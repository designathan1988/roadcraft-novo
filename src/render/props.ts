// Props drawn by the GPU: one pool of instances (every cell,
// every kind), culled in a compute shader each frame against the
// frustum and the distance, which writes the visible lists per kind and level and
// the counts of the indirect draws. One material for everything, one call per
// kind and level. Dirty cells are rebuilt in the workers and only their
// blocks go up to the GPU. A level change fades by dithering.

import * as THREE from 'three/webgpu';
import { CELL_COUNT, Dirty, cellOriginX, tileId, tileX, type DirtyReader } from '../core/grid.ts';
import { CELL_SIZE, MAP_CELLS, MAP_TILES, TILE_SIZE } from '../config.ts';
import type { JobPool } from '../jobs/pool.ts';
import { boxTransfer, roadGraphTransfer, type PropColumns } from '../shared/contracts/worker.ts';
import { drawnTriangleCounts, type PropsProbe } from './propsProbe.ts';
import { PROP_FREE, PROP_TYPES, propType } from '../jobs/props.ts';
import { PARTS_RANGE, VARIANT_TYPES } from '../jobs/parts40.ts';
import type { World } from '../world/world.ts';
import { PartSize, partRules } from './partSize.ts';
import { buildPropDefs, buildPropKinds, buildingPartModels, propKindCasts, propCullRadius, propLayer, propStretch, buildSignAtlas, impostorSources, propKindTable, VARIANTS, type PropDef, type PropKind } from './propMeshes.ts';
import { bakeImpostors, impostorFrames } from './impostor.ts';
import { buildLeafAtlas } from './treeMeshes.ts';
import { T, type Node } from './tsl.ts';
import { PropBlocks } from './propBlocks.ts';
import { PropFallback } from './propFallback.ts';
import { DepthOcclusion } from './depthOcclusion.ts';
import { createPropMaterial, fadeJitter } from './propMaterial.ts';
import { SHADOW_LENGTH, sunDirection } from './sun.ts';
import type { SegId } from '../core/ids.ts';

const {
  Fn, If, Loop, storage, uniform, uniformArray, instanceIndex, atomicAdd, atomicStore, atomicLoad, uint, float,
  min, select, length, dot, step, texture, clamp, max,
} = T;

const CAP = 1 << 20;
const BLOCK = 64;
/** Entries of the visible list: an instance is in at most two levels at once (the fading band). */
const VISIBLE = CAP * 2;
const LODS = 3;
/** Kinds drawn: the types, with the ones whose variants are different meshes split per variant. */
const KINDS = propKindTable().count;
const DRAWS = KINDS * LODS;
/** A level switch dissolves for this long (ms), as Cesium's dithered LOD transitions (0.5 s); transient, not a band. */
const LOD_FADE_MS = 450;
/** Words of an instance's dissolve state: its prop key, its levels, the dissolve's start (ms). One buffer on purpose: the
 *  fill pass binds 8 storage buffers, WebGPU's guaranteed limit for a stage. A ninth (the start kept apart) made the
 *  pipeline invalid: the colour cull never ran and the draws read the last shadow cascade's list as their own, each mesh
 *  drawn at another kind's instances. */
const LOD_WORDS = 3;
/** How far past a cell a next cell's lot matters to its wild trees (m): the widest crown. */
const LOT_REACH = 16;
/** How far the eye goes before the casters are chosen again (m). */
const CASTER_STEP = 48;
/** Cells this near hold all their parts. */
const PART_ALL = 64;
/** Cells of the queue asked again at a time. */
const RETRY_CELLS = 12;
/** The level changes only this far past its boundary (relative distance), so a camera at rest never flickers. */
const LOD_HYSTERESIS = 0.06;

export class PropRenderer {
  readonly group = new THREE.Group();
  readonly enabled: boolean;
  private world: World;
  private pool: JobPool;
  /** This renderer's own list of cells whose props changed (particles read the same kind). */
  private dirty: DirtyReader;
  private defs: PropDef[];
  /** What is drawn: one kind per type, or per variant for the types whose variants are different meshes. */
  private kinds: PropKind[];
  private kindOfAttr: THREE.StorageBufferAttribute;
  /** Instances of each kind in held cells within that kind's reach (a kind with none nearby is not drawn). */
  private kindNear = new Uint32Array(KINDS);
  private kindNearDue = true;
  /** LOD dissolve state per instance: (prop key, from | to << 4) and the dissolve start (ms). */
  private lodStateAttr!: THREE.StorageBufferAttribute;
  private readonly lodClock = uniform(0);
  /** Frames drawn: the dissolve's dither phase. */
  private fadeFrame = 0;
  /** Instances per kind of each cell that holds props. */
  private cellKinds = new Map<number, Uint32Array>();
  /** Highest point any held prop of a cell reaches (rooftop equipment on towers), −∞ without props. */
  private cellTop = new Float32Array(CELL_COUNT).fill(-Infinity);
  private kindOf: Uint32Array;
  private data = new Float32Array(CAP * 4);
  private extra = new Uint32Array(CAP).fill(PROP_FREE);
  private poolAttr: THREE.StorageBufferAttribute;
  private extraAttr: THREE.StorageBufferAttribute;
  private visAttr: THREE.StorageBufferAttribute;
  /** Where each draw's run starts in the visible list (prefix sum of the counts, every frame). */
  private offsetAttr: THREE.StorageBufferAttribute;
  /** Next free entry of each draw's run while the list is filled. */
  private cursorAttr: THREE.StorageBufferAttribute;
  private drawAttr: THREE.IndirectStorageBufferAttribute;
  private blocks = new PropBlocks(CAP / BLOCK, CELL_COUNT);
  private cellVer = new Uint32Array(CELL_COUNT);
  private cellReq = new Uint32Array(CELL_COUNT);
  /** Version of the props a cell shows (-1: dropped, asked again when it comes back in range). */
  private cellHave = new Int32Array(CELL_COUNT);
  /** Whether a cell's props were asked with its 4.0 buildings' parts (near cells only, jobs/parts40.ts PARTS_RANGE). */
  private cellParts = new Uint8Array(CELL_COUNT);
  /** The distance each cell's parts were chosen for: nearer than this, they were left out and it is asked again. */
  private cellPartAt = new Float32Array(CELL_COUNT);
  private partRuleTable!: Float32Array;
  /** Cells whose props did not fit in the pool: asked again when blocks are freed. */
  private pending = new Set<number>();
  private residentAt = new THREE.Vector3(Infinity, 0, Infinity);
  private residencyDue = true;
  private retryDue = false;
  private usedU = uniform(0, 'uint');
  private camU = uniform(new THREE.Vector3());
  /** Where the cascades' casters are chosen from: it follows the eye in steps. Chosen from the eye itself, what casts
   *  changed with every orbit and a kept or scrolled map went without the parts now near it. */
  private casterEyeU = uniform(new THREE.Vector3(Infinity, 0, 0));
  /** The caster set moved with the eye: the near cascades, which hold those parts, are drawn again. */
  casterMoved = false;
  private planes: THREE.Vector4[] = Array.from({ length: 6 }, () => new THREE.Vector4());
  private planesU: Node;
  private distArr: number[] = new Array(DRAWS).fill(0);
  /** Draws of each level in the frame (the view and each shadow cascade), counted as three draws them (D81). */
  private readonly drawsThisFrame = new Uint32Array(DRAWS);
  private distU: Node;
  private radiusU: Node;
  /** The 4.0 building parts' unit models, built once here: the props pool draws them, the ruins take them (features/demolition). */
  readonly partModels: Readonly<Record<string, THREE.BufferGeometry>>;
  private stretchU: Node;
  /** 1 for the kinds whose near level casts a sun shadow. */
  private castU: Node;
  /** The 4.0 building parts' size on the screen (their level and where they leave the drawing, per instance). */
  private partSize: PartSize;
  /** Toward the sun (xyz). */
  private sunU = uniform(new THREE.Vector3(0, 1, 0));
  private reset: Node;
  private count: Node;
  private prefix: Node;
  private cull: Node;
  /** The shadow cascades' own frustum and fill: casters per cascade, run between passes (post.ts renderShadow). */
  private readonly shadowPlanes: THREE.Vector4[] = Array.from({ length: 6 }, () => new THREE.Vector4());
  private shadowPlanesU: Node;
  private shFrustum = new THREE.Frustum();
  private shPv = new THREE.Matrix4();
  private shCount: Node;
  private shCull: Node;
  /** The pools' occlusion: the previous frame's depth pyramid, tested in the cull (WebGPU only). */
  private occlusion: DepthOcclusion | null = null;
  /** The frame the pyramid holds: its forward, matrices and focal (the test asks whether it hid the instance). */
  private camFU = uniform(new THREE.Vector3(0, 0, -1));
  private projU = uniform(new THREE.Matrix4());
  private viewU = uniform(new THREE.Matrix4());
  private focalU = uniform(1304);
  private readonly nextFwd = new THREE.Vector3(0, 0, -1);
  private readonly nextProj = new THREE.Matrix4();
  private readonly nextView = new THREE.Matrix4();
  private nextFocal = 1304;
  private frustum = new THREE.Frustum();
  private pv = new THREE.Matrix4();
  /** Traffic light state texture (node → 1 + arm * 4 + state). */
  readonly signalTex: THREE.DataTexture;
  pixelScale = 1;
  /** Props were placed or dropped since the last `update` (the shadow cascades are redrawn). */
  changed = true;
  /** Cells whose props came or left since the shadows last looked: their cascades redraw, not all of them. */
  private readonly changedCells = new Set<number>();
  /** Mesh of each type × level (null: no level): levels nothing can reach this frame are not drawn. */
  private slotMesh: Array<THREE.Mesh | null> = new Array(DRAWS).fill(null);
  private signalSent = 0;
  // compatibility mode (WebGL 2): instanced meshes per cell, only near the camera
  private fallback: PropFallback | null = null;
  // impostor atlas (colour and normal); swapped for the photo at load
  private impColor = texture(new THREE.Texture());
  private impNormal = texture(new THREE.Texture());
  // sign faces (speed limits, stop, yield…), drawn once at load
  private signAtlas = texture(buildSignAtlas());
  // leaf clump and palm frond, cut out of the tree cards
  private leafTex = buildLeafAtlas();
  private leafAtlas = texture(this.leafTex);
  impRT: THREE.RenderTarget[] = [];

  constructor(world: World, pool: JobPool, signalsSab: SharedArrayBuffer, isWebGPU: boolean) {
    this.world = world;
    this.pool = pool;
    this.dirty = world.dirty.reader(Dirty.Props);
    this.enabled = isWebGPU; // compute culling: WebGPU only (on WebGL 2 the props are left out for now)
    if (this.enabled) this.occlusion = new DepthOcclusion(); // the cull tests the previous frame's depth pyramid
    this.partModels = buildingPartModels();
    this.defs = buildPropDefs(this.partModels);
    const built = buildPropKinds(this.defs);
    this.kinds = built.kinds;
    this.kindOf = built.kindOf;
    this.kindOfAttr = new THREE.StorageBufferAttribute(built.kindOf, 1);
    // the impostor frames are measured from the tree meshes before the material reads them
    impostorFrames(impostorSources(this.defs));
    this.poolAttr = new THREE.StorageBufferAttribute(this.data, 4);
    this.extraAttr = new THREE.StorageBufferAttribute(this.extra, 1);
    this.lodStateAttr = new THREE.StorageBufferAttribute(new Uint32Array(CAP * LOD_WORDS).fill(0xffffffff), 1);
    this.visAttr = new THREE.StorageBufferAttribute(new Uint32Array(VISIBLE), 1);
    this.offsetAttr = new THREE.StorageBufferAttribute(new Uint32Array(DRAWS), 1);
    this.cursorAttr = new THREE.StorageBufferAttribute(new Uint32Array(DRAWS), 1);
    const draw = new Uint32Array(DRAWS * 5);
    this.kinds.forEach((d, k) => d.lods.forEach((g, l) => { if (g) draw[(k * LODS + l) * 5] = g.attributes.position.count; }));
    this.drawAttr = new THREE.IndirectStorageBufferAttribute(draw, 1);
    const sig = new Uint8Array(signalsSab);
    this.signalTex = new THREE.DataTexture(sig, 512, sig.length / 512, THREE.RedFormat, THREE.UnsignedByteType);
    this.signalTex.minFilter = THREE.NearestFilter;
    this.signalTex.magFilter = THREE.NearestFilter;
    this.signalTex.needsUpdate = true;

    this.planesU = uniformArray(this.planes, 'vec4');
    this.distU = uniformArray(this.distArr, 'float');
    this.radiusU = uniformArray(this.kinds.map((d) => d.radius), 'float');
    this.stretchU = uniformArray(this.kinds.map((d) => propStretch(d)), 'float');
    this.castU = uniformArray(this.kinds.map((d) => (propKindCasts(d) ? 1 : 0)), 'float');
    this.partSize = new PartSize(this.kinds);
    this.partRuleTable = partRules(this.kinds, this.kindOf, VARIANTS);

    // ---- compute. The visible list is compact: each draw's instances in one run, the runs back to back. Count (how
    // many each draw gets), prefix (where each run starts), fill. No draw has a cap of its own: a forest of 250,000
    // trees in view is drawn whole (a fixed 131,072 per draw cut a different part every frame and the forest blinked).
    const drawsA = storage(this.drawAttr, 'uint', DRAWS * 5).toAtomic();
    const cursorA = storage(this.cursorAttr, 'uint', DRAWS).toAtomic();
    const offsetW = storage(this.offsetAttr, 'uint', DRAWS);
    this.reset = Fn(() => {
      atomicStore(drawsA.element(instanceIndex.mul(5).add(1)), uint(0));
      atomicStore(cursorA.element(instanceIndex), uint(0));
    })().compute(DRAWS);
    const poolC = storage(this.poolAttr, 'vec4', CAP).toReadOnly();
    const extraC = storage(this.extraAttr, 'uint', CAP).toReadOnly();
    const kindOfC = storage(this.kindOfAttr, 'uint', PROP_TYPES * VARIANTS).toReadOnly();
    const visW = storage(this.visAttr, 'uint', VISIBLE);
    const lodStateW = storage(this.lodStateAttr, 'uint', CAP * LOD_WORDS);
    const nowU = this.lodClock;
    /** Culls instance i and calls `emit(slot, code)` for each level it is drawn in (one, or two while fading). */
    const classify = (emit: (slot: Node, code: Node) => void) => {
      const i = instanceIndex;
      If(i.lessThan(this.usedU), () => {
        const type = extraC.element(i).bitAnd(uint(31)).toVar();
        If(type.lessThan(uint(PROP_FREE)), () => {
          const pose = poolC.element(i).toVar();
          const p = pose.xyz;
          // the kind: the type, or the type's variant when its variants are different meshes. A 4.0 building part keeps
          // its variant in its key (extra bits 29-31, jobs/parts40.ts partKey): its w's high bits are its colour (partW)
          let isVar = uint(0).toVar();
          for (const t of VARIANT_TYPES) isVar = select(type.equal(uint(t)), uint(1), isVar);
          const variant = select(isVar.equal(uint(1)), extraC.element(i).shiftRight(uint(29)).bitAnd(uint(7)), uint(pose.w).shiftRight(uint(12)).bitAnd(uint(15)));
          const kind = kindOfC.element(type.mul(VARIANTS).add(variant)).toVar();
          // a 4.0 building part: its scale per axis from its key (render/partSize.ts)
          const isPart = this.partSize.isPart(kind);
          const s3 = this.partSize.scale(extraC.element(i), select(isVar.equal(uint(1)), float(1), float(0))).toVar();
          // the kind's reach times the instance's scale (or plus the span, for wires and walls): a fixed radius cut
          // big trees and long wires at the edge of the screen. A part's: its model's reach at its scale (w holds its colour)
          const rk = this.radiusU.element(kind);
          const bits = float(uint(pose.w).shiftRight(uint(16)).bitAnd(uint(63)));
          const mode = this.stretchU.element(kind);
          const rProp = select(mode.lessThan(0.5), rk.mul(bits.div(42).add(0.5)), rk.add(bits.mul(select(mode.lessThan(1.5), float(1), float(0.1)))));
          const r = select(isPart, this.partSize.radius(kind, s3), rProp).toVar();
          // in the view, or (near level only) its shadow is: the sphere swept along the shadow, away from the sun,
          // as long as its height casts it (a tree outside the edge of the screen shadows the street in it)
          const sun = this.sunU;
          const len = select(sun.y.greaterThan(0.02), min(r.div(sun.y.max(0.02)), float(SHADOW_LENGTH)), float(0));
          let inView: Node = float(1), inShadow: Node = float(1);
          for (let k = 0; k < 6; k++) {
            const pl = this.planesU.element(k);
            const s0 = dot(pl.xyz, p).add(pl.w);
            inView = inView.mul(step(r.negate(), s0));
            inShadow = inShadow.mul(step(r.negate(), s0.add(max(dot(pl.xyz, sun.xyz.negate()).mul(len), float(0)))));
          }
          // the previous frame's depth pyramid: an instance hidden behind the frame's occluders does not draw
          // (the shadow sweep keeps its casters - a tree behind a building still shadows the street)
          if (this.occlusion) inView = inView.mul(this.occlusion.test(p, r, this.camFU, this.projU, this.viewU, this.focalU));
          If(inView.add(inShadow).greaterThan(0.5), () => {
            const d = length(p.sub(this.camU)).toVar();
            // A part's levels end where its size on the screen says, within its type's distance (render/partSize.ts).
            // The switch between levels is a short TIMED dissolve (Cesium's dithered LOD transitions: a threshold ramped
            // over time, noise changing every frame, resolved by the TAA), not a permanent distance band: both levels
            // are drawn only while the dissolve lasts, and a camera at rest draws one level per instance.
            const partEnd = this.partSize.ends(kind, s3, this.distU.element(kind.mul(LODS)));
            const ends: Node[] = [];
            for (let l = 0; l < LODS; l++) ends.push(select(isPart, partEnd[l], this.distU.element(kind.mul(LODS).add(l))));
            const endAt = (lvl: Node): Node => { let e: Node = float(0); for (let l = 0; l < LODS; l++) e = select(lvl.equal(uint(l)), ends[l], e); return e; };
            // the level the distance asks for: the first whose end is farther than d
            const target = uint(LODS).toVar();
            for (let l = LODS - 1; l >= 0; l--) target.assign(select(ends[l].greaterThan(0).and(d.lessThan(ends[l])), uint(l), target));
            // per-instance dissolve state: the prop key, the level it comes from and goes to, and when it began
            const stKey = lodStateW.element(i.mul(LOD_WORDS)).toVar();
            const stPacked = lodStateW.element(i.mul(LOD_WORDS).add(1)).toVar();
            const stStart = float(lodStateW.element(i.mul(LOD_WORDS).add(2))).toVar();
            const from = stPacked.bitAnd(uint(15)).toVar();
            const to = stPacked.shiftRight(uint(4)).bitAnd(uint(15)).toVar();
            const start = stStart.toVar();
            const key = extraC.element(i);
            // a prop that took the pool slot (or the first frame): no dissolve, it appears at its level
            If(stKey.notEqual(key), () => {
              from.assign(target); to.assign(target); start.assign(nowU.sub(float(LOD_FADE_MS)));
              lodStateW.element(i.mul(LOD_WORDS)).assign(key);
              lodStateW.element(i.mul(LOD_WORDS).add(1)).assign(from.bitOr(to.shiftLeft(uint(4))));
              lodStateW.element(i.mul(LOD_WORDS).add(2)).assign(uint(max(start, float(0))));
            });
            // the level changes only past a hysteresis band, and the dissolve starts then
            const high = endAt(to);
            const low = select(to.greaterThan(uint(0)), endAt(to.sub(uint(1))), float(0));
            const up = target.greaterThan(to).and(d.greaterThanEqual(high.mul(1 + LOD_HYSTERESIS)));
            const down = target.lessThan(to).and(d.lessThan(low.mul(1 - LOD_HYSTERESIS)));
            If(up.or(down), () => {
              from.assign(to); to.assign(target); start.assign(nowU);
              lodStateW.element(i.mul(LOD_WORDS).add(1)).assign(from.bitOr(to.shiftLeft(uint(4))));
              lodStateW.element(i.mul(LOD_WORDS).add(2)).assign(uint(max(start, float(0))));
            });
            const a = clamp(nowU.sub(start).div(float(LOD_FADE_MS)), 0, 1).toVar();
            // during the dissolve the outgoing level fades out and the incoming one fades in (complementary masks);
            // afterwards only the target level is drawn (one level per instance, as before the band)
            If(inView.greaterThan(0.5), () => {
              If(a.lessThan(1).and(from.notEqual(to)).and(from.lessThan(uint(LODS))), () => {
                emit(kind.mul(LODS).add(from), i.bitOr(uint(float(1).sub(a).mul(255)).shiftLeft(uint(22))));
              });
              If(a.lessThan(1).and(from.notEqual(to)).and(to.lessThan(uint(LODS))), () => {
                emit(kind.mul(LODS).add(to), i.bitOr(uint(a.mul(255)).shiftLeft(uint(22))).bitOr(uint(1).shiftLeft(uint(31))));
              });
              If(a.greaterThanEqual(1).or(from.equal(to)), () => {
                If(to.lessThan(uint(LODS)), () => { emit(kind.mul(LODS).add(to), i.bitOr(uint(255).shiftLeft(uint(22)))); });
              });
            });
            // a caster whose shadow reaches the view but whose own screen box does not: the near level casts it, and
            // only while the near level is the one the distance would use (the old level band's reach)
            If(inView.lessThan(0.5).and(inShadow.greaterThan(0.5)).and(this.castU.element(kind).greaterThan(0.5))
              .and(d.lessThan(ends[0])), () => {
              emit(kind.mul(LODS), i.bitOr(uint(255).shiftLeft(uint(22))));
            });
          });
        });
      });
    };
    this.count = Fn(() => {
      classify((slot) => { atomicAdd(drawsA.element(slot.mul(5).add(1)), uint(1)); });
    })().compute(CAP, [64]);
    this.prefix = Fn(() => {
      const sum = uint(0).toVar();
      Loop(DRAWS, ({ i }: { i: Node }) => {
        offsetW.element(i).assign(sum);
        sum.addAssign(atomicLoad(drawsA.element(uint(i).mul(5).add(1))));
      });
    })().compute(1);
    const offsetC = storage(this.offsetAttr, 'uint', DRAWS).toReadOnly();
    this.cull = Fn(() => {
      classify((slot, code) => {
        const n = atomicAdd(cursorA.element(slot), uint(1));
        visW.element(offsetC.element(slot).add(n)).assign(code);
      });
    })().compute(CAP, [64]);

    // The shadow cascades' fill: the casters alone, level 0, no dissolve state - each cascade's own frustum with
    // the same sweep toward the sun the main cull tests. prepareCascade runs it between passes, before that
    // cascade's render, so the draws' indirect arguments hold the cascade's own casters (up to two thirds of the
    // shadow vertices were instances whose slice another cascade covers).
    this.shadowPlanesU = uniformArray(this.shadowPlanes, 'vec4');
    const shadowPlanesU = this.shadowPlanesU;
    const shadowClassify = (emit: (slot: Node, code: Node) => void) => {
      const i = instanceIndex;
      If(i.lessThan(this.usedU), () => {
        const type = extraC.element(i).bitAnd(uint(31)).toVar();
        If(type.lessThan(uint(PROP_FREE)), () => {
          const pose = poolC.element(i).toVar();
          const p = pose.xyz;
          let isVar = uint(0).toVar();
          for (const t of VARIANT_TYPES) isVar = select(type.equal(uint(t)), uint(1), isVar);
          const variant = select(isVar.equal(uint(1)), extraC.element(i).shiftRight(uint(29)).bitAnd(uint(7)), uint(pose.w).shiftRight(uint(12)).bitAnd(uint(15)));
          const kind = kindOfC.element(type.mul(VARIANTS).add(variant)).toVar();
          const isPart = this.partSize.isPart(kind);
          const s3 = this.partSize.scale(extraC.element(i), select(isVar.equal(uint(1)), float(1), float(0))).toVar();
          const rk = this.radiusU.element(kind);
          const bits = float(uint(pose.w).shiftRight(uint(16)).bitAnd(uint(63)));
          const mode = this.stretchU.element(kind);
          const rProp = select(mode.lessThan(0.5), rk.mul(bits.div(42).add(0.5)), rk.add(bits.mul(select(mode.lessThan(1.5), float(1), float(0.1)))));
          const r = select(isPart, this.partSize.radius(kind, s3), rProp).toVar();
          const sun = this.sunU;
          const len = select(sun.y.greaterThan(0.02), min(r.div(sun.y.max(0.02)), float(SHADOW_LENGTH)), float(0));
          let inShadow: Node = float(1);
          for (let k = 0; k < 6; k++) {
            const pl = shadowPlanesU.element(k);
            const s0 = dot(pl.xyz, p).add(pl.w);
            inShadow = inShadow.mul(step(r.negate(), s0.add(max(dot(pl.xyz, sun.xyz.negate()).mul(len), float(0)))));
          }
          const d = length(p.sub(this.casterEyeU)).toVar();
          If(inShadow.greaterThan(0.5).and(this.castU.element(kind).greaterThan(0.5)).and(d.lessThan(this.distU.element(kind.mul(LODS)))), () => {
            emit(kind.mul(LODS), i.bitOr(uint(255).shiftLeft(uint(22))));
          });
        });
      });
    };
    this.shCount = Fn(() => {
      shadowClassify((slot) => { atomicAdd(drawsA.element(slot.mul(5).add(1)), uint(1)); });
    })().compute(CAP, [64]);
    this.shCull = Fn(() => {
      shadowClassify((slot, code) => {
        const n = atomicAdd(cursorA.element(slot), uint(1));
        visW.element(offsetC.element(slot).add(n)).assign(code);
      });
    })().compute(CAP, [64]);

    // ---- desenho
    if (!this.enabled) {
      // WebGL 2: the fallback material, compiled at load with one hidden instance (render/propFallback.ts)
      this.fallback = new PropFallback(this.group, this.defs, this.createMaterial('cpu'));
      this.fallback.warm();
      return;
    }
    const material = this.createMaterial('gpu');
    this.kinds.forEach((d, t) => d.lods.forEach((g, l) => {
      if (!g) return;
      g.setIndirect(this.drawAttr, (t * LODS + l) * 5 * 4);
      const mesh = new THREE.Mesh(g, material);
      mesh.frustumCulled = false;
      mesh.userData.slot = t * LODS + l;
      const slot = t * LODS + l;
      mesh.onBeforeRender = () => { this.drawsThisFrame[slot]++; };
      // only the near level casts shadows, and only the kinds propKindCasts lets in (by type, not by kind index)
      mesh.castShadow = l === 0 && propKindCasts(d);
      // low props, leaves in the wind (propLayer)
      mesh.layers.set(propLayer(d, l));
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.slotMesh[t * LODS + l] = mesh;
    }));
  }

  /** The material itself lives in render/propMaterial.ts (its own responsibility). */
  private createMaterial(source: 'gpu' | 'cpu'): THREE.MeshStandardNodeMaterial {
    return createPropMaterial({
      gpu: source === 'gpu', cap: CAP, visible: VISIBLE, draws: DRAWS,
      visAttr: this.visAttr, offsetAttr: this.offsetAttr, poolAttr: this.poolAttr, extraAttr: this.extraAttr,
      signalTex: this.signalTex, impColor: this.impColor, impNormal: this.impNormal, leafAtlas: this.leafAtlas, signAtlas: this.signAtlas,
    });
  }

  /** Photographs the trees for the impostors (at load). */
  bake(renderer: THREE.WebGPURenderer): void {
    if (!this.enabled) return;
    const baked = bakeImpostors(renderer, impostorSources(this.defs), this.leafTex);
    this.impRT = baked.targets;
    this.impColor.value = baked.color;
    this.impNormal.value = baked.normal;
  }

  /** Dirty cells: their props are out of date; the ones in range are asked again (`updateResidency`). */
  processDirty(): void {
    const cells = this.dirty.drain();
    for (const c of cells) { this.cellVer[c]++; this.pending.delete(c); }
    if (cells.length) this.residencyDue = true;
  }

  /** Horizontal distance from the camera to a cell. */
  private cellDistance(c: number, cam: THREE.Vector3): number {
    const x0 = cellOriginX(c % MAP_CELLS), z0 = cellOriginX((c / MAP_CELLS) | 0);
    const dx = Math.max(x0 - cam.x, 0, cam.x - (x0 + CELL_SIZE)), dz = Math.max(z0 - cam.z, 0, cam.z - (z0 + CELL_SIZE));
    return Math.hypot(dx, dz);
  }

  /** Asks the workers for a cell's props, nearest first. */
  private requestCell(c: number, distance: number): void {
    const v = this.cellVer[c];
    this.cellReq[c] = v;
    const parts40 = this.wantParts(c, distance);
    this.cellParts[c] = parts40 ? 1 : 0;
    // a quarter of the way in: the camera then comes that much nearer before the cell has to be asked again
    const partAt = distance > PART_ALL ? distance * 0.75 : 0;
    this.cellPartAt[c] = partAt;
    const w = this.world, net = w.roads;
    const x0 = cellOriginX(c % MAP_CELLS), z0 = cellOriginX((c / MAP_CELLS) | 0);
    const segs: SegId[] = [];
    net.forSegsNear(x0 - 40, z0 - 40, x0 + 296, z0 + 296, (s) => segs.push(s));
    const boxes = w.gatherBoxes([c], true);
    const graph = net.gather(segs, []);
    const items = w.items.gather(c, MAP_CELLS);
    const lots = w.lotsNear(x0 - LOT_REACH, z0 - LOT_REACH, x0 + CELL_SIZE + LOT_REACH, z0 + CELL_SIZE + LOT_REACH, c);
    this.pool.submit('props', { graph, boxes, cell: c, items, biome: w.biome, parts40, partRules: this.partRuleTable, partPx: this.partSize.pxPerMetre, partAt, lots }, (r) => { if (this.cellReq[r.cell] === v) this.setCell(r.cell, r.props, v); }, {
      key: `props:${c}`, priority: distance + 100, transfer: [...roadGraphTransfer(graph), ...boxTransfer(boxes), items.buffer as ArrayBuffer, lots.buffer as ArrayBuffer],
    });
  }

  /** Whether a cell at `d` wants its buildings' parts: within the range, kept a little past it (no asking again at the edge). */
  private wantParts(c: number, d: number): boolean {
    const r = PARTS_RANGE * this.pixelScale;
    return this.cellParts[c] ? d < r * 1.25 : d < r;
  }

  /** How far props can be drawn now (the farthest level band), and the range kept beyond it. */
  private ranges(): { keep: number; drop: number } {
    const far = this.enabled ? this.reach * this.pixelScale : 420 * this.pixelScale;
    const keep = far + CELL_SIZE;
    return { keep, drop: keep * 1.15 + CELL_SIZE };
  }

  /**
   * Which cells hold props: the ones within the farthest drawn band (asked nearest first), never the whole map. Cells
   * that leave the range give their blocks back. Runs when the camera moved, cells got dirty or blocks were freed.
   */
  private updateResidency(cam: THREE.Vector3): void {
    const { keep, drop } = this.ranges();
    if (keep <= CELL_SIZE) return;
    const moved = Math.hypot(cam.x - this.residentAt.x, cam.z - this.residentAt.z) > 32;
    if (!moved && !this.residencyDue && !this.retryDue) return;
    this.residentAt.copy(cam);
    this.residencyDue = false;
    this.kindNearDue = true;
    for (const c of [...this.blocks.resident]) {
      const d = this.cellDistance(c, cam);
      if (d > drop) this.dropCell(c);
      else {
        this.blocks.setDistance(c, d);
        // came near (or went far): asked again with (without) its buildings' parts
        // (a near cell holds all its parts, `at` 0: it is never asked again for coming or going)
        const parts = this.cellParts[c] === 1, at = this.cellPartAt[c];
        if ((this.wantParts(c, d) !== parts || (parts && at > 0 && (d < at || d > at * 2.4))) && this.cellReq[c] === this.cellHave[c]) this.requestCell(c, d);
      }
    }
    for (const c of [...this.pending]) if (this.cellDistance(c, cam) > drop) { this.pending.delete(c); this.cellHave[c] = -1; this.cellReq[c] = 0; }
    if (this.retryDue) {
      this.retryDue = false;
      // nearest first and only what the room can take: a whole queue asked again at one free block held the main thread
      // gathering its roads and buildings, and most of it came back to the queue
      const wait = [...this.pending].map((c) => [c, this.cellDistance(c, cam)] as const).sort((a, b) => a[1] - b[1]);
      const take = Math.min(wait.length, RETRY_CELLS, this.blocks.free > 0 ? RETRY_CELLS : 0);
      for (let k = 0; k < take; k++) { const [c, d] = wait[k]; this.pending.delete(c); this.requestCell(c, d); }
      this.retryDue = wait.length > take && this.blocks.free > 0;
    }
    const span = Math.ceil(keep / CELL_SIZE);
    const ccx = Math.floor((cam.x + MAP_CELLS * CELL_SIZE / 2) / CELL_SIZE), ccz = Math.floor((cam.z + MAP_CELLS * CELL_SIZE / 2) / CELL_SIZE);
    for (let cz = Math.max(0, ccz - span); cz <= Math.min(MAP_CELLS - 1, ccz + span); cz++) {
      for (let cx = Math.max(0, ccx - span); cx <= Math.min(MAP_CELLS - 1, ccx + span); cx++) {
        const c = cz * MAP_CELLS + cx;
        if (this.cellHave[c] === this.cellVer[c] || this.cellReq[c] === this.cellVer[c] || this.pending.has(c)) continue;
        const d = this.cellDistance(c, cam);
        if (d <= keep) this.requestCell(c, d);
      }
    }
  }

  /** A cell out of range gives its blocks back; it is asked again if it comes back. */
  private dropCell(c: number): void {
    this.clearBlocks(this.blocks.release(c));
    this.forgetKinds(c);
    if (!this.enabled) this.fallback?.setCell(c, null);
    this.cellHave[c] = -1;
    this.cellReq[c] = 0;
    this.retryDue ||= this.pending.size > 0;
  }

  /** Farthest level band of any kind (m, at 1080p). */
  private get reach(): number {
    let r = 0;
    for (const k of this.kinds) k.dist.forEach((x, l) => { if (k.lods[l]) r = Math.max(r, x); });
    return r;
  }

  /** Counts a placed cell's instances per kind (kinds with none in the held cells are not drawn). */
  private countKinds(c: number, p: PropColumns): void {
    this.forgetKinds(c);
    this.changedCells.add(c);
    const n = new Uint32Array(KINDS);
    let top = -Infinity;
    for (let i = 0; i < p.count; i++) {
      const type = propType(p.extra[i]);
      if (type >= PROP_TYPES) continue;
      const k = this.kindOf[type * VARIANTS + propVariant(type, p.data[i * 4 + 3], p.extra[i])];
      n[k]++;
      top = Math.max(top, p.data[i * 4 + 1] + propCullRadius(this.kinds[k], p.data[i * 4 + 3]));
    }
    this.cellTop[c] = top;
    this.cellKinds.set(c, n);
    this.kindNearDue = true;
  }

  /**
   * Which kinds have instances within their own reach of the camera: the held cells (a bounded ring round the
   * camera) and each kind's farthest band. Runs when cells come or go or the camera moved (residency), not per frame.
   */
  private countKindsNear(cam: THREE.Vector3): void {
    this.kindNearDue = false;
    this.kindNear.fill(0);
    const reach = this.kinds.map((k) => Math.max(...k.dist.map((x, l) => (k.lods[l] ? x : 0))) * this.pixelScale);
    for (const [c, n] of this.cellKinds) {
      const d = this.cellDistance(c, cam);
      for (let k = 0; k < KINDS; k++) if (n[k] && d < reach[k]) this.kindNear[k] += n[k];
    }
  }

  private forgetKinds(c: number): void {
    const n = this.cellKinds.get(c);
    if (!n) return;
    this.cellKinds.delete(c);
    this.changedCells.add(c);
    this.cellTop[c] = -Infinity;
    this.kindNearDue = true;
  }

  /** Marks blocks free on the GPU side (the cull pass skips them). */
  private clearBlocks(blocks: readonly number[]): void {
    if (!blocks.length) return;
    for (const b of blocks) {
      this.extra.fill(PROP_FREE, b * BLOCK, (b + 1) * BLOCK);
      this.extraAttr.addUpdateRange(b * BLOCK, BLOCK);
    }
    this.extraAttr.needsUpdate = true;
  }

  private setCell(c: number, p: PropColumns | null, v: number): void {
    const d = this.cellDistance(c, this.residentAt);
    // the camera left while the job ran: not kept (asked again if it comes back)
    if (d > this.ranges().drop) { this.cellHave[c] = -1; this.cellReq[c] = 0; return; }
    if (!this.enabled) { this.fallback!.setCell(c, p); this.cellHave[c] = v; return; }
    const freed = this.blocks.release(c);
    this.clearBlocks(freed);
    this.forgetKinds(c);
    if (freed.length) this.retryDue ||= this.pending.size > 0;
    this.pending.delete(c);
    if (!p || p.count === 0) { this.cellHave[c] = v; return; }
    const placed = this.blocks.place(c, p.count, BLOCK, d);
    if (!placed) {
      // no room even after farther cells gave way: it waits, counted, and is asked again when blocks are freed
      this.pending.add(c);
      this.cellHave[c] = -1;
      return;
    }
    for (const e of placed.evicted) {
      this.clearBlocks(e.blocks);
      this.forgetKinds(e.cell);
      this.cellHave[e.cell] = -1;
      this.pending.add(e.cell);
    }
    let i = 0;
    for (const b of placed.blocks) {
      const s0 = b * BLOCK;
      const n = Math.min(BLOCK, p.count - i);
      this.data.set(p.data.subarray(i * 4, (i + n) * 4), s0 * 4);
      this.extra.set(p.extra.subarray(i, i + n), s0);
      if (n < BLOCK) this.extra.fill(PROP_FREE, s0 + n, s0 + BLOCK);
      this.poolAttr.addUpdateRange(s0 * 4, BLOCK * 4);
      this.extraAttr.addUpdateRange(s0, BLOCK);
      i += n;
    }
    this.poolAttr.needsUpdate = true;
    this.extraAttr.needsUpdate = true;
    this.countKinds(c, p);
    this.cellHave[c] = v;
  }

  /** The ground boxes of the cells whose props changed, once. */
  takeChangedBoxes(): THREE.Box3[] {
    const out: THREE.Box3[] = [];
    for (const c of this.changedCells) {
      const x = cellOriginX(c % MAP_CELLS), z = cellOriginX((c / MAP_CELLS) | 0);
      out.push(new THREE.Box3(new THREE.Vector3(x - 16, -200, z - 16), new THREE.Vector3(x + CELL_SIZE + 16, 1400, z + CELL_SIZE + 16)));
    }
    this.changedCells.clear();
    return out;
  }

  /** Cells waiting for room in the pool, and cells holding props. */
  get pendingCells(): number { return this.pending.size; }
  get residentCells(): number { return this.blocks.resident.size; }

  // The WebGL 2 fallback lives in render/propFallback.ts (its own responsibility; the props file-size gate).

  /** The props' real drawn triangles (D81); the measurement lives with the probe (render/propsProbe.ts). */
  async drawnTriangles(renderer: THREE.WebGPURenderer): Promise<{ counted: number; drawn: number }> {
    return drawnTriangleCounts(renderer, this.enabled, this.drawsThisFrame, this.drawAttr, DRAWS);
  }

  /**
   * What the render checks read and put into the props layer (the automation contract's render.props): GPU invariants a
   * Node test cannot reach. putCell takes a cell's props as a job result would (its current version).
   */
  probe(renderer: THREE.WebGPURenderer): PropsProbe {
    return {
      putCell: (c, p) => this.setCell(c, p, this.cellVer[c]),
      drawCounts: async () => new Uint32Array(await renderer.getArrayBufferAsync(this.drawAttr)),
      kindOf: (type, variant) => this.kindOf[type * VARIANTS + variant],
      levelShown: (kind, level) => this.slotMesh[kind * LODS + level]?.visible === true,
      kindRadius: (kind) => this.kinds[kind].radius,
      planes: () => this.planes.map((p) => ({ x: p.x, y: p.y, z: p.z, w: p.w })),
    };
  }

  /** A new animation-loop frame: the draws are counted again (three resets its own counts here too, Animation.js:81). */
  frameStart(): void { this.drawsThisFrame.fill(0); }

  /** Before drawing: culling on the GPU (or choosing the cells, on WebGL 2). */
  update(renderer: THREE.WebGPURenderer, camera: THREE.Camera, camPos: THREE.Vector3, now: number): void {
    if (now - this.signalSent > 250) { this.signalSent = now; this.signalTex.needsUpdate = true; }
    (this.lodClock as { value: number }).value = now;
    // two incommensurate golden-ratio walks: the dissolve's dither is never a fixed mask (the TRAA averages it)
    this.fadeFrame++;
    (fadeJitter.value as THREE.Vector2).set((this.fadeFrame * 0.6180339887498949 % 1) * 64, (this.fadeFrame * 0.7548776662466927 % 1) * 64);
    if (!this.enabled) { this.updateResidency(camPos); this.fallback!.update(camera, camPos, this.pixelScale); return; }
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv, camera.coordinateSystem, (camera as THREE.PerspectiveCamera).reversedDepth);
    this.frustum.planes.forEach((p, k) => this.planes[k].set(p.normal.x, p.normal.y, p.normal.z, p.constant));
    this.camU.value.copy(camPos);
    if ((this.casterEyeU.value as THREE.Vector3).distanceTo(camPos) > CASTER_STEP) { (this.casterEyeU.value as THREE.Vector3).copy(camPos); this.casterMoved = true; }
    // the occlusion test projects with the matrices of the frame the pyramid was reduced from, the last one drawn;
    // this frame's are kept for the next
    (this.projU.value as THREE.Matrix4).copy(this.nextProj);
    (this.viewU.value as THREE.Matrix4).copy(this.nextView);
    (this.camFU.value as THREE.Vector3).copy(this.nextFwd);
    this.focalU.value = this.nextFocal;
    this.nextProj.copy(camera.projectionMatrix);
    this.nextView.copy(camera.matrixWorldInverse);
    camera.getWorldDirection(this.nextFwd);
    this.nextFocal = (renderer.domElement.height || 1080) / (2 * Math.tan((((camera as THREE.PerspectiveCamera).fov ?? 45) / 2) * Math.PI / 180));
    (this.sunU.value as THREE.Vector3).copy(sunDirection);
    // a new scale moves every distance: the cascades' casters changed
    if (this.partSize.setView(camera, this.pixelScale)) this.changed = true;
    for (let k = 0; k < KINDS; k++) {
      const d = this.kinds[k];
      for (let l = 0; l < LODS; l++) this.distArr[k * LODS + l] = d.lods[l] && this.kindNear[k] > 0 ? d.dist[l] * this.pixelScale : 0;
    }
    this.updateResidency(camPos);
    if (this.kindNearDue) this.countKindsNear(camPos);
    // An indirect draw costs a call (and one per shadow cascade) even when the cull leaves it empty: a level whose
    // band ends nearer than any prop can be is not drawn. Nearest possible prop: the eye's height over the highest
    // ground of the 3 × 3 tiles round it (+60 m for bridges and rooftops); props beyond those tiles are ≥ 1 km away.
    const w = this.world;
    const tx = Math.min(MAP_TILES - 1, Math.max(0, tileX(camPos.x))), tz = Math.min(MAP_TILES - 1, Math.max(0, tileX(camPos.z)));
    let top = -Infinity;
    for (let j = Math.max(0, tz - 1); j <= Math.min(MAP_TILES - 1, tz + 1); j++) for (let i = Math.max(0, tx - 1); i <= Math.min(MAP_TILES - 1, tx + 1); i++) top = Math.max(top, w.tileMax[tileId(i, j)] + 60);
    // and the highest prop held in those tiles (equipment on a 60-floor roof is 200 m up, not 60)
    const per = TILE_SIZE / CELL_SIZE;
    for (let cz = Math.max(0, (tz - 1) * per); cz < Math.min(MAP_CELLS, (tz + 2) * per); cz++) {
      for (let cx = Math.max(0, (tx - 1) * per); cx < Math.min(MAP_CELLS, (tx + 2) * per); cx++) top = Math.max(top, this.cellTop[cz * MAP_CELLS + cx]);
    }
    const nearest = Math.min(TILE_SIZE, camPos.y - top);
    for (let k = 0; k < DRAWS; k++) { const m = this.slotMesh[k]; if (m) m.visible = this.distArr[k] > nearest; }
    this.usedU.value = this.blocks.highBlock * BLOCK;
    // with shadows the cascades' fills overwrite these lists and `prepareMain` makes them again after the last one: two
    // whole passes over the pool here were thrown away every frame
    if (this.cullInCascades) return;
    renderer.compute(this.reset);
    renderer.compute(this.count);
    renderer.compute(this.prefix);
    renderer.compute(this.cull);
    this.dropGpuOnlyCopies();
  }

  /** Written and read by the GPU alone: their CPU arrays only filled the buffers once. */
  private dropGpuOnlyCopies(): void {
    if (this.copiesDropped) return;
    this.copiesDropped = true;
    (this.visAttr as unknown as { array: Uint32Array }).array = new Uint32Array(0);
    (this.lodStateAttr as unknown as { array: Uint32Array }).array = new Uint32Array(0);
  }
  private copiesDropped = false;
  /** The colour lists are made after the shadow cascades (the game sets it: true with shadows on). */
  cullInCascades = false;

  /**
   * One shadow cascade's cull: the casters its own frustum sweeps (post.ts renderShadow calls this between passes,
   * before the cascade's render - the draws' indirect arguments then hold that cascade's casters alone). The
   * distance bands still read the main camera (`camU`, untouched): the level a caster casts with is the one the
   * view chose.
   */
  prepareCascade(renderer: THREE.WebGPURenderer, camera: THREE.Camera): void {
    if (!this.enabled) return;
    this.shPv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.shFrustum.setFromProjectionMatrix(this.shPv, camera.coordinateSystem, (camera as THREE.PerspectiveCamera).reversedDepth);
    this.shFrustum.planes.forEach((p, k) => this.shadowPlanes[k].set(p.normal.x, p.normal.y, p.normal.z, p.constant));
    renderer.compute(this.reset);
    renderer.compute(this.shCount);
    renderer.compute(this.prefix);
    renderer.compute(this.shCull);
  }

  /** The colour pass's cull again: the cascades' fills overwrote the indirect arguments (post.ts, after the last). */
  prepareMain(renderer: THREE.WebGPURenderer): void {
    if (!this.enabled) return;
    renderer.compute(this.reset);
    renderer.compute(this.count);
    renderer.compute(this.prefix);
    renderer.compute(this.cull);
    this.dropGpuOnlyCopies();
  }

  /** The pools' occlusion pyramid (null on WebGL 2): post.frameEnd feeds it the scene depth. */
  get occl(): DepthOcclusion | null { return this.enabled ? this.occlusion : null; }

  /** Forgets everything (another city): results still on their way are ignored by version. */  clear(): void {
    for (const c of [...this.blocks.resident]) { this.clearBlocks(this.blocks.release(c)); this.forgetKinds(c); }
    for (let c = 0; c < CELL_COUNT; c++) {
      if (!this.enabled) this.fallback?.setCell(c, null);
      this.cellVer[c]++; this.cellReq[c] = 0; this.cellHave[c] = -1;
    }
    this.pending.clear();
    this.residencyDue = true;
    // (the dissolve state needs no reset: an instance whose key changed starts over, stKey above)
  }
}

/** An instance's variant: a 4.0 building part's from its key (extra bits 29-31), any other prop's from w bits 12-15. */
function propVariant(type: number, w: number, extra: number): number {
  return VARIANT_TYPES.has(type) ? (extra >>> 29) & 7 : (w >>> 12) & 15;
}

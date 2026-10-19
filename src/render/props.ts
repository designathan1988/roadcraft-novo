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
import { boxTransfer, roadGraphTransfer, type PropColumns } from '../jobs/protocol.ts';
import { PROP, PROP_FREE, PROP_TYPES } from '../jobs/props.ts';
import { PARTS_RANGE, PART_TYPES, SCALE_MIN, SCALE_OCTAVES, VARIANT_TYPES } from '../jobs/parts40.ts';
import type { World } from '../world/world.ts';
import { buildPropDefs, buildPropKinds, propCastsShadow, propCullRadius, propIsSmallCaster, propStretch, buildSignAtlas, impostorSources, propKindTable, FACE_LAST, PMAT, SIGN_ATLAS, SIGN_FACES, VARIANTS, type PropDef, type PropKind } from './propMeshes.ts';
import { IMP_FRAME, IMP_G, IMP_TYPES, bakeImpostors, hemiOctDecodeNode, hemiOctEncodeNode, impostorFrames } from './impostor.ts';
import { buildLeafAtlas } from './treeMeshes.ts';
import { nightU } from './scene.ts';
import { PAINTS } from './vehicles.ts';
import { windDirU, windU } from './weather.ts';
import { T, withPrevious, type Node } from './tsl.ts';
import { PropBlocks } from './propBlocks.ts';
import { SHADOW_LENGTH, SMALL_CASTER_LAYER, sunDirection } from './sun.ts';

const {
  Fn, If, Loop, storage, uniform, uniformArray, instanceIndex, atomicAdd, atomicStore, atomicLoad, uint, float, int, vec3, vec4, ivec2,
  attribute, positionLocal, normalLocal, varyingProperty, transformNormalToView, normalize, cos, sin, min, select, length, dot,
  textureLoad, time, interleavedGradientNoise, screenCoordinate, mix, step, abs, fract, hash, sRGBTransferEOTF,
  texture, vec2, cross, clamp, floor, uniformArray: uArr, cameraPosition, positionWorld: positionWorldP, cameraViewMatrix, max,
} = T;

const CAP = 1 << 20;
const BLOCK = 64;
/** Entries of the visible list: an instance is in at most two levels at once (the fading band). */
const VISIBLE = CAP * 2;
const LODS = 3;
/** Kinds drawn: the types, with the ones whose variants are different meshes split per variant. */
const KINDS = propKindTable().count;
const DRAWS = KINDS * LODS;
const FADE_BAND = 0.12;
/** Share of the ipês in flower. */
const IPE_IN_FLOWER = 0.35;
/** The leaf tones (treeMeshes.ts LEAF, linear) an ipê out of flower takes. */
const LEAF_DARK = new THREE.Color(0x24401c), LEAF_LIT = new THREE.Color(0x4f7a34);

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
  /** Cells whose props did not fit in the pool: asked again when blocks are freed. */
  private pending = new Set<number>();
  private residentAt = new THREE.Vector3(Infinity, 0, Infinity);
  private residencyDue = true;
  private retryDue = false;
  private usedU = uniform(0, 'uint');
  private camU = uniform(new THREE.Vector3());
  private planes: THREE.Vector4[] = Array.from({ length: 6 }, () => new THREE.Vector4());
  private planesU: Node;
  private distArr: number[] = new Array(DRAWS).fill(0);
  private distU: Node;
  private radiusU: Node;
  private stretchU: Node;
  /** 1 for the kinds whose near level casts a sun shadow. */
  private castU: Node;
  /** Toward the sun (xyz). */
  private sunU = uniform(new THREE.Vector3(0, 1, 0));
  private reset: Node;
  private count: Node;
  private prefix: Node;
  private cull: Node;
  private frustum = new THREE.Frustum();
  private pv = new THREE.Matrix4();
  /** Traffic light state texture (node → 1 + arm * 4 + state). */
  readonly signalTex: THREE.DataTexture;
  pixelScale = 1;
  /** Props were placed or dropped since the last `update` (the shadow cascades are redrawn). */
  changed = true;
  /** Mesh of each type × level (null: no level): levels nothing can reach this frame are not drawn. */
  private slotMesh: Array<THREE.Mesh | null> = new Array(DRAWS).fill(null);
  private signalSent = 0;
  // compatibility mode (WebGL 2): instanced meshes per cell, only near the camera
  private fallbackMat: THREE.MeshStandardNodeMaterial | null = null;
  private cellMeshes: Array<THREE.Mesh[] | null> = new Array(CELL_COUNT).fill(null);
  private fbFrustum = new THREE.Frustum();
  private fbBox = new THREE.Box3();
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
    this.defs = buildPropDefs();
    const built = buildPropKinds(this.defs);
    this.kinds = built.kinds;
    this.kindOf = built.kindOf;
    this.kindOfAttr = new THREE.StorageBufferAttribute(built.kindOf, 1);
    // the impostor frames are measured from the tree meshes before the material reads them
    impostorFrames(impostorSources(this.defs));
    this.poolAttr = new THREE.StorageBufferAttribute(this.data, 4);
    this.extraAttr = new THREE.StorageBufferAttribute(this.extra, 1);
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
    this.castU = uniformArray(this.kinds.map((d) => (propCastsShadow(d, 0) ? 1 : 0)), 'float');

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
    /** Culls instance i and calls `emit(slot, code)` for each level it is drawn in (one, or two while fading). */
    const classify = (emit: (slot: Node, code: Node) => void) => {
      const i = instanceIndex;
      If(i.lessThan(this.usedU), () => {
        const type = extraC.element(i).bitAnd(uint(31)).toVar();
        If(type.lessThan(uint(PROP_FREE)), () => {
          const pose = poolC.element(i).toVar();
          const p = pose.xyz;
          // the kind: the type, or the type's variant when its variants are different meshes
          const variant = uint(pose.w).shiftRight(uint(12)).bitAnd(uint(15));
          const kind = kindOfC.element(type.mul(VARIANTS).add(variant)).toVar();
          // the kind's reach times the instance's scale (or plus the span, for wires and walls): a fixed radius cut
          // big trees and long wires at the edge of the screen
          const rk = this.radiusU.element(kind);
          const bits = float(uint(pose.w).shiftRight(uint(16)).bitAnd(uint(63)));
          const mode = this.stretchU.element(kind);
          const r = select(mode.lessThan(0.5), rk.mul(bits.div(42).add(0.5)), rk.add(bits.mul(select(mode.lessThan(1.5), float(1), float(0.1)))));
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
          If(inView.add(inShadow).greaterThan(0.5), () => {
            const d = length(p.sub(this.camU)).toVar();
            for (let l = 0; l < LODS; l++) {
              const slot = kind.mul(LODS).add(l);
              const end = this.distU.element(slot);
              const start = l === 0 ? float(-1) : this.distU.element(slot.sub(1));
              // enters level l at the end of the previous one (fading), leaves at the end of its own
              const bandIn = start.mul(1 - FADE_BAND);
              // shadow-only instances go into the near level of the kinds that cast (the main pass culls them on screen)
              const seen = l === 0 ? inView.greaterThan(0.5).or(this.castU.element(kind).greaterThan(0.5)) : inView.greaterThan(0.5);
              If(seen.and(end.greaterThan(0)).and(d.lessThan(end)).and(d.greaterThanEqual(bandIn)), () => {
                // fade out (near the end) and in (inside the previous one's band)
                const outA = select(d.greaterThan(end.mul(1 - FADE_BAND)), end.sub(d).div(end.mul(FADE_BAND)), float(1));
                const inA = select(d.lessThan(start), d.sub(bandIn).div(start.mul(FADE_BAND).max(0.001)), float(1));
                const a = min(outA, inA);
                // code: 8 bits of coverage; bit 31 = complementary mask (the incoming one)
                const comp = select(d.lessThan(start), uint(1), uint(0));
                const cov = uint(min(a, 1).mul(255));
                emit(slot, i.bitOr(cov.shiftLeft(uint(22))).bitOr(comp.shiftLeft(uint(31))));
              });
            }
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

    // ---- desenho
    if (!this.enabled) {
      this.fallbackMat = this.createMaterial('cpu');
      // one hidden instance so the shader compiles at load
      this.setCellFallback(0, { count: 1, data: new Float32Array([0, -5000, 0, 0]), extra: new Uint32Array([0]) });
      for (const m of this.cellMeshes[0] ?? []) this.group.children.push(m);
      this.cellMeshes[0] = null;
      return;
    }
    const material = this.createMaterial('gpu');
    this.kinds.forEach((d, t) => d.lods.forEach((g, l) => {
      if (!g) return;
      g.setIndirect(this.drawAttr, (t * LODS + l) * 5 * 4);
      const mesh = new THREE.Mesh(g, material);
      mesh.frustumCulled = false;
      mesh.userData.slot = t * LODS + l;
      // only the near level casts shadows (propCastsShadow); of the 4.0 building parts only the boxes (sills, fins) and the
      // lot pieces: thin frames, railings and small props none (each cascade would draw them again)
      mesh.castShadow = propCastsShadow(d, l) && (!PART_TYPES.includes(t) || t === PROP.BBox || t === PROP.BLot);
      // low props: the views and the near cascade only (their shadow is under a texel of the far ones)
      if (propIsSmallCaster(d)) mesh.layers.set(SMALL_CASTER_LAYER);
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.slotMesh[t * LODS + l] = mesh;
    }));
  }

  /**
   * One material. 'gpu': the instance comes from the compute's visible list (WebGPU);
   * 'cpu': the instance comes from instanced attributes per cell (WebGL 2, near only).
   */
  private createMaterial(source: 'gpu' | 'cpu'): THREE.MeshStandardNodeMaterial {
    const m = new THREE.MeshStandardNodeMaterial();
    const gpu = source === 'gpu';
    const slotU = gpu ? uniform(0, 'uint').onObjectUpdate(({ object }: { object: THREE.Object3D }) => object.userData.slot as number) : null;
    const visR = gpu ? storage(this.visAttr, 'uint', VISIBLE).toReadOnly() : null;
    const offsetR = gpu ? storage(this.offsetAttr, 'uint', DRAWS).toReadOnly() : null;
    const poolR = gpu ? storage(this.poolAttr, 'vec4', CAP).toReadOnly() : null;
    const extraR = gpu ? storage(this.extraAttr, 'uint', CAP).toReadOnly() : null;
    const vN = varyingProperty('vec3', 'vPropN');
    // varyings packed in vec4s (WebGPU caps the inter-stage variables; one float each ran out once the sign atlas
    // came in): A = fade, complementary mask, variant, lit lamp; B = impostor uv, impostor yaw cos/sin;
    // C = sign atlas uv, sign back face, flower
    const vA = varyingProperty('vec4', 'vPropA');
    const vB = varyingProperty('vec4', 'vPropB');
    const vC = varyingProperty('vec4', 'vPropC');
    // D = a building part's instance colour (linear), and whether it is one
    const vD = varyingProperty('vec4', 'vPropD');
    const vFade = vA.x, vComp = vA.y, vVar = vA.z, vLit = vA.w;
    const vImpUV = vB.xy, vImpCS = vB.zw;
    const vAtlasUV = vC.xy, vAtlasBack = vC.z, vFlower = vC.w;
    let fadeN: Node = float(1), compN: Node = float(0), flowerN: Node = float(0), atlasUVN: Node = vec2(0, 0), backN: Node = float(0);
    const pcol = attribute('pcol', 'vec4');
    const sigTex = this.signalTex;

    m.positionNode = Fn(() => {
      let inst: Node, keyRaw: Node;
      if (gpu) {
        const code = visR.element(offsetR.element(slotU).add(instanceIndex)).toVar();
        const idx = code.bitAnd(uint(0x3fffff));
        fadeN = float(code.shiftRight(uint(22)).bitAnd(uint(255))).div(255);
        compN = float(code.shiftRight(uint(31)));
        inst = poolR.element(idx).toVar();
        keyRaw = extraR.element(idx);
      } else {
        inst = attribute('ipose', 'vec4');
        keyRaw = uint(attribute('ikey', 'float'));
      }
      const w = uint(inst.w);
      const yaw = float(w.bitAnd(uint(4095))).mul(Math.PI * 2 / 4096);
      // a 4.0 building part (jobs/parts40.ts): scale per axis in the key (log code), its colour in w over the turn,
      // a variant on top of the key for the types that hold several parts
      const ptype = float(keyRaw.bitAnd(uint(31)));
      const isPart = step(float(PART_TYPES[0] - 0.5), ptype).mul(step(ptype, float(PART_TYPES[PART_TYPES.length - 1] + 0.5)));
      let isVarT: Node = float(0);
      for (const t of VARIANT_TYPES) isVarT = isVarT.add(step(abs(ptype.sub(t)), float(0.5)));
      const pkey = keyRaw.shiftRight(uint(5));
      const q9 = (k: number) => float(pkey.shiftRight(uint(k * 9)).bitAnd(uint(511))).div(511);
      const q8 = (k: number) => float(pkey.shiftRight(uint(k * 8)).bitAnd(uint(255))).div(255);
      const sc = (k: number) => T.exp2(mix(q9(k), q8(k), isVarT).mul(SCALE_OCTAVES)).mul(SCALE_MIN);
      const scale3 = vec3(sc(0), sc(1), sc(2));
      const partVariant = float(pkey.shiftRight(uint(24)).bitAnd(uint(7)));
      const pc12 = w.shiftRight(uint(12));
      const partRgb = vec3(float(pc12.shiftRight(uint(8)).bitAnd(uint(15))), float(pc12.shiftRight(uint(4)).bitAnd(uint(15))), float(pc12.bitAnd(uint(15)))).div(15);
      vD.assign(vec4(sRGBTransferEOTF(partRgb), isPart));
      const variant = mix(float(w.shiftRight(uint(12)).bitAnd(uint(15))), partVariant, isPart);
      const scale = float(w.shiftRight(uint(16)).bitAnd(uint(63))).div(42).add(0.5);
      // the ipê (tree or oak, variant 3) is a model of its own with its crown in flower; each one draws a number that
      // says whether it is in flower (about a third are, as the season spreads them)
      const typeF = float(keyRaw.bitAnd(uint(31)));
      const isIpe = max(step(abs(typeF.sub(PROP.Tree)), float(0.5)), step(abs(typeF.sub(PROP.Oak)), float(0.5))).mul(step(abs(variant.sub(3)), float(0.5)));
      flowerN = isIpe.mul(hash(floor(inst.x).add(floor(inst.z).mul(157))).mul(0.998).add(0.001));
      const c = cos(yaw), s = sin(yaw);
      // wire: scale = span length (m), variant = height difference; z goes from 0 to 1 along the span
      const isWire = step(abs(pcol.w.mul(255).sub(PMAT.Wire)), float(0.5));
      const span = float(w.shiftRight(uint(16)).bitAnd(uint(63)));
      const dy = variant.sub(8).mul(0.5);
      const lz = positionLocal.z;
      const sag = lz.mul(float(1).sub(lz)).mul(4).mul(span.mul(0.018));
      const wireP = vec3(positionLocal.x, positionLocal.y.add(dy.mul(lz)).sub(sag), lz.mul(span));
      // sign: the faces of the other variants collapse
      const mat0 = pcol.w.mul(255);
      const isFace = step(float(PMAT.Sign0 - 0.5), mat0).mul(step(mat0, float(FACE_LAST + 0.5)));
      const wrongFace = isFace.mul(step(float(0.5), abs(mat0.sub(PMAT.Sign0).sub(variant))));
      // wall/fence: length in decimetres in the scale, height difference in the key
      const isBarrier = step(abs(float(keyRaw.bitAnd(uint(31))).sub(PROP.Barrier)), float(0.5));
      const bDy = float(keyRaw.shiftRight(uint(5))).sub(512).mul(0.05);
      const barrierP = vec3(positionLocal.x, positionLocal.y.add(bDy.mul(lz)), lz.mul(span.mul(0.1)));
      // sign face: one quad sized per variant (SIGN_FACES), its atlas cell by the variant or, for speed limits, by the
      // speed in the key (km/h; 0 = 60)
      const isAtlas = step(abs(mat0.sub(PMAT.Atlas)), float(0.5));
      const face = uArr(SIGN_FACES.map(([hx, hy, cy, cellK]) => new THREE.Vector4(hx, hy, cy, cellK)), 'vec4').element(int(variant));
      const atlasP = vec3(positionLocal.x.mul(face.x), face.z.add(positionLocal.y.mul(face.y)), positionLocal.z);
      const kmh = float(keyRaw.shiftRight(uint(5)));
      const speedCell = clamp(select(kmh.lessThan(5), float(60), kmh).div(10).round().sub(2), 0, 10);
      const cellK = select(face.w.lessThan(-0.5), speedCell, face.w);
      const back = step(normalLocal.z, float(0));
      const lxA = mix(positionLocal.x, positionLocal.x.negate(), back);
      atlasUVN = (vec2(T.mod(cellK, SIGN_ATLAS.COLS).add(lxA.mul(0.5).add(0.5)).div(SIGN_ATLAS.COLS),
        float(1).sub(floor(cellK.div(SIGN_ATLAS.COLS)).add(float(0.5).sub(positionLocal.y.mul(0.5))).div(SIGN_ATLAS.ROWS))));
      backN = back;
      const local = mix(positionLocal, atlasP, isAtlas);
      const p = mix(mix(mix(local.mul(scale), positionLocal.mul(scale3), isPart), wireP, isWire), barrierP, isBarrier).mul(float(1).sub(wrongFace)).toVar();
      // foliage sways a little with the wind
      const isCard = step(abs(pcol.w.mul(255).sub(PMAT.LeafCard)), float(0.5));
      const leaf = max(step(abs(pcol.w.mul(255).sub(PMAT.Leaf)), float(0.5)), isCard);
      // with strong wind: faster and wider sway, leaning with the wind
      // along the wind, as much as the wind: none in still air (it used to sway 3 cm per metre of height with no
      // wind, always along x)
      const sway = sin(time.mul(windU.mul(2.2).add(1.3)).add(inst.x.mul(0.07)).add(inst.z.mul(0.05))).mul(windU.mul(0.09)).add(windU.mul(windU).mul(0.06)).mul(p.y).mul(leaf);
      const wx = p.x.mul(c).add(p.z.mul(s)).add(sway.mul(windDirU.x));
      const wz = p.x.negate().mul(s).add(p.z.mul(c)).add(sway.mul(windDirU.y));
      const n = normalize(mix(normalLocal, normalLocal.div(scale3), isPart));
      vN.assign(vec3(n.x.mul(c).add(n.z.mul(s)), n.y, n.x.negate().mul(s).add(n.z.mul(c))));
      // traffic light: which lamp is lit
      const key = keyRaw.shiftRight(uint(5));
      const node = int(key.shiftRight(uint(3)));
      const arm = float(key.bitAnd(uint(7)));
      const st = textureLoad(sigTex, ivec2(node.mod(int(512)), node.div(int(512)))).r.mul(255).add(0.5).floor();
      // outside the simulation's window: a decorative cycle by the clock
      const fakeT = time.add(hash(node.toUint()).mul(60));
      const fakePhase = float(fakeT.div(16).floor().mod(2));
      const fakeState = select(fract(fakeT.div(16)).greaterThan(0.85), float(1), float(0));
      // from the simulation: 128 | amber << 6 | arms with green
      const known = step(float(127.5), st);
      const mask = st.mod(64);
      const armOn = floor(mask.div(T.pow(float(2), arm))).mod(2);
      const state = mix(fakeState, step(float(0.5), floor(st.div(64)).mod(2)), known);
      const armMatch = mix(step(abs(fract(arm.div(2)).mul(2).sub(fakePhase)), float(0.1)), armOn, known);
      const mat = pcol.w.mul(255);
      const isRed = step(abs(mat.sub(PMAT.Red)), float(0.5));
      const isYel = step(abs(mat.sub(PMAT.Yellow)), float(0.5));
      const isGrn = step(abs(mat.sub(PMAT.Green)), float(0.5));
      const greenOn = armMatch.mul(step(state, float(0.5)));
      const yellowOn = armMatch.mul(step(abs(state.sub(1)), float(0.5)));
      const redOn = float(1).sub(greenOn).sub(yellowOn);
      vA.assign(vec4(fadeN, compN, variant, isRed.mul(redOn).add(isYel.mul(yellowOn)).add(isGrn.mul(greenOn))));
      // impostor: a square facing the camera with the photo of the nearest direction
      const isImp = step(abs(mat.sub(PMAT.Impostor)), float(0.5));
      const col = pcol.x.mul(255).add(0.5).floor();
      const frame = uArr(IMP_FRAME.map((f) => new THREE.Vector2(f.cy, f.r)), 'vec2').element(int(col));
      const centerW = inst.xyz.add(vec3(0, frame.x.mul(scale), 0));
      const vw = normalize(cameraPosition.sub(centerW));
      // into the tree's space (without the heading)
      const vl = normalize(vec3(vw.x.mul(c).sub(vw.z.mul(s)), vw.y.max(0.02), vw.x.mul(s).add(vw.z.mul(c))));
      const fuv = hemiOctEncodeNode(vl);
      const cell = clamp(floor(fuv.mul(IMP_G)), 0, IMP_G - 1);
      const dl = hemiOctDecodeNode(cell.add(0.5).div(IMP_G));
      const dw = vec3(dl.x.mul(c).add(dl.z.mul(s)), dl.y, dl.x.negate().mul(s).add(dl.z.mul(c)));
      const upRef = select(abs(dl.y).greaterThan(0.985), vec3(s, 0, c), vec3(0, 1, 0));
      const right = normalize(cross(upRef, dw));
      const upv = cross(dw, right);
      const R = frame.y.mul(scale);
      const impPos = centerW.add(right.mul(positionLocal.x.mul(R))).add(upv.mul(positionLocal.y.mul(R)));
      const atlas = vec2(col.mul(IMP_G).add(cell.x).add(positionLocal.x.mul(0.5).add(0.5)).div(IMP_G * IMP_TYPES),
        cell.y.add(positionLocal.y.mul(0.5).add(0.5)).div(IMP_G));
      vB.assign(vec4(atlas, c, s));
      vC.assign(vec4(select(isCard.greaterThan(0.5), attribute('pext', 'vec4').xy, atlasUVN), backN, flowerN));
      // foliage cards face the camera (the shadow pass's camera too: leafy shadows); corner offset in metres
      const pext = attribute('pext', 'vec4');
      const camR = vec3(cameraViewMatrix.element(0).x, cameraViewMatrix.element(1).x, cameraViewMatrix.element(2).x);
      const camU = vec3(cameraViewMatrix.element(0).y, cameraViewMatrix.element(1).y, cameraViewMatrix.element(2).y);
      const card = camR.mul(pext.z).add(camU.mul(pext.w)).mul(scale).mul(isCard);
      return mix(vec3(wx, p.y, wz).add(inst.xyz).add(card), impPos, isImp);
    })();
    withPrevious(m);
    // impostor: the photo's normal (tree space) turned by the heading
    const fmat = pcol.w.mul(255);
    const isImpF = step(abs(fmat.sub(PMAT.Impostor)), float(0.5));
    const impC = this.impColor.sample(vImpUV);
    const impN = this.impNormal.sample(vImpUV).xyz.mul(2).sub(1);
    const impNW = vec3(impN.x.mul(vImpCS.x).add(impN.z.mul(vImpCS.y)), impN.y, impN.x.negate().mul(vImpCS.y).add(impN.z.mul(vImpCS.x)));
    m.normalNode = transformNormalToView(normalize(mix(vN, impNW, isImpF)));

    const mat = pcol.w.mul(255);
    const isCardF = step(abs(mat.sub(PMAT.LeafCard)), float(0.5));
    const isLeaf = max(step(abs(mat.sub(PMAT.Leaf)), float(0.5)), isCardF);
    const leafC = this.leafAtlas.sample(vAtlasUV);
    const isGlass = step(abs(mat.sub(PMAT.Glass)), float(0.5));
    const isBulb = step(float(2.5), mat).mul(step(mat, float(5.5)));
    const isMetal = step(abs(mat.sub(PMAT.Metal)), float(0.5));
    // foliage variation by variant
    const tint = mix(vec3(1, 1, 1), mix(vec3(0.82, 1.05, 0.7), vec3(1.15, 1.0, 0.75), step(float(1.5), vVar)), step(float(0.5), vVar).mul(isLeaf));
    // paint of the parked cars by variant
    const isPaint = step(abs(mat.sub(PMAT.Paint)), float(0.5));
    const paint = sRGBTransferEOTF(uArr(PAINTS.map((p) => new THREE.Color(p)), 'color').element(int(vVar.add(0.5))));
    const isAtlasF = step(abs(mat.sub(PMAT.Atlas)), float(0.5));
    const atlasC = this.signAtlas.sample(vAtlasUV);
    const signFace = mix(atlasC.xyz, pcol.xyz, vAtlasBack);
    // an ipê out of flower: its bloom (redder than green) takes the leaf tone of the same brightness
    const bloomVert = step(pcol.y.mul(1.05), pcol.x).mul(isLeaf.max(isImpF));
    const outOfFlower = step(float(0.0005), vFlower).mul(step(float(IPE_IN_FLOWER), vFlower)).mul(bloomVert);
    const leafOf = mix(LEAF_DARK, LEAF_LIT, clamp(dot(pcol.xyz, vec3(0.2126, 0.7152, 0.0722)).mul(3), 0, 1));
    const pc = mix(pcol.xyz, leafOf, outOfFlower);
    const impBase = mix(impC.xyz, leafOf.mul(dot(impC.xyz, vec3(0.2126, 0.7152, 0.0722)).mul(4)), step(float(0.0005), vFlower).mul(step(float(IPE_IN_FLOWER), vFlower)).mul(step(impC.y.mul(1.05), impC.x)));
    const base = mix(mix(mix(pc.mul(mix(vec3(1, 1, 1), leafC.xyz, isCardF)), paint, isPaint), signFace, isAtlasF), impBase, isImpF).mul(mix(tint, mix(vec3(1, 1, 1), tint, step(float(0.5), vVar)), isImpF));
    const bulbOff = base.mul(0.12);
    // foliage: each tree with its own tone (lighter, yellower or darker), the top of the crown lighter and the
    // light that passes through the leaves (the shadow side does not go black)
    const treeH = hash(floor(positionWorldP.xz.div(7)).dot(vec2(1, 57.3)));
    const leafTone = mix(mix(vec3(0.82, 0.9, 0.8), vec3(1.12, 1.08, 0.82), step(float(0.55), treeH)), vec3(1.0, 1.12, 0.92), step(float(0.85), treeH));
    // flower: multiplies the leaf colour (sRGB 0x6a9a45 in linear) up to the flower colour; the impostor trunk barely changes
    const leafK = leafTone;
    const leafBase = base.mul(mix(vec3(1, 1, 1), leafK, isLeaf.max(isImpF)));
    const up = clamp(normalize(mix(vN, impNW, isImpF)).y, 0, 1);
    const through = leafBase.mul(float(0.1).add(up.mul(0.1))).mul(float(1).sub(nightU.mul(0.9))).mul(isLeaf.max(isImpF));
    m.colorNode = vec4(mix(leafBase, bulbOff, isBulb).mul(mix(vec3(1, 1, 1), vD.xyz, vD.w)), 1);
    m.emissiveNode = through.add(pcol.xyz.mul(isBulb).mul(vLit).mul(mix(float(2.2), float(4), nightU)))
      .add(sRGBTransferEOTF(vec3(1, 0.86, 0.6)).mul(isGlass).mul(nightU).mul(6));
    m.roughnessNode = mix(mix(float(0.85), float(0.45), isMetal), float(0.95), isLeaf.max(isImpF));
    m.metalnessNode = isMetal.mul(0.3);
    // fading between levels
    const noise = interleavedGradientNoise(screenCoordinate.xy);
    const fadeOk = select(vComp.greaterThan(0.5), noise.greaterThanEqual(float(1).sub(vFade)), noise.lessThan(vFade.add(0.002)));
    m.maskNode = fadeOk.and(isImpF.lessThan(0.5).or(impC.a.greaterThan(0.5))).and(isAtlasF.lessThan(0.5).or(atlasC.a.greaterThan(0.5))).and(isCardF.lessThan(0.5).or(leafC.a.greaterThan(0.5)));
    return m;
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
    const w = this.world, net = w.roads;
    const x0 = cellOriginX(c % MAP_CELLS), z0 = cellOriginX((c / MAP_CELLS) | 0);
    const segs: number[] = [];
    net.forSegsNear(x0 - 40, z0 - 40, x0 + 296, z0 + 296, (s) => segs.push(s));
    const boxes = w.gatherBoxes([c]);
    const graph = net.gather(segs, []);
    const items = w.items.gather(c, MAP_CELLS);
    this.pool.submit('props', { graph, boxes, cell: c, items, biome: w.biome, parts40 }, (r) => { if (this.cellReq[r.cell] === v) this.setCell(r.cell, r.props, v); }, {
      key: `props:${c}`, priority: distance + 100, transfer: [...roadGraphTransfer(graph), ...boxTransfer(boxes), items.buffer as ArrayBuffer],
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
        if (this.wantParts(c, d) !== (this.cellParts[c] === 1) && this.cellReq[c] === this.cellHave[c]) this.requestCell(c, d);
      }
    }
    for (const c of [...this.pending]) if (this.cellDistance(c, cam) > drop) { this.pending.delete(c); this.cellHave[c] = -1; this.cellReq[c] = 0; }
    if (this.retryDue) {
      this.retryDue = false;
      const wait = [...this.pending].map((c) => [c, this.cellDistance(c, cam)] as const).sort((a, b) => a[1] - b[1]);
      for (const [c, d] of wait) { this.pending.delete(c); this.requestCell(c, d); }
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
    if (!this.enabled) this.setCellFallback(c, null);
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
    this.changed = true;
    const n = new Uint32Array(KINDS);
    let top = -Infinity;
    for (let i = 0; i < p.count; i++) {
      const type = p.extra[i] & 31;
      if (type >= PROP_TYPES) continue;
      const k = this.kindOf[type * VARIANTS + ((p.data[i * 4 + 3] >>> 12) & 15)];
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
    this.changed = true;
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
    if (!this.enabled) { this.setCellFallback(c, p); this.cellHave[c] = v; return; }
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

  /** Cells waiting for room in the pool, and cells holding props. */
  get pendingCells(): number { return this.pending.size; }
  get residentCells(): number { return this.blocks.resident.size; }

  /** WebGL 2: one instanced mesh per kind in the cell (the middle level, or the only one there is). */
  private setCellFallback(c: number, p: PropColumns | null): void {
    const old = this.cellMeshes[c];
    if (old) for (const m of old) m.geometry.dispose();
    this.cellMeshes[c] = null;
    if (!p || p.count === 0 || !this.fallbackMat) return;
    const meshes: THREE.Mesh[] = [];
    for (let t = 0; t < PROP_TYPES; t++) {
      const def = this.defs[t];
      const base = def.lods[1] ?? def.lods[0];
      if (!base) continue;
      let n = 0;
      for (let i = 0; i < p.count; i++) if ((p.extra[i] & 31) === t) n++;
      if (n === 0) continue;
      const pose = new Float32Array(n * 4), key = new Float32Array(n);
      let k = 0;
      for (let i = 0; i < p.count; i++) {
        if ((p.extra[i] & 31) !== t) continue;
        pose.set(p.data.subarray(i * 4, i * 4 + 4), k * 4);
        key[k] = p.extra[i];
        k++;
      }
      const g = new THREE.InstancedBufferGeometry();
      for (const name of ['position', 'normal', 'pcol', 'pext']) g.setAttribute(name, base.attributes[name]);
      g.setAttribute('ipose', new THREE.InstancedBufferAttribute(pose, 4));
      g.setAttribute('ikey', new THREE.InstancedBufferAttribute(key, 1));
      g.instanceCount = n;
      const mesh = new THREE.Mesh(g, this.fallbackMat);
      mesh.frustumCulled = false;
      (mesh as { parent: THREE.Object3D | null }).parent = this.group;
      meshes.push(mesh);
    }
    this.cellMeshes[c] = meshes;
  }

  /** WebGL 2: cells near and in view. */
  private updateFallback(camera: THREE.Camera, camPos: THREE.Vector3): void {
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.fbFrustum.setFromProjectionMatrix(this.pv, camera.coordinateSystem, (camera as THREE.PerspectiveCamera).reversedDepth);
    const out = this.group.children;
    out.length = 0;
    const R = 420 * this.pixelScale;
    const c0x = Math.floor((camPos.x - R + MAP_CELLS * 128) / 256), c1x = Math.floor((camPos.x + R + MAP_CELLS * 128) / 256);
    const c0z = Math.floor((camPos.z - R + MAP_CELLS * 128) / 256), c1z = Math.floor((camPos.z + R + MAP_CELLS * 128) / 256);
    for (let cz = Math.max(0, c0z); cz <= Math.min(MAP_CELLS - 1, c1z); cz++) {
      for (let cx = Math.max(0, c0x); cx <= Math.min(MAP_CELLS - 1, c1x); cx++) {
        const list = this.cellMeshes[cz * MAP_CELLS + cx];
        if (!list) continue;
        const x0 = cellOriginX(cx), z0 = cellOriginX(cz);
        this.fbBox.min.set(x0 - 8, -100, z0 - 8);
        this.fbBox.max.set(x0 + 264, 600, z0 + 264);
        if (!this.fbFrustum.intersectsBox(this.fbBox)) continue;
        for (const m of list) out.push(m);
      }
    }
  }

  /** Before drawing: culling on the GPU (or choosing the cells, on WebGL 2). */
  update(renderer: THREE.WebGPURenderer, camera: THREE.Camera, camPos: THREE.Vector3, now: number): void {
    if (now - this.signalSent > 250) { this.signalSent = now; this.signalTex.needsUpdate = true; }
    if (!this.enabled) { this.updateResidency(camPos); this.updateFallback(camera, camPos); return; }
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv, camera.coordinateSystem, (camera as THREE.PerspectiveCamera).reversedDepth);
    this.frustum.planes.forEach((p, k) => this.planes[k].set(p.normal.x, p.normal.y, p.normal.z, p.constant));
    this.camU.value.copy(camPos);
    (this.sunU.value as THREE.Vector3).copy(sunDirection);
    this.kinds.forEach((d, k) => d.dist.forEach((x, l) => { this.distArr[k * LODS + l] = d.lods[l] && this.kindNear[k] > 0 ? x * this.pixelScale : 0; }));
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
    renderer.compute(this.reset);
    renderer.compute(this.count);
    renderer.compute(this.prefix);
    renderer.compute(this.cull);
  }

  /** Forgets everything (another city): results still on their way are ignored by version. */
  clear(): void {
    for (const c of [...this.blocks.resident]) { this.clearBlocks(this.blocks.release(c)); this.forgetKinds(c); }
    for (let c = 0; c < CELL_COUNT; c++) {
      if (!this.enabled) this.setCellFallback(c, null);
      this.cellVer[c]++; this.cellReq[c] = 0; this.cellHave[c] = -1;
    }
    this.pending.clear();
    this.residencyDue = true;
  }
}

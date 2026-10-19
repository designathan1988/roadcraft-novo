// CDLOD terrain: one instanced grid mesh, one draw call. The height comes from a layered texture (one layer per
// tile), read in the vertex shader with a manual bilinear filter, the same as world/heights.ts. Nodes are chosen by
// a quadtree from the camera: the cost follows what is seen. Grass tufts near the camera are one more instanced
// mesh on a camera-locked grid (a child of the terrain mesh), drawn only when the camera is near the ground.

import * as THREE from 'three/webgpu';
import { currentU, foamU, waveU } from './scene.ts';
import { windU } from './weather.ts';
import { T, withPrevious, type Node } from './tsl.ts';
import { GRASS_TEX, GRASS_TILE } from './surfaceBake.ts';
import { SHADOW_ONLY_LAYER, SHADOW_REACH } from './sun.ts';
import {
  HEIGHT_SPACING, HEIGHT_TILE_RES, MAP_HALF, MAP_SIZE, MAP_TILES, PLATE_SIZE, SEA_LEVEL, TILE_SIZE,
} from '../config.ts';
import { tileX, tileId } from '../core/grid.ts';
import { PAINT_COARSE } from '../jobs/roadPaint.ts';
import { GROUND_COLORS, NO_WATER, WATER_SPACING, WATER_TILE_RES } from '../world/ground.ts';
import type { World } from '../world/world.ts';

/** Grid on the map switched on (0/1). */
export const gridU = T.uniform(0);

const {
  Fn, attribute, clamp, float, floor, fract, int, ivec2, max, mix, normalize, smoothstep, textureLoad,
  transformNormalToView, uniform, varyingProperty, vec2, vec3, vec4, length, abs, sRGBTransferEOTF,
  positionWorld, fwidth, mx_noise_float, select, texture, instanceIndex, hash, sin, cos, time, positionLocal, step,
} = T;

/** Colour of each ground kind (sRGB). */
const GROUND_TABLE = T.uniformArray(GROUND_COLORS.concat(new Array(16 - GROUND_COLORS.length).fill(0x6b8545)).map((h) => new THREE.Vector4(((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255, 1)), 'vec4');

const GRID = 32; // squares per side of a patch
const LEAF = 128; // side of the finest node (m) → 4 m between vertices
const LEVELS = Math.log2(PLATE_SIZE / LEAF) + 1; // 0..4
const MAX_NODES = 4096;
/** The shadow copy of the terrain: its LOD factor (coarser than the view's), how far round the camera it goes (the
 *  cascades' reach plus a ridge's shadow) and how much it is sunk (the coarse copy must not shadow the fine ground). */
const SHADOW_LOD = 1.6;
const SHADOW_SINK = 1.5;
const MAX_SHADOW_NODES = 1024;
/** Water tiles nearer than this (m) use the 8 m grid; farther ones the 32 m grid. */
const WATER_FINE = 1500;

/** Grass tufts: grid spacing (m), tufts per side of the camera-locked grid, and the eye height above which they go. */
const TUFT_STEP = 0.9;
const TUFT_SIDE = 160;
const TUFT_EYE = 140;
/** Blades per tuft (one triangle each). */
const BLADES = 7;

type N = Node;

export class TerrainRenderer {
  readonly mesh: THREE.Mesh;
  readonly heightTex: THREE.DataArrayTexture;
  /** Roads painted (far): fine 256² and coarse 32² per tile. */
  readonly paintFine: THREE.DataArrayTexture;
  readonly paintCoarse: THREE.DataArrayTexture;
  /** Painted ground (kind, strength, forest, clearing) per 4 m sample. */
  readonly groundTex: THREE.DataArrayTexture;
  /** Water level (8 m) and its mesh (only on the tiles with water). */
  readonly waterTex: THREE.DataArrayTexture;
  readonly waterMesh: THREE.Mesh;
  /** Grass tufts round the camera (a child of `mesh`). */
  readonly grassMesh: THREE.Mesh;
  /**
   * The terrain's sun shadow: a coarse copy round the camera (behind it too: a ridge behind the camera shadows the
   * valley in view), in a layer only the cascades' cameras see. A child of `mesh`.
   */
  readonly shadowMesh: THREE.Mesh;
  private shadowGeo: THREE.InstancedBufferGeometry;
  private shadowInst: THREE.InstancedBufferAttribute;
  private shadowArray = new Float32Array(MAX_SHADOW_NODES * 4);
  private shadowCount = 0;
  private shadowRangeBase: Node = uniform(LEAF * SHADOW_LOD);
  private waterGeo: THREE.InstancedBufferGeometry;
  private waterInst: THREE.InstancedBufferAttribute;
  /** Water tiles far from the camera: a 32 m grid (a child of `waterMesh`). */
  readonly waterFar: THREE.Mesh;
  private waterFarGeo: THREE.InstancedBufferGeometry;
  private waterFarInst: THREE.InstancedBufferAttribute;
  /** Frame a water tile was last chosen in (one entry per tile and frame). */
  private waterSeen = new Uint32Array(MAP_TILES * MAP_TILES);
  private waterFrame = 0;
  private waterBox = new THREE.Box3();
  private waterNear = 0;
  private waterFarCount = 0;
  /** Grass colours by biome. */
  readonly grassA: Node = uniform(new THREE.Color().setRGB(0.275, 0.39, 0.185, THREE.LinearSRGBColorSpace));
  readonly grassB: Node = uniform(new THREE.Color().setRGB(0.345, 0.447, 0.227, THREE.LinearSRGBColorSpace));
  private geometry: THREE.InstancedBufferGeometry;
  private inst: THREE.InstancedBufferAttribute;
  private instArray: Float32Array;
  private ranges = new Float64Array(LEVELS + 1);
  private count = 0;
  private world: World;
  private frustum = new THREE.Frustum();
  private box = new THREE.Box3();
  private camPos = new THREE.Vector3();

  /** Brush position (x, z, radius, visible). */
  readonly brush: Node = uniform(new THREE.Vector4(0, 0, 50, 0));
  readonly camUniform: Node = uniform(new THREE.Vector3());
  /** Centre of the grass field: on the ground ahead of the eye, where the view looks. */
  private grassCentre: Node = uniform(new THREE.Vector2());
  private fwd = new THREE.Vector3();
  readonly rangeBase: Node = uniform(0);
  /** Distance factor of the LOD bands (larger = more detail). */
  lodFactor = 5;

  constructor(world: World) {
    this.world = world;
    this.heightTex = new THREE.DataArrayTexture(world.heights, HEIGHT_TILE_RES, HEIGHT_TILE_RES, MAP_TILES * MAP_TILES);
    this.heightTex.format = THREE.RedFormat;
    this.heightTex.type = THREE.FloatType;
    this.heightTex.minFilter = THREE.NearestFilter;
    this.heightTex.magFilter = THREE.NearestFilter;
    this.heightTex.generateMipmaps = false;
    this.heightTex.needsUpdate = true;

    const mkPaint = (res: number) => {
      const t = new THREE.DataArrayTexture(new Uint8Array(res * res * 4 * MAP_TILES * MAP_TILES), res, res, MAP_TILES * MAP_TILES);
      t.format = THREE.RGBAFormat;
      t.type = THREE.UnsignedByteType;
      t.minFilter = THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.generateMipmaps = false;
      t.needsUpdate = true;
      return t;
    };
    this.paintFine = mkPaint(HEIGHT_TILE_RES);
    this.paintCoarse = mkPaint(PAINT_COARSE);
    this.groundTex = new THREE.DataArrayTexture(new Uint8Array(world.groundSab), WATER_TILE_RES, WATER_TILE_RES, MAP_TILES * MAP_TILES);
    this.groundTex.format = THREE.RGBAFormat;
    this.groundTex.type = THREE.UnsignedByteType;
    this.groundTex.minFilter = THREE.NearestFilter;
    this.groundTex.magFilter = THREE.NearestFilter;
    this.groundTex.generateMipmaps = false;
    this.groundTex.needsUpdate = true;
    this.waterTex = new THREE.DataArrayTexture(world.water, WATER_TILE_RES, WATER_TILE_RES, MAP_TILES * MAP_TILES);
    this.waterTex.format = THREE.RedFormat;
    this.waterTex.type = THREE.FloatType;
    this.waterTex.minFilter = THREE.NearestFilter;
    this.waterTex.magFilter = THREE.NearestFilter;
    this.waterTex.generateMipmaps = false;
    this.waterTex.needsUpdate = true;

    // unit grid (u, v) in [0, 1]
    const g = new THREE.InstancedBufferGeometry();
    const verts = (GRID + 1) * (GRID + 1);
    const pos = new Float32Array(verts * 3);
    for (let j = 0, k = 0; j <= GRID; j++) for (let i = 0; i <= GRID; i++, k += 3) { pos[k] = i / GRID; pos[k + 2] = j / GRID; }
    const idx = new Uint16Array(GRID * GRID * 6);
    for (let j = 0, k = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++, k += 6) {
        const a = j * (GRID + 1) + i, b = a + 1, c = a + GRID + 1, d = c + 1;
        // alternating diagonal avoids a visual bias
        if ((i + j) & 1) { idx.set([a, c, b, b, c, d], k); } else { idx.set([a, c, d, a, d, b], k); }
      }
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.instArray = new Float32Array(MAX_NODES * 4);
    this.inst = new THREE.InstancedBufferAttribute(this.instArray, 4);
    this.inst.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('node', this.inst);
    g.instanceCount = 0;
    this.geometry = g;

    this.mesh = new THREE.Mesh(g, this.createMaterial());
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;

    // water of rivers and lakes: a grid per tile, instanced on the tiles with water that the terrain selection chose
    // this frame (in view): 8 m near the camera, 32 m far (every water tile drew the full 8 m grid, in view or not)
    const waterGrid = (WR: number) => {
      const wg = new THREE.InstancedBufferGeometry();
      const wpos = new Float32Array((WR + 1) * (WR + 1) * 3);
      for (let j = 0, k = 0; j <= WR; j++) for (let i = 0; i <= WR; i++, k += 3) { wpos[k] = i / WR; wpos[k + 2] = j / WR; }
      const widx = new Uint32Array(WR * WR * 6);
      for (let j = 0, k = 0; j < WR; j++) for (let i = 0; i < WR; i++, k += 6) {
        const a = j * (WR + 1) + i, b = a + 1, c = a + WR + 1, d = c + 1;
        widx.set([a, c, b, b, c, d], k);
      }
      wg.setAttribute('position', new THREE.BufferAttribute(wpos, 3));
      wg.setIndex(new THREE.BufferAttribute(widx, 1));
      const inst = new THREE.InstancedBufferAttribute(new Float32Array(MAP_TILES * MAP_TILES), 1);
      inst.setUsage(THREE.DynamicDrawUsage);
      wg.setAttribute('wtile', inst);
      wg.instanceCount = 0;
      return { wg, inst };
    };
    const near = waterGrid(WATER_TILE_RES), far = waterGrid(WATER_TILE_RES / 4);
    this.waterGeo = near.wg; this.waterInst = near.inst;
    this.waterFarGeo = far.wg; this.waterFarInst = far.inst;
    const waterMat = this.createWaterMaterial();
    this.waterMesh = new THREE.Mesh(near.wg, waterMat);
    this.waterMesh.frustumCulled = false;
    this.waterFar = new THREE.Mesh(far.wg, waterMat);
    this.waterFar.frustumCulled = false;
    // drawn with the near grid's mesh (a child: whoever adds the water adds both)
    this.waterMesh.add(this.waterFar);

    this.grassMesh = this.createGrass();
    this.mesh.add(this.grassMesh);

    const sg = new THREE.InstancedBufferGeometry();
    sg.setAttribute('position', g.attributes.position);
    sg.setIndex(g.index);
    this.shadowInst = new THREE.InstancedBufferAttribute(this.shadowArray, 4);
    this.shadowInst.setUsage(THREE.DynamicDrawUsage);
    sg.setAttribute('node', this.shadowInst);
    sg.instanceCount = 0;
    this.shadowGeo = sg;
    this.shadowMesh = new THREE.Mesh(sg, this.createShadowMaterial());
    this.shadowMesh.frustumCulled = false;
    this.shadowMesh.castShadow = true;
    this.shadowMesh.receiveShadow = false;
    this.shadowMesh.layers.set(SHADOW_ONLY_LAYER);
    this.mesh.add(this.shadowMesh);
    this.setLodFactor(this.lodFactor);
  }

  setLodFactor(f: number): void {
    this.lodFactor = f;
    for (let l = 0; l <= LEVELS; l++) this.ranges[l] = LEAF * (1 << l) * f;
    this.rangeBase.value = LEAF * f;
  }

  /** Height texture read: global sample (gx, gz) → height. */
  private loadH(gx: N, gz: N): N {
    const RES = HEIGHT_TILE_RES * MAP_TILES;
    const cx = clamp(gx, int(0), int(RES - 1));
    const cz = clamp(gz, int(0), int(RES - 1));
    const layer = cz.shiftRight(int(8)).mul(int(MAP_TILES)).add(cx.shiftRight(int(8)));
    return textureLoad(this.heightTex, ivec2(cx.bitAnd(int(255)), cz.bitAnd(int(255)))).depth(layer).r;
  }

  /** Painted ground sample (kind, strength, forest, clearing) at a global 4 m sample. */
  private loadG(gx: N, gz: N): N {
    const GRES = WATER_TILE_RES * MAP_TILES;
    const cx = clamp(gx, int(0), int(GRES - 1));
    const cz = clamp(gz, int(0), int(GRES - 1));
    const layer = cz.shiftRight(int(7)).mul(int(MAP_TILES)).add(cx.shiftRight(int(7)));
    return textureLoad(this.groundTex, ivec2(cx.bitAnd(int(127)), cz.bitAnd(int(127)))).depth(layer);
  }

  private heightFn(): N {
    return Fn(([p]: [N]) => {
      const f = p.add(float(MAP_HALF)).div(float(HEIGHT_SPACING));
      const i = floor(f);
      const t = f.sub(i);
      const ix = int(i.x), iz = int(i.y);
      const h00 = this.loadH(ix, iz), h10 = this.loadH(ix.add(1), iz);
      const h01 = this.loadH(ix, iz.add(1)), h11 = this.loadH(ix.add(1), iz.add(1));
      return mix(mix(h00, h10, t.x), mix(h01, h11, t.x), t.y);
    });
  }

  /** Road coverage (fine and coarse paint) at a world xz, for the vertex shaders. */
  private roadCover(xz: N): N {
    const tileF = clamp(floor(xz.add(float(MAP_HALF)).div(float(TILE_SIZE))), 0, float(MAP_TILES - 1));
    const layerV = int(tileF.y.mul(MAP_TILES).add(tileF.x));
    const uvV = xz.add(float(MAP_HALF)).div(float(TILE_SIZE)).sub(tileF);
    const fineV = texture(this.paintFine, uvV).depth(layerV).level(0);
    const coarseV = texture(this.paintCoarse, uvV).depth(layerV).level(0);
    return max(max(fineV.x, fineV.y), smoothstep(0, 0.25, max(coarseV.x, coarseV.y)));
  }

  private createMaterial(): THREE.MeshStandardNodeMaterial {
    const heightAt = this.heightFn();
    const vNormal = varyingProperty('vec3', 'vTerrainNormal');
    const vMorph = varyingProperty('float', 'vTerrainMorph');
    const cam = this.camUniform;
    const rangeBase = this.rangeBase;

    const position = Fn(() => {
      const node = attribute('node', 'vec4');
      const uv = attribute('position', 'vec3').xz;
      const size = node.z;
      const level = node.w;
      const step = size.div(float(GRID));
      const xz = node.xy.add(uv.mul(size));
      const h0 = heightAt(xz);
      const dist = length(vec3(xz.x, h0, xz.y).sub(cam));
      const range = rangeBase.mul(level.exp2());
      const morph = clamp(dist.sub(range.mul(0.72)).div(range.mul(0.28)), 0, 1);
      // odd vertices slide onto the grid of the level above
      const g = uv.mul(float(GRID));
      const odd = fract(g.mul(0.5)).mul(2);
      const mxz = xz.sub(odd.mul(step).mul(morph));
      // under the roads, on the coarse levels: the 8-64 m triangle does not follow the conformed cut/fill and rose over
      // the carriageway and sidewalk far away (the road "blinked" into the lawn). It drops by the level's step, by the
      // road mask (the one that paints the ground)
      const cover = this.roadCover(mxz);
      const spacing = step.mul(morph.add(1));
      // and 0.4 m at the finest level too: the 4 m grid does not follow the junction fans and corners, and it surfaced
      // through the asphalt in the middle of junctions (the road skirts reach 0.7 m)
      const sink = cover.mul(clamp(spacing.sub(float(HEIGHT_SPACING)).mul(0.08), 0, 3).add(smoothstep(0.35, 0.7, cover).mul(0.4)));
      const y = heightAt(mxz).sub(sink);
      // normal by central differences at the level's scale
      const e = max(step, float(HEIGHT_SPACING));
      const hl = heightAt(mxz.sub(vec2(e, 0))), hr = heightAt(mxz.add(vec2(e, 0)));
      const hd = heightAt(mxz.sub(vec2(0, e))), hu = heightAt(mxz.add(vec2(0, e)));
      vNormal.assign(normalize(vec3(hl.sub(hr), e.mul(2), hd.sub(hu))));
      vMorph.assign(morph);
      return vec3(mxz.x, y, mxz.y);
    });

    const m = new THREE.MeshStandardNodeMaterial();
    m.positionNode = position();
    withPrevious(m);

    // fine relief (Roadcraft terrainRelief.ts, here analytic): on slopes the normal is bent by a ridged noise, so dirt
    // and rock read as eroded ground near the camera; it fades before it turns into noise far away
    const relief = Fn(() => {
      const n = normalize(vNormal);
      const p = positionWorld;
      const slope = float(1).sub(n.y);
      const fade = clamp(float(1).sub(fwidth(p.x).div(0.8)), 0, 1).mul(smoothstep(0.08, 0.3, slope));
      const q = p.xz.mul(0.45).add(vec2(p.y.mul(0.3), 0));
      const e = 0.35;
      const h = (o: N) => abs(mx_noise_float(q.add(o)));
      const h0 = h(vec2(0, 0));
      const dx = h(vec2(e, 0)).sub(h0), dz = h(vec2(0, e)).sub(h0);
      return normalize(n.add(vec3(dx, 0, dz).mul(-2.2).mul(fade)));
    })();
    m.normalNode = transformNormalToView(relief);

    // colour: grass, dirt, rock, sand, by slope and height, with broad variation
    const color = Fn(() => {
      const n = normalize(vNormal);
      const p = positionWorld;
      const slope = float(1).sub(n.y);
      const big = mx_noise_float(p.xz.mul(1 / 180)).mul(0.5).add(0.5);
      const mid = mx_noise_float(p.xz.mul(1 / 23));
      // fades with distance before it turns into noise (fwidth > period)
      const fadeMid = clamp(float(1).sub(fwidth(p.xz.x).div(6)), 0, 1);
      const grassA = sRGBTransferEOTF(this.grassA);
      const grassB = sRGBTransferEOTF(this.grassB);
      const dirt = sRGBTransferEOTF(vec3(0.52, 0.45, 0.36));
      // rock in strata: bands by height broken by noise (Roadcraft's cliff walls)
      const strata = sin(p.y.mul(1.7).add(mid.mul(3))).mul(0.5).add(0.5);
      const rock = mix(sRGBTransferEOTF(vec3(0.43, 0.42, 0.4)), sRGBTransferEOTF(vec3(0.55, 0.52, 0.47)), strata.mul(fadeMid).add(float(1).sub(fadeMid).mul(0.5)));
      const sand = sRGBTransferEOTF(vec3(0.72, 0.66, 0.52));
      // the lawn a little darker than the biome colours: under ACES they read lime in full sun (Roadcraft: deep green)
      let c = mix(grassA, grassB, clamp(big.add(mid.mul(0.22).mul(fadeMid)), 0, 1)).mul(0.78);
      // baked lawn (tufts, soil in the gaps, dry patches; `surfaceBake.ts`) at two scales so it does not repeat; the
      // mipmap carries the average far away
      const g1 = texture(GRASS_TEX, p.xz.div(GRASS_TILE)).xyz.mul(2);
      const g2 = texture(GRASS_TEX, p.xz.div(GRASS_TILE * 4.37).add(0.37)).xyz.mul(2);
      c = c.mul(g1).mul(mix(vec3(1, 1, 1), g2, 0.45));
      const speck = clamp(g1.y.mul(0.5), 0, 1);
      c = mix(c, dirt, smoothstep(0.12, 0.25, slope.add(mid.mul(0.04).mul(fadeMid))));
      c = mix(c, rock, smoothstep(0.28, 0.42, slope));
      c = mix(c, sand, smoothstep(float(SEA_LEVEL + 2.5), float(SEA_LEVEL + 0.5), p.y));
      // painted ground: 4 neighbouring samples, each its own kind, blended (edge broken by noise)
      {
        const f = p.xz.add(float(MAP_HALF)).div(float(WATER_SPACING)).sub(0.5).add(mid.mul(0.3).mul(fadeMid));
        const i0 = floor(f), t = fract(f);
        const ix = int(i0.x), iz = int(i0.y);
        const g00 = this.loadG(ix, iz), g10 = this.loadG(ix.add(1), iz), g01 = this.loadG(ix, iz.add(1)), g11 = this.loadG(ix.add(1), iz.add(1));
        const tint = (gs: N) => {
          const kind = int(floor(gs.r.mul(255).add(0.5)));
          const col = sRGBTransferEOTF(GROUND_TABLE.element(kind).xyz);
          // stones and flowers: a fine dot texture (the blotch noise, computed once)
          const pc = mix(col, col.mul(mix(float(0.75), float(1.2), speck)), fadeMid);
          const painted = mix(c, pc, gs.g);
          // forest: dark leaf litter
          return mix(painted, sRGBTransferEOTF(vec3(0.24, 0.3, 0.16)), gs.b.mul(0.55));
        };
        const top = mix(tint(g00), tint(g10), t.x), bot = mix(tint(g01), tint(g11), t.x);
        c = mix(top, bot, t.y);
      }
      // roads painted on the ground (seen where the road mesh does not reach)
      const tileF = clamp(floor(p.xz.add(float(MAP_HALF)).div(float(TILE_SIZE))), 0, float(MAP_TILES - 1));
      const layer = int(tileF.y.mul(MAP_TILES).add(tileF.x));
      const uvT = p.xz.add(float(MAP_HALF)).div(float(TILE_SIZE)).sub(tileF);
      const fine = texture(this.paintFine, uvT).depth(layer);
      const coarse = texture(this.paintCoarse, uvT).depth(layer);
      const pix = fwidth(p.x).add(fwidth(p.z)).mul(0.5);
      const paint = mix(fine, coarse, smoothstep(5, 28, pix));
      c = mix(c, sRGBTransferEOTF(vec3(0.27, 0.28, 0.3)), paint.x);
      c = mix(c, sRGBTransferEOTF(vec3(0.72, 0.69, 0.64)), paint.y);
      // brush ring
      const b = this.brush;
      const d = length(p.xz.sub(b.xy));
      const w = max(fwidth(d), float(0.15)).mul(1.5);
      const ring = smoothstep(b.z.sub(w.mul(2)), b.z.sub(w), d).mul(smoothstep(b.z.add(w), b.z, d)).mul(b.w);
      const inner = smoothstep(b.z, float(0), d).mul(0.12).mul(b.w);
      c = mix(c, vec3(1.0, 0.85, 0.35), max(ring, inner));
      // grid on the map (optional): lines every 64 m, stronger every 256 m; they vanish far away
      const gl = (stepM: number, wid: number) => {
        const g2b = abs(fract(p.xz.div(stepM)).sub(0.5)).mul(stepM);
        const fw = max(fwidth(p.x), float(0.02)).mul(wid);
        return max(smoothstep(fw.mul(2), fw, g2b.x.sub(stepM / 2).abs()), smoothstep(fw.mul(2), fw, g2b.y.sub(stepM / 2).abs()));
      };
      const grid = max(gl(64, 1).mul(0.35), gl(256, 1.6).mul(0.6)).mul(gridU).mul(smoothstep(float(3), float(0.6), pix));
      c = mix(c, vec3(1, 1, 1), grid);
      // map edge
      const edge = max(abs(p.x), abs(p.z));
      c = select(edge.greaterThan(float(MAP_HALF - 0.5)), c.mul(0.6), c);
      return vec4(c, 1);
    });
    m.colorNode = color();
    m.roughnessNode = float(0.95);
    m.metalnessNode = float(0);
    return m;
  }

  /**
   * Grass tufts as in Roadcraft (grass.ts / grassField.ts): blades instanced on a grid locked to the camera (it moves
   * in whole steps: no swimming), each tuft placed on the height texture and skipped where there is a road, water,
   * sand, a slope, painted ground or forest litter. Shorter toward the edge of the field (no visible border). One
   * draw call; hidden when the eye is above TUFT_EYE m (city and neighbourhood views gain nothing).
   */
  private createGrass(): THREE.Mesh {
    const heightAt = this.heightFn();
    // one tuft: BLADES thin triangles round its centre (x, z jitter, lean, height factor in the colour slot)
    const pos: number[] = [], nrm: number[] = [], bl: number[] = [];
    let s = 3;
    const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let i = 0; i < BLADES; i++) {
      const a = r() * Math.PI * 2, d = r() * 0.3, w = 0.06 + r() * 0.04, h = 0.35 + r() * 0.3, turn = r() * Math.PI;
      const cx = Math.cos(a) * d, cz = Math.sin(a) * d, tx = Math.cos(turn) * w, tz = Math.sin(turn) * w;
      const lean = 0.06 + r() * 0.08;
      pos.push(cx - tx, 0, cz - tz, cx + tx, 0, cz + tz, cx + Math.cos(a) * lean, h, cz + Math.sin(a) * lean);
      for (let k = 0; k < 3; k++) { nrm.push(0, 1, 0); bl.push(k === 2 ? 1 : 0); }
    }
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
    g.setAttribute('tip', new THREE.BufferAttribute(new Float32Array(bl), 1));
    g.instanceCount = TUFT_SIDE * TUFT_SIDE;
    const centre = this.grassCentre;
    const vTip = varyingProperty('float', 'vGrassTip');
    const vShade = varyingProperty('float', 'vGrassShade');
    const position = Fn(() => {
      const id = instanceIndex.toFloat();
      const ix = id.mod(TUFT_SIDE), iz = floor(id.div(TUFT_SIDE));
      const origin = floor(centre.div(TUFT_STEP)).sub(TUFT_SIDE / 2);
      const cell = origin.add(vec2(ix, iz));
      const jx = hash(cell.x.mul(12.9).add(cell.y.mul(78.2))), jz = hash(cell.x.mul(39.3).add(cell.y.mul(11.1)));
      const base = cell.add(vec2(jx, jz)).mul(TUFT_STEP);
      const h = heightAt(base);
      // where grass grows: no road, no water, no sand, gentle slope, not painted or forest litter
      const e = float(HEIGHT_SPACING);
      const slope = abs(heightAt(base.add(vec2(e, 0))).sub(h)).add(abs(heightAt(base.add(vec2(0, e))).sub(h))).div(e);
      const gi = floor(base.add(float(MAP_HALF)).div(float(WATER_SPACING)));
      const gs = this.loadG(int(gi.x), int(gi.y));
      // painted ground: grass grows on the grassy kinds (auto, meadow, cerrado, flowers) however strong the paint
      const kind = floor(gs.r.mul(255).add(0.5));
      const grassy = max(max(step(kind, float(0.5)), step(abs(kind.sub(3)), float(0.5))), step(abs(kind.sub(11.5)), float(1)));
      const ok = step(this.roadCover(base), float(0.02)).mul(step(slope, float(0.35))).mul(step(float(SEA_LEVEL + 1.1), h))
        .mul(max(grassy, step(gs.g, float(0.3)))).mul(step(gs.b, float(0.5)));
      // shorter toward the edge of the field and with distance
      const dist = length(base.sub(centre));
      const grow = float(1).sub(smoothstep(float(TUFT_SIDE * TUFT_STEP * 0.3), float(TUFT_SIDE * TUFT_STEP * 0.5), dist));
      const k = ok.mul(grow).mul(hash(cell.x.mul(3.7).add(cell.y.mul(17.3))).mul(0.6).add(0.7));
      const yaw = jx.mul(6.283);
      const c = cos(yaw), sn = sin(yaw);
      const lp = positionLocal;
      const tip = attribute('tip', 'float');
      // wind: the tips bend with the wind
      const sway = sin(time.mul(windU.mul(2.5).add(1.6)).add(base.x.mul(0.31)).add(base.y.mul(0.23))).mul(windU.mul(0.08).add(0.025)).mul(tip);
      vTip.assign(tip);
      vShade.assign(jz);
      return vec3(lp.x.mul(c).add(lp.z.mul(sn)).add(sway), lp.y, lp.x.negate().mul(sn).add(lp.z.mul(c))).mul(k).add(vec3(base.x, h.add(0.01), base.y));
    });
    const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide });
    m.positionNode = position();
    withPrevious(m);
    const grassA = sRGBTransferEOTF(this.grassA), grassB = sRGBTransferEOTF(this.grassB);
    const base = mix(grassA, grassB, vShade).mul(texture(GRASS_TEX, positionWorld.xz.div(GRASS_TILE)).xyz.mul(2));
    // dark at the root (where it meets the lawn's colour), lighter and drier at the tip
    m.colorNode = vec4(mix(base.mul(0.85), base.mul(vec3(1.25, 1.2, 0.95)), vTip), 1);
    m.normalNode = transformNormalToView(vec3(0, 1, 0));
    m.roughnessNode = float(0.9);
    m.metalnessNode = float(0);
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    return mesh;
  }

  /** Water: surface at the stored level; colour by depth (ground read from the terrain's texture), foam at the shore. */
  private createWaterMaterial(): THREE.MeshStandardNodeMaterial {
    const wtex = this.waterTex;
    const WRES = WATER_TILE_RES * MAP_TILES;
    const loadW = (gx: N, gz: N) => {
      const cx = clamp(gx, int(0), int(WRES - 1)), cz = clamp(gz, int(0), int(WRES - 1));
      const layer = cz.shiftRight(int(7)).mul(int(MAP_TILES)).add(cx.shiftRight(int(7)));
      return textureLoad(wtex, ivec2(cx.bitAnd(int(127)), cz.bitAnd(int(127)))).depth(layer).r;
    };
    const vDepth = varyingProperty('float', 'vWaterDepth');
    const pos = Fn(() => {
      const tile = attribute('wtile', 'float');
      const tx = tile.mod(float(MAP_TILES)), tz = floor(tile.div(float(MAP_TILES)));
      const uv = attribute('position', 'vec3').xz;
      const xz = vec2(tx, tz).add(uv).mul(float(TILE_SIZE)).sub(float(MAP_HALF));
      // level at the vertex: the highest of the 4 neighbours with water (the edge runs a little under the bank)
      const g = xz.add(float(MAP_HALF)).div(float(WATER_SPACING));
      const ix = int(floor(g.x.add(0.5))), iz = int(floor(g.y.add(0.5)));
      const w = max(max(loadW(ix.sub(1), iz.sub(1)), loadW(ix, iz.sub(1))), max(loadW(ix.sub(1), iz), loadW(ix, iz)));
      const gh = this.loadH(int(floor(xz.x.add(float(MAP_HALF)).div(float(HEIGHT_SPACING)))), int(floor(xz.y.add(float(MAP_HALF)).div(float(HEIGHT_SPACING)))));
      vDepth.assign(w.sub(gh));
      // waves: the surface rises and falls a little (up to 0.35 m)
      const wave = T.sin(xz.x.mul(0.21).add(T.time.mul(1.3))).mul(T.sin(xz.y.mul(0.17).add(T.time.mul(1.1)))).mul(waveU.mul(0.35));
      // at the mouth (level at the sea's) the river's surface drops under the sea plane: with waves the two crossed and blinked
      const surf = select(w.lessThan(float(SEA_LEVEL + 0.6)), float(SEA_LEVEL - 0.3), w.add(wave));
      const y = select(w.greaterThan(float(NO_WATER + 1)), surf, float(-2000));
      return vec3(xz.x, y, xz.y);
    });
    const m = new THREE.MeshStandardNodeMaterial();
    m.positionNode = pos();
    withPrevious(m);
    const p = positionWorld;
    // current: the noise flows downwind; waves: stronger and faster; foam: white crests
    const flow = vec2(0.91, 0.41).mul(T.time.mul(currentU.mul(0.35).add(0.12)));
    const ripple = mx_noise_float(p.xz.mul(waveU.mul(0.08).add(0.1)).add(flow)).mul(0.5).add(0.5);
    const deep = sRGBTransferEOTF(vec3(0.03, 0.09, 0.11)), shallow = sRGBTransferEOTF(vec3(0.14, 0.26, 0.24));
    const depth = clamp(vDepth.div(3), 0, 1);
    const crest = smoothstep(float(1).sub(foamU.mul(0.35)), float(1.02), ripple).mul(waveU).mul(foamU);
    const foam = clamp(smoothstep(foamU.mul(0.5).add(0.15), 0.0, vDepth).mul(ripple.mul(0.6).add(0.4)).add(crest), 0, 1);
    m.colorNode = vec4(mix(mix(shallow, deep, depth), vec3(0.85, 0.88, 0.86), foam), 1);
    m.roughnessNode = mix(float(0.16), float(0.34), ripple.mul(waveU.add(0.4)));
    m.metalnessNode = float(0);
    m.maskNode = p.y.greaterThan(float(-1500));
    return m;
  }

  /** Depth only: the patch on the height texture, morphed between its levels like the view's, sunk SHADOW_SINK. */
  private createShadowMaterial(): THREE.MeshBasicNodeMaterial {
    const heightAt = this.heightFn();
    const cam = this.camUniform, rangeBase = this.shadowRangeBase;
    const position = Fn(() => {
      const node = attribute('node', 'vec4');
      const uv = attribute('position', 'vec3').xz;
      const size = node.z, level = node.w;
      const step = size.div(float(GRID));
      const xz = node.xy.add(uv.mul(size));
      const dist = length(vec3(xz.x, heightAt(xz), xz.y).sub(cam));
      const range = rangeBase.mul(level.exp2());
      const morph = clamp(dist.sub(range.mul(0.72)).div(range.mul(0.28)), 0, 1);
      const odd = fract(uv.mul(float(GRID)).mul(0.5)).mul(2);
      const mxz = xz.sub(odd.mul(step).mul(morph));
      return vec3(mxz.x, heightAt(mxz).sub(SHADOW_SINK), mxz.y);
    });
    const m = new THREE.MeshBasicNodeMaterial();
    m.positionNode = position();
    return m;
  }

  /** Map biome: grass colours. */
  setBiome(b: number): void {
    const pal: Array<[number, number]> = [[0x46642f, 0x58723a], [0x9c9450, 0xb0a565], [0x4e7a35, 0x5f8a40], [0x3f6e2c, 0x4f7f34], [0x8a8458, 0x9e906a], [0x7a9a50, 0x92a860], [0x5f8a45, 0x7a9050]];
    const [a, c] = pal[b] ?? pal[0];
    // sRGB components stored as they are (the shader converts)
    const set = (u: Node, h: number) => (u.value as THREE.Color).setRGB(((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255, THREE.LinearSRGBColorSpace);
    set(this.grassA, a); set(this.grassB, c);
  }

  /** Writes a tile's road paint and re-sends only that layer. */
  setRoadPaint(tile: number, fine: Uint8Array, coarse: Uint8Array): void {
    (this.paintFine.image.data as Uint8Array).set(fine, tile * fine.length);
    (this.paintCoarse.image.data as Uint8Array).set(coarse, tile * coarse.length);
    this.paintFine.addLayerUpdate(tile);
    this.paintCoarse.addLayerUpdate(tile);
    this.paintFine.needsUpdate = true;
    this.paintCoarse.needsUpdate = true;
  }

  /** Re-sends to the GPU only the changed layers (tiles). */
  uploadDirtyLayers(): void {
    const w = this.world;
    if (w.groundDirty.size) { for (const l of w.groundDirty) this.groundTex.addLayerUpdate(l); w.groundDirty.clear(); this.groundTex.needsUpdate = true; }
    if (w.waterDirty.size) {
      for (const l of w.waterDirty) this.waterTex.addLayerUpdate(l);
      w.waterDirty.clear(); this.waterTex.needsUpdate = true;
    }
    const dirty = this.world.layerDirty;
    if (dirty.size === 0) return;
    for (const l of dirty) this.heightTex.addLayerUpdate(l);
    dirty.clear();
    this.heightTex.needsUpdate = true;
  }

  /** CDLOD selection from the camera. */
  update(camera: THREE.Camera, viewPos: THREE.Vector3): void {
    camera.updateMatrixWorld();
    const pv = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(pv, camera.coordinateSystem, (camera as THREE.PerspectiveCamera).reversedDepth);
    this.camPos.copy(viewPos);
    this.camUniform.value.copy(viewPos);
    // grass only near the ground (orthographic views and high cameras: none)
    const eyeAboveGround = viewPos.y - this.groundAt(viewPos.x, viewPos.z);
    this.grassMesh.visible = (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true && eyeAboveGround < TUFT_EYE;
    camera.getWorldDirection(this.fwd);
    const ahead = Math.min(45, eyeAboveGround * 1.2 + 10);
    const fl = Math.hypot(this.fwd.x, this.fwd.z) || 1;
    (this.grassCentre.value as THREE.Vector2).set(viewPos.x + this.fwd.x / fl * ahead, viewPos.z + this.fwd.z / fl * ahead);
    this.count = 0;
    this.waterFrame++;
    this.waterNear = 0; this.waterFarCount = 0;
    const roots = Math.ceil(MAP_SIZE / PLATE_SIZE);
    const top = LEVELS - 1;
    for (let rz = 0; rz < roots; rz++) {
      for (let rx = 0; rx < roots; rx++) {
        const x = rx * PLATE_SIZE - MAP_HALF, z = rz * PLATE_SIZE - MAP_HALF;
        // a root beyond the coarsest band (16-24 km maps) is drawn whole, but only when in view
        if (!this.select(x, z, PLATE_SIZE, top) && this.frustum.intersectsBox(this.bounds(x, z, PLATE_SIZE))) this.add(x, z, PLATE_SIZE, top);
      }
    }
    this.geometry.instanceCount = this.count;
    // the shadow copy: every patch round the camera within the cascades' reach, in view or not
    this.shadowCount = 0;
    for (let rz = 0; rz < roots; rz++) for (let rx = 0; rx < roots; rx++) this.selectShadow(rx * PLATE_SIZE - MAP_HALF, rz * PLATE_SIZE - MAP_HALF, PLATE_SIZE, top);
    this.shadowGeo.instanceCount = this.shadowCount;
    this.shadowInst.clearUpdateRanges();
    this.shadowInst.addUpdateRange(0, this.shadowCount * 4);
    this.shadowInst.needsUpdate = true;
    for (const [g, a, n] of [[this.waterGeo, this.waterInst, this.waterNear], [this.waterFarGeo, this.waterFarInst, this.waterFarCount]] as const) {
      g.instanceCount = n;
      a.clearUpdateRanges();
      a.addUpdateRange(0, n);
      a.needsUpdate = true;
    }
    this.inst.clearUpdateRanges();
    this.inst.addUpdateRange(0, this.count * 4);
    this.inst.needsUpdate = true;
  }

  /** Ground height at a point from the tile bounds' table (cheap; enough to tell how high the eye is). */
  private groundAt(x: number, z: number): number {
    const tx = Math.min(MAP_TILES - 1, Math.max(0, tileX(x))), tz = Math.min(MAP_TILES - 1, Math.max(0, tileX(z)));
    const t = tileId(tx, tz);
    return (this.world.tileMin[t] + this.world.tileMax[t]) / 2;
  }

  private add(x: number, z: number, size: number, level: number): void {
    if (this.count >= MAX_NODES) return;
    // nodes past the map's edge (2048 roots on a 10240 map) are cut
    if (x >= MAP_HALF || z >= MAP_HALF) return;
    const o = this.count * 4;
    this.instArray[o] = x; this.instArray[o + 1] = z; this.instArray[o + 2] = size; this.instArray[o + 3] = level;
    this.count++;
    // the water tiles under this patch, once per frame: near ones get the 8 m grid
    const w = this.world;
    const tx0 = tileX(x), tx1 = tileX(Math.min(x + size, MAP_HALF) - 1), tz0 = tileX(z), tz1 = tileX(Math.min(z + size, MAP_HALF) - 1);
    for (let tz = tz0; tz <= tz1; tz++) for (let tx = tx0; tx <= tx1; tx++) {
      const t = tileId(tx, tz);
      if (!w.tileWater[t] || this.waterSeen[t] === this.waterFrame) continue;
      this.waterSeen[t] = this.waterFrame;
      const ox = tx * TILE_SIZE - MAP_HALF, oz = tz * TILE_SIZE - MAP_HALF;
      // a big patch spans several tiles: each one is tested on its own (water level is at most the tile's top)
      this.waterBox.min.set(ox, w.tileMin[t] - 2, oz);
      this.waterBox.max.set(ox + TILE_SIZE, w.tileMax[t] + 2, oz + TILE_SIZE);
      if (!this.frustum.intersectsBox(this.waterBox)) continue;
      const d = Math.hypot(Math.max(ox - this.camPos.x, 0, this.camPos.x - ox - TILE_SIZE), Math.max(oz - this.camPos.z, 0, this.camPos.z - oz - TILE_SIZE));
      if (d < WATER_FINE) (this.waterInst.array as Float32Array)[this.waterNear++] = t;
      else (this.waterFarInst.array as Float32Array)[this.waterFarCount++] = t;
    }
  }

  private bounds(x: number, z: number, size: number): THREE.Box3 {
    const tx0 = tileX(x), tx1 = tileX(Math.min(x + size, MAP_HALF) - 1);
    const tz0 = tileX(z), tz1 = tileX(Math.min(z + size, MAP_HALF) - 1);
    let lo = Infinity, hi = -Infinity;
    for (let tz = tz0; tz <= tz1; tz++) for (let tx = tx0; tx <= tx1; tx++) {
      const t = tileId(tx, tz);
      lo = Math.min(lo, this.world.tileMin[t]); hi = Math.max(hi, this.world.tileMax[t]);
    }
    this.box.min.set(x, lo, z);
    this.box.max.set(Math.min(x + size, MAP_HALF), hi, Math.min(z + size, MAP_HALF));
    return this.box;
  }

  /** true if the node (or its children) was handled; false if it is outside its band. */
  private select(x: number, z: number, size: number, level: number): boolean {
    if (x >= MAP_HALF || z >= MAP_HALF) return true;
    const b = this.bounds(x, z, size);
    if (b.distanceToPoint(this.camPos) > this.ranges[level]) return false;
    if (!this.frustum.intersectsBox(b)) return true;
    if (level === 0) { this.add(x, z, size, level); return true; }
    const childRange = this.ranges[level - 1];
    if (b.distanceToPoint(this.camPos) > childRange) { this.add(x, z, size, level); return true; }
    const h = size / 2;
    for (let k = 0; k < 4; k++) {
      const cx = x + (k & 1 ? h : 0), cz = z + (k & 2 ? h : 0);
      // child outside its band: draws the quadrant at the child's density, already fully morphed
      if (!this.select(cx, cz, h, level - 1)) {
        const cb = this.bounds(cx, cz, h);
        if (this.frustum.intersectsBox(cb)) this.add(cx, cz, h, level - 1);
      }
    }
    return true;
  }

  /** The shadow copy's quadtree: within SHADOW_REACH of the eye, by the copy's coarser bands, without the view test. */
  private selectShadow(x: number, z: number, size: number, level: number): void {
    if (x >= MAP_HALF || z >= MAP_HALF) return;
    const d = this.bounds(x, z, size).distanceToPoint(this.camPos);
    if (d > SHADOW_REACH) return;
    if (level > 0 && d < LEAF * (1 << (level - 1)) * SHADOW_LOD) {
      const h = size / 2;
      for (let k = 0; k < 4; k++) this.selectShadow(x + (k & 1 ? h : 0), z + (k & 2 ? h : 0), h, level - 1);
      return;
    }
    if (this.shadowCount >= MAX_SHADOW_NODES) return;
    const o = this.shadowCount++ * 4;
    this.shadowArray[o] = x; this.shadowArray[o + 1] = z; this.shadowArray[o + 2] = size; this.shadowArray[o + 3] = level;
  }

  /** Tile side, for whoever needs it. */
  static readonly tileSize = TILE_SIZE;
}

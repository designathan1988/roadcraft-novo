// CDLOD terrain: one instanced grid mesh, one draw call. The height comes from a layered texture (one layer per
// tile), read in the vertex shader with a manual bilinear filter, the same as world/heights.ts. Nodes are chosen by
// a quadtree from the camera: the cost follows what is seen. Grass tufts near the camera are one more instanced
// mesh on a camera-locked grid (a child of the terrain mesh), drawn only when the camera is near the ground.

import * as THREE from 'three/webgpu';
import { currentU, foamU, waterEnv, waveU } from './scene.ts';
import { windDirU, windU } from './weather.ts';
import { T, withPrevious, type Node } from './tsl.ts';
import { GroundOverlays } from './groundOverlays.ts';
import { TERRAIN_NOISE, WATER_TEX } from './surfaceBake.ts';
import { COOKED, LAND, loadCookedSurfaces } from './cookedSurfaces.ts';
import { rockColour, rockNormal, soilTint } from './terrainRock.ts';
import {
  HEIGHT_SPACING, HEIGHT_TILE_RES, MAP_HALF, MAP_SIZE, MAP_TAG, MAP_TILES, PLATE_SIZE, SEA_LEVEL, TILE_SIZE,
} from '../config.ts';
import { tileX, tileId } from '../core/grid.ts';
import { PAINT_COARSE } from '../jobs/roadPaint.ts';
import { POINT_EDGE_X, POINT_EDGE_Z, POINT_GROUND, SEAM_CELLS, SEAM_SUB } from '../jobs/terrainSeams.ts';
import { ECO_RES } from './ecology.ts';
import { SLOPE_RES } from './landSlope.ts';
import { GROUND_COLORS, NO_WATER, WATER_SPACING, WATER_TILE_RES } from '../world/ground.ts';
import type { World } from '../world/world.ts';
import { heightAt } from '../world/heights.ts';
import { parkMiller } from '../core/rng.ts';

/**
 * Farthest the terrain is cut along the roads (render/terrainSeams.ts, jobs/terrainSeams.ts): the 4 m cells the seams
 * hold are not drawn and nothing sinks under the roads within it. The seam layer draws its cells up to here; the
 * terrain applies the cut within `seamReachU`, never past the finest level's unmorphed band (0.7 of LEAF × lodFactor),
 * so the seams always meet unmorphed 4 m vertices.
 */
export const SEAM_REACH = 440;


const {
  Fn, attribute, clamp, float, floor, fract, int, ivec2, max, mix, normalize, smoothstep, textureLoad, cameraPosition, pow, dot,
  transformNormalToView, uniform, varyingProperty, vec2, vec3, vec4, length, abs, sRGBTransferEOTF,
  positionWorld, fwidth, mx_noise_float, select, texture, instanceIndex, hash, sin, cos, time, positionLocal, step, modelWorldMatrix,
} = T;

/** Colour of each ground kind (sRGB). */
const GROUND_TABLE = T.uniformArray(GROUND_COLORS.concat(new Array(16 - GROUND_COLORS.length).fill(0x6b8545)).map((h) => new THREE.Vector4(((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255, 1)), 'vec4');

const GRID = 32; // squares per side of a patch
const LEAF = 128; // side of the finest node (m) → 4 m between vertices
const LEVELS = Math.log2(PLATE_SIZE / LEAF) + 1; // 0..4
const MAX_NODES = 4096;
/** Mean luma (0.3, 0.6, 0.1 weights) of the 4.0 grass texture, linear (its last mip, measured from the file). */
const GRASS_MEAN = 0.0864;
/** Water tiles nearer than this (m) use the 8 m grid; farther ones the 32 m grid. */
const WATER_FINE = 1500;

/** Grass tufts: grid spacing (m), tufts per side of the camera-locked grid, and the eye height above which they go. */
const TUFT_STEP = 0.9;
const TUFT_SIDE = 160;
const TUFT_EYE = 140;
/** Blades per tuft (one triangle each). */
const BLADES = 7;

type N = Node;

/**
 * The water's material: a standard one whose specular lobe is the water's Fresnel, as 4.0's (water.ts:359-366: both
 * the direct and the environment lobe take mix(0.04, 1, F), F90 = 1), not the standard 0.04 everywhere.
 */
class WaterNodeMaterial extends THREE.MeshStandardNodeMaterial {
  fresnelNode: Node | null = null;
  override setupSpecular(): void {
    if (!this.fresnelNode) { super.setupSpecular(); return; }
    const s = mix(vec3(0.04), vec3(1), this.fresnelNode);
    T.specularColor.assign(s);
    T.specularColorBlended.assign(s);
    T.specularF90.assign(1);
  }
}

export class TerrainRenderer {
  readonly mesh: THREE.Mesh;
  readonly heightTex: THREE.DataArrayTexture;
  /** Roads painted (far): fine 256² and coarse 32² per tile. */
  readonly paintFine: THREE.DataArrayTexture;
  readonly paintCoarse: THREE.DataArrayTexture;
  /** Painted ground (kind, strength, forest, clearing) per 4 m sample. */
  readonly groundTex: THREE.DataArrayTexture;
  /** The ecology field per tile (render/ecology.ts: dry grass, wet ground, bare ground), from its own worker. */
  readonly ecoTex: THREE.DataArrayTexture;
  /** The land's slope per height corner (landSlope.ts), one layer a tile, filled with the ecology. */
  private readonly slopeTex: THREE.DataArrayTexture;
  private ecoWorker: Worker | null = null;
  /** Tiles waiting for the ecology worker, and the one it is computing. */
  private ecoQueue = new Set<number>();
  private ecoBusy = -1;
  /** Water level (8 m) and its mesh (only on the tiles with water). */
  readonly waterTex: THREE.DataArrayTexture;
  readonly waterMesh: THREE.Mesh;
  /** Grass tufts round the camera (a child of `mesh`). */
  readonly grassMesh: THREE.Mesh;
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
  /** The brush ring and the grid drawn over the ground (render/groundOverlays.ts). */
  readonly overlays = new GroundOverlays();
  readonly camUniform: Node = uniform(new THREE.Vector3());
  /** Centre of the grass field: on the ground ahead of the eye, where the view looks. */
  private grassCentre: Node = uniform(new THREE.Vector2());
  private fwd = new THREE.Vector3();
  readonly rangeBase: Node = uniform(0);
  /** Distance factor of the LOD bands (larger = more detail). */
  lodFactor = 5;
  /** How far the seams are applied now (`SEAM_REACH`, within the finest level's unmorphed band). */
  private seamReachU = uniform(SEAM_REACH);

  constructor(world: World) {
    this.world = world;
    loadCookedSurfaces();
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

    const ecoSab = new SharedArrayBuffer(ECO_RES * ECO_RES * 4 * MAP_TILES * MAP_TILES);
    this.ecoTex = new THREE.DataArrayTexture(new Uint8Array(ecoSab), ECO_RES, ECO_RES, MAP_TILES * MAP_TILES);
    this.ecoTex.format = THREE.RGBAFormat;
    this.ecoTex.type = THREE.UnsignedByteType;
    this.ecoTex.minFilter = THREE.LinearFilter;
    this.ecoTex.magFilter = THREE.LinearFilter;
    this.ecoTex.generateMipmaps = false;
    this.ecoTex.needsUpdate = true;
    const slopeSab = new SharedArrayBuffer(SLOPE_RES * SLOPE_RES * MAP_TILES * MAP_TILES);
    this.slopeTex = new THREE.DataArrayTexture(new Uint8Array(slopeSab), SLOPE_RES, SLOPE_RES, MAP_TILES * MAP_TILES);
    this.slopeTex.format = THREE.RedFormat;
    this.slopeTex.type = THREE.UnsignedByteType;
    this.slopeTex.minFilter = THREE.NearestFilter;
    this.slopeTex.magFilter = THREE.NearestFilter;
    this.slopeTex.generateMipmaps = false;
    this.slopeTex.needsUpdate = true;
    if (typeof Worker !== 'undefined') {
      this.ecoWorker = new Worker(new URL('./ecologyWorker.ts', import.meta.url), { type: 'module', name: `ecology ${MAP_TAG}` });
      this.ecoWorker.postMessage({ heights: world.heightsSab, water: world.waterSab, field: ecoSab, slope: slopeSab });
      this.ecoWorker.onmessage = (e: MessageEvent<number>) => {
        // a tile that failed answers -1 - tile: the queue goes on (D34: a thrown tile left ecoBusy set for good)
        if (e.data >= 0) {
          this.ecoTex.addLayerUpdate(e.data); this.ecoTex.needsUpdate = true;
          this.slopeTex.addLayerUpdate(e.data); this.slopeTex.needsUpdate = true;
        }
        this.ecoBusy = -1;
        this.nextEcology();
      };
      this.ecoWorker.onerror = (e) => { console.error('ecology worker:', e.message); this.ecoBusy = -1; this.nextEcology(); };
    }

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
    // uploaded once per frame by update()'s range (DynamicDrawUsage re-uploaded it in every render call: three r186
    // renderers/common/Attributes.js); the same for the water and shadow copies below
    this.inst = new THREE.InstancedBufferAttribute(this.instArray, 4);
    g.setAttribute('node', this.inst);
    g.instanceCount = 0;
    this.geometry = g;

    this.mesh = new THREE.Mesh(g, this.createMaterial());
    this.seamMaterial = this.createMaterial(true);
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
    // the ground does not cast a sun shadow (Roadcraft 4.0 terrain.ts:1401): it receives them. A shadow copy of the
    // terrain drawn into the three cascades every frame (an R5 invention) cost a terrain draw per cascade and threw
    // polygonal shadows off the landforms' feet (2026-10-31)
    this.mesh.castShadow = false;
    this.setLodFactor(this.lodFactor);
  }

  setLodFactor(f: number): void {
    this.lodFactor = f;
    for (let l = 0; l <= LEVELS; l++) this.ranges[l] = LEAF * (1 << l) * f;
    this.rangeBase.value = LEAF * f;
    this.seamReachU.value = Math.min(SEAM_REACH, LEAF * f * 0.7);
  }

  /** Height texture read: global sample (gx, gz) → height. */
  private loadH(gx: N, gz: N): N {
    const RES = HEIGHT_TILE_RES * MAP_TILES;
    const cx = clamp(gx, int(0), int(RES - 1));
    const cz = clamp(gz, int(0), int(RES - 1));
    const layer = cz.shiftRight(int(8)).mul(int(MAP_TILES)).add(cx.shiftRight(int(8)));
    return textureLoad(this.heightTex, ivec2(cx.bitAnd(int(255)), cz.bitAnd(int(255)))).depth(layer).r;
  }

  /** The land's corner slope (0..1 of 90°) at a global height sample. */
  private loadSlope(gx: N, gz: N): N {
    const RES = HEIGHT_TILE_RES * MAP_TILES;
    const cx = clamp(gx, int(0), int(RES - 1)), cz = clamp(gz, int(0), int(RES - 1));
    const layer = cz.shiftRight(int(8)).mul(int(MAP_TILES)).add(cx.shiftRight(int(8)));
    return textureLoad(this.slopeTex, ivec2(cx.bitAnd(int(255)), cz.bitAnd(int(255)))).depth(layer).r;
  }

  /**
   * Rock, dirt and talus weights (Roadcraft 4.0 terrain.ts:834-896): slope in degrees plus a wander of four noise scales
   * (0.00575, 0.0275, 0.05, 0.2075 per metre: ±14, ±10, ±30, ±16°) and a fine break-up (±13°) faded with distance;
   * rock = smoothstep(30°, 56°) or the altitude (168-232 m); dirt = smoothstep(27°, 42°) under the rock; talus where the
   * rock weight is between 0.06 and 0.92.
   */
  private groundBlend(vNormal: N): { rockW: N; dirtW: N; talus: N; wanderA: N; wanderC: N } {
    const p = positionWorld;
    const n = normalize(vNormal);
    // 4.0 terrainSlope (terrain.ts:720-723): the vertex normal's slope, taken over by the corners' (landSlope.ts) where
    // the land is steep, bilinear between them across tiles
    const smoothDeg = T.acos(clamp(n.y, -1, 1)).mul(57.2958);
    const f = p.xz.add(float(MAP_HALF)).div(float(HEIGHT_SPACING));
    const i0 = floor(f), t = fract(f), ix = int(i0.x), iz = int(i0.y);
    const ls = mix(mix(this.loadSlope(ix, iz), this.loadSlope(ix.add(1), iz), t.x), mix(this.loadSlope(ix, iz.add(1)), this.loadSlope(ix.add(1), iz.add(1)), t.x), t.y).mul(90);
    const deg = max(smoothDeg, mix(smoothDeg, ls, smoothstep(38, 60, ls)));
    const tn = (k: number) => texture(TERRAIN_NOISE, p.xz.mul(k / 4));
    const wanderA = tn(0.00575).r, wanderC = tn(0.05).r;
    const wander = wanderA.sub(0.5).mul(14).add(tn(0.0275).r.sub(0.5).mul(10)).add(wanderC.sub(0.5).mul(30)).add(tn(0.2075).r.sub(0.5).mul(16));
    const fineFade = clamp(float(1).sub(fwidth(p.x).div(1.5)), 0, 1);
    const breakup = tn(0.475).g.sub(0.5).mul(26).mul(fineFade);
    const altitude = smoothstep(168, 232, p.y);
    const rockW = max(smoothstep(30, 56, deg.add(wander.mul(float(1).sub(smoothstep(45, 70, deg).mul(0.5)))).add(breakup)), altitude.mul(0.92));
    const sw = deg.add(wander);
    const dirtW = smoothstep(27, 42, sw).mul(float(1).sub(rockW)).mul(float(1).sub(smoothstep(36, 48, sw).mul(0.6)));
    const talus = smoothstep(0.06, 0.4, rockW).mul(float(1).sub(smoothstep(0.5, 0.92, rockW)));
    return { rockW, dirtW, talus, wanderA, wanderC };
  }

  /** The painted geology's weights at `p` (granite, sandstone, basalt), bilinear over the 8 m samples (4.0 terrainGeo). */
  private geologyAt(p: N): N {
    const f = p.xz.add(float(MAP_HALF)).div(float(WATER_SPACING)).sub(0.5);
    const i0 = floor(f), t = fract(f), ix = int(i0.x), iz = int(i0.y);
    const sb = (gs: N) => { const k = floor(gs.r.mul(255).add(0.5)); return vec2(step(abs(k.sub(9)), float(0.5)), step(abs(k.sub(10)), float(0.5))).mul(gs.g); };
    const w = mix(mix(sb(this.loadG(ix, iz)), sb(this.loadG(ix.add(1), iz)), t.x), mix(sb(this.loadG(ix, iz.add(1))), sb(this.loadG(ix.add(1), iz.add(1))), t.x), t.y);
    return vec3(float(1).sub(w.x).sub(w.y), w.x, w.y);
  }

  /** Water level at a global 8 m sample (NO_WATER where dry). */
  private loadWater(gx: N, gz: N): N {
    const WRES = WATER_TILE_RES * MAP_TILES;
    const cx = clamp(gx, int(0), int(WRES - 1)), cz = clamp(gz, int(0), int(WRES - 1));
    const layer = cz.shiftRight(int(7)).mul(int(MAP_TILES)).add(cx.shiftRight(int(7)));
    return textureLoad(this.waterTex, ivec2(cx.bitAnd(int(127)), cz.bitAnd(int(127)))).depth(layer).r;
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

  /**
   * The terrain seams' state of the 4 m cell (gx, gz) (global cell = its lower corner's height sample), kept in the
   * fine road paint's blue channel (`setSeams`): 0 nothing known, ~0.5 a seam cell that the terrain draws, 1 a hole.
   */
  private seamState(gx: N, gz: N): N {
    const RES = HEIGHT_TILE_RES * MAP_TILES;
    const cx = clamp(gx, int(0), int(RES - 1)), cz = clamp(gz, int(0), int(RES - 1));
    const layer = cz.shiftRight(int(8)).mul(int(MAP_TILES)).add(cx.shiftRight(int(8)));
    return textureLoad(this.paintFine, ivec2(cx.bitAnd(int(255)), cz.bitAnd(int(255)))).depth(layer).z;
  }

  /**
   * The seams of the road cell at (originX, originZ) arrived (`holes`: SEAM_CELLS a side, 1 = the terrain does not draw
   * that 4 m cell) or left (null): written into the fine paint's blue channel, the cell's layer sent again.
   */
  setSeams(originX: number, originZ: number, holes: Uint8Array | null): void {
    const data = this.paintFine.image.data as Uint8Array, R = HEIGHT_TILE_RES;
    const gx0 = Math.round((originX + MAP_HALF) / HEIGHT_SPACING), gz0 = Math.round((originZ + MAP_HALF) / HEIGHT_SPACING);
    let tile = -1;
    for (let j = 0; j < SEAM_CELLS; j++) for (let i = 0; i < SEAM_CELLS; i++) {
      const gx = gx0 + i, gz = gz0 + j;
      tile = (gz >> 8) * MAP_TILES + (gx >> 8);
      data[(tile * R * R + (gz & 255) * R + (gx & 255)) * 4 + 2] = holes ? (holes[j * SEAM_CELLS + i] ? 255 : 128) : 0;
    }
    if (tile >= 0) { this.paintFine.addLayerUpdate(tile); this.paintFine.needsUpdate = true; }
  }

  /** The terrain cut along the roads near the camera (render/terrainSeams.ts), drawn with the terrain's own look. */
  readonly seamMaterial: THREE.MeshStandardNodeMaterial;

  private createMaterial(seam = false): THREE.MeshStandardNodeMaterial {
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
      const sinkAll = cover.mul(clamp(spacing.sub(float(HEIGHT_SPACING)).mul(0.08), 0, 3).add(smoothstep(0.35, 0.7, cover).mul(0.8)));
      // within SEAM_REACH, where the seams are in (any of the 4 cells round the vertex known), nothing sinks: the cells
      // under a road are holes there (not drawn) and the cut cells meet this vertex on its own height
      const gv = ivec2(int(floor(mxz.x.add(float(MAP_HALF)).div(float(HEIGHT_SPACING)).add(0.5))), int(floor(mxz.y.add(float(MAP_HALF)).div(float(HEIGHT_SPACING)).add(0.5))));
      const known = max(max(this.seamState(gv.x, gv.y), this.seamState(gv.x.sub(1), gv.y)), max(this.seamState(gv.x, gv.y.sub(1)), this.seamState(gv.x.sub(1), gv.y.sub(1))));
      // (`step` is the grid's spacing in here: comparisons by select)
      const seamed = select(known.greaterThan(float(0.25)).and(dist.lessThan(this.seamReachU)), float(1), float(0));
      const sink = sinkAll.mul(float(1).sub(seamed));
      const y = heightAt(mxz).sub(sink);
      // normal by central differences at the level's scale
      const e = max(step, float(HEIGHT_SPACING));
      const hl = heightAt(mxz.sub(vec2(e, 0))), hr = heightAt(mxz.add(vec2(e, 0)));
      const hd = heightAt(mxz.sub(vec2(0, e))), hu = heightAt(mxz.add(vec2(0, e)));
      vNormal.assign(normalize(vec3(hl.sub(hr), e.mul(2), hd.sub(hu))));
      vMorph.assign(morph);
      return vec3(mxz.x, y, mxz.y);
    });

    // a seam's point (jobs/terrainSeams.ts), placed by its layer (origin and scale in the model matrix): its lattice
    // coordinates snapped to 0.5 m (the packed position is quantised), a point of the terrain itself at the height the
    // terrain draws there; the normal as the finest level's
    const seamPosition = Fn(() => {
      const world = modelWorldMatrix.mul(vec4(positionLocal, 1)).xyz;
      const kind = floor(attribute('col', 'vec4').w.mul(255).add(0.5));
      const snap = (v: N) => floor(v.mul(SEAM_SUB / HEIGHT_SPACING).add(0.5)).div(SEAM_SUB / HEIGHT_SPACING);
      const isEdgeX = step(abs(kind.sub(POINT_EDGE_X)), float(0.5)), isEdgeZ = step(abs(kind.sub(POINT_EDGE_Z)), float(0.5));
      // an edge point on a side along x keeps its x (its z is on the lattice), one on a side along z its z
      const x = mix(snap(world.x), world.x, isEdgeX);
      const z = mix(snap(world.z), world.z, isEdgeZ);
      const xz = vec2(x, z);
      const y = select(kind.lessThan(float(POINT_GROUND + 0.5)), heightAt(xz), world.y);
      const e = float(HEIGHT_SPACING);
      const hl = heightAt(xz.sub(vec2(e, 0))), hr = heightAt(xz.add(vec2(e, 0)));
      const hd = heightAt(xz.sub(vec2(0, e))), hu = heightAt(xz.add(vec2(0, e)));
      vNormal.assign(normalize(vec3(hl.sub(hr), e.mul(2), hd.sub(hu))));
      vMorph.assign(float(0));
      // back to the mesh's own space: the layer's matrix is a translation and a uniform scale
      const t = modelWorldMatrix.element(3).xyz, s = length(modelWorldMatrix.element(0).xyz);
      return vec3(x, y, z).sub(t).div(s);
    });

    const m = new THREE.MeshStandardNodeMaterial();
    m.positionNode = seam ? seamPosition() : position();
    withPrevious(m);
    // the 4 m cells the seams hold, within SEAM_REACH: not drawn here (the road covers them, or the seam draws the part
    // off the road)
    if (!seam) {
      const pw = positionWorld;
      const cell = this.seamState(int(floor(pw.x.add(float(MAP_HALF)).div(float(HEIGHT_SPACING)))), int(floor(pw.z.add(float(MAP_HALF)).div(float(HEIGHT_SPACING)))));
      m.maskNode = cell.lessThan(float(0.75)).or(length(pw.sub(cameraPosition)).greaterThan(this.seamReachU));
    }

    // rock, dirt and grass weights as Roadcraft 4.0's (terrain.ts:834-896): by the slope in degrees, wandering with
    // noise at four scales and a fine break-up, rock also above 168-232 m; scree (talus) in a band at the rock's fringe
    const blend = this.groundBlend(vNormal);
    // the 4.0's grass (terrain-grass), one repeat every 12.8 m, read twice (the second turned and offset) and blended by
    // a broad noise so it does not tile, with a wide octave for the large patches (4.0 dualScaleNoTile)
    const grassUv = (p: N): N => p.xz.div(12.8);
    const noTile = (t: THREE.Texture, uv: N): N => {
      const k = texture(TERRAIN_NOISE, uv.mul(0.031)).r;
      const r = vec2(uv.x.mul(0.8660254).sub(uv.y.mul(0.5)), uv.x.mul(0.5).add(uv.y.mul(0.8660254))).add(0.37);
      return mix(texture(t, uv), texture(t, r), smoothstep(0.35, 0.65, k));
    };

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
      let soil: N = normalize(n.add(vec3(dx, 0, dz).mul(-2.2).mul(fade)));
      // the grass's own relief (tufts), on the gentle ground, near
      const gn = noTile(COOKED['terrain-grass.normal'], grassUv(p)).xyz.mul(2).sub(1);
      const gFade = clamp(float(1).sub(fwidth(p.x).div(0.6)), 0, 1).mul(float(1).sub(blend.rockW)).mul(float(1).sub(blend.dirtW));
      soil = normalize(soil.add(vec3(gn.x, 0, gn.y).mul(0.6).mul(gFade)));
      // the rock's own relief where it shows (softened 45 % toward the surface, as 4.0)
      const rn = rockNormal(p, n, blend.rockW, this.geologyAt(p)).xyz.mul(2).sub(1);
      const bent = normalize(n.add(vec3(rn.x, 0, rn.y).mul(0.55)));
      return normalize(mix(soil, bent, blend.rockW));
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
      // Roadcraft 4.0's grass texture as it is (its own tones: tufts, soil in the gaps, dry patches), the large patches
      // from a wide octave (macro × 0.7..1.3 at 0.35), the biome's hue over the default biome's, and a little less
      // saturated (the player found the green too strong)
      const gNear = sRGBTransferEOTF(noTile(COOKED['terrain-grass.map'], grassUv(p)).xyz);
      const gFar = sRGBTransferEOTF(noTile(COOKED['terrain-grass.map'], grassUv(p).mul(0.137).add(0.21)).xyz);
      const lumaW = vec3(0.3, 0.6, 0.1);
      const macro = clamp(dot(gFar, lumaW).div(GRASS_MEAN), 0.7, 1.3);
      const biome = grassA.div(sRGBTransferEOTF(vec3(0x46 / 255, 0x64 / 255, 0x2f / 255)));
      let c: N = gNear.mul(mix(float(1), macro, 0.35)).mul(biome);
      c = mix(vec3(dot(c, lumaW)), c, 0.82).mul(mix(float(0.92), float(1.06), clamp(big.add(mid.mul(0.22).mul(fadeMid)), 0, 1)));
      void grassB;
      const speck = clamp(dot(gNear, lumaW).div(GRASS_MEAN).mul(0.5), 0, 1);
      void slope;
      // the 4.0's dirt (terrain-land layer 8, 13.6 m), the soil of the rock it weathered from; the painted geology's
      // rock in its beds (terrainRock.ts); scree at the rock's fringe
      const geo = this.geologyAt(p);
      const dirtC = sRGBTransferEOTF(texture(COOKED['terrain-land.map'], p.xz.div(13.6)).depth(int(LAND.Dirt)).xyz).mul(soilTint(geo));
      void dirt;
      const rockC = rockColour(p, n, blend.rockW, geo, blend.wanderA, blend.wanderC);
      // height blending (4.0 terrain.ts:877-888, Mishkinis): each layer's weight lifted by its own texture's
      // brightness, the top 0.3 kept; the soil shows only where it beats the turf, in a narrow ragged edge
      {
        const lw = vec3(0.3, 0.6, 0.1);
        const grassW = max(float(0), float(1).sub(blend.rockW).sub(blend.dirtW));
        const hG = grassW.add(dot(c, lw).mul(1.4).mul(smoothstep(0, 0.35, grassW)));
        const hD = blend.dirtW.add(dot(dirtC, lw).mul(0.9).mul(smoothstep(0, 0.35, blend.dirtW)));
        const hR = blend.rockW.add(dot(rockC, lw).mul(1.1).mul(smoothstep(0, 0.35, blend.rockW)));
        const top = max(hG, max(hD, hR)).sub(0.3);
        const bG = max(hG.sub(top), 0), bD = max(hD.sub(top), 0), bR = max(hR.sub(top), 0);
        const sum = max(bG.add(bD).add(bR), 1e-4);
        c = c.mul(bG).add(dirtC.mul(bD)).add(rockC.mul(bR)).div(sum);
      }
      const scree = mix(rockC.mul(0.7), dirtC.mul(0.8), 0.4).mul(mix(float(0.75), float(1.2), texture(TERRAIN_NOISE, p.xz.mul(1.325 / 8)).b));
      c = mix(c, scree, blend.talus.mul(0.75));
      // the ecology field (Roadcraft 4.0 terrain.ts:937-957): straw on dry grass in patches, sodden ground near the
      // water, bare soil where little grows
      {
        const tileE = clamp(floor(p.xz.add(float(MAP_HALF)).div(float(TILE_SIZE))), 0, float(MAP_TILES - 1));
        const eco = texture(this.ecoTex, p.xz.add(float(MAP_HALF)).div(float(TILE_SIZE)).sub(tileE)).depth(int(tileE.y.mul(MAP_TILES).add(tileE.x)));
        // patches of ~92 m and ~22 m (the noise's g channel has 8 periods per tile, b 16)
        const patchy = texture(TERRAIN_NOISE, p.xz.div(92 * 8)).g;
        const lift = texture(TERRAIN_NOISE, p.xz.div(22 * 16)).b;
        const golden = clamp(eco.x.mul(0.55).mul(patchy.mul(0.9).add(0.35)), 0, 1);
        const gold = smoothstep(0.35, 0.8, golden.add(lift.sub(0.5).mul(0.3))).mul(0.25);
        const luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = mix(c, vec3(1.32, 1.04, 0.46).mul(luma).mul(1.05), gold.mul(float(1).sub(blend.rockW)));
        c = mix(c, c.mul(vec3(0.55, 0.72, 0.55)), eco.y.mul(0.85).mul(smoothstep(float(SEA_LEVEL + 0.4), float(SEA_LEVEL + 2.5), p.y)));
        c = mix(c, dirt, eco.z.mul(0.4).mul(float(1).sub(blend.rockW)));
      }
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
          // geology (8-10) is no colour of its own: it picks the rock and the soil (geologyAt; 4.0 terrain.ts:854-882)
          const painted = mix(c, pc, gs.g.mul(float(1).sub(step(abs(float(kind).sub(9)), float(1)))));
          // forest: dark leaf litter
          return mix(painted, sRGBTransferEOTF(vec3(0.24, 0.3, 0.16)), gs.b.mul(0.55));
        };
        const top = mix(tint(g00), tint(g10), t.x), bot = mix(tint(g01), tint(g11), t.x);
        c = mix(top, bot, t.y);
      }
      // the shore, as Roadcraft 4.0's (terrain.ts:987-1010), measured from the water beside it, not from the sea
      // level: a beach 1-2.4 m up on gentle banks, a cut of damp earth 2-4 m up on steep ones (both wandering by up to
      // 1.2 m and 2 m), the bed under the water (gravel and pebbles turning to silt by 4.8 m deep), wet ground darker
      // from 0.56 m over the line down. Its colours are 4.0's linear ones.
      {
        const gw = p.xz.add(float(MAP_HALF)).div(float(WATER_SPACING));
        const wx = int(floor(gw.x.add(0.5))), wz = int(floor(gw.y.add(0.5)));
        const w00 = this.loadWater(wx.sub(1), wz.sub(1)), w10 = this.loadWater(wx, wz.sub(1)), w01 = this.loadWater(wx.sub(1), wz), w11 = this.loadWater(wx, wz);
        const wl = max(max(w00, w10), max(w01, w11));
        // how much of the ground round here has water (4.0's terrainShoreCover): the 4 samples, bilinear
        const tw = fract(gw.sub(0.5));
        const hw = (v: N) => step(float(NO_WATER + 1), v);
        const riverCover = mix(mix(hw(w00), hw(w10), tw.x), mix(hw(w01), hw(w11), tw.x), tw.y);
        // the sea is not in the level texture: by the sea, the sea is the water
        const bySea = step(wl, float(NO_WATER + 1)).mul(step(p.y, float(SEA_LEVEL + 4.8)));
        const lvl = select(wl.greaterThan(float(NO_WATER + 1)), wl, float(SEA_LEVEL));
        const cover = max(riverCover, bySea);
        const above = p.y.sub(lvl);
        const wander = texture(TERRAIN_NOISE, p.xz.div(37 * 8)).g;
        const slopeDeg = T.acos(clamp(n.y, 0, 1)).mul(57.29578);
        const gentle = float(1).sub(smoothstep(24, 40, slopeDeg));
        const shoreFade = smoothstep(0.15, 0.85, cover.add(wander.sub(0.5).mul(0.3)));
        const sandLuma = dot(dirtC, vec3(0.3, 0.6, 0.1));
        const sand = vec3(0.42, 0.36, 0.23).mul(sandLuma.mul(1.4).add(0.82));
        const beach = float(1).sub(smoothstep(wander.mul(1.2).add(1), wander.mul(1.2).add(2.4), above)).mul(gentle).mul(shoreFade);
        c = mix(c, sand, beach.mul(float(1).sub(blend.rockW.mul(0.6))));
        const bank = float(1).sub(smoothstep(wander.mul(2).add(2), wander.mul(2).add(4), above)).mul(float(1).sub(gentle)).mul(shoreFade);
        c = mix(c, dirtC.mul(vec3(0.78, 0.72, 0.62)), bank.mul(float(1).sub(blend.rockW)));
        const wetCover = smoothstep(0.03, 0.35, cover);
        const pebble = texture(COOKED['terrain-land.map'], p.xz.mul(1.325)).depth(int(LAND.Dirt)).x;
        const stones = texture(COOKED['terrain-land.map'], p.xz.mul(0.525).add(0.4)).depth(int(LAND.Dirt)).y;
        const gravel = vec3(0.34, 0.3, 0.22).mul(mix(float(0.62), float(1.3), pebble)).mul(mix(float(0.85), float(1.12), stones));
        const silt = vec3(0.18, 0.17, 0.12).mul(sandLuma.add(0.85));
        const bedC = mix(gravel, silt, smoothstep(-0.8, -4.8, above));
        c = mix(c, bedC, smoothstep(0, -0.8, above).mul(wetCover).mul(0.9));
        c = c.mul(mix(float(1), float(0.6), float(1).sub(smoothstep(-0.08, 0.56, above)).mul(wetCover)));
      }
      // roads painted on the ground (seen where the road mesh does not reach)
      const tileF = clamp(floor(p.xz.add(float(MAP_HALF)).div(float(TILE_SIZE))), 0, float(MAP_TILES - 1));
      const layer = int(tileF.y.mul(MAP_TILES).add(tileF.x));
      const uvT = p.xz.add(float(MAP_HALF)).div(float(TILE_SIZE)).sub(tileF);
      const fine = texture(this.paintFine, uvT).depth(layer);
      const coarse = texture(this.paintCoarse, uvT).depth(layer);
      const pix = fwidth(p.x).add(fwidth(p.z)).mul(0.5);
      // (not where the terrain is cut along the roads: there the road itself is drawn, and the 4 m paint, bilinear, bled
      // the footway's tone onto the ground beside it)
      const cut = seam ? float(1) : select(this.seamState(int(floor(p.x.add(float(MAP_HALF)).div(float(HEIGHT_SPACING)))), int(floor(p.z.add(float(MAP_HALF)).div(float(HEIGHT_SPACING))))).greaterThan(float(0.25))
        .and(length(p.sub(cameraPosition)).lessThan(this.seamReachU)), float(1), float(0));
      const paint = mix(fine, coarse, smoothstep(5, 28, pix)).mul(float(1).sub(cut));
      c = mix(c, sRGBTransferEOTF(vec3(0.27, 0.28, 0.3)), paint.x);
      c = mix(c, sRGBTransferEOTF(vec3(0.72, 0.69, 0.64)), paint.y);
      // the tools' overlays: brush ring, grid
      c = this.overlays.over(c, p, pix);
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
    const r = parkMiller(3);
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
      // geology (8-10) does not bare the ground (4.0: the slope decides)
      const grassy = max(max(max(step(kind, float(0.5)), step(abs(kind.sub(3)), float(0.5))), step(abs(kind.sub(11.5)), float(1))), step(abs(kind.sub(9)), float(1.5)));
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
      // the tips bend along the wind, as much as the wind (still air: still grass)
      const sway = sin(time.mul(windU.mul(2.5).add(1.6)).add(base.x.mul(0.31)).add(base.y.mul(0.23))).mul(windU.mul(0.1)).mul(tip);
      vTip.assign(tip);
      vShade.assign(jz);
      return vec3(lp.x.mul(c).add(lp.z.mul(sn)), lp.y, lp.x.negate().mul(sn).add(lp.z.mul(c))).mul(k).add(vec3(windDirU.x, 0, windDirU.y).mul(sway.mul(k))).add(vec3(base.x, h.add(0.01), base.y));
    });
    const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide });
    m.positionNode = position();
    withPrevious(m);
    const grassA = sRGBTransferEOTF(this.grassA), grassB = sRGBTransferEOTF(this.grassB);
    // the same grass as the ground under it (the 4.0's grass texture), a little lighter or darker per tuft
    const base = sRGBTransferEOTF(texture(COOKED['terrain-grass.map'], positionWorld.xz.div(12.8)).xyz).mul(grassA.div(sRGBTransferEOTF(vec3(0x46 / 255, 0x64 / 255, 0x2f / 255)))).mul(mix(float(0.85), float(1.15), vShade));
    void grassB;
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

  /**
   * Water as Roadcraft 4.0's (`render/water.ts`): transparent, its depth read per pixel (the water's level over the
   * ground under the pixel, from the height texture), coloured by depth (shallow 7fb2a8 → 3d7a8e → deep 245a74), its
   * normals from three drifting scales of the baked water texture plus a wind-driven swell; along a river the ripples
   * ride the current (the level's slope gives the downstream direction, two-phase flow sampling), lakes (flat level)
   * just drift. Lace foam in a band in from the shore, whitecaps with the waves, churn in fast water, Fresnel (F0 0.06,
   * power 3) toward the horizon tint.
   */
  private createWaterMaterial(sea = false): THREE.MeshStandardNodeMaterial {
    const wtex = this.waterTex;
    const WRES = WATER_TILE_RES * MAP_TILES;
    const loadW = (gx: N, gz: N) => {
      const cx = clamp(gx, int(0), int(WRES - 1)), cz = clamp(gz, int(0), int(WRES - 1));
      const layer = cz.shiftRight(int(7)).mul(int(MAP_TILES)).add(cx.shiftRight(int(7)));
      return textureLoad(wtex, ivec2(cx.bitAnd(int(127)), cz.bitAnd(int(127)))).depth(layer).r;
    };
    const heightAt = this.heightFn();
    // level, downstream direction (x, z) and how much it runs
    const vW = varyingProperty('vec4', 'vWaterFlow');
    const pos = Fn(() => {
      const tile = attribute('wtile', 'float');
      const tx = tile.mod(float(MAP_TILES)), tz = floor(tile.div(float(MAP_TILES)));
      const uv = attribute('position', 'vec3').xz;
      const xz = vec2(tx, tz).add(uv).mul(float(TILE_SIZE)).sub(float(MAP_HALF));
      // level at the vertex: the highest of the 4 neighbours with water (the edge runs a little under the bank)
      const g = xz.add(float(MAP_HALF)).div(float(WATER_SPACING));
      const ix = int(floor(g.x.add(0.5))), iz = int(floor(g.y.add(0.5)));
      const w = max(max(loadW(ix.sub(1), iz.sub(1)), loadW(ix, iz.sub(1))), max(loadW(ix.sub(1), iz), loadW(ix, iz)));
      // the level's slope (dry neighbours count as level): the river runs down it; a lake is flat
      const wet = (v: N) => select(v.greaterThan(float(NO_WATER + 1)), v, w);
      const gx = wet(loadW(ix.sub(2), iz.sub(1)).max(loadW(ix.sub(2), iz))).sub(wet(loadW(ix.add(1), iz.sub(1)).max(loadW(ix.add(1), iz))));
      const gz = wet(loadW(ix.sub(1), iz.sub(2)).max(loadW(ix, iz.sub(2)))).sub(wet(loadW(ix.sub(1), iz.add(1)).max(loadW(ix, iz.add(1)))));
      const grad = vec2(gx, gz).div(float(WATER_SPACING * 3));
      // the generated river falls 0.3 m/km (jobs/terrainGen.ts MIN_FALL): that is a full current; a lake is flat
      const run = smoothstep(0.00005, 0.00025, length(grad));
      vW.assign(vec4(w, normalize(grad.add(vec2(1e-7, 0))), run));
      // no displacement: 4.0's waves are in the normals only (water.ts:297-298, :346-350)
      // at the mouth (level at the sea's) the river's surface drops under the sea plane, so the two never cross
      const surf = select(w.lessThan(float(SEA_LEVEL + 0.6)), float(SEA_LEVEL - 0.3), w);
      const y = select(w.greaterThan(float(NO_WATER + 1)), surf, float(-2000));
      return vec3(xz.x, y, xz.y);
    });
    const m = new WaterNodeMaterial({ transparent: true });
    waterEnv(m);
    // the sea is a plane at sea level (scene.ts): no level to read and no current
    if (!sea) { m.positionNode = pos(); withPrevious(m); }
    const p = positionWorld;
    const t = T.time.mod(1000);
    const level = sea ? float(SEA_LEVEL) : vW.x, flowDir = sea ? vec2(1, 0) : vW.yz, run = sea ? float(0) : vW.w;
    // depth per pixel: the level over the ground under this pixel
    const depth = max(level.sub(heightAt(p.xz)), 0);
    // 4.0 water.ts:389: the waves are the map's setting alone; the wind only drives the swell (it doubled the whitecaps)
    const waves = waveU;
    const tex = (uv: N) => texture(WATER_TEX, uv);
    // drifting layers (13.6 m and 4.4 m) and the swell (36 m) along the wind
    const uvA = p.xz.div(13.6).add(vec2(0.035, 0.021).mul(t)), uvB = p.xz.div(4.4).add(vec2(-0.026, 0.047).mul(t));
    const W = tex(p.xz.div(36).add(windDirU.mul(t.mul(windU.mul(7).add(0.6)).div(36))));
    // the current: two phases of a 2 s cycle, each carrying the ripples downstream, cross-faded
    const p0 = fract(t.div(2)), p1 = fract(t.div(2).add(0.5)), w0 = float(1).sub(abs(float(1).sub(p0.mul(2))));
    // 4.0 water.ts:289: the flow × the current × the 2 s cycle; fastest down the middle, 0.4 of it at the banks
    // (terrain.ts:2589: 1 − 0.6 s² across the ribbon; here the depth tells the middle: the bed's section is that shape)
    const pace = float(0.4).add(clamp(depth.div(6), 0, 1).mul(0.6));
    const shift = flowDir.mul(currentU.mul(2)).mul(pace);
    const flowed = (uv: N, scale: number) => mix(tex(uv.sub(shift.mul(p1).div(scale)).add(vec2(0.37, 0.61))), tex(uv.sub(shift.mul(p0).div(scale))), w0);
    const runC = run.mul(step(float(0.001), currentU));
    const A = mix(tex(uvA), flowed(p.xz.div(13.6), 13.6), runC), B = mix(tex(uvB), flowed(p.xz.div(4.4), 4.4), runC);
    const nA = A.xyz.mul(2).sub(1), nB = B.xyz.mul(2).sub(1), nW = W.xyz.mul(2).sub(1);
    // foam: lace in a band in from the shore, whitecaps with the waves, churn in fast water
    const lace = A.w.mul(0.55).add(B.w.mul(0.65));
    const shore = smoothstep(0.196, 0.364, depth).mul(smoothstep(0.34, 0.4, float(1).sub(smoothstep(0, 1.6, depth)).add(lace.sub(0.6).mul(0.22)))).mul(foamU);
    const caps = smoothstep(float(0.8).sub(waves.mul(0.22)), float(0.97), W.w).mul(smoothstep(0.25, 0.8, waves)).mul(smoothstep(0.6, 2.4, depth));
    const churn = run.mul(smoothstep(0.66, 0.78, lace)).mul(smoothstep(0.8, 3.2, currentU));
    const foam = clamp(max(shore, caps.add(churn.mul(0.6)).mul(foamU).mul(1.6)), 0, 1);
    // normal: the slopes of the layers summed, flattened under foam
    // the fine ripples fade where a pixel spans more than ~1 m (far and grazing: they turned into glitter)
    const pix = length(fwidth(p.xz));
    const fine = smoothstep(1.6, 0.4, pix);
    const slope = nA.xy.mul(0.62).add(nB.xy.mul(0.48)).mul(fine).add(nW.xy.mul(waves.mul(1.3)).mul(smoothstep(0.32, 2, depth))).mul(0.85).mul(float(1).sub(foam.mul(0.6)));
    const n = normalize(vec3(slope.x, nA.z.mul(nB.z).max(0.2), slope.y));
    m.normalNode = transformNormalToView(n);
    // colour by depth, a slow slick variation, Fresnel toward the horizon tint, foam
    const lin = (h: number) => sRGBTransferEOTF(vec3(((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255));
    const deepK = float(1).sub(T.exp(depth.div(-1.44)));
    let c: N = select(deepK.lessThan(0.5), mix(lin(0x7fb2a8), lin(0x3d7a8e), deepK.mul(2)), mix(lin(0x3d7a8e), lin(0x245a74), deepK.sub(0.5).mul(2)));
    c = c.mul(tex(p.xz.mul(0.0031).add(vec2(0.0011, 0.0006).mul(t))).w.mul(0.12).add(0.94));
    const view = normalize(cameraPosition.sub(p));
    const F = float(0.06).add(float(0.94).mul(pow(float(1).sub(clamp(dot(view, n), 0, 1)), 3)));
    m.fresnelNode = F;
    c = c.mul(float(1).sub(F.mul(0.6))).mul(mix(float(0.65), float(1), foam));
    c = mix(c, lin(0x6f95b8), F.mul(0.35).mul(float(1).sub(foam)));
    m.colorNode = vec4(mix(c, lin(0xe6eef2), foam), 1);
    // 4.0 water.ts:324-326: the first shallow stretch shows the bed, near opaque by 5.6 m; the rim fades in by 0.28 m
    let alpha: N = max(mix(float(0.05), float(0.88), smoothstep(0.12, 5.6, depth)), foam.mul(0.9));
    alpha = clamp(alpha.add(F.mul(0.5)), 0, 1).mul(smoothstep(0, 0.28, depth));
    m.opacityNode = alpha;
    m.roughnessNode = mix(float(0.15), float(0.72), foam);
    m.metalnessNode = float(0);
    if (!sea) m.maskNode = p.y.greaterThan(float(-1500));
    else {
      // no sea under a river or lake standing above it (their beds go under the sea level: it showed through their water)
      const g = p.xz.add(float(MAP_HALF)).div(float(WATER_SPACING));
      const ix = int(floor(g.x.add(0.5))), iz = int(floor(g.y.add(0.5)));
      const w = max(max(loadW(ix.sub(1), iz.sub(1)), loadW(ix, iz.sub(1))), max(loadW(ix.sub(1), iz), loadW(ix, iz)));
      m.maskNode = w.lessThan(float(SEA_LEVEL + 0.6));
    }
    return m;
  }

  /** The sea plane's material (scene.ts makes the plane): the same water, at sea level. */
  createSeaMaterial(): THREE.MeshStandardNodeMaterial { return this.createWaterMaterial(true); }

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
    // the blue channel is the terrain seams' (`setSeams`): kept
    const data = this.paintFine.image.data as Uint8Array, o = tile * fine.length;
    for (let k = 0; k < fine.length; k += 4) { data[o + k] = fine[k]; data[o + k + 1] = fine[k + 1]; data[o + k + 3] = fine[k + 3]; }
    (this.paintCoarse.image.data as Uint8Array).set(coarse, tile * coarse.length);
    this.paintFine.addLayerUpdate(tile);
    this.paintCoarse.addLayerUpdate(tile);
    this.paintFine.needsUpdate = true;
    this.paintCoarse.needsUpdate = true;
  }

  /** Asks the ecology worker for a tile and its 8 neighbours (the field reads 128 m past the tile's edge). */
  private queueEcology(t: number): void {
    const tx = t % MAP_TILES, tz = (t / MAP_TILES) | 0;
    for (let j = Math.max(0, tz - 1); j <= Math.min(MAP_TILES - 1, tz + 1); j++) for (let i = Math.max(0, tx - 1); i <= Math.min(MAP_TILES - 1, tx + 1); i++) this.ecoQueue.add(tileId(i, j));
  }

  private nextEcology(): void {
    if (this.ecoBusy >= 0 || !this.ecoWorker || this.ecoQueue.size === 0) return;
    const t = this.ecoQueue.values().next().value as number;
    this.ecoQueue.delete(t);
    this.ecoBusy = t;
    this.ecoWorker.postMessage(t);
  }

  /** Re-sends to the GPU only the changed layers (tiles). */
  uploadDirtyLayers(): void {
    const w = this.world;
    // the ecology follows the ground and the water of the tiles that changed (bounded by the edit, never the map)
    for (const l of w.layerDirty) this.queueEcology(l);
    for (const l of w.waterDirty) this.queueEcology(l);
    this.nextEcology();
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

  /** The view-projection matrix of the frame (kept: not a matrix per frame). */
  private readonly pv = new THREE.Matrix4();

  /** A water buffer's drawn instances and its upload range. */
  private waterCount(g: THREE.InstancedBufferGeometry, a: THREE.InstancedBufferAttribute, n: number): void {
    g.instanceCount = n;
    a.clearUpdateRanges();
    a.addUpdateRange(0, n);
    a.needsUpdate = true;
  }

  /** CDLOD selection from the camera. */
  update(camera: THREE.Camera, viewPos: THREE.Vector3): void {
    camera.updateMatrixWorld();
    const pv = this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
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
    this.waterCount(this.waterGeo, this.waterInst, this.waterNear);
    this.waterCount(this.waterFarGeo, this.waterFarInst, this.waterFarCount);
    this.inst.clearUpdateRanges();
    this.inst.addUpdateRange(0, this.count * 4);
    this.inst.needsUpdate = true;
  }

  /** Ground height under a point (the tile's mean was off by up to half the tile's relief: grass shown or hidden
   *  100 m too early on hills). */
  private groundAt(x: number, z: number): number {
    return heightAt(this.world.heights, x, z);
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

  /** Tile side, for whoever needs it. */
  static readonly tileSize = TILE_SIZE;
}

// Buildings: the mesh source (procedural generator in the workers) and the one
// material: windows aligned to the walls, fake interiors (interior mapping),
// rooms lit at night, shops with a shop window and a sign.

import * as THREE from 'three/webgpu';
import { CELL_SIZE, CELLS_PER_TILE, MAP_CELLS, MAP_PLATES, MAP_TILES, PLATE_SIZE, TILE_SIZE } from '../config.ts';
import { CELL_COUNT, Dirty, cellId, cellOriginX, tileOriginX } from '../core/grid.ts';
import type { JobPool } from '../jobs/pool.ts';
import { boxTransfer } from '../shared/contracts/worker.ts';
import type { World } from '../world/world.ts';
import { heightAt } from '../world/heights.ts';
import { CellLayer, type LayerSource } from './cellLayer.ts';
import { T, lodFadeMask, useCompactVertex, withPrevious, type Node } from './tsl.ts';
import { nightU } from './scene.ts';
import { ARCHES, ARCH_COUNT, facadeWindowTable } from '../world/arch.ts';
import { cutMask } from './inside.ts';
import { GRASS_TEX, GRASS_TILE } from './surfaceBake.ts';
import { FINISH_BY_MAT, FINISH_COUNT, FINISH_LOOKS, FINISH_SIZE } from '../jobs/buildingFinishes.ts';
import { WIN_REVEAL_SHADE } from '../jobs/buildingGen.ts';

const {
  attribute, uniform, vec3, vec4, float, int, mix, clamp, fract, fwidth, smoothstep, floor, mod, select, hash, min, abs,
  positionWorld, cameraPosition, sRGBTransferEOTF, dot, max, step, normalize, pow, texture, vec2, cross, transformNormalToView,
} = T;

/**
 * The 13 building finishes as two texture arrays (layer = finish id − 1), Roadcraft 4.0's cooked maps: colour (sRGB) +
 * roughness, normal + metal mask. Neutral until the worker answers (a plaster-like grey, flat normal).
 */
function finishArray(fill: [number, number, number, number], srgb: boolean): THREE.DataArrayTexture {
  const n = FINISH_SIZE * FINISH_SIZE * FINISH_COUNT, data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) data.set(fill, i * 4);
  const t = new THREE.DataArrayTexture(data, FINISH_SIZE, FINISH_SIZE, FINISH_COUNT);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}
export const FINISH_ALBEDO = finishArray([230, 230, 230, 235], true);
export const FINISH_NORMAL = finishArray([128, 128, 255, 255], false);
let finishBaked = false;
/** Starts the load (once): a worker reads the cooked files and fills both arrays, which go up to the GPU again. */
function bakeFinishesOnce(): void {
  if (finishBaked || typeof Worker === 'undefined' || typeof document === 'undefined') return;
  finishBaked = true;
  const w = new Worker(new URL('../jobs/buildingFinishWorker.ts', import.meta.url), { type: 'module', name: 'finishes' });
  w.onmessage = (e: MessageEvent<{ albedo: Uint8Array; normal: Uint8Array } | { error: string }>) => {
    w.terminate();
    if ('error' in e.data) { console.warn('building finishes not loaded:', e.data.error); return; }
    (FINISH_ALBEDO.image.data as Uint8Array).set(e.data.albedo); FINISH_ALBEDO.needsUpdate = true;
    (FINISH_NORMAL.image.data as Uint8Array).set(e.data.normal); FINISH_NORMAL.needsUpdate = true;
  };
  w.postMessage({ base: new URL('cooked/surfaces/', document.baseURI).href });
}
/** Per finish (4.0 LOOKS): (1 / metres a repeat / repeats in its layer, normal strength, metalness, metal by the map). */
const FINISH_LOOK = T.uniformArray(FINISH_LOOKS.map((l, k) => new THREE.Vector4(k ? 1 / l.worldSize / l.tiles : 0, l.normalScale, l.metalness, l.metallic ? 1 : 0)), 'vec4');
const FINISH_AUTO = T.uniformArray(FINISH_BY_MAT.map((f) => new THREE.Vector4(f, 0, 0, 0)), 'vec4');

/** Render noise made once (128², tiles seamlessly): R fine grain + blotches, G streaks (stretched in y). */
function wallNoise(): THREE.DataTexture {
  const N = 128, data = new Uint8Array(N * N * 4);
  const lattice = (g: number, seed: number) => { const v = new Float32Array(g * g); let x = seed * 2654435761 >>> 0; for (let i = 0; i < v.length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; v[i] = (x >>> 0) / 4294967296; } return v; };
  const sample = (v: Float32Array, g: number, u: number, w: number) => {
    const x = u * g, y = w * g, i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const at = (a: number, b: number) => v[((b % g + g) % g) * g + ((a % g + g) % g)];
    return (at(i, j) * (1 - sx) + at(i + 1, j) * sx) * (1 - sy) + (at(i, j + 1) * (1 - sx) + at(i + 1, j + 1) * sx) * sy;
  };
  const a = lattice(8, 7), b = lattice(32, 11), c = lattice(16, 23);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, w = y / N, o = (y * N + x) * 4;
    data[o] = Math.round(255 * (sample(a, 8, u, w) * 0.55 + sample(b, 32, u, w) * 0.45));
    data[o + 1] = Math.round(255 * sample(c, 16, u, w * 0.25));
    data[o + 2] = 0; data[o + 3] = 255;
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}
export const WALL_NOISE = wallNoise();

/** Buildings: the mesh source for the cell layer. */
export function createCity(world: World, pool: JobPool): CellLayer {
  const src: LayerSource = {
    hasContent: (c) => world.cellBuildings[c] > 0,
    buildCell: (c, level, priority, done) => {
      const cx = c % MAP_CELLS, cz = (c / MAP_CELLS) | 0;
      const boxes = world.gatherBoxes([c], true);
      pool.submit('buildingMesh', { boxes, originX: cellOriginX(cx), originZ: cellOriginX(cz), extent: CELL_SIZE, lod: level },
        (r) => done(r.mesh), { key: `cell${level}:${c}`, priority, transfer: boxTransfer(boxes) });
    },
    buildTile: (t, priority, done) => {
      const tx = t % MAP_TILES, tz = (t / MAP_TILES) | 0;
      const cells: number[] = [];
      for (let j = 0; j < CELLS_PER_TILE; j++) for (let i = 0; i < CELLS_PER_TILE; i++) cells.push(cellId(tx * CELLS_PER_TILE + i, tz * CELLS_PER_TILE + j));
      const boxes = world.gatherBoxes(cells, true);
      if (boxes.count === 0) { done(null); return; }
      pool.submit('buildingMesh', { boxes, originX: tileOriginX(tx), originZ: tileOriginX(tz), extent: TILE_SIZE, lod: 2 },
        (r) => done(r.mesh), { key: `tile:${t}`, priority, transfer: boxTransfer(boxes) });
    },
    buildPlate: (p, priority, done) => {
      const per = PLATE_SIZE / TILE_SIZE * CELLS_PER_TILE;
      const px = p % MAP_PLATES, pz = (p / MAP_PLATES) | 0;
      const cells: number[] = [];
      for (let j = 0; j < per; j++) for (let i = 0; i < per; i++) {
        const ci = px * per + i, cj = pz * per + j;
        if (ci < MAP_CELLS && cj < MAP_CELLS) cells.push(cellId(ci, cj));
      }
      const boxes = world.gatherBoxes(cells, true);
      if (boxes.count === 0) { done(null); return; }
      pool.submit('buildingMesh', { boxes, originX: cellOriginX(px * per), originZ: cellOriginX(pz * per), extent: PLATE_SIZE, lod: 3 },
        (r) => done(r.mesh), { key: `plate:${p}`, priority, transfer: boxTransfer(boxes) });
    },
  };
  // L0 full detail near, L1 facade level in the middle, L2 masses far: `detail` has to stay below `near`, or the cell
  // jumps from L0 straight to the tile's massing and the town turns into boxes at the near boundary (4.0's L1 band).
  return new CellLayer(src, world.dirty, Dirty.Buildings, createBuildingMaterial(), { near: 1800, evict: 3000, margin: 40, detail: 700, plate: 4200, budget: 256e6, eyeHeight: (x, z) => heightAt(world.heights, x, z) }, false, true);
}


/**
 * Facade detail near the camera: window openings, sills and heads in 3D (lod −1 in the generator). A layer of its
 * own, cells only, with a short radius: far away it does not exist (the shader draws the window alone).
 */
/** Cells whose window detail is on screen at full fade (the detail layer writes it): there the walls open at the windows. */
export const DETAIL_SHOWN = new Uint8Array(CELL_COUNT);

export function createCityDetail(world: World, pool: JobPool, material: THREE.Material): CellLayer {
  const src: LayerSource = {
    hasContent: (c) => world.cellBuildings[c] > 0,
    buildCell: (c, level, priority, done) => {
      if (level > 0) { done(null); return; } // far: no detail
      const cx = c % MAP_CELLS, cz = (c / MAP_CELLS) | 0;
      const boxes = world.gatherBoxes([c], true);
      pool.submit('buildingMesh', { boxes, originX: cellOriginX(cx), originZ: cellOriginX(cz), extent: CELL_SIZE, lod: -1 },
        (r) => done(r.mesh), { key: `detail:${c}`, priority: priority - 1, transfer: boxTransfer(boxes) });
    },
    buildTile: (_t, _p, done) => done(null),
    buildPlate: (_p, _q, done) => done(null),
  };
  return new CellLayer(src, world.dirty, Dirty.Buildings, material, { near: 1100, evict: 1400, margin: 30, detail: 150, budget: 48e6, shadows: false, sparse: true, publish: DETAIL_SHOWN,
    eyeHeight: (x, z) => heightAt(world.heights, x, z) }, false, true);
}

/** Direction to the sun (from the scene's directional light, read once per render). */
let sunLight: THREE.DirectionalLight | null = null;
const SUN_DIR = T.uniform(new THREE.Vector3(0, 1, 0)).onRenderUpdate(({ scene }: { scene: THREE.Scene | null }, self: { value: THREE.Vector3 }) => {
  if (!sunLight && scene) scene.traverse((o) => { if (!sunLight && (o as THREE.DirectionalLight).isDirectionalLight) sunLight = o as THREE.DirectionalLight; });
  if (sunLight) self.value.copy(sunLight.position).sub(sunLight.target.position).normalize();
});

/** Band [lo, hi] of x, filtered by the pixel width w. */
function band(lo: Node, hi: Node, x: Node, w: Node): Node {
  return smoothstep(lo.sub(w), lo.add(w), x).mul(smoothstep(hi.add(w), hi.sub(w), x));
}

/** Window and trim per style, for the shader. */
const ARCH_WIN = T.uniformArray(facadeWindowTable().map(([a, b, c, d]) => new THREE.Vector4(a, b, c, d)), 'vec4');
/** 4.0 curtain wall colours (signature.ts:150-152), linear: per palette glass at the head, glass at the sill, mullion, spandrel (blue, dark, teal, green). */
const CURTAINS = T.uniformArray([
  0x9fc0d6, 0x5f8099, 0xd5dadd, 0x6c7f8c, 0x4b5a66, 0x222b33, 0x5a6168, 0x1b2127,
  0x7fc2c4, 0x2f6f73, 0xe8efee, 0x2b5557, 0x8fb3ae, 0x557a76, 0xcfd6d3, 0x5d736f,
].map((h) => { const c = new THREE.Color(h).convertSRGBToLinear(); return new THREE.Vector4(c.r, c.g, c.b, 1); }), 'vec4');
/** The 4.0 plinth's stone (PLINTH_MATERIAL 0x7f786d), linear. */
const PLINTH_RGB = new THREE.Color(0x7f786d).convertSRGBToLinear().toArray();
const ARCH_TRIM = T.uniformArray(ARCHES.map((a) => { const c = new THREE.Color(a.trim).convertSRGBToLinear(); return new THREE.Vector4(c.r, c.g, c.b, 1); }), 'vec4');

/** The one building material. Materials by the colour's alpha channel (BMAT in the generator). */
/**
 * Moves the building's vertices after they are read (a ruin's fragments, features/demolition/ruin): `place` turns a
 * vertex's rest position into where it is drawn, `turn` a rest normal into its drawn one, `surface` is the rest world
 * position the finishes and the grain are laid by (so they stay on a piece as it tumbles), `prev` last frame's place.
 */
export interface BuildingPlacement { place: (rest: Node) => Node; turn: (n: Node) => Node; surface: Node; prev: Node }

export function createBuildingMaterial(moved?: BuildingPlacement): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  const n = useCompactVertex(m, 'vBldNormal', moved?.place);
  // the level swap dither and the inside view cut
  bakeFinishesOnce();
  const col = attribute('col', 'vec4');
  const matByte = floor(col.w.mul(255).add(0.5));
  const mat = mod(matByte, 16);
  // finish: high nibble of the material byte (0 = the material's default)
  const finV = floor(matByte.div(16));
  const fin = select(finV.greaterThan(0.5), finV, FINISH_AUTO.element(int(mat)).x);
  const hasFin = step(float(0.5), fin);
  // the lot lawn with the same baked grass as the terrain
  const lawn = step(abs(mat.sub(7)), float(0.5));
  const base = sRGBTransferEOTF(col.xyz).mul(mix(vec3(1, 1, 1), texture(GRASS_TEX, (moved?.surface ?? positionWorld).xz.div(GRASS_TILE)).xyz.mul(2), lawn));
  const fac = attribute('fac', 'vec4').mul(255);
  const fuv = attribute('fuv', 'vec2').mul(512);

  const kindByte = floor(fac.z.add(0.5));
  const kind = mod(kindByte, 4);
  const shop = mod(floor(kindByte.div(4)), 2);
  const fh = floor(kindByte.div(8)).mul(0.1).add(2.5);
  // column width in decimetres x 2; the low bit: the wall opens at its windows where the detail layer draws them
  const facW = floor(fac.w.add(0.5));
  const colW = floor(facW.div(2)).div(10);
  const openBit = mod(facW, 2);
  const seed = floor(fac.y.add(0.5)).add(floor(fac.x.add(0.5)).mul(256));

  const isCurtain = step(abs(mat.sub(3)), float(0.5));
  const isWall = step(mat, float(0.5));
  const isMetal = step(abs(mat.sub(5)), float(0.5));
  // the pane at the back of an opening (detail layer): all window, no painted recess
  const isGlass = step(abs(mat.sub(10)), float(0.5));
  const vertical = step(abs(n.y), float(0.3));
  const hasWin = step(float(0.5), colW).mul(vertical).mul(max(max(max(isWall, isCurtain), isMetal), isGlass));

  // facade coordinates: columns (curtain wall: a room every 2 columns) and storeys
  const ground = shop.mul(4.4);
  const hh = fuv.y.sub(ground);
  const inShop = shop.mul(step(hh, float(0))).mul(step(float(0), fuv.y));
  const roomH = select(inShop.greaterThan(0.5), float(4.4), fh);
  const yy = select(inShop.greaterThan(0.5), fuv.y.div(4.4), hh.div(fh));
  const span = select(isCurtain.greaterThan(0.5), float(2), float(1));
  const uu = fuv.x.div(span);
  const cu = floor(uu), fl = floor(yy);
  const fx = fract(uu), fy = fract(yy);
  const wu = fwidth(uu).add(1e-4), wy = fwidth(yy).add(1e-4);
  const rnd = hash(cu.add(fl.add(64).mul(1013)).add(seed.mul(7919)));
  const rnd2 = hash(cu.mul(31).add(fl.add(64).mul(577)).add(seed.mul(131)).add(17));
  const sty = hash(seed.add(3));

  // windows by architecture style (side margin, sill, head, shutters/surround)
  const archId = int(floor(fac.x.add(0.5)));
  const ap = ARCH_WIN.element(archId);
  const ww = ap.x, wLow = ap.y, wHigh = ap.z;
  const hasShutters = mod(ap.w, 2), hasFrame = mod(floor(ap.w.div(2)), 2);
  // facade pattern bay rule: 4 = every third bay blank (art deco piers), 8 = only every third bay glazed (industrial)
  const skip3 = mod(floor(ap.w.div(4)), 2), only3 = mod(floor(ap.w.div(8)), 2);
  const cm = mod(cu, 3);
  const bayOn = float(1).sub(max(skip3.mul(step(abs(cm.sub(1)), float(0.5))), only3.mul(step(float(0.5), cm))).mul(float(1).sub(inShop)));
  const avgBay = float(1).sub(skip3.mul(1 / 3)).sub(only3.mul(2 / 3));
  const punched = band(ww, float(1).sub(ww), fx, wu).mul(band(wLow, wHigh, fy, wy));
  const houseWin = punched;
  const strip = band(ww, float(1).sub(ww), fx, wu).mul(band(wLow, wHigh, fy, wy));
  // surround (a light band of ~8 cm round it) and shutters open at the sides
  const fu = float(0.08).div(colW), fyy = float(0.08).div(fh);
  const frameOuter = band(ww.sub(fu), float(1).sub(ww).add(fu), fx, wu).mul(band(wLow.sub(fyy), wHigh.add(fyy.mul(1.5)), fy, wy));
  const shutW = min(ww.sub(0.02), float(1).sub(ww.mul(2)).mul(0.45));
  const shutter = max(band(ww.sub(shutW), ww.sub(0.01), fx, wu), band(float(1).sub(ww).add(0.01), float(1).sub(ww).add(shutW), fx, wu))
    .mul(band(wLow, wHigh, fy, wy)).mul(hasShutters).mul(step(float(0.25), rnd2));
  // 4.0 curtain wall (signature.ts:149-156, facadeKit.ts:235-247): a mullion at every bay's edge, the spandrel panel
  // at the foot of each storey (18 %) under a transom, the glass graded from light at the head to dark at the sill
  const cfx = fract(fuv.x), cw = fwidth(fuv.x).add(1e-4);
  const curtainGlass = band(float(0.03), float(0.97), cfx, cw).mul(band(float(0.205), float(0.985), fy, wy));
  const ck = int(mod(seed, 4)).mul(4);
  const cGlassA = CURTAINS.element(ck).xyz, cGlassB = CURTAINS.element(ck.add(1)).xyz, cMull = CURTAINS.element(ck.add(2)).xyz, cSpand = CURTAINS.element(ck.add(3)).xyz;
  const cMullAmt = float(1).sub(band(float(0.03), float(0.97), cfx, cw).mul(band(float(0.016), float(0.977), fy, wy).mul(float(1).sub(band(float(0.18), float(0.205), fy, wy)))));
  let win: Node = select(kind.lessThan(0.5), punched, select(kind.lessThan(1.5), curtainGlass, select(kind.lessThan(2.5), houseWin, strip)));
  // the shop window and the sign above it
  const shopWin = band(float(0.05), float(0.95), fx, wu).mul(band(float(0.05), float(0.76), fy, wy));
  const sign = band(float(0.8), float(0.95), fy, wy).mul(band(float(0.02), float(0.98), fx, wu));
  win = select(inShop.greaterThan(0.5), shopWin, win);
  win = win.mul(hasWin).mul(step(float(0), yy).max(inShop)).mul(bayOn);
  win = max(win, isGlass);
  // the opening: on a level-0 wall of a cell whose detail is on screen, the window (1 cm in from its edges, under
  // the reveals) is cut out and the detail's reveals and recessed pane show through
  const opened = uniform(0).onObjectUpdate(({ object }: { object: { userData: { cell?: number; level?: number; publisher?: boolean } } }) => {
    const u = object.userData;
    return !u.publisher && u.level === 0 && u.cell !== undefined && DETAIL_SHOWN[u.cell] ? 1 : 0;
  });
  const eu = float(0.01).div(colW), ey = float(0.01).div(fh);
  const hardWin = step(ww.add(eu), fx).mul(step(fx, float(1).sub(ww).sub(eu))).mul(step(wLow.add(ey), fy)).mul(step(fy, wHigh.sub(ey)));
  const hole = opened.mul(openBit).mul(hasWin).mul(bayOn).mul(float(1).sub(inShop)).mul(step(float(0), yy)).mul(hardWin);
  m.maskNode = lodFadeMask().and(cutMask()).and(hole.lessThan(0.5));
  // the shadow keeps the wall whole: the sun through an opening lights the room, not the street behind the building
  m.maskShadowNode = lodFadeMask().and(cutMask());
  const signMask = sign.mul(inShop).mul(hasWin).mul(step(float(0.35), rnd2));

  // fake interior: the camera ray inside a room the size of the window
  const V = normalize(positionWorld.sub(cameraPosition));
  const tng = vec3(n.z, 0, n.x.negate());
  const depth = select(inShop.greaterThan(0.5), float(8), float(4.5));
  const d = vec3(dot(V, tng).div(colW.mul(span)), V.y.div(roomH), max(dot(V, n.negate()), 0.02).div(depth));
  const sx = select(d.x.greaterThanEqual(0), max(d.x, 1e-4), min(d.x, -1e-4));
  const sy = select(d.y.greaterThanEqual(0), max(d.y, 1e-4), min(d.y, -1e-4));
  const ix = step(float(0), sx).sub(fx).div(sx);
  const iy = step(float(0), sy).sub(fy).div(sy);
  const iz = float(1).div(d.z);
  const tmin = min(min(ix, iy), iz);
  const hz = clamp(d.z.mul(tmin), 0, 1);
  const wallTone = mix(vec3(0.62, 0.55, 0.46), vec3(0.5, 0.56, 0.6), rnd);
  const backC = wallTone;
  const sideC = wallTone.mul(0.78);
  const floorC = mix(vec3(0.24, 0.17, 0.11), vec3(0.32, 0.3, 0.28), rnd2);
  const ceilC = vec3(0.86, 0.85, 0.82);
  const hitY = select(sy.lessThan(0), floorC, ceilC);
  let room: Node = select(iz.lessThanEqual(min(ix, iy)), backC, select(ix.lessThan(iy), sideC, hitY));
  room = room.mul(float(1).sub(hz.mul(0.45)));
  // a dark piece of furniture/partition at the back of some rooms
  room = room.mul(mix(float(1), float(0.55), step(float(0.7), rnd2).mul(step(iz, min(ix, iy)))));
  // a shop's room: walls lined with shelves of goods, a counter at the back, a light tiled floor (the 4.0 furnishes
  // its shops; here the same read in the interior mapping)
  const hx = fx.add(sx.mul(tmin)), hy = fy.add(sy.mul(tmin)), onBack = step(iz, min(ix, iy));
  const along = select(onBack.greaterThan(0.5), hx, hz);
  const shelfRow = fract(hy.mul(5));
  const shelfZone = step(float(0.2), hy).mul(step(hy, float(0.78)));
  const goodsCell = hash(floor(along.mul(16)).add(floor(hy.mul(5)).mul(37)).add(seed.mul(11)));
  const goodsC = mix(mix(vec3(0.75, 0.25, 0.18), vec3(0.2, 0.42, 0.7), step(float(0.33), goodsCell)), mix(vec3(0.85, 0.72, 0.3), vec3(0.3, 0.6, 0.35), step(float(0.8), goodsCell)), step(float(0.6), goodsCell));
  const goods = shelfZone.mul(step(float(0.12), shelfRow)).mul(step(shelfRow, float(0.62))).mul(step(float(0.25), goodsCell));
  const shelfC = mix(vec3(0.8, 0.77, 0.7), vec3(0.42, 0.3, 0.2), step(float(0.5), hash(seed.add(41))));
  let shopWall: Node = mix(mix(vec3(0.86, 0.83, 0.77), shelfC, shelfZone.mul(step(shelfRow, float(0.1)))), goodsC, goods);
  shopWall = mix(shopWall, shelfC.mul(0.7), onBack.mul(step(hy, float(0.22))).mul(step(abs(hx.sub(0.5)), float(0.35))));
  const tile = mod(floor(hx.mul(6)).add(floor(hz.mul(10))), 2);
  const shopFloor = mix(vec3(0.72, 0.7, 0.66), vec3(0.6, 0.58, 0.55), tile);
  const shopRoom = select(iy.lessThan(min(ix, iz)), select(sy.lessThan(0), shopFloor, vec3(0.9, 0.9, 0.88)), shopWall.mul(select(onBack.greaterThan(0.5), float(1), float(0.85))));
  room = select(inShop.greaterThan(0.5), shopRoom.mul(float(1).sub(hz.mul(0.25))), room);

  // night: some rooms lit (fewer later); shops and signs always
  const lit = step(rnd, mix(float(0.15), float(0.62), sty)).max(inShop);
  const lamp = mix(vec3(1.0, 0.84, 0.58), vec3(0.85, 0.92, 1.0), step(float(0.75), rnd2));
  const night = nightU;
  const dayInside = room.mul(select(inShop.greaterThan(0.5), float(0.26), float(0.11)));
  const nightInside = room.mul(lamp).mul(lit).mul(select(inShop.greaterThan(0.5), float(1.7), float(1.5)));
  // a blind (slats, down to some height) or curtains (panels at the sides) in some windows
  const r3 = hash(cu.mul(17).add(fl.add(64).mul(733)).add(seed.mul(53)).add(91));
  const lx = clamp(fx.sub(ww).div(float(1).sub(ww.mul(2)).max(0.05)), 0, 1);
  const ly = clamp(fy.sub(wLow).div(wHigh.sub(wLow).max(0.05)), 0, 1);
  const blindDown = hash(r3.mul(97.1)).mul(0.75).add(0.15);
  // blind slats: near only (18 per window turn to noise when the window has few pixels)
  const slatFade = clamp(float(1).sub(fwidth(ly.mul(18)).mul(1.5)), 0, 1);
  const slats = smoothstep(float(0.35), float(0.5), fract(ly.mul(18))).mul(0.25).mul(slatFade).add(float(1).sub(slatFade.mul(0.25)));
  const blinds = step(r3, float(0.32)).mul(step(float(1).sub(blindDown), ly));
  const curtW = hash(r3.mul(53.7)).mul(0.22).add(0.12);
  const curtains = step(float(0.32), r3).mul(step(r3, float(0.5))).mul(step(lx, curtW).max(step(float(1).sub(curtW), lx)));
  // curtains in neutral tones (cream, light grey); only the odd one coloured
  const curtC = mix(mix(vec3(0.72, 0.66, 0.56), vec3(0.64, 0.64, 0.62), step(float(0.55), hash(r3.mul(11.3)))), vec3(0.5, 0.3, 0.24), step(float(0.88), hash(r3.mul(5.9))));
  const blindC = mix(vec3(0.78, 0.76, 0.7), vec3(0.6, 0.62, 0.64), hash(r3.mul(3.3)));
  const cover = blinds.max(curtains).mul(float(1).sub(inShop));
  const coverC = select(blinds.greaterThan(0.5), blindC.mul(slats), curtC);
  // fabric by day: lit by the light coming in; at night, lit from behind if the room is lit
  const insideLit = mix(mix(dayInside, coverC.mul(0.32), cover), mix(nightInside, coverC.mul(lamp).mul(lit).mul(0.9), cover), night);
  const pick = floor(hash(cu.mul(23).add(fl.add(64).mul(389)).add(seed.mul(17)).add(5)).mul(20));
  const plainWin = step(kind, float(0.5)).max(step(float(1.5), kind)).mul(float(1).sub(inShop));
  // a pane 1.8 m or wider is the 4.0 wide window or ribbon: dark one in five, no roller
  const widePane = step(float(1.8), float(1).sub(ww.mul(2)).mul(colW));
  const darkPane = step(pick, mix(float(4.5), float(3.5), widePane)).mul(plainWin);
  const inside = insideLit.mul(mix(float(1), float(0.3), darkPane));
  // the roller shutter: down from the head a quarter to 70 % of the pane, slats every 5 cm, 5 cm in front of the glass
  const rollDown = pick.sub(9).mul(0.15).add(0.25);
  const roller = step(float(8.5), pick).mul(step(pick, float(12.5))).mul(plainWin).mul(float(1).sub(widePane)).mul(step(float(1).sub(rollDown), ly));
  const rollSlat = fract(fy.mul(fh).div(0.05));
  const rollerC = mix(vec3(0.4, 0.4, 0.38), vec3(0.6, 0.59, 0.56), smoothstep(float(0.15), float(0.5), rollSlat).mul(smoothstep(float(0.95), float(0.75), rollSlat)).mul(clamp(float(1).sub(fwidth(fy.mul(fh).div(0.05)).mul(1.5)), 0, 1)).add(0.25).min(1));

  // glass: reflection by the angle (Schlick's Fresnel)
  const cosV = clamp(dot(V.negate(), n), 0, 1);
  const F = float(0.04).add(float(0.96).mul(pow(float(1).sub(cosV), 5)));
  // the sky in the glass: the 4.0 punched windows read dark grey with a faint grey sky in them (roadcraft-rua-dia.png);
  // a curtain wall keeps the bluer sky of its tinted glass
  const skyRefl = mix(mix(vec3(0.2, 0.21, 0.22), vec3(0.42, 0.44, 0.46), clamp(V.y.negate().add(0.3), 0, 1)), mix(vec3(0.34, 0.4, 0.46), vec3(0.62, 0.7, 0.78), clamp(V.y.negate().add(0.3), 0, 1)), isCurtain).mul(float(1).sub(night.mul(0.92)));
  const glassTint = select(isCurtain.greaterThan(0.5), select(hasWin.greaterThan(0.5), mix(cGlassB, cGlassA, clamp(fy.sub(0.2).div(0.78), 0, 1)).mul(0.45), base.mul(0.35)), vec3(0.03, 0.04, 0.05));
  const refl = max(F, select(isCurtain.greaterThan(0.5), float(0.2), float(0.08)));

  // far: the facade's average only once a window cell is ~2 px (the 4.5 here averaged windows from ~3.5 px, and the
  // city went flat pastel from ~800 m; 4.0's filtered pulse holds the window to 2 px a bay)
  const detail = clamp(float(1.3).sub(max(wu, wy).mul(2.6)), 0, 1);
  const avgWin = select(kind.lessThan(0.5), float(0.6 * 0.56), select(kind.lessThan(1.5), float(0.74), select(kind.lessThan(2.5), float(0.2), float(0.2))))
    .mul(hasWin).mul(step(float(0), yy).max(inShop)).mul(mix(avgBay, float(1), inShop));
  const avgLit = mix(float(0.15), float(0.62), sty).max(inShop);
  const winAmt = max(mix(avgWin, win, detail), isGlass);
  // far, at night: the windows' average weaker and yellow (too strong turned the whole facade brown)
  const insideAmt = mix(mix(vec3(0.07, 0.065, 0.06), vec3(1.0, 0.88, 0.64).mul(avgLit).mul(0.42), night), inside, max(detail, isGlass));

  // curtain wall spandrels: opaque, the glass colour darkened
  const wallC = select(isCurtain.greaterThan(0.5), select(hasWin.greaterThan(0.5), mix(cSpand, cMull, cMullAmt.mul(detail)), base.mul(0.55)), base);
  const signC = mix(vec3(0.85, 0.2, 0.15), vec3(0.15, 0.4, 0.85), rnd).mul(mix(float(1), float(0.6), step(float(0.5), rnd2)));
  // surround and shutters (only where there is a real window, not on the curtain wall)
  const archMask = bayOn.mul(hasWin).mul(step(kind, float(0.5)).max(step(float(1.5), kind))).mul(step(float(0), yy)).mul(float(1).sub(inShop)).mul(detail);
  const trimC = ARCH_TRIM.element(int(mod(floor(fac.x.add(0.5)), ARCH_COUNT))).xyz;
  const shutterC = mix(mix(vec3(0.12, 0.3, 0.18), vec3(0.18, 0.28, 0.45), step(float(0.5), sty)), vec3(0.35, 0.22, 0.12), step(float(0.8), sty));
  const frameAmt = clamp(frameOuter.sub(win), 0, 1).mul(hasFrame).mul(archMask);
  const shutterAmt = shutter.mul(archMask);
  let wallFinal: Node = mix(mix(wallC, trimC, frameAmt), shutterC, shutterAmt);
  // the 4.0 plinth (emitPlinth): under the floor a wall is the stone plinth (0x7f786d, stone finish)
  const plinthAmt = max(isWall, isMetal).mul(vertical).mul(step(fuv.y, float(-0.03))).mul(step(float(-40), fuv.y));
  wallFinal = mix(wallFinal, vec3(PLINTH_RGB[0], PLINTH_RGB[1], PLINTH_RGB[2]), plinthAmt);
  // 4.0 storey bands (band(): BAND_OUT 7 cm, BAND_H 22 cm, a lower tier in the trim x 0.94) at every floor line above
  // the ground storey, painted for the middle distance (the detail layer stands them out near)
  const lineD = min(fy, float(1).sub(fy)).mul(fh);
  const bandOn = step(lineD, float(0.11)).mul(select(fy.lessThan(0.5), step(float(0.5), fl).max(shop), float(1))).mul(hasWin).mul(float(1).sub(isCurtain))
    .mul(float(1).sub(inShop)).mul(step(float(0), yy)).mul(float(1).sub(win)).mul(step(kind, float(0.5)).max(step(float(1.5), kind))).mul(float(1).sub(isGlass));
  const lowerTier = step(float(0.5), fy).mul(step(float(0.022), float(1).sub(fy).mul(fh)));
  const bandC = select(dot(trimC, vec3(0.2126, 0.7152, 0.0722)).lessThan(0.08), wallC.mul(0.86), trimC);
  wallFinal = mix(wallFinal, bandC.mul(mix(float(1), float(0.94), lowerTier)), bandOn.mul(clamp(float(1.4).sub(wy.mul(fh).mul(2.8)), 0, 1)));
  const finE = select(plinthAmt.greaterThan(0.5), float(4), fin);
  const hasFinE = max(hasFin, plinthAmt);
  const P = moved?.surface ?? positionWorld;
  // finish: UV in metres in the face's plane (u along the face, v up; on a slab, x and z)
  const look = FINISH_LOOK.element(int(floor(finE.add(0.5))));
  const faceH = vec2(n.z, n.x.negate());
  const flatFace = step(dot(faceH, faceH), float(0.0025));
  const tAx = normalize(mix(vec3(faceH.x, 0, faceH.y), vec3(1, 0, 0), flatFace));
  const bAx = cross(n, tAx);
  const fuvM = vec2(dot(P, tAx), dot(P, bAx)).mul(look.x);
  const layer = int(max(finE.sub(1), float(0)));
  const finA = texture(FINISH_ALBEDO, fuvM).depth(layer);
  const finN = texture(FINISH_NORMAL, fuvM).depth(layer);
  // paint x map as in 4.0; glass and slate (maps of mean 0.08 and 0.23, drawn dark by their own shading here: the
  // curtain wall's glass, the roof's) keep their paint as the mean
  const darkMean = select(abs(finE.sub(8)).lessThan(0.5), float(0.081), select(abs(finE.sub(13)).lessThan(0.5), float(0.226), float(1)));
  const finTone = mix(vec3(1, 1, 1), finA.xyz.div(darkMean).min(2), hasFinE);
  const wn = texture(WALL_NOISE, vec2(P.x.add(P.z), P.y).mul(0.11));
  const grain = wn.r.mul(2).sub(1);
  const isFacade = hasWin.max(vertical.mul(isWall));
  const plain = float(1).sub(isCurtain).mul(float(1).sub(hasFin));
  const winCol = band(ww, float(1).sub(ww), fx, wu).mul(hasWin).mul(bayOn).mul(float(1).sub(inShop)).mul(step(float(0), yy));
  // rain streak under the window (darker near the sill)
  const sh = hash(cu.mul(41).add(fl.add(64).mul(211)).add(seed.mul(29)).add(7));
  const reach = min(wLow.mul(fh).sub(0.11), floor(fract(sh.mul(7.31)).mul(7)).mul(0.12).add(0.7));
  const half = floor(fract(sh.mul(3.17)).mul(5)).mul(0.03).add(0.32).mul(float(1).sub(ww.mul(2)));
  const below = wLow.sub(fy).mul(fh).sub(0.06);
  const streakOn = step(float(1 / 3), sh).mul(step(float(0.5), wLow.mul(fh).sub(0.06))).mul(step(abs(fx.sub(0.5)), half))
    .mul(step(float(0), below)).mul(step(below, reach)).mul(hasWin).mul(bayOn).mul(float(1).sub(inShop)).mul(step(float(0), yy));
  const streak = streakOn.mul(float(1).sub(below.div(reach.max(0.1)))).mul(wn.g.mul(0.5).add(0.75)).mul(0.1)
    .mul(step(kind, float(0.5)).max(step(float(1.5), kind))).mul(float(1).sub(isMetal));
  // a light sill (it takes the sun from above) and its shadow just below
  const sillW = band(ww.sub(0.04), float(1).sub(ww).add(0.04), fx, wu).mul(hasWin).mul(bayOn).mul(float(1).sub(inShop)).mul(step(float(0), yy)).mul(step(kind, float(0.5)).max(step(float(1.5), kind)));
  const sill = sillW.mul(band(wLow.sub(float(0.06)), wLow, fy, wy));
  const sillShadow = sillW.mul(band(wLow.sub(float(0.12)), wLow.sub(float(0.06)), fy, wy));
  const pm = vec2(dot(P, tAx), dot(P, bAx));
  const nr = (k: number) => texture(WALL_NOISE, pm.mul(k)).r;
  const macro = nr(0.0056).mul(0.55).add(nr(0.021).mul(0.3)).add(nr(0.075).mul(0.15));
  const glassy = max(max(isCurtain, isGlass), step(abs(fin.sub(7)), float(0.5)).max(step(abs(fin.sub(8)), float(0.5))));
  const stainStreak = smoothstep(float(0.55), float(0.85), texture(WALL_NOISE, vec2(pm.x.mul(0.1375), P.y.mul(0.02))).g);
  const grimeN = nr(0.0275).mul(0.5).add(0.5);
  const stain = float(0.3).mul(float(0.18).add(grimeN.mul(0.12)).add(select(vertical.greaterThan(0.5), stainStreak.mul(0.28), float(0.1)))).mul(float(1).sub(glassy));
  const weather = macro.mul(0.2).add(0.9).mul(float(1).sub(stain));
  const wallK = float(1).add(grain.mul(0.11).mul(plain)).sub(streak).sub(sillShadow.mul(0.3));
  const sillAmt = sill.mul(isFacade).mul(detail).mul(float(1).sub(isCurtain));
  wallFinal = mix(wallFinal.mul(wallK).mul(finTone).mul(weather), mix(trimC, vec3(0.86, 0.84, 0.8), 0.5), sillAmt);
  // the recess by the view angle: the glass sits ~22 cm in; where the opening (in the wall) does not show the
  // glass, the opening's side shows (in shade), opposite the eye
  const inward = max(dot(V, n.negate()), float(0.15));
  const recess = float(0.22);
  const offU = dot(V, tng).div(inward).mul(recess).div(colW.mul(span));
  const offY = V.y.div(inward).mul(recess).div(fh);
  const glassSeen = band(ww, float(1).sub(ww), fx.add(offU), wu).mul(band(wLow, wHigh, fy.add(offY), wy));
  const deepWin = step(kind, float(0.5)).max(step(float(1.5), kind)).mul(float(1).sub(inShop));
  const reveal = clamp(punched.sub(glassSeen), 0, 1).mul(winCol).mul(deepWin).mul(detail).mul(float(1).sub(isGlass));
  // which face: a jamb (normal ±tangent) where the ray leaves the opening sideways, else the head (down) or the sill (up)
  const gx = fx.add(offU), gy = fy.add(offY);
  const outX = max(ww.sub(gx), gx.sub(float(1).sub(ww))).mul(colW), outY = max(wLow.sub(gy), gy.sub(wHigh)).mul(fh);
  const jambN = select(gx.lessThan(0.5), tng, tng.negate());
  const capN = select(gy.lessThan(0.5), vec3(0, 1, 0), vec3(0, -1, 0));
  const faceN = select(outX.greaterThan(outY), jambN, capN);
  // the 4.0 reveal: trim x 0.68 in its own shade, lifted where the sun reaches it (relative to the wall's own light)
  const litFace = clamp(dot(faceN, SUN_DIR), 0, 1), litWall = clamp(dot(n, SUN_DIR), 0, 1);
  const revealK = float(WIN_REVEAL_SHADE).mul(float(0.45).add(litFace.mul(0.55)).div(float(0.45).add(litWall.mul(0.55))));
  const glassC = mix(glassTint.add(skyRefl.mul(refl)), wallC.mul(revealK.mul(float(1).sub(night.mul(0.6)))), reveal);
  // the roller over the pane where it is down (near and mid; far it is in the average)
  const rollAmt = roller.mul(win).mul(detail).mul(float(1).sub(reveal));
  // the 4.0 frame (kit.ts:239-257) painted where the detail layer does not stand it: the border 4.5 % of the opening,
  // a mullion in the middle and a transom at 68 %, in the trim; seen at the pane's depth (the recess's parallax)
  const px = select(isGlass.greaterThan(0.5), fx, gx), py = select(isGlass.greaterThan(0.5), fy, gy);
  const fxw = px.sub(ww).div(float(1).sub(ww.mul(2)).max(0.05)), fyw = py.sub(wLow).div(wHigh.sub(wLow).max(0.05));
  const ax2 = fwidth(fxw).add(1e-4), ay2 = fwidth(fyw).add(1e-4);
  const edgeBar = float(1).sub(band(float(0.045), float(0.955), fxw, ax2).mul(band(float(0.045), float(0.955), fyw, ay2)));
  const crossBar = max(band(float(0.482), float(0.518), fxw, ax2), band(float(0.662), float(0.698), fyw, ay2));
  // the shopfront's frame the same (4.0 buildingMesh.ts:1659-1661: frame over the glass of the shop window)
  const sxw = fx.sub(0.05).div(0.9), syw = fy.sub(0.05).div(0.71), sax = fwidth(sxw).add(1e-4), say = fwidth(syw).add(1e-4);
  const shopBars = float(1).sub(band(float(0.03), float(0.97), sxw, sax).mul(band(float(0.04), float(0.96), syw, say)))
    .max(band(float(0.488), float(0.512), sxw, sax)).max(band(float(0.665), float(0.69), syw, say));
  // (not on a pane of the detail layer or of a 4.0 building: its frame stands there in relief)
  const paneFrame = max(max(edgeBar, crossBar).mul(plainWin), shopBars.mul(inShop)).mul(win).mul(float(1).sub(isGlass)).mul(float(1).sub(reveal)).mul(float(1).sub(rollAmt))
    .mul(clamp(float(1.6).sub(max(ax2, ay2).mul(12)), 0, 1));
  const albedo = mix(mix(mix(mix(wallFinal, glassC.mul(mix(float(1), float(0.6), darkPane)), winAmt), rollerC, rollAmt), trimC, paneFrame), signC, signMask.mul(detail));
  m.colorNode = vec4(albedo, 1);
  m.emissiveNode = insideAmt.mul(winAmt).mul(float(1).sub(refl)).mul(float(1).sub(reveal)).mul(float(1).sub(rollAmt)).mul(float(1).sub(paneFrame)).add(signC.mul(signMask).mul(detail).mul(night).mul(1.8));

  // indoors (BMAT.Indoor: a ruin's floors and the inner side of its walls): the sky's light hardly reaches in
  m.aoNode = select(mat.equal(11), float(0.5), float(1));
  const rough0 = select(mat.equal(7), float(0.95), select(mat.equal(5), float(0.45), select(mat.equal(2), float(0.7), float(0.86))));
  const rough = mix(rough0, finA.w, hasFinE);
  m.roughnessNode = mix(mix(rough, float(0.12), winAmt.mul(float(1).sub(reveal))), float(0.6), max(rollAmt, paneFrame));
  m.metalnessNode = max(select(mat.equal(5), float(0.35), float(0)), look.z.mul(mix(float(1), finN.w, look.w)).mul(hasFinE)).mul(float(1).sub(winAmt)).mul(float(1).sub(rollAmt));
  // the finish's relief (off the glass), in the face's frame
  const nm = finN.xyz.mul(2).sub(1);
  const nk = look.y.mul(hasFinE).mul(float(1).sub(winAmt)).mul(float(1).sub(sillAmt));
  const nW = normalize(tAx.mul(nm.x.mul(nk)).add(bAx.mul(nm.y.mul(nk))).add(n.mul(nm.z)));
  m.normalNode = transformNormalToView(moved ? moved.turn(nW) : nW);
  if (moved) withPrevious(m, moved.prev);
  return m;
}

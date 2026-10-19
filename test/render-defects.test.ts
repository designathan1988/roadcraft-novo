/// <reference types="node" />
// Regression tests for the drawing defects (section E of DEFEITOS-roadcraft-novo.md), one test per defect id. Each one
// failed on the code before its fix (the commit that fixed it quotes the result before and after).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { World } from '../src/world/world.ts';
import { CellLayer, type LayerSource } from '../src/render/cellLayer.ts';
import { Dirty } from '../src/core/grid.ts';
import type { PackedMesh } from '../src/jobs/protocol.ts';

/** A one-triangle packed mesh. */
function triangle(): PackedMesh {
  return { originX: 0, originY: 0, originZ: 0, scale: 256, vertexCount: 3, minY: 0, maxY: 1,
    position: new Int16Array([0, 0, 0, 0, 100, 0, 0, 0, 0, 0, 100, 0]), normal: new Int8Array(12), color: new Uint8Array(12),
    index: new Uint16Array([0, 1, 2]) };
}

type Slot = { mesh: THREE.Mesh | null; requested: number; built: number };
interface LayerInside { cells: Slot[][]; tiles: Slot[]; plates: Slot[]; setMesh(s: Slot, m: PackedMesh | null, v: number): void }
const inside = (l: CellLayer) => l as unknown as LayerInside;

/** A layer source that records every request and keeps its callbacks, to answer them by hand. */
function recordingSource(): LayerSource & { cells: Array<{ c: number; level: number; done: (m: PackedMesh | null) => void }> } {
  const cells: Array<{ c: number; level: number; done: (m: PackedMesh | null) => void }> = [];
  return {
    cells,
    buildCell(c, level, _p, done) { cells.push({ c, level, done }); },
    buildTile(_t, _p, done) { done(null); },
    hasContent: () => true,
  };
}

test('E10: two layers fed by the same kind of dirty cells both rebuild an edited cell', () => {
  const w = new World();
  const material = new THREE.MeshBasicNodeMaterial();
  const srcA = recordingSource(), srcB = recordingSource();
  const city = new CellLayer(srcA, w.dirty, Dirty.Buildings, material, { near: 1400, evict: 2600, margin: 40 });
  const detail = new CellLayer(srcB, w.dirty, Dirty.Buildings, material, { near: 1100, evict: 1400, margin: 30, sparse: true });
  const c = 5;
  for (const l of [city, detail]) inside(l).setMesh(inside(l).cells[0][c], triangle(), 1);
  w.dirty.mark(c, Dirty.Buildings);
  city.processDirty();
  detail.processDirty();
  assert.deepEqual(srcA.cells.map((r) => r.c), [c], 'the city layer asked for the edited cell');
  assert.deepEqual(srcB.cells.map((r) => r.c), [c], 'the detail layer asked for the edited cell too');
});

test('E11: a mesh of the previous city that arrives after reset is thrown away', () => {
  const w = new World();
  const src = recordingSource();
  const layer = new CellLayer(src, w.dirty, Dirty.Buildings, new THREE.MeshBasicNodeMaterial(), { near: 1400, evict: 2600, margin: 40 });
  const L = inside(layer);
  const c = 7;
  // the old city asks for the cell (its job is still running when the player loads another map)
  (layer as unknown as { requestCell(c: number, level: number): void }).requestCell(c, 0);
  const old = src.cells.pop()!;
  layer.reset();
  // the new city asks for the same cell
  (layer as unknown as { requestCell(c: number, level: number): void }).requestCell(c, 0);
  const fresh = src.cells.pop()!;
  old.done(triangle());
  assert.ok(L.cells[0][c].mesh === null, 'the old city\'s mesh was not taken');
  fresh.done(triangle());
  assert.ok(L.cells[0][c].mesh !== null, 'the new city\'s mesh was taken');
});

/** A source that answers tiles and plates at once (cells are left pending), counting the requests. */
function farSource(): LayerSource & { tileAsks: number[]; plateAsks: number[] } {
  const tileAsks: number[] = [], plateAsks: number[] = [];
  return {
    tileAsks, plateAsks,
    buildCell() { /* near cells never answer: the far bands are under test */ },
    buildTile(t, _p, done) { tileAsks.push(t); done(triangle()); },
    buildPlate(p, _q, done) { plateAsks.push(p); done(triangle()); },
    hasContent: () => true,
  };
}

/** A camera at the map's south-west corner, 300 m up, looking at the centre with a 90° view. */
function cornerCamera(): { camera: THREE.PerspectiveCamera; eye: THREE.Vector3 } {
  const camera = new THREE.PerspectiveCamera(90, 1, 1, 30000);
  const eye = new THREE.Vector3(-5100, 300, -5100);
  camera.position.copy(eye);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return { camera, eye };
}

test('E12: every tile in view between 4.2 and 6 km is covered by its tile or by its plate', async () => {
  const { MAP_TILES, MAP_PLATES, TILE_SIZE, PLATE_SIZE } = await import('../src/config.ts');
  const w = new World();
  const src = farSource();
  // the building layer's own options (render/city.ts)
  const layer = new CellLayer(src, w.dirty, Dirty.Buildings, new THREE.MeshBasicNodeMaterial(), { near: 1400, evict: 2600, margin: 40, detail: 650, plate: 4200, budget: 256e6 });
  const L = inside(layer);
  const { camera, eye } = cornerCamera();
  for (let i = 0; i < 4; i++) layer.update(camera, eye);
  const drawn = new Set(layer.group.children);
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const per = PLATE_SIZE / TILE_SIZE;
  const missing: string[] = [];
  for (let tz = 0; tz < MAP_TILES; tz++) for (let tx = 0; tx < MAP_TILES; tx++) {
    const x = -MAP_TILES * TILE_SIZE / 2 + tx * TILE_SIZE, z = -MAP_TILES * TILE_SIZE / 2 + tz * TILE_SIZE;
    const box = new THREE.Box3(new THREE.Vector3(x + 1, 0, z + 1), new THREE.Vector3(x + TILE_SIZE - 1, 1, z + TILE_SIZE - 1));
    if (!frustum.intersectsBox(box)) continue;
    const d = Math.hypot(Math.max(0, x - eye.x), Math.max(0, z - eye.z));
    if (d < 1600) continue; // the near band draws by cells (they never answer here)
    const t = tz * MAP_TILES + tx, p = Math.floor(tz / per) * MAP_PLATES + Math.floor(tx / per);
    const covered = (L.tiles[t].mesh && drawn.has(L.tiles[t].mesh!)) || (L.plates[p].mesh && drawn.has(L.plates[p].mesh!));
    if (!covered) missing.push(`tile ${tx},${tz} at ${(d / 1000).toFixed(1)} km`);
  }
  assert.deepEqual(missing, [], 'tiles in view with nothing drawn');
});

test('E9: a plate the camera came close to leaves the GPU once its tiles cover it', () => {
  const w = new World();
  const src = { ...farSource(), buildCell(_c: number, _l: number, _p: number, done: (m: PackedMesh | null) => void) { done(triangle()); } };
  const layer = new CellLayer(src, w.dirty, Dirty.Buildings, new THREE.MeshBasicNodeMaterial(), { near: 1400, evict: 2600, margin: 40, detail: 650, plate: 4200, budget: 256e6 });
  const L = inside(layer);
  const { camera, eye } = cornerCamera();
  for (let i = 0; i < 3; i++) layer.update(camera, eye);
  const centre = 2 * 5 + 2; // plate (2, 2) of the 10 km map: far from the corner
  assert.ok(L.plates[centre].mesh !== null, 'seen from the corner the centre plate is drawn');
  // fly to the centre: the plate's tiles and cells take over
  eye.set(0, 300, 0); camera.position.copy(eye); camera.lookAt(500, 0, 500); camera.updateMatrixWorld();
  for (let i = 0; i < 3; i++) layer.update(camera, eye);
  assert.ok(L.plates[centre].mesh === null, 'the plate under the camera was let go');
});

test('E13: the road layer keeps and draws its tiles to the same distance at every resolution', async () => {
  const { MAP_TILES, TILE_SIZE } = await import('../src/config.ts');
  for (const pixelScale of [0.5, 2]) {
    const w = new World();
    const src = farSource();
    // the road layer's own options (render/roads.ts)
    const layer = new CellLayer(src, w.dirty, Dirty.Roads, new THREE.MeshBasicNodeMaterial(), { near: 1400, evict: 2200, margin: 80, shadows: false, far: 5500, detail: 600, budget: 192e6 });
    layer.pixelScale = pixelScale;
    const L = inside(layer);
    const { camera, eye } = cornerCamera();
    for (let i = 0; i < 3; i++) layer.update(camera, eye);
    const drawn = new Set(layer.group.children);
    const limit = 5500 * Math.max(1, pixelScale);
    const kept: number[] = [], shown: number[] = [];
    for (let t = 0; t < MAP_TILES * MAP_TILES; t++) {
      const x = -MAP_TILES * TILE_SIZE / 2 + (t % MAP_TILES) * TILE_SIZE, z = -MAP_TILES * TILE_SIZE / 2 + Math.floor(t / MAP_TILES) * TILE_SIZE;
      const d = Math.hypot(Math.max(0, x - eye.x), Math.max(0, z - eye.z));
      if (d < 1600) continue;
      const m = L.tiles[t].mesh;
      if (m) kept.push(d);
      if (m && drawn.has(m)) shown.push(d);
    }
    const farKept = Math.max(...kept), farShown = Math.max(...shown);
    assert.ok(farShown > limit - 1500, `pixel scale ${pixelScale}: roads drawn only to ${(farShown / 1000).toFixed(1)} km (limit ${limit / 1000} km)`);
    assert.ok(farKept < limit * 1.2, `pixel scale ${pixelScale}: tiles kept to ${(farKept / 1000).toFixed(1)} km but drawn to ${(farShown / 1000).toFixed(1)} km`);
  }
});

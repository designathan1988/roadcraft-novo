/// <reference types="node" />
// Regression tests for the defects listed in DEFEITOS-roadcraft-novo.md (one test per defect id). Each one failed on
// commit 4d6fc49 before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { RoadJournal, buildRoad, planRoad, snap } from '../src/roads/build.ts';
import { buildBuildings } from '../src/jobs/buildingGen.ts';
import { emptyBoxes, type PackedMesh } from '../src/jobs/protocol.ts';
import { Zone } from '../src/roads/zones.ts';
import { CommandStack } from '../src/core/commands.ts';
import { Growth } from '../src/world/growth.ts';
import type { JobPool } from '../src/jobs/pool.ts';
import type { LotColumns } from '../src/jobs/protocol.ts';
import * as THREE from 'three/webgpu';
import { CellLayer } from '../src/render/cellLayer.ts';
import { Dirty } from '../src/core/grid.ts';

/** World positions of a packed mesh's vertices. */
function positions(m: PackedMesh): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < m.vertexCount; i++) {
    const p = m.position, k = m.scale / 32767;
    out.push([m.originX + p[i * 4] * k, m.originY + p[i * 4 + 1] * k, m.originZ + p[i * 4 + 2] * k]);
  }
  return out;
}

function flatWorld(money: number): World {
  const w = new World();
  w.heights.fill(10); w.tileMin.fill(10); w.tileMax.fill(10);
  w.money = money;
  return w;
}

function road(w: World, ax: number, az: number, bx: number, bz: number, profile = 0): void {
  const a = snap(w.roads, ax, az, 8), b = snap(w.roads, bx, bz, 8);
  const p = planRoad(w, a, null, b, profile, 0);
  assert.ok(p.ok, p.reason);
  assert.ok(buildRoad(w, p, a, b, profile).settle());
}

test('D1: raising or lowering a node never gives money back for roads that are still there', () => {
  const w = flatWorld(1e9);
  road(w, -120, 0, 120, 0);
  road(w, 0, -120, 0, 120);
  const node = w.roads.nearestNode(0, 0, 3);
  assert.ok(node !== null && node >= 0, 'the crossing has a node');
  const start = w.money;
  for (let i = 0; i < 10; i++) {
    for (const dy of [0.5, -0.5]) {
      const j = new RoadJournal(w, 'node height');
      j.moveNodeY(node, w.roads.nodes.cols.y[node] + dy);
      assert.ok(j.settle());
    }
    assert.ok(w.money <= start, `after ${i + 1} up/down pairs the money went from ${start} to ${w.money}`);
  }
});

test('F1: a building that overhangs its cell is not flattened at the cell edge', () => {
  const w = flatWorld(0);
  const b = emptyBoxes(1);
  // centre 10 m inside the east and south edges of cell (0, 0): the building reaches 10-12 m past both
  b.x[0] = 246; b.z[0] = 246; b.w[0] = 40; b.d[0] = 44; b.rot[0] = 0;
  b.zone[0] = Zone.Commercial; b.floors[0] = 8; b.seed[0] = 4242; b.style[0] = 3;
  b.count = 1;
  for (const lod of [0, 1, -1]) {
    const m = buildBuildings(w.heights, b, 0, 0, 256, lod);
    assert.ok(m, `level ${lod} has a mesh`);
    let maxX = -Infinity, maxZ = -Infinity;
    for (const [x, , z] of positions(m)) { maxX = Math.max(maxX, x); maxZ = Math.max(maxZ, z); }
    assert.ok(maxX > 260 && maxZ > 260, `level ${lod}: the building ends at x=${maxX.toFixed(2)}, z=${maxZ.toFixed(2)} (cut at 256)`);
  }
});

test('A20: undoing a demolition works after growth took the lot (and its freed id)', () => {
  const w = flatWorld(1e9);
  const commands = new CommandStack();
  const rec = { x: 100, z: 100, w: 20, d: 30, h: 0, rot: 0, color: 0, seed: 77, zone: Zone.Residential, floors: 3, style: 5 };
  const build = new RoadJournal(w, 'build');
  const id = build.addBuilding(rec);
  commands.push(build);
  const demolish = new RoadJournal(w, 'demolish');
  demolish.removeBuilding(id);
  commands.push(demolish);
  // the lot is free again: growth grows a building on it, outside the history
  const lot: LotColumns = { count: 1, x: new Float32Array([100]), z: new Float32Array([100]), w: new Float32Array([20]), d: new Float32Array([30]),
    rot: new Float32Array([0]), zone: new Uint8Array([Zone.Residential]), seed: new Uint32Array([991]), profile: new Uint16Array([0]) };
  new Growth(w, null as unknown as JobPool).place(lot, 0);
  // a neighbour on the next lot, sharing the lot edge at x = 110: it must stay
  const neighbour = w.growBuilding({ ...rec, x: 120, seed: 555 });
  assert.doesNotThrow(() => commands.undo(), 'undo of the demolition');
  assert.equal(w.buildings.alive[id], 1, 'the demolished building is back with its id');
  assert.equal(w.buildings.cols.seed[id], 77, 'it is the same building');
  let onLot = 0;
  w.buildingIndex.query(80, 80, 105, 120, (b) => { if (Math.abs(w.buildings.cols.x[b] - 100) < 1) onLot++; });
  assert.equal(onLot, 1, 'one building on the lot, not the restored one on top of the grown one');
  assert.equal(w.buildings.alive[neighbour], 1, 'the neighbour sharing the lot edge stays');
  assert.doesNotThrow(() => commands.redo(), 'redo of the demolition');
  assert.equal(w.buildings.alive[id], 0);
});

/** A one-triangle packed mesh. */
function triangle(): PackedMesh {
  return { originX: 0, originY: 0, originZ: 0, scale: 256, vertexCount: 3, minY: 0, maxY: 1,
    position: new Int16Array([0, 0, 0, 0, 100, 0, 0, 0, 0, 0, 100, 0]), normal: new Int8Array(12), color: new Uint8Array(12),
    index: new Uint16Array([0, 1, 2]) };
}

test('E6: a cell mesh that is replaced or reset is disposed (three releases its render objects only then)', () => {
  const w = new World();
  const source = { buildCell() {}, buildTile() {}, hasContent: () => true };
  const layer = new CellLayer(source, w.dirty, Dirty.Buildings, new THREE.MeshBasicNodeMaterial(), { near: 1400, evict: 2600, margin: 40 });
  type Slot = { mesh: THREE.Mesh | null };
  const inner = layer as unknown as { cells: Slot[][]; setMesh(s: Slot, m: PackedMesh | null, v: number): void };
  const slot = inner.cells[0][0];
  inner.setMesh(slot, triangle(), 1);
  const first = slot.mesh!;
  let disposed = 0;
  first.addEventListener('dispose', () => { disposed++; });
  inner.setMesh(slot, triangle(), 2);
  assert.equal(disposed, 1, 'the replaced mesh fired dispose');
  const second = slot.mesh!;
  let reset = 0;
  second.addEventListener('dispose', () => { reset++; });
  layer.reset();
  assert.equal(reset, 1, 'reset disposed the mesh it held');
});

test('E1: a cell that does not fit in the props pool is never cut silently; near cells come before far ones', async () => {
  const { PropBlocks } = await import('../src/render/propBlocks.ts');
  const BLOCK = 64;
  const pool = new PropBlocks(100, 20); // room for 100 blocks
  // 3 cells of 40 blocks each, placed far to near: the third does not fit beside the other two
  const placed = [pool.place(0, 40 * BLOCK, BLOCK, 3000), pool.place(1, 40 * BLOCK, BLOCK, 2000), pool.place(2, 40 * BLOCK, BLOCK, 100)];
  for (let c = 0; c < 3; c++) {
    const got = pool.blocksOf(c)?.length ?? 0;
    assert.ok(got === 0 || got === 40, `cell ${c} holds ${got} of its 40 blocks: cut silently`);
  }
  assert.equal(pool.blocksOf(2)?.length, 40, 'the nearest cell has all its props');
  assert.equal(pool.blocksOf(0), null, 'the farthest cell gave way');
  assert.ok(placed[2] !== null, 'the near cell was placed');
});

test('E2: the pool\'s high-water mark goes back down when the top blocks are freed', async () => {
  const { PropBlocks } = await import('../src/render/propBlocks.ts');
  const pool = new PropBlocks(100, 4);
  pool.place(0, 10 * 64, 64, 10);
  pool.place(1, 30 * 64, 64, 10);
  assert.equal(pool.highBlock, 40);
  pool.release(1);
  assert.equal(pool.highBlock, 10, 'only cell 0 is left: the cull pass reads 10 blocks, not 40');
});

/** A stand-in worker: answers every job with an error when the payload asks for one, else with `{ ok: true }`. */
class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  postMessage(msg: { type: string; id?: number; payload?: { fail?: boolean } }): void {
    if (msg.type !== 'job') return;
    const reply = msg.payload?.fail ? { type: 'error', id: msg.id, message: 'disk full' } : { type: 'done', id: msg.id, result: { ok: true } };
    setTimeout(() => this.onmessage?.({ data: reply }), 1);
  }
}

test('A3: a job that fails tells whoever asked for it (save, load and new map cannot hang)', async () => {
  const { JobPool } = await import('../src/jobs/pool.ts');
  const shared = { heights: new SharedArrayBuffer(4), ground: new SharedArrayBuffer(4), water: new SharedArrayBuffer(4) };
  const pool = new JobPool(shared, 1, () => new FakeWorker() as unknown as Worker);
  const told = await new Promise<string>((resolve) => {
    pool.submit('saveMeta', { slot: 's', meta: new Uint8Array(1), fail: true } as never, () => resolve('done'), { fail: (m: string) => resolve(`failed: ${m}`) } as never);
    setTimeout(() => resolve('never told'), 200);
  });
  assert.equal(told, 'failed: disk full');
  const run = (pool as unknown as { run?: (k: string, p: unknown) => Promise<unknown> }).run;
  assert.equal(typeof run, 'function', 'the pool has a promise form for code that awaits a job');
  await assert.rejects(run!.call(pool, 'saveMeta', { slot: 's', meta: new Uint8Array(1), fail: true }), /disk full/);
  assert.deepEqual(await run!.call(pool, 'saveMeta', { slot: 's', meta: new Uint8Array(1) }), { ok: true });
});

test('A4: a callback that throws does not stop the pool', async () => {
  const { JobPool } = await import('../src/jobs/pool.ts');
  const shared = { heights: new SharedArrayBuffer(4), ground: new SharedArrayBuffer(4), water: new SharedArrayBuffer(4) };
  const pool = new JobPool(shared, 1, () => new FakeWorker() as unknown as Worker);
  const errors = console.error; console.error = () => {};
  try {
    const second = new Promise<string>((resolve) => {
      pool.submit('saveMeta', { slot: 's', meta: new Uint8Array(1) }, () => { throw new Error('bug in a callback'); });
      pool.submit('saveMeta', { slot: 's', meta: new Uint8Array(1) }, () => resolve('second ran'));
      setTimeout(() => resolve('pool stopped'), 200);
    });
    assert.equal(await second, 'second ran');
  } finally { console.error = errors; }
});

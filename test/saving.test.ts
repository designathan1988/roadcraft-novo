/// <reference types="node" />
// Saving, loading and the job pool: regression tests for the A defects of DEFEITOS-roadcraft-novo.md (one test per
// defect id, named after it). Each one failed before its fix; the in-game half of these defects is in
// tools/check-save.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobPool } from '../src/jobs/pool.ts';

const shared = () => ({ heights: new SharedArrayBuffer(4), ground: new SharedArrayBuffer(4), water: new SharedArrayBuffer(4) });

type Reply = { type: string; id?: number; result?: unknown; message?: string };

/**
 * A stand-in worker. Payload flags: `uncloneable` (postMessage throws DataCloneError, like a payload holding a
 * function), `die` (the worker raises an uncaught error and never answers), `badReply` (its answer cannot be read on
 * the page), `slow` (answers after that many ms). Anything else answers `{ ok: true, by }` with the worker's number.
 */
class FakeWorker {
  static made = 0;
  readonly n = FakeWorker.made++;
  onmessage: ((e: { data: Reply }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  onmessageerror: ((e: unknown) => void) | null = null;
  terminated = false;
  received: string[] = [];
  postMessage(msg: { type: string; id?: number; payload?: Record<string, unknown> }): void {
    this.received.push(msg.type);
    if (msg.type !== 'job') return;
    const p = msg.payload ?? {};
    if (p.uncloneable) throw new DOMException('function could not be cloned', 'DataCloneError');
    if (p.die) { setTimeout(() => this.onerror?.({ message: 'out of memory' }), 1); return; }
    if (p.badReply) { setTimeout(() => this.onmessageerror?.({}), 1); return; }
    const reply: Reply = { type: 'done', id: msg.id, result: { ok: true, by: this.n } };
    setTimeout(() => { if (!this.terminated) this.onmessage?.({ data: reply }); }, Number(p.slow ?? 1));
  }
  terminate(): void { this.terminated = true; }
}

/** The outcome of a job within `ms`: 'done', 'failed: <why>' or 'never told'. */
function outcome(pool: JobPool, payload: Record<string, unknown>, ms = 300, key?: string): Promise<string> {
  return new Promise((resolve) => {
    try {
      pool.submit('terrainGen', payload as never, () => resolve('done'), { key, fail: (m) => resolve(`failed: ${m}`) });
    } catch (err) { resolve(`submit threw: ${(err as Error).message}`); return; }
    setTimeout(() => resolve('never told'), ms);
  });
}

test('A5: a job whose message cannot be sent fails, and its worker stays free for the next job', async () => {
  const pool = new JobPool(shared(), 1, () => new FakeWorker() as unknown as Worker);
  const errors = console.error; console.error = () => {};
  try {
    const first = await outcome(pool, { uncloneable: true });
    assert.match(first, /^failed: .*cloned/, 'the sender is told why');
    assert.equal(await outcome(pool, {}), 'done', 'the next job runs on the same worker');
    assert.ok(pool.isIdle(), 'nothing is left busy');
  } finally { console.error = errors; }
});

test('A5: a worker that dies fails its job, is replaced, and the queue goes on', async () => {
  const made: FakeWorker[] = [];
  const pool = new JobPool(shared(), 1, () => { const w = new FakeWorker(); made.push(w); return w as unknown as Worker; });
  pool.broadcast({ type: 'profiles', list: [] });
  const errors = console.error; console.error = () => {};
  try {
    const dying = outcome(pool, { die: true });
    const queued = outcome(pool, {});
    assert.match(await dying, /^failed: .*out of memory/, 'the job on the dead worker is reported');
    assert.equal(await queued, 'done', 'the job queued behind it runs');
    assert.equal(made.length, 2, 'a new worker took the place of the dead one');
    assert.ok(made[0].terminated, 'the dead worker was terminated');
    assert.deepEqual(made[1].received.slice(0, 2), ['init', 'profiles'], 'the new worker got the shared world and the last broadcast');
    // an answer that cannot be read on the page fails its job too (the worker is fine and keeps working)
    assert.equal(await outcome(pool, { badReply: true }), 'failed: the worker\'s answer could not be read');
    assert.equal(await outcome(pool, {}), 'done');
  } finally { console.error = errors; }
});

test('A5: a worker that keeps dying is not restarted forever; with no worker left, jobs fail instead of waiting', async () => {
  let made = 0;
  const pool = new JobPool(shared(), 1, () => { made++; return new FakeWorker() as unknown as Worker; });
  const errors = console.error; console.error = () => {};
  try {
    for (let k = 0; k < 6; k++) await outcome(pool, { die: true });
    assert.ok(made <= 4, `${made} workers made for one slot`);
    assert.match(await outcome(pool, {}), /^failed: /, 'a job with no worker to run it fails at once');
    assert.ok(pool.isIdle());
  } finally { console.error = errors; }
});

test('A6: a keyed job superseded while queued or while running tells its sender (covered by the pool since ddd3fa7)', async () => {
  const pool = new JobPool(shared(), 1, () => new FakeWorker() as unknown as Worker);
  const running = outcome(pool, { slow: 30 }, 300, 'terrain:1');
  const queued = outcome(pool, {}, 300, 'terrain:2');
  const queuedLater = outcome(pool, {}, 300, 'terrain:2');
  const supersedesRunning = outcome(pool, {}, 300, 'terrain:1');
  assert.equal(await queued, 'failed: superseded', 'the queued job replaced by a newer one of its key');
  assert.equal(await running, 'failed: superseded', 'the running job whose key was submitted again');
  assert.equal(await queuedLater, 'done');
  assert.equal(await supersedesRunning, 'done');
});

// ------------------------------------------------------------------ save generations (saveFiles.ts)

import { SaveSlot, StoreError, type FileEntry, type FileStore } from '../src/platform/saveFiles.ts';
import { encodeMeta } from '../src/platform/save.ts';
import { TILE_COUNT } from '../src/core/grid.ts';

/** Folders in memory; `failWrite(name)` returning true makes that write fail like a full disk. */
class MemoryStore implements FileStore {
  dirs = new Map<string, Map<string, Uint8Array>>();
  failWrite: (name: string) => boolean = () => false;
  private dir(f: string) { let d = this.dirs.get(f); if (!d) this.dirs.set(f, (d = new Map())); return d; }
  async read(f: string, n: string) { return this.dirs.get(f)?.get(n)?.slice() ?? null; }
  async write(f: string, n: string, data: Uint8Array) { if (this.failWrite(n)) throw new StoreError('disk full'); this.dir(f).set(n, data.slice()); }
  async list(f: string): Promise<FileEntry[]> { return [...(this.dirs.get(f) ?? new Map<string, Uint8Array>())].map(([name, b]) => ({ name, size: b.length })); }
  async remove(f: string, n: string) { this.dirs.get(f)?.delete(n); }
  async folders() { return [...this.dirs.keys()].filter((k) => k !== ''); }
  async removeFolder(f: string) { this.dirs.delete(f); }
}

const metaOf = (game: number, listed: number[]) => { const tiles = new Uint8Array(TILE_COUNT); for (const t of listed) tiles[t] = 1; return encodeMeta({ seed: 7, gameId: game, tiles, camera: new Float64Array(0) }); };
const bytes = (...v: number[]) => new Uint8Array(v);
const { sha256 } = await import('../src/jobs/storage.ts');

async function saveGen(slot: SaveSlot, tiles: Array<[number, Uint8Array]>, listed: number[], kept: Awaited<ReturnType<SaveSlot['open']>>['generations'][0] | null) {
  const w = await slot.begin();
  for (const [t, b] of tiles) await w.tile(t, b, await sha256(b));
  return w.commit(metaOf(5, listed), listed, kept, 5, 7);
}

test('A9: a save that fails before its commit leaves the save before it as the one that opens, intact', async () => {
  const store = new MemoryStore(), slot = new SaveSlot(store, 'cidade-1');
  const g1 = await saveGen(slot, [[3, bytes(1, 1, 1)], [4, bytes(2, 2)]], [3, 4], null);
  // the next save rewrites tile 3 and adds tile 9, then the commit (or the manifest, or the map description) fails
  for (const failing of [/^current/, /^manifest/, /^meta/]) {
    store.failWrite = (n) => failing.test(n);
    await assert.rejects(saveGen(slot, [[3, bytes(9, 9, 9, 9)], [9, bytes(5)]], [3, 4, 9], g1));
    store.failWrite = () => false;
    const { generations } = await slot.open();
    assert.equal(generations[0].gen, g1.gen, `after a failed ${failing} the save before opens`);
    assert.deepEqual([...generations[0].tiles.keys()], [3, 4]);
    assert.deepEqual(await slot.readTile(generations[0], 3), bytes(1, 1, 1), 'tile 3 as it was saved, not as the failed save wrote it');
  }
});

test('A9: a committed save keeps the generation before it as a fallback and removes only what neither uses', async () => {
  const store = new MemoryStore(), slot = new SaveSlot(store, 'cidade-1');
  const g1 = await saveGen(slot, [[3, bytes(1)], [4, bytes(2)]], [3, 4], null);
  const g2 = await saveGen(slot, [[3, bytes(3, 3)]], [3, 4], g1);
  let o = await slot.open();
  assert.deepEqual(o.generations.map((g) => g.gen), [g2.gen, g1.gen]);
  assert.equal(o.generations[0].tiles.get(4)!.file, g1.tiles.get(4)!.file, 'an unchanged tile keeps its file');
  // the newest manifest damaged: the generation before opens
  const man = g2.manifest!.file;
  await store.write('cidade-1', man, bytes(...new TextEncoder().encode('{"format":1')));
  o = await slot.open();
  assert.equal(o.generations[0].gen, g1.gen);
  assert.equal(o.newest, g2.gen, 'the caller knows it fell back');
  // a third save built on g1: the files only g2 used go
  const g3 = await saveGen(slot, [[4, bytes(4, 4, 4)]], [3, 4], g1);
  const names = (await store.list('cidade-1')).map((e) => e.name).sort();
  assert.ok(!names.includes(g2.tiles.get(3)!.file) && !names.includes(man), `g2's files removed: ${names}`);
  assert.ok(names.includes(g1.tiles.get(3)!.file) && names.includes(g3.tiles.get(4)!.file));
  // a tile file that is gone is reported, not hidden
  await store.remove('cidade-1', g3.tiles.get(4)!.file);
  o = await slot.open();
  assert.deepEqual([...o.generations[0].missing.keys()], [4]);
});

test('A9: a save from before generations opens as generation 0 and the first new save builds on it', async () => {
  const store = new MemoryStore(), slot = new SaveSlot(store, 'cidade-1');
  await store.write('cidade-1', 'meta.bin', metaOf(5, [3, 4]));
  await store.write('cidade-1', 'tile_0003.bin', bytes(1));
  await store.write('cidade-1', 'tile_0004.bin', bytes(2));
  await store.write('cidade-1', 'tile_0050.bin', bytes(8)); // a tile its map does not list
  const g0 = (await slot.open()).generations[0];
  assert.equal(g0.gen, 0);
  assert.deepEqual([...g0.tiles.keys()], [3, 4]);
  const g1 = await saveGen(slot, [[3, bytes(7)]], [3, 4], g0);
  assert.equal(g1.tiles.get(4)!.file, 'tile_0004.bin');
  const names = (await store.list('cidade-1')).map((e) => e.name);
  assert.ok(!names.includes('tile_0050.bin') && names.includes('meta.bin'), `${names}`);
  assert.equal((await slot.open()).generations[1].gen, 0, 'generation 0 is the fallback');
});

test('A14: the same damaged save goes to quarantine once, and only the last three quarantines are kept', async () => {
  const { quarantineSlot } = await import('../src/platform/mapFile.ts');
  const store = new MemoryStore(), slot = new SaveSlot(store, 'cidade-1');
  await store.write('cidade-1', 'meta.bin', bytes(1, 2, 3));
  const q = (why: string) => (quarantineSlot as (s: SaveSlot, why: string) => Promise<string | null>)(slot, why);
  const first = await q('damaged');
  assert.equal(await q('damaged'), first, 'opening the same damaged save again does not copy it again');
  assert.equal((await store.folders()).filter((f) => f.startsWith('quarentena-')).length, 1);
  for (let k = 0; k < 4; k++) { await store.write('cidade-1', 'meta.bin', bytes(9, k)); await new Promise((r) => setTimeout(r, 2)); await q(`damaged ${k}`); }
  const left = (await store.folders()).filter((f) => f.startsWith('quarentena-'));
  assert.equal(left.length, 3, `${left}`);
  assert.ok(!left.includes(first!), 'the oldest went');
});

test('A17: cancelling a key prefix drops the queued jobs and the result of the one running', async () => {
  const pool = new JobPool(shared(), 1, () => new FakeWorker() as unknown as Worker);
  const running = outcome(pool, { slow: 30 }, 300, 'lots:1');
  const queued = outcome(pool, {}, 300, 'lots:2');
  const other = outcome(pool, {}, 300, 'props:2');
  (pool as unknown as { cancel(prefix: string): void }).cancel('lots:');
  assert.equal(await running, 'failed: cancelled', 'the lots being made for the old city are not delivered');
  assert.equal(await queued, 'failed: cancelled');
  assert.equal(await other, 'done', 'other jobs go on');
  assert.equal(await outcome(pool, {}, 300, 'lots:1'), 'done', 'a new job of a cancelled key runs');
});

// ------------------------------------------------------------------ desktop save files (electron/files.mjs)

test('desktop saves: real files, written whole (temporary file, flush, rename), names that are never paths', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const where = '../electron/files.mjs';
  const { fileStore } = await import(where) as { fileStore(root: string): FileStore };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roadcraft-files-'));
  try {
    const st = fileStore(path.join(root, 'saves'));
    assert.equal(await st.read('cidade-1', 'meta.bin'), null, 'nothing yet');
    assert.deepEqual(await st.list('cidade-1'), []);
    await st.write('cidade-1', 'meta.bin', bytes(1, 2, 3));
    await st.write('cidade-1', 'meta.bin', bytes(4, 5));
    assert.deepEqual(new Uint8Array(await st.read('cidade-1', 'meta.bin') as Uint8Array), bytes(4, 5));
    assert.deepEqual(await st.list('cidade-1'), [{ name: 'meta.bin', size: 2 }], 'no temporary file left behind');
    assert.ok(fs.existsSync(path.join(root, 'saves', 'cidade-1', 'meta.bin')), 'a real file in the folder');
    await st.write('', 'mark.json', bytes(7));
    assert.deepEqual(await st.folders(), ['cidade-1']);
    for (const bad of ['../x', 'a/b', 'a\b', '..', '.', '']) await assert.rejects(st.write('cidade-1', bad, bytes(1)), /invalid save file name/, bad);
    await assert.rejects(st.read('..', 'x'), /invalid save file name/);
    await st.remove('cidade-1', 'meta.bin');
    await st.remove('cidade-1', 'meta.bin');
    assert.deepEqual(await st.list('cidade-1'), []);
    await st.removeFolder('cidade-1');
    assert.deepEqual(await st.folders(), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('desktop saves: the saves kept in the browser storage are copied to files once, and never removed from it', async () => {
  const { migrateOnce } = await import('../src/platform/saveFiles.ts');
  const opfs = new MemoryStore(), files = new MemoryStore();
  await opfs.write('cidade-1', 'meta.bin', bytes(1));
  await opfs.write('cidade-1', 'tile_0003.bin', bytes(2, 2));
  await opfs.write('anterior-2026-10-18T10-00-00-cidade-1', 'meta.bin', bytes(3));
  // a copy that stopped half way: the folder is there with its "being copied" mark
  await files.write('anterior-2026-10-18T10-00-00-cidade-1', 'migrating-from-browser-storage.json', bytes(0));
  // the copy fails once (disk full): nothing is marked as done, and the next start tries again
  files.failWrite = (n) => n === 'tile_0003.bin';
  await assert.rejects(migrateOnce(opfs, files));
  files.failWrite = () => false;
  assert.deepEqual((await migrateOnce(opfs, files)).sort(), ['anterior-2026-10-18T10-00-00-cidade-1', 'cidade-1']);
  assert.deepEqual(await files.read('cidade-1', 'tile_0003.bin'), bytes(2, 2));
  assert.deepEqual((await files.list('anterior-2026-10-18T10-00-00-cidade-1')).map((e) => e.name), ['meta.bin'], 'the half-way mark is gone');
  assert.deepEqual((await opfs.list('cidade-1')).map((e) => e.name).sort(), ['meta.bin', 'tile_0003.bin'], 'the browser storage is untouched');
  // once: a save made since is never overwritten by the old one
  await files.write('cidade-1', 'meta.bin', bytes(9, 9));
  assert.deepEqual(await migrateOnce(opfs, files), []);
  assert.deepEqual(await files.read('cidade-1', 'meta.bin'), bytes(9, 9));
});

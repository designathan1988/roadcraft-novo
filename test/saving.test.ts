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
      pool.submit('saveMeta', payload as never, () => resolve('done'), { key, fail: (m) => resolve(`failed: ${m}`) });
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

/// <reference types="node" />
// The simulation worker's own loop, run under Node with a fake clock: `self`, `setTimeout` and `performance.now` are
// replaced before the worker module is loaded (one worker per test file: the module is a singleton).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FromSim, ToSim } from '../src/sim/worker.ts';
import { createPoseBuffers } from '../src/sim/poses.ts';
import { Traffic } from '../src/sim/traffic.ts';
import { encodeOps } from '../src/sim/lanes.ts';
import type { NetOp } from '../src/roads/network.ts';

interface FakeScope { postMessage(m: FromSim): void; onmessage: ((e: { data: ToSim }) => void) | null }

const posted: FromSim[] = [];
const scope: FakeScope = { postMessage: (m) => { posted.push(m); }, onmessage: null };
(globalThis as unknown as { self: FakeScope }).self = scope;

let now = 0;
/** Pending worker timers (the worker keeps at most one). */
const timers: Array<{ fn: () => void; delay: number }> = [];
const realNow = performance.now.bind(performance);
const realSetTimeout = globalThis.setTimeout;
function fakeClock(on: boolean): void {
  (performance as unknown as { now: () => number }).now = on ? () => now : realNow;
  (globalThis as unknown as { setTimeout: unknown }).setTimeout = on
    ? (fn: () => void, delay = 0) => { timers.push({ fn, delay }); return timers.length; }
    : realSetTimeout;
}
/** Fires the worker's pending timer at the time it asked for (unless `at` says when), returning the delay it had asked. */
function fire(at?: number): number {
  const t = timers.shift();
  assert.ok(t, 'the worker scheduled its next step');
  now = at ?? now + t.delay;
  t.fn();
  return t.delay;
}
const send = (m: ToSim) => scope.onmessage!({ data: m });

fakeClock(true);
await import('../src/sim/worker.ts');
send({ type: 'init', poses: createPoseBuffers(), heights: new SharedArrayBuffer(4), occupancy: new SharedArrayBuffer(1 << 16), signals: new SharedArrayBuffer(1 << 14), tickHz: 20 });
fakeClock(false);

test('C13: after a slow step the simulation does not run steps back to back without limit to catch up the clock', () => {
  fakeClock(true);
  try {
    for (let i = 0; i < 5; i++) fire();
    // one step took 10 s (a stall): the next steps fire with no wait while the simulation is behind the clock
    now += 10000;
    fire(now); // the step that was due before the stall
    let backToBack = 0;
    while (backToBack < 1000 && fire(now) === 0) backToBack++;
    assert.ok(backToBack <= 4, `${backToBack} steps ran back to back after a 10 s stall (unbounded catch-up)`);
  } finally { fakeClock(false); }
});

test('C14: a network change that fails is reported, the rest of the batch still applies and the page is asked for the whole network', () => {
  posted.length = 0;
  const node = (id: number, x: number): NetOp => ({ t: 'addNode', rec: { id, x, z: 0, y: 10 } });
  const seg = (id: number, a: number, b: number, x: number): NetOp => ({ t: 'addSeg', rec: { id, a, b, cx: x, cz: 0, profile: 0, flags: 0, zl: 0, zr: 0 } });
  const batch = (ops: NetOp[]) => { const extra: string[] = []; const e = encodeOps(ops, extra); send({ type: 'ops', ops: e, extra }); };
  batch([node(0, 0), node(1, 100), seg(0, 0, 1, 50)]);
  // removing a node that still has a segment throws in the network; the node added after it must still arrive
  let threw: unknown = null;
  try { batch([{ t: 'remNode', id: 0 }, node(2, 300)]); } catch (e) { threw = e; }
  assert.equal(threw, null, `the worker let the error out of its message handler: ${String(threw)}`);
  const errors = posted.filter((m) => m.type === 'error');
  assert.ok(errors.length >= 1, 'the failure was reported to the page');
  assert.ok(posted.some((m) => m.type === 'resync'), 'the worker asked the page for the whole network (its mirror diverged)');
});

test('C14: every different simulation error is reported, not only the first one', () => {
  fakeClock(true);
  const real = Traffic.prototype.step;
  let n = 0;
  try {
    posted.length = 0;
    Traffic.prototype.step = function () { n++; throw new Error(`step failure ${n <= 3 ? 'A' : 'B'}`); };
    for (let i = 0; i < 6; i++) fire();
    const errors = posted.filter((m) => m.type === 'error').map((m) => (m as { message: string }).message.split(String.fromCharCode(10))[0]);
    assert.ok(errors.some((m) => m.includes('failure A')) && errors.some((m) => m.includes('failure B')), `reported: ${JSON.stringify(errors)}`);
  } finally { Traffic.prototype.step = real; fakeClock(false); }
});

test('C29: per-hour and per-minute figures use simulated time, not real time (at 4x speed too)', () => {
  fakeClock(true);
  const real = Traffic.prototype.lineStats;
  const asked: number[] = [];
  try {
    Traffic.prototype.lineStats = function (dt: number) { asked.push(dt); return real.call(this, dt); };
    send({ type: 'speed', value: 4 });
    posted.length = 0;
    for (let i = 0; i < 45; i++) fire();
    const stats = posted.filter((m) => m.type === 'stats') as Array<{ simTime?: number }>;
    assert.ok(asked.length >= 2, `line figures asked ${asked.length} times`);
    assert.ok(Math.abs(asked[asked.length - 1] - 4) < 0.01, `boardings per hour reckoned over ${asked[asked.length - 1]} s for 4 simulated seconds`);
    assert.ok(stats.length >= 2 && typeof stats[1].simTime === 'number' && Math.abs(stats[1].simTime - stats[0].simTime! - 4) < 0.01, 'the stats carry the simulated time (for trips per minute)');
  } finally { Traffic.prototype.lineStats = real; send({ type: 'speed', value: 1 }); fakeClock(false); }
});

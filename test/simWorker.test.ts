/// <reference types="node" />
// The simulation worker's own loop, run under Node with a fake clock: `self`, `setTimeout` and `performance.now` are
// replaced before the worker module is loaded (one worker per test file: the module is a singleton).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FromSim, ToSim } from '../src/sim/worker.ts';
import { createPoseBuffers } from '../src/sim/poses.ts';

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

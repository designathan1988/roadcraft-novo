/// <reference types="node" />
// The simulation worker's own loop, run under Node with a fake clock: `self`, `setTimeout` and `performance.now` are
// replaced before the worker module is loaded (one worker per test file: the module is a singleton).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FromSim, ToSim } from '../src/sim/worker.ts';
import { createPoseBuffers, PoseReader, viewPoseBuffers, POSE_STRIDE } from '../src/sim/poses.ts';
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
const poseSab = createPoseBuffers();
send({ type: 'init', poses: poseSab, heights: new SharedArrayBuffer(4), occupancy: new SharedArrayBuffer(1 << 16), signals: new SharedArrayBuffer(1 << 14), tickHz: 20 });
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

test('C30: paused, people and vehicles are published standing (previous pose = current), so nobody walks in place', () => {
  fakeClock(true);
  try {
    // a straight road of 1.2 km with traffic, the camera on it
    const ops: NetOp[] = [{ t: 'clear' }];
    for (let i = 0; i <= 6; i++) ops.push({ t: 'addNode', rec: { id: 10 + i, x: i * 200, z: 50, y: 10 } });
    for (let i = 0; i < 6; i++) ops.push({ t: 'addSeg', rec: { id: 10 + i, a: 10 + i, b: 11 + i, cx: i * 200 + 100, cz: 50, profile: 0, flags: 0, zl: 2, zr: 2 } });
    const extra: string[] = []; const e = encodeOps(ops, extra);
    send({ type: 'ops', ops: e, extra });
    send({ type: 'camera', x: 600, z: 50 });
    send({ type: 'density', value: 1 / 15 });
    for (let i = 0; i < 20 * 30; i++) fire();
    const reader = new PoseReader(viewPoseBuffers(poseSab));
    reader.acquire();
    assert.ok(reader.count > 3, `agents published ${reader.count}`);
    send({ type: 'speed', value: 0 });
    for (let i = 0; i < 10; i++) fire();
    reader.acquire();
    const d = reader.data;
    let moving = 0;
    for (let i = 0; i < reader.count; i++) { const o = i * POSE_STRIDE; if (Math.hypot(d[o + 4] - d[o], d[o + 6] - d[o + 2]) > 1e-4) moving++; }
    assert.equal(moving, 0, `${moving} of ${reader.count} agents still published moving while paused`);
  } finally { send({ type: 'speed', value: 1 }); fakeClock(false); }
});

test('C30: at 2x and 4x the walk is played faster with the ground speed, so the feet do not slide', async () => {
  const { pickLook } = await import('../src/render/people/looks.ts');
  const meta = { variations: Array.from({ length: 4 }, () => ({ band: 'adult', height: 1.75 })) } as unknown as import('../src/render/people/format.ts').CookedPeople;
  const out = { variation: 0, clip: 0, rate: 1, phase: 0, hash: 0 };
  // someone walking 1.4 m/s seen at 4x: 5.6 m/s on screen
  const l = pickLook(3 * 256, 5.6, false, 0, meta, out, 7);
  assert.ok(l.rate >= 3.5, `walk played at ${l.rate}x for 4x the walking speed`);
  const b = pickLook(5 * 256, 20, true, 0, meta, out, 7);
  assert.ok(b.rate >= 3.5, `pedalling at ${b.rate}x for 4x the cycling speed`);
});

test('C7: drawing the vehicles and people reads only the poses of the part of the city in view, not every pose', async () => {
  const THREE = await import('three/webgpu');
  const { VehicleRenderer } = await import('../src/render/vehicles.ts');
  fakeClock(true);
  try {
    // a grid city of 10 x 10 streets 150 m apart, the camera over it, busy traffic
    const ops: NetOp[] = [{ t: 'clear' }];
    const id = (i: number, j: number) => 100 + i * 10 + j;
    for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) ops.push({ t: 'addNode', rec: { id: id(i, j), x: i * 150 - 675, z: j * 150 - 675, y: 10 } });
    let s = 100;
    for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) {
      if (i < 9) ops.push({ t: 'addSeg', rec: { id: s++, a: id(i, j), b: id(i + 1, j), cx: i * 150 - 600, cz: j * 150 - 675, profile: 0, flags: 0, zl: 2, zr: 1 } });
      if (j < 9) ops.push({ t: 'addSeg', rec: { id: s++, a: id(i, j), b: id(i, j + 1), cx: i * 150 - 675, cz: j * 150 - 600, profile: 0, flags: 0, zl: 1, zr: 2 } });
    }
    const extra: string[] = []; const e = encodeOps(ops, extra);
    send({ type: 'ops', ops: e, extra });
    send({ type: 'camera', x: 0, z: 0 });
    send({ type: 'density', value: 1 / 12 });
    for (let i = 0; i < 20 * 40; i++) fire();
  } finally { fakeClock(false); }
  const reader = new PoseReader(viewPoseBuffers(poseSab));
  reader.acquire();
  const n = reader.count;
  assert.ok(n > 400, `poses published ${n}`);
  const vr = new VehicleRenderer(reader);
  // looking out of the city from its east edge: almost nothing in view
  const cam = new THREE.PerspectiveCamera(50, 16 / 9, 1, 4000);
  cam.position.set(700, 40, 0); cam.lookAt(2000, 0, 0); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
  // count the poses the drawing reads
  const seen = new Set<number>();
  const data = reader.data;
  const counted = new Proxy(data, { get(t, p) { if (typeof p === 'string' && /^\d+$/.test(p)) seen.add(Math.floor(Number(p) / POSE_STRIDE)); const v = Reflect.get(t, p, t); return typeof v === 'function' ? v.bind(t) : v; } });
  Object.defineProperty(reader, 'data', { get: () => counted, configurable: true });
  Object.defineProperty(reader, 'acquire', { value: () => false, configurable: true });
  vr.update(cam, cam.position);
  const reads = seen.size;
  assert.ok(reads < n * 0.3, `the drawing read ${reads} of ${n} poses with almost nothing in view`);
});

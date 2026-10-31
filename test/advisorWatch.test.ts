/// <reference types="node" />
// D55: the automatic control judges only the junctions it watches, each every EVERY s (4.0 ControlAdvisor.EVERY,
// world.ts stepControlAdvisor): a junction is watched from its first vehicle (or from its creation / the choice of its
// control) until it rests at signs too quiet for anything else. No step walks the map's nodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridCity, traffic, inner } from './simCity.ts';
import * as advisor from '../src/sim/advisor.ts';

// read through the module (4.0's 10 s if it has none), so the test runs against code without the constant too
const EVERY: number = (advisor as { EVERY?: number }).EVERY ?? 10, SETTLE = advisor.SETTLE;

/** Steps the advisor alone (no vehicles) from t0 to t1, rebuilding the nodes it changed as the worker does. */
function idle(tr: ReturnType<typeof traffic>, sim: ReturnType<typeof gridCity>['sim'], t0: number, t1: number): void {
  for (let t = t0; t < t1; t++) { tr.advisor.step(t); if (t % EVERY === 0) tr.nodesRebuilt(sim.rebuild()); }
}

test('D55: with no traffic the signals nobody needs go, then nothing is watched and a step reads no node', () => {
  const { sim } = gridCity();
  const tr = traffic(sim);
  let signals = 0;
  for (let n = 0; n < sim.net.nodes.end; n++) if (sim.net.nodes.alive[n] && sim.nodeAuto[n] && sim.nodePhases[n] > 0) signals++;
  assert.ok(signals > 0, 'the grid has automatic junctions with a signal to judge');
  idle(tr, sim, 0, SETTLE + 4 * EVERY);
  for (let n = 0; n < sim.net.nodes.end; n++) {
    if (sim.net.nodes.alive[n] && sim.nodeAuto[n]) assert.equal(sim.nodePhases[n], 0, `node ${n}: no flow, no signal`);
  }
  assert.equal(inner(tr.advisor).size, 0, 'no junction is watched');
  const nodes = sim.net.nodes as unknown as { alive: Uint8Array };
  const real = nodes.alive;
  let reads = 0;
  Object.defineProperty(nodes, 'alive', {
    configurable: true, writable: true,
    value: new Proxy(real, { get: (o, k) => { if (typeof k === 'string' && /^\d+$/.test(k)) reads++; return Reflect.get(o, k); } }),
  });
  try {
    tr.advisor.step(SETTLE + 4 * EVERY);
  } finally {
    Object.defineProperty(nodes, 'alive', { configurable: true, writable: true, value: real });
  }
  assert.equal(reads, 0, `nodes read by one step: ${reads}`);
});

test('D55: a junction with flow is judged every EVERY s; a quiet one is watched again at its next vehicle', () => {
  const { sim } = gridCity();
  const tr = traffic(sim);
  const t0 = SETTLE + 4 * EVERY;
  idle(tr, sim, 0, t0);
  let n = -1;
  for (let k = 0; k < sim.net.nodes.end && n < 0; k++) if (sim.net.nodes.alive[k] && sim.nodeAuto[k] && sim.net.nodes.cols.deg[k] === 4) n = k;
  assert.ok(n >= 0);
  const a = inner(tr.advisor);
  assert.equal(a.queued[n], 0, 'quiet: not watched');
  // a steady flow: 3 vehicles a second on each arm
  for (let t = t0; t <= t0 + 3 * EVERY + 5; t++) {
    for (let arm = 0; arm < 4; arm++) for (let i = 0; i < 3; i++) tr.advisor.count(n, arm, t);
    tr.advisor.step(t);
    if (t === t0) assert.equal(a.queued[n], 1, 'its first vehicle: watched');
  }
  assert.equal(a.lastT[n], t0 + 3 * EVERY, 'judged at t0 + 10, 20, 30 s, not at every step');
  assert.ok(tr.advisor.rate[n * 8] > 0, 'the flow was measured');
});

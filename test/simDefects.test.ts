/// <reference types="node" />
// Regression tests for the simulation defects (section C of DEFEITOS-roadcraft-novo.md), one test per defect id.
// Each one failed on the code before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SimNet } from '../src/sim/lanes.ts';
import { ROUTE_CAP, type Traffic } from '../src/sim/traffic.ts';
import { gridCity, inner, traffic } from './simCity.ts';

/** A connection whose two lanes are both long enough to hold a queue. */
function someConn(sim: SimNet): number {
  const k = sim.conns.cols;
  for (let c = 0; c < sim.conns.end; c++) {
    if (!sim.conns.alive[c] || k.turn[c] !== 1) continue;
    if (sim.laneLen(k.from[c]) > 40 && sim.laneLen(k.to[c]) > 40 && sim.net.nodes.cols.deg[k.node[c]] >= 3) return c;
  }
  throw new Error('no straight connection between long lanes');
}

/** A vehicle placed on `lane` at `s`, driving to the end node of `next` through the connection's node. */
function place(tr: Traffic, lane: number, s: number, next: number, micro: boolean): number {
  const T = inner(tr), sim = tr.sim, c = tr.veh.cols;
  const v = tr.veh.alloc();
  T.initVehicle(v);
  c.kind[v] = 0; c.len[v] = 4.4;
  const o = v * ROUTE_CAP;
  tr.routes[o] = sim.laneFrom(lane); tr.routes[o + 1] = sim.laneTo(lane); tr.routes[o + 2] = sim.laneTo(next);
  c.rLen[v] = 3; c.rIdx[v] = 1; c.dest[v] = sim.laneTo(next);
  c.lane[v] = lane; c.conn[v] = -1; c.s[v] = s;
  T.setLaneCount(lane, 1);
  if (micro) { T.addMicro(v); T.insert(v, false, lane); } else T.schedule(v, tr.time);
  return v;
}

test('C8: a far vehicle that finds no room at the start of the next lane is not counted as having passed the node', () => {
  const { sim } = gridCity(4, 120);
  const tr = traffic(sim);
  tr.density = 0;
  tr.window = 1e6; // every lane in the micro window: the meso vehicle would become micro on the next lane
  const k = sim.conns.cols, conn = someConn(sim);
  const from = k.from[conn], to = k.to[conn], node = k.node[conn];
  // a stopped micro car right at the start of the next lane: no room to enter it
  const blocker = place(tr, to, 1, to, true);
  tr.veh.cols.v[blocker] = 0;
  // a meso car at the end of its lane, due to move on now
  const v = place(tr, from, tr.sim.laneLen(from), to, false);
  const passed = tr.nodePass[node], arm = k.arm[conn], flow = tr.advisor.pass[node * 8 + arm];
  inner(tr).mesoAdvance(v);
  assert.equal(tr.veh.cols.lane[v], from, 'the car is still on its lane');
  assert.equal(tr.nodePass[node], passed, `node pass count went from ${passed} to ${tr.nodePass[node]} with nobody through`);
  assert.equal(tr.advisor.pass[node * 8 + arm], flow, 'the automatic control saw a vehicle that did not pass');
});

/** Segment between two nodes (−1 if none). */
function segBetween(sim: SimNet, a: number, b: number): number {
  const sc = sim.net.segs.cols;
  for (const s of sim.net.segsOf(a, [])) if ((sc.a[s] === a && sc.b[s] === b) || (sc.b[s] === a && sc.a[s] === b)) return s;
  return -1;
}

/** First movement along `path` (arriving at path[0] by `inSeg`) that no connection makes, as "node from→to", or null. */
function illegalTurn(sim: SimNet, inSeg: number, path: Int32Array, len: number): string | null {
  const k = sim.conns.cols;
  let sIn = inSeg;
  for (let i = 0; i + 1 < len; i++) {
    const n = path[i], sOut = segBetween(sim, n, path[i + 1]);
    if (sIn >= 0) {
      let ok = false;
      for (let c = sim.nodeConn[n]; c >= 0 && !ok; c = k.nextAtNode[c]) ok = (k.from[c] >> 4) === sIn && (k.to[c] >> 4) === sOut;
      if (!ok) return `node ${n}: ${sIn}→${sOut}`;
    }
    sIn = sOut;
  }
  return null;
}

test('C12: routes never use a banned turn or a movement the hand-made lane connectors removed', async () => {
  const { mirror, recordOps } = await import('./simCity.ts');
  const { Router } = await import('../src/sim/routing.ts');
  const { w, sim } = gridCity(4, 120);
  const ops = recordOps(w);
  const nc = sim.net.nodes.cols, sc = sim.net.segs.cols;
  // an inner four-way junction, the arm it is entered by and the arm straight ahead
  let n = -1;
  for (let i = 0; i < sim.net.nodes.end && n < 0; i++) if (sim.net.nodes.alive[i] && nc.deg[i] === 4 && Math.abs(nc.x[i]) < 100 && Math.abs(nc.z[i]) < 100) n = i;
  assert.ok(n >= 0, 'an inner junction');
  const segs = sim.net.segsOf(n, []);
  const dir = (s: number) => { const o = sc.a[s] === n ? sc.b[s] : sc.a[s]; return [nc.x[o] - nc.x[n], nc.z[o] - nc.z[n]]; };
  const A = segs[0], [ax, az] = dir(A);
  const B = segs.find((s) => { const [bx, bz] = dir(s); return bx * ax + bz * az < -0.5 * Math.hypot(ax, az) * Math.hypot(bx, bz); })!;
  const far = sc.a[B] === n ? sc.b[B] : sc.a[B];
  const router = new Router(sim);
  const path = new Int32Array(64);
  // straight on is the obvious route
  let len = router.route(n, far, path, 0, 64, false, A);
  assert.deepEqual([...path.subarray(0, len)], [n, far], 'straight on before the ban');
  // the player bans that movement
  w.roads.setJunction(n, { ctl: 0, bans: [A, B] });
  mirror(sim, ops.splice(0)); sim.rebuild();
  len = router.route(n, far, path, 0, 64, false, A);
  assert.ok(len >= 2 && path[len - 1] === far, 'still reachable another way');
  assert.equal(illegalTurn(sim, A, path, len), null, `route ${[...path.subarray(0, len)]}`);
  // hand-made connectors: the lanes of A at n may only turn into one other arm
  const C = segs.find((s) => s !== A && s !== B)!;
  w.roads.setJunction(n, { ctl: 0, lanes: [[A, 0, [C]], [A, 1, [C]]] });
  mirror(sim, ops.splice(0)); sim.rebuild();
  len = router.route(n, far, path, 0, 64, false, A);
  assert.ok(len >= 2 && path[len - 1] === far, 'still reachable another way');
  assert.equal(illegalTurn(sim, A, path, len), null, `route ${[...path.subarray(0, len)]}`);
});

test('C9: the page sending the same bus lines again (after any road edit or zone dab) keeps the buses, their riders and who is waiting', () => {
  const { sim } = gridCity(4, 120);
  const tr = traffic(sim);
  tr.density = 0;
  const spec = [{ id: 1, color: 3, buses: 3, stops: [-120, -189, 189, 0, 0, 189] }];
  tr.setLines(spec);
  for (let i = 0; i < 20 * 240; i++) { tr.step(0.05); if (i % 10 === 0) tr.checkWindow(); }
  const T = inner(tr), c = tr.veh.cols;
  const buses = [...T.busSets[0] as Set<number>].filter((v) => !c.dying[v]);
  const riders = buses.map((v) => [...(T.riders.get(v) ?? [])].reduce((a: number, b: number) => a + b, 0));
  // background demand accrues lazily (at each visit): waiting now = waiting + arrivals since the last visit
  const waitingNow = () => tr.lines[0].waiting.map((w, i) => Math.min(120, w + (tr.time - tr.lines[0].lastT[i]) / 9));
  const waiting = waitingNow();
  assert.equal(buses.length, 3);
  assert.ok(waiting.some((w) => w > 1), 'people waiting at the stops');
  tr.setLines(spec.map((l) => ({ ...l, stops: [...l.stops] })));
  for (const v of buses) {
    assert.ok(tr.veh.alive[v] && !c.dying[v] && c.line[v] === 0 && T.busSets[0].has(v), `bus ${v} was removed by the resend`);
  }
  const after = buses.map((v) => [...(T.riders.get(v) ?? [])].reduce((a: number, b: number) => a + b, 0));
  assert.deepEqual(after.map(Math.round), riders.map(Math.round), 'riders kept');
  waitingNow().forEach((w, i) => assert.ok(w >= waiting[i] - 1e-6, `stop ${i}: ${waiting[i].toFixed(1)} waiting before, ${w.toFixed(1)} after`));
  // the player removes the middle stop: the same buses go on, with every rider, on the shorter line
  const total = buses.reduce((a, v) => a + [...(T.riders.get(v) ?? [])].reduce((x: number, y: number) => x + y, 0), 0);
  tr.setLines([{ ...spec[0], stops: [-120, -189, 0, 189] }]);
  for (const v of buses) assert.ok(tr.veh.alive[v] && !c.dying[v] && T.busSets[0].has(v) && c.stopI[v] < tr.lines[0].stopLane.length, `bus ${v} after removing a stop`);
  const total2 = buses.reduce((a, v) => a + [...(T.riders.get(v) ?? [])].reduce((x: number, y: number) => x + y, 0), 0);
  assert.ok(Math.abs(total2 - total) < 1e-6, `riders ${total} before, ${total2} after`);
});

test('C11: at a quiet traffic light (no cars, at night) pedestrians still get to cross', async () => {
  const { Peds } = await import('../src/sim/peds.ts');
  const { sim } = gridCity(4, 120);
  const tr = traffic(sim);
  tr.density = 0; // nobody driving: no vehicle ever asks the light to change
  const peds = new Peds(sim);
  peds.density = 1 / 3;
  // wired as in the worker
  const P = inner(peds), T = inner(tr);
  if ('carsGo' in P && 'carsGo' in T) P.carsGo = (n: number, a: number) => T.carsGo(n, a);
  if ('walkOk' in P && 'walkOk' in T) P.walkOk = (n: number, a: number) => T.walkOk(n, a);
  if ('onWait' in P && 'pedCall' in T) P.onWait = (n: number, a: number) => T.pedCall(n, a);
  tr.pedCrossing = (n) => peds.crossing(n);
  let signals = 0;
  for (let n = 0; n < sim.net.nodes.end; n++) if (sim.net.nodes.alive[n] && sim.nodePhases[n] > 0) signals++;
  assert.ok(signals >= 1, 'the grid has a traffic light');
  const waited = new Float64Array(1 << 16);
  let worst = 0, waits = 0;
  for (let i = 0; i < 20 * 300; i++) {
    tr.step(0.05); peds.step(0.05);
    if (i % 10 === 0) { tr.checkWindow(); peds.checkWindow(); }
    const c = peds.t.cols;
    for (let p = 0; p < peds.t.end; p++) {
      if (peds.t.alive[p] && c.mode[p] === 2) { if (waited[p] === 0) waits++; waited[p] += 0.05; worst = Math.max(worst, waited[p]); } else waited[p] = 0;
    }
  }
  assert.ok(waits > 5, `pedestrians waited at the light ${waits} times`);
  assert.ok(worst < 90, `a pedestrian waited ${worst.toFixed(0)} s at a light with no cars`);
});

test('C6: a traffic light far from the camera is not frozen and open: far vehicles stop at its red, far pedestrians wait for it', async () => {
  const { laneId } = await import('../src/sim/lanes.ts');
  const { sim } = gridCity(4, 120);
  const tr = traffic(sim, 6000, 6000); // the camera far away: every vehicle here runs in the far model
  tr.density = 0;
  let n = -1;
  for (let i = 0; i < sim.net.nodes.end && n < 0; i++) if (sim.net.nodes.alive[i] && sim.nodePhases[i] > 0) n = i;
  assert.ok(n >= 0, 'a traffic light');
  const sc = sim.net.segs.cols, k = sim.conns.cols, deg = sim.net.nodes.cols.deg[n];
  // run a while: a light that runs changes state
  const states = new Set<number>();
  for (let i = 0; i < 20 * 120; i++) { tr.step(0.05); states.add(tr.sig.state(n)); }
  assert.ok(states.size >= 4, `the far light went through ${states.size} states in 2 min`);
  // an arm that is red right now, and a car arriving by it at the end of its lane
  const st = tr.sig.state(n), green = (st & 3) === 0 ? tr.sig.arms[n * 8 + (st >> 2)] : 0;
  let arm = -1;
  for (let a = 0; a < deg && arm < 0; a++) if (!(green & (1 << a))) arm = a;
  const seg = sim.armSeg[n * 8 + arm], lane = laneId(seg, sc.b[seg] === n ? 1 : -1, 0);
  let conn = sim.laneConn[lane];
  while (conn >= 0 && k.turn[conn] === 3) conn = k.nextFromLane[conn];
  assert.ok(conn >= 0, 'a way through the node');
  const v = place(tr, lane, sim.laneLen(lane), k.to[conn], false);
  inner(tr).mesoAdvance(v);
  assert.equal(tr.veh.cols.lane[v], lane, 'a far car went through a red light');
  // a pedestrian at the crossing of an arm whose cars have green waits
  if (green) {
    let ga = 0; while (!(green & (1 << ga))) ga++;
    assert.equal(tr.walkOk(n, ga), false, 'a far pedestrian may cross in front of a green');
  }
});

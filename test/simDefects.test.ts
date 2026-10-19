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

test('C1: looking at a traffic jam does not cut the traffic of the whole city (the fleet governor reads the city, not the camera)', () => {
  const run = (camX: number) => {
    const { sim } = gridCity(6, 100);
    const tr = traffic(sim, camX, 0);
    tr.density = 1 / 9; tr.hour = 8; // more than the grid carries
    for (let i = 0; i < 20 * 480; i++) { tr.step(0.05); if (i % 10 === 0) tr.checkWindow(); }
    return { gov: tr.gov, fleet: tr.count };
  };
  const on = run(0), off = run(8000);
  // the governor sees a jam where the camera is not (before: nothing in the camera window, no cut at all)
  assert.ok(off.gov < 0.98, `a jam away from the camera left the fleet share at ${off.gov.toFixed(2)}`);
  // and looking at it changes the share only as much as the near and far models differ
  assert.ok(Math.abs(on.gov - off.gov) <= 0.2, `fleet share ${on.gov.toFixed(2)} with the camera on the jam, ${off.gov.toFixed(2)} away`);
});

test('C4: trucks do not head for the warehouse docks near the camera more than for anywhere else', () => {
  const { sim } = gridCity(6, 100);
  const tr = traffic(sim);
  tr.density = 1 / 30;
  // three docks near the camera (as the page sends them): their nearest nodes become dock nodes
  const nc = sim.net.nodes.cols, docks: number[] = [];
  for (let n = 0; n < sim.net.nodes.end && docks.length < 9; n++) if (sim.net.nodes.alive[n] && nc.deg[n] >= 3 && Math.hypot(nc.x[n], nc.z[n]) < 160) docks.push(nc.x[n] + 5, nc.z[n] + 5, 0);
  tr.setDocks(new Float32Array(docks));
  const dockNodes = new Set<number>();
  for (let k = 0; k < docks.length; k += 3) dockNodes.add(sim.net.nearestNode(docks[k], docks[k + 1], 80));
  let alive = 0;
  for (let n = 0; n < sim.net.nodes.end; n++) if (sim.net.nodes.alive[n] && nc.deg[n] > 0) alive++;
  const seen = new Set<number>();
  let trucks = 0, toDock = 0;
  for (let i = 0; i < 20 * 300; i++) {
    tr.step(0.05);
    if (i % 10 === 0) tr.checkWindow();
    const c = tr.veh.cols;
    for (let v = 0; v < tr.veh.end; v++) {
      if (!tr.veh.alive[v] || c.kind[v] !== 2 || seen.has(v * 100000 + c.dest[v])) continue;
      seen.add(v * 100000 + c.dest[v]);
      trucks++; if (dockNodes.has(c.dest[v])) toDock++;
    }
  }
  const share = dockNodes.size / alive;
  assert.ok(trucks > 30, `trucks ${trucks}`);
  assert.ok(toDock / trucks < Math.max(0.2, share * 3), `${(100 * toDock / trucks).toFixed(0)}% of the trucks went to the ${dockNodes.size} dock nodes near the camera (${(100 * share).toFixed(0)}% of the nodes)`);
});

test('C5: pedestrians are not born around the camera (doors only change where someone near the camera steps out)', async () => {
  const { Peds } = await import('../src/sim/peds.ts');
  const { sim } = gridCity(10, 100);
  const peds = new Peds(sim);
  peds.density = 1 / 4;
  const cx = -400, cz = -400, R = 250;
  // the page sends the doors of the buildings around the camera
  const doors: number[] = [];
  for (let i = 0; i < 2000; i++) { const a = i * 2.39996, r = 20 + (i % 97) * 4; doors.push(cx + Math.cos(a) * r, cz + Math.sin(a) * r); }
  const P = inner(peds);
  if (typeof P.setDoors === 'function') P.setDoors(new Float32Array(doors)); else P.doors = new Float32Array(doors);
  peds.camX = cx; peds.camZ = cz;
  const nc = sim.net.nodes.cols;
  let nodes = 0, near = 0;
  for (let n = 0; n < sim.net.nodes.end; n++) if (sim.net.nodes.alive[n] && nc.deg[n] > 0) { nodes++; if (Math.hypot(nc.x[n] - cx, nc.z[n] - cz) < R) near++; }
  for (let i = 0; i < 20 * 2; i++) peds.step(0.05); // where they were born (2 s: nobody has walked far)
  let all = 0, close = 0;
  for (let p = 0; p < peds.t.end; p++) {
    if (!peds.t.alive[p]) continue;
    const q = P.posNow(p);
    all++; if (Math.hypot(q[0] - cx, q[2] - cz) < R) close++;
  }
  const share = near / nodes;
  assert.ok(all > 200, `pedestrians ${all}`);
  assert.ok(close / all < share * 1.5 + 0.03, `${(100 * close / all).toFixed(0)}% of the pedestrians within ${R} m of the camera, where ${(100 * share).toFixed(0)}% of the nodes are`);
});

test('C15: trips that end without reaching their destination are counted as lost, never as arrivals', async () => {
  const { recordOps, mirror, syncNet } = await import('./simCity.ts');
  const { laneSeg } = await import('../src/sim/lanes.ts');
  const { w, sim } = gridCity(4, 120);
  const ops = recordOps(w);
  const tr = traffic(sim);
  tr.density = 1 / 20;
  for (let i = 0; i < 20 * 60; i++) { tr.step(0.05); if (i % 10 === 0) tr.checkWindow(); }
  // the segment with most vehicles on it (near the camera: in the lists) is demolished
  const c = tr.veh.cols, on = new Map<number, number>();
  for (let i = 0; i < tr.microN; i++) { const v = tr.micro[i]; if (c.conn[v] < 0 && c.lane[v] >= 0 && !c.dying[v] && c.line[v] < 0) on.set(laneSeg(c.lane[v]), (on.get(laneSeg(c.lane[v])) ?? 0) + 1); }
  const [seg, cars] = [...on].sort((a, b) => b[1] - a[1])[0];
  assert.ok(cars >= 2, `cars on the busiest segment: ${cars}`);
  const arrived = tr.arrived, lost = tr.lost;
  w.roads.removeSeg(seg);
  mirror(sim, ops.splice(0));
  syncNet(sim, tr);
  assert.equal(tr.arrived, arrived, 'removed cars were counted as arrivals');
  assert.ok(tr.lost - lost >= cars, `${cars} cars removed with the road, lost went from ${lost} to ${tr.lost}`);
});

/** Vehicles whose lane is on segment `seg`, and those of them in the far model. */
function onSeg(tr: Traffic, seg: number): { all: number[]; far: number[] } {
  const c = tr.veh.cols, all: number[] = [], far: number[] = [];
  for (let v = 0; v < tr.veh.end; v++) if (tr.veh.alive[v] && c.conn[v] < 0 && c.lane[v] >= 0 && (c.lane[v] >> 4) === seg) { all.push(v); if (!c.micro[v]) far.push(v); }
  return { all, far };
}

/** The segment with the most vehicles on it. */
function busiest(tr: Traffic): number {
  const c = tr.veh.cols, n = new Map<number, number>();
  for (let v = 0; v < tr.veh.end; v++) if (tr.veh.alive[v] && c.lane[v] >= 0 && c.conn[v] < 0 && c.line[v] < 0) n.set(c.lane[v] >> 4, (n.get(c.lane[v] >> 4) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0][0];
}

test('C16: a new road that reuses a demolished one\'s id does not inherit its far vehicles nor lose its count', async () => {
  const { recordOps, mirror, syncNet } = await import('./simCity.ts');
  const { w, sim } = gridCity(4, 120);
  const ops = recordOps(w);
  const tr = traffic(sim, 8000, 8000); // all in the far model
  tr.density = 1 / 15;
  for (let i = 0; i < 20 * 90; i++) tr.step(0.05);
  const seg = busiest(tr), before = onSeg(tr, seg).far.length;
  assert.ok(before >= 2, `far vehicles on the busiest segment: ${before}`);
  const rec = w.roads.segRec(seg), lost = tr.lost;
  // demolished and rebuilt in the same frame: the new segment takes the freed id
  w.roads.removeSeg(seg);
  const again = w.roads.addSeg({ a: rec.a, b: rec.b, cx: rec.cx, cz: rec.cz, profile: rec.profile, flags: rec.flags, zl: rec.zl, zr: rec.zr });
  assert.equal(again, seg, 'the id is reused');
  mirror(sim, ops.splice(0));
  syncNet(sim, tr);
  assert.equal(onSeg(tr, seg).all.length, 0, 'vehicles of the demolished road are on the new one');
  for (let k = 0; k < 16; k++) assert.equal(tr.laneCount[seg * 16 + k], 0, `lane ${k} of the new road starts with a count`);
  assert.ok(tr.lost - lost >= before, `lost went from ${lost} to ${tr.lost} with ${before} vehicles demolished`);
  // and the new road's count is right after traffic uses it a while (nobody leaving it subtracts what they never added)
  for (let i = 0; i < 20 * 60; i++) tr.step(0.05);
  for (let k = 0; k < 16; k++) {
    const l = seg * 16 + k, c = tr.veh.cols;
    let n = 0;
    for (let v = 0; v < tr.veh.end; v++) if (tr.veh.alive[v] && c.lane[v] === l && c.dying[v] !== 2) n++;
    assert.equal(tr.laneCount[l], n, `lane ${k}: count ${tr.laneCount[l]}, vehicles ${n}`);
  }
});

test('C17: upgrading a road keeps the vehicles that are on it', async () => {
  const { recordOps, mirror, syncNet } = await import('./simCity.ts');
  const { laneCount } = await import('../src/sim/lanes.ts');
  for (const camX of [0, 8000]) {
    const { w, sim } = gridCity(4, 120);
    const ops = recordOps(w);
    const tr = traffic(sim, camX, 0);
    tr.density = 1 / 15;
    for (let i = 0; i < 20 * 90; i++) { tr.step(0.05); if (i % 10 === 0) tr.checkWindow(); }
    const seg = busiest(tr), cars = onSeg(tr, seg).all.filter((v) => !tr.veh.cols.dying[v]);
    assert.ok(cars.length >= 2, `vehicles on the busiest segment: ${cars.length}`);
    const to = sim.net.segs.cols.profile[seg] === 3 ? 0 : 3;
    w.roads.setProfile(seg, to);
    mirror(sim, ops.splice(0));
    syncNet(sim, tr);
    const c = tr.veh.cols;
    for (const v of cars) {
      assert.ok(tr.veh.alive[v] && !c.dying[v], `vehicle ${v} disappeared with the upgrade (camera ${camX ? 'away' : 'near'})`);
      const l = c.conn[v] >= 0 ? sim.conns.cols.to[c.conn[v]] : c.lane[v];
      assert.ok((l & 7) < laneCount(to, (l & 8) ? -1 : 1), `vehicle ${v} on lane ${l & 7} of ${laneCount(to, (l & 8) ? -1 : 1)}`);
    }
  }
});

test('C2: far from the camera a full lane never takes more vehicles than physically fit, however long they wait', () => {
  const { sim } = gridCity(4, 120);
  const tr = traffic(sim, 8000, 8000);
  tr.density = 0;
  const k = sim.conns.cols, conn = someConn(sim);
  const from = k.from[conn], to = k.to[conn];
  // the next lane holds as many cars as fit bumper to bumper (4.4 m cars, 2.2 m apart)
  const full = Math.floor(sim.laneLen(to) / 6.6);
  inner(tr).setLaneCount(to, full);
  const v = place(tr, from, sim.laneLen(from), to, false);
  let most = full;
  for (let i = 0; i < 20 * 180; i++) { tr.step(0.05); most = Math.max(most, tr.laneCount[to]); }
  assert.ok(most <= full, `the full lane went from ${full} to ${most} vehicles (${sim.laneLen(to).toFixed(0)} m)`);
  assert.ok(tr.veh.alive[v] || tr.lost === 0, 'the car waits (or takes a detour), it is never dropped');
});

test('C3: far from the camera a car whose turn was banned on the way finds another route instead of turning anyway', async () => {
  const { recordOps, mirror, syncNet } = await import('./simCity.ts');
  const { w, sim } = gridCity(4, 120);
  const ops = recordOps(w);
  const tr = traffic(sim, 8000, 8000);
  tr.density = 0;
  const k = sim.conns.cols, conn = someConn(sim);
  const from = k.from[conn], to = k.to[conn], node = k.node[conn];
  // a destination well past the turn, so there is somewhere to go another way
  const v = place(tr, from, sim.laneLen(from), to, false);
  const c = tr.veh.cols, nc = sim.net.nodes.cols;
  let dest = -1;
  for (let n = 0; n < sim.net.nodes.end; n++) if (sim.net.nodes.alive[n] && nc.deg[n] >= 3 && Math.hypot(nc.x[n] - nc.x[node], nc.z[n] - nc.z[node]) > 200) { dest = n; break; }
  c.dest[v] = dest;
  inner(tr).replanFrom(v, node);
  // the route turns somewhere at the node: the player bans exactly that movement
  const nextSeg = inner(tr).nextSeg(v), inSeg = from >> 4;
  w.roads.setJunction(node, { ctl: 0, bans: [inSeg, nextSeg] });
  mirror(sim, ops.splice(0)); syncNet(sim, tr);
  for (let i = 0; i < 20 * 10 && tr.veh.alive[v] && c.lane[v] === from; i++) tr.step(0.05);
  assert.ok(tr.veh.alive[v], `the car disappeared (lost ${tr.lost})`);
  assert.notEqual(c.lane[v] >> 4, nextSeg, 'the car went through the banned turn');
  assert.ok(c.lane[v] !== from, 'the car never moved on');
  assert.ok(sim.turnOk(node, inSeg, c.lane[v] >> 4, false), 'the movement it made exists');
});

test('C20: pedestrians look as many ways as their appearance ids, not 16, and are not all in step', async () => {
  const { pickLook } = await import('../src/render/people/looks.ts');
  // 32 cooked variations (as the real file), all adults
  const meta = { variations: Array.from({ length: 32 }, () => ({ band: 'adult', height: 1.75 })) } as unknown as import('../src/render/people/format.ts').CookedPeople;
  const variations = new Set<number>(), phases = new Set<number>();
  const out = { variation: 0, clip: 0, rate: 1, phase: 0, hash: 0 };
  // the same kind and colour (what the old pose field carried), different appearance ids (pose index 10)
  for (let look = 0; look < 400; look++) {
    const l = (pickLook as (...a: unknown[]) => typeof out)(3 * 256 + 5, 1.3, false, 0, meta, out, look * 163);
    variations.add(l.variation); phases.add(Math.round(l.phase * 64));
  }
  assert.ok(variations.size >= 24, `${variations.size} different bodies for 400 appearance ids`);
  assert.ok(phases.size >= 32, `${phases.size} different walking phases for 400 people`);
});

test('C27: the motorbike rider keeps the same body when the bike brakes or signals', async () => {
  const { riderHash } = await import('../src/render/people/looks.ts') as unknown as { riderHash?: (info: number, id: number, seat: number) => number };
  assert.ok(typeof riderHash === 'function', 'the rider look comes from a function of the vehicle alone');
  const base = 0 * 256 + 3 + (5 << 4);
  const plain = riderHash(base, 77, 0);
  for (const lights of [1, 2, 4, 3, 5]) assert.equal(riderHash(base + lights * 65536, 77, 0), plain, `lights ${lights} changed the rider`);
});

test('C21: where pedestrians walk to is not drawn with a bias to the south', async () => {
  const { Peds } = await import('../src/sim/peds.ts');
  const { sim } = gridCity(25, 60, -1); // dense: more nodes within a walk than the old candidate list held
  const peds = new Peds(sim);
  peds.density = 1 / 20;
  for (let i = 0; i < 20 * 3; i++) peds.step(0.05);
  const P = inner(peds), nc = sim.net.nodes.cols, c = peds.t.cols;
  let n = 0, dz = 0, dx = 0;
  for (let p = 0; p < peds.t.end; p++) {
    if (!peds.t.alive[p] || c.bike[p]) continue;
    const a = P.routes[p * 32], b = P.routes[p * 32 + c.rLen[p] - 1];
    dz += nc.z[b] - nc.z[a]; dx += nc.x[b] - nc.x[a]; n++;
  }
  assert.ok(n > 300, `walkers ${n}`);
  assert.ok(Math.abs(dz / n) < 60 && Math.abs(dx / n) < 60, `mean trip offset x ${(dx / n).toFixed(0)} m, z ${(dz / n).toFixed(0)} m`);
});

test('C48: the number of pedestrians follows the demand, not a fixed ceiling of 100,000', async () => {
  const { Peds } = await import('../src/sim/peds.ts');
  const { sim } = gridCity(10, 100, -1);
  const peds = new Peds(sim);
  peds.density = 4; // a city whose demand is ~140,000 people
  const want = Math.floor(sim.laneMeters * peds.density);
  assert.ok(want > 120000, `demand ${want}`);
  for (let i = 0; i < 20 * 300 && peds.count <= 110000; i++) peds.step(0.05);
  assert.ok(peds.count > 110000, `${peds.count} pedestrians for a demand of ${want}`);
});

test('C50: drawing the people waiting at stops looks only at the stops near the camera', () => {
  const { sim } = gridCity(4, 120);
  const tr = traffic(sim, 8000, 8000);
  tr.density = 0;
  const lines = [];
  for (let i = 0; i < 40; i++) lines.push({ id: i + 1, color: i % 16, buses: 0, stops: [-120, -189, 189, 0, 0, 189] });
  tr.setLines(lines);
  let reads = 0;
  for (const ln of tr.lines) {
    for (const key of ['stopX', 'stopZ'] as const) {
      ln[key] = new Proxy(ln[key], { get(t, p, r) { if (typeof p === 'string' && /^\d+$/.test(p)) reads++; return Reflect.get(t, p, r); } });
    }
  }
  const out = new Float32Array(11 * 1000);
  for (let i = 0; i < 20; i++) tr.writeStopPeople(out, 11, 0, 1000);
  assert.equal(reads, 0, `${reads} stop reads in 20 steps with every stop 8 km from the camera`);
  // near the camera they are drawn
  tr.camX = 0; tr.camZ = 0;
  for (const ln of tr.lines) ln.lastT.fill(-1000); // people have been arriving for a while
  assert.ok(tr.writeStopPeople(out, 11, 0, 1000) > 0, 'nobody drawn at the stops near the camera');
});

test('C22: the HUD speed and stopped count and the road inspector cover the whole city, not the camera window', () => {
  const { sim } = gridCity(6, 100);
  const tr = traffic(sim, 8000, 8000); // nothing near the camera
  tr.density = 1 / 9; tr.hour = 8; // a jam
  for (let i = 0; i < 20 * 300; i++) tr.step(0.05);
  const speed = tr.avgSpeed();
  assert.ok(speed > 0.5 && speed < 12, `city speed ${(speed * 3.6).toFixed(1)} km/h in a jam away from the camera`);
  assert.ok(tr.stopped > 50, `${tr.stopped} stopped in a jam of ${tr.count} vehicles away from the camera`);
  // the inspector on the fullest segment shows its queue and a slow speed
  let seg = -1, most = -1;
  for (let s = 0; s < sim.net.segs.end; s++) if (sim.net.segs.alive[s] && tr.segLoad[s * 2] + tr.segLoad[s * 2 + 1] > most) { most = tr.segLoad[s * 2] + tr.segLoad[s * 2 + 1]; seg = s; }
  const p = tr.probe(seg);
  assert.ok(p.queue > 0, `inspector: ${p.vehicles} vehicles, queue ${p.queue}`);
  assert.ok(p.speed < 0.6 * 50 / 3.6, `inspector: ${(p.speed * 3.6).toFixed(0)} km/h on a jammed street`);
});

test('C19: a pedestrian coming back near the camera starts from where it is, not from where it was last drawn', async () => {
  const { Peds } = await import('../src/sim/peds.ts');
  const { sim } = gridCity(10, 100, -1);
  const peds = new Peds(sim);
  peds.density = 1 / 6;
  for (let i = 0; i < 20 * 10; i++) peds.step(0.05);
  const out = new Float32Array(11 * 50000);
  peds.camX = -400; peds.camZ = -400; peds.checkWindow();
  peds.writePoses(out, 11, 0, 50000);
  // the camera goes away for two minutes and comes back
  peds.camX = 5000; peds.camZ = 5000; peds.checkWindow();
  for (let i = 0; i < 20 * 120; i++) { peds.step(0.05); peds.writePoses(out, 11, 0, 50000); }
  peds.camX = -400; peds.camZ = -400; peds.checkWindow();
  const n = peds.writePoses(out, 11, 0, 50000);
  let worst = 0;
  for (let i = 0; i < n; i++) worst = Math.max(worst, Math.hypot(out[i * 11 + 4] - out[i * 11], out[i * 11 + 6] - out[i * 11 + 2]));
  assert.ok(n > 50, `pedestrians drawn ${n}`);
  assert.ok(worst < 2, `a pedestrian drawn moving ${worst.toFixed(0)} m in one step after the camera came back`);
});

test('C18: a car pulling up at the kerb stops behind the car ahead, not inside it', () => {
  const { sim } = gridCity(4, 120);
  const tr = traffic(sim);
  tr.density = 0;
  const k = sim.conns.cols, conn = someConn(sim), lane = k.from[conn];
  // a stopped car, and right behind it a car at 12 m/s that starts its kerb stop (4 m of gap)
  const ahead = place(tr, lane, 30, k.to[conn], true);
  const c = tr.veh.cols;
  c.v[ahead] = 0; c.dying[ahead] = 3; // held in place (as a car parking)
  const v = place(tr, lane, 30 - 4.4 - 4, k.to[conn], true);
  c.v[v] = 12; c.dying[v] = 4; c.dwell[v] = 0;
  let worst = 99;
  for (let i = 0; i < 20 * 5; i++) { tr.step(0.05); worst = Math.min(worst, c.s[ahead] - c.len[ahead] - c.s[v]); }
  assert.ok(worst > 0, `the car at the kerb ran ${(-worst).toFixed(1)} m into the car ahead`);
});

test('C10: a car that changed lanes just before a junction is drawn going on smoothly into it, without a jump', async () => {
  const { laneCount, laneId } = await import('../src/sim/lanes.ts');
  const { sim } = gridCity(4, 120);
  const tr = traffic(sim);
  tr.density = 0;
  const k = sim.conns.cols, sc = sim.net.segs.cols;
  let conn = -1;
  for (let x = 0; x < sim.conns.end && conn < 0; x++) {
    if (!sim.conns.alive[x] || k.turn[x] !== 1) continue;
    const f = k.from[x], seg = f >> 4, dir = (f & 8) ? -1 : 1;
    if ((f & 7) === 0 && laneCount(sc.profile[seg], dir) >= 2 && sim.laneLen(f) > 30) conn = x;
  }
  assert.ok(conn >= 0, 'a two-lane approach');
  const lane = k.from[conn], other = laneId(lane >> 4, (lane & 8) ? -1 : 1, 1);
  const v = place(tr, lane, sim.laneLen(lane) - 6, k.to[conn], true);
  const c = tr.veh.cols;
  c.v[v] = 10; c.lcFrom[v] = other; c.lcT[v] = 0.3; // half-way through a lane change from the other lane
  const out = new Float32Array(11 * 64);
  let worst = 0, last: number[] | null = null;
  for (let i = 0; i < 30; i++) {
    tr.step(0.05);
    const n = tr.writePoses(out, 11);
    let o = -1;
    for (let j = 0; j < n; j++) if (out[j * 11 + 10] === (v & 0xffff)) o = j * 11;
    if (o < 0) break;
    if (last) worst = Math.max(worst, Math.hypot(out[o + 4] - last[0], out[o + 6] - last[1]));
    last = [out[o + 4], out[o + 6]];
  }
  assert.ok(worst < 1.2, `the car was drawn jumping ${worst.toFixed(2)} m in one step (driving 0.5 m a step)`);
});

test('C31: a car dropping someone off ends its trip (counted) and starts another, near the camera and far from it alike', () => {
  const share = (camX: number) => {
    const { sim } = gridCity(4, 120);
    const tr = traffic(sim, camX, 0);
    tr.density = 1 / 25;
    for (let i = 0; i < 20 * 240; i++) { tr.step(0.05); if (i % 10 === 0) tr.checkWindow(); }
    // trips that ended (arrivals) against vehicles that left: a drop-off ends a trip without the car leaving
    return { arrived: tr.arrived, kerb: tr.kerbStops };
  };
  const near = share(0), far = share(8000);
  assert.ok(near.kerb > 5, `drop-offs near the camera: ${near.kerb}`);
  assert.ok(far.kerb > 5, `drop-offs far from the camera: ${far.kerb} (before: only near the camera)`);
  assert.ok(near.kerb <= near.arrived, `near: ${near.kerb} drop-offs but ${near.arrived} trips ended`);
});

test('C32: level crossing barriers close for trains far from the camera too, and far cars wait at them', async () => {
  const { World } = await import('../src/world/world.ts');
  const { planRoad, buildRoad, snap } = await import('../src/roads/build.ts');
  const { PROFILES } = await import('../src/roads/profiles.ts');
  const { SimNet, laneId } = await import('../src/sim/lanes.ts');
  const { Ctl } = await import('../src/roads/control.ts');
  const { recordOps, mirror } = await import('./simCity.ts');
  const railId = PROFILES.findIndex((p) => p.name === 'Ferrovia dupla');
  const w = new World();
  w.heights.fill(10); w.tileMin.fill(10); w.tileMax.fill(10); w.unlimited = true;
  const ops = recordOps(w);
  const build = (ax: number, az: number, bx: number, bz: number, prof: number) => {
    const a = snap(w.roads, ax, az, 8), b = snap(w.roads, bx, bz, 8);
    buildRoad(w, planRoad(w, a, null, b, prof, 0), a, b, prof);
  };
  build(-600, 0, 600, 0, railId); build(0, -400, 0, 400, 0);
  const sim = new SimNet(); mirror(sim, ops); sim.rebuild(); sim.removedSegs.length = 0;
  const tr = traffic(sim, 8000, 8000);
  tr.density = 0;
  tr.setLines([{ id: 1, color: 3, buses: 1, stops: [-500, 0, 400, 0], mode: 1 }]);
  let x = -1;
  for (let n = 0; n < sim.net.nodes.end; n++) if (sim.net.nodes.alive[n] && sim.nodeCtl[n] === Ctl.Crossing) x = n;
  assert.ok(x >= 0, 'a level crossing');
  let closed = 0, carWaited = false;
  const sc = sim.net.segs.cols;
  for (let i = 0; i < 20 * 300; i++) {
    tr.step(0.05);
    if (tr.crossingDown(x)) {
      closed++;
      if (closed === 1) {
        // a far car arrives at the crossing on the road while the barrier is down
        const road = sim.net.segsOf(x, []).find((s) => sc.profile[s] === 0)!;
        const lane = laneId(road, sc.b[road] === x ? 1 : -1, 0);
        const T = inner(tr), c = tr.veh.cols, v = tr.veh.alloc();
        T.initVehicle(v); c.len[v] = 4.4;
        const other = sim.net.segsOf(x, []).find((s) => s !== road && sc.profile[s] === 0)!;
        const far = sc.a[other] === x ? sc.b[other] : sc.a[other];
        tr.routes[v * 96] = sim.laneFrom(lane); tr.routes[v * 96 + 1] = x; tr.routes[v * 96 + 2] = far;
        c.rLen[v] = 3; c.rIdx[v] = 1; c.dest[v] = far; c.lane[v] = lane; c.s[v] = sim.laneLen(lane);
        T.setLaneCount(lane, 1);
        T.mesoAdvance(v);
        carWaited = c.lane[v] === lane;
      }
    }
  }
  assert.ok(closed > 0, 'the barrier never closed for a train away from the camera');
  assert.ok(carWaited, 'a far car crossed the rails with the barrier down');
});

test('C42: a car stopped at the kerb when the camera leaves finishes its drop-off instead of vanishing', () => {
  const { sim } = gridCity(4, 120);
  const tr = traffic(sim);
  tr.density = 0;
  const k = sim.conns.cols, conn = someConn(sim), lane = k.from[conn];
  const v = place(tr, lane, 20, k.to[conn], true);
  const c = tr.veh.cols;
  c.v[v] = 0; c.dying[v] = 4; c.dwell[v] = 2; c.served[v] = 1; // passenger getting out
  const arrived = tr.arrived, lost = tr.lost;
  tr.camX = 8000; tr.camZ = 8000; tr.checkWindow();
  for (let i = 0; i < 20 * 5; i++) tr.step(0.05);
  assert.equal(tr.lost, lost, 'counted as a lost trip');
  assert.equal(tr.arrived, arrived + 1, `the drop-off trip was not counted (arrived ${arrived} → ${tr.arrived})`);
  assert.ok(tr.veh.alive[v] && !c.dying[v], 'the car did not drive on to its next trip');
});

test('C34: a car leaving a junction moves once per step, not twice', () => {
  const { sim } = gridCity(4, 120);
  const tr = traffic(sim);
  tr.density = 0;
  const k = sim.conns.cols, conn = someConn(sim);
  // on the connection, 0.1 m from its end, at 10 m/s
  const v = place(tr, k.from[conn], 0, k.to[conn], true);
  const T = inner(tr), c = tr.veh.cols;
  T.unlink(v); c.conn[v] = conn; c.s[v] = k.len[conn] - 0.1; c.v[v] = 10; T.insert(v, true, conn);
  tr.step(0.05);
  assert.equal(c.lane[v], k.to[conn], 'onto the next lane');
  assert.ok(c.s[v] < 0.6, `${(c.s[v] + 0.1).toFixed(2)} m driven in a 0.05 s step at 10 m/s`);
});

test('C35: a car that changes lane in its last step before the junction goes on from the new lane', async () => {
  const { laneCount, laneId } = await import('../src/sim/lanes.ts');
  const { sim } = gridCity(4, 120);
  const tr = traffic(sim);
  tr.density = 0;
  const k = sim.conns.cols, sc = sim.net.segs.cols;
  // a left turn that only the second lane of a two-lane approach makes
  let conn = -1;
  for (let x = 0; x < sim.conns.end && conn < 0; x++) {
    if (!sim.conns.alive[x] || k.turn[x] !== 2) continue;
    const f = k.from[x], seg = f >> 4, dir = (f & 8) ? -1 : 1;
    if ((f & 7) === 1 && laneCount(sc.profile[seg], dir) === 2) {
      const right = laneId(seg, dir, 0);
      let rightToo = false;
      for (let y = sim.laneConn[right]; y >= 0; y = k.nextFromLane[y]) rightToo ||= (k.to[y] >> 4) === (k.to[x] >> 4);
      if (!rightToo) conn = x;
    }
  }
  assert.ok(conn >= 0, 'a left turn from the second lane only');
  const left = k.from[conn], right = laneId(left >> 4, (left & 8) ? -1 : 1, 0);
  const v = place(tr, right, sim.laneLen(right) - 0.2, k.to[conn], true);
  const c = tr.veh.cols, T = inner(tr);
  c.v[v] = 6; c.wait[v] = 6; c.lcCool[v] = 0;
  for (let i = 0; i < 3; i++) {
    tr.step(0.05);
    const where = c.conn[v] >= 0 ? k.from[c.conn[v]] : -1;
    if (c.conn[v] >= 0) assert.equal(where, c.lane[v], `in the junction by a connection of lane ${where & 7} while on lane ${c.lane[v] & 7}`);
    else { let inList = false; for (let u = tr.laneHead[c.lane[v]]; u >= 0; u = c.next[u]) inList ||= u === v; assert.ok(inList, 'not in its lane\'s list'); }
  }
  void T;
});

test('C37: two trucks never back into the same dock, two cars never take the same bay', async () => {
  const { sim } = gridCity(4, 120);
  const tr = traffic(sim);
  tr.density = 0;
  const k = sim.conns.cols, conn = someConn(sim), lane = k.from[conn];
  const T = inner(tr), c = tr.veh.cols, p = new Float64Array(4);
  sim.lanePoint(lane, 20, p);
  tr.setDocks(new Float32Array([p[0] + 12, p[2] + 12, 0]));
  const a = place(tr, lane, 20, k.to[conn], true), b = place(tr, lane, 12, k.to[conn], true);
  c.kind[a] = c.kind[b] = 2; c.len[a] = c.len[b] = 9.5;
  assert.equal(T.tryDock(a, lane), true, 'the first truck docks');
  assert.equal(T.tryDock(b, lane), false, 'a second truck backed into the same dock');
});

test('C38: clearing the simulation (new map, load) leaves nothing of the old city behind', () => {
  const { sim } = gridCity(4, 120);
  const tr = traffic(sim);
  tr.density = 1 / 20;
  tr.setLines([{ id: 1, color: 3, buses: 2, stops: [-120, -189, 189, 0, 0, 189] }]);
  tr.occupancy = new Uint8Array(1 << 16);
  for (let i = 0; i < 20 * 60; i++) tr.step(0.05);
  tr.gov = 0.8; tr.jamShare = 0.4;
  inner(tr).crossingClosed.set(3, tr.time + 100);
  tr.clearAll();
  assert.equal(tr.gov, 1, 'fleet share');
  assert.equal(tr.jamShare, 0, 'jam share');
  assert.equal(inner(tr).crossingClosed.size, 0, 'level crossings still closed');
  assert.equal(tr.lines.length, 0, 'bus lines of the old city');
  assert.ok(tr.occupancy.every((x) => x === 0), 'road occupancy');
  assert.equal(tr.docks.length, 0, 'docks of the old city');
});

test('C40: car trips never start or end at a node that only rails reach', async () => {
  const { World } = await import('../src/world/world.ts');
  const { planRoad, buildRoad, snap } = await import('../src/roads/build.ts');
  const { PROFILES, PROFILE_INFO } = await import('../src/roads/profiles.ts');
  const { SimNet } = await import('../src/sim/lanes.ts');
  const { recordOps, mirror } = await import('./simCity.ts');
  const railId = PROFILES.findIndex((p) => p.name === 'Ferrovia dupla');
  const w = new World();
  w.heights.fill(10); w.tileMin.fill(10); w.tileMax.fill(10); w.unlimited = true;
  const ops = recordOps(w);
  const build = (ax: number, az: number, bx: number, bz: number, prof: number) => {
    const a = snap(w.roads, ax, az, 8), b = snap(w.roads, bx, bz, 8);
    buildRoad(w, planRoad(w, a, null, b, prof, 0), a, b, prof);
  };
  build(-900, 300, 900, 300, railId); build(-900, -100, 900, -100, 0); build(0, -400, 0, 200, 0);
  const sim = new SimNet(); mirror(sim, ops); sim.rebuild(); sim.removedSegs.length = 0;
  const tr = traffic(sim);
  const sc = sim.net.segs.cols, nc = sim.net.nodes.cols;
  const railOnly = (n: number) => { for (const s of sim.net.segsOf(n, [])) if (!PROFILE_INFO[sc.profile[s]].rail) return false; return true; };
  let picks = 0, rail = 0;
  for (let i = 0; i < 2000; i++) { const n = inner(tr).zonedNode([1, 1, 1, 1, 1]); if (n < 0) continue; picks++; if (railOnly(n)) rail++; }
  assert.ok(picks > 1000 && nc.deg.length > 0, `picks ${picks}`);
  assert.equal(rail, 0, `${rail} of ${picks} trip ends at nodes only rails reach`);
});

test('C45: with two segments between the same nodes, a car takes the one it may drive that way', async () => {
  const { SimNet } = await import('../src/sim/lanes.ts');
  const { PROFILES } = await import('../src/roads/profiles.ts');
  const one = PROFILES.findIndex((p) => p.oneWay && !p.name.toLowerCase().includes('ferro'));
  assert.ok(one >= 0, 'a one-way profile');
  const sim = new SimNet();
  sim.apply({ t: 'addNode', rec: { id: 0, x: 0, z: 0, y: 10 } });
  sim.apply({ t: 'addNode', rec: { id: 1, x: 200, z: 0, y: 10 } });
  // first a one-way street from 1 to 0 (curving north), then a one-way from 0 to 1 (curving south)
  sim.apply({ t: 'addSeg', rec: { id: 0, a: 1, b: 0, cx: 100, cz: 60, profile: one, flags: 0, zl: 0, zr: 0 } });
  sim.apply({ t: 'addSeg', rec: { id: 1, a: 0, b: 1, cx: 100, cz: -60, profile: one, flags: 0, zl: 0, zr: 0 } });
  sim.rebuild();
  const tr = traffic(sim);
  assert.equal(inner(tr).segBetween(0, 1), 1, 'from node 0 to node 1 by the street that runs that way');
  assert.equal(inner(tr).segBetween(1, 0), 0, 'and back by the other');
});

test('C25: bus riders walk to the stop itself to board and step off the bus at the stop, not at the junction', async () => {
  const { Peds } = await import('../src/sim/peds.ts');
  const { sim } = gridCity(4, 120);
  const tr = traffic(sim);
  tr.density = 0;
  const peds = new Peds(sim);
  peds.density = 1 / 6; peds.transitShare = 0.6;
  const P = inner(peds);
  peds.pickTrip = () => tr.pickTrip();
  let boarded = 0, boardFar = 0, alighted = 0, alightFar = 0;
  const near = (x: number, z: number) => tr.lines[0].stopX.some((sx, i) => Math.hypot(sx - x, tr.lines[0].stopZ[i] - z) < 4);
  peds.onStop = ((l: number, a: number, b: number, x?: number, z?: number) => { boarded++; if (x === undefined || !near(x, z!)) boardFar++; tr.pedAtStop(l, a, b); }) as typeof peds.onStop;
  tr.onAlight = ((node: number, n: number, x?: number, z?: number) => {
    const before = new Set<number>(); for (let p = 0; p < peds.t.end; p++) if (peds.t.alive[p]) before.add(p);
    if (x !== undefined && typeof P.spawnFromStop === 'function') P.spawnFromStop(x, z, n); else peds.spawnAt(node, n);
    for (let p = 0; p < peds.t.end; p++) if (peds.t.alive[p] && !before.has(p)) { alighted++; const q = P.posNow(p); if (!near(q[0], q[2])) alightFar++; }
  }) as typeof tr.onAlight;
  tr.setLines([{ id: 1, color: 3, buses: 3, stops: [-120, -189, 189, 0, 0, 189] }]);
  for (let i = 0; i < 20 * 600; i++) { tr.step(0.05); peds.step(0.05); if (i % 20 === 0) tr.checkWindow(); }
  assert.ok(boarded > 5 && alighted > 5, `boarded ${boarded}, alighted ${alighted}`);
  assert.equal(boardFar, 0, `${boardFar} of ${boarded} boarded away from the stop`);
  assert.equal(alightFar, 0, `${alightFar} of ${alighted} stepped off away from the stop`);
});

test('C28: following a vehicle keeps to that vehicle when a look-alike passes closer', async () => {
  const mod = await import('../src/render/vehicles.ts') as unknown as { followMatch?: (d: Float32Array, o: number, f: { info: number; id: number }) => boolean };
  assert.ok(typeof mod.followMatch === 'function', 'the followed vehicle is matched by something of its own');
  const d = new Float32Array(22);
  // two silver sedans, same kind and colour: ids 41 and 42
  d[8] = 0 * 256 + 3; d[10] = 41; d[11 + 8] = 0 * 256 + 3 + 65536 /* braking */; d[11 + 10] = 42;
  const fol = { info: 3, id: 42 };
  assert.equal(mod.followMatch(d, 0, fol), false, 'the look-alike matched');
  assert.equal(mod.followMatch(d, 11, fol), true, 'the followed car (braking) did not match');
});

test('C24: the rear wagons of a train stay on the track through a bend', async () => {
  const { SimNet, laneId } = await import('../src/sim/lanes.ts');
  const { PROFILES } = await import('../src/roads/profiles.ts');
  const T = await import('../src/sim/traffic.ts') as unknown as { backAlong?: (sim: SimNet, lane: number, conn: number, s: number, d: number, out: Float64Array) => void };
  const rail = PROFILES.findIndex((p) => p.name === 'Ferrovia dupla');
  const sim = new SimNet();
  sim.apply({ t: 'addNode', rec: { id: 0, x: 0, z: 0, y: 10 } });
  sim.apply({ t: 'addNode', rec: { id: 1, x: 200, z: 0, y: 10 } });
  sim.apply({ t: 'addNode', rec: { id: 2, x: 300, z: 150, y: 10 } });
  sim.apply({ t: 'addSeg', rec: { id: 0, a: 0, b: 1, cx: 100, cz: 0, profile: rail, flags: 0, zl: 0, zr: 0 } });
  sim.apply({ t: 'addSeg', rec: { id: 1, a: 1, b: 2, cx: 250, cz: 75, profile: rail, flags: 0, zl: 0, zr: 0 } });
  sim.rebuild();
  assert.ok(typeof T.backAlong === 'function', 'wagon placement is reachable');
  const front = laneId(1, 1, 0), behind = laneId(0, 1, 0), out = new Float64Array(4), q = new Float64Array(4);
  // the third wagon's middle, 51 m behind a front 5 m past the bend: on the first segment
  T.backAlong(sim, front, -1, 5, 51, out);
  let best = 1e9;
  for (let s = 0; s <= sim.laneLen(behind); s += 0.5) { sim.lanePoint(behind, s, q); best = Math.min(best, Math.hypot(q[0] - out[0], q[2] - out[2])); }
  assert.ok(best < 1, `the wagon is ${best.toFixed(1)} m off the track`);
});

test('C26: a pedestrian whose way ahead was demolished walks round another way; one left with no way fades out', async () => {
  const { Peds } = await import('../src/sim/peds.ts');
  const { recordOps, mirror } = await import('./simCity.ts');
  const { w, sim } = gridCity(6, 100, -1);
  const ops = recordOps(w);
  const peds = new Peds(sim);
  peds.density = 1 / 8;
  for (let i = 0; i < 20 * 20; i++) peds.step(0.05);
  const P = inner(peds), c = peds.t.cols;
  // walkers with at least three segments still ahead: the segment two nodes ahead of each is demolished
  const watch: number[] = [], doomed = new Set<number>();
  for (let p = 0; p < peds.t.end && watch.length < 25; p++) {
    if (!peds.t.alive[p] || c.bike[p] || c.tLine[p] >= 0 || c.mode[p] !== 0 || c.rIdx[p] + 3 >= c.rLen[p]) continue;
    const a = P.routes[p * 32 + c.rIdx[p] + 1], b = P.routes[p * 32 + c.rIdx[p] + 2];
    const s = P.segBetween(a, b);
    if (s < 0 || !w.roads.segs.alive[s]) continue;
    // a few inner streets only (removing many would cut people off from where they go)
    const sc = w.roads.segs.cols;
    if (Math.abs(sc.mx[s]) > 180 || Math.abs(sc.mz[s]) > 180 || (!doomed.has(s) && doomed.size >= 6)) continue;
    doomed.add(s); watch.push(p);
  }
  assert.ok(watch.length >= 8, `walkers watched ${watch.length}`);
  // who disappears before reaching the end of the route
  const gone = new Set<number>(), kill = P.kill.bind(P), alive = new Set(watch);
  P.kill = (p: number) => { if (alive.has(p)) { alive.delete(p); if (c.rIdx[p] + 1 < c.rLen[p]) gone.add(p); } kill(p); };
  for (const s of doomed) w.roads.removeSeg(s);
  mirror(sim, ops.splice(0)); sim.rebuild();
  const out = new Float32Array(11 * 40000);
  let faded = 0;
  for (let i = 0; i < 20 * 60; i++) {
    peds.step(0.05);
    if (i % 5 === 0) { peds.camX = 0; peds.camZ = 0; peds.checkWindow(); const n = peds.writePoses(out, 11, 0, 40000); for (let j = 0; j < n; j++) if (out[j * 11 + 9] < 0.99) faded++; }
  }
  const went = watch.length - gone.size;
  assert.ok(went >= watch.length * 0.6, `${went} of ${watch.length} walkers went round the demolished street (the rest vanished)`);
  assert.ok(faded > 0, 'nobody left on a demolished sidewalk was seen fading out');
});

test('C51: a pedestrian hit by a shot or a blast falls out of sight over a moment instead of vanishing', async () => {
  const { Peds } = await import('../src/sim/peds.ts');
  const { sim } = gridCity(4, 120);
  const peds = new Peds(sim);
  peds.density = 1 / 4;
  for (let i = 0; i < 20 * 10; i++) peds.step(0.05);
  peds.camX = 0; peds.camZ = 0; peds.checkWindow();
  const out = new Float32Array(11 * 20000);
  let n = peds.writePoses(out, 11, 0, 20000);
  assert.ok(n > 10, `drawn ${n}`);
  const x = out[4], z = out[6];
  assert.equal(peds.hit(x, z, 1, true), 1, 'one hit');
  peds.step(0.05);
  n = peds.writePoses(out, 11, 0, 20000);
  let fading = 0;
  for (let i = 0; i < n; i++) if (out[i * 11 + 9] < 1 && Math.hypot(out[i * 11 + 4] - x, out[i * 11 + 6] - z) < 1.5) fading++;
  assert.equal(fading, 1, 'the person hit vanished at once');
});

test('C52: the bicycle wheels roll (marked as wheels for the shader, with spokes that show it)', async () => {
  const mod = await import('../src/render/vehicles.ts') as unknown as { bikeModel?: () => import('three').BufferGeometry };
  assert.ok(typeof mod.bikeModel === 'function', 'the bicycle model can be checked');
  const g = mod.bikeModel(), glow = g.getAttribute('glow').array as Float32Array;
  const parts = new Set<number>();
  for (let i = 0; i < glow.length; i++) if (glow[i] >= 100) parts.add(glow[i]);
  assert.ok(parts.size >= 2, `wheel parts in the bicycle: ${[...parts]}`);
  assert.ok([...parts].some((p) => Math.floor((p - 100) / 2) === 2), 'no spokes: a rolling ring looks still');
});

test('C43: when the crowd fills the people batches, the groups the player placed are still drawn', async () => {
  const THREE = await import('three/webgpu');
  const { PeopleRenderer } = await import('../src/render/people/crowd.ts');
  const pr = new PeopleRenderer(), P = inner(pr);
  const attr = (cap: number) => ({ array: new Float32Array(cap * 4), needsUpdate: false, clearUpdateRanges() {}, addUpdateRange() {} });
  P.attrs = [2048, 8192, 16384].map((cap) => ({ pos: attr(cap), prev: attr(cap), info: attr(cap), anim: attr(cap) }));
  P.geos = [{ instanceCount: 0 }, { instanceCount: 0 }, { instanceCount: 0 }];
  P.meta = { variations: [{ band: 'adult', height: 1.75, sitPelvis: [0.5, 0.1] }] };
  // five people the player placed, 10 m in front of the camera
  P.creator = { size: 5, forEach(_x: number, _z: number, _r: number, _t: number, _dt: number, _vis: unknown, draw: (p: unknown) => void) {
    for (let i = 0; i < 5; i++) draw({ x: i, y: 0, z: 10, yaw: 0, px: i, pz: 10, pyaw: 0, variation: 0, clip: 1, hash: 0xabc000 + i, scale: 1 });
  } };
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 2000);
  cam.position.set(0, 2, 0); cam.lookAt(0, 0, 10); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
  pr.begin(cam);
  // a dense crowd close by: more full-detail people than the batch holds
  const d = new Float32Array(11); d[8] = 3 * 256;
  for (let i = 0; i < 3000; i++) pr.push(d, 0, (i % 50) * 0.5, 0, 4, 0, (i % 50) * 0.5, 0, 4, 0, 4, 50, false);
  pr.end();
  const info = P.attrs[0].info.array as Float32Array;
  let placed = 0;
  for (let i = 0; i < pr.drawn[0]; i++) if ((info[i * 4] & 0xfff000) === 0xabc000) placed++;
  assert.equal(placed, 5, `${placed} of the 5 placed people drawn with a full crowd`);
});

test('C23: changing a junction\'s control keeps the cars inside it where they are', async () => {
  const { recordOps, mirror, syncNet } = await import('./simCity.ts');
  const { w, sim } = gridCity(4, 120);
  const ops = recordOps(w);
  const tr = traffic(sim);
  tr.density = 0;
  const k = sim.conns.cols, conn = someConn(sim), node = k.node[conn];
  // two cars inside the junction, one behind the other
  const T = inner(tr), c = tr.veh.cols, cars: number[] = [];
  for (const s of [k.len[conn] * 0.7, k.len[conn] * 0.7 - 6]) {
    if (s < 0) continue;
    const v = place(tr, k.from[conn], 0, k.to[conn], true);
    T.unlink(v); c.conn[v] = conn; c.s[v] = s; c.v[v] = 0; T.insert(v, true, conn);
    cars.push(v);
  }
  const where = (v: number) => { const p = new Float64Array(4); if (c.conn[v] >= 0) sim.connPoint(c.conn[v], c.s[v], p); else sim.lanePoint(c.lane[v], c.s[v], p); return p; };
  const before = cars.map(where);
  w.roads.setJunction(node, { ctl: 3 }); // stop signs on every arm
  mirror(sim, ops.splice(0)); syncNet(sim, tr);
  cars.forEach((v, i) => {
    const p = where(v);
    assert.ok(Math.hypot(p[0] - before[i][0], p[2] - before[i][2]) < 1, `car ${i} moved ${Math.hypot(p[0] - before[i][0], p[2] - before[i][2]).toFixed(1)} m when the control changed`);
  });
});

test('C33: inside the camera window every vehicle is a drawn one (none stays invisible in the far model)', () => {
  const { sim } = gridCity(4, 120);
  const tr = traffic(sim, 8000, 8000);
  tr.density = 1 / 20;
  for (let i = 0; i < 20 * 60; i++) tr.step(0.05);
  // the camera arrives over the city
  tr.camX = 0; tr.camZ = 0; tr.checkWindow();
  for (let i = 0; i < 20 * 5; i++) { tr.step(0.05); if (i % 10 === 0) tr.checkWindow(); }
  tr.checkWindow(); // (as the worker does every half second)
  const c = tr.veh.cols, T = inner(tr);
  let hidden = 0, all = 0;
  for (let v = 0; v < tr.veh.end; v++) {
    if (!tr.veh.alive[v] || c.lane[v] < 0) continue;
    all++;
    // (one waiting to fit behind a full queue of drawn vehicles stays out of sight until there is room)
    const tail = tr.laneTail[c.lane[v]];
    const room = tail < 0 || c.s[tail] - c.len[tail] - 2 >= c.len[v];
    if (!c.micro[v] && T.inWindow(c.lane[v]) && room) hidden++;
  }
  assert.ok(all > 50, `vehicles ${all}`);
  assert.equal(hidden, 0, `${hidden} of ${all} vehicles inside the window are invisible (far model)`);
});

test('buses reach every stop of their line (the last turn into a stop\'s lane is one the junction makes)', () => {
  const { sim } = gridCity(4, 120);
  const tr = traffic(sim);
  tr.density = 0;
  tr.setLines([{ id: 1, color: 3, buses: 3, stops: [-120, -189, 189, 0, 0, 189] }]);
  const T = inner(tr), c = tr.veh.cols, served = new Map<number, number>(), last = new Map<number, number>();
  for (let i = 0; i < 20 * 900; i++) {
    tr.step(0.05); if (i % 20 === 0) tr.checkWindow();
    for (const v of T.busSets[0] as Set<number>) {
      const was = last.get(v);
      if (was !== undefined && was !== c.stopI[v]) served.set(was, (served.get(was) ?? 0) + 1);
      last.set(v, c.stopI[v]);
    }
  }
  const n = tr.lines[0].stopLane.length;
  for (let s = 0; s < n; s++) assert.ok((served.get(s) ?? 0) >= 2, `stop ${s} served ${served.get(s) ?? 0} times in 15 min (served: ${JSON.stringify([...served])})`);
});

test('C39: bus riders of the background demand do not step off as extra pedestrians; only people who boarded on foot do', () => {
  const { sim } = gridCity(4, 120);
  const tr = traffic(sim);
  tr.density = 0;
  let off = 0;
  tr.onAlight = (_n, count) => { off += count; };
  tr.setLines([{ id: 1, color: 3, buses: 3, stops: [-120, -189, 189, 0, 0, 189] }]);
  for (let i = 0; i < 20 * 600; i++) { tr.step(0.05); if (i % 20 === 0) tr.checkWindow(); }
  assert.ok(tr.lineStats(1)[0].perHour > 0, 'people rode the buses');
  assert.equal(off, 0, `${off} pedestrians stepped off with nobody having boarded on foot`);
  // one person on foot boards at stop 0 for stop 1: exactly one steps off
  tr.pedAtStop(0, 0, 1);
  for (let i = 0; i < 20 * 900 && off === 0; i++) { tr.step(0.05); if (i % 20 === 0) tr.checkWindow(); }
  assert.equal(off, 1, `${off} stepped off for one person who boarded on foot`);
});

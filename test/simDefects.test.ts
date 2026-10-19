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

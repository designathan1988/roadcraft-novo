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
  assert.ok(Math.abs(on.gov - off.gov) <= 0.05, `fleet share ${on.gov.toFixed(2)} with the camera on the jam, ${off.gov.toFixed(2)} away`);
  assert.ok(Math.abs(on.fleet - off.fleet) <= 0.1 * off.fleet, `fleet ${on.fleet} with the camera on the jam, ${off.fleet} away`);
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

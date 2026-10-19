/// <reference types="node" />
// Behaviour ported from roadcraft 4.0's traffic (src/sim of roadcraft-4.0-main), rebuilt as columns of the vehicle table
// in the simulation worker. One test (or a few) per behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SimNet } from '../src/sim/lanes.ts';
import { ROUTE_CAP, type Traffic } from '../src/sim/traffic.ts';
import { gridCity, inner, traffic } from './simCity.ts';

/** A straight run of lanes across the grid's middle: [lane, lane, ...] joined by straight connections. */
export function straightRun(sim: SimNet, min = 3): number[] {
  const k = sim.conns.cols;
  for (let start = 0; start < sim.conns.end; start++) {
    if (!sim.conns.alive[start] || k.turn[start] !== 1) continue;
    const run = [k.from[start]];
    let lane = k.from[start];
    for (let guard = 0; guard < 20; guard++) {
      let next = -1;
      for (let x = sim.laneConn[lane]; x >= 0; x = k.nextFromLane[x]) if (k.turn[x] === 1) { next = k.to[x]; break; }
      if (next < 0) break;
      run.push(next); lane = next;
    }
    if (run.length >= min) return run;
  }
  throw new Error('no straight run');
}

/** A vehicle of class kind/style on `lane` at `s`, driving along `run` (route through the run's end nodes). */
export function placeOn(tr: Traffic, run: number[], i: number, s: number, v: number): number {
  const T = inner(tr), sim = tr.sim, c = tr.veh.cols;
  const id = tr.veh.alloc();
  T.initVehicle(id, 0);
  c.color[id] &= 15; c.len[id] = 4.4; // a sedan
  const o = id * ROUTE_CAP;
  tr.routes[o] = sim.laneFrom(run[i]);
  for (let k = i; k < run.length; k++) tr.routes[o + 1 + k - i] = sim.laneTo(run[k]);
  c.rLen[id] = run.length - i + 1; c.rIdx[id] = 1; c.dest[id] = sim.laneTo(run[run.length - 1]);
  c.lane[id] = run[i]; c.conn[id] = -1; c.s[id] = s; c.v[id] = v;
  T.setLaneCount(run[i], 1); T.addMicro(id); T.insert(id, false, run[i]);
  return id;
}

test('drivers differ: the pushy follow closer, accelerate and brake harder, accept smaller gaps and lose patience sooner than the timid', async () => {
  const { drawDriver, driverSchema } = await import('../src/sim/drivers.ts');
  const cols = Object.fromEntries(Object.entries(driverSchema).map(([k, A]) => [k, new A(2)])) as unknown as Parameters<typeof drawDriver>[0];
  // the extremes: uniforms 0,0 give aggression −1; 1,1 give +1
  const fixed = (u: number) => () => u;
  drawDriver(cols, 0, 'sedan', fixed(0));
  drawDriver(cols, 1, 'sedan', fixed(0.9999));
  assert.ok(cols.aggr[0] < -0.9 && cols.aggr[1] > 0.9, `aggression ${cols.aggr[0]} and ${cols.aggr[1]}`);
  assert.ok(cols.dT[1] < cols.dT[0] * 0.6, `headway ${cols.dT[1].toFixed(2)} (pushy) and ${cols.dT[0].toFixed(2)} (timid)`);
  assert.ok(cols.da[1] > cols.da[0] * 1.6 && cols.db[1] > cols.db[0], 'acceleration and braking');
  assert.ok(cols.gapF[1] < cols.gapF[0] && cols.patience[1] < cols.patience[0] && cols.polite[1] < cols.polite[0], 'gap, patience and politeness');
  // in the fleet: a spread, most drivers ordinary
  const { sim } = gridCity(4, 120);
  const tr = traffic(sim);
  tr.density = 1 / 15;
  for (let i = 0; i < 20 * 20; i++) tr.step(0.05);
  const c = tr.veh.cols, g: number[] = [];
  for (let v = 0; v < tr.veh.end; v++) if (tr.veh.alive[v] && c.kind[v] === 0) g.push(c.aggr[v]);
  const mid = g.filter((x) => Math.abs(x) < 0.5).length / g.length;
  assert.ok(g.length > 50 && Math.min(...g) < -0.6 && Math.max(...g) > 0.6, `aggression from ${Math.min(...g).toFixed(2)} to ${Math.max(...g).toFixed(2)}`);
  assert.ok(mid > 0.55, `${(mid * 100).toFixed(0)}% ordinary drivers (|aggression| < 0.5)`);
  // on the road: behind the same leader at 12 m/s, the timid driver settles further back than the pushy one
  const gapBehind = (u: number) => {
    const t2 = traffic(gridCity(4, 120).sim);
    t2.density = 0;
    const run = straightRun(t2.sim, 3);
    const lead = placeOn(t2, run, 0, 40, 12), f = placeOn(t2, run, 0, 20, 12);
    const fc = t2.veh.cols;
    drawDriver(fc as unknown as Parameters<typeof drawDriver>[0], f, 'sedan', fixed(u));
    fc.vf[lead] = 0.75; fc.vf[f] = 1.3; fc.driftA[lead] = 0; fc.driftA[f] = 0; // the leader drives slower: the follower closes up
    let gap = 0;
    for (let i = 0; i < 20 * 12; i++) { t2.step(0.05); if (fc.lane[f] === fc.lane[lead] && fc.conn[f] < 0) gap = fc.s[lead] - fc.len[lead] - fc.s[f]; }
    return gap;
  };
  const timid = gapBehind(0), pushy = gapBehind(0.9999);
  assert.ok(timid > pushy + 3, `following gap ${timid.toFixed(1)} m (timid) and ${pushy.toFixed(1)} m (pushy)`);
});

test('driving: improved IDM with the constant-acceleration heuristic, jerk-limited pedals, and never into what is ahead', async () => {
  const { drawDriver, driveAccel, driverSchema, JERK_UP } = await import('../src/sim/drivers.ts');
  const c = Object.fromEntries(Object.entries(driverSchema).map(([k, A]) => [k, new A(1)])) as unknown as Parameters<typeof drawDriver>[0];
  drawDriver(c, 0, 'sedan', () => 0.5); // an ordinary driver
  const dt = 0.05;
  // pulling away from rest on a free road: the acceleration builds up at the driver's jerk, not at once
  let v = 0, last = 0;
  c.acc[0] = 0;
  for (let i = 0; i < 20; i++) {
    const a = driveAccel(c, 0, v, 14, 1e9, 99, 0, dt);
    assert.ok(a - last <= JERK_UP * dt + 1e-9, `step ${i}: acceleration ${last.toFixed(2)} → ${a.toFixed(2)} m/s²`);
    last = a; c.acc[0] = a; v += a * dt;
  }
  // a car cuts in 5 m ahead at the same 14 m/s: too close by the headway, but not closing; plain IDM would stamp on the
  // brake, the heuristic eases off
  c.acc[0] = 0;
  const cut = driveAccel(c, 0, 14, 15, 5, 14, 0, dt);
  const s0 = c.ds0[0], T = c.dT[0], a = c.da[0];
  const sStar = s0 + 14 * T;
  const idm = a * (1 - (14 / 15) ** 4 - (sStar / 5) ** 2);
  assert.ok(cut > -c.db[0] - 0.5 && idm < -8, `cut-in: ${cut.toFixed(2)} m/s² (plain IDM ${idm.toFixed(2)})`);
  // at 15 m/s towards a stopped car 40 m ahead: stops short of it, never braking harder than an emergency stop
  v = 15; let s = 0; c.acc[0] = 0;
  let hardest = 0;
  for (let i = 0; i < 20 * 20; i++) {
    const acc = driveAccel(c, 0, v, 14, 40 - s, 0, 0, dt);
    const nv = Math.max(0, v + acc * dt);
    const applied = (nv - v) / dt;
    hardest = Math.min(hardest, applied);
    s += (v + nv) / 2 * dt; v = nv; c.acc[0] = applied;
  }
  assert.ok(s < 40 && 40 - s < 6, `stopped ${(40 - s).toFixed(2)} m short of the car`);
  assert.ok(hardest >= -c.dbe[0] - 1e-6, `braked at ${hardest.toFixed(2)} m/s² (emergency ${c.dbe[0].toFixed(2)})`);
});

test('lorry yards: a truck bound for a yard turns in at the dock\'s gate as it drives past, not from the end of the street', () => {
  const { sim } = gridCity(4, 120);
  const tr = traffic(sim);
  tr.density = 0;
  // the destination's lane: the longest one there is; a dock 16 m back from its kerb, near the lane's start
  const k = sim.conns.cols;
  let lane = -1;
  for (let x = 0; x < sim.conns.end; x++) if (sim.conns.alive[x] && k.turn[x] === 1 && (lane < 0 || sim.laneLen(k.to[x]) > sim.laneLen(lane))) lane = k.to[x];
  assert.ok(sim.laneLen(lane) > 75, `lane of ${sim.laneLen(lane).toFixed(0)} m`);
  const p = new Float64Array(4);
  sim.lanePoint(lane, 14, p);
  const nx = -Math.cos(p[3]), nz = Math.sin(p[3]); // the driver's right
  tr.setDocks(new Float32Array([p[0] + nx * 16, p[2] + nz * 16, Math.atan2(-nx, -nz)]));
  // a truck coming along that lane to its end
  const T = inner(tr), c = tr.veh.cols, v = tr.veh.alloc();
  T.initVehicle(v, 2);
  const o = v * ROUTE_CAP;
  tr.routes[o] = sim.laneFrom(lane); tr.routes[o + 1] = sim.laneTo(lane);
  c.rLen[v] = 2; c.rIdx[v] = 1; c.dest[v] = sim.laneTo(lane);
  c.lane[v] = lane; c.conn[v] = -1; c.s[v] = 0; c.v[v] = 8;
  T.setLaneCount(lane, 1); T.addMicro(v); T.insert(v, false, lane);
  let docked = -1;
  for (let i = 0; i < 20 * 20 && docked < 0; i++) { tr.step(0.05); if (tr.docked > 0) docked = c.s[v]; }
  assert.ok(docked >= 0, `the truck never backed into the dock (planned ${tr.mvs.planned}, refused ${tr.mvs.refused})`);
  assert.ok(docked < 45, `it turned in ${docked.toFixed(0)} m along the lane, past the gate at 14 m`);
});

test('bends: turns are driven within the lateral acceleration a driver accepts (4 m/s² falling with speed, less for heavy vehicles)', () => {
  const { sim } = gridCity(4, 120);
  const tr = traffic(sim);
  tr.density = 1 / 25;
  const c = tr.veh.cols, k = sim.conns.cols;
  // each connection's sharpest curvature, from its curve (|B' × B''| / |B'|³ at 9 points)
  const curv = (x: number) => {
    const ax = 2 * (k.x0[x] - 2 * k.cx[x] + k.x1[x]), az = 2 * (k.z0[x] - 2 * k.cz[x] + k.z1[x]);
    let m = 0;
    for (let i = 0; i <= 8; i++) {
      const t = i / 8, dx = 2 * (1 - t) * (k.cx[x] - k.x0[x]) + 2 * t * (k.x1[x] - k.cx[x]), dz = 2 * (1 - t) * (k.cz[x] - k.z0[x]) + 2 * t * (k.z1[x] - k.cz[x]);
      const d = Math.hypot(dx, dz);
      if (d > 1e-3) m = Math.max(m, Math.abs(dx * az - dz * ax) / (d * d * d));
    }
    return m;
  };
  let worst = 0, turning = 0;
  for (let i = 0; i < 20 * 240; i++) {
    tr.step(0.05);
    if (i % 10 === 0) tr.checkWindow();
    for (let j = 0; j < tr.microN; j++) {
      const v = tr.micro[j], x = c.conn[v];
      if (x < 0 || k.turn[x] === 1 || c.s[v] < 2 || c.s[v] > k.len[x] - 2) continue;
      turning++;
      const share = (1 + 0.2 * c.aggr[v]) * (c.kind[v] ? 0.7 : 1);
      worst = Math.max(worst, (c.v[v] * c.v[v] * curv(x)) / share);
    }
  }
  assert.ok(turning > 200, `vehicle-steps in turns ${turning}`);
  assert.ok(worst <= 4.3, `lateral acceleration up to ${worst.toFixed(1)} m/s² (per unit of the driver's share) in a turn`);
});

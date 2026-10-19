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

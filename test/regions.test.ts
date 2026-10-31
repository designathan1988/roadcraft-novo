/// <reference types="node" />
// D55: the region sums (cars and lane slots per 400 m region, the fleet and its jammed share) are kept as segments and
// their loads change, and the 4 s measurement divides out only the regions that changed. Pinned here: the published
// values equal the full pass over every segment that the measurement used to make, through loading, a reprofile, a
// removal whose id a new road takes before the vehicles are cleared, and a cleared network; and the measurement does
// not walk the segments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridCity, recordOps, mirror, syncNet, traffic, inner } from './simCity.ts';
import { planRoad, buildRoad, snap, changeProfile, demolishSeg } from '../src/roads/build.ts';
import { PROFILE_INFO } from '../src/roads/profiles.ts';
import { JAMMED } from '../src/sim/traffic/regions.ts';
import { asSeg } from '../src/core/ids.ts';
import type { Traffic } from '../src/sim/traffic.ts';
import type { SimNet } from '../src/sim/lanes.ts';

/** The pass the measurement made before D55, in doubles: every live, non-rail segment. */
function reference(sim: SimNet, tr: Traffic): { occ: Float64Array; fleet: number; jammed: number } {
  const sc = sim.net.segs.cols, L = new Float64Array(tr.regionOcc.length), C = new Float64Array(tr.regionOcc.length);
  let fleet = 0, jammed = 0;
  for (let s = 0; s < sim.net.segs.end; s++) {
    if (!sim.net.segs.alive[s]) continue;
    const info = PROFILE_INFO[sc.profile[s]];
    if (info.rail) continue;
    const r = tr.regionOf(sc.mx[s], sc.mz[s]);
    const fwd = tr.segLoad[s * 2], back = tr.segLoad[s * 2 + 1], slots = sc.len[s] / 7.5;
    L[r] += fwd + back;
    C[r] += slots * (info.lanesFwd + info.lanesBack);
    fleet += fwd + back;
    if (info.lanesFwd && fwd >= JAMMED * slots * info.lanesFwd) jammed += fwd;
    if (info.lanesBack && back >= JAMMED * slots * info.lanesBack) jammed += back;
  }
  const occ = new Float64Array(L.length);
  for (let r = 0; r < L.length; r++) occ[r] = C[r] > 0 ? L[r] / C[r] : 0;
  return { occ, fleet, jammed };
}

/** Measures now and compares every region and the fleet with the full pass. */
function same(sim: SimNet, tr: Traffic, label: string): { fleet: number } {
  inner(tr.regions).t = -Infinity;
  tr.regions.measure(tr.time);
  const ref = reference(sim, tr);
  for (let r = 0; r < ref.occ.length; r++) {
    assert.ok(Math.abs(tr.regionOcc[r] - ref.occ[r]) <= 1e-6 * Math.max(1, ref.occ[r]), `${label}: region ${r} ${tr.regionOcc[r]} != ${ref.occ[r]}`);
  }
  assert.equal(inner(tr.regions).fleet, ref.fleet, `${label}: fleet`);
  assert.equal(tr.jammedNow, ref.jammed, `${label}: jammed`);
  assert.equal(tr.jamShare, ref.fleet > 0 ? ref.jammed / ref.fleet : 0, `${label}: jam share`);
  return ref;
}

function run(tr: Traffic, steps: number): void {
  for (let i = 0; i < steps; i++) { tr.step(0.05); if (i % 10 === 0) tr.checkWindow(); }
}

/** The live road segment carrying the most cars now. */
function busiest(sim: SimNet, tr: Traffic): number {
  let best = -1, most = -1;
  for (let s = 0; s < sim.net.segs.end; s++) {
    if (!sim.net.segs.alive[s] || PROFILE_INFO[sim.net.segs.cols.profile[s]].rail) continue;
    const n = tr.segLoad[s * 2] + tr.segLoad[s * 2 + 1];
    if (n > most) { most = n; best = s; }
  }
  return best;
}

test('D55: the kept region sums equal the full pass through loading, reprofile, removal with id reuse and clear', () => {
  const { w, sim } = gridCity(4);
  const ops = recordOps(w);
  const tr = traffic(sim);
  tr.density = 1 / 40;
  run(tr, 600);
  assert.ok(same(sim, tr, 'loaded').fleet > 20, 'the city has traffic to measure');

  // a segment with cars changes profile (its slots and its jam limit change under the cars on it)
  const p = busiest(sim, tr);
  assert.ok(tr.segLoad[p * 2] + tr.segLoad[p * 2 + 1] > 0);
  changeProfile(w, asSeg(p), sim.net.segs.cols.profile[p] === 3 ? 0 : 3);
  mirror(sim, ops.splice(0));
  same(sim, tr, 'reprofiled, before the vehicles moved');
  syncNet(sim, tr);
  run(tr, 200);
  same(sim, tr, 'reprofiled');

  // a segment with cars goes, and a new road takes its id before Traffic clears the cars of the old one
  const d = busiest(sim, tr);
  assert.ok(tr.segLoad[d * 2] + tr.segLoad[d * 2 + 1] > 0);
  const sc = sim.net.segs.cols, nc = sim.net.nodes.cols;
  const ax = nc.x[sc.a[d]], az = nc.z[sc.a[d]], bx = nc.x[sc.b[d]], bz = nc.z[sc.b[d]];
  demolishSeg(w, asSeg(d));
  mirror(sim, ops.splice(0));
  same(sim, tr, 'removed, before the vehicles left');
  const a = snap(w.roads, ax, az, 8), b = snap(w.roads, bx, bz, 8);
  const plan = planRoad(w, a, null, b, 0, 0);
  assert.ok(plan.ok, plan.reason);
  buildRoad(w, plan, a, b, 0);
  const built = ops.filter((op) => op.t === 'addSeg').map((op) => (op.t === 'addSeg' ? op.rec.id : -1));
  assert.ok(built.includes(asSeg(d)), `the new road takes the freed id ${d} (took ${built.join(', ')})`);
  mirror(sim, ops.splice(0));
  same(sim, tr, 'id reused, the old cars still counted on it');
  syncNet(sim, tr);
  same(sim, tr, 'id reused, the old cars gone');
  run(tr, 200);
  same(sim, tr, 'after the edits');

  // a new map: no cars, no slots
  tr.clearAll();
  sim.apply({ t: 'clear' });
  same(sim, tr, 'cleared');
  assert.ok(inner(tr.regions).cap.every((c: number) => c === 0), 'no slots left in any region');
  assert.ok(inner(tr.regions).count.every((c: number) => c === 0), 'no segment counted');
});

test('D55: the measurement does not walk the segments', () => {
  const { sim } = gridCity(4);
  const tr = traffic(sim);
  tr.density = 1 / 40;
  run(tr, 200);
  const segs = sim.net.segs as unknown as { alive: Uint8Array };
  const real = segs.alive;
  let reads = 0;
  Object.defineProperty(segs, 'alive', {
    configurable: true, writable: true,
    value: new Proxy(real, { get: (o, k) => { if (typeof k === 'string' && /^\d+$/.test(k)) reads++; return Reflect.get(o, k); } }),
  });
  try {
    inner(tr.regions).t = -Infinity;
    // the arguments the old measurement took (the network and the loads) are given: it would walk them
    (tr.regions.measure as (...a: unknown[]) => void).call(tr.regions, tr.time, sim.net, tr.segLoad);
  } finally {
    Object.defineProperty(segs, 'alive', { configurable: true, writable: true, value: real });
  }
  assert.equal(reads, 0, `segments read by one measurement: ${reads}`);
});

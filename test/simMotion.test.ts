/// <reference types="node" />
// What the motion probe (tools/check-sim.mjs, scenario 'motion') found in the game, each reproduced here first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Peds } from '../src/sim/peds.ts';
import { gridCity, inner, traffic } from './simCity.ts';

test('pedestrians keep walking when a route crosses a street without sidewalks (an expressway at a junction)', () => {
  // local streets, one of them an expressway (no sidewalks): people walking round the corners cross it
  const { sim } = gridCity(4, 120, -1, (i, horiz) => (i === 1 && horiz ? 5 : 0));
  const tr = traffic(sim);
  tr.density = 0;
  const peds = new Peds(sim);
  peds.density = 1 / 4;
  const P = inner(peds);
  const c = peds.t.cols;
  const seen = new Map<number, [number, number]>();
  let frozen = 0, walking = 0, nan = 0;
  for (let i = 0; i < 20 * 120; i++) {
    tr.step(0.05); peds.step(0.05);
    if (i % 10 === 0) { tr.checkWindow(); peds.checkWindow(); }
    if (P.heapN > 0 && !Number.isFinite(P.heapT[0])) nan++;
    if (i % 20 !== 0 || i < 20 * 60) continue;
    // every second in the second minute: those on a walking leg (sidewalk or line) have moved since the last look
    const r = peds.inspect(0, 0, 1000);
    for (let k = 0; k < r.length; k += 12) {
      const id = r[k], x = r[k + 1], z = r[k + 2], mode = r[k + 5];
      const was = seen.get(id);
      // walking (not holding its pace behind someone near the camera, which reports speed 0)
      if (was && (mode === 0 || mode === 1) && c.dur[id] > 1.2 && r[k + 4] > 0) { walking++; if (Math.hypot(x - was[0], z - was[1]) < 0.05) frozen++; }
      seen.set(id, [x, z]);
    }
  }
  assert.equal(peds.invalid, 0, 'people given an invalid time (faded out instead of walking on)');
  assert.equal(nan, 0, `steps with an event at an invalid time on top of the pedestrians' queue: ${nan}`);
  assert.ok(walking > 500, `walking people looked at ${walking}`);
  assert.ok(frozen <= walking * 0.01, `${frozen} of ${walking} walking people had not moved in a second`);
});

test('people do not walk inside each other: on the sidewalk, across the crosswalk, waiting at the light, at a 1.2-1.5 m/s pace', (t) => {
  const { sim } = gridCity(4, 120);
  const tr = traffic(sim);
  tr.density = 1 / 40;
  const peds = new Peds(sim);
  peds.density = 1 / 10; // a busy street: one person every 8 m of sidewalk
  const P = inner(peds), T = inner(tr);
  P.walkOk = (n: number, a: number) => T.walkOk(n, a);
  P.onWait = (n: number, a: number) => T.pedCall(n, a);
  tr.pedCrossing = (n) => peds.crossing(n);
  let prev = new Set<string>(), fused = 0, pairs = 0, looks = 0, offPace = 0, walking = 0;
  for (let i = 0; i < 20 * 150; i++) {
    tr.step(0.05); peds.step(0.05);
    if (i % 10 === 0) { tr.checkWindow(); peds.checkWindow(); }
    if (i % 5 !== 0 || i < 20 * 60) continue;
    // every 0.25 s, near the camera: pairs closer than 0.35 m (two bodies in one), still so a quarter of a second later
    const r = peds.inspect(0, 0, 150), n = r.length / 12, now = new Set<string>();
    const cell = new Map<number, number[]>();
    for (let a = 0; a < n; a++) {
      if (r[a * 12 + 8]) continue; // cyclists ride the bike lane
      const k = Math.floor(r[a * 12 + 1]) * 4096 + Math.floor(r[a * 12 + 2]);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const b of cell.get(k + dx * 4096 + dz) ?? []) {
        if (Math.hypot(r[a * 12 + 1] - r[b * 12 + 1], r[a * 12 + 2] - r[b * 12 + 2]) >= 0.35) continue;
        const key = Math.min(r[a * 12], r[b * 12]) + '/' + Math.max(r[a * 12], r[b * 12]);
        now.add(key); pairs++;
        if (prev.has(key)) fused++;
      }
      (cell.get(k) ?? cell.set(k, []).get(k)!).push(a);
      const mode = r[a * 12 + 5];
      // walking at its own pace (not slowed behind someone near the camera)
      if ((mode === 0 || mode === 1) && r[a * 12 + 11] > 0.999) { walking++; if (r[a * 12 + 4] < 1.2 - 1e-3 || r[a * 12 + 4] > 1.5 + 1e-3) offPace++; }
    }
    prev = now; looks++;
  }
  t.diagnostic(`looks ${looks}, walking people seen ${walking}, off pace ${offPace}, close pairs ${pairs}, inside each other over 0.25 s ${fused}`);
  assert.ok(looks > 300 && walking > 10000, `looks ${looks}, walking people seen ${walking}`);
  assert.ok(offPace === 0, `${offPace} of ${walking} walking at a pace outside 1.2-1.5 m/s`);
  // two who meet head-on in a crowd may still brush through each other for a moment; never stay one inside the other
  assert.ok(fused <= looks * 0.05, `${fused} times two people inside each other for over a quarter of a second in ${looks} looks (${pairs} close pairs)`);
});

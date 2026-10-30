/// <reference types="node" />
// What the motion probe (tools/check-sim.mjs, scenario 'motion') found in the game, each reproduced here first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Peds } from '../src/sim/peds.ts';
import { INSPECT_PASS } from '../src/sim/traffic.ts';
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
    tr.step(0.05); peds.setBodies(tr.bodyBuf, tr.writeBodies(0, 0, 180)); peds.step(0.05);
    if (i % 10 === 0) { tr.checkWindow(); peds.checkWindow(); }
    if (P.heapN > 0 && !Number.isFinite(P.heapT[0])) nan++;
    if (i % 20 !== 0 || i < 20 * 60) continue;
    // every second in the second minute: those on a walking leg (sidewalk or line) have moved since the last look
    const r = peds.inspect(0, 0, 1000);
    for (let k = 0; k < r.length; k += 12) {
      const id = r[k], x = r[k + 1], z = r[k + 2], mode = r[k + 5];
      const was = seen.get(id);
      // walking (not holding its pace behind someone near the camera, which reports speed 0)
      if (was && (mode === 0 || mode === 1) && c.dur[id] > 1.2 && r[k + 4] > 0.1) { walking++; if (Math.hypot(x - was[0], z - was[1]) < 0.05) frozen++; }
      seen.set(id, [x, z]);
    }
  }
  assert.equal(peds.invalid, 0, 'people given an invalid time (faded out instead of walking on)');
  assert.equal(nan, 0, `steps with an event at an invalid time on top of the pedestrians' queue: ${nan}`);
  assert.ok(walking > 500, `walking people looked at ${walking}`);
  assert.ok(frozen <= walking * 0.01, `${frozen} of ${walking} walking people had not moved in a second`);
});

test('people never jump: between two publications a walker moves at most a step (corners, crosswalks, waits)', (t) => {
  const { sim } = gridCity(4, 120);
  const tr = traffic(sim);
  tr.density = 1 / 40;
  const peds = new Peds(sim);
  peds.density = 1 / 6; // busy sidewalks: people step aside for each other, then turn corners and cross
  const P = inner(peds), T = inner(tr);
  P.walkOk = (n: number, a: number) => T.walkOk(n, a);
  P.onWait = (n: number, a: number) => T.pedCall(n, a);
  tr.pedCrossing = (n) => peds.crossing(n);
  tr.pedCrossingNear = (n, m, x, z, r) => peds.crossingNear(n, m, x, z, r);
  P.carsOn = (n: number, a: number) => T.carsOnCrossing(n, a);
  const c = peds.t.cols, buf = new Float32Array(11 * 8192);
  const lastX = new Float32Array(1 << 20), lastZ = new Float32Array(1 << 20), lastF = new Int32Array(1 << 20).fill(-9);
  let steps = 0, jumps = 0, worst = 0, example = '';
  for (let i = 0; i < 20 * 120; i++) {
    tr.step(0.05); peds.setBodies(tr.bodyBuf, tr.writeBodies(0, 0, 180)); peds.step(0.05);
    if (i % 10 === 0) { tr.checkWindow(); peds.checkWindow(); }
    peds.writePoses(buf, 11, 0, buf.length / 11);
    const frame = P.frame;
    for (let p = 0; p < peds.t.end; p++) {
      if (!peds.t.alive[p] || c.wf[p] !== frame || c.bike[p]) continue;
      if (i > 20 * 20 && lastF[p] === frame - 1) {
        const d = Math.hypot(c.px[p] - lastX[p], c.pz[p] - lastZ[p]);
        steps++;
        if (d > 0.3) { jumps++; if (d > worst) { worst = d; example = `person ${p} moved ${d.toFixed(2)} m in 50 ms (mode ${c.mode[p]})`; } }
      }
      lastX[p] = c.px[p]; lastZ[p] = c.pz[p]; lastF[p] = frame;
    }
  }
  t.diagnostic(`published walker steps ${steps}, jumps over 0.3 m ${jumps}, worst ${worst.toFixed(2)} m`);
  assert.ok(steps > 100000, `walker steps looked at ${steps}`);
  assert.equal(jumps, 0, `${jumps} jumps over 0.3 m in a 50 ms publication; worst: ${example}`);
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
    tr.step(0.05); peds.setBodies(tr.bodyBuf, tr.writeBodies(0, 0, 180)); peds.step(0.05);
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

test('cars stop before the crosswalk and give way to people on it: nobody crossing is ever inside a vehicle', (t) => {
  const { sim } = gridCity(4, 120);
  const tr = traffic(sim);
  tr.density = 1 / 30;
  const peds = new Peds(sim);
  peds.density = 1 / 10;
  const P = inner(peds), T = inner(tr);
  P.walkOk = (n: number, a: number) => T.walkOk(n, a);
  P.onWait = (n: number, a: number) => T.pedCall(n, a);
  tr.pedCrossing = (n) => peds.crossing(n);
  if ('pedCrossingArms' in T) T.pedCrossingArms = (n: number, m: number) => peds.crossingArms(n, m);
  if ('pedCrossingNear' in T) T.pedCrossingNear = (n: number, m: number, x: number, z: number, r: number) => peds.crossingNear(n, m, x, z, r);
  if ('carsOn' in P && 'carsOnCrossing' in T) P.carsOn = (n: number, a: number) => T.carsOnCrossing(n, a);
  const W = [1.8, 2.55, 2.5, 0.8, 3.0];
  let inside = 0, crossingSeen = 0, onZebra = 0, committedOnZebra = 0, stoppedAtLine = 0, looks = 0;
  const stood = new Set<number>(), onIt = new Set<number>(), committedIt = new Set<number>();
  for (let i = 0; i < 20 * 150; i++) {
    tr.step(0.05); peds.setBodies(tr.bodyBuf, tr.writeBodies(0, 0, 180)); peds.step(0.05);
    if (i % 10 === 0) { tr.checkWindow(); peds.checkWindow(); }
    if (i % 5 !== 0 || i < 20 * 60) continue;
    looks++;
    const v = tr.inspect(0, 0, 150).vehicles, p = peds.inspect(0, 0, 150);
    // stopped at a junction's line: front short of the zebra (the last 4.2 m of the lane), not on it
    for (let a = 0; a < v.length; a += 18) {
      if (v[a + 7] >= 0 || v[a + 6] > 0.1 || v[a + 12] > 8 || v[a + 10] < 900) continue; // first in line, standing
      stoppedAtLine++; stood.add(v[a]);
      if (v[a + 12] < 4.2 - 0.05 && sim.net.nodes.cols.deg[v[a + 8]] >= 3) {
        // committed at the line with the way open (pass) and then stopped for somebody stepping into its path is the
        // allowed case (roadcraft stoppedForWalker); an approaching vehicle must never be found on the zebra.
        if (v[a + 9] & INSPECT_PASS) { committedOnZebra++; committedIt.add(v[a]); }
        else { onZebra++; onIt.add(v[a]); }
      }
    }
    for (let b = 0; b < p.length; b += 12) {
      if (p[b + 6] === 0 || p[b + 8]) continue; // on a crossing, on foot
      crossingSeen++;
      for (let a = 0; a < v.length; a += 18) {
        if (p[b + 7] !== v[a + 8]) continue; // the person and the vehicle must be at the same junction
        const y = v[a + 4], dx = p[b + 1] - v[a + 2], dz = p[b + 2] - v[a + 3];
        const lf = dx * Math.sin(y) + dz * Math.cos(y), ls = dx * Math.cos(y) - dz * Math.sin(y);
        if (v[a + 1] !== 4 && Math.abs(lf) < v[a + 5] / 2 && Math.abs(ls) < W[v[a + 1]] / 2) inside++;
      }
    }
  }
  t.diagnostic(`looks ${looks}, people crossing seen ${crossingSeen}, inside a vehicle ${inside}, first in line stopped ${stoppedAtLine} (${stood.size} vehicles), on the zebra ${onZebra} (${onIt.size} vehicles), committed on the zebra ${committedOnZebra} (${committedIt.size} vehicles)`);
  assert.ok(crossingSeen > 500 && stoppedAtLine > 500, `people crossing seen ${crossingSeen}, vehicles stopped first in line ${stoppedAtLine}`);
  // The committed vehicles counted apart above are the documented stoppedForWalker case; the bound below is for an
  // approaching first-in-line vehicle, allowing the physical overshoot of a stop at the line.
  assert.ok(onZebra <= stoppedAtLine * 0.01, `${onZebra} of ${stoppedAtLine} looks at approaching first-in-line vehicles on the zebra (${onIt.size} vehicles)`);
  assert.ok(inside <= crossingSeen * 0.001, `${inside} times in ${crossingSeen} someone crossing was inside a vehicle`);
});

test('vehicles go round a turn on their path: the drawn body\'s ends stay on it (no pivoting about the nose)', async () => {
  const { backAlong } = await import('../src/sim/traffic.ts');
  const { sim } = gridCity(4, 120);
  const tr = traffic(sim);
  tr.density = 1 / 30;
  const c = tr.veh.cols, k = sim.conns.cols, T = inner(tr);
  const p = new Float64Array(4), f = new Float64Array(4), r = new Float64Array(4);
  // the tightest corner the junctions build: a body spans more than the connection it is on
  let kMax = 0;
  for (let x = 0; x < sim.conns.end; x++) if (sim.conns.alive[x]) kMax = Math.max(kMax, k.k[x]);
  let looked = 0, worst = 0, example = '';
  for (let i = 0; i < 20 * 150; i++) {
    tr.step(0.05);
    if (i % 10 === 0) tr.checkWindow();
    for (let j = 0; j < tr.microN; j++) {
      const v = tr.micro[j], x = c.conn[v];
      if (x < 0 || k.turn[x] === 1 || c.kind[v] === 4 || c.mv[v] >= 0 || c.lcT[v] < 1) continue;
      T.centreOf(v, p);
      const h = c.len[v] / 2, fx = Math.sin(p[3]), fz = Math.cos(p[3]);
      backAlong(sim, c.lane[v], x, c.s[v], 0, f);
      backAlong(sim, c.lane[v], x, c.s[v], c.len[v], r);
      const off = Math.max(Math.hypot(p[0] + fx * h - f[0], p[2] + fz * h - f[2]), Math.hypot(p[0] - fx * h - r[0], p[2] - fz * h - r[2]));
      // the chord between the ends cuts the bend: its sag (L² k / 8 at the sharpest curvature) is all a rigid body may
      // leave its path by
      const excess = off - (c.len[v] * c.len[v] * kMax / 8 + 0.3);
      looked++;
      if (excess > worst) { worst = excess; example = `vehicle ${v} (kind ${c.kind[v]}, ${c.len[v].toFixed(1)} m) ${off.toFixed(2)} m off its path`; }
    }
  }
  assert.ok(looked > 5000, `vehicle-steps in turns ${looked}`);
  assert.ok(worst <= 0, `the drawn body's front or rear left its path ${worst.toFixed(2)} m beyond a rigid body's sag: ${example}`);
});

test('people turn as people do: the body never snaps round between two publications (3.5 rad/s walking, 6 standing)', () => {
  const { sim } = gridCity(4, 120);
  const tr = traffic(sim);
  tr.density = 1 / 40;
  const peds = new Peds(sim);
  peds.density = 1 / 6;
  const P = inner(peds), T = inner(tr);
  P.walkOk = (n: number, a: number) => T.walkOk(n, a);
  P.onWait = (n: number, a: number) => T.pedCall(n, a);
  tr.pedCrossing = (n) => peds.crossing(n);
  P.carsOn = (n: number, a: number) => T.carsOnCrossing(n, a);
  const buf = new Float32Array(11 * 8192);
  let steps = 0, snaps = 0, worst = 0;
  for (let i = 0; i < 20 * 90; i++) {
    tr.step(0.05); peds.setBodies(tr.bodyBuf, tr.writeBodies(0, 0, 180)); peds.step(0.05);
    if (i % 10 === 0) { tr.checkWindow(); peds.checkWindow(); }
    const n = peds.writePoses(buf, 11, 0, buf.length / 11);
    if (i < 20 * 20) continue;
    for (let k = 0; k < n; k++) {
      let dy = buf[k * 11 + 7] - buf[k * 11 + 3];
      dy -= Math.round(dy / (2 * Math.PI)) * 2 * Math.PI;
      steps++;
      worst = Math.max(worst, Math.abs(dy));
      if (Math.abs(dy) > 6 * 0.05 + 1e-4) snaps++;
    }
  }
  assert.ok(steps > 100000, `published steps ${steps}`);
  assert.equal(snaps, 0, `${snaps} bodies turned faster than 6 rad/s (worst ${(worst * 180 / Math.PI).toFixed(0)} degrees in 50 ms)`);
});

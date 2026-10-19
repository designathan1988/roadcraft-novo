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
    for (let k = 0; k < r.length; k += 11) {
      const id = r[k], x = r[k + 1], z = r[k + 2], mode = r[k + 5];
      const was = seen.get(id);
      if (was && (mode === 0 || mode === 1) && c.dur[id] > 1.2) { walking++; if (Math.hypot(x - was[0], z - was[1]) < 0.05) frozen++; }
      seen.set(id, [x, z]);
    }
  }
  assert.equal(peds.invalid, 0, 'people given an invalid time (faded out instead of walking on)');
  assert.equal(nan, 0, `steps with an event at an invalid time on top of the pedestrians' queue: ${nan}`);
  assert.ok(walking > 500, `walking people looked at ${walking}`);
  assert.ok(frozen <= walking * 0.01, `${frozen} of ${walking} walking people had not moved in a second`);
});

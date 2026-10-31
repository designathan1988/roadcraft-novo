/// <reference types="node" />
// Junction corners and setbacks (Roadcraft 4.0 world/junction/corners.ts and trim.ts): a kerb return of radius
// clamp(0.5 × the narrower road's half width, 2.8, 7.2) m where two kerbs meet; a bevel for very sharp corners;
// each leg set back as far as its two corners need; never more than 45 % of a segment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armOf, cornerFillet, junctionRetreats } from '../src/roads/junction.ts';
import { PROFILE_INFO } from '../src/roads/profiles.ts';
import type { Quad } from '../src/roads/geometry.ts';

/** An arm of `profile` leaving the origin at `deg` degrees (counter-clockwise seen from above: z is down the screen). */
function arm(deg: number, profile = 0) {
  const a = (deg * Math.PI) / 180, x = Math.cos(a) * 100, z = -Math.sin(a) * 100;
  const q: Quad = { x0: 0, z0: 0, cx: x / 2, cz: z / 2, x1: x, z1: z };
  return armOf(q, profile, 0);
}
function retreats(degs: number[], profile = 0): number[] {
  const arms = degs.map((d) => arm(d, profile)), out = new Float64Array(16), order: number[] = [];
  junctionRetreats(arms, arms.map(() => 100), out, order);
  return Array.from(out.subarray(0, arms.length));
}

test('a right-angle crossing of local streets: kerb returns of about 3 m, legs set back to their tangent points', () => {
  const info = PROFILE_INFO[0];
  const r = Math.min(7.2, Math.max(2.8, 0.5 * info.right));
  const kerb = info.asphaltRight; // the kerb line runs at the carriageway's edge
  for (const t of retreats([0, 90, 180, 270])) assert.ok(Math.abs(t - (kerb + r)) < 0.05, `set back ${t.toFixed(2)} m, the tangent point is ${(kerb + r).toFixed(2)} m out`);
  const f = cornerFillet(arm(0), arm(90));
  assert.equal(f.mode, 'fillet');
  assert.ok(Math.abs(f.r - r) < 1e-6, `radius ${f.r}`);
  // the centre sits inside the block, r from both kerbs
  assert.ok(Math.abs(Math.abs(f.cx) - (kerb + r)) < 0.05 && Math.abs(Math.abs(f.cz) - (kerb + r)) < 0.05, `centre ${f.cx}, ${f.cz}`);
});

test('wider roads get wider kerb returns, up to 7.2 m', () => {
  const avenue = PROFILE_INFO.findIndex((p) => p.name === 'profile.avenue6LanesMedian');
  const f = cornerFillet(arm(0, avenue), arm(90, avenue));
  assert.ok(f.r > 5 && f.r <= 7.2, `radius ${f.r}`);
});

test('a very sharp corner is bevelled, set back far enough that the kerbs do not overlap', () => {
  const f = cornerFillet(arm(0), arm(10));
  assert.equal(f.mode, 'bevel');
  const t = retreats([0, 10, 180]);
  // at the setback the two carriageways are side by side: their centrelines are at least their widths apart
  const sep = 2 * Math.sin((10 * Math.PI) / 180 / 2) * Math.min(t[0], t[1]);
  assert.ok(sep >= PROFILE_INFO[0].asphaltLeft + PROFILE_INFO[0].asphaltRight - 0.05, `the two legs are ${sep.toFixed(2)} m apart at their mouths`);
});

test('a setback never takes more than 45 % of a short segment', () => {
  const arms = [arm(0), arm(20), arm(180)], out = new Float64Array(16), order: number[] = [];
  junctionRetreats(arms, [12, 12, 100], out, order);
  assert.ok(out[0] <= 12 * 0.45 + 1e-9 && out[1] <= 12 * 0.45 + 1e-9, `${out[0]}, ${out[1]}`);
});

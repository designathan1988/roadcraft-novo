/// <reference types="node" />
// The road inspector's edits that Roadcraft 4.0 has (ui/inspector.ts): bend a road by its curvature and the curve's
// position (:231, :253-254, :325-341), its class upgraded one step (:256), a height point added (:264).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { bendRoad, buildRoad, planRoad, snap, upgradeStep, addHeightPoint } from '../src/roads/build.ts';
import { PROFILES } from '../src/roads/profiles.ts';
import { bez } from '../src/roads/geometry.ts';

function world(): World {
  const w = new World(); w.unlimited = true; w.heights.fill(10);
  return w;
}
function road(w: World, ax: number, az: number, bx: number, bz: number, profile = 0): void {
  const a = snap(w.roads, ax, az, 10), b = snap(w.roads, bx, bz, 10);
  const p = planRoad(w, a, null, b, profile, 0);
  assert.ok(p.ok, `road refused: ${p.ok ? '' : p.reason}`);
  assert.ok(buildRoad(w, p, a, b, profile, 0).settle());
}

test('a road bends by its curvature: the control point leaves the chord by h at position t, one undo step', () => {
  const w = world();
  road(w, 1000, 1000, 1080, 1000);
  const s = w.roads.nearestSeg(1040, 1000, 3)![0];
  const j = bendRoad(w, s, 0.5, 20);
  assert.equal(typeof j, 'object', `refused: ${j}`);
  if (typeof j === 'string') return;
  assert.ok(j.settle());
  const s2 = w.roads.nearestSeg(1040, 990, 4)![0];
  const q = w.roads.quad(s2), p = new Float64Array(2);
  bez(q, 0.5, p);
  // a quadratic's middle lies half way to its control point: 10 m off the chord
  assert.ok(Math.abs(Math.abs(p[1] - 1000) - 10) < 0.5, `middle of the bent road at z ${p[1]}`);
  j.invert();
  const s3 = w.roads.nearestSeg(1040, 1000, 3)![0];
  const q3 = w.roads.quad(s3);
  assert.ok(Math.abs(q3.cz - 1000) < 1e-6, 'undo straightens it');
});

test('a bend that would cross another road, or make a road too long, is refused', () => {
  const w = world();
  road(w, 1000, 1000, 1080, 1000);
  road(w, 1000, 1015, 1080, 1015);
  const s = w.roads.nearestSeg(1040, 1000, 3)![0];
  const r = bendRoad(w, s, 0.5, -40);
  assert.ok(typeof r === 'string' && /passaria|run over/.test(r), `crossing the parallel road (on the right of a → b, +z): ${typeof r === 'string' ? r : 'built'}`);
  const w2 = world();
  road(w2, 1000, 1000, 1100, 1000);
  const s2 = w2.roads.nearestSeg(1050, 1000, 3)![0];
  assert.equal(typeof bendRoad(w2, s2, 0.5, -60), 'string', 'longer than the spatial index holds');
});

test('upgrade takes the road one class up; a height point splits it in the middle and returns the node', () => {
  const w = world();
  road(w, 1000, 1000, 1080, 1000);
  const s = w.roads.nearestSeg(1040, 1000, 3)![0];
  const next = upgradeStep(w.roads.segs.cols.profile[s]);
  assert.ok(next >= 0 && next !== 0, `next class ${next}`);
  assert.ok(PROFILES[next].name.length > 0);
  const r = addHeightPoint(w, s);
  assert.equal(typeof r, 'object');
  if (typeof r === 'string') return;
  assert.ok(r.journal.settle());
  assert.equal(w.roads.nodes.cols.deg[r.node], 2);
});

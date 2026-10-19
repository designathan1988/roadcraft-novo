/// <reference types="node" />
// Regression tests for the defects listed in DEFEITOS-roadcraft-novo.md (one test per defect id). Each one failed on
// commit 4d6fc49 before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { RoadJournal, buildRoad, planRoad, snap } from '../src/roads/build.ts';

function flatWorld(money: number): World {
  const w = new World();
  w.heights.fill(10); w.tileMin.fill(10); w.tileMax.fill(10);
  w.money = money;
  return w;
}

function road(w: World, ax: number, az: number, bx: number, bz: number, profile = 0): void {
  const a = snap(w.roads, ax, az, 8), b = snap(w.roads, bx, bz, 8);
  const p = planRoad(w, a, null, b, profile, 0);
  assert.ok(p.ok, p.reason);
  assert.ok(buildRoad(w, p, a, b, profile).settle());
}

test('D1: raising or lowering a node never gives money back for roads that are still there', () => {
  const w = flatWorld(1e9);
  road(w, -120, 0, 120, 0);
  road(w, 0, -120, 0, 120);
  const node = w.roads.nearestNode(0, 0, 3);
  assert.ok(node !== null && node >= 0, 'the crossing has a node');
  const start = w.money;
  for (let i = 0; i < 10; i++) {
    for (const dy of [0.5, -0.5]) {
      const j = new RoadJournal(w, 'node height');
      j.moveNodeY(node, w.roads.nodes.cols.y[node] + dy);
      assert.ok(j.settle());
    }
    assert.ok(w.money <= start, `after ${i + 1} up/down pairs the money went from ${start} to ${w.money}`);
  }
});

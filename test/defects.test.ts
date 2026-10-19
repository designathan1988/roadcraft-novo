/// <reference types="node" />
// Regression tests for the defects listed in DEFEITOS-roadcraft-novo.md (one test per defect id). Each one failed on
// commit 4d6fc49 before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { RoadJournal, buildRoad, planRoad, snap } from '../src/roads/build.ts';
import { buildBuildings } from '../src/jobs/buildingGen.ts';
import { emptyBoxes, type PackedMesh } from '../src/jobs/protocol.ts';
import { Zone } from '../src/roads/zones.ts';

/** World positions of a packed mesh's vertices. */
function positions(m: PackedMesh): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < m.vertexCount; i++) {
    const p = m.position, k = m.scale / 32767;
    out.push([m.originX + p[i * 4] * k, m.originY + p[i * 4 + 1] * k, m.originZ + p[i * 4 + 2] * k]);
  }
  return out;
}

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

test('F1: a building that overhangs its cell is not flattened at the cell edge', () => {
  const w = flatWorld(0);
  const b = emptyBoxes(1);
  // centre 10 m inside the east and south edges of cell (0, 0): the building reaches 10-12 m past both
  b.x[0] = 246; b.z[0] = 246; b.w[0] = 40; b.d[0] = 44; b.rot[0] = 0;
  b.zone[0] = Zone.Commercial; b.floors[0] = 8; b.seed[0] = 4242; b.style[0] = 3;
  b.count = 1;
  for (const lod of [0, 1, -1]) {
    const m = buildBuildings(w.heights, b, 0, 0, 256, lod);
    assert.ok(m, `level ${lod} has a mesh`);
    let maxX = -Infinity, maxZ = -Infinity;
    for (const [x, , z] of positions(m)) { maxX = Math.max(maxX, x); maxZ = Math.max(maxZ, z); }
    assert.ok(maxX > 260 && maxZ > 260, `level ${lod}: the building ends at x=${maxX.toFixed(2)}, z=${maxZ.toFixed(2)} (cut at 256)`);
  }
});

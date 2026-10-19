/// <reference types="node" />
// Lot edits that act on every lot they touch (Roadcraft 4.0 lots.ts): shared corners, a split line across lots,
// a delete stroke. Each is one undo step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { Zone } from '../src/roads/zones.ts';
import { deleteLotsAlong, lotOutlineWorld, moveSharedCorner, splitLotsByLine } from '../src/world/lotEdit.ts';

function world(): World {
  const w = new World();
  w.heights.fill(10); w.tileMin.fill(10); w.tileMax.fill(10);
  return w;
}
/** A row of three 20 × 30 m lots side by side, x from 0 to 60, z from 0 to 30 (front towards +z). */
function row(w: World): number[] {
  return [10, 30, 50].map((x, i) => w.addBuilding({ x, z: 15, w: 20, d: 30, h: 0, rot: 0, color: 0, seed: i + 1, zone: Zone.Residential, floors: 0, style: 1 }));
}
const alive = (w: World) => { let n = 0; for (let i = 0; i < w.buildings.end; i++) if (w.buildings.alive[i]) n++; return n; };

test('moving a corner moves it on every lot that shares it; undo puts them back', () => {
  const w = world();
  row(w);
  // the corner shared by the first two lots at (20, 30) goes to (22, 34)
  const j = moveSharedCorner(w, 20, 30, 22, 34);
  assert.ok(typeof j !== 'string', String(j));
  let moved = 0;
  for (let i = 0; i < w.buildings.end; i++) if (w.buildings.alive[i]) {
    const o = lotOutlineWorld(w, i);
    assert.ok(!o.some(([x, z]) => Math.hypot(x - 20, z - 30) < 0.5), `lot ${i} still has the old corner`);
    if (o.some(([x, z]) => Math.hypot(x - 22, z - 34) < 0.05)) moved++;
  }
  assert.equal(moved, 2, `${moved} lots have the moved corner`);
  j.invert();
  let back = 0;
  for (let i = 0; i < w.buildings.end; i++) if (w.buildings.alive[i] && lotOutlineWorld(w, i).some(([x, z]) => Math.hypot(x - 20, z - 30) < 0.05)) back++;
  assert.equal(back, 2);
});

test('a line drawn across a row of lots splits every one it crosses, in one step', () => {
  const w = world();
  row(w);
  const j = splitLotsByLine(w, -5, 12, 65, 12);
  assert.ok(typeof j !== 'string', String(j));
  assert.equal(alive(w), 6, 'each of the three lots became two');
  j.invert();
  assert.equal(alive(w), 3);
  assert.equal(typeof splitLotsByLine(w, -5, 50, 65, 50), 'string', 'a line past the lots splits nothing');
});

test('a delete stroke over lots empties the built ones and removes the empty ones, in one step', () => {
  const w = world();
  const ids = row(w);
  w.editBuilding(ids[1], 3, 1);
  const j = deleteLotsAlong(w, [[5, 20], [55, 20]]);
  assert.ok(typeof j !== 'string', String(j));
  // lots 0 and 2 were empty: gone; lot 1 had a building: now an empty lot
  assert.equal(alive(w), 1);
  let floors = -1;
  for (let i = 0; i < w.buildings.end; i++) if (w.buildings.alive[i]) floors = w.buildings.cols.floors[i];
  assert.equal(floors, 0);
  j.invert();
  assert.equal(alive(w), 3);
});

/// <reference types="node" />
// Building on the ground clears it: the items on a lot leave (and come back with undo), and a lot of the next cell keeps
// wild trees off its ground.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insideOutline } from '../src/core/outline.ts';

test('a point is inside a lot outline by the even-odd rule', () => {
  const square = [-5, -5, 5, -5, 5, 5, -5, 5];
  assert.equal(insideOutline(square, 0, 4, 0, 0), true);
  assert.equal(insideOutline(square, 0, 4, 6, 0), false);
  const shifted = [9, 9, ...square];
  assert.equal(insideOutline(shifted, 2, 4, 4.9, -4.9), true);
  assert.equal(insideOutline(shifted, 2, 4, -5.1, 0), false);
});

test('building on the ground removes what stood on it, and undo puts it back', async () => {
  const { World } = await import('../src/world/world.ts');
  const { Item } = await import('../src/world/items.ts');
  const { RoadJournal } = await import('../src/roads/construction/journal.ts');
  const { Zone } = await import('../src/roads/zones.ts');
  const w = new World(); w.heights.fill(10);
  const on = w.items.add([300, 300, 0, 0, Item.Tree, 0]);
  const off = w.items.add([340, 300, 0, 0, Item.Tree, 0]);
  const j = new RoadJournal(w, 'test');
  j.addBuilding({ x: 300, z: 300, w: 20, d: 30, h: 0, rot: 0.4, color: 0, seed: 7, zone: Zone.Residential, floors: 3, style: 10 });
  assert.equal(w.items.t.alive[on], 0, 'the tree on the lot left');
  assert.equal(w.items.t.alive[off], 1, 'the tree beside the lot stays');
  j.invert();
  assert.equal(w.items.t.alive[on], 1, 'undo brought it back');
});

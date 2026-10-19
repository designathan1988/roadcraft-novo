/// <reference types="node" />
// Bridge structures (Roadcraft 4.0 render/structures.ts): piers spaced by kind, kept clear of the abutments, one
// at mid-span when none fits; two-column bents sized by the deck and the pier's height.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bentColumns, pierStations, PIER_SPACING_BRIDGE, PIER_SPACING_ELEVATED } from '../src/jobs/roadMesh.ts';

test('piers every 29.6 m on land and 38.4 m over water, from half a spacing in, clear of the abutments', () => {
  const land = pierStations(0, 112, PIER_SPACING_ELEVATED, []);
  assert.deepEqual(land.map((d) => +d.toFixed(1)), [14.8, 44.4, 74], 'land');
  const water = pierStations(0, 112, PIER_SPACING_BRIDGE, []);
  assert.deepEqual(water.map((d) => +d.toFixed(1)), [19.2, 57.6, 96], 'water');
  const near = pierStations(0, 112, PIER_SPACING_ELEVATED, [40]);
  assert.ok(near.every((d) => Math.abs(d - 40) >= 10.4), `a pier within 10.4 m of the abutment: ${near}`);
  assert.deepEqual(pierStations(0, 20, PIER_SPACING_ELEVATED, []), [10], 'one at mid-span when none fits');
});

test('a bent has two columns under a street, set in from the deck edges, thicker when taller', () => {
  const low = bentColumns(5.9, 6, false), high = bentColumns(5.9, 30, false);
  assert.equal(low.offsets.length, 2);
  assert.ok(Math.abs(low.offsets[0]) <= 5.9 - low.radius - 1 + 1e-9, `column at ${low.offsets[0]} under a 5.9 m half deck`);
  assert.ok(high.width > low.width, 'a taller pier is thicker');
  assert.ok(bentColumns(5.9, 6, true).radius > low.radius, 'a bridge pier over water is thicker than a viaduct\'s');
});

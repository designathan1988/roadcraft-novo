/// <reference types="node" />
// A 4.0 building's wall height on the page is the one the worker built it to: the cell's mesh job writes each
// building's top (GenOutputs.tops, by the box's world id) and the page keeps it in the buildings' `top` column, which
// wallsHeightOf reads; it never generates the building on the page. Each building gets its own height (D65: seed 0
// and a rounded size once made different buildings share one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wallsHeightOf, type HeightRec } from '../src/jobs/buildingGen/heights.ts';
import { buildBuildings } from '../src/jobs/buildingGen.ts';
import { newOutputs } from '../src/jobs/buildingGen/outputs.ts';
import { volumes40, type Lot40 } from '../src/jobs/building40.ts';
import { emptyBoxes } from '../src/shared/contracts/worker.ts';
import { Zone } from '../src/roads/zones.ts';
import { HEIGHT_MAP_RES } from '../src/config.ts';

const expected = (b: HeightRec, i: number): number => {
  const lot: Lot40 = { cx: b.x[i], cz: b.z[i], W: b.w[i], D: b.d[i], rot: b.rot[i], use: 'residential', density: 'medium', seed: b.seed[i] || i + 1, groundAt: () => 0 };
  return Math.max(0, ...volumes40(lot).map((v) => v.y1));
};

test('D65: the worker gives each building its own built wall height, and the page reads it without generating', () => {
  const n = 8, b = emptyBoxes(n);
  b.zone.fill(Zone.Residential); b.floors.fill(3);
  for (let i = 0; i < n; i++) { b.x[i] = 40 + i * 30; b.z[i] = 40; b.w[i] = i % 2 ? 20.4 : 19.6; b.d[i] = 14 + (i % 3) * 0.3; b.id[i] = 100 + i; }
  const own = Array.from({ length: n }, (_, i) => expected(b, i));
  assert.ok(new Set(own).size > 1, `the fixture's heights differ: ${own.join(', ')}`);
  // the page's estimate before any job answered
  const page: HeightRec = { ...b, top: new Float32Array(n) };
  for (let i = 0; i < n; i++) assert.ok(wallsHeightOf(page, i) > 0, 'an estimate stands in before the build');
  // the cell's mesh job (the worker): the tops come with the mesh
  const tops = new Float32Array(n);
  buildBuildings(new Float32Array(HEIGHT_MAP_RES * HEIGHT_MAP_RES), b, 0, 0, 256, 0, false, newOutputs({ tops }));
  // (the column holds floats)
  for (let i = 0; i < n; i++) assert.equal(tops[i], Math.fround(own[i]), `building ${i} built to its own height`);
  // kept by the page (World.setBuiltTops writes the column by the box's id): read, not generated
  page.top!.set(tops);
  for (let i = 0; i < n; i++) assert.equal(wallsHeightOf(page, i), Math.fround(own[i]), `building ${i}`);
});

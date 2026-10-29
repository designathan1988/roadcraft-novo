/// <reference types="node" />
// The 4.0 building path: its world-space lot frame and the owner of a near lot's yard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { emptyBoxes, type BoxColumns } from '../src/shared/contracts/worker.ts';
import { Zone } from '../src/roads/zones.ts';
import { buildBuildings, buildBuildingParts } from '../src/jobs/buildingGen.ts';
import { buildProps, PROP } from '../src/jobs/props.ts';
import { cellId, cellX } from '../src/core/grid.ts';

function oneBuilding(zone: number, floors: number, w: number, d: number, seed: number): BoxColumns {
  const b = emptyBoxes(1);
  b.x[0] = 128; b.z[0] = 128; b.w[0] = w; b.d[0] = d; b.rot[0] = 0;
  b.zone[0] = zone; b.floors[0] = floors; b.seed[0] = seed; b.style[0] = 10; b.count = 1;
  return b;
}

test('B16: the 4.0 lot samples its slope in world coordinates', async () => {
  const { heightIndex, sampleCoord, worldOfSample } = await import('../src/world/heights.ts');
  const flat = new World(); flat.heights.fill(10);
  // flat at the origin, a 1-in-10 slope from z 400: a lot at (500, 500) climbs ~5 m to its back
  const slope = new World(); slope.heights.fill(10);
  for (let gz = sampleCoord(400); gz <= sampleCoord(600); gz++) for (let gx = sampleCoord(400); gx <= sampleCoord(600); gx++)
    slope.heights[heightIndex(gx, gz)] = 10 + Math.max(0, worldOfSample(gz) - 400) / 10;
  const b = oneBuilding(Zone.Residential, 1, 16, 30, 4242); b.x[0] = 500; b.z[0] = 500;
  const mesh = (h: Float32Array) => buildBuildings(h, b, 0, 0, 1024, 0)!;
  const onFlat = mesh(flat.heights), onSlope = mesh(slope.heights);
  const backRise = 10 + Math.max(0, 485 - 400) / 10 - (10 + Math.max(0, 515 - 400) / 10);
  assert.ok(Math.abs(backRise) > 0.3, `the case slopes (back rises ${backRise.toFixed(1)} m)`);
  assert.notEqual(onSlope.vertexCount, onFlat.vertexCount, 'a lot that climbs must terrace (different geometry than the flat one)');
  assert.ok(onSlope.vertexCount > onFlat.vertexCount, `the terracing adds geometry (${onSlope.vertexCount} vs ${onFlat.vertexCount})`);
});

test('B17: a near 4.0 lot owns its yard; a far lot without the 4.0 sink keeps the generic yard', () => {
  const w = new World(); w.heights.fill(10);
  const b = oneBuilding(Zone.Residential, 1, 16, 30, 10);
  const cell = cellId(cellX(128), cellX(128));
  const yardInLot = (parts40: boolean): number => {
    const r = buildProps(w.heights, w.roads.gather([], []), b, cell, undefined, { parts40 });
    let n = 0;
    for (let k = 0; k < r.count; k++) {
      const kind = r.extra[k] & 31;
      if (kind !== PROP.Bush && kind !== PROP.Tree && kind !== PROP.Oak && kind !== PROP.Conifer && kind !== PROP.Palm) continue;
      if (Math.abs(r.data[k * 4] - 128) <= 8 && Math.abs(r.data[k * 4 + 2] - 128) <= 15) n++;
    }
    return n;
  };
  assert.equal(yardInLot(true), 0, 'the 4.0 parts sink owns the near yard');
  assert.ok(yardInLot(false) > 0, 'without the sink the generic yard still plants');
  const parts40: string[] = [];
  const near = buildBuildingParts(w.heights, b, () => {}, undefined, (kind) => parts40.push(kind));
  const far = buildBuildingParts(w.heights, b, () => {});
  assert.deepEqual(near, [true]);
  assert.deepEqual(far, [false]);
  assert.ok(parts40.length > 0, 'the 4.0 sink received the lot parts');
});

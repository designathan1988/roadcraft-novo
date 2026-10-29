/// <reference types="node" />
// The 4.0 building path: its world-space lot frame and the owner of a near lot's yard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { emptyBoxes, type BoxColumns, type PackedMesh } from '../src/shared/contracts/worker.ts';
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

function positions(m: PackedMesh): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < m.vertexCount; i++) {
    const p = m.position, k = m.scale / 32767;
    out.push([m.originX + p[i * 4] * k, m.originY + p[i * 4 + 1] * k, m.originZ + p[i * 4 + 2] * k]);
  }
  return out;
}

/** Area of the flat upward faces by height (cm), above `minY`; the same measurement the defect list uses. */
function flatUpAreas(m: PackedMesh, minY: number): Map<number, number> {
  const p = positions(m), out = new Map<number, number>();
  for (let i = 0; i < m.index.length; i += 3) {
    const a = p[m.index[i]], b = p[m.index[i + 1]], c = p[m.index[i + 2]];
    if (Math.abs(a[1] - b[1]) > 2e-3 || Math.abs(a[1] - c[1]) > 2e-3 || a[1] < minY) continue;
    const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    if (ny <= 1e-6) continue;
    const key = Math.round(a[1] * 100);
    out.set(key, (out.get(key) ?? 0) + ny / 2);
  }
  return out;
}

/** A lid: a roof-sized level with another level at most 0.5 m over it covering >=80% of it. */
function lidOverRoof(m: PackedMesh, minY: number): string | null {
  const areas = [...flatUpAreas(m, minY)].map(([h, a]) => [h / 100, a] as const).sort((x, y) => x[0] - y[0]);
  const max = Math.max(0, ...areas.map(([, a]) => a));
  const roofSized = areas.filter(([, a]) => a >= max * 0.5 && a >= 30);
  for (let i = 0; i < roofSized.length; i++) for (let j = i + 1; j < roofSized.length; j++) {
    const [loY, loA] = roofSized[i], [hiY, hiA] = roofSized[j];
    if (hiY - loY > 0.5) continue;
    if (hiA >= loA * 0.8) return `${hiY.toFixed(2)} m covering ${(100 * hiA / loA).toFixed(0)}% of the ${loY.toFixed(2)} m level`;
  }
  return null;
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

test('B18: no 4.0 roof gets a full lid, including the terrace membrane and small porch slabs', () => {
  const w = new World(); w.heights.fill(10);
  const cases: Array<[string, BoxColumns]> = [];
  for (let seed = 1; seed <= 6; seed++) {
    cases.push([`commercial 4, seed ${seed}`, oneBuilding(Zone.Commercial, 4, 30, 40, seed * 7919)]);
    cases.push([`residential 5, seed ${seed}`, oneBuilding(Zone.Residential, 5, 30, 40, seed * 7919)]);
    cases.push([`house, seed ${seed}`, oneBuilding(Zone.Residential, 1, 16, 30, seed * 7919)]);
  }
  const failures: string[] = [];
  for (const [name, b] of cases) for (const lod of [0, 1]) {
    const m = buildBuildings(w.heights, b, 0, 0, 256, lod)!;
    const lid = lidOverRoof(m, 12.5);
    if (lid) failures.push(`${name}, level ${lod}: a lid at ${lid}`);
  }
  assert.deepEqual(failures, []);
});

test('B19: the 4.0 parts and detail passes write no vertex into a throwaway mesh', async () => {
  const { MeshBuilder } = await import('../src/jobs/meshBuilder.ts');
  const w = new World(); w.heights.fill(10);
  const b = oneBuilding(Zone.Residential, 1, 16, 30, 139);
  const vert = MeshBuilder.prototype.vert;
  let written = 0;
  MeshBuilder.prototype.vert = function (this: InstanceType<typeof MeshBuilder>, ...a: Parameters<typeof vert>) { written++; return vert.apply(this, a); };
  try {
    let parts40 = 0;
    buildBuildingParts(w.heights, b, () => {}, undefined, () => { parts40++; });
    assert.ok(parts40 > 0, 'the 4.0 sink receives the parts');
    assert.equal(written, 0, `the parts pass wrote ${written} vertices`);
    written = 0;
    const detail = buildBuildings(w.heights, b, 0, 0, 256, -1);
    assert.equal(written, detail?.vertexCount ?? 0, `the detail pass wrote ${written} vertices for a ${detail?.vertexCount ?? 0}-vertex mesh`);
  } finally { MeshBuilder.prototype.vert = vert; }
});

test('B17: near 4.0 yard plants stand on the 4.0 ground; a far lot without the sink keeps the old ground', () => {
  const w = new World(); w.heights.fill(10);
  const b = oneBuilding(Zone.Residential, 1, 16, 30, 10);
  const cell = cellId(cellX(128), cellX(128));
  const yardInLot = (parts40: boolean): { n: number; finite: boolean } => {
    const r = buildProps(w.heights, w.roads.gather([], []), b, cell, undefined, { parts40 });
    let n = 0, finite = true;
    for (let k = 0; k < r.count; k++) {
      const kind = r.extra[k] & 31;
      if (kind !== PROP.Bush && kind !== PROP.Tree && kind !== PROP.Oak && kind !== PROP.Conifer && kind !== PROP.Palm) continue;
      if (Math.abs(r.data[k * 4] - 128) <= 8 && Math.abs(r.data[k * 4 + 2] - 128) <= 15) { n++; finite &&= Number.isFinite(r.data[k * 4 + 1]); }
    }
    return { n, finite };
  };
  const near = yardInLot(true), far = yardInLot(false);
  assert.ok(near.n > 0, 'the 4.0 lot still gets the old generator\'s yard plants');
  assert.ok(near.finite, 'they stand on the 4.0 lot ground, not on a NaN');
  assert.ok(far.n > 0, 'without the sink the generic yard still plants');
  // The parts pass exposes the 4.0 ground for exactly the lots whose parts went through its sink.
  const grounds = buildBuildingParts(w.heights, b, () => {}, undefined, () => {});
  assert.equal(typeof grounds[0], 'function');
  const oldGrounds = buildBuildingParts(w.heights, b, () => {});
  assert.equal(oldGrounds[0], undefined);
});

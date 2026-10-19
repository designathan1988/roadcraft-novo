/// <reference types="node" />
// Regression tests for the building defects of DEFEITOS-roadcraft-novo.md (section F and the inside view B7-B15).
// Each one failed on the code before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { buildBuildings } from '../src/jobs/buildingGen.ts';
import { emptyBoxes, type BoxColumns, type PackedMesh } from '../src/jobs/protocol.ts';
import { Zone } from '../src/roads/zones.ts';
import { encodeDesign } from '../src/world/design.ts';
import { Fn } from '../src/world/arch.ts';

/** World positions of a packed mesh's vertices. */
function positions(m: PackedMesh): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < m.vertexCount; i++) {
    const p = m.position, k = m.scale / 32767;
    out.push([m.originX + p[i * 4] * k, m.originY + p[i * 4 + 1] * k, m.originZ + p[i * 4 + 2] * k]);
  }
  return out;
}

function flatHeights(y = 10): Float32Array {
  const w = new World();
  w.heights.fill(y);
  return w.heights;
}

/** One building at (128, 128) on a lot w × d, facing +z. */
function oneBuilding(zone: number, floors: number, w: number, d: number, seed: number, style: number): BoxColumns {
  const b = emptyBoxes(1);
  b.x[0] = 128; b.z[0] = 128; b.w[0] = w; b.d[0] = d; b.rot[0] = 0;
  b.zone[0] = zone; b.floors[0] = floors; b.seed[0] = seed; b.style[0] = style; b.count = 1;
  return b;
}

/**
 * Area of the flat upward faces of a mesh by height (cm), above `minY`. A lid over a roof shows up as a second
 * level with about the roof's area.
 */
function flatUpAreas(m: PackedMesh, minY: number): Map<number, number> {
  const p = positions(m), out = new Map<number, number>();
  for (let i = 0; i < m.index.length; i += 3) {
    const a = p[m.index[i]], b = p[m.index[i + 1]], c = p[m.index[i + 2]];
    if (Math.abs(a[1] - b[1]) > 2e-3 || Math.abs(a[1] - c[1]) > 2e-3 || a[1] < minY) continue;
    // y of the cross product: > 0 = facing up (the builder winds every triangle by its normal)
    const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    if (ny <= 1e-6) continue;
    const key = Math.round(a[1] * 100);
    out.set(key, (out.get(key) ?? 0) + ny / 2);
  }
  return out;
}

/** The heights (m) of the flat upward levels with at least half the area of the largest one. */
function bigLevels(m: PackedMesh, minY: number): number[] {
  const areas = flatUpAreas(m, minY);
  const max = Math.max(...areas.values());
  return [...areas].filter(([, a]) => a >= max * 0.5).map(([k]) => k / 100).sort((x, y) => x - y);
}

test('F2: the parapet coping and the cornice band do not put a lid over the whole roof', () => {
  const heights = flatHeights(10);
  const failures: string[] = [];
  // low blocks (parapet, cornice, slab and stepped crowns over every style), houses (the modern house slab) and designs
  const cases: Array<[string, BoxColumns]> = [];
  for (let seed = 1; seed <= 12; seed++) {
    cases.push([`commercial 4 floors, seed ${seed}`, oneBuilding(Zone.Commercial, 4, 30, 40, seed * 7919, seed * 10)]);
    cases.push([`residential 5 floors, seed ${seed}`, oneBuilding(Zone.Residential, 5, 30, 40, seed * 7919, seed * 10)]);
    cases.push([`house, seed ${seed}`, oneBuilding(Zone.Residential, 1, 16, 30, seed * 7919, seed * 10)]);
    for (const roof of [0, 1]) {
      const b = oneBuilding(Zone.Commercial, 3, 24, 30, seed * 7919, 0);
      const e = encodeDesign({ shape: 0, roof, finish: seed % 7, gear: 0, setback: 0, wall: 0xd9c7a6 });
      b.color[0] = e.color; b.h[0] = e.h;
      cases.push([`design roof ${roof}, seed ${seed}`, b]);
    }
    for (const [name, fn] of [['school', Fn.School], ['hospital', Fn.Hospital]] as const) {
      const b = oneBuilding(Zone.Commercial, 6, 50, 60, seed * 7919, 0);
      b.fn[0] = fn;
      cases.push([`${name}, seed ${seed}`, b]);
    }
  }
  for (const [name, b] of cases) for (const lod of [0, 1]) {
    const m = buildBuildings(heights, b, 0, 0, 256, lod)!;
    // above the lot's ground (10 m + the yard's 0.24 m) by a storey: only roofs and what stands on them
    const levels = bigLevels(m, 12.5);
    if (levels.length > 1) failures.push(`${name}, level ${lod}: ${levels.length} roof-sized levels at ${levels.map((y) => y.toFixed(2)).join(', ')} m`);
  }
  assert.deepEqual(failures, []);
});

test('F3: a hip roof deeper than wide covers its plan once, without holes or folds', async () => {
  const { hip } = await import('../src/jobs/buildingGen.ts');
  const { MeshBuilder } = await import('../src/jobs/meshBuilder.ts');
  for (const [w, d] of [[10, 16], [16, 10], [12, 12]]) {
    const mb = new MeshBuilder(false, true);
    const f = { cx: 0, cz: 0, c: 1, s: 0, base: 0 };
    hip(mb, f, -w / 2, w / 2, -d / 2, d / 2, 6, 3, 0x993322, 0xdddddd);
    // the roof planes, seen from above, must cover the plan with eaves exactly once
    let area = 0;
    for (let i = 0; i < mb.t; i += 3) {
      const a = mb.idx[i] * 3, b = mb.idx[i + 1] * 3, c = mb.idx[i + 2] * 3, P = mb.pos;
      if (P[a + 1] < 5.9 && P[b + 1] < 5.9 && P[c + 1] < 5.9) continue; // the soffit under the eaves
      area += Math.abs((P[b] - P[a]) * (P[c + 2] - P[a + 2]) - (P[c] - P[a]) * (P[b + 2] - P[a + 2])) / 2;
    }
    const plan = (w + 1.2) * (d + 1.2);
    assert.ok(Math.abs(area - plan) < 0.01, `${w}×${d}: the roof covers ${area.toFixed(2)} m² of a ${plan.toFixed(2)} m² plan`);
  }
});

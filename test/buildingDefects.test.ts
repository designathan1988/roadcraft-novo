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

test('F4: the detail and parts passes write no vertex into a throwaway mesh', async () => {
  const { buildBuildingParts } = await import('../src/jobs/buildingGen.ts');
  const { MeshBuilder } = await import('../src/jobs/meshBuilder.ts');
  const heights = flatHeights(10);
  const b = emptyBoxes(24);
  for (let i = 0; i < 24; i++) {
    b.x[i] = 30 + (i % 6) * 40; b.z[i] = 30 + Math.floor(i / 6) * 60; b.w[i] = 24; b.d[i] = 40; b.rot[i] = 0;
    b.zone[i] = 1 + (i % 4); b.floors[i] = 1 + (i * 5) % 20; b.seed[i] = 1000 + i * 7919; b.style[i] = i * 13;
  }
  b.count = 24;
  const vert = MeshBuilder.prototype.vert;
  let written = 0;
  MeshBuilder.prototype.vert = function (this: InstanceType<typeof MeshBuilder>, ...a: Parameters<typeof vert>) { written++; return vert.apply(this, a); };
  try {
    let parts = 0;
    buildBuildingParts(heights, b, () => { parts++; });
    assert.ok(parts > 0, 'the parts pass emits parts');
    assert.equal(written, 0, `the parts pass wrote ${written} vertices`);
    written = 0;
    const detail = buildBuildings(heights, b, 0, 0, 256, -1)!;
    assert.equal(written, detail.vertexCount, `the detail pass wrote ${written} vertices for a ${detail.vertexCount}-vertex mesh`);
  } finally { MeshBuilder.prototype.vert = vert; }
});

/** World point → lot frame (x along the front, z towards the front), as world/lotEdit.ts worldToLot. */
function toLot(b: BoxColumns, i: number, x: number, z: number): [number, number] {
  const c = Math.cos(b.rot[i]), s = Math.sin(b.rot[i]), dx = x - b.x[i], dz = z - b.z[i];
  return [dx * c - dz * s, dx * s + dz * c];
}

/** Distance from a point to the outside of a polygon (0 inside), in the polygon's frame. */
function outsideBy(p: Array<[number, number]>, x: number, z: number): number {
  let inside = false, best = Infinity;
  for (let k = 0, j = p.length - 1; k < p.length; j = k++) {
    const [ax, az] = p[j], [bx, bz] = p[k];
    if ((az > z) !== (bz > z) && x < ax + (z - az) * (bx - ax) / (bz - az)) inside = !inside;
    const dx = bx - ax, dz = bz - az, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return inside ? 0 : best;
}

test('F6: buildings, yards and walls follow the polygon the player drew', () => {
  const heights = flatHeights(10);
  // a 30 × 40 lot with its front right corner cut 12 m (counter-clockwise, lot frame, front = +z)
  const poly: Array<[number, number]> = [[-15, -20], [15, -20], [15, 8], [3, 20], [-15, 20]];
  const failures: string[] = [];
  const kinds: Array<[string, number, number, number]> = [['house', Zone.Residential, 1, 0], ['block', Zone.Residential, 5, 0],
    ['shops', Zone.Commercial, 4, 0], ['tower', Zone.Commercial, 16, 0], ['warehouse', Zone.Industrial, 2, 0], ['mixed', Zone.Mixed, 6, 0],
    ['square', Zone.Commercial, 1, Fn.Square], ['empty lot', Zone.Residential, 0, 0]];
  for (const [name, zone, floors, fn] of kinds) for (const rot of [0, 0.6]) for (const seed of [11, 222, 3333]) {
    const b = oneBuilding(zone, floors, 30, 40, seed * 7919, seed % 127);
    b.rot[0] = rot; b.fn[0] = fn; b.shapeN[0] = poly.length;
    poly.forEach(([x, z], k) => { b.shape[k * 2] = x * 10; b.shape[k * 2 + 1] = z * 10; });
    const m = buildBuildings(heights, b, 0, 0, 256, 0)!;
    const p = positions(m);
    let worst = 0;
    // only the part the player cut away (inside the lot rectangle, outside the polygon): what overhangs the
    // rectangle (awnings over the sidewalk, a crown slab over the party wall) is the same on any lot
    for (const [x, , z] of p) { const [lx, lz] = toLot(b, 0, x, z); if (Math.abs(lx) <= 15 && Math.abs(lz) <= 20) worst = Math.max(worst, outsideBy(poly, lx, lz)); }
    if (worst > 0.35) failures.push(`${name} rot ${rot} seed ${seed}: reaches ${worst.toFixed(2)} m into the cut corner`);
    // the lot's ground covers the polygon: points well inside have a face over them low down
    let bare = 0, tested = 0;
    for (let lx = -14; lx <= 14; lx += 2) for (let lz = -19; lz <= 19; lz += 2) {
      if (outsideBy(poly, lx, lz) > 0 || outsideBy(poly.map(([a, c]) => [a * 0.9, c * 0.9] as [number, number]), lx, lz) > 0) continue;
      tested++;
      const wxp = b.x[0] + lx * Math.cos(rot) + lz * Math.sin(rot), wzp = b.z[0] - lx * Math.sin(rot) + lz * Math.cos(rot);
      let covered = false;
      for (let t = 0; t < m.index.length && !covered; t += 3) {
        const A = p[m.index[t]], B = p[m.index[t + 1]], C = p[m.index[t + 2]];
        if (Math.max(A[1], B[1], C[1]) > 10.6) continue;
        const d1 = (wxp - B[0]) * (A[2] - B[2]) - (A[0] - B[0]) * (wzp - B[2]);
        const d2 = (wxp - C[0]) * (B[2] - C[2]) - (B[0] - C[0]) * (wzp - C[2]);
        const d3 = (wxp - A[0]) * (C[2] - A[2]) - (C[0] - A[0]) * (wzp - A[2]);
        covered = !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
      }
      if (!covered) bare++;
    }
    if (floors > 0 && bare > tested * 0.02) failures.push(`${name} rot ${rot} seed ${seed}: ${bare} of ${tested} points inside the lot have no ground`);
  }
  assert.deepEqual(failures, []);
});

test('F6: yard trees, shrubs and parked cars stay inside a polygon lot', async () => {
  const { lotYardProps } = await import('../src/jobs/props.ts');
  const { lotParking } = await import('../src/jobs/buildingGen.ts');
  const heights = flatHeights(10);
  const poly: Array<[number, number]> = [[-15, -20], [15, -20], [15, 8], [3, 20], [-15, 20]];
  const failures: string[] = [];
  for (const [zone, floors] of [[Zone.Residential, 1], [Zone.Residential, 2], [Zone.Mixed, 4], [Zone.Commercial, 3]]) for (const rot of [0, 0.6]) for (let seed = 1; seed <= 30; seed++) {
    const b = oneBuilding(zone, floors, 30, 40, seed * 7919, seed * 4);
    b.rot[0] = rot; b.shapeN[0] = poly.length;
    poly.forEach(([x, z], k) => { b.shape[k * 2] = x * 10; b.shape[k * 2 + 1] = z * 10; });
    lotYardProps(heights, b, (_k, x, _y, z) => {
      const [lx, lz] = toLot(b, 0, x, z), out = outsideBy(poly, lx, lz);
      if (out > 0.3) failures.push(`zone ${zone} rot ${rot} seed ${seed}: a yard prop ${out.toFixed(1)} m outside`);
    });
    const rows = lotParking(b, 0);
    for (let k = 0; k + 3 < rows.length; k += 4) for (const t of [0, 1]) {
      const lx = rows[k] + (rows[k + 2] - rows[k]) * t, lz = rows[k + 1] + (rows[k + 3] - rows[k + 1]) * t, out = outsideBy(poly, lx, lz);
      if (out > 0.3) failures.push(`zone ${zone} rot ${rot} seed ${seed}: a parking row ends ${out.toFixed(1)} m outside`);
    }
  }
  assert.deepEqual(failures.slice(0, 8), [], `${failures.length} failures`);
});

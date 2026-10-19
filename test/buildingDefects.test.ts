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

/** Top of the walls that carry windows in a generated mesh (m): where the storeys end. */
function windowTop(m: PackedMesh): number {
  const p = positions(m);
  let top = -Infinity;
  // the shader draws windows on walls (material 0), glass (3) and metal (5) with a column width
  for (let i = 0; i < m.vertexCount; i++) if (m.fac![i * 4 + 3] > 0 && [0, 3, 5].includes(m.color[i * 4 + 3] & 15)) top = Math.max(top, p[i][1]);
  return top;
}

test('B7, B8: the inside view uses the storeys the generator lays out', async () => {
  const { buildingVolumes } = await import('../src/jobs/buildingGen.ts');
  const { insidePlan } = await import('../src/render/inside.ts');
  const w = new World();
  // a slope of 1 in 6 along x: the lots' ground varies by metres
  for (let i = 0; i < w.heights.length; i++) w.heights[i] = 10;
  const { heightAt, heightIndex, sampleCoord, worldOfSample } = await import('../src/world/heights.ts');
  const slope = new World();
  // around the lots (x 60..200): ground rising 1 m every 6 m along x and 1 m every 12 m along z
  for (let gz = sampleCoord(40); gz <= sampleCoord(220); gz++) for (let gx = sampleCoord(40); gx <= sampleCoord(220); gx++) slope.heights[heightIndex(gx, gz)] = 10 + (worldOfSample(gx) - 128) / 6 + (worldOfSample(gz) - 128) / 12;
  const failures: string[] = [];
  const cases: Array<[string, number, number, number, number, number]> = [
    ['tower 30', Zone.Commercial, 30, 40, 50, 100], ['tower 45', Zone.Commercial, 45, 40, 50, 20], ['shops 5', Zone.Commercial, 5, 24, 30, 60],
    ['flats 9', Zone.Residential, 9, 26, 36, 40], ['house 1', Zone.Residential, 1, 14, 30, 10], ['sobrado 2', Zone.Residential, 2, 12, 30, 90], ['mixed 7', Zone.Mixed, 7, 20, 30, 70]];
  for (const heights of [w.heights, slope.heights]) for (const [name, zone, floors, W, D, style] of cases) for (const seed of [5, 77, 901]) {
    const b = oneBuilding(zone, floors, W, D, seed * 7919, style);
    const vols = buildingVolumes(heights, b, 0);
    const plan = insidePlan(vols, { x: 128, z: 128, w: W, d: D, rot: 0 }, 999, 1)!;
    const m = buildBuildings(heights, b, 0, 0, 256, 0)!;
    const top = windowTop(m), tag = `${name} seed ${seed}${heights === slope.heights ? ' slope' : ''}`;
    // B7: the top floor ends where the walls with windows end
    if (Math.abs(plan.storey.y + plan.storey.h - top) > 0.15) failures.push(`${tag}: top floor ${plan.storey.y.toFixed(2)} + ${plan.storey.h.toFixed(2)} vs walls up to ${top.toFixed(2)}`);
    // B8: the ground floor is not under the lot's ground anywhere on the building
    const ground = insidePlan(vols, { x: 128, z: 128, w: W, d: D, rot: 0 }, 0, 1)!.storey, v = ground.v;
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const gy = heightAt(heights, v.cx + sx * v.hw, v.cz + sz * v.hd);
      if (ground.y < gy - 0.05) failures.push(`${tag}: ground floor at ${ground.y.toFixed(2)} under the ground ${gy.toFixed(2)}`);
    }
  }
  assert.deepEqual(failures.slice(0, 10), [], `${failures.length} failures`);
});

test('B9, B14: the inside view stays in its building and cuts only above the floor', async () => {
  const { InsideView, cutYU, cutBoxU } = await import('../src/render/inside.ts');
  const { RoadJournal } = await import('../src/roads/build.ts');
  const w = new World();
  w.heights.fill(10); w.tileMin.fill(10); w.tileMax.fill(10); w.unlimited = true;
  const j = new RoadJournal(w, 'build');
  // terraced houses (sobrados, 128 + 11: walls 0.4 m apart) on deep lots (big back yards)
  const house = j.addBuilding({ x: 300, z: 300, w: 14, d: 34, h: 0, rot: 0, color: 0, seed: 4242, zone: Zone.Residential, floors: 2, style: 139 });
  j.addBuilding({ x: 286, z: 300, w: 14, d: 34, h: 0, rot: 0, color: 0, seed: 4343, zone: Zone.Residential, floors: 2, style: 139 });
  const tower = j.addBuilding({ x: 400, z: 300, w: 40, d: 50, h: 0, rot: 0.4, color: 0, seed: 99, zone: Zone.Commercial, floors: 20, style: 100 });
  j.settle();
  const view = new InsideView();
  // B9: the cut and the rooms in the house's own footprint, not the lot (the yard and the neighbour stay)
  assert.ok(view.showBuilding(w, house, 1));
  const p = view.plan!, v = p.storey.v;
  assert.ok(v.hw * 2 <= 14 && v.hd * 2 < 20, `the house is ${(v.hw * 2).toFixed(1)} × ${(v.hd * 2).toFixed(1)} m, not the 14 × 34 lot`);
  // on the cell's real mesh: what the cut discards is the house's own (roof, upper walls), never the neighbour, the
  // lots' ground and walls or the trees, even where the cut box takes them in
  const cellMesh = buildBuildings(w.heights, w.gatherBoxes([w.buildings.cols.cell[house]]), 0, 0, 256, 0)!;
  const cp = positions(cellMesh), c = Math.cos(p.cut.rot), sn = Math.sin(p.cut.rot);
  let cut = 0, spared = 0;
  for (let i = 0; i < cellMesh.vertexCount; i++) {
    const [x, y, z] = cp[i], dx = x - p.cut.x, dz = z - p.cut.z;
    if (Math.abs(dx * c - dz * sn) >= p.cut.hw || Math.abs(dx * sn + dz * c) >= p.cut.hd || y <= p.cut.y) continue;
    if (cellMesh.position[i * 4 + 3] === p.cut.tag) cut++; else spared++;
  }
  assert.ok(cut > 0, 'the house above the floor is cut');
  assert.ok(spared > 0, 'the cut box takes in the neighbour, and it stays');
  // B14: only what is above the chosen floor's walls is cut
  assert.equal(cutYU.value, p.storey.y + 1.4);
  assert.equal(cutBoxU.value.z, p.cut.hw);
  // the tower: storeys of the generator (20), any floor
  assert.ok(view.showBuilding(w, tower, 19));
  assert.equal(view.plan!.floors, 20);
});

test('B12: the inside view opens the building in view, not a selection left far away', async () => {
  const { insideTarget } = await import('../src/render/inside.ts');
  const { RoadJournal } = await import('../src/roads/build.ts');
  const w = new World();
  w.heights.fill(10); w.tileMin.fill(10); w.tileMax.fill(10); w.unlimited = true;
  const j = new RoadJournal(w, 'build');
  const far = j.addBuilding({ x: -3000, z: -3000, w: 20, d: 30, h: 0, rot: 0, color: 0, seed: 1, zone: Zone.Commercial, floors: 6, style: 0 });
  const here = j.addBuilding({ x: 1000, z: 1000, w: 20, d: 30, h: 0, rot: 0, color: 0, seed: 2, zone: Zone.Commercial, floors: 6, style: 0 });
  j.settle();
  // looking at "here" from 200 m, with "far" still selected
  assert.deepEqual(insideTarget(w, far, 1000, 1000, 200), { id: here, go: false });
  // the selection in view is the one opened, even off the centre
  assert.deepEqual(insideTarget(w, here, 1040, 980, 200), { id: here, go: false });
  assert.deepEqual(insideTarget(w, -1, 1000, 1000, 200), { id: here, go: false });
  // nothing in view: the selected one, and the camera goes to it
  assert.deepEqual(insideTarget(w, far, 0, 0, 200), { id: far, go: true });
});

test('B11: the inside view goes with its building (demolished, a new city) and follows its edits', async () => {
  const { InsideView, cutYU } = await import('../src/render/inside.ts');
  const { RoadJournal } = await import('../src/roads/build.ts');
  const w = new World();
  w.heights.fill(10); w.tileMin.fill(10); w.tileMax.fill(10); w.unlimited = true;
  const j = new RoadJournal(w, 'build');
  const house = j.addBuilding({ x: 300, z: 300, w: 14, d: 34, h: 0, rot: 0, color: 0, seed: 4242, zone: Zone.Residential, floors: 2, style: 139 });
  const tower = j.addBuilding({ x: 400, z: 300, w: 40, d: 50, h: 0, rot: 0.4, color: 0, seed: 99, zone: Zone.Commercial, floors: 20, style: 100 });
  j.settle();
  const view = new InsideView();
  assert.ok(view.showBuilding(w, tower, 19));
  // B11: editing the building lays it out again; demolishing it, undoing its building, a new city: gone
  const before = view.plan!.storey.y;
  w.editBuilding(tower, 30, w.buildings.cols.style[tower]);
  view.follow(w);
  assert.ok(view.on && (view.plan!.floors as number) === 30 && view.plan!.storey.y === before, 'edited: same floor, 30 storeys');
  const k = new RoadJournal(w, 'demolish');
  k.removeBuilding(tower); k.settle();
  view.follow(w);
  assert.equal(view.on, false, 'demolished: the inside view is gone');
  assert.equal(cutYU.value, 1e9, 'and nothing is cut');
  assert.ok(view.showBuilding(w, house, 0));
  w.clearBuildings();
  view.follow(w);
  assert.equal(view.on, false, 'another city: gone');
});

test('B15: the camera and the collapse use the height the generator builds', async () => {
  const { wallsHeight, buildingVolumes } = await import('../src/jobs/buildingGen.ts');
  const { storeyLevels } = await import('../src/render/inside.ts');
  const heights = flatHeights(10);
  const failures: string[] = [];
  const cases: Array<[string, number, number, number, number, number]> = [
    ['tower 30', Zone.Commercial, 30, 40, 50, 100], ['tower 45', Zone.Commercial, 45, 40, 50, 20], ['shops 5', Zone.Commercial, 5, 24, 30, 60],
    ['flats 9', Zone.Residential, 9, 26, 36, 40], ['house 1', Zone.Residential, 1, 14, 30, 10], ['sobrado 2', Zone.Residential, 2, 12, 30, 90], ['mixed 7', Zone.Mixed, 7, 20, 30, 70]];
  for (const [name, zone, floors, W, D, style] of cases) for (const seed of [5, 77, 901]) {
    const b = oneBuilding(zone, floors, W, D, seed * 7919, style);
    const top = windowTop(buildBuildings(heights, b, 0, 0, 256, 0)!), ground = storeyLevels(buildingVolumes(heights, b, 0))[0].y;
    const est = wallsHeight(zone, floors, 128, 128, style, 0, 0, 0) + ground;
    if (Math.abs(est - top) > 0.6) failures.push(`${name} seed ${seed}: walls estimated up to ${est.toFixed(2)}, built up to ${top.toFixed(2)}`);
  }
  assert.deepEqual(failures, []);
});

test('F5: the creator reaches all 13 finishes by its choices, and "Vidro" is glass', async () => {
  const { FIN, FINISH_COUNT } = await import('../src/jobs/buildingFinishes.ts');
  const { FINISHES, ROOFS } = await import('../src/world/design.ts');
  const heights = flatHeights(10);
  /** The finish ids a design puts on the mesh, for every one of 5 seeds (by choice, not by luck). */
  const finishesOf = (finish: number, roof: number): Set<number> => {
    let common = null as Set<number> | null;
    for (const seed of [1, 22, 333, 4444, 55555]) {
      const b = oneBuilding(Zone.Commercial, 4, 24, 30, seed, 0);
      const e = encodeDesign({ shape: 0, roof, finish, gear: 0, setback: 0, wall: 0xd9c7a6 });
      b.color[0] = e.color; b.h[0] = e.h;
      const m = buildBuildings(heights, b, 0, 0, 256, 0)!, here = new Set<number>();
      for (let i = 0; i < m.vertexCount; i++) here.add(m.color[i * 4 + 3] >> 4);
      common = common ? new Set([...common].filter((f) => here.has(f))) : here;
    }
    return common!;
  };
  const reached = new Set<number>();
  for (let f = 0; f < FINISHES.length; f++) for (let r = 0; r < ROOFS.length; r++) for (const id of finishesOf(f, r)) reached.add(id);
  const missing = Object.entries(FIN).filter(([, id]) => id > 0 && !reached.has(id)).map(([n]) => n);
  assert.deepEqual(missing, [], `${FINISH_COUNT - missing.length} of ${FINISH_COUNT} finishes reachable`);
  assert.ok(finishesOf(FINISHES.indexOf('Vidro'), 0).has(FIN.Glass), '"Vidro" puts glass on the walls');
});

test('F9: civic buildings and warehouses fit their lot', () => {
  const heights = flatHeights(10);
  const failures: string[] = [];
  const kinds: Array<[string, number, number]> = [['school', Zone.Residential, Fn.School], ['church', Zone.Residential, Fn.Church], ['hospital', Zone.Commercial, Fn.Hospital],
    ['clinic', Zone.Residential, Fn.Clinic], ['gas station', Zone.Commercial, Fn.GasStation], ['supermarket', Zone.Commercial, Fn.Supermarket],
    ['city hall', Zone.Commercial, Fn.CityHall], ['police', Zone.Commercial, Fn.Police], ['fire station', Zone.Commercial, Fn.FireStation],
    ['mall', Zone.Commercial, Fn.Mall], ['sports court', Zone.Residential, Fn.SportsCourt], ['square', Zone.Commercial, Fn.Square], ['warehouse', Zone.Industrial, 0]];
  for (const [name, zone, fn] of kinds) for (const [W, D] of [[18, 26], [24, 32], [30, 44], [50, 60]]) for (const seed of [3, 44]) {
    const b = oneBuilding(zone, 3, W, D, seed * 7919, 0);
    b.fn[0] = fn;
    const m = buildBuildings(heights, b, 0, 0, 256, 0)!;
    let worst = 0;
    // past the sides or the back of the lot; the front may overhang the sidewalk (marquees, canopies)
    for (const [x, , z] of positions(m)) worst = Math.max(worst, Math.abs(x - 128) - W / 2, 128 - D / 2 - z, z - (128 + D / 2) - 3);
    if (worst > 0.7) failures.push(`${name} on ${W}×${D}: ${worst.toFixed(1)} m past the lot`);
  }
  assert.deepEqual(failures, []);
});

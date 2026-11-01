// The building levels' geometric error, measured the way a level switch sees it: the skyline - a level may not drop
// the tallest thing the near level draws by more than its own reference. The mast that broke this (3.5 m off the far
// level, 8 cm thick but it.h tall, skipped for its thickness) is the contract's history; the tiles' and plates' drops
// are 4.0's (massing.ts TILE 1.4, PLATE 8), and the switch distances derive from the levels' errors through the
// screen-space-error rule (viewError.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { emptyBoxes, type BoxColumns, type PackedMesh } from '../src/shared/contracts/worker.ts';
import { Zone } from '../src/roads/zones.ts';
import { buildBuildings } from '../src/jobs/buildingGen.ts';
import { TILE_DETAIL, PLATE_DETAIL } from '../src/r40/render/buildings/massing.ts';
import { FLAT_DEPTH } from '../src/r40/render/buildings/meshCore.ts';
import { FINE_PIXELS, NEAR_PIXELS, PX_PER_METRE_AT_1080, distanceForError, viewScale } from '../src/render/viewError.ts';

/** The mesh's skyline: its highest vertex (the packed position carries four numbers a vertex). */
function topOf(mesh: PackedMesh): number {
  const k = mesh.scale / 32767;
  let top = -Infinity;
  for (let i = 0; i < mesh.vertexCount; i++) top = Math.max(top, mesh.originY + mesh.position[i * 4 + 1]! * k);
  return top;
}

/** A packed mesh from flat [x, y, z] points (the metric's synthetic cases only). */
const mk = (pts: number[], idx: number[]): PackedMesh => {
  const packed = new Int16Array((pts.length / 3) * 4);
  for (let i = 0, j = 0; i < pts.length; i += 3, j += 4) { packed[j] = pts[i]!; packed[j + 1] = pts[i + 1]!; packed[j + 2] = pts[i + 2]!; }
  return {
    originX: 0, originY: 0, originZ: 0, scale: 32767, vertexCount: pts.length / 3, minY: Math.min(...pts.filter((_, i) => i % 3 === 1)), maxY: Math.max(...pts.filter((_, i) => i % 3 === 1)),
    position: packed, normal: new Int8Array(packed.length), color: new Uint8Array(packed.length),
    index: new Uint32Array(idx),
  };
};

test('the mass levels keep the 4.0 drops', () => {
  assert.equal(TILE_DETAIL.drop, 1.4, `the tile's drop is 4.0's 1.4 m (got ${TILE_DETAIL.drop})`);
  assert.equal(TILE_DETAIL.boxes, false);
  assert.equal(PLATE_DETAIL.drop, 8, `the plate's drop is 4.0's 8 m (got ${PLATE_DETAIL.drop})`);
  assert.equal(PLATE_DETAIL.boxes, true);
});

test('the switch distances derive from the levels\' own errors (1080p, 45°)', () => {
  const farError = Math.max(1.5, TILE_DETAIL.drop); // the far level's and the tile masses' attributed error
  assert.equal(PX_PER_METRE_AT_1080 > 1303 && PX_PER_METRE_AT_1080 < 1305, true, '1080 px at 45° fov is ~1304 px per metre');
  assert.ok(Math.abs(distanceForError(farError, NEAR_PIXELS) - 978) < 1, `the near switch is 978 m (got ${distanceForError(farError, NEAR_PIXELS).toFixed(1)})`);
  assert.ok(Math.abs(distanceForError(FLAT_DEPTH, FINE_PIXELS) - 782) < 1, `the facade switch is 782 m (got ${distanceForError(FLAT_DEPTH, FINE_PIXELS).toFixed(1)})`);
  assert.ok(Math.abs(distanceForError(PLATE_DETAIL.drop, NEAR_PIXELS) - 5216) < 2, `the plate switch is 5216 m (got ${distanceForError(PLATE_DETAIL.drop, NEAR_PIXELS).toFixed(1)})`);
  // the rule: at the switch distance the error spans exactly its pixel budget
  const d = distanceForError(1.5, NEAR_PIXELS);
  assert.ok(Math.abs(1.5 * (PX_PER_METRE_AT_1080 / d) - NEAR_PIXELS) < 1e-9, 'SSE = error * pxPerMetre / distance hits the threshold');
});

test('the view scale follows the real projection (fov, ortho zoom)', () => {
  const persp = { isOrthographicCamera: false as const, fov: 45 };
  assert.ok(Math.abs(viewScale(persp as never, 1080) - 1) < 1e-9, '1080 px at 45° is the reference (scale 1)');
  assert.ok(viewScale({ ...persp, fov: 60 } as never, 1080) < 1, 'a wider fov sees fewer px per metre');
  assert.ok(viewScale(persp as never, 2160) >= 2, 'more pixels, coarser levels run out nearer');
  const ortho = { isOrthographicCamera: true, top: 500, bottom: -500 };
  const base = viewScale(ortho as never, 1304);
  assert.ok(Math.abs(base - 1.304 / PX_PER_METRE_AT_1080) < 1e-9, `ortho 1304 px over a 1000 m frustum reads 1.304 px per metre against the reference's ${PX_PER_METRE_AT_1080.toFixed(1)} (got ${base.toFixed(5)})`);
  const zoomed = viewScale({ isOrthographicCamera: true, top: 250, bottom: -250 } as never, 1304);
  assert.ok(Math.abs(zoomed - 2 * base) < 1e-6, 'zooming in (half the frustum) doubles the scale');
});

const w = new World();
w.heights.fill(10);

function one(zone: number, floors: number, wd: number, dd: number, seed: number, style: number): BoxColumns {
  const b = emptyBoxes(1);
  b.x[0] = 128; b.z[0] = 128; b.w[0] = wd; b.d[0] = dd; b.rot[0] = 0;
  b.zone[0] = zone; b.floors[0] = floors; b.seed[0] = seed; b.style[0] = style; b.count = 1;
  return b;
}

/** The skyline each level may lose: 4.0 massCells.ts:19 gives the far level 1.5 m; the plate's is its own 8 m drop
 *  (its boxes flatten pitched roofs of up to that rise). The tile's is its drop over the far level's floor. */
test('no level drops the skyline by more than its reference', () => {
  const cases: Array<[string, number, number, number, number, number, number]> = [
    ['res tower', Zone.Residential, 5, 30, 40, 7919, 10],
    ['res medium', Zone.Residential, 5, 30, 40, 104729, 7],
    ['shop', Zone.Commercial, 4, 30, 40, 7919, 10],
    ['office tower', Zone.Commercial, 8, 30, 40, 7919, 3],
    ['house', Zone.Residential, 1, 16, 30, 7919, 10],
    ['mixed', Zone.Mixed, 6, 26, 36, 7919, 5],
  ];
  const worst = { l1: 0, l2: 0, l3: 0, at: '' };
  for (const [name, zone, floors, wd, dd, seed, style] of cases) {
    const b = one(zone, floors, wd, dd, seed, style);
    const t0 = topOf(buildBuildings(w.heights, b, 0, 0, 256, 0)!);
    for (const lod of [1, 2, 3]) {
      const drop = t0 - topOf(buildBuildings(w.heights, b, 0, 0, 256, lod)!);
      if (lod === 1 && drop > worst.l1) { worst.l1 = drop; worst.at = `${name} L1`; }
      if (lod === 2 && drop > worst.l2) { worst.l2 = drop; worst.at = `${name} L2`; }
      if (lod === 3 && drop > worst.l3) { worst.l3 = drop; worst.at = `${name} L3`; }
    }
  }
  assert.ok(worst.l1 <= 1.5, `the facade level drops ${worst.l1.toFixed(2)} m of the skyline at ${worst.at}; the far level carries 1.5 m`);
  assert.ok(worst.l2 <= Math.max(1.5, TILE_DETAIL.drop), `the tile level drops ${worst.l2.toFixed(2)} m at ${worst.at}; it carries ${TILE_DETAIL.drop} m over the 1.5 m floor`);
  assert.ok(worst.l3 <= PLATE_DETAIL.drop, `the plate level drops ${worst.l3.toFixed(2)} m at ${worst.at}; its drop is ${PLATE_DETAIL.drop} m`);
});

test('a sweep of styles and floors keeps the far level too', () => {
  const zones = [Zone.Residential, Zone.ResHigh, Zone.Commercial, Zone.Mixed];
  let worst = { drop: 0, at: '' };
  for (let k = 0; k < 12; k++) {
    const b = one(zones[k % 4]!, 1 + ((k * 3) % 10), 24 + (k % 3) * 6, 30 + (k % 4) * 5, 31_133 + k * 97, (k * 5) % 12);
    const t0 = topOf(buildBuildings(w.heights, b, 0, 0, 256, 0)!);
    const drop = t0 - topOf(buildBuildings(w.heights, b, 0, 0, 256, 1)!);
    if (drop > worst.drop) worst = { drop, at: `case ${k} (zone ${zones[k % 4]}, floors ${1 + ((k * 3) % 10)}, style ${(k * 5) % 12})` };
  }
  assert.ok(worst.drop <= 1.5, `the facade level drops ${worst.drop.toFixed(2)} m at ${worst.at}; the reference is 1.5 m`);
});

// the metric's meaning, on synthetic pairs: a feature reads as itself, never as its distance to the mass
test('the feature metric reads a rooftop mast as its height', () => {
  const mast = mk([5, 10, 5, 5, 14, 5, 5.1, 10, 5.1, 5.1, 14, 5.1, 0, 0], [0, 2, 3, 0, 3, 1]);
  const k = mast.scale / 32767;
  let top = -Infinity;
  for (let i = 0; i < mast.vertexCount; i++) top = Math.max(top, mast.position[i * 4 + 1]! * k);
  const slabTop = 10;
  assert.ok(Math.abs(top - slabTop - 4) < 0.01 && top > slabTop, `the mast tops the slab by its own 4 m (got ${(top - slabTop).toFixed(2)})`);
});

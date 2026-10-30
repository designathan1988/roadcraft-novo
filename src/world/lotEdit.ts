// Lot editing. The building record is the lot (centre, front w, depth d, rotation, zone) plus, for a polygon lot,
// its corners (World.lotShape, see BoxColumns.shape). Splitting, joining, deleting, turning the front, moving
// corners, cutting by a line and curving a side all swap records in a journal (undo comes back with the same ids).
// An empty lot is a record with 0 floors: marked on the ground and taken, so growth does not build on it.
// Every operation works on the outline in world coordinates and frames the result again (`frameLot`): the record
// keeps the bounding rectangle in the lot's frame and the polygon, or just the rectangle when the piece is one.
// Messages returned as strings are shown to the player (pt-BR).

import { Rng } from '../core/rng.ts';
import { SHAPE_MAX } from '../shared/contracts/worker.ts';
import { RoadJournal } from '../roads/build.ts';
import { bez, closestT } from '../roads/geometry.ts';
import { PROFILE_INFO } from '../roads/profiles.ts';
import { floorsFor } from './growth.ts';
import { heightAt } from './heights.ts';
import { waterAt } from './ground.ts';
import { World, polygonArea, type BuildingRec } from './world.ts';

/** Shortest side of a lot (m). */
export const MIN_LOT = 6;

export type SplitKind = 'side' | 'depth';

type Pt = [number, number];
interface Frame { x: number; z: number; rot: number }

function rec(world: World, id: number): BuildingRec {
  return World.recOf(world.buildingRec(id));
}

/** Point of the lot in local coordinates (x along the front, z towards the front) to the world. */
export function lotToWorld(r: Frame, lx: number, lz: number): [number, number] {
  const c = Math.cos(r.rot), s = Math.sin(r.rot);
  return [r.x + lx * c + lz * s, r.z - lx * s + lz * c];
}

/** World point in the lot frame (inverse of lotToWorld). */
export function worldToLot(r: Frame, x: number, z: number): [number, number] {
  const c = Math.cos(r.rot), s = Math.sin(r.rot), dx = x - r.x, dz = z - r.z;
  return [dx * c - dz * s, dx * s + dz * c];
}

// ------------------------------------------------------------------ polygon helpers

/** Even-odd point in polygon. */
export function pointInPolygon(p: Pt[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, zi] = p[i], [xj, zj] = p[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

const flat = (p: Pt[]): number[] => p.flatMap(([x, z]) => [x, z]);
const area = (p: Pt[]): number => polygonArea(flat(p));

function segsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
}

/** No two non-adjacent edges cross. */
export function isSimple(p: Pt[]): boolean {
  const n = p.length;
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    if (segsCross(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n])) return false;
  }
  return true;
}

/** Drops repeated points and points on a straight line between their neighbours. */
function tidy(p: Pt[]): Pt[] {
  let out = p.filter((q, i) => Math.hypot(q[0] - p[(i + 1) % p.length][0], q[1] - p[(i + 1) % p.length][1]) > 0.05);
  for (let changed = true; changed && out.length > 3;) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i + out.length - 1) % out.length], b = out[i], c = out[(i + 1) % out.length];
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (Math.abs(cross) < 0.02 * Math.max(1, Math.hypot(c[0] - a[0], c[1] - a[1]))) { out = out.filter((_, k) => k !== i); changed = true; break; }
    }
  }
  return out;
}

/** Keeps the part of the polygon where n·p <= c (Sutherland-Hodgman against one half-plane). */
export function clipHalf(p: Pt[], nx: number, nz: number, c: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    const da = a[0] * nx + a[1] * nz - c, db = b[0] * nx + b[1] * nz - c;
    if (da <= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) { const t = da / (da - db); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
  }
  return out.length >= 3 ? tidy(out) : [];
}

/**
 * Frames a lot outline (world points) in the rotation `rot`: the record's centre, w and d are the bounding
 * rectangle in that frame, and the corners go in `shape` (counter-clockwise) unless the outline is that rectangle.
 */
export function frameLot(world: Pt[], rot: number): { x: number; z: number; w: number; d: number; rot: number; shape?: number[] } | null {
  let pts = tidy(world);
  if (pts.length < 3) return null;
  if (area(pts) < 0) pts = pts.reverse();
  const o = { x: 0, z: 0, rot };
  const loc = pts.map(([x, z]) => worldToLot(o, x, z));
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of loc) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const w = x1 - x0, d = z1 - z0;
  if (w < MIN_LOT - 1e-6 || d < MIN_LOT - 1e-6) return null;
  const [cx, cz] = lotToWorld(o, (x0 + x1) / 2, (z0 + z1) / 2);
  const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
  const local: Pt[] = loc.map(([x, z]) => [x - mx, z - mz]);
  const isRect = local.length === 4 && local.every(([x, z]) => Math.abs(Math.abs(x) - w / 2) < 0.05 && Math.abs(Math.abs(z) - d / 2) < 0.05);
  if (local.length > SHAPE_MAX) return null;
  return { x: cx, z: cz, w, d, rot, shape: isRect ? undefined : flat(local) };
}

/** A lot's outline in world coordinates (its polygon, or the four corners of its rectangle). */
export function lotOutlineWorld(world: World, id: number): Pt[] {
  const c = world.buildings.cols, o = world.lotOutline(id), f = { x: c.x[id], z: c.z[id], rot: c.rot[id] }, out: Pt[] = [];
  for (let k = 0; k < o.length; k += 2) out.push(lotToWorld(f, o[k], o[k + 1]));
  return out;
}

/** Lot (record) under the point, or −1. */
export function lotAt(world: World, x: number, z: number): number {
  const col = world.buildings.cols;
  let best = -1, bd = Infinity;
  world.buildingIndex.query(x - 90, z - 90, x + 90, z + 90, (id) => {
    const [lx, lz] = worldToLot({ x: col.x[id], z: col.z[id], rot: col.rot[id] }, x, z);
    if (Math.abs(lx) > col.w[id] / 2 + 0.5 || Math.abs(lz) > col.d[id] / 2 + 0.5) return;
    if (col.shapeN[id]) {
      const o = world.lotPolygon(id), p: Pt[] = [];
      for (let k = 0; k < o.length; k += 2) p.push([o[k], o[k + 1]]);
      if (!pointInPolygon(p, lx, lz)) return;
    }
    const d = lx * lx + lz * lz;
    if (d < bd) { bd = d; best = id; }
  });
  return best;
}

/** A child lot of `r` with a new seed (k-th piece), the floors drawn again if it was built. */
function child(r: BuildingRec, k: number, framed: NonNullable<ReturnType<typeof frameLot>>): BuildingRec {
  const seed = (Math.imul(r.seed ^ 0x9e3779b9, k + 1) + k * 7919) >>> 0;
  const floors = r.floors === 0 ? 0 : floorsFor(r.zone, 0, new Rng(seed));
  return { ...r, ...framed, shape: framed.shape, seed, floors, fn: 0, built: undefined };
}

/** Replaces lot `id` by the outlines `pieces` (world points), all in the lot's own rotation. */
function replaceBy(world: World, id: number, pieces: Pt[][], label: string): RoadJournal | string {
  const r = rec(world, id);
  const framed = pieces.map((p) => frameLot(p, r.rot));
  if (framed.some((f) => !f) || pieces.some((p) => Math.abs(area(p)) < MIN_LOT * MIN_LOT)) return 'não sobra um lote que valha a pena aí';
  const j = new RoadJournal(world, label);
  j.removeBuilding(id);
  framed.forEach((f, k) => j.addBuilding(child(r, k, f!)));
  return j;
}

/**
 * Whether a lot outline (world points) may stand there: a simple polygon, clear of every road's footprint and not
 * overlapping another lot (`ignore`: the lots it replaces). '' when it fits, otherwise the reason for the player.
 * Queries only the spatial indexes around the outline.
 */
export function lotFits(world: World, outline: Pt[], ignore: readonly number[] = []): string {
  if (outline.length < 3 || !isSimple(outline)) return 'os lados do lote se cruzam';
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of outline) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  // roads: no point of the outline's edges (every metre) on a carriageway or sidewalk, no centreline inside
  const net = world.roads, sc = net.segs.cols, q = { x0: 0, z0: 0, cx: 0, cz: 0, x1: 0, z1: 0 }, p = new Float64Array(2);
  let onRoad = false;
  net.forSegsNear(x0 - 30, z0 - 30, x1 + 30, z1 + 30, (s) => {
    if (onRoad) return;
    net.quad(s, q);
    const half = PROFILE_INFO[sc.profile[s]].right - 0.3;
    for (let i = 0; i < outline.length && !onRoad; i++) {
      const [ax, az] = outline[i], [bx, bz] = outline[(i + 1) % outline.length];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az)));
      for (let k = 0; k <= n; k++) if (closestT(q, ax + (bx - ax) * k / n, az + (bz - az) * k / n)[1] < half) { onRoad = true; break; }
    }
    for (let k = 0; k <= 16 && !onRoad; k++) { bez(q, k / 16, p); if (pointInPolygon(outline, p[0], p[1])) onRoad = true; }
  });
  if (onRoad) return 'o lote ficaria sobre uma via';
  // water: the outline and the middle must stand on ground above the water line
  const wet = (x: number, z: number) => waterAt(world.water, x, z) > heightAt(world.heights, x, z) - 0.5;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  if (wet(cx, cz)) return 'o lote ficaria sobre a água';
  for (let i = 0; i < outline.length; i++) {
    const [ax, az] = outline[i], [bx, bz] = outline[(i + 1) % outline.length];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 4));
    for (let k = 0; k <= n; k++) if (wet(ax + (bx - ax) * k / n, az + (bz - az) * k / n)) return 'o lote ficaria sobre a água';
  }
  // other lots: edges crossing, or a corner (pulled 0.3 m inwards) inside the other one; touching is fine
  const shrink = (o: Pt[]): Pt[] => {
    const cx = o.reduce((s, v) => s + v[0], 0) / o.length, cz = o.reduce((s, v) => s + v[1], 0) / o.length;
    return o.map(([x, z]) => { const l = Math.hypot(x - cx, z - cz) || 1; return [x + (cx - x) / l * 0.3, z + (cz - z) / l * 0.3] as Pt; });
  };
  const mine = shrink(outline);
  let hit = false;
  world.buildingIndex.query(x0 - 120, z0 - 120, x1 + 120, z1 + 120, (id) => {
    if (hit || ignore.includes(id)) return;
    const other = shrink(lotOutlineWorld(world, id));
    if (mine.some(([x, z]) => pointInPolygon(other, x, z)) || other.some(([x, z]) => pointInPolygon(mine, x, z))) { hit = true; return; }
    for (let i = 0; i < mine.length && !hit; i++) for (let k = 0; k < other.length; k++) {
      if (segsCross(mine[i], mine[(i + 1) % mine.length], other[k], other[(k + 1) % other.length])) { hit = true; break; }
    }
  });
  return hit ? 'o lote ficaria sobre outro lote' : '';
}

// ------------------------------------------------------------------ edits

/** Splits the lot into `n` equal strips: side by side (along the front) or front and back. */
export function splitLot(world: World, id: number, kind: SplitKind, n: number): RoadJournal | string {
  const r = rec(world, id);
  const along = kind === 'side' ? r.w : r.d;
  if (along / n < MIN_LOT) return 'não sobra um lote que valha a pena aí';
  const f = { x: r.x, z: r.z, rot: r.rot };
  const local = world.lotOutline(id);
  const poly: Pt[] = [];
  for (let k = 0; k < local.length; k += 2) poly.push([local[k], local[k + 1]]);
  const pieces: Pt[][] = [];
  for (let k = 0; k < n; k++) {
    const a = -along / 2 + k * along / n, b = a + along / n;
    // strip a <= coord <= b along x (side) or z (depth)
    const nx = kind === 'side' ? 1 : 0, nz = kind === 'side' ? 0 : 1;
    let piece = clipHalf(poly, nx, nz, b);
    piece = piece.length ? clipHalf(piece, -nx, -nz, -a) : [];
    if (piece.length < 3) return 'não sobra um lote que valha a pena aí';
    pieces.push(piece.map(([x, z]) => lotToWorld(f, x, z)));
  }
  return replaceBy(world, id, pieces, 'dividir lote');
}

/** Cuts the lot in two along the line through (ax, az) and (bx, bz) (Roadcraft "split by line"). */
export function splitLotByLine(world: World, id: number, ax: number, az: number, bx: number, bz: number): RoadJournal | string {
  const L = Math.hypot(bx - ax, bz - az);
  if (L < 1) return 'trace uma linha que atravesse o lote';
  const nx = -(bz - az) / L, nz = (bx - ax) / L, c = ax * nx + az * nz;
  const poly = lotOutlineWorld(world, id);
  const one = clipHalf(poly, nx, nz, c), two = clipHalf(poly, -nx, -nz, -c);
  if (one.length < 3 || two.length < 3) return 'a linha não atravessa o lote';
  return replaceBy(world, id, [one, two], 'dividir lote por linha');
}

/**
 * Lot made from a drawn polygon (world points): frame of the smallest rectangle, front on the first side clicked.
 * With the world, it must also fit there (`lotFits`).
 */
export function polygonLot(pts: Pt[], world?: World): { x: number; z: number; w: number; d: number; rot: number; shape?: number[] } | string {
  if (pts.length < 3) return 'clique pelo menos três cantos';
  const p = tidy(pts);
  if (p.length < 3) return 'clique pelo menos três cantos';
  if (p.length > SHAPE_MAX) return `no máximo ${SHAPE_MAX} cantos`;
  if (!isSimple(p)) return 'os lados do lote se cruzam';
  const fits = world ? lotFits(world, p) : '';
  if (fits) return fits;
  const frame = polygonRect(p);
  if (!frame) return 'não cabe um lote aí';
  return frameLot(p, frame.rot) ?? 'não cabe um lote aí';
}

/** Joins two neighbouring lots into one: aligned rectangles sharing a side, or any two lots sharing a whole edge. */
export function joinLots(world: World, a: number, b: number): RoadJournal | string {
  if (a === b) return 'escolha dois lotes diferentes';
  const ra = rec(world, a), rb = rec(world, b);
  const A = lotOutlineWorld(world, a), B = lotOutlineWorld(world, b);
  const near = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1.5;
  let merged: Pt[] | null = null;
  // a whole edge in common (both counter-clockwise: it runs the other way in B)
  for (let i = 0; i < A.length && !merged; i++) for (let j = 0; j < B.length && !merged; j++) {
    if (near(A[i], B[(j + 1) % B.length]) && near(A[(i + 1) % A.length], B[j])) {
      merged = [];
      for (let k = 0; k < A.length; k++) merged.push(A[(i + 1 + k) % A.length]);
      for (let k = 2; k < B.length; k++) merged.push(B[(j + k) % B.length]);
    }
  }
  // aligned rectangles side by side whose sides differ in length are still joined as their union rectangle
  if (!merged && !ra.shape && !rb.shape) {
    const dr = ((rb.rot - ra.rot) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
    if (Math.abs(dr) < 0.05 || Math.abs(Math.abs(dr) - Math.PI) < 0.05) {
      const [bx, bz] = worldToLot(ra, rb.x, rb.z), tol = 1.5;
      const side = Math.abs(bz) < tol && Math.abs(rb.d - ra.d) < tol && Math.abs(Math.abs(bx) - (ra.w + rb.w) / 2) < tol;
      const back = Math.abs(bx) < tol && Math.abs(rb.w - ra.w) < tol && Math.abs(Math.abs(bz) - (ra.d + rb.d) / 2) < tol;
      if (side || back) merged = [...A, ...B];
      if (merged) {
        // the union of two aligned rectangles is their bounding rectangle
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (const [x, z] of merged) { const [lx, lz] = worldToLot(ra, x, z); x0 = Math.min(x0, lx); x1 = Math.max(x1, lx); z0 = Math.min(z0, lz); z1 = Math.max(z1, lz); }
        merged = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].map(([x, z]) => lotToWorld(ra, x, z));
      }
    }
  }
  if (!merged) return 'esses lotes não têm um lado em comum';
  const f = frameLot(merged, ra.rot);
  if (!f) return 'esses lotes não têm um lado em comum';
  const fits = lotFits(world, merged, [a, b]);
  if (fits) return fits;
  const j = new RoadJournal(world, 'juntar lotes');
  j.removeBuilding(a); j.removeBuilding(b);
  j.addBuilding({ ...ra, ...f, shape: f.shape, built: undefined, floors: ra.floors === 0 && rb.floors === 0 ? 0 : Math.max(ra.floors, rb.floors, 1), fn: 0 });
  return j;
}

/** Delete: a building becomes an empty marked lot; an empty lot goes away (a zoned street may grow again). */
export function deleteLot(world: World, id: number): RoadJournal {
  const r = rec(world, id);
  const j = new RoadJournal(world, r.floors === 0 ? 'apagar lote' : 'demolir prédio');
  j.removeBuilding(id);
  if (r.floors !== 0) j.addBuilding({ ...r, floors: 0, fn: 0 });
  return j;
}

/** Turns the lot's front to the side nearest (x, z). Returns null if it already is the front. */
export function setLotFront(world: World, id: number, x: number, z: number): RoadJournal | null {
  const r = rec(world, id);
  const [lx, lz] = worldToLot(r, x, z);
  // distance to each side: front (+z), back, right (+x), left
  const sides: Array<[number, number]> = [[r.d / 2 - lz, 0], [lz + r.d / 2, Math.PI], [r.w / 2 - lx, Math.PI / 2], [lx + r.w / 2, -Math.PI / 2]];
  sides.sort((p, q) => p[0] - q[0]);
  const turn = sides[0][1];
  if (turn === 0) return null;
  const f = frameLot(lotOutlineWorld(world, id), r.rot + turn);
  if (!f) return null;
  const j = new RoadJournal(world, 'frente do lote');
  j.removeBuilding(id);
  j.addBuilding({ ...r, ...f, shape: f.shape });
  return j;
}

/** Corner of the lot nearest the point (index into its outline) and the distance, to grab and drag. */
export function nearestCorner(world: World, id: number, x: number, z: number): [number, number] {
  const o = lotOutlineWorld(world, id);
  let best = 0, bd = Infinity;
  o.forEach(([cx, cz], k) => { const d = Math.hypot(cx - x, cz - z); if (d < bd) { bd = d; best = k; } });
  return [best, bd];
}

/**
 * Drags corner `k` to (x, z). A rectangle stays a rectangle in the same rotation (the opposite corner stays);
 * a polygon moves just that corner.
 */
export function moveLotCorner(world: World, id: number, k: number, x: number, z: number): RoadJournal | string {
  const r = rec(world, id);
  let f: ReturnType<typeof frameLot>;
  if (!r.shape) {
    const [lx0, lz0] = worldToLot(r, ...lotOutlineWorld(world, id)[k]);
    const sx = Math.sign(lx0) || 1, sz = Math.sign(lz0) || 1;
    const ox = -sx * r.w / 2, oz = -sz * r.d / 2; // opposite corner (fixed)
    const [lx, lz] = worldToLot(r, x, z);
    const w = (lx - ox) * sx, d = (lz - oz) * sz;
    if (w < MIN_LOT || d < MIN_LOT) return 'lote pequeno demais';
    if (w > 200 || d > 200) return 'lote grande demais';
    const [cx, cz] = lotToWorld(r, ox + sx * w / 2, oz + sz * d / 2);
    f = { x: cx, z: cz, w, d, rot: r.rot };
    const fits = lotFits(world, [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([u, v]) => lotToWorld(f!, u, v)), [id]);
    if (fits) return fits;
  } else {
    const o = lotOutlineWorld(world, id);
    o[k] = [x, z];
    if (!isSimple(o)) return 'os lados do lote se cruzariam';
    f = frameLot(o, r.rot);
    if (!f) return 'lote pequeno demais';
    if (f.w > 200 || f.d > 200) return 'lote grande demais';
    const fits = lotFits(world, o, [id]);
    if (fits) return fits;
  }
  const j = new RoadJournal(world, 'cantos do lote');
  j.removeBuilding(id);
  j.addBuilding({ ...r, ...f, shape: f.shape });
  return j;
}

/**
 * Curves the side of the lot nearest (x, z) so it passes through (px, pz) (Roadcraft "curve side"): the side
 * becomes a quadratic curve through that point at its middle, sampled into corners (up to SHAPE_MAX in all).
 */
export function curveLotSide(world: World, id: number, x: number, z: number, px: number, pz: number): RoadJournal | string {
  const r = rec(world, id);
  const o = lotOutlineWorld(world, id);
  let side = 0, bd = Infinity;
  for (let i = 0; i < o.length; i++) {
    const a = o[i], b = o[(i + 1) % o.length], ex = b[0] - a[0], ez = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / (ex * ex + ez * ez || 1)));
    const d = Math.hypot(a[0] + ex * t - x, a[1] + ez * t - z);
    if (d < bd) { bd = d; side = i; }
  }
  const a = o[side], b = o[(side + 1) % o.length];
  const room = SHAPE_MAX - o.length;
  if (room < 2) return 'o lote já tem cantos demais para curvar';
  const steps = Math.min(8, room + 1);
  // control point so the curve passes through P at t = 1/2
  const cx = 2 * px - (a[0] + b[0]) / 2, cz = 2 * pz - (a[1] + b[1]) / 2;
  const arc: Pt[] = [];
  for (let k = 1; k < steps; k++) {
    const t = k / steps, u = 1 - t;
    arc.push([u * u * a[0] + 2 * u * t * cx + t * t * b[0], u * u * a[1] + 2 * u * t * cz + t * t * b[1]]);
  }
  const out = [...o.slice(0, side + 1), ...arc, ...o.slice(side + 1)];
  if (!isSimple(out)) return 'a curva cruzaria outro lado do lote';
  const f = frameLot(out, r.rot);
  if (!f) return 'lote pequeno demais';
  const fits = lotFits(world, out, [id]);
  if (fits) return fits;
  const j = new RoadJournal(world, 'curvar lado do lote');
  j.removeBuilding(id);
  j.addBuilding({ ...r, ...f, shape: f.shape });
  return j;
}

/**
 * Frame of a drawn polygon: the smallest-area rectangle around it (sides of the convex hull), with the front on
 * the side holding the first edge clicked. Returns the rectangle (the lot record without the polygon).
 */
export function polygonRect(pts: Array<[number, number]>): { x: number; z: number; w: number; d: number; rot: number } | null {
  if (pts.length < 3) return null;
  const hull = convexHull(pts);
  if (hull.length < 3) return null;
  let best: { x: number; z: number; w: number; d: number; rot: number; area: number } | null = null;
  for (let i = 0; i < hull.length; i++) {
    const [ax, az] = hull[i], [bx, bz] = hull[(i + 1) % hull.length];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1e-6) continue;
    const ux = (bx - ax) / L, uz = (bz - az) / L;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [px, pz] of hull) {
      const u = px * ux + pz * uz, v = -px * uz + pz * ux;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const ar = (u1 - u0) * (v1 - v0);
    if (!best || ar < best.area) {
      const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
      best = { x: cu * ux - cv * uz, z: cu * uz + cv * ux, w: u1 - u0, d: v1 - v0, rot: 0, area: ar };
      // front (+z local) towards the side that holds the first edge clicked
      const [p0x, p0z] = pts[0], [p1x, p1z] = pts[1];
      const mx = (p0x + p1x) / 2 - best.x, mz = (p0z + p1z) / 2 - best.z;
      const fu = mx * ux + mz * uz, fv = -mx * uz + mz * ux;
      let fx: number, fz: number, w = best.w, d = best.d;
      if (Math.abs(fv) / Math.max(1e-6, d) >= Math.abs(fu) / Math.max(1e-6, w)) { const sg = Math.sign(fv) || 1; fx = -uz * sg; fz = ux * sg; }
      else { const sg = Math.sign(fu) || 1; fx = ux * sg; fz = uz * sg; [w, d] = [d, w]; }
      best.w = w; best.d = d;
      best.rot = Math.atan2(fx, fz); // (sin rot, cos rot) = front
    }
  }
  if (!best || best.w < MIN_LOT || best.d < MIN_LOT) return null;
  return { x: best.x, z: best.z, w: best.w, d: best.d, rot: best.rot };
}

function convexHull(pts: Array<[number, number]>): Array<[number, number]> {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [], upper: Pt[] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

// ------------------------------------------------------------------ edits on every lot touched (Roadcraft 4.0 lots.ts)

/** Lots whose outline has a corner within `r` m of (x, z), with the indices of those corners. */
function lotsWithCorner(world: World, x: number, z: number, r: number): Array<[number, number[]]> {
  const out: Array<[number, number[]]> = [];
  world.buildingIndex.query(x - 120, z - 120, x + 120, z + 120, (id) => {
    const ks: number[] = [];
    lotOutlineWorld(world, id).forEach(([cx, cz], k) => { if (Math.hypot(cx - x, cz - z) < r) ks.push(k); });
    if (ks.length) out.push([id, ks]);
  });
  return out;
}

/**
 * Drags the lot corner at (fromX, fromZ) to (x, z) on every lot that has it (neighbours share their corners), as
 * one step. A rectangle whose corner leaves its rectangle becomes a polygon lot in the same rotation.
 */
export function moveSharedCorner(world: World, fromX: number, fromZ: number, x: number, z: number): RoadJournal | string {
  const lots = lotsWithCorner(world, fromX, fromZ, 0.8);
  if (!lots.length) return 'nenhum canto de lote aqui';
  const ids = lots.map(([id]) => id);
  const next: Array<[number, BuildingRec]> = [];
  for (const [id, ks] of lots) {
    const r = rec(world, id), o = lotOutlineWorld(world, id);
    for (const k of ks) o[k] = [x, z];
    if (!isSimple(o)) return 'os lados do lote se cruzariam';
    const f = frameLot(o, r.rot);
    if (!f) return 'lote pequeno demais';
    if (f.w > 200 || f.d > 200) return 'lote grande demais';
    const fits = lotFits(world, o, ids);
    if (fits) return fits;
    next.push([id, { ...r, ...f, shape: f.shape }]);
  }
  const j = new RoadJournal(world, 'cantos do lote');
  for (const [id] of next) j.removeBuilding(id);
  for (const [, r] of next) j.addBuilding(r);
  return j;
}

/** Splits every lot the segment (ax, az)–(bx, bz) runs across in two along it, as one step (Roadcraft split by line). */
export function splitLotsByLine(world: World, ax: number, az: number, bx: number, bz: number): RoadJournal | string {
  const L = Math.hypot(bx - ax, bz - az);
  if (L < 2) return 'trace uma linha que atravesse os lotes';
  const nx = -(bz - az) / L, nz = (bx - ax) / L, c = ax * nx + az * nz;
  const hit: number[] = [];
  world.buildingIndex.query(Math.min(ax, bx) - 120, Math.min(az, bz) - 120, Math.max(ax, bx) + 120, Math.max(az, bz) + 120, (id) => {
    const o = lotOutlineWorld(world, id);
    // corners on both sides of the line, and the segment itself passing through the lot
    const side = o.map(([x, z]) => x * nx + z * nz - c);
    if (!(side.some((v) => v < -0.05) && side.some((v) => v > 0.05))) return;
    for (let k = 0; k <= 20; k++) if (pointInPolygon(o, ax + (bx - ax) * k / 20, az + (bz - az) * k / 20)) { hit.push(id); return; }
  });
  if (!hit.length) return 'a linha não atravessa nenhum lote';
  const all = new RoadJournal(world, 'dividir lotes por linha');
  let why = '';
  for (const id of hit) {
    const r = splitLotByLine(world, id, ax, az, bx, bz);
    if (typeof r === 'string') why = r; else all.append(r);
  }
  return all.empty ? why || 'a linha não atravessa nenhum lote' : all;
}

/**
 * Delete stroke (Roadcraft): every lot under the line through `pts` (sampled every 2 m) is deleted, as one step: a
 * building becomes an empty lot, an empty lot goes away.
 */
export function deleteLotsAlong(world: World, pts: Pt[]): RoadJournal | string {
  const hit = new Set<number>();
  const visit = (x: number, z: number) => { const id = lotAt(world, x, z); if (id >= 0) hit.add(id); };
  if (pts.length === 1) visit(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 2));
    for (let k = 0; k <= n && hit.size < 400; k++) visit(ax + (bx - ax) * k / n, az + (bz - az) * k / n);
  }
  if (!hit.size) return 'nenhum lote no traço';
  const all = new RoadJournal(world, 'apagar lotes');
  for (const id of hit) all.append(deleteLot(world, id));
  return all;
}

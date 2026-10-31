import type { Vec2 } from '../../core/vec2.ts';
import { convexHull, pointInPolygon } from '../../core/polygon.ts';
import { m } from '../units.ts';
import { localFootprint, overlapArea } from './footprints.ts';
import { STEP_RISE } from './foundation.ts';
import { isRetainingStone } from './cityBuildings.ts';
import {
  EPS,
  elementRect,
  volumeElevation,
  volumeLift,
} from './geometry.ts';
import {
  type Building,
  type BuildingElement,
  type ElementKind,
  type Volume,
  volumeTop,
} from './types.ts';

/** Parts hung on a facade rather than standing on the ground. */
export const ON_FACADE: ReadonlySet<ElementKind> = new Set<ElementKind>(['canopy', 'ac', 'awning', 'clock']);

/** Whether an element's foot stands on the ground (rather than on a floor, or hung on a wall). */
export const onGround = (e: BuildingElement): boolean => e.z <= EPS && !ON_FACADE.has(e.kind);

/** Parts that stand on the land itself and follow it */
export const FOLLOWS_GROUND: ReadonlySet<ElementKind> = new Set<ElementKind>([
  'wall', 'fence', 'railing', 'pavement', 'hedge', 'bin', 'lamp', 'bollard', 'drain', 'planter', 'bench', 'rocks',
  'flowers', 'shrub', 'tree', 'gate',
]);

/** The longest step of a run that follows the ground. */
const FOLLOW_STEP = m(2);

/** A long run that follows the ground in steps of at most `FOLLOW_STEP`; anything else whole. */
export function followPieces(el: BuildingElement): BuildingElement[] {
  if (!FOLLOWS_GROUND.has(el.kind) || el.kind === 'gate') return [el];
  const alongW = el.w >= el.d;
  const length = alongW ? el.w : el.d;
  const n = Math.ceil(length / FOLLOW_STEP - 1e-9);
  if (n <= 1) return [el];
  // The way `w` runs: across the facing, turned by the element's own angle.
  const a = el.angle ?? 0;
  const wx = el.facing === 0 || el.facing === 2 ? 1 : 0, wy = 1 - wx;
  const ux = wx * Math.cos(a) - wy * Math.sin(a), uy = wx * Math.sin(a) + wy * Math.cos(a);
  const [dx, dy] = alongW ? [ux, uy] : [-uy, ux];
  const out: BuildingElement[] = [];
  for (let k = 0; k < n; k++) {
    const off = (k + 0.5) * (length / n) - length / 2;
    out.push({ ...el, x: el.x + dx * off, y: el.y + dy * off, ...(alongW ? { w: length / n } : { d: length / n }) });
  }
  return out;
}

export { elementRect };

/** Steps of a stair: every riser at most `STEP_RISE`. */
export const stairSteps = (e: BuildingElement): number => Math.max(1, Math.ceil(e.h / STEP_RISE - 1e-9));

/** The first volume an element would stand inside of, or null. Touching is allowed. */
export function elementClash(b: Building, e: BuildingElement): Volume | null {
  const [x0, y0, x1, y1] = elementRect(e);
  const z0 = e.z;
  const z1 = e.z + e.h;
  for (const v of b.volumes) {
    // A lot is ground to stand things on, and a cut or a clip is no mass.
    if (v.open || v.mode === 'void' || v.mode === 'intersect') continue;
    // Its own heights (a block at a floor of its own, `Volume.lift`)
    const vz0 = v.base === 0 ? Math.min(0, volumeLift(v)) : volumeElevation(b, v, v.base);
    const vz1 = volumeElevation(b, v, volumeTop(v));
    // A canopy, an awning or a unit hangs ON the wall
    if (ON_FACADE.has(e.kind)) {
      if (z0 < vz1 - EPS && vz0 < z1 - EPS && pointInPolygon({ x: e.x, y: e.y }, localFootprint(v))) return v;
      continue;
    }
    if (z0 < vz1 - EPS && vz0 < z1 - EPS &&
      (v.outline ? overlapArea(localFootprint(v), [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]) > EPS
        : x0 < v.x + v.w - EPS && v.x < x1 - EPS && y0 < v.y + v.d - EPS && v.y < y1 - EPS)) return v;
  }
  return null;
}

/** The parts nothing holds up: a carport roof whose posts were refused, a pergola whose posts a retaining wall cleared */
export function unsupportedElements(b: Building): Set<number> {
  const els = b.elements ?? [];
  const out = new Set<number>();
  if (els.length === 0) return out;
  const tol = m(0.05);
  const masses = b.volumes.filter((v) => !v.open && v.mode !== 'void' && v.mode !== 'intersect');
  const rects = new Map(els.map((e) => [e.id, elementRect(e)] as const));
  const square = ([x0, y0, x1, y1]: readonly number[], grow: number): Vec2[] =>
    [{ x: x0! - grow, y: y0! - grow }, { x: x1! + grow, y: y0! - grow }, { x: x1! + grow, y: y1! + grow }, { x: x0! - grow, y: y1! + grow }];
  const onLand = (e: BuildingElement): boolean => {
    if (onGround(e) || FOLLOWS_GROUND.has(e.kind)) return true;
    // On a terrace (an open block raised or lowered with the slope) it touches at its own base
    const box = square(rects.get(e.id)!, tol);
    for (const v of b.volumes) {
      if (!v.open || v.terrace === undefined) continue;
      if (Math.abs(e.z - v.terrace) <= tol && overlapArea(localFootprint(v), box) > EPS) return true;
    }
    return false;
  };
  // Hung on the building's wall, or laid on one of its roofs or floors
  const heldByMass = (e: BuildingElement): boolean => {
    const box = square(rects.get(e.id)!, m(0.3));
    for (const v of masses) {
      const vz0 = v.base === 0 ? Math.min(0, volumeLift(v)) : volumeElevation(b, v, v.base);
      const vz1 = volumeElevation(b, v, volumeTop(v));
      if (e.z > vz1 + tol || e.z + e.h < vz0 - tol) continue;
      if (overlapArea(localFootprint(v), box) > EPS) return true;
    }
    return false;
  };
  const held = new Set<number>();
  for (const e of els) if (onLand(e) || heldByMass(e)) held.add(e.id);
  for (let changed = true; changed;) {
    changed = false;
    for (const e of els) {
      if (held.has(e.id)) continue;
      const [ex0, ey0, ex1, ey1] = rects.get(e.id)!;
      const contacts: Vec2[] = [];
      for (const s of els) {
        if (s === e || !held.has(s.id)) continue;
        // Touching across a height they share: under it (its top at e's underside), over it (e hangs from it) or beside it
        if (s.z > e.z + e.h + tol || e.z > s.z + s.h + tol) continue;
        const [sx0, sy0, sx1, sy1] = rects.get(s.id)!;
        const ix0 = Math.max(ex0, sx0), iy0 = Math.max(ey0, sy0), ix1 = Math.min(ex1, sx1), iy1 = Math.min(ey1, sy1);
        if (ix1 < ix0 - tol || iy1 < iy0 - tol) continue;
        contacts.push(...square([ix0, iy0, Math.max(ix0, ix1), Math.max(iy0, iy1)], tol));
      }
      if (contacts.length === 0 || !pointInPolygon({ x: e.x, y: e.y }, convexHull(contacts))) continue;
      held.add(e.id);
      changed = true;
    }
  }
  for (const e of els) if (!held.has(e.id)) out.add(e.id);
  return out;
}

/** The objects a lot's parts make: parts that touch (by the same contact `unsupportedElements` reads) are one thing */
export function partGroups(b: Building): Map<number, number> {
  const els = (b.elements ?? []).filter((e) => !FOLLOWS_GROUND.has(e.kind));
  const tol = m(0.05);
  const rects = els.map((e) => elementRect(e));
  const parent = els.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; } return i; };
  for (let i = 0; i < els.length; i++) {
    const a = els[i]!, [ax0, ay0, ax1, ay1] = rects[i]!;
    for (let j = i + 1; j < els.length; j++) {
      const c = els[j]!, [cx0, cy0, cx1, cy1] = rects[j]!;
      if (c.z > a.z + a.h + tol || a.z > c.z + c.h + tol) continue;
      if (cx0 > ax1 + tol || ax0 > cx1 + tol || cy0 > ay1 + tol || ay0 > cy1 + tol) continue;
      parent[find(i)] = find(j);
    }
  }
  const out = new Map<number, number>();
  els.forEach((e, i) => out.set(e.id, find(i)));
  return out;
}

// ------------------------------------------------------------------ parts through parts

/** Laid on the ground to stand things on (`lotPlan.ts` FLAT_KINDS): a surface, not a footprint. */
const SURFACE_KINDS: ReadonlySet<ElementKind> = new Set<ElementKind>(['pavement', 'drain', 'parking']);
/** The lot's boundary and its posts: runs meet each other at joints by design. */
const BOUNDARY_KINDS: ReadonlySet<ElementKind> = new Set<ElementKind>(['wall', 'fence', 'hedge', 'railing', 'gate', 'pillar']);
/** Planting, which grows under a tree's crown. */
const PLANT_KINDS: ReadonlySet<ElementKind> = new Set<ElementKind>(['flowers', 'shrub', 'hedge', 'planter']);
/** How far two parts may run into each other: a contact, a footing set into paving. */
const MEET = m(0.03);
/** A tree's trunk, and where its crown starts as a share of its height. */
const TRUNK = m(0.4);
const CROWN_FROM = 0.35;

/** The yard's earthworks - a flight, a ramp, a retaining wall in its stone */
function isEarthwork(e: BuildingElement): boolean {
  return e.kind === 'stair' || e.kind === 'ramp' || (e.kind === 'slab' && isRetainingStone(e.material));
}
/** Laid with the lot's structure (its boundary, its earthworks): dressing in its way is cleared. */
export function isStructure(e: BuildingElement): boolean {
  return BOUNDARY_KINDS.has(e.kind) || isEarthwork(e);
}

interface Footprint { cx: number; cy: number; hx: number; hy: number; a: number }

/** The two footprints `elementsMeet` compares, written in place: DO NOT make two objects a pair tested, the growth tests a lot's every part against every candidate (the allocation profile, 2026-10-17: the lot plan's `fits` and `put` 0.6-1.1 GB in each tile worker). */
const footA: Footprint = { cx: 0, cy: 0, hx: 0, hy: 0, a: 0 }, footB: Footprint = { cx: 0, cy: 0, hx: 0, hy: 0, a: 0 };

function footprintOf(e: BuildingElement, out: Footprint, size?: number): Footprint {
  const alongY = e.facing === 0 || e.facing === 2;
  out.cx = e.x; out.cy = e.y;
  out.hx = (size ?? (alongY ? e.w : e.d)) / 2; out.hy = (size ?? (alongY ? e.d : e.w)) / 2;
  out.a = e.angle ?? 0;
  return out;
}

/** A footprint's half extent along the axis (ux, uy). */
const reachAlong = (b: Footprint, ux: number, uy: number): number =>
  b.hx * Math.abs(Math.cos(b.a) * ux + Math.sin(b.a) * uy) + b.hy * Math.abs(-Math.sin(b.a) * ux + Math.cos(b.a) * uy);

/** How deep two turned rectangles run into each other (separating axes); <= 0 when apart. */
function planDepth(p: Footprint, q: Footprint): number {
  // Far apart for any turn (bounding circles), without the trigonometry: most pairs.
  const gap = Math.hypot(q.cx - p.cx, q.cy - p.cy) - Math.hypot(p.hx, p.hy) - Math.hypot(q.hx, q.hy);
  if (gap > 0) return -gap;
  let best = Infinity;
  // The four axes: p's two, then q's two (no array of them, no function a pair).
  for (let k = 0; k < 4; k++) {
    const t = k === 0 ? p.a : k === 1 ? p.a + Math.PI / 2 : k === 2 ? q.a : q.a + Math.PI / 2;
    const ux = Math.cos(t), uy = Math.sin(t);
    best = Math.min(best, reachAlong(p, ux, uy) + reachAlong(q, ux, uy) - Math.abs((q.cx - p.cx) * ux + (q.cy - p.cy) * uy));
  }
  return best;
}

/** The radius of a circle round every footprint of a part (`footprintOf`, its own or a trunk's). */
/** The radius round a part's centre its footprint stays within for any turn: two parts whose centres are farther apart than the sum never meet (`elementsMeet`'s first test). */
export const planReach = (e: BuildingElement): number => Math.hypot(Math.max(e.w, TRUNK), Math.max(e.d, TRUNK)) / 2;

/** Heights running into each other by more than a contact (a flush joint of two plates is a contact). */
const heightsMeet = (a0: number, a1: number, b0: number, b1: number): boolean => Math.min(a1, b1) - Math.max(a0, b0) > MEET + m(0.001);

/** Whether two parts of a lot stand in each other (Etapa 5a) */
export function elementsMeet(a: BuildingElement, b: BuildingElement): boolean {
  // Apart for any turn: the circles round their footprints do not meet
  if (Math.hypot(b.x - a.x, b.y - a.y) > planReach(a) + planReach(b)) return false;
  if (SURFACE_KINDS.has(a.kind) || SURFACE_KINDS.has(b.kind)) return false;
  if (isStructure(a) && isStructure(b)) return false;
  // A plant against a thin run of the boundary grows through it (a shrub through a fence); a shed or a cabinet
  if ((PLANT_KINDS.has(a.kind) && thinRun(b)) || (PLANT_KINDS.has(b.kind) && thinRun(a))) return false;
  // Foliage into foliage: a shrub grown into a hedge.
  if (foliage(a) && foliage(b)) return false;
  if (a.kind === 'tree' || b.kind === 'tree') {
    const tree = a.kind === 'tree' ? a : b, other = a.kind === 'tree' ? b : a;
    if (other.kind === 'tree') return heightsMeet(a.z, a.z + a.h, b.z, b.z + b.h) && planDepth(footprintOf(a, footA, TRUNK), footprintOf(b, footB, TRUNK)) > MEET;
    const crown = tree.z + tree.h * CROWN_FROM;
    const trunkMeets = heightsMeet(tree.z, tree.z + tree.h, other.z, other.z + other.h)
      && planDepth(footprintOf(tree, footA, TRUNK), footprintOf(other, footB)) > MEET;
    if (trunkMeets && !PLANT_KINDS.has(other.kind)) return true;
    return !PLANT_KINDS.has(other.kind) && heightsMeet(crown, tree.z + tree.h, other.z, other.z + other.h)
      && other.z >= crown - MEET && planDepth(footprintOf(tree, footA), footprintOf(other, footB)) > MEET;
  }
  return heightsMeet(a.z, a.z + a.h, b.z, b.z + b.h) && planDepth(footprintOf(a, footA), footprintOf(b, footB)) > MEET + m(0.001);
}

/** A thin run of the boundary: a plant grows through it (`elementsMeet`). */
const thinRun = (e: BuildingElement): boolean => (e.kind === 'wall' || e.kind === 'fence' || e.kind === 'railing') && Math.min(e.w, e.d) <= m(0.3);
/** Foliage: a shrub grows into a hedge (`elementsMeet`). */
const foliage = (e: BuildingElement): boolean => e.kind === 'shrub' || e.kind === 'hedge';

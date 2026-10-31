// The plan of a grown lot: what its front, sides and back carry, and the building's envelope. Values and draw
// order from Roadcraft 4.0 world/growth/lotPlan.ts; the rules are split by lot kind and settle once, over a small
// state record, so no single block mirrors the 4.0 switch.
import type { Xoshiro128 } from '../../../core/rng.ts';

export type B40LotKind = 'house' | 'flats' | 'tower' | 'shop' | 'office' | 'industry';
export type B40FrontUse = 'street' | 'garden' | 'carpad' | 'forecourt' | 'plaza' | 'apron';
export type B40SideUse = 'attached' | 'path' | 'drive' | 'drivePath' | 'garden';
export type B40BackUse = 'none' | 'yard' | 'parking' | 'service' | 'courtyard' | 'loading';

export interface B40Rect { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }
export interface B40SidePlan { readonly use: B40SideUse; readonly width: number }
export interface B40Plan {
  readonly kind: B40LotKind;
  readonly W: number;
  readonly D: number;
  readonly front: { readonly use: B40FrontUse; readonly depth: number };
  readonly left: B40SidePlan;
  readonly right: B40SidePlan;
  readonly back: { readonly use: B40BackUse; readonly depth: number; readonly rows: number };
  readonly building: B40Rect;
  readonly corner?: 'left' | 'right';
}

const DRIVE = 3.5, HOUSE_DRIVE = 3, FOOTPATH = 1.2, TRUCK_LANE = 6;
const STALL = 5, AISLE = 6;

const gap = (rng: Xoshiro128, lo: number, hi: number): number => (hi - lo) * rng.float() + lo;
const half = (x: number): number => Math.floor(x + x) / 2;

interface PlanState {
  front: B40Plan['front'];
  left: B40SidePlan;
  right: B40SidePlan;
  back: B40Plan['back'];
}

const ATTACHED: B40SidePlan = { use: 'attached', width: 0 };

function assignSides(s: PlanState, flip: boolean, a: B40SidePlan, b: B40SidePlan): void {
  s.left = flip ? b : a;
  s.right = flip ? a : b;
}

function rowsWithin(D: number, frontDepth: number, minBuilding: number): number {
  const spare = D - frontDepth - minBuilding;
  if (spare >= STALL * 2 + AISLE) return 2;
  return spare >= STALL + AISLE ? 1 : 0;
}

function planHouse(s: PlanState, W: number, D: number, rng: Xoshiro128, flip: boolean): void {
  const narrow = W < 10.5;
  s.front = D >= 22
    ? (narrow ? { use: 'carpad', depth: 5.5 } : { use: 'garden', depth: half(gap(rng, 3.5, 5.5)) })
    : { use: 'garden', depth: D >= 14 ? 3 : 0 };
  if (s.front.depth === 0) s.front = { use: 'street', depth: 0 };
  const alley = { use: 'path' as const, width: 1.1 };
  if (narrow) assignSides(s, flip, { use: 'path', width: FOOTPATH }, alley);
  else assignSides(s, flip, { use: 'drive', width: HOUSE_DRIVE },
    W >= 16 ? { use: 'garden', width: half(gap(rng, 3, 4)) } : W >= 13 ? { use: 'path', width: FOOTPATH } : alley);
  const houseD = Math.min(Math.max(8, D - s.front.depth - gap(rng, 8, 12)), 15);
  const yard = D - s.front.depth - houseD;
  if (yard >= 4) s.back = { use: 'yard', depth: half(yard), rows: 0 };
}

function planFlats(s: PlanState, kind: 'flats' | 'tower', W: number, D: number, rng: Xoshiro128, flip: boolean): void {
  if (kind === 'tower') s.front = { use: D >= 24 ? 'plaza' : 'street', depth: D >= 24 ? 5 : 0 };
  else s.front = W >= 14 && D >= 20 && rng.float() < 0.75 ? { use: 'garden', depth: half(gap(rng, 3, 5)) } : { use: 'street', depth: 0 };
  const stalls = W >= 18 ? rowsWithin(D, s.front.depth, 12) : 0;
  if (stalls > 0) {
    assignSides(s, flip, { use: 'drivePath', width: DRIVE + FOOTPATH }, rng.float() < 0.55 ? ATTACHED : { use: 'path', width: 1.5 });
    s.back = { use: 'parking', depth: stalls === 2 ? STALL * 2 + AISLE : STALL + AISLE, rows: stalls };
    return;
  }
  assignSides(s, flip, W >= 14 ? { use: 'path', width: 1.5 } : ATTACHED, ATTACHED);
  const spare = D - s.front.depth - 12;
  if (spare >= 5) s.back = { use: 'courtyard', depth: half(Math.min(spare, 12)), rows: 0 };
}

function planShop(s: PlanState, W: number, D: number, rng: Xoshiro128, flip: boolean): void {
  s.front = D >= 16 && rng.float() < 0.45 ? { use: 'forecourt', depth: half(gap(rng, 3, 4.5)) } : { use: 'street', depth: 0 };
  const stalls = W >= 15 && rng.float() < 0.6 ? Math.min(1, rowsWithin(D, s.front.depth, 12)) : 0;
  if (stalls > 0) {
    assignSides(s, flip, { use: 'drive', width: DRIVE }, ATTACHED);
    s.back = { use: 'parking', depth: STALL + AISLE, rows: stalls };
  } else if (D - s.front.depth >= 14) s.back = { use: 'service', depth: half(gap(rng, 4.5, 6)), rows: 0 };
}

function planOffice(s: PlanState, W: number, D: number, rng: Xoshiro128, flip: boolean): void {
  s.front = D >= 22 ? { use: 'plaza', depth: half(gap(rng, 5, 7)) } : { use: 'forecourt', depth: D >= 14 ? 3 : 0 };
  if (s.front.depth === 0) s.front = { use: 'street', depth: 0 };
  const stalls = W >= 16 ? rowsWithin(D, s.front.depth, 14) : 0;
  if (stalls > 0) {
    assignSides(s, flip, { use: 'drivePath', width: DRIVE + FOOTPATH }, ATTACHED);
    s.back = { use: 'parking', depth: stalls === 2 ? STALL * 2 + AISLE : STALL + AISLE, rows: stalls };
  } else if (D - s.front.depth >= 16) s.back = { use: 'service', depth: 5, rows: 0 };
}

function planIndustry(s: PlanState, W: number, D: number, rng: Xoshiro128, flip: boolean): void {
  s.front = D >= 22 ? { use: 'apron', depth: D >= 40 ? STALL + AISLE : 6 } : { use: 'street', depth: 0 };
  if (W < 20 || D < 30) return;
  assignSides(s, flip, { use: 'drive', width: TRUCK_LANE }, W >= 26 ? { use: 'path', width: 1.5 } : ATTACHED);
  const spare = D - s.front.depth;
  const full = 22;
  s.back = { use: 'loading', depth: half(spare >= full + 14 ? full : Math.min(16, Math.max(12, spare * 0.35))), rows: 0 };
}

/** Rules read after the kind: a parking back needs its drive, a narrow lot gives its sides up, a corner closes low. */
function settlePlan(s: PlanState, kind: B40LotKind, W: number, corner?: 'left' | 'right'): void {
  if (s.back.use === 'parking' && ![s.left.use, s.right.use].some((u) => u === 'drive' || u === 'drivePath')) {
    s.back = { use: 'service', depth: Math.min(6, s.back.depth), rows: 0 };
  }
  if (W - s.left.width - s.right.width < 6) {
    if (kind === 'house' && W >= 8.5) {
      s.left = { use: 'path', width: 1 };
      s.right = { use: 'path', width: 1 };
    } else {
      s.left = ATTACHED; s.right = ATTACHED;
      if (s.back.use === 'parking') s.back = { use: 'service', depth: Math.min(6, s.back.depth), rows: 0 };
    }
  }
  if (!corner) return;
  const onCorner = corner === 'left' ? s.left : s.right;
  const other = corner === 'left' ? s.right : s.left;
  if (onCorner.use !== 'attached' || W - other.width - 2 < 6) return;
  if (corner === 'left') s.left = { use: 'garden', width: 2 };
  else s.right = { use: 'garden', width: 2 };
}

export function lotKind(use: 'residential' | 'commercial' | 'industrial', density: 'low' | 'medium' | 'high'): B40LotKind {
  if (use === 'industrial') return 'industry';
  if (use === 'commercial') return density === 'high' ? 'office' : 'shop';
  return density === 'low' ? 'house' : density === 'medium' ? 'flats' : 'tower';
}

export function planLot(kind: B40LotKind, W: number, D: number, rng: Xoshiro128, corner?: 'left' | 'right'): B40Plan {
  const flip = rng.float() < 0.5;
  const s: PlanState = { front: { use: 'street', depth: 0 }, left: ATTACHED, right: ATTACHED, back: { use: 'none', depth: 0, rows: 0 } };
  switch (kind) {
    case 'house': planHouse(s, W, D, rng, flip); break;
    case 'flats':
    case 'tower': planFlats(s, kind, W, D, rng, flip); break;
    case 'shop': planShop(s, W, D, rng, flip); break;
    case 'office': planOffice(s, W, D, rng, flip); break;
    case 'industry': planIndustry(s, W, D, rng, flip); break;
  }
  settlePlan(s, kind, W, corner);
  const building = { x0: s.left.width, y0: s.front.depth, x1: W - s.right.width, y1: D - s.back.depth };
  return { kind, W, D, front: s.front, left: s.left, right: s.right, back: s.back, building, ...(corner ? { corner } : {}) };
}

export function yardRamp(plan: B40Plan): { readonly start: number; readonly end: number; readonly grade: number } | null {
  if (plan.back.use !== 'parking' && plan.back.use !== 'loading') return null;
  if (![plan.left, plan.right].some((s) => s.use === 'drive' || s.use === 'drivePath')) return null;
  const end = plan.D - plan.back.depth;
  const start = Math.max(plan.front.depth, 6);
  if (end - start < 2) return null;
  return { start, end, grade: plan.kind === 'industry' ? 0.1 : 0.125 };
}

export const GARAGE_GRADE = 0.25;
export function garageRamp(plan: B40Plan): { readonly start: number; readonly end: number; readonly grade: number } | null {
  if (plan.kind !== 'house' || ![plan.left, plan.right].some((s) => s.use === 'drive')) return null;
  const end = plan.D - plan.back.depth;
  const start = Math.max(plan.front.depth, 1);
  if (end - start < 2) return null;
  return { start, end, grade: GARAGE_GRADE };
}

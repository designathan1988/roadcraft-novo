// The plan of a grown lot: what its front, sides and back carry, and the building's envelope. Values and draw
// order from Roadcraft 4.0 world/growth/lotPlan.ts (planLot); one small record per lot, no per-entity objects.
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
const YARD_FULL = 22;

const between = (rng: Xoshiro128, a: number, b: number): number => a + (b - a) * rng.float();
const half = (x: number): number => Math.floor(x * 2) / 2;

export function lotKind(use: 'residential' | 'commercial' | 'industrial', density: 'low' | 'medium' | 'high'): B40LotKind {
  if (use === 'industrial') return 'industry';
  if (use === 'commercial') return density === 'high' ? 'office' : 'shop';
  return density === 'low' ? 'house' : density === 'medium' ? 'flats' : 'tower';
}

export function planLot(kind: B40LotKind, W: number, D: number, rng: Xoshiro128, corner?: 'left' | 'right'): B40Plan {
  const attached: B40SidePlan = { use: 'attached', width: 0 };
  let front: B40Plan['front'] = { use: 'street', depth: 0 };
  let left: B40SidePlan = attached, right: B40SidePlan = attached;
  let back: B40Plan['back'] = { use: 'none', depth: 0, rows: 0 };
  const flip = rng.float() < 0.5;
  const sides = (a: B40SidePlan, b: B40SidePlan): void => { [left, right] = flip ? [b, a] : [a, b]; };
  const parkingRows = (minBuilding: number): number => {
    const room = D - front.depth - minBuilding;
    return room >= STALL * 2 + AISLE ? 2 : room >= STALL + AISLE ? 1 : 0;
  };

  switch (kind) {
    case 'house': {
      const narrow = W < 10.5;
      front = D >= 22 ? (narrow ? { use: 'carpad', depth: 5.5 } : { use: 'garden', depth: half(between(rng, 3.5, 5.5)) })
        : { use: 'garden', depth: D >= 14 ? 3 : 0 };
      if (front.depth === 0) front = { use: 'street', depth: 0 };
      const passage = { use: 'path' as const, width: 1.1 };
      if (narrow) sides({ use: 'path', width: FOOTPATH }, passage);
      else sides({ use: 'drive', width: HOUSE_DRIVE }, W >= 16 ? { use: 'garden', width: half(between(rng, 3, 4)) } : W >= 13 ? { use: 'path', width: FOOTPATH } : passage);
      const houseD = Math.min(Math.max(8, D - front.depth - between(rng, 8, 12)), 15);
      const yard = D - front.depth - houseD;
      back = yard >= 4 ? { use: 'yard', depth: half(yard), rows: 0 } : back;
      break;
    }
    case 'flats':
    case 'tower': {
      front = kind === 'tower' ? { use: D >= 24 ? 'plaza' : 'street', depth: D >= 24 ? 5 : 0 }
        : W >= 14 && D >= 20 && rng.float() < 0.75 ? { use: 'garden', depth: half(between(rng, 3, 5)) } : { use: 'street', depth: 0 };
      const rows = W >= 18 ? parkingRows(12) : 0;
      if (rows) {
        sides({ use: 'drivePath', width: DRIVE + FOOTPATH }, rng.float() < 0.55 ? attached : { use: 'path', width: 1.5 });
        back = { use: 'parking', depth: rows === 2 ? STALL * 2 + AISLE : STALL + AISLE, rows };
      } else {
        sides(W >= 14 ? { use: 'path', width: 1.5 } : attached, attached);
        const room = D - front.depth - 12;
        back = room >= 5 ? { use: 'courtyard', depth: half(Math.min(room, 12)), rows: 0 } : back;
      }
      break;
    }
    case 'shop': {
      front = D >= 16 && rng.float() < 0.45 ? { use: 'forecourt', depth: half(between(rng, 3, 4.5)) } : { use: 'street', depth: 0 };
      const rows = W >= 15 && rng.float() < 0.6 ? Math.min(1, parkingRows(12)) : 0;
      if (rows) {
        sides({ use: 'drive', width: DRIVE }, attached);
        back = { use: 'parking', depth: STALL + AISLE, rows };
      } else if (D - front.depth >= 14) {
        back = { use: 'service', depth: half(between(rng, 4.5, 6)), rows: 0 };
      }
      break;
    }
    case 'office': {
      front = D >= 22 ? { use: 'plaza', depth: half(between(rng, 5, 7)) } : { use: 'forecourt', depth: D >= 14 ? 3 : 0 };
      if (front.depth === 0) front = { use: 'street', depth: 0 };
      const rows = W >= 16 ? parkingRows(14) : 0;
      if (rows) {
        sides({ use: 'drivePath', width: DRIVE + FOOTPATH }, attached);
        back = { use: 'parking', depth: rows === 2 ? STALL * 2 + AISLE : STALL + AISLE, rows };
      } else if (D - front.depth >= 16) back = { use: 'service', depth: 5, rows: 0 };
      break;
    }
    case 'industry': {
      front = D >= 22 ? { use: 'apron', depth: D >= 40 ? STALL + AISLE : 6 } : { use: 'street', depth: 0 };
      if (W >= 20 && D >= 30) {
        sides({ use: 'drive', width: TRUCK_LANE }, W >= 26 ? { use: 'path', width: 1.5 } : attached);
        const room = D - front.depth;
        back = { use: 'loading', depth: half(room >= YARD_FULL + 14 ? YARD_FULL : Math.min(16, Math.max(12, room * 0.35))), rows: 0 };
      }
      break;
    }
  }
  if (back.use === 'parking' && left.use !== 'drive' && left.use !== 'drivePath' && right.use !== 'drive' && right.use !== 'drivePath') {
    back = { use: 'service', depth: Math.min(6, back.depth), rows: 0 };
  }
  if (W - left.width - right.width < 6 && kind === 'house' && W >= 8.5) { left = { use: 'path', width: 1 }; right = { use: 'path', width: 1 }; }
  else if (W - left.width - right.width < 6) { left = attached; right = attached; if (back.use === 'parking') back = { use: 'service', depth: Math.min(6, back.depth), rows: 0 }; }
  if (corner) {
    const side = corner === 'left' ? left : right;
    const other = corner === 'left' ? right : left;
    if (side.use === 'attached' && W - other.width - 2 >= 6) {
      if (corner === 'left') left = { use: 'garden', width: 2 }; else right = { use: 'garden', width: 2 };
    }
  }
  const building = { x0: left.width, y0: front.depth, x1: W - right.width, y1: D - back.depth };
  return { kind, W, D, front, left, right, back, building, ...(corner ? { corner } : {}) };
}

/** How far a car park's or a loading yard's drive may climb or fall (4.0 yardRamp). */
export function yardRamp(plan: B40Plan): { readonly start: number; readonly end: number; readonly grade: number } | null {
  if (plan.back.use !== 'parking' && plan.back.use !== 'loading') return null;
  const drive = [plan.left, plan.right].some((s) => s.use === 'drive' || s.use === 'drivePath');
  if (!drive) return null;
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

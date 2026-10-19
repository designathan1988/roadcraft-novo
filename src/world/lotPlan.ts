// The plan of a lot (Roadcraft 4.0 world/growth/lotPlan.ts planLot, yardRamp, garageRamp, driveSide): what each
// part of a W × D lot is for — the front (garden, car pad, forecourt, plaza, apron), the two sides (party wall,
// path, drive), the back (yard, car park in one or two rows, service yard, courtyard, loading yard with docks) — and
// the building's envelope that is left. Pure: the building generator (jobs/buildingGen.ts) lays the lot from it.
// 4.0 measures y from the front edge inwards; `envelope` gives the rectangle in this engine's lot frame (x across
// the front, z towards the front, the lot centred on the origin).

import type { Rng } from '../core/rng.ts';
import { Zone, baseZone, zoneDensity } from '../roads/zones.ts';

export type LotKind = 'house' | 'flats' | 'tower' | 'shop' | 'office' | 'industry';

/** The kind of lot a zone (with its density) grows. */
export function lotKind(zone: number): LotKind {
  const base = baseZone(zone), dens = zoneDensity(zone);
  if (base === Zone.Industrial) return 'industry';
  if (base === Zone.Commercial) return dens === 2 ? 'office' : 'shop';
  return dens === 0 ? 'house' : dens === 1 ? 'flats' : 'tower';
}

export type FrontUse = 'street' | 'garden' | 'carpad' | 'forecourt' | 'plaza' | 'apron';
export type SideUse = 'attached' | 'path' | 'drive' | 'drivePath' | 'garden';
export type BackUse = 'none' | 'yard' | 'parking' | 'service' | 'courtyard' | 'loading';

interface SidePlan { readonly use: SideUse; readonly width: number }

export interface LotPlan {
  readonly kind: LotKind;
  readonly W: number;
  readonly D: number;
  readonly front: { readonly use: FrontUse; readonly depth: number };
  readonly left: SidePlan;
  readonly right: SidePlan;
  readonly back: { readonly use: BackUse; readonly depth: number; readonly rows: number };
  /** The building's envelope, 4.0's frame: x from the left edge, y from the front edge inwards. */
  readonly building: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };
  /** A corner lot: the side on a second street, a front too (a low boundary, never a blank party wall). */
  readonly corner?: 'left' | 'right';
}

/** A loading yard deep enough for a lorry's approach to its docks. */
export const YARD_FULL = 22;
/** Drive widths, a footpath, a lorry lane, a car stall and its aisle, a lorry's dock (m). */
export const DRIVE = 3.5, HOUSE_DRIVE = 3, FOOTPATH = 1.2, TRUCK_LANE = 6, STALL = 5, AISLE = 6, DOCK = 3.6;

const between = (rng: Rng, a: number, b: number): number => a + (b - a) * rng.next();
const half = (x: number): number => Math.floor(x * 2) / 2;

/** The plan of a lot `W` × `D` metres for a kind of building (4.0's rules and numbers). */
export function planLot(kind: LotKind, W: number, D: number, rng: Rng, corner?: 'left' | 'right'): LotPlan {
  const attached: SidePlan = { use: 'attached', width: 0 };
  let front: LotPlan['front'] = { use: 'street', depth: 0 };
  let left: SidePlan = attached, right: SidePlan = attached;
  let back: LotPlan['back'] = { use: 'none', depth: 0, rows: 0 };
  const flip = rng.next() < 0.5;
  const sides = (a: SidePlan, b: SidePlan): void => { [left, right] = flip ? [b, a] : [a, b]; };
  /** Parking behind: the rows the depth allows after the front and a building of `minBuilding`. */
  const parkingRows = (minBuilding: number): number => {
    const room = D - front.depth - minBuilding;
    return room >= STALL * 2 + AISLE ? 2 : room >= STALL + AISLE ? 1 : 0;
  };
  switch (kind) {
    case 'house': {
      const narrow = W < 10.5;
      front = D >= 22 ? (narrow ? { use: 'carpad', depth: 5.5 } : { use: 'garden', depth: half(between(rng, 3.5, 5.5)) }) : { use: 'garden', depth: D >= 14 ? 3 : 0 };
      if (front.depth === 0) front = { use: 'street', depth: 0 };
      // a house stands free of its neighbours: a passage on both sides
      const passage: SidePlan = { use: 'path', width: 1.1 };
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
        : W >= 14 && D >= 20 && rng.next() < 0.75 ? { use: 'garden', depth: half(between(rng, 3, 5)) } : { use: 'street', depth: 0 };
      const rows = W >= 18 ? parkingRows(12) : 0;
      if (rows) {
        sides({ use: 'drivePath', width: DRIVE + FOOTPATH }, rng.next() < 0.55 ? attached : { use: 'path', width: 1.5 });
        back = { use: 'parking', depth: rows === 2 ? STALL * 2 + AISLE : STALL + AISLE, rows };
      } else {
        sides(W >= 14 ? { use: 'path', width: 1.5 } : attached, attached);
        const room = D - front.depth - 12;
        back = room >= 5 ? { use: 'courtyard', depth: half(Math.min(room, 12)), rows: 0 } : back;
      }
      break;
    }
    case 'shop': {
      front = D >= 16 && rng.next() < 0.45 ? { use: 'forecourt', depth: half(between(rng, 3, 4.5)) } : { use: 'street', depth: 0 };
      const rows = W >= 15 && rng.next() < 0.6 ? Math.min(1, parkingRows(12)) : 0;
      if (rows) { sides({ use: 'drive', width: DRIVE }, attached); back = { use: 'parking', depth: STALL + AISLE, rows }; }
      else if (D - front.depth >= 14) back = { use: 'service', depth: half(between(rng, 4.5, 6)), rows: 0 };
      break;
    }
    case 'office': {
      front = D >= 22 ? { use: 'plaza', depth: half(between(rng, 5, 7)) } : { use: 'forecourt', depth: D >= 14 ? 3 : 0 };
      if (front.depth === 0) front = { use: 'street', depth: 0 };
      const rows = W >= 16 ? parkingRows(14) : 0;
      if (rows) { sides({ use: 'drivePath', width: DRIVE + FOOTPATH }, attached); back = { use: 'parking', depth: rows === 2 ? STALL * 2 + AISLE : STALL + AISLE, rows }; }
      else if (D - front.depth >= 16) back = { use: 'service', depth: 5, rows: 0 };
      break;
    }
    case 'industry': {
      // visitors' stalls and their aisle behind the gate when deep enough, else a paved forecourt
      front = D >= 22 ? { use: 'apron', depth: D >= 40 ? STALL + AISLE : 6 } : { use: 'street', depth: 0 };
      if (W >= 20 && D >= 30) {
        sides({ use: 'drive', width: TRUCK_LANE }, W >= 26 ? { use: 'path', width: 1.5 } : attached);
        // deep enough for a lorry to back square onto a dock
        const room = D - front.depth;
        back = { use: 'loading', depth: half(room >= YARD_FULL + 14 ? YARD_FULL : Math.min(16, Math.max(12, room * 0.35))), rows: 0 };
      }
      break;
    }
  }
  // a car park is reached from the street: without a drive down a side to it, the back is a paved service yard
  const hasDrive = (s: SidePlan) => s.use === 'drive' || s.use === 'drivePath';
  if (back.use === 'parking' && !hasDrive(left) && !hasDrive(right)) back = { use: 'service', depth: Math.min(6, back.depth), rows: 0 };
  // the building keeps a usable width: what it cannot keep, the sides give up
  if (W - left.width - right.width < 6 && kind === 'house' && W >= 8.5) { left = { use: 'path', width: 1 }; right = { use: 'path', width: 1 }; }
  else if (W - left.width - right.width < 6) { left = attached; right = attached; if (back.use === 'parking') back = { use: 'service', depth: Math.min(6, back.depth), rows: 0 }; }
  // a corner lot's side on the second street is a garden strip, not a party wall
  if (corner) {
    const side = corner === 'left' ? left : right, other = corner === 'left' ? right : left;
    if (side.use === 'attached' && W - other.width - 2 >= 6) { if (corner === 'left') left = { use: 'garden', width: 2 }; else right = { use: 'garden', width: 2 }; }
  }
  const building = { x0: left.width, y0: front.depth, x1: W - right.width, y1: D - back.depth };
  return { kind, W, D, front, left, right, back, building, ...(corner ? { corner } : {}) };
}

/** The building's envelope in this engine's lot frame: x across (left edge at −W/2), z towards the front (+D/2). */
export function envelope(p: LotPlan): { x0: number; x1: number; z0: number; z1: number } {
  return { x0: p.building.x0 - p.W / 2, x1: p.building.x1 - p.W / 2, z0: p.D / 2 - p.building.y1, z1: p.D / 2 - p.building.y0 };
}

/** The drive's ramp from the street to a car park or loading yard at another level: where it runs and its grade. */
export function yardRamp(p: LotPlan): { start: number; end: number; grade: number } | null {
  if (p.back.use !== 'parking' && p.back.use !== 'loading') return null;
  if (!driveSide(p)) return null;
  const end = p.D - p.back.depth, start = Math.max(p.front.depth, 6);
  if (end - start < 2) return null;
  return { start, end, grade: p.kind === 'industry' ? 0.1 : 0.125 };
}

/** A house's drive down (or up) to a garage under it, at 1 in 4. */
export const GARAGE_GRADE = 0.25;
export function garageRamp(p: LotPlan): { start: number; end: number; grade: number } | null {
  if (p.kind !== 'house' || driveSide(p) === null) return null;
  const end = p.D - p.back.depth, start = Math.max(p.front.depth, 1);
  if (end - start < 2) return null;
  return { start, end, grade: GARAGE_GRADE };
}

/** The side of the lot its drive runs down, if it has one. */
export function driveSide(p: LotPlan): 'left' | 'right' | null {
  const d = (s: SidePlan) => s.use === 'drive' || s.use === 'drivePath';
  return d(p.left) ? 'left' : d(p.right) ? 'right' : null;
}

/** How many lorry docks a loading yard's back wall holds (one per DOCK of building width). */
export function docksFor(p: LotPlan): number {
  return p.back.use === 'loading' ? Math.max(1, Math.floor((p.building.x1 - p.building.x0) / DOCK)) : 0;
}

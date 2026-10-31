// Architectural styles: the grammar of each facade (colours, window, balcony,
// crown, base, piers, roof). The building generator (worker) picks one by the
// neighbourhood and the seed; the shader reads the window parameters by index.

import { fbm } from '../core/rng.ts';
import { Zone } from '../roads/zones.ts';
import { catalogWindowRows } from './catalogFacade.ts';

export const ArchId = {
  Colonial: 0, ArtDeco: 1, Modernist: 2, Contemporary: 3, Brick: 4, Tropical: 5, Glass: 6, Industrial: 7,
  ColonialHouse: 8, Bungalow: 9, ModernHouse: 10, Sobrado: 11, Civic: 12,
} as const;
import { ARCH_COUNT, ARCHES, PATTERN_COUNT, Win } from './archData.ts';
export { ARCH_COUNT, ARCHES, PATTERN_COUNT, Win, Balcony, Crown } from './archData.ts';
export type { Arch } from './archData.ts';

/** Building function (0 = ordinary; growth picks by zone). */
export const Fn = {
  None: 0, School: 1, Church: 2, Hospital: 3, Clinic: 4, Square: 5, Park: 6, GasStation: 7, Supermarket: 8,
  CityHall: 9, Police: 10, FireStation: 11, Mall: 12, SportsCourt: 13,
  // functions added later: the building comes from the creator (a ready design per function), except the cemetery and the playground
  Council: 14, Courthouse: 15, PostOffice: 16, University: 17, Library: 18, Museum: 19, Prison: 20, Cemetery: 21, BusStation: 22,
  Bank: 23, Pharmacy: 24, Bakery: 25, Restaurant: 26, SnackBar: 27, Bar: 28, Cinema: 29, Hotel: 30, Gym: 31, Club: 32, Office: 33, Playground: 34,
} as const;
export const FN_NAMES = ['', 'building.fn.school', 'building.fn.church', 'building.fn.hospital', 'building.fn.clinic', 'building.fn.square', 'building.fn.park', 'building.fn.gasStation', 'building.fn.supermarket',
  'building.fn.cityHall', 'building.fn.policeStation', 'building.fn.fireStation', 'building.fn.mall', 'building.fn.sportsCourt',
  'building.fn.cityCouncil', 'building.fn.courthouse', 'building.fn.postOffice', 'building.fn.university', 'building.fn.library', 'building.fn.museum', 'building.fn.prison', 'building.fn.cemetery', 'building.fn.busStation',
  'building.fn.bank', 'building.fn.pharmacy', 'building.fn.bakery', 'building.fn.restaurant', 'building.fn.snackBar', 'building.fn.bar', 'building.fn.cinema', 'building.fn.hotel', 'building.fn.gym', 'building.fn.club', 'building.fn.offices', 'building.fn.playground'];

/** Draw by zone: [function, weight]. */
const FN_BY_ZONE: Array<Array<[number, number]>> = [
  [],
  [[Fn.School, 25], [Fn.Church, 14], [Fn.Square, 22], [Fn.Clinic, 10], [Fn.Park, 15], [Fn.SportsCourt, 10], [Fn.Supermarket, 4]],
  [[Fn.Square, 18], [Fn.Supermarket, 14], [Fn.CityHall, 4], [Fn.Hospital, 10], [Fn.Church, 10], [Fn.GasStation, 14], [Fn.Police, 8], [Fn.FireStation, 5], [Fn.Mall, 10]],
  [[Fn.GasStation, 50], [Fn.FireStation, 25], [Fn.Police, 10]],
  [[Fn.School, 15], [Fn.Church, 12], [Fn.Square, 20], [Fn.Supermarket, 14], [Fn.GasStation, 12], [Fn.Clinic, 10], [Fn.Hospital, 6], [Fn.Mall, 5]],
];

/**
 * A lot's function: at most one special building per cell (the largest lot),
 * drawn from the cell: deterministic, scanning nothing.
 */
export function civicFor(cell: number, zone: number, isBiggest: boolean, area: number): number {
  if (!isBiggest || area < 500) return Fn.None;
  let h = (cell * 2654435761) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; h ^= h >>> 13;
  if ((h & 1023) / 1024 > 0.4) return Fn.None;
  const list = FN_BY_ZONE[zone] ?? [];
  if (!list.length) return Fn.None;
  const total = list.reduce((s, [, w]) => s + w, 0);
  let k = ((h >>> 10) % 1000) / 1000 * total;
  for (const [fn, w] of list) { if ((k -= w) < 0) return fn; }
  return list[0][0];
}

/**
 * Warehouse chimney, by the seed (the same sum in the generator and in the smoke):
 * [local x, local z, top height above the lot's highest ground] or null.
 */
export function chimneyOf(seed: number, W: number, D: number, floors: number): [number, number, number] | null {
  let h = (seed ^ 0x5bd1e995) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0; h ^= h >>> 13;
  if (h % 2 !== 0 || W < 18) return null;
  const side = (h >>> 8) & 1 ? 1 : -1;
  return [side * (W / 2 - 3), -D / 2 + 4, 16 + floors * 2.5 + ((h >>> 12) % 9)];
}

/**
 * Style by neighbourhood (broad noise: the whole block reads as one era) and by the seed.
 * Old: colonial, art deco; middle: modernist, brick, tropical; new: contemporary, glass.
 */
export function pickArch(zone: number, floors: number, x: number, z: number, style: number): number {
  return archFor(zone, floors, eraAt(x, z), style);
}

/** Era of the neighbourhood at a point (900 m noise): the same for a lot and its neighbours. */
export function eraAt(x: number, z: number): number { return fbm(x / 900, z / 900, 777, 2); }

/** Style by the neighbourhood's era and by the seed (`style`; 128 + style = picked by the player). */
export function archFor(zone: number, floors: number, era: number, style: number): number {
  // picked by the player: 128 + style
  if (style >= 128 && style - 128 < ARCHES.length) return style - 128;
  const k = style / 127;
  if (zone === Zone.Industrial) return ArchId.Industrial;
  if (zone === Zone.Residential && floors <= 3) {
    if (era > 0.25) return k < 0.6 ? ArchId.ColonialHouse : ArchId.Sobrado;
    if (era < -0.2) return k < 0.55 ? ArchId.ModernHouse : ArchId.Bungalow;
    return k < 0.4 ? ArchId.Bungalow : k < 0.7 ? ArchId.Sobrado : k < 0.85 ? ArchId.ColonialHouse : ArchId.ModernHouse;
  }
  if (zone === Zone.Commercial && floors >= 8) {
    if (era > 0.3 && floors <= 18) return ArchId.ArtDeco;
    return k < 0.55 ? ArchId.Glass : k < 0.8 ? ArchId.Contemporary : ArchId.ArtDeco;
  }
  if (era > 0.25) return floors <= 5 && k < 0.6 ? ArchId.Colonial : k < 0.85 ? ArchId.ArtDeco : ArchId.Brick;
  if (era < -0.2) return k < 0.65 ? ArchId.Contemporary : ArchId.Tropical;
  return k < 0.3 ? ArchId.Modernist : k < 0.55 ? ArchId.Brick : k < 0.8 ? ArchId.Tropical : ArchId.Contemporary;
}

/**
 * Facade patterns (Roadcraft 4.0 `facadePatterns.ts`): a coherent composition laid over a style. The facade id the
 * vertex carries is style + ARCH_COUNT × pattern; the window table below has one row per id.
 */
export const Pattern = { Residential: 0, Storefront: 1, Office: 2, Industrial: 3, Arcade: 4, Gallery: 5, ArtDeco: 6, ArtDecoCrown: 7, Observation: 8 } as const;
/** Per pattern: window width factor (on the side margin), sill and head shifts, bay rule (4 = every third bay blank, 8 = only every third bay glazed). */
export const PATTERNS: Array<{ name: string; side: number; low: number; high: number; bays: number }> = [
  { name: 'residential', side: 1, low: 0, high: 0, bays: 0 },
  { name: 'storefront', side: 0.6, low: -0.04, high: 0.04, bays: 0 },
  { name: 'office', side: 0.35, low: 0.04, high: 0.02, bays: 0 },
  { name: 'industrial', side: 1, low: 0.3, high: 0, bays: 8 },
  { name: 'arcade', side: 1, low: 0, high: 0, bays: 0 },
  { name: 'gallery', side: 1.15, low: 0, high: 0, bays: 0 },
  { name: 'artDeco', side: 1.25, low: -0.08, high: 0.06, bays: 4 },
  { name: 'artDecoCrown', side: 1.25, low: -0.08, high: 0.06, bays: 4 },
  { name: 'observation', side: 0.35, low: -0.1, high: 0.08, bays: 0 },
];
/** Facade id → style and pattern. */
export const facadeArch = (id: number): number => id % ARCH_COUNT;
export const facadePattern = (id: number): number => Math.floor(id / ARCH_COUNT) % PATTERN_COUNT;

/** Window table per facade id (style × pattern): (side margin, sill, head, bits: 1 shutters, 2 moulding, 4/8 bay rule). */
export function facadeWindowTable(): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = [];
  for (let p = 0; p < PATTERN_COUNT; p++) for (const a of ARCHES) {
    const P = PATTERNS[p], curtain = a.win === Win.Curtain;
    const side = curtain ? a.winSide : Math.max(0.03, Math.min(0.4, a.winSide * P.side));
    const low = curtain ? a.winLow : Math.max(0.02, Math.min(0.8, a.winLow + P.low));
    const high = curtain ? a.winHigh : Math.max(low + 0.12, Math.min(0.97, a.winHigh + P.high));
    out.push([side, low, high, (a.shutters && !P.bays ? 1 : 0) + (a.frame ? 2 : 0) + (curtain ? 0 : P.bays)]);
  }
  // the catalog projects' window shapes (world/catalogFacade.ts), ids 117 and up
  out.push(...catalogWindowRows());
  // last: a pane filled whole (the 4.0 buildings' glass parts, jobs/building40.ts): the room behind it, blinds, night
  out.push([0, 0, 1, 0]);
  return out;
}
/** The whole-pane row of facadeWindowTable (its last): the catalog adds 132 rows (world/catalogFacade.ts, test buildingDesign). */
export const PANE_ROW = 13 * 9 + 132;

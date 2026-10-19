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
export const ARCH_COUNT = 13;

/** Window as the shader draws it. */
export const Win = { Punched: 0, French: 1, Ribbon: 2, Curtain: 3, Tall: 4 } as const;
/** Balcony. */
export const Balcony = { None: 0, Every: 1, Alternate: 2, Continuous: 3 } as const;
/** Crown. */
export const Crown = { Parapet: 0, Cornice: 1, Stepped: 2, Slab: 3 } as const;

export interface Arch {
  name: string;
  walls: number[];
  trim: number;
  /** Base colour (ground floor in stone/cladding), or -1. */
  base: number;
  win: number;
  /** Window: side margin (fraction of the column), sill and head (fraction of the storey). */
  winSide: number; winLow: number; winHigh: number;
  shutters: boolean;
  /** Light moulding around the window. */
  frame: boolean;
  balcony: number;
  crown: number;
  /** Piers standing out every n columns (0 = none). */
  piers: number;
  /** Band standing out every n storeys (0 = none). */
  bands: number;
  /** Column width (m). */
  module: number;
  /** Storey height (m). */
  floorH: number;
  /** Setbacks at the top (stepping). */
  setbacks: number;
  roof: 'flat' | 'hip' | 'gable';
}

/** Walls: Roadcraft 4.0 paints (PALETTE_MATERIALS, FINISH_COLOUR), muted; the finish's map multiplies them. */
export const ARCHES: Arch[] = [
  { name: 'Colonial', walls: [0xe6d8bd, 0xd8c297, 0xf0efe9, 0xe8d2b0, 0xd9c9a8, 0xcfd3c8, 0xe3c9a8, 0xd6b98f],
    trim: 0xf7f4ec, base: -1, win: Win.French, winSide: 0.3, winLow: 0.06, winHigh: 0.8, shutters: true, frame: true,
    balcony: Balcony.Every, crown: Crown.Cornice, piers: 0, bands: 1, module: 3, floorH: 3.6, setbacks: 0, roof: 'flat' },
  { name: 'Art déco', walls: [0xd8c7ad, 0xcfc0a4, 0xe0d5c0, 0xc9b896, 0xd6cbb6, 0xbfb29a, 0xdcd4c4],
    trim: 0xf0e8d6, base: 0xa89c88, win: Win.Tall, winSide: 0.22, winLow: 0.18, winHigh: 0.88, shutters: false, frame: true,
    balcony: Balcony.None, crown: Crown.Stepped, piers: 1, bands: 0, module: 2.6, floorH: 3.4, setbacks: 2, roof: 'flat' },
  { name: 'Modernista', walls: [0xe6e4dc, 0xcfd6da, 0xd8dcd6, 0xc9d3d6, 0xe0dccf, 0xb8c4c8, 0xdcd4c4],
    trim: 0xf4f3ee, base: -1, win: Win.Ribbon, winSide: 0.02, winLow: 0.38, winHigh: 0.86, shutters: false, frame: false,
    balcony: Balcony.Continuous, crown: Crown.Slab, piers: 0, bands: 1, module: 3.2, floorH: 3.0, setbacks: 0, roof: 'flat' },
  { name: 'Contemporâneo', walls: [0xf0efe9, 0xdcdcd6, 0xbdbcb4, 0xc9c4ba, 0x8f9ba5, 0x6f757a, 0xd2c4b2, 0xa89f92, 0xb4b4b0],
    trim: 0x3a3f43, base: 0x5a6066, win: Win.French, winSide: 0.08, winLow: 0.04, winHigh: 0.92, shutters: false, frame: false,
    balcony: Balcony.Continuous, crown: Crown.Parapet, piers: 0, bands: 0, module: 3.4, floorH: 3.0, setbacks: 1, roof: 'flat' },
  { name: 'Tijolinho', walls: [0xa4563f, 0x8c4a35, 0x72412f, 0x9a5a44, 0xb06a4e],
    trim: 0xf2eee6, base: 0x6b6058, win: Win.Punched, winSide: 0.24, winLow: 0.28, winHigh: 0.84, shutters: false, frame: true,
    balcony: Balcony.Alternate, crown: Crown.Cornice, piers: 0, bands: 0, module: 2.9, floorH: 3.0, setbacks: 0, roof: 'flat' },
  { name: 'Tropical', walls: [0xd8c297, 0xc9a882, 0xa8b8a0, 0x9fb3bf, 0xd6b090, 0xe6d8bd, 0xb8a58a, 0xcfd6da],
    trim: 0xf7f5ef, base: -1, win: Win.French, winSide: 0.12, winLow: 0.05, winHigh: 0.86, shutters: true, frame: false,
    balcony: Balcony.Continuous, crown: Crown.Slab, piers: 0, bands: 0, module: 3.3, floorH: 3.0, setbacks: 0, roof: 'flat' },
  { name: 'Envidraçado', walls: [0x8f9ba5, 0x939b91, 0x7d8890, 0x6f7a80, 0x9aa3a8, 0x857f74],
    trim: 0x7d7f80, base: 0x8f8b84, win: Win.Curtain, winSide: 0.02, winLow: 0.24, winHigh: 0.98, shutters: false, frame: false,
    balcony: Balcony.None, crown: Crown.Parapet, piers: 0, bands: 0, module: 1.6, floorH: 3.6, setbacks: 2, roof: 'flat' },
  { name: 'Industrial', walls: [0xbdbcb4, 0xb4b4b0, 0x939b91, 0x8f9ba5, 0xc4c8c1, 0xa9a59a],
    trim: 0x5c6064, base: -1, win: Win.Ribbon, winSide: 0.06, winLow: 0.62, winHigh: 0.84, shutters: false, frame: false,
    balcony: Balcony.None, crown: Crown.Parapet, piers: 0, bands: 0, module: 4, floorH: 5.6, setbacks: 0, roof: 'flat' },
  { name: 'Casa colonial', walls: [0xe6d8bd, 0xf0e6cf, 0xd8c297, 0xe8d8c8, 0xcfd8c8, 0xf0efe9, 0xd9b99a, 0xc8d4dc],
    trim: 0xf7f4ec, base: -1, win: Win.Punched, winSide: 0.26, winLow: 0.3, winHigh: 0.82, shutters: true, frame: true,
    balcony: Balcony.None, crown: Crown.Parapet, piers: 0, bands: 0, module: 3, floorH: 3.0, setbacks: 0, roof: 'hip' },
  { name: 'Bangalô', walls: [0xe6dcc8, 0xd8ccb4, 0xece4d4, 0xd0c4ac, 0xc8d0bc, 0xd4dce0],
    trim: 0xffffff, base: 0x8c7b6a, win: Win.Punched, winSide: 0.22, winLow: 0.32, winHigh: 0.82, shutters: false, frame: true,
    balcony: Balcony.None, crown: Crown.Parapet, piers: 0, bands: 0, module: 3.3, floorH: 2.9, setbacks: 0, roof: 'hip' },
  { name: 'Casa moderna', walls: [0xf0efe9, 0xdcdcd6, 0xc9c4ba, 0x5b6064, 0xb4b4b0, 0x9c6b43, 0x8e8a84],
    trim: 0x3a3f43, base: 0x7b6a5a, win: Win.French, winSide: 0.08, winLow: 0.04, winHigh: 0.9, shutters: false, frame: false,
    balcony: Balcony.None, crown: Crown.Slab, piers: 0, bands: 0, module: 3.6, floorH: 3.0, setbacks: 0, roof: 'flat' },
  { name: 'Sobrado', walls: [0xe6d8bd, 0xe8d0b8, 0xc8d4c0, 0xc8d4dc, 0xd8c8d0, 0xd8c297, 0xa4563f, 0x9a5a44],
    trim: 0xf2eee6, base: -1, win: Win.Punched, winSide: 0.24, winLow: 0.3, winHigh: 0.82, shutters: false, frame: true,
    balcony: Balcony.None, crown: Crown.Parapet, piers: 0, bands: 0, module: 3, floorH: 2.9, setbacks: 0, roof: 'gable' },
  { name: 'Cívico', walls: [0xe8e2d4, 0xd8cfbd, 0xefe9de],
    trim: 0xffffff, base: 0x9a9284, win: Win.Tall, winSide: 0.26, winLow: 0.12, winHigh: 0.86, shutters: false, frame: true,
    balcony: Balcony.None, crown: Crown.Cornice, piers: 1, bands: 0, module: 3.4, floorH: 4.2, setbacks: 0, roof: 'flat' },
];

/** Window parameters per style, for the shader: (side margin, sill, head, bits: 1 shutters, 2 moulding). */
export function archWindowTable(): Array<[number, number, number, number]> {
  return ARCHES.map((a) => [a.winSide, a.winLow, a.winHigh, (a.shutters ? 1 : 0) + (a.frame ? 2 : 0)]);
}

/** Building function (0 = ordinary; growth picks by zone). */
export const Fn = {
  None: 0, School: 1, Church: 2, Hospital: 3, Clinic: 4, Square: 5, Park: 6, GasStation: 7, Supermarket: 8,
  CityHall: 9, Police: 10, FireStation: 11, Mall: 12, SportsCourt: 13,
  // functions added later: the building comes from the creator (a ready design per function), except the cemetery and the playground
  Council: 14, Courthouse: 15, PostOffice: 16, University: 17, Library: 18, Museum: 19, Prison: 20, Cemetery: 21, BusStation: 22,
  Bank: 23, Pharmacy: 24, Bakery: 25, Restaurant: 26, SnackBar: 27, Bar: 28, Cinema: 29, Hotel: 30, Gym: 31, Club: 32, Office: 33, Playground: 34,
} as const;
export const FN_NAMES = ['', 'Escola', 'Igreja', 'Hospital', 'Posto de saúde', 'Praça', 'Parque', 'Posto de gasolina', 'Supermercado',
  'Prefeitura', 'Delegacia', 'Bombeiros', 'Shopping', 'Quadra',
  'Câmara de Vereadores', 'Fórum', 'Correios', 'Faculdade', 'Biblioteca', 'Museu', 'Presídio', 'Cemitério', 'Rodoviária',
  'Agência bancária', 'Farmácia', 'Padaria', 'Restaurante', 'Lanchonete', 'Bar', 'Cinema', 'Hotel', 'Academia', 'Clube', 'Escritórios', 'Parquinho'];

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
export const PATTERN_COUNT = 9;
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
  return out;
}

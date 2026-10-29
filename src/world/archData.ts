// Architectural style data: colours, window/balcony/crown parameters and module sizes. Pure data, no imports:
// `arch.ts` keeps the behaviour and re-exports these for existing callers. This split breaks the runtime cycle
// arch.ts <-> catalogFacade.ts (the catalog needs the data; the data needs no catalog code).

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

/** Windows: the 4.0 styles' openings (architecture.ts:44-178: width and height shares, sill in metres). Walls: Roadcraft 4.0 paints (PALETTE_MATERIALS, FINISH_COLOUR), muted; the finish's map multiplies them. */
export const ARCHES: Arch[] = [
  { name: 'Colonial', walls: [0xe6d8bd, 0xd8c297, 0xf0efe9, 0xe8d2b0, 0xd9c9a8, 0xcfd3c8, 0xe3c9a8, 0xd6b98f],
    trim: 0xf7f4ec, base: -1, win: Win.French, winSide: 0.305, winLow: 0.25, winHigh: 0.88, shutters: true, frame: true,
    balcony: Balcony.Every, crown: Crown.Cornice, piers: 0, bands: 1, module: 3, floorH: 3.6, setbacks: 0, roof: 'flat' },
  { name: 'Art déco', walls: [0xd8c7ad, 0xcfc0a4, 0xe0d5c0, 0xc9b896, 0xd6cbb6, 0xbfb29a, 0xdcd4c4],
    trim: 0xf0e8d6, base: 0xa89c88, win: Win.Tall, winSide: 0.305, winLow: 0.25, winHigh: 0.91, shutters: false, frame: true,
    balcony: Balcony.None, crown: Crown.Stepped, piers: 1, bands: 0, module: 2.6, floorH: 3.4, setbacks: 2, roof: 'flat' },
  { name: 'Modernista', walls: [0xe6e4dc, 0xcfd6da, 0xd8dcd6, 0xc9d3d6, 0xe0dccf, 0xb8c4c8, 0xdcd4c4],
    trim: 0xf4f3ee, base: -1, win: Win.Ribbon, winSide: 0.113, winLow: 0.3, winHigh: 0.84, shutters: false, frame: false,
    balcony: Balcony.Continuous, crown: Crown.Slab, piers: 0, bands: 1, module: 3.2, floorH: 3.0, setbacks: 0, roof: 'flat' },
  { name: 'Contemporâneo', walls: [0xf0efe9, 0xdcdcd6, 0xbdbcb4, 0xc9c4ba, 0x8f9ba5, 0x6f757a, 0xd2c4b2, 0xa89f92, 0xb4b4b0],
    trim: 0x3a3f43, base: 0x5a6066, win: Win.French, winSide: 0.162, winLow: 0.267, winHigh: 0.827, shutters: false, frame: false,
    balcony: Balcony.Continuous, crown: Crown.Parapet, piers: 0, bands: 0, module: 3.4, floorH: 3.0, setbacks: 1, roof: 'flat' },
  { name: 'Tijolinho', walls: [0xa4563f, 0x8c4a35, 0x72412f, 0x9a5a44, 0xb06a4e],
    trim: 0xf2eee6, base: 0x6b6058, win: Win.Punched, winSide: 0.25, winLow: 0.283, winHigh: 0.903, shutters: false, frame: true,
    balcony: Balcony.Alternate, crown: Crown.Cornice, piers: 0, bands: 0, module: 2.9, floorH: 3.0, setbacks: 0, roof: 'flat' },
  { name: 'Tropical', walls: [0xd8c297, 0xc9a882, 0xa8b8a0, 0x9fb3bf, 0xd6b090, 0xe6d8bd, 0xb8a58a, 0xcfd6da],
    trim: 0xf7f5ef, base: -1, win: Win.French, winSide: 0.113, winLow: 0.3, winHigh: 0.8, shutters: true, frame: false,
    balcony: Balcony.Continuous, crown: Crown.Slab, piers: 0, bands: 0, module: 3.3, floorH: 3.0, setbacks: 0, roof: 'flat' },
  { name: 'Envidraçado', walls: [0x8f9ba5, 0x939b91, 0x7d8890, 0x6f7a80, 0x9aa3a8, 0x857f74],
    trim: 0x7d7f80, base: 0x8f8b84, win: Win.Curtain, winSide: 0.02, winLow: 0.24, winHigh: 0.98, shutters: false, frame: false,
    balcony: Balcony.None, crown: Crown.Parapet, piers: 0, bands: 0, module: 1.6, floorH: 3.6, setbacks: 2, roof: 'flat' },
  { name: 'Industrial', walls: [0xbdbcb4, 0xb4b4b0, 0x939b91, 0x8f9ba5, 0xc4c8c1, 0xa9a59a],
    trim: 0x5c6064, base: -1, win: Win.Ribbon, winSide: 0.05, winLow: 0.214, winHigh: 0.614, shutters: false, frame: false,
    balcony: Balcony.None, crown: Crown.Parapet, piers: 0, bands: 0, module: 4, floorH: 5.6, setbacks: 0, roof: 'flat' },
  { name: 'Casa colonial', walls: [0xe6d8bd, 0xf0e6cf, 0xd8c297, 0xe8d8c8, 0xcfd8c8, 0xf0efe9, 0xd9b99a, 0xc8d4dc],
    trim: 0xf7f4ec, base: -1, win: Win.Punched, winSide: 0.3, winLow: 0.317, winHigh: 0.917, shutters: true, frame: true,
    balcony: Balcony.None, crown: Crown.Parapet, piers: 0, bands: 0, module: 3, floorH: 3.0, setbacks: 0, roof: 'hip' },
  { name: 'Bangalô', walls: [0xe6dcc8, 0xd8ccb4, 0xece4d4, 0xd0c4ac, 0xc8d0bc, 0xd4dce0],
    trim: 0xffffff, base: 0x8c7b6a, win: Win.Punched, winSide: 0.262, winLow: 0.345, winHigh: 0.885, shutters: false, frame: true,
    balcony: Balcony.None, crown: Crown.Parapet, piers: 0, bands: 0, module: 3.3, floorH: 2.9, setbacks: 0, roof: 'hip' },
  { name: 'Casa moderna', walls: [0xf0efe9, 0xdcdcd6, 0xc9c4ba, 0x5b6064, 0xb4b4b0, 0x9c6b43, 0x8e8a84],
    trim: 0x3a3f43, base: 0x7b6a5a, win: Win.French, winSide: 0.113, winLow: 0.2, winHigh: 0.8, shutters: false, frame: false,
    balcony: Balcony.None, crown: Crown.Slab, piers: 0, bands: 0, module: 3.6, floorH: 3.0, setbacks: 0, roof: 'flat' },
  { name: 'Sobrado', walls: [0xe6d8bd, 0xe8d0b8, 0xc8d4c0, 0xc8d4dc, 0xd8c8d0, 0xd8c297, 0xa4563f, 0x9a5a44],
    trim: 0xf2eee6, base: -1, win: Win.Punched, winSide: 0.28, winLow: 0.31, winHigh: 0.92, shutters: false, frame: true,
    balcony: Balcony.None, crown: Crown.Parapet, piers: 0, bands: 0, module: 3, floorH: 2.9, setbacks: 0, roof: 'gable' },
  { name: 'Cívico', walls: [0xe8e2d4, 0xd8cfbd, 0xefe9de],
    trim: 0xffffff, base: 0x9a9284, win: Win.Tall, winSide: 0.26, winLow: 0.12, winHigh: 0.86, shutters: false, frame: true,
    balcony: Balcony.None, crown: Crown.Cornice, piers: 1, bands: 0, module: 3.4, floorH: 4.2, setbacks: 0, roof: 'flat' },
];

export const PATTERN_COUNT = 9;

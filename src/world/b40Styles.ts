// The architectural styles of the 4.0 grown buildings, as b40 data: the skins and trims a building draws from,
// the bay rhythms of its street and back faces, its dress, opening proportions, piers and module, plus the weights
// that pick a style for a kind of building and the era affinity of a quarter. Values from Roadcraft 4.0
// world/buildings/architecture.ts (STYLES, FOR, ERA_AFFINITY); colours are sRGB hex and carry their linear triple,
// precomputed once here, so the generator never converts a colour per building.
import { FIN } from '../shared/finishes.ts';
import { linearRgb } from '../core/color.ts';
import { B40_BAY, B40_CROWN, B40_KIND, B40_LINES } from './b40Kinds.ts';

export interface B40Paint {
  readonly finish: number;
  /** 0xRRGGBB, sRGB. */
  readonly colour: number;
  /** The same colour in linear RGB, for the shader and the mesh. */
  readonly linear: readonly [number, number, number];
}

const paint = (finish: number, colour: number): B40Paint => ({ finish, colour, linear: linearRgb(colour) });
const tones = (finish: number, colours: readonly number[]): B40Paint[] => colours.map((c) => paint(finish, c));

export interface B40Opening {
  /** The window's share of its bay's width and of its storey's height. */
  readonly width: readonly [number, number];
  readonly height: readonly [number, number];
  /** Metres. */
  readonly sill: number;
}

export interface B40Piers {
  readonly width: number;
  readonly depth: number;
  readonly every: number;
}

export interface B40Style {
  readonly skins: readonly B40Paint[];
  readonly trims: readonly B40Paint[];
  /** Column rhythms of the street and back faces, counted from the ends in. */
  readonly rhythms: readonly (readonly number[])[];
  readonly sideFill: number;
  readonly groundFill: number;
  readonly top: number | null;
  readonly lines: number;
  readonly crown: number;
  readonly opening: B40Opening;
  readonly piers?: B40Piers;
  readonly stoneBase?: boolean;
  /** The column module the openings sit on, metres. */
  readonly module: number;
}

/** The 4.0 style keys, as dense codes in the architecture.ts order. */
export const B40_STYLE = {
  Colonial: 0, ArtDeco: 1, Modernist: 2, Contemporary: 3, Brick: 4, Tropical: 5, Glass: 6, Industrial: 7,
  ColonialHouse: 8, Bungalow: 9, ModernHouse: 10, Sobrado: 11,
} as const;
export type B40StyleCode = (typeof B40_STYLE)[keyof typeof B40_STYLE];
export const B40_STYLE_COUNT = 12;

const BAY = B40_BAY;

export const B40_STYLES: readonly B40Style[] = [
  { // Colonial: rendered in strong colours, white frames and surrounds, louvred shutters
    skins: tones(FIN.Plaster, [0xe9c46a, 0xd98c5f, 0x7fa8c9, 0xe8a7a0, 0x9cc5a1, 0xf1e3c6, 0xc96f53, 0xe0b54b, 0x88a9b5, 0xd7b9d5]),
    trims: [paint(FIN.Plaster, 0xf7f4ec), paint(FIN.Plaster, 0xf1ead9)],
    rhythms: [[BAY.ShutteredWindow], [BAY.ShutteredWindow, BAY.FrenchWindow, BAY.ShutteredWindow], [BAY.FrenchWindow, BAY.Balcony, BAY.FrenchWindow], [BAY.FrenchWindow]],
    sideFill: BAY.Window, groundFill: BAY.ShutteredWindow, top: null,
    lines: B40_LINES.Base, crown: B40_CROWN.Cornice,
    opening: { width: [0.36, 0.42], height: [0.6, 0.66], sill: 0.9 },
    module: 3,
  },
  { // Art Deco: stone and cream render, bronze frames, piers, a stepped cornice
    skins: [...tones(FIN.Stucco, [0xe8dcc4, 0xdccaa6, 0xefe4cf, 0xd8c7ad]), ...tones(FIN.Stone, [0xcfc4ae, 0xd9cdb4])],
    trims: [paint(FIN.Metal, 0x5f4a33), paint(FIN.Plaster, 0xf0e8d6), paint(FIN.Metal, 0x3b3d3f)],
    rhythms: [[BAY.SashWindow], [BAY.SashWindow, BAY.SashWindow, BAY.BayWindow]],
    sideFill: BAY.SashWindow, groundFill: BAY.Window, top: BAY.Window,
    lines: B40_LINES.None, crown: B40_CROWN.Deco,
    opening: { width: [0.36, 0.42], height: [0.62, 0.7], sill: 0.85 },
    piers: { width: 0.55, depth: 0.32, every: 1 },
    stoneBase: true,
    module: 2.8,
  },
  { // Brazilian modernism: light walls or pastilhas, brise-soleil, ribbon windows, slabs
    skins: [...tones(FIN.Ceramic, [0xe9ecea, 0x9fbfcf, 0xa9cbb4, 0xe8d38f, 0x7fa0bf, 0xd9a07a, 0x8fb5a8]), ...tones(FIN.Plaster, [0xf2f0ea, 0xe6e4dc])],
    trims: [paint(FIN.Plaster, 0xf4f3ee), paint(FIN.Metal, 0xb9bcbd), paint(FIN.Concrete, 0xd6d2c8)],
    rhythms: [[BAY.Brise], [BAY.Ribbon, BAY.Brise, BAY.Brise], [BAY.Brise, BAY.Ribbon]],
    sideFill: BAY.Ribbon, groundFill: BAY.WideWindow, top: BAY.Ribbon,
    lines: B40_LINES.Slab, crown: B40_CROWN.Slab,
    opening: { width: [0.7, 0.85], height: [0.5, 0.58], sill: 0.9 },
    module: 3,
  },
  { // Today's residential block: light render or pastilha, graphite frames, glass-railed balconies
    skins: [...tones(FIN.Plaster, [0xf1f0ec, 0xe7e3dc, 0xcfc8bd, 0xd8b99a, 0xb7c2b0]),
      ...tones(FIN.Ceramic, [0x8e959a, 0xb4673f, 0xc9a27a, 0x7d8b78, 0x4a5258, 0x3f6b72, 0xa65f45, 0x6f7f91]),
      paint(FIN.Concrete, 0xbab7b0)],
    trims: [paint(FIN.Metal, 0x2e3134), paint(FIN.Metal, 0x4a4f53), paint(FIN.Metal, 0x8e9396)],
    rhythms: [[BAY.Gourmet, BAY.Window, BAY.Gourmet], [BAY.Window, BAY.Gourmet, BAY.Gourmet], [BAY.Loggia, BAY.Window], [BAY.Gourmet, BAY.Gourmet, BAY.Window, BAY.Window]],
    sideFill: BAY.Window, groundFill: BAY.WideWindow, top: BAY.WideWindow,
    lines: B40_LINES.None, crown: B40_CROWN.Attic,
    opening: { width: [0.6, 0.75], height: [0.52, 0.6], sill: 0.8 },
    module: 3.2,
  },
  { // Exposed brick, white or black frames, concrete lintels, a cornice
    skins: tones(FIN.Brick, [0xa4563f, 0x8c4a35, 0xb86a4a, 0x9a6a52, 0xb07a5a, 0x7d5444]),
    trims: [paint(FIN.Plaster, 0xf4f2ec), paint(FIN.Metal, 0x26282a), paint(FIN.Metal, 0x2f4a3a)],
    rhythms: [[BAY.Window], [BAY.Window, BAY.FrenchWindow, BAY.Window], [BAY.Balcony, BAY.Window, BAY.Window]],
    sideFill: BAY.Window, groundFill: BAY.Window, top: null,
    lines: B40_LINES.Every, crown: B40_CROWN.Cornice,
    opening: { width: [0.45, 0.55], height: [0.6, 0.64], sill: 0.85 },
    piers: { width: 0.35, depth: 0.12, every: 1 },
    module: 3,
  },
  { // The coloured Brazilian block of the 60s-70s
    skins: tones(FIN.Ceramic, [0x3f78a8, 0x4f9a86, 0xc0633f, 0xd3a03a, 0x2f6f8f, 0x8fb9a0, 0xb84a3a, 0x6f8fb8, 0xe0c27a, 0x5a8a5a]),
    trims: [paint(FIN.Plaster, 0xf7f5ef), paint(FIN.Metal, 0x26282a)],
    rhythms: [[BAY.Ribbon], [BAY.Balcony, BAY.Ribbon, BAY.Balcony], [BAY.Ribbon, BAY.Balcony]],
    sideFill: BAY.Window, groundFill: BAY.Window, top: null,
    lines: B40_LINES.Slab, crown: B40_CROWN.Slab,
    opening: { width: [0.7, 0.85], height: [0.46, 0.54], sill: 0.9 },
    module: 3,
  },
  { // A curtain wall: tinted glass floor to floor, slim black or silver mullions
    skins: tones(FIN.Glass, [0x8fb0c0, 0x6f8f9f, 0x9fb8b0, 0x7d97b5, 0x5d7280, 0x4f7f6a, 0x8a6f4f, 0x2f4f7f, 0x3f7f86, 0xb8a68a]),
    trims: [paint(FIN.Metal, 0x1e2022), paint(FIN.Metal, 0x8e9396)],
    rhythms: [[BAY.WideWindow]],
    sideFill: BAY.WideWindow, groundFill: BAY.WideWindow, top: null,
    lines: B40_LINES.None, crown: B40_CROWN.Attic,
    opening: { width: [0.92, 0.94], height: [0.78, 0.82], sill: 0.25 },
    module: 3,
  },
  { // Sheds: metal or fibre-cement panels, a parapet hiding the roof edge
    skins: [...tones(FIN.Panel, [0x8f9ba5, 0xa3a9a6, 0x9aa49a, 0x7f8b8f, 0x6f7f8c, 0x8a9a7c, 0xc2b8a3]), ...tones(FIN.Metal, [0xb7b2a6, 0x7c8a96]), paint(FIN.Concrete, 0xb0aca2)],
    trims: [paint(FIN.Metal, 0x3b4044), paint(FIN.Metal, 0xd8dad6)],
    rhythms: [[BAY.Ribbon]],
    sideFill: BAY.Wall, groundFill: BAY.Wall, top: null,
    lines: B40_LINES.None, crown: B40_CROWN.Attic,
    opening: { width: [0.9, 0.9], height: [0.4, 0.4], sill: 1.2 },
    module: 3,
  },
  { // Houses: colonial
    skins: tones(FIN.Plaster, [0xf2d98a, 0xe8c66a, 0xf0c4a4, 0x9fc4a8, 0xb8d0e0, 0xeac6cc, 0xf6f1e6, 0xd98e6a, 0xa9c6c9, 0xe9cf8f]),
    trims: [paint(FIN.Plaster, 0xf7f5ef)],
    rhythms: [[BAY.ShutteredWindow]],
    sideFill: BAY.Window, groundFill: BAY.ShutteredWindow, top: null,
    lines: B40_LINES.None, crown: B40_CROWN.Cornice,
    opening: { width: [0.38, 0.42], height: [0.58, 0.62], sill: 0.95 },
    module: 2.6,
  },
  { // Houses: bungalow
    skins: [...tones(FIN.Plaster, [0xf2ead8, 0xe9dcc0, 0xf0e4cc, 0xe4d6bc, 0xcfe0c3, 0xd5e3ec, 0xf3e1a6]), ...tones(FIN.Stucco, [0xe8dcc2, 0xd9c6a8])],
    trims: [paint(FIN.Plaster, 0xf7f5ef), paint(FIN.Wood, 0x7a5536), paint(FIN.Plaster, 0x2f5a7a), paint(FIN.Plaster, 0x3d6b45)],
    rhythms: [[BAY.Window], [BAY.Window, BAY.FrenchWindow, BAY.Window]],
    sideFill: BAY.Window, groundFill: BAY.Window, top: null,
    lines: B40_LINES.None, crown: B40_CROWN.None,
    opening: { width: [0.4, 0.55], height: [0.5, 0.58], sill: 1 },
    module: 3,
  },
  { // Houses: modern
    skins: [...tones(FIN.Plaster, [0xf4f3ef, 0xe6e4df, 0xd8d5ce, 0x5b6064]), paint(FIN.Concrete, 0xb8b5ae), paint(FIN.Wood, 0x9c6b43), ...tones(FIN.Ceramic, [0xc9c4ba, 0x8e8a84])],
    trims: [paint(FIN.Metal, 0x2e3134), paint(FIN.Metal, 0x8e9396)],
    rhythms: [[BAY.WideWindow], [BAY.WideWindow, BAY.Loggia], [BAY.FrenchWindow, BAY.WideWindow]],
    sideFill: BAY.Window, groundFill: BAY.WideWindow, top: null,
    lines: B40_LINES.None, crown: B40_CROWN.Slab,
    opening: { width: [0.7, 0.85], height: [0.55, 0.65], sill: 0.6 },
    module: 3,
  },
  { // Houses: sobrado
    skins: [...tones(FIN.Plaster, [0xf1d98a, 0xf0c4a4, 0xb9d3b0, 0xb8d0e0, 0xd9c2d8, 0xe9dcc0, 0xc9714f, 0x7fa88f]), ...tones(FIN.Brick, [0xa4563f, 0xb86a4a])],
    trims: [paint(FIN.Plaster, 0xf7f5ef), paint(FIN.Plaster, 0xeee6d2), paint(FIN.Wood, 0x7a5536)],
    rhythms: [[BAY.SashWindow], [BAY.FrenchWindow, BAY.SashWindow], [BAY.Balcony, BAY.SashWindow]],
    sideFill: BAY.Window, groundFill: BAY.Window, top: null,
    lines: B40_LINES.Base, crown: B40_CROWN.Cornice,
    opening: { width: [0.4, 0.48], height: [0.6, 0.66], sill: 0.9 },
    module: 2.8,
  },
];

/** The styles each kind of building is drawn from, with their weights (4.0 `FOR`). */
export const B40_FOR: Readonly<Record<number, readonly (readonly [number, number])[]>> = {
  [B40_KIND.House]: [[B40_STYLE.Bungalow, 3], [B40_STYLE.ColonialHouse, 2], [B40_STYLE.ModernHouse, 2], [B40_STYLE.Sobrado, 2]],
  [B40_KIND.Flats]: [[B40_STYLE.Contemporary, 3], [B40_STYLE.Colonial, 1], [B40_STYLE.ArtDeco, 2], [B40_STYLE.Modernist, 2], [B40_STYLE.Brick, 1.5], [B40_STYLE.Tropical, 2]],
  [B40_KIND.Tower]: [[B40_STYLE.Contemporary, 4], [B40_STYLE.Modernist, 2], [B40_STYLE.ArtDeco, 1.5], [B40_STYLE.Tropical, 1.5], [B40_STYLE.Glass, 1]],
  [B40_KIND.Shop]: [[B40_STYLE.Colonial, 3], [B40_STYLE.ArtDeco, 2], [B40_STYLE.Brick, 2], [B40_STYLE.Contemporary, 2], [B40_STYLE.Modernist, 1.5], [B40_STYLE.Tropical, 1]],
  [B40_KIND.Office]: [[B40_STYLE.Glass, 4], [B40_STYLE.Modernist, 2], [B40_STYLE.Contemporary, 1.5], [B40_STYLE.ArtDeco, 1]],
  [B40_KIND.Works]: [[B40_STYLE.Industrial, 1]],
};

/** The era of a quarter: its buildings were mostly put up in one period (4.0 `ERA_AFFINITY`, per style). */
export const B40_ERA_AFFINITY: readonly (readonly [number, number, number])[] = [
  [3, 0.5, 0.15],   // colonial
  [2.5, 1, 0.2],    // artDeco
  [0.7, 3, 1],      // modernist
  [0.3, 1, 3],      // contemporary
  [2, 1.5, 0.5],    // brick
  [0.5, 3, 0.5],    // tropical
  [0.2, 1, 3],      // glass
  [1, 1, 1],        // industrial
  [3, 0.8, 0.2],    // colonialHouse
  [1.5, 2, 1.5],    // bungalow
  [0.2, 1, 3],      // modernHouse
  [3, 1.5, 0.3],    // sobrado
];

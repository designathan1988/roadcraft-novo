// What stands on a flat roof, chosen and packed per roof: Roadcraft 4.0 world/buildings/roofPlant.ts (its catalogue,
// chances, sizes and packing, in metres), so the same kinds of plant stand on the same kinds of roof.

import { stream } from '../core/rng.ts';

export type RoofPlantKind =
  | 'tank' | 'tankBox' | 'hatch' | 'condenser' | 'airHandler' | 'solar' | 'mast' | 'dish' | 'skylight' | 'vent' | 'liftRoom' | 'chimney';

export interface RoofPlantItem {
  readonly kind: RoofPlantKind;
  /** The piece's footprint on the roof (local metres). */
  readonly x0: number; readonly z0: number; readonly x1: number; readonly z1: number;
  /** How tall it stands over the roof. */
  readonly h: number;
  /** A variant of the kind (a colour, a size of array), 0..3. */
  readonly variant: number;
}

export type RoofUse = 'residential' | 'commercial' | 'industrial';

export interface RoofSite {
  /** The seed (the building's) and the roof's own number. */
  readonly seed: number;
  readonly volume: number;
  readonly use: RoofUse;
  /** Storeys to the roof. */
  readonly storeys: number;
  /** The roof's rectangle (local metres). */
  readonly x0: number; readonly z0: number; readonly x1: number; readonly z1: number;
  /** How old it looks, 0 new to 1 old. */
  readonly age: number;
  /** A lift core drawn by the building itself: no machine room to add. */
  readonly hasCore?: boolean;
  /** Rectangles taken already (a block standing on the roof). */
  readonly blocked?: readonly { readonly x0: number; readonly z0: number; readonly x1: number; readonly z1: number }[];
}

interface Kind {
  readonly kind: RoofPlantKind;
  readonly w: number; readonly d: number; readonly h: number;
  readonly most: number;
  readonly chance: (s: RoofSite, area: number) => number;
  /** One piece for this many square metres of roof, times its chance. */
  readonly perArea?: number;
}

const USE = (s: RoofSite, r: number, c: number, i: number): number => (s.use === 'residential' ? r : s.use === 'industrial' ? i : c);

/** 4.0 CATALOGUE (roofPlant.ts:58-74). */
const CATALOGUE: readonly Kind[] = [
  { kind: 'liftRoom', w: 2.6, d: 2.6, h: 2.5, most: 1, chance: (s) => (s.storeys >= 4 && !s.hasCore ? 1 : 0) },
  { kind: 'tankBox', w: 3.2, d: 2.4, h: 2.2, most: 1, chance: (s) => (s.storeys >= 6 ? USE(s, 0.7, 0.5, 0.2) : 0) },
  { kind: 'tank', w: 1.9, d: 1.9, h: 1.5, most: 2, chance: (s) => (s.storeys < 6 ? USE(s, 0.75, 0.55, 0.35) : USE(s, 0.25, 0.2, 0.2)) },
  { kind: 'hatch', w: 0.9, d: 0.9, h: 0.45, most: 1, chance: () => 0.9 },
  { kind: 'airHandler', w: 3.4, d: 1.8, h: 1.6, most: 2, perArea: 260, chance: (s, a) => (a > 150 ? USE(s, 0.1, 0.8, 0.5) : 0) },
  { kind: 'condenser', w: 0.9, d: 0.8, h: 0.85, most: 6, perArea: 30, chance: (s) => USE(s, 0.5, 0.8, 0.35) * (0.6 + 0.6 * (1 - s.age)) },
  { kind: 'solar', w: 4.6, d: 3.4, h: 0.4, most: 3, chance: (s) => USE(s, 0.3, 0.2, 0.45) * (1.3 - s.age) },
  { kind: 'mast', w: 0.6, d: 0.6, h: 3.5, most: 3, chance: (s) => (s.storeys >= 10 ? 0.7 : USE(s, 0.45, 0.25, 0.1) * (0.4 + s.age)) },
  { kind: 'dish', w: 0.9, d: 0.7, h: 1.2, most: 2, perArea: 180, chance: (s) => USE(s, 0.6, 0.3, 0.05) },
  { kind: 'skylight', w: 1.2, d: 1.2, h: 0.25, most: 6, chance: (s) => USE(s, 0.15, 0.25, 0.7) },
  { kind: 'vent', w: 0.7, d: 0.7, h: 0.9, most: 5, perArea: 70, chance: (s) => USE(s, 0.1, 0.6, 0.75) },
  { kind: 'chimney', w: 0.9, d: 0.9, h: 4.5, most: 1, chance: (s) => USE(s, 0, 0, 0.3) },
];

/** Grid cell of the packing, the clear way kept round each piece, the parapet's margin. */
const CELL = 0.5, CLEAR = 0.6, EDGE = 0.8;


/** The plant of one roof (4.0 planRoofPlant, roofPlant.ts:94-145): each kind by its chance, packed at random free places. */
export function planRoofPlant(site: RoofSite): RoofPlantItem[] {
  const W = site.x1 - site.x0, D = site.z1 - site.z0;
  if (W < 4 || D < 4) return [];
  const rnd = stream(Math.imul(site.seed, 2_654_435_761) ^ Math.imul(site.volume + 7, 40_503) ^ 0x5f3759df);
  const area = W * D;
  const gx0 = site.x0 + EDGE, gz0 = site.z0 + EDGE;
  const nx = Math.max(0, Math.floor((W - 2 * EDGE) / CELL)), nz = Math.max(0, Math.floor((D - 2 * EDGE) / CELL));
  const used = new Uint8Array(nx * nz);
  const free = (i0: number, j0: number, i1: number, j1: number): boolean => {
    if (i0 < 0 || j0 < 0 || i1 > nx || j1 > nz) return false;
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) if (used[j * nx + i]) return false;
    return true;
  };
  const take = (i0: number, j0: number, i1: number, j1: number): void => {
    for (let j = Math.max(0, j0); j < Math.min(nz, j1); j++) for (let i = Math.max(0, i0); i < Math.min(nx, i1); i++) used[j * nx + i] = 1;
  };
  const clear = Math.ceil(CLEAR / CELL);
  for (const r of site.blocked ?? []) {
    take(Math.floor((r.x0 - gx0) / CELL) - clear, Math.floor((r.z0 - gz0) / CELL) - clear, Math.ceil((r.x1 - gx0) / CELL) + clear, Math.ceil((r.z1 - gz0) / CELL) + clear);
  }
  const out: RoofPlantItem[] = [];
  for (const k of CATALOGUE) {
    let p = Math.min(1, k.chance(site, area));
    const target = k.perArea ? Math.min(k.most * 6, Math.round((area / k.perArea) * p + rnd() * 0.8)) : -1;
    if (target >= 0) p = 1;
    for (let n = 0; target >= 0 ? n < target : n < k.most && rnd() < p; n++) {
      const variant = Math.floor(rnd() * 4);
      const scale = k.kind === 'solar' ? 0.7 + variant * 0.25 : 1;
      const turn = rnd() < 0.5;
      const w = k.w * scale, d = k.d * (k.kind === 'solar' ? 1 : scale);
      const [pw, pd] = turn && k.kind !== 'solar' ? [d, w] : [w, d];
      const ci = Math.ceil(pw / CELL), cj = Math.ceil(pd / CELL);
      if (ci > nx || cj > nz) break;
      let at: [number, number] | null = null;
      for (let t = 0; t < 24 && !at; t++) {
        const i = Math.floor(rnd() * (nx - ci + 1)), j = Math.floor(rnd() * (nz - cj + 1));
        if (free(i, j, i + ci, j + cj)) at = [i, j];
      }
      if (!at) break;
      const [i, j] = at;
      take(i - clear, j - clear, i + ci + clear, j + cj + clear);
      out.push({ kind: k.kind, x0: gx0 + i * CELL, z0: gz0 + j * CELL, x1: gx0 + i * CELL + pw, z1: gz0 + j * CELL + pd, h: k.h, variant });
      if (target < 0) p *= 0.6;
    }
  }
  return out;
}

/** 4.0 roofPlan.ts:8-17: the colours of a roof's pieces and of its water tanks. */
export const ROOF_COLOURS = { plant: 0x6c6a64, condenser: 0xc9ccc9, solar: 0x1d2b45, skylight: 0x8fb4c6, chimney: 0x8c4a35, drain: 0x2d3033 } as const;
export const TANK_COLOURS: readonly number[] = [0x4a7fb8, 0x8d9399, 0xdcdedb, 0xc9b48a];
/** 4.0 materials.ts FLAT_ROOFS: tar-dark membrane, grey membrane, white sheet, beige gravel, concrete. */
export const FLAT_ROOFS: readonly number[] = [0x74716a, 0x4f4d49, 0x8f8c84, 0xc8c5bc, 0x8c8170, 0x9d9a92, 0x5f5a52];

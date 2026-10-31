/** Procedural texture recipes and the texels they bake: pure, run at build time (`scripts/vite/surface-bake-plugin.ts`), nothing baked during play. */

/** Deterministic 2D value noise with a positive integer period, so the result tiles. */
export function makeNoise(seed: number): (x: number, y: number, period: number) => number {
  const seedHash = Math.imul(seed, 2_246_822_519);
  const hash = (x: number, y: number): number => {
    let h = Math.imul(x | 0, 374_761_393) ^ Math.imul(y | 0, 668_265_263) ^ seedHash;
    h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
    return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
  };
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  return (x: number, y: number, period: number): number => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = smooth(x - x0);
    const fy = smooth(y - y0);
    const rx = x0 % period;
    const ry = y0 % period;
    const ax = rx < 0 ? rx + period : rx;
    const ay = ry < 0 ? ry + period : ry;
    const bx = ax + 1 === period ? 0 : ax + 1;
    const by = ay + 1 === period ? 0 : ay + 1;
    const a = hash(ax, ay);
    const b = hash(bx, ay);
    const c = hash(ax, by);
    const d = hash(bx, by);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
}

/** Sums octaves of tiling value noise. Returns roughly 0..1. */
export function fbm(
  noise: (x: number, y: number, period: number) => number,
  x: number,
  y: number,
  basePeriod: number,
  octaves: number,
): number {
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  let period = basePeriod;
  let frequency = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amplitude * noise(x * frequency, y * frequency, period);
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
    period *= 2;
  }
  return sum / total;
}

export interface SurfaceRecipe {
  readonly size: number;
  /** World units covered by one tile of the texture. */
  readonly worldSize: number;
  /** Fills colour (0..1 rgb), height (0..1) and roughness (0..1) for one texel, and metalness */
  readonly shade: (
    u: number,
    v: number,
    out: { r: number; g: number; b: number; h: number; rough: number; metal?: number },
  ) => void;
  /** Relief strength of the derived normal map. */
  readonly relief: number;
  /** A surface of metal and non-metal side by side (a curtain wall's aluminium mullions round its glass) */
  readonly metallic?: boolean;
}

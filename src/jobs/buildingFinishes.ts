// Building finishes: 13 procedural, tiling texture recipes (after Roadcraft 4.0 `bake/finishRecipes.ts`), baked in a
// worker at load into two texture-array layers each: albedo tone (rgb, mean normalised to 0.5) + roughness (a), and
// a tangent-space normal derived from the same height field (rgb) + metalness (a). No three here: workers only.

/** Finish ids as the vertex carries them (high nibble of the material byte). 0 = by material (see FINISH_BY_MAT). */
export const FIN = {
  Auto: 0, Plaster: 1, Ceramic: 2, Brick: 3, Stone: 4, Concrete: 5, Wood: 6, Metal: 7, Glass: 8, Tile: 9, Roofing: 10,
  Stucco: 11, Panel: 12, Slate: 13,
} as const;
export const FINISH_COUNT = 13;
/** Texels per layer side (every finish bakes at this size; density is set by `worldSize`). */
export const FINISH_SIZE = 256;

export interface FinishLook {
  /** Metres one tile of the texture covers. */
  worldSize: number;
  /** Relief of the derived normal map (central difference × relief). */
  relief: number;
  /** Strength of the normal on the material, 0..1. */
  normalScale: number;
  shade: (x: number, y: number, out: Texel) => void;
}
export interface Texel { r: number; g: number; b: number; h: number; rough: number; metal: number }

/** Tiling value noise with an integer period. */
export function makeNoise(seed: number): (x: number, y: number, period: number) => number {
  const seedHash = Math.imul(seed, 2_246_822_519);
  const hash = (x: number, y: number): number => {
    let h = Math.imul(x | 0, 374_761_393) ^ Math.imul(y | 0, 668_265_263) ^ seedHash;
    h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
    return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
  };
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  return (x, y, period) => {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = smooth(x - x0), fy = smooth(y - y0);
    const rx = x0 % period, ry = y0 % period;
    const ax = rx < 0 ? rx + period : rx, ay = ry < 0 ? ry + period : ry;
    const bx = ax + 1 === period ? 0 : ax + 1, by = ay + 1 === period ? 0 : ay + 1;
    return (hash(ax, ay) * (1 - fx) + hash(bx, ay) * fx) * (1 - fy) + (hash(ax, by) * (1 - fx) + hash(bx, by) * fx) * fy;
  };
}

function fbm(noise: (x: number, y: number, p: number) => number, x: number, y: number, period: number, octaves: number): number {
  let sum = 0, amp = 1, total = 0, f = 1;
  for (let i = 0; i < octaves; i++) { sum += amp * noise(x * f, y * f, period * f); total += amp; amp *= 0.5; f *= 2; }
  return sum / total;
}

function cellHash(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
}

const grey = (o: Texel, t: number): void => { o.r = t; o.g = t; o.b = t; };

/** Running bond: `rows` courses, `across` units per course in one tile. */
function bond(u: number, v: number, size: number, across: number, rows: number): { col: number; row: number; edge: number } {
  const h = size / rows, w = size / across;
  const row = Math.floor(v / h);
  const shifted = u + (row % 2 === 1 ? w / 2 : 0);
  const col = Math.floor(shifted / w) % across;
  const fu = shifted - Math.floor(shifted / w) * w, fv = v - row * h;
  return { col, row, edge: Math.min(fu, w - fu, fv, h - fv) };
}

const S = FINISH_SIZE;

function looks(): FinishLook[] {
  const L: FinishLook[] = [];
  {
    const coarse = makeNoise(0x71a3), fine = makeNoise(0x2c5d);
    // reboco liso: nuvem lenta, grão fino
    L[FIN.Plaster] = { worldSize: 4, relief: 0.45, normalScale: 0.25, shade: (x, y, o) => {
      const n = fbm(coarse, x / S * 6, y / S * 6, 6, 4), f = fine(x / S * 96, y / S * 96, 96);
      grey(o, 0.91 + (n - 0.5) * 0.08 + (f - 0.5) * 0.02); o.h = f * 0.3 + n * 0.7; o.rough = 0.93;
    } };
  }
  {
    const grain = makeNoise(0x31c4);
    // pastilha: 10 × 10 cm (modernista brasileiro), rejunte claro
    L[FIN.Ceramic] = { worldSize: 1, relief: 0.9, normalScale: 0.35, shade: (x, y, o) => {
      const t = S / 10, col = Math.floor(x / t), row = Math.floor(y / t);
      const edge = Math.min(x % t, t - x % t, y % t, t - y % t);
      const g = grain(x / S * 80, y / S * 80, 80);
      if (edge < 1.4) { grey(o, 1.0); o.h = 0.1; o.rough = 0.8; return; }
      grey(o, 0.84 + cellHash(col, row, 0x8c) * 0.09 + (g - 0.5) * 0.015); o.h = 0.64; o.rough = 0.3;
    } };
  }
  {
    const grain = makeNoise(0x6b11);
    // tijolo à vista: 16 fiadas de 7,5 cm, 5 tijolos por fiada em 1,2 m
    L[FIN.Brick] = { worldSize: 1.2, relief: 3.2, normalScale: 0.6, shade: (x, y, o) => {
      const { col, row, edge } = bond(x, y, S, 5, 16);
      const g = grain(x / S * 128, y / S * 128, 128);
      if (edge < 1.3) { o.r = 0.95 + g * 0.05; o.g = 0.98 + g * 0.05; o.b = 1.02 + g * 0.05; o.h = 0.1; o.rough = 0.97; return; }
      const tone = 0.72 + cellHash(col, row, 0x3b) * 0.24 + (g - 0.5) * 0.08;
      o.r = tone; o.g = tone * 0.97; o.b = tone * 0.94; o.h = 0.75 + g * 0.2 + Math.min(1, edge / 4) * 0.05; o.rough = 0.86;
    } };
  }
  {
    const grain = makeNoise(0x5d07), mottle = makeNoise(0x0e93);
    // pedra aparelhada: 4 fiadas de 40 cm, 3 blocos por fiada em 1,6 m
    L[FIN.Stone] = { worldSize: 1.6, relief: 1.4, normalScale: 0.4, shade: (x, y, o) => {
      const { col, row, edge } = bond(x, y, S, 3, 4);
      const g = fbm(grain, x / S * 48, y / S * 48, 48, 3), mo = fbm(mottle, x / S * 8, y / S * 8, 8, 3);
      if (edge < 1.5) { grey(o, 0.62 + g * 0.06); o.h = 0; o.rough = 0.95; return; }
      grey(o, 0.72 + cellHash(col, row, 0x51) * 0.2 + (mo - 0.5) * 0.14 + (g - 0.5) * 0.06); o.h = 0.7 + g * 0.15; o.rough = 0.9;
    } };
  }
  {
    const n1 = makeNoise(0x44c1), n2 = makeNoise(0x1b7e);
    // concreto: nuvem, poros, junta de forma a cada 1,2 m (4,8 m de ladrilho)
    L[FIN.Concrete] = { worldSize: 4.8, relief: 1.6, normalScale: 0.3, shade: (x, y, o) => {
      const n = fbm(n1, x / S * 6, y / S * 6, 6, 4), f = n2(x / S * 120, y / S * 120, 120);
      const pore = f > 0.82 ? -0.06 : 0;
      const joint = Math.min(y % (S / 4), S / 4 - y % (S / 4)) < 0.8 ? -0.07 : 0;
      grey(o, 0.8 + (n - 0.5) * 0.1 + (f - 0.5) * 0.03 + pore + joint); o.h = joint ? 0.2 : 0.6 + f * 0.1; o.rough = 0.9;
    } };
  }
  {
    const grain = makeNoise(0x2fa9);
    // madeira: 16 tábuas de 15 cm em pé
    L[FIN.Wood] = { worldSize: 2.4, relief: 2.4, normalScale: 0.45, shade: (x, y, o) => {
      const board = S / 16, col = Math.floor(x / board), fu = x - col * board;
      if (Math.min(fu, board - fu) < 0.9) { grey(o, 0.4); o.h = 0; o.rough = 0.95; return; }
      const g = fbm(grain, x / S * 64 + col * 3.7, y / S * 6, 6, 4);
      const streak = 0.5 + 0.5 * Math.sin((g * 18 + fu * 0.3) * Math.PI);
      const tone = 0.72 + cellHash(col, 0, 0x7c) * 0.16 + (streak - 0.5) * 0.12;
      o.r = tone; o.g = tone * 0.97; o.b = tone * 0.93; o.h = 0.7 + streak * 0.15; o.rough = 0.78;
    } };
  }
  {
    const n = makeNoise(0x6e2b);
    // telha metálica ondulada: 8 ondas por 1,6 m, em pé
    L[FIN.Metal] = { worldSize: 1.6, relief: 5, normalScale: 0.7, shade: (x, y, o) => {
      const rib = 0.5 + 0.5 * Math.sin(x / S * 8 * Math.PI * 2);
      const w = n(x / S * 20, y / S * 20, 20);
      grey(o, 0.82 + (rib - 0.5) * 0.14 + (w - 0.5) * 0.06); o.h = rib; o.rough = 0.42 + w * 0.1; o.metal = 0.55;
    } };
  }
  {
    const n = makeNoise(0x39d4);
    // vidro de pele: painéis de 1,5 m entre montantes de alumínio
    L[FIN.Glass] = { worldSize: 3, relief: 2, normalScale: 0.2, shade: (x, y, o) => {
      const pane = S / 2, fu = x % pane, fv = y % pane;
      if (Math.min(fu, pane - fu, fv, pane - fv) < 3) { grey(o, 0.85); o.h = 1; o.rough = 0.4; o.metal = 1; return; }
      grey(o, 0.3 + cellHash(Math.floor(x / pane), Math.floor(y / pane), 0x12) * 0.08 + (n(x / S * 6, y / S * 6, 6) - 0.5) * 0.04);
      o.h = 0.4; o.rough = 0.07;
    } };
  }
  {
    const grain = makeNoise(0x0bb5);
    // telha capa e canal: 8 fiadas de 25 cm, 10 telhas por fiada em 2 m
    L[FIN.Tile] = { worldSize: 2, relief: 5.5, normalScale: 0.75, shade: (x, y, o) => {
      const course = S / 8, row = Math.floor(y / course), fv = (y - row * course) / course;
      const w = S / 10, shifted = x + (row % 2 === 1 ? w / 2 : 0), col = Math.floor(shifted / w) % 10;
      const fu = (shifted % w) / w, barrel = Math.sin(fu * Math.PI);
      const lap = fv < 0.14 ? 0.55 + fv * 2.5 : 1;
      const g = grain(x / S * 64, y / S * 64, 64);
      grey(o, (0.66 + barrel * 0.2 + cellHash(col, row, 0x2e) * 0.14 + (g - 0.5) * 0.05) * lap); o.h = barrel * 0.8 + fv * 0.2; o.rough = 0.8;
    } };
  }
  {
    const granules = makeNoise(0x4e1f), blotch = makeNoise(0x0a77);
    // manta asfáltica em folhas de 1 m
    L[FIN.Roofing] = { worldSize: 4, relief: 0.6, normalScale: 0.35, shade: (x, y, o) => {
      const sheet = S / 4, fv = y % sheet;
      const seam = fv < 2.2 ? 0.95 + fv * 0.02 : 1;
      const g = granules(x / S * 128, y / S * 128, 128), b = fbm(blotch, x / S * 3, y / S * 3, 3, 3);
      grey(o, (0.8 + (g - 0.5) * 0.04 + (b - 0.5) * 0.12) * seam); o.h = fv < 2.2 ? 0.58 : 0.5 + g * 0.04; o.rough = 0.93;
    } };
  }
  {
    const grain = makeNoise(0x5c31), sweep = makeNoise(0x77a9);
    // estuque/chapisco: grão grosso e o arco da desempenadeira
    L[FIN.Stucco] = { worldSize: 3, relief: 0.8, normalScale: 0.35, shade: (x, y, o) => {
      const g = fbm(grain, x / S * 64, y / S * 64, 64, 2), s = fbm(sweep, x / S * 3 + y / S * 0.6, y / S * 3, 3, 2);
      grey(o, 0.9 + (g - 0.5) * 0.14 + (s - 0.5) * 0.08); o.h = g * 0.75 + s * 0.25; o.rough = 0.92;
    } };
  }
  {
    const grain = makeNoise(0x1d4b);
    // painel de ACM: placas largas de duas fiadas, junta aberta
    L[FIN.Panel] = { worldSize: 2.4, relief: 1.2, normalScale: 0.35, shade: (x, y, o) => {
      const w = S / 2, h = S / 4, col = Math.floor(x / w), row = Math.floor(y / h);
      const fu = x - col * w, fv = y - row * h, joint = Math.min(fu, w - fu, fv, h - fv);
      const seam = joint < 1.6 ? 0.62 + joint * 0.12 : 1;
      const g = grain(x / S * 96, y / S * 96, 96);
      grey(o, (0.9 + cellHash(col, row, 0x9e) * 0.1 + (g - 0.5) * 0.02) * seam); o.h = joint < 1.6 ? 0.7 : 0.55; o.rough = 0.5; o.metal = 0.15;
    } };
  }
  {
    const grain = makeNoise(0x3f88);
    // ardósia: 8 fiadas sobrepostas, cada placa no seu cinza
    L[FIN.Slate] = { worldSize: 2, relief: 3.5, normalScale: 0.6, shade: (x, y, o) => {
      const course = S / 8, row = Math.floor(y / course), fv = (y - row * course) / course;
      const w = S / 6, shifted = x + (row % 2 === 1 ? w / 2 : 0), col = Math.floor(shifted / w) % 6;
      const lap = fv < 0.16 ? 0.5 + fv * 2.2 : 1;
      const g = grain(x / S * 80, y / S * 80, 80);
      grey(o, (0.42 + cellHash(col, row, 0x5a) * 0.22 + (g - 0.5) * 0.05) * lap); o.h = (1 - fv) * 0.5 + 0.3; o.rough = 0.82;
    } };
  }
  return L;
}

export const FINISH_LOOKS: FinishLook[] = looks();

/** Finish for each building material (BMAT) when the vertex says Auto. 0 = no texture. */
export const FINISH_BY_MAT = [FIN.Plaster, FIN.Roofing, FIN.Tile, 0, FIN.Plaster, FIN.Metal, FIN.Concrete, 0, FIN.Plaster, FIN.Plaster, 0, 0, 0, 0, 0, 0];

/** Finish names for the creator (index = id − 1). */
export const FINISH_KEYS = ['plaster', 'ceramic', 'brick', 'stone', 'concrete', 'wood', 'metal', 'glass', 'tile', 'roofing', 'stucco', 'panel', 'slate'] as const;

const byte = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);

/**
 * Bakes every finish: `albedo` = rgb tone (mean luminance → 0.5, so ×2 in the shader keeps the vertex colour as the
 * average) + roughness; `normal` = tangent-space normal (rgb, z up) + metalness. Layer k = finish id k + 1.
 */
export function bakeFinishes(): { albedo: Uint8Array; normal: Uint8Array } {
  const n = S * S;
  const albedo = new Uint8Array(n * 4 * FINISH_COUNT), normal = new Uint8Array(n * 4 * FINISH_COUNT);
  const rgb = new Float32Array(n * 3), h = new Float32Array(n), rough = new Float32Array(n), metal = new Float32Array(n);
  const o: Texel = { r: 0, g: 0, b: 0, h: 0, rough: 0.9, metal: 0 };
  for (let id = 1; id <= FINISH_COUNT; id++) {
    const look = FINISH_LOOKS[id];
    let lum = 0;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      o.metal = 0;
      look.shade(x, y, o);
      const i = y * S + x;
      rgb[i * 3] = o.r; rgb[i * 3 + 1] = o.g; rgb[i * 3 + 2] = o.b;
      h[i] = o.h; rough[i] = o.rough; metal[i] = o.metal;
      lum += 0.2126 * o.r + 0.7152 * o.g + 0.0722 * o.b;
    }
    const k = 0.5 / Math.max(1e-3, lum / n);
    const base = (id - 1) * n * 4;
    for (let y = 0; y < S; y++) {
      const up = ((y + 1) % S) * S, dn = ((y + S - 1) % S) * S, row = y * S;
      for (let x = 0; x < S; x++) {
        const i = row + x, p = base + i * 4;
        albedo[p] = byte(rgb[i * 3] * k); albedo[p + 1] = byte(rgb[i * 3 + 1] * k); albedo[p + 2] = byte(rgb[i * 3 + 2] * k);
        albedo[p + 3] = byte(rough[i]);
        const dx = (h[row + (x + 1) % S] - h[row + (x + S - 1) % S]) * look.relief;
        const dy = (h[up + x] - h[dn + x]) * look.relief;
        const l = Math.sqrt(dx * dx + dy * dy + 1);
        normal[p] = byte(-dx / l * 0.5 + 0.5); normal[p + 1] = byte(-dy / l * 0.5 + 0.5); normal[p + 2] = byte(1 / l * 0.5 + 0.5);
        normal[p + 3] = byte(metal[i]);
      }
    }
  }
  return { albedo, normal };
}

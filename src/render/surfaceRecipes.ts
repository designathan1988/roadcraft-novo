// The procedural surface recipes (asphalt, grass, water normals, terrain noise): pure functions over typed arrays,
// run by render/surfaceBakeWorker.ts off the main thread. Each returns its RGBA8 texels; render/surfaceBake.ts owns
// the textures they fill.

/** Seed of a value noise (the hash's per-seed term). */
const seedOf = (seed: number): number => Math.imul(seed, 2_246_822_519);

function latticeHash(x: number, y: number, seedHash: number): number {
  let h = Math.imul(x | 0, 374_761_393) ^ Math.imul(y | 0, 668_265_263) ^ seedHash;
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
}

/** 2D value noise with an integer period (tiles seamlessly). */
function noise(seedHash: number, x: number, y: number, period: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const tx = x - x0, ty = y - y0;
  const fx = tx * tx * (3 - 2 * tx), fy = ty * ty * (3 - 2 * ty);
  const rx = x0 % period, ry = y0 % period;
  const ax = rx < 0 ? rx + period : rx, ay = ry < 0 ? ry + period : ry;
  const bx = ax + 1 === period ? 0 : ax + 1, by = ay + 1 === period ? 0 : ay + 1;
  return (latticeHash(ax, ay, seedHash) * (1 - fx) + latticeHash(bx, ay, seedHash) * fx) * (1 - fy)
    + (latticeHash(ax, by, seedHash) * (1 - fx) + latticeHash(bx, by, seedHash) * fx) * fy;
}

function fbm(seedHash: number, x: number, y: number, period: number, octaves: number): number {
  let sum = 0, amp = 1, total = 0, f = 1;
  for (let i = 0; i < octaves; i++) { sum += amp * noise(seedHash, x * f, y * f, period * f); total += amp; amp *= 0.5; f *= 2; }
  return sum / total;
}

function cellHash(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
}

export const ASPHALT_SIZE = 512, GRASS_SIZE = 512, WATER_SIZE = 256, NOISE_SIZE = 256;

/** Asphalt: R = relative tone (0.5 = the road colour), G = wear sheen (polished track). 512² over 10.4 m. */
export function bakeAsphalt(): Uint8Array {
  const size = ASPHALT_SIZE, base = 0.215, data = new Uint8Array(size * size * 4);
  const grain = seedOf(0x51ed), macro = seedOf(0x9a17), patch = seedOf(0x2b64), oil = seedOf(0x6d05);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    // low-contrast aggregate (what shows up close), wear and broad repairs
    const chips = fbm(grain, u * 128, v * 128, 128, 2);
    const wear = fbm(macro, u * 6, v * 6, 6, 3);
    const repair = fbm(patch, u * 3 + 11, v * 3 + 7, 3, 2);
    const stain = fbm(oil, u * 14, v * 3, 14, 2);
    const drip = stain > 0.66 ? (stain - 0.66) * 0.12 : 0;
    // light pebbles in the dark binder
    const stone = noise(grain, u * 420 + 3, v * 420 + 9, 420);
    const flecks = stone > 0.74 ? (stone - 0.74) * 0.5 : stone < 0.2 ? -0.02 : 0;
    // patch: rectangle of newer (darker) asphalt where a trench was dug
    const pu = Math.floor(u * 5), pv = Math.floor(v * 3);
    const patchy = cellHash(pu, pv, 0x91c) > 0.82 && u * 5 - pu > 0.15 && u * 5 - pu < 0.75 && v * 3 - pv > 0.2 && v * 3 - pv < 0.6;
    const tone = base + (chips - 0.5) * 0.055 + flecks + (wear - 0.5) * 0.04 + (repair > 0.74 ? 0.022 : 0) - (patchy ? 0.03 : 0) - drip;
    const o = (y * size + x) * 4;
    data[o] = Math.round(Math.min(1, Math.max(0, tone / base * 0.5)) * 255);
    data[o + 1] = Math.round(Math.min(1, chips) * 255);
    data[o + 2] = 0; data[o + 3] = 255;
  }
  return data;
}

/**
 * Grass: tufts with a warped domain (no noise squares), dry patches, soil in the gaps and the grain of the blades.
 * RGB = relative colour per channel (0.5 = the biome colour), 512² over 19.2 m.
 */
export function bakeGrass(): Uint8Array {
  const size = GRASS_SIZE, data = new Uint8Array(size * size * 4);
  const fine = seedOf(0x1234), clumpN = seedOf(0x9f2c);
  // tones: dark and lit tufts, dry grass, soil; `mean` is the biome colour the texture is relative to
  const dR = 0.27, dG = 0.34, dB = 0.19, lR = 0.33, lG = 0.4, lB = 0.21;
  const yR = 0.41, yG = 0.4, yB = 0.28, sR = 0.36, sG = 0.3, sB = 0.2;
  const mR = 0.3, mG = 0.37, mB = 0.2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    const wx = (noise(clumpN, u * 12 + 11, v * 12, 12) - 0.5) * 0.9;
    const wy = (noise(clumpN, u * 12, v * 12 + 29, 12) - 0.5) * 0.9;
    const speck = fbm(fine, u * 48 + wx * 2, v * 48 + wy * 2, 48, 2);
    const tuft = fbm(fine, u * 16 + wx + 3.1, v * 16 + wy + 7.7, 16, 2);
    const clump = fbm(clumpN, u * 5 + wx * 0.5, v * 5 + wy * 0.5, 5, 2);
    const t = Math.min(1, Math.max(0, (tuft - 0.3) / 0.42));
    const k = t * t * (3 - 2 * t);
    let r = dR + (lR - dR) * k, g = dG + (lG - dG) * k, b = dB + (lB - dB) * k;
    const dryW = Math.min(1, Math.max(0, (clump - 0.6) / 0.12)) * k * 0.2;
    const soilW = Math.min(1, Math.max(0, (speck - 0.7) / 0.08)) * (1 - k) * 0.45;
    r += (yR - r) * dryW; r += (sR - r) * soilW;
    g += (yG - g) * dryW; g += (sG - g) * soilW;
    b += (yB - b) * dryW; b += (sB - b) * soilW;
    const tuftlet = fbm(fine, u * 192 + 1.7, v * 192 + 5.3, 192, 2);
    const blade = noise(clumpN, u * 384 + 9.1, v * 384 + 2.9, 384);
    const gap = blade < 0.3 ? 0.72 : 1, tip = blade > 0.78 ? 1.16 : 1;
    const grain = (0.84 + tuftlet * 0.3) * gap * tip * (0.96 + speck * 0.08);
    const o = (y * size + x) * 4;
    data[o] = Math.round(Math.min(1, r * grain * (tip > 1 ? 1.05 : 1) / mR * 0.5) * 255);
    data[o + 1] = Math.round(Math.min(1, g * grain / mG * 0.5) * 255);
    data[o + 2] = Math.round(Math.min(1, b * grain * (gap < 1 ? 1.08 : 1) / mB * 0.5) * 255);
    data[o + 3] = 255;
  }
  return data;
}

/**
 * Water normals: height = ridged crests (period 24, 3 octaves) × 0.62 + a long swell (period 6) × 0.38, normals by
 * central differences (relief 0.014 × size); alpha holds a foam noise (period 9) for the shore lace, the whitecaps
 * and the churn. One 256² tile, sampled at three scales.
 */
export function bakeWaterNormals(): Uint8Array {
  const N = WATER_SIZE, data = new Uint8Array(N * N * 4), h = new Float32Array(N * N);
  const crestN = seedOf(91), longN = seedOf(37), foamN = seedOf(53);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const crest = 1 - Math.abs(fbm(crestN, x * 24 / N, y * 24 / N, 24, 3) - 0.5) * 2;
    const long = fbm(longN, x * 6 / N, y * 6 / N, 6, 3);
    h[y * N + x] = crest * 0.62 + long * 0.38;
  }
  const relief = N * 0.014, last = N - 1;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    // neighbours wrap around the tile; no ½ on the central difference, z stored as 1 / length
    const xl = x === 0 ? last : x - 1, xr = x === last ? 0 : x + 1;
    const yd = y === 0 ? last : y - 1, yu = y === last ? 0 : y + 1;
    const dx = (h[y * N + xr] - h[y * N + xl]) * relief, dy = (h[yu * N + x] - h[yd * N + x]) * relief;
    const l = Math.hypot(dx, dy, 1), o = (y * N + x) * 4;
    data[o] = Math.round((-dx / l * 0.5 + 0.5) * 255);
    data[o + 1] = Math.round((-dy / l * 0.5 + 0.5) * 255);
    data[o + 2] = Math.round((1 / l) * 255);
    data[o + 3] = Math.round(fbm(foamN, x * 9 / N, y * 9 / N, 9, 3) * 255);
  }
  return data;
}

/** Tileable noise for the terrain's blend wander: r, g, b, a = value noise of periods 4, 8, 16 and 32 over 256². */
export function bakeTerrainNoise(): Uint8Array {
  const N = NOISE_SIZE, data = new Uint8Array(N * N * 4);
  const s0 = seedOf(201), s1 = seedOf(203), s2 = seedOf(207), s3 = seedOf(211);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const o = (y * N + x) * 4;
    data[o] = Math.round(fbm(s0, x * 4 / N, y * 4 / N, 4, 2) * 255);
    data[o + 1] = Math.round(fbm(s1, x * 8 / N, y * 8 / N, 8, 2) * 255);
    data[o + 2] = Math.round(fbm(s2, x * 16 / N, y * 16 / N, 16, 2) * 255);
    data[o + 3] = Math.round(fbm(s3, x * 32 / N, y * 32 / N, 32, 2) * 255);
  }
  return data;
}

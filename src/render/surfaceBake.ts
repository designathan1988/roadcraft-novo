// Paving textures baked once at load (roadcraft recipes, `render/materials.ts`): asphalt with aggregate chips,
// wear, patches and oil stains; sidewalk of concrete pavers in running bond with chamfer and dirt in the
// joints. Each one tiles seamlessly and the shader reads it once per pixel (it fades in the far mipmap).

import * as THREE from 'three/webgpu';

/** 2D value noise with an integer period (tiles seamlessly). */
function makeNoise(seed: number): (x: number, y: number, period: number) => number {
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

function texture(data: Uint8Array, size: number): THREE.DataTexture {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/** Side of the asphalt tile (m). */
export const ASPHALT_TILE = 10.4;

/**
 * Asphalt: R = relative tone (0.5 = the road colour), G = wear sheen (polished track). 512² over 10.4 m.
 */
function asphalt(): THREE.DataTexture {
  const size = 512, base = 0.215, data = new Uint8Array(size * size * 4);
  const grain = makeNoise(0x51ed), macro = makeNoise(0x9a17), patch = makeNoise(0x2b64), oil = makeNoise(0x6d05);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    // low-contrast aggregate (what shows up close), wear and broad repairs
    const chips = fbm(grain, u * 128, v * 128, 128, 2);
    const wear = fbm(macro, u * 6, v * 6, 6, 3);
    const repair = fbm(patch, u * 3 + 11, v * 3 + 7, 3, 2);
    const stain = fbm(oil, u * 14, v * 3, 14, 2);
    const drip = stain > 0.66 ? (stain - 0.66) * 0.12 : 0;
    // light pebbles in the dark binder
    const stone = grain(u * 420 + 3, v * 420 + 9, 420);
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
  return texture(data, size);
}

/**
 * Sidewalk: grey concrete pavers in running bond (22 × 11 cm), chamfer, dirt and moss in the joints.
 * R = relative tone (0.5 = the sidewalk colour), G = paver face (0 at the joint, 1 in the middle).
 */
export const GRASS_TILE = 19.2;

/**
 * Grass (roadcraft `terrain.ts`, `terrainBakes`): tufts with a warped domain (no noise squares), dry
 * patches, soil in the gaps and the grain of the blades. RGB = relative colour per channel (0.5 = the biome colour), 512² over 19.2 m.
 */
function grass(): THREE.DataTexture {
  const size = 512, data = new Uint8Array(size * size * 4);
  const fine = makeNoise(0x1234), clumpN = makeNoise(0x9f2c);
  const dark = [0.27, 0.34, 0.19], lit = [0.33, 0.4, 0.21], dry = [0.41, 0.4, 0.28], soil = [0.36, 0.3, 0.2];
  const mean = [0.3, 0.37, 0.2];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    const wx = (clumpN(u * 12 + 11, v * 12, 12) - 0.5) * 0.9;
    const wy = (clumpN(u * 12, v * 12 + 29, 12) - 0.5) * 0.9;
    const speck = fbm(fine, u * 48 + wx * 2, v * 48 + wy * 2, 48, 2);
    const tuft = fbm(fine, u * 16 + wx + 3.1, v * 16 + wy + 7.7, 16, 2);
    const clump = fbm(clumpN, u * 5 + wx * 0.5, v * 5 + wy * 0.5, 5, 2);
    const t = Math.min(1, Math.max(0, (tuft - 0.3) / 0.42));
    const k = t * t * (3 - 2 * t);
    const c = [0, 1, 2].map((i) => dark[i] + (lit[i] - dark[i]) * k);
    const dryW = Math.min(1, Math.max(0, (clump - 0.6) / 0.12)) * k * 0.2;
    const soilW = Math.min(1, Math.max(0, (speck - 0.7) / 0.08)) * (1 - k) * 0.45;
    for (let i = 0; i < 3; i++) { c[i] += (dry[i] - c[i]) * dryW; c[i] += (soil[i] - c[i]) * soilW; }
    const tuftlet = fbm(fine, u * 192 + 1.7, v * 192 + 5.3, 192, 2);
    const blade = clumpN(u * 384 + 9.1, v * 384 + 2.9, 384);
    const gap = blade < 0.3 ? 0.72 : 1, tip = blade > 0.78 ? 1.16 : 1;
    const grain = (0.84 + tuftlet * 0.3) * gap * tip * (0.96 + speck * 0.08);
    const o = (y * size + x) * 4;
    data[o] = Math.round(Math.min(1, c[0] * grain * (tip > 1 ? 1.05 : 1) / mean[0] * 0.5) * 255);
    data[o + 1] = Math.round(Math.min(1, c[1] * grain / mean[1] * 0.5) * 255);
    data[o + 2] = Math.round(Math.min(1, c[2] * grain * (gap < 1 ? 1.08 : 1) / mean[2] * 0.5) * 255);
    data[o + 3] = 255;
  }
  return texture(data, size);
}

export const GRASS_TEX = grass();
export const ASPHALT_TEX = asphalt();

/**
 * Water normals as Roadcraft 4.0's (`render/water.ts` waterNormalTexels): height = ridged crests (period 24, 3
 * octaves) × 0.62 + a long swell (period 6) × 0.38, normals by central differences (relief 0.014 × size); alpha holds a
 * foam noise (period 9) for the shore lace, the whitecaps and the churn. One 256² tile, sampled at three scales.
 */
function waterNormals(): THREE.DataTexture {
  const N = 256, data = new Uint8Array(N * N * 4), h = new Float32Array(N * N);
  const crestN = makeNoise(91), longN = makeNoise(37), foamN = makeNoise(53);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const crest = 1 - Math.abs(fbm(crestN, x * 24 / N, y * 24 / N, 24, 3) - 0.5) * 2;
    const long = fbm(longN, x * 6 / N, y * 6 / N, 6, 3);
    h[y * N + x] = crest * 0.62 + long * 0.38;
  }
  const relief = N * 0.014;
  const at = (x: number, y: number) => h[((y + N) % N) * N + ((x + N) % N)];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    // exactly as 4.0's water.ts:105-111 (no ½ on the central difference; z stored as 1 / length)
    const dx = (at(x + 1, y) - at(x - 1, y)) * relief, dy = (at(x, y + 1) - at(x, y - 1)) * relief;
    const l = Math.hypot(dx, dy, 1), o = (y * N + x) * 4;
    data[o] = Math.round((-dx / l * 0.5 + 0.5) * 255);
    data[o + 1] = Math.round((-dy / l * 0.5 + 0.5) * 255);
    data[o + 2] = Math.round((1 / l) * 255);
    data[o + 3] = Math.round(fbm(foamN, x * 9 / N, y * 9 / N, 9, 3) * 255);
  }
  return texture(data, N);
}
export const WATER_TEX = waterNormals();

/** Side of the rock texture's tile (m): Roadcraft 4.0's ROCK_WORLD. */
export const ROCK_TILE = 23.2;

/**
 * Rock face as Roadcraft 4.0's granite recipe (`bake/terrainRecipes.ts`): grey (0.46, 0.455, 0.44) broken by broad
 * mottling, vertical streaks, dark joints and lichen patches; the normal from the same height (relief 2.2). Two 512²
 * maps: albedo (rgb) + roughness (a), normal (rgb).
 */

/**
 * Tileable noise for the terrain's blend wander (Roadcraft 4.0 reads its dirt texture's channels at four scales):
 * r, g, b, a = value noise of periods 4, 8, 16 and 32 over one 256² tile.
 */
function terrainNoise(): THREE.DataTexture {
  const N = 256, data = new Uint8Array(N * N * 4), ns = [makeNoise(201), makeNoise(203), makeNoise(207), makeNoise(211)];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const o = (y * N + x) * 4;
    [4, 8, 16, 32].forEach((p, k) => { data[o + k] = Math.round(fbm(ns[k], x * p / N, y * p / N, p, 2) * 255); });
  }
  return texture(data, N);
}
export const TERRAIN_NOISE = terrainNoise();

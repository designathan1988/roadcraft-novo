// Texturas de piso assadas uma vez na carga (receitas do roadcraft, `render/materials.ts`): asfalto com brita,
// desgaste, remendos e manchas de óleo; calçada de bloquete de concreto em fiada corrida com chanfro e sujeira
// nas juntas. Cada uma repete sem emenda e o shader lê uma vez por pixel (some no mipmap de longe).

import * as THREE from 'three/webgpu';

/** Ruído de valor 2D com período inteiro (repete sem emenda). */
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

/** Lado do ladrilho do asfalto (m). */
export const ASPHALT_TILE = 10.4;
/** Lado do ladrilho da calçada (m): 32 fiadas de bloquete de 11 cm. */
export const FOOTWAY_TILE = 3.52;

/**
 * Asfalto: R = tom relativo (0,5 = a cor da via), G = brilho do desgaste (trilha polida). 512² em 10,4 m.
 */
function asphalt(): THREE.DataTexture {
  const size = 512, base = 0.215, data = new Uint8Array(size * size * 4);
  const grain = makeNoise(0x51ed), macro = makeNoise(0x9a17), patch = makeNoise(0x2b64), oil = makeNoise(0x6d05);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    // brita em contraste baixo (é o que aparece de perto), desgaste e reparos largos
    const chips = fbm(grain, u * 128, v * 128, 128, 2);
    const wear = fbm(macro, u * 6, v * 6, 6, 3);
    const repair = fbm(patch, u * 3 + 11, v * 3 + 7, 3, 2);
    const stain = fbm(oil, u * 14, v * 3, 14, 2);
    const drip = stain > 0.66 ? (stain - 0.66) * 0.12 : 0;
    // pedrinhas claras no ligante escuro
    const stone = grain(u * 420 + 3, v * 420 + 9, 420);
    const flecks = stone > 0.74 ? (stone - 0.74) * 0.5 : stone < 0.2 ? -0.02 : 0;
    // remendo: retângulo de asfalto mais novo (mais escuro) onde abriram vala
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
 * Calçada: bloquete de concreto cinza em fiada corrida (22 × 11 cm), chanfro, sujeira e musgo nas juntas.
 * R = tom relativo (0,5 = a cor da calçada), G = face da peça (0 na junta, 1 no meio).
 */
function footway(): THREE.DataTexture {
  const size = 512, PAVER = 16, bevel = 2, data = new Uint8Array(size * size * 4);
  const grain = makeNoise(0x77c1), stain = makeNoise(0x1d3f), blot = makeNoise(0x5e2d);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size, w = PAVER;
    const row = Math.floor(y / w);
    const sx = (x + (row % 2 === 0 ? 0 : w)) % size;
    const col = Math.floor(sx / (2 * w));
    const ex = Math.min(sx % (2 * w), 2 * w - (sx % (2 * w)));
    const ey = Math.min(y % w, w - (y % w));
    const face = Math.min(1, Math.max(0, (Math.min(ex, ey) - 1.1) / bevel));
    const chamfer = face * face * (3 - 2 * face);
    const blockTone = (cellHash(col, row, 0x5a1b) - 0.5) * 0.1;
    const speck = fbm(grain, u * 128, v * 128, 128, 2);
    const dirt = fbm(stain, u * 3, v * 3, 3, 3);
    const spot = fbm(blot, u * 15, v * 15, 15, 2);
    const mark = spot > 0.7 ? (spot - 0.7) * 1.2 : 0;
    const tone = 0.54 + blockTone + (speck - 0.5) * 0.08 - (dirt - 0.5) * 0.14 - mark * 0.22;
    const lum = tone * chamfer + 0.28 * (1 - chamfer);
    const o = (y * size + x) * 4;
    data[o] = Math.round(Math.min(1, Math.max(0, lum / 0.54 * 0.5)) * 255);
    data[o + 1] = Math.round(chamfer * 255);
    data[o + 2] = 0; data[o + 3] = 255;
  }
  return texture(data, size);
}

/** Lado do ladrilho da grama (m). */
export const GRASS_TILE = 19.2;

/**
 * Grama (roadcraft `terrain.ts`, `terrainBakes`): tufos com o domínio torcido (sem quadrados de ruído), manchas
 * secas, terra nas falhas e o grão das folhas. RGB = cor relativa por canal (0,5 = a cor do bioma), 512² em 19,2 m.
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
export const FOOTWAY_TEX = footway();

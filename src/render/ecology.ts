// The ecology field of a tile, after Roadcraft 4.0's `world/ecology.ts`: from the ground's heights and the water, per
// 8 m sample, how dry the grass is, how wet the ground is and how bare (R, G, B). Pure: it runs in the ecology worker,
// one tile at a time, reading the map's shared height and water buffers (with a border from the neighbour tiles).

import { HEIGHT_SPACING, HEIGHT_TILE_RES, MAP_TILES } from '../config.ts';
import { NO_WATER, WATER_SPACING, WATER_TILE_RES } from '../world/ground.ts';

/** Samples per tile side (8 m: the water grid's spacing). */
export const ECO_RES = WATER_TILE_RES;
/** Border read round the tile (samples): the water distance and the valley/ridge reach past its edge. */
const BORDER = 16;
/** Radius of the box mean that tells a valley from a ridge (samples: 48 m). */
const MEAN_R = 6;

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Tileable-free value noise (for the patchiness: 92 m and 22 m in 4.0). */
function noise(x: number, z: number, period: number): number {
  const fx = x / period, fz = z / period, ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
  const h = (i: number, j: number) => { let v = Math.imul(i, 374_761_393) ^ Math.imul(j, 668_265_263); v = Math.imul(v ^ (v >>> 13), 1_274_126_177); return ((v ^ (v >>> 16)) >>> 0) / 4_294_967_296; };
  const sx = tx * tx * (3 - 2 * tx), sz = tz * tz * (3 - 2 * tz);
  return (h(ix, iz) * (1 - sx) + h(ix + 1, iz) * sx) * (1 - sz) + (h(ix, iz + 1) * (1 - sx) + h(ix + 1, iz + 1) * sx) * sz;
}

/**
 * Writes tile `tile`'s field into `out` (ECO_RES² × 4 bytes): R dry grass, G wet ground, B bare ground, A 255.
 * - wet: riparian, 1 − smoothstep(10 m, 44 m) of the distance to water (chamfer 3-4), more in valleys;
 * - dry: ridges and patches far from water (4.0: the cerrado's straw on the high ground);
 * - bare: steep ground (40°-56°) away from water.
 */
export function ecologyTile(heights: Float32Array, water: Float32Array, tile: number, out: Uint8Array): void {
  const W = ECO_RES + BORDER * 2, n = W * W;
  const tx = tile % MAP_TILES, tz = Math.floor(tile / MAP_TILES);
  const gx0 = tx * ECO_RES - BORDER, gz0 = tz * ECO_RES - BORDER;
  const HRES = HEIGHT_TILE_RES * MAP_TILES, WRES = WATER_TILE_RES * MAP_TILES;
  const step = WATER_SPACING / HEIGHT_SPACING; // height samples per ecology sample
  const hAt = (gx: number, gz: number) => {
    const hx = Math.min(HRES - 1, Math.max(0, gx * step)), hz = Math.min(HRES - 1, Math.max(0, gz * step));
    const t = Math.floor(hz / HEIGHT_TILE_RES) * MAP_TILES + Math.floor(hx / HEIGHT_TILE_RES);
    return heights[t * HEIGHT_TILE_RES * HEIGHT_TILE_RES + (hz % HEIGHT_TILE_RES) * HEIGHT_TILE_RES + (hx % HEIGHT_TILE_RES)];
  };
  const wAt = (gx: number, gz: number) => {
    const x = Math.min(WRES - 1, Math.max(0, gx)), z = Math.min(WRES - 1, Math.max(0, gz));
    const t = Math.floor(z / WATER_TILE_RES) * MAP_TILES + Math.floor(x / WATER_TILE_RES);
    return water[t * WATER_TILE_RES * WATER_TILE_RES + (z % WATER_TILE_RES) * WATER_TILE_RES + (x % WATER_TILE_RES)];
  };
  const h = new Float32Array(n), dist = new Float32Array(n);
  for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i;
    h[k] = hAt(gx0 + i, gz0 + j);
    dist[k] = wAt(gx0 + i, gz0 + j) > NO_WATER + 1 ? 0 : 1e9;
  }
  // chamfer 3-4 distance to water (two passes), in samples × 3
  for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i;
    let d = dist[k];
    if (i > 0) d = Math.min(d, dist[k - 1] + 3);
    if (j > 0) { d = Math.min(d, dist[k - W] + 3); if (i > 0) d = Math.min(d, dist[k - W - 1] + 4); if (i < W - 1) d = Math.min(d, dist[k - W + 1] + 4); }
    dist[k] = d;
  }
  for (let j = W - 1; j >= 0; j--) for (let i = W - 1; i >= 0; i--) {
    const k = j * W + i;
    let d = dist[k];
    if (i < W - 1) d = Math.min(d, dist[k + 1] + 3);
    if (j < W - 1) { d = Math.min(d, dist[k + W] + 3); if (i < W - 1) d = Math.min(d, dist[k + W + 1] + 4); if (i > 0) d = Math.min(d, dist[k + W - 1] + 4); }
    dist[k] = d;
  }
  // summed-area table of the heights for the box mean
  const sat = new Float64Array((W + 1) * (W + 1));
  for (let j = 0; j < W; j++) { let row = 0; for (let i = 0; i < W; i++) { row += h[j * W + i]; sat[(j + 1) * (W + 1) + i + 1] = sat[j * (W + 1) + i + 1] + row; } }
  const mean = (i: number, j: number) => {
    const i0 = Math.max(0, i - MEAN_R), i1 = Math.min(W - 1, i + MEAN_R), j0 = Math.max(0, j - MEAN_R), j1 = Math.min(W - 1, j + MEAN_R);
    const s = sat[(j1 + 1) * (W + 1) + i1 + 1] - sat[j0 * (W + 1) + i1 + 1] - sat[(j1 + 1) * (W + 1) + i0] + sat[j0 * (W + 1) + i0];
    return s / ((i1 - i0 + 1) * (j1 - j0 + 1));
  };
  for (let j = 0; j < ECO_RES; j++) for (let i = 0; i < ECO_RES; i++) {
    const wi = i + BORDER, wj = j + BORDER, k = wj * W + wi;
    const waterM = dist[k] / 3 * WATER_SPACING;
    const rel = h[k] - mean(wi, wj);
    const valley = smooth(0.8, 8.8, -rel), ridge = smooth(0.8, 8.8, rel);
    const gx = (h[k + 1] - h[k - 1]) / (2 * WATER_SPACING), gz = (h[k + W] - h[k - W]) / (2 * WATER_SPACING);
    const slope = Math.atan(Math.hypot(gx, gz)) * 57.2958;
    const wx = (gx0 + wi) * WATER_SPACING, wz = (gz0 + wj) * WATER_SPACING;
    const patch = noise(wx, wz, 92) * 0.7 + noise(wx, wz, 22) * 0.3;
    const wet = waterM === 0 ? 1 : Math.min(1, (1 - smooth(10, 44, waterM)) + valley * 0.35 * (1 - smooth(40, 120, waterM)));
    const steep = smooth(40, 56, slope);
    const dry = Math.min(1, Math.max(0, 0.15 + ridge * 0.7 + (patch - 0.5) * 0.9 - wet * 0.9 + smooth(15, 35, slope) * 0.2));
    const bare = Math.min(1, steep * (1 - wet) * 0.8 + ridge * smooth(25, 45, slope) * 0.3);
    const o = (j * ECO_RES + i) * 4;
    out[o] = Math.round(dry * 255); out[o + 1] = Math.round(wet * 255); out[o + 2] = Math.round(bare * 255); out[o + 3] = 255;
  }
}

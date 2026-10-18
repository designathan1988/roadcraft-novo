// Assenta o relevo de um ladrilho sob uma lista de trechos retos (worker):
// cada amostra perto de uma via vai para a altura linear do trecho, com uma
// borda suave. Não aterra água nem faz aterro alto (ponte) nem corte fundo.

import { HEIGHT_TILE_RES, MAP_TILES, SEA_LEVEL } from '../config.ts';
import { heightIndex, worldOfSample } from '../world/heights.ts';

/** Por trecho: x0, z0, y0, x1, z1, y1, meia largura. */
export const CONFORM_REC = 7;
const BLEND = 7;
const BUCKET = 32;

export function conformTile(heights: Float32Array, tile: number, segs: Float32Array): { min: number; max: number } {
  const tx = tile % MAP_TILES, tz = (tile / MAP_TILES) | 0;
  const x0 = worldOfSample(tx * HEIGHT_TILE_RES), z0 = worldOfSample(tz * HEIGHT_TILE_RES);
  const size = HEIGHT_TILE_RES * (worldOfSample(1) - worldOfSample(0));
  const nb = Math.ceil(size / BUCKET) + 1;
  const buckets: number[][] = Array.from({ length: nb * nb }, () => []);
  const n = segs.length / CONFORM_REC;
  for (let s = 0; s < n; s++) {
    const o = s * CONFORM_REC;
    const r = segs[o + 6] + BLEND;
    const i0 = Math.max(0, Math.floor((Math.min(segs[o], segs[o + 3]) - r - x0) / BUCKET));
    const i1 = Math.min(nb - 1, Math.floor((Math.max(segs[o], segs[o + 3]) + r - x0) / BUCKET));
    const j0 = Math.max(0, Math.floor((Math.min(segs[o + 1], segs[o + 4]) - r - z0) / BUCKET));
    const j1 = Math.min(nb - 1, Math.floor((Math.max(segs[o + 1], segs[o + 4]) + r - z0) / BUCKET));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) buckets[j * nb + i].push(s);
  }
  let min = Infinity, max = -Infinity;
  for (let sj = 0; sj < HEIGHT_TILE_RES; sj++) {
    const gz = tz * HEIGHT_TILE_RES + sj;
    const z = worldOfSample(gz);
    for (let si = 0; si < HEIGHT_TILE_RES; si++) {
      const gx = tx * HEIGHT_TILE_RES + si;
      const x = worldOfSample(gx);
      const idx = heightIndex(gx, gz);
      const old = heights[idx];
      const list = buckets[Math.floor((z - z0) / BUCKET) * nb + Math.floor((x - x0) / BUCKET)];
      let bestK = 0, target = 0;
      for (const s of list) {
        const o = s * CONFORM_REC;
        const ax = segs[o], az = segs[o + 1], bx = segs[o + 3], bz = segs[o + 4];
        const dx = bx - ax, dz = bz - az;
        const l2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
        const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
        const half = segs[o + 6];
        if (d >= half + BLEND) continue;
        const k = d <= half ? 1 : 1 - smooth((d - half) / BLEND);
        if (k > bestK) { bestK = k; target = segs[o + 2] + (segs[o + 5] - segs[o + 2]) * t; }
      }
      let v = old;
      if (bestK > 0 && old > SEA_LEVEL + 0.3) {
        const want = target - 0.05;
        // aterro alto = ponte; corte fundo = deixa (túnel não é gerado)
        if (want - old < 6 && old - want < 14) {
          v = old + (want - old) * bestK;
          heights[idx] = v;
        }
      }
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return { min, max };
}

function smooth(t: number): number { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); }

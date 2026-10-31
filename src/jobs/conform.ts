// Lays a tile's relief under a list of straight road pieces (worker): each sample near a road goes to the piece's
// linear height, with a soft edge. It neither fills water nor builds a high fill (a bridge) nor a deep cut.

import { HEIGHT_TILE_RES, MAP_TILES, SEA_LEVEL } from '../config.ts';
import { heightIndex, worldOfSample } from '../world/heights.ts';
import { BESIDE_DROP, UNDER_DROP } from '../roads/kerb.ts';
import { smoothstep01 } from '../core/math.ts';

/**
 * Per segment: x0, z0, y0, x1, z1, y1, half width (the outer edge), and the outer strip's rise over the road on its left
 * (u+) and right sides (roads/kerb.ts edgeRise): under the road the ground goes below the surface, beside it level with
 * that strip's top (roadcraft 4.0 world/elevation.ts roadShapeAt); under any road wins over beside another.
 */
export const CONFORM_REC = 9;
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
      // the road it is under (the nearest centre line), else the road it is beside with the most weight
      let underD = Infinity, underY = 0, bestK = 0, besideY = 0, besideSurface = 0;
      for (const s of list) {
        const o = s * CONFORM_REC;
        const ax = segs[o], az = segs[o + 1], bx = segs[o + 3], bz = segs[o + 4];
        const dx = bx - ax, dz = bz - az;
        const l2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
        const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
        const half = segs[o + 6];
        if (d >= half + BLEND) continue;
        const surface = segs[o + 2] + (segs[o + 5] - segs[o + 2]) * t;
        if (d < half) { if (d < underD) { underD = d; underY = surface; } continue; }
        const k = d <= half + 0.5 ? 1 : 1 - smoothstep01((d - half - 0.5) / (BLEND - 0.5));
        if (k > bestK) {
          bestK = k; besideSurface = surface;
          // u+ (the left of a to b) lies along (dz, -dx)
          const left = (x - ax) * dz - (z - az) * dx > 0;
          besideY = surface + segs[o + (left ? 7 : 8)] - BESIDE_DROP;
        }
      }
      const under = underD < Infinity;
      const k = under ? 1 : bestK, surface = under ? underY : besideSurface, want = under ? underY - UNDER_DROP : besideY;
      let v = old;
      if (k > 0 && old > SEA_LEVEL + 0.3) {
        // a high fill is a bridge, a deep cut is left (no tunnel is generated): judged on the road's surface
        if (surface - old < 6 && old - surface < 14) {
          v = old + (want - old) * k;
          heights[idx] = v;
        }
      }
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return { min, max };
}


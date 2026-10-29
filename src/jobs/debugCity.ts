// Worst-case loader: fills the map with a grid of streets and generic buildings
// in the blocks. Global grid (not per tile), heights from the terrain generator
// (deterministic, independent of worker order). ~90k buildings and ~20k
// road segments on the 10 km map.

import { HEIGHT_TILE_RES, MAP_HALF, MAP_SIZE, MAP_TILES, SEA_LEVEL } from '../config.ts';
import { Rng, fbm, hash2 } from '../core/rng.ts';
import { tileX, tileId } from '../core/grid.ts';
import { heightIndex, worldOfSample } from '../world/heights.ts';
import { baseHeight, waterLevelAt } from './terrainGen.ts';
import { SHAPE_STRIDE, emptyBoxes, type BoxColumns } from '../shared/contracts/worker.ts';
import { PROFILE_INFO } from '../roads/profiles.ts';

export const BLOCK = 88; // grid spacing (m)
export const DEBUG_PROFILE = 1; // street with parking, ~16 m
export const DEBUG_AVENUE = 3; // an avenue every 5 lines
const HALF = PROFILE_INFO[DEBUG_PROFILE].right;
/** Profile of grid line i (same for both directions). */
export const lineProfile = (i: number): number => (i % 5 === 2 ? DEBUG_AVENUE : DEBUG_PROFILE);
const halfOf = (i: number): number => PROFILE_INFO[lineProfile(i)].right;
const LINES = Math.floor(MAP_SIZE / BLOCK); // 106
const MAX_GRADE = 0.1;
const PALETTE = [0xd8cfc0, 0xc9b79c, 0xb8bcc2, 0xe6e1d6, 0xa89880, 0x9fa8b0, 0xd2c4b0, 0xbfae95, 0x8e9aa6, 0xcdd2d6];

const lineX = (i: number) => -MAP_HALF + BLOCK / 2 + i * BLOCK;

/** Height of a grid node (smoothed average of the generated terrain), or NaN if no street fits. */
export function gridNodeHeight(i: number, j: number, seed: number): number {
  const x = lineX(i), z = lineX(j);
  let h = 0;
  for (const [dx, dz] of [[0, 0], [6, 0], [-6, 0], [0, 6], [0, -6]]) h += baseHeight(x + dx, z + dz, seed);
  h /= 5;
  if (h < SEA_LEVEL + 1.2 || waterLevelAt(x, z, seed) > h - 1.2) return NaN;
  if (Math.max(Math.abs(x), Math.abs(z)) > MAP_HALF - 300) return NaN; // edge mountains
  return h;
}

function edgeOk(ha: number, hb: number): boolean {
  return Number.isFinite(ha) && Number.isFinite(hb) && Math.abs(ha - hb) / BLOCK <= MAX_GRADE;
}

export interface DebugRoads {
  nodes: Float32Array; // i, j, x, z, y per node
  segs: Int32Array; // i1, j1, i2, j2 per segment
}

/** Grid nodes and segments whose start node lies in this tile. */
export function debugTileRoads(tile: number, seed: number): DebugRoads {
  const nodes: number[] = [], segs: number[] = [];
  const tx = tile % MAP_TILES, tz = (tile / MAP_TILES) | 0;
  const cache = new Map<number, number>();
  const H = (i: number, j: number) => {
    const k = i * 1000 + j;
    let v = cache.get(k);
    if (v === undefined) { v = i < 0 || j < 0 || i >= LINES || j >= LINES ? NaN : gridNodeHeight(i, j, seed); cache.set(k, v); }
    return v;
  };
  for (let j = 0; j < LINES; j++) {
    for (let i = 0; i < LINES; i++) {
      const x = lineX(i), z = lineX(j);
      if (tileId(tileX(x), tileX(z)) !== tile || tileX(x) !== tx || tileX(z) !== tz) continue;
      const h = H(i, j);
      if (!Number.isFinite(h)) continue;
      // a node exists only if it has at least one segment
      const right = edgeOk(h, H(i + 1, j)), down = edgeOk(h, H(i, j + 1));
      const left = edgeOk(h, H(i - 1, j)), up = edgeOk(h, H(i, j - 1));
      if (!(right || down || left || up)) continue;
      nodes.push(i, j, x, z, h);
      if (right) segs.push(i, j, i + 1, j);
      if (down) segs.push(i, j, i, j + 1);
    }
  }
  return { nodes: new Float32Array(nodes), segs: new Int32Array(segs) };
}

/** Settles the tile's terrain under the grid streets (writes only to the tile's samples). */
export function conformTileToGrid(heights: Float32Array, tile: number, seed: number): { min: number; max: number } {
  const tx = tile % MAP_TILES, tz = (tile / MAP_TILES) | 0;
  const blend = 6;
  let min = Infinity, max = -Infinity;
  const cache = new Map<number, number>();
  const H = (i: number, j: number) => {
    const k = i * 1000 + j;
    let v = cache.get(k);
    if (v === undefined) { v = i < 0 || j < 0 || i >= LINES || j >= LINES ? NaN : gridNodeHeight(i, j, seed); cache.set(k, v); }
    return v;
  };
  for (let sj = 0; sj < HEIGHT_TILE_RES; sj++) {
    const gz = tz * HEIGHT_TILE_RES + sj;
    const z = worldOfSample(gz);
    for (let si = 0; si < HEIGHT_TILE_RES; si++) {
      const gx = tx * HEIGHT_TILE_RES + si;
      const x = worldOfSample(gx);
      const idx = heightIndex(gx, gz);
      const old = heights[idx];
      let best = Infinity, target = 0;
      // nearest vertical street (along z)
      const fi = (x + MAP_HALF - BLOCK / 2) / BLOCK, fj = (z + MAP_HALF - BLOCK / 2) / BLOCK;
      const i = Math.round(fi), j = Math.round(fj);
      const dX = Math.abs(x - lineX(i)), dZ = Math.abs(z - lineX(j));
      if (dX < halfOf(i) + blend) {
        const j0 = Math.floor(fj), t = fj - j0;
        const ha = H(i, j0), hb = H(i, j0 + 1);
        if (edgeOk(ha, hb)) { best = dX; target = ha + (hb - ha) * t; }
      }
      if (dZ < halfOf(j) + blend && dZ < best) {
        const i0 = Math.floor(fi), t = fi - i0;
        const ha = H(i0, j), hb = H(i0 + 1, j);
        if (edgeOk(ha, hb)) { best = dZ; target = ha + (hb - ha) * t; }
      }
      let v = old;
      const half = best === dX ? halfOf(i) : halfOf(j);
      if (best < half + blend) {
        const k = best <= half ? 1 : 1 - smooth((best - half) / blend);
        v = old + (target - 0.05 - old) * k;
        heights[idx] = v;
      }
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return { min, max };
}

function smooth(t: number): number { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); }

/** Buildings of the blocks whose center lies in this tile. */
export function debugTileBoxes(tile: number, seed: number): BoxColumns {
  const tx = tile % MAP_TILES, tz = (tile / MAP_TILES) | 0;
  const out = emptyBoxes(14 * 14 * 12);
  let n = 0;
  const street = HALF * 2 + 0.4;
  const lot = BLOCK - street;
  for (let bj = 0; bj + 1 < LINES; bj++) {
    for (let bi = 0; bi + 1 < LINES; bi++) {
      const x0 = lineX(bi) + street / 2, z0 = lineX(bj) + street / 2;
      const cx = x0 + lot / 2, cz = z0 + lot / 2;
      if (tileX(cx) !== tx || tileX(cz) !== tz) continue;
      // a block only where all four corners have a street
      const hs = [gridNodeHeight(bi, bj, seed), gridNodeHeight(bi + 1, bj, seed), gridNodeHeight(bi, bj + 1, seed), gridNodeHeight(bi + 1, bj + 1, seed)];
      if (hs.some((h) => !Number.isFinite(h))) continue;
      if (Math.max(...hs) - Math.min(...hs) > 12) continue;
      const rng = new Rng(hash2(Math.round(cx), Math.round(cz), seed));
      const center = Math.hypot(cx, cz);
      const downtown = Math.max(0, 1 - center / 2200);
      const density = 0.5 + 0.5 * fbm(cx / 1500, cz / 1500, seed + 5, 2);
      const lw = lot / 3, ld = lot / 4;
      for (let ly = 0; ly < 4; ly++) {
        for (let lx = 0; lx < 3; lx++) {
          if (rng.next() > 0.6 + 0.4 * density) continue;
          const w = lw - rng.range(2.5, 6);
          const d = ld - rng.range(2, 5);
          const tall = rng.next() < downtown * 0.6;
          const h = tall ? rng.range(30, 40 + 160 * downtown) : rng.range(4, 10 + 20 * density);
          out.x[n] = x0 + lx * lw + lw / 2;
          out.z[n] = z0 + ly * ld + ld / 2;
          out.w[n] = w; out.d[n] = d; out.h[n] = h;
          out.rot[n] = 0;
          out.color[n] = PALETTE[rng.int(0, PALETTE.length)];
          n++;
        }
      }
    }
  }
  return {
    count: n,
    x: out.x.slice(0, n), z: out.z.slice(0, n), w: out.w.slice(0, n), d: out.d.slice(0, n),
    h: out.h.slice(0, n), rot: out.rot.slice(0, n), color: out.color.slice(0, n),
    seed: out.seed.slice(0, n), zone: out.zone.slice(0, n), floors: out.floors.slice(0, n), style: out.style.slice(0, n), fn: out.fn.slice(0, n),
    shapeN: out.shapeN.slice(0, n), shape: out.shape.slice(0, n * SHAPE_STRIDE), built: out.built.slice(0, n), decay: out.decay.slice(0, n),
  };
}

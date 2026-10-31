// The land's slope per height corner, as Roadcraft 4.0's (render/terrainLightCompute.ts:54-92 landSlope): half the
// steepest cell round the corner, half the mean of that over the corners round it, in degrees (byte = deg / 90 × 255).
// The shader reads it bilinear between the corners (terrain.ts landSlopeAt) and lets it take over the vertex normal's
// slope on steep ground (4.0 terrain.ts:720-723 terrainSlope): a corner at a cliff's foot or rim reads the cliff, so a
// wall's cells are rock whole and the rock's edge runs along the cells, not in teeth along the triangles. Pure: it runs
// in the ecology worker, one tile at a time, on the map's shared heights.

import { HEIGHT_SPACING, HEIGHT_TILE_RES, MAP_TILES } from '../config.ts';

/** Corners per tile side (the height samples). */
export const SLOPE_RES = HEIGHT_TILE_RES;
/** Corners read round the tile: the mean's ring and the steepest cell's. */
const BORDER = 2;

/** Writes tile `tile`'s corner slopes into `out` (SLOPE_RES² bytes). */
export function slopeTile(heights: Float32Array, tile: number, out: Uint8Array): void {
  const W = SLOPE_RES + BORDER * 2, RES = HEIGHT_TILE_RES * MAP_TILES;
  const tx = tile % MAP_TILES, tz = Math.floor(tile / MAP_TILES);
  const gx0 = tx * SLOPE_RES - BORDER, gz0 = tz * SLOPE_RES - BORDER;
  const h = new Float32Array(W * W);
  for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
    const gx = Math.min(RES - 1, Math.max(0, gx0 + i)), gz = Math.min(RES - 1, Math.max(0, gz0 + j));
    const t = Math.floor(gz / HEIGHT_TILE_RES) * MAP_TILES + Math.floor(gx / HEIGHT_TILE_RES);
    h[j * W + i] = heights[t * HEIGHT_TILE_RES * HEIGHT_TILE_RES + (gz % HEIGHT_TILE_RES) * HEIGHT_TILE_RES + (gx % HEIGHT_TILE_RES)];
  }
  // the steepest cell round each corner (the cells it is a corner of), degrees; the outer ring is left 0 and unread
  const steep = new Float32Array(W * W);
  for (let j = 1; j < W - 1; j++) for (let i = 1; i < W - 1; i++) {
    let most = 0;
    for (let cy = j - 1; cy <= j; cy++) for (let cx = i - 1; cx <= i; cx++) {
      const a = h[cy * W + cx], b = h[cy * W + cx + 1], c = h[(cy + 1) * W + cx], d = h[(cy + 1) * W + cx + 1];
      const gx = (b - a + d - c) / (2 * HEIGHT_SPACING), gy = (c - a + d - b) / (2 * HEIGHT_SPACING);
      most = Math.max(most, Math.hypot(gx, gy));
    }
    steep[j * W + i] = (Math.atan(most) * 180) / Math.PI;
  }
  for (let j = 0; j < SLOPE_RES; j++) for (let i = 0; i < SLOPE_RES; i++) {
    const wi = i + BORDER, wj = j + BORDER;
    let sum = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += steep[(wj + dy) * W + wi + dx];
    const deg = 0.5 * steep[wj * W + wi] + 0.5 * (sum / 9);
    out[j * SLOPE_RES + i] = Math.round(Math.min(1, deg / 90) * 255);
  }
}

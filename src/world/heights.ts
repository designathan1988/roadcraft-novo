// Terrain heights on a HEIGHT_SPACING m grid, stored per tile
// (layer) in a SharedArrayBuffer. The same array feeds the GPU's layered
// texture, so editing a tile uploads that layer only.
// Pure module: used on the page and in the workers.

import {
  HEIGHT_MAP_RES, HEIGHT_SPACING, HEIGHT_TILE_RES, MAP_HALF, MAP_TILES,
} from '../config.ts';
import { cellId, cellX } from '../core/grid.ts';

export const LAYER_TEXELS = HEIGHT_TILE_RES * HEIGHT_TILE_RES;
const SHIFT = Math.log2(HEIGHT_TILE_RES);
const MASK = HEIGHT_TILE_RES - 1;
if (1 << SHIFT !== HEIGHT_TILE_RES) throw new Error('HEIGHT_TILE_RES must be a power of 2');

export function createHeightBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(LAYER_TEXELS * MAP_TILES * MAP_TILES * 4);
}

/** Index in the heights array of the global sample (gx, gz). */
export function heightIndex(gx: number, gz: number): number {
  return (((gz >> SHIFT) * MAP_TILES + (gx >> SHIFT)) << (SHIFT * 2)) + ((gz & MASK) << SHIFT) + (gx & MASK);
}

/** Global (fractional) sample of a world coordinate. */
export const sampleCoord = (w: number) => (w + MAP_HALF) / HEIGHT_SPACING;
/** World coordinate of the global sample g. */
export const worldOfSample = (g: number) => g * HEIGHT_SPACING - MAP_HALF;

const clampG = (g: number) => (g < 0 ? 0 : g > HEIGHT_MAP_RES - 1 ? HEIGHT_MAP_RES - 1 : g);

/** Bilinear height at world (x, z). The same the terrain shader computes. */
export function heightAt(h: Float32Array, x: number, z: number): number {
  const fx = sampleCoord(x), fz = sampleCoord(z);
  const x0 = Math.floor(fx), z0 = Math.floor(fz);
  const tx = fx - x0, tz = fz - z0;
  const ax = clampG(x0), bx = clampG(x0 + 1), az = clampG(z0), bz = clampG(z0 + 1);
  const h00 = h[heightIndex(ax, az)], h10 = h[heightIndex(bx, az)];
  const h01 = h[heightIndex(ax, bz)], h11 = h[heightIndex(bx, bz)];
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}

/** Global sample (gx, gz) of an index into the heights (inverse of heightIndex). */
export function sampleOfIndex(i: number): [number, number] {
  const tile = i >> (SHIFT * 2), local = i & (LAYER_TEXELS - 1);
  return [(tile % MAP_TILES) * HEIGHT_TILE_RES + (local & MASK), ((tile / MAP_TILES) | 0) * HEIGHT_TILE_RES + (local >> SHIFT)];
}

/**
 * The cells whose meshes read the samples `idx`: the cell of each sample and of the points `margin` metres away (one
 * spacing for the terrain and roads on the next cell's edge; a building's half size for buildings). Only the touched
 * cells, never a bounding box.
 */
export function cellsOfSamples(idx: ArrayLike<number>, margin = HEIGHT_SPACING): number[] {
  const seen = new Set<number>();
  for (let k = 0; k < idx.length; k++) {
    const [gx, gz] = sampleOfIndex(idx[k]);
    const x = worldOfSample(gx), z = worldOfSample(gz);
    for (const dz of [-margin, margin]) for (const dx of [-margin, margin]) seen.add(cellId(cellX(x + dx), cellX(z + dz)));
  }
  return [...seen];
}

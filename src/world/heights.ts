// Alturas do terreno numa grade de HEIGHT_SPACING m, guardadas por ladrilho
// (camada) num SharedArrayBuffer. O mesmo array alimenta a textura em camadas
// da GPU, então editar um ladrilho só reenvia aquela camada.
// Módulo puro: usado na página e nos workers.

import {
  HEIGHT_MAP_RES, HEIGHT_SPACING, HEIGHT_TILE_RES, MAP_HALF, MAP_TILES,
} from '../config.ts';

export const LAYER_TEXELS = HEIGHT_TILE_RES * HEIGHT_TILE_RES;
const SHIFT = Math.log2(HEIGHT_TILE_RES);
const MASK = HEIGHT_TILE_RES - 1;
if (1 << SHIFT !== HEIGHT_TILE_RES) throw new Error('HEIGHT_TILE_RES precisa ser potência de 2');

export function createHeightBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(LAYER_TEXELS * MAP_TILES * MAP_TILES * 4);
}

/** Índice no array de alturas da amostra global (gx, gz). */
export function heightIndex(gx: number, gz: number): number {
  return (((gz >> SHIFT) * MAP_TILES + (gx >> SHIFT)) << (SHIFT * 2)) + ((gz & MASK) << SHIFT) + (gx & MASK);
}

/** Amostra global (fracionária) de uma coordenada de mundo. */
export const sampleCoord = (w: number) => (w + MAP_HALF) / HEIGHT_SPACING;
/** Coordenada de mundo da amostra global g. */
export const worldOfSample = (g: number) => g * HEIGHT_SPACING - MAP_HALF;

const clampG = (g: number) => (g < 0 ? 0 : g > HEIGHT_MAP_RES - 1 ? HEIGHT_MAP_RES - 1 : g);

/** Altura bilinear em (x, z) de mundo. Igual à que o shader do terreno calcula. */
export function heightAt(h: Float32Array, x: number, z: number): number {
  const fx = sampleCoord(x), fz = sampleCoord(z);
  const x0 = Math.floor(fx), z0 = Math.floor(fz);
  const tx = fx - x0, tz = fz - z0;
  const ax = clampG(x0), bx = clampG(x0 + 1), az = clampG(z0), bz = clampG(z0 + 1);
  const h00 = h[heightIndex(ax, az)], h10 = h[heightIndex(bx, az)];
  const h01 = h[heightIndex(ax, bz)], h11 = h[heightIndex(bx, bz)];
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}

/** Menor e maior altura num retângulo de mundo (para caixas de recorte e bases de prédio). */
export function heightRange(h: Float32Array, minX: number, minZ: number, maxX: number, maxZ: number, out: Float32Array): void {
  const gx0 = clampG(Math.floor(sampleCoord(minX))), gx1 = clampG(Math.ceil(sampleCoord(maxX)));
  const gz0 = clampG(Math.floor(sampleCoord(minZ))), gz1 = clampG(Math.ceil(sampleCoord(maxZ)));
  let lo = Infinity, hi = -Infinity;
  for (let gz = gz0; gz <= gz1; gz++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const v = h[heightIndex(gx, gz)];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  out[0] = lo; out[1] = hi;
}

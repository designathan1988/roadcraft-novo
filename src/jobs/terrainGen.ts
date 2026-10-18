// Gera o relevo base de um ladrilho direto no SharedArrayBuffer de alturas.
// Determinístico pela semente: o mesmo mapa em qualquer máquina.

import { HEIGHT_TILE_RES, MAP_HALF, MAP_TILES, TERRAIN_MAX_Y, TERRAIN_MIN_Y } from '../config.ts';
import { fbm } from '../core/rng.ts';
import { heightIndex, worldOfSample } from '../world/heights.ts';

export function baseHeight(x: number, z: number, seed: number): number {
  // colinas largas e suaves, boas para cidade
  let h = 18 + 30 * fbm(x / 2600, z / 2600, seed, 4);
  h += 6 * fbm(x / 520, z / 520, seed + 7, 3);
  // vale de rio cruzando o mapa
  const river = Math.abs(z - 900 * fbm(x / 4000, 0.5, seed + 31, 2) - 600 * Math.sin(x / 2300));
  const valley = Math.min(1, river / 380);
  h = h * (0.25 + 0.75 * valley * valley) - 10 * (1 - Math.min(1, river / 60));
  // serras nas bordas do mapa
  const edge = Math.max(Math.abs(x), Math.abs(z)) / MAP_HALF;
  if (edge > 0.82) {
    const t = (edge - 0.82) / 0.18;
    h += t * t * (90 + 70 * fbm(x / 700, z / 700, seed + 99, 4));
  }
  return Math.min(TERRAIN_MAX_Y, Math.max(TERRAIN_MIN_Y, h));
}

export function generateTerrainTile(heights: Float32Array, tile: number, seed: number): { min: number; max: number } {
  const tx = tile % MAP_TILES, tz = (tile / MAP_TILES) | 0;
  let min = Infinity, max = -Infinity;
  for (let j = 0; j < HEIGHT_TILE_RES; j++) {
    const gz = tz * HEIGHT_TILE_RES + j;
    const z = worldOfSample(gz);
    for (let i = 0; i < HEIGHT_TILE_RES; i++) {
      const gx = tx * HEIGHT_TILE_RES + i;
      const v = baseHeight(worldOfSample(gx), z, seed);
      heights[heightIndex(gx, gz)] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return { min, max };
}

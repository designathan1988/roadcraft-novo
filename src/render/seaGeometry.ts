// The sea as geometry, not a masked plane (audit F8): a grid over the map, keeping a vertex only where the sea was
// ever visible - the ground under sea level (the water colour's depth, and with it the alpha, is exactly the
// ground's drop below SEA_LEVEL: everywhere else the old 8x-map plane drew fully transparent) and no river or lake
// standing above it (their own water tiles draw there - the old mask's own rule). Without the mask's discard the
// opaque land's depth rejects the sea's pixels early (early-Z: the water shader ran under every inland pixel of
// the plane), and the four table reads a pixel paid are gone. The 128 m edge at the coast lies under the terrain's
// own waterline. Rebuilt when the water table is edited (the game's frame, at most then).

import * as THREE from 'three/webgpu';
import { MAP_HALF, MAP_SIZE, MAP_TILES, SEA_LEVEL } from '../config.ts';
import { heightAt } from '../world/heights.ts';
import { WATER_SPACING, WATER_TILE_RES } from '../world/ground.ts';
import type { World } from '../world/world.ts';

/** Water level at a global 8 m sample (NO_WATER where dry): the CPU side of the water texture. */
function waterLevelAt(world: World, gx: number, gz: number): number {
  const WRES = WATER_TILE_RES * MAP_TILES;
  const cx = Math.min(WRES - 1, Math.max(0, gx)), cz = Math.min(WRES - 1, Math.max(0, gz));
  const layer = ((cz >> 7) * MAP_TILES + (cx >> 7)) * WATER_TILE_RES * WATER_TILE_RES;
  return world.water[layer + (cz & 127) * WATER_TILE_RES + (cx & 127)]!;
}

/** The sea's mesh over the map (see the header). */
export function buildSeaGeometry(world: World): THREE.BufferGeometry {
  const STEP = 128;
  const n0 = Math.ceil(MAP_SIZE / STEP) + 1;
  const pos = new Float32Array(n0 * n0 * 3);
  const keep = new Uint8Array(n0 * n0);
  for (let j = 0; j < n0; j++) for (let i = 0; i < n0; i++) {
    const x = -MAP_HALF + Math.min(i * STEP, MAP_SIZE), z = -MAP_HALF + Math.min(j * STEP, MAP_SIZE), k = j * n0 + i;
    pos[k * 3] = x; pos[k * 3 + 1] = SEA_LEVEL; pos[k * 3 + 2] = z;
    // 2 m past the waterline: the extra vertices stay hidden under the beach slope, so the 128 m grid cannot gap
    if (heightAt(world.heights, x, z) >= SEA_LEVEL + 2) continue;
    const gx = Math.floor((x + MAP_HALF) / WATER_SPACING), gz = Math.floor((z + MAP_HALF) / WATER_SPACING);
    const level = Math.max(Math.max(waterLevelAt(world, gx - 1, gz - 1), waterLevelAt(world, gx, gz - 1)), Math.max(waterLevelAt(world, gx - 1, gz), waterLevelAt(world, gx, gz)));
    keep[k] = level < SEA_LEVEL + 0.6 ? 1 : 0;
  }
  const idx = new Uint32Array(n0 * n0 * 6);
  let n = 0;
  for (let j = 0; j + 1 < n0; j++) for (let i = 0; i + 1 < n0; i++) {
    const a = j * n0 + i, b = a + 1, c = a + n0, d = c + 1;
    if (keep[a]! && keep[b]! && keep[c]! && keep[d]!) { idx[n++] = a; idx[n++] = c; idx[n++] = b; idx[n++] = b; idx[n++] = c; idx[n++] = d; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx.subarray(0, n), 1));
  return g;
}

// The procedural surface textures: asphalt tone, grass, water normals and the terrain's blend noise. Each is made now
// with its final size and neutral texels (the mean of its recipe), and filled when render/surfaceBakeWorker.ts has
// baked it (render/surfaceRecipes.ts): the recipes never run on the main thread. Each one tiles seamlessly.

import * as THREE from 'three/webgpu';
import { ASPHALT_SIZE, GRASS_SIZE, NOISE_SIZE, WATER_SIZE } from './surfaceRecipes.ts';
import type { BakedSurface } from './surfaceBakeWorker.ts';

function texture(size: number, r: number, g: number, b: number, a: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  new Uint32Array(data.buffer).fill(((a << 24) | (b << 16) | (g << 8) | r) >>> 0);
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/** Side of the asphalt tile (m). */
export const ASPHALT_TILE = 10.4;
/** Side of the grass tile (m). */
export const GRASS_TILE = 19.2;
/** Side of the rock texture's tile (m): Roadcraft 4.0's ROCK_WORLD. */
export const ROCK_TILE = 23.2;

/** Asphalt: R = relative tone (0.5 = the road colour), G = wear sheen. */
export const ASPHALT_TEX = texture(ASPHALT_SIZE, 128, 128, 0, 255);
/** Grass: RGB = relative colour per channel (0.5 = the biome colour). */
export const GRASS_TEX = texture(GRASS_SIZE, 128, 128, 128, 255);
/** Water: RGB = normal, A = foam noise. */
export const WATER_TEX = texture(WATER_SIZE, 128, 128, 255, 128);
/** Terrain blend wander: r, g, b, a = value noise of periods 4, 8, 16 and 32. */
export const TERRAIN_NOISE = texture(NOISE_SIZE, 128, 128, 128, 128);

const BY_NAME: Record<BakedSurface, THREE.DataTexture> = { asphalt: ASPHALT_TEX, grass: GRASS_TEX, water: WATER_TEX, noise: TERRAIN_NOISE };

/** Starts the bake; called once, by render/cookedSurfaces.ts loadCookedSurfaces (the surfaces' single start). */
export function bakeSurfaces(): void {
  const w = new Worker(new URL('./surfaceBakeWorker.ts', import.meta.url), { type: 'module', name: 'surfaces' });
  w.onmessage = (e: MessageEvent<{ name: BakedSurface; data: Uint8Array }>) => {
    const t = BY_NAME[e.data.name];
    // the worker's array becomes the texture's data (the same size): no copy on the main thread
    t.image.data = e.data.data;
    t.needsUpdate = true;
  };
  w.postMessage(null);
}

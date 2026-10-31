/// <reference types="node" />
// Procedural surfaces (render/surfaceRecipes.ts): baked by render/surfaceBakeWorker.ts, never on the main thread.
// Before, render/surfaceBake.ts ran the four recipes when it was imported (~150 ms on the page at load).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bakeAsphalt, bakeGrass, bakeTerrainNoise, bakeWaterNormals } from '../src/render/surfaceRecipes.ts';
import { ASPHALT_TEX, GRASS_TEX, TERRAIN_NOISE, WATER_TEX } from '../src/render/surfaceBake.ts';

const fnv = (d: Uint8Array): string => { let h = 0x811c9dc5; for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 0x01000193); return (h >>> 0).toString(16); };

test('the worker recipes bake the same texels the main thread baked before (FNV-1a of each map)', () => {
  assert.deepEqual({ asphalt: fnv(bakeAsphalt()), grass: fnv(bakeGrass()), water: fnv(bakeWaterNormals()), noise: fnv(bakeTerrainNoise()) },
    { asphalt: '32b4e543', grass: 'd320211f', water: '50f4dc63', noise: 'bff86bf9' });
});

test('loading the textures module bakes nothing: each texture holds one neutral texel until the worker fills it', () => {
  for (const t of [ASPHALT_TEX, GRASS_TEX, WATER_TEX, TERRAIN_NOISE]) {
    const px = new Uint32Array((t.image.data as Uint8Array).buffer);
    assert.ok(px.every((p) => p === px[0]));
  }
});

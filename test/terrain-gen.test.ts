/// <reference types="node" />
// The generated river and lakes, as Roadcraft 4.0 draws them with its river brush (src/jobs/terrainGen.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAP_HALF, SEA_LEVEL } from '../src/config.ts';
import { TILE_COUNT } from '../src/core/grid.ts';
import { NO_WATER, WATER_SPACING } from '../src/world/ground.ts';
import * as gen from '../src/jobs/terrainGen.ts';

const SEED = 1;
const level = (x: number, z: number) => (gen as Record<string, unknown>).waterLevelAt ? gen.waterLevelAt(x, z, SEED) : NO_WATER;

/** The river's middle at x: the lowest ground across a band, where there is water over it. */
function middle(x: number): { z: number; ground: number; level: number } | null {
  let best: { z: number; ground: number; level: number } | null = null;
  for (let z = -2000; z <= 2000; z += 4) {
    const w = level(x, z);
    if (w === NO_WATER) continue;
    const g = gen.baseHeight(x, z, SEED);
    if (!best || g < best.ground) best = { z, ground: g, level: w };
  }
  return best;
}

test('the generated river is a river: water above the sea, falling downstream, a bed as deep as 4.0 cuts', () => {
  const xs: number[] = [];
  for (let x = -MAP_HALF * 0.7; x <= MAP_HALF * 0.7; x += 400) xs.push(x);
  const mids = xs.map(middle);
  assert.ok(mids.every(Boolean), 'no generated water along the course');
  const L = mids.map((m) => m!.level);
  // above the sea all along (it was sea before: the plane at 0 over a groove)
  for (const l of L) assert.ok(l > SEA_LEVEL + 0.9, `level ${l}`);
  // only falls, one way
  const down = L[0] > L[L.length - 1];
  for (let i = 1; i < L.length; i++) assert.ok(down ? L[i] < L[i - 1] : L[i] > L[i - 1], `level rises at ${xs[i]}: ${L[i - 1]} → ${L[i]}`);
  // 4.0's default river: 14.6 m under the banks, the water fills 55 %: 7-9 m over the floor
  for (const m of mids) { const d = m!.level - m!.ground; assert.ok(d > 6 && d < 12, `depth ${d}`); }
  // and the banks stand over the water (the river runs in its bed): 120 m out of the middle the ground is dry
  for (let i = 0; i < xs.length; i++) {
    const m = mids[i]!;
    for (const s of [-1, 1]) assert.ok(gen.baseHeight(xs[i], m.z + s * 120, SEED) > m.level, `bank under water at ${xs[i]}`);
  }
});

test('the tile generator writes the water and says which tiles have it', () => {
  const heights = new Float32Array(TILE_COUNT * 256 * 256);
  const water = new Float32Array(TILE_COUNT * 128 * 128).fill(NO_WATER);
  let wet = 0;
  for (let t = 0; t < TILE_COUNT; t++) { const r = gen.generateTerrainTile(heights, t, SEED, water) as { hasWater?: boolean }; if (r.hasWater) wet++; }
  assert.ok(wet > 0 && wet < TILE_COUNT, `${wet} tiles with water`);
  let n = 0; for (const v of water) if (v !== NO_WATER) n++;
  assert.ok(n * WATER_SPACING * WATER_SPACING > 1e6, `${n} water samples`);
});


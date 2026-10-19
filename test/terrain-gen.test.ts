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
  const zc = gen.courseZ(x, SEED);
  for (let z = zc - 200; z <= zc + 200; z += 4) {
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


test('the generated city keeps out of the river: no street node in its water, streets only cross it', async () => {
  const { generateCity } = await import('../src/jobs/cityGen.ts');
  const c = generateCity(SEED);
  const wetAt = (x: number, z: number) => level(x, z) > gen.baseHeight(x, z, SEED) - 0.5;
  const n = c.nodes.length / 3;
  // a junction or a dead end never stands in the water; a node in the middle of a bridge (two legs, the generator
  // cuts long edges into pieces) does, as long as the bridge it is on lands on dry ground at both ends
  const legs: number[][] = Array.from({ length: n }, () => []);
  for (let s = 0; s < c.segs.length; s += 5) { legs[c.segs[s]].push(c.segs[s + 1]); legs[c.segs[s + 1]].push(c.segs[s]); }
  const wet = (i: number) => wetAt(c.nodes[i * 3], c.nodes[i * 3 + 1]);
  let wetNodes = 0;
  for (let i = 0; i < n; i++) {
    if (!wet(i)) continue;
    if (legs[i].length !== 2) { wetNodes++; continue; }
    // follow the bridge both ways through its middle nodes: it must reach a dry node each way
    for (const first of legs[i]) {
      let prev = i, at = first, steps = 0;
      while (wet(at) && legs[at].length === 2 && steps++ < 50) { const next = legs[at][0] === prev ? legs[at][1] : legs[at][0]; prev = at; at = next; }
      if (wet(at)) { wetNodes++; break; }
    }
  }
  assert.equal(wetNodes, 0, `${wetNodes} street nodes in the water that are not the middle of a bridge`);
  // a street over water is a bridge: from dry ground to dry ground, never more than 320 m of it
  let along = 0;
  for (let s = 0; s < c.segs.length; s += 5) {
    const a = c.segs[s], b = c.segs[s + 1];
    const ax = c.nodes[a * 3], az = c.nodes[a * 3 + 1], bx = c.nodes[b * 3], bz = c.nodes[b * 3 + 1];
    const L = Math.hypot(bx - ax, bz - az), k = Math.ceil(L / 4);
    let wet = 0;
    for (let i = 1; i < k; i++) if (wetAt(ax + (bx - ax) * i / k, az + (bz - az) * i / k)) wet += L / k;
    if (wet > 320) along++;
  }
  assert.equal(along, 0, `${along} streets run in the river`);
});

test('lakes as in 4.0: hollows away from the river, each one body at one flat level', () => {
  // water more than 700 m from the river's middle is a lake: grouped by its level, each group is one compact body
  const lakes = new Map<number, number[]>();
  for (let x = -MAP_HALF * 0.74; x < MAP_HALF * 0.74; x += 24) {
    const zc = gen.courseZ(x, SEED);
    for (let z = -MAP_HALF * 0.74; z < MAP_HALF * 0.74; z += 24) {
      if (Math.abs(z - zc) < 700) continue;
      const w = level(x, z);
      if (w === NO_WATER) continue;
      const k = Math.round(w * 1000);
      if (!lakes.has(k)) lakes.set(k, []);
      lakes.get(k)!.push(x, z);
    }
  }
  assert.ok(lakes.size >= 1, 'no lake');
  for (const [k, p] of lakes) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); z0 = Math.min(z0, p[i + 1]); z1 = Math.max(z1, p[i + 1]); }
    assert.ok(x1 - x0 < 600 && z1 - z0 < 600, `lake at level ${k / 1000} spans ${x1 - x0} × ${z1 - z0} m`);
  }
});

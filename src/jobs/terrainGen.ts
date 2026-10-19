// The base relief of a tile, written straight into the shared height buffer, with the generated river and lakes in
// the shared water buffer. Deterministic from the seed: the same map on any machine.
//
// The river is a river as Roadcraft 4.0 draws one with its brush at the default size (`main.ts:372-373`: radius 80 m,
// strength 24): a bed with a flat floor and ramped banks that wander in and out (`world/terrain.ts:249-277`), its
// water down from the lowest bank (`render/terrain.ts:1772-1779`), smoothed along the course and never dry
// (`render/terrain.ts:2566-2574`). Here its level also only falls downstream (the water shader reads the current
// from the level's slope). Lakes are 4.0's flood (`render/terrain.ts:2338-2401`) filling the land's basins: the
// water rises in a basin until it would spill, and its shore follows the land.

import { HEIGHT_TILE_RES, MAP_HALF, MAP_TILES, SEA_LEVEL, TERRAIN_MAX_Y, TERRAIN_MIN_Y } from '../config.ts';
import { fbm } from '../core/rng.ts';
import { heightIndex, worldOfSample } from '../world/heights.ts';
import { NO_WATER, WATER_SPACING, WATER_TILE_RES, waterIndex } from '../world/ground.ts';

// 4.0's river brush and water (metres; 4.0's unit is the metre, `core/units.ts`)
/** Default brush radius and strength (`main.ts:372-373`). */
const RIVER_RADIUS = 80, RIVER_STRENGTH = 24;
/** `world/terrain.ts:42`, `:53`, `:55`, `:58`. */
const RIVER_CARVE = 1.45, RIVER_BED_DEPTH = 0.42, RIVER_BED_FLOOR = 0.72, ROUGH_REACH_MIN = 0.78;
/** The carve under the banks at the bed's floor: 24 × 1.45 × 0.42 = 14.6 m. */
const BED_CARVE = RIVER_STRENGTH * RIVER_CARVE * RIVER_BED_DEPTH;
/** `render/terrain.ts:87-89`: share of a channel's depth the water fills, its margin under the banks. */
const WATER_FILL = 0.45, WATER_MARGIN = 0.16;
/** `render/terrain.ts:2536`: the least water over a river's bed. */
const RIVER_MIN_DEPTH = 0.5;
/** `world/terrain.ts:40`: what counts as wet. */
const TERRAIN_WATER_HEIGHT = 0.048;
/** `render/terrain.ts:2339`: 40 000 cells of 1.6 m flood at most (here in 8 m samples). */
const MAX_FLOOD = Math.round(40_000 * 1.6 * 1.6 / (WATER_SPACING * WATER_SPACING));

/** The least height of the river valley's floor (it was 2-7 m up: 4.0's water, 6.6 m under the banks, was under the sea). */
const VALLEY_FLOOR = 12;
/** The least fall of the river's level, per metre (0.3 m/km: the water shader reads the current from it). */
const MIN_FALL = 0.0003;
/** Lakes: one candidate basin per square of this side; its radius and depth. */
const LAKE_GRID = 2200, BASIN_RADIUS = 170, BASIN_DEPTH = 9;

/** The basin of a lake square, if it has one: away from the river's valley and the map's edges. */
function basinOf(i: number, j: number, seed: number): [number, number] | null {
  const r = (k: number) => 0.5 + 0.5 * hash2(i * 7 + k + seed * 13, j * 11 - k);
  if (r(3) > 0.6) return null;
  const x = (i + 0.25 + 0.5 * r(1)) * LAKE_GRID, z = (j + 0.25 + 0.5 * r(2)) * LAKE_GRID;
  if (Math.max(Math.abs(x), Math.abs(z)) / MAP_HALF > 0.74 || Math.abs(z - courseZ(x, seed)) < 760) return null;
  return [x, z];
}
function basinsNear(x: number, z: number, seed: number): Array<[number, number]> {
  const i0 = Math.floor(x / LAKE_GRID), j0 = Math.floor(z / LAKE_GRID), out: Array<[number, number]> = [];
  for (let j = j0 - 1; j <= j0 + 1; j++) for (let i = i0 - 1; i <= i0 + 1; i++) { const b = basinOf(i, j, seed); if (b) out.push(b); }
  return out;
}

// 4.0's value noise (`world/terrain.ts:65-84`): the wandering banks
function hash2(x: number, y: number): number {
  let h = Math.imul(x | 0, 374_761_393) ^ Math.imul(y | 0, 668_265_263);
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
  return ((h ^ (h >>> 16)) >>> 0) / 2_147_483_648 - 1;
}
function valueNoise(x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0), b = hash2(x0 + 1, y0), c = hash2(x0, y0 + 1), d = hash2(x0 + 1, y0 + 1);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}
/** `world/terrain.ts:45`. */
const influence = (u: number) => u * u * (3 - 2 * u);
/** A rough river dab's reach at a point (`world/terrain.ts:251-252`). */
const roughReach = (x: number, z: number, radius = RIVER_RADIUS) => {
  const lobe = radius * 0.6;
  return radius * (ROUGH_REACH_MIN + (1 - ROUGH_REACH_MIN) * (0.5 + 0.5 * valueNoise(x / lobe + 23.9, z / lobe + 31.4)));
};
/** The bed's section, 1 on the floor to 0 at the reach (`world/terrain.ts:272`). */
const bedProfile = (d: number, reach: number) => influence(Math.min(1, (1 - d / reach) / RIVER_BED_FLOOR));

/** The river's course: z of its middle at x. */
export const courseZ = (x: number, seed: number) => 900 * fbm(x / 4000, 0.5, seed + 31, 2) + 600 * Math.sin(x / 2300);

/** The land before the river and lakes cut it: broad hills, the river's valley, ranges at the map's edge. */
function land(x: number, z: number, seed: number): number {
  // broad, gentle hills, good for a city
  let h = 18 + 30 * fbm(x / 2600, z / 2600, seed, 4);
  h += 6 * fbm(x / 520, z / 520, seed + 7, 3);
  // the valley the river runs in, its floor raised where low so the water stands above the sea
  const valley = Math.min(1, Math.abs(z - courseZ(x, seed)) / 380);
  const open = valley * valley;
  h = h * (0.25 + 0.75 * open);
  if (h < VALLEY_FLOOR) h += (VALLEY_FLOOR - h) * (1 - open);
  // the basins the lakes fill: soft bowls with a wandering outline
  for (const [bx, bz] of basinsNear(x, z, seed)) {
    const d = Math.hypot(x - bx, z - bz);
    if (d >= BASIN_RADIUS * 1.4) continue;
    const r = BASIN_RADIUS * (1 + 0.38 * valueNoise(x / 95 + bx * 0.01, z / 95 - bz * 0.01));
    const t = Math.min(1, d / r);
    h -= BASIN_DEPTH * (1 - t * t) * (1 - t * t);
  }
  // ranges along the map's edges, with a pass where the river comes in and goes out
  const edge = Math.max(Math.abs(x), Math.abs(z)) / MAP_HALF;
  if (edge > 0.82) {
    const t = (edge - 0.82) / 0.18;
    h += t * t * (90 + 70 * fbm(x / 700, z / 700, seed + 99, 4)) * open;
  }
  return h;
}

/** A lake: the water filling a basin of the land, at one level, as water-grid samples (made when first asked). */
interface Lake { level: number; flooded: Map<number, number> }
interface Plan {
  /** Per 8 m of x from the map's west edge: the river's middle, its water level and its depth over the floor. */
  z: Float32Array; level: Float32Array; depth: Float32Array;
  lakes: Map<number, Lake | null>;
}
const plans = new Map<number, Plan>();

/** The river's level along its course (computed once per seed: 8 m steps across the map). */
function plan(seed: number): Plan {
  let p = plans.get(seed);
  if (p) return p;
  const n = Math.ceil(MAP_HALF * 2 / WATER_SPACING) + 1;
  const z = new Float32Array(n), level = new Float32Array(n), depth = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * WATER_SPACING - MAP_HALF, zc = courseZ(x, seed);
    // the LOWEST bank round the dab, and the bed cut into the land at its middle (4.0 render/terrain.ts:1772-1779)
    let bank = land(x, zc, seed);
    for (let k = 0; k < 8; k++) {
      const a = k / 8 * Math.PI * 2;
      bank = Math.min(bank, land(x + Math.cos(a) * RIVER_RADIUS, zc + Math.sin(a) * RIVER_RADIUS, seed));
    }
    const bed = land(x, zc, seed) - BED_CARVE;
    z[i] = zc;
    level[i] = bank - Math.max(WATER_MARGIN, WATER_FILL * (bank - bed));
    depth[i] = Math.max(RIVER_MIN_DEPTH, level[i] - bed);
  }
  // smoothed along the course (4.0 render/terrain.ts:2566-2568)
  for (let pass = 0; pass < 4; pass++) for (let i = 1; i + 1 < n; i++) level[i] = (level[i - 1] + level[i] * 2 + level[i + 1]) / 4;
  // downstream from the higher end (4.0 :2545-2547); then it only falls, at least MIN_FALL, never down to the sea
  const third = Math.max(1, Math.floor(n / 3));
  let head = 0, tail = 0;
  for (let i = 0; i < third; i++) { head += level[i]; tail += level[n - 1 - i]; }
  const step = MIN_FALL * WATER_SPACING;
  const fall = (i: number, prev: number) => { level[i] = Math.max(SEA_LEVEL + 1, Math.min(level[i], prev - step)); };
  if (head >= tail) for (let i = 1; i < n; i++) fall(i, level[i - 1]);
  else for (let i = n - 2; i >= 0; i--) fall(i, level[i + 1]);
  p = { z, level, depth, lakes: new Map() };
  plans.set(seed, p);
  return p;
}

/** The river at (x, z): its level, the floor's height and the bed's section there (0 off the bed). */
function riverAt(x: number, z: number, seed: number): { level: number; floor: number; section: number; d: number; reach: number } {
  const P = plan(seed), f = Math.min(P.z.length - 1.001, Math.max(0, (x + MAP_HALF) / WATER_SPACING));
  const i = Math.floor(f), t = f - i;
  const zc = P.z[i] + (P.z[i + 1] - P.z[i]) * t;
  const level = P.level[i] + (P.level[i + 1] - P.level[i]) * t;
  const depth = P.depth[i] + (P.depth[i + 1] - P.depth[i]) * t;
  // across the course, not along z: the course's slope shortens the distance
  const slope = (P.z[i + 1] - P.z[i]) / WATER_SPACING;
  const d = Math.abs(z - zc) / Math.sqrt(1 + slope * slope);
  const reach = roughReach(x, z);
  return { level, floor: level - depth, section: d < reach ? bedProfile(d, reach) : 0, d, reach };
}

/**
 * The lake of a grid square: the water of its basin, as 4.0's flood (render/terrain.ts:2338-2401) fills a hollow: from
 * the basin's lowest sample the water rises, lowest ground first, until it would spill over the rim (or reaches 4.0's
 * most, 40 000 cells of 1.6 m). It stands at the rim less 4.0's share of the depth (:1797: the rim − max(0.16,
 * 0.45 × depth)), and covers the ground under that level joined to the bottom: a shore that follows the land.
 */
function lakeOf(i: number, j: number, seed: number): Lake | null {
  const P = plan(seed), key = (i + 512) * 1024 + (j + 512);
  if (P.lakes.has(key)) return P.lakes.get(key)!;
  let lake: Lake | null = null;
  const b = basinOf(i, j, seed);
  if (b) {
    const at = (g: number) => g * WATER_SPACING - MAP_HALF;
    const hOf = (gx: number, gz: number) => baseHeight(at(gx), at(gz), seed);
    // the bottom: down the steepest way from the basin's middle
    let gx = Math.round((b[0] + MAP_HALF) / WATER_SPACING), gz = Math.round((b[1] + MAP_HALF) / WATER_SPACING);
    for (let moved = true, k = 0; moved && k < 200; k++) {
      moved = false;
      let best = hOf(gx, gz), bx = gx, bz = gz;
      for (const [dx, dz] of N8) { const v = hOf(gx + dx, gz + dz); if (v < best) { best = v; bx = gx + dx; bz = gz + dz; } }
      if (bx !== gx || bz !== gz) { gx = bx; gz = bz; moved = true; }
    }
    // priority flood: a binary heap of samples by height
    const kOf = (x: number, z: number) => z * 65_536 + x;
    const heap: number[] = [], hh: number[] = [], seen = new Set<number>();
    const push = (x: number, z: number) => {
      const k = kOf(x, z);
      if (seen.has(k)) return;
      seen.add(k);
      let n = heap.length; heap.push(k); hh.push(hOf(x, z));
      while (n > 0) { const p = (n - 1) >> 1; if (hh[p] <= hh[n]) break; [heap[p], heap[n]] = [heap[n], heap[p]]; [hh[p], hh[n]] = [hh[n], hh[p]]; n = p; }
    };
    const pop = (): [number, number] => {
      const k = heap[0], h = hh[0], lk = heap.pop()!, lh = hh.pop()!;
      if (heap.length) {
        heap[0] = lk; hh[0] = lh;
        for (let n = 0; ;) {
          const l = n * 2 + 1, r = l + 1;
          let m = n;
          if (l < heap.length && hh[l] < hh[m]) m = l;
          if (r < heap.length && hh[r] < hh[m]) m = r;
          if (m === n) break;
          [heap[m], heap[n]] = [heap[n], heap[m]]; [hh[m], hh[n]] = [hh[n], hh[m]]; n = m;
        }
      }
      return [k, h];
    };
    const bottom = hOf(gx, gz);
    let rim = bottom, filled = 0;
    push(gx, gz);
    while (heap.length && filled < MAX_FLOOD * 2) {
      const [k, h] = pop();
      // lower than the water reached so far: past the rim, the water would run out here
      if (h < rim - TERRAIN_WATER_HEIGHT) break;
      rim = Math.max(rim, h);
      filled++;
      const x = k % 65_536, z = Math.floor(k / 65_536);
      for (const [dx, dz] of N4) push(x + dx, z + dz);
    }
    const level = rim - Math.max(WATER_MARGIN, WATER_FILL * (rim - bottom));
    if (level - bottom > 1 && level > SEA_LEVEL + 1) {
      // the water: the ground under the level joined to the bottom (4.0 :2368-2392), at most 4.0's flood
      const W = new Map<number, number>([[kOf(gx, gz), level]]);
      const queue = [gx, gz];
      for (let head = 0; head < queue.length && W.size < MAX_FLOOD; head += 2) {
        const x = queue[head], z = queue[head + 1];
        for (const [dx, dz] of N4) {
          const nx = x + dx, nz = z + dz, k = kOf(nx, nz);
          if (W.has(k) || hOf(nx, nz) >= level - TERRAIN_WATER_HEIGHT) continue;
          W.set(k, level); queue.push(nx, nz);
        }
      }
      // and one sample past it all round (its shore: the water's mesh reaches the bank under it)
      for (const k of [...W.keys()]) {
        const x = k % 65_536, z = Math.floor(k / 65_536);
        for (const [dx, dz] of N8) if (!W.has(kOf(x + dx, z + dz))) W.set(kOf(x + dx, z + dz), level);
      }
      lake = { level, flooded: W };
    }
  }
  P.lakes.set(key, lake);
  return lake;
}
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

/** The lakes whose water could reach (x, z) (their square and the 8 round it). */
function lakesNear(x: number, z: number, seed: number): Lake[] {
  const i0 = Math.floor(x / LAKE_GRID), j0 = Math.floor(z / LAKE_GRID), out: Lake[] = [];
  for (let j = j0 - 1; j <= j0 + 1; j++) for (let i = i0 - 1; i <= i0 + 1; i++) { const l = lakeOf(i, j, seed); if (l) out.push(l); }
  return out;
}

/** Ground height at (x, z): the land (with the lakes' basins), cut by the river's bed. */
export function baseHeight(x: number, z: number, seed: number): number {
  let h = land(x, z, seed);
  const r = riverAt(x, z, seed);
  // the bed: from the land down to the floor by the bed's section (4.0 world/terrain.ts:272-277), never raised
  if (r.section > 0 && h > r.floor) h -= (h - r.floor) * r.section;
  return Math.min(TERRAIN_MAX_Y, Math.max(TERRAIN_MIN_Y, h));
}

/** The water's level at the water-grid sample (gx, gz) (river or lake), or NO_WATER. */
function waterAtSample(gx: number, gz: number, seed: number): number {
  const x = gx * WATER_SPACING - MAP_HALF, z = gz * WATER_SPACING - MAP_HALF;
  const r = riverAt(x, z, seed);
  // the river's water reaches a sample past the bed's edge (the bank hides it; the shader fades the rim)
  if (r.d < r.reach + WATER_SPACING) return r.level;
  let best = NO_WATER;
  for (const l of lakesNear(x, z, seed)) {
    const v = l.flooded.get(gz * 65_536 + gx);
    if (v !== undefined && v > best) best = v;
  }
  return best;
}

/** The generated water's level at (x, z) (the nearest water sample), or NO_WATER: for the city's generator. */
export function waterLevelAt(x: number, z: number, seed: number): number {
  return waterAtSample(Math.round((x + MAP_HALF) / WATER_SPACING), Math.round((z + MAP_HALF) / WATER_SPACING), seed);
}

/** Writes tile `tile`'s heights (and, given the water buffer, its river and lakes); its height range and if it has water. */
export function generateTerrainTile(heights: Float32Array, tile: number, seed: number, water?: Float32Array): { min: number; max: number; hasWater: boolean } {
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
  let hasWater = false;
  if (water) {
    for (let j = 0; j < WATER_TILE_RES; j++) for (let i = 0; i < WATER_TILE_RES; i++) {
      const gx = tx * WATER_TILE_RES + i, gz = tz * WATER_TILE_RES + j;
      const v = waterAtSample(gx, gz, seed);
      water[waterIndex(gx, gz)] = v;
      if (v !== NO_WATER) hasWater = true;
    }
  }
  return { min, max, hasWater };
}

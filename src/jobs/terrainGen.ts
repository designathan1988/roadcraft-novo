// The base relief of a tile, written straight into the shared height buffer, with the generated river and lakes in
// the shared water buffer. Deterministic from the seed: the same map on any machine.
//
// The river is a river as Roadcraft 4.0 draws one with its brush at the default size (`main.ts:372-373`: radius 80 m,
// strength 24): a bed with a flat floor and ramped banks that wander in and out (`world/terrain.ts:249-277`), its
// water down from the lowest bank (`render/terrain.ts:1772-1779`), smoothed along the course and never dry
// (`render/terrain.ts:2566-2574`). Here its level also only falls downstream (the water shader reads the current
// from the level's slope). Lakes are 4.0's single river dabs: a carved hollow whose water floods the basin round it,
// a basin too big to be one withdrawn to its shore (`render/terrain.ts:2338-2401`).

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
/** `render/terrain.ts:83-89`: water disc share, spread past the brush, share of the channel filled, rim margin. */
const WATER_RADIUS = 0.92, WATER_SPREAD = 1.6, WATER_FILL = 0.45, WATER_MARGIN = 0.16;
/** `render/terrain.ts:2536`: the least water over a river's bed. */
const RIVER_MIN_DEPTH = 0.5;
/** `world/terrain.ts:40`: what counts as wet. */
const TERRAIN_WATER_HEIGHT = 0.048;
/** `render/terrain.ts:2339`, `:2343`: 40 000 cells of 1.6 m flood at most (here in 8 m samples), else only a 6-cell shore stays. */
const MAX_FLOOD = Math.round(40_000 * 1.6 * 1.6 / (WATER_SPACING * WATER_SPACING));
const SHORE_BAND = Math.max(1, Math.round(6 * 1.6 / WATER_SPACING));

/** The least height of the river valley's floor (it was 2-7 m up: 4.0's water, 6.6 m under the banks, was under the sea). */
const VALLEY_FLOOR = 12;
/** The least fall of the river's level, per metre (0.3 m/km: the water shader reads the current from it). */
const MIN_FALL = 0.0003;
/** Lakes: one candidate per square of this side. */
const LAKE_GRID = 2200;

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
  // ranges along the map's edges, with a pass where the river comes in and goes out
  const edge = Math.max(Math.abs(x), Math.abs(z)) / MAP_HALF;
  if (edge > 0.82) {
    const t = (edge - 0.82) / 0.18;
    h += t * t * (90 + 70 * fbm(x / 700, z / 700, seed + 99, 4)) * open;
  }
  return h;
}

/** A lake: a few overlapping river dabs (x, z, radius each), as a player paints one, at one level. */
interface Lake { dabs: Array<[number, number, number]>; level: number; flooded: Map<number, number> | null }
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

/** The lake of a grid square, if it has one (a hollow away from the river and the edges), with its level. */
function lakeOf(i: number, j: number, seed: number): Lake | null {
  const P = plan(seed), key = (i + 512) * 1024 + (j + 512);
  if (P.lakes.has(key)) return P.lakes.get(key)!;
  let lake: Lake | null = null;
  // the most hollow of 5 × 5 spots in the square's middle (lower than the ring 250 m round it), if it is one
  const ringOf = (x: number, z: number) => {
    let ring = 0;
    for (let k = 0; k < 8; k++) { const a = k / 8 * Math.PI * 2; ring += land(x + Math.cos(a) * 250, z + Math.sin(a) * 250, seed) / 8; }
    return ring;
  };
  let x = 0, z = 0, best = Infinity;
  for (let v = 0; v < 5; v++) for (let u = 0; u < 5; u++) {
    const px = (i + 0.2 + 0.15 * u) * LAKE_GRID, pz = (j + 0.2 + 0.15 * v) * LAKE_GRID;
    if (Math.max(Math.abs(px), Math.abs(pz)) / MAP_HALF > 0.74 || riverAt(px, pz, seed).d < 600) continue;
    const h = land(px, pz, seed), k = h - ringOf(px, pz);
    if (k < best) { best = k; x = px; z = pz; }
  }
  if (best < -1) {
    // the dabs: one on the hollow, 2-3 more overlapping it (35-60 m off, 65-80 m wide), one body with a lobed shore
    const r = (k: number) => 0.5 + 0.5 * hash2(i * 7 + k + seed * 13, j * 11 - k);
    const dabs: Array<[number, number, number]> = [[x, z, RIVER_RADIUS]];
    const more = 2 + (r(1) < 0.5 ? 1 : 0), a0 = r(2) * Math.PI * 2;
    for (let k = 0; k < more; k++) {
      const a = a0 + k * (Math.PI * 2 / more) + (r(3 + k) - 0.5), d = 35 + 25 * r(6 + k);
      dabs.push([x + Math.cos(a) * d, z + Math.sin(a) * d, 65 + 15 * r(9 + k)]);
    }
    // 4.0 render/terrain.ts:1790-1798, per dab: the level down from its lowest bank, its bed cut at its middle; the
    // lake stands at the lowest of them
    let level = Infinity;
    for (const [dx, dz, dr] of dabs) {
      const c = land(dx, dz, seed);
      let bank = c;
      for (let k = 0; k < 8; k++) { const a = k / 8 * Math.PI * 2; bank = Math.min(bank, land(dx + Math.cos(a) * dr, dz + Math.sin(a) * dr, seed)); }
      const bed = c - BED_CARVE * dr / RIVER_RADIUS;
      level = Math.min(level, bank - Math.max(WATER_MARGIN, WATER_FILL * (bank - bed)));
    }
    if (level > SEA_LEVEL + 1) lake = { dabs, level, flooded: null };
  }
  P.lakes.set(key, lake);
  return lake;
}

/** The lakes whose water could reach (x, z) (their square and the 8 round it). */
function lakesNear(x: number, z: number, seed: number): Lake[] {
  const i0 = Math.floor(x / LAKE_GRID), j0 = Math.floor(z / LAKE_GRID), out: Lake[] = [];
  for (let j = j0 - 1; j <= j0 + 1; j++) for (let i = i0 - 1; i <= i0 + 1; i++) { const l = lakeOf(i, j, seed); if (l) out.push(l); }
  return out;
}

/** Ground height at (x, z): the land, cut by the river's bed and the lakes' hollows. */
export function baseHeight(x: number, z: number, seed: number): number {
  let h = land(x, z, seed);
  const r = riverAt(x, z, seed);
  // the bed: from the land down to the floor by the bed's section (4.0 world/terrain.ts:272-277), never raised
  if (r.section > 0 && h > r.floor) h -= (h - r.floor) * r.section;
  for (const l of lakesNear(x, z, seed)) {
    // a stroke's dabs move the ground by the most of them, not the sum (4.0 world/terrain.ts:279-283)
    let low = h;
    for (const [dx, dz, dr] of l.dabs) {
      const d = Math.hypot(x - dx, z - dz), reach = roughReach(x, z, dr);
      if (d >= reach) continue;
      const floor = land(dx, dz, seed) - BED_CARVE * dr / RIVER_RADIUS;
      if (h > floor) low = Math.min(low, h - (h - floor) * bedProfile(d, reach));
    }
    h = low;
  }
  return Math.min(TERRAIN_MAX_Y, Math.max(TERRAIN_MIN_Y, h));
}

/** A lake's water: its disc and the basin it floods, as water-grid samples → level (computed once per lake). */
function lakeWater(l: Lake, seed: number): Map<number, number> {
  if (l.flooded) return l.flooded;
  const W = new Map<number, number>();
  const key = (gx: number, gz: number) => gz * 65_536 + gx;
  const at = (g: number) => g * WATER_SPACING - MAP_HALF;
  // the discs: every sample within the spread of a dab (4.0 render/terrain.ts:2416-2441)
  const queue: number[] = [];
  for (const [dx, dz, dr] of l.dabs) {
    const reach = dr * WATER_RADIUS * WATER_SPREAD;
    const g0x = Math.floor((dx - reach + MAP_HALF) / WATER_SPACING), g1x = Math.ceil((dx + reach + MAP_HALF) / WATER_SPACING);
    const g0z = Math.floor((dz - reach + MAP_HALF) / WATER_SPACING), g1z = Math.ceil((dz + reach + MAP_HALF) / WATER_SPACING);
    for (let gz = g0z; gz <= g1z; gz++) for (let gx = g0x; gx <= g1x; gx++) {
      if (W.has(key(gx, gz)) || Math.hypot(at(gx) - dx, at(gz) - dz) >= reach) continue;
      W.set(key(gx, gz), l.level); queue.push(gx, gz);
    }
  }
  // the flood, breadth first from the disc's whole edge into ground under the level (4.0 :2368-2392)
  const steps = new Map<number, number>(), added: number[] = [];
  let overflow = false;
  for (let head = 0; head < queue.length && !overflow; head += 2) {
    const gx = queue[head], gz = queue[head + 1], out = steps.get(key(gx, gz)) ?? 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = gx + dx, nz = gz + dz, k = key(nx, nz);
      if (W.has(k) || baseHeight(at(nx), at(nz), seed) >= l.level - TERRAIN_WATER_HEIGHT) continue;
      W.set(k, l.level); steps.set(k, out + 1); added.push(k); queue.push(nx, nz);
      if (added.length > MAX_FLOOD) { overflow = true; break; }
    }
  }
  // open country is not a basin: that flood is withdrawn but for the shore (4.0 :2393-2395)
  if (overflow) for (const k of added) if ((steps.get(k) ?? 0) > SHORE_BAND) W.delete(k);
  l.flooded = W;
  return W;
}

/** The water's level at the water-grid sample (gx, gz) (river or lake), or NO_WATER. */
function waterAtSample(gx: number, gz: number, seed: number): number {
  const x = gx * WATER_SPACING - MAP_HALF, z = gz * WATER_SPACING - MAP_HALF;
  const r = riverAt(x, z, seed);
  // the river's water reaches a sample past the bed's edge (the bank hides it; the shader fades the rim)
  if (r.d < r.reach + WATER_SPACING) return r.level;
  let best = NO_WATER;
  for (const l of lakesNear(x, z, seed)) {
    const v = lakeWater(l, seed).get(gz * 65_536 + gx);
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

/// <reference types="node" />
// Grows a city in Node the way Game.generatedCity does (src/game.ts:1835-1903): terrain per tile, the city's roads,
// the terrain conformed to them, lots per cell (jobs/lots.ts) and every lot filled (Growth.fillAll). Read-only use of
// the game's modules; nothing is written into the game.
import { World } from '../../../src/world/world.ts';
import { generateTerrainTile, FLAT_BIT } from '../../../src/jobs/terrainGen.ts';
import { generateCity } from '../../../src/jobs/cityGen.ts';
import { conformTile } from '../../../src/jobs/conform.ts';
import { buildLots } from '../../../src/jobs/lots.ts';
import { Growth } from '../../../src/world/growth.ts';
import { PROFILE_INFO } from '../../../src/roads/profiles.ts';
import { FOOTWAY_RISE, edgeRise } from '../../../src/roads/kerb.ts';
import { bulbAt } from '../../../src/roads/build.ts';
import { BULB_R, BULB_WALK } from '../../../src/roads/junction.ts';
import { CELL_SIZE, MAP_CELLS, MAP_TILES, TILE_SIZE } from '../../../src/config.ts';
import { TILE_COUNT, cellOriginX, tileId, tileX, Dirty } from '../../../src/core/grid.ts';
import type { JobPool } from '../../../src/jobs/pool.ts';
import type { CityStyle } from '../../../src/jobs/cityField.ts';

export interface GrownCity { w: World; seed: number; style: CityStyle; medium: boolean; buildings: number; segs: number; ms: number }

export function growCity(seed: number, style: CityStyle = 'classic', medium = false): GrownCity {
  const t0 = performance.now();
  const w = new World();
  w.seed = (medium ? seed | FLAT_BIT : seed & ~FLAT_BIT) >>> 0;
  for (let t = 0; t < TILE_COUNT; t++) {
    const r = generateTerrainTile(w.heights, t, w.seed, w.water);
    w.tileMin[t] = r.min; w.tileMax[t] = r.max;
  }
  const city = generateCity(w.seed, style, medium);
  const ids: number[] = [];
  for (let i = 0; i < city.nodes.length; i += 3) ids.push(w.roads.addNode({ x: city.nodes[i], z: city.nodes[i + 1], y: city.nodes[i + 2] }));
  const nc = w.roads.nodes.cols;
  const perTile: number[][] = Array.from({ length: TILE_COUNT }, () => []);
  for (let k = 0; k < city.segs.length; k += 5) {
    const a = ids[city.segs[k]], b = ids[city.segs[k + 1]], profile = city.segs[k + 2];
    const mx = (nc.x[a] + nc.x[b]) / 2, mz = (nc.z[a] + nc.z[b]) / 2;
    try { w.roads.addSeg({ a, b, cx: mx, cz: mz, profile, flags: 0, zl: city.segs[k + 3], zr: city.segs[k + 4] }); } catch { continue; }
    const half = PROFILE_INFO[profile].right;
    const rec = [nc.x[a], nc.z[a], nc.y[a], nc.x[b], nc.z[b], nc.y[b], half, edgeRise(profile, true), edgeRise(profile, false)];
    const r = half + 8;
    const tx0 = tileX(Math.min(nc.x[a], nc.x[b]) - r), tx1 = tileX(Math.max(nc.x[a], nc.x[b]) + r);
    const tz0 = tileX(Math.min(nc.z[a], nc.z[b]) - r), tz1 = tileX(Math.max(nc.z[a], nc.z[b]) + r);
    for (let tz = tz0; tz <= tz1; tz++) for (let tx = tx0; tx <= tx1; tx++) perTile[tileId(tx, tz)].push(...rec);
  }
  for (const n of ids) {
    if (!bulbAt(w.roads, n)) continue;
    const half = BULB_R + BULB_WALK, r = half + 8;
    const rec = [nc.x[n], nc.z[n], nc.y[n], nc.x[n], nc.z[n], nc.y[n], half, FOOTWAY_RISE, FOOTWAY_RISE];
    for (let tz = tileX(nc.z[n] - r); tz <= tileX(nc.z[n] + r); tz++) for (let tx = tileX(nc.x[n] - r); tx <= tileX(nc.x[n] + r); tx++) perTile[tileId(tx, tz)].push(...rec);
  }
  perTile.forEach((list, t) => {
    if (!list.length) return;
    const r = conformTile(w.heights, t, new Float32Array(list));
    w.tileMin[t] = r.min; w.tileMax[t] = r.max;
  });
  // lots per dirty cell, computed here instead of in the pool (test/growth.test.ts growthOf does the same)
  const g = new Growth(w, null as unknown as JobPool);
  const G = g as unknown as { setLots(c: number, l: unknown): void };
  const cells = w.dirty.drain(Dirty.Lots);
  for (const c of cells) {
    const x0 = cellOriginX(c % MAP_CELLS), z0 = cellOriginX((c / MAP_CELLS) | 0);
    const segs: number[] = [];
    w.roads.forSegsNear(x0 - 160, z0 - 160, x0 + CELL_SIZE + 160, z0 + CELL_SIZE + 160, (s) => segs.push(s));
    if (segs.length) G.setLots(c, buildLots(w.heights, w.roads.gather(segs, []), c, w.water));
  }
  const buildings = g.fillAll();
  return { w, seed, style, medium, buildings, segs: w.roads.segs.size, ms: performance.now() - t0 };
}

export const MAP = { tiles: MAP_TILES, tileSize: TILE_SIZE, cells: MAP_CELLS, cellSize: CELL_SIZE };

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const seed = Number(process.argv[2] ?? 20261030), style = (process.argv[3] ?? 'classic') as CityStyle;
  const c = growCity(seed, style, process.argv.includes('--medium'));
  console.log(JSON.stringify({ seed: c.seed, style: c.style, medium: c.medium, buildings: c.buildings, segs: c.segs, s: +(c.ms / 1000).toFixed(1), map: MAP }));
}

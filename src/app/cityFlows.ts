// The flows that replace the city on screen with a new one: forgetting the current city, the generated city (terrain,
// the street grid from its worker, the terrain conformed per tile, lots and buildings) and the worst-case test city.
// The page's parts it clears and the loading screen it shows are reached through CityFlowHost.

import { MAP_TILES, TILE_SIZE } from '../config.ts';
import type { Lifecycle } from './lifecycle.ts';
import { FLAT_BIT } from '../jobs/terrainGen.ts';
import { Dirty, TILE_COUNT, tileId, tileOriginX, tileX } from '../core/grid.ts';
import type { JobPool } from '../jobs/pool.ts';
import { lineProfile } from '../jobs/debugCity.ts';
import { BULB_R, BULB_WALK, bulbAt } from '../roads/junction.ts';
import { FOOTWAY_RISE, edgeRise } from '../roads/kerb.ts';
import { PROFILE_INFO } from '../roads/profiles.ts';
import { Zone } from '../roads/zones.ts';
import { START_MONEY, type World } from '../world/world.ts';
import type { Hud } from '../ui/hud.ts';
import { fmtInt, t } from '../shared/i18n/index.ts';
import { achieve } from '../platform/steam.ts';

export interface CityFlowHost {
  readonly world: World;
  readonly pool: JobPool;
  readonly hud: Hud;
  /** The game's lifecycle (app/lifecycle.ts): a generation is its 'generating' operation. */
  readonly life: Lifecycle;
  /** Lets go of everything the page holds of the city on screen (lots under way, layers, props, wrecks, lines, history, clouds, sign texts). */
  clearPage(): void;
  /** The city on screen is not the one the save slot holds any more. */
  forgetSlot(): void;
  generateTerrain(): Promise<void>;
  /** Lots in the workers, then a building on every free lot; the buildings made. */
  grow(): Promise<number>;
  endRebuild(err: unknown, what: string): void;
}

export class CityFlows {
  private h: CityFlowHost;
  private terrain = false;
  /** True while the generated city's terrain is made and conformed (the frame loop leaves the growth alone). */
  get terrainUnderway(): boolean { return this.terrain; }

  constructor(host: CityFlowHost) { this.h = host; }

  /** Forgets the current city (roads, buildings, lines, history): a new one starts with a new id. */
  reset(): void {
    const w = this.h.world;
    w.clearBuildings();
    w.items.clear();
    w.clearGround();
    w.roads.clear();
    this.h.clearPage();
    w.signTexts.clear(); w.streetNames.clear();
    w.money = START_MONEY;
    // another city: nothing of it is in the save yet, and it is not the city the slot holds
    w.tileInSave.fill(0);
    this.h.forgetSlot();
    w.gameId = (Math.random() * 2 ** 32) >>> 0;
  }

  /** The whole city from the seed: terrain again, roads in a worker, terrain conformed per tile in parallel, lots and buildings. */
  async generated(medium = false): Promise<void> {
    const h = this.h, w = h.world;
    if (!h.life.begin('generating')) return;
    // the medium town is laid on a level plain (Roadcraft 2.0's flat map); the whole map keeps its relief
    w.seed = (medium ? w.seed | FLAT_BIT : w.seed & ~FLAT_BIT) >>> 0;
    const t0 = performance.now();
    const phase = (name: string) => console.log(`phase: ${name} ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    h.hud.showLoading(t('game.loading.city'));
    try {
      this.reset();
      this.terrain = true;
      await h.generateTerrain();
      phase('terrain');
      const city = await h.pool.run('cityGen', { seed: w.seed, medium }, { priority: 0 });
      phase('street grid');
      h.hud.showLoading(t('game.loading.roads'));
      const ids: number[] = [];
      for (let i = 0; i < city.nodes.length; i += 3) ids.push(w.roads.addNode({ x: city.nodes[i], z: city.nodes[i + 1], y: city.nodes[i + 2] }));
      const nc = w.roads.nodes.cols;
      const perTile: number[][] = Array.from({ length: TILE_COUNT }, () => []);
      for (let k = 0; k < city.segs.length; k += 5) {
        const a = ids[city.segs[k]], b = ids[city.segs[k + 1]], profile = city.segs[k + 2];
        const mx = (nc.x[a] + nc.x[b]) / 2, mz = (nc.z[a] + nc.z[b]) / 2;
        try {
          w.roads.addSeg({ a, b, cx: mx, cz: mz, profile, flags: 0, zl: city.segs[k + 3], zr: city.segs[k + 4] });
        } catch { continue; }
        // the straight segment the terrain is conformed to, in every tile it touches
        const half = PROFILE_INFO[profile].right;
        const rec = [nc.x[a], nc.z[a], nc.y[a], nc.x[b], nc.z[b], nc.y[b], half, edgeRise(profile, true), edgeRise(profile, false)];
        const r = half + 8;
        const tx0 = tileX(Math.min(nc.x[a], nc.x[b]) - r), tx1 = tileX(Math.max(nc.x[a], nc.x[b]) + r);
        const tz0 = tileX(Math.min(nc.z[a], nc.z[b]) - r), tz1 = tileX(Math.max(nc.z[a], nc.z[b]) + r);
        for (let tz = tz0; tz <= tz1; tz++) for (let tx = tx0; tx <= tx1; tx++) perTile[tileId(tx, tz)].push(...rec);
      }
      // dead ends with a turning bulb: a disc when conforming the terrain (its footway ring ends at BULB_R + BULB_WALK)
      for (const n of ids) {
        if (!bulbAt(w.roads, n)) continue;
        const half = BULB_R + BULB_WALK, r = half + 8;
        const rec = [nc.x[n], nc.z[n], nc.y[n], nc.x[n], nc.z[n], nc.y[n], half, FOOTWAY_RISE, FOOTWAY_RISE];
        for (let tz = tileX(nc.z[n] - r); tz <= tileX(nc.z[n] + r); tz++) for (let tx = tileX(nc.x[n] - r); tx <= tileX(nc.x[n] + r); tx++) perTile[tileId(tx, tz)].push(...rec);
      }
      phase('roads inserted');
      await Promise.all(perTile.map(async (list, tile) => {
        if (!list.length) return;
        const segs = new Float32Array(list);
        const r = await h.pool.run('conform', { tile, segs }, { priority: 0, transfer: [segs.buffer] });
        w.tileMin[r.tile] = r.min; w.tileMax[r.tile] = r.max;
        w.layerDirty.add(r.tile);
        const tx = r.tile % MAP_TILES, tz = (r.tile / MAP_TILES) | 0;
        w.touchRect(tileOriginX(tx), tileOriginX(tz), tileOriginX(tx) + TILE_SIZE - 1, tileOriginX(tz) + TILE_SIZE - 1, Dirty.Terrain);
      }));
      this.terrain = false;
      phase('terrain conformed');
      h.hud.showLoading(t('game.loading.lots'));
      const n = await h.grow();
      phase('lots and buildings');
      h.endRebuild(null, '');
      achieve('CIDADE_GERADA');
      const secs = ((performance.now() - t0) / 1000).toFixed(0);
      h.hud.toast(t('game.toast.generated', { secs, buildings: fmtInt(n), roads: fmtInt(w.roads.segs.size) }));
    } catch (err) {
      this.terrain = false;
      h.endRebuild(err, t('game.flow.generate'));
    }
  }

  /** Worst case: fills the map with zoned streets and lets buildings grow on every lot. */
  async testCity(): Promise<void> {
    const h = this.h, w = h.world;
    if (!h.life.begin('generating')) return;
    h.hud.toast(t('game.toast.testCity'));
    try {
      this.reset();
      const nodes: Float32Array[] = [], segs: Int32Array[] = [];
      await Promise.all(Array.from({ length: TILE_COUNT }, async (_, tile) => {
        const r = await h.pool.run('debugTile', { seed: w.seed, tile }, { priority: 1 });
        // the tile's terrain is made again here: its range is its own (never widened by the previous map's)
        w.tileMin[r.tile] = r.min;
        w.tileMax[r.tile] = r.max;
        w.layerDirty.add(r.tile);
        nodes.push(r.roadNodes); segs.push(r.roadSegs);
      }));
      // streets: all the nodes first, then the segments (which may link tiles)
      const key = new Map<number, number>();
      for (const a of nodes) for (let k = 0; k < a.length; k += 5) key.set(a[k] * 1000 + a[k + 1], w.roads.addNode({ x: a[k + 2], z: a[k + 3], y: a[k + 4] }));
      const nc = w.roads.nodes.cols;
      for (const a of segs) for (let k = 0; k < a.length; k += 4) {
        const na = key.get(a[k] * 1000 + a[k + 1]), nb = key.get(a[k + 2] * 1000 + a[k + 3]);
        if (na === undefined || nb === undefined) continue;
        const mx = (nc.x[na] + nc.x[nb]) / 2, mz = (nc.z[na] + nc.z[nb]) / 2;
        const r = Math.hypot(mx, mz);
        const zone = r < 1300 ? Zone.Commercial : r < 2600 ? Zone.Mixed : mx > 2800 ? Zone.Industrial : Zone.Residential;
        // a horizontal segment (same j) follows line j; a vertical one, line i
        const profile = a[k + 1] === a[k + 3] ? lineProfile(a[k + 1]) : lineProfile(a[k]);
        w.roads.addSeg({ a: na, b: nb, cx: mx, cz: mz, profile, flags: 0, zl: zone, zr: zone });
      }
      const n = await h.grow();
      h.endRebuild(null, '');
      h.hud.toast(t('game.toast.testCityDone', { buildings: fmtInt(n), roads: fmtInt(w.roads.segs.size) }));
    } catch (err) {
      h.endRebuild(err, t('game.flow.testCity'));
    }
  }
}

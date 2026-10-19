// Per-cell lots (built in the workers) and growth: buildings appear on their own
// in the free lots of the zones. Bounded, constant work per frame.

import { CELL_SIZE, MAP_CELLS } from '../config.ts';
import { CELL_COUNT, Dirty, cellId, cellOriginX, cellX } from '../core/grid.ts';
import { Rng } from '../core/rng.ts';
import type { JobPool } from '../jobs/pool.ts';
import { roadGraphTransfer, type LotColumns } from '../jobs/protocol.ts';
import { Zone, baseZone, zoneDensity } from '../roads/zones.ts';
import { PROFILE_INFO } from '../roads/profiles.ts';
import { Fn, archFor, civicFor, eraAt } from './arch.ts';
import { generatedBuilt } from './decay.ts';
import { LANDMARKS, encodeDesign } from './design.ts';
import { hash2 } from '../core/rng.ts';
import type { BuildingRec, World } from './world.ts';

/** Floors by zone and frontage road (avenues give taller buildings). */
export function floorsFor(zoneId: number, profile: number, r: Rng): number {
  const avenue = (PROFILE_INFO[profile]?.priority ?? 0) >= 2;
  const zone = baseZone(zoneId), dens = zoneDensity(zoneId);
  // low density: houses and townhouses; high: towers
  if (dens === 0) return zone === Zone.Residential ? r.int(1, 3) : r.int(1, 4);
  if (dens === 2) return zone === Zone.Residential ? r.int(8, avenue ? 26 : 18) : r.int(10, avenue ? 40 : 28);
  switch (zone) {
    case Zone.Residential: {
      if (avenue) return r.int(4, 15);
      const x = r.next();
      return x < 0.68 ? r.int(1, 3) : x < 0.94 ? r.int(3, 6) : r.int(6, 11);
    }
    case Zone.Commercial: return avenue ? r.int(5, 26) : r.int(2, 7);
    case Zone.Industrial: return r.int(1, 3);
    case Zone.Mixed: return avenue ? r.int(6, 15) : r.int(3, 9);
    default: return 1;
  }
}

export class Growth {
  private world: World;
  private pool: JobPool;
  private lots = new Map<number, LotColumns>();
  /** Cells with lots, to draw from without scanning the map. */
  private cells: number[] = [];
  private cellPos = new Int32Array(CELL_COUNT).fill(-1);
  private rng = new Rng(9182);
  private acc = 0;
  /** Buildings per second (0 = stopped). */
  rate = 25;

  constructor(world: World, pool: JobPool) {
    this.world = world;
    this.pool = pool;
  }

  /** Cells with dirty lots: requests their lots again. */
  processDirty(): void {
    const cells = this.world.dirty.drain(Dirty.Lots);
    const net = this.world.roads;
    for (const c of cells) {
      const x0 = cellOriginX(c % MAP_CELLS), z0 = cellOriginX((c / MAP_CELLS) | 0);
      const segs: number[] = [];
      net.forSegsNear(x0 - 160, z0 - 160, x0 + CELL_SIZE + 160, z0 + CELL_SIZE + 160, (s) => segs.push(s));
      if (segs.length === 0) { this.setLots(c, null); continue; }
      const graph = net.gather(segs, []);
      this.pool.submit('lots', { graph, cell: c }, (r) => this.setLots(r.cell, r.lots), {
        key: `lots:${c}`, priority: 2500, transfer: roadGraphTransfer(graph),
      });
    }
  }

  private setLots(c: number, lots: LotColumns | null): void {
    this.taken.delete(c);
    if (lots && lots.count > 0) {
      this.lots.set(c, lots);
      if (this.cellPos[c] < 0) { this.cellPos[c] = this.cells.length; this.cells.push(c); }
    } else {
      this.lots.delete(c);
      const i = this.cellPos[c];
      if (i >= 0) {
        const last = this.cells.pop()!;
        if (last !== c) { this.cells[i] = last; this.cellPos[last] = i; }
        this.cellPos[c] = -1;
      }
    }
  }

  lotsOf(c: number): LotColumns | undefined { return this.lots.get(c); }

  /** Does any building occupy the lot? */
  private occupied(l: LotColumns, i: number): boolean {
    const col = this.world.buildings.cols;
    const r = Math.max(l.w[i], l.d[i]) / 2;
    let hit = false;
    this.world.buildingIndex.query(l.x[i] - r - 20, l.z[i] - r - 20, l.x[i] + r + 20, l.z[i] + r + 20, (id) => {
      if (hit) return;
      const ro = Math.min(col.w[id], col.d[id]) / 2;
      if (Math.hypot(col.x[id] - l.x[i], col.z[id] - l.z[i]) < (Math.min(l.w[i], l.d[i]) / 2 + ro) * 0.8) hit = true;
    });
    return hit;
  }

  /** Where the last building grew: the next one is the free lot nearest it, so a street fills in sequence. */
  private last: { x: number; z: number } | null = null;
  /** Lots known to be taken (a hint per cell's lots; checked again before building). */
  private taken = new Map<number, Uint8Array>();

  /**
   * Grows buildings over time (Roadcraft growth): the next lot is the free one nearest the last that grew, in the
   * 3×3 cells around it; when none is left there, a lot anywhere. Bounded work per frame (`budget` tries).
   */
  step(dt: number, budget = 8): void {
    if (this.cells.length === 0 || this.rate <= 0) return;
    this.acc = Math.min(this.acc + dt * this.rate, 50);
    let tries = budget;
    while (this.acc >= 1 && tries-- > 0) {
      const next = this.last ? this.nearestFree(this.last.x, this.last.z) : null;
      if (next) { this.grow(next.l, next.i, true); continue; }
      const c = this.cells[this.rng.int(0, this.cells.length)];
      const l = this.lots.get(c)!;
      const i = this.rng.int(0, l.count);
      if (this.occupied(l, i)) { this.markTaken(c, i); continue; }
      this.grow(l, i, true);
    }
  }

  /** One frame of growth at the game's speed (0 = paused: nothing grows; 2× and 4× grow that much faster). */
  tick(dt: number, speed: number): void {
    if (!(speed > 0)) return;
    this.step(dt * speed, 8 * Math.ceil(speed));
  }

  private grow(l: LotColumns, i: number, organic: boolean): void {
    this.world.growBuilding(this.recordFor(l, i, organic));
    this.markTaken(cellId(cellX(l.x[i]), cellX(l.z[i])), i);
    this.last = { x: l.x[i], z: l.z[i] };
    this.acc -= 1;
  }

  private markTaken(c: number, i: number): void {
    const l = this.lots.get(c);
    if (!l) return;
    let t = this.taken.get(c);
    if (!t || t.length !== l.count) this.taken.set(c, (t = new Uint8Array(l.count)));
    t[i] = 1;
  }

  /** Free lot nearest (x, z) in the 3×3 cells around it (lots already seen taken are skipped), or null. */
  private nearestFree(x: number, z: number): { l: LotColumns; i: number } | null {
    const cx = cellX(x), cz = cellX(z);
    const cand: Array<[number, number, number]> = [];
    for (let j = cz - 1; j <= cz + 1; j++) for (let k = cx - 1; k <= cx + 1; k++) {
      if (j < 0 || k < 0 || j >= MAP_CELLS || k >= MAP_CELLS) continue;
      const c = cellId(k, j), l = this.lots.get(c);
      if (!l) continue;
      const t = this.taken.get(c);
      for (let i = 0; i < l.count; i++) if (!t || t.length !== l.count || !t[i]) cand.push([(l.x[i] - x) ** 2 + (l.z[i] - z) ** 2, c, i]);
    }
    cand.sort((a, b) => a[0] - b[0]);
    for (let k = 0; k < cand.length && k < 12; k++) {
      const [, c, i] = cand[k], l = this.lots.get(c)!;
      if (!this.occupied(l, i)) return { l, i };
      this.markTaken(c, i);
    }
    return null;
  }

  /** Cell of the neighbourhood (2×2 cells, 512 m) that holds its square: the first, in an order drawn by the
   * neighbourhood, whose biggest lot is big enough and not industrial. −1 when none. */
  private squareCell(cell: number): number {
    const bx = (cell % MAP_CELLS) >> 1, bz = ((cell / MAP_CELLS) | 0) >> 1;
    const h = hash2(bx, bz, 4242);
    for (let k = 0; k < 4; k++) {
      const q = (h + k) & 3, x = bx * 2 + (q & 1), z = bz * 2 + (q >> 1);
      if (x >= MAP_CELLS || z >= MAP_CELLS) continue;
      const c = cellId(x, z), l = this.lots.get(c);
      if (!l) continue;
      const b = Growth.biggest(l);
      if (l.w[b] * l.d[b] >= 500 && baseZone(l.zone[b]) !== Zone.Industrial) return c;
    }
    return -1;
  }

  private static biggest(l: LotColumns): number {
    let b = 0;
    for (let k = 0; k < l.count; k++) if (l.w[k] * l.d[k] > l.w[b] * l.d[b]) b = k;
    return b;
  }

  /**
   * Record of the building for lot i. One square per neighbourhood (Roadcraft), in the biggest lot of the cell the
   * neighbourhood draws; one other civic building at most per cell. `organic` (growing over time, not the
   * generated city filled at once): at most 3 floors above the tallest neighbour within 30 m (Roadcraft).
   */
  recordFor(l: LotColumns, i: number, organic = false): BuildingRec {
    const r = new Rng(l.seed[i]);
    const cell = cellId(cellX(l.x[i]), cellX(l.z[i]));
    const biggest = Growth.biggest(l) === i;
    let fn = biggest && this.squareCell(cell) === cell ? Fn.Square : civicFor(cell, baseZone(l.zone[i]), biggest, l.w[i] * l.d[i]);
    if (fn === Fn.Square && !(biggest && this.squareCell(cell) === cell)) fn = Fn.None;
    const zone = baseZone(l.zone[i]);
    let floors = floorsFor(l.zone[i], l.profile[i], r);
    let most = Infinity;
    if (organic) {
      let tallest = -1;
      const col = this.world.buildings.cols;
      this.world.buildingIndex.query(l.x[i] - 30, l.z[i] - 30, l.x[i] + 30, l.z[i] + 30, (id) => {
        if (Math.hypot(col.x[id] - l.x[i], col.z[id] - l.z[i]) <= 30 + Math.max(col.w[id], col.d[id]) / 2) tallest = Math.max(tallest, col.floors[id]);
      });
      if (tallest >= 0) { most = Math.max(1, tallest) + 3; floors = Math.min(floors, most); }
    }
    const rec: BuildingRec = {
      fn,
      x: l.x[i], z: l.z[i], w: l.w[i], d: l.d[i], rot: l.rot[i], h: 0, color: 0,
      seed: l.seed[i], zone, floors, style: this.unlikeStyle(l.x[i], l.z[i], zone, floors, l.seed[i]),
    };
    if (!fn) this.landmark(rec, most);
    return rec;
  }

  /**
   * Landmark (Roadcraft catalog): some commercial towers with a near-square footprint get a ready-made design
   * (round glass, art deco spire, copper octagon...), never the same landmark within 250 m.
   */
  private landmark(rec: BuildingRec, most = Infinity): void {
    if ((rec.zone !== Zone.Commercial && rec.zone !== Zone.Mixed) || rec.floors < 8) return;
    const ratio = rec.w / Math.max(1, rec.d);
    if (rec.w < 16 || rec.d < 16 || rec.w > 46 || rec.d > 46 || ratio < 0.6 || ratio > 1.7) return;
    const h = hash2(Math.round(rec.x), Math.round(rec.z), 911);
    if (h % 100 >= 22) return;
    const k0 = (h >>> 8) % LANDMARKS.length;
    const cols = this.world.buildings.cols;
    for (let t = 0; t < LANDMARKS.length; t++) {
      const [ds, minFloors] = LANDMARKS[(k0 + t) % LANDMARKS.length];
      // a landmark taller than the growth rule allows here waits for the neighbours to grow
      if (minFloors > most) continue;
      const enc = encodeDesign(ds);
      let near = false;
      this.world.buildingIndex.query(rec.x - 250, rec.z - 250, rec.x + 250, rec.z + 250, (id) => { if (cols.color[id] === enc.color && cols.h[id] === enc.h) near = true; });
      if (near) continue;
      rec.color = enc.color; rec.h = enc.h;
      rec.floors = Math.max(rec.floors, minFloors);
      return;
    }
  }

  /**
   * Style of the new building: among the seed's style and three alternatives, the one most unlike its neighbours
   * (Roadcraft `zoning.ts` `unlikeness`): a different architecture style scores more, similar height and the same color
   * (same style seed) score less, and farther neighbours weigh less. The neighbourhood era is the lot's for all (900 m noise).
   */
  private unlikeStyle(x: number, z: number, zone: number, floors: number, seed: number): number {
    const REACH = 30;
    const cols = this.world.buildings.cols;
    const near: number[] = [];
    this.world.buildingIndex.query(x - REACH, z - REACH, x + REACH, z + REACH, (id) => { if (near.length < 24) near.push(id); });
    const first = seed & 127;
    if (near.length === 0) return first;
    const era = eraAt(x, z);
    let best = first, bestScore = -Infinity;
    for (let k = 0; k < 4; k++) {
      const style = k === 0 ? first : (first + 37 * k + ((seed >>> (8 + k * 5)) & 31)) & 127;
      const arch = archFor(zone, floors, era, style);
      let least = Infinity;
      for (const id of near) {
        const d = Math.hypot(cols.x[id] - x, cols.z[id] - z);
        if (d > REACH) continue;
        const other = cols.style[id] >= 128 ? cols.style[id] - 128 : archFor(cols.zone[id], cols.floors[id], era, cols.style[id]);
        const sig = (other === arch ? 0 : 2) + Math.min(1.5, Math.abs(cols.floors[id] - floors) / 3) + (cols.style[id] === style ? 0 : 0.5);
        least = Math.min(least, sig + 2.5 * d / REACH);
      }
      // the seed gets a small preference (the neighbourhood does not become a lottery)
      const score = least + (k === 0 ? 0.3 : 0);
      if (score > bestScore) { bestScore = score; best = style; }
    }
    return best;
  }

  place(l: LotColumns, i: number): number { return this.world.growBuilding(this.recordFor(l, i)); }

  /** Free lot containing the point. */
  lotAt(x: number, z: number): { lots: LotColumns; i: number } | null {
    const c = cellId(cellX(x), cellX(z));
    for (const cc of [c, c - 1, c + 1, c - MAP_CELLS, c + MAP_CELLS]) {
      const l = this.lots.get(cc);
      if (!l) continue;
      for (let i = 0; i < l.count; i++) {
        const dx = x - l.x[i], dz = z - l.z[i];
        const s = Math.sin(l.rot[i]), co = Math.cos(l.rot[i]);
        const lx = dx * co - dz * s, lz = dx * s + dz * co;
        if (Math.abs(lx) <= l.w[i] / 2 && Math.abs(lz) <= l.d[i] / 2 && !this.occupied(l, i)) return { lots: l, i };
      }
    }
    return null;
  }

  /** Fills every free lot at once (generated and test city): a grown-up town, aged over a tenth of the decay. */
  fillAll(): number {
    let n = 0;
    for (const c of this.cells) {
      const l = this.lots.get(c)!;
      for (let i = 0; i < l.count; i++) if (!this.occupied(l, i)) {
        const rec = this.recordFor(l, i);
        rec.built = this.world.clock - generatedBuilt(rec.seed);
        this.world.growBuilding(rec); n++;
      }
    }
    return n;
  }

  get pendingCells(): number { return this.world.dirty.pending(Dirty.Lots); }

  clear(): void {
    this.lots.clear();
    this.taken.clear();
    this.last = null;
    for (const c of this.cells) this.cellPos[c] = -1;
    this.cells.length = 0;
  }
}

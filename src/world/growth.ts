// Lotes por célula (feitos nos workers) e crescimento: prédios nascem sozinhos
// nos lotes livres das zonas. Trabalho por quadro limitado e constante.

import { CELL_SIZE, MAP_CELLS } from '../config.ts';
import { CELL_COUNT, Dirty, cellId, cellOriginX, cellX } from '../core/grid.ts';
import { Rng } from '../core/rng.ts';
import type { JobPool } from '../jobs/pool.ts';
import { roadGraphTransfer, type LotColumns } from '../jobs/protocol.ts';
import { Zone, baseZone, zoneDensity } from '../roads/zones.ts';
import { PROFILE_INFO } from '../roads/profiles.ts';
import { archFor, civicFor, eraAt } from './arch.ts';
import { LANDMARKS, encodeDesign } from './design.ts';
import { hash2 } from '../core/rng.ts';
import type { BuildingRec, World } from './world.ts';

/** Andares por zona e via da frente (avenidas dão prédios mais altos). */
export function floorsFor(zoneId: number, profile: number, r: Rng): number {
  const avenue = (PROFILE_INFO[profile]?.priority ?? 0) >= 2;
  const zone = baseZone(zoneId), dens = zoneDensity(zoneId);
  // densidade baixa: casas e sobrados; alta: torres
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
  /** Células com lotes, para sortear sem varrer o mapa. */
  private cells: number[] = [];
  private cellPos = new Int32Array(CELL_COUNT).fill(-1);
  private rng = new Rng(9182);
  private acc = 0;
  /** Prédios por segundo (0 = parado). */
  rate = 25;

  constructor(world: World, pool: JobPool) {
    this.world = world;
    this.pool = pool;
  }

  /** Células sujas de lotes: pede os lotes de novo. */
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

  /** Algum prédio ocupa o lote? */
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

  /** Cresce até `n` prédios agora (cidade de teste) ou devagar no tempo. */
  step(dt: number, budget = 8): void {
    if (this.cells.length === 0 || this.rate <= 0) return;
    this.acc = Math.min(this.acc + dt * this.rate, 50);
    let tries = budget;
    while (this.acc >= 1 && tries-- > 0) {
      const c = this.cells[this.rng.int(0, this.cells.length)];
      const l = this.lots.get(c)!;
      const i = this.rng.int(0, l.count);
      if (this.occupied(l, i)) continue;
      this.place(l, i);
      this.acc -= 1;
    }
  }

  recordFor(l: LotColumns, i: number): BuildingRec {
    const r = new Rng(l.seed[i]);
    // prédio especial: o maior lote da célula, sorteado pela célula
    const cell = cellId(cellX(l.x[i]), cellX(l.z[i]));
    let biggest = i;
    for (let k = 0; k < l.count; k++) if (l.w[k] * l.d[k] > l.w[biggest] * l.d[biggest]) biggest = k;
    const fn = civicFor(cell, baseZone(l.zone[i]), biggest === i, l.w[i] * l.d[i]);
    const zone = baseZone(l.zone[i]), floors = floorsFor(l.zone[i], l.profile[i], r);
    const rec: BuildingRec = {
      fn,
      x: l.x[i], z: l.z[i], w: l.w[i], d: l.d[i], rot: l.rot[i], h: 0, color: 0,
      seed: l.seed[i], zone, floors, style: this.unlikeStyle(l.x[i], l.z[i], zone, floors, l.seed[i]),
    };
    if (!fn) this.landmark(rec);
    return rec;
  }

  /**
   * Marco (catálogo do roadcraft): parte das torres comerciais de planta quase quadrada ganha um projeto pronto
   * (redonda de vidro, agulha art déco, octogonal de cobre...), nunca o mesmo marco a menos de 250 m.
   */
  private landmark(rec: BuildingRec): void {
    if ((rec.zone !== Zone.Commercial && rec.zone !== Zone.Mixed) || rec.floors < 8) return;
    const ratio = rec.w / Math.max(1, rec.d);
    if (rec.w < 16 || rec.d < 16 || rec.w > 46 || rec.d > 46 || ratio < 0.6 || ratio > 1.7) return;
    const h = hash2(Math.round(rec.x), Math.round(rec.z), 911);
    if (h % 100 >= 22) return;
    const k0 = (h >>> 8) % LANDMARKS.length;
    const cols = this.world.buildings.cols;
    for (let t = 0; t < LANDMARKS.length; t++) {
      const [ds, minFloors] = LANDMARKS[(k0 + t) % LANDMARKS.length];
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
   * Estilo do prédio novo: entre o da semente e três alternativas, o mais diferente dos vizinhos (roadcraft
   * `zoning.ts` `unlikeness`): outro estilo de arquitetura vale mais, altura parecida e cor igual (mesma semente de
   * estilo) valem menos, e quem está mais longe pesa menos. A época do bairro é a do lote para todos (ruído de 900 m).
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
      // a semente tem uma pequena preferência (o bairro não vira um sorteio)
      const score = least + (k === 0 ? 0.3 : 0);
      if (score > bestScore) { bestScore = score; best = style; }
    }
    return best;
  }

  place(l: LotColumns, i: number): number { return this.world.addBuilding(this.recordFor(l, i)); }

  /** Lote livre que contém o ponto. */
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

  /** Enche todos os lotes livres de uma vez (cidade de teste). */
  fillAll(): number {
    let n = 0;
    for (const c of this.cells) {
      const l = this.lots.get(c)!;
      for (let i = 0; i < l.count; i++) if (!this.occupied(l, i)) { this.place(l, i); n++; }
    }
    return n;
  }

  get pendingCells(): number { return this.world.dirty.pending(Dirty.Lots); }

  clear(): void {
    this.lots.clear();
    for (const c of this.cells) this.cellPos[c] = -1;
    this.cells.length = 0;
  }
}

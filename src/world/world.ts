// World state that lives on the page: heights (shared with the workers),
// typed tables, spatial index and dirty marking.

import { StreetItems } from './items.ts';
import { NO_WATER, createGroundBuffers } from './ground.ts';
import { CELL_COUNT, DirtyCells, Dirty, SpatialIndex, TILE_COUNT, cellX, cellId, tileOfCell, tileX, tileId } from '../core/grid.ts';
import { Table } from '../core/table.ts';
import { createHeightBuffer } from './heights.ts';
import { SHAPE_MAX, SHAPE_SCALE, SHAPE_STRIDE, emptyBoxes, type BoxColumns } from '../shared/contracts/worker.ts';
import { MinuteHeap, decayTenths, nextTenthAt } from './decay.ts';
import { RoadNetwork } from '../roads/network.ts';
import { ROAD_TUNING } from '../roads/tuning.ts';
import { ImpossibleNodes } from '../roads/impossible.ts';
import { MAP_CELLS } from '../config.ts';
import { Fn } from './arch.ts';
import { MapLook } from './mapLook.ts';
import type { SegId } from '../core/ids.ts';

/** Buildings. Milestone 1 has only generic boxes; the procedural generator arrives in milestone 4. */
/** The first day starts at 06:30 (Roadcraft 4.0 sim/city/city.ts:9); minutes in a day. */
const DAY_START = 6 * 60 + 30, DAY = 24 * 60;

export const buildingSchema = {
  x: Float32Array, z: Float32Array,
  w: Float32Array, d: Float32Array, h: Float32Array,
  rot: Float32Array,
  color: Uint32Array,
  seed: Uint32Array,
  zone: Uint8Array, floors: Uint8Array, style: Uint8Array,
  /** Function (school, church, hospital…; 0 = ordinary). */
  fn: Uint8Array,
  cell: Int32Array,
  /** Corners of a polygon lot (0 = rectangle); the corners live in World.lotShape (see BoxColumns.shape). */
  shapeN: Uint8Array,
  /** City minute built or renovated, decay in tenths, and the minute of its next tenth in the decay heap. */
  built: Float32Array, decay: Uint8Array, due: Float64Array,
  /** The height its walls were built to over the ground storey (m), as the worker that meshed its cell found it;
   *  0 until then (jobs/buildingGen/heights.ts estimates). Not saved: the workers fill it again. */
  top: Float32Array,
};

/** A building's fields (the rest comes from the generator). */
export interface BuildingRec {
  x: number; z: number; w: number; d: number; h: number; rot: number; color: number; seed: number; zone: number; floors: number; style: number; fn?: number;
  /** City minute built (default: now). */
  built?: number;
  /** Polygon lot corners in the lot frame, metres, flat [x0, z0, x1, z1, …] (absent = rectangle). */
  shape?: ArrayLike<number>;
}

/** Area of a polygon given as flat [x, z, …] (positive when counter-clockwise with z up). */
export function polygonArea(p: ArrayLike<number>, n = p.length / 2): number {
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a += p[j * 2] * p[i * 2 + 1] - p[i * 2] * p[j * 2 + 1];
  return a / 2;
}

/** Money a new map starts with (Roadcraft's, `roads/tuning.ts`). */
export const START_MONEY = ROAD_TUNING.economy.startingFunds;

export class World {
  seed = 1;
  gameId = 0;
  /** Cash on hand (R$). Roads cost by width, length and structure. */
  money: number = START_MONEY;
  /** Sandbox mode: nothing is charged. */
  unlimited = false;
  /** A new city's money: the starting cash, and the developer's unlimited money off. */
  startMoney(): void { this.money = START_MONEY; this.unlimited = false; }
  readonly heightsSab: SharedArrayBuffer;
  readonly heights: Float32Array;
  /** Painted ground (RGBA per 4 m sample, see world/ground.ts) and water (8 m). */
  readonly groundSab: SharedArrayBuffer;
  readonly ground32: Uint32Array;
  readonly waterSab: SharedArrayBuffer;
  readonly water: Float32Array;
  /** Ground and water layers to re-upload; tiles that have water. */
  readonly groundDirty = new Set<number>();
  readonly waterDirty = new Set<number>();
  readonly tileWater = new Uint8Array(TILE_COUNT);
  /** Map biome (colors and trees). */
  biome = 0;
  /** Conservative min/max height per tile (for culling). */
  readonly tileMin = new Float32Array(TILE_COUNT);
  readonly tileMax = new Float32Array(TILE_COUNT);
  /** Height texture layers that need re-uploading. */
  readonly layerDirty = new Set<number>();
  /** Tiles changed since the last save. */
  readonly saveDirty = new Uint8Array(TILE_COUNT);
  /** Bumped with every change of a tile: a save clears a tile's mark only if no change came after its snapshot. */
  readonly saveVer = new Uint32Array(TILE_COUNT);
  /** Tiles present in the current save. */
  readonly tileInSave = new Uint8Array(TILE_COUNT);

  readonly dirty = new DirtyCells();
  readonly buildings = new Table(buildingSchema, 1 << 16);
  /** Player sign texts, by position (signKey), and street names by segment. */
  readonly signTexts = new Map<string, string>();
  readonly streetNames = new Map<SegId, string>();
  /** The text on the sign at `key`; undefined takes it away. */
  setSignText(key: string, text: string | undefined): void { if (text === undefined) this.signTexts.delete(key); else this.signTexts.set(key, text); }
  /** The name typed for segment `seg`; undefined takes it away (the generated name shows again). */
  setStreetName(seg: SegId, name: string | undefined): void { if (name === undefined) this.streetNames.delete(seg); else this.streetNames.set(seg, name); }
  /** The map's look (water, hand-set weather, clouds, fog, road paint), saved with the map. */
  readonly look = new MapLook();
  readonly buildingIndex = new SpatialIndex(1 << 16);
  /** Data version of each cell (bumped on every change). */
  readonly cellVersion = new Uint32Array(CELL_COUNT);
  /** Buildings per cell. */
  readonly cellBuildings = new Uint32Array(CELL_COUNT);
  /** Squares per neighbourhood (2 × 2 cells): growth puts one at most in each (Roadcraft). */
  readonly squares = new Uint16Array(Math.ceil(MAP_CELLS / 2) ** 2);

  /** The neighbourhood (2 × 2 cells, 512 m) of a point. */
  static neighbourhood(x: number, z: number): number { return (cellX(z) >> 1) * Math.ceil(MAP_CELLS / 2) + (cellX(x) >> 1); }

  readonly roads: RoadNetwork;
  /** Nodes where two neighbouring roads meet under 25° (the top bar's warning), kept from the network's changes. */
  readonly impossible: ImpossibleNodes;
  /** Street items placed by the player. */
  readonly items: StreetItems;
  /** Polygon lot corners, SHAPE_STRIDE int16 (decimetres, lot frame) per building id. */
  lotShape = new Int16Array((1 << 16) * SHAPE_STRIDE);
  /** City clock in minutes since the map began (building decay; never wraps). */
  clock = 0;
  /**
   * Minutes the time of day runs ahead of the city clock: one clock for both, as Roadcraft 4.0 (sim/city/city.ts:9-32,
   * minutes = DAY_START 06:30 + skipped + the clock). Setting the hour (a save, a photo, ?hour) moves only this shift.
   */
  private dayShift = DAY_START;
  /** Each building's next decay tenth (world/decay.ts). */
  private decayHeap = new MinuteHeap();
  /** Buildings that passed a tenth since the start (counted, for the commit messages). */
  decayChanges = 0;

  constructor() {
    this.roads = new RoadNetwork(this);
    this.impossible = new ImpossibleNodes(this.roads);
    this.items = new StreetItems(this);
    this.heightsSab = createHeightBuffer();
    this.heights = new Float32Array(this.heightsSab);
    const gb = createGroundBuffers();
    this.groundSab = gb.ground; this.waterSab = gb.water;
    this.ground32 = new Uint32Array(this.groundSab);
    this.water = new Float32Array(this.waterSab);
    this.buildings.onGrow((cap) => {
      this.buildingIndex.grow(cap);
      const s = new Int16Array(cap * SHAPE_STRIDE); s.set(this.lotShape); this.lotShape = s;
    });
  }

  /** Corners of a polygon lot in metres (lot frame), flat; empty for a rectangle. */
  lotPolygon(id: number): number[] {
    const n = this.buildings.cols.shapeN[id], o = id * SHAPE_STRIDE, out: number[] = [];
    for (let k = 0; k < n * 2; k++) out.push(this.lotShape[o + k] / SHAPE_SCALE);
    return out;
  }

  /** Lot outline in metres (lot frame): the polygon, or the rectangle's four corners. */
  lotOutline(id: number): number[] {
    const c = this.buildings.cols;
    if (c.shapeN[id]) return this.lotPolygon(id);
    const w = c.w[id] / 2, d = c.d[id] / 2;
    return [-w, -d, w, -d, w, d, -w, d];
  }

  /**
   * Advances the city clock; buildings that reach a new decay tenth get it in `decay` (only those). Nothing drawn reads
   * decay yet, so no mesh is marked for it; the saved decay is derived again from `built` on load.
   */
  advanceClock(minutes: number): void {
    if (!(minutes > 0)) return;
    this.clock += minutes;
    const h = this.decayHeap, c = this.buildings.cols;
    while (h.topKey <= this.clock) {
      const at = h.topKey, id = h.pop();
      if (!this.buildings.alive[id] || c.due[id] !== at) continue; // gone or filed again later
      this.refreshDecay(id);
    }
  }

  /** The time of day in hours, [0, 24): the city clock and the shift. */
  get hour(): number { return (((this.clock + this.dayShift) % DAY) + DAY) % DAY / 60; }

  /** Sets the time of day (a save's, a photo's, ?hour); the city clock, and so the decay, does not move. */
  setHour(h: number): void { this.dayShift = (((h * 60 - this.clock) % DAY) + DAY) % DAY; }

  /** Sets the clock (loading a save): every building is filed again; the time of day stays. */
  setClock(minute: number): void {
    const h = this.hour;
    this.clock = minute;
    this.setHour(h);
    this.decayHeap.clear();
    const t = this.buildings;
    for (let id = 0; id < t.end; id++) if (t.alive[id]) this.refreshDecay(id);
  }

  private refreshDecay(id: number): void {
    const c = this.buildings.cols;
    const d = decayTenths(c.built[id], this.clock);
    if (d !== c.decay[id]) { c.decay[id] = d; this.decayChanges++; }
    const next = nextTenthAt(c.built[id], d);
    c.due[id] = next;
    if (next !== Infinity) this.decayHeap.push(next, id);
  }

  /** Renovation (Roadcraft Shift+click): the building is new again. Returns the previous built minute. */
  setBuilt(id: number, minute: number): number {
    const c = this.buildings.cols, before = c.built[id];
    c.built[id] = minute;
    this.refreshDecay(id);
    this.touchCell(c.cell[id], Dirty.Save);
    return before;
  }

  /** Marks dirty cells and what depends on them (save, version). */
  touchRect(minX: number, minZ: number, maxX: number, maxZ: number, kinds: number): void {
    if (kinds & (Dirty.Roads | Dirty.Buildings | Dirty.Terrain)) kinds |= Dirty.Props;
    this.dirty.markRect(minX, minZ, maxX, maxZ, kinds);
    const x0 = cellX(minX), x1 = cellX(maxX), z0 = cellX(minZ), z1 = cellX(maxZ);
    for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) this.cellVersion[cellId(cx, cz)]++;
    const tx0 = tileX(minX), tx1 = tileX(maxX), tz0 = tileX(minZ), tz1 = tileX(maxZ);
    for (let tz = tz0; tz <= tz1; tz++) for (let tx = tx0; tx <= tx1; tx++) this.markSave(tileId(tx, tz));
  }

  touchCell(cid: number, kinds: number): void {
    if (kinds & (Dirty.Roads | Dirty.Buildings | Dirty.Terrain)) kinds |= Dirty.Props;
    this.dirty.mark(cid, kinds);
    this.cellVersion[cid]++;
    this.markSave(tileOfCell(cid));
  }

  /** A tile to write at the next save. */
  markSave(t: number): void {
    this.saveDirty[t] = 1;
    this.saveVer[t]++;
  }

  /** Residents and jobs (O(1) updates for every building added, removed or changed). */
  residents = 0;
  jobs = 0;

  /** Residents and jobs of a building, by zone, area and floors. */
  static capacity(zone: number, w: number, d: number, floors: number): [number, number] {
    const area = w * d * 0.6 * floors; // approximate usable area (empty lot: 0 floors, nobody)
    switch (zone) {
      case 1: return [Math.round(area / 28), 0]; // residential
      case 2: return [0, Math.round(area / 18)]; // commercial
      case 3: return [0, Math.round(area / 45)]; // industrial
      case 4: return [Math.round(area / 40), Math.round(area / 40)]; // mixed
      default: return [0, 0];
    }
  }

  private count(id: number, sign: number): void {
    const c = this.buildings.cols;
    // a polygon lot counts its own area (as a square of the same area)
    const side = c.shapeN[id] ? Math.sqrt(Math.abs(polygonArea(this.lotShape.subarray(id * SHAPE_STRIDE), c.shapeN[id]))) / SHAPE_SCALE : 0;
    const [r, j] = c.shapeN[id] ? World.capacity(c.zone[id], side, side, c.floors[id]) : World.capacity(c.zone[id], c.w[id], c.d[id], c.floors[id]);
    this.residents += r * sign; this.jobs += j * sign;
  }

  addBuilding(b: BuildingRec, at?: number): number {
    let id: number;
    if (at !== undefined) { this.buildings.allocAt(at); id = at; } else id = this.buildings.alloc();
    return this.fillBuilding(b, id);
  }

  /**
   * A building made outside the undo history (growth, generated city): it takes a never-used id, so an undo can
   * always restore a building that a command removed with the id it had.
   */
  growBuilding(b: BuildingRec): number {
    return this.fillBuilding(b, this.buildings.alloc(true));
  }

  private fillBuilding(b: BuildingRec, id: number): number {
    const c = this.buildings.cols;
    const { x, z } = b;
    c.x[id] = x; c.z[id] = z; c.w[id] = b.w; c.d[id] = b.d; c.h[id] = b.h; c.rot[id] = b.rot; c.color[id] = b.color;
    c.seed[id] = b.seed; c.zone[id] = b.zone; c.floors[id] = b.floors; c.style[id] = b.style; c.fn[id] = b.fn ?? 0;
    const n = b.shape ? Math.min(SHAPE_MAX, b.shape.length >> 1) : 0;
    c.shapeN[id] = n >= 3 ? n : 0;
    const o = id * SHAPE_STRIDE;
    this.lotShape.fill(0, o, o + SHAPE_STRIDE);
    if (b.shape && c.shapeN[id]) for (let k = 0; k < n * 2; k++) this.lotShape[o + k] = Math.round(b.shape[k] * SHAPE_SCALE);
    c.built[id] = b.built ?? this.clock;
    c.decay[id] = 0;
    const cid = cellId(cellX(x), cellX(z));
    c.cell[id] = cid;
    this.buildingIndex.insert(id, x, z);
    this.cellBuildings[cid]++;
    if (c.fn[id] === Fn.Square) this.squares[World.neighbourhood(x, z)]++;
    this.count(id, 1);
    this.refreshDecay(id);
    this.touchCell(cid, Dirty.Buildings);
    return id;
  }

  /** Building fields for commands (undo): [id, x, z, w, d, h, rot, color, seed, zone, floors, style, fn, built, n, corners…]. */
  buildingRec(id: number): number[] {
    const c = this.buildings.cols;
    return [id, c.x[id], c.z[id], c.w[id], c.d[id], c.h[id], c.rot[id], c.color[id], c.seed[id], c.zone[id], c.floors[id], c.style[id], c.fn[id], c.built[id], c.shapeN[id], ...this.lotPolygon(id)];
  }

  /** The record of buildingRec as a BuildingRec (without the id). */
  static recOf(r: number[]): BuildingRec {
    const n = r[14] ?? 0;
    return { x: r[1], z: r[2], w: r[3], d: r[4], h: r[5], rot: r[6], color: r[7], seed: r[8], zone: r[9], floors: r[10], style: r[11], fn: r[12] ?? 0, built: r[13], shape: n ? r.slice(15, 15 + n * 2) : undefined };
  }

  /**
   * Puts back a building a command removed (undo of a removal, redo of an addition), with its id. Every later command
   * is undone already, so whatever stands on its lot now came from outside the history (growth): it gives way.
   */
  restoreBuilding(r: number[]): void {
    const rec = World.recOf(r);
    for (const other of this.buildingsOverlapping(rec)) this.removeBuilding(other);
    // its id is never taken outside the history (`growBuilding`), but should anything hold it, move that elsewhere
    if (this.buildings.alive[r[0]]) {
      const held = World.recOf(this.buildingRec(r[0]));
      this.removeBuilding(r[0]);
      this.growBuilding(held);
    }
    this.addBuilding(rec, r[0]);
  }

  /** Live buildings whose lot rectangle overlaps this one's (lots that only touch along an edge do not count). */
  private buildingsOverlapping(b: BuildingRec): number[] {
    const c = this.buildings.cols, out: number[] = [];
    const reach = Math.hypot(b.w, b.d) / 2 + 60;
    this.buildingIndex.query(b.x - reach, b.z - reach, b.x + reach, b.z + reach, (id) => {
      if (rectsOverlap(b.x, b.z, b.w / 2 - 0.5, b.d / 2 - 0.5, b.rot, c.x[id], c.z[id], c.w[id] / 2 - 0.5, c.d[id] / 2 - 0.5, c.rot[id])) out.push(id);
    });
    return out;
  }

  /** Changes floors/style (player edit). */
  editBuilding(id: number, floors: number, style: number, fn = this.buildings.cols.fn[id]): void {
    const c = this.buildings.cols;
    this.count(id, -1);
    const nb = World.neighbourhood(c.x[id], c.z[id]);
    if (c.fn[id] === Fn.Square) this.squares[nb]--;
    c.floors[id] = floors; c.style[id] = style; c.fn[id] = fn;
    if (fn === Fn.Square) this.squares[nb]++;
    this.count(id, 1);
    this.touchCell(c.cell[id], Dirty.Buildings);
  }

  /** Creator design (color and h fields) and floors: the building mesh is rebuilt. */
  setDesign(id: number, color: number, h: number, floors: number): void {
    const c = this.buildings.cols;
    this.count(id, -1);
    c.color[id] = color; c.h[id] = h; c.floors[id] = floors;
    this.count(id, 1);
    this.touchCell(c.cell[id], Dirty.Buildings);
  }

  removeBuilding(id: number): void {
    // its id may be reused by the next building: it is not a ruin
    this.ruined.delete(id);
    if (!this.buildings.alive[id]) return;
    this.buildingIndex.remove(id);
    this.count(id, -1);
    const cid = this.buildings.cols.cell[id];
    this.cellBuildings[cid]--;
    if (this.buildings.cols.fn[id] === Fn.Square) this.squares[World.neighbourhood(this.buildings.cols.x[id], this.buildings.cols.z[id])]--;
    this.touchCell(cid, Dirty.Buildings);
    this.buildings.release(id);
  }

  /** Copies the buildings of a cell (or a tile) into transferable columns. */
  /**
   * Buildings stood in for by their ruin (features/demolition/ruin): still in the world (the simulation, the growth
   * and the save count them), not drawn by the cell layers (`gatherBoxes(cells, true)`). A handful at a time.
   */
  readonly ruined = new Set<number>();

  /** Building `id` drawn by its ruin (`on`) or by the cell layers again: its cell is drawn again either way. */
  setRuined(id: number, on: boolean): void {
    if (on === this.ruined.has(id)) return;
    if (on) this.ruined.add(id); else this.ruined.delete(id);
    const cid = this.buildings.cols.cell[id];
    this.dirty.mark(cid, Dirty.Buildings | Dirty.Props);
    this.cellVersion[cid]++;
  }

  /** The buildings of `cells` as job columns; `drawn`: only those the cell layers draw (not the ruined). */
  gatherBoxes(cells: number[], drawn = false): BoxColumns {
    let n = 0;
    for (const c of cells) n += this.cellBuildings[c];
    const out = emptyBoxes(n);
    const col = this.buildings.cols;
    let k = 0;
    for (const c of cells) {
      this.buildingIndex.queryCell(c, (id) => {
        if (col.cell[id] !== c || (drawn && this.ruined.has(id))) return;
        out.x[k] = col.x[id]; out.z[k] = col.z[id]; out.w[k] = col.w[id]; out.d[k] = col.d[id];
        out.h[k] = col.h[id]; out.rot[k] = col.rot[id]; out.color[k] = col.color[id];
        out.seed[k] = col.seed[id]; out.zone[k] = col.zone[id]; out.floors[k] = col.floors[id]; out.style[k] = col.style[id]; out.fn[k] = col.fn[id];
        out.shapeN[k] = col.shapeN[id]; out.built[k] = col.built[id]; out.decay[k] = col.decay[id];
        out.id[k] = id;
        if (col.shapeN[id]) out.shape.set(this.lotShape.subarray(id * SHAPE_STRIDE, (id + 1) * SHAPE_STRIDE), k * SHAPE_STRIDE);
        k++;
      });
    }
    out.count = k;
    return out;
  }

  /** The heights a worker built the buildings' walls to (`JobResults.buildingMesh.built`), into their `top` column. */
  setBuiltTops(built: { id: Int32Array; top: Float32Array }): void {
    const top = this.buildings.cols.top;
    for (let k = 0; k < built.id.length; k++) {
      const id = built.id[k];
      if (id >= 0 && id < this.buildings.end && this.buildings.alive[id] && built.top[k] > 0) top[id] = built.top[k];
    }
  }

  /** Ground with no paint and no water (new map, load). */
  clearGround(): void {
    this.ground32.fill(0);
    this.water.fill(NO_WATER);
    this.tileWater.fill(0);
    for (let t = 0; t < TILE_COUNT; t++) { this.groundDirty.add(t); this.waterDirty.add(t); }
  }

  clearBuildings(): void {
    this.ruined.clear();
    this.buildingIndex.clear();
    this.buildings.clear();
    this.cellBuildings.fill(0);
    this.squares.fill(0);
    this.residents = 0; this.jobs = 0;
    this.decayHeap.clear();
    // another city starts its clock again; the time of day goes on
    const h = this.hour;
    this.clock = 0;
    this.setHour(h);
  }
}

/**
 * Whether two rotated rectangles (centre, half sizes along their own x and z, rotation as the lots use it) overlap,
 * by the separating axis test. Rectangles that only touch do not overlap.
 */
function rectsOverlap(ax: number, az: number, ahw: number, ahd: number, arot: number,
  bx: number, bz: number, bhw: number, bhd: number, brot: number): boolean {
  if (ahw <= 0 || ahd <= 0 || bhw <= 0 || bhd <= 0) return false;
  const ac = Math.cos(arot), as = Math.sin(arot), bc = Math.cos(brot), bs = Math.sin(brot);
  // each rectangle's axes in world space (the inverse of the lots' world-to-local turn)
  const axes = [[ac, -as], [as, ac], [bc, -bs], [bs, bc]];
  const dx = bx - ax, dz = bz - az;
  for (const [nx, nz] of axes) {
    const d = Math.abs(dx * nx + dz * nz);
    const ra = ahw * Math.abs(ac * nx - as * nz) + ahd * Math.abs(as * nx + ac * nz);
    const rb = bhw * Math.abs(bc * nx - bs * nz) + bhd * Math.abs(bs * nx + bc * nz);
    if (d >= ra + rb) return false;
  }
  return true;
}

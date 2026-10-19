// Single spatial grid: plate 2048 m, tile 1024 m, cell 256 m, subcell 64 m.
// Grid coordinates start at the corner (-MAP_HALF, -MAP_HALF). Keys are Morton codes.

import {
  CELL_SIZE, MAP_CELLS, MAP_HALF, MAP_SUBCELLS, MAP_TILES, SUBCELL_SIZE, TILE_SIZE,
} from '../config.ts';

/** Spreads the low 16 bits of v onto the even bits. */
function part1by1(v: number): number {
  v &= 0xffff;
  v = (v | (v << 8)) & 0x00ff00ff;
  v = (v | (v << 4)) & 0x0f0f0f0f;
  v = (v | (v << 2)) & 0x33333333;
  v = (v | (v << 1)) & 0x55555555;
  return v >>> 0;
}

function compact1by1(v: number): number {
  v &= 0x55555555;
  v = (v | (v >>> 1)) & 0x33333333;
  v = (v | (v >>> 2)) & 0x0f0f0f0f;
  v = (v | (v >>> 4)) & 0x00ff00ff;
  v = (v | (v >>> 8)) & 0x0000ffff;
  return v;
}

/** Morton key of (ix, iz), each up to 16 bits. */
export function morton(ix: number, iz: number): number {
  return (part1by1(ix) | (part1by1(iz) << 1)) >>> 0;
}

export function mortonX(key: number): number { return compact1by1(key); }
export function mortonZ(key: number): number { return compact1by1(key >>> 1); }

/** Integer grid index of a world coordinate for a given cell side length. */
export function gridIndex(world: number, size: number, count: number): number {
  const i = Math.floor((world + MAP_HALF) / size);
  return i < 0 ? 0 : i >= count ? count - 1 : i;
}

export const cellX = (x: number) => gridIndex(x, CELL_SIZE, MAP_CELLS);
export const subcellX = (x: number) => gridIndex(x, SUBCELL_SIZE, MAP_SUBCELLS);
export const tileX = (x: number) => gridIndex(x, TILE_SIZE, MAP_TILES);

/** Dense cell index (row by row). Used as the cell id in arrays. */
export const cellId = (cx: number, cz: number) => cz * MAP_CELLS + cx;
export const tileId = (tx: number, tz: number) => tz * MAP_TILES + tx;
export const CELL_COUNT = MAP_CELLS * MAP_CELLS;
export const TILE_COUNT = MAP_TILES * MAP_TILES;
export const SUBCELL_COUNT = MAP_SUBCELLS * MAP_SUBCELLS;

export function cellOriginX(cx: number): number { return cx * CELL_SIZE - MAP_HALF; }
export function tileOriginX(tx: number): number { return tx * TILE_SIZE - MAP_HALF; }

/** Tile that contains the cell. */
export function tileOfCell(cid: number): number {
  const cx = cid % MAP_CELLS;
  const cz = (cid / MAP_CELLS) | 0;
  const per = TILE_SIZE / CELL_SIZE;
  return tileId((cx / per) | 0, (cz / per) | 0);
}

/**
 * Spatial index with intrusive linked lists per subcell.
 * One per table. Insert/remove/move is O(1); a rectangle query
 * visits only the subcells it touches.
 */
export class SpatialIndex {
  readonly head = new Int32Array(SUBCELL_COUNT).fill(-1);
  next: Int32Array;
  prev: Int32Array;
  slot: Int32Array; // subcell of each entity, -1 if outside

  constructor(capacity: number) {
    this.next = new Int32Array(capacity).fill(-1);
    this.prev = new Int32Array(capacity).fill(-1);
    this.slot = new Int32Array(capacity).fill(-1);
  }

  grow(capacity: number): void {
    if (capacity <= this.next.length) return;
    const g = (a: Int32Array) => { const b = new Int32Array(capacity).fill(-1); b.set(a); return b; };
    this.next = g(this.next);
    this.prev = g(this.prev);
    this.slot = g(this.slot);
  }

  clear(): void {
    this.head.fill(-1);
    this.next.fill(-1);
    this.prev.fill(-1);
    this.slot.fill(-1);
  }

  insert(id: number, x: number, z: number): void {
    const s = subcellX(z) * MAP_SUBCELLS + subcellX(x);
    const h = this.head[s];
    this.next[id] = h;
    this.prev[id] = -1;
    if (h >= 0) this.prev[h] = id;
    this.head[s] = id;
    this.slot[id] = s;
  }

  remove(id: number): void {
    const s = this.slot[id];
    if (s < 0) return;
    const n = this.next[id];
    const p = this.prev[id];
    if (p >= 0) this.next[p] = n; else this.head[s] = n;
    if (n >= 0) this.prev[n] = p;
    this.slot[id] = -1;
    this.next[id] = -1;
    this.prev[id] = -1;
  }

  move(id: number, x: number, z: number): void {
    const s = subcellX(z) * MAP_SUBCELLS + subcellX(x);
    if (s === this.slot[id]) return;
    this.remove(id);
    this.insert(id, x, z);
  }

  /** Calls fn for each entity whose subcells touch the rectangle. */
  query(minX: number, minZ: number, maxX: number, maxZ: number, fn: (id: number) => void): void {
    const x0 = subcellX(minX), x1 = subcellX(maxX);
    const z0 = subcellX(minZ), z1 = subcellX(maxZ);
    for (let sz = z0; sz <= z1; sz++) {
      for (let sx = x0; sx <= x1; sx++) {
        for (let id = this.head[sz * MAP_SUBCELLS + sx]; id >= 0; id = this.next[id]) fn(id);
      }
    }
  }

  /** Entities in a 256 m cell (4×4 subcells). */
  queryCell(cid: number, fn: (id: number) => void): void {
    const per = CELL_SIZE / SUBCELL_SIZE;
    const cx = cid % MAP_CELLS, cz = (cid / MAP_CELLS) | 0;
    for (let sz = cz * per; sz < cz * per + per; sz++) {
      for (let sx = cx * per; sx < cx * per + per; sx++) {
        for (let id = this.head[sz * MAP_SUBCELLS + sx]; id >= 0; id = this.next[id]) fn(id);
      }
    }
  }
}

/** Kinds of derived product that an edit can dirty. */
export const Dirty = {
  Terrain: 1 << 0,
  Roads: 1 << 1,
  Buildings: 1 << 2,
  Props: 1 << 3,
  Save: 1 << 4,
  RoadPaint: 1 << 5,
  Lots: 1 << 6,
} as const;
export type DirtyKind = (typeof Dirty)[keyof typeof Dirty];

/** One consumer's own list of dirty cells of a kind: draining it leaves the other consumers' lists alone. */
export class DirtyReader {
  readonly kind: DirtyKind;
  private flags = new Uint8Array(CELL_COUNT);
  private list: number[] = [];

  constructor(kind: DirtyKind) { this.kind = kind; }

  /** Called by DirtyCells.mark. */
  push(cid: number): void {
    if (this.flags[cid]) return;
    this.flags[cid] = 1;
    this.list.push(cid);
  }

  /** Removes and returns this consumer's dirty cells. */
  drain(): number[] {
    const l = this.list;
    if (l.length === 0) return [];
    this.list = [];
    for (const c of l) this.flags[c] = 0;
    return l;
  }

  get pending(): number { return this.list.length; }
}

/**
 * Dirty cells per kind. Marking is O(1); the consumer drains only the list of
 * cells of that kind and never scans the grid. A kind with more than one consumer (the building layer and its detail
 * layer) gives each one a reader with its own list; such a kind has no shared list.
 */
export class DirtyCells {
  private flags = new Uint8Array(CELL_COUNT);
  private lists = new Map<number, number[]>();
  /** Readers by kind bit (index = log2 of the kind). */
  private readers: DirtyReader[][] = [];
  /** Kinds consumed through readers. */
  private readKinds = 0;

  /** A new consumer of a kind, with its own list (cells marked from now on). */
  reader(kind: DirtyKind): DirtyReader {
    const r = new DirtyReader(kind);
    const bit = Math.log2(kind);
    (this.readers[bit] ??= []).push(r);
    this.readKinds |= kind;
    return r;
  }

  mark(cid: number, kinds: number): void {
    const read = kinds & this.readKinds;
    if (read) {
      for (let bit = 0; bit < this.readers.length; bit++) {
        if (!(read & (1 << bit))) continue;
        for (const r of this.readers[bit]) r.push(cid);
      }
    }
    const old = this.flags[cid];
    const fresh = kinds & ~this.readKinds & ~old;
    if (!fresh) return;
    this.flags[cid] = old | fresh;
    for (let k = 1; k <= fresh; k <<= 1) {
      if (fresh & k) {
        let l = this.lists.get(k);
        if (!l) this.lists.set(k, (l = []));
        l.push(cid);
      }
    }
  }

  /** Marks every cell touched by a world rectangle. */
  markRect(minX: number, minZ: number, maxX: number, maxZ: number, kinds: number): void {
    const x0 = cellX(minX), x1 = cellX(maxX), z0 = cellX(minZ), z1 = cellX(maxZ);
    for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) this.mark(cellId(cx, cz), kinds);
  }

  /** Removes and returns the dirty cells of a kind. */
  drain(kind: DirtyKind): number[] {
    if (kind & this.readKinds) throw new Error(`dirty kind ${kind} is read through readers: drain the reader`);
    const l = this.lists.get(kind);
    if (!l || l.length === 0) return [];
    this.lists.set(kind, []);
    for (const c of l) this.flags[c] &= ~kind;
    return l;
  }

  pending(kind: DirtyKind): number {
    if (kind & this.readKinds) return Math.max(...this.readers[Math.log2(kind)].map((r) => r.pending));
    return this.lists.get(kind)?.length ?? 0;
  }
}

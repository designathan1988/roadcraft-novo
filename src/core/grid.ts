// Grade espacial única: placa 2048 m, ladrilho 1024 m, célula 256 m, subcélula 64 m.
// Coordenadas de grade começam no canto (-MAP_HALF, -MAP_HALF). Chaves em Morton.

import {
  CELL_SIZE, MAP_CELLS, MAP_HALF, MAP_SUBCELLS, MAP_TILES, SUBCELL_SIZE, TILE_SIZE,
} from '../config.ts';

/** Espalha os 16 bits baixos de v nos bits pares. */
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

/** Chave de Morton de (ix, iz), cada um com até 16 bits. */
export function morton(ix: number, iz: number): number {
  return (part1by1(ix) | (part1by1(iz) << 1)) >>> 0;
}

export function mortonX(key: number): number { return compact1by1(key); }
export function mortonZ(key: number): number { return compact1by1(key >>> 1); }

/** Índice de grade (inteiro) de uma coordenada de mundo para um lado de célula. */
export function gridIndex(world: number, size: number, count: number): number {
  const i = Math.floor((world + MAP_HALF) / size);
  return i < 0 ? 0 : i >= count ? count - 1 : i;
}

export const cellX = (x: number) => gridIndex(x, CELL_SIZE, MAP_CELLS);
export const subcellX = (x: number) => gridIndex(x, SUBCELL_SIZE, MAP_SUBCELLS);
export const tileX = (x: number) => gridIndex(x, TILE_SIZE, MAP_TILES);

/** Índice denso de célula (linha a linha). Usado como id de célula em arrays. */
export const cellId = (cx: number, cz: number) => cz * MAP_CELLS + cx;
export const tileId = (tx: number, tz: number) => tz * MAP_TILES + tx;
export const CELL_COUNT = MAP_CELLS * MAP_CELLS;
export const TILE_COUNT = MAP_TILES * MAP_TILES;
export const SUBCELL_COUNT = MAP_SUBCELLS * MAP_SUBCELLS;

export function cellOriginX(cx: number): number { return cx * CELL_SIZE - MAP_HALF; }
export function tileOriginX(tx: number): number { return tx * TILE_SIZE - MAP_HALF; }

/** Ladrilho que contém a célula. */
export function tileOfCell(cid: number): number {
  const cx = cid % MAP_CELLS;
  const cz = (cid / MAP_CELLS) | 0;
  const per = TILE_SIZE / CELL_SIZE;
  return tileId((cx / per) | 0, (cz / per) | 0);
}

/**
 * Índice espacial com listas encadeadas intrusivas por subcélula.
 * Um por tabela. Inserir/remover/mover é O(1); consulta por retângulo
 * visita só as subcélulas tocadas.
 */
export class SpatialIndex {
  readonly head = new Int32Array(SUBCELL_COUNT).fill(-1);
  next: Int32Array;
  prev: Int32Array;
  slot: Int32Array; // subcélula de cada entidade, -1 se fora

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

  /** Chama fn para cada entidade cujas subcélulas tocam o retângulo. */
  query(minX: number, minZ: number, maxX: number, maxZ: number, fn: (id: number) => void): void {
    const x0 = subcellX(minX), x1 = subcellX(maxX);
    const z0 = subcellX(minZ), z1 = subcellX(maxZ);
    for (let sz = z0; sz <= z1; sz++) {
      for (let sx = x0; sx <= x1; sx++) {
        for (let id = this.head[sz * MAP_SUBCELLS + sx]; id >= 0; id = this.next[id]) fn(id);
      }
    }
  }

  /** Entidades de uma célula de 256 m (4×4 subcélulas). */
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

/** Tipos de produto derivado que uma edição pode sujar. */
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

/**
 * Células sujas por tipo. Marcar é O(1); quem consome drena só a lista de
 * células daquele tipo, nunca varre a grade.
 */
export class DirtyCells {
  private flags = new Uint8Array(CELL_COUNT);
  private lists = new Map<number, number[]>();

  mark(cid: number, kinds: number): void {
    const old = this.flags[cid];
    const fresh = kinds & ~old;
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

  /** Marca todas as células tocadas por um retângulo de mundo. */
  markRect(minX: number, minZ: number, maxX: number, maxZ: number, kinds: number): void {
    const x0 = cellX(minX), x1 = cellX(maxX), z0 = cellX(minZ), z1 = cellX(maxZ);
    for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) this.mark(cellId(cx, cz), kinds);
  }

  /** Retira e devolve as células sujas de um tipo. */
  drain(kind: DirtyKind): number[] {
    const l = this.lists.get(kind);
    if (!l || l.length === 0) return [];
    this.lists.set(kind, []);
    for (const c of l) this.flags[c] &= ~kind;
    return l;
  }

  pending(kind: DirtyKind): number {
    return this.lists.get(kind)?.length ?? 0;
  }
}

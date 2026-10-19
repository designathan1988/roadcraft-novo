// Poses compartilhadas entre o worker de simulação e a página, em buffer triplo
// sem trava. O escritor publica trocando seu buffer pelo do meio; o leitor
// pega o do meio quando há um novo. Ninguém espera ninguém.
//
// Cada registro guarda a pose anterior e a atual, para a página interpolar.

/** px, py, pz, pyaw, x, y, z, yaw, type*256+colour, opacity, look. The 11th number (index 10, added at the end) is a
 * 16-bit appearance id (0..65535): stable per pedestrian (drawn when it is born), the vehicle id for vehicles and
 * a hash for people waiting at stops. The people renderer picks body, clothes and hair from it. */
export const POSE_STRIDE = 11;
export const MAX_AGENTS = 1 << 17; // 131 072 carros + pessoas na janela micro

/**
 * The records of a publication are sorted by TILE m square of a TILE_GRID × TILE_GRID grid around the camera (the
 * micro window fits in it), with the first record of each tile: the page skips whole tiles out of view or too far
 * instead of reading every pose every frame.
 */
export const TILE = 128, TILE_GRID = 32, TILES = TILE_GRID * TILE_GRID;

const STATE = 0; // bits 0-1: índice do meio; bit 2: novo
const NEW = 4;
const HEADER_INTS = 4;
/** Numbers per buffer in `meta`: count, tick time (ms), dt (ms), tick, grid origin x and z, sorted by tile (1/0). */
const META = 7;

export interface PoseBuffers {
  sab: SharedArrayBuffer;
  ctl: Int32Array; // [estado]
  /** Per buffer: META numbers (see META). */
  meta: Float64Array;
  /** Per buffer: the first record of each tile (TILES + 1). */
  tiles: Int32Array[];
  data: Float32Array[]; // 3 buffers
}

const TILE_BYTES = 3 * (TILES + 1) * 4;

export function createPoseBuffers(): SharedArrayBuffer {
  const bytes = HEADER_INTS * 4 + 3 * META * 8 + TILE_BYTES + 3 * MAX_AGENTS * POSE_STRIDE * 4;
  return new SharedArrayBuffer(bytes);
}

export function viewPoseBuffers(sab: SharedArrayBuffer): PoseBuffers {
  const ctl = new Int32Array(sab, 0, HEADER_INTS);
  const meta = new Float64Array(sab, HEADER_INTS * 4, 3 * META);
  const toff = HEADER_INTS * 4 + 3 * META * 8;
  const tiles = [0, 1, 2].map((i) => new Int32Array(sab, toff + i * (TILES + 1) * 4, TILES + 1));
  const off = toff + TILE_BYTES;
  const data = [0, 1, 2].map((i) => new Float32Array(sab, off + i * MAX_AGENTS * POSE_STRIDE * 4, MAX_AGENTS * POSE_STRIDE));
  return { sab, ctl, meta, tiles, data };
}

/** Corner of the tile grid for a camera at (x, z). */
export function tileOrigin(x: number, z: number, out: Float64Array): void {
  out[0] = Math.floor(x / TILE) * TILE - (TILE_GRID / 2) * TILE;
  out[1] = Math.floor(z / TILE) * TILE - (TILE_GRID / 2) * TILE;
}

/**
 * Copies `n` records of `src` into `dst` sorted by tile of their current position (a counting sort: two passes),
 * writing each tile's first record into `tiles`. Records outside the grid go to its edge tiles.
 */
export function sortByTile(src: Float32Array, n: number, dst: Float32Array, tiles: Int32Array, ox: number, oz: number, cell: Int32Array): void {
  tiles.fill(0);
  for (let i = 0; i < n; i++) {
    const o = i * POSE_STRIDE;
    const tx = Math.min(TILE_GRID - 1, Math.max(0, Math.floor((src[o + 4] - ox) / TILE)));
    const tz = Math.min(TILE_GRID - 1, Math.max(0, Math.floor((src[o + 6] - oz) / TILE)));
    const t = tz * TILE_GRID + tx;
    cell[i] = t;
    tiles[t + 1]++;
  }
  for (let t = 0; t < TILES; t++) tiles[t + 1] += tiles[t];
  const next = cell.subarray(n, n + TILES);
  next.set(tiles.subarray(0, TILES));
  for (let i = 0; i < n; i++) {
    const k = next[cell[i]]++;
    dst.set(src.subarray(i * POSE_STRIDE, i * POSE_STRIDE + POSE_STRIDE), k * POSE_STRIDE);
  }
}

/** Lado da simulação. */
export class PoseWriter {
  back: number;
  private b: PoseBuffers;
  constructor(b: PoseBuffers) {
    this.b = b;
    // estado inicial: meio = 1, escritor = 0, leitor = 2
    Atomics.store(b.ctl, STATE, 1);
    this.back = 0;
  }
  get data(): Float32Array { return this.b.data[this.back]; }
  /** The tile index of the buffer being written. */
  get tiles(): Int32Array { return this.b.tiles[this.back]; }
  /** `ox`, `oz`: the tile grid's corner when the records were sorted by tile (`sortByTile`); NaN = not sorted. */
  publish(count: number, tickTimeMs: number, dtMs: number, tick: number, ox = NaN, oz = NaN): void {
    const m = this.back * META;
    this.b.meta[m] = count;
    this.b.meta[m + 1] = tickTimeMs;
    this.b.meta[m + 2] = dtMs;
    this.b.meta[m + 3] = tick;
    this.b.meta[m + 4] = ox;
    this.b.meta[m + 5] = oz;
    this.b.meta[m + 6] = Number.isNaN(ox) ? 0 : 1;
    this.back = Atomics.exchange(this.b.ctl, STATE, this.back | NEW) & 3;
  }
}

/** Lado da página. */
export class PoseReader {
  front = 2;
  private b: PoseBuffers;
  constructor(b: PoseBuffers) { this.b = b; }
  /** Pega o buffer mais novo, se houver. Devolve true quando trocou. */
  acquire(): boolean {
    if ((Atomics.load(this.b.ctl, STATE) & NEW) === 0) return false;
    this.front = Atomics.exchange(this.b.ctl, STATE, this.front) & 3;
    return true;
  }
  get data(): Float32Array { return this.b.data[this.front]; }
  get count(): number { return this.b.meta[this.front * META]; }
  get tickTime(): number { return this.b.meta[this.front * META + 1]; }
  get dt(): number { return this.b.meta[this.front * META + 2]; }
  get tick(): number { return this.b.meta[this.front * META + 3]; }
  /** The records are sorted by tile (`tiles`, grid corner `originX`, `originZ`). */
  get tiled(): boolean { return this.b.meta[this.front * META + 6] === 1; }
  get originX(): number { return this.b.meta[this.front * META + 4]; }
  get originZ(): number { return this.b.meta[this.front * META + 5]; }
  get tiles(): Int32Array { return this.b.tiles[this.front]; }
}

// Which blocks of the props pool each cell holds. The pool is one GPU buffer of instances in blocks of `BLOCK`; a
// cell's props take whole blocks. Plain bookkeeping, no GPU: the renderer copies the data into the blocks it is given.
//
// A cell holds all the blocks its props need or none: it is never cut. When the pool is full, cells farther from the
// camera than the one asking give way (farthest first); if that is still not enough, the asking cell waits and the
// caller counts it. Blocks are handed out lowest first and the high-water mark follows the highest block in use, so
// the cull pass reads only the part of the pool that holds something.

export interface Placement {
  readonly blocks: number[];
  /** Cells that gave their blocks away to make room, with those blocks (their data must be cleared). */
  readonly evicted: Array<{ readonly cell: number; readonly blocks: number[] }>;
}

export class PropBlocks {
  /** Blocks in the pool. */
  readonly capacity: number;
  /** One past the highest block in use: the cull pass reads the pool up to here. */
  highBlock = 0;
  private heap: number[] = [];
  private live: Uint8Array;
  private cellBlocks: Array<number[] | null>;
  private cellDist: Float64Array;
  /** Cells that hold blocks. */
  readonly resident = new Set<number>();

  constructor(capacity: number, cells: number) {
    this.capacity = capacity;
    this.live = new Uint8Array(capacity);
    this.cellBlocks = new Array(cells).fill(null);
    this.cellDist = new Float64Array(cells);
    for (let b = 0; b < capacity; b++) this.heap.push(b); // sorted: already a min-heap
  }

  /** Free blocks. */
  get free(): number { return this.heap.length; }

  /** The blocks a cell holds (null: none). */
  blocksOf(c: number): readonly number[] | null { return this.cellBlocks[c]; }

  /** Updates how far a resident cell is from the camera (who gives way first when the pool is full). */
  setDistance(c: number, d: number): void { this.cellDist[c] = d; }

  /** Lets go of a cell's blocks; returns them, for the caller to clear their data. */
  release(c: number): number[] {
    const old = this.cellBlocks[c];
    if (!old) return [];
    for (const b of old) { this.live[b] = 0; this.pushFree(b); }
    this.cellBlocks[c] = null;
    this.resident.delete(c);
    while (this.highBlock > 0 && !this.live[this.highBlock - 1]) this.highBlock--;
    return old;
  }

  /**
   * All the blocks for `count` instances of a cell `distance` metres from the camera (the cell holds none: `release`
   * it first), making room from farther cells when needed; null when even that is not enough (nothing changed).
   */
  place(c: number, count: number, blockSize: number, distance: number): Placement | null {
    const need = Math.ceil(count / blockSize);
    if (need > this.capacity) return null;
    const evicted: Array<{ cell: number; blocks: number[] }> = [];
    if (need > this.heap.length) {
      // farther cells, farthest first, until their blocks and the free ones are enough
      const farther = [...this.resident].filter((r) => this.cellDist[r] > distance).sort((a, b) => this.cellDist[b] - this.cellDist[a]);
      let room = this.heap.length;
      let k = 0;
      while (room < need && k < farther.length) room += this.cellBlocks[farther[k++]]!.length;
      if (room < need) return null;
      for (let i = 0; i < k; i++) evicted.push({ cell: farther[i], blocks: this.release(farther[i]) });
    }
    const blocks: number[] = [];
    for (let k = 0; k < need; k++) {
      const b = this.popFree();
      this.live[b] = 1;
      blocks.push(b);
      if (b + 1 > this.highBlock) this.highBlock = b + 1;
    }
    this.cellBlocks[c] = blocks;
    this.cellDist[c] = distance;
    this.resident.add(c);
    return { blocks, evicted };
  }

  private pushFree(b: number): void {
    const h = this.heap;
    let i = h.push(b) - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p] <= h[i]) break;
      [h[p], h[i]] = [h[i], h[p]]; i = p;
    }
  }

  private popFree(): number {
    const h = this.heap, top = h[0], last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < h.length && h[l] < h[m]) m = l;
        if (r < h.length && h[r] < h[m]) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]]; i = m;
      }
    }
    return top;
  }
}

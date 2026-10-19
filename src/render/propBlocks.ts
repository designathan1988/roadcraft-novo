// Which blocks of the props pool each cell holds. The pool is one GPU buffer of instances in blocks of `BLOCK`; a
// cell's props take whole blocks. Plain bookkeeping, no GPU: the renderer copies the data into the blocks it is given.

export class PropBlocks {
  /** Blocks in the pool. */
  readonly capacity: number;
  /** One past the highest block in use: the cull pass reads the pool up to here. */
  highBlock = 0;
  private freeList: number[] = [];
  private cellBlocks: Array<number[] | null>;

  constructor(capacity: number, cells: number) {
    this.capacity = capacity;
    this.cellBlocks = new Array(cells).fill(null);
    for (let b = capacity - 1; b >= 0; b--) this.freeList.push(b);
  }

  /** The blocks a cell holds (null: none). */
  blocksOf(c: number): readonly number[] | null { return this.cellBlocks[c]; }

  /** Lets go of a cell's blocks; returns them, for the caller to clear their data. */
  release(c: number): number[] {
    const old = this.cellBlocks[c];
    if (!old) return [];
    for (const b of old) this.freeList.push(b);
    this.cellBlocks[c] = null;
    return old;
  }

  /** Blocks for `count` instances of a cell (the cell holds none: `release` it first). */
  place(c: number, count: number, blockSize: number): number[] {
    const need = Math.ceil(count / blockSize);
    const blocks: number[] = [];
    for (let k = 0; k < need && this.freeList.length; k++) blocks.push(this.freeList.pop()!);
    for (const b of blocks) this.highBlock = Math.max(this.highBlock, b + 1);
    this.cellBlocks[c] = blocks;
    return blocks;
  }
}

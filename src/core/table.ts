// SoA table: one typed array per field, dense ids and a free list.
// No object per entity.

type TypedCtor =
  | Float32ArrayConstructor | Float64ArrayConstructor
  | Int32ArrayConstructor | Uint32ArrayConstructor
  | Int16ArrayConstructor | Uint16ArrayConstructor
  | Int8ArrayConstructor | Uint8ArrayConstructor;

export type Schema = Record<string, TypedCtor>;
export type Columns<S extends Schema> = { [K in keyof S]: InstanceType<S[K]> };

export class Table<S extends Schema> {
  readonly schema: S;
  cols: Columns<S>;
  alive: Uint8Array;
  /** Highest id ever used + 1. Valid ids are in [0, end). */
  end = 0;
  /** Live entities. */
  size = 0;
  private free: Int32Array;
  private freeTop = 0;
  /** Where each id sits in the free list (−1 = not in it): taking a given id off the list is O(1). */
  private freePos: Int32Array;
  private growListeners: Array<(cap: number) => void> = [];

  constructor(schema: S, capacity = 1024) {
    this.schema = schema;
    this.cols = {} as Columns<S>;
    for (const k in schema) (this.cols as Record<string, unknown>)[k] = new schema[k](capacity);
    this.alive = new Uint8Array(capacity);
    this.free = new Int32Array(capacity);
    this.freePos = new Int32Array(capacity).fill(-1);
  }

  get capacity(): number { return this.alive.length; }

  onGrow(fn: (cap: number) => void): void { this.growListeners.push(fn); }

  private grow(min: number): void {
    let cap = this.capacity;
    while (cap < min) cap *= 2;
    for (const k in this.schema) {
      const old = this.cols[k] as unknown as { length: number } & ArrayLike<number>;
      const fresh = new this.schema[k](cap);
      (fresh as unknown as { set(a: ArrayLike<number>): void }).set(old);
      (this.cols as Record<string, unknown>)[k] = fresh;
    }
    const a = new Uint8Array(cap); a.set(this.alive); this.alive = a;
    const f = new Int32Array(cap); f.set(this.free); this.free = f;
    const p = new Int32Array(cap).fill(-1); p.set(this.freePos); this.freePos = p;
    for (const fn of this.growListeners) fn(cap);
  }

  /**
   * Reserves an id (reuses one from the free list). Fields are not zeroed here. `fresh`: a never-used id, for
   * entities made outside the undo history (growth): a freed id may still be restored by an undo (`allocAt`).
   */
  alloc(fresh = false): number {
    let id: number;
    if (this.freeTop > 0 && !fresh) { id = this.free[--this.freeTop]; this.freePos[id] = -1; }
    else {
      if (this.end >= this.capacity) this.grow(this.end + 1);
      id = this.end++;
    }
    this.alive[id] = 1;
    this.size++;
    return id;
  }

  /** Reserves a specific id (used when undoing a removal). */
  allocAt(id: number): void {
    if (id >= this.capacity) this.grow(id + 1);
    if (this.alive[id]) throw new Error(`id ${id} already alive`);
    if (id >= this.end) {
      for (let i = this.end; i < id; i++) this.pushFree(i);
      this.end = id + 1;
    } else {
      // take id off the free list: the last entry fills its place
      const k = this.freePos[id];
      if (k >= 0) {
        const last = this.free[--this.freeTop];
        this.free[k] = last; this.freePos[last] = k;
        this.freePos[id] = -1;
      }
    }
    this.alive[id] = 1;
    this.size++;
  }

  private pushFree(id: number): void {
    if (this.freeTop >= this.free.length) { const f = new Int32Array(this.free.length * 2); f.set(this.free); this.free = f; }
    this.freePos[id] = this.freeTop;
    this.free[this.freeTop++] = id;
  }

  release(id: number): void {
    if (!this.alive[id]) return;
    this.alive[id] = 0;
    this.size--;
    this.pushFree(id);
  }

  clear(): void {
    this.alive.fill(0);
    this.end = 0;
    this.size = 0;
    this.freeTop = 0;
    this.freePos.fill(-1);
  }
}

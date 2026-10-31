import type { Building } from './types.ts';

/** A TILE'S BUILDINGS AS ONE TYPED TABLE IN SHARED MEMORY (CLAUDE.md "Architecture": per-tile typed tables read by stateless jobs): columns for what is read without the record (id, place, rotation), each record's members in a binary stream, every string, object shape and shared member (`intern.ts`) written once for the tile; a SharedArrayBuffer is posted as a handle, never copied (MDN "SharedArrayBuffer"), and each reader decodes only the rows it is asked for */

const MAGIC = 0x52435442;
/** Bumped when the layout below changes. */
const FORMAT = 1;
/** Header words: magic, format, rows, strings, string units, shapes, shape keys, nodes, stream bytes. */
const HEAD = 9;

const T_NULL = 0, T_FALSE = 1, T_TRUE = 2, T_U8 = 3, T_I32 = 4, T_F64 = 5, T_STR = 6, T_ARR = 7, T_OBJ = 8, T_NODE = 9;

const align8 = (n: number): number => Math.ceil(n / 8) * 8;

/** Where each section starts, from the header's counts. */
interface Layout {
  readonly rows: number;
  readonly strings: number;
  readonly units: number;
  readonly shapes: number;
  readonly keys: number;
  readonly nodes: number;
  readonly stream: number;
  readonly ids: number;
  readonly xs: number;
  readonly ys: number;
  readonly turns: number;
  readonly rootAt: number;
  readonly nodeAt: number;
  readonly strStart: number;
  readonly shapeStart: number;
  readonly shapeKeys: number;
  readonly strUnits: number;
  readonly streamAt: number;
  readonly bytes: number;
}

function layout(rows: number, strings: number, units: number, shapes: number, keys: number, nodes: number, stream: number): Layout {
  let at = align8(HEAD * 4);
  const take = (bytes: number): number => { const start = at; at = align8(at + bytes); return start; };
  const ids = take(rows * 8), xs = take(rows * 8), ys = take(rows * 8), turns = take(rows * 8);
  const rootAt = take(rows * 4), nodeAt = take(nodes * 4), strStart = take((strings + 1) * 4), shapeStart = take((shapes + 1) * 4), shapeKeys = take(keys * 4);
  const strUnits = take(units * 2), streamAt = take(stream);
  return { rows, strings, units, shapes, keys, nodes, stream, ids, xs, ys, turns, rootAt, nodeAt, strStart, shapeStart, shapeKeys, strUnits, streamAt, bytes: at };
}

/** A table read back from its buffer (posted or shared): its columns are views on it; its records are decoded by a `TableReader`. */
export class RecordTable {
  readonly rows: number;
  readonly ids: Float64Array;
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  readonly rotations: Float64Array;
  /** The row of each id, made when first asked. */
  private rowOf: Map<number, number> | null = null;
  /** @internal */ readonly at: Layout;

  readonly buffer: ArrayBufferLike;
  constructor(buffer: ArrayBufferLike) {
    this.buffer = buffer;
    const head = new Uint32Array(buffer, 0, HEAD);
    if (head[0] !== MAGIC || head[1] !== FORMAT) throw new Error('[buildings] not a record table of this format');
    this.at = layout(head[2]!, head[3]!, head[4]!, head[5]!, head[6]!, head[7]!, head[8]!);
    this.rows = this.at.rows;
    this.ids = new Float64Array(buffer, this.at.ids, this.rows);
    this.xs = new Float64Array(buffer, this.at.xs, this.rows);
    this.ys = new Float64Array(buffer, this.at.ys, this.rows);
    this.rotations = new Float64Array(buffer, this.at.turns, this.rows);
  }

  /** The row holding a building's id; -1 when it is not in the table. */
  row(id: number): number {
    if (!this.rowOf) { this.rowOf = new Map(); for (let i = 0; i < this.rows; i++) this.rowOf.set(this.ids[i]!, i); }
    return this.rowOf.get(id) ?? -1;
  }

  /** A reader of this table: what it decodes (strings, shapes, shared members) is kept for its own life only (a job's). */
  reader(): TableReader {
    return new TableReader(this);
  }
}

/** DO NOT keep a reader past the job it was made for: a stateless job decodes what it reads and lets it go; the shared members it decoded are one object for all its rows (as `intern.ts` on the page) */
export class TableReader {
  private readonly view: DataView;
  private readonly rootAt: Uint32Array;
  private readonly nodeAt: Uint32Array;
  private readonly strStart: Uint32Array;
  private readonly strUnits: Uint16Array;
  private readonly shapeStart: Uint32Array;
  private readonly shapeKeys: Uint32Array;
  // DO NOT fill these at the ids met, from empty: a row read first meets ids far past the array's end, and V8 turns such an array into a dictionary (each look-up hashed: the cell jobs' decoding, wprof4). Sized and filled once.
  private readonly strings: (string | undefined)[];
  private readonly shapes: (string[] | undefined)[];
  private readonly nodes: unknown[];
  /** Whether each shared member was decoded (a member may decode to null). */
  private readonly decoded: Uint8Array;
  private pos = 0;

  readonly table: RecordTable;
  constructor(table: RecordTable) {
    this.table = table;
    const { buffer, at } = table;
    this.view = new DataView(buffer, at.streamAt, at.stream);
    this.rootAt = new Uint32Array(buffer, at.rootAt, at.rows);
    this.nodeAt = new Uint32Array(buffer, at.nodeAt, at.nodes);
    this.strStart = new Uint32Array(buffer, at.strStart, at.strings + 1);
    this.strUnits = new Uint16Array(buffer, at.strUnits, at.units);
    this.shapeStart = new Uint32Array(buffer, at.shapeStart, at.shapes + 1);
    this.shapeKeys = new Uint32Array(buffer, at.shapeKeys, at.keys);
    this.strings = new Array<string | undefined>(at.strings).fill(undefined);
    this.shapes = new Array<string[] | undefined>(at.shapes).fill(undefined);
    this.nodes = new Array<unknown>(at.nodes).fill(undefined);
    this.decoded = new Uint8Array(at.nodes);
  }

  /** A row's record: a fresh object of its own, its shared members the reader's. */
  record(row: number): Building {
    if (row < 0 || row >= this.table.rows) throw new Error(`[buildings] no row ${row} in the record table`);
    this.pos = this.rootAt[row]!;
    return this.value() as Building;
  }

  private string(id: number): string {
    let s = this.strings[id];
    if (s === undefined) {
      const a = this.strStart[id]!, b = this.strStart[id + 1]!;
      s = '';
      // DO NOT TextDecoder a shared view (browsers refuse it): the units are read in short runs.
      for (let i = a; i < b; i += 4096) s += String.fromCharCode(...this.strUnits.subarray(i, Math.min(b, i + 4096)));
      this.strings[id] = s;
    }
    return s;
  }

  private shape(id: number): string[] {
    let keys = this.shapes[id];
    if (!keys) {
      keys = [];
      for (let i = this.shapeStart[id]!; i < this.shapeStart[id + 1]!; i++) keys.push(this.string(this.shapeKeys[i]!));
      this.shapes[id] = keys;
    }
    return keys;
  }

  private value(): unknown {
    const view = this.view;
    const tag = view.getUint8(this.pos++);
    switch (tag) {
      case T_NULL: return null;
      case T_FALSE: return false;
      case T_TRUE: return true;
      case T_U8: return view.getUint8(this.pos++);
      case T_I32: { const v = view.getInt32(this.pos, true); this.pos += 4; return v; }
      case T_F64: { const v = view.getFloat64(this.pos, true); this.pos += 8; return v; }
      case T_STR: { const id = view.getUint32(this.pos, true); this.pos += 4; return this.string(id); }
      case T_ARR: {
        const n = view.getUint32(this.pos, true); this.pos += 4;
        const out = new Array<unknown>(n);
        for (let i = 0; i < n; i++) out[i] = this.value();
        return out;
      }
      case T_OBJ: {
        const keys = this.shape(view.getUint32(this.pos, true)); this.pos += 4;
        const out: Record<string, unknown> = {};
        for (const key of keys) out[key] = this.value();
        return out;
      }
      case T_NODE: {
        const id = view.getUint32(this.pos, true); this.pos += 4;
        if (this.decoded[id]) {
          // The first meeting is followed by the member's body: stepped over when it was decoded before.
          if (this.pos === this.nodeAt[id]) this.skip();
          return this.nodes[id];
        }
        const back = this.pos;
        this.pos = this.nodeAt[id]!;
        const node = this.value();
        this.nodes[id] = node;
        this.decoded[id] = 1;
        if (back !== this.nodeAt[id]) this.pos = back;
        return node;
      }
      default: throw new Error(`[buildings] a record table holds an unknown tag ${tag}`);
    }
  }

  /** The value at `pos` passed over without making it. */
  private skip(): void {
    const view = this.view;
    const tag = view.getUint8(this.pos++);
    switch (tag) {
      case T_NULL: case T_FALSE: case T_TRUE: return;
      case T_U8: this.pos += 1; return;
      case T_I32: case T_STR: this.pos += 4; return;
      // A shared member met here first has its body behind its mark: passed over with it.
      case T_NODE: { const id = view.getUint32(this.pos, true); this.pos += 4; if (this.pos === this.nodeAt[id]) this.skip(); return; }
      case T_F64: this.pos += 8; return;
      case T_ARR: { const n = view.getUint32(this.pos, true); this.pos += 4; for (let i = 0; i < n; i++) this.skip(); return; }
      case T_OBJ: { const keys = this.shape(view.getUint32(this.pos, true)); this.pos += 4; for (let i = 0; i < keys.length; i++) this.skip(); return; }
      default: throw new Error(`[buildings] a record table holds an unknown tag ${tag}`);
    }
  }
}

/** Where a building's record is read from: a table and its row (posted to a worker as the table's buffer and the row). */
export interface RecordRef {
  readonly buffer: ArrayBufferLike;
  readonly row: number;
}

/** Each record's place in a table: its tile's (`tableRecords`) or its own, written once when first asked (a record is replaced, never edited). */
const refs = new WeakMap<object, RecordRef>();

/** A tile's buildings read from its table on the page, each knowing its row: a job is handed the row, never the record. */
export function tableRecords(buffer: ArrayBufferLike): Building[] {
  const table = new RecordTable(buffer);
  const reader = table.reader();
  const out: Building[] = [];
  for (let row = 0; row < table.rows; row++) {
    const b = reader.record(row);
    refs.set(b, { buffer, row });
    out.push(b);
  }
  return out;
}

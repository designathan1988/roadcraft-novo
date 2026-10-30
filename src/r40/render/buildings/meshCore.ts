// Part of the R40 building mesh pipeline (split by responsibility).
import { hypot3 } from '../../core/hypot.ts';
import { deriveSpaces } from '../../world/buildings/spaces.ts';
import { worldToLocal, type FacadeBay, sideStart } from '../../world/buildings/geometry.ts';
import { type FurnitureKind } from '../../world/buildings/interior.ts';
import { ROOM_FLOATS } from './roomBehind.ts';
import { edgeFrame } from '../../world/buildings/footprints.ts';
import { Color, DataUtils } from 'three';
import { COLOURED_PARTS, FACADE_BYTES, FACADE_FLOATS, FACADE_GRID, NORMAL_SHORTS, SHELL_SHORTS, WEAR_STEPS, finishId, finishWear, octNormal, paintShort, wearByte } from './cellArrays.ts';
import { COVER_INSET, GRIME_REACH, LOOK_FLOATS, MACRO_SCALE, NO_GROUND, SHELL_PARTS, type ShellPartKind, macroNoiseInto } from './shellParts.ts';
import { m } from '../../world/units.ts';
import { LANDING_RISE } from '../../world/buildings/foundation.ts';
import { type Finish, type MaterialSpec } from '../../world/buildings/materials.ts';
import { type BayComponent, type Building, type FacadeGeometry, type FaceId, type Volume, type RoofDetail } from '../../world/buildings/types.ts';
import { PART_KINDS, type PartKind } from './kit.ts';
import { FACADE_FLIP, FACADE_KIND } from './facadeLevel.ts';
import { ROOF_COLOURS } from './roofPlan.ts';
import type { FlagInstance } from './flagLayer.ts';
import type { PartBatch } from './chunk.ts';
import { POSE_FLOATS } from './partPose.ts';
import { type FlagDesign, legacyFlag } from '../../world/buildings/flags.ts';

export let flagSink: FlagInstance[] | null = null;
/** Sets where the flags of the building being emitted go (the emitter entry owns the call). */
export function setFlagSink(v: FlagInstance[] | null): void { flagSink = v; }

export const flagOf = (detail: RoofDetail): FlagDesign | null =>
  !detail.flag || detail.flag === 'none' ? null : detail.flagDesign ?? legacyFlag(detail.flag);

export type Rgb = readonly [number, number, number];

export interface Paint {
  readonly rgb: Rgb;
  readonly finish: Finish;
}

export const linear = (hex: number, shade = 1): Rgb => {
  const c = new Color().setHex(hex);
  return [c.r * shade, c.g * shade, c.b * shade];
};

export const paint = (m: MaterialSpec, shade = 1): Paint => ({ rgb: linear(m.colour, shade), finish: m.finish });

export const TERRACE: Paint = paint({ finish: 'stone', colour: 0xb0a595 });

export const ARCADE_FLOOR: Paint = paint({ finish: 'stone', colour: 0x9d968a });

export const SAW_GLASS: Paint = paint({ finish: 'glass', colour: 0x3c5360 });

export const ROOF_PLANT: Paint = paint({ finish: 'concrete', colour: ROOF_COLOURS.plant });

export const WHITE_RGB: Rgb = [1, 1, 1];

export const PART_DEFAULT_COLOUR: Partial<Record<PartKind, Rgb>> = { frame: linear(0xe8e6df), railing: linear(0x33373a), fin: linear(0xe8e6df), brise: linear(0xe8e6df), louvre: linear(0x3d6b45) };

export const trimColours = new WeakMap<Paint, Color>();

export const trimColour = (p: Paint): Color => {
  let c = trimColours.get(p);
  if (!c) { c = new Color(p.rgb[0], p.rgb[1], p.rgb[2]); trimColours.set(p, c); }
  return c;
};

export const REVEAL = m(0.2);

export const FLAT_DEPTH = m(0.3);

export const SHADER_DRAWN: ReadonlySet<PartKind> = Object.freeze(new Set<PartKind>(['glass', 'glassDark', 'frame', 'door', 'shutter']));

export const BAND_OUT = m(0.07);

export const BAND_H = m(0.22);

export const CORNICE_OUT = m(0.16);

export const PARAPET_H = m(0.85);

export const PARAPET_T = m(0.25);

export const PART_INSET = m(0.006);

export const ATTIC_H = m(1.5);

export const EAVES = m(0.45);

export const ROOF_THICK = m(0.18);

export const ARCADE = m(1.8);

export const PLINTH_GROW = m(0.12);

export const PLINTH_RISE = LANDING_RISE;

export const LOGGIA_DEPTH = m(1.4);

export const GOURMET_OUT = m(1.6);

export const GOURMET_CHEEK = m(0.2);

export const CHEEK_IN = m(0.003);

export const CHEEK_FOOT = m(0.307);

export const CHEEK_BURY = m(0.011);

export interface Opening {
  a0: number;
  a1: number;
  h0: number;
  h1: number;
  depth: number;
}

export function openingOf(component: BayComponent, W: number, H: number, geometry?: FacadeGeometry): Opening | null {
  let w: number;
  let h0: number;
  let h1: number;
  let depth = REVEAL;
  switch (component) {
    case 'window':
    case 'sashWindow':
      w = Math.min(W - m(1.1), m(1.5));
      h0 = m(0.9);
      h1 = H - m(0.55);
      break;
    case 'wideWindow':
      w = W - m(0.35);
      h0 = m(0.35);
      h1 = H - m(0.35);
      depth = m(0.12);
      break;
    case 'balcony':
      w = Math.min(W - m(0.9), m(1.7));
      h0 = m(0.02);
      h1 = H - m(0.5);
      break;
    case 'door':
      w = Math.min(W - m(0.9), m(1.3));
      h0 = 0;
      h1 = Math.min(H - m(0.4), m(2.35));
      break;
    case 'shopfront':
      w = W - m(0.3);
      h0 = m(0.35);
      h1 = H - m(0.8);
      depth = m(0.12);
      break;
    case 'loadingDoor':
      w = W - m(0.7);
      h0 = 0;
      h1 = Math.min(H - m(0.6), m(4.5));
      depth = m(0.25);
      break;
    // These had no opening at all: every double door, French window, bay window
    case 'doubleDoor':
      w = Math.min(W - m(0.7), m(2.4));
      h0 = 0;
      // A tall ground floor gets a fanlight over the door, up to 3.6 m.
      h1 = Math.min(H - m(0.45), m(3.6));
      depth = m(0.3);
      break;
    case 'frenchWindow':
      w = Math.min(W - m(0.9), m(1.6));
      h0 = m(0.05);
      h1 = H - m(0.5);
      break;
    case 'bayWindow':
      w = Math.min(W - m(0.8), m(2));
      h0 = m(0.75);
      h1 = H - m(0.5);
      depth = m(0.12);
      break;
    case 'ribbon':
      w = W - m(0.15);
      h0 = m(0.9);
      h1 = H - m(0.6);
      depth = m(0.1);
      break;
    case 'garageDoor':
      w = Math.min(W - m(0.8), m(3));
      h0 = 0;
      h1 = Math.min(H - m(0.5), m(2.6));
      depth = m(0.2);
      break;
    // The facade library (`world/buildings/architecture.ts`).
    case 'loggia':
      // Let into the wall the depth of a room's edge
      w = W - m(0.5);
      h0 = m(0.02);
      h1 = H - m(0.3);
      depth = LOGGIA_DEPTH;
      break;
    case 'brise':
      w = W - m(0.5);
      h0 = m(0.75);
      h1 = H - m(0.4);
      depth = m(0.15);
      break;
    case 'shutteredWindow':
      w = Math.min(W - m(1.6), m(1.2));
      h0 = m(0.85);
      h1 = H - m(0.45);
      break;
    case 'gourmet':
      w = W - m(0.4);
      h0 = m(0.02);
      h1 = H - m(0.35);
      depth = m(0.15);
      break;
    default:
      return null;
  }
  if (geometry && (component === 'window' || component === 'sashWindow' || component === 'wideWindow')) {
    if (geometry.windowWidth !== undefined) w = W * geometry.windowWidth;
    if (geometry.sill !== undefined) h0 = Math.min(geometry.sill, H - m(.65));
    if (geometry.windowHeight !== undefined) h1 = h0 + H * geometry.windowHeight;
  }
  w = Math.max(m(0.4), Math.min(w, W - m(0.2)));
  h1 = Math.max(h0 + m(0.5), Math.min(h1, H - m(0.15)));
  const a0 = (W - w) / 2;
  return { a0, a1: a0 + w, h0, h1, depth };
}

export type Typed = Float32Array | Int16Array | Uint16Array | Uint32Array | Uint8Array;

export class Grow<T extends Typed> {
  array: T;
  length = 0;
  private readonly make: (size: number) => T;
  constructor(make: (size: number) => T, size: number) {
    this.make = make;
    this.array = make(size);
  }

  /** The array, with room for `n` more numbers after `length` (a new one, twice as large, when full). */
  room(n: number): T {
    const need = this.length + n;
    if (need > this.array.length) {
      let size = this.array.length * 2;
      while (size < need) size *= 2;
      const next = this.make(size);
      (next as Typed).set(this.array);
      this.array = next;
    }
    return this.array;
  }

  /** What was written, without a copy. */
  view(): T {
    return this.array.subarray(0, this.length) as T;
  }

  /** What was written, in an array of its own size (the arrays written again for the next building, `ShellWriter`). */
  copy(): T {
    return this.array.slice(0, this.length) as T;
  }

  /** The array's bytes as 32-bit words (a new view only once it grew): what the vertex weld hashes and compares. */
  bits(): Int32Array {
    const a = this.array;
    let w = this.words;
    if (!w || w.buffer !== a.buffer) w = this.words = new Int32Array(a.buffer, a.byteOffset, a.byteLength >> 2);
    return w;
  }

  private words: Int32Array | null = null;
}

export class PartRows {
  readonly poses = new Grow((n) => new Float32Array(n), 8 * POSE_FLOATS);
  readonly colours: Grow<Float32Array> | null;
  readonly looks: Grow<Float32Array> | null;
  readonly slots: Grow<Float32Array> | null;
  readonly rooms: Grow<Uint16Array> | null;
  count = 0;

  /** `fallback`: the colour of an instance placed with none (`PART_DEFAULT_COLOUR`). */
  readonly glassy: boolean;
  private readonly fallback: Rgb;
  constructor(coloured: boolean, looked: boolean, glassy: boolean, fallback: Rgb = WHITE_RGB) {
    this.glassy = glassy;
    this.fallback = fallback;
    this.colours = coloured ? new Grow((n) => new Float32Array(n), 8 * 3) : null;
    this.looks = looked ? new Grow((n) => new Float32Array(n), 8 * LOOK_FLOATS) : null;
    this.slots = glassy ? new Grow((n) => new Float32Array(n), 8) : null;
    this.rooms = glassy ? new Grow((n) => new Uint16Array(n), 8 * ROOM_FLOATS) : null;
  }

  /** Emptied for the next building, its arrays kept at their size. */
  clear(): void {
    this.count = 0;
    this.poses.length = 0;
    if (this.colours) this.colours.length = 0;
    if (this.looks) this.looks.length = 0;
    if (this.slots) this.slots.length = 0;
    if (this.rooms) this.rooms.length = 0;
  }

  /** One instance at (x, y, z) in world axes, turned `yaw`, sized (sx, sy, sz): its pose (`partPose.ts`), the kind's colour, no look, slot or room; its index. */
  add(x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number): number {
    const i = this.count++;
    const out = this.poses.room(POSE_FLOATS), o = i * POSE_FLOATS;
    // World y is mirrored into three's z, as everywhere else in this layer.
    out[o] = x; out[o + 1] = z; out[o + 2] = -y; out[o + 3] = Math.cos(yaw);
    out[o + 4] = Math.sin(yaw); out[o + 5] = sx; out[o + 6] = sy; out[o + 7] = sz;
    this.poses.length = o + POSE_FLOATS;
    if (this.colours) {
      const c = this.colours.room(3), f = this.fallback;
      c[i * 3] = f[0]; c[i * 3 + 1] = f[1]; c[i * 3 + 2] = f[2];
      this.colours.length = i * 3 + 3;
    }
    if (this.looks) {
      const l = this.looks.room(LOOK_FLOATS);
      for (let k = 0; k < LOOK_FLOATS; k++) l[i * LOOK_FLOATS + k] = 0;
      this.looks.length = (i + 1) * LOOK_FLOATS;
    }
    if (this.slots) {
      this.slots.room(1)[i] = -1;
      this.slots.length = i + 1;
    }
    if (this.rooms) {
      const r = this.rooms.room(ROOM_FLOATS);
      for (let k = 0; k < ROOM_FLOATS; k++) r[i * ROOM_FLOATS + k] = 0;
      this.rooms.length = (i + 1) * ROOM_FLOATS;
    }
    return i;
  }

  /** Instance `i`'s own colour (a kind drawn with none keeps none). */
  colour(i: number, r: number, g: number, b: number): void {
    const c = this.colours?.array;
    if (!c) return;
    c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b;
  }

  /** A shell's part's look (`shellParts.ts`): its finish id, its wear as the shell's vertices carry it and its ground (`NO_GROUND`: none). */
  look(i: number, finish: number, wear: number, ground: number): void {
    const l = this.looks?.array;
    if (!l) return;
    l[i * LOOK_FLOATS] = finish; l[i * LOOK_FLOATS + 1] = wear; l[i * LOOK_FLOATS + 2] = ground;
  }

  /** A pane's light slot and the room behind it (`roomBehind.ts`, ROOM_FLOATS numbers as half floats), when known. */
  pane(i: number, slot: number, room: readonly number[] | null): void {
    if (!this.slots || !this.rooms) return;
    this.slots.array[i] = slot;
    if (room) for (let k = 0; k < ROOM_FLOATS; k++) this.rooms.array[i * ROOM_FLOATS + k] = DataUtils.toHalfFloat(room[k]!);
  }

  /** The batch of what was placed, in arrays of its own (the rows are written again for the next building). */
  batch(): PartBatch {
    const poses = this.poses.copy(), colours = this.colours ? this.colours.copy() : null, count = this.count;
    if (this.slots && this.rooms) return { poses, colours, count, slots: this.slots.copy(), rooms: this.rooms.copy() };
    return this.looks ? { poses, colours, count, looks: this.looks.copy() } : { poses, colours, count };
  }
}

export type PartSink = Record<PartKind, PartRows>;

export type FurnitureSink = Partial<Record<FurnitureKind, PartRows>>;

export const partSink = (): PartSink => Object.fromEntries(PART_KINDS.map((k) =>
  [k, new PartRows(COLOURED_PARTS.has(k), SHELL_PARTS.has(k), k === 'glass' || k === 'glassDark', PART_DEFAULT_COLOUR[k] ?? WHITE_RGB)])) as PartSink;

export const furnitureRows = (sink: FurnitureSink, kind: FurnitureKind): PartRows => (sink[kind] ??= new PartRows(false, false, false));

export interface Stream {
  readonly grow: Grow<Typed>;
  readonly size: number;
  readonly words: number;
}

export function hashWord(h: number, w: number): number {
  let k = Math.imul(w, 0xcc9e2d51);
  k = Math.imul((k << 15) | (k >>> 17), 0x1b873593);
  h ^= k;
  h = (h << 13) | (h >>> 19);
  return (Math.imul(h, 5) + 0xe6546b64) | 0;
}

export class ShellPart {
  vertices = 0;
  readonly position = new Grow((n) => new Float32Array(n), 3 * 64);
  /** The normal, octahedral (`octNormal`). */
  readonly normal = new Grow((n) => new Int16Array(n), NORMAL_SHORTS * 64);
  /** The paint, its tone and grime in it, and the finish id with the building's decay (`Building.decay`) for the weathering shader (`finishWear`). */
  readonly paint = new Grow((n) => new Uint16Array(n), SHELL_SHORTS * 64);
  readonly index = new Grow((n) => new Uint32Array(n), 96);
  /** A run of bays only (`RunChunk`): each vertex's bay width and storey height (`FACADE_FLOATS`), its grid (`FACADE_GRID`), its opening in its bay (a0, a1, h0, h1), its frames' colour (r, g, b) and office flag (`FACADE_BYTES`, 0..255). */
  readonly facade: Grow<Uint16Array> | null;
  readonly grid: Grow<Int16Array> | null;
  readonly opening: Grow<Uint8Array> | null;
  /** Every array a vertex is written in: two vertices alike in all of them, bit for bit, are drawn as one. */
  private readonly streams: readonly Stream[];
  /** The weld's table, open addressing with linear probing: each slot a vertex + 1, 0 empty; never more than half full. */
  private slots = new Int32Array(256);
  /** Each vertex's hash, kept as it is welded: DO NOT hash every vertex again each time the table doubles (`rehash`). */
  private readonly hashes = new Grow((n) => new Uint32Array(n), 128);

  readonly finish: number;
  constructor(finish: number, run: boolean) {
    this.finish = finish;
    this.facade = run ? new Grow((n) => new Uint16Array(n), FACADE_FLOATS * 64) : null;
    this.grid = run ? new Grow((n) => new Int16Array(n), FACADE_GRID * 64) : null;
    this.opening = run ? new Grow((n) => new Uint8Array(n), FACADE_BYTES * 64) : null;
    const streams: Stream[] = [
      { grow: this.position, size: 3, words: 3 },
      { grow: this.normal, size: NORMAL_SHORTS, words: NORMAL_SHORTS / 2 },
      { grow: this.paint, size: SHELL_SHORTS, words: SHELL_SHORTS / 2 },
    ];
    if (this.facade && this.grid && this.opening) {
      streams.push({ grow: this.facade, size: FACADE_FLOATS, words: FACADE_FLOATS / 2 }, { grow: this.grid, size: FACADE_GRID, words: FACADE_GRID / 2 }, { grow: this.opening, size: FACADE_BYTES, words: FACADE_BYTES / 4 });
    }
    this.streams = streams;
  }

  /** Emptied for the next building, its arrays and its table kept at their size (`ShellWriter`). */
  clear(): void {
    this.vertices = 0;
    for (const s of this.streams) s.grow.length = 0;
    this.index.length = 0;
    this.hashes.length = 0;
    this.slots.fill(0);
  }

  /** Each stream's array as 32-bit words and its words a vertex, as they are after `room` (an array only changes there, as it grows). */
  private readonly views: Int32Array[] = [];
  private readonly widths: number[] = [];

  /** Room in every array for `count` vertices written from `vertices` on; the weld's views of them made again only where one grew. */
  room(count: number): void {
    const streams = this.streams;
    for (let i = 0; i < streams.length; i++) {
      const s = streams[i]!;
      s.grow.room(count * s.size);
      // DO NOT ask each stream for its words in every hash and every comparison of the weld (`bits` checks the buffer each time).
      this.views[i] = s.grow.bits();
      this.widths[i] = s.words;
    }
  }

  /** The vertex just written at `vertices`: kept as a new one, or the one laid before with every number alike; its index. */
  weld(): number {
    const v = this.vertices;
    if ((v + 1) * 2 > this.slots.length) this.rehash();
    const mask = this.slots.length - 1;
    const h = this.hash(v);
    for (let s = h & mask; ; s = (s + 1) & mask) {
      const at = this.slots[s]!;
      if (at === 0) {
        this.slots[s] = v + 1;
        this.hashes.room(1)[v] = h;
        this.hashes.length = v + 1;
        this.vertices = v + 1;
        for (const st of this.streams) st.grow.length = this.vertices * st.size;
        return v;
      }
      if (this.same(at - 1, v)) return at - 1;
    }
  }

  private hash(v: number): number {
    let h = 0x2545f491;
    const views = this.views, widths = this.widths;
    for (let i = 0; i < views.length; i++) {
      const bits = views[i]!, words = widths[i]!;
      for (let k = v * words, end = k + words; k < end; k++) h = hashWord(h, bits[k]!);
    }
    // MurmurHash3's finaliser: every bit of the words reaches the low bits the table reads.
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
    return h ^ (h >>> 16);
  }

  private same(a: number, b: number): boolean {
    const views = this.views, widths = this.widths;
    for (let i = 0; i < views.length; i++) {
      const bits = views[i]!, words = widths[i]!;
      for (let k = 0; k < words; k++) if (bits[a * words + k] !== bits[b * words + k]) return false;
    }
    return true;
  }

  /** A table twice the size, every vertex kept put in it again. */
  private rehash(): void {
    this.slots = new Int32Array(this.slots.length * 2);
    const mask = this.slots.length - 1;
    const hashes = this.hashes.array;
    for (let v = 0; v < this.vertices; v++) {
      let s = hashes[v]! & mask;
      while (this.slots[s] !== 0) s = (s + 1) & mask;
      this.slots[s] = v + 1;
    }
  }
}

export const FACE_NORMAL = new Int16Array(NORMAL_SHORTS);

export let faceIds = new Int32Array(32);

export interface FacadeStamp {
  /** `FACADE_KIND`. */
  readonly kind: number;
  readonly volume: number;
  readonly side: number;
  /** The run's direction along the facade, world plan. */
  readonly tx: number;
  readonly ty: number;
  /** One bay's width and one storey's height. */
  readonly W: number;
  readonly H: number;
  /** The opening in its bay, shares of W and H. */
  readonly opening: readonly [number, number, number, number];
  /** The frames' colour (the trim), linear 0..1. */
  readonly trim: readonly [number, number, number];
  /** Each point's bay (u) and level (v), whole numbers at the run's bay and storey lines. */
  readonly uv: readonly (readonly [number, number])[];
  /** Offices and shops: their lit rooms take the offices' lamps (`roomLamps.ts`). */
  readonly office: boolean;
}

export const toByte = (x: number): number => Math.round(Math.max(0, Math.min(1, x)) * 255);

export class Shell {
  readonly parts = new Map<Finish, ShellPart>();
  /** A vertex's place in and its tone noise out of `macroNoiseInto`. */
  private readonly noise = new Float64Array(4);
  /** The far level's runs of bays with openings, apart (`RunChunk`): only their vertices pay for the window grid. */
  readonly runs = new Map<Finish, ShellPart>();
  /** The ground floor's height for the building being emitted: walls darken towards it */
  ground = Number.NaN;
  /** How run-down the building being emitted is (`Building.decay`): stains, peeling paint, grime. */
  decay = 0;
  /** The far level being emitted (`emitChunk` `far`): its bays laid as runs, the runs with openings in `runs`. */
  far = false;
  /** The windows of the face being laid (the far level's runs of bays). */
  stamp: FacadeStamp | null = null;
  /** The elements' boxes as instances of the shell's parts (`shellParts.ts`, `emitChunk` `apart`); false lays them here face by face. */
  apart = true;
  /** Written again for each building of a job (`ShellWriter`): its chunks copy what was written out. */
  reused = false;
  /** The finishes this building laid, in the order it first laid each (its chunk's, as a new shell's parts were made). */
  readonly order: Finish[] = [];
  readonly runOrder: Finish[] = [];

  /** Emptied for the next building: every part kept, its arrays at their size, none of what was laid. */
  clear(): void {
    for (const part of this.parts.values()) part.clear();
    for (const part of this.runs.values()) part.clear();
    this.order.length = 0;
    this.runOrder.length = 0;
    this.ground = Number.NaN;
    this.decay = 0;
    this.far = false;
    this.stamp = null;
    this.apart = true;
  }

  /** DO NOT lay only the first two triangles: a lantern's octagonal and 24-sided caps */
  face(points: readonly (readonly [number, number, number])[], n: readonly [number, number, number], c: Paint, shades?: readonly number[]): void {
    // A run of bays with no opening (kind 0) draws as a wall: it needs no window grid.
    const st = this.stamp && this.stamp.kind !== FACADE_KIND.none ? this.stamp : null;
    const parts = st ? this.runs : this.parts;
    let part = parts.get(c.finish);
    if (!part) {
      part = new ShellPart(finishId(c.finish), st !== null);
      parts.set(c.finish, part);
    }
    if (part.index.length === 0) (st ? this.runOrder : this.order).push(c.finish);
    const count = points.length;
    // DO NOT ask the built-in: its result comes back boxed, one heap number a face (`core/hypot.ts`).
    const length = hypot3(n[0], n[1], n[2]) || 1;
    const wx = n[0] / length;
    const wy = n[1] / length;
    const wz = n[2] / length;
    const nx = wx;
    const ny = wz;
    const nz = -wy;
    const wall = Math.abs(wz) < 0.5;
    const grime = wall && Number.isFinite(this.ground);
    // Every vertex of every shell passes here (a town's opening: 2.5-3 s of its 6 s of buildings): straight into the GPU's layout, its uv worked out there (`shellUv`).
    part.room(count);
    const position = part.position.array, normal = part.normal.array, paint = part.paint.array;
    octNormal(nx, ny, nz, FACE_NORMAL, 0);
    const qx = FACE_NORMAL[0]!, qy = FACE_NORMAL[1]!;
    const rgb = c.rgb;
    const id = finishWear(part.finish, this.decay);
    if (faceIds.length < count) faceIds = new Int32Array(count * 2);
    const ids = faceIds;
    const bytes = st ? this.runBytes(st) : null;
    const flip = st ? this.runFlip(st, wx, wy) : 0;
    for (let i = 0; i < count; i++) {
      const p = points[i]!;
      const x = p[0], y = p[1], z = p[2];
      // Written past the vertices kept: the weld keeps it, or finds it laid already and the next one writes over it.
      const v = part.vertices, p3 = v * 3, p4 = v * SHELL_SHORTS, p2 = v * NORMAL_SHORTS;
      // Each -0 written +0 (x + 0, 0 - y), so the two weld: the GPU draws them alike.
      position[p3] = x + 0; position[p3 + 1] = z + 0; position[p3 + 2] = 0 - y;
      // No two stretches of wall quite the same tone, and the base weathered.
      // A vertex's own shade (a streak under a sill darker at its foot, `emitStreak`).
      const noise = this.noise;
      noise[0] = x / MACRO_SCALE; noise[1] = y / MACRO_SCALE; noise[2] = z / MACRO_SCALE;
      macroNoiseInto(noise);
      let tone = (0.97 + noise[3]! * 0.06) * (shades?.[i] ?? 1);
      if (grime) {
        const t = Math.min(1, Math.max(0, (z - this.ground) / GRIME_REACH));
        tone *= 0.8 + 0.2 * t * t * (3 - 2 * t);
      }
      normal[p2] = qx; normal[p2 + 1] = qy;
      paint[p4] = paintShort(rgb[0] * tone); paint[p4 + 1] = paintShort(rgb[1] * tone); paint[p4 + 2] = paintShort(rgb[2] * tone); paint[p4 + 3] = id;
      if (st && bytes) this.stampRun(part, v, st, i, flip, bytes);
      ids[i] = part.weld();
    }
    // In three's axes (x, z, -y): the winding measured against the normal.
    const p0 = points[0]!, p1 = points[1]!, p2 = points[2]!;
    const ux = p1[0] - p0[0], uy = p1[2] - p0[2], uz = p0[1] - p1[1];
    const vx = p2[0] - p0[0], vy = p2[2] - p0[2], vz = p0[1] - p2[1];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    const forward = cx * nx + cy * ny + cz * nz >= 0;
    const index = part.index.room((count - 2) * 3);
    let k3 = part.index.length;
    for (let k = 1; k + 1 < count; k++) {
      index[k3++] = ids[0]!;
      index[k3++] = forward ? ids[k]! : ids[k + 1]!;
      index[k3++] = forward ? ids[k + 1]! : ids[k]!;
    }
    part.index.length = k3;
  }

  /** The run's bays go along the face's own horizontal (`shellUv`'s t, as the shader works it out) or against it: the shader turns it round; (wx, wy): the face's normal on the plan, world axes. */
  private runFlip(st: FacadeStamp, wx: number, wy: number): number {
    return Math.hypot(wx, wy) > 1e-6 && -wy * st.tx + wx * st.ty < 0 ? FACADE_FLIP : 0;
  }

  /** A run's opening and frames as bytes, the same on each of its vertices. */
  private runBytes(st: FacadeStamp): readonly number[] {
    return [toByte(st.opening[0]), toByte(st.opening[1]), toByte(st.opening[2]), toByte(st.opening[3]), toByte(st.trim[0]), toByte(st.trim[1]), toByte(st.trim[2]), st.office ? 255 : 0];
  }

  /** The window grid of the run's corner `i`, written at vertex `v` before it is welded. */
  private stampRun(part: ShellPart, v: number, st: FacadeStamp, i: number, flip: number, bytes: readonly number[]): void {
    const facade = part.facade!.array, grid = part.grid!.array, opening = part.opening!.array;
    const [u, w] = st.uv[i]!;
    const f = v * FACADE_FLOATS, g = v * FACADE_GRID, o = v * FACADE_BYTES;
    // Half floats (`cellArrays.ts` `FACADE_FLOATS`): a bay's width and a storey's height to a millimetre or two.
    facade[f] = DataUtils.toHalfFloat(st.W); facade[f + 1] = DataUtils.toHalfFloat(st.H);
    grid[g] = u; grid[g + 1] = w; grid[g + 2] = st.kind + flip; grid[g + 3] = st.volume * 4 + st.side;
    for (let k = 0; k < FACADE_BYTES; k++) opening[o + k] = bytes[k]!;
  }

  get triangles(): number {
    let n = 0;
    for (const parts of [this.parts, this.runs]) for (const part of parts.values()) n += part.index.length / 3;
    return n;
  }
}

export type V3 = [number, number, number];

export const UP: Readonly<V3> = Object.freeze([0, 0, 1] as V3);

export interface BayFace {
  /** Local start of the bay on the facade line, its along direction and outward normal. */
  ax: number;
  ay: number;
  tx: number;
  ty: number;
  nx: number;
  ny: number;
  z0: number;
  W: number;
  H: number;
}

export function sideFrame(v: Volume, side: FaceId, along: number, push = 0): Pick<BayFace, 'ax' | 'ay' | 'tx' | 'ty' | 'nx' | 'ny'> {
  const s = sideStart(v, side);
  const edge = edgeFrame(v, side);
  return { ax: s.x + s.tx * along + edge.nx * push, ay: s.y + s.ty * along + edge.ny * push, tx: s.tx, ty: s.ty, nx: edge.nx, ny: edge.ny };
}

export function sideFrameInto(out: BayFace, v: Volume, side: FaceId, along: number, push = 0): void {
  const edge = edgeFrame(v, side);
  let x: number, y: number, tx: number, ty: number;
  if (v.outline) { x = edge.x; y = edge.y; tx = edge.tx; ty = edge.ty; }
  else if (side === 0) { x = v.x; y = v.y; tx = 1; ty = 0; }
  else if (side === 1) { x = v.x + v.w; y = v.y; tx = 0; ty = 1; }
  else if (side === 2) { x = v.x; y = v.y + v.d; tx = 1; ty = 0; }
  else { x = v.x; y = v.y; tx = 0; ty = 1; }
  out.ax = x + tx * along + edge.nx * push; out.ay = y + ty * along + edge.ny * push;
  out.tx = tx; out.ty = ty; out.nx = edge.nx; out.ny = edge.ny;
}

export class Emitter {
  private readonly c: number;
  private readonly s: number;
  readonly parts: PartSink;

  private readonly b: Building;
  readonly shell: Shell;
  readonly furniture: FurnitureSink;
  constructor(
    b: Building,
    shell: Shell,
    parts: PartSink,
    /** Furniture pieces, by kind, drawn instanced from the furniture kit. */
    furniture: FurnitureSink = {},
  ) {
    this.b = b;
    this.shell = shell;
    this.furniture = furniture;
    this.c = Math.cos(b.rotation);
    this.s = Math.sin(b.rotation);
    this.parts = parts;
  }

  /** The building being emitted. */
  get building(): Building {
    return this.b;
  }

  /** A local plan point at absolute height z, in world axes. */
  L(lx: number, ly: number, z: number): V3 {
    return [this.b.x + lx * this.c - ly * this.s, this.b.y + lx * this.s + ly * this.c, z];
  }

  /** A local direction as a world normal. */
  N(dx: number, dy: number, dz = 0): V3 {
    return [dx * this.c - dy * this.s, dx * this.s + dy * this.c, dz];
  }

  /** A point on a bay face: `a` along, `h` up, `depth` into the wall. */
  P(f: BayFace, a: number, h: number, depth: number): V3 {
    return this.L(f.ax + f.tx * a - f.nx * depth, f.ay + f.ty * a - f.ny * depth, f.z0 + h);
  }

  /** The four corners a rectangle, strip or jamb hands `Shell.face`, written over by each (the face reads them and keeps none): DO NOT make four points and their list for each face of every bay. */
  private readonly quad: [V3, V3, V3, V3] = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];

  /** Where `put` works out an instance's place. */
  private readonly spot: V3 = [0, 0, 0];

  /** A facade prop's colour, set from its hex for each prop (`put` copies it at once): DO NOT make a Color for each. */
  readonly propColour = new Color();

  /** `P` written into `out`, the same arithmetic. */
  private corner(out: V3, f: BayFace, a: number, h: number, depth: number): void {
    const lx = f.ax + f.tx * a - f.nx * depth, ly = f.ay + f.ty * a - f.ny * depth;
    out[0] = this.b.x + lx * this.c - ly * this.s;
    out[1] = this.b.y + lx * this.s + ly * this.c;
    out[2] = f.z0 + h;
  }

  /** A rectangle on (or parallel to) a bay face. */
  rect(f: BayFace, a0: number, a1: number, h0: number, h1: number, depth: number, n: Readonly<V3>, c: Paint): void {
    if (a1 - a0 < 1e-4 || h1 - h0 < 1e-4) return;
    const q = this.quad;
    this.corner(q[0], f, a0, h0, depth); this.corner(q[1], f, a1, h0, depth); this.corner(q[2], f, a1, h1, depth); this.corner(q[3], f, a0, h1, depth);
    this.shell.face(q, n, c);
  }

  /** An axis-aligned box in the local plan: sides and top (the bottom is never seen). */
  /** A round tank or drum: an upright prism of `sides` faces, capped on top. */
  cylinder(cx: number, cy: number, r: number, z0: number, z1: number, c: Paint, top: Paint = c, sides = 14): void {
    const sh = this.shell;
    const at = (k: number): [number, number] => [cx + Math.cos((k / sides) * Math.PI * 2) * r, cy + Math.sin((k / sides) * Math.PI * 2) * r];
    for (let k = 0; k < sides; k++) {
      const [ax, ay] = at(k), [bx, by] = at(k + 1);
      const mid = ((k + 0.5) / sides) * Math.PI * 2;
      sh.face([this.L(ax, ay, z0), this.L(bx, by, z0), this.L(bx, by, z1), this.L(ax, ay, z1)], this.N(Math.cos(mid), Math.sin(mid)), c);
      sh.face([this.L(cx, cy, z1), this.L(ax, ay, z1), this.L(bx, by, z1)], UP, top);
    }
  }

  box(x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, c: Paint, top: Paint = c): void {
    if (z1 - z0 < 1e-4) return;
    // An element's box of one paint: an instance of the shell's box, its look laid as these faces' (`shellParts.ts`).
    if (this.apart && top === c && x1 - x0 > 1e-6 && y1 - y0 > 1e-6) {
      this.shellPart('lotBox', (x0 + x1) / 2, (y0 + y1) / 2, z0, z1, x1 - x0, y1 - y0, 0, c);
      return;
    }
    const sh = this.shell;
    sh.face([this.L(x0, y0, z0), this.L(x1, y0, z0), this.L(x1, y0, z1), this.L(x0, y0, z1)], this.N(0, -1), c);
    sh.face([this.L(x1, y1, z0), this.L(x0, y1, z0), this.L(x0, y1, z1), this.L(x1, y1, z1)], this.N(0, 1), c);
    sh.face([this.L(x1, y0, z0), this.L(x1, y1, z0), this.L(x1, y1, z1), this.L(x1, y0, z1)], this.N(1, 0), c);
    sh.face([this.L(x0, y1, z0), this.L(x0, y0, z0), this.L(x0, y0, z1), this.L(x0, y1, z1)], this.N(-1, 0), c);
    sh.face([this.L(x0, y0, z1), this.L(x1, y0, z1), this.L(x1, y1, z1), this.L(x0, y1, z1)], UP, top);
  }

  /** A box whose sides stand `inset` in from the edges of its top. */
  slab(x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, inset: number, c: Paint): void {
    if (z1 - z0 < 1e-4 || x1 - x0 <= 2 * inset || y1 - y0 <= 2 * inset) return;
    // An element's paving: an instance of the shell's, its sides stood in by its program (`shellParts.ts` `COVER_INSET`).
    if (this.apart && inset === COVER_INSET) {
      this.shellPart('lotSlab', (x0 + x1) / 2, (y0 + y1) / 2, z0, z1, x1 - x0, y1 - y0, 0, c);
      return;
    }
    const sh = this.shell;
    const [a0, b0, a1, b1] = [x0 + inset, y0 + inset, x1 - inset, y1 - inset];
    sh.face([this.L(a0, b0, z0), this.L(a1, b0, z0), this.L(a1, b0, z1), this.L(a0, b0, z1)], this.N(0, -1), c);
    sh.face([this.L(a1, b1, z0), this.L(a0, b1, z0), this.L(a0, b1, z1), this.L(a1, b1, z1)], this.N(0, 1), c);
    sh.face([this.L(a1, b0, z0), this.L(a1, b1, z0), this.L(a1, b1, z1), this.L(a1, b0, z1)], this.N(1, 0), c);
    sh.face([this.L(a0, b1, z0), this.L(a0, b0, z0), this.L(a0, b0, z1), this.L(a0, b1, z1)], this.N(-1, 0), c);
    sh.face([this.L(x0, y0, z1), this.L(x1, y0, z1), this.L(x1, y1, z1), this.L(x0, y1, z1)], UP, c);
  }

  /** A horizontal strip at height h, from depth d0 to d1 into the wall. */
  strip(f: BayFace, a0: number, a1: number, h: number, d0: number, d1: number, n: Readonly<V3>, c: Paint): void {
    const q = this.quad;
    this.corner(q[0], f, a0, h, d0); this.corner(q[1], f, a1, h, d0); this.corner(q[2], f, a1, h, d1); this.corner(q[3], f, a0, h, d1);
    this.shell.face(q, n, c);
  }

  /** A vertical strip across the wall's thickness at `a`, from h0 to h1. */
  jamb(f: BayFace, a: number, h0: number, h1: number, d0: number, d1: number, n: Readonly<V3>, c: Paint): void {
    const q = this.quad;
    this.corner(q[0], f, a, h0, d0); this.corner(q[1], f, a, h0, d1); this.corner(q[2], f, a, h1, d1); this.corner(q[3], f, a, h1, d0);
    this.shell.face(q, n, c);
  }

  /** An instance placed on a bay face, turned so its local +Z is the face's outward normal. */
  /** The space of the bay being drawn, for its panes (-1: none). */
  slot = -1;
  /** The room behind a pane centred `a` along the bay and `h` up it, for the bay being emitted (`roomBehind.ts`). */
  room: ((a: number, h: number) => readonly number[]) | null = null;
  /** The bay being emitted is flattened (the far level, `emitChunk` `far`): its wall and opening laid by `emitFacadeRuns`. */
  flat = false;

  put(kind: PartKind, f: BayFace, a: number, h: number, depth: number, sx: number, sy: number, sz: number, colour?: Color, turn = 0): void {
    // A flattened bay of the far level: what is set into its opening is drawn by the shader (`facadeLevel.ts`).
    if (this.flat && depth > 0 && SHADER_DRAWN.has(kind)) return;
    // Its place and the face's normal as `P` and `N` give them, with no point or normal made for each instance.
    const p = this.spot;
    this.corner(p, f, a, h, depth);
    const nx = f.nx * this.c - f.ny * this.s, ny = f.nx * this.s + f.ny * this.c;
    const rows = this.parts[kind];
    const i = rows.add(p[0], p[1], p[2], Math.atan2(nx, -ny) + turn, sx, sy, sz);
    if (colour) rows.colour(i, colour.r, colour.g, colour.b);
    if (rows.glassy) rows.pane(i, this.slot, this.room ? this.room(a, h) : null);
  }

  /** An element being emitted (`emitElement`): its boxes are the shell's parts where the shell lets them be (`Shell.apart`). */
  inElement = false;
  get apart(): boolean {
    return this.inElement && this.shell.apart;
  }

  /** A shell's part (`shellParts.ts`) centred at plan point (lx, ly), from z0 to z1, `along` its own x turned `turn` from the building's and `across` it. */
  shellPart(kind: ShellPartKind, lx: number, ly: number, z0: number, z1: number, along: number, across: number, turn: number, c: Paint): void {
    const p = this.L(lx, ly, (z0 + z1) / 2);
    const rows = this.parts[kind];
    const i = rows.add(p[0], p[1], p[2], this.b.rotation + turn, along, z1 - z0, across);
    rows.colour(i, c.rgb[0], c.rgb[1], c.rgb[2]);
    const ground = this.shell.ground;
    rows.look(i, finishId(c.finish), wearShort(this.shell.decay), Number.isFinite(ground) ? ground : NO_GROUND);
  }

  /** An instance at a point of the building's plan (`L`), square to the building, its centre at height `z`. */
  putAt(kind: PartKind, lx: number, ly: number, z: number, sx: number, sy: number, sz: number): void {
    const p = this.L(lx, ly, z);
    const n = this.N(0, 1);
    this.parts[kind].add(p[0], p[1], p[2], Math.atan2(n[0], -n[1]), sx, sy, sz);
  }
}

export type SlotAllocator = (building: number, level: number, volume: number, x: number, y: number) => number;

export function slotOfBay(b: Building, v: Volume, bay: FacadeBay, spaces: ReturnType<typeof deriveSpaces>, slots: SlotAllocator): number {
  if (b.id < 0) return -1;
  const floor = spaces.find((f) => f.volume === v.id && f.level === bay.level);
  if (!floor) return -1;
  // A step inside the facade, in the building's frame.
  const inside = worldToLocal(b, { x: bay.x - bay.nx * m(0.6) + 0, y: bay.y - bay.ny * m(0.6) });
  const along = (bay.width ?? 0) / 2;
  void along;
  const sp = floor.spaces.find((q) => inside.x >= q.x - 1 && inside.x <= q.x + q.w + 1 && inside.y >= q.y - 1 && inside.y <= q.y + q.d + 1)
    ?? floor.spaces[0];
  return sp ? slots(b.id, bay.level, v.id, sp.x, sp.y) : -1;
}

export const bayKey = (volume: number, level: number, side: number, index: number): number => ((volume * 2048 + level + 1024) * 4 + side) * 1_048_576 + index + 1;

export const shaded = (c: Paint, k: number): Paint => ({ rgb: [c.rgb[0] * k, c.rgb[1] * k, c.rgb[2] * k], finish: c.finish });

export const wearShort = (x: number): number => wearByte(x) / WEAR_STEPS;

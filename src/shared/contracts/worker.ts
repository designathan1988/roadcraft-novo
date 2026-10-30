// Contract between the page and the worker pool. Types and plain data only.

import type { Profile } from '../../roads/profiles.ts';

export interface SharedWorld {
  /** Terrain heights (see world/heights.ts). */
  heights: SharedArrayBuffer;
  /** Painted ground and water (see world/ground.ts). */
  ground: SharedArrayBuffer;
  water: SharedArrayBuffer;
}

/** Generic buildings of a tile/cell, in columns. */
/**
 * Buildings in columns. A building is the lot (centre, front w, depth d, turn) +
 * zone + floors + seed + style: the procedural generator does the rest. The
 * lot's front faces local +z (towards the road). Zone 0 = a generic box
 * of height h and colour color (the old worst-case loader).
 */
export interface BoxColumns {
  count: number;
  x: Float32Array; z: Float32Array;
  w: Float32Array; d: Float32Array; h: Float32Array;
  rot: Float32Array;
  color: Uint32Array; // 0xRRGGBB
  seed: Uint32Array;
  zone: Uint8Array; floors: Uint8Array; style: Uint8Array;
  /** The building's function (0 = ordinary). */
  fn: Uint8Array;
  /**
   * Polygon lot (save version 7). shapeN[i] = number of corners (0 = the lot is the rectangle w × d). The corners
   * are in `shape`, SHAPE_STRIDE int16 per building: (x, z) pairs in decimetres in the lot frame (x along the
   * front, z towards the front, the same frame as w/d and `lotToWorld` in world/lotEdit.ts), counter-clockwise seen
   * from above (x right, z up), simple (no crossing edges), all inside the rectangle ±w/2 × ±d/2. Up to SHAPE_MAX
   * corners; a curved side arrives already sampled into corners. The building generator fits the building into it.
   */
  shapeN: Uint8Array;
  shape: Int16Array;
  /** City minute the building was built or last renovated (World.clock); decay is derived from it. */
  built: Float32Array;
  /**
   * How run-down it is, in tenths: 0 (new) to 10 (falling apart). Roadcraft's ageing: 5 days of grace, then 30
   * days to fall apart without maintenance (world/decay.ts). Filled by the page when it gathers the boxes; the
   * cell is marked dirty only when a building passes a tenth. The drawing does not read it yet (no stains or broken windows).
   */
  decay: Uint8Array;
}

/** Most corners of a polygon lot, and int16 per building in BoxColumns.shape. */
export const SHAPE_MAX = 16;
export const SHAPE_STRIDE = SHAPE_MAX * 2;
/** Decimetres per unit of BoxColumns.shape. */
export const SHAPE_SCALE = 10;

/** A compact mesh ready for the GPU. Positions relative to the origin, as snorm16 × scale. */
export interface PackedMesh {
  originX: number; originY: number; originZ: number;
  scale: number;
  vertexCount: number;
  position: Int16Array; // xyzw, snorm
  normal: Int8Array; // oct xy + 2 spare, snorm
  color: Uint8Array; // rgb + material, unorm
  index: Uint16Array | Uint32Array;
  /** An extra attribute per vertex (roads: u, v, to the end, code). */
  extra?: Float32Array;
  /** Facade per vertex (buildings): style, seed, kind, column width. */
  fac?: Uint8Array;
  /** Wall coordinates (u in columns, h in metres above the base), snorm16 × 512. */
  fuv?: Int16Array;
  /** Local box (metres, relative to the origin). */
  minY: number; maxY: number;
}

export interface JobPayloads {
  terrainGen: { seed: number; tile: number };
  debugTile: { seed: number; tile: number };
  buildingMesh: { boxes: BoxColumns; originX: number; originZ: number; extent: number; lod: number };
  roadMesh: { graph: RoadGraph; originX: number; originZ: number; extent: number; lod: number };
  /** The terrain cut along the roads of a road cell (jobs/terrainSeams.ts): the roads reaching within its pad. */
  terrainSeams: { graph: RoadGraph; originX: number; originZ: number };
  roadPaint: { graph: RoadGraph; tile: number };
  lots: { graph: RoadGraph; cell: number };
  props: { graph: RoadGraph; boxes: BoxColumns; cell: number; items?: Float32Array; biome?: number; parts40?: boolean };
  cityGen: { seed: number; medium?: boolean };
  conform: { tile: number; segs: Float32Array };
  /**
   * A tile's save file made from the page's snapshot (the page writes it). ground and water: the tile's painted ground
   * and water, copied by the page with the rest of the snapshot.
   */
  packTile: { tile: number; heights: Uint16Array; boxes: BoxColumns; roads: RoadSave; ground?: Uint32Array; water?: Float32Array };
  /** A tile's save file read by the page: checked against `hash` ('' = not recorded), decoded, terrain written. */
  unpackTile: { tile: number; data: Uint8Array; hash: string };
}

export interface JobResults {
  terrainGen: { tile: number; min: number; max: number; hasWater: boolean };
  debugTile: { tile: number; roadNodes: Float32Array; roadSegs: Int32Array; min: number; max: number };
  buildingMesh: { mesh: PackedMesh | null };
  roadMesh: { mesh: PackedMesh | null };
  /** `holes`: per 4 m cell of the road cell, 1 where the terrain does not draw its own cell. */
  terrainSeams: { mesh: PackedMesh | null; holes: Uint8Array };
  roadPaint: { tile: number; texels: Uint8Array; coarse: Uint8Array };
  lots: { cell: number; lots: LotColumns };
  props: { cell: number; props: PropColumns };
  cityGen: { nodes: Float32Array; segs: Int32Array; centers: Float32Array };
  conform: { tile: number; min: number; max: number };
  /** The compressed file and its SHA-256. */
  packTile: { tile: number; data: Uint8Array; hash: string };
  /** ok false: the file cannot be used (`reason`), and nothing was written. hash: the file's SHA-256. */
  unpackTile: { tile: number; ok: boolean; reason?: string; hash: string; min: number; max: number; boxes: BoxColumns | null; roads: RoadSave | null; hasWater?: boolean };
}

export type JobKind = keyof JobPayloads;

/** A tile's roads in the save: nodes [id, x, z, y] and segments [id, a, b, cx, cz, profile, bits, left zone, right zone]. */
export interface RoadSave { nodes: Float32Array; segs: Float32Array; /** Street items (version 4): 6 numbers per item. */ items?: Float32Array }
export const NODE_REC = 4;
export const SEG_REC = 9;
/** A segment record in save version 2 (without zones). */
export const SEG_REC_V2 = 7;

export type ToWorker =
  | { type: 'init'; shared: SharedWorld }
  | { type: 'job'; id: number; kind: JobKind; payload: unknown }
  | { type: 'profiles'; list: Profile[] };

export type FromWorker =
  | { type: 'done'; id: number; result: unknown }
  | { type: 'error'; id: number; message: string };

/** The column buffers, to transfer. */
export function boxTransfer(b: BoxColumns): ArrayBuffer[] {
  return boxColumnList(b).map((a) => a.buffer as ArrayBuffer);
}

/** Columns in save order (version 3: 11, 4: + fn, 7: + shapeN, shape, built, decay). */
export function boxColumnList(b: BoxColumns): Array<Float32Array | Uint32Array | Uint8Array | Int16Array> {
  return [b.x, b.z, b.w, b.d, b.h, b.rot, b.color, b.seed, b.zone, b.floors, b.style, b.fn, b.shapeN, b.shape, b.built, b.decay];
}

/** Elements per building of a column (shape has SHAPE_STRIDE, the rest 1). */
export function columnStride(b: BoxColumns, col: ArrayBufferView): number { return col === b.shape ? SHAPE_STRIDE : 1; }

export function emptyBoxes(n: number): BoxColumns {
  return {
    count: n,
    x: new Float32Array(n), z: new Float32Array(n),
    w: new Float32Array(n), d: new Float32Array(n), h: new Float32Array(n),
    rot: new Float32Array(n), color: new Uint32Array(n),
    seed: new Uint32Array(n), zone: new Uint8Array(n), floors: new Uint8Array(n), style: new Uint8Array(n),
    fn: new Uint8Array(n),
    shapeN: new Uint8Array(n), shape: new Int16Array(n * SHAPE_STRIDE), built: new Float32Array(n), decay: new Uint8Array(n),
  };
}

/** A cell's lots (front towards local +z, like the buildings). */
export interface LotColumns {
  count: number;
  x: Float32Array; z: Float32Array; w: Float32Array; d: Float32Array; rot: Float32Array;
  zone: Uint8Array; seed: Uint32Array;
  /** Profile of the road in front (an avenue gives a taller building). */
  profile: Uint16Array;
}

export function lotTransfer(l: LotColumns): ArrayBuffer[] {
  return [l.x, l.z, l.w, l.d, l.rot, l.zone, l.seed, l.profile].map((a) => a.buffer as ArrayBuffer);
}

/**
 * A cell's props (trees, poles, traffic lights, benches...). Per instance:
 * x, y, z and w = heading (12 bits) + variant (4) * 4096 + scale (6) * 65536;
 * extra = kind (4 bits) + key * 16 (traffic light: node * 8 + arm; others: random).
 */
export interface PropColumns {
  count: number;
  data: Float32Array;
  extra: Uint32Array;
}

export function propTransfer(p: PropColumns): ArrayBuffer[] {
  return [p.data.buffer as ArrayBuffer, p.extra.buffer as ArrayBuffer];
}

export function meshTransfer(m: PackedMesh): ArrayBuffer[] {
  const list: ArrayBufferView[] = [m.position, m.normal, m.color, m.index];
  if (m.extra) list.push(m.extra);
  if (m.fac) list.push(m.fac);
  if (m.fuv) list.push(m.fuv);
  return list.map((a) => a.buffer as ArrayBuffer);
}

/** A piece of the road network sent to a worker: the segments and nodes to build and the neighbours that set the set-backs. */
export interface RoadGraph {
  nodeCount: number;
  nx: Float32Array; nz: Float32Array; ny: Float32Array;
  /** 1 = build this node's junction/end here. */
  nodeOwn: Uint8Array;
  segCount: number;
  sa: Int32Array; sb: Int32Array; // indices into the node arrays
  scx: Float32Array; scz: Float32Array;
  sprofile: Uint16Array; sflags: Uint8Array;
  /** 1 = build this segment here. */
  segOwn: Uint8Array;
  /** The segment's real id (for the traffic occupancy in the shader). */
  sid: Int32Array;
  /** Zones of the left/right sides. */
  szl: Uint8Array; szr: Uint8Array;
  /** Each node's real id (traffic lights). */
  nid: Int32Array;
  /** Each node's effective control (Ctl). */
  nctl: Uint8Array;
  /** 1 = a straight joint: the node has two arms in line (one street cut in two), not a corner. */
  njoint: Uint8Array;
  /** Each segment end's rule: end a in bits 0-2, end b in bits 3-5 (Rule). */
  srule: Uint8Array;
}

export function roadGraphTransfer(g: RoadGraph): ArrayBuffer[] {
  return [g.nx, g.nz, g.ny, g.nodeOwn, g.sa, g.sb, g.scx, g.scz, g.sprofile, g.sflags, g.segOwn, g.sid, g.szl, g.szr, g.nid, g.nctl, g.srule].map((a) => a.buffer as ArrayBuffer);
}

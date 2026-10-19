// Binary per-tile save, compressed, in the origin private file system (OPFS).
// Runs in the worker. Only tiles that changed are written.

import { HEIGHT_TILE_RES, MAP_TILES, SAVE_VERSION, TERRAIN_MAX_Y, TERRAIN_MIN_Y } from '../config.ts';
import { heightIndex } from '../world/heights.ts';
import { SEG_REC, SEG_REC_V2, boxColumnList, columnStride, emptyBoxes, type BoxColumns, type RoadSave } from './protocol.ts';
import { generatedBuilt } from '../world/decay.ts';

const MAGIC_TILE = 0x31544443; // 'CDT1'
const HEIGHT_Q = 100; // centimeters

export function quantizeHeight(h: number): number {
  const v = Math.round((h - TERRAIN_MIN_Y) * HEIGHT_Q);
  return v < 0 ? 0 : v > 65535 ? 65535 : v;
}
export function dequantizeHeight(q: number): number { return q / HEIGHT_Q + TERRAIN_MIN_Y; }
export const HEIGHT_MAX_Q = quantizeHeight(TERRAIN_MAX_Y);

export function encodeTile(tile: number, heights: Uint16Array, boxes: BoxColumns, roads: RoadSave, ground: Uint32Array = new Uint32Array(0), water: Float32Array = new Float32Array(0)): Uint8Array {
  const n = boxes.count;
  const cols = boxColumnList(boxes);
  const colBytes = cols.reduce((sum, c) => sum + n * columnStride(boxes, c) * c.BYTES_PER_ELEMENT, 0);
  const items = roads.items ?? new Float32Array(0);
  const bytes = 16 + heights.byteLength + 4 + colBytes + 8 + roads.nodes.byteLength + roads.segs.byteLength + 4 + items.byteLength + 8 + ground.byteLength + water.byteLength;
  const buf = new ArrayBuffer(bytes);
  const dv = new DataView(buf);
  dv.setUint32(0, MAGIC_TILE, true);
  dv.setUint32(4, SAVE_VERSION, true);
  dv.setUint32(8, tile, true);
  dv.setUint32(12, heights.length, true);
  let o = 16;
  new Uint8Array(buf, o, heights.byteLength).set(new Uint8Array(heights.buffer, heights.byteOffset, heights.byteLength));
  o += heights.byteLength;
  dv.setUint32(o, n, true); o += 4;
  for (const col of cols) {
    const b = n * columnStride(boxes, col) * col.BYTES_PER_ELEMENT;
    new Uint8Array(buf, o, b).set(new Uint8Array(col.buffer, col.byteOffset, b));
    o += b;
  }
  // roads (version 2)
  dv.setUint32(o, roads.nodes.length, true); o += 4;
  dv.setUint32(o, roads.segs.length, true); o += 4;
  for (const arr of [roads.nodes, roads.segs]) {
    new Uint8Array(buf, o, arr.byteLength).set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
    o += arr.byteLength;
  }
  // street items (version 4)
  dv.setUint32(o, items.length, true); o += 4;
  new Uint8Array(buf, o, items.byteLength).set(new Uint8Array(items.buffer, items.byteOffset, items.byteLength));
  o += items.byteLength;
  // painted ground and water (version 5)
  dv.setUint32(o, ground.length, true); o += 4;
  new Uint8Array(buf, o, ground.byteLength).set(new Uint8Array(ground.buffer, ground.byteOffset, ground.byteLength)); o += ground.byteLength;
  dv.setUint32(o, water.length, true); o += 4;
  new Uint8Array(buf, o, water.byteLength).set(new Uint8Array(water.buffer, water.byteOffset, water.byteLength));
  return new Uint8Array(buf);
}

export function decodeTile(data: Uint8Array): { tile: number; heights: Uint16Array; boxes: BoxColumns; roads: RoadSave; ground?: Uint32Array; water?: Float32Array } {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (dv.getUint32(0, true) !== MAGIC_TILE) throw new Error('arquivo de ladrilho inválido');
  const version = dv.getUint32(4, true);
  if (version > SAVE_VERSION) throw new Error(`versão de salvamento ${version} mais nova que o jogo`);
  const tile = dv.getUint32(8, true);
  const hn = dv.getUint32(12, true);
  let o = 16;
  const heights = new Uint16Array(hn);
  new Uint8Array(heights.buffer).set(data.subarray(o, o + hn * 2));
  o += hn * 2;
  const n = dv.getUint32(o, true); o += 4;
  const boxes = emptyBoxes(n);
  // version < 3: only the first 7 columns (generic boxes); < 4: no function; < 7: no polygon, built or decay
  const cols = boxColumnList(boxes).slice(0, version >= 7 ? 16 : version >= 4 ? 12 : version >= 3 ? 11 : 7);
  for (const col of cols) {
    const b = n * columnStride(boxes, col) * col.BYTES_PER_ELEMENT;
    new Uint8Array(col.buffer).set(data.subarray(o, o + b));
    o += b;
  }
  // older saves: each building gets the spread "built" of a generated one (the town does not age all at once)
  if (version < 7) for (let i = 0; i < n; i++) boxes.built[i] = generatedBuilt(boxes.seed[i]);
  const roads: RoadSave = { nodes: new Float32Array(0), segs: new Float32Array(0) };
  if (version >= 2) {
    const nn = dv.getUint32(o, true); o += 4;
    const ns = dv.getUint32(o, true); o += 4;
    roads.nodes = new Float32Array(nn); new Uint8Array(roads.nodes.buffer).set(data.subarray(o, o + nn * 4)); o += nn * 4;
    roads.segs = new Float32Array(ns); new Uint8Array(roads.segs.buffer).set(data.subarray(o, o + ns * 4)); o += ns * 4;
    if (version === 2) roads.segs = widenSegs(roads.segs);
  }
  if (version >= 4) {
    const ni = dv.getUint32(o, true); o += 4;
    roads.items = new Float32Array(ni); new Uint8Array(roads.items.buffer).set(data.subarray(o, o + ni * 4)); o += ni * 4;
  }
  let ground: Uint32Array | undefined, water: Float32Array | undefined;
  if (version >= 5) {
    const ng = dv.getUint32(o, true); o += 4;
    ground = new Uint32Array(ng); new Uint8Array(ground.buffer).set(data.subarray(o, o + ng * 4)); o += ng * 4;
    const nw = dv.getUint32(o, true); o += 4;
    water = new Float32Array(nw); new Uint8Array(water.buffer).set(data.subarray(o, o + nw * 4)); o += nw * 4;
  }
  return { tile, heights, boxes, roads, ground, water };
}

/** Copies a tile's quantized heights (done on the page, proportional to the tile). */
export function packTileHeights(src: Float32Array, tile: number): Uint16Array {
  const tx = tile % MAP_TILES, tz = (tile / MAP_TILES) | 0;
  const out = new Uint16Array(HEIGHT_TILE_RES * HEIGHT_TILE_RES);
  const base = heightIndex(tx * HEIGHT_TILE_RES, tz * HEIGHT_TILE_RES);
  for (let i = 0; i < out.length; i++) out[i] = quantizeHeight(src[base + i]);
  return out;
}

/** Writes a tile's heights into the shared array and returns min/max. */
export function unpackTileHeights(dst: Float32Array, tile: number, q: Uint16Array): { min: number; max: number } {
  const tx = tile % MAP_TILES, tz = (tile / MAP_TILES) | 0;
  const base = heightIndex(tx * HEIGHT_TILE_RES, tz * HEIGHT_TILE_RES);
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < q.length; i++) {
    const h = dequantizeHeight(q[i]);
    dst[base + i] = h;
    if (h < min) min = h;
    if (h > max) max = h;
  }
  return { min, max };
}

/** Version 2 had no zones: appends two zeros per segment. */
function widenSegs(old: Float32Array): Float32Array {
  const n = old.length / SEG_REC_V2;
  const out = new Float32Array(n * SEG_REC);
  for (let i = 0; i < n; i++) out.set(old.subarray(i * SEG_REC_V2, (i + 1) * SEG_REC_V2), i * SEG_REC);
  return out;
}

async function compress(data: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

async function decompress(data: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** The storage says the entry is not there (anything else it throws is a failure of the storage itself). */
const notThere = (err: unknown) => { const n = (err as { name?: string })?.name; return n === 'NotFoundError' || n === 'TypeMismatchError'; };

/** The save folder; null when it does not exist. Throws when the storage fails (never reported as "no save"). */
async function slotDir(slot: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const saves = await root.getDirectoryHandle('saves', { create });
    return await saves.getDirectoryHandle(slot, { create });
  } catch (err) {
    if (notThere(err)) return null;
    throw new Error(`the save storage failed: ${(err as Error)?.message ?? String(err)}`);
  }
}

async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: Uint8Array): Promise<void> {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data as BlobPart);
  await w.close();
}

/** The file's bytes; null when it does not exist. Throws when the storage fails to read it. */
async function readFile(dir: FileSystemDirectoryHandle, name: string): Promise<Uint8Array | null> {
  try {
    const fh = await dir.getFileHandle(name);
    return new Uint8Array(await (await fh.getFile()).arrayBuffer());
  } catch (err) {
    if (notThere(err)) return null;
    throw new Error(`the save storage failed to read ${name}: ${(err as Error)?.message ?? String(err)}`);
  }
}

const tileName = (t: number) => `tile_${t.toString().padStart(4, '0')}.bin`;

export async function saveTile(slot: string, tile: number, heights: Uint16Array, boxes: BoxColumns, roads: RoadSave, ground?: Uint32Array, water?: Float32Array): Promise<number> {
  const dir = await slotDir(slot, true);
  if (!dir) throw new Error('armazenamento indisponível');
  const z = await compress(encodeTile(tile, heights, boxes, roads, ground, water));
  await writeFile(dir, tileName(tile), z);
  return z.byteLength;
}

/** A tile file's compressed bytes; null when it does not exist. Throws when the storage fails. */
export async function readTile(slot: string, tile: number): Promise<Uint8Array | null> {
  const dir = await slotDir(slot, false);
  return dir ? readFile(dir, tileName(tile)) : null;
}

/** Decodes a tile file's bytes. Throws when they are not a tile (a damaged file). */
export async function unpackTile(z: Uint8Array) {
  return decodeTile(await decompress(z));
}

export async function saveMeta(slot: string, meta: Uint8Array): Promise<number> {
  const dir = await slotDir(slot, true);
  if (!dir) throw new Error('armazenamento indisponível');
  await writeFile(dir, 'meta.bin', meta);
  return meta.byteLength;
}

export async function loadMeta(slot: string): Promise<Uint8Array | null> {
  const dir = await slotDir(slot, false);
  if (!dir) return null;
  return readFile(dir, 'meta.bin');
}

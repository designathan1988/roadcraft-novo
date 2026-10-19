// Save metadata: seed, game id, which tiles exist in the file, the camera,
// the hour and the bus lines. The tiles themselves are written by the workers.

import { SAVE_VERSION } from './config.ts';
import { TILE_COUNT } from './core/grid.ts';

const MAGIC_META = 0x314d4443; // 'CDM1'

export interface SaveMeta {
  seed: number;
  gameId: number;
  tiles: Uint8Array; // 1 = tile saved
  camera: Float64Array;
  /** Hour of day (optional in old saves). */
  hour?: number;
  /** Bus lines (Transit.encode). */
  transit?: Float64Array;
  /** Road profiles made by the player (JSON). */
  profiles?: string;
  /** Cash on hand (NaN in older saves: sandbox mode on; now the flag is in `extra`). */
  money?: number;
  /** Junctions with a chosen control (JSON of [node, spec]). */
  junctions?: string;
  /** Map biome. */
  biome?: number;
  /** Map settings added later (sky, weather, clouds…): free-form JSON; old saves lack it. */
  extra?: string;
}

/** The save is for another map size: the page reloads at that size. */
export class MapSizeError extends Error {
  readonly tiles: number;
  constructor(tiles: number) { super(`a save of a ${tiles} km map`); this.tiles = tiles; }
}

/**
 * The ids and the listed tiles of a map description, for any map size (`decodeMeta` refuses other sizes). Throws when
 * the bytes are not a map description.
 */
export function metaHeader(data: Uint8Array): { seed: number; gameId: number; tiles: Uint8Array } {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.byteLength < 20 || dv.getUint32(0, true) !== MAGIC_META) throw new Error('not a map description');
  const count = dv.getUint32(16, true);
  if (count > 4096 || data.byteLength < 20 + Math.ceil(count / 8)) throw new Error('map description cut short');
  const tiles = new Uint8Array(count);
  for (let i = 0; i < count; i++) tiles[i] = (dv.getUint8(20 + (i >> 3)) >> (i & 7)) & 1;
  return { seed: dv.getUint32(8, true), gameId: dv.getUint32(12, true), tiles };
}

export function encodeMeta(m: SaveMeta): Uint8Array {
  const bitBytes = Math.ceil(TILE_COUNT / 8);
  const prof = new TextEncoder().encode(m.profiles ?? '');
  const junc = new TextEncoder().encode(m.junctions ?? '');
  const extra = new TextEncoder().encode(m.extra ?? '');
  const buf = new ArrayBuffer(16 + 4 + bitBytes + 4 + m.camera.length * 8 + 8 + 4 + (m.transit?.length ?? 0) * 8 + 4 + prof.length + 8 + 4 + junc.length + 4 + 4 + extra.length);
  const dv = new DataView(buf);
  let o = 0;
  dv.setUint32(o, MAGIC_META, true); o += 4;
  dv.setUint32(o, SAVE_VERSION, true); o += 4;
  dv.setUint32(o, m.seed >>> 0, true); o += 4;
  dv.setUint32(o, m.gameId >>> 0, true); o += 4;
  dv.setUint32(o, TILE_COUNT, true); o += 4;
  for (let i = 0; i < TILE_COUNT; i++) if (m.tiles[i]) dv.setUint8(o + (i >> 3), dv.getUint8(o + (i >> 3)) | (1 << (i & 7)));
  o += bitBytes;
  dv.setUint32(o, m.camera.length, true); o += 4;
  for (let i = 0; i < m.camera.length; i++, o += 8) dv.setFloat64(o, m.camera[i], true);
  dv.setFloat64(o, m.hour ?? 10, true); o += 8;
  const tr = m.transit ?? new Float64Array(0);
  dv.setUint32(o, tr.length, true); o += 4;
  for (let i = 0; i < tr.length; i++, o += 8) dv.setFloat64(o, tr[i], true);
  dv.setUint32(o, prof.length, true); o += 4;
  new Uint8Array(buf, o, prof.length).set(prof); o += prof.length;
  dv.setFloat64(o, m.money ?? NaN, true); o += 8;
  dv.setUint32(o, junc.length, true); o += 4;
  new Uint8Array(buf, o, junc.length).set(junc); o += junc.length;
  dv.setUint32(o, m.biome ?? 0, true); o += 4;
  dv.setUint32(o, extra.length, true); o += 4;
  new Uint8Array(buf, o, extra.length).set(extra); o += extra.length;
  return new Uint8Array(buf, 0, o);
}

export function decodeMeta(data: Uint8Array): SaveMeta {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 0;
  if (dv.getUint32(o, true) !== MAGIC_META) throw new Error('not a map description');
  o += 4;
  const version = dv.getUint32(o, true); o += 4;
  if (version > SAVE_VERSION) throw new Error('a save from a newer version of the game');
  const seed = dv.getUint32(o, true); o += 4;
  const gameId = dv.getUint32(o, true); o += 4;
  const count = dv.getUint32(o, true); o += 4;
  if (count !== TILE_COUNT) throw new MapSizeError(Math.round(Math.sqrt(count)));
  const tiles = new Uint8Array(TILE_COUNT);
  for (let i = 0; i < TILE_COUNT; i++) tiles[i] = (dv.getUint8(o + (i >> 3)) >> (i & 7)) & 1;
  o += Math.ceil(TILE_COUNT / 8);
  const n = dv.getUint32(o, true); o += 4;
  const camera = new Float64Array(n);
  for (let i = 0; i < n; i++, o += 8) camera[i] = dv.getFloat64(o, true);
  const hour = o + 8 <= data.byteLength ? dv.getFloat64(o, true) : undefined;
  o += 8;
  let transit: Float64Array | undefined;
  if (o + 4 <= data.byteLength) {
    const k = dv.getUint32(o, true); o += 4;
    transit = new Float64Array(k);
    for (let i = 0; i < k; i++, o += 8) transit[i] = dv.getFloat64(o, true);
  }
  let profiles: string | undefined;
  if (o + 4 <= data.byteLength) {
    const k = dv.getUint32(o, true); o += 4;
    profiles = new TextDecoder().decode(data.subarray(o, o + k)); o += k;
  }
  const money = o + 8 <= data.byteLength ? dv.getFloat64(o, true) : undefined;
  o += 8;
  let junctions: string | undefined;
  if (o + 4 <= data.byteLength) {
    const k = dv.getUint32(o, true); o += 4;
    junctions = new TextDecoder().decode(data.subarray(o, o + k)); o += k;
  }
  const biome = o + 4 <= data.byteLength ? dv.getUint32(o, true) : 0;
  o += 4;
  let extra: string | undefined;
  if (o + 4 <= data.byteLength) {
    const k = dv.getUint32(o, true); o += 4;
    extra = new TextDecoder().decode(data.subarray(o, o + k)); o += k;
  }
  return { seed, gameId, tiles, camera, hour, transit, profiles, money, junctions, biome, extra };
}

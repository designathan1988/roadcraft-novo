// Map as a file, and copies of a save kept aside. A map file bundles one generation of a save (saveFiles.ts) for
// download; opening one commits it as a new generation of the slot. Before another city takes the slot, the city
// there is copied aside as a previous city (saves/anterior-<date>-<slot>); a save that cannot be read is copied
// untouched into quarantine (saves/quarentena-<date>-<slot>). Nothing here reads the world: it copies files.

import { metaHeader } from './save.ts';
import { CURRENT, SaveSlot, StoreError, type FileRef, type FileStore } from './saveFiles.ts';
import { sha256 } from './jobs/storage.ts';

const MAGIC = 'CIDADE-MAPA-1';

/** A map file that cannot be opened; `key` is the dictionary text for the player (save.file.*). */
export class MapFileError extends Error {
  readonly key: string;
  constructor(key: string, message: string) { super(message); this.key = key; }
}

/** Files in one package: [MAGIC][n] and, for each one, [name][size][bytes]. */
export function packFiles(files: Array<[string, Uint8Array]>): Blob {
  const enc = new TextEncoder();
  const parts: BlobPart[] = [enc.encode(MAGIC)];
  const n = new DataView(new ArrayBuffer(4)); n.setUint32(0, files.length, true);
  parts.push(n.buffer);
  for (const [name, data] of files) {
    const nm = enc.encode(name);
    const hdr = new DataView(new ArrayBuffer(8));
    hdr.setUint32(0, nm.length, true); hdr.setUint32(4, data.length, true);
    parts.push(hdr.buffer, nm, data as BlobPart);
  }
  return new Blob(parts, { type: 'application/octet-stream' });
}

/** The committed generation of the slot as a package (only its files: never those of earlier cities); null when none. */
export async function packSlot(slot: SaveSlot): Promise<Blob | null> {
  const g = (await slot.open()).generations[0];
  return g ? packFiles(await slot.pack(g)) : null;
}

/** Reads a map package into its files ([name, bytes]). Throws if the file is not a map or is cut. */
export async function readPackage(file: Blob): Promise<Array<[string, Uint8Array]>> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const head = new TextEncoder().encode(MAGIC);
  for (let i = 0; i < head.length; i++) if (buf[i] !== head[i]) throw new MapFileError('save.file.notMap', 'not a Roadcraft map file');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = head.length;
  if (o + 4 > buf.length) throw new MapFileError('save.file.cut', 'the map file is cut short');
  const count = dv.getUint32(o, true); o += 4;
  const files: Array<[string, Uint8Array]> = [];
  const dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (o + 8 > buf.length) throw new MapFileError('save.file.cut', 'the map file is cut short');
    const nl = dv.getUint32(o, true), dl = dv.getUint32(o + 4, true); o += 8;
    if (o + nl + dl > buf.length) throw new MapFileError('save.file.cut', 'the map file is cut short');
    const name = dec.decode(buf.subarray(o, o + nl)); o += nl;
    if (!/^[\w.-]+$/.test(name) || name === '.' || name === '..') throw new MapFileError('save.file.damaged', 'the map file has an invalid file name');
    files.push([name, buf.slice(o, o + dl)]); o += dl;
  }
  if (!files.some(([n]) => n.startsWith('meta'))) throw new MapFileError('save.file.damaged', 'the map file has no map description');
  return files;
}

/** A whole save taken out of a package: its map description and every tile's file. */
export interface PackedSave { meta: Uint8Array; tiles: Map<number, Uint8Array>; seed: number; gameId: number }

/**
 * The save a package holds, checked: a generation (current.json, its manifest, and files that match it) or a save
 * from before generations (meta.bin and the tile files its map description lists; files of other tiles, which older
 * exports carried from earlier cities, are left out). Throws when a file is missing or does not match.
 */
export async function savedIn(files: Array<[string, Uint8Array]>): Promise<PackedSave> {
  const byName = new Map(files);
  const json = (name: string) => { const b = byName.get(name); if (!b) throw new MapFileError('save.file.damaged', `the map file has no ${name}`); return JSON.parse(new TextDecoder().decode(b)) as unknown; };
  const checked = async (ref: FileRef) => {
    const b = byName.get(ref.file);
    if (!b) throw new MapFileError('save.file.damaged', `the map file has no ${ref.file}`);
    if (b.length !== ref.size || (ref.hash && await sha256(b) !== ref.hash)) throw new MapFileError('save.file.damaged', `${ref.file} in the map file is damaged`);
    return b;
  };
  const tiles = new Map<number, Uint8Array>();
  let meta: Uint8Array;
  if (byName.has(CURRENT)) {
    const cur = json(CURRENT) as { manifest?: FileRef };
    if (typeof cur?.manifest?.file !== 'string') throw new MapFileError('save.file.damaged', 'the map file has a broken commit record');
    const man = await checked(cur.manifest);
    const m = JSON.parse(new TextDecoder().decode(man)) as { meta: FileRef; tiles: Array<[number, string, number, string]> };
    meta = await checked(m.meta);
    for (const [t, file, size, hash] of m.tiles) tiles.set(t, await checked({ file, size, hash }));
  } else {
    meta = byName.get('meta.bin') ?? files.find(([n]) => n.startsWith('meta'))![1];
    const listed = metaHeader(meta).tiles;
    for (let t = 0; t < listed.length; t++) {
      if (!listed[t]) continue;
      const b = byName.get(`tile_${t.toString().padStart(4, '0')}.bin`);
      if (!b) throw new MapFileError('save.file.damaged', `the map file lacks the file of tile ${t}`);
      tiles.set(t, b);
    }
  }
  const h = metaHeader(meta);
  return { meta, tiles, seed: h.seed, gameId: h.gameId };
}

/** Date and time for folder names (milliseconds included: two copies in the same second get two folders). */
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);

/** A folder name `<prefix>-<date>-<slot>` not used yet. */
async function freshFolder(store: FileStore, prefix: string, slot: string): Promise<string> {
  const have = new Set(await store.folders());
  const base = `${prefix}-${stamp()}`;
  let name = `${base}-${slot}`;
  for (let k = 2; have.has(name); k++) name = `${base}.${k}-${slot}`;
  return name;
}

/** Folders `<prefix>-*-<slot>`, oldest first. */
async function foldersOf(store: FileStore, prefix: string, slot: string): Promise<string[]> {
  return (await store.folders()).filter((n) => n.startsWith(`${prefix}-`) && n.endsWith(`-${slot}`)).sort();
}

/** How many previous cities and quarantined saves are kept per slot (the oldest beyond that are removed). */
const PREVIOUS_KEPT = 3;
const QUARANTINES_KEPT = 3;

async function prune(store: FileStore, folders: string[], keep: number): Promise<void> {
  for (const old of folders.slice(0, Math.max(0, folders.length - keep))) await store.removeFolder(old).catch((err: unknown) => console.warn('save: not removed', old, err));
}

/**
 * Before another city takes the slot: the city saved there (its committed generation; every file when no generation
 * checks out) is copied to `saves/anterior-<date>-<slot>`. Only the last PREVIOUS_KEPT previous cities are kept.
 * Returns the folder name, or null when the slot is empty. Throws when the copy fails.
 */
export async function keepPreviousCity(slot: SaveSlot): Promise<string | null> {
  const { store, folder } = slot;
  let g;
  try {
    const opened = await slot.open();
    if (!opened.found) return null;
    g = opened.generations[0] ?? null;
  } catch (err) {
    if (err instanceof StoreError) throw err;
    g = null; // a save of another map size: kept as it is
  }
  const name = await freshFolder(store, 'anterior', folder);
  if (g) await slot.copyGeneration(g, name); else await slot.copyAll(name);
  await prune(store, await foldersOf(store, 'anterior', folder), PREVIOUS_KEPT);
  return name;
}

/**
 * Quarantine (Roadcraft: an unreadable map is never deleted): every file of the slot is copied untouched into
 * `saves/quarentena-<date>-<slot>`, so it can be sent for repair. The same files are quarantined once: opening the same
 * damaged save again returns the folder it already went to. Only the last QUARANTINES_KEPT are kept. Returns the
 * folder name, or null when the slot is empty or the copy failed.
 */
export async function quarantineSlot(slot: SaveSlot, why: string): Promise<string | null> {
  const { store, folder } = slot;
  try {
    // what identifies these files: every name and size, and the contents of the small ones (commit record, manifests,
    // map descriptions), which change with every save
    const files: string[] = [];
    for (const e of (await store.list(folder)).sort((x, y) => (x.name < y.name ? -1 : 1))) {
      const small = /^(current|manifest|meta)/.test(e.name) ? await store.read(folder, e.name) : null;
      files.push(`${e.name}:${e.size}:${small ? await sha256(small) : ''}`);
    }
    if (!files.length) return null;
    const key = await sha256(new TextEncoder().encode(files.join('\n')));
    const earlier = await foldersOf(store, 'quarentena', folder);
    for (const q of earlier) {
      const note = await store.read(q, 'quarantine.json').catch(() => null);
      if (note && (JSON.parse(new TextDecoder().decode(note)) as { key?: string }).key === key) return q;
    }
    const name = await freshFolder(store, 'quarentena', folder);
    await slot.copyAll(name);
    await store.write(name, 'quarantine.json', new TextEncoder().encode(JSON.stringify({ key, why, at: new Date().toISOString() })));
    await prune(store, await foldersOf(store, 'quarentena', folder), QUARANTINES_KEPT);
    return name;
  } catch (err) {
    console.error('save: quarantine failed', err);
    return null;
  }
}
/** A previous city kept aside: its folder and what its save says. */
export interface PreviousCity { folder: string; saved: string; seed: number; gameId: number; tiles: number; bytes: number }

/** The previous cities of a slot, newest first (those whose save checks out). */
export async function previousCities(store: FileStore, slot: string): Promise<PreviousCity[]> {
  const out: PreviousCity[] = [];
  for (const folder of (await foldersOf(store, 'anterior', slot)).reverse()) {
    try {
      const g = (await new SaveSlot(store, folder).open()).generations[0];
      if (!g) continue;
      let bytes = g.meta.size;
      for (const r of g.tiles.values()) bytes += r.size;
      // a copy of a save from before generations has no date of its own: the folder's
      const saved = g.saved || folder.slice('anterior-'.length, 'anterior-'.length + 19).replace(/T(\d\d)-(\d\d)-(\d\d)/, 'T$1:$2:$3');
      out.push({ folder, saved, seed: g.seed, gameId: g.game, tiles: g.tiles.size, bytes });
    } catch (err) { console.warn('save: previous city not readable', folder, err); }
  }
  return out;
}

/**
 * Puts a previous city back in the slot: the city in the slot now is kept aside first (keepPreviousCity), then the
 * previous city's save is committed as a new generation of the slot. Returns the folder the current city went to.
 */
export async function restorePrevious(slot: SaveSlot, folder: string): Promise<string | null> {
  if (!folder.startsWith('anterior-') || !folder.endsWith(`-${slot.folder}`)) throw new Error(`${folder} is not a previous city of ${slot.folder}`);
  const from = new SaveSlot(slot.store, folder);
  const g = (await from.open()).generations[0];
  if (!g) throw new Error(`the save in ${folder} cannot be read`);
  const tiles = new Map<number, Uint8Array>();
  for (const t of g.tiles.keys()) tiles.set(t, await from.readTile(g, t));
  const kept = await keepPreviousCity(slot);
  await slot.adopt(g.metaBytes, tiles, g.game, g.seed);
  return kept;
}

/** The save actions the interface can call (Game.hudActions): the previous cities of the save, and opening one. */
export interface SaveActions {
  /** The previous cities kept aside, newest first. */
  previousCities(): Promise<PreviousCity[]>;
  /** Puts a previous city (`folder` from previousCities) back in the save and opens it, asking first when the city on screen has unsaved work. */
  openPreviousCity(folder: string): void;
}

// Save files: where a save's files live, and how a save is written so that closing or crashing half way never leaves a
// save that does not open.
//
// A save folder (a "slot", saves/<folder>) holds generations. Saving writes generation N: the tiles that changed as new
// files (tile_0042.g17.bin), the map description (meta.g17.bin) and a manifest (manifest.g17.json) listing every tile
// file of the generation, new or kept from the generation before, with its size and SHA-256. current.json, a small file
// naming the manifest, is written last: that write is the commit. Opening reads current.json, checks the manifest and
// its files, and falls back to the generation before when one is missing or wrong. Files are deleted only after a
// commit, and only those neither of the last two generations uses. A save written before generations existed (meta.bin
// and tile_NNNN.bin) opens as generation 0.
//
// Where the folders are is a FileStore: in the browser, the origin private file system (OPFS); in the desktop game, real
// files written by the Electron main process (electron/files.mjs) in the app data folder, which Steam Cloud can sync.

import { metaHeader } from './save.ts';
import { sha256 } from '../jobs/storage.ts';

export interface FileEntry { name: string; size: number }

/** The folders of saves/ and their files. Folder '' is saves/ itself. */
export interface FileStore {
  /** The file's bytes; null when it does not exist. Throws StoreError when the storage itself fails. */
  read(folder: string, name: string): Promise<Uint8Array | null>;
  /** Writes the whole file. Once the promise resolves the file is complete; a write that fails leaves the old file. */
  write(folder: string, name: string, data: Uint8Array): Promise<void>;
  /** The folder's files with their sizes; [] when the folder does not exist. */
  list(folder: string): Promise<FileEntry[]>;
  /** Removes a file (nothing happens when it is not there). */
  remove(folder: string, name: string): Promise<void>;
  /** The folders under saves/. */
  folders(): Promise<string[]>;
  /** Removes a folder and everything in it. */
  removeFolder(folder: string): Promise<void>;
}

/** The storage failed (unavailable, denied, full…): not the same as "there is no such file". */
export class StoreError extends Error {}

/** A file or folder name the stores accept: letters, digits, _ . - (never a path). */
export function checkName(name: string, folder = false): void {
  if (folder && name === '') return;
  if (!/^[\w.-]+$/.test(name) || name === '.' || name === '..') throw new StoreError(`invalid save file name: ${JSON.stringify(name)}`);
}

// ------------------------------------------------------------------ browser: OPFS

const notFound = (err: unknown) => (err as { name?: string })?.name === 'NotFoundError' || (err as { name?: string })?.name === 'TypeMismatchError';
const storeError = (what: string, err: unknown) => new StoreError(`${what}: ${(err as Error)?.message ?? String(err)}`);
type Entries = AsyncIterable<[string, FileSystemHandle]>;

/** Saves in the origin private file system: saves/<folder>/<file>. Works on the page and in workers. */
export class OpfsStore implements FileStore {
  private async dir(folder: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
    checkName(folder, true);
    try {
      const saves = await (await navigator.storage.getDirectory()).getDirectoryHandle('saves', { create });
      return folder ? await saves.getDirectoryHandle(folder, { create }) : saves;
    } catch (err) {
      if (notFound(err)) return null;
      throw storeError(`save folder ${folder || 'saves'}`, err);
    }
  }

  async read(folder: string, name: string): Promise<Uint8Array | null> {
    checkName(name);
    const dir = await this.dir(folder, false);
    if (!dir) return null;
    let h: FileSystemFileHandle;
    try { h = await dir.getFileHandle(name); } catch (err) { if (notFound(err)) return null; throw storeError(`reading ${folder}/${name}`, err); }
    try { return new Uint8Array(await (await h.getFile()).arrayBuffer()); } catch (err) { throw storeError(`reading ${folder}/${name}`, err); }
  }

  async write(folder: string, name: string, data: Uint8Array): Promise<void> {
    checkName(name);
    const dir = (await this.dir(folder, true))!;
    // a writable stream writes to a copy that replaces the file only on close(); abort() throws the copy away
    let w: FileSystemWritableFileStream | null = null;
    try {
      w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write(data as unknown as FileSystemWriteChunkType);
      await w.close();
    } catch (err) {
      await w?.abort().catch(() => { /* already closed */ });
      throw storeError(`writing ${folder}/${name}`, err);
    }
  }

  async list(folder: string): Promise<FileEntry[]> {
    const dir = await this.dir(folder, false);
    if (!dir) return [];
    const out: FileEntry[] = [];
    try {
      for await (const [name, h] of dir as unknown as Entries) if (h.kind === 'file') out.push({ name, size: (await (h as FileSystemFileHandle).getFile()).size });
    } catch (err) { throw storeError(`listing ${folder}`, err); }
    return out;
  }

  async remove(folder: string, name: string): Promise<void> {
    checkName(name);
    const dir = await this.dir(folder, false);
    if (!dir) return;
    try { await dir.removeEntry(name); } catch (err) { if (!notFound(err)) throw storeError(`removing ${folder}/${name}`, err); }
  }

  async folders(): Promise<string[]> {
    const saves = await this.dir('', false);
    if (!saves) return [];
    const out: string[] = [];
    try { for await (const [name, h] of saves as unknown as Entries) if (h.kind === 'directory') out.push(name); } catch (err) { throw storeError('listing saves', err); }
    return out;
  }

  async removeFolder(folder: string): Promise<void> {
    checkName(folder);
    const saves = await this.dir('', false);
    if (!saves) return;
    try { await saves.removeEntry(folder, { recursive: true }); } catch (err) { if (!notFound(err)) throw storeError(`removing ${folder}`, err); }
  }
}

// ------------------------------------------------------------------ desktop: real files

/** What the desktop game's preload offers (roadcraftApp.files): the main process's file store, over IPC. */
export interface FilesBridge {
  read(folder: string, name: string): Promise<Uint8Array | null>;
  write(folder: string, name: string, data: Uint8Array): Promise<void>;
  list(folder: string): Promise<FileEntry[]>;
  remove(folder: string, name: string): Promise<void>;
  folders(): Promise<string[]>;
  removeFolder(folder: string): Promise<void>;
}

/** Saves as real files kept by the Electron main process (electron/files.mjs): <app data>/saves/<folder>/<file>. */
export class AppStore implements FileStore {
  bridge: FilesBridge;
  constructor(bridge: FilesBridge) { this.bridge = bridge; }

  private async call<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (err) { throw storeError(what, err); }
  }

  read(folder: string, name: string): Promise<Uint8Array | null> {
    checkName(folder, true); checkName(name);
    return this.call(`reading ${folder}/${name}`, async () => { const b = await this.bridge.read(folder, name); return b ? new Uint8Array(b) : null; });
  }
  write(folder: string, name: string, data: Uint8Array): Promise<void> {
    checkName(folder, true); checkName(name);
    return this.call(`writing ${folder}/${name}`, () => this.bridge.write(folder, name, data));
  }
  list(folder: string): Promise<FileEntry[]> { checkName(folder, true); return this.call(`listing ${folder}`, () => this.bridge.list(folder)); }
  remove(folder: string, name: string): Promise<void> { checkName(folder, true); checkName(name); return this.call(`removing ${folder}/${name}`, () => this.bridge.remove(folder, name)); }
  folders(): Promise<string[]> { return this.call('listing saves', () => this.bridge.folders()); }
  removeFolder(folder: string): Promise<void> { checkName(folder); return this.call(`removing ${folder}`, () => this.bridge.removeFolder(folder)); }
}

/** Written in saves/ once the saves the desktop game kept in the browser storage were copied to real files. */
export const MIGRATED = 'migrated-from-browser-storage.json';
/** In a folder being copied, until every file of it is there. */
const MIGRATING = 'migrating-from-browser-storage.json';

/**
 * Copies, once, every save folder of `from` (the browser storage earlier versions of the desktop game used) into `to`
 * (real files). The browser storage is never changed. A folder `to` already has is left alone, unless it is one a
 * copy that stopped half way was making. Throws when a copy fails (the next start tries again).
 */
export async function migrateOnce(from: FileStore, to: FileStore): Promise<string[]> {
  if (await to.read('', MIGRATED)) return [];
  const have = new Set(await to.folders());
  const copied: string[] = [];
  for (const folder of await from.folders()) {
    if (have.has(folder) && !(await to.read(folder, MIGRATING))) continue;
    await to.write(folder, MIGRATING, bytesOf({ at: new Date().toISOString() }));
    for (const e of await from.list(folder)) {
      const b = await from.read(folder, e.name);
      if (b) await to.write(folder, e.name, b);
    }
    await to.remove(folder, MIGRATING);
    copied.push(folder);
  }
  await to.write('', MIGRATED, bytesOf({ at: new Date().toISOString(), folders: copied }));
  return copied;
}

/**
 * Who writes a slot. In the browser every tab of the game shares the storage: the first tab holds a lock on the slot
 * (navigator.locks, while the tab lives) and writes; another tab only reads, until the lock is free again (the first
 * tab closed), when `onWriter` is called. The desktop game is one window (a single instance) and always writes.
 */
export class SlotLock {
  writer = true;
  readonly ready: Promise<void>;

  constructor(slot: string, onWriter?: () => void) {
    const locks = (globalThis.navigator as Navigator | undefined)?.locks;
    const desktop = !!(globalThis as { roadcraftApp?: { files?: unknown } }).roadcraftApp?.files;
    if (!locks || desktop) { this.ready = Promise.resolve(); return; }
    this.writer = false;
    const name = `roadcraft-save-${slot}`;
    const hold = () => new Promise<void>(() => { /* held while the tab lives */ });
    this.ready = new Promise<void>((resolve) => {
      void locks.request(name, { ifAvailable: true }, (lock) => {
        if (lock) { this.writer = true; resolve(); return hold(); }
        resolve();
        // another tab writes: wait for its lock
        void locks.request(name, () => { this.writer = true; onWriter?.(); return hold(); });
        return null;
      }).catch((err: unknown) => { console.warn('save: no lock on the save', err); this.writer = true; resolve(); });
    });
  }
}

/**
 * The save storage of this game: real files in the desktop game (after copying, once, the saves it kept in the browser
 * storage before), the origin private file system in the browser. Never rejects.
 */
export async function openSaveStore(): Promise<FileStore> {
  const bridge = (globalThis as { roadcraftApp?: { files?: FilesBridge } }).roadcraftApp?.files;
  if (!bridge) {
    // the browser may clear storage it was not asked to keep (low disk): ask to keep the saves
    void navigator.storage?.persist?.().then((kept) => { if (!kept) console.warn('save: the browser did not promise to keep the saves'); }, () => { /* not offered */ });
    return new OpfsStore();
  }
  const files = new AppStore(bridge);
  try {
    const copied = await migrateOnce(new OpfsStore(), files);
    if (copied.length) console.log('save: copied from the browser storage:', copied.join(', '));
  } catch (err) { console.error('save: the saves in the browser storage were not copied yet (they stay there; the next start tries again)', err); }
  return files;
}

// ------------------------------------------------------------------ generations

/** A file of a generation: its name, size in bytes and SHA-256 (hex; '' when not known: saves before generations). */
export interface FileRef { file: string; size: number; hash: string }

export interface Generation {
  /** 0: a save written before generations (meta.bin and tile_NNNN.bin, without recorded hashes). */
  gen: number;
  game: number;
  seed: number;
  /** When it was saved (ISO time); '' when not known. */
  saved: string;
  /** Its manifest (null for generation 0). */
  manifest: FileRef | null;
  meta: FileRef;
  /** The map description's bytes (read and checked when the generation was opened). */
  metaBytes: Uint8Array;
  /** Tile → its file. */
  tiles: Map<number, FileRef>;
  /** Tiles whose file is gone or not the recorded size, and why (the generation opens without them only as a last resort). */
  missing: Map<number, string>;
}

/** What `SaveSlot.open` found. */
export interface Opened {
  /** False: the folder has no files at all (nothing was ever saved there). */
  found: boolean;
  /** The committed generations whose commit record, manifest and map description check out, newest first (at most
   * two); one may still miss tile files (`missing`). */
  generations: Generation[];
  /** What was wrong with the generations that did not check out, newest first (one line each). */
  problems: string[];
  /** The newest committed generation, even when it did not check out (null: there is none). */
  newest: number | null;
}

interface ManifestJson {
  format: 1; gen: number; game: number; seed: number; saved: string;
  meta: FileRef;
  /** [tile, file, size, hash]. */
  tiles: Array<[number, string, number, string]>;
}

interface CurrentJson {
  format: 1; gen: number; manifest: FileRef;
  /** The generation the committed one replaced: its manifest, 'legacy' (generation 0) or null (none of this city). */
  previous: FileRef | 'legacy' | null;
}

export const CURRENT = 'current.json';
const LEGACY_META = 'meta.bin';
const pad = (t: number) => t.toString().padStart(4, '0');
const tileFile = (t: number, gen: number) => `tile_${pad(t)}.g${gen}.bin`;
const legacyTile = (t: number) => `tile_${pad(t)}.bin`;
const metaFile = (gen: number) => `meta.g${gen}.bin`;
const manifestFile = (gen: number) => `manifest.g${gen}.json`;
/** The generation in a file name (tile_0042.g17.bin → 17); 0 for names without one. */
const genOf = (name: string) => { const m = /\.g(\d+)\.(?:bin|json)$/.exec(name); return m ? Number(m[1]) : 0; };
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const bytesOf = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

/** Tile files written (or read) at the same time. */
export const WRITES_AT_ONCE = 8;

/** Runs at most `n` of the functions given to it at a time (the others wait their turn). */
export function limiter(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async (fn) => {
    if (running >= n) await new Promise<void>((r) => waiting.push(r));
    running++;
    try { return await fn(); } finally { running--; waiting.shift()?.(); }
  };
}

/** A tile file that cannot be used (missing, cut, damaged, another tile). */
export class TileFileError extends Error {}

/** Every generation's files (plus current.json) are written and read through this. */
export class SaveSlot {
  readonly store: FileStore;
  readonly folder: string;

  constructor(store: FileStore, folder: string) {
    checkName(folder);
    this.store = store;
    this.folder = folder;
  }

  /**
   * The committed generations, newest first: current.json's, then the one it replaced. A generation is returned when
   * its manifest matches what current.json recorded and its map description matches the manifest; its tile files that
   * are gone or of another size are listed in `missing` (the tile hashes are checked as the tiles are read, by the
   * worker that decodes them). When current.json is missing or unreadable, the manifests in the folder are tried newest
   * first. Throws StoreError when the storage fails.
   */
  async open(): Promise<Opened> {
    const files = new Map((await this.store.list(this.folder)).map((e) => [e.name, e.size]));
    if (files.size === 0) return { found: false, generations: [], problems: [], newest: null };
    const problems: string[] = [];
    let candidates: Array<FileRef | 'legacy'> = [];
    const cur = files.has(CURRENT) ? await this.current().catch((err: unknown) => { if (err instanceof StoreError) throw err; problems.push(`${CURRENT}: ${(err as Error).message}`); return null; }) : null;
    let newest: number | null = null;
    if (cur) {
      newest = cur.gen;
      candidates = [cur.manifest, ...(cur.previous ? [cur.previous] : [])];
    } else {
      // no commit point to go by: every manifest in the folder, newest first, then a save from before generations
      const manifests = [...files.keys()].filter((n) => /^manifest\.g\d+\.json$/.test(n)).sort((x, y) => genOf(y) - genOf(x));
      candidates = manifests.map((file) => ({ file, size: -1, hash: '' }));
      if (files.has(LEGACY_META)) candidates.push('legacy');
      newest = candidates.length ? (candidates[0] === 'legacy' ? 0 : genOf((candidates[0] as FileRef).file)) : null;
      if (!candidates.length) problems.push('no map description');
    }
    const generations: Generation[] = [];
    for (const c of candidates) {
      if (generations.length === 2) break;
      try {
        const g = c === 'legacy' ? await this.legacy(files) : await this.fromManifest(c, files);
        for (const [t, why] of g.missing) problems.push(`generation ${g.gen}: tile ${t}: ${why}`);
        generations.push(g);
      } catch (err) {
        if (err instanceof StoreError) throw err;
        problems.push(`${c === 'legacy' ? 'generation 0' : `generation ${genOf(c.file)}`}: ${(err as Error).message}`);
      }
    }
    return { found: true, generations, problems, newest };
  }

  /** current.json, checked; null when there is none. */
  private async current(): Promise<CurrentJson | null> {
    const raw = await this.store.read(this.folder, CURRENT);
    if (!raw) return null;
    const c = JSON.parse(text(raw)) as CurrentJson;
    if (c?.format !== 1 || typeof c.gen !== 'number' || typeof c.manifest?.file !== 'string') throw new Error('not a commit record');
    return c;
  }

  private async fromManifest(ref: FileRef, files: Map<string, number>): Promise<Generation> {
    const raw = await this.store.read(this.folder, ref.file);
    if (!raw) throw new Error(`${ref.file} is missing`);
    if (ref.size >= 0 && raw.length !== ref.size) throw new Error(`${ref.file} has ${raw.length} bytes, the commit recorded ${ref.size}`);
    if (ref.hash && await sha256(raw) !== ref.hash) throw new Error(`${ref.file} is not the one the commit recorded`);
    let m: ManifestJson;
    try { m = JSON.parse(text(raw)) as ManifestJson; } catch { throw new Error(`${ref.file} cannot be read`); }
    if (m?.format !== 1 || typeof m.gen !== 'number' || typeof m.meta?.file !== 'string' || !Array.isArray(m.tiles)) throw new Error(`${ref.file} is not a manifest`);
    const metaBytes = await this.checked(m.meta);
    const tiles = new Map<number, FileRef>(), missing = new Map<number, string>();
    for (const [t, file, size, hash] of m.tiles) {
      const has = files.get(file);
      if (has === undefined) missing.set(t, `its file (${file}) is missing`);
      else if (has !== size) missing.set(t, `its file (${file}) has ${has} bytes, the manifest says ${size}`);
      tiles.set(t, { file, size, hash });
    }
    return { gen: m.gen, game: m.game >>> 0, seed: m.seed >>> 0, saved: m.saved ?? '', manifest: { file: ref.file, size: raw.length, hash: ref.hash || await sha256(raw) }, meta: m.meta, metaBytes, tiles, missing };
  }

  /** A save from before generations: meta.bin and the tile_NNNN.bin files its map description lists. */
  private async legacy(files: Map<string, number>): Promise<Generation> {
    const metaBytes = await this.store.read(this.folder, LEGACY_META);
    if (!metaBytes) throw new Error(`${LEGACY_META} is missing`);
    let meta;
    try { meta = metaHeader(metaBytes); } catch (err) { throw new Error(`${LEGACY_META} cannot be read (${(err as Error).message})`); }
    const tiles = new Map<number, FileRef>(), missing = new Map<number, string>();
    for (let t = 0; t < meta.tiles.length; t++) {
      if (!meta.tiles[t]) continue;
      const size = files.get(legacyTile(t));
      if (size === undefined) missing.set(t, `its file (${legacyTile(t)}) is missing`);
      tiles.set(t, { file: legacyTile(t), size: size ?? -1, hash: '' });
    }
    return { gen: 0, game: meta.gameId, seed: meta.seed, saved: '', manifest: null, meta: { file: LEGACY_META, size: metaBytes.length, hash: '' }, metaBytes, tiles, missing };
  }

  /** A file's bytes, checked against its size and hash. */
  private async checked(ref: FileRef): Promise<Uint8Array> {
    const b = await this.store.read(this.folder, ref.file);
    if (!b) throw new Error(`${ref.file} is missing`);
    if (b.length !== ref.size) throw new Error(`${ref.file} has ${b.length} bytes, the manifest says ${ref.size}`);
    if (ref.hash && await sha256(b) !== ref.hash) throw new Error(`${ref.file} is damaged (its contents do not match the manifest)`);
    return b;
  }

  /** Whether every file of generation `g` is still in the folder with its recorded size (a save can build on it). */
  async hasFiles(g: Generation): Promise<boolean> {
    const have = new Map((await this.store.list(this.folder)).map((e) => [e.name, e.size]));
    return have.get(g.meta.file) === g.meta.size && [...g.tiles.values()].every((r) => have.get(r.file) === r.size);
  }

  /** A tile file's bytes, checked against its size (its hash is checked by whoever decodes it). */
  async readTile(g: Generation, t: number): Promise<Uint8Array> {
    const ref = g.tiles.get(t);
    if (!ref) throw new TileFileError(`tile ${t} is not in generation ${g.gen}`);
    const b = await this.store.read(this.folder, ref.file);
    if (!b) throw new TileFileError(`its file (${ref.file}) is missing`);
    if (b.length !== ref.size) throw new TileFileError(`its file (${ref.file}) has ${b.length} bytes, the save recorded ${ref.size}`);
    return b;
  }

  /** Starts writing a new generation (numbered above every generation in the folder, committed or not). */
  async begin(): Promise<SaveWriter> {
    let top = 0;
    for (const e of await this.store.list(this.folder)) top = Math.max(top, genOf(e.name));
    return new SaveWriter(this, top + 1);
  }

  /** Every file a generation uses (its manifest included). */
  static filesOf(g: Generation): string[] {
    return [g.meta.file, ...(g.manifest ? [g.manifest.file] : []), ...[...g.tiles.values()].map((r) => r.file)];
  }

  /**
   * Copies generation `g` into the folder `to` as a save of its own (same file names, a current.json with no
   * generation before it). Throws if anything fails (what was copied stays).
   */
  async copyGeneration(g: Generation, to: string): Promise<void> {
    checkName(to);
    for (const file of SaveSlot.filesOf(g)) {
      const b = await this.store.read(this.folder, file);
      if (!b) throw new StoreError(`${file} vanished while being copied`);
      await this.store.write(to, file, b);
    }
    if (g.manifest) await this.store.write(to, CURRENT, bytesOf({ format: 1, gen: g.gen, manifest: g.manifest, previous: null } satisfies CurrentJson));
  }

  /** Copies every file of the folder into `to`, untouched (quarantine: what cannot be read is kept for repair). */
  async copyAll(to: string): Promise<number> {
    checkName(to);
    let n = 0;
    for (const e of await this.store.list(this.folder)) {
      const b = await this.store.read(this.folder, e.name);
      if (b) { await this.store.write(to, e.name, b); n++; }
    }
    return n;
  }

  /** The files of generation `g` with a current.json naming it: a save that opens on its own (export). */
  async pack(g: Generation): Promise<Array<[string, Uint8Array]>> {
    const out: Array<[string, Uint8Array]> = [];
    for (const file of SaveSlot.filesOf(g)) {
      const b = await this.store.read(this.folder, file);
      if (!b) throw new StoreError(`${file} vanished while being packed`);
      out.push([file, b]);
    }
    if (g.manifest) out.push([CURRENT, bytesOf({ format: 1, gen: g.gen, manifest: g.manifest, previous: null } satisfies CurrentJson)]);
    return out;
  }

  /**
   * A whole save from bytes (an imported file, a previous city) committed as a new generation of this slot. The
   * generation before it is not kept as a fallback (it is another city).
   */
  async adopt(meta: Uint8Array, tiles: Map<number, Uint8Array>, game: number, seed: number): Promise<Generation> {
    const w = await this.begin();
    for (const [t, b] of tiles) await w.tile(t, b, await sha256(b));
    return w.commit(meta, [...tiles.keys()], null, game, seed);
  }
}

/** One generation being written: tiles first, then `commit`. Nothing is visible to `open` until the commit. */
export class SaveWriter {
  readonly gen: number;
  private slot: SaveSlot;
  private written = new Map<number, FileRef>();
  /** A few writes at a time, not one per tile of the map at once. */
  private writes = limiter(WRITES_AT_ONCE);

  constructor(slot: SaveSlot, gen: number) { this.slot = slot; this.gen = gen; }

  /** Writes one tile's file (compressed bytes and their SHA-256). */
  async tile(t: number, data: Uint8Array, hash: string): Promise<void> {
    const file = tileFile(t, this.gen);
    await this.writes(() => this.slot.store.write(this.slot.folder, file, data));
    this.written.set(t, { file, size: data.length, hash });
  }

  /**
   * Writes the map description and the manifest, then current.json (the commit), then removes the files neither
   * this generation nor `kept` uses. `listed`: every tile the save holds; a tile not written here comes from `kept`,
   * the committed generation of the same city this one builds on (null: every listed tile was written). Throws before
   * the commit when a tile has no file, or when a kept file is gone (the next save must write every tile then).
   */
  async commit(meta: Uint8Array, listed: Iterable<number>, kept: Generation | null, game: number, seed: number): Promise<Generation> {
    const { store, folder } = this.slot;
    const tiles = new Map<number, FileRef>();
    for (const t of listed) {
      const ref = this.written.get(t) ?? kept?.tiles.get(t);
      if (!ref) throw new Error(`tile ${t} is listed but has no file`);
      tiles.set(t, ref);
    }
    if (kept) {
      const have = new Map((await store.list(folder)).map((e) => [e.name, e.size]));
      for (const [t, ref] of tiles) if (!this.written.has(t) && have.get(ref.file) !== ref.size) throw new KeptFileMissing(`the file of tile ${t} kept from the save before (${ref.file}) is gone`);
    }
    const metaRef: FileRef = { file: metaFile(this.gen), size: meta.length, hash: await sha256(meta) };
    await store.write(folder, metaRef.file, meta);
    const saved = new Date().toISOString();
    const m: ManifestJson = { format: 1, gen: this.gen, game: game >>> 0, seed: seed >>> 0, saved, meta: metaRef,
      tiles: [...tiles].sort((x, y) => x[0] - y[0]).map(([t, r]) => [t, r.file, r.size, r.hash]) };
    const mb = bytesOf(m);
    const manifest: FileRef = { file: manifestFile(this.gen), size: mb.length, hash: await sha256(mb) };
    await store.write(folder, manifest.file, mb);
    const previous = kept ? (kept.manifest ?? 'legacy') : null;
    await store.write(folder, CURRENT, bytesOf({ format: 1, gen: this.gen, manifest, previous } satisfies CurrentJson));
    // committed: what neither this generation nor the one before uses goes (a failure here only leaves extra files)
    const g: Generation = { gen: this.gen, game: game >>> 0, seed: seed >>> 0, saved, manifest, meta: metaRef, metaBytes: meta, tiles, missing: new Map() };
    const keep = new Set([CURRENT, ...SaveSlot.filesOf(g), ...(kept ? SaveSlot.filesOf(kept) : [])]);
    try {
      for (const e of await store.list(folder)) if (!keep.has(e.name)) await store.remove(folder, e.name);
    } catch (err) { console.warn('save: old files not removed:', err); }
    return g;
  }
}

/** A tile file of the generation a save built on is gone: nothing was committed. */
export class KeptFileMissing extends Error {}

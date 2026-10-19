// Map as a file: bundles the save files (meta and tiles, already compressed) into a single file
// for download, and does the reverse. Does not read the world: it copies what the save wrote.

const MAGIC = 'CIDADE-MAPA-1';

async function slotDir(slot: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const saves = await root.getDirectoryHandle('saves', { create });
    return await saves.getDirectoryHandle(slot, { create });
  } catch { return null; }
}

/** The save files in one package: [MAGIC][n] and, for each one, [name][size][bytes]. */
export async function packSlot(slot: string): Promise<Blob | null> {
  const dir = await slotDir(slot, false);
  if (!dir) return null;
  const parts: BlobPart[] = [];
  const enc = new TextEncoder();
  const head = enc.encode(MAGIC);
  let count = 0;
  const body: BlobPart[] = [];
  for await (const [name, h] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
    if (h.kind !== 'file') continue;
    const data = new Uint8Array(await (await (h as FileSystemFileHandle).getFile()).arrayBuffer());
    const nm = enc.encode(name);
    const hdr = new DataView(new ArrayBuffer(8));
    hdr.setUint32(0, nm.length, true); hdr.setUint32(4, data.length, true);
    body.push(hdr.buffer, nm, data);
    count++;
  }
  if (count === 0) return null;
  const n = new DataView(new ArrayBuffer(4)); n.setUint32(0, count, true);
  parts.push(head, n.buffer, ...body);
  return new Blob(parts, { type: 'application/octet-stream' });
}

/** Reads a map package into its files ([name, bytes]). Throws if the file is not a map or is cut. */
export async function readPackage(file: Blob): Promise<Array<[string, Uint8Array]>> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const head = new TextEncoder().encode(MAGIC);
  for (let i = 0; i < head.length; i++) if (buf[i] !== head[i]) throw new Error('esse arquivo não é um mapa do Roadcraft');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = head.length;
  const count = dv.getUint32(o, true); o += 4;
  const files: Array<[string, Uint8Array]> = [];
  const dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (o + 8 > buf.length) throw new Error('arquivo de mapa cortado');
    const nl = dv.getUint32(o, true), dl = dv.getUint32(o + 4, true); o += 8;
    if (o + nl + dl > buf.length) throw new Error('arquivo de mapa cortado');
    const name = dec.decode(buf.subarray(o, o + nl)); o += nl;
    if (!/^[\w.-]+$/.test(name) || name === '.' || name === '..') throw new Error('arquivo de mapa com nome inválido');
    files.push([name, buf.slice(o, o + dl)]); o += dl;
  }
  if (!files.some(([n]) => n.startsWith('meta'))) throw new Error('arquivo de mapa sem a descrição do mapa');
  return files;
}

/** Writes files as the whole content of a save folder (what was there goes). */
async function writeSlot(slot: string, files: Array<[string, Uint8Array]>): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const saves = await root.getDirectoryHandle('saves', { create: true });
  try { await saves.removeEntry(slot, { recursive: true }); } catch { /* there was none */ }
  const dir = await saves.getDirectoryHandle(slot, { create: true });
  for (const [name, data] of files) {
    const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await w.write(data as unknown as FileSystemWriteChunkType);
    await w.close();
  }
}

/** Every file of a save folder ([name, bytes]); empty when there is none. */
async function slotFiles(slot: string): Promise<Array<[string, Uint8Array]>> {
  const dir = await slotDir(slot, false);
  if (!dir) return [];
  const out: Array<[string, Uint8Array]> = [];
  for await (const [file, h] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
    if (h.kind !== 'file') continue;
    out.push([file, new Uint8Array(await (await (h as FileSystemFileHandle).getFile()).arrayBuffer())]);
  }
  return out;
}

/**
 * Replaces the save in `slot` with the package. Nothing is touched until the package is read and `check` accepts its
 * map description (it throws to refuse); the city saved before is kept as a previous city (`keepPreviousCity`), and
 * if writing fails it is put back. Returns the folder the previous city was kept in (null: there was none).
 */
export async function unpackToSlot(slot: string, file: Blob, check: (meta: Uint8Array) => void): Promise<string | null> {
  const files = await readPackage(file);
  check(files.find(([n]) => n.startsWith('meta'))![1]);
  const before = await slotFiles(slot);
  const kept = before.length ? await keepPreviousCity(slot) : null;
  try {
    await writeSlot(slot, files);
  } catch (err) {
    if (before.length) await writeSlot(slot, before).catch(() => { /* the copy in `kept` stays */ });
    throw err;
  }
  return kept;
}

/** Copies every file of the save `slot` into `saves/<name>`, untouched. Returns the name, or null when there is no save. */
async function copySlot(slot: string, name: string): Promise<string | null> {
  const files = await slotFiles(slot);
  if (!files.length) return null;
  const root = await navigator.storage.getDirectory();
  const saves = await root.getDirectoryHandle('saves', { create: true });
  const q = await saves.getDirectoryHandle(name, { create: true });
  for (const [file, data] of files) {
    const w = await (await q.getFileHandle(file, { create: true })).createWritable();
    await w.write(data as unknown as FileSystemWriteChunkType);
    await w.close();
  }
  return name;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/**
 * Quarantine (Roadcraft: an unreadable map is never deleted): copies every file of the save `slot` into
 * `saves/quarentena-<date>-<slot>`, untouched, so it can be sent for repair. Returns the folder name, or null.
 */
export async function quarantineSlot(slot: string): Promise<string | null> {
  return copySlot(slot, `quarentena-${stamp()}-${slot}`);
}

/** How many previous cities are kept. */
const PREVIOUS_KEPT = 3;

/**
 * Before another city takes the slot: the city saved there is copied to `saves/anterior-<date>-<slot>`; only the last
 * `PREVIOUS_KEPT` previous cities are kept. Returns the folder name, or null when the slot is empty.
 */
export async function keepPreviousCity(slot: string): Promise<string | null> {
  const name = await copySlot(slot, `anterior-${stamp()}-${slot}`);
  if (!name) return null;
  const root = await navigator.storage.getDirectory();
  const saves = await root.getDirectoryHandle('saves', { create: true });
  const previous: string[] = [];
  for await (const [n, h] of (saves as unknown as AsyncIterable<[string, FileSystemHandle]>)) if (h.kind === 'directory' && n.startsWith('anterior-') && n.endsWith(`-${slot}`)) previous.push(n);
  previous.sort();
  for (const old of previous.slice(0, Math.max(0, previous.length - PREVIOUS_KEPT))) await saves.removeEntry(old, { recursive: true }).catch(() => { /* kept */ });
  return name;
}

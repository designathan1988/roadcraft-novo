// Mapa em arquivo: junta os arquivos do salvamento (meta e ladrilhos, já comprimidos) num arquivo
// só para baixar, e faz o caminho de volta. Não lê o mundo: copia o que o salvamento gravou.

const MAGIC = 'CIDADE-MAPA-1';

async function slotDir(slot: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const saves = await root.getDirectoryHandle('saves', { create });
    return await saves.getDirectoryHandle(slot, { create });
  } catch { return null; }
}

/** Os arquivos do salvamento num pacote: [MAGIC][n] e, para cada um, [nome][tamanho][bytes]. */
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

/** Troca o salvamento do `slot` pelo conteúdo do pacote. Erro se o arquivo não for um mapa. */
export async function unpackToSlot(slot: string, file: Blob): Promise<number> {
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
    if (!/^[\w.-]+$/.test(name)) throw new Error('arquivo de mapa com nome inválido');
    files.push([name, buf.slice(o, o + dl)]); o += dl;
  }
  if (!files.some(([n]) => n.startsWith('meta'))) throw new Error('arquivo de mapa sem a descrição do mapa');
  const root = await navigator.storage.getDirectory();
  const saves = await root.getDirectoryHandle('saves', { create: true });
  try { await saves.removeEntry(slot, { recursive: true }); } catch { /* não havia */ }
  const dir = await saves.getDirectoryHandle(slot, { create: true });
  for (const [name, data] of files) {
    const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await w.write(data as unknown as FileSystemWriteChunkType);
    await w.close();
  }
  return files.length;
}

/**
 * Quarantine (Roadcraft: an unreadable map is never deleted): copies every file of the save `slot` into
 * `saves/quarentena-<date>-<slot>`, untouched, so it can be sent for repair. Returns the folder name, or null.
 */
export async function quarantineSlot(slot: string): Promise<string | null> {
  const dir = await slotDir(slot, false);
  if (!dir) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `quarentena-${stamp}-${slot}`;
  const root = await navigator.storage.getDirectory();
  const saves = await root.getDirectoryHandle('saves', { create: true });
  const q = await saves.getDirectoryHandle(name, { create: true });
  for await (const [file, h] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
    if (h.kind !== 'file') continue;
    const data = await (await (h as FileSystemFileHandle).getFile()).arrayBuffer();
    const w = await (await q.getFileHandle(file, { create: true })).createWritable();
    await w.write(data);
    await w.close();
  }
  return name;
}

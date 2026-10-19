// The desktop game's save files: real files under <root>/<folder>/<file> (root = the app data folder's saves/, which
// Steam Cloud can sync), served to the page over IPC (main.mjs). A write goes to a temporary file that is flushed to
// disk (fsync) and then renamed over the old one, so a file is always either the old one or the new one, whole.
import fs from 'node:fs';
import path from 'node:path';

/** A file or folder name: letters, digits, _ . - (never a path). Folder '' is the root itself. */
function checked(name, folder = false) {
  if (folder && name === '') return name;
  if (typeof name !== 'string' || !/^[\w.-]+$/.test(name) || name === '.' || name === '..') throw new Error(`invalid save file name: ${JSON.stringify(name)}`);
  return name;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** rename, tried again a few times when Windows reports the target busy (an antivirus or a sync client reading it). */
async function rename(from, to) {
  for (let k = 0; ; k++) {
    try { await fs.promises.rename(from, to); return; } catch (err) {
      if (k >= 10 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      await wait(20 * (k + 1));
    }
  }
}

let serial = 0;

/** The store over `root` (created on the first write). Every method rejects with the file system's error. */
export function fileStore(root) {
  const dir = (folder) => (folder === '' ? root : path.join(root, checked(folder, true)));
  return {
    /** The file's bytes, or null when it does not exist. */
    async read(folder, name) {
      try { return await fs.promises.readFile(path.join(dir(folder), checked(name))); } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
        throw err;
      }
    },
    async write(folder, name, data) {
      const d = dir(folder);
      await fs.promises.mkdir(d, { recursive: true });
      const file = path.join(d, checked(name));
      const tmp = `${file}.${process.pid}-${++serial}.tmp`;
      const fh = await fs.promises.open(tmp, 'w');
      try {
        await fh.writeFile(data);
        await fh.sync();
      } catch (err) {
        await fh.close().catch(() => {});
        await fs.promises.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      await fh.close();
      try { await rename(tmp, file); } catch (err) { await fs.promises.rm(tmp, { force: true }).catch(() => {}); throw err; }
      // the rename itself is made durable by flushing the folder (not possible on Windows, where NTFS logs it)
      if (process.platform !== 'win32') { const dh = await fs.promises.open(d, 'r'); try { await dh.sync(); } finally { await dh.close(); } }
    },
    /** [{ name, size }] of the folder's files; [] when it does not exist. */
    async list(folder) {
      let entries;
      try { entries = await fs.promises.readdir(dir(folder), { withFileTypes: true }); } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
        throw err;
      }
      const out = [];
      for (const e of entries) {
        if (!e.isFile()) continue;
        try { out.push({ name: e.name, size: (await fs.promises.stat(path.join(dir(folder), e.name))).size }); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      }
      return out;
    },
    async remove(folder, name) { await fs.promises.rm(path.join(dir(folder), checked(name)), { force: true }); },
    async folders() {
      try { return (await fs.promises.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
      }
    },
    async removeFolder(folder) { await fs.promises.rm(path.join(root, checked(folder)), { recursive: true, force: true, maxRetries: 3 }); },
  };
}

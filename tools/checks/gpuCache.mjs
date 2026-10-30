// The GPU caches shared by the test runs (the compiled shaders: Chromium's GPU caches and Dawn's blob cache, keyed by
// the shader's hash, so a changed shader is compiled again and the rest is not). Every run gets a user data folder of
// its own (its saves); without the caches it compiles every shader again: 13.8 s to ready cold, 5.6 s warm (?empty,
// 2026-10-30). A run starts with the shared caches copied in, as a player's game starts with its own folder; once its
// Electron has exited (the GPU process holds the files until then) the run gives back the caches that grew.
import fs from 'node:fs';
import path from 'node:path';

const CACHES = ['DawnWebGPUCache', 'DawnGraphiteCache', 'GPUCache', 'GrShaderCache', 'ShaderCache', 'GPUPersistentCache'];

const sizeOf = (dir) => {
  let n = 0;
  try { for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) n += fs.statSync(path.join(e.parentPath, e.name)).size; } catch { /* absent */ }
  return n;
};

/** Copies the shared caches into a run's user data folder (before its Electron starts). */
export function seedGpuCache(own, shared) {
  for (const c of CACHES) {
    const from = path.join(shared, c);
    if (fs.existsSync(from) && !fs.existsSync(path.join(own, c))) fs.cpSync(from, path.join(own, c), { recursive: true });
  }
}

/**
 * Gives back a run's caches that hold more than the shared ones (after its Electron exited). Each one is copied aside
 * and swapped in whole, so runs that end together never leave a mix of two.
 */
export function keepGpuCache(own, shared) {
  fs.mkdirSync(shared, { recursive: true });
  for (const c of CACHES) {
    const mine = path.join(own, c), theirs = path.join(shared, c);
    if (!fs.existsSync(mine) || sizeOf(mine) <= sizeOf(theirs)) continue;
    const tmp = `${theirs}.${process.pid}`;
    try {
      fs.cpSync(mine, tmp, { recursive: true });
      fs.rmSync(theirs, { recursive: true, force: true });
      fs.renameSync(tmp, theirs);
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      console.log(`gpu cache ${c} not kept: ${e.code ?? e.message}`);
    }
  }
}

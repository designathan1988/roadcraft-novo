// Steam through steamworks.js, only in the main process (the page stays isolated).
// Without Steam open (or outside Steam), everything becomes a no-op: the game runs the same.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
let client = null;
let lib = null;

/** Starts Steam. appId: steam_appid.txt next to the executable, otherwise 480 (Spacewar, test). */
export function initSteam(appDir) {
  if (process.env.ROADCRAFT_SHOT || process.env.ROADCRAFT_NO_STEAM) return false;
  try {
    lib = require('steamworks.js');
    let appId = 480;
    for (const dir of [process.cwd(), appDir, path.dirname(process.execPath)]) {
      const f = path.join(dir, 'steam_appid.txt');
      if (fs.existsSync(f)) { appId = Number(fs.readFileSync(f, 'utf8').trim()) || appId; break; }
    }
    client = lib.init(appId);
    return true;
  } catch (err) {
    console.log('Steam unavailable:', err?.message ?? err);
    client = null;
    return false;
  }
}

/** Steam overlay in the Electron window (call after initSteam). */
export function enableOverlay() {
  try { if (lib && client) lib.electronEnableSteamOverlay(); } catch { /* no overlay */ }
}

export function steamInfo() {
  if (!client) return { available: false, name: '' };
  try { return { available: true, name: client.localplayer.getName() }; } catch { return { available: false, name: '' }; }
}

export function unlock(id) {
  if (!client) return false;
  try { return client.achievement.activate(id); } catch { return false; }
}

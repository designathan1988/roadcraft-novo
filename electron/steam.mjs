// Steam through steamworks.js, only in the main process (the page stays isolated).
// Without Steam open (or outside Steam), everything becomes a no-op: the game runs the same.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
let client = null;
let lib = null;

/**
 * Starts Steam. The app id comes from steam_appid.txt next to the executable (or the working folder), or from the
 * SteamAppId variable Steam sets when it launches the game. Without one Steam is not started: the library's default
 * is app 480 (Spacewar), and achievements and the overlay would go to that app (D70). `load` gives the library.
 */
export function initSteam(appDir, load = () => require('steamworks.js')) {
  if (process.env.ROADCRAFT_SHOT || process.env.ROADCRAFT_NO_STEAM) return false;
  let appId = Number(process.env.SteamAppId) || 0;
  for (const dir of [process.cwd(), appDir, path.dirname(process.execPath)]) {
    if (appId) break;
    const f = path.join(dir, 'steam_appid.txt');
    try { if (fs.existsSync(f)) appId = Number(fs.readFileSync(f, 'utf8').trim()) || 0; } catch { /* unreadable: no id */ }
  }
  if (!appId) { console.log('Steam not started: no app id (steam_appid.txt or SteamAppId)'); return false; }
  try {
    lib = load();
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

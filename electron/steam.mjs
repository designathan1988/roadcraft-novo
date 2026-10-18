// Steam pela steamworks.js, só no processo principal (a página continua isolada).
// Sem Steam aberto (ou fora da Steam), tudo vira nada: o jogo roda igual.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
let client = null;
let lib = null;

/** Liga o Steam. appId: steam_appid.txt ao lado do executável, senão 480 (Spacewar, teste). */
export function initSteam(appDir) {
  if (process.env.CIDADE_SHOT || process.env.CIDADE_NO_STEAM) return false;
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
    console.log('Steam indisponível:', err?.message ?? err);
    client = null;
    return false;
  }
}

/** Overlay do Steam na janela do Electron (chamar depois de initSteam). */
export function enableOverlay() {
  try { if (lib && client) lib.electronEnableSteamOverlay(); } catch { /* sem overlay */ }
}

export function steamInfo() {
  if (!client) return { available: false, name: '' };
  try { return { available: true, name: client.localplayer.getName() }; } catch { return { available: false, name: '' }; }
}

export function unlock(id) {
  if (!client) return false;
  try { return client.achievement.activate(id); } catch { return false; }
}

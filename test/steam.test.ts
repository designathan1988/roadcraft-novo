/// <reference types="node" />
// Steam starts only with the game's own app id (D70: without steam_appid.txt the library started app 480,
// Spacewar, and achievements went to the wrong app).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('D70: without an app id Steam is not started; with steam_appid.txt it starts with that id', async () => {
  // a plain .mjs of the Electron side (no declaration file): loaded by its URL
  const { initSteam } = await import(new URL('../electron/steam.mjs', import.meta.url).href) as { initSteam: (dir: string, load: () => unknown) => boolean };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-steam-'));
  const cwd = process.cwd(), env = process.env.SteamAppId;
  delete process.env.SteamAppId;
  const inits: number[] = [];
  const lib = { init: (id: number) => { inits.push(id); return {}; } };
  try {
    process.chdir(dir);
    assert.equal(initSteam(dir, () => lib), false);
    assert.deepEqual(inits, []);
    fs.writeFileSync(path.join(dir, 'steam_appid.txt'), '123456\n');
    assert.equal(initSteam(dir, () => lib), true);
    assert.deepEqual(inits, [123456]);
  } finally {
    process.chdir(cwd);
    if (env !== undefined) process.env.SteamAppId = env;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

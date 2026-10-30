// What the browser's own reload keys do to a city with unsaved work, in the real executable shell (electron/main.mjs),
// with the key sent as a real key: Chromium's DevTools protocol (Input.dispatchKeyEvent) goes through the same path
// as the keyboard, so the window's menu accelerators see it. One session per key, with a user data folder of its own.
// Usage: npx vite build && node tools/check-reload-keys.mjs   (exits with code 1 if a key loses unsaved work)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, findPage, waitReady } from './checks/cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** [name, key, code, Windows key code, modifiers (2 Ctrl, 8 Shift)] */
const KEYS = [['Ctrl+R', 'r', 'KeyR', 82, 2], ['F5', 'F5', 'F5', 116, 0], ['Ctrl+Shift+R', 'R', 'KeyR', 82, 10], ['Ctrl+W', 'w', 'KeyW', 87, 2], ['Alt+F4', 'F4', 'F4', 115, 1]];

/** Opens the game over `own` with the DevTools port; returns the process and a way to talk to the page. */
async function open(own, port) {
  const env = { ...process.env, ROADCRAFT_SHOT: path.join(own, 'shot.png'), ROADCRAFT_QUERY: '?empty&hour=11&workers=3', ROADCRAFT_SCRIPT: '1',
    ROADCRAFT_SETTLE: '200', ROADCRAFT_LIMIT: '260', ROADCRAFT_USER_DATA: own, ROADCRAFT_W: '1600', ROADCRAFT_H: '900', ROADCRAFT_CLOSE_SAVES: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  return spawn(exe, ['.', `--remote-debugging-port=${port}`], { cwd: root, env, stdio: 'ignore' });
}

/** The road segments the save holds: the game opened again over the same folder, its save loaded. */
async function savedSegments(own, port) {
  const p = await open(own, port);
  try {
    const target = await findPage(port, (u) => u.startsWith('app://'));
    if (!target) return -1;
    const tab = await connect(target);
    await waitReady(tab, 120000);
    const n = await tab.evaluate('(async () => { const R = window.__roadcraft; await R.saves.load(); return R.world.roads.segs.size; })()');
    tab.close();
    return n;
  } finally { p.kill(); await wait(1500); }
}

async function session(name, key, code, vk, mods, port) {
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'roadcraft-reload-'));
  const p = await open(own, port);
  let exited = false;
  p.on('exit', () => { exited = true; });
  try {
    let target = await findPage(port, (u) => u.startsWith('app://'));
    if (!target) return `${name}: the game did not open`;
    let tab = await connect(target);
    await waitReady(tab, 120000);
    const before = await tab.evaluate(`(async () => { const R = window.__roadcraft; R.world.unlimited = true; R.actions.road(1400, 1500, 1700, 1500); R.actions.road(1400, 1600, 1700, 1600); window.__sameDocument = 1; return { segs: R.world.roads.segs.size, unsaved: R.lifecycle.unsaved() }; })()`);
    await tab.send('Page.bringToFront');
    for (const type of ['rawKeyDown', 'keyUp']) {
      await tab.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods });
    }
    await wait(8000);
    if (exited) {
      const saved = await savedSegments(own, port + 100);
      return `${name}: the window closed; the edit (${before.segs} segments, unsaved ${before.unsaved}) ${saved >= before.segs ? 'was saved first and came back on reopening' : `was LOST (the save holds ${saved})`}`;
    }
    // the page may have been replaced: talk to it again
    tab.close();
    target = await findPage(port, (u) => u.startsWith('app://'));
    tab = await connect(target);
    await waitReady(tab, 120000);
    const after = await tab.evaluate(`(async () => { const R = window.__roadcraft; const same = window.__sameDocument === 1; const now = R.world.roads.segs.size; const loaded = same ? -1 : (await R.saves.load(), R.world.roads.segs.size); return { same, now, loaded }; })()`);
    tab.close();
    if (after.same) return `${name}: nothing happened (same page, ${after.now} of ${before.segs} segments)`;
    return `${name}: the page reloaded; the edit (${before.segs} segments, unsaved ${before.unsaved}) ${after.loaded >= before.segs ? 'was saved first and came back' : `was LOST (after reload ${after.now}, the save holds ${after.loaded})`}`;
  } finally {
    p.kill();
    await wait(1500);
    fs.rmSync(own, { recursive: true, force: true, maxRetries: 3 });
  }
}

let lost = 0;
for (const [i, k] of KEYS.entries()) {
  const line = await session(...k, 9333 + i);
  if (/LOST/.test(line)) lost++;
  console.log(line);
}
console.log(lost ? `reload keys: ${lost} lose or close the city` : 'reload keys: ok');
process.exit(lost ? 1 : 0);

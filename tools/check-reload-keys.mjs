// What the browser's own reload keys do to a city with unsaved work, in the real executable shell (electron/main.mjs),
// with the key sent as a real key: Chromium's DevTools protocol (Input.dispatchKeyEvent) goes through the same path
// as the keyboard, so the window's menu accelerators see it. One session per key, with a user data folder of its own.
// Usage: npx vite build && node tools/check-reload-keys.mjs   (exits with code 1 if a key loses unsaved work)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** [name, key, code, Windows key code, modifiers (2 Ctrl, 8 Shift)] */
const KEYS = [['Ctrl+R', 'r', 'KeyR', 82, 2], ['F5', 'F5', 'F5', 116, 0], ['Ctrl+Shift+R', 'R', 'KeyR', 82, 10], ['Ctrl+W', 'w', 'KeyW', 87, 2], ['Alt+F4', 'F4', 'F4', 115, 1]];

/** Opens the game over `own` with the DevTools port; returns the process and a way to talk to the page. */
async function open(own, port) {
  const env = { ...process.env, CIDADE_SHOT: path.join(own, 'shot.png'), CIDADE_QUERY: '?vazio&hora=11&workers=3', CIDADE_SCRIPT: '1',
    CIDADE_SETTLE: '200', CIDADE_LIMIT: '260', CIDADE_USER_DATA: own, CIDADE_W: '1600', CIDADE_H: '900', CIDADE_CLOSE_SAVES: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  return spawn(exe, ['.', `--remote-debugging-port=${port}`], { cwd: root, env, stdio: 'ignore' });
}

/** The road segments the save holds: the game opened again over the same folder, its save loaded. */
async function savedSegments(own, port) {
  const p = await open(own, port);
  try {
    let target = null;
    for (let k = 0; k < 120 && !target; k++) { await wait(500); try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && t.url.startsWith('app://')); } catch { /* not up */ } }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const ev = (expr) => new Promise((r) => { ws.onmessage = (m) => r(JSON.parse(m.data).result?.result?.value); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })); });
    for (let k = 0; k < 240 && (await ev('window.__cidade && window.__cidade.status')) !== 'pronto'; k++) await wait(500);
    const n = await ev('(async () => { const g = window.__cidade.game; await g.saving.load(); return g.world.roads.segs.size; })()');
    ws.close();
    return n;
  } finally { p.kill(); await wait(1500); }
}

async function session(name, key, code, vk, mods, port) {
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'roadcraft-reload-'));
  const p = await open(own, port);
  let exited = false;
  p.on('exit', () => { exited = true; });
  try {
    let target = null;
    for (let k = 0; k < 120 && !target; k++) {
      await wait(500);
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && t.url.startsWith('app://')); } catch { /* not up yet */ }
    }
    if (!target) return `${name}: the game did not open`;
    let ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
    const call = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const evaluate = async (expr) => (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
    for (let k = 0; k < 240 && (await evaluate('window.__cidade && window.__cidade.status')) !== 'pronto'; k++) await wait(500);
    const before = await evaluate(`(async () => { const g = window.__cidade.game; g.world.unlimited = true; g.api.road(1400, 1500, 1700, 1500); g.api.road(1400, 1600, 1700, 1600); window.__sameDocument = 1; return { segs: g.world.roads.segs.size, unsaved: g.unsaved }; })()`);
    await call('Page.bringToFront');
    for (const type of ['rawKeyDown', 'keyUp']) {
      await call('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods });
    }
    await wait(8000);
    if (exited) {
      const saved = await savedSegments(own, port + 100);
      return `${name}: the window closed; the edit (${before.segs} segments, unsaved ${before.unsaved}) ${saved >= before.segs ? 'was saved first and came back on reopening' : `was LOST (the save holds ${saved})`}`;
    }
    // the page may have been replaced: talk to it again
    try { ws.close(); } catch { /* gone */ }
    target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && t.url.startsWith('app://'));
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
    for (let k = 0; k < 240 && (await evaluate('window.__cidade && window.__cidade.status')) !== 'pronto'; k++) await wait(500);
    const after = await evaluate(`(async () => { const g = window.__cidade.game; const same = window.__sameDocument === 1; const now = g.world.roads.segs.size; const loaded = same ? -1 : (await g.saving.load(), g.world.roads.segs.size); return { same, now, loaded }; })()`);
    ws.close();
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

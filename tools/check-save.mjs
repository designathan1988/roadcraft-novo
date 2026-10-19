// Saving and loading checked in the real game (the machine's GPU), one scenario per Electron session with a user data
// folder of its own (never the game's). Each scenario edits, saves, fails on purpose, loads, and checks the world.
// Usage: npx vite build && node tools/check-save.mjs [scenario...]   (exits with code 1 if anything fails)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Page helpers shared by every scenario: results are printed as "CHECK OK|FAILED name" and the run ends with "CHECK END".
const PRELUDE = `
const g = window.__cidade.game, a = g.api, w = g.world;
const errors = [];
const logError = console.error.bind(console);
console.error = (...x) => { errors.push(x.map(String).join(' ').slice(0, 300)); logError(...x); };
window.addEventListener('error', (e) => errors.push('error: ' + (e.message || e.error)));
window.addEventListener('unhandledrejection', (e) => errors.push('rejection: ' + (e.reason && e.reason.message || e.reason)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms) => Promise.race([p.then(() => 'returned'), wait(ms).then(() => 'hung')]);
const check = (name, ok, why) => console.log('CHECK ' + (ok ? 'OK ' : 'FAILED ') + name + (ok ? '' : ': ' + why));
const dirtyTiles = () => { const out = []; for (let t = 0; t < w.saveDirty.length; t++) if (w.saveDirty[t]) out.push(t); return out; };
const road = (ax, az, bx, bz) => { const r = a.road(ax, az, bx, bz); if (r !== 'ok') throw new Error('road refused: ' + r); };
w.unlimited = true;
`;

const SCENARIOS = {
  // A1, A2, A3: a tile write that fails leaves the work unsaved and marked, the game free, and a later save works
  'failed-save': `
    road(1500, 1500, 1700, 1500);
    const before = w.roads.segs.size, marked = dirtyTiles();
    check('an edit marks tiles to save', marked.length > 0 && g.unsaved, 'unsaved=' + g.unsaved + ' tiles=' + marked);
    const P = g.pool, submit = P.submit.bind(P);
    let fail = true;
    P.submit = (k, p, d, o) => submit(k, k === 'saveTile' && fail ? { ...p, slot: '' } : p, d, o);
    const r = await within(g.save(false), 10000);
    check('a failed save returns', r === 'returned', 'save() ' + r);
    check('the game is free after a failed save', g.busy === false, 'busy=' + g.busy);
    check('a failed save leaves the work unsaved', g.unsaved === true, 'unsaved=' + g.unsaved);
    check('a failed save keeps the tiles marked', marked.every((t) => w.saveDirty[t]), 'marked now: ' + dirtyTiles());
    fail = false;
    const r2 = await within(g.save(false), 10000);
    check('the next save works', r2 === 'returned' && !g.unsaved && dirtyTiles().length === 0, 'save() ' + r2 + ' unsaved=' + g.unsaved + ' tiles=' + dirtyTiles());
    const r3 = await within(g.load(), 30000);
    check('the saved road comes back', r3 === 'returned' && w.roads.segs.size === before, 'load() ' + r3 + ', segments ' + w.roads.segs.size + ' of ' + before);
  `,
  // A11, A12: an old map repaired on opening, then edited elsewhere and saved incrementally, opens again
  'repair-then-reopen': `
    const net = w.roads;
    // the old-map defect the repair fixes: a dead end lying inside another road (not something the tools make)
    const n = (x, z) => net.addNode({ x, z, y: 10 });
    const A = n(1400, 1500), B = n(1700, 1500), C = n(1550, 1500.5), D = n(1550, 1600);
    net.addSeg({ a: A, b: B, cx: 1550, cz: 1500, profile: 0, flags: 0, zl: 0, zr: 0 });
    net.addSeg({ a: C, b: D, cx: 1550, cz: 1550, profile: 0, flags: 0, zl: 0, zr: 0 });
    for (let t = 0; t < w.saveDirty.length; t++) w.saveDirty[t] = 1;
    await g.save(false);
    let r = await within(g.load(), 30000);
    check('the old map opens (and is repaired)', r === 'returned' && !g.busy, 'load() ' + r);
    road(-2000, -2000, -1800, -2000);
    await g.save(false);
    const segs = w.roads.segs.size;
    const e0 = errors.length;
    r = await within(g.load(), 30000);
    check('the map opens again after an incremental save', r === 'returned' && !g.busy && errors.length === e0, 'load() ' + r + ' busy=' + g.busy + ' errors: ' + errors.slice(e0).join(' | '));
    check('nothing lost or doubled', w.roads.segs.size === segs, 'segments ' + w.roads.segs.size + ' of ' + segs);
  `,
  // A26: generating a city after loading another one does not keep the old city's tiles in the save
  'generate-after-load': `
    road(4000, 4000, 4200, 4000);
    await g.save(false);
    await g.load();
    const listed = w.tileInSave.reduce((s, v) => s + v, 0);
    check('the loaded city lists its saved tiles', listed > 0, 'tiles listed: ' + listed);
    const r = await within(g.generatedCity(), 240000);
    const left = w.tileInSave.reduce((s, v) => s + v, 0);
    check('the generated city does not list the old city\\'s tiles', r === 'returned' && left === 0, 'generatedCity() ' + r + ', old tiles still listed: ' + left);
  `,
  // A34: opening a broken map file never destroys the player's save
  'import-broken-file': `
    road(1500, 1500, 1700, 1500);
    await g.save(false);
    const before = w.roads.segs.size;
    // a package of the player's own save with its map description garbled
    const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('saves')).getDirectoryHandle('cidade-1');
    const enc = new TextEncoder(), parts = [], body = [];
    let count = 0;
    for await (const [name, h] of dir) {
      if (h.kind !== 'file') continue;
      let data = new Uint8Array(await (await h.getFile()).arrayBuffer());
      if (name.startsWith('meta')) data = data.map((v, i) => (i > 4 ? v ^ 0x5a : v));
      const nm = enc.encode(name), hdr = new DataView(new ArrayBuffer(8));
      hdr.setUint32(0, nm.length, true); hdr.setUint32(4, data.length, true);
      body.push(hdr.buffer, nm, data); count++;
    }
    const nb = new DataView(new ArrayBuffer(4)); nb.setUint32(0, count, true);
    parts.push(enc.encode('CIDADE-MAPA-1'), nb.buffer, ...body);
    // the save's files, byte for byte, before the import
    const files = async () => { const m = new Map(); const d = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('saves')).getDirectoryHandle('cidade-1');
      for await (const [name, h] of d) if (h.kind === 'file') m.set(name, Array.from(new Uint8Array(await (await h.getFile()).arrayBuffer())).join(',')); return m; };
    const saved = await files();
    const r = await within(g.importMap(new Blob(parts)), 30000);
    check('opening the broken file returns', r === 'returned' && !g.busy, 'importMap() ' + r + ' busy=' + g.busy);
    const now = await files();
    const same = saved.size === now.size && [...saved].every(([k, v]) => now.get(k) === v);
    check('the player\\'s save files are untouched', same, 'files before ' + [...saved.keys()] + ', after ' + [...now.keys()] + (saved.size === now.size ? ' (contents changed)' : ''));
    void before;
  `,
  // A28: closing the game saves what was not saved yet (two sessions over the same user data folder)
  'close-saves': [`
    road(1500, 1500, 1700, 1500);
    check('there is something unsaved', g.unsaved === true, 'unsaved=' + g.unsaved);
    console.log('CHECK END');
    // the game's own Quit (the window's X and Alt+F4 go through the same close event)
    window.roadcraftApp.quit();
    await wait(30000);
  `, `
    const r = await within(g.load(), 30000);
    check('the road built before closing is there', r === 'returned' && w.roads.segs.size > 0, 'load() ' + r + ', segments ' + w.roads.segs.size);
  `],
  // B1: changing the language (which reloads the page) saves the city first
  'language-saves': [`
    road(1500, 1500, 1700, 1500);
    check('there is something unsaved', g.unsaved === true, 'unsaved=' + g.unsaved);
    console.log('CHECK END');
    // not awaited: the page reloads under the script (the session then quits; the next one opens the save)
    void window.__cidade.setLang('en');
    await wait(15000);
  `, `
    const r = await within(g.load(), 30000);
    check('the road built before the language change is there', r === 'returned' && w.roads.segs.size > 0, 'load() ' + r + ', segments ' + w.roads.segs.size);
  `],
};

const pick = process.argv.slice(2);
const names = pick.length ? pick : Object.keys(SCENARIOS);
let failed = 0;
for (const name of names) {
  const bodies = SCENARIOS[name];
  if (!bodies) { console.log(`unknown scenario ${name}`); failed++; continue; }
  // a scenario is one session, or several sessions one after the other over the same folder (closing and reopening)
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'roadcraft-save-'));
  const checks = [];
  for (const body of Array.isArray(bodies) ? bodies : [bodies]) {
    const script = `(async()=>{${PRELUDE}\ntry {${body}\n} catch (e) { check('scenario ran to the end', false, e && e.stack || e); }\nconsole.log('CHECK END');})()`;
    const lines = await new Promise((resolve) => {
      const out = [];
      const p = spawn(process.execPath, [path.join(root, 'tools', 'shot.mjs'), path.join(own, 'shot.png'), '?vazio&hora=11&workers=3', script],
        { cwd: root, env: { ...process.env, CIDADE_USER_DATA: own, CIDADE_SETTLE: '1', CIDADE_LIMIT: '420', CIDADE_CLOSE_SAVES: '1' } });
      p.stdout.on('data', (d) => out.push(...String(d).split('\n')));
      p.on('exit', () => resolve(out));
    });
    const got = lines.filter((l) => l.includes('CHECK ')).map((l) => l.slice(l.indexOf('CHECK ') + 6));
    if (!got.includes('END')) got.push('FAILED the session did not finish (hung or crashed) after: ' + (got[got.length - 1] ?? 'nothing'));
    checks.push(...got.filter((c) => c !== 'END'));
  }
  const bad = checks.filter((c) => c.startsWith('FAILED'));
  failed += bad.length;
  console.log(`${name}: ${checks.filter((c) => c.startsWith('OK')).length} ok, ${bad.length} failed`);
  for (const c of bad) console.log('  ' + c);
  fs.rmSync(own, { recursive: true, force: true, maxRetries: 3 });
}
console.log(failed ? `save check: ${failed} FAILED` : 'save check: ok');
process.exit(failed ? 1 : 0);

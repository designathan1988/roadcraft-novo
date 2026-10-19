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
const roadAt = (x, z) => w.roads.nearestSeg(x, z, 6) !== null;
// segments whose ends are not live nodes (a road shooting off to wherever a dead node's numbers point)
const deadEnds = () => { const s = w.roads.segs, c = s.cols, n = w.roads.nodes.alive; let k = 0; for (let i = 0; i < s.alive.length; i++) if (s.alive[i] && (!n[c.a[i]] || !n[c.b[i]])) k++; return k; };
// the save's file storage (g.saveStore, a FileStore, since saves are written by the page); before that, the browser storage
const saveStore = async () => g.saveStore ? await g.saveStore : null;
// makes every write of a file whose name matches \`re\` fail, until the returned function is called
const failWrites = async (re) => {
  const st = await saveStore();
  if (st) { const write = st.write; st.write = (f, n, d) => re.test(n) ? Promise.reject(new Error('disk full (test)')) : write.call(st, f, n, d); return () => { st.write = write; }; }
  const P = g.pool, submit = P.submit;
  P.submit = (k, p, d, o) => submit.call(P, k, (k === 'saveMeta' && re.test('meta.bin')) || (k === 'saveTile' && re.test('tile')) ? { ...p, slot: '' } : p, d, o);
  return () => { P.submit = submit; };
};
// makes the storage fail as it would on its own (denied, unreadable…) for files and folders whose name matches re;
// before the page read the save files, the workers' reads are sent to a folder that cannot exist
const failStorage = async (re) => {
  const st = await saveStore();
  const broken = () => new DOMException('the storage failed (test)', 'NotReadableError');
  if (st && st.bridge) {
    const b = st.bridge;
    st.bridge = { ...b, read: (f, n) => re.test(n) || re.test(f) ? Promise.reject(broken()) : b.read(f, n), list: (f) => re.test(f) ? Promise.reject(broken()) : b.list(f) };
    return () => { st.bridge = b; };
  }
  if (st) {
    const D = FileSystemDirectoryHandle.prototype, getFile = D.getFileHandle, getDir = D.getDirectoryHandle;
    D.getFileHandle = function (n, o) { return re.test(n) ? Promise.reject(broken()) : getFile.call(this, n, o); };
    D.getDirectoryHandle = function (n, o) { return re.test(n) ? Promise.reject(broken()) : getDir.call(this, n, o); };
    return () => { D.getFileHandle = getFile; D.getDirectoryHandle = getDir; };
  }
  const P = g.pool, submit = P.submit;
  const hit = (k, p) => (k === 'loadMeta' && (re.test('meta.bin') || re.test(SLOT))) || (k === 'loadTile' && re.test('tile_' + String(p.tile).padStart(4, '0') + '.bin'));
  P.submit = (k, p, d, o) => submit.call(P, k, hit(k, p) ? { ...p, slot: '' } : p, d, o);
  return () => { P.submit = submit; };
};
// the tile holding (x, z)
const MT = Math.round(Math.sqrt(w.tileInSave.length));
const tileOf = (x, z) => { const f = (v) => Math.min(MT - 1, Math.max(0, Math.floor((v + MT * 512) / 1024))); return f(z) * MT + f(x); };
const SLOT = 'cidade-1';
// the save's files: through the game's FileStore once the page writes them; before that, straight from the browser storage
const opfs = async (folder, create = false) => { const s = await (await navigator.storage.getDirectory()).getDirectoryHandle('saves', { create }); return folder ? s.getDirectoryHandle(folder, { create }) : s; };
const files = {
  async list(folder = SLOT) {
    const st = await saveStore(); if (st) return (await st.list(folder)).map((e) => e.name);
    const out = []; try { for await (const [n, h] of await opfs(folder)) if (h.kind === 'file') out.push(n); } catch { /* none */ } return out;
  },
  async read(name, folder = SLOT) {
    const st = await saveStore(); if (st) return st.read(folder, name);
    try { return new Uint8Array(await (await (await (await opfs(folder)).getFileHandle(name)).getFile()).arrayBuffer()); } catch { return null; }
  },
  async write(name, data, folder = SLOT) {
    const st = await saveStore(); if (st) return st.write(folder, name, data);
    const wr = await (await (await opfs(folder, true)).getFileHandle(name, { create: true })).createWritable(); await wr.write(data); await wr.close();
  },
  async remove(name, folder = SLOT) { const st = await saveStore(); if (st) return st.remove(folder, name); await (await opfs(folder)).removeEntry(name); },
  async folders() {
    const st = await saveStore(); if (st) return st.folders();
    const out = []; try { for await (const [n, h] of await opfs('')) if (h.kind === 'directory') out.push(n); } catch { /* none */ } return out;
  },
  // name → bytes as text, to compare a folder before and after
  async snapshot(folder = SLOT) { const m = new Map(); for (const n of await files.list(folder)) m.set(n, Array.from(await files.read(n, folder)).join(',')); return m; },
};
const sameFiles = (x, y) => x.size === y.size && [...x].every(([k, v]) => y.get(k) === v);
// the file holding tile t in the save the slot opens: the committed manifest's entry, or tile_NNNN.bin before generations
const tileFile = async (t) => {
  const cur = await files.read('current.json');
  if (!cur) return 'tile_' + String(t).padStart(4, '0') + '.bin';
  const m = JSON.parse(new TextDecoder().decode(await files.read(JSON.parse(new TextDecoder().decode(cur)).manifest.file)));
  const e = m.tiles.find((x) => x[0] === t); return e ? e[1] : null;
};
// a map package (mapFile.ts) as its files [name, bytes], and a package made of files
const unpack = async (blob) => {
  const b = new Uint8Array(await blob.arrayBuffer()), dv = new DataView(b.buffer); let o = 13; const n = dv.getUint32(o, true); o += 4; const out = [];
  for (let k = 0; k < n; k++) { const nl = dv.getUint32(o, true), dl = dv.getUint32(o + 4, true); o += 8; out.push([new TextDecoder().decode(b.subarray(o, o + nl)), b.slice(o + nl, o + nl + dl)]); o += nl + dl; }
  return out;
};
const pack = (list) => {
  const enc = new TextEncoder(), parts = [enc.encode('CIDADE-MAPA-1')], nb = new DataView(new ArrayBuffer(4)); nb.setUint32(0, list.length, true); parts.push(nb.buffer);
  for (const [name, data] of list) { const nm = enc.encode(name), hdr = new DataView(new ArrayBuffer(8)); hdr.setUint32(0, nm.length, true); hdr.setUint32(4, data.length, true); parts.push(hdr.buffer, nm, data); }
  return new Blob(parts);
};
// every toast the game shows from here on
const toasts = [];
{ const show = g.hud.toast; g.hud.toast = function (m, ...r) { toasts.push(String(m)); return show.call(this, m, ...r); }; }
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
    // a package of the player's own save with its map description garbled
    const list = [];
    for (const n of await files.list()) { let d = await files.read(n); if (n.startsWith('meta')) d = d.map((v, i) => (i > 4 ? v ^ 0x5a : v)); list.push([n, d]); }
    // the save's files, byte for byte, before the import
    const saved = await files.snapshot();
    const r = await within(g.importMap(pack(list)), 30000);
    check('opening the broken file returns', r === 'returned' && !g.busy, 'importMap() ' + r + ' busy=' + g.busy);
    const now = await files.snapshot();
    check('the player\\'s save files are untouched', sameFiles(saved, now), 'files before ' + [...saved.keys()] + ', after ' + [...now.keys()] + (saved.size === now.size ? ' (contents changed)' : ''));
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
  // A15: a tile the save lists but whose file is gone comes back from the seed (not with the terrain of the city that
  // was on screen), and the player is told
  'missing-tile': `
    const x = 1600, z = 1560, seed = a.ground(x, z);
    for (let k = 0; k < 5; k++) a.terrain('raise', x, z, 150, 1);
    road(1500, 1500, 1700, 1500);
    check('the edit raised the terrain', a.ground(x, z) - seed > 1, 'from ' + seed + ' to ' + a.ground(x, z));
    check('the save completes', await g.save(false) === true, 'save() did not complete');
    // the city on screen changes again and is not saved: its terrain must not leak into the opened save
    for (let k = 0; k < 2; k++) a.terrain('lower', x, z, 150, 1);
    const onScreen = a.ground(x, z);
    await files.remove(await tileFile(tileOf(x, z)));
    toasts.length = 0;
    const r = await within(g.load(), 30000);
    check('the save opens', r === 'returned' && !g.busy, 'load() ' + r);
    const h = a.ground(x, z);
    check('the lost tile comes back from the seed', Math.abs(h - seed) < 0.05, 'height ' + h + ', seed ' + seed + ', the city on screen had ' + onScreen);
    check('the player is told that part of the map was lost', toasts.some((m) => /pedaço|pedaços/.test(m)), 'toasts: ' + toasts.join(' | '));
  `,
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

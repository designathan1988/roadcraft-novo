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
    const heal = await failWrites(/^tile/);
    const r = await within(g.save(false), 10000);
    check('a failed save returns', r === 'returned', 'save() ' + r);
    check('the game is free after a failed save', g.busy === false, 'busy=' + g.busy);
    check('a failed save leaves the work unsaved', g.unsaved === true, 'unsaved=' + g.unsaved);
    check('a failed save keeps the tiles marked', marked.every((t) => w.saveDirty[t]), 'marked now: ' + dirtyTiles());
    heal();
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
  // A9: a save interrupted between the tile files and its commit (the map description fails to be written, then the
  // game is closed while the close save fails the same way) leaves the save before it intact, and that save opens
  'interrupted-save': [`
    road(1500, 1500, 1700, 1500);
    check('the first save completes', await g.save(false) === true, 'save() did not complete');
    // after it: another road in the same tile (its file is written again) and one in a tile not saved yet
    road(1500, 1620, 1700, 1620);
    road(-3000, -3000, -2800, -3000);
    await failWrites(/^(meta|current|manifest)/);
    check('the interrupted save reports that it did not complete', await g.save(false) === false, 'save() said it completed');
    console.log('CHECK END');
    window.roadcraftApp.quit();
    await wait(30000);
  `, `
    const r = await within(g.load(), 30000);
    check('the save before the interrupted one opens', r === 'returned' && !g.busy && !g.saveBlocked, 'load() ' + r + ' busy=' + g.busy + ' blocked=' + g.saveBlocked);
    check('it is that save, intact: its road and none of the later ones', roadAt(1600, 1500) && !roadAt(1600, 1620) && !roadAt(-2900, -3000),
      'roads: first ' + roadAt(1600, 1500) + ', same tile later ' + roadAt(1600, 1620) + ', other tile later ' + roadAt(-2900, -3000));
    check('no road ends on a missing node', deadEnds() === 0, deadEnds() + ' segments with a dead end');
    check('no errors', errors.length === 0, errors.join(' | '));
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
  // A16: a storage that fails is not "no save found", and a tile that cannot be read because the storage failed is not
  // "damaged": the opening stops, nothing is quarantined or rewritten, and once the storage works the save opens
  'storage-error': `
    road(1500, 1500, 1700, 1500);
    check('the save completes', await g.save(false) === true, 'save() did not complete');
    const before = await files.snapshot(), folders = (await files.folders()).length;
    let heal = await failStorage(/^(meta|current|manifest|cidade-1$)/);
    toasts.length = 0;
    let r = await within(g.load(), 30000);
    heal();
    check('a storage failure is not reported as no save', r === 'returned' && toasts.length > 0 && !toasts.some((m) => /Nenhum salvamento|No save/.test(m)), 'load() ' + r + ', toasts: ' + toasts.join(' | '));
    const file = await tileFile(tileOf(1600, 1500));
    heal = await failStorage({ test: (n) => n === file });
    toasts.length = 0;
    r = await within(g.load(), 30000);
    heal();
    check('the opening returns', r === 'returned' && !g.busy, 'load() ' + r);
    check('a tile the storage failed to read is not called damaged or lost', !toasts.some((m) => /ilegíve|pedaço|quarentena/.test(m)), 'toasts: ' + toasts.join(' | '));
    check('nothing went to quarantine', (await files.folders()).length === folders, 'folders ' + folders + ' → ' + (await files.folders()));
    check('the save files are untouched', sameFiles(before, await files.snapshot()), 'files changed');
    r = await within(g.load(), 30000);
    check('once the storage works the save opens with its road', r === 'returned' && !g.busy && !g.saveBlocked && roadAt(1600, 1500), 'load() ' + r + ' blocked=' + g.saveBlocked + ' road=' + roadAt(1600, 1500));
  `,
  // A36: exporting packs only the files of the city saved now (never tiles of a city saved earlier in the same slot),
  // and opening an old package that carries such a file does not take it in
  'export-this-city': `
    road(-4000, -4000, -3800, -4000);
    check('the first city is saved', await g.save(false) === true, 'save() did not complete');
    await g.newMap();
    w.unlimited = true;
    road(1500, 1500, 1700, 1500);
    check('the second city is saved', await g.save(false) === true, 'save() did not complete');
    const listed = () => w.tileInSave.reduce((s, v) => s + v, 0);
    let names = (await unpack(await a.packMap())).map(([n]) => n);
    check('the export holds one file per tile of this city', names.filter((n) => n.startsWith('tile_')).length === listed(), names.length + ' files: ' + names + '; tiles listed ' + listed());
    // an old-style package (meta.bin + tile_NNNN.bin) that also carries a file of a tile its map does not list
    const old = (await unpack(await a.packMap())).filter(([n]) => n === 'meta.bin' || /^tile_[0-9]{4}[.]bin$/.test(n));
    if (old.length) {
      old.push(['tile_0000.bin', old.find(([n]) => n.startsWith('tile_'))[1]]);
      await g.importMap(pack(old));
      names = (await unpack(await a.packMap())).map(([n]) => n);
      check('a stray tile file of an opened package is not taken in', names.filter((n) => n.startsWith('tile_')).length === listed(), names + '; tiles listed ' + listed());
    }
  `,
  // A13: when a tile cannot be read, the roads of the tile next to it that end in it do not link to its dead nodes
  'unreadable-neighbour': `
    road(-150, 1500, 150, 1500);
    const s = w.roads.nearestSeg(0, 1500, 6)[0], c = w.roads.segs.cols, n = w.roads.nodes.cols;
    const ta = tileOf(n.x[c.a[s]], n.z[c.a[s]]), tb = tileOf(n.x[c.b[s]], n.z[c.b[s]]);
    check('the road crosses from one tile to the next', ta !== tb, 'tiles ' + ta + ', ' + tb);
    check('the save completes', await g.save(false) === true, 'save() did not complete');
    // the tile of the far end (the segment is saved with its first end) is damaged
    const file = await tileFile(tb), data = await files.read(file);
    await files.write(file, data.map((v, i) => (i > 8 ? v ^ 0xa5 : v)));
    const e0 = errors.length;
    const r = await within(g.load(), 30000);
    check('the save opens', r === 'returned' && !g.busy, 'load() ' + r);
    check('no road ends on a node that was not read', deadEnds() === 0, deadEnds() + ' segments with a dead end; errors: ' + errors.slice(e0).join(' | '));
  `,
  // A14: a damaged tile goes to quarantine once, not at every opening; the next save writes that tile again, and then
  // the save opens clean
  'quarantine-once': `
    road(1500, 1500, 1700, 1500);
    check('the save completes', await g.save(false) === true, 'save() did not complete');
    const file = await tileFile(tileOf(1600, 1500)), data = await files.read(file);
    await files.write(file, data.map((v, i) => (i > 8 ? v ^ 0xa5 : v)));
    const quarantines = async () => (await files.folders()).filter((f) => f.startsWith('quarentena-')).length;
    for (let k = 0; k < 3; k++) await g.load();
    check('opening the same damaged save three times quarantines it once', await quarantines() === 1, (await quarantines()) + ' quarantine folders');
    check('the damaged tile is marked to be written again', w.saveDirty[tileOf(1600, 1500)] === 1, 'not marked');
    check('the next save completes', await g.save(false) === true, 'save() did not complete');
    toasts.length = 0;
    await g.load();
    check('then the save opens clean', !toasts.some((m) => /ilegíve|pedaço/.test(m)) && await quarantines() === 1, 'toasts: ' + toasts.join(' | ') + '; quarantines ' + (await quarantines()));
  `,
  // A17: lots the workers were still making for the city on screen are not taken in by the city opened after it (no
  // building of the old city grows in the new one)
  'stale-lots': `
    road(1500, 1500, 1700, 1500);
    check('the save completes', await g.save(false) === true, 'save() did not complete');
    // the workers get lot jobs 4 s late (as when they are busy), so the lots of the next road are still being made
    for (const wk of g.pool.workers) { if (!wk) continue; const post = wk.postMessage.bind(wk); wk.postMessage = (m, tr) => m && m.kind === 'lots' ? setTimeout(() => post(m, tr), 4000) : post(m, tr); }
    road(-3000, -3000, -2600, -3000);
    a.zone(-2800, -3000, 80, 1);
    await wait(500);
    const r = await within(g.load(), 30000);
    check('the save opens', r === 'returned' && !g.busy, 'load() ' + r);
    await wait(9000);
    let grown = 0;
    w.buildingIndex.query(-3100, -3100, -2500, -2900, () => { grown++; });
    check('no building of the city on screen before grows in the opened one', grown === 0 && !roadAt(-2800, -3000), grown + ' buildings where the old city had its zoned road');
  `,
  // A10: two openings, or an opening and a save, never run together (nothing is inserted twice)
  'overlap': `
    road(1500, 1500, 1700, 1500);
    check('the save completes', await g.save(false) === true, 'save() did not complete');
    const segs = w.roads.segs.size, builds = w.buildings.size, e0 = errors.length;
    const [l1, l2] = await Promise.all([g.load(), g.load()]);
    check('a second opening while one runs is refused', l1 === true && l2 === false, 'load() ' + l1 + ', ' + l2);
    const [l3, s3] = await Promise.all([g.load(), g.save(false)]);
    check('a save while opening is refused', l3 === true && s3 === false, 'load() ' + l3 + ', save() ' + s3);
    const [s4, l4] = await Promise.all([g.save(false), g.load()]);
    check('an opening while saving is refused', s4 === true && l4 === false, 'save() ' + s4 + ', load() ' + l4);
    check('nothing is doubled', w.roads.segs.size === segs && w.buildings.size === builds && errors.length === e0, 'segments ' + w.roads.segs.size + ' of ' + segs + ', errors: ' + errors.slice(e0).join(' | '));
  `,
  // A31: with unlimited money on, the balance is saved too: turning it off after opening gives the balance back
  'unlimited-money': `
    road(1500, 1500, 1700, 1500);
    w.money = 12345;
    w.unlimited = true;
    check('the save completes', await g.save(false) === true, 'save() did not complete');
    w.money = 1; w.unlimited = false;
    await g.load();
    check('unlimited money is still on after opening', w.unlimited === true, 'unlimited=' + w.unlimited);
    w.unlimited = false;
    check('turning it off gives the saved balance', w.money === 12345, 'money ' + w.money);
  `,
  // A43: the test city sets each tile's height range from its own terrain, not the previous map's
  'test-city-heights': `
    w.tileMin[0] = -500; w.tileMax[0] = 900;
    const r = await within(g.testCity(), 300000);
    check('the test city is made', r === 'returned' && !g.busy, 'testCity() ' + r);
    const per = w.heights.length / w.tileInSave.length;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < per; i++) { const h = w.heights[i]; if (h < lo) lo = h; if (h > hi) hi = h; }
    check('tile 0 has its own height range', Math.abs(w.tileMin[0] - lo) < 1 && Math.abs(w.tileMax[0] - hi) < 1, 'range ' + w.tileMin[0] + '..' + w.tileMax[0] + ', terrain ' + lo + '..' + hi);
  `,
  // A39: the game's own protocol (app://) serves only files inside dist/, never from a folder next to it whose name
  // starts with "dist" (SETUP makes one)
  'app-path': `
    const inside = await fetch('app://cidade/index.html').then((r) => r.status, () => 'error');
    check('a file inside dist/ is served', inside === 200, 'status ' + inside);
    const next = await fetch('app://cidade/..%2Fdist-probe%2Fprobe.txt').then(async (r) => r.status + ' ' + (await r.text()).slice(0, 20), () => 'refused');
    check('a file in a folder next to dist/ is not', !next.includes('outside dist'), 'served: ' + next);
  `,
  // The desktop game keeps its saves as real files in <user data>/saves (POST checks the disk), not in the browser storage
  'desktop-files': `
    road(1500, 1500, 1700, 1500);
    check('the save completes', await g.save(false) === true, 'save() did not complete');
    let inBrowser = [];
    try { for await (const [n] of await opfs(SLOT)) inBrowser.push(n); } catch { /* no such folder: right */ }
    check('nothing of it is in the browser storage', inBrowser.length === 0, 'browser storage holds ' + inBrowser);
  `,
  // Saves an earlier desktop version kept in the browser storage are copied to files once, open, and stay where they were
  'migrate-opfs': [`
    road(1500, 1500, 1700, 1500);
    check('the save completes', await g.save(false) === true, 'save() did not complete');
    // the same city as an earlier version left it: meta.bin and tile_NNNN.bin in the browser storage, no files
    const cur = JSON.parse(new TextDecoder().decode(await files.read('current.json')));
    const man = JSON.parse(new TextDecoder().decode(await files.read(cur.manifest.file)));
    const raw = async (name, data) => { const wr = await (await (await opfs(SLOT, true)).getFileHandle(name, { create: true })).createWritable(); await wr.write(data); await wr.close(); };
    await raw('meta.bin', await files.read(man.meta.file));
    for (const [t, file] of man.tiles) await raw('tile_' + String(t).padStart(4, '0') + '.bin', await files.read(file));
    const st = await saveStore();
    await st.removeFolder(SLOT);
    await st.remove('', 'migrated-from-browser-storage.json');
    console.log('CHECK END');
  `, `
    const r = await within(g.load(), 30000);
    check('the save of the earlier version opens', r === 'returned' && roadAt(1600, 1500), 'load() ' + r + ', road ' + roadAt(1600, 1500));
    check('it was copied to files', (await files.list()).includes('meta.bin'), 'files: ' + (await files.list()));
    const left = []; try { for await (const [n] of await opfs(SLOT)) left.push(n); } catch { /* gone */ }
    check('the browser storage still has it', left.includes('meta.bin') && left.some((n) => n.startsWith('tile_')), 'browser storage: ' + left);
  `],
  // Previous cities: a city another one replaced in the save is listed, and opening it puts it back (the city that was
  // in the save goes aside in its turn)
  'previous-cities': `
    road(-4000, -4000, -3800, -4000);
    check('the first city is saved', await g.save(false) === true, 'save() did not complete');
    await g.newMap();
    w.unlimited = true;
    road(1500, 1500, 1700, 1500);
    check('the second city is saved', await g.save(false) === true, 'save() did not complete');
    const list = await g.hudActions.previousCities();
    check('the first city is listed as a previous city', list.length === 1 && list[0].tiles >= 1 && list[0].bytes > 0 && !!list[0].saved, JSON.stringify(list));
    g.hudActions.openPreviousCity(list[0].folder);
    for (let k = 0; k < 120 && (g.busy || !roadAt(-3900, -4000)); k++) await wait(250);
    check('opening it brings it back', roadAt(-3900, -4000) && !roadAt(1600, 1500) && !g.busy, 'first city road ' + roadAt(-3900, -4000) + ', second ' + roadAt(1600, 1500));
    const after = await g.hudActions.previousCities();
    check('the city that was in the save is now a previous city', after.some((c) => c.gameId !== list[0].gameId), JSON.stringify(after));
    check('and the save works', await g.save(false) === true, 'save() did not complete');
  `,
  // Reload keys of the desktop window (Ctrl+R, F5, Ctrl+Shift+R) never throw away work that was not saved: the edit is
  // there at the next opening (two sessions over the same user data folder)
  ...Object.fromEntries([['reload-ctrl-r', 'R', ['control']], ['reload-f5', 'F5', []], ['reload-ctrl-shift-r', 'R', ['control', 'shift']]].map(([name, key, mods]) => [name, [`
    road(1500, 1500, 1700, 1500);
    check('there is something unsaved', g.unsaved === true, 'unsaved=' + g.unsaved);
    console.log('CHECK END');
    window.roadcraftApp.testKey(${JSON.stringify(key)}, ${JSON.stringify(mods)});
    await wait(15000);
  `, `
    const r = await within(g.load(), 30000);
    check('the road built before the key is there', r === 'returned' && roadAt(1600, 1500), 'load() ' + r + ', road ' + roadAt(1600, 1500) + ', toasts: ' + toasts.join(' | '));
  `]])),
  // A city just opened has nothing unsaved (opening another one does not ask to discard anything)
  'opened-is-saved': `
    road(1500, 1500, 1700, 1500);
    check('the save completes', await g.save(false) === true, 'save() did not complete');
    await g.load();
    check('right after opening nothing is unsaved', g.unsaved === false && dirtyTiles().length === 0, 'unsaved=' + g.unsaved + ' tiles=' + dirtyTiles());
  `,
  // Alt+F4 (what Windows sends for it, from outside the game) closes through the close that saves
  'alt-f4': [`
    road(1500, 1500, 1700, 1500);
    check('there is something unsaved', g.unsaved === true, 'unsaved=' + g.unsaved);
    console.log('CHECK END');
    await wait(500);
    console.log('ALT-F4 NOW');
    await wait(30000);
    // still here: Alt+F4 did not close the window (the run would then close it itself, and that close saves too)
    check('Alt+F4 closes the window', false, 'the window was still open 30 s later');
  `, `
    const r = await within(g.load(), 30000);
    check('the road built before Alt+F4 is there', r === 'returned' && roadAt(1600, 1500), 'load() ' + r + ', road ' + roadAt(1600, 1500) + ', toasts: ' + toasts.join(' | '));
  `],
  // The desktop window's other shortcuts: DevTools only with ?dev, no page zoom on Ctrl +, F11 still toggles full screen
  'window-keys': `
    let r = await window.roadcraftApp.testKey('I', ['control', 'shift']);
    check('Ctrl+Shift+I does not open DevTools without ?dev', !r.devtools, JSON.stringify(r));
    const ratio = devicePixelRatio;
    r = await window.roadcraftApp.testKey('Plus', ['control']);
    check('Ctrl + does not zoom the page', devicePixelRatio === ratio, 'pixel ratio ' + ratio + ' → ' + devicePixelRatio + ' ' + JSON.stringify(r));
    r = await window.roadcraftApp.testKey('F11', []);
    check('F11 turns full screen on', r.fullscreen === true, JSON.stringify(r));
    r = await window.roadcraftApp.testKey('F11', []);
    check('F11 again turns it off', r.fullscreen === false, JSON.stringify(r));
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

// Node-side preparation of a scenario; returns what undoes it
const SETUP = {
  'app-path': () => {
    const dir = path.join(root, 'dist-probe');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'probe.txt'), 'outside dist');
    return () => fs.rmSync(dir, { recursive: true, force: true });
  },
};

// Node-side checks after a scenario's sessions, on the run's user data folder: ["OK name" | "FAILED name: why"]
const POST = {
  'desktop-files': (own) => {
    const file = path.join(own, 'saves', 'cidade-1', 'current.json');
    return [fs.existsSync(file) ? 'OK the save is a real file in the user data folder' : `FAILED the save is a real file in the user data folder: no ${file}`];
  },
};

// Scenarios of the browser build: Chrome (WebGPU) with a profile of its own, the game served from dist/ by
// tools/serve.mjs, driven through the DevTools protocol. Each step runs in one tab, in order.
const BROWSER = {
  // A37: one tab writes the save; a second tab of the same city does not write over it, and says so; once the first
  // tab closes, the second one can save
  'two-tabs': [
    { tab: 0, body: `
      road(1500, 1500, 1700, 1500);
      check('the first tab saves', await g.save(false) === true, 'save() did not complete');
      console.log('persisted storage: ' + await navigator.storage.persisted());
    ` },
    { tab: 1, body: `
      const before = await files.snapshot();
      road(-3000, -3000, -2800, -3000);
      const r = await g.save(false);
      const same = sameFiles(before, await files.snapshot());
      check('a second tab does not write the same save', r === false && same, 'save() ' + r + ', files ' + (same ? 'same' : 'changed'));
      check('it says why', toasts.some((m) => /outra aba|another tab/.test(m)), 'toasts: ' + toasts.join(' | '));
      // opening a map file writes the save too: refused the same way
      await g.importMap(await a.packMap());
      const same2 = sameFiles(before, await files.snapshot());
      check('a second tab does not open a map file over the save', same2, 'files changed');
    ` },
    { tab: 0, body: `
      road(1500, 1600, 1700, 1600);
      check('the first tab still saves', await g.save(false) === true, 'save() did not complete');
    ` },
    { close: 0 },
    { tab: 1, body: `
      await wait(2000);
      check('once the first tab closed, the second one saves', await g.save(false) === true, 'save() did not complete');
    ` },
  ],
};

function chromePath() {
  const local = process.env.LOCALAPPDATA ?? '', pf = process.env.PROGRAMFILES ?? 'C:\\Program Files', pf86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
  return [path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((c) => fs.existsSync(c));
}

/** Runs a browser scenario's steps; returns its checks ("OK …" / "FAILED …"). */
async function inChrome(steps) {
  const chrome = chromePath();
  if (!chrome) return ['FAILED Chrome is not installed'];
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'roadcraft-chrome-'));
  const port = 5300 + Math.floor(Math.random() * 300), debug = port + 1000;
  const server = spawn(process.execPath, [path.join(root, 'tools', 'serve.mjs')], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'ignore'] });
  const checks = [];
  let ch = null;
  try {
    const url = await new Promise((resolve, reject) => {
      server.stdout.on('data', (d) => { const m = /(http:\/\/localhost:\d+\/)/.exec(String(d)); if (m) resolve(m[1]); });
      setTimeout(() => reject(new Error('the server did not start')), 15000);
    });
    const page = `${url}?vazio&hora=11&workers=2`;
    ch = spawn(chrome, [`--user-data-dir=${profile}`, `--remote-debugging-port=${debug}`, '--no-first-run', '--no-default-browser-check',
      '--window-size=1280,720', '--window-position=-20000,-20000', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion', page], { stdio: 'ignore' });
    const targets = async () => (await (await fetch(`http://127.0.0.1:${debug}/json/list`)).json()).filter((t) => t.type === 'page' && t.url.startsWith(url));
    let first = null;
    for (let i = 0; i < 100 && !first; i++) { await new Promise((r) => setTimeout(r, 300)); try { first = (await targets())[0]; } catch { /* not up yet */ } }
    if (!first) throw new Error('no Chrome page');
    const second = await (await fetch(`http://127.0.0.1:${debug}/json/new?${encodeURIComponent(page)}`, { method: 'PUT' })).json();
    const tabs = [];
    for (const t of [first, second]) {
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((r) => ws.addEventListener('open', r, { once: true }));
      const tab = { id: t.id, ws, seq: 0, pending: new Map(), lines: [] };
      ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        if (m.id && tab.pending.has(m.id)) { tab.pending.get(m.id)(m); tab.pending.delete(m.id); }
        if (m.method === 'Runtime.consoleAPICalled') tab.lines.push(m.params.args.map((x) => x.value ?? x.description ?? '').join(' '));
      });
      tab.send = (method, params = {}) => new Promise((r) => { const id = ++tab.seq; tab.pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
      tab.eval = async (expression) => (await tab.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
      await tab.send('Runtime.enable');
      tabs.push(tab);
    }
    for (const tab of tabs) {
      const t0 = Date.now();
      while (Date.now() - t0 < 240000 && await tab.eval('window.__cidade?.status ?? "carregando"') !== 'pronto') await new Promise((r) => setTimeout(r, 500));
    }
    for (const step of steps) {
      if (step.close !== undefined) { await fetch(`http://127.0.0.1:${debug}/json/close/${tabs[step.close].id}`); continue; }
      const tab = tabs[step.tab];
      tab.lines = [];
      void tab.eval(`(async()=>{${PRELUDE}\ntry {${step.body}\n} catch (e) { check('step ran to the end', false, e && e.stack || e); }\nconsole.log('CHECK END');})()`);
      const t0 = Date.now();
      while (Date.now() - t0 < 240000 && !tab.lines.some((l) => l.includes('CHECK END'))) await new Promise((r) => setTimeout(r, 300));
      for (const l of tab.lines) if (l.startsWith('persisted storage')) console.log(`  (${l})`);
      const got = tab.lines.filter((l) => l.includes('CHECK ')).map((l) => l.slice(l.indexOf('CHECK ') + 6));
      if (!got.includes('END')) got.push(`FAILED tab ${step.tab} did not finish its step after: ` + (got[got.length - 1] ?? 'nothing'));
      checks.push(...got.filter((c) => c !== 'END'));
    }
    await tabs[1].send('Browser.close').catch(() => {});
  } catch (err) {
    checks.push(`FAILED the browser run: ${err.message}`);
  } finally {
    try { ch?.kill(); } catch { /* gone */ }
    server.kill();
    await new Promise((r) => setTimeout(r, 1500));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  }
  return checks;
}

/** Alt+F4 on the game window started by the shot.mjs of process `parent`: Windows turns the key into WM_SYSCOMMAND SC_CLOSE. */
function altF4(parent) {
  const ps = `
$c = Get-CimInstance Win32_Process -Filter "ParentProcessId=${parent} AND Name='electron.exe'" | Select-Object -First 1
$h = (Get-Process -Id $c.ProcessId).MainWindowHandle
Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);'
"posted " + [W.U]::PostMessage($h, 0x0112, [System.IntPtr]0xF060, [System.IntPtr]0) + " to " + $h`;
  const r = spawn('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: ['ignore', 'pipe', 'pipe'] });
  r.stdout.on('data', (d) => console.log(`  (alt+f4: ${String(d).trim()})`));
  r.stderr.on('data', (d) => console.log(`  (alt+f4 error: ${String(d).trim()})`));
}

const pick = process.argv.slice(2);
const names = pick.length ? pick : [...Object.keys(SCENARIOS), ...Object.keys(BROWSER)];
let failed = 0;
for (const name of names) {
  if (BROWSER[name]) {
    const checks = await inChrome(BROWSER[name]);
    const bad = checks.filter((c) => c.startsWith('FAILED'));
    failed += bad.length;
    console.log(`${name} (browser): ${checks.filter((c) => c.startsWith('OK')).length} ok, ${bad.length} failed`);
    for (const c of bad) console.log('  ' + c);
    continue;
  }
  const bodies = SCENARIOS[name];
  if (!bodies) { console.log(`unknown scenario ${name}`); failed++; continue; }
  // a scenario is one session, or several sessions one after the other over the same folder (closing and reopening)
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'roadcraft-save-'));
  const undo = SETUP[name]?.();
  const checks = [];
  for (const body of Array.isArray(bodies) ? bodies : [bodies]) {
    const script = `(async()=>{${PRELUDE}\ntry {${body}\n} catch (e) { check('scenario ran to the end', false, e && e.stack || e); }\nconsole.log('CHECK END');})()`;
    const lines = await new Promise((resolve) => {
      const out = [];
      const p = spawn(process.execPath, [path.join(root, 'tools', 'shot.mjs'), path.join(own, 'shot.png'), '?vazio&hora=11&workers=3', script],
        { cwd: root, env: { ...process.env, CIDADE_USER_DATA: own, CIDADE_SETTLE: '1', CIDADE_LIMIT: '420', CIDADE_CLOSE_SAVES: '1' } });
      p.stdout.on('data', (d) => {
        const got = String(d).split('\n');
        out.push(...got);
        // a session asking for Alt+F4: the window gets what Windows sends for it (WM_SYSCOMMAND SC_CLOSE)
        if (got.some((l) => l.includes('ALT-F4 NOW'))) altF4(p.pid);
      });
      p.on('exit', () => resolve(out));
    });
    const got = lines.filter((l) => l.includes('CHECK ')).map((l) => l.slice(l.indexOf('CHECK ') + 6));
    if (!got.includes('END')) got.push('FAILED the session did not finish (hung or crashed) after: ' + (got[got.length - 1] ?? 'nothing'));
    checks.push(...got.filter((c) => c !== 'END'));
  }
  checks.push(...(POST[name]?.(own) ?? []));
  const bad = checks.filter((c) => c.startsWith('FAILED'));
  failed += bad.length;
  console.log(`${name}: ${checks.filter((c) => c.startsWith('OK')).length} ok, ${bad.length} failed`);
  for (const c of bad) console.log('  ' + c);
  fs.rmSync(own, { recursive: true, force: true, maxRetries: 3 });
  undo?.();
}
console.log(failed ? `save check: ${failed} FAILED` : 'save check: ok');
process.exit(failed ? 1 : 0);

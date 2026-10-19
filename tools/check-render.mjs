// Drawing checked in the real game (the machine's GPU), one scenario per Electron session with a user data folder of
// its own (never the game's). Each scenario sets up what it needs, draws, reads back what the GPU did and checks it.
// Usage: npx vite build && node tools/check-render.mjs [scenario...]   (exits with code 1 if anything fails)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Page helpers shared by every scenario: results are printed as "CHECK OK|FAILED name" and the run ends with "CHECK END".
const PRELUDE = `
const g = window.__cidade.game, w = g.world, P = g.props, renderer = g.parts.renderer;
// the 10 km map (?mapa=10): 40 cells of 256 m a side, centred on (0, 0)
const MAP_HALF = 5120, CELL = 256, MAP_CELLS = 40;
// a draw of the props: kind × 3 levels (the tree is kind 0 before and after the variants got kinds of their own)
const slotOf = (kind, level) => kind * 3 + level;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const frames = (n) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
const check = (name, ok, why) => console.log('CHECK ' + (ok ? 'OK ' : 'FAILED ') + name + (ok ? '' : ': ' + why));
/** Props put straight into the pool, cell by cell (as if the workers had built them). */
const putProps = (list) => {
  const byCell = new Map();
  for (const p of list) {
    const cx = Math.floor((p.x + MAP_HALF) / CELL), cz = Math.floor((p.z + MAP_HALF) / CELL), c = cz * MAP_CELLS + cx;
    if (!byCell.has(c)) byCell.set(c, []);
    byCell.get(c).push(p);
  }
  for (const [c, ps] of byCell) {
    const data = new Float32Array(ps.length * 4), extra = new Uint32Array(ps.length);
    ps.forEach((p, i) => { data.set([p.x, p.y, p.z, (p.yaw | 0) | ((p.variant | 0) << 12) | ((p.scale ?? 21) << 16)], i * 4); extra[i] = p.type | ((p.key | 0) << 5); });
    P.setCell(c, { count: ps.length, data, extra }, P.cellVer[c]);
  }
};
/** The indirect draw arguments as the GPU left them (instance count of each draw). */
const drawCounts = async () => new Uint32Array(await renderer.getArrayBufferAsync(P.drawAttr));
`;

const SCENARIOS = {
  // E24: more than 131,072 trees of one kind in view are all drawn (no per-kind cut that changes every frame)
  'many-trees': `
    await g.view(0, 0, 0, 80, 1500, 11);
    await frames(10);
    const trees = [];
    let s = 1; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 250000; i++) trees.push({ x: (rnd() - 0.5) * 900, z: (rnd() - 0.5) * 900, y: 0, yaw: rnd() * 4095, type: 0, variant: 0 });
    putProps(trees);
    await frames(5);
    const d = await drawCounts();
    const slot = slotOf(0, 2);
    const shown = d[slot * 5 + 1];
    check('250,000 trees in view are all in the impostor draw', shown >= 240000, 'the impostor draw holds ' + shown);
    await frames(3);
    const again = (await drawCounts())[slot * 5 + 1];
    check('the same trees are drawn the next frames', again === shown, 'frame after: ' + again + ', before: ' + shown);
  `,
  // E28: equipment on top of a 60-floor tower is drawn when the camera is high above it
  'rooftop-props': `
    await g.view(0, 0, 0, 80, 330, 11);
    await frames(10);
    const ground = w.tileMax[Math.floor(10 / 2) * 10 + 5];
    // condensers (furniture variant 9) on a roof 200 m up, under the camera
    const roof = [];
    for (let i = 0; i < 20; i++) roof.push({ x: (i % 5) * 3, z: Math.floor(i / 5) * 3, y: ground + 200, type: 11, variant: 9 });
    putProps(roof);
    await frames(8);
    const kind = P.kindOf[11 * 16 + 9], mesh = P.slotMesh[kind * 3];
    const eye = g.rig.eye.y - ground;
    check('rooftop condensers 200 m up are drawn with the eye ' + Math.round(eye) + ' m up', mesh && mesh.visible, 'their draw is switched off');
    const d = await drawCounts();
    check('the cull pass keeps them', d[(kind * 3) * 5 + 1] >= 20, 'count ' + d[(kind * 3) * 5 + 1]);
  `,
  // E14: a tree just outside the edge of the view, on the low sun's side, still casts its shadow into it
  'offscreen-shadow': `
    await g.view(0, 0, 0, 25, 120, 7);
    await frames(10);
    const sun = g.parts.sun.position.clone().normalize();
    const r = P.kinds[0].radius; // a tree at scale 1
    const side = (x, z, y) => Math.min(...P.planes.map((pl) => pl.x * x + pl.y * y + pl.z * z + pl.w));
    let spot = null;
    for (const edge of [-0.95, 0.95]) {
      const q = g.rig.pick(edge, -0.2);
      if (!q) continue;
      const h = Math.hypot(sun.x, sun.z);
      for (let k = 0; k < 80 && !spot; k++) {
        const x = q.x + sun.x / h * k, z = q.z + sun.z / h * k;
        if (side(x, z, q.y) < -(r + 3) && side(q.x, q.z, q.y) > -1) spot = { x, z, y: q.y, k };
      }
      if (spot) break;
    }
    check('found a spot just outside the view on the side of the sun', !!spot, 'no edge goes outward toward the sun');
    if (spot) {
      const slot = slotOf(0, 0);
      // the cell's own props are replaced: compare with the same cell holding the tree 5 km under the ground
      putProps([{ x: spot.x, z: spot.z, y: spot.y - 5000, type: 0, variant: 0 }]);
      await frames(5);
      const before = (await drawCounts())[slot * 5 + 1];
      putProps([{ x: spot.x, z: spot.z, y: spot.y, type: 0, variant: 0 }]);
      await frames(5);
      const after = (await drawCounts())[slot * 5 + 1];
      check('the tree ' + spot.k + ' m outside the view (shadow ' + Math.round(15 / Math.tan(Math.asin(sun.y))) + ' m long) is drawn for the shadow maps', after > before, 'near trees ' + before + ' -> ' + after);
    }
  `,
  // E19: paused, without wind and with the camera still, the shadow cascades are not redrawn every frame
  'still-shadows': `
    await g.view(0, 0, 35, 40, 300, 11);
    await g.settle(10);
    g.weather.windFixed = 0;
    await frames(60);
    const running = g.stats().draws;
    if (!g.paused) g.togglePause();
    await frames(30);
    const still = [];
    for (let i = 0; i < 5; i++) { await frames(1); still.push(g.stats().draws); }
    check('paused and still, a frame draws less than running (' + running + ' draws running, still ' + still.join('/') + ')', Math.max(...still) < running * 0.8, 'still frames: ' + still.join(', '));
    g.rig.yaw += 0.2;
    await frames(2);
    check('turning the camera redraws the cascades', g.stats().draws > Math.max(...still), 'after turning: ' + g.stats().draws);
  `,
  // E20: paused with nothing moving, and minimized, the game stops drawing; input or showing it again draws at once
  'idle-frames': `
    await g.view(0, 0, 35, 40, 300, 11);
    await g.settle(10);
    g.weather.windFixed = 0;
    if (!g.paused) g.togglePause();
    let drawn = 0;
    const draw = g.post.render.bind(g.post);
    g.post.render = (...a) => { drawn++; return draw(...a); };
    await frames(120);
    drawn = 0;
    await frames(60);
    check('paused and idle, nothing is drawn (' + drawn + ' of 60 frames)', drawn === 0, drawn + ' of 60 frames drawn');
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, clientY: 300 }));
    drawn = 0;
    await frames(5);
    check('moving the mouse draws again', drawn > 0, 'nothing drawn after the input');
    if (!g.paused) g.togglePause();
    g.togglePause();
    await frames(10);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    drawn = 0;
    await frames(30);
    check('minimized while running, nothing is drawn (' + drawn + ' of 30 frames)', drawn === 0, drawn + ' of 30 frames drawn');
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
    drawn = 0;
    await frames(5);
    check('shown again, it draws', drawn > 0, 'nothing drawn');
  `,
  // E29: with no wind the trees and the grass stand still (two captures 1 s apart, camera and clock still)
  'still-trees': {
    body: `
      g.weather.windFixed = 0;
      // clear sky: the clouds' shadows drift with the wind and would move the image
      g.weather.fixed = { clouds: 0, rain: 0 };
      await g.view(2500, -2500, 35, 12, 40, 11);
      await frames(10);
      const y = w.tileMax[0] ? 0 : 0;
      const q = g.rig.target;
      const trees = [];
      for (let i = 0; i < 9; i++) trees.push({ x: q.x - 8 + (i % 3) * 8, z: q.z - 8 + Math.floor(i / 3) * 8, y: q.y, type: 0, variant: i % 3, scale: 42 });
      putProps(trees);
      await frames(30);
    `,
    env: { CIDADE_DIFF: '1000', CIDADE_SETTLE: '3' },
    diff: (pct) => [pct < 0.5, 'with no wind, under 0.5% of the pixels change in 1 s (' + pct + '%)', pct + '% of the pixels changed'],
  },
  // E29: and with wind they do move
  'windy-trees': {
    body: `
      g.weather.windFixed = 0.8;
      await g.view(2500, -2500, 35, 12, 40, 11);
      await frames(10);
      const q = g.rig.target;
      const trees = [];
      for (let i = 0; i < 9; i++) trees.push({ x: q.x - 8 + (i % 3) * 8, z: q.z - 8 + Math.floor(i / 3) * 8, y: q.y, type: 0, variant: i % 3, scale: 42 });
      putProps(trees);
      await frames(30);
    `,
    env: { CIDADE_DIFF: '1000', CIDADE_SETTLE: '3' },
    diff: (pct) => [pct > 3, 'with a strong wind the trees and the grass move (' + pct + '% of the pixels in 1 s)', 'only ' + pct + '% of the pixels changed'],
  },
  // E30: a far forest, camera still and no wind: the trees' photos do not shimmer (two captures 1 s apart)
  'far-forest': {
    body: `
      g.weather.windFixed = 0;
      // clear sky: the clouds' shadows drift with the wind and would move the image
      g.weather.fixed = { clouds: 0, rain: 0 };
      // only far trees in view (the nearest ground in the picture is ~600 m away: the trees' photos)
      await g.view(2500, -2500, 35, 8, 2500, 11);
      await g.settle(10);
      await frames(30);
    `,
    env: { CIDADE_DIFF: '1000', CIDADE_SETTLE: '3' },
    // measured with only far trees in view: 0.99-1.65% without the photos' mipmaps, 0.62-0.78% with them
    diff: (pct) => [pct < 0.9, 'a far forest seen still changes under 0.9% of the pixels in 1 s (' + pct + '%)', pct + '% of the pixels changed'],
  },
};

const pick = process.argv.slice(2);
const names = pick.length ? pick : Object.keys(SCENARIOS);
let failed = 0;
for (const name of names) {
  const sc = SCENARIOS[name];
  if (!sc) { console.log(`unknown scenario ${name}`); failed++; continue; }
  const body = typeof sc === 'string' ? sc : sc.body;
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'roadcraft-render-'));
  const script = `(async()=>{${PRELUDE}\ntry {${body}\n} catch (e) { check('scenario ran to the end', false, e && e.stack || e); }\nconsole.log('CHECK END');})()`;
  const lines = await new Promise((resolve) => {
    const out = [];
    const p = spawn(process.execPath, [path.join(root, 'tools', 'shot.mjs'), path.join(own, 'shot.png'), '?vazio&mapa=10&hora=11&limpo', script],
      { cwd: root, env: { ...process.env, CIDADE_USER_DATA: own, CIDADE_SETTLE: '1', CIDADE_LIMIT: '300', ...(sc.env ?? {}) } });
    p.stdout.on('data', (d) => out.push(...String(d).split('\n')));
    p.on('exit', () => resolve(out));
  });
  const got = lines.filter((l) => l.includes('CHECK ')).map((l) => l.slice(l.indexOf('CHECK ') + 6));
  // scenarios that measure what changes between two captures (shot.mjs with CIDADE_DIFF)
  if (sc.diff) {
    const d = lines.map((l) => /diff: ([0-9.]+)% of pixels changed/.exec(l)).find(Boolean);
    const [ok, okName, why] = d ? sc.diff(Number(d[1])) : [false, 'two captures compared', 'no diff line'];
    got.splice(got.indexOf('END') < 0 ? got.length : got.indexOf('END'), 0, (ok ? 'OK ' : 'FAILED ') + okName + (ok ? '' : ': ' + why));
  }
  if (!got.includes('END')) got.push('FAILED the session did not finish (hung or crashed) after: ' + (got[got.length - 1] ?? 'nothing'));
  const checks = got.filter((c) => c !== 'END');
  const bad = checks.filter((c) => c.startsWith('FAILED'));
  failed += bad.length;
  console.log(`${name}: ${checks.filter((c) => c.startsWith('OK')).length} ok, ${bad.length} failed`);
  for (const c of checks) console.log('  ' + c);
  // CHECK_KEEP=folder: keep each scenario's captures (shot and difference map) there
  if (process.env.CHECK_KEEP) for (const f of fs.readdirSync(own).filter((f) => f.endsWith('.png'))) { fs.mkdirSync(process.env.CHECK_KEEP, { recursive: true }); fs.copyFileSync(path.join(own, f), path.join(process.env.CHECK_KEEP, `${name}-${f}`)); }
  fs.rmSync(own, { recursive: true, force: true, maxRetries: 3 });
}
console.log(failed ? `render check: ${failed} FAILED` : 'render check: ok');
process.exit(failed ? 1 : 0);

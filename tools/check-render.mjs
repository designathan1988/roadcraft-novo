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
};

const pick = process.argv.slice(2);
const names = pick.length ? pick : Object.keys(SCENARIOS);
let failed = 0;
for (const name of names) {
  const body = SCENARIOS[name];
  if (!body) { console.log(`unknown scenario ${name}`); failed++; continue; }
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'roadcraft-render-'));
  const script = `(async()=>{${PRELUDE}\ntry {${body}\n} catch (e) { check('scenario ran to the end', false, e && e.stack || e); }\nconsole.log('CHECK END');})()`;
  const lines = await new Promise((resolve) => {
    const out = [];
    const p = spawn(process.execPath, [path.join(root, 'tools', 'shot.mjs'), path.join(own, 'shot.png'), '?vazio&mapa=10&hora=11&limpo', script],
      { cwd: root, env: { ...process.env, CIDADE_USER_DATA: own, CIDADE_SETTLE: '1', CIDADE_LIMIT: '300' } });
    p.stdout.on('data', (d) => out.push(...String(d).split('\n')));
    p.on('exit', () => resolve(out));
  });
  const got = lines.filter((l) => l.includes('CHECK ')).map((l) => l.slice(l.indexOf('CHECK ') + 6));
  if (!got.includes('END')) got.push('FAILED the session did not finish (hung or crashed) after: ' + (got[got.length - 1] ?? 'nothing'));
  const checks = got.filter((c) => c !== 'END');
  const bad = checks.filter((c) => c.startsWith('FAILED'));
  failed += bad.length;
  console.log(`${name}: ${checks.filter((c) => c.startsWith('OK')).length} ok, ${bad.length} failed`);
  for (const c of bad) console.log('  ' + c);
  fs.rmSync(own, { recursive: true, force: true, maxRetries: 3 });
}
console.log(failed ? `render check: ${failed} FAILED` : 'render check: ok');
process.exit(failed ? 1 : 0);

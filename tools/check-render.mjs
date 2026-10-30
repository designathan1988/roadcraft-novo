// Drawing checked in the real game (the machine's GPU), one scenario per Electron session with a user data folder of
// its own (never the game's). Each scenario sets up what it needs, draws, reads back what the GPU did and checks it.
// Usage: npx vite build && node tools/check-render.mjs [scenario...]   (exits with code 1 if anything fails)
import { checksOf, pick, report, scenarioFolder, session, wrap } from './checks/run.mjs';

// Page helpers shared by every scenario: results are printed as "CHECK OK|FAILED name" and the run ends with "CHECK END".
const PRELUDE = `
const R = window.__roadcraft, w = R.world, P = R.render.props();
// the 10 km map (?map=10): 40 cells of 256 m a side, centred on (0, 0)
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
    P.putCell(c, { count: ps.length, data, extra });
  }
};
/** The indirect draw arguments as the GPU left them (instance count of each draw). */
const drawCounts = () => P.drawCounts();
`;

const SCENARIOS = {
  // E24: more than 131,072 trees of one kind in view are all drawn (no per-kind cut that changes every frame)
  'many-trees': `
    await R.camera.view(0, 0, 0, 80, 1500, 11);
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
    await R.camera.view(0, 0, 0, 80, 330, 11);
    await frames(10);
    const ground = w.tileMax[Math.floor(10 / 2) * 10 + 5];
    // condensers (furniture variant 9) on a roof 200 m up, under the camera
    const roof = [];
    for (let i = 0; i < 20; i++) roof.push({ x: (i % 5) * 3, z: Math.floor(i / 5) * 3, y: ground + 200, type: 11, variant: 9 });
    putProps(roof);
    await frames(8);
    const kind = P.kindOf(11, 9);
    const eye = R.camera.pose().eye.y - ground;
    check('rooftop condensers 200 m up are drawn with the eye ' + Math.round(eye) + ' m up', P.levelShown(kind, 0), 'their draw is switched off');
    const d = await drawCounts();
    check('the cull pass keeps them', d[(kind * 3) * 5 + 1] >= 20, 'count ' + d[(kind * 3) * 5 + 1]);
  `,
  // E14: a tree just outside the edge of the view, on the low sun's side, still casts its shadow into it
  'offscreen-shadow': `
    await R.camera.view(0, 0, 0, 25, 120, 7);
    await frames(10);
    const sun = R.render.sun();
    const r = P.kindRadius(0); // a tree at scale 1
    const side = (x, z, y) => Math.min(...P.planes().map((pl) => pl.x * x + pl.y * y + pl.z * z + pl.w));
    let spot = null;
    for (const edge of [-0.95, 0.95]) {
      const q = R.camera.pick(edge, -0.2);
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
    await R.camera.view(0, 0, 35, 40, 300, 11);
    await R.frames.settle(10);
    R.ui.weather({ rain: 0, wind: 0, dir: 65, lightning: 0, thunder: 1 });
    await frames(60);
    const running = R.frames.stats().draws;
    if (!R.sim.paused()) R.sim.togglePause();
    await frames(30);
    const still = [];
    for (let i = 0; i < 5; i++) { await frames(1); still.push(R.frames.stats().draws); }
    check('paused and still, a frame draws less than running (' + running + ' draws running, still ' + still.join('/') + ')', Math.max(...still) < running * 0.8, 'still frames: ' + still.join(', '));
    R.camera.place({ yaw: R.camera.pose().yaw + 0.2 });
    await frames(2);
    check('turning the camera redraws the cascades', R.frames.stats().draws > Math.max(...still), 'after turning: ' + R.frames.stats().draws);
  `,
  // E20: paused with nothing moving, and minimized, the game stops drawing; input or showing it again draws at once
  'idle-frames': `
    await R.camera.view(0, 0, 35, 40, 300, 11);
    await R.frames.settle(10);
    R.ui.weather({ rain: 0, wind: 0, dir: 65, lightning: 0, thunder: 1 });
    if (!R.sim.paused()) R.sim.togglePause();
    // frames that drew, as the game counts them (a still or hidden frame stops before drawing)
    let base = R.frames.drawn();
    const drawnSince = () => R.frames.drawn() - base;
    await frames(120);
    base = R.frames.drawn();
    await frames(60);
    check('paused and idle, nothing is drawn (' + drawnSince() + ' of 60 frames)', drawnSince() === 0, drawnSince() + ' of 60 frames drawn');
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, clientY: 300 }));
    base = R.frames.drawn();
    await frames(5);
    check('moving the mouse draws again', drawnSince() > 0, 'nothing drawn after the input');
    if (!R.sim.paused()) R.sim.togglePause();
    R.sim.togglePause();
    await frames(10);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    base = R.frames.drawn();
    await frames(30);
    check('minimized while running, nothing is drawn (' + drawnSince() + ' of 30 frames)', drawnSince() === 0, drawnSince() + ' of 30 frames drawn');
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
    base = R.frames.drawn();
    await frames(5);
    check('shown again, it draws', drawnSince() > 0, 'nothing drawn');
  `,
  // E29: with no wind the trees and the grass stand still (two captures 1 s apart, camera and clock still)
  'still-trees': {
    body: `
      // no wind, no rain, set as the player sets it (Weather drawer): nothing should move the image
      R.ui.weather({ rain: 0, wind: 0, dir: 65, lightning: 0, thunder: 1 });
      await R.camera.view(2500, -2500, 35, 12, 40, 11);
      await frames(10);
      const y = w.tileMax[0] ? 0 : 0;
      const q = R.camera.pose();
      const trees = [];
      for (let i = 0; i < 9; i++) trees.push({ x: q.x - 8 + (i % 3) * 8, z: q.z - 8 + Math.floor(i / 3) * 8, y: q.y, type: 0, variant: i % 3, scale: 42 });
      putProps(trees);
      await frames(30);
    `,
    env: { ROADCRAFT_DIFF: '1000', ROADCRAFT_SETTLE: '3' },
    diff: (pct) => [pct < 0.5, 'with no wind, under 0.5% of the pixels change in 1 s (' + pct + '%)', pct + '% of the pixels changed'],
  },
  // E29: and with wind they do move
  'windy-trees': {
    body: `
      R.ui.weather({ rain: 0, wind: 16, dir: 65, lightning: 0, thunder: 1 });
      await R.camera.view(2500, -2500, 35, 12, 40, 11);
      await frames(10);
      const q = R.camera.pose();
      const trees = [];
      for (let i = 0; i < 9; i++) trees.push({ x: q.x - 8 + (i % 3) * 8, z: q.z - 8 + Math.floor(i / 3) * 8, y: q.y, type: 0, variant: i % 3, scale: 42 });
      putProps(trees);
      await frames(30);
    `,
    env: { ROADCRAFT_DIFF: '1000', ROADCRAFT_SETTLE: '3' },
    diff: (pct) => [pct > 3, 'with a strong wind the trees and the grass move (' + pct + '% of the pixels in 1 s)', 'only ' + pct + '% of the pixels changed'],
  },
  // E30: a far forest, camera still and no wind: the trees' photos do not shimmer (two captures 1 s apart)
  'far-forest': {
    body: `
      // no wind, no rain, set as the player sets it (Weather drawer): nothing should move the image
      R.ui.weather({ rain: 0, wind: 0, dir: 65, lightning: 0, thunder: 1 });
      // only far trees in view (the nearest ground in the picture is ~600 m away: the trees' photos)
      await R.camera.view(2500, -2500, 35, 8, 2500, 11);
      await R.frames.settle(10);
      await frames(30);
    `,
    env: { ROADCRAFT_DIFF: '1000', ROADCRAFT_SETTLE: '3' },
    // measured with only far trees in view: 0.99-1.65% without the photos' mipmaps, 0.62-0.78% with them
    diff: (pct) => [pct < 0.9, 'a far forest seen still changes under 0.9% of the pixels in 1 s (' + pct + '%)', pct + '% of the pixels changed'],
  },
};

const { names, unknown } = pick(SCENARIOS);
let failed = unknown;
for (const name of names) {
  const sc = SCENARIOS[name];
  const body = typeof sc === 'string' ? sc : sc.body;
  const own = scenarioFolder('roadcraft-render-', name);
  const lines = await session({ query: '?empty&map=10&hour=11&clear', script: wrap(PRELUDE, body), own: own.dir, env: sc.env ?? {} });
  const checks = checksOf(lines);
  // scenarios that measure what changes between two captures (shot.mjs with ROADCRAFT_DIFF)
  if (sc.diff) {
    const d = lines.map((l) => /diff: ([0-9.]+)% of pixels changed/.exec(l)).find(Boolean);
    const [ok, okName, why] = d ? sc.diff(Number(d[1])) : [false, 'two captures compared', 'no diff line'];
    checks.push((ok ? 'OK ' : 'FAILED ') + okName + (ok ? '' : ': ' + why));
  }
  failed += report(name, checks);
  own.done();
}
console.log(failed ? `render check: ${failed} FAILED` : 'render check: ok');
process.exit(failed ? 1 : 0);

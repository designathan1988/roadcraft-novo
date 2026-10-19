// The traffic and pedestrian simulation checked in the real game (the machine's GPU), one scenario per Electron session
// with a user data folder of its own (never the game's). Prints "CHECK OK|FAILED name" lines and leaves each
// scenario's photo in the output folder.
// Usage: npx vite build && node tools/check-sim.mjs [output-folder] [scenario...]   (exits with code 1 if anything fails)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
// a first argument with a slash is the output folder; the rest are scenario names
const out = path.resolve(args[0] && /[\\/]/.test(args[0]) ? args.shift() : path.join(root, 'test-results', 'sim'));
fs.mkdirSync(out, { recursive: true });

const PRELUDE = `
const g = window.__cidade.game, a = g.api, w = g.world;
const errors = [];
const logError = console.error.bind(console);
console.error = (...x) => { errors.push(x.map(String).join(' ').slice(0, 300)); logError(...x); };
window.addEventListener('error', (e) => errors.push('error: ' + (e.message || e.error)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, why) => console.log('CHECK ' + (ok ? 'OK ' : 'FAILED ') + name + (ok ? '' : ': ' + why));
const stats = () => g.simStats && g.simStats.type === 'stats' ? g.simStats : null;
w.unlimited = true;
`;

const SCENARIOS = {
  // the generated 10 km city: traffic and people everywhere, figures for the whole city, a busy junction photographed
  'city-traffic': {
    query: '?cidade&mapa=10&limpo&hora=8',
    body: `
      await wait(45000);
      const s1 = stats();
      check('the city has traffic', s1 && s1.cars > 2000, 'cars ' + (s1 && s1.cars));
      check('the city has pedestrians', s1 && s1.peds > 2000, 'pedestrians ' + (s1 && s1.peds));
      check('the city speed is a speed (whole city, not the camera)', s1 && s1.speed > 1 && s1.speed < 25, 'speed ' + (s1 && s1.speed));
      await wait(20000);
      const s2 = stats();
      check('trips end', s2 && s2.arrived > s1.arrived, 'arrived ' + s1.arrived + ' -> ' + (s2 && s2.arrived));
      check('few trips are lost', s2 && (s2.lost - s1.lost) <= Math.max(10, (s2.arrived - s1.arrived) * 0.05), 'lost ' + s1.lost + ' -> ' + (s2 && s2.lost) + ' while ' + (s2.arrived - s1.arrived) + ' arrived');
      // a four-way junction with a light near the middle of the city, seen from a street corner
      const nc = w.roads.nodes.cols;
      let best = -1, bd = 1e9;
      for (let n = 0; n < w.roads.nodes.end; n++) {
        if (!w.roads.nodes.alive[n] || nc.deg[n] !== 4) continue;
        const d = Math.hypot(nc.x[n] - 600, nc.z[n] - 600);
        if (d < bd) { bd = d; best = n; }
      }
      check('a junction to look at', best >= 0, 'none');
      if (best >= 0) await g.view(nc.x[best], nc.z[best], 35, 30, 110, 8);
      await wait(8000);
      const s3 = stats();
      console.log('CHECK INFO cars ' + s3.cars + ' micro ' + s3.micro + ' peds ' + s3.peds + ' speed ' + (s3.speed * 3.6).toFixed(1) + ' km/h stopped ' + s3.stopped + ' arrived ' + s3.arrived + ' lost ' + s3.lost);
      check('nothing reached the console as an error', errors.length === 0, errors.slice(0, 3).join(' | '));
    `,
  },
  // C14: a network change the simulation cannot apply makes the page send the whole network; traffic goes on
  'resync': {
    query: '?vazio&hora=11&workers=3&cam=1500,1500,0,50,600',
    body: `
      const road = (ax, az, bx, bz) => { const r = a.road(ax, az, bx, bz); if (r !== 'ok') throw new Error('road refused: ' + r); };
      for (let i = 0; i < 4; i++) { road(1200, 1200 + i * 150, 1800, 1200 + i * 150); road(1200 + i * 150, 1200, 1200 + i * 150, 1800); }
      await wait(20000);
      const before = stats();
      check('traffic on the new streets', before && before.cars > 20, 'cars ' + (before && before.cars));
      // a node that still has segments: removing it throws inside the simulation's copy of the network
      let n = -1;
      for (let i = 0; i < w.roads.nodes.end && n < 0; i++) if (w.roads.nodes.alive[i] && w.roads.nodes.cols.deg[i] >= 3) n = i;
      const ops = new Float64Array(8); ops[0] = 2; ops[1] = n;
      g.sim.postMessage({ type: 'ops', ops, extra: [] });
      await wait(15000);
      const after = stats();
      check('the failure was reported', errors.some((e) => e.includes('node still connected')), errors.slice(0, 3).join(' | '));
      check('the page sent the whole network again', errors.some((e) => e.includes('rede reenviada')), errors.slice(0, 3).join(' | '));
      check('traffic goes on after it', after && after.cars > 20 && after.arrived >= 0, 'cars ' + (after && after.cars));
      const known = errors.filter((e) => !e.includes('node still connected') && !e.includes('rede reenviada') && !e.includes('network change'));
      check('no other error', known.length === 0, known.slice(0, 3).join(' | '));
    `,
  },
};

const names = args.length ? args : Object.keys(SCENARIOS);
let failed = 0;
for (const name of names) {
  const sc = SCENARIOS[name];
  if (!sc) { console.log(`unknown scenario ${name}`); failed++; continue; }
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'roadcraft-sim-'));
  const script = `(async()=>{${PRELUDE}\ntry {${sc.body}\n} catch (e) { check('scenario ran to the end', false, e && e.stack || e); }\nconsole.log('CHECK END');})()`;
  const lines = await new Promise((resolve) => {
    const got = [];
    const p = spawn(process.execPath, [path.join(root, 'tools', 'shot.mjs'), path.join(out, `${name}.png`), sc.query, script],
      { cwd: root, env: { ...process.env, CIDADE_USER_DATA: own, CIDADE_SETTLE: '1', CIDADE_LIMIT: '600' } });
    p.stdout.on('data', (d) => got.push(...String(d).split('\n')));
    p.on('exit', () => resolve(got));
  });
  const checks = lines.filter((l) => l.includes('CHECK ')).map((l) => l.slice(l.indexOf('CHECK ') + 6));
  if (!checks.includes('END')) checks.push('FAILED the session did not finish (hung or crashed) after: ' + (checks[checks.length - 1] ?? 'nothing'));
  const bad = checks.filter((c) => c.startsWith('FAILED'));
  failed += bad.length;
  console.log(`${name}: ${checks.filter((c) => c.startsWith('OK')).length} ok, ${bad.length} failed (photo ${path.join(out, name + '.png')})`);
  for (const c of checks.filter((c) => c.startsWith('INFO') || c.startsWith('FAILED'))) console.log('  ' + c);
  fs.rmSync(own, { recursive: true, force: true, maxRetries: 3 });
}
console.log(failed ? `sim check: ${failed} FAILED` : 'sim check: ok');
process.exit(failed ? 1 : 0);

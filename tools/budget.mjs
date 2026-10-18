// Frame budget by counting, not timing: draw calls, triangles and GPU MB per fixed view of the generated 10 km
// city, compared with tools/budget.json. Fails (exit 1) when a view exceeds its limit.
// Use: node tools/budget.mjs            -> check against tools/budget.json
//      node tools/budget.mjs --baseline -> rewrite tools/budget.json from the current counts (only on main, after
//                                          a reviewed merge; the limits are derived from the baseline below)
// Runs over dist/ (npm run build first) through tools/shot.mjs (Electron on the real GPU). Photos go to
// test-results/budget/.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const budgetFile = path.join(root, 'tools', 'budget.json');
const out = path.join(root, 'test-results', 'budget');
fs.mkdirSync(out, { recursive: true });
const baseline = process.argv.includes('--baseline');

// The same views as tools/fotos.mjs plus the whole map. yaw/pitch in degrees, dist in metres, hour of day.
const VIEWS = [
  { name: 'street', yaw: 35, pitch: 18, dist: 90, hour: 11 },
  { name: 'district', yaw: 35, pitch: 50, dist: 420, hour: 11 },
  { name: 'city', yaw: 35, pitch: 45, dist: 2200, hour: 11 },
  { name: 'map', yaw: 0, pitch: 75, dist: 11000, hour: 11 },
  { name: 'night', yaw: 35, pitch: 18, dist: 90, hour: 21 },
];

// Limits relative to the baseline: what each view may grow before the merge is refused.
const LIMITS = {
  street: { draws: (b) => b + 150, tris: (b) => b * 2 },
  district: { draws: (b) => b + 100, tris: (b) => b * 2 },
  city: { draws: (b) => b, tris: (b) => b * 1.2 },
  map: { draws: (b) => b, tris: (b) => b * 1.2 },
  night: { draws: (b) => b + 150, tris: (b) => b * 2 },
};
const MEMORY_FACTOR = 1.5; // cityMB + roadsMB

const script = (v) => `(async()=>{const g=window.__cidade.game;await g.view(0,0,${v.yaw},${v.pitch},${v.dist},${v.hour});` +
  `await g.settle(10);await new Promise(r=>setTimeout(r,1500));await g.settle(5);` +
  `console.log('BUDGET '+JSON.stringify({view:'${v.name}',...g.stats()}));})()`;

const seq = VIEWS.slice(1).map((v) => [path.join(out, `${v.name}.png`), script(v)]);
const env = { ...process.env, CIDADE_W: '1920', CIDADE_H: '1080', CIDADE_SEQ: JSON.stringify(seq) };
delete env.ELECTRON_RUN_AS_NODE;
const first = VIEWS[0];
const p = spawn(process.execPath, [
  path.join(root, 'tools', 'shot.mjs'), path.join(out, `${first.name}.png`),
  `?cidade&mapa=10&limpo&hora=${first.hour}&cam=0,0,${first.yaw},${first.pitch},${first.dist}`, script(first),
], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] });

const counts = {};
let buf = '';
p.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    const m = /BUDGET (\{.*\})/.exec(line);
    if (m) { const s = JSON.parse(m[1]); counts[s.view] = s; } else if (/^state:|error|Error/.test(line)) console.log(line);
  }
});

p.on('exit', (code) => {
  if (code) { console.error(`shot.mjs exited with ${code}`); process.exit(code); }
  const missing = VIEWS.filter((v) => !counts[v.name]).map((v) => v.name);
  if (missing.length) { console.error(`no counts for: ${missing.join(', ')}`); process.exit(1); }
  if (baseline) {
    fs.writeFileSync(budgetFile, JSON.stringify(counts, null, 2) + '\n');
    console.log(`baseline written to ${path.relative(root, budgetFile)}`);
    print(counts, null);
    process.exit(0);
  }
  if (!fs.existsSync(budgetFile)) { console.error('tools/budget.json missing: run with --baseline on main first'); process.exit(1); }
  const base = JSON.parse(fs.readFileSync(budgetFile, 'utf8'));
  const failures = print(counts, base);
  if (failures.length) { console.error(`\nBUDGET EXCEEDED: ${failures.join('; ')}`); process.exit(1); }
  console.log('\nbudget ok');
});

function print(now, base) {
  const failures = [];
  const row = (...c) => console.log(c.map((x, i) => String(x).padStart(i ? 12 : 9)).join(''));
  row('view', 'draws', 'limit', 'tris', 'limit', 'MB', 'limit', 'cars', 'peds');
  for (const v of VIEWS) {
    const n = now[v.name], b = base?.[v.name];
    const lim = LIMITS[v.name];
    const drawLimit = b ? Math.round(lim.draws(b.draws)) : '';
    const triLimit = b ? Math.round(lim.tris(b.tris)) : '';
    const mb = (n.cityMB ?? 0) + (n.roadsMB ?? 0);
    const mbLimit = b ? Math.round(((b.cityMB ?? 0) + (b.roadsMB ?? 0)) * MEMORY_FACTOR) : '';
    row(v.name, n.draws, drawLimit, n.tris, triLimit, mb, mbLimit, n.cars ?? '', n.peds ?? '');
    if (b) {
      if (n.draws > drawLimit) failures.push(`${v.name} draws ${n.draws} > ${drawLimit}`);
      if (n.tris > triLimit) failures.push(`${v.name} tris ${n.tris} > ${triLimit}`);
      if (mb > mbLimit) failures.push(`${v.name} MB ${mb} > ${mbLimit}`);
    }
  }
  return failures;
}

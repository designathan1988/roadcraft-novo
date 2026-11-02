// The load the machine really sees: the game in a visible window with vsync on (the display's own limit, no measurement
// switch), scenario by scenario, while the GPU's busy percentage, its memory and clocks (nvidia-smi) and the CPU and the
// memory of the game's processes are sampled from outside, next to the frame's own numbers (rAF time, frames drawn, GPU
// ms per pass and per compute with ?perf). What tools/probe.mjs measures is the frame's cost uncapped; this is what the
// Task Manager shows. Output: a table and a JSON file.
// Usage: npx vite build && node tools/gpu-load.mjs [--w=2560 --h=1080] [--seconds=8] [--out=file.json] [--query=extra] [--noperf] scenario...
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, findPage, waitReady } from './checks/cdp.mjs';
import { root } from './checks/run.mjs';
import { VIEWS, viewScript } from './photos/views.mjs';

const flag = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const names = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const W = flag('w', '2560'), H = flag('h', '1080'), seconds = Number(flag('seconds', 8)), extra = flag('query', '');
const perf = !process.argv.includes('--noperf');
const query = `?city&map=${flag('map', '10')}&clear&hour=11${perf ? '&perf' : ''}${extra ? '&' + extra : ''}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const view = Object.fromEntries(VIEWS.map((v) => [v.name, v]));
const set = (v, after = 'await R.frames.settle(20);') => viewScript(v, { after });
const stop = 'window.__mover = false;';
/** A camera moved every frame until the next scenario: `f(k)` is the argument of R.camera.place (yaw in radians; `y0` the
 * view's own). */
const mover = (f) => `window.__mover = true; { let k = 0; const R = window.__roadcraft; const y0 = R.camera.pose().yaw; const step = () => { if (!window.__mover) return; R.camera.place(${f}); k++; requestAnimationFrame(step); }; requestAnimationFrame(step); }`;

const SCENARIOS = {
  street: { setup: set(view.street) },
  district: { setup: set(view.district) },
  city: { setup: set(view.city) },
  night: { setup: set(view.night) },
  // the clock stopped, nothing touched: the frame loop should stop drawing after STILL_FRAMES
  paused: { setup: set(view.street, 'await R.frames.settle(20); R.ui.speed(0);'), then: 'window.__roadcraft.ui.speed(1);' },
  turnStreet: { setup: set(view.street) + ';' + mover('{ yaw: y0 + Math.sin(k * 0.02) * 0.6 }') },
  turnDistrict: { setup: set(view.district) + ';' + mover('{ yaw: y0 + Math.sin(k * 0.02) * 0.6 }') },
  turnCity: { setup: set(view.city) + ';' + mover('{ yaw: y0 + Math.sin(k * 0.02) * 0.6 }') },
  zoom: { setup: set(view.district) + ';' + mover('{ dist: 420 + Math.sin(k * 0.03) * 300 }') },
  // the window out of sight: what the game keeps drawing for nobody
  minimized: { setup: set(view.street), window: 'minimized', then: '' },
};

const exe = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const own = fs.mkdtempSync(path.join(os.tmpdir(), 'roadcraft-load-'));
const port = 9800 + Math.floor(Math.random() * 150);
// a window on the screen (ROADCRAFT_SHOW): off screen the compositor does not present as it does for a player
const env = { ...process.env, ROADCRAFT_SHOT: path.join(own, 'shot.png'), ROADCRAFT_QUERY: query, ROADCRAFT_SCRIPT: '1', ROADCRAFT_SETTLE: '7200', ROADCRAFT_USER_DATA: own, ROADCRAFT_W: W, ROADCRAFT_H: H, ROADCRAFT_SHOW: 'screen', ROADCRAFT_PLAYER: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ROADCRAFT_NOVSYNC;
const child = spawn(exe, ['.', `--remote-debugging-port=${port}`], { cwd: root, env, stdio: 'ignore' });

// ---- samplers. nvidia-smi once a second (the same counter the Task Manager's 3D graph follows on this driver);
// the processes through one PowerShell loop: CPU seconds and memory per electron.exe.
const smi = { rows: [] };
const smiP = spawn('nvidia-smi', ['--query-gpu=utilization.gpu,utilization.memory,memory.used,clocks.gr,power.draw', '--format=csv,noheader,nounits', '-l', '1'], { stdio: ['ignore', 'pipe', 'ignore'] });
smiP.on('error', () => {});
smiP.stdout?.on('data', (d) => { for (const l of String(d).split('\n')) { const c = l.split(',').map((x) => parseFloat(x)); if (c.length === 5 && !c.some(Number.isNaN)) smi.rows.push({ t: Date.now(), gpu: c[0], mem: c[1], vram: c[2], mhz: c[3], watts: c[4] }); } });
const procs = { rows: [] };
const ps = `while ($true) { $p = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*roadcraft-novo*' }; $o = $p | ForEach-Object { '{0}:{1}:{2}:{3}' -f $_.Id, [math]::Round($_.TotalProcessorTime.TotalMilliseconds), $_.WorkingSet64, $_.PrivateMemorySize64 }; Write-Output ($o -join ' '); Start-Sleep -Milliseconds 1000 }`;
const psP = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: ['ignore', 'pipe', 'ignore'] });
psP.stdout.on('data', (d) => { for (const l of String(d).split('\n')) { const list = l.trim().split(' ').filter(Boolean).map((e) => e.split(':').map(Number)); if (list.length) procs.rows.push({ t: Date.now(), list }); } });

const cores = os.cpus().length;
function window_(t0, t1) {
  const s = smi.rows.filter((r) => r.t >= t0 && r.t <= t1), p = procs.rows.filter((r) => r.t >= t0 && r.t <= t1);
  const mean = (k) => (s.length ? +(s.reduce((a, r) => a + r[k], 0) / s.length).toFixed(1) : null);
  const max = (k) => (s.length ? Math.max(...s.map((r) => r[k])) : null);
  let cpuPerCore = null, top = null, ws = null, priv = null;
  if (p.length >= 2) {
    const a = new Map(p[0].list.map((e) => [e[0], e[1]])), b = p[p.length - 1], ms = b.t - p[0].t;
    const per = b.list.map((e) => ({ id: e[0], core: (e[1] - (a.get(e[0]) ?? e[1])) / ms }));
    cpuPerCore = +per.reduce((x, e) => x + e.core, 0).toFixed(2);
    top = per.sort((x, y) => y.core - x.core).slice(0, 4).map((e) => +e.core.toFixed(2));
    ws = Math.round(b.list.reduce((x, e) => x + e[2], 0) / 1e6);
    priv = Math.round(b.list.reduce((x, e) => x + e[3], 0) / 1e6);
  }
  return { gpuPct: mean('gpu'), gpuMax: max('gpu'), memCtl: mean('mem'), vramMB: max('vram'), mhz: mean('mhz'), watts: mean('watts'), cpuCores: cpuPerCore, cpuTaskMgr: cpuPerCore === null ? null : +(cpuPerCore / cores * 100).toFixed(1), topProcCores: top, workingSetMB: ws, privateMB: priv };
}

const MEASURE = (ms) => `new Promise((done) => { const R = window.__roadcraft, prof = R.frames.profile?.(), gpu = R.frames.gpu?.();
  prof?.reset(); gpu?.reset(); const d0 = R.frames.drawn(); const dts = []; let last = performance.now(); const t0 = last;
  const step = () => { const now = performance.now(); dts.push(now - last); last = now;
    if (now - t0 < ${ms}) requestAnimationFrame(step);
    else { const t = prof?.snapshot() ?? null; done({ dts, drawn: R.frames.drawn() - d0, t, gpu: gpu?.snapshot() ?? null, stats: R.frames.stats(), hidden: document.hidden, vis: document.visibilityState }); } };
  requestAnimationFrame(step); })`;

const results = [];
const order = names.length ? names : ['street', 'turnStreet', 'district', 'turnDistrict', 'zoom', 'city', 'turnCity', 'night', 'paused', 'minimized'];
try {
  const target = await findPage(port, (u) => u.startsWith('app://'), { tries: 240, every: 500 });
  if (!target) throw new Error('the game did not open');
  const tab = await connect(target);
  if (!await waitReady(tab, 600000)) throw new Error('the game did not get ready');
  const { windowId } = (await tab.send('Browser.getWindowForTarget')).result ?? {};
  for (const name of order) {
    const sc = SCENARIOS[name];
    if (!sc) { results.push({ label: name, error: 'unknown scenario' }); continue; }
    await tab.evaluate(stop);
    const ok = await tab.evaluate(`(async () => { try { await ${sc.setup}; return 'ok'; } catch (e) { return String(e && e.stack || e); } })()`);
    if (ok !== 'ok' && ok !== undefined) { results.push({ label: name, error: ok }); continue; }
    if (sc.window && windowId) await tab.send('Browser.setWindowBounds', { windowId, bounds: { windowState: sc.window } });
    await sleep(1500);
    const t0 = Date.now();
    const f = await Promise.race([tab.evaluate(MEASURE(seconds * 1000)), sleep(seconds * 1000 + 3000).then(() => null)]);
    const t1 = Date.now();
    if (sc.window && windowId) await tab.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    if (sc.then) await tab.evaluate(sc.then);
    const load = window_(t0, t1);
    const r = { label: name, ...load };
    if (f) {
      const dts = [...f.dts].sort((a, b) => a - b), q = (p) => +dts[Math.floor(dts.length * p)].toFixed(1);
      Object.assign(r, { rafHz: +(f.dts.length / seconds).toFixed(1), drawnHz: +(f.drawn / seconds).toFixed(1), frameP50: q(0.5), frameP99: q(0.99), hidden: f.hidden, vis: f.vis,
        cpuDrawMs: f.t ? +(f.t.draw / Math.max(1, f.t.frames ?? f.dts.length)).toFixed(2) : null,
        gpuRenderMs: f.gpu && +f.gpu.totalMs.toFixed(2), gpuComputeMs: f.gpu && +f.gpu.computeMs.toFixed(2),
        perCall: f.gpu?.perCallMs.map((x, i) => [f.gpu.names[i] ?? '?', +x.toFixed(2)]), perCompute: f.gpu?.perComputeMs.map((x) => +x.toFixed(2)), stats: f.stats });
    } else r.note = 'no animation frame in the window';
    results.push(r);
    console.log(JSON.stringify(r));
  }
  await tab.evaluate(stop);
  tab.close();
} catch (err) {
  results.push({ error: String(err && err.stack || err) });
  console.log('error: ' + (err && err.message || err));
} finally {
  child.kill(); smiP.kill(); psP.kill();
  await sleep(1500);
  fs.rmSync(own, { recursive: true, force: true, maxRetries: 5 });
}
const out = flag('out', '');
if (out) fs.writeFileSync(out, JSON.stringify({ query, W, H, results }, null, 1));
const row = (...c) => console.log(c.map((x, i) => String(x ?? '-').padStart(i ? 9 : 13)).join(''));
row('scenario', 'GPU%', 'max', 'CPU%TM', 'cores', 'VRAM', 'WS MB', 'rafHz', 'drawHz', 'p50', 'p99', 'renderMs', 'compMs', 'cpuDraw');
for (const r of results) row(r.label, r.gpuPct, r.gpuMax, r.cpuTaskMgr, r.cpuCores, r.vramMB, r.workingSetMB, r.rafHz, r.drawnHz, r.frameP50, r.frameP99, r.gpuRenderMs, r.gpuComputeMs, r.cpuDrawMs);
process.exit(results.some((r) => r.error) ? 1 : 0);

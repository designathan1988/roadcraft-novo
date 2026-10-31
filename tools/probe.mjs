// Measurement probe: the game (dist/, Electron, the machine's GPU, frame rate not capped: ROADCRAFT_NOVSYNC) driven over
// the DevTools protocol, scenario by scenario in one session. Per scenario, over N frames:
//  - frame time (requestAnimationFrame deltas) and the CPU time of each per-frame system (the frame's own profile
//    under ?perf, src/app/frameProfile.ts, read through the automation contract window.__roadcraft);
//  - GPU time per render call (?perf turns on the renderer's timestamp queries, src/render/gpuTiming.ts);
//  - allocations: the sampling heap profiler with the objects already collected kept (HeapProfiler.startSampling,
//    includeObjectsCollectedByMinorGC/MajorGC), total per frame and the functions that allocate most;
//  - garbage collections: MinorGC/MajorGC events of a trace (categories v8, devtools.timeline);
//  - messages out to the simulation and jobs to the pool (counted at the page's boundary, Worker postMessage), messages
//    in from the simulation (the profile counts them where they arrive); R.frames.stats() at the end.
// Usage: npx vite build && node tools/probe.mjs [--map=10] [--query=extra] [--frames=300] [--out=file.json] scenario...
// Scenarios: street district city night maxTraffic bomb editing save (default: street district city night).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, findPage, waitReady } from './checks/cdp.mjs';
import { root } from './checks/run.mjs';
import { VIEWS, viewScript } from './photos/views.mjs';

const flag = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const names = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const scenarios = names.length ? names : ['street', 'district', 'city', 'night'];
const map = flag('map', '10'), frames = Number(flag('frames', 300)), extra = flag('query', '');
const query = `?city&map=${map}&clear&hour=11&perf${extra ? '&' + extra : ''}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const view = Object.fromEntries(VIEWS.map((v) => [v.name, v]));

// installed once: per-frame systems timed, worker messages and pool jobs counted
const INSTALL = `(() => { const R = window.__roadcraft;
// what the page sends out to its workers, counted at the boundary: jobs to the pool, the rest to the simulation
const P = window.__probe = { msgOut: 0, jobs: 0 };
const W = Worker.prototype, post = W.postMessage;
W.postMessage = function (m, tr) { if (m && m.type === 'job') P.jobs++; else P.msgOut++; return post.call(this, m, tr); };
return 1; })()`;

// N frames timed in the page; resolves with the frame times, the systems' totals (the frame's own profile) and the counts
const FRAMES = (n) => `new Promise((done) => { const R = window.__roadcraft, P = window.__probe, prof = R.frames.profile(), gpu = R.frames.gpu();
  prof.reset(); gpu?.reset(); P.msgOut = 0; P.jobs = 0;
  const dts = []; let last = performance.now(), k = 0;
  const step = () => { const now = performance.now(); dts.push(now - last); last = now;
    if (++k < ${n}) requestAnimationFrame(step);
    else { const t = prof.snapshot(); const msgIn = t.simIn; delete t.frames; delete t.drawn; delete t.simIn;
      done({ dts, t, msgOut: P.msgOut, msgIn, jobs: P.jobs, gpu: gpu?.snapshot() ?? null, stats: R.frames.stats() }); } };
  requestAnimationFrame(step); })`;

const SETUP = {
  street: viewScript(view.street, { after: 'await R.frames.settle(20);' }),
  district: viewScript(view.district, { after: 'await R.frames.settle(20);' }),
  city: viewScript(view.city, { after: 'await R.frames.settle(20);' }),
  night: viewScript(view.night, { after: 'await R.frames.settle(20);' }),
  maxTraffic: viewScript({ ...view.district, dist: 250, pitch: 30 }, { before: "R.ui.simulation({ traffic: 2, people: 2, demand: 'peak' });", after: 'await new Promise((r) => setTimeout(r, 20000));' }),
  bomb: viewScript({ ...view.district, dist: 250, pitch: 30 }, { after: 'await R.frames.settle(10); R.ui.bombForce(20); R.actions.bomb(0, 0);' }),
  editing: viewScript({ ...view.district, pitch: 40, dist: 400 }, { after: "await R.frames.settle(10); window.__ed = 0; const ed = () => { if (window.__ed++ < 400) { R.actions.terrain('raise', (window.__ed % 20) * 8 - 80, 120, 40, 0.4); requestAnimationFrame(ed); } }; requestAnimationFrame(ed);" }),
};

const exe = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const own = fs.mkdtempSync(path.join(os.tmpdir(), 'roadcraft-probe-'));
const port = 9400 + Math.floor(Math.random() * 400);
const env = { ...process.env, ROADCRAFT_SHOT: path.join(own, 'shot.png'), ROADCRAFT_QUERY: query, ROADCRAFT_SCRIPT: '1', ROADCRAFT_SETTLE: '7200', ROADCRAFT_LIMIT: '7200',
  ROADCRAFT_USER_DATA: own, ROADCRAFT_W: '1920', ROADCRAFT_H: '1080', ROADCRAFT_NOVSYNC: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(exe, ['.', `--remote-debugging-port=${port}`], { cwd: root, env, stdio: 'ignore' });
const results = [];
try {
  const target = await findPage(port, (u) => u.startsWith('app://'), { tries: 240, every: 500 });
  if (!target) throw new Error('the game did not open');
  const tab = await connect(target);
  const t0 = Date.now();
  if (!await waitReady(tab, 600000)) throw new Error('the game did not get ready');
  results.push({ label: 'ready', ms: Date.now() - t0 });
  await tab.evaluate(INSTALL);
  // collections counted from the trace; one listener for the whole run, the counters reset per scenario
  const gcs = { minor: 0, major: 0 };
  let traceDone = () => {};
  tab.on('Tracing.dataCollected', (p) => { for (const e of p.value) { if (e.name === 'MinorGC') gcs.minor++; else if (e.name === 'MajorGC') gcs.major++; } });
  tab.on('Tracing.tracingComplete', () => traceDone());
  for (const name of scenarios) {
    if (name === 'save') {
      const r = await tab.evaluate(`(async () => { const R = window.__roadcraft; const t0 = performance.now(); const ok = await R.saves.save(false); const t1 = performance.now();
        const ok2 = await R.saves.load(); await R.frames.settle(20); const t2 = performance.now(); return { saveOk: ok, saveMs: Math.round(t1 - t0), loadOk: ok2, loadMs: Math.round(t2 - t1), stats: R.frames.stats() }; })()`);
      results.push({ label: 'save', ...r });
      console.log(JSON.stringify(results[results.length - 1]));
      continue;
    }
    if (!SETUP[name]) { results.push({ label: name, error: 'unknown scenario' }); continue; }
    const set = await tab.evaluate(`(async () => { try { await ${SETUP[name]}; return 'ok'; } catch (e) { return String(e && e.stack || e); } })()`);
    if (set !== 'ok') { results.push({ label: name, error: set }); continue; }
    // allocations (sampled, collected objects kept) and collections (trace) over the measured frames
    await tab.send('HeapProfiler.enable');
    await tab.send('HeapProfiler.startSampling', { samplingInterval: 8192, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    gcs.minor = 0; gcs.major = 0;
    const complete = new Promise((r) => { traceDone = r; });
    await tab.send('Tracing.start', { categories: 'v8,devtools.timeline', transferMode: 'ReportEvents' });
    const f = await tab.evaluate(FRAMES(frames));
    await tab.send('Tracing.end');
    await Promise.race([complete, sleep(20000)]);
    const prof = (await tab.send('HeapProfiler.stopSampling')).result?.profile;
    const byFn = new Map();
    let bytes = 0;
    const walk = (n) => {
      if (n.selfSize) { bytes += n.selfSize; const cf = n.callFrame; const k = `${cf.functionName || '(anonymous)'} ${cf.url.replace(/^.*\/assets\//, '')}:${cf.lineNumber + 1}`; byFn.set(k, (byFn.get(k) ?? 0) + n.selfSize); }
      for (const c of n.children ?? []) walk(c);
    };
    if (prof) walk(prof.head);
    const dts = [...f.dts].sort((a, b) => a - b), q = (p) => +dts[Math.floor(dts.length * p)].toFixed(2);
    const per = Object.fromEntries(Object.entries(f.t).map(([k, v]) => [k, +(v / frames).toFixed(3)]));
    results.push({
      label: name, frames, frameMs: { p50: q(0.5), p90: q(0.9), p99: q(0.99), max: +dts[dts.length - 1].toFixed(1) }, systemsMsPerFrame: per,
      gpu: f.gpu && { frames: f.gpu.frames, totalMs: +f.gpu.totalMs.toFixed(2), perCallMs: f.gpu.perCallMs.map((x) => +x.toFixed(2)) },
      allocKBPerFrame: +(bytes / frames / 1024).toFixed(1), gc: gcs,
      topAllocKBPerFrame: [...byFn].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => [k, +(v / frames / 1024).toFixed(1)]),
      simMsgOut: f.msgOut, simMsgIn: f.msgIn, jobs: f.jobs, stats: f.stats,
    });
    console.log(JSON.stringify(results[results.length - 1]));
  }
  tab.close();
} catch (err) {
  results.push({ error: String(err && err.stack || err) });
  console.log('error: ' + (err && err.message || err));
} finally {
  child.kill();
  await sleep(1500);
  fs.rmSync(own, { recursive: true, force: true, maxRetries: 5 });
}
const out = flag('out', '');
if (out) fs.writeFileSync(out, JSON.stringify({ query, frames, results }, null, 1));
process.exit(results.some((r) => r.error) ? 1 : 0);

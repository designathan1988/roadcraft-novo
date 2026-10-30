// The standard photos (tools/photos/views.mjs) taken from what ships, not from dist/: the packaged executable
// (out/Roadcraft-win32-x64) or the browser zip's folder served by its own tools/serve.mjs and opened in Chrome (driven
// through the DevTools protocol). Each run uses its own browser profile, so it never shares the save storage.
// Usage: node tools/photos/package.mjs [--browser] [output folder]
//   npm run package:win / npm run package:web first. Prints game.stats() per view and, in the browser, whether the
//   page is cross-origin isolated (COOP/COEP, needed for SharedArrayBuffer).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { connect, findPage } from '../checks/cdp.mjs';
import { root } from '../checks/run.mjs';
import { VIEWS, viewScript } from './views.mjs';

const browser = process.argv.includes('--browser');
const outArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const out = path.resolve(outArg ?? path.join(root, 'test-results', 'photos', browser ? 'package-browser' : 'package'));
fs.mkdirSync(out, { recursive: true });
const wait = (ms) => `await new Promise(r=>setTimeout(r,${ms}));`;
const byName = Object.fromEntries(VIEWS.map((v) => [v.name, v]));
const SHOTS = [['01-street', 'street', 4000], ['02-district', 'district', 6000], ['03-city', 'city', 8000], ['04-night', 'night', 6000]]
  .map(([file, v, ms]) => [`${file}.png`, viewScript(byName[v], { after: `${wait(ms)}console.log('STATS ${v} '+JSON.stringify(R.frames.stats()));` })]);
const QUERY = '?city&map=10&clear&hour=11';
const limit = Number(process.env.ROADCRAFT_LIMIT ?? 600) * 1000;

if (!browser) {
  const dir = path.join(root, 'out', process.platform === 'win32' ? 'Roadcraft-win32-x64' : 'Roadcraft-linux-x64');
  const exe = path.join(dir, process.platform === 'win32' ? 'Roadcraft.exe' : 'Roadcraft');
  if (!fs.existsSync(exe)) { console.error(`no ${exe}: run npm run package:win first`); process.exit(2); }
  const env = { ...process.env, ROADCRAFT_W: '1920', ROADCRAFT_H: '1080', ROADCRAFT_QUERY: QUERY, ROADCRAFT_SHOT: path.join(out, SHOTS[0][0]), ROADCRAFT_SCRIPT: SHOTS[0][1],
    ROADCRAFT_SEQ: JSON.stringify(SHOTS.slice(1).map(([f, s]) => [path.join(out, f), s])) };
  delete env.ELECTRON_RUN_AS_NODE;
  const p = spawn(exe, [`--user-data-dir=${path.join(out, '.profile')}`], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const s of [p.stdout, p.stderr]) s.on('data', (d) => { for (const l of String(d).split('\n')) if (/STATS|state:|photo:|rror/.test(l)) console.log(l.trim()); });
  let timedOut = false;
  const t = setTimeout(() => { timedOut = true; console.log('timed out'); p.kill(); }, limit);
  p.on('exit', (c, signal) => { clearTimeout(t); process.exit(timedOut ? 124 : c ?? (signal ? 1 : 0)); });
} else {
  const dir = path.join(root, 'out', 'Roadcraft-navegador');
  if (!fs.existsSync(path.join(dir, 'tools', 'serve.mjs'))) { console.error(`no ${dir}: run npm run package:web first`); process.exit(2); }
  const port = 5190 + Math.floor(Math.random() * 40);
  const server = spawn(process.execPath, [path.join(dir, 'tools', 'serve.mjs')], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise((resolve) => server.stdout.on('data', (d) => { const m = /(http:\/\/localhost:\d+\/)/.exec(String(d)); if (m) resolve(m[1]); }));
  const local = process.env.LOCALAPPDATA ?? '', pf = process.env.PROGRAMFILES ?? 'C:\\Program Files', pf86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
  const chrome = [`${pf}\\Google\\Chrome\\Application\\chrome.exe`, `${pf86}\\Google\\Chrome\\Application\\chrome.exe`, `${local}\\Google\\Chrome\\Application\\chrome.exe`,
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((c) => fs.existsSync(c));
  if (!chrome) { console.error('Chrome not found'); server.kill(); process.exit(2); }
  const debug = port + 100;
  const ch = spawn(chrome, [`--user-data-dir=${path.join(out, '.chrome')}`, `--remote-debugging-port=${debug}`, '--no-first-run', '--no-default-browser-check',
    '--window-size=1920,1080', '--window-position=-20000,-20000', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion', `${url}${QUERY}`], { stdio: 'ignore' });
  const done = (code) => { try { ch.kill(); } catch { /* gone */ } server.kill(); process.exit(code); };
  setTimeout(() => { console.log('timed out'); done(124); }, limit);
  const target = await findPage(debug, (u) => u.startsWith(url), { tries: 100, every: 300 });
  if (!target) { console.error('no Chrome page'); done(1); }
  const tab = await connect(target);
  await tab.send('Runtime.enable');
  const t0 = Date.now();
  let status = '';
  while (Date.now() - t0 < limit) {
    status = await tab.evaluate('window.__roadcraft?.status ?? "loading"');
    if (status === 'ready' || status === 'failed') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`state: ${status} after ${((Date.now() - t0) / 1000).toFixed(1)} s; crossOriginIsolated=${await tab.evaluate('crossOriginIsolated')}; webgpu=${await tab.evaluate('!!navigator.gpu')}; ${url}`);
  for (const [file, script] of SHOTS) {
    tab.lines.length = 0;
    await tab.evaluate(script);
    for (const l of tab.lines) if (/STATS|rror/.test(l)) console.log(l);
    await new Promise((r) => setTimeout(r, 2000));
    const shot = await tab.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, file), Buffer.from(shot.result.data, 'base64'));
    console.log(`photo: ${path.join(out, file)}`);
  }
  await tab.send('Browser.close').catch(() => {});
  done(status === 'ready' ? 0 : 1);
}

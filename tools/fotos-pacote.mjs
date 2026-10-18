// The standard photos (street, district, city, night: the views of tools/fotos.mjs) taken from what ships, not
// from dist/: the packaged executable (out/Roadcraft-win32-x64) or the browser zip's folder served by its own
// tools/serve.mjs and opened in Chrome (driven through the DevTools protocol; no Playwright).
// Each run uses its own browser profile, so it never shares the save storage with a game or another run.
// Usage: node tools/fotos-pacote.mjs [--navegador] [pasta-de-saída]
//   npm run package:win / npm run package:web first. Prints game.stats() per view and, in the browser,
//   whether the page is cross-origin isolated (COOP/COEP, needed for SharedArrayBuffer).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = process.argv.includes('--navegador');
const outArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const out = path.resolve(outArg ?? path.join(root, 'test-results', browser ? 'fotos-navegador' : 'fotos-pacote'));
fs.mkdirSync(out, { recursive: true });
const wait = (ms) => `await new Promise(r=>setTimeout(r,${ms}));`;
const stats = (name) => `console.log('STATS ${name} '+JSON.stringify(window.__cidade.game.stats()));`;
const view = (name, yaw, pitch, dist, hour, ms) => `(async()=>{await window.__cidade.game.view(0,0,${yaw},${pitch},${dist},${hour});${wait(ms)}${stats(name)}})()`;
const QUERY = '?cidade&mapa=10&limpo&hora=11&cam=0,0,35,18,90';
const VIEWS = [
  ['01-rua.png', `(async()=>{${wait(4000)}${stats('rua')}})()`],
  ['02-bairro.png', view('bairro', 35, 50, 420, 11, 6000)],
  ['03-cidade.png', view('cidade', 35, 45, 2200, 11, 8000)],
  ['04-noite.png', view('noite', 35, 18, 90, 21, 6000)],
];
const limit = Number(process.env.CIDADE_LIMIT ?? 600) * 1000;

if (!browser) {
  const dir = path.join(root, 'out', process.platform === 'win32' ? 'Roadcraft-win32-x64' : 'Roadcraft-linux-x64');
  const exe = path.join(dir, process.platform === 'win32' ? 'Roadcraft.exe' : 'Roadcraft');
  if (!fs.existsSync(exe)) { console.error(`no ${exe}: run npm run package:win first`); process.exit(2); }
  const env = {
    ...process.env, CIDADE_W: '1920', CIDADE_H: '1080', CIDADE_QUERY: QUERY,
    CIDADE_SHOT: path.join(out, VIEWS[0][0]), CIDADE_SCRIPT: VIEWS[0][1],
    CIDADE_SEQ: JSON.stringify(VIEWS.slice(1).map(([f, s]) => [path.join(out, f), s])),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const p = spawn(exe, [`--user-data-dir=${path.join(out, '.perfil')}`], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const s of [p.stdout, p.stderr]) s.on('data', (d) => { for (const l of String(d).split('\n')) if (/STATS|state:|photo:|rror/.test(l)) console.log(l.trim()); });
  const t = setTimeout(() => { console.log('timeout'); p.kill(); }, limit);
  p.on('exit', (c) => { clearTimeout(t); process.exit(c ?? 0); });
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
  setTimeout(() => { console.log('timeout'); done(1); }, limit);
  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    await new Promise((r) => setTimeout(r, 300));
    try { target = (await (await fetch(`http://127.0.0.1:${debug}/json/list`)).json()).find((t) => t.type === 'page' && t.url.startsWith(url)); } catch { /* not up yet */ }
  }
  if (!target) { console.error('no Chrome page'); done(1); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      if (/STATS|rror/.test(text)) console.log(text);
    }
  });
  const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await send('Runtime.enable');
  const t0 = Date.now();
  let status = '';
  while (Date.now() - t0 < limit) {
    status = await evaluate('window.__cidade?.status ?? "carregando"');
    if (status === 'pronto' || status === 'falhou') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`state: ${status} after ${((Date.now() - t0) / 1000).toFixed(1)} s; crossOriginIsolated=${await evaluate('crossOriginIsolated')}; webgpu=${await evaluate('!!navigator.gpu')}; ${url}`);
  for (const [file, script] of VIEWS) {
    await evaluate(script);
    await new Promise((r) => setTimeout(r, 2000));
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, file), Buffer.from(shot.result.data, 'base64'));
    console.log(`photo: ${path.join(out, file)}`);
  }
  await send('Browser.close').catch(() => {});
  done(status === 'pronto' ? 0 : 1);
}

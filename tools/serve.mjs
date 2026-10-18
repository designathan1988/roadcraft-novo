// Minimal local server with COOP/COEP (SharedArrayBuffer needs them). No dependencies: it ships in the browser zip
// next to dist/ (tools/package-web.mjs) and is started by jogar.bat / jogar.sh.
// Usage: node tools/serve.mjs [--abrir]   (PORT=5173 by default; the next free port if it is taken)
//   --abrir  opens the game in Chrome (or Edge, or the default browser) once the server is up
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const open = process.argv.includes('--abrir');
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.map': 'application/json', '.json': 'application/json', '.css': 'text/css', '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm', '.png': 'image/png', '.webp': 'image/webp', '.ktx2': 'image/ktx2', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.bin': 'application/octet-stream',
};
if (!fs.existsSync(path.join(root, 'index.html'))) {
  console.error(`Não achei o jogo em ${root} (falta dist/index.html).`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.resolve(root, rel);
  if (!file.startsWith(root)) { res.writeHead(404).end('not found'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

/** Chrome first (WebGPU), then Edge, then whatever the system opens. */
function browse(url) {
  const local = process.env.LOCALAPPDATA ?? '', pf = process.env.PROGRAMFILES ?? 'C:\\Program Files', pf86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
  const candidates = process.platform === 'win32'
    ? [`${pf}\\Google\\Chrome\\Application\\chrome.exe`, `${pf86}\\Google\\Chrome\\Application\\chrome.exe`, `${local}\\Google\\Chrome\\Application\\chrome.exe`, `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`, `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`]
    : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const exe = candidates.find((c) => fs.existsSync(c));
  if (exe) spawn(exe, [url], { detached: true, stdio: 'ignore' }).unref();
  else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

let port = Number(process.env.PORT ?? 5173);
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && port < Number(process.env.PORT ?? 5173) + 20) { port++; server.listen(port, '127.0.0.1'); return; }
  console.error(e.message);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  const url = `http://localhost:${port}/`;
  console.log(`Roadcraft em ${url}  (feche esta janela para parar)`);
  if (open) browse(url);
});

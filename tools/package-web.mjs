// The browser version as a zip: dist/ (the build, without source maps and without the people's source assets,
// only their licences), tools/serve.mjs (local server with COOP/COEP) and jogar.bat / jogar.sh, which start it and
// open Chrome. The player needs Node.js (the Windows build needs nothing).
// Usage: node tools/package-web.mjs   (npm run package:web builds first)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const name = 'Roadcraft-navegador';
const out = path.join(root, 'out', name);
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) throw new Error('no dist/: run npm run build first');
fs.rmSync(out, { recursive: true, force: true });

/** The same choice as tools/package.mjs: no .map, of dist/models only the licence files. */
const ships = (rel) => {
  if (rel.endsWith('.map')) return false;
  if (rel.startsWith('models/')) return /\/(LICENSE[^/]*|LICENSES\.json)$/.test(rel);
  return true;
};
const copyDir = (from, to, base = '') => {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) copyDir(path.join(from, e.name), path.join(to, e.name), rel);
    else if (ships(rel)) { fs.mkdirSync(to, { recursive: true }); fs.copyFileSync(path.join(from, e.name), path.join(to, e.name)); }
  }
};
copyDir(path.join(root, 'dist'), path.join(out, 'dist'));
fs.mkdirSync(path.join(out, 'tools'), { recursive: true });
fs.copyFileSync(path.join(root, 'tools', 'serve.mjs'), path.join(out, 'tools', 'serve.mjs'));
// line ends fixed whatever the checkout did: sh refuses CRLF, cmd wants it
const text = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
fs.writeFileSync(path.join(out, 'jogar.sh'), text('jogar.sh'));
fs.writeFileSync(path.join(out, 'jogar.bat'), text('jogar.bat').replace(/\n/g, '\r\n'));
fs.chmodSync(path.join(out, 'jogar.sh'), 0o755);
fs.writeFileSync(path.join(out, 'LEIA-ME.txt'), [
  'Roadcraft no navegador',
  '',
  'Windows: dois cliques em jogar.bat. Linux e macOS: ./jogar.sh',
  'Abre o jogo no Chrome (ou Edge) em http://localhost:5173/. Feche a janela do servidor para parar.',
  'Precisa do Node.js 20 ou mais novo (https://nodejs.org) e de um navegador com WebGPU (Chrome ou Edge atuais).',
  'O jogo salvo fica no navegador (armazenamento do site localhost).',
  '',
  'Licenças dos modelos de pessoas: dist/models/people (MakeHuman, CC0) e dist/models/citizens (Microsoft Rocketbox, MIT).',
  '',
].join('\r\n'));

const zip = `${out}.zip`;
fs.rmSync(zip, { force: true });
const win = process.platform === 'win32';
const tool = win ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'zip';
const r = spawnSync(tool, win ? ['-a', '-cf', `${name}.zip`, name] : ['-qr', `${name}.zip`, name], { cwd: path.dirname(out), stdio: 'inherit' });
if (r.status !== 0) throw new Error(`zip failed: ${tool}`);

const sizeOf = (p) => (fs.statSync(p).isDirectory() ? fs.readdirSync(p).reduce((s, f) => s + sizeOf(path.join(p, f)), 0) : fs.statSync(p).size);
const mb = (b) => `${(b / 1e6).toFixed(1)} MB`;
console.log(`${out}: ${mb(sizeOf(out))}; ${zip}: ${mb(fs.statSync(zip).size)}`);
for (const [label, at] of [['pessoas cozidas', 'dist/cooked'], ['jogo (código, three.js, textos)', 'dist/assets'], ['licenças', 'dist/models']]) {
  const p = path.join(out, at);
  if (fs.existsSync(p)) console.log(`  ${label}: ${mb(sizeOf(p))}`);
}

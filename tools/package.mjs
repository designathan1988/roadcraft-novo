// Packages the game with Electron (Windows and Linux), with no Node needed on the player's PC.
// Usage: node tools/package.mjs [win32|linux]
import { packager } from '@electron/packager';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const platform = process.argv[2] ?? 'win32';
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const electronVersion = JSON.parse(fs.readFileSync('node_modules/electron/package.json', 'utf8')).version;
const keep = new Set(['', '/package.json', '/electron', '/dist', '/node_modules', '/node_modules/steamworks.js']);
const paths = await packager({
  dir: '.',
  out: 'out',
  platform,
  arch: 'x64',
  name: 'Roadcraft',
  executableName: 'Roadcraft',
  appVersion: pkg.version,
  electronVersion,
  overwrite: true,
  icon: 'electron/icon.ico',
  win32metadata: { CompanyName: 'Roadcraft', FileDescription: 'Roadcraft', ProductName: 'Roadcraft', InternalName: 'Roadcraft', OriginalFilename: 'Roadcraft.exe' },
  asar: false,
  prune: false,
  ignore: (p) => {
    if (keep.has(p)) return false;
    // the game needs only the build: no source maps, and of the people's source assets (public/models, used by the
    // offline cook) only the licence files, which ship with the game and are shown in About
    if (p.endsWith('.map')) return true;
    if (p.startsWith('/dist/models/')) return !(/\/(LICENSE[^/]*|LICENSES\.json)$/.test(p) || /^\/dist\/models\/(people|citizens)$/.test(p));
    // from node_modules only steamworks.js ships (and only the platform's binary)
    if (p.startsWith('/node_modules/steamworks.js/dist/')) {
      const want = platform === 'win32' ? 'win64' : 'linux64';
      return !p.startsWith(`/node_modules/steamworks.js/dist/${want}`) && p !== '/node_modules/steamworks.js/dist';
    }
    if (p.startsWith('/node_modules/steamworks.js/')) return false;
    if (p.startsWith('/node_modules')) return true;
    return ![...keep].some((k) => k && (p === k || p.startsWith(k + '/')));
  },
});
// Steam: the executable looks for steam_appid.txt next to it (480 = test); replace with the game's AppID
for (const p of paths) fs.writeFileSync(`${p}/steam_appid.txt`, process.env.STEAM_APPID ?? '480');

// Chromium's interface strings: only the game's languages (it falls back to en-US for any other system language)
const LOCALES = new Set(['en-US.pak', 'pt-BR.pak']);
for (const p of paths) {
  const dir = path.join(p, 'locales');
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (!LOCALES.has(f)) fs.rmSync(path.join(dir, f));
}

// The folder zipped for distribution, with the sizes and what weighs most
const sizeOf = (p) => (fs.statSync(p).isDirectory() ? fs.readdirSync(p).reduce((s, f) => s + sizeOf(path.join(p, f)), 0) : fs.statSync(p).size);
const mb = (b) => `${(b / 1e6).toFixed(1)} MB`;
for (const p of paths) {
  const zip = `${p}.zip`;
  fs.rmSync(zip, { force: true });
  // Windows 10+ ships bsdtar, which writes zip (-a picks the format by the extension)
  const win = process.platform === 'win32';
  const tool = win ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'zip';
  const args = win ? ['-a', '-cf', path.basename(zip), path.basename(p)] : ['-qr', path.basename(zip), path.basename(p)];
  const r = spawnSync(tool, args, { cwd: path.dirname(p), stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`zip failed: ${tool}`);
  console.log(`${p}: ${mb(sizeOf(p))}; ${zip}: ${mb(fs.statSync(zip).size)}`);
  const app = path.join(p, 'resources', 'app');
  const parts = [['Electron (Chromium)', path.join(p, win ? 'Roadcraft.exe' : 'Roadcraft')], ['pessoas cozidas', path.join(app, 'dist', 'cooked')],
    ['jogo (código, three.js, textos)', path.join(app, 'dist', 'assets')], ['Steam (steamworks.js)', path.join(app, 'node_modules')], ['locales', path.join(p, 'locales')]];
  for (const [name, at] of parts) if (fs.existsSync(at)) console.log(`  ${name}: ${mb(sizeOf(at))}`);
}

// Empacota o jogo com o Electron (Windows e Linux), sem precisar de Node no PC do jogador.
// Uso: node tools/package.mjs [win32|linux]
import { packager } from '@electron/packager';
import fs from 'node:fs';

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
  asar: false,
  prune: false,
  ignore: (p) => {
    if (keep.has(p)) return false;
    // de node_modules só vai a steamworks.js (e só o binário da plataforma)
    if (p.startsWith('/node_modules/steamworks.js/dist/')) {
      const want = platform === 'win32' ? 'win64' : 'linux64';
      return !p.startsWith(`/node_modules/steamworks.js/dist/${want}`) && p !== '/node_modules/steamworks.js/dist';
    }
    if (p.startsWith('/node_modules/steamworks.js/')) return false;
    if (p.startsWith('/node_modules')) return true;
    return ![...keep].some((k) => k && (p === k || p.startsWith(k + '/')));
  },
});
// Steam: o executável procura steam_appid.txt ao lado (480 = teste); troque pelo AppID do jogo
for (const p of paths) fs.writeFileSync(`${p}/steam_appid.txt`, process.env.STEAM_APPID ?? '480');
console.log(paths.join('\n'));

// Evidence photos for a feature slice: the same generated 10 km city, several distances and hours, so a visual
// change can be judged on more than one image. Usage: node tools/fotos-testemunho.mjs [folder]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(root, 'test-results', 'testemunho'));
fs.mkdirSync(out, { recursive: true });
const wait = (ms) => `await new Promise(r=>setTimeout(r,${ms}));`;
const view = (x, z, yaw, pitch, dist, hour, ms) => `(async()=>{window.__cidade.game.view(${x},${z},${yaw},${pitch},${dist},${hour});${wait(ms)}})()`;
const street = [177, 711];
const seq = [
  [path.join(out, '02-rua-perto.png'), view(...street, 35, 12, 22, 11, 5000)],
  [path.join(out, '03-rua-perto-noite.png'), view(...street, 215, 12, 22, 21, 5000)],
  [path.join(out, '04-bairro.png'), view(0, 0, 35, 50, 420, 11, 6000)],
  [path.join(out, '05-cidade.png'), view(0, 0, 35, 45, 2200, 11, 8000)],
  [path.join(out, '06-noite.png'), view(...street, 35, 18, 90, 21, 6000)],
  [path.join(out, '07-rua-outro-lado.png'), view(...street, 215, 14, 30, 11, 5000)],
  [path.join(out, '08-cidade-noite.png'), view(0, 0, 35, 45, 2200, 21, 8000)],
];
const env = { ...process.env, CIDADE_W: '1920', CIDADE_H: '1080' };
delete env.ELECTRON_RUN_AS_NODE;
const p = spawn(process.execPath, [
  path.join(root, 'tools', 'shot.mjs'), path.join(out, '01-rua.png'),
  `?cidade&mapa=10&limpo&hora=11&cam=${street[0]},${street[1]},35,18,90`,
], { cwd: root, env: { ...env, CIDADE_SEQ: JSON.stringify(seq) }, stdio: 'inherit' });
p.on('exit', (code) => process.exit(code ?? 0));

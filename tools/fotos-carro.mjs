// Close evidence of the cabins: the same intersection from several low, short views, day and night.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(root, 'test-results', 'carro-perto'));
fs.mkdirSync(out, { recursive: true });
const wait = (ms) => `await new Promise(r=>setTimeout(r,${ms}));`;
const view = (yaw, pitch, dist, hour, ms) => `(async()=>{window.__cidade.game.view(177,711,${yaw},${pitch},${dist},${hour});${wait(ms)}})()`;
const seq = [
  [path.join(out, '02-carro-12m.png'), view(215, 8, 12, 11, 4000)],
  [path.join(out, '03-carro-16m.png'), view(35, 10, 16, 11, 4000)],
  [path.join(out, '04-carro-8m-noite.png'), view(35, 8, 8, 21, 4000)],
  [path.join(out, '05-carro-12m-noite.png'), view(215, 8, 12, 21, 4000)],
  [path.join(out, '06-carro-16m-noite.png'), view(35, 10, 16, 21, 4000)],
  [path.join(out, '07-seguindo-carro.png'), `(async()=>{const g=window.__cidade.game;await g.view(177,711,35,8,12,11);g.hudActions.follow();${wait(2500)}})()`],
];
const env = { ...process.env, CIDADE_W: '1920', CIDADE_H: '1080', CIDADE_SEQ: JSON.stringify(seq) };
delete env.ELECTRON_RUN_AS_NODE;
const p = spawn(process.execPath, [
  path.join(root, 'tools', 'shot.mjs'), path.join(out, '01-carro-8m.png'),
  '?cidade&mapa=10&limpo&hora=11&cam=177,711,35,8,8',
], { cwd: root, env, stdio: 'inherit' });
p.on('exit', (code) => process.exit(code ?? 0));

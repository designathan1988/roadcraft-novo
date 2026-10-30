// Car QA photos: the same junction at 20/100/500 m, day and night, plus the camera following a car at 20/100/500 m.
// The point is opacity: only the glass may be transparent, never the body. Usage: node tools/fotos-carros-qa.mjs [folder]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(root, 'test-results', 'carros-qa'));
fs.mkdirSync(out, { recursive: true });
const wait = (ms) => `await new Promise(r=>setTimeout(r,${ms}));`;
const view = (dist, pitch, hour) => `(async()=>{window.__cidade.game.view(177,711,35,${pitch},${dist},${hour});${wait(4500)}})()`;
const follow = (dist, pitch, hour) => `(async()=>{const g=window.__cidade.game;await g.view(177,711,35,8,20,${hour});${wait(3000)}g.hudActions.follow();${wait(1200)}g.rig.dist=${dist};g.rig.pitch=${pitch}*Math.PI/180;${wait(2200)}})()`;
const seq = [
  [path.join(out, '01-carro-20m-dia.png'), view(20, 8, 11)],
  [path.join(out, '02-carro-100m-dia.png'), view(100, 18, 11)],
  [path.join(out, '03-carro-500m-dia.png'), view(500, 28, 11)],
  [path.join(out, '04-carro-20m-noite.png'), view(20, 8, 21)],
  [path.join(out, '05-carro-100m-noite.png'), view(100, 18, 21)],
  [path.join(out, '06-carro-500m-noite.png'), view(500, 28, 21)],
  [path.join(out, '07-seguir-20m.png'), follow(20, 10, 11)],
  [path.join(out, '08-seguir-100m.png'), follow(100, 10, 11)],
  [path.join(out, '09-seguir-500m.png'), follow(500, 10, 11)],
];
const env = { ...process.env, CIDADE_W: '1920', CIDADE_H: '1080', CIDADE_SEQ: JSON.stringify(seq) };
delete env.ELECTRON_RUN_AS_NODE;
const p = spawn(process.execPath, [
  path.join(root, 'tools', 'shot.mjs'), path.join(out, '01-carro-20m-dia.png'),
  '?cidade&mapa=10&limpo&hora=11&cam=177,711,35,8,20',
], { cwd: root, env, stdio: 'inherit' });
p.on('exit', (code) => process.exit(code ?? 0));

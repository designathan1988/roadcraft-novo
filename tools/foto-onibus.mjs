// Evidence of buses at a crossing: a line is added near the camera, then several frames follow it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(root, 'test-results', 'onibus'));
fs.mkdirSync(out, { recursive: true });
const wait = (ms) => `await new Promise(r=>setTimeout(r,${ms}));`;
const view = (x, z, ms) => `(async()=>{const g=window.__cidade.game;await g.view(${x},${z},35,14,24,11);${wait(ms)}})()`;
const line = `(async()=>{const g=window.__cidade.game;g.api.line(0,[177,711,177,650,177,770],3);${wait(5000)}})()`;
const seq = [
  [path.join(out, '01-linha.png'), line],
  [path.join(out, '02-parada-a.png'), view(177, 650, 0)],
  [path.join(out, '03-parada-a-1s.png'), view(177, 650, 1000)],
  [path.join(out, '04-parada-b.png'), view(177, 770, 0)],
  [path.join(out, '05-parada-b-1s.png'), view(177, 770, 1000)],
  [path.join(out, '06-centro.png'), view(177, 711, 0)],
];
const env = { ...process.env, CIDADE_W: '1920', CIDADE_H: '1080' };
delete env.ELECTRON_RUN_AS_NODE;
const p = spawn(process.execPath, [
  path.join(root, 'tools', 'shot.mjs'), path.join(out, '01-linha.png'),
  '?cidade&mapa=10&limpo&hora=11&cam=177,711,35,14,28',
  line,
], { cwd: root, env: { ...env, CIDADE_SEQ: JSON.stringify(seq.slice(1)) }, stdio: 'inherit' });
p.on('exit', (code) => process.exit(code ?? 0));

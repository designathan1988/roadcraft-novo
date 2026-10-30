// One evidence photo following a vehicle: the cabin glass and its occupants at close range.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(root, 'test-results', 'seguir-carro'));
fs.mkdirSync(out, { recursive: true });
const wait = (ms) => `await new Promise(r=>setTimeout(r,${ms}));`;
const script = `(async()=>{const g=window.__cidade.game;await g.view(177,711,35,12,20,11);${wait(3500)}g.hudActions.follow();${wait(2500)}})()`;
const env = { ...process.env, CIDADE_W: '1920', CIDADE_H: '1080' };
delete env.ELECTRON_RUN_AS_NODE;
const p = spawn(process.execPath, [
  path.join(root, 'tools', 'shot.mjs'), path.join(out, '01-seguindo.png'),
  '?cidade&mapa=10&limpo&hora=11&cam=177,711,35,12,20', script,
], { cwd: root, env, stdio: 'inherit' });
p.on('exit', (code) => process.exit(code ?? 0));

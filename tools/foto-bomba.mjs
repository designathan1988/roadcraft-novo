// Evidence of a bomb on a real building: before, the first frames, the interior/falling floors, and the rubble.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(root, 'test-results', 'bomba-real'));
fs.mkdirSync(out, { recursive: true });
const wait = (ms) => `await new Promise(r=>setTimeout(r,${ms}));`;
const find = `const g=window.__cidade.game,c=g.world.buildings.cols;let id=-1;for(let i=0;i<g.world.buildings.end;i++)if(g.world.buildings.alive[i]&&c.floors[i]>=4){id=i;break;}if(id<0)throw new Error('no building');window.__bomb={x:c.x[id],z:c.z[id]};`;
const first = `(async()=>{${find}const b=window.__bomb;await g.view(b.x,b.z,35,15,32,11);${wait(4000)}})()`;
const boom = (ms) => `(async()=>{const g=window.__cidade.game,b=window.__bomb;g.api.bomb(b.x,b.z);${wait(ms)}})()`;
const settle = (ms) => `(async()=>{${wait(ms)}})()`;
const seq = [
  [path.join(out, '02-explosao-0ms.png'), boom(70)],
  [path.join(out, '03-explosao-250ms.png'), settle(180)],
  [path.join(out, '04-explosao-900ms.png'), settle(650)],
  [path.join(out, '05-interior-e-queda.png'), settle(900)],
  [path.join(out, '06-depois.png'), settle(1700)],
];
const env = { ...process.env, CIDADE_W: '1280', CIDADE_H: '720', CIDADE_SEQ: JSON.stringify(seq) };
delete env.ELECTRON_RUN_AS_NODE;
const p = spawn(process.execPath, [
  path.join(root, 'tools', 'shot.mjs'), path.join(out, '01-antes.png'),
  '?cidade&mapa=4&seed=123456789&limpo&hora=11&cam=177,711,35,15,32', first,
], { cwd: root, env, stdio: 'inherit' });
p.on('exit', (code) => process.exit(code ?? 0));

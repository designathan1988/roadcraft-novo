// Bus-curve QA on an empty map: a square of roads, a short line whose last leg turns 90° at the corner, and a fixed
// camera on that corner. No follow lag and no city traffic: the frames show the body through the bend.
// Usage: node tools/fotos-onibus-curva.mjs [folder]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(root, 'test-results', 'onibus-curva'));
fs.mkdirSync(out, { recursive: true });
const wait = (ms) => `await new Promise(r=>setTimeout(r,${ms}));`;
const build = `(async()=>{const g=window.__cidade.game;
  const segs=[[1500,1500,1700,1500],[1700,1500,1700,1700],[1700,1700,1500,1700],[1500,1700,1500,1500]];
  const made=segs.map(([ax,az,bx,bz])=>g.api.road(ax,az,bx,bz));
  console.log('ROADS '+made.join(','));
  // the line runs east along the south side, then north at the corner: the last leg is the 90° turn
  g.api.line(0,[1550,1500,1650,1500,1700,1550],3);
  await g.view(1700,1500,35,30,75,11);
  ${wait(1500)}
})()`;
const tick = `(async()=>{${wait(1500)}})()`;
const seq = []; // photo 01 (with the build script) is the main shot
for (let i = 2; i <= 30; i++) seq.push([path.join(out, `${String(i).padStart(2, '0')}-quadro.png`), tick]);
const env = { ...process.env, CIDADE_W: '1920', CIDADE_H: '1080', CIDADE_SEQ: JSON.stringify(seq) };
delete env.ELECTRON_RUN_AS_NODE;
const p = spawn(process.execPath, [
  path.join(root, 'tools', 'shot.mjs'), path.join(out, '01-quadra-fixa.png'),
  '?vazio&hora=11&cam=1700,1500,35,30,75', build,
], { cwd: root, env, stdio: 'inherit' });
p.on('exit', (code) => process.exit(code ?? 0));

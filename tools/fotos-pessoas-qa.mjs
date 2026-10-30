// People QA photos: a group placed by the game's own creator, seen at 2/20/100 m by day and at 2/20 m at night.
// The point is the whole body, clothes/hair and shadow, with no hole or transparency. Usage: node tools/fotos-pessoas-qa.mjs [folder]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(root, 'test-results', 'pessoas-qa'));
fs.mkdirSync(out, { recursive: true });
const wait = (ms) => `await new Promise(r=>setTimeout(r,${ms}));`;
const ready = `for(let k=0;k<150&&!g.vehicles.people.ready;k++)${wait(200)}`;
const place = `(async()=>{const g=window.__cidade.game;${ready}g.api.people(177,711,{count:8,mode:'group',mixed:true});g.api.people(183,711,{count:4,mode:'walk',mixed:true,hold:'phone'});${wait(1200)}})()`;
const view = (dist, pitch, hour) => `(async()=>{const g=window.__cidade.game;await g.view(177,711,35,${pitch},${dist},${hour});${wait(2500)}})()`;
const seq = [
  [path.join(out, '01-pessoas-2m-dia.png'), view(2, 4, 11)],
  [path.join(out, '02-pessoas-20m-dia.png'), view(20, 10, 11)],
  [path.join(out, '03-pessoas-100m-dia.png'), view(100, 18, 11)],
  [path.join(out, '04-pessoas-2m-noite.png'), view(2, 4, 21)],
  [path.join(out, '05-pessoas-20m-noite.png'), view(20, 10, 21)],
];
const env = { ...process.env, CIDADE_W: '1920', CIDADE_H: '1080', CIDADE_SEQ: JSON.stringify(seq) };
delete env.ELECTRON_RUN_AS_NODE;
const p = spawn(process.execPath, [
  path.join(root, 'tools', 'shot.mjs'), path.join(out, '01-pessoas-2m-dia.png'),
  '?cidade&mapa=10&limpo&hora=11&cam=177,711,35,4,2', place,
], { cwd: root, env, stdio: 'inherit' });
p.on('exit', (code) => process.exit(code ?? 0));

// A survey of the generated city: several junctions, angles and distances, day and night. Each image is named for
// what it is meant to judge (cars close/mid, street, buildings, river, whole city). Usage: node tools/fotos-survey.mjs [folder]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(root, 'test-results', 'survey'));
fs.mkdirSync(out, { recursive: true });
const wait = (ms) => `await new Promise(r=>setTimeout(r,${ms}));`;
const view = (x, z, yaw, pitch, dist, hour, ms) => `(async()=>{window.__cidade.game.view(${x},${z},${yaw},${pitch},${dist},${hour});${wait(ms)}})()`;
const a = [177, 711], b = [57, 591], c = [297, 831];
const seq = [
  [path.join(out, '01-carro-a-perto-dia.png'), view(...a, 35, 8, 12, 11, 4500)],
  [path.join(out, '02-carro-a-medio-dia.png'), view(...a, 215, 12, 35, 11, 4500)],
  [path.join(out, '03-carro-a-lado-dia.png'), view(...a, 125, 10, 18, 11, 4500)],
  [path.join(out, '04-carro-b-perto-dia.png'), view(...b, 35, 8, 14, 11, 4500)],
  [path.join(out, '05-carro-b-medio-dia.png'), view(...b, 215, 14, 40, 11, 4500)],
  [path.join(out, '06-carro-c-perto-dia.png'), view(...c, 35, 9, 12, 11, 4500)],
  [path.join(out, '07-carro-c-medio-noite.png'), view(...c, 215, 12, 30, 21, 4500)],
  [path.join(out, '08-rua-b-noite.png'), view(...b, 125, 16, 55, 21, 4500)],
  [path.join(out, '09-predios-a-120m.png'), view(...a, 35, 34, 120, 11, 5000)],
  [path.join(out, '10-predios-b-220m.png'), view(...b, 215, 40, 220, 11, 5000)],
  [path.join(out, '11-bairro-c-400m.png'), view(...c, 35, 48, 400, 11, 6000)],
  [path.join(out, '12-rio-perto.png'), view(0, 0, 35, 20, 450, 11, 5000)],
  [path.join(out, '13-rio-longe-noite.png'), view(0, 0, 215, 40, 900, 21, 6000)],
  [path.join(out, '14-cidade-dia.png'), view(0, 0, 35, 45, 2200, 11, 8000)],
  [path.join(out, '15-cidade-noite.png'), view(0, 0, 215, 45, 2200, 21, 8000)],
];
const env = { ...process.env, CIDADE_W: '1920', CIDADE_H: '1080', CIDADE_SEQ: JSON.stringify(seq) };
delete env.ELECTRON_RUN_AS_NODE;
const p = spawn(process.execPath, [
  path.join(root, 'tools', 'shot.mjs'), path.join(out, '01-carro-a-perto-dia.png'),
  `?cidade&mapa=10&limpo&hora=11&cam=${a[0]},${a[1]},35,8,12`,
], { cwd: root, env, stdio: 'inherit' });
p.on('exit', (code) => process.exit(code ?? 0));

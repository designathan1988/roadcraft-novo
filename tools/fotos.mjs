// Standard game screenshots with the machine's GPU: street, district, city and night, in the generated 10 km city.
// Usage: node tools/fotos.mjs [output-folder]   (runs over dist/: npm run build first)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VIEWS, viewScript } from './photos/views.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(root, 'test-results', 'fotos'));
// Electron cannot write a photo into a folder that does not exist (the run used to hang there)
fs.mkdirSync(out, { recursive: true });
const wait = (ms) => `await new Promise(r=>setTimeout(r,${ms}));`;
// the standard views (tools/photos/views.mjs, the same as tools/budget.mjs): street and night look along the street
// nearest the map's centre, found in the generated network
const byName = Object.fromEntries(VIEWS.map((v) => [v.name, v]));
const shots = [['01-rua', 'street', 6000], ['02-bairro', 'district', 6000], ['03-cidade', 'city', 8000], ['04-noite', 'night', 6000]]
  .map(([file, name, ms]) => [path.join(out, `${file}.png`), viewScript(byName[name], { after: wait(ms) })]);
const seq = shots.slice(1);
const env = {
  ...process.env,
  CIDADE_W: '1920', CIDADE_H: '1080',
  CIDADE_SEQ: JSON.stringify(seq),
};
delete env.ELECTRON_RUN_AS_NODE;
const p = spawn(process.execPath, [
  path.join(root, 'tools', 'shot.mjs'),
  shots[0][0],
  '?cidade&mapa=10&limpo&hora=11', shots[0][1],
], { cwd: root, env, stdio: 'inherit' });
p.on('exit', (code) => process.exit(code ?? 0));

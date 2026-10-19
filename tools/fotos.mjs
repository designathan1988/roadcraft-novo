// Standard game screenshots with the machine's GPU: street, district, city and night, in the generated 10 km city.
// Usage: node tools/fotos.mjs [output-folder]   (runs over dist/: npm run build first)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(root, 'test-results', 'fotos'));
// Electron cannot write a photo into a folder that does not exist (the run used to hang there)
fs.mkdirSync(out, { recursive: true });
const c = 0; // the map is centered at (0, 0); angles in degrees
// street and night: a commercial avenue crossing (the centre of the generated map is the river)
const street = [177, 711];
const wait = (ms) => `await new Promise(r=>setTimeout(r,${ms}));`;
const view = (yaw, pitch, dist, hora, ms, [x, z] = [c, c]) => `(async()=>{window.__cidade.game.view(${x},${z},${yaw},${pitch},${dist},${hora});${wait(ms)}})()`;
const seq = [
  [path.join(out, '02-bairro.png'), view(35, 50, 420, 11, 6000)],
  [path.join(out, '03-cidade.png'), view(35, 45, 2200, 11, 8000)],
  [path.join(out, '04-noite.png'), view(35, 18, 90, 21, 6000, street)],
];
const env = {
  ...process.env,
  CIDADE_W: '1920', CIDADE_H: '1080',
  CIDADE_SEQ: JSON.stringify(seq),
};
delete env.ELECTRON_RUN_AS_NODE;
const p = spawn(process.execPath, [
  path.join(root, 'tools', 'shot.mjs'),
  path.join(out, '01-rua.png'),
  `?cidade&mapa=10&limpo&hora=11&cam=${street[0]},${street[1]},35,18,90`,
], { cwd: root, env, stdio: 'inherit' });
p.on('exit', (code) => process.exit(code ?? 0));

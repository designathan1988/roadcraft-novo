// Fotos padrão do jogo com a GPU da máquina: rua, bairro, cidade e noite, na cidade gerada de 10 km.
// Uso: node tools/fotos.mjs [pasta-de-saída]   (roda sobre dist/: npm run build antes)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(root, 'test-results', 'fotos'));
const c = 5120; // centro do mapa de 10 km
const wait = (ms) => `await new Promise(r=>setTimeout(r,${ms}));`;
const view = (yaw, pitch, dist, hora, ms) => `(async()=>{game.view(${c},${c},${yaw},${pitch},${dist},${hora});${wait(ms)}})()`;
const seq = [
  [path.join(out, '02-bairro.png'), view(0.6, 0.9, 420, 11, 6000)],
  [path.join(out, '03-cidade.png'), view(0.6, 0.75, 2200, 11, 8000)],
  [path.join(out, '04-noite.png'), view(0.6, 0.35, 90, 21, 6000)],
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
  `?cidade&mapa=10&limpo&hora=11&cam=${c},${c},0.6,0.35,90`,
], { cwd: root, env, stdio: 'inherit' });
p.on('exit', (code) => process.exit(code ?? 0));

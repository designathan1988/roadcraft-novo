// Foto do jogo com a GPU da máquina (Windows ou Linux com tela), sem Xvfb.
// Uso: node tools/shot.mjs /abs/foto.png "?cam=x,z,yaw,pitch,dist&hora=11" ["<script js>"]
// Mais fotos na mesma sessão: CIDADE_SEQ='[["/abs/b.png","<js>"]]'. Roda sobre dist/ (npm run build antes).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [shot, query = '', script = ''] = process.argv.slice(2);
if (!shot) { console.error('uso: node tools/shot.mjs /abs/foto.png "?query" ["script"]'); process.exit(2); }
const exe = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const env = {
  ...process.env, CIDADE_SHOT: path.resolve(shot), CIDADE_QUERY: query, CIDADE_SCRIPT: script,
  CIDADE_W: process.env.CIDADE_W ?? '1600', CIDADE_H: process.env.CIDADE_H ?? '900',
};
delete env.ELECTRON_RUN_AS_NODE;
const p = spawn(exe, ['.'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
const keep = /página|estado|foto|script|erro|Error|diferença/;
const skip = /Security|unsafe-eval|electronjs|once the app|experimental on this/;
for (const s of [p.stdout, p.stderr]) {
  let buf = '';
  s.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (keep.test(line) && !skip.test(line)) console.log(line);
    }
  });
}
const limit = setTimeout(() => { console.log('tempo esgotado'); p.kill(); }, Number(process.env.CIDADE_LIMIT ?? 600) * 1000);
p.on('exit', (c) => { clearTimeout(limit); process.exit(c ?? 0); });

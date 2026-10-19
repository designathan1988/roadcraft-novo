// Game screenshot with the machine's GPU (Windows or Linux with a display), without Xvfb.
// Usage: node tools/shot.mjs /abs/photo.png "?cam=x,z,yaw,pitch,dist&hora=11" ["<script js>"]
// More screenshots in the same session: CIDADE_SEQ='[["/abs/b.png","<js>"]]'. Runs over dist/ (npm run build first).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [shot, query = '', script = ''] = process.argv.slice(2);
if (!shot) { console.error('usage: node tools/shot.mjs /abs/photo.png "?query" ["script"]'); process.exit(2); }
const exe = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const env = {
  ...process.env, CIDADE_SHOT: path.resolve(shot), CIDADE_QUERY: query, CIDADE_SCRIPT: script,
  CIDADE_W: process.env.CIDADE_W ?? '1600', CIDADE_H: process.env.CIDADE_H ?? '900',
};
delete env.ELECTRON_RUN_AS_NODE;
const p = spawn(exe, ['.'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
const keep = /\[page\]|state:|photo:|script|error|Error|diff:|userData:/;
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
const limit = setTimeout(() => { console.log('timed out'); p.kill(); }, Number(process.env.CIDADE_LIMIT ?? 600) * 1000);
p.on('exit', (c) => { clearTimeout(limit); process.exit(c ?? 0); });

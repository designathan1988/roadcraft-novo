// Game screenshot with the machine's GPU (Windows or Linux with a display), without Xvfb.
// Usage: node tools/shot.mjs /abs/photo.png "?cam=x,z,yaw,pitch,dist&hour=11" ["<script js>"]
// More screenshots in the same session: ROADCRAFT_SEQ='[["/abs/b.png","<js>"]]'. Runs over dist/ (npm run build first).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keepGpuCache, seedGpuCache } from './checks/gpuCache.mjs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [shot, query = '', arg = ''] = process.argv.slice(2);
// '@file': the script read from a file (a command line holds 32 KB on Windows; the shared check sessions are longer)
const script = arg.startsWith('@') ? fs.readFileSync(arg.slice(1), 'utf8') : arg;
if (!shot) { console.error('usage: node tools/shot.mjs /abs/photo.png "?query" ["script"]'); process.exit(2); }
const exe = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
// the run's own user data folder (its saves; a fresh one in the temp folder unless given), warm with the shared GPU caches
const given = process.env.ROADCRAFT_USER_DATA;
const own = given ?? fs.mkdtempSync(path.join(os.tmpdir(), 'roadcraft-shot-'));
const gpuCache = process.env.ROADCRAFT_GPU_CACHE ?? path.join(root, 'test-results', 'gpu-cache');
seedGpuCache(own, gpuCache);
// the script goes to the game in a file of the run's folder
const scriptFile = path.join(own, 'run-script.js');
fs.writeFileSync(scriptFile, script);
const env = {
  ...process.env, ROADCRAFT_SHOT: path.resolve(shot), ROADCRAFT_QUERY: query, ROADCRAFT_SCRIPT_FILE: scriptFile,
  ROADCRAFT_W: process.env.ROADCRAFT_W ?? '1600', ROADCRAFT_H: process.env.ROADCRAFT_H ?? '900',
  ROADCRAFT_USER_DATA: own,
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
// a run cut by the time limit (or ended by a signal) failed: it never exits 0
let timedOut = false;
const limit = setTimeout(() => { timedOut = true; console.log('timed out'); p.kill(); }, Number(process.env.ROADCRAFT_LIMIT ?? 600) * 1000);
p.on('exit', (c, signal) => {
  clearTimeout(limit);
  // the GPU process held the caches until now
  keepGpuCache(own, gpuCache);
  if (!given) fs.rmSync(own, { recursive: true, force: true, maxRetries: 3 });
  process.exit(timedOut ? 124 : c ?? (signal ? 1 : 0));
});

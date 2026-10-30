// Checks that screenshot/test runs never write into the game's own user data folder (where the player's saves live).
// Runs the game through tools/shot.mjs with a folder of its own, saves the map, and compares the game's folder before
// and after. Usage: npx vite build && node tools/check-user-data.mjs   (exits with code 1 on failure)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appData = process.platform === 'win32' ? process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
  : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.config');
const gameFolder = path.join(appData, 'Roadcraft');

/** Every file under a folder with its size and modification time. */
function listing(dir) {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const file = path.join(e.parentPath ?? e.path, e.name);
    try { const s = fs.statSync(file); out.set(file, `${s.size}:${s.mtimeMs}`); } catch { /* vanished while listing */ }
  }
  return out;
}

// the player's saves: real files in saves/ (and, from earlier versions, the browser storage in File System/)
const places = [path.join(gameFolder, 'saves'), path.join(gameFolder, 'File System')];
const listAll = () => new Map(places.flatMap((p) => [...listing(p)]));
const before = listAll();
const own = fs.mkdtempSync(path.join(os.tmpdir(), 'roadcraft-check-'));
const shot = path.join(own, 'shot.png');
const script = '(async()=>{const g=window.__cidade.game;await g.saving.save(false);console.log("script SAVED");})()';
const lines = await new Promise((resolve) => {
  const out = [];
  const p = spawn(process.execPath, [path.join(root, 'tools', 'shot.mjs'), shot, '?vazio&hora=11', script],
    { cwd: root, env: { ...process.env, CIDADE_USER_DATA: own, CIDADE_SETTLE: '2', CIDADE_LIMIT: '180' } });
  p.stdout.on('data', (d) => out.push(...String(d).split('\n')));
  p.on('exit', () => resolve(out));
});

const fails = [];
if (!lines.some((l) => l.includes(`userData: ${own}`))) fails.push(`the run did not use its own folder (${own})`);
if (!lines.some((l) => l.includes('script SAVED'))) fails.push('the run did not finish saving');
if (listing(path.join(own, 'saves', 'cidade-1')).size === 0) fails.push('nothing was saved in the run\'s own folder');
const after = listAll();
const changed = [...after].filter(([f, v]) => before.get(f) !== v).map(([f]) => f);
const removed = [...before.keys()].filter((f) => !after.has(f));
if (changed.length || removed.length) fails.push(`the game's folder changed: ${changed.length} files written, ${removed.length} removed (${places.join(', ')})`);
fs.rmSync(own, { recursive: true, force: true, maxRetries: 3 });

for (const f of fails) console.log(`FAILED ${f}`);
console.log(fails.length ? 'user data check: FAILED' : `user data check: ok (game folder untouched, ${before.size} files)`);
process.exit(fails.length ? 1 : 0);

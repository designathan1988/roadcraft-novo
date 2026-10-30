// Verification in the real game (the machine's GPU): runs the scripts in scripts/verification/ on an empty map,
// each in its own Electron session, and collects the results. Each script uses the same actions as the buttons and
// checks the effect on the world (roads, buildings, items, lines...) and that nothing reached the console as an error.
// Lines: "VERIFY OK|FAILED name: why", then "VERIFICATION…" at the end of a script.
// Usage: npx vite build && node tools/verificar.mjs   (exits with code 1 if anything fails)
// VERIFY_ONLY=text runs only the scripts whose name contains the text; VERIFY_LIMIT=seconds changes each one's limit.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'scripts', 'verification');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && (!process.env.VERIFY_ONLY || f.includes(process.env.VERIFY_ONLY))).sort();
const shot = path.join(os.tmpdir(), 'roadcraft-verification.png');
let ok = 0, bad = 0;
for (const f of files) {
  const script = fs.readFileSync(path.join(dir, f), 'utf8');
  const lines = await new Promise((resolve) => {
    const out = [];
    const p = spawn(process.execPath, [path.join(root, 'tools', 'shot.mjs'), shot, '?empty&hour=11&workers=3&cam=1500,1500,0,50,400', script],
      { cwd: root, env: { ...process.env, ROADCRAFT_SETTLE: '1', ROADCRAFT_LIMIT: process.env.VERIFY_LIMIT ?? '560' } });
    let buf = '';
    p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { out.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    p.on('exit', () => resolve(out));
  });
  const got = lines.filter((l) => l.includes('VERIFY ')).map((l) => l.slice(l.indexOf('VERIFY ') + 7));
  if (got.length === 0) { console.log(`${f}: the script did not run`); bad++; continue; }
  // without the final line the script hung or timed out: the last printed check says where
  if (!lines.some((l) => l.includes('VERIFICATION'))) got.push(`FAILED the script stopped after: ${got[got.length - 1] ?? '(nothing)'}`);
  const fails = got.filter((v) => v.startsWith('FAILED'));
  ok += got.length - fails.length; bad += fails.length;
  console.log(`${f}: ${got.length - fails.length} ok, ${fails.length} failed`);
  for (const v of fails) console.log('  ' + v);
}
console.log(`total: ${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);

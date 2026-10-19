// Verification in the real game (the machine's GPU): runs the scripts in scripts/verificacao/ on an empty map,
// each in its own Electron session, and collects the results. Each script uses the same actions as the buttons and
// checks the effect on the world (roads, buildings, items, lines...) and that nothing reached the console as an error.
// Usage: npx vite build && node tools/verificar.mjs   (exits with code 1 if anything fails)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'scripts', 'verificacao');
// VER_ONLY=text runs only the scripts whose name contains the text; VER_LIMIT=seconds changes each one's time limit
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && (!process.env.VER_ONLY || f.includes(process.env.VER_ONLY))).sort();
const shot = path.join(os.tmpdir(), 'cidade-verificacao.png');
let ok = 0, bad = 0;
for (const f of files) {
  const script = fs.readFileSync(path.join(dir, f), 'utf8');
  const lines = await new Promise((resolve) => {
    const out = [];
    const p = spawn(process.execPath, [path.join(root, 'tools', 'shot.mjs'), shot, '?vazio&hora=11&workers=3&cam=1500,1500,0,50,400', script],
      { cwd: root, env: { ...process.env, CIDADE_SETTLE: '1', CIDADE_LIMIT: process.env.VER_LIMIT ?? '560' } });
    let buf = '';
    p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { out.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    p.on('exit', () => resolve(out));
  });
  const ver = lines.filter((l) => l.includes('VER ')).map((l) => l.slice(l.indexOf('VER ') + 4));
  if (ver.length === 0) { console.log(`${f}: o roteiro não terminou`); bad++; continue; }
  // without the final line the script hung or timed out: the last printed check says where
  if (!lines.some((l) => l.includes('VERIFICAÇÃO'))) ver.push(`FALHOU o roteiro parou depois de: ${ver[ver.length - 1] ?? '(nada)'}`);
  const fails = ver.filter((v) => v.startsWith('FALHOU'));
  ok += ver.length - fails.length; bad += fails.length;
  console.log(`${f}: ${ver.length - fails.length} ok, ${fails.length} falhas`);
  for (const v of fails) console.log('  ' + v);
}
console.log(`total: ${ok} ok, ${bad} falhas`);
process.exit(bad ? 1 : 0);

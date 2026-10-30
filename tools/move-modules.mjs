// Moves source modules and rewrites every relative import that reaches them (src, test, tools), so a
// reorganization is one exact step. Usage: node tools/move-modules.mjs <from>=<to> [...] (paths from the repo root).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moves = new Map(process.argv.slice(2).map((a) => a.split('=').map((p) => path.resolve(root, p))));
if (!moves.size) { console.error('usage: node tools/move-modules.mjs <from>=<to> ...'); process.exit(1); }

const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'vendor') walk(p); } else if (/\.(ts|mjs|js)$/.test(e.name)) files.push(p); } };
for (const d of ['src', 'test', 'tools', 'scripts']) if (fs.existsSync(path.join(root, d))) walk(path.join(root, d));

const spec = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\2/g;
const rel = (fromFile, target) => { let r = path.relative(path.dirname(fromFile), target).split(path.sep).join('/'); return r.startsWith('.') ? r : './' + r; };
let changed = 0;
for (const file of files) {
  const now = moves.get(file) ?? file;
  const src = fs.readFileSync(file, 'utf8');
  const out = src.replace(spec, (m, lead, q, s) => {
    const target = path.resolve(path.dirname(file), s);
    const moved = moves.get(target) ?? target;
    if (moved === target && now === file) return m;
    return `${lead}${q}${rel(now, moved)}${q}`;
  });
  if (out !== src) { fs.writeFileSync(file, out); changed++; }
}
for (const [from, to] of moves) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  execFileSync('git', ['mv', from, to], { cwd: root });
}
console.log(`moved ${moves.size} module(s), rewrote imports in ${changed} file(s)`);

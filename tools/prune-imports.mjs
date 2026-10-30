// Removes the imports tsc reports as unused (TS6133 on an import specifier, TS6192 for a whole declaration), so a
// refactor that moves code out of a file leaves no dead import behind. Usage: node tools/prune-imports.mjs
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let out = '';
try { execSync('npx tsc --noEmit', { cwd: root, stdio: 'pipe' }); } catch (e) { out = String(e.stdout ?? ''); }
const hits = new Map();
for (const m of out.matchAll(/^(.+?)\((\d+),(\d+)\): error (TS6133|TS6192): (.*)$/gm)) {
  const [, file, line, , code, msg] = m;
  const list = hits.get(file) ?? []; hits.set(file, list);
  list.push({ line: Number(line), code, name: /'([^']+)'/.exec(msg)?.[1] });
}
const CR = String.fromCharCode(13);
let changed = 0;
for (const [file, list] of hits) {
  const p = path.resolve(root, file), lines = fs.readFileSync(p, 'utf8').split('\n');
  for (const h of list.sort((a, b) => b.line - a.line)) {
    const i = h.line - 1, raw = lines[i];
    const cr = raw.endsWith(CR) ? CR : '', l = cr ? raw.slice(0, -1) : raw;
    if (!/^import /.test(l)) continue; // only import lines: an unused local is a real finding, left for a person
    if (h.code === 'TS6192') { lines.splice(i, 1); changed++; continue; }
    const m = /^import (type )?\{([^}]*)\}( from .*)$/.exec(l);
    if (!m) continue;
    const names = m[2].split(',').map((x) => x.trim()).filter(Boolean).filter((x) => x.replace(/^type /, '').split(/\s+as\s+/).pop() !== h.name);
    if (names.length) lines[i] = `import ${m[1] ?? ''}{ ${names.join(', ')} }${m[3]}${cr}`;
    else lines.splice(i, 1);
    changed++;
  }
  fs.writeFileSync(p, lines.join('\n'));
}
console.log(`pruned ${changed} unused import(s)`);

// Splits one module into several files of a folder by line ranges, keeping it as the public entry (it re-exports
// every name it exported), so no import elsewhere changes. Each part gets the module's imports (relative paths moved
// one folder down) and imports from its sibling parts for the top-level names it uses; the module's own exports keep
// their `export`, the names a sibling needs get one. Run tools/prune-imports.mjs after it.
// Usage: node tools/split-module.mjs <module.ts> <folder> <name>:<firstLine>-<lastLine> [...]
import fs from 'node:fs';
import path from 'node:path';

const [modArg, dirArg, ...partsArg] = process.argv.slice(2);
const mod = path.resolve(modArg), dir = path.resolve(dirArg);
const lines = fs.readFileSync(mod, 'utf8').replace(/\r\n/g, '\n').split('\n');
const parts = partsArg.map((a) => { const [name, r] = a.split(':'); const [x, y] = r.split('-').map(Number); return { name, from: x, to: y }; });

// the module's import block: every line from the first import to the last one that ends an import
let lastImport = 0;
for (let i = 0; i < lines.length; i++) if (/^import /.test(lines[i]) || (lastImport && i === lastImport + 1 && /^\s/.test(lines[i]))) lastImport = i;
const imports = lines.slice(0, lastImport + 1).filter((l) => /^import /.test(l))
  .map((l) => l.replace(/from '(\.{1,2}\/[^']+)'/, (_, p) => `from '${path.relative(dir, path.resolve(path.dirname(mod), p)).split(path.sep).join('/').replace(/^(?!\.)/, './')}'`));

// top-level names each part defines
const defRe = /^(?:export\s+)?(?:async\s+)?(?:function\*?|class|const|let|type|interface|enum)\s+([A-Za-z_$][\w$]*)/;
const owner = new Map(), exported = new Set(), typeOnly = new Set();
for (const p of parts) for (let i = p.from - 1; i < p.to; i++) {
  const m = defRe.exec(lines[i]);
  if (!m) continue;
  owner.set(m[1], p.name);
  if (/^(?:export\s+)?(?:type|interface)\s/.test(lines[i])) typeOnly.add(m[1]);
  if (/^export /.test(lines[i])) exported.add(m[1]);
}
const needs = new Map(parts.map((p) => [p.name, new Set()]));
const ident = /[A-Za-z_$][\w$]*/g;
for (const p of parts) {
  // comments first (an apostrophe in one would open a "string"), then strings that stay on their line
  const body = lines.slice(p.from - 1, p.to).join('\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''");
  for (const m of body.matchAll(ident)) { const o = owner.get(m[0]); if (o && o !== p.name) needs.get(p.name).add(m[0]); }
}
const shared = new Set([...needs.values()].flatMap((s) => [...s]));
fs.mkdirSync(dir, { recursive: true });
for (const p of parts) {
  const body = lines.slice(p.from - 1, p.to).map((l) => {
    const m = defRe.exec(l);
    return m && shared.has(m[1]) && !/^export /.test(l) ? 'export ' + l : l;
  });
  const sib = new Map();
  for (const n of needs.get(p.name)) { const o = owner.get(n); if (!sib.has(o)) sib.set(o, []); sib.get(o).push(n); }
  const sibImports = [...sib].flatMap(([o, ns]) => {
    const values = ns.filter((n) => !typeOnly.has(n)).sort(), types = ns.filter((n) => typeOnly.has(n)).sort();
    return [values.length ? `import { ${values.join(', ')} } from './${o}.ts';` : '', types.length ? `import type { ${types.join(', ')} } from './${o}.ts';` : ''].filter(Boolean);
  });
  fs.writeFileSync(path.join(dir, `${p.name}.ts`), [...imports, ...sibImports, '', ...body].join('\n').replace(/\n{3,}/g, '\n\n') + '\n');
}
// the module becomes the folder's public entry
const NL = String.fromCharCode(10);
const head = lines.slice(0, lines.findIndex((l) => /^import /.test(l))).join('\n');
const reexports = parts.map((p) => {
  const names = [...owner].filter(([n, o]) => o === p.name && exported.has(n)).map(([n]) => n);
  const values = names.filter((n) => !typeOnly.has(n)).sort(), types = names.filter((n) => typeOnly.has(n)).sort(), from = `'./${path.basename(dir)}/${p.name}.ts'`;
  return [values.length ? `export { ${values.join(', ')} } from ${from};` : '', types.length ? `export type { ${types.join(', ')} } from ${from};` : ''].filter(Boolean).join(NL);
}).filter(Boolean);
fs.writeFileSync(mod, `${head.trimEnd()}\n// The public entry of ${path.basename(dir)}/: every name it exported, from the part that holds it.\n\n${reexports.join('\n')}\n`);
console.log(`split into ${parts.length} parts; ${shared.size} names shared between parts`);

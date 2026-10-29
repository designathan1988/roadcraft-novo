// Read-only architecture audit: file size, import graph, runtime/type cycles, fan-in/out and layer crossings.
// It does not modify the source. Output: test-results/architecture/audit.{json,md}.
// `--check <baseline.json>` fails when a new runtime cycle or boundary leak appears (for CI/commit gates).
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

const root = process.cwd();
const src = path.join(root, 'src');
const outDir = path.join(root, 'test-results', 'architecture');
const posix = (p) => p.split(path.sep).join('/');
const relOf = (abs) => posix(path.relative(root, abs));
const SHARED_FILES = new Set(['src/config.ts']);
const PLATFORM_FILES = new Set(['src/save.ts', 'src/saveFiles.ts', 'src/mapFile.ts', 'src/steam.ts', 'src/audio.ts']);
const APP_FILES = new Set(['src/game.ts', 'src/main.ts']);

function walk(dir, list = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, list);
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) list.push(abs);
  }
  return list;
}

const files = walk(src).sort();
const fileSet = new Set(files.map(relOf));
const data = new Map();

for (const abs of files) {
  const rel = relOf(abs);
  const text = fs.readFileSync(abs, 'utf8');
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports = new Map();
  const add = (spec, typeOnly) => {
    if (!spec || !spec.startsWith('.')) return;
    const dir = path.posix.dirname(rel);
    const base = path.posix.normalize(path.posix.join(dir, spec));
    const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`];
    if (base.endsWith('.js')) candidates.unshift(`${base.slice(0, -3)}.ts`);
    for (const c of candidates) if (fileSet.has(c)) { imports.set(c, (imports.get(c) ?? false) || !typeOnly); return; }
    imports.set(`${base} [unresolved]`, false);
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (spec && ts.isStringLiteral(spec)) add(spec.text, !!node.importClause?.isTypeOnly);
    } else if (ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (spec && ts.isStringLiteral(spec)) add(spec.text, !!node.isTypeOnly);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) add(arg.text, false);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  let exports = 0;
  for (const st of source.statements) {
    if (ts.isExportDeclaration(st) || ts.isExportAssignment(st) || (st.modifiers && st.modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))) exports++;
  }
  data.set(rel, {
    rel, bytes: Buffer.byteLength(text), lines: text.split('\n').length, exports,
    imports: [...imports].map(([to, value]) => ({ to, typeOnly: !value })).sort((a, b) => a.to.localeCompare(b.to)),
  });
}

const layerOf = (rel) => {
  const parts = rel.split('/');
  if (parts[0] !== 'src' || parts.length < 2) return 'other';
  if (parts[1] === 'shared') return 'shared';
  if (parts[1] === 'app') return 'app';
  if (parts.length === 2) return APP_FILES.has(rel) ? 'app' : PLATFORM_FILES.has(rel) ? 'platform' : SHARED_FILES.has(rel) ? 'shared' : 'app';
  const l = parts[1];
  return ['core', 'world', 'roads', 'jobs', 'sim', 'render', 'r40', 'ui', 'tools', 'features'].includes(l) ? l : 'other';
};

const edges = [];
const fanIn = new Map([...data.keys()].map((k) => [k, 0]));
for (const [rel, d] of data) {
  for (const imp of d.imports) {
    if (imp.to.endsWith(' [unresolved]') || !data.has(imp.to)) continue;
    edges.push({ from: rel, to: imp.to, typeOnly: imp.typeOnly, fromLayer: layerOf(rel), toLayer: layerOf(imp.to) });
    fanIn.set(imp.to, (fanIn.get(imp.to) ?? 0) + 1);
  }
}

function cyclesFor(includeTypeOnly) {
  const adj = new Map([...data.keys()].map((k) => [k, []]));
  for (const e of edges) if (includeTypeOnly || !e.typeOnly) adj.get(e.from).push(e.to);
  const index = new Map(), low = new Map(), onStack = new Set(), stack = [], sccs = [];
  let nextIndex = 0;
  function strong(v) {
    index.set(v, nextIndex); low.set(v, nextIndex); nextIndex++;
    stack.push(v); onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const comp = [];
      let w;
      do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1) sccs.push(comp.sort());
    }
  }
  for (const v of data.keys()) if (!index.has(v)) strong(v);
  return sccs.sort((a, b) => b.length - a.length);
}
const valueCycles = cyclesFor(false);
const allCycles = cyclesFor(true);
const typeOnlyCycles = allCycles.filter((c) => !valueCycles.some((v) => v.length === c.length && v.every((x, i) => x === c[i])));

const layerMatrix = new Map();
for (const e of edges) {
  if (e.fromLayer === e.toLayer) continue;
  const k = `${e.fromLayer}->${e.toLayer}`;
  const row = layerMatrix.get(k) ?? { from: e.fromLayer, to: e.toLayer, count: 0, value: 0, examples: [] };
  row.count++;
  if (!e.typeOnly) row.value++;
  if (row.examples.length < 3) row.examples.push(`${e.from} -> ${e.to}`);
  layerMatrix.set(k, row);
}

// Target boundary set. `world` and `roads` are peers in the domain layer (they call each other); `tools` is an
// application/UI layer above render and ui. Only value imports are checked.
const allowed = {
  shared: ['shared'],
  platform: ['core', 'shared', 'jobs', 'platform'],
  core: ['core', 'shared'],
  world: ['core', 'shared', 'world', 'roads'],
  roads: ['core', 'shared', 'world', 'roads'],
  jobs: ['core', 'shared', 'world', 'roads', 'jobs', 'r40'],
  sim: ['core', 'shared', 'world', 'roads', 'sim'],
  render: ['core', 'shared', 'world', 'roads', 'jobs', 'r40', 'render'],
  ui: ['core', 'shared', 'world', 'roads', 'sim', 'platform', 'ui'],
  tools: ['core', 'shared', 'world', 'roads', 'sim', 'render', 'ui', 'tools'],
  features: ['core', 'shared', 'world', 'roads', 'jobs', 'sim', 'render', 'r40', 'ui', 'features'],
  r40: ['core', 'shared', 'r40'],
  app: ['core', 'shared', 'platform', 'world', 'roads', 'jobs', 'sim', 'render', 'r40', 'ui', 'tools', 'features', 'app'],
};
const violations = [];
for (const e of edges) {
  if (e.typeOnly) continue;
  const allowedTo = allowed[e.fromLayer];
  if (allowedTo && !allowedTo.includes(e.toLayer) && e.fromLayer !== e.toLayer) violations.push({ ...e, rule: `${e.fromLayer} must not import ${e.toLayer}` });
}

const byBytes = [...data.values()].sort((a, b) => b.bytes - a.bytes);
const byFanIn = [...data.values()].sort((a, b) => (fanIn.get(b.rel) ?? 0) - (fanIn.get(a.rel) ?? 0));
const byFanOut = [...data.values()].sort((a, b) => b.imports.length - a.imports.length);
const totalBytes = byBytes.reduce((s, d) => s + d.bytes, 0);
const totalLines = byBytes.reduce((s, d) => s + d.lines, 0);
const over = (n) => byBytes.filter((d) => d.bytes >= n).length;

const summary = {
  files: data.size, bytes: totalBytes, lines: totalLines,
  over50k: over(50_000), over100k: over(100_000), over150k: over(150_000),
  edges: edges.length, typeOnlyEdges: edges.filter((e) => e.typeOnly).length,
  valueCycles: valueCycles.length, allCycles: allCycles.length, typeOnlyCycles: typeOnlyCycles.length,
  violations: violations.length,
  layers: [...new Set([...data.keys()].map(layerOf))].sort(),
};

fs.mkdirSync(outDir, { recursive: true });
const report = {
  summary,
  files: byBytes.slice(0, 80),
  valueCycles: valueCycles.slice(0, 30),
  allCycles: allCycles.slice(0, 30),
  layerMatrix: [...layerMatrix.values()].sort((a, b) => b.count - a.count),
  violations: violations.slice(0, 120),
  fanIn: byFanIn.slice(0, 40).map((d) => ({ rel: d.rel, fanIn: fanIn.get(d.rel), bytes: d.bytes })),
  fanOut: byFanOut.slice(0, 40).map((d) => ({ rel: d.rel, imports: d.imports.length, bytes: d.bytes })),
};
fs.writeFileSync(path.join(outDir, 'audit.json'), JSON.stringify(report, null, 2));

const md = [];
md.push('# Architecture audit', '');
md.push(`Files: **${summary.files}** · bytes: **${summary.bytes}** · lines: **${summary.lines}**`);
md.push(`Edges: **${summary.edges}** (${summary.typeOnlyEdges} type-only) · runtime cycles: **${summary.valueCycles}** · cycles including types: **${summary.allCycles}** · boundary leaks: **${summary.violations}**`);
md.push(`Files >=50 KB: **${summary.over50k}** · >=100 KB: **${summary.over100k}** · >=150 KB: **${summary.over150k}**`, '');
md.push('## Largest files', '', '| file | KB | lines | exports | imports | layer |', '|---|---:|---:|---:|---:|---|');
for (const d of byBytes.slice(0, 30)) md.push(`| ${d.rel} | ${(d.bytes / 1024).toFixed(1)} | ${d.lines} | ${d.exports} | ${d.imports.length} | ${layerOf(d.rel)} |`);
md.push('', '## Runtime cycles (value imports only)', '');
if (!valueCycles.length) md.push('No runtime cycles.');
else for (const [i, c] of valueCycles.slice(0, 15).entries()) md.push(`${i + 1}. (${c.length}) ${c.join(', ')}`);
md.push('', '## Cycles that include type-only imports', '');
if (!typeOnlyCycles.length) md.push('None beyond the runtime cycles.');
else for (const [i, c] of typeOnlyCycles.slice(0, 15).entries()) md.push(`${i + 1}. (${c.length}) ${c.join(', ')}`);
md.push('', '## Highest fan-in', '', '| file | fan-in | KB | layer |', '|---|---:|---:|---|');
for (const d of byFanIn.slice(0, 15)) md.push(`| ${d.rel} | ${fanIn.get(d.rel)} | ${(d.bytes / 1024).toFixed(1)} | ${layerOf(d.rel)} |`);
md.push('', '## Highest fan-out', '', '| file | imports | KB | layer |', '|---|---:|---:|---|');
for (const d of byFanOut.slice(0, 15)) md.push(`| ${d.rel} | ${d.imports.length} | ${(d.bytes / 1024).toFixed(1)} | ${layerOf(d.rel)} |`);
md.push('', '## Layer crossings (actual)', '', '| from | to | edges (value) | examples |', '|---|---|---:|---|');
for (const r of [...layerMatrix.values()].sort((a, b) => b.count - a.count)) md.push(`| ${r.from} | ${r.to} | ${r.count} (${r.value}) | ${r.examples.join('<br>')} |`);
md.push('', '## Boundary leaks (target rules, value imports only)', '');
if (!violations.length) md.push('No value-import leaks under the target rules.');
else for (const v of violations.slice(0, 80)) md.push(`- **${v.rule}**: \`${v.from}\` -> \`${v.to}\``);
md.push('', '_`shared` = config/steam/save/mapFile/audio; `app` = game/main. `world` and `roads` are peers in the domain layer. Rules are the target, not the current state._', '');
fs.writeFileSync(path.join(outDir, 'audit.md'), md.join('\n'));

console.log(JSON.stringify(summary, null, 2));
console.log(`\nWrote ${relOf(path.join(outDir, 'audit.json'))} and ${relOf(path.join(outDir, 'audit.md'))}`);
console.log('\nRuntime cycles: ' + (valueCycles.length ? valueCycles.map((c) => `(${c.length}) ${c.join(' ')}`).join('\n') : 'none'));
console.log('\nBoundary leaks (value):');
for (const v of violations.slice(0, 20)) console.log(`  ${v.fromLayer} -> ${v.toLayer}: ${v.from} -> ${v.to}`);

// Guardrail: fail on a new runtime cycle, a new value-import boundary leak, or a new file >= 50 KB.
const checkAt = process.argv.indexOf('--check');
if (checkAt >= 0) {
  const baselinePath = process.argv[checkAt + 1] ?? 'tools/arch-baseline.json';
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const baseCycles = new Set((baseline.valueCycles ?? []).map((c) => c.join('|')));
  const baseLeaks = new Set((baseline.violations ?? []).map((v) => `${v.from}->${v.to}`));
  const baseFiles = new Set((baseline.files ?? []).map((f) => f.rel));
  const newCycles = valueCycles.filter((c) => !baseCycles.has(c.join('|')));
  const newLeaks = violations.filter((v) => !baseLeaks.has(`${v.from}->${v.to}`));
  const newBig = byBytes.filter((d) => d.bytes >= 50_000 && !baseFiles.has(d.rel));
  if (!newCycles.length && !newLeaks.length && !newBig.length) {
    console.log(`\narch baseline OK (${baselinePath})`);
  } else {
    if (newCycles.length) console.error('\nNEW runtime cycles:\n' + newCycles.map((c) => `  ${c.join(' ')}`).join('\n'));
    if (newLeaks.length) console.error('\nNEW boundary leaks:\n' + newLeaks.map((v) => `  ${v.from} -> ${v.to}`).join('\n'));
    if (newBig.length) console.error('\nNEW files >=50 KB:\n' + newBig.map((d) => `  ${(d.bytes / 1024).toFixed(1)} KB  ${d.rel}`).join('\n'));
    process.exitCode = 1;
  }
}

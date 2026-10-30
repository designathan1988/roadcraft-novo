// State ownership gate (audit §13.8): every write to mutable state resolved with the TypeScript type checker to the
// declaration it writes, then the rules:
//  1. a World / road network / street items field or table column written outside its owner's file;
//  2. a module-level `let` outside a worker module;
//  3. a uniform read by save or interface code (a uniform is derived state, never a source);
// Report mode by default (prints, exits 0); --fail exits 1 when a rule finds anything not in the known list
// (tools/state-baseline.json), so the gate turns blocking once the owners exist (plan step P10).
// Usage: node tools/state-check.mjs [--fail] [--write-baseline]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (f) => path.relative(root, f).split(path.sep).join('/');
const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'vendor') walk(p); } else if (/\.ts$/.test(e.name) && !e.name.endsWith('.d.ts')) files.push(p); } };
walk(path.join(root, 'src'));
const program = ts.createProgram(files, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true, noEmit: true, strict: true, skipLibCheck: true, types: [], lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.webworker.d.ts'] });
const checker = program.getTypeChecker();
const ours = (sf) => sf && !sf.isDeclarationFile && rel(sf.fileName).startsWith('src/');
const at = (n) => { const sf = n.getSourceFile(); return `${rel(sf.fileName)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`; };

// owners: the World, the road network and the street items own their fields and tables (and the tables' columns)
const OWNED = { 'src/world/world.ts': 'World', 'src/roads/network.ts': 'RoadNetwork', 'src/world/items.ts': 'StreetItems' };
const SAVE_OR_UI = (f) => /^src\/(app\/(saveFlow|session|insertBoxes)|platform\/(save|saveFiles|mapFile|mapExtra)|ui\/)/.test(f) || f === 'src/jobs/storage.ts';
const WORKER = (f) => /(^|\/)worker\.ts$|Worker\.ts$/.test(f);
const CONTAINER = /^(Map|Set|Array|ReadonlyArray|Int8Array|Uint8Array|Uint8ClampedArray|Int16Array|Uint16Array|Int32Array|Uint32Array|Float32Array|Float64Array)$/;
const MUT = new Set(['set', 'delete', 'clear', 'push', 'pop', 'shift', 'unshift', 'splice', 'add', 'fill', 'sort', 'reverse', 'copyWithin', 'copy']);

const ownedDecls = new Map(); // declaration -> owner file
const uniforms = new Set();
const lets = [];
for (const sf of program.getSourceFiles()) {
  if (!ours(sf)) continue;
  const f = rel(sf.fileName);
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) {
      const init = d.initializer?.getText() ?? '';
      if ((st.declarationList.flags & ts.NodeFlags.Let) && !WORKER(f)) lets.push({ where: at(d), name: d.name.getText() });
      // uniforms, and the uniform-shaped { value } holders the renderer reads (render/scene.ts fogLevel)
      if (/^(\w+\.)?uniform(Array)?\(/.test(init) || (f.startsWith('src/render/') && /^\{\s*value:/.test(init))) uniforms.add(d);
      if (OWNED[f] && /Schema$/.test(d.name.getText()) && d.initializer && ts.isObjectLiteralExpression(d.initializer)) for (const p of d.initializer.properties) ownedDecls.set(p, f);
    }
    if (OWNED[f] && ts.isClassDeclaration(st) && st.name?.text === OWNED[f]) for (const m of st.members) if (ts.isPropertyDeclaration(m)) ownedDecls.set(m, f);
  }
}
const declOf = (e) => {
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) e = e.expression;
  if (ts.isElementAccessExpression(e)) return declOf(e.expression);
  const s = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(e) ? e.name : e);
  const sym = s && (s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s);
  for (const d of sym?.declarations ?? []) if (ownedDecls.has(d) || uniforms.has(d)) return d;
  return ts.isPropertyAccessExpression(e) ? declOf(e.expression) : null;
};
const outside = [], uniformReads = [];
for (const sf of program.getSourceFiles()) {
  if (!ours(sf)) continue;
  const f = rel(sf.fileName);
  ts.forEachChild(sf, function v(n) {
    let target = null;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) target = n.left;
    else if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(n.operator)) target = n.operand;
    // a mutating call writes when its target is a bare container; a call on an owner object (w.items.clear()) goes
    // through the owner
    else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && MUT.has(n.expression.name.text)
      && CONTAINER.test(checker.getTypeAtLocation(n.expression.expression).getSymbol()?.name ?? '')) target = n.expression.expression;
    if (target) { const d = declOf(target); if (d && ownedDecls.has(d) && ownedDecls.get(d) !== f) outside.push({ where: at(n), state: `${OWNED[ownedDecls.get(d)]}.${d.name.getText()}` }); }
    if (ts.isIdentifier(n) && SAVE_OR_UI(f)) { const s = checker.getSymbolAtLocation(n); const sym = s && (s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s); if (sym?.declarations?.some((d) => uniforms.has(d)) && !ts.isImportSpecifier(n.parent)) uniformReads.push({ where: at(n), uniform: n.text }); }
    ts.forEachChild(n, v);
  });
}
const found = {
  worldWritesOutsideOwner: outside.map((o) => `${o.state} @ ${o.where}`),
  moduleLetsOutsideWorkers: lets.map((l) => `${l.name} @ ${l.where}`),
  uniformsReadBySaveOrUi: uniformReads.map((u) => `${u.uniform} @ ${u.where}`),
};
const basePath = path.join(root, 'tools', 'state-baseline.json');
if (process.argv.includes('--write-baseline')) { fs.writeFileSync(basePath, JSON.stringify(found, null, 1) + '\n'); console.log('wrote', rel(basePath)); }
const base = fs.existsSync(basePath) ? JSON.parse(fs.readFileSync(basePath, 'utf8')) : {};
// a finding is new when its text (state and file, without the line) is not in the known list
const key = (s) => s.replace(/:\d+$/, '');
let fresh = 0;
for (const [rule, list] of Object.entries(found)) {
  const known = new Set((base[rule] ?? []).map(key));
  const added = list.filter((s) => !known.has(key(s)));
  fresh += added.length;
  console.log(`${rule}: ${list.length} (${added.length} new)`);
  for (const s of added) console.log('  NEW ' + s);
}
if (process.argv.includes('--fail') && fresh) process.exit(1);

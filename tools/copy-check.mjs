// Detects code copied from Roadcraft 4.0 (lab/roadcraft) into this repository, by three measures:
//  1. identical lines after normalisation (whitespace collapsed, comments dropped);
//  2. winnowed k-gram fingerprints of normalised tokens (identifiers, strings and numbers replaced by their kind, as
//     MOSS does), which survive renaming, reformatting and translated names (Schleimer, Wilkerson, Aiken, SIGMOD 2003);
//  3. whole files copied (most of a file's lines identical to one 4.0 file).
// It also lists shared rare constants and names, comments that cite 4.0, and the matched stretches (lines here and
// lines in 4.0). Read-only. Usage:
//   node tools/copy-check.mjs [--old ../roadcraft] [--json out.json] [--md out.md] [--fail-above PCT]
// --fail-above PCT exits 1 when any file has PCT % or more of its fingerprints matched in 4.0 (the proposed gate).
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const oldRoot = path.resolve(root, arg('--old', '../roadcraft'));
const K = Number(arg('--k', 20)), W = Number(arg('--w', 10)), COMMON = Number(arg('--common', 10)); // k-gram length (tokens), winnow window, fingerprints shared by more 4.0 places are boilerplate
const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const posix = (p) => p.split(path.sep).join('/');

function listNew() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = posix(path.join(dir, e.name));
      if (e.isDirectory()) { if (!/(^|\/)(node_modules|vendor|dist|test-results)$/.test(rel)) walk(rel); }
      else if (CODE.test(e.name) && !e.name.endsWith('.d.ts')) out.push(rel);
    }
  };
  for (const d of ['src', 'tools', 'scripts', 'data', 'test', 'electron']) if (fs.existsSync(path.join(root, d))) walk(d);
  for (const f of ['vite.config.ts']) if (fs.existsSync(path.join(root, f))) out.push(f);
  return out.sort();
}
function listOld() {
  let files;
  try { files = execSync('git ls-files', { cwd: oldRoot, maxBuffer: 1 << 28 }).toString().split('\n'); }
  catch { throw new Error(`cannot list ${oldRoot} (git ls-files)`); }
  return files.filter((f) => CODE.test(f) && !f.endsWith('.d.ts') && !/(^|\/)(node_modules|vendor|dist)\//.test(f)).sort();
}

const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard);
/** Tokens with their line; comments collected apart. */
function lex(text, jsx) {
  scanner.setLanguageVariant(jsx ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard);
  scanner.setText(text);
  const lineStarts = ts.computeLineStarts(text);
  const lineOf = (pos) => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (lineStarts[m] <= pos) lo = m; else hi = m - 1; } return lo + 1; };
  const toks = [], comments = [];
  for (let k = scanner.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = scanner.scan()) {
    if (k === ts.SyntaxKind.WhitespaceTrivia || k === ts.SyntaxKind.NewLineTrivia) continue;
    const pos = scanner.getTokenPos();
    if (k === ts.SyntaxKind.SingleLineCommentTrivia || k === ts.SyntaxKind.MultiLineCommentTrivia) { comments.push({ line: lineOf(pos), text: scanner.getTokenText() }); continue; }
    if (k === ts.SyntaxKind.SlashToken || k === ts.SyntaxKind.SlashEqualsToken) { const r = scanner.reScanSlashToken(); if (r === ts.SyntaxKind.RegularExpressionLiteral) k = r; }
    if (k === ts.SyntaxKind.CloseBraceToken) { /* template continuation is handled as plain tokens: good enough for fingerprints */ }
    toks.push({ k, t: scanner.getTokenText(), line: lineOf(pos) });
  }
  return { toks, comments };
}
const kindCode = (tok) => {
  if (tok.k === ts.SyntaxKind.Identifier || tok.k === ts.SyntaxKind.PrivateIdentifier) return 'I';
  if (tok.k === ts.SyntaxKind.StringLiteral || tok.k === ts.SyntaxKind.NoSubstitutionTemplateLiteral || tok.k >= ts.SyntaxKind.TemplateHead && tok.k <= ts.SyntaxKind.TemplateTail) return 'S';
  if (tok.k === ts.SyntaxKind.NumericLiteral || tok.k === ts.SyntaxKind.BigIntLiteral) return 'N';
  if (tok.k === ts.SyntaxKind.RegularExpressionLiteral) return 'R';
  return String(tok.k);
};
const exactCode = (tok) => (tok.k === ts.SyntaxKind.Identifier ? 'i:' + tok.t : kindCode(tok));
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
/** Winnowing (robust variant): the rightmost minimum hash of each window of W k-gram hashes. */
function winnow(codes, toks) {
  const hs = [];
  for (let i = 0; i + K <= codes.length; i++) hs.push(hashStr(codes.slice(i, i + K).join(' ')));
  const fps = [];
  let last = -1;
  for (let s = 0; s + W <= hs.length; s++) {
    let m = s;
    for (let j = s; j < s + W; j++) if (hs[j] <= hs[m]) m = j;
    if (m !== last) { fps.push({ h: hs[m], line: toks[m].line, end: toks[m + K - 1].line }); last = m; }
  }
  if (hs.length && hs.length < W) { let m = 0; for (let j = 0; j < hs.length; j++) if (hs[j] <= hs[m]) m = j; fps.push({ h: hs[m], line: toks[m].line, end: toks[m + K - 1].line }); }
  return fps;
}
/** Lines with code, normalised: comments removed, whitespace collapsed. */
function codeLines(text, comments) {
  const lines = text.split('\n');
  const commentLines = new Map();
  for (const c of comments) commentLines.set(c.line, true);
  return lines.map((l, i) => {
    let s = l.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '').replace(/\s+/g, ' ').trim();
    if (/^\*|^\/\*/.test(s)) s = '';
    return { n: i + 1, s };
  }).filter((x) => x.s.length >= 24 && !/^(import\b|export \{[^}]*\} from\b)/.test(x.s));
}
const RARE_NUM = (t) => { const v = Number(t); return Number.isFinite(v) && !/^0x/i.test(t) && (Math.abs(v) >= 100 || /\.\d{2,}/.test(t)) && ![100, 1000, 255, 256, 360, 1024, 4096, 65535, 65536].includes(Math.abs(v)); };
const CITE = /\b4\.0\b|roadcraft(?![\w-]*novo)|\bmain\.ts:\d+|\brenderer\.ts\b/i;

function analyse(rootDir, rel) {
  // line endings normalised: a CRLF checkout (core.autocrlf) and an LF archive of the same commit give the same result
  const text = fs.readFileSync(path.join(rootDir, rel), 'utf8').replace(/\r\n?/g, '\n');
  const { toks, comments } = lex(text, /\.(tsx|jsx)$/.test(rel));
  return {
    rel, text, toks, comments,
    lines: codeLines(text, comments),
    norm: winnow(toks.map(kindCode), toks),
    exact: winnow(toks.map(exactCode), toks),
    nums: new Set(toks.filter((t) => t.k === ts.SyntaxKind.NumericLiteral && RARE_NUM(t.t)).map((t) => t.t)),
    names: new Set(toks.filter((t) => t.k === ts.SyntaxKind.Identifier && t.t.length >= 9).map((t) => t.t)),
  };
}

const t0 = Date.now();
const newFiles = listNew(), oldFiles = listOld();
const olds = oldFiles.map((f) => analyse(oldRoot, f));
// indexes over 4.0
const lineIndex = new Map(); // normalised line -> Set(old file idx)
const normIndex = new Map(), exactIndex = new Map(); // fingerprint -> [{f, line}]
olds.forEach((o, fi) => {
  for (const l of o.lines) { let s = lineIndex.get(l.s); if (!s) lineIndex.set(l.s, s = new Set()); s.add(fi); }
  for (const [idx, list] of [[normIndex, o.norm], [exactIndex, o.exact]]) for (const fp of list) { let a = idx.get(fp.h); if (!a) idx.set(fp.h, a = []); if (a.length <= COMMON) a.push({ f: fi, line: fp.line, end: fp.end }); }
});
const usable = (idx, h) => { const a = idx.get(h); return a && a.length <= COMMON ? a : null; };

const results = [];
for (const rel of newFiles) {
  const n = analyse(root, rel);
  // 1. identical lines
  const perOldLines = new Map();
  let identical = 0;
  const identSet = new Set();
  for (const l of n.lines) {
    const s = lineIndex.get(l.s);
    if (!s) continue;
    identical++; identSet.add(l.n);
    for (const fi of s) perOldLines.set(fi, (perOldLines.get(fi) ?? 0) + 1);
  }
  let bestLines = -1, bestLinesN = 0;
  for (const [fi, c] of perOldLines) if (c > bestLinesN) { bestLines = fi; bestLinesN = c; }
  // 2. fingerprints
  const score = (fps, idx) => {
    const per = new Map(); let hit = 0;
    const hits = [];
    for (const fp of fps) {
      const a = usable(idx, fp.h); if (!a) continue;
      hit++;
      const seen = new Set();
      for (const p of a) { if (seen.has(p.f)) continue; seen.add(p.f); per.set(p.f, (per.get(p.f) ?? 0) + 1); hits.push({ fp, p }); }
    }
    let best = -1, bestN = 0; for (const [fi, c] of per) if (c > bestN) { best = fi; bestN = c; }
    return { hit, per, best, bestN, hits };
  };
  const ns = score(n.norm, normIndex), es = score(n.exact, exactIndex);
  // stretches against the best few 4.0 files (by normalised fingerprints)
  const stretches = [];
  const top = [...ns.per].sort((a, b) => b[1] - a[1]).slice(0, 5).filter(([, c]) => c >= 3);
  for (const [fi] of top) {
    const pts = ns.hits.filter((h) => h.p.f === fi).sort((a, b) => a.fp.line - b.fp.line);
    let cur = null;
    for (const h of pts) {
      if (cur && h.fp.line - cur.ne <= 4 && Math.abs(h.p.line - cur.oe) <= 12) { cur.ne = Math.max(cur.ne, h.fp.end); cur.oe = Math.max(cur.oe, h.p.end); cur.os = Math.min(cur.os, h.p.line); cur.c++; }
      else { if (cur && cur.c >= 3) stretches.push(cur); cur = { old: oldFiles[fi], ns: h.fp.line, ne: h.fp.end, os: h.p.line, oe: h.p.end, c: 1 }; }
    }
    if (cur && cur.c >= 3) stretches.push(cur);
  }
  for (const s of stretches) {
    let same = 0, tot = 0;
    for (const l of n.lines) if (l.n >= s.ns && l.n <= s.ne) { tot++; if (identSet.has(l.n)) same++; }
    s.identicalPct = tot ? Math.round(100 * same / tot) : 0;
  }
  const bo = ns.best >= 0 ? olds[ns.best] : null;
  const sharedNums = bo ? [...n.nums].filter((x) => bo.nums.has(x)) : [];
  const sharedNames = bo ? [...n.names].filter((x) => bo.names.has(x)) : [];
  const cites = n.comments.filter((c) => CITE.test(c.text)).map((c) => ({ line: c.line, text: c.text.replace(/\s+/g, ' ').slice(0, 140) }));
  const sig = n.lines.length;
  results.push({
    file: rel, codeLines: sig, identicalLines: identical, identicalPct: sig ? +(100 * identical / sig).toFixed(1) : 0,
    bestByLines: bestLines >= 0 ? oldFiles[bestLines] : null, bestByLinesPct: sig ? +(100 * bestLinesN / sig).toFixed(1) : 0,
    fingerprints: n.norm.length, normMatchedPct: n.norm.length ? +(100 * ns.hit / n.norm.length).toFixed(1) : 0,
    exactMatchedPct: n.exact.length ? +(100 * es.hit / n.exact.length).toFixed(1) : 0,
    bestOld: bo ? bo.rel : null, bestOldPct: n.norm.length ? +(100 * ns.bestN / n.norm.length).toFixed(1) : 0,
    wholeFile: sig >= 5 && bestLinesN / sig >= 0.9,
    stretches: stretches.sort((a, b) => a.ns - b.ns).map((s) => ({ here: `${s.ns}-${s.ne}`, old: `${s.old}:${s.os}-${s.oe}`, fingerprints: s.c, identicalPct: s.identicalPct })),
    sharedConstants: sharedNums.slice(0, 40), sharedConstantCount: sharedNums.length,
    sharedNames: sharedNames.slice(0, 40), sharedNameCount: sharedNames.length,
    cites,
  });
}

const sum = (rows, k) => rows.reduce((s, r) => s + r[k], 0);
const group = (pred) => { const rows = results.filter(pred); return { files: rows.length, codeLines: sum(rows, 'codeLines'), identicalLines: sum(rows, 'identicalLines'), wholeFiles: rows.filter((r) => r.wholeFile).length }; };
const summary = {
  base: root, old: oldRoot, newFiles: newFiles.length, oldFiles: oldFiles.length, k: K, w: W, guarantee: K + W - 1, commonCap: COMMON,
  seconds: +((Date.now() - t0) / 1000).toFixed(1),
  all: group(() => true), r40: group((r) => r.file.startsWith('src/r40/')), srcOutsideR40: group((r) => r.file.startsWith('src/') && !r.file.startsWith('src/r40/')),
  filesWithSimilarity: results.filter((r) => r.normMatchedPct > 0 || r.identicalLines > 0).length,
  filesCiting40: results.filter((r) => r.cites.length).length,
};
const jsonOut = arg('--json'), mdOut = arg('--md');
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ summary, results }, null, 1));
if (mdOut) {
  const md = ['# Copy check against Roadcraft 4.0', '', '```json', JSON.stringify(summary, null, 2), '```', '',
    '| file | code lines | identical | % | normalised fp % | exact fp % | best 4.0 file | % of fps | whole |', '|---|---:|---:|---:|---:|---:|---|---:|---|'];
  for (const r of [...results].sort((a, b) => b.normMatchedPct - a.normMatchedPct)) md.push(`| ${r.file} | ${r.codeLines} | ${r.identicalLines} | ${r.identicalPct} | ${r.normMatchedPct} | ${r.exactMatchedPct} | ${r.bestOld ?? ''} | ${r.bestOldPct} | ${r.wholeFile ? 'yes' : ''} |`);
  fs.writeFileSync(mdOut, md.join('\n'));
}
console.log(JSON.stringify(summary, null, 2));
const fail = arg('--fail-above');
if (fail !== undefined) {
  const bad = results.filter((r) => r.normMatchedPct >= Number(fail));
  if (bad.length) { console.error(`\n${bad.length} files with >= ${fail}% of fingerprints found in 4.0:\n` + bad.map((r) => `  ${r.normMatchedPct}%  ${r.file}  (${r.bestOld})`).join('\n')); process.exitCode = 1; }
}

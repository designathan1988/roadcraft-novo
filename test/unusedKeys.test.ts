/// <reference types="node" />
// The language tables hold no key the code cannot reach (P21: 1,039 keys copied from 4.0 or left behind went). A key is
// reached when a string literal in src, tools or test equals it, a dynamic prefix starts it (a template's head such as
// `zone.name.${z}`, or a literal ending in '.'), or it is a plural form (.one/.other) of a reached key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ENGINE_PT } from '../src/shared/i18n/lang/engine.pt-BR.ts';
import { ENGINE_EN } from '../src/shared/i18n/lang/engine.en.ts';
import { PT_BR } from '../data/textos-roadcraft/pt-BR.ts';
import { EN } from '../data/textos-roadcraft/en.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ts = createRequire(path.join(root, 'package.json'))('typescript');

test('every key of the language tables is reached by the code', () => {
  const literals = new Set<string>(), prefixes = new Set<string>();
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/i18n[\\/]lang$|node_modules/.test(p)) walk(p); continue; }
      if (!/\.(ts|mjs|js)$/.test(e.name) || e.name.endsWith('.d.ts')) continue;
      const sf = ts.createSourceFile(p, fs.readFileSync(p, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (n: any): void => {
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) { literals.add(n.text); if (/^[\w.]+\.$/.test(n.text)) prefixes.add(n.text); }
        else if (ts.isTemplateHead(n) && /^[\w.]+$/.test(n.text) && n.text.length >= 2) prefixes.add(n.text);
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
  };
  for (const d of ['src', 'tools', 'test']) walk(path.join(root, d));
  const pre = [...prefixes];
  const reached = (k: string): boolean => literals.has(k) || pre.some((p) => k.startsWith(p)) || (/\.(one|other)$/.test(k) && reached(k.replace(/\.(one|other)$/, '')));
  const keys = [...new Set([...Object.keys(ENGINE_PT), ...Object.keys(ENGINE_EN), ...Object.keys(PT_BR), ...Object.keys(EN)])];
  assert.ok(keys.length > 1000, `keys: ${keys.length}`);
  assert.deepEqual(keys.filter((k) => !reached(k)), []);
});

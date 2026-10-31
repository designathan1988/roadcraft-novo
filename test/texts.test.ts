/// <reference types="node" />
// Text the player reads lives only in the dictionaries (src/shared/i18n/lang/engine.*.ts, data/textos-roadcraft): the
// interface's files and game.ts must not write a sentence of their own (B57, B58 in DEFEITOS-roadcraft-novo.md).
// The scan reads the source: every string literal that looks like a phrase (two words or more, or Portuguese
// letters) is reported, except where the code names it as not for the player (comments, log lines, undo labels).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The interface's files (other areas own creator.ts, inspector.ts, roadCatalog.ts) and game.ts. */
const FILES = ['src/game.ts', 'src/main.ts', 'src/platform/audio.ts', 'src/platform/steam.ts',
  ...fs.readdirSync(path.join(root, 'src/ui')).filter((f) => f.endsWith('.ts') && !['creator.ts', 'inspector.ts', 'roadCatalog.ts', 'icons.ts', 'css.d.ts'].includes(f)).map((f) => `src/ui/${f}`)];
/** Lines whose strings are not for the player: logs, undo labels (B60), errors for developers, test hooks. */
const NOT_PLAYER = /console\.|label: '|label: `|new ItemsCommand\(|new RoadJournal\(|setClouds\(|phase\(|throw new Error|health\?\.add|this\.health\.(add|context)|return '|return `|\.context = /;
const PHRASE = /(['`])((?:(?!\1)[^\\]|\\.)*)\1/g;

function phrases(file: string): string[] {
  const out: string[] = [];
  const lines = fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/);
  lines.forEach((raw, i) => {
    // a line may say its strings are data, not text: "// not for the player"
    if (/\/\/ not for the player/.test(raw)) return;
    const line = raw.replace(/\/\/.*$/, '');
    if (/^\s*(\*|\/\*)/.test(raw) || NOT_PLAYER.test(line)) return;
    for (const m of line.matchAll(PHRASE)) {
      const s = m[2].replace(/\$\{[^}]*\}/g, '');
      if (/^[a-zA-Z0-9_.]+$/.test(s) || /^[\s\W\d]*$/.test(s)) continue; // keys, codes, symbols
      if (/[ãõçéêáíóúâôà]/i.test(s) || /\b[A-Za-z]{2,}\s+[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(s)) out.push(`${file}:${i + 1}: ${m[0].slice(0, 70)}`);
    }
  });
  return out;
}

test('B57/B58: the interface and game.ts write no phrase of their own (everything through the dictionaries)', () => {
  const found = FILES.flatMap(phrases).filter((p) => !/\b(data-|class=|<svg|<path|<i |<b |<img|style=|M\d)/.test(p));
  assert.deepEqual(found, [], `${found.length} phrases outside the dictionaries:\n${found.join('\n')}`);
});

test('B62: every action the interface declares is used by a button, a key, a panel or a check', () => {
  const hud = fs.readFileSync(path.join(root, 'src/ui/hud.ts'), 'utf8');
  const decl = hud.slice(hud.indexOf('export interface OptionalActions'), hud.indexOf('type PopId'));
  const names = [...decl.matchAll(/^\s+([a-zA-Z]+)\??\(/gm)].map((m) => m[1]);
  const users = ['src/ui', 'src/app', 'scripts/verification', 'tools'].flatMap((d) => fs.readdirSync(path.join(root, d)).filter((f) => /\.(ts|js|mjs)$/.test(f)).map((f) => fs.readFileSync(path.join(root, d, f), 'utf8'))).join('\n')
    + fs.readFileSync(path.join(root, 'src/game.ts'), 'utf8').replace(/this\.hud = new Hud\([\s\S]*?satisfies HudActions\)\);/, '');
  const unused = names.filter((n) => !new RegExp(`\\b(a|h\\.a|this\\.a|A|H|hudActions)\\.${n}\\b|\\b${n}\\?\\.\\(`).test(users));
  assert.deepEqual(unused, [], `actions nobody calls: ${unused.join(', ')}`);
  const hudClass = hud.slice(hud.indexOf('export class Hud'));
  const methods = [...hudClass.matchAll(/^ {2}([a-z][a-zA-Z]+)\([^)]*\): void \{/gm)].map((m) => m[1]);
  const game = fs.readFileSync(path.join(root, 'src/game.ts'), 'utf8') + users;
  const dead = methods.filter((m) => !new RegExp(`(hud|this)\\.${m}\\(`).test(game));
  assert.deepEqual(dead, [], `interface methods nobody calls: ${dead.join(', ')}`);
});

test('D5: no text left says demolishing refunds half (the refund is what the tuning says, 25% as Roadcraft 4.0)', async () => {
  const { ROAD_TUNING } = await import('../src/roads/tuning.ts');
  if ((ROAD_TUNING.economy.demolitionRefund as number) === 0.5) return;
  // every language table the player reads (the legacy phrase table is gone: nothing in src writes Portuguese now)
  const tables = await Promise.all(['../src/shared/i18n/lang/engine.pt-BR.ts', '../src/shared/i18n/lang/engine.en.ts', '../data/textos-roadcraft/pt-BR.ts', '../data/textos-roadcraft/en.ts'].map((f) => import(f)));
  const all = tables.flatMap((m) => Object.values(m).flatMap((t) => Object.entries(t as Record<string, string>)));
  assert.ok(all.length > 1000, `texts read: ${all.length}`);
  const wrong = all.filter(([k, v]) => /devolv|refund/i.test(k + v) && /metade|\bhalf\b/i.test(v));
  assert.deepEqual(wrong, []);
});

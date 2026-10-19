/// <reference types="node" />
// Text the player reads lives only in the dictionaries (src/ui/lang/engine.*.ts, data/textos-roadcraft): the
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
const FILES = ['src/game.ts', 'src/main.ts', 'src/audio.ts', 'src/steam.ts',
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

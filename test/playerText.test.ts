/// <reference types="node" />
// What the player reads comes from the language files (src/shared/i18n/lang), never from a Portuguese literal in the
// code: the files listed here are migrated, and none may hold one again. Not counted: the labels of commands (the
// second argument of new RoadJournal / new ItemsCommand), internal names that still pick the command's sound
// (game.ts onPush: open, to be replaced by a kind on the command).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ENGINE_PT } from '../src/shared/i18n/lang/engine.pt-BR.ts';
import { setLang, t } from '../src/shared/i18n/index.ts';
import { polygonLot } from '../src/world/lotEdit.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ts = createRequire(path.join(root, 'package.json'))('typescript');

const MIGRATED = [
  'src/features/roads/roadTool.ts', 'src/features/streetscape/itemTool.ts', 'src/features/zones/zoneTool.ts',
  'src/roads/construction/plan.ts', 'src/roads/construction/segmentEdits.ts', 'src/roads/signRule.ts',
  'src/world/lotEdit.ts',
];
const PT_VALUES = new Set(Object.values(ENGINE_PT));
const ACCENT = /[ãõçáéíóúâêôàÃÕÇÁÉÍÓÚÂÊÔ]/;
const WORDS = /\b(demais|nenhum|nenhuma|para o|para a|do lote|da via|Clique|Arraste|Solte)\b/;

function portuguese(file: string): string[] {
  const s = fs.readFileSync(path.join(root, file), 'utf8');
  const sf = ts.createSourceFile(file, s, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  // a command's label: the 2nd argument of new RoadJournal / ItemsCommand, the 7th of buildRoad (through a ?: too)
  const label = (n: any): boolean => {
    while (ts.isConditionalExpression(n.parent) || ts.isParenthesizedExpression(n.parent)) n = n.parent;
    const p = n.parent;
    if (!p || !(ts.isNewExpression(p) || ts.isCallExpression(p))) return false;
    const callee = p.expression.getText();
    return (/^(RoadJournal|ItemsCommand)$/.test(callee) && p.arguments?.[1] === n) || (callee === 'buildRoad' && p.arguments?.[6] === n);
  };
  const visit = (n: any): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      const v: string = n.text;
      if (!ts.isImportDeclaration(n.parent) && !label(n) && (ACCENT.test(v) || PT_VALUES.has(v) || WORDS.test(v))) {
        out.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${v.slice(0, 60)}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

test('the migrated files hold no Portuguese text for the player', () => {
  assert.deepEqual(MIGRATED.flatMap(portuguese), []);
});

test('their refusals follow the player\'s language', () => {
  try {
    setLang('en');
    // two corners are not a lot
    assert.equal(polygonLot([]), t('refuse.lot.threeCorners'));
    assert.equal(polygonLot([]), 'click at least three corners');
  } finally {
    setLang('pt-BR');
  }
});

/// <reference types="node" />
// What the player reads comes from the language files (src/shared/i18n/lang), never from a Portuguese literal in the
// code: the files listed here are migrated, and none may hold one again. Command labels are language keys
// (cmd.<sound>.<name>) everywhere in src, in both languages, and their middle part keeps each command's old sound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ENGINE_PT } from '../src/shared/i18n/lang/engine.pt-BR.ts';
import { ENGINE_EN } from '../src/shared/i18n/lang/engine.en.ts';
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
  const visit = (n: any): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      const v: string = n.text;
      if (!ts.isImportDeclaration(n.parent) && (ACCENT.test(v) || PT_VALUES.has(v) || WORDS.test(v))) {
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

/** Every literal in a command-label position in src: label: / readonly label = / label = default, the label argument of
 *  new RoadJournal / new ItemsCommand / removeItems / replaceBy / buildRoad and the inspector's this.apply. */
function labels(): string[] {
  const out: string[] = [];
  const ARG = new Map<string, number>([['RoadJournal', 1], ['ItemsCommand', 1], ['removeItems', 1], ['replaceBy', 3], ['buildRoad', 6]]);
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/lang$|vendor$/.test(p)) walk(p); continue; }
      if (!e.name.endsWith('.ts') || e.name.endsWith('.d.ts') || p.endsWith(path.join('ui', 'keys.ts'))) continue;
      const s = fs.readFileSync(p, 'utf8'), sf = ts.createSourceFile(p, s, ts.ScriptTarget.Latest, true);
      const visit = (n: any): void => {
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
          let m = n; while (ts.isConditionalExpression(m.parent) || ts.isParenthesizedExpression(m.parent)) m = m.parent;
          const q = m.parent;
          const named = (ts.isPropertyAssignment(q) || ts.isPropertyDeclaration(q) || ts.isParameter(q)) && q.name.getText(sf) === 'label' && q.initializer === m;
          let arg = false;
          if ((ts.isNewExpression(q) || ts.isCallExpression(q)) && q.arguments) {
            const callee = q.expression.getText(sf), i = q.arguments.indexOf(m);
            arg = ARG.get(callee) === i || (callee === 'this.apply' && p.endsWith('inspector.ts') && i === 1);
          }
          if (named || arg) out.push(`${path.relative(root, p)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${n.text}`);
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
  };
  walk(path.join(root, 'src'));
  return out;
}

test('command labels are cmd.* keys of both languages', () => {
  const all = labels();
  assert.ok(all.length > 70, `labels found: ${all.length}`);
  assert.deepEqual(all.filter((l) => { const k = l.split(' ')[1]; return !(k.startsWith('cmd.') && k in ENGINE_PT && k in ENGINE_EN); }), []);
});

test('each command label keeps the sound it had (the old rule on its Portuguese text agrees with its key)', () => {
  const old = (l: string): string => l.startsWith('demolir') || l.startsWith('remover') || l.startsWith('tirar') || l.startsWith('apagar') ? 'demolish'
    : l.startsWith('construir') || l === 'rotatória' || l.startsWith('trocar') || l === 'lote desenhado' || l === 'muro' ? 'build' : 'place';
  const keys = Object.keys(ENGINE_PT).filter((k) => k.startsWith('cmd.'));
  assert.ok(keys.length >= 80);
  assert.deepEqual(keys.filter((k) => old(ENGINE_PT[k]) !== k.split('.')[1]), []);
});

/// <reference types="node" />
// D7: the road height keys move the road a metre (Roadcraft 4.0 editor/roadTool.ts stepHeight), landing on whole
// metres, as the hint the player reads says ("±1 m", "Raise the road 1 m"); the keys used to move it 4 m.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heightStep } from '../src/features/roads/roadTool.ts';
import { PT_BR } from '../data/textos-roadcraft/pt-BR.ts';
import { EN } from '../data/textos-roadcraft/en.ts';

test('D7: a press of the height keys is one metre, landing on whole metres', () => {
  assert.equal(heightStep(0, 1), 1);
  assert.equal(heightStep(0, -1), -1);
  assert.equal(heightStep(2.5, 1), 3);
  assert.equal(heightStep(2.5, -1), 2);
  assert.equal(heightStep(4, 1), 5);
  // the step the hint names is the step the key makes
  assert.match(EN['roadKeys.heightUp'], /\b1 m\b/);
  assert.match(PT_BR['roadKeys.heightUp'], /\b1 m\b/);
  assert.equal(heightStep(7, 1) - 7, 1);
});

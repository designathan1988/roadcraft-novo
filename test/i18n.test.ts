/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translate } from '../src/shared/i18n/index.ts';

test('tradução: frases fixas, espaços preservados e frases com números', () => {
  assert.equal(translate('Câmera'), 'Camera');
  assert.equal(translate(' moradores · '), ' residents · ');
  assert.equal(translate('17 mil'), '17k');
  assert.equal(translate('Escola · 3 andares'), 'School · 3 floor(s)');
  assert.equal(translate('Calçada 2 de 9'), 'Sidewalk 2 of 9');
  assert.equal(translate('texto que não existe'), 'texto que não existe');
});

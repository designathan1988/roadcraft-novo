/// <reference types="node" />
// The b40 vocabulary: codes are dense from 0 (a bay is one byte), the furniture sizes are one positive triple per
// kind in the same order. Guards the transcription of the 4.0 tables.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  B40_BAY, B40_BAY_COUNT, B40_PATTERN, B40_PATTERN_COUNT, B40_ROOF, B40_CORE, B40_SPACE, B40_KIND, B40_GROUND,
  B40_SIDE, B40_ROOF_DETAIL, B40_LINES, B40_CROWN, B40_FURNITURE, B40_FURNITURE_COUNT, B40_FURNITURE_SIZE,
  B40_FURNITURE_STRIDE,
} from '../src/world/b40Kinds.ts';

const TABLES = {
  B40_BAY, B40_PATTERN, B40_ROOF, B40_CORE, B40_SPACE, B40_KIND, B40_GROUND, B40_SIDE, B40_ROOF_DETAIL, B40_LINES,
  B40_CROWN, B40_FURNITURE,
} as const;

test('every b40 kind table is dense and starts at zero', () => {
  for (const [name, table] of Object.entries(TABLES)) {
    const values = Object.values(table);
    assert.deepEqual(values, values.map((_, i) => i), `${name} is not dense from 0`);
    assert.equal(new Set(values).size, values.length, `${name} repeats a code`);
  }
});

test('the counted tables agree with their constants', () => {
  assert.equal(Object.keys(B40_BAY).length, B40_BAY_COUNT);
  assert.equal(Object.keys(B40_PATTERN).length, B40_PATTERN_COUNT);
  assert.equal(Object.keys(B40_FURNITURE).length, B40_FURNITURE_COUNT);
});

test('the furniture sizes are one positive triple per kind, in code order', () => {
  assert.equal(B40_FURNITURE_SIZE.length, B40_FURNITURE_COUNT * B40_FURNITURE_STRIDE);
  for (let k = 0; k < B40_FURNITURE_COUNT; k++) {
    for (let a = 0; a < B40_FURNITURE_STRIDE; a++) {
      const v = B40_FURNITURE_SIZE[k * B40_FURNITURE_STRIDE + a]!;
      assert.ok(v > 0 && Number.isFinite(v), `furniture ${k} axis ${a}: ${v}`);
    }
  }
});

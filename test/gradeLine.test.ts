/// <reference types="node" />
// The road's grade line (roads/build.ts gradeLine): the least earthwork under the grade limit, the same both ways.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradeLine } from '../src/roads/build.ts';

const line = (wanted: number[], g: number, fixedAt: number[] = [], floor?: number[]) => {
  const y = Float64Array.from(wanted);
  const fixed = new Uint8Array(y.length);
  for (const i of fixedAt) fixed[i] = 1;
  gradeLine(y, g, fixed, Float64Array.from(floor ?? wanted.map(() => -Infinity)));
  return y;
};
const hill = (n: number, peak: number) => Array.from({ length: n }, (_, i) => 10 + peak * Math.max(0, Math.cos(Math.PI * (i - (n - 1) / 2) / (n / 3))));

test('ground already within the grade is kept as it is', () => {
  const ground = Array.from({ length: 50 }, (_, i) => 10 + 0.3 * Math.sin(i / 5));
  const y = line(ground, 0.5);
  for (let i = 0; i < ground.length; i++) assert.ok(Math.abs(y[i] - ground[i]) < 1e-9);
});

test('no step is steeper than the grade', () => {
  const y = line(hill(61, 30), 0.5);
  for (let i = 1; i < y.length; i++) assert.ok(Math.abs(y[i] - y[i - 1]) <= 0.5 + 1e-9, `step ${i}: ${y[i] - y[i - 1]}`);
});

test('over a symmetric hill the line is symmetric: the crest is not pushed downhill', () => {
  const y = line(hill(61, 30), 0.5);
  for (let i = 0; i < 30; i++) assert.ok(Math.abs(y[i] - y[60 - i]) < 1e-6, `stations ${i} and ${60 - i}: ${y[i]} ${y[60 - i]}`);
  let top = 0;
  for (let i = 1; i < y.length; i++) if (y[i] > y[top] + 1e-9) top = i;
  assert.ok(Math.abs(top - 30) <= 1, `crest at ${top}`);
});

test('the ends on flat ground stay on the ground', () => {
  const y = line(hill(61, 30), 0.5);
  assert.ok(Math.abs(y[0] - 10) < 1e-9 && Math.abs(y[60] - 10) < 1e-9);
});

test('fixed stations are held and the floor is respected', () => {
  const ground = Array.from({ length: 40 }, () => 10);
  const y = line(ground.map((v, i) => (i === 20 ? 14 : v)), 0.5, [20], ground.map((_, i) => (i > 30 ? 11 : -Infinity)));
  assert.ok(Math.abs(y[20] - 14) < 1e-6, `fixed: ${y[20]}`);
  for (let i = 31; i < 40; i++) assert.ok(y[i] >= 11 - 1e-6, `floor at ${i}: ${y[i]}`);
  for (let i = 1; i < y.length; i++) assert.ok(Math.abs(y[i] - y[i - 1]) <= 0.5 + 1e-6);
});

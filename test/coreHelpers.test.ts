/// <reference types="node" />
// The numeric helpers have one copy each (P21): the Park-Miller stream and the clamped smoothstep in core, pinned
// to the formulas the removed copies computed, and no copy left in src.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parkMiller } from '../src/core/rng.ts';
import { smoothstep01 } from '../src/core/math.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const walk = (dir: string, fn: (p: string) => void): void => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'vendor') walk(p, fn); } else if (/\.ts$/.test(e.name)) fn(p);
  }
};

test('parkMiller(seed) is the removed copies\' sequence (s = s * 16807 mod 2^31 - 1, / 2^31 - 1)', () => {
  let s = 12345;
  const r = parkMiller(12345);
  for (let i = 0; i < 32; i++) { s = (s * 16807) % 2147483647; assert.ok(Object.is(r(), s / 2147483647)); }
});

test('smoothstep01 equals the removed copies\' formula on every kind of input', () => {
  const old = (t: number): number => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); };
  for (const t of [-1, -0, 0, 1e-9, 0.25, 0.5, 0.75, 1, 2, NaN, Infinity, -Infinity]) assert.ok(Object.is(smoothstep01(t), old(t)), `t = ${t}`);
  for (let i = 0; i < 1000; i++) { const t = (i - 300) / 400; assert.ok(Object.is(smoothstep01(t), old(t))); }
});

test('no file outside core carries the Park-Miller or lowbias32 constants, or the clamped smoothstep formula', () => {
  const offenders: string[] = [];
  walk(path.join(root, 'src'), (p) => {
    if (p.includes(path.join('src', 'core') + path.sep)) return;
    const text = fs.readFileSync(p, 'utf8');
    if (/16807|0x7feb352d/.test(text) || /Math\.min\(1, Math\.max\(0, t\)\); return x \* x \* \(3 - 2 \* x\)/.test(text)) offenders.push(path.relative(root, p));
  });
  assert.deepEqual(offenders, []);
});

/// <reference types="node" />
// One mulberry32 for the whole code base (P21): `stream` in core/rng.ts is the Rng as a function, and no other file
// carries its own copy of the generator (roof plants, trees, facade props and their leaves did, bit for bit the same).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rng, stream } from '../src/core/rng.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('stream(seed) is the Rng sequence (what the removed copies computed)', () => {
  const r = new Rng(42), s = stream(42);
  for (let i = 0; i < 16; i++) assert.equal(s(), r.next());
  // the sequence itself, pinned: a change of the generator shows here
  assert.deepEqual([stream(1)(), stream(7)(), stream(0xdeadbeef)()].map((v) => v.toFixed(12)), [new Rng(1).next(), new Rng(7).next(), new Rng(0xdeadbeef).next()].map((v) => v.toFixed(12)));
});

test('no file outside core/rng.ts carries the mulberry32 constants', () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'vendor') walk(p); continue; }
      if (!/\.ts$/.test(e.name) || p.endsWith(path.join('core', 'rng.ts'))) continue;
      if (/0x6d2b79f5/i.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(root, p));
    }
  };
  walk(path.join(root, 'src'));
  assert.deepEqual(offenders, []);
});

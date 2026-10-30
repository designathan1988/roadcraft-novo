import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fractureData } from '../src/render/fracture.ts';

test('fratura: triângulos viram fragmentos com slots e vizinhos, sem perder vértices', () => {
  // two walls of a box, 6 triangles
  const pos: number[] = [], nrm: number[] = [], idx: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[], n: number[]) => {
    const base = pos.length / 3;
    for (const p of [a, b, c, d]) { pos.push(...p); nrm.push(...n); }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  quad([0, 0, 0], [8, 0, 0], [8, 0, 8], [0, 0, 8], [0, 1, 0]);
  quad([0, 0, 0], [0, 8, 0], [8, 8, 0], [8, 0, 0], [0, 0, -1]);
  const colour = new Uint32Array(pos.length / 3).fill(0x998877);
  const still = fractureData({ position: Float32Array.from(pos), normal: Float32Array.from(nrm), colour, index: Uint32Array.from(idx), seed: 42 });
  assert.ok(still.fragments.length >= 2, `${still.fragments.length} fragmentos`);
  assert.equal(still.slots.length, still.fragments.length);
  const total = still.slots.reduce((n, s) => n + s[1], 0);
  assert.ok(total >= pos.length / 3, 'todos os vértices ficam na ruína');
  assert.ok(still.fragments.some((f) => f.neighbours.length > 0), 'fragmentos vizinhos ligados');
  assert.ok(still.fragments.some((f) => f.radius > 0));
});

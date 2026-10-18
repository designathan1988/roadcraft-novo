/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { morton, mortonX, mortonZ, SpatialIndex, DirtyCells, Dirty, cellX, cellId } from '../src/core/grid.ts';
import { Table } from '../src/core/table.ts';
import { CommandStack, type Command } from '../src/core/commands.ts';
import { Rng, fbm } from '../src/core/rng.ts';

test('morton ida e volta', () => {
  for (const [x, z] of [[0, 0], [1, 0], [0, 1], [39, 17], [159, 159], [65535, 1234]]) {
    const k = morton(x, z);
    assert.equal(mortonX(k), x);
    assert.equal(mortonZ(k), z);
  }
});

test('índice espacial: inserir, mover, remover, consultar', () => {
  const s = new SpatialIndex(8);
  s.insert(0, 10, 10);
  s.insert(1, 100, 100);
  s.insert(2, 3000, -3000);
  const found: number[] = [];
  s.query(0, 0, 120, 120, (id) => found.push(id));
  assert.deepEqual(found.sort(), [0, 1]);
  s.move(1, 3000, -3000);
  const near: number[] = [];
  s.queryCell(cellId(cellX(3000), cellX(-3000)), (id) => near.push(id));
  assert.deepEqual(near.sort(), [1, 2]);
  s.remove(2);
  const after: number[] = [];
  s.query(2990, -3010, 3010, -2990, (id) => after.push(id));
  assert.deepEqual(after, [1]);
});

test('células sujas por tipo, sem repetir', () => {
  const d = new DirtyCells();
  d.mark(5, Dirty.Buildings);
  d.mark(5, Dirty.Buildings | Dirty.Terrain);
  d.mark(7, Dirty.Buildings);
  assert.deepEqual(d.drain(Dirty.Buildings), [5, 7]);
  assert.deepEqual(d.drain(Dirty.Buildings), []);
  assert.deepEqual(d.drain(Dirty.Terrain), [5]);
});

test('tabela SoA: ids densos, lista livre e crescimento', () => {
  const t = new Table({ x: Float32Array, n: Uint8Array }, 2);
  const a = t.alloc(), b = t.alloc(), c = t.alloc();
  assert.deepEqual([a, b, c], [0, 1, 2]);
  assert.ok(t.capacity >= 3);
  t.cols.x[c] = 5;
  t.release(b);
  assert.equal(t.alloc(), 1);
  t.release(a);
  t.allocAt(0);
  assert.equal(t.size, 3);
  assert.equal(t.cols.x[2], 5);
  assert.throws(() => t.allocAt(2));
});

test('desfazer e refazer aplicam o inverso', () => {
  let v = 0;
  const add = (n: number): Command => ({ label: 'soma', apply: () => { v += n; }, invert: () => { v -= n; } });
  const s = new CommandStack();
  s.run(add(2));
  s.run(add(3));
  assert.equal(v, 5);
  s.undo();
  assert.equal(v, 2);
  s.redo();
  assert.equal(v, 5);
  s.undo(); s.undo();
  assert.equal(v, 0);
  assert.equal(s.undo(), false);
  s.run(add(10));
  assert.equal(s.canRedo, false);
});

test('aleatoriedade determinística', () => {
  const a = new Rng(42), b = new Rng(42);
  for (let i = 0; i < 100; i++) assert.equal(a.nextU32(), b.nextU32());
  assert.equal(fbm(12.3, -4.5, 7, 5), fbm(12.3, -4.5, 7, 5));
  assert.notEqual(fbm(12.3, -4.5, 7, 5), fbm(12.3, -4.5, 8, 5));
});

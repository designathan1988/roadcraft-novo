/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';

test('nós impossíveis: duas vias a menos de 25° contam; abrir o ângulo ou demolir tira; sem varrer o mapa', () => {
  const w = new World(), net = w.roads;
  const c = net.addNode({ x: 0, z: 0, y: 10 });
  const a = net.addNode({ x: 100, z: 0, y: 10 }), b = net.addNode({ x: 100, z: 30, y: 10 }); // ~16,7°
  const s1 = net.addSeg({ a: c, b: a, cx: 50, cz: 0, profile: 0, flags: 0 });
  assert.equal(w.impossible.count, 0);
  const s2 = net.addSeg({ a: c, b, cx: 50, cz: 15, profile: 0, flags: 0 });
  assert.equal(w.impossible.count, 1);
  assert.ok(Math.abs(w.impossible.angleAt(c) - 16.7) < 0.2, `${w.impossible.angleAt(c)}`);
  net.removeSeg(s2);
  assert.equal(w.impossible.count, 0);
  const d = net.addNode({ x: 0, z: 100, y: 10 });
  net.addSeg({ a: c, b: d, cx: 0, cz: 50, profile: 0, flags: 0 }); // 90°
  assert.equal(w.impossible.count, 0);
  void s1;
  net.clear();
  assert.equal(w.impossible.count, 0);
});

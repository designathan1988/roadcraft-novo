/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { DECAY_GRACE, DECAY_SPAN, MinuteHeap, decayTenths, generatedBuilt } from '../src/world/decay.ts';
import { Dirty } from '../src/core/grid.ts';

const DAY = 1440;

test('desgaste do roadcraft: 5 dias de graça, 30 dias até cair aos pedaços, em décimos', () => {
  assert.equal(decayTenths(0, 4 * DAY), 0);
  assert.equal(decayTenths(0, DECAY_GRACE + DECAY_SPAN / 2), 5);
  assert.equal(decayTenths(0, 35 * DAY), 10);
  assert.equal(decayTenths(0, 400 * DAY), 10);
});

test('heap de minutos devolve em ordem', () => {
  const h = new MinuteHeap();
  const keys = [50, 3, 99, 7, 7, 1, 1000, 42];
  keys.forEach((k, i) => h.push(k, i));
  const out: number[] = [];
  while (h.size) { out.push(h.topKey); h.pop(); }
  assert.deepEqual(out, [...keys].sort((a, b) => a - b));
});

test('o relógio da cidade envelhece só quem passou de um décimo, e a reforma zera', () => {
  const w = new World();
  const a = w.addBuilding({ x: 10, z: 10, w: 20, d: 20, h: 0, rot: 0, color: 0, seed: 1, zone: 1, floors: 3, style: 1 });
  w.advanceClock(10 * DAY);
  const b = w.addBuilding({ x: 600, z: 600, w: 20, d: 20, h: 0, rot: 0, color: 0, seed: 2, zone: 1, floors: 3, style: 1 });
  w.dirty.drain(Dirty.Buildings);
  w.advanceClock(5 * DAY); // a: 15 dias (10 depois da graça: 3 décimos); b: 5 dias (ainda novo)
  const c = w.buildings.cols;
  assert.equal(c.decay[a], decayTenths(0, 15 * DAY));
  assert.equal(c.decay[b], 0);
  // nada desenhado lê o desgaste (defeito D9): nenhuma malha é refeita por ele
  assert.equal(w.dirty.drain(Dirty.Buildings).length, 0, 'o desgaste não suja a malha dos prédios');
  // passar o tempo de novo sem chegar ao próximo décimo não suja nada
  w.advanceClock(1);
  assert.equal(w.dirty.drain(Dirty.Buildings).length, 0);
  // reforma: volta a 0 e envelhece de novo do zero
  const before = w.setBuilt(a, w.clock);
  assert.equal(before, 0);
  assert.equal(c.decay[a], 0);
  w.advanceClock(4 * DAY);
  assert.equal(c.decay[a], 0);
  w.advanceClock(40 * DAY);
  assert.equal(c.decay[a], 10);
});

test('a cidade gerada não envelhece toda no mesmo minuto', () => {
  const seen = new Set<number>();
  for (let s = 0; s < 500; s++) { const b = generatedBuilt(s * 7919); assert.ok(b >= 0 && b < DECAY_SPAN / 10); seen.add(Math.floor(b / 60)); }
  assert.ok(seen.size > 40, `${seen.size} horas diferentes`);
});

test('desfazer remoção traz a idade de volta (registro com built)', () => {
  const w = new World();
  w.advanceClock(3 * DAY);
  const a = w.addBuilding({ x: 10, z: 10, w: 20, d: 20, h: 0, rot: 0, color: 0, seed: 1, zone: 1, floors: 3, style: 1, built: 0 });
  const rec = w.buildingRec(a);
  w.removeBuilding(a);
  w.advanceClock(20 * DAY);
  w.restoreBuilding(rec);
  assert.equal(w.buildings.cols.built[a], 0);
  assert.equal(w.buildings.cols.decay[a], decayTenths(0, 23 * DAY));
});

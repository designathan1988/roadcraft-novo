/// <reference types="node" />
// Starting another city leaves nothing of the previous one: no bus passenger of it gets off later (D2), and the
// developer's unlimited money does not carry over (D63).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridCity } from './simCity.ts';
import { Peds } from '../src/sim/peds.ts';
import { World } from '../src/world/world.ts';
import { CityFlows } from '../src/app/cityFlows.ts';

test('D2: Peds.clear forgets the bus passengers still to step out', () => {
  const { sim } = gridCity(4, 120);
  const peds = new Peds(sim);
  peds.density = 0;
  const inner = peds as unknown as { outOfBus: number[]; windowNodes: number[] };
  // a bus stop on the avenue: twelve passengers to step out over the next seconds, and the buildings' doors
  peds.spawnFromStop(-60, -66, 12);
  peds.setDoors(new Float32Array([-60, -70, 0, 1, 60, -70, 0, 1]));
  assert.ok(inner.outOfBus.length > 0, 'passengers waiting to step out');
  peds.clear();
  // nothing of that city is left to come out
  assert.equal(inner.outOfBus.length, 0);
  assert.equal(inner.windowNodes.length, 0);
  assert.equal(peds.doors.length, 0);
  for (let i = 0; i < 10; i++) peds.step(0.5);
  assert.equal(peds.t.size, 0);
});

test('D63: a new city starts without the unlimited money', () => {
  const w = new World();
  w.unlimited = true;
  new CityFlows({ world: w, clearPage() {}, forgetSlot() {} } as unknown as ConstructorParameters<typeof CityFlows>[0]).reset();
  assert.equal(w.unlimited, false);
});

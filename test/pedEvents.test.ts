/// <reference types="node" />
// D55 option C (the owner keeps A/B): a pedestrian step handles every event that is due, however many. It used to stop
// at 20,000 a step and leave the rest late (people standing past the end of their stretch): an implicit amortization
// (CLAUDE.md forbidden rule 6) that hid the real cost of a big population instead of showing it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridCity, inner } from './simCity.ts';
import { Peds } from '../src/sim/peds.ts';

test('every due pedestrian event is handled in the step it is due, past 20,000', () => {
  const { sim } = gridCity(3, 120);
  const peds = new Peds(sim);
  peds.density = 0;
  const p = inner(peds);
  // 25,000 events due now (stale ones, for nobody: the step pops them without walking anyone)
  for (let i = 0; i < 25000; i++) p.schedule(0, 0);
  assert.equal(p.heapN, 25000);
  peds.step(0.05);
  assert.equal(p.heapN, 0, `events left late after one step: ${p.heapN}`);
});

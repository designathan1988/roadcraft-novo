/// <reference types="node" />
// The b40 lot plan against the 4.0 plans recorded before the 4.0 generator was deleted: 216 plans, every kind,
// width, depth and corner state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Xoshiro128 } from '../src/core/rng.ts';
import { planLot, type B40LotKind } from '../src/jobs/b40/lot/plan.ts';
import { FIX } from './b40FixtureData.ts';

test('b40 planLot matches the recorded 4.0 plans', () => {
  for (const f of FIX.plans) {
    const plan = planLot(f.kind as B40LotKind, f.W, f.D, new Xoshiro128(f.key), f.corner);
    assert.deepEqual(plan, f.plan, `${f.kind} ${f.W}×${f.D} corner ${f.corner}`);
  }
});

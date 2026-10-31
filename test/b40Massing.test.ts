/// <reference types="node" />
// The b40 massing against the 4.0 bodies recorded before the 4.0 generator was deleted: same body, entrance, back
// door, free rectangles and the random state left for the lot, for 144 buildings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Xoshiro128 } from '../src/core/rng.ts';
import { B40Table } from '../src/jobs/b40/volumes.ts';
import { planLot, type B40LotKind } from '../src/jobs/b40/lot/plan.ts';
import { madeToMeasure } from '../src/jobs/b40/massing.ts';
import { toBuilding40 } from '../src/jobs/b40/adapter.ts';
import { FIX } from './b40FixtureData.ts';

test('b40 massing matches the recorded 4.0 buildings', () => {
  const table = new B40Table();
  for (const f of FIX.massed) {
    const where = `${f.kind} ${f.W}×${f.D} corner ${f.corner} key ${f.key}`;
    const rng = new Xoshiro128(f.key);
    planLot(f.kind as B40LotKind, f.W, f.D, rng, f.corner);
    const made = madeToMeasure(table, f.use, f.density, f.env, rng);
    const back = toBuilding40(table, 1, 0, 0, 0) as unknown as Record<string, unknown>;
    delete back.id; delete back.x; delete back.y; delete back.rotation;
    assert.deepEqual(back, f.body, where);
    assert.equal(made.entrance, f.entrance, `${where}: entrance`);
    assert.equal(made.backDoor, f.backDoor, `${where}: back door`);
    assert.deepEqual(made.free, f.free, `${where}: free`);
    for (let k = 0; k < 16; k++) assert.equal(rng.float(), f.draws[k], `${where}: rng draw ${k}`);
  }
});

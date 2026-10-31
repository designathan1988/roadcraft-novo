/// <reference types="node" />
// The whole b40 generation pipeline (plan, massing, shift, furnish) against the 4.0 lots recorded before the 4.0
// generator was deleted: same final record, element ids included, and random state, for 144 lots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Xoshiro128 } from '../src/core/rng.ts';
import { B40Table } from '../src/jobs/b40/volumes.ts';
import { planLot, type B40LotKind } from '../src/jobs/b40/lot/plan.ts';
import { madeToMeasure } from '../src/jobs/b40/massing.ts';
import { furnishLot } from '../src/jobs/b40/lot/furnish.ts';
import { toBuilding40 } from '../src/jobs/b40/adapter.ts';
import { FIX } from './b40FixtureData.ts';

test('b40 furnishing matches the recorded 4.0 lots', () => {
  const table = new B40Table();
  for (const f of FIX.furnished) {
    const where = `${f.kind} ${f.W}×${f.D} corner ${f.corner} key ${f.key}`;
    const rng = new Xoshiro128(f.key);
    const plan = planLot(f.kind as B40LotKind, f.W, f.D, rng, f.corner);
    const made = madeToMeasure(table, f.use, f.density, f.env, rng);
    const dx = plan.building.x0 - f.W / 2, dy = plan.building.y0;
    for (let v = 0; v < table.n; v++) { table.x[v] = table.x[v]! + dx; table.y[v] = table.y[v]! + dy; }
    for (let i = 0; i < table.elN; i++) { table.elX[i] = table.elX[i]! + dx; table.elY[i] = table.elY[i]! + dy; }
    for (let i = 0; i < table.coreN; i++) { table.coreX[i] = table.coreX[i]! + dx; table.coreY[i] = table.coreY[i]! + dy; }
    furnishLot(table, plan, made, rng);
    const back = toBuilding40(table, 1, 0, 0, 0) as unknown as Record<string, unknown>;
    delete back.id; delete back.x; delete back.y; delete back.rotation;
    assert.deepEqual(back, f.body, where);
    for (let k = 0; k < 8; k++) assert.equal(rng.float(), f.draws[k], `${where}: rng draw ${k}`);
  }
});

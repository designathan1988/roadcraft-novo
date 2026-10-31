/// <reference types="node" />
// The b40 table records every 4.0 building in the recorded fixtures and gives it back unchanged: the adapter's
// round trip, for all 144 bodies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { B40Table } from '../src/jobs/b40/volumes.ts';
import { fromBuilding40, toBuilding40 } from '../src/jobs/b40/adapter.ts';
import { FIX } from './b40FixtureData.ts';

test('every recorded building survives the SoA table round trip', () => {
  const table = new B40Table();
  for (const f of FIX.massed) {
    fromBuilding40(table, f.body as never);
    const back = toBuilding40(table, 1, 0, 0, 0) as unknown as Record<string, unknown>;
    delete back.id; delete back.x; delete back.y; delete back.rotation;
    assert.deepEqual(back, f.body, `${f.kind} ${f.W}×${f.D} key ${f.key}`);
  }
});

/// <reference types="node" />
// The b40 bay layout against 4.0 facadeBays for every recorded body: same bays, in the same order, with the same
// component, push, span pieces and heights.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { facadeBays } from '../src/r40/world/buildings/geometry.ts';
import { B40_BAY_NAME } from '../src/world/b40Kinds.ts';
import { B40Table } from '../src/jobs/b40/volumes.ts';
import { fromBuilding40, toBuilding40 } from '../src/jobs/b40/adapter.ts';
import { bayLayout } from '../src/jobs/b40/emit/layout.ts';
import { FIX } from './b40FixtureData.ts';

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-8;

test('b40 bay layout matches 4.0 facadeBays for every recorded body', () => {
  const table = new B40Table();
  for (const f of FIX.massed) {
    fromBuilding40(table, f.body as never);
    const b = toBuilding40(table, 1, 0, 0, 0);
    const want = facadeBays(b);
    const got = bayLayout(table);
    assert.equal(got.length, want.length, `${f.kind} ${f.W}×${f.D} key ${f.key}: bay count`);
    for (let i = 0; i < got.length; i++) {
      const a = got[i]!, w = want[i]!;
      const where = `${f.kind} ${f.W}×${f.D} key ${f.key} bay ${i}`;
      assert.equal(a.volume, w.volume, `${where}: volume`);
      assert.equal(a.storey, w.storey, `${where}: storey`);
      assert.equal(a.level, w.level, `${where}: level`);
      assert.equal(a.side, w.side, `${where}: side`);
      assert.equal(a.index, w.index, `${where}: index`);
      assert.equal(B40_BAY_NAME[a.component], w.component, `${where}: component`);
      // the record stands at the origin, so its local point is the world one
      assert.ok(near(a.lx, w.x) && near(a.ly, w.y), `${where}: point`);
      assert.ok(near(a.lnx, w.nx) && near(a.lny, w.ny), `${where}: normal`);
      assert.ok(near(a.z, w.z) && near(a.start, w.start) && near(a.push, w.push), `${where}: z/start/push`);
      assert.ok(near(a.width, w.width) && near(a.height, w.height), `${where}: size`);
    }
  }
});

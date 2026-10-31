/// <reference types="node" />
// The b40 "parts nothing holds up" must remove exactly the parts 4.0 removes, on random bodies of blocks and parts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unsupportedElements as unsupported40 } from '../src/r40/world/buildings/elements.ts';
import { Rng } from '../src/core/rng.ts';
import { B40_ELEMENT_NAME } from '../src/world/b40Kinds.ts';
import { B40Table } from '../src/jobs/b40/volumes.ts';
import { toBuilding40 } from '../src/jobs/b40/adapter.ts';
import { unsupportedElements as unsupportedB40 } from '../src/jobs/b40/elements.ts';

test('b40 unsupportedElements removes exactly what 4.0 removes', () => {
  const r = new Rng(0x51ed270b);
  for (let c = 0; c < 1500; c++) {
    const t = new B40Table();
    t.clear();
    const nv = r.int(1, 8);
    for (let v = 0; v < nv; v++) {
      const w = r.range(4, 16), d = r.range(4, 16);
      t.block({ x: r.range(-12, 12), y: r.range(-12, 12), w, d, base: r.next() < 0.3 ? r.int(1, 4) : 0, storeys: r.int(1, 6), roof: 0 });
    }
    const ne = r.int(1, 30);
    for (let e = 0; e < ne; e++) {
      t.el(r.int(0, B40_ELEMENT_NAME.length - 1), r.range(-18, 18), r.range(-18, 18), r.int(0, 3), {
        w: r.range(0.1, 5), d: r.range(0.1, 5), h: r.range(0.2, 4), z: r.next() < 0.6 ? 0 : r.range(0, 6),
      });
    }
    const b = toBuilding40(t, 1, 0, 0, 0);
    const a = [...unsupported40(b)].map((id) => id - 1).sort((p, q) => p - q);
    const ours = [...unsupportedB40(t)].sort((p, q) => p - q);
    assert.deepEqual(ours, a, `case ${c}`);
  }
});

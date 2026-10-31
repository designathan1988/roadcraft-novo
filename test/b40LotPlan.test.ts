/// <reference types="node" />
// The b40 lot plan must be the 4.0 plan: same front, sides, back, envelope and corner, from the same seed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLot as plan40 } from '../src/r40/api.ts';
import { Xoshiro128 } from '../src/core/rng.ts';
import { planLot as planB40, type B40LotKind } from '../src/jobs/b40/lot/plan.ts';

const KINDS: B40LotKind[] = ['house', 'flats', 'tower', 'shop', 'office', 'industry'];

test('b40 planLot matches the 4.0 plan for every kind, size and corner', () => {
  let n = 0;
  for (const kind of KINDS) {
    for (let wi = 0; wi < 7; wi++) {
      for (let di = 0; di < 7; di++) {
        for (const corner of [undefined, 'left', 'right'] as const) {
          const W = 8 + wi * 3.5, D = 9 + di * 5;
          for (let seed = 1; seed <= 12; seed++) {
            const key = seed * 104729 + n;
            const a = plan40(kind, W, D, new Xoshiro128(key), corner);
            const b = planB40(kind, W, D, new Xoshiro128(key), corner);
            assert.deepEqual(b, a, `${kind} ${W}×${D} corner ${corner} seed ${seed}`);
            n++;
          }
        }
      }
    }
  }
});

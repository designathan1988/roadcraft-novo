/// <reference types="node" />
// The b40 table must be able to hold every 4.0 building the procedural generator makes: recording a made body in
// the SoA table and building the record back must give the same building, for every kind, density and seed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { madeToMeasure } from '../src/r40/api.ts';
import { Xoshiro128 } from '../src/core/rng.ts';
import { B40Table } from '../src/jobs/b40/volumes.ts';
import { fromBuilding40, toBuilding40 } from '../src/jobs/b40/adapter.ts';

const CASES = [
  { use: 'residential', density: 'low' },
  { use: 'residential', density: 'medium' },
  { use: 'residential', density: 'high' },
  { use: 'commercial', density: 'low' },
  { use: 'commercial', density: 'high' },
  { use: 'industrial', density: 'medium' },
] as const;

test('every made building survives the SoA table round trip', () => {
  const table = new B40Table();
  for (const [ci, c] of CASES.entries()) {
    for (let seed = 1; seed <= 20; seed++) {
      const rng = new Xoshiro128(seed * 7919 + ci);
      const env = {
        W: 10 + (seed % 4) * 4, D: 12 + (seed % 3) * 5,
        door: seed % 2 ? 3 : undefined, backDoor: seed % 3 === 0,
        character: seed & 0xffff, era: (seed % 3) as 0 | 1 | 2,
        driveSide: seed % 2 ? 'left' as const : 'right' as const,
        neighbours: seed % 4 ? [2, 3] : undefined,
      };
      const made = madeToMeasure(c.use, c.density, env, rng);
      fromBuilding40(table, made.body as never);
      const back = toBuilding40(table, 1, 0, 0, 0) as unknown as Record<string, unknown>;
      delete back.id; delete back.x; delete back.y; delete back.rotation;
      assert.deepEqual(back, made.body, `${c.use}/${c.density} seed ${seed}`);
    }
  }
});

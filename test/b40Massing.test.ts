/// <reference types="node" />
// The b40 massing must make exactly the buildings 4.0 makes: the same body (blocks, storeys, bays, materials,
// elements, cores) and the same entrance, back door and free rectangles, from the same seed and envelope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { madeToMeasure as made40 } from '../src/r40/api.ts';
import { Xoshiro128 } from '../src/core/rng.ts';
import { B40Table } from '../src/jobs/b40/volumes.ts';
import { madeToMeasure as madeB40 } from '../src/jobs/b40/massing.ts';
import { toBuilding40 } from '../src/jobs/b40/adapter.ts';

const CASES = [
  { use: 'residential', density: 'low' },
  { use: 'residential', density: 'medium' },
  { use: 'residential', density: 'high' },
  { use: 'commercial', density: 'low' },
  { use: 'commercial', density: 'high' },
  { use: 'industrial', density: 'medium' },
] as const;

test('b40 massing matches the 4.0 generator building for building', () => {
  const table = new B40Table();
  for (const [ci, c] of CASES.entries()) {
    for (let seed = 1; seed <= 40; seed++) {
      const key = seed * 7919 + ci;
      const env = {
        W: 10 + (seed % 4) * 4, D: 12 + (seed % 3) * 5,
        door: seed % 2 ? 3 : undefined, backDoor: seed % 3 === 0,
        character: seed & 0xffff, era: (seed % 3) as 0 | 1 | 2,
        driveSide: seed % 2 ? 'left' as const : 'right' as const,
        neighbours: seed % 4 ? [2, 3] : undefined,
      };
      const rngOld = new Xoshiro128(key), rngB40 = new Xoshiro128(key);
      const old = made40(c.use, c.density, env, rngOld);
      const made = madeB40(table, c.use, c.density, env, rngB40);
      const back = toBuilding40(table, 1, 0, 0, 0) as unknown as Record<string, unknown>;
      delete back.id; delete back.x; delete back.y; delete back.rotation;
      const where = `${c.use}/${c.density} seed ${seed}`;
      assert.deepEqual(back, old.body, where);
      assert.equal(made.entrance, old.entrance, `${where}: entrance`);
      assert.equal(made.backDoor, old.backDoor, `${where}: back door`);
      assert.deepEqual(made.free, old.free, `${where}: free`);
      // The stream left for the lot must be the same: a draw more or less would furnish another yard.
      for (let k = 0; k < 16; k++) assert.equal(rngB40.float(), rngOld.float(), `${where}: rng draw ${k}`);
    }
  }
});

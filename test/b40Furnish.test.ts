/// <reference types="node" />
// The b40 furnisher must lay exactly the 4.0 lot: the same volumes, elements (ids included), tracks and random
// state, from the same plan, body and seed, with the body already standing in its envelope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { furnishLot as furnish40, madeToMeasure as made40, planLot as plan40, type LotKind, type MadeBuilding } from '../src/r40/api.ts';
import { Xoshiro128 } from '../src/core/rng.ts';
import { B40Table } from '../src/jobs/b40/volumes.ts';
import { madeToMeasure as madeB40 } from '../src/jobs/b40/massing.ts';
import { planLot as planB40 } from '../src/jobs/b40/lot/plan.ts';
import { furnishLot as furnishB40 } from '../src/jobs/b40/lot/furnish.ts';
import { toBuilding40 } from '../src/jobs/b40/adapter.ts';

const KINDS = [
  { kind: 'house', use: 'residential', density: 'low' },
  { kind: 'flats', use: 'residential', density: 'medium' },
  { kind: 'tower', use: 'residential', density: 'high' },
  { kind: 'shop', use: 'commercial', density: 'low' },
  { kind: 'office', use: 'commercial', density: 'high' },
  { kind: 'industry', use: 'industrial', density: 'medium' },
] as const;
const WIDTHS = [10, 14, 18, 26], DEPTHS = [16, 24, 34], CORNERS = [undefined, 'left', 'right'] as const;

test('b40 furnishing matches 4.0 lot for lot', () => {
  const table = new B40Table();
  let n = 0;
  for (const [ci, c] of KINDS.entries()) for (const W of WIDTHS) for (const D of DEPTHS) for (const corner of CORNERS) for (let seed = 1; seed <= 2; seed++) {
      const key = seed * 65537 + (n++) * 7919 + ci;
      const where = `${c.kind} ${W}×${D} corner ${corner} seed ${seed}`;
      const rngOld = new Xoshiro128(key), rngB = new Xoshiro128(key);
      const planOld = plan40(c.kind as LotKind, W, D, rngOld, corner);
      const planB = planB40(c.kind, W, D, rngB, corner);
      const env = {
        W: planOld.building.x1 - planOld.building.x0, D: planOld.building.y1 - planOld.building.y0,
        backDoor: planOld.back.use !== 'none' && planOld.back.use !== 'loading',
        character: seed & 0xffff, era: ((seed * 7) % 3) as 0 | 1 | 2,
      };
      const madeOld = made40(c.use, c.density, env, rngOld);
      const madeB = madeB40(table, c.use, c.density, env, rngB);
      assert.deepEqual(madeB.free, madeOld.free, `${where}: free before`);
      const dx = planOld.building.x0 - W / 2, dy = planOld.building.y0;
      const bodyOld = madeOld.body as unknown as { volumes: Array<{ x: number; y: number }>; elements?: Array<{ x: number; y: number }>; cores: Array<{ x: number; y: number }> };
      for (const v of bodyOld.volumes) { v.x += dx; v.y += dy; }
      for (const e of bodyOld.elements ?? []) { e.x += dx; e.y += dy; }
      for (const cr of bodyOld.cores) { cr.x += dx; cr.y += dy; }
      for (let v = 0; v < table.n; v++) { table.x[v] = table.x[v]! + dx; table.y[v] = table.y[v]! + dy; }
      for (let i = 0; i < table.elN; i++) { table.elX[i] = table.elX[i]! + dx; table.elY[i] = table.elY[i]! + dy; }
      for (let i = 0; i < table.coreN; i++) { table.coreX[i] = table.coreX[i]! + dx; table.coreY[i] = table.coreY[i]! + dy; }
      furnish40(bodyOld as never, planOld, madeOld as MadeBuilding, rngOld);
      furnishB40(table, planB, madeB, rngB);
      const back = toBuilding40(table, 1, 0, 0, 0) as unknown as Record<string, unknown>;
      delete back.id; delete back.x; delete back.y; delete back.rotation;
      assert.deepEqual(back, bodyOld, where);
      for (let k = 0; k < 8; k++) assert.equal(rngB.float(), rngOld.float(), `${where}: rng draw ${k}`);
  }
});

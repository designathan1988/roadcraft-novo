/// <reference types="node" />
// Party walls (4.0 partyWalls.ts): a bay standing back to back against a neighbouring lot's block is never seen, so
// the shell pass does not lay it. The cell's mesh job reads its 4.0 lots as one another's neighbours
// (jobs/building40.ts partyWallsOf); before, no PartyWalls was ever built and every such wall was drawn twice, hidden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBuildings } from '../src/jobs/buildingGen.ts';
import { emptyBoxes } from '../src/shared/contracts/worker.ts';
import { Zone } from '../src/roads/zones.ts';
import { HEIGHT_MAP_RES } from '../src/config.ts';

test('three mixed-use lots side by side lay fewer shell triangles together than each alone (the hidden party walls)', () => {
  const heights = new Float32Array(HEIGHT_MAP_RES * HEIGHT_MAP_RES);
  const W = 14, D = 26, seeds = [41, 42, 43];
  const lot = (b: ReturnType<typeof emptyBoxes>, k: number, i: number): void => { b.x[k] = 60 + i * W; b.z[k] = 60; b.w[k] = W; b.d[k] = D; b.seed[k] = seeds[i]; };
  const row = emptyBoxes(3); row.zone.fill(Zone.Mixed); row.floors.fill(5);
  for (let i = 0; i < 3; i++) lot(row, i, i);
  const together = buildBuildings(heights, row, 0, 0, 256, 0)!.index.length / 3;
  let alone = 0;
  for (let i = 0; i < 3; i++) {
    const one = emptyBoxes(1); one.zone.fill(Zone.Mixed); one.floors.fill(5); lot(one, 0, i);
    alone += buildBuildings(heights, one, 0, 0, 256, 0)!.index.length / 3;
  }
  assert.ok(together < alone * 0.95, `together ${together} triangles, alone ${alone}: the walls between the lots are laid`);
});

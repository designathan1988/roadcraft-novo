/// <reference types="node" />
// The generated grid has no dead ends (jobs/cityGen.ts withoutSpurs): a street cut at the bank is taken back to its
// last crossing, the block's ring stays whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withoutSpurs, type CityRoads } from '../src/jobs/cityGen.ts';

test('a spur of two pieces is taken away, the ring it hung from stays', () => {
  // a square ring 0-1-2-3 and a spur 1-4-5
  const xy = [[0, 0], [100, 0], [100, 100], [0, 100], [200, 0], [300, 0]];
  const nodes = new Float32Array(xy.flatMap(([x, z]) => [x, z, 10]));
  const pairs = [[0, 1], [1, 2], [2, 3], [3, 0], [1, 4], [4, 5]];
  const r: CityRoads = { nodes, segs: new Int32Array(pairs.flatMap(([a, b]) => [a, b, 1, 0, 0])), centers: new Float32Array(0) };
  const out = withoutSpurs(r);
  assert.equal(out.segs.length / 5, 4);
  assert.equal(out.nodes.length / 3, 4);
  const deg = new Int32Array(4);
  for (let s = 0; s < 4; s++) { deg[out.segs[s * 5]]++; deg[out.segs[s * 5 + 1]]++; }
  assert.deepEqual([...deg], [2, 2, 2, 2]);
});

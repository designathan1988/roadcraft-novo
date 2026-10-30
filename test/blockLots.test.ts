/// <reference types="node" />
// A closed block is cut as Roadcraft 4.0 cuts it (jobs/blockLots.ts, 4.0 world/lots.ts blockPlan): two rows back to
// back when it is deep enough, equal columns, the lots covering it from street to street.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { Zone } from '../src/roads/zones.ts';
import { buildLots } from '../src/jobs/lots.ts';
import { cellId, cellX } from '../src/core/grid.ts';
import { PROFILE_INFO } from '../src/roads/profiles.ts';
import type { SegId } from '../src/core/ids.ts';

test('a 120 x 72 m block of the grid is covered by two rows of equal lots, front to the street', () => {
  const w = new World(); w.heights.fill(20);
  const net = w.roads, n = (x: number, z: number) => net.addNode({ x, z, y: 20 });
  const p = 1, Z = Zone.Residential;
  // the block's four streets (centre lines), around (60..180, 40..112) in the cell at the origin's corner
  const a = n(60, 40), b = n(180, 40), c = n(180, 112), d = n(60, 112);
  for (const [u, v] of [[a, b], [b, c], [c, d], [d, a]] as const) {
    net.addSeg({ a: u, b: v, cx: (net.nodes.cols.x[u] + net.nodes.cols.x[v]) / 2, cz: (net.nodes.cols.z[u] + net.nodes.cols.z[v]) / 2, profile: p, flags: 0, zl: Z, zr: Z });
  }
  const cell = cellId(cellX(100), cellX(60));
  const segs: SegId[] = [];
  net.forSegsNear(-1e4, -1e4, 1e4, 1e4, (s) => segs.push(s));
  const L = buildLots(w.heights, net.gather(segs, []), cell);
  const half = Math.max(PROFILE_INFO[p].left, PROFILE_INFO[p].right);
  const inner = (120 - 2 * half) * (72 - 2 * half);
  // the lots of this block (their centre inside its four streets); the street-side lots out on the open land round
  // it are not its own
  const own: number[] = [];
  for (let i = 0; i < L.count; i++) if (L.x[i] > 60 && L.x[i] < 180 && L.z[i] > 40 && L.z[i] < 112) own.push(i);
  let area = 0;
  for (const i of own) area += (L.w[i] + 0.6) * L.d[i];
  assert.ok(own.length >= 8, `${own.length} lots`);
  assert.ok(area / inner > 0.9, `lots cover ${(area / inner * 100).toFixed(1)} % of the block's land`);
  // two rows: the lots' depth is about half the block's
  for (const i of own) assert.ok(Math.abs(L.d[i] - (72 - 2 * half) / 2) < 2, `lot ${i} depth ${L.d[i].toFixed(1)}`);
});

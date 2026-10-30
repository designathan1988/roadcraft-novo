/// <reference types="node" />
// The generated city: Roadcraft 4.0's single block grid (the other styles were discarded by the owner, 2026-10-30).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCity } from '../src/jobs/cityGen.ts';
import { MAX_DEG, MAX_SEG_LEN } from '../src/roads/network.ts';

/** Share of segments (by length) running within 3° of the two axes of the map. */
function axisShare(c: ReturnType<typeof generateCity>): number {
  let on = 0, all = 0;
  for (let k = 0; k < c.segs.length; k += 5) {
    const a = c.segs[k], b = c.segs[k + 1];
    const dx = c.nodes[b * 3] - c.nodes[a * 3], dz = c.nodes[b * 3 + 1] - c.nodes[a * 3 + 1], L = Math.hypot(dx, dz);
    const ang = Math.abs(Math.atan2(dz, dx)) % (Math.PI / 2);
    if (Math.min(ang, Math.PI / 2 - ang) < (3 * Math.PI) / 180) on += L;
    all += L;
  }
  return on / all;
}

test('the grid city is whole and its segments fit the network', () => {
  for (const style of ['grid'] as const) {
    const c = generateCity(7);
    const n = c.nodes.length / 3, segs = c.segs.length / 5;
    assert.ok(segs > 5000, `${style}: ${segs} segments`);
    const deg = new Uint8Array(n);
    for (let k = 0; k < c.segs.length; k += 5) {
      const a = c.segs[k], b = c.segs[k + 1];
      assert.notEqual(a, b, `${style}: a segment from a node to itself`);
      const L = Math.hypot(c.nodes[b * 3] - c.nodes[a * 3], c.nodes[b * 3 + 1] - c.nodes[a * 3 + 1]);
      assert.ok(L <= MAX_SEG_LEN, `${style}: a ${L.toFixed(0)} m segment`);
      deg[a]++; deg[b]++;
    }
    assert.ok(deg.every((d) => d <= MAX_DEG), `${style}: a node with more than ${MAX_DEG} roads`);
  }
});

test('the grid lays straight north-south and east-west streets', () => {
  const blocks = axisShare(generateCity(7));
  assert.ok(blocks > 0.95, `${(blocks * 100).toFixed(0)} % of the streets on the axes`);
});

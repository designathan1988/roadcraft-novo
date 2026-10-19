/// <reference types="node" />
// The generated city's styles (Roadcraft 4.0 cityGen: tensor field streets; blocks) on this engine's generator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCity } from '../src/jobs/cityGen.ts';
import { CITY_STYLES } from '../src/jobs/cityField.ts';
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

test('every style makes a whole city whose segments the network can hold', () => {
  for (const style of CITY_STYLES) {
    const c = generateCity(7, style);
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

test('blocks lay straight north-south and east-west streets; organic streets bend every way', () => {
  const blocks = axisShare(generateCity(7, 'blocks')), organic = axisShare(generateCity(7, 'organic'));
  assert.ok(blocks > 0.6, `blocks: ${(blocks * 100).toFixed(0)} % of the streets on the axes`);
  assert.ok(organic < 0.3, `organic: ${(organic * 100).toFixed(0)} % of the streets on the axes`);
});

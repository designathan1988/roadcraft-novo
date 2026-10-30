/// <reference types="node" />
// A straight street side shorter than its corners' setbacks has no lot, and cutting it ends (jobs/lots.ts: the side's
// span went negative and the equal-slot loop walked backwards for ever, so the lots job never returned and the city
// stopped growing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { Zone } from '../src/roads/zones.ts';
import { buildLots } from '../src/jobs/lots.ts';
import { cellId, cellX } from '../src/core/grid.ts';

test('a 12 m street between two crossings gets no lot and the cutting ends', { timeout: 5000 }, () => {
  const w = new World(); w.heights.fill(20);
  const net = w.roads, n = (x: number, z: number) => net.addNode({ x, z, y: 20 });
  const seg = (a: number, b: number) => net.addSeg({ a, b, cx: (net.nodes.cols.x[a] + net.nodes.cols.x[b]) / 2, cz: (net.nodes.cols.z[a] + net.nodes.cols.z[b]) / 2, profile: 3, flags: 0, zl: Zone.Residential, zr: Zone.Residential });
  // two crossings 12 m apart on an avenue: the short piece between them is straight, its setbacks longer than it
  const a = n(100, 100), b = n(112, 100);
  seg(n(0, 100), a); seg(a, b); seg(b, n(220, 100));
  seg(a, n(100, 0)); seg(a, n(100, 200)); seg(b, n(112, 0)); seg(b, n(112, 200));
  const segs: number[] = [];
  net.forSegsNear(-1e4, -1e4, 1e4, 1e4, (s) => segs.push(s));
  const L = buildLots(w.heights, net.gather(segs, []), cellId(cellX(100), cellX(100)));
  for (let i = 0; i < L.count; i++) assert.ok(L.w[i] > 0 && L.d[i] > 0, `lot ${i}: ${L.w[i]} x ${L.d[i]}`);
});

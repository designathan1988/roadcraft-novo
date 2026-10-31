/// <reference types="node" />
// The traffic's arrays follow the network's size even when the network grew before the Traffic was made (a
// network built first and mirrored later): segLoad stayed (1 << 14) * 2 and the router read NaN loads past it
// (found by the P12 research agent: searches then flooded to their 40,000 limit and failed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimNet } from '../src/sim/lanes.ts';
import { Traffic } from '../src/sim/traffic.ts';
import { asNode, asSeg } from '../src/core/ids.ts';

test('a Traffic made after a network of more than 16,384 segments sizes its arrays to it', () => {
  const sim = new SimNet();
  const N = 20_000;
  for (let i = 0; i <= N; i++) sim.apply({ t: 'addNode', rec: { id: asNode(i), x: -4000 + i * 0.4, z: 0, y: 10 } });
  for (let i = 0; i < N; i++) sim.apply({ t: 'addSeg', rec: { id: asSeg(i), a: asNode(i), b: asNode(i + 1), cx: -4000 + i * 0.4 + 0.2, cz: 0, profile: 0, flags: 0, zl: 0, zr: 0 } });
  assert.ok(sim.net.segs.capacity > 1 << 14);
  const tr = new Traffic(sim) as unknown as { segLoad: Uint16Array; segWear: Float32Array; laneHead: Int32Array; router: { segLoad: Uint16Array }; nodePass: Uint32Array };
  assert.ok(tr.segLoad.length >= sim.net.segs.capacity * 2, `segLoad ${tr.segLoad.length} for ${sim.net.segs.capacity} segments`);
  assert.equal(tr.router.segLoad, tr.segLoad);
  assert.ok(tr.segWear.length >= sim.net.segs.capacity);
  assert.ok(tr.laneHead.length >= sim.net.segs.capacity * 16);
  assert.ok(tr.nodePass.length >= sim.net.nodes.capacity);
});

/// <reference types="node" />
// Removing or reprofiling a road rechecks the dead ends near it (their turning bulb may now fit, or no longer):
// D41, only an added segment rechecked them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimNet } from '../src/sim/lanes.ts';
import { asNode, asSeg } from '../src/core/ids.ts';

test('D41: removing a road rebuilds the dead ends near it', () => {
  const sim = new SimNet();
  const node = (id: number, x: number, z: number) => sim.apply({ t: 'addNode', rec: { id: asNode(id), x, z, y: 10 } });
  // a dead-end street (0 -> 1) and a road passing near its end (2 -> 3)
  node(0, -100, 0); node(1, 0, 0); node(2, 20, -100); node(3, 20, 100);
  sim.apply({ t: 'addSeg', rec: { id: asSeg(0), a: asNode(0), b: asNode(1), cx: -50, cz: 0, profile: 0, flags: 0, zl: 0, zr: 0 } });
  sim.apply({ t: 'addSeg', rec: { id: asSeg(1), a: asNode(2), b: asNode(3), cx: 20, cz: 0, profile: 0, flags: 0, zl: 0, zr: 0 } });
  sim.rebuild();
  sim.apply({ t: 'remSeg', id: asSeg(1) });
  const done = sim.rebuild();
  assert.ok(done.includes(1), `rebuilt: ${done}`);
});

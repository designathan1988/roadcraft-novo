/// <reference types="node" />
// The flow advisor counts per arm; when a node's arms are laid out again (a road removed there) each arm's counters
// follow their segment (D24: they stayed by index and the remaining arms took each other's counts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimNet } from '../src/sim/lanes.ts';
import { Traffic } from '../src/sim/traffic.ts';
import { asNode, asSeg } from '../src/core/ids.ts';

test('D24: removing an arm keeps the other arms\' counters with their segments', () => {
  const sim = new SimNet();
  const tr = new Traffic(sim);
  const node = (id: number, x: number, z: number) => sim.apply({ t: 'addNode', rec: { id: asNode(id), x, z, y: 10 } });
  const seg = (id: number, b: number, cx: number, cz: number) => sim.apply({ t: 'addSeg', rec: { id: asSeg(id), a: asNode(0), b: asNode(b), cx, cz, profile: 0, flags: 0, zl: 0, zr: 0 } });
  node(0, 0, 0); node(1, 100, 0); node(2, 0, 100); node(3, -100, 0); node(4, 0, -100);
  seg(0, 1, 50, 0); seg(1, 2, 0, 50); seg(2, 3, -50, 0); seg(3, 4, 0, -50);
  sim.rebuild();
  const adv = tr.advisor as unknown as { rate: Float32Array };
  assert.equal(sim.net.nodes.cols.deg[0], 4);
  for (let k = 0; k < 4; k++) adv.rate[k] = 100 + sim.armSeg[k];
  const gone = sim.armSeg[0];
  sim.apply({ t: 'remSeg', id: asSeg(gone) });
  sim.rebuild();
  assert.equal(sim.net.nodes.cols.deg[0], 3);
  for (let k = 0; k < 3; k++) assert.equal(adv.rate[k], 100 + sim.armSeg[k], `arm ${k} (segment ${sim.armSeg[k]})`);
});

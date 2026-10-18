/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { repairDanglingEnds } from '../src/roads/repair.ts';

function flatWorld(): World {
  const w = new World();
  w.heights.fill(10); w.tileMin.fill(10); w.tileMax.fill(10);
  w.unlimited = true;
  return w;
}

test('mapa antigo: ponta solta dentro de outra via vira cruzamento ao abrir; sob ponte, não', () => {
  const w = flatWorld(), net = w.roads;
  // como um salvamento antigo: nós e trechos inseridos direto, sem as regras de encaixe
  const a = net.addNode({ x: -100, z: 0, y: 10 }), b = net.addNode({ x: 100, z: 0, y: 10 });
  net.addSeg({ a, b, cx: 0, cz: 0, profile: 0, flags: 0 });
  const c = net.addNode({ x: 20, z: 80, y: 10 }), d = net.addNode({ x: 20, z: 1.2, y: 10 });
  net.addSeg({ a: c, b: d, cx: 20, cz: 40, profile: 0, flags: 0 });
  // outra ponta solta, mas embaixo de uma via 8 m acima: fica
  const e = net.addNode({ x: -40, z: 60, y: 10 }), f = net.addNode({ x: -40, z: 0.5, y: 2 });
  net.addSeg({ a: e, b: f, cx: -40, cz: 30, profile: 0, flags: 0 });
  assert.equal(repairDanglingEnds(w), 1);
  const n = net.nearestNode(20, 0, 2);
  assert.ok(n >= 0, 'nó novo no meio da via');
  assert.equal(net.nodes.cols.deg[n], 3, 'cruzamento de três braços');
  assert.equal(net.nodes.alive[d], 0, 'a ponta solta sumiu');
  assert.equal(net.segs.size, 4);
  // de novo não muda nada
  assert.equal(repairDanglingEnds(w), 0);
});

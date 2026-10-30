/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCity } from '../src/jobs/cityGen.ts';
import { baseHeight } from '../src/jobs/terrainGen.ts';
import { asNode } from '../src/core/ids.ts';

test('cidade gerada: determinística, grafo limpo, nós em terra', () => {
  const a = generateCity(3), b = generateCity(3);
  assert.deepEqual(a, b);
  const n = a.nodes.length / 3, m = a.segs.length / 5;
  assert.ok(m > 8000 && m < 40000, `trechos ${m}`);
  const deg = new Int32Array(n);
  const seen = new Set<string>();
  for (let i = 0; i < a.segs.length; i += 5) {
    const x = a.segs[i], y = a.segs[i + 1];
    assert.notEqual(x, y);
    const k = x < y ? `${x},${y}` : `${y},${x}`;
    assert.ok(!seen.has(k), 'trecho repetido');
    seen.add(k);
    deg[x]++; deg[y]++;
    const L = Math.hypot(a.nodes[x * 3] - a.nodes[y * 3], a.nodes[x * 3 + 1] - a.nodes[y * 3 + 1]);
    assert.ok(L >= 9, `trecho curto ${L}`);
  }
  for (let i = 0; i < n; i++) {
    assert.ok(deg[i] >= 1 && deg[i] <= 6, `grau ${deg[i]}`);
    // over water only a pier in the middle of a bridge span (two roads, deck above the water): long spans are split
    // so no segment is longer than the spatial index holds
    if (baseHeight(a.nodes[i * 3], a.nodes[i * 3 + 1], 3) <= 0) assert.ok(deg[i] === 2 && a.nodes[i * 3 + 2] > 1, `nó na água com grau ${deg[i]}, altura ${a.nodes[i * 3 + 2]}`);
  }
});

test('the generated city is born clean: no impossible node, no dead end lying inside another road', async () => {
  const { World } = await import('../src/world/world.ts');
  const { repairDanglingEnds } = await import('../src/roads/repair.ts');
  for (const seed of [1, 7, 42]) {
    // inserted the way game.ts generatedCity does
    const w = new World(); w.seed = seed; w.unlimited = true;
    const city = generateCity(seed);
    const ids: number[] = [];
    for (let i = 0; i < city.nodes.length; i += 3) ids.push(w.roads.addNode({ x: city.nodes[i], z: city.nodes[i + 1], y: city.nodes[i + 2] }));
    const nc = w.roads.nodes.cols;
    for (let k = 0; k < city.segs.length; k += 5) {
      const a = ids[city.segs[k]], b = ids[city.segs[k + 1]];
      w.roads.addSeg({ a: asNode(a), b: asNode(b), cx: (nc.x[a] + nc.x[b]) / 2, cz: (nc.z[a] + nc.z[b]) / 2, profile: city.segs[k + 2], flags: 0, zl: city.segs[k + 3], zr: city.segs[k + 4] });
    }
    assert.equal(w.impossible.count, 0, `seed ${seed}: ${w.impossible.count} impossible nodes`);
    assert.equal(repairDanglingEnds(w), 0, `seed ${seed}: dead ends inside other roads`);
  }
});

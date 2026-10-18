/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCity } from '../src/jobs/cityGen.ts';
import { baseHeight } from '../src/jobs/terrainGen.ts';

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
    assert.ok(baseHeight(a.nodes[i * 3], a.nodes[i * 3 + 1], 3) > 0, 'nó na água');
  }
});

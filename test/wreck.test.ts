import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { emptyBoxes } from '../src/shared/contracts/worker.ts';
import { lot40OfBox } from '../src/jobs/buildingGen.ts';
import { wreckInput } from '../src/render/wreckData.ts';

test('wreck: um prédio real produz casca, lajes e partições para a fratura', () => {
  const w = new World();
  w.heights.fill(10);
  const b = emptyBoxes(1);
  b.x[0] = 0; b.z[0] = 0; b.w[0] = 22; b.d[0] = 26; b.h[0] = 28; b.rot[0] = 0;
  b.zone[0] = 2; b.floors[0] = 7; b.seed[0] = 12345; b.style[0] = 4; b.color[0] = 0; b.count = 1;
  const input = wreckInput(lot40OfBox(w.heights, b, 0));
  assert.ok(input.position.length > 300, `${input.position.length / 3} vértices`);
  assert.ok(input.index.length > 300);
  assert.ok(input.index.length % 3 === 0);
});

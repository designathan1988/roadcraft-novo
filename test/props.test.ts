/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { buildProps, PROP } from '../src/jobs/props.ts';
import { emptyBoxes } from '../src/shared/contracts/worker.ts';
import { cellId, cellX } from '../src/core/grid.ts';

import { Zone } from '../src/roads/zones.ts';
import { Ctl } from '../src/roads/control.ts';

test('peças: determinísticas, cada uma na sua célula, semáforo por braço', () => {
  const w = new World();
  w.heights.fill(10);
  const net = w.roads;
  // cruzamento em cruz bem na quina de quatro células, avenida num eixo
  const c = net.addNode({ x: 0, z: 0, y: 10 });
  const ends = [[200, 0], [0, 200], [-200, 0], [0, -200]].map(([x, z]) => net.addNode({ x, z, y: 10 }));
  ends.forEach((e, i) => {
    const ex = net.nodes.cols.x[e], ez = net.nodes.cols.z[e];
    net.addSeg({ a: c, b: e, cx: ex / 2, cz: ez / 2, profile: i % 2 ? 3 : 1, flags: 0, zl: Zone.Commercial, zr: Zone.Residential });
  });
  const segs: number[] = [];
  net.forSegsNear(-300, -300, 300, 300, (s) => segs.push(s));
  // automático: avenida principal, a rua dá a preferência (placas, sem semáforo)
  let auto = 0;
  for (let i = 0; i < 4; i++) { const g = net.gather(segs, []); const r = buildProps(w.heights, g, emptyBoxes(0), [cellId(cellX(-1), cellX(-1)), cellId(cellX(1), cellX(-1)), cellId(cellX(-1), cellX(1)), cellId(cellX(1), cellX(1))][i]);
    for (let k = 0; k < r.count; k++) if ((r.extra[k] & 15) === PROP.Signal) auto++; }
  assert.equal(auto, 0);
  net.setJunction(c, { ctl: Ctl.Signal });
  const cells = [cellId(cellX(-1), cellX(-1)), cellId(cellX(1), cellX(-1)), cellId(cellX(-1), cellX(1)), cellId(cellX(1), cellX(1))];
  let signals = 0, lamps = 0, trees = 0, total = 0;
  for (const cell of cells) {
    const a = buildProps(w.heights, net.gather(segs, []), emptyBoxes(0), cell);
    const b = buildProps(w.heights, net.gather(segs, []), emptyBoxes(0), cell);
    assert.deepEqual(a, b);
    for (let i = 0; i < a.count; i++) {
      const x = a.data[i * 4], z = a.data[i * 4 + 2];
      assert.equal(cellId(cellX(x), cellX(z)), cell, 'peça fora da célula');
      const t = a.extra[i] & 15;
      if (t === PROP.Signal) signals++;
      if (t === PROP.Lamp || t === PROP.LampDouble) lamps++;
      if (t === PROP.Tree || t === PROP.Conifer) trees++;
    }
    total += a.count;
  }
  assert.equal(signals, 4);
  assert.ok(lamps >= 4 * 5, `postes ${lamps}`);
  assert.ok(trees > 20, `árvores ${trees}`);
  assert.ok(total < 2000);
});

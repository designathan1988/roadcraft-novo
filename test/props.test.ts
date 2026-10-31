/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { buildProps, PROP, propType } from '../src/jobs/props.ts';
import { emptyBoxes } from '../src/shared/contracts/worker.ts';
import { cellId, cellX } from '../src/core/grid.ts';

import { Zone } from '../src/roads/zones.ts';
import { Ctl } from '../src/roads/control.ts';
import type { SegId } from '../src/core/ids.ts';

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
  const segs: SegId[] = [];
  net.forSegsNear(-300, -300, 300, 300, (s) => segs.push(s));
  // automático: avenida principal, a rua dá a preferência (placas, sem semáforo)
  let auto = 0;
  for (let i = 0; i < 4; i++) { const g = net.gather(segs, []); const r = buildProps(w.heights, g, emptyBoxes(0), [cellId(cellX(-1), cellX(-1)), cellId(cellX(1), cellX(-1)), cellId(cellX(-1), cellX(1)), cellId(cellX(1), cellX(1))][i]);
    for (let k = 0; k < r.count; k++) if (propType(r.extra[k]) === PROP.Signal) auto++; }
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
      const t = propType(a.extra[i]);
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

test('no wild tree roots on a cliff (Roadcraft 4.0 renderer.ts:2984 natureOpen: grade over 0.75)', async () => {
  const { sampleOfIndex, worldOfSample } = await import('../src/world/heights.ts');
  const { cellOriginX } = await import('../src/core/grid.ts');
  const { wildGrade, WILD_MAX_GRADE } = await import('../src/jobs/props.ts');
  const w = new World();
  const cx = cellX(300), ox = cellOriginX(cx);
  // a mesa's wall across the cell: flat, 60 m up over 40 m (grade 1.5), flat on top
  for (let i = 0; i < w.heights.length; i++) {
    const [gx] = sampleOfIndex(i);
    const x = worldOfSample(gx) - ox;
    w.heights[i] = 10 + Math.min(60, Math.max(0, (x - 100) * 1.5));
  }
  const r = buildProps(w.heights, new World().roads.gather([], []), emptyBoxes(0), cellId(cx, cx));
  let flat = 0, steep = 0;
  for (let k = 0; k < r.count; k++) {
    const t = propType(r.extra[k]);
    if (t !== PROP.Tree && t !== PROP.Oak && t !== PROP.Conifer && t !== PROP.Palm && t !== PROP.Bush) continue;
    const g = wildGrade(w.heights, r.data[k * 4], r.data[k * 4 + 2]);
    if (g > WILD_MAX_GRADE) steep++; else flat++;
  }
  assert.ok(flat > 100, `plants on the level ground ${flat}`);
  assert.equal(steep, 0, 'plants on the cliff');
});

test('D15: a prop type is read with its 5 bits (a type over 15 is not the signal)', () => {
  // the format: type & 31, the key above it (src/jobs/props.ts); the old & 15 read type 16 + Signal as a Signal
  const extra = ((PROP.Signal + 16) | (7 << 5)) >>> 0;
  assert.notEqual(propType(extra), PROP.Signal);
  assert.equal(propType(extra), PROP.Signal + 16);
});

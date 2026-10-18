/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, decodeDesign, encodeDesign, hasDesign, type Design } from '../src/world/design.ts';
import { World } from '../src/world/world.ts';
import { generateTerrainTile } from '../src/jobs/terrainGen.ts';
import { buildBuildings, planCells } from '../src/jobs/buildingGen.ts';
import { emptyBoxes } from '../src/jobs/protocol.ts';
import { Zone } from '../src/roads/zones.ts';
import { facadeWindowTable, ARCHES, PATTERN_COUNT } from '../src/world/arch.ts';

test('projeto: ida e volta pelos bits do registro, com o catálogo', () => {
  const d: Design = { shape: 5, roof: 3, finish: 6, gear: 0x2b, setback: 9, wall: 0x3d5568, windows: 4, wing: 2, catalog: 37 };
  const { color, h } = encodeDesign(d);
  assert.ok(hasDesign(color));
  assert.deepEqual(decodeDesign(color, h), d);
  for (let k = 0; k <= CATALOG.length; k++) assert.equal(decodeDesign(encodeDesign({ ...d, catalog: k }).color, h).catalog, k);
});

test('catálogo: 38 projetos do Roadcraft, volumes dentro do lote e com andares', () => {
  assert.equal(CATALOG.length, 38);
  for (const e of CATALOG) {
    assert.ok(e.w > 5 && e.d > 5 && e.gh > 2 && e.sh > 2, e.name);
    const solid = e.vols.filter((v) => (v[5] as number) > 0);
    assert.ok(solid.length > 0, e.name);
    for (const v of e.vols) assert.ok((v[0] as number) >= -e.w / 2 - 0.01 && (v[0] as number) + (v[2] as number) <= e.w / 2 + 0.01, `${e.name} x`);
  }
  assert.equal(facadeWindowTable().length, ARCHES.length * PATTERN_COUNT);
});

test('marcos e padrões: determinísticos, o mesmo marco nunca a menos de 250 m na célula', () => {
  const w = new World();
  for (const t of [44, 45, 54, 55]) generateTerrainTile(w.heights, t, 1);
  // 30 torres comerciais numa célula (a célula 0..256 do ladrilho do centro)
  const b = emptyBoxes(30);
  for (let i = 0; i < 30; i++) {
    b.x[i] = 20 + (i % 6) * 40; b.z[i] = 20 + Math.floor(i / 6) * 45; b.w[i] = 34; b.d[i] = 40;
    b.zone[i] = Zone.Commercial; b.floors[i] = 12 + (i % 9); b.seed[i] = 5000 + i * 7919; b.style[i] = (i * 53) % 128;
  }
  b.count = 30;
  const a = buildBuildings(w.heights, b, 0, 0, 256, 0)!, c = buildBuildings(w.heights, b, 0, 0, 256, 0)!;
  assert.deepEqual(a, c);
  // the same plan whatever the batch (a cell alone or inside a tile): build twice with a shuffled order
  const r = emptyBoxes(30);
  const order = [...Array(30).keys()].reverse();
  for (const k of ['x', 'z', 'w', 'd', 'zone', 'floors', 'seed', 'style'] as const) order.forEach((src, dst) => { (r[k] as Float32Array)[dst] = (b[k] as Float32Array)[src]; });
  r.count = 30;
  const m2 = buildBuildings(w.heights, r, 0, 0, 256, 0)!;
  assert.equal(m2.vertexCount, a.vertexCount);
  const plan = planCells(b);
  let marks = 0;
  for (let i = 0; i < 30; i++) {
    if (!plan.landmark[i]) continue;
    marks++;
    for (let j = 0; j < 30; j++) if (j !== i && plan.landmark[j] === plan.landmark[i]) assert.ok(Math.hypot(b.x[i] - b.x[j], b.z[i] - b.z[j]) >= 250);
  }
  assert.ok(marks >= 2 && marks <= 14, marks + " marcos");
  const kinds = new Set(Array.from(plan.pattern));
  assert.ok(kinds.size >= 3, [...kinds].join(","));
});

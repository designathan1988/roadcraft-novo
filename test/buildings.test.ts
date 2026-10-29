/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { generateTerrainTile } from '../src/jobs/terrainGen.ts';
import { buildBuildings } from '../src/jobs/buildingGen.ts';
import { emptyBoxes } from '../src/shared/contracts/worker.ts';
import { Zone } from '../src/roads/zones.ts';

/** Um prédio de cada tipo, lado a lado, numa célula perto do centro. */
function sample() {
  const b = emptyBoxes(5);
  const kinds: Array<[number, number, number, number]> = [
    [Zone.Residential, 2, 16, 30], [Zone.Residential, 9, 20, 32], [Zone.Commercial, 18, 26, 38],
    [Zone.Industrial, 2, 44, 52], [Zone.Mixed, 6, 18, 34],
  ];
  kinds.forEach(([zone, floors, w, d], i) => {
    b.x[i] = 40 + i * 50; b.z[i] = 60; b.w[i] = w; b.d[i] = d; b.rot[i] = i * 0.7;
    b.zone[i] = zone; b.floors[i] = floors; b.seed[i] = 1000 + i * 7919; b.style[i] = i * 37;
  });
  b.count = 5;
  return b;
}

test('gerador de prédios: determinístico, índices válidos, fachada preenchida', () => {
  const w = new World();
  for (const t of [44, 45, 54, 55]) generateTerrainTile(w.heights, t, 1);
  const a = buildBuildings(w.heights, sample(), 0, 0, 256, 0)!;
  const b = buildBuildings(w.heights, sample(), 0, 0, 256, 0)!;
  assert.deepEqual(a, b);
  assert.ok(a.fac && a.fuv);
  for (let i = 0; i < a.index.length; i++) assert.ok(a.index[i] < a.vertexCount);
  // alguma parede com janelas (coluna > 0) e alguma cega
  let withWin = 0, blank = 0;
  for (let i = 0; i < a.vertexCount; i++) (a.fac[i * 4 + 3] > 0 ? withWin++ : blank++);
  assert.ok(withWin > 0 && blank > 0);
  // longe (lod 1) é bem mais leve
  const far = buildBuildings(w.heights, sample(), 0, 0, 1024, 1)!;
  assert.ok(far.vertexCount < a.vertexCount * 0.6, `${far.vertexCount} vs ${a.vertexCount}`);
});

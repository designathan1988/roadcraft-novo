/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FINISH_COUNT, FINISH_SIZE, bakeFinishes } from '../src/jobs/buildingFinishes.ts';
import { World } from '../src/world/world.ts';
import { generateTerrainTile } from '../src/jobs/terrainGen.ts';
import { buildBuildings } from '../src/jobs/buildingGen.ts';
import { emptyBoxes } from '../src/jobs/protocol.ts';
import { Zone } from '../src/roads/zones.ts';

test('acabamentos: 13 camadas, determinísticas, tom médio 0,5 e normal unitária', () => {
  const a = bakeFinishes(), b = bakeFinishes();
  assert.equal(a.albedo.length, FINISH_SIZE * FINISH_SIZE * 4 * FINISH_COUNT);
  assert.deepEqual(a.albedo, b.albedo);
  assert.deepEqual(a.normal, b.normal);
  const n = FINISH_SIZE * FINISH_SIZE;
  for (let k = 0; k < FINISH_COUNT; k++) {
    let lum = 0, minZ = 255;
    for (let i = 0; i < n; i++) {
      const p = (k * n + i) * 4;
      lum += 0.2126 * a.albedo[p] + 0.7152 * a.albedo[p + 1] + 0.0722 * a.albedo[p + 2];
      minZ = Math.min(minZ, a.normal[p + 2]);
    }
    const mean = lum / n / 255;
    assert.ok(Math.abs(mean - 0.5) < 0.03, `camada ${k}: tom médio ${mean}`);
    assert.ok(minZ > 128, `camada ${k}: normal virada (${minZ})`);
  }
});

test('acabamentos: periódicos (a borda continua na borda oposta)', () => {
  const { albedo } = bakeFinishes();
  const S = FINISH_SIZE, n = S * S;
  for (let k = 0; k < FINISH_COUNT; k++) {
    // a diferença entre a última e a primeira coluna não pode ser maior que entre colunas vizinhas do meio
    let edge = 0, mid = 0;
    for (let y = 0; y < S; y++) {
      const at = (x: number) => albedo[(k * n + y * S + x) * 4 + 1];
      edge += Math.abs(at(S - 1) - at(0));
      mid += Math.abs(at(S / 2) - at(S / 2 - 1));
    }
    assert.ok(edge <= mid * 3 + S * 8, `camada ${k}: emenda ${edge} vs ${mid}`);
  }
});

test('gerador: acabamento no nibble alto do material, material no baixo', () => {
  const w = new World();
  for (const t of [44, 45, 54, 55]) generateTerrainTile(w.heights, t, 1);
  const b = emptyBoxes(3);
  [[Zone.Residential, 6], [Zone.Commercial, 18], [Zone.Industrial, 2]].forEach(([zone, floors], i) => {
    b.x[i] = 40 + i * 60; b.z[i] = 60; b.w[i] = 24; b.d[i] = 34; b.zone[i] = zone; b.floors[i] = floors; b.seed[i] = 77 + i * 31; b.style[i] = i * 40;
  });
  b.count = 3;
  const m = buildBuildings(w.heights, b, 0, 0, 256, 0)!;
  let withFin = 0;
  for (let i = 0; i < m.vertexCount; i++) {
    const byte = m.color[i * 4 + 3];
    assert.ok((byte & 15) <= 9, `material ${byte & 15}`);
    assert.ok(byte >> 4 <= 13, `acabamento ${byte >> 4}`);
    if (byte >> 4) withFin++;
  }
  assert.ok(withFin > m.vertexCount / 4, `${withFin} de ${m.vertexCount}`);
});

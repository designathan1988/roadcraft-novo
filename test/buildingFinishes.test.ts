/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { COOKED_FILES, COOKED_FINISHES, FIN, FINISH_COUNT, FINISH_KEYS, FINISH_SIZE, packFinishes } from '../src/jobs/buildingFinishes.ts';
import { World } from '../src/world/world.ts';
import { generateTerrainTile } from '../src/jobs/terrainGen.ts';
import { buildBuildings } from '../src/jobs/buildingGen.ts';
import { emptyBoxes } from '../src/jobs/protocol.ts';
import { Zone } from '../src/roads/zones.ts';

/** Level 0 of a cooked finish file (public/cooked/surfaces), decoded as the worker does. */
async function cooked(file: string): Promise<Uint8Array> {
  const { read } = await import('three/examples/jsm/libs/ktx-parse.module.js');
  const { ZSTDDecoder } = await import('three/examples/jsm/libs/zstddec.module.js');
  const z = new ZSTDDecoder();
  await z.init();
  const c = read(new Uint8Array(fs.readFileSync(new URL('../public/cooked/surfaces/' + file, import.meta.url))));
  assert.equal(c.pixelWidth, FINISH_SIZE);
  assert.equal(c.layerCount, FINISH_COUNT);
  return z.decode(c.levels[0].levelData, c.levels[0].uncompressedByteLength);
}

test('acabamentos: as 13 camadas cozidas da 4.0, na ordem dos ids do motor', async () => {
  const map = await cooked(COOKED_FILES.map), normal = await cooked(COOKED_FILES.normal), rough = await cooked(COOKED_FILES.rough);
  const out = packFinishes(map, normal, rough);
  const per = FINISH_SIZE * FINISH_SIZE * 4;
  assert.equal(out.albedo.length, per * FINISH_COUNT);
  // the layer of each id is the 4.0 layer of the same name: the mean colour of brick is red, of slate dark, of glass black
  const mean = (arr: Uint8Array, id: number, ch: number) => { let t = 0; for (let i = (id - 1) * per + ch; i < id * per; i += 4 * 13) t += arr[i]; return t / (per / 52) / 255; };
  for (let id = 1; id <= FINISH_COUNT; id++) {
    const k = COOKED_FINISHES.indexOf(FINISH_KEYS[id - 1]);
    for (const ch of [0, 1, 2]) assert.equal(out.albedo[(id - 1) * per + 4 * 1000 + ch], map[k * per + 4 * 1000 + ch], `${FINISH_KEYS[id - 1]} colour`);
    assert.equal(out.albedo[(id - 1) * per + 4 * 1000 + 3], rough[k * per + 4 * 1000 + 1], `${FINISH_KEYS[id - 1]} roughness`);
    assert.ok(mean(out.normal, id, 2) > 0.85, `${FINISH_KEYS[id - 1]}: normal facing out`);
  }
  assert.ok(mean(out.albedo, FIN.Brick, 0) > mean(out.albedo, FIN.Brick, 2) + 0.01, 'brick is warm');
  assert.ok(mean(out.albedo, FIN.Slate, 0) < 0.6 && mean(out.albedo, FIN.Glass, 0) < 0.4, 'slate and glass are dark');
  assert.ok(mean(out.albedo, FIN.Glass, 3) < 0.4 && mean(out.albedo, FIN.Plaster, 3) > 0.85, 'glass smooth, plaster rough');
  // the metal mask: only glass reads it from the map (the mullions); every other finish is whole
  assert.ok(mean(out.normal, FIN.Plaster, 3) > 0.99);
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

test('peças de fachada: mesmo sorteio da malha, determinísticas, variantes 8..15', async () => {
  const { buildBuildingParts, PART } = await import('../src/jobs/buildingGen.ts');
  const w = new World();
  for (const t of [44, 45, 54, 55]) generateTerrainTile(w.heights, t, 1);
  const b = emptyBoxes(4);
  [[Zone.Residential, 7], [Zone.Mixed, 6], [Zone.Commercial, 16], [Zone.Residential, 1]].forEach(([zone, floors], i) => {
    b.x[i] = 40 + i * 50; b.z[i] = 60; b.w[i] = 24; b.d[i] = 34; b.zone[i] = zone; b.floors[i] = floors; b.seed[i] = 911 + i * 77; b.style[i] = 10 + i * 30;
  });
  b.count = 4;
  const run = () => { const out: number[] = []; buildBuildingParts(w.heights, b, (v, x, y, z, yaw, s) => out.push(v, x, y, z, yaw, s)); return out; };
  const a = run(), c = run();
  assert.deepEqual(a, c);
  assert.ok(a.length / 6 > 5, `${a.length / 6} peças`);
  const kinds = new Set<number>();
  for (let k = 0; k < a.length; k += 6) { assert.ok(a[k] >= 8 && a[k] <= 15); kinds.add(a[k]); }
  assert.ok(kinds.has(PART.WallAc) || kinds.has(PART.RoofAc), [...kinds].join(','));
});

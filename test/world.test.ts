/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TILE_COUNT } from '../src/core/grid.ts';
import { HEIGHT_TILE_RES } from '../src/config.ts';
import { World } from '../src/world/world.ts';
import { BrushStroke } from '../src/world/brush.ts';
import { CommandStack } from '../src/core/commands.ts';
import { heightAt, heightIndex } from '../src/world/heights.ts';
import { generateTerrainTile } from '../src/jobs/terrainGen.ts';
import { debugTileBoxes } from '../src/jobs/debugCity.ts';
import { buildBoxMesh } from '../src/jobs/boxMesh.ts';
import { encodeTile, decodeTile, packTileHeights, unpackTileHeights } from '../src/jobs/storage.ts';
import { encodeMeta, decodeMeta } from '../src/save.ts';
import { createPoseBuffers, viewPoseBuffers, PoseReader, PoseWriter } from '../src/sim/poses.ts';

test('relevo é determinístico pela semente', () => {
  const a = new World(), b = new World();
  const ra = generateTerrainTile(a.heights, 44, 7);
  const rb = generateTerrainTile(b.heights, 44, 7);
  assert.deepEqual(ra, rb);
  const s = heightIndex(44 % 10 * HEIGHT_TILE_RES, Math.floor(44 / 10) * HEIGHT_TILE_RES);
  assert.deepEqual(a.heights.subarray(s, s + 65536), b.heights.subarray(s, s + 65536));
});

test('cidade de teste é determinística e cabe no orçamento', () => {
  const w = new World();
  for (let t = 0; t < TILE_COUNT; t++) generateTerrainTile(w.heights, t, 1);
  const a = debugTileBoxes(55, 1), b = debugTileBoxes(55, 1);
  assert.deepEqual(a, b);
  let total = 0;
  for (let t = 0; t < TILE_COUNT; t++) total += debugTileBoxes(t, 1).count;
  assert.ok(total > 50000 && total < 120000, `total ${total}`);
});

test('traço de pincel desfaz e refaz exatamente', () => {
  const w = new World();
  for (const t of [44, 45, 54, 55]) generateTerrainTile(w.heights, t, 3);
  const before = w.heights.slice();
  const cmds = new CommandStack();
  const s = new BrushStroke(w);
  // em cima da junção de 4 ladrilhos
  for (let i = 0; i < 10; i++) s.dab(0, 0, { mode: 'raise', radius: 40, strength: 5 }, 0.1);
  for (let i = 0; i < 5; i++) s.dab(10, 0, { mode: 'smooth', radius: 30, strength: 0.8 }, 0.1);
  assert.ok(s.finish());
  cmds.push(s);
  const after = w.heights.slice();
  assert.ok(heightAt(w.heights, 0, 0) > heightAt(new Float32Array(before), 0, 0) + 1);
  assert.ok(w.layerDirty.has(44) && w.layerDirty.has(55));
  cmds.undo();
  assert.deepEqual(w.heights, before);
  cmds.redo();
  assert.deepEqual(w.heights, after);
});

test('malha de caixas: contagens e faixa compacta', () => {
  const w = new World();
  for (let t = 0; t < TILE_COUNT; t++) generateTerrainTile(w.heights, t, 1);
  const boxes = debugTileBoxes(45, 1);
  const m = buildBoxMesh(w.heights, boxes, -1024, -1024, 1024)!;
  assert.equal(m.vertexCount, boxes.count * 20);
  assert.equal(m.index.length, boxes.count * 30);
  for (let i = 0; i < m.index.length; i++) assert.ok(m.index[i] < m.vertexCount);
});

test('salvamento de ladrilho ida e volta', () => {
  const w = new World();
  generateTerrainTile(w.heights, 12, 9);
  const boxes = debugTileBoxes(12, 9);
  const q = packTileHeights(w.heights, 12);
  const roads = { nodes: new Float32Array([7, 1.5, 2.5, 3.5]), segs: new Float32Array([3, 7, 9, 0, 0, 2, 1]), items: new Float32Array([10, 20, 1.2, 33, 22, 0]) };
  const dec = decodeTile(encodeTile(12, q, boxes, roads));
  assert.deepEqual(dec.roads, roads);
  assert.equal(dec.tile, 12);
  assert.deepEqual(dec.boxes, boxes);
  const w2 = new World();
  unpackTileHeights(w2.heights, 12, dec.heights);
  const s = heightIndex(2 * HEIGHT_TILE_RES, 1 * HEIGHT_TILE_RES);
  for (let i = 0; i < 65536; i += 97) assert.ok(Math.abs(w.heights[s + i] - w2.heights[s + i]) <= 0.005);
  const tiles = new Uint8Array(TILE_COUNT); tiles[3] = 1; tiles[99] = 1;
  const meta = decodeMeta(encodeMeta({ seed: 5, gameId: 77, tiles, camera: new Float64Array([1, 2, 3]) }));
  assert.equal(meta.seed, 5);
  assert.deepEqual(meta.tiles, tiles);
  assert.deepEqual(meta.camera, new Float64Array([1, 2, 3]));
});

test('buffer triplo de poses entrega o mais novo sem misturar', () => {
  const b = viewPoseBuffers(createPoseBuffers());
  const wr = new PoseWriter(b), rd = new PoseReader(b);
  assert.equal(rd.acquire(), false);
  wr.data[0] = 1; wr.publish(1, 0, 50, 1);
  wr.data[0] = 2; wr.publish(1, 50, 50, 2);
  assert.equal(rd.acquire(), true);
  assert.equal(rd.tick, 2);
  assert.equal(rd.data[0], 2);
  assert.equal(rd.acquire(), false);
  wr.data[0] = 3; wr.publish(1, 100, 50, 3);
  assert.equal(rd.acquire(), true);
  assert.equal(rd.data[0], 3);
  // buffers distintos
  assert.notEqual(rd.front, wr.back);
});

test('rio: água desce sempre, leito abaixo da água, desfazer volta tudo', async () => {
  const { RiverCommand, waterAt, NO_WATER, GroundStroke } = await import('../src/world/ground.ts');
  const w = new World();
  // rampa: alto no oeste, baixo no leste
  for (const t of [44, 45, 54, 55]) generateTerrainTile(w.heights, t, 3);
  for (let i = 0; i < w.heights.length; i++) w.heights[i] = 40;
  const h0 = w.heights.slice(), w0 = w.water.slice();
  const pts: Array<[number, number]> = [[-300, 10], [-100, 30], [100, 0], [300, -20]];
  const c = new RiverCommand(w, pts, 14, 2.5);
  c.apply();
  let prev = Infinity;
  for (let x = -290; x <= 290; x += 20) {
    // ponto no traço (interpolado entre os pontos dados)
    let z = 0;
    for (let i = 0; i + 1 < pts.length; i++) if (x >= pts[i][0] && x <= pts[i + 1][0]) z = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * (x - pts[i][0]) / (pts[i + 1][0] - pts[i][0]);
    const lvl = waterAt(w.water, x, z);
    assert.ok(lvl !== NO_WATER, `sem água em ${x}`);
    assert.ok(lvl <= prev + 1e-3, 'a água subiu rio abaixo');
    prev = lvl;
    assert.ok(heightAt(w.heights, x, z) < lvl - 0.5, 'leito acima da água');
  }
  c.invert();
  assert.deepEqual(w.heights, h0);
  assert.deepEqual(w.water, w0);
  // pincel de chão desfaz exato
  const g0 = w.ground32.slice();
  const s = new GroundStroke(w);
  s.dab(0, 0, 30, 'paint', 1, 1, 0.5);
  s.dab(10, 0, 30, 'forest', 0, 1, 0.5);
  assert.ok(s.finish());
  assert.notDeepEqual(w.ground32, g0);
  s.invert();
  assert.deepEqual(w.ground32, g0);
});

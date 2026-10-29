/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, polygonArea } from '../src/world/world.ts';
import { curveLotSide, joinLots, lotAt, lotOutlineWorld, moveLotCorner, nearestCorner, polygonLot, splitLot, splitLotByLine } from '../src/world/lotEdit.ts';
import { RoadJournal } from '../src/roads/build.ts';
import { SHAPE_MAX, SHAPE_SCALE, SHAPE_STRIDE } from '../src/shared/contracts/worker.ts';

function flatWorld(): World {
  const w = new World();
  w.heights.fill(10); w.tileMin.fill(10); w.tileMax.fill(10);
  w.unlimited = true;
  return w;
}

const alive = (w: World) => [...Array(w.buildings.end).keys()].filter((i) => w.buildings.alive[i]);
/** Lots as sorted text (centre, size, rotation, polygon) to compare before and after undo. */
const state = (w: World) => alive(w).map((i) => `${i}:${w.buildingRec(i).map((v) => v.toFixed(2)).join(',')}`).sort().join(' ');
const worldArea = (p: Array<[number, number]>) => Math.abs(polygonArea(p.flatMap((q) => q)));

/** A pentagon lot drawn by five clicks (first side = front), as the polygon tool does. */
function pentagon(w: World): number {
  const pts: Array<[number, number]> = [[100, 100], [140, 100], [150, 125], [120, 150], [92, 128]];
  const r = polygonLot(pts);
  assert.ok(typeof r !== 'string', String(r));
  const j = new RoadJournal(w, 'lote desenhado');
  const id = j.addBuilding({ ...r, h: 0, color: 0, seed: 5, zone: 1, floors: 2, style: 1 });
  return id;
}

test('lote de 5 lados: guardado como polígono de 5 cantos, mesma área, clique dentro e fora', () => {
  const w = flatWorld();
  const id = pentagon(w);
  assert.equal(w.buildings.cols.shapeN[id], 5);
  const out = lotOutlineWorld(w, id);
  const expected = worldArea([[100, 100], [140, 100], [150, 125], [120, 150], [92, 128]]);
  assert.ok(Math.abs(worldArea(out) - expected) < 2, `área ${worldArea(out)} contra ${expected}`);
  assert.equal(lotAt(w, 120, 120), id, 'dentro do polígono');
  // canto do retângulo envolvente que fica fora do polígono: não é o lote
  assert.equal(lotAt(w, 147, 145), -1, 'fora do polígono (dentro do retângulo)');
  // cantos guardados em decímetros, anti-horário
  const o = id * SHAPE_STRIDE;
  const local: number[] = [];
  for (let k = 0; k < 10; k++) local.push(w.lotShape[o + k] / SHAPE_SCALE);
  assert.ok(polygonArea(local) > 0, 'anti-horário');
});

test('polígono que se cruza é recusado; mais de 16 cantos também', () => {
  assert.equal(typeof polygonLot([[0, 0], [30, 30], [30, 0], [0, 30]]), 'string');
  const many: Array<[number, number]> = [];
  for (let k = 0; k < SHAPE_MAX + 2; k++) many.push([Math.cos(k / (SHAPE_MAX + 2) * 6.283) * 40, Math.sin(k / (SHAPE_MAX + 2) * 6.283) * 40]);
  assert.equal(typeof polygonLot(many), 'string');
});

test('dividir por linha: dois lotes que somam a área; juntar volta a um; desfazer volta igual', () => {
  const w = flatWorld();
  const id = pentagon(w);
  const before = state(w), area0 = worldArea(lotOutlineWorld(w, id));
  const j = splitLotByLine(w, id, 118, 90, 125, 160);
  assert.ok(typeof j !== 'string', String(j));
  const ids = alive(w);
  assert.equal(ids.length, 2);
  const sum = ids.reduce((s, i) => s + worldArea(lotOutlineWorld(w, i)), 0);
  assert.ok(Math.abs(sum - area0) < 6, `${sum} contra ${area0}`);
  const k = joinLots(w, ids[0], ids[1]);
  assert.ok(typeof k !== 'string', String(k));
  assert.equal(alive(w).length, 1);
  assert.ok(Math.abs(worldArea(lotOutlineWorld(w, alive(w)[0])) - area0) < 6, "cantos em decímetros: até 0,3 % de diferença");
  k.invert(); (j as RoadJournal).invert();
  assert.equal(state(w), before);
});

test('linha que não atravessa o lote é recusada', () => {
  const w = flatWorld();
  const id = pentagon(w);
  assert.equal(typeof splitLotByLine(w, id, 0, 0, 10, 0), 'string');
});

test('curvar lado: o lado passa pelo ponto, o lote ganha cantos e área; desfazer volta', () => {
  const w = flatWorld();
  const id = w.addBuilding({ x: 0, z: 0, w: 30, d: 40, h: 0, rot: 0, color: 0, seed: 1, zone: 1, floors: 2, style: 1 });
  const before = state(w), a0 = worldArea(lotOutlineWorld(w, id));
  // frente do lote em z = +20 (frente olha +z local; rot 0): curva para fora até z = 26
  const j = curveLotSide(w, id, 0, 19, 0, 26);
  assert.ok(typeof j !== 'string', String(j));
  const n = alive(w)[0];
  assert.ok(w.buildings.cols.shapeN[n] > 4);
  const out = lotOutlineWorld(w, n);
  assert.ok(out.some(([x, z]) => Math.abs(x) < 4 && Math.abs(z - 26) < 0.6), 'passa pelo ponto puxado');
  assert.ok(worldArea(out) > a0 + 100);
  (j as RoadJournal).invert();
  assert.equal(state(w), before);
});

test('dividir em partes e mover canto num lote em polígono', () => {
  const w = flatWorld();
  const id = pentagon(w);
  const a0 = worldArea(lotOutlineWorld(w, id));
  const j = splitLot(w, id, 'side', 2);
  assert.ok(typeof j !== 'string', String(j));
  const ids = alive(w);
  assert.equal(ids.length, 2);
  assert.ok(Math.abs(ids.reduce((s, i) => s + worldArea(lotOutlineWorld(w, i)), 0) - a0) < 2);
  const [k, d] = nearestCorner(w, ids[0], 150, 125);
  assert.ok(d < 60);
  const m = moveLotCorner(w, ids[0], k, lotOutlineWorld(w, ids[0])[k][0] + 3, lotOutlineWorld(w, ids[0])[k][1] + 2);
  assert.ok(typeof m !== 'string', String(m));
});

test('salvamento versão 7: polígono, idade e desgaste vão e voltam; versão antiga abre com idade espalhada', async () => {
  const { encodeTile, decodeTile, packTileHeights } = await import('../src/jobs/storage.ts');
  const w = flatWorld();
  const id = pentagon(w);
  w.addBuilding({ x: 300, z: 300, w: 20, d: 30, h: 0, rot: 0.3, color: 0, seed: 9, zone: 2, floors: 5, style: 3 });
  w.advanceClock(20 * 1440);
  const cells = [...new Set(alive(w).map((i) => w.buildings.cols.cell[i]))];
  const boxes = w.gatherBoxes(cells);
  const roads = { nodes: new Float32Array(0), segs: new Float32Array(0), items: new Float32Array(0) };
  const bytes = encodeTile(0, packTileHeights(w.heights, 0), boxes, roads);
  const dec = decodeTile(bytes);
  assert.deepEqual(dec.boxes, boxes);
  const k = Array.from(dec.boxes.shapeN).indexOf(5);
  assert.ok(k >= 0, 'polígono salvo');
  assert.equal(dec.boxes.decay[k], w.buildings.cols.decay[id]);
  assert.ok(w.buildings.cols.decay[id] > 0, 'aos 20 dias já tem desgaste');
  // versão 6: mesma tabela sem as quatro colunas novas
  const v6 = new Uint8Array(bytes); new DataView(v6.buffer).setUint32(4, 6, true);
  const n = boxes.count, extra = n * (1 + SHAPE_STRIDE * 2 + 4 + 1);
  const head = 16 + packTileHeights(w.heights, 0).byteLength + 4;
  const base = head + n * (4 * 8 + 1 * 4); // 8 colunas de 4 bytes + 4 de 1 byte
  const old = new Uint8Array(v6.length - extra);
  old.set(v6.subarray(0, base)); old.set(v6.subarray(base + extra), base);
  const d6 = decodeTile(old);
  assert.equal(d6.boxes.count, n);
  assert.deepEqual(Array.from(d6.boxes.shapeN), new Array(n).fill(0));
  assert.ok(Array.from(d6.boxes.built).every((b) => b >= 0 && b < 3 * 1440), 'idade espalhada num décimo do desgaste');
});

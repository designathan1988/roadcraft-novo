/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { CommandStack } from '../src/core/commands.ts';
import { buildRoad, planRoad, snap } from '../src/roads/build.ts';
import { ZoneTool } from '../src/tools/zoneTool.ts';
import { deleteLot, joinLots, lotAt, moveLotCorner, polygonRect, setLotFront, splitLot } from '../src/world/lotEdit.ts';

function flatWorld(): World {
  const w = new World();
  w.heights.fill(10); w.tileMin.fill(10); w.tileMax.fill(10);
  w.unlimited = true;
  return w;
}

function lot(w: World, x: number, z: number, wd: number, d: number, rot = 0): number {
  return w.addBuilding({ x, z, w: wd, d, h: 0, rot, color: 0, seed: 7, zone: 1, floors: 3, style: 1 });
}

test('dividir em 3 lado a lado e juntar de volta', () => {
  const w = flatWorld();
  const id = lot(w, 0, 0, 30, 20, 0.3);
  const j = splitLot(w, id, 'side', 3);
  assert.ok(typeof j !== 'string');
  assert.equal(w.buildings.size, 3);
  const c = w.buildings.cols;
  const ids = [...Array(w.buildings.end).keys()].filter((i) => w.buildings.alive[i]);
  for (const i of ids) { assert.ok(Math.abs(c.w[i] - 10) < 1e-4); assert.ok(Math.abs(c.d[i] - 20) < 1e-4); }
  // os dois primeiros (vizinhos) juntam
  const [a, b] = ids.sort((p, q) => c.x[p] - c.x[q]);
  const k = joinLots(w, a, b);
  assert.ok(typeof k !== 'string', String(k));
  assert.equal(w.buildings.size, 2);
  k.invert(); j.invert();
  assert.equal(w.buildings.size, 1);
  assert.ok(Math.abs(c.w[id] - 30) < 1e-4);
});

test('lotes sem lado em comum não juntam; pequeno demais não divide', () => {
  const w = flatWorld();
  const a = lot(w, 0, 0, 12, 20), b = lot(w, 40, 0, 12, 20);
  assert.equal(typeof joinLots(w, a, b), 'string');
  assert.equal(typeof splitLot(w, a, 'side', 3), 'string');
});

test('apagar: prédio vira lote vazio (0 andares, sem moradores); de novo some', () => {
  const w = flatWorld();
  const id = lot(w, 0, 0, 20, 30);
  const before = w.residents;
  assert.ok(before > 0);
  deleteLot(w, id);
  const empty = lotAt(w, 0, 0);
  assert.ok(empty >= 0);
  assert.equal(w.buildings.cols.floors[empty], 0);
  assert.equal(w.residents, 0);
  deleteLot(w, empty);
  assert.equal(w.buildings.size, 0);
});

test('frente: clicar no lado direito gira 90° e troca frente e fundo', () => {
  const w = flatWorld();
  const id = lot(w, 0, 0, 20, 30, 0);
  // rot 0: frente para +z, lado "direito" local (+x) é +x no mundo
  const j = setLotFront(w, id, 9.5, 0);
  assert.ok(j);
  const n = lotAt(w, 0, 0), c = w.buildings.cols;
  assert.ok(Math.abs(Math.sin(c.rot[n]) - 1) < 1e-6, 'frente para +x');
  assert.equal(c.w[n], 30); assert.equal(c.d[n], 20);
});

test('mover canto: o oposto fica parado', () => {
  const w = flatWorld();
  const id = lot(w, 0, 0, 20, 20, 0);
  // canto 2 = (+x, +z); oposto (−10, −10)
  const j = moveLotCorner(w, id, 2, 20, 15);
  assert.ok(typeof j !== 'string');
  const n = lotAt(w, 0, 0), c = w.buildings.cols;
  assert.ok(Math.abs(c.w[n] - 30) < 1e-4 && Math.abs(c.d[n] - 25) < 1e-4);
  assert.ok(Math.abs(c.x[n] - c.w[n] / 2 + 10) < 1e-4 && Math.abs(c.z[n] - c.d[n] / 2 + 10) < 1e-4);
});

test('polígono: o retângulo que contém os pontos, frente no primeiro lado', () => {
  const r = polygonRect([[0, 0], [20, 0], [20, 30], [10, 36], [0, 30]])!;
  assert.ok(r);
  assert.ok(Math.abs(r.w * r.d - 20 * 36) < 1);
  // primeiro lado (0,0)-(20,0) é a frente: aponta para −z
  assert.ok(Math.cos(r.rot) < -0.99, `rot ${r.rot}`);
  assert.ok(Math.abs(r.w - 20) < 0.01);
});

test('quadra inteira: as quatro ruas em volta recebem a zona do lado de dentro', () => {
  const w = flatWorld();
  const road = (ax: number, az: number, bx: number, bz: number) => {
    const a = snap(w.roads, ax, az, 8), b = snap(w.roads, bx, bz, 8);
    const p = planRoad(w, a, null, b, 0, 0);
    assert.ok(p.ok, p.reason);
    buildRoad(w, p, a, b, 0).settle();
  };
  road(-50, -50, 50, -50); road(50, -50, 50, 50); road(50, 50, -50, 50); road(-50, 50, -50, -50);
  road(50, -50, 150, -50); // rua de fora, não pode ser zoneada
  const cmds = new CommandStack();
  const zt = new ZoneTool(w, cmds);
  zt.zone = 2;
  assert.equal(zt.fillBlock(0, 0), 'ok');
  const sc = w.roads.segs.cols;
  let inside = 0, outside = 0;
  for (let s = 0; s < w.roads.segs.end; s++) {
    if (!w.roads.segs.alive[s]) continue;
    const zoned = sc.zl[s] === 2 || sc.zr[s] === 2;
    if (sc.mx[s] > 60) { if (zoned) outside++; } else if (zoned) inside++;
    if (sc.mx[s] <= 60) assert.ok(!(sc.zl[s] === 2 && sc.zr[s] === 2), 'só um lado');
  }
  assert.ok(inside >= 4, `trechos da quadra: ${inside}`);
  assert.equal(outside, 0);
  cmds.undo();
  for (let s = 0; s < w.roads.segs.end; s++) if (w.roads.segs.alive[s]) assert.ok(sc.zl[s] !== 2 && sc.zr[s] !== 2);
});

test('salvamento: lotes editados (vazio, dividido) voltam iguais', async () => {
  const { encodeTile, decodeTile, packTileHeights } = await import('../src/jobs/storage.ts');
  const w = flatWorld();
  const id = lot(w, 10, 10, 30, 20, 0.4);
  splitLot(w, id, 'depth', 2);
  deleteLot(w, lotAt(w, 10, 10) >= 0 ? lotAt(w, 10, 10) : [...Array(w.buildings.end).keys()].find((i) => w.buildings.alive[i])!);
  const cells = [...new Set([...Array(w.buildings.end).keys()].filter((i) => w.buildings.alive[i]).map((i) => w.buildings.cols.cell[i]))];
  const boxes = w.gatherBoxes(cells);
  const roads = { nodes: new Float32Array(0), segs: new Float32Array(0), items: new Float32Array(0) };
  const dec = decodeTile(encodeTile(0, packTileHeights(w.heights, 0), boxes, roads));
  assert.deepEqual(dec.boxes, boxes);
  assert.ok(Array.from(dec.boxes!.floors).includes(0), 'lote vazio salvo com 0 andares');
});

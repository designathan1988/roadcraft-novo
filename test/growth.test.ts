/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { buildRoad, planRoad, snap } from '../src/roads/build.ts';
import { Growth } from '../src/world/growth.ts';
import { buildLots } from '../src/jobs/lots.ts';
import { CELL_SIZE, MAP_CELLS } from '../src/config.ts';
import { cellId, cellOriginX } from '../src/core/grid.ts';
import { Fn } from '../src/world/arch.ts';
import { Zone } from '../src/roads/zones.ts';
import type { JobPool } from '../src/jobs/pool.ts';

function flatWorld(): World {
  const w = new World();
  w.heights.fill(10); w.tileMin.fill(10); w.tileMax.fill(10);
  w.unlimited = true;
  return w;
}
function road(w: World, ax: number, az: number, bx: number, bz: number, zone: number): void {
  const a = snap(w.roads, ax, az, 8), b = snap(w.roads, bx, bz, 8);
  const p = planRoad(w, a, null, b, 0, 0);
  assert.ok(p.ok, p.reason);
  assert.ok(buildRoad(w, p, a, b, 0).settle());
  for (let s = 0; s < w.roads.segs.end; s++) if (w.roads.segs.alive[s]) { w.roads.setZone(s, 0, zone); w.roads.setZone(s, 1, zone); }
}
/** Growth with the lots computed here instead of in the worker pool. */
function growthOf(w: World): Growth {
  const g = new Growth(w, null as unknown as JobPool);
  const G = g as unknown as { setLots(c: number, l: unknown): void };
  const cells = new Set<number>();
  for (let s = 0; s < w.roads.segs.end; s++) if (w.roads.segs.alive[s]) {
    const sc = w.roads.segs.cols;
    for (const dx of [-1, 0, 1]) for (const dz of [-1, 0, 1]) cells.add(sc.cell[s] + dx + dz * MAP_CELLS);
  }
  for (const c of cells) {
    const x0 = cellOriginX(c % MAP_CELLS), z0 = cellOriginX((c / MAP_CELLS) | 0);
    const segs: number[] = [];
    w.roads.forSegsNear(x0 - 160, z0 - 160, x0 + CELL_SIZE + 160, z0 + CELL_SIZE + 160, (s) => segs.push(s));
    if (segs.length) G.setLots(c, buildLots(w.heights, w.roads.gather(segs, []), c));
  }
  return g;
}

test('loteamento gerado recusa todo lote sobre água', () => {
  const w = flatWorld();
  road(w, -100, 0, 100, 0, Zone.Residential);
  w.water.fill(11); // ground is at 10
  const c = cellId(MAP_CELLS >> 1, MAP_CELLS >> 1);
  const segs: number[] = [];
  const x0 = cellOriginX(c % MAP_CELLS), z0 = cellOriginX((c / MAP_CELLS) | 0);
  w.roads.forSegsNear(x0 - 160, z0 - 160, x0 + CELL_SIZE + 160, z0 + CELL_SIZE + 160, (s) => segs.push(s));
  const lots = buildLots(w.heights, w.roads.gather(segs, []), c, w.water);
  assert.equal(lots.count, 0);
});

test('crescimento do roadcraft: o próximo prédio é o lote livre mais perto do último (a rua enche em sequência)', () => {
  const w = flatWorld();
  road(w, -400, 0, 400, 0, Zone.Residential);
  const g = growthOf(w);
  g.rate = 1;
  const order: Array<[number, number]> = [];
  const col = w.buildings.cols;
  for (let k = 0; k < 20; k++) {
    const before = w.buildings.end;
    g.step(1, 8);
    for (let id = before; id < w.buildings.end; id++) if (w.buildings.alive[id]) order.push([col.x[id], col.z[id]]);
  }
  assert.ok(order.length >= 15, `${order.length} prédios`);
  // cada um nasce perto do anterior (lotes de 12-19 m: o vizinho, o da frente ou o seguinte)
  let jumps = 0;
  for (let k = 1; k < order.length; k++) if (Math.hypot(order[k][0] - order[k - 1][0], order[k][1] - order[k - 1][1]) > 60) jumps++;
  assert.ok(jumps <= 1, `${jumps} saltos em ${order.length}`);
});

test('no máximo 3 andares acima do vizinho mais alto (crescimento ao longo do tempo)', () => {
  const w = flatWorld();
  road(w, -300, 0, 300, 0, Zone.ResHigh); // densidade alta: torres de 8 a 18 andares
  const g = growthOf(w);
  g.rate = 1;
  for (let k = 0; k < 30; k++) g.step(1, 8);
  const col = w.buildings.cols, ids = [...Array(w.buildings.end).keys()].filter((i) => w.buildings.alive[i]);
  // em ordem de nascimento: cada um tem no máximo 3 a mais que o mais alto que já havia a 30 m
  for (let k = 1; k < ids.length; k++) {
    const id = ids[k];
    let tallest = -1;
    for (const o of ids.slice(0, k)) if (Math.hypot(col.x[o] - col.x[id], col.z[o] - col.z[id]) <= 30 + Math.max(col.w[o], col.d[o]) / 2) tallest = Math.max(tallest, col.floors[o]);
    if (tallest >= 0) assert.ok(col.floors[id] <= Math.max(1, tallest) + 3, `prédio ${k}: ${col.floors[id]} andares ao lado de ${tallest}`);
  }
  assert.ok(Math.max(...ids.map((i) => col.floors[i])) > 3, 'ainda sobe aos poucos');
});

test('uma praça por bairro (2×2 células): nunca duas', () => {
  const w = flatWorld();
  // um bairro com ruas em grade
  for (let z = -200; z <= 200; z += 100) road(w, -250, z, 250, z, Zone.Residential);
  const g = growthOf(w);
  g.fillAll();
  const col = w.buildings.cols;
  const byHood = new Map<string, number>();
  for (let id = 0; id < w.buildings.end; id++) {
    if (!w.buildings.alive[id] || col.fn[id] !== Fn.Square) continue;
    const c = col.cell[id], key = `${(c % MAP_CELLS) >> 1},${((c / MAP_CELLS) | 0) >> 1}`;
    byHood.set(key, (byHood.get(key) ?? 0) + 1);
  }
  assert.ok(byHood.size >= 1, 'há praça');
  for (const [k, n] of byHood) assert.equal(n, 1, `bairro ${k} com ${n} praças`);
});

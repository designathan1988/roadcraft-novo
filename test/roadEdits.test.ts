/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { buildRoad, duplicateRoad, joinAt, moveNode, planRoad, reverseRoad, snap, splitAt } from '../src/roads/build.ts';
import { PROFILE_INFO } from '../src/roads/profiles.ts';

function flatWorld(): World {
  const w = new World();
  w.heights.fill(10); w.tileMin.fill(10); w.tileMax.fill(10);
  w.unlimited = true;
  return w;
}

function road(w: World, ax: number, az: number, bx: number, bz: number, profile = 0): void {
  const a = snap(w.roads, ax, az, 8), b = snap(w.roads, bx, bz, 8);
  const p = planRoad(w, a, null, b, profile, 0);
  assert.ok(p.ok, p.reason);
  assert.ok(buildRoad(w, p, a, b, profile).settle());
}

/** Rede como texto ordenado (pontas e perfis), para comparar antes e depois de desfazer. */
function shape(w: World): string {
  const net = w.roads, sc = net.segs.cols, nc = net.nodes.cols, out: string[] = [];
  for (let s = 0; s < net.segs.end; s++) if (net.segs.alive[s]) {
    const a = sc.a[s], b = sc.b[s];
    out.push(`${nc.x[a].toFixed(1)},${nc.z[a].toFixed(1)}>${nc.x[b].toFixed(1)},${nc.z[b].toFixed(1)}:${sc.profile[s]}`);
  }
  return out.sort().join(' ');
}

test('dividir e unir: dois trechos e de volta a um; desfazer volta igual', () => {
  const w = flatWorld();
  road(w, -50, 0, 50, 0);
  const before = shape(w);
  const s = [...Array(w.roads.segs.end).keys()].find((i) => w.roads.segs.alive[i])!;
  const j = splitAt(w, s, 0.5);
  assert.equal(w.roads.segs.size, 2);
  const mid = w.roads.nearestNode(0, 0, 3);
  assert.ok(mid >= 0);
  const k = joinAt(w, mid);
  assert.ok(!k.empty);
  assert.equal(w.roads.segs.size, 1);
  k.invert(); j.invert();
  assert.equal(shape(w), before);
});

test('inverter mão única troca as pontas da rua inteira; desfazer volta', () => {
  const w = flatWorld();
  const one = PROFILE_INFO.findIndex((p) => p.oneWay && !p.ring && !p.rail);
  road(w, -150, 0, 150, 0, one); // mais de um trecho (até 112 m cada)
  assert.ok(w.roads.segs.size >= 3);
  const before = shape(w);
  const s = w.roads.nearestSeg(0, 0, 5)![0];
  const j = reverseRoad(w, s);
  const sc = w.roads.segs.cols, nc = w.roads.nodes.cols;
  for (let i = 0; i < w.roads.segs.end; i++) if (w.roads.segs.alive[i]) assert.ok(nc.x[sc.a[i]] > nc.x[sc.b[i]], 'todos de leste para oeste');
  j.invert();
  assert.equal(shape(w), before);
});

test('mover nó leva as vias junto; perto demais recusa', () => {
  const w = flatWorld();
  road(w, -60, 0, 0, 0);
  road(w, 0, 0, 0, 60);
  const n = w.roads.nearestNode(0, 0, 2);
  const before = shape(w);
  const j = moveNode(w, n, 10, -10);
  assert.ok(typeof j !== 'string');
  assert.equal(w.roads.nodes.cols.x[n], 10);
  assert.equal(w.roads.segsOf(n, []).length, 2);
  j.invert();
  assert.equal(shape(w), before);
  assert.equal(typeof moveNode(w, n, -57, 0), 'string');
});

test('duplicar cria uma via paralela do mesmo perfil', () => {
  const w = flatWorld();
  road(w, -100, 0, 100, 0);
  const n0 = w.roads.segs.size;
  const s = w.roads.nearestSeg(0, 0, 5)![0];
  const j = duplicateRoad(w, s);
  assert.ok(typeof j !== 'string', String(j));
  assert.ok(w.roads.segs.size >= n0 * 2);
  const off = PROFILE_INFO[0].left + PROFILE_INFO[0].right + 2;
  assert.ok(w.roads.nearestSeg(0, off, 1.5) || w.roads.nearestSeg(0, -off, 1.5));
  j.invert();
  assert.equal(w.roads.segs.size, n0);
});

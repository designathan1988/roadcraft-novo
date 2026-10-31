/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { RoadNetwork } from '../src/roads/network.ts';
import { buildRoadMesh } from '../src/jobs/roadMesh.ts';
import { armRetreats, armAngle, splitQuad, bez, bezLength, intersectQuads, type Arm } from '../src/roads/geometry.ts';
import { PROFILE_INFO } from '../src/roads/profiles.ts';
import { Dirty } from '../src/core/grid.ts';
import { heightIndex as heightIndexOf } from '../src/world/heights.ts';

function cross(net: RoadNetwork, profile = 0) {
  const c = net.addNode({ x: 0, z: 0, y: 10 });
  const ends = [[60, 0], [0, 60], [-60, 0], [0, -60]].map(([x, z]) => net.addNode({ x, z, y: 10 }));
  for (const e of ends) {
    const ex = net.nodes.cols.x[e], ez = net.nodes.cols.z[e];
    net.addSeg({ a: c, b: e, cx: ex / 2, cz: ez / 2, profile, flags: 0 });
  }
  return c;
}

test('perfis: larguras e linhas', () => {
  const local = PROFILE_INFO[0];
  assert.ok(Math.abs(local.left - local.right) < 1e-9);
  assert.equal(local.lanesFwd, 1);
  assert.equal(local.lanesBack, 1);
  // linha amarela no meio da rua de mão dupla (tracejada na rua local, dupla na avenida sem canteiro)
  assert.ok(local.lines.some((l) => l.color === 1 && Math.abs(l.u) < 1e-9));
  const av4 = PROFILE_INFO.find((p) => p.name === 'profile.avenue4Lanes')!;
  assert.ok(av4.lines.some((l) => l.kind === 3 && l.color === 1 && Math.abs(l.u) < 1e-9));
  const one = PROFILE_INFO[2];
  assert.equal(one.lanesBack, 0);
  assert.ok(!one.lines.some((l) => l.color === 1));
});

test('recuo em cruzamento em cruz e em T', () => {
  const info = PROFILE_INFO[0];
  const mk = (dx: number, dz: number): Arm => ({ dx, dz, left: info.left, right: info.right, asphLeft: info.asphaltLeft, asphRight: info.asphaltRight });
  const arms = [mk(1, 0), mk(0, 1), mk(-1, 0), mk(0, -1)].sort((a, b) => armAngle(a.dx, a.dz) - armAngle(b.dx, b.dz));
  const out = new Float64Array(4);
  armRetreats(arms, 3, out);
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(out[i] - (info.left + 3)) < 1e-6, `recuo ${out[i]}`);
  const t = [mk(1, 0), mk(-1, 0), mk(0, 1)].sort((a, b) => armAngle(a.dx, a.dz) - armAngle(b.dx, b.dz));
  const o3 = new Float64Array(3);
  armRetreats(t, 3, o3);
  for (let i = 0; i < 3; i++) assert.ok(o3[i] > info.left, `T ${o3[i]}`);
});

test('via que segue reta mudando de largura: rampa de 1 para 8', () => {
  const a: Arm = { dx: 1, dz: 0, left: 10, right: 10, asphLeft: 7, asphRight: 7 };
  const b: Arm = { dx: -1, dz: 0, left: 6, right: 6, asphLeft: 3.5, asphRight: 3.5 };
  const out = new Float64Array(2);
  armRetreats([a, b], 3, out);
  // maior mudança de meia largura: 4 m → 32 m de rampa, 16 m de cada lado
  assert.ok(Math.abs(out[0] - 16) < 1e-6 && Math.abs(out[1] - 16) < 1e-6, `rampa ${out[0]} ${out[1]}`);
  // mudança pequena: no mínimo 9,6 m (4,8 de cada lado)
  const c: Arm = { ...b, left: 9.5, right: 9.5, asphLeft: 6.6, asphRight: 6.6 };
  armRetreats([a, c], 3, out);
  assert.ok(Math.abs(out[0] - 4.8) < 1e-6, `mínimo ${out[0]}`);
});

test('divisão de curva é exata', () => {
  const q = { x0: 0, z0: 0, cx: 50, cz: 80, x1: 100, z1: 0 };
  const [a, b] = splitQuad(q, 0.3);
  const p = new Float64Array(2), r = new Float64Array(2);
  bez(q, 0.3 + 0.7 * 0.5, p); bez(b, 0.5, r);
  assert.ok(Math.hypot(p[0] - r[0], p[1] - r[1]) < 1e-9);
  assert.ok(Math.abs(bezLength(a) + bezLength(b) - bezLength(q)) < 0.05);
  const c = intersectQuads(q, { x0: 50, z0: -20, cx: 50, cz: 50, x1: 50, z1: 120 });
  assert.equal(c.length, 1);
});

test('rede: adjacência, sujeira e montagem da malha do cruzamento', () => {
  const w = new World();
  for (let i = 0; i < w.heights.length; i++) w.heights[i] = 9.9;
  const net = new RoadNetwork(w);
  const c = cross(net);
  assert.equal(net.nodes.cols.deg[c], 4);
  assert.ok(w.dirty.pending(Dirty.Roads) > 0);
  const segs: SegId[] = [], nodes: NodeId[] = [];
  for (let s = 0; s < net.segs.end; s++) if (net.segs.alive[s]) segs.push(asSeg(s));
  for (let n = 0; n < net.nodes.end; n++) if (net.nodes.alive[n]) nodes.push(asNode(n));
  const g = net.gather(segs, nodes);
  const m = buildRoadMesh(w.heights, g, -256, -256, 512, 0)!;
  assert.ok(m && m.vertexCount > 100);
  assert.ok(m.extra && m.extra.length === m.vertexCount * 4);
  for (let i = 0; i < m.index.length; i++) assert.ok(m.index[i] < m.vertexCount);
  for (const v of m.extra) assert.ok(Number.isFinite(v));
  // ribbon (longe) é mais leve
  const far = buildRoadMesh(w.heights, g, -256, -256, 512, 1)!;
  assert.ok(far.vertexCount < m.vertexCount);
});

test('remover trecho desliga dos nós', () => {
  const w = new World();
  const net = new RoadNetwork(w);
  const c = cross(net);
  const s = net.segsOf(c)[0];
  const rec = net.removeSeg(s);
  assert.equal(net.nodes.cols.deg[c], 3);
  net.addSeg(rec);
  assert.equal(net.nodes.cols.deg[c], 4);
  assert.equal(net.segs.alive[rec.id], 1);
});

import { planRoad, buildRoad, snap, demolishSeg, buildRoundabout } from '../src/roads/build.ts';
import { CommandStack } from '../src/core/commands.ts';

function flatWorld(y = 10): World {
  const w = new World();
  w.heights.fill(y);
  w.tileMin.fill(y); w.tileMax.fill(y);
  return w;
}

function snapshot(net: RoadNetwork): string {
  const out: string[] = [];
  for (let s = 0; s < net.segs.end; s++) if (net.segs.alive[s]) {
    const r = net.segRec(asSeg(s)), c = net.nodes.cols;
    out.push([s, r.a, r.b, r.profile, c.x[r.a].toFixed(2), c.z[r.a].toFixed(2), c.x[r.b].toFixed(2), c.z[r.b].toFixed(2)].join(','));
  }
  return out.sort().join('|');
}

test('construir via cruzando outra cria cruzamento; desfazer volta exato', () => {
  const w = flatWorld();
  const net = w.roads;
  const cmds = new CommandStack();
  const a0 = snap(net, -100, 0, 10), a1 = snap(net, 100, 0, 10);
  const p1 = planRoad(w, a0, null, a1, 0, 0);
  assert.ok(p1.ok, p1.reason);
  cmds.push(buildRoad(w, p1, a0, a1, 0));
  const before = snapshot(net);
  const hBefore = w.heights.slice();
  const b0 = snap(net, 0, -90, 10), b1 = snap(net, 0, 90, 10);
  const p2 = planRoad(w, b0, null, b1, 3, 0);
  assert.ok(p2.ok, p2.reason);
  assert.equal(p2.junctions.length, 1);
  cmds.push(buildRoad(w, p2, b0, b1, 3));
  // há um nó de grau 4 no meio
  const center = net.nearestNode(0, 0, 2);
  assert.ok(center >= 0);
  assert.equal(net.nodes.cols.deg[center], 4);
  const after = snapshot(net);
  cmds.undo();
  assert.equal(snapshot(net), before);
  assert.deepEqual(w.heights, hBefore);
  cmds.redo();
  assert.equal(snapshot(net), after);
});

test('via longa é dividida e começa num trecho existente (T)', () => {
  const w = flatWorld();
  const net = w.roads;
  const a0 = snap(net, -150, 0, 10), a1 = snap(net, 150, 0, 10);
  buildRoad(w, planRoad(w, a0, null, a1, 0, 0), a0, a1, 0);
  assert.ok(net.segs.size >= 3); // 300 m em pedaços de no máximo 112
  const t0 = snap(net, 30, 1, 10);
  assert.ok(t0.seg >= 0 || t0.node >= 0);
  const t1 = snap(net, 30, 80, 10);
  const p = planRoad(w, t0, null, t1, 0, 0);
  assert.ok(p.ok, p.reason);
  buildRoad(w, p, t0, t1, 0);
  const n = net.nearestNode(30, 0, 7);
  assert.ok(n >= 0 && net.nodes.cols.deg[n] === 3);
});

test('rio vira ponte: perfil sobe sobre a água', () => {
  const w = flatWorld(10);
  // vala de rio no meio
  for (let gz = 0; gz < 2560; gz++) for (let gx = 1270; gx < 1290; gx++) w.heights[heightIndexOf(gx, gz)] = -5;
  const a0 = snap(w.roads, -120, 0, 5), a1 = snap(w.roads, 120, 0, 5);
  const p = planRoad(w, a0, null, a1, 0, 0);
  assert.ok(p.ok, p.reason);
  const mid = p.profile.y[Math.floor(p.profile.y.length / 2)];
  assert.ok(mid > 5, `meio da ponte a ${mid}`);
});

test('demolir e rotatória', () => {
  const w = flatWorld();
  const net = w.roads;
  const cmds = new CommandStack();
  const a0 = snap(net, -100, 0, 10), a1 = snap(net, 100, 0, 10);
  cmds.push(buildRoad(w, planRoad(w, a0, null, a1, 0, 0), a0, a1, 0));
  const b0 = snap(net, 0, -100, 10), b1 = snap(net, 0, 100, 10);
  cmds.push(buildRoad(w, planRoad(w, b0, null, b1, 0, 0), b0, b1, 0));
  const before = snapshot(net);
  const r = buildRoundabout(w, 0, 0, 22)!;
  assert.ok(r);
  cmds.push(r);
  let ring = 0, deg3 = 0;
  for (let s = 0; s < net.segs.end; s++) if (net.segs.alive[s] && net.segs.cols.flags[s] & 1) ring++;
  for (let n = 0; n < net.nodes.end; n++) if (net.nodes.alive[n] && net.nodes.cols.deg[n] === 3) deg3++;
  assert.ok(ring >= 8, `anel com ${ring}`);
  assert.equal(deg3, 4);
  assert.equal(net.nearestNode(0, 0, 15), -1);
  cmds.undo();
  assert.equal(snapshot(net), before);
  // demolir um trecho
  const s0 = net.segsOf(net.nearestNode(0, 0, 2))[0];
  cmds.push(demolishSeg(w, s0));
  cmds.undo();
  assert.equal(snapshot(net), before);
});

test('rotatória sobre cruzamento com emendas curtas fecha um anel simples', () => {
  const w = flatWorld();
  const net = w.roads;
  for (const [a, b] of [[[500, 500], [800, 520]], [[650, 380], [660, 680]]] as Array<[[number, number], [number, number]]>) {
    const s = snap(net, a[0], a[1], 8), e = snap(net, b[0], b[1], 8);
    buildRoad(w, planRoad(w, s, null, e, 0, 0), s, e, 0);
  }
  const c = snap(net, 655, 510, 14);
  buildRoundabout(w, c.x, c.z, 22);
  const ringNodes = new Map<number, number>();
  let ringSegs = 0;
  for (let s = 0; s < net.segs.end; s++) if (net.segs.alive[s] && net.segs.cols.flags[s] & 1) {
    ringSegs++;
    for (const n of [net.segs.cols.a[s], net.segs.cols.b[s]]) ringNodes.set(n, (ringNodes.get(n) ?? 0) + 1);
  }
  assert.equal(ringNodes.size, ringSegs);
  for (const [n, k] of ringNodes) {
    assert.equal(k, 2, `nó ${n} aparece ${k} vezes no anel`);
    assert.ok(net.nodes.cols.deg[n] <= 3);
  }
});

import { buildLots } from '../src/jobs/lots.ts';
import { cellId, cellX } from '../src/core/grid.ts';
import { asNode, asSeg, type NodeId, type SegId } from '../src/core/ids.ts';

test('lotes ao longo das vias zoneadas, sem sobrepor vias nem uns aos outros', () => {
  const w = flatWorld();
  const net = w.roads;
  // grade 3x3 de ruas de 100 m, tudo residencial
  for (let i = 0; i < 3; i++) for (const h of [true, false]) {
    const c = -100 + i * 100;
    const a = h ? snap(net, -100, c, 8) : snap(net, c, -100, 8), b = h ? snap(net, 100, c, 8) : snap(net, c, 100, 8);
    buildRoad(w, planRoad(w, a, null, b, 0, 0), a, b, 0);
  }
  for (let s = 0; s < net.segs.end; s++) if (net.segs.alive[s]) { net.setZone(asSeg(s), 0, 1); net.setZone(asSeg(s), 1, 1); }
  const all: Array<{ x: number; z: number; w: number; d: number; rot: number }> = [];
  for (const [x, z] of [[-60, -60], [60, -60], [-60, 60], [60, 60], [0, 0]]) {
    const cell = cellId(cellX(x), cellX(z));
    const segs: SegId[] = [];
    net.forSegsNear(x - 400, z - 400, x + 400, z + 400, (s) => segs.push(s));
    const lots = buildLots(w.heights, net.gather(segs, []), cell);
    for (let i = 0; i < lots.count; i++) all.push({ x: lots.x[i], z: lots.z[i], w: lots.w[i], d: lots.d[i], rot: lots.rot[i] });
  }
  const uniq = new Map(all.map((l) => [`${l.x.toFixed(2)},${l.z.toFixed(2)}`, l]));
  const lots = [...uniq.values()];
  assert.ok(lots.length > 20, `lotes ${lots.length}`);
  // nenhum canto de lote em cima de via
  const corners = (l: typeof lots[0]) => {
    const s = Math.sin(l.rot), c = Math.cos(l.rot);
    return [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([a, b]) => [l.x + (a * l.w) * c + (b * l.d) * s, l.z - (a * l.w) * s + (b * l.d) * c]);
  };
  for (const l of lots) for (const [x, z] of corners(l)) {
    const near = net.nearestSeg(x, z, 5);
    assert.ok(!near, `canto (${x.toFixed(1)}, ${z.toFixed(1)}) em cima de via`);
  }
});

test('vagas por lado: perfil com e sem estacionamento de um lado, ida e volta', async () => {
  const { withParking, PROFILES: P } = await import('../src/roads/profiles.ts');
  const base = 0;
  const right = withParking(base, true, true);
  assert.ok(right >= 0 && right !== base);
  assert.equal(PROFILE_INFO[right].strips.filter((s) => s.kind === 'parking').length, 1);
  assert.ok(PROFILE_INFO[right].right > PROFILE_INFO[base].right, 'mais larga do lado direito');
  const both = withParking(right, false, true);
  assert.equal(PROFILE_INFO[both].strips.filter((s) => s.kind === 'parking').length, 2);
  const back = withParking(withParking(both, false, false), true, false);
  assert.equal(JSON.stringify(P[back].strips), JSON.stringify(P[base].strips));
});

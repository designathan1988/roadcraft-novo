/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { planRoad, buildRoad, snap } from '../src/roads/build.ts';
import { SimNet, encodeOps, decodeOp, laneDir, laneSeg } from '../src/sim/lanes.ts';
import { Traffic } from '../src/sim/traffic.ts';
import { Ctl } from '../src/roads/control.ts';
import { PROFILES, PROFILE_INFO } from '../src/roads/profiles.ts';
import { Transit } from '../src/world/transit.ts';
import type { NetOp } from '../src/roads/network.ts';
import { gridCity, traffic as trafficOf } from './simCity.ts';

function net(build: (b: (ax: number, az: number, bx: number, bz: number, prof: number) => void) => void): SimNet {
  const w = new World();
  w.heights.fill(10); w.tileMin.fill(10); w.tileMax.fill(10);
  const ops: NetOp[] = [];
  w.roads.listeners.push((op) => ops.push(op));
  build((ax, az, bx, bz, prof) => {
    const a = snap(w.roads, ax, az, 8), b = snap(w.roads, bx, bz, 8);
    const p = planRoad(w, a, null, b, prof, 0);
    assert.ok(p.ok, p.reason);
    buildRoad(w, p, a, b, prof);
  });
  const sim = new SimNet();
  const enc = encodeOps(ops);
  for (let i = 0; i < ops.length; i++) sim.apply(decodeOp(enc, i));
  sim.rebuild();
  return sim;
}

test('linha de ônibus vai e volta: as paradas da volta ficam do outro lado, as pontas são terminais; circular só se pedir', () => {
  const sim = net((b) => { b(-400, 0, 400, 0, 0); });
  const tr = new Traffic(sim);
  tr.nodesRebuilt([...Array(sim.net.nodes.end).keys()]);
  tr.density = 0;
  // quatro paradas na calçada sul (z > 0 é a direita de quem anda para +x)
  tr.setLines([{ id: 1, color: 3, buses: 2, stops: [-300, 9, -100, 9, 100, 9, 300, 9] }]);
  const ln = tr.lines[0];
  assert.equal(ln.stopLane.length, 6, 'ida 4 + volta 2');
  const dirs = ln.stopLane.map((l) => laneDir(l));
  assert.ok(dirs.slice(0, 4).every((d) => d === dirs[0]) && dirs.slice(4).every((d) => d === -dirs[0]), `sentidos ${dirs}`);
  assert.ok(ln.stopZ.slice(4).every((z) => z < 0), 'a volta para na calçada norte');
  assert.ok(ln.term.has(0) && ln.term.has(3), 'pontas terminais');
  tr.setLines([{ id: 1, color: 3, buses: 2, stops: [-300, 9, -100, 9, 100, 9, 300, 9], loop: true }]);
  assert.equal(tr.lines[0].stopLane.length, 4);
});

test('cor e circular da linha são comandos com desfazer; salvamento leva o circular', () => {
  const t = new Transit();
  const { cmd, id } = t.addLine(0);
  cmd.apply();
  const c = t.setColor(id, 11)!; c.apply();
  assert.equal(t.line(id)!.color, 11);
  c.invert();
  assert.notEqual(t.line(id)!.color, 11);
  t.setLoop(id, true)!.apply();
  const t2 = new Transit(); t2.decode(t.encode());
  assert.equal(t2.line(id)!.loop, true);
  assert.equal(t2.line(id)!.mode, 0);
});

test('passagem de nível: a cancela desce com o trem chegando e nenhum carro entra no cruzamento', () => {
  const railId = PROFILES.findIndex((p) => p.name === 'profile.doubleRailway');
  const sim = net((b) => { b(-700, 0, 700, 0, railId); b(0, -400, 0, 400, 0); b(-350, -400, -350, 400, 0); b(350, -400, 350, 400, 0); });
  const tr = new Traffic(sim);
  sim.onConnRemoved = (c) => tr.evacuateConn(c);
  tr.nodesRebuilt([...Array(sim.net.nodes.end).keys()]);
  tr.density = 1 / 20;
  tr.camX = 0; tr.camZ = 0;
  tr.signals = new Uint8Array(1 << 17);
  tr.setLines([{ id: 1, color: 3, buses: 2, stops: [-650, 0, 650, 0], mode: 1 }]);
  tr.checkWindow();
  const crossings: number[] = [];
  for (let n = 0; n < sim.net.nodes.end; n++) if (sim.net.nodes.alive[n] && sim.nodeCtl[n] === Ctl.Crossing) crossings.push(n);
  assert.equal(crossings.length, 3);
  const c = tr.veh.cols, k = sim.conns.cols;
  let downSteps = 0, entered = 0, signalSeen = 0;
  const inBox = new Set<number>();
  for (let step = 0; step < 20 * 300; step++) {
    tr.step(0.05);
    if (step % 10 === 0) tr.checkWindow();
    for (const n of crossings) if (tr.crossingDown(n)) { downSteps++; if (tr.signals[n] & 128) signalSeen++; }
    // carro que entra na caixa do cruzamento com a cancela descida
    for (let v = 0; v < tr.veh.end; v++) {
      if (!tr.veh.alive[v] || c.kind[v] === 4) { inBox.delete(v); continue; }
      const conn = c.conn[v];
      if (conn < 0) { inBox.delete(v); continue; }
      const n = k.node[conn];
      if (!crossings.includes(n) || inBox.has(v)) continue;
      inBox.add(v);
      if (tr.crossingDown(n) && c.s[v] < 1 && !PROFILE_INFO[sim.net.segs.cols.profile[laneSeg(k.from[conn])]].rail) entered++;
    }
  }
  assert.ok(downSteps > 50, `cancela desceu ${downSteps} passos`);
  assert.equal(signalSeen, downSteps, 'a página vê a cancela no buffer de sinais');
  assert.equal(entered, 0, 'carro entrou com a cancela descida');
});

test('D44: a line with more than 256 stops (out and back) addresses every one of them', () => {
  const { sim } = gridCity(4, 120);
  const tr = trafficOf(sim);
  // a stop every 10 m on the sidewalk of each horizontal street: 140 stops, 280 out and back
  const stops: number[] = [];
  for (const z of [-189, -69, 51, 171]) for (let x = -170; x <= 170; x += 10) stops.push(x, z);
  tr.setLines([{ id: 1, color: 0, buses: 1, stops }]);
  const n = tr.lines[0].stopLane.length;
  assert.ok(n > 256, `the line resolved to ${n} stops`);
  // the vehicle table's stop index holds the last stop of such a line
  const c = tr.veh.cols, v = tr.veh.alloc();
  c.stopI[v] = n - 1;
  assert.equal(c.stopI[v], n - 1);
  tr.veh.release(v);
});

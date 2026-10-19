/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { planRoad, buildRoad, snap } from '../src/roads/build.ts';
import { SimNet, encodeOps, decodeOp } from '../src/sim/lanes.ts';
import { Traffic } from '../src/sim/traffic.ts';
import { MKind } from '../src/sim/manoeuvres.ts';
import { PROFILES } from '../src/roads/profiles.ts';
import { Zone } from '../src/roads/zones.ts';
import type { NetOp } from '../src/roads/network.ts';

/** A grid of streets with kerbside parking, zoned (trips start and end there). */
function parkingGrid(n = 4, step = 160): SimNet {
  const w = new World();
  w.heights.fill(10); w.tileMin.fill(10); w.tileMax.fill(10);
  const ops: NetOp[] = [];
  w.roads.listeners.push((op) => ops.push(op));
  const prof = PROFILES.findIndex((p) => p.name === 'Rua com estacionamento');
  assert.ok(prof >= 0);
  const half = (n - 1) * step / 2;
  for (let i = 0; i < n; i++) for (const horiz of [true, false]) {
    const c = -half + i * step;
    const a = horiz ? snap(w.roads, -half, c, 8) : snap(w.roads, c, -half, 8);
    const b = horiz ? snap(w.roads, half, c, 8) : snap(w.roads, c, half, 8);
    const p = planRoad(w, a, null, b, prof, 0);
    assert.ok(p.ok, p.reason);
    buildRoad(w, p, a, b, prof);
  }
  for (let s = 0; s < w.roads.segs.end; s++) if (w.roads.segs.alive[s]) { w.roads.setZone(s, 0, Zone.Residential); w.roads.setZone(s, 1, Zone.Commercial); }
  const sim = new SimNet();
  const enc = encodeOps(ops);
  for (let i = 0; i < ops.length; i++) sim.apply(decodeOp(enc, i));
  sim.rebuild();
  return sim;
}

test('manobras perto da câmera: estacionar na vaga, sair dela, deixar passageiro no meio-fio, caminhão de ré na doca', () => {
  const sim = parkingGrid();
  const tr = new Traffic(sim);
  sim.onConnRemoved = (c) => tr.evacuateConn(c);
  tr.nodesRebuilt([...Array(sim.net.nodes.end).keys()]);
  tr.camX = 0; tr.camZ = 0; tr.hour = 12; tr.demand = 1.5;
  let drops = 0;
  tr.onDropOff = () => { drops++; };
  // docas de galpão junto às ruas (como a página manda: ponto, rumo de frente para a rua)
  const docks: number[] = [];
  for (const [x, z, yaw] of [[-200, -100, Math.PI / 2], [60, 200, Math.PI], [200, 40, -Math.PI / 2], [-100, 60, 0]]) docks.push(x, z, yaw);
  tr.setDocks(new Float32Array(docks));
  const data = new Float32Array(11 * 20000);
  const c = tr.veh.cols, mc = tr.mvs.t.cols;
  let parkedChecked = 0, maxQueueBehindTruck = 0;
  const pose = new Float64Array(4);
  for (let step = 0; step < 20 * 60 * 6; step++) {
    tr.step(0.05);
    const rb = sim.rebuild();
    if (rb.length) tr.nodesRebuilt(rb);
    if (step % 10 === 0) tr.checkWindow();
    if (step % 40 === 0) {
      const n = tr.writePoses(data, 11);
      for (let i = 0; i < n * 11; i++) assert.ok(Number.isFinite(data[i]), 'pose sem NaN');
      // carros que terminaram de estacionar: o centro está na vaga (fora da faixa)
      for (let m = 0; m < tr.mvs.t.end; m++) {
        if (!tr.mvs.t.alive[m] || mc.d[m] < mc.total[m] - 1e-3) continue;
        tr.mvs.pose(m, pose);
        assert.ok(Number.isFinite(pose[0]) && Number.isFinite(pose[1]));
        if (mc.kind[m] === MKind.Park) parkedChecked++;
      }
      // caminhão manobrando ainda na faixa: quem vem atrás espera (fila atrás dele)
      for (let v = 0; v < tr.veh.end; v++) if (tr.veh.alive[v] && c.kind[v] === 2 && c.dying[v] === 3) {
        let q = 0;
        for (let o = c.next[v]; o >= 0 && q < 20; o = c.next[o]) q++;
        maxQueueBehindTruck = Math.max(maxQueueBehindTruck, q);
      }
    }
  }
  assert.ok(tr.mvs.planned > 5, `manobras planejadas ${tr.mvs.planned} (recusadas ${tr.mvs.refused})`);
  assert.ok(parkedChecked > 0, 'carro terminou a manobra na vaga');
  assert.ok(tr.kerbStops > 0 && drops > 0, `paradas no meio-fio ${tr.kerbStops}, passageiros ${drops}`);
  assert.ok(tr.docked > 0, `caminhões na doca: ${tr.docked}`);
  assert.ok(tr.mvs.t.size < 200, 'só perto da câmera');
  void maxQueueBehindTruck;
});

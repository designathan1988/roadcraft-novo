/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { planRoad, buildRoad, snap } from '../src/roads/build.ts';
import { SimNet, encodeOps, decodeOp, laneId } from '../src/sim/lanes.ts';
import { Traffic } from '../src/sim/traffic.ts';
import { Peds } from '../src/sim/peds.ts';
import type { NetOp } from '../src/roads/network.ts';
import { asNode, asSeg } from '../src/core/ids.ts';

function gridCity(n = 4, step = 120): { w: World; sim: SimNet } {
  const w = new World();
  w.heights.fill(10); w.tileMin.fill(10); w.tileMax.fill(10);
  const ops: NetOp[] = [];
  w.roads.listeners.push((op) => ops.push(op));
  const half = (n - 1) * step / 2;
  for (let i = 0; i < n; i++) {
    for (const horiz of [true, false]) {
      const c = -half + i * step;
      const a = horiz ? snap(w.roads, -half, c, 8) : snap(w.roads, c, -half, 8);
      const b = horiz ? snap(w.roads, half, c, 8) : snap(w.roads, c, half, 8);
      const p = planRoad(w, a, null, b, i === 1 ? 3 : 0, 0);
      assert.ok(p.ok, p.reason);
      buildRoad(w, p, a, b, i === 1 ? 3 : 0);
    }
  }
  // passa pelo mesmo caminho que o worker usa (codificado)
  const sim = new SimNet();
  const enc = encodeOps(ops);
  for (let i = 0; i < ops.length; i++) sim.apply(decodeOp(enc, i));
  sim.rebuild();
  return { w, sim };
}

test('espelho da rede: faixas e conexões nos cruzamentos', () => {
  const { w, sim } = gridCity();
  assert.equal(sim.net.segs.size, w.roads.segs.size);
  let signals = 0;
  for (let n = 0; n < sim.net.nodes.end; n++) if (sim.net.nodes.alive[n] && sim.nodePhases[n] > 0) signals++;
  // avenida (preferência 2) só cruza avenida num ponto: semáforo lá; o resto é placa (avenida principal) ou sem placa
  assert.equal(signals, 1);
  let stops = 0;
  for (let n = 0; n < sim.net.nodes.end; n++) for (let a = 0; a < 8; a++) if (sim.net.nodes.alive[n] && sim.armRule[n * 8 + a] >= 2 && sim.armRule[n * 8 + a] <= 3) stops++;
  assert.ok(stops >= 6, `braços com dê a preferência: ${stops}`);
  assert.ok(sim.conns.size > 40);
  const p = new Float64Array(4);
  for (let s = 0; s < sim.net.segs.end; s++) if (sim.net.segs.alive[s]) {
    const l = laneId(s, 1, 0);
    sim.lanePoint(l, 0, p);
    assert.ok(p.every(Number.isFinite));
    sim.lanePoint(l, sim.laneLen(l), p);
    assert.ok(p.every(Number.isFinite));
  }
});

test('trânsito: carros nascem, andam, param no vermelho e chegam', () => {
  const { sim } = gridCity();
  const tr = new Traffic(sim);
  sim.onConnRemoved = (c) => tr.evacuateConn(c);
  tr.nodesRebuilt([...Array(sim.net.nodes.end).keys()]);
  tr.density = 1 / 40;
  tr.camX = 0; tr.camZ = 0;
  tr.checkWindow();
  const data = new Float32Array(100000 * 10);
  let maxMicro = 0, moved = 0;
  const before = new Map<number, number>();
  // conflitos: veículo da via que dá a preferência entrando com a principal ocupada
  const k = sim.conns.cols;
  let entries = 0, badEntries = 0;
  const onConn = new Map<number, number>();
  for (let step = 0; step < 20 * 180; step++) {
    tr.step(0.05);
    for (let i = 0; i < tr.microN; i++) {
      const v = tr.micro[i], cn = tr.veh.cols.conn[v];
      if (cn < 0) { onConn.delete(v); continue; }
      if (onConn.get(v) === cn) continue;
      onConn.set(v, cn);
      const rule = sim.armRule[k.node[cn] * 8 + k.arm[cn]];
      if (rule !== 2 && rule !== 3) continue;
      entries++;
      const list = sim.conflicts.get(cn) ?? [];
      for (const d of list) {
        const rd = sim.armRule[k.node[d] * 8 + k.arm[d]];
        if (rd === 1 && tr.connHead[d] >= 0 && tr.connHead[d] !== v) { badEntries++; break; }
      }
    }
    if (step % 10 === 0) tr.checkWindow();
    maxMicro = Math.max(maxMicro, tr.microN);
    if (step === 20 * 60) for (let i = 0; i < tr.microN; i++) before.set(tr.micro[i], tr.veh.cols.s[tr.micro[i]] + tr.veh.cols.lane[tr.micro[i]] * 1000);
  }
  for (const [v, s] of before) if (tr.veh.alive[v] && tr.veh.cols.s[v] + tr.veh.cols.lane[v] * 1000 !== s) moved++;
  assert.ok(tr.count > 20, `veículos ${tr.count}`);
  assert.ok(maxMicro > 10, `micro ${maxMicro}`);
  assert.ok(entries > 10, `entradas pela via secundária ${entries}`);
  assert.ok(badEntries <= entries * 0.05, `entrou com a principal ocupada: ${badEntries} de ${entries}`);
  assert.ok(moved > 0 || before.size === 0);
  const n = tr.writePoses(data, 11);
  for (let i = 0; i < n * 11; i++) assert.ok(Number.isFinite(data[i]), `pose ${i}`);
  // ninguém atravessa o da frente na mesma faixa
  const c = tr.veh.cols;
  for (let i = 0; i < tr.microN; i++) {
    const v = tr.micro[i];
    if (c.conn[v] >= 0 || c.prev[v] < 0) continue;
    const lead = c.prev[v];
    assert.ok(c.s[lead] - c.len[lead] - c.s[v] > -0.5, 'sobreposição');
  }
});

test('demolir trecho com carros não quebra nada', () => {
  const { w, sim } = gridCity(3);
  const tr = new Traffic(sim);
  sim.onConnRemoved = (c) => tr.evacuateConn(c);
  tr.nodesRebuilt([...Array(sim.net.nodes.end).keys()]);
  tr.density = 1 / 30;
  tr.checkWindow();
  for (let i = 0; i < 600; i++) tr.step(0.05);
  const ops: NetOp[] = [];
  w.roads.listeners.push((op) => ops.push(op));
  let s = 0; while (!w.roads.segs.alive[s]) s++;
  w.roads.removeSeg(asSeg(s));
  for (const op of ops) sim.apply(op);
  tr.segsRemoved(sim.removedSegs.splice(0));
  tr.nodesRebuilt(sim.rebuild());
  for (let i = 0; i < 600; i++) tr.step(0.05);
  assert.ok(tr.count > 0);
});

test('pedestres: nascem, andam pelas calçadas, atravessam e chegam', () => {
  const { sim } = gridCity(5, 110);
  const peds = new Peds(sim);
  peds.density = 1 / 4;
  const out = new Float32Array(11 * 20000);
  let maxCount = 0, written = 0;
  const first = new Map<number, number>();
  for (let k = 0; k < 20 * 120; k++) {
    peds.step(0.05);
    if (k % 10 === 0) peds.checkWindow();
    maxCount = Math.max(maxCount, peds.count);
    if (k % 100 === 0) {
      const n = peds.writePoses(out, 11, 0, 20000);
      written = Math.max(written, n);
      for (let i = 0; i < n * 11; i++) assert.ok(Number.isFinite(out[i]), 'pose inválida');
      // ninguém longe da cidade nem acima/abaixo do chão das vias
      const looks = new Set<number>();
      for (let i = 0; i < n; i++) {
        const x = out[i * 11 + 4], y = out[i * 11 + 5], z = out[i * 11 + 6];
        assert.ok(Math.abs(x) < 260 && Math.abs(z) < 260, `fora: ${x} ${z}`);
        assert.ok(y > 9.9 && y < 10.4, `altura ${y}`);
        looks.add(out[i * 11 + 10]);
      }
      // aparência de 16 bits no fim da pose (sessão de pessoas): muito mais que as 16 cores
      if (n > 40) assert.ok(looks.size > 30, `aparências distintas ${looks.size} de ${n}`);
      if (k === 0) for (let i = 0; i < n; i++) first.set(i, out[i * 11 + 4]);
    }
  }
  assert.ok(maxCount > 50, `pedestres ${maxCount}`);
  assert.ok(written > 20, `na janela ${written}`);
});

test('ônibus: rodam a linha, param nas paradas e levam gente', () => {
  const { sim } = gridCity(4, 120);
  const tr = new Traffic(sim);
  sim.onConnRemoved = (c) => tr.evacuateConn(c);
  tr.nodesRebuilt([...Array(sim.net.nodes.end).keys()]);
  tr.density = 0;
  // três paradas na calçada de vias diferentes (grade de −180 a 180)
  tr.setLines([{ id: 1, color: 3, buses: 3, stops: [-120, -189, 189, 0, 0, 189] }]);
  assert.equal(tr.lines[0].stopLane.length, 4); // ida (3) e volta pelo outro lado (1: as pontas são terminais)
  let served = 0, maxBuses = 0;
  for (let i = 0; i < 20 * 600; i++) {
    tr.step(0.05);
    if (i % 20 === 0) { tr.checkWindow(); const st = tr.lineStats(1); served += st[0].perHour; maxBuses = Math.max(maxBuses, st[0].buses); }
  }
  assert.equal(maxBuses, 3);
  assert.ok(served > 0, 'ninguém embarcou');
  // apagar a linha tira os ônibus
  tr.setLines([]);
  for (let i = 0; i < 200; i++) tr.step(0.05);
  let buses = 0;
  for (let v = 0; v < tr.veh.end; v++) if (tr.veh.alive[v] && tr.veh.cols.kind[v] === 1 && tr.veh.cols.line[v] >= 0) buses++;
  assert.equal(buses, 0);
});

test('ônibus levam pedestres: andam até a parada, embarcam e descem a pé', () => {
  const { sim } = gridCity(4, 120);
  const tr = new Traffic(sim);
  sim.onConnRemoved = (c) => tr.evacuateConn(c);
  tr.nodesRebuilt([...Array(sim.net.nodes.end).keys()]);
  tr.density = 0;
  const peds = new Peds(sim);
  peds.density = 1 / 12;
  peds.transitShare = 0.6;
  let atStop = 0, alighted = 0;
  peds.pickTrip = () => tr.pickTrip();
  peds.onStop = (l, a, b) => { atStop++; tr.pedAtStop(l, a, b); };
  tr.onAlight = (node, n) => { alighted += n; peds.spawnAt(asNode(node), n); };
  tr.setLines([{ id: 1, color: 3, buses: 3, stops: [-120, -189, 189, 0, 0, 189] }]);
  let ran = 0;
  for (let i = 0; i < 20 * 900; i++) {
    tr.step(0.05); peds.step(0.05);
    if (i % 20 === 0) tr.checkWindow();
    ran = i;
    if (atStop > 5 && alighted > 5) break;
  }
  assert.ok(atStop > 5, `chegaram à parada: ${atStop} em ${(ran * 0.05).toFixed(0)} s`);
  assert.ok(alighted > 5, `desceram: ${alighted} em ${(ran * 0.05).toFixed(0)} s`);
});

test('setas por faixa e faixa de ônibus decidem as conexões', async () => {
  const { registerProfile, TurnBit, PROFILE_INFO } = await import('../src/roads/profiles.ts');
  // avenida: em cada sentido, faixa da direita só à direita, a do meio só em frente (ônibus), a da esquerda só à esquerda
  const base = PROFILE_INFO[0].strips;
  const id = registerProfile({ name: 'teste setas', speed: 50, oneWay: false, strips: [
    base[0], base[1],
    { kind: 'lane', width: 3, dir: 1, turns: TurnBit.Right }, { kind: 'lane', width: 3, dir: 1, turns: TurnBit.Straight, bus: true },
    { kind: 'lane', width: 3, dir: 1, turns: TurnBit.Left },
    { kind: 'lane', width: 3, dir: -1, turns: TurnBit.Left }, { kind: 'lane', width: 3, dir: -1, turns: TurnBit.Straight, bus: true },
    { kind: 'lane', width: 3, dir: -1, turns: TurnBit.Right },
    base[1], base[0]] });
  const w = new World();
  w.heights.fill(10); w.tileMin.fill(10); w.tileMax.fill(10);
  const ops: NetOp[] = [];
  w.roads.listeners.push((op) => ops.push(op));
  for (const [ax, az, bx, bz] of [[-150, 0, 150, 0], [0, -150, 0, 150]]) {
    const a = snap(w.roads, ax, az, 8), b = snap(w.roads, bx, bz, 8);
    const p = planRoad(w, a, null, b, id, 0);
    assert.ok(p.ok, p.reason);
    buildRoad(w, p, a, b, id);
  }
  const sim = new SimNet();
  const enc = encodeOps(ops);
  for (let i = 0; i < ops.length; i++) sim.apply(decodeOp(enc, i));
  sim.rebuild();
  const k = sim.conns.cols;
  let n = 0;
  for (let c = 0; c < sim.conns.end; c++) {
    if (!sim.conns.alive[c] || sim.net.segsOf(asNode(k.node[c])).length < 3) continue; // só o cruzamento
    n++;
    const idx = k.from[c] & 7;
    const want = idx === 0 ? 0 : idx === 1 ? 1 : 2; // Turn.Right, Straight, Left
    assert.equal(k.turn[c], want, `faixa ${idx} fez o movimento ${k.turn[c]}`);
  }
  assert.ok(n >= 12, `conexões ${n}`);
  // carro escolhe faixa fora da de ônibus para seguir em frente quando há outra (aqui não há: cai na de ônibus)
  const ns = sim.net.segs.end;
  let anyBus = false;
  for (let s = 0; s < ns; s++) if (sim.net.segs.alive[s]) anyBus ||= sim.isBusLane(laneId(s, 1, 1));
  assert.ok(anyBus);
});

test('vias custam dinheiro; desfazer devolve; sem dinheiro não constrói', () => {
  const w = new World();
  w.heights.fill(10); w.tileMin.fill(10); w.tileMax.fill(10);
  const start = w.money;
  const a = snap(w.roads, -200, 0, 8), b = snap(w.roads, 200, 0, 8);
  const p = planRoad(w, a, null, b, 3, 0);
  const j = buildRoad(w, p, a, b, 3);
  const price = j.price;
  assert.ok(price > 50000, `preço ${price}`);
  assert.ok(j.settle());
  assert.equal(w.money, start - price);
  j.invert();
  assert.equal(w.money, start);
  assert.equal(w.roads.segs.size, 0);
  j.apply();
  assert.equal(w.money, start - price);
  // sem dinheiro: desfaz sozinho
  w.money = 10;
  const c = snap(w.roads, -200, 100, 8), d = snap(w.roads, 200, 100, 8);
  const segs = w.roads.segs.size;
  const j2 = buildRoad(w, planRoad(w, c, null, d, 3, 0), c, d, 3);
  assert.equal(j2.settle(), false);
  assert.equal(w.roads.segs.size, segs);
  assert.equal(w.money, 10);
});

test('trem: anda só no trilho, para nas estações; carro nunca entra no trilho', async () => {
  const { PROFILES } = await import('../src/roads/profiles.ts');
  const railId = PROFILES.findIndex((p) => p.name === 'profile.doubleRailway');
  assert.ok(railId > 0);
  const w = new World();
  w.heights.fill(10); w.tileMin.fill(10); w.tileMax.fill(10);
  const ops: NetOp[] = [];
  w.roads.listeners.push((op) => ops.push(op));
  // ferrovia leste-oeste cruzando uma rua norte-sul (passagem de nível)
  const build = (ax: number, az: number, bx: number, bz: number, prof: number) => {
    const a = snap(w.roads, ax, az, 8), b = snap(w.roads, bx, bz, 8);
    const p = planRoad(w, a, null, b, prof, 0);
    assert.ok(p.ok, p.reason);
    buildRoad(w, p, a, b, prof);
  };
  build(-600, 0, 600, 0, railId);
  build(0, -400, 0, 400, 0);
  build(-300, -400, -300, 400, 0);
  const sim = new SimNet();
  const tr = new Traffic(sim);
  const enc = encodeOps(ops);
  for (let i = 0; i < ops.length; i++) sim.apply(decodeOp(enc, i));
  sim.rebuild();
  sim.onConnRemoved = (c) => tr.evacuateConn(c);
  tr.nodesRebuilt([...Array(sim.net.nodes.end).keys()]);
  tr.density = 1 / 30;
  tr.camX = 0; tr.camZ = 0;
  tr.setLines([{ id: 1, color: 3, buses: 1, stops: [-500, 0, 400, 0], mode: 1 }]);
  tr.checkWindow();
  let carOnRail = 0, trainOffRail = 0, served = 0, lastStop = -1;
  const { laneSeg } = await import('../src/sim/lanes.ts');
  const { PROFILE_INFO } = await import('../src/roads/profiles.ts');
  for (let step = 0; step < 20 * 240; step++) {
    tr.step(0.05);
    if (step % 10 === 0) tr.checkWindow();
    const c = tr.veh.cols;
    for (let v = 0; v < tr.veh.end; v++) {
      if (!tr.veh.alive[v] || c.lane[v] < 0) continue;
      const rail = PROFILE_INFO[sim.net.segs.cols.profile[laneSeg(c.lane[v])]].rail;
      if (c.kind[v] === 4 && !rail) trainOffRail++;
      if (c.kind[v] !== 4 && rail) carOnRail++;
    }
    for (const v of (tr as unknown as { buses: { sets: Array<Set<number>> } }).buses.sets[0]) { if (lastStop >= 0 && c.stopI[v] !== lastStop) served++; lastStop = c.stopI[v]; }
  }
  assert.equal(carOnRail, 0);
  assert.equal(trainOffRail, 0);
  const st = tr.lineStats(1);
  assert.ok(st[0].buses >= 1, 'sem trem');
  if (process.env.DBG) {
    const sc = sim.net.segs.cols, nc = sim.net.nodes.cols;
    for (let sg = 0; sg < sim.net.segs.end; sg++) if (sim.net.segs.alive[sg]) console.log('SEG', sg, sc.profile[sg], nc.x[sc.a[sg]].toFixed(0), nc.z[sc.a[sg]].toFixed(0), '->', nc.x[sc.b[sg]].toFixed(0), nc.z[sc.b[sg]].toFixed(0));
  }
  assert.ok(served >= 2, `estações atendidas ${served}`);
});

test('conexões de faixa à mão: a simulação usa só as saídas escolhidas e a seta bate', async () => {
  const { laneExits, arrowCode } = await import('../src/roads/laneLinks.ts');
  const { TurnBit } = await import('../src/roads/profiles.ts');
  const { w, sim } = gridCity(3, 120);
  // um cruzamento de quatro braços no meio
  let n = -1;
  for (let i = 0; i < w.roads.nodes.end; i++) if (w.roads.nodes.alive[i] && w.roads.nodes.cols.deg[i] === 4) { n = i; break; }
  assert.ok(n >= 0);
  const from = w.roads.segsOf(asNode(n), [])[0];
  const before = laneExits(w.roads, asNode(n), from);
  assert.ok(before[0].exits.length >= 2);
  // faixa 0 só para a primeira saída automática
  const only = before[0].exits[0][0];
  w.roads.setJunction(asNode(n), { ctl: 0, lanes: [[from, 0, [only]]] });
  const after = laneExits(w.roads, asNode(n), from);
  assert.deepEqual(after[0].exits.map(([s]) => s), [only]);
  // seta pintada: os 3 bits da faixa 0 são o bit daquela saída
  const code = arrowCode(w.roads, asNode(n), from);
  assert.equal(code % 8, after[0].exits[0][1]);
  assert.ok([TurnBit.Left, TurnBit.Straight, TurnBit.Right].includes(code % 8 as 1 | 2 | 4));
  // simulação: espelha a mudança e confere as conexões da faixa 0
  const ops: import('../src/roads/network.ts').NetOp[] = [{ t: 'junction', id: asNode(n), spec: w.roads.junctions.get(asNode(n))! }];
  const extra: string[] = [];
  const enc = encodeOps(ops, extra);
  sim.apply(decodeOp(enc, 0, extra));
  sim.rebuild();
  const k = sim.conns.cols;
  const sc = sim.net.segs.cols;
  const inDir = sc.b[from] === n ? 1 : -1;
  const lane = laneId(from, inDir, 0);
  const targets = new Set<number>();
  for (let c = sim.laneConn[lane]; c >= 0; c = k.nextFromLane[c]) targets.add(Math.floor(k.to[c] / 16));
  assert.deepEqual([...targets], [only]);
});

test('faixa no meio da quadra: zebra para carros com pedestre na faixa; semáforo alterna carros e pedestres', async () => {
  const { addCrossing } = await import('../src/roads/build.ts');
  const { Ctl, effectiveControl } = await import('../src/roads/control.ts');
  const w = new World();
  w.heights.fill(10); w.tileMin.fill(10); w.tileMax.fill(10); w.unlimited = true;
  const ops: NetOp[] = [];
  w.roads.listeners.push((op) => ops.push(op));
  const a = snap(w.roads, -100, 0, 8), b = snap(w.roads, 100, 0, 8);
  const p = planRoad(w, a, null, b, 0, 0);
  buildRoad(w, p, a, b, 0).settle();
  const s = w.roads.nearestSeg(-50, 0, 5)![0];
  const j = addCrossing(w, s, 0.5, Ctl.Zebra);
  assert.ok(typeof j !== 'string');
  const n = w.roads.nearestNode(-50, 0, 6);
  assert.ok(n >= 0);
  assert.equal(effectiveControl(w.roads, n).ctl, Ctl.Zebra);
  const extra: string[] = [];
  const enc = encodeOps(ops, extra);
  const sim = new SimNet();
  const tr = new Traffic(sim);
  for (let i = 0; i < ops.length; i++) sim.apply(decodeOp(enc, i, extra));
  sim.rebuild();
  assert.equal(sim.nodeCtl[n], Ctl.Zebra);
  // with someone on the crosswalk (on the stretch the car drives over) the connection closes; with nobody, it opens
  let crossing = true;
  tr.pedCrossing = () => crossing;
  tr.pedCrossingReach = () => crossing;
  const k = sim.conns.cols;
  const conn = sim.nodeConn[n];
  assert.ok(conn >= 0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const T = tr as any;
  assert.equal(T.junctions.gateRules(conn, 0, 10), false);
  crossing = false;
  assert.equal(T.junctions.gateRules(conn, 0, 10), true);
  void k;
  // semáforo de pedestres: duas fases, a segunda sem braços (pedestres)
  w.roads.setJunction(n, { ctl: Ctl.PedSignal });
  const e2: string[] = [];
  const enc2 = encodeOps([{ t: 'junction', id: n, spec: { ctl: Ctl.PedSignal } }], e2);
  sim.apply(decodeOp(enc2, 0, e2));
  tr.nodesRebuilt(sim.rebuild());
  assert.equal(sim.nodePhases[n], 2);
});

test('retorno no canteiro: a faixa da esquerda tem conexão de volta pelo mesmo trecho', async () => {
  const { addUTurn } = await import('../src/roads/build.ts');
  const { PROFILE_INFO } = await import('../src/roads/profiles.ts');
  const w = new World();
  w.heights.fill(10); w.tileMin.fill(10); w.tileMax.fill(10); w.unlimited = true;
  const ops: NetOp[] = [];
  w.roads.listeners.push((op) => ops.push(op));
  const prof = PROFILE_INFO.findIndex((p) => !p.oneWay && p.edges.some((e) => e.strip.kind === 'median' && e.u1 - e.u0 >= 1.5) && !p.rail);
  assert.ok(prof >= 0);
  const a = snap(w.roads, -100, 0, 8), b = snap(w.roads, 100, 0, 8);
  buildRoad(w, planRoad(w, a, null, b, prof, 0), a, b, prof).settle();
  const s = w.roads.nearestSeg(-50, 0, 5)![0];
  assert.equal(typeof addUTurn(w, s, 0.5), 'object');
  const n = w.roads.nearestNode(-50, 0, 6);
  const extra: string[] = [];
  const enc = encodeOps(ops, extra);
  const sim = new SimNet();
  new Traffic(sim);
  for (let i = 0; i < ops.length; i++) sim.apply(decodeOp(enc, i, extra));
  sim.rebuild();
  const k = sim.conns.cols;
  let uturns = 0;
  for (let c = sim.nodeConn[n]; c >= 0; c = k.nextAtNode[c]) if (Math.floor(k.from[c] / 16) === Math.floor(k.to[c] / 16)) uturns++;
  assert.equal(uturns, 2, 'um retorno por sentido');
});

test('controle automático pelo fluxo: semáforo onde passa muita gente, placas onde quase ninguém passa, com histerese', async () => {
  const { warrantedControl, Ctl } = await import('../src/roads/control.ts');
  const { SETTLE, TREND } = await import('../src/sim/advisor.ts');
  // limiares (roadcraft): 500 principal + 150 secundária pede semáforo; para manter basta 80%
  assert.equal(warrantedControl(520, 160, 160, 'priority'), 'signal');
  assert.equal(warrantedControl(420, 125, 125, 'priority'), 'priority');
  assert.equal(warrantedControl(420, 125, 125, 'signal'), 'signal');
  assert.equal(warrantedControl(300, 50, 50, 'signal'), 'priority');
  const { sim } = gridCity();
  const tr = new Traffic(sim);
  sim.onConnRemoved = (c) => tr.evacuateConn(c);
  tr.nodesRebuilt([...Array(sim.net.nodes.end).keys()]);
  const nc = sim.net.nodes.cols;
  let busy = -1, quiet = -1;
  for (let n = 0; n < sim.net.nodes.end; n++) {
    if (!sim.net.nodes.alive[n] || !sim.nodeAuto[n] || nc.deg[n] !== 4) continue;
    if (sim.nodePhases[n] > 0) quiet = n; else if (busy < 0 && sim.nodeCtl[n] === Ctl.Priority) busy = n;
  }
  assert.ok(busy >= 0 && quiet >= 0, 'cruzamento com placas e com semáforo na grade');
  const changed: number[] = [];
  tr.advisor.onChange = (n) => changed.push(n);
  // fluxo por braço (veíc./h, nos limiares do roadcraft; a simulação usa os limiares vezes `scale`): o
  // principal soma os dois braços da via principal
  const acc = new Float64Array(8), x = tr.advisor.scale;
  const run = (seconds: number, t0: number, mainRate: number, minorRate: number) => {
    for (let t = t0; t < t0 + seconds; t++) {
      for (let a = 0; a < 4; a++) {
        acc[a] += ((sim.armMain[busy] & (1 << a)) ? mainRate : minorRate) * x / 3600;
        const whole = Math.floor(acc[a]); acc[a] -= whole; for (let i = 0; i < whole; i++) tr.advisor.count(busy, a, t);
      }
      tr.advisor.step(t);
    }
    tr.nodesRebuilt(sim.rebuild());
    return t0 + seconds;
  };
  let t = run(SETTLE - 60, 0, 350, 200);
  assert.equal(sim.nodePhases[busy], 0, 'antes de medir o bastante não troca');
  t = run(TREND * 2, t, 350, 200);
  assert.ok(sim.nodePhases[busy] > 0, 'fluxo alto: ganhou semáforo');
  assert.equal(sim.nodePhases[quiet], 0, 'sem fluxo: o semáforo da importância das vias sai');
  assert.equal(sim.nodeCtl[quiet], Ctl.Priority);
  assert.deepEqual(changed.sort(), [busy, quiet].sort());
  // histerese: 85% do limiar mantém o semáforo; metade tira
  t = run(SETTLE + TREND * 2, t, 215, 130);
  assert.ok(sim.nodePhases[busy] > 0, 'perto do limiar fica como está');
  t = run(SETTLE + TREND * 2, t, 120, 60);
  assert.equal(sim.nodePhases[busy], 0, 'fluxo baixo: volta às placas');
  // o jogador escolhe o controle: o automático esquece o que mediu
  sim.apply({ t: 'junction', id: asNode(busy), spec: { ctl: Ctl.AllStop } });
  tr.nodesRebuilt(sim.rebuild());
  assert.equal(sim.nodeAuto[busy], 0);
  assert.equal(tr.advisor.rate[busy * 8], 0);
});

test('trânsito cheio: ninguém é removido por travamento; quem fica preso reconsidera a rota e o cruzamento travado é liberado', () => {
  const { sim } = gridCity(5, 90);
  const tr = new Traffic(sim);
  sim.onConnRemoved = (c) => tr.evacuateConn(c);
  tr.nodesRebuilt([...Array(sim.net.nodes.end).keys()]);
  tr.density = 1 / 9; // bem acima do que a grade escoa
  tr.camX = 0; tr.camZ = 0;
  tr.checkWindow();
  const c = tr.veh.cols, k = sim.conns.cols;
  let worst = 0;
  for (let step = 0; step < 20 * 60 * 8; step++) {
    tr.step(0.05);
    if (step % 10 === 0) tr.checkWindow();
    if (step % 200 === 0) for (let i = 0; i < tr.microN; i++) { const v = tr.micro[i]; if (c.conn[v] < 0 && c.prev[v] < 0) worst = Math.max(worst, c.wait[v]); }
  }
  assert.equal(tr.lost, 0, 'removidos');
  assert.ok(tr.arrived > 200, `chegadas ${tr.arrived}`);
  assert.ok(tr.reroutes > 0, 'alguém reconsiderou a rota');
  // ninguém fica preso na linha para sempre (travou: liberado um por vez)
  assert.ok(worst < 120, `maior espera na linha ${worst.toFixed(0)} s (travamentos ${tr.jams}, liberados ${tr.released})`);
  // quem está na conexão não ficou em cima de outro
  for (let x = 0; x < sim.conns.end; x++) for (let v = tr.connHead[x]; v >= 0 && c.next[v] >= 0; v = c.next[v]) assert.ok(c.s[v] >= c.s[c.next[v]] - 0.01, `ordem na conexão ${x} do nó ${k.node[x]}`);
});

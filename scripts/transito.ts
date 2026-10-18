// Diagnóstico do trânsito no centro da cidade gerada (fora do npm test, um núcleo só).
// Uso: node scripts/transito.ts [mapa=10] [minutos=15] [hora=12] [demanda=1.5] [semente=1]
// RELOGIO=1: a hora anda como no jogo (1 h por minuto de simulação, da página); senão fica parada.
// A cada minuto de simulação: veículos na janela micro, velocidade média, parados, esperando > 10 s,
// chegadas e desistências, e a causa de cada parado (fila, vermelho, saída cheia, preferência, pare…).

const arg = (i: number, d: number) => { const v = Number(process.argv[2 + i]); return Number.isFinite(v) && process.argv[2 + i] !== undefined ? v : d; };
const MAPA = arg(0, 10), MIN = arg(1, 15), HORA = arg(2, 12), DEMANDA = arg(3, 1.5), SEED = arg(4, 1);
(globalThis as { name?: string }).name = `mapa=${MAPA}`;

const { generateCity } = await import('../src/jobs/cityGen.ts');
const { World } = await import('../src/world/world.ts');
const { SimNet, encodeOps, decodeOp, laneSeg } = await import('../src/sim/lanes.ts');
const { Traffic } = await import('../src/sim/traffic.ts');
const { Rule } = await import('../src/roads/control.ts');
type NetOp = import('../src/roads/network.ts').NetOp;

let t0 = performance.now();
const city = generateCity(SEED);
const w = new World();
const ops: NetOp[] = [];
w.roads.listeners.push((op) => ops.push(op));
const ids: number[] = [];
for (let i = 0; i < city.nodes.length; i += 3) ids.push(w.roads.addNode({ x: city.nodes[i], z: city.nodes[i + 1], y: city.nodes[i + 2] }));
const nc = w.roads.nodes.cols;
for (let k = 0; k < city.segs.length; k += 5) {
  const a = ids[city.segs[k]], b = ids[city.segs[k + 1]];
  try { w.roads.addSeg({ a, b, cx: (nc.x[a] + nc.x[b]) / 2, cz: (nc.z[a] + nc.z[b]) / 2, profile: city.segs[k + 2], flags: 0, zl: city.segs[k + 3], zr: city.segs[k + 4] }); } catch { /* igual ao jogo */ }
}
// como no worker: o trânsito existe antes da rede (as tabelas dele crescem com ela)
const sim = new SimNet();
const tr = new Traffic(sim);
sim.onConnRemoved = (c) => tr.evacuateConn(c);
const enc = encodeOps(ops);
for (let i = 0; i < ops.length; i++) sim.apply(decodeOp(enc, i));
const rebuilt = sim.rebuild();
tr.nodesRebuilt(rebuilt);
const cx = Number(process.env.CX ?? city.centers[0]), cz = Number(process.env.CZ ?? city.centers[1]);
tr.camX = cx; tr.camZ = cz; tr.hour = HORA; tr.demand = DEMANDA;
// JANELA=raio: tamanho da janela micro (JANELA=1e6 põe o mapa inteiro em micro, para medir o meso contra ele)
if (process.env.JANELA) tr.window = Number(process.env.JANELA);
// FLUXO_X=k: limiares do controle automático pelo fluxo vezes k
if (process.env.FLUXO_X) tr.advisor.scale = Number(process.env.FLUXO_X);
console.log(`mapa ${MAPA} km, ${w.roads.segs.size} trechos, centro (${cx.toFixed(0)}, ${cz.toFixed(0)}), preparo ${((performance.now() - t0) / 1000).toFixed(1)} s`);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const T = tr as any;
const c = tr.veh.cols, k = sim.conns.cols;
const DT = 0.05;
const RELOGIO = Number(process.env.RELOGIO ?? 0);
/** Por que o veículo v (micro, quase parado) está parado. */
function cause(v: number): string {
  if (c.conn[v] >= 0) return c.prev[v] >= 0 ? 'fila no cruzamento' : 'parado no cruzamento';
  const lane = c.lane[v];
  const lead = c.prev[v];
  if (lead >= 0) {
    let h = lead; for (let i = 0; i < 200 && c.prev[h] >= 0; i++) h = c.prev[h];
    if (c.line[h] >= 0) return 'fila atrás de ônibus';
    if (c.dying[h]) return 'fila atrás de quem chegou';
    if (sim.laneLen(lane) - c.s[h] > 15) return 'fila (cabeça no meio da faixa)';
    return c.s[lead] - c.len[lead] - c.s[v] < 12 ? 'fila' : 'atrás de lento';
  }
  if (c.dying[v]) return 'chegando (some)';
  const toEnd = sim.laneLen(lane) - c.s[v];
  if (toEnd > 15) return c.line[v] >= 0 ? 'ônibus no ponto' : 'meio da faixa';
  if (c.line[v] >= 0) return 'ônibus';
  let ns = T.nextSeg(v);
  if (ns < 0) return 'sem rota';
  let conn = sim.connToward(lane, ns, false);
  if (conn < 0) return 'faixa errada';
  if (!T.exitRoom(conn, v)) { const to = k.to[conn]; exitLens.push(Math.round(sim.laneLen(to))); exitDeg.push(sim.net.nodes.cols.deg[sim.laneTo(to)]); return T.inWindow(to) ? (tr.laneCount[to] > sim.laneLen(to) / 7.5 ? 'saída cheia (micro, acima da lotação)' : 'saída cheia (micro)') : 'saída cheia (meso)'; }
  const n = k.node[conn];
  if (sim.nodePhases[n] > 0 && !T.stageGreen(conn)) return 'vermelho';
  const r = sim.armRule[n * 8 + k.arm[conn]];
  if (r === Rule.Stop) return 'pare';
  if (!T.gateRules(conn, v, toEnd)) return sim.nodePhases[n] > 0 ? 'conversão no verde' : 'preferência';
  return 'livre (arrancando)';
}

// experimentos: SEM=reconsider,release,fluxo,lotacao,regiao,governador desliga cada parte (rota reconsiderada, liberação do cruzamento
// travado, controle pelo fluxo, viagens que evitam rua engarrafada)
for (const off of (process.env.SEM ?? '').split(',').filter(Boolean)) {
  if (off === 'reconsider') T.reconsider = () => false;
  else if (off === 'release') T.jamRelease = () => false;
  else if (off === 'fluxo') T.advisor.step = () => {};
  else if (off === 'lotacao') T.crowdAvoid = false;
  else if (off === 'regiao') T.regionAvoid = false;
  else if (off === 'governador') T.governed = false;
}

const exitLens: number[] = [], exitDeg: number[] = [];
function countSignals(): number { let n = 0; for (let i = 0; i < sim.net.nodes.end; i++) if (sim.net.nodes.alive[i] && sim.nodePhases[i] > 0 && sim.nodeCtl[i] === 1) n++; return n; }
let mesoDist = 0, mesoTime = 0;
let enter = 0, leave = 0, connIn = 0, microEnd = 0;
{ const a = T.addMicro.bind(T), r = T.removeMicro.bind(T), ins = T.insert.bind(T);
  T.addMicro = (v: number) => { if (!c.micro[v]) enter++; a(v); };
  T.removeMicro = (v: number) => { if (c.micro[v]) leave++; r(v); };
  { const d = T.despawn.bind(T); T.despawn = (v: number) => { if (c.micro[v]) microEnd++; d(v); }; }
  { const me = T.mesoEnter.bind(T); T.mesoEnter = (v: number, lane: number, spawned = false) => { const rest = spawned ? sim.laneLen(lane) - c.s[v] : sim.laneLen(lane); const t0 = tr.time; me(v, lane, spawned); const d = c.tExit[v] - t0; if (d > 0 && rest > 0) { mesoDist += rest; mesoTime += d; } }; }
  T.insert = (v: number, onConn: boolean, id: number) => { if (onConn) connIn++; ins(v, onConn, id); }; }
let lastMF = 0, lastMT = 0;
let lastArr = 0, lastLost = 0, lastRe = 0, lastJam = 0, lastRel = 0, lastChg = 0;
t0 = performance.now();
const steps = Math.round(60 / DT);
for (let m = 1; m <= MIN; m++) {
  let sumV = 0, n = 0, stepMs = 0;
  for (let s = 0; s < steps; s++) {
    const ts = performance.now();
    tr.step(DT);
    stepMs += performance.now() - ts;
    if (RELOGIO) tr.hour = (tr.hour + DT * RELOGIO / 60) % 24;
    // como no worker: nós tocados (o controle automático troca) são refeitos a cada passo
    const rb = sim.rebuild();
    if (rb.length) tr.nodesRebuilt(rb);
    if (s % 10 === 0) tr.checkWindow();
  }
  const causes = new Map<string, number>();
  let stopped = 0, long = 0, near = 0, nearV = 0;
  const nearCauses = new Map<string, number>();
  let nearMov = 0, nearMovV = 0, nearConn = 0;
  for (let i = 0; i < tr.microN; i++) {
    const v = tr.micro[i];
    sumV += c.v[v]; n++;
    const lane = c.conn[v] >= 0 ? k.to[c.conn[v]] : c.lane[v];
    const sc = sim.net.segs.cols, sg = laneSeg(lane);
    const isNear = Math.hypot(sc.mx[sg] - cx, sc.mz[sg] - cz) < 700;
    if (isNear) { near++; nearV += c.v[v]; if (c.v[v] >= 0.5) { nearMov++; nearMovV += c.v[v]; } if (c.conn[v] >= 0) nearConn++; }
    if (isNear && c.v[v] < 0.5) { const why = cause(v); nearCauses.set(why, (nearCauses.get(why) ?? 0) + 1); }
    if (c.v[v] < 0.5) {
      stopped++;
      if (c.wait[v] > 10) long++;
      const why = cause(v);
      causes.set(why, (causes.get(why) ?? 0) + 1);
    }
  }
  let over = 0, overMeso = 0;
  for (let sg = 0; sg < sim.net.segs.end; sg++) if (sim.net.segs.alive[sg]) for (let d = 0; d < 16; d++) { const ln = sg * 16 + d; if (tr.laneCount[ln] > 0 && tr.laneCount[ln] > sim.laneLen(ln) / 7.5 + 0.5) { over++; if (!T.inWindow(ln)) overMeso++; } }
  causes.set(`faixas acima da lotação ${over} (meso ${overMeso})`, 0);
  causes.set(`meso ${(mesoDist / Math.max(1, mesoTime) * 3.6).toFixed(1)} km/h`, 0); mesoDist = mesoTime = 0;
  causes.set(`entram ${enter} saem ${leave} terminam ${microEnd} cruzam ${connIn}`, 0); enter = leave = connIn = microEnd = 0;
  if (process.env.NOS && m % 5 === 0) {
    // cruzamentos com mais parados (o carro parado no fim da faixa, esperando aquele nó)
    const per = new Map<number, number>();
    for (let i = 0; i < tr.microN; i++) { const v = tr.micro[i]; if (c.v[v] < 0.5 && c.conn[v] < 0) { const nd = sim.laneTo(c.lane[v]); per.set(nd, (per.get(nd) ?? 0) + 1); } }
    const worst = [...per].filter(([nd]) => !process.env.NOS_R || Math.hypot(sim.net.nodes.cols.x[nd] - cx, sim.net.nodes.cols.z[nd] - cz) < Number(process.env.NOS_R)).sort((a, b) => b[1] - a[1]).slice(0, 12);
    const nn = sim.net.nodes.cols;
    console.log('  piores nós: ' + worst.map(([nd, q]) => `${nd}(${q}, ctl ${sim.nodeCtl[nd]}, fases ${sim.nodePhases[nd]}, grau ${sim.net.segsOf(nd, []).length}, ${Math.round(Math.hypot(nn.x[nd] - cx, nn.z[nd] - cz))} m)`).join(' '));
    const hist = [0, 0, 0, 0, 0];
    for (const q of per.values()) hist[q < 3 ? 0 : q < 6 ? 1 : q < 12 ? 2 : q < 25 ? 3 : 4]++;
    console.log(`  nós com parados: 1-2 ${hist[0]}, 3-5 ${hist[1]}, 6-11 ${hist[2]}, 12-24 ${hist[3]}, 25+ ${hist[4]}`);
  }
  if (process.env.NODE) for (const nd of process.env.NODE.split(',').map(Number)) {
    const kk = sim.conns.cols, out: string[] = [];
    for (let x = sim.nodeConn[nd]; x >= 0; x = kk.nextAtNode[x]) {
      const f = kk.from[x], to = kk.to[x], h = T.laneHead[f];
      out.push(`${f}->${to} [${Math.round(sim.laneLen(f))} m ${tr.laneCount[f]} carros, cabeça ${h >= 0 ? cause(h) + ' v' + c.v[h].toFixed(1) : '-'}] -> [${Math.round(sim.laneLen(to))} m ${tr.laneCount[to]} carros, perfil ${sim.net.segs.cols.profile[laneSeg(to)]}, nó seguinte grau ${sim.net.nodes.cols.deg[sim.laneTo(to)]} ctl ${sim.nodeCtl[sim.laneTo(to)]}]`);
    }
    console.log(`  nó ${nd}: ` + out.join(' | '));
  }
  let r1500 = 0;
  for (let v = 0; v < tr.veh.end; v++) {
    if (!tr.veh.alive[v]) continue;
    const ln = c.conn[v] >= 0 ? k.to[c.conn[v]] : c.lane[v];
    if (ln < 0) continue;
    const sg = laneSeg(ln);
    if (Math.hypot(sim.net.segs.cols.mx[sg] - cx, sim.net.segs.cols.mz[sg] - cz) < 1500) r1500++;
  }
  causes.set(`fator do dia ${tr.dayFactor().toFixed(2)}, meso cheio ${(100 * (T.mesoFull - lastMF) / Math.max(1, T.mesoTries - lastMT)).toFixed(1)}%, raio 1500 m: ${r1500}, reconsideram ${(T.reroutes ?? 0) - lastRe}, travam ${(T.jams ?? 0) - lastJam}, liberados ${(T.released ?? 0) - lastRel}, trocas ${(T.advisor?.changes ?? 0) - lastChg} (semáforos ${countSignals()}), passo ${(stepMs / steps).toFixed(2)} ms`, 0);
  if (process.env.QUENTE) {
    // as regiões mais cheias: onde, quantas vagas, e se estão na janela micro
    const R = 400, N = Math.ceil(Math.sqrt(tr.regionOcc.length));
    const top = [...tr.regionOcc].map((o, i) => [o, i] as [number, number]).sort((a, b) => b[0] - a[0]).slice(0, 5);
    console.log('  regiões mais cheias: ' + top.map(([o, i]) => { const x = (i % N) * R - N * R / 2 + R / 2, z = Math.floor(i / N) * R - N * R / 2 + R / 2; return `${o.toFixed(2)} em (${x}, ${z}) a ${Math.round(Math.hypot(x - cx, z - cz))} m, vagas ${Math.round(T.regionCap[i])}`; }).join(' | '));
  }
  causes.set(`região do centro ${(tr.regionOcc[tr.regionOf(cx, cz)] ?? 0).toFixed(2)} janela ${(tr.windowSpeed * 3.6).toFixed(1)} km/h governador ${tr.gov.toFixed(2)}`, 0);
  lastMF = T.mesoFull ?? 0; lastMT = T.mesoTries ?? 0;
  lastRe = T.reroutes ?? 0; lastJam = T.jams ?? 0; lastRel = T.released ?? 0; lastChg = T.advisor?.changes ?? 0;
  const top = [...causes].sort((a, b) => b[1] - a[1]).map(([a, b]) => `${a} ${b}`).join(', ');
  console.log(`${m} min (${tr.hour.toFixed(1)} h): ${tr.count} veículos, ${tr.microN} na janela, ${(sumV / Math.max(1, n) * 3.6).toFixed(1)} km/h (centro 700 m: ${(nearV / Math.max(1, near) * 3.6).toFixed(1)} km/h, ${near}), ` +
    `parados ${stopped}, > 10 s ${long}, chegadas ${tr.arrived - lastArr}, desistências ${tr.lost - lastLost} · ${top} · ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  if (process.env.CENTRO) { exitLens.sort((a, b) => a - b); const q = (f: number) => exitLens[Math.floor(f * (exitLens.length - 1))]; console.log(`  saída cheia: ${exitLens.length}, comprimento p10 ${q(0.1)} p50 ${q(0.5)} p90 ${q(0.9)} m; nó seguinte grau 2: ${exitDeg.filter((d) => d === 2).length}`); exitLens.length = 0; exitDeg.length = 0; }
  if (process.env.CENTRO) console.log(`  centro: andando ${nearMov} a ${(nearMovV / Math.max(1, nearMov) * 3.6).toFixed(1)} km/h, no cruzamento ${nearConn}`);
  if (process.env.CENTRO) console.log('  centro parados: ' + [...nearCauses].sort((a, b) => b[1] - a[1]).map(([a, b]) => `${a} ${b}`).join(', '));
  lastArr = tr.arrived; lastLost = tr.lost;
}

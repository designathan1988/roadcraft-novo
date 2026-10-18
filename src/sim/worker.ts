// Worker de simulação: dono do trânsito e dos pedestres. Recebe as mudanças da rede viária e a
// posição da câmera; publica poses (buffer triplo) e ocupação das vias
// (memória compartilhada). A página só lê.

import { PoseWriter, POSE_STRIDE, MAX_AGENTS, viewPoseBuffers } from './poses.ts';
import { SimNet, decodeOp } from './lanes.ts';
import { Traffic, type LineSpec } from './traffic.ts';
import { Peds } from './peds.ts';

export type ToSim =
  | { type: 'init'; poses: SharedArrayBuffer; heights: SharedArrayBuffer; occupancy: SharedArrayBuffer; signals: SharedArrayBuffer; tickHz: number }
  | { type: 'speed'; value: number } // 0 = pausado, 1, 2, 4
  | { type: 'camera'; x: number; z: number }
  /** Portas dos prédios perto da câmera (x, z): os pedestres saem delas. */
  | { type: 'doors'; pts: Float32Array }
  | { type: 'ops'; ops: Float64Array; extra?: string[] }
  | { type: 'density'; value: number }
  | { type: 'demand'; hour: number; demand: number; traffic: number; people: number }
  | { type: 'lines'; lines: LineSpec[] }
  | { type: 'profiles'; list: Profile[] }
  | { type: 'probe'; seg: number }
  | { type: 'probeNode'; node: number }
  | { type: 'people'; x: number; z: number; count: number; color: number }
  | { type: 'hit'; x: number; z: number; r: number; one: boolean };

/** Do worker para a página. */
export type FromSim =
  | { type: 'probe'; seg: number; vehicles: number; speed: number; queue: number; capacity: number }
  | { type: 'probeNode'; node: number; passed: number; time: number }
  | { type: 'hit'; people: number; vehicles: number }
  /** O automático trocou o controle do nó pelo fluxo medido (Flow: 1 semáforo, 2 placas). A página pode
   *  passar o mesmo `flow` para `effectiveControl` (pintura, placas, cabeças de semáforo, inspetor). */
  | { type: 'autoControl'; node: number; flow: number }
  | { type: 'stats'; cars: number; micro: number; peds: number; arrived: number; lost: number; speed: number; stopped: number;
      lines: Array<{ id: number; buses: number; perHour: number; waiting: number }> }
  | { type: 'error'; message: string };

import { setCustomProfiles, type Profile } from '../roads/profiles.ts';

interface SimScope { onmessage: ((e: MessageEvent<ToSim>) => void) | null; postMessage(m: FromSim): void }
const scope = self as unknown as SimScope;

const sim = new SimNet();
const traffic = new Traffic(sim);
sim.onConnRemoved = (c) => traffic.evacuateConn(c);
sim.onSegAdded = (s) => traffic.clearWear(s);
const peds = new Peds(sim);
peds.carsGo = (n, arm) => traffic.carsGo(n, arm);
traffic.pedCrossing = (n) => peds.crossing(n);
// ônibus e pedestres: quem vai de ônibus anda até a parada, espera, viaja e desce a pé
peds.pickTrip = () => traffic.pickTrip();
peds.onStop = (l, a, b) => traffic.pedAtStop(l, a, b);
traffic.onAlight = (node, n) => peds.spawnAt(node, n);
traffic.advisor.onChange = (node, flow) => scope.postMessage({ type: 'autoControl', node, flow });

let writer: PoseWriter | null = null;
let speed = 1;
let dtMs = 50;
let tick = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let next = 0;
let windowTimer = 0;

let statsTimer = 0;
let failed = false;

function step(): void {
  if (!writer) return;
  try { stepInner(); } catch (err) {
    // erro na simulação: avisa a página uma vez e segue (o próximo passo tenta de novo)
    if (!failed) { failed = true; scope.postMessage({ type: 'error', message: String((err as Error)?.stack ?? err) }); }
  }
  next += dtMs;
  timer = setTimeout(step, Math.max(0, next - performance.now()));
}

function stepInner(): void {
  if (!writer) return;
  const dt = dtMs / 1000;
  // rede mudou: refaz só os nós tocados
  const removed = sim.removedSegs.splice(0);
  if (removed.length) traffic.segsRemoved(removed);
  const rebuilt = sim.rebuild();
  if (rebuilt.length) traffic.nodesRebuilt(rebuilt);
  for (let k = 0; k < speed; k++) {
    traffic.step(dt);
    peds.step(dt);
    tick++;
  }
  windowTimer += dt * Math.max(1, speed);
  if (windowTimer >= 0.5) { windowTimer = 0; traffic.checkWindow(); peds.checkWindow(); }
  let n = -1;
  if (speed > 0) {
    n = Math.min(MAX_AGENTS, traffic.writePoses(writer.data, POSE_STRIDE));
    n += traffic.writeStopPeople(writer.data, POSE_STRIDE, n, MAX_AGENTS);
    n += peds.writePoses(writer.data, POSE_STRIDE, n, MAX_AGENTS);
  }
  if (n >= 0) writer.publish(n, performance.timeOrigin + performance.now(), dtMs, tick);
  statsTimer += dtMs;
  if (statsTimer >= 1000) {
    statsTimer = 0;
    const speedNow = traffic.avgSpeed();
    scope.postMessage({ type: 'stats', cars: traffic.count, micro: traffic.microN, peds: peds.count, arrived: traffic.arrived, lost: traffic.lost, speed: speedNow, stopped: traffic.stopped, lines: traffic.lineStats(1) });
  }
}

scope.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      writer = new PoseWriter(viewPoseBuffers(m.poses));
      traffic.occupancy = new Uint8Array(m.occupancy);
      traffic.signals = new Uint8Array(m.signals);
      dtMs = 1000 / m.tickHz;
      next = performance.now();
      if (timer === null) step();
      break;
    case 'speed': speed = m.value; break;
    case 'camera': traffic.camX = peds.camX = m.x; traffic.camZ = peds.camZ = m.z; break;
    case 'doors': peds.doors = m.pts; break;
    case 'density': traffic.density = m.value; break;
    case 'demand': traffic.hour = m.hour; traffic.demand = m.demand; traffic.trafficShare = m.traffic; peds.share = m.people; break;
    case 'profiles': setCustomProfiles(m.list); break;
    case 'lines': traffic.setLines(m.lines); break;
    case 'probe': scope.postMessage({ type: 'probe', seg: m.seg, ...traffic.probe(m.seg) }); break;
    case 'people': { const n = sim.net.nearestNode(m.x, m.z, 200); if (n >= 0) peds.spawnAt(n, m.count, m.color); break; }
    case 'hit': scope.postMessage({ type: 'hit', people: peds.hit(m.x, m.z, m.r, m.one), vehicles: m.one ? 0 : traffic.blast(m.x, m.z, m.r) }); break;
    case 'probeNode': scope.postMessage({ type: 'probeNode', node: m.node, passed: traffic.nodePass[m.node] ?? 0, time: traffic.time }); break;
    case 'ops': {
      const n = m.ops.length / 8;
      for (let i = 0; i < n; i++) {
        const op = decodeOp(m.ops, i, m.extra);
        if (op.t === 'clear') { peds.clear(); traffic.clearAll(); }
        sim.apply(op);
      }
      break;
    }
  }
};

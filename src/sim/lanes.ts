// Espelho da rede viária no worker de simulação: faixas e conexões nos nós.
// Faixa não é objeto: o id é (trecho * 16 + sentido * 8 + índice) e a forma
// sai da curva do trecho com o deslocamento lateral do perfil. Conexões
// (movimentos dentro do nó) ficam numa tabela SoA, refeitas só nos nós tocados.

import { RoadNetwork, type NetOp } from '../roads/network.ts';
import { Ctl, Rule, banned, effectiveControl, mainLegs, signalStages, type JunctionSpec } from '../roads/control.ts';
import { PROFILE_INFO, PROFILES, TurnBit } from '../roads/profiles.ts';
import { arcTable, bez, bezD, tAtLength, type Quad } from '../roads/geometry.ts';
import { BULB_R, armOf, bulbAt, junctionRetreats } from '../roads/junction.ts';
import { customExits } from '../roads/laneLinks.ts';
import { SegFlag } from '../roads/flags.ts';
import { Table } from '../core/table.ts';

export const ARC_STEPS = 16;
export const laneId = (seg: number, dir: number, idx: number) => seg * 16 + (dir > 0 ? 0 : 8) + idx;
export const laneSeg = (l: number) => l >> 4;
export const laneDir = (l: number) => ((l & 8) !== 0 ? -1 : 1);
export const laneIdx = (l: number) => l & 7;

export const laneCount = (profile: number, dir: number) => (dir > 0 ? PROFILE_INFO[profile].lanesFwd : PROFILE_INFO[profile].lanesBack);
/** Faixa só de ônibus. */
export const laneBus = (profile: number, dir: number, idx: number) => (dir > 0 ? PROFILE_INFO[profile].fwd : PROFILE_INFO[profile].back)[idx]?.bus ?? false;
export const laneSpeed = (profile: number) => PROFILES[profile].speed / 3.6;

export const Turn = { Right: 0, Straight: 1, Left: 2, UTurn: 3 } as const;

const connSchema = {
  from: Int32Array, to: Int32Array, node: Int32Array,
  x0: Float32Array, y0: Float32Array, z0: Float32Array,
  cx: Float32Array, cz: Float32Array,
  x1: Float32Array, y1: Float32Array, z1: Float32Array,
  len: Float32Array, turn: Uint8Array, arm: Uint8Array,
  nextAtNode: Int32Array, nextFromLane: Int32Array,
};

const p2 = new Float64Array(2), d2 = new Float64Array(2);

export class SimNet {
  readonly net = new RoadNetwork({ touchCell() {} });
  readonly conns = new Table(connSchema, 1 << 14);
  arc = new Float32Array((1 << 14) * (ARC_STEPS + 1));
  retreat = new Float32Array((1 << 14) * 2);
  /** Primeira conexão de cada nó / que sai de cada faixa (listas encadeadas). */
  nodeConn = new Int32Array(1 << 14).fill(-1);
  laneConn = new Int32Array((1 << 14) * 16).fill(-1);
  /** Nó com semáforo: número de fases; 0 = sem semáforo. */
  nodePhases = new Uint8Array(1 << 14);
  /** Controle efetivo do nó (Ctl). */
  nodeCtl = new Uint8Array(1 << 14);
  /** Por nó e braço (n * 8 + braço): fase do semáforo e regra (Rule). */
  armStage = new Uint8Array((1 << 14) * 8);
  armRule = new Uint8Array((1 << 14) * 8);
  /** Direção de saída de cada braço (para a preferência de quem vem pela direita). */
  armDx = new Float32Array((1 << 14) * 8);
  armDz = new Float32Array((1 << 14) * 8);
  /** Braço de cada ponta de trecho no seu nó (trecho * 2 + ponta; 0 = ponta a). Para a rota pesar o cruzamento. */
  segArm = new Uint8Array((1 << 14) * 2);
  /** Conexões que cruzam ou juntam com cada conexão (refeitas com o nó). */
  readonly conflicts = new Map<number, Int32Array>();
  /** Nó de rotatória (entradas dão preferência ao anel). */
  nodeRing = new Uint8Array(1 << 14);
  /** O que o fluxo medido pede no nó automático (Flow; 0 = ainda não mediu: vale a importância das vias). */
  nodeFlow = new Uint8Array(1 << 14);
  /** Braços da via principal do nó (bit por braço), para medir o fluxo principal e o secundário. */
  armMain = new Uint8Array(1 << 14);
  /** O controle do nó ainda pode ser trocado pelo fluxo (automático, cruzamento comum de 3+ braços). */
  nodeAuto = new Uint8Array(1 << 14);
  private dirtyNodes = new Set<number>();
  /** Trechos removidos desde o último passo (os veículos neles saem). */
  readonly removedSegs: number[] = [];
  /** Comprimento total de faixas (para a demanda). */
  laneMeters = 0;

  constructor() {
    this.net.nodes.onGrow((cap) => {
      this.nodeConn = grow(this.nodeConn, cap, -1);
      this.nodePhases = grow(this.nodePhases, cap, 0);
      this.nodeCtl = grow(this.nodeCtl, cap, 0);
      this.armStage = grow(this.armStage, cap * 8, 0);
      this.armRule = grow(this.armRule, cap * 8, 0);
      this.armDx = grow(this.armDx, cap * 8, 0);
      this.armDz = grow(this.armDz, cap * 8, 0);
      this.nodeRing = grow(this.nodeRing, cap, 0);
      this.nodeFlow = grow(this.nodeFlow, cap, 0);
      this.armMain = grow(this.armMain, cap, 0);
      this.nodeAuto = grow(this.nodeAuto, cap, 0);
    });
    this.net.segs.onGrow((cap) => {
      this.arc = grow(this.arc, cap * (ARC_STEPS + 1), 0);
      this.retreat = grow(this.retreat, cap * 2, 0);
      this.segArm = grow(this.segArm, cap * 2, 0);
      this.laneConn = grow(this.laneConn, cap * 16, -1);
    });
  }

  apply(op: NetOp): void {
    const net = this.net;
    switch (op.t) {
      case 'addNode': net.addNode(op.rec); this.nodeFlow[op.rec.id] = 0; this.onNodeReset(op.rec.id); this.dirtyNodes.add(op.rec.id); break;
      case 'remNode': this.clearNode(op.id); net.removeNode(op.id); this.nodeFlow[op.id] = 0; this.nodeAuto[op.id] = 0; this.onNodeReset(op.id); this.dirtyNodes.delete(op.id); break;
      case 'addSeg': {
        net.addSeg(op.rec);
        const q = net.quad(op.rec.id);
        const t = arcTable(q, ARC_STEPS);
        this.arc.set(t, op.rec.id * (ARC_STEPS + 1));
        this.laneMeters += net.segs.cols.len[op.rec.id] * (laneCount(op.rec.profile, 1) + laneCount(op.rec.profile, -1));
        this.dirtyNodes.add(op.rec.a); this.dirtyNodes.add(op.rec.b);
        this.dirtyDeadEndsNear(op.rec.id);
        this.onSegAdded(op.rec.id);
        break;
      }
      case 'remSeg': {
        const sc = net.segs.cols;
        this.laneMeters -= sc.len[op.id] * (laneCount(sc.profile[op.id], 1) + laneCount(sc.profile[op.id], -1));
        this.dirtyNodes.add(sc.a[op.id]); this.dirtyNodes.add(sc.b[op.id]);
        for (let k = 0; k < 16; k++) this.laneConn[op.id * 16 + k] = -1;
        net.removeSeg(op.id);
        this.removedSegs.push(op.id);
        break;
      }
      case 'profile': {
        const sc = net.segs.cols;
        this.laneMeters -= sc.len[op.id] * (laneCount(sc.profile[op.id], 1) + laneCount(sc.profile[op.id], -1));
        net.setProfile(op.id, op.profile);
        this.laneMeters += sc.len[op.id] * (laneCount(op.profile, 1) + laneCount(op.profile, -1));
        this.dirtyNodes.add(sc.a[op.id]); this.dirtyNodes.add(sc.b[op.id]);
        this.removedSegs.push(op.id); // faixas podem ter mudado de número
        break;
      }
      case 'zone': net.setZone(op.id, op.side, op.zone); break; // pedestres nascem mais no comércio
      // o jogador escolheu o controle: o automático volta a medir do zero
      case 'junction': net.setJunction(op.id, op.spec); this.nodeFlow[op.id] = 0; this.onNodeReset(op.id); this.dirtyNodes.add(op.id); break;
      case 'clear':
        net.clear(); this.conns.clear(); this.nodeConn.fill(-1); this.laneConn.fill(-1);
        this.nodePhases.fill(0); this.nodeRing.fill(0); this.dirtyNodes.clear(); this.laneMeters = 0;
        this.nodeCtl.fill(0); this.conflicts.clear(); this.nodeFlow.fill(0); this.armMain.fill(0); this.nodeAuto.fill(0);
        this.removedSegs.length = 0;
        break;
    }
  }

  /** Nó novo, apagado ou com controle escolhido (ids são reaproveitados): quem mede o fluxo zera o dele. */
  onNodeReset: (n: number) => void = () => {};

  /** O fluxo pede outro controle para o nó automático: guarda e refaz o nó no próximo passo. */
  setFlow(n: number, flow: number): void {
    if (this.nodeFlow[n] === flow) return;
    this.nodeFlow[n] = flow;
    this.dirtyNodes.add(n);
  }

  /** Chamado antes de cada conexão sumir (quem estiver nela precisa sair). */
  onConnRemoved: (conn: number) => void = () => {};
  /** Trecho novo entrou na rede (o id pode ser reaproveitado). */
  onSegAdded: (seg: number) => void = () => {};

  /** Refaz recuos e conexões dos nós tocados. Devolve os nós refeitos. */
  rebuild(): number[] {
    const done: number[] = [];
    for (const n of this.dirtyNodes) {
      if (this.net.nodes.alive[n]) this.rebuildNode(n);
      done.push(n);
    }
    this.dirtyNodes.clear();
    return done;
  }

  // ------------------------------------------------------------ geometria

  /** Distância de s (comprimento ao longo do trecho) para t da curva. */
  private tOf(seg: number, s: number): number {
    const o = seg * (ARC_STEPS + 1);
    const tab = this.arc.subarray(o, o + ARC_STEPS + 1);
    return tAtLength(tab as unknown as Float64Array, s);
  }

  segLen(seg: number): number { return this.net.segs.cols.len[seg]; }

  /** Metros desde o nó a até o ponto de parâmetro t da curva. */
  sAlong(seg: number, t: number): number {
    const o = seg * (ARC_STEPS + 1);
    const f = Math.max(0, Math.min(1, t)) * ARC_STEPS;
    const i = Math.min(ARC_STEPS - 1, Math.floor(f));
    return this.arc[o + i] + (this.arc[o + i + 1] - this.arc[o + i]) * (f - i);
  }

  /** t da curva a s metros do nó a. */
  tAt(seg: number, s: number): number { return this.tOf(seg, s); }

  /** Início e fim úteis do trecho (descontados os recuos dos nós). */
  segS0(seg: number): number { return this.retreat[seg * 2]; }
  segS1(seg: number): number { return this.segLen(seg) - this.retreat[seg * 2 + 1]; }

  laneLen(lane: number): number {
    const s = laneSeg(lane);
    return Math.max(0.5, this.segS1(s) - this.segS0(s));
  }

  laneU(lane: number): number {
    const s = laneSeg(lane), p = this.net.segs.cols.profile[s];
    const u = laneDir(lane) > 0 ? PROFILE_INFO[p].fwd : PROFILE_INFO[p].back;
    return u[Math.min(laneIdx(lane), u.length - 1)]?.u ?? 0;
  }

  /** Nó de saída e de chegada da faixa. */
  laneFrom(lane: number): number { const s = laneSeg(lane); return laneDir(lane) > 0 ? this.net.segs.cols.a[s] : this.net.segs.cols.b[s]; }
  laneTo(lane: number): number { const s = laneSeg(lane); return laneDir(lane) > 0 ? this.net.segs.cols.b[s] : this.net.segs.cols.a[s]; }

  /**
   * Ponto a d metros do começo da faixa: out = [x, y, z, rumo].
   * Rumo = ângulo em torno de y (0 = +z), como o yaw de um Object3D.
   */
  lanePoint(lane: number, d: number, out: Float64Array): void {
    const seg = laneSeg(lane), dir = laneDir(lane);
    const s0 = this.segS0(seg), s1 = this.segS1(seg);
    const s = dir > 0 ? s0 + d : s1 - d;
    const q = this.quadOf(seg);
    const t = this.tOf(seg, Math.max(0, Math.min(this.segLen(seg), s)));
    bez(q, t, p2); bezD(q, t, d2);
    const l = Math.hypot(d2[0], d2[1]) || 1;
    const dx = d2[0] / l, dz = d2[1] / l;
    const u = this.laneU(lane);
    const nc = this.net.nodes.cols, sc = this.net.segs.cols;
    const ya = nc.y[sc.a[seg]], yb = nc.y[sc.b[seg]];
    out[0] = p2[0] + dz * u;
    out[2] = p2[1] - dx * u;
    out[1] = ya + (yb - ya) * (s / Math.max(1e-6, this.segLen(seg)));
    out[3] = Math.atan2(dx * dir, dz * dir);
  }

  /** Ponto na conexão (curva) a d metros do começo. */
  connPoint(c: number, d: number, out: Float64Array): void {
    const k = this.conns.cols;
    const t = Math.max(0, Math.min(1, d / Math.max(0.01, k.len[c])));
    const s = 1 - t;
    out[0] = s * s * k.x0[c] + 2 * s * t * k.cx[c] + t * t * k.x1[c];
    out[2] = s * s * k.z0[c] + 2 * s * t * k.cz[c] + t * t * k.z1[c];
    out[1] = k.y0[c] + (k.y1[c] - k.y0[c]) * t;
    const dx = 2 * s * (k.cx[c] - k.x0[c]) + 2 * t * (k.x1[c] - k.cx[c]);
    const dz = 2 * s * (k.cz[c] - k.z0[c]) + 2 * t * (k.z1[c] - k.cz[c]);
    out[3] = Math.atan2(dx, dz);
  }

  private q: Quad = { x0: 0, z0: 0, cx: 0, cz: 0, x1: 0, z1: 0 };
  private quadOf(seg: number): Quad { return this.net.quad(seg, this.q); }

  // ------------------------------------------------------------ nós

  private clearNode(n: number): void {
    const k = this.conns.cols;
    for (let c = this.nodeConn[n]; c >= 0;) {
      const next = k.nextAtNode[c];
      this.onConnRemoved(c);
      this.conflicts.delete(c);
      // tira da lista da faixa de origem
      const from = k.from[c];
      let prev = -1;
      for (let x = this.laneConn[from]; x >= 0; x = k.nextFromLane[x]) {
        if (x === c) { if (prev < 0) this.laneConn[from] = k.nextFromLane[x]; else k.nextFromLane[prev] = k.nextFromLane[x]; break; }
        prev = x;
      }
      this.conns.release(c);
      c = next;
    }
    this.nodeConn[n] = -1;
    this.nodePhases[n] = 0;
    this.nodeRing[n] = 0;
  }

  /** Trecho novo: as pontas sem saída perto dele refazem o balão (pode sumir com a via ao lado). */
  private dirtyDeadEndsNear(seg: number): void {
    const net = this.net, sc = net.segs.cols, nc = net.nodes.cols;
    const r = sc.len[seg] / 2 + BULB_R + 20;
    net.nodeIndex.query(sc.mx[seg] - r, sc.mz[seg] - r, sc.mx[seg] + r, sc.mz[seg] + r, (n) => { if (nc.deg[n] === 1) this.dirtyNodes.add(n); });
  }

  private rebuildNode(n: number): void {
    this.clearNode(n);
    const net = this.net, sc = net.segs.cols;
    const segs = net.segsOf(n, []);
    const deg = segs.length;
    if (deg === 0) return;
    const ends = segs.map((s) => (sc.a[s] === n ? 0 : 1) as 0 | 1);
    const arms = segs.map((s, i) => armOf(net.quad(s), sc.profile[s], ends[i]));
    const lens = segs.map((s) => sc.len[s]);
    const ret = new Float64Array(16);
    const order: number[] = [];
    junctionRetreats(arms, lens, ret, order, deg === 1 && bulbAt(net, n));
    segs.forEach((s, i) => { this.retreat[s * 2 + ends[i]] = ret[i]; });
    const ring = segs.some((s) => (sc.flags[s] & SegFlag.Ring) !== 0);
    this.nodeRing[n] = ring ? 1 : 0;
    const armIndex = new Map<number, number>();
    order.forEach((i, k) => armIndex.set(i, k));
    // controle: regra de cada braço e, no semáforo, as fases (braços opostos juntos)
    const ctl = effectiveControl(net, n, net.junctions.get(n), this.nodeFlow[n]);
    this.nodeCtl[n] = ctl.ctl;
    // só cruzamento comum no automático troca pelo fluxo (rotatória, trilho e faixa no meio da quadra não)
    this.nodeAuto[n] = ctl.auto && deg >= 3 && (ctl.ctl === Ctl.Signal || ctl.ctl === Ctl.Priority || ctl.ctl === Ctl.None) ? 1 : 0;
    const main = mainLegs(net, n);
    const stageOf: number[] = [];
    // faixa com semáforo: fase 0 carros (os dois braços), fase 1 pedestres (nenhum braço)
    const nStages = ctl.ctl === Ctl.Signal ? signalStages(order.map((i) => [arms[i].dx, arms[i].dz]), stageOf) : ctl.ctl === Ctl.PedSignal ? (order.forEach((_, k) => { stageOf[k] = 0; }), 2) : 0;
    this.nodePhases[n] = nStages;
    order.forEach((i, k) => {
      this.armRule[n * 8 + k] = ctl.legs.get(segs[i]) ?? Rule.Free;
      this.armStage[n * 8 + k] = nStages ? stageOf[k] : 0;
      this.armDx[n * 8 + k] = arms[i].dx; this.armDz[n * 8 + k] = arms[i].dz;
      this.segArm[segs[i] * 2 + ends[i]] = k;
    });
    let mainBits = 0;
    order.forEach((i, k) => { if (main.includes(segs[i])) mainBits |= 1 << k; });
    this.armMain[n] = mainBits;
    const spec = net.junctions.get(n);

    const pa = new Float64Array(4), pb = new Float64Array(4);
    for (let i = 0; i < deg; i++) {
      const si = segs[i], ei = ends[i];
      const inDir = ei === 1 ? 1 : -1; // faixas que chegam ao nó
      const m = laneCount(sc.profile[si], inDir);
      if (m === 0) continue;
      // rumo de chegada = contrário do braço
      const hx = -arms[i].dx, hz = -arms[i].dz;
      for (let j = 0; j < deg; j++) {
        // retorno no canteiro: a faixa da esquerda volta pelo mesmo trecho
        if (j === i && deg > 1 && ctl.ctl !== Ctl.UTurn) continue;
        const sj = segs[j], ej = ends[j];
        if (banned(spec, si, sj)) continue;
        if (PROFILE_INFO[sc.profile[si]].rail !== PROFILE_INFO[sc.profile[sj]].rail) continue; // trilho só liga com trilho
        const outDir = ej === 0 ? 1 : -1; // faixas que saem do nó
        const k = laneCount(sc.profile[sj], outDir);
        if (k === 0) continue;
        let turn: number;
        if (j === i) turn = Turn.UTurn;
        else if (deg === 2) turn = Turn.Straight;
        else {
          const ox = arms[j].dx, oz = arms[j].dz;
          const left = ox * hz - oz * hx; // >0: à esquerda (esquerda de h = (hz, -hx))
          const fwd = ox * hx + oz * hz;
          turn = fwd > 0.7 ? Turn.Straight : left > 0 ? Turn.Left : Turn.Right;
        }
        // que faixas fazem o movimento: setas da faixa (ou pela posição)
        const pairs: Array<[number, number]> = [];
        const lanesIn = inDir > 0 ? PROFILE_INFO[sc.profile[si]].fwd : PROFILE_INFO[sc.profile[si]].back;
        const bit = turn === Turn.Straight ? TurnBit.Straight : turn === Turn.Right ? TurnBit.Right : TurnBit.Left;
        const ok: number[] = [];
        for (let a = 0; a < m; a++) {
          // faixa ajustada à mão no cruzamento: só as saídas escolhidas (a seta pintada sai da mesma lista)
          if (turn === Turn.UTurn && ctl.ctl === Ctl.UTurn && a !== m - 1) continue;
          const custom = customExits(spec, si, a);
          if (custom ? custom.includes(sj) && turn !== Turn.UTurn : deg <= 2 || turn === Turn.UTurn || (laneTurns(lanesIn[a]?.turns ?? 0, a, m) & bit)) ok.push(a);
        }
        if (turn === Turn.Left || turn === Turn.UTurn) ok.forEach((a, r) => pairs.push([a, Math.max(0, k - 1 - Math.min(ok.length - 1 - r, k - 1))]));
        else ok.forEach((a, r) => pairs.push([a, Math.min(r, k - 1)]));
        for (const [a, b] of pairs) {
          const from = laneId(si, inDir, a), to = laneId(sj, outDir, b);
          this.lanePoint(from, this.laneLen(from), pa);
          this.lanePoint(to, 0, pb);
          const c = this.conns.alloc();
          const kc = this.conns.cols;
          kc.from[c] = from; kc.to[c] = to; kc.node[c] = n;
          kc.x0[c] = pa[0]; kc.y0[c] = pa[1]; kc.z0[c] = pa[2];
          kc.x1[c] = pb[0]; kc.y1[c] = pb[1]; kc.z1[c] = pb[2];
          // controle: cruzamento das tangentes, se fizer sentido
          const d0x = Math.sin(pa[3]), d0z = Math.cos(pa[3]), d1x = Math.sin(pb[3]), d1z = Math.cos(pb[3]);
          const den = d0x * d1z - d0z * d1x;
          let cx = (pa[0] + pb[0]) / 2, cz = (pa[2] + pb[2]) / 2;
          if (Math.abs(den) > 0.05) {
            const wx = pb[0] - pa[0], wz = pb[2] - pa[2];
            const t0 = (wx * d1z - wz * d1x) / den, t1 = (wx * d0z - wz * d0x) / den;
            if (t0 > 0 && t1 > 0 && t0 < 80 && t1 < 80) { cx = pa[0] + d0x * t0; cz = pa[2] + d0z * t0; }
          } else if (turn === Turn.UTurn) {
            // rua sem saída com balão: a volta vai até perto do nó (a faixa termina no recuo do balão)
            const nc = this.net.nodes.cols;
            const ext = deg === 1 ? 2 * (Math.hypot(nc.x[n] - pa[0], nc.z[n] - pa[2]) + 3) : 8;
            cx = (pa[0] + pb[0]) / 2 + d0x * ext; cz = (pa[2] + pb[2]) / 2 + d0z * ext;
          }
          kc.cx[c] = cx; kc.cz[c] = cz;
          kc.len[c] = quadLen(pa[0], pa[2], cx, cz, pb[0], pb[2]);
          kc.turn[c] = turn; kc.arm[c] = armIndex.get(i) ?? 0;
          kc.nextAtNode[c] = this.nodeConn[n]; this.nodeConn[n] = c;
          kc.nextFromLane[c] = this.laneConn[from]; this.laneConn[from] = c;
        }
      }
    }
    if (deg >= 3) this.buildConflicts(n);
  }

  /** Pares de conexões do nó que se cruzam ou chegam na mesma faixa. */
  private buildConflicts(n: number): void {
    const k = this.conns.cols;
    const list: number[] = [];
    for (let c = this.nodeConn[n]; c >= 0; c = k.nextAtNode[c]) list.push(c);
    const P = 8;
    const pts = new Float64Array(list.length * (P + 1) * 2);
    list.forEach((c, i) => {
      for (let j = 0; j <= P; j++) {
        const t = j / P, s = 1 - t;
        pts[(i * (P + 1) + j) * 2] = s * s * k.x0[c] + 2 * s * t * k.cx[c] + t * t * k.x1[c];
        pts[(i * (P + 1) + j) * 2 + 1] = s * s * k.z0[c] + 2 * s * t * k.cz[c] + t * t * k.z1[c];
      }
    });
    const out: number[][] = list.map(() => []);
    for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
      const ca = list[a], cb = list[b];
      if (k.arm[ca] === k.arm[cb]) continue; // mesmo braço: fila, não conflito
      let hit = k.to[ca] === k.to[cb];
      for (let i = 0; i < P && !hit; i++) for (let j = 0; j < P && !hit; j++) {
        const o1 = (a * (P + 1) + i) * 2, o2 = (b * (P + 1) + j) * 2;
        hit = segCross(pts[o1], pts[o1 + 1], pts[o1 + 2], pts[o1 + 3], pts[o2], pts[o2 + 1], pts[o2 + 2], pts[o2 + 3]);
      }
      if (hit) { out[a].push(cb); out[b].push(ca); }
    }
    list.forEach((c, i) => { if (out[i].length) this.conflicts.set(c, Int32Array.from(out[i])); });
  }

  /** Faixa só de ônibus? */
  isBusLane(lane: number): boolean { return laneBus(this.net.segs.cols.profile[laneSeg(lane)], laneDir(lane), laneIdx(lane)); }

  /** Conexão que leva da faixa ao trecho `toSeg`; sem `bus`, prefere chegar fora da faixa de ônibus. */
  connToward(lane: number, toSeg: number, bus = true): number {
    const k = this.conns.cols;
    let any = -1;
    for (let c = this.laneConn[lane]; c >= 0; c = k.nextFromLane[c]) {
      if (laneSeg(k.to[c]) !== toSeg) continue;
      if (bus || !this.isBusLane(k.to[c])) return c;
      if (any < 0) any = c;
    }
    return any;
  }

  /** Alguma faixa do trecho/sentido que tem conexão para `toSeg`; prefere a mais perto de `idx` (e fora da de ônibus, sem `bus`). */
  laneToward(seg: number, dir: number, toSeg: number, idx: number, bus = true): number {
    const p = this.net.segs.cols.profile[seg];
    const n = laneCount(p, dir);
    let best = -1, bd = 1e9;
    for (let i = 0; i < n; i++) {
      const l = laneId(seg, dir, i);
      if (this.connToward(l, toSeg, bus) < 0) continue;
      const d = Math.abs(i - idx) + (!bus && laneBus(p, dir, i) ? 100 : 0);
      if (d < bd) { bd = d; best = l; }
    }
    return best;
  }
}

/** Setas efetivas: as da faixa, ou pela posição (direita vira à direita, esquerda à esquerda). */
export function laneTurns(turns: number, idx: number, count: number): number {
  if (turns) return turns;
  if (count === 1) return TurnBit.Left | TurnBit.Straight | TurnBit.Right;
  if (idx === 0) return TurnBit.Right | TurnBit.Straight;
  if (idx === count - 1) return TurnBit.Left | TurnBit.Straight;
  return TurnBit.Straight;
}

function segCross(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): boolean {
  const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax), d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx), d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function quadLen(x0: number, z0: number, cx: number, cz: number, x1: number, z1: number): number {
  let len = 0, px = x0, pz = z0;
  for (let i = 1; i <= 8; i++) {
    const t = i / 8, s = 1 - t;
    const x = s * s * x0 + 2 * s * t * cx + t * t * x1, z = s * s * z0 + 2 * s * t * cz + t * t * z1;
    len += Math.hypot(x - px, z - pz); px = x; pz = z;
  }
  return Math.max(0.5, len);
}

function grow<T extends Int32Array | Float32Array | Uint8Array>(a: T, cap: number, fill: number): T {
  if (cap <= a.length) return a;
  const b = new (a.constructor as new (n: number) => T)(cap);
  b.fill(fill);
  b.set(a);
  return b;
}

/** Codifica mudanças da rede para mandar ao worker (8 números por operação). */
export function encodeOps(ops: NetOp[], extra: string[] = []): Float64Array {
  const out = new Float64Array(ops.length * 8);
  ops.forEach((op, i) => {
    const o = i * 8;
    switch (op.t) {
      case 'addNode': out[o] = 1; out[o + 1] = op.rec.id; out[o + 2] = op.rec.x; out[o + 3] = op.rec.z; out[o + 4] = op.rec.y; break;
      case 'remNode': out[o] = 2; out[o + 1] = op.id; break;
      case 'addSeg': { const r = op.rec; out[o] = 3; out[o + 1] = r.id; out[o + 2] = r.a; out[o + 3] = r.b; out[o + 4] = r.cx; out[o + 5] = r.cz; out[o + 6] = r.profile; out[o + 7] = r.flags + (r.zl ?? 0) * 256 + (r.zr ?? 0) * 4096; break; }
      case 'remSeg': out[o] = 4; out[o + 1] = op.id; break;
      case 'profile': out[o] = 5; out[o + 1] = op.id; out[o + 2] = op.profile; break;
      case 'zone': out[o] = 7; out[o + 1] = op.id; out[o + 2] = op.side; out[o + 3] = op.zone; break;
      case 'junction': out[o] = 8; out[o + 1] = op.id; out[o + 2] = extra.length; extra.push(JSON.stringify(op.spec)); break;
      case 'clear': out[o] = 6; break;
    }
  });
  return out;
}

export function decodeOp(a: Float64Array, i: number, extra: string[] = []): NetOp {
  const o = i * 8;
  switch (a[o]) {
    case 1: return { t: 'addNode', rec: { id: a[o + 1], x: a[o + 2], z: a[o + 3], y: a[o + 4] } };
    case 2: return { t: 'remNode', id: a[o + 1] };
    case 3: { const f = a[o + 7]; return { t: 'addSeg', rec: { id: a[o + 1], a: a[o + 2], b: a[o + 3], cx: a[o + 4], cz: a[o + 5], profile: a[o + 6], flags: f % 256, zl: Math.floor(f / 256) % 16, zr: Math.floor(f / 4096) % 16 } }; }
    case 4: return { t: 'remSeg', id: a[o + 1] };
    case 5: return { t: 'profile', id: a[o + 1], profile: a[o + 2] };
    case 7: return { t: 'zone', id: a[o + 1], side: a[o + 2], zone: a[o + 3] };
    case 8: return { t: 'junction', id: a[o + 1], spec: JSON.parse(extra[a[o + 2]] ?? 'null') as JunctionSpec | null };
    default: return { t: 'clear' };
  }
}

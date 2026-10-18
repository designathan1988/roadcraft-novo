// Rotas: A* no grafo de nós e trechos (mão única respeitada), custo em tempo.
// A pé: o mesmo grafo, sem mão única, só trechos com calçada.
// Arrays tipados reaproveitados entre buscas; nada percorre a frota.

import { MAX_DEG } from '../roads/network.ts';
import { PROFILES, PROFILE_INFO } from '../roads/profiles.ts';
import { Ctl, Rule } from '../roads/control.ts';
import type { SimNet } from './lanes.ts';

const MAX_SPEED = 90 / 3.6;
/**
 * Carro: a estimativa do resto do caminho usa a velocidade típica da cidade com as esperas (30 km/h), não a
 * máxima: a busca abre ~3× menos nós (o mapa de 16 km abre com a frota em metade do tempo e cada viagem nova
 * custa menos), e as rotas saem quase as mesmas (velocidade no centro igual, medido).
 */
const GUESS_SPEED = 30 / 3.6;
export const WALK_SPEED = 1.35;

export class Router {
  private g = new Float64Array(1 << 14);
  private from = new Int32Array(1 << 14);
  /** Trecho por onde a busca chegou a cada nó (para o custo da conversão e da regra do braço). */
  private via = new Int32Array(1 << 14);
  private stamp = new Uint32Array(1 << 14);
  private closed = new Uint32Array(1 << 14);
  private cur = 0;
  private heapN = new Int32Array(1 << 14);
  private heapF = new Float64Array(1 << 14);
  private heapSize = 0;
  private path = new Int32Array(1024);
  private sim: SimNet;
  /** Expansões máximas por busca (rotas longas demais falham e o carro some). */
  limit = 40000;
  /** Nós abertos e buscas sem caminho, desde sempre (diagnóstico). */
  expanded = 0; failed = 0;

  /** Veículos por trecho e sentido (do trânsito): o custo sobe com a lotação. */
  segLoad: Uint16Array | null = null;

  constructor(sim: SimNet) { this.sim = sim; }

  /** Segundos de espera esperados no nó `n` chegando por `sIn` e saindo por `sOut`. */
  nodeCost(n: number, sIn: number, sOut: number): number {
    const sim = this.sim, sc = sim.net.segs.cols;
    if (sim.net.nodes.cols.deg[n] < 3) return 0;
    const ai = n * 8 + sim.segArm[sIn * 2 + (sc.a[sIn] === n ? 0 : 1)];
    const ao = n * 8 + sim.segArm[sOut * 2 + (sc.a[sOut] === n ? 0 : 1)];
    // rumo de chegada (contra o braço de entrada) e braço de saída: produto vetorial > 0 é à direita
    const hx = -sim.armDx[ai], hz = -sim.armDz[ai], ox = sim.armDx[ao], oz = sim.armDz[ao];
    const cross = hx * oz - hz * ox, dot = hx * ox + hz * oz;
    const turn = dot > 0.7 ? 0 : cross > 0 ? 2 : dot < -0.7 ? 15 : 6;
    const signal = sim.nodePhases[n] > 0;
    if (signal) return 10 + turn * 1.3;
    if (sim.nodeRing[n]) return 3;
    const rule = sim.armRule[ai];
    const wait = rule === Rule.Stop ? (sim.nodeCtl[n] === Ctl.AllStop ? 6 : 8) : rule === Rule.Yield ? 4 : rule === Rule.Main ? 0 : 2;
    return wait + turn;
  }

  private ensure(cap: number): void {
    if (cap <= this.g.length) return;
    let n = this.g.length;
    while (n < cap) n *= 2;
    const gr = <T extends Float64Array | Int32Array | Uint32Array>(a: T): T => { const b = new (a.constructor as new (n: number) => T)(n); b.set(a); return b; };
    this.g = gr(this.g); this.from = gr(this.from); this.via = gr(this.via); this.stamp = gr(this.stamp); this.closed = gr(this.closed);
  }

  private push(n: number, f: number): void {
    if (this.heapSize >= this.heapN.length) {
      const a = new Int32Array(this.heapN.length * 2); a.set(this.heapN); this.heapN = a;
      const b = new Float64Array(this.heapF.length * 2); b.set(this.heapF); this.heapF = b;
    }
    let i = this.heapSize++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.heapF[p] <= f) break;
      this.heapN[i] = this.heapN[p]; this.heapF[i] = this.heapF[p]; i = p;
    }
    this.heapN[i] = n; this.heapF[i] = f;
  }

  private pop(): number {
    const top = this.heapN[0];
    const ln = this.heapN[--this.heapSize], lf = this.heapF[this.heapSize];
    let i = 0;
    for (;;) {
      let c = i * 2 + 1;
      if (c >= this.heapSize) break;
      if (c + 1 < this.heapSize && this.heapF[c + 1] < this.heapF[c]) c++;
      if (this.heapF[c] >= lf) break;
      this.heapN[i] = this.heapN[c]; this.heapF[i] = this.heapF[c]; i = c;
    }
    this.heapN[i] = ln; this.heapF[i] = lf;
    return top;
  }

  /**
   * Caminho de nós de `src` a `dst` em `out` (a partir de `at`), até `max` nós.
   * Devolve quantos nós escreveu (0 = sem caminho). `ban`: trecho proibido na saída de `src` (evita retorno);
   * `ban2`: outro (a saída cheia de quem reconsidera a rota).
   */
  route(src: number, dst: number, out: Int32Array, at: number, max: number, walk = false, ban = -1, rail = false, ban2 = -1): number {
    const net = this.sim.net, nc = net.nodes.cols, sc = net.segs.cols;
    this.ensure(net.nodes.capacity);
    if (++this.cur === 0xffffffff) { this.stamp.fill(0); this.closed.fill(0); this.cur = 1; }
    const cur = this.cur;
    if (!net.nodes.alive[src] || !net.nodes.alive[dst]) return 0;
    const tx = nc.x[dst], tz = nc.z[dst];
    const vmax = walk ? WALK_SPEED : rail ? MAX_SPEED : GUESS_SPEED;
    const h = (n: number) => Math.hypot(nc.x[n] - tx, nc.z[n] - tz) / vmax;
    this.heapSize = 0;
    this.g[src] = 0; this.stamp[src] = cur; this.from[src] = -1; this.via[src] = -1;
    this.push(src, h(src));
    let expanded = 0;
    let found = false;
    while (this.heapSize > 0) {
      const n = this.pop();
      if (this.closed[n] === cur) continue;
      this.closed[n] = cur;
      if (n === dst) { found = true; break; }
      if (++expanded > this.limit) break;
      const o = n * MAX_DEG, d = nc.deg[n];
      for (let k = 0; k < d; k++) {
        const s = net.adj[o + k];
        if (s < 0 || !net.segs.alive[s] || ((s === ban || s === ban2) && n === src)) continue; // sem retorno no trecho de onde veio
        const p = PROFILES[sc.profile[s]];
        if (!walk && PROFILE_INFO[sc.profile[s]].rail !== rail) continue; // carro não anda no trilho, trem só no trilho
        const forward = sc.a[s] === n;
        // a pé: mão única não importa, mas só onde há calçada
        if (walk ? !PROFILE_INFO[sc.profile[s]].walk : p.oneWay && !forward) continue;
        const m = forward ? sc.b[s] : sc.a[s];
        if (this.closed[m] === cur) continue;
        let edge = walk ? sc.len[s] / WALK_SPEED + 1 : sc.len[s] / (p.speed / 3.6) + 2; // + espera por nó
        // carro: o cruzamento custa pelo controle e pela conversão (avenida com semáforo vence
        // a rua local cheia de pare; virar à esquerda custa mais que seguir reto)
        if (!walk && !rail && this.via[n] >= 0) edge += this.nodeCost(n, this.via[n], s);
        const load = this.segLoad;
        if (!walk && load) {
          // lotação: tempo cresce com o quadrado da ocupação (curva BPR forte): o motorista foge da rua cheia
          const info = PROFILE_INFO[sc.profile[s]];
          const cap = Math.max(1, sc.len[s] * Math.max(1, forward ? info.lanesFwd : info.lanesBack) / 7.5);
          const r = load[s * 2 + (forward ? 0 : 1)] / cap;
          edge *= 1 + 10 * r * r;
        }
        const cost = this.g[n] + edge;
        if (this.stamp[m] !== cur || cost < this.g[m]) {
          this.stamp[m] = cur; this.g[m] = cost; this.from[m] = n; this.via[m] = s;
          this.push(m, cost + h(m));
        }
      }
    }
    this.expanded += expanded;
    if (!found) { this.failed++; return 0; }
    // reconstrói do fim; guarda os primeiros `max` nós (o resto é recalculado no caminho)
    let len = 0;
    for (let n = dst; n >= 0; n = this.from[n]) {
      if (len >= this.path.length) { const p = new Int32Array(this.path.length * 2); p.set(this.path); this.path = p; }
      this.path[len++] = n;
    }
    const take = Math.min(len, max);
    for (let i = 0; i < take; i++) out[at + i] = this.path[len - 1 - i];
    return take;
  }
}

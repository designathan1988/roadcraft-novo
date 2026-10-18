// Pedestres (worker de simulação). Mesmo esquema do trânsito: no mapa todo
// só eventos (fim de cada trecho de caminhada, numa fila por tempo); perto da
// câmera, posição a cada quadro, espera nas faixas de pedestre com semáforo.
// Caminho = rota A* nos nós (só trechos com calçada); em cada nó, contorna as
// esquinas e atravessa os braços pelas faixas. Nada percorre a multidão por
// tick: cada pessoa fica na lista do nó para onde anda, e a janela lê só as
// listas dos nós perto da câmera.

import { Table } from '../core/table.ts';
import { Rng } from '../core/rng.ts';
import { armAngle, bez, bezD } from '../roads/geometry.ts';
import { armOf } from '../roads/junction.ts';
import { PROFILE_INFO } from '../roads/profiles.ts';
import { baseZone } from '../roads/zones.ts';
import { MAX_DEG } from '../roads/network.ts';
import type { SimNet } from './lanes.ts';
import { Router } from './routing.ts';

const MAX_PEDS = 100000;
/** Chance de nascer num nó pela zona das vias em volta (nenhuma, residencial, comercial, industrial, misto). */
const ZONE_PULL = [0.12, 0.4, 1, 0.15, 0.8];
const ROUTE = 32;
const WAYS = 12;
const CROSS_AT = 2.15; // meio da faixa de pedestre, a partir do recuo
const WINDOW = 520;
const CURB = 0.15;
/** Parte das viagens que sai de bicicleta quando há ciclofaixa perto (roadcraft `vehicles/cycleLane.ts`). */
const BIKE_SHARE = 0.1;
/** Trechos que um ciclista percorre (passeio pelas ciclofaixas, sem roteador). */
const BIKE_LEGS = 24;

/** u do meio da ciclofaixa de quem anda no sentido `dir` do trecho (mão direita; NaN = sem ciclofaixa). */
function bikeU(profile: number, dir: number): number {
  let best = NaN;
  for (const e of PROFILE_INFO[profile].edges) {
    if (e.strip.kind !== 'bike') continue;
    const u = (e.u0 + e.u1) / 2;
    // a→b anda à direita (u < 0); b→a, à esquerda (u > 0); ciclofaixa de um lado só: serve aos dois sentidos
    if ((dir > 0 && u < 0) || (dir < 0 && u > 0)) return u;
    best = u;
  }
  return best;
}

const schema = {
  // rota
  rLen: Uint8Array, rIdx: Uint8Array,
  // trecho atual (calçada): de da a db metros desde o nó a, no lado side (+1 = u+)
  seg: Int32Array, side: Int8Array, da: Float32Array, db: Float32Array,
  // passo atual: 0 calçada, 1 reta entre pontos, 2 esperando
  mode: Uint8Array, wIdx: Uint8Array, wLen: Uint8Array,
  t0: Float64Array, dur: Float32Array, at: Float64Array,
  // nó para onde anda (lista da janela)
  node: Int32Array, next: Int32Array, prev: Int32Array,
  speed: Float32Array, color: Uint8Array,
  // última posição publicada (para interpolar)
  px: Float32Array, py: Float32Array, pz: Float32Array, pyaw: Float32Array, has: Uint8Array,
  // viagem de ônibus: linha (-1 = só a pé), parada de embarque e de descida
  tLine: Int16Array, tFrom: Uint8Array, tTo: Uint8Array,
  // de bicicleta (anda pela ciclofaixa)
  bike: Uint8Array,
  // onde entra no primeiro trecho de calçada (0-1; quem sai de uma porta entra no meio)
  enter: Float32Array,
};

const p2 = new Float64Array(2), d2 = new Float64Array(2);

export class Peds {
  readonly t = new Table(schema, 4096);
  private sim: SimNet;
  private router: Router;
  private routes = new Int32Array(4096 * ROUTE);
  /** Pontos de passagem por pessoa: x, y, z, braço atravessado + 1 (0 = não é travessia). */
  private ways = new Float32Array(4096 * WAYS * 4);
  private wayNode = new Int32Array(4096);
  /** Ponto de partida da reta atual (ou onde está parado). */
  private lineFrom = new Float32Array(4096 * 3);
  private pos3 = [0, 0, 0, 0];
  private head = new Int32Array(1 << 14).fill(-1);
  private heapT = new Float64Array(1 << 14);
  private heapP = new Int32Array(1 << 14);
  private heapN = 0;
  private rng = new Rng(4242);
  private time = 0;
  private windowNodes: number[] = [];
  /** Semáforo: carros do braço `arm` do nó `n` estão andando? (dado pelo trânsito) */
  carsGo: (n: number, arm: number) => boolean = () => false;
  /** Pessoas por metro de faixa de carro (demanda simples). */
  density = 1 / 30;
  /** Porcentagem de pessoas escolhida pelo jogador. */
  share = 1;
  camX = 0;
  camZ = 0;
  /** Portas perto da câmera (x, z), da página. */
  doors: Float32Array = new Float32Array(0);

  constructor(sim: SimNet) {
    this.sim = sim;
    this.router = new Router(sim);
    this.t.onGrow((cap) => {
      const r = new Int32Array(cap * ROUTE); r.set(this.routes); this.routes = r;
      const w = new Float32Array(cap * WAYS * 4); w.set(this.ways); this.ways = w;
      const n = new Int32Array(cap); n.set(this.wayNode); this.wayNode = n;
      const f = new Float32Array(cap * 3); f.set(this.lineFrom); this.lineFrom = f;
    });
    sim.net.nodes.onGrow((cap) => {
      const h = new Int32Array(cap).fill(-1); h.set(this.head); this.head = h;
    });
  }

  get count(): number { return this.t.size; }

  // ------------------------------------------------------------ fila de eventos

  private schedule(p: number, at: number): void {
    this.t.cols.at[p] = at;
    if (this.heapN >= this.heapT.length) {
      const a = new Float64Array(this.heapT.length * 2); a.set(this.heapT); this.heapT = a;
      const b = new Int32Array(this.heapP.length * 2); b.set(this.heapP); this.heapP = b;
    }
    let i = this.heapN++;
    while (i > 0) {
      const q = (i - 1) >> 1;
      if (this.heapT[q] <= at) break;
      this.heapT[i] = this.heapT[q]; this.heapP[i] = this.heapP[q]; i = q;
    }
    this.heapT[i] = at; this.heapP[i] = p;
  }

  private popEvent(): void {
    const lt = this.heapT[--this.heapN], lp = this.heapP[this.heapN];
    let i = 0;
    for (;;) {
      let c = i * 2 + 1;
      if (c >= this.heapN) break;
      if (c + 1 < this.heapN && this.heapT[c + 1] < this.heapT[c]) c++;
      if (this.heapT[c] >= lt) break;
      this.heapT[i] = this.heapT[c]; this.heapP[i] = this.heapP[c]; i = c;
    }
    this.heapT[i] = lt; this.heapP[i] = lp;
  }

  /** Alguém na faixa de pedestres do nó agora (andando no trecho de travessia)? */
  crossing(n: number): boolean {
    const c = this.t.cols;
    for (let p = this.head[n]; p >= 0; p = c.next[p]) {
      if (c.mode[p] !== 1 && c.mode[p] !== 2) continue;
      const w = c.wIdx[p] - 1;
      if (w >= 0 && this.ways[p * WAYS * 4 + w * 4 + 3] > 0) return true;
    }
    return false;
  }

  // ------------------------------------------------------------ listas por nó

  private link(p: number, n: number): void {
    const c = this.t.cols;
    c.node[p] = n; c.prev[p] = -1; c.next[p] = this.head[n];
    if (this.head[n] >= 0) c.prev[this.head[n]] = p;
    this.head[n] = p;
  }

  private unlink(p: number): void {
    const c = this.t.cols, n = c.node[p];
    if (n < 0) return;
    if (c.prev[p] >= 0) c.next[c.prev[p]] = c.next[p]; else if (this.head[n] === p) this.head[n] = c.next[p];
    if (c.next[p] >= 0) c.prev[c.next[p]] = c.prev[p];
    c.node[p] = -1;
  }

  // ------------------------------------------------------------ nascer e sumir

  private randomNode(): number {
    const net = this.sim.net, t = net.nodes, sc = net.segs.cols;
    for (let i = 0; i < 12; i++) {
      const n = this.rng.int(0, t.end);
      if (!t.alive[n] || t.cols.deg[n] === 0) continue;
      // mais gente onde há comércio
      let pull = 0;
      for (let k = 0; k < t.cols.deg[n]; k++) {
        const s = net.adj[n * MAX_DEG + k];
        pull = Math.max(pull, ZONE_PULL[baseZone(sc.zl[s])] ?? 0.1, ZONE_PULL[baseZone(sc.zr[s])] ?? 0.1);
      }
      if (this.rng.next() < pull) return n;
    }
    return -1;
  }

  /** Viagem de ônibus ao acaso (do trânsito): [linha, embarque, descida, nó do embarque]. */
  pickTrip: () => [number, number, number, number] | null = () => null;
  /** Chegou na parada: passa a esperar o ônibus (na conta do trânsito). */
  onStop: (line: number, from: number, to: number) => void = () => {};
  /** Parte de quem anda vai pegar ônibus (quando há linhas). */
  transitShare = 0.3;

  /** Desceram do ônibus no nó: seguem a pé até um destino perto. */
  spawnAt(node: number, count: number, color = -1): void {
    for (let k = 0; k < count && this.t.size < MAX_PEDS; k++) {
      this.nextColor = color;
      this.spawnFrom(node, 600, -1, 0, 0, 0);
    }
    this.nextColor = -1;
  }

  /** Cor da próxima pessoa (criador de pessoas); −1 = sorteada. */
  private nextColor = -1;

  /**
   * Tira de cena quem estiver a até `r` metros de (x, z), só nas listas dos nós perto (nunca a multidão
   * inteira). Devolve quantos. `one`: só o mais perto (pistola).
   */
  hit(x: number, z: number, r: number, one: boolean): number {
    const net = this.sim.net, c = this.t.cols;
    const near: number[] = [];
    net.nodeIndex.query(x - r - 120, z - r - 120, x + r + 120, z + r + 120, (n) => near.push(n));
    let best = -1, bd = r, n0 = 0;
    const doomed: number[] = [];
    for (const n of near) for (let p = this.head[n]; p >= 0; p = c.next[p]) {
      if (!c.has[p]) continue;
      const d = Math.hypot(c.px[p] - x, c.pz[p] - z);
      if (d > r) continue;
      if (one) { if (d < bd) { bd = d; best = p; } } else doomed.push(p);
    }
    if (one && best >= 0) doomed.push(best);
    for (const p of doomed) { this.kill(p); n0++; }
    return n0;
  }

  private spawn(): void {
    // parte vai a pé até uma parada, pega o ônibus e desce longe
    if (this.rng.next() < this.transitShare) {
      const trip = this.pickTrip();
      if (trip) {
        const [li, from, to, stopNode] = trip;
        const net = this.sim.net, nc = net.nodes.cols;
        if (!net.nodes.alive[stopNode]) return;
        const cand: number[] = [];
        net.nodeIndex.query(nc.x[stopNode] - 500, nc.z[stopNode] - 500, nc.x[stopNode] + 500, nc.z[stopNode] + 500, (n) => { if (cand.length < 200) cand.push(n); });
        const a = cand.length ? cand[this.rng.int(0, cand.length)] : -1;
        if (a >= 0 && a !== stopNode) this.spawnRoute(a, stopNode, li, from, to);
        return;
      }
    }
    const a = this.randomNode();
    if (a < 0) return;
    if (this.rng.next() < BIKE_SHARE && this.spawnBike(a)) return;
    if (this.doors.length && this.rng.next() < 0.5 && this.spawnFromDoor()) return;
    this.spawnFrom(a, 900, -1, 0, 0, this.rng.next());
  }

  /**
   * Sai de uma porta perto da câmera (roadcraft `lotDoors`): anda reto da porta até a calçada do trecho mais perto e
   * segue a rota dali (até um nó ao acaso a até 900 m).
   */
  private spawnFromDoor(): boolean {
    const k = this.rng.int(0, this.doors.length >> 1);
    return this.spawnFromPoint(this.doors[k * 2], this.doors[k * 2 + 1]);
  }

  /** Someone starts walking at (x, z) (a door, or a passenger getting out of a car at the kerb): to the sidewalk, then on. */
  spawnFromPoint(x: number, z: number): boolean {
    if (this.t.size >= MAX_PEDS) return false;
    const net = this.sim.net, sc = net.segs.cols, nc = net.nodes.cols, sim = this.sim;
    const hit = net.nearestSeg(x, z, 30, (s) => PROFILE_INFO[sc.profile[s]].walk);
    if (!hit) return false;
    const [s, t] = hit;
    const q = net.quad(s);
    bez(q, t, p2); bezD(q, t, d2);
    const l = Math.hypot(d2[0], d2[1]) || 1, dx = d2[0] / l, dz = d2[1] / l;
    // lado da porta (u+ = esquerda de a→b) e o ponto da calçada daquele lado
    const sideSign = (x - p2[0]) * dz - (z - p2[1]) * dx > 0 ? 1 : -1;
    const [u, side] = this.sideU(sc.profile[s], sideSign);
    const L = sim.segLen(s), r0 = sim.segS0(s), r1 = sim.segS1(s), dA = Math.max(r0, Math.min(r1, t * L));
    // anda para a ponta mais perto do destino
    const n0a = sc.a[s], n0b = sc.b[s];
    const cand: number[] = [];
    net.nodeIndex.query(x - 900, z - 900, x + 900, z + 900, (n) => { if (cand.length < 400) cand.push(n); });
    let b = -1;
    for (let i = 0; i < 8 && cand.length; i++) {
      const n = cand[this.rng.int(0, cand.length)];
      const d = Math.hypot(nc.x[n] - x, nc.z[n] - z);
      if (d > 150 && d < 900 && nc.deg[n] > 0) { b = n; break; }
    }
    if (b < 0) return false;
    const towardB = Math.hypot(nc.x[n0b] - nc.x[b], nc.z[n0b] - nc.z[b]) < Math.hypot(nc.x[n0a] - nc.x[b], nc.z[n0a] - nc.z[b]);
    const from = towardB ? n0a : n0b, to = towardB ? n0b : n0a;
    const p = this.t.alloc();
    const c = this.t.cols;
    const r = p * ROUTE;
    this.routes[r] = from;
    const len = this.router.route(to, b, this.routes, r + 1, ROUTE - 1, true);
    if (len < 1 || this.routes[r + len] !== b) { this.t.release(p); return false; }
    c.rLen[p] = len + 1; c.rIdx[p] = 0; c.node[p] = -1; c.has[p] = 0;
    c.speed[p] = 1.1 + this.rng.next() * 0.55;
    c.color[p] = this.rng.int(0, 16);
    c.side[p] = side;
    c.tLine[p] = -1; c.tFrom[p] = 0; c.tTo[p] = 0;
    c.bike[p] = 0;
    c.seg[p] = s;
    c.enter[p] = Math.max(0, Math.min(0.98, (towardB ? dA - r0 : r1 - dA) / Math.max(0.5, r1 - r0)));
    // reta da porta até a calçada
    const y = nc.y[sc.a[s]] + (nc.y[sc.b[s]] - nc.y[sc.a[s]]) * (dA / Math.max(1e-6, L)) + CURB;
    this.lineFrom[p * 3] = x; this.lineFrom[p * 3 + 1] = y; this.lineFrom[p * 3 + 2] = z;
    const o = p * WAYS * 4;
    this.ways[o] = p2[0] + dz * u; this.ways[o + 1] = y; this.ways[o + 2] = p2[1] - dx * u; this.ways[o + 3] = 0;
    c.pyaw[p] = Math.atan2(this.ways[o] - x, this.ways[o + 2] - z);
    c.wIdx[p] = 0; c.wLen[p] = 1; c.mode[p] = 3;
    this.wayNode[p] = from;
    this.unlink(p);
    this.link(p, to);
    if (!this.nextWay(p)) { this.kill(p); return false; }
    return true;
  }

  /**
   * Ciclista: sai de `a` por um trecho com ciclofaixa e segue pelas ciclofaixas (de preferência em frente) até elas
   * acabarem ou BIKE_LEGS trechos. Rota sem roteador: um passeio que cabe na lista de nós da pessoa.
   */
  private spawnBike(a: number): boolean {
    const net = this.sim.net, sc = net.segs.cols, nc = net.nodes.cols;
    const segs = net.segsOf(a, []).filter((s) => !Number.isNaN(bikeU(sc.profile[s], 1)));
    if (!segs.length) return false;
    const p = this.t.alloc();
    const c = this.t.cols;
    const r = p * ROUTE;
    let at = a, s = segs[this.rng.int(0, segs.length)], len = 0;
    this.routes[r + len++] = at;
    while (len < Math.min(ROUTE, BIKE_LEGS + 1)) {
      const next = sc.a[s] === at ? sc.b[s] : sc.a[s];
      this.routes[r + len++] = next;
      // saída mais reta com ciclofaixa (um pouco de sorteio para espalhar)
      const q = net.quad(s);
      const inx = sc.a[s] === next ? q.x0 - q.cx : q.x1 - q.cx, inz = sc.a[s] === next ? q.z0 - q.cz : q.z1 - q.cz;
      const il = Math.hypot(inx, inz) || 1;
      let best = -1, bestScore = -Infinity;
      for (const o of net.segsOf(next, [])) {
        if (o === s || Number.isNaN(bikeU(sc.profile[o], 1))) continue;
        const oq = net.quad(o);
        const ox = sc.a[o] === next ? oq.cx - oq.x0 : oq.cx - oq.x1, oz = sc.a[o] === next ? oq.cz - oq.z0 : oq.cz - oq.z1;
        const score = (inx * ox + inz * oz) / (il * (Math.hypot(ox, oz) || 1)) + this.rng.next() * 0.6;
        if (score > bestScore) { bestScore = score; best = o; }
      }
      if (best < 0) break;
      at = next; s = best;
    }
    if (len < 2 || !nc.deg[a]) { this.t.release(p); return false; }
    c.rLen[p] = len; c.rIdx[p] = 0; c.node[p] = -1; c.has[p] = 0;
    c.speed[p] = 4 + this.rng.next() * 1.6;
    c.color[p] = this.rng.int(0, 16);
    c.side[p] = 1;
    c.tLine[p] = -1; c.tFrom[p] = 0; c.tTo[p] = 0;
    c.bike[p] = 1; c.enter[p] = 0;
    if (!this.startSidewalk(p, this.rng.next())) { this.kill(p); return false; }
    return true;
  }

  /** Nasce em `a` e anda até um nó ao acaso a até `radius` metros. */
  private spawnFrom(a: number, radius: number, li: number, from: number, to: number, frac: number): void {
    const net = this.sim.net, nc = net.nodes.cols;
    if (!net.nodes.alive[a]) return;
    const cand: number[] = [];
    net.nodeIndex.query(nc.x[a] - radius, nc.z[a] - radius, nc.x[a] + radius, nc.z[a] + radius, (n) => { if (cand.length < 400) cand.push(n); });
    let b = -1;
    for (let i = 0; i < 8 && cand.length; i++) {
      const n = cand[this.rng.int(0, cand.length)];
      const d = Math.hypot(nc.x[n] - nc.x[a], nc.z[n] - nc.z[a]);
      if (n !== a && d > 150 && d < radius && nc.deg[n] > 0) { b = n; break; }
    }
    if (b < 0) return;
    this.spawnRoute(a, b, li, from, to, frac);
  }

  private spawnRoute(a: number, b: number, li: number, from: number, to: number, frac = 0): void {
    const p = this.t.alloc();
    const c = this.t.cols;
    const len = this.router.route(a, b, this.routes, p * ROUTE, ROUTE, true);
    if (len < 2 || this.routes[p * ROUTE + len - 1] !== b) { this.t.release(p); return; }
    c.rLen[p] = len; c.rIdx[p] = 0; c.node[p] = -1; c.has[p] = 0;
    c.speed[p] = 1.1 + this.rng.next() * 0.55;
    c.color[p] = this.nextColor >= 0 ? this.nextColor : this.rng.int(0, 16);
    c.side[p] = this.rng.next() < 0.5 ? 1 : -1;
    c.tLine[p] = li; c.tFrom[p] = from; c.tTo[p] = to;
    c.bike[p] = 0; c.enter[p] = 0;
    // `frac` > 0: começa no meio do primeiro trecho, para a cidade já nascer cheia
    if (!this.startSidewalk(p, frac)) { this.kill(p); return; }
  }

  private kill(p: number): void {
    this.unlink(p);
    this.t.cols.at[p] = -1;
    this.t.release(p);
  }

  // ------------------------------------------------------------ caminhada

  private segBetween(a: number, b: number): number {
    const net = this.sim.net, sc = net.segs.cols;
    const d = net.nodes.cols.deg[a];
    for (let k = 0; k < d; k++) {
      const s = net.adj[a * MAX_DEG + k];
      if (s >= 0 && ((sc.a[s] === a && sc.b[s] === b) || (sc.b[s] === a && sc.a[s] === b))) return s;
    }
    return -1;
  }

  /** u da calçada do lado pedido (ou do outro lado, se esse não tiver). */
  private sideU(profile: number, side: number): [number, number] {
    const s = PROFILE_INFO[profile];
    if (side > 0) return Number.isNaN(s.walkLeft) ? [s.walkRight, -1] : [s.walkLeft, 1];
    return Number.isNaN(s.walkRight) ? [s.walkLeft, 1] : [s.walkRight, -1];
  }

  /** Entra na calçada do trecho entre rota[rIdx] e rota[rIdx + 1]. `frac` > 0 começa no meio. */
  private startSidewalk(p: number, frac = 0): boolean {
    const c = this.t.cols, sim = this.sim, sc = sim.net.segs.cols;
    // quem saiu de uma porta entra no meio do trecho (onde a reta da porta chegou)
    if (frac === 0 && c.enter[p] > 0) { frac = c.enter[p]; c.enter[p] = 0; }
    const i = c.rIdx[p];
    if (i + 1 >= c.rLen[p]) return false;
    const n0 = this.routes[p * ROUTE + i], n1 = this.routes[p * ROUTE + i + 1];
    if (!sim.net.nodes.alive[n0] || !sim.net.nodes.alive[n1]) return false;
    const s = this.segBetween(n0, n1);
    if (s < 0 || (c.bike[p] ? Number.isNaN(bikeU(sc.profile[s], 1)) : !PROFILE_INFO[sc.profile[s]].walk)) return false;
    if (!c.bike[p]) {
      const [, side] = this.sideU(sc.profile[s], c.side[p]);
      c.side[p] = side;
    }
    const r0 = sim.segS0(s), r1 = sim.segS1(s);
    const fromA = sc.a[s] === n0;
    c.seg[p] = s;
    c.da[p] = fromA ? r0 : r1;
    c.db[p] = fromA ? r1 : r0;
    c.mode[p] = 0;
    const dur = Math.abs(c.db[p] - c.da[p]) / c.speed[p];
    c.dur[p] = Math.max(0.1, dur);
    c.t0[p] = this.time - frac * c.dur[p];
    this.unlink(p);
    this.link(p, n1);
    this.schedule(p, c.t0[p] + c.dur[p]);
    return true;
  }

  /** Chegou ao nó rota[rIdx + 1]: monta os pontos para contornar/atravessar até o próximo trecho. */
  private atNode(p: number): boolean {
    const c = this.t.cols, sim = this.sim, net = sim.net, sc = net.segs.cols;
    c.rIdx[p]++;
    const i = c.rIdx[p];
    if (i + 1 >= c.rLen[p]) {
      // chegou: quem ia pegar ônibus fica esperando na parada
      if (c.tLine[p] >= 0) this.onStop(c.tLine[p], c.tFrom[p], c.tTo[p]);
      return false;
    }
    const n = this.routes[p * ROUTE + i], nNext = this.routes[p * ROUTE + i + 1];
    const sIn = c.seg[p], sOut = this.segBetween(n, nNext);
    if (c.bike[p]) return this.bikeThrough(p, n, sIn, sOut);
    if (sOut < 0 || !net.segs.alive[sIn] || !PROFILE_INFO[sc.profile[sOut]].walk) return false;
    // ponto de partida = fim da calçada que acabou
    const here = this.posNow(p);
    this.lineFrom[p * 3] = here[0]; this.lineFrom[p * 3 + 1] = here[1]; this.lineFrom[p * 3 + 2] = here[2];
    c.pyaw[p] = here[3];
    c.mode[p] = 3;
    // braços do nó em ordem anti-horária (a mesma do trânsito e dos semáforos)
    const segs = net.segsOf(n, []);
    const deg = segs.length;
    const angle = segs.map((s) => { const a = armOf(net.quad(s), sc.profile[s], sc.a[s] === n ? 0 : 1); return armAngle(a.dx, a.dz); });
    const order = segs.map((_, k) => k).sort((x, y) => angle[x] - angle[y]);
    const rank = new Array<number>(deg);
    order.forEach((k, r) => { rank[k] = r; });
    const ai = rank[segs.indexOf(sIn)], aj = rank[segs.indexOf(sOut)];
    const endIn = sc.a[sIn] === n ? 0 : 1;
    const armLeftIn = endIn === 0 ? c.side[p] > 0 : c.side[p] < 0;
    const ci = armLeftIn ? ai : (ai - 1 + deg) % deg;
    // esquina de destino: à esquerda (aj) ou à direita (aj − 1) do braço de saída; menos travessias
    const opts = [aj, (aj - 1 + deg) % deg].map((cj) => {
      const ccw = (cj - ci + deg) % deg, cw = (ci - cj + deg) % deg;
      return { cj, steps: Math.min(ccw, cw), dir: ccw <= cw ? 1 : -1 };
    });
    // empate: sorteio fixo por pessoa (metade atravessa antes, metade depois); na faixa do meio da quadra, metade atravessa
    const mid = deg === 2 && (sim.nodeCtl[n] === 9 || sim.nodeCtl[n] === 10);
    const want = mid && ((p + n) & 1) === 0;
    const pick = mid ? (opts.find((o) => (o.steps > 0) === want) ?? opts[0]) : opts[0].steps < opts[1].steps || (opts[0].steps === opts[1].steps && (p & 1) === 0) ? opts[0] : opts[1];
    let w = 0;
    const base = p * WAYS * 4;
    const put = (x: number, y: number, z: number, cross: number) => {
      if (w >= WAYS) return;
      const o = base + w * 4;
      this.ways[o] = x; this.ways[o + 1] = y; this.ways[o + 2] = z; this.ways[o + 3] = cross;
      w++;
    };
    const tmp = new Float64Array(3);
    let cur = ci;
    for (let k = 0; k < pick.steps && w + 2 < WAYS; k++) {
      // anti-horário: atravessa o braço cur+1 da direita para a esquerda; horário: o braço cur, da esquerda para a direita
      const arm = pick.dir > 0 ? (cur + 1) % deg : cur;
      const s = segs[order[arm]];
      const end = sc.a[s] === n ? 0 : 1;
      const d = (end === 0 ? sim.segS0(s) : sim.segLen(s) - sim.segS1(s)) + CROSS_AT;
      const fromLeft = pick.dir < 0;
      this.armPoint(s, end, d, fromLeft, tmp, false); put(tmp[0], tmp[1], tmp[2], 0);
      this.armPoint(s, end, d, !fromLeft, tmp, false); put(tmp[0], tmp[1], tmp[2], arm + 1);
      cur = pick.dir > 0 ? (cur + 1) % deg : (cur - 1 + deg) % deg;
    }
    // ponta da calçada de saída, no lado da esquina final
    const endOut = sc.a[sOut] === n ? 0 : 1;
    const armLeftOut = pick.cj === aj;
    const dOut = endOut === 0 ? sim.segS0(sOut) : sim.segLen(sOut) - sim.segS1(sOut);
    this.armPoint(sOut, endOut, dOut, armLeftOut, tmp, true);
    put(tmp[0], tmp[1], tmp[2], 0);
    c.side[p] = endOut === 0 ? (armLeftOut ? 1 : -1) : (armLeftOut ? -1 : 1);
    this.wayNode[p] = n;
    c.wIdx[p] = 0; c.wLen[p] = w;
    c.seg[p] = sOut;
    this.unlink(p);
    this.link(p, n);
    return this.nextWay(p);
  }

  /** Ciclista no nó: uma reta do fim da ciclofaixa que chega ao começo da que sai (pelo cruzamento, como um carro). */
  private bikeThrough(p: number, n: number, sIn: number, sOut: number): boolean {
    const c = this.t.cols, sim = this.sim, net = sim.net, sc = net.segs.cols;
    if (sOut < 0 || !net.segs.alive[sIn] || Number.isNaN(bikeU(sc.profile[sOut], 1))) return false;
    const here = this.posNow(p);
    this.lineFrom[p * 3] = here[0]; this.lineFrom[p * 3 + 1] = here[1]; this.lineFrom[p * 3 + 2] = here[2];
    c.pyaw[p] = here[3];
    const fromA = sc.a[sOut] === n, d = fromA ? sim.segS0(sOut) : sim.segS1(sOut);
    const dir = fromA ? 1 : -1;
    const t = sim.tAt(sOut, d), q = net.quad(sOut);
    bez(q, t, p2); bezD(q, t, d2);
    const l = Math.hypot(d2[0], d2[1]) || 1, dx = d2[0] / l, dz = d2[1] / l, u = bikeU(sc.profile[sOut], dir);
    const nc = net.nodes.cols, ya = nc.y[sc.a[sOut]], yb = nc.y[sc.b[sOut]], L = sim.segLen(sOut);
    const o = p * WAYS * 4;
    this.ways[o] = p2[0] + dz * u; this.ways[o + 2] = p2[1] - dx * u;
    this.ways[o + 1] = ya + (yb - ya) * (d / Math.max(1e-6, L)) + 0.02;
    this.ways[o + 3] = 0;
    this.wayNode[p] = n;
    c.wIdx[p] = 0; c.wLen[p] = 1;
    c.seg[p] = sOut;
    this.unlink(p);
    this.link(p, n);
    return this.nextWay(p);
  }

  /** Ponto na calçada (ou faixa de pedestre) de um braço, a d metros do nó, no lado esquerdo/direito do braço. */
  private armPoint(s: number, end: 0 | 1, d: number, armLeft: boolean, out: Float64Array, sidewalk: boolean): void {
    const sim = this.sim, net = sim.net, sc = net.segs.cols, nc = net.nodes.cols;
    const L = sim.segLen(s);
    const fromA = end === 0 ? d : L - d;
    // esquerda do braço em coordenadas do trecho (u+ = esquerda de a→b)
    const segLeft = end === 0 ? armLeft : !armLeft;
    const [u] = this.sideU(sc.profile[s], segLeft ? 1 : -1);
    const t = sim.tAt(s, Math.max(0, Math.min(L, fromA)));
    bez(net.quad(s), t, p2); bezD(net.quad(s), t, d2);
    const l = Math.hypot(d2[0], d2[1]) || 1;
    const dx = d2[0] / l, dz = d2[1] / l;
    out[0] = p2[0] + dz * u;
    out[2] = p2[1] - dx * u;
    const ya = nc.y[sc.a[s]], yb = nc.y[sc.b[s]];
    out[1] = ya + (yb - ya) * (fromA / Math.max(1e-6, L)) + (sidewalk ? CURB : 0.02);
  }

  /** Próximo ponto de passagem (ou a calçada, quando acabam). */
  private nextWay(p: number): boolean {
    const c = this.t.cols;
    if (c.wIdx[p] >= c.wLen[p]) return this.startSidewalk(p);
    const o = p * WAYS * 4 + c.wIdx[p] * 4;
    const cross = this.ways[o + 3];
    // travessia com semáforo: espera os carros daquele braço pararem (só perto da câmera)
    if (cross > 0 && this.carsGo(this.wayNode[p], cross - 1)) {
      c.mode[p] = 2;
      c.t0[p] = this.time; c.dur[p] = 1;
      this.schedule(p, this.time + 1);
      return true;
    }
    const [x0, y0, z0, yaw0] = this.posNow(p);
    c.pyaw[p] = yaw0;
    const len = Math.hypot(this.ways[o] - x0, this.ways[o + 2] - z0);
    c.mode[p] = 1;
    c.t0[p] = this.time;
    c.dur[p] = Math.max(0.05, len / c.speed[p]);
    // o ponto de partida fica guardado em px/py/pz da reta
    this.lineFrom[p * 3] = x0; this.lineFrom[p * 3 + 1] = y0; this.lineFrom[p * 3 + 2] = z0;
    c.wIdx[p]++;
    this.schedule(p, this.time + c.dur[p]);
    return true;
  }


  /** Posição agora (x, y, z, rumo). Modos: 0 calçada, 1 reta, 2 esperando num ponto, 3 parado no ponto de partida. */
  private posNow(p: number, time = this.time): number[] {
    const c = this.t.cols, sim = this.sim, out = this.pos3;
    out[3] = c.pyaw[p];
    if (c.mode[p] === 3) {
      out[0] = this.lineFrom[p * 3]; out[1] = this.lineFrom[p * 3 + 1]; out[2] = this.lineFrom[p * 3 + 2];
      return out;
    }
    const f = Math.max(0, Math.min(1, (time - c.t0[p]) / c.dur[p]));
    if (c.mode[p] === 0) {
      const s = c.seg[p];
      const d = c.da[p] + (c.db[p] - c.da[p]) * f;
      const net = sim.net, sc = net.segs.cols, nc = net.nodes.cols;
      const q = net.quad(s);
      const L = sim.segLen(s);
      const t = sim.tAt(s, Math.max(0, Math.min(L, d)));
      bez(q, t, p2); bezD(q, t, d2);
      const l = Math.hypot(d2[0], d2[1]) || 1;
      const dx = d2[0] / l, dz = d2[1] / l;
      const dir = c.db[p] >= c.da[p] ? 1 : -1;
      // ciclista: no meio da ciclofaixa da sua mão; pedestre: cada um num "trilho" um pouco diferente da calçada
      const uu = c.bike[p] ? bikeU(sc.profile[s], dir) : this.sideU(sc.profile[s], c.side[p])[0] + ((p * 0.618) % 1 - 0.5) * 0.9;
      out[0] = p2[0] + dz * uu; out[2] = p2[1] - dx * uu;
      const ya = nc.y[sc.a[s]], yb = nc.y[sc.b[s]];
      out[1] = ya + (yb - ya) * (d / Math.max(1e-6, L)) + (c.bike[p] ? 0.02 : CURB);
      out[3] = Math.atan2(dx * dir, dz * dir);
      return out;
    }
    // reta (ou parado, esperando no último ponto)
    const k = c.mode[p] === 2 ? Math.max(0, c.wIdx[p] - 1) : c.wIdx[p] - 1;
    const o = p * WAYS * 4 + Math.max(0, k) * 4;
    if (c.mode[p] === 2) {
      // parado no último ponto alcançado
      if (c.wIdx[p] > 0) { out[0] = this.ways[o]; out[1] = this.ways[o + 1]; out[2] = this.ways[o + 2]; }
      else { out[0] = this.lineFrom[p * 3]; out[1] = this.lineFrom[p * 3 + 1]; out[2] = this.lineFrom[p * 3 + 2]; }
      return out;
    }
    const ax = this.lineFrom[p * 3], ay = this.lineFrom[p * 3 + 1], az = this.lineFrom[p * 3 + 2];
    const bx = this.ways[o], by = this.ways[o + 1], bz = this.ways[o + 2];
    out[0] = ax + (bx - ax) * f; out[1] = ay + (by - ay) * f; out[2] = az + (bz - az) * f;
    if (Math.abs(bx - ax) + Math.abs(bz - az) > 1e-3) out[3] = Math.atan2(bx - ax, bz - az);
    return out;
  }

  /** Um evento: fim de trecho, fim de reta ou fim de espera. */
  private advance(p: number): void {
    const ok = this.t.cols.mode[p] === 0 ? this.atNode(p) : this.nextWay(p);
    if (!ok) this.kill(p);
  }

  // ------------------------------------------------------------ passo

  step(dt: number): void {
    this.time += dt;
    const target = Math.min(MAX_PEDS, Math.floor(this.sim.laneMeters * this.density * this.share));
    for (let k = 0; k < 40 && this.t.size < target; k++) this.spawn();
    const c = this.t.cols;
    let budget = 20000;
    while (this.heapN > 0 && this.heapT[0] <= this.time && budget-- > 0) {
      const p = this.heapP[0], at = this.heapT[0];
      this.popEvent();
      if (!this.t.alive[p] || c.at[p] !== at) continue; // evento velho
      if (c.mode[p] === 0 && !this.sim.net.segs.alive[c.seg[p]]) { this.kill(p); continue; }
      this.advance(p);
    }
  }

  /** A câmera andou: nós cuja lista entra na janela. */
  checkWindow(): void {
    this.windowNodes.length = 0;
    this.sim.net.nodeIndex.query(this.camX - WINDOW, this.camZ - WINDOW, this.camX + WINDOW, this.camZ + WINDOW, (n) => this.windowNodes.push(n));
  }

  /** Trechos removidos: quem estava neles some no próximo evento (checado em step). */

  /** Escreve as poses de quem está perto, a partir de `start`. Devolve quantos escreveu. */
  writePoses(data: Float32Array, stride: number, start: number, max: number): number {
    const c = this.t.cols;
    let n = 0;
    for (const node of this.windowNodes) {
      if (!this.sim.net.nodes.alive[node]) continue;
      for (let p = this.head[node]; p >= 0; p = c.next[p]) {
        if (start + n >= max) return n;
        if (c.mode[p] === 0 && !this.sim.net.segs.alive[c.seg[p]]) continue;
        const q = this.posNow(p);
        const o = (start + n) * stride;
        if (!c.has[p]) { c.px[p] = q[0]; c.py[p] = q[1]; c.pz[p] = q[2]; c.pyaw[p] = q[3]; c.has[p] = 1; }
        data[o] = c.px[p]; data[o + 1] = c.py[p]; data[o + 2] = c.pz[p]; data[o + 3] = c.pyaw[p];
        data[o + 4] = q[0]; data[o + 5] = q[1]; data[o + 6] = q[2]; data[o + 7] = q[3];
        data[o + 8] = (c.bike[p] ? 5 : 3) * 256 + c.color[p];
        data[o + 9] = 1;
        c.px[p] = q[0]; c.py[p] = q[1]; c.pz[p] = q[2]; c.pyaw[p] = q[3];
        n++;
      }
    }
    return n;
  }

  clear(): void {
    this.t.clear();
    this.head.fill(-1);
    this.heapN = 0;
  }
}

// Trânsito: meso no mapa inteiro (fila por faixa, eventos por veículo), micro
// numa janela em volta da câmera (IDM para seguir, MOBIL para trocar de faixa,
// semáforos por braço que se ajustam à fila, preferência nas rotatórias).
// Tudo em tabelas SoA; nenhum laço passa pela frota inteira por passo.

import { Table } from '../core/table.ts';
import { MAP_HALF, MAP_SIZE } from '../config.ts';
import { Rng } from '../core/rng.ts';
import { MAX_DEG } from '../roads/network.ts';
import { SegFlag } from '../roads/flags.ts';
import { Ctl, Rule } from '../roads/control.ts';
import { baseZone } from '../roads/zones.ts';
import { PROFILE_INFO } from '../roads/profiles.ts';
import { SimNet, Turn, laneCount, laneDir, laneId, laneIdx, laneSeg, laneSpeed } from './lanes.ts';
import { Router } from './routing.ts';
import { FlowAdvisor } from './advisor.ts';
import { bez, bezD } from '../roads/geometry.ts';
import { MANOEUVRE_RADIUS, MKind, Manoeuvres } from './manoeuvres.ts';

export const ROUTE_CAP = 96;
export const MAX_VEHICLES = 1 << 16;
const WINDOW = 1500;
// meso (longe da câmera) no ritmo do micro: a frota é uma só, então se o meso anda mais rápido os carros se
// juntam na janela até ela travar, e se anda mais devagar a janela esvazia (era o caso: meso a 6 km/h, micro a
// 20). O meso leva este fator vezes a conta de `mesoEnter` (andar livre pela lotação + espera do cruzamento).
// Conferido em scripts/transito.ts contra o mapa inteiro em micro (JANELA=1e6): os carros num raio de 1,5 km
// do centro andam junto com os da rodada toda micro (2,0 enche a janela, 4,0 esvazia)
const MESO_ALPHA = 2.5;
const WINDOW_OUT = 1750;
/** Parado há tanto tempo (s), o motorista reconsidera a rota (roadcraft STUCK_SECONDS). */
export const STUCK_SECONDS = 10;
/** Cruzamento travado: alguém esperando na linha e ninguém passou há tanto tempo (s). */
export const JAM_SECONDS = 20;
/** Esperando a mesma saída cheia há tanto tempo (s), o motorista guarda a vez nela. */
const STARVE_SECONDS = 30;
/** Liberação controlada de um cruzamento travado: um veículo a cada tanto (s). */
const RELEASE_EVERY = 3;
/** Buscas de rota por passo (desvios e reconsiderações): o resto tenta no passo seguinte. */
const ROUTE_BUDGET = 6;
/**
 * A frota não é fixa nem salta: abaixo do alvo ela cresce no ritmo das viagens novas, chegando ao alvo com esta
 * constante de tempo (s, ~ a duração de uma viagem). Sem isso o pico das 18 h (o relógio do jogo anda 1 h por
 * minuto) punha 50% de carros a mais na rede em dois minutos, e eles levavam 15 min para chegar: o centro
 * caía para 10 km/h depois de ~10 min de jogo. Abaixo de FILL_SHARE do alvo (mapa abrindo) enche de uma vez.
 */
const FLEET_TAU = 600, FILL_SHARE = 0.5;
/**
 * Lotação (fração da faixa cheia) das ruas em volta a partir da qual um nó perde peso como origem ou destino,
 * e quanto perde por unidade de lotação (zero com 35%). Medido: sem isso o centro acumulava carros e caía
 * de ~18 para ~14 km/h em 20 min.
 */
const CROWD_OCC = 0.15, CROWD_SLOPE = 5;
/**
 * Região engarrafada (blocos de 400 m, recalculados a cada 4 s pela lotação dos trechos): viagens que começam ou
 * terminam nela vão para outro lugar, como quem evita o centro no pico. Sem isso a frota (fixa) escorria para o centro
 * até travar: no pico, 845 → 1 423 carros a 700 m do centro em 20 min e 17,8 → 9,9 km/h.
 */
export const REGION = 400, REGION_OCC = 0.1, REGION_SLOPE = 7, REGION_EVERY = 4;
const REGION_N = Math.ceil(MAP_SIZE / REGION);
/**
 * Governador da frota (roadcraft `populationGovernor`, aqui pelo trânsito e não pelo custo do passo): a velocidade média
 * da janela micro (o que o jogador vê, parados incluídos) abaixo de GOV_SLOW corta o alvo da frota aos poucos, acima de
 * GOV_FAST devolve. Medido: a rede da cidade gerada não carrega a frota do pico (tudo em micro cai para 8,6 km/h e não
 * para de cair); com o governador o pico tem menos carros e anda.
 */
const GOV_SLOW = 15 / 3.6, GOV_FAST = 18 / 3.6, GOV_MIN = 0.75;
/** O desvio de quem reconsidera volta à rota até tantos nós adiante. */
const REJOIN = 6;

/**
 * IDM. Carro arranca a 2,8 m/s² (com 2,2 o centro ficava ~2 km/h mais lento, medido); ônibus, caminhão e
 * trem, pesados, a 2,2 (e param no ponto certo). 0,9 s de distância.
 */
const A_MAX = 2.8, A_HEAVY = 2.2, B_COMF = 2.2, S0 = 2.2, T_HEAD = 0.9;

const vehSchema = {
  lane: Int32Array, conn: Int32Array, s: Float32Array, v: Float32Array,
  len: Float32Array, vf: Float32Array, micro: Uint8Array, kind: Uint8Array, color: Uint8Array,
  dest: Int32Array, rIdx: Uint8Array, rLen: Uint8Array,
  tExit: Float64Array,
  next: Int32Array, prev: Int32Array, // lista da faixa/conexão (micro), da frente para trás
  px: Float32Array, py: Float32Array, pz: Float32Array, pyaw: Float32Array, has: Uint8Array,
  fade: Float32Array, dying: Uint8Array,
  lcFrom: Int32Array, lcT: Float32Array, lcCool: Float32Array,
  microIdx: Int32Array,
  // ônibus: linha (-1 = carro comum), próxima parada, tempo parado, lotação, já atendeu a parada
  line: Int16Array, stopI: Uint8Array, dwell: Float32Array, load: Uint8Array, served: Uint8Array,
  // tempo parado na linha de retenção (placa de pare, fila de quem dá a preferência)
  wait: Float32Array,
  // parado (em qualquer ponto da faixa) desde a última vez que reconsiderou a rota
  held: Float32Array,
  // luzes (roadcraft vehicleSignals): freando/parado, e a conexão de saída planejada (para a seta)
  brk: Uint8Array, exitC: Int32Array,
  // na vaga ao lado da faixa (0 = na faixa, 1 = na vaga): entrando nela ao chegar ou saindo dela ao começar
  pk: Float32Array,
  // manoeuvre (sim/manoeuvres.ts, −1 = none) and the lane position (front) where it ends
  mv: Int32Array, ms: Float32Array,
};

/** Linha de ônibus como a simulação a vê: paradas resolvidas em faixas. */
interface SimLine {
  id: number; color: number; buses: number;
  /** 0 ônibus, 1 trem, 2 metrô (trilhos). */
  mode: number;
  stopLane: number[]; stopV: number[]; waiting: number[]; lastT: number[];
  /** Quem espera em cada parada, por parada de destino (gente de verdade e demanda de fundo). */
  waitTo: Float64Array[];
  /** Ponto da parada na calçada (para desenhar quem espera). */
  stopX: number[]; stopZ: number[]; stopY: number[]; stopYaw: number[];
  /** Embarques desde o último relatório, e a média por hora. */
  boardings: number; perHour: number;
  /** Paradas terminais (índice resolvido): espera longa. */
  term: Set<number>;
}

/** Linha recebida da página: paradas como pontos (x, z) na calçada. */
export interface LineSpec { id: number; color: number; buses: number; stops: number[]; mode?: number; /** índices das paradas que são terminais */ term?: number[] }

const DWELL = 14;
/** Espera no terminal (s): o ônibus descansa e acerta o horário antes de voltar. */
const TERMINAL_DWELL = 75;
const BUS_CAP = 70;
const WAIT_RATE = 1 / 9; // pessoas chegando por segundo em cada parada

/** Comprimento por tipo: carro, ônibus, caminhão, (pessoa), trem (3 vagões de 20 m). */
const KIND_LEN = [4.4, 12, 9.5, 0.6, 62];
/** Estacionando (roadcraft kerbStops/parking): freada, encostar na vaga (s) e quanto tempo fica parado antes de sumir. */
const PARK_DECEL = 2.6, PARK_SIDE_S = 2.4, PARK_STAY = 3;

/** u do meio da faixa de estacionamento à direita de quem anda no sentido `dir` do trecho (NaN = sem vaga). */
function parkU(profile: number, dir: number): number {
  for (const e of PROFILE_INFO[profile].edges) {
    if (e.strip.kind !== 'parking') continue;
    const u = (e.u0 + e.u1) / 2;
    if ((dir > 0 && u < 0) || (dir < 0 && u > 0)) return u;
  }
  return NaN;
}

/** Desgaste por veículo que entra numa faixa: uma via de 1 000 veículos por hora fica bem gasta em ~1 h de simulação a 1×. */
const WEAR_PER_PASS = 0.2;
/**
 * Carros de passeio (roadcraft archetypes): sedã, hatch, SUV, van, picape e moto, com o comprimento de cada um
 * e a fatia da frota. O estilo vai nos bits 4-6 da cor (a página escolhe o modelo por ele).
 */
export const CAR_STYLE_LEN = [4.4, 3.9, 4.6, 4.9, 5.3, 2.1];
const CAR_STYLE_SHARE = [0.3, 0.3, 0.17, 0.08, 0.07, 0.08];
/** Bits das luzes na pose (× 65536 no campo tipo/cor): freio, seta esquerda, seta direita. */
export const LIGHT_BRAKE = 1, LIGHT_LEFT = 2, LIGHT_RIGHT = 4;
/** Vagões do trem e o comprimento de cada um. */
export const WAGONS = 3, WAGON_LEN = 20.5;

export class Traffic {
  readonly sim: SimNet;
  readonly router: Router;
  readonly veh = new Table(vehSchema, 1 << 12);
  routes = new Int32Array((1 << 12) * ROUTE_CAP);
  /** Lista ordenada de veículos micro por faixa e por conexão (cabeça = o da frente). */
  laneHead = new Int32Array((1 << 14) * 16).fill(-1);
  laneTail = new Int32Array((1 << 14) * 16).fill(-1);
  connHead = new Int32Array(1 << 14).fill(-1);
  /** Quem espera demais numa preferência reclama a vez (décimos de segundo do relógio da simulação). */
  private connClaim = new Int32Array(1 << 14).fill(-100);
  connTail = new Int32Array(1 << 14).fill(-1);
  /** Todos os veículos (micro e meso) por faixa, e a última saída meso (fila FIFO). */
  laneCount = new Uint16Array((1 << 14) * 16);
  laneLastExit = new Float64Array((1 << 14) * 16);
  /**
   * Vez na faixa de saída cheia: quem espera há STARVE_SECONDS por ela guarda a próxima vaga (renovada a cada
   * passo); sem isso um braço via a saída encher sempre com quem vinha dos outros e esperava minutos.
   */
  private exitClaim = new Int32Array((1 << 14) * 16).fill(-1);
  private exitClaimT = new Float64Array((1 << 14) * 16);
  /** Veículos por trecho e sentido (a rota evita o que está cheio). */
  segLoad = new Uint16Array((1 << 14) * 2);
  /** Desgaste acumulado por trecho (passagens × peso; 255 = gasto). */
  segWear = new Float32Array(1 << 14);
  /** Ocupação por trecho e sentido, para os "carros de densidade" do shader. */
  occupancy: Uint8Array | null = null;
  /** Estado dos semáforos por nó, para o desenho: 0 = fora da janela; senão 1 + braço * 4 + estado (0 verde, 1 amarelo, 2 vermelho). */
  signals: Uint8Array | null = null;
  /** Veículos micro, densos (para publicar e iterar). */
  micro = new Int32Array(1 << 12);
  microN = 0;
  /** Faixas e conexões com veículos micro. */
  private activeLanes = new Set<number>();
  private activeConns = new Set<number>();
  /** Eventos meso: heap (tempo, veículo). */
  private evT = new Float64Array(1 << 12);
  private evV = new Int32Array(1 << 12);
  private evN = 0;
  // semáforos
  sigPhase = new Uint8Array(1 << 14);
  sigTimer = new Float32Array(1 << 14);
  sigGreen = new Float32Array(1 << 14);
  sigState = new Uint8Array(1 << 14); // 0 verde, 1 amarelo, 2 vermelho geral
  private signalNodes = new Set<number>();
  /** Semáforos perto da câmera (só eles andam; os de longe ficam parados). */
  private windowSignals = new Set<number>();

  /** Velocidade média dos carros perto da câmera (m/s). */
  avgSpeed(): number {
    const c = this.veh.cols;
    let s = 0, stopped = 0;
    for (let i = 0; i < this.microN; i++) { const v = c.v[this.micro[i]]; s += v; if (v < 0.5) stopped++; }
    this.stopped = stopped;
    return this.microN ? s / this.microN : 0;
  }

  /** Parados perto da câmera (contado junto com a velocidade média). */
  stopped = 0;

  /** Um trecho agora: veículos (micro e meso), velocidade média dos que se vê, fila (parados) e capacidade. */
  probe(seg: number): { vehicles: number; speed: number; queue: number; capacity: number } {
    const sim = this.sim, c = this.veh.cols;
    if (!sim.net.segs.alive[seg]) return { vehicles: 0, speed: 0, queue: 0, capacity: 0 };
    const p = sim.net.segs.cols.profile[seg];
    let vehicles = 0, seen = 0, sum = 0, queue = 0, capacity = 0;
    for (const dir of [1, -1]) for (let i = 0; i < laneCount(p, dir); i++) {
      const l = laneId(seg, dir, i);
      vehicles += this.laneCount[l];
      capacity += Math.floor(sim.laneLen(l) / 7.5);
      for (let v = this.laneHead[l]; v >= 0; v = c.next[v]) { seen++; sum += c.v[v]; if (c.v[v] < 0.5) queue++; }
    }
    return { vehicles, speed: seen ? sum / seen : laneSpeed(p) * 0.85, queue, capacity };
  }

  /** Rede apagada (mapa novo, carregar): todos os veículos saem, filas e semáforos zeram. */
  clearAll(): void {
    this.veh.clear();
    this.laneHead.fill(-1); this.laneTail.fill(-1); this.connHead.fill(-1); this.connTail.fill(-1); this.connClaim.fill(-100);
    this.laneCount.fill(0); this.laneLastExit.fill(0); this.segLoad.fill(0);
    this.lastAdmit.fill(this.time); this.releaseAt.fill(0); this.jamAt.fill(0); this.exitClaim.fill(-1);
    this.microN = 0; this.evN = 0;
    this.activeLanes.clear(); this.activeConns.clear();
    this.signalNodes.clear();
    if (this.signals) for (const n of this.windowSignals) if (n < this.signals.length) this.signals[n] = 0;
    this.windowSignals.clear();
    for (const set of this.busSets) set.clear();
    this.riders.clear();
    this.wagonPrev.clear();
    if (this.occupancy) this.occupancy.fill(0);
    this.segWear.fill(0);
    this.parkers.clear();
    this.mvs.clear();
  }

  /** Trecho novo (o id pode ser de um demolido): asfalto novo. */
  clearWear(seg: number): void {
    if (seg < this.segWear.length) this.segWear[seg] = 0;
    if (this.occupancy && seg * 4 + 2 < this.occupancy.length) this.occupancy[seg * 4 + 2] = 0;
  }

  /** Linhas de ônibus (índice = posição; o veículo guarda o índice). */
  lines: SimLine[] = [];
  /** Ônibus de cada linha (para não varrer a frota). */
  private busSets: Array<Set<number>> = [];
  /** Passageiros de cada ônibus por parada de destino. */
  private riders = new Map<number, Float64Array>();
  /** Gente desce do ônibus no nó `node` (os pedestres continuam a pé). */
  onAlight: (node: number, count: number) => void = () => {};
  private lineCheck = 0;

  /** Alguém atravessando na faixa do nó? (dos pedestres) */
  pedCrossing: (n: number) => boolean = () => false;

  /** Veículos que passaram por cada nó (micro e meso), para o fluxo do cruzamento. */
  nodePass = new Uint32Array(1 << 14);
  /** Última passagem normal por nó (sem liberação), para achar cruzamento travado; e a próxima liberação. */
  private lastAdmit = new Float64Array(1 << 14);
  private releaseAt = new Float64Array(1 << 14);
  private jamAt = new Float64Array(1 << 14);
  /** Controle automático pelo fluxo medido. */
  readonly advisor: FlowAdvisor;
  /** Viagens evitam começar ou terminar em rua engarrafada. */
  crowdAvoid = true;
  /** Contagens: rotas reconsideradas, cruzamentos que travaram, veículos liberados. */
  reroutes = 0; jams = 0; released = 0;
  /** Meso: tentativas de passar ao fim da faixa e quantas acharam a próxima cheia (congestionamento longe da câmera). */
  mesoTries = 0; mesoFull = 0;
  private routeBudget = 0;

  /** Explosão: veículos da janela micro a até `r` metros saem de cena (devolve quantos). */
  blast(x: number, z: number, r: number): number {
    const c = this.veh.cols;
    let n = 0;
    for (let i = this.microN - 1; i >= 0; i--) {
      const v = this.micro[i];
      if (!c.has[v] || Math.hypot(c.px[v] - x, c.pz[v] - z) > r) continue;
      // estacionando: já está fora da faixa, só apaga (o `stepParkers` termina)
      if (c.dying[v] !== 2) c.dying[v] = 1;
      c.fade[v] = Math.min(c.fade[v], 0.3); n++;
    }
    return n;
  }

  /** Contagens para depuração e testes. */
  arrived = 0; lost = 0;
  camX = 0; camZ = 0;
  /** Raio da janela micro (m). Os diagnósticos põem o mapa inteiro em micro para medir o meso. */
  window = WINDOW;
  time = 0;
  private rng = new Rng(12345);
  private tmp = new Float64Array(4);
  private tmp2 = new Float64Array(4);
  /** Densidade alvo (veículos por metro de faixa). */
  density = 1 / 100;

  constructor(sim: SimNet) {
    this.sim = sim;
    this.router = new Router(sim);
    this.router.segLoad = this.segLoad;
    this.advisor = new FlowAdvisor(sim);
    sim.onNodeReset = (n) => { this.advisor.reset(n); };
    this.veh.onGrow((cap) => {
      const r = new Int32Array(cap * ROUTE_CAP); r.set(this.routes); this.routes = r;
      const m = new Int32Array(cap); m.set(this.micro); this.micro = m;
    });
    sim.net.segs.onGrow((cap) => {
      this.laneHead = grow(this.laneHead, cap * 16, -1);
      this.laneTail = grow(this.laneTail, cap * 16, -1);
      this.laneCount = grow(this.laneCount, cap * 16, 0);
      this.laneLastExit = grow(this.laneLastExit, cap * 16, 0);
      this.exitClaim = grow(this.exitClaim, cap * 16, -1);
      this.exitClaimT = grow(this.exitClaimT, cap * 16, 0);
      this.segLoad = grow(this.segLoad, cap * 2, 0);
      this.segWear = grow(this.segWear, cap, 0);
      this.router.segLoad = this.segLoad;
    });
    sim.conns.onGrow((cap) => {
      this.connHead = grow(this.connHead, cap, -1);
      this.connTail = grow(this.connTail, cap, -1);
      this.connClaim = grow(this.connClaim, cap, -100);
    });
    sim.net.nodes.onGrow((cap) => {
      this.sigPhase = grow(this.sigPhase, cap, 0);
      this.sigTimer = grow(this.sigTimer, cap, 0);
      this.sigGreen = grow(this.sigGreen, cap, 0);
      this.sigState = grow(this.sigState, cap, 0);
      this.nodePass = grow(this.nodePass, cap, 0);
      this.lastAdmit = grow(this.lastAdmit, cap, 0);
      this.releaseAt = grow(this.releaseAt, cap, 0);
      this.jamAt = grow(this.jamAt, cap, 0);
    });
  }

  get count(): number { return this.veh.size; }

  // ------------------------------------------------------------ listas

  /** Insere v na lista (faixa ou conexão) mantendo a ordem por s (da frente para trás). */
  private insert(v: number, onConn: boolean, id: number): void {
    const c = this.veh.cols;
    const head = onConn ? this.connHead : this.laneHead;
    const tail = onConn ? this.connTail : this.laneTail;
    // procura de trás para frente (quase sempre entra no fim)
    let after = tail[id];
    while (after >= 0 && c.s[after] < c.s[v]) after = c.prev[after];
    const before = after >= 0 ? c.next[after] : head[id];
    c.prev[v] = after; c.next[v] = before;
    if (after >= 0) c.next[after] = v; else head[id] = v;
    if (before >= 0) c.prev[before] = v; else tail[id] = v;
    (onConn ? this.activeConns : this.activeLanes).add(id);
  }

  /** Carros encostando na vaga (fora das listas das faixas: quem vem atrás passa). */
  private parkers = new Set<number>();
  /** Manoeuvres near the camera (Reeds-Shepp): into the bay, out of it, a truck backing into a dock. */
  readonly mvs = new Manoeuvres();
  /** Loading docks near the camera from the page: (x, z, yaw facing the street) per warehouse; their nearest nodes. */
  docks: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private dockNodes: number[] = [];
  /** A passenger gets out at (x, z) on the kerb (the worker makes a pedestrian there). */
  onDropOff: (x: number, z: number) => void = () => {};
  /** Counters for the measurements: kerb drop-offs, trucks at docks. */
  kerbStops = 0;
  docked = 0;
  private mvA = new Float64Array(4);
  private mvB = new Float64Array(4);

  /** The manoeuvres going on, for the page (inspection, photos): [x, z, kind, share done] each, and the counters. */
  manoeuvreList(): { list: number[]; planned: number; kerbStops: number; docked: number } {
    const t = this.mvs.t, mc = t.cols, list: number[] = [], p = this.mvA;
    for (let m = 0; m < t.end; m++) {
      if (!t.alive[m]) continue;
      this.mvs.pose(m, p);
      list.push(p[0], p[1], mc.kind[m], mc.d[m] / Math.max(1e-3, mc.total[m]));
    }
    // cars at the kerb (kind 4 here: the page tells them apart)
    const c = this.veh.cols;
    for (let i = 0; i < this.microN; i++) {
      const v = this.micro[i];
      if (c.dying[v] !== 4 || c.lane[v] < 0) continue;
      this.sim.lanePoint(c.lane[v], c.s[v], p);
      list.push(p[0], p[2], 4, Math.min(1, c.dwell[v] / 6));
    }
    return { list, planned: this.mvs.planned, kerbStops: this.kerbStops, docked: this.docked };
  }

  /** Docks sent by the page; each gets the node trucks drive to. */
  setDocks(pts: Float32Array): void {
    this.docks = pts;
    const nodes = new Set<number>();
    for (let k = 0; k + 2 < pts.length; k += 3) { const n = this.sim.net.nearestNode(pts[k], pts[k + 1], 80); if (n >= 0) nodes.add(n); }
    this.dockNodes = [...nodes];
  }

  private nearCam(lane: number): boolean {
    const sc = this.sim.net.segs.cols, sg = laneSeg(lane);
    return Math.hypot(sc.mx[sg] - this.camX, sc.mz[sg] - this.camZ) <= MANOEUVRE_RADIUS;
  }

  /** Centre pose of a vehicle whose front is at s on the lane, moved du metres to the driver's left: [x, y, z, yaw]. */
  private centrePose(lane: number, s: number, len: number, du: number, out: Float64Array): void {
    const sim = this.sim;
    sim.lanePoint(lane, Math.max(0, Math.min(sim.laneLen(lane), s)), out);
    const yaw = out[3];
    out[0] += Math.cos(yaw) * du - Math.sin(yaw) * len / 2;
    out[2] += -Math.sin(yaw) * du - Math.cos(yaw) * len / 2;
  }

  /**
   * Arrived near the end of its trip: a truck backs into a warehouse dock, some cars stop at the kerb to drop a
   * passenger, the others drive into a bay beside the kerb (Reeds-Shepp, near the camera) or, farther away, slide
   * into it. 0 = keep driving, 1 = handled, 2 = it goes away.
   */
  private arrive(v: number, lane: number, toEnd: number): number {
    const c = this.veh.cols;
    if (c.micro[v] && this.nearCam(lane)) {
      if (c.kind[v] === 2 && this.tryDock(v, lane)) return 1;
      if (c.kind[v] === 0 && this.tryKerbStop(v, lane)) return 1;
      if (c.kind[v] === 0 && this.tryParkManoeuvre(v, lane)) return 1;
    }
    if (toEnd >= 12) return 0;
    return this.startParking(v, lane) ? 1 : 2;
  }

  /** Bay beside the right lane: drive into it along a Reeds-Shepp path; those behind wait while it is in the lane. */
  private tryParkManoeuvre(v: number, lane: number): boolean {
    const c = this.veh.cols, sim = this.sim;
    if (laneIdx(lane) !== 0) return false;
    const pu = parkU(sim.net.segs.cols.profile[laneSeg(lane)], laneDir(lane));
    if (Number.isNaN(pu)) return false;
    const len = c.len[v], bayFront = c.s[v] + len + 3;
    if (bayFront > sim.laneLen(lane) - 4) return false;
    const du = (pu - sim.laneU(lane)) * laneDir(lane);
    const a = this.mvA, b = this.mvB;
    this.centrePose(lane, c.s[v], len, 0, a);
    this.centrePose(lane, bayFront, len, du, b);
    const m = this.mvs.start(v, MKind.Park, a[0], a[2], a[3], b[0], b[2], b[3], a[1], 5, 12);
    if (m < 0) return false;
    c.mv[v] = m; c.ms[v] = bayFront; c.dying[v] = 3; c.dwell[v] = 0; c.pk[v] = 0;
    return true;
  }

  /** Truck: the nearest dock within 70 m, backed into with the rear at the dock, facing the street. */
  private tryDock(v: number, lane: number): boolean {
    const c = this.veh.cols, d = this.docks, len = c.len[v];
    if (!d.length) return false;
    const a = this.mvA;
    this.centrePose(lane, c.s[v], len, 0, a);
    let best = -1, bd = 70;
    for (let k = 0; k + 2 < d.length; k += 3) { const dist = Math.hypot(d[k] - a[0], d[k + 1] - a[2]); if (dist < bd) { bd = dist; best = k; } }
    if (best < 0) return false;
    const yaw = d[best + 2], bx = d[best] + Math.sin(yaw) * len / 2, bz = d[best + 1] + Math.cos(yaw) * len / 2;
    const m = this.mvs.start(v, MKind.Dock, a[0], a[2], a[3], bx, bz, yaw, a[1], 9, 45);
    if (m < 0) return false;
    c.mv[v] = m; c.ms[v] = -1; c.dying[v] = 3; c.dwell[v] = 0;
    this.docked++;
    return true;
  }

  /** Some cars (4 in 10, by their id) stop at the kerb with the hazard lights on, a passenger gets out, and they go on. */
  private tryKerbStop(v: number, lane: number): boolean {
    const c = this.veh.cols;
    if (laneIdx(lane) !== 0 || ((Math.imul(v, 2654435761) >>> 0) % 10) >= 4) return false;
    if (!PROFILE_INFO[this.sim.net.segs.cols.profile[laneSeg(lane)]].walk) return false;
    c.dying[v] = 4; c.dwell[v] = 0; c.served[v] = 0;
    this.kerbStops++;
    return true;
  }

  /** At the kerb: brake, edge to the kerb, let the passenger out, then pick a new trip and pull out. */
  private kerbStep(v: number, lane: number, dt: number): void {
    const c = this.veh.cols, sim = this.sim;
    const nv = Math.max(0, c.v[v] - 3 * dt);
    c.s[v] = Math.min(sim.laneLen(lane) - 0.3, c.s[v] + (c.v[v] + nv) * 0.5 * dt);
    c.v[v] = nv; c.brk[v] = 1;
    c.pk[v] = Math.min(1, c.pk[v] + dt / 2);
    if (nv > 0) return;
    c.dwell[v] += dt;
    if (c.dwell[v] > 1.5 && !c.served[v]) {
      c.served[v] = 1;
      const p = this.mvA;
      // the door side: the middle of the sidewalk on the right
      const info = PROFILE_INFO[sim.net.segs.cols.profile[laneSeg(lane)]], dir = laneDir(lane);
      const wu = dir > 0 ? info.walkRight : info.walkLeft;
      this.centrePose(lane, c.s[v], c.len[v], Number.isNaN(wu) ? -3 : (wu - sim.laneU(lane)) * dir, p);
      this.onDropOff(p[0], p[2]);
    }
    if (c.dwell[v] > 6) {
      const b = this.zonedNode(this.zoneWeights(false));
      c.dying[v] = 0; c.served[v] = 0; c.dwell[v] = 1.3; // the bay-leaving slide takes the car back to the lane
      if (b < 0) { c.dying[v] = 1; return; }
      c.dest[v] = b;
      this.replanFrom(v, sim.laneTo(lane));
    }
  }

  /** Moves the manoeuvres; a parking car or docking truck leaves the lane lists once it is out of the lane. */
  private stepManoeuvres(dt: number): void {
    const t = this.mvs.t, mc = t.cols, c = this.veh.cols, sim = this.sim, p = this.mvA, q = this.mvB;
    for (let m = 0; m < t.end; m++) {
      if (!t.alive[m]) continue;
      const v = mc.veh[m];
      if (!this.veh.alive[v] || c.mv[v] !== m) { this.mvs.end(m); continue; }
      const lane = c.lane[v];
      if (!c.micro[v] || lane < 0 || !sim.net.segs.alive[laneSeg(lane)]) {
        this.mvs.end(m); c.mv[v] = -1;
        if (c.dying[v] === 3) c.dying[v] = 1;
        continue;
      }
      const kind = mc.kind[m];
      const done = this.mvs.advance(m, dt);
      c.brk[v] = this.mvs.moving(m) ? 0 : 1;
      c.v[v] = 0;
      if (kind === MKind.Unpark) {
        if (done) { this.mvs.end(m); c.mv[v] = -1; c.s[v] = Math.min(sim.laneLen(lane) - 0.5, c.ms[v]); c.pk[v] = 0; c.dwell[v] = 9; }
        continue;
      }
      if (c.dying[v] !== 3) continue;
      this.mvs.pose(m, p);
      this.centrePose(lane, c.s[v], c.len[v], 0, q);
      const lat = Math.abs((p[0] - q[0]) * Math.cos(q[3]) - (p[1] - q[2]) * Math.sin(q[3]));
      if (done || lat > (kind === MKind.Dock ? 3.2 : 1.8)) {
        this.unlink(v);
        this.setLaneCount(lane, -1);
        c.dying[v] = 2; c.dwell[v] = 0;
        this.parkers.add(v);
      }
    }
  }

  /**
   * Chegou: se a faixa da direita tem vaga ao lado, o carro sai da fila (quem vem atrás passa), freia encostando
   * na vaga com a seta da direita, fica parado um pouco e some. Só desenho: ninguém mais o enxerga.
   */
  private startParking(v: number, lane: number): boolean {
    const c = this.veh.cols, sim = this.sim;
    if (c.kind[v] !== 0 || !c.micro[v] || laneIdx(lane) !== 0) return false;
    const pu = parkU(sim.net.segs.cols.profile[laneSeg(lane)], laneDir(lane));
    if (Number.isNaN(pu)) return false;
    this.unlink(v);
    this.setLaneCount(lane, -1);
    c.dying[v] = 2; c.dwell[v] = 0; c.pk[v] = 0;
    this.parkers.add(v);
    return true;
  }

  /** Quem está estacionando: freia, encosta, espera e some. */
  private stepParkers(dt: number): void {
    const c = this.veh.cols, sim = this.sim;
    for (const v of this.parkers) {
      const lane = c.lane[v];
      if (!this.veh.alive[v] || lane < 0 || !sim.net.segs.alive[laneSeg(lane)]) { this.parkers.delete(v); if (this.veh.alive[v]) this.despawn(v); continue; }
      // on a manoeuvre: it drives itself (stepManoeuvres); once at the end it stays (a truck at the dock longer), then goes
      if (c.mv[v] >= 0) {
        if (this.mvs.moving(c.mv[v]) || this.mvs.t.cols.d[c.mv[v]] < this.mvs.t.cols.total[c.mv[v]] - 1e-3) continue;
        c.dwell[v] += dt;
        if (c.dwell[v] > (c.kind[v] === 2 ? 25 : PARK_STAY + 2)) {
          c.fade[v] -= dt * 1.2;
          if (c.fade[v] <= 0) { this.parkers.delete(v); this.arrived++; this.despawn(v); }
        }
        continue;
      }
      const nv = Math.max(0, c.v[v] - PARK_DECEL * dt);
      c.s[v] = Math.min(sim.laneLen(lane) - 0.3, c.s[v] + (c.v[v] + nv) * 0.5 * dt);
      c.v[v] = nv;
      c.dwell[v] += dt;
      c.pk[v] = Math.min(1, c.dwell[v] / PARK_SIDE_S);
      c.brk[v] = 1;
      if (nv === 0 && c.dwell[v] > PARK_SIDE_S + PARK_STAY) {
        c.fade[v] -= dt * 1.2;
        if (c.fade[v] <= 0) { this.parkers.delete(v); this.arrived++; this.despawn(v); }
      }
    }
  }

  private unlink(v: number): void {
    const c = this.veh.cols;
    const onConn = c.conn[v] >= 0;
    const id = onConn ? c.conn[v] : c.lane[v];
    if (id < 0) return;
    const head = onConn ? this.connHead : this.laneHead;
    const tail = onConn ? this.connTail : this.laneTail;
    if (c.prev[v] >= 0) c.next[c.prev[v]] = c.next[v]; else head[id] = c.next[v];
    if (c.next[v] >= 0) c.prev[c.next[v]] = c.prev[v]; else tail[id] = c.prev[v];
    c.next[v] = c.prev[v] = -1;
    if (head[id] < 0) (onConn ? this.activeConns : this.activeLanes).delete(id);
  }

  private setLaneCount(lane: number, delta: number): void {
    const n = Math.max(0, this.laneCount[lane] + delta);
    const so = laneSeg(lane) * 2 + (laneDir(lane) > 0 ? 0 : 1);
    this.segLoad[so] = Math.max(0, this.segLoad[so] + n - this.laneCount[lane]);
    this.laneCount[lane] = n;
    const occ = this.occupancy;
    if (!occ) return;
    const seg = laneSeg(lane), dir = laneDir(lane);
    const p = this.sim.net.segs.cols.profile[seg];
    const lanes = laneCount(p, dir);
    let total = 0;
    for (let i = 0; i < lanes; i++) total += this.laneCount[laneId(seg, dir, i)];
    const L = this.sim.laneLen(lane) * Math.max(1, lanes);
    const o = seg * 4 + (dir > 0 ? 0 : 1);
    if (o < occ.length) occ[o] = Math.min(255, Math.round((total * 7.5 / L) * 255));
    // desgaste: cada veículo que entra na faixa gasta um pouco o trecho (micro e meso: o mapa inteiro)
    if (delta > 0 && seg * 4 + 2 < occ.length) {
      const w = (this.segWear[seg] += WEAR_PER_PASS);
      occ[seg * 4 + 2] = Math.min(255, w | 0);
    }
  }

  private addMicro(v: number): void {
    const c = this.veh.cols;
    if (c.micro[v]) return;
    c.micro[v] = 1;
    c.microIdx[v] = this.microN;
    this.micro[this.microN++] = v;
    c.has[v] = 0;
  }

  private removeMicro(v: number): void {
    const c = this.veh.cols;
    if (!c.micro[v]) return;
    c.micro[v] = 0;
    this.wagonPrev.delete(v);
    const i = c.microIdx[v], last = this.micro[--this.microN];
    this.micro[i] = last;
    c.microIdx[last] = i;
  }

  // ------------------------------------------------------------ eventos meso

  private schedule(v: number, t: number): void {
    this.veh.cols.tExit[v] = t;
    if (this.evN >= this.evT.length) {
      const a = new Float64Array(this.evT.length * 2); a.set(this.evT); this.evT = a;
      const b = new Int32Array(this.evV.length * 2); b.set(this.evV); this.evV = b;
    }
    let i = this.evN++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.evT[p] <= t) break;
      this.evT[i] = this.evT[p]; this.evV[i] = this.evV[p]; i = p;
    }
    this.evT[i] = t; this.evV[i] = v;
  }

  private popEvent(): number {
    const v = this.evV[0];
    const lt = this.evT[--this.evN], lv = this.evV[this.evN];
    let i = 0;
    for (;;) {
      let c = i * 2 + 1;
      if (c >= this.evN) break;
      if (c + 1 < this.evN && this.evT[c + 1] < this.evT[c]) c++;
      if (this.evT[c] >= lt) break;
      this.evT[i] = this.evT[c]; this.evV[i] = this.evV[c]; i = c;
    }
    this.evT[i] = lt; this.evV[i] = lv;
    return v;
  }

  // ------------------------------------------------------------ rotas

  private routeAt(v: number, k: number): number { return this.routes[v * ROUTE_CAP + k]; }

  /** Trecho entre o nó atual da rota e o seguinte (-1 se não houver). */
  private segBetween(a: number, b: number): number {
    const net = this.sim.net, sc = net.segs.cols;
    const o = a * MAX_DEG, d = net.nodes.cols.deg[a];
    for (let k = 0; k < d; k++) {
      const s = net.adj[o + k];
      if ((sc.a[s] === a && sc.b[s] === b) || (sc.b[s] === a && sc.a[s] === b)) return s;
    }
    return -1;
  }

  private plan(v: number, from: number, dest: number, allowBack = false): boolean {
    const c = this.veh.cols;
    const ban = c.lane[v] >= 0 && !allowBack ? laneSeg(c.lane[v]) : -1;
    let n = this.router.route(from, dest, this.routes, v * ROUTE_CAP, ROUTE_CAP, false, ban);
    if (n < 2 && ban >= 0) n = this.router.route(from, dest, this.routes, v * ROUTE_CAP, ROUTE_CAP); // beco: retorna
    c.rLen[v] = n;
    c.rIdx[v] = 1;
    c.dest[v] = dest;
    return n >= 2;
  }

  /** Trecho `k` passos depois do próximo na rota (−1 se a rota acaba antes). */
  private segAfter(v: number, k: number): number {
    const c = this.veh.cols, i = c.rIdx[v] + 1 + k;
    if (i >= c.rLen[v]) return -1;
    return this.segBetween(this.routeAt(v, i - 1), this.routeAt(v, i));
  }

  /** Faixa menos cheia do trecho/sentido que tem conexão para `after` (−1: qualquer); fora da de ônibus para carro. */
  private pickLane(seg: number, dir: number, after: number, bus: boolean, fallback: number): number {
    const sim = this.sim, n = laneCount(sim.net.segs.cols.profile[seg], dir);
    let best = fallback, bc = fallback >= 0 ? this.laneCount[fallback] : 1e9;
    for (let i = 0; i < n; i++) {
      const l = laneId(seg, dir, i);
      if (!bus && sim.isBusLane(l)) continue;
      if (after >= 0 && sim.connToward(l, after, bus) < 0) continue;
      if (this.laneCount[l] < bc) { bc = this.laneCount[l]; best = l; }
    }
    return best;
  }

  /** Próximo trecho da rota a partir do nó em que a faixa atual termina. */
  private nextSeg(v: number): number {
    const c = this.veh.cols;
    const k = c.rIdx[v];
    if (k + 1 >= c.rLen[v]) return -1;
    return this.segBetween(this.routeAt(v, k), this.routeAt(v, k + 1));
  }

  /** Replaneja com a faixa atual levando a `node` (rIdx = 0 aponta para ele). */
  private replanFrom(v: number, node: number, allowBack = false): void {
    const c = this.veh.cols;
    if (c.line[v] >= 0) { this.busPlan(v, node); return; }
    if (node === c.dest[v]) { this.routes[v * ROUTE_CAP] = node; c.rLen[v] = 1; c.rIdx[v] = 0; return; }
    if (!this.plan(v, node, c.dest[v], allowBack)) { c.dying[v] = 1; return; }
    c.rIdx[v] = 0;
  }

  private atDestination(v: number): boolean {
    const c = this.veh.cols;
    return c.rIdx[v] >= c.rLen[v] - 1 && this.routeAt(v, c.rIdx[v]) === c.dest[v];
  }

  // ------------------------------------------------------------ demanda

  private randomNode(): number {
    const t = this.sim.net.nodes;
    if (t.size === 0) return -1;
    for (let i = 0; i < 20; i++) {
      const n = this.rng.int(0, t.end);
      if (t.alive[n] && t.cols.deg[n] > 0) return n;
    }
    return -1;
  }

  /** Hora do dia (da página) e multiplicadores do jogador. */
  hour = 10;
  /** Demanda escolhida (0,6 baixa, 1 normal, 1,5 pico) e porcentagem do tráfego. */
  demand = 1;
  trafficShare = 1;

  /** Peso de cada zona (nenhuma, residencial, comercial, industrial, misto) para origem e destino na hora atual. */
  private zoneWeights(origin: boolean): number[] {
    const h = this.hour;
    const morning = h >= 6 && h < 10, evening = h >= 16 && h < 20;
    // de manhã sai de casa para o trabalho; à tarde volta; no meio do dia, comércio
    const home = [0.15, 1, 0.15, 0.1, 0.5], work = [0.1, 0.2, 1, 0.8, 0.6], mid = [0.15, 0.5, 0.8, 0.4, 0.8];
    if (morning) return origin ? home : work;
    if (evening) return origin ? work : home;
    return mid;
  }

  /** Viagens novas que ainda cabem neste passo além de repor quem chegou (FLEET_TAU). */
  private spawnCredit = 0;
  /** Tamanho da frota no fim do passo anterior (até o alvo): quem chegou é reposto sem gastar crédito. */
  private fleetFloor = 0;

  /** Quantos carros a hora pede (curva do dia, picos às 8 e às 18). */
  dayFactor(): number {
    const h = this.hour;
    const peak = (c: number, w: number) => Math.exp(-((h - c) * (h - c)) / (2 * w * w));
    return 0.3 + 0.55 * peak(8, 1.3) + 0.6 * peak(18, 1.5) + 0.35 * peak(13, 2.5) - 0.2 * (h < 5 || h > 23 ? 1 : 0);
  }

  /** Lotação de cada região (carros / vagas nas faixas) e quando foi medida. */
  regionOcc = new Float32Array(REGION_N * REGION_N);
  private regionLoad = new Float32Array(REGION_N * REGION_N);
  private regionCap = new Float32Array(REGION_N * REGION_N);
  private regionT = -Infinity;
  /** Desliga a recusa por região (medida A/B). */
  regionAvoid = true;

  regionOf(x: number, z: number): number {
    const i = Math.min(REGION_N - 1, Math.max(0, Math.floor((x + MAP_HALF) / REGION)));
    const j = Math.min(REGION_N - 1, Math.max(0, Math.floor((z + MAP_HALF) / REGION)));
    return j * REGION_N + i;
  }

  /** Mede a lotação das regiões (a cada REGION_EVERY s: uma passada pelos trechos, não por passo). */
  private measureRegions(): void {
    if (this.time - this.regionT < REGION_EVERY) return;
    this.regionT = this.time;
    const net = this.sim.net, sc = net.segs.cols, L = this.regionLoad, C = this.regionCap;
    L.fill(0); C.fill(0);
    for (let s = 0; s < net.segs.end; s++) {
      if (!net.segs.alive[s]) continue;
      const info = PROFILE_INFO[sc.profile[s]];
      if (info.rail) continue;
      const r = this.regionOf(sc.mx[s], sc.mz[s]);
      L[r] += this.segLoad[s * 2] + this.segLoad[s * 2 + 1];
      C[r] += sc.len[s] * (info.lanesFwd + info.lanesBack) / 7.5;
    }
    for (let r = 0; r < L.length; r++) this.regionOcc[r] = C[r] > 0 ? L[r] / C[r] : 0;
    // governador: velocidade média da janela micro (só com gente bastante para medir)
    let sum = 0;
    const cv = this.veh.cols.v;
    for (let i = 0; i < this.microN; i++) sum += cv[this.micro[i]];
    const avg = this.microN > 200 ? sum / this.microN : GOV_FAST;
    this.windowSpeed = avg;
    if (this.governed) {
      if (avg < GOV_SLOW) this.gov = Math.max(GOV_MIN, this.gov - 0.02);
      else if (avg > GOV_FAST) this.gov = Math.min(1, this.gov + 0.01);
    }
  }

  /** Fração da frota que a rede carrega agora (governador) e a velocidade média da janela (m/s). */
  gov = 1;
  windowSpeed = 0;
  /** Desliga o governador (medida A/B). */
  governed = true;

  /** Nó pela zona das vias em volta (sorteio com rejeição: O(1) esperado). */
  private zonedNode(weights: number[]): number {
    const net = this.sim.net, t = net.nodes, sc = net.segs.cols;
    for (let i = 0; i < 24; i++) {
      const n = this.randomNode();
      if (n < 0) return -1;
      let w = 0, front = 0, occ = 0;
      for (let k = 0; k < t.cols.deg[n]; k++) {
        const s = net.adj[n * MAX_DEG + k];
        w = Math.max(w, weights[baseZone(sc.zl[s])] ?? 0.1, weights[baseZone(sc.zr[s])] ?? 0.1);
        front += sc.len[s] * 0.5;
        const info = PROFILE_INFO[sc.profile[s]], cap = sc.len[s] / 7.5;
        occ = Math.max(occ, this.segLoad[s * 2] / (cap * Math.max(1, info.lanesFwd)), this.segLoad[s * 2 + 1] / (cap * Math.max(1, info.lanesBack)));
      }
      // pelo comprimento de rua em volta (os lotes), não por nó: cruzamentos colados no centro não viram
      // origem e destino de viagens a mais
      w *= Math.min(1, front / 120);
      // rua em volta engarrafada: a viagem sai (ou vai) para outro lugar, como quem evita o horário ou o
      // bairro parado; sem isso o centro junta carros até travar (a frota é a mesma, só muda onde)
      if (this.crowdAvoid && occ > CROWD_OCC) w *= Math.max(0, 1 - (occ - CROWD_OCC) * CROWD_SLOPE);
      if (this.regionAvoid) {
        const ro = this.regionOcc[this.regionOf(t.cols.x[n], t.cols.z[n])];
        if (ro > REGION_OCC) w *= Math.max(0.05, 1 - (ro - REGION_OCC) * REGION_SLOPE);
      }
      if (this.rng.next() < w) return n;
    }
    return this.randomNode();
  }

  private spawn(): void {
    const net = this.sim.net, nc = net.nodes.cols;
    const a = this.zonedNode(this.zoneWeights(true));
    if (a < 0) return;
    let b = -1;
    const wd = this.zoneWeights(false);
    for (let i = 0; i < 16; i++) {
      const cand = this.zonedNode(wd);
      if (cand < 0 || cand === a) continue;
      const d = Math.hypot(nc.x[cand] - nc.x[a], nc.z[cand] - nc.z[a]);
      // viagens curtas são mais comuns (distância média ~2,5 km)
      if (d > 200 && d < 7000 && this.rng.next() < Math.exp(-d / 2500)) { b = cand; break; }
    }
    if (b < 0) return;
    const v = this.veh.alloc();
    this.initVehicle(v);
    // part of the trucks carry cargo to a warehouse dock near the camera (they back into it on arrival)
    if (this.veh.cols.kind[v] === 2 && this.dockNodes.length && this.rng.next() < 0.6) {
      const d = this.dockNodes[this.rng.int(0, this.dockNodes.length)];
      if (d !== a && net.nodes.alive[d] && Math.hypot(nc.x[d] - nc.x[a], nc.z[d] - nc.z[a]) < 3000) b = d;
    }
    if (!this.plan(v, a, b)) { this.veh.release(v); return; }
    const seg = this.segBetween(a, this.routeAt(v, 1));
    if (seg < 0) { this.veh.release(v); return; }
    const dir = net.segs.cols.a[seg] === a ? 1 : -1;
    const after = this.nextSeg(v);
    const lane = this.pickLane(seg, dir, after, false, after >= 0 ? this.sim.laneToward(seg, dir, after, 0, false) : laneId(seg, dir, 0));
    if (lane < 0 || laneCount(net.segs.cols.profile[seg], dir) === 0) { this.veh.release(v); return; }
    // faixa cheia: não há onde sair com o carro (a viagem nasce em outro lugar)
    if (this.laneCount[lane] + 1 > this.sim.laneLen(lane) / 7.5) { this.veh.release(v); return; }
    const c = this.veh.cols;
    c.lane[v] = lane; c.conn[v] = -1;
    c.s[v] = this.rng.next() * this.sim.laneLen(lane);
    this.setLaneCount(lane, 1);
    if (this.leaveBay(v, lane)) return;
    this.mesoEnter(v, lane, true);
  }

  /**
   * Nasce perto da câmera (350 m), na faixa da direita de um trecho com vagas: sai da vaga (parado na guia, seta da
   * esquerda, entra na faixa) em vez de andar invisível no meso até a próxima esquina. Só com folga atrás.
   */
  private leaveBay(v: number, lane: number): boolean {
    const c = this.veh.cols, sim = this.sim;
    if (c.kind[v] !== 0 || laneIdx(lane) !== 0) return false;
    // só onde se vê (350 m da câmera): no resto da janela micro nascer no meso não muda o desenho e custa menos
    const sc = sim.net.segs.cols, sg = laneSeg(lane);
    if (Math.hypot(sc.mx[sg] - this.camX, sc.mz[sg] - this.camZ) > 350) return false;
    if (Number.isNaN(parkU(sim.net.segs.cols.profile[laneSeg(lane)], laneDir(lane)))) return false;
    const s = c.s[v];
    if (s < 10 || s > sim.laneLen(lane) - 25) return false;
    for (let o = this.laneHead[lane]; o >= 0; o = c.next[o]) {
      const d = c.s[o] - s;
      if (d > -40 && d < c.len[o] + 8) return false; // alguém chegando atrás ou logo à frente
    }
    c.v[v] = 0; c.pk[v] = 1; c.dwell[v] = 0; c.held[v] = 0; c.fade[v] = 0;
    this.addMicro(v);
    this.insert(v, false, lane);
    // pull out of the bay along a Reeds-Shepp path (held in place until it is back in the lane)
    const du = (parkU(sc.profile[sg], laneDir(lane)) - sim.laneU(lane)) * laneDir(lane);
    const a = this.mvA, b = this.mvB, len = c.len[v];
    this.centrePose(lane, s, len, du, a);
    this.centrePose(lane, s + 7, len, 0, b);
    const m = this.mvs.start(v, MKind.Unpark, a[0], a[2], a[3], b[0], b[2], b[3], a[1], 5, 4);
    if (m >= 0) { c.mv[v] = m; c.ms[v] = s + 7; }
    return true;
  }

  private initVehicle(v: number): void {
    const c = this.veh.cols;
    const r = this.rng.next();
    const kind = r < 0.88 ? 0 : r < 0.94 ? 1 : 2;
    c.kind[v] = kind; c.len[v] = KIND_LEN[kind];
    c.vf[v] = (kind === 0 ? 0.9 : 0.8) + this.rng.next() * 0.2;
    c.color[v] = this.rng.int(0, 16);
    if (kind === 0) {
      let u = this.rng.next(), style = 0;
      while (style < CAR_STYLE_SHARE.length - 1 && u >= CAR_STYLE_SHARE[style]) u -= CAR_STYLE_SHARE[style++];
      c.color[v] |= style << 4;
      c.len[v] = CAR_STYLE_LEN[style];
    }
    c.brk[v] = 0; c.exitC[v] = -1; c.pk[v] = 0; c.mv[v] = -1; c.ms[v] = 0;
    c.micro[v] = 0; c.dying[v] = 0; c.fade[v] = 1; c.has[v] = 0;
    c.next[v] = c.prev[v] = -1; c.lcFrom[v] = -1; c.lcT[v] = 1; c.lcCool[v] = this.rng.next() * 2;
    c.v[v] = 0;
    c.line[v] = -1; c.stopI[v] = 0; c.dwell[v] = 0; c.load[v] = 0; c.served[v] = 0; c.wait[v] = 0;
    c.held[v] = 0;
  }

  private despawn(v: number): void {
    const c = this.veh.cols;
    if (c.line[v] >= 0) { this.busSets[c.line[v]]?.delete(v); this.riders.delete(v); }
    this.wagonPrev.delete(v);
    if (c.mv[v] >= 0) { this.mvs.end(c.mv[v]); c.mv[v] = -1; }
    const parked = c.dying[v] === 2;
    if (c.micro[v]) { if (!parked) this.unlink(v); this.removeMicro(v); }
    if (c.lane[v] >= 0 && !parked) this.setLaneCount(c.lane[v], -1);
    if (parked) { this.parkers.delete(v); c.dying[v] = 1; }
    c.lane[v] = -1; c.conn[v] = -1;
    c.tExit[v] = -1;
    this.veh.release(v);
  }

  // ------------------------------------------------------------ meso

  private inWindow(lane: number): boolean {
    const sc = this.sim.net.segs.cols, s = laneSeg(lane);
    return Math.hypot(sc.mx[s] - this.camX, sc.mz[s] - this.camZ) < this.window;
  }

  /** Veículo passa a andar em modo meso na faixa (agenda a saída). */
  private mesoEnter(v: number, lane: number, spawned = false): void {
    const c = this.veh.cols;
    const L = this.sim.laneLen(lane);
    const p = this.sim.net.segs.cols.profile[laneSeg(lane)];
    const lanes = Math.max(1, laneCount(p, laneDir(lane)));
    // a fila já sai da vazão (um veículo a cada 1,8 s por faixa) e a faixa cheia anda devagar: o
    // congestionamento existe longe da câmera também, e a vazão que chega à janela micro é a que um
    // trânsito daquela lotação daria
    const rest = spawned ? L - c.s[v] : L;
    let extra = 0;
    // ônibus na faixa da sua parada: para, atende e já sabe a próxima
    if (c.line[v] >= 0) {
      const ln = this.lines[c.line[v]];
      if (ln && ln.stopLane[c.stopI[v]] === lane) { extra = ln.mode ? 25 : ln.term.has(c.stopI[v]) ? TERMINAL_DWELL : DWELL; this.serve(v); }
    }
    // o cruzamento no fim da faixa: a mesma espera que a rota estima (semáforo, pare, conversão) e a
    // vazão do braço, como no micro
    const ns = this.nextSeg(v);
    const wait = ns >= 0 ? this.router.nodeCost(this.sim.laneTo(lane), laneSeg(lane), ns) : 0;
    const node = this.sim.laneTo(lane);
    const headway = this.sim.nodePhases[node] > 0 ? 3.4 : wait >= 6 ? 3.6 : wait >= 4 ? 2.6 : 1.8;
    // tempo: andar livre, mais lento pela lotação (curva BPR), mais a espera do cruzamento; tudo vezes MESO_ALPHA
    const occ = Math.min(1, this.laneCount[lane] * 7.5 / (L * lanes));
    const run = rest / (laneSpeed(p) * c.vf[v]) * (1 + 3 * occ * occ) + wait;
    const t = Math.max(this.time + run * MESO_ALPHA + extra, this.laneLastExit[lane] + headway / lanes);
    this.laneLastExit[lane] = t;
    this.schedule(v, t);
  }

  private processMeso(): void {
    while (this.evN > 0 && this.evT[0] <= this.time) {
      const t = this.evT[0];
      const v = this.popEvent();
      const c = this.veh.cols;
      if (!this.veh.alive[v] || c.micro[v] || c.tExit[v] !== t) continue;
      this.mesoAdvance(v);
    }
  }

  /** Fim da faixa em modo meso: escolhe a próxima, espera se estiver cheia. */
  private mesoAdvance(v: number): void {
    const c = this.veh.cols, sim = this.sim;
    const lane = c.lane[v];
    if (!sim.net.segs.alive[laneSeg(lane)] || c.dying[v]) { this.despawn(v); return; }
    if (this.atDestination(v)) {
      if (c.line[v] < 0) { this.arrived++; this.despawn(v); return; }
      this.busPlan(v, sim.laneTo(lane)); // ônibus chegou sem atender: refaz o trecho até a parada
      if (c.dying[v]) { this.despawn(v); return; }
    }
    let ns = this.nextSeg(v);
    if (ns < 0) {
      // rota acabou antes do destino (rota truncada): planeja de novo daqui
      this.replanFrom(v, sim.laneTo(lane));
      if (c.dying[v]) { this.despawn(v); return; }
      ns = this.nextSeg(v);
      if (ns < 0) { this.despawn(v); return; }
    }
    const conn = sim.connToward(lane, ns, c.line[v] >= 0);
    const node = sim.laneTo(lane);
    const dir = sim.net.segs.cols.a[ns] === node ? 1 : -1;
    // meso: entra na faixa menos cheia entre as que servem para a conversão seguinte (todas as faixas
    // carregam carros, como no micro; senão todos chegam à janela numa faixa só)
    let to = conn >= 0 ? this.pickLane(ns, dir, this.segAfter(v, 1), c.line[v] >= 0, sim.conns.cols.to[conn]) : sim.laneToward(ns, dir, ns, 0);
    if (to < 0 && ns === laneSeg(lane)) to = laneId(ns, dir, 0); // retorno no fim de beco
    if (to < 0 || !sim.net.segs.alive[ns]) { this.despawn(v); return; }
    // fila: faixa cheia segura o veículo
    const cap = sim.laneLen(to) / 7.5;
    // fila: espera vaga; preso demais (impasse longe da câmera, onde ninguém vê), segue assim mesmo. O meso
    // não reconsidera a rota: desviando das faixas meso cheias ele mandava os carros para a janela micro
    // (medido: a janela enchia e o centro caía de 16 para 8 km/h)
    this.mesoTries++;
    if (this.laneCount[to] >= cap && c.wait[v] < 40) { c.wait[v] += 2; this.mesoFull++; this.schedule(v, this.time + 2); return; }
    c.wait[v] = 0;
    this.admit(node, sim.segArm[laneSeg(lane) * 2 + (laneDir(lane) > 0 ? 1 : 0)]);
    const enterMicro = this.inWindow(to);
    const tail = this.laneTail[to];
    if (enterMicro && tail >= 0 && c.s[tail] < c.len[tail] + S0 + 4) { this.schedule(v, this.time + 0.6); return; }
    this.setLaneCount(lane, -1);
    this.setLaneCount(to, 1);
    c.lane[v] = to;
    c.rIdx[v]++;
    if (enterMicro) {
      // entrou na janela: vira micro no começo da faixa
      c.s[v] = 0;
      c.held[v] = 0;
      c.v[v] = Math.min(laneSpeed(sim.net.segs.cols.profile[ns]) * c.vf[v], tail >= 0 ? Math.max(2, (c.s[tail] - c.len[tail]) / T_HEAD) : 99);
      c.conn[v] = -1;
      c.fade[v] = 0;
      this.addMicro(v);
      this.insert(v, false, to);
      return;
    }
    this.mesoEnter(v, to);
  }

  // ------------------------------------------------------------ cruzamentos

  /** Fase do semáforo aberta para o braço da conexão? */
  private stageGreen(conn: number, amberToo = false): boolean {
    const sim = this.sim, k = sim.conns.cols, n = k.node[conn];
    return sim.armStage[n * 8 + k.arm[conn]] === this.sigPhase[n] && (this.sigState[n] === 0 || (amberToo && this.sigState[n] === 1));
  }

  /** A conexão pode ser usada agora? (semáforo, preferência do anel) — sem olhar a preferência entre veículos. */
  gateOpen(conn: number): boolean {
    const sim = this.sim, k = sim.conns.cols;
    const n = k.node[conn];
    if (sim.nodePhases[n] > 0) return this.windowSignals.has(n) ? this.stageGreen(conn) : true;
    if (sim.nodeRing[n]) {
      const from = k.from[conn];
      const fromRing = (sim.net.segs.cols.flags[laneSeg(from)] & SegFlag.Ring) !== 0;
      if (fromRing) return true;
      // entrada: espera o anel livre (carros chegando ao nó ou passando por ele)
      for (let c = sim.nodeConn[n]; c >= 0; c = k.nextAtNode[c]) {
        const f = k.from[c];
        if ((sim.net.segs.cols.flags[laneSeg(f)] & SegFlag.Ring) === 0) continue;
        if (this.connHead[c] >= 0) return false;
        const t = this.laneHead[f];
        if (t >= 0 && sim.laneLen(f) - this.veh.cols.s[t] < 18) return false;
      }
      return true;
    }
    return true;
  }

  /** Peso da regra do braço: principal e semáforo passam antes; sem placa no meio; quem dá a preferência ou para, depois. */
  private ruleRank(conn: number): number {
    const k = this.sim.conns.cols, r = this.sim.armRule[k.node[conn] * 8 + k.arm[conn]];
    return r === Rule.Main || r === Rule.Signal ? 3 : r === Rule.Free ? 2 : 1;
  }

  /** `d` passa antes de `c`? Regra do braço, depois o movimento (reto > direita > esquerda), depois quem vem pela direita. */
  private outranks(d: number, c: number): boolean {
    const rd = this.ruleRank(d), rc = this.ruleRank(c);
    if (rd !== rc) return rd > rc;
    const k = this.sim.conns.cols;
    const mv = (x: number) => (k.turn[x] === Turn.Straight ? 2 : k.turn[x] === Turn.Right ? 1 : k.turn[x] === Turn.Left ? 0 : -1);
    if (mv(d) !== mv(c)) return mv(d) > mv(c);
    const n = k.node[c], sim = this.sim;
    const hx = -sim.armDx[n * 8 + k.arm[c]], hz = -sim.armDz[n * 8 + k.arm[c]];
    const ox = sim.armDx[n * 8 + k.arm[d]], oz = sim.armDz[n * 8 + k.arm[d]];
    return ox * hz - oz * hx < 0; // braço de d à direita de quem chega por c
  }

  /** Há alguém na conexão `d` ou chegando nela em breve (para quem precisa esperar por ela)? */
  private connBusy(d: number, me: number, strict: boolean): boolean {
    if (this.connHead[d] >= 0) return true;
    const sim = this.sim, k = sim.conns.cols, c = this.veh.cols;
    const f = k.from[d];
    const h = this.laneHead[f];
    if (h < 0 || h === me) return false;
    const dist = sim.laneLen(f) - c.s[h];
    if (dist > 45) return false;
    // vai mesmo por d?
    const ns = this.nextSeg(h);
    if (ns < 0 || laneSeg(k.to[d]) !== ns || sim.connToward(f, ns, c.line[h] >= 0) !== d) return false;
    // quem tem a vez está parado porque a saída dele está cheia: não vai sair agora, o outro passa
    if (c.v[h] < 0.5 && !this.exitRoom(d, h)) return false;
    // paciência (roadcraft): quem espera aceita brecha menor, 0,06 s por segundo esperado, até 1,5 s (mínimo 2,2 s)
    const imp = Math.min(1.5, c.wait[me] * 0.06);
    if (strict) return dist < 5 || dist / Math.max(1, c.v[h]) < Math.max(2.2, 3 - imp);
    // mesma regra, parado na linha: quem chegou primeiro passa
    if (c.v[h] < 0.5 && dist < 5) return c.wait[h] > c.wait[me] + 0.3;
    if (sim.nodePhases[k.node[d]] > 0 && !this.stageGreen(d, true)) return false;
    return dist < 6 || dist / Math.max(1, c.v[h]) < Math.max(2.2, 3.5 - imp);
  }

  /** Cabe na faixa de saída? (não entra no cruzamento para ficar parado nele) */
  private exitRoom(conn: number, v: number, extra = 0, deep = false): boolean {
    const sim = this.sim, k = sim.conns.cols, c = this.veh.cols;
    const to = k.to[conn];
    // a vaga está guardada para quem espera por ela há mais tempo (outro braço não fura a vez)
    const cl = this.exitClaim[to];
    if (cl >= 0 && cl !== v && this.time - this.exitClaimT[to] < 1 && this.veh.alive[cl]) return false;
    const L = sim.laneLen(to);
    // cruzamentos colados (a faixa entre eles é mais curta que um carro): ela é parte dos dois cruzamentos; a vaga que
    // conta é a da faixa seguinte da rota, descontando quem está nela e quem vai para ela. Exigir vaga na faixa de 1 m
    // deixava passar um carro por vez pelo cruzamento duplo (o pior nó do centro gerado)
    if (L < 8 && !deep) {
      const kk = c.rIdx[v];
      const ns2 = kk + 2 < c.rLen[v] ? this.segBetween(this.routeAt(v, kk + 1), this.routeAt(v, kk + 2)) : -1;
      const c2 = ns2 >= 0 ? sim.connToward(to, ns2, c.line[v] >= 0) : -1;
      if (c2 >= 0) {
        let busy = 0;
        for (let u = this.laneHead[to]; u >= 0; u = c.next[u]) busy += c.len[u] + 2;
        for (let x = sim.nodeConn[k.node[conn]]; x >= 0; x = k.nextAtNode[x]) {
          if (k.to[x] !== to) continue;
          for (let u = this.connHead[x]; u >= 0; u = c.next[u]) busy += c.len[u] + 2;
        }
        return this.exitRoom(c2, v, busy, true);
      }
    }
    const tail = this.laneTail[to];
    // o último da faixa andando abre espaço no tempo de atravessar (~2 s): quem está atrás já pode entrar
    let room = (tail >= 0 ? c.s[tail] - c.len[tail] + Math.min(c.v[tail], 6) * 1.5 : L) - extra;
    let inbound = 0;
    // quem já está no cruzamento indo para a mesma faixa
    for (let x = sim.nodeConn[k.node[conn]]; x >= 0; x = k.nextAtNode[x]) {
      if (k.to[x] !== to) continue;
      for (let u = this.connHead[x]; u >= 0; u = c.next[u]) { room -= c.len[u] + 2; inbound++; }
    }
    if (extra > 0) inbound++;
    // faixa vazia (mesmo curta): pode entrar; senão precisa caber
    if (this.laneCount[to] === 0 && inbound === 0) return true;
    // trecho curto entre cruzamentos colados: é quase parte do cruzamento; o último andando, cabe mais um
    if (L < 25 && tail >= 0 && c.v[tail] > 2 && inbound === 0) return true;
    if (this.laneCount[to] >= Math.max(1, L / 7.5)) return false;
    return room > Math.min(c.len[v] + 2.5, L * 0.6);
  }

  /** Portão para um veículo: semáforo (no amarelo passa quem não consegue parar), pare, preferência, saída livre. */
  private gateFor(conn: number, v: number, toEnd: number): boolean {
    // emenda de via (nó de duas vias sem controle): não há cruzamento para bloquear; o IDM segue o último da faixa
    // seguinte através do nó (`aheadThrough`). Exigir folga ali parava a fila a cada emenda (a cidade divide as vias a
    // cada ≤112 m) e o anda-e-para descia até o centro: 31 → 196 saídas cheias atrás de emendas em 20 min de pico.
    const sim = this.sim, n = sim.conns.cols.node[conn];
    if (sim.net.nodes.cols.deg[n] === 2 && sim.nodeCtl[n] === Ctl.None) return true;
    if (!this.exitRoom(conn, v)) return false;
    return this.gateRules(conn, v, toEnd);
  }

  private gateRules(conn: number, v: number, toEnd: number): boolean {
    const sim = this.sim, k = sim.conns.cols, n = k.node[conn], c = this.veh.cols;
    if (sim.nodePhases[n] > 0) {
      if (!this.windowSignals.has(n)) return true;
      if (!this.stageGreen(conn)) {
        if (this.sigState[n] === 1 && this.stageGreen(conn, true)) { const sv = c.v[v]; if (toEnd < (sv * sv) / (2 * 3.5)) return true; }
        return false;
      }
    } else if (sim.nodeRing[n]) return this.gateOpen(conn);
    // zebra: dá a vez a quem está atravessando (o pedestre aparece só perto da câmera)
    else if (sim.nodeCtl[n] === Ctl.Zebra) return !this.pedCrossing(n);
    else if (sim.armRule[n * 8 + k.arm[conn]] === Rule.Stop && c.wait[v] < 1.2) return false; // pare: para antes de seguir
    // preferência: espera quem passa antes (no semáforo, só o conflito permitido, como a conversão à esquerda)
    const list = sim.conflicts.get(conn);
    if (!list) return true;
    const stuck = c.wait[v] > 8; // ninguém fica preso para sempre: depois de 12 s só respeita quem já está no cruzamento
    const now = Math.round(this.time * 10);
    // e reclama a vez: quem vem pela preferencial e ainda pode parar com folga deixa passar
    if (stuck) this.connClaim[conn] = now;
    const sv = c.v[v], canStop = toEnd > (sv * sv) / (2 * 3) + 1;
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      if (stuck) { if (this.connHead[d] >= 0) return false; continue; }
      if (canStop && now - this.connClaim[d] < 6) return false;
      if (sim.nodePhases[n] > 0 && !this.stageGreen(d, true) && this.connHead[d] < 0) continue;
      const higher = this.outranks(d, conn);
      if (higher && this.connBusy(d, v, this.ruleRank(d) > this.ruleRank(conn))) return false;
      if (!higher && this.connHead[d] >= 0 && this.ruleRank(d) >= this.ruleRank(conn)) return false; // não entra em cima de quem já está passando
    }
    return true;
  }

  private updateSignals(dt: number): void {
    const sim = this.sim;
    for (const n of this.windowSignals) {
      const phases = sim.nodePhases[n];
      if (!sim.net.nodes.alive[n] || phases === 0) { this.signalNodes.delete(n); this.windowSignals.delete(n); if (this.signals && n < this.signals.length) this.signals[n] = 0; continue; }
      const spec = sim.net.junctions.get(n);
      const pedSig = sim.nodeCtl[n] === Ctl.PedSignal;
      if (spec?.fixed || pedSig) {
        // tempo fixo: o ciclo segue o relógio (com a defasagem), para a onda verde
        const greens: number[] = [];
        let cycle = 0;
        for (let i = 0; i < phases; i++) { const g = Math.max(5, spec?.greens?.[i] ?? (pedSig ? (i === 0 ? 30 : 12) : 20)); greens.push(g); cycle += g + 4.5; }
        let t = ((this.time + (spec?.offset ?? 0)) % cycle + cycle) % cycle;
        let st = 0;
        for (let i = 0; i < phases; i++) {
          if (t < greens[i]) { st = 0; this.sigPhase[n] = i; break; }
          t -= greens[i];
          if (t < 3) { st = 1; this.sigPhase[n] = i; break; }
          t -= 3;
          if (t < 1.5) { st = 2; this.sigPhase[n] = i; break; }
          t -= 1.5;
        }
        this.sigState[n] = st;
      } else {
        this.sigTimer[n] += dt;
        const st = this.sigState[n];
        // prioridade ao ônibus: ônibus esperando no vermelho encurta o verde dos outros
        const busWaiting = spec?.bus && st === 0 && this.sigTimer[n] > 6 && this.busWaitingAt(n);
        // a cada segundo de verde (depois do mínimo): fila vazia aqui e gente esperando do outro lado corta o
        // verde; ninguém esperando do outro lado segura o verde
        let endGreen = busWaiting || false;
        const tg = this.sigTimer[n];
        if (!endGreen && st === 0 && tg >= 6 && Math.floor(tg) !== Math.floor(tg - dt)) {
          let others = 0;
          for (let p = 0; p < phases && others === 0; p++) if (p !== this.sigPhase[n]) others += this.stageQueue(n, p);
          if (others === 0) this.sigGreen[n] = Math.max(this.sigGreen[n], tg + 1.5);
          else if (this.stageQueue(n, this.sigPhase[n]) === 0) endGreen = true;
        }
        if (st === 0 && (tg >= this.sigGreen[n] || endGreen)) { this.sigState[n] = 1; this.sigTimer[n] = 0; }
        else if (st === 1 && this.sigTimer[n] >= 3) { this.sigState[n] = 2; this.sigTimer[n] = 0; }
        else if (st === 2 && this.sigTimer[n] >= 1.5) {
          // próxima fase com fila (pula fases vazias)
          let next = this.sigPhase[n];
          for (let k = 1; k <= phases; k++) {
            const cand = (this.sigPhase[n] + k) % phases;
            if (this.stageQueue(n, cand) > 0 || k === phases) { next = cand; break; }
          }
          this.sigPhase[n] = next;
          this.sigState[n] = 0;
          this.sigTimer[n] = 0;
          // verde se ajusta à fila
          this.sigGreen[n] = Math.min(40, Math.max(8, 5 + this.stageQueue(n, next) * 1.8));
        }
      }
      if (this.signals && n < this.signals.length) {
        // 128 | amarelo << 6 | braços com verde/amarelo
        let mask = 0;
        if (this.sigState[n] < 2) for (let a = 0; a < 8; a++) if (sim.armStage[n * 8 + a] === this.sigPhase[n] && a < sim.net.nodes.cols.deg[n]) mask |= 1 << a;
        this.signals[n] = 128 | (this.sigState[n] === 1 ? 64 : 0) | (mask & 63);
      }
    }
  }

  /** Fila de uma fase (soma dos braços dela). */
  private stageQueue(n: number, stage: number): number {
    let q = 0;
    const deg = this.sim.net.nodes.cols.deg[n];
    for (let a = 0; a < deg; a++) if (this.sim.armStage[n * 8 + a] === stage) q += this.armQueue(n, a);
    return q;
  }

  /** Algum ônibus parado no vermelho deste nó? */
  private busWaitingAt(n: number): boolean {
    const sim = this.sim, k = sim.conns.cols, c = this.veh.cols;
    for (let x = sim.nodeConn[n]; x >= 0; x = k.nextAtNode[x]) {
      if (this.stageGreen(x)) continue;
      const h = this.laneHead[k.from[x]];
      if (h >= 0 && c.line[h] >= 0 && sim.laneLen(k.from[x]) - c.s[h] < 40) return true;
    }
    return false;
  }

  /** Carros do braço `arm` do nó `n` com verde ou amarelo (pedestres esperam). Só na janela. */
  carsGo(n: number, arm: number): boolean {
    return this.windowSignals.has(n) && this.sim.armStage[n * 8 + arm] === this.sigPhase[n] && this.sigState[n] < 2;
  }

  /** Veículos esperando num braço (perto da linha de retenção). */
  private armQueue(n: number, arm: number): number {
    const sim = this.sim, k = sim.conns.cols, c = this.veh.cols;
    let q = 0;
    const seen = new Set<number>();
    for (let x = sim.nodeConn[n]; x >= 0; x = k.nextAtNode[x]) {
      if (k.arm[x] !== arm || seen.has(k.from[x])) continue;
      const lane = k.from[x];
      seen.add(lane);
      const L = sim.laneLen(lane);
      for (let v = this.laneHead[lane]; v >= 0 && L - c.s[v] < 80; v = c.next[v]) q++;
      if (this.laneHead[lane] < 0) q += Math.min(4, this.laneCount[lane]);
    }
    return q;
  }

  /** Uma conexão vai sumir (nó refeito): quem está nela pula para a faixa de destino. */
  evacuateConn(conn: number): void {
    const c = this.veh.cols, sim = this.sim;
    for (let v = this.connHead[conn]; v >= 0;) {
      const next = c.next[v];
      const to = sim.conns.cols.to[conn];
      this.unlink(v);
      c.conn[v] = -1;
      if (!sim.net.segs.alive[laneSeg(to)]) { this.despawn(v); v = next; continue; }
      this.setLaneCount(c.lane[v], -1);
      this.setLaneCount(to, 1);
      c.lane[v] = to; c.s[v] = 0; c.rIdx[v]++;
      if (c.rIdx[v] >= c.rLen[v] || this.routeAt(v, c.rIdx[v]) !== sim.laneTo(to)) this.replanFrom(v, sim.laneTo(to));
      this.insert(v, false, to);
      v = next;
    }
    this.connHead[conn] = -1; this.connTail[conn] = -1;
    this.activeConns.delete(conn);
  }

  /** Nós refeitos: semáforos recomeçam. */
  nodesRebuilt(nodes: number[]): void {
    for (const n of nodes) {
      if (!this.sim.net.nodes.alive[n] || this.sim.nodePhases[n] === 0) { this.signalNodes.delete(n); continue; }
      this.signalNodes.add(n);
      this.sigPhase[n] = 0; this.sigState[n] = 0; this.sigTimer[n] = 0; this.sigGreen[n] = 12;
    }
  }

  /** Trechos removidos: veículos nas faixas deles saem. */
  segsRemoved(segs: number[]): void {
    if (!segs.length) return;
    const dead = new Set(segs);
    const c = this.veh.cols;
    // só os micro estão em listas; meso descobrem no próximo evento
    for (let i = this.microN - 1; i >= 0; i--) {
      const v = this.micro[i];
      const lane = c.conn[v] >= 0 ? this.sim.conns.cols.to[c.conn[v]] : c.lane[v];
      if (dead.has(laneSeg(lane)) || (c.lane[v] >= 0 && dead.has(laneSeg(c.lane[v])))) this.despawn(v);
    }
    for (const s of segs) { this.segLoad[s * 2] = 0; this.segLoad[s * 2 + 1] = 0; }
    for (const s of segs) for (let k = 0; k < 16; k++) { this.laneCount[s * 16 + k] = 0; this.laneHead[s * 16 + k] = -1; this.laneTail[s * 16 + k] = -1; this.activeLanes.delete(s * 16 + k); }
  }

  // ------------------------------------------------------------ micro

  /** Aceleração IDM com líder a `gap` metros andando a `vl`. */
  private idm(v: number, v0: number, gap: number, vl: number, am = A_MAX): number {
    const dv = v - vl;
    // arranque da fila (roadcraft): o da frente saiu e eu ainda estou devagar → encosto menos e reajo mais
    // rápido (até 60%, some aos 4 m/s); a fila sai junta, sem sanfona
    const rel = vl > 0.3 && v < 4 ? 0.6 * (1 - v / 4) * Math.min(1, vl / 1.5) : 0;
    const sStar = S0 * (1 - rel) + Math.max(0, v * T_HEAD * (1 - rel) + (v * dv) / (2 * Math.sqrt(am * B_COMF)));
    const g = Math.max(0.1, gap);
    return am * (1 - Math.pow(v / Math.max(0.1, v0), 4) - (sStar / g) * (sStar / g));
  }

  private stepMicro(dt: number): void {
    const c = this.veh.cols, sim = this.sim;
    // conexões primeiro (estão na frente das faixas que alimentam)
    for (const conn of [...this.activeConns]) {
      for (let v = this.connHead[conn]; v >= 0;) {
        const next = c.next[v];
        this.moveOnConn(v, conn, dt);
        v = next;
      }
    }
    for (const lane of [...this.activeLanes]) {
      if (!sim.net.segs.alive[laneSeg(lane)]) continue;
      for (let v = this.laneHead[lane]; v >= 0;) {
        const next = c.next[v];
        this.moveOnLane(v, lane, dt);
        v = next;
      }
    }
  }

  /** Distância até o veículo de trás da conexão/faixa à frente (para seguir através do nó). */
  private aheadThrough(conn: number): [number, number] {
    const c = this.veh.cols, k = this.sim.conns.cols;
    const t = this.connTail[conn];
    if (t >= 0) return [c.s[t] - c.len[t], c.v[t]];
    const lt = this.laneTail[k.to[conn]];
    if (lt >= 0) return [k.len[conn] + c.s[lt] - c.len[lt], c.v[lt]];
    return [k.len[conn] + 60, 99];
  }

  private moveOnLane(v: number, lane: number, dt: number): void {
    const c = this.veh.cols, sim = this.sim;
    // manoeuvring while still in the lane: stopped there, so those behind wait (or change lanes)
    if (c.dying[v] === 3) { c.v[v] = 0; c.brk[v] = 1; return; }
    if (c.dying[v] === 4) { this.kerbStep(v, lane, dt); return; }
    const L = sim.laneLen(lane);
    const p = sim.net.segs.cols.profile[laneSeg(lane)];
    const v0 = laneSpeed(p) * c.vf[v];
    let gap = 1e9, vl = 99;
    const lead = c.prev[v];
    if (lead >= 0) { gap = c.s[lead] - c.len[lead] - c.s[v]; vl = c.v[lead]; }
    // fim da faixa: destino, semáforo ou o que vem depois do nó
    let conn = -1, release = false;
    // ônibus: a parada é um obstáculo até ele parar e atender
    let atStop = false;
    if (c.line[v] >= 0 && !c.dying[v]) {
      const ln = this.lines[c.line[v]];
      if (ln && ln.stopLane[c.stopI[v]] === lane) {
        const sg = ln.stopV[c.stopI[v]] - c.s[v];
        if (sg > -2) {
          if (sg < 1.2 && c.v[v] < 0.4) {
            c.dwell[v] += dt;
            if (c.dwell[v] >= (ln.mode ? 25 : ln.term.has(c.stopI[v]) ? TERMINAL_DWELL : DWELL)) { c.dwell[v] = 0; this.serve(v); }
            else atStop = true;
          }
          if (lead < 0 || sg + S0 < gap) { gap = Math.min(gap, Math.max(0, sg) + S0); vl = 0; }
        }
      }
    }
    if (c.dying[v]) { /* saindo */ }
    else if (this.atDestination(v) && c.line[v] < 0) {
      // near the camera cars and trucks decide 30 m before the end (room for the manoeuvre); the rest at 12 m
      const room = c.micro[v] && (c.kind[v] === 0 || c.kind[v] === 2) && this.nearCam(lane) ? 30 : 12;
      if (L - c.s[v] < room) { const r = this.arrive(v, lane, L - c.s[v]); if (r === 1) return; if (r === 2) c.dying[v] = 1; }
    } else {
      let ns = this.nextSeg(v);
      if (ns < 0 && !c.dying[v]) { this.replanFrom(v, sim.laneTo(lane)); ns = this.nextSeg(v); }
      if (ns >= 0) conn = sim.connToward(lane, ns, c.line[v] >= 0);
      if (conn < 0) {
        // faixa errada: tenta trocar; senão segue qualquer conexão e replaneja
        if (ns >= 0) this.mandatoryChange(v, lane, ns);
        conn = sim.laneConn[lane];
        if (conn < 0 && lead < 0 && c.lane[v] === lane) this.escapeLane(v, lane);
      }
      // parado há 10 s na fila de uma faixa cheia (não no vermelho de uma faixa com folga): reconsidera a
      // rota, fugindo do que está cheio (roadcraft reconsiderRoute). Na linha já é tarde para mudar (como no
      // roadcraft): ali quem desvia é `detour`, e só para uma saída com espaço
      if (c.held[v] >= STUCK_SECONDS && lead >= 0 && c.line[v] < 0 && this.routeBudget > 0) {
        c.held[v] = 0;
        if (this.laneCount[lane] >= 0.6 * L / 7.5 && this.reconsider(v, lane, -1)) {
          const ns2 = this.nextSeg(v);
          if (ns2 >= 0 && sim.connToward(lane, ns2, false) < 0) this.mandatoryChange(v, lane, ns2);
        }
      }
      if (lead < 0) {
        const toEnd = L - c.s[v];
        if (toEnd < 6 && c.v[v] < 0.5) c.wait[v] += dt;
        // saída bloqueada há um tempo: o motorista desvia por outra saída livre desta faixa
        if (conn >= 0 && c.wait[v] > 6 && c.lcCool[v] <= 0 && !this.exitRoom(conn, v)) {
          c.lcCool[v] = 5;
          const alt = this.detour(v, lane, conn);
          if (alt >= 0) conn = alt;
        }
        // esperando a saída cheia há muito tempo: guarda a próxima vaga dela (o que espera há mais tempo ganha)
        if (conn >= 0 && toEnd < 6 && c.wait[v] > STARVE_SECONDS) {
          const to = sim.conns.cols.to[conn], cl = this.exitClaim[to];
          if (cl === v || cl < 0 || this.time - this.exitClaimT[to] >= 1 || !this.veh.alive[cl] || c.wait[cl] < c.wait[v]) { this.exitClaim[to] = v; this.exitClaimT[to] = this.time; }
        }
        // cruzamento travado (ninguém passa há 20 s e este espera há 20 s): passa um por vez, com a caixa livre
        if (conn >= 0 && toEnd < 6 && c.wait[v] > JAM_SECONDS) release = this.jamRelease(conn, v);
        if (conn < 0 || !(release || this.gateFor(conn, v, toEnd))) { gap = Math.min(gap, toEnd - 1); vl = 0; }
        else { const [g2, v2] = this.aheadThrough(conn); if (toEnd + g2 < gap) { gap = toEnd + g2; vl = v2; } } // (não apaga a parada do ônibus)
        // ônibus e trem: a parada logo depois do nó já entra na frenagem (trem rápido não para em 20 m)
        const sg = this.stopAhead(v, conn);
        if (sg >= 0 && toEnd + sg < gap) { gap = toEnd + sg; vl = 0; }
      }
    }
    let a = this.idm(c.v[v], v0, gap, vl, c.kind[v] ? A_HEAVY : A_MAX);
    if (c.dying[v]) a = Math.min(a, 0); // quem chegou some sem frear na frente dos outros
    if (c.pk[v] > 0 && !c.dying[v] && c.dwell[v] < 1.2) a = -9; // na vaga, esperando para sair
    if (c.mv[v] >= 0) a = -9; // pulling out of the bay: held until the manoeuvre is back in the lane
    if (atStop) a = Math.min(a, -2);
    a = Math.max(-9, a);
    const nv = Math.max(0, c.v[v] + a * dt);
    c.exitC[v] = conn;
    c.brk[v] = a < -1.2 || nv < 0.4 ? 1 : 0;
    // saindo da vaga: o desenho desliza da guia para a faixa (a simulação já o tem na faixa)
    if (c.pk[v] > 0 && !c.dying[v] && c.mv[v] < 0 && (c.dwell[v] += dt) > 1.2) c.pk[v] = Math.max(0, c.pk[v] - dt / PARK_SIDE_S);
    c.s[v] += (c.v[v] + nv) * 0.5 * dt;
    c.v[v] = nv;
    if (c.lcT[v] < 1) c.lcT[v] = Math.min(1, c.lcT[v] + dt / 2.2);
    c.lcCool[v] -= dt;
    if (c.dying[v]) { c.fade[v] -= dt * 1.5; if (c.fade[v] <= 0) { this.arrived++; this.despawn(v); } return; }
    if (c.fade[v] < 1) c.fade[v] = Math.min(1, c.fade[v] + dt * 1.2);
    if (nv < 0.5) c.held[v] += dt; else c.held[v] = 0;
    if (c.s[v] >= L) {
      // faixa sem saída nenhuma (a conversão era de outra faixa e a troca não deu): para na linha e troca de
      // faixa quando couber (`escapeLane`), em vez de sumir
      if (conn < 0) { c.s[v] = L - 0.01; c.v[v] = 0; return; }
      if (!release && !this.gateFor(conn, v, 0)) { c.s[v] = L - 0.01; c.v[v] = 0; return; }
      // entra na conexão
      this.unlink(v);
      c.s[v] -= L;
      c.conn[v] = conn;
      c.wait[v] = 0;
      c.held[v] = 0;
      const k = sim.conns.cols;
      if (release) { this.released++; this.releaseAt[k.node[conn]] = this.time + RELEASE_EVERY; this.nodePass[k.node[conn]]++; this.advisor.pass[k.node[conn] * 8 + k.arm[conn]]++; }
      else this.admit(k.node[conn], k.arm[conn]);
      this.insert(v, true, conn);
      return;
    }
    if (c.lcCool[v] <= 0 && lead >= 0) this.discretionaryChange(v, lane);
  }

  /** Alguém passou pelo nó `n` vindo do braço `arm` (micro ou meso): fluxo do braço e "o nó anda". */
  private admit(n: number, arm: number): void {
    this.nodePass[n]++;
    this.advisor.pass[n * 8 + arm]++;
    this.lastAdmit[n] = this.time;
  }

  /**
   * Cruzamento travado (invariants do roadcraft: ninguém passou há JAM_SECONDS e `v` espera na linha há
   * isso): `v` pode passar sem esperar a vez nem a saída, um veículo por vez a cada RELEASE_EVERY s, só
   * com a caixa livre (ninguém nas conexões que cruzam a dele) e sem pedestre na faixa. No semáforo só quem
   * está no verde (a saída cheia o segurava): ninguém fura o vermelho. Num ciclo de faixas cheias, cada um
   * que entra na caixa abre uma vaga atrás e a roda anda.
   */
  private jamRelease(conn: number, v: number): boolean {
    const sim = this.sim, k = sim.conns.cols, n = k.node[conn];
    if (this.time - this.lastAdmit[n] < JAM_SECONDS || this.time < this.releaseAt[n]) return false;
    if (this.veh.cols.wait[v] < JAM_SECONDS) return false;
    if (this.jamAt[n] < this.lastAdmit[n]) { this.jamAt[n] = this.time; this.jams++; } // travamento novo
    if (sim.nodePhases[n] > 0 && (!this.windowSignals.has(n) || !this.stageGreen(conn, true))) return false;
    if (this.connHead[conn] >= 0 && this.veh.cols.s[this.connTail[conn]] < this.veh.cols.len[this.connTail[conn]] + 2) return false;
    if (this.pedCrossing(n)) return false;
    const list = sim.conflicts.get(conn);
    if (list) for (let i = 0; i < list.length; i++) if (this.connHead[list[i]] >= 0) return false;
    return true;
  }

  /**
   * Motorista parado há STUCK_SECONDS reconsidera a rota (roadcraft reconsiderRoute): a busca já foge das
   * vias cheias (custo pela lotação) e, se a saída que ele queria está cheia, proíbe aquele trecho.
   * Sem outro caminho fica com a rota de antes. Devolve se mudou de rota.
   */
  private reconsider(v: number, lane: number, blocked: number): boolean {
    const c = this.veh.cols, sim = this.sim;
    if (c.line[v] >= 0 || this.routeBudget <= 0) return false;
    const node = sim.laneTo(lane);
    // a rota segue de `node` (rIdx aponta para ele); o desvio é local: volta à rota alguns nós adiante
    // (busca curta, barata), e o resto da rota fica como estava
    const o = v * ROUTE_CAP, k0 = c.rIdx[v], len = c.rLen[v];
    if (k0 >= len || this.routes[o + k0] !== node || k0 + 1 >= len) return false;
    const j = Math.min(len - 1, k0 + REJOIN);
    const target = this.routes[o + j];
    this.routeBudget--;
    const lim = this.router.limit;
    this.router.limit = 600;
    const n = this.router.route(node, target, this.detourPath, 0, ROUTE_CAP, false, laneSeg(lane), false, blocked);
    this.router.limit = lim;
    if (n < 2 || this.detourPath[n - 1] !== target) return false;
    // só um desvio que esta faixa alcança (sem troca de faixa forçada na fila, que acabava em conexão errada
    // e rota refeita do zero do outro lado)
    const first = this.segBetween(this.detourPath[0], this.detourPath[1]);
    if (first < 0 || this.sim.connToward(lane, first, false) < 0) return false;
    // nada mudou (a mesma sequência de nós): fica
    let same = n === j - k0 + 1;
    for (let i = 0; same && i < n; i++) same = this.detourPath[i] === this.routes[o + k0 + i];
    if (same) return false;
    // nova rota: desvio + o que sobrava depois do ponto de volta (até caber)
    this.splice(v, 0, n, j);
    this.reroutes++;
    return true;
  }
  private detourPath = new Int32Array(ROUTE_CAP);
  private tailTmp = new Int32Array(ROUTE_CAP);

  /** Rota nova de `v`: `pre` nós já em routes[0..pre), o desvio (`detourPath`, n nós) e o que sobrava da rota depois do índice `j`. */
  private splice(v: number, pre: number, n: number, j: number): void {
    const c = this.veh.cols, o = v * ROUTE_CAP, len = c.rLen[v];
    const tail = this.tailTmp, rest = Math.max(0, Math.min(len - j - 1, ROUTE_CAP - pre - n));
    for (let i = 0; i < rest; i++) tail[i] = this.routes[o + j + 1 + i];
    for (let i = 0; i < n; i++) this.routes[o + pre + i] = this.detourPath[i];
    for (let i = 0; i < rest; i++) this.routes[o + pre + n + i] = tail[i];
    c.rLen[v] = pre + n + rest; c.rIdx[v] = 0;
  }

  /**
   * Outra conexão da faixa com espaço na saída; a rota é refeita a partir dela, voltando à rota de antes
   * alguns nós adiante (busca curta; sem volta por perto, até o destino). −1 se não houver.
   */
  private detour(v: number, lane: number, blocked: number): number {
    const c = this.veh.cols, sim = this.sim, k = sim.conns.cols;
    if (c.line[v] >= 0 || this.routeBudget <= 0) return -1;
    const o = v * ROUTE_CAP, k0 = c.rIdx[v], len = c.rLen[v];
    for (let x = sim.laneConn[lane]; x >= 0; x = k.nextFromLane[x]) {
      if (x === blocked || k.turn[x] === Turn.UTurn) continue;
      const to = k.to[x];
      if (sim.isBusLane(to) || !this.exitRoom(x, v)) continue;
      const far = sim.laneTo(to);
      this.routeBudget--;
      const j = Math.min(len - 1, k0 + REJOIN + 1), target = this.routes[o + j];
      if (k0 < len && j > k0 + 1 && target !== far) {
        const lim = this.router.limit;
        this.router.limit = 600;
        const n = this.router.route(far, target, this.detourPath, 0, ROUTE_CAP - 1, false, laneSeg(to));
        this.router.limit = lim;
        if (n >= 2 && this.detourPath[n - 1] === target) { this.routes[o] = k.node[x]; this.splice(v, 1, n, j); return x; }
      }
      const n = this.router.route(far, c.dest[v], this.routes, o + 1, ROUTE_CAP - 1, false, laneSeg(to));
      if (n < 1) continue;
      this.routes[o] = k.node[x];
      c.rLen[v] = n + 1; c.rIdx[v] = 0;
      return x;
    }
    return -1;
  }

  /** Distância do começo da conexão até a parada (se a parada está na faixa depois dela), ou −1. */
  private stopAhead(v: number, conn: number): number {
    const c = this.veh.cols;
    if (c.line[v] < 0 || conn < 0) return -1;
    const ln = this.lines[c.line[v]];
    if (!ln || ln.stopLane[c.stopI[v]] !== this.sim.conns.cols.to[conn]) return -1;
    return this.sim.conns.cols.len[conn] + ln.stopV[c.stopI[v]];
  }

  private moveOnConn(v: number, conn: number, dt: number): void {
    const c = this.veh.cols, sim = this.sim, k = sim.conns.cols;
    const L = k.len[conn];
    const to = k.to[conn];
    const v0 = Math.min(laneSpeed(sim.net.segs.cols.profile[laneSeg(to)]), k.turn[conn] === Turn.Straight ? 99 : 8) * c.vf[v];
    let gap = 1e9, vl = 99;
    const lead = c.prev[v];
    if (lead >= 0) { gap = c.s[lead] - c.len[lead] - c.s[v]; vl = c.v[lead]; }
    else {
      const lt = this.laneTail[to];
      if (lt >= 0) { gap = L - c.s[v] + c.s[lt] - c.len[lt]; vl = c.v[lt]; }
      // outra conexão juntando na mesma faixa: quem está mais perto do fim entra antes (sem isso os dois
      // chegavam juntos e um aparecia dentro do outro no começo da faixa)
      const mine = L - c.s[v];
      for (let x = sim.nodeConn[k.node[conn]]; x >= 0; x = k.nextAtNode[x]) {
        if (x === conn || k.to[x] !== to) continue;
        const h = this.connHead[x];
        if (h < 0) continue;
        const ahead = k.len[x] - c.s[h];
        if (ahead < mine || (ahead === mine && h < v)) { const g = mine - ahead - c.len[h]; if (g < gap) { gap = g; vl = c.v[h]; } }
      }
    }
    const sg = this.stopAhead(v, conn);
    if (sg >= 0 && sg - c.s[v] < gap) { gap = Math.max(0, sg - c.s[v]); vl = 0; }
    const a = Math.max(-9, this.idm(c.v[v], v0, gap, vl, c.kind[v] ? A_HEAVY : A_MAX));
    const nv = Math.max(0, c.v[v] + a * dt);
    c.s[v] += (c.v[v] + nv) * 0.5 * dt;
    c.v[v] = nv;
    c.brk[v] = a < -1.2 || nv < 0.4 ? 1 : 0;
    if (c.fade[v] < 1) c.fade[v] = Math.min(1, c.fade[v] + dt * 1.2);
    if (c.s[v] < L) return;
    // chegou na faixa seguinte
    this.unlink(v);
    c.conn[v] = -1;
    const from = c.lane[v];
    this.setLaneCount(from, -1);
    this.setLaneCount(to, 1);
    c.lane[v] = to;
    c.s[v] -= L;
    c.rIdx[v]++;
    // a rota pode ter sido furada (faixa errada): replaneja a partir do fim desta faixa;
    // indo para um retorno no canteiro, replaneja podendo voltar (quem passou do destino retorna ali)
    const endNode = sim.laneTo(to);
    if (sim.nodeCtl[endNode] === Ctl.UTurn && c.line[v] < 0) this.replanFrom(v, endNode, true);
    else if (c.rIdx[v] >= c.rLen[v] || this.routeAt(v, c.rIdx[v]) !== endNode) this.replanFrom(v, endNode);
    if (!this.inWindowOut(to)) {
      // saiu da janela: volta a ser meso
      this.removeMicro(v);
      this.mesoEnter(v, to);
      return;
    }
    this.insert(v, false, to);
  }

  private inWindowOut(lane: number): boolean {
    const sc = this.sim.net.segs.cols, s = laneSeg(lane);
    return Math.hypot(sc.mx[s] - this.camX, sc.mz[s] - this.camZ) < this.window + WINDOW_OUT - WINDOW;
  }

  // ------------------------------------------------------------ troca de faixa

  /** Vizinhos na faixa `lane` em torno de s: [líder, seguidor]. */
  private around(lane: number, s: number): [number, number] {
    const c = this.veh.cols;
    let lead = -1;
    for (let v = this.laneHead[lane]; v >= 0; v = c.next[v]) {
      if (c.s[v] < s) return [lead, v];
      lead = v;
    }
    return [lead, -1];
  }

  private canChange(v: number, target: number, bias: number): boolean {
    const c = this.veh.cols, sim = this.sim;
    const [lead, follow] = this.around(target, c.s[v]);
    const p = sim.net.segs.cols.profile[laneSeg(target)];
    const v0 = laneSpeed(p) * c.vf[v];
    const gapF = lead >= 0 ? c.s[lead] - c.len[lead] - c.s[v] : 1e9;
    const gapB = follow >= 0 ? c.s[v] - c.len[v] - c.s[follow] : 1e9;
    if (gapF < 2 || gapB < 3) return false;
    // segurança: o novo seguidor não freia forte
    const am = c.kind[v] ? A_HEAVY : A_MAX;
    if (follow >= 0 && this.idm(c.v[follow], v0, gapB, c.v[v], c.kind[follow] ? A_HEAVY : A_MAX) < -3.5) return false;
    const aNew = this.idm(c.v[v], v0, gapF, lead >= 0 ? c.v[lead] : 99, am);
    const oldLead = c.prev[v];
    const aOld = oldLead >= 0 ? this.idm(c.v[v], v0, c.s[oldLead] - c.len[oldLead] - c.s[v], c.v[oldLead], am) : am;
    return aNew - aOld + bias > 0.25;
  }

  private doChange(v: number, from: number, to: number): void {
    const c = this.veh.cols;
    this.unlink(v);
    this.setLaneCount(from, -1);
    this.setLaneCount(to, 1);
    c.lane[v] = to;
    c.lcFrom[v] = from;
    c.lcT[v] = 0;
    c.lcCool[v] = 3;
    this.insert(v, false, to);
  }

  /**
   * Parado no fim de uma faixa sem saída nenhuma: vai para a faixa vizinha que tem saída (a rota é refeita
   * depois do cruzamento). Parado há 5 s na linha, troca com qualquer espaço físico (o vizinho espera).
   */
  private escapeLane(v: number, lane: number): void {
    const c = this.veh.cols, sim = this.sim;
    if (c.lcCool[v] > 0) return;
    const seg = laneSeg(lane), dir = laneDir(lane), n = laneCount(sim.net.segs.cols.profile[seg], dir);
    for (const step of [1, -1]) {
      const i = laneIdx(lane) + step;
      if (i < 0 || i >= n) continue;
      const adj = laneId(seg, dir, i);
      if (sim.laneConn[adj] < 0 || (c.line[v] < 0 && sim.isBusLane(adj))) continue;
      if (this.canChange(v, adj, 2) || (c.wait[v] > 5 && this.roomBeside(v, adj))) { this.doChange(v, lane, adj); return; }
    }
    c.lcCool[v] = 0.5;
  }

  /** Cabe fisicamente ao lado, e quem vem atrás ainda para (freando forte) antes de encostar. */
  private roomBeside(v: number, target: number): boolean {
    const c = this.veh.cols;
    const [lead, follow] = this.around(target, c.s[v]);
    if (lead >= 0 && c.s[lead] - c.len[lead] - c.s[v] < 0.5) return false;
    return follow < 0 || c.s[v] - c.len[v] - c.s[follow] > 0.5 + (c.v[follow] * c.v[follow]) / (2 * 6);
  }

  private mandatoryChange(v: number, lane: number, ns: number): void {
    const c = this.veh.cols, sim = this.sim;
    if (c.lcCool[v] > 0) return;
    const seg = laneSeg(lane), dir = laneDir(lane);
    const target = sim.laneToward(seg, dir, ns, laneIdx(lane), c.line[v] >= 0);
    if (target < 0 || target === lane) return;
    const step = laneIdx(target) > laneIdx(lane) ? 1 : -1;
    const adj = laneId(seg, dir, laneIdx(lane) + step);
    // parado há 5 s na linha esperando a troca: entra com qualquer espaço físico (o vizinho espera)
    if (this.canChange(v, adj, 2) || (c.wait[v] > 5 && c.v[v] < 0.5 && this.roomBeside(v, adj))) this.doChange(v, lane, adj);
    else c.lcCool[v] = 0.5;
  }

  private discretionaryChange(v: number, lane: number): void {
    const c = this.veh.cols, sim = this.sim;
    c.lcCool[v] = 1 + this.rng.next();
    const seg = laneSeg(lane), dir = laneDir(lane);
    const n = laneCount(sim.net.segs.cols.profile[seg], dir);
    if (n < 2) return;
    const ns = this.nextSeg(v);
    const L = sim.laneLen(lane);
    if (L - c.s[v] < 60) return; // perto do nó: fica na faixa
    for (const step of [-1, 1]) {
      const i = laneIdx(lane) + step;
      if (i < 0 || i >= n) continue;
      const target = laneId(seg, dir, i);
      if (ns >= 0 && sim.connToward(target, ns) < 0) continue;
      if (c.line[v] < 0 && sim.isBusLane(target)) continue; // carro não entra na faixa de ônibus
      // à direita tem um pouco de preferência (manter a direita)
      if (this.canChange(v, target, step < 0 ? 0.1 : -0.1)) { this.doChange(v, lane, target); return; }
    }
  }

  // ------------------------------------------------------------ ônibus

  /** Troca o conjunto de linhas. Ônibus de linhas que mudaram saem; os novos nascem nas paradas. */
  setLines(specs: LineSpec[]): void {
    const c = this.veh.cols, net = this.sim.net, sc = net.segs.cols;
    // tira os ônibus atuais (só os das listas das linhas)
    for (const set of this.busSets) {
      for (const v of [...set]) {
        if (!this.veh.alive[v]) continue;
        if (c.micro[v]) { set.delete(v); c.dying[v] = 1; c.line[v] = -1; } else this.despawn(v);
      }
    }
    this.lines = specs.map((sp) => {
      const rail = (sp.mode ?? 0) > 0;
      const ln: SimLine = { id: sp.id, color: sp.color, buses: sp.buses, mode: sp.mode ?? 0, stopLane: [], stopV: [], waiting: [], lastT: [],
        stopX: [], stopZ: [], stopY: [], stopYaw: [], waitTo: [], boardings: 0, perHour: 0, term: new Set<number>() };
      for (let i = 0; i + 1 < sp.stops.length; i += 2) {
        const x = sp.stops[i], z = sp.stops[i + 1];
        // ônibus: via comum mais perto; trem e metrô: trilho mais perto
        const hit = net.nearestSeg(x, z, 40, (sg) => PROFILE_INFO[sc.profile[sg]].rail === rail);
        if (!hit) continue;
        const [seg, t] = hit;
        const q = net.quad(seg);
        const pp = new Float64Array(2), dd = new Float64Array(2);
        bez(q, t, pp); bezD(q, t, dd);
        // lado: u+ (esquerda de a→b) é a calçada de quem anda de b para a
        const u = (x - pp[0]) * dd[1] - (z - pp[1]) * dd[0];
        let dir = u > 0 ? -1 : 1;
        if (rail) {
          // estação: a linha segue para a próxima estação pelo trilho do sentido dela
          const ni = (i + 2) % sp.stops.length, nx = sp.stops[ni] - x, nz = sp.stops[ni + 1] - z;
          dir = nx * dd[0] + nz * dd[1] >= 0 ? 1 : -1;
        }
        if (laneCount(sc.profile[seg], dir) === 0) dir = -dir;
        if (laneCount(sc.profile[seg], dir) === 0) continue;
        const lane = laneId(seg, dir, 0);
        const L = this.sim.laneLen(lane);
        const along = this.sim.sAlong(seg, t);
        const v = dir > 0 ? along - this.sim.segS0(seg) : this.sim.segS1(seg) - along;
        if (sp.term?.includes(i / 2)) ln.term.add(ln.stopLane.length);
        ln.stopLane.push(lane);
        ln.stopV.push(Math.max(Math.min(8, L * 0.4), Math.min(L - 14, v)));
        ln.waiting.push(0); ln.lastT.push(this.time);
        const lp = new Float64Array(4);
        this.sim.lanePoint(lane, ln.stopV[ln.stopV.length - 1], lp);
        ln.stopX.push(x); ln.stopZ.push(z); ln.stopY.push(lp[1] + 0.15);
        ln.stopYaw.push(Math.atan2(lp[0] - x, lp[2] - z)); // olhando para a via
      }
      ln.waitTo = ln.stopLane.map(() => new Float64Array(ln.stopLane.length));
      return ln;
    });
    this.busSets = this.lines.map(() => new Set<number>());
    this.riders.clear();
    this.keepBuses();
  }

  /** Mantém o número de ônibus de cada linha (os que sumiram renascem numa parada). */
  private keepBuses(): void {
    if (this.lines.length === 0) return;
    const c = this.veh.cols;
    this.lines.forEach((ln, i) => {
      const n = ln.stopLane.length;
      if (n < 2) return;
      let have = 0;
      for (const v of this.busSets[i]) if (!c.dying[v]) have++;
      for (let k = have; k < ln.buses; k++) this.spawnBus(i, Math.floor((k * n) / Math.max(1, ln.buses)) % n);
    });
  }

  private spawnBus(li: number, stop: number): void {
    const ln = this.lines[li], sim = this.sim;
    const lane = ln.stopLane[stop];
    if (!sim.net.segs.alive[laneSeg(lane)]) return;
    const v = this.veh.alloc();
    this.initVehicle(v);
    const c = this.veh.cols;
    const train = ln.mode > 0;
    c.kind[v] = train ? 4 : 1; c.len[v] = KIND_LEN[train ? 4 : 1]; c.vf[v] = train ? 1 : 0.9;
    c.color[v] = ln.color & 15;
    c.line[v] = li; c.stopI[v] = stop; c.served[v] = 0;
    this.busSets[li].add(v);
    const o = v * ROUTE_CAP;
    this.routes[o] = sim.laneFrom(lane); this.routes[o + 1] = sim.laneTo(lane);
    c.rLen[v] = 2; c.rIdx[v] = 1; c.dest[v] = sim.laneTo(lane);
    c.lane[v] = lane; c.conn[v] = -1;
    c.s[v] = this.rng.next() * Math.max(0, ln.stopV[stop] - 6);
    this.setLaneCount(lane, 1);
    this.mesoEnter(v, lane, true);
  }

  /** Atende a parada: desce e sobe gente; o próximo trecho vai até a parada seguinte. */
  /** Demanda de fundo que chegou desde a última vez, espalhada pelos destinos. */
  private accrue(ln: SimLine, i: number): void {
    const n = ln.stopLane.length;
    const room = Math.max(0, 120 - ln.waiting[i]);
    const add = Math.min(room, (this.time - ln.lastT[i]) * WAIT_RATE);
    ln.lastT[i] = this.time;
    if (add <= 0 || n < 2) return;
    for (let j = 0; j < n; j++) if (j !== i) ln.waitTo[i][j] += add / (n - 1);
    ln.waiting[i] += add;
  }

  /** Um pedestre chegou na parada `from` querendo ir até `to`. */
  pedAtStop(li: number, from: number, to: number): void {
    const ln = this.lines[li];
    if (!ln || from >= ln.waitTo.length || to >= ln.waitTo.length) return;
    this.accrue(ln, from);
    ln.waitTo[from][to] += 1;
    ln.waiting[from] += 1;
  }

  /** Para os pedestres: uma viagem de ônibus ao acaso (linha, parada de embarque, de descida, nó do embarque). */
  pickTrip(): [number, number, number, number] | null {
    if (this.lines.length === 0) return null;
    const li = this.rng.int(0, this.lines.length);
    const ln = this.lines[li];
    const n = ln.stopLane.length;
    if (n < 2 || this.busSets[li].size === 0 || ln.mode) return null;
    const a = this.rng.int(0, n);
    let b = this.rng.int(0, n - 1);
    if (b >= a) b++;
    return [li, a, b, this.sim.laneFrom(ln.stopLane[a])];
  }

  private serve(v: number): void {
    const c = this.veh.cols, ln = this.lines[c.line[v]];
    const i = c.stopI[v];
    const n = ln.stopLane.length;
    this.accrue(ln, i);
    let r = this.riders.get(v);
    if (!r || r.length !== n) { r = new Float64Array(n); this.riders.set(v, r); }
    // descem os que vão para esta parada (e continuam a pé)
    const off = r[i];
    r[i] = 0;
    if (off >= 0.5 && !ln.mode) this.onAlight(this.sim.laneTo(c.lane[v]), Math.round(off)); // do trem a pessoa sai pela estação (sem calçada no trilho)
    let load = 0;
    for (let j = 0; j < n; j++) load += r[j];
    // sobem os que esperam, até lotar
    const room = Math.max(0, (ln.mode ? 600 : BUS_CAP) - load);
    const take = Math.min(Math.floor(ln.waiting[i]), room);
    if (take > 0 && ln.waiting[i] > 0) {
      const f = take / ln.waiting[i];
      for (let j = 0; j < n; j++) { const m = ln.waitTo[i][j] * f; r[j] += m; ln.waitTo[i][j] -= m; }
      ln.waiting[i] -= take;
    }
    c.load[v] = Math.min(255, Math.round(load + take));
    const on = take;
    ln.boardings += on;
    c.stopI[v] = (i + 1) % ln.stopLane.length;
    this.busPlan(v, this.sim.laneTo(c.lane[v]));
  }

  /** Rota do nó `from` até a parada atual: chega pela faixa da parada (no sentido certo). */
  private busPlan(v: number, from: number): void {
    const c = this.veh.cols, sim = this.sim, ln = this.lines[c.line[v]];
    if (!ln) { c.line[v] = -1; c.dying[v] = 1; return; }  // (linha sumiu: o conjunto já foi trocado)
    const target = ln.stopLane[c.stopI[v]];
    if (!sim.net.segs.alive[laneSeg(target)]) { c.dying[v] = 1; return; }
    const a = sim.laneFrom(target), b = sim.laneTo(target);
    const o = v * ROUTE_CAP;
    let n: number;
    if (from === a) { this.routes[o] = a; n = 1; }
    else {
      const ban = c.lane[v] >= 0 && sim.laneTo(c.lane[v]) === from ? laneSeg(c.lane[v]) : -1;
      const rail = ln.mode > 0;
      n = this.router.route(from, a, this.routes, o, ROUTE_CAP - 1, false, ban, rail);
      if (n < 2 && ban >= 0) n = this.router.route(from, a, this.routes, o, ROUTE_CAP - 1, false, -1, rail); // beco: retorna
      if (n < 2) { c.dying[v] = 1; return; }
      if (this.routes[o + n - 1] !== a) { c.rLen[v] = n; c.rIdx[v] = 0; c.dest[v] = a; return; } // rota truncada: segue e replaneja no fim
    }
    this.routes[o + n] = b;
    c.rLen[v] = n + 1; c.rIdx[v] = 0; c.dest[v] = b;
  }

  /** Quem espera nas paradas perto da câmera (pessoas paradas, até 14 por parada). */
  writeStopPeople(data: Float32Array, stride: number, start: number, max: number): number {
    let n = 0;
    for (const ln of this.lines) {
      for (let i = 0; i < ln.stopX.length; i++) {
        const x = ln.stopX[i], z = ln.stopZ[i];
        if (Math.abs(x - this.camX) > 600 || Math.abs(z - this.camZ) > 600) continue;
        const w = Math.min(14, Math.floor(Math.min(120, ln.waiting[i] + (this.time - ln.lastT[i]) * WAIT_RATE)));
        const yaw = ln.stopYaw[i];
        const ax = Math.cos(yaw), az = -Math.sin(yaw); // ao longo da calçada
        for (let k = 0; k < w && start + n < max; k++) {
          const h = ((i * 7 + k * 13 + ln.id * 31) % 97) / 97;
          const along = (k - w / 2) * 0.75 + (h - 0.5) * 0.4;
          const back = -0.6 + ((k * 5) % 3) * 0.45;
          const px = x + ax * along + Math.sin(yaw) * back, pz = z + az * along + Math.cos(yaw) * back;
          const o = (start + n) * stride;
          const fy = yaw + (h - 0.5) * 0.9;
          data[o] = px; data[o + 1] = ln.stopY[i]; data[o + 2] = pz; data[o + 3] = fy;
          data[o + 4] = px; data[o + 5] = ln.stopY[i]; data[o + 6] = pz; data[o + 7] = fy;
          data[o + 8] = 3 * 256 + ((k * 5 + i) % 16);
          data[o + 9] = 1;
          n++;
        }
      }
    }
    return n;
  }

  /** Números das linhas para a interface (passageiros por hora). */
  lineStats(dtReport: number): Array<{ id: number; buses: number; perHour: number; waiting: number }> {
    return this.lines.map((ln, i) => {
      const have = this.busSets[i].size;
      const rate = ln.boardings / Math.max(1e-3, dtReport) * 3600;
      ln.perHour = ln.perHour === 0 ? rate : ln.perHour * 0.9 + rate * 0.1;
      ln.boardings = 0;
      let w = 0;
      for (let k = 0; k < ln.waiting.length; k++) w += Math.min(120, ln.waiting[k] + (this.time - ln.lastT[k]) * WAIT_RATE);
      return { id: ln.id, buses: have, perHour: Math.round(ln.perHour), waiting: Math.round(w) };
    });
  }

  // ------------------------------------------------------------ janela

  /** A câmera andou: quem ficou longe vira meso; semáforos da janela. */
  checkWindow(): void {
    const c = this.veh.cols, sim = this.sim;
    const old = this.windowSignals;
    this.windowSignals = new Set<number>();
    const r = this.window + WINDOW_OUT - WINDOW;
    sim.net.nodeIndex.query(this.camX - r, this.camZ - r, this.camX + r, this.camZ + r, (n) => {
      if (sim.nodePhases[n] > 0 && this.signalNodes.has(n)) this.windowSignals.add(n);
    });
    // quem saiu da janela volta a "desconhecido" no desenho
    if (this.signals) for (const n of old) if (!this.windowSignals.has(n) && n < this.signals.length) this.signals[n] = 0;
    for (let i = this.microN - 1; i >= 0; i--) {
      const v = this.micro[i];
      if (c.conn[v] >= 0 || c.dying[v] === 2) continue;
      const lane = c.lane[v];
      if (this.inWindowOut(lane)) continue;
      this.unlink(v);
      this.removeMicro(v);
      this.mesoEnter(v, lane, true);
    }
  }

  // ------------------------------------------------------------ passo

  step(dt: number): void {
    this.time += dt;
    this.measureRegions();
    this.routeBudget = ROUTE_BUDGET;
    this.advisor.step(this.time);
    const target = Math.min(MAX_VEHICLES, Math.floor(this.sim.laneMeters * this.density * this.dayFactor() * this.demand * this.trafficShare * this.gov));
    // repõe quem chegou e cresce no ritmo de FLEET_TAU (o mapa abrindo enche de uma vez)
    const have = this.veh.size;
    if (have < target * FILL_SHARE) this.spawnCredit = target - have;
    else this.spawnCredit = Math.min(this.spawnCredit + Math.max(0, target - have) * dt / FLEET_TAU, Math.max(0, target - have));
    // (cada tentativa é uma busca de rota: poucas falhas por passo, o resto tenta no seguinte)
    for (let k = 0, fails = 0; k < 60 && fails < 8 && this.veh.size < target && (this.veh.size < this.fleetFloor || this.spawnCredit >= 1); k++) {
      const before = this.veh.size;
      this.spawn();
      if (this.veh.size === before) fails++;
      else if (this.veh.size > this.fleetFloor) this.spawnCredit--;
    }
    this.fleetFloor = Math.min(this.veh.size, target);
    this.lineCheck -= dt;
    if (this.lineCheck <= 0) { this.lineCheck = 2; this.keepBuses(); }
    this.updateSignals(dt);
    this.processMeso();
    this.mvs.beginStep();
    this.stepMicro(dt);
    this.stepManoeuvres(dt);
    this.stepParkers(dt);
  }

  /** Vagões do trem: uma pose por vagão, seguindo o trilho para trás (anterior guardada por vagão). */
  private wagonPrev = new Map<number, Float32Array>();
  private writeTrain(v: number, data: Float32Array, stride: number, n: number, p: Float64Array): number {
    const c = this.veh.cols;
    let prev = this.wagonPrev.get(v);
    const first = !prev;
    if (!prev) { prev = new Float32Array(WAGONS * 4); this.wagonPrev.set(v, prev); }
    for (let k = 0; k < WAGONS; k++) {
      backAlong(this.sim, c.lane[v], c.conn[v], c.s[v], WAGON_LEN * (k + 0.5), p);
      // rumo pela linha entre as pontas do vagão (curvas)
      const fx = p[0], fz = p[2];
      backAlong(this.sim, c.lane[v], c.conn[v], c.s[v], WAGON_LEN * k + 1, this.tmp2);
      const yaw = Math.atan2(this.tmp2[0] - fx, this.tmp2[2] - fz);
      const o = n * stride, q = k * 4;
      if (first) { prev[q] = fx; prev[q + 1] = p[1]; prev[q + 2] = fz; prev[q + 3] = yaw; }
      data[o] = prev[q]; data[o + 1] = prev[q + 1]; data[o + 2] = prev[q + 2]; data[o + 3] = prev[q + 3];
      data[o + 4] = fx; data[o + 5] = p[1]; data[o + 6] = fz; data[o + 7] = yaw;
      data[o + 8] = 4 * 256 + c.color[v] + (k === 0 ? 128 : 0);
      data[o + 9] = Math.max(0, Math.min(1, c.fade[v]));
      prev[q] = fx; prev[q + 1] = p[1]; prev[q + 2] = fz; prev[q + 3] = yaw;
      n++;
    }
    return n;
  }

  /** Escreve as poses dos micro (anterior e atual). */
  private turnTmp = new Float64Array(4);
  /**
   * Luzes do veículo: freio, e a seta da conversão (dentro do cruzamento, ou a 45 m dele com a saída já
   * escolhida) ou da troca de faixa (`lights` já trazido). Esquerda = o rumo cresce ao longo da conexão.
   */
  private lightBits(v: number, lights: number): number {
    const c = this.veh.cols, sim = this.sim;
    if (c.brk[v]) lights |= LIGHT_BRAKE;
    if (lights & (LIGHT_LEFT | LIGHT_RIGHT)) return lights;
    let conn = c.conn[v];
    if (conn < 0 && c.lane[v] >= 0 && sim.laneLen(c.lane[v]) - c.s[v] < 45) conn = c.exitC[v];
    if (conn < 0 || !sim.conns.alive[conn]) return lights;
    const t = this.turnTmp;
    sim.connPoint(conn, 0, t); const y0 = t[3];
    sim.connPoint(conn, sim.conns.cols.len[conn], t);
    let d = t[3] - y0;
    d = ((d + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    if (d > 0.35) lights |= LIGHT_LEFT; else if (d < -0.35) lights |= LIGHT_RIGHT;
    return lights;
  }

  writePoses(data: Float32Array, stride: number): number {
    const c = this.veh.cols, sim = this.sim, p = this.tmp, q = this.tmp2;
    let n = 0;
    for (let i = 0; i < this.microN; i++) {
      const v = this.micro[i];
      let lights = 0;
      if (c.conn[v] >= 0) sim.connPoint(c.conn[v], c.s[v], p);
      else {
        const lane = c.lane[v];
        const L = sim.laneLen(lane);
        sim.lanePoint(lane, Math.min(L, c.s[v]), p);
        // troca de faixa suave: mistura com a faixa de origem
        if (c.lcT[v] < 1 && c.lcFrom[v] >= 0 && sim.net.segs.alive[laneSeg(c.lcFrom[v])]) {
          sim.lanePoint(c.lcFrom[v], Math.min(L, c.s[v]), q);
          // seta da troca de faixa: para o lado da faixa nova (direita do motorista = (−cos, sen) do rumo)
          if (c.lcT[v] < 0.8) lights |= -Math.cos(p[3]) * (p[0] - q[0]) + Math.sin(p[3]) * (p[2] - q[2]) > 0 ? LIGHT_RIGHT : LIGHT_LEFT;
          const t = c.lcT[v], k = 1 - t * t * (3 - 2 * t);
          p[0] += (q[0] - p[0]) * k; p[2] += (q[2] - p[2]) * k;
        }
      }
      if (c.kind[v] === 4) { n = this.writeTrain(v, data, stride, n, p); continue; }
      let centred = false;
      if (c.mv[v] >= 0) {
        // on a manoeuvre: the pose is the vehicle centre on the Reeds-Shepp path; signal towards where it goes
        const mp = this.mvA;
        this.mvs.pose(c.mv[v], mp);
        p[0] = mp[0]; p[2] = mp[1]; p[3] = mp[2];
        centred = true;
        lights |= this.mvs.t.cols.kind[c.mv[v]] === MKind.Unpark ? LIGHT_LEFT : LIGHT_RIGHT;
      } else if (c.dying[v] === 4 && c.conn[v] < 0) {
        // at the kerb: 0.9 m to the right, hazard lights while stopped
        const k = c.pk[v] * c.pk[v] * (3 - 2 * c.pk[v]);
        p[0] -= Math.cos(p[3]) * 0.9 * k; p[2] += Math.sin(p[3]) * 0.9 * k;
        if (c.v[v] < 0.1 && ((this.time * 1.5) % 1) < 0.5) lights |= LIGHT_LEFT | LIGHT_RIGHT;
      }
      // na vaga ou a caminho dela (deslocamento em u, no sentido do trecho): entrando, seta da direita; saindo, da esquerda
      if (!centred && c.dying[v] !== 4 && c.pk[v] > 0 && c.conn[v] < 0) {
        const lane = c.lane[v], dir = laneDir(lane);
        const du = (parkU(sim.net.segs.cols.profile[laneSeg(lane)], dir) - sim.laneU(lane)) * dir;
        const k = c.pk[v] * c.pk[v] * (3 - 2 * c.pk[v]);
        if (!Number.isNaN(du)) { p[0] += Math.cos(p[3]) * du * k; p[2] -= Math.sin(p[3]) * du * k; }
        if (c.dying[v] === 2 ? c.pk[v] < 1 : c.dwell[v] > 0.4) lights |= c.dying[v] === 2 ? LIGHT_RIGHT : LIGHT_LEFT;
      }
      // ponto de referência no meio do veículo
      const back = centred ? 0 : c.len[v] / 2;
      p[0] -= Math.sin(p[3]) * back; p[2] -= Math.cos(p[3]) * back;
      const o = n * stride;
      if (!c.has[v]) { c.px[v] = p[0]; c.py[v] = p[1]; c.pz[v] = p[2]; c.pyaw[v] = p[3]; c.has[v] = 1; }
      data[o] = c.px[v]; data[o + 1] = c.py[v]; data[o + 2] = c.pz[v]; data[o + 3] = c.pyaw[v];
      data[o + 4] = p[0]; data[o + 5] = p[1]; data[o + 6] = p[2]; data[o + 7] = p[3];
      // ocupantes (roadcraft occupants): carro e caminhão com o motorista; ônibus pela lotação (0-7)
      const seats = c.kind[v] === 1 ? Math.min(7, Math.ceil(c.load[v] / BUS_CAP * 7)) : c.kind[v] === 3 ? 0 : 1;
      data[o + 8] = c.kind[v] * 256 + c.color[v] + (this.lightBits(v, lights) + seats * 8) * 65536;
      data[o + 9] = Math.max(0, Math.min(1, c.fade[v]));
      c.px[v] = p[0]; c.py[v] = p[1]; c.pz[v] = p[2]; c.pyaw[v] = p[3];
      n++;
    }
    return n;
  }
}

/** Ponto a `d` metros atrás da frente do veículo (passa para a faixa anterior pela reta, se faltar). */
function backAlong(sim: SimNet, lane: number, conn: number, s: number, d: number, out: Float64Array): void {
  if (conn >= 0) {
    if (s - d >= 0) { sim.connPoint(conn, s - d, out); return; }
    const from = sim.conns.cols.from[conn];
    lane = from; s = sim.laneLen(from) + (s - d); d = 0;
  } else s -= d;
  if (s >= 0) { sim.lanePoint(lane, s, out); return; }
  sim.lanePoint(lane, 0, out);
  out[0] += Math.sin(out[3]) * s; out[2] += Math.cos(out[3]) * s;
}

function grow<T extends Int32Array | Uint32Array | Float32Array | Float64Array | Uint16Array | Uint8Array>(a: T, cap: number, fill: number): T {
  if (cap <= a.length) return a;
  const b = new (a.constructor as new (n: number) => T)(cap);
  b.fill(fill);
  b.set(a);
  return b;
}

// Controle de cruzamento: o que o jogador escolheu (ou o automático pela
// importância das vias e, depois de medir, pelo fluxo) e a regra de cada braço. A mesma conta roda na
// página (pintura, placas, painel) e no worker de simulação (quem passa primeiro).

import { PROFILE_INFO } from './profiles.ts';
import { SegFlag } from './flags.ts';
import type { RoadNetwork } from './network.ts';

/** Tipo de controle. Auto escolhe pela importância das vias. */
export const Ctl = { Auto: 0, Signal: 1, Priority: 2, AllStop: 3, YieldAll: 4, Mini: 5, None: 6, Ring: 7, Crossing: 8, Zebra: 9, PedSignal: 10, UTurn: 11 } as const;
/** Faixa de pedestres no meio da quadra (nó de duas vias). */
export const isMidCrossing = (ctl: number) => ctl === Ctl.Zebra || ctl === Ctl.PedSignal;
/** Controle especial de um nó de duas vias (faixa de pedestres ou retorno no canteiro). */
export const isMidNode = (ctl: number) => isMidCrossing(ctl) || ctl === Ctl.UTurn;
export const CTL_NAMES = ['Automático', 'Semáforo', 'Placas (via principal)', 'Pare em todas', 'Preferência em todas', 'Minirrotatória', 'Sem sinalização', 'Rotatória', 'Passagem de nível', 'Faixa zebra', 'Faixa com semáforo', 'Retorno'];
/** Regra de um braço: Free = sem placa (preferência de quem vem pela direita). */
export const Rule = { Free: 0, Main: 1, Yield: 2, Stop: 3, Signal: 4 } as const;
export const RULE_NAMES = ['Sem placa', 'Preferencial', 'Dê a preferência', 'Pare', 'Semáforo'];

export interface JunctionSpec {
  ctl: number;
  /** Semáforo de tempo fixo (senão adaptativo pela fila). */
  fixed?: boolean;
  /** Verde de cada fase (s), no modo fixo. */
  greens?: number[];
  /** Defasagem do ciclo (s), para a onda verde. */
  offset?: number;
  /** Prioridade ao ônibus (adaptativo encurta o verde dos outros). */
  bus?: boolean;
  /** Regra escolhida à mão por braço: [trecho, regra]. */
  legs?: Array<[number, number]>;
  /** Movimentos proibidos: pares [trecho de chegada, trecho de saída]. */
  bans?: number[];
  /** Conexões de faixa à mão: [trecho de chegada, faixa (0 = a da direita), trechos de saída]. */
  lanes?: Array<[number, number, number[]]>;
}

export interface Control { ctl: number; /** regra por trecho ligado ao nó */ legs: Map<number, number>; auto: boolean }

const tmpSegs: number[] = [];

/** O que o fluxo medido pede num cruzamento no automático (roadcraft controlAdvisor). */
export const Flow = { None: 0, Signal: 1, Signs: 2 } as const;

/** Limiares do fluxo (veíc./h por braço que chega): via principal (soma dos dois braços dela) e secundárias. */
export const FLOW = { stopMajor: 300, stopMinor: 200, signalMajor: 500, signalMinor: 150, signalMajorB: 750, signalMinorB: 75, stepDown: 0.8 } as const;

/**
 * Controle que o fluxo pede, com histerese: para manter o que já tem basta 80% do limiar
 * ('stop' = placas com pare; quem decide as placas aqui é a importância das vias, então só o semáforo troca).
 */
export function warrantedControl(major: number, minorMax: number, minorTotal: number, current: 'signal' | 'stop' | 'priority'): 'signal' | 'stop' | 'priority' {
  const rank = (c: string) => (c === 'signal' ? 2 : c === 'stop' ? 1 : 0);
  const k = (step: 'signal' | 'stop') => (rank(current) >= rank(step) ? FLOW.stepDown : 1);
  const signal = (major >= FLOW.signalMajor * k('signal') && minorMax >= FLOW.signalMinor * k('signal')) ||
    (major >= FLOW.signalMajorB * k('signal') && minorMax >= FLOW.signalMinorB * k('signal'));
  if (signal) return 'signal';
  return major >= FLOW.stopMajor * k('stop') && minorTotal >= FLOW.stopMinor * k('stop') ? 'stop' : 'priority';
}

/** Os dois braços da via principal do nó (os mais importantes; empate: os mais opostos). */
export function mainLegs(net: RoadNetwork, n: number): number[] {
  const sc = net.segs.cols;
  const segs = net.segsOf(n, tmpSegs).slice();
  if (segs.length < 3) return segs;
  const pr = (s: number) => PROFILE_INFO[sc.profile[s]].priority ?? 0;
  const sorted = segs.slice().sort((a, b) => pr(b) - pr(a));
  const top = segs.filter((s) => pr(s) === pr(sorted[0]));
  return top.length > 2 ? mostOpposite(net, n, top) : top.length === 2 ? top : [sorted[0], sorted[1]];
}

/**
 * Controle efetivo do nó `n` (com o automático resolvido). `flow`: o que o fluxo medido pede (Flow), só no
 * automático: Signal põe semáforo; Signs tira o semáforo que a importância das vias poria (fica com placas).
 */
export function effectiveControl(net: RoadNetwork, n: number, spec = net.junctions.get(n), flow: number = Flow.None): Control {
  const sc = net.segs.cols;
  const segs = net.segsOf(n, tmpSegs).slice();
  const legs = new Map<number, number>();
  if (segs.length === 2 && spec && spec.ctl === Ctl.UTurn) {
    for (const s of segs) legs.set(s, Rule.Free);
    return { ctl: Ctl.UTurn, legs, auto: false };
  }
  if (segs.length === 2 && spec && isMidCrossing(spec.ctl)) {
    // faixa no meio da quadra: zebra (carro dá a vez a quem atravessa) ou com semáforo
    for (const s of segs) legs.set(s, spec.ctl === Ctl.PedSignal ? Rule.Signal : Rule.Free);
    return { ctl: spec.ctl, legs, auto: false };
  }
  if (segs.length < 3) { for (const s of segs) legs.set(s, Rule.Free); return { ctl: Ctl.None, legs, auto: true }; }
  if (segs.some((s) => (sc.flags[s] & SegFlag.Ring) !== 0)) {
    for (const s of segs) legs.set(s, (sc.flags[s] & SegFlag.Ring) ? Rule.Main : Rule.Yield);
    return { ctl: Ctl.Ring, legs, auto: true };
  }
  // trilhos: passagem de nível (o trem sempre passa; quem vem pela rua para) ou só trilhos (agulhas)
  const rails = segs.filter((s) => PROFILE_INFO[sc.profile[s]].rail).length;
  if (rails > 0) {
    for (const s of segs) legs.set(s, rails === segs.length ? Rule.Free : PROFILE_INFO[sc.profile[s]].rail ? Rule.Main : Rule.Stop);
    return { ctl: rails === segs.length ? Ctl.None : Ctl.Crossing, legs, auto: true };
  }
  const pr = (s: number) => PROFILE_INFO[sc.profile[s]].priority ?? 0;
  let ctl = spec?.ctl ?? Ctl.Auto;
  const auto = ctl === Ctl.Auto;
  const sorted = segs.slice().sort((a, b) => pr(b) - pr(a));
  const p1 = pr(sorted[0]);
  if (auto) {
    // arteriais (preferência 2+) que se cruzam: semáforo; uma via mais importante: placas; todas iguais: sem placa
    const majors = segs.filter((s) => pr(s) >= 2);
    // 5 braços ou mais: semáforo (com placas o cruzamento grande escoa pouco e trava no pico)
    if (segs.length >= 5 || majors.length >= 3 || (majors.length === 2 && !throughPair(net, n, majors[0], majors[1]))) ctl = Ctl.Signal;
    else if (p1 > pr(sorted[sorted.length - 1])) ctl = Ctl.Priority;
    else ctl = Ctl.None;
    // o fluxo medido manda: semáforo onde passa muita gente; sem ele onde quase ninguém passa
    if (flow === Flow.Signal) ctl = Ctl.Signal;
    else if (flow === Flow.Signs && ctl === Ctl.Signal && segs.length < 5) ctl = Ctl.Priority;
  }
  switch (ctl) {
    case Ctl.Signal: for (const s of segs) legs.set(s, Rule.Signal); break;
    case Ctl.AllStop: for (const s of segs) legs.set(s, Rule.Stop); break;
    case Ctl.YieldAll: case Ctl.Mini: case Ctl.None: for (const s of segs) legs.set(s, Rule.Free); break;
    case Ctl.Priority: {
      // principal: as duas mais importantes (as mais opostas, se empatar mais de duas)
      const top = segs.filter((s) => pr(s) === p1);
      let main = top.length >= 2 ? top.slice(0, 2) : [sorted[0], sorted[1]];
      if (top.length > 2) main = mostOpposite(net, n, top);
      const pm = Math.max(...main.map(pr));
      for (const s of segs) {
        if (main.includes(s)) legs.set(s, Rule.Main);
        else legs.set(s, pm - pr(s) >= 2 || pm >= 4 ? Rule.Stop : Rule.Yield);
      }
      break;
    }
  }
  // regras escolhidas à mão (só com placas)
  if (spec?.legs && (ctl === Ctl.Priority || ctl === Ctl.AllStop)) {
    for (const [s, r] of spec.legs) if (legs.has(s) && r >= Rule.Main && r <= Rule.Stop) legs.set(s, r);
  }
  return { ctl, legs, auto };
}

/** Os dois trechos são a mesma via passando reto pelo nó. */
function throughPair(net: RoadNetwork, n: number, a: number, b: number): boolean {
  const da = dirOut(net, n, a), db = dirOut(net, n, b);
  return da[0] * db[0] + da[1] * db[1] < -0.8;
}

function mostOpposite(net: RoadNetwork, n: number, segs: number[]): number[] {
  let best: number[] = [segs[0], segs[1]], bd = 2;
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const a = dirOut(net, n, segs[i]), b = dirOut(net, n, segs[j]);
    const d = a[0] * b[0] + a[1] * b[1];
    if (d < bd) { bd = d; best = [segs[i], segs[j]]; }
  }
  return best;
}

/** Direção de saída do trecho a partir do nó (pelo ponto de controle). */
export function dirOut(net: RoadNetwork, n: number, s: number): [number, number] {
  const sc = net.segs.cols, nc = net.nodes.cols;
  let dx = sc.cx[s] - nc.x[n], dz = sc.cz[s] - nc.z[n];
  if (Math.hypot(dx, dz) < 1e-6) { const o = sc.a[s] === n ? sc.b[s] : sc.a[s]; dx = nc.x[o] - nc.x[n]; dz = nc.z[o] - nc.z[n]; }
  const l = Math.hypot(dx, dz) || 1;
  return [dx / l, dz / l];
}

/** Movimento proibido? */
export function banned(spec: JunctionSpec | undefined, fromSeg: number, toSeg: number): boolean {
  const b = spec?.bans;
  if (!b) return false;
  for (let i = 0; i + 1 < b.length; i += 2) if (b[i] === fromSeg && b[i + 1] === toSeg) return true;
  return false;
}

/**
 * Fases do semáforo: braços quase opostos andam juntos (a mesma via nos dois
 * sentidos); os outros têm fase própria. Devolve a fase de cada braço (na ordem dada) e o total.
 */
export function signalStages(dirs: Array<[number, number]>, out: number[]): number {
  const n = dirs.length;
  out.length = n;
  out.fill(-1);
  let stages = 0;
  for (let i = 0; i < n; i++) {
    if (out[i] >= 0) continue;
    out[i] = stages;
    let best = -1, bd = -0.75;
    for (let j = i + 1; j < n; j++) {
      if (out[j] >= 0) continue;
      const d = dirs[i][0] * dirs[j][0] + dirs[i][1] * dirs[j][1];
      if (d < bd) { bd = d; best = j; }
    }
    if (best >= 0) out[best] = stages;
    stages++;
  }
  return stages;
}

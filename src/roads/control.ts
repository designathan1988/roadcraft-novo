// Junction control: what the player chose (or the automatic one, by the
// importance of the roads and, once measured, by the flow) and the rule of each arm. The same rule runs on the
// page (paint, signs, panel) and in the simulation worker (who goes first).

import { PROFILE_INFO } from './profiles.ts';
import { SegFlag } from './flags.ts';
import type { RoadNetwork } from './network.ts';

/** Control kind. Auto chooses by the importance of the roads. */
export const Ctl = { Auto: 0, Signal: 1, Priority: 2, AllStop: 3, YieldAll: 4, Mini: 5, None: 6, Ring: 7, Crossing: 8, Zebra: 9, PedSignal: 10, UTurn: 11 } as const;
/** Mid-block pedestrian crossing (a two-road node). */
export const isMidCrossing = (ctl: number) => ctl === Ctl.Zebra || ctl === Ctl.PedSignal;
/** Special control of a two-road node (pedestrian crossing or U-turn through the median). */
export const isMidNode = (ctl: number) => isMidCrossing(ctl) || ctl === Ctl.UTurn;
export const CTL_NAMES = ['Automático', 'Semáforo', 'Placas (via principal)', 'Pare em todas', 'Preferência em todas', 'Minirrotatória', 'Sem sinalização', 'Rotatória', 'Passagem de nível', 'Faixa zebra', 'Faixa com semáforo', 'Retorno'];
/** Rule of an arm: Free = no sign (priority to the right). */
export const Rule = { Free: 0, Main: 1, Yield: 2, Stop: 3, Signal: 4 } as const;
export const RULE_NAMES = ['Sem placa', 'Preferencial', 'Dê a preferência', 'Pare', 'Semáforo'];

export interface JunctionSpec {
  ctl: number;
  /** Fixed-time signal (otherwise adaptive to the queue). */
  fixed?: boolean;
  /** Green of each stage (s), in fixed mode. */
  greens?: number[];
  /** Cycle offset (s), for the green wave. */
  offset?: number;
  /** Bus priority (adaptive mode shortens the others' green). */
  bus?: boolean;
  /** Rule picked by hand per arm: [segment, rule]. */
  legs?: Array<[number, number]>;
  /** Banned movements: pairs [arriving segment, leaving segment]. */
  bans?: number[];
  /** Lane connections by hand: [arriving segment, lane (0 = the rightmost), leaving segments]. */
  lanes?: Array<[number, number, number[]]>;
}

export interface Control { ctl: number; /** rule per segment at the node */ legs: Map<number, number>; auto: boolean }

const tmpSegs: number[] = [];

/** What the measured flow asks for at an automatic junction (roadcraft controlAdvisor). */
export const Flow = { None: 0, Signal: 1, Signs: 2 } as const;

/** Flow thresholds (veh/h per arriving arm): main road (sum of its two arms) and side roads. */
export const FLOW = { stopMajor: 300, stopMinor: 200, signalMajor: 500, signalMinor: 150, signalMajorB: 750, signalMinorB: 75, stepDown: 0.8 } as const;

/**
 * Control the flow asks for, with hysteresis: keeping what is there needs only 80% of the threshold
 * ('stop' = signs with stop; the importance of the roads decides the signs here, so only the signal changes).
 */
export function warrantedControl(major: number, minorMax: number, minorTotal: number, current: 'signal' | 'stop' | 'priority'): 'signal' | 'stop' | 'priority' {
  const rank = (c: string) => (c === 'signal' ? 2 : c === 'stop' ? 1 : 0);
  const k = (step: 'signal' | 'stop') => (rank(current) >= rank(step) ? FLOW.stepDown : 1);
  const signal = (major >= FLOW.signalMajor * k('signal') && minorMax >= FLOW.signalMinor * k('signal')) ||
    (major >= FLOW.signalMajorB * k('signal') && minorMax >= FLOW.signalMinorB * k('signal'));
  if (signal) return 'signal';
  return major >= FLOW.stopMajor * k('stop') && minorTotal >= FLOW.stopMinor * k('stop') ? 'stop' : 'priority';
}

/** The two arms of the node's main road (the most important; on a tie, the most opposite). */
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
 * Effective control of node `n` (automatic resolved). `flow`: what the measured flow asks for (Flow), automatic
 * only: Signal puts a traffic light; Signs removes the light the importance of the roads would put (signs stay).
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
    // mid-block crossing: zebra (cars give way to walkers) or with a signal
    for (const s of segs) legs.set(s, spec.ctl === Ctl.PedSignal ? Rule.Signal : Rule.Free);
    return { ctl: spec.ctl, legs, auto: false };
  }
  if (segs.length < 3) { for (const s of segs) legs.set(s, Rule.Free); return { ctl: Ctl.None, legs, auto: true }; }
  if (segs.some((s) => (sc.flags[s] & SegFlag.Ring) !== 0)) {
    for (const s of segs) legs.set(s, (sc.flags[s] & SegFlag.Ring) ? Rule.Main : Rule.Yield);
    return { ctl: Ctl.Ring, legs, auto: true };
  }
  // rails: level crossing (the train always goes; the street stops) or rails only (switches)
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
    // arterials (priority 2+) crossing: signal; one road more important: signs; all equal: no sign
    const majors = segs.filter((s) => pr(s) >= 2);
    // 5 arms or more: signal (with signs a big junction drains little and jams at the peak)
    if (segs.length >= 5 || majors.length >= 3 || (majors.length === 2 && !throughPair(net, n, majors[0], majors[1]))) ctl = Ctl.Signal;
    else if (p1 > pr(sorted[sorted.length - 1])) ctl = Ctl.Priority;
    else ctl = Ctl.None;
    // the measured flow rules: a signal where many pass; none where almost nobody does
    if (flow === Flow.Signal) ctl = Ctl.Signal;
    else if (flow === Flow.Signs && ctl === Ctl.Signal && segs.length < 5) ctl = Ctl.Priority;
  }
  switch (ctl) {
    case Ctl.Signal: for (const s of segs) legs.set(s, Rule.Signal); break;
    case Ctl.AllStop: for (const s of segs) legs.set(s, Rule.Stop); break;
    case Ctl.YieldAll: case Ctl.Mini: case Ctl.None: for (const s of segs) legs.set(s, Rule.Free); break;
    case Ctl.Priority: {
      // main: the two most important (the most opposite, if more than two tie)
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
  // rules picked by hand (signs only)
  if (spec?.legs && (ctl === Ctl.Priority || ctl === Ctl.AllStop)) {
    for (const [s, r] of spec.legs) if (legs.has(s) && r >= Rule.Main && r <= Rule.Stop) legs.set(s, r);
  }
  return { ctl, legs, auto };
}

/** The two segments are the same road going straight through the node. */
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

/** Direction out of the node along the segment (by its control point). */
export function dirOut(net: RoadNetwork, n: number, s: number): [number, number] {
  const sc = net.segs.cols, nc = net.nodes.cols;
  let dx = sc.cx[s] - nc.x[n], dz = sc.cz[s] - nc.z[n];
  if (Math.hypot(dx, dz) < 1e-6) { const o = sc.a[s] === n ? sc.b[s] : sc.a[s]; dx = nc.x[o] - nc.x[n]; dz = nc.z[o] - nc.z[n]; }
  const l = Math.hypot(dx, dz) || 1;
  return [dx / l, dz / l];
}

/** Is the movement banned? */
export function banned(spec: JunctionSpec | undefined, fromSeg: number, toSeg: number): boolean {
  const b = spec?.bans;
  if (!b) return false;
  for (let i = 0; i + 1 < b.length; i += 2) if (b[i] === fromSeg && b[i + 1] === toSeg) return true;
  return false;
}

/**
 * Signal stages: nearly opposite arms go together (the same road both
 * ways); the others get their own stage. Returns each arm's stage (in the given order) and the count.
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

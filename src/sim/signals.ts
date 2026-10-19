// Traffic lights: one plan per signalled node, kept in arrays per node (nothing per frame or per step that grows with
// the map). A plan has up to 8 stages; each stage releases a set of arms (bit k = arm k of the node, the arms in the
// order of `SimNet.armStage`), lets pedestrians walk over the crossings of the arms whose traffic it stops, and has its
// own green, the ITE yellow of its fastest approach and an all-red clearance.
//
// Near the camera a light is actuated (roadcraft 4.0 `signals/fsm.ts`): a green lasts at least its minimum, ends when
// its own arms have nobody waiting and another stage has (gap-out) or at its target or maximum with others waiting
// (max-out), never while pedestrians it released are still crossing (bounded), and the next stage is the one waiting
// longest, a stage starved for 1.5 cycles first and a pedestrian waiting 45 s at the kerb next. Pedestrians call their
// stage by pressing the button when they reach the kerb.

import { Ctl } from '../roads/control.ts';
import { laneSpeed, type SimNet } from './lanes.ts';

/** Timings (s), from roadcraft 4.0 `params.ts`. */
export const SIGNAL = {
  minGreen: 6, baseGreen: 20, maxGreen: 34,
  /** Shortest and longest yellow (MUTCD: 3 to 6 s). */
  amber: 3.2, amberMax: 6,
  allRed: 1.2,
  /** A stage red with somebody waiting for this many cycles is served next. */
  starvationCycles: 1.5,
  /** A pedestrian waiting this long at the kerb is served next (after a starved stage). */
  pedWaitLimit: 45,
  /** Longest a green is held past its maximum for pedestrians still on its crossings. */
  pedHold: 30,
  /** Longest a green is held past its maximum for a bus about to reach the line. */
  busExtension: 10,
} as const;

/** Sub-phase of a stage. */
export const Sub = { Green: 0, Amber: 1, AllRed: 2 } as const;

/**
 * Yellow change interval from the approach speed limit (m/s), by the ITE kinematic formula Y = t + V / (2a): 1 s of
 * perception-reaction, 3.05 m/s² of comfortable braking, V = the 85th-percentile speed (limit + 3.13 m/s), clamped to
 * 3.2-6 s.
 */
export function iteAmber(limit: number): number {
  return Math.min(SIGNAL.amberMax, Math.max(SIGNAL.amber, 1 + (limit + 3.13) / (2 * 3.05)));
}

export class Signals {
  private readonly sim: SimNet;
  // ---------------- plan, per node
  /** Seconds of a full cycle at the target greens (and of the fixed-time cycle). */
  cycle = new Float32Array(1 << 14);
  /** Where the cycle starts on the common clock (s). */
  offset = new Float32Array(1 << 14);
  /** Fixed time chosen by the player: follows the clock, near the camera too (green wave). */
  fixed = new Uint8Array(1 << 14);
  /** Bus priority chosen by the player. */
  bus = new Uint8Array(1 << 14);
  // ---------------- plan, per node * 8 + stage
  /** Arms released (bit per arm). */
  arms = new Uint8Array((1 << 14) * 8);
  /** Crossings (by the arm they cross) where pedestrians may walk. */
  walk = new Uint8Array((1 << 14) * 8);
  /** Target green (the player's green at a fixed-time light). */
  green = new Float32Array((1 << 14) * 8);
  amber = new Float32Array((1 << 14) * 8);
  // ---------------- actuated state, per node
  phase = new Uint8Array(1 << 14);
  sub = new Uint8Array(1 << 14);
  /** Simulation time the current sub-phase started. */
  since = new Float64Array(1 << 14);
  /** When each stage last ended its green, per node * 8 + stage (starvation guard). */
  served = new Float64Array((1 << 14) * 8);
  /** Oldest unanswered pedestrian call per node * 8 + crossing arm (−1 = none). */
  call = new Float64Array((1 << 14) * 8).fill(-1);
  /** Nodes run actuated: near the camera and not fixed-time (the set, and a flag per node). */
  readonly active = new Set<number>();
  private on = new Uint8Array(1 << 14);
  time = 0;

  /** Vehicles waiting near the line on the arms in `mask` (from traffic). */
  queue: (n: number, mask: number) => number = () => 0;
  /** A bus waiting near the line on the arms in `mask`. */
  busNear: (n: number, mask: number) => boolean = () => false;
  /** Pedestrians on a crossing over one of the arms in `mask`. */
  pedsOn: (n: number, mask: number) => boolean = () => false;

  constructor(sim: SimNet) {
    this.sim = sim;
    sim.net.nodes.onGrow((cap) => {
      this.cycle = grow(this.cycle, cap, 0); this.offset = grow(this.offset, cap, 0);
      this.fixed = grow(this.fixed, cap, 0); this.bus = grow(this.bus, cap, 0);
      this.arms = grow(this.arms, cap * 8, 0); this.walk = grow(this.walk, cap * 8, 0);
      this.green = grow(this.green, cap * 8, 0); this.amber = grow(this.amber, cap * 8, 0);
      this.phase = grow(this.phase, cap, 0); this.sub = grow(this.sub, cap, 0); this.since = grow(this.since, cap, 0);
      this.served = grow(this.served, cap * 8, 0); this.call = grow(this.call, cap * 8, -1);
      this.on = grow(this.on, cap, 0);
    });
  }

  /** Stages of the node's light (0 = no light). */
  stages(n: number): number { return this.sim.nodePhases[n]; }

  /** The node was rebuilt (or its control changed): a new plan; the light starts its cycle again. */
  rebuild(n: number): void {
    const sim = this.sim, ns = sim.nodePhases[n];
    this.active.delete(n); this.on[n] = 0;
    for (let k = 0; k < 8; k++) { this.arms[n * 8 + k] = 0; this.walk[n * 8 + k] = 0; this.call[n * 8 + k] = -1; this.served[n * 8 + k] = this.time; }
    this.cycle[n] = 0;
    if (!sim.net.nodes.alive[n] || ns === 0) return;
    const deg = sim.net.nodes.cols.deg[n], spec = sim.net.junctions.get(n);
    const pedSig = sim.nodeCtl[n] === Ctl.PedSignal;
    const all = (1 << Math.min(8, deg)) - 1;
    for (let k = 0; k < deg && k < 8; k++) if (!pedSig) this.arms[n * 8 + sim.armStage[n * 8 + k]] |= 1 << k;
    if (pedSig) this.arms[n * 8] = all; // stage 0 the cars, stage 1 the pedestrians
    this.fixed[n] = spec?.fixed ? 1 : 0;
    this.bus[n] = spec?.bus ? 1 : 0;
    let cycle = 0;
    for (let s = 0; s < ns; s++) {
      const o = n * 8 + s, mask = this.arms[o];
      // pedestrians cross the arms whose traffic the stage stops
      this.walk[o] = all & ~mask;
      // the yellow of the fastest approach the stage releases
      let limit = 0;
      for (let k = 0; k < deg && k < 8; k++) if (mask & (1 << k)) limit = Math.max(limit, laneSpeed(sim.net.segs.cols.profile[sim.armSeg[n * 8 + k]]));
      this.amber[o] = limit > 0 ? iteAmber(limit) : SIGNAL.amber;
      const target = pedSig ? (s === 0 ? 30 : 12) : SIGNAL.baseGreen;
      this.green[o] = Math.max(5, spec?.fixed ? spec.greens?.[s] ?? target : target);
      cycle += this.green[o] + this.amber[o] + SIGNAL.allRed;
    }
    this.cycle[n] = cycle;
    // fixed time: the player's offset (green wave); otherwise one per node, so neighbours do not all turn together
    this.offset[n] = spec?.fixed ? spec.offset ?? 0 : ((Math.imul(n, 2654435761) >>> 0) % 1000) / 1000 * cycle;
    this.seek(n);
  }

  /** Near the camera or not: an actuated light starts from where its timed cycle stands now. */
  setActive(n: number, on: boolean): void {
    if (!on || this.fixed[n] || this.sim.nodePhases[n] === 0) { this.active.delete(n); this.on[n] = 0; return; }
    if (this.on[n]) return;
    this.seek(n);
    this.active.add(n); this.on[n] = 1;
  }

  /** Puts the actuated state where the timed cycle stands now. */
  private seek(n: number): void {
    const st = this.timed(n, this.time);
    this.phase[n] = st >> 2; this.sub[n] = st & 3; this.since[n] = this.time - this.timedIn;
  }

  /** Seconds into the sub-phase, from the last `timed` call. */
  private timedIn = 0;

  /**
   * The light as a function of time (a fixed-time light, and every light away from the camera): stage × 4 + sub-phase
   * at time `t`, its cycle at the target greens started at the node's offset.
   */
  timed(n: number, t: number): number {
    const ns = this.sim.nodePhases[n], cyc = this.cycle[n];
    this.timedIn = 0;
    if (!(cyc > 0)) return 0;
    let x = ((t + this.offset[n]) % cyc + cyc) % cyc;
    for (let s = 0; s < ns; s++) {
      const o = n * 8 + s;
      if (x < this.green[o]) { this.timedIn = x; return s * 4 + Sub.Green; }
      x -= this.green[o];
      if (x < this.amber[o]) { this.timedIn = x; return s * 4 + Sub.Amber; }
      x -= this.amber[o];
      if (x < SIGNAL.allRed) { this.timedIn = x; return s * 4 + Sub.AllRed; }
      x -= SIGNAL.allRed;
    }
    return 0;
  }

  /**
   * Earliest time from `t` on when vehicles on arm `arm` have green: exact for a timed light; an actuated one is asked
   * again a second later. `t` itself when green now (or no light).
   */
  nextGreen(n: number, arm: number, t: number): number {
    if (this.sim.nodePhases[n] === 0 || this.go(n, arm)) return t;
    if (this.on[n]) return t + 1;
    const ns = this.sim.nodePhases[n], cyc = this.cycle[n];
    if (!(cyc > 0)) return t + 1;
    // walk the cycle from where it stands until a green of a stage that releases the arm
    const st = this.timed(n, t);
    let s = st >> 2, sub = st & 3, wait = -this.timedIn;
    for (let guard = 0; guard < ns * 3 + 3; guard++) {
      const o = n * 8 + s;
      if (sub === Sub.Green) { if (this.arms[o] & (1 << arm)) return t + Math.max(0, wait); wait += this.green[o]; sub = Sub.Amber; }
      else if (sub === Sub.Amber) { wait += this.amber[o]; sub = Sub.AllRed; }
      else { wait += SIGNAL.allRed; sub = Sub.Green; s = (s + 1) % ns; }
    }
    return t + 1;
  }

  /** Current stage (× 4) + sub-phase: the actuated state near the camera, the timed cycle elsewhere. */
  state(n: number): number {
    return this.on[n] ? this.phase[n] * 4 + this.sub[n] : this.timed(n, this.time);
  }

  /** Vehicles on arm `arm` may go (green; also amber with `amberToo`). */
  go(n: number, arm: number, amberToo = false): boolean {
    const st = this.state(n), sub = st & 3;
    return (this.arms[n * 8 + (st >> 2)] & (1 << arm)) !== 0 && (sub === Sub.Green || (amberToo && sub === Sub.Amber));
  }

  /** The light shows yellow now. */
  amberNow(n: number): boolean { return (this.state(n) & 3) === Sub.Amber; }

  /** Pedestrians may start crossing arm `arm` now. */
  walkOk(n: number, arm: number): boolean {
    if (this.sim.nodePhases[n] === 0) return true;
    const st = this.state(n);
    return (st & 3) === Sub.Green && (this.walk[n * 8 + (st >> 2)] & (1 << arm)) !== 0;
  }

  /** A pedestrian reached the kerb of the crossing over arm `arm` and waits: the stage that lets them walk is called. */
  pedCall(n: number, arm: number): void {
    const o = n * 8 + arm;
    if (this.sim.nodePhases[n] > 0 && arm < 8 && this.call[o] < 0) this.call[o] = this.time;
  }

  /** Somebody (vehicles or pedestrians) waits for stage `s`. */
  private demand(n: number, s: number): boolean {
    const o = n * 8 + s;
    if (this.arms[o] && this.queue(n, this.arms[o]) > 0) return true;
    for (let k = 0; k < 8; k++) if ((this.walk[o] & (1 << k)) && this.call[n * 8 + k] >= 0) return true;
    return false;
  }

  /** Longest a pedestrian has waited for stage `s` (s). */
  private pedWait(n: number, s: number): number {
    let w = 0;
    for (let k = 0; k < 8; k++) if ((this.walk[n * 8 + s] & (1 << k)) && this.call[n * 8 + k] >= 0) w = Math.max(w, this.time - this.call[n * 8 + k]);
    return w;
  }

  /** One step of the actuated lights. */
  step(dt: number): void {
    this.time += dt;
    for (const n of this.active) {
      if (!this.sim.net.nodes.alive[n] || this.sim.nodePhases[n] === 0) { this.active.delete(n); this.on[n] = 0; continue; }
      this.stepNode(n);
    }
  }

  private endGreen(n: number): void {
    this.served[n * 8 + this.phase[n]] = this.time;
    this.sub[n] = Sub.Amber; this.since[n] = this.time;
  }

  private stepNode(n: number): void {
    const ns = this.sim.nodePhases[n], s = this.phase[n], o = n * 8 + s, el = this.time - this.since[n];
    if (this.sub[n] === Sub.Green) {
      // pedestrians this stage let walk are still crossing: the green waits for them (bounded)
      const inside = el < SIGNAL.maxGreen + SIGNAL.pedHold && this.pedsOn(n, this.walk[o]);
      const mayEnd = el >= SIGNAL.minGreen && !inside;
      // bus priority: the green held for a bus about to reach the line, cut short for one waiting on another stage
      if (this.bus[n] && this.arms[o] && this.busNear(n, this.arms[o]) && el < SIGNAL.maxGreen + SIGNAL.busExtension) return;
      let competing = false, busElsewhere = false;
      for (let k = 1; k < ns; k++) {
        const t = (s + k) % ns;
        competing ||= this.demand(n, t);
        if (this.bus[n] && this.arms[n * 8 + t] && this.busNear(n, this.arms[n * 8 + t])) busElsewhere = true;
      }
      if (mayEnd && busElsewhere) { this.endGreen(n); return; }
      if (!mayEnd && el < SIGNAL.maxGreen) return;
      // an actuated light rests in green while nobody else asks for the right of way
      const mine = this.arms[o] !== 0 && this.queue(n, this.arms[o]) > 0;
      const gapOut = mayEnd && competing && !mine;
      const atTarget = mayEnd && competing && el >= this.green[o];
      const maxOut = el >= SIGNAL.maxGreen && competing && !inside;
      if (gapOut || atTarget || maxOut) this.endGreen(n);
    } else if (this.sub[n] === Sub.Amber) {
      if (el >= this.amber[o]) { this.sub[n] = Sub.AllRed; this.since[n] = this.time; }
    } else if (el >= SIGNAL.allRed) {
      const next = this.pickNext(n);
      this.phase[n] = next; this.sub[n] = Sub.Green; this.since[n] = this.time;
      // the crossings this stage lets walk: their callers are answered
      for (let k = 0; k < 8; k++) if (this.walk[n * 8 + next] & (1 << k)) this.call[n * 8 + k] = -1;
    }
  }

  /** Next stage: one starved for 1.5 cycles, then a pedestrian waiting 45 s, then the longest-waiting call, else the next in order. */
  private pickNext(n: number): number {
    const ns = this.sim.nodePhases[n], cur = this.phase[n];
    if (ns <= 1) return 0;
    const seq = (cur + 1) % ns, deadline = this.cycle[n] * SIGNAL.starvationCycles;
    let overdue = -1, overdueAge = -1, called = -1, calledAge = -1, walkers = -1, longest: number = SIGNAL.pedWaitLimit;
    for (let k = 1; k < ns; k++) {
      const t = (cur + k) % ns;
      if (!this.demand(n, t)) continue;
      const age = this.time - this.served[n * 8 + t];
      if (this.arms[n * 8 + t] && age >= deadline && age > overdueAge) { overdue = t; overdueAge = age; }
      if (age > calledAge) { called = t; calledAge = age; }
      const w = this.pedWait(n, t);
      if (w >= longest) { longest = w; walkers = t; }
    }
    if (overdue >= 0) return overdue;
    if (walkers >= 0) return walkers;
    return called >= 0 ? called : seq;
  }
}

function grow<T extends Float32Array | Float64Array | Uint8Array>(a: T, cap: number, fill: number): T {
  if (cap <= a.length) return a;
  const b = new (a.constructor as new (n: number) => T)(cap);
  b.fill(fill);
  b.set(a);
  return b;
}

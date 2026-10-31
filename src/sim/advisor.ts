// Automatic control by flow (Roadcraft 4.0 ControlAdvisor, src/sim/roads/controlAdvisor.ts and world.ts
// stepControlAdvisor): each junction on automatic counts who comes in by arm (micro and meso), the rate becomes a moving
// average of a few minutes and, with hysteresis, the node gains or loses its signal. As in 4.0, only the junctions being
// watched are judged, each every EVERY seconds: a junction is watched from the first vehicle counted at it (or from its
// creation / the choice of its control) until it rests at signs too quiet for anything else. A quiet junction costs
// nothing until a vehicle comes again; nothing walks the map's nodes (D55: a cursor sliced every node, 64 a step).

import { FLOW, Flow, warrantedControl } from '../roads/control.ts';
import type { SimNet } from './lanes.ts';
import { asNode, type NodeId } from '../core/ids.ts';

/** Moving average of the flow (s): the control changes on a trend, not on a platoon. */
export const TREND = 300;
/** Minimum time between two changes at a node, and of measuring before the first (s). */
export const SETTLE = 600;
/** Seconds between two judgements of a watched junction (4.0 ControlAdvisor.EVERY). */
export const EVERY = 10;
/**
 * Vehicles an hour into a junction below which no control above signs is warranted, whatever it has now: the least
 * major flow of a step up, with the hysteresis (4.0 controlAdvisor.ts QUIET_FLOW).
 */
export const QUIET_FLOW = Math.min(FLOW.stopMajor, FLOW.signalMajor, FLOW.signalMajorB) * Math.min(1, FLOW.stepDown);
/** Changes per step (each change rebuilds the node; the rest stay due and change at the next step). */
const CHANGES_PER_STEP = 2;

export class FlowAdvisor {
  private readonly sim: SimNet;
  /** Arrivals per arm (node * 8 + arm), ever; and the value at the last judgement. */
  pass = new Uint32Array((1 << 14) * 8);
  private seen = new Uint32Array((1 << 14) * 8);
  /** Flow per arm (vehicles/h, moving average). */
  rate = new Float32Array((1 << 14) * 8);
  /** Last judgement and start of the measurement (or last change) of each node. */
  private lastT = new Float64Array(1 << 14);
  private since = new Float64Array(1 << 14).fill(-1);
  /** Watched nodes in the order they are due (every push is due EVERY s after now, so the queue stays in order). */
  private queue = new Int32Array(1 << 14);
  private dueAt = new Float64Array(1 << 14);
  private head = 0;
  private size = 0;
  private queued = new Uint8Array(1 << 14);
  /** Nodes new or with their control chosen since the last step: watched from then (they may never see a vehicle). */
  private pending: number[] = [];
  private pendingAt = new Uint8Array(1 << 14);
  /** 4.0's thresholds times this. With 1 the automatic put ~700 signals in the generated 16 km city and the centre fell
   *  1-2 km/h (a junction with signs clears more than a signal here); with 2 it changes ~200 nodes. */
  scale = 2;
  /** Changes made (for the diagnosis). */
  changes = 0;
  /** A node changed (to tell the page). */
  onChange: (node: NodeId, flow: number) => void = () => {};

  constructor(sim: SimNet) {
    this.sim = sim;
    sim.net.nodes.onGrow((cap) => this.growNodes(cap));
    this.growNodes(sim.net.nodes.capacity);
    // a network built before this advisor was made
    for (let n = 0; n < sim.net.nodes.end; n++) if (sim.net.nodes.alive[n]) this.reset(n);
  }

  /** New node or control chosen: measured again, and watched from the next step. */
  reset(n: number): void {
    for (let a = 0; a < 8; a++) { this.pass[n * 8 + a] = 0; this.seen[n * 8 + a] = 0; this.rate[n * 8 + a] = 0; }
    this.since[n] = -1;
    if (!this.pendingAt[n]) { this.pendingAt[n] = 1; this.pending.push(n); }
  }

  /** A vehicle went through node n from arm `arm` at `time` (micro or meso): counted, and the node watched. */
  count(n: number, arm: number, time: number): void {
    this.pass[n * 8 + arm]++;
    if (!this.queued[n] && this.sim.nodeAuto[n]) this.watch(n, time);
  }

  /**
   * The node's arms were laid out again (a road added or removed there, a new width): each arm's counters follow its
   * segment to its new index; a new arm starts at zero (D24: the counters stayed by index and mixed arms up).
   */
  remap(n: number, oldArms: ArrayLike<number>): void {
    const pass = this.pass, seen = this.seen, rate = this.rate, arms = this.sim.armSeg, o = n * 8;
    const p = pass.slice(o, o + 8), s = seen.slice(o, o + 8), r = rate.slice(o, o + 8);
    for (let k = 0; k < 8; k++) {
      const seg = arms[o + k];
      let j = -1;
      if (seg >= 0) for (let i = 0; i < 8; i++) if (oldArms[i] === seg) { j = i; break; }
      pass[o + k] = j >= 0 ? p[j] : 0; seen[o + k] = j >= 0 ? s[j] : 0; rate[o + k] = j >= 0 ? r[j] : 0;
    }
  }

  /** Judges the watched nodes that are due (each every EVERY s), and starts watching the new ones. */
  step(time: number): void {
    const sim = this.sim, nodes = sim.net.nodes;
    for (const n of this.pending) {
      this.pendingAt[n] = 0;
      if (nodes.alive[n] && sim.nodeAuto[n] && !this.queued[n]) this.watch(n, time);
    }
    this.pending.length = 0;
    let changes = 0;
    while (this.size > 0 && changes < CHANGES_PER_STEP && this.dueAt[this.head] <= time) {
      const n = this.queue[this.head];
      this.head = (this.head + 1) % this.queue.length; this.size--;
      this.queued[n] = 0;
      if (!nodes.alive[n] || !sim.nodeAuto[n]) continue;
      if (this.since[n] < 0) { this.watch(n, time); continue; }
      const dt = time - this.lastT[n];
      if (dt <= 0) { this.push(n, time); continue; }
      this.lastT[n] = time;
      // exponential moving average of each arm's rate
      const w = Math.min(1, dt / TREND), main = sim.armMain[n], deg = nodes.cols.deg[n];
      let major = 0, minorMax = 0, minorTotal = 0;
      for (let a = 0; a < deg; a++) {
        const k = n * 8 + a;
        const inst = (this.pass[k] - this.seen[k]) / dt * 3600;
        this.seen[k] = this.pass[k];
        this.rate[k] += (inst - this.rate[k]) * w;
        if (main & (1 << a)) major += this.rate[k];
        else { minorMax = Math.max(minorMax, this.rate[k]); minorTotal += this.rate[k]; }
      }
      const k = this.scale, signal = sim.nodePhases[n] > 0;
      // at signs and too quiet for anything else: the rates only fall until a vehicle is counted here again (4.0)
      if (!signal && (major + minorTotal) / k < QUIET_FLOW) continue;
      this.push(n, time);
      if (time - this.since[n] < SETTLE) continue;
      const want = warrantedControl(major / k, minorMax / k, minorTotal / k, signal ? 'signal' : 'priority');
      if ((want === 'signal') === signal) continue;
      const node = asNode(n);
      sim.setFlow(node, want === 'signal' ? Flow.Signal : Flow.Signs);
      this.since[n] = time;
      this.changes++; changes++;
      this.onChange(node, want === 'signal' ? Flow.Signal : Flow.Signs);
    }
  }

  /** Watches node n from `time`: its measurement starts now if it had none, and it is judged EVERY s from now. */
  private watch(n: number, time: number): void {
    if (this.since[n] < 0) {
      this.since[n] = time; this.lastT[n] = time;
      for (let a = 0; a < 8; a++) this.seen[n * 8 + a] = this.pass[n * 8 + a];
    }
    this.push(n, time);
  }

  private push(n: number, time: number): void {
    const q = this.queue;
    const i = (this.head + this.size) % q.length;
    q[i] = n; this.dueAt[i] = time + EVERY;
    this.size++;
    this.queued[n] = 1;
  }

  /** The per-node arrays take the network's size (also one that grew before this advisor was made). */
  private growNodes(cap: number): void {
    this.pass = grow(this.pass, cap * 8); this.seen = grow(this.seen, cap * 8); this.rate = grow(this.rate, cap * 8);
    this.lastT = grow(this.lastT, cap); this.since = grow(this.since, cap, -1);
    this.queued = grow(this.queued, cap); this.pendingAt = grow(this.pendingAt, cap);
    // the queue holds each node at most once: it grows with the nodes, keeping its order
    if (cap <= this.queue.length) return;
    const q = new Int32Array(cap), d = new Float64Array(cap);
    for (let k = 0; k < this.size; k++) {
      const i = (this.head + k) % this.queue.length;
      q[k] = this.queue[i]; d[k] = this.dueAt[i];
    }
    this.queue = q; this.dueAt = d; this.head = 0;
  }
}

function grow<T extends Uint32Array | Float32Array | Float64Array | Uint8Array>(a: T, cap: number, fill = 0): T {
  if (cap <= a.length) return a;
  const b = new (a.constructor as new (n: number) => T)(cap);
  b.fill(fill);
  b.set(a);
  return b;
}

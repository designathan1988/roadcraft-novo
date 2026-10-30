// Routes: A* in time over the road graph. Vehicles search directed segments (one-way streets, banned turns and the
// lanes' connections respected); on foot, the nodes (no one-way streets, only segments with a sidewalk).
// Typed arrays reused between searches; nothing walks the fleet.

import { MAX_DEG } from '../roads/network.ts';
import { PROFILES, PROFILE_INFO } from '../roads/profiles.ts';
import { Ctl, Rule } from '../roads/control.ts';
import type { SimNet } from './lanes.ts';
import { asSeg, type NodeId } from '../core/ids.ts';

const MAX_SPEED = 90 / 3.6;
/**
 * Car: the estimate of the rest of the way uses the city's typical speed with its waits (30 km/h), not the top
 * speed: the search opens ~3× fewer nodes (the 16 km map opens with its fleet in half the time and each new trip
 * costs less), and the routes come out nearly the same (same speed downtown, measured).
 */
const GUESS_SPEED = 30 / 3.6;
export const WALK_SPEED = 1.35;

export class Router {
  private g = new Float64Array(1 << 14);
  private from = new Int32Array(1 << 14);
  private stamp = new Uint32Array(1 << 14);
  private closed = new Uint32Array(1 << 14);
  private cur = 0;
  private heapN = new Int32Array(1 << 14);
  private heapF = new Float64Array(1 << 14);
  private heapSize = 0;
  private path = new Int32Array(1024);
  private sim: SimNet;
  /** Most expansions per search (a longer route fails). */
  limit = 40000;
  /** Nodes opened and searches with no path, ever (diagnostics). */
  expanded = 0; failed = 0;

  /** Vehicles per segment and direction (from traffic): the cost rises as it fills up. */
  segLoad: Uint16Array | null = null;

  constructor(sim: SimNet) { this.sim = sim; }

  /** Seconds expected at node `n` arriving by `sIn` and leaving by `sOut`; without `signalWait`, a light costs only the turn. */
  nodeCost(n: number, sIn: number, sOut: number, signalWait = true): number {
    const sim = this.sim, sc = sim.net.segs.cols;
    if (sim.net.nodes.cols.deg[n] < 3) return 0;
    const ai = n * 8 + sim.segArm[sIn * 2 + (sc.a[sIn] === n ? 0 : 1)];
    const ao = n * 8 + sim.segArm[sOut * 2 + (sc.a[sOut] === n ? 0 : 1)];
    // arriving heading (against the entry arm) and exit arm: a cross product > 0 is to the right
    const hx = -sim.armDx[ai], hz = -sim.armDz[ai], ox = sim.armDx[ao], oz = sim.armDz[ao];
    const cross = hx * oz - hz * ox, dot = hx * ox + hz * oz;
    const turn = dot > 0.7 ? 0 : cross > 0 ? 2 : dot < -0.7 ? 15 : 6;
    const signal = sim.nodePhases[n] > 0;
    if (signal) return (signalWait ? 10 : 0) + turn * 1.3;
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
    this.g = gr(this.g); this.from = gr(this.from); this.stamp = gr(this.stamp); this.closed = gr(this.closed);
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
   * Node path from `src` to `dst` into `out` (from `at`), up to `max` nodes. Returns how many nodes it wrote (0 = no
   * path). On foot (`walk`): `ban` is a segment not to leave `src` by (no turning back). A vehicle: `ban` is the
   * segment it reaches `src` by, and every movement, `src` included, must be one the node's connections make (banned
   * turns and hand-made lane connectors respected; turning back only where there is a U-turn connection); `ban2` is a
   * segment not to leave `src` by (the full exit of a driver reconsidering the route); `bus`: bus-only lanes too;
   * `last`: the route must end driving this segment into `dst` (a bus stop's lane), −1 = any way into `dst`.
   */
  route(src: number, dst: number, out: Int32Array, at: number, max: number, walk = false, ban = -1, rail = false, ban2 = -1, bus = false, last = -1): number {
    return walk ? this.walkRoute(src, dst, out, at, max, ban) : this.driveRoute(src, dst, out, at, max, ban, rail, ban2, bus, last);
  }

  /** On foot: A* over the nodes (one-way streets do not matter, only segments with a sidewalk). */
  private walkRoute(src: number, dst: number, out: Int32Array, at: number, max: number, ban: number): number {
    const net = this.sim.net, nc = net.nodes.cols, sc = net.segs.cols;
    this.ensure(net.nodes.capacity);
    if (++this.cur === 0xffffffff) { this.stamp.fill(0); this.closed.fill(0); this.cur = 1; }
    const cur = this.cur;
    if (!net.nodes.alive[src] || !net.nodes.alive[dst]) return 0;
    const tx = nc.x[dst], tz = nc.z[dst];
    const h = (n: number) => Math.hypot(nc.x[n] - tx, nc.z[n] - tz) / WALK_SPEED;
    this.heapSize = 0;
    this.g[src] = 0; this.stamp[src] = cur; this.from[src] = -1;
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
        if (s < 0 || !net.segs.alive[s] || (n === src && s === ban)) continue; // no turning back on the segment it came by
        if (!PROFILE_INFO[sc.profile[s]].walk) continue;
        const m = sc.a[s] === n ? sc.b[s] : sc.a[s];
        if (this.closed[m] === cur) continue;
        const cost = this.g[n] + sc.len[s] / WALK_SPEED + 1;
        if (this.stamp[m] !== cur || cost < this.g[m]) {
          this.stamp[m] = cur; this.g[m] = cost; this.from[m] = n;
          this.push(m, cost + h(m));
        }
      }
    }
    this.expanded += expanded;
    if (!found) { this.failed++; return 0; }
    // rebuilt from the end; keeps the first `max` nodes (the rest is planned again on the way)
    let len = 0;
    for (let n = dst; n >= 0; n = this.from[n]) {
      if (len >= this.path.length) { const p = new Int32Array(this.path.length * 2); p.set(this.path); this.path = p; }
      this.path[len++] = n;
    }
    const take = Math.min(len, max);
    for (let i = 0; i < take; i++) out[at + i] = this.path[len - 1 - i];
    return take;
  }

  /** Per directed segment (seg * 2 + 0 travelling a→b, + 1 b→a): cost, previous state, marks. */
  private eg = new Float64Array(1 << 15);
  private efrom = new Int32Array(1 << 15);
  private estamp = new Uint32Array(1 << 15);
  private eclosed = new Uint32Array(1 << 15);
  private ecur = 0;

  private ensureEdges(cap: number): void {
    if (cap <= this.eg.length) return;
    let n = this.eg.length;
    while (n < cap) n *= 2;
    this.eg = new Float64Array(n); this.efrom = new Int32Array(n);
    this.estamp = new Uint32Array(n); this.eclosed = new Uint32Array(n);
    this.ecur = 0;
  }

  /**
   * A vehicle: A* over directed segments (the state is "arriving at a node by a segment"), so a movement the node's
   * lanes do not make is never planned and a path may pass the same node twice (round the block after a banned turn,
   * to a dead end and back).
   */
  private driveRoute(src: number, dst: number, out: Int32Array, at: number, max: number, inSeg: number, rail: boolean, ban2: number, bus: boolean, last: number): number {
    const sim = this.sim, net = sim.net, nc = net.nodes.cols, sc = net.segs.cols;
    if (!net.nodes.alive[src] || !net.nodes.alive[dst]) return 0;
    // the state the route must end in (arriving at dst by `last`), −1 = any
    const goal = last >= 0 && net.segs.alive[last] && (sc.a[last] === dst || sc.b[last] === dst) ? last * 2 + (sc.b[last] === dst ? 0 : 1) : -1;
    if (src === dst && goal < 0) { out[at] = src; return 1; }
    this.ensureEdges(net.segs.capacity * 2);
    if (++this.ecur === 0xffffffff) { this.estamp.fill(0); this.eclosed.fill(0); this.ecur = 1; }
    const cur = this.ecur;
    const tx = nc.x[dst], tz = nc.z[dst];
    const vmax = rail ? MAX_SPEED : GUESS_SPEED;
    const h = (n: number) => Math.hypot(nc.x[n] - tx, nc.z[n] - tz) / vmax;
    // a directed edge is a segment travelled a → b (even) or b → a (odd); its head is the node it arrives at
    const head = (e: number): NodeId => ((e & 1) === 0 ? sc.b[e >> 1] : sc.a[e >> 1]);
    const load = this.segLoad;
    /** Time to drive segment `s` leaving node `n` (−1: a vehicle cannot), slowed by how full it is. */
    const drive = (s: number, n: number): number => {
      if (s < 0 || !net.segs.alive[s]) return -1;
      const info = PROFILE_INFO[sc.profile[s]], p = PROFILES[sc.profile[s]];
      if (info.rail !== rail) return -1; // cars never on the rails, trains only on them
      const forward = sc.a[s] === n;
      if (p.oneWay && !forward) return -1;
      let t = sc.len[s] / (p.speed / 3.6) + 2;
      if (load) {
        // occupancy: time grows with its square (strong BPR curve): drivers avoid the full street
        const cap = Math.max(1, sc.len[s] * Math.max(1, forward ? info.lanesFwd : info.lanesBack) / 7.5);
        const r = load[s * 2 + (forward ? 0 : 1)] / cap;
        t *= 1 + 10 * r * r;
      }
      return t;
    };
    this.heapSize = 0;
    let start = -1;
    if (inSeg >= 0 && net.segs.alive[inSeg] && (sc.a[inSeg] === src || sc.b[inSeg] === src)) {
      // already arriving at src by inSeg: the state src is left from
      start = inSeg * 2 + (sc.b[inSeg] === src ? 0 : 1);
      this.eg[start] = 0; this.efrom[start] = -1; this.estamp[start] = cur;
      this.push(start, h(src));
    } else {
      // standing at src (a new trip mid-segment): any segment out of it
      const o = src * MAX_DEG, d = nc.deg[src];
      for (let k = 0; k < d; k++) {
        const s = net.adj[o + k];
        if (s === ban2) continue;
        const t = drive(s, src);
        if (t < 0) continue;
        const e = s * 2 + (sc.a[s] === src ? 0 : 1);
        if (this.estamp[e] === cur && this.eg[e] <= t) continue;
        this.eg[e] = t; this.efrom[e] = -1; this.estamp[e] = cur;
        this.push(e, t + h(head(e)));
      }
    }
    let expanded = 0, found = -1;
    while (this.heapSize > 0) {
      const e = this.pop();
      if (this.eclosed[e] === cur) continue;
      this.eclosed[e] = cur;
      const n = head(e);
      if (n === dst && e !== start && (goal < 0 || e === goal)) { found = e; break; }
      if (++expanded > this.limit) break;
      const sIn = asSeg(e >> 1), o = n * MAX_DEG, d = nc.deg[n];
      for (let k = 0; k < d; k++) {
        const s = net.adj[o + k];
        if (e === start && s === ban2) continue;
        const t = drive(s, n);
        if (t < 0 || !sim.turnOk(n, sIn, s, bus || rail)) continue; // only the movements the node's lanes make
        const e2 = s * 2 + (sc.a[s] === n ? 0 : 1);
        if (this.eclosed[e2] === cur) continue;
        // the junction costs by its control and the turn (an avenue with signals beats the local street full of stop
        // signs; turning left costs more than going straight)
        const cost = this.eg[e] + t + (rail ? 0 : this.nodeCost(n, sIn, s));
        if (this.estamp[e2] !== cur || cost < this.eg[e2]) {
          this.estamp[e2] = cur; this.eg[e2] = cost; this.efrom[e2] = e;
          this.push(e2, cost + h(head(e2)));
        }
      }
    }
    this.expanded += expanded;
    if (found < 0) { this.failed++; return 0; }
    // rebuilt from the end: the head node of every state, then src; keeps the first `max` nodes
    let len = 0;
    for (let e = found; e >= 0 && e !== start; e = this.efrom[e]) {
      if (len + 1 >= this.path.length) { const p = new Int32Array(this.path.length * 2); p.set(this.path); this.path = p; }
      this.path[len++] = head(e);
    }
    this.path[len++] = src;
    const take = Math.min(len, max);
    for (let i = 0; i < take; i++) out[at + i] = this.path[len - 1 - i];
    return take;
  }
}

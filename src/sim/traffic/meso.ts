// Meso (far from the camera) traffic: one queue per lane ordered by entry, and an event per vehicle for the end of
// its lane. No loop goes over the fleet per step: only the events due are taken from the heap. The movement itself
// (picking the next lane, queues, lights, crossings) is simulated here at the pace of the near model; the vehicles
// entering the window become micro (Traffic owns the columns and the lane lists, read through MesoHost).

import { Ctl } from '../../roads/control.ts';
import { PROFILE_INFO } from '../../roads/profiles.ts';
import { laneCount, laneDir, laneIdx, laneSeg, laneSpeed, type SimNet } from '../lanes.ts';
import type { Router } from '../routing.ts';
import type { Signals } from '../signals.ts';
import { TERMINAL_DWELL } from './buses.ts';
import { growArray } from './grow.ts';
import type { SimLine } from './lines.ts';
import { End, JAM_SECONDS, RELEASE_EVERY, type VehAccess } from './state.ts';

// Meso at the pace of micro: the fleet is a single one, so if meso runs faster the cars pile up in the window until
// it jams, and if it runs slower the window empties; and the camera must not change how fast the city drives. Measured
// on a 6 × 6 grid at 8:00, the camera on it against 8 km away (test "the camera does not change how fast the city
// drives"): 21.7 / 20.8, 10.6 / 10.9 and 5.9 / 6.7 km/h at densities 1/100, 1/30 and 1/15 with alpha 0.95 (the earlier
// 0.85 with the same scene gave 5.7 / 7.4 at 1/15, the far model too fast).
const MESO_ALPHA = 0.95, MESO_CROWD = 12;
// IDM figures for what is not a driver's own (sim/drivers.ts has each driver's): the standstill gap kept from a bus
// stop or the tail entering a lane, and the headway a vehicle entering the window is given.
const S0 = 2.2, T_HEAD = 0.9;
const DWELL = 14;

/** The vehicle columns the far model writes (every other column it only reads). */
export type MesoWrites = 's' | 'v' | 'wait' | 'held' | 'fade' | 'rIdx' | 'tExit' | 'why'
  | 'ml' | 'mnext' | 'mprev';
export type MesoColumns = VehAccess<MesoWrites>;

/** What the far model needs from Traffic; every field is the owner's state, not a copy. */
export interface MesoHost {
  readonly sim: SimNet;
  readonly cols: MesoColumns;
  readonly alive: Uint8Array;
  readonly time: number;
  readonly camX: number;
  readonly camZ: number;
  readonly window: number;
  readonly laneHead: Int32Array;
  readonly laneTail: Int32Array;
  readonly laneCount: Uint16Array;
  readonly lines: SimLine[];
  readonly router: Router;
  readonly sig: Signals;
  readonly routeBudget: number;
  readonly lastAdmit: Float64Array;
  readonly releaseAt: Float64Array;
  readonly jamAt: Float64Array;
  countRelease(): void;
  countJam(): void;
  nextSeg(v: number): number;
  segAfter(v: number, k: number): number;
  pickLane(seg: number, dir: number, after: number, bus: boolean, fallback: number): number;
  atDestination(v: number): boolean;
  dropsOff(v: number): boolean;
  dropOffTrip(v: number, node: number): boolean;
  finish(v: number): void;
  lose(v: number): void;
  replanFrom(v: number, node: number): void;
  materialize(lane: number): void;
  serveBus(v: number): void;
  busPlan(v: number, node: number): void;
  addMicro(v: number): void;
  insert(v: number, onConn: boolean, lane: number): void;
  leaveLane(v: number, lane: number): void;
  setLaneCount(lane: number, delta: number): void;
  /** Traffic's transitions of a vehicle between lanes and connections (it keeps the lane counts with the columns). */
  moveToLane(v: number, from: number, to: number): void;
  enterConn(v: number, conn: number): void;
  leaveConn(v: number, cameBy: number): void;
  placeNew(v: number, lane: number): void;
  enterLane(v: number, s: number): void;
  admit(node: number, arm: number): void;
  reconsider(v: number, lane: number, ns: number): boolean;
  crossingDown(n: number): boolean;
  pedCrossing(n: number): boolean;
}

export class Meso {
  /** Far-model vehicles per lane, in order of entry: an edit to a road finds the vehicles on it without a fleet pass. */
  head = new Int32Array((1 << 14) * 16).fill(-1);
  tail = new Int32Array((1 << 14) * 16).fill(-1);
  /** Attempts to move on at the end of the lane and how many found the next one full (congestion far from the camera). */
  tries = 0;
  full = 0;
  /** Pace of the far model against the near one, and how much a full lane slows it (the BPR term). */
  alpha = MESO_ALPHA;
  crowd = MESO_CROWD;
  private laneLastExit = new Float64Array((1 << 14) * 16);
  /** Events: heap (time, vehicle). */
  private evT = new Float64Array(1 << 12);
  private evV = new Int32Array(1 << 12);
  private evN = 0;
  private readonly host: MesoHost;

  constructor(host: MesoHost) { this.host = host; }

  /** The lane arrays grew with the road network. */
  grow(cap: number): void {
    this.head = growArray(this.head, cap, -1);
    this.tail = growArray(this.tail, cap, -1);
    this.laneLastExit = growArray(this.laneLastExit, cap, 0);
  }

  clear(): void {
    this.head.fill(-1);
    this.tail.fill(-1);
    this.laneLastExit.fill(0);
    this.evN = 0;
  }

  /** Puts a far-model vehicle at the end of its lane's list. */
  link(v: number, lane: number): void {
    const c = this.host.cols;
    if (c.ml[v] === lane) return;
    this.unlink(v);
    c.ml[v] = lane; c.mnext[v] = -1; c.mprev[v] = this.tail[lane];
    if (this.tail[lane] >= 0) c.mnext[this.tail[lane]] = v; else this.head[lane] = v;
    this.tail[lane] = v;
  }

  unlink(v: number): void {
    const c = this.host.cols, lane = c.ml[v];
    if (lane < 0) return;
    if (c.mprev[v] >= 0) c.mnext[c.mprev[v]] = c.mnext[v]; else this.head[lane] = c.mnext[v];
    if (c.mnext[v] >= 0) c.mprev[c.mnext[v]] = c.mprev[v]; else this.tail[lane] = c.mprev[v];
    c.ml[v] = -1; c.mnext[v] = c.mprev[v] = -1;
  }

  /** Is the lane's middle inside the camera window? */
  inWindow(lane: number): boolean {
    const h = this.host, sc = h.sim.net.segs.cols, s = laneSeg(lane);
    return Math.hypot(sc.mx[s] - h.camX, sc.mz[s] - h.camZ) < h.window;
  }

  /** Vehicle switches to meso mode on the lane (schedules its exit). */
  enter(v: number, lane: number, spawned = false): void {
    const h = this.host, c = h.cols;
    this.link(v, lane);
    const L = h.sim.laneLen(lane);
    const p = h.sim.net.segs.cols.profile[laneSeg(lane)];
    const lanes = Math.max(1, laneCount(p, laneDir(lane)));
    // the queue already drains at the capacity rate (one vehicle every 1.8 s per lane) and a full lane moves slowly:
    // congestion exists far from the camera too, and the flow reaching the micro window is what traffic at that
    // occupancy would deliver
    const rest = spawned ? L - c.s[v] : L;
    let extra = 0;
    // bus on the lane of its stop: stops, serves it and already knows the next one
    if (c.line[v] >= 0) {
      const ln = h.lines[c.line[v]];
      if (ln && ln.stopLane[c.stopI[v]] === lane) { extra = ln.mode ? 25 : ln.term.has(c.stopI[v]) ? TERMINAL_DWELL : DWELL; h.serveBus(v); }
    }
    // the junction at the end of the lane: the same wait the router estimates (signal, stop, turn) and the
    // arm's throughput, as in micro
    // (at a light the red itself is simulated when the vehicle reaches the line: only the turn's slowdown here, and the
    // queue leaves at the saturation headway of a green)
    const ns = h.nextSeg(v);
    const node = h.sim.laneTo(lane), lit = h.sim.nodePhases[node] > 0;
    const wait = ns >= 0 ? h.router.nodeCost(node, laneSeg(lane), ns, !lit) : 0;
    const headway = lit ? 2 : wait >= 6 ? 3.6 : wait >= 4 ? 2.6 : 1.8;
    // time: free driving, slowed by occupancy (BPR curve), plus the junction wait; all times MESO_ALPHA
    const occ = Math.min(1, h.laneCount[lane] * 7.5 / (L * lanes));
    const run = rest / (laneSpeed(p) * c.vf[v]) * (1 + this.crowd * occ * occ) + wait;
    const t = Math.max(h.time + run * this.alpha + extra, this.laneLastExit[lane] + headway / lanes);
    this.laneLastExit[lane] = t;
    this.schedule(v, t);
  }

  /** Takes the events due (one per vehicle reaching the end of its lane). */
  process(): void {
    while (this.evN > 0 && this.evT[0] <= this.host.time) {
      const t = this.evT[0];
      const v = this.popEvent();
      const c = this.host.cols;
      if (!this.host.alive[v] || c.micro[v] || c.tExit[v] !== t) continue;
      this.advance(v);
    }
  }

  /** End of the lane in meso mode: picks the next one, waits if it is full. */
  advance(v: number): void {
    const h = this.host, c = h.cols, sim = h.sim;
    let lane = c.lane[v];
    if (!sim.net.segs.alive[laneSeg(lane)]) { c.why[v] = End.Lost; h.finish(v); return; }
    if (c.phase[v]) { h.finish(v); return; }
    // on a lane inside the window, behind drawn vehicles: it waits to fit behind them (never passes them unseen)
    if (h.laneHead[lane] >= 0 && this.inWindow(lane)) { h.materialize(lane); if (!c.micro[v]) this.schedule(v, h.time + 1); return; }
    if (h.atDestination(v)) {
      // a drop-off: the trip ends there and the car goes on to another after a moment at the kerb
      if (h.dropsOff(v) && h.dropOffTrip(v, sim.laneTo(lane))) { this.schedule(v, h.time + 6); return; }
      if (c.line[v] < 0) { h.finish(v); return; }
      h.busPlan(v, sim.laneTo(lane)); // bus arrived without serving: redo the leg to the stop
      if (c.phase[v]) { h.finish(v); return; }
    }
    let ns = h.nextSeg(v);
    if (ns < 0) {
      // route ended before the destination (truncated route): plan again from here
      h.replanFrom(v, sim.laneTo(lane));
      if (c.phase[v]) { h.finish(v); return; }
      ns = h.nextSeg(v);
      if (ns < 0) { h.lose(v); h.finish(v); return; }
    }
    const bus = c.line[v] >= 0, node = sim.laneTo(lane);
    let conn = sim.connToward(lane, ns, bus);
    for (let tries = 0; conn < 0 && tries < 2; tries++) {
      // its lane does not make the route's turn (the turn was banned, the lanes rearranged): another lane of this
      // segment that makes it (the far model changes lanes at the end of the lane), else a new route from here
      const alt = sim.laneToward(laneSeg(lane), laneDir(lane), ns, laneIdx(lane), bus);
      if (alt >= 0 && alt !== lane) {
        h.moveToLane(v, lane, alt);
        lane = alt; this.link(v, alt);
      } else {
        h.replanFrom(v, node);
        if (c.phase[v]) { h.finish(v); return; }
        ns = h.nextSeg(v);
        if (ns < 0) break;
      }
      conn = sim.connToward(lane, ns, bus);
    }
    if (conn < 0) { h.lose(v); h.finish(v); return; }
    // a level crossing with the barrier down, or someone on the zebra: wait (the far model obeys them too)
    const ctl = sim.nodeCtl[node];
    if ((ctl === Ctl.Crossing && h.crossingDown(node) && !PROFILE_INFO[sim.net.segs.cols.profile[laneSeg(lane)]].rail) || (ctl === Ctl.Zebra && h.pedCrossing(node))) {
      this.schedule(v, h.time + 1); return;
    }
    // the light: red for this arm, wait for its next green (the far model obeys the lights too)
    if (sim.nodePhases[node] > 0) {
      const arm = sim.segArm[laneSeg(lane) * 2 + (laneDir(lane) > 0 ? 1 : 0)];
      if (!h.sig.go(node, arm)) { this.schedule(v, Math.max(h.time + 0.2, h.sig.nextGreen(node, arm, h.time))); return; }
    }
    const dir = sim.net.segs.cols.a[ns] === node ? 1 : -1;
    // meso: enters the least full lane among those valid for the next turn (all lanes carry cars,
    // as in micro; otherwise everyone reaches the window in a single lane)
    const to = h.pickLane(ns, dir, h.segAfter(v, 1), bus, sim.conns.cols.to[conn]);
    if (to < 0 || !sim.net.segs.alive[ns]) { h.lose(v); h.finish(v); return; }
    // queue: a full lane holds the vehicle. As in micro: stopped STUCK_SECONDS, the driver reconsiders the route (a
    // local detour toward an exit with room); a junction jammed for JAM_SECONDS lets one vehicle in every
    // RELEASE_EVERY s, but never more than physically fit (bumper to bumper)
    this.tries++;
    const L = sim.laneLen(to);
    const room = Math.max(1, Math.floor(L / 7.5)), fit = Math.max(room, Math.floor(L / 6.6));
    if (h.laneCount[to] >= room) {
      c.wait[v] += 2; this.full++;
      if (c.wait[v] >= c.patience[v] && !bus && h.routeBudget > 0 && c.held[v] < c.wait[v] - c.patience[v] + 1) {
        c.held[v] = c.wait[v]; // (reconsiders once every patience)
        if (h.reconsider(v, lane, ns)) { this.schedule(v, h.time + 0.5); return; }
      }
      const jammed = c.wait[v] >= JAM_SECONDS && h.time - h.lastAdmit[node] >= JAM_SECONDS && h.time >= h.releaseAt[node];
      if (!jammed || h.laneCount[to] >= fit) { this.schedule(v, h.time + 2); return; }
      h.countRelease(); h.releaseAt[node] = h.time + RELEASE_EVERY;
      if (h.jamAt[node] < h.lastAdmit[node]) { h.jamAt[node] = h.time; h.countJam(); }
    }
    c.wait[v] = 0; c.held[v] = 0;
    const enterMicro = this.inWindow(to);
    const tail = h.laneTail[to];
    if (enterMicro && tail >= 0 && c.s[tail] < c.len[tail] + S0 + 4) { this.schedule(v, h.time + 0.6); return; }
    // counted only once it really goes through (flow inspector, automatic control, jammed-junction detection)
    h.admit(node, sim.segArm[laneSeg(lane) * 2 + (laneDir(lane) > 0 ? 1 : 0)]);
    h.leaveLane(v, lane);
    h.moveToLane(v, lane, to);
    h.enterLane(v, 0);
    c.rIdx[v]++;
    if (enterMicro) {
      // entered the window: becomes micro at the start of the lane
      this.unlink(v);
      c.s[v] = 0;
      c.held[v] = 0;
      c.v[v] = Math.min(laneSpeed(sim.net.segs.cols.profile[ns]) * c.vf[v], tail >= 0 ? Math.max(2, (c.s[tail] - c.len[tail]) / T_HEAD) : 99);
      h.leaveConn(v, -1);
      c.fade[v] = 0;
      h.addMicro(v);
      h.insert(v, false, to);
      return;
    }
    this.enter(v, to);
  }

  private schedule(v: number, t: number): void {
    this.host.cols.tExit[v] = t;
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
      let c = 2 * i + 1;
      if (c >= this.evN) break;
      if (c + 1 < this.evN && this.evT[c + 1] < this.evT[c]) c++;
      if (this.evT[c] >= lt) break;
      this.evT[i] = this.evT[c]; this.evV[i] = this.evV[c]; i = c;
    }
    this.evT[i] = lt; this.evV[i] = lv;
    return v;
  }
}

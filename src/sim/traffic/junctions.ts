// Right of way at junctions: crossings and zebras, yields, exits and the box (roadcraft permission.ts,
// crossings). The connections' claims and the crossings' state are owned here; the vehicles, lanes and routes stay
// with Traffic (the single owner), read through JunctionHost.

import { Ctl, Rule } from '../../roads/control.ts';
import { SegFlag } from '../../roads/flags.ts';
import { PROFILE_INFO } from '../../roads/profiles.ts';
import { Turn, laneCount, laneDir, laneId, laneSeg, laneSpeed, type SimNet } from '../lanes.ts';
import type { Signals } from '../signals.ts';
import type { SimLine } from './lines.ts';
import { End, CLEAR_MARGIN, CROSSING_REACH, CROSSWALK, PED_COURTESY, PED_CRITICAL_GAP, SPAN_REACH, type VehAccess } from './state.ts';
import { bendSpeed } from '../drivers.ts';
import { asNode } from '../../core/ids.ts';

/** The vehicle columns the junction rules write (every other column they only read). */
export type JunctionWrites = 'lane' | 'conn' | 'cameBy' | 's' | 'rIdx' | 'exitC' | 'why';

export interface JunctionHost {
  readonly sim: SimNet;
  readonly veh: { readonly cols: VehAccess<JunctionWrites>; readonly alive: Uint8Array };
  readonly time: number;
  readonly laneHead: Int32Array;
  readonly laneTail: Int32Array;
  readonly laneCount: Uint16Array;
  readonly connHead: Int32Array;
  readonly connTail: Int32Array;
  readonly lines: SimLine[];
  readonly buses: { readonly sets: Array<Set<number>> };
  readonly sig: Signals;
  signals: Uint8Array | null;
  readonly tmp2: Float64Array;
  readonly activeConns: Set<number>;
  pedCrossing(n: number): boolean;
  pedCrossingReach(n: number, mask: number, x: number, z: number, reach: number, front: number): boolean;
  stopBack(lane: number): number;
  nextSeg(v: number): number;
  routeAt(v: number, k: number): number;
  segBetween(a: number, b: number): number;
  replanFrom(v: number, node: number): void;
  finish(v: number): void;
  enterLane(v: number, s: number): void;
  insert(v: number, onConn: boolean, id: number): void;
  unlink(v: number): void;
  setLaneCount(lane: number, delta: number): void;
  keptLane(lane: number): number;
}

export class Junctions {
  /** Per connection: the vehicle that claimed it at its stop line (pass), and when. */
  connPass = new Int32Array(1 << 14).fill(-1);
  connPassT = new Float64Array(1 << 14);
  /** Whoever waits too long at a yield claims the turn (tenths of a second of the simulation clock). */
  connClaim = new Int32Array(1 << 14).fill(-100);
  /** Turn on a full exit lane: whoever has waited STARVE_SECONDS holds the next free spot. */
  exitClaim = new Int32Array((1 << 14) * 16).fill(-1);
  exitClaimT = new Float64Array((1 << 14) * 16);
  /** Level crossings with the barrier down, until when. */
  private crossingClosed = new Map<number, number>();
  /** Vehicles that were inside a junction being rebuilt. */
  private inBox: number[] = [];
  private readonly h: JunctionHost;

  constructor(h: JunctionHost) { this.h = h; }

  clear(): void {
    this.connPass.fill(-1); this.connPassT.fill(0); this.connClaim.fill(-100);
    this.exitClaim.fill(-1); this.exitClaimT.fill(0);
    this.crossingClosed.clear();
    this.inBox.length = 0;
  }

  growConns(cap: number): void {
    const pass = new Int32Array(cap).fill(-1); pass.set(this.connPass); this.connPass = pass;
    const passT = new Float64Array(cap); passT.set(this.connPassT); this.connPassT = passT;
    const claim = new Int32Array(cap).fill(-100); claim.set(this.connClaim); this.connClaim = claim;
  }

  growLanes(cap: number): void {
    const b = new Float64Array(cap); b.set(this.exitClaimT); this.exitClaimT = b;
    const a = new Int32Array(cap).fill(-1); a.set(this.exitClaim); this.exitClaim = a;
  }

  /** Level crossings with the barrier down (for the drawing and the inspector). */
  closedCrossings(): number[] { return [...this.crossingClosed.keys()]; }

  /** The micro side of the exit claim: the vehicle holds the exit it has waited longest for. */
  claimExit(to: number, v: number): void {
    const c = this.h.veh.cols, cl = this.exitClaim[to];
    if (cl === v || cl < 0 || this.h.time - this.exitClaimT[to] >= 1 || !this.h.veh.alive[cl] || c.wait[cl] < c.wait[v]) { this.exitClaim[to] = v; this.exitClaimT[to] = this.h.time; }
  }

  /** The micro side of the pass: a vehicle went over the stop line with the way open. */
  pass(conn: number, v: number): void { this.connPass[conn] = v; this.connPassT[conn] = this.h.time; }

  carsOnCrossing(n: number, arm: number): boolean {
    const sim = this.h.sim, sc = sim.net.segs.cols, c = this.h.veh.cols, k = sim.conns.cols;
    if (arm >= 8 || !sim.net.nodes.alive[n]) return false;
    const seg = sim.armSeg[n * 8 + arm];
    if (!sim.net.segs.alive[seg] || (sc.a[seg] !== n && sc.b[seg] !== n)) return false;
    const back = CROSSWALK, inDir = sc.b[seg] === n ? 1 : -1, p = sc.profile[seg];
    for (const dir of [1, -1]) for (let i = 0, m = laneCount(p, dir); i < m; i++) {
      const lane = laneId(seg, dir, i);
      if (dir === inDir) {
        const h = this.h.laneHead[lane];
        if (h < 0) continue;
        const toLine = sim.laneLen(lane) - c.s[h] - back;
        if (c.pass[h] || toLine < 0 || (toLine < 3 && c.v[h] > 0.5)) return true;
        // too near to stop comfortably before its line (roadcraft permission.ts:131, idm canStopComfortably): the one
        // on foot waits for it (a vehicle already braking for those on the zebra stopped on it)
        if (c.v[h] > 0.5 && toLine < (c.v[h] * c.v[h]) / (2 * Math.max(0.5, c.db[h])) + 1) return true;
        // its turn (roadcraft permission.ts:105-126, PED_COURTESY): standing at the line this long, with the way open
        // to it but for the people stepping off in front of it, it goes next
        if (toLine < 4 && this.courtesyOwed(h)) return true;
      } else {
        const t = this.h.laneTail[lane];
        if (t >= 0 && c.s[t] - c.len[t] < back) return true;
      }
    }
    for (let x = sim.nodeConn[n]; x >= 0; x = k.nextAtNode[x]) {
      // one gone on from this arm into the junction with its body still over the zebra (a lorry's rear is 9.5 m behind
      // its front): the last on each such connection
      if (laneSeg(k.from[x]) === seg) { const t = this.h.connTail[x]; if (t >= 0 && c.s[t] < c.len[t]) return true; }
      if (laneSeg(k.to[x]) !== seg) continue;
      if (this.h.connHead[x] >= 0) return true;
      // a car turning into this arm that has waited its share at its line (permission.ts:90-103), or coming to turn
      // into it too soon to stop for someone stepping off (the critical gap, permission.ts:113-133)
      const h = this.h.laneHead[k.from[x]];
      if (h < 0 || c.exitC[h] !== x) continue;
      const toLine = sim.laneLen(k.from[x]) - c.s[h] - this.h.stopBack(k.from[x]);
      if ((toLine < 4 && this.courtesyOwed(h)) || (c.v[h] > 0.5 && toLine / c.v[h] < PED_CRITICAL_GAP)) return true;
    }
    return false;
  }

  /** Vehicle `v` at its line has stood PED_COURTESY s and its light, if any, is green: the people let it go. */
  private courtesyOwed(v: number): boolean {
    const c = this.h.veh.cols, conn = c.exitC[v];
    if (conn < 0 || c.v[v] > 0.5 || c.wait[v] <= PED_COURTESY) return false;
    return this.h.sim.nodePhases[this.h.sim.conns.cols.node[conn]] === 0 || this.stageGreen(conn);
  }

  /**
   * For a vehicle over its stop line (committed at the line with the way open): the level crossing's barrier is up
   * and nobody is on a connection crossing its own (roadcraft intersections/admission.ts: claims are held until the
   * vehicle has gone through).
   */
  boxClear(conn: number): boolean {
    const sim = this.h.sim, n = sim.conns.cols.node[conn];
    if (sim.nodeCtl[n] === Ctl.Crossing && this.crossingDown(n) && !PROFILE_INFO[sim.net.segs.cols.profile[laneSeg(sim.conns.cols.from[conn])]].rail) return false;
    const list = sim.conflicts.get(conn);
    if (list) for (let i = 0; i < list.length; i++) {
      const d = list[i];
      if (this.h.connHead[d] >= 0) return false;
      // another one over its line for a crossing connection since before this one: it goes first
      if (this.passHolder(d) >= 0 && (this.connPassT[d] < this.connPassT[conn] || (this.connPassT[d] === this.connPassT[conn] && this.connPass[d] < this.connPass[conn]))) return false;
    }
    return true;
  }

  /** The vehicle over its stop line that has claimed connection `d` and not yet entered it, or −1. */
  private passHolder(d: number): number {
    const u = this.connPass[d], c = this.h.veh.cols;
    return u >= 0 && this.h.veh.alive[u] && c.pass[u] && c.conn[u] < 0 && c.exitC[u] === d ? u : -1;
  }

  /**
   * Somebody on the stretch of a zebra connection `conn` drives over (roadcraft crossingSpans.ts: within the heavy
   * body's half width and 0.9 m of its path), or walking towards it and there within the look-ahead plus `front` s
   * (`frontOut` for the zebra it leaves by; roadcraft pedestrianAffectsSpan, admission.ts crossingReachedFirst): where
   * its lane in crosses the zebra of the arm it comes from (`entry`), and where its lane out crosses the one of the arm
   * it leaves by (`exit`).
   */
  pedsInWay(conn: number, front = 0, entry = true, frontOut = front, exit = true): boolean {
    const sim = this.h.sim, k = sim.conns.cols, n = k.node[conn], p = this.h.tmp2;
    const from = k.from[conn], to = k.to[conn];
    sim.lanePoint(from, Math.max(0, sim.laneLen(from) - CROSSWALK / 2), p);
    if (entry && this.h.pedCrossingReach(n, 1 << k.arm[conn], p[0], p[2], SPAN_REACH, front)) return true;
    if (!exit) return false;
    sim.lanePoint(to, Math.min(sim.laneLen(to), CROSSWALK / 2), p);
    return this.h.pedCrossingReach(n, 1 << this.exitArm(conn), p[0], p[2], SPAN_REACH, frontOut);
  }

  /**
   * Seconds, with CLEAR_MARGIN, vehicle `v` takes to bring its front `d` m on from its speed now, speeding up at its
   * comfortable rate to the most it drives through connection `conn` (roadcraft admission.ts travelTime).
   */
  private frontTime(v: number, conn: number, d: number): number {
    const c = this.h.veh.cols, sim = this.h.sim, k = sim.conns.cols;
    const top = Math.max(2, Math.min(laneSpeedOf(sim, k.to[conn]) * c.vf[v], bendSpeed(c, v, k.k[conn], c.kind[v] !== 0)));
    const a = Math.max(0.5, c.da[v]), v0 = Math.min(c.v[v], top), reach = (top * top - v0 * v0) / (2 * a);
    const t = d <= reach ? (-v0 + Math.sqrt(v0 * v0 + 2 * a * d)) / a : (top - v0) / a + (d - reach) / top;
    return CLEAR_MARGIN * t;
  }

  /** The arm of its node that connection `conn` leaves by. */
  private exitArm(conn: number): number {
    const sim = this.h.sim, to = sim.conns.cols.to[conn];
    return sim.segArm[laneSeg(to) * 2 + (laneDir(to) > 0 ? 0 : 1)];
  }

  /** Is the signal stage open for the connection's arm? */
  stageGreen(conn: number, amberToo = false): boolean {
    const k = this.h.sim.conns.cols;
    return this.h.sig.go(k.node[conn], k.arm[conn], amberToo);
  }

  /** Can the connection be used now? (signal, ring priority) — without looking at right of way between vehicles. */
  gateOpen(conn: number): boolean {
    const sim = this.h.sim, k = sim.conns.cols;
    const n = k.node[conn];
    if (sim.nodePhases[n] > 0) return this.stageGreen(conn);
    if (sim.nodeRing[n]) {
      const from = k.from[conn];
      const fromRing = (sim.net.segs.cols.flags[laneSeg(from)] & SegFlag.Ring) !== 0;
      if (fromRing) return true;
      // entry: wait for the ring to be clear (cars approaching the node or going through it)
      for (let c = sim.nodeConn[n]; c >= 0; c = k.nextAtNode[c]) {
        const f = k.from[c];
        if ((sim.net.segs.cols.flags[laneSeg(f)] & SegFlag.Ring) === 0) continue;
        if (this.h.connHead[c] >= 0) return false;
        const t = this.h.laneHead[f];
        if (t >= 0 && sim.laneLen(f) - this.h.veh.cols.s[t] < 18) return false;
      }
      return true;
    }
    return true;
  }

  /** Rank of the arm's rule: main road and signal go first; unsigned in the middle; yield or stop last. */
  private ruleRank(conn: number): number {
    const k = this.h.sim.conns.cols, r = this.h.sim.armRule[k.node[conn] * 8 + k.arm[conn]];
    return r === Rule.Main || r === Rule.Signal ? 3 : r === Rule.Free ? 2 : 1;
  }

  /** Does `d` go before `c`? Arm rule, then the movement (straight > right > left), then whoever comes from the right. */
  private outranks(d: number, c: number): boolean {
    const rd = this.ruleRank(d), rc = this.ruleRank(c);
    if (rd !== rc) return rd > rc;
    const k = this.h.sim.conns.cols;
    const mv = (x: number) => (k.turn[x] === Turn.Straight ? 2 : k.turn[x] === Turn.Right ? 1 : k.turn[x] === Turn.Left ? 0 : -1);
    if (mv(d) !== mv(c)) return mv(d) > mv(c);
    const n = k.node[c], sim = this.h.sim;
    const hx = -sim.armDx[n * 8 + k.arm[c]], hz = -sim.armDz[n * 8 + k.arm[c]];
    const ox = sim.armDx[n * 8 + k.arm[d]], oz = sim.armDz[n * 8 + k.arm[d]];
    return ox * hz - oz * hx < 0; // d's arm is to the right of someone arriving via c
  }

  /** Is someone on connection `d` or about to reach it (for whoever must wait for it)? */
  private connBusy(d: number, me: number, strict: boolean): boolean {
    if (this.h.connHead[d] >= 0) return true;
    const sim = this.h.sim, k = sim.conns.cols, c = this.h.veh.cols;
    const f = k.from[d];
    const h = this.h.laneHead[f];
    if (h < 0 || h === me) return false;
    const dist = sim.laneLen(f) - c.s[h];
    if (dist > 45) return false;
    // is it really taking d?
    const ns = this.h.nextSeg(h);
    if (ns < 0 || laneSeg(k.to[d]) !== ns || sim.connToward(f, ns, c.line[h] >= 0) !== d) return false;
    // the one with right of way is stopped because its exit is full: it will not go now, the other passes
    if (c.v[h] < 0.5 && !this.exitRoom(d, h)) return false;
    // impatience (roadcraft): whoever waits accepts a smaller gap, 0.06 s per second waited, up to 1.5 s (minimum 2.2 s)
    const imp = Math.min(1.5, c.wait[me] * 0.06), gf = c.gapF[me];
    if (strict) return dist < 5 || dist / Math.max(1, c.v[h]) < Math.max(2.2, (3 - imp) * gf);
    // same rule, stopped at the line: first come, first served
    if (c.v[h] < 0.5 && dist < 5) return c.wait[h] > c.wait[me] + 0.3;
    if (sim.nodePhases[k.node[d]] > 0 && !this.stageGreen(d, true)) return false;
    return dist < 6 || dist / Math.max(1, c.v[h]) < Math.max(2.2, (3.5 - imp) * gf);
  }

  /** Is there room on the exit lane? (do not enter the junction only to get stuck in it) */
  exitRoom(conn: number, v: number, extra = 0, deep = false): boolean {
    const sim = this.h.sim, k = sim.conns.cols, c = this.h.veh.cols;
    const to = k.to[conn];
    // the spot is reserved for whoever has waited longest for it (another arm cannot jump the queue)
    const cl = this.exitClaim[to];
    if (cl >= 0 && cl !== v && this.h.time - this.exitClaimT[to] < 1 && this.h.veh.alive[cl]) return false;
    const L = sim.laneLen(to);
    // back-to-back junctions (the lane between them is shorter than a car): it is part of both junctions; the room
    // that counts is on the next lane of the route, minus those on it and those heading to it. Requiring room on the
    // 1 m lane let only one car at a time through the double junction (the worst node of the generated downtown)
    if (L < 8 && !deep) {
      const kk = c.rIdx[v];
      const ns2 = kk + 2 < c.rLen[v] ? this.h.segBetween(this.h.routeAt(v, kk + 1), this.h.routeAt(v, kk + 2)) : -1;
      const c2 = ns2 >= 0 ? sim.connToward(to, ns2, c.line[v] >= 0) : -1;
      if (c2 >= 0) {
        let busy = 0;
        for (let u = this.h.laneHead[to]; u >= 0; u = c.next[u]) busy += c.len[u] + 2;
        for (let x = sim.nodeConn[k.node[conn]]; x >= 0; x = k.nextAtNode[x]) {
          if (k.to[x] !== to) continue;
          for (let u = this.h.connHead[x]; u >= 0; u = c.next[u]) busy += c.len[u] + 2;
        }
        return this.exitRoom(c2, v, busy, true);
      }
    }
    const tail = this.h.laneTail[to];
    // the last one on the lane, moving, frees room in the time it takes to cross (~2 s): those behind may enter
    let room = (tail >= 0 ? c.s[tail] - c.len[tail] + Math.min(c.v[tail], 6) * 1.5 : L) - extra;
    let inbound = 0;
    // those already in the junction heading to the same lane
    for (let x = sim.nodeConn[k.node[conn]]; x >= 0; x = k.nextAtNode[x]) {
      if (k.to[x] !== to) continue;
      for (let u = this.h.connHead[x]; u >= 0; u = c.next[u]) { room -= c.len[u] + 2; inbound++; }
    }
    if (extra > 0) inbound++;
    // empty lane (even a short one): may enter; otherwise it must fit
    if (this.h.laneCount[to] === 0 && inbound === 0) return true;
    // short segment between close junctions: nearly part of the junction; if the last one is moving, one more fits
    if (L < 25 && tail >= 0 && c.v[tail] > 2 && inbound === 0) return true;
    if (this.h.laneCount[to] >= Math.max(1, L / 7.5)) return false;
    return room > Math.min(c.len[v] + 2.5, L * 0.6);
  }

  /** Gate for a vehicle: signal (on amber those who cannot stop go), stop sign, right of way, clear exit. */
  gateFor(conn: number, v: number, toEnd: number): boolean {
    // road splice (uncontrolled two-way node): there is no junction to block; IDM follows the last vehicle on the next
    // lane through the node (`aheadThrough`). Requiring room there stopped the queue at every splice (the city splits
    // roads every ≤112 m) and the stop-and-go spread to the centre: 31 → 196 full exits behind splices in 20 min of peak.
    const sim = this.h.sim, n = sim.conns.cols.node[conn];
    if (sim.net.nodes.cols.deg[n] === 2 && sim.nodeCtl[n] === Ctl.None) return true;
    if (!this.exitRoom(conn, v)) return false;
    return this.gateRules(conn, v, toEnd);
  }

  /**
   * Level crossings (Roadcraft): each train in the micro window closes the barriers of the crossings ahead of it
   * on its route within CROSSING_REACH, and of the one it is on, for 1 s, renewed every step while it is there.
   * The page reads the state in the signals buffer: 128 | the rail arms' bits while the barrier is down, 0 up.
   * Work per step: the trains in the window × the nodes of their route within reach.
   */
  updateCrossings(): void {
    const c = this.h.veh.cols, sim = this.h.sim, sc = sim.net.segs.cols;
    this.h.lines.forEach((ln, li) => {
      if (!ln.mode) return;
      for (const v of this.h.buses.sets[li]) {
        if (!this.h.veh.alive[v]) continue;
        if (c.conn[v] >= 0) { const n = sim.conns.cols.node[c.conn[v]]; if (sim.nodeCtl[n] === Ctl.Crossing) this.crossingClosed.set(n, this.h.time + 1); }
        if (c.lane[v] < 0) continue;
        // a far train has no position on its lane: where it should be by now, from when it entered and when it leaves
        let s = c.s[v];
        if (!c.micro[v]) {
          const L = sim.laneLen(c.lane[v]), span = c.tExit[v] - c.tIn[v];
          s = span > 0 ? L * Math.min(1, Math.max(0, (this.h.time - c.tIn[v]) / span)) : L;
          // its tail is still on the crossing it just went through
          const back = c.rIdx[v] > 0 ? this.h.routeAt(v, c.rIdx[v] - 1) : -1;
          if (back >= 0 && s < c.len[v] && sim.nodeCtl[back] === Ctl.Crossing) this.crossingClosed.set(back, this.h.time + 1);
        }
        let d = sim.laneLen(c.lane[v]) - s;
        for (let k = c.rIdx[v]; k < c.rLen[v] && d < CROSSING_REACH; k++) {
          const n = this.h.routeAt(v, k);
          if (n >= 0 && n < sim.nodeCtl.length && sim.nodeCtl[n] === Ctl.Crossing) this.crossingClosed.set(n, this.h.time + 1);
          if (k + 1 < c.rLen[v]) { const s = this.h.segBetween(n, this.h.routeAt(v, k + 1)); if (s < 0) break; d += sc.len[s]; }
        }
      }
    });
    for (const [n, until] of this.crossingClosed) {
      const open = until < this.h.time || !sim.net.nodes.alive[n];
      if (this.h.signals && n < this.h.signals.length) {
        let mask = 0;
        if (!open) { const segs = sim.net.segsOf(asNode(n), []); segs.forEach((s, a) => { if (PROFILE_INFO[sc.profile[s]].rail) mask |= 1 << a; }); }
        this.h.signals[n] = open ? 0 : 128 | (mask & 63);
      }
      if (open) this.crossingClosed.delete(n);
    }
  }

  /** The barrier of the level crossing at node n is down. */
  crossingDown(n: number): boolean { return (this.crossingClosed.get(n) ?? -1) >= this.h.time; }

  gateRules(conn: number, v: number, toEnd: number): boolean {
    const sim = this.h.sim, k = sim.conns.cols, n = k.node[conn], c = this.h.veh.cols;
    // level crossing with the barrier down: road traffic waits (the train goes through)
    if (sim.nodeCtl[n] === Ctl.Crossing && this.crossingDown(n) && !PROFILE_INFO[sim.net.segs.cols.profile[laneSeg(k.from[conn])]].rail) return false;
    if (sim.nodePhases[n] > 0) {
      if (!this.stageGreen(conn)) {
        if (this.h.sig.amberNow(n) && this.stageGreen(conn, true)) { const sv = c.v[v]; if (toEnd < (sv * sv) / (2 * 3.5)) return true; }
        return false;
      }
    } else if (sim.nodeRing[n]) return this.gateOpen(conn);
    // people on the crosswalks it drives over, the arm it comes from and the arm it leaves by, or who will be on them
    // before its front is: it waits for them (roadcraft admission.ts:339 crossingBusy, crossingReachedFirst; at a light,
    // those still crossing as it turns green and those walking beside it when it turns). No exception for a vehicle
    // too close to stop comfortably: these are already on the zebra (it brakes harder); only those waiting at a kerb
    // wait for it (permission.ts:131). `toEnd` here is to the stop line: the zebra's middle is the stop line's setback
    // less half the zebra on, the zebra it leaves by the connection on. Those who will be there before its front only
    // while it can still stop comfortably at its line (the admission's question); nearer, it is on its way and only
    // those on the stretch or about to step onto it stop it (obstacles.ts pedestrianAhead): asked with the time its
    // front takes, a walker speeding up let it go and stopped it again a moment later, past its line on the zebra.
    // (a zebra between two arms too: there, as anywhere, it gives way to those on the stretch it drives over, not to
    // anyone crossing any arm, which shut it a metre before its line when someone stepped off across another arm)
    if (sim.net.nodes.cols.deg[n] >= 3 || sim.nodeCtl[n] === Ctl.Zebra) {
      const toZebra = Math.max(0, toEnd + this.h.stopBack(k.from[conn]) - CROSSWALK / 2);
      const canStop = toEnd > (c.v[v] * c.v[v]) / (2 * Math.max(0.5, c.db[v]));
      if (canStop ? this.pedsInWay(conn, this.frontTime(v, conn, toZebra), true, this.frontTime(v, conn, toZebra + CROSSWALK + k.len[conn])) : this.pedsInWay(conn)) return false;
    }
    if (sim.armRule[n * 8 + k.arm[conn]] === Rule.Stop && c.wait[v] < 1.2) return false; // stop sign: halt before going on
    // right of way: wait for those who go first (at a signal, only the permitted conflict, such as a left turn)
    const list = sim.conflicts.get(conn);
    if (!list) return true;
    // someone over its line for a crossing connection holds it: wait for it to go through (not at a level crossing:
    // a car there waits for the barrier, the train does not wait for the car)
    if (sim.nodeCtl[n] !== Ctl.Crossing) for (let i = 0; i < list.length; i++) if (this.passHolder(list[i]) >= 0) return false;
    const stuck = c.wait[v] > 8; // nobody stays stuck forever: after 12 s only those already in the junction are respected
    const now = Math.round(this.h.time * 10);
    // and claims the turn: those on the priority road who can still stop comfortably let it through
    if (stuck) this.connClaim[conn] = now;
    const sv = c.v[v], canStop = toEnd > (sv * sv) / (2 * 3) + 1;
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      if (stuck) { if (this.h.connHead[d] >= 0) return false; continue; }
      if (canStop && now - this.connClaim[d] < 6) return false;
      if (sim.nodePhases[n] > 0 && !this.stageGreen(d, true) && this.h.connHead[d] < 0) continue;
      const higher = this.outranks(d, conn);
      if (higher && this.connBusy(d, v, this.ruleRank(d) > this.ruleRank(conn))) return false;
      if (!higher && this.h.connHead[d] >= 0 && this.ruleRank(d) >= this.ruleRank(conn)) return false; // do not drive into someone already going through
    }
    return true;
  }

  /** Steps the actuated lights and writes EVERY signalled node's state for the drawing: the far ones answer by the
   * timed cycle, so what is drawn always matches what the cars obey — no decorative fake light out of the window. */
  evacuateConn(conn: number): void {
    const c = this.h.veh.cols, sim = this.h.sim;
    // those on it wait out the rebuild where they are (their exit lane kept in exitC); `nodesRebuilt` puts them on
    // the new connection with the same lanes, at the same place
    for (let v = this.h.connHead[conn]; v >= 0;) {
      const next = c.next[v];
      this.h.unlink(v);
      c.conn[v] = -1; c.cameBy[v] = -1;
      c.exitC[v] = sim.conns.cols.to[conn];
      this.inBox.push(v);
      v = next;
    }
    this.h.connHead[conn] = -1; this.h.connTail[conn] = -1;
    this.h.activeConns.delete(conn);
  }

  /** After a rebuild: each vehicle that was inside a junction goes back onto the connection with the same lanes. */
  resettleBox(): void {
    const c = this.h.veh.cols, sim = this.h.sim, k = sim.conns.cols;
    for (const v of this.inBox.splice(0)) {
      if (!this.h.veh.alive[v] || c.conn[v] >= 0 || !c.micro[v]) continue;
      const from = c.lane[v], to = c.exitC[v];
      let conn = -1;
      if (from >= 0 && sim.net.segs.alive[laneSeg(from)]) for (let x = sim.laneConn[from]; x >= 0; x = k.nextFromLane[x]) if (k.to[x] === to) { conn = x; break; }
      if (conn >= 0) { c.conn[v] = conn; c.s[v] = Math.min(c.s[v], k.len[conn] - 0.1); this.h.insert(v, true, conn); continue; }
      // that movement is gone: onto the exit lane (the outermost one left, after a new profile), behind whoever is there
      if (!sim.net.segs.alive[laneSeg(to)]) { c.why[v] = End.Lost; this.h.finish(v); continue; }
      const kept = this.h.keptLane(to);
      if (kept < 0) { c.why[v] = End.Lost; this.h.finish(v); continue; }
      this.h.setLaneCount(c.lane[v], -1);
      this.h.setLaneCount(kept, 1);
      const tail = this.h.laneTail[kept];
      c.lane[v] = kept; c.s[v] = tail >= 0 ? Math.max(0, c.s[tail] - c.len[tail] - 1) : 0; c.rIdx[v]++;
      this.h.enterLane(v, c.s[v]);
      if (c.rIdx[v] >= c.rLen[v] || this.h.routeAt(v, c.rIdx[v]) !== sim.laneTo(kept)) this.h.replanFrom(v, sim.laneTo(kept));
      this.h.insert(v, false, kept);
    }
  }

  /** Rebuilt nodes: a new plan for their lights, which start their cycle again. */
}

/** The limit (m/s) of the lane `lane`'s road. */
function laneSpeedOf(sim: SimNet, lane: number): number { return laneSpeed(sim.net.segs.cols.profile[laneSeg(lane)]); }

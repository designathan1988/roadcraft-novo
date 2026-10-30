// The near model: IDM car-following with the driver's own figures, moving along a lane and through a connection,
// the bend's speed, the jammed-junction release, the detour of a blocked exit and the route reconsideration. The
// vehicle table, the lane lists and the world stay with Traffic (the owner), read through MicroHost.

import type { Columns } from '../../core/table.ts';
import { Turn, laneCount, laneDir, laneId, laneIdx, laneSeg, laneSpeed, type SimNet } from '../lanes.ts';
import { Ctl } from '../../roads/control.ts';
import { bendSpeed, desiredSpeed, driveAccel } from '../drivers.ts';
import type { Router } from '../routing.ts';
import type { FlowAdvisor } from '../advisor.ts';
import type { LaneChanges } from './laneChanges.ts';
import type { Meso } from './meso.ts';
import type { Buses } from './buses.ts';
import type { Junctions } from './junctions.ts';
import type { SimLine } from './lines.ts';
import { CROSSWALK, DWELL, JAM_SECONDS, PED_BODY, PARK_SIDE_S, RELEASE_EVERY, REJOIN, ROUTE_CAP, STARVE_SECONDS, type vehSchema, VehPhase } from './state.ts';
import { TERMINAL_DWELL } from './buses.ts';

export interface MicroHost {
  readonly sim: SimNet;
  readonly veh: { readonly cols: Columns<typeof vehSchema>; readonly alive: Uint8Array };
  readonly time: number;
  readonly laneHead: Int32Array;
  readonly laneTail: Int32Array;
  readonly laneCount: Uint16Array;
  readonly connHead: Int32Array;
  readonly connTail: Int32Array;
  readonly routes: Int32Array;
  readonly router: Router;
  readonly meso: Meso;
  readonly buses: Buses;
  readonly junctions: Junctions;
  readonly laneChanges: LaneChanges;
  readonly advisor: FlowAdvisor;
  readonly nodePass: Uint32Array;
  readonly lastAdmit: Float64Array;
  readonly releaseAt: Float64Array;
  readonly jamAt: Float64Array;
  readonly activeLanes: Set<number>;
  readonly activeConns: Set<number>;
  readonly lines: SimLine[];
  readonly docks: Float32Array;
  released: number;
  jams: number;
  ranRed: number;
  reroutes: number;
  routeBudget: number;
  pedCrossing(n: number): boolean;
  arrive(v: number, lane: number, toEnd: number): number;
  atDestination(v: number): boolean;
  dropsOff(v: number): boolean;
  enterLane(v: number, s: number): void;
  finish(v: number): void;
  inWindowOut(lane: number): boolean;
  insert(v: number, onConn: boolean, id: number): void;
  kerbStep(v: number, lane: number, dt: number): void;
  leaveLane(v: number, lane: number): void;
  nearCam(lane: number): boolean;
  nextSeg(v: number): number;
  removeMicro(v: number): void;
  replanFrom(v: number, node: number): void;
  routeAt(v: number, k: number): number;
  segAfter(v: number, k: number): number;
  segBetween(a: number, b: number): number;
  setLaneCount(lane: number, delta: number): void;
  stopBack(lane: number): number;
  tryDock(v: number, lane: number): boolean;
  unlink(v: number): void;
}

export class Micro {
  private readonly h: MicroHost;

  constructor(h: MicroHost) { this.h = h; }

  idm(u: number, v: number, v0: number, gap: number, vl: number): number {
    const c = this.h.veh.cols, am = c.da[u], b = c.db[u];
    const dv = v - vl;
    // queue discharge (roadcraft): the one ahead has left and I am still slow → keep a shorter gap and react
    // faster (up to 60%, gone at 4 m/s); the queue moves off together, without an accordion effect
    const rel = vl > 0.3 && v < 4 ? 0.6 * (1 - v / 4) * Math.min(1, vl / 1.5) : 0;
    const sStar = c.ds0[u] * (1 - rel) + Math.max(0, v * c.dT[u] * (1 - rel) + (v * dv) / (2 * Math.sqrt(am * b)));
    const g = Math.max(0.1, gap);
    return am * (1 - Math.pow(v / Math.max(0.1, v0), 4) - (sStar / g) * (sStar / g));
  }

  stepMicro(dt: number): void {
    const c = this.h.veh.cols, sim = this.h.sim, step = ++this.microStep;
    // connections first (they are ahead of the lanes that feed them)
    for (const conn of [...this.h.activeConns]) {
      for (let v = this.h.connHead[conn]; v >= 0;) {
        const next = c.next[v];
        if (c.moved[v] !== step) { c.moved[v] = step; this.moveOnConn(v, conn, dt); }
        v = next;
      }
    }
    for (const lane of [...this.h.activeLanes]) {
      if (!sim.net.segs.alive[laneSeg(lane)]) continue;
      for (let v = this.h.laneHead[lane]; v >= 0;) {
        const next = c.next[v];
        if (c.moved[v] !== step) { c.moved[v] = step; this.moveOnLane(v, lane, dt); }
        v = next;
      }
    }
  }
  microStep = 0;

  /**
   * Braking for the bends ahead (roadcraft 4.0 `curveSpeedCap`): connection `conn` starts `d` m ahead, and after it
   * and its lane the route's next turn. For each bend slower than the vehicle, the steady deceleration that reaches
   * its speed at its start, applied once it reaches 80 % of the driver's comfortable braking (up to the emergency one).
   * Returns the acceleration limit (Infinity: none).
   */
  bendBrake(v: number, conn: number, d: number): number {
    const c = this.h.veh.cols, sim = this.h.sim, k = sim.conns.cols, heavy = c.kind[v] !== 0, speed = c.v[v];
    let limit = Infinity, at = d, x = conn;
    const horizon = (speed * speed) / (2 * c.db[v]) + 20;
    for (let i = 0; i < 2 && x >= 0 && at < horizon; i++) {
      const vb = bendSpeed(c, v, this.bendK(v, x), heavy);
      if (speed > vb) {
        const need = (speed * speed - vb * vb) / (2 * Math.max(0.5, at - 0.5));
        if (need >= c.db[v] * 0.8) limit = Math.min(limit, -Math.min(c.dbe[v], Math.max(need, c.db[v] * 0.8)));
      }
      // and the turn after: past this connection and the lane it leads to (its exit along the route)
      if (i > 0) break;
      const after = this.h.segAfter(v, 1), to = k.to[x];
      if (after < 0) break;
      at += k.len[x] + sim.laneLen(to);
      x = this.connAfter(to, after, c.line[v] >= 0);
    }
    return limit;
  }

  /** Curvature of a connection for vehicle `v`: a train reverses at the end of its line (drawn as a loop), so none there. */
  bendK(v: number, conn: number): number {
    const k = this.h.sim.conns.cols;
    return this.h.veh.cols.kind[v] === 4 && k.turn[conn] === Turn.UTurn ? 0 : k.k[conn];
  }

  /** The connection from `lane` (or the lane of its segment it will change to) toward segment `seg`; −1 if none. */
  connAfter(lane: number, seg: number, bus: boolean): number {
    const sim = this.h.sim;
    let x = sim.connToward(lane, seg, bus);
    if (x < 0) { const l2 = sim.laneToward(laneSeg(lane), laneDir(lane), seg, laneIdx(lane), bus); if (l2 >= 0) x = sim.connToward(l2, seg, bus); }
    return x;
  }

  /** Distance to the rearmost vehicle on the connection/lane ahead (to follow through the node). */
  aheadThrough(conn: number): [number, number] {
    const c = this.h.veh.cols, k = this.h.sim.conns.cols;
    const t = this.h.connTail[conn];
    if (t >= 0) return [c.s[t] - c.len[t], c.v[t]];
    const lt = this.h.laneTail[k.to[conn]];
    if (lt >= 0) return [k.len[conn] + c.s[lt] - c.len[lt], c.v[lt]];
    return [k.len[conn] + 60, 99];
  }

  moveOnLane(v: number, lane: number, dt: number): void {
    const c = this.h.veh.cols, sim = this.h.sim;
    // manoeuvring while still in the lane: stopped there, so those behind wait (or change lanes)
    if (c.phase[v] === VehPhase.Manoeuvre) { c.v[v] = 0; c.brk[v] = 1; return; }
    if (c.phase[v] === VehPhase.KerbStop) { this.h.kerbStep(v, lane, dt); return; }
    const L = sim.laneLen(lane);
    const p = sim.net.segs.cols.profile[laneSeg(lane)];
    // the limit, and the lane's own bend (a sharply curved road is driven slower)
    let v0 = Math.min(desiredSpeed(c, v, laneSpeed(p) * c.vf[v], this.h.time), bendSpeed(c, v, sim.segK[laneSeg(lane)], c.kind[v] !== 0));
    let gap = 1e9, vl = 99;
    /** Where it must have stopped by, whatever its comfort (a bus or train stop: no further than just past it). */
    let stopRoom = 1e9;
    const lead = c.prev[v];
    if (lead >= 0) { gap = c.s[lead] - c.len[lead] - c.s[v]; vl = c.v[lead]; }
    // end of the lane: destination, signal or whatever comes after the node
    let conn = -1, release = false;
    // bus: the stop is an obstacle until it halts and serves it
    let atStop = false;
    if (c.line[v] >= 0 && !c.phase[v]) {
      const ln = this.h.lines[c.line[v]];
      if (ln && ln.stopLane[c.stopI[v]] === lane) {
        const sg = ln.stopV[c.stopI[v]] - c.s[v];
        if (sg > -2) {
          if (sg < 1.2 && c.v[v] < 0.4) {
            c.dwell[v] += dt;
            if (c.dwell[v] >= (ln.mode ? 25 : ln.term.has(c.stopI[v]) ? TERMINAL_DWELL : DWELL)) { c.dwell[v] = 0; this.h.buses.serve(v); }
            else atStop = true;
          }
          if (lead < 0 || sg + c.ds0[v] < gap) { gap = Math.min(gap, Math.max(0, sg) + c.ds0[v]); vl = 0; } // (its own standstill gap: it halts at the stop)
          stopRoom = Math.max(0, sg) + 0.5;
        }
      }
    }
    if (c.phase[v]) { /* leaving */ }
    // a truck bound for a yard turns in at its gate as it drives past (tried every second: planning the reverse costs)
    else if (this.h.atDestination(v) && c.line[v] < 0 && c.kind[v] === 2 && this.h.docks.length && (this.microStep + v) % 20 === 0 && this.h.nearCam(lane) && this.h.tryDock(v, lane)) return;
    else if (this.h.atDestination(v) && c.line[v] < 0) {
      // near the camera cars and trucks decide 30 m before the end (room for the manoeuvre); the rest at 12 m
      // (a drop-off that drives straight on decides with room to brake for the next turn)
      let room = c.micro[v] && (c.kind[v] === 0 || c.kind[v] === 2) && this.h.nearCam(lane) ? 30 : 12;
      if (this.h.dropsOff(v)) room = Math.max(room, (c.v[v] * c.v[v]) / (2 * c.db[v]) + 25);
      if (L - c.s[v] < room) { const r = this.h.arrive(v, lane, L - c.s[v]); if (r === 1) return; if (r === 2) c.phase[v] = VehPhase.Leaving; }
    } else {
      let ns = this.h.nextSeg(v);
      if (ns < 0 && !c.phase[v]) { this.h.replanFrom(v, sim.laneTo(lane)); ns = this.h.nextSeg(v); }
      if (ns >= 0) conn = sim.connToward(lane, ns, c.line[v] >= 0);
      if (conn < 0) {
        // wrong lane: try to change; otherwise take any connection and replan
        if (ns >= 0) this.h.laneChanges.mandatory(v, lane, ns);
        conn = sim.laneConn[lane];
        if (conn < 0 && lead < 0 && c.lane[v] === lane) this.h.laneChanges.escape(v, lane);
      }
      // it just moved to the next lane over: it goes on from there in the next step (this lane's leader, length and
      // connection no longer apply)
      if (c.lane[v] !== lane) return;
      // stopped for 10 s in the queue of a full lane (not at the red of a lane with room): reconsider the
      // route, avoiding what is full (roadcraft reconsiderRoute). At the line it is too late to change (as in
      // roadcraft): there `detour` handles it, and only toward an exit with room
      if (c.held[v] >= c.patience[v] && lead >= 0 && c.line[v] < 0 && this.h.routeBudget > 0) {
        c.held[v] = 0;
        if (this.h.laneCount[lane] >= 0.6 * L / 7.5 && this.reconsider(v, lane, -1)) {
          const ns2 = this.h.nextSeg(v);
          if (ns2 >= 0 && sim.connToward(lane, ns2, false) < 0) this.h.laneChanges.mandatory(v, lane, ns2);
          if (c.lane[v] !== lane) return;
        }
      }
      {
        // the stop line is before the crosswalk (roadcraft): the last metres of the lane are the zebra, kept clear.
        // Every vehicle checks it, not only the leader: a follower must not cross on red behind a leader.
        const toEnd = L - c.s[v], back = this.h.stopBack(lane), toLine = toEnd - back;
        if (toLine < 6 && c.v[v] < 0.5) c.wait[v] += dt;
        // exit blocked for a while: the driver detours via another free exit of this lane
        if (lead < 0 && conn >= 0 && c.wait[v] > 6 && c.lcCool[v] <= 0 && !this.h.junctions.exitRoom(conn, v)) {
          c.lcCool[v] = 5;
          const alt = this.detour(v, lane, conn);
          if (alt >= 0) conn = alt;
        }
        // waiting for the full exit for a long time: reserve its next free spot (the longest waiter wins)
        if (conn >= 0 && toLine < 6 && c.wait[v] > STARVE_SECONDS) this.h.junctions.claimExit(sim.conns.cols.to[conn], v);
        // jammed junction (nobody through for 20 s and this one waiting 20 s): one at a time, with the box clear
        if (lead < 0 && conn >= 0 && toLine < 6 && c.wait[v] > JAM_SECONDS) release = this.jamRelease(conn, v);
        // with the way open where it can no longer stop comfortably at the line, it is committed and goes on through (it
        // is not left standing on the zebra; roadcraft admission is asked while the vehicle can still stop); short of
        // that it stops at the line (on it already, at the end of the lane). Committed only at the line, a way that shut
        // in its last metre (the exit full, someone into the box) stopped it hard past the line on the zebra.
        const commit = Math.max(0.3, (c.v[v] * c.v[v]) / (2 * Math.max(0.5, c.db[v])));
        let open = c.pass[v] === 1;
        if (!open) {
          open = conn >= 0 && (release || this.h.junctions.gateFor(conn, v, Math.max(0, toLine)));
          // it commits only into a clear box (nobody crossing its way inside, the barrier up): what it crosses over after
          // the line, it does not stop on
          if (open && !release && toLine < commit && !this.h.junctions.boxClear(conn)) open = false;
          // (just over it when the way closed: still at the line, it has stopped there; well over it, at the end)
          if (!open) { gap = Math.min(gap, toLine > -1 ? Math.max(0, toLine - 0.3) : toEnd - 1); vl = 0; }
          else if (toLine < commit) {
            c.pass[v] = 1;
            // the connection is its own from here (roadcraft claims.ts grantAll at admission): crossing ones wait for it
            this.h.junctions.pass(conn, v);
            if (sim.nodePhases[sim.laneTo(lane)] > 0 && !this.h.junctions.stageGreen(conn, true)) this.h.ranRed++;
          }
        }
        // over the line, the light no longer stops it; a barrier coming down, someone in the box or somebody on (or
        // coming onto) the stretch of a zebra ahead it drives over still does (roadcraft obstacles.ts pedestrianAhead):
        // the one it comes from while its front is short of it (the stop line is before it: over the line, it is still
        // ahead), stopping short of the walker; the one it leaves by, at the end of the lane (into the box only when
        // the way out is clear)
        const J = this.h.junctions, pass = open && c.pass[v] === 1 && conn >= 0;
        if (pass && toEnd > CROSSWALK / 2 && J.pedsInWay(conn, 0, true, 0, false)) { gap = Math.min(gap, Math.max(0, toEnd - CROSSWALK / 2 - PED_BODY - 0.3)); vl = 0; }
        else if (pass && (!J.boxClear(conn) || J.pedsInWay(conn, 0, false))) { gap = Math.min(gap, toEnd - 1); vl = 0; }
        else if (open && conn >= 0) { const [g2, v2] = this.aheadThrough(conn); if (toEnd + g2 < gap) { gap = toEnd + g2; vl = v2; } } // (does not override the bus stop)
        // bus and train: a stop just past the node already counts for braking (a fast train cannot stop in 20 m)
        const sg = this.stopAhead(v, conn);
        if (sg >= 0 && toEnd + sg < gap) { gap = toEnd + sg; vl = 0; }
        if (sg >= 0) stopRoom = Math.min(stopRoom, toEnd + sg + 0.5);
      }
    }
    // the turn ahead: slow enough by the line to take its bend within the driver's lateral comfort (braking on time)

    // what the car ahead is doing, when it is the obstacle (the stop line, a stop or a red stand still)
    const al = lead >= 0 && gap === c.s[lead] - c.len[lead] - c.s[v] ? c.acc[lead] : 0;
    let a = driveAccel(c, v, c.v[v], v0, gap, vl, al, dt, stopRoom);
    // the bends ahead (this junction's turn, and the next one's after a short lane): braked for in time
    if (conn >= 0) a = Math.min(a, this.bendBrake(v, conn, L - c.s[v]));
    if (c.phase[v]) a = Math.min(a, 0); // an arrived vehicle disappears without braking in front of others
    if (c.pk[v] > 0 && !c.phase[v] && c.dwell[v] < 1.2) a = -9; // in the bay, waiting to pull out
    if (c.mv[v] >= 0) a = -9; // pulling out of the bay: held until the manoeuvre is back in the lane
    if (atStop) a = Math.min(a, -2);
    a = Math.max(-9, a);
    const nv = Math.max(0, c.v[v] + a * dt);
    c.acc[v] = (nv - c.v[v]) / dt;
    c.exitC[v] = conn;
    c.brk[v] = a < -1.2 || nv < 0.4 ? 1 : 0;
    // pulling out of the bay: the drawing slides from the kerb to the lane (the simulation already has it in the lane)
    if (c.pk[v] > 0 && !c.phase[v] && c.mv[v] < 0 && (c.dwell[v] += dt) > 1.2) c.pk[v] = Math.max(0, c.pk[v] - dt / PARK_SIDE_S);
    c.s[v] += (c.v[v] + nv) * 0.5 * dt;
    c.v[v] = nv;
    if (c.lcT[v] < 1) c.lcT[v] = Math.min(1, c.lcT[v] + dt / 2.2);
    c.lcCool[v] -= dt;
    if (c.phase[v]) { c.fade[v] -= dt * 1.5; if (c.fade[v] <= 0) this.h.finish(v); return; }
    if (c.fade[v] < 1) c.fade[v] = Math.min(1, c.fade[v] + dt * 1.2);
    if (nv < 0.5) c.held[v] += dt; else c.held[v] = 0;
    if (c.s[v] >= L) {
      // lane with no exit at all (the turn was from another lane and the change failed): stop at the line and change
      // lanes when there is room (`escapeLane`), instead of disappearing
      if (conn < 0) { c.s[v] = L - 0.01; c.v[v] = 0; return; }
      if (!release && (c.pass[v] ? !this.h.junctions.boxClear(conn) : !this.h.junctions.gateFor(conn, v, 0))) { c.s[v] = L - 0.01; c.v[v] = 0; return; }
      // enter the connection
      this.h.leaveLane(v, lane);
      this.h.unlink(v);
      c.s[v] -= L;
      c.conn[v] = conn;
      c.wait[v] = 0;
      c.held[v] = 0;
      const k = sim.conns.cols;
      // an invariant kept as a count (roadcraft invariants.ts): nobody enters a junction on red (amber is a go for
      // whoever cannot stop); one that crossed the stop line with the way open was counted there
      if (!c.pass[v] && sim.nodePhases[k.node[conn]] > 0 && !this.h.junctions.stageGreen(conn, true)) this.h.ranRed++;
      if (release) { this.h.released++; this.h.releaseAt[k.node[conn]] = this.h.time + RELEASE_EVERY; this.h.nodePass[k.node[conn]]++; this.h.advisor.pass[k.node[conn] * 8 + k.arm[conn]]++; }
      else this.admit(k.node[conn], k.arm[conn]);
      this.h.insert(v, true, conn);
      return;
    }
    if (c.lcCool[v] <= 0 && lead >= 0) this.h.laneChanges.discretionary(v, lane);
  }

  /** Someone went through node `n` from arm `arm` (micro or meso): arm flow and "the node is moving". */
  admit(n: number, arm: number): void {
    this.h.nodePass[n]++;
    this.h.advisor.pass[n * 8 + arm]++;
    this.h.lastAdmit[n] = this.h.time;
  }

  /**
   * Jammed junction (roadcraft invariants: nobody has gone through for JAM_SECONDS and `v` has waited at the line
   * that long): `v` may go without waiting for its turn or for the exit, one vehicle every RELEASE_EVERY s, only
   * with the box clear (nobody on connections crossing its own) and no pedestrian on the crosswalk. At a signal only
   * those on green (held by the full exit): nobody runs the red. In a cycle of full lanes, each one entering the box
   * frees a spot behind and the wheel turns.
   */
  jamRelease(conn: number, v: number): boolean {
    const sim = this.h.sim, k = sim.conns.cols, n = k.node[conn];
    if (this.h.time - this.h.lastAdmit[n] < JAM_SECONDS || this.h.time < this.h.releaseAt[n]) return false;
    if (this.h.veh.cols.wait[v] < JAM_SECONDS) return false;
    if (this.h.jamAt[n] < this.h.lastAdmit[n]) { this.h.jamAt[n] = this.h.time; this.h.jams++; } // new jam
    if (sim.nodePhases[n] > 0 && !this.h.junctions.stageGreen(conn, true)) return false;
    if (this.h.connHead[conn] >= 0 && this.h.veh.cols.s[this.h.connTail[conn]] < this.h.veh.cols.len[this.h.connTail[conn]] + 2) return false;
    if (this.h.pedCrossing(n)) return false;
    const list = sim.conflicts.get(conn);
    if (list) for (let i = 0; i < list.length; i++) if (this.h.connHead[list[i]] >= 0) return false;
    return true;
  }

  /**
   * A driver stopped for STUCK_SECONDS reconsiders the route (roadcraft reconsiderRoute): the search already avoids
   * full roads (cost by occupancy) and, if the exit it wanted is full, bans that segment.
   * With no other path it keeps the previous route. Returns whether the route changed.
   */
  reconsider(v: number, lane: number, blocked: number): boolean {
    const c = this.h.veh.cols, sim = this.h.sim;
    if (c.line[v] >= 0 || this.h.routeBudget <= 0) return false;
    const node = sim.laneTo(lane);
    // the route continues from `node` (rIdx points at it); the detour is local: it rejoins the route a few nodes
    // ahead (short, cheap search), and the rest of the route stays as it was
    const o = v * ROUTE_CAP, k0 = c.rIdx[v], len = c.rLen[v];
    if (k0 >= len || this.h.routes[o + k0] !== node || k0 + 1 >= len) return false;
    const j = Math.min(len - 1, k0 + REJOIN);
    const target = this.h.routes[o + j];
    this.h.routeBudget--;
    const lim = this.h.router.limit;
    this.h.router.limit = 600;
    const n = this.h.router.route(node, target, this.detourPath, 0, ROUTE_CAP, false, laneSeg(lane), false, blocked);
    this.h.router.limit = lim;
    if (n < 2 || this.detourPath[n - 1] !== target) return false;
    // only a detour this lane can reach (no forced lane change in the queue, which ended in a wrong connection
    // and a route rebuilt from scratch on the other side)
    const first = this.h.segBetween(this.detourPath[0], this.detourPath[1]);
    if (first < 0 || this.h.sim.connToward(lane, first, false) < 0) return false;
    // nothing changed (the same node sequence): keep it
    let same = n === j - k0 + 1;
    for (let i = 0; same && i < n; i++) same = this.detourPath[i] === this.h.routes[o + k0 + i];
    if (same) return false;
    // new route: detour + what remained after the rejoin point (as far as it fits)
    this.splice(v, 0, n, j);
    this.h.reroutes++;
    return true;
  }
  detourPath = new Int32Array(ROUTE_CAP);
  tailTmp = new Int32Array(ROUTE_CAP);

  /** New route of `v`: `pre` nodes already in routes[0..pre), the detour (`detourPath`, n nodes) and what remained of the route after index `j`. */
  splice(v: number, pre: number, n: number, j: number): void {
    const c = this.h.veh.cols, o = v * ROUTE_CAP, len = c.rLen[v];
    const tail = this.tailTmp, rest = Math.max(0, Math.min(len - j - 1, ROUTE_CAP - pre - n));
    for (let i = 0; i < rest; i++) tail[i] = this.h.routes[o + j + 1 + i];
    for (let i = 0; i < n; i++) this.h.routes[o + pre + i] = this.detourPath[i];
    for (let i = 0; i < rest; i++) this.h.routes[o + pre + n + i] = tail[i];
    c.rLen[v] = pre + n + rest; c.rIdx[v] = 0;
  }

  /**
   * Another connection of the lane with room at the exit; the route is rebuilt from it, rejoining the previous route
   * a few nodes ahead (short search; with no rejoin nearby, all the way to the destination). −1 if none.
   */
  detour(v: number, lane: number, blocked: number): number {
    const c = this.h.veh.cols, sim = this.h.sim, k = sim.conns.cols;
    if (c.line[v] >= 0 || this.h.routeBudget <= 0) return -1;
    const o = v * ROUTE_CAP, k0 = c.rIdx[v], len = c.rLen[v];
    for (let x = sim.laneConn[lane]; x >= 0; x = k.nextFromLane[x]) {
      if (x === blocked || k.turn[x] === Turn.UTurn) continue;
      const to = k.to[x];
      if (sim.isBusLane(to) || !this.h.junctions.exitRoom(x, v)) continue;
      const far = sim.laneTo(to);
      this.h.routeBudget--;
      const j = Math.min(len - 1, k0 + REJOIN + 1), target = this.h.routes[o + j];
      if (k0 < len && j > k0 + 1 && target !== far) {
        const lim = this.h.router.limit;
        this.h.router.limit = 600;
        const n = this.h.router.route(far, target, this.detourPath, 0, ROUTE_CAP - 1, false, laneSeg(to));
        this.h.router.limit = lim;
        if (n >= 2 && this.detourPath[n - 1] === target) { this.h.routes[o] = k.node[x]; this.splice(v, 1, n, j); return x; }
      }
      const n = this.h.router.route(far, c.dest[v], this.h.routes, o + 1, ROUTE_CAP - 1, false, laneSeg(to));
      if (n < 1) continue;
      this.h.routes[o] = k.node[x];
      c.rLen[v] = n + 1; c.rIdx[v] = 0;
      return x;
    }
    return -1;
  }

  /** Distance from the start of the connection to the stop (if the stop is on the lane after it), or −1. */
  stopAhead(v: number, conn: number): number {
    const c = this.h.veh.cols;
    if (c.line[v] < 0 || conn < 0) return -1;
    const ln = this.h.lines[c.line[v]];
    if (!ln || ln.stopLane[c.stopI[v]] !== this.h.sim.conns.cols.to[conn]) return -1;
    return this.h.sim.conns.cols.len[conn] + ln.stopV[c.stopI[v]];
  }

  moveOnConn(v: number, conn: number, dt: number): void {
    const c = this.h.veh.cols, sim = this.h.sim, k = sim.conns.cols;
    const L = k.len[conn];
    const to = k.to[conn];
    // through the junction at the limit, or at the speed its bend allows within the driver's lateral comfort
    const v0 = Math.min(desiredSpeed(c, v, laneSpeed(sim.net.segs.cols.profile[laneSeg(to)]) * c.vf[v], this.h.time), bendSpeed(c, v, this.bendK(v, conn), c.kind[v] !== 0));
    let gap = 1e9, vl = 99;
    const lead = c.prev[v];
    if (lead >= 0) { gap = c.s[lead] - c.len[lead] - c.s[v]; vl = c.v[lead]; }
    else {
      const lt = this.h.laneTail[to];
      if (lt >= 0) { gap = L - c.s[v] + c.s[lt] - c.len[lt]; vl = c.v[lt]; }
      // another connection merging into the same lane: whoever is closer to the end goes first (without it both
      // arrived together and one appeared inside the other at the start of the lane)
      const mine = L - c.s[v];
      for (let x = sim.nodeConn[k.node[conn]]; x >= 0; x = k.nextAtNode[x]) {
        if (x === conn || k.to[x] !== to) continue;
        const h = this.h.connHead[x];
        if (h < 0) continue;
        const ahead = k.len[x] - c.s[h];
        if (ahead < mine || (ahead === mine && h < v)) { const g = mine - ahead - c.len[h]; if (g < gap) { gap = g; vl = c.v[h]; } }
      }
    }
    // somebody on (or coming onto) the stretch of the zebra it leaves by: it stops short of the walker, unless its
    // front is over it already (roadcraft obstacles.ts pedestrianAhead, on a connector: the span along it less a margin)
    const toWalker = L - c.s[v] + CROSSWALK / 2 - PED_BODY;
    if (toWalker > 0 && this.h.junctions.pedsInWay(conn, 0, false)) { const g = Math.max(0, toWalker - 0.3); if (g < gap) { gap = g; vl = 0; } }
    const sg = this.stopAhead(v, conn);
    if (sg >= 0 && sg - c.s[v] < gap) { gap = Math.max(0, sg - c.s[v]); vl = 0; }
    if (c.lcT[v] < 1) c.lcT[v] = Math.min(1, c.lcT[v] + dt / 2.2); // a lane change finishing on the way through
    const al = lead >= 0 && gap === c.s[lead] - c.len[lead] - c.s[v] ? c.acc[lead] : 0;
    let a = Math.max(-9, driveAccel(c, v, c.v[v], v0, gap, vl, al, dt, sg >= 0 ? Math.max(0, sg - c.s[v]) + 0.5 : 1e9));
    if (c.v[v] > v0 + 0.3) a = Math.min(a, -c.db[v]); // in the bend too fast (it came in late): brakes, not coasts
    // the next junction's turn, after the lane this connection leads to
    const next = this.h.segAfter(v, 1);
    if (next >= 0) { const c2 = this.connAfter(to, next, c.line[v] >= 0); if (c2 >= 0) a = Math.min(a, this.bendBrake(v, c2, L - c.s[v] + sim.laneLen(to))); }
    const nv = Math.max(0, c.v[v] + a * dt);
    c.acc[v] = (nv - c.v[v]) / dt;
    c.s[v] += (c.v[v] + nv) * 0.5 * dt;
    c.v[v] = nv;
    c.brk[v] = a < -1.2 || nv < 0.4 ? 1 : 0;
    if (c.fade[v] < 1) c.fade[v] = Math.min(1, c.fade[v] + dt * 1.2);
    if (c.s[v] < L) return;
    // reached the next lane
    this.h.unlink(v);
    c.conn[v] = -1; c.cameBy[v] = conn;
    const from = c.lane[v];
    this.h.setLaneCount(from, -1);
    this.h.setLaneCount(to, 1);
    c.lane[v] = to;
    c.s[v] -= L;
    this.h.enterLane(v, c.s[v]);
    // a lane change still under way goes on along the new segment (the lane on the same side of the new one)
    if (c.lcT[v] < 1 && c.lcFrom[v] >= 0 && laneSeg(c.lcFrom[v]) === laneSeg(from)) {
      const idx = laneIdx(to) + laneIdx(c.lcFrom[v]) - laneIdx(from), sg = laneSeg(to), dr = laneDir(to);
      if (idx >= 0 && idx < laneCount(sim.net.segs.cols.profile[sg], dr)) c.lcFrom[v] = laneId(sg, dr, idx); else c.lcT[v] = 1;
    }
    c.rIdx[v]++;
    // the route may have been broken (wrong lane): replan from the end of this lane;
    // heading to a median U-turn, replan (whoever overshot the destination turns there: the U-turn is a connection)
    const endNode = sim.laneTo(to);
    if (sim.nodeCtl[endNode] === Ctl.UTurn && c.line[v] < 0) this.h.replanFrom(v, endNode);
    else if (c.rIdx[v] >= c.rLen[v] || this.h.routeAt(v, c.rIdx[v]) !== endNode) this.h.replanFrom(v, endNode);
    if (!this.h.inWindowOut(to)) {
      // left the window: back to meso
      this.h.removeMicro(v);
      this.h.meso.enter(v, to);
      return;
    }
    this.h.insert(v, false, to);
  }

}

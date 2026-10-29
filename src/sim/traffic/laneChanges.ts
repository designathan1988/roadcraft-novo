// Lane changes of the micro vehicles: the MOBIL safety test, the mandatory move to a lane that reaches the next
// turn, the escape from a lane with no exit at all, and the discretionary keep-right move.
import { laneCount, laneDir, laneId, laneIdx, laneSeg, laneSpeed, type SimNet } from '../lanes.ts';
import { desiredSpeed, type VehicleColumns } from '../drivers.ts';
import type { Rng } from '../../core/rng.ts';

/** The vehicle columns the lane-change rules read, on top of the driver's comfort figures. */
export type LaneColumns = VehicleColumns & {
  next: Int32Array; prev: Int32Array;
  s: Float32Array; v: Float32Array; len: Float32Array; vf: Float32Array;
  lane: Int32Array; lcFrom: Int32Array; lcT: Float32Array; lcCool: Float32Array;
  line: Int16Array; wait: Float32Array;
};

/** What the lane-change rules need from Traffic; every field is the owner's state, not a copy. */
export interface LaneHost {
  readonly sim: SimNet;
  readonly cols: LaneColumns;
  readonly laneHead: Int32Array;
  readonly rng: Rng;
  readonly time: number;
  idm(v: number, speed: number, v0: number, gap: number, vl: number): number;
  unlink(v: number): void;
  setLaneCount(lane: number, delta: number): void;
  insert(v: number, onConn: boolean, lane: number): void;
  nextSeg(v: number): number;
}

export class LaneChanges {
  private readonly host: LaneHost;

  constructor(host: LaneHost) { this.host = host; }

  /** Neighbours on lane `lane` around s: [leader, follower]. */
  private around(lane: number, s: number): [number, number] {
    const { cols: c, laneHead } = this.host;
    let lead = -1;
    for (let v = laneHead[lane]; v >= 0; v = c.next[v]) {
      if (c.s[v] < s) return [lead, v];
      lead = v;
    }
    return [lead, -1];
  }

  private canChange(v: number, target: number, bias: number): boolean {
    const h = this.host, c = h.cols, sim = h.sim;
    const [lead, follow] = this.around(target, c.s[v]);
    const p = sim.net.segs.cols.profile[laneSeg(target)];
    const v0 = desiredSpeed(c, v, laneSpeed(p) * c.vf[v], h.time);
    const gapF = lead >= 0 ? c.s[lead] - c.len[lead] - c.s[v] : 1e9;
    const gapB = follow >= 0 ? c.s[v] - c.len[v] - c.s[follow] : 1e9;
    if (gapF < 2 || gapB < 3) return false;
    // safety: the new follower does not brake hard
    if (follow >= 0 && h.idm(follow, c.v[follow], v0, gapB, c.v[v]) < -3.5) return false;
    const aNew = h.idm(v, c.v[v], v0, gapF, lead >= 0 ? c.v[lead] : 99);
    const oldLead = c.prev[v];
    const aOld = oldLead >= 0 ? h.idm(v, c.v[v], v0, c.s[oldLead] - c.len[oldLead] - c.s[v], c.v[oldLead]) : c.da[v];
    return aNew - aOld + bias > 0.25;
  }

  private doChange(v: number, from: number, to: number): void {
    const h = this.host, c = h.cols;
    h.unlink(v);
    h.setLaneCount(from, -1);
    h.setLaneCount(to, 1);
    c.lane[v] = to;
    c.lcFrom[v] = from;
    c.lcT[v] = 0;
    c.lcCool[v] = 3;
    h.insert(v, false, to);
  }

  /**
   * Stopped at the end of a lane with no exit at all: moves to the adjacent lane that has one (the route is rebuilt
   * after the junction). Stopped at the line for 5 s, it changes into any physical gap (the neighbour waits).
   */
  escape(v: number, lane: number): void {
    const h = this.host, c = h.cols, sim = h.sim;
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

  /** Physically fits alongside, and whoever is behind can still stop (braking hard) before touching. */
  private roomBeside(v: number, target: number): boolean {
    const c = this.host.cols;
    const [lead, follow] = this.around(target, c.s[v]);
    if (lead >= 0 && c.s[lead] - c.len[lead] - c.s[v] < 0.5) return false;
    return follow < 0 || c.s[v] - c.len[v] - c.s[follow] > 0.5 + (c.v[follow] * c.v[follow]) / (2 * 6);
  }

  mandatory(v: number, lane: number, ns: number): void {
    const h = this.host, c = h.cols, sim = h.sim;
    if (c.lcCool[v] > 0) return;
    const seg = laneSeg(lane), dir = laneDir(lane);
    const target = sim.laneToward(seg, dir, ns, laneIdx(lane), c.line[v] >= 0);
    if (target < 0 || target === lane) return;
    const step = laneIdx(target) > laneIdx(lane) ? 1 : -1;
    const adj = laneId(seg, dir, laneIdx(lane) + step);
    // stopped at the line for 5 s waiting to change: takes any physical gap (the neighbour waits)
    if (this.canChange(v, adj, 2) || (c.wait[v] > 5 && c.v[v] < 0.5 && this.roomBeside(v, adj))) this.doChange(v, lane, adj);
    else c.lcCool[v] = 0.5;
  }

  discretionary(v: number, lane: number): void {
    const h = this.host, c = h.cols, sim = h.sim;
    c.lcCool[v] = 1 + h.rng.next();
    const seg = laneSeg(lane), dir = laneDir(lane);
    const n = laneCount(sim.net.segs.cols.profile[seg], dir);
    if (n < 2) return;
    const ns = h.nextSeg(v);
    const L = sim.laneLen(lane);
    if (L - c.s[v] < 60) return; // near the node: stay in the lane
    for (const step of [-1, 1]) {
      const i = laneIdx(lane) + step;
      if (i < 0 || i >= n) continue;
      const target = laneId(seg, dir, i);
      if (ns >= 0 && sim.connToward(target, ns) < 0) continue;
      if (c.line[v] < 0 && sim.isBusLane(target)) continue; // cars do not enter the bus lane
      // slight preference for the right (keep right)
      if (this.canChange(v, target, step < 0 ? 0.1 : -0.1)) { this.doChange(v, lane, target); return; }
    }
  }
}

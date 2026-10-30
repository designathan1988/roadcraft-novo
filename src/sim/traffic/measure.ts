// Traffic measurement: the city's average speed and stopped count, and a segment probe for the inspector. Owns only
// the accumulators; the lane lists, vehicle table and network stay with Traffic and arrive through MeasureHost.

import { laneCount, laneDir, laneId, laneSeg, laneSpeed, type SimNet } from '../lanes.ts';
import { JAMMED } from './regions.ts';
import { VehPhase } from './state.ts';

/** The columns and arrays the measurement reads (all owned by Traffic). */
export interface MeasureHost {
  readonly cols: {
    v: Float32Array; conn: Int32Array; lane: Int32Array; phase: Uint8Array; next: Int32Array;
    mnext: Int32Array; wait: Float32Array; tExit: Float64Array;
  };
  readonly micro: Int32Array;
  readonly microN: number;
  readonly sim: SimNet;
  readonly segLoad: Uint16Array;
  readonly jammedNow: number;
  readonly laneCount: Uint16Array;
  readonly laneHead: Int32Array;
  readonly mesoHead: Int32Array;
  readonly laneVel: Float32Array;
  readonly laneVelT: Float64Array;
  readonly time: number;
}

export class Measure {
  /** The city's stopped vehicles (counted along with the average speed). */
  stopped = 0;
  /** Lane length driven and time taken since the last `avgSpeed`, and the smoothed city speed. */
  private distSum = 0;
  private timeSum = 0;
  private cityV = 0;

  reset(): void { this.stopped = 0; this.distSum = 0; this.timeSum = 0; this.cityV = 0; }

  /** A vehicle finished a lane: add its distance and time to the city's figures. */
  addTrip(dist: number, time: number): void { this.distSum += dist; this.timeSum += time; }

  /**
   * Average speed of the whole city (m/s): length driven over time taken by every vehicle that finished a lane since
   * the last call, near the camera or not (smoothed). Also counts the city's stopped vehicles (`stopped`).
   */
  avgSpeed(h: MeasureHost): number {
    if (this.timeSum > 0) { const sp = this.distSum / this.timeSum; this.cityV = this.cityV > 0 ? this.cityV * 0.7 + sp * 0.3 : sp; }
    this.distSum = 0; this.timeSum = 0;
    // stopped: everyone on a jammed street (whole city, from the last region pass), and near the camera those stopped
    // on a street that is not jammed
    const c = h.cols, sc = h.sim.net.segs.cols;
    let stopped = h.jammedNow;
    for (let i = 0; i < h.microN; i++) {
      const v = h.micro[i];
      if (c.v[v] >= 0.5 || c.conn[v] >= 0 || c.lane[v] < 0 || c.phase[v] === VehPhase.Parked) continue;
      const sg = laneSeg(c.lane[v]), fwd = laneDir(c.lane[v]) > 0, lanes = laneCount(sc.profile[sg], fwd ? 1 : -1);
      if (h.segLoad[sg * 2 + (fwd ? 0 : 1)] < JAMMED * lanes * sc.len[sg] / 7.5) stopped++;
    }
    this.stopped = stopped;
    return this.cityV;
  }

  /** A segment right now: vehicles (micro and meso), average speed of the visible ones, queue (stopped) and capacity. */
  probe(h: MeasureHost, seg: number): { vehicles: number; speed: number; queue: number; capacity: number } {
    const sim = h.sim, c = h.cols;
    if (!sim.net.segs.alive[seg]) return { vehicles: 0, speed: 0, queue: 0, capacity: 0 };
    const p = sim.net.segs.cols.profile[seg];
    let vehicles = 0, seen = 0, sum = 0, queue = 0, capacity = 0, far = 0, farSum = 0;
    for (const dir of [1, -1]) for (let i = 0; i < laneCount(p, dir); i++) {
      const l = laneId(seg, dir, i), cap = Math.floor(sim.laneLen(l) / 7.5);
      vehicles += h.laneCount[l];
      capacity += cap;
      // near the camera: the vehicles themselves
      for (let v = h.laneHead[l]; v >= 0; v = c.next[v]) { seen++; sum += c.v[v]; if (c.v[v] < 0.5) queue++; }
      // far: a jammed lane is a queue; otherwise those held at the line (waiting for room or for the green)
      if (h.mesoHead[l] < 0) continue;
      let held = 0, n = 0;
      for (let v = h.mesoHead[l]; v >= 0; v = c.mnext[v]) { n++; if (c.wait[v] > 0 || c.tExit[v] - h.time > 30) held++; }
      queue += h.laneCount[l] >= JAMMED * cap ? n : held;
      // the speed driven on the lane lately; nobody out of a full lane for a minute: standing still
      const stale = h.time - h.laneVelT[l] > 60;
      far += n; farSum += n * (stale ? (h.laneCount[l] >= JAMMED * cap ? 0 : laneSpeed(p) * 0.85) : h.laneVel[l]);
    }
    const speed = seen + far ? (sum + farSum) / (seen + far) : laneSpeed(p) * 0.85;
    return { vehicles, speed, queue, capacity };
  }
}

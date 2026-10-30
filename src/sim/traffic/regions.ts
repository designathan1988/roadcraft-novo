// Region occupancy (400 m blocks) and the fleet governor. Measured every REGION_EVERY s from segment load, never per
// step; the regions feed origin/destination avoidance and the governor's fleet target. Pure module state: the
// Traffic instance owns one Regions and publishes the fields through getters.

import { MAP_HALF, MAP_SIZE } from '../../config.ts';
import { PROFILE_INFO } from '../../roads/profiles.ts';
import type { RoadNetwork } from '../../roads/network.ts';

export const REGION = 400, REGION_OCC = 0.1, REGION_SLOPE = 7, REGION_EVERY = 4;
const REGION_N = Math.ceil(MAP_SIZE / REGION);
/** A direction of a segment at this share of its slots is jammed (avgSpeed uses the same figure). */
export const JAMMED = 0.8;
const GOV_JAM = 0.5, GOV_FREE = 0.15, GOV_MIN = 0.75;

export class Regions {
  /** Occupancy of each region (cars / lane slots) from the last measurement. */
  readonly occ = new Float32Array(REGION_N * REGION_N);
  private readonly load = new Float32Array(REGION_N * REGION_N);
  private readonly cap = new Float32Array(REGION_N * REGION_N);
  private t = -Infinity;
  /** Share of the fleet on jammed streets at the last measurement, and the jammed vehicle count. */
  jamShare = 0;
  jammedNow = 0;
  /** Fleet share the governor allows now (1 = no cut). */
  gov = 1;
  governed = true;
  avoid = true;

  reset(): void {
    this.occ.fill(0);
    this.t = -Infinity;
    this.jamShare = 0;
    this.jammedNow = 0;
    this.gov = 1;
  }

  of(x: number, z: number): number {
    const i = Math.min(REGION_N - 1, Math.max(0, Math.floor((x + MAP_HALF) / REGION)));
    const j = Math.min(REGION_N - 1, Math.max(0, Math.floor((z + MAP_HALF) / REGION)));
    return j * REGION_N + i;
  }

  /** Measures region occupancy (every REGION_EVERY s: one pass over the segments, not per step). */
  measure(time: number, net: RoadNetwork, segLoad: Uint16Array): void {
    if (time - this.t < REGION_EVERY) return;
    this.t = time;
    const sc = net.segs.cols, L = this.load, C = this.cap;
    L.fill(0); C.fill(0);
    let fleet = 0, jammed = 0;
    for (let s = 0; s < net.segs.end; s++) {
      if (!net.segs.alive[s]) continue;
      const info = PROFILE_INFO[sc.profile[s]];
      if (info.rail) continue;
      const r = this.of(sc.mx[s], sc.mz[s]);
      const fwd = segLoad[s * 2], back = segLoad[s * 2 + 1], slots = sc.len[s] / 7.5;
      L[r] += fwd + back;
      C[r] += slots * (info.lanesFwd + info.lanesBack);
      fleet += fwd + back;
      if (info.lanesFwd && fwd >= JAMMED * slots * info.lanesFwd) jammed += fwd;
      if (info.lanesBack && back >= JAMMED * slots * info.lanesBack) jammed += back;
    }
    for (let r = 0; r < L.length; r++) this.occ[r] = C[r] > 0 ? L[r] / C[r] : 0;
    this.jamShare = fleet > 0 ? jammed / fleet : 0;
    this.jammedNow = jammed;
    if (this.governed && fleet >= 200) {
      const over = Math.min(1, Math.max(0, (this.jamShare - GOV_FREE) / (GOV_JAM - GOV_FREE)));
      this.gov += (1 - over * (1 - GOV_MIN) - this.gov) * 0.1;
    }
  }
}

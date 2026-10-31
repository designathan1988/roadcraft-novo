// Region occupancy (400 m blocks) and the fleet governor. The sums of each region (cars, lane slots) and of the fleet
// (cars, jammed cars) are kept as they change: a segment added, reprofiled or removed (SimNet.onSegChanged) and the cars
// of one direction of a segment (Traffic.setLaneCount). Every REGION_EVERY s only the regions that changed are divided
// out; nothing walks the map's segments (D55: the 4 s pass over every segment grew with the city). The regions feed
// origin/destination avoidance and the governor's fleet target. The Traffic instance owns one Regions and publishes the
// fields through getters; segLoad stays Traffic's (read through the host, never copied).

import { MAP_HALF, MAP_SIZE } from '../../config.ts';
import { PROFILE_INFO } from '../../roads/profiles.ts';
import type { SimNet } from '../lanes.ts';
import { growArray as grow } from './grow.ts';

export const REGION = 400, REGION_OCC = 0.1, REGION_SLOPE = 7, REGION_EVERY = 4;
const REGION_N = Math.ceil(MAP_SIZE / REGION);
/** A direction of a segment at this share of its slots is jammed (avgSpeed uses the same figure). */
export const JAMMED = 0.8;
const GOV_JAM = 0.5, GOV_FREE = 0.15, GOV_MIN = 0.75;

export class Regions {
  /** Occupancy of each region (cars / lane slots) from the last measurement. */
  readonly occ = new Float32Array(REGION_N * REGION_N);
  /** Cars and lane slots of each region now, and the segments counted in it (none left: the slots are exactly 0). */
  private readonly load = new Float64Array(REGION_N * REGION_N);
  private readonly cap = new Float64Array(REGION_N * REGION_N);
  private readonly count = new Int32Array(REGION_N * REGION_N);
  /** Regions whose sums changed since the last measurement (each listed once). */
  private readonly dirty = new Uint8Array(REGION_N * REGION_N);
  private readonly dirtyList = new Int32Array(REGION_N * REGION_N);
  private dirtyN = 0;
  /** What each segment adds now: its region (−1: not counted, gone or rail), slots, lanes and cars each way. */
  private segRegion = new Int32Array(0);
  private segSlots = new Float64Array(0);
  private segLanes = new Uint8Array(0);
  private segCars = new Uint16Array(0);
  private fleet = 0;
  private jammed = 0;
  private t = -Infinity;
  /** Share of the fleet on jammed streets at the last measurement, and the jammed vehicle count. */
  jamShare = 0;
  jammedNow = 0;
  /** Fleet share the governor allows now (1 = no cut). */
  gov = 1;
  governed = true;
  avoid = true;

  private readonly sim: SimNet;
  private readonly segLoad: () => Uint16Array;

  /** `segLoad`: Traffic's cars per segment direction (seg * 2 + 0 forward, + 1 back); the array is replaced as it grows. */
  constructor(sim: SimNet, segLoad: () => Uint16Array) {
    this.sim = sim;
    this.segLoad = segLoad;
    sim.onSegChanged = (s) => this.track(s);
    // a network built before this Traffic was made
    for (let s = 0; s < sim.net.segs.end; s++) this.track(s);
  }

  /** Traffic dropped every vehicle (its segLoad is all zero): the cars go, the segments' slots stay. */
  reset(): void {
    this.occ.fill(0);
    this.load.fill(0);
    this.segCars.fill(0);
    this.dirty.fill(0); this.dirtyN = 0;
    this.fleet = 0; this.jammed = 0;
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

  /** Segment s was added, reprofiled or removed (or its cars were cleared): its share comes out and goes back as it is now. */
  track(s: number): void {
    if (s >= this.segRegion.length) {
      const cap = Math.max(s + 1, this.sim.net.segs.capacity);
      this.segRegion = grow(this.segRegion, cap, -1);
      this.segSlots = grow(this.segSlots, cap, 0);
      this.segLanes = grow(this.segLanes, cap * 2, 0);
      this.segCars = grow(this.segCars, cap * 2, 0);
    }
    const was = this.segRegion[s];
    if (was >= 0) {
      this.setCars(s * 2, 0); this.setCars(s * 2 + 1, 0);
      this.count[was]--;
      this.cap[was] = this.count[was] ? this.cap[was] - this.segSlots[s] * (this.segLanes[s * 2] + this.segLanes[s * 2 + 1]) : 0;
      this.segRegion[s] = -1;
      this.mark(was);
    }
    const net = this.sim.net;
    if (!net.segs.alive[s]) return;
    const sc = net.segs.cols, info = PROFILE_INFO[sc.profile[s]];
    if (info.rail) return;
    const r = this.of(sc.mx[s], sc.mz[s]), slots = sc.len[s] / 7.5;
    this.segRegion[s] = r; this.segSlots[s] = slots;
    this.segLanes[s * 2] = info.lanesFwd; this.segLanes[s * 2 + 1] = info.lanesBack;
    this.cap[r] += slots * (info.lanesFwd + info.lanesBack);
    this.count[r]++;
    this.mark(r);
    const load = this.segLoad();
    this.setCars(s * 2, load[s * 2]); this.setCars(s * 2 + 1, load[s * 2 + 1]);
  }

  /** Traffic changed segLoad[i] (i = seg * 2 + direction): the region and the fleet take the difference. */
  loadChanged(i: number): void { this.setCars(i, this.segLoad()[i]); }

  private setCars(i: number, n: number): void {
    const s = i >> 1, r = s < this.segRegion.length ? this.segRegion[s] : -1;
    if (r < 0) return;
    const was = this.segCars[i];
    if (was === n) return;
    this.segCars[i] = n;
    this.load[r] += n - was;
    this.fleet += n - was;
    this.jammed += this.jam(i, n) - this.jam(i, was);
    this.mark(r);
  }

  /** The cars of one direction that count as jammed: all of them at JAMMED of its slots, else none. */
  private jam(i: number, n: number): number {
    const lanes = this.segLanes[i];
    return lanes && n >= JAMMED * this.segSlots[i >> 1] * lanes ? n : 0;
  }

  private mark(r: number): void {
    if (this.dirty[r]) return;
    this.dirty[r] = 1;
    this.dirtyList[this.dirtyN++] = r;
  }

  /** Publishes region occupancy and the jam share (every REGION_EVERY s: the regions that changed, not the map). */
  measure(time: number): void {
    if (time - this.t < REGION_EVERY) return;
    this.t = time;
    for (let k = 0; k < this.dirtyN; k++) {
      const r = this.dirtyList[k];
      this.dirty[r] = 0;
      this.occ[r] = this.cap[r] > 0 ? this.load[r] / this.cap[r] : 0;
    }
    this.dirtyN = 0;
    const fleet = this.fleet, jammed = this.jammed;
    this.jamShare = fleet > 0 ? jammed / fleet : 0;
    this.jammedNow = jammed;
    if (this.governed && fleet >= 200) {
      const over = Math.min(1, Math.max(0, (this.jamShare - GOV_FREE) / (GOV_JAM - GOV_FREE)));
      this.gov += (1 - over * (1 - GOV_MIN) - this.gov) * 0.1;
    }
  }
}

// Bus and train line runtime inside the simulation: the lines resolved to lanes, their vehicles, riders, the stops
// being served and the timetable figures. The waiting queues and the stop cell index live in Stops; the vehicle
// columns, routes and the lane lists stay with Traffic (the single owner), read here through BusHost.

import type { Rng } from '../../core/rng.ts';
import type { SimNet } from '../lanes.ts';
import { End, KIND_LEN, ROUTE_CAP, VehPhase, type VehAccess } from './state.ts';
import { drawDriver, archOf, type driverSchema } from '../drivers.ts';
import type { Router } from '../routing.ts';
import { resolveLine, type LineSpec, type SimLine } from './lines.ts';
import { WAIT_RATE, type Stops } from './stops.ts';
import { laneSeg } from '../lanes.ts';

/** The vehicle columns the line runtime writes (every other column it only reads). */
export type BusWrites = 'lane' | 'conn' | 'cameBy' | 's' | 'kind' | 'len' | 'vf' | 'color' | 'line' | 'stopI' | 'load' | 'served'
  | 'dest' | 'rIdx' | 'rLen' | 'phase' | 'why'
  // a bus's driver is drawn when the bus is made (drivers.ts drawDriver)
  | keyof typeof driverSchema;
export type BusColumns = VehAccess<BusWrites>;

/** What the line runtime needs from Traffic; every field is the owner's state, not a copy. */
export interface BusHost {
  readonly sim: SimNet;
  readonly veh: { readonly cols: BusColumns; readonly alive: Uint8Array; alloc(): number };
  readonly routes: Int32Array;
  readonly router: Router;
  readonly stops: Stops;
  readonly time: number;
  readonly rng: Rng;
  readonly sample: () => number;
  onAlight: (node: number, count: number, x: number, z: number) => void;
  initVehicle(v: number): void;
  enterLane(v: number, s: number): void;
  setLaneCount(lane: number, delta: number): void;
  mesoEnter(v: number, lane: number, spawned?: boolean): void;
  despawn(v: number): void;
}

/** Dwell at the terminal (s): the bus rests and adjusts its schedule before heading back. */
export const TERMINAL_DWELL = 75;
export const BUS_CAP = 70;

export class Buses {
  /** Bus lines (index = position; the vehicle stores the index). */
  lines: SimLine[] = [];
  /** Buses of each line (so the fleet is not scanned). */
  readonly sets: Array<Set<number>> = [];
  /** Passengers of each bus by destination stop, and of them those who came on foot. */
  readonly riders = new Map<number, Float64Array>();
  readonly realRiders = new Map<number, Float64Array>();
  private check = 0;
  private readonly host: BusHost;

  constructor(host: BusHost) { this.host = host; }

  clear(): void {
    for (const set of this.sets) set.clear();
    this.riders.clear();
    this.realRiders.clear();
    this.lines = [];
    this.sets.length = 0;
  }

  /** A vehicle that leaves the fleet stops counting as a bus of its line. */
  forget(v: number): void {
    const c = this.host.veh.cols;
    if (c.line[v] >= 0) { this.sets[c.line[v]]?.delete(v); this.riders.delete(v); this.realRiders.delete(v); }
  }

  /** Every 2 s: keeps the number of buses on each line. */
  tick(dt: number): void {
    this.check -= dt;
    if (this.check <= 0) { this.check = 2; this.keepBuses(); }
  }

  setLines(specs: LineSpec[]): void {
    const h = this.host;
    const old = this.lines, oldSets = this.sets;
    const byId = new Map<number, number>();
    old.forEach((ln, i) => byId.set(ln.id, i));
    const keptOld = new Set<number>();
    const lines: SimLine[] = [], sets: Array<Set<number>> = [];
    for (const sp of specs) {
      const ln = resolveLine(sp, h.sim, h.time), li = lines.length, set = new Set<number>();
      const oi = byId.get(sp.id);
      if (oi !== undefined && !keptOld.has(oi) && old[oi].mode === ln.mode) {
        keptOld.add(oi);
        this.carryLine(old[oi], oldSets[oi], ln, li, set);
      }
      lines.push(ln); sets.push(set);
    }
    // buses of lines that are gone leave (only those in the lines' lists)
    oldSets.forEach((set, oi) => { if (!keptOld.has(oi)) for (const v of set) this.retireBus(v); });
    this.lines = lines;
    this.sets.length = 0;
    for (const set of sets) this.sets.push(set);
    // a line with fewer buses now: the extra ones leave
    sets.forEach((set, li) => {
      let extra = set.size - lines[li].buses;
      for (const v of [...set]) { if (extra <= 0) break; set.delete(v); this.retireBus(v); extra--; }
    });
    this.keepBuses();
    h.stops.index(this.lines);
  }

  /** A bus leaves its line: fades out where it is (near the camera) or goes at once (far). Not a trip. */
  private retireBus(v: number): void {
    const h = this.host, c = h.veh.cols;
    if (!h.veh.alive[v] || c.line[v] < 0) return;
    this.riders.delete(v); this.realRiders.delete(v);
    c.why[v] = End.NoTrip;
    if (c.micro[v]) { c.phase[v] = VehPhase.Leaving; c.line[v] = -1; } else { c.line[v] = -1; h.despawn(v); }
  }

  /** The new version `ln` (index `li`) of line `prev`: its buses, riders and those waiting, stop by stop. */
  private carryLine(prev: SimLine, prevSet: Set<number>, ln: SimLine, li: number, set: Set<number>): void {
    const c = this.host.veh.cols, n = ln.stopLane.length, m = prev.stopLane.length;
    // the same stop: the same place on the sidewalk (the return trip's stops are mirrored, so they differ)
    const toNew = new Int32Array(m).fill(-1);
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < n; i++) if (Math.abs(ln.stopX[i] - prev.stopX[j]) < 1 && Math.abs(ln.stopZ[i] - prev.stopZ[j]) < 1) { toNew[j] = i; break; }
    }
    for (let j = 0; j < m; j++) {
      const i = toNew[j];
      if (i < 0) continue;
      ln.lastT[i] = prev.lastT[j];
      let w = 0;
      for (let k = 0; k < m; k++) if (toNew[k] >= 0) { ln.waitTo[i][toNew[k]] += prev.waitTo[j][k]; ln.realTo[i][toNew[k]] += prev.realTo[j][k]; w += prev.waitTo[j][k]; }
      ln.waiting[i] = w;
    }
    ln.boardings = prev.boardings; ln.perHour = prev.perHour;
    /** The first stop from old index `j` on (in the line's order) that is still there. */
    const nextKept = (j: number): number => { for (let k = 0; k < m; k++) { const i = toNew[(j + k) % m]; if (i >= 0) return i; } return 0; };
    for (const v of prevSet) {
      if (!this.host.veh.alive[v] || c.phase[v] || c.line[v] < 0) continue;
      set.add(v);
      c.line[v] = li;
      const next = nextKept(c.stopI[v]);
      for (const map of [this.riders, this.realRiders]) {
        const r = map.get(v);
        if (!r) continue;
        const nr = new Float64Array(n);
        for (let k = 0; k < r.length && k < m; k++) nr[toNew[k] >= 0 ? toNew[k] : next] += r[k];
        map.set(v, nr);
      }
      c.stopI[v] = next;
    }
  }

  /** Keeps the number of buses on each line (those that vanished respawn at a stop). */
  private keepBuses(): void {
    if (this.lines.length === 0) return;
    const c = this.host.veh.cols;
    this.lines.forEach((ln, i) => {
      const n = ln.stopLane.length;
      if (n < 2) return;
      let have = 0;
      for (const v of this.sets[i]) if (!c.phase[v]) have++;
      for (let k = have; k < ln.buses; k++) this.spawnBus(i, Math.floor((k * n) / Math.max(1, ln.buses)) % n);
    });
  }

  private spawnBus(li: number, stop: number): void {
    const h = this.host, ln = this.lines[li], sim = h.sim;
    const lane = ln.stopLane[stop];
    if (!sim.net.segs.alive[laneSeg(lane)]) return;
    const v = h.veh.alloc();
    h.initVehicle(v);
    const c = h.veh.cols;
    const train = ln.mode > 0;
    c.kind[v] = train ? 4 : 1; c.len[v] = KIND_LEN[train ? 4 : 1];
    c.vf[v] = train ? 1 : drawDriver(c, v, archOf(1, 0), h.sample);
    if (train) drawDriver(c, v, archOf(4, 0), h.sample);
    c.color[v] = ln.color & 15;
    c.line[v] = li; c.stopI[v] = stop; c.served[v] = 0;
    this.sets[li].add(v);
    const o = v * ROUTE_CAP;
    h.routes[o] = sim.laneFrom(lane); h.routes[o + 1] = sim.laneTo(lane);
    c.rLen[v] = 2; c.rIdx[v] = 1; c.dest[v] = sim.laneTo(lane);
    c.lane[v] = lane; c.conn[v] = -1; c.cameBy[v] = -1;
    c.s[v] = h.rng.next() * Math.max(0, ln.stopV[stop] - 6);
    h.enterLane(v, c.s[v]);
    h.setLaneCount(lane, 1);
    h.mesoEnter(v, lane, true);
  }

  /** Background demand that arrived since last time, spread over the destinations. */
  private accrue(ln: SimLine, i: number): void {
    const n = ln.stopLane.length;
    const room = Math.max(0, 120 - ln.waiting[i]);
    const add = Math.min(room, (this.host.time - ln.lastT[i]) * WAIT_RATE);
    ln.lastT[i] = this.host.time;
    if (add <= 0 || n < 2) return;
    for (let j = 0; j < n; j++) if (j !== i) ln.waitTo[i][j] += add / (n - 1);
    ln.waiting[i] += add;
  }

  /** A pedestrian arrived at stop `from` wanting to go to `to`. */
  pedAtStop(li: number, from: number, to: number): void {
    const ln = this.lines[li];
    if (!ln || from >= ln.waitTo.length || to >= ln.waitTo.length) return;
    this.accrue(ln, from);
    ln.waitTo[from][to] += 1;
    ln.realTo[from][to] += 1;
    ln.waiting[from] += 1;
  }

  /** For pedestrians: a random bus trip (line, boarding stop, alighting stop, boarding node, the stop on the sidewalk). */
  pickTrip(): [number, number, number, number, number, number] | null {
    const h = this.host;
    if (this.lines.length === 0) return null;
    const li = h.rng.int(0, this.lines.length);
    const ln = this.lines[li];
    const n = ln.stopLane.length;
    if (n < 2 || this.sets[li].size === 0 || ln.mode) return null;
    const a = h.rng.int(0, n);
    let b = h.rng.int(0, n - 1);
    if (b >= a) b++;
    return [li, a, b, h.sim.laneFrom(ln.stopLane[a]), ln.stopX[a], ln.stopZ[a]];
  }

  /** Serves the stop: people get off and on; the next leg goes to the following stop. */
  serve(v: number): void {
    const h = this.host, c = h.veh.cols, ln = this.lines[c.line[v]];
    const i = c.stopI[v];
    const n = ln.stopLane.length;
    this.accrue(ln, i);
    let r = this.riders.get(v), rr = this.realRiders.get(v);
    if (!r || r.length !== n) { r = new Float64Array(n); this.riders.set(v, r); }
    if (!rr || rr.length !== n) { rr = new Float64Array(n); this.realRiders.set(v, rr); }
    // those bound for this stop get off; the people who came on foot step off at the stop and walk on (the background
    // demand only rides: it never becomes extra pedestrians). From a train people leave through the station.
    const realOff = rr[i];
    r[i] = 0; rr[i] = 0;
    if (realOff >= 0.5 && !ln.mode) h.onAlight(h.sim.laneTo(c.lane[v]), Math.round(realOff), ln.stopX[i], ln.stopZ[i]);
    let load = 0;
    for (let j = 0; j < n; j++) load += r[j];
    // those waiting get on, until full: the people who walked there first (whole persons), then the background
    const room = Math.max(0, (ln.mode ? 600 : BUS_CAP) - load);
    const take = Math.min(Math.floor(ln.waiting[i]), room);
    if (take > 0 && ln.waiting[i] > 0) {
      let real = 0, total = 0;
      for (let j = 0; j < n; j++) { real += ln.realTo[i][j]; total += ln.waitTo[i][j]; }
      const realTake = Math.min(real, take), fr = real > 0 ? realTake / real : 0;
      for (let j = 0; j < n; j++) { const m = ln.realTo[i][j] * fr; rr[j] += m; r[j] += m; ln.realTo[i][j] -= m; ln.waitTo[i][j] -= m; }
      const bg = total - real, fb = bg > 0 ? Math.min(1, (take - realTake) / bg) : 0;
      for (let j = 0; j < n; j++) { const m = (ln.waitTo[i][j] - ln.realTo[i][j]) * fb; r[j] += m; ln.waitTo[i][j] -= m; }
      ln.waiting[i] -= take;
    }
    c.load[v] = Math.min(255, Math.round(load + take));
    ln.boardings += take;
    c.stopI[v] = (i + 1) % ln.stopLane.length;
    this.busPlan(v, h.sim.laneTo(c.lane[v]));
  }

  /** Route from node `from` to the current stop: arrives via the stop's lane (in the right direction). */
  busPlan(v: number, from: number): void {
    const h = this.host, c = h.veh.cols, sim = h.sim, ln = this.lines[c.line[v]];
    if (!ln) { c.line[v] = -1; c.phase[v] = VehPhase.Leaving; return; }  // (line gone: the set has already been replaced)
    const target = ln.stopLane[c.stopI[v]];
    if (!sim.net.segs.alive[laneSeg(target)]) { c.phase[v] = VehPhase.Leaving; return; }
    const b = sim.laneTo(target);
    const o = v * ROUTE_CAP;
    // already on the stop's lane (not served yet): it stays on it; the stop comes before the lane's end
    if (c.lane[v] === target && c.conn[v] < 0) { h.routes[o] = b; c.rLen[v] = 1; c.rIdx[v] = 0; c.dest[v] = b; return; }
    // to the end of the stop's lane, driving that lane: the last movement into it must be one the junction makes
    // (planning only to its start node could leave the bus unable to turn into it, circling for ever)
    const inSeg = c.lane[v] >= 0 && sim.laneTo(c.lane[v]) === from ? laneSeg(c.lane[v]) : -1;
    const n = h.router.route(from, b, h.routes, o, ROUTE_CAP, false, inSeg, ln.mode > 0, -1, true, laneSeg(target));
    if (n < 2) { c.phase[v] = VehPhase.Leaving; return; }
    // (a truncated route goes on and is planned again at its end)
    c.rLen[v] = n; c.rIdx[v] = 0; c.dest[v] = h.routes[o + n - 1];
  }
}

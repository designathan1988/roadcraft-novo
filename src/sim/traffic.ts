// Traffic: meso over the whole map (queue per lane, events per vehicle), micro
// in a window around the camera (IDM for car-following, MOBIL for lane changes,
// signals per arm that adapt to the queue, right of way at roundabouts).
// Everything in SoA tables; no loop goes over the whole fleet per step.

import { Table } from '../core/table.ts';
import { MAP_HALF, MAP_SIZE } from '../config.ts';
import { Rng } from '../core/rng.ts';
import { MAX_DEG } from '../roads/network.ts';
import { SegFlag } from '../roads/flags.ts';
import { Ctl } from '../roads/control.ts';
import { baseZone } from '../roads/zones.ts';
import { PROFILE_INFO } from '../roads/profiles.ts';
import { SimNet, laneCount, laneDir, laneId, laneIdx, laneSeg, laneSpeed } from './lanes.ts';
import { Router } from './routing.ts';
import { FlowAdvisor } from './advisor.ts';
import { MANOEUVRE_RADIUS, MKind, Manoeuvres } from './manoeuvres.ts';
import { Signals } from './signals.ts';
import { stripAt } from './probe.ts';
import { archOf, drawDriver } from './drivers.ts';
import { BODY_HALF_W, CAR_STYLE_LEN, CROSSWALK, End, INSPECT_BAY, INSPECT_CHANGING, INSPECT_GATE, INSPECT_LEAVING, INSPECT_PASS, INSPECT_RED, INSPECT_STOP, KIND_LEN, LIGHT_BRAKE, LIGHT_LEFT, LIGHT_RIGHT, MAX_VEHICLES, ROUTE_CAP, WAGON_LEN, WAGONS, vehSchema, VehPhase } from './traffic/state.ts';
export { CAR_STYLE_LEN, INSPECT_BAY, INSPECT_CHANGING, INSPECT_GATE, INSPECT_LEAVING, INSPECT_PASS, INSPECT_RED, INSPECT_STOP, INSPECT_STRIDE, ROUTE_CAP, WAGONS, WAGON_LEN } from './traffic/state.ts';
import { LaneChanges } from './traffic/laneChanges.ts';
import { BUS_CAP, Buses } from './traffic/buses.ts';
import { Meso } from './traffic/meso.ts';
import { Junctions } from './traffic/junctions.ts';
import { Micro } from './traffic/micro.ts';
import { KerbStops } from './traffic/kerbStops.ts';
import { growArray as grow } from './traffic/grow.ts';
import type { LineSpec, SimLine } from './traffic/lines.ts';
import { JAMMED, REGION, REGION_EVERY, REGION_OCC, REGION_SLOPE, Regions } from './traffic/regions.ts';
import { Measure } from './traffic/measure.ts';
import { Stops } from './traffic/stops.ts';
export { JAMMED, REGION, REGION_EVERY, REGION_OCC, REGION_SLOPE };

const WINDOW = 1500;
const WINDOW_OUT = 1750;
/** Stopped for this long (s), the driver reconsiders the route (roadcraft STUCK_SECONDS). */
export const STUCK_SECONDS = 10;
/** Route searches per step (detours and reconsiderations): the rest try on the next step. */
const ROUTE_BUDGET = 6;
/**
 * The fleet is neither fixed nor jumps: below the target it grows at the pace of new trips, reaching the target with
 * this time constant (s, ~ the length of a trip). Without it the 18:00 peak (the game clock runs 1 h per minute)
 * put 50% more cars on the network in two minutes, and they took 15 min to arrive: the centre dropped to
 * 10 km/h after ~10 min of play. Below FILL_SHARE of the target (map opening) it fills at once.
 */
const FLEET_TAU = 600, FILL_SHARE = 0.5;
/**
 * Occupancy (fraction of a full lane) of the surrounding streets above which a node loses weight as origin or
 * destination, and how much it loses per unit of occupancy (zero at 35%). Measured: without it the centre piled up
 * cars and dropped from ~18 to ~14 km/h in 20 min.
 */
const CROWD_OCC = 0.15, CROWD_SLOPE = 5;
/**
 * Congested region (400 m blocks, recomputed every 4 s from segment occupancy): trips that start or end in it go
 * somewhere else, like people avoiding downtown at rush hour. Without it the (fixed) fleet drained into the centre
 * until it jammed: at peak, 845 → 1,423 cars within 700 m of the centre in 20 min and 17.8 → 9.9 km/h.
 */

/** Where trucks start and end (none, residential, commercial, industrial, mixed): goods between industry and commerce. */
const TRUCK_ZONES = [0.05, 0.1, 0.6, 1, 0.4];

/** Dock index cell (m) and cells per side; a truck turns into a yard whose dock is this near its centre (m). */
const DOCK_CELL = 64, DOCK_CELLS = Math.ceil(MAP_SIZE / DOCK_CELL), YARD_REACH = 28;


/** Parking (roadcraft kerbStops/parking): deceleration, time to pull into the bay (s), and how long it stays before disappearing. */
const PARK_DECEL = 2.6, PARK_SIDE_S = 2.4, PARK_STAY = 3;
/** In a lane change the rear follows the front's sideways move this share of the change later (the body points into it). */
const LC_REAR_LAG = 0.15;
/** Half the chord a body's heading is read along, centred on its middle (roadcraft world/heading.ts HEADING_CHORD). */
const HEADING_CHORD = 1.5;

/** u of the middle of the parking strip on the right of someone driving in direction `dir` of the segment (NaN = no bays). */
function parkU(profile: number, dir: number): number {
  for (const e of PROFILE_INFO[profile].edges) {
    if (e.strip.kind !== 'parking') continue;
    const u = (e.u0 + e.u1) / 2;
    if ((dir > 0 && u < 0) || (dir < 0 && u > 0)) return u;
  }
  return NaN;
}

/** Wear per vehicle entering a lane: a road with 1,000 vehicles per hour gets well worn in ~1 h of simulation at 1×. */
const WEAR_PER_PASS = 0.2;
/** The share of the fleet each passenger car style takes; the lengths are in `traffic/state.ts`. */
const CAR_STYLE_SHARE = [0.3, 0.3, 0.17, 0.08, 0.07, 0.08];

export class Traffic {
  readonly sim: SimNet;
  readonly router: Router;
  /** Region occupancy and the fleet governor (traffic/regions.ts). */
  readonly regions = new Regions();
  /** City speed/stopped measurement and segment probes (traffic/measure.ts). */
  readonly measure = new Measure();
  /** Bus stop cell index, waiting people and line figures (traffic/stops.ts). */
  readonly stops = new Stops();
  readonly veh = new Table(vehSchema, 1 << 12);
  routes = new Int32Array((1 << 12) * ROUTE_CAP);
  /** Ordered list of micro vehicles per lane and per connection (head = the frontmost). */
  laneHead = new Int32Array((1 << 14) * 16).fill(-1);
  laneTail = new Int32Array((1 << 14) * 16).fill(-1);
  /** Far model: lane queues and events (traffic/meso.ts); the lists are the owner's arrays. */
  readonly meso: Meso;
  /** Far-model vehicles per lane, in order of entry (view of the owner, `meso`). */
  get mesoHead(): Int32Array { return this.meso.head; }
  get mesoTail(): Int32Array { return this.meso.tail; }
  connHead = new Int32Array(1 << 14).fill(-1);
  connTail = new Int32Array(1 << 14).fill(-1);
  /** All vehicles (micro and meso) per lane. */
  laneCount = new Uint16Array((1 << 14) * 16);
  /** Right of way at junctions: claims, exits, crossings and the box (traffic/junctions.ts). */
  readonly junctions: Junctions;
  /** The near model: IDM, lane and connection movement, jams and detours (traffic/micro.ts). */
  readonly microSim: Micro;
  /** Vehicles per segment and direction (routing avoids what is full). */
  segLoad = new Uint16Array((1 << 14) * 2);
  /** Accumulated wear per segment (passes × weight; 255 = worn out). */
  segWear = new Float32Array(1 << 14);
  /** Occupancy per segment and direction, for the shader's "density cars". */
  occupancy: Uint8Array | null = null;
  /** Signal state per node, for drawing: 0 = outside the window; otherwise 1 + arm * 4 + state (0 green, 1 amber, 2 red). */
  signals: Uint8Array | null = null;
  /** Micro vehicles, dense (to publish and iterate). */
  micro = new Int32Array(1 << 12);
  microN = 0;
  /** Lanes and connections with micro vehicles. */
  private activeLanes = new Set<number>();
  private activeConns = new Set<number>();
  /** Traffic lights (plans, timed cycle, actuated near the camera). */
  readonly sig: Signals;
  private readonly laneChanges: LaneChanges;
  /** Drop-offs at the kerb (sim/traffic/kerbStops.ts). */
  private readonly kerb: KerbStops;
  private signalNodes = new Set<number>();
  /** Signals near the camera (only these run; distant ones stay frozen). */
  private windowSignals = new Set<number>();

  /** Average speed of the whole city (m/s), stopped count and a segment probe: measured by `measure`. */
  avgSpeed(): number { return this.measure.avgSpeed(this); }
  probe(seg: number): { vehicles: number; speed: number; queue: number; capacity: number } { return this.measure.probe(this, seg); }
  get stopped(): number { return this.measure.stopped; }
  get cols() { return this.veh.cols; }
  /** Speed actually driven on each lane by the last vehicles that finished it (m/s, smoothed), and when. */
  laneVel = new Float32Array((1 << 14) * 16);
  laneVelT = new Float64Array((1 << 14) * 16);

  /** The vehicle starts lane c.lane[v] at position `s`. */
  private enterLane(v: number, s: number): void { const c = this.veh.cols; c.tIn[v] = this.time; c.s0[v] = Math.max(0, s); c.pass[v] = 0; }

  /**
   * How far before the end of `lane` its stop line is (m): at a junction with crosswalks (three arms or more, not a
   * roundabout) and at a mid-block crossing, the crosswalk and the line take the last CROSSWALK m (as painted,
   * jobs/roadMesh.ts); elsewhere 0.
   */
  private stopBack(lane: number): number {
    const sim = this.sim, n = sim.laneTo(lane), deg = sim.net.nodes.cols.deg[n], seg = laneSeg(lane);
    // no crosswalk on a roundabout's ring nor across a railway
    if ((sim.net.segs.cols.flags[seg] & SegFlag.Ring) !== 0 || PROFILE_INFO[sim.net.segs.cols.profile[seg]].rail) return 0;
    const ctl = sim.nodeCtl[n];
    if (ctl === Ctl.Crossing) return 0; // a level crossing has its barrier, not a zebra
    if (deg >= 3) return CROSSWALK;
    return deg === 2 && (ctl === Ctl.Zebra || ctl === Ctl.PedSignal) ? CROSSWALK : 0;
  }

  /** The vehicle finishes `lane`: its speed on it goes into the lane's and the city's figures. */
  private leaveLane(v: number, lane: number): void {
    const c = this.veh.cols, dist = this.sim.laneLen(lane) - c.s0[v], t = this.time - c.tIn[v];
    if (!(t > 0.2) || dist < 1) return;
    const sp = dist / t;
    this.laneVel[lane] = this.laneVel[lane] > 0 ? this.laneVel[lane] * 0.6 + sp * 0.4 : sp;
    this.laneVelT[lane] = this.time;
    this.measure.addTrip(dist, t);
  }

  /** Network cleared (new map, load): all vehicles leave, queues and signals reset. */
  clearAll(): void {
    this.veh.clear();
    this.laneHead.fill(-1); this.laneTail.fill(-1); this.connHead.fill(-1); this.connTail.fill(-1);
    this.meso.clear(); this.junctions.clear();
    this.laneCount.fill(0); this.segLoad.fill(0);
    this.lastAdmit.fill(this.time); this.releaseAt.fill(0); this.jamAt.fill(0);
    this.microN = 0;
    this.activeLanes.clear(); this.activeConns.clear();
    this.signalNodes.clear();
    if (this.signals) for (const n of this.windowSignals) if (n < this.signals.length) this.signals[n] = 0;
    for (const n of this.windowSignals) this.sig.setActive(n, false);
    this.windowSignals.clear();
    this.buses.clear();
    this.wagonPrev.clear();
    if (this.occupancy) this.occupancy.fill(0);
    this.segWear.fill(0);
    this.parkers.clear();
    this.mvs.clear();
    this.spots.clear();
    // nothing of the old city: its jams, crossings, docks and bus lines (the page sends the new map's lines and docks)
    this.regions.reset();
    this.measure.reset(); this.laneVel.fill(0); this.laneVelT.fill(0);
    this.docks = new Float32Array(0);
    this.stops.index(this.lines);
    this.spawnCredit = 0; this.fleetFloor = 0;
  }

  /** New segment (the id may belong to a demolished one): fresh asphalt. */
  clearWear(seg: number): void {
    if (seg < this.segWear.length) this.segWear[seg] = 0;
    if (this.occupancy && seg * 4 + 2 < this.occupancy.length) this.occupancy[seg * 4 + 2] = 0;
  }

  /** Bus/train line runtime: lines, their vehicles, riders and stop service (traffic/buses.ts). */
  readonly buses: Buses;
  /** The lines, by position (the vehicle stores the index). */
  get lines(): SimLine[] { return this.buses.lines; }
  /** People get off the bus at node `node` (the pedestrians carry on on foot). */
  onAlight: (node: number, count: number, x: number, z: number) => void = () => {};

  /** Is someone walking on the node's crosswalk? (from the pedestrians) */
  pedCrossing: (n: number) => boolean = () => false;
  /** Is someone walking a crossing over one of node `n`'s arms in `mask` (bit per arm)? (from the pedestrians) */
  pedCrossingArms: (n: number, mask: number) => boolean = () => false;
  /**
   * Is someone walking a crossing over an arm of `n` in `mask` on the stretch within `reach` m of (x, z), or walking
   * towards it and there within the look-ahead plus `front` s? (from the pedestrians: `Peds.crossingReach`)
   */
  pedCrossingReach: (n: number, mask: number, x: number, z: number, reach: number, front: number) => boolean = () => false;

  /** Vehicles that went through each node (micro and meso), for the junction flow. */
  nodePass = new Uint32Array(1 << 14);
  /** Last normal pass per node (not a release), to detect a jammed junction; and the next release. */
  private lastAdmit = new Float64Array(1 << 14);
  private releaseAt = new Float64Array(1 << 14);
  private jamAt = new Float64Array(1 << 14);
  /** Automatic control from the measured flow. */
  readonly advisor: FlowAdvisor;
  /** Trips avoid starting or ending on a congested street. */
  crowdAvoid = true;
  /** Counters: reconsidered routes, junctions that jammed, vehicles released. */
  reroutes = 0; jams = 0; released = 0;
  /** Vehicles that entered a signalled junction on red (near the camera; should stay 0). */
  ranRed = 0;
  /** Meso: attempts to move on at the end of the lane and how many found the next one full (congestion far from the camera). */
  get mesoTries(): number { return this.meso.tries; }
  get mesoFull(): number { return this.meso.full; }
  private routeBudget = 0;

  /** Explosion: micro-window vehicles within `r` metres leave the scene (returns how many). */
  blast(x: number, z: number, r: number): number {
    const c = this.veh.cols;
    let n = 0;
    for (let i = this.microN - 1; i >= 0; i--) {
      const v = this.micro[i];
      if (!c.has[v] || Math.hypot(c.px[v] - x, c.pz[v] - z) > r) continue;
      // parking: already out of the lane, just fade it (`stepParkers` finishes it)
      if (c.phase[v] !== VehPhase.Parked) c.phase[v] = VehPhase.Leaving;
      if (c.why[v] === End.Arrived) c.why[v] = End.Lost;
      c.fade[v] = Math.min(c.fade[v], 0.3); n++;
    }
    return n;
  }

  /** Counters for debugging and tests. */
  arrived = 0; lost = 0;
  camX = 0; camZ = 0;
  /** Radius of the micro window (m). Diagnostics put the whole map in micro to measure meso. */
  window = WINDOW;
  time = 0;
  readonly rng = new Rng(12345);
  private tmp = new Float64Array(4);
  private tmp2 = new Float64Array(4);
  /** Meso pace factor (MESO_ALPHA; a field so measurements can try others). */
  get mesoAlpha(): number { return this.meso.alpha; }
  set mesoAlpha(v: number) { this.meso.alpha = v; }
  /** How much a full lane slows the far model (the BPR term: 1 + mesoCrowd × occupancy²). */
  get mesoCrowd(): number { return this.meso.crowd; }
  set mesoCrowd(v: number) { this.meso.crowd = v; }
  /** Target density (vehicles per metre of lane). */
  density = 1 / 100;

  constructor(sim: SimNet) {
    this.sim = sim;
    this.router = new Router(sim);
    this.router.segLoad = this.segLoad;
    this.advisor = new FlowAdvisor(sim);
    this.sig = new Signals(sim);
    this.sig.queue = (n, mask) => this.armsQueue(n, mask);
    this.sig.busNear = (n, mask) => this.busNearArms(n, mask);
    sim.onNodeReset = (n) => { this.advisor.reset(n); };
    this.veh.onGrow((cap) => {
      const r = new Int32Array(cap * ROUTE_CAP); r.set(this.routes); this.routes = r;
      const m = new Int32Array(cap); m.set(this.micro); this.micro = m;
    });
    const onSegs = (cap: number) => {
      this.laneHead = grow(this.laneHead, cap * 16, -1);
      this.laneTail = grow(this.laneTail, cap * 16, -1);
      this.meso.grow(cap * 16);
      this.laneVel = grow(this.laneVel, cap * 16, 0);
      this.laneVelT = grow(this.laneVelT, cap * 16, 0);
      this.laneCount = grow(this.laneCount, cap * 16, 0);
      this.junctions.growLanes(cap * 16);
      this.segLoad = grow(this.segLoad, cap * 2, 0);
      this.segWear = grow(this.segWear, cap, 0);
      this.router.segLoad = this.segLoad;
    };
    sim.net.segs.onGrow(onSegs);
    const onConns = (cap: number) => {
      this.connHead = grow(this.connHead, cap, -1);
      this.connTail = grow(this.connTail, cap, -1);
      this.junctions.growConns(cap);
    };
    sim.conns.onGrow(onConns);
    const onNodes = (cap: number) => {
      this.nodePass = grow(this.nodePass, cap, 0);
      this.lastAdmit = grow(this.lastAdmit, cap, 0);
      this.releaseAt = grow(this.releaseAt, cap, 0);
      this.jamAt = grow(this.jamAt, cap, 0);
    };
    sim.net.nodes.onGrow(onNodes);
    const g = this;
    // the transitions between lanes and connections, for every module
    const moves = {
      moveToLane: (v: number, from: number, to: number) => g.moveToLane(v, from, to), enterConn: (v: number, conn: number) => g.enterConn(v, conn),
      leaveConn: (v: number, cameBy: number) => g.leaveConn(v, cameBy), placeNew: (v: number, lane: number) => g.placeNew(v, lane),
    };
    this.junctions = new Junctions({
      sim,
      veh: { get cols() { return g.veh.cols; }, get alive() { return g.veh.alive; } },
      get time() { return g.time; },
      get laneHead() { return g.laneHead; },
      get laneTail() { return g.laneTail; },
      get laneCount() { return g.laneCount; },
      get connHead() { return g.connHead; },
      get connTail() { return g.connTail; },
      get lines() { return g.lines; },
      get buses() { return g.buses; },
      sig: this.sig,
      get signals() { return g.signals; },
      set signals(v) { g.signals = v; },
      get tmp2() { return g.tmp2; },
      get activeConns() { return g.activeConns; },
      pedCrossing: (n) => g.pedCrossing(n),
      pedCrossingReach: (n, mask, x, z, reach, front) => g.pedCrossingReach(n, mask, x, z, reach, front),
      stopBack: (lane) => g.stopBack(lane),
      nextSeg: (v) => g.nextSeg(v),
      routeAt: (v, k) => g.routeAt(v, k),
      segBetween: (a, b) => g.segBetween(a, b),
      replanFrom: (v, node) => g.replanFrom(v, node),
      finish: (v) => g.finish(v),
      enterLane: (v, s) => g.enterLane(v, s),
      insert: (v, onConn, id) => g.insert(v, onConn, id),
      unlink: (v) => g.unlink(v),
      setLaneCount: (lane, delta) => g.setLaneCount(lane, delta),
      ...moves,
      keptLane: (lane) => g.keptLane(lane),
    });
    this.meso = new Meso({
      sim,
      cols: this.veh.cols,
      get alive() { return g.veh.alive; },
      get time() { return g.time; },
      get camX() { return g.camX; },
      get camZ() { return g.camZ; },
      get window() { return g.window; },
      get laneHead() { return g.laneHead; },
      get laneTail() { return g.laneTail; },
      get laneCount() { return g.laneCount; },
      get lines() { return g.lines; },
      router: this.router,
      sig: this.sig,
      get routeBudget() { return g.routeBudget; },
      get lastAdmit() { return g.lastAdmit; },
      get releaseAt() { return g.releaseAt; },
      get jamAt() { return g.jamAt; },
      countRelease: () => { g.released++; },
      countJam: () => { g.jams++; },
      nextSeg: (v) => g.nextSeg(v),
      segAfter: (v, k) => g.segAfter(v, k),
      pickLane: (seg, dir, after, bus, fallback) => g.pickLane(seg, dir, after, bus, fallback),
      atDestination: (v) => g.atDestination(v),
      dropsOff: (v) => g.kerb.dropsOff(v),
      dropOffTrip: (v, node) => g.kerb.endTrip(v, node),
      finish: (v) => g.finish(v),
      lose: (v) => g.lose(v),
      replanFrom: (v, node) => g.replanFrom(v, node),
      materialize: (lane) => g.materialize(lane),
      serveBus: (v) => g.buses.serve(v),
      busPlan: (v, node) => g.buses.busPlan(v, node),
      addMicro: (v) => g.addMicro(v),
      insert: (v, onConn, lane) => g.insert(v, onConn, lane),
      leaveLane: (v, lane) => g.leaveLane(v, lane),
      setLaneCount: (lane, delta) => g.setLaneCount(lane, delta),
      ...moves,
      enterLane: (v, s) => g.enterLane(v, s),
      admit: (node, arm) => g.admit(node, arm),
      reconsider: (v, lane, ns) => g.reconsider(v, lane, ns),
      crossingDown: (n) => g.crossingDown(n),
      pedCrossing: (n) => g.pedCrossing(n),
    });
    this.buses = new Buses({
      sim,
      veh: this.veh,
      get routes() { return g.routes; },
      router: this.router,
      stops: this.stops,
      get time() { return g.time; },
      get rng() { return g.rng; },
      get sample() { return g.sample; },
      get onAlight() { return g.onAlight; },
      initVehicle: (v) => g.initVehicle(v),
      enterLane: (v, s) => g.enterLane(v, s),
      setLaneCount: (lane, delta) => g.setLaneCount(lane, delta),
      ...moves,
      mesoEnter: (v, lane, spawned) => g.meso.enter(v, lane, spawned),
      despawn: (v) => g.despawn(v),
    });
    this.kerb = new KerbStops({
      get sim() { return g.sim; }, get cols() { return g.veh.cols; },
      centrePose: (lane, s, len, du, out) => g.centrePose(lane, s, len, du, out),
      nextDestination: () => g.zonedNode(g.zoneWeights(false)), replanFrom: (v, node) => g.replanFrom(v, node),
      countTrip: () => { g.arrived++; g.kerbStops++; }, dropOff: (x, z) => g.onDropOff(x, z),
    });
    this.laneChanges = new LaneChanges({
      sim,
      get cols() { return g.veh.cols; },
      get laneHead() { return g.laneHead; },
      get rng() { return g.rng; },
      get time() { return g.time; },
      idm: (v, speed, v0, gap, vl) => g.idm(v, speed, v0, gap, vl),
      unlink: (v) => g.unlink(v),
      setLaneCount: (lane, delta) => g.setLaneCount(lane, delta),
      ...moves,
      insert: (v, onConn, lane) => g.insert(v, onConn, lane),
      nextSeg: (v) => g.nextSeg(v),
    });
    this.microSim = new Micro({
      sim,
      veh: { get cols() { return g.veh.cols; }, get alive() { return g.veh.alive; } },
      get time() { return g.time; },
      get laneHead() { return g.laneHead; },
      get laneTail() { return g.laneTail; },
      get laneCount() { return g.laneCount; },
      get connHead() { return g.connHead; },
      get connTail() { return g.connTail; },
      get routes() { return g.routes; },
      router: this.router,
      meso: this.meso,
      buses: this.buses,
      junctions: this.junctions,
      laneChanges: this.laneChanges,
      advisor: this.advisor,
      get nodePass() { return g.nodePass; },
      get lastAdmit() { return g.lastAdmit; },
      get releaseAt() { return g.releaseAt; },
      get jamAt() { return g.jamAt; },
      get activeLanes() { return g.activeLanes; },
      get activeConns() { return g.activeConns; },
      get lines() { return g.lines; },
      get docks() { return g.docks; },
      get released() { return g.released; }, set released(v) { g.released = v; },
      get jams() { return g.jams; }, set jams(v) { g.jams = v; },
      get ranRed() { return g.ranRed; }, set ranRed(v) { g.ranRed = v; },
      get reroutes() { return g.reroutes; }, set reroutes(v) { g.reroutes = v; },
      get routeBudget() { return g.routeBudget; }, set routeBudget(v) { g.routeBudget = v; },
      pedCrossing: (n) => g.pedCrossing(n),
      arrive: (v, lane, toEnd) => g.arrive(v, lane, toEnd),
      atDestination: (v) => g.atDestination(v),
      dropsOff: (v) => g.kerb.dropsOff(v),
      enterLane: (v, s) => g.enterLane(v, s),
      finish: (v) => g.finish(v),
      inWindowOut: (lane) => g.inWindowOut(lane),
      insert: (v, onConn, id) => g.insert(v, onConn, id),
      kerbStep: (v, lane, dt) => g.kerb.step(v, lane, dt),
      leaveLane: (v, lane) => g.leaveLane(v, lane),
      nearCam: (lane) => g.nearCam(lane),
      nextSeg: (v) => g.nextSeg(v),
      removeMicro: (v) => g.removeMicro(v),
      replanFrom: (v, node) => g.replanFrom(v, node),
      routeAt: (v, k) => g.routeAt(v, k),
      segAfter: (v, k) => g.segAfter(v, k),
      segBetween: (a, b) => g.segBetween(a, b),
      setLaneCount: (lane, delta) => g.setLaneCount(lane, delta),
      ...moves,
      stopBack: (lane) => g.stopBack(lane),
      tryDock: (v, lane) => g.tryDock(v, lane),
      unlink: (v) => g.unlink(v),
    });
    // a network that grew before this Traffic was made (built first, mirrored later): its arrays take the network's
    // size now, as the listeners above do for later growth (else segLoad stayed 1 << 15 and the router read NaN)
    if (sim.net.segs.capacity > this.segWear.length) onSegs(sim.net.segs.capacity);
    if (sim.conns.capacity > this.connHead.length) onConns(sim.conns.capacity);
    if (sim.net.nodes.capacity > this.nodePass.length) onNodes(sim.net.nodes.capacity);
  }

  get count(): number { return this.veh.size; }

  // ------------------------------------------------------------ lists

  /** Inserts v into the list (lane or connection) keeping it ordered by s (front to back). */
  private insert(v: number, onConn: boolean, id: number): void {
    const c = this.veh.cols;
    const head = onConn ? this.connHead : this.laneHead;
    const tail = onConn ? this.connTail : this.laneTail;
    // search from the back forward (it almost always goes at the end)
    let after = tail[id];
    while (after >= 0 && c.s[after] < c.s[v]) after = c.prev[after];
    const before = after >= 0 ? c.next[after] : head[id];
    c.prev[v] = after; c.next[v] = before;
    if (after >= 0) c.next[after] = v; else head[id] = v;
    if (before >= 0) c.prev[before] = v; else tail[id] = v;
    (onConn ? this.activeConns : this.activeLanes).add(id);
  }

  /** Cars pulling into a bay (out of the lane lists: those behind can pass). */
  private parkers = new Set<number>();
  /** Manoeuvres near the camera (Reeds-Shepp): into the bay, out of it, a truck backing into a dock. */
  readonly mvs = new Manoeuvres();
  /** Loading docks near the camera from the page: (x, z, yaw facing the street) per warehouse; their nearest nodes. */
  docks: Float32Array<ArrayBufferLike> = new Float32Array(0);
  /** A passenger gets out at (x, z) on the kerb (the worker makes a pedestrian there). */
  onDropOff: (x: number, z: number) => void = () => {};
  /** Counters for the measurements: kerb drop-offs, trucks at docks. */
  kerbStops = 0;
  docked = 0;
  private mvA = new Float64Array(4);
  private mvB = new Float64Array(4);

  /** The manoeuvres going on, for the page (inspection, photos): [x, z, kind, share done] each, and the counters. */
  manoeuvreList(): { list: number[]; planned: number; kerbStops: number; docked: number; crossings: number[]; trains: number[] } {
    const t = this.mvs.t, mc = t.cols, list: number[] = [], p = this.mvA;
    for (let m = 0; m < t.end; m++) {
      if (!t.alive[m]) continue;
      this.mvs.pose(m, p);
      list.push(p[0], p[1], mc.kind[m], mc.d[m] / Math.max(1e-3, mc.total[m]));
    }
    // cars at the kerb (kind 4 here: the page tells them apart)
    const c = this.veh.cols;
    for (let i = 0; i < this.microN; i++) {
      const v = this.micro[i];
      if (c.phase[v] !== VehPhase.KerbStop || c.lane[v] < 0) continue;
      this.sim.lanePoint(c.lane[v], c.s[v], p);
      list.push(p[0], p[2], 4, Math.min(1, c.dwell[v] / 6));
    }
    // level crossings with the barrier down, and the trains in the window (x, z) for inspection
    const crossings = this.junctions.closedCrossings().filter((n) => this.crossingDown(n)), trains: number[] = [];
    this.lines.forEach((ln, li) => { if (ln.mode) for (const v of this.buses.sets[li]) if (this.veh.alive[v] && c.micro[v] && c.lane[v] >= 0) { this.sim.lanePoint(c.lane[v], c.s[v], p); trains.push(p[0], p[2]); } });
    return { list, planned: this.mvs.planned, kerbStops: this.kerbStops, docked: this.docked, crossings, trains };
  }

  /** Docks near the camera sent by the page: a truck arriving next to one backs into it (they never pick trips). */
  setDocks(pts: Float32Array): void {
    this.docks = pts;
    // by DOCK_CELL cell, so a truck finds the docks beside it without scanning them all
    const n = Math.floor(pts.length / 3);
    const start = new Int32Array(DOCK_CELLS * DOCK_CELLS + 1), idx = new Int32Array(n);
    const cell = (k: number) => this.dockCell(pts[k * 3], pts[k * 3 + 1]);
    for (let k = 0; k < n; k++) start[cell(k) + 1]++;
    for (let i = 0; i < DOCK_CELLS * DOCK_CELLS; i++) start[i + 1] += start[i];
    const fill = start.slice(0, DOCK_CELLS * DOCK_CELLS);
    for (let k = 0; k < n; k++) idx[fill[cell(k)]++] = k * 3;
    this.dockStart = start; this.dockIdx = idx;
  }
  private dockStart = new Int32Array(DOCK_CELLS * DOCK_CELLS + 1);
  private dockIdx = new Int32Array(0);
  private dockCell(x: number, z: number): number {
    const i = Math.min(DOCK_CELLS - 1, Math.max(0, Math.floor((x + MAP_HALF) / DOCK_CELL)));
    const j = Math.min(DOCK_CELLS - 1, Math.max(0, Math.floor((z + MAP_HALF) / DOCK_CELL)));
    return j * DOCK_CELLS + i;
  }

  /** A free dock within YARD_REACH of (x, z) (the docks' first number in `docks`), or −1. */
  private dockNear(x: number, z: number, self: number): number {
    const c = this.veh.cols, d = this.docks;
    let best = -1, bd = YARD_REACH;
    const ci = Math.floor((x + MAP_HALF) / DOCK_CELL), cj = Math.floor((z + MAP_HALF) / DOCK_CELL);
    for (let j = cj - 1; j <= cj + 1; j++) for (let i = ci - 1; i <= ci + 1; i++) {
      if (i < 0 || j < 0 || i >= DOCK_CELLS || j >= DOCK_CELLS) continue;
      const cell = j * DOCK_CELLS + i;
      for (let e = this.dockStart[cell]; e < this.dockStart[cell + 1]; e++) {
        const k = this.dockIdx[e], dist = Math.hypot(d[k] - x, d[k + 1] - z);
        if (dist >= bd) continue;
        const key = this.dockKey(k), holder = this.spots.get(key);
        if (holder !== undefined && holder !== self && this.veh.alive[holder] && c.spot[holder] === key) continue;
        bd = dist; best = k;
      }
    }
    return best;
  }
  private dockKey(k: number): number { const d = this.docks; return (Math.round(d[k]) + 20000) * 40000 + Math.round(d[k + 1]) + 20000 + 1; }

  private nearCam(lane: number): boolean {
    const sc = this.sim.net.segs.cols, sg = laneSeg(lane);
    return Math.hypot(sc.mx[sg] - this.camX, sc.mz[sg] - this.camZ) <= MANOEUVRE_RADIUS;
  }

  /** Centre pose of a vehicle whose front is at s on the lane, moved du metres to the driver's left: [x, y, z, yaw]. */
  private centrePose(lane: number, s: number, len: number, du: number, out: Float64Array): void {
    const sim = this.sim;
    sim.lanePoint(lane, Math.max(0, Math.min(sim.laneLen(lane), s)), out);
    const yaw = out[3];
    out[0] += Math.cos(yaw) * du - Math.sin(yaw) * len / 2;
    out[2] += -Math.sin(yaw) * du - Math.cos(yaw) * len / 2;
  }

  /**
   * Arrived near the end of its trip: a truck backs into a warehouse dock, some cars stop at the kerb to drop a
   * passenger, the others drive into a bay beside the kerb (Reeds-Shepp, near the camera) or, farther away, slide
   * into it. 0 = keep driving, 1 = handled, 2 = it goes away.
   */
  private arrive(v: number, lane: number, toEnd: number): number {
    const c = this.veh.cols;
    if (c.micro[v] && this.nearCam(lane)) {
      if (c.kind[v] === 2 && this.tryDock(v, lane)) return 1;
      if (c.kind[v] === 0 && this.kerb.tryStop(v, lane)) return 1;
      if (c.kind[v] === 0 && this.tryParkManoeuvre(v, lane)) return 1;
    }
    // the same share of drop-offs away from the kerb animation: the trip ends and the car drives on to another; decided
    // with room to brake for wherever the new route turns (it stops at the kerb instead where it can)
    if (this.kerb.dropsOff(v)) {
      if (c.micro[v] && c.kind[v] === 0 && toEnd < 12 && this.kerb.tryStop(v, lane)) return 1;
      if ((toEnd >= 12 || !c.micro[v] || c.kind[v] !== 0 || laneIdx(lane) !== 0) && this.kerb.endTrip(v, this.sim.laneTo(lane))) return 0;
    }
    if (toEnd >= 12) return 0;
    return this.startParking(v, lane) ? 1 : 2;
  }

  /** Bay beside the right lane: drive into it along a Reeds-Shepp path; those behind wait while it is in the lane. */
  /** Docks and bays taken (near the camera): key (a dock by its place, a bay by lane and 7 m slot) → vehicle. */
  private spots = new Map<number, number>();

  /** Takes the dock or bay `key` for `v`; false if another vehicle holds it. */
  private reserve(v: number, key: number): boolean {
    const c = this.veh.cols, holder = this.spots.get(key);
    if (holder !== undefined && holder !== v && this.veh.alive[holder] && c.spot[holder] === key) return false;
    this.spots.set(key, v); c.spot[v] = key;
    return true;
  }

  private releaseSpot(v: number): void {
    const c = this.veh.cols, key = c.spot[v];
    if (key !== 0 && this.spots.get(key) === v) this.spots.delete(key);
    c.spot[v] = 0;
  }

  private tryParkManoeuvre(v: number, lane: number): boolean {
    const c = this.veh.cols, sim = this.sim;
    if (laneIdx(lane) !== 0) return false;
    const pu = parkU(sim.net.segs.cols.profile[laneSeg(lane)], laneDir(lane));
    if (Number.isNaN(pu)) return false;
    const len = c.len[v], bayFront = c.s[v] + len + 3;
    if (bayFront > sim.laneLen(lane) - 4) return false;
    if (!this.reserve(v, -(lane * 4096 + Math.floor(bayFront / 7)) - 1)) return false;
    const du = (pu - sim.laneU(lane)) * laneDir(lane);
    const a = this.mvA, b = this.mvB;
    this.centrePose(lane, c.s[v], len, 0, a);
    this.centrePose(lane, bayFront, len, du, b);
    const m = this.mvs.start(v, MKind.Park, a[0], a[2], a[3], b[0], b[2], b[3], a[1], 5, 12);
    if (m < 0) { this.releaseSpot(v); return false; }
    c.mv[v] = m; c.ms[v] = bayFront; c.phase[v] = VehPhase.Manoeuvre; c.dwell[v] = 0; c.pk[v] = 0;
    return true;
  }

  /** Truck: the nearest dock within 70 m, backed into with the rear at the dock, facing the street. */
  private tryDock(v: number, lane: number): boolean {
    const c = this.veh.cols, d = this.docks, len = c.len[v];
    if (!d.length) return false;
    const a = this.mvA;
    this.centrePose(lane, c.s[v], len, 0, a);
    // the nearest free dock beside it (the yard's gate: within YARD_REACH)
    const best = this.dockNear(a[0], a[2], v);
    if (best < 0 || !this.reserve(v, this.dockKey(best))) return false;
    const yaw = d[best + 2], bx = d[best] + Math.sin(yaw) * len / 2, bz = d[best + 1] + Math.cos(yaw) * len / 2;
    const m = this.mvs.start(v, MKind.Dock, a[0], a[2], a[3], bx, bz, yaw, a[1], 9, 45);
    if (m < 0) { this.releaseSpot(v); return false; }
    c.mv[v] = m; c.ms[v] = -1; c.phase[v] = VehPhase.Manoeuvre; c.dwell[v] = 0;
    this.docked++;
    return true;
  }

  /** Moves the manoeuvres; a parking car or docking truck leaves the lane lists once it is out of the lane. */
  private stepManoeuvres(dt: number): void {
    const t = this.mvs.t, mc = t.cols, c = this.veh.cols, sim = this.sim, p = this.mvA, q = this.mvB;
    for (let m = 0; m < t.end; m++) {
      if (!t.alive[m]) continue;
      const v = mc.veh[m];
      if (!this.veh.alive[v] || c.mv[v] !== m) { this.mvs.end(m); continue; }
      const lane = c.lane[v];
      if (!c.micro[v] || lane < 0 || !sim.net.segs.alive[laneSeg(lane)]) {
        this.mvs.end(m); c.mv[v] = -1;
        if (c.phase[v] === VehPhase.Manoeuvre) this.lose(v);
        continue;
      }
      const kind = mc.kind[m];
      const done = this.mvs.advance(m, dt);
      c.brk[v] = this.mvs.moving(m) ? 0 : 1;
      c.v[v] = 0;
      if (kind === MKind.Unpark) {
        if (done) { this.mvs.end(m); c.mv[v] = -1; c.s[v] = Math.min(sim.laneLen(lane) - 0.5, c.ms[v]); c.pk[v] = 0; c.dwell[v] = 9; }
        continue;
      }
      if (c.phase[v] !== VehPhase.Manoeuvre) continue;
      this.mvs.pose(m, p);
      this.centrePose(lane, c.s[v], c.len[v], 0, q);
      const lat = Math.abs((p[0] - q[0]) * Math.cos(q[3]) - (p[1] - q[2]) * Math.sin(q[3]));
      if (done || lat > (kind === MKind.Dock ? 3.2 : 1.8)) {
        this.unlink(v);
        this.setLaneCount(lane, -1);
        c.phase[v] = VehPhase.Parked; c.dwell[v] = 0;
        this.parkers.add(v);
      }
    }
  }

  /**
   * Arrived: if the right lane has a bay beside it, the car leaves the queue (those behind pass), brakes while pulling
   * into the bay with the right indicator on, stays a moment and disappears. Drawing only: nobody else sees it.
   */
  private startParking(v: number, lane: number): boolean {
    const c = this.veh.cols, sim = this.sim;
    if (c.kind[v] !== 0 || !c.micro[v] || laneIdx(lane) !== 0) return false;
    const pu = parkU(sim.net.segs.cols.profile[laneSeg(lane)], laneDir(lane));
    if (Number.isNaN(pu)) return false;
    this.unlink(v);
    this.setLaneCount(lane, -1);
    c.phase[v] = VehPhase.Parked; c.dwell[v] = 0; c.pk[v] = 0;
    this.parkers.add(v);
    return true;
  }

  /** Those parking: brake, pull over, wait and disappear. */
  private stepParkers(dt: number): void {
    const c = this.veh.cols, sim = this.sim;
    for (const v of this.parkers) {
      const lane = c.lane[v];
      if (!this.veh.alive[v] || lane < 0 || !sim.net.segs.alive[laneSeg(lane)]) { this.parkers.delete(v); if (this.veh.alive[v]) { c.why[v] = End.Lost; this.finish(v); } continue; }
      // on a manoeuvre: it drives itself (stepManoeuvres); once at the end it stays (a truck at the dock longer), then goes
      if (c.mv[v] >= 0) {
        if (this.mvs.moving(c.mv[v]) || this.mvs.t.cols.d[c.mv[v]] < this.mvs.t.cols.total[c.mv[v]] - 1e-3) continue;
        c.dwell[v] += dt;
        if (c.dwell[v] > (c.kind[v] === 2 ? 25 : PARK_STAY + 2)) {
          c.fade[v] -= dt * 1.2;
          if (c.fade[v] <= 0) { this.parkers.delete(v); this.finish(v); }
        }
        continue;
      }
      const nv = Math.max(0, c.v[v] - PARK_DECEL * dt);
      c.s[v] = Math.min(sim.laneLen(lane) - 0.3, c.s[v] + (c.v[v] + nv) * 0.5 * dt);
      c.v[v] = nv;
      c.dwell[v] += dt;
      c.pk[v] = Math.min(1, c.dwell[v] / PARK_SIDE_S);
      c.brk[v] = 1;
      if (nv === 0 && c.dwell[v] > PARK_SIDE_S + PARK_STAY) {
        c.fade[v] -= dt * 1.2;
        if (c.fade[v] <= 0) { this.parkers.delete(v); this.finish(v); }
      }
    }
  }

  private unlink(v: number): void {
    const c = this.veh.cols;
    const onConn = c.conn[v] >= 0;
    const id = onConn ? c.conn[v] : c.lane[v];
    if (id < 0) return;
    const head = onConn ? this.connHead : this.laneHead;
    const tail = onConn ? this.connTail : this.laneTail;
    if (c.prev[v] >= 0) c.next[c.prev[v]] = c.next[v]; else head[id] = c.next[v];
    if (c.next[v] >= 0) c.prev[c.next[v]] = c.prev[v]; else tail[id] = c.prev[v];
    c.next[v] = c.prev[v] = -1;
    if (head[id] < 0) (onConn ? this.activeConns : this.activeLanes).delete(id);
  }

  /** From lane `from` to lane `to`; the lane counts follow (the lists are the caller's). */
  private moveToLane(v: number, from: number, to: number): void {
    this.setLaneCount(from, -1);
    this.setLaneCount(to, 1);
    this.veh.cols.lane[v] = to;
  }

  /** Onto connection `conn`, at the end of its lane. */
  private enterConn(v: number, conn: number): void { this.veh.cols.conn[v] = conn; }

  /** Off its connection onto its lane; `cameBy`: the connection it came out of (its rear may be on it), or -1. */
  private leaveConn(v: number, cameBy: number): void { const c = this.veh.cols; c.conn[v] = -1; c.cameBy[v] = cameBy; }

  /** A new vehicle on `lane`, on no connection. */
  private placeNew(v: number, lane: number): void { const c = this.veh.cols; c.lane[v] = lane; c.conn[v] = -1; c.cameBy[v] = -1; }

  private setLaneCount(lane: number, delta: number): void {
    const n = Math.max(0, this.laneCount[lane] + delta);
    const so = laneSeg(lane) * 2 + (laneDir(lane) > 0 ? 0 : 1);
    this.segLoad[so] = Math.max(0, this.segLoad[so] + n - this.laneCount[lane]);
    this.laneCount[lane] = n;
    const occ = this.occupancy;
    if (!occ) return;
    const seg = laneSeg(lane), dir = laneDir(lane);
    const p = this.sim.net.segs.cols.profile[seg];
    const lanes = laneCount(p, dir);
    let total = 0;
    for (let i = 0; i < lanes; i++) total += this.laneCount[laneId(seg, dir, i)];
    const L = this.sim.laneLen(lane) * Math.max(1, lanes);
    const o = seg * 4 + (dir > 0 ? 0 : 1);
    if (o < occ.length) occ[o] = Math.min(255, Math.round((total * 7.5 / L) * 255));
    // wear: each vehicle entering the lane wears the segment a little (micro and meso: the whole map)
    if (delta > 0 && seg * 4 + 2 < occ.length) {
      const w = (this.segWear[seg] += WEAR_PER_PASS);
      occ[seg * 4 + 2] = Math.min(255, w | 0);
    }
  }

  private addMicro(v: number): void {
    const c = this.veh.cols;
    if (c.micro[v]) return;
    c.micro[v] = 1;
    c.microIdx[v] = this.microN;
    this.micro[this.microN++] = v;
    c.has[v] = 0;
  }

  private removeMicro(v: number): void {
    const c = this.veh.cols;
    if (!c.micro[v]) return;
    c.micro[v] = 0;
    this.wagonPrev.delete(v);
    const i = c.microIdx[v], last = this.micro[--this.microN];
    this.micro[i] = last;
    c.microIdx[last] = i;
  }

  // ------------------------------------------------------------ routes

  private routeAt(v: number, k: number): number { return this.routes[v * ROUTE_CAP + k]; }

  /** Segment between the current route node and the next (-1 if none). */
  private segBetween(a: number, b: number): number {
    const net = this.sim.net, sc = net.segs.cols;
    const o = a * MAX_DEG, d = net.nodes.cols.deg[a];
    // two segments between the same nodes: the one with lanes from a to b (the shorter, if both)
    let any = -1, best = -1;
    for (let k = 0; k < d; k++) {
      const s = net.adj[o + k];
      const fwd = sc.a[s] === a && sc.b[s] === b, back = sc.b[s] === a && sc.a[s] === b;
      if (!fwd && !back) continue;
      if (any < 0) any = s;
      if (laneCount(sc.profile[s], fwd ? 1 : -1) > 0 && (best < 0 || sc.len[s] < sc.len[best])) best = s;
    }
    return best >= 0 ? best : any;
  }

  /** Route from `from`, reached by the vehicle's current lane (if any): only movements the lanes make, U-turns too. */
  private plan(v: number, from: number, dest: number): boolean {
    const c = this.veh.cols;
    const inSeg = c.lane[v] >= 0 && this.sim.laneTo(c.lane[v]) === from ? laneSeg(c.lane[v]) : -1;
    const n = this.router.route(from, dest, this.routes, v * ROUTE_CAP, ROUTE_CAP, false, inSeg);
    c.rLen[v] = n;
    c.rIdx[v] = 1;
    c.dest[v] = dest;
    return n >= 2;
  }

  /** Segment `k` steps after the next one on the route (−1 if the route ends before). */
  private segAfter(v: number, k: number): number {
    const c = this.veh.cols, i = c.rIdx[v] + 1 + k;
    if (i >= c.rLen[v]) return -1;
    return this.segBetween(this.routeAt(v, i - 1), this.routeAt(v, i));
  }

  /** Least full lane of the segment/direction that connects to `after` (−1: any); bus lanes excluded for cars. */
  private pickLane(seg: number, dir: number, after: number, bus: boolean, fallback: number): number {
    const sim = this.sim, n = laneCount(sim.net.segs.cols.profile[seg], dir);
    let best = fallback, bc = fallback >= 0 ? this.laneCount[fallback] : 1e9;
    for (let i = 0; i < n; i++) {
      const l = laneId(seg, dir, i);
      if (!bus && sim.isBusLane(l)) continue;
      if (after >= 0 && sim.connToward(l, after, bus) < 0) continue;
      if (this.laneCount[l] < bc) { bc = this.laneCount[l]; best = l; }
    }
    return best;
  }

  /** Next route segment from the node where the current lane ends. */
  private nextSeg(v: number): number {
    const c = this.veh.cols;
    const k = c.rIdx[v];
    if (k + 1 >= c.rLen[v]) return -1;
    return this.segBetween(this.routeAt(v, k), this.routeAt(v, k + 1));
  }

  /** Replans with the current lane leading to `node` (rIdx = 0 points at it). */
  private replanFrom(v: number, node: number): void {
    const c = this.veh.cols;
    if (c.line[v] >= 0) { this.buses.busPlan(v, node); return; }
    if (node === c.dest[v]) { this.routes[v * ROUTE_CAP] = node; c.rLen[v] = 1; c.rIdx[v] = 0; return; }
    if (!this.plan(v, node, c.dest[v])) { this.lose(v); return; }
    c.rIdx[v] = 0;
  }

  private atDestination(v: number): boolean {
    const c = this.veh.cols;
    return c.rIdx[v] >= c.rLen[v] - 1 && this.routeAt(v, c.rIdx[v]) === c.dest[v];
  }

  // ------------------------------------------------------------ demand

  private randomNode(): number {
    const t = this.sim.net.nodes;
    if (t.size === 0) return -1;
    for (let i = 0; i < 20; i++) {
      const n = this.rng.int(0, t.end);
      if (t.alive[n] && t.cols.deg[n] > 0 && this.byRoad(n)) return n;
    }
    return -1;
  }

  /** Does a road (not only rails) reach node `n`? Car trips start and end only there. */
  private byRoad(n: number): boolean {
    const net = this.sim.net, sc = net.segs.cols;
    for (let k = 0; k < net.nodes.cols.deg[n]; k++) if (!PROFILE_INFO[sc.profile[net.adj[n * MAX_DEG + k]]].rail) return true;
    return false;
  }

  /** Hour of day (from the page) and the player's multipliers. */
  hour = 10;
  /** Chosen demand (0.6 low, 1 normal, 1.5 peak) and traffic percentage. */
  demand = 1;
  trafficShare = 1;

  /** Weight of each zone (none, residential, commercial, industrial, mixed) for origin and destination at the current hour. */
  private zoneWeights(origin: boolean): number[] {
    const h = this.hour;
    const morning = h >= 6 && h < 10, evening = h >= 16 && h < 20;
    // in the morning from home to work; in the evening back; midday, shopping
    const home = [0.15, 1, 0.15, 0.1, 0.5], work = [0.1, 0.2, 1, 0.8, 0.6], mid = [0.15, 0.5, 0.8, 0.4, 0.8];
    if (morning) return origin ? home : work;
    if (evening) return origin ? work : home;
    return mid;
  }

  /** New trips still allowed this step beyond replacing those who arrived (FLEET_TAU). */
  private spawnCredit = 0;
  /** Fleet size at the end of the previous step (up to the target): arrivals are replaced without spending credit. */
  private fleetFloor = 0;

  /** How many cars the hour calls for (daily curve, peaks at 8:00 and 18:00). */
  dayFactor(): number {
    const h = this.hour;
    const peak = (c: number, w: number) => Math.exp(-((h - c) * (h - c)) / (2 * w * w));
    return 0.3 + 0.55 * peak(8, 1.3) + 0.6 * peak(18, 1.5) + 0.35 * peak(13, 2.5) - 0.2 * (h < 5 || h > 23 ? 1 : 0);
  }

  /** Occupancy per region from the regions' last measurement (read-only view). */
  get regionOcc(): Float32Array { return this.regions.occ; }
  regionOf(x: number, z: number): number { return this.regions.of(x, z); }
  /** Turns off region avoidance (A/B measurement). */
  get regionAvoid(): boolean { return this.regions.avoid; }
  set regionAvoid(v: boolean) { this.regions.avoid = v; }
  /** Fraction of the fleet the network carries now (governor) and the share on jammed streets. */
  get gov(): number { return this.regions.gov; }
  set gov(v: number) { this.regions.gov = v; }
  get jamShare(): number { return this.regions.jamShare; }
  set jamShare(v: number) { this.regions.jamShare = v; }
  get jammedNow(): number { return this.regions.jammedNow; }
  /** Turns off the governor (A/B measurement). */
  get governed(): boolean { return this.regions.governed; }
  set governed(v: boolean) { this.regions.governed = v; }

  /** Node picked by the zone of the surrounding roads (rejection sampling: O(1) expected). */
  private zonedNode(weights: number[]): number {
    const net = this.sim.net, t = net.nodes, sc = net.segs.cols;
    for (let i = 0; i < 24; i++) {
      const n = this.randomNode();
      if (n < 0) return -1;
      let w = 0, front = 0, occ = 0;
      for (let k = 0; k < t.cols.deg[n]; k++) {
        const s = net.adj[n * MAX_DEG + k];
        w = Math.max(w, weights[baseZone(sc.zl[s])] ?? 0.1, weights[baseZone(sc.zr[s])] ?? 0.1);
        front += sc.len[s] * 0.5;
        const info = PROFILE_INFO[sc.profile[s]], cap = sc.len[s] / 7.5;
        occ = Math.max(occ, this.segLoad[s * 2] / (cap * Math.max(1, info.lanesFwd)), this.segLoad[s * 2 + 1] / (cap * Math.max(1, info.lanesBack)));
      }
      // by the street length around it (the lots), not per node: tightly packed junctions downtown do not become
      // the origin and destination of extra trips
      w *= Math.min(1, front / 120);
      // congested surrounding street: the trip starts (or ends) somewhere else, like people avoiding the rush hour or
      // the gridlocked district; without it the centre piles up cars until it jams (same fleet, only where changes)
      if (this.crowdAvoid && occ > CROWD_OCC) w *= Math.max(0, 1 - (occ - CROWD_OCC) * CROWD_SLOPE);
      if (this.regionAvoid) {
        const ro = this.regionOcc[this.regionOf(t.cols.x[n], t.cols.z[n])];
        if (ro > REGION_OCC) w *= Math.max(0.05, 1 - (ro - REGION_OCC) * REGION_SLOPE);
      }
      if (this.rng.next() < w) return n;
    }
    return this.randomNode();
  }

  private spawn(): void {
    const net = this.sim.net, nc = net.nodes.cols;
    // the kind first: trucks carry goods between industry and commerce (anywhere in the city, never by the camera)
    const r = this.rng.next(), kind = r < 0.88 ? 0 : r < 0.94 ? 1 : 2;
    const a = this.zonedNode(kind === 2 ? TRUCK_ZONES : this.zoneWeights(true));
    if (a < 0) return;
    let b = -1;
    const wd = kind === 2 ? TRUCK_ZONES : this.zoneWeights(false);
    for (let i = 0; i < 16; i++) {
      const cand = this.zonedNode(wd);
      if (cand < 0 || cand === a) continue;
      const d = Math.hypot(nc.x[cand] - nc.x[a], nc.z[cand] - nc.z[a]);
      // short trips are more common (mean distance ~2.5 km)
      if (d > 200 && d < 7000 && this.rng.next() < Math.exp(-d / 2500)) { b = cand; break; }
    }
    if (b < 0) return;
    const v = this.veh.alloc();
    this.initVehicle(v, kind);
    if (!this.plan(v, a, b)) { this.veh.release(v); return; }
    const seg = this.segBetween(a, this.routeAt(v, 1));
    if (seg < 0) { this.veh.release(v); return; }
    const dir = net.segs.cols.a[seg] === a ? 1 : -1;
    const after = this.nextSeg(v);
    const lane = this.pickLane(seg, dir, after, false, after >= 0 ? this.sim.laneToward(seg, dir, after, 0, false) : laneId(seg, dir, 0));
    if (lane < 0 || laneCount(net.segs.cols.profile[seg], dir) === 0) { this.veh.release(v); return; }
    // lane full: nowhere to pull out with the car (the trip is born elsewhere)
    if (this.laneCount[lane] + 1 > this.sim.laneLen(lane) / 7.5) { this.veh.release(v); return; }
    const c = this.veh.cols;
    c.lane[v] = lane; c.conn[v] = -1;
    // Never born on the stop line or the crosswalk: keep the front (and the body) before it.
    const born = Math.max(0, this.sim.laneLen(lane) - this.stopBack(lane) - c.len[v] - 1);
    c.s[v] = this.rng.next() * born;
    this.enterLane(v, c.s[v]);
    this.setLaneCount(lane, 1);
    if (this.leaveBay(v, lane)) return;
    this.meso.enter(v, lane, true);
    // born inside the window: drawn from the start
    if (this.meso.inWindow(lane)) this.materialize(lane);
  }

  /**
   * Born near the camera (350 m), in the right lane of a segment with bays: pulls out of the bay (stopped at the kerb,
   * left indicator, merges into the lane) instead of driving invisibly in meso to the next corner. Only with room behind.
   */
  private leaveBay(v: number, lane: number): boolean {
    const c = this.veh.cols, sim = this.sim;
    if (c.kind[v] !== 0 || laneIdx(lane) !== 0) return false;
    // only where it is visible (350 m from the camera): elsewhere in the micro window, spawning in meso looks the same and costs less
    const sc = sim.net.segs.cols, sg = laneSeg(lane);
    if (Math.hypot(sc.mx[sg] - this.camX, sc.mz[sg] - this.camZ) > 350) return false;
    if (Number.isNaN(parkU(sim.net.segs.cols.profile[laneSeg(lane)], laneDir(lane)))) return false;
    const s = c.s[v];
    if (s < 10 || s > sim.laneLen(lane) - 25) return false;
    for (let o = this.laneHead[lane]; o >= 0; o = c.next[o]) {
      const d = c.s[o] - s;
      if (d > -40 && d < c.len[o] + 8) return false; // someone coming from behind or just ahead
    }
    c.v[v] = 0; c.pk[v] = 1; c.dwell[v] = 0; c.held[v] = 0; c.fade[v] = 0;
    this.addMicro(v);
    this.insert(v, false, lane);
    // pull out of the bay along a Reeds-Shepp path (held in place until it is back in the lane)
    const du = (parkU(sc.profile[sg], laneDir(lane)) - sim.laneU(lane)) * laneDir(lane);
    const a = this.mvA, b = this.mvB, len = c.len[v];
    this.centrePose(lane, s, len, du, a);
    this.centrePose(lane, s + 7, len, 0, b);
    const m = this.mvs.start(v, MKind.Unpark, a[0], a[2], a[3], b[0], b[2], b[3], a[1], 5, 4);
    if (m >= 0) { c.mv[v] = m; c.ms[v] = s + 7; }
    return true;
  }

  private initVehicle(v: number, kind = 0): void {
    const c = this.veh.cols;
    c.kind[v] = kind; c.len[v] = KIND_LEN[kind];
    c.color[v] = this.rng.int(0, 16);
    let style = 0;
    if (kind === 0) {
      let u = this.rng.next();
      while (style < CAR_STYLE_SHARE.length - 1 && u >= CAR_STYLE_SHARE[style]) u -= CAR_STYLE_SHARE[style++];
      c.color[v] |= style << 4;
      c.len[v] = CAR_STYLE_LEN[style];
    }
    // the driver: its class's comfort figures and its own aggression; the share of the limit it drives at
    c.vf[v] = drawDriver(c, v, archOf(kind, style), this.sample);
    c.lane[v] = -1; c.conn[v] = -1; c.cameBy[v] = -1;
    c.brk[v] = 0; c.exitC[v] = -1; c.pk[v] = 0; c.mv[v] = -1; c.ms[v] = 0;
    c.micro[v] = 0; c.phase[v] = VehPhase.Driving; c.fade[v] = 1; c.has[v] = 0;
    c.next[v] = c.prev[v] = -1; c.lcFrom[v] = -1; c.lcT[v] = 1; c.lcCool[v] = this.rng.next() * 2;
    c.v[v] = 0;
    c.line[v] = -1; c.stopI[v] = 0; c.dwell[v] = 0; c.load[v] = 0; c.served[v] = 0; c.wait[v] = 0;
    c.held[v] = 0; c.why[v] = End.Arrived; c.ml[v] = -1; c.mnext[v] = -1; c.mprev[v] = -1; c.spot[v] = 0;
  }

  /** The trip will not reach its destination: the vehicle fades out and is counted as lost. */
  private lose(v: number): void {
    const c = this.veh.cols;
    if (c.why[v] === End.Arrived) c.why[v] = End.Lost;
    if (c.phase[v] !== VehPhase.Parked) c.phase[v] = VehPhase.Leaving;
  }

  /** The vehicle leaves the simulation and its trip is counted (arrived or lost; a bus is not a trip). */
  private finish(v: number): void {
    const c = this.veh.cols;
    if (c.line[v] < 0 && c.why[v] !== End.NoTrip) { if (c.why[v] === End.Lost) this.lost++; else this.arrived++; }
    this.despawn(v);
  }

  private despawn(v: number): void {
    const c = this.veh.cols;
    this.meso.unlink(v);
    if (c.spot[v] !== 0) this.releaseSpot(v);
    if (c.line[v] >= 0) this.buses.forget(v);
    this.wagonPrev.delete(v);
    if (c.mv[v] >= 0) { this.mvs.end(c.mv[v]); c.mv[v] = -1; }
    const parked = c.phase[v] === VehPhase.Parked;
    if (c.micro[v]) { if (!parked) this.unlink(v); this.removeMicro(v); }
    if (c.lane[v] >= 0 && !parked) this.setLaneCount(c.lane[v], -1);
    if (parked) { this.parkers.delete(v); c.phase[v] = VehPhase.Leaving; }
    c.lane[v] = -1; c.conn[v] = -1;
    c.tExit[v] = -1;
    this.veh.release(v);
  }

  // ------------------------------------------------------------ junctions

  /**
   * Is a vehicle on the crosswalk over arm `arm` of node `n`, or about to drive over it (over its stop line with the
   * way open, or coming at speed within 3 m of it, on a connection leaving by that arm, or still crossing it on the
   * way out)? The pedestrians ask before stepping off the kerb (roadcraft crossings/permission). Near the camera only:
   * the first vehicle of each lane and the connections of the node.
   */
  carsOnCrossing(n: number, arm: number): boolean { return this.junctions.carsOnCrossing(n, arm); }

  gateOpen(conn: number): boolean { return this.junctions.gateOpen(conn); }

  crossingDown(n: number): boolean { return this.junctions.crossingDown(n); }

  evacuateConn(conn: number): void { this.junctions.evacuateConn(conn); }

  private updateSignals(dt: number): void {
    const sim = this.sim;
    this.sig.step(dt);
    for (const n of this.signalNodes) {
      if (!sim.net.nodes.alive[n] || sim.nodePhases[n] === 0) { this.signalNodes.delete(n); this.windowSignals.delete(n); this.sig.setActive(n, false); if (this.signals && n < this.signals.length) this.signals[n] = 0; continue; }
      if (this.signals && n < this.signals.length) this.signals[n] = this.lightState(n);
    }
  }

  /** A light's state as written for the drawing: 128 | amber << 6 | arms with green or amber (0: no light). */
  lightState(n: number): number {
    if (this.sim.nodePhases[n] === 0) return 0;
    const st = this.sig.state(n), mask = (st & 3) < 2 ? this.sig.arms[n * 8 + (st >> 2)] : 0;
    return 128 | ((st & 3) === 1 ? 64 : 0) | (mask & 63);
  }

  /** Vehicles waiting near the line on the arms of node `n` in `mask`. */
  private armsQueue(n: number, mask: number): number {
    let q = 0;
    const deg = this.sim.net.nodes.cols.deg[n];
    for (let a = 0; a < deg && a < 8; a++) if (mask & (1 << a)) q += this.armQueue(n, a);
    return q;
  }

  /** A bus within 40 m of the line on one of the arms in `mask`. */
  private busNearArms(n: number, mask: number): boolean {
    const sim = this.sim, k = sim.conns.cols, c = this.veh.cols;
    for (let x = sim.nodeConn[n]; x >= 0; x = k.nextAtNode[x]) {
      if ((mask & (1 << k.arm[x])) === 0) continue;
      const h = this.laneHead[k.from[x]];
      if (h >= 0 && c.line[h] >= 0 && sim.laneLen(k.from[x]) - c.s[h] < 40) return true;
    }
    return false;
  }

  /** May pedestrians start crossing arm `arm` of node `n`? (every light, near the camera or not) */
  walkOk(n: number, arm: number): boolean { return this.sig.walkOk(n, arm); }

  /** A pedestrian waits at the kerb of the crossing over arm `arm` of node `n`: calls the light. */
  pedCall(n: number, arm: number): void { this.sig.pedCall(n, arm); }

  /** Vehicles waiting on an arm (near the stop line; far ones counted up to 4 per lane). */
  private armQueue(n: number, arm: number): number {
    const sim = this.sim, c = this.veh.cols, sc = sim.net.segs.cols;
    const seg = sim.armSeg[n * 8 + arm];
    if (!sim.net.segs.alive[seg]) return 0;
    const dir = sc.b[seg] === n ? 1 : -1; // lanes that arrive at n
    let q = 0;
    for (let i = 0, m = laneCount(sc.profile[seg], dir); i < m; i++) {
      const lane = laneId(seg, dir, i), L = sim.laneLen(lane);
      for (let v = this.laneHead[lane]; v >= 0 && L - c.s[v] < 80; v = c.next[v]) q++;
      if (this.laneHead[lane] < 0) q += Math.min(4, this.laneCount[lane]);
    }
    return q;
  }

  /** A connection is about to disappear (node rebuilt): those on it jump to the destination lane. */
  /** Rebuilt nodes: a new plan for their lights, which start their cycle again. */
  nodesRebuilt(nodes: number[]): void {
    this.junctions.resettleBox();
    for (const n of nodes) {
      this.sig.rebuild(n);
      if (!this.sim.net.nodes.alive[n] || this.sim.nodePhases[n] === 0) {
        this.signalNodes.delete(n);
        if (this.windowSignals.delete(n) && this.signals && n < this.signals.length) this.signals[n] = 0;
        continue;
      }
      this.signalNodes.add(n);
      if (this.windowSignals.has(n)) this.sig.setActive(n, true);
    }
  }

  /** Removed segments: vehicles on their lanes leave. */
  segsRemoved(segs: number[]): void {
    if (!segs.length) return;
    const dead = new Set(segs);
    const c = this.veh.cols;
    // far vehicles on them leave now (from the lanes' lists), before a new segment can take the freed id
    for (const s of segs) for (let k = 0; k < 16; k++) {
      for (let v = this.mesoHead[s * 16 + k]; v >= 0;) { const next = c.mnext[v]; c.why[v] = End.Lost; this.finish(v); v = next; }
    }
    // near ones: on the lanes, or on a connection into them
    for (let i = this.microN - 1; i >= 0; i--) {
      const v = this.micro[i];
      const lane = c.conn[v] >= 0 ? this.sim.conns.cols.to[c.conn[v]] : c.lane[v];
      if (dead.has(laneSeg(lane)) || (c.lane[v] >= 0 && dead.has(laneSeg(c.lane[v])))) { c.why[v] = End.Lost; this.finish(v); }
    }
    for (const s of segs) { this.segLoad[s * 2] = 0; this.segLoad[s * 2 + 1] = 0; }
    for (const s of segs) for (let k = 0; k < 16; k++) { this.laneCount[s * 16 + k] = 0; this.laneHead[s * 16 + k] = -1; this.laneTail[s * 16 + k] = -1; this.activeLanes.delete(s * 16 + k); }
  }

  /** The lane that takes over `lane` after its segment's profile changed: itself, the outermost one left, or −1 (no lanes that way). */
  private keptLane(lane: number): number {
    const seg = laneSeg(lane), dir = laneDir(lane), n = laneCount(this.sim.net.segs.cols.profile[seg], dir);
    if (n === 0) return -1;
    return laneIdx(lane) < n ? lane : laneId(seg, dir, n - 1);
  }

  /**
   * Segments with a new profile (an upgrade, a lane more or less): the vehicles on lanes that are gone move to the
   * outermost lane left in their direction (near ones keep their place in it); with no lane left that way, their trip is lost.
   */
  segsReprofiled(segs: number[]): void {
    const c = this.veh.cols;
    for (const s of segs) {
      if (!this.sim.net.segs.alive[s]) continue;
      for (const dir of [1, -1]) for (let i = 0; i < 8; i++) {
        const lane = laneId(s, dir, i), to = this.keptLane(lane);
        if (to === lane) continue;
        for (let v = this.mesoHead[lane]; v >= 0;) {
          const next = c.mnext[v];
          if (to < 0) { c.why[v] = End.Lost; this.finish(v); }
          else { this.setLaneCount(lane, -1); this.setLaneCount(to, 1); c.lane[v] = to; this.meso.link(v, to); }
          v = next;
        }
        for (let v = this.laneHead[lane]; v >= 0;) {
          const next = c.next[v];
          if (to < 0) { c.why[v] = End.Lost; this.finish(v); }
          else { this.unlink(v); this.setLaneCount(lane, -1); this.setLaneCount(to, 1); c.lane[v] = to; c.lcT[v] = 1; this.insert(v, false, to); }
          v = next;
        }
        this.laneCount[lane] = 0;
      }
    }
    // pulled into a bay (out of the lists): only the drawing reads their lane
    for (const v of this.parkers) if (c.lane[v] >= 0 && segs.includes(laneSeg(c.lane[v]))) { const to = this.keptLane(c.lane[v]); if (to >= 0) c.lane[v] = to; }
  }

  // ------------------------------------------------------------ micro

  /** Uniform in [0, 1) from the simulation's generator (for drawing drivers). */
  readonly sample = () => this.rng.next();

  /** IDM acceleration of driver `u` at speed `v` (its own comfort figures) with a leader `gap` metres ahead at `vl`. */
  private idm(u: number, v: number, v0: number, gap: number, vl: number): number { return this.microSim.idm(u, v, v0, gap, vl); }

  private stepMicro(dt: number): void { this.microSim.stepMicro(dt); }

  private admit(n: number, arm: number): void { this.microSim.admit(n, arm); }

  private reconsider(v: number, lane: number, blocked: number): boolean { return this.microSim.reconsider(v, lane, blocked); }

  private inWindowOut(lane: number): boolean {
    const sc = this.sim.net.segs.cols, s = laneSeg(lane);
    return Math.hypot(sc.mx[s] - this.camX, sc.mz[s] - this.camZ) < this.window + WINDOW_OUT - WINDOW;
  }

  // ------------------------------------------------------------ buses

  /**
   * Replaces the set of lines (the page sends them again after every road edit, so the stops follow the roads).
   * What each line keeps (buses, riders, those waiting) lives in traffic/buses.ts.
   */
  setLines(specs: LineSpec[]): void { this.buses.setLines(specs); }

  /** A pedestrian arrived at stop `from` wanting to go to `to`. */
  pedAtStop(li: number, from: number, to: number): void { this.buses.pedAtStop(li, from, to); }

  /** For pedestrians: a random bus trip (line, boarding stop, alighting stop, boarding node, the stop on the sidewalk). */
  pickTrip(): [number, number, number, number, number, number] | null { return this.buses.pickTrip(); }

  /** Those waiting at stops near the camera (standing people, up to 14 per stop). */
  writeStopPeople(data: Float32Array, stride: number, start: number, max: number): number { return this.stops.write(this.lines, this.camX, this.camZ, this.time, data, stride, start, max); }

  /** Line figures for the interface (passengers per hour). */
  lineStats(dtReport: number): Array<{ id: number; buses: number; perHour: number; waiting: number }> { return this.stops.stats(this.lines, this.buses.sets, this.time, dtReport); }

  // ------------------------------------------------------------ window

  /** The camera moved: those now far away become meso; window signals. */
  checkWindow(): void {
    const c = this.veh.cols, sim = this.sim;
    const old = this.windowSignals;
    this.windowSignals = new Set<number>();
    const r = this.window + WINDOW_OUT - WINDOW;
    sim.net.nodeIndex.query(this.camX - r, this.camZ - r, this.camX + r, this.camZ + r, (n) => {
      if (sim.nodePhases[n] > 0 && this.signalNodes.has(n)) this.windowSignals.add(n);
    });
    // those that left the window go back to their timed cycle; the drawing keeps the real state (updateSignals writes every signalled node)
    for (const n of old) if (!this.windowSignals.has(n)) this.sig.setActive(n, false);
    for (const n of this.windowSignals) this.sig.setActive(n, true);
    for (let i = this.microN - 1; i >= 0; i--) {
      const v = this.micro[i];
      if (c.conn[v] >= 0 || c.phase[v] === VehPhase.Parked) continue;
      const lane = c.lane[v];
      if (this.inWindowOut(lane)) continue;
      // what only exists near the camera ends here, counted: a drop-off at the kerb finishes its trip and the car goes
      // on to the next; a car or truck manoeuvring into its bay or dock has arrived; one fading out leaves
      if (c.mv[v] >= 0) { this.mvs.end(c.mv[v]); c.mv[v] = -1; }
      if (c.phase[v] === VehPhase.Manoeuvre || c.phase[v] === VehPhase.Leaving) { this.finish(v); continue; }
      if (c.phase[v] === VehPhase.KerbStop) {
        c.phase[v] = VehPhase.Driving; c.served[v] = 0;
        if (!this.kerb.endTrip(v, this.sim.laneTo(lane))) { this.arrived++; this.kerbStops++; c.why[v] = End.NoTrip; this.finish(v); continue; }
      }
      c.pk[v] = 0;
      this.unlink(v);
      this.removeMicro(v);
      this.meso.enter(v, lane, true);
    }
    // far-model vehicles on lanes now inside the window become drawn ones (the window came to them, or they were born
    // there): nobody inside the window is invisible, holding a queue or an exit's room unseen
    const sc = sim.net.segs.cols, w = this.window;
    sim.net.segIndex.query(this.camX - w, this.camZ - w, this.camX + w, this.camZ + w, (s) => {
      if (!sim.net.segs.alive[s] || Math.hypot(sc.mx[s] - this.camX, sc.mz[s] - this.camZ) >= w) return;
      for (let k = 0; k < 16; k++) if (this.mesoHead[s * 16 + k] >= 0) this.materialize(s * 16 + k);
    });
  }

  /**
   * The far-model vehicles of a lane become near ones, in their order on it: each where its timing says it is by now,
   * behind the vehicles already drawn and at least a car length plus 2 m behind the one ahead (a queue fills from the
   * line backwards). Those that do not fit stay in the far model until they move on.
   */
  private materialize(lane: number): void {
    const c = this.veh.cols, sim = this.sim, L = sim.laneLen(lane);
    const tail = this.laneTail[lane];
    let limit = tail >= 0 ? c.s[tail] - c.len[tail] - 2 : L - 0.5;
    const free = laneSpeed(sim.net.segs.cols.profile[laneSeg(lane)]);
    for (let v = this.mesoHead[lane]; v >= 0;) {
      const next = c.mnext[v];
      if (c.phase[v]) { this.finish(v); v = next; continue; }
      const span = c.tExit[v] - c.tIn[v];
      const est = span > 0 ? c.s0[v] + (L - c.s0[v]) * Math.min(1, Math.max(0, (this.time - c.tIn[v]) / span)) : L;
      // (one that has just come in stands at the start of the lane, whole)
      if (limit < c.len[v]) break;
      const s = Math.max(c.len[v], Math.min(est, limit));
      this.meso.unlink(v);
      c.s[v] = s; c.conn[v] = -1; c.cameBy[v] = -1; c.held[v] = 0; c.wait[v] = 0;
      // in a queue it stands; otherwise it drives at what the lane has been driving at
      c.v[v] = s < est - 1 ? 0 : Math.min(free * c.vf[v], this.laneVel[lane] > 0 ? this.laneVel[lane] : free * 0.7);
      // never faster than what still stops comfortably at the line (whatever the junction asks of it there)
      c.v[v] = Math.min(c.v[v], Math.sqrt(2 * c.db[v] * Math.max(0, L - s - 1)));
      c.acc[v] = 0;
      c.fade[v] = 0;
      this.addMicro(v);
      this.insert(v, false, lane);
      limit = s - c.len[v] - 2;
      v = next;
    }
  }

  // ------------------------------------------------------------ step

  step(dt: number): void {
    this.time += dt;
    this.regions.measure(this.time, this.sim.net, this.segLoad);
    this.routeBudget = ROUTE_BUDGET;
    this.advisor.step(this.time);
    const target = Math.min(MAX_VEHICLES, Math.floor(this.sim.laneMeters * this.density * this.dayFactor() * this.demand * this.trafficShare * this.gov));
    // replace arrivals and grow at the FLEET_TAU pace (an opening map fills at once)
    const have = this.veh.size;
    if (have < target * FILL_SHARE) this.spawnCredit = target - have;
    else this.spawnCredit = Math.min(this.spawnCredit + Math.max(0, target - have) * dt / FLEET_TAU, Math.max(0, target - have));
    // (each attempt is a route search: few failures per step, the rest try on the next)
    for (let k = 0, fails = 0; k < 60 && fails < 8 && this.veh.size < target && (this.veh.size < this.fleetFloor || this.spawnCredit >= 1); k++) {
      const before = this.veh.size;
      this.spawn();
      if (this.veh.size === before) fails++;
      else if (this.veh.size > this.fleetFloor) this.spawnCredit--;
    }
    this.fleetFloor = Math.min(this.veh.size, target);
    this.buses.tick(dt);
    this.updateSignals(dt);
    this.junctions.updateCrossings();
    this.meso.process();
    this.mvs.beginStep();
    this.stepMicro(dt);
    this.stepManoeuvres(dt);
    this.stepParkers(dt);
  }

  /** Train wagons: one pose per wagon, following the track backwards (previous pose stored per wagon). */
  private wagonPrev = new Map<number, Float32Array>();
  private writeTrain(v: number, data: Float32Array, stride: number, n: number, p: Float64Array): number {
    const c = this.veh.cols;
    let prev = this.wagonPrev.get(v);
    const first = !prev;
    if (!prev) { prev = new Float32Array(WAGONS * 4); this.wagonPrev.set(v, prev); }
    for (let k = 0; k < WAGONS; k++) {
      backAlong(this.sim, c.lane[v], c.conn[v], c.s[v], WAGON_LEN * (k + 0.5), p, c.cameBy[v]);
      // heading along the line between the wagon's ends (curves)
      const fx = p[0], fz = p[2];
      backAlong(this.sim, c.lane[v], c.conn[v], c.s[v], WAGON_LEN * k + 1, this.tmp2, c.cameBy[v]);
      const yaw = Math.atan2(this.tmp2[0] - fx, this.tmp2[2] - fz);
      const o = n * stride, q = k * 4;
      if (first) { prev[q] = fx; prev[q + 1] = p[1]; prev[q + 2] = fz; prev[q + 3] = yaw; }
      data[o] = prev[q]; data[o + 1] = prev[q + 1]; data[o + 2] = prev[q + 2]; data[o + 3] = prev[q + 3];
      data[o + 4] = fx; data[o + 5] = p[1]; data[o + 6] = fz; data[o + 7] = yaw;
      data[o + 8] = 4 * 256 + c.color[v] + (k === 0 ? 128 : 0);
      data[o + 10] = v & 0xffff;
      data[o + 9] = Math.max(0, Math.min(1, c.fade[v]));
      prev[q] = fx; prev[q + 1] = p[1]; prev[q + 2] = fz; prev[q + 3] = yaw;
      n++;
    }
    return n;
  }

  /** Writes the poses of the micro vehicles (previous and current). */
  private turnTmp = new Float64Array(4);
  /**
   * Vehicle lights: brake, and the turn indicator (inside the junction, or within 45 m of it with the exit already
   * chosen) or the lane-change one (`lights` passed in). Left = the heading increases along the connection.
   */
  private lightBits(v: number, lights: number): number {
    const c = this.veh.cols, sim = this.sim;
    if (c.brk[v]) lights |= LIGHT_BRAKE;
    if (lights & (LIGHT_LEFT | LIGHT_RIGHT)) return lights;
    let conn = c.conn[v];
    if (conn < 0 && c.lane[v] >= 0 && sim.laneLen(c.lane[v]) - c.s[v] < 45) conn = c.exitC[v];
    if (conn < 0 || !sim.conns.alive[conn]) return lights;
    const t = this.turnTmp;
    sim.connPoint(conn, 0, t); const y0 = t[3];
    sim.connPoint(conn, sim.conns.cols.len[conn], t);
    let d = t[3] - y0;
    d = ((d + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    if (d > 0.35) lights |= LIGHT_LEFT; else if (d < -0.35) lights |= LIGHT_RIGHT;
    return lights;
  }

  /**
   * The vehicles within `r` m of (x, z), as the motion probe reads them (tools/check-sim.mjs): INSPECT_STRIDE numbers
   * each (id, kind, middle x, z, yaw, length, speed, connection, node ahead, why it may stand (INSPECT_* bits), gap
   * to the vehicle ahead, its speed, distance to the stop line, time waited at the line, time stopped, position on the lane or connection, strip of the street under its middle (sim/probe.ts STRIP_KINDS)
   * and the distance from the street's nearer end), and the pairs
   * inside the same junction on paths that cross, both over the crossing point (id, id, x, z). Only the micro window
   * is looked at, and only on request.
   */
  inspect(x: number, z: number, r: number): { vehicles: Float32Array; clashes: Float32Array } {
    const c = this.veh.cols, sim = this.sim, k = sim.conns.cols, p = this.tmp;
    const out: number[] = [], onConn: number[] = [];
    for (let i = 0; i < this.microN; i++) {
      const v = this.micro[i];
      if (c.kind[v] === 4) this.headOf(v, p); else this.centreOf(v, p);
      if (Math.hypot(p[0] - x, p[2] - z) > r) continue;
      const conn = c.conn[v], lane = c.lane[v];
      let flags = 0, gap = 999, vl = 0, toEnd = 0, node = -1;
      if (conn >= 0) { node = k.node[conn]; onConn.push(v); }
      else if (lane >= 0) {
        node = sim.laneTo(lane);
        toEnd = sim.laneLen(lane) - c.s[v];
        const arm = sim.segArm[laneSeg(lane) * 2 + (laneDir(lane) > 0 ? 1 : 0)];
        if (sim.nodePhases[node] > 0 && !this.sig.go(node, arm, true)) flags |= INSPECT_RED;
        const lead = c.prev[v];
        if (lead >= 0 && c.lane[lead] === lane && c.conn[lead] < 0) { gap = c.s[lead] - c.len[lead] - c.s[v]; vl = c.v[lead]; }
        if (toEnd < 8 && c.wait[v] > 0) flags |= INSPECT_GATE;
        const ctl = sim.nodeCtl[node];
        if ((ctl === Ctl.Crossing && this.crossingDown(node)) || (ctl === Ctl.Zebra && this.pedCrossing(node))) flags |= INSPECT_GATE;
      }
      if (c.pk[v] > 0 || c.mv[v] >= 0) flags |= INSPECT_BAY;
      if (c.pass[v]) flags |= INSPECT_PASS; // over its line with the way open: it is not an approach violation
      if (c.phase[v]) flags |= INSPECT_LEAVING;
      if (c.line[v] >= 0 && c.dwell[v] > 0) flags |= INSPECT_STOP;
      if (c.lcT[v] < 1) flags |= INSPECT_CHANGING;
      const [strip, fromEnd] = stripAt(sim, p[0], p[2]);
      out.push(v, c.kind[v], p[0], p[2], p[3], c.len[v], c.v[v], conn, node, flags, gap, vl, toEnd, c.wait[v], c.held[v], c.s[v], strip, fromEnd);
    }
    // paths that cross inside a junction: both bodies over the crossing point at once
    const clashes: number[] = [];
    for (let a = 0; a < onConn.length; a++) for (let b = a + 1; b < onConn.length; b++) {
      const va = onConn[a], vb = onConn[b], ca = c.conn[va], cb = c.conn[vb];
      if (ca === cb || k.node[ca] !== k.node[cb]) continue;
      const list = sim.conflicts.get(ca);
      if (!list || !list.includes(cb)) continue;
      const hit = this.crossAt(ca, cb);
      if (!hit) continue;
      const over = (v: number, s: number) => c.s[v] + 0.5 >= s && c.s[v] - c.len[v] - 0.5 <= s;
      if (over(va, hit[0]) && over(vb, hit[1])) clashes.push(va, vb, hit[2], hit[3]);
    }
    return { vehicles: Float32Array.from(out), clashes: Float32Array.from(clashes) };
  }

  /** Where connections a and b cross: [position along a, along b, x, z] (the end of both when they merge), or null. */
  private crossAt(a: number, b: number): [number, number, number, number] | null {
    const k = this.sim.conns.cols, P = 16;
    const pt = (x: number, t: number) => {
      const s = 1 - t;
      return [s * s * k.x0[x] + 2 * s * t * k.cx[x] + t * t * k.x1[x], s * s * k.z0[x] + 2 * s * t * k.cz[x] + t * t * k.z1[x]];
    };
    for (let i = 0; i < P; i++) {
      const [ax, az] = pt(a, i / P), [bx, bz] = pt(a, (i + 1) / P);
      for (let j = 0; j < P; j++) {
        const [cx, cz] = pt(b, j / P), [dx, dz] = pt(b, (j + 1) / P);
        const den = (bx - ax) * (dz - cz) - (bz - az) * (dx - cx);
        if (Math.abs(den) < 1e-9) continue;
        const t = ((cx - ax) * (dz - cz) - (cz - az) * (dx - cx)) / den, u = ((cx - ax) * (bz - az) - (cz - az) * (bx - ax)) / den;
        if (t < 0 || t > 1 || u < 0 || u > 1) continue;
        return [k.len[a] * (i + t) / P, k.len[b] * (j + u) / P, ax + (bx - ax) * t, az + (bz - az) * t];
      }
    }
    if (k.to[a] === k.to[b]) return [k.len[a], k.len[b], k.x1[a], k.z1[a]];
    return null;
  }

  writePoses(data: Float32Array, stride: number): number {
    const c = this.veh.cols, p = this.tmp;
    let n = 0;
    for (let i = 0; i < this.microN; i++) {
      const v = this.micro[i];
      if (c.kind[v] === 4) { this.headOf(v, p); n = this.writeTrain(v, data, stride, n, p); continue; }
      const lights = this.centreOf(v, p);
      const o = n * stride;
      if (!c.has[v]) { c.px[v] = p[0]; c.py[v] = p[1]; c.pz[v] = p[2]; c.pyaw[v] = p[3]; c.has[v] = 1; }
      data[o] = c.px[v]; data[o + 1] = c.py[v]; data[o + 2] = c.pz[v]; data[o + 3] = c.pyaw[v];
      data[o + 4] = p[0]; data[o + 5] = p[1]; data[o + 6] = p[2]; data[o + 7] = p[3];
      // occupants (roadcraft occupants): car and truck with the driver; bus by load (0-7)
      const seats = c.kind[v] === 1 ? Math.min(7, Math.ceil(c.load[v] / BUS_CAP * 7)) : c.kind[v] === 3 ? 0 : 1;
      data[o + 8] = c.kind[v] * 256 + c.color[v] + (this.lightBits(v, lights) + seats * 8) * 65536;
      data[o + 9] = Math.max(0, Math.min(1, c.fade[v]));
      data[o + 10] = v & 0xffff;
      c.px[v] = p[0]; c.py[v] = p[1]; c.pz[v] = p[2]; c.pyaw[v] = p[3];
      n++;
    }
    return n;
  }

  /**
   * The bodies of the vehicles within `r` m of (x, z), for the walkers to keep off (roadcraft walk.ts CarZone): x, z,
   * yaw, half length, half width each into `bodyBuf` (grown when full). Only the micro window. Returns how many.
   */
  writeBodies(x: number, z: number, r: number): number {
    const c = this.veh.cols, p = this.tmp;
    let n = 0;
    for (let i = 0; i < this.microN; i++) {
      const v = this.micro[i];
      if (c.kind[v] === 4) continue;
      this.centreOf(v, p);
      if (Math.abs(p[0] - x) > r || Math.abs(p[2] - z) > r) continue;
      if ((n + 1) * 5 > this.bodyBuf.length) { const b = new Float32Array(this.bodyBuf.length * 2); b.set(this.bodyBuf); this.bodyBuf = b; }
      const o = n * 5;
      this.bodyBuf[o] = p[0]; this.bodyBuf[o + 1] = p[2]; this.bodyBuf[o + 2] = p[3];
      this.bodyBuf[o + 3] = c.len[v] / 2; this.bodyBuf[o + 4] = BODY_HALF_W[c.kind[v]] ?? 0.9;
      n++;
    }
    return n;
  }
  bodyBuf = new Float32Array(5 * 1024);

  /**
   * Front of vehicle `v` on its lane or connection (x, y, z, yaw into `p`), mid lane change if one is under way.
   * Returns the lane-change indicator bits.
   */
  private headOf(v: number, p: Float64Array): number {
    const c = this.veh.cols, sim = this.sim, q = this.tmp2;
    let lights = 0;
    this.lcOff[0] = this.lcOff[1] = this.lcOff[2] = 0;
    // a lane change still under way (only between lanes of the same segment as the lane it is on or came from)
    const changing = c.lcT[v] < 1 && c.lcFrom[v] >= 0 && c.lane[v] >= 0 && laneSeg(c.lcFrom[v]) === laneSeg(c.lane[v]) && sim.net.segs.alive[laneSeg(c.lcFrom[v])];
    if (c.conn[v] >= 0) {
      sim.connPoint(c.conn[v], c.s[v], p);
      // into the junction mid-change: the sideways offset left at the end of the lane fades out on the way
      if (changing) {
        const lane = c.lane[v], L = sim.laneLen(lane), t = c.lcT[v], k = 1 - t * t * (3 - 2 * t);
        sim.lanePoint(c.lcFrom[v], L, q); const qx = q[0], qz = q[2];
        sim.lanePoint(lane, L, q);
        p[0] += (qx - q[0]) * k; p[2] += (qz - q[2]) * k;
        this.lcOff[0] = qx - q[0]; this.lcOff[1] = qz - q[2]; this.lcOff[2] = k;
      }
    } else {
      const lane = c.lane[v];
      const L = sim.laneLen(lane);
      sim.lanePoint(lane, Math.min(L, c.s[v]), p);
      // smooth lane change: blend with the origin lane
      if (changing) {
        sim.lanePoint(c.lcFrom[v], Math.min(L, c.s[v]), q);
        // lane-change indicator: toward the new lane's side (driver's right = (−cos, sin) of the heading)
        if (c.lcT[v] < 0.8) lights |= -Math.cos(p[3]) * (p[0] - q[0]) + Math.sin(p[3]) * (p[2] - q[2]) > 0 ? LIGHT_RIGHT : LIGHT_LEFT;
        const t = c.lcT[v], k = 1 - t * t * (3 - 2 * t);
        this.lcOff[0] = q[0] - p[0]; this.lcOff[1] = q[2] - p[2]; this.lcOff[2] = k;
        p[0] += (q[0] - p[0]) * k; p[2] += (q[2] - p[2]) * k;
      }
    }
    return lights;
  }
  /** The sideways offset `headOf` gave the front for a lane change under way (x, z, its share k; k = 0: none). */
  private lcOff = new Float64Array(3);
  /** The ends of the chord a body's heading is read along (`centreOf`). */
  private chAhead = new Float64Array(4);
  private chBehind = new Float64Array(4);

  /**
   * Middle of vehicle `v` as drawn (x, y, z, yaw into `p`): on its lane or connection, in the bay, at the kerb or on a
   * manoeuvre's path. Returns the indicator bits. Not for trains (their wagons: `writeTrain`).
   */
  private centreOf(v: number, p: Float64Array): number {
    const c = this.veh.cols, sim = this.sim;
    let lights = this.headOf(v, p);
    if (c.mv[v] >= 0) {
      // on a manoeuvre: the pose is the vehicle centre on the Reeds-Shepp path; signal towards where it goes
      const mp = this.mvA;
      this.mvs.pose(c.mv[v], mp);
      p[0] = mp[0]; p[2] = mp[1]; p[3] = mp[2];
      return lights | (this.mvs.t.cols.kind[c.mv[v]] === MKind.Unpark ? LIGHT_LEFT : LIGHT_RIGHT);
    }
    // the body's middle on its path, pointing along a short chord centred on it (roadcraft sim/pose.ts:144-160
    // axleFrame, world/heading.ts HEADING_CHORD): round a bend its ends swing out over the outside of the curve, as a
    // body along its path does. Both ends on the path instead (an earlier misreading of pose.ts here) sagged its middle
    // to the inside by L²k/8: a 12 m bus 4 m over the kerb return of a tight right turn, 64% of its turning steps. From
    // the front's tangent, the body pivoted about its nose and the rear swept across the junction.
    const len = c.len[v], half = len / 2, ch = Math.min(HEADING_CHORD, half), off = this.lcOff;
    const mid = this.tmp2, ahead = this.chAhead, behind = this.chBehind, came = c.cameBy[v];
    const oMid = backAlong(sim, c.lane[v], c.conn[v], c.s[v], half, mid, came);
    const oAhead = backAlong(sim, c.lane[v], c.conn[v], c.s[v], half - ch, ahead, came);
    const oBehind = backAlong(sim, c.lane[v], c.conn[v], c.s[v], half + ch, behind, came);
    // a lane change under way: the front has its sideways offset (`headOf`), the rear takes it a moment later (the body
    // points into it), the points between in proportion; one still on the way into the lane it changes from is on that
    // lane's path: brought over to this lane's first (less the whole offset), so that it does not jump as it comes out
    if (off[2] > 0) {
      const t = Math.max(0, c.lcT[v] - LC_REAR_LAG), kr = 1 - t * t * (3 - 2 * t), kf = off[2];
      const shift = (q: Float64Array, d: number, other: boolean): void => {
        const w = kf + (kr - kf) * (d / len) - (other ? 1 : 0);
        q[0] += off[0] * w; q[2] += off[1] * w;
      };
      shift(mid, half, oMid); shift(ahead, half - ch, oAhead); shift(behind, half + ch, oBehind);
    }
    const dx = ahead[0] - behind[0], dz = ahead[2] - behind[2];
    if (dx * dx + dz * dz > 1e-6) p[3] = Math.atan2(dx, dz);
    p[0] = mid[0]; p[1] = mid[1]; p[2] = mid[2];
    if (c.phase[v] === VehPhase.KerbStop && c.conn[v] < 0) {
      // at the kerb: 0.9 m to the right, hazard lights while stopped
      const k = c.pk[v] * c.pk[v] * (3 - 2 * c.pk[v]);
      p[0] -= Math.cos(p[3]) * 0.9 * k; p[2] += Math.sin(p[3]) * 0.9 * k;
      if (c.v[v] < 0.1 && ((this.time * 1.5) % 1) < 0.5) lights |= LIGHT_LEFT | LIGHT_RIGHT;
    }
    // in the bay or on the way to it (offset in u, along the segment direction): pulling in, right indicator; pulling out, left
    else if (c.pk[v] > 0 && c.conn[v] < 0) {
      const lane = c.lane[v], dir = laneDir(lane);
      const du = (parkU(sim.net.segs.cols.profile[laneSeg(lane)], dir) - sim.laneU(lane)) * dir;
      const k = c.pk[v] * c.pk[v] * (3 - 2 * c.pk[v]);
      if (!Number.isNaN(du)) { p[0] += Math.cos(p[3]) * du * k; p[2] -= Math.sin(p[3]) * du * k; }
      if (c.phase[v] === VehPhase.Parked ? c.pk[v] < 1 : c.dwell[v] > 0.4) lights |= c.phase[v] === VehPhase.Parked ? LIGHT_RIGHT : LIGHT_LEFT;
    }
    return lights;
  }
}

/**
 * Point `d` metres behind the vehicle's front (its rear, a wagon): back along the connection and lanes it came by,
 * through the connections into each lane (a train's rear wagons follow the track round a bend); only past what is
 * known, along a straight line. `cameBy`: the connection it came out of onto `lane` (one of several into it: taken as
 * the first that leads there, a car's rear swung onto the straight-on connection just out of a turn, the body turning
 * up to 180 degrees in one step). Returns whether the point is on the path into another lane of `lane`'s road (a lane
 * change begun as it came out, with no way into `lane` from that road).
 */
export function backAlong(sim: SimNet, lane: number, conn: number, s: number, d: number, out: Float64Array, cameBy = -1): boolean {
  const k = sim.conns.cols;
  s -= d;
  let other = false;
  for (let guard = 0; guard < 6; guard++) {
    if (conn >= 0) {
      if (s >= 0) { sim.connPoint(conn, s, out); return other; }
      lane = k.from[conn]; s += sim.laneLen(lane); conn = -1;
      continue;
    }
    if (s >= 0) { sim.lanePoint(lane, s, out); return other; }
    // the connection it came by; a lane change begun as it came out (the body's sideways offset of the change is added
    // after, from this lane's path): the one into this lane from the same lane, or from the same road (a neighbour of
    // that lane: the same movement, beside it); or one that leads into this lane (on rails there is one per lane, except
    // at a switch)
    let into = -1;
    if (cameBy >= 0 && sim.conns.alive[cameBy]) {
      const from = k.from[cameBy];
      if (k.to[cameBy] === lane) into = cameBy;
      else for (let x = sim.nodeConn[sim.laneFrom(lane)]; x >= 0; x = k.nextAtNode[x]) {
        if (k.to[x] !== lane || laneSeg(k.from[x]) !== laneSeg(from) || laneDir(k.from[x]) !== laneDir(from)) continue;
        into = x;
        if (k.from[x] === from) break;
      }
      // none from that road into this lane: the one it came by, into the lane it changes from (the rear is on that lane's
      // path already: the caller adds no offset of the change to it)
      if (into < 0 && laneSeg(k.to[cameBy]) === laneSeg(lane) && laneDir(k.to[cameBy]) === laneDir(lane)) { into = cameBy; other = true; }
    }
    cameBy = -1;
    if (into < 0) for (let x = sim.nodeConn[sim.laneFrom(lane)]; x >= 0; x = k.nextAtNode[x]) if (k.to[x] === lane) { into = x; break; }
    if (into < 0) break;
    conn = into; s += k.len[into];
  }
  sim.lanePoint(lane, 0, out);
  out[0] += Math.sin(out[3]) * s; out[2] += Math.cos(out[3]) * s;
  return other;
}


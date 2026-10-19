// Traffic: meso over the whole map (queue per lane, events per vehicle), micro
// in a window around the camera (IDM for car-following, MOBIL for lane changes,
// signals per arm that adapt to the queue, right of way at roundabouts).
// Everything in SoA tables; no loop goes over the whole fleet per step.

import { Table } from '../core/table.ts';
import { MAP_HALF, MAP_SIZE } from '../config.ts';
import { Rng } from '../core/rng.ts';
import { MAX_DEG } from '../roads/network.ts';
import { SegFlag } from '../roads/flags.ts';
import { Ctl, Rule } from '../roads/control.ts';
import { baseZone } from '../roads/zones.ts';
import { PROFILE_INFO } from '../roads/profiles.ts';
import { SimNet, Turn, laneCount, laneDir, laneId, laneIdx, laneSeg, laneSpeed } from './lanes.ts';
import { Router } from './routing.ts';
import { FlowAdvisor } from './advisor.ts';
import { bez, bezD } from '../roads/geometry.ts';
import { MANOEUVRE_RADIUS, MKind, Manoeuvres } from './manoeuvres.ts';
import { Signals } from './signals.ts';

export const ROUTE_CAP = 96;
export const MAX_VEHICLES = 1 << 16;
const WINDOW = 1500;
// meso (far from the camera) at the pace of micro: the fleet is a single one, so if meso runs faster the cars
// pile up in the window until it jams, and if it runs slower the window empties (that was the case: meso at
// 6 km/h, micro at 20). Meso takes this factor times the `mesoEnter` estimate (free driving scaled by
// occupancy + junction wait). Checked in scripts/transito.ts against the whole map in micro (JANELA=1e6): cars
// within 1.5 km of the centre move along with those of the all-micro run (2.0 fills the window, 4.0 empties it)
const MESO_ALPHA = 2.5;
const WINDOW_OUT = 1750;
/** Stopped for this long (s), the driver reconsiders the route (roadcraft STUCK_SECONDS). */
export const STUCK_SECONDS = 10;
/** Jammed junction: someone waiting at the line and nobody has gone through for this long (s). */
export const JAM_SECONDS = 20;
/** Waiting for the same full exit for this long (s), the driver claims its turn on it. */
const STARVE_SECONDS = 30;
/** Controlled release of a jammed junction: one vehicle every this many seconds. */
const RELEASE_EVERY = 3;
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
export const REGION = 400, REGION_OCC = 0.1, REGION_SLOPE = 7, REGION_EVERY = 4;
const REGION_N = Math.ceil(MAP_SIZE / REGION);
/**
 * Fleet governor (roadcraft `populationGovernor`, here driven by traffic rather than step cost): the share of the
 * whole city's fleet on jammed streets (a direction of a segment 80% full or more, near the camera or not) above
 * GOV_FREE cuts the fleet target in proportion, down to GOV_MIN at GOV_JAM (approached gradually, without the jumps of
 * an on/off rule at a threshold). It never reads the camera: looking at a jam
 * must not change the city's traffic. Measured: the generated city's network cannot carry the peak fleet; with the
 * governor the peak has fewer cars and keeps moving.
 */
const GOV_JAM = 0.5, GOV_FREE = 0.15, GOV_MIN = 0.75, JAMMED = 0.8;
/** A reconsidering driver's detour rejoins the route up to this many nodes ahead. */
const REJOIN = 6;

/**
 * IDM. Cars accelerate at 2.8 m/s² (with 2.2 the centre was ~2 km/h slower, measured); buses, trucks and
 * trains, being heavy, at 2.2 (and stop at the right spot). 0.9 s headway.
 */
const A_MAX = 2.8, A_HEAVY = 2.2, B_COMF = 2.2, S0 = 2.2, T_HEAD = 0.9;

const vehSchema = {
  lane: Int32Array, conn: Int32Array, s: Float32Array, v: Float32Array,
  len: Float32Array, vf: Float32Array, micro: Uint8Array, kind: Uint8Array, color: Uint8Array,
  dest: Int32Array, rIdx: Uint8Array, rLen: Uint8Array,
  tExit: Float64Array,
  next: Int32Array, prev: Int32Array, // lane/connection list (micro), front to back
  px: Float32Array, py: Float32Array, pz: Float32Array, pyaw: Float32Array, has: Uint8Array,
  fade: Float32Array, dying: Uint8Array,
  lcFrom: Int32Array, lcT: Float32Array, lcCool: Float32Array,
  microIdx: Int32Array,
  // bus: line (-1 = ordinary car), next stop, dwell time, load, stop already served
  line: Int16Array, stopI: Uint8Array, dwell: Float32Array, load: Uint8Array, served: Uint8Array,
  // time stopped at the stop line (stop sign, queue of those yielding)
  wait: Float32Array,
  // stopped (anywhere on the lane) since the last time it reconsidered the route
  held: Float32Array,
  // lights (roadcraft vehicleSignals): braking/stopped, and the planned exit connection (for the indicator)
  brk: Uint8Array, exitC: Int32Array,
  // in the bay beside the lane (0 = in the lane, 1 = in the bay): pulling in on arrival or out at the start
  pk: Float32Array,
  // manoeuvre (sim/manoeuvres.ts, −1 = none) and the lane position (front) where it ends
  mv: Int32Array, ms: Float32Array,
  // how the trip ends once it leaves (End)
  why: Uint8Array,
  // far model: the lane whose list it is in (−1 = none) and its neighbours in that list (in order of entry)
  ml: Int32Array, mnext: Int32Array, mprev: Int32Array,
  // when it entered its current lane and where (for the speed actually driven on each lane, near and far)
  tIn: Float64Array, s0: Float32Array,
  // the micro step it last moved in (one move per step, even after passing from a connection to a lane)
  moved: Uint32Array,
  // the dock or bay it has reserved (Traffic.spots key; 0 = none)
  spot: Float64Array,
};

/** How a vehicle's trip ends: arrived, lost (no route, its road removed, an explosion), or no trip at all (a bus). */
const End = { Arrived: 0, Lost: 1, NoTrip: 2 } as const;

/** Bus line as the simulation sees it: stops resolved to lanes. */
interface SimLine {
  id: number; color: number; buses: number;
  /** 0 bus, 1 train, 2 metro (rails). */
  mode: number;
  stopLane: number[]; stopV: number[]; waiting: number[]; lastT: number[];
  /** Who is waiting at each stop, by destination stop (real people and background demand). */
  waitTo: Float64Array[];
  /** Stop position on the sidewalk (to draw those waiting). */
  stopX: number[]; stopZ: number[]; stopY: number[]; stopYaw: number[];
  /** Boardings since the last report, and the hourly average. */
  boardings: number; perHour: number;
  /** Terminal stops (resolved index): long dwell. */
  term: Set<number>;
}

/** Line received from the page: stops as (x, z) points on the sidewalk. */
export interface LineSpec {
  id: number; color: number; buses: number; stops: number[]; mode?: number; /** indices of the stops that are terminals */ term?: number[];
  /** Bus line that runs as a ring (last stop → first). Otherwise (Roadcraft) it runs out and back: the return trip
   *  stops on the other side of the street, and both ends are terminals. Trains always follow their stations in order. */
  loop?: boolean;
}

/** Where trucks start and end (none, residential, commercial, industrial, mixed): goods between industry and commerce. */
const TRUCK_ZONES = [0.05, 0.1, 0.6, 1, 0.4];

/** Cell of the stop index (m) and cells per side of the map. */
const STOP_CELL = 600, STOP_CELLS = Math.ceil(MAP_SIZE / STOP_CELL);

const DWELL = 14;
/** Dwell at the terminal (s): the bus rests and adjusts its schedule before heading back. */
const TERMINAL_DWELL = 75;
const BUS_CAP = 70;
const WAIT_RATE = 1 / 9; // people arriving per second at each stop

/** Length per kind: car, bus, truck, (person), train (3 wagons of 20 m). */
const KIND_LEN = [4.4, 12, 9.5, 0.6, 62];
/** Parking (roadcraft kerbStops/parking): deceleration, time to pull into the bay (s), and how long it stays before disappearing. */
const PARK_DECEL = 2.6, PARK_SIDE_S = 2.4, PARK_STAY = 3;

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
/**
 * Passenger cars (roadcraft archetypes): sedan, hatchback, SUV, van, pickup and motorbike, with each one's length
 * and share of the fleet. The style goes in bits 4-6 of the colour (the page picks the model from it).
 */
export const CAR_STYLE_LEN = [4.4, 3.9, 4.6, 4.9, 5.3, 2.1];
const CAR_STYLE_SHARE = [0.3, 0.3, 0.17, 0.08, 0.07, 0.08];
/** Light bits in the pose (× 65536 in the kind/colour field): brake, left indicator, right indicator. */
export const LIGHT_BRAKE = 1, LIGHT_LEFT = 2, LIGHT_RIGHT = 4;
/** Train wagons and the length of each. */
export const WAGONS = 3, WAGON_LEN = 20.5;

export class Traffic {
  readonly sim: SimNet;
  readonly router: Router;
  readonly veh = new Table(vehSchema, 1 << 12);
  routes = new Int32Array((1 << 12) * ROUTE_CAP);
  /** Ordered list of micro vehicles per lane and per connection (head = the frontmost). */
  laneHead = new Int32Array((1 << 14) * 16).fill(-1);
  laneTail = new Int32Array((1 << 14) * 16).fill(-1);
  /** Far-model vehicles per lane, in order of entry: an edit to a road finds the vehicles on it without a fleet pass. */
  mesoHead = new Int32Array((1 << 14) * 16).fill(-1);
  mesoTail = new Int32Array((1 << 14) * 16).fill(-1);
  connHead = new Int32Array(1 << 14).fill(-1);
  /** Whoever waits too long at a yield claims the turn (tenths of a second of the simulation clock). */
  private connClaim = new Int32Array(1 << 14).fill(-100);
  connTail = new Int32Array(1 << 14).fill(-1);
  /** All vehicles (micro and meso) per lane, and the last meso exit (FIFO queue). */
  laneCount = new Uint16Array((1 << 14) * 16);
  laneLastExit = new Float64Array((1 << 14) * 16);
  /**
   * Turn on a full exit lane: whoever has waited STARVE_SECONDS for it holds the next free spot (renewed every
   * step); without it an arm saw the exit always filled by those coming from the others and waited for minutes.
   */
  private exitClaim = new Int32Array((1 << 14) * 16).fill(-1);
  private exitClaimT = new Float64Array((1 << 14) * 16);
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
  /** Meso events: heap (time, vehicle). */
  private evT = new Float64Array(1 << 12);
  private evV = new Int32Array(1 << 12);
  private evN = 0;
  /** Traffic lights (plans, timed cycle, actuated near the camera). */
  readonly sig: Signals;
  private signalNodes = new Set<number>();
  /** Signals near the camera (only these run; distant ones stay frozen). */
  private windowSignals = new Set<number>();

  /** Average speed of the cars near the camera (m/s). */
  /**
   * Average speed of the whole city (m/s): length driven over time taken by every vehicle that finished a lane since
   * the last call, near the camera or not (smoothed). Also counts the city's stopped vehicles (`stopped`).
   */
  avgSpeed(): number {
    if (this.timeSum > 0) { const sp = this.distSum / this.timeSum; this.cityV = this.cityV > 0 ? this.cityV * 0.7 + sp * 0.3 : sp; }
    this.distSum = 0; this.timeSum = 0;
    // stopped: everyone on a jammed street (whole city, from the last region pass), and near the camera those stopped
    // on a street that is not jammed
    const c = this.veh.cols, sc = this.sim.net.segs.cols;
    let stopped = this.jammedNow;
    for (let i = 0; i < this.microN; i++) {
      const v = this.micro[i];
      if (c.v[v] >= 0.5 || c.conn[v] >= 0 || c.lane[v] < 0 || c.dying[v] === 2) continue;
      const sg = laneSeg(c.lane[v]), fwd = laneDir(c.lane[v]) > 0, lanes = laneCount(sc.profile[sg], fwd ? 1 : -1);
      if (this.segLoad[sg * 2 + (fwd ? 0 : 1)] < JAMMED * lanes * sc.len[sg] / 7.5) stopped++;
    }
    this.stopped = stopped;
    return this.cityV;
  }

  /** The city's stopped vehicles (counted along with the average speed). */
  stopped = 0;
  /** Lane length driven and time taken since the last `avgSpeed`, and the smoothed city speed. */
  private distSum = 0; private timeSum = 0; private cityV = 0;
  /** Vehicles on jammed streets at the last region pass. */
  private jammedNow = 0;
  /** Speed actually driven on each lane by the last vehicles that finished it (m/s, smoothed), and when. */
  laneVel = new Float32Array((1 << 14) * 16);
  private laneVelT = new Float64Array((1 << 14) * 16);

  /** The vehicle starts lane c.lane[v] at position `s`. */
  private enterLane(v: number, s: number): void { const c = this.veh.cols; c.tIn[v] = this.time; c.s0[v] = Math.max(0, s); }

  /** The vehicle finishes `lane`: its speed on it goes into the lane's and the city's figures. */
  private leaveLane(v: number, lane: number): void {
    const c = this.veh.cols, dist = this.sim.laneLen(lane) - c.s0[v], t = this.time - c.tIn[v];
    if (!(t > 0.2) || dist < 1) return;
    const sp = dist / t;
    this.laneVel[lane] = this.laneVel[lane] > 0 ? this.laneVel[lane] * 0.6 + sp * 0.4 : sp;
    this.laneVelT[lane] = this.time;
    this.distSum += dist; this.timeSum += t;
  }

  /** A segment right now: vehicles (micro and meso), average speed of the visible ones, queue (stopped) and capacity. */
  probe(seg: number): { vehicles: number; speed: number; queue: number; capacity: number } {
    const sim = this.sim, c = this.veh.cols;
    if (!sim.net.segs.alive[seg]) return { vehicles: 0, speed: 0, queue: 0, capacity: 0 };
    const p = sim.net.segs.cols.profile[seg];
    let vehicles = 0, seen = 0, sum = 0, queue = 0, capacity = 0, far = 0, farSum = 0;
    for (const dir of [1, -1]) for (let i = 0; i < laneCount(p, dir); i++) {
      const l = laneId(seg, dir, i), cap = Math.floor(sim.laneLen(l) / 7.5);
      vehicles += this.laneCount[l];
      capacity += cap;
      // near the camera: the vehicles themselves
      for (let v = this.laneHead[l]; v >= 0; v = c.next[v]) { seen++; sum += c.v[v]; if (c.v[v] < 0.5) queue++; }
      // far: a jammed lane is a queue; otherwise those held at the line (waiting for room or for the green)
      if (this.mesoHead[l] < 0) continue;
      let held = 0, n = 0;
      for (let v = this.mesoHead[l]; v >= 0; v = c.mnext[v]) { n++; if (c.wait[v] > 0 || c.tExit[v] - this.time > 30) held++; }
      queue += this.laneCount[l] >= JAMMED * cap ? n : held;
      // the speed driven on the lane lately; nobody out of a full lane for a minute: standing still
      const stale = this.time - this.laneVelT[l] > 60;
      far += n; farSum += n * (stale ? (this.laneCount[l] >= JAMMED * cap ? 0 : laneSpeed(p) * 0.85) : this.laneVel[l]);
    }
    const speed = seen + far ? (sum + farSum) / (seen + far) : laneSpeed(p) * 0.85;
    return { vehicles, speed, queue, capacity };
  }

  /** Network cleared (new map, load): all vehicles leave, queues and signals reset. */
  clearAll(): void {
    this.veh.clear();
    this.laneHead.fill(-1); this.laneTail.fill(-1); this.connHead.fill(-1); this.connTail.fill(-1); this.connClaim.fill(-100);
    this.mesoHead.fill(-1); this.mesoTail.fill(-1);
    this.laneCount.fill(0); this.laneLastExit.fill(0); this.segLoad.fill(0);
    this.lastAdmit.fill(this.time); this.releaseAt.fill(0); this.jamAt.fill(0); this.exitClaim.fill(-1);
    this.microN = 0; this.evN = 0;
    this.activeLanes.clear(); this.activeConns.clear();
    this.signalNodes.clear();
    if (this.signals) for (const n of this.windowSignals) if (n < this.signals.length) this.signals[n] = 0;
    for (const n of this.windowSignals) this.sig.setActive(n, false);
    this.windowSignals.clear();
    for (const set of this.busSets) set.clear();
    this.riders.clear();
    this.wagonPrev.clear();
    if (this.occupancy) this.occupancy.fill(0);
    this.segWear.fill(0);
    this.parkers.clear();
    this.mvs.clear();
    this.spots.clear();
    // nothing of the old city: its jams, crossings, docks and bus lines (the page sends the new map's lines and docks)
    this.gov = 1; this.jamShare = 0; this.jammedNow = 0; this.regionOcc.fill(0); this.regionT = -Infinity;
    this.cityV = 0; this.distSum = 0; this.timeSum = 0; this.laneVel.fill(0);
    this.crossingClosed.clear();
    this.docks = new Float32Array(0);
    this.lines = []; this.busSets = []; this.indexStops();
    this.spawnCredit = 0; this.fleetFloor = 0;
  }

  /** New segment (the id may belong to a demolished one): fresh asphalt. */
  clearWear(seg: number): void {
    if (seg < this.segWear.length) this.segWear[seg] = 0;
    if (this.occupancy && seg * 4 + 2 < this.occupancy.length) this.occupancy[seg * 4 + 2] = 0;
  }

  /** Bus lines (index = position; the vehicle stores the index). */
  lines: SimLine[] = [];
  /** Buses of each line (so the fleet is not scanned). */
  private busSets: Array<Set<number>> = [];
  /** Passengers of each bus by destination stop. */
  private riders = new Map<number, Float64Array>();
  /** People get off the bus at node `node` (the pedestrians carry on on foot). */
  onAlight: (node: number, count: number, x: number, z: number) => void = () => {};
  private lineCheck = 0;

  /** Is someone walking on the node's crosswalk? (from the pedestrians) */
  pedCrossing: (n: number) => boolean = () => false;

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
  /** Meso: attempts to move on at the end of the lane and how many found the next one full (congestion far from the camera). */
  mesoTries = 0; mesoFull = 0;
  private routeBudget = 0;

  /** Explosion: micro-window vehicles within `r` metres leave the scene (returns how many). */
  blast(x: number, z: number, r: number): number {
    const c = this.veh.cols;
    let n = 0;
    for (let i = this.microN - 1; i >= 0; i--) {
      const v = this.micro[i];
      if (!c.has[v] || Math.hypot(c.px[v] - x, c.pz[v] - z) > r) continue;
      // parking: already out of the lane, just fade it (`stepParkers` finishes it)
      if (c.dying[v] !== 2) c.dying[v] = 1;
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
  private rng = new Rng(12345);
  private tmp = new Float64Array(4);
  private tmp2 = new Float64Array(4);
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
    sim.net.segs.onGrow((cap) => {
      this.laneHead = grow(this.laneHead, cap * 16, -1);
      this.laneTail = grow(this.laneTail, cap * 16, -1);
      this.mesoHead = grow(this.mesoHead, cap * 16, -1);
      this.mesoTail = grow(this.mesoTail, cap * 16, -1);
      this.laneVel = grow(this.laneVel, cap * 16, 0);
      this.laneVelT = grow(this.laneVelT, cap * 16, 0);
      this.laneCount = grow(this.laneCount, cap * 16, 0);
      this.laneLastExit = grow(this.laneLastExit, cap * 16, 0);
      this.exitClaim = grow(this.exitClaim, cap * 16, -1);
      this.exitClaimT = grow(this.exitClaimT, cap * 16, 0);
      this.segLoad = grow(this.segLoad, cap * 2, 0);
      this.segWear = grow(this.segWear, cap, 0);
      this.router.segLoad = this.segLoad;
    });
    sim.conns.onGrow((cap) => {
      this.connHead = grow(this.connHead, cap, -1);
      this.connTail = grow(this.connTail, cap, -1);
      this.connClaim = grow(this.connClaim, cap, -100);
    });
    sim.net.nodes.onGrow((cap) => {
      this.nodePass = grow(this.nodePass, cap, 0);
      this.lastAdmit = grow(this.lastAdmit, cap, 0);
      this.releaseAt = grow(this.releaseAt, cap, 0);
      this.jamAt = grow(this.jamAt, cap, 0);
    });
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
      if (c.dying[v] !== 4 || c.lane[v] < 0) continue;
      this.sim.lanePoint(c.lane[v], c.s[v], p);
      list.push(p[0], p[2], 4, Math.min(1, c.dwell[v] / 6));
    }
    // level crossings with the barrier down, and the trains in the window (x, z) for inspection
    const crossings = [...this.crossingClosed.keys()].filter((n) => this.crossingDown(n)), trains: number[] = [];
    this.lines.forEach((ln, li) => { if (ln.mode) for (const v of this.busSets[li]) if (this.veh.alive[v] && c.micro[v] && c.lane[v] >= 0) { this.sim.lanePoint(c.lane[v], c.s[v], p); trains.push(p[0], p[2]); } });
    return { list, planned: this.mvs.planned, kerbStops: this.kerbStops, docked: this.docked, crossings, trains };
  }

  /** Docks near the camera sent by the page: a truck arriving next to one backs into it (they never pick trips). */
  setDocks(pts: Float32Array): void { this.docks = pts; }

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
      if (c.kind[v] === 0 && this.tryKerbStop(v, lane)) return 1;
      if (c.kind[v] === 0 && this.tryParkManoeuvre(v, lane)) return 1;
    }
    if (toEnd >= 12) return 0;
    // the same share of drop-offs away from the kerb animation: the trip ends and the car drives on to another
    if (this.dropsOff(v) && this.dropOffTrip(v, this.sim.laneTo(lane))) return 0;
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
    c.mv[v] = m; c.ms[v] = bayFront; c.dying[v] = 3; c.dwell[v] = 0; c.pk[v] = 0;
    return true;
  }

  /** Truck: the nearest dock within 70 m, backed into with the rear at the dock, facing the street. */
  private tryDock(v: number, lane: number): boolean {
    const c = this.veh.cols, d = this.docks, len = c.len[v];
    if (!d.length) return false;
    const a = this.mvA;
    this.centrePose(lane, c.s[v], len, 0, a);
    // the nearest free dock within 70 m
    let best = -1, bd = 70;
    const keyOf = (k: number) => (Math.round(d[k]) + 20000) * 40000 + Math.round(d[k + 1]) + 20000 + 1;
    for (let k = 0; k + 2 < d.length; k += 3) {
      const dist = Math.hypot(d[k] - a[0], d[k + 1] - a[2]);
      if (dist >= bd) continue;
      const holder = this.spots.get(keyOf(k));
      if (holder !== undefined && holder !== v && this.veh.alive[holder] && c.spot[holder] === keyOf(k)) continue;
      bd = dist; best = k;
    }
    if (best < 0 || !this.reserve(v, keyOf(best))) return false;
    const yaw = d[best + 2], bx = d[best] + Math.sin(yaw) * len / 2, bz = d[best + 1] + Math.cos(yaw) * len / 2;
    const m = this.mvs.start(v, MKind.Dock, a[0], a[2], a[3], bx, bz, yaw, a[1], 9, 45);
    if (m < 0) { this.releaseSpot(v); return false; }
    c.mv[v] = m; c.ms[v] = -1; c.dying[v] = 3; c.dwell[v] = 0;
    this.docked++;
    return true;
  }

  /** Some cars (4 in 10, by their id) stop at the kerb with the hazard lights on, a passenger gets out, and they go on. */
  /** A car whose trip is dropping someone off (4 in 10, by vehicle and destination): the same rule near and far. */
  private dropsOff(v: number): boolean {
    const c = this.veh.cols;
    return c.kind[v] === 0 && c.line[v] < 0 && ((Math.imul(v * 31 + c.dest[v], 2654435761) >>> 0) % 10) < 4;
  }

  /** The drop-off trip ends (counted) and the car starts another from `node`; false if there is nowhere to go. */
  private dropOffTrip(v: number, node: number): boolean {
    const c = this.veh.cols;
    const b = this.zonedNode(this.zoneWeights(false));
    if (b < 0 || b === node) return false;
    this.arrived++; this.kerbStops++;
    c.dest[v] = b;
    this.replanFrom(v, node);
    return !c.dying[v];
  }

  private tryKerbStop(v: number, lane: number): boolean {
    const c = this.veh.cols;
    if (laneIdx(lane) !== 0 || !this.dropsOff(v)) return false;
    if (!PROFILE_INFO[this.sim.net.segs.cols.profile[laneSeg(lane)]].walk) return false;
    c.dying[v] = 4; c.dwell[v] = 0; c.served[v] = 0;
    return true;
  }

  /** At the kerb: brake, edge to the kerb, let the passenger out, then pick a new trip and pull out. */
  private kerbStep(v: number, lane: number, dt: number): void {
    const c = this.veh.cols, sim = this.sim;
    // brakes gently, harder if the car ahead is close (it stops behind it, never inside it)
    const lead = c.prev[v];
    const room = lead >= 0 ? c.s[lead] - c.len[lead] - c.s[v] - 1 : 1e9;
    const brake = Math.min(9, Math.max(3, (c.v[v] * c.v[v]) / (2 * Math.max(0.1, room))));
    const nv = Math.max(0, c.v[v] - brake * dt);
    let s = Math.min(sim.laneLen(lane) - 0.3, c.s[v] + (c.v[v] + nv) * 0.5 * dt);
    if (lead >= 0) s = Math.min(s, Math.max(c.s[v], c.s[lead] - c.len[lead] - 0.5));
    c.s[v] = s;
    c.v[v] = nv; c.brk[v] = 1;
    c.pk[v] = Math.min(1, c.pk[v] + dt / 2);
    if (nv > 0) return;
    c.dwell[v] += dt;
    if (c.dwell[v] > 1.5 && !c.served[v]) {
      c.served[v] = 1;
      const p = this.mvA;
      // the door side: the middle of the sidewalk on the right
      const info = PROFILE_INFO[sim.net.segs.cols.profile[laneSeg(lane)]], dir = laneDir(lane);
      const wu = dir > 0 ? info.walkRight : info.walkLeft;
      this.centrePose(lane, c.s[v], c.len[v], Number.isNaN(wu) ? -3 : (wu - sim.laneU(lane)) * dir, p);
      this.onDropOff(p[0], p[2]);
    }
    if (c.dwell[v] > 6) {
      // the passenger is out: that trip ended; the car pulls out on another (the bay-leaving slide takes it back)
      c.dying[v] = 0; c.served[v] = 0; c.dwell[v] = 1.3;
      if (!this.dropOffTrip(v, sim.laneTo(lane))) { this.arrived++; this.kerbStops++; c.why[v] = End.NoTrip; c.dying[v] = 1; }
    }
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
        if (c.dying[v] === 3) this.lose(v);
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
      if (c.dying[v] !== 3) continue;
      this.mvs.pose(m, p);
      this.centrePose(lane, c.s[v], c.len[v], 0, q);
      const lat = Math.abs((p[0] - q[0]) * Math.cos(q[3]) - (p[1] - q[2]) * Math.sin(q[3]));
      if (done || lat > (kind === MKind.Dock ? 3.2 : 1.8)) {
        this.unlink(v);
        this.setLaneCount(lane, -1);
        c.dying[v] = 2; c.dwell[v] = 0;
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
    c.dying[v] = 2; c.dwell[v] = 0; c.pk[v] = 0;
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

  // ------------------------------------------------------------ meso events

  private schedule(v: number, t: number): void {
    this.veh.cols.tExit[v] = t;
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
      let c = i * 2 + 1;
      if (c >= this.evN) break;
      if (c + 1 < this.evN && this.evT[c + 1] < this.evT[c]) c++;
      if (this.evT[c] >= lt) break;
      this.evT[i] = this.evT[c]; this.evV[i] = this.evV[c]; i = c;
    }
    this.evT[i] = lt; this.evV[i] = lv;
    return v;
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
    if (c.line[v] >= 0) { this.busPlan(v, node); return; }
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

  /** Occupancy of each region (cars / lane slots) and when it was measured. */
  regionOcc = new Float32Array(REGION_N * REGION_N);
  private regionLoad = new Float32Array(REGION_N * REGION_N);
  private regionCap = new Float32Array(REGION_N * REGION_N);
  private regionT = -Infinity;
  /** Turns off region avoidance (A/B measurement). */
  regionAvoid = true;

  regionOf(x: number, z: number): number {
    const i = Math.min(REGION_N - 1, Math.max(0, Math.floor((x + MAP_HALF) / REGION)));
    const j = Math.min(REGION_N - 1, Math.max(0, Math.floor((z + MAP_HALF) / REGION)));
    return j * REGION_N + i;
  }

  /** Measures region occupancy (every REGION_EVERY s: one pass over the segments, not per step). */
  private measureRegions(): void {
    if (this.time - this.regionT < REGION_EVERY) return;
    this.regionT = this.time;
    const net = this.sim.net, sc = net.segs.cols, L = this.regionLoad, C = this.regionCap;
    L.fill(0); C.fill(0);
    let fleet = 0, jammed = 0;
    for (let s = 0; s < net.segs.end; s++) {
      if (!net.segs.alive[s]) continue;
      const info = PROFILE_INFO[sc.profile[s]];
      if (info.rail) continue;
      const r = this.regionOf(sc.mx[s], sc.mz[s]);
      const fwd = this.segLoad[s * 2], back = this.segLoad[s * 2 + 1], slots = sc.len[s] / 7.5;
      L[r] += fwd + back;
      C[r] += slots * (info.lanesFwd + info.lanesBack);
      fleet += fwd + back;
      if (info.lanesFwd && fwd >= JAMMED * slots * info.lanesFwd) jammed += fwd;
      if (info.lanesBack && back >= JAMMED * slots * info.lanesBack) jammed += back;
    }
    for (let r = 0; r < L.length; r++) this.regionOcc[r] = C[r] > 0 ? L[r] / C[r] : 0;
    // governor: the share of the whole city's fleet on jammed streets
    this.jamShare = fleet > 0 ? jammed / fleet : 0;
    this.jammedNow = jammed;
    if (this.governed && fleet >= 200) {
      const over = Math.min(1, Math.max(0, (this.jamShare - GOV_FREE) / (GOV_JAM - GOV_FREE)));
      this.gov += (1 - over * (1 - GOV_MIN) - this.gov) * 0.1;
    }
  }

  /** Fraction of the fleet the network carries now (governor) and the share of the fleet on jammed streets. */
  gov = 1;
  jamShare = 0;
  /** Turns off the governor (A/B measurement). */
  governed = true;

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
    c.s[v] = this.rng.next() * this.sim.laneLen(lane);
    this.enterLane(v, c.s[v]);
    this.setLaneCount(lane, 1);
    if (this.leaveBay(v, lane)) return;
    this.mesoEnter(v, lane, true);
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
    c.vf[v] = (kind === 0 ? 0.9 : 0.8) + this.rng.next() * 0.2;
    c.color[v] = this.rng.int(0, 16);
    if (kind === 0) {
      let u = this.rng.next(), style = 0;
      while (style < CAR_STYLE_SHARE.length - 1 && u >= CAR_STYLE_SHARE[style]) u -= CAR_STYLE_SHARE[style++];
      c.color[v] |= style << 4;
      c.len[v] = CAR_STYLE_LEN[style];
    }
    c.lane[v] = -1; c.conn[v] = -1;
    c.brk[v] = 0; c.exitC[v] = -1; c.pk[v] = 0; c.mv[v] = -1; c.ms[v] = 0;
    c.micro[v] = 0; c.dying[v] = 0; c.fade[v] = 1; c.has[v] = 0;
    c.next[v] = c.prev[v] = -1; c.lcFrom[v] = -1; c.lcT[v] = 1; c.lcCool[v] = this.rng.next() * 2;
    c.v[v] = 0;
    c.line[v] = -1; c.stopI[v] = 0; c.dwell[v] = 0; c.load[v] = 0; c.served[v] = 0; c.wait[v] = 0;
    c.held[v] = 0; c.why[v] = End.Arrived; c.ml[v] = -1; c.mnext[v] = -1; c.mprev[v] = -1; c.spot[v] = 0;
  }

  /** The trip will not reach its destination: the vehicle fades out and is counted as lost. */
  private lose(v: number): void {
    const c = this.veh.cols;
    if (c.why[v] === End.Arrived) c.why[v] = End.Lost;
    if (c.dying[v] !== 2) c.dying[v] = 1;
  }

  /** The vehicle leaves the simulation and its trip is counted (arrived or lost; a bus is not a trip). */
  private finish(v: number): void {
    const c = this.veh.cols;
    if (c.line[v] < 0 && c.why[v] !== End.NoTrip) { if (c.why[v] === End.Lost) this.lost++; else this.arrived++; }
    this.despawn(v);
  }

  /** Puts a far-model vehicle at the end of its lane's list. */
  private mesoLink(v: number, lane: number): void {
    const c = this.veh.cols;
    if (c.ml[v] === lane) return;
    this.mesoUnlink(v);
    c.ml[v] = lane; c.mnext[v] = -1; c.mprev[v] = this.mesoTail[lane];
    if (this.mesoTail[lane] >= 0) c.mnext[this.mesoTail[lane]] = v; else this.mesoHead[lane] = v;
    this.mesoTail[lane] = v;
  }

  private mesoUnlink(v: number): void {
    const c = this.veh.cols, lane = c.ml[v];
    if (lane < 0) return;
    if (c.mprev[v] >= 0) c.mnext[c.mprev[v]] = c.mnext[v]; else this.mesoHead[lane] = c.mnext[v];
    if (c.mnext[v] >= 0) c.mprev[c.mnext[v]] = c.mprev[v]; else this.mesoTail[lane] = c.mprev[v];
    c.ml[v] = -1; c.mnext[v] = c.mprev[v] = -1;
  }

  private despawn(v: number): void {
    const c = this.veh.cols;
    this.mesoUnlink(v);
    if (c.spot[v] !== 0) this.releaseSpot(v);
    if (c.line[v] >= 0) { this.busSets[c.line[v]]?.delete(v); this.riders.delete(v); }
    this.wagonPrev.delete(v);
    if (c.mv[v] >= 0) { this.mvs.end(c.mv[v]); c.mv[v] = -1; }
    const parked = c.dying[v] === 2;
    if (c.micro[v]) { if (!parked) this.unlink(v); this.removeMicro(v); }
    if (c.lane[v] >= 0 && !parked) this.setLaneCount(c.lane[v], -1);
    if (parked) { this.parkers.delete(v); c.dying[v] = 1; }
    c.lane[v] = -1; c.conn[v] = -1;
    c.tExit[v] = -1;
    this.veh.release(v);
  }

  // ------------------------------------------------------------ meso

  private inWindow(lane: number): boolean {
    const sc = this.sim.net.segs.cols, s = laneSeg(lane);
    return Math.hypot(sc.mx[s] - this.camX, sc.mz[s] - this.camZ) < this.window;
  }

  /** Vehicle switches to meso mode on the lane (schedules its exit). */
  private mesoEnter(v: number, lane: number, spawned = false): void {
    const c = this.veh.cols;
    this.mesoLink(v, lane);
    const L = this.sim.laneLen(lane);
    const p = this.sim.net.segs.cols.profile[laneSeg(lane)];
    const lanes = Math.max(1, laneCount(p, laneDir(lane)));
    // the queue already drains at the capacity rate (one vehicle every 1.8 s per lane) and a full lane moves slowly:
    // congestion exists far from the camera too, and the flow reaching the micro window is what traffic at that
    // occupancy would deliver
    const rest = spawned ? L - c.s[v] : L;
    let extra = 0;
    // bus on the lane of its stop: stops, serves it and already knows the next one
    if (c.line[v] >= 0) {
      const ln = this.lines[c.line[v]];
      if (ln && ln.stopLane[c.stopI[v]] === lane) { extra = ln.mode ? 25 : ln.term.has(c.stopI[v]) ? TERMINAL_DWELL : DWELL; this.serve(v); }
    }
    // the junction at the end of the lane: the same wait the router estimates (signal, stop, turn) and the
    // arm's throughput, as in micro
    // (at a light the red itself is simulated when the vehicle reaches the line: only the turn's slowdown here, and the
    // queue leaves at the saturation headway of a green)
    const ns = this.nextSeg(v);
    const node = this.sim.laneTo(lane), lit = this.sim.nodePhases[node] > 0;
    const wait = ns >= 0 ? this.router.nodeCost(node, laneSeg(lane), ns, !lit) : 0;
    const headway = lit ? 2 : wait >= 6 ? 3.6 : wait >= 4 ? 2.6 : 1.8;
    // time: free driving, slowed by occupancy (BPR curve), plus the junction wait; all times MESO_ALPHA
    const occ = Math.min(1, this.laneCount[lane] * 7.5 / (L * lanes));
    const run = rest / (laneSpeed(p) * c.vf[v]) * (1 + 3 * occ * occ) + wait;
    const t = Math.max(this.time + run * MESO_ALPHA + extra, this.laneLastExit[lane] + headway / lanes);
    this.laneLastExit[lane] = t;
    this.schedule(v, t);
  }

  private processMeso(): void {
    while (this.evN > 0 && this.evT[0] <= this.time) {
      const t = this.evT[0];
      const v = this.popEvent();
      const c = this.veh.cols;
      if (!this.veh.alive[v] || c.micro[v] || c.tExit[v] !== t) continue;
      this.mesoAdvance(v);
    }
  }

  /** End of the lane in meso mode: picks the next one, waits if it is full. */
  private mesoAdvance(v: number): void {
    const c = this.veh.cols, sim = this.sim;
    let lane = c.lane[v];
    if (!sim.net.segs.alive[laneSeg(lane)]) { c.why[v] = End.Lost; this.finish(v); return; }
    if (c.dying[v]) { this.finish(v); return; }
    if (this.atDestination(v)) {
      // a drop-off: the trip ends there and the car goes on to another after a moment at the kerb
      if (this.dropsOff(v) && this.dropOffTrip(v, sim.laneTo(lane))) { this.schedule(v, this.time + 6); return; }
      if (c.line[v] < 0) { this.finish(v); return; }
      this.busPlan(v, sim.laneTo(lane)); // bus arrived without serving: redo the leg to the stop
      if (c.dying[v]) { this.finish(v); return; }
    }
    let ns = this.nextSeg(v);
    if (ns < 0) {
      // route ended before the destination (truncated route): plan again from here
      this.replanFrom(v, sim.laneTo(lane));
      if (c.dying[v]) { this.finish(v); return; }
      ns = this.nextSeg(v);
      if (ns < 0) { this.lose(v); this.finish(v); return; }
    }
    const bus = c.line[v] >= 0, node = sim.laneTo(lane);
    let conn = sim.connToward(lane, ns, bus);
    for (let tries = 0; conn < 0 && tries < 2; tries++) {
      // its lane does not make the route's turn (the turn was banned, the lanes rearranged): another lane of this
      // segment that makes it (the far model changes lanes at the end of the lane), else a new route from here
      const alt = sim.laneToward(laneSeg(lane), laneDir(lane), ns, laneIdx(lane), bus);
      if (alt >= 0 && alt !== lane) {
        this.setLaneCount(lane, -1); this.setLaneCount(alt, 1);
        c.lane[v] = lane = alt; this.mesoLink(v, alt);
      } else {
        this.replanFrom(v, node);
        if (c.dying[v]) { this.finish(v); return; }
        ns = this.nextSeg(v);
        if (ns < 0) break;
      }
      conn = sim.connToward(lane, ns, bus);
    }
    if (conn < 0) { this.lose(v); this.finish(v); return; }
    // a level crossing with the barrier down, or someone on the zebra: wait (the far model obeys them too)
    const ctl = sim.nodeCtl[node];
    if ((ctl === Ctl.Crossing && this.crossingDown(node) && !PROFILE_INFO[sim.net.segs.cols.profile[laneSeg(lane)]].rail) || (ctl === Ctl.Zebra && this.pedCrossing(node))) {
      this.schedule(v, this.time + 1); return;
    }
    // the light: red for this arm, wait for its next green (the far model obeys the lights too)
    if (sim.nodePhases[node] > 0) {
      const arm = sim.segArm[laneSeg(lane) * 2 + (laneDir(lane) > 0 ? 1 : 0)];
      if (!this.sig.go(node, arm)) { this.schedule(v, Math.max(this.time + 0.2, this.sig.nextGreen(node, arm, this.time))); return; }
    }
    const dir = sim.net.segs.cols.a[ns] === node ? 1 : -1;
    // meso: enters the least full lane among those valid for the next turn (all lanes carry cars,
    // as in micro; otherwise everyone reaches the window in a single lane)
    const to = this.pickLane(ns, dir, this.segAfter(v, 1), bus, sim.conns.cols.to[conn]);
    if (to < 0 || !sim.net.segs.alive[ns]) { this.lose(v); this.finish(v); return; }
    // queue: a full lane holds the vehicle. As in micro: stopped STUCK_SECONDS, the driver reconsiders the route (a
    // local detour toward an exit with room); a junction jammed for JAM_SECONDS lets one vehicle in every
    // RELEASE_EVERY s, but never more than physically fit (bumper to bumper)
    this.mesoTries++;
    const L = sim.laneLen(to);
    const room = Math.max(1, Math.floor(L / 7.5)), fit = Math.max(room, Math.floor(L / 6.6));
    if (this.laneCount[to] >= room) {
      c.wait[v] += 2; this.mesoFull++;
      if (c.wait[v] >= STUCK_SECONDS && !bus && this.routeBudget > 0 && c.held[v] < c.wait[v] - STUCK_SECONDS + 1) {
        c.held[v] = c.wait[v]; // (reconsiders once every STUCK_SECONDS)
        if (this.reconsider(v, lane, ns)) { this.schedule(v, this.time + 0.5); return; }
      }
      const jammed = c.wait[v] >= JAM_SECONDS && this.time - this.lastAdmit[node] >= JAM_SECONDS && this.time >= this.releaseAt[node];
      if (!jammed || this.laneCount[to] >= fit) { this.schedule(v, this.time + 2); return; }
      this.released++; this.releaseAt[node] = this.time + RELEASE_EVERY;
      if (this.jamAt[node] < this.lastAdmit[node]) { this.jamAt[node] = this.time; this.jams++; }
    }
    c.wait[v] = 0; c.held[v] = 0;
    const enterMicro = this.inWindow(to);
    const tail = this.laneTail[to];
    if (enterMicro && tail >= 0 && c.s[tail] < c.len[tail] + S0 + 4) { this.schedule(v, this.time + 0.6); return; }
    // counted only once it really goes through (flow inspector, automatic control, jammed-junction detection)
    this.admit(node, sim.segArm[laneSeg(lane) * 2 + (laneDir(lane) > 0 ? 1 : 0)]);
    this.leaveLane(v, lane);
    this.setLaneCount(lane, -1);
    this.setLaneCount(to, 1);
    c.lane[v] = to;
    this.enterLane(v, 0);
    c.rIdx[v]++;
    if (enterMicro) {
      // entered the window: becomes micro at the start of the lane
      this.mesoUnlink(v);
      c.s[v] = 0;
      c.held[v] = 0;
      c.v[v] = Math.min(laneSpeed(sim.net.segs.cols.profile[ns]) * c.vf[v], tail >= 0 ? Math.max(2, (c.s[tail] - c.len[tail]) / T_HEAD) : 99);
      c.conn[v] = -1;
      c.fade[v] = 0;
      this.addMicro(v);
      this.insert(v, false, to);
      return;
    }
    this.mesoEnter(v, to);
  }

  // ------------------------------------------------------------ junctions

  /** Is the signal stage open for the connection's arm? */
  private stageGreen(conn: number, amberToo = false): boolean {
    const k = this.sim.conns.cols;
    return this.sig.go(k.node[conn], k.arm[conn], amberToo);
  }

  /** Can the connection be used now? (signal, ring priority) — without looking at right of way between vehicles. */
  gateOpen(conn: number): boolean {
    const sim = this.sim, k = sim.conns.cols;
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
        if (this.connHead[c] >= 0) return false;
        const t = this.laneHead[f];
        if (t >= 0 && sim.laneLen(f) - this.veh.cols.s[t] < 18) return false;
      }
      return true;
    }
    return true;
  }

  /** Rank of the arm's rule: main road and signal go first; unsigned in the middle; yield or stop last. */
  private ruleRank(conn: number): number {
    const k = this.sim.conns.cols, r = this.sim.armRule[k.node[conn] * 8 + k.arm[conn]];
    return r === Rule.Main || r === Rule.Signal ? 3 : r === Rule.Free ? 2 : 1;
  }

  /** Does `d` go before `c`? Arm rule, then the movement (straight > right > left), then whoever comes from the right. */
  private outranks(d: number, c: number): boolean {
    const rd = this.ruleRank(d), rc = this.ruleRank(c);
    if (rd !== rc) return rd > rc;
    const k = this.sim.conns.cols;
    const mv = (x: number) => (k.turn[x] === Turn.Straight ? 2 : k.turn[x] === Turn.Right ? 1 : k.turn[x] === Turn.Left ? 0 : -1);
    if (mv(d) !== mv(c)) return mv(d) > mv(c);
    const n = k.node[c], sim = this.sim;
    const hx = -sim.armDx[n * 8 + k.arm[c]], hz = -sim.armDz[n * 8 + k.arm[c]];
    const ox = sim.armDx[n * 8 + k.arm[d]], oz = sim.armDz[n * 8 + k.arm[d]];
    return ox * hz - oz * hx < 0; // d's arm is to the right of someone arriving via c
  }

  /** Is someone on connection `d` or about to reach it (for whoever must wait for it)? */
  private connBusy(d: number, me: number, strict: boolean): boolean {
    if (this.connHead[d] >= 0) return true;
    const sim = this.sim, k = sim.conns.cols, c = this.veh.cols;
    const f = k.from[d];
    const h = this.laneHead[f];
    if (h < 0 || h === me) return false;
    const dist = sim.laneLen(f) - c.s[h];
    if (dist > 45) return false;
    // is it really taking d?
    const ns = this.nextSeg(h);
    if (ns < 0 || laneSeg(k.to[d]) !== ns || sim.connToward(f, ns, c.line[h] >= 0) !== d) return false;
    // the one with right of way is stopped because its exit is full: it will not go now, the other passes
    if (c.v[h] < 0.5 && !this.exitRoom(d, h)) return false;
    // impatience (roadcraft): whoever waits accepts a smaller gap, 0.06 s per second waited, up to 1.5 s (minimum 2.2 s)
    const imp = Math.min(1.5, c.wait[me] * 0.06);
    if (strict) return dist < 5 || dist / Math.max(1, c.v[h]) < Math.max(2.2, 3 - imp);
    // same rule, stopped at the line: first come, first served
    if (c.v[h] < 0.5 && dist < 5) return c.wait[h] > c.wait[me] + 0.3;
    if (sim.nodePhases[k.node[d]] > 0 && !this.stageGreen(d, true)) return false;
    return dist < 6 || dist / Math.max(1, c.v[h]) < Math.max(2.2, 3.5 - imp);
  }

  /** Is there room on the exit lane? (do not enter the junction only to get stuck in it) */
  private exitRoom(conn: number, v: number, extra = 0, deep = false): boolean {
    const sim = this.sim, k = sim.conns.cols, c = this.veh.cols;
    const to = k.to[conn];
    // the spot is reserved for whoever has waited longest for it (another arm cannot jump the queue)
    const cl = this.exitClaim[to];
    if (cl >= 0 && cl !== v && this.time - this.exitClaimT[to] < 1 && this.veh.alive[cl]) return false;
    const L = sim.laneLen(to);
    // back-to-back junctions (the lane between them is shorter than a car): it is part of both junctions; the room
    // that counts is on the next lane of the route, minus those on it and those heading to it. Requiring room on the
    // 1 m lane let only one car at a time through the double junction (the worst node of the generated downtown)
    if (L < 8 && !deep) {
      const kk = c.rIdx[v];
      const ns2 = kk + 2 < c.rLen[v] ? this.segBetween(this.routeAt(v, kk + 1), this.routeAt(v, kk + 2)) : -1;
      const c2 = ns2 >= 0 ? sim.connToward(to, ns2, c.line[v] >= 0) : -1;
      if (c2 >= 0) {
        let busy = 0;
        for (let u = this.laneHead[to]; u >= 0; u = c.next[u]) busy += c.len[u] + 2;
        for (let x = sim.nodeConn[k.node[conn]]; x >= 0; x = k.nextAtNode[x]) {
          if (k.to[x] !== to) continue;
          for (let u = this.connHead[x]; u >= 0; u = c.next[u]) busy += c.len[u] + 2;
        }
        return this.exitRoom(c2, v, busy, true);
      }
    }
    const tail = this.laneTail[to];
    // the last one on the lane, moving, frees room in the time it takes to cross (~2 s): those behind may enter
    let room = (tail >= 0 ? c.s[tail] - c.len[tail] + Math.min(c.v[tail], 6) * 1.5 : L) - extra;
    let inbound = 0;
    // those already in the junction heading to the same lane
    for (let x = sim.nodeConn[k.node[conn]]; x >= 0; x = k.nextAtNode[x]) {
      if (k.to[x] !== to) continue;
      for (let u = this.connHead[x]; u >= 0; u = c.next[u]) { room -= c.len[u] + 2; inbound++; }
    }
    if (extra > 0) inbound++;
    // empty lane (even a short one): may enter; otherwise it must fit
    if (this.laneCount[to] === 0 && inbound === 0) return true;
    // short segment between close junctions: nearly part of the junction; if the last one is moving, one more fits
    if (L < 25 && tail >= 0 && c.v[tail] > 2 && inbound === 0) return true;
    if (this.laneCount[to] >= Math.max(1, L / 7.5)) return false;
    return room > Math.min(c.len[v] + 2.5, L * 0.6);
  }

  /** Gate for a vehicle: signal (on amber those who cannot stop go), stop sign, right of way, clear exit. */
  private gateFor(conn: number, v: number, toEnd: number): boolean {
    // road splice (uncontrolled two-way node): there is no junction to block; IDM follows the last vehicle on the next
    // lane through the node (`aheadThrough`). Requiring room there stopped the queue at every splice (the city splits
    // roads every ≤112 m) and the stop-and-go spread to the centre: 31 → 196 full exits behind splices in 20 min of peak.
    const sim = this.sim, n = sim.conns.cols.node[conn];
    if (sim.net.nodes.cols.deg[n] === 2 && sim.nodeCtl[n] === Ctl.None) return true;
    if (!this.exitRoom(conn, v)) return false;
    return this.gateRules(conn, v, toEnd);
  }

  /** Level crossings whose barrier is down (a train within reach): node → simulation time until it lifts. */
  private crossingClosed = new Map<number, number>();
  /** Barrier reach: a train this far (m, along its route) or on the crossing closes it. */
  static readonly CROSSING_REACH = 160;

  /**
   * Level crossings (Roadcraft): each train in the micro window closes the barriers of the crossings ahead of it
   * on its route within CROSSING_REACH, and of the one it is on, for 1 s, renewed every step while it is there.
   * The page reads the state in the signals buffer: 128 | the rail arms' bits while the barrier is down, 0 up.
   * Work per step: the trains in the window × the nodes of their route within reach.
   */
  private updateCrossings(): void {
    const c = this.veh.cols, sim = this.sim, sc = sim.net.segs.cols;
    this.lines.forEach((ln, li) => {
      if (!ln.mode) return;
      for (const v of this.busSets[li]) {
        if (!this.veh.alive[v]) continue;
        if (c.conn[v] >= 0) { const n = sim.conns.cols.node[c.conn[v]]; if (sim.nodeCtl[n] === Ctl.Crossing) this.crossingClosed.set(n, this.time + 1); }
        if (c.lane[v] < 0) continue;
        // a far train has no position on its lane: where it should be by now, from when it entered and when it leaves
        let s = c.s[v];
        if (!c.micro[v]) {
          const L = sim.laneLen(c.lane[v]), span = c.tExit[v] - c.tIn[v];
          s = span > 0 ? L * Math.min(1, Math.max(0, (this.time - c.tIn[v]) / span)) : L;
          // its tail is still on the crossing it just went through
          const back = c.rIdx[v] > 0 ? this.routeAt(v, c.rIdx[v] - 1) : -1;
          if (back >= 0 && s < c.len[v] && sim.nodeCtl[back] === Ctl.Crossing) this.crossingClosed.set(back, this.time + 1);
        }
        let d = sim.laneLen(c.lane[v]) - s;
        for (let k = c.rIdx[v]; k < c.rLen[v] && d < Traffic.CROSSING_REACH; k++) {
          const n = this.routeAt(v, k);
          if (n >= 0 && n < sim.nodeCtl.length && sim.nodeCtl[n] === Ctl.Crossing) this.crossingClosed.set(n, this.time + 1);
          if (k + 1 < c.rLen[v]) { const s = this.segBetween(n, this.routeAt(v, k + 1)); if (s < 0) break; d += sc.len[s]; }
        }
      }
    });
    for (const [n, until] of this.crossingClosed) {
      const open = until < this.time || !sim.net.nodes.alive[n];
      if (this.signals && n < this.signals.length) {
        let mask = 0;
        if (!open) { const segs = sim.net.segsOf(n, []); segs.forEach((s, a) => { if (PROFILE_INFO[sc.profile[s]].rail) mask |= 1 << a; }); }
        this.signals[n] = open ? 0 : 128 | (mask & 63);
      }
      if (open) this.crossingClosed.delete(n);
    }
  }

  /** The barrier of the level crossing at node n is down. */
  crossingDown(n: number): boolean { return (this.crossingClosed.get(n) ?? -1) >= this.time; }

  private gateRules(conn: number, v: number, toEnd: number): boolean {
    const sim = this.sim, k = sim.conns.cols, n = k.node[conn], c = this.veh.cols;
    // level crossing with the barrier down: road traffic waits (the train goes through)
    if (sim.nodeCtl[n] === Ctl.Crossing && this.crossingDown(n) && !PROFILE_INFO[sim.net.segs.cols.profile[laneSeg(k.from[conn])]].rail) return false;
    if (sim.nodePhases[n] > 0) {
      if (!this.stageGreen(conn)) {
        if (this.sig.amberNow(n) && this.stageGreen(conn, true)) { const sv = c.v[v]; if (toEnd < (sv * sv) / (2 * 3.5)) return true; }
        return false;
      }
    } else if (sim.nodeRing[n]) return this.gateOpen(conn);
    // zebra: give way to whoever is crossing (the pedestrian only appears near the camera)
    else if (sim.nodeCtl[n] === Ctl.Zebra) return !this.pedCrossing(n);
    else if (sim.armRule[n * 8 + k.arm[conn]] === Rule.Stop && c.wait[v] < 1.2) return false; // stop sign: halt before going on
    // right of way: wait for those who go first (at a signal, only the permitted conflict, such as a left turn)
    const list = sim.conflicts.get(conn);
    if (!list) return true;
    const stuck = c.wait[v] > 8; // nobody stays stuck forever: after 12 s only those already in the junction are respected
    const now = Math.round(this.time * 10);
    // and claims the turn: those on the priority road who can still stop comfortably let it through
    if (stuck) this.connClaim[conn] = now;
    const sv = c.v[v], canStop = toEnd > (sv * sv) / (2 * 3) + 1;
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      if (stuck) { if (this.connHead[d] >= 0) return false; continue; }
      if (canStop && now - this.connClaim[d] < 6) return false;
      if (sim.nodePhases[n] > 0 && !this.stageGreen(d, true) && this.connHead[d] < 0) continue;
      const higher = this.outranks(d, conn);
      if (higher && this.connBusy(d, v, this.ruleRank(d) > this.ruleRank(conn))) return false;
      if (!higher && this.connHead[d] >= 0 && this.ruleRank(d) >= this.ruleRank(conn)) return false; // do not drive into someone already going through
    }
    return true;
  }

  /** Steps the actuated lights and writes the state of the lights near the camera for the drawing. */
  private updateSignals(dt: number): void {
    const sim = this.sim;
    this.sig.step(dt);
    for (const n of this.windowSignals) {
      if (!sim.net.nodes.alive[n] || sim.nodePhases[n] === 0) { this.signalNodes.delete(n); this.windowSignals.delete(n); this.sig.setActive(n, false); if (this.signals && n < this.signals.length) this.signals[n] = 0; continue; }
      if (this.signals && n < this.signals.length) {
        // 128 | amber << 6 | arms with green/amber
        const st = this.sig.state(n), mask = (st & 3) < 2 ? this.sig.arms[n * 8 + (st >> 2)] : 0;
        this.signals[n] = 128 | ((st & 3) === 1 ? 64 : 0) | (mask & 63);
      }
    }
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
  evacuateConn(conn: number): void {
    const c = this.veh.cols, sim = this.sim;
    for (let v = this.connHead[conn]; v >= 0;) {
      const next = c.next[v];
      const to = sim.conns.cols.to[conn];
      this.unlink(v);
      c.conn[v] = -1;
      if (!sim.net.segs.alive[laneSeg(to)]) { c.why[v] = End.Lost; this.finish(v); v = next; continue; }
      // the destination lane may be gone with a new profile: the outermost one left, or the trip is lost
      const kept = this.keptLane(to);
      if (kept < 0) { c.why[v] = End.Lost; this.finish(v); v = next; continue; }
      this.setLaneCount(c.lane[v], -1);
      this.setLaneCount(kept, 1);
      c.lane[v] = kept; c.s[v] = 0; c.rIdx[v]++;
      this.enterLane(v, 0);
      if (c.rIdx[v] >= c.rLen[v] || this.routeAt(v, c.rIdx[v]) !== sim.laneTo(kept)) this.replanFrom(v, sim.laneTo(kept));
      this.insert(v, false, kept);
      v = next;
    }
    this.connHead[conn] = -1; this.connTail[conn] = -1;
    this.activeConns.delete(conn);
  }

  /** Rebuilt nodes: a new plan for their lights, which start their cycle again. */
  nodesRebuilt(nodes: number[]): void {
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
          else { this.setLaneCount(lane, -1); this.setLaneCount(to, 1); c.lane[v] = to; this.mesoLink(v, to); }
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

  /** IDM acceleration with a leader `gap` metres ahead moving at `vl`. */
  private idm(v: number, v0: number, gap: number, vl: number, am = A_MAX): number {
    const dv = v - vl;
    // queue discharge (roadcraft): the one ahead has left and I am still slow → keep a shorter gap and react
    // faster (up to 60%, gone at 4 m/s); the queue moves off together, without an accordion effect
    const rel = vl > 0.3 && v < 4 ? 0.6 * (1 - v / 4) * Math.min(1, vl / 1.5) : 0;
    const sStar = S0 * (1 - rel) + Math.max(0, v * T_HEAD * (1 - rel) + (v * dv) / (2 * Math.sqrt(am * B_COMF)));
    const g = Math.max(0.1, gap);
    return am * (1 - Math.pow(v / Math.max(0.1, v0), 4) - (sStar / g) * (sStar / g));
  }

  private stepMicro(dt: number): void {
    const c = this.veh.cols, sim = this.sim, step = ++this.microStep;
    // connections first (they are ahead of the lanes that feed them)
    for (const conn of [...this.activeConns]) {
      for (let v = this.connHead[conn]; v >= 0;) {
        const next = c.next[v];
        if (c.moved[v] !== step) { c.moved[v] = step; this.moveOnConn(v, conn, dt); }
        v = next;
      }
    }
    for (const lane of [...this.activeLanes]) {
      if (!sim.net.segs.alive[laneSeg(lane)]) continue;
      for (let v = this.laneHead[lane]; v >= 0;) {
        const next = c.next[v];
        if (c.moved[v] !== step) { c.moved[v] = step; this.moveOnLane(v, lane, dt); }
        v = next;
      }
    }
  }
  private microStep = 0;

  /** Distance to the rearmost vehicle on the connection/lane ahead (to follow through the node). */
  private aheadThrough(conn: number): [number, number] {
    const c = this.veh.cols, k = this.sim.conns.cols;
    const t = this.connTail[conn];
    if (t >= 0) return [c.s[t] - c.len[t], c.v[t]];
    const lt = this.laneTail[k.to[conn]];
    if (lt >= 0) return [k.len[conn] + c.s[lt] - c.len[lt], c.v[lt]];
    return [k.len[conn] + 60, 99];
  }

  private moveOnLane(v: number, lane: number, dt: number): void {
    const c = this.veh.cols, sim = this.sim;
    // manoeuvring while still in the lane: stopped there, so those behind wait (or change lanes)
    if (c.dying[v] === 3) { c.v[v] = 0; c.brk[v] = 1; return; }
    if (c.dying[v] === 4) { this.kerbStep(v, lane, dt); return; }
    const L = sim.laneLen(lane);
    const p = sim.net.segs.cols.profile[laneSeg(lane)];
    const v0 = laneSpeed(p) * c.vf[v];
    let gap = 1e9, vl = 99;
    const lead = c.prev[v];
    if (lead >= 0) { gap = c.s[lead] - c.len[lead] - c.s[v]; vl = c.v[lead]; }
    // end of the lane: destination, signal or whatever comes after the node
    let conn = -1, release = false;
    // bus: the stop is an obstacle until it halts and serves it
    let atStop = false;
    if (c.line[v] >= 0 && !c.dying[v]) {
      const ln = this.lines[c.line[v]];
      if (ln && ln.stopLane[c.stopI[v]] === lane) {
        const sg = ln.stopV[c.stopI[v]] - c.s[v];
        if (sg > -2) {
          if (sg < 1.2 && c.v[v] < 0.4) {
            c.dwell[v] += dt;
            if (c.dwell[v] >= (ln.mode ? 25 : ln.term.has(c.stopI[v]) ? TERMINAL_DWELL : DWELL)) { c.dwell[v] = 0; this.serve(v); }
            else atStop = true;
          }
          if (lead < 0 || sg + S0 < gap) { gap = Math.min(gap, Math.max(0, sg) + S0); vl = 0; }
        }
      }
    }
    if (c.dying[v]) { /* leaving */ }
    else if (this.atDestination(v) && c.line[v] < 0) {
      // near the camera cars and trucks decide 30 m before the end (room for the manoeuvre); the rest at 12 m
      const room = c.micro[v] && (c.kind[v] === 0 || c.kind[v] === 2) && this.nearCam(lane) ? 30 : 12;
      if (L - c.s[v] < room) { const r = this.arrive(v, lane, L - c.s[v]); if (r === 1) return; if (r === 2) c.dying[v] = 1; }
    } else {
      let ns = this.nextSeg(v);
      if (ns < 0 && !c.dying[v]) { this.replanFrom(v, sim.laneTo(lane)); ns = this.nextSeg(v); }
      if (ns >= 0) conn = sim.connToward(lane, ns, c.line[v] >= 0);
      if (conn < 0) {
        // wrong lane: try to change; otherwise take any connection and replan
        if (ns >= 0) this.mandatoryChange(v, lane, ns);
        conn = sim.laneConn[lane];
        if (conn < 0 && lead < 0 && c.lane[v] === lane) this.escapeLane(v, lane);
      }
      // it just moved to the next lane over: it goes on from there in the next step (this lane's leader, length and
      // connection no longer apply)
      if (c.lane[v] !== lane) return;
      // stopped for 10 s in the queue of a full lane (not at the red of a lane with room): reconsider the
      // route, avoiding what is full (roadcraft reconsiderRoute). At the line it is too late to change (as in
      // roadcraft): there `detour` handles it, and only toward an exit with room
      if (c.held[v] >= STUCK_SECONDS && lead >= 0 && c.line[v] < 0 && this.routeBudget > 0) {
        c.held[v] = 0;
        if (this.laneCount[lane] >= 0.6 * L / 7.5 && this.reconsider(v, lane, -1)) {
          const ns2 = this.nextSeg(v);
          if (ns2 >= 0 && sim.connToward(lane, ns2, false) < 0) this.mandatoryChange(v, lane, ns2);
          if (c.lane[v] !== lane) return;
        }
      }
      if (lead < 0) {
        const toEnd = L - c.s[v];
        if (toEnd < 6 && c.v[v] < 0.5) c.wait[v] += dt;
        // exit blocked for a while: the driver detours via another free exit of this lane
        if (conn >= 0 && c.wait[v] > 6 && c.lcCool[v] <= 0 && !this.exitRoom(conn, v)) {
          c.lcCool[v] = 5;
          const alt = this.detour(v, lane, conn);
          if (alt >= 0) conn = alt;
        }
        // waiting for the full exit for a long time: reserve its next free spot (the longest waiter wins)
        if (conn >= 0 && toEnd < 6 && c.wait[v] > STARVE_SECONDS) {
          const to = sim.conns.cols.to[conn], cl = this.exitClaim[to];
          if (cl === v || cl < 0 || this.time - this.exitClaimT[to] >= 1 || !this.veh.alive[cl] || c.wait[cl] < c.wait[v]) { this.exitClaim[to] = v; this.exitClaimT[to] = this.time; }
        }
        // jammed junction (nobody through for 20 s and this one waiting 20 s): one at a time, with the box clear
        if (conn >= 0 && toEnd < 6 && c.wait[v] > JAM_SECONDS) release = this.jamRelease(conn, v);
        if (conn < 0 || !(release || this.gateFor(conn, v, toEnd))) { gap = Math.min(gap, toEnd - 1); vl = 0; }
        else { const [g2, v2] = this.aheadThrough(conn); if (toEnd + g2 < gap) { gap = toEnd + g2; vl = v2; } } // (does not override the bus stop)
        // bus and train: a stop just past the node already counts for braking (a fast train cannot stop in 20 m)
        const sg = this.stopAhead(v, conn);
        if (sg >= 0 && toEnd + sg < gap) { gap = toEnd + sg; vl = 0; }
      }
    }
    let a = this.idm(c.v[v], v0, gap, vl, c.kind[v] ? A_HEAVY : A_MAX);
    if (c.dying[v]) a = Math.min(a, 0); // an arrived vehicle disappears without braking in front of others
    if (c.pk[v] > 0 && !c.dying[v] && c.dwell[v] < 1.2) a = -9; // in the bay, waiting to pull out
    if (c.mv[v] >= 0) a = -9; // pulling out of the bay: held until the manoeuvre is back in the lane
    if (atStop) a = Math.min(a, -2);
    a = Math.max(-9, a);
    const nv = Math.max(0, c.v[v] + a * dt);
    c.exitC[v] = conn;
    c.brk[v] = a < -1.2 || nv < 0.4 ? 1 : 0;
    // pulling out of the bay: the drawing slides from the kerb to the lane (the simulation already has it in the lane)
    if (c.pk[v] > 0 && !c.dying[v] && c.mv[v] < 0 && (c.dwell[v] += dt) > 1.2) c.pk[v] = Math.max(0, c.pk[v] - dt / PARK_SIDE_S);
    c.s[v] += (c.v[v] + nv) * 0.5 * dt;
    c.v[v] = nv;
    if (c.lcT[v] < 1) c.lcT[v] = Math.min(1, c.lcT[v] + dt / 2.2);
    c.lcCool[v] -= dt;
    if (c.dying[v]) { c.fade[v] -= dt * 1.5; if (c.fade[v] <= 0) this.finish(v); return; }
    if (c.fade[v] < 1) c.fade[v] = Math.min(1, c.fade[v] + dt * 1.2);
    if (nv < 0.5) c.held[v] += dt; else c.held[v] = 0;
    if (c.s[v] >= L) {
      // lane with no exit at all (the turn was from another lane and the change failed): stop at the line and change
      // lanes when there is room (`escapeLane`), instead of disappearing
      if (conn < 0) { c.s[v] = L - 0.01; c.v[v] = 0; return; }
      if (!release && !this.gateFor(conn, v, 0)) { c.s[v] = L - 0.01; c.v[v] = 0; return; }
      // enter the connection
      this.leaveLane(v, lane);
      this.unlink(v);
      c.s[v] -= L;
      c.conn[v] = conn;
      c.wait[v] = 0;
      c.held[v] = 0;
      const k = sim.conns.cols;
      if (release) { this.released++; this.releaseAt[k.node[conn]] = this.time + RELEASE_EVERY; this.nodePass[k.node[conn]]++; this.advisor.pass[k.node[conn] * 8 + k.arm[conn]]++; }
      else this.admit(k.node[conn], k.arm[conn]);
      this.insert(v, true, conn);
      return;
    }
    if (c.lcCool[v] <= 0 && lead >= 0) this.discretionaryChange(v, lane);
  }

  /** Someone went through node `n` from arm `arm` (micro or meso): arm flow and "the node is moving". */
  private admit(n: number, arm: number): void {
    this.nodePass[n]++;
    this.advisor.pass[n * 8 + arm]++;
    this.lastAdmit[n] = this.time;
  }

  /**
   * Jammed junction (roadcraft invariants: nobody has gone through for JAM_SECONDS and `v` has waited at the line
   * that long): `v` may go without waiting for its turn or for the exit, one vehicle every RELEASE_EVERY s, only
   * with the box clear (nobody on connections crossing its own) and no pedestrian on the crosswalk. At a signal only
   * those on green (held by the full exit): nobody runs the red. In a cycle of full lanes, each one entering the box
   * frees a spot behind and the wheel turns.
   */
  private jamRelease(conn: number, v: number): boolean {
    const sim = this.sim, k = sim.conns.cols, n = k.node[conn];
    if (this.time - this.lastAdmit[n] < JAM_SECONDS || this.time < this.releaseAt[n]) return false;
    if (this.veh.cols.wait[v] < JAM_SECONDS) return false;
    if (this.jamAt[n] < this.lastAdmit[n]) { this.jamAt[n] = this.time; this.jams++; } // new jam
    if (sim.nodePhases[n] > 0 && !this.stageGreen(conn, true)) return false;
    if (this.connHead[conn] >= 0 && this.veh.cols.s[this.connTail[conn]] < this.veh.cols.len[this.connTail[conn]] + 2) return false;
    if (this.pedCrossing(n)) return false;
    const list = sim.conflicts.get(conn);
    if (list) for (let i = 0; i < list.length; i++) if (this.connHead[list[i]] >= 0) return false;
    return true;
  }

  /**
   * A driver stopped for STUCK_SECONDS reconsiders the route (roadcraft reconsiderRoute): the search already avoids
   * full roads (cost by occupancy) and, if the exit it wanted is full, bans that segment.
   * With no other path it keeps the previous route. Returns whether the route changed.
   */
  private reconsider(v: number, lane: number, blocked: number): boolean {
    const c = this.veh.cols, sim = this.sim;
    if (c.line[v] >= 0 || this.routeBudget <= 0) return false;
    const node = sim.laneTo(lane);
    // the route continues from `node` (rIdx points at it); the detour is local: it rejoins the route a few nodes
    // ahead (short, cheap search), and the rest of the route stays as it was
    const o = v * ROUTE_CAP, k0 = c.rIdx[v], len = c.rLen[v];
    if (k0 >= len || this.routes[o + k0] !== node || k0 + 1 >= len) return false;
    const j = Math.min(len - 1, k0 + REJOIN);
    const target = this.routes[o + j];
    this.routeBudget--;
    const lim = this.router.limit;
    this.router.limit = 600;
    const n = this.router.route(node, target, this.detourPath, 0, ROUTE_CAP, false, laneSeg(lane), false, blocked);
    this.router.limit = lim;
    if (n < 2 || this.detourPath[n - 1] !== target) return false;
    // only a detour this lane can reach (no forced lane change in the queue, which ended in a wrong connection
    // and a route rebuilt from scratch on the other side)
    const first = this.segBetween(this.detourPath[0], this.detourPath[1]);
    if (first < 0 || this.sim.connToward(lane, first, false) < 0) return false;
    // nothing changed (the same node sequence): keep it
    let same = n === j - k0 + 1;
    for (let i = 0; same && i < n; i++) same = this.detourPath[i] === this.routes[o + k0 + i];
    if (same) return false;
    // new route: detour + what remained after the rejoin point (as far as it fits)
    this.splice(v, 0, n, j);
    this.reroutes++;
    return true;
  }
  private detourPath = new Int32Array(ROUTE_CAP);
  private tailTmp = new Int32Array(ROUTE_CAP);

  /** New route of `v`: `pre` nodes already in routes[0..pre), the detour (`detourPath`, n nodes) and what remained of the route after index `j`. */
  private splice(v: number, pre: number, n: number, j: number): void {
    const c = this.veh.cols, o = v * ROUTE_CAP, len = c.rLen[v];
    const tail = this.tailTmp, rest = Math.max(0, Math.min(len - j - 1, ROUTE_CAP - pre - n));
    for (let i = 0; i < rest; i++) tail[i] = this.routes[o + j + 1 + i];
    for (let i = 0; i < n; i++) this.routes[o + pre + i] = this.detourPath[i];
    for (let i = 0; i < rest; i++) this.routes[o + pre + n + i] = tail[i];
    c.rLen[v] = pre + n + rest; c.rIdx[v] = 0;
  }

  /**
   * Another connection of the lane with room at the exit; the route is rebuilt from it, rejoining the previous route
   * a few nodes ahead (short search; with no rejoin nearby, all the way to the destination). −1 if none.
   */
  private detour(v: number, lane: number, blocked: number): number {
    const c = this.veh.cols, sim = this.sim, k = sim.conns.cols;
    if (c.line[v] >= 0 || this.routeBudget <= 0) return -1;
    const o = v * ROUTE_CAP, k0 = c.rIdx[v], len = c.rLen[v];
    for (let x = sim.laneConn[lane]; x >= 0; x = k.nextFromLane[x]) {
      if (x === blocked || k.turn[x] === Turn.UTurn) continue;
      const to = k.to[x];
      if (sim.isBusLane(to) || !this.exitRoom(x, v)) continue;
      const far = sim.laneTo(to);
      this.routeBudget--;
      const j = Math.min(len - 1, k0 + REJOIN + 1), target = this.routes[o + j];
      if (k0 < len && j > k0 + 1 && target !== far) {
        const lim = this.router.limit;
        this.router.limit = 600;
        const n = this.router.route(far, target, this.detourPath, 0, ROUTE_CAP - 1, false, laneSeg(to));
        this.router.limit = lim;
        if (n >= 2 && this.detourPath[n - 1] === target) { this.routes[o] = k.node[x]; this.splice(v, 1, n, j); return x; }
      }
      const n = this.router.route(far, c.dest[v], this.routes, o + 1, ROUTE_CAP - 1, false, laneSeg(to));
      if (n < 1) continue;
      this.routes[o] = k.node[x];
      c.rLen[v] = n + 1; c.rIdx[v] = 0;
      return x;
    }
    return -1;
  }

  /** Distance from the start of the connection to the stop (if the stop is on the lane after it), or −1. */
  private stopAhead(v: number, conn: number): number {
    const c = this.veh.cols;
    if (c.line[v] < 0 || conn < 0) return -1;
    const ln = this.lines[c.line[v]];
    if (!ln || ln.stopLane[c.stopI[v]] !== this.sim.conns.cols.to[conn]) return -1;
    return this.sim.conns.cols.len[conn] + ln.stopV[c.stopI[v]];
  }

  private moveOnConn(v: number, conn: number, dt: number): void {
    const c = this.veh.cols, sim = this.sim, k = sim.conns.cols;
    const L = k.len[conn];
    const to = k.to[conn];
    const v0 = Math.min(laneSpeed(sim.net.segs.cols.profile[laneSeg(to)]), k.turn[conn] === Turn.Straight ? 99 : 8) * c.vf[v];
    let gap = 1e9, vl = 99;
    const lead = c.prev[v];
    if (lead >= 0) { gap = c.s[lead] - c.len[lead] - c.s[v]; vl = c.v[lead]; }
    else {
      const lt = this.laneTail[to];
      if (lt >= 0) { gap = L - c.s[v] + c.s[lt] - c.len[lt]; vl = c.v[lt]; }
      // another connection merging into the same lane: whoever is closer to the end goes first (without it both
      // arrived together and one appeared inside the other at the start of the lane)
      const mine = L - c.s[v];
      for (let x = sim.nodeConn[k.node[conn]]; x >= 0; x = k.nextAtNode[x]) {
        if (x === conn || k.to[x] !== to) continue;
        const h = this.connHead[x];
        if (h < 0) continue;
        const ahead = k.len[x] - c.s[h];
        if (ahead < mine || (ahead === mine && h < v)) { const g = mine - ahead - c.len[h]; if (g < gap) { gap = g; vl = c.v[h]; } }
      }
    }
    const sg = this.stopAhead(v, conn);
    if (sg >= 0 && sg - c.s[v] < gap) { gap = Math.max(0, sg - c.s[v]); vl = 0; }
    if (c.lcT[v] < 1) c.lcT[v] = Math.min(1, c.lcT[v] + dt / 2.2); // a lane change finishing on the way through
    const a = Math.max(-9, this.idm(c.v[v], v0, gap, vl, c.kind[v] ? A_HEAVY : A_MAX));
    const nv = Math.max(0, c.v[v] + a * dt);
    c.s[v] += (c.v[v] + nv) * 0.5 * dt;
    c.v[v] = nv;
    c.brk[v] = a < -1.2 || nv < 0.4 ? 1 : 0;
    if (c.fade[v] < 1) c.fade[v] = Math.min(1, c.fade[v] + dt * 1.2);
    if (c.s[v] < L) return;
    // reached the next lane
    this.unlink(v);
    c.conn[v] = -1;
    const from = c.lane[v];
    this.setLaneCount(from, -1);
    this.setLaneCount(to, 1);
    c.lane[v] = to;
    c.s[v] -= L;
    this.enterLane(v, c.s[v]);
    // a lane change still under way goes on along the new segment (the lane on the same side of the new one)
    if (c.lcT[v] < 1 && c.lcFrom[v] >= 0 && laneSeg(c.lcFrom[v]) === laneSeg(from)) {
      const idx = laneIdx(to) + laneIdx(c.lcFrom[v]) - laneIdx(from), sg = laneSeg(to), dr = laneDir(to);
      if (idx >= 0 && idx < laneCount(sim.net.segs.cols.profile[sg], dr)) c.lcFrom[v] = laneId(sg, dr, idx); else c.lcT[v] = 1;
    }
    c.rIdx[v]++;
    // the route may have been broken (wrong lane): replan from the end of this lane;
    // heading to a median U-turn, replan (whoever overshot the destination turns there: the U-turn is a connection)
    const endNode = sim.laneTo(to);
    if (sim.nodeCtl[endNode] === Ctl.UTurn && c.line[v] < 0) this.replanFrom(v, endNode);
    else if (c.rIdx[v] >= c.rLen[v] || this.routeAt(v, c.rIdx[v]) !== endNode) this.replanFrom(v, endNode);
    if (!this.inWindowOut(to)) {
      // left the window: back to meso
      this.removeMicro(v);
      this.mesoEnter(v, to);
      return;
    }
    this.insert(v, false, to);
  }

  private inWindowOut(lane: number): boolean {
    const sc = this.sim.net.segs.cols, s = laneSeg(lane);
    return Math.hypot(sc.mx[s] - this.camX, sc.mz[s] - this.camZ) < this.window + WINDOW_OUT - WINDOW;
  }

  // ------------------------------------------------------------ lane changes

  /** Neighbours on lane `lane` around s: [leader, follower]. */
  private around(lane: number, s: number): [number, number] {
    const c = this.veh.cols;
    let lead = -1;
    for (let v = this.laneHead[lane]; v >= 0; v = c.next[v]) {
      if (c.s[v] < s) return [lead, v];
      lead = v;
    }
    return [lead, -1];
  }

  private canChange(v: number, target: number, bias: number): boolean {
    const c = this.veh.cols, sim = this.sim;
    const [lead, follow] = this.around(target, c.s[v]);
    const p = sim.net.segs.cols.profile[laneSeg(target)];
    const v0 = laneSpeed(p) * c.vf[v];
    const gapF = lead >= 0 ? c.s[lead] - c.len[lead] - c.s[v] : 1e9;
    const gapB = follow >= 0 ? c.s[v] - c.len[v] - c.s[follow] : 1e9;
    if (gapF < 2 || gapB < 3) return false;
    // safety: the new follower does not brake hard
    const am = c.kind[v] ? A_HEAVY : A_MAX;
    if (follow >= 0 && this.idm(c.v[follow], v0, gapB, c.v[v], c.kind[follow] ? A_HEAVY : A_MAX) < -3.5) return false;
    const aNew = this.idm(c.v[v], v0, gapF, lead >= 0 ? c.v[lead] : 99, am);
    const oldLead = c.prev[v];
    const aOld = oldLead >= 0 ? this.idm(c.v[v], v0, c.s[oldLead] - c.len[oldLead] - c.s[v], c.v[oldLead], am) : am;
    return aNew - aOld + bias > 0.25;
  }

  private doChange(v: number, from: number, to: number): void {
    const c = this.veh.cols;
    this.unlink(v);
    this.setLaneCount(from, -1);
    this.setLaneCount(to, 1);
    c.lane[v] = to;
    c.lcFrom[v] = from;
    c.lcT[v] = 0;
    c.lcCool[v] = 3;
    this.insert(v, false, to);
  }

  /**
   * Stopped at the end of a lane with no exit at all: moves to the adjacent lane that has one (the route is rebuilt
   * after the junction). Stopped at the line for 5 s, it changes into any physical gap (the neighbour waits).
   */
  private escapeLane(v: number, lane: number): void {
    const c = this.veh.cols, sim = this.sim;
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
    const c = this.veh.cols;
    const [lead, follow] = this.around(target, c.s[v]);
    if (lead >= 0 && c.s[lead] - c.len[lead] - c.s[v] < 0.5) return false;
    return follow < 0 || c.s[v] - c.len[v] - c.s[follow] > 0.5 + (c.v[follow] * c.v[follow]) / (2 * 6);
  }

  private mandatoryChange(v: number, lane: number, ns: number): void {
    const c = this.veh.cols, sim = this.sim;
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

  private discretionaryChange(v: number, lane: number): void {
    const c = this.veh.cols, sim = this.sim;
    c.lcCool[v] = 1 + this.rng.next();
    const seg = laneSeg(lane), dir = laneDir(lane);
    const n = laneCount(sim.net.segs.cols.profile[seg], dir);
    if (n < 2) return;
    const ns = this.nextSeg(v);
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

  // ------------------------------------------------------------ buses

  /**
   * Replaces the set of lines (the page sends them again after every road edit, so the stops follow the roads). A line
   * that is still there keeps its buses, their riders and the people waiting, stop by stop (matched by position): only
   * a removed stop loses those waiting for it, and riders bound for it get off at the bus's next stop. Buses of removed
   * lines (or a line that changed mode) leave; missing buses spawn at the stops; extra ones leave.
   */
  setLines(specs: LineSpec[]): void {
    const old = this.lines, oldSets = this.busSets;
    const byId = new Map<number, number>();
    old.forEach((ln, i) => byId.set(ln.id, i));
    const keptOld = new Set<number>();
    const lines: SimLine[] = [], sets: Array<Set<number>> = [];
    for (const sp of specs) {
      const ln = this.resolveLine(sp), li = lines.length, set = new Set<number>();
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
    this.busSets = sets;
    // a line with fewer buses now: the extra ones leave
    sets.forEach((set, li) => {
      let extra = set.size - lines[li].buses;
      for (const v of [...set]) { if (extra <= 0) break; set.delete(v); this.retireBus(v); extra--; }
    });
    this.keepBuses();
    this.indexStops();
  }

  /** Stops by STOP_CELL cell of the map (first entry of each cell, then line and stop of each entry). */
  private stopStart = new Int32Array(STOP_CELLS * STOP_CELLS + 1);
  private stopLine = new Int32Array(0);
  private stopIdx = new Int32Array(0);

  /** Sorts every stop into its cell (when the lines change), so the drawing reads only the cells near the camera. */
  private indexStops(): void {
    const cellOf = (x: number, z: number) => {
      const i = Math.min(STOP_CELLS - 1, Math.max(0, Math.floor((x + MAP_HALF) / STOP_CELL)));
      const j = Math.min(STOP_CELLS - 1, Math.max(0, Math.floor((z + MAP_HALF) / STOP_CELL)));
      return j * STOP_CELLS + i;
    };
    let n = 0;
    for (const ln of this.lines) n += ln.stopX.length;
    const start = this.stopStart.fill(0), line = new Int32Array(n), idx = new Int32Array(n);
    this.lines.forEach((ln) => { for (let i = 0; i < ln.stopX.length; i++) start[cellOf(ln.stopX[i], ln.stopZ[i]) + 1]++; });
    for (let c = 0; c < STOP_CELLS * STOP_CELLS; c++) start[c + 1] += start[c];
    const fill = start.slice(0, STOP_CELLS * STOP_CELLS);
    this.lines.forEach((ln, li) => { for (let i = 0; i < ln.stopX.length; i++) { const k = fill[cellOf(ln.stopX[i], ln.stopZ[i])]++; line[k] = li; idx[k] = i; } });
    this.stopLine = line; this.stopIdx = idx;
  }

  /** A bus leaves its line: fades out where it is (near the camera) or goes at once (far). Not a trip. */
  private retireBus(v: number): void {
    const c = this.veh.cols;
    if (!this.veh.alive[v] || c.line[v] < 0) return;
    this.riders.delete(v);
    c.why[v] = End.NoTrip;
    if (c.micro[v]) { c.dying[v] = 1; c.line[v] = -1; } else { c.line[v] = -1; this.despawn(v); }
  }

  /** The new version `ln` (index `li`) of line `prev`: its buses, riders and those waiting, stop by stop. */
  private carryLine(prev: SimLine, prevSet: Set<number>, ln: SimLine, li: number, set: Set<number>): void {
    const c = this.veh.cols, n = ln.stopLane.length, m = prev.stopLane.length;
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
      for (let k = 0; k < m; k++) if (toNew[k] >= 0) { ln.waitTo[i][toNew[k]] += prev.waitTo[j][k]; w += prev.waitTo[j][k]; }
      ln.waiting[i] = w;
    }
    ln.boardings = prev.boardings; ln.perHour = prev.perHour;
    /** The first stop from old index `j` on (in the line's order) that is still there. */
    const nextKept = (j: number): number => { for (let k = 0; k < m; k++) { const i = toNew[(j + k) % m]; if (i >= 0) return i; } return 0; };
    for (const v of prevSet) {
      if (!this.veh.alive[v] || c.dying[v] || c.line[v] < 0) continue;
      set.add(v);
      c.line[v] = li;
      const next = nextKept(c.stopI[v]);
      const r = this.riders.get(v);
      if (r) {
        const nr = new Float64Array(n);
        for (let k = 0; k < r.length && k < m; k++) nr[toNew[k] >= 0 ? toNew[k] : next] += r[k];
        this.riders.set(v, nr);
      }
      c.stopI[v] = next;
    }
  }

  /** A line from the page with its stops resolved to lanes. */
  private resolveLine(sp: LineSpec): SimLine {
    const net = this.sim.net, sc = net.segs.cols;
    const rail = (sp.mode ?? 0) > 0;
    const ln: SimLine = { id: sp.id, color: sp.color, buses: sp.buses, mode: sp.mode ?? 0, stopLane: [], stopV: [], waiting: [], lastT: [],
      stopX: [], stopZ: [], stopY: [], stopYaw: [], waitTo: [], boardings: 0, perHour: 0, term: new Set<number>() };
    /** One stop at (x, z); `flip`: the stop of the return trip, across the street. False if no road there. */
    const addStop = (x: number, z: number, i: number, flip: boolean): boolean => {
      // bus: nearest ordinary road; train and metro: nearest rail
      const hit = net.nearestSeg(x, z, 40, (sg) => PROFILE_INFO[sc.profile[sg]].rail === rail);
      if (!hit) return false;
      const [seg, t] = hit;
      const q = net.quad(seg);
      const pp = new Float64Array(2), dd = new Float64Array(2);
      bez(q, t, pp); bezD(q, t, dd);
      // return trip: the same stop mirrored across the street's centre line
      if (flip) { x = 2 * pp[0] - x; z = 2 * pp[1] - z; }
      // side: u+ (left of a→b) is the sidewalk of those driving from b to a
      const u = (x - pp[0]) * dd[1] - (z - pp[1]) * dd[0];
      let dir = u > 0 ? -1 : 1;
      if (rail) {
        // station: the line heads to the next station on the track of its direction
        const ni = (i + 2) % sp.stops.length, nx = sp.stops[ni] - x, nz = sp.stops[ni + 1] - z;
        dir = nx * dd[0] + nz * dd[1] >= 0 ? 1 : -1;
      }
      if (laneCount(sc.profile[seg], dir) === 0) dir = -dir;
      if (laneCount(sc.profile[seg], dir) === 0) return false;
      const lane = laneId(seg, dir, 0);
      const L = this.sim.laneLen(lane);
      const along = this.sim.sAlong(seg, t);
      const v = dir > 0 ? along - this.sim.segS0(seg) : this.sim.segS1(seg) - along;
      if (sp.term?.includes(i / 2)) ln.term.add(ln.stopLane.length);
      ln.stopLane.push(lane);
      ln.stopV.push(Math.max(Math.min(8, L * 0.4), Math.min(L - 14, v)));
      ln.waiting.push(0); ln.lastT.push(this.time);
      const lp = new Float64Array(4);
      this.sim.lanePoint(lane, ln.stopV[ln.stopV.length - 1], lp);
      ln.stopX.push(x); ln.stopZ.push(z); ln.stopY.push(lp[1] + 0.15);
      ln.stopYaw.push(Math.atan2(lp[0] - x, lp[2] - z)); // facing the road
      return true;
    };
    const kept: number[] = [];
    for (let i = 0; i + 1 < sp.stops.length; i += 2) if (addStop(sp.stops[i], sp.stops[i + 1], i, false)) kept.push(i);
    // Roadcraft bus lines go out and back: the stops of the return trip on the other side, the two ends terminals
    if (!rail && !sp.loop && kept.length >= 2) {
      ln.term.add(0); ln.term.add(ln.stopLane.length - 1);
      for (let k = kept.length - 2; k >= 1; k--) addStop(sp.stops[kept[k]], sp.stops[kept[k] + 1], kept[k], true);
    }
    ln.waitTo = ln.stopLane.map(() => new Float64Array(ln.stopLane.length));
    return ln;
  }

  /** Keeps the number of buses on each line (those that vanished respawn at a stop). */
  private keepBuses(): void {
    if (this.lines.length === 0) return;
    const c = this.veh.cols;
    this.lines.forEach((ln, i) => {
      const n = ln.stopLane.length;
      if (n < 2) return;
      let have = 0;
      for (const v of this.busSets[i]) if (!c.dying[v]) have++;
      for (let k = have; k < ln.buses; k++) this.spawnBus(i, Math.floor((k * n) / Math.max(1, ln.buses)) % n);
    });
  }

  private spawnBus(li: number, stop: number): void {
    const ln = this.lines[li], sim = this.sim;
    const lane = ln.stopLane[stop];
    if (!sim.net.segs.alive[laneSeg(lane)]) return;
    const v = this.veh.alloc();
    this.initVehicle(v);
    const c = this.veh.cols;
    const train = ln.mode > 0;
    c.kind[v] = train ? 4 : 1; c.len[v] = KIND_LEN[train ? 4 : 1]; c.vf[v] = train ? 1 : 0.9;
    c.color[v] = ln.color & 15;
    c.line[v] = li; c.stopI[v] = stop; c.served[v] = 0;
    this.busSets[li].add(v);
    const o = v * ROUTE_CAP;
    this.routes[o] = sim.laneFrom(lane); this.routes[o + 1] = sim.laneTo(lane);
    c.rLen[v] = 2; c.rIdx[v] = 1; c.dest[v] = sim.laneTo(lane);
    c.lane[v] = lane; c.conn[v] = -1;
    c.s[v] = this.rng.next() * Math.max(0, ln.stopV[stop] - 6);
    this.enterLane(v, c.s[v]);
    this.setLaneCount(lane, 1);
    this.mesoEnter(v, lane, true);
  }

  /** Serves the stop: people get off and on; the next leg goes to the following stop. */
  /** Background demand that arrived since last time, spread over the destinations. */
  private accrue(ln: SimLine, i: number): void {
    const n = ln.stopLane.length;
    const room = Math.max(0, 120 - ln.waiting[i]);
    const add = Math.min(room, (this.time - ln.lastT[i]) * WAIT_RATE);
    ln.lastT[i] = this.time;
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
    ln.waiting[from] += 1;
  }

  /** For pedestrians: a random bus trip (line, boarding stop, alighting stop, boarding node, the stop on the sidewalk). */
  pickTrip(): [number, number, number, number, number, number] | null {
    if (this.lines.length === 0) return null;
    const li = this.rng.int(0, this.lines.length);
    const ln = this.lines[li];
    const n = ln.stopLane.length;
    if (n < 2 || this.busSets[li].size === 0 || ln.mode) return null;
    const a = this.rng.int(0, n);
    let b = this.rng.int(0, n - 1);
    if (b >= a) b++;
    return [li, a, b, this.sim.laneFrom(ln.stopLane[a]), ln.stopX[a], ln.stopZ[a]];
  }

  private serve(v: number): void {
    const c = this.veh.cols, ln = this.lines[c.line[v]];
    const i = c.stopI[v];
    const n = ln.stopLane.length;
    this.accrue(ln, i);
    let r = this.riders.get(v);
    if (!r || r.length !== n) { r = new Float64Array(n); this.riders.set(v, r); }
    // those bound for this stop get off (and carry on on foot)
    const off = r[i];
    r[i] = 0;
    // they step off at the stop and walk on (from a train people leave through the station: no sidewalk on the rails)
    if (off >= 0.5 && !ln.mode) this.onAlight(this.sim.laneTo(c.lane[v]), Math.round(off), ln.stopX[i], ln.stopZ[i]);
    let load = 0;
    for (let j = 0; j < n; j++) load += r[j];
    // those waiting get on, until full
    const room = Math.max(0, (ln.mode ? 600 : BUS_CAP) - load);
    const take = Math.min(Math.floor(ln.waiting[i]), room);
    if (take > 0 && ln.waiting[i] > 0) {
      const f = take / ln.waiting[i];
      for (let j = 0; j < n; j++) { const m = ln.waitTo[i][j] * f; r[j] += m; ln.waitTo[i][j] -= m; }
      ln.waiting[i] -= take;
    }
    c.load[v] = Math.min(255, Math.round(load + take));
    const on = take;
    ln.boardings += on;
    c.stopI[v] = (i + 1) % ln.stopLane.length;
    this.busPlan(v, this.sim.laneTo(c.lane[v]));
  }

  /** Route from node `from` to the current stop: arrives via the stop's lane (in the right direction). */
  private busPlan(v: number, from: number): void {
    const c = this.veh.cols, sim = this.sim, ln = this.lines[c.line[v]];
    if (!ln) { c.line[v] = -1; c.dying[v] = 1; return; }  // (line gone: the set has already been replaced)
    const target = ln.stopLane[c.stopI[v]];
    if (!sim.net.segs.alive[laneSeg(target)]) { c.dying[v] = 1; return; }
    const a = sim.laneFrom(target), b = sim.laneTo(target);
    const o = v * ROUTE_CAP;
    let n: number;
    if (from === a) { this.routes[o] = a; n = 1; }
    else {
      const inSeg = c.lane[v] >= 0 && sim.laneTo(c.lane[v]) === from ? laneSeg(c.lane[v]) : -1;
      const rail = ln.mode > 0;
      n = this.router.route(from, a, this.routes, o, ROUTE_CAP - 1, false, inSeg, rail, -1, true);
      if (n < 2) { c.dying[v] = 1; return; }
      if (this.routes[o + n - 1] !== a) { c.rLen[v] = n; c.rIdx[v] = 0; c.dest[v] = a; return; } // truncated route: go on and replan at the end
    }
    this.routes[o + n] = b;
    c.rLen[v] = n + 1; c.rIdx[v] = 0; c.dest[v] = b;
  }

  /** Those waiting at stops near the camera (standing people, up to 14 per stop). */
  writeStopPeople(data: Float32Array, stride: number, start: number, max: number): number {
    let n = 0;
    // only the cells within 600 m of the camera (the stop index), never every stop of every line
    const i0 = Math.max(0, Math.floor((this.camX - 600 + MAP_HALF) / STOP_CELL)), i1 = Math.min(STOP_CELLS - 1, Math.floor((this.camX + 600 + MAP_HALF) / STOP_CELL));
    const j0 = Math.max(0, Math.floor((this.camZ - 600 + MAP_HALF) / STOP_CELL)), j1 = Math.min(STOP_CELLS - 1, Math.floor((this.camZ + 600 + MAP_HALF) / STOP_CELL));
    for (let cj = j0; cj <= j1; cj++) for (let ci = i0; ci <= i1; ci++) {
      const cell = cj * STOP_CELLS + ci;
      for (let e = this.stopStart[cell]; e < this.stopStart[cell + 1]; e++) {
        const ln = this.lines[this.stopLine[e]], i = this.stopIdx[e];
        const x = ln.stopX[i], z = ln.stopZ[i];
        if (Math.abs(x - this.camX) > 600 || Math.abs(z - this.camZ) > 600) continue;
        const w = Math.min(14, Math.floor(Math.min(120, ln.waiting[i] + (this.time - ln.lastT[i]) * WAIT_RATE)));
        const yaw = ln.stopYaw[i];
        const ax = Math.cos(yaw), az = -Math.sin(yaw); // along the sidewalk
        for (let k = 0; k < w && start + n < max; k++) {
          const h = ((i * 7 + k * 13 + ln.id * 31) % 97) / 97;
          const along = (k - w / 2) * 0.75 + (h - 0.5) * 0.4;
          const back = -0.6 + ((k * 5) % 3) * 0.45;
          const px = x + ax * along + Math.sin(yaw) * back, pz = z + az * along + Math.cos(yaw) * back;
          const o = (start + n) * stride;
          const fy = yaw + (h - 0.5) * 0.9;
          data[o] = px; data[o + 1] = ln.stopY[i]; data[o + 2] = pz; data[o + 3] = fy;
          data[o + 4] = px; data[o + 5] = ln.stopY[i]; data[o + 6] = pz; data[o + 7] = fy;
          data[o + 8] = 3 * 256 + ((k * 5 + i) % 16);
          data[o + 9] = 1;
          data[o + 10] = (Math.imul(ln.id * 131 + i * 31 + k, 2654435761) >>> 16) & 0xffff;
          n++;
        }
      }
    }
    return n;
  }

  /** Line figures for the interface (passengers per hour). */
  lineStats(dtReport: number): Array<{ id: number; buses: number; perHour: number; waiting: number }> {
    return this.lines.map((ln, i) => {
      const have = this.busSets[i].size;
      // per simulated hour (paused: nothing to measure, the figure stays)
      if (dtReport > 0) {
        const rate = ln.boardings / dtReport * 3600;
        ln.perHour = ln.perHour === 0 ? rate : ln.perHour * 0.9 + rate * 0.1;
        ln.boardings = 0;
      }
      let w = 0;
      for (let k = 0; k < ln.waiting.length; k++) w += Math.min(120, ln.waiting[k] + (this.time - ln.lastT[k]) * WAIT_RATE);
      return { id: ln.id, buses: have, perHour: Math.round(ln.perHour), waiting: Math.round(w) };
    });
  }

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
    // those that left the window go back to "unknown" in the drawing and to their timed cycle
    for (const n of old) if (!this.windowSignals.has(n)) { this.sig.setActive(n, false); if (this.signals && n < this.signals.length) this.signals[n] = 0; }
    for (const n of this.windowSignals) this.sig.setActive(n, true);
    for (let i = this.microN - 1; i >= 0; i--) {
      const v = this.micro[i];
      if (c.conn[v] >= 0 || c.dying[v] === 2) continue;
      const lane = c.lane[v];
      if (this.inWindowOut(lane)) continue;
      // what only exists near the camera ends here, counted: a drop-off at the kerb finishes its trip and the car goes
      // on to the next; a car or truck manoeuvring into its bay or dock has arrived; one fading out leaves
      if (c.mv[v] >= 0) { this.mvs.end(c.mv[v]); c.mv[v] = -1; }
      if (c.dying[v] === 3 || c.dying[v] === 1) { this.finish(v); continue; }
      if (c.dying[v] === 4) {
        c.dying[v] = 0; c.served[v] = 0;
        if (!this.dropOffTrip(v, this.sim.laneTo(lane))) { this.arrived++; this.kerbStops++; c.why[v] = End.NoTrip; this.finish(v); continue; }
      }
      c.pk[v] = 0;
      this.unlink(v);
      this.removeMicro(v);
      this.mesoEnter(v, lane, true);
    }
  }

  // ------------------------------------------------------------ step

  step(dt: number): void {
    this.time += dt;
    this.measureRegions();
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
    this.lineCheck -= dt;
    if (this.lineCheck <= 0) { this.lineCheck = 2; this.keepBuses(); }
    this.updateSignals(dt);
    this.updateCrossings();
    this.processMeso();
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
      backAlong(this.sim, c.lane[v], c.conn[v], c.s[v], WAGON_LEN * (k + 0.5), p);
      // heading along the line between the wagon's ends (curves)
      const fx = p[0], fz = p[2];
      backAlong(this.sim, c.lane[v], c.conn[v], c.s[v], WAGON_LEN * k + 1, this.tmp2);
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

  writePoses(data: Float32Array, stride: number): number {
    const c = this.veh.cols, sim = this.sim, p = this.tmp, q = this.tmp2;
    let n = 0;
    for (let i = 0; i < this.microN; i++) {
      const v = this.micro[i];
      let lights = 0;
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
          p[0] += (q[0] - p[0]) * k; p[2] += (q[2] - p[2]) * k;
        }
      }
      if (c.kind[v] === 4) { n = this.writeTrain(v, data, stride, n, p); continue; }
      let centred = false;
      if (c.mv[v] >= 0) {
        // on a manoeuvre: the pose is the vehicle centre on the Reeds-Shepp path; signal towards where it goes
        const mp = this.mvA;
        this.mvs.pose(c.mv[v], mp);
        p[0] = mp[0]; p[2] = mp[1]; p[3] = mp[2];
        centred = true;
        lights |= this.mvs.t.cols.kind[c.mv[v]] === MKind.Unpark ? LIGHT_LEFT : LIGHT_RIGHT;
      } else if (c.dying[v] === 4 && c.conn[v] < 0) {
        // at the kerb: 0.9 m to the right, hazard lights while stopped
        const k = c.pk[v] * c.pk[v] * (3 - 2 * c.pk[v]);
        p[0] -= Math.cos(p[3]) * 0.9 * k; p[2] += Math.sin(p[3]) * 0.9 * k;
        if (c.v[v] < 0.1 && ((this.time * 1.5) % 1) < 0.5) lights |= LIGHT_LEFT | LIGHT_RIGHT;
      }
      // in the bay or on the way to it (offset in u, along the segment direction): pulling in, right indicator; pulling out, left
      if (!centred && c.dying[v] !== 4 && c.pk[v] > 0 && c.conn[v] < 0) {
        const lane = c.lane[v], dir = laneDir(lane);
        const du = (parkU(sim.net.segs.cols.profile[laneSeg(lane)], dir) - sim.laneU(lane)) * dir;
        const k = c.pk[v] * c.pk[v] * (3 - 2 * c.pk[v]);
        if (!Number.isNaN(du)) { p[0] += Math.cos(p[3]) * du * k; p[2] -= Math.sin(p[3]) * du * k; }
        if (c.dying[v] === 2 ? c.pk[v] < 1 : c.dwell[v] > 0.4) lights |= c.dying[v] === 2 ? LIGHT_RIGHT : LIGHT_LEFT;
      }
      // reference point at the middle of the vehicle
      const back = centred ? 0 : c.len[v] / 2;
      p[0] -= Math.sin(p[3]) * back; p[2] -= Math.cos(p[3]) * back;
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
}

/** Point `d` metres behind the vehicle's front (continues onto the previous lane along a straight line if needed). */
function backAlong(sim: SimNet, lane: number, conn: number, s: number, d: number, out: Float64Array): void {
  if (conn >= 0) {
    if (s - d >= 0) { sim.connPoint(conn, s - d, out); return; }
    const from = sim.conns.cols.from[conn];
    lane = from; s = sim.laneLen(from) + (s - d); d = 0;
  } else s -= d;
  if (s >= 0) { sim.lanePoint(lane, s, out); return; }
  sim.lanePoint(lane, 0, out);
  out[0] += Math.sin(out[3]) * s; out[2] += Math.cos(out[3]) * s;
}

function grow<T extends Int32Array | Uint32Array | Float32Array | Float64Array | Uint16Array | Uint8Array>(a: T, cap: number, fill: number): T {
  if (cap <= a.length) return a;
  const b = new (a.constructor as new (n: number) => T)(cap);
  b.fill(fill);
  b.set(a);
  return b;
}

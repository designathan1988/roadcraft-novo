// Pedestrians (simulation worker). Same scheme as traffic: across the whole map
// only events (end of each walking leg, in a time-ordered queue); near the
// camera, a position every frame, waiting at signalled crosswalks.
// Path = A* route over the nodes (only segments with a sidewalk); at each node it
// goes around the corners and crosses the arms at the crosswalks. Nothing walks the
// crowd per tick: each person sits in the list of the node it is walking to, and the
// window reads only the lists of the nodes near the camera.

import { Table } from '../core/table.ts';
import { Rng } from '../core/rng.ts';
import { armAngle, bez, bezD, closestT } from '../roads/geometry.ts';
import { armOf } from '../roads/junction.ts';
import { PROFILE_INFO } from '../roads/profiles.ts';
import { baseZone } from '../roads/zones.ts';
import { MAX_DEG } from '../roads/network.ts';
import type { SimNet } from './lanes.ts';
import { Router } from './routing.ts';
import { stripAt } from './probe.ts';

/**
 * Guard against a runaway only (2 million people, ~1 GB): the number of pedestrians is the demand (street length ×
 * density × the player's share); no map's demand comes near it.
 */
const PEDS_GUARD = 1 << 21;
/** Spawns per step: the steady rate, and while below half the demand (a map opening) the fill rate. */
const SPAWN_STEADY = 40, SPAWN_FILL = 400;
/** Chance of spawning at a node by the zone of the roads around it (none, residential, commercial, industrial, mixed). */
const ZONE_PULL = [0.12, 0.4, 1, 0.15, 0.8];
const ROUTE = 32;
/** Someone left with nowhere to walk fades out over this long (s). */
const FADE_OUT = 1.5;
/** A node near the camera lets its people out of a door within this distance (m). */
const DOOR_CELL = 80;
const WAYS = 12;
const CROSS_AT = 2.15; // middle of the crosswalk, measured from the setback
const WINDOW = 520;
const CURB = 0.15;
/** Farthest a sidewalk stretch may start past an end of its segment, level with where the walker was seen (m). */
const SEEN_PAST = 1.5;
/**
 * Walking paces (m/s): brisk and easy, inside the 1.2-1.5 m/s of people walking in town. Each pace keeps to its own
 * track on the sidewalk and the crosswalk, so nobody walks up into the person ahead in theirs.
 */
const PACE = [1.45, 1.25];
/**
 * Keeping right (roadcraft peds/sidewalk.ts stripes): how far right of the middle of the sidewalk each pace walks (m),
 * at most (narrow sidewalks squeeze them in), and across a crosswalk, right of the line between its ends.
 */
const TRACK = [0.25, 0.8], CROSS_TRACK = [0.35, 1.0];
/** Two people starting the same stretch from the same spot within this long (s): the second waits that long. */
const START_GAP = 0.7;
/**
 * Slots of the table that spaces people starting the same stretch (`spaced`): a few thousand people start a stretch
 * somewhere in a big city within START_GAP, and a slot taken by another stretch forgets the last start.
 */
const STARTS = 1 << 17;
/**
 * Near the camera people walk as roadcraft 4.0's walkers (sim/agents/walk.ts, SUMO's striping): within NEAR_R m of it,
 * every step. Stripe width, body, shoulders, look ahead, the gap kept and its headway, acceleration and braking, the
 * stripe's hold and switch gain, the lateral penalty and share, the step aside and the jam: walk.ts:23-65.
 */
const NEAR_R = 160;
const STRIPE = 0.65, BODY_R = 0.27, SHOULDERS = 0.5, LOOK = 8, MOVING = 0.1, KEEP = 0.45, HEADWAY = 0.5;
const PED_ACCEL = 1.2, PED_BRAKE = 2.5, SWITCH_GAIN = 1.2, AIM_HOLD = 0.6, HELD_SWITCH = 0.5;
/** Fastest a body turns walking and standing, rad/s (roadcraft walk.ts TURN_RATE, TURN_STANDING). */
const TURN_RATE = 3.5, TURN_STANDING = 6;
const LATERAL_PENALTY = 1 / STRIPE, LATERAL_SHARE = 0.4, SIDESTEP_RATE = 0.45;
const JAM_AFTER = 20, JAM_AFTER_CROSSING = 10, JAM_SHARE = 0.25, ONCOMING_CONFLICT = 50;
/** Closer than this (m, centre to centre) two walkers are one inside the other: they move apart across their ways. */
const CLOSE = 0.5;
/** Grid of the near walkers (`seeEachOther`): cell size (m, the look ahead, walk.ts:96) and hash slots. */
const NEAR_CELL = LOOK, NEAR_SLOTS = 1 << 14;
/** Share of trips made by bicycle when there is a bike lane nearby (roadcraft `vehicles/cycleLane.ts`). */
const BIKE_SHARE = 0.1;
/** Segments a cyclist rides (a wander along the bike lanes, no router). */
const BIKE_LEGS = 24;

/** u of the middle of the bike lane for someone riding in direction `dir` of the segment (right-hand traffic; NaN = no bike lane). */
function bikeU(profile: number, dir: number): number {
  let best = NaN;
  for (const e of PROFILE_INFO[profile].edges) {
    if (e.strip.kind !== 'bike') continue;
    const u = (e.u0 + e.u1) / 2;
    // a→b rides on the right (u < 0); b→a on the left (u > 0); a bike lane on one side only serves both directions
    if ((dir > 0 && u < 0) || (dir < 0 && u > 0)) return u;
    best = u;
  }
  return best;
}

const schema = {
  // route
  rLen: Uint8Array, rIdx: Uint8Array,
  // current segment (sidewalk): from da to db metres from node a, on side `side` (+1 = u+)
  seg: Int32Array, side: Int8Array, da: Float32Array, db: Float32Array,
  // current step: 0 sidewalk, 1 straight line between points, 2 waiting
  mode: Uint8Array, wIdx: Uint8Array, wLen: Uint8Array,
  t0: Float64Array, dur: Float32Array, at: Float64Array,
  // node it is walking to (window list)
  node: Int32Array, next: Int32Array, prev: Int32Array,
  speed: Float32Array, color: Uint8Array,
  // appearance id (16 bits) for the people renderer: drawn when the pedestrian is born, published at pose index 10
  look: Uint16Array,
  // last published position (for interpolation) and the publication it was in; `pyaw` is the heading it stands with
  // (waiting, standing), `syaw` the body's heading as last published (it turns at a person's rate, `writePoses`)
  px: Float32Array, py: Float32Array, pz: Float32Array, pyaw: Float32Array, syaw: Float32Array, has: Uint8Array, wf: Uint32Array,
  // bus trip: line (-1 = on foot only), boarding stop and alighting stop, and the boarding stop on the sidewalk
  tLine: Int16Array, tFrom: Uint8Array, tTo: Uint8Array, tx: Float32Array, tz: Float32Array,
  // by bicycle (rides on the bike lane)
  bike: Uint8Array,
  // where it enters the first sidewalk segment (0-1; someone leaving a door enters mid-way)
  enter: Float32Array,
  // near the camera (`seeEachOther`): the step aside (m, + = right), where it is heading, and how long it has held its pace
  lat: Float32Array, latT: Float32Array, hold: Float32Array,
  // its speed now (near the camera), and when it last chose its stripe
  vNow: Float32Array, aimAt: Float64Array,
  // and the share of its pace it walked in the last step (1 = free)
  pace: Float32Array,
};

const p2 = new Float64Array(2), d2 = new Float64Array(2);
const qd = { x0: 0, z0: 0, cx: 0, cz: 0, x1: 0, z1: 0 };

/** Numbers per person in `Peds.inspect`. */
export const PED_INSPECT_STRIDE = 12;

export class Peds {
  readonly t = new Table(schema, 4096);
  private sim: SimNet;
  private router: Router;
  private routes = new Int32Array(4096 * ROUTE);
  /** Waypoints per person: x, y, z, crossed arm + 1 (0 = not a crossing). */
  private ways = new Float32Array(4096 * WAYS * 4);
  private wayNode = new Int32Array(4096);
  /** Start point of the current straight line (or where it is standing). */
  private lineFrom = new Float32Array(4096 * 3);
  private pos3 = [0, 0, 0, 0];
  private head = new Int32Array(1 << 14).fill(-1);
  private heapT = new Float64Array(1 << 14);
  private heapP = new Int32Array(1 << 14);
  private heapN = 0;
  private rng = new Rng(4242);
  private time = 0;
  private windowNodes: number[] = [];
  /** Traffic light: may pedestrians start crossing arm `arm` of node `n` now? (provided by traffic) */
  walkOk: (n: number, arm: number) => boolean = () => true;
  /** Is a vehicle on the crosswalk over arm `arm` of node `n`, or about to drive over it? (provided by traffic) */
  carsOn: (n: number, arm: number) => boolean = () => false;
  /** A pedestrian waits at the kerb of the crossing over arm `arm` of node `n` (presses the button). */
  onWait: (n: number, arm: number) => void = () => {};
  /** Who last started each stretch (a hash of its start and end) and when: `spaced`. */
  private startKey = new Int32Array(STARTS).fill(-1);
  private startT = new Float64Array(STARTS);
  /** Events refused for an invalid time (should stay 0; each such person faded out). */
  invalid = 0;
  /** People per metre of car lane (simple demand). */
  density = 1 / 30;
  /** Share of people chosen by the player. */
  share = 1;
  camX = 0;
  camZ = 0;
  /** Doors near the camera (x, z), from the page, sorted into DOOR_CELL cells (`setDoors`). */
  doors: Float32Array = new Float32Array(0);
  private doorX0 = 0; private doorZ0 = 0; private doorW = 0; private doorH = 0;
  private doorStart = new Int32Array(1);
  private doorIdx = new Int32Array(0);

  /** Doors from the page: indexed by cell, so the door next to a node is found without scanning them all. */
  setDoors(pts: Float32Array): void {
    this.doors = pts;
    const n = pts.length >> 1;
    if (!n) { this.doorW = this.doorH = 0; return; }
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < n; i++) { x0 = Math.min(x0, pts[i * 2]); x1 = Math.max(x1, pts[i * 2]); z0 = Math.min(z0, pts[i * 2 + 1]); z1 = Math.max(z1, pts[i * 2 + 1]); }
    const w = Math.floor((x1 - x0) / DOOR_CELL) + 1, h = Math.floor((z1 - z0) / DOOR_CELL) + 1;
    this.doorX0 = x0; this.doorZ0 = z0; this.doorW = w; this.doorH = h;
    const cell = (i: number) => Math.floor((pts[i * 2 + 1] - z0) / DOOR_CELL) * w + Math.floor((pts[i * 2] - x0) / DOOR_CELL);
    const start = new Int32Array(w * h + 1);
    for (let i = 0; i < n; i++) start[cell(i) + 1]++;
    for (let c = 0; c < w * h; c++) start[c + 1] += start[c];
    const fill = start.slice(0, w * h), idx = new Int32Array(n);
    for (let i = 0; i < n; i++) idx[fill[cell(i)]++] = i;
    this.doorStart = start; this.doorIdx = idx;
  }

  /** A door within DOOR_CELL of (x, z) (a random one of the nearest cells), or −1. */
  private doorNear(x: number, z: number): number {
    if (!this.doorW) return -1;
    const cx = Math.floor((x - this.doorX0) / DOOR_CELL), cz = Math.floor((z - this.doorZ0) / DOOR_CELL);
    let best = -1, bd = DOOR_CELL * DOOR_CELL, seen = 0;
    for (let j = cz - 1; j <= cz + 1; j++) for (let i = cx - 1; i <= cx + 1; i++) {
      if (i < 0 || j < 0 || i >= this.doorW || j >= this.doorH) continue;
      for (let k = this.doorStart[j * this.doorW + i]; k < this.doorStart[j * this.doorW + i + 1]; k++) {
        const d = this.doorIdx[k], dd = (this.doors[d * 2] - x) ** 2 + (this.doors[d * 2 + 1] - z) ** 2;
        // among the doors in reach, one at random (reservoir), so the same door is not the only one ever used
        if (dd < bd && this.rng.next() * ++seen < 1) best = d;
      }
    }
    return best;
  }

  constructor(sim: SimNet) {
    this.sim = sim;
    this.router = new Router(sim);
    this.t.onGrow((cap) => {
      const r = new Int32Array(cap * ROUTE); r.set(this.routes); this.routes = r;
      const w = new Float32Array(cap * WAYS * 4); w.set(this.ways); this.ways = w;
      const n = new Int32Array(cap); n.set(this.wayNode); this.wayNode = n;
      const f = new Float32Array(cap * 3); f.set(this.lineFrom); this.lineFrom = f;
    });
    sim.net.nodes.onGrow((cap) => {
      const h = new Int32Array(cap).fill(-1); h.set(this.head); this.head = h;
    });
  }

  get count(): number { return this.t.size; }
  /** The population the current street length, density and player share demand (the guard is only a runaway limit). */
  get demand(): number { return Math.min(PEDS_GUARD, Math.floor(this.sim.laneMeters * this.density * this.share)); }
  /** The runaway guard, exposed so the demand is never confused with a fixed population ceiling. */
  get limit(): number { return PEDS_GUARD; }

  // ------------------------------------------------------------ event queue

  private schedule(p: number, at: number): void {
    // an invalid time would sit on top of the queue and stop every pedestrian's events for good: whoever got one
    // leaves (fading out from where it stands) instead
    if (!Number.isFinite(at)) { this.invalid++; this.fadeOut(p, true); return; }
    this.t.cols.at[p] = at;
    if (this.heapN >= this.heapT.length) {
      const a = new Float64Array(this.heapT.length * 2); a.set(this.heapT); this.heapT = a;
      const b = new Int32Array(this.heapP.length * 2); b.set(this.heapP); this.heapP = b;
    }
    let i = this.heapN++;
    while (i > 0) {
      const q = (i - 1) >> 1;
      if (this.heapT[q] <= at) break;
      this.heapT[i] = this.heapT[q]; this.heapP[i] = this.heapP[q]; i = q;
    }
    this.heapT[i] = at; this.heapP[i] = p;
  }

  private popEvent(): void {
    const lt = this.heapT[--this.heapN], lp = this.heapP[this.heapN];
    let i = 0;
    for (;;) {
      let c = i * 2 + 1;
      if (c >= this.heapN) break;
      if (c + 1 < this.heapN && this.heapT[c + 1] < this.heapT[c]) c++;
      if (this.heapT[c] >= lt) break;
      this.heapT[i] = this.heapT[c]; this.heapP[i] = this.heapP[c]; i = c;
    }
    this.heapT[i] = lt; this.heapP[i] = lp;
  }

  /**
   * Is anyone walking a crossing over one of node `n`'s arms in `mask` within `r` m of (x, z)? A vehicle waits only
   * for those on the part of the zebra it drives over (roadcraft intersections/crossingSpans.ts).
   */
  crossingNear(n: number, mask: number, x: number, z: number, r: number): boolean {
    const c = this.t.cols;
    for (let p = this.head[n]; p >= 0; p = c.next[p]) {
      if (c.mode[p] !== 1) continue;
      const w = c.wIdx[p] - 1;
      const cross = w >= 0 ? this.ways[p * WAYS * 4 + w * 4 + 3] : 0;
      if (cross <= 0 || (mask & (1 << (cross - 1))) === 0) continue;
      const q = this.posShown(p);
      if (Math.abs(q[0] - x) < r && Math.abs(q[2] - z) < r && Math.hypot(q[0] - x, q[2] - z) < r) return true;
    }
    return false;
  }

  /** Is anyone on the node's crosswalk right now (walking the crossing leg)? */
  crossing(n: number): boolean { return this.crossingArms(n, 0xff); }

  /** Is anyone walking a crossing over one of the node's arms in `mask` (bit per arm)? */
  crossingArms(n: number, mask: number): boolean {
    const c = this.t.cols;
    for (let p = this.head[n]; p >= 0; p = c.next[p]) {
      // walking the crossing line (standing, it is at a kerb: waiting to start one, or done with the last)
      if (c.mode[p] !== 1) continue;
      const w = c.wIdx[p] - 1;
      const cross = w >= 0 ? this.ways[p * WAYS * 4 + w * 4 + 3] : 0;
      if (cross > 0 && (mask & (1 << (cross - 1))) !== 0) return true;
    }
    return false;
  }

  // ------------------------------------------------------------ per-node lists

  private link(p: number, n: number): void {
    const c = this.t.cols;
    c.node[p] = n; c.prev[p] = -1; c.next[p] = this.head[n];
    if (this.head[n] >= 0) c.prev[this.head[n]] = p;
    this.head[n] = p;
  }

  private unlink(p: number): void {
    const c = this.t.cols, n = c.node[p];
    if (n < 0) return;
    if (c.prev[p] >= 0) c.next[c.prev[p]] = c.next[p]; else if (this.head[n] === p) this.head[n] = c.next[p];
    if (c.next[p] >= 0) c.prev[c.next[p]] = c.prev[p];
    c.node[p] = -1;
  }

  // ------------------------------------------------------------ spawning and removal

  private randomNode(): number {
    const net = this.sim.net, t = net.nodes, sc = net.segs.cols;
    for (let i = 0; i < 12; i++) {
      const n = this.rng.int(0, t.end);
      if (!t.alive[n] || t.cols.deg[n] === 0) continue;
      // more people where there is commerce
      let pull = 0;
      for (let k = 0; k < t.cols.deg[n]; k++) {
        const s = net.adj[n * MAX_DEG + k];
        pull = Math.max(pull, ZONE_PULL[baseZone(sc.zl[s])] ?? 0.1, ZONE_PULL[baseZone(sc.zr[s])] ?? 0.1);
      }
      if (this.rng.next() < pull) return n;
    }
    return -1;
  }

  /** Random bus trip (from traffic): [line, boarding stop, alighting stop, boarding node]. */
  pickTrip: () => [number, number, number, number, number, number] | null = () => null;
  /** Reached the stop at (x, z): starts waiting for the bus (tracked by traffic). */
  onStop: (line: number, from: number, to: number, x: number, z: number) => void = () => {};

  /** People stepping off a bus at the stop (x, z): each walks from there to the sidewalk and on. */
  spawnFromStop(x: number, z: number, count: number): void {
    // out of five places along the kerb 0.8 m apart (the bus's doors), not all out of one point; those after the first
    // five step off behind them (`spaced`: the same stretch from the same spot waits for a gap)
    for (let k = 0; k < count; k++) this.spawnFromPoint(x, z, ((k % 5) - 2) * 0.8);
  }
  /** Share of walkers who take the bus (when there are lines). */
  transitShare = 0.3;

  /** Got off the bus at the node: they walk on to a nearby destination. */
  spawnAt(node: number, count: number, color = -1): void {
    for (let k = 0; k < count && this.t.size < PEDS_GUARD; k++) {
      this.nextColor = color;
      this.spawnFrom(node, 600, -1, 0, 0, 0);
    }
    this.nextColor = -1;
  }

  /** Colour of the next person (people creator); −1 = random. */
  private nextColor = -1;

  /**
   * Removes everyone within `r` metres of (x, z), only in the lists of nearby nodes (never the whole
   * crowd). Returns how many. `one`: only the closest (pistol).
   */
  hit(x: number, z: number, r: number, one: boolean): number {
    const net = this.sim.net, c = this.t.cols;
    const near: number[] = [];
    net.nodeIndex.query(x - r - 120, z - r - 120, x + r + 120, z + r + 120, (n) => near.push(n));
    let best = -1, bd = r, n0 = 0;
    const doomed: number[] = [];
    for (const n of near) for (let p = this.head[n]; p >= 0; p = c.next[p]) {
      if (!c.has[p] || c.mode[p] === 4) continue;
      const d = Math.hypot(c.px[p] - x, c.pz[p] - z);
      if (d > r) continue;
      if (one) { if (d < bd) { bd = d; best = p; } } else doomed.push(p);
    }
    if (one && best >= 0) doomed.push(best);
    // they drop out of sight over a moment (fading where they stood), not in a blink
    for (const p of doomed) { this.fadeOut(p); n0++; }
    return n0;
  }

  private spawn(): void {
    // some walk to a stop, take the bus and get off far away
    if (this.rng.next() < this.transitShare) {
      const trip = this.pickTrip();
      if (trip) {
        const [li, from, to, stopNode, sx, sz] = trip;
        const net = this.sim.net, nc = net.nodes.cols;
        if (!net.nodes.alive[stopNode]) return;
        const a = this.nodeAround(nc.x[stopNode], nc.z[stopNode], 60, 500);
        // the last stretch is the stop's own segment, walked on the stop's side up to the stop
        const seg = this.stopSegment(stopNode, sx, sz);
        const far = seg < 0 ? -1 : net.segs.cols.a[seg] === stopNode ? net.segs.cols.b[seg] : net.segs.cols.a[seg];
        if (a >= 0 && a !== stopNode && far >= 0) this.spawnRoute(a, stopNode, li, from, to, 0, sx, sz, far);
        return;
      }
    }
    // where someone is born is drawn over the whole city; near the camera, where the page sent the buildings' doors,
    // they step out of a door next to that node (roadcraft `lotDoors`) instead of appearing on the sidewalk
    const a = this.randomNode();
    if (a < 0) return;
    if (this.rng.next() < BIKE_SHARE && this.spawnBike(a)) return;
    const nc = this.sim.net.nodes.cols, door = this.doorNear(nc.x[a], nc.z[a]);
    if (door >= 0 && this.spawnFromPoint(this.doors[door * 2], this.doors[door * 2 + 1])) return;
    this.spawnFrom(a, 900, -1, 0, 0, this.rng.next());
  }

  /** Someone starts walking at (x, z) (a door, or a passenger getting out of a car at the kerb): to the sidewalk, then on. */
  /** `along`: starts that many metres along the street from (x, z). */
  spawnFromPoint(x: number, z: number, along = 0): boolean {
    if (this.t.size >= PEDS_GUARD) return false;
    const net = this.sim.net, sc = net.segs.cols, nc = net.nodes.cols, sim = this.sim;
    let hit = net.nearestSeg(x, z, 30, (s) => PROFILE_INFO[sc.profile[s]].walk);
    if (!hit) return false;
    if (along) {
      net.quad(hit[0], qd); bezD(qd, hit[1], d2);
      const dl = Math.hypot(d2[0], d2[1]) || 1;
      x += d2[0] / dl * along; z += d2[1] / dl * along;
      hit = net.nearestSeg(x, z, 30, (s) => PROFILE_INFO[sc.profile[s]].walk);
      if (!hit) return false;
    }
    const [s, t] = hit;
    const q = net.quad(s);
    bez(q, t, p2); bezD(q, t, d2);
    const l = Math.hypot(d2[0], d2[1]) || 1, dx = d2[0] / l, dz = d2[1] / l;
    // side of the door (u+ = left of a→b) and the sidewalk point on that side
    const sideSign = (x - p2[0]) * dz - (z - p2[1]) * dx > 0 ? 1 : -1;
    const [u, side] = this.sideU(sc.profile[s], sideSign);
    const L = sim.segLen(s), r0 = sim.segS0(s), r1 = sim.segS1(s), dA = Math.max(r0, Math.min(r1, t * L));
    // walk towards the end closest to the destination
    const n0a = sc.a[s], n0b = sc.b[s];
    const b = this.nodeAround(x, z, 150, 900);
    if (b < 0) return false;
    const towardB = Math.hypot(nc.x[n0b] - nc.x[b], nc.z[n0b] - nc.z[b]) < Math.hypot(nc.x[n0a] - nc.x[b], nc.z[n0a] - nc.z[b]);
    const from = towardB ? n0a : n0b, to = towardB ? n0b : n0a;
    const p = this.t.alloc();
    const c = this.t.cols;
    const r = p * ROUTE;
    this.routes[r] = from;
    const len = this.router.route(to, b, this.routes, r + 1, ROUTE - 1, true);
    if (len < 1 || this.routes[r + len] !== b) { this.t.release(p); return false; }
    c.rLen[p] = len + 1; c.rIdx[p] = 0; c.node[p] = -1; c.has[p] = 0;
    c.speed[p] = PACE[this.rng.int(0, 2)];
    c.color[p] = this.rng.int(0, 16); c.look[p] = this.rng.int(0, 65536);
    c.side[p] = side;
    c.tLine[p] = -1; c.tFrom[p] = 0; c.tTo[p] = 0; c.tx[p] = NaN; c.tz[p] = NaN;
    c.bike[p] = 0; c.lat[p] = c.latT[p] = c.hold[p] = 0; c.pace[p] = 1; c.vNow[p] = c.speed[p]; c.aimAt[p] = -1e9;
    c.seg[p] = s;
    c.enter[p] = Math.max(0, Math.min(0.98, (towardB ? dA - r0 : r1 - dA) / Math.max(0.5, r1 - r0)));
    // straight line from the door to the sidewalk
    const y = nc.y[sc.a[s]] + (nc.y[sc.b[s]] - nc.y[sc.a[s]]) * (dA / Math.max(1e-6, L)) + CURB;
    this.lineFrom[p * 3] = x; this.lineFrom[p * 3 + 1] = y; this.lineFrom[p * 3 + 2] = z;
    const o = p * WAYS * 4;
    this.ways[o] = p2[0] + dz * u; this.ways[o + 1] = y; this.ways[o + 2] = p2[1] - dx * u; this.ways[o + 3] = 0;
    c.pyaw[p] = Math.atan2(this.ways[o] - x, this.ways[o + 2] - z);
    c.wIdx[p] = 0; c.wLen[p] = 1; c.mode[p] = 3;
    this.wayNode[p] = from;
    this.unlink(p);
    this.link(p, to);
    if (!this.nextWay(p)) { this.kill(p); return false; }
    return true;
  }

  /**
   * Cyclist: leaves `a` along a segment with a bike lane and follows the bike lanes (preferably straight on) until they
   * end or BIKE_LEGS segments. Route without the router: a wander that fits in the person's node list.
   */
  private spawnBike(a: number): boolean {
    const net = this.sim.net, sc = net.segs.cols, nc = net.nodes.cols;
    const segs = net.segsOf(a, []).filter((s) => !Number.isNaN(bikeU(sc.profile[s], 1)));
    if (!segs.length) return false;
    const p = this.t.alloc();
    const c = this.t.cols;
    const r = p * ROUTE;
    let at = a, s = segs[this.rng.int(0, segs.length)], len = 0;
    this.routes[r + len++] = at;
    while (len < Math.min(ROUTE, BIKE_LEGS + 1)) {
      const next = sc.a[s] === at ? sc.b[s] : sc.a[s];
      this.routes[r + len++] = next;
      // straightest exit with a bike lane (a little randomness to spread them out)
      const q = net.quad(s);
      const inx = sc.a[s] === next ? q.x0 - q.cx : q.x1 - q.cx, inz = sc.a[s] === next ? q.z0 - q.cz : q.z1 - q.cz;
      const il = Math.hypot(inx, inz) || 1;
      let best = -1, bestScore = -Infinity;
      for (const o of net.segsOf(next, [])) {
        if (o === s || Number.isNaN(bikeU(sc.profile[o], 1))) continue;
        const oq = net.quad(o);
        const ox = sc.a[o] === next ? oq.cx - oq.x0 : oq.cx - oq.x1, oz = sc.a[o] === next ? oq.cz - oq.z0 : oq.cz - oq.z1;
        const score = (inx * ox + inz * oz) / (il * (Math.hypot(ox, oz) || 1)) + this.rng.next() * 0.6;
        if (score > bestScore) { bestScore = score; best = o; }
      }
      if (best < 0) break;
      at = next; s = best;
    }
    if (len < 2 || !nc.deg[a]) { this.t.release(p); return false; }
    c.rLen[p] = len; c.rIdx[p] = 0; c.node[p] = -1; c.has[p] = 0;
    c.speed[p] = 4 + this.rng.next() * 1.6;
    c.color[p] = this.rng.int(0, 16); c.look[p] = this.rng.int(0, 65536);
    c.side[p] = 1;
    c.tLine[p] = -1; c.tFrom[p] = 0; c.tTo[p] = 0;
    c.bike[p] = 1; c.enter[p] = 0; c.lat[p] = c.latT[p] = c.hold[p] = 0; c.pace[p] = 1; c.vNow[p] = c.speed[p]; c.aimAt[p] = -1e9;
    if (!this.startSidewalk(p, this.rng.next())) { this.kill(p); return false; }
    return true;
  }

  /**
   * A node between `rMin` and `rMax` metres from (x, z), uniform over the area: the node nearest to a random point
   * of the ring (a small query each try). A list of the nodes in the box, cut at a few hundred, came out in the
   * index's order, south first. −1 if none in a few tries.
   */
  private nodeAround(x: number, z: number, rMin: number, rMax: number): number {
    const net = this.sim.net, nc = net.nodes.cols;
    for (let i = 0; i < 8; i++) {
      const ang = this.rng.next() * Math.PI * 2, r = Math.sqrt(rMin * rMin + this.rng.next() * (rMax * rMax - rMin * rMin));
      const n = net.nearestNode(x + Math.cos(ang) * r, z + Math.sin(ang) * r, 90);
      if (n < 0 || nc.deg[n] === 0) continue;
      const d = Math.hypot(nc.x[n] - x, nc.z[n] - z);
      if (d >= rMin && d <= rMax) return n;
    }
    return -1;
  }

  /** Spawns at `a` and walks to a random node up to `radius` metres away. */
  private spawnFrom(a: number, radius: number, li: number, from: number, to: number, frac: number): void {
    const net = this.sim.net, nc = net.nodes.cols;
    if (!net.nodes.alive[a]) return;
    const b = this.nodeAround(nc.x[a], nc.z[a], 150, radius);
    if (b < 0 || b === a) return;
    this.spawnRoute(a, b, li, from, to, frac);
  }

  /**
   * A person walking from `a` to `b` (for a bus trip when `li` >= 0, to the stop at (`sx`, `sz`) on the segment from `b`
   * to `far`: the route ends along it); returns its id, or −1.
   */
  private spawnRoute(a: number, b: number, li: number, from: number, to: number, frac = 0, sx = NaN, sz = NaN, far = -1): number {
    const p = this.t.alloc();
    const c = this.t.cols;
    let len = this.router.route(a, b, this.routes, p * ROUTE, ROUTE, true);
    if (len < 2 || this.routes[p * ROUTE + len - 1] !== b) { this.t.release(p); return -1; }
    // to a stop: on along its segment unless the route already came along it
    if (far >= 0 && this.routes[p * ROUTE + len - 2] !== far) {
      if (len >= ROUTE) { this.t.release(p); return -1; }
      this.routes[p * ROUTE + len++] = far;
    }
    c.rLen[p] = len; c.rIdx[p] = 0; c.node[p] = -1; c.has[p] = 0;
    c.speed[p] = PACE[this.rng.int(0, 2)];
    c.color[p] = this.nextColor >= 0 ? this.nextColor : this.rng.int(0, 16); c.look[p] = this.rng.int(0, 65536);
    c.side[p] = this.rng.next() < 0.5 ? 1 : -1;
    c.tLine[p] = li; c.tFrom[p] = from; c.tTo[p] = to; c.tx[p] = sx; c.tz[p] = sz;
    c.bike[p] = 0; c.enter[p] = 0; c.lat[p] = c.latT[p] = c.hold[p] = 0; c.pace[p] = 1; c.vNow[p] = c.speed[p]; c.aimAt[p] = -1e9;
    // `frac` > 0: starts part-way along the first segment, so the city starts out full
    if (!this.startSidewalk(p, frac)) { this.kill(p); return -1; }
    return p;
  }

  private kill(p: number): void {
    this.unlink(p);
    this.t.cols.at[p] = -1;
    this.t.release(p);
  }

  // ------------------------------------------------------------ walking

  private segBetween(a: number, b: number): number {
    const net = this.sim.net, sc = net.segs.cols;
    const d = net.nodes.cols.deg[a];
    for (let k = 0; k < d; k++) {
      const s = net.adj[a * MAX_DEG + k];
      if (s >= 0 && ((sc.a[s] === a && sc.b[s] === b) || (sc.b[s] === a && sc.a[s] === b))) return s;
    }
    return -1;
  }

  /** u of the sidewalk on the requested side (or the other side, if that one has none). */
  /**
   * Where person `p` walks across sidewalk `side` of a street of `profile` going in direction `dir` (+1 = a → b):
   * right of the middle, by its pace's track (u+ is the left of a → b, so walking a → b the right is u−).
   */
  private trackU(p: number, profile: number, side: number, dir: number): number {
    const [u] = this.sideU(profile, side);
    return u - dir * this.trackOff(p, profile, u);
  }

  /** How far right of the middle of the sidewalk at `u` person `p` walks: its pace's track, within the width. */
  private trackOff(p: number, profile: number, u: number): number {
    let half = 1.5;
    for (const e of PROFILE_INFO[profile].edges) if (e.strip.kind === 'sidewalk' && u >= e.u0 && u <= e.u1) half = (e.u1 - e.u0) / 2;
    const band = this.t.cols.speed[p] > 1.35 ? 0 : 1, room = Math.max(0.1, half - 0.35);
    return Math.min(TRACK[band], band === 0 ? room * 0.3 : room);
  }

  /**
   * Spacing at the start of a stretch: someone who started the same one (`key`) less than START_GAP ago from the same
   * spot would walk inside them all the way, at the same pace on the same track. Returns false (and has `p` wait out
   * the gap where it stands) when it must wait.
   */
  private spaced(p: number, key: number): boolean {
    const h = (Math.imul(key, 2654435761) >>> 0) % STARTS;
    if (this.startKey[h] === key && this.time - this.startT[h] < START_GAP) {
      // it stands where it is seen (its step aside kept)
      const c = this.t.cols, q = this.posShown(p);
      this.lineFrom[p * 3] = q[0]; this.lineFrom[p * 3 + 1] = q[1]; this.lineFrom[p * 3 + 2] = q[2];
      c.pyaw[p] = q[3]; c.lat[p] = c.latT[p] = 0;
      c.mode[p] = 2; c.t0[p] = this.time; c.dur[p] = START_GAP;
      this.schedule(p, this.startT[h] + START_GAP + 0.01);
      return false;
    }
    this.startKey[h] = key; this.startT[h] = this.time;
    return true;
  }

  /** A stretch's key: its start and end to 0.25 m, and the pace (the other pace walks another track). */
  private stretchKey(p: number, x0: number, z0: number, x1: number, z1: number): number {
    const q = (v: number) => Math.round(v * 4) | 0;
    let h = Math.imul(q(x0), 73856093) ^ Math.imul(q(z0), 19349663) ^ Math.imul(q(x1), 83492791) ^ Math.imul(q(z1), 2971215073 | 0);
    if (this.t.cols.speed[p] > 1.35) h = ~h;
    return h & 0x7fffffff;
  }

  private sideU(profile: number, side: number): [number, number] {
    const s = PROFILE_INFO[profile];
    if (side > 0) return Number.isNaN(s.walkLeft) ? [s.walkRight, -1] : [s.walkLeft, 1];
    return Number.isNaN(s.walkRight) ? [s.walkLeft, 1] : [s.walkRight, -1];
  }

  /** Enters the sidewalk of the segment between route[rIdx] and route[rIdx + 1]. `frac` > 0 starts part-way. */
  /** `spacedStart`: arriving at it from a line (`nextWay`), it keeps a gap from whoever just started it. */
  private startSidewalk(p: number, frac = 0, spacedStart = false): boolean {
    const c = this.t.cols, sim = this.sim, sc = sim.net.segs.cols;
    // someone who left a door enters mid-segment (where the line from the door arrived)
    if (frac === 0 && c.enter[p] > 0) frac = c.enter[p];
    const i = c.rIdx[p];
    if (i + 1 >= c.rLen[p]) return false;
    const n0 = this.routes[p * ROUTE + i], n1 = this.routes[p * ROUTE + i + 1];
    if (!sim.net.nodes.alive[n0] || !sim.net.nodes.alive[n1]) return false;
    const s = this.segBetween(n0, n1);
    if (s < 0 || (c.bike[p] ? Number.isNaN(bikeU(sc.profile[s], 1)) : !PROFILE_INFO[sc.profile[s]].walk)) return false;
    // a bus rider's last stretch: the stop's side, up to the stop
    const toStop = this.toStop(p, s) ? this.stopAt : null;
    if (toStop) c.side[p] = toStop[1];
    if (!c.bike[p]) {
      const [, side] = this.sideU(sc.profile[s], c.side[p]);
      c.side[p] = side;
    }
    const r0 = sim.segS0(s), r1 = sim.segS1(s);
    const fromA = sc.a[s] === n0;
    // the same sidewalk from the same spot at the same pace as someone just before: a moment's gap first
    if (spacedStart && !c.bike[p] && frac === 0 && !this.spaced(p, this.stretchKey(p, s, c.side[p], fromA ? 1 : -1, n1))) return true;
    this.seenNow(p);
    c.enter[p] = 0;
    c.seg[p] = s;
    c.da[p] = fromA ? r0 : r1;
    c.db[p] = toStop ? Math.max(r0, Math.min(r1, toStop[0])) : fromA ? r1 : r0;
    c.mode[p] = 0;
    const dur = Math.abs(c.db[p] - c.da[p]) / c.speed[p];
    c.dur[p] = Math.max(0.1, dur);
    c.t0[p] = this.time - frac * c.dur[p];
    if (!c.bike[p]) this.keepSeen(p, frac === 0);
    this.unlink(p);
    this.link(p, n1);
    this.schedule(p, c.t0[p] + c.dur[p]);
    return true;
  }

  /** The segment of node `n` the stop at (x, z) stands beside (its curve nearest), or −1. */
  private stopSegment(n: number, x: number, z: number): number {
    const net = this.sim.net;
    let best = -1, bd = Infinity;
    for (const s of net.segsOf(n, [])) {
      const [, d] = closestT(net.quad(s), x, z);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  /**
   * Is segment `s` the last of bus rider `p`'s way, to its stop? If so `stopAt` holds the stop's distance along it (m
   * from node a) and the side of its sidewalk (+1: u+, the left of a → b).
   */
  private toStop(p: number, s: number): boolean {
    const c = this.t.cols;
    if (c.tLine[p] < 0 || Number.isNaN(c.tx[p]) || c.rIdx[p] + 2 !== c.rLen[p] || s < 0) return false;
    const net = this.sim.net, q = net.quad(s), [t] = closestT(q, c.tx[p], c.tz[p]);
    bez(q, t, p2); bezD(q, t, d2);
    this.stopAt[0] = this.sim.sAlong(s, t);
    // u+ lies along (dz, −dx) of the curve's direction (`posNow`)
    this.stopAt[1] = (c.tx[p] - p2[0]) * d2[1] - (c.tz[p] - p2[1]) * d2[0] >= 0 ? 1 : -1;
    return true;
  }
  private stopAt = new Float64Array(2);

  /** Reached node route[rIdx + 1]: builds the waypoints to go around/cross to the next segment. */
  private atNode(p: number): boolean {
    const c = this.t.cols, sim = this.sim, net = sim.net, sc = net.segs.cols;
    c.rIdx[p]++;
    const i = c.rIdx[p];
    if (i + 1 >= c.rLen[p]) {
      // arrived at the stop's corner: those taking the bus walk the last metres to the stop and wait there
      if (c.tLine[p] >= 0 && !Number.isNaN(c.tx[p])) {
        const here = this.posShown(p);
        this.lineFrom[p * 3] = here[0]; this.lineFrom[p * 3 + 1] = here[1]; this.lineFrom[p * 3 + 2] = here[2];
        c.lat[p] = c.latT[p] = 0;
        const o = p * WAYS * 4;
        this.ways[o] = c.tx[p]; this.ways[o + 1] = here[1]; this.ways[o + 2] = c.tz[p]; this.ways[o + 3] = 0;
        c.mode[p] = 3; c.wIdx[p] = 0; c.wLen[p] = 1;
        return this.nextWay(p);
      }
      if (c.tLine[p] >= 0) { const q = this.posNow(p); this.onStop(c.tLine[p], c.tFrom[p], c.tTo[p], q[0], q[2]); }
      return false;
    }
    const n = this.routes[p * ROUTE + i];
    let nNext = this.routes[p * ROUTE + i + 1];
    const sIn = c.seg[p];
    let sOut = this.segBetween(n, nNext);
    if (c.bike[p]) return this.bikeThrough(p, n, sIn, sOut);
    const usable = (s: number) => s >= 0 && net.segs.alive[s] && PROFILE_INFO[sc.profile[s]].walk;
    if (!usable(sOut) || !net.segs.alive[sIn]) {
      // the way ahead (or the sidewalk just walked) was demolished: a new route from this corner to where they were
      // going; with none, they leave (fading out)
      if (!this.reroute(p, n)) return this.fadeOut(p);
      if (!net.segs.alive[sIn]) return this.startSidewalk(p);
      nNext = this.routes[p * ROUTE + 1];
      sOut = this.segBetween(n, nNext);
      if (!usable(sOut)) return this.fadeOut(p);
    }
    // start point = end of the sidewalk just finished, where it is seen (its step aside is now part of the line)
    const here = this.posShown(p);
    this.lineFrom[p * 3] = here[0]; this.lineFrom[p * 3 + 1] = here[1]; this.lineFrom[p * 3 + 2] = here[2];
    c.pyaw[p] = here[3];
    c.lat[p] = c.latT[p] = 0;
    c.mode[p] = 3;
    // node arms in counter-clockwise order (the same as traffic and the traffic lights)
    const segs = net.segsOf(n, []);
    const deg = segs.length;
    const angle = segs.map((s) => { const a = armOf(net.quad(s), sc.profile[s], sc.a[s] === n ? 0 : 1); return armAngle(a.dx, a.dz); });
    const order = segs.map((_, k) => k).sort((x, y) => angle[x] - angle[y]);
    const rank = new Array<number>(deg);
    order.forEach((k, r) => { rank[k] = r; });
    const ai = rank[segs.indexOf(sIn)], aj = rank[segs.indexOf(sOut)];
    const endIn = sc.a[sIn] === n ? 0 : 1;
    const armLeftIn = endIn === 0 ? c.side[p] > 0 : c.side[p] < 0;
    const ci = armLeftIn ? ai : (ai - 1 + deg) % deg;
    // target corner: left (aj) or right (aj − 1) of the exit arm; fewest crossings
    const opts = [aj, (aj - 1 + deg) % deg].map((cj) => {
      const ccw = (cj - ci + deg) % deg, cw = (ci - cj + deg) % deg;
      return { cj, steps: Math.min(ccw, cw), dir: ccw <= cw ? 1 : -1 };
    });
    // tie: fixed per-person draw (half cross before, half after); at a mid-block crosswalk, half cross
    const mid = deg === 2 && (sim.nodeCtl[n] === 9 || sim.nodeCtl[n] === 10);
    const want = mid && ((p + n) & 1) === 0;
    let pick = mid ? (opts.find((o) => (o.steps > 0) === want) ?? opts[0]) : opts[0].steps < opts[1].steps || (opts[0].steps === opts[1].steps && (p & 1) === 0) ? opts[0] : opts[1];
    // a bus rider onto the stop's segment: the corner on the stop's side (it crosses here, at the crosswalk, not to
    // the stop over the carriageway)
    if (i + 2 === c.rLen[p] && this.toStop(p, sOut)) {
      const endOut0 = sc.a[sOut] === n, leftOut = endOut0 ? this.stopAt[1] > 0 : this.stopAt[1] < 0;
      pick = opts.find((o) => o.cj === (leftOut ? aj : (aj - 1 + deg) % deg)) ?? pick;
    }
    let w = 0;
    const base = p * WAYS * 4;
    const put = (x: number, y: number, z: number, cross: number) => {
      if (w >= WAYS) return;
      const o = base + w * 4;
      this.ways[o] = x; this.ways[o + 1] = y; this.ways[o + 2] = z; this.ways[o + 3] = cross;
      w++;
    };
    const tmp = new Float64Array(3);
    let cur = ci;
    for (let k = 0; k < pick.steps && w + 2 < WAYS; k++) {
      // counter-clockwise: cross arm cur+1 from right to left; clockwise: arm cur, from left to right
      const arm = pick.dir > 0 ? (cur + 1) % deg : cur;
      const s = segs[order[arm]];
      const end = sc.a[s] === n ? 0 : 1;
      const d = (end === 0 ? sim.segS0(s) : sim.segLen(s) - sim.segS1(s)) + CROSS_AT;
      const fromLeft = pick.dir < 0;
      this.armPoint(s, end, d, fromLeft, tmp, false); put(tmp[0], tmp[1], tmp[2], 0);
      this.armPoint(s, end, d, !fromLeft, tmp, false); put(tmp[0], tmp[1], tmp[2], arm + 1);
      cur = pick.dir > 0 ? (cur + 1) % deg : (cur - 1 + deg) % deg;
    }
    // end of the exit sidewalk, on the side of the final corner
    const endOut = sc.a[sOut] === n ? 0 : 1;
    const armLeftOut = pick.cj === aj;
    const dOut = endOut === 0 ? sim.segS0(sOut) : sim.segLen(sOut) - sim.segS1(sOut);
    // on the exit sidewalk's track (walking away from the node), where the sidewalk walk starts
    this.armPoint(sOut, endOut, dOut, armLeftOut, tmp, true, p, endOut === 0 ? 1 : -1);
    put(tmp[0], tmp[1], tmp[2], 0);
    c.side[p] = endOut === 0 ? (armLeftOut ? 1 : -1) : (armLeftOut ? -1 : 1);
    this.keepRight(p, w);
    this.wayNode[p] = n;
    c.wIdx[p] = 0; c.wLen[p] = w;
    c.seg[p] = sOut;
    this.unlink(p);
    this.link(p, n);
    return this.nextWay(p);
  }

  /** Cyclist at a node: a straight line from the end of the incoming bike lane to the start of the outgoing one (through the junction, like a car). */
  private bikeThrough(p: number, n: number, sIn: number, sOut: number): boolean {
    const c = this.t.cols, sim = this.sim, net = sim.net, sc = net.segs.cols;
    if (sOut < 0 || !net.segs.alive[sIn] || Number.isNaN(bikeU(sc.profile[sOut], 1))) return false;
    const here = this.posNow(p);
    this.lineFrom[p * 3] = here[0]; this.lineFrom[p * 3 + 1] = here[1]; this.lineFrom[p * 3 + 2] = here[2];
    c.pyaw[p] = here[3];
    const fromA = sc.a[sOut] === n, d = fromA ? sim.segS0(sOut) : sim.segS1(sOut);
    const dir = fromA ? 1 : -1;
    const t = sim.tAt(sOut, d), q = net.quad(sOut);
    bez(q, t, p2); bezD(q, t, d2);
    const l = Math.hypot(d2[0], d2[1]) || 1, dx = d2[0] / l, dz = d2[1] / l, u = bikeU(sc.profile[sOut], dir);
    const nc = net.nodes.cols, ya = nc.y[sc.a[sOut]], yb = nc.y[sc.b[sOut]], L = sim.segLen(sOut);
    const o = p * WAYS * 4;
    this.ways[o] = p2[0] + dz * u; this.ways[o + 2] = p2[1] - dx * u;
    this.ways[o + 1] = ya + (yb - ya) * (d / Math.max(1e-6, L)) + 0.02;
    this.ways[o + 3] = 0;
    this.wayNode[p] = n;
    c.wIdx[p] = 0; c.wLen[p] = 1;
    c.seg[p] = sOut;
    this.unlink(p);
    this.link(p, n);
    return this.nextWay(p);
  }

  /** Point on an arm's sidewalk (or crosswalk), d metres from the node, on the arm's left/right side. */
  /** `who` ≥ 0: on that person's track along the sidewalk, walking in direction `dir` of the segment. */
  private armPoint(s: number, end: 0 | 1, d: number, armLeft: boolean, out: Float64Array, sidewalk: boolean, who = -1, dir = 1): void {
    const sim = this.sim, net = sim.net, sc = net.segs.cols, nc = net.nodes.cols;
    const L = sim.segLen(s);
    const fromA = end === 0 ? d : L - d;
    // arm's left in segment coordinates (u+ = left of a→b)
    const segLeft = end === 0 ? armLeft : !armLeft;
    let [u] = this.sideU(sc.profile[s], segLeft ? 1 : -1);
    // an arm with no sidewalk on either side (an expressway, a railway): the crossing ends at its kerb
    if (Number.isNaN(u)) { const info = PROFILE_INFO[sc.profile[s]]; u = segLeft ? info.left : -info.right; }
    else if (who >= 0) u -= dir * this.trackOff(who, sc.profile[s], u);
    const t = sim.tAt(s, Math.max(0, Math.min(L, fromA)));
    bez(net.quad(s), t, p2); bezD(net.quad(s), t, d2);
    const l = Math.hypot(d2[0], d2[1]) || 1;
    const dx = d2[0] / l, dz = d2[1] / l;
    out[0] = p2[0] + dz * u;
    out[2] = p2[1] - dx * u;
    const ya = nc.y[sc.a[s]], yb = nc.y[sc.b[s]];
    out[1] = ya + (yb - ya) * (fromA / Math.max(1e-6, L)) + (sidewalk ? CURB : 0.02);
  }

  /** Next waypoint (or the sidewalk, when they run out). */
  private nextWay(p: number): boolean {
    const c = this.t.cols;
    if (c.wIdx[p] >= c.wLen[p]) {
      // at the end of the route a bus rider has reached the stop: waits for the bus (tracked by traffic)
      if (c.rIdx[p] + 1 >= c.rLen[p] && c.tLine[p] >= 0) { const q = this.posNow(p); this.onStop(c.tLine[p], c.tFrom[p], c.tTo[p], q[0], q[2]); return false; }
      return this.startSidewalk(p, 0, true);
    }
    const o = p * WAYS * 4 + c.wIdx[p] * 4;
    const cross = this.ways[o + 3];
    // signalled crossing: waits for the light to let them walk (and calls it), one behind the other at the kerb
    if (cross > 0 && !this.walkOk(this.wayNode[p], cross - 1)) {
      this.onWait(this.wayNode[p], cross - 1);
      if (c.mode[p] !== 2) this.standToCross(p, o);
      c.mode[p] = 2;
      c.t0[p] = this.time; c.dur[p] = 1;
      this.schedule(p, this.time + 1);
      return true;
    }
    // a vehicle on the crosswalk or about to drive over it: waits for it to pass (looked at again in half a second)
    if (cross > 0 && this.carsOn(this.wayNode[p], cross - 1)) {
      if (c.mode[p] !== 2) this.standToCross(p, o);
      c.mode[p] = 2;
      c.t0[p] = this.time; c.dur[p] = 0.5;
      this.schedule(p, this.time + 0.5);
      return true;
    }
    // the next line starts where it is seen: the step aside of the line just walked is part of it
    const [x0, y0, z0, yaw0] = this.posShown(p);
    // the same stretch from the same spot at the same pace as someone just before: a moment's gap first
    if (!this.spaced(p, this.stretchKey(p, x0, z0, this.ways[o], this.ways[o + 2]))) return true;
    c.pyaw[p] = yaw0;
    const len = Math.hypot(this.ways[o] - x0, this.ways[o + 2] - z0);
    c.mode[p] = 1;
    c.lat[p] = c.latT[p] = 0;
    c.t0[p] = this.time;
    c.dur[p] = Math.max(0.05, len / c.speed[p]);
    // the start point is stored in the line's px/py/pz
    this.lineFrom[p * 3] = x0; this.lineFrom[p * 3 + 1] = y0; this.lineFrom[p * 3 + 2] = z0;
    c.wIdx[p]++;
    this.schedule(p, this.time + c.dur[p]);
    return true;
  }


  /**
   * Keeping right round the corner and across (roadcraft peds/sidewalk.ts stripes): the way from where `p` stands
   * through its first `w` − 1 waypoints is moved right of its own direction by the pace's track (mitred at each
   * turn), so people going the other way, or at the other pace, walk beside it and not through it. The start (on its
   * sidewalk track) and the last waypoint (on the exit sidewalk's track) stay.
   */
  private keepRight(p: number, w: number): void {
    const k = CROSS_TRACK[this.t.cols.speed[p] > 1.35 ? 0 : 1], o = p * WAYS * 4, W = this.ways;
    let px = this.lineFrom[p * 3], pz = this.lineFrom[p * 3 + 2];
    for (let i = 0; i + 1 < w; i++) {
      const x = W[o + i * 4], z = W[o + i * 4 + 2], nx = W[o + i * 4 + 4], nz = W[o + i * 4 + 6];
      // right of a heading (vx, vz) is (−vz, vx)
      let ax = x - px, az = z - pz, bx = nx - x, bz = nz - z;
      const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
      px = x; pz = z;
      if (la < 1e-3 && lb < 1e-3) continue;
      if (la < 1e-3) { ax = bx; az = bz; } else if (lb < 1e-3) { bx = ax; bz = az; }
      const ra = Math.hypot(ax, az), rb = Math.hypot(bx, bz);
      const mx = -az / ra - bz / rb, mz = ax / ra + bx / rb, ml = Math.hypot(mx, mz);
      if (ml < 1e-3) continue; // turning right back: no mitre
      // the mitre's length keeps the track's width on both legs (capped on sharp turns)
      const cos = (mx / ml) * (-az / ra) + (mz / ml) * (ax / ra), len = k / Math.max(0.5, cos);
      W[o + i * 4] = x + mx / ml * len; W[o + i * 4 + 2] = z + mz / ml * len;
    }
  }

  /**
   * Waiting to cross at the kerb: it stands where it is seen (its step aside, if any, kept), facing the crossing.
   * Near the camera those arriving behind it wait behind it (`seeEachOther`), so the people waiting form a queue.
   */
  private standToCross(p: number, o: number): void {
    const c = this.t.cols, q = this.posShown(p), vx = this.ways[o] - q[0], vz = this.ways[o + 2] - q[2];
    this.lineFrom[p * 3] = q[0]; this.lineFrom[p * 3 + 1] = q[1]; this.lineFrom[p * 3 + 2] = q[2];
    if (Math.abs(vx) + Math.abs(vz) > 1e-3) c.pyaw[p] = Math.atan2(vx, vz);
    c.lat[p] = c.latT[p] = 0;
  }

  /** Current position (x, y, z, heading). Modes: 0 sidewalk, 1 straight line, 2 waiting at a point, 3 standing at the start point. */
  private posNow(p: number, time = this.time): number[] {
    const c = this.t.cols, sim = this.sim, out = this.pos3;
    out[3] = c.pyaw[p];
    if (c.mode[p] === 2 || c.mode[p] === 3 || c.mode[p] === 4) {
      out[0] = this.lineFrom[p * 3]; out[1] = this.lineFrom[p * 3 + 1]; out[2] = this.lineFrom[p * 3 + 2];
      return out;
    }
    const f = Math.max(0, Math.min(1, (time - c.t0[p]) / c.dur[p]));
    if (c.mode[p] === 0) {
      const s = c.seg[p];
      const d = c.da[p] + (c.db[p] - c.da[p]) * f;
      const net = sim.net, sc = net.segs.cols, nc = net.nodes.cols;
      const q = net.quad(s);
      const L = sim.segLen(s);
      // a stretch may start a little past an end of the segment (where it was seen coming in, `keepSeen`): the
      // sidewalk goes on straight along the end's tangent there
      const dIn = Math.max(0, Math.min(L, d)), over = d - dIn;
      const t = sim.tAt(s, dIn);
      bez(q, t, p2); bezD(q, t, d2);
      const l = Math.hypot(d2[0], d2[1]) || 1;
      const dx = d2[0] / l, dz = d2[1] / l;
      const dir = c.db[p] >= c.da[p] ? 1 : -1;
      // cyclist: in the middle of the bike lane on its side; pedestrian: keeping right, on its pace's track
      const uu = c.bike[p] ? bikeU(sc.profile[s], dir) : this.trackU(p, sc.profile[s], c.side[p], dir);
      out[0] = p2[0] + dz * uu + dx * over; out[2] = p2[1] - dx * uu + dz * over;
      const ya = nc.y[sc.a[s]], yb = nc.y[sc.b[s]];
      out[1] = ya + (yb - ya) * (d / Math.max(1e-6, L)) + (c.bike[p] ? 0.02 : CURB);
      out[3] = Math.atan2(dx * dir, dz * dir);
      return out;
    }
    // straight line
    const o = p * WAYS * 4 + Math.max(0, c.wIdx[p] - 1) * 4;
    const ax = this.lineFrom[p * 3], ay = this.lineFrom[p * 3 + 1], az = this.lineFrom[p * 3 + 2];
    const bx = this.ways[o], by = this.ways[o + 1], bz = this.ways[o + 2];
    out[0] = ax + (bx - ax) * f; out[1] = ay + (by - ay) * f; out[2] = az + (bz - az) * f;
    if (Math.abs(bx - ax) + Math.abs(bz - az) > 1e-3) out[3] = Math.atan2(bx - ax, bz - az);
    return out;
  }

  /** One event: end of a segment, end of a straight line or end of a wait. */
  private advance(p: number): void {
    const mode = this.t.cols.mode[p];
    const ok = mode === 4 ? false : mode === 0 ? this.atNode(p) : this.nextWay(p);
    if (!ok) this.kill(p);
  }

  /** A new walking route from node `n` to the end of the current one (on foot, turning back allowed). */
  private reroute(p: number, n: number): boolean {
    const c = this.t.cols, r = p * ROUTE, dest = this.routes[r + c.rLen[p] - 1];
    if (dest === n || !this.sim.net.nodes.alive[dest]) return false;
    const len = this.router.route(n, dest, this.routes, r, ROUTE, true);
    if (len < 2 || this.routes[r + len - 1] !== dest) return false;
    c.rLen[p] = len; c.rIdx[p] = 0;
    return true;
  }

  /** Nowhere left to walk: stands where it is and fades out over FADE_OUT s, then leaves. */
  private fadeOut(p: number, lost = false): boolean {
    const c = this.t.cols;
    // lost: where it was going is not a place (an invalid point); it fades out at the start of that line
    const q = lost ? [this.lineFrom[p * 3], this.lineFrom[p * 3 + 1], this.lineFrom[p * 3 + 2], c.pyaw[p]] : this.posShown(p);
    if (!Number.isFinite(q[0]) || !Number.isFinite(q[2])) { this.kill(p); return false; }
    this.lineFrom[p * 3] = q[0]; this.lineFrom[p * 3 + 1] = q[1]; this.lineFrom[p * 3 + 2] = q[2];
    c.pyaw[p] = q[3];
    c.mode[p] = 4; c.t0[p] = this.time; c.dur[p] = FADE_OUT;
    this.schedule(p, this.time + FADE_OUT);
    return true;
  }

  // ------------------------------------------------------------ step

  step(dt: number): void {
    this.time += dt;
    const target = this.demand;
    const rate = this.t.size < target / 2 ? SPAWN_FILL : SPAWN_STEADY;
    for (let k = 0; k < rate && this.t.size < target; k++) this.spawn();
    const c = this.t.cols;
    let budget = 20000;
    while (this.heapN > 0 && this.heapT[0] <= this.time && budget-- > 0) {
      const p = this.heapP[0], at = this.heapT[0];
      this.popEvent();
      if (!this.t.alive[p] || c.at[p] !== at) continue; // stale event
      if (c.mode[p] === 0 && !this.sim.net.segs.alive[c.seg[p]]) { this.fadeOut(p); continue; }
      // held behind someone near the camera: the end of the stretch moved later (`seeEachOther`)
      if ((c.mode[p] === 0 || c.mode[p] === 1) && c.t0[p] + c.dur[p] > this.time + 1e-6) { this.schedule(p, c.t0[p] + c.dur[p]); continue; }
      this.advance(p);
    }
    this.seeEachOther(dt);
  }

  // near walkers, gathered every step (reused arrays)
  private nearP = new Int32Array(4096);
  private nearX = new Float32Array(4096); private nearZ = new Float32Array(4096);
  private nearHx = new Float32Array(4096); private nearHz = new Float32Array(4096);
  private nearV = new Float32Array(4096);
  private nearNext = new Int32Array(4096);
  private nearHead = new Int32Array(NEAR_SLOTS).fill(-1);
  private nearKey = new Int32Array(NEAR_SLOTS);
  private nearNodes: number[] = [];
  // the others a walker sees (`seeEachOther`): along, across, coming the other way
  private othAlong = new Float32Array(512); private othLat = new Float32Array(512); private othOn = new Uint8Array(512);
  private othR = new Float32Array(512);
  // the vehicles near the camera (`setBodies`): x, z, yaw, half length, half width each; by cell
  private bodies: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private bodyN = 0;
  private bodyNext = new Int32Array(0);
  private bodyHead = new Int32Array(NEAR_SLOTS).fill(-1);
  private bodyKey = new Int32Array(NEAR_SLOTS);

  /** The vehicles near the camera this step (traffic `writeBodies`): solid to the walkers. */
  setBodies(b: Float32Array, n: number): void {
    this.bodies = b; this.bodyN = n;
    if (this.bodyNext.length < n) this.bodyNext = new Int32Array(Math.max(1024, n * 2));
  }

  private bodySlot(ix: number, iz: number): number {
    const key = (ix & 0xffff) | ((iz & 0xffff) << 16);
    let h = (Math.imul(key, 2654435761) >>> 0) & (NEAR_SLOTS - 1);
    while (this.bodyHead[h] >= 0 && this.bodyKey[h] !== key) h = (h + 1) & (NEAR_SLOTS - 1);
    this.bodyKey[h] = key;
    return h;
  }

  private nearSlot(ix: number, iz: number): number {
    const key = (ix & 0xffff) | ((iz & 0xffff) << 16);
    let h = (Math.imul(key, 2654435761) >>> 0) & (NEAR_SLOTS - 1);
    while (this.nearHead[h] >= 0 && this.nearKey[h] !== key) h = (h + 1) & (NEAR_SLOTS - 1);
    this.nearKey[h] = key;
    return h;
  }

  /**
   * People near the camera walk as roadcraft 4.0's walkers do (sim/agents/walk.ts `stepWalkers`, SUMO's striping
   * model), each step: the others within LOOK ahead in its own frame (how far along, how far across, coming the other
   * way or not, through a grid of cells: only who is near); the stripe across its way with the most room ahead, keeping
   * right (walk.ts:1736-1762); its speed the room ahead in that stripe less the gap kept, over the headway, eased by
   * its acceleration and braking (walk.ts:1837-1840); a step aside towards the stripe, faster the slower it walks
   * (walk.ts:1846-1858); held too long, it is let through slowly (walk.ts:1816-1836). Its progress along the stretch is
   * the event model's (\`t0\` moved later by what it did not walk, the end event with it); its place across is \`lat\`.
   */
  private seeEachOther(dt: number): void {
    const c = this.t.cols, net = this.sim.net;
    // gather: walkers and those standing (obstacles too), with their shown position
    this.nearNodes.length = 0;
    // a person is in the list of the node it walks to, up to a street's length away
    const reach = NEAR_R + 150;
    net.nodeIndex.query(this.camX - reach, this.camZ - reach, this.camX + reach, this.camZ + reach, (n) => this.nearNodes.push(n));
    let n = 0;
    for (const node of this.nearNodes) {
      for (let p = this.head[node]; p >= 0; p = c.next[p]) {
        if (c.bike[p] || c.mode[p] === 4 || (c.mode[p] === 0 && !net.segs.alive[c.seg[p]])) continue;
        if (n >= this.nearP.length) this.growNear();
        const q = this.posShown(p);
        if (Math.abs(q[0] - this.camX) > NEAR_R || Math.abs(q[2] - this.camZ) > NEAR_R) continue;
        this.nearP[n] = p; this.nearX[n] = q[0]; this.nearZ[n] = q[2];
        this.nearHx[n] = Math.sin(q[3]); this.nearHz[n] = Math.cos(q[3]);
        this.nearV[n] = c.mode[p] === 0 || c.mode[p] === 1 ? c.vNow[p] : 0;
        n++;
      }
    }
    this.nearHead.fill(-1);
    for (let i = 0; i < n; i++) {
      const h = this.nearSlot(Math.floor(this.nearX[i] / NEAR_CELL), Math.floor(this.nearZ[i] / NEAR_CELL));
      this.nearNext[i] = this.nearHead[h]; this.nearHead[h] = i;
    }
    const oa = this.othAlong, ol = this.othLat, oo = this.othOn, or = this.othR;
    // the vehicles near, by cell (`setBodies`)
    this.bodyHead.fill(-1);
    for (let b = 0; b < this.bodyN; b++) {
      const h = this.bodySlot(Math.floor(this.bodies[b * 5] / NEAR_CELL), Math.floor(this.bodies[b * 5 + 1] / NEAR_CELL));
      this.bodyNext[b] = this.bodyHead[h]; this.bodyHead[h] = b;
    }
    for (let i = 0; i < n; i++) {
      const p = this.nearP[i], walking = c.mode[p] === 0 || c.mode[p] === 1;
      if (!walking) { c.vNow[p] = 0; c.hold[p] = 0; continue; }
      const xi = this.nearX[i], zi = this.nearZ[i], hx = this.nearHx[i], hz = this.nearHz[i], d = c.lat[p];
      // on the carriageway, crossing: those standing at the far kerb waiting for their own crossing step back for it
      // (roadcraft waits a step back from the kerb, walk.ts:75 KERB_BACK): it does not stop on the zebra for them
      const crossingNow = c.mode[p] === 1 && c.wIdx[p] > 0 && this.ways[p * WAYS * 4 + (c.wIdx[p] - 1) * 4 + 3] > 0;
      // the others in its frame (walk.ts:1470-1481): along its heading, and across (+ = right), as stripes see them
      let m = 0;
      const cx = Math.floor(xi / NEAR_CELL), cz = Math.floor(zi / NEAR_CELL), cells = Math.ceil(LOOK / NEAR_CELL);
      for (let gz = cz - cells; gz <= cz + cells; gz++) for (let gx = cx - cells; gx <= cx + cells; gx++) {
        const key = (gx & 0xffff) | ((gz & 0xffff) << 16);
        let h = (Math.imul(key, 2654435761) >>> 0) & (NEAR_SLOTS - 1);
        while (this.nearHead[h] >= 0 && this.nearKey[h] !== key) h = (h + 1) & (NEAR_SLOTS - 1);
        for (let j = this.nearHead[h]; j >= 0; j = this.nearNext[j]) {
          if (j === i) continue;
          if (crossingNow && c.mode[this.nearP[j]] === 2) continue;
          const dx = this.nearX[j] - xi, dz = this.nearZ[j] - zi;
          const along = dx * hx + dz * hz;
          if (along <= 0 || along > LOOK) continue;
          if (m >= oa.length) break;
          // facing it and moving: coming the other way (walk.ts:1477-1478)
          const facing = hx * this.nearHx[j] + hz * this.nearHz[j] < -0.3;
          oa[m] = along; ol[m] = d + (-dx * hz + dz * hx); oo[m] = facing && this.nearV[j] > MOVING ? 1 : 0; or[m] = SHOULDERS - BODY_R;
          m++;
        }
      }
      // the vehicles: kept off as three discs along each body (walk.ts:111-119, 1705-1724)
      const bd = this.bodies;
      for (let gz = cz - 1; gz <= cz + 1; gz++) for (let gx = cx - 1; gx <= cx + 1; gx++) {
        const key = (gx & 0xffff) | ((gz & 0xffff) << 16);
        let h = (Math.imul(key, 2654435761) >>> 0) & (NEAR_SLOTS - 1);
        while (this.bodyHead[h] >= 0 && this.bodyKey[h] !== key) h = (h + 1) & (NEAR_SLOTS - 1);
        for (let b = this.bodyHead[h]; b >= 0; b = this.bodyNext[b]) {
          const o = b * 5, fx = Math.sin(bd[o + 2]), fz = Math.cos(bd[o + 2]), rad = bd[o + 4], reachB = Math.max(0, bd[o + 3] - rad);
          // inside its body already (it came to them): they walk on out of its way, not held inside it (walk.ts:1710-1713)
          let inside = false;
          for (let q = -1; q <= 1 && !inside; q++) if (Math.hypot(bd[o] + fx * reachB * q - xi, bd[o + 1] + fz * reachB * q - zi) < rad) inside = true;
          if (inside) continue;
          for (let q = -1; q <= 1 && m < oa.length; q++) {
            const rx = bd[o] + fx * reachB * q - xi, rz = bd[o + 1] + fz * reachB * q - zi;
            const along = rx * hx + rz * hz - rad + BODY_R;
            if (along + 2 * rad <= 0 || along > LOOK) continue;
            oa[m] = Math.max(0.01, along); ol[m] = d + (-rx * hz + rz * hx); oo[m] = 0; or[m] = rad;
            m++;
          }
        }
      }
      // free distance ahead in the stripe centred c (walk.ts:1484-1493): someone coming the other way meets it halfway
      const free = (cc: number): number => {
        let gap = LOOK;
        for (let k = 0; k < m; k++) {
          if (Math.abs(ol[k] - cc) >= BODY_R + or[k]) continue;
          const g = oo[k] ? oa[k] / 2 : oa[k];
          if (g < gap) gap = g;
        }
        return gap;
      };
      // the room across: the sidewalk's width on a sidewalk (its body inside it), a crosswalk's half elsewhere
      const [lo, hi] = this.latRoom(p);
      // the stripe (walk.ts:1736-1762): most room ahead, a metre less for each stripe away from where it is, kept to
      // the right (here + is right), a stripe just taken kept a moment
      const right = hi - Math.min(hi - lo, STRIPE * 0.5);
      const lateral = c.hold[p] === 0 && free(d) > 0.05 ? LATERAL_PENALTY : 0;
      const gain = c.hold[p] > HELD_SWITCH ? SWITCH_GAIN / 4 : SWITCH_GAIN;
      // somebody coming the other way in the leftmost stripe: that stripe is theirs (walk.ts:1741-1749, 1507-1509)
      const leftmost = lo + STRIPE, wide = hi - lo > STRIPE;
      let oncomingLeft = false;
      for (let k = 0; k < m && !oncomingLeft; k++) if (oo[k] && ol[k] - SHOULDERS < leftmost && ol[k] + SHOULDERS > lo) oncomingLeft = true;
      const reserve = (cc: number) => (oncomingLeft && wide && cc < leftmost - 1e-6 ? ONCOMING_CONFLICT : 0);
      let aim = Math.max(lo, Math.min(hi, c.latT[p]));
      let best = free(aim) - (right - aim) * 0.15 - Math.abs(aim - d) * lateral + gain - reserve(aim) / 2;
      for (let cc = lo; cc <= hi + 1e-6; cc += STRIPE / 2) {
        const score = free(cc) - (right - cc) * 0.15 - Math.abs(cc - d) * Math.max(lateral, 0.2) - reserve(cc);
        if (score > best) { best = score; aim = cc; }
      }
      if (Math.abs(aim - c.latT[p]) > 1e-6 && (this.time - c.aimAt[p] >= AIM_HOLD || free(c.latT[p]) < KEEP || c.hold[p] > HELD_SWITCH)) { c.latT[p] = aim; c.aimAt[p] = this.time; }
      // the speed (walk.ts:1816-1840): the room ahead in its stripe over the headway; held too long, through slowly
      const pace = c.speed[p];
      let want = pace;
      const jam = c.hold[p] > (c.mode[p] === 1 ? JAM_AFTER_CROSSING : JAM_AFTER);
      if (jam) want *= JAM_SHARE;
      else want = Math.min(want, Math.max(0, (free(d) - KEEP) / HEADWAY));
      const v0 = c.vNow[p];
      const v = want > v0 ? Math.min(want, v0 + PED_ACCEL * dt) : Math.max(want, v0 - PED_BRAKE * dt);
      c.vNow[p] = v;
      c.hold[p] = v < 0.1 ? c.hold[p] + dt : 0;
      // its stretch: it walked v of its pace (the start moves later by the rest of the step)
      c.t0[p] += dt * (1 - v / pace);
      c.pace[p] = v / pace;
      // across, towards its stripe: with the walk (0.4 of the speed, walk.ts:1349) and, slow, a step aside (walk.ts:1848)
      const aside = c.latT[p] - d;
      if (Math.abs(aside) > 0.02 && free(c.latT[p]) > KEEP) {
        const rate = LATERAL_SHARE * v + SIDESTEP_RATE * Math.max(0, 1 - v / (0.6 * pace));
        c.lat[p] = d + Math.max(-rate * dt, Math.min(rate * dt, aside));
      }
    }
    // two walkers closer than CLOSE (side by side at the end of a queue, one catching another at a corner) move apart
    // across their own ways, half each, at most 1.2 m/s (those standing do not move: the walker takes it all)
    for (let i = 0; i < n; i++) {
      const xi = this.nearX[i], zi = this.nearZ[i];
      const cx = Math.floor(xi / NEAR_CELL), cz = Math.floor(zi / NEAR_CELL);
      for (let gz = cz - 1; gz <= cz + 1; gz++) for (let gx = cx - 1; gx <= cx + 1; gx++) {
        const key = (gx & 0xffff) | ((gz & 0xffff) << 16);
        let h = (Math.imul(key, 2654435761) >>> 0) & (NEAR_SLOTS - 1);
        while (this.nearHead[h] >= 0 && this.nearKey[h] !== key) h = (h + 1) & (NEAR_SLOTS - 1);
        for (let j = this.nearHead[h]; j >= 0; j = this.nearNext[j]) {
          if (j <= i) continue;
          let dx = this.nearX[j] - xi, dz = this.nearZ[j] - zi;
          const d = Math.hypot(dx, dz);
          if (d >= CLOSE) continue;
          // on one spot: apart along the first one's right
          if (d < 1e-3) { dx = -this.nearHz[i]; dz = this.nearHx[i]; } else { dx /= d; dz /= d; }
          const pi = this.nearP[i], pj = this.nearP[j];
          const wi = c.mode[pi] === 0 || c.mode[pi] === 1, wj = c.mode[pj] === 0 || c.mode[pj] === 1;
          if (!wi && !wj) continue;
          const push = Math.min(CLOSE - d, 1.2 * dt) / (wi && wj ? 2 : 1);
          // i moves along −(dx, dz), j along +(dx, dz), each through its own right (−hz, hx)
          if (wi) this.nudge(pi, -(dx * -this.nearHz[i] + dz * this.nearHx[i]) * push);
          if (wj) this.nudge(pj, (dx * -this.nearHz[j] + dz * this.nearHx[j]) * push);
        }
      }
    }
  }

  /** Moves walker `p` `d` m to its right, within its sidewalk (on a sidewalk) or a metre either way (elsewhere). */
  private nudge(p: number, d: number): void {
    const c = this.t.cols;
    let lo = -1, hi = 1;
    if (c.mode[p] === 0) {
      const prof = this.sim.net.segs.cols.profile[c.seg[p]], [u] = this.sideU(prof, c.side[p]);
      let half = 1.5;
      for (const e of PROFILE_INFO[prof].edges) if (e.strip.kind === 'sidewalk' && u >= e.u0 && u <= e.u1) half = (e.u1 - e.u0) / 2;
      // the track is already this far right of the middle; the step aside keeps the body on the sidewalk
      const k = this.trackOff(p, prof, u), room = Math.max(0, half - 0.25);
      lo = -room - k; hi = room - k;
    }
    // (one still out of its room, just in from a crosswalk, is not put back at once: it moves from where it is)
    c.lat[p] = Math.max(Math.min(lo, c.lat[p]), Math.min(Math.max(hi, c.lat[p]), c.lat[p] + d));
    // it keeps that step aside while they are close (easing back to its track only once clear)
    c.latT[p] = c.lat[p];
  }


  /** The room across person \`p\`'s way for its body (+ = right of its track): the sidewalk, or ±0.9 m on a line. */
  private latRoom(p: number): [number, number] {
    const c = this.t.cols;
    if (c.mode[p] !== 0) return [-0.9, 0.9];
    const prof = this.sim.net.segs.cols.profile[c.seg[p]], [u] = this.sideU(prof, c.side[p]);
    let half = 1.5;
    for (const e of PROFILE_INFO[prof].edges) if (e.strip.kind === 'sidewalk' && u >= e.u0 && u <= e.u1) half = (e.u1 - e.u0) / 2;
    // the track is already this far right of the middle
    const k = this.trackOff(p, prof, u), room = Math.max(0, half - BODY_R);
    return [-room - k, room - k];
  }

  private growNear(): void {
    const m = this.nearP.length * 2;
    const g = <T extends Int32Array | Float32Array>(a: T): T => { const b = new (a.constructor as { new(n: number): T })(m); b.set(a); return b; };
    this.nearP = g(this.nearP); this.nearX = g(this.nearX); this.nearZ = g(this.nearZ);
    this.nearHx = g(this.nearHx); this.nearHz = g(this.nearHz); this.nearV = g(this.nearV); this.nearNext = g(this.nearNext);
  }

  /** Where person `p` is seen: `posNow` and, walking near the camera, its step aside (right of its heading). */
  private posShown(p: number): number[] {
    const c = this.t.cols, q = this.posNow(p), l = c.mode[p] === 0 || c.mode[p] === 1 ? c.lat[p] : 0;
    if (l) { q[0] -= Math.cos(q[3]) * l; q[2] += Math.sin(q[3]) * l; }
    return q;
  }

  /**
   * Where `p` is seen now, before its stretch changes (x, z into `seenAt`): the next stretch starts there. The step
   * aside is right of the heading, so carried over a corner as it is it would swing the body across (up to 1.4 × the
   * step at a right angle, metres on a wide sidewalk); `keepSeen` re-expresses it in the new heading instead.
   */
  private seenNow(p: number): void {
    const c = this.t.cols;
    if (c.mode[p] === 0 && !this.sim.net.segs.alive[c.seg[p]]) { this.seenAt[0] = NaN; return; }
    const q = this.posShown(p);
    this.seenAt[0] = q[0]; this.seenAt[1] = q[1]; this.seenAt[2] = q[2];
  }
  private seenAt = new Float64Array(3);

  /**
   * After `p` entered a sidewalk stretch at its start: the stretch starts level with where it was seen (`seenNow`; the
   * last leg comes in across the sidewalk, so the step aside on it lies along the sidewalk) and the step aside that
   * keeps it there across, within its room. `fromStart`: it entered at the stretch's start (not part-way, from a door).
   */
  private keepSeen(p: number, fromStart: boolean): void {
    const c = this.t.cols;
    c.lat[p] = c.latT[p] = 0;
    if (!c.has[p] || Number.isNaN(this.seenAt[0])) return;
    let q = this.posNow(p);
    if (fromStart) {
      const along = (this.seenAt[0] - q[0]) * Math.sin(q[3]) + (this.seenAt[2] - q[2]) * Math.cos(q[3]);
      const dir = c.db[p] >= c.da[p] ? 1 : -1, L = this.sim.segLen(c.seg[p]);
      c.da[p] = Math.max(-SEEN_PAST, Math.min(L + SEEN_PAST, c.da[p] + along * dir));
      c.dur[p] = Math.max(0.1, Math.abs(c.db[p] - c.da[p]) / c.speed[p]);
      q = this.posNow(p);
    }
    const rx = -Math.cos(q[3]), rz = Math.sin(q[3]);
    const [lo, hi] = this.latRoom(p), want = (this.seenAt[0] - q[0]) * rx + (this.seenAt[2] - q[2]) * rz;
    // seen beyond the sidewalk's room (it stepped aside on a crosswalk, wider): it stays where it is and steps back in
    // (its aim within the room), instead of being put there at once
    c.latT[p] = Math.max(lo, Math.min(hi, want));
    c.lat[p] = Math.max(lo - SEEN_PAST, Math.min(hi + SEEN_PAST, want));
  }

  /** The camera moved: nodes whose lists enter the window. */
  checkWindow(): void {
    this.windowNodes.length = 0;
    this.sim.net.nodeIndex.query(this.camX - WINDOW, this.camZ - WINDOW, this.camX + WINDOW, this.camZ + WINDOW, (n) => this.windowNodes.push(n));
  }

  /** Removed segments: whoever was on them disappears at their next event (checked in step). */

  /** Writes the poses of the people nearby, starting at `start`. Returns how many it wrote. */
  /** Publications so far (a person not in the previous one starts from where it is now, not where it was last seen). */
  private frame = 0;
  /** The simulated time of the last publication. */
  private pubTime = 0;

  writePoses(data: Float32Array, stride: number, start: number, max: number): number {
    const c = this.t.cols, frame = ++this.frame;
    // the simulated time since the last publication: the turn a body may make in it (paused: none)
    const dt = Math.max(0, this.time - this.pubTime);
    this.pubTime = this.time;
    let n = 0;
    for (const node of this.windowNodes) {
      if (!this.sim.net.nodes.alive[node]) continue;
      for (let p = this.head[node]; p >= 0; p = c.next[p]) {
        if (start + n >= max) return n;
        if (c.mode[p] === 0 && !this.sim.net.segs.alive[c.seg[p]]) continue;
        const q = this.posShown(p);
        const o = (start + n) * stride;
        if (!c.has[p] || c.wf[p] !== frame - 1) { c.px[p] = q[0]; c.py[p] = q[1]; c.pz[p] = q[2]; c.syaw[p] = q[3]; c.has[p] = 1; }
        c.wf[p] = frame;
        // the body turns towards the way it goes at a person's rate (the way bends at once at a corner or a waypoint:
        // drawn as it is, the body snapped round, 60-180 degrees in one publication)
        const walking = (c.mode[p] === 0 || c.mode[p] === 1) && c.pace[p] > 0.2;
        let turn = q[3] - c.syaw[p];
        turn -= Math.round(turn / (2 * Math.PI)) * 2 * Math.PI;
        const most = (walking ? TURN_RATE : TURN_STANDING) * dt, yaw = c.syaw[p] + Math.max(-most, Math.min(most, turn));
        data[o] = c.px[p]; data[o + 1] = c.py[p]; data[o + 2] = c.pz[p]; data[o + 3] = c.syaw[p];
        data[o + 4] = q[0]; data[o + 5] = q[1]; data[o + 6] = q[2]; data[o + 7] = yaw;
        data[o + 8] = (c.bike[p] ? 5 : 3) * 256 + c.color[p];
        data[o + 9] = c.mode[p] === 4 ? Math.max(0, 1 - (this.time - c.t0[p]) / c.dur[p]) : 1;
        data[o + 10] = c.look[p];
        c.px[p] = q[0]; c.py[p] = q[1]; c.pz[p] = q[2]; c.syaw[p] = yaw;
        n++;
      }
    }
    return n;
  }

  /**
   * The people within  m of (x, z), as the motion probe reads them (tools/check-sim.mjs): PED_INSPECT_STRIDE
   * numbers each (id, x, z, yaw, speed, mode, arm being crossed + 1 (0: not crossing), node it walks to, bicycle, strip
   * of the street under it (STRIP_KINDS index), distance past the junction's edge, share of its own pace it walks at
   * (below 1: behind someone)). Only the window's nodes, on request.
   */
  inspect(x: number, z: number, r: number): Float32Array {
    const c = this.t.cols, net = this.sim.net, out: number[] = [];
    for (const node of this.windowNodes) {
      if (!net.nodes.alive[node]) continue;
      for (let p = this.head[node]; p >= 0; p = c.next[p]) {
        if (c.mode[p] === 0 && !net.segs.alive[c.seg[p]]) continue;
        const [px, , pz, yaw] = this.posShown(p);
        if (Math.hypot(px - x, pz - z) > r) continue;
        const m = c.mode[p];
        // near the camera it walks at the share of its pace the people ahead leave it (`seeEachOther`)
        const share = m === 0 || m === 1 ? c.pace[p] : 0;
        const speed = share * (m === 0 ? Math.abs(c.db[p] - c.da[p]) / Math.max(1e-3, c.dur[p]) : c.speed[p]);
        const arm = m === 1 && c.wIdx[p] > 0 ? this.ways[p * WAYS * 4 + (c.wIdx[p] - 1) * 4 + 3] : 0;
        const [strip, fromEnd] = stripAt(this.sim, px, pz);
        out.push(p, px, pz, yaw, speed, m, arm, node, c.bike[p], strip, fromEnd, share);
      }
    }
    return Float32Array.from(out);
  }

  clear(): void {
    this.t.clear();
    this.head.fill(-1);
    this.heapN = 0;
  }
}

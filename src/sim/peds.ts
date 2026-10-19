// Pedestrians (simulation worker). Same scheme as traffic: across the whole map
// only events (end of each walking leg, in a time-ordered queue); near the
// camera, a position every frame, waiting at signalled crosswalks.
// Path = A* route over the nodes (only segments with a sidewalk); at each node it
// goes around the corners and crosses the arms at the crosswalks. Nothing walks the
// crowd per tick: each person sits in the list of the node it is walking to, and the
// window reads only the lists of the nodes near the camera.

import { Table } from '../core/table.ts';
import { Rng } from '../core/rng.ts';
import { armAngle, bez, bezD } from '../roads/geometry.ts';
import { armOf } from '../roads/junction.ts';
import { PROFILE_INFO } from '../roads/profiles.ts';
import { baseZone } from '../roads/zones.ts';
import { MAX_DEG } from '../roads/network.ts';
import type { SimNet } from './lanes.ts';
import { Router } from './routing.ts';

const MAX_PEDS = 100000;
/** Chance of spawning at a node by the zone of the roads around it (none, residential, commercial, industrial, mixed). */
const ZONE_PULL = [0.12, 0.4, 1, 0.15, 0.8];
const ROUTE = 32;
/** A node near the camera lets its people out of a door within this distance (m). */
const DOOR_CELL = 80;
const WAYS = 12;
const CROSS_AT = 2.15; // middle of the crosswalk, measured from the setback
const WINDOW = 520;
const CURB = 0.15;
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
  // last published position (for interpolation)
  px: Float32Array, py: Float32Array, pz: Float32Array, pyaw: Float32Array, has: Uint8Array,
  // bus trip: line (-1 = on foot only), boarding stop and alighting stop
  tLine: Int16Array, tFrom: Uint8Array, tTo: Uint8Array,
  // by bicycle (rides on the bike lane)
  bike: Uint8Array,
  // where it enters the first sidewalk segment (0-1; someone leaving a door enters mid-way)
  enter: Float32Array,
};

const p2 = new Float64Array(2), d2 = new Float64Array(2);

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
  /** A pedestrian waits at the kerb of the crossing over arm `arm` of node `n` (presses the button). */
  onWait: (n: number, arm: number) => void = () => {};
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

  // ------------------------------------------------------------ event queue

  private schedule(p: number, at: number): void {
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

  /** Is anyone on the node's crosswalk right now (walking the crossing leg)? */
  crossing(n: number): boolean { return this.crossingArms(n, 0xff); }

  /** Is anyone walking a crossing over one of the node's arms in `mask` (bit per arm)? */
  crossingArms(n: number, mask: number): boolean {
    const c = this.t.cols;
    for (let p = this.head[n]; p >= 0; p = c.next[p]) {
      if (c.mode[p] !== 1 && c.mode[p] !== 2) continue;
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
  pickTrip: () => [number, number, number, number] | null = () => null;
  /** Reached the stop: starts waiting for the bus (tracked by traffic). */
  onStop: (line: number, from: number, to: number) => void = () => {};
  /** Share of walkers who take the bus (when there are lines). */
  transitShare = 0.3;

  /** Got off the bus at the node: they walk on to a nearby destination. */
  spawnAt(node: number, count: number, color = -1): void {
    for (let k = 0; k < count && this.t.size < MAX_PEDS; k++) {
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
      if (!c.has[p]) continue;
      const d = Math.hypot(c.px[p] - x, c.pz[p] - z);
      if (d > r) continue;
      if (one) { if (d < bd) { bd = d; best = p; } } else doomed.push(p);
    }
    if (one && best >= 0) doomed.push(best);
    for (const p of doomed) { this.kill(p); n0++; }
    return n0;
  }

  private spawn(): void {
    // some walk to a stop, take the bus and get off far away
    if (this.rng.next() < this.transitShare) {
      const trip = this.pickTrip();
      if (trip) {
        const [li, from, to, stopNode] = trip;
        const net = this.sim.net, nc = net.nodes.cols;
        if (!net.nodes.alive[stopNode]) return;
        const cand: number[] = [];
        net.nodeIndex.query(nc.x[stopNode] - 500, nc.z[stopNode] - 500, nc.x[stopNode] + 500, nc.z[stopNode] + 500, (n) => { if (cand.length < 200) cand.push(n); });
        const a = cand.length ? cand[this.rng.int(0, cand.length)] : -1;
        if (a >= 0 && a !== stopNode) this.spawnRoute(a, stopNode, li, from, to);
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
  spawnFromPoint(x: number, z: number): boolean {
    if (this.t.size >= MAX_PEDS) return false;
    const net = this.sim.net, sc = net.segs.cols, nc = net.nodes.cols, sim = this.sim;
    const hit = net.nearestSeg(x, z, 30, (s) => PROFILE_INFO[sc.profile[s]].walk);
    if (!hit) return false;
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
    const cand: number[] = [];
    net.nodeIndex.query(x - 900, z - 900, x + 900, z + 900, (n) => { if (cand.length < 400) cand.push(n); });
    let b = -1;
    for (let i = 0; i < 8 && cand.length; i++) {
      const n = cand[this.rng.int(0, cand.length)];
      const d = Math.hypot(nc.x[n] - x, nc.z[n] - z);
      if (d > 150 && d < 900 && nc.deg[n] > 0) { b = n; break; }
    }
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
    c.speed[p] = 1.1 + this.rng.next() * 0.55;
    c.color[p] = this.rng.int(0, 16); c.look[p] = this.rng.int(0, 65536);
    c.side[p] = side;
    c.tLine[p] = -1; c.tFrom[p] = 0; c.tTo[p] = 0;
    c.bike[p] = 0;
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
    c.bike[p] = 1; c.enter[p] = 0;
    if (!this.startSidewalk(p, this.rng.next())) { this.kill(p); return false; }
    return true;
  }

  /** Spawns at `a` and walks to a random node up to `radius` metres away. */
  private spawnFrom(a: number, radius: number, li: number, from: number, to: number, frac: number): void {
    const net = this.sim.net, nc = net.nodes.cols;
    if (!net.nodes.alive[a]) return;
    const cand: number[] = [];
    net.nodeIndex.query(nc.x[a] - radius, nc.z[a] - radius, nc.x[a] + radius, nc.z[a] + radius, (n) => { if (cand.length < 400) cand.push(n); });
    let b = -1;
    for (let i = 0; i < 8 && cand.length; i++) {
      const n = cand[this.rng.int(0, cand.length)];
      const d = Math.hypot(nc.x[n] - nc.x[a], nc.z[n] - nc.z[a]);
      if (n !== a && d > 150 && d < radius && nc.deg[n] > 0) { b = n; break; }
    }
    if (b < 0) return;
    this.spawnRoute(a, b, li, from, to, frac);
  }

  private spawnRoute(a: number, b: number, li: number, from: number, to: number, frac = 0): void {
    const p = this.t.alloc();
    const c = this.t.cols;
    const len = this.router.route(a, b, this.routes, p * ROUTE, ROUTE, true);
    if (len < 2 || this.routes[p * ROUTE + len - 1] !== b) { this.t.release(p); return; }
    c.rLen[p] = len; c.rIdx[p] = 0; c.node[p] = -1; c.has[p] = 0;
    c.speed[p] = 1.1 + this.rng.next() * 0.55;
    c.color[p] = this.nextColor >= 0 ? this.nextColor : this.rng.int(0, 16); c.look[p] = this.rng.int(0, 65536);
    c.side[p] = this.rng.next() < 0.5 ? 1 : -1;
    c.tLine[p] = li; c.tFrom[p] = from; c.tTo[p] = to;
    c.bike[p] = 0; c.enter[p] = 0;
    // `frac` > 0: starts part-way along the first segment, so the city starts out full
    if (!this.startSidewalk(p, frac)) { this.kill(p); return; }
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
  private sideU(profile: number, side: number): [number, number] {
    const s = PROFILE_INFO[profile];
    if (side > 0) return Number.isNaN(s.walkLeft) ? [s.walkRight, -1] : [s.walkLeft, 1];
    return Number.isNaN(s.walkRight) ? [s.walkLeft, 1] : [s.walkRight, -1];
  }

  /** Enters the sidewalk of the segment between route[rIdx] and route[rIdx + 1]. `frac` > 0 starts part-way. */
  private startSidewalk(p: number, frac = 0): boolean {
    const c = this.t.cols, sim = this.sim, sc = sim.net.segs.cols;
    // someone who left a door enters mid-segment (where the line from the door arrived)
    if (frac === 0 && c.enter[p] > 0) { frac = c.enter[p]; c.enter[p] = 0; }
    const i = c.rIdx[p];
    if (i + 1 >= c.rLen[p]) return false;
    const n0 = this.routes[p * ROUTE + i], n1 = this.routes[p * ROUTE + i + 1];
    if (!sim.net.nodes.alive[n0] || !sim.net.nodes.alive[n1]) return false;
    const s = this.segBetween(n0, n1);
    if (s < 0 || (c.bike[p] ? Number.isNaN(bikeU(sc.profile[s], 1)) : !PROFILE_INFO[sc.profile[s]].walk)) return false;
    if (!c.bike[p]) {
      const [, side] = this.sideU(sc.profile[s], c.side[p]);
      c.side[p] = side;
    }
    const r0 = sim.segS0(s), r1 = sim.segS1(s);
    const fromA = sc.a[s] === n0;
    c.seg[p] = s;
    c.da[p] = fromA ? r0 : r1;
    c.db[p] = fromA ? r1 : r0;
    c.mode[p] = 0;
    const dur = Math.abs(c.db[p] - c.da[p]) / c.speed[p];
    c.dur[p] = Math.max(0.1, dur);
    c.t0[p] = this.time - frac * c.dur[p];
    this.unlink(p);
    this.link(p, n1);
    this.schedule(p, c.t0[p] + c.dur[p]);
    return true;
  }

  /** Reached node route[rIdx + 1]: builds the waypoints to go around/cross to the next segment. */
  private atNode(p: number): boolean {
    const c = this.t.cols, sim = this.sim, net = sim.net, sc = net.segs.cols;
    c.rIdx[p]++;
    const i = c.rIdx[p];
    if (i + 1 >= c.rLen[p]) {
      // arrived: those taking the bus wait at the stop
      if (c.tLine[p] >= 0) this.onStop(c.tLine[p], c.tFrom[p], c.tTo[p]);
      return false;
    }
    const n = this.routes[p * ROUTE + i], nNext = this.routes[p * ROUTE + i + 1];
    const sIn = c.seg[p], sOut = this.segBetween(n, nNext);
    if (c.bike[p]) return this.bikeThrough(p, n, sIn, sOut);
    if (sOut < 0 || !net.segs.alive[sIn] || !PROFILE_INFO[sc.profile[sOut]].walk) return false;
    // start point = end of the sidewalk just finished
    const here = this.posNow(p);
    this.lineFrom[p * 3] = here[0]; this.lineFrom[p * 3 + 1] = here[1]; this.lineFrom[p * 3 + 2] = here[2];
    c.pyaw[p] = here[3];
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
    const pick = mid ? (opts.find((o) => (o.steps > 0) === want) ?? opts[0]) : opts[0].steps < opts[1].steps || (opts[0].steps === opts[1].steps && (p & 1) === 0) ? opts[0] : opts[1];
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
    this.armPoint(sOut, endOut, dOut, armLeftOut, tmp, true);
    put(tmp[0], tmp[1], tmp[2], 0);
    c.side[p] = endOut === 0 ? (armLeftOut ? 1 : -1) : (armLeftOut ? -1 : 1);
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
  private armPoint(s: number, end: 0 | 1, d: number, armLeft: boolean, out: Float64Array, sidewalk: boolean): void {
    const sim = this.sim, net = sim.net, sc = net.segs.cols, nc = net.nodes.cols;
    const L = sim.segLen(s);
    const fromA = end === 0 ? d : L - d;
    // arm's left in segment coordinates (u+ = left of a→b)
    const segLeft = end === 0 ? armLeft : !armLeft;
    const [u] = this.sideU(sc.profile[s], segLeft ? 1 : -1);
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
    if (c.wIdx[p] >= c.wLen[p]) return this.startSidewalk(p);
    const o = p * WAYS * 4 + c.wIdx[p] * 4;
    const cross = this.ways[o + 3];
    // signalled crossing: waits for the light to let them walk (and calls it)
    if (cross > 0 && !this.walkOk(this.wayNode[p], cross - 1)) {
      this.onWait(this.wayNode[p], cross - 1);
      c.mode[p] = 2;
      c.t0[p] = this.time; c.dur[p] = 1;
      this.schedule(p, this.time + 1);
      return true;
    }
    const [x0, y0, z0, yaw0] = this.posNow(p);
    c.pyaw[p] = yaw0;
    const len = Math.hypot(this.ways[o] - x0, this.ways[o + 2] - z0);
    c.mode[p] = 1;
    c.t0[p] = this.time;
    c.dur[p] = Math.max(0.05, len / c.speed[p]);
    // the start point is stored in the line's px/py/pz
    this.lineFrom[p * 3] = x0; this.lineFrom[p * 3 + 1] = y0; this.lineFrom[p * 3 + 2] = z0;
    c.wIdx[p]++;
    this.schedule(p, this.time + c.dur[p]);
    return true;
  }


  /** Current position (x, y, z, heading). Modes: 0 sidewalk, 1 straight line, 2 waiting at a point, 3 standing at the start point. */
  private posNow(p: number, time = this.time): number[] {
    const c = this.t.cols, sim = this.sim, out = this.pos3;
    out[3] = c.pyaw[p];
    if (c.mode[p] === 3) {
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
      const t = sim.tAt(s, Math.max(0, Math.min(L, d)));
      bez(q, t, p2); bezD(q, t, d2);
      const l = Math.hypot(d2[0], d2[1]) || 1;
      const dx = d2[0] / l, dz = d2[1] / l;
      const dir = c.db[p] >= c.da[p] ? 1 : -1;
      // cyclist: in the middle of the bike lane on its side; pedestrian: each on a slightly different "track" along the sidewalk
      const uu = c.bike[p] ? bikeU(sc.profile[s], dir) : this.sideU(sc.profile[s], c.side[p])[0] + ((p * 0.618) % 1 - 0.5) * 0.9;
      out[0] = p2[0] + dz * uu; out[2] = p2[1] - dx * uu;
      const ya = nc.y[sc.a[s]], yb = nc.y[sc.b[s]];
      out[1] = ya + (yb - ya) * (d / Math.max(1e-6, L)) + (c.bike[p] ? 0.02 : CURB);
      out[3] = Math.atan2(dx * dir, dz * dir);
      return out;
    }
    // straight line (or standing, waiting at the last point)
    const k = c.mode[p] === 2 ? Math.max(0, c.wIdx[p] - 1) : c.wIdx[p] - 1;
    const o = p * WAYS * 4 + Math.max(0, k) * 4;
    if (c.mode[p] === 2) {
      // standing at the last point reached
      if (c.wIdx[p] > 0) { out[0] = this.ways[o]; out[1] = this.ways[o + 1]; out[2] = this.ways[o + 2]; }
      else { out[0] = this.lineFrom[p * 3]; out[1] = this.lineFrom[p * 3 + 1]; out[2] = this.lineFrom[p * 3 + 2]; }
      return out;
    }
    const ax = this.lineFrom[p * 3], ay = this.lineFrom[p * 3 + 1], az = this.lineFrom[p * 3 + 2];
    const bx = this.ways[o], by = this.ways[o + 1], bz = this.ways[o + 2];
    out[0] = ax + (bx - ax) * f; out[1] = ay + (by - ay) * f; out[2] = az + (bz - az) * f;
    if (Math.abs(bx - ax) + Math.abs(bz - az) > 1e-3) out[3] = Math.atan2(bx - ax, bz - az);
    return out;
  }

  /** One event: end of a segment, end of a straight line or end of a wait. */
  private advance(p: number): void {
    const ok = this.t.cols.mode[p] === 0 ? this.atNode(p) : this.nextWay(p);
    if (!ok) this.kill(p);
  }

  // ------------------------------------------------------------ step

  step(dt: number): void {
    this.time += dt;
    const target = Math.min(MAX_PEDS, Math.floor(this.sim.laneMeters * this.density * this.share));
    for (let k = 0; k < 40 && this.t.size < target; k++) this.spawn();
    const c = this.t.cols;
    let budget = 20000;
    while (this.heapN > 0 && this.heapT[0] <= this.time && budget-- > 0) {
      const p = this.heapP[0], at = this.heapT[0];
      this.popEvent();
      if (!this.t.alive[p] || c.at[p] !== at) continue; // stale event
      if (c.mode[p] === 0 && !this.sim.net.segs.alive[c.seg[p]]) { this.kill(p); continue; }
      this.advance(p);
    }
  }

  /** The camera moved: nodes whose lists enter the window. */
  checkWindow(): void {
    this.windowNodes.length = 0;
    this.sim.net.nodeIndex.query(this.camX - WINDOW, this.camZ - WINDOW, this.camX + WINDOW, this.camZ + WINDOW, (n) => this.windowNodes.push(n));
  }

  /** Removed segments: whoever was on them disappears at their next event (checked in step). */

  /** Writes the poses of the people nearby, starting at `start`. Returns how many it wrote. */
  writePoses(data: Float32Array, stride: number, start: number, max: number): number {
    const c = this.t.cols;
    let n = 0;
    for (const node of this.windowNodes) {
      if (!this.sim.net.nodes.alive[node]) continue;
      for (let p = this.head[node]; p >= 0; p = c.next[p]) {
        if (start + n >= max) return n;
        if (c.mode[p] === 0 && !this.sim.net.segs.alive[c.seg[p]]) continue;
        const q = this.posNow(p);
        const o = (start + n) * stride;
        if (!c.has[p]) { c.px[p] = q[0]; c.py[p] = q[1]; c.pz[p] = q[2]; c.pyaw[p] = q[3]; c.has[p] = 1; }
        data[o] = c.px[p]; data[o + 1] = c.py[p]; data[o + 2] = c.pz[p]; data[o + 3] = c.pyaw[p];
        data[o + 4] = q[0]; data[o + 5] = q[1]; data[o + 6] = q[2]; data[o + 7] = q[3];
        data[o + 8] = (c.bike[p] ? 5 : 3) * 256 + c.color[p];
        data[o + 9] = 1;
        data[o + 10] = c.look[p];
        c.px[p] = q[0]; c.py[p] = q[1]; c.pz[p] = q[2]; c.pyaw[p] = q[3];
        n++;
      }
    }
    return n;
  }

  clear(): void {
    this.t.clear();
    this.head.fill(-1);
    this.heapN = 0;
  }
}

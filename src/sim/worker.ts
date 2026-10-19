// Simulation worker: owns traffic and pedestrians. Receives the road network changes and the
// camera position; publishes poses (triple buffer) and road occupancy
// (shared memory). The page only reads.

import { PoseWriter, POSE_STRIDE, MAX_AGENTS, TILES, sortByTile, tileOrigin, viewPoseBuffers } from './poses.ts';
import { SimNet, decodeOp } from './lanes.ts';
import { Traffic, type LineSpec } from './traffic.ts';
import { Peds } from './peds.ts';

export type ToSim =
  | { type: 'init'; poses: SharedArrayBuffer; heights: SharedArrayBuffer; occupancy: SharedArrayBuffer; signals: SharedArrayBuffer; tickHz: number }
  | { type: 'speed'; value: number } // 0 = paused, 1, 2, 4
  | { type: 'camera'; x: number; z: number }
  /** Building doors near the camera (x, z): pedestrians come out of them. */
  | { type: 'doors'; pts: Float32Array }
  /** Warehouse loading docks near the camera: (x, z, yaw facing the street) each. */
  | { type: 'docks'; pts: Float32Array }
  | { type: 'probeManoeuvres' }
  | { type: 'ops'; ops: Float64Array; extra?: string[] }
  | { type: 'density'; value: number }
  | { type: 'demand'; hour: number; demand: number; traffic: number; people: number }
  | { type: 'lines'; lines: LineSpec[] }
  | { type: 'profiles'; list: Profile[] }
  | { type: 'probe'; seg: number }
  | { type: 'probeNode'; node: number }
  /** The motion probe (tools/check-sim.mjs): vehicles and people within r m of (x, z), as they are now. */
  | { type: 'inspect'; x: number; z: number; r: number }
  | { type: 'people'; x: number; z: number; count: number; color: number }
  | { type: 'hit'; x: number; z: number; r: number; one: boolean };

/** From the worker to the page. */
export type FromSim =
  | { type: 'probe'; seg: number; vehicles: number; speed: number; queue: number; capacity: number }
  | { type: 'probeNode'; node: number; passed: number; time: number }
  | { type: 'hit'; people: number; vehicles: number }
  /** Answer to 'inspect': Traffic.inspect and Peds.inspect records, the lights within reach (node, state as in the
   *  signals buffer) and the count of vehicles that entered a junction on red. */
  | { type: 'inspect'; time: number; vehicles: Float32Array; clashes: Float32Array; peds: Float32Array; lights: number[]; ranRed: number }
  /** Manoeuvres going on (answer to 'probeManoeuvres'): [x, z, kind (sim/manoeuvres MKind), share done] each; counters. */
  | { type: 'manoeuvres'; list: number[]; planned: number; kerbStops: number; docked: number; crossings: number[]; trains: number[] }
  /** Automatic mode switched the node's control based on measured flow (Flow: 1 traffic light, 2 signs). The page can
   *  pass the same `flow` to `effectiveControl` (paint, signs, signal heads, inspector). */
  | { type: 'autoControl'; node: number; flow: number }
  /** `simTime`: the simulation clock (s), for rates per simulated minute or hour (the speed may be 0, 1, 2 or 4). */
  | { type: 'stats'; cars: number; micro: number; peds: number; arrived: number; lost: number; speed: number; stopped: number; simTime: number;
      lines: Array<{ id: number; buses: number; perHour: number; waiting: number }> }
  | { type: 'error'; message: string }
  /** A network change failed and the worker's mirror of the network may differ from the page's: the page sends the
   *  whole network again (a 'clear' followed by every node, segment and junction). */
  | { type: 'resync'; reason: string };

import { setCustomProfiles, type Profile } from '../roads/profiles.ts';

interface SimScope { onmessage: ((e: MessageEvent<ToSim>) => void) | null; postMessage(m: FromSim): void }
const scope = self as unknown as SimScope;

const sim = new SimNet();
const traffic = new Traffic(sim);
sim.onConnRemoved = (c) => traffic.evacuateConn(c);
sim.onSegAdded = (s) => traffic.clearWear(s);
const peds = new Peds(sim);
peds.walkOk = (n, arm) => traffic.walkOk(n, arm);
peds.onWait = (n, arm) => traffic.pedCall(n, arm);
traffic.pedCrossing = (n) => peds.crossing(n);
traffic.pedCrossingArms = (n, mask) => peds.crossingArms(n, mask);
traffic.pedCrossingNear = (n, mask, x, z, r) => peds.crossingNear(n, mask, x, z, r);
peds.carsOn = (n, arm) => traffic.carsOnCrossing(n, arm);
traffic.sig.pedsOn = (n, mask) => peds.crossingArms(n, mask);
// buses and pedestrians: bus riders walk to the stop, wait, ride and get off on foot
peds.pickTrip = () => traffic.pickTrip();
peds.onStop = (l, a, b) => traffic.pedAtStop(l, a, b);
traffic.onAlight = (_node, n, x, z) => peds.spawnFromStop(x, z, n);
// a car stopping at the kerb lets a passenger out: a pedestrian from that point
traffic.onDropOff = (x, z) => { peds.spawnFromPoint(x, z); };
traffic.advisor.onChange = (node, flow) => scope.postMessage({ type: 'autoControl', node, flow });

let writer: PoseWriter | null = null;
let speed = 1;
let dtMs = 50;
let tick = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let next = 0;
let windowTimer = 0;

let statsTimer = 0;
/** Poses as written, before sorting them by tile into the published buffer; scratch for the sort. */
const raw = new Float32Array(MAX_AGENTS * POSE_STRIDE);
const tileOf = new Int32Array(MAX_AGENTS + TILES);
const origin = new Float64Array(2);
/** The standing-still poses of the pause were published. */
let pausedOut = false;
/** Simulation clock at the last stats (boardings per hour are reckoned over simulated time). */
let statsSim = 0;

/** When each distinct error was last reported (by its first line). */
const reported = new Map<string, number>();
/** The same error is reported again after this long (ms), so the page knows it is still happening. */
const REPORT_AGAIN_MS = 10000;
/** Last request for the whole network (a failing snapshot must not ask again in a loop). */
let resyncAt = -Infinity;

/** Tells the page about an error: every distinct one, each again at most every REPORT_AGAIN_MS. */
function report(where: string, err: unknown): void {
  const message = `${where}: ${String((err as Error)?.stack ?? err)}`;
  const key = message.split(String.fromCharCode(10))[0];
  const t = performance.now(), last = reported.get(key);
  if (last !== undefined && t - last < REPORT_AGAIN_MS) return;
  if (reported.size >= 256) reported.clear();
  reported.set(key, t);
  scope.postMessage({ type: 'error', message });
}

function step(): void {
  if (!writer) return;
  // simulation error: tell the page and carry on (the next step tries again)
  try { stepInner(); } catch (err) { report('simulation step', err); }
  next += dtMs;
  // behind the clock (a slow step, the tab in the background): catch up at most MAX_LAG_MS; the rest of the lost time
  // is dropped (the simulation runs slower for a moment) instead of running steps back to back until it catches up
  const t = performance.now();
  if (t - next > MAX_LAG_MS) next = t - MAX_LAG_MS;
  timer = setTimeout(step, Math.max(0, next - t));
}

/** Most the step loop will run behind the clock and still catch up (steps back to back). */
const MAX_LAG_MS = 100;

function stepInner(): void {
  if (!writer) return;
  const dt = dtMs / 1000;
  // network changed: rebuild only the touched nodes
  const removed = sim.removedSegs.splice(0);
  if (removed.length) traffic.segsRemoved(removed);
  const reprofiled = sim.reprofiledSegs.splice(0);
  if (reprofiled.length) traffic.segsReprofiled(reprofiled);
  const rebuilt = sim.rebuild();
  if (rebuilt.length) traffic.nodesRebuilt(rebuilt);
  for (let k = 0; k < speed; k++) {
    traffic.step(dt);
    // the vehicles near the camera are solid to the walkers there
    peds.setBodies(traffic.bodyBuf, traffic.writeBodies(traffic.camX, traffic.camZ, 180));
    peds.step(dt);
    tick++;
  }
  windowTimer += dt * Math.max(1, speed);
  if (windowTimer >= 0.5) { windowTimer = 0; traffic.checkWindow(); peds.checkWindow(); }
  let n = -1;
  // paused: published once more standing still (previous pose = current), so nobody walks in place
  if (speed > 0 || !pausedOut) {
    const d = raw;
    n = Math.min(MAX_AGENTS, traffic.writePoses(d, POSE_STRIDE));
    n += traffic.writeStopPeople(d, POSE_STRIDE, n, MAX_AGENTS);
    n += peds.writePoses(d, POSE_STRIDE, n, MAX_AGENTS);
    if (speed === 0) {
      for (let i = 0; i < n; i++) { const o = i * POSE_STRIDE; d[o] = d[o + 4]; d[o + 1] = d[o + 5]; d[o + 2] = d[o + 6]; d[o + 3] = d[o + 7]; }
    }
    pausedOut = speed === 0;
    // sorted by tile around the camera: the page reads only the tiles in view
    tileOrigin(traffic.camX, traffic.camZ, origin);
    sortByTile(d, n, writer.data, writer.tiles, origin[0], origin[1], tileOf);
  }
  if (n >= 0) writer.publish(n, performance.timeOrigin + performance.now(), dtMs, tick, origin[0], origin[1]);
  statsTimer += dtMs;
  if (statsTimer >= 1000) {
    statsTimer = 0;
    const speedNow = traffic.avgSpeed();
    const simDt = traffic.time - statsSim;
    statsSim = traffic.time;
    scope.postMessage({ type: 'stats', cars: traffic.count, micro: traffic.microN, peds: peds.count, arrived: traffic.arrived, lost: traffic.lost, speed: speedNow, stopped: traffic.stopped, simTime: traffic.time, lines: traffic.lineStats(simDt) });
  }
}

scope.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      writer = new PoseWriter(viewPoseBuffers(m.poses));
      traffic.occupancy = new Uint8Array(m.occupancy);
      traffic.signals = new Uint8Array(m.signals);
      dtMs = 1000 / m.tickHz;
      next = performance.now();
      if (timer === null) step();
      break;
    case 'speed': speed = m.value; break;
    case 'camera': traffic.camX = peds.camX = m.x; traffic.camZ = peds.camZ = m.z; break;
    case 'doors': peds.setDoors(m.pts); break;
    case 'docks': traffic.setDocks(m.pts); break;
    case 'density': traffic.density = m.value; break;
    case 'demand': traffic.hour = m.hour; traffic.demand = m.demand; traffic.trafficShare = m.traffic; peds.share = m.people; break;
    case 'profiles': setCustomProfiles(m.list); break;
    case 'lines': traffic.setLines(m.lines); break;
    case 'probe': scope.postMessage({ type: 'probe', seg: m.seg, ...traffic.probe(m.seg) }); break;
    case 'people': { const n = sim.net.nearestNode(m.x, m.z, 200); if (n >= 0) peds.spawnAt(n, m.count, m.color); break; }
    case 'hit': scope.postMessage({ type: 'hit', people: peds.hit(m.x, m.z, m.r, m.one), vehicles: m.one ? 0 : traffic.blast(m.x, m.z, m.r) }); break;
    case 'probeManoeuvres': scope.postMessage({ type: 'manoeuvres', ...traffic.manoeuvreList() }); break;
    case 'inspect': {
      const tv = traffic.inspect(m.x, m.z, m.r), lights: number[] = [];
      sim.net.nodeIndex.query(m.x - m.r, m.z - m.r, m.x + m.r, m.z + m.r, (n) => { if (sim.nodePhases[n] > 0) lights.push(n, traffic.lightState(n)); });
      scope.postMessage({ type: 'inspect', time: traffic.time, vehicles: tv.vehicles, clashes: tv.clashes, peds: peds.inspect(m.x, m.z, m.r), lights, ranRed: traffic.ranRed });
      break;
    }
    case 'probeNode': scope.postMessage({ type: 'probeNode', node: m.node, passed: traffic.nodePass[m.node] ?? 0, time: traffic.time }); break;
    case 'ops': {
      // every op is tried (one failing must not drop the ones after it); any failure means this mirror may now differ
      // from the page's network, so the page is asked for the whole network (at most every REPORT_AGAIN_MS)
      const n = m.ops.length / 8;
      let failure: unknown = null;
      for (let i = 0; i < n; i++) {
        try {
          const op = decodeOp(m.ops, i, m.extra);
          if (op.t === 'clear') { peds.clear(); traffic.clearAll(); }
          sim.apply(op);
        } catch (err) { failure ??= err; report('network change', err); }
      }
      const t = performance.now();
      if (failure !== null && t - resyncAt > REPORT_AGAIN_MS) {
        resyncAt = t;
        scope.postMessage({ type: 'resync', reason: String((failure as Error)?.message ?? failure) });
      }
      break;
    }
  }
};

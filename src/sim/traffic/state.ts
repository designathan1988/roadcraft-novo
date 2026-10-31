// The traffic's data vocabulary: the vehicle table's columns, the trip end reasons and the constants every vehicle
// system shares. Pure data; no Traffic instance, no state of its own.
import { driverSchema } from '../drivers.ts';
import type { Columns } from '../../core/table.ts';

export const ROUTE_CAP = 96;
export const MAX_VEHICLES = 1 << 16;
/** Dwell at a bus stop (s) and the detour's rejoin distance (nodes). */
export const DWELL = 14, REJOIN = 6;
/** Parking: how far into the bay the vehicle slides (m). */
export const PARK_SIDE_S = 2.4;
/** Jammed junction: someone waiting at the line and nobody has gone through for this long (s). */
export const JAM_SECONDS = 20;
/** Controlled release of a jammed junction: one vehicle every this many seconds. */
export const RELEASE_EVERY = 3;
/** Length of the crosswalk and its stop line at the end of a lane (m, as painted: jobs/roadMesh.ts CROSSWALK). */
export const CROSSWALK = 4.2;
/** Seconds a vehicle stands at its line giving way to people stepping onto the zebra before it is its turn. */
export const PED_COURTESY = 8;
/** A walker steps off in front of an approaching vehicle only with this many seconds to spare. */
export const PED_CRITICAL_GAP = 4;
/** Half widths of the vehicle kinds (car, bus, truck, motorbike, train), m. */
export const BODY_HALF_W = [0.9, 1.27, 1.25, 0.4, 1.5];
/** The stretch of a zebra a vehicle drives over: the heavy body's half width and 0.9 m either side of where its lane
 *  crosses it (roadcraft crossingSpans.ts:24 REACH). */
export const SPAN_REACH = 2.55 / 2 + 0.9;
/** A walker's body (m), the least pace (m/s) and the look-ahead (s) a walker on a zebra is counted with (roadcraft
 *  crossingSpans.ts:195-197 PED_BODY, PED_MIN_PACE, PED_REACH_TIME). */
export const PED_BODY = 1, PED_MIN_PACE = 0.8, PED_REACH_TIME = 4;
/** Allowance over the time a front takes to reach a zebra (roadcraft admission.ts:1005 CLEAR_MARGIN). */
export const CLEAR_MARGIN = 1.2;
/** Waiting for the same full exit for this long (s), the driver claims its turn on it. */
export const STARVE_SECONDS = 30;
/** A train on its route within this distance (m) of a level crossing closes the barrier. */
export const CROSSING_REACH = 160;

/** Numbers per vehicle in `Traffic.inspect`, and why a vehicle there may stand still (bits). */
export const INSPECT_STRIDE = 18;
export const INSPECT_RED = 1, INSPECT_BAY = 2, INSPECT_LEAVING = 4, INSPECT_STOP = 8, INSPECT_CHANGING = 16, INSPECT_GATE = 32, INSPECT_PASS = 64;

/** Length per kind: car, bus, truck, (person), train (3 wagons of 20 m). */
export const KIND_LEN = [4.4, 12, 9.5, 0.6, 62];
/** Passenger car styles (sedan, hatchback, SUV, van, pickup, motorbike) and each one's length. */
export const CAR_STYLE_LEN = [4.4, 3.9, 4.6, 4.9, 5.3, 2.1];
/** Light bits in the pose (× 65536 in the kind/colour field): brake, left indicator, right indicator. */
export const LIGHT_BRAKE = 1, LIGHT_LEFT = 2, LIGHT_RIGHT = 4;
/** Train wagons and the length of each. */
export const WAGONS = 3, WAGON_LEN = 20.5;

export const vehSchema = {
  lane: Int32Array, conn: Int32Array, s: Float32Array, v: Float32Array,
  // the connection it last came out of, onto its lane (its rear may still be on it: `backAlong`); -1 none
  cameBy: Int32Array,
  len: Float32Array, vf: Float32Array, micro: Uint8Array, kind: Uint8Array, color: Uint8Array,
  dest: Int32Array, rIdx: Uint8Array, rLen: Uint8Array,
  tExit: Float64Array,
  next: Int32Array, prev: Int32Array, // lane/connection list (micro), front to back
  px: Float32Array, py: Float32Array, pz: Float32Array, pyaw: Float32Array, has: Uint8Array,
  fade: Float32Array, phase: Uint8Array,
  lcFrom: Int32Array, lcT: Float32Array, lcCool: Float32Array,
  microIdx: Int32Array,
  // bus: line (-1 = ordinary car), next stop, dwell time, load, stop already served
  // stopI: an out-and-back line with 129 or more stops passes 258 (D44: Uint8 wrapped at 256)
  line: Int16Array, stopI: Uint16Array, dwell: Float32Array, load: Uint8Array, served: Uint8Array,
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
  // over the stop line with the way open: it goes through the junction without asking again (1)
  pass: Uint8Array,
  // the dock or bay it has reserved (Traffic.spots key; 0 = none)
  spot: Float64Array,
  // the driver (sim/drivers.ts): aggression, comfort figures, gap acceptance, politeness, patience
  ...driverSchema,
};

/** The vehicle table's columns (Traffic, sim/traffic.ts, owns the table). */
export type VehCols = Columns<typeof vehSchema>;
/** A column a module may read but not write: writing an element does not compile. */
export interface ReadColumn { readonly [i: number]: number; readonly length: number }
/**
 * The vehicle table as one traffic module sees it: every column readable, only the columns `W` writable. Each
 * module's host declares its `W`, so who writes which column is visible in one place and checked by the compiler;
 * moving a vehicle between lanes, connections and lists is done by Traffic's methods (it keeps the lists and the
 * counts consistent with the columns).
 */
export type VehAccess<W extends keyof VehCols> = { readonly [K in keyof VehCols]: K extends W ? VehCols[K] : ReadColumn };

/** How a vehicle's trip ends: arrived, lost (no route, its road removed, an explosion), or no trip at all (a bus). */
export const End = { Arrived: 0, Lost: 1, NoTrip: 2 } as const;
/**
 * Where a vehicle is in its life (the `phase` column). Driving: on its lane or a connection. Manoeuvre: pulling into
 * a parking bay or a loading dock, still in its lane's list. Parked: out of the lane (in the bay or at the dock), it
 * stays a moment and disappears. KerbStop: stopped at the kerb while a passenger gets out. Leaving: its trip ended;
 * it fades out where it is.
 */
export const VehPhase = { Driving: 0, Leaving: 1, Parked: 2, Manoeuvre: 3, KerbStop: 4 } as const;

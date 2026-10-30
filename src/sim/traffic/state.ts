// The traffic's data vocabulary: the vehicle table's columns, the trip end reasons and the constants every vehicle
// system shares. Pure data; no Traffic instance, no state of its own.
import { driverSchema } from '../drivers.ts';

export const ROUTE_CAP = 96;
export const MAX_VEHICLES = 1 << 16;
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
/** How near a walker on a zebra to where a vehicle's lane crosses it holds the vehicle (m). */
export const SPAN_REACH = 2.55 / 2 + 0.9 + 0.6;
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
  // over the stop line with the way open: it goes through the junction without asking again (1)
  pass: Uint8Array,
  // the dock or bay it has reserved (Traffic.spots key; 0 = none)
  spot: Float64Array,
  // the driver (sim/drivers.ts): aggression, comfort figures, gap acceptance, politeness, patience
  ...driverSchema,
};

/** How a vehicle's trip ends: arrived, lost (no route, its road removed, an explosion), or no trip at all (a bus). */
export const End = { Arrived: 0, Lost: 1, NoTrip: 2 } as const;

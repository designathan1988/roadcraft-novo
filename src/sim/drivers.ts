// The driver behind the wheel (roadcraft 4.0 `vehicles/driver.ts`, `vehicles/archetypes.ts`), kept as columns of the
// vehicle table: no object per vehicle. Each vehicle class has its own comfort figures; each driver an aggression,
// from timid (−1) to pushy (+1), that sets how hard they accelerate and brake, how close they follow, what gap they
// accept at a junction, how politely they change lanes and how long they wait before looking for another way round.

/**
 * Vehicle classes: comfortable acceleration a and deceleration b, emergency deceleration bE (m/s²), time headway T (s),
 * standstill gap s0 (m) and the share of the speed limit driven. Roadcraft 4.0's figures, scaled so its sedan matches
 * the headway and acceleration this engine was calibrated with (2.8 m/s², 2.2 m/s², 0.9 s, 2.2 m).
 */
export const ARCH = {
  sedan: [2.4, 2.9, 6.0, 1.2, 2.0, 1.0],
  hatch: [2.9, 3.2, 6.5, 1.0, 1.8, 1.08],
  suv: [2.2, 2.8, 5.8, 1.3, 2.1, 0.97],
  van: [1.9, 2.6, 5.5, 1.4, 2.2, 0.95],
  pickup: [2.1, 2.7, 5.6, 1.3, 2.1, 0.96],
  moto: [3.6, 3.6, 7.0, 0.8, 1.2, 1.12],
  // heavy vehicles keep this engine's calibration (2.2 m/s² both ways: buses and trains stop at the right spot, and
  // lines keep their timetable) with 4.0's longer headway and gap and its speed shares
  bus: [1.9, 2.9, 4.2, 1.6, 2.4, 0.8],
  truck: [1.8, 2.8, 4.4, 1.7, 2.6, 0.82],
  train: [1.9, 2.9, 3.0, 2.0, 3.0, 1.0],
} as const;
type ArchName = keyof typeof ARCH;
const SCALE_A = 2.8 / 2.4, SCALE_B = 2.2 / 2.9, SCALE_T = 0.9 / 1.2, SCALE_S0 = 2.2 / 2.0;

/** The class of a vehicle kind (0 car, 1 bus, 2 truck, 4 train) and car style (sedan, hatch, SUV, van, pickup, moto). */
export function archOf(kind: number, style: number): ArchName {
  if (kind === 1) return 'bus';
  if (kind === 2) return 'truck';
  if (kind === 4) return 'train';
  return (['sedan', 'hatch', 'suv', 'van', 'pickup', 'moto'] as const)[style] ?? 'sedan';
}

/** The driver columns of the vehicle table. */
export const driverSchema = {
  /** −1 timid, 0 ordinary, +1 pushy. */
  aggr: Float32Array,
  /** Comfortable acceleration and deceleration, emergency deceleration (m/s²), headway (s), standstill gap (m). */
  da: Float32Array, db: Float32Array, dbe: Float32Array, dT: Float32Array, ds0: Float32Array,
  /** Multiplies the critical gap a yielding movement demands. */
  gapF: Float32Array,
  /** MOBIL politeness (weight of the others' gain) and threshold (gain an overtake must be worth, m/s²). */
  polite: Float32Array, lcTh: Float32Array,
  /** Slow wander of the desired speed: amplitude (share), rate (rad/s), phase. */
  driftA: Float32Array, driftR: Float32Array, driftP: Float32Array,
  /** Seconds held up before looking for another way round. */
  patience: Float32Array,
  /** The acceleration of the last step (the foot on the pedal: the next one changes at a driver's jerk). */
  acc: Float32Array,
} as const;
type Cols = { [K in keyof typeof driverSchema]: InstanceType<(typeof driverSchema)[K]> };

/** Spread of the comfort figures between the timid and the pushy (roadcraft 4.0). */
const ACCEL_SPREAD = 0.3, BRAKE_SPREAD = 0.22, HEADWAY_SPREAD = 0.32, GAP_SPREAD = 0.28, EMERGENCY_SPREAD = 0.025;

/**
 * Draws the driver of vehicle `v` of class `arch` (`sample` gives uniforms in [0, 1)). Returns the share of the speed
 * limit the class drives at. Aggression is triangular: most drivers ordinary, the extremes rare.
 */
export function drawDriver(c: Cols, v: number, arch: ArchName, sample: () => number): number {
  const [a, b, bE, T, s0, speed] = ARCH[arch];
  const g = Math.max(-1, Math.min(1, (sample() + sample() - 1) * 1.15));
  c.aggr[v] = g;
  c.da[v] = a * SCALE_A * (1 + g * ACCEL_SPREAD);
  c.db[v] = b * SCALE_B * (1 + g * BRAKE_SPREAD);
  c.dbe[v] = bE * (1 + g * EMERGENCY_SPREAD);
  // inverted: the pushy driver keeps a shorter headway and a smaller gap
  c.dT[v] = T * SCALE_T * (1 - g * HEADWAY_SPREAD);
  c.ds0[v] = s0 * SCALE_S0 * (1 - g * GAP_SPREAD * 0.6);
  c.gapF[v] = 1 - g * GAP_SPREAD;
  // a polite driver weighs the cars a lane change would inconvenience; a pushy one barely notices them, and needs less
  c.polite[v] = Math.max(0.05, Math.min(0.8, 0.45 - g * 0.3));
  c.lcTh[v] = Math.max(0.08, Math.min(0.7, 0.35 - g * 0.22));
  // independent of aggression: nobody holds an exact speed
  c.driftA[v] = 0.025 + sample() * 0.045;
  c.driftR[v] = 0.06 + sample() * 0.12;
  c.driftP[v] = sample() * Math.PI * 2;
  c.patience[v] = 6 + (1 - g) * 7;
  c.acc[v] = 0;
  // the class's share of the limit, and each driver a little faster or slower (0.92-1.08)
  return speed * (0.92 + sample() * 0.16);
}

/** Share of the heuristic in the IIDM/CAH blend (Treiber & Kesting use 0.99). */
const COOLNESS = 0.99;
/** Fastest a driver's acceleration rises (easing on) and falls (braking harder), m/s³. */
export const JERK_UP = 2.5, JERK_DOWN = 8;
/** Below this speed (m/s) a driver lifts off at once. */
const CRAWL = 1;

/**
 * The acceleration driver `u` (at speed `v`, aiming for `v0`) applies this step with an obstacle `gap` m ahead
 * moving at `vl` and accelerating at `al` (gap ≥ 1e8: free road). Roadcraft 4.0's operational model
 * (`drive/operational.ts`, `vehicles/idm.ts`): the improved IDM (no creeping drift below the desired speed, a
 * comfortable slow-down above it), blended with the constant-acceleration heuristic (a car cutting in ahead but
 * pulling away is not braked for as if it stood still); the pedal moves at the driver's jerk (easing on at
 * JERK_UP, ordinary braking at JERK_DOWN; braking harder than comfortable is never held back), and the speed never
 * exceeds the one from which an emergency stop still ends short of the obstacle. The queue-discharge relief of this
 * engine stays (a queue moves off together, without an accordion). `stopRoom`: where it must have stopped by (a bus
 * or train stop), checked like the obstacle.
 */
export function driveAccel(c: Cols, u: number, v: number, v0: number, gap: number, vl: number, al: number, dt: number, stopRoom = 1e9): number {
  const a = c.da[u], b = c.db[u], bE = c.dbe[u];
  const v0s = Math.max(v0, 0.01);
  const free = v <= v0s ? a * (1 - (v / v0s) ** 4) : -b * (1 - Math.pow(v0s / v, (a * 4) / b));
  let target = free;
  if (gap < 1e8) {
    const rel = vl > 0.3 && v < 4 ? 0.6 * (1 - v / 4) * Math.min(1, vl / 1.5) : 0;
    const sStar = c.ds0[u] * (1 - rel) + Math.max(0, v * c.dT[u] * (1 - rel) + (v * (v - vl)) / (2 * Math.sqrt(a * b)));
    const s = Math.max(gap, 0.02), z = sStar / s;
    const iidm = v <= v0s ? (z >= 1 ? a * (1 - z * z) : free * (1 - Math.pow(z, (2 * a) / Math.max(free, 1e-6))))
      : (z >= 1 ? free + a * (1 - z * z) : free);
    const alc = Math.max(-bE, Math.min(a, al));
    const cah = vl * (v - vl) <= -2 * s * alc ? (v * v * alc) / Math.max(vl * vl - 2 * s * alc, 1e-6)
      : alc - (Math.max(0, v - vl) ** 2) / (2 * s);
    target = iidm >= cah ? iidm : (1 - COOLNESS) * iidm + COOLNESS * (cah + b * Math.tanh((iidm - cah) / b));
  }
  target = Math.max(-bE, Math.min(a, target));
  const foot = Math.max(-bE, Math.min(a, c.acc[u]));
  let acc = target < -b || (v < CRAWL && target < foot) ? Math.min(target, foot + JERK_UP * dt)
    : Math.max(foot - JERK_DOWN * dt, Math.min(foot + JERK_UP * dt, target));
  if (gap < 1e8 || stopRoom < 1e8) {
    // the emergency-stop cap: fast enough only to still stop short of it (what it needs to stop counts for one moving)
    const room = Math.max(0, Math.min(stopRoom, gap - 0.3 + (vl > 0 ? (vl * vl) / (2 * bE) : 0)));
    const safe = -bE * dt + Math.sqrt(bE * bE * dt * dt + 2 * bE * room);
    if (v + acc * dt > safe) acc = (safe - v) / dt;
  }
  return acc;
}

/**
 * Lateral acceleration a driver accepts in a bend (roadcraft 4.0 `params.ts`): 4 m/s², falling by 0.09 per m/s of
 * speed, never below 1.8; heavy vehicles take 70 % of it; ±20 % with aggression.
 */
const MAX_LATERAL = 4.0, LATERAL_FALL = 0.09, MIN_LATERAL = 1.8, HEAVY_SHARE = 0.7, AGGRESSION_SHARE = 0.2;

/**
 * Fastest speed (m/s) driver `u` takes a bend of curvature `k` (1/m) at (roadcraft 4.0 `vehicles/curvature.ts`):
 * the lateral acceleration v²k within the comfort that falls with speed (a0 − c·v), or the floor's.
 */
export function bendSpeed(c: Cols, u: number, k: number, heavy: boolean): number {
  if (k < 1e-4) return Infinity;
  const share = (1 + AGGRESSION_SHARE * c.aggr[u]) * (heavy ? HEAVY_SHARE : 1);
  const a0 = share * MAX_LATERAL, fall = share * LATERAL_FALL;
  const v = (-fall + Math.sqrt(fall * fall + 4 * k * a0)) / (2 * k);
  return Math.max(v, Math.sqrt((share * MIN_LATERAL) / k));
}

/** The speed driver `v` aims for now, around `v0`. */
export function desiredSpeed(c: Cols, v: number, v0: number, time: number): number {
  return v0 * (1 + c.driftA[v] * Math.sin(c.driftP[v] + time * c.driftR[v]));
}

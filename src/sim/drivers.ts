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
  // the class's share of the limit, and each driver a little faster or slower (0.92-1.08)
  return speed * (0.92 + sample() * 0.16);
}

/** The speed driver `v` aims for now, around `v0`. */
export function desiredSpeed(c: Cols, v: number, v0: number, time: number): number {
  return v0 * (1 + c.driftA[v] * Math.sin(c.driftP[v] + time * c.driftR[v]));
}

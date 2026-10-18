// Reeds-Shepp paths (a car that goes forward and in reverse with a minimum turning radius), for the parking and
// loading-dock manoeuvres in the micro window. The CSC and CCC families with their time-flip, reflection and
// backwards variants (Reeds & Shepp 1990; the formulas as in OMPL's ReedsSheppStateSpace). That covers parallel
// parking (two reverse arcs), backing a truck into a dock (arc, straight, arc in reverse) and pulling out.
// Pure maths, no allocation per query beyond the result; a query is a few dozen trigonometric calls.

/** Segment kinds: turn left, straight, turn right. */
export const Seg = { L: 1, S: 0, R: -1 } as const;

/** A path of up to 3 segments: kind (Seg) and signed length in radius units (negative = in reverse). */
export interface RSPath { kinds: number[]; lens: number[]; total: number }

const TWO_PI = Math.PI * 2;
const EPS = 1e-9;

function mod2pi(x: number): number {
  let v = x % TWO_PI;
  if (v < -Math.PI) v += TWO_PI;
  else if (v > Math.PI) v -= TWO_PI;
  return v;
}

function polar(x: number, y: number): [number, number] { return [Math.sqrt(x * x + y * y), Math.atan2(y, x)]; }

function LpSpLp(x: number, y: number, phi: number): [number, number, number] | null {
  const [u, t] = polar(x - Math.sin(phi), y - 1 + Math.cos(phi));
  if (t >= -EPS) { const v = mod2pi(phi - t); if (v >= -EPS) return [t, u, v]; }
  return null;
}

function LpSpRp(x: number, y: number, phi: number): [number, number, number] | null {
  const [u1, t1] = polar(x + Math.sin(phi), y - 1 - Math.cos(phi));
  const u2 = u1 * u1;
  if (u2 >= 4) {
    const u = Math.sqrt(u2 - 4), theta = Math.atan2(2, u);
    const t = mod2pi(t1 + theta), v = mod2pi(t - phi);
    if (t >= -EPS && v >= -EPS) return [t, u, v];
  }
  return null;
}

function LpRmL(x: number, y: number, phi: number): [number, number, number] | null {
  const xi = x - Math.sin(phi), eta = y - 1 + Math.cos(phi);
  const [u1, theta] = polar(xi, eta);
  if (u1 <= 4) {
    const u = -2 * Math.asin(0.25 * u1);
    const t = mod2pi(theta + 0.5 * u + Math.PI), v = mod2pi(phi - t + u);
    if (t >= -EPS && u <= EPS) return [t, u, v];
  }
  return null;
}

const L = Seg.L, S = Seg.S, R = Seg.R;

/** All candidate paths from the origin facing +x (y to the left) to (x, y, phi), radius 1. */
function candidates(x: number, y: number, phi: number): RSPath[] {
  const out: RSPath[] = [];
  const add = (k: number[], r: [number, number, number] | null, sign: number, rev = false) => {
    if (!r) return;
    const lens = (rev ? [r[2], r[1], r[0]] : r).map((v) => v * sign);
    out.push({ kinds: k, lens, total: Math.abs(lens[0]) + Math.abs(lens[1]) + Math.abs(lens[2]) });
  };
  // CSC
  add([L, S, L], LpSpLp(x, y, phi), 1);
  add([L, S, L], LpSpLp(-x, y, -phi), -1);
  add([R, S, R], LpSpLp(x, -y, -phi), 1);
  add([R, S, R], LpSpLp(-x, -y, phi), -1);
  add([L, S, R], LpSpRp(x, y, phi), 1);
  add([L, S, R], LpSpRp(-x, y, -phi), -1);
  add([R, S, L], LpSpRp(x, -y, -phi), 1);
  add([R, S, L], LpSpRp(-x, -y, phi), -1);
  // CCC
  add([L, R, L], LpRmL(x, y, phi), 1);
  add([L, R, L], LpRmL(-x, y, -phi), -1);
  add([R, L, R], LpRmL(x, -y, -phi), 1);
  add([R, L, R], LpRmL(-x, -y, phi), -1);
  // CCC backwards (the same curve driven from the goal)
  const xb = x * Math.cos(phi) + y * Math.sin(phi), yb = x * Math.sin(phi) - y * Math.cos(phi);
  add([L, R, L], LpRmL(xb, yb, phi), 1, true);
  add([L, R, L], LpRmL(-xb, yb, -phi), -1, true);
  add([R, L, R], LpRmL(xb, -yb, -phi), 1, true);
  add([R, L, R], LpRmL(-xb, -yb, phi), -1, true);
  return out;
}

/** End pose of a path from (0, 0, 0), radius 1 (x forward, y left, phi counter-clockwise). */
export function integrate(p: RSPath, upTo = Infinity): [number, number, number] {
  let x = 0, y = 0, phi = 0, left = upTo;
  for (let i = 0; i < p.kinds.length && left > 0; i++) {
    const full = p.lens[i], l = Math.sign(full) * Math.min(Math.abs(full), left);
    left -= Math.abs(l);
    const k = p.kinds[i];
    if (k === 0) { x += Math.cos(phi) * l; y += Math.sin(phi) * l; }
    else { const p1 = phi + k * l; x += (Math.sin(p1) - Math.sin(phi)) / k; y += (Math.cos(phi) - Math.cos(p1)) / k; phi = p1; }
  }
  return [x, y, phi];
}

/**
 * Shortest path among the families above from pose a to pose b (world: forward = (sin yaw, cos yaw), as the
 * vehicle poses), with turning radius r (m). `maxReverse`: longest stretch in reverse allowed (m). Null when none.
 */
export function planRS(ax: number, az: number, ayaw: number, bx: number, bz: number, byaw: number, r: number, maxReverse = Infinity): RSPath | null {
  // goal in the start frame: forward f = (sin a, cos a), left l = (cos a, -sin a)
  const dx = bx - ax, dz = bz - az;
  const fx = Math.sin(ayaw), fz = Math.cos(ayaw), lx = Math.cos(ayaw), lz = -Math.sin(ayaw);
  const x = (dx * fx + dz * fz) / r, y = (dx * lx + dz * lz) / r, phi = mod2pi(byaw - ayaw);
  let best: RSPath | null = null;
  for (const c of candidates(x, y, phi)) {
    let rev = 0;
    for (const l of c.lens) if (l < 0) rev += -l * r;
    if (rev > maxReverse) continue;
    if (!best || c.total < best.total) best = c;
  }
  if (!best) return null;
  return { kinds: best.kinds, lens: best.lens.map((v) => v * r), total: best.total * r };
}

/**
 * Pose along a path in metres (radius r) at distance `d` from its start pose (ax, az, ayaw): [x, z, yaw, gear]
 * (gear 1 forward, −1 reverse) into `out`.
 */
export function poseAlong(p: RSPath, r: number, ax: number, az: number, ayaw: number, d: number, out: Float64Array): void {
  let x = 0, y = 0, phi = 0, left = d, gear = 1;
  for (let i = 0; i < p.kinds.length; i++) {
    const full = p.lens[i] / r;
    if (Math.abs(full) < 1e-9) continue;
    gear = full < 0 ? -1 : 1;
    if (left <= 0) break;
    const l = Math.sign(full) * Math.min(Math.abs(full), left / r);
    left -= Math.abs(l) * r;
    const k = p.kinds[i];
    if (k === 0) { x += Math.cos(phi) * l; y += Math.sin(phi) * l; }
    else { const p1 = phi + k * l; x += (Math.sin(p1) - Math.sin(phi)) / k; y += (Math.cos(phi) - Math.cos(p1)) / k; phi = p1; }
  }
  const fx = Math.sin(ayaw), fz = Math.cos(ayaw), lx = Math.cos(ayaw), lz = -Math.sin(ayaw);
  out[0] = ax + (x * fx + y * lx) * r;
  out[1] = az + (x * fz + y * lz) * r;
  out[2] = ayaw + phi;
  out[3] = gear;
}

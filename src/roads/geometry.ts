// Pure road geometry: quadratic Bézier curves, length, closest point, exact split, crossings and each arm's setback
// at a node. Used on the page and in the workers. XZ plane; the "left" of d = (d.z, -d.x).

export interface Quad { x0: number; z0: number; cx: number; cz: number; x1: number; z1: number }

export function bez(q: Quad, t: number, out: Float64Array): void {
  const s = 1 - t;
  out[0] = s * s * q.x0 + 2 * s * t * q.cx + t * t * q.x1;
  out[1] = s * s * q.z0 + 2 * s * t * q.cz + t * t * q.z1;
}

/** Derivative (not normalized). */
export function bezD(q: Quad, t: number, out: Float64Array): void {
  out[0] = 2 * (1 - t) * (q.cx - q.x0) + 2 * t * (q.x1 - q.cx);
  out[1] = 2 * (1 - t) * (q.cz - q.z0) + 2 * t * (q.z1 - q.cz);
}

const tmp = new Float64Array(2);

export function bezLength(q: Quad, steps = 24): number {
  let len = 0, px = q.x0, pz = q.z0;
  for (let i = 1; i <= steps; i++) {
    bez(q, i / steps, tmp);
    len += Math.hypot(tmp[0] - px, tmp[1] - pz);
    px = tmp[0]; pz = tmp[1];
  }
  return len;
}

/** Table of accumulated length (to walk by distance). */
export function arcTable(q: Quad, steps: number): Float64Array {
  const t = new Float64Array(steps + 1);
  let px = q.x0, pz = q.z0;
  for (let i = 1; i <= steps; i++) {
    bez(q, i / steps, tmp);
    t[i] = t[i - 1] + Math.hypot(tmp[0] - px, tmp[1] - pz);
    px = tmp[0]; pz = tmp[1];
  }
  return t;
}

/** Parameter t for a distance along the curve, by the table. */
export function tAtLength(table: Float64Array, s: number): number {
  const n = table.length - 1;
  if (s <= 0) return 0;
  if (s >= table[n]) return 1;
  let lo = 0, hi = n;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (table[m] < s) lo = m; else hi = m; }
  const f = (s - table[lo]) / Math.max(1e-9, table[hi] - table[lo]);
  return (lo + f) / n;
}

/** Splits at t (de Casteljau, exact). */
export function splitQuad(q: Quad, t: number): [Quad, Quad] {
  const ax = q.x0 + (q.cx - q.x0) * t, az = q.z0 + (q.cz - q.z0) * t;
  const bx = q.cx + (q.x1 - q.cx) * t, bz = q.cz + (q.z1 - q.cz) * t;
  const mx = ax + (bx - ax) * t, mz = az + (bz - az) * t;
  return [
    { x0: q.x0, z0: q.z0, cx: ax, cz: az, x1: mx, z1: mz },
    { x0: mx, z0: mz, cx: bx, cz: bz, x1: q.x1, z1: q.z1 },
  ];
}

/** Trecho de t0 a t1. */
export function subQuad(q: Quad, t0: number, t1: number): Quad {
  if (t0 <= 0) return splitQuad(q, t1)[0];
  const right = splitQuad(q, t0)[1];
  return splitQuad(right, (t1 - t0) / (1 - t0))[0];
}

/** Closest point: samples and refines. Returns [t, distance]. */
export function closestT(q: Quad, x: number, z: number): [number, number] {
  let best = 0, bd = Infinity;
  const N = 32;
  for (let i = 0; i <= N; i++) {
    bez(q, i / N, tmp);
    const d = (tmp[0] - x) ** 2 + (tmp[1] - z) ** 2;
    if (d < bd) { bd = d; best = i / N; }
  }
  let step = 1 / N;
  for (let k = 0; k < 12; k++) {
    step /= 2;
    for (const t of [best - step, best + step]) {
      if (t < 0 || t > 1) continue;
      bez(q, t, tmp);
      const d = (tmp[0] - x) ** 2 + (tmp[1] - z) ** 2;
      if (d < bd) { bd = d; best = t; }
    }
  }
  return [best, Math.sqrt(bd)];
}

/** Cruzamentos entre duas curvas: lista de [ta, tb]. */
export function intersectQuads(a: Quad, b: Quad, steps = 24): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const pa = new Float64Array((steps + 1) * 2), pb = new Float64Array((steps + 1) * 2);
  for (let i = 0; i <= steps; i++) {
    bez(a, i / steps, tmp); pa[i * 2] = tmp[0]; pa[i * 2 + 1] = tmp[1];
    bez(b, i / steps, tmp); pb[i * 2] = tmp[0]; pb[i * 2 + 1] = tmp[1];
  }
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps; j++) {
      const r = segSeg(pa[i * 2], pa[i * 2 + 1], pa[i * 2 + 2], pa[i * 2 + 3], pb[j * 2], pb[j * 2 + 1], pb[j * 2 + 2], pb[j * 2 + 3]);
      if (r) out.push([(i + r[0]) / steps, (j + r[1]) / steps]);
    }
  }
  return out;
}

/** Intersection of two line segments: [s, t] in [0,1] or null. */
export function segSeg(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): [number, number] | null {
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return null;
  const qx = cx - ax, qz = cz - az;
  const s = (qx * sz - qz * sx) / den;
  const t = (qx * rz - qz * rx) / den;
  if (s < 0 || s > 1 || t < 0 || t > 1) return null;
  return [s, t];
}

/** Intersection of two lines (point + direction): parameters [s, t] or null when parallel. */
export function lineLine(px: number, pz: number, dx: number, dz: number, qx: number, qz: number, ex: number, ez: number): [number, number] | null {
  const den = dx * ez - dz * ex;
  if (Math.abs(den) < 1e-9) return null;
  const wx = qx - px, wz = qz - pz;
  return [(wx * ez - wz * ex) / den, (wx * dz - wz * dx) / den];
}

/** A node's arm: outward direction (unit) and the half widths to its left and right. */
export interface Arm { dx: number; dz: number; left: number; right: number; asphLeft: number; asphRight: number }

/**
 * Each arm's setback: how far before the node the road ends so that neighbouring arms' edges do not overlap, plus
 * the corner's radius. The arms must already be sorted by angle (anticlockwise seen from above).
 */
export function armRetreats(arms: Arm[], cornerRadius: number, out: Float64Array): void {
  const n = arms.length;
  for (let i = 0; i < n; i++) out[i] = 0;
  if (n < 2) return;
  if (n === 2) {
    // continuation: a mitre joint; set back only as much as the bend needs
    const a = arms[0], b = arms[1];
    const dot = Math.max(-1, Math.min(1, a.dx * b.dx + a.dz * b.dz));
    const turn = Math.PI - Math.acos(dot); // 0 = reto
    const w = Math.max(a.left, a.right, b.left, b.right);
    const widthChange = Math.abs(a.left - b.right) + Math.abs(a.right - b.left);
    // a road going straight on with a change of width: a 1 in 8 taper of the largest half-width change (sidewalk or
    // asphalt), at least 9.6 m, half on each side (roadcraft `junction/transition.ts`)
    const step = Math.max(Math.abs(a.left - b.right), Math.abs(a.right - b.left), Math.abs(a.asphLeft - b.asphRight), Math.abs(a.asphRight - b.asphLeft));
    const taper = turn < Math.PI / 6 && step >= 0.3 ? Math.max(9.6, step * 8) / 2 : widthChange > 0.5 ? 3 : 0;
    const r = Math.min(60, w * Math.tan(Math.min(turn, 2.6) / 2) + taper);
    out[0] = r; out[1] = r;
    return;
  }
  for (let i = 0; i < n; i++) {
    const a = arms[i], b = arms[(i + 1) % n];
    // a's left with b's right (b is the next one anticlockwise, so a's left faces b)
    const lax = a.dz, laz = -a.dx; // esquerda de a
    const rbx = -b.dz, rbz = b.dx; // direita de b
    const dot = a.dx * b.dx + a.dz * b.dz;
    if (dot < -0.97) continue; // quase opostos: sem esquina entre eles
    const r = lineLine(lax * a.left, laz * a.left, a.dx, a.dz, rbx * b.right, rbz * b.right, b.dx, b.dz);
    let ta = 0, tb = 0;
    if (r && r[0] > -50 && r[1] > -50) { ta = r[0]; tb = r[1]; }
    else if (!r) { ta = tb = Math.max(a.left, b.right); }
    const pad = cornerRadius;
    out[i] = Math.max(out[i], ta + pad);
    out[(i + 1) % n] = Math.max(out[(i + 1) % n], tb + pad);
  }
  for (let i = 0; i < n; i++) out[i] = Math.max(0, Math.min(out[i], 60));
}

/** Angle to sort arms by (anticlockwise seen from above, with z "down" on the screen). */
export function armAngle(dx: number, dz: number): number {
  return Math.atan2(-dz, dx);
}

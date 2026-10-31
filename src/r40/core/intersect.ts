import { EPS } from './scalar.ts';
import { type Vec2, add, sub, scale, cross } from './vec2.ts';

/** Intersection of the infinite line through `a0` with direction `da` and the infinite line through `b0` with direction */
export function lineLine(
  a0: Vec2,
  da: Vec2,
  b0: Vec2,
  db: Vec2,
  sinEps = EPS,
): { point: Vec2; sA: number; sB: number } | null {
  const den = cross(da, db);
  if (Math.abs(den) < sinEps) return null;
  const w = sub(b0, a0);
  const sA = cross(w, db) / den;
  const sB = cross(w, da) / den;
  return { point: add(a0, scale(da, sA)), sA, sB };
}

/** Intersection of the finite segments a->b and c->d. */
export function segSeg(
  a: Vec2,
  b: Vec2,
  c: Vec2,
  d: Vec2,
): { point: Vec2; t: number; u: number } | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const den = cross(r, s);
  if (Math.abs(den) < EPS) return null; // parallel or degenerate
  const w = sub(c, a);
  const t = cross(w, s) / den;
  const u = cross(w, r) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { point: add(a, scale(r, t)), t, u };
}

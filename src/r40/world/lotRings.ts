import type { Vec2 } from '../core/vec2.ts';

export function hull(points: readonly Vec2[]): Vec2[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Vec2, a: Vec2, b: Vec2): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [], upper: Vec2[] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]!; while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop(); upper.push(q); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** The boundary's area centroid (the corners' mean for a degenerate one). */
export function lotCentre(l: { readonly corners: readonly Vec2[] }): Vec2 {
  const q = l.corners;
  let a = 0, x = 0, y = 0;
  for (let i = 0; i < q.length; i++) {
    const p = q[i]!, r = q[(i + 1) % q.length]!;
    const c = p.x * r.y - r.x * p.y;
    a += c; x += (p.x + r.x) * c; y += (p.y + r.y) * c;
  }
  if (Math.abs(a) < 1e-9) return { x: q.reduce((s, p) => s + p.x, 0) / q.length, y: q.reduce((s, p) => s + p.y, 0) / q.length };
  return { x: x / (3 * a), y: y / (3 * a) };
}

// The b40 clash test a hung part makes against the body (the subset of 4.0 elements.ts elementClash the massing
// uses: a canopy, an awning, a veranda slab or post against the blocks). The full element rules come with the lot.
import { B40_ELEMENT } from '../../world/b40Kinds.ts';
import type { B40Table } from './volumes.ts';

const ON_FACADE = new Set<number>([B40_ELEMENT.Canopy, B40_ELEMENT.Ac, B40_ELEMENT.Awning, B40_ELEMENT.Clock]);
const EPS = 1e-9;

/** Height of a floor above the building's ground floor (no per-level overrides in a made body). */
export const levelElevation = (t: B40Table, level: number): number =>
  level <= 0 ? 0 : t.groundHeight + (level - 1) * t.storeyHeight;

/** A volume's vertical span, its lift included. */
export function volumeSpan(t: B40Table, v: number): [number, number] {
  const lift = Number.isFinite(t.lift[v]) ? t.lift[v]! : 0;
  const z0 = t.base[v]! === 0 ? Math.min(0, lift) : lift + levelElevation(t, t.base[v]!);
  return [z0, lift + levelElevation(t, t.base[v]! + t.storeys[v]!)];
}

/** The axis-aligned rectangle of an element, its turn included (4.0 elementRect). */
export function elementRect(e: { x: number; y: number; w: number; d: number; facing: number; angle?: number }): [number, number, number, number] {
  const alongY = e.facing === 0 || e.facing === 2;
  const sx = alongY ? e.w : e.d, sy = alongY ? e.d : e.w;
  const a = e.angle ?? 0;
  if (!a) return [e.x - sx / 2, e.y - sy / 2, e.x + sx / 2, e.y + sy / 2];
  const cs = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a));
  const hx = (sx * cs + sy * sn) / 2, hy = (sx * sn + sy * cs) / 2;
  return [e.x - hx, e.y - hy, e.x + hx, e.y + hy];
}

/** Whether a point is in a volume's plan (rectangle or outline, normalized). */
function inPlan(t: B40Table, v: number, x: number, y: number): boolean {
  const n = t.outlineN[v]!;
  if (n === 0) return x >= t.x[v]! - EPS && x <= t.x[v]! + t.w[v]! + EPS && y >= t.y[v]! - EPS && y <= t.y[v]! + t.d[v]! + EPS;
  let inside = false;
  const at = t.outlineAt[v]!;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = t.x[v]! + t.outline[at + i * 2]! * t.w[v]!, yi = t.y[v]! + t.outline[at + i * 2 + 1]! * t.d[v]!;
    const xj = t.x[v]! + t.outline[at + j * 2]! * t.w[v]!, yj = t.y[v]! + t.outline[at + j * 2 + 1]! * t.d[v]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The first volume a hung part would stand inside of, or −1 (4.0 elementClash, the massing subset). */
export function elementClash(t: B40Table, e: { x: number; y: number; w: number; d: number; facing: number; angle?: number; z: number; h: number; kind: number }): number {
  const [x0, y0, x1, y1] = elementRect(e);
  const z0 = e.z, z1 = e.z + e.h;
  const facade = ON_FACADE.has(e.kind);
  for (let v = 0; v < t.n; v++) {
    if (t.open[v]! >= 0 || t.mode[v]! === 1 || t.mode[v]! === 2) continue;
    const [vz0, vz1] = volumeSpan(t, v);
    if (!(z0 < vz1 - EPS && vz0 < z1 - EPS)) continue;
    if (facade) {
      if (inPlan(t, v, e.x, e.y)) return v;
    } else if (t.outlineN[v]! === 0) {
      if (x0 < t.x[v]! + t.w[v]! - EPS && t.x[v]! < x1 - EPS && y0 < t.y[v]! + t.d[v]! - EPS && t.y[v]! < y1 - EPS) return v;
    } else if (inPlan(t, v, x0, y0) || inPlan(t, v, x1, y0) || inPlan(t, v, x1, y1) || inPlan(t, v, x0, y1)) return v;
    else {
      // The outline's bounding box for a part wholly outside or wholly inside: a rough test, as the massing's
      // hung parts stand on plain blocks; the lot's full overlap comes with the elements table.
      if (x0 < t.x[v]! + t.w[v]! - EPS && t.x[v]! < x1 - EPS && y0 < t.y[v]! + t.d[v]! - EPS && t.y[v]! < y1 - EPS) return v;
    }
  }
  return -1;
}

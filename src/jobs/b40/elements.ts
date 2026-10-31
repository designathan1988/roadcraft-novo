// The b40 element rules: which parts stand in each other, which are structure, which follow the ground. The rules
// and tolerances are Roadcraft 4.0 elements.ts; the data is the lot's element columns, read by index.
import { B40_ELEMENT } from '../../world/b40Kinds.ts';
import type { B40Table } from './volumes.ts';

const F_SURFACE = 1, F_BOUNDARY = 2, F_PLANT = 4, F_FOLLOWS = 8, F_EARTHWORK = 16, F_FACADE = 32;
const FLAGS = new Uint8Array(32);
const set = (k: number, f: number): void => { FLAGS[k] = FLAGS[k]! | f; };
for (const k of [B40_ELEMENT.Pavement, B40_ELEMENT.Drain, B40_ELEMENT.Parking]) set(k, F_SURFACE);
for (const k of [B40_ELEMENT.Wall, B40_ELEMENT.Fence, B40_ELEMENT.Hedge, B40_ELEMENT.Railing, B40_ELEMENT.Gate, B40_ELEMENT.Pillar]) set(k, F_BOUNDARY);
for (const k of [B40_ELEMENT.Flowers, B40_ELEMENT.Shrub, B40_ELEMENT.Hedge, B40_ELEMENT.Planter]) set(k, F_PLANT);
for (const k of [
  B40_ELEMENT.Wall, B40_ELEMENT.Fence, B40_ELEMENT.Railing, B40_ELEMENT.Pavement, B40_ELEMENT.Hedge, B40_ELEMENT.Bin,
  B40_ELEMENT.Lamp, B40_ELEMENT.Bollard, B40_ELEMENT.Drain, B40_ELEMENT.Planter, B40_ELEMENT.Bench, B40_ELEMENT.Rocks,
  B40_ELEMENT.Flowers, B40_ELEMENT.Shrub, B40_ELEMENT.Tree, B40_ELEMENT.Gate,
]) set(k, F_FOLLOWS);
for (const k of [B40_ELEMENT.Stair, B40_ELEMENT.Ramp]) set(k, F_EARTHWORK);
for (const k of [B40_ELEMENT.Canopy, B40_ELEMENT.Ac, B40_ELEMENT.Awning, B40_ELEMENT.Clock]) set(k, F_FACADE);

export const SURFACE_KINDS = (k: number): boolean => (FLAGS[k]! & F_SURFACE) !== 0;
export const BOUNDARY_KINDS = (k: number): boolean => (FLAGS[k]! & F_BOUNDARY) !== 0;
export const PLANT_KINDS = (k: number): boolean => (FLAGS[k]! & F_PLANT) !== 0;
export const FOLLOWS_GROUND = (k: number): boolean => (FLAGS[k]! & F_FOLLOWS) !== 0;
export const FACADE_KINDS = (k: number): boolean => (FLAGS[k]! & F_FACADE) !== 0;

const MEET = 0.03, TRUNK = 0.4, CROWN_FROM = 0.35;

export interface ElementFields {
  kind: number; x: number; y: number; z: number; w: number; d: number; h: number; facing: number; angle: number;
  matFinish: number; matColour: number;
}

export function fieldsOf(t: B40Table, i: number): ElementFields {
  const ref = t.elMat[i]!;
  return {
    kind: t.elKind[i]!, x: t.elX[i]!, y: t.elY[i]!, z: t.elZ[i]!, w: t.elW[i]!, d: t.elD[i]!, h: t.elH[i]!,
    facing: t.elFacing[i]!, angle: Number.isFinite(t.elAngle[i]) ? t.elAngle[i]! : 0,
    matFinish: ref >= 0 ? t.matFinish[ref]! : -1, matColour: ref >= 0 ? t.matColour[ref]! : 0,
  };
}

const isRetainingStone = (e: ElementFields): boolean => e.matFinish === 4 && e.matColour === 0x9a948a;

export const isEarthwork = (e: ElementFields): boolean => e.kind === B40_ELEMENT.Stair || e.kind === B40_ELEMENT.Ramp || (e.kind === B40_ELEMENT.Slab && isRetainingStone(e));
export const isStructure = (e: ElementFields): boolean => BOUNDARY_KINDS(e.kind) || isEarthwork(e);

const alongY = (e: ElementFields): boolean => e.facing === 0 || e.facing === 2;
export const planReach = (e: ElementFields): number => Math.hypot(Math.max(e.w, TRUNK), Math.max(e.d, TRUNK)) / 2;

interface Foot { cx: number; cy: number; hx: number; hy: number; a: number }
function footprint(e: ElementFields, out: Foot, size?: number): Foot {
  const ay = alongY(e);
  out.cx = e.x; out.cy = e.y;
  out.hx = (size ?? (ay ? e.w : e.d)) / 2; out.hy = (size ?? (ay ? e.d : e.w)) / 2;
  out.a = e.angle;
  return out;
}
const fa: Foot = { cx: 0, cy: 0, hx: 0, hy: 0, a: 0 }, fb: Foot = { cx: 0, cy: 0, hx: 0, hy: 0, a: 0 };

const reachAlong = (b: Foot, ux: number, uy: number): number =>
  b.hx * Math.abs(Math.cos(b.a) * ux + Math.sin(b.a) * uy) + b.hy * Math.abs(-Math.sin(b.a) * ux + Math.cos(b.a) * uy);

function planDepth(p: Foot, q: Foot): number {
  const gap = Math.hypot(q.cx - p.cx, q.cy - p.cy) - Math.hypot(p.hx, p.hy) - Math.hypot(q.hx, q.hy);
  if (gap > 0) return -gap;
  let best = Infinity;
  for (let k = 0; k < 4; k++) {
    const t = k === 0 ? p.a : k === 1 ? p.a + Math.PI / 2 : k === 2 ? q.a : q.a + Math.PI / 2;
    const ux = Math.cos(t), uy = Math.sin(t);
    best = Math.min(best, reachAlong(p, ux, uy) + reachAlong(q, ux, uy) - Math.abs((q.cx - p.cx) * ux + (q.cy - p.cy) * uy));
  }
  return best;
}

const heightsMeet = (a0: number, a1: number, b0: number, b1: number): boolean => Math.min(a1, b1) - Math.max(a0, b0) > MEET + 0.001;
const thinRun = (e: ElementFields): boolean =>
  (e.kind === B40_ELEMENT.Wall || e.kind === B40_ELEMENT.Fence || e.kind === B40_ELEMENT.Railing) && Math.min(e.w, e.d) <= 0.3;
const foliage = (e: ElementFields): boolean => e.kind === B40_ELEMENT.Shrub || e.kind === B40_ELEMENT.Hedge;

/** Whether two parts stand in each other (4.0 elementsMeet). */
export function elementsMeet(a: ElementFields, b: ElementFields): boolean {
  if (Math.hypot(b.x - a.x, b.y - a.y) > planReach(a) + planReach(b)) return false;
  if (SURFACE_KINDS(a.kind) || SURFACE_KINDS(b.kind)) return false;
  if (isStructure(a) && isStructure(b)) return false;
  if ((PLANT_KINDS(a.kind) && thinRun(b)) || (PLANT_KINDS(b.kind) && thinRun(a))) return false;
  if (foliage(a) && foliage(b)) return false;
  if (a.kind === B40_ELEMENT.Tree || b.kind === B40_ELEMENT.Tree) {
    const tree = a.kind === B40_ELEMENT.Tree ? a : b, other = a.kind === B40_ELEMENT.Tree ? b : a;
    if (other.kind === B40_ELEMENT.Tree) {
      return heightsMeet(a.z, a.z + a.h, b.z, b.z + b.h) && planDepth(footprint(a, fa, TRUNK), footprint(b, fb, TRUNK)) > MEET;
    }
    const crown = tree.z + tree.h * CROWN_FROM;
    const trunkMeets = heightsMeet(tree.z, tree.z + tree.h, other.z, other.z + other.h) &&
      planDepth(footprint(tree, fa, TRUNK), footprint(other, fb)) > MEET;
    if (trunkMeets && !PLANT_KINDS(other.kind)) return true;
    return !PLANT_KINDS(other.kind) && heightsMeet(crown, tree.z + tree.h, other.z, other.z + other.h) &&
      other.z >= crown - MEET && planDepth(footprint(tree, fa), footprint(other, fb)) > MEET;
  }
  return heightsMeet(a.z, a.z + a.h, b.z, b.z + b.h) && planDepth(footprint(a, fa), footprint(b, fb)) > MEET + 0.001;
}

export function meetAt(t: B40Table, a: number, b: number): boolean {
  return elementsMeet(fieldsOf(t, a), fieldsOf(t, b));
}


// ---------------------------------------------------------------- the parts nothing holds up

const EPS = 1e-9;

interface V2 { x: number; y: number }

function pointInPolygon(p: V2, points: readonly V2[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const pi = points[i]!, pj = points[j]!;
    if (pi.y > p.y !== pj.y > p.y) {
      const x = ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x;
      if (p.x < x) inside = !inside;
    }
  }
  return inside;
}

function convexHull(input: readonly V2[]): V2[] {
  if (input.length < 4) return input.slice();
  const pts = input.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const turn = (o: V2, a: V2, b: V2): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: V2[] = [], upper: V2[] = [];
  for (const p of pts) { while (lower.length >= 2 && turn(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop(); lower.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]!; while (upper.length >= 2 && turn(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop(); upper.push(p); }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

function ringArea(ring: readonly V2[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j]!.x * ring[i]!.y - ring[i]!.x * ring[j]!.y;
  return a / 2;
}

/** The area of the volume's plan in a rectangle (rectangles directly, outlines clipped by the rect). */
function footprintInRect(t: B40Table, v: number, x0: number, y0: number, x1: number, y1: number): number {
  const vx0 = t.x[v]!, vy0 = t.y[v]!, vx1 = vx0 + t.w[v]!, vy1 = vy0 + t.d[v]!;
  if (t.outlineN[v]! === 0) {
    const ix0 = Math.max(vx0, x0), iy0 = Math.max(vy0, y0), ix1 = Math.min(vx1, x1), iy1 = Math.min(vy1, y1);
    return ix1 > ix0 && iy1 > iy0 ? (ix1 - ix0) * (iy1 - iy0) : 0;
  }
  let poly: V2[] = [];
  const at = t.outlineAt[v]!;
  for (let i = 0; i < t.outlineN[v]!; i++) poly.push({ x: vx0 + t.outline[at + i * 2]! * t.w[v]!, y: vy0 + t.outline[at + i * 2 + 1]! * t.d[v]! });
  const clip = (inside: (p: V2) => boolean, cross: (a: V2, b: V2) => V2): void => {
    const out: V2[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
      const ia = inside(a), ib = inside(b);
      if (ia) out.push(a);
      if (ia !== ib) out.push(cross(a, b));
    }
    poly = out;
  };
  const xAt = (a: V2, b: V2, x: number): V2 => ({ x, y: a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x) });
  const yAt = (a: V2, b: V2, y: number): V2 => ({ x: a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y), y });
  clip((p) => p.x >= x0, (a, b) => xAt(a, b, x0));
  clip((p) => p.x <= x1, (a, b) => xAt(a, b, x1));
  clip((p) => p.y >= y0, (a, b) => yAt(a, b, y0));
  clip((p) => p.y <= y1, (a, b) => yAt(a, b, y1));
  return poly.length >= 3 ? Math.abs(ringArea(poly)) : 0;
}

/** The parts nothing holds up (4.0 unsupportedElements), by element index. */
export function unsupportedElements(t: B40Table): Set<number> {
  const out = new Set<number>();
  if (t.elN === 0) return out;
  const tol = 0.05;
  const rects: Array<[number, number, number, number]> = [];
  for (let i = 0; i < t.elN; i++) {
    const e = fieldsOf(t, i);
    const ay = alongY(e), sx = ay ? e.w : e.d, sy = ay ? e.d : e.w;
    const cs = Math.abs(Math.cos(e.angle)), sn = Math.abs(Math.sin(e.angle));
    const hx = (sx * cs + sy * sn) / 2, hy = (sx * sn + sy * cs) / 2;
    rects.push([e.x - hx, e.y - hy, e.x + hx, e.y + hy]);
  }
  const square = ([x0, y0, x1, y1]: readonly number[], grow: number): V2[] =>
    [{ x: x0! - grow, y: y0! - grow }, { x: x1! + grow, y: y0! - grow }, { x: x1! + grow, y: y1! + grow }, { x: x0! - grow, y: y1! + grow }];
  const onLand = (i: number, e: ElementFields): boolean => {
    if ((e.z <= EPS && !FACADE_KINDS(e.kind)) || FOLLOWS_GROUND(e.kind)) return true;
    const box = square(rects[i]!, tol);
    const [bx0, by0] = [Math.min(...box.map((p) => p.x)), Math.min(...box.map((p) => p.y))];
    const [bx1, by1] = [Math.max(...box.map((p) => p.x)), Math.max(...box.map((p) => p.y))];
    for (let v = 0; v < t.n; v++) {
      if (t.open[v]! < 0 || !Number.isFinite(t.terrace[v])) continue;
      if (Math.abs(e.z - t.terrace[v]!) <= tol && footprintInRect(t, v, bx0, by0, bx1, by1) > EPS) return true;
    }
    return false;
  };
  const heldByMass = (i: number, e: ElementFields): boolean => {
    const box = square(rects[i]!, 0.3);
    const bx0 = Math.min(...box.map((p) => p.x)), by0 = Math.min(...box.map((p) => p.y));
    const bx1 = Math.max(...box.map((p) => p.x)), by1 = Math.max(...box.map((p) => p.y));
    for (let v = 0; v < t.n; v++) {
      if (t.open[v]! >= 0 || t.mode[v]! === 1 || t.mode[v]! === 2) continue;
      const lift = Number.isFinite(t.lift[v]) ? t.lift[v]! : 0;
      const z0 = t.base[v]! === 0 ? Math.min(0, lift) : lift + (t.base[v]! === 0 ? 0 : t.groundHeight + (t.base[v]! - 1) * t.storeyHeight);
      const z1 = lift + (t.base[v]! + t.storeys[v]! <= 0 ? 0 : t.groundHeight + (t.base[v]! + t.storeys[v]! - 1) * t.storeyHeight);
      if (e.z > z1 + tol || e.z + e.h < z0 - tol) continue;
      if (footprintInRect(t, v, bx0, by0, bx1, by1) > EPS) return true;
    }
    return false;
  };
  const held = new Uint8Array(t.elN);
  for (let i = 0; i < t.elN; i++) { const e = fieldsOf(t, i); if (onLand(i, e) || heldByMass(i, e)) held[i] = 1; }
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < t.elN; i++) {
      if (held[i]) continue;
      const e = fieldsOf(t, i), [ex0, ey0, ex1, ey1] = rects[i]!;
      const contacts: V2[] = [];
      for (let j = 0; j < t.elN; j++) {
        if (i === j || !held[j]) continue;
        const s = fieldsOf(t, j);
        if (s.z > e.z + e.h + tol || e.z > s.z + s.h + tol) continue;
        const [sx0, sy0, sx1, sy1] = rects[j]!;
        const ix0 = Math.max(ex0, sx0), iy0 = Math.max(ey0, sy0), ix1 = Math.min(ex1, sx1), iy1 = Math.min(ey1, sy1);
        if (ix1 < ix0 - tol || iy1 < iy0 - tol) continue;
        contacts.push(...square([ix0, iy0, Math.max(ix0, ix1), Math.max(iy0, iy1)], tol));
      }
      if (contacts.length === 0 || !pointInPolygon({ x: e.x, y: e.y }, convexHull(contacts))) continue;
      held[i] = 1; changed = true;
    }
  }
  for (let i = 0; i < t.elN; i++) if (!held[i]) out.add(i);
  return out;
}

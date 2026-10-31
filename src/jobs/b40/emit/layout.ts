// A b40 building's bays in its own frame: every outside wall of every storey, split where another block stands
// against it, with the relief push and the component the facade carries. Values and rules from Roadcraft 4.0
// world/buildings/geometry.ts (workOutLayout, coveredSpans); the data is the SoA table.
import { B40_BAY } from '../../../world/b40Kinds.ts';
import type { B40Table } from '../volumes.ts';

const EPS = 1e-9;

export interface B40Bay {
  readonly volume: number;
  /** Storey index in the volume. */
  readonly storey: number;
  readonly level: number;
  readonly side: number;
  readonly index: number;
  readonly component: number;
  readonly lx: number;
  readonly ly: number;
  readonly lnx: number;
  readonly lny: number;
  readonly z: number;
  readonly start: number;
  readonly push: number;
  readonly width: number;
  readonly height: number;
}

interface Frame { x: number; y: number; tx: number; ty: number; nx: number; ny: number; length: number }

const isMass = (t: B40Table, v: number): boolean => t.mode[v] !== 1 && t.mode[v] !== 2;
const volumeSides = (t: B40Table, v: number): number => (t.outlineN[v]! > 0 ? t.outlineN[v]! : 4);
const levelHeight = (t: B40Table, level: number): number => (level === 0 ? t.groundHeight : t.storeyHeight);
const levelElevation = (t: B40Table, level: number): number => {
  if (level <= 0) return 0;
  return t.groundHeight + (level - 1) * t.storeyHeight;
};
const volumeLift = (t: B40Table, v: number): number => (Number.isFinite(t.lift[v]) ? t.lift[v]! : 0);
const volumeElevation = (t: B40Table, v: number, level: number): number => volumeLift(t, v) + levelElevation(t, level);
const volumeTop = (t: B40Table, v: number): number => t.base[v]! + t.storeys[v]!;
const occupiesLevel = (t: B40Table, v: number, level: number): boolean => t.base[v]! <= level && level < volumeTop(t, v);

/** The ring of a volume's plan in the local frame (rectangle corners or its outline, scaled). */
function footprint(t: B40Table, v: number): { x: number; y: number }[] {
  const n = t.outlineN[v]!;
  if (n > 0) {
    const at = t.outlineAt[v]!;
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < n; i++) out.push({ x: t.x[v]! + t.outline[at + i * 2]! * t.w[v]!, y: t.y[v]! + t.outline[at + i * 2 + 1]! * t.d[v]! });
    return out;
  }
  return [{ x: t.x[v]!, y: t.y[v]! }, { x: t.x[v]! + t.w[v]!, y: t.y[v]! }, { x: t.x[v]! + t.w[v]!, y: t.y[v]! + t.d[v]! }, { x: t.x[v]!, y: t.y[v]! + t.d[v]! }];
}

/** A side's frame: start point, along direction, outward normal and length (4.0 sideFrame). */
function frame(t: B40Table, v: number, side: number): Frame {
  const ring = footprint(t, v);
  let p = ring[side % ring.length]!, q = ring[(side + 1) % ring.length]!;
  const dx = q.x - p.x, dy = q.y - p.y;
  const overlap = Math.hypot(dx, dy) || 1;
  const nx = dy / overlap, ny = -dx / overlap;
  if (t.outlineN[v]! === 0 && side >= 2) [p, q] = [q, p];
  return { x: p.x, y: p.y, tx: (q.x - p.x) / overlap, ty: (q.y - p.y) / overlap, nx, ny, length: overlap };
}

const sideLength = (t: B40Table, v: number, side: number): number => frame(t, v, side).length;

function baysOn(t: B40Table, v: number, side: number): number {
  const composed = t.fgBays[v * 16 + side]!;
  if (composed >= 0) return composed;
  const length = side === 0 || side === 2 ? t.w[v]! : t.d[v]!;
  return Math.max(1, Math.round(Math.round((length / t.module) * 1e6) / 1e6));
}

export const bayWidth = (t: B40Table, v: number, side: number): number => sideLength(t, v, side) / baysOn(t, v, side);

/** The component a bay carries: its own override, its side's, else the storey's fill. */
export function componentAt(t: B40Table, v: number, storey: number, side: number, index: number): number {
  const code = t.bay(v, storey, side, index);
  if (code !== 255) return code;
  const sideFill = t.sideFill[(v * 64 + storey) * 16 + side]!;
  if (sideFill >= 0) return sideFill;
  return t.fillOf(v, storey);
}

function pointInPolygon(px: number, py: number, ring: readonly { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const pi = ring[i]!, pj = ring[j]!;
    if (pi.y > py !== pj.y > py) {
      const x = ((pj.x - pi.x) * (py - pi.y)) / (pj.y - pi.y) + pi.x;
      if (px < x) inside = !inside;
    }
  }
  return inside;
}

/** Stretches of a side another block stands against, fully (`want` 2) or over part of the storey (1). */
function spansAgainst(t: B40Table, v: number, side: number, level: number, want: 1 | 2): [number, number][] {
  const out: [number, number][] = [];
  const anyOutline = (() => { for (let i = 0; i < t.n; i++) if (t.outlineN[i]! > 0) return true; return false; })();
  if (anyOutline) {
    const a = frame(t, v, side);
    for (let o = 0; o < t.n; o++) {
      if (o === v || t.open[o]! >= 0 || !isMass(t, o) || standsAgainst(t, o, v, level) !== want) continue;
      const edges = volumeSides(t, o);
      for (let edge = 0; edge < edges; edge++) {
        const c = frame(t, o, edge);
        const facing = a.nx * c.nx + a.ny * c.ny;
        const against = facing <= -0.9999;
        const same = want === 2 && facing >= 0.9999 && o < v;
        if (!against && !same) continue;
        if (Math.abs((c.x - a.x) * a.nx + (c.y - a.y) * a.ny) > EPS * 10) continue;
        const start = (c.x - a.x) * a.tx + (c.y - a.y) * a.ty;
        const end = start + c.length * (c.tx * a.tx + c.ty * a.ty);
        const from = Math.max(0, Math.min(start, end)), to = Math.min(a.length, Math.max(start, end));
        if (to - from > EPS) out.push([from, to]);
      }
      if (want === 2) out.push(...insideSpans(a, footprint(t, o)));
    }
    return out.sort((p, q) => p[0] - q[0]);
  }
  for (let o = 0; o < t.n; o++) {
    if (o === v || t.open[o]! >= 0 || !isMass(t, o) || standsAgainst(t, o, v, level) !== want) continue;
    let touches: boolean;
    let from: number;
    let to: number;
    if (side === 0 || side === 2) {
      const line = side === 0 ? t.y[v]! : t.y[v]! + t.d[v]!;
      touches = side === 0 ? Math.abs(t.y[o]! + t.d[o]! - t.y[v]!) < EPS * 10 : Math.abs(t.y[o]! - (t.y[v]! + t.d[v]!)) < EPS * 10;
      if (want === 2) {
        const inside = line > t.y[o]! + EPS * 10 && line < t.y[o]! + t.d[o]! - EPS * 10;
        const same = o < v && (side === 0 ? Math.abs(t.y[o]! - t.y[v]!) < EPS * 10 : Math.abs(t.y[o]! + t.d[o]! - (t.y[v]! + t.d[v]!)) < EPS * 10);
        touches ||= inside || same;
      }
      from = Math.max(t.x[o]!, t.x[v]!) - t.x[v]!;
      to = Math.min(t.x[o]! + t.w[o]!, t.x[v]! + t.w[v]!) - t.x[v]!;
    } else {
      const line = side === 3 ? t.x[v]! : t.x[v]! + t.w[v]!;
      touches = side === 3 ? Math.abs(t.x[o]! + t.w[o]! - t.x[v]!) < EPS * 10 : Math.abs(t.x[o]! - (t.x[v]! + t.w[v]!)) < EPS * 10;
      if (want === 2) {
        const inside = line > t.x[o]! + EPS * 10 && line < t.x[o]! + t.w[o]! - EPS * 10;
        const same = o < v && (side === 3 ? Math.abs(t.x[o]! - t.x[v]!) < EPS * 10 : Math.abs(t.x[o]! + t.w[o]! - (t.x[v]! + t.w[v]!)) < EPS * 10);
        touches ||= inside || same;
      }
      from = Math.max(t.y[o]!, t.y[v]!) - t.y[v]!;
      to = Math.min(t.y[o]! + t.d[o]!, t.y[v]! + t.d[v]!) - t.y[v]!;
    }
    if (touches && to - from > EPS) out.push([from, to]);
  }
  return out.sort((p, q) => p[0] - q[0]);
}

function insideSpans(a: Frame, poly: readonly { x: number; y: number }[]): [number, number][] {
  const out: [number, number][] = [];
  const step = Math.max(EPS * 20, a.length / 64);
  const nudge = EPS * 20;
  let from = -1;
  for (let s = 0; s <= a.length + 1e-9; s += step) {
    const at = Math.min(s, a.length);
    const inside = pointInPolygon(a.x + a.tx * at + a.nx * nudge, a.y + a.ty * at + a.ny * nudge, poly);
    if (inside && from < 0) from = Math.max(0, at - step / 2);
    if ((!inside || at >= a.length) && from >= 0) {
      const to = inside ? a.length : Math.min(a.length, at - step / 2);
      if (to - from > EPS) out.push([from, to]);
      from = -1;
    }
  }
  return out;
}

function standsAgainst(t: B40Table, o: number, v: number, level: number): 0 | 1 | 2 {
  if (Math.abs(volumeLift(t, o) - volumeLift(t, v)) < EPS) return occupiesLevel(t, o, level) ? 2 : 0;
  const z0 = volumeElevation(t, v, level), z1 = z0 + levelHeight(t, level);
  const o0 = t.base[o]! === 0 ? -Infinity : volumeElevation(t, o, t.base[o]!);
  const o1 = volumeElevation(t, o, volumeTop(t, o));
  if (o0 <= z0 + EPS && o1 >= z1 - EPS) return 2;
  return o1 > z0 + EPS && o0 < z1 - EPS ? 1 : 0;
}

function exposedParts(spans: readonly (readonly [number, number])[], a0: number, a1: number): [number, number][] {
  const out: [number, number][] = [];
  let from = a0;
  for (const [s0, s1] of spans) {
    if (s1 <= from + EPS || s0 >= a1 - EPS) continue;
    if (s0 > from + EPS) out.push([from, Math.min(s0, a1)]);
    from = Math.max(from, s1);
    if (from >= a1 - EPS) break;
  }
  if (a1 - from > EPS) out.push([from, a1]);
  return out;
}

function reliefPushes(t: B40Table, v: number, side: number, count: number): Float64Array | null {
  if (t.reliefCount[v]! === 0) return null;
  let out: Float64Array | null = null;
  const storeys = t.storeys[v]!;
  for (let r = t.reliefStart[v]!, end = r + t.reliefCount[v]!; r < end; r++) {
    if (t.reliefSide[r]! !== side) continue;
    out ??= new Float64Array(storeys * count);
    const k1 = Math.min(Math.floor(t.reliefStorey1[r]!), storeys - 1), i1 = Math.min(Math.floor(t.reliefBay1[r]!), count - 1);
    for (let k = Math.max(Math.ceil(t.reliefStorey0[r]!), 0); k <= k1; k++) {
      for (let i = Math.max(Math.ceil(t.reliefBay0[r]!), 0); i <= i1; i++) out[k * count + i] = t.reliefDepth[r]!;
    }
  }
  return out;
}

/** The bays of every outside wall of every storey, in the building's own frame. */
export function bayLayout(t: B40Table): B40Bay[] {
  const out: B40Bay[] = [];
  let top = 0;
  for (let v = 0; v < t.n; v++) top = Math.max(top, volumeTop(t, v));
  const elevations: number[] = [];
  for (let level = 0; level <= top; level++) elevations.push(levelElevation(t, level));
  let lowLift = Infinity, highLift = -Infinity;
  for (let v = 0; v < t.n; v++) { lowLift = Math.min(lowLift, volumeLift(t, v)); highLift = Math.max(highLift, volumeLift(t, v)); }
  const lifted = highLift - lowLift > EPS;

  for (let v = 0; v < t.n; v++) {
    if (t.storeys[v]! <= 0) continue;
    const sides = [];
    for (let side = 0; side < volumeSides(t, v); side++) {
      const f = frame(t, v, side);
      const count = baysOn(t, v, side);
      sides.push({ side, nx: f.nx, ny: f.ny, count, width: f.length / count, s: { x: f.x, y: f.y, tx: f.tx, ty: f.ty }, pushes: reliefPushes(t, v, side, count) });
    }
    const lift = volumeLift(t, v);
    for (let k = 0; k < t.storeys[v]!; k++) {
      const level = t.base[v]! + k;
      const z = lift + (elevations[level] ?? levelElevation(t, level));
      const height = levelHeight(t, level);
      for (const { side, nx, ny, count, width, s, pushes } of sides) {
        const spans = spansAgainst(t, v, side, level, 2);
        const partly = lifted ? spansAgainst(t, v, side, level, 1) : [];
        const emit = (index: number, push: number, p0: number, p1: number, whole: boolean): void => {
          const mid = (p0 + p1) / 2;
          out.push({
            volume: v + 1, storey: k, level, side, index,
            component: whole ? componentAt(t, v, k, side, index) : B40_BAY.Wall,
            lx: s.x + s.tx * mid + nx * push, ly: s.y + s.ty * mid + ny * push, lnx: nx, lny: ny,
            z, start: p0, push, width: p1 - p0, height,
          });
        };
        for (let index = 0; index < count; index++) {
          const a0 = index * width, a1 = a0 + width;
          const push = pushes ? pushes[k * count + index]! : 0;
          let partlyHere = false;
          for (const [s0, s1] of partly) if (s1 > a0 + EPS && s0 < a1 - EPS) { partlyHere = true; break; }
          if (spans.length === 0) { emit(index, push, a0, a1, !partlyHere); continue; }
          const parts = exposedParts(spans, a0, a1);
          const first = parts[0];
          const whole = parts.length === 1 && first !== undefined && Math.abs(first[0] - a0) < EPS && Math.abs(first[1] - a1) < EPS && !partlyHere;
          for (const [p0, p1] of parts) emit(index, push, p0, p1, whole);
        }
      }
    }
  }
  return out;
}

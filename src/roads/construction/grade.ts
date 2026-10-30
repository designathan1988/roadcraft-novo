import { SEA_LEVEL } from '../../config.ts';
import { heightAt } from '../../world/heights.ts';
import { bez, tAtLength, type Quad } from '../geometry.ts';
import { ROAD_TUNING, TUNNEL } from '../tuning.ts';
import { NO_WATER, waterAt } from '../../world/ground.ts';

// --------------------------------------------------------------- plan

export interface Fixed { at: number; y: number }

/** Smoothed terrain (average over a small radius) so the road does not copy every ripple. */
export function smoothGround(h: Float32Array, x: number, z: number): number {
  let s = 0;
  for (const [dx, dz] of [[0, 0], [5, 0], [-5, 0], [0, 5], [0, -5]]) s += heightAt(h, x + dx, z + dz);
  return s / 5;
}

/**
 * Heights along the path, every `step` meters: follows the terrain + the requested
 * offset, passes over water, respects the fixed points and the maximum grade.
 */
export function heightProfile(h: Float32Array, q: Quad, table: Float64Array, offset: number, maxGrade: number, fixed: Fixed[], step = 6, water?: Float32Array): { at: Float64Array; y: Float64Array } {
  const len = table[table.length - 1];
  const n = Math.max(2, Math.ceil(len / step) + 1);
  const at = new Float64Array(n), y = new Float64Array(n);
  const isFixed = new Uint8Array(n);
  const groundOf = new Float64Array(n);
  // over water a road on or above the ground never dips below the bridge clearance (narrow rivers are not smoothed away)
  const floor = new Float64Array(n).fill(-Infinity);
  const p = new Float64Array(2);
  for (let i = 0; i < n; i++) {
    at[i] = len * i / (n - 1);
    bez(q, tAtLength(table, at[i]), p);
    const g = smoothGround(h, p[0], p[1]);
    groundOf[i] = g;
    // over the sea or a river or lake of the player's: a bridge 7 m over the water
    const wl = water ? waterAt(water, p[0], p[1]) : NO_WATER;
    y[i] = g < SEA_LEVEL + 0.5 ? SEA_LEVEL + 7 + offset : wl > g ? wl + 7 + offset : g + offset;
    if (offset >= 0 && (g < SEA_LEVEL + 0.5 || wl > g)) floor[i] = Math.max(SEA_LEVEL, wl) + ROAD_TUNING.economy.bridgeFrom + 0.5;
  }
  for (const f of fixed) {
    const i = Math.round(f.at / len * (n - 1));
    y[i] = f.y; isFixed[i] = 1;
  }
  // smooth (the road does not follow every ripple of the terrain)
  for (let pass = 0; pass < 4; pass++) {
    let prev = y[0];
    for (let i = 1; i < n - 1; i++) {
      const cur = y[i];
      if (!isFixed[i]) y[i] = Math.max(floor[i], (prev + 2 * cur + y[i + 1]) / 4);
      prev = cur;
    }
  }
  const d = len / (n - 1);
  // The grade limit per station: the road's own, and the tunnel's (TUNNEL.maxGrade) where the line runs deeper than a
  // portal. Which stations are in a tunnel depends on the line itself: solved again until that set stays the same.
  const wanted = Float64Array.from(y);
  const grade = new Float64Array(n).fill(maxGrade * d);
  const inTunnel = new Uint8Array(n);
  for (let round = 0; round < 6; round++) {
    y.set(wanted);
    gradeLine(y, grade, isFixed, floor);
    let changed = false;
    for (let i = 0; i < n; i++) {
      const t = groundOf[i] - y[i] >= TUNNEL.portalDepth ? 1 : 0;
      if (t && !inTunnel[i]) { inTunnel[i] = 1; grade[i] = Math.min(maxGrade, TUNNEL.maxGrade) * d; changed = true; }
    }
    if (!changed) break;
  }
  return { at, y };
}

/**
 * The grade line that moves the least earth: the heights y minimising the sum of |y − wanted| (cut plus fill) with
 * |y[i+1] − y[i]| ≤ g, the fixed stations held and never under `floor` (the road's vertical alignment as an earthwork
 * minimisation, Easa 1988 / Moreb: https://unistroy.spbstu.ru/article/2019.82.1). Solved exactly by dynamic programming
 * over convex piecewise-linear costs (Rote, "Isotonic regression by dynamic programming"), its breakpoints in two heaps:
 * the grade limit is a minimum over a window of ±g, which moves the left breakpoints down by g and the right ones up by
 * g. Clamping each station to its neighbour's ±g in forward and backward sweeps (as this did, and 4.0's slopeLimit
 * does) depends on the sweeps' order: over a hill the road climbed late in a cut and came down late on fill, its crest
 * ~40 m downhill and the far side marked a bridge. `wanted` is replaced by the line in place.
 */
export function gradeLine(wanted: Float64Array, grade: number | Float64Array, fixed: Uint8Array, floor: Float64Array): void {
  // grade[i]: the most the height may change between stations i - 1 and i (one number: the same everywhere)
  const g = (i: number) => (typeof grade === 'number' ? grade : grade[i]);
  const n = wanted.length;
  const HARD = 1e6;
  // breakpoints with multiplicities: L a max-heap (left of the minimum), R a min-heap, each with its pending shift
  const L = new BreakHeap(true), R = new BreakHeap(false);
  let shiftL = 0, shiftR = 0;
  const lo = new Float64Array(n), hi = new Float64Array(n);
  // f += w·max(0, y − c): c joins the left, then w units of the left's top move right
  const addRight = (c: number, w: number) => { L.push(c - shiftL, w); moveTop(L, shiftL, R, shiftR, w); };
  // f += w·max(0, c − y)
  const addLeft = (c: number, w: number) => { R.push(c - shiftR, w); moveTop(R, shiftR, L, shiftL, w); };
  for (let i = 0; i < n; i++) {
    if (i > 0) { shiftL -= g(i); shiftR += g(i); }
    const w = fixed[i] ? HARD : 1;
    addRight(wanted[i], w); addLeft(wanted[i], w);
    if (floor[i] > -Infinity) addLeft(floor[i], HARD);
    lo[i] = L.size ? L.top() + shiftL : -Infinity;
    hi[i] = R.size ? R.top() + shiftR : Infinity;
  }
  // back from the end: the last station anywhere in its best interval (nearest its wanted height), each one before it
  // the best within its interval and the window of the one after
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
  wanted[n - 1] = clamp(wanted[n - 1], lo[n - 1], hi[n - 1]);
  for (let i = n - 2; i >= 0; i--) {
    const next = wanted[i + 1];
    wanted[i] = clamp(clamp(next, lo[i], hi[i]), next - g(i + 1), next + g(i + 1));
  }
}

/** w units moved from the top of `from` (stored minus fromShift) to `to` (stored minus toShift). */
function moveTop(from: BreakHeap, fromShift: number, to: BreakHeap, toShift: number, w: number): void {
  while (w > 0 && from.size) {
    const [pos, count] = from.peek();
    const k = Math.min(w, count);
    from.take(k);
    to.push(pos + fromShift - toShift, k);
    w -= k;
  }
}

/** A binary heap of (position, count), a max-heap or a min-heap by position. */
class BreakHeap {
  private pos: number[] = [];
  private cnt: number[] = [];
  private max: boolean;
  constructor(max: boolean) { this.max = max; }
  get size(): number { return this.pos.length; }
  top(): number { return this.pos[0]; }
  peek(): [number, number] { return [this.pos[0], this.cnt[0]]; }
  private before(a: number, b: number): boolean { return this.max ? this.pos[a] > this.pos[b] : this.pos[a] < this.pos[b]; }
  private swap(a: number, b: number): void {
    const p = this.pos[a]; this.pos[a] = this.pos[b]; this.pos[b] = p;
    const c = this.cnt[a]; this.cnt[a] = this.cnt[b]; this.cnt[b] = c;
  }
  push(p: number, c: number): void {
    this.pos.push(p); this.cnt.push(c);
    for (let i = this.pos.length - 1; i > 0;) { const up = (i - 1) >> 1; if (!this.before(i, up)) break; this.swap(i, up); i = up; }
  }
  /** k units off the top (all of it: the next breakpoint comes up). */
  take(k: number): void {
    if (this.cnt[0] > k) { this.cnt[0] -= k; return; }
    const last = this.pos.length - 1;
    this.swap(0, last); this.pos.pop(); this.cnt.pop();
    for (let i = 0; ;) {
      const a = 2 * i + 1, b = a + 1;
      let m = i;
      if (a < this.pos.length && this.before(a, m)) m = a;
      if (b < this.pos.length && this.before(b, m)) m = b;
      if (m === i) break;
      this.swap(i, m); i = m;
    }
  }
}

export function profileY(pr: { at: Float64Array; y: Float64Array }, s: number): number {
  const { at, y } = pr;
  const n = at.length;
  if (s <= 0) return y[0];
  if (s >= at[n - 1]) return y[n - 1];
  const f = s / at[n - 1] * (n - 1);
  const i = Math.floor(f);
  return y[i] + (y[i + 1] - y[i]) * (f - i);
}


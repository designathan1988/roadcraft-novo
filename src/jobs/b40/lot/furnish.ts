// Furnishing a lot: the front, the side strips, the back zone and the boundary laid on a body whose building
// already stands in its envelope. Rules, values and draw order are Roadcraft 4.0 world/growth/lotPlan.ts
// furnishLot; the data is the b40 SoA table, the elements are indices, and the clash tests read the element columns.
import type { Xoshiro128 } from '../../../core/rng.ts';
import { B40_BAY, B40_ELEMENT, B40_SURFACE } from '../../../world/b40Kinds.ts';
import { FIN } from '../../../shared/finishes.ts';
import { B40Table, type B40Made } from '../volumes.ts';
import type { B40Plan, B40Rect, B40SidePlan } from './plan.ts';
import { garageRamp, yardRamp } from './plan.ts';
import { BOUNDARY_KINDS, FOLLOWS_GROUND, SURFACE_KINDS, elementsMeet, fieldsOf, isStructure, planReach, type ElementFields } from '../elements.ts';
import { elementClash } from '../clash.ts';
import { paintOf } from '../paint.ts';
import { furnishZones } from './furnishZones.ts';

export interface B40Hill {
  readonly yard: number;
  readonly split?: { readonly y: number; readonly lift: number };
  readonly backFall?: number;
  readonly garage?: { readonly x: number; readonly y: number; readonly w: number };
  readonly landAt?: (x: number, y: number) => number;
}

const FOOTPATH = 1.2;
const BOUNDARY_RESERVE = 30;
const STEP_RISE_M = 0.17, STEP_RUN_M = 0.3, TERRACE_MAX_RISERS = 20;
const MAX_TERRACE_V = 5.5 - 0.1;

const mat = (finish: number, colour: number) => paintOf(finish, colour);
const PAVERS = mat(FIN.Brick, 0x9a958c);
const RETAINING = mat(FIN.Stone, 0x9a948a);

type Side = 0 | 1 | 2 | 3;

/** `Math.hypot(dx, dy) > r` with the square settling all but the ties (4.0 `apart`). */
function apart(dx: number, dy: number, r: number): boolean {
  const d2 = dx * dx + dy * dy, r2 = r * r;
  if (d2 > r2 * (1 + 1e-9)) return true;
  if (d2 < r2 * (1 - 1e-9)) return false;
  return Math.hypot(dx, dy) > r;
}

export class LotBuilder {
  readonly t: B40Table;
  readonly plan: B40Plan;
  readonly rng: Xoshiro128;
  readonly hill?: B40Hill;
  readonly W: number;
  readonly D: number;
  readonly F: number;
  readonly Bk: number;
  readonly env: B40Rect;
  readonly split: { y: number; lift: number } | null;
  readonly backLevel: number;
  readonly door: number;
  readonly backDoor: number | null;
  readonly keepClear: B40Rect[] = [];
  readonly gateWays: { x0: number; x1: number }[] = [];
  readonly taken: B40Rect[] = [];
  laying = false;
  readonly isHouse: boolean;
  readonly driveSurface: number;
  readonly ramp: { start: number; end: number; grade: number } | null;
  readonly garage: { x: number; y: number; w: number } | null;

  constructor(t: B40Table, plan: B40Plan, made: B40Made, rng: Xoshiro128, hill?: B40Hill) {
    this.t = t; this.plan = plan; this.rng = rng; this.hill = hill;
    this.W = plan.W; this.D = plan.D; this.F = plan.front.depth; this.Bk = plan.D - plan.back.depth;
    this.env = plan.building;
    this.split = hill?.split && Math.abs(hill.split.lift) > 0.05 ? hill.split : null;
    this.backLevel = this.split?.lift ?? 0;
    this.door = plan.building.x0 + made.entrance;
    this.backDoor = made.backDoor !== undefined ? plan.building.x0 + made.backDoor : null;
    this.isHouse = plan.kind === 'house';
    this.driveSurface = this.isHouse || plan.kind === 'industry' ? B40_SURFACE.Concrete : B40_SURFACE.Asphalt;
    this.garage = this.split && hill?.garage ? hill.garage : null;
    this.ramp = this.split ? yardRamp(plan) ?? (this.garage ? garageRamp(plan) : null) : null;
  }

  X(x: number): number { return x - this.W / 2; }
  Y(y: number): number { return y; }

  lay(r: B40Rect, code: number): void {
    if (r.x1 - r.x0 < 2 - 1e-6 || r.y1 - r.y0 < 2 - 1e-6) return;
    this.t.block({ x: this.X(r.x0), y: this.Y(r.y0), w: r.x1 - r.x0, d: r.y1 - r.y0, open: code, fill: B40_BAY.Wall });
  }

  sloped(r: B40Rect, code: number, from: number, to: number): void {
    if (r.x1 - r.x0 < 2 - 1e-6 || r.y1 - r.y0 < 2 - 1e-6) return;
    const v = this.t.block({ x: this.X(r.x0), y: this.Y(r.y0), w: r.x1 - r.x0, d: r.y1 - r.y0, open: code, fill: B40_BAY.Wall });
    this.t.ramp[v] = from; this.t.terrace[v] = to;
  }

  fillAround(region: B40Rect, holes: readonly B40Rect[], code: number): void {
    const inside = holes.map((h) => ({ x0: Math.max(h.x0, region.x0), y0: Math.max(h.y0, region.y0), x1: Math.min(h.x1, region.x1), y1: Math.min(h.y1, region.y1) }))
      .filter((h) => h.x1 > h.x0 && h.y1 > h.y0);
    const ys = [...new Set([region.y0, region.y1, ...inside.flatMap((h) => [h.y0, h.y1])])].sort((a, b) => a - b);
    for (let j = 0; j + 1 < ys.length; j++) {
      const y0 = ys[j]!, y1 = ys[j + 1]!;
      const cuts = inside.filter((h) => h.y0 < y1 - 1e-6 && h.y1 > y0 + 1e-6).map((h) => [h.x0, h.x1] as const).sort((a, b) => a[0] - b[0]);
      let x = region.x0;
      for (const [a, b] of [...cuts, [region.x1, region.x1] as const]) {
        if (a - x >= 2) this.lay({ x0: x, y0, x1: a, y1 }, code);
        x = Math.max(x, b);
      }
    }
  }

  candidate(kind: number, x: number, y: number, facing: Side, w: number, d: number, h: number, z: number, material?: { finish: number; colour: number }): ElementFields {
    return {
      kind, x: this.X(x), y: this.Y(y), facing, w: Math.min(w, 40), d, z, h, angle: 0,
      matFinish: material ? material.finish : -1, matColour: material ? material.colour : 0,
    };
  }

  wouldFit(kind: number, x: number, y: number, facing: Side, w: number, d: number, h: number, z = 0, material?: { finish: number; colour: number }): boolean {
    const boundary = kind === B40_ELEMENT.Wall || kind === B40_ELEMENT.Fence || kind === B40_ELEMENT.Hedge || kind === B40_ELEMENT.Gate || kind === B40_ELEMENT.Railing;
    if (this.t.elN >= 128 - (boundary ? 2 : BOUNDARY_RESERVE) || w < 0.1 || d < 0.1 || h < 0.1) return false;
    if (!(this.laying || kind === B40_ELEMENT.Gate) && z < 2 && !SURFACE_KINDS(kind)) {
      const across = facing === 1 || facing === 3;
      const hw = across ? d / 2 : w / 2, hd = across ? w / 2 : d / 2;
      for (const r of this.keepClear) if (x + hw > r.x0 && x - hw < r.x1 && y + hd > r.y0 && y - hd < r.y1) return false;
      if (y - hd < Math.max(this.F, 1)) for (const g of this.gateWays) if (x + hw > g.x0 && x - hw < g.x1) return false;
    }
    const c = this.candidate(kind, x, y, facing, w, d, h, z, material);
    if (elementClash(this.t, { ...c, angle: 0 }) >= 0) return false;
    if (this.laying || isStructure(c)) return true;
    const reach = planReach(c);
    for (let i = 0; i < this.t.elN; i++) {
      const o = fieldsOf(this.t, i);
      if (!apart(o.x - c.x, o.y - c.y, reach + planReach(o)) && elementsMeet(c, o)) return false;
    }
    return true;
  }

  place(kind: number, x: number, y: number, facing: Side, w: number, d: number, h: number, z = 0, material?: { finish: number; colour: number }): boolean {
    if (!this.wouldFit(kind, x, y, facing, w, d, h, z, material)) return false;
    const c = this.candidate(kind, x, y, facing, w, d, h, z, material);
    if (this.laying || isStructure(c)) {
      for (let i = this.t.elN - 1; i >= 0; i--) {
        const o = fieldsOf(this.t, i);
        if (!apart(o.x - c.x, o.y - c.y, planReach(o) + planReach(c)) && elementsMeet(c, o)) this.t.removeElement(i);
      }
    }
    this.t.el(kind, c.x, c.y, facing, { w: c.w, d: c.d, h: c.h, z: c.z, ...(material ? { material } : {}) });
    return true;
  }

  runAcross(kind: number, y: number, x0: number, x1: number, h: number, gaps: readonly (readonly [number, number])[] = [], z = 0): void {
    const cuts = gaps.map(([c, w]) => [c - w / 2, c + w / 2] as const).sort((p, q) => p[0] - q[0]);
    let from = x0;
    const thick = kind === B40_ELEMENT.Fence ? 0.12 : kind === B40_ELEMENT.Hedge ? 0.7 : 0.2;
    const piece = (a: number, b: number): void => {
      this.laying = true;
      const ok = this.place(kind, (a + b) / 2, y, 0, b - a, thick, h, z);
      this.laying = false;
      if (ok || b - a < 1) return;
      piece(a, (a + b) / 2); piece((a + b) / 2, b);
    };
    for (const [g0, g1] of [...cuts, [x1, x1] as const]) {
      const to = Math.min(g0, x1);
      const n = Math.ceil((to - from) / 20);
      for (let k = 0; k < n && to - from > 0.3; k++) piece(from + ((to - from) * k) / n, from + ((to - from) * (k + 1)) / n);
      from = Math.max(from, g1);
    }
  }

  runAlong(kind: number, x: number, y0: number, y1: number, h: number, z = 0): void {
    const n = Math.ceil((y1 - y0) / 20);
    const thick = kind === B40_ELEMENT.Fence ? 0.12 : kind === B40_ELEMENT.Hedge ? 0.7 : 0.2;
    const piece = (a: number, b: number): void => {
      this.laying = true;
      const ok = this.place(kind, x, (a + b) / 2, 1, b - a, thick, h, z);
      this.laying = false;
      if (ok || b - a < 1) return;
      piece(a, (a + b) / 2); piece((a + b) / 2, b);
    };
    for (let k = 0; k < n && y1 - y0 > 0.3; k++) piece(y0 + ((y1 - y0) * k) / n, y0 + ((y1 - y0) * (k + 1)) / n);
  }

  walk(r: B40Rect, material: { finish: number; colour: number } = PAVERS): void {
    if (r.x1 - r.x0 < 0.3 || r.y1 - r.y0 < 0.3) return;
    this.taken.push(r);
    this.place(B40_ELEMENT.Pavement, (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, 0, r.x1 - r.x0, r.y1 - r.y0, 0.1, 0, material);
  }

  occupied(x: number, y: number, r = 0.8): boolean {
    return this.taken.some((t) => x + r > t.x0 && x - r < t.x1 && y + r > t.y0 && y - r < t.y1);
  }

  /** Everything laid since index `fromVolume` / id `fromElement` raised (negative: lowered) `rise` metres. */
  raiseSince(fromVolume: number, fromElement: number, rise: number, behind = -Infinity): void {
    if (Math.abs(rise) < 1e-6) return;
    for (let v = 0; v < this.t.n; v++) {
      if (this.t.open[v]! < 0 || v < fromVolume || this.t.y[v]! < this.Y(behind) - 1e-6) continue;
      const terrace = Number.isFinite(this.t.terrace[v]) ? this.t.terrace[v]! : 0;
      this.t.terrace[v] = Math.max(-MAX_TERRACE_V, Math.min(MAX_TERRACE_V, rise + terrace));
      if (Number.isFinite(this.t.ramp[v])) this.t.ramp[v] = Math.max(-MAX_TERRACE_V, Math.min(MAX_TERRACE_V, rise + this.t.ramp[v]!));
    }
    for (let i = 0; i < this.t.elN; i++) {
      if (this.t.elId[i]! >= fromElement && !FOLLOWS_GROUND(this.t.elKind[i]!) && this.t.elY[i]! >= this.Y(behind) - 1e-6) this.t.elZ[i]! += rise;
    }
  }

  /** A retaining wall in stone from (x0, y0) to (x1, y1). */
  hold(x0: number, y0: number, x1: number, y1: number): void {
    const h = this.backLevel > 0 ? this.backLevel + 0.15 : 0.95;
    const alongY = Math.abs(x1 - x0) < Math.abs(y1 - y0);
    const length = alongY ? y1 - y0 : x1 - x0;
    const n = Math.ceil(length / 20);
    for (let k = 0; k < n && length > 0.4; k++) {
      const a = k / n, b = (k + 1) / n;
      if (alongY) this.place(B40_ELEMENT.Slab, x0, y0 + (y1 - y0) * (a + b) / 2, 1, (y1 - y0) / n, 0.3, h, 0, RETAINING);
      else this.place(B40_ELEMENT.Slab, x0 + (x1 - x0) * (a + b) / 2, y0, 0, (x1 - x0) / n, 0.3, h, 0, RETAINING);
    }
  }

  /** A flight `width` wide from the street floor's level at `y` to the back level beyond it, at `x`. */
  stepsAt(x: number, y: number, width: number): void {
    const risers = Math.max(2, Math.round(Math.abs(this.backLevel) / STEP_RISE_M));
    const run = (risers + 1) * STEP_RUN_M;
    this.taken.push({ x0: x - width / 2, y0: y, x1: x + width / 2, y1: y + run });
    if (this.backLevel > 0) this.place(B40_ELEMENT.Stair, x, y + run / 2, 0, width, run, this.backLevel, 0, RETAINING);
    else this.place(B40_ELEMENT.Stair, x, y + run / 2, 2, width, run, -this.backLevel, this.backLevel, RETAINING);
  }

  /** The yard from y0 to y1 laid as a terrace `fall` metres above (or below) the floor, rounded to risers. */
  terraceYard(y0: number, y1: number, fall: number, fromVolume: number, fromElement: number, stairX: number, base = 0): void {
    const room = MAX_TERRACE_V - Math.max(0, Math.sign(fall) * base);
    const risers = Math.min(TERRACE_MAX_RISERS, Math.round(Math.abs(fall) * 0.85 / STEP_RISE_M), Math.floor(room / STEP_RISE_M));
    if (risers < 4) return;
    const rise = risers * STEP_RISE_M * Math.sign(fall);
    const run = (risers + 1) * STEP_RUN_M;
    if (y1 - y0 < run + 2 || this.W < 6) return;
    const flightClear = (x: number): boolean => {
      const fx0 = x - 1.05, fx1 = x + 1.05, fy0 = y0 + 0.05, fy1 = y0 + run + 0.5;
      if (this.taken.some((t) => fx0 < t.x1 && t.x0 < fx1 && fy0 < t.y1 && t.y0 < fy1)) return false;
      return fall > 0
        ? this.wouldFit(B40_ELEMENT.Stair, x, y0 + run / 2, 0, 1.3, run, risers * STEP_RISE_M, 0)
        : this.wouldFit(B40_ELEMENT.Stair, x, y0 + run / 2, 2, 1.3, run, risers * STEP_RISE_M, -risers * STEP_RISE_M);
    };
    let sx: number | null = null;
    for (let d = 0; d <= this.W && sx === null; d += 0.5) {
      for (const x of [stairX + d, stairX - d]) if (x >= 1.2 && x <= this.W - 1.2 && flightClear(x)) { sx = x; break; }
    }
    if (sx === null) return;
    const inYard = (yy: number): boolean => yy >= this.Y(y0) - 1e-6;
    for (let v = 0; v < this.t.n; v++) if (this.t.open[v]! >= 0 && v >= fromVolume && inYard(this.t.y[v]!)) this.t.terrace[v] = rise;
    for (let i = 0; i < this.t.elN; i++) if (this.t.elId[i]! >= fromElement && inYard(this.t.elY[i]!) && !FOLLOWS_GROUND(this.t.elKind[i]!)) this.t.elZ[i]! += rise;
    for (let i = this.t.elN - 1; i >= 0; i--) {
      if (this.t.elId[i]! < fromElement || BOUNDARY_KINDS(this.t.elKind[i]!)) continue;
      const ex = this.t.elX[i]! + this.W / 2, ey = this.t.elY[i]!;
      const half = Math.max(this.t.elW[i]!, this.t.elD[i]!) / 2;
      const onWall = Math.abs(ey - y0) < half + 0.4;
      const onStair = Math.abs(ex - sx) < half + 1 && ey > y0 - 0.5 && ey < y0 + run + 0.5;
      if (onWall || onStair) this.t.removeElement(i);
    }
    if (rise > 0) this.place(B40_ELEMENT.Stair, sx, y0 + run / 2, 0, 1.3, run, rise, 0, RETAINING);
    else this.place(B40_ELEMENT.Stair, sx, y0 + run / 2, 2, 1.3, run, -rise, rise, RETAINING);
    const wallH = rise > 0 ? rise + 0.15 : 0.95;
    for (const [a, b] of [[0.15, sx - 0.75], [sx + 0.75, this.W - 0.15]] as const) {
      if (b - a < 0.4) continue;
      const n = Math.ceil((b - a) / 20);
      for (let k = 0; k < n; k++) {
        const pa = a + ((b - a) * k) / n, pb = a + ((b - a) * (k + 1)) / n;
        this.place(B40_ELEMENT.Slab, (pa + pb) / 2, y0 - 0.15, 0, pb - pa, 0.3, wallH, 0, RETAINING);
      }
    }
  }

  sideStrip(side: 'left' | 'right'): { drive: B40Rect | null; walk: B40Rect | null; garden: B40Rect | null } {
    const s: B40SidePlan = side === 'left' ? this.plan.left : this.plan.right;
    const x0 = side === 'left' ? 0 : this.W - s.width, x1 = side === 'left' ? s.width : this.W;
    const out: { drive: B40Rect | null; walk: B40Rect | null; garden: B40Rect | null } = { drive: null, walk: null, garden: null };
    const driveW = s.use === 'drivePath' ? s.width - FOOTPATH : s.width;
    if (s.use === 'drive' || s.use === 'drivePath') out.drive = side === 'left' ? { x0, y0: 0, x1: x0 + driveW, y1: this.Bk } : { x0: x1 - driveW, y0: 0, x1, y1: this.Bk };
    if (s.use === 'drivePath') out.walk = side === 'left' ? { x0: x0 + driveW, y0: this.F, x1, y1: this.Bk } : { x0, y0: this.F, x1: x0 + FOOTPATH, y1: this.Bk };
    if (s.use === 'path') out.walk = { x0, y0: this.F, x1, y1: this.Bk };
    if (s.use === 'garden') out.garden = { x0, y0: this.F, x1, y1: this.Bk };
    return out;
  }
}

export function furnishLot(t: B40Table, plan: B40Plan, made: B40Made, rng: Xoshiro128, hill?: B40Hill): void {
  const lot = new LotBuilder(t, plan, made, rng, hill);
  furnishZones(lot, made);
  t.furnished = true;
}

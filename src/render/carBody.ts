// Passenger cars built the way a car is designed: the body lofted from its side profile, plan and sections, every face
// of the loft classified (paint, glass, frames, pillars, seams, liners, valances), with the trim, mirrors, handles and
// lamps. The styles' lines and the sizes are Roadcraft 4.0's (render/carBody.ts); the loft is one grid of stations ×
// ring points in typed arrays, classified by quad, and written out once per style into one geometry per material
// (render/vehicleParts.ts), drawn by instances (render/vehicles.ts). The cabin the glass shows into is
// render/carCabin.ts. x forward, y up, z right; metres.

import { BufferAttribute, BufferGeometry, Float32BufferAttribute, Vector3 } from 'three/webgpu';
import { PAINT, PartList, bar, box, profile, slab, type P2 } from './vehicleParts.ts';

export type CarStyle = 'hatch' | 'sedan' | 'wagon' | 'suv' | 'pickup' | 'van';
type DoorSide = -1 | 1;

/** What a car class is drawn from, metres. */
export interface CarArchetype { readonly length: number; readonly width: number; readonly height: number; readonly wheelRadius: number }

/**
 * A lamp or a plate as a box in the car's frame (x forward, y up, z right), metres. `face`: the lamp shaped to the body
 * instead (a car's nose and tail are rounded in plan, where a box set at one x stood out of the corner by up to 15 cm),
 * in the same frame; drawn in place of the box when present.
 */
export interface Lamp {
  readonly x: number; readonly y: number; readonly z: number; readonly sx: number; readonly sy: number; readonly sz: number;
  readonly face?: BufferGeometry;
}

/** A car's geometry: vertex colours white where the paint goes. */
export interface CarBody {
  readonly shell: BufferGeometry;
  readonly glass: BufferGeometry;
  readonly trim: BufferGeometry;
  /** The same surface, glass dark and opaque (the middle distance). */
  readonly far: BufferGeometry;
  readonly headlamps: readonly Lamp[];
  readonly taillamps: readonly Lamp[];
  readonly indicators: readonly (Lamp & { readonly side: DoorSide; readonly front: boolean })[];
  readonly plates: readonly Lamp[];
  /** Axle positions along x. */
  readonly axles: readonly number[];
}

// ---------------------------------------------------------------- palette (vertex colours multiply the paint)

const BLACKOUT = 0x16171a;
const SEAM = 0x2a2b2d;
const DARK_TRIM = 0x1c1d20;
const LINER = 0x0b0b0c;
const GRILLE = 0x0d0e10;
const COVER = 0x1f2124;
const MIRROR_GLASS = 0x6f7d86;

// ---------------------------------------------------------------- styles (4.0's lines)

/** A style's shape, metres from the middle of the car (x, forward positive) and from the road (y). */
export interface Style {
  readonly clearance: number;
  /** Floor above the road. */
  readonly floor: number;
  /** Distance from a front hip point back to the rear one (the couple distance), metres. */
  readonly couple: number;
  /** A van's cab: upright seats over a high floor instead of reclined car seats. */
  readonly cab?: boolean;
  /** The top line, front to back: (x, y) as fractions of length and height. */
  readonly top: readonly (readonly [number, number])[];
  /** Front and rear bottom: how far the bumpers tuck up. */
  readonly noseLift: number;
  readonly tailLift: number;
  /** Windscreen base and top, x as a fraction of length. */
  readonly screen: readonly [number, number];
  /** Rear window top and base, x as a fraction of length; null for none (a van's blind back). */
  readonly rear: readonly [number, number] | null;
  /** Belt height at the front and the back of the glasshouse, fraction of height. */
  readonly belt: readonly [number, number];
  /** Door edges front to back, fractions of length. */
  readonly doors: readonly number[];
  /** Side glass behind the last door (a quarter window). */
  readonly quarter: boolean;
  /** Roof edge inset from the waist, metres (tumblehome). */
  readonly tumble: number;
  /** Plan corner radii, metres. */
  readonly noseRadius: number;
  readonly tailRadius: number;
  /** A pick-up's bed: from this x (fraction) back, the top is a covered load bed. */
  readonly bedFrom?: number;
  /** Driver's hip x, fraction of length. */
  readonly hip: number;
}

const STYLES: Record<CarStyle, Style> = {
  sedan: {
    clearance: 0.14, floor: 0.24, couple: 0.9,
    top: [[0.5, 0.43], [0.485, 0.5], [0.44, 0.555], [0.33, 0.6], [0.215, 0.645], [0.13, 0.78], [0.04, 0.995], [-0.05, 1], [-0.14, 0.995], [-0.24, 0.995],
      [-0.3, 0.9], [-0.36, 0.675], [-0.44, 0.665], [-0.49, 0.63], [-0.5, 0.56]],
    noseLift: 0.12, tailLift: 0.12, screen: [0.215, 0.045], rear: [-0.17, -0.29], belt: [0.635, 0.69],
    doors: [0.215, -0.035, -0.205], quarter: true, tumble: 0.2, noseRadius: 0.42, tailRadius: 0.32, hip: 0.035,
  },
  wagon: {
    clearance: 0.14, floor: 0.24, couple: 0.9,
    top: [[0.5, 0.43], [0.485, 0.5], [0.44, 0.555], [0.33, 0.6], [0.215, 0.645], [0.13, 0.78], [0.04, 0.965], [-0.05, 1], [-0.25, 0.985], [-0.44, 0.955],
      [-0.47, 0.88], [-0.495, 0.7], [-0.5, 0.6]],
    noseLift: 0.12, tailLift: 0.12, screen: [0.215, 0.045], rear: [-0.45, -0.49], belt: [0.635, 0.69],
    doors: [0.215, -0.035, -0.205], quarter: true, tumble: 0.18, noseRadius: 0.42, tailRadius: 0.22, hip: 0.035,
  },
  hatch: {
    clearance: 0.14, floor: 0.24, couple: 0.86,
    top: [[0.5, 0.43], [0.485, 0.5], [0.44, 0.56], [0.33, 0.605], [0.19, 0.645], [0.1, 0.8], [0.02, 0.975], [-0.12, 1], [-0.32, 0.98], [-0.41, 0.93],
      [-0.46, 0.78], [-0.49, 0.66], [-0.5, 0.58]],
    noseLift: 0.12, tailLift: 0.12, screen: [0.19, 0.03], rear: [-0.41, -0.47], belt: [0.64, 0.69],
    doors: [0.2, -0.046, -0.25], quarter: true, tumble: 0.17, noseRadius: 0.4, tailRadius: 0.22, hip: -0.02,
  },
  suv: {
    clearance: 0.2, floor: 0.34, couple: 0.9,
    top: [[0.5, 0.44], [0.488, 0.52], [0.45, 0.575], [0.33, 0.61], [0.2, 0.635], [0.13, 0.76], [0.06, 0.965], [-0.04, 1], [-0.3, 0.99], [-0.44, 0.975],
      [-0.475, 0.9], [-0.495, 0.68], [-0.5, 0.58]],
    noseLift: 0.1, tailLift: 0.1, screen: [0.2, 0.06], rear: [-0.45, -0.49], belt: [0.62, 0.66],
    doors: [0.21, -0.02, -0.21], quarter: true, tumble: 0.16, noseRadius: 0.36, tailRadius: 0.24, hip: 0.025,
  },
  pickup: {
    clearance: 0.22, floor: 0.36, couple: 0.86,
    top: [[0.5, 0.45], [0.488, 0.54], [0.45, 0.6], [0.33, 0.63], [0.21, 0.645], [0.14, 0.77], [0.07, 0.965], [-0.02, 1], [-0.2, 0.99], [-0.235, 0.96],
      [-0.25, 0.64], [-0.27, 0.6], [-0.49, 0.6], [-0.5, 0.52]],
    noseLift: 0.1, tailLift: 0.08, screen: [0.21, 0.07], rear: [-0.235, -0.248], belt: [0.62, 0.64],
    doors: [0.21, -0.02, -0.22], quarter: false, tumble: 0.14, noseRadius: 0.34, tailRadius: 0.12, bedFrom: -0.25, hip: 0.025,
  },
  van: {
    clearance: 0.16, floor: 0.4, couple: 0, cab: true,
    top: [[0.5, 0.3], [0.488, 0.36], [0.46, 0.43], [0.41, 0.47], [0.37, 0.5], [0.31, 0.7], [0.26, 0.95], [0.2, 0.995], [0, 1], [-0.47, 0.995],
      [-0.495, 0.96], [-0.5, 0.88]],
    noseLift: 0.08, tailLift: 0.06, screen: [0.375, 0.24], rear: null, belt: [0.49, 0.5],
    doors: [0.3, 0.04], quarter: false, tumble: 0.08, noseRadius: 0.36, tailRadius: 0.1, hip: 0.07,
  },
};

/** A style's lines. */
export const carStyle = (name: CarStyle): Style => STYLES[name];

/** Hip point over the floor (the seating package), and a van cab's. */
export const CAR_HIP_OVER_FLOOR = 0.27, CAB_HIP_OVER_FLOOR = 0.45;

/** The simulation's five car styles, with the sizes the bodies and the seats are built at (metres). */
export const CAR_SIZES: Readonly<Record<Exclude<CarStyle, 'wagon'>, CarArchetype>> = {
  sedan: { length: 4.4, width: 1.84, height: 1.45, wheelRadius: 0.33 },
  hatch: { length: 3.9, width: 1.72, height: 1.48, wheelRadius: 0.31 },
  suv: { length: 4.6, width: 1.95, height: 1.78, wheelRadius: 0.37 },
  van: { length: 4.9, width: 2.0, height: 2.2, wheelRadius: 0.35 },
  pickup: { length: 5.3, width: 1.95, height: 1.8, wheelRadius: 0.37 },
};

/** Seats of a car style in the renderer's frame (+z forward, +x the driver's left): hip points (m). */
export function carSeatPoints(style: Exclude<CarStyle, 'wagon'>): Array<[number, number, number]> {
  const s = STYLES[style], a = CAR_SIZES[style];
  const hipY = s.floor + (s.cab ? CAB_HIP_OVER_FLOOR : CAR_HIP_OVER_FLOOR);
  const z = a.width / 2 - 0.46;
  const rows = s.doors.length - 1;
  const out: Array<[number, number, number]> = [];
  // numbered as the simulation numbers them: the driver's (left) side front to back, then the kerb side
  for (const side of [-1, 1] as const) {
    for (let row = 0; row < rows; row++) out.push([side < 0 ? z : -z, hipY, s.hip * a.length - row * s.couple]);
  }
  return out;
}

/** Axle positions, metres (the wheels are placed there). */
export function axlesOf(a: CarArchetype): number[] {
  return [a.length * 0.31, -a.length * 0.31];
}

// ---------------------------------------------------------------- the shape's lines

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));

/**
 * A line through points sorted by x as a table of `n` heights at even steps, read by linear interpolation: a monotone
 * cubic between the points (the tangent at a point is the harmonic mean of its neighbours' slopes, zero at a crest
 * or a trough), so the roof line never overshoots a point and a lookup costs no search.
 */
function lineTable(points: readonly P2[], n: number): (x: number) => number {
  const m = points.length, x0 = points[0][0], x1 = points[m - 1][0];
  const slope = new Float64Array(m - 1), tangent = new Float64Array(m);
  for (let i = 0; i < m - 1; i++) slope[i] = (points[i + 1][1] - points[i][1]) / Math.max(1e-9, points[i + 1][0] - points[i][0]);
  tangent[0] = slope[0]; tangent[m - 1] = slope[m - 2];
  for (let i = 1; i < m - 1; i++) {
    const a = slope[i - 1], b = slope[i], ha = points[i][0] - points[i - 1][0], hb = points[i + 1][0] - points[i][0];
    tangent[i] = a * b <= 0 ? 0 : (3 * (ha + hb)) / ((2 * hb + ha) / a + (hb + 2 * ha) / b);
  }
  const table = new Float32Array(n + 1);
  for (let k = 0, i = 0; k <= n; k++) {
    const x = lerp(x0, x1, k / n);
    while (i < m - 2 && x > points[i + 1][0]) i++;
    const h = points[i + 1][0] - points[i][0], t = (x - points[i][0]) / h, t2 = t * t, t3 = t2 * t;
    table[k] = (2 * t3 - 3 * t2 + 1) * points[i][1] + (t3 - 2 * t2 + t) * h * tangent[i] + (3 * t2 - 2 * t3) * points[i + 1][1] + (t3 - t2) * h * tangent[i + 1];
  }
  return (x: number): number => {
    const f = clamp01((x - x0) / (x1 - x0)) * n, k = Math.min(n - 1, Math.floor(f));
    return lerp(table[k], table[k + 1], f - k);
  };
}

/** The lines a body is lofted from. */
export interface CarShape {
  readonly top: (x: number) => number;
  readonly bottom: (x: number) => number;
  readonly belt: (x: number) => number;
  /** Half the width at the waist, at x. */
  readonly halfWidth: (x: number) => number;
  /** Half the width of the glasshouse at height y over x. */
  readonly sideAt: (x: number, y: number) => number;
  readonly floor: number;
  readonly front: number;
  readonly back: number;
  readonly doorEdges: readonly number[];
  readonly screenBase: number;
  readonly screenTop: number;
}

/** The lines of class `a` in style `name`: the top from the style's points, the bottom with the bumpers tucked up over
 *  their last 0.35 m (nose) and 0.3 m (tail), the belt sloping from the screen's base to the tail, the plan rounded
 *  at the nose and tail, the glasshouse leaning in by the tumblehome. */
export function carShape(a: CarArchetype, name: CarStyle): CarShape {
  const s = STYLES[name], L = a.length, W = a.width, H = a.height, front = L / 2, back = -L / 2;
  const top = lineTable(s.top.map(([x, y]) => [x * L, y * H] as P2).sort((p, q) => p[0] - q[0]), 256);
  const bottom = (x: number): number => {
    const f = clamp01((x - (front - 0.35)) / 0.35), r = clamp01((back + 0.3 - x) / 0.3);
    return s.clearance + s.noseLift * f * f + s.tailLift * r * r;
  };
  const beltFront = s.belt[0] * H, beltRear = s.belt[1] * H, screenBase = s.screen[0] * L;
  const belt = (x: number): number => lerp(beltFront, beltRear, clamp01((screenBase - x) / (screenBase - back)));
  const nr = s.noseRadius, tr = s.tailRadius;
  const halfWidth = (x: number): number => {
    const f = x - (front - nr), r = back + tr - x;
    if (f > 0) return W / 2 - nr + Math.sqrt(Math.max(0, nr * nr - f * f));
    if (r > 0) return W / 2 - tr + Math.sqrt(Math.max(0, tr * tr - r * r));
    return W / 2;
  };
  const lean = s.tumble / Math.max(1e-6, H - beltFront);
  return {
    top, bottom, belt, halfWidth, sideAt: (x, y) => halfWidth(x) - Math.max(0, y - belt(x)) * lean,
    floor: s.floor, front, back, doorEdges: s.doors.map((f) => f * L), screenBase, screenTop: s.screen[1] * L,
  };
}

// ---------------------------------------------------------------- the loft

/** What a quad of the loft is. */
const Region = { Paint: 0, Roof: 1, Glass: 2, Frame: 3, Pillar: 4, Seam: 5, Under: 6, Liner: 7, Valance: 8, Cover: 9 } as const;
type Region = (typeof Region)[keyof typeof Region];
const REGION_COLOUR = [PAINT, PAINT, PAINT, BLACKOUT, BLACKOUT, SEAM, LINER, LINER, DARK_TRIM, COVER];

/** Rows of a section's right half, bottom centre to top centre. */
const Row = { BottomCentre: 0, WellInner: 1, Well: 2, BottomEdge: 3, SideLow: 6, Sill: 7, Lower1: 8, Lower2: 9, Belt: 10, BeltFrame: 11, TopFrame: 15, GlassTop: 16, RoofEdge: 20 } as const;
const HALF = 24;
/** Points round a station: the right half, then the left mirrored without the two centres again. */
const RING = HALF * 2 - 2;
/** The row and side (±1) of ring point `j`. */
const rowOf = (j: number): number => (j < HALF ? j : RING - j);
const sideOf = (j: number): DoorSide => (j < HALF ? 1 : -1);

/** The edges of the windscreen's and the side glass's frames, the B-pillars, the doors' shut lines, the roof's and the
 *  bottom's edge radii, metres. */
const FRAME = 0.035, PILLAR_B = 0.05, SHUT = 0.004, ROOF_R = 0.075, BOTTOM_R = 0.06;

/**
 * A car of class `a` in style `name`. `stations`: the uniform stations along the body (64), `arch` the stations over
 * each wheel arch (18) and `ends` those rounding the nose and the tail (8): fewer for a lighter body.
 */
export function buildCarBody(a: CarArchetype, name: CarStyle, stations = 64, arch = 18, ends = 8): CarBody {
  const st = STYLES[name], shape = carShape(a, name);
  const { top, bottom, belt, halfWidth, front, back, screenBase, screenTop, doorEdges } = shape;
  const L = a.length, W = a.width, r = a.wheelRadius, axles = axlesOf(a);
  const archR = r + 0.07, archY = r * 0.96, tread = W * 0.14, archIn = W / 2 - tread - 0.05;
  const archTop = (x: number): number => {
    let y = -Infinity;
    for (const ax of axles) { const dx = x - ax; if (Math.abs(dx) < archR) y = Math.max(y, archY + Math.sqrt(archR * archR - dx * dx)); }
    return y;
  };
  const inArchX = (x: number): boolean => Math.abs(x - axles[0]) < archR || Math.abs(x - axles[1]) < archR;
  const perSide = doorEdges.length - 1, lastDoor = doorEdges[perSide];
  const rear = st.rear ? { top: st.rear[0] * L, base: st.rear[1] * L } : null;
  const bedFrom = st.bedFrom !== undefined ? st.bedFrom * L : -Infinity;
  const crownOf = (x: number): number => (x > screenBase || x < bedFrom ? 0.02 : 0.045);
  // the side glass runs from the A-pillar to the C-pillar (or the last door)
  const glassFront = screenBase - 0.06;
  const glassBack = st.quarter && rear ? Math.max(rear.top + 0.12, lastDoor - 0.55) : lastDoor + 0.05;
  // the glasshouse's lean per metre of height, measured at the car's middle
  const leanRate = halfWidth(0) - shape.sideAt(0, belt(0) + 1);

  // ---- stations: uniform, plus every feature edge, 4 mm apart at least
  const wanted: number[] = [];
  for (let i = 0; i <= stations; i++) wanted.push(lerp(back, front, i / stations));
  for (let i = 1; i <= ends; i++) wanted.push(front - (0.12 * i) / ends, back + (0.12 * i) / ends);
  for (const ax of axles) {
    for (let i = 0; i <= arch; i++) wanted.push(ax - archR + (2 * archR * i) / arch);
    wanted.push(ax - archR - 0.002, ax + archR + 0.002);
  }
  for (const e of doorEdges) wanted.push(e - SHUT, e + SHUT, e - PILLAR_B, e + PILLAR_B);
  wanted.push(screenBase, screenBase - FRAME, screenTop, screenTop + FRAME, glassFront, glassFront - FRAME, glassBack, glassBack + FRAME);
  if (rear) wanted.push(rear.top, rear.top - FRAME, rear.base, rear.base + FRAME);
  if (Number.isFinite(bedFrom)) wanted.push(bedFrom, bedFrom - 0.04);
  wanted.sort((p, q) => p - q);
  const xs: number[] = [];
  for (const x of wanted) if (x >= back - 1e-9 && x <= front + 1e-9 && (xs.length === 0 || x - xs[xs.length - 1] > 0.004)) xs.push(x);
  const S = xs.length;

  // ---- the grid: S rings of RING points, and which of the right half's points the wheel arches lifted
  const grid = new Float32Array((S * RING + 2) * 3);
  const lifted = new Uint8Array(S * HALF);
  const sz = new Float64Array(HALF), sy = new Float64Array(HALF);
  for (let i = 0; i < S; i++) {
    const x = xs[i], b = bottom(x), t = top(x), hw = halfWidth(x);
    const yS = Math.min(belt(x), t - ROOF_R - 0.002), yT = t - ROOF_R;
    // the side bulges out a little between the bottom and the belt, and leans in above it
    const c = (b + yS) / 2, h = Math.max(1e-6, (yS - b) / 2);
    const bulge = (y: number): number => hw * (1 - 0.02 * ((y - c) / h) ** 2);
    const side = (y: number): number => (y <= yS ? bulge(y) : bulge(yS) - (y - yS) * leanRate);
    const put = (row: number, z: number, y: number): void => { sz[row] = Math.max(0, z); sy[row] = y; };
    const zb = hw - 0.03, sLow = b + BOTTOM_R;
    put(Row.BottomCentre, 0, b);
    put(Row.WellInner, Math.min(archIn - 0.01, zb - BOTTOM_R - 0.02), b);
    put(Row.Well, Math.min(archIn, zb - BOTTOM_R - 0.01), b);
    put(Row.BottomEdge, zb - BOTTOM_R, b);
    // the bottom corner: a quarter ellipse up to the side
    for (let k = 1; k <= 2; k++) {
      const a2 = (k / 3) * (Math.PI / 2);
      put(Row.BottomEdge + k, zb - BOTTOM_R + Math.sin(a2) * (bulge(sLow) - (zb - BOTTOM_R)), b + (1 - Math.cos(a2)) * BOTTOM_R);
    }
    put(Row.SideLow, bulge(sLow), sLow);
    const sill = Math.min(yS - 0.02, Math.max(sLow + 0.01, st.clearance + 0.17));
    put(Row.Sill, bulge(sill), sill);
    put(Row.Lower1, bulge(lerp(sill, yS, 0.4)), lerp(sill, yS, 0.4));
    put(Row.Lower2, bulge(lerp(sill, yS, 0.78)), lerp(sill, yS, 0.78));
    put(Row.Belt, bulge(yS), yS);
    // the glasshouse: its frame rows and the glass between them
    const g = Math.max(0, yT - yS), fb = g > 0 ? Math.min(0.5, FRAME / g) : 0;
    const glassRows = [fb, lerp(fb, 1 - fb, 0.2), lerp(fb, 1 - fb, 0.5), lerp(fb, 1 - fb, 0.8), 1 - fb, 1];
    for (let k = 0; k < 6; k++) { const y = yS + g * glassRows[k]; put(Row.BeltFrame + k, side(y), y); }
    // the roof's edge: a quarter ellipse into the roof, and the crown over to the centre
    const zT = side(yT), rr = Math.min(ROOF_R, zT * 0.45);
    for (let k = 1; k <= 3; k++) { const a2 = (k / 4) * (Math.PI / 2); put(Row.GlassTop + k, zT - rr + Math.cos(a2) * rr, yT + Math.sin(a2) * ROOF_R); }
    put(Row.RoofEdge, zT - rr, t);
    const crown = crownOf(x);
    for (let k = 1; k <= 3; k++) { const f = 1 - k / 3; put(Row.RoofEdge + k, (zT - rr) * f, t + crown * (1 - f * f)); }
    // the wheel arches: everything outboard of the well, below the arch, is lifted onto it
    if (inArchX(x)) {
      const at = archTop(x);
      for (let row = Row.Well; row <= Row.Lower2; row++) if (sz[row] >= archIn - 0.005 && sy[row] < at) { sy[row] = at; lifted[i * HALF + row] = 1; }
    }
    // the nose and the tail roll into their end faces over the last 6 cm
    const edge = Math.min(front - x, x - back);
    if (edge < 0.06) {
      const u = 1 - edge / 0.06, k = 1 - (1 - Math.sqrt(Math.max(0, 1 - u * u))) * 0.9, cy = (b + t) / 2;
      for (let row = 0; row < HALF; row++) { sz[row] -= (1 - k) * 0.05 * (sz[row] / Math.max(1e-6, hw)); sy[row] = cy + (sy[row] - cy) * (1 - (1 - k) * 0.06); }
    }
    for (let j = 0; j < RING; j++) {
      const row = rowOf(j), o = (i * RING + j) * 3;
      grid[o] = x; grid[o + 1] = sy[row]; grid[o + 2] = sideOf(j) * sz[row];
    }
  }
  const vid = (i: number, j: number): number => i * RING + ((j % RING) + RING) % RING;
  const yAt = (v: number): number => grid[v * 3 + 1];

  // ---- every quad classified
  const regions = new Uint8Array((S - 1) * RING);
  const inDoor = (x: number): number => {
    for (let d = 0; d < perSide; d++) if (x < doorEdges[d] - SHUT && x > doorEdges[d + 1] + SHUT) return d;
    return -1;
  };
  const nearB = (x: number): boolean => { for (let d = 1; d < perSide; d++) if (Math.abs(x - doorEdges[d]) < PILLAR_B) return true; return false; };
  const nearShut = (x: number): boolean => doorEdges.some((e) => Math.abs(x - e) < SHUT * 1.01);
  const isScreen = (x: number): boolean => x < screenBase && x > screenTop;
  const isRear = (x: number): boolean => rear !== null && x < rear.top && x > rear.base;
  const onRoof = (x: number): boolean => x <= screenTop && (rear === null || x >= rear.top) && x > bedFrom;
  for (let i = 0; i < S - 1; i++) {
    const xm = (xs[i] + xs[i + 1]) / 2, archX = inArchX(xm), door = inDoor(xm);
    for (let j = 0; j < RING; j++) {
      // the quad spans rows [row, row + 1] on one side (the ring wraps at the centres)
      const row = Math.min(rowOf(j), rowOf(j + 1)), rowL = Math.min(row, HALF - 1);
      const lift = archX && (lifted[i * HALF + rowL] === 1 || lifted[(i + 1) * HALF + rowL] === 1);
      let region: Region;
      if (row < Row.BottomEdge) region = archX && row >= Row.WellInner ? Region.Liner : Region.Under;
      else if (row < Row.SideLow) region = lift ? Region.Liner : Region.Under;
      else if (row < Row.Belt) {
        region = lift && row < Row.Sill ? Region.Liner : Region.Paint;
        if (row < Row.Sill && (xm > front - 0.3 || xm < back + 0.25)) region = Region.Valance;
        if (row >= Row.Sill && nearShut(xm) && xm < doorEdges[0] + SHUT && xm > lastDoor - SHUT) region = Region.Seam;
      } else if (row < Row.GlassTop) {
        // the belt to the top of the side glass
        const glassX = xm < glassFront && xm > glassBack;
        const framed = row === Row.Belt || row === Row.TopFrame || xm > glassFront - FRAME || xm < glassBack + FRAME;
        region = glassX ? (nearB(xm) ? Region.Pillar : framed ? Region.Frame : Region.Glass) : Region.Paint;
        if (xm < bedFrom) region = Region.Paint;
        else if (xm > glassFront && xm < screenBase + 0.02 && region === Region.Paint) region = Region.Pillar;
      } else if (row < Row.RoofEdge) {
        // the roof's rounded edge: pillars over the screens, paint over the roof
        region = isScreen(xm) || isRear(xm) ? Region.Pillar : xm < bedFrom ? Region.Paint : onRoof(xm) ? Region.Roof : Region.Paint;
      } else {
        // the top: windscreen, roof, rear window, bonnet, boot, bed
        if (isScreen(xm)) region = xm > screenBase - FRAME || xm < screenTop + FRAME || row === Row.RoofEdge ? Region.Frame : Region.Glass;
        else if (isRear(xm)) region = xm > rear!.top - FRAME || xm < rear!.base + FRAME || row === Row.RoofEdge ? Region.Frame : Region.Glass;
        else if (xm < bedFrom - 0.04) region = Region.Cover;
        else region = onRoof(xm) ? Region.Roof : Region.Paint;
      }
      void door;
      regions[i * RING + j] = region;
    }
  }

  // ---- the end caps' centres, and smooth normals over the whole loft
  const capBase = S * RING;
  for (const [i, sign] of [[0, -1], [S - 1, 1]] as const) {
    let cy = 0;
    for (let j = 0; j < RING; j++) cy += yAt(vid(i, j));
    const o = (capBase + (sign > 0 ? 1 : 0)) * 3;
    grid[o] = xs[i] + sign * 0.004; grid[o + 1] = cy / RING; grid[o + 2] = 0;
  }
  const index = new Uint32Array((S - 1) * RING * 6 + RING * 6);
  let n = 0;
  for (let i = 0; i < S - 1; i++) for (let j = 0; j < RING; j++) {
    const p = vid(i, j), q = vid(i + 1, j), s2 = vid(i + 1, j + 1), d = vid(i, j + 1);
    index[n++] = p; index[n++] = q; index[n++] = s2; index[n++] = p; index[n++] = s2; index[n++] = d;
  }
  for (let j = 0; j < RING; j++) { index[n++] = capBase; index[n++] = vid(0, j); index[n++] = vid(0, j + 1); index[n++] = capBase + 1; index[n++] = vid(S - 1, j); index[n++] = vid(S - 1, j + 1); }
  const loft = new BufferGeometry();
  loft.setAttribute('position', new BufferAttribute(grid, 3));
  loft.setIndex(new BufferAttribute(index, 1));
  loft.computeVertexNormals();
  const normals = loft.getAttribute('normal').array as Float32Array;
  // the winding faces outwards: checked on a roof quad
  let probe = 0;
  for (let k = 0; k < regions.length; k++) if (regions[k] === Region.Roof) { probe = k; break; }
  const pa = new Vector3().fromArray(grid, index[probe * 6] * 3), pb = new Vector3().fromArray(grid, index[probe * 6 + 1] * 3), pc = new Vector3().fromArray(grid, index[probe * 6 + 2] * 3);
  const flip = pb.sub(pa).cross(pc.sub(pa)).y < 0;
  const sign = flip ? -1 : 1;

  // ---- the loft written out by region: the shell, the glass, and the far model with its glass dark
  const shell = new PartList(), glass = new PartList(), far = new PartList();
  const tri = new Float64Array(9), nor = new Float64Array(9);
  const vertex = (v: number, k: number): void => {
    tri[k] = grid[v * 3]; tri[k + 1] = grid[v * 3 + 1]; tri[k + 2] = grid[v * 3 + 2];
    nor[k] = normals[v * 3] * sign; nor[k + 1] = normals[v * 3 + 1] * sign; nor[k + 2] = normals[v * 3 + 2] * sign;
  };
  const emit = (p: number, q: number, s2: number, region: Region): void => {
    vertex(p, 0); vertex(flip ? s2 : q, 3); vertex(flip ? q : s2, 6);
    const hex = REGION_COLOUR[region];
    (region === Region.Glass ? glass : shell).triangles(tri, nor, hex);
    far.triangles(tri, nor, region === Region.Glass ? BLACKOUT : hex);
  };
  for (let i = 0; i < S - 1; i++) for (let j = 0; j < RING; j++) {
    const region = regions[i * RING + j] as Region;
    const p = vid(i, j), q = vid(i + 1, j), s2 = vid(i + 1, j + 1), d = vid(i, j + 1);
    emit(p, q, s2, region); emit(p, s2, d, region);
  }
  // the caps: flat, painted above the sill line (where the side's dark valance band stops, so the band runs on round
  // the corner), dark trim below it
  const capPos: number[] = [], painted: number[] = [], dark: number[] = [];
  for (const [i, end] of [[0, -1], [S - 1, 1]] as const) {
    const centre = capBase + (end > 0 ? 1 : 0);
    for (let j = 0; j < RING; j++) {
      const p = vid(i, j), q = vid(i, j + 1), out = (end > 0) !== flip;
      for (const v of [centre, out ? p : q, out ? q : p]) capPos.push(grid[v * 3], grid[v * 3 + 1], grid[v * 3 + 2]);
    }
  }
  const sillBack = yAt(vid(0, Row.Sill)), sillFront = yAt(vid(S - 1, Row.Sill));
  for (let k = 0; k < capPos.length; k += 9) {
    // wound to face out along x: the fan's order turns with the side
    const facesOut = ((capPos[k + 4] - capPos[k + 1]) * (capPos[k + 8] - capPos[k + 2]) - (capPos[k + 5] - capPos[k + 2]) * (capPos[k + 7] - capPos[k + 1])) * Math.sign(capPos[k]) > 0;
    const t: V3[] = facesOut
      ? [[capPos[k], capPos[k + 1], capPos[k + 2]], [capPos[k + 3], capPos[k + 4], capPos[k + 5]], [capPos[k + 6], capPos[k + 7], capPos[k + 8]]]
      : [[capPos[k], capPos[k + 1], capPos[k + 2]], [capPos[k + 6], capPos[k + 7], capPos[k + 8]], [capPos[k + 3], capPos[k + 4], capPos[k + 5]]];
    splitAtY(t, capPos[k] > 0 ? sillFront : sillBack, painted, dark);
  }
  for (const list of [shell, far]) list.triangles(painted, null, PAINT).triangles(dark, null, DARK_TRIM);

  // ---- trim: grille, wheel-house liners, handles and mirrors
  const trim = new PartList();
  const noseY = top(front - 0.02), grilleY = (bottom(front) + noseY) / 2 + 0.03;
  trim.add(slab(0.03, halfWidth(front - 0.02) * 0.95, 0.02, 0.13, front - 0.012, grilleY - 0.065, 0), GRILLE);
  for (const ax of axles) {
    // a dark half drum over each tyre, inside the arch
    const band: P2[] = [], ra = archR * 0.98;
    for (let i = 0; i <= 12; i++) { const x = ax - ra + (2 * ra * i) / 12; band.push([x, archY + Math.sqrt(Math.max(0, ra * ra - (x - ax) ** 2))]); }
    for (let i = 12; i >= 0; i--) band.push([band[i][0], band[i][1] + 0.03]);
    for (const side of [-1, 1] as const) trim.add(profile(band, tread + 0.06, 0, side * (W / 2 - tread / 2 - 0.02)), LINER);
  }
  // the skin's z at (x, y) on the side, as the loft bulges it
  const skinAt = (x: number, y: number): number => {
    const b0 = bottom(x), yS = Math.min(belt(x), top(x) - ROOF_R), c = (b0 + yS) / 2, h = Math.max(1e-6, (yS - b0) / 2);
    return halfWidth(x) * (1 - 0.02 * ((y - c) / h) ** 2);
  };
  for (const side of [-1, 1] as const) {
    for (let d = 0; d < perSide; d++) {
      const x0 = doorEdges[d] - SHUT, x1 = doorEdges[d + 1] + SHUT;
      const handleX = x1 + Math.min(0.2, (x0 - x1) * 0.25), handleY = belt(handleX) - 0.09;
      trim.add(box(0.17, 0.028, 0.03, handleX + 0.06, handleY, side * (skinAt(handleX, handleY) + 0.008)), DARK_TRIM);
      if (d === 0) {
        const mx = x0 - 0.12, my = belt(mx) + 0.06, mz = skinAt(mx, belt(mx));
        trim.add(bar(new Vector3(mx, my - 0.03, side * (mz - 0.02)), new Vector3(mx - 0.04, my, side * (mz + 0.1)), 0.035), DARK_TRIM);
        trim.add(slab(0.11, 0.2, 0.045, 0.11, mx - 0.06, my - 0.02, side * (mz + 0.17)));
        trim.add(box(0.008, 0.085, 0.17, mx - 0.117, my + 0.035, side * (mz + 0.17)), MIRROR_GLASS);
      }
    }
  }

  // ---- lamps and plates, each shaped to the body where it is
  const lampY = lerp(bottom(front), noseY, 0.72), tailY = lerp(bottom(back), top(back + 0.05), 0.7);
  // the x of the nose (tail) surface at a half-width, searched inwards
  const noseAt = (z: number): number => { let x = front; while (x > front - 0.6 && halfWidth(x) < Math.abs(z)) x -= 0.005; return x; };
  const tailAt = (z: number): number => { let x = back; while (x < back + 0.6 && halfWidth(x) < Math.abs(z)) x += 0.005; return x; };
  const headlamps: Lamp[] = [], taillamps: Lamp[] = [], indicators: (Lamp & { side: DoorSide; front: boolean })[] = [];
  for (const side of [-1, 1] as const) {
    const hz = W / 2 - 0.26, tz = W / 2 - 0.18, iz = W / 2 - 0.08;
    headlamps.push({ x: noseAt(hz) - 0.005, y: lampY, z: side * hz, sx: 0.04, sy: 0.08, sz: 0.3 });
    taillamps.push({ x: tailAt(tz) + 0.005, y: tailY, z: side * tz, sx: 0.04, sy: name === 'van' ? 0.28 : 0.1, sz: 0.26 });
    indicators.push({ x: noseAt(iz) - 0.01, y: lampY - 0.03, z: side * iz, sx: 0.04, sy: 0.045, sz: 0.06, side, front: true });
    indicators.push({ x: tailAt(iz) + 0.01, y: tailY + 0.02, z: side * iz, sx: 0.04, sy: 0.05, sz: 0.05, side, front: false });
  }
  const plates: Lamp[] = [
    { x: front + 0.008, y: lerp(bottom(front), grilleY, 0.45), z: 0, sx: 0.012, sy: 0.11, sz: 0.52 },
    { x: back - 0.008, y: lerp(bottom(back), tailY, 0.55), z: 0, sx: 0.012, sy: 0.11, sz: 0.52 },
  ];
  const skin = Float64Array.from([...shell.positions(), ...glass.positions()]);
  // a lamp reaching past the body's outline at the corner moves in, 2 cm at a time, until it lies on the body
  const shaped = <T extends Lamp>(list: T[], ahead: (l: T) => boolean): T[] => list.map((l) => {
    let at: T = l, face = lampFace(skin, at, ahead(l));
    for (let k = 1; k <= 8 && face.getAttribute('position').count < 48; k++) {
      at = { ...l, z: l.z - Math.sign(l.z) * 0.02 * k };
      face = lampFace(skin, at, ahead(l));
    }
    return { ...at, face };
  });
  return {
    shell: shell.geometry(), glass: glass.geometry(), trim: trim.geometry(), far: far.geometry(),
    headlamps: shaped(headlamps, () => true), taillamps: shaped(taillamps, () => false),
    indicators: shaped(indicators, (l) => l.front), plates: shaped(plates, (l) => l.x > 0), axles,
  };
}

type V3 = [number, number, number];
/** Splits a triangle at the height `y` into the part above (to `up`) and below (to `down`), winding kept. */
function splitAtY(t: V3[], y: number, up: number[], down: number[]): void {
  const above = t.map((p) => p[1] >= y);
  const n = above.filter(Boolean).length;
  if (n === 3) { for (const p of t) up.push(...p); return; }
  if (n === 0) { for (const p of t) down.push(...p); return; }
  // the lone vertex (the one on its own side) first; the winding is kept
  const lone = above.findIndex((a) => (n === 1 ? a : !a));
  const a = t[lone], b = t[(lone + 1) % 3], c = t[(lone + 2) % 3];
  const at = (p: V3, q: V3): V3 => { const f = (y - p[1]) / (q[1] - p[1]); return [p[0] + (q[0] - p[0]) * f, y, p[2] + (q[2] - p[2]) * f]; };
  const ab = at(a, b), ac = at(a, c);
  for (const p of [a, ab, ac]) (n === 1 ? up : down).push(...p);
  for (const p of [ab, b, c, ab, c, ac]) (n === 1 ? down : up).push(...p);
}

/** Where a ray from far ahead (or behind) along x at (y, z) first meets the body's triangles (flat, 9 a triangle). */
function surfaceX(T: Float64Array, y: number, z: number, ahead: boolean): number {
  const dx = ahead ? -1 : 1, ox = ahead ? 50 : -50;
  let best = Infinity;
  for (let k = 0; k < T.length; k += 9) {
    // the ray runs along x: the triangle's projection on (y, z) must hold the point
    const ay = T[k + 1], az = T[k + 2], by = T[k + 4], bz = T[k + 5], cy = T[k + 7], cz = T[k + 8];
    const d = (by - cy) * (az - cz) + (cz - bz) * (ay - cy);
    if (Math.abs(d) < 1e-12) continue;
    const l1 = ((by - cy) * (z - cz) + (cz - bz) * (y - cy)) / d, l2 = ((cy - ay) * (z - cz) + (az - cz) * (y - cy)) / d, l3 = 1 - l1 - l2;
    if (l1 < 0 || l2 < 0 || l3 < 0) continue;
    const t = (l1 * T[k] + l2 * T[k + 3] + l3 * T[k + 6] - ox) * dx;
    if (t > 0 && t < best) best = t;
  }
  return best === Infinity ? NaN : ox + dx * best;
}

/**
 * A lamp's (or plate's) face on the body: a grid over its extent across (z) and up (y), each point 6 mm out from the
 * surface met along the length; cells with a corner off the body are left out. Faces ahead (+x) or behind.
 */
function lampFace(T: Float64Array, l: Lamp, ahead: boolean): BufferGeometry {
  const NZ = 4, NY = 2, out = ahead ? 0.006 : -0.006;
  const xs = new Float64Array((NZ + 1) * (NY + 1));
  for (let j = 0; j <= NY; j++) for (let i = 0; i <= NZ; i++) xs[j * (NZ + 1) + i] = surfaceX(T, l.y + (j / NY - 0.5) * l.sy, l.z + (i / NZ - 0.5) * l.sz, ahead);
  const pos: number[] = [];
  const at = (i: number, j: number): V3 => [xs[j * (NZ + 1) + i] + out, l.y + (j / NY - 0.5) * l.sy, l.z + (i / NZ - 0.5) * l.sz];
  for (let j = 0; j < NY; j++) for (let i = 0; i < NZ; i++) {
    const q = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
    if (q.some((p) => Number.isNaN(p[0]))) continue;
    // counter-clockwise seen from outside: ahead the face looks along +x (z right, y up)
    for (const k of ahead ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3]) pos.push(...q[k]);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/**
 * The same car as a light silhouette for the middle distance (a few hundred triangles): the style's own lines lofted
 * over a few stations, a ring of 7 points a side, the glasshouse dark between the belt and the roof edge, the rest
 * painted (white).
 */
export function buildCarSilhouette(a: CarArchetype, name: CarStyle, stations = 12): BufferGeometry {
  const st = STYLES[name], shape = carShape(a, name);
  const { top, bottom, belt, halfWidth, front, back, screenBase, screenTop } = shape;
  const rear = st.rear ? { top: st.rear[0] * a.length, base: st.rear[1] * a.length } : null;
  const xs: number[] = [screenBase, screenTop];
  for (let i = 0; i <= stations; i++) xs.push(lerp(back, front, i / stations));
  if (rear) xs.push(rear.top, rear.base);
  xs.sort((p, q) => p - q);
  const lean = halfWidth(0) - shape.sideAt(0, belt(0) + 1);
  const H = 7, GLASS_ROW = 3, DARK = 0x10161d;
  // half ring, bottom centre to roof centre: (z, y)
  const ring = (x: number, out: Float64Array): void => {
    const b = bottom(x), t = top(x), hw = halfWidth(x), yB = Math.min(belt(x), t - 0.08), zT = Math.max(0.05, hw - (t - 0.06 - yB) * lean);
    out.set([0, b, hw - 0.06, b, hw, b + 0.08, hw, yB, zT, t - 0.06, zT * 0.5, t, 0, t + 0.02]);
  };
  const glassX = (x: number): boolean => x < screenBase - 0.05 && x > (rear ? rear.top : back + 0.3);
  const dark = (x: number, j: number): boolean => (j === GLASS_ROW && glassX(x)) || (j >= 4 && ((x < screenBase && x > screenTop) || (rear !== null && x < rear.top && x > rear.base)));
  const parts = new PartList(), r0 = new Float64Array(H * 2), r1 = new Float64Array(H * 2), tri = new Float64Array(9);
  const put = (k: number, x: number, ring2: Float64Array, j: number, side: number): void => { tri[k] = x; tri[k + 1] = ring2[j * 2 + 1]; tri[k + 2] = side * ring2[j * 2]; };
  for (let i = 0; i + 1 < xs.length; i++) {
    const x0 = xs[i], x1 = xs[i + 1], xm = (x0 + x1) / 2;
    if (x1 - x0 < 1e-3) continue;
    ring(x0, r0); ring(x1, r1);
    for (const side of [-1, 1]) for (let j = 0; j + 1 < H; j++) {
      const hex = j === 0 ? LINER : dark(xm, j) ? DARK : PAINT;
      // counter-clockwise seen from outside: on the right (+z) side the quad goes along x then up
      const corners: Array<[number, Float64Array, number]> = [[x0, r0, j], [x1, r1, j], [x1, r1, j + 1], [x0, r0, j + 1]];
      for (const order of side > 0 ? [[0, 1, 2], [0, 2, 3]] : [[0, 2, 1], [0, 3, 2]]) {
        order.forEach((c, k) => put(k * 3, corners[c][0], corners[c][1], corners[c][2], side));
        parts.triangles(tri, null, hex);
      }
    }
  }
  // the nose and tail caps
  for (const [x, sgn] of [[xs[0], -1], [xs[xs.length - 1], 1]] as const) {
    ring(x, r0);
    const cy = (r0[1] + r0[(H - 1) * 2 + 1]) / 2;
    for (const side of [-1, 1]) for (let j = 0; j + 1 < H; j++) {
      const hex = j > GLASS_ROW && sgn > 0 ? DARK : PAINT;
      tri[0] = x; tri[1] = cy; tri[2] = 0;
      if (sgn * side > 0) { put(3, x, r0, j + 1, side); put(6, x, r0, j, side); } else { put(3, x, r0, j, side); put(6, x, r0, j + 1, side); }
      parts.triangles(tri, null, hex);
    }
  }
  return parts.geometry();
}

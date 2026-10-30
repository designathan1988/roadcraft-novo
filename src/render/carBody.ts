// Passenger cars built the way a car is designed: roadcraft 4.0's render/carBody.ts (roadcraft-4.0-main/src), the body
// surface lofted from its side profile, plan and sections, every face classified (paint, glass, frames, pillars, seams,
// liners, valances), with the trim, mirrors, handles and lamps. Brought over as geometry built once per style and drawn
// by instances (render/vehicles.ts), with a lean cabin for the near model (`buildCarCabin`); the opening doors of 4.0
// are left out for now. Units are metres.

import { BoxGeometry, BufferAttribute, BufferGeometry, Color, CylinderGeometry, ExtrudeGeometry, Float32BufferAttribute, Quaternion, Shape, TorusGeometry, Vector2, Vector3 } from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export type CarStyle = 'hatch' | 'sedan' | 'wagon' | 'suv' | 'pickup' | 'van';
type DoorSide = -1 | 1;

/** What a car class is drawn from (4.0 sim/vehicles/archetypes.ts), metres. */
export interface CarArchetype { readonly length: number; readonly width: number; readonly height: number; readonly wheelRadius: number }

/**
 * A lamp or a plate as a box in the car's frame (x forward, y up, z right), metres (4.0 vehicleModels.ts Lamp).
 * `face`: the lamp shaped to the body instead (a car's: its nose and tail are rounded in plan, where a box set at one x
 * stood out of the corner by up to 15 cm), in the same frame; drawn in place of the box when present.
 */
export interface Lamp {
  readonly x: number; readonly y: number; readonly z: number; readonly sx: number; readonly sy: number; readonly sz: number;
  readonly face?: BufferGeometry;
}

/** A car's geometry, in the 4.0 frame (x forward, z right): vertex colours white where the paint goes. */
export interface CarBody {
  readonly shell: BufferGeometry;
  readonly glass: BufferGeometry;
  readonly trim: BufferGeometry;
  /** The same surface, coarse, glass dark and opaque (the 4.0 far level). */
  readonly far: BufferGeometry;
  readonly headlamps: readonly Lamp[];
  readonly taillamps: readonly Lamp[];
  readonly indicators: readonly (Lamp & { readonly side: DoorSide; readonly front: boolean })[];
  readonly plates: readonly Lamp[];
  /** Axle positions along x. */
  readonly axles: readonly number[];
}

const M = (metres: number): number => metres;
// ---------------------------------------------------------------- palette (vertex colours multiply the paint)

const WHITE = 0xffffff;
const BLACKOUT = 0x16171a;
const SEAM = 0x2a2b2d;
const DARK_TRIM = 0x1c1d20;
const LINER = 0x0b0b0c;
const GRILLE = 0x0d0e10;
const COVER = 0x1f2124;
const MIRROR_GLASS = 0x6f7d86;

// ---------------------------------------------------------------- styles

/** A style's shape, metres from the middle of the car (x, forward positive) and from the road (y). */
interface Style {
  readonly clearance: number;
  /** Floor above the road. */
  readonly floor: number;
  /** Distance from a front hip point back to the rear one (the couple distance), metres. */
  readonly couple: number;
  /** A van's cab: upright seats over a high floor (`cab` posture) instead of reclined car seats. */
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

/** Hip point over the floor (roadcraft 4.0 `carBody.ts` seating package), and a van cab's. */
const CAR_HIP_OVER_FLOOR = 0.27, CAB_HIP_OVER_FLOOR = 0.45;

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
  const z = a.width / 2 - M(0.46);
  const rows = s.doors.length - 1;
  const out: Array<[number, number, number]> = [];
  // Numbered as the simulation numbers them: the driver's (left) side front to back, then the kerb side.
  for (const side of [-1, 1] as const) {
    for (let row = 0; row < rows; row++) out.push([side < 0 ? z : -z, hipY, s.hip * a.length - row * s.couple]);
  }
  return out;
}

// ---------------------------------------------------------------- small helpers

type P2 = readonly [number, number];
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));

function tint<T extends BufferGeometry>(g: T, hex: number): T {
  const c = new Color().setHex(hex);
  const n = g.getAttribute('position').count;
  const data = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { data[i * 3] = c.r; data[i * 3 + 1] = c.g; data[i * 3 + 2] = c.b; }
  g.setAttribute('color', new BufferAttribute(data, 3));
  return g;
}

/** Merges parts into one non-indexed geometry with position, normal and colour (white where none). */
function merge(parts: BufferGeometry[]): BufferGeometry {
  const ready = parts.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    if (!n.getAttribute('normal')) n.computeVertexNormals();
    if (!n.getAttribute('color')) tint(n, WHITE);
    for (const name of Object.keys(n.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'color') n.deleteAttribute(name);
    n.clearGroups();
    return n;
  });
  const merged = ready.length ? mergeGeometries(ready, false) : null;
  if (!merged) {
    const empty = new BufferGeometry();
    empty.setAttribute('position', new Float32BufferAttribute([], 3));
    empty.setAttribute('normal', new Float32BufferAttribute([], 3));
    empty.setAttribute('color', new Float32BufferAttribute([], 3));
    return empty;
  }
  return merged;
}

const box = (sx: number, sy: number, sz: number, x: number, y: number, z: number): BufferGeometry =>
  new BoxGeometry(sx, sy, sz).translate(x, y, z);

/** A bar between two points, `thick` square in section. */
function bar(a: Vector3, b: Vector3, thick: number, thickB = thick): BufferGeometry {
  const g = new BoxGeometry(thick, a.distanceTo(b), thickB);
  g.applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), b.clone().sub(a).normalize()));
  return g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
}

/** A rectangle rounded in plan, `height` tall, bottom at y. */
function roundedSlab(lx: number, lz: number, radius: number, height: number, x: number, y: number, z: number): BufferGeometry {
  const r = Math.min(radius, lx / 2 - 1e-4, lz / 2 - 1e-4);
  const s = new Shape();
  const hx = lx / 2;
  const hz = lz / 2;
  s.moveTo(-hx + r, -hz);
  s.lineTo(hx - r, -hz);
  s.quadraticCurveTo(hx, -hz, hx, -hz + r);
  s.lineTo(hx, hz - r);
  s.quadraticCurveTo(hx, hz, hx - r, hz);
  s.lineTo(-hx + r, hz);
  s.quadraticCurveTo(-hx, hz, -hx, hz - r);
  s.lineTo(-hx, -hz + r);
  s.quadraticCurveTo(-hx, -hz, -hx + r, -hz);
  const g = new ExtrudeGeometry(s, { depth: height, bevelEnabled: false, curveSegments: 3 });
  g.rotateX(-Math.PI / 2);
  return g.translate(x, y, z);
}

/** A side profile extruded across, bevelled, centred on z. */
function extrude(points: readonly P2[], width: number, bevel: number, z = 0): BufferGeometry {
  const shape = new Shape(points.map(([x, y]) => new Vector2(x, y)));
  const depth = Math.max(1e-3, width - bevel * 2);
  const g = new ExtrudeGeometry(shape, {
    depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.8, bevelOffset: -bevel * 0.8,
    bevelSegments: bevel > 0 ? 2 : 0, curveSegments: 4,
  });
  return g.translate(0, 0, -depth / 2 + z);
}

/** Monotone cubic interpolation (Fritsch-Carlson) through points sorted by x: smooth, and never overshooting */
function monotone(points: readonly P2[]): (x: number) => number {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1]![0] - pts[i]![0]);
    slope.push((pts[i + 1]![1] - pts[i]![1]) / Math.max(1e-9, dx[i]!));
  }
  const tangent: number[] = [slope[0]!];
  for (let i = 1; i < n - 1; i++) {
    const a = slope[i - 1]!;
    const b = slope[i]!;
    tangent.push(a * b <= 0 ? 0 : (3 * (dx[i - 1]! + dx[i]!)) / ((2 * dx[i]! + dx[i - 1]!) / a + (dx[i]! + 2 * dx[i - 1]!) / b));
  }
  tangent.push(slope[n - 2]!);
  return (x: number): number => {
    if (x <= pts[0]![0]) return pts[0]![1];
    if (x >= pts[n - 1]![0]) return pts[n - 1]![1];
    let i = 0;
    while (i < n - 2 && x > pts[i + 1]![0]) i++;
    const h = dx[i]!;
    const t = (x - pts[i]![0]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * pts[i]![1] + (t3 - 2 * t2 + t) * h * tangent[i]!
      + (-2 * t3 + 3 * t2) * pts[i + 1]![1] + (t3 - t2) * h * tangent[i + 1]!;
  };
}

// ---------------------------------------------------------------- the body surface

/** What a face of the body is. */
type Region =
  | 'paint' | 'roof' | 'glass' | 'frame' | 'pillar' | 'seam' | 'under' | 'liner' | 'valance' | 'cover';

interface Face {
  /** The quad's four corners, as vertex indices of the grid (or the caps'). */
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number | null;
  region: Region;
  /** Door this face belongs to (index into the doors), or -1 for the body. */
  door: number;
}

/** The surface description a body is built from, kept for the anchors and the tests. */
interface CarShape {
  readonly style: CarStyle;
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

/** Axle positions, metres (the wheels are placed there). */
export function axlesOf(a: CarArchetype): number[] {
  return [a.length * 0.31, -a.length * 0.31];
}

function carShape(a: CarArchetype, styleName: CarStyle): CarShape {
  const s = STYLES[styleName];
  const L = a.length;
  const W = a.width;
  const H = a.height;
  const front = L / 2;
  const back = -L / 2;
  const clearance = M(s.clearance);
  const top = monotone(s.top.map(([x, y]) => [x * L, y * H] as P2));
  const noseLift = M(s.noseLift);
  const tailLift = M(s.tailLift);
  const bottom = (x: number): number => {
    // The bumpers tuck up over their last 0.35 m.
    const f = clamp01((x - (front - M(0.35))) / M(0.35));
    const r = clamp01(((back + M(0.3)) - x) / M(0.3));
    return clearance + noseLift * f * f + tailLift * r * r;
  };
  const beltFront = s.belt[0] * H;
  const beltRear = s.belt[1] * H;
  const beltLine = (x: number): number => lerp(beltFront, beltRear, clamp01((s.screen[0] * L - x) / (s.screen[0] * L - back)));
  const noseR = M(s.noseRadius);
  const tailR = M(s.tailRadius);
  const halfWidth = (x: number): number => {
    let h = W / 2;
    const f = x - (front - noseR);
    if (f > 0) h = W / 2 - noseR + Math.sqrt(Math.max(0, noseR * noseR - f * f));
    const r = (back + tailR) - x;
    if (r > 0) h = W / 2 - tailR + Math.sqrt(Math.max(0, tailR * tailR - r * r));
    return h;
  };
  const tumble = M(s.tumble);
  const roofH = H;
  const lean = tumble / Math.max(1e-6, roofH - beltFront);
  const sideAt = (x: number, y: number): number => {
    const b = beltLine(x);
    return halfWidth(x) - Math.max(0, y - b) * lean;
  };
  return {
    style: styleName, top, bottom, belt: beltLine, halfWidth, sideAt, floor: M(s.floor), front, back,
    doorEdges: s.doors.map((f) => f * L), screenBase: s.screen[0] * L, screenTop: s.screen[1] * L,
  };
}

/**
 * A car of class `a` in style `styleName` (4.0 carBody.ts:382-949, `buildCarModel`). `stations`: the uniform
 * stations along the body (4.0: 64), `arch` the stations over each wheel arch (18) and `ends` those rounding the nose
 * and the tail (8): fewer for a lighter body.
 */
export function buildCarBody(a: CarArchetype, styleName: CarStyle, stations0 = 64, arch = 18, ends = 8): CarBody {
  const st = STYLES[styleName];
  const shape = carShape(a, styleName);
  const { top, bottom, belt, halfWidth, front, back } = shape;
  const L = a.length;
  const W = a.width;
  const r = a.wheelRadius;
  const axles = axlesOf(a);
  const archR = r + M(0.07);
  const archY = r * 0.96;
  const tread = W * 0.14;
  const archIn = W / 2 - tread - M(0.05);
  const archTop = (x: number): number => {
    let y = -Infinity;
    for (const ax of axles) {
      const dx = x - ax;
      if (Math.abs(dx) < archR) y = Math.max(y, archY + Math.sqrt(archR * archR - dx * dx));
    }
    return y;
  };
  const inArchX = (x: number): boolean => axles.some((ax) => Math.abs(x - ax) < archR);
  const doorEdges = shape.doorEdges;
  const perSide = doorEdges.length - 1;
  const screenBase = shape.screenBase;
  const screenTop = shape.screenTop;
  const rear = st.rear ? { top: st.rear[0] * L, base: st.rear[1] * L } : null;
  const bedFrom = st.bedFrom !== undefined ? st.bedFrom * L : -Infinity;
  const frame = M(0.035);
  const pillarB = M(0.05);
  const shut = M(0.004);
  const rs = M(0.075);
  const rb = M(0.06);
  const crownOf = (x: number): number => (x > screenBase || x < bedFrom ? M(0.02) : M(0.045));
  // The side glass runs from the A-pillar to the C-pillar (or the last door).
  const glassFront = screenBase - M(0.06);
  const lastDoor = doorEdges[doorEdges.length - 1]!;
  const glassBack = st.quarter && rear ? Math.max(rear.top + M(0.12), lastDoor - M(0.55)) : lastDoor + M(0.05);

  // ---- stations: uniform, plus every feature edge.
  const xs = new Set<number>();
  const N = stations0;
  for (let i = 0; i <= N; i++) xs.add(lerp(back, front, i / N));
  for (let i = 1; i <= ends; i++) { xs.add(front - (M(0.06) * i) / ends * 2); xs.add(back + (M(0.06) * i) / ends * 2); }
  for (const ax of axles) {
    for (let i = 0; i <= arch; i++) xs.add(ax - archR + (2 * archR * i) / arch);
    xs.add(ax - archR - M(0.002));
    xs.add(ax + archR + M(0.002));
  }
  for (const e of doorEdges) { xs.add(e - shut); xs.add(e + shut); xs.add(e - pillarB); xs.add(e + pillarB); }
  for (const x of [screenBase, screenBase - frame, screenTop, screenTop + frame, glassFront, glassFront - frame, glassBack, glassBack + frame]) xs.add(x);
  if (rear) for (const x of [rear.top, rear.top - frame, rear.base, rear.base + frame]) xs.add(x);
  if (Number.isFinite(bedFrom)) { xs.add(bedFrom); xs.add(bedFrom - M(0.04)); }
  const stations = [...xs].filter((x) => x >= back - 1e-9 && x <= front + 1e-9).sort((p, q) => p - q)
    .filter((x, i, list) => i === 0 || x - list[i - 1]! > M(0.004));

  // ---- one section per station: the right half, bottom centre to top centre.
  const ROW = { bottomCentre: 0, wellInner: 1, well: 2, bottomEdge: 3, corner1: 4, corner2: 5, sideLow: 6, sill: 7,
    lower1: 8, lower2: 9, belt: 10, beltFrame: 11, glass1: 12, glass2: 13, glass3: 14, topFrame: 15, glassTop: 16,
    roof1: 17, roof2: 18, roof3: 19, roofEdge: 20, crown1: 21, crown2: 22, crown3: 23 } as const;
  const HALF = 24;
  interface Pt { z: number; y: number; lifted: boolean }
  const sectionAt = (x: number): Pt[] => {
    const b = bottom(x);
    const t = top(x);
    const hw = halfWidth(x);
    const yS = Math.min(belt(x), t - rs - M(0.002));
    const yT = t - rs;
    const bulge = (y: number): number => {
      const c = (b + yS) / 2;
      const h = Math.max(1e-6, (yS - b) / 2);
      return hw * (1 - 0.02 * ((y - c) / h) ** 2);
    };
    const side = (y: number): number => (y <= yS ? bulge(y) : bulge(yS) - (y - yS) * ((W / 2 - shape.sideAt(0, belt(0) + 1)) || 0));
    // Glasshouse lean from the style (sideAt), measured at the car's middle.
    const leanRate = (halfWidth(0) - shape.sideAt(0, belt(0) + 1));
    const sideG = (y: number): number => (y <= yS ? bulge(y) : bulge(yS) - (y - yS) * leanRate);
    void side;
    const pts: Pt[] = [];
    const push = (z: number, y: number): void => { pts.push({ z: Math.max(0, z), y, lifted: false }); };
    const zb = hw - M(0.03);
    push(0, b);
    push(Math.min(archIn - M(0.01), zb - rb - M(0.02)), b);
    push(Math.min(archIn, zb - rb - M(0.01)), b);
    push(zb - rb, b);
    // Bottom corner, a quarter ellipse up to the side.
    const sLow = b + rb;
    for (const k of [1, 2]) {
      const a2 = (k / 3) * (Math.PI / 2);
      push(zb - rb + Math.sin(a2) * (bulge(sLow) - (zb - rb)), b + (1 - Math.cos(a2)) * rb);
    }
    push(bulge(sLow), sLow);
    const sill = Math.min(yS - M(0.02), Math.max(sLow + M(0.01), M(st.clearance + 0.17)));
    push(bulge(sill), sill);
    push(bulge(lerp(sill, yS, 0.4)), lerp(sill, yS, 0.4));
    push(bulge(lerp(sill, yS, 0.78)), lerp(sill, yS, 0.78));
    push(bulge(yS), yS);
    const g = Math.max(0, yT - yS);
    const gy = (f: number): number => yS + g * f;
    const fb = g > 0 ? Math.min(0.5, frame / g) : 0;
    for (const f of [fb, lerp(fb, 1 - fb, 0.2), lerp(fb, 1 - fb, 0.5), lerp(fb, 1 - fb, 0.8), 1 - fb, 1]) push(sideG(gy(f)), gy(f));
    // Roof edge: a quarter ellipse into the roof.
    const zT = sideG(yT);
    const rr = Math.min(rs, zT * 0.45);
    for (const k of [1, 2, 3]) {
      const a2 = (k / 4) * (Math.PI / 2);
      push(zT - rr + Math.cos(a2) * rr, yT + Math.sin(a2) * rs);
    }
    push(zT - rr, t);
    const crown = crownOf(x);
    for (const f of [0.66, 0.33, 0]) {
      const z = (zT - rr) * f;
      push(z, t + crown * (1 - f * f));
    }
    // The wheel arches: everything outboard of the well, below the arch, is lifted onto it.
    if (inArchX(x)) {
      const arch = archTop(x);
      for (let j = ROW.well; j <= ROW.lower2; j++) {
        const p = pts[j]!;
        if (p.z >= archIn - M(0.005) && p.y < arch) { p.y = arch; p.lifted = true; }
      }
    }
    // Round the nose and tail into their end faces over the last 6 cm.
    const edge = Math.min(front - x, x - back);
    const roll = M(0.06);
    if (edge < roll) {
      const u = 1 - edge / roll;
      const k = 1 - (1 - Math.sqrt(Math.max(0, 1 - u * u))) * 0.9;
      const cy = (b + t) / 2;
      for (const p of pts) {
        p.z = p.z - (1 - k) * M(0.05) * (p.z / Math.max(1e-6, hw));
        p.y = cy + (p.y - cy) * (1 - (1 - k) * 0.06);
      }
    }
    return pts;
  };

  const sections = stations.map(sectionAt);
  // Full ring per station: right half (z >= 0) then the left half mirrored, without repeating the centres.
  const RING = HALF * 2 - 2;
  const ringPoint = (i: number, j: number): { x: number; y: number; z: number; lifted: boolean } => {
    const sec = sections[i]!;
    if (j < HALF) { const p = sec[j]!; return { x: stations[i]!, y: p.y, z: p.z, lifted: p.lifted }; }
    const k = RING - j; // j = HALF .. RING-1 map to HALF-2 .. 1
    const p = sec[k]!;
    return { x: stations[i]!, y: p.y, z: -p.z, lifted: p.lifted };
  };
  const positions: number[] = [];
  for (let i = 0; i < stations.length; i++) {
    for (let j = 0; j < RING; j++) {
      const p = ringPoint(i, j);
      positions.push(p.x, p.y, p.z);
    }
  }
  const vid = (i: number, j: number): number => i * RING + (((j % RING) + RING) % RING);
  // The half-row of a ring index, and its side.
  const rowOf = (j: number): { row: number; side: DoorSide } => (j < HALF ? { row: j, side: 1 } : { row: RING - j, side: -1 });

  // ---- classify every quad.
  const faces: Face[] = [];
  const inDoor = (x: number): number => {
    for (let d = 0; d < perSide; d++) if (x < doorEdges[d]! - shut && x > doorEdges[d + 1]! + shut) return d;
    return -1;
  };
  const nearEdge = (x: number, w: number): boolean => doorEdges.some((e) => Math.abs(x - e) < w);
  const innerEdges = doorEdges.slice(1, -1);
  const nearB = (x: number): boolean => innerEdges.some((e) => Math.abs(x - e) < pillarB);
  const isScreen = (x: number): boolean => x < screenBase && x > screenTop;
  const isRear = (x: number): boolean => rear !== null && x < rear.top && x > rear.base;
  const onRoof = (x: number): boolean => x <= screenTop && (rear === null ? true : x >= rear.top) && x > bedFrom;
  for (let i = 0; i < stations.length - 1; i++) {
    const xm = (stations[i]! + stations[i + 1]!) / 2;
    for (let j = 0; j < RING; j++) {
      const a = vid(i, j);
      const b = vid(i + 1, j);
      const c = vid(i + 1, j + 1);
      const d = vid(i, j + 1);
      const lo = rowOf(j);
      const hi = rowOf(j + 1);
      // The quad spans rows [row, row + 1] on one side (the ring wraps at the centres).
      const row = Math.min(lo.row, hi.row);
      let region: Region;
      let door = -1;
      const pa = sections[i]![Math.min(row, HALF - 1)]!;
      const liftedQuad = pa.lifted || sections[i + 1]![Math.min(row, HALF - 1)]!.lifted;
      if (row < ROW.bottomEdge) region = inArchX(xm) && row >= ROW.wellInner ? 'liner' : 'under';
      else if (row < ROW.sideLow) region = inArchX(xm) && liftedQuad ? 'liner' : 'under';
      else if (row < ROW.belt) {
        region = inArchX(xm) && liftedQuad && row < ROW.sill ? 'liner' : 'paint';
        if (row < ROW.sill && (xm > front - M(0.3) || xm < back + M(0.25))) region = 'valance';
        if (row >= ROW.sill) {
          const dd = inDoor(xm);
          if (dd >= 0 && !(inArchX(xm) && liftedQuad)) door = dd;
          if (nearEdge(xm, shut * 1.01) && xm < doorEdges[0]! + shut && xm > lastDoor - shut) region = 'seam';
        }
      } else if (row < ROW.glassTop) {
        // Belt to the top of the side glass.
        const glassX = xm < glassFront && xm > glassBack;
        const framed = row === ROW.belt || row === ROW.topFrame || xm > glassFront - frame || xm < glassBack + frame;
        if (glassX && !nearB(xm)) region = framed ? 'frame' : 'glass';
        else if (glassX && nearB(xm)) region = 'pillar';
        else region = 'paint';
        if (xm < bedFrom) region = 'paint';
        const dd = inDoor(xm);
        if (dd >= 0 && !nearB(xm)) door = dd;
        if (xm > glassFront && xm < screenBase + M(0.02) && region === 'paint') region = 'pillar';
      } else if (row < ROW.roofEdge) {
        // The roof's rounded edge: pillars over the screens, paint over the roof.
        region = isScreen(xm) || isRear(xm) ? 'pillar' : xm < bedFrom ? 'paint' : onRoof(xm) ? 'roof' : 'paint';
        if (xm < bedFrom) region = 'paint';
      } else {
        // The top: windscreen, roof, rear window, bonnet, boot, bed.
        if (isScreen(xm)) region = xm > screenBase - frame || xm < screenTop + frame || row === ROW.roofEdge ? 'frame' : 'glass';
        else if (isRear(xm)) region = xm > rear!.top - frame || xm < rear!.base + frame || row === ROW.roofEdge ? 'frame' : 'glass';
        else if (xm < bedFrom - M(0.04)) region = 'cover';
        else if (onRoof(xm)) region = 'roof';
        else region = 'paint';
      }
      if (region === 'glass' && row === ROW.roofEdge) region = 'frame';
      faces.push({ a, b, c, d, region, door: row >= ROW.sill && row < ROW.glassTop ? door : -1 });
    }
  }

  // ---- end caps: the nose and tail faces, fans to their centres.
  const capVertices: number[] = [];
  const capFaces: { verts: number[]; normal: number }[] = [];
  const capBase = positions.length / 3;
  for (const [i, sign] of [[0, -1], [stations.length - 1, 1]] as const) {
    let cy = 0;
    for (let j = 0; j < RING; j++) { cy += positions[vid(i, j) * 3 + 1]!; }
    cy /= RING;
    const cx = stations[i]!;
    const centre = capBase + capVertices.length / 3;
    capVertices.push(cx + sign * M(0.004), cy, 0);
    for (let j = 0; j < RING; j++) capFaces.push({ verts: [centre, vid(i, j), vid(i, j + 1)], normal: sign });
  }
  const all = new Float32Array([...positions, ...capVertices]);

  // Smooth normals over the lofted surface (indexed), before splitting by region.
  const surface = new BufferGeometry();
  surface.setAttribute('position', new BufferAttribute(all, 3));
  const idx: number[] = [];
  for (const f of faces) idx.push(f.a, f.b, f.c, f.a, f.c, f.d!);
  surface.setIndex(idx);
  surface.computeVertexNormals();
  const normals = surface.getAttribute('normal');
  // Make sure the winding faces outwards: check a face on the roof.
  const probe = faces.find((f) => f.region === 'roof') ?? faces[0]!;
  const pa = new Vector3().fromArray(all, probe.a * 3);
  const pb = new Vector3().fromArray(all, probe.b * 3);
  const pc = new Vector3().fromArray(all, probe.c * 3);
  const flip = pb.clone().sub(pa).cross(pc.clone().sub(pa)).y < 0;

  const COLOURS: Record<Region, number> = {
    paint: WHITE, roof: WHITE, glass: WHITE, frame: BLACKOUT, pillar: BLACKOUT, seam: SEAM, under: LINER,
    liner: LINER, valance: DARK_TRIM, cover: COVER,
  };
  /** Builds a geometry from quads, with the surface's smooth normals and per-face colours. */
  const fromFaces = (list: readonly Face[], offset = 0, inward = false, colour?: number): BufferGeometry => {
    const pos: number[] = [];
    const nor: number[] = [];
    const col: number[] = [];
    const cc = new Color();
    const put = (v: number, hex: number): void => {
      const nx = normals.getX(v);
      const ny = normals.getY(v);
      const nz = normals.getZ(v);
      const s2 = (flip ? -1 : 1) * (inward ? -1 : 1);
      pos.push(all[v * 3]! - nx * offset * (flip ? -1 : 1), all[v * 3 + 1]! - ny * offset * (flip ? -1 : 1), all[v * 3 + 2]! - nz * offset * (flip ? -1 : 1));
      nor.push(nx * s2, ny * s2, nz * s2);
      cc.setHex(hex);
      col.push(cc.r, cc.g, cc.b);
    };
    for (const f of list) {
      const hex = colour ?? COLOURS[f.region];
      const tri = (p: number, q: number, s3: number): void => {
        const outward = !flip !== inward;
        if (outward) { put(p, hex); put(q, hex); put(s3, hex); } else { put(p, hex); put(s3, hex); put(q, hex); }
      };
      tri(f.a, f.b, f.c);
      if (f.d !== null) tri(f.a, f.c, f.d);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new Float32BufferAttribute(nor, 3));
    g.setAttribute('color', new Float32BufferAttribute(col, 3));
    return g;
  };
  // The caps: flat, their own normal along the car.
  const capGeometry = (): BufferGeometry => {
    const pos: number[] = [];
    for (const f of capFaces) {
      const [p, q, s3] = f.verts as [number, number, number];
      const order = (f.normal > 0) !== flip ? [p, q, s3] : [p, s3, q];
      for (const v of order) pos.push(all[v * 3]!, all[v * 3 + 1]!, all[v * 3 + 2]!);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    // Wound either way by the fan; make every normal point out along x.
    const n = g.getAttribute('normal');
    const p2 = g.getAttribute('position');
    const probeX = p2.getX(0);
    for (let k = 0; k < n.count; k += 3) {
      const out = p2.getX(k) > 0 ? 1 : -1;
      if (Math.sign(n.getX(k)) !== out && Math.abs(n.getX(k)) > 1e-3) {
        // Swap two vertices of the triangle.
        for (const attr of [p2]) {
          const x1 = attr.getX(k + 1); const y1 = attr.getY(k + 1); const z1 = attr.getZ(k + 1);
          attr.setXYZ(k + 1, attr.getX(k + 2), attr.getY(k + 2), attr.getZ(k + 2));
          attr.setXYZ(k + 2, x1, y1, z1);
        }
      }
    }
    void probeX;
    g.computeVertexNormals();
    return tint(g, DARK_TRIM);
  };

  const isGlass = (f: Face): boolean => f.region === 'glass';
  const isRoof = (f: Face): boolean => f.region === 'roof';
  const bodyPaint = faces.filter((f) => !isGlass(f) && !isRoof(f));
  const shellFaces = bodyPaint;
  const glassFaces = faces.filter(isGlass);

  // ---- trim: grille, plates, liners behind the arches.
  const trim: BufferGeometry[] = [];
  const noseY = top(front - M(0.02));
  const grilleY = (bottom(front) + noseY) / 2 + M(0.03);
  trim.push(tint(roundedSlab(M(0.03), halfWidth(front - M(0.02)) * 0.95, M(0.02), M(0.13), front - M(0.012), grilleY - M(0.065), 0), GRILLE));
  for (const ax of axles) {
    // Wheel-house liners: a dark half drum over each tyre, inside the arch.
    const band: P2[] = [];
    for (let i = 0; i <= 12; i++) {
      const x = ax - archR * 0.98 + (2 * archR * 0.98 * i) / 12;
      band.push([x, archY + Math.sqrt(Math.max(0, (archR * 0.98) ** 2 - (x - ax) ** 2))]);
    }
    for (let i = 12; i >= 0; i--) band.push([band[i]![0], band[i]![1] + M(0.03)]);
    for (const side of [-1, 1] as const) trim.push(tint(extrude(band, tread + M(0.06), 0, side * (W / 2 - tread / 2 - M(0.02))), LINER));
  }

  // ---- lamps and plates, on the surface.
  const lampY = lerp(bottom(front), noseY, 0.72);
  const tailY = lerp(bottom(back), top(back + M(0.05)), 0.7);
  const headlamps: Lamp[] = [];
  const taillamps: Lamp[] = [];
  const indicators: (Lamp & { side: DoorSide; front: boolean })[] = [];
  const noseAt = (z: number): number => {
    // The x of the nose surface at a given half-width: search inwards.
    let x = front;
    while (x > front - M(0.6) && halfWidth(x) < Math.abs(z)) x -= M(0.005);
    return x;
  };
  const tailAt = (z: number): number => {
    let x = back;
    while (x < back + M(0.6) && halfWidth(x) < Math.abs(z)) x += M(0.005);
    return x;
  };
  for (const side of [-1, 1] as const) {
    const hz = W / 2 - M(0.26);
    headlamps.push({ x: noseAt(hz) - M(0.005), y: lampY, z: side * hz, sx: M(0.04), sy: M(0.08), sz: M(0.3) });
    const tz = W / 2 - M(0.18);
    taillamps.push({ x: tailAt(tz) + M(0.005), y: tailY, z: side * tz, sx: M(0.04), sy: styleName === 'van' ? M(0.28) : M(0.1), sz: M(0.26) });
    const iz = W / 2 - M(0.08);
    indicators.push({ x: noseAt(iz) - M(0.01), y: lampY - M(0.03), z: side * iz, sx: M(0.04), sy: M(0.045), sz: M(0.06), side, front: true });
    indicators.push({ x: tailAt(iz) + M(0.01), y: tailY + M(0.02), z: side * iz, sx: M(0.04), sy: M(0.05), sz: M(0.05), side, front: false });
  }
  const plates: Lamp[] = [
    { x: front + M(0.008), y: lerp(bottom(front), grilleY, 0.45), z: 0, sx: M(0.012), sy: M(0.11), sz: M(0.52) },
    { x: back - M(0.008), y: lerp(bottom(back), tailY, 0.55), z: 0, sx: M(0.012), sy: M(0.11), sz: M(0.52) },
  ];

  // ---- far LOD: the same surface, coarse, glass drawn dark and opaque.
  const farFaces: BufferGeometry[] = [];
  {
    const dark = faces.map((f) => ({ ...f, region: f.region === 'glass' ? 'frame' as Region : f.region }));
    farFaces.push(fromFaces(dark));
    farFaces.push(capGeometry());
  }

  // ---- handles and mirrors (4.0 carBody.ts:724-747, the door leaves left out: on the body)
  const sectionSideZ = (x: number, y: number): number => {
    const b0 = bottom(x);
    const yS = Math.min(belt(x), top(x) - rs);
    const hw = halfWidth(x);
    const c = (b0 + yS) / 2;
    const h = Math.max(1e-6, (yS - b0) / 2);
    return hw * (1 - 0.02 * ((y - c) / h) ** 2);
  };
  const skinAt = (x: number, y: number): number => shape.sideAt(x, y) > 0 ? sectionSideZ(x, y) : halfWidth(x);
  for (const side of [-1, 1] as const) {
    for (let d = 0; d < perSide; d++) {
      const x0 = doorEdges[d]! - shut;
      const x1 = doorEdges[d + 1]! + shut;
      const handleX = x1 + Math.min(M(0.2), (x0 - x1) * 0.25);
      const handleY = belt(handleX) - M(0.09);
      const hz = skinAt(handleX, handleY);
      trim.push(tint(box(M(0.17), M(0.028), M(0.03), handleX + M(0.06), handleY, side * (hz + M(0.008))), DARK_TRIM));
      if (d === 0) {
        const mx = x0 - M(0.12);
        const my = belt(mx) + M(0.06);
        const mz = skinAt(mx, belt(mx));
        trim.push(tint(bar(new Vector3(mx, my - M(0.03), side * (mz - M(0.02))), new Vector3(mx - M(0.04), my, side * (mz + M(0.1))), M(0.035)), DARK_TRIM));
        trim.push(roundedSlab(M(0.11), M(0.2), M(0.045), M(0.11), mx - M(0.06), my - M(0.02), side * (mz + M(0.17))));
        trim.push(tint(box(M(0.008), M(0.085), M(0.17), mx - M(0.117), my + M(0.035), side * (mz + M(0.17))), MIRROR_GLASS));
      }
    }
  }

  const shell = merge([fromFaces(shellFaces), fromFaces(faces.filter(isRoof)), capGeometry()]);
  const glass = fromFaces(glassFaces);
  // the lamps and plates on the surface: each one's face follows the body where it is (built once per style)
  const skin = surfaceOf([shell, glass]);
  // (a lamp reaching past the body's outline at the corner moves in, 2 cm at a time, until it lies on the body)
  const shaped = <T extends Lamp>(list: T[], ahead: (l: T) => boolean): T[] => list.map((l) => {
    let at: T = l, face = lampFace(skin, at, ahead(l));
    for (let k = 1; k <= 8 && face.getAttribute('position').count < 48; k++) {
      at = { ...l, z: l.z - Math.sign(l.z) * M(0.02) * k };
      face = lampFace(skin, at, ahead(l));
    }
    return { ...at, face };
  });
  return {
    // the roof panel (4.0 keeps it apart for a glass roof, carBody.ts:922): painted with the shell here
    shell,
    glass,
    trim: merge(trim),
    far: merge(farFaces),
    headlamps: shaped(headlamps, () => true), taillamps: shaped(taillamps, () => false),
    indicators: shaped(indicators, (l) => l.front), plates: shaped(plates, (l) => l.x > 0), axles,
  };
}

/** A body's triangles, flat (9 numbers each), for `lampFace`. */
function surfaceOf(parts: BufferGeometry[]): Float64Array {
  let n = 0;
  for (const g of parts) n += g.index ? g.index.count : g.getAttribute('position').count;
  const out = new Float64Array(n * 3);
  let o = 0;
  for (const g of parts) {
    const p = g.getAttribute('position').array, idx = g.index?.array, m = idx ? idx.length : p.length / 3;
    for (let i = 0; i < m; i++) { const k = idx ? idx[i]! : i; out[o++] = p[k * 3]!; out[o++] = p[k * 3 + 1]!; out[o++] = p[k * 3 + 2]!; }
  }
  return out;
}

/** Where a ray from far ahead (or behind) along x at (y, z) first meets the body: its x, or NaN. */
function surfaceX(T: Float64Array, y: number, z: number, ahead: boolean): number {
  const dx = ahead ? -1 : 1, ox = ahead ? 50 : -50;
  let best = Infinity;
  for (let k = 0; k < T.length; k += 9) {
    // the ray runs along x: the triangle's projection on (y, z) must hold the point
    const ay = T[k + 1]!, az = T[k + 2]!, by = T[k + 4]!, bz = T[k + 5]!, cy = T[k + 7]!, cz = T[k + 8]!;
    const d = (by - cy) * (az - cz) + (cz - bz) * (ay - cy);
    if (Math.abs(d) < 1e-12) continue;
    const l1 = ((by - cy) * (z - cz) + (cz - bz) * (y - cy)) / d, l2 = ((cy - ay) * (z - cz) + (az - cz) * (y - cy)) / d, l3 = 1 - l1 - l2;
    if (l1 < 0 || l2 < 0 || l3 < 0) continue;
    const x = l1 * T[k]! + l2 * T[k + 3]! + l3 * T[k + 6]!, t = (x - ox) * dx;
    if (t > 0 && t < best) best = t;
  }
  return best === Infinity ? NaN : ox + dx * best;
}

/**
 * A lamp's (or plate's) face on the body: a grid over its extent across (z) and up (y), each point 6 mm out from the
 * surface met along the length; cells with a corner off the body are left out. Faces ahead (+x) or behind.
 */
function lampFace(T: Float64Array, l: Lamp, ahead: boolean): BufferGeometry {
  const NZ = 4, NY = 2, out = ahead ? M(0.006) : -M(0.006);
  const xs: number[] = [];
  for (let j = 0; j <= NY; j++) for (let i = 0; i <= NZ; i++) xs.push(surfaceX(T, l.y + (j / NY - 0.5) * l.sy, l.z + (i / NZ - 0.5) * l.sz, ahead));
  const pos: number[] = [];
  const at = (i: number, j: number): [number, number, number] => [xs[j * (NZ + 1) + i]! + out, l.y + (j / NY - 0.5) * l.sy, l.z + (i / NZ - 0.5) * l.sz];
  for (let j = 0; j < NY; j++) for (let i = 0; i < NZ; i++) {
    const q = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
    if (q.some((p) => Number.isNaN(p[0]))) continue;
    // counter-clockwise seen from outside: ahead the face looks along +x (z right, y up)
    const order = ahead ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
    for (const k of order) pos.push(...q[k]!);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- the cabin

const CARPET = 0x26282c, DASH = 0x1e2023, SEAT_FABRIC = 0x4a4f57, SEAT_SIDE = 0x34373d, CARD = 0x3b3e44;
const HEADREST = 0x42464d, WHEEL_RIM = 0x141517, BULKHEAD = 0x8b9198;
/** 4.0's seating package (carBody.ts CAR_PACKAGE): seat recline (rad), the cushion's drop under the hip and reach. */
const RECLINE = 0.42, CUSHION_DROP = 0.1, CUSHION_REACH = 0.42, UPRIGHT_CUSHION_REACH = 0.3;
/** Where the steering wheel's hub is from the driver's hip, its lean back from vertical and its radius (4.0 riderPoses.ts). */
const DRIVER_WHEEL = { forward: 0.46, up: 0.36, tilt: 0.45, radius: 0.185 };
const CAB_WHEEL = { forward: 0.42, up: 0.13, tilt: 1.0, radius: 0.22 };

/**
 * What the glass shows into (roadcraft 4.0 carBody.ts, "the cabin, from the package"): carpet, dashboard and console,
 * steering wheel, the seats with their headrests at the hip points the occupants sit at (`carSeatPoints`), the door
 * trims up to the waist and what is behind the last seats (parcel shelf, load floor, a pick-up's cab wall, a van's
 * bulkhead). Without it the body is a hollow shell: through the windscreen the road under the car shows from above.
 * Built for the near model only (the farther ones have opaque dark glass), flat: no bevels, boxes and plain
 * extrusions, the steering wheel a coarse ring — about 500 triangles a car. 4.0 frame (x forward, y up, z right).
 */
export function buildCarCabin(a: CarArchetype, styleName: Exclude<CarStyle, 'wagon'>): BufferGeometry {
  const st = STYLES[styleName], shape = carShape(a, styleName);
  const { top, belt, halfWidth, back, floor, screenBase, doorEdges } = shape;
  const W = a.width, L = a.length, inner = W - M(0.2);
  const rows = doorEdges.length - 1;
  const hipY = floor + (st.cab ? CAB_HIP_OVER_FLOOR : CAR_HIP_OVER_FLOOR), seatZ = W / 2 - M(0.46);
  const seatX = (row: number): number => st.hip * L - row * M(st.couple);
  const archR = a.wheelRadius + M(0.07);
  const parts: BufferGeometry[] = [];
  // the footwell runs forward under the dash to the front wheel houses
  const bulk = Math.min(axlesOf(a)[0]! - archR - M(0.02), screenBase + M(0.1));
  const lastX = seatX(rows - 1);
  // the body's own width over a stretch, less a gap: the floor and the dash reach the sides (no slit to the road)
  const widthOver = (xa: number, xb: number): number => {
    let hw = Infinity;
    for (let i = 0; i <= 8; i++) hw = Math.min(hw, halfWidth(lerp(xa, xb, i / 8)));
    return 2 * hw - M(0.06);
  };
  parts.push(tint(box(bulk - (lastX - M(0.6)), M(0.03), widthOver(lastX - M(0.6), bulk), (bulk + lastX - M(0.6)) / 2, floor - M(0.015), 0), CARPET));
  // dashboard and console, from the driver's place (the left side: z < 0)
  const wheelSpec = st.cab ? CAB_WHEEL : DRIVER_WHEEL;
  const dx = seatX(0), dz = -seatZ;
  const dashTop = belt(screenBase - M(0.1)) - M(0.01);
  const dashRear = dx + M(wheelSpec.forward) + M(0.12);
  parts.push(tint(extrude([
    [screenBase + M(0.02), dashTop - M(0.03)], [bulk + M(0.05), floor + M(0.14)], [bulk - M(0.06), floor + M(0.14)],
    [dashRear + M(0.12), dashTop - M(0.3)], [dashRear, dashTop - M(0.18)], [dashRear - M(0.02), dashTop - M(0.05)],
    [dashRear + M(0.06), dashTop + M(0.01)],
  ], widthOver(dashRear, screenBase + M(0.02)), 0), DASH));
  const consoleBack = dx - M(0.12);
  if (!st.cab) parts.push(tint(box(dashRear - consoleBack, M(0.2), M(0.2), (dashRear + consoleBack) / 2, floor + M(0.1), 0), DASH));
  // steering wheel: a ring and its boss, its axis towards the driver leaning back by the package's tilt
  {
    const rim = new TorusGeometry(M(wheelSpec.radius), M(0.02), 4, 14);
    rim.rotateY(Math.PI / 2);
    const boss = new CylinderGeometry(M(0.065), M(0.075), M(0.05), 8).rotateZ(Math.PI / 2);
    const g = merge([rim, boss]).rotateZ(wheelSpec.tilt).translate(dx + M(wheelSpec.forward), hipY + M(wheelSpec.up), dz);
    parts.push(tint(g, WHEEL_RIM));
  }
  // seats: buckets in front, a bench behind
  const headrest = (x: number, y: number, z: number, width: number): void => { parts.push(tint(box(M(0.1), M(0.18), width, x, y + M(0.09), z), HEADREST)); };
  const headrestAt = (x: number, y: number, recline: number): [number, number] => {
    const up = M(0.62);
    return [x - M(0.2) - up * Math.sin(recline), y - M(0.1) + up * Math.cos(recline) + M(0.02)];
  };
  for (const side of [-1, 1] as const) {
    seat(parts, seatX(0), hipY, floor, M(0.5), side * seatZ, RECLINE, M(0.6), st.cab ? UPRIGHT_CUSHION_REACH : CUSHION_REACH);
    const [hx, hy] = headrestAt(seatX(0), hipY, RECLINE);
    headrest(hx, hy, side * seatZ, M(0.26));
  }
  if (rows > 1) {
    const x = seatX(rows - 1), recline = RECLINE + 0.05;
    seat(parts, x, hipY, floor, Math.min(inner - M(0.06), 2 * seatZ + M(0.64)), 0, recline, M(0.58), CUSHION_REACH);
    const [hx, hy] = headrestAt(x, hipY, recline);
    for (const side of [-1, 1] as const) headrest(hx - M(0.01), hy - M(0.03), side * seatZ, M(0.24));
    // behind the bench: a parcel shelf (sedan), the cab's back wall (pick-up) or a load floor under a shelf
    const benchBack = x - M(0.14) - M(0.58) * Math.sin(recline) - M(0.1);
    const rear = st.rear ? st.rear[1] * L : back + M(0.3);
    if (styleName === 'sedan') {
      parts.push(tint(box(Math.max(M(0.1), benchBack - rear), M(0.03), inner, (benchBack + rear) / 2, belt(rear) - M(0.02), 0), CARPET));
    } else if (styleName === 'pickup' && st.bedFrom !== undefined) {
      const bx = st.bedFrom * L + M(0.06), h = top(bx + M(0.04)) - floor - M(0.05);
      parts.push(tint(box(M(0.04), h, inner, bx, floor + h / 2, 0), CARD));
    } else {
      const bootFloor = floor + M(0.3), bootEnd = back + M(0.04), from = x - M(0.2);
      parts.push(tint(box(from - bootEnd, M(0.03), inner, (from + bootEnd) / 2, bootFloor, 0), CARPET));
      parts.push(tint(box(Math.max(M(0.1), benchBack - bootEnd), M(0.015), inner - M(0.04), (benchBack + bootEnd) / 2, belt(bootEnd) - M(0.02), 0), 0x2c2e33));
    }
  } else {
    // a van: the bulkhead behind the cab
    const bx = seatX(0) - M(0.55);
    parts.push(tint(box(M(0.04), top(bx) - floor - M(0.08), inner, bx, (top(bx) + floor) / 2 - M(0.02), 0), BULKHEAD));
  }
  // the trim inside the doors, up to the waist, from the footwell to behind the last seat: it hides the inside of the
  // far side's panels (the shell is one-sided) seen through the near window
  // (in four lengths, each as wide as the body there, and thick enough that its top closes the door's inside), clear
  // of the wheel arches: through the arch's opening it stood over the rear wheel as a grey slab
  const x0 = Math.max(back + M(0.25), lastX - M(0.75), axlesOf(a)[1]! + archR + M(0.03)), x1 = bulk;
  for (let k = 0; k < 4; k++) {
    const xa = lerp(x0, x1, k / 4), xb = lerp(x0, x1, (k + 1) / 4);
    let hw = Infinity, waist = Infinity;
    for (let i = 0; i <= 4; i++) { const x = lerp(xa, xb, i / 4); hw = Math.min(hw, halfWidth(x)); waist = Math.min(waist, belt(x)); }
    for (const side of [-1, 1] as const) parts.push(tint(box(xb - xa, waist - floor, M(0.1), (xa + xb) / 2, (waist + floor) / 2, side * (hw - M(0.08))), CARD));
  }
  // the wheel houses come into the cabin, as in a car: by each axle (and a margin, so the narrowing lies clear of the
  // arch) and up to the arch's top, nothing is wider than the wheel house's inner face (the floor, the rear bench and
  // the boot floor reached through the arch's opening over the tyre)
  const well = W / 2 - W * 0.14 - M(0.06), wellTop = archR + a.wheelRadius * 0.96 + M(0.02);
  // the wheel house's top inside, over each arch and its margin, from its inner face to the side (above the arch's
  // opening: not seen from outside)
  for (const ax of axlesOf(a)) {
    const reach = archR + M(0.15), side = Math.min(halfWidth(ax - reach), halfWidth(ax + reach)) - M(0.03);
    if (side > well) for (const sd of [-1, 1] as const) parts.push(tint(box(2 * reach, M(0.03), side - well, ax, wellTop + M(0.015), sd * (well + side) / 2), CARD));
  }
  const g = merge(parts), pos = g.getAttribute('position') as BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (y < wellTop && Math.abs(z) > well && axlesOf(a).some((ax) => Math.abs(x - ax) < archR + M(0.15))) pos.setZ(i, Math.sign(z) * well);
  }
  g.computeVertexNormals();
  return g;
}

/** A seat (4.0 seatShell): the side profile of cushion and back extruded across, its bolsters and its base. */
function seat(out: BufferGeometry[], hipX: number, hipY: number, floor: number, width: number, z: number, recline: number, backHeight: number, reach: number): void {
  const top = hipY - M(CUSHION_DROP), base = Math.max(floor + M(0.1), top - M(0.13)), backX = hipX - M(0.14);
  const sin = Math.sin(recline), cos = Math.cos(recline), thick = M(0.13);
  out.push(tint(extrude([
    [hipX + M(reach) - M(0.04), top - M(0.03)], [hipX + M(reach), top - M(0.08)], [hipX + M(reach) - M(0.04), base],
    [backX - thick * cos, base], [backX - thick * cos - backHeight * sin, top + backHeight * cos - M(0.02)],
    [backX - backHeight * sin + M(0.01), top + backHeight * cos], [backX, top + M(0.05)], [backX + M(0.06), top],
  ], width, 0, z), SEAT_FABRIC));
  for (const side of [-1, 1] as const) {
    const zz = z + side * (width / 2 - M(0.04));
    out.push(tint(bar(new Vector3(backX - M(0.02), top + M(0.08), zz), new Vector3(backX - M(0.02) - backHeight * 0.8 * sin, top + backHeight * 0.8 * cos, zz), M(0.09), M(0.07)), SEAT_SIDE));
  }
  out.push(tint(box(M(0.3), Math.max(M(0.02), base - floor), width * 0.6, hipX + M(0.08), (base + floor) / 2, z), DASH));
}

/**
 * The same car as a light silhouette for the middle distance (in place of 4.0's far body, a few hundred triangles):
 * the style's own top line, bottom, plan and belt (`carShape`) lofted over a few stations, a ring of a few points a
 * side, the glasshouse dark between the belt and the roof edge, the rest painted (white).
 */
export function buildCarSilhouette(a: CarArchetype, styleName: CarStyle, stations = 12): BufferGeometry {
  const st = STYLES[styleName];
  const shape = carShape(a, styleName);
  const { top, bottom, belt, halfWidth, front, back } = shape;
  const L = a.length;
  const rear = st.rear ? { top: st.rear[0] * L, base: st.rear[1] * L } : null;
  const xs: number[] = [];
  for (let i = 0; i <= stations; i++) xs.push(lerp(back, front, i / stations));
  for (const x of [shape.screenBase, shape.screenTop, ...(rear ? [rear.top, rear.base] : [])]) xs.push(x);
  xs.sort((p, q) => p - q);
  const lean = halfWidth(0) - shape.sideAt(0, belt(0) + 1);
  // half ring, bottom centre to roof centre: (z, y)
  const ring = (x: number): Array<[number, number]> => {
    const b = bottom(x), t = top(x), hw = halfWidth(x), yB = Math.min(belt(x), t - 0.08);
    const zT = Math.max(0.05, hw - (t - 0.06 - yB) * lean);
    return [[0, b], [hw - 0.06, b], [hw, b + 0.08], [hw, yB], [zT, t - 0.06], [zT * 0.5, t], [0, t + 0.02]];
  };
  const H = 7, glassRow = 3; // the quad between rows 3 and 4 is the side glass
  const glassX = (x: number): boolean => x < shape.screenBase - 0.05 && x > (rear ? rear.top : back + 0.3);
  const isScreen = (x: number): boolean => x < shape.screenBase && x > shape.screenTop;
  const isRear = (x: number): boolean => rear !== null && x < rear.top && x > rear.base;
  const pos: number[] = [], col: number[] = [];
  const dark = new Color().setHex(0x10161d), white = new Color().setHex(WHITE), under = new Color().setHex(LINER);
  const put = (x: number, p: [number, number], side: number, c: Color): void => { pos.push(x, p[1], side * p[0]); col.push(c.r, c.g, c.b); };
  for (let i = 0; i + 1 < xs.length; i++) {
    const x0 = xs[i]!, x1 = xs[i + 1]!, xm = (x0 + x1) / 2;
    if (x1 - x0 < 1e-3) continue;
    const r0 = ring(x0), r1 = ring(x1);
    for (const side of [-1, 1]) for (let j = 0; j + 1 < H; j++) {
      const c = j === 0 ? under : j === glassRow && glassX(xm) ? dark : j >= 4 && (isScreen(xm) || isRear(xm)) ? dark : white;
      const q = [[x0, r0[j]!], [x1, r1[j]!], [x1, r1[j + 1]!], [x0, r0[j + 1]!]] as const;
      // counter-clockwise seen from outside (three's front face): the ring runs up from the bottom centre, so on the
      // right (+z) side the quad goes along x then up. The opposite order built the whole silhouette inside out: the
      // far side's inner face and all four wheels were drawn, the near side culled (a car seen lying on its side)
      const tri = side > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
      for (const k of tri) put(q[k]![0], q[k]![1] as [number, number], side, c);
    }
  }
  // nose and tail caps
  for (const [x, sgn] of [[xs[0]!, -1], [xs[xs.length - 1]!, 1]] as const) {
    const r = ring(x), cy = (r[0]![1] + r[H - 1]![1]) / 2;
    for (const side of [-1, 1]) for (let j = 0; j + 1 < H; j++) {
      const c = j >= glassRow + 1 && sgn > 0 ? dark : white;
      const tri: Array<[number, [number, number]]> = [[x, [0, cy]], [x, r[j]!], [x, r[j + 1]!]];
      const order = (sgn * side > 0) ? [0, 2, 1] : [0, 1, 2];
      for (const k of order) put(tri[k]![0], tri[k]![1], side, c);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

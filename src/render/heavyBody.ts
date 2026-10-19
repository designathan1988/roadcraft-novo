// Buses and lorries as roadcraft 4.0 builds them: render/vehicleModels.ts (roadcraft-4.0-main/src) buildBusModel
// (:739-1022) and buildTruckModel (:1058-1233), their outside: the bus's walls with the arches cut and the doors, the
// window band with its pillars and panes, the windscreen, the roof and its air-conditioning pod, the folding doors shut;
// the lorry's cab with its doors, windscreen, grille, steps, mirrors and mudguards, the chassis, tank and side guards,
// the box body. Built once, drawn by instances (render/vehicles.ts). The cabins inside (seats, poles, dashboards) are left
// out while the glass is opaque. x forward, y up, z right; metres.

import { BoxGeometry, BufferAttribute, BufferGeometry, Color, CylinderGeometry, ExtrudeGeometry, Float32BufferAttribute, Quaternion, Shape, ShapeUtils, Vector2, Vector3 } from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Lamp } from './carBody.ts';

type DoorSide = -1 | 1;
const M = (metres: number): number => metres;

/** What a heavy vehicle class is drawn from (4.0 sim/vehicles/archetypes.ts), metres. */
export interface HeavyArchetype { readonly length: number; readonly width: number; readonly height: number; readonly wheelRadius: number; readonly cabinFraction: number }

/** A bus or a lorry: its painted shell, its glass, its unpainted trim, a second fixed colour (the lorry's box), lamps. */
export interface HeavyBody {
  readonly shell: BufferGeometry;
  readonly glass: BufferGeometry;
  readonly trim: BufferGeometry;
  readonly accent: BufferGeometry | null;
  readonly headlamps: readonly Lamp[];
  readonly taillamps: readonly Lamp[];
  readonly indicators: readonly (Lamp & { readonly side: DoorSide; readonly front: boolean })[];
  readonly plates: readonly Lamp[];
  readonly axles: readonly number[];
}

/** Axle positions along the body, front first (4.0 vehicleModels.ts:165-174). */
export function heavyAxles(a: HeavyArchetype, bus: boolean): number[] {
  const L = a.length;
  if (bus) return [L * 0.28, -L * 0.17, -L * 0.28];
  return [L * 0.37, -L * 0.21, -L * 0.34];
}

const WHITE = 0xffffff;
/** Black-out on paint: B-pillars, window surrounds, a bus's pillars. */
const BLACKOUT = 0x1a1b1e;
/** Shut lines and seams on paint. */
const SEAM = 0x3a3a3a;
const DARK_TRIM = 0x202226;
const CHROME_TRIM = 0xb9bec4;
const GRILLE = 0x0e0f11;
/** Cabin colours, sRGB. */

// ------------------------------------------------------------------ geometry helpers

type P2 = readonly [number, number];

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Sets a constant vertex colour on a geometry, in place, and returns it. */
function tint<T extends BufferGeometry>(g: T, hex: number): T {
  const c = new Color().setHex(hex);
  const n = g.getAttribute('position').count;
  const data = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    data[i * 3] = c.r;
    data[i * 3 + 1] = c.g;
    data[i * 3 + 2] = c.b;
  }
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
  const merged = mergeGeometries(ready, false);
  if (!merged) throw new Error('vehicle model: parts could not be merged');
  return merged;
}
/** Points of a polyline monotone in x, clipped to [xa, xb]. */
function clipX(line: readonly P2[], xa: number, xb: number): P2[] {
  const out: P2[] = [];
  const push = (p: P2): void => {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > 1e-7 || Math.abs(last[1] - p[1]) > 1e-7) out.push(p);
  };
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const dx = b[0] - a[0];
    if (Math.abs(dx) < 1e-9) {
      if (a[0] >= xa - 1e-9 && a[0] <= xb + 1e-9) { push(a); push(b); }
      continue;
    }
    const ta = (xa - a[0]) / dx;
    const tb = (xb - a[0]) / dx;
    const t0 = Math.max(0, Math.min(ta, tb));
    const t1 = Math.min(1, Math.max(ta, tb));
    if (t0 > t1) continue;
    push([lerp(a[0], b[0], t0), lerp(a[1], b[1], t0)]);
    push([lerp(a[0], b[0], t1), lerp(a[1], b[1], t1)]);
  }
  return out;
}

/** Drops consecutive duplicates and a closing point equal to the first. */
function clean(points: readonly P2[]): P2[] {
  const out: P2[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) > 1e-6) out.push(p);
  }
  while (out.length > 2 && Math.hypot(out[0]![0] - out[out.length - 1]![0], out[0]![1] - out[out.length - 1]![1]) < 1e-6) out.pop();
  return out;
}

/** Extrudes a side profile across the body, centred on Z (or on `z`). */
function extrude(points: readonly P2[], width: number, bevel: number, z = 0, curveSegments = 6, bevelSegments = 3): ExtrudeGeometry {
  const shape = new Shape(clean(points).map(([x, y]) => new Vector2(x, y)));
  const depth = Math.max(1e-3, width - bevel * 2);
  const g = new ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel * 0.8,
    // Rounded INTO the outline rather than grown out of it
    bevelOffset: -bevel * 0.8,
    bevelSegments: bevel > 0 ? bevelSegments : 0,
    curveSegments,
  });
  g.translate(0, 0, -depth / 2 + z);
  return g;
}

/** Gap left at each end of a truck cab's door leaf, so it clears its opening as it swings. */
const SHUT = M(0.004);

function box(sx: number, sy: number, sz: number, x: number, y: number, z: number): BufferGeometry {
  return new BoxGeometry(sx, sy, sz).translate(x, y, z);
}

/** A bar between two points in 3D, `thick` square in section. */
function bar(a: Vector3, b: Vector3, thick: number, thickB = thick): BufferGeometry {
  const length = a.distanceTo(b);
  const g = new BoxGeometry(thick, length, thickB);
  const dir = b.clone().sub(a).normalize();
  // Rotation taking the box's long axis (+Y) onto the bar.
  g.applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

/** A rectangle rounded in plan (X-Z), `height` tall, bottom at `y`. */
function roundedSlab(lx: number, lz: number, radius: number, height: number, x: number, y: number, z: number, segments = 3): BufferGeometry {
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
  const g = new ExtrudeGeometry(s, { depth: height, bevelEnabled: false, curveSegments: segments });
  // Shape in X-Y extruded along Z: turn it so the extrusion runs up.
  g.rotateX(-Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

/** A flat polygon mapped into 3D, triangulated in its own 2D coordinates, and wound so its face points along `outward`. */
function polygon(points2: readonly P2[], to3: (p: P2) => Vector3, outward: Vector3): BufferGeometry {
  const pts = clean(points2);
  if (pts.length < 3) return new BufferGeometry().setAttribute('position', new Float32BufferAttribute([], 3));
  const contour = pts.map(([x, y]) => new Vector2(x, y));
  const faces = ShapeUtils.triangulateShape(contour, []);
  const v = pts.map(to3);
  const out: number[] = [];
  const e1 = new Vector3();
  const e2 = new Vector3();
  for (const [a, b, c] of faces) {
    const pa = v[a!]!;
    const pb = v[b!]!;
    const pc = v[c!]!;
    e1.subVectors(pb, pa);
    e2.subVectors(pc, pa);
    const n = e1.clone().cross(e2);
    const order = n.dot(outward) >= 0 ? [pa, pb, pc] : [pa, pc, pb];
    for (const p of order) out.push(p.x, p.y, p.z);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(out, 3));
  g.computeVertexNormals();
  return g;
}

/** A polygon given twice, facing both ways, a sliver apart: a pane seen from inside and out. */
function twoSided(points2: readonly P2[], to3: (p: P2) => Vector3, outward: Vector3, gap: number): BufferGeometry {
  const off = outward.clone().normalize().multiplyScalar(gap / 2);
  const front = polygon(points2, (p) => to3(p).add(off), outward);
  const back = polygon(points2, (p) => to3(p).sub(off), outward.clone().negate());
  return merge([front, back]);
}

/** A surface lofted along a profile: at each station */
function loft(stations: readonly P2[], half: (y: number) => number, crown: number, across = 6,
  zRange: readonly [number, number] = [-1, 1]): BufferGeometry {
  const pos: number[] = [];
  const index: number[] = [];
  const cols = across + 1;
  for (const [x, y] of stations) {
    const h = half(y);
    for (let j = 0; j <= across; j++) {
      const u = lerp(zRange[0], zRange[1], j / across);
      pos.push(x, y + crown * (1 - u * u), u * h);
    }
  }
  for (let i = 0; i < stations.length - 1; i++) {
    const [x0, y0] = stations[i]!;
    const [x1, y1] = stations[i + 1]!;
    // Outward in the X-Y plane for a segment running from i to i + 1.
    const out = new Vector3(y1 - y0, -(x1 - x0), 0);
    if (out.y < 0 || (Math.abs(out.y) < 1e-9 && out.x < 0)) out.negate();
    for (let j = 0; j < across; j++) {
      const a = i * cols + j;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      const pa = new Vector3(pos[a * 3]!, pos[a * 3 + 1]!, pos[a * 3 + 2]!);
      const pb = new Vector3(pos[b * 3]!, pos[b * 3 + 1]!, pos[b * 3 + 2]!);
      const pc = new Vector3(pos[c * 3]!, pos[c * 3 + 1]!, pos[c * 3 + 2]!);
      const n = pb.clone().sub(pa).cross(pc.clone().sub(pa));
      if (n.dot(out) >= 0) index.push(a, b, c, b, d, c);
      else index.push(a, c, b, b, c, d);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** A mudguard's outline over a wheel: a half ring. */
function archOutline(cx: number, cy: number, radius: number): P2[] {
  const out: P2[] = [];
  const inner = radius;
  const outer = radius + M(0.06);
  for (let i = 0; i <= 10; i++) {
    const a = Math.PI - (Math.PI * i) / 10;
    out.push([cx + Math.cos(a) * outer, cy + Math.sin(a) * outer]);
  }
  for (let i = 10; i >= 0; i--) {
    const a = Math.PI - (Math.PI * i) / 10;
    out.push([cx + Math.cos(a) * inner, cy + Math.sin(a) * inner]);
  }
  return out;
}

export function buildBusBody(a: HeavyArchetype): HeavyBody {
  const L = a.length;
  const W = a.width;
  const H = a.height;
  const r = a.wheelRadius;
  const halfW = W / 2;
  const front = L / 2;
  const back = -L / 2;
  const axles = heavyAxles(a, true);
  const archR = r + M(0.07);
  const clear = M(0.28);
  const floor = M(0.38);
  const sillY = M(1.02);
  const cant = H - M(0.42);
  const wall = M(0.06);
  const shell: BufferGeometry[] = [];
  const trim: BufferGeometry[] = [];
  const glass: BufferGeometry[] = [];

  // Door openings on the kerb side: [rear edge, front edge].
  const doorSpans: [number, number][] = [[front - M(1.5), front - M(0.3)], [-M(0.9), M(0.3)]];

  // ---- lower body: side walls with the arches cut, front and rear panels.
  const archTop = (x: number): number => {
    let y = -Infinity;
    for (const ax of axles) {
      const dx = x - ax;
      if (Math.abs(dx) < archR) y = Math.max(y, r + Math.sqrt(archR * archR - dx * dx));
    }
    return y;
  };
  const xs = new Set<number>([back, front]);
  for (const ax of axles) for (let i = 0; i <= 16; i++) xs.add(ax - archR + (2 * archR * i) / 16);
  for (const [x0, x1] of doorSpans) { xs.add(x0); xs.add(x1); }
  const bottom: P2[] = [...xs].filter((x) => x >= back && x <= front).sort((u, v) => u - v)
    .map((x) => [x, Math.max(clear, archTop(x))] as const);
  const wallOutline = (xa: number, xb: number, topY: number): P2[] => [...clipX(bottom, xa, xb), [xb, topY], [xa, topY]];
  // Left: one wall. Right: the stretches between the doors.
  shell.push(extrude(wallOutline(back + M(0.08), front - M(0.08), sillY), wall, M(0.02), -(halfW - wall / 2), 4, 2));
  {
    let x = back + M(0.08);
    for (const [x0, x1] of [...doorSpans].sort((u, v) => u[0] - v[0])) {
      shell.push(extrude(wallOutline(x, x0, sillY), wall, M(0.02), halfW - wall / 2, 4, 2));
      x = x1;
    }
    shell.push(extrude(wallOutline(x, front - M(0.08), sillY), wall, M(0.02), halfW - wall / 2, 4, 2));
  }
  // A darker skirt band along the bottom.
  for (const side of [-1, 1] as const) {
    trim.push(tint(box(L - M(0.3), M(0.1), M(0.02), 0, clear + M(0.05), side * (halfW + M(0.005))), DARK_TRIM));
  }
  // Front: a panel from the bumper to the windscreen, rounded at the corners.
  const screenBase = M(0.95);
  shell.push(roundedSlab(M(0.14), W, M(0.1), screenBase - clear, front - M(0.07), clear, 0));
  shell.push(roundedSlab(M(0.14), W, M(0.1), sillY - clear + M(0.05), back + M(0.07), clear, 0));
  // Rear: engine bay under a panel up to the cant rail, with a small window.
  shell.push(box(M(0.06), cant - sillY, W - M(0.04), back + M(0.03), (cant + sillY) / 2, 0));
  glass.push(twoSided([[-halfW + M(0.3), sillY + M(0.9)], [halfW - M(0.3), sillY + M(0.9)], [halfW - M(0.3), cant - M(0.15)], [-halfW + M(0.3), cant - M(0.15)]],
    ([z, y]) => new Vector3(back - M(0.005), y, z), new Vector3(-1, 0, 0), M(0.006)));
  trim.push(tint(box(M(0.02), M(0.5), W * 0.7, back - M(0.005), clear + M(0.45), 0), GRILLE));

  // ---- the window band: pillars and glass from the sill to the cant rail.
  const bays = Math.max(5, Math.round((L - M(1.5)) / M(1.4)));
  const bandStart = back + M(0.15);
  const bandEnd = front - M(0.25);
  const pillar = M(0.09);
  for (const side of [-1, 1] as const) {
    const z = side * (halfW - wall / 2);
    const spans: [number, number][] = [];
    // Pillars at bay edges, skipping the door openings on the kerb side.
    const inDoor = (x: number): boolean => side === 1 && doorSpans.some(([x0, x1]) => x > x0 - M(0.05) && x < x1 + M(0.05));
    const posts: number[] = [];
    for (let i = 0; i <= bays; i++) posts.push(bandStart + ((bandEnd - bandStart) * i) / bays);
    if (side === 1) for (const [x0, x1] of doorSpans) posts.push(x0 - pillar / 2, x1 + pillar / 2);
    const sorted = posts.filter((x) => !inDoor(x) || doorSpans.some(([x0, x1]) => Math.abs(x - x0 + pillar / 2) < 1e-6 || Math.abs(x - x1 - pillar / 2) < 1e-6))
      .sort((u, v) => u - v);
    for (const x of sorted) shell.push(tint(box(pillar, cant - sillY, wall, x, (cant + sillY) / 2, z), BLACKOUT));
    for (let i = 0; i < sorted.length - 1; i++) {
      const x0 = sorted[i]! + pillar / 2;
      const x1 = sorted[i + 1]! - pillar / 2;
      if (x1 - x0 < M(0.2) || inDoor((x0 + x1) / 2)) continue;
      spans.push([x0, x1]);
    }
    for (const [x0, x1] of spans) {
      glass.push(twoSided([[x0, sillY], [x1, sillY], [x1, cant], [x0, cant]], ([x, y]) => new Vector3(x, y, side * (halfW - wall * 0.3)), new Vector3(0, 0, side), M(0.006)));
    }
    // A black band under the glass, the rubber of the glazing.
    shell.push(tint(box(bandEnd - bandStart, M(0.05), wall + M(0.004), (bandStart + bandEnd) / 2, sillY + M(0.01), z), BLACKOUT));
  }
  // The driver's side window, ahead of the first bay on the left.
  const screenTop = cant - M(0.3);
  glass.push(loft([[front - M(0.04), screenBase], [front - M(0.14), screenTop]], () => halfW - M(0.08), M(0.04), 6));
  shell.push(tint(box(M(0.1), M(0.08), W - M(0.02), front - M(0.06), screenBase - M(0.02), 0), BLACKOUT));
  for (const side of [-1, 1] as const) {
    shell.push(tint(bar(new Vector3(front - M(0.05), screenBase, side * (halfW - M(0.04))), new Vector3(front - M(0.16), cant, side * (halfW - M(0.04))), M(0.09), M(0.08)), BLACKOUT));
  }
  shell.push(tint(box(M(0.12), cant - screenTop, W - M(0.02), front - M(0.15), (cant + screenTop) / 2, 0), BLACKOUT));

  // ---- roof with rounded ends, and the air-conditioning pod.
  {
    const s: P2[] = [[back + M(0.02), cant], [front - M(0.12), cant], [front - M(0.2), H - M(0.12)], [front - M(0.5), H], [back + M(0.35), H], [back + M(0.03), H - M(0.1)]];
    shell.push(extrude(s, W, M(0.08), 0, 6));
    trim.push(tint(roundedSlab(M(2.6), W * 0.62, M(0.2), M(0.2), -M(0.6), H - M(0.01), 0), 0xd4d7da));
  }

  // ---- lamps, blind and plates.
  const headlamps: Lamp[] = [];
  const taillamps: Lamp[] = [];
  const indicators: (Lamp & { side: DoorSide; front: boolean })[] = [];
  for (const side of [-1, 1] as const) {
    headlamps.push({ x: front + M(0.005), y: M(0.62), z: side * (halfW - M(0.3)), sx: M(0.04), sy: M(0.14), sz: M(0.34) });
    taillamps.push({ x: back - M(0.005), y: M(0.75), z: side * (halfW - M(0.18)), sx: M(0.04), sy: M(0.34), sz: M(0.16) });
    indicators.push({ x: front + M(0.005), y: M(0.82), z: side * (halfW - M(0.12)), sx: M(0.04), sy: M(0.08), sz: M(0.12), side, front: true });
    indicators.push({ x: back - M(0.005), y: M(1.15), z: side * (halfW - M(0.18)), sx: M(0.04), sy: M(0.1), sz: M(0.16), side, front: false });
  }
  const plates: Lamp[] = [
    { x: front + M(0.01), y: M(0.45), z: 0, sx: M(0.015), sy: M(0.13), sz: M(0.4) },
    { x: back - M(0.01), y: M(0.5), z: 0, sx: M(0.015), sy: M(0.13), sz: M(0.4) },
    // The destination blind, lit.
    { x: front - M(0.14), y: cant - M(0.16), z: 0, sx: M(0.02), sy: M(0.2), sz: W - M(0.5) },
  ];

  // the doors, shut (4.0 :844-866): two glazed leaves each, framed
  doorSpans.forEach(([x0, x1]) => {
    const leaf = (x1 - x0) / 2;
    for (const dir of [1, -1] as const) {
      const cx = dir === 1 ? x1 - leaf / 2 : x0 + leaf / 2;
      const hingeZ = halfW - wall / 2;
      const hw = leaf / 2 - M(0.005);
      const top = cant - M(0.02);
      const bot = floor + M(0.02);
      const f: BufferGeometry[] = [];
      f.push(tint(box(leaf - M(0.01), M(0.08), wall * 0.7, 0, bot + M(0.04), 0), BLACKOUT));
      f.push(tint(box(leaf - M(0.01), M(0.08), wall * 0.7, 0, top - M(0.04), 0), BLACKOUT));
      f.push(tint(box(M(0.06), top - bot, wall * 0.7, hw - M(0.03), (top + bot) / 2, 0), BLACKOUT));
      f.push(tint(box(M(0.06), top - bot, wall * 0.7, -hw + M(0.03), (top + bot) / 2, 0), BLACKOUT));
      f.push(tint(box(leaf - M(0.1), M(0.04), wall * 0.7, 0, sillY, 0), BLACKOUT));
      shell.push(merge(f).translate(cx, 0, hingeZ));
      glass.push(twoSided([[-hw + M(0.05), bot + M(0.08)], [hw - M(0.05), bot + M(0.08)], [hw - M(0.05), top - M(0.08)], [-hw + M(0.05), top - M(0.08)]],
        ([x, y]) => new Vector3(x + cx, y, hingeZ), new Vector3(0, 0, 1), M(0.006)));
    }
  });
  return { shell: merge(shell), glass: merge(glass), trim: merge(trim), accent: null, headlamps, taillamps, indicators, plates, axles };
}


export function buildTruckBody(a: HeavyArchetype): HeavyBody {
  const L = a.length;
  const W = a.width;
  const H = a.height;
  const r = a.wheelRadius;
  const halfW = W / 2;
  const cabLength = L * a.cabinFraction;
  const cabFront = L / 2;
  const cabBack = cabFront - cabLength;
  const axles = heavyAxles(a, false);
  const archR = r + M(0.08);
  const cabBottom = M(0.95);
  const belt = M(1.9);
  const cabTop = M(2.95);
  const shell: BufferGeometry[] = [];
  const trim: BufferGeometry[] = [];
  const glass: BufferGeometry[] = [];
  const accent: BufferGeometry[] = [];
  const skin = M(0.06);

  // ---- cab: front face, sides with the door openings, rear wall, roof.
  const doorFront = cabFront - M(0.42);
  const doorRear = cabBack + M(0.22);
  shell.push(roundedSlab(M(0.16), W, M(0.12), belt - M(0.55), cabFront - M(0.08), M(0.55), 0));
  for (const side of [-1, 1] as const) {
    const z = side * (halfW - skin / 2);
    // Front corner and rear strip of each side, from the cab bottom to the waist.
    shell.push(extrude([[doorFront, cabBottom], [cabFront - M(0.1), cabBottom], [cabFront - M(0.1), belt], [doorFront, belt]], skin, M(0.015), z, 2, 1));
    shell.push(extrude([[cabBack, cabBottom], [doorRear, cabBottom], [doorRear, belt], [cabBack, belt]], skin, M(0.015), z, 2, 1));
    // Mudguard over the front wheel.
    trim.push(tint(extrude(archOutline(axles[0]!, r, archR), M(0.3), M(0.02), side * (halfW - M(0.17)), 8, 1), DARK_TRIM));
    // Steps behind the wheel, up to the cab floor.
    for (const [k, y] of [[0, M(0.5)], [1, M(0.82)]] as const) {
      trim.push(tint(box(M(0.4), M(0.04), M(0.22), axles[0]! - archR - M(0.25) + k * M(0.05), y, side * (halfW - M(0.12))), CHROME_TRIM));
    }
    trim.push(tint(box(M(0.5), M(0.5), M(0.03), axles[0]! - archR - M(0.25), M(0.68), side * (halfW - M(0.02))), DARK_TRIM));
    // Mirror arm and head.
    trim.push(tint(bar(new Vector3(cabFront - M(0.3), belt + M(0.2), side * halfW), new Vector3(cabFront - M(0.25), belt + M(0.35), side * (halfW + M(0.28))), M(0.035)), DARK_TRIM));
    trim.push(tint(box(M(0.08), M(0.42), M(0.16), cabFront - M(0.25), belt + M(0.35), side * (halfW + M(0.3))), DARK_TRIM));
    // Side glass behind the door and the pillars.
    shell.push(box(M(0.1), cabTop - belt, skin, cabBack + M(0.05), (cabTop + belt) / 2, z));
    shell.push(bar(new Vector3(cabFront - M(0.1), belt, z), new Vector3(cabFront - M(0.3), cabTop - M(0.05), z), M(0.1), skin));
    glass.push(twoSided([[cabBack + M(0.1), belt], [doorRear, belt], [doorRear, cabTop - M(0.08)], [cabBack + M(0.1), cabTop - M(0.08)]],
      ([x, y]) => new Vector3(x, y, side * (halfW - skin / 2)), new Vector3(0, 0, side), M(0.006)));
  }
  // Cab floor seen from the side under the doors, and the rear wall.
  shell.push(box(cabLength - M(0.1), M(0.06), W - M(0.02), cabBack + (cabLength - M(0.1)) / 2, cabBottom, 0));
  shell.push(box(M(0.06), cabTop - cabBottom, W - M(0.02), cabBack + M(0.03), (cabTop + cabBottom) / 2, 0));
  // Roof, and a deflector up to the height of the box.
  shell.push(extrude([[cabBack, cabTop - M(0.04)], [cabFront - M(0.32), cabTop - M(0.04)], [cabFront - M(0.36), cabTop + M(0.08)], [cabBack, cabTop + M(0.08)]], W, M(0.05), 0, 2));
  shell.push(extrude([[cabBack + M(0.05), cabTop + M(0.06)], [cabFront - M(0.8), cabTop + M(0.06)], [cabBack + M(0.25), H - M(0.08)], [cabBack + M(0.05), H - M(0.08)]], W - M(0.1), M(0.04), 0, 2));
  // Windscreen and the black surround.
  glass.push(loft([[cabFront - M(0.1), belt + M(0.02)], [cabFront - M(0.3), cabTop - M(0.06)]], () => halfW - M(0.1), M(0.03), 6));
  shell.push(tint(box(M(0.06), M(0.08), W - M(0.04), cabFront - M(0.1), belt - M(0.01), 0), BLACKOUT));
  // Grille, bumper and the lamps' housings.
  trim.push(tint(box(M(0.03), M(0.55), W * 0.62, cabFront + M(0.005), belt - M(0.42), 0), GRILLE));
  trim.push(tint(roundedSlab(M(0.2), W, M(0.1), M(0.3), cabFront + M(0.01), M(0.42), 0), DARK_TRIM));

  // ---- doors over the front wheels, shut (4.0 :1118-1134): their panels and glass with the cab
  for (const side of [-1, 1] as const) {
    const hingeX = doorFront - SHUT;
    const x1 = doorRear + SHUT;
    const hingeZ = side * (halfW - skin / 2);
    shell.push(extrude([[x1 - hingeX, cabBottom + M(0.02)], [0, cabBottom + M(0.02)], [0, belt], [x1 - hingeX, belt]], skin, M(0.015), 0, 2, 1).translate(hingeX, 0, hingeZ));
    trim.push(tint(box(M(0.2), M(0.04), M(0.02), (x1 - hingeX) + M(0.2), belt - M(0.15), side * (skin / 2 + M(0.008))), SEAM).translate(hingeX, 0, hingeZ));
    glass.push(twoSided([[x1 - hingeX + M(0.03), belt], [-M(0.04), belt], [-M(0.18), cabTop - M(0.08)], [x1 - hingeX + M(0.03), cabTop - M(0.08)]],
      ([x, y]) => new Vector3(x + hingeX, y, hingeZ), new Vector3(0, 0, side), M(0.006)));
  }

  // ---- chassis, tank, guards, mudguards.
  const boxFront = cabBack - M(0.18);
  trim.push(tint(box(L - M(0.4), M(0.25), W * 0.62, -M(0.1), M(0.74), 0), DARK_TRIM));
  trim.push(tint(new CylinderGeometry(M(0.26), M(0.26), M(1.1), 12).rotateZ(Math.PI / 2).translate(boxFront - M(0.9), M(0.62), -halfW + M(0.32)), CHROME_TRIM));
  trim.push(tint(box(M(0.9), M(0.45), M(0.5), boxFront - M(0.9), M(0.62), halfW - M(0.35)), DARK_TRIM));
  for (const side of [-1, 1] as const) {
    const xa = axles[1]! + archR + M(0.1);
    const xb = boxFront - M(1.6);
    if (xb - xa > M(0.3)) trim.push(tint(box(xb - xa, M(0.28), M(0.03), (xa + xb) / 2, M(0.62), side * (halfW - M(0.05))), 0x8e9398));
    trim.push(tint(extrude(archOutline((axles[1]! + axles[2]!) / 2, r, archR + (axles[1]! - axles[2]!) / 2), M(0.5), M(0.02), side * (halfW - M(0.27)), 8, 1), DARK_TRIM));
  }
  trim.push(tint(box(M(0.12), M(0.14), W - M(0.1), -L / 2 + M(0.1), M(0.55), 0), DARK_TRIM));

  // ---- the box body, with its floor rail, corner posts and rear doors.
  const boxBack = -L / 2 + M(0.05);
  const boxLength = boxFront - boxBack;
  const boxBottom = M(1.05);
  accent.push(extrude([[boxBack, boxBottom], [boxFront, boxBottom], [boxFront, H], [boxBack, H]], W, M(0.03), 0, 2, 1));
  trim.push(tint(box(boxLength, M(0.12), W + M(0.01), (boxFront + boxBack) / 2, boxBottom + M(0.02), 0), DARK_TRIM));
  for (const x of [boxFront, boxBack]) {
    for (const side of [-1, 1] as const) {
      trim.push(tint(box(M(0.08), H - boxBottom, M(0.08), x + (x === boxFront ? -M(0.04) : M(0.04)), (H + boxBottom) / 2, side * (halfW - M(0.03))), 0x9aa0a6));
    }
  }
  accent.push(tint(box(M(0.01), H - boxBottom - M(0.2), M(0.01), boxBack - M(0.005), (H + boxBottom) / 2, 0), SEAM));
  for (const side of [-1, 1] as const) {
    trim.push(tint(box(M(0.02), M(0.8), M(0.05), boxBack - M(0.01), boxBottom + M(1.1), side * M(0.2)), CHROME_TRIM));
  }

  const headlamps: Lamp[] = [];
  const taillamps: Lamp[] = [];
  const indicators: (Lamp & { side: DoorSide; front: boolean })[] = [];
  for (const side of [-1, 1] as const) {
    headlamps.push({ x: cabFront + M(0.01), y: M(0.82), z: side * (halfW - M(0.32)), sx: M(0.04), sy: M(0.14), sz: M(0.34) });
    taillamps.push({ x: -L / 2 + M(0.02), y: M(0.62), z: side * (halfW - M(0.2)), sx: M(0.04), sy: M(0.14), sz: M(0.26) });
    indicators.push({ x: cabFront + M(0.01), y: M(0.82), z: side * (halfW - M(0.08)), sx: M(0.04), sy: M(0.1), sz: M(0.1), side, front: true });
    indicators.push({ x: -L / 2 + M(0.02), y: M(0.82), z: side * (halfW - M(0.2)), sx: M(0.04), sy: M(0.08), sz: M(0.14), side, front: false });
  }
  const plates: Lamp[] = [
    { x: cabFront + M(0.12), y: M(0.5), z: 0, sx: M(0.015), sy: M(0.12), sz: M(0.4) },
    { x: -L / 2 + M(0.03), y: M(0.5), z: 0, sx: M(0.015), sy: M(0.14), sz: M(0.4) },
  ];
  return { shell: merge(shell), glass: merge(glass), trim: merge(trim), accent: merge(accent), headlamps, taillamps, indicators, plates, axles };
}

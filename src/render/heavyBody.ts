// Buses and lorries, their outside: the bus's walls with the arches cut and the doors, the window band with its pillars
// and panes, the windscreen, the roof and its air-conditioning pod, the folding doors shut; the lorry's cab with its
// doors, windscreen, grille, steps, mirrors and mudguards, the chassis, tank and side guards, the box body. The sizes
// and placings are Roadcraft 4.0's (render/vehicleModels.ts buildBusModel, buildTruckModel). Each model is built once
// from parts (render/vehicleParts.ts) into one geometry per material and drawn by instances (render/vehicles.ts). The
// cabins inside (seats, poles, dashboards) are left out while the glass is opaque. x forward, y up, z right; metres.

import { BufferGeometry, CylinderGeometry, Float32BufferAttribute, Vector3 } from 'three/webgpu';
import type { Lamp } from './carBody.ts';
import { PartList, bar, box, profile, slab, type P2 } from './vehicleParts.ts';

type DoorSide = -1 | 1;

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

/** Black-out on paint: pillars, window surrounds. */
const BLACKOUT = 0x1a1b1e;
/** Shut lines and seams on paint. */
const SEAM = 0x3a3a3a;
const DARK_TRIM = 0x202226;
const CHROME_TRIM = 0xb9bec4;
const GRILLE = 0x0e0f11;
/** Gap at each end of a lorry cab's door leaf against its opening. */
const SHUT = 0.004;

/** The run of a line rising in x that lies over [xa, xb], cut where it crosses both ends. */
function span(line: readonly P2[], xa: number, xb: number): P2[] {
  const yAt = (x: number): number => {
    for (let i = 1; i < line.length; i++) {
      const [x1, y1] = line[i], [x0, y0] = line[i - 1];
      if (x <= x1) return x1 > x0 ? y0 + ((y1 - y0) * (x - x0)) / (x1 - x0) : y1;
    }
    return line[line.length - 1][1];
  };
  return [[xa, yAt(xa)], ...line.filter(([x]) => x > xa && x < xb), [xb, yAt(xb)]];
}

/**
 * A flat convex pane from its corners in the plane's own (u, v), placed by `to3`, given both faces `gap` apart (seen
 * from outside and from in).
 */
function pane(corners: readonly P2[], to3: (p: P2) => Vector3, outward: Vector3, gap: number): BufferGeometry {
  const n = outward.clone().normalize(), off = n.clone().multiplyScalar(gap / 2);
  const outer = corners.map((c) => to3(c).add(off)), inner = corners.map((c) => to3(c).sub(off));
  const pos: number[] = [], e1 = new Vector3(), e2 = new Vector3();
  const tri = (a: Vector3, b: Vector3, c: Vector3, facing: Vector3): void => {
    const keep = e1.subVectors(b, a).cross(e2.subVectors(c, a)).dot(facing) >= 0;
    for (const p of keep ? [a, b, c] : [a, c, b]) pos.push(p.x, p.y, p.z);
  };
  const back = n.clone().negate();
  for (let i = 1; i < corners.length - 1; i++) { tri(outer[0], outer[i], outer[i + 1], n); tri(inner[0], inner[i], inner[i + 1], back); }
  const g = new BufferGeometry().setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/**
 * A windscreen from its base (x0, y0) to its top (x1, y1), `half` wide each side, bowed up `crown` at the middle,
 * `across` strips wide, facing forward.
 */
function screen(x0: number, y0: number, x1: number, y1: number, half: number, crown: number, across = 6): BufferGeometry {
  const pos: number[] = [];
  const at = (x: number, y: number, j: number): number[] => { const u = (2 * j) / across - 1; return [x, y + crown * (1 - u * u), u * half]; };
  for (let j = 0; j < across; j++) {
    const a = at(x0, y0, j), b = at(x0, y0, j + 1), c = at(x1, y1, j), d = at(x1, y1, j + 1);
    // wound to face +x (the base is ahead of the top)
    pos.push(...a, ...c, ...b, ...b, ...c, ...d);
  }
  const g = new BufferGeometry().setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** A mudguard's side outline over a wheel at (cx, cy): a half ring from `radius` out 6 cm, in 10 steps. */
function mudguard(cx: number, cy: number, radius: number): P2[] {
  const ring = (r: number): P2[] => Array.from({ length: 11 }, (_, i) => [cx - Math.cos((Math.PI * i) / 10) * r, cy + Math.sin((Math.PI * i) / 10) * r] as P2);
  return [...ring(radius + 0.06), ...ring(radius).reverse()];
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
  const archR = r + 0.07;
  const clear = 0.28;
  const floor = 0.38;
  const sillY = 1.02;
  const cant = H - 0.42;
  const wall = 0.06;
  const shell = new PartList();
  const trim = new PartList();
  const glass = new PartList();

  // Door openings on the kerb side: [rear edge, front edge].
  const doorSpans: [number, number][] = [[front - 1.5, front - 0.3], [-0.9, 0.3]];

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
  const wallOutline = (xa: number, xb: number, topY: number): P2[] => [...span(bottom, xa, xb), [xb, topY], [xa, topY]];
  // Left: one wall. Right: the stretches between the doors.
  shell.add(profile(wallOutline(back + 0.08, front - 0.08, sillY), wall, 0.02, -(halfW - wall / 2), 4, 2));
  {
    let x = back + 0.08;
    for (const [x0, x1] of [...doorSpans].sort((u, v) => u[0] - v[0])) {
      shell.add(profile(wallOutline(x, x0, sillY), wall, 0.02, halfW - wall / 2, 4, 2));
      x = x1;
    }
    shell.add(profile(wallOutline(x, front - 0.08, sillY), wall, 0.02, halfW - wall / 2, 4, 2));
  }
  // A darker skirt band along the bottom.
  for (const side of [-1, 1] as const) {
    trim.add(box(L - 0.3, 0.1, 0.02, 0, clear + 0.05, side * (halfW + 0.005)), DARK_TRIM);
  }
  // Front: a panel from the bumper to the windscreen, rounded at the corners.
  const screenBase = 0.95;
  shell.add(slab(0.14, W, 0.1, screenBase - clear, front - 0.07, clear, 0));
  shell.add(slab(0.14, W, 0.1, sillY - clear + 0.05, back + 0.07, clear, 0));
  // Rear: engine bay under a panel up to the cant rail, with a small window.
  shell.add(box(0.06, cant - sillY, W - 0.04, back + 0.03, (cant + sillY) / 2, 0));
  glass.add(pane([[-halfW + 0.3, sillY + 0.9], [halfW - 0.3, sillY + 0.9], [halfW - 0.3, cant - 0.15], [-halfW + 0.3, cant - 0.15]],
    ([z, y]) => new Vector3(back - 0.005, y, z), new Vector3(-1, 0, 0), 0.006));
  trim.add(box(0.02, 0.5, W * 0.7, back - 0.005, clear + 0.45, 0), GRILLE);

  // ---- the window band: pillars and glass from the sill to the cant rail.
  const bays = Math.max(5, Math.round((L - 1.5) / 1.4));
  const bandStart = back + 0.15;
  const bandEnd = front - 0.25;
  const pillar = 0.09;
  for (const side of [-1, 1] as const) {
    const z = side * (halfW - wall / 2);
    const spans: [number, number][] = [];
    // Pillars at bay edges, skipping the door openings on the kerb side.
    const inDoor = (x: number): boolean => side === 1 && doorSpans.some(([x0, x1]) => x > x0 - 0.05 && x < x1 + 0.05);
    const posts: number[] = [];
    for (let i = 0; i <= bays; i++) posts.push(bandStart + ((bandEnd - bandStart) * i) / bays);
    if (side === 1) for (const [x0, x1] of doorSpans) posts.push(x0 - pillar / 2, x1 + pillar / 2);
    const sorted = posts.filter((x) => !inDoor(x) || doorSpans.some(([x0, x1]) => Math.abs(x - x0 + pillar / 2) < 1e-6 || Math.abs(x - x1 - pillar / 2) < 1e-6))
      .sort((u, v) => u - v);
    for (const x of sorted) shell.add(box(pillar, cant - sillY, wall, x, (cant + sillY) / 2, z), BLACKOUT);
    for (let i = 0; i < sorted.length - 1; i++) {
      const x0 = sorted[i]! + pillar / 2;
      const x1 = sorted[i + 1]! - pillar / 2;
      if (x1 - x0 < 0.2 || inDoor((x0 + x1) / 2)) continue;
      spans.push([x0, x1]);
    }
    for (const [x0, x1] of spans) {
      glass.add(pane([[x0, sillY], [x1, sillY], [x1, cant], [x0, cant]], ([x, y]) => new Vector3(x, y, side * (halfW - wall * 0.3)), new Vector3(0, 0, side), 0.006));
    }
    // A black band under the glass, the rubber of the glazing.
    shell.add(box(bandEnd - bandStart, 0.05, wall + 0.004, (bandStart + bandEnd) / 2, sillY + 0.01, z), BLACKOUT);
  }
  // The driver's side window, ahead of the first bay on the left.
  const screenTop = cant - 0.3;
  glass.add(screen(front - 0.04, screenBase, front - 0.14, screenTop, halfW - 0.08, 0.04));
  shell.add(box(0.1, 0.08, W - 0.02, front - 0.06, screenBase - 0.02, 0), BLACKOUT);
  for (const side of [-1, 1] as const) {
    shell.add(bar(new Vector3(front - 0.05, screenBase, side * (halfW - 0.04)), new Vector3(front - 0.16, cant, side * (halfW - 0.04)), 0.09, 0.08), BLACKOUT);
  }
  shell.add(box(0.12, cant - screenTop, W - 0.02, front - 0.15, (cant + screenTop) / 2, 0), BLACKOUT);

  // ---- roof with rounded ends, and the air-conditioning pod.
  {
    const s: P2[] = [[back + 0.02, cant], [front - 0.12, cant], [front - 0.2, H - 0.12], [front - 0.5, H], [back + 0.35, H], [back + 0.03, H - 0.1]];
    shell.add(profile(s, W, 0.08, 0, 6));
    trim.add(slab(2.6, W * 0.62, 0.2, 0.2, -0.6, H - 0.01, 0), 0xd4d7da);
  }

  // ---- lamps, blind and plates.
  const headlamps: Lamp[] = [];
  const taillamps: Lamp[] = [];
  const indicators: (Lamp & { side: DoorSide; front: boolean })[] = [];
  for (const side of [-1, 1] as const) {
    headlamps.push({ x: front + 0.005, y: 0.62, z: side * (halfW - 0.3), sx: 0.04, sy: 0.14, sz: 0.34 });
    taillamps.push({ x: back - 0.005, y: 0.75, z: side * (halfW - 0.18), sx: 0.04, sy: 0.34, sz: 0.16 });
    indicators.push({ x: front + 0.005, y: 0.82, z: side * (halfW - 0.12), sx: 0.04, sy: 0.08, sz: 0.12, side, front: true });
    indicators.push({ x: back - 0.005, y: 1.15, z: side * (halfW - 0.18), sx: 0.04, sy: 0.1, sz: 0.16, side, front: false });
  }
  const plates: Lamp[] = [
    { x: front + 0.01, y: 0.45, z: 0, sx: 0.015, sy: 0.13, sz: 0.4 },
    { x: back - 0.01, y: 0.5, z: 0, sx: 0.015, sy: 0.13, sz: 0.4 },
    // The destination blind, lit.
    { x: front - 0.14, y: cant - 0.16, z: 0, sx: 0.02, sy: 0.2, sz: W - 0.5 },
  ];

  // the doors, shut (4.0 :844-866): two glazed leaves each, framed
  doorSpans.forEach(([x0, x1]) => {
    const leaf = (x1 - x0) / 2;
    for (const dir of [1, -1] as const) {
      const cx = dir === 1 ? x1 - leaf / 2 : x0 + leaf / 2;
      const hingeZ = halfW - wall / 2;
      const hw = leaf / 2 - 0.005;
      const top = cant - 0.02;
      const bot = floor + 0.02;
      const f = new PartList();
      f.add(box(leaf - 0.01, 0.08, wall * 0.7, 0, bot + 0.04, 0), BLACKOUT);
      f.add(box(leaf - 0.01, 0.08, wall * 0.7, 0, top - 0.04, 0), BLACKOUT);
      f.add(box(0.06, top - bot, wall * 0.7, hw - 0.03, (top + bot) / 2, 0), BLACKOUT);
      f.add(box(0.06, top - bot, wall * 0.7, -hw + 0.03, (top + bot) / 2, 0), BLACKOUT);
      f.add(box(leaf - 0.1, 0.04, wall * 0.7, 0, sillY, 0), BLACKOUT);
      shell.add(f.geometry().translate(cx, 0, hingeZ));
      glass.add(pane([[-hw + 0.05, bot + 0.08], [hw - 0.05, bot + 0.08], [hw - 0.05, top - 0.08], [-hw + 0.05, top - 0.08]],
        ([x, y]) => new Vector3(x + cx, y, hingeZ), new Vector3(0, 0, 1), 0.006));
    }
  });
  return { shell: shell.geometry(), glass: glass.geometry(), trim: trim.geometry(), accent: null, headlamps, taillamps, indicators, plates, axles };
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
  const archR = r + 0.08;
  const cabBottom = 0.95;
  const belt = 1.9;
  const cabTop = 2.95;
  const shell = new PartList();
  const trim = new PartList();
  const glass = new PartList();
  const accent = new PartList();
  const skin = 0.06;

  // ---- cab: front face, sides with the door openings, rear wall, roof.
  const doorFront = cabFront - 0.42;
  const doorRear = cabBack + 0.22;
  shell.add(slab(0.16, W, 0.12, belt - 0.55, cabFront - 0.08, 0.55, 0));
  for (const side of [-1, 1] as const) {
    const z = side * (halfW - skin / 2);
    // Front corner and rear strip of each side, from the cab bottom to the waist.
    shell.add(profile([[doorFront, cabBottom], [cabFront - 0.1, cabBottom], [cabFront - 0.1, belt], [doorFront, belt]], skin, 0.015, z, 2, 1));
    shell.add(profile([[cabBack, cabBottom], [doorRear, cabBottom], [doorRear, belt], [cabBack, belt]], skin, 0.015, z, 2, 1));
    // Mudguard over the front wheel.
    trim.add(profile(mudguard(axles[0]!, r, archR), 0.3, 0.02, side * (halfW - 0.17), 8, 1), DARK_TRIM);
    // Steps behind the wheel, up to the cab floor.
    for (const [k, y] of [[0, 0.5], [1, 0.82]] as const) {
      trim.add(box(0.4, 0.04, 0.22, axles[0]! - archR - 0.25 + k * 0.05, y, side * (halfW - 0.12)), CHROME_TRIM);
    }
    trim.add(box(0.5, 0.5, 0.03, axles[0]! - archR - 0.25, 0.68, side * (halfW - 0.02)), DARK_TRIM);
    // Mirror arm and head.
    trim.add(bar(new Vector3(cabFront - 0.3, belt + 0.2, side * halfW), new Vector3(cabFront - 0.25, belt + 0.35, side * (halfW + 0.28)), 0.035), DARK_TRIM);
    trim.add(box(0.08, 0.42, 0.16, cabFront - 0.25, belt + 0.35, side * (halfW + 0.3)), DARK_TRIM);
    // Side glass behind the door and the pillars.
    shell.add(box(0.1, cabTop - belt, skin, cabBack + 0.05, (cabTop + belt) / 2, z));
    shell.add(bar(new Vector3(cabFront - 0.1, belt, z), new Vector3(cabFront - 0.3, cabTop - 0.05, z), 0.1, skin));
    glass.add(pane([[cabBack + 0.1, belt], [doorRear, belt], [doorRear, cabTop - 0.08], [cabBack + 0.1, cabTop - 0.08]],
      ([x, y]) => new Vector3(x, y, side * (halfW - skin / 2)), new Vector3(0, 0, side), 0.006));
  }
  // Cab floor seen from the side under the doors, and the rear wall.
  shell.add(box(cabLength - 0.1, 0.06, W - 0.02, cabBack + (cabLength - 0.1) / 2, cabBottom, 0));
  shell.add(box(0.06, cabTop - cabBottom, W - 0.02, cabBack + 0.03, (cabTop + cabBottom) / 2, 0));
  // Roof, and a deflector up to the height of the box.
  shell.add(profile([[cabBack, cabTop - 0.04], [cabFront - 0.32, cabTop - 0.04], [cabFront - 0.36, cabTop + 0.08], [cabBack, cabTop + 0.08]], W, 0.05, 0, 2));
  shell.add(profile([[cabBack + 0.05, cabTop + 0.06], [cabFront - 0.8, cabTop + 0.06], [cabBack + 0.25, H - 0.08], [cabBack + 0.05, H - 0.08]], W - 0.1, 0.04, 0, 2));
  // Windscreen and the black surround.
  glass.add(screen(cabFront - 0.1, belt + 0.02, cabFront - 0.3, cabTop - 0.06, halfW - 0.1, 0.03));
  shell.add(box(0.06, 0.08, W - 0.04, cabFront - 0.1, belt - 0.01, 0), BLACKOUT);
  // Grille, bumper and the lamps' housings.
  trim.add(box(0.03, 0.55, W * 0.62, cabFront + 0.005, belt - 0.42, 0), GRILLE);
  trim.add(slab(0.2, W, 0.1, 0.3, cabFront + 0.01, 0.42, 0), DARK_TRIM);

  // ---- doors over the front wheels, shut (4.0 :1118-1134): their panels and glass with the cab
  for (const side of [-1, 1] as const) {
    const hingeX = doorFront - SHUT;
    const x1 = doorRear + SHUT;
    const hingeZ = side * (halfW - skin / 2);
    shell.add(profile([[x1 - hingeX, cabBottom + 0.02], [0, cabBottom + 0.02], [0, belt], [x1 - hingeX, belt]], skin, 0.015, 0, 2, 1).translate(hingeX, 0, hingeZ));
    trim.add(box(0.2, 0.04, 0.02, (x1 - hingeX) + 0.2, belt - 0.15, side * (skin / 2 + 0.008)).translate(hingeX, 0, hingeZ), SEAM);
    glass.add(pane([[x1 - hingeX + 0.03, belt], [-0.04, belt], [-0.18, cabTop - 0.08], [x1 - hingeX + 0.03, cabTop - 0.08]],
      ([x, y]) => new Vector3(x + hingeX, y, hingeZ), new Vector3(0, 0, side), 0.006));
  }

  // ---- chassis, tank, guards, mudguards.
  const boxFront = cabBack - 0.18;
  trim.add(box(L - 0.4, 0.25, W * 0.62, -0.1, 0.74, 0), DARK_TRIM);
  trim.add(new CylinderGeometry(0.26, 0.26, 1.1, 12).rotateZ(Math.PI / 2).translate(boxFront - 0.9, 0.62, -halfW + 0.32), CHROME_TRIM);
  trim.add(box(0.9, 0.45, 0.5, boxFront - 0.9, 0.62, halfW - 0.35), DARK_TRIM);
  for (const side of [-1, 1] as const) {
    const xa = axles[1]! + archR + 0.1;
    const xb = boxFront - 1.6;
    if (xb - xa > 0.3) trim.add(box(xb - xa, 0.28, 0.03, (xa + xb) / 2, 0.62, side * (halfW - 0.05)), 0x8e9398);
    trim.add(profile(mudguard((axles[1]! + axles[2]!) / 2, r, archR + (axles[1]! - axles[2]!) / 2), 0.5, 0.02, side * (halfW - 0.27), 8, 1), DARK_TRIM);
  }
  trim.add(box(0.12, 0.14, W - 0.1, -L / 2 + 0.1, 0.55, 0), DARK_TRIM);

  // ---- the box body, with its floor rail, corner posts and rear doors.
  const boxBack = -L / 2 + 0.05;
  const boxLength = boxFront - boxBack;
  const boxBottom = 1.05;
  accent.add(profile([[boxBack, boxBottom], [boxFront, boxBottom], [boxFront, H], [boxBack, H]], W, 0.03, 0, 2, 1));
  trim.add(box(boxLength, 0.12, W + 0.01, (boxFront + boxBack) / 2, boxBottom + 0.02, 0), DARK_TRIM);
  for (const x of [boxFront, boxBack]) {
    for (const side of [-1, 1] as const) {
      trim.add(box(0.08, H - boxBottom, 0.08, x + (x === boxFront ? -0.04 : 0.04), (H + boxBottom) / 2, side * (halfW - 0.03)), 0x9aa0a6);
    }
  }
  accent.add(box(0.01, H - boxBottom - 0.2, 0.01, boxBack - 0.005, (H + boxBottom) / 2, 0), SEAM);
  for (const side of [-1, 1] as const) {
    trim.add(box(0.02, 0.8, 0.05, boxBack - 0.01, boxBottom + 1.1, side * 0.2), CHROME_TRIM);
  }

  const headlamps: Lamp[] = [];
  const taillamps: Lamp[] = [];
  const indicators: (Lamp & { side: DoorSide; front: boolean })[] = [];
  for (const side of [-1, 1] as const) {
    headlamps.push({ x: cabFront + 0.01, y: 0.82, z: side * (halfW - 0.32), sx: 0.04, sy: 0.14, sz: 0.34 });
    taillamps.push({ x: -L / 2 + 0.02, y: 0.62, z: side * (halfW - 0.2), sx: 0.04, sy: 0.14, sz: 0.26 });
    indicators.push({ x: cabFront + 0.01, y: 0.82, z: side * (halfW - 0.08), sx: 0.04, sy: 0.1, sz: 0.1, side, front: true });
    indicators.push({ x: -L / 2 + 0.02, y: 0.82, z: side * (halfW - 0.2), sx: 0.04, sy: 0.08, sz: 0.14, side, front: false });
  }
  const plates: Lamp[] = [
    { x: cabFront + 0.12, y: 0.5, z: 0, sx: 0.015, sy: 0.12, sz: 0.4 },
    { x: -L / 2 + 0.03, y: 0.5, z: 0, sx: 0.015, sy: 0.14, sz: 0.4 },
  ];
  return { shell: shell.geometry(), glass: glass.geometry(), trim: trim.geometry(), accent: accent.geometry(), headlamps, taillamps, indicators, plates, axles };
}
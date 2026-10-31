// What a car's glass shows into: carpet, dashboard and console, steering wheel, the seats with their headrests at the
// hip points the occupants sit at (carBody.ts carSeatPoints), the door trims up to the waist and what is behind the
// last seats (parcel shelf, load floor, a pick-up's cab wall, a van's bulkhead). Without it the body is a hollow shell:
// through the windscreen the road under the car shows from above. Built once per style for the near model only (the
// farther ones have opaque dark glass), flat: boxes and plain extrusions, the steering wheel a coarse ring, about 500
// triangles a car. The seating package's numbers are Roadcraft 4.0's. x forward, y up, z right; metres.

import { BufferGeometry, CylinderGeometry, Float32BufferAttribute, TorusGeometry, Vector3 } from 'three/webgpu';
import { CAB_HIP_OVER_FLOOR, CAR_HIP_OVER_FLOOR, axlesOf, carShape, carStyle, type CarArchetype, type CarStyle } from './carBody.ts';
import { PartList, bar, box, profile } from './vehicleParts.ts';

const CARPET = 0x26282c, DASH = 0x1e2023, SEAT_FABRIC = 0x4a4f57, SEAT_SIDE = 0x34373d, CARD = 0x3b3e44;
const HEADREST = 0x42464d, WHEEL_RIM = 0x141517, BULKHEAD = 0x8b9198;
/** The seating package: seat recline (rad), the cushion's drop under the hip and its reach. */
const RECLINE = 0.42, CUSHION_DROP = 0.1, CUSHION_REACH = 0.42, UPRIGHT_CUSHION_REACH = 0.3;
/** Where the steering wheel's hub is from the driver's hip, its lean back from vertical and its radius. */
const DRIVER_WHEEL = { forward: 0.46, up: 0.36, tilt: 0.45, radius: 0.185 };
const CAB_WHEEL = { forward: 0.42, up: 0.13, tilt: 1.0, radius: 0.22 };

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** The cabin of class `a` in style `name`, one geometry (position, normal, colour). */
export function buildCarCabin(a: CarArchetype, name: Exclude<CarStyle, 'wagon'>): BufferGeometry {
  const st = carStyle(name), shape = carShape(a, name);
  const { top, belt, halfWidth, back, floor, screenBase, doorEdges } = shape;
  const W = a.width, L = a.length, inner = W - 0.2, axles = axlesOf(a);
  const rows = doorEdges.length - 1;
  const hipY = floor + (st.cab ? CAB_HIP_OVER_FLOOR : CAR_HIP_OVER_FLOOR), seatZ = W / 2 - 0.46;
  const seatX = (row: number): number => st.hip * L - row * st.couple;
  const archR = a.wheelRadius + 0.07;
  const parts = new PartList();
  // the footwell runs forward under the dash to the front wheel houses
  const bulk = Math.min(axles[0] - archR - 0.02, screenBase + 0.1);
  const lastX = seatX(rows - 1);
  // the body's own width over a stretch, less a gap: the floor and the dash reach the sides (no slit to the road)
  const widthOver = (xa: number, xb: number): number => {
    let hw = Infinity;
    for (let i = 0; i <= 8; i++) hw = Math.min(hw, halfWidth(lerp(xa, xb, i / 8)));
    return 2 * hw - 0.06;
  };
  parts.add(box(bulk - (lastX - 0.6), 0.03, widthOver(lastX - 0.6, bulk), (bulk + lastX - 0.6) / 2, floor - 0.015, 0), CARPET);
  // dashboard and console, from the driver's place (the left side: z < 0)
  const wheel = st.cab ? CAB_WHEEL : DRIVER_WHEEL;
  const dx = seatX(0), dz = -seatZ;
  const dashTop = belt(screenBase - 0.1) - 0.01, dashRear = dx + wheel.forward + 0.12;
  parts.add(profile([
    [screenBase + 0.02, dashTop - 0.03], [bulk, floor + 0.14], [bulk - 0.06, floor + 0.14],
    [dashRear + 0.12, dashTop - 0.3], [dashRear, dashTop - 0.18], [dashRear - 0.02, dashTop - 0.05], [dashRear + 0.06, dashTop + 0.01],
  ], widthOver(dashRear, screenBase + 0.02), 0), DASH);
  const consoleBack = dx - 0.12;
  if (!st.cab) parts.add(box(dashRear - consoleBack, 0.2, 0.2, (dashRear + consoleBack) / 2, floor + 0.1, 0), DASH);
  // the steering wheel: a ring and its boss, its axis towards the driver leaning back by the package's tilt
  parts.add(new TorusGeometry(wheel.radius, 0.02, 4, 14).rotateY(Math.PI / 2).rotateZ(wheel.tilt).translate(dx + wheel.forward, hipY + wheel.up, dz), WHEEL_RIM);
  parts.add(new CylinderGeometry(0.065, 0.075, 0.05, 8).rotateZ(Math.PI / 2).rotateZ(wheel.tilt).translate(dx + wheel.forward, hipY + wheel.up, dz), WHEEL_RIM);
  // seats: buckets in front, a bench behind
  const headrest = (x: number, y: number, z: number, width: number): void => { parts.add(box(0.1, 0.18, width, x, y + 0.09, z), HEADREST); };
  const headrestAt = (x: number, y: number, recline: number): [number, number] => [x - 0.2 - 0.62 * Math.sin(recline), y - 0.08 + 0.62 * Math.cos(recline)];
  for (const side of [-1, 1] as const) {
    seat(parts, seatX(0), hipY, floor, 0.5, side * seatZ, RECLINE, 0.6, st.cab ? UPRIGHT_CUSHION_REACH : CUSHION_REACH);
    const [hx, hy] = headrestAt(seatX(0), hipY, RECLINE);
    headrest(hx, hy, side * seatZ, 0.26);
  }
  if (rows > 1) {
    const x = seatX(rows - 1), recline = RECLINE + 0.05;
    seat(parts, x, hipY, floor, Math.min(inner - 0.06, 2 * seatZ + 0.64), 0, recline, 0.58, CUSHION_REACH);
    const [hx, hy] = headrestAt(x, hipY, recline);
    for (const side of [-1, 1] as const) headrest(hx - 0.01, hy - 0.03, side * seatZ, 0.24);
    // behind the bench: a parcel shelf (sedan), the cab's back wall (pick-up) or a load floor under a shelf
    const benchBack = x - 0.14 - 0.58 * Math.sin(recline) - 0.1;
    const rear = st.rear ? st.rear[1] * L : back + 0.3;
    if (name === 'sedan') {
      parts.add(box(Math.max(0.1, benchBack - rear), 0.03, inner, (benchBack + rear) / 2, belt(rear) - 0.02, 0), CARPET);
    } else if (name === 'pickup' && st.bedFrom !== undefined) {
      const bx = st.bedFrom * L + 0.06, h = top(bx + 0.04) - floor - 0.05;
      parts.add(box(0.04, h, inner, bx, floor + h / 2, 0), CARD);
    } else {
      const bootFloor = floor + 0.3, bootEnd = back + 0.04, from = x - 0.2;
      parts.add(box(from - bootEnd, 0.03, inner, (from + bootEnd) / 2, bootFloor, 0), CARPET);
      parts.add(box(Math.max(0.1, benchBack - bootEnd), 0.015, inner - 0.04, (benchBack + bootEnd) / 2, belt(bootEnd) - 0.02, 0), 0x2c2e33);
    }
  } else {
    // a van: the bulkhead behind the cab
    const bx = seatX(0) - 0.55;
    parts.add(box(0.04, top(bx) - floor - 0.08, inner, bx, (top(bx) + floor) / 2 - 0.02, 0), BULKHEAD);
  }
  // the trim inside the doors, up to the waist, from the footwell to behind the last seat: it hides the inside of the
  // far side's panels (the shell is one-sided) seen through the near window, in four lengths each as wide as the body
  // there, clear of the wheel arches (through the arch's opening it stood over the rear wheel as a grey slab)
  const x0 = Math.max(back + 0.25, lastX - 0.75, axles[1] + archR + 0.03), x1 = bulk;
  for (let k = 0; k < 4; k++) {
    const xa = lerp(x0, x1, k / 4), xb = lerp(x0, x1, (k + 1) / 4);
    let hw = Infinity, waist = Infinity;
    for (let i = 0; i <= 4; i++) { const x = lerp(xa, xb, i / 4); hw = Math.min(hw, halfWidth(x)); waist = Math.min(waist, belt(x)); }
    for (const side of [-1, 1] as const) parts.add(box(xb - xa, waist - floor, 0.1, (xa + xb) / 2, (waist + floor) / 2, side * (hw - 0.08)), CARD);
  }
  // the wheel houses come into the cabin: by each axle, from under the floor up to the arch's top and out from the
  // wheel house's inner face, the floor, the rear bench and the boot floor are cut away (they reached through the
  // arch's opening over the tyre), and the wheel house's walls, in the trim, close the cut
  const well = W / 2 - W * 0.14 - 0.06, wellTop = archR + a.wheelRadius * 0.96 + 0.02, rx = archR + 0.02;
  const houses: number[][] = [];
  for (const ax of axles) for (const sd of [-1, 1] as const) houses.push(sd > 0 ? [ax - rx, floor - 0.1, well, ax + rx, wellTop, W] : [ax - rx, floor - 0.1, -W, ax + rx, wellTop, -well]);
  const reach = new Float64Array(houses.length * 2);
  const out = new PartList().add(carve(parts.geometry(), houses, reach));
  // the walls close only what was cut and can be seen: the rear houses (the cabin's floor ends before the front ones),
  // the inner wall and the top over a cut, a wall ahead or behind only where what was cut goes on past the house. One
  // face each, towards the cabin: from outside, through the arch's opening, the liner over the tyre hides the other side.
  houses.forEach((h, i) => {
    const cx0 = reach[2 * i], cx1 = reach[2 * i + 1];
    if (!(cx1 > cx0)) return;
    const ax = (h[0] + h[3]) / 2, sd = h[2] > 0 ? 1 : -1;
    if (ax > 0) return;
    const side = Math.min(halfWidth(ax - rx), halfWidth(ax + rx)) - 0.03;
    if (side <= well) return;
    const zOut = [sd * well, sd * side].sort((p, q) => p - q);
    wall(out, 2, sd * well, [ax - rx, ax + rx], [floor, wellTop], -sd);
    wall(out, 1, wellTop, [ax - rx, ax + rx], zOut, 1);
    for (const k of [-1, 1] as const) {
      if (k > 0 ? cx1 <= ax + rx + 1e-4 : cx0 >= ax - rx - 1e-4) continue;
      wall(out, 0, ax + k * rx, [floor, wellTop], zOut, k);
    }
  });
  return out.geometry();
}

/**
 * A rectangle of door card in the plane coordinate[axis] = value, over `u` and `v` along the next two axes (x → y, z;
 * y → x, z; z → x, y), facing `facing` (±1) along `axis`: two triangles.
 */
function wall(out: PartList, axis: number, value: number, u: readonly number[], v: readonly number[], facing: number): void {
  const [ua, va] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
  const corner = (p: number, q: number): number[] => { const c = [0, 0, 0]; c[axis] = value; c[ua] = p; c[va] = q; return c; };
  let quad = [corner(u[0], v[0]), corner(u[1], v[0]), corner(u[1], v[1]), corner(u[0], v[1])];
  // wound counter-clockwise seen from the side it faces
  const e1 = quad[1].map((c, k) => c - quad[0][k]), e2 = quad[2].map((c, k) => c - quad[0][k]);
  const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  if (n[axis] * facing < 0) quad = [quad[0], quad[3], quad[2], quad[1]];
  const nrm = [0, 0, 0]; nrm[axis] = facing;
  out.triangles([...quad[0], ...quad[1], ...quad[2], ...quad[0], ...quad[2], ...quad[3]], [...nrm, ...nrm, ...nrm, ...nrm, ...nrm, ...nrm], CARD);
}

/**
 * `g` (non-indexed: position, normal, colour) less what lies inside any of the boxes ([x0, y0, z0, x1, y1, z1]): each
 * triangle that reaches into one is cut by the box's planes, the parts outside kept (attributes interpolated along the
 * cut), the part inside dropped. What is cut is left open there: what cut it closes it. `reach`: for each box, the
 * least and most x of what reached into it (Infinity, -Infinity: nothing).
 */
function carve(g: BufferGeometry, boxes: readonly (readonly number[])[], reach: Float64Array): BufferGeometry {
  for (let i = 0; i < boxes.length; i++) { reach[2 * i] = Infinity; reach[2 * i + 1] = -Infinity; }
  const P = g.getAttribute('position').array, N = g.getAttribute('normal').array, C = g.getAttribute('color').array;
  const pos: number[] = [], nor: number[] = [], col: number[] = [];
  type V = number[]; // x y z, nx ny nz, r g b
  const at = (a: V, b: V, f: number): V => a.map((v, k) => v + (b[k] - v) * f);
  // the part of `poly` on one side of the plane coordinate[axis] = value (`keepBelow`: below it)
  const clip = (poly: V[], axis: number, value: number, keepBelow: boolean): V[] => {
    const res: V[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const da = keepBelow ? value - a[axis] : a[axis] - value, db = keepBelow ? value - b[axis] : b[axis] - value;
      if (da >= 0) res.push(a);
      if ((da >= 0) !== (db >= 0)) res.push(at(a, b, da / (da - db)));
    }
    return res;
  };
  const emit = (poly: V[]): void => {
    for (let i = 1; i + 1 < poly.length; i++) {
      const a = poly[0], b = poly[i], c = poly[i + 1];
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) < 1e-9) continue;
      for (const v of [a, b, c]) { pos.push(v[0], v[1], v[2]); nor.push(v[3], v[4], v[5]); col.push(v[6], v[7], v[8]); }
    }
  };
  for (let t = 0; t < P.length; t += 9) {
    let pieces: V[][] = [[0, 1, 2].map((k) => { const o = t + 3 * k; return [P[o], P[o + 1], P[o + 2], N[o], N[o + 1], N[o + 2], C[o], C[o + 1], C[o + 2]]; })];
    boxes.forEach((bx, bi) => {
      const next: V[][] = [];
      for (const poly of pieces) {
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (const v of poly) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); }
        if (hi[0] <= bx[0] || lo[0] >= bx[3] || hi[1] <= bx[1] || lo[1] >= bx[4] || hi[2] <= bx[2] || lo[2] >= bx[5]) { next.push(poly); continue; }
        reach[2 * bi] = Math.min(reach[2 * bi], lo[0]); reach[2 * bi + 1] = Math.max(reach[2 * bi + 1], hi[0]);
        // outside each plane in turn is kept; what is inside all six is the box's
        let rest = poly;
        for (let k = 0; k < 3 && rest.length >= 3; k++) {
          const below = clip(rest, k, bx[k], true);
          if (below.length >= 3) next.push(below);
          rest = clip(rest, k, bx[k], false);
          if (rest.length < 3) break;
          const above = clip(rest, k, bx[k + 3], false);
          if (above.length >= 3) next.push(above);
          rest = clip(rest, k, bx[k + 3], true);
        }
      }
      pieces = next;
    });
    for (const poly of pieces) emit(poly);
  }
  const r = new BufferGeometry();
  r.setAttribute('position', new Float32BufferAttribute(pos, 3));
  r.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  r.setAttribute('color', new Float32BufferAttribute(col, 3));
  return r;
}

/** A seat: the side profile of cushion and back extruded across, its bolsters and its base. */
function seat(out: PartList, hipX: number, hipY: number, floor: number, width: number, z: number, recline: number, backHeight: number, reach: number): void {
  const top = hipY - CUSHION_DROP, base = Math.max(floor + 0.1, top - 0.13), backX = hipX - 0.14;
  const sin = Math.sin(recline), cos = Math.cos(recline), thick = 0.13;
  out.add(profile([
    [hipX + reach - 0.04, top - 0.03], [hipX + reach, top - 0.08], [hipX + reach - 0.04, base],
    [backX - thick * cos, base], [backX - thick * cos - backHeight * sin, top + backHeight * cos - 0.02],
    [backX - backHeight * sin + 0.01, top + backHeight * cos], [backX, top + 0.05], [backX + 0.06, top],
  ], width, 0, z), SEAT_FABRIC);
  for (const side of [-1, 1] as const) {
    const zz = z + side * (width / 2 - 0.04);
    out.add(bar(new Vector3(backX - 0.02, top + 0.08, zz), new Vector3(backX - 0.02 - backHeight * 0.8 * sin, top + backHeight * 0.8 * cos, zz), 0.09, 0.07), SEAT_SIDE);
  }
  out.add(box(0.3, Math.max(0.02, base - floor), width * 0.6, hipX + 0.08, (base + floor) / 2, z), DASH);
}

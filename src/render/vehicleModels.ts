// The vehicle and person models render/vehicles.ts draws by instances: the cars from their bodies (carBody.ts,
// carCabin.ts), the bus and the lorry (heavyBody.ts), the motorbike, the bicycle, the people, with the wheels, lamps
// and glass tagged for the shader (the tag in the colour's alpha: glow, wheel, blob, occupant), and the fleet's sizes.
// Built once at load.

import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CAR_SIZES, buildCarBody, buildCarSilhouette, type CarArchetype, type CarStyle, type Lamp } from './carBody.ts';
import { buildCarCabin } from './carCabin.ts';
import { buildBusBody, buildTruckBody, type HeavyArchetype, type HeavyBody } from './heavyBody.ts';

export const NEAR = 200;
export const MID = 1700;
export const CAP_NEAR = 6000;
export const CAP_MID = 30000;

/** Parts: [x, y, z, width, height, length, fixed colour or -1 = paint]. */
export type Part = [number, number, number, number, number, number, number];

export function model(parts: Part[]): THREE.BufferGeometry {
  const geos = parts.map(([x, y, z, w, h, l, col]) => {
    const g = new THREE.BoxGeometry(w, h, l);
    g.translate(x, y + h / 2, z);
    g.deleteAttribute('uv');
    const n = g.attributes.position.count;
    const c = new Float32Array(n * 3), paint = new Float32Array(n), glow = new Float32Array(n);
    const color = new THREE.Color(col < 0 ? 0xffffff : col).convertSRGBToLinear();
    // headlights (1) and tail lights (2) light up at night and in the rain; indicators (3 left, 4 right) blink
    const gl = glowOf(col);
    for (let i = 0; i < n; i++) { c[i * 3] = color.r; c[i * 3 + 1] = color.g; c[i * 3 + 2] = color.b; paint[i] = col < 0 ? 1 : 0; glow[i] = gl; }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    g.setAttribute('paint', new THREE.BufferAttribute(paint, 1));
    g.setAttribute('glow', new THREE.BufferAttribute(glow, 1));
    g.setAttribute('limb', new THREE.BufferAttribute(new Float32Array(n), 1));
    return g;
  });
  const merged = mergeGeometries(geos)!;
  return merged;
}

export const GLASS = 0x1a2430, TIRE = 0x161616, LIGHT = 0xfff1c8, RED = 0x8a1010;
/** Indicators (unlit amber; lit by the simulation's bit): left = the model's +x (the heading turns from +z to +x). */
export const AMBER_L = 0xb8741a, AMBER_R = 0xb8741b;
export const glowOf = (col: number) => (col === LIGHT ? 1 : col === RED ? 2 : col === AMBER_L ? 3 : col === AMBER_R ? 4 : col === GLASS ? GLASS_GLOW : 0);
/** Glass (smooth, reflects the sky), exhaust puff, and the wheel parts (100 + 2 × part + front: tyre, hubcap, spoke). */
export const GLASS_GLOW = 5, PUFF = 7, WHEEL = 100;

/** Re-tags a geometry as a wheel part: its colour slot holds the wheel centre (the shader rolls and steers it). */
export function asWheelPart(g: THREE.BufferGeometry, part: number, front: boolean, cx: number, cy: number, cz: number): THREE.BufferGeometry {
  const n = g.attributes.position.count;
  const c = g.attributes.color.array as Float32Array, gl = g.attributes.glow.array as Float32Array;
  for (let i = 0; i < n; i++) { c[i * 3] = cx; c[i * 3 + 1] = cy; c[i * 3 + 2] = cz; gl[i] = WHEEL + part * 2 + (front ? 1 : 0); }
  return g;
}

/** A wheel (Roadcraft carBody: tyre, hubcap, five spokes): it rolls with the distance driven and the front ones steer. */
export function wheel(parts: THREE.BufferGeometry[], x: number, y: number, z: number, r: number, width: number, front: boolean): void {
  const side = Math.sign(x) || 1;
  const tyre = new THREE.CylinderGeometry(r, r, width, 12, 1, true); tyre.rotateZ(Math.PI / 2); tyre.translate(x, y, z);
  parts.push(asWheelPart(tagged(tyre, TIRE), 0, front, x, y, z));
  const wall = new THREE.RingGeometry(r * 0.62, r, 12); wall.rotateY(side > 0 ? Math.PI / 2 : -Math.PI / 2); wall.translate(x + side * width / 2, y, z);
  parts.push(asWheelPart(tagged(wall, TIRE), 0, front, x, y, z));
  const cap = new THREE.CircleGeometry(r * 0.62, 10); cap.rotateY(side > 0 ? Math.PI / 2 : -Math.PI / 2); cap.translate(x + side * (width / 2 - 0.01), y, z);
  parts.push(asWheelPart(tagged(cap, 0xb9bcbf), 1, front, x, y, z));
  for (let k = 0; k < 5; k++) {
    const sp = new THREE.BoxGeometry(0.012, r * 0.5, 0.05); sp.translate(0, r * 0.3, 0); sp.rotateX(k * Math.PI * 2 / 5); sp.translate(x + side * (width / 2 - 0.004), y, z);
    parts.push(asWheelPart(tagged(sp, 0x2a2b2d), 2, front, x, y, z));
  }
}

/** Exhaust puff: a little square at the tailpipe, billboarded and animated in the shader (anchor in the colour slot). */
export function puff(parts: THREE.BufferGeometry[], x: number, y: number, z: number): void {
  const q = new THREE.PlaneGeometry(0.36, 0.36); q.translate(x, y, z);
  const g = tagged(q, 0x9a9a98);
  const n = g.attributes.position.count, c = g.attributes.color.array as Float32Array, gl = g.attributes.glow.array as Float32Array;
  for (let i = 0; i < n; i++) { c[i * 3] = x; c[i * 3 + 1] = y; c[i * 3 + 2] = z; gl[i] = PUFF; }
  parts.push(g);
}
/**
 * Blob shadow (roadcraft `blobShadows`) for the vehicles beyond SHADOW_NEAR, which are not in the cascades: a dark
 * rectangle 3 cm above the road with a dithered edge (TRAA smooths it). `glow` = BLOB; the colour carries the corner.
 */
export const BLOB = 9;
export function withBlob(g: THREE.BufferGeometry, w: number, l: number): THREE.BufferGeometry {
  const q = new THREE.PlaneGeometry(w + 0.6, l + 0.9).rotateX(-Math.PI / 2).toNonIndexed();
  q.translate(0, 0.03, 0);
  q.deleteAttribute('uv');
  const n = q.attributes.position.count, pos = q.attributes.position.array;
  const c = new Float32Array(n * 3);
  // corner in −1..1 in the r and g channels (the shader fades from the middle to the edge)
  for (let i = 0; i < n; i++) { c[i * 3] = Math.sign(pos[i * 3]); c[i * 3 + 1] = Math.sign(pos[i * 3 + 2]); }
  q.setAttribute('color', new THREE.BufferAttribute(c, 3));
  q.setAttribute('paint', new THREE.BufferAttribute(new Float32Array(n), 1));
  q.setAttribute('glow', new THREE.BufferAttribute(new Float32Array(n).fill(BLOB), 1));
  q.setAttribute('limb', new THREE.BufferAttribute(new Float32Array(n), 1));
  return mergeGeometries([g.index ? g.toNonIndexed() : g, q])!;
}


/** A rider's parts (the motorbike's, the bicycle's): `glow` = OCC + seat, shown when the seat is within the load. */
export const OCC = 10;

/** Colour, paint and light attributes on a finished geometry (not indexed, to merge). */
export function tagged(g: THREE.BufferGeometry, col: number, limb = 0): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  out.deleteAttribute('uv');
  const n = out.attributes.position.count;
  const c = new Float32Array(n * 3), paint = new Float32Array(n), glow = new Float32Array(n);
  const color = new THREE.Color(col < 0 ? 0xffffff : col).convertSRGBToLinear();
  const gl = glowOf(col);
  for (let i = 0; i < n; i++) { c[i * 3] = color.r; c[i * 3 + 1] = color.g; c[i * 3 + 2] = color.b; paint[i] = col < 0 ? 1 : 0; glow[i] = gl; }
  out.setAttribute('color', new THREE.BufferAttribute(c, 3));
  out.setAttribute('paint', new THREE.BufferAttribute(paint, 1));
  out.setAttribute('glow', new THREE.BufferAttribute(glow, 1));
  out.setAttribute('limb', new THREE.BufferAttribute(new Float32Array(n).fill(limb), 1));
  return out;
}

/** Side profile (z forward, y up) extruded across the width, centred on x. */
export function profile(pts: Array<[number, number]>, width: number): THREE.BufferGeometry {
  const sh = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y)));
  // rounded edges as Roadcraft's extruded bodies (carBody.ts extrude with a bevel): the same overall size
  const bevel = 0.045;
  const g = new THREE.ExtrudeGeometry(sh, { depth: width - bevel * 2, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2, curveSegments: 1 });
  // the shape lies in the xy plane (x = forward); turned so x = side, z = forward
  g.translate(0, 0, -width / 2 + bevel);
  g.rotateY(-Math.PI / 2);
  return g;
}

/** Pedestrian: the same body as the creator's person (shoes, legs, torso and arms in the clothes' colour, hands, neck, head and hair). */
export function personModel(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const box = (x: number, y: number, z: number, w: number, h: number, l: number, col: number, limb = 0) => {
    const b = new THREE.BoxGeometry(w, h, l); b.translate(x, y + h / 2, z); parts.push(tagged(b, col, limb));
  };
  const ball = (x: number, y: number, z: number, r: number, sy: number, col: number, detail = 0, limb = 0) => {
    const b = new THREE.IcosahedronGeometry(r, detail); b.scale(1, sy, 1); b.translate(x, y, z); parts.push(tagged(b, col, limb));
  };
  // a truncated cone (7 sides) from y0 to y1, flattened in z; no caps where they are hidden
  const limbC = (x: number, y0: number, y1: number, rTop: number, rBot: number, sz: number, col: number, limb = 0, open = true) => {
    const c = new THREE.CylinderGeometry(rTop, rBot, y1 - y0, 7, 1, open); c.scale(1, 1, sz); c.translate(x, (y0 + y1) / 2, 0); parts.push(tagged(c, col, limb));
  };
  // shoes, legs narrowing to the ankle, hips
  box(-0.095, 0, 0.03, 0.11, 0.07, 0.24, 0x1b1b1b, 1); box(0.095, 0, 0.03, 0.11, 0.07, 0.24, 0x1b1b1b, 2);
  limbC(-0.095, 0.06, 0.84, 0.078, 0.052, 1, PANTS, 1); limbC(0.095, 0.06, 0.84, 0.078, 0.052, 1, PANTS, 2);
  limbC(0, 0.76, 0.93, 0.17, 0.165, 0.62, PANTS, 0, false);
  // torso wider at the shoulders, arms narrowing to the wrist, hands
  limbC(0, 0.9, 1.4, 0.205, 0.168, 0.58, -1, 0, false);
  limbC(-0.25, 0.83, 1.38, 0.058, 0.045, 1, -1, 3); limbC(0.25, 0.83, 1.38, 0.058, 0.045, 1, -1, 4);
  ball(-0.25, 0.79, 0, 0.05, 1.2, SKIN, 0, 3); ball(0.25, 0.79, 0, 0.05, 1.2, SKIN, 0, 4);
  // neck, head and hair
  limbC(0, 1.37, 1.46, 0.048, 0.052, 1, SKIN);
  ball(0, 1.56, 0, 0.115, 1.12, SKIN, 1);
  ball(0, 1.615, -0.02, 0.122, 0.82, HAIR, 1);
  return mergeGeometries(parts)!;
}

/**
 * The simulation's car styles 0-4 (sedan, hatchback, SUV, van, pickup) as roadcraft 4.0 builds them (render/carBody.ts,
 * sizes from sim/vehicles/archetypes.ts; lengths kept at the simulation's), metres.
 */
export const CAR_BODIES: Array<[CarStyle, CarArchetype]> = [
  ['sedan', CAR_SIZES.sedan], ['hatch', CAR_SIZES.hatch], ['suv', CAR_SIZES.suv], ['van', CAR_SIZES.van], ['pickup', CAR_SIZES.pickup],
];

/**
 * A 4.0 car geometry (x forward, z right, vertex colours white where painted) in this renderer's frame and attributes:
 * turned so z is forward and +x the driver's left, the paint flag where it was white, `glow` for the whole part.
 */
export function fromBody(g: THREE.BufferGeometry, glow: number): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  out.rotateY(-Math.PI / 2);
  for (const k of Object.keys(out.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'color') out.deleteAttribute(k);
  if (!out.getAttribute('normal')) out.computeVertexNormals();
  const n = out.attributes.position.count;
  const src = out.getAttribute('color') as THREE.BufferAttribute | undefined;
  const c = new Float32Array(n * 3), paint = new Float32Array(n), gl = new Float32Array(n).fill(glow);
  const tmp = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const r = src ? src.getX(i) : 1, gg = src ? src.getY(i) : 1, b = src ? src.getZ(i) : 1;
    const white = r > 0.99 && gg > 0.99 && b > 0.99;
    tmp.setRGB(r, gg, b);
    c[i * 3] = tmp.r; c[i * 3 + 1] = tmp.g; c[i * 3 + 2] = tmp.b;
    paint[i] = white && glow === 0 ? 1 : 0;
  }
  out.setAttribute('color', new THREE.BufferAttribute(c, 3));
  out.setAttribute('paint', new THREE.BufferAttribute(paint, 1));
  out.setAttribute('glow', new THREE.BufferAttribute(gl, 1));
  out.setAttribute('limb', new THREE.BufferAttribute(new Float32Array(n), 1));
  return out;
}

/** A 4.0 lamp box (x forward, z right) in this frame, lit as `col` (headlight, tail light, indicator, plate). */
export function lampBox(parts: THREE.BufferGeometry[], l: Lamp, col: number): void {
  // a car's lamp shaped to its body (carBody.ts lampFace), turned into this frame as `fromBody` turns the body
  if (l.face) { parts.push(tagged(l.face.clone().rotateY(-Math.PI / 2), col)); return; }
  const b = new THREE.BoxGeometry(l.sz, l.sy, l.sx);
  b.translate(-l.z, l.y, l.x);
  parts.push(tagged(b, col));
}

/**
 * Passenger car near the camera: roadcraft 4.0's body (carBody.ts buildCarModel: lofted shell, glass, frames and
 * pillars, arch liners, grille, handles, mirrors), its lamps and plates, and the wheels that roll and steer. No figure
 * in or at the windows: the cooked people sit inside when the cabin is drawn (render/people).
 */
export function carModel(i: number): THREE.BufferGeometry {
  const [style, a] = CAR_BODIES[i];
  const body = buildCarBody(a, style, 24, 8, 3);
  const parts: THREE.BufferGeometry[] = [fromBody(body.shell, 0), fromBody(body.glass, GLASS_GLOW), fromBody(body.trim, 0)];
  // the glass's own colour (vertex colours were white: the glass region)
  const gc = parts[1].getAttribute('color').array as Float32Array, glassC = new THREE.Color(GLASS).convertSRGBToLinear();
  for (let k = 0; k < gc.length; k += 3) { gc[k] = glassC.r; gc[k + 1] = glassC.g; gc[k + 2] = glassC.b; }
  for (const l of body.headlamps) lampBox(parts, l, LIGHT);
  for (const l of body.taillamps) lampBox(parts, l, RED);
  for (const l of body.indicators) lampBox(parts, l, l.side < 0 ? AMBER_L : AMBER_R);
  for (const l of body.plates) lampBox(parts, l, 0xe9e9e2);
  const r = a.wheelRadius, half = a.width / 2 - 0.14;
  for (const ax of body.axles) for (const x of [half, -half]) wheel(parts, x, r, ax, r, 0.22, ax > 0);
  puff(parts, a.width * 0.28, 0.28, -a.length / 2 - 0.2);
  return mergeGeometries(parts)!;
}

/** The cabin the near car's glass shows into (carBody.ts buildCarCabin): seats, dash, wheel, trims; never painted. */
export function carCabin(i: number): THREE.BufferGeometry {
  const [style, a] = CAR_BODIES[i];
  return fromBody(buildCarCabin(a, style as Exclude<CarStyle, 'wagon'>), 0);
}

/** The same car for the middle distance: the style's silhouette (carBody.ts buildCarSilhouette) and dark wheels. */
export function carMidModel(i: number): THREE.BufferGeometry {
  const [style, a] = CAR_BODIES[i];
  const parts: THREE.BufferGeometry[] = [fromBody(buildCarSilhouette(a, style), 0)];
  const r = a.wheelRadius;
  for (const ax of [a.length * 0.31, -a.length * 0.31]) for (const x of [a.width / 2 - 0.14, -a.width / 2 + 0.14]) {
    const t = new THREE.CylinderGeometry(r, r, 0.22, 8, 1, false); t.rotateZ(Math.PI / 2); t.translate(x, r, ax); parts.push(tagged(t, TIRE));
  }
  return mergeGeometries(parts)!;
}

/** Motorbike with its rider (helmet in the bike's colour), 2.1 m. */
export function motoModel(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [tagged(profile([[0.95, 0.42], [0.88, 0.78], [0.35, 0.86], [-0.25, 0.9], [-0.9, 0.82], [-0.98, 0.5], [-0.3, 0.4]], 0.3), -1)];
  const box = (x: number, y: number, z: number, w: number, h: number, l: number, col: number) => {
    const b = new THREE.BoxGeometry(w, h, l); b.translate(x, y + h / 2, z); parts.push(tagged(b, col));
  };
  for (const z of [0.72, -0.72]) wheel(parts, 0.06, 0.31, z, 0.31, 0.12, z > 0);
  box(0, 0.86, 0.72, 0.62, 0.04, 0.04, 0x2a2b2d); // handlebar
  box(0, 0.74, 0.97, 0.14, 0.1, 0.03, LIGHT); box(0, 0.76, -0.99, 0.12, 0.08, 0.03, RED);
  box(0.17, 0.78, 0.94, 0.05, 0.05, 0.03, AMBER_L); box(-0.17, 0.78, 0.94, 0.05, 0.05, 0.03, AMBER_R);
  box(0.17, 0.7, -0.97, 0.05, 0.05, 0.03, AMBER_L); box(-0.17, 0.7, -0.97, 0.05, 0.05, 0.03, AMBER_R);
  // rider (only without the cooked people, src/render/people): occupant seat 1
  const rider = parts.length;
  box(0.15, 0.5, 0.05, 0.12, 0.42, 0.3, 0x24262c); box(-0.15, 0.5, 0.05, 0.12, 0.42, 0.3, 0x24262c);
  const t = new THREE.BoxGeometry(0.4, 0.62, 0.24); t.rotateX(0.32); t.translate(0, 1.22, 0.02); parts.push(tagged(t, 0x30343c));
  box(0.22, 1.12, 0.42, 0.09, 0.09, 0.42, 0x30343c); box(-0.22, 1.12, 0.42, 0.09, 0.09, 0.42, 0x30343c);
  const h = new THREE.IcosahedronGeometry(0.15, 1); h.translate(0, 1.66, 0.12); parts.push(tagged(h, -1));
  for (let i = rider; i < parts.length; i++) (parts[i].getAttribute('glow').array as Float32Array).fill(OCC + 1);
  return mergeGeometries(parts)!;
}

/** Bicycle with its rider (1.8 m): thin wheels, frame, handlebar, the rider bent forward and a helmet in the colour. */
export function bikeModel(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const box = (x: number, y: number, z: number, w: number, h: number, l: number, col: number) => {
    const b = new THREE.BoxGeometry(w, h, l); b.translate(x, y + h / 2, z); parts.push(tagged(b, col));
  };
  // wheels: tyre and three spokes, marked as wheel parts so the shader rolls them with the distance ridden
  for (const z of [0.55, -0.55]) {
    const w = new THREE.TorusGeometry(0.33, 0.025, 4, 14); w.rotateY(Math.PI / 2); w.translate(0, 0.35, z);
    parts.push(asWheelPart(tagged(w, TIRE), 0, false, 0, 0.35, z));
    for (let k = 0; k < 3; k++) {
      const sp = new THREE.BoxGeometry(0.012, 0.62, 0.012); sp.rotateX(k * Math.PI / 3); sp.translate(0, 0.35, z);
      parts.push(asWheelPart(tagged(sp, 0x9a9da0), 2, false, 0, 0.35, z));
    }
  }
  const bar = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r: number, col: number) => {
    const L = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(x1 - x0, y1 - y0, z1 - z0).normalize());
    const h = new THREE.CylinderGeometry(r, r, L, 5, 1, true); h.applyQuaternion(q); h.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    parts.push(tagged(h, col));
  };
  // frame (painted), handlebar, saddle
  bar(0, 0.35, -0.55, 0, 0.75, -0.12, 0.022, -1); bar(0, 0.35, -0.55, 0, 0.4, 0.05, 0.022, -1);
  bar(0, 0.4, 0.05, 0, 0.75, -0.12, 0.022, -1); bar(0, 0.75, -0.12, 0, 0.82, 0.42, 0.022, -1); bar(0, 0.35, 0.55, 0, 0.92, 0.42, 0.02, 0x2a2b2d);
  box(0, 0.92, 0.38, 0.5, 0.03, 0.04, 0x2a2b2d); box(0, 0.8, -0.16, 0.12, 0.05, 0.24, 0x1b1b1b);
  // rider (only without the cooked people, src/render/people): occupant seat 1, shown by the colour
  const rider = parts.length;
  box(0.11, 0.42, -0.08, 0.1, 0.42, 0.14, 0x2c3140); box(-0.11, 0.42, 0.02, 0.1, 0.42, 0.14, 0x2c3140);
  const t = new THREE.BoxGeometry(0.34, 0.55, 0.22); t.rotateX(0.55); t.translate(0, 1.12, 0.02); parts.push(tagged(t, 0x56677a));
  box(0.17, 1.06, 0.26, 0.07, 0.07, 0.36, 0x56677a); box(-0.17, 1.06, 0.26, 0.07, 0.07, 0.36, 0x56677a);
  const head = new THREE.IcosahedronGeometry(0.12, 1); head.translate(0, 1.5, 0.22); parts.push(tagged(head, -1));
  for (let i = rider; i < parts.length; i++) (parts[i].getAttribute('glow').array as Float32Array).fill(OCC + 1);
  return mergeGeometries(parts)!;
}

/** Bus and lorry classes (4.0 sim/vehicles/archetypes.ts; the lorry's length is the simulation's), metres. */
export const BUS_A: HeavyArchetype = { length: 12, width: 2.55, height: 3.2, wheelRadius: 0.5, cabinFraction: 0.98 };
export const TRUCK_A: HeavyArchetype = { length: 9.5, width: 2.5, height: 3.5, wheelRadius: 0.52, cabinFraction: 0.24 };

/**
 * A 4.0 bus or lorry (heavyBody.ts) in this renderer's frame: shell in the paint (a bus in its line's colour), glass,
 * trim, the lorry's box in its own pale grey, lamps, plates (the bus's destination blind lit like a lamp), wheels.
 */
export function heavyModel(b: HeavyBody, a: HeavyArchetype): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [fromBody(b.shell, 0), fromBody(b.glass, GLASS_GLOW), fromBody(b.trim, 0)];
  const gc = parts[1].getAttribute('color').array as Float32Array, glassC = new THREE.Color(GLASS).convertSRGBToLinear();
  for (let k = 0; k < gc.length; k += 3) { gc[k] = glassC.r; gc[k + 1] = glassC.g; gc[k + 2] = glassC.b; }
  // the trim keeps its colours: never the paint
  (parts[2].getAttribute('paint').array as Float32Array).fill(0);
  if (b.accent) {
    const acc = fromBody(b.accent, 0);
    (acc.getAttribute('paint').array as Float32Array).fill(0);
    const ac = acc.getAttribute('color').array as Float32Array, box = new THREE.Color(0xd9d6cf).convertSRGBToLinear();
    for (let k = 0; k < ac.length; k += 3) if (ac[k] > 0.9) { ac[k] = box.r; ac[k + 1] = box.g; ac[k + 2] = box.b; }
    parts.push(acc);
  }
  for (const l of b.headlamps) lampBox(parts, l, LIGHT);
  for (const l of b.taillamps) lampBox(parts, l, RED);
  for (const l of b.indicators) lampBox(parts, l, l.side < 0 ? AMBER_L : AMBER_R);
  b.plates.forEach((l, i) => lampBox(parts, l, i === 2 ? LIGHT : 0xe9e9e2));
  const r = a.wheelRadius, half = a.width / 2 - 0.2;
  b.axles.forEach((ax, i) => { for (const x of [half, -half]) wheel(parts, x, r, ax, r, 0.32, i === 0); });
  puff(parts, a.width * 0.32, 0.38, -a.length / 2 - 0.2);
  return mergeGeometries(parts)!;
}

/** Bus (4.0 buildBusModel), its outside: no figures at the windows. */
export function busModel(): THREE.BufferGeometry { return heavyModel(buildBusBody(BUS_A), BUS_A); }

/** Lorry (4.0 buildTruckModel), its outside. */
export function truckModel(): THREE.BufferGeometry { return heavyModel(buildTruckBody(TRUCK_A), TRUCK_A); }

export const SKIN = 0xc89a78, PANTS = 0x2c3140, HAIR = 0x2a1f18;
/** Train/metro wagon (20 m): a box painted in the line's colour, a band of windows, roof, bogies. */
export const WAGON: Part[] = [
  [0, 0.9, 0, 2.9, 2.9, 19.6, 0xd8dadc],
  [0, 1.05, 0, 2.94, 0.5, 19.7, -1], // band in the line's colour
  [0, 2.0, 0, 2.95, 1.0, 18.4, GLASS],
  [0, 3.8, 0, 2.6, 0.25, 18.8, 0x9aa0a4],
  [0, 0.3, 6.5, 2.4, 0.65, 2.6, 0x2a2b2d], [0, 0.3, -6.5, 2.4, 0.65, 2.6, 0x2a2b2d], // truques
  [0, 1.4, 9.82, 2.2, 1.6, 0.04, GLASS], [0, 0.95, 9.84, 1.6, 0.18, 0.02, LIGHT],
];
/** Unit box for the middle level (scaled per instance). */
export const BOX: Part[] = [[0, 0, 0, 1, 1, 1, -1]];
export const KIND_DIMS: Array<[number, number, number]> = [[1.8, 1.45, 4.4], [2.5, 3.0, 12], [2.5, 3.3, 9.5], [0.45, 1.7, 0.3], [2.95, 4.0, 19.8],
  // car styles 1-5 (hatchback, SUV, van, pickup, motorbike): boxes 5-9
  [1.74, 1.45, 3.9], [1.88, 1.72, 4.6], [1.92, 1.97, 4.9], [1.88, 1.74, 5.3], [0.7, 1.6, 2.1],
  // bicicleta (10)
  [0.6, 1.75, 1.8]];
/** Index of the detailed model: car styles 0-5, bus 6, truck 7, person 8, wagon 9, bicycle 10. */
export const modelOf = (kind: number, style: number) => (kind === 0 ? style : kind + 5);
export const dimsOf = (kind: number, style: number) => (kind === 0 && style > 0 ? 4 + style : kind === 5 ? 10 : kind);

/**
 * Splits a merged vehicle model into its opaque body and its glass, by the `glow` attribute. The glass gets a
 * transparent material (the cabin's people read through it); the body stays a single opaque draw.
 */
export function splitGlass(g: THREE.BufferGeometry): { solid: THREE.BufferGeometry; glass: THREE.BufferGeometry | null } {
  const glow = g.getAttribute('glow');
  const index = g.index ? Array.from(g.index.array as ArrayLike<number>) : null;
  const count = glow ? glow.count : g.getAttribute('position').count;
  const tri = (g.index ? g.index.count : count) / 3;
  const solid: number[] = [], glass: number[] = [];
  for (let t = 0; t < tri; t++) {
    const a = index ? index[t * 3] : t * 3, b = index ? index[t * 3 + 1] : a + 1, c = index ? index[t * 3 + 2] : a + 2;
    (glow && Math.abs(glow.getX(a) - GLASS_GLOW) < 0.01 ? glass : solid).push(a, b, c);
  }
  const pick = (indices: number[]): THREE.BufferGeometry => {
    const out = new THREE.BufferGeometry();
    for (const [name, src] of Object.entries(g.attributes)) {
      const item = src.itemSize, data = new Float32Array(indices.length * item);
      for (let k = 0; k < indices.length; k++) for (let j = 0; j < item; j++) data[k * item + j] = src.getComponent(indices[k], j);
      out.setAttribute(name, new THREE.BufferAttribute(data, item, src.normalized));
    }
    return out;
  };
  return { solid: pick(solid), glass: glass.length ? pick(glass) : null };
}

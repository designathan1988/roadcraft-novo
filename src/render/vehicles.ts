// Cars, buses, trucks and people on screen. The poses come from the simulation worker (triple buffer); here they are
// only interpolated, culled and given their level: near, models with cabins and wheels; in the middle, boxes; far,
// "density cars" painted in the roads' shader (see roads.ts).
// Four draw calls for the whole fleet.

import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { POSE_STRIDE, TILE, TILE_GRID, TILES, type PoseReader } from '../shared/contracts/poses.ts';
import { PAINTS } from '../shared/vehiclePaints.ts';
import { T, withPrevious, type Node } from './tsl.ts';
import { nightU } from './scene.ts';
import { rainU } from './weather.ts';
import { PeopleRenderer } from './people/crowd.ts';
import { CAR_SIZES, buildCarBody, buildCarCabin, buildCarSilhouette, type CarArchetype, type CarStyle, type Lamp } from './carBody.ts';
import { buildBusBody, buildTruckBody, type HeavyArchetype, type HeavyBody } from './heavyBody.ts';

const {
  attribute, vec2, vec3, vec4, float, abs, cos, sin, mix, transformNormalToView, normalize,
  interleavedGradientNoise, screenCoordinate, uniformArray, int, floor, sRGBTransferEOTF, max, step, select, mod, time, smoothstep,
  cameraViewMatrix, fract, hash, clamp, atan, length,
} = T;

const NEAR = 200;
const MID = 1700;
const CAP_NEAR = 6000;
const CAP_MID = 30000;

/** Parts: [x, y, z, width, height, length, fixed colour or -1 = paint]. */
type Part = [number, number, number, number, number, number, number];

function model(parts: Part[]): THREE.BufferGeometry {
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

const GLASS = 0x1a2430, TIRE = 0x161616, LIGHT = 0xfff1c8, RED = 0x8a1010;
/** Indicators (unlit amber; lit by the simulation's bit): left = the model's +x (the heading turns from +z to +x). */
const AMBER_L = 0xb8741a, AMBER_R = 0xb8741b;
const glowOf = (col: number) => (col === LIGHT ? 1 : col === RED ? 2 : col === AMBER_L ? 3 : col === AMBER_R ? 4 : col === GLASS ? GLASS_GLOW : 0);
/** Glass (smooth, reflects the sky), exhaust puff, and the wheel parts (100 + 2 × part + front: tyre, hubcap, spoke). */
const GLASS_GLOW = 5, PUFF = 7, WHEEL = 100;

/** Re-tags a geometry as a wheel part: its colour slot holds the wheel centre (the shader rolls and steers it). */
function asWheelPart(g: THREE.BufferGeometry, part: number, front: boolean, cx: number, cy: number, cz: number): THREE.BufferGeometry {
  const n = g.attributes.position.count;
  const c = g.attributes.color.array as Float32Array, gl = g.attributes.glow.array as Float32Array;
  for (let i = 0; i < n; i++) { c[i * 3] = cx; c[i * 3 + 1] = cy; c[i * 3 + 2] = cz; gl[i] = WHEEL + part * 2 + (front ? 1 : 0); }
  return g;
}

/** A wheel (Roadcraft carBody: tyre, hubcap, five spokes): it rolls with the distance driven and the front ones steer. */
function wheel(parts: THREE.BufferGeometry[], x: number, y: number, z: number, r: number, width: number, front: boolean): void {
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
function puff(parts: THREE.BufferGeometry[], x: number, y: number, z: number): void {
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
const BLOB = 9;
function withBlob(g: THREE.BufferGeometry, w: number, l: number): THREE.BufferGeometry {
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
const OCC = 10;

/** Colour, paint and light attributes on a finished geometry (not indexed, to merge). */
function tagged(g: THREE.BufferGeometry, col: number, limb = 0): THREE.BufferGeometry {
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
function profile(pts: Array<[number, number]>, width: number): THREE.BufferGeometry {
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
function personModel(): THREE.BufferGeometry {
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
const CAR_BODIES: Array<[CarStyle, CarArchetype]> = [
  ['sedan', CAR_SIZES.sedan], ['hatch', CAR_SIZES.hatch], ['suv', CAR_SIZES.suv], ['van', CAR_SIZES.van], ['pickup', CAR_SIZES.pickup],
];

/**
 * A 4.0 car geometry (x forward, z right, vertex colours white where painted) in this renderer's frame and attributes:
 * turned so z is forward and +x the driver's left, the paint flag where it was white, `glow` for the whole part.
 */
function fromBody(g: THREE.BufferGeometry, glow: number): THREE.BufferGeometry {
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
function lampBox(parts: THREE.BufferGeometry[], l: Lamp, col: number): void {
  const b = new THREE.BoxGeometry(l.sz, l.sy, l.sx);
  b.translate(-l.z, l.y, l.x);
  parts.push(tagged(b, col));
}

/**
 * Passenger car near the camera: roadcraft 4.0's body (carBody.ts buildCarModel: lofted shell, glass, frames and
 * pillars, arch liners, grille, handles, mirrors), its lamps and plates, and the wheels that roll and steer. No figure
 * in or at the windows: the cooked people sit inside when the cabin is drawn (render/people).
 */
function carModel(i: number): THREE.BufferGeometry {
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
function carCabin(i: number): THREE.BufferGeometry {
  const [style, a] = CAR_BODIES[i];
  return fromBody(buildCarCabin(a, style as Exclude<CarStyle, 'wagon'>), 0);
}

/** The same car for the middle distance: the style's silhouette (carBody.ts buildCarSilhouette) and dark wheels. */
function carMidModel(i: number): THREE.BufferGeometry {
  const [style, a] = CAR_BODIES[i];
  const parts: THREE.BufferGeometry[] = [fromBody(buildCarSilhouette(a, style), 0)];
  const r = a.wheelRadius;
  for (const ax of [a.length * 0.31, -a.length * 0.31]) for (const x of [a.width / 2 - 0.14, -a.width / 2 + 0.14]) {
    const t = new THREE.CylinderGeometry(r, r, 0.22, 8, 1, false); t.rotateZ(Math.PI / 2); t.translate(x, r, ax); parts.push(tagged(t, TIRE));
  }
  return mergeGeometries(parts)!;
}

/** Motorbike with its rider (helmet in the bike's colour), 2.1 m. */
function motoModel(): THREE.BufferGeometry {
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
const BUS_A: HeavyArchetype = { length: 12, width: 2.55, height: 3.2, wheelRadius: 0.5, cabinFraction: 0.98 };
const TRUCK_A: HeavyArchetype = { length: 9.5, width: 2.5, height: 3.5, wheelRadius: 0.52, cabinFraction: 0.24 };

/**
 * A 4.0 bus or lorry (heavyBody.ts) in this renderer's frame: shell in the paint (a bus in its line's colour), glass,
 * trim, the lorry's box in its own pale grey, lamps, plates (the bus's destination blind lit like a lamp), wheels.
 */
function heavyModel(b: HeavyBody, a: HeavyArchetype): THREE.BufferGeometry {
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
function busModel(): THREE.BufferGeometry { return heavyModel(buildBusBody(BUS_A), BUS_A); }

/** Lorry (4.0 buildTruckModel), its outside. */
function truckModel(): THREE.BufferGeometry { return heavyModel(buildTruckBody(TRUCK_A), TRUCK_A); }

const SKIN = 0xc89a78, PANTS = 0x2c3140, HAIR = 0x2a1f18;
/** Train/metro wagon (20 m): a box painted in the line's colour, a band of windows, roof, bogies. */
const WAGON: Part[] = [
  [0, 0.9, 0, 2.9, 2.9, 19.6, 0xd8dadc],
  [0, 1.05, 0, 2.94, 0.5, 19.7, -1], // band in the line's colour
  [0, 2.0, 0, 2.95, 1.0, 18.4, GLASS],
  [0, 3.8, 0, 2.6, 0.25, 18.8, 0x9aa0a4],
  [0, 0.3, 6.5, 2.4, 0.65, 2.6, 0x2a2b2d], [0, 0.3, -6.5, 2.4, 0.65, 2.6, 0x2a2b2d], // truques
  [0, 1.4, 9.82, 2.2, 1.6, 0.04, GLASS], [0, 0.95, 9.84, 1.6, 0.18, 0.02, LIGHT],
];
/** Unit box for the middle level (scaled per instance). */
const BOX: Part[] = [[0, 0, 0, 1, 1, 1, -1]];
const KIND_DIMS: Array<[number, number, number]> = [[1.8, 1.45, 4.4], [2.5, 3.0, 12], [2.5, 3.3, 9.5], [0.45, 1.7, 0.3], [2.95, 4.0, 19.8],
  // car styles 1-5 (hatchback, SUV, van, pickup, motorbike): boxes 5-9
  [1.74, 1.45, 3.9], [1.88, 1.72, 4.6], [1.92, 1.97, 4.9], [1.88, 1.74, 5.3], [0.7, 1.6, 2.1],
  // bicicleta (10)
  [0.6, 1.75, 1.8]];
/** Index of the detailed model: car styles 0-5, bus 6, truck 7, person 8, wagon 9, bicycle 10. */
const modelOf = (kind: number, style: number) => (kind === 0 ? style : kind + 5);
const dimsOf = (kind: number, style: number) => (kind === 0 && style > 0 ? 4 + style : kind === 5 ? 10 : kind);

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
/** People: the model up to here, a box up to PERSON_MID. */
const PERSON_NEAR = 70;
/** Detailed vehicles cast shadows only up to here; beyond, the same model without (the shadow fades with distance). */
const SHADOW_NEAR = 90;
const PERSON_MID = 480;

class Batch {
  readonly mesh: THREE.Mesh;
  readonly pos: Float32Array;
  readonly info: Float32Array;
  /** The previous frame's pose (TRAA velocity: without it a moving car smears and shakes). */
  readonly prev: Float32Array;
  private posAttr: THREE.InstancedBufferAttribute;
  private prevAttr: THREE.InstancedBufferAttribute;
  private infoAttr: THREE.InstancedBufferAttribute;
  private geo: THREE.InstancedBufferGeometry;
  count = 0;
  readonly cap: number;

  constructor(base: THREE.BufferGeometry, cap: number, scaled: boolean, shadows = true, animated = false, glass = false) {
    this.cap = cap;
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    for (const k of Object.keys(base.attributes)) g.setAttribute(k, base.attributes[k]);
    this.pos = new Float32Array(cap * 4);
    this.info = new Float32Array(cap * 4);
    this.prev = new Float32Array(cap * 4);
    this.prevAttr = new THREE.InstancedBufferAttribute(this.prev, 4).setUsage(THREE.DynamicDrawUsage) as THREE.InstancedBufferAttribute;
    // people: the limbs already take the 8th vertex buffer (WebGPU's limit); at 1.4 m/s the current pose is enough
    if (!animated) g.setAttribute('iprev', this.prevAttr);
    this.posAttr = new THREE.InstancedBufferAttribute(this.pos, 4).setUsage(THREE.DynamicDrawUsage) as THREE.InstancedBufferAttribute;
    this.infoAttr = new THREE.InstancedBufferAttribute(this.info, 4).setUsage(THREE.DynamicDrawUsage) as THREE.InstancedBufferAttribute;
    g.setAttribute('ipos', this.posAttr);
    g.setAttribute('iinfo', this.infoAttr);
    g.instanceCount = 0;
    this.geo = g;
    // one material per combination (plain, box, person, glass) for every batch: each extra material is one more shader
    // to build and compile at load (19 batches were 19 materials and the city opened 1.5 s slower)
    const key = (scaled ? 1 : 0) + (animated ? 2 : 0) + (glass ? 4 : 0);
    this.mesh = new THREE.Mesh(g, MATERIALS[key] ??= glass ? vehicleGlassMaterial() : vehicleMaterial(scaled, animated));
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = shadows;
    this.mesh.receiveShadow = true;
  }

  /** `lod`: near/middle cross over by complementary masks (near: noise < lod; middle: lod = −1 − f, noise ≥ f), so
   *  the model and the box never fight over the same pixel. */
  push(x: number, y: number, z: number, yaw: number, color: number, alpha: number, kind: number, lod = 1, px = x, py = y, pz = z, pyaw = yaw): void {
    if (this.count >= this.cap) return;
    const o = this.count * 4;
    this.pos[o] = x; this.pos[o + 1] = y; this.pos[o + 2] = z; this.pos[o + 3] = yaw;
    this.prev[o] = px; this.prev[o + 1] = py; this.prev[o + 2] = pz; this.prev[o + 3] = pyaw;
    this.info[o] = color; this.info[o + 1] = alpha; this.info[o + 2] = kind; this.info[o + 3] = lod;
    this.count++;
  }

  commit(): void {
    this.geo.instanceCount = this.count;
    this.posAttr.clearUpdateRanges(); this.posAttr.addUpdateRange(0, this.count * 4); this.posAttr.needsUpdate = true;
    this.infoAttr.clearUpdateRanges(); this.infoAttr.addUpdateRange(0, this.count * 4); this.infoAttr.needsUpdate = true;
    this.prevAttr.clearUpdateRanges(); this.prevAttr.addUpdateRange(0, this.count * 4); this.prevAttr.needsUpdate = true;
  }
}

const MATERIALS: Array<THREE.MeshStandardNodeMaterial | undefined> = [];

function vehicleMaterial(scaled: boolean, animated: boolean): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  const ipos = attribute('ipos', 'vec4');
  const info = attribute('iinfo', 'vec4');
  const iprev = animated ? null : attribute('iprev', 'vec4');
  const rotBy = (yaw: Node) => {
    const c = cos(yaw), s = sin(yaw);
    return (p: Node) => vec3(p.x.mul(c).add(p.z.mul(s)), p.y, p.x.negate().mul(s).add(p.z.mul(c)));
  };
  const rot = rotBy(ipos.w);
  let local: Node = attribute('position', 'vec3');
  let nrm: Node = attribute('normal', 'vec3');
  if (animated) {
    // people only: legs and arms swing (cars and buses do not pay for it)
    const limb = attribute('limb', 'float');
    const isLimb = step(float(0.5), limb);
    const isArm = step(float(2.5), limb);
    const side = select(mod(limb, 2).greaterThan(0.5), float(1), float(-1));
    // stride: ~1.9 steps a second, phase by position (each person in their own rhythm)
    const phase = time.mul(6).add(ipos.x.mul(0.71)).add(ipos.z.mul(0.53));
    const ang = sin(phase).mul(select(isArm.greaterThan(0.5), float(0.45), float(0.5))).mul(side).mul(select(isArm.greaterThan(0.5), float(-1), float(1))).mul(isLimb);
    const pivot = select(isArm.greaterThan(0.5), float(1.36), float(0.83));
    const ca = cos(ang), sa = sin(ang);
    const dy = local.y.sub(pivot);
    local = vec3(local.x, pivot.add(dy.mul(ca)).sub(local.z.mul(sa)), dy.mul(sa).add(local.z.mul(ca)));
    nrm = vec3(nrm.x, nrm.y.mul(ca).sub(nrm.z.mul(sa)), nrm.y.mul(sa).add(nrm.z.mul(ca)));
  }
  if (scaled) {
    // unit box standing on the ground, scaled by kind
    const k = int(info.z.add(0.5));
    const dims = uniformArray(KIND_DIMS.map((d) => new THREE.Vector3(...d)), 'vec3');
    local = local.add(vec3(0, 0.5, 0)).mul(dims.element(k));
  }
  const glowV = attribute('glow', 'float');
  let world: Node = rot(local).add(ipos.xyz);
  let puffShow: Node = float(1).greaterThan(0);
  if (!animated) {
    // wheels roll by the distance driven along the heading and the front ones steer by the turn rate (curvature ×
    // wheelbase from this frame's and last frame's pose), round their own centre (kept in the colour slot)
    const isWheel = step(float(WHEEL - 0.5), glowV);
    const front = mod(glowV.sub(WHEEL), 2).mul(isWheel);
    const centre = attribute('color', 'vec3');
    const r = max(centre.y, float(0.1));
    const travelled = ipos.x.mul(sin(ipos.w)).add(ipos.z.mul(cos(ipos.w)));
    const a = travelled.div(r).mul(isWheel);
    let dyaw: Node = ipos.w.sub(iprev.w);
    dyaw = dyaw.sub(floor(dyaw.div(6.2832).add(0.5)).mul(6.2832));
    const moved = length(ipos.xz.sub(iprev.xz));
    // a bus (1) and a truck (2) turn their front wheels for their own wheelbase, not a car's 2.6 m
    const isBus = step(abs(info.z.sub(float(1))), float(0.1));
    const isTruck = step(abs(info.z.sub(float(2))), float(0.1));
    const wheelbase = mix(mix(float(2.6), float(5.0), isTruck), float(6.2), isBus);
    const steer = clamp(atan(dyaw.div(max(moved, float(0.05))).mul(wheelbase)), -0.55, 0.55).mul(step(float(0.02), moved)).mul(front);
    const ca = cos(a), sa = sin(a), cs = cos(steer), ss = sin(steer);
    const roll = (v: Node) => vec3(v.x, v.y.mul(ca).sub(v.z.mul(sa)), v.y.mul(sa).add(v.z.mul(ca)));
    const turn = (v: Node) => vec3(v.x.mul(cs).add(v.z.mul(ss)), v.y, v.x.negate().mul(ss).add(v.z.mul(cs)));
    const q = local.sub(centre);
    local = mix(local, centre.add(turn(roll(q))), isWheel);
    nrm = mix(nrm, turn(roll(nrm)), isWheel);
    world = rot(local).add(ipos.xyz);
    // exhaust puff: rises and drifts back from the tailpipe over ~1.3 s, growing and fading (dithered)
    const isPuff = step(abs(glowV.sub(PUFF)), float(0.5));
    const life = fract(time.mul(0.75).add(hash(ipos.x.mul(1.7).add(ipos.z.mul(3.1)))));
    const anchor = attribute('color', 'vec3');
    const rel = attribute('position', 'vec3').sub(anchor);
    const corner = rel.xy.mul(float(1).add(life.mul(2)));
    const camR = vec3(cameraViewMatrix.element(0).x, cameraViewMatrix.element(1).x, cameraViewMatrix.element(2).x);
    const camU = vec3(cameraViewMatrix.element(0).y, cameraViewMatrix.element(1).y, cameraViewMatrix.element(2).y);
    const puffPos = rot(anchor.add(vec3(0, life.mul(0.55), life.mul(-0.9)))).add(ipos.xyz).add(camR.mul(corner.x)).add(camU.mul(corner.y));
    world = mix(world, puffPos, isPuff);
    const r2 = clamp(length(rel.xy).div(0.18), 0, 1);
    puffShow = isPuff.lessThan(0.5).or(float(1).sub(life).mul(float(1).sub(r2)).mul(0.45).greaterThan(interleavedGradientNoise(screenCoordinate.xy.add(vec2(51, 17)))));
  }
  m.positionNode = world;
  withPrevious(m, animated ? undefined : rotBy(iprev.w)(local).add(iprev.xyz));
  m.normalNode = transformNormalToView(normalize(rot(nrm)));
  const palette = uniformArray(PAINTS.map((p) => new THREE.Color(p)), 'color');
  // info.x = colour (0-15) + 16 × the simulation's lights (1 brake, 2 left indicator, 4 right indicator)
  const code = floor(info.x.add(0.5));
  const paint = sRGBTransferEOTF(palette.element(int(mod(code, 16))));
  const lightBits = floor(code.div(16));
  // occupants: seats up to the load (bits 3-5 of the lights, 0-7 → 0-16 seats; a car = the driver only)
  const seatsOn = floor(lightBits.div(8)).mul(16 / 7);
  const glowA = attribute('glow', 'float');
  const seat = glowA.sub(OCC);
  const occOk = seat.lessThan(0.5).or(seat.greaterThan(16.5)).or(seat.lessThan(seatsOn.add(0.5)));
  // blob shadow: dark in the middle, fading at the edge (dithered by another noise)
  const isBlob = step(abs(glowA.sub(BLOB)), float(0.5));
  const blobR = attribute('color', 'vec3').xy.length().div(1.414);
  const blobOk = isBlob.lessThan(0.5).or(float(1).sub(smoothstep(float(0.35), float(1), blobR)).mul(0.85).greaterThan(interleavedGradientNoise(screenCoordinate.xy.add(vec2(7.0, 13.0)))));
  // wheel parts and puffs keep a centre in the colour slot: their colour is by part
  const wPart = floor(glowA.sub(WHEEL).div(2));
  const wheelC = select(wPart.lessThan(0.5), sRGBTransferEOTF(vec3(0.086, 0.086, 0.086)), select(wPart.lessThan(1.5), sRGBTransferEOTF(vec3(0.73, 0.74, 0.75)), sRGBTransferEOTF(vec3(0.16, 0.17, 0.18))));
  const isWheelF = step(float(WHEEL - 0.5), glowA);
  const isPuffF = step(abs(glowA.sub(PUFF)), float(0.5));
  const isGlass = step(abs(glowA.sub(GLASS_GLOW)), float(0.5));
  const surf = mix(mix(attribute('color', 'vec3'), paint, attribute('paint', 'float')), wheelC, isWheelF);
  m.colorNode = vec4(mix(mix(surf, vec3(0.015, 0.015, 0.02), isBlob), vec3(0.45, 0.45, 0.44), isPuffF), 1);
  // paint with a clear coat look, glass smooth (it shows the sky from the environment), the rest matte
  m.roughnessNode = mix(mix(float(0.28), float(0.62), attribute('paint', 'float').oneMinus()), float(0.05), isGlass).add(isPuffF);
  m.metalnessNode = attribute('paint', 'float').mul(0.3);
  if (!scaled) {
    const gl = attribute('glow', 'float');
    const on = max(nightU, rainU.mul(0.7));
    const isK = (k: number) => step(abs(gl.sub(k)), float(0.5));
    const brake = mod(lightBits, 2), left = mod(floor(lightBits.div(2)), 2), right = mod(floor(lightBits.div(4)), 2);
    // (the occupants' seats are above 9.5: no light)
    // indicators blink at 1.5 Hz; the brake lights the tail light by day too
    const blink = step(float(0), sin(time.mul(9.42)));
    const head = vec3(1, 0.93, 0.78).mul(6).mul(on).mul(isK(1));
    const tail = vec3(1, 0.05, 0.03).mul(max(on.mul(3.5), brake.mul(2.6))).mul(isK(2));
    const amber = vec3(1, 0.5, 0.06).mul(7).mul(blink).mul(isK(3).mul(left).add(isK(4).mul(right)));
    m.emissiveNode = head.add(tail).add(amber);
  }
  // appears and disappears by dithering (no transparency)
  const alpha = info.y, lod = info.w;
  const n = interleavedGradientNoise(screenCoordinate.xy);
  const lodOk = select(lod.greaterThanEqual(0), n.lessThan(lod), n.greaterThanEqual(lod.negate().sub(1)));
  // fading in/out with another noise (the level's noise would cut the same pixels in both)
  m.maskNode = lodOk.and(occOk).and(blobOk).and(puffShow).and(alpha.greaterThan(interleavedGradientNoise(screenCoordinate.xy.add(vec2(23.0, 41.0)))));
  return m;
}

/** The cabin glass: one transparent draw over the opaque body, so the seated people read through the panes. */
function vehicleGlassMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  m.transparent = true;
  m.opacity = 0.34;
  m.depthWrite = false;
  m.side = THREE.DoubleSide;
  m.forceSinglePass = true;
  m.roughness = 0.08;
  m.metalness = 0.05;
  const ipos = attribute('ipos', 'vec4'), iprev = attribute('iprev', 'vec4');
  const local = attribute('position', 'vec3'), nrm = attribute('normal', 'vec3');
  const rotBy = (yaw: Node) => {
    const c = cos(yaw), s = sin(yaw);
    return (p: Node) => vec3(p.x.mul(c).add(p.z.mul(s)), p.y, p.x.negate().mul(s).add(p.z.mul(c)));
  };
  const rot = rotBy(ipos.w);
  m.positionNode = rot(local).add(ipos.xyz);
  withPrevious(m, rotBy(iprev.w)(local).add(iprev.xyz));
  m.normalNode = transformNormalToView(normalize(rot(nrm)));
  m.colorNode = vec4(vec3(0.10, 0.17, 0.21), float(1));
  return m;
}

/** The pose at `o` is the followed vehicle: its own id (pose index 10) and kind and colour (light bits left out). */
export function followMatch(d: Float32Array, o: number, f: { info: number; id: number }): boolean {
  return d[o + 10] === f.id && d[o + 8] % 65536 === f.info;
}

export class VehicleRenderer {
  readonly group = new THREE.Group();
  private near: Batch[];
  /** Cabin glass for the near models: the opaque body is drawn by `near`, this transparent draw over it. */
  private nearGlass: Array<Batch | null> = [];
  /** Detailed cars, buses and trucks beyond SHADOW_NEAR: the same model, without a shadow. */
  private nearFar: Batch[];
  private mid: Batch;
  /** Cars in the middle distance, by style (their silhouette). */
  private midCars: Batch[];
  private reader: PoseReader;
  private frustum = new THREE.Frustum();
  private pv = new THREE.Matrix4();
  private sphere = new THREE.Sphere(new THREE.Vector3(), 7);
  private tileBox = new THREE.Box3();
  /** Cooked pedestrians and cyclists (src/render/people); until they load, the simple figures. */
  readonly people = new PeopleRenderer();

  constructor(reader: PoseReader) {
    this.reader = reader;
    // one model per car style (the same material: one more call per style on screen). The near models are split into
    // an opaque body and a transparent glass; the far ones keep the merged model (glass there is a dark pane).
    const fullCars = [...CAR_BODIES.map((_, i) => carModel(i)), motoModel()];
    const splitCars = fullCars.map(splitGlass);
    // the near cars' glass is see-through: their cabin goes in with the body (the farther levels' glass is opaque)
    const cars = splitCars.map((s, i) => (i < CAR_BODIES.length ? mergeGeometries([s.solid, carCabin(i)])! : s.solid));
    const fullBus = busModel(), fullTruck = truckModel();
    const splitBus = splitGlass(fullBus), splitTruck = splitGlass(fullTruck);
    const bus = splitBus.solid, truck = splitTruck.solid;
    const carCap = (i: number) => (i < 2 ? CAP_NEAR : CAP_NEAR / 2);
    this.near = [...cars.map((g, i) => new Batch(g, carCap(i), false)), new Batch(bus, 1024, false), new Batch(truck, 1024, false), new Batch(personModel(), 8000, false, true, true), new Batch(model(WAGON), 512, false), new Batch(bikeModel(), 2000, false)];
    this.nearGlass = [
      ...splitCars.map((s, i) => s.glass ? new Batch(s.glass, carCap(i), false, false, false, true) : null),
      splitBus.glass ? new Batch(splitBus.glass, 1024, false, false, false, true) : null,
      splitTruck.glass ? new Batch(splitTruck.glass, 1024, false, false, false, true) : null,
    ];
    // beyond the cascades' shadow: the same model with the blob shadow under it
    const blobs = [...CAR_BODIES.map(([, a]) => [a.width, a.length]), [0.7, 2.1]];
    this.nearFar = [...fullCars.map((g, i) => new Batch(withBlob(g, blobs[i][0], blobs[i][1]), carCap(i), false, false)),
      new Batch(withBlob(fullBus, 2.5, 11.8), 1024, false, false), new Batch(withBlob(fullTruck, 2.5, 9.5), 1024, false, false)];
    // far (boxes up to 1.7 km): no shadow (less than a pixel, and up to 30,000 in the three shadow passes)
    this.mid = new Batch(model(BOX), CAP_MID, true, false);
    // the cars in the middle distance keep their silhouette (not a box): one light model per style
    this.midCars = CAR_BODIES.map((_, i) => new Batch(carMidModel(i), CAP_MID / 2, false, false));
    for (const b of [...this.near, ...this.nearFar, this.mid, ...this.midCars]) this.group.add(b.mesh);
    for (const b of this.nearGlass) if (b) this.group.add(b.mesh);
    this.group.add(this.people.group);
    this.people.seatedInCabins = true;
    void this.people.load();
  }

  /** Measurements: the people are not drawn. */
  hidePeople = false;

  /** Vehicle the camera follows: tracked by its id and its kind and colour (`followMatch`), nearest to the last place. */
  follow: { x: number; z: number; info: number; id: number; lost: number } | null = null;
  /** The followed vehicle's pose this frame: x, y, z, heading. */
  readonly followPose = new Float64Array(4);

  /** Starts following the vehicle nearest (x, z), within a radius. */
  pick(x: number, z: number, radius: number): boolean {
    const r = this.reader, d = r.data;
    let best = -1, bd = radius * radius;
    for (let i = 0; i < r.count; i++) {
      const o = i * POSE_STRIDE;
      if ((Math.floor(d[o + 8] / 256) & 255) === 3) continue; // not people
      const dd = (d[o + 4] - x) ** 2 + (d[o + 6] - z) ** 2;
      if (dd < bd) { bd = dd; best = o; }
    }
    if (best < 0) return false;
    this.follow = { x: d[best + 4], z: d[best + 6], info: d[best + 8] % 65536, id: d[best + 10], lost: 0 };
    return true;
  }

  /** Reads the newest poses, interpolates and fills the visible batches. */
  /** The previous frame's time (the previous pose for TRAA's velocity). */
  private lastNow = 0;

  update(camera: THREE.Camera, eye: THREE.Vector3, frameNow = performance.now()): void {
    const r = this.reader;
    r.acquire();
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv, camera.coordinateSystem, (camera as THREE.PerspectiveCamera).reversedDepth);
    for (const b of this.near) b.count = 0;
    for (const b of this.nearGlass) if (b) b.count = 0;
    for (const b of this.nearFar) b.count = 0;
    this.mid.count = 0;
    for (const b of this.midCars) b.count = 0;
    const people = this.people.ready ? this.people : null;
    people?.begin(camera);
    const n = r.count;
    if (n > 0) {
      // the frame's instant (the rAF's), not mid-frame: otherwise the step varies with the work before this
      const now = performance.timeOrigin + frameNow;
      const span = Math.max(1, r.dt);
      const t = Math.min(1, Math.max(0, (now - r.tickTime) / span));
      // the previous one along the same line (before the current step: extrapolated back, at most one step)
      const prevNow = this.lastNow > 0 && frameNow - this.lastNow < 200 ? performance.timeOrigin + this.lastNow : now;
      const tp = Math.min(t, Math.max(-1, (prevNow - r.tickTime) / span));
      const d = r.data;
      const fol = this.follow, fp = this.followPose;
      let fbest = 12 * 12;
      // tile by tile (the worker sorts the records by tile around the camera): whole tiles out of view or beyond the
      // drawing distance are skipped without reading their poses; the grid's edge tiles hold what lies beyond it
      const tiled = r.tiled, tiles = r.tiles, gx = r.originX, gz = r.originZ, box = this.tileBox;
      for (let tile = 0; tile < (tiled ? TILES : 1); tile++) {
        const i0 = tiled ? tiles[tile] : 0, i1 = tiled ? tiles[tile + 1] : n;
        if (i0 >= i1) continue;
        if (tiled) {
          const tx = tile % TILE_GRID, tz = (tile / TILE_GRID) | 0;
          if (tx > 0 && tz > 0 && tx < TILE_GRID - 1 && tz < TILE_GRID - 1) {
            box.min.set(gx + tx * TILE - 15, -500, gz + tz * TILE - 15);
            box.max.set(gx + (tx + 1) * TILE + 15, 2500, gz + (tz + 1) * TILE + 15);
            if (box.distanceToPoint(eye) > MID || !this.frustum.intersectsBox(box)) continue;
          }
        }
        for (let i = i0; i < i1; i++) {
          const o = i * POSE_STRIDE;
          const x = d[o] + (d[o + 4] - d[o]) * t;
          const y = d[o + 1] + (d[o + 5] - d[o + 1]) * t;
          const z = d[o + 2] + (d[o + 6] - d[o + 2]) * t;
          let dy = d[o + 7] - d[o + 3];
          if (dy > Math.PI) dy -= Math.PI * 2; else if (dy < -Math.PI) dy += Math.PI * 2;
          const yaw = d[o + 3] + dy * t;
          const px = d[o] + (d[o + 4] - d[o]) * tp, py = d[o + 1] + (d[o + 5] - d[o + 1]) * tp, pz = d[o + 2] + (d[o + 6] - d[o + 2]) * tp;
          const pyaw = d[o + 3] + dy * tp;
          if (fol && followMatch(d, o, fol)) {
            const dd = (x - fol.x) ** 2 + (z - fol.z) ** 2;
            if (dd < fbest) { fbest = dd; fp[0] = x; fp[1] = y; fp[2] = z; fp[3] = yaw; }
          }
          this.sphere.center.set(x, y + 1, z);
          this.sphere.radius = d[o + 8] % 65536 >= 4 * 256 ? 12 : 7;
          if (!this.frustum.intersectsSphere(this.sphere)) continue;
          const dist = Math.hypot(x - eye.x, y - eye.y, z - eye.z);
          if (dist > MID) continue;
          // kind × 256 + colour (bits 0-3; car style in bits 4-6; 128 = leading wagon) + lights × 65536
          const info = d[o + 8], lights = Math.floor(info / 65536), base = info - lights * 65536;
          const kind = Math.floor(base / 256), low = base - kind * 256;
          const style = kind === 0 ? (low >> 4) & 7 : 0;
          // with the cooked people the motorbike's rider is one of them: the bike's seats go off
          const shown = people && kind === 0 && style === 5 ? lights & 7 : lights;
          const color = (kind === 0 ? low & 15 : low & 127) + shown * 16 + (kind === 5 && !people ? 128 : 0);
          // people and bicycles: small, the model only up to PERSON_NEAR and a box up to PERSON_MID
          const person = kind === 3, small = person || kind === 5;
          if ((small && dist > PERSON_MID) || (person && this.hidePeople)) continue;
          if (people && small) { people.push(d, o, x, y, z, yaw, px, py, pz, pyaw, dist, r.dt, !person); if (person) continue; }
          if (people && kind <= 2 && dist < NEAR) people.occupants(kind, style, x, y, z, yaw, px, py, pz, pyaw, info, lights, dist, d[o + 10]);
          // near/middle crossing over by dithering in a 30 m band (people: 10 m)
          const fadeNear = small ? Math.min(1, Math.max(0, (PERSON_NEAR + 5 - dist) / 10)) : Math.min(1, Math.max(0, (NEAR + 15 - dist) / 30));
          const alpha = d[o + 9];
          const mi = modelOf(kind, style);
          // Opaque bodies: one level or the other at a hard cut, never a dither over the paint (the old
          // complementary masks made the body see-through for the whole 30 m band).
          const nearBody = !(kind < 3 && dist > SHADOW_NEAR);
          if (fadeNear > 0.5) {
            (nearBody ? this.near[mi] : this.nearFar[mi]).push(x, y, z, yaw, color, alpha, kind, 1, px, py, pz, pyaw);
            if (nearBody && mi < this.nearGlass.length) this.nearGlass[mi]?.push(x, y, z, yaw, color, alpha, kind, 1, px, py, pz, pyaw);
          }
          else if (kind === 0 && style < this.midCars.length) this.midCars[style].push(x, y, z, yaw, color, alpha, kind, -1, px, py, pz, pyaw);
          else this.mid.push(x, y, z, yaw, color, alpha, dimsOf(kind, style), -1, px, py, pz, pyaw);
        }
      }
      this.trackFollow(fbest < 12 * 12);
    }
    this.lastNow = frameNow;
    people?.end();
    for (const b of this.near) b.commit();
    for (const b of this.nearGlass) if (b) b.commit();
    for (const b of this.nearFar) b.commit();
    this.mid.commit();
    for (const b of this.midCars) b.commit();
  }

  /** Updates the followed vehicle after the frame: out of sight for half a second, let go. */
  private trackFollow(found: boolean): void {
    const f = this.follow;
    if (!f) return;
    if (found) { f.x = this.followPose[0]; f.z = this.followPose[2]; f.lost = 0; }
    else if (++f.lost > 30) this.follow = null;
  }

  /** Meshes to compile the shaders at load. */
  warmup(): void {
    for (const b of [...this.near, ...this.nearFar, this.mid, ...this.midCars]) { b.count = 0; b.push(0, -1000, 0, 0, 0, 1, 0); b.commit(); }
  }
}

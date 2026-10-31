// Cars, buses, trucks and people on screen. The poses come from the simulation worker (triple buffer); here they are
// only interpolated, culled and given their level: near, models with cabins and wheels; in the middle, boxes; far,
// "density cars" painted in the roads' shader (see roads.ts).
// Four draw calls for the whole fleet.

import * as THREE from 'three/webgpu';
import { POSE_STRIDE, TILE, TILE_GRID, TILES, type PoseReader } from '../shared/contracts/poses.ts';
import { PAINTS } from '../shared/vehiclePaints.ts';
import { T, withPrevious, type Node } from './tsl.ts';
import { nightU } from './scene.ts';
import { rainU } from './weather.ts';
import { PeopleRenderer } from './people/crowd.ts';

import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { NEAR, MID, CAP_NEAR, CAP_MID, model, GLASS_GLOW, PUFF, WHEEL, BLOB, OCC, withBlob, personModel, CAR_BODIES, carModel, carCabin, carMidModel, motoModel, bikeModel, busModel, truckModel, WAGON, BOX, KIND_DIMS, modelOf, dimsOf, splitGlass } from './vehicleModels.ts';
const {
  attribute, vec2, vec3, vec4, float, abs, cos, sin, mix, transformNormalToView, normalize,
  interleavedGradientNoise, screenCoordinate, uniformArray, int, floor, sRGBTransferEOTF, max, step, select, mod, time, smoothstep,
  cameraViewMatrix, fract, hash, clamp, atan, length, frontFacing, faceDirection,
} = T;

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

  /** `inside`: the body's inner side is drawn too (a near vehicle, seen into through its glass: `vehicleMaterial`). */
  constructor(base: THREE.BufferGeometry, cap: number, scaled: boolean, shadows = true, animated = false, glass = false, inside = false) {
    this.cap = cap;
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    for (const k of Object.keys(base.attributes)) g.setAttribute(k, base.attributes[k]);
    this.pos = new Float32Array(cap * 4);
    this.info = new Float32Array(cap * 4);
    this.prev = new Float32Array(cap * 4);
    // uploaded once per frame by commit()'s update range: three r186 re-uploads a DynamicDrawUsage attribute in every
    // render call that draws it (renderers/common/Attributes.js), the whole array after the first (the range is spent)
    this.prevAttr = new THREE.InstancedBufferAttribute(this.prev, 4);
    // people: the limbs already take the 8th vertex buffer (WebGPU's limit); at 1.4 m/s the current pose is enough
    if (!animated) g.setAttribute('iprev', this.prevAttr);
    this.posAttr = new THREE.InstancedBufferAttribute(this.pos, 4);
    this.infoAttr = new THREE.InstancedBufferAttribute(this.info, 4);
    g.setAttribute('ipos', this.posAttr);
    g.setAttribute('iinfo', this.infoAttr);
    g.instanceCount = 0;
    this.geo = g;
    // one material per combination (plain, box, person, glass) for every batch: each extra material is one more shader
    // to build and compile at load (19 batches were 19 materials and the city opened 1.5 s slower)
    const key = (scaled ? 1 : 0) + (animated ? 2 : 0) + (glass ? 4 : 0) + (inside ? 8 : 0);
    this.mesh = new THREE.Mesh(g, MATERIALS[key] ??= glass ? vehicleGlassMaterial() : vehicleMaterial(scaled, animated, inside));
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

/**
 * `inside`: for the near vehicles, whose glass is see-through. Their body is a single skin, one-sided: from outside,
 * through a window, the inner side of the roof, the pillars, the doors and the tail was culled and the street behind
 * showed through the car (3-7 % of the rays through a car's glass, `test/render-defects.test.ts`). Drawn on both sides
 * instead (three r186 nodes/display/FrontFacingNode.js `frontFacing`, `faceDirection`), the back faces as the cabin's
 * trim, lit from inside: no geometry added, one more material.
 */
function vehicleMaterial(scaled: boolean, animated: boolean, inside = false): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  if (inside) m.side = THREE.DoubleSide;
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
    const front = step(float(0.5), mod(glowV.sub(WHEEL), 2)).mul(isWheel);
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
  m.normalNode = inside ? transformNormalToView(normalize(rot(nrm))).mul(faceDirection) : transformNormalToView(normalize(rot(nrm)));
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
  // wheel parts and puffs keep a centre in the colour slot: their colour is by part. (glow is interpolated: a rear
  // wheel's 102 arrives as 101.99998, and floor((glow - 100) / 2) flipped between hub and tyre pixel by pixel — the
  // rear wheels' speckle; +0.5 keeps every part half a step from the rounding)
  const wPart = floor(glowA.sub(WHEEL).add(0.5).div(2));
  const wheelC = select(wPart.lessThan(0.5), sRGBTransferEOTF(vec3(0.086, 0.086, 0.086)), select(wPart.lessThan(1.5), sRGBTransferEOTF(vec3(0.73, 0.74, 0.75)), sRGBTransferEOTF(vec3(0.16, 0.17, 0.18))));
  const isWheelF = step(float(WHEEL - 0.5), glowA);
  const isPuffF = step(abs(glowA.sub(PUFF)), float(0.5));
  const isGlass = step(abs(glowA.sub(GLASS_GLOW)), float(0.5));
  const surf = mix(mix(attribute('color', 'vec3'), paint, attribute('paint', 'float')), wheelC, isWheelF);
  const outside = vec4(mix(mix(surf, vec3(0.015, 0.015, 0.02), isBlob), vec3(0.45, 0.45, 0.44), isPuffF), 1);
  // the inner side: the trim's grey (carBody.ts CARD), matte
  m.colorNode = inside ? select(frontFacing, outside, vec4(sRGBTransferEOTF(vec3(0.23, 0.24, 0.27)), 1)) : outside;
  // paint with a clear coat look, glass smooth (it shows the sky from the environment), the rest matte
  const rough = mix(mix(float(0.28), float(0.62), attribute('paint', 'float').oneMinus()), float(0.05), isGlass).add(isPuffF);
  m.roughnessNode = inside ? select(frontFacing, rough, float(0.85)) : rough;
  m.metalnessNode = inside ? attribute('paint', 'float').mul(0.3).mul(float(frontFacing)) : attribute('paint', 'float').mul(0.3);
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
    m.emissiveNode = inside ? head.add(tail).add(amber).mul(float(frontFacing)) : head.add(tail).add(amber);
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
  /** The whole bodies (glass merged) by model (`modelOf`: car styles 0-4, motorbike, bus, lorry): the blast's wrecks. */
  readonly wreckModels: THREE.BufferGeometry[];

  constructor(reader: PoseReader) {
    this.reader = reader;
    // one model per car style (the same material: one more call per style on screen). The near models are split into
    // an opaque body and a transparent glass; the far ones keep the merged model (glass there is a dark pane).
    const fullCars = [...CAR_BODIES.map((_, i) => carModel(i)), motoModel()];
    const splitCars = fullCars.map(splitGlass);
    // the near cars' glass is see-through: their cabin goes in with the body (the farther levels' glass is opaque)
    const cars = splitCars.map((s, i) => (i < CAR_BODIES.length ? mergeGeometries([s.solid, carCabin(i)])! : s.solid));
    const fullBus = busModel(), fullTruck = truckModel();
    this.wreckModels = [...fullCars, fullBus, fullTruck];
    const splitBus = splitGlass(fullBus), splitTruck = splitGlass(fullTruck);
    const bus = splitBus.solid, truck = splitTruck.solid;
    const carCap = (i: number) => (i < 2 ? CAP_NEAR : CAP_NEAR / 2);
    // (the cars, the bus and the lorry are seen into through their glass: their bodies' inner side is drawn)
    this.near = [...cars.map((g, i) => new Batch(g, carCap(i), false, true, false, false, i < CAR_BODIES.length)), new Batch(bus, 1024, false, true, false, false, true), new Batch(truck, 1024, false, true, false, false, true), new Batch(personModel(), 8000, false, true, true), new Batch(model(WAGON), 512, false), new Batch(bikeModel(), 2000, false)];
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

  /**
   * The cars, buses and lorries within `r` of (x, z) in the last poses read (only the tiles the circle touches): per
   * vehicle x, y, z, yaw, model (`wreckModels`) and paint (0xRRGGBB) pushed on `out`. Returns how many.
   */
  vehiclesNear(x: number, z: number, r: number, out: number[]): number {
    const rd = this.reader, d = rd.data, n0 = out.length;
    const scan = (i0: number, i1: number) => {
      for (let i = i0; i < i1; i++) {
        const o = i * POSE_STRIDE;
        const vx = d[o + 4], vz = d[o + 6];
        if ((vx - x) ** 2 + (vz - z) ** 2 > r * r) continue;
        const info = d[o + 8], lights = Math.floor(info / 65536), base = info - lights * 65536;
        const kind = Math.floor(base / 256), low = base - kind * 256;
        if (kind > 2) continue;
        const style = kind === 0 ? (low >> 4) & 7 : 0;
        const model = modelOf(kind, style);
        if (model >= this.wreckModels.length) continue;
        out.push(vx, d[o + 5], vz, d[o + 7], model, PAINTS[(kind === 0 ? low & 15 : low & 127) % PAINTS.length]);
      }
    };
    if (!rd.tiled) scan(0, rd.count);
    else {
      const t0x = Math.max(0, Math.floor((x - r - rd.originX) / TILE)), t1x = Math.min(TILE_GRID - 1, Math.floor((x + r - rd.originX) / TILE));
      const t0z = Math.max(0, Math.floor((z - r - rd.originZ) / TILE)), t1z = Math.min(TILE_GRID - 1, Math.floor((z + r - rd.originZ) / TILE));
      // (the grid's edge tiles also hold what lies beyond it: a circle past the edge reads them)
      for (let tz = t0z; tz <= t1z; tz++) for (let tx = t0x; tx <= t1x; tx++) {
        const tile = tz * TILE_GRID + tx;
        scan(rd.tiles[tile], rd.tiles[tile + 1]);
      }
    }
    return (out.length - n0) / 6;
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

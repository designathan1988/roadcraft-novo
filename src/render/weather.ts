// Weather: clouds (a noise layer in the sky), rain (instanced streaks around
// the camera, animated only in the shader), wet ground, stars and moon at
// night. The state changes slowly on its own; everything comes from a few uniforms.

import * as THREE from 'three/webgpu';
import { T, type Node } from './tsl.ts';
import { nightU } from './scene.ts';
import { colorOnly } from './tsl.ts';

const {
  uniform, vec3, vec4, float, mix, smoothstep, clamp, positionWorld, positionLocal, time, mx_fractal_noise_float,
  instanceIndex, hash, fract, cameraPosition, normalize, cross, sRGBTransferEOTF, attribute, sin, step, cameraProjectionMatrix,
} = T;

/** 0 clear sky .. 1 overcast. */
export const cloudsU = uniform(0.25);
/** 0 dry .. 1 heavy rain. */
export const rainU = uniform(0);
/** Wet ground (rises with the rain, dries slowly). */
export const wetU = uniform(0);
/** 0 calm .. 1 gale (slanted rain, swaying trees). */
export const windU = uniform(0.2);
/** Where the wind blows to (x, z), so the rain slants. */
export const windDirU = uniform(new THREE.Vector2(0.91, 0.41));
/** Lightning flash (0..1, falls off in tenths of a second). */
export const flashU = uniform(0);
/** How far the cloud layer has drifted with the wind (m, x and z): the clouds and their shadows move together. */
export const cloudDriftU = uniform(new THREE.Vector2(0, 0));

/** Cover of the weather's cloud layer over a point of its plane (0..1): the noise its material draws. */
export function layerCover(xz: Node): Node {
  const p = xz.add(cloudDriftU).div(2600);
  const n = mx_fractal_noise_float(vec3(p.x, p.y, time.mul(0.002)), 4, 2, 0.5).mul(0.5).add(0.5);
  const cover = cloudsU.mul(0.9);
  return smoothstep(float(1).sub(cover), float(1.15).sub(cover.mul(0.6)), n);
}

const RAIN_DROPS = 14000;
/** Bolt: 40 pieces, each with 4 triangles (edge, core, edge: the core glows, the edges are the halo). */
/** Room for the channel (128 pieces) and up to 6 branches (32 each), 12 vertices per piece. */
const BOLT_SEGS = 128 + 6 * 32;
const BOLT_VERTS = BOLT_SEGS * 12;

/** Midpoint displacement from a to b: 2^gens pieces, each generation kicked sideways by kick × its length, halved. */
function boltPath(a: [number, number, number], b: [number, number, number], gens: number, kick: number, rng: () => number): number[][] {
  let pts: number[][] = [a, b];
  let k = kick * Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  for (let g = 0; g < gens; g++) {
    const next: number[][] = [pts[0]];
    for (let i = 0; i + 1 < pts.length; i++) {
      const p = pts[i], q = pts[i + 1];
      next.push([(p[0] + q[0]) / 2 + (rng() - 0.5) * 2 * k, (p[1] + q[1]) / 2 + (rng() - 0.5) * k * 0.5, (p[2] + q[2]) / 2 + (rng() - 0.5) * 2 * k], q);
    }
    pts = next;
    k *= 0.5;
  }
  return pts;
}
const RAIN_BOX = 70;
/** Height of the weather's cloud layer (m). */
export const CLOUD_Y = 2200;

export class Weather {
  readonly group = new THREE.Group();
  private rng = Math.random;
  /** Targets the weather slowly chases. */
  private target = { clouds: 0.25, rain: 0, wind: 0.2, storm: 0 };
  /** Current storm (0..1): lightning and strong wind. */
  storm = 0;
  private strikeIn = 6;
  private flashT = 1;
  private bolt: THREE.Mesh;
  /** A lightning bolt is drawn now (the in-game checks see a strike). */
  get boltShown(): boolean { return this.bolt.visible; }
  private clouds: THREE.Mesh;
  private rain: THREE.Mesh;
  private skirt: THREE.Mesh;
  /** Fog colour (linear), copied every frame. */
  private horizonU = uniform(new THREE.Color(0xb9cbdc));
  private boltPos: THREE.BufferAttribute;
  /** Direction the camera looks at (angle on the plane, as atan2(z, x)). */
  viewAngle = 0;
  /** A bolt struck: distance to the camera (for the thunder). */
  onStrike: ((dist: number) => void) | null = null;
  private timer = 0;
  private eyeU = uniform(new THREE.Vector3());
  /** Bolts per minute chosen by the player (0 = the storm's own, on their own). */
  lightningRate = 0;
  /** Wind chosen by the player (0..1), or null for the weather's. */
  windFixed: number | null = null;
  /** Where the player's wind blows to (degrees). */
  set windDirection(deg: number) { const r = (deg * Math.PI) / 180; (windDirU.value as THREE.Vector2).set(Math.sin(r), Math.cos(r)); }
  /** Fixed by the option (null = changes on its own). */
  fixed: { clouds: number; rain: number; storm?: number } | null = null;

  constructor() {
    // clouds: high plane, noise that moves with the wind
    const cm = colorOnly(new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    // the layer drifts with the wind (`cloudDriftU`, Roadcraft 4.0: drift += wind × dt), its shadows with it
    const a = layerCover(positionWorld.xz);
    const day = float(1).sub(nightU);
    const light = mix(vec3(0.12, 0.13, 0.16), vec3(0.96, 0.96, 0.97), day).mul(mix(float(1), float(0.62), rainU));
    // camera rising close to the layer (overview of large maps): the clouds fade out
    const below = float(1).sub(smoothstep(float(CLOUD_Y - 1000), float(CLOUD_Y - 250), cameraPosition.y));
    cm.colorNode = vec4(sRGBTransferEOTF(light).add(vec3(0.9, 0.92, 1).mul(flashU.mul(3))), clamp(a.mul(mix(float(0.85), float(1), rainU)).mul(below), 0, 0.97));
    cm.fog = true;
    const clouds = this.clouds = new THREE.Mesh(new THREE.PlaneGeometry(80000, 80000).rotateX(-Math.PI / 2), cm);
    clouds.position.y = CLOUD_Y;
    clouds.frustumCulled = false;
    clouds.renderOrder = -10;
    this.group.add(clouds);

    // rain: thin streaks, position from the index; they fall and wrap around in a box that follows the camera
    const g = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(0.018, 0.9);
    g.index = quad.index;
    g.setAttribute('position', quad.attributes.position);
    g.instanceCount = RAIN_DROPS;
    const rm = colorOnly(new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false }));
    const id = instanceIndex.toFloat();
    const hx = hash(id), hz = hash(id.add(7.31)), hy = hash(id.add(3.17));
    // each drop stays fixed in the world (falling) and wraps around in a box around the camera
    const base = vec3(hx, hy, hz).mul(RAIN_BOX).sub(vec3(0, time.mul(9), 0));
    const center = this.eyeU.add(fract(base.sub(this.eyeU).div(RAIN_BOX)).sub(0.5).mul(RAIN_BOX));
    const toCam = normalize(cameraPosition.sub(center));
    const side = normalize(cross(vec3(0, 1, 0), toCam));
    const wind = vec3(windDirU.x, 0, windDirU.y).mul(positionLocal.y);
    rm.positionNode = center.add(side.mul(positionLocal.x)).add(vec3(0, positionLocal.y, 0)).add(wind.mul(windU.mul(1.4).add(0.1)));
    // only the drops the rain's strength asks for are drawn (`sizeRain`): each id has its own place, so the first n
    // are as spread as all of them
    // a drop stuck to the camera becomes a huge streak: it fades out up close
    const near = smoothstep(float(3), float(8), cameraPosition.distance(center));
    // isometric (the game centres the box on what is looked at): the box covers a close view; a wider view would show
    // it as a block of rain in the middle (the drops are under a pixel there anyway), so the rain fades out
    const ortho = step(float(0.5), cameraProjectionMatrix.element(3).element(3));
    const viewW = float(2).div(cameraProjectionMatrix.element(0).element(0));
    const fit = mix(float(1), smoothstep(float(RAIN_BOX * 1.1), float(RAIN_BOX * 0.7), viewW), ortho);
    rm.colorNode = vec4(0.75, 0.78, 0.82, near.mul(0.32).mul(fit));
    rm.fog = true;
    const rain = this.rain = new THREE.Mesh(g, rm);
    rain.frustumCulled = false;
    rain.renderOrder = 20;
    this.group.add(rain);

    // stars: small camera-facing squares on a huge sphere
    const sg = new THREE.InstancedBufferGeometry();
    const sq = new THREE.PlaneGeometry(1, 1);
    sg.index = sq.index;
    sg.setAttribute('position', sq.attributes.position);
    const N = 2500;
    const dirs = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) {
      const u = this.rng() * 2 - 1, t = this.rng() * Math.PI * 2, r = Math.sqrt(1 - u * u);
      dirs[i * 4] = r * Math.cos(t); dirs[i * 4 + 1] = Math.abs(u) * 0.95 + 0.05; dirs[i * 4 + 2] = r * Math.sin(t);
      dirs[i * 4 + 3] = 0.5 + this.rng() * this.rng() * 2.2;
    }
    sg.setAttribute('sdir', new THREE.InstancedBufferAttribute(dirs, 4));
    sg.instanceCount = N;
    const sm = colorOnly(new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false }));
    const sd = attribute('sdir', 'vec4');
    const R = 40000;
    const sc = cameraPosition.add(sd.xyz.mul(R));
    const tc = normalize(cameraPosition.sub(sc));
    const sx = normalize(cross(vec3(0, 1, 0), tc));
    const sy = cross(tc, sx);
    const size = sd.w.mul(R * 0.0011);
    sm.positionNode = sc.add(sx.mul(positionLocal.x.mul(size))).add(sy.mul(positionLocal.y.mul(size)));
    const twinkle = sin(time.mul(2.3).add(sd.x.mul(91))).mul(0.25).add(0.75);
    sm.colorNode = vec4(1, 1, 1, nightU.mul(float(1).sub(cloudsU)).mul(twinkle).mul(clamp(sd.w.mul(0.6), 0.25, 1)));
    sm.fog = false;
    const stars = new THREE.Mesh(sg, sm);
    stars.frustumCulled = false;
    stars.renderOrder = -900;
    this.group.add(stars);

    // horizon skirt: with an overcast sky, the band between the cloud edge and the horizon
    // takes the fog colour (otherwise the bright sky shows under the cloud layer)
    const hm = colorOnly(new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.BackSide }));
    hm.colorNode = vec4(this.horizonU, smoothstep(float(0.45), float(0.9), cloudsU).mul(0.97));
    hm.fog = false;
    this.skirt = new THREE.Mesh(new THREE.CylinderGeometry(52000, 52000, 3200, 48, 1, true).translate(0, 1300, 0), hm);
    this.skirt.frustumCulled = false;
    this.skirt.renderOrder = -950;
    this.group.add(this.skirt);

    // bolt: zigzag ribbon rebuilt on every strike (64 pieces), brightness above 1 so the bloom catches it
    const bg = new THREE.BufferGeometry();
    this.boltPos = new THREE.BufferAttribute(new Float32Array(BOLT_VERTS * 3), 3);
    bg.setAttribute('position', this.boltPos);
    // core (1) and edge (0) of each vertex: the same pattern in every piece
    const core = new Float32Array(BOLT_VERTS);
    const pattern = [0, 1, 1, 0, 1, 0, 1, 0, 0, 1, 0, 1];
    for (let i = 0; i < BOLT_VERTS; i++) core[i] = pattern[i % 12];
    bg.setAttribute('core', new THREE.BufferAttribute(core, 1));
    const bm = colorOnly(new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    const glow = attribute('core', 'float');
    // white core above 1 (the bloom does the rest); bluish edges that fade: a halo wide enough not to
    // vanish in the temporal smoothing, which dilutes one-pixel lines that last only a few frames
    bm.colorNode = vec4(mix(vec3(1.2, 1.4, 2.4), vec3(6, 6.2, 7), glow.mul(glow)).mul(flashU), clamp(flashU.mul(1.5), 0, 1).mul(glow.mul(glow).mul(0.85).add(0.15)));
    bm.fog = false;
    this.bolt = new THREE.Mesh(bg, bm);
    this.bolt.frustumCulled = false;
    this.bolt.visible = false;
    this.bolt.renderOrder = 25;
    this.group.add(this.bolt);
  }

  /** Builds the bolt from a cloud down to the ground near (x, z), as a camera-facing ribbon. */
  private strike(eye: THREE.Vector3, ground: number, front = false, at: [number, number] | null = null): void {
    // half the strikes land in front of the camera (the others are only heard); or where the player clicked
    const a = at ? Math.atan2(at[1] - eye.z, at[0] - eye.x) : front || this.rng() < 0.5 ? this.viewAngle + (this.rng() - 0.5) * 1.2 : this.rng() * Math.PI * 2;
    const d = at ? Math.hypot(at[0] - eye.x, at[1] - eye.z) : 700 + this.rng() * 3300;
    const x = at ? at[0] : eye.x + Math.cos(a) * d, z = at ? at[1] : eye.z + Math.sin(a) * d;
    const top = ground + 1300 + this.rng() * 500;
    const p = this.boltPos.array as Float32Array;
    // ribbon side: perpendicular to the camera direction
    const sx = -Math.sin(a), sz = Math.cos(a);
    const top0: [number, number, number] = [x + (this.rng() - 0.5) * (at ? 120 : 300), top, z + (this.rng() - 0.5) * (at ? 120 : 300)];
    // wider halo from afar (a few pixels on screen even at 4 km)
    const width = 6 + d * 0.004;
    // Roadcraft 4.0's branching bolt (lightning.ts): the channel by midpoint displacement, 7 generations (128 pieces),
    // kick 0.2 × length halved each generation; 3-6 branches leave it 10-70 % down, ~30° off its axis, reaching
    // (1 − f) × length × (0.25..0.55), 5 generations with kick 0.18 × reach; branches thinner than the channel
    const main = boltPath(top0, [x, ground, z], 7, 0.2, this.rng);
    const pieces: Array<{ a: number[]; b: number[]; w0: number; w1: number }> = [];
    const n = main.length - 1;
    for (let i = 0; i < n; i++) pieces.push({ a: main[i], b: main[i + 1], w0: width * (1 - 0.4 * i / n), w1: width * (1 - 0.4 * (i + 1) / n) });
    const branches = 3 + Math.floor(this.rng() * 4);
    const len = Math.hypot(main[n][0] - main[0][0], main[n][1] - main[0][1], main[n][2] - main[0][2]);
    for (let k = 0; k < branches; k++) {
      const f = 0.1 + this.rng() * 0.6, from = main[Math.floor(f * n)];
      const reach = (1 - f) * len * (0.25 + this.rng() * 0.3);
      const turn = this.rng() * Math.PI * 2, off = 0.52;
      const to = [from[0] + Math.cos(turn) * Math.sin(off) * reach, from[1] - Math.cos(off) * reach, from[2] + Math.sin(turn) * Math.sin(off) * reach];
      const path = boltPath(from as [number, number, number], to as [number, number, number], 5, 0.18, this.rng);
      for (let i = 0; i + 1 < path.length; i++) pieces.push({ a: path[i], b: path[i + 1], w0: width * 0.7 * (1 - 0.5 * i / path.length), w1: width * 0.7 * (1 - 0.5 * (i + 1) / path.length) });
    }
    let k = 0;
    for (const { a: A, b: B, w0, w1 } of pieces) {
      if (k + 36 > p.length) break;
      // left-core and core-right (core/edge pattern in the 'core' attribute)
      const L0 = [A[0] - sx * w0, A[1], A[2] - sz * w0], C0 = A, R0 = [A[0] + sx * w0, A[1], A[2] + sz * w0];
      const L1 = [B[0] - sx * w1, B[1], B[2] - sz * w1], C1 = B, R1 = [B[0] + sx * w1, B[1], B[2] + sz * w1];
      p.set([...L0, ...C0, ...C1, ...L0, ...C1, ...L1, ...C0, ...R0, ...R1, ...C0, ...R1, ...C1], k); k += 36;
    }
    p.fill(0, k);
    (this.bolt.geometry as THREE.BufferGeometry).setDrawRange(0, k / 3);
    this.boltPos.needsUpdate = true;
    this.bolt.visible = true;
    this.flashT = 0;
    this.onStrike?.(Math.hypot(x - eye.x, z - eye.z, ground - eye.y));
  }

  /** Forces a strike (api and photos). */
  strikeNow(eye: THREE.Vector3, ground: number): void { this.strike(eye, ground, true); }

  /** Bolt at the ground point (x, z) (player's click). */
  strikeAt(eye: THREE.Vector3, x: number, z: number, ground: number): void { this.strike(eye, ground, false, [x, z]); }

  /**
   * Changes the weather slowly; wets and dries the ground. `eye`: where the rain box is centred (the eye; in the isometric view,
   * the point looked at).
   */
  update(dt: number, gameDt: number, eye: THREE.Vector3, ground = 0, fog?: THREE.Color): void {
    this.eyeU.value.copy(eye);
    // the cloud layer drifts along the wind: 3 m/s in calm air, 15 m/s in a gale
    const drift = cloudDriftU.value as THREE.Vector2, wd = windDirU.value as THREE.Vector2, speed = 3 + 12 * windU.value;
    drift.set(drift.x + wd.x * speed * dt, drift.y + wd.y * speed * dt);
    // without rain, the streaks are not even drawn; above the layer, neither are the clouds
    this.rain.visible = rainU.value > 0.003;
    this.clouds.visible = eye.y < CLOUD_Y - 250;
    this.skirt.position.set(eye.x, 0, eye.z);
    if (fog) (this.horizonU.value as THREE.Color).copy(fog);
    // flash: blinks twice and fades
    this.flashT += dt;
    const f = this.flashT;
    flashU.value = f < 0.08 ? 1 : f < 0.14 ? 0.25 : f < 0.22 ? 0.85 : Math.max(0, 0.85 - (f - 0.22) * 4);
    if (flashU.value <= 0) this.bolt.visible = false;
    if (this.lightningRate > 0 || this.storm > 0.3) {
      this.strikeIn -= dt;
      if (this.strikeIn <= 0) {
        this.strikeIn = this.lightningRate > 0 ? (60 / this.lightningRate) * (0.5 + this.rng()) : 3 + this.rng() * 14 / this.storm;
        this.strike(eye, ground);
      }
    }
    if (this.fixed) {
      // fixed weather (option or photo): it arrives already settled
      cloudsU.value = this.fixed.clouds; rainU.value = this.fixed.rain; wetU.value = this.fixed.rain > 0 ? 1 : 0;
      this.storm = this.fixed.storm ?? 0;
      windU.value = this.windFixed ?? 0.2 + this.storm * 0.8;
      this.sizeRain();
      return;
    }
    {
      this.timer -= gameDt;
      if (this.timer <= 0) {
        // every 1 to 3 game hours, new weather
        this.timer = 3600 * (1 + this.rng() * 2);
        const r = this.rng();
        const w = this.rng();
        this.target = r < 0.55 ? { clouds: 0.1 + this.rng() * 0.3, rain: 0, wind: w * 0.4, storm: 0 }
          : r < 0.8 ? { clouds: 0.55 + this.rng() * 0.3, rain: 0, wind: 0.2 + w * 0.5, storm: 0 }
          : r < 0.93 ? { clouds: 0.9, rain: 0.4 + this.rng() * 0.6, wind: 0.3 + w * 0.4, storm: 0 }
          : { clouds: 1, rain: 0.9, wind: 0.8 + w * 0.2, storm: 1 };
      }
    }
    const k = Math.min(1, dt * 0.08);
    cloudsU.value += (this.target.clouds - cloudsU.value) * k;
    rainU.value += (this.target.rain - rainU.value) * k;
    windU.value += ((this.windFixed ?? this.target.wind) - windU.value) * k;
    this.storm += (this.target.storm - this.storm) * k;
    wetU.value = rainU.value > 0.05 ? Math.min(1, wetU.value + dt * 0.05) : Math.max(0, wetU.value - dt * 0.004);
    this.sizeRain();
  }

  /** Draws as many drops as the rain shows (all 14,000 were drawn and most of them hidden by the shader). */
  private sizeRain(): void {
    const n = Math.ceil(RAIN_DROPS * Math.min(1, Math.max(0, rainU.value)));
    (this.rain.geometry as THREE.InstancedBufferGeometry).instanceCount = n;
    this.rain.visible = n > 0 && rainU.value > 0.003;
  }
}

/** Wet roads and sidewalks: darker and smoother. */
export function wetLook(color: Node, rough: Node): [Node, Node] {
  return [color.mul(mix(float(1), float(0.62), wetU)), mix(rough, float(0.22), wetU.mul(0.8))];
}

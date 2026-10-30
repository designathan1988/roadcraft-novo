// Explosions as Roadcraft 4.0 draws them (render/blast.ts explode/crater, render/playEffects.ts explode): the flash, a
// shockwave racing over the ground, the camera shaken, fire and smoke (the particles' bursts), shrapnel of what the
// ground was, a crater with its rim heaved up in slabs, soot round it, and whatever was struck thrown as rigid pieces
// (render/blast/debris.ts) that come to rest and stay. Every part is a bounded pool made once and compiled at load
// (`warm`): nothing is created during play, and with nothing moving the effect costs nothing a frame.

import * as THREE from 'three/webgpu';
import { T } from './tsl.ts';
import { Debris, PieceSpec, Shape } from './blast/debris.ts';
import { Marks } from './blast/marks.ts';
import { Puff } from './particles.ts';

const { vec3, float, mix, smoothstep, attribute, mx_noise_float } = T;

/** Colours of what is thrown, by what it was (4.0's COLORS). */
export const Kind = {
  asphalt: 0x2b2b2d, concrete: 0x9a968e, earth: 0x5b4632, brick: 0x8a4a35, wood: 0x6b4a2e,
  metal: 0x3c3f44, glass: 0x9fb8c4, char: 0x1c1a19, leaf: 0x3d6b2a,
} as const;

export type BlastGround = 'road' | 'earth' | 'building';

/** Lasting fires (a burning wreck, the crater): at most this many at once, the oldest goes. */
const MAX_FIRES = 64;
const RING_LIFE = 0.7;

export class Blast {
  readonly group = new THREE.Group();
  readonly debris: Debris;
  readonly marks: Marks;
  /** A reusable piece to fill and pass to `debris.add`. */
  readonly spec = new PieceSpec();
  private flash: THREE.Mesh;
  private flashT = 9;
  private flashMat = new THREE.MeshBasicNodeMaterial({ color: 0xffd28a, transparent: true, depthWrite: false });
  private ring: THREE.Mesh;
  private ringMat = new THREE.MeshBasicNodeMaterial({ color: 0xfff1d0, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
  private ringAge = Infinity;
  private ringReach = 0;
  private shakeAmp = 0;
  // fires: x, y, z, size, seconds left, seconds to the next puff per row
  private fires = new Float32Array(MAX_FIRES * 6);
  private nFires = 0;
  private emit: (x: number, y: number, z: number, kind: number, strength: number, seconds: number) => void;
  /** Each wreck model's box (width, height, length). */
  private wreckSizes: Array<[number, number, number]>;

  /**
   * `wrecks`: the vehicles' whole bodies by model (`Vehicles.wreckModels`); `emit`: a burst of particles (Particles.burst);
   * `groundAt`: the ground's height (the pieces land on it, the marks lie on it).
   */
  private groundAt: (x: number, z: number) => number;

  constructor(wrecks: THREE.BufferGeometry[], emit: (x: number, y: number, z: number, kind: number, strength: number, seconds: number) => void,
    groundAt: (x: number, z: number) => number) {
    this.emit = emit;
    this.groundAt = groundAt;
    this.marks = new Marks(groundAt);
    this.flash = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), this.flashMat);
    this.flash.visible = false;
    this.flash.frustumCulled = false;
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.86, 1, 48).rotateX(-Math.PI / 2), this.ringMat);
    this.ring.name = 'blast-ring';
    this.ring.visible = false;
    this.ring.frustumCulled = false;
    this.ring.renderOrder = 6;
    const bodies = wrecks.map(centred);
    this.wreckSizes = bodies.map((g) => { const v = g.boundingBox!.getSize(new THREE.Vector3()); return [v.x, v.y, v.z]; });
    this.debris = new Debris(bodies, carcassMaterial());
    // a wreck that was burning keeps burning where it comes to rest, under its own smoke
    this.debris.onRest = (x, y, z, size, seconds) => this.burn(x, y, z, size, seconds);
    this.group.add(this.flash, this.ring, this.debris.group, this.marks.group);
  }

  /** A burst of particles (Particles.burst). */
  emitAt(x: number, y: number, z: number, kind: number, strength: number, seconds: number): void { this.emit(x, y, z, kind, strength, seconds); }
  /** A wreck model's box: width, height, length (m). */
  wreckSize(model: number): [number, number, number] { return this.wreckSizes[model]; }

  /**
   * A building struck down by the blast at (bx, bz): its shell in panels and one slab per floor, thrown out from the
   * blast and tumbling to rest as rigid pieces (`color` its walls' 0xRRGGBB). Footprint w × d centred at (x, z), turned
   * `rot`, standing on `y`, `h` high.
   */
  collapse(x: number, y: number, z: number, w: number, d: number, h: number, rot: number, floors: number, color: number, bx: number, bz: number, radius: number): void {
    const c = Math.cos(rot), sn = Math.sin(rot);
    const nx = 3, nz = 2, ny = Math.max(1, Math.min(6, Math.round(floors)));
    const s = this.spec;
    const out = (px: number, pz: number, k: number) => {
      const dx = px - bx, dz = pz - bz, dd = Math.hypot(dx, dz) || 1, f = k * Math.max(0.25, 1 - dd / (radius * 1.6));
      s.vx = (dx / dd) * f + (Math.random() - 0.5); s.vy = f * 0.4 * Math.random(); s.vz = (dz / dd) * f + (Math.random() - 0.5);
    };
    for (let ix = 0; ix < nx; ix++) for (let iz = 0; iz < nz; iz++) for (let iy = 0; iy < ny; iy++) {
      const lx = (ix + 0.5) / nx * w - w / 2, lz = (iz + 0.5) / nz * d - d / 2;
      s.reset().turn(0, 1, 0, rot);
      s.shape = Shape.Box; s.color = (ix + iy + iz) % 4 === 3 ? Kind.concrete : color;
      s.x = x + lx * c + lz * sn; s.y = y + (iy + 0.5) * h / ny; s.z = z - lx * sn + lz * c;
      s.sx = w / nx * 0.92; s.sy = h / ny * 0.92; s.sz = d / nz * 0.92;
      out(s.x, s.z, 6);
      s.wx = (Math.random() - 0.5) * 1.5; s.wy = (Math.random() - 0.5) * 0.6; s.wz = (Math.random() - 0.5) * 1.5;
      this.debris.add(s);
    }
    // the floor slabs, coming down flat
    for (let f = 1; f <= floors && f <= 12; f++) {
      s.reset().turn(0, 1, 0, rot);
      s.shape = Shape.Box; s.color = Kind.concrete;
      s.x = x; s.y = y + f * h / Math.max(1, floors); s.z = z;
      s.sx = w * 0.92; s.sy = 0.2; s.sz = d * 0.92;
      out(s.x, s.z, 2);
      s.wx = (Math.random() - 0.5) * 0.4; s.wy = 0; s.wz = (Math.random() - 0.5) * 0.4;
      this.debris.add(s);
    }
    this.emit(x, y + h * 0.5, z, Puff.Dust, Math.min(15, 4 + h / 4), 6);
  }

  /** How far the camera is shaken now (m). */
  shake(): number { return this.shakeAmp; }
  /** Whether anything is still moving, flashing or shaking (the frame is drawn while it is). */
  active(): boolean { return this.flash.visible || this.ringAge < RING_LIFE || this.shakeAmp > 0 || this.nFires > 0 || this.debris.moving(); }
  /** Whether anything casting a shadow moves (the shadow maps are redrawn while it does). */
  moving(): boolean { return this.debris.moving(); }

  /**
   * The explosion at (x, y, z), `radius` its reach, tearing up `ground` (4.0 explode): flash, fireball, smoke and dust,
   * a fire left burning, the shockwave, the shake and shrapnel.
   */
  explode(x: number, y: number, z: number, radius: number, ground: BlastGround): void {
    this.flash.position.set(x, y + 2, z);
    this.flash.scale.setScalar(radius * 0.3);
    this.flash.userData.r = radius;
    this.flashT = 0;
    this.flash.visible = true;
    const k = Math.min(15, 3 + radius / 4);
    // the fireball, the column rising after it, and the fire left in the hole a while under black smoke
    this.emit(x, y + 0.8, z, Puff.Fire, k, 1.5);
    this.emit(x, y + 2.5, z, Puff.Fire, k * 0.7, 1.6);
    this.burn(x, y + 0.2, z, Math.min(3, radius * 0.08), 6 + Math.min(10, radius * 0.05));
    this.emit(x, y + 1.5, z, Puff.Smoke, k, 7);
    this.emit(x, y + 5, z, Puff.Smoke, k * 0.8, 9);
    this.emit(x, y + 0.3, z, ground === 'earth' ? Puff.Dust : Puff.Soot, k, 6);
    this.emit(x, y + 0.5, z, Puff.Sparks, k, 1.4);
    this.ringAge = 0;
    this.ringReach = radius * 2.4;
    this.ring.position.set(x, y + 0.15, z);
    this.shakeAmp = Math.max(this.shakeAmp, 0.25 + radius * 0.04);
    // shrapnel of what the ground was
    const kinds = ground === 'earth' ? [Kind.earth, Kind.earth, Kind.earth, Kind.concrete]
      : ground === 'road' ? [Kind.asphalt, Kind.asphalt, Kind.concrete, Kind.earth] : [Kind.concrete, Kind.brick, Kind.glass, Kind.concrete];
    const n = Math.round(24 + radius * 1.5);
    const s = this.spec;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, out = 4 + Math.random() * 9;
      const size = 0.08 + Math.random() * Math.random() * 0.45;
      s.reset();
      s.shape = Shape.Box; s.color = kinds[i % kinds.length];
      s.x = x + Math.cos(a) * radius * 0.2; s.y = y + 0.3; s.z = z + Math.sin(a) * radius * 0.2;
      s.sx = size * (1 + Math.random()); s.sy = size * (0.4 + Math.random() * 0.5); s.sz = size * (1 + Math.random());
      s.vx = Math.cos(a) * out; s.vy = 5 + Math.random() * 10; s.vz = Math.sin(a) * out;
      this.debris.add(s);
    }
  }

  /**
   * A crater at (x, y, z), `radius` across its scorch (4.0 crater): the hole, its broken rim of tilted slabs, and plates
   * of the ground heaved up round it, laid still (not where plates already lie).
   */
  crater(x: number, y: number, z: number, radius: number, road: boolean): void {
    this.marks.crater(x, z, radius, road);
    const s = this.spec;
    const rim = Math.round(8 + radius * 0.8);
    for (let i = 0; i < rim; i++) {
      const a = (i / rim) * Math.PI * 2 + Math.random() * 0.4, r = radius * (0.32 + Math.random() * 0.12);
      const size = (0.35 + Math.random() * 0.5) * (road ? 1 : 0.8);
      // tipped about the axis across the way out
      s.reset().turn(-Math.sin(a), 0, Math.cos(a), 0.4 + Math.random() * 0.6);
      s.shape = Shape.Box; s.color = road ? (i % 3 === 0 ? Kind.concrete : Kind.asphalt) : Kind.earth;
      s.x = x + Math.cos(a) * r; s.y = y + 0.1; s.z = z + Math.sin(a) * r;
      s.sx = size; s.sy = road ? 0.12 : 0.2; s.sz = size * (0.6 + Math.random() * 0.5);
      s.vx = Math.cos(a) * 0.6; s.vy = 0.8; s.vz = Math.sin(a) * 0.6;
      s.wx = s.wy = s.wz = 0;
      this.debris.add(s);
    }
    const plates = this.debris.stillNear(x, z, radius * 1.4) > 25 ? 0 : Math.min(60, Math.round(10 + radius / 1.6));
    const base = new THREE.Color(), dirt = new THREE.Color(0x6e6357);
    for (let i = 0; i < plates; i++) {
      const a = Math.random() * Math.PI * 2, r = radius * (0.4 + Math.sqrt(Math.random()) * 1.1);
      const w = (1.2 + Math.random() * 2.6) * Math.min(2, 0.6 + radius / 20);
      const d = w * (0.5 + Math.random() * 0.6);
      // tipped about an axis across the way out (the inner edge sunk), turned any way about the vertical
      const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(-Math.sin(a), 0, Math.cos(a)), 0.35 + Math.random() * 0.75)
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI));
      // dirty: dust and earth over the asphalt or the concrete, each its own shade
      base.setHex(road ? (Math.random() < 0.35 ? Kind.concrete : Kind.asphalt) : Kind.earth);
      base.lerp(dirt, 0.25 + Math.random() * 0.35).multiplyScalar(0.7 + Math.random() * 0.35);
      s.reset();
      s.qx = tilt.x; s.qy = tilt.y; s.qz = tilt.z; s.qw = tilt.w;
      s.shape = Shape.Slab; s.color = base.getHex(); s.still = true;
      s.x = x + Math.cos(a) * r; s.y = y + w * 0.18; s.z = z + Math.sin(a) * r;
      s.sx = w; s.sy = road ? 0.3 : 0.45; s.sz = d;
      this.debris.add(s);
      // earth and grit thrown up round it
      if (i % 3 === 0) {
        s.reset();
        s.shape = Shape.Box; s.color = Kind.earth; s.still = true;
        s.x = x + Math.cos(a) * r; s.y = y + 0.2; s.z = z + Math.sin(a) * r;
        s.sx = 0.3 + Math.random() * 0.4; s.sy = 0.2; s.sz = 0.3 + Math.random() * 0.4;
        this.debris.add(s);
      }
    }
  }

  /** Soot and ash laid on the ground at (x, y, z), `radius` across: kept. */
  soot(x: number, _y: number, z: number, radius: number): void { this.marks.blot(x, z, radius); }

  /** A fire that keeps burning at (x, y, z), `size` across, for `seconds`: flames and a black column. */
  burn(x: number, y: number, z: number, size: number, seconds: number): void {
    if (this.nFires >= MAX_FIRES) { this.fires.copyWithin(0, 6, this.nFires * 6); this.nFires--; }
    const o = this.nFires++ * 6;
    this.fires[o] = x; this.fires[o + 1] = y; this.fires[o + 2] = z; this.fires[o + 3] = size;
    this.fires[o + 4] = seconds; this.fires[o + 5] = 0;
  }

  update(dt: number): void {
    if (this.flash.visible) {
      this.flashT += dt;
      const k = this.flashT / 0.6;
      const r = (this.flash.userData.r as number) ?? 10;
      this.flash.scale.setScalar(r * (0.3 + k * 0.9));
      this.flashMat.opacity = Math.max(0, 1 - k);
      if (k >= 1) this.flash.visible = false;
    }
    if (this.ringAge < RING_LIFE) {
      this.ringAge += dt;
      const k = Math.min(1, this.ringAge / RING_LIFE);
      const r = this.ringReach * (1 - (1 - k) ** 2);
      this.ring.visible = true;
      this.ring.scale.set(r, 1, r);
      this.ringMat.opacity = 0.55 * (1 - k);
    } else this.ring.visible = false;
    this.shakeAmp *= Math.exp(-dt * 4);
    if (this.shakeAmp < 1e-3) this.shakeAmp = 0;
    // lasting fires: their flames and smoke renewed as emitters of a few seconds (the particles run on the GPU)
    for (let i = this.nFires - 1; i >= 0; i--) {
      const o = i * 6;
      this.fires[o + 4] -= dt;
      this.fires[o + 5] -= dt;
      if (this.fires[o + 4] <= 0) { this.fires.copyWithin(o, o + 6, this.nFires * 6); this.nFires--; continue; }
      if (this.fires[o + 5] > 0) continue;
      const left = Math.min(4, this.fires[o + 4]), size = this.fires[o + 3];
      const dying = Math.min(1, this.fires[o + 4] / 3 + 0.3);
      this.emit(this.fires[o], this.fires[o + 1] + 0.3, this.fires[o + 2], Puff.Fire, Math.min(15, (2 + size * 2) * dying), left);
      this.emit(this.fires[o], this.fires[o + 1] + 1, this.fires[o + 2], Puff.Smoke, Math.min(15, 2 + size * 2), left + 4);
      this.fires[o + 5] = left;
    }
    this.debris.update(dt, this.groundAt);
  }

  /** Everything gone (a new city). */
  clear(): void {
    this.debris.clear();
    this.marks.clear();
    this.nFires = 0;
    this.flash.visible = false;
    this.ringAge = Infinity;
    this.shakeAmp = 0;
  }

  /**
   * Compiles every part at load (`on`), as the very objects drawn in play: the pipeline is tied to the mesh (three r186
   * names a small instance buffer by its node, nodes/accessors/Instance.js) and to the scene's light and environment
   * (NodeManager.getCacheKey). Far under the ground meanwhile.
   */
  warm(on: boolean): void {
    if (on) { this.flash.position.set(0, -5000, 0); this.ring.position.set(0, -5000, 0); }
    this.flash.visible = on;
    this.ring.visible = on;
    this.debris.warm(on);
    this.marks.warm(on);
  }
}

/** A vehicle body moved so its box's centre is at the origin (the physics turns a piece about its centre). */
function centred(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', src.getAttribute('position').clone());
  g.setAttribute('normal', src.getAttribute('normal'));
  if (src.index) g.setIndex(src.index);
  g.computeBoundingBox();
  const c = g.boundingBox!.getCenter(new THREE.Vector3());
  g.translate(-c.x, -c.y, -c.z);
  g.computeBoundingBox();
  return g;
}

/**
 * A burnt-out vehicle (4.0's carcass shader, render/blast.ts carcassMaterial): soot, grey ash and rust in fine-grained
 * burns over the body, and a trace of its paint low on the sides where it burnt least. The paint per wreck in `ipaint`.
 */
function carcassMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0.25, side: THREE.DoubleSide });
  // the body's own coordinates (positionLocal is the instanced one by now: the burns would slide as it tumbles)
  const body = attribute('position', 'vec3');
  const q = body.mul(1 / 0.22);
  const n = (p: ReturnType<typeof vec3>) => mx_noise_float(p).mul(0.5).add(0.5);
  // two octaves each: fine-grained burns, not blotches
  const n1 = n(q).mul(0.65).add(n(q.mul(3.1).add(7)).mul(0.35));
  const n2 = n(q.mul(2.3).add(13)).mul(0.6).add(n(q.mul(6).add(29)).mul(0.4));
  const n3 = n(q.mul(0.5).add(41));
  const soot = vec3(0.03, 0.028, 0.026), ash = vec3(0.2, 0.19, 0.18), rust = vec3(0.24, 0.12, 0.065);
  let c = mix(soot, ash, smoothstep(0.4, 0.8, n1).mul(0.55));
  c = mix(c, rust, smoothstep(0.62, 0.86, n2).mul(0.55));
  const low = float(1).sub(smoothstep(0.3, 0.9, body.y.add(0.6)));
  c = mix(c, attribute('ipaint', 'vec3').mul(0.22), smoothstep(0.6, 0.85, n3).mul(low).mul(0.6));
  m.colorNode = c;
  return m;
}

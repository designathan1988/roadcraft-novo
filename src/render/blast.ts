// Explosion and collapse: one flash, plus the building's shell and floor slabs as a single instanced
// burst. A burst is a handful of draws at most (one per explosion), never one object per building;
// when its pieces settle, the burst is disposed and the scene goes back to having no blast state.

import * as THREE from 'three/webgpu';
import { Destruction } from './destruction.ts';
import type { FractureInput } from './fracture.ts';

const FRAGMENTS = 1024;
const GRAVITY = 9.8;
const LIFE = 3.2;

interface Burst {
  mesh: THREE.InstancedMesh;
  n: number;
  cap: number;
  px: Float32Array; py: Float32Array; pz: Float32Array;
  vx: Float32Array; vy: Float32Array; vz: Float32Array;
  rx: Float32Array; ry: Float32Array; rz: Float32Array;
  sx: Float32Array; sy: Float32Array; sz: Float32Array;
  ground: Float32Array;
  age: Float32Array;
  born: number;
}

export class Blast {
  readonly group = new THREE.Group();
  private flash: THREE.Mesh;
  private flashT = 9;
  private bursts: Burst[] = [];
  private current: Burst | null = null;
  private box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  private wallMat = new THREE.MeshStandardNodeMaterial({ color: 0xb8b0a2, roughness: 0.9 });
  private flashMat = new THREE.MeshBasicNodeMaterial({ color: 0xffd28a, transparent: true, depthWrite: false });
  private readonly destruction = new Destruction();
  private scratch = new THREE.Matrix4();
  private quat = new THREE.Quaternion();
  private euler = new THREE.Euler();
  private pos = new THREE.Vector3();
  private scale = new THREE.Vector3();

  constructor() {
    this.flash = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), this.flashMat);
    this.flash.visible = false;
    this.group.add(this.flash);
    this.group.add(this.destruction.group);
  }

  /** Starts the real ruin of one building; its pieces fall under the same update as the flash. */
  wreck(input: FractureInput, floor: number, x: number, y: number, z: number, force: number): void {
    this.destruction.spawn(input, floor, x, y, z, force);
  }

  /** A flash at (x, y, z) with the explosion's radius; the next collapse pieces belong to this burst. */
  boom(x: number, y: number, z: number, r: number): void {
    this.flash.position.set(x, y + 2, z);
    this.flash.scale.setScalar(r * 0.3);
    this.flash.userData.r = r;
    this.flashT = 0;
    this.flash.visible = true;
    this.current = this.newBurst();
  }

  /** A building collapsing: shell panels and one slab per floor, all in the burst's single draw. */
  collapse(x: number, y: number, z: number, w: number, d: number, h: number, rot: number, floors = 4): void {
    const b = this.current ?? (this.current = this.newBurst());
    const c = Math.cos(rot), s = Math.sin(rot);
    const ground = y;
    const nx = 3, nz = 2, ny = Math.max(1, Math.min(6, Math.round(floors)));
    // shell panels
    for (let ix = 0; ix < nx; ix++) for (let iz = 0; iz < nz; iz++) for (let iy = 0; iy < ny; iy++) {
      const lx = (ix + 0.5) / nx * w - w / 2, lz = (iz + 0.5) / nz * d - d / 2;
      this.add(b, x + lx * c + lz * s, ground + (iy + 0.5) * h / ny, z - lx * s + lz * c,
        w / nx * 0.92, h / ny * 0.92, d / nz * 0.92, rot, ground, 0.7 + (ix + iy + iz) * 0.08);
    }
    // floor slabs, visible while the shell falls apart
    for (let f = 0; f <= floors; f++) this.add(b, x, ground + f * h / Math.max(1, floors), z,
      w * 0.92, 0.16, d * 0.92, rot, ground, 0.5 + f * 0.04);
    this.flush(b);
  }

  private newBurst(): Burst {
    const mesh = new THREE.InstancedMesh(this.box, this.wallMat, FRAGMENTS);
    mesh.count = 0; mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true;
    this.group.add(mesh);
    const b: Burst = {
      mesh, n: 0, cap: FRAGMENTS,
      px: new Float32Array(FRAGMENTS), py: new Float32Array(FRAGMENTS), pz: new Float32Array(FRAGMENTS),
      vx: new Float32Array(FRAGMENTS), vy: new Float32Array(FRAGMENTS), vz: new Float32Array(FRAGMENTS),
      rx: new Float32Array(FRAGMENTS), ry: new Float32Array(FRAGMENTS), rz: new Float32Array(FRAGMENTS),
      sx: new Float32Array(FRAGMENTS), sy: new Float32Array(FRAGMENTS), sz: new Float32Array(FRAGMENTS),
      ground: new Float32Array(FRAGMENTS), age: new Float32Array(FRAGMENTS), born: 0,
    };
    this.bursts.push(b);
    return b;
  }

  private add(b: Burst, x: number, y: number, z: number, sx: number, sy: number, sz: number, rot: number, ground: number, speed: number): void {
    if (b.n >= b.cap) return;
    const i = b.n++;
    const a = (i / b.cap) * Math.PI * 2;
    b.px[i] = x; b.py[i] = y; b.pz[i] = z;
    b.vx[i] = Math.cos(a) * speed; b.vz[i] = Math.sin(a) * speed; b.vy[i] = -0.4 - (i % 7) * 0.12;
    b.rx[i] = (i % 5 - 2) * 0.18; b.ry[i] = rot + (i % 3 - 1) * 0.2; b.rz[i] = (i % 7 - 3) * 0.1;
    b.sx[i] = sx; b.sy[i] = sy; b.sz[i] = sz; b.ground[i] = ground;
  }

  private flush(b: Burst): void {
    b.mesh.count = b.n; b.born = performance.now() / 1000;
    for (let i = 0; i < b.n; i++) {
      this.euler.set(b.rx[i], b.ry[i], b.rz[i]); this.quat.setFromEuler(this.euler);
      this.pos.set(b.px[i], b.py[i], b.pz[i]); this.scale.set(b.sx[i], b.sy[i], b.sz[i]);
      this.scratch.compose(this.pos, this.quat, this.scale); b.mesh.setMatrixAt(i, this.scratch);
    }
    b.mesh.instanceMatrix.needsUpdate = true;
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
    for (let k = this.bursts.length - 1; k >= 0; k--) {
      const b = this.bursts[k];
      let moving = false;
      for (let i = 0; i < b.n; i++) {
        b.age[i] += dt;
        if (b.py[i] > b.ground[i] + 0.02) {
          b.vy[i] -= GRAVITY * dt;
          b.px[i] += b.vx[i] * dt; b.py[i] += b.vy[i] * dt; b.pz[i] += b.vz[i] * dt;
          b.rx[i] += b.vx[i] * 0.15 * dt; b.rz[i] += b.vz[i] * 0.15 * dt;
          if (b.py[i] < b.ground[i]) { b.py[i] = b.ground[i]; b.vy[i] = 0; }
          moving = true;
          this.euler.set(b.rx[i], b.ry[i], b.rz[i]); this.quat.setFromEuler(this.euler);
          this.pos.set(b.px[i], b.py[i], b.pz[i]); this.scale.set(b.sx[i], b.sy[i], b.sz[i]);
          this.scratch.compose(this.pos, this.quat, this.scale); b.mesh.setMatrixAt(i, this.scratch);
        }
      }
      if (moving) b.mesh.instanceMatrix.needsUpdate = true;
      const last = b.n ? Math.max(...b.age.subarray(0, b.n)) : 0;
      if (last > LIFE) {
        this.group.remove(b.mesh); b.mesh.dispose(); this.bursts.splice(k, 1);
        if (this.current === b) this.current = null;
      }
    }
    this.destruction.update(dt);
  }

  /** Sample meshes (they compile at load). */
  warmup(): THREE.Object3D[] {
    const a = new THREE.Mesh(this.box, this.wallMat); a.position.y = -5000;
    const b = new THREE.Mesh(this.flash.geometry, this.flashMat); b.position.y = -5000;
    return [a, b];
  }
}

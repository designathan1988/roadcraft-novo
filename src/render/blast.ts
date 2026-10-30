// Explosion and collapse: one flash, plus the buildings' shell and floor slabs as pieces of one instanced mesh with a
// fixed number of slots (a bounded pool shared by every bomb, one draw). The mesh is made once and compiled at load:
// three r186 names a small instance matrix buffer after its node id (nodes/accessors/Instance.js), so a new
// InstancedMesh per bomb meant a new shader and 4 pipelines (main pass and 3 shadow cascades) built mid-game, a
// 170-340 ms frame on every bomb. With no piece alive the mesh is hidden and costs nothing per frame.

import * as THREE from 'three/webgpu';

/** Slots for the pieces of every collapse alive at once (a building is up to 43 pieces); the oldest are reused. */
const FRAGMENTS = 4096;
const GRAVITY = 9.8;
const LIFE = 3.2;

export class Blast {
  readonly group = new THREE.Group();
  private flash: THREE.Mesh;
  private flashT = 9;
  private box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  private wallMat = new THREE.MeshStandardNodeMaterial({ color: 0xb8b0a2, roughness: 0.9 });
  private flashMat = new THREE.MeshBasicNodeMaterial({ color: 0xffd28a, transparent: true, depthWrite: false });
  private pieces: THREE.InstancedMesh;
  // one row per slot (SoA): position, velocity, rotation, size, the ground it settles on, age (≥ LIFE: free)
  private px = new Float32Array(FRAGMENTS); private py = new Float32Array(FRAGMENTS); private pz = new Float32Array(FRAGMENTS);
  private vx = new Float32Array(FRAGMENTS); private vy = new Float32Array(FRAGMENTS); private vz = new Float32Array(FRAGMENTS);
  private rx = new Float32Array(FRAGMENTS); private ry = new Float32Array(FRAGMENTS); private rz = new Float32Array(FRAGMENTS);
  private sx = new Float32Array(FRAGMENTS); private sy = new Float32Array(FRAGMENTS); private sz = new Float32Array(FRAGMENTS);
  private ground = new Float32Array(FRAGMENTS);
  private age = new Float32Array(FRAGMENTS).fill(LIFE);
  /** The next slot to fill (slots are taken in order, so the next one is the oldest); `used`: slots drawn. */
  private next = 0;
  private used = 0;
  private live = 0;
  private scratch = new THREE.Matrix4();
  private quat = new THREE.Quaternion();
  private euler = new THREE.Euler();
  private pos = new THREE.Vector3();
  private scale = new THREE.Vector3();

  constructor() {
    this.flash = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), this.flashMat);
    this.flash.visible = false;
    this.flash.frustumCulled = false;
    this.group.add(this.flash);
    this.pieces = new THREE.InstancedMesh(this.box, this.wallMat, FRAGMENTS);
    this.pieces.count = 0; this.pieces.visible = false;
    this.pieces.frustumCulled = false; this.pieces.castShadow = true; this.pieces.receiveShadow = true;
    this.group.add(this.pieces);
  }

  /** A flash at (x, y, z) with the explosion's radius. */
  boom(x: number, y: number, z: number, r: number): void {
    this.flash.position.set(x, y + 2, z);
    this.flash.scale.setScalar(r * 0.3);
    this.flash.userData.r = r;
    this.flashT = 0;
    this.flash.visible = true;
  }

  /** A building collapsing: shell panels and one slab per floor. */
  collapse(x: number, y: number, z: number, w: number, d: number, h: number, rot: number, floors = 4): void {
    const c = Math.cos(rot), s = Math.sin(rot);
    const ground = y;
    const nx = 3, nz = 2, ny = Math.max(1, Math.min(6, Math.round(floors)));
    const from = this.next;
    // shell panels
    for (let ix = 0; ix < nx; ix++) for (let iz = 0; iz < nz; iz++) for (let iy = 0; iy < ny; iy++) {
      const lx = (ix + 0.5) / nx * w - w / 2, lz = (iz + 0.5) / nz * d - d / 2;
      this.add(x + lx * c + lz * s, ground + (iy + 0.5) * h / ny, z - lx * s + lz * c,
        w / nx * 0.92, h / ny * 0.92, d / nz * 0.92, rot, ground, 0.7 + (ix + iy + iz) * 0.08);
    }
    // floor slabs, visible while the shell falls apart
    for (let f = 0; f <= floors; f++) this.add(x, ground + f * h / Math.max(1, floors), z,
      w * 0.92, 0.16, d * 0.92, rot, ground, 0.5 + f * 0.04);
    // the new slots' matrices (a run that wrapped round the end is two ranges)
    const to = this.next, im = this.pieces.instanceMatrix;
    for (let i = from; i !== to; i = (i + 1) % FRAGMENTS) this.compose(i);
    if (to >= from) im.addUpdateRange(from * 16, (to - from) * 16);
    else { im.addUpdateRange(from * 16, (FRAGMENTS - from) * 16); im.addUpdateRange(0, to * 16); }
    im.needsUpdate = true;
    this.pieces.count = this.used;
    this.pieces.visible = true;
  }

  private add(x: number, y: number, z: number, sx: number, sy: number, sz: number, rot: number, ground: number, speed: number): void {
    const i = this.next;
    this.next = (i + 1) % FRAGMENTS;
    this.used = Math.max(this.used, i + 1);
    if (this.age[i] >= LIFE) this.live++;
    const a = (i / FRAGMENTS) * Math.PI * 8;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = Math.cos(a) * speed; this.vz[i] = Math.sin(a) * speed; this.vy[i] = -0.4 - (i % 7) * 0.12;
    this.rx[i] = (i % 5 - 2) * 0.18; this.ry[i] = rot + (i % 3 - 1) * 0.2; this.rz[i] = (i % 7 - 3) * 0.1;
    this.sx[i] = sx; this.sy[i] = sy; this.sz[i] = sz; this.ground[i] = ground; this.age[i] = 0;
  }

  private compose(i: number): void {
    if (this.age[i] >= LIFE) this.scale.set(0, 0, 0);
    else this.scale.set(this.sx[i], this.sy[i], this.sz[i]);
    this.euler.set(this.rx[i], this.ry[i], this.rz[i]); this.quat.setFromEuler(this.euler);
    this.pos.set(this.px[i], this.py[i], this.pz[i]);
    this.scratch.compose(this.pos, this.quat, this.scale); this.pieces.setMatrixAt(i, this.scratch);
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
    if (this.live === 0) return;
    // the slots drawn, at most FRAGMENTS: a fixed bound, and only while some piece is alive
    let lo = this.used, hi = -1;
    for (let i = 0; i < this.used; i++) {
      if (this.age[i] >= LIFE) continue;
      this.age[i] += dt;
      const dead = this.age[i] >= LIFE;
      if (dead) this.live--;
      if (!dead && this.py[i] <= this.ground[i] + 0.02) continue;
      if (!dead) {
        this.vy[i] -= GRAVITY * dt;
        this.px[i] += this.vx[i] * dt; this.py[i] += this.vy[i] * dt; this.pz[i] += this.vz[i] * dt;
        this.rx[i] += this.vx[i] * 0.15 * dt; this.rz[i] += this.vz[i] * 0.15 * dt;
        if (this.py[i] < this.ground[i]) { this.py[i] = this.ground[i]; this.vy[i] = 0; }
      }
      this.compose(i);
      if (i < lo) lo = i;
      hi = i;
    }
    if (hi >= lo) {
      const im = this.pieces.instanceMatrix;
      im.addUpdateRange(lo * 16, (hi - lo + 1) * 16);
      im.needsUpdate = true;
    }
    // all settled and gone: hidden (not drawn, no per-frame update), the slots start over
    if (this.live === 0) { this.pieces.visible = false; this.pieces.count = 0; this.used = 0; this.next = 0; }
  }

  /**
   * Compiles the pieces and the flash at load (`on`), as the very objects drawn in play: the pipeline is tied to the
   * mesh's own buffers, so a sample mesh compiled another one. One piece far under the ground meanwhile.
   */
  warm(on: boolean): void {
    if (on) {
      this.scratch.makeTranslation(0, -5000, 0);
      this.pieces.setMatrixAt(0, this.scratch);
      this.pieces.instanceMatrix.needsUpdate = true;
      this.flash.position.set(0, -5000, 0);
    }
    this.pieces.count = on ? 1 : 0;
    this.pieces.visible = on;
    this.flash.visible = on;
  }
}

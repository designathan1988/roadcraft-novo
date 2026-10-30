// Explosion and collapse: a flash, a scorched crater that stays, and the debris of the ground and of the building
// thrown outward with spin, bouncing and settling. One instanced draw per burst (never one object per piece); the
// crater decals are flat discs, capped so a city of bombs does not pile up draws.

import * as THREE from 'three/webgpu';

const FRAGMENTS = 2048;
const GRAVITY = 9.8;
const LIFE = 6;
const MAX_CRATERS = 10;

interface Burst {
  mesh: THREE.InstancedMesh;
  n: number;
  cap: number;
  px: Float32Array; py: Float32Array; pz: Float32Array;
  vx: Float32Array; vy: Float32Array; vz: Float32Array;
  rx: Float32Array; ry: Float32Array; rz: Float32Array;
  wx: Float32Array; wy: Float32Array; wz: Float32Array;
  sx: Float32Array; sy: Float32Array; sz: Float32Array;
  ground: Float32Array;
  col: Float32Array;
  age: Float32Array;
  cx: number; cy: number; cz: number;
  born: number;
}

const WALL = new THREE.Color(0xb8b0a2), CHAR = new THREE.Color(0x37312c), SOIL = new THREE.Color(0x5b4632);
const ASPHALT = new THREE.Color(0x35342f), STONE = new THREE.Color(0x8d887e);

export class Blast {
  readonly group = new THREE.Group();
  private flash: THREE.Mesh;
  private flashT = 9;
  private bursts: Burst[] = [];
  private current: Burst | null = null;
  private craters: THREE.Mesh[] = [];
  private box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  private disc = new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2);
  private wallMat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.92 });
  private flashMat = new THREE.MeshBasicNodeMaterial({ color: 0xffd28a, transparent: true, depthWrite: false });
  private sootMat = new THREE.MeshBasicNodeMaterial({ color: 0x141110, transparent: true, opacity: 0.78, depthWrite: false });
  private scratch = new THREE.Matrix4();
  private quat = new THREE.Quaternion();
  private euler = new THREE.Euler();
  private pos = new THREE.Vector3();
  private scale = new THREE.Vector3();
  private tint = new THREE.Color();
  private rng = 0x9e3779b9;

  constructor() {
    this.flash = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), this.flashMat);
    this.flash.visible = false;
    this.flash.renderOrder = 30;
    this.group.add(this.flash);
  }

  private rand(): number {
    this.rng = (Math.imul(this.rng ^ (this.rng >>> 15), 0x2c1b3c6d) + 0x7f4a7c15) >>> 0;
    return this.rng / 4294967296;
  }

  /** A flash at (x, y, z) with the explosion's radius; the crater stays, the next pieces belong to this burst. */
  boom(x: number, y: number, z: number, r: number): void {
    this.flash.position.set(x, y + 2, z);
    this.flash.scale.setScalar(r * 0.3);
    this.flash.userData.r = r;
    this.flashT = 0;
    this.flash.visible = true;
    this.current = this.newBurst(x, y, z);
    this.crater(x, y, z, r);
    // the ground itself, torn up and thrown out: dark asphalt and soil, some pale stone
    const n = Math.min(90, Math.round(r * 4));
    for (let i = 0; i < n; i++) {
      const a = this.rand() * Math.PI * 2, d = r * (0.15 + 0.5 * Math.sqrt(this.rand()));
      const s = 0.25 + this.rand() * (0.5 + r * 0.03);
      const kind = this.rand();
      this.tint.copy(kind < 0.45 ? ASPHALT : kind < 0.8 ? SOIL : STONE).multiplyScalar(0.75 + this.rand() * 0.4);
      const out = 5 + this.rand() * (6 + r * 0.5);
      this.add(this.current!, x + Math.cos(a) * d, y + 0.15 + this.rand() * 0.4, z + Math.sin(a) * d, s, s * 0.55, s,
        this.rand() * Math.PI * 2, y, out, 2 + this.rand() * (3 + r * 0.15), this.tint);
    }
    this.flush(this.current!);
  }

  /** A building collapsing: shell panels and one slab per floor, thrown outward from the blast and spun. */
  collapse(x: number, y: number, z: number, w: number, d: number, h: number, rot: number, floors = 4): void {
    const b = this.current ?? (this.current = this.newBurst(x, y, z));
    const c = Math.cos(rot), s = Math.sin(rot);
    const ground = y;
    const nx = 3, nz = 2, ny = Math.max(1, Math.min(6, Math.round(floors)));
    for (let ix = 0; ix < nx; ix++) for (let iz = 0; iz < nz; iz++) for (let iy = 0; iy < ny; iy++) {
      const lx = (ix + 0.5) / nx * w - w / 2, lz = (iz + 0.5) / nz * d - d / 2;
      const k = (ix + iy + iz) % 5;
      this.tint.copy(k === 0 ? CHAR : WALL).multiplyScalar(0.78 + ((ix * 7 + iy * 3 + iz) % 6) * 0.04);
      this.add(b, x + lx * c + lz * s, ground + (iy + 0.5) * h / ny, z - lx * s + lz * c,
        w / nx * 0.92, h / ny * 0.92, d / nz * 0.92, rot, ground,
        1.5 + (ix + iy + iz) * 0.35, 0.6 + (iy / ny) * 2.4, this.tint);
    }
    // floor slabs, visible while the shell falls apart
    for (let f = 0; f <= floors; f++) {
      this.tint.copy(WALL).multiplyScalar(0.55 + f * 0.03);
      this.add(b, x, ground + f * h / Math.max(1, floors), z, w * 0.92, 0.16, d * 0.92, rot, ground,
        0.9 + f * 0.15, 0.3 + (f / Math.max(1, floors)), this.tint);
    }
    this.flush(b);
  }

  /** The scorched hole the blast leaves on the ground (kept; the oldest goes when the cap is reached). */
  private crater(x: number, y: number, z: number, r: number): void {
    const mesh = new THREE.Mesh(this.disc, this.sootMat);
    mesh.position.set(x, y + 0.035, z);
    mesh.scale.setScalar(Math.max(1.5, r * 0.55));
    mesh.renderOrder = 4;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    this.craters.push(mesh);
    if (this.craters.length > MAX_CRATERS) {
      const old = this.craters.shift()!;
      this.group.remove(old);
    }
  }

  private newBurst(cx: number, cy: number, cz: number): Burst {
    const mesh = new THREE.InstancedMesh(this.box, this.wallMat, FRAGMENTS);
    mesh.count = 0; mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true;
    this.group.add(mesh);
    const colors = new THREE.InstancedBufferAttribute(new Float32Array(FRAGMENTS * 3), 3);
    mesh.instanceColor = colors;
    const b: Burst = {
      mesh, n: 0, cap: FRAGMENTS,
      px: new Float32Array(FRAGMENTS), py: new Float32Array(FRAGMENTS), pz: new Float32Array(FRAGMENTS),
      vx: new Float32Array(FRAGMENTS), vy: new Float32Array(FRAGMENTS), vz: new Float32Array(FRAGMENTS),
      rx: new Float32Array(FRAGMENTS), ry: new Float32Array(FRAGMENTS), rz: new Float32Array(FRAGMENTS),
      wx: new Float32Array(FRAGMENTS), wy: new Float32Array(FRAGMENTS), wz: new Float32Array(FRAGMENTS),
      sx: new Float32Array(FRAGMENTS), sy: new Float32Array(FRAGMENTS), sz: new Float32Array(FRAGMENTS),
      ground: new Float32Array(FRAGMENTS), col: new Float32Array(FRAGMENTS * 3), age: new Float32Array(FRAGMENTS),
      cx, cy, cz, born: 0,
    };
    this.bursts.push(b);
    return b;
  }

  /** A piece: thrown away from the burst's centre with `out` (m/s) and `up` (m/s), spun. */
  private add(b: Burst, x: number, y: number, z: number, sx: number, sy: number, sz: number, rot: number, ground: number, out: number, up: number, colour: THREE.Color): void {
    if (b.n >= b.cap) return;
    const i = b.n++;
    let dx = x - b.cx, dz = z - b.cz;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) { const a = this.rand() * Math.PI * 2; dx = Math.cos(a); dz = Math.sin(a); }
    else { dx /= len; dz /= len; }
    const j = 0.7 + this.rand() * 0.6;
    b.px[i] = x; b.py[i] = y; b.pz[i] = z;
    b.vx[i] = dx * out * j; b.vz[i] = dz * out * j; b.vy[i] = up * (0.6 + this.rand() * 0.8);
    b.rx[i] = (this.rand() - 0.5) * 0.6; b.ry[i] = rot + (this.rand() - 0.5) * 0.6; b.rz[i] = (this.rand() - 0.5) * 0.6;
    b.wx[i] = (this.rand() - 0.5) * 7; b.wy[i] = (this.rand() - 0.5) * 5; b.wz[i] = (this.rand() - 0.5) * 7;
    b.sx[i] = sx; b.sy[i] = sy; b.sz[i] = sz; b.ground[i] = ground;
    b.col[i * 3] = colour.r; b.col[i * 3 + 1] = colour.g; b.col[i * 3 + 2] = colour.b;
  }

  private flush(b: Burst): void {
    b.mesh.count = b.n; b.born = performance.now() / 1000;
    const colors = b.mesh.instanceColor!;
    for (let i = 0; i < b.n; i++) {
      this.euler.set(b.rx[i], b.ry[i], b.rz[i]); this.quat.setFromEuler(this.euler);
      this.pos.set(b.px[i], b.py[i], b.pz[i]); this.scale.set(b.sx[i], b.sy[i], b.sz[i]);
      this.scratch.compose(this.pos, this.quat, this.scale); b.mesh.setMatrixAt(i, this.scratch);
      colors.setXYZ(i, b.col[i * 3], b.col[i * 3 + 1], b.col[i * 3 + 2]);
    }
    b.mesh.instanceMatrix.needsUpdate = true;
    colors.needsUpdate = true;
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
      let changed = false;
      for (let i = 0; i < b.n; i++) {
        b.age[i] += dt;
        const resting = b.py[i] <= b.ground[i] + 0.02 && Math.hypot(b.vx[i], b.vy[i], b.vz[i]) < 0.15;
        if (resting) continue;
        b.vy[i] -= GRAVITY * dt;
        b.px[i] += b.vx[i] * dt; b.py[i] += b.vy[i] * dt; b.pz[i] += b.vz[i] * dt;
        b.rx[i] += b.wx[i] * dt; b.ry[i] += b.wy[i] * dt; b.rz[i] += b.wz[i] * dt;
        if (b.py[i] <= b.ground[i]) {
          b.py[i] = b.ground[i];
          if (b.vy[i] < -0.6) b.vy[i] = -b.vy[i] * 0.26;
          else b.vy[i] = 0;
          b.vx[i] *= 0.62; b.vz[i] *= 0.62;
          b.wx[i] *= 0.55; b.wy[i] *= 0.55; b.wz[i] *= 0.55;
        }
        // air drag, stronger once on the ground
        const drag = b.py[i] <= b.ground[i] + 0.02 ? Math.exp(-dt * 5) : Math.exp(-dt * 0.25);
        b.vx[i] *= drag; b.vz[i] *= drag;
        this.euler.set(b.rx[i], b.ry[i], b.rz[i]); this.quat.setFromEuler(this.euler);
        this.pos.set(b.px[i], b.py[i], b.pz[i]); this.scale.set(b.sx[i], b.sy[i], b.sz[i]);
        this.scratch.compose(this.pos, this.quat, this.scale); b.mesh.setMatrixAt(i, this.scratch);
        changed = true;
      }
      if (changed) b.mesh.instanceMatrix.needsUpdate = true;
      const last = b.n ? Math.max(...b.age.subarray(0, b.n)) : 0;
      if (last > LIFE) {
        this.group.remove(b.mesh); b.mesh.dispose(); this.bursts.splice(k, 1);
        if (this.current === b) this.current = null;
      }
    }
  }

  /** Sample meshes (they compile at load). */
  warmup(): THREE.Object3D[] {
    const a = new THREE.Mesh(this.box, this.wallMat); a.position.y = -5000;
    const b = new THREE.Mesh(this.flash.geometry, this.flashMat); b.position.y = -5000;
    const c = new THREE.Mesh(this.disc, this.sootMat); c.position.y = -5000;
    return [a, b, c];
  }
}

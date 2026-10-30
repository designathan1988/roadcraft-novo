// What an explosion throws: rigid pieces (boxes, rods, broken slabs of the ground, car shells and burnt-out vehicles)
// with Roadcraft 4.0's physics (render/blast.ts stepPiece: gravity, each corner below the ground pushed out by an
// impulse with friction, asleep when its farthest point is slow, as Box2D judges rest). One row per piece in typed
// arrays (no object per piece), at most MAX_PIECES; when full the oldest piece at rest goes. Drawn as one
// InstancedMesh per shape, made once (compiled at load, `warm`), rewritten only while a piece moves or the set changes:
// a street of rubble at rest costs nothing a frame.

import * as THREE from 'three/webgpu';

export const MAX_PIECES = 1400;
const GRAVITY = 9.8;
const STEP = 1 / 60;

/** Piece shapes: the InstancedMesh each is drawn by. Burnt vehicles come after these, one shape per model. */
export const Shape = { Box: 0, Rod: 1, Slab: 2, Shell: 3 } as const;
const BASE_SHAPES = 4;
/** Capacity of the shell and of each vehicle-model batch (4.0 keeps at most 40 wrecks). */
const WRECKS = 48;

/** A piece to throw (filled by the caller, read by `add`; reused, never kept). Rotations as a quaternion, NaN spin = random. */
export class PieceSpec {
  shape = 0;
  x = 0; y = 0; z = 0;
  /** Box: width, height, depth. Rod: radius, length, radius. Shell and vehicles: length (x), height, width. */
  sx = 1; sy = 1; sz = 1;
  qx = 0; qy = 0; qz = 0; qw = 1;
  vx = 0; vy = 0; vz = 0;
  wx = NaN; wy = NaN; wz = NaN;
  color = 0x808080;
  /** Seconds it keeps burning once at rest (0: none). */
  burn = 0;
  /** Laid where it is and never moved (a heaved slab of the ground). */
  still = false;
  reset(): this {
    this.shape = 0; this.x = this.y = this.z = 0; this.sx = this.sy = this.sz = 1;
    this.qx = this.qy = this.qz = 0; this.qw = 1; this.vx = this.vy = this.vz = 0;
    this.wx = this.wy = this.wz = NaN; this.color = 0x808080; this.burn = 0; this.still = false;
    return this;
  }
  /** Turned by `angle` about the unit axis (ax, ay, az). */
  turn(ax: number, ay: number, az: number, angle: number): this {
    const s = Math.sin(angle / 2);
    this.qx = ax * s; this.qy = ay * s; this.qz = az * s; this.qw = Math.cos(angle / 2);
    return this;
  }
}

const ASLEEP = 1, STILL = 2;

export class Debris {
  readonly group = new THREE.Group();
  /** Called once when a burning piece comes to rest: where, how big, for how long more. */
  onRest: ((x: number, y: number, z: number, size: number, seconds: number) => void) | null = null;
  private meshes: THREE.InstancedMesh[] = [];
  private n = 0;
  private born = 0;
  private px = new Float32Array(MAX_PIECES); private py = new Float32Array(MAX_PIECES); private pz = new Float32Array(MAX_PIECES);
  private vx = new Float32Array(MAX_PIECES); private vy = new Float32Array(MAX_PIECES); private vz = new Float32Array(MAX_PIECES);
  private qx = new Float32Array(MAX_PIECES); private qy = new Float32Array(MAX_PIECES); private qz = new Float32Array(MAX_PIECES); private qw = new Float32Array(MAX_PIECES);
  private wx = new Float32Array(MAX_PIECES); private wy = new Float32Array(MAX_PIECES); private wz = new Float32Array(MAX_PIECES);
  private sx = new Float32Array(MAX_PIECES); private sy = new Float32Array(MAX_PIECES); private sz = new Float32Array(MAX_PIECES);
  private col = new Uint32Array(MAX_PIECES);
  /** Inverse of the (round) inertia per unit mass, and the farthest corner's distance from the centre. */
  private invI = new Float32Array(MAX_PIECES); private reach = new Float32Array(MAX_PIECES);
  private burn = new Float32Array(MAX_PIECES); private rest = new Float32Array(MAX_PIECES);
  private order = new Uint32Array(MAX_PIECES);
  private shape = new Uint8Array(MAX_PIECES);
  private flags = new Uint8Array(MAX_PIECES);
  private clock = 0;
  private dirty = false;
  private counts: number[] = [];
  private mat = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private c = new THREE.Color();

  /**
   * `models`: vehicle bodies, burnt out by `wreckMaterial` (one shape each after the base ones, in the vehicle's own
   * frame). Their instances carry the vehicle's paint in `ipaint` (not the instance colour, which three multiplies into
   * the whole surface: the paint is only a trace on a wreck).
   */
  constructor(models: THREE.BufferGeometry[], wreckMaterial: THREE.Material) {
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0.05 });
    const geos: Array<[THREE.BufferGeometry, number, THREE.Material]> = [
      [new THREE.BoxGeometry(1, 1, 1), MAX_PIECES, material],
      [new THREE.CylinderGeometry(1, 1, 1, 9), MAX_PIECES, material],
      [slabGeometry(), MAX_PIECES, material],
      [shellGeometry(), WRECKS, material],
      ...models.map((g): [THREE.BufferGeometry, number, THREE.Material] => [wreckGeometry(g), WRECKS, wreckMaterial]),
    ];
    for (const [g, cap, m] of geos) {
      const mesh = new THREE.InstancedMesh(g, m, cap);
      mesh.name = 'blast-debris';
      mesh.count = 0; mesh.visible = false;
      mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true;
      // the instance colour from the first frame, so the shader never changes variant (4.0 does the same)
      if (m === material) mesh.setColorAt(0, this.c.set(1, 1, 1));
      this.meshes.push(mesh);
      this.counts.push(0);
      this.group.add(mesh);
    }
  }

  get count(): number { return this.n; }
  /** Whether a piece casts a moving shadow (not all at rest). */
  moving(): boolean {
    for (let i = 0; i < this.n; i++) if (!(this.flags[i] & ASLEEP)) return true;
    return false;
  }

  add(s: PieceSpec): void {
    let i = this.n;
    if (i >= MAX_PIECES) i = this.victim();
    else this.n++;
    this.shape[i] = s.shape;
    this.px[i] = s.x; this.py[i] = s.y; this.pz[i] = s.z;
    this.vx[i] = s.vx; this.vy[i] = s.vy; this.vz[i] = s.vz;
    const ql = Math.hypot(s.qx, s.qy, s.qz, s.qw) || 1;
    this.qx[i] = s.qx / ql; this.qy[i] = s.qy / ql; this.qz[i] = s.qz / ql; this.qw[i] = s.qw / ql;
    this.wx[i] = Number.isNaN(s.wx) ? (Math.random() - 0.5) * 8 : s.wx;
    this.wy[i] = Number.isNaN(s.wy) ? (Math.random() - 0.5) * 8 : s.wy;
    this.wz[i] = Number.isNaN(s.wz) ? (Math.random() - 0.5) * 8 : s.wz;
    this.sx[i] = s.sx; this.sy[i] = s.sy; this.sz[i] = s.sz;
    const rod = s.shape === Shape.Rod;
    const extent = rod ? s.sy * s.sy + 3 * s.sx * s.sx : s.sx * s.sx + s.sy * s.sy + s.sz * s.sz;
    this.invI[i] = 12 / Math.max(1e-4, extent);
    this.reach[i] = rod ? Math.hypot(Math.max(s.sx, s.sz), s.sy / 2) : Math.sqrt(extent) / 2;
    // each piece its own shade of its kind's colour (4.0: × 0.85..1.15)
    const k = 0.85 + Math.random() * 0.3;
    const r = Math.min(255, ((s.color >> 16) & 255) * k), g = Math.min(255, ((s.color >> 8) & 255) * k), b = Math.min(255, (s.color & 255) * k);
    this.col[i] = (r << 16) | (g << 8) | b;
    this.burn[i] = s.burn;
    this.rest[i] = 0;
    this.flags[i] = s.still ? ASLEEP | STILL : 0;
    this.order[i] = this.born++;
    this.dirty = true;
  }

  /** The slot to reuse when full: the oldest piece at rest that is not burning nor laid still, else the oldest. */
  private victim(): number {
    let best = -1, bestOrder = Infinity, any = 0, anyOrder = Infinity;
    for (let i = 0; i < this.n; i++) {
      const o = this.order[i];
      if (o < anyOrder) { anyOrder = o; any = i; }
      if (o < bestOrder && (this.flags[i] & (ASLEEP | STILL)) === ASLEEP && this.burn[i] <= 0) { bestOrder = o; best = i; }
    }
    return best >= 0 ? best : any;
  }

  /** How many pieces laid still lie within `r` of (x, z) (4.0 does not heave the ground twice in one place). */
  stillNear(x: number, z: number, r: number): number {
    let k = 0;
    for (let i = 0; i < this.n; i++) if (this.flags[i] & STILL && (this.px[i] - x) ** 2 + (this.pz[i] - z) ** 2 < r * r) k++;
    return k;
  }

  clear(): void {
    this.n = 0;
    this.dirty = true;
  }

  update(dt: number, groundAt: (x: number, z: number) => number): void {
    if (this.n === 0 && !this.dirty) return;
    this.clock += Math.min(0.1, Math.max(0, dt));
    let moved = false;
    while (this.clock >= STEP) {
      this.clock -= STEP;
      for (let i = 0; i < this.n; i++) {
        if (this.flags[i] & ASLEEP) continue;
        this.stepPiece(i, STEP, groundAt);
        moved = true;
      }
    }
    if (moved || this.dirty) this.draw();
    this.dirty = false;
  }

  /** One step of a rigid piece: gravity, then each corner below the ground struck with an impulse (4.0 stepPiece). */
  private stepPiece(i: number, dt: number, groundAt: (x: number, z: number) => number): void {
    this.vy[i] -= GRAVITY * dt;
    this.px[i] += this.vx[i] * dt; this.py[i] += this.vy[i] * dt; this.pz[i] += this.vz[i] * dt;
    let wx = this.wx[i], wy = this.wy[i], wz = this.wz[i];
    const wl = Math.hypot(wx, wy, wz), angle = wl * dt;
    if (angle > 1e-6) {
      // q = rotation(w, angle) × q
      const h = Math.sin(angle / 2) / wl, ax = wx * h, ay = wy * h, az = wz * h, aw = Math.cos(angle / 2);
      const bx = this.qx[i], by = this.qy[i], bz = this.qz[i], bw = this.qw[i];
      let nx = aw * bx + ax * bw + ay * bz - az * by, ny = aw * by - ax * bz + ay * bw + az * bx;
      let nz = aw * bz + ax * by - ay * bx + az * bw, nw = aw * bw - ax * bx - ay * by - az * bz;
      const l = Math.hypot(nx, ny, nz, nw) || 1;
      nx /= l; ny /= l; nz /= l; nw /= l;
      this.qx[i] = nx; this.qy[i] = ny; this.qz[i] = nz; this.qw[i] = nw;
    }
    const qx = this.qx[i], qy = this.qy[i], qz = this.qz[i], qw = this.qw[i];
    const rod = this.shape[i] === Shape.Rod;
    const hx = rod ? this.sx[i] : this.sx[i] / 2, hy = this.sy[i] / 2, hz = rod ? this.sz[i] : this.sz[i] / 2;
    const invI = this.invI[i];
    let touching = false, deepest = 0, lowest = Infinity;
    for (let k = 0; k < 8; k++) {
      // corner k: a box's 8, or a rod's 4 round each end
      let cx: number, cy: number, cz: number;
      if (rod) { const a = (k & 3) * Math.PI / 2; cx = Math.cos(a) * hx; cy = k < 4 ? -hy : hy; cz = Math.sin(a) * hz; }
      else { cx = k & 1 ? hx : -hx; cy = k & 2 ? hy : -hy; cz = k & 4 ? hz : -hz; }
      // r = q · c (rotate the corner by the quaternion)
      const tx = 2 * (qy * cz - qz * cy), ty = 2 * (qz * cx - qx * cz), tz = 2 * (qx * cy - qy * cx);
      const rx = cx + qw * tx + (qy * tz - qz * ty), ry = cy + qw * ty + (qz * tx - qx * tz), rz = cz + qw * tz + (qx * ty - qy * tx);
      const wpx = this.px[i] + rx, wpy = this.py[i] + ry, wpz = this.pz[i] + rz;
      const pen = groundAt(wpx, wpz) - wpy;
      if (-pen < lowest) lowest = -pen;
      if (pen <= 0) continue;
      touching = true;
      if (pen > deepest) deepest = pen;
      // the corner's velocity (w × r + v), and the impulse that stops it going in
      wx = this.wx[i]; wy = this.wy[i]; wz = this.wz[i];
      const vpx = wy * rz - wz * ry + this.vx[i], vpy = wz * rx - wx * rz + this.vy[i], vpz = wx * ry - wy * rx + this.vz[i];
      if (vpy >= 0) continue;
      const kk = 1 + invI * (rx * rx + rz * rz);
      const j = (-(1 + 0.25) * vpy) / kk;
      this.vy[i] += j;
      // r × up = (−rz, 0, rx)
      this.wx[i] += -rz * invI * j; this.wz[i] += rx * invI * j;
      // friction across the contact, at most a share of the push
      const tl = Math.hypot(vpx, vpz);
      if (tl > 1e-6) {
        const f = Math.min(tl / kk, 0.6 * j);
        const fx = (-vpx / tl) * f, fz = (-vpz / tl) * f;
        this.vx[i] += fx; this.vz[i] += fz;
        this.wx[i] += invI * (ry * fz);
        this.wy[i] += invI * (rz * fx - rx * fz);
        this.wz[i] += invI * (-ry * fx);
      }
    }
    if (deepest > 0) this.py[i] += deepest;
    if (touching) {
      this.wx[i] *= 0.985; this.wy[i] *= 0.985; this.wz[i] *= 0.985;
      this.vx[i] *= 0.995; this.vz[i] *= 0.995;
    }
    // at rest as Box2D judges it: the speed of the body's farthest point
    const reach = this.reach[i];
    const slow = Math.hypot(this.vx[i], this.vy[i], this.vz[i]) + Math.hypot(this.wx[i], this.wy[i], this.wz[i]) * reach < 0.15 + 0.55 * reach;
    const resting = touching || lowest < 0.05;
    this.rest[i] = resting && slow ? this.rest[i] + dt : 0;
    if (this.rest[i] > 0.6) {
      this.flags[i] |= ASLEEP;
      this.vx[i] = this.vy[i] = this.vz[i] = 0;
      this.wx[i] = this.wy[i] = this.wz[i] = 0;
      if (this.burn[i] > 0) {
        this.onRest?.(this.px[i], this.py[i], this.pz[i], Math.max(this.sx[i], this.sz[i]), this.burn[i]);
        this.burn[i] = 0;
      }
    }
  }

  /** All pieces' matrices and colours, shape by shape (bounded by MAX_PIECES; only while something moves or changed). */
  private draw(): void {
    const counts = this.counts;
    counts.fill(0);
    const meshes = this.meshes;
    for (let i = 0; i < this.n; i++) {
      const mesh = meshes[this.shape[i]];
      const k = counts[this.shape[i]];
      if (k >= mesh.instanceMatrix.count) continue;
      counts[this.shape[i]] = k + 1;
      this.p.set(this.px[i], this.py[i], this.pz[i]);
      this.q.set(this.qx[i], this.qy[i], this.qz[i], this.qw[i]);
      // shells and vehicle models are drawn at their own size (the size is their box, for the physics)
      if (this.shape[i] >= BASE_SHAPES) this.s.set(1, 1, 1);
      else this.s.set(this.sx[i], this.sy[i], this.sz[i]);
      this.mat.compose(this.p, this.q, this.s);
      mesh.setMatrixAt(k, this.mat);
      this.c.setHex(this.col[i]);
      if (mesh.instanceColor) mesh.setColorAt(k, this.c);
      else (mesh.geometry.getAttribute('ipaint') as THREE.InstancedBufferAttribute).setXYZ(k, this.c.r, this.c.g, this.c.b);
    }
    for (let m = 0; m < meshes.length; m++) {
      const mesh = meshes[m], n = counts[m];
      mesh.count = n;
      mesh.visible = n > 0;
      // only the instances written go up (4.0 uploadWritten)
      for (const a of [mesh.instanceMatrix, mesh.instanceColor ?? mesh.geometry.getAttribute('ipaint') as THREE.InstancedBufferAttribute]) {
        if (!a) continue;
        a.clearUpdateRanges();
        if (n) a.addUpdateRange(0, n * a.itemSize);
        a.needsUpdate = true;
      }
    }
  }

  /** One piece of every shape far under the ground, drawn at load so their pipelines are compiled then. */
  warm(on: boolean): void {
    this.mat.makeTranslation(0, -5000, 0);
    for (const mesh of this.meshes) {
      if (on) { mesh.setMatrixAt(0, this.mat); mesh.instanceMatrix.needsUpdate = true; }
      mesh.count = on ? 1 : 0;
      mesh.visible = on;
    }
    if (!on) this.dirty = true;
  }
}

/** A vehicle body's shape only (position, normal, index), with room for each wreck's paint. */
function wreckGeometry(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', src.getAttribute('position'));
  g.setAttribute('normal', src.getAttribute('normal'));
  if (src.index) g.setIndex(src.index);
  g.setAttribute('ipaint', new THREE.InstancedBufferAttribute(new Float32Array(WRECKS * 3), 3));
  return g;
}

/** A broken slab of road or footway: an irregular outline with notches, extruded thin (4.0's jag), unit size. */
function slabGeometry(): THREE.BufferGeometry {
  const jag = new THREE.Shape();
  const corners = 11;
  for (let k = 0; k < corners; k++) {
    const a = (k / corners) * Math.PI * 2;
    const r = 0.36 + 0.14 * Math.sin(k * 2.7 + 1.3) + (k % 3 === 0 ? -0.1 : 0.04);
    if (k) jag.lineTo(Math.cos(a) * r, Math.sin(a) * r); else jag.moveTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  jag.closePath();
  return new THREE.ExtrudeGeometry(jag, { depth: 1, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.04, bevelSegments: 1 })
    .translate(0, 0, -0.5).rotateX(-Math.PI / 2);
}

/** A car's side extruded across (4.0's shell for a vehicle without a model): unit box, x along the car. */
function shellGeometry(): THREE.BufferGeometry {
  const side = new THREE.Shape();
  const profile: Array<[number, number]> = [[-0.5, -0.5], [0.5, -0.5], [0.5, -0.12], [0.44, 0.0], [0.2, 0.05], [0.08, 0.48], [-0.28, 0.5], [-0.42, 0.08], [-0.5, 0.02]];
  profile.forEach(([x, y], i) => (i ? side.lineTo(x, y) : side.moveTo(x, y)));
  side.closePath();
  return new THREE.ExtrudeGeometry(side, { depth: 1, bevelEnabled: false }).translate(0, 0, -0.5);
}

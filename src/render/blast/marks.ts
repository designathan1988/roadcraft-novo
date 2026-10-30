// What an explosion leaves on the ground: craters (a hole with its broken lip, scorch and, through paving, cracks) and
// blots of soot round it, as Roadcraft 4.0 draws them (render/blast.ts craterTexture, soot), with its canvas textures.
// Each mark is a small grid laid on the ground vertex by vertex (a flat disc cut into the slopes and sank under the
// roads where they stand above the terrain), in one fixed buffer per kind: a ring of slots, the oldest reused, and
// only the slot written goes up. Nothing is done a frame.

import * as THREE from 'three/webgpu';

const MAX_CRATERS = 60;
const MAX_SOOT = 600;
/** Vertices along a side of a crater's grid, and of a blot's. */
const CRATER_GRID = 9;
const SOOT_GRID = 4;
/** Above the ground it lies on (the terrain under a road stands within a few cm of it: a42fa72). */
const LIFT = 0.07;

/** One kind of mark: `cap` grids of `g` × `g` vertices in one geometry. */
class MarkBatch {
  readonly mesh: THREE.Mesh;
  private pos: THREE.BufferAttribute;
  private uv: THREE.BufferAttribute;
  private next = 0;
  private n = 0;
  private cap: number;
  private g: number;
  constructor(cap: number, g: number, map: THREE.Texture | null, order: number, name: string) {
    this.cap = cap; this.g = g;
    const vpm = g * g, geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(cap * vpm * 3), 3);
    this.uv = new THREE.BufferAttribute(new Float32Array(cap * vpm * 2), 2);
    const quads = (g - 1) * (g - 1), idx = new Uint32Array(cap * quads * 6);
    for (let m = 0, k = 0; m < cap; m++) for (let j = 0; j < g - 1; j++) for (let i = 0; i < g - 1; i++) {
      const a = m * vpm + j * g + i, b = a + 1, c = a + g, d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
    geo.setAttribute('position', this.pos);
    geo.setAttribute('uv', this.uv);
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(cap * vpm * 3).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);
    const mat = new THREE.MeshStandardNodeMaterial({ map, transparent: true, depthWrite: false, roughness: 1 });
    // over the ground and the roads: a positive offset pulls toward the camera here (reversed depth, roads.ts uses 1/2)
    mat.polygonOffset = true; mat.polygonOffsetFactor = order; mat.polygonOffsetUnits = order;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = order;
    this.mesh.visible = false;
  }

  /** A mark centred at (x, z), `size` across, turned `angle`, laid on `groundAt`. */
  lay(x: number, z: number, size: number, angle: number, groundAt: (x: number, z: number) => number): void {
    const g = this.g, vpm = g * g, slot = this.next, c = Math.cos(angle), s = Math.sin(angle);
    const p = this.pos.array as Float32Array, t = this.uv.array as Float32Array;
    for (let j = 0; j < g; j++) for (let i = 0; i < g; i++) {
      const u = i / (g - 1), v = j / (g - 1), lx = (u - 0.5) * size, lz = (v - 0.5) * size;
      const wx = x + lx * c - lz * s, wz = z + lx * s + lz * c, o = slot * vpm + j * g + i;
      p[o * 3] = wx; p[o * 3 + 1] = groundAt(wx, wz) + LIFT; p[o * 3 + 2] = wz;
      t[o * 2] = u; t[o * 2 + 1] = v;
    }
    for (const a of [this.pos, this.uv]) { a.addUpdateRange(slot * vpm * a.itemSize, vpm * a.itemSize); a.needsUpdate = true; }
    this.next = (slot + 1) % this.cap;
    this.n = Math.min(this.cap, this.n + 1);
    this.show();
  }

  clear(): void { this.n = this.next = 0; this.show(); }

  private show(): void {
    this.mesh.geometry.setDrawRange(0, this.n * (this.g - 1) * (this.g - 1) * 6);
    this.mesh.visible = this.n > 0;
  }

  /** One mark far under the ground (compiled at load). */
  warm(on: boolean): void {
    if (on) { this.lay(0, 0, 1, 0, () => -5000); this.n = 1; }
    else this.clear();
    this.mesh.visible = on;
  }
}

export class Marks {
  readonly group = new THREE.Group();
  private road = new MarkBatch(MAX_CRATERS, CRATER_GRID, craterTexture(true), 4, 'blast-craters');
  private earth = new MarkBatch(MAX_CRATERS, CRATER_GRID, craterTexture(false), 4, 'blast-craters');
  private soot = new MarkBatch(MAX_SOOT, SOOT_GRID, sootTexture(), 3, 'blast-soot');

  private groundAt: (x: number, z: number) => number;
  constructor(groundAt: (x: number, z: number) => number) {
    this.groundAt = groundAt;
    this.group.add(this.road.mesh, this.earth.mesh, this.soot.mesh);
  }

  /** A crater at (x, z), `r` across its scorch. */
  crater(x: number, z: number, r: number, road: boolean): void {
    (road ? this.road : this.earth).lay(x, z, r * 2, Math.random() * Math.PI * 2, this.groundAt);
  }

  /** A blot of soot and ash at (x, z), `r` across: the street left dirty. */
  blot(x: number, z: number, r: number): void {
    this.soot.lay(x, z, r * 2, Math.random() * Math.PI * 2, this.groundAt);
  }

  clear(): void { this.road.clear(); this.earth.clear(); this.soot.clear(); }

  warm(on: boolean): void { this.road.warm(on); this.earth.warm(on); this.soot.warm(on); }
}

/** Roadcraft 4.0's crater (render/blast.ts craterTexture): scorch, a dark hole with a lighter broken lip, clods, cracks. */
function craterTexture(road: boolean): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  // 512 (4.0: 256): a crater of a strong bomb is tens of metres across
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  let seed = road ? 7 : 13;
  const rnd = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const mid = size / 2;
  for (let i = 0; i < 40; i++) {
    const a = rnd() * Math.PI * 2, r = size * (0.15 + rnd() * 0.3);
    const x = mid + Math.cos(a) * r * 0.6, y = mid + Math.sin(a) * r * 0.6, rad = size * (0.08 + rnd() * 0.14);
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    grad.addColorStop(0, 'rgba(12, 10, 9, 0.55)');
    grad.addColorStop(1, 'rgba(12, 10, 9, 0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
  }
  const hole = size * 0.26;
  g.beginPath();
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2, r = hole * (0.82 + rnd() * 0.3);
    if (i) g.lineTo(mid + Math.cos(a) * r, mid + Math.sin(a) * r); else g.moveTo(mid + Math.cos(a) * r, mid + Math.sin(a) * r);
  }
  g.closePath();
  const grad = g.createRadialGradient(mid, mid, 0, mid, mid, hole * 1.1);
  grad.addColorStop(0, road ? 'rgba(28, 22, 17, 1)' : 'rgba(34, 25, 17, 1)');
  grad.addColorStop(0.7, road ? 'rgba(58, 46, 36, 1)' : 'rgba(70, 52, 34, 1)');
  grad.addColorStop(1, road ? 'rgba(92, 86, 80, 1)' : 'rgba(96, 74, 50, 1)');
  g.fillStyle = grad;
  g.fill();
  g.lineWidth = 3 * size / 256;
  g.strokeStyle = road ? 'rgba(120, 116, 110, 0.9)' : 'rgba(110, 86, 60, 0.9)';
  g.stroke();
  // (four times 4.0's 160 clods at half the size: the same grit, finer when a strong bomb's crater is tens of metres)
  for (let i = 0; i < 640; i++) {
    const a = rnd() * Math.PI * 2, r = hole * (0.2 + rnd() * 1.6);
    const s = (1 + rnd() * 3) * size / 512;
    const shade = road ? 40 + rnd() * 70 : 50 + rnd() * 50;
    g.fillStyle = road ? `rgba(${shade},${shade},${shade + 4},0.9)` : `rgba(${shade + 30},${shade + 12},${shade - 10},0.9)`;
    // round clods (4.0's squares became big blurred squares at a strong bomb's size)
    g.beginPath(); g.arc(mid + Math.cos(a) * r, mid + Math.sin(a) * r, s / 2, 0, Math.PI * 2); g.fill();
  }
  if (road) {
    g.strokeStyle = 'rgba(14, 12, 12, 0.85)';
    for (let i = 0; i < 11; i++) {
      let a = rnd() * Math.PI * 2, r = hole * 0.9;
      let x = mid + Math.cos(a) * r, y = mid + Math.sin(a) * r;
      g.lineWidth = 2.2 * size / 256;
      g.beginPath(); g.moveTo(x, y);
      const length = size * (0.12 + rnd() * 0.22);
      for (let s = 0; s < 8; s++) {
        a += (rnd() - 0.5) * 0.7;
        r = length / 8;
        x += Math.cos(a) * r; y += Math.sin(a) * r;
        g.lineTo(x, y);
        g.lineWidth = Math.max(0.6, 2.2 - s * 0.25) * size / 256;
        if (rnd() < 0.25) {
          const b = a + (rnd() < 0.5 ? 0.8 : -0.8);
          g.moveTo(x, y); g.lineTo(x + Math.cos(b) * r * 2, y + Math.sin(b) * r * 2); g.moveTo(x, y);
        }
      }
      g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A soft dark blot of soot (4.0's soot map): many of them, kept. */
function sootTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  let seed = 29;
  const rnd = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let k = 0; k < 26; k++) {
    const x = 64 + (rnd() - 0.5) * 70, y = 64 + (rnd() - 0.5) * 70, r = 10 + rnd() * 34;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(20,17,14,${0.25 + rnd() * 0.25})`);
    grad.addColorStop(1, 'rgba(20,17,14,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

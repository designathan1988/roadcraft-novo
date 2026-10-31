// What an explosion leaves on the ground: craters (a hole with its broken lip, scorch and, through paving, cracks) and
// blots of soot round it, as Roadcraft 4.0 draws them (render/blast.ts craterTexture, soot); their images are drawn
// by blast/marksWorker.ts off the main thread and fill these textures when they arrive (until then they are clear).
// Each mark is a small grid laid on the ground vertex by vertex (a flat disc cut into the slopes and sank under the
// roads where they stand above the terrain), in one fixed buffer per kind: a ring of slots, the oldest reused, and
// only the slot written goes up. Nothing is done a frame.

import * as THREE from 'three/webgpu';
import { MARK_SIZE, type MarkImage } from './marksWorker.ts';

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
  constructor(cap: number, g: number, map: THREE.Texture, order: number, name: string) {
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
    const up = new Float32Array(cap * vpm * 3);
    for (let i = 1; i < up.length; i += 3) up[i] = 1;
    geo.setAttribute('normal', new THREE.BufferAttribute(up, 3));
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
    this.pos.addUpdateRange(slot * vpm * 3, vpm * 3); this.pos.needsUpdate = true;
    this.uv.addUpdateRange(slot * vpm * 2, vpm * 2); this.uv.needsUpdate = true;
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
  private images: Record<MarkImage, THREE.DataTexture> = {
    'crater-road': markTexture(MARK_SIZE['crater-road']), 'crater-earth': markTexture(MARK_SIZE['crater-earth']), soot: markTexture(MARK_SIZE.soot),
  };
  private road = new MarkBatch(MAX_CRATERS, CRATER_GRID, this.images['crater-road'], 4, 'blast-craters');
  private earth = new MarkBatch(MAX_CRATERS, CRATER_GRID, this.images['crater-earth'], 4, 'blast-craters');
  private soot = new MarkBatch(MAX_SOOT, SOOT_GRID, this.images.soot, 3, 'blast-soot');

  private groundAt: (x: number, z: number) => number;
  constructor(groundAt: (x: number, z: number) => number) {
    this.groundAt = groundAt;
    this.group.add(this.road.mesh, this.earth.mesh, this.soot.mesh);
    if (typeof Worker === 'undefined') return;
    const w = new Worker(new URL('./marksWorker.ts', import.meta.url), { type: 'module', name: 'blast-marks' });
    w.onmessage = (e: MessageEvent<{ name: MarkImage; data: Uint8Array }>) => {
      // the worker's array becomes the texture's data (the same size): no copy on the main thread
      const t = this.images[e.data.name];
      t.image.data = e.data.data;
      t.needsUpdate = true;
    };
    w.postMessage(null);
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

/** A mark's colour map, clear until blast/marksWorker.ts sends its texels; sampled as a canvas texture is (rows top
 * down, so flipped; linear with mipmaps; sRGB). */
function markTexture(size: number): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array(size * size * 4), size, size, THREE.RGBAFormat);
  t.flipY = true;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

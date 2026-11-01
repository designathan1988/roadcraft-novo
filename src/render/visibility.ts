// Visibility beyond the frustum. A conservative software occluder, following the documented hierarchical Z-buffer and
// masked software occlusion culling (Greene et al. 1993; Downs et al. 2001; Hasselgren et al. 2016): the walls of the
// buildings drawn near the eye are laid into a small depth buffer at the farthest corner of each face, the buffer is
// reduced to a max pyramid, and a box is hidden only when every texel under it holds an occluder in front of the box's
// nearest point. It never hides a box that could be seen: a texel not covered whole is left empty (Infinity), a face
// touching the near plane is not laid, and the depth of a face is its farthest corner.
//
// The occluders are the buildings of the cells the building layer chose at L0/L1 this frame, above their ground floor:
// the upper walls are solid, the ground floor may be a shop window or an open arcade, so it is never used as an occluder.
// A cell mesh hidden in the colour pass is shown again inside each shadow cascade (Post's CachedShadowNode), so a caster
// never loses its shadow.

import type * as THREE from 'three/webgpu';
import { heightAt } from '../world/heights.ts';
import type { World } from '../world/world.ts';

/** Texels across the buffer (4.0's width): a 1920-wide screen gets one texel per 7.5 px. */
const WIDTH = 256;
/** How far round the eye a building may occlude (m): past it a wall spans a few texels and hides little. */
export const OCCLUDER_REACH = 1500;
/** A box over more texels than this is not read texel by texel: it spans most of the screen and is all but never hidden. */
const MOST_TEXELS_READ = 8192;
/** The ground floor is not an occluder: it may be a shop window or an open arcade (8 m covers the tallest shopfront). */
const GROUND_FLOOR = 8;

/** A world-space axis-aligned box used by the cell layers (metres). */
export interface WorldBox { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }

export interface OcclusionStats { occluders: number; texels: number; tested: number; hidden: number; buildMs: number }

/**
 * The small depth pyramid. `begin` prepares the frame's camera; `addBox` lays one building's walls; `end` reduces the
 * pyramid; `hidden` answers for a world box.
 */
export class OcclusionBuffer {
  readonly width = WIDTH;
  height = 0;
  private levels: Float32Array[] = [];
  private widths: number[] = [];
  private heights: number[] = [];
  private readonly vp = new Float64Array(16);
  private readonly view = new Float64Array(16);
  private near = 0.1;
  private eyeX = 0;
  private eyeY = 0;
  private eyeZ = 0;
  private laid = false;
  readonly stats: OcclusionStats = { occluders: 0, texels: 0, tested: 0, hidden: 0, buildMs: 0 };
  private readonly quad = new Float64Array(16);
  private readonly corners = new Float64Array(24);

  /** Starts one frame's buffer from `camera`. `aspect` is width / height of the view. */
  begin(camera: THREE.Camera, aspect: number): void {
    const height = Math.max(8, Math.round(WIDTH / Math.max(0.25, aspect)));
    if (height !== this.height) this.resize(height);
    const p = camera.projectionMatrix.elements, v = camera.matrixWorldInverse.elements;
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += p[k * 4 + r] * v[c * 4 + k];
        this.vp[c * 4 + r] = sum;
      }
    }
    for (let i = 0; i < 16; i++) this.view[i] = v[i];
    this.near = (camera as THREE.PerspectiveCamera).near;
    const e = camera.matrixWorld.elements;
    this.eyeX = e[12]; this.eyeY = e[13]; this.eyeZ = e[14];
    this.levels[0].fill(Infinity);
    this.laid = false;
    const s = this.stats;
    s.occluders = 0; s.texels = 0; s.tested = 0; s.hidden = 0;
  }

  /** Lays one building's walls and top. `bottom`/`top` are world heights; `rot` turns the local x/z footprint. */
  addBox(cx: number, cz: number, hw: number, hd: number, rot: number, bottom: number, top: number): void {
    // Past the reach a wall spans a few texels and hides little (OCCLUDER_REACH): not laid, and the frame's build cost
    // stays bounded at any resolution (the cells drawn can reach farther than 1500 m at a high pixel scale).
    const rdx = cx - this.eyeX, rdz = cz - this.eyeZ;
    if (rdx * rdx + rdz * rdz > OCCLUDER_REACH * OCCLUDER_REACH) return;
    const c = Math.cos(rot), s = Math.sin(rot);
    const bx = this.wallX, bz = this.wallZ, tx = this.topX, tz = this.topZ;
    const lx = this.wallLX, lz = this.wallLZ;
    lx[0] = -hw; lx[1] = hw; lx[2] = hw; lx[3] = -hw;
    lz[0] = -hd; lz[1] = -hd; lz[2] = hd; lz[3] = hd;
    for (let k = 0; k < 4; k++) {
      bx[k] = cx + lx[k] * c - lz[k] * s; bz[k] = cz + lx[k] * s + lz[k] * c;
      tx[k] = bx[k]; tz[k] = bz[k];
    }
    let laid = false;
    // The four walls. A wall is laid only when it turns toward the eye.
    for (let k = 0; k < 4; k++) {
      const n = (k + 1) & 3;
      // Outward normal of the local walls: -z, +x, +z, -x.
      const nx = k === 1 ? 1 : k === 3 ? -1 : 0;
      const nz = k === 0 ? -1 : k === 2 ? 1 : 0;
      const wnx = nx * c - nz * s, wnz = nx * s + nz * c;
      const mx = (bx[k] + bx[n]) * 0.5, mz = (bz[k] + bz[n]) * 0.5;
      if ((this.eyeX - mx) * wnx + (this.eyeZ - mz) * wnz <= 0) continue;
      const q = this.quad;
      if (!this.project(bx[k], bottom, bz[k], q, 0)) continue;
      if (!this.project(bx[n], bottom, bz[n], q, 4)) continue;
      if (!this.project(bx[n], top, bz[n], q, 8)) continue;
      if (!this.project(bx[k], top, bz[k], q, 12)) continue;
      if (this.layQuad(q)) laid = true;
    }
    // The top, when the eye is above it.
    if (this.eyeY > top) {
      const q = this.quad;
      let ok = true;
      for (let k = 0; k < 4; k++) if (!this.project(tx[k], top, tz[k], q, k * 4)) { ok = false; break; }
      if (ok && this.layQuad(q)) laid = true;
    }
    if (laid) this.stats.occluders++;
  }

  /** Reduces the buffer to the max pyramid. */
  end(): void {
    if (this.stats.occluders > 0) this.laid = true;
    for (let l = 1; l < this.levels.length; l++) {
      const below = this.levels[l - 1], bw = this.widths[l - 1], bh = this.heights[l - 1];
      const out = this.levels[l], w = this.widths[l], h = this.heights[l];
      for (let j = 0; j < h; j++) {
        const j0 = j * 2, j1 = Math.min(bh - 1, j0 + 1);
        for (let i = 0; i < w; i++) {
          const i0 = i * 2, i1 = Math.min(bw - 1, i0 + 1);
          out[j * w + i] = Math.max(below[j0 * bw + i0], below[j0 * bw + i1], below[j1 * bw + i0], below[j1 * bw + i1]);
        }
      }
    }
  }

  /** Whether the world box is behind every occluder under it. Conservative: false when in doubt. */
  hidden(box: WorldBox): boolean {
    if (!this.laid) return false;
    this.stats.tested++;
    let sx0 = Infinity, sy0 = Infinity, sx1 = -Infinity, sy1 = -Infinity, nearest = Infinity;
    for (let k = 0; k < 8; k++) {
      const x = k & 1 ? box.x1 : box.x0, y = k & 2 ? box.y1 : box.y0, z = k & 4 ? box.z1 : box.z0;
      if (!this.project(x, y, z, this.corners, k * 3)) return false;
      const c = this.corners;
      if (c[k * 3] < sx0) sx0 = c[k * 3];
      if (c[k * 3] > sx1) sx1 = c[k * 3];
      if (c[k * 3 + 1] < sy0) sy0 = c[k * 3 + 1];
      if (c[k * 3 + 1] > sy1) sy1 = c[k * 3 + 1];
      if (c[k * 3 + 2] < nearest) nearest = c[k * 3 + 2];
    }
    const w = this.width, h = this.height;
    if (sx1 < 0 || sy1 < 0 || sx0 >= w || sy0 >= h) return false;
    const i0 = Math.max(0, Math.floor(sx0)), i1 = Math.min(w - 1, Math.floor(sx1));
    const j0 = Math.max(0, Math.floor(sy0)), j1 = Math.min(h - 1, Math.floor(sy1));
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > MOST_TEXELS_READ) return false;
    let top = 0;
    while (top < this.levels.length - 1 && ((i1 >> top) - (i0 >> top) > 3 || (j1 >> top) - (j0 >> top) > 3)) top++;
    for (let level = top; level >= 0; level--) {
      const data = this.levels[level], lw = this.widths[level];
      const li0 = i0 >> level, li1 = i1 >> level, lj0 = j0 >> level, lj1 = j1 >> level;
      let all = true;
      for (let j = lj0; j <= lj1 && all; j++) {
        const row = j * lw;
        for (let i = li0; i <= li1; i++) if (!(data[row + i] < nearest)) { all = false; break; }
      }
      if (all) { this.stats.hidden++; return true; }
    }
    return false;
  }

  /** Forgets the frame (another city, a view the buffer cannot stand for). */
  reset(): void {
    this.laid = false;
    if (this.levels[0]) this.levels[0].fill(Infinity);
  }

  private resize(height: number): void {
    this.height = height;
    this.levels = []; this.widths = []; this.heights = [];
    let w = WIDTH, h = height;
    for (;;) {
      this.levels.push(new Float32Array(w * h));
      this.widths.push(w); this.heights.push(h);
      if (w === 1 && h === 1) break;
      w = Math.max(1, (w + 1) >> 1); h = Math.max(1, (h + 1) >> 1);
    }
  }

  /** Projects a world point into `out[into..into+2]` (texel x, texel y, view depth); false at or behind the near plane. */
  private project(x: number, y: number, z: number, out: Float64Array, into: number): boolean {
    const v = this.view;
    const depth = -(v[2] * x + v[6] * y + v[10] * z + v[14]);
    if (!(depth > this.near)) return false;
    const m = this.vp;
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (!(cw > 0)) return false;
    const cx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / cw;
    const cy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw;
    out[into] = (cx * 0.5 + 0.5) * this.width;
    out[into + 1] = (0.5 - cy * 0.5) * this.height;
    out[into + 2] = depth;
    return true;
  }

  /**
   * Lays a convex projected quad at its farthest corner's depth, over the texels it covers whole. A texel touched only in
   * part is left empty: the buffer is never wider than what stands.
   */
  private layQuad(q: Float64Array): boolean {
    const ax = q[0], ay = q[1], bx = q[4], by = q[5], cx = q[8], cy = q[9], dx = q[12], dy = q[13];
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) + (cx - ax) * (dy - ay) - (cy - ay) * (dx - ax);
    if (Math.abs(area) < 1) return false;
    const depth = Math.max(q[2], q[6], q[10], q[14]);
    let yMin = Math.min(ay, by, cy, dy), yMax = Math.max(ay, by, cy, dy);
    yMin = Math.max(0, Math.ceil(yMin - 0.5)); yMax = Math.min(this.height - 1, Math.floor(yMax - 0.5));
    if (yMin > yMax) return false;
    const xs = this.edgeCrossings;
    const w = this.width;
    const data = this.levels[0];
    let texels = 0;
    for (let j = yMin; j <= yMax; j++) {
      const y = j + 0.5;
      let n = 0;
      for (let e = 0; e < 4; e++) {
        const e1 = (e + 1) & 3;
        const x0 = q[e * 4], y0 = q[e * 4 + 1], x1 = q[e1 * 4], y1 = q[e1 * 4 + 1];
        if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
          xs[n++] = x0 + (y - y0) * (x1 - x0) / (y1 - y0);
          if (n === 2) break;
        }
      }
      if (n < 2) continue;
      const lo = Math.min(xs[0], xs[1]), hi = Math.max(xs[0], xs[1]);
      // Texels [i, i+1] covered whole: i >= lo and i+1 <= hi.
      const i0 = Math.max(0, Math.ceil(lo)), i1 = Math.min(w - 1, Math.floor(hi) - 1);
      if (i0 > i1) continue;
      const row = j * w;
      for (let i = i0; i <= i1; i++) {
        if (depth < data[row + i]) data[row + i] = depth;
        texels++;
      }
    }
    this.stats.texels += texels;
    return texels > 0;
  }

  private readonly edgeCrossings = new Float64Array(2);
  private readonly wallX = new Float64Array(4);
  private readonly wallZ = new Float64Array(4);
  private readonly topX = new Float64Array(4);
  private readonly topZ = new Float64Array(4);
  private readonly wallLX = new Float64Array(4);
  private readonly wallLZ = new Float64Array(4);
}

/** The colours shown in the shadow passes: a caster hidden from the colour pass is shown inside each cascade. */
const shadowHidden = new Set<THREE.Mesh>();

/** Marks a cell mesh hidden (or not) by this frame's occlusion. Hidden meshes are still in the scene: the shadow pass shows them. */
export function markOccluded(mesh: THREE.Mesh, hidden: boolean): void {
  if (hidden) { shadowHidden.add(mesh); mesh.visible = false; }
  else if (shadowHidden.delete(mesh)) mesh.visible = true;
}

/** A mesh leaving the scene: it must not be kept in the shadow list. */
export function forgetOccluded(mesh: THREE.Mesh): void {
  if (shadowHidden.delete(mesh)) mesh.visible = true;
}

/** Shows every colour-occluded caster for a shadow pass (`on`) and hides them again after it. */
export function showOccludedForShadows(on: boolean): void {
  for (const mesh of shadowHidden) mesh.visible = on;
}

/** How many meshes this frame's occlusion hid from the colour pass (measurement). */
export function occludedMeshes(): number { return shadowHidden.size; }

/** Another city / a reset: nothing is hidden. */
export function clearOccluded(): void {
  for (const mesh of shadowHidden) mesh.visible = true;
  shadowHidden.clear();
}

/**
 * The building occluders of one frame: the walls above the ground floor of the buildings in the cells the building
 * layer drew at L0/L1. The cells are given by the meshes the layer chose, so a building whose cell is drawn only as a
 * massing (an L2 tile or L3 plate) is never used as an occluder.
 */
export class BuildingOccluders {
  private readonly world: World;
  private readonly buffer = new OcclusionBuffer();
  private ready = false;
  readonly stats: OcclusionStats = this.buffer.stats;

  constructor(world: World) { this.world = world; }

  /** Builds this frame's buffer from the cell meshes the building layer chose. Runs before the layer filters its list. */
  build(camera: THREE.Camera, meshes: Iterable<THREE.Mesh>): void {
    const t0 = performance.now();
    const aspect = cameraAspect(camera);
    this.buffer.begin(camera, aspect);
    const cells = this.cells;
    cells.clear();
    for (const mesh of meshes) {
      const u = mesh.userData as { cell?: number; level?: number; fade?: number; dead?: boolean; publisher?: boolean };
      if (u.cell === undefined || (u.level ?? 0) > 1 || u.dead || u.publisher || (u.fade ?? 1) < 1) continue;
      cells.add(u.cell);
    }
    const w = this.world;
    this.cellCount = 0;
    for (const cell of cells) {
      const ver = w.cellVersion[cell];
      let e = this.cache.get(cell);
      if (!e || e.ver !== ver) { e = this.collectCell(cell, ver); this.cache.set(cell, e); }
      for (let i = 0; i < e.n; i++) {
        const o = i * 7;
        this.buffer.addBox(e.data[o], e.data[o + 1], e.data[o + 2], e.data[o + 3], e.data[o + 4], e.data[o + 5], e.data[o + 6]);
      }
      this.cellCount += e.n;
    }
    this.buffer.end();
    this.ready = this.cellCount > 0;
    this.stats.buildMs = performance.now() - t0;
  }

  /** The cell's solid wall boxes, collected once per cell version (an edit bumps the version). */
  private collectCell(cell: number, ver: number): CellBoxes {
    const out = this.scratch;
    out.length = 0;
    this.currentCell = cell;
    this.world.buildingIndex.queryCell(cell, this.collectBuilding);
    return { ver, data: new Float64Array(out), n: out.length / 7 };
  }

  /** One building of the current cell, if it is a plain solid building the cell layer draws. */
  private readonly collectBuilding = (id: number): void => {
    const w = this.world, col = w.buildings.cols, cell = this.currentCell;
    if (!w.buildings.alive[id] || col.cell[id] !== cell || col.shapeN[id] || w.ruined.has(id)) return;
    const height = col.top[id];
    if (!(height > 0)) return;
    const x = col.x[id], z = col.z[id], rot = col.rot[id];
    const c = Math.cos(rot), s = Math.sin(rot);
    const hw = col.w[id] / 2, hd = col.d[id] / 2;
    // `top` is the wall height over the building's own ground. The box used here stays inside the walls: its bottom on
    // the highest ground of the footprint and its top on the lowest ground plus that height.
    let low = heightAt(w.heights, x, z), high = low;
    for (let k = 0; k < 8; k += 2) {
      const lx = GROUND_CORNERS[k] * hw, lz = GROUND_CORNERS[k + 1] * hd;
      const gy = heightAt(w.heights, x + lx * c - lz * s, z + lx * s + lz * c);
      if (gy < low) low = gy;
      if (gy > high) high = gy;
    }
    const bottom = high + GROUND_FLOOR;
    const top = low + height;
    if (top <= bottom + 0.5) return;
    this.scratch.push(x, z, hw, hd, rot, bottom, top);
  };

  private currentCell = -1;
  private cellCount = 0;
  private readonly scratch: number[] = [];
  private readonly cache = new Map<number, CellBoxes>();

  /** Whether the world box is hidden behind this frame's building walls. */
  hidden(box: WorldBox): boolean {
    return this.ready && this.buffer.hidden(box);
  }

  reset(): void {
    this.ready = false;
    this.buffer.reset();
    this.cache.clear();
    clearOccluded();
  }

  private readonly cells = new Set<number>();
}

interface CellBoxes { ver: number; data: Float64Array; n: number }

/** The footprint corners as multiples of the half width/depth: (-1,-1), (1,-1), (1,1), (-1,1). */
const GROUND_CORNERS = new Float64Array([-1, -1, 1, -1, 1, 1, -1, 1]);

function cameraAspect(camera: THREE.Camera): number {
  const p = camera as THREE.PerspectiveCamera;
  if (p.isPerspectiveCamera) return p.aspect || 1;
  const o = camera as THREE.OrthographicCamera;
  const w = o.right - o.left, h = o.top - o.bottom;
  return w > 0 && h > 0 ? w / h : 1;
}

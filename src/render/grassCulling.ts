// The grass field's GPU culling (WebGPU): one compute pass keeps the tufts whose column is inside the view, and the
// draw reads its count and list indirectly (the props' pattern). The frustum test uses the field's conservative height
// range, sampled on the CPU from the shared heights; no height-texture read in the compute. The kept tufts are a
// superset of the visible ones, so the image cannot change (three.js StorageBufferNode readWrite / IndirectStorage-
// BufferAttribute, docs/pages/StorageBufferNode.md and docs/pages/IndirectStorageBufferAttribute.md).
//
// This module owns everything the cull needs, keeping the terrain renderer free of it (the file-size gate).

import * as THREE from 'three/webgpu';
import { HEIGHT_SPACING, MAP_HALF } from '../config.ts';
import { heightAt } from '../world/heights.ts';
import { T, type Node } from './tsl.ts';

const {
  Fn, If, storage, uniform, uniformArray, instanceIndex, atomicAdd, atomicStore, uint, float, vec2, vec3, floor, hash,
  step, dot, abs,
} = T;

/** Grass tufts: grid spacing (m), tufts per side of the camera-locked grid, and blades per tuft. */
export const TUFT_STEP = 0.9;
export const TUFT_SIDE = 160;
export const BLADES = 7;
const TUFTS = TUFT_SIDE * TUFT_SIDE;

/**
 * The conservative height range of the field's square, read from the shared heights at every grid point inside it
 * (one extra ring covers the bilinear support). A tuft can never be dropped for standing above the test point.
 */
export function grassHeightRange(heights: Float32Array, cx: number, cz: number, half: number): [number, number] {
  const x0 = Math.max(-MAP_HALF, cx - half), x1 = Math.min(MAP_HALF, cx + half);
  const z0 = Math.max(-MAP_HALF, cz - half), z1 = Math.min(MAP_HALF, cz + half);
  const gx0 = Math.floor((x0 + MAP_HALF) / HEIGHT_SPACING) - 1;
  const gx1 = Math.ceil((x1 + MAP_HALF) / HEIGHT_SPACING) + 1;
  const gz0 = Math.floor((z0 + MAP_HALF) / HEIGHT_SPACING) - 1;
  const gz1 = Math.ceil((z1 + MAP_HALF) / HEIGHT_SPACING) + 1;
  let lo = Infinity, hi = -Infinity;
  for (let gz = gz0; gz <= gz1; gz++) {
    const z = -MAP_HALF + gz * HEIGHT_SPACING;
    if (z < -MAP_HALF || z > MAP_HALF) continue;
    for (let gx = gx0; gx <= gx1; gx++) {
      const x = -MAP_HALF + gx * HEIGHT_SPACING;
      if (x < -MAP_HALF || x > MAP_HALF) continue;
      const h = heightAt(heights, x, z);
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
  }
  if (!(hi >= lo)) { const h = heightAt(heights, cx, cz); lo = h; hi = h; }
  return [lo, hi];
}

export class GrassCulling {
  private readonly vis = new THREE.StorageBufferAttribute(new Uint32Array(TUFTS), 1);
  // (index count, instance count, first index, base vertex, first instance); whole until the first compute
  private readonly draw = new THREE.IndirectStorageBufferAttribute(new Uint32Array([BLADES * 3, TUFTS, 0, 0, 0]), 1);
  private readonly planes = Array.from({ length: 6 }, () => new THREE.Vector4());
  private readonly planesU: Node = uniformArray(this.planes, 'vec4');
  /** The field's height range (centre y, radius): what the cull tests each tuft's column against, conservative. */
  private readonly rangeU: Node = uniform(new THREE.Vector2(0, 1e6));
  private readonly reset: Node;
  private readonly cullPass: Node;
  private originX = 0;
  private originZ = 0;
  private heightsVer = 0;
  private heightsSeen = -1;
  private readonly heights: Float32Array;
  private readonly centre: Node;

  constructor(heights: Float32Array, centre: Node) {
    this.heights = heights;
    this.centre = centre;
    const drawsA = storage(this.draw, 'uint', 5).toAtomic();
    const visW = storage(this.vis, 'uint', TUFTS);
    this.reset = Fn(() => {
      atomicStore(drawsA.element(uint(1)), uint(0));
    })().compute(1).setName('grass.reset');
    const range = this.rangeU;
    const planesU = this.planesU;
    this.cullPass = Fn(() => {
      // the material's own placement math (TerrainRenderer.createGrass), up to the tuft's world column
      const id = instanceIndex.toFloat();
      const ix = id.mod(TUFT_SIDE), iz = floor(id.div(TUFT_SIDE));
      const origin = floor(centre.div(TUFT_STEP)).sub(TUFT_SIDE / 2);
      const cell = origin.add(vec2(ix, iz));
      const jx = hash(cell.x.mul(12.9).add(cell.y.mul(78.2))), jz = hash(cell.x.mul(39.3).add(cell.y.mul(11.1)));
      const base = cell.add(vec2(jx, jz)).mul(TUFT_STEP);
      const p = vec3(base.x, range.x, base.y);
      let inside: Node = float(1);
      // the field is camera-locked: a tuft past the map's edge hangs over the void - culled like the material grows it
      inside = inside.mul(step(abs(base.x), float(MAP_HALF))).mul(step(abs(base.y), float(MAP_HALF)));
      for (let k = 0; k < 6; k++) {
        const pl = planesU.element(k);
        inside = inside.mul(step(range.y.negate(), dot(pl.xyz, p).add(pl.w)));
      }
      If(inside.greaterThan(0.5), () => {
        const n = atomicAdd(drawsA.element(uint(1)), uint(1));
        visW.element(n).assign(instanceIndex);
      });
    })().compute(TUFTS, [64]).setName('grass.cull');
  }

  /** The visible ids, read by the grass material. */
  get visibleAttr(): THREE.StorageBufferAttribute { return this.vis; }
  /** The indirect draw's five words, read by the grass geometry. */
  get indirectAttr(): THREE.IndirectStorageBufferAttribute { return this.draw; }

  /** Runs this frame's cull with the camera's frustum, before the draw. */
  cull(renderer: THREE.WebGPURenderer, frustum: THREE.Frustum, visible: boolean): void {
    if (!visible) return;
    this.updateRange();
    frustum.planes.forEach((p, k) => this.planes[k].set(p.normal.x, p.normal.y, p.normal.z, p.constant));
    renderer.compute(this.reset);
    renderer.compute(this.cullPass);
  }

  /** A height layer was re-sent: the CPU range reads it again. */
  invalidateHeights(): void { this.heightsVer++; }

  /** The tufts the last cull kept, and what three counts for the field (an indirect draw is counted whole). */
  async drawn(renderer: THREE.WebGPURenderer): Promise<{ counted: number; drawn: number } | null> {
    const kept = new Uint32Array(await renderer.getArrayBufferAsync(this.draw))[1];
    return { counted: TUFTS * BLADES, drawn: kept * BLADES };
  }

  private updateRange(): void {
    const c = this.centre.value as THREE.Vector2;
    const ox = Math.floor(c.x / TUFT_STEP), oz = Math.floor(c.y / TUFT_STEP);
    if (ox === this.originX && oz === this.originZ && this.heightsVer === this.heightsSeen) return;
    this.originX = ox; this.originZ = oz; this.heightsSeen = this.heightsVer;
    const half = TUFT_SIDE * TUFT_STEP / 2 + TUFT_STEP;
    const [lo, hi] = grassHeightRange(this.heights, c.x, c.y, half);
    // the margin holds the blade's 0.7 m, its sway and the half tuft
    (this.rangeU.value as THREE.Vector2).set((lo + hi) / 2, (hi - lo) / 2 + 2);
  }
}

// The pool's occlusion: a hierarchical depth pyramid built from the previous frame's scene depth (the standard
// one-frame-late, conservative scheme - a caster revealed this frame draws from the next), and a screen test the
// cull embeds: an instance whose whole screen square sits behind the farthest occluder of every pyramid cell it
// covers does not draw. The pyramid keeps, per cell, the FARTHEST stored depth (the smallest reversed-Z value), so
// the claim is conservative: if even the farthest occluder of each cell is nearer than the instance's nearest
// point, nothing of it can be seen. Depth convention-agnostic: the instance's nearest point is projected by the
// matrices of the frame the pyramid was built from (the question is "was it hidden last frame"), so both sides compare
// in the stored convention; the safety margin pulls the instance's test point a metre toward the camera. What that
// frame's view did not hold is never hidden: an instance coming into the screen draws at once.
// (Greene, Kass & Miller, Hierarchical Z-buffer visibility, SIGGRAPH 1993; the GPU-driven pipelines' prior-frame
// depth test, SIGGRAPH 2015.)

import * as THREE from 'three/webgpu';
import { T, type Node } from './tsl.ts';

const { Fn, If, storage, uniform, uniformArray, instanceIndex, uint, int, float, vec2, ivec2, textureLoad, min, max, floor, ceil, log2, clamp, abs, step, vec4, exp2 } = T;

/** The pyramid is sized once for this frame size: bigger canvases rebuild nothing (the levels read the actual
 *  dimensions from uniforms). */
const MAX_W = 3840, MAX_H = 2160;
const MAX_LEVELS = 9;
const GROUP = 64;

export class DepthOcclusion {
  /** The scene depth the levels reduce (swapped each build by post's frame end). */
  private readonly depth: THREE.DepthTexture = new THREE.DepthTexture(4, 4);
  private depthNode: Node;
  /** One float per texel, levels 1..L appended; the test reads it directly. */
  readonly buffer = new THREE.StorageBufferAttribute(Math.ceil(MAX_W * MAX_H * 0.34), 1);
  private store: any;
  /** The levels' offsets and sizes: the node reads these (its own `value` turns into a typed array once it is set up). */
  private readonly offsets = Array.from({ length: MAX_LEVELS + 1 }, () => new THREE.Vector2());
  private readonly dimsOf = Array.from({ length: MAX_LEVELS + 1 }, () => new THREE.Vector2());
  private readonly offsetsU: Node;
  private readonly dimsU: Node;
  private readonly levelU = uniform(new THREE.Vector2(1, 0));
  private readonly dims = new THREE.Vector2();
  /** The frame's base size and level count, read by the test. */
  readonly baseU = uniform(new THREE.Vector3(3840, 2160, 1));
  readonly readyU = uniform(0);
  readonly build1: Node;
  readonly buildK: Node;
  private readonly levels: Array<{ offset: number; w: number; h: number }> = [];

  constructor() {
    this.depthNode = T.texture(this.depth);
    this.offsetsU = uniformArray(this.offsets, 'vec2');
    this.dimsU = uniformArray(this.dimsOf, 'vec2');
    this.store = storage(this.buffer, 'float', this.buffer.count);

    // level 1: each texel keeps the farthest (smallest reversed-Z) of the four depth texels under it
    this.build1 = Fn(() => {
      const dims = this.dimsU.element(1);
      const n = dims.x.mul(dims.y);
      If(instanceIndex.lessThan(n), () => {
        const x = instanceIndex.mod(dims.x), y = instanceIndex.div(dims.x);
        const b = this.baseU;
        const sx = int(clamp(x.mul(2).add(0.5), float(0), b.x.sub(1)));
        const sy = int(clamp(y.mul(2).add(0.5), float(0), b.y.sub(1)));
        const nx = min(sx.add(1), int(b.x.sub(1))), ny = min(sy.add(1), int(b.y.sub(1)));
        const a = textureLoad(this.depthNode, ivec2(sx, sy)).x;
        const c = textureLoad(this.depthNode, ivec2(nx, sy)).x;
        const d2 = textureLoad(this.depthNode, ivec2(sx, ny)).x;
        const e = textureLoad(this.depthNode, ivec2(nx, ny)).x;
        const off = this.offsetsU.element(1).x;
        this.store.element(off.add(y.mul(dims.x).add(x))).assign(min(min(a, c), min(d2, e)));
      });
    })().computeKernel([GROUP]).setName('occlusion.level1');

    // level k > 1: the farthest of the four texels of level k-1 (dispatched once per level, levelU selects it)
    this.buildK = Fn(() => {
      const k = uint(this.levelU.x);
      const dims = this.dimsU.element(k), prev = this.dimsU.element(k.sub(uint(1)));
      const n = dims.x.mul(dims.y);
      If(instanceIndex.lessThan(n), () => {
        const x = instanceIndex.mod(dims.x), y = instanceIndex.div(dims.x);
        const sx = min(x.mul(2), prev.x.sub(1)), sy = min(y.mul(2), prev.y.sub(1));
        const nx = min(sx.add(1), prev.x.sub(1)), ny = min(sy.add(1), prev.y.sub(1));
        const pOff = this.offsetsU.element(k.sub(uint(1))).x, off = this.offsetsU.element(k).x;
        const a = this.store.element(pOff.add(sy.mul(prev.x).add(sx)));
        const c = this.store.element(pOff.add(sy.mul(prev.x).add(nx)));
        const d2 = this.store.element(pOff.add(ny.mul(prev.x).add(sx)));
        const e = this.store.element(pOff.add(ny.mul(prev.x).add(nx)));
        this.store.element(off.add(y.mul(dims.x).add(x))).assign(min(min(a, c), min(d2, e)));
      });
    })().computeKernel([GROUP]).setName('occlusion.levelK');
  }

  /**
   * Reduces the scene depth (the frame just rendered) into the pyramid. The levels' storage is filled front to
   * back; the test reads it from the next frame's cull.
   */
  build(renderer: THREE.WebGPURenderer, depth: THREE.DepthTexture): void {
    const w = depth.image.width ?? 0, h = depth.image.height ?? 0;
    if (w > MAX_W || h > MAX_H || !w || !h) return;
    this.depthNode.value = depth;
    if (this.dims.x !== w || this.dims.y !== h) this.layout(w, h);
    // the invocations each level has (three's count is in invocations and it divides by the workgroup itself: the
    // kernels were given a count already divided, and only the first 64th of each level was written)
    renderer.compute(this.build1, this.levels[1].w * this.levels[1].h);
    for (let k = 2; k < this.levels.length; k++) {
      (this.levelU.value as THREE.Vector2).set(k, 0);
      renderer.compute(this.buildK, this.levels[k].w * this.levels[k].h);
    }
    this.readyU.value = 1;
    // the GPU alone writes and reads the levels
    (this.buffer as unknown as { array: Float32Array }).array = new Float32Array(0);
  }

  /** The levels' offsets and dimensions for this frame size (the storage holds room for the maximum already). */
  private layout(w: number, h: number): void {
    this.dims.set(w, h);
    this.levels.length = 0;
    this.levels.push({ offset: 0, w, h }); // slot 0: the depth texture itself
    let offset = 0, lw = w, lh = h;
    for (let k = 1; k <= MAX_LEVELS && (lw > 1 || lh > 1); k++) {
      // rounded up: rounded down, the last row of an odd size had no cell and the clamp read its neighbour's depth
      lw = (lw + 1) >> 1; lh = (lh + 1) >> 1;
      this.levels.push({ offset, w: lw, h: lh });
      this.offsets[k].set(offset, 0); this.dimsOf[k].set(lw, lh);
      offset += lw * lh;
    }
    (this.baseU.value as THREE.Vector3).set(w, h, this.levels.length - 1);
  }

  /**
   * The screen-occlusion test for one instance (world centre `p`, radius `r`, the forward, projection and view of the
   * frame the pyramid holds, that frame's focal length in pixels): 0 when every pyramid cell under its screen square
   * holds an occluder nearer than its nearest point (pulled a metre out for safety), 1 otherwise - 1 whenever the
   * pyramid is cold, or that frame did not see the instance whole in front of the camera and inside the screen.
   */
  test(p: Node, r: Node, fwd: Node, proj: Node, view: Node, focal: Node): Node {
    const viewP = view.mul(vec4(p, 1));
    const clip = proj.mul(viewP);
    const clipW = clip.w.toVar();
    const ndc = clip.xyz.div(clipW);
    const near = proj.mul(view.mul(vec4(p.sub(fwd.mul(r.add(1))), 1)));
    const nearW = near.w.toVar();
    const nearZ = near.z.div(nearW);
    const b = this.baseU;
    // the texture's first row is the top of the screen; NDC y grows upward
    const px = vec2(ndc.x.mul(0.5).add(0.5), ndc.y.mul(-0.5).add(0.5)).mul(b.xy);
    const rPx = clamp(r.mul(focal).div(max(viewP.z.negate(), 0.1)), float(2), float(256));
    // the level whose cell is at least the square's side: the square then meets at most 2 x 2 cells, all four read
    // (a side of up to 4 cells, the level this took before, left the cells between the corners unread)
    const lv = min(int(ceil(log2(rPx.mul(2)))), int(b.z));
    const half = exp2(lv.toFloat());
    const whole = step(rPx.mul(2), half);
    const dims = this.dimsU.element(lv), offs = this.offsetsU.element(lv).x;
    const x0 = clamp(floor(px.x.sub(rPx).div(half)), float(0), dims.x.sub(1));
    const x1 = clamp(floor(px.x.add(rPx).div(half)), float(0), dims.x.sub(1));
    const y0 = clamp(floor(px.y.sub(rPx).div(half)), float(0), dims.y.sub(1));
    const y1 = clamp(floor(px.y.add(rPx).div(half)), float(0), dims.y.sub(1));
    const a = this.store.element(offs.add(y0.mul(dims.x).add(x0)));
    const c = this.store.element(offs.add(y0.mul(dims.x).add(x1)));
    const d2 = this.store.element(offs.add(y1.mul(dims.x).add(x0)));
    const e = this.store.element(offs.add(y1.mul(dims.x).add(x1)));
    // occluded when all four cells' farthest occluder is at least as near as the instance's pulled-back point
    const hits = step(nearZ, a).add(step(nearZ, c)).add(step(nearZ, d2)).add(step(nearZ, e));
    const all = step(float(3.5), hits);
    // only what that frame had whole on its screen and in front of its camera can be claimed hidden
    const onScreen = step(float(0), px.x.sub(rPx)).mul(step(px.x.add(rPx), b.x)).mul(step(float(0), px.y.sub(rPx))).mul(step(px.y.add(rPx), b.y));
    const inFront = step(float(0.1), clipW).mul(step(float(0.1), nearW)).mul(step(abs(ndc.z), float(1)));
    return float(1).sub(all.mul(whole).mul(onScreen).mul(inFront).mul(this.readyU));
  }
}

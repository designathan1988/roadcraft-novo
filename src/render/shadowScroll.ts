// A shadow cascade scrolled instead of redrawn (Acton, "CSM Scrolling", SIGGRAPH 2012; Roadcraft 4.0 sunCascades.ts): a turn
// of the camera moves a cascade by whole texels along its own plane, so its kept depth is still right, only shifted. It is
// laid into the map shifted and the casters are drawn only in the strips that came into the map. WebGPU copies a depth
// texture only whole, so the shift is a full-screen pass writing the stored depth, not a copy.

import * as THREE from 'three/webgpu';
import { T, type Node } from './tsl.ts';

const { floor, float, ivec2, int, screenCoordinate, textureLoad, uniform, step } = T;

/** Rotation elements and moves within this are the same (the cascades' matrices carry rounding). */
const SAME = 1e-6;
/** A move along the cascade's axes within this of whole texels, and along its depth within this many metres, scrolls. */
const WHOLE_TEXEL = 0.01;
const SAME_DEPTH = 1e-3;
/** Past this fraction of the map on either axis, drawing the strips costs what drawing the map does. */
const MOST_SHIFT = 0.45;

export interface Shift { dx: number; dy: number }

/** The texels `now` moved from `was` along its own axes, or null when the kept depth does not hold (it turned, or moved in depth). */
export function cascadeShift(was: THREE.Matrix4, now: THREE.Matrix4, texelW: number, texelH: number, w: number, h: number): Shift | null {
  const a = was.elements, b = now.elements;
  for (let i = 0; i < 11; i++) if (i % 4 !== 3 && Math.abs(a[i] - b[i]) > SAME) return null;
  const mx = b[12] - a[12], my = b[13] - a[13], mz = b[14] - a[14];
  const fx = (mx * b[0] + my * b[1] + mz * b[2]) / texelW, fy = (mx * b[4] + my * b[5] + mz * b[6]) / texelH;
  const depth = mx * b[8] + my * b[9] + mz * b[10];
  const dx = Math.round(fx), dy = Math.round(fy);
  if (Math.abs(fx - dx) > WHOLE_TEXEL || Math.abs(fy - dy) > WHOLE_TEXEL || Math.abs(depth) > SAME_DEPTH) return null;
  if (Math.abs(dx) > w * MOST_SHIFT || Math.abs(dy) > h * MOST_SHIFT) return null;
  return { dx, dy };
}

export class ShadowScroll {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 2);
  private readonly shiftU = uniform(new THREE.Vector2());
  private readonly sizeU = uniform(new THREE.Vector2());
  private readonly source: Node;

  constructor() {
    this.source = T.texture(new THREE.DepthTexture(4, 4));
    const m = new THREE.NodeMaterial();
    m.colorWrite = false;
    m.depthFunc = THREE.AlwaysDepth;
    m.fog = false;
    m.lights = false;
    const from = floor(screenCoordinate.xy).add(this.shiftU);
    // the texels the stored map does not hold stay cleared: the strips draw them
    m.maskNode = step(float(0), from.x).mul(step(float(0), from.y)).mul(step(from.x, this.sizeU.x.sub(1))).mul(step(from.y, this.sizeU.y.sub(1))).greaterThan(0.5);
    m.depthNode = textureLoad(this.source, ivec2(int(from.x), int(from.y))).x;
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), m);
    quad.position.z = -1;
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  /** Clears the bound map and lays `store` in it, shifted: a new texel (x, y) reads the stored (x + sx, y + sy). */
  lay(renderer: THREE.WebGPURenderer, store: THREE.DepthTexture, sx: number, sy: number): void {
    this.source.value = store;
    (this.shiftU.value as THREE.Vector2).set(sx, sy);
    (this.sizeU.value as THREE.Vector2).set(store.image.width ?? 0, store.image.height ?? 0);
    const fn = renderer.getRenderObjectFunction();
    const auto = renderer.autoClear;
    renderer.setRenderObjectFunction(null);
    renderer.autoClear = true;
    try { renderer.render(this.scene, this.camera); } finally { renderer.setRenderObjectFunction(fn); renderer.autoClear = auto; }
  }
}

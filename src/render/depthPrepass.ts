// The scene pass with a depth pre-pass: the depth of the materials laid first (`layDepthFirst`) drawn before the colour, each through a depth-only twin (its
// position and its mask, no colour), then the colour with the materials writing no depth, tested against that depth.
//
// Measured (RenderDoc 1.46 replay of the street view, 2544x993, RTX 3060, 2026-10-31): the buildings' material (5445
// lines of pixel shader, 9 textures) took 36 % of the frame's GPU time and ran on 2.15 screens of pixels; one of its draws
// shaded 1.26 screens with 7.3 k triangles, a quarter of them failing the depth test after shading. Every opaque material
// here has a mask (`discard`: level dither, inside cut, window holes), and a pixel shader that may discard while it
// writes depth loses the early depth test: every fragment, hidden or not, ran the whole material. With the depth laid
// first and the colour pass writing none, the early test rejects every hidden fragment and each covered pixel runs its
// material once (Unreal Engine's early Z pass with masked materials, Unity URP's depth priming; three r186
// Renderer.setRenderObjectFunction: "every object that has material of a certain type should perform a pre-pass with a
// special overwrite material").

import * as THREE from 'three/webgpu';

type AnyMaterial = THREE.Material & { positionNode?: unknown; maskNode?: unknown; depthNode?: unknown; setupPosition?: (b: unknown) => unknown };

/** Each opaque material's depth-only twin (null: the material draws in the colour pass alone). */
const twins = new WeakMap<THREE.Material, THREE.NodeMaterial | null>();

/**
 * Materials whose depth is laid first. Only where a pixel costs far more than a vertex: the buildings' (one draw shaded
 * 1.26 screens of pixels with 7.3 k triangles). Laying every opaque material first drew the scene's 6.2 M triangles twice
 * (the props' instances 429 k triangles for 0.09 of a screen): the depth pass cost 2.88 ms for 2.5 ms saved in the colour
 * pass, the frame 10.64 -> 11.03 ms (same view, 2026-10-31).
 */
const laidFirst = new WeakSet<THREE.Material>();
export function layDepthFirst<M extends THREE.Material>(m: M): M {
  laidFirst.add(m);
  return m;
}

/** The twin of `m`, made once: its position and mask (the same nodes, the same vertex program), writing depth only. From
 *  then on `m` itself writes no depth (the twin's depth is what its colour is tested against). */
export function depthTwin(m: THREE.Material): THREE.NodeMaterial | null {
  let t = twins.get(m);
  if (t !== undefined) return t;
  const src = m as AnyMaterial;
  if (!laidFirst.has(m) || !(m as THREE.NodeMaterial).isNodeMaterial || m.transparent || !m.depthWrite || !m.depthTest) {
    twins.set(m, null);
    return null;
  }
  t = new THREE.NodeMaterial();
  t.name = (m.name || m.type) + ' depth';
  const tt = t as unknown as AnyMaterial;
  tt.positionNode = src.positionNode ?? null;
  tt.maskNode = src.maskNode ?? null;
  tt.depthNode = src.depthNode ?? null;
  // the position as the material sets it up (render/tsl.ts withPrevious wraps it on some): one vertex program, one depth
  if (src.setupPosition) tt.setupPosition = (b: unknown) => src.setupPosition!.call(src, b);
  t.side = m.side;
  t.depthFunc = m.depthFunc;
  t.alphaTest = m.alphaTest;
  t.colorWrite = false;
  t.fog = false;
  t.lights = false;
  twins.set(m, t);
  m.depthWrite = false;
  m.needsUpdate = true;
  return t;
}

/** A scene pass (three's PassNode) drawing the opaque depth first through the materials' twins, then the colour. */
export class PrepassPassNode extends THREE.PassNode {
  private readonly depthOnly = (object: THREE.Object3D, scene: THREE.Scene, camera: THREE.Camera, geometry: THREE.BufferGeometry, material: THREE.Material,
    group: unknown, lightsNode: unknown, clipping: unknown): void => {
    const t = depthTwin(material);
    if (t) (this.drawer as unknown as { renderObject(...a: unknown[]): void }).renderObject(object, scene, camera, geometry, t, group, lightsNode, clipping, 'depthPrepass');
  };
  private drawer: THREE.Renderer | null = null;

  constructor(scene: THREE.Scene, camera: THREE.Camera, options?: Record<string, unknown>) {
    super(THREE.PassNode.COLOR, scene, camera, options);
  }

  override updateBefore(frame: THREE.NodeFrame): boolean | undefined {
    const r = frame.renderer as THREE.Renderer & { getRenderObjectFunction(): unknown; setRenderObjectFunction(f: unknown): void };
    this.drawer = r;
    const own = r.getRenderObjectFunction();
    const self = this as unknown as { transparent: boolean; autoClearDepth: boolean };
    const transparent = self.transparent, clearDepth = self.autoClearDepth;
    // 1. the opaque depth (cleared first), no colour written
    r.setRenderObjectFunction(this.depthOnly);
    self.transparent = false;
    try { super.updateBefore(frame); } finally { r.setRenderObjectFunction(own); self.transparent = transparent; }
    // 2. the colour over it, the depth kept
    self.autoClearDepth = false;
    try { return super.updateBefore(frame); } finally { self.autoClearDepth = clearDepth; }
  }
}

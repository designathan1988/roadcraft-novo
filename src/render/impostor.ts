// Octahedral impostors of the trees (upper hemisphere: never seen from below). At load each tree is photographed
// from G × G directions into a texture (colour and normal); far away the tree becomes a camera-facing square that
// shows the photo of the nearest direction. The foliage cards face the photo camera and are cut by the leaf atlas,
// as they are in the game.

import * as THREE from 'three/webgpu';
import { T, type Node } from './tsl.ts';

const { vec2, vec3, vec4, float, abs, normalize, attribute, normalWorld, step, cameraViewMatrix, positionLocal, texture } = T;

export const IMP_G = 8;
const SIZE = 128;
/** Types with an impostor, in the order of the atlas columns (mixed, cypress, oak, palm). */
export const IMP_TYPES = 4;
/** Centre height and radius of each photographed tree (m, scale 1): measured from its mesh (`impostorFrames`). */
export const IMP_FRAME: Array<{ cy: number; r: number }> = Array.from({ length: IMP_TYPES }, () => ({ cy: 4, r: 5 }));
/** Finish id of the tree cards (PMAT.LeafCard). */
const LEAF_CARD = 26;

/** Measures each tree for its photo: the box of its triangles plus its cards' reach. */
export function impostorFrames(geos: THREE.BufferGeometry[]): void {
  geos.forEach((g, i) => {
    const p = g.attributes.position, e = g.attributes.pext;
    let y0 = Infinity, y1 = -Infinity, rr = 0;
    for (let k = 0; k < p.count; k++) {
      const reach = e ? Math.hypot(e.getZ(k), e.getW(k)) : 0;
      y0 = Math.min(y0, p.getY(k) - reach); y1 = Math.max(y1, p.getY(k) + reach);
      rr = Math.max(rr, Math.hypot(p.getX(k), p.getZ(k)) + reach);
    }
    const cy = (y0 + y1) / 2;
    IMP_FRAME[i] = { cy, r: Math.max((y1 - y0) / 2, rr) * 1.04 };
  });
}

/** Direction (upper hemisphere) → uv on the octahedron. */
export function hemiOctEncode(x: number, y: number, z: number): [number, number] {
  const s = Math.abs(x) + Math.abs(y) + Math.abs(z);
  const px = x / s, pz = z / s;
  return [(px + pz) * 0.5 + 0.5, (px - pz) * 0.5 + 0.5];
}

export function hemiOctDecode(u: number, v: number): [number, number, number] {
  const ux = u * 2 - 1, uy = v * 2 - 1;
  const px = (ux + uy) / 2, pz = (ux - uy) / 2;
  const y = 1 - Math.abs(px) - Math.abs(pz);
  const l = Math.hypot(px, y, pz);
  return [px / l, y / l, pz / l];
}

/** The same in TSL. */
export function hemiOctEncodeNode(d: Node): Node {
  const s = abs(d.x).add(abs(d.y)).add(abs(d.z));
  const px = d.x.div(s), pz = d.z.div(s);
  return vec2(px.add(pz), px.sub(pz)).mul(0.5).add(0.5);
}

export function hemiOctDecodeNode(uv: Node): Node {
  const u = uv.mul(2).sub(1);
  const px = u.x.add(u.y).div(2), pz = u.x.sub(u.y).div(2);
  return normalize(vec3(px, float(1).sub(abs(px)).sub(abs(pz)), pz));
}

/** "Up" of each photo's camera (at the top, looking straight down, it uses +z). */
export function upFor(d: [number, number, number]): THREE.Vector3 {
  return Math.abs(d[1]) > 0.985 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
}

/** Photographs the trees: one target with the colour (alpha = cutout) and another with the normal. */
/**
 * One atlas target (colour or normal). With mipmaps: far trees are a few pixels and, read at full size, each pixel
 * picked a different leaf every frame (the forests shimmered).
 */
export function impostorTarget(w: number, h: number): THREE.RenderTarget {
  const rt = new THREE.RenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: true });
  rt.texture.minFilter = THREE.LinearMipmapLinearFilter; rt.texture.magFilter = THREE.LinearFilter; rt.texture.generateMipmaps = true;
  return rt;
}

export function bakeImpostors(renderer: THREE.WebGPURenderer, geos: THREE.BufferGeometry[], leafAtlas: THREE.Texture): { color: THREE.Texture; normal: THREE.Texture; targets: THREE.RenderTarget[] } {
  const W = SIZE * IMP_G;
  const pcol = attribute('pcol', 'vec4');
  const pext = attribute('pext', 'vec4');
  const isCard = step(abs(pcol.w.mul(255).sub(LEAF_CARD)), float(0.5));
  // cards face the photo camera, as they face the game's
  const right = vec3(cameraViewMatrix.element(0).x, cameraViewMatrix.element(1).x, cameraViewMatrix.element(2).x);
  const up = vec3(cameraViewMatrix.element(0).y, cameraViewMatrix.element(1).y, cameraViewMatrix.element(2).y);
  const pos = positionLocal.add(right.mul(pext.z).add(up.mul(pext.w)).mul(isCard));
  const leaf = texture(leafAtlas, pext.xy);
  const mask = isCard.lessThan(0.5).or(leaf.a.greaterThan(0.5));
  const colorMat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  colorMat.positionNode = pos;
  colorMat.colorNode = vec4(pcol.xyz.mul(T.mix(vec3(1, 1, 1), leaf.xyz, isCard)), 1);
  colorMat.maskNode = mask;
  const normalMat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  normalMat.positionNode = pos;
  normalMat.colorNode = vec4(normalWorld.mul(0.5).add(0.5), 1);
  normalMat.maskNode = mask;
  const targets = [colorMat, normalMat].map(() => impostorTarget(W * IMP_TYPES, W));
  const scene = new THREE.Scene();
  // copies without the props' indirect draw (there the count comes from the GPU)
  const meshes = geos.map((src) => { const g = src.clone(); g.indirect = null; const m = new THREE.Mesh(g, colorMat); m.frustumCulled = false; scene.add(m); return m; });
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 80);
  const prevRT = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevAuto = renderer.autoClear;
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false;
  targets.forEach((rt, pass) => {
    for (const m of meshes) m.material = pass === 0 ? colorMat : normalMat;
    renderer.setRenderTarget(rt);
    rt.viewport.set(0, 0, W * IMP_TYPES, W);
    renderer.clear();
    // the mipmaps are made once, after the last photo (each render into the atlas would make them again)
    rt.texture.generateMipmaps = false;
    for (let t = 0; t < geos.length; t++) {
      meshes.forEach((m, k) => { m.visible = k === t; });
      const { cy, r } = IMP_FRAME[t];
      cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r; cam.updateProjectionMatrix();
      for (let j = 0; j < IMP_G; j++) for (let i = 0; i < IMP_G; i++) {
        const d = hemiOctDecode((i + 0.5) / IMP_G, (j + 0.5) / IMP_G);
        cam.up.copy(upFor(d));
        cam.position.set(d[0] * 40, cy + d[1] * 40, d[2] * 40);
        cam.lookAt(0, cy, 0);
        cam.updateMatrixWorld();
        rt.viewport.set(t * W + i * SIZE, j * SIZE, SIZE, SIZE);
        if (t === geos.length - 1 && j === IMP_G - 1 && i === IMP_G - 1) rt.texture.generateMipmaps = true;
        renderer.render(scene, cam);
      }
    }
    rt.viewport.set(0, 0, W * IMP_TYPES, W);
  });
  renderer.autoClear = prevAuto;
  renderer.setClearColor(prevClear, prevAlpha);
  renderer.setRenderTarget(prevRT);
  for (const m of meshes) m.geometry.dispose();
  return { color: targets[0].texture, normal: targets[1].texture, targets };
}

/** Far level mesh: one square (−1..1), finish "impostor". */
export function impostorQuad(mat: number, column: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(2, 2).toNonIndexed();
  g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 4);
  // r = atlas column (which tree)
  for (let i = 0; i < n; i++) { col[i * 4] = column / 255; col[i * 4 + 1] = 1; col[i * 4 + 2] = 1; col[i * 4 + 3] = mat / 255; }
  g.setAttribute('pcol', new THREE.BufferAttribute(col, 4));
  g.setAttribute('pext', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
  return g;
}

// Impostores octaédricos das árvores (meia esfera: nunca se vê de baixo).
// Na carga, cada árvore é fotografada de G × G direções numa textura (cor e
// normal); longe, a árvore vira um quadrado virado para a câmera que mostra a
// foto da direção mais próxima.

import * as THREE from 'three/webgpu';
import { T, type Node } from './tsl.ts';

const { vec2, vec3, vec4, float, abs, normalize, attribute, normalWorld } = T;

export const IMP_G = 8;
const SIZE = 128;
/** Tipos com impostor, na ordem das colunas do atlas. */
export const IMP_TYPES = 2;
/** Centro e raio de cada árvore fotografada (m, escala 1). */
export const IMP_FRAME: Array<{ cy: number; r: number }> = [{ cy: 3.9, r: 4.4 }, { cy: 3.6, r: 4.0 }];

/** Direção (meia esfera de cima) → uv no octaedro. */
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

/** Os mesmos cálculos em TSL. */
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

/** "Para cima" da câmera de cada foto (no topo, olhando reto para baixo, usa +z). */
export function upFor(d: [number, number, number]): THREE.Vector3 {
  return Math.abs(d[1]) > 0.985 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
}

/** Fotografa as árvores: um alvo com a cor (alfa = recorte) e outro com a normal. */
export function bakeImpostors(renderer: THREE.WebGPURenderer, geos: THREE.BufferGeometry[]): { color: THREE.Texture; normal: THREE.Texture; targets: THREE.RenderTarget[] } {
  const W = SIZE * IMP_G;
  const pcol = attribute('pcol', 'vec4');
  const colorMat = new THREE.MeshBasicNodeMaterial();
  colorMat.colorNode = vec4(pcol.xyz, 1);
  const normalMat = new THREE.MeshBasicNodeMaterial();
  normalMat.colorNode = vec4(normalWorld.mul(0.5).add(0.5), 1);
  const targets = [colorMat, normalMat].map(() => {
    const rt = new THREE.RenderTarget(W * IMP_TYPES, W, { type: THREE.UnsignedByteType, depthBuffer: true });
    rt.texture.minFilter = THREE.LinearFilter; rt.texture.magFilter = THREE.LinearFilter; rt.texture.generateMipmaps = false;
    return rt;
  });
  const scene = new THREE.Scene();
  // cópia sem o desenho indireto das peças (lá a contagem vem da GPU)
  const meshes = geos.map((src) => { const g = src.clone(); g.indirect = null; const m = new THREE.Mesh(g, colorMat); m.frustumCulled = false; scene.add(m); return m; });
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 60);
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
    for (let t = 0; t < geos.length; t++) {
      meshes.forEach((m, k) => { m.visible = k === t; });
      const { cy, r } = IMP_FRAME[t];
      cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r; cam.updateProjectionMatrix();
      for (let j = 0; j < IMP_G; j++) for (let i = 0; i < IMP_G; i++) {
        const d = hemiOctDecode((i + 0.5) / IMP_G, (j + 0.5) / IMP_G);
        cam.up.copy(upFor(d));
        cam.position.set(d[0] * 30, cy + d[1] * 30, d[2] * 30);
        cam.lookAt(0, cy, 0);
        cam.updateMatrixWorld();
        rt.viewport.set(t * W + i * SIZE, j * SIZE, SIZE, SIZE);
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

/** Malha do nível longe: um quadrado (−1..1), acabamento "impostor". */
export function impostorQuad(mat: number, column: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(2, 2).toNonIndexed();
  g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 4);
  // r = coluna do atlas (qual árvore)
  for (let i = 0; i < n; i++) { col[i * 4] = column / 255; col[i * 4 + 1] = 1; col[i * 4 + 2] = 1; col[i * 4 + 3] = mat / 255; }
  g.setAttribute('pcol', new THREE.BufferAttribute(col, 4));
  return g;
}

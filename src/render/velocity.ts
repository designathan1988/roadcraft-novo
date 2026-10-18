// Velocidade de tela para o TRAA, com as matrizes da câmera principal definidas uma vez por quadro (sem o jitter).
//
// O `velocity` do three guarda as matrizes "anteriores" da câmera em uniformes do nó compartilhado, trocados por
// câmera e por quadro; com as passadas de sombra do CSM no meio, parte dos objetos saía com a velocidade de outra
// câmera (as áreas de sombra apareciam se mexendo com tudo parado), o TRAA dava peso total ao quadro atual ali e
// essas áreas tremiam. Aqui: os objetos do jogo não se movem pela matriz (o que anda, anda pelo `positionPrevious`,
// ver `withPrevious`), então só a câmera conta.

import * as THREE from 'three/webgpu';
import { T } from './tsl.ts';

const { Fn, uniform, vec4, modelWorldMatrix, positionLocal, positionPrevious } = T;

const curVP = uniform(new THREE.Matrix4());
const prevVP = uniform(new THREE.Matrix4());
let lastCamera: THREE.Camera | null = null;

/** Antes de desenhar o quadro (a câmera sem o jitter do TRAA): guarda a anterior e põe a atual. */
export function updateVelocityCamera(camera: THREE.Camera): void {
  const m = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  if (camera !== lastCamera) { prevVP.value.copy(m); lastCamera = camera; }
  else prevVP.value.copy(curVP.value);
  curVP.value.copy(m);
}

/** Velocidade em NDC (atual − anterior), como a do three. */
export const stableVelocity = Fn(() => {
  const cur = curVP.mul(modelWorldMatrix).mul(vec4(positionLocal, 1));
  const prev = prevVP.mul(modelWorldMatrix).mul(vec4(positionPrevious, 1));
  return cur.xy.div(cur.w).sub(prev.xy.div(prev.w));
})();

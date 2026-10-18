// Screen velocity for TRAA, with the main camera matrices set once per frame (without the jitter).
//
// three's `velocity` keeps the "previous" camera matrices in uniforms of the shared node, swapped per
// camera and per frame; with the CSM shadow passes in between, some objects came out with another camera's
// velocity (shadow areas appeared to move with everything still), TRAA gave full weight to the current frame there
// and those areas shimmered. Here: game objects do not move through the matrix (what moves, moves through
// `positionPrevious`, see `withPrevious`), so only the camera counts.

import * as THREE from 'three/webgpu';
import { T } from './tsl.ts';

const { Fn, uniform, vec4, modelWorldMatrix, positionLocal, positionPrevious } = T;

const curVP = uniform(new THREE.Matrix4());
const prevVP = uniform(new THREE.Matrix4());
let lastCamera: THREE.Camera | null = null;

/** Before drawing the frame (the camera without the TRAA jitter): stores the previous one and sets the current one. */
export function updateVelocityCamera(camera: THREE.Camera): void {
  const m = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  if (camera !== lastCamera) { prevVP.value.copy(m); lastCamera = camera; }
  else prevVP.value.copy(curVP.value);
  curVP.value.copy(m);
}

/** Velocity in NDC (current − previous), like three's. */
export const stableVelocity = Fn(() => {
  const cur = curVP.mul(modelWorldMatrix).mul(vec4(positionLocal, 1));
  const prev = prevVP.mul(modelWorldMatrix).mul(vec4(positionPrevious, 1));
  return cur.xy.div(cur.w).sub(prev.xy.div(prev.w));
})();

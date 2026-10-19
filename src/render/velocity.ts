// Screen velocity for TRAA, with the main camera matrices set once per frame (without the jitter).
//
// three's `velocity` keeps the "previous" camera matrices in uniforms of the shared node, swapped per
// camera and per frame; with the CSM shadow passes in between, some objects came out with another camera's
// velocity (shadow areas appeared to move with everything still), TRAA gave full weight to the current frame there
// and those areas shimmered. Here: game objects do not move through the matrix (what moves, moves through
// `positionPrevious`, see `withPrevious`); what does move through its matrix keeps its own previous matrix per frame.

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

interface ModelHistory { velFrame?: number; velPrev?: THREE.Matrix4; velCur?: THREE.Matrix4 }

/**
 * The object's world matrix in the previous frame (for objects animated through their matrix: the collapsing block,
 * the explosion flash). Kept per object and per frame: every pass of a frame (main and shadow cascades) sees the same;
 * an object not drawn in the frame before starts still (no jump when it comes back into view).
 */
export function previousModelMatrix(object: THREE.Object3D, frameId: number): THREE.Matrix4 {
  const u = object.userData as ModelHistory;
  if (u.velFrame !== frameId) {
    const prev = (u.velPrev ??= new THREE.Matrix4()), cur = (u.velCur ??= new THREE.Matrix4());
    prev.copy(u.velFrame === frameId - 1 ? cur : object.matrixWorld);
    cur.copy(object.matrixWorld);
    u.velFrame = frameId;
  }
  return u.velPrev!;
}

const prevModel = uniform(new THREE.Matrix4()).onObjectUpdate((frame: { object: THREE.Object3D; frameId: number }) => previousModelMatrix(frame.object, frame.frameId));

/** Velocity in NDC (current − previous), like three's, with the object's own previous matrix (E23: it was the current
 *  one, so what moved through its matrix had zero velocity and the anti-aliasing smeared it). */
export const stableVelocity = Fn(() => {
  const cur = curVP.mul(modelWorldMatrix).mul(vec4(positionLocal, 1));
  const prev = prevVP.mul(prevModel).mul(vec4(positionPrevious, 1));
  return cur.xy.div(cur.w).sub(prev.xy.div(prev.w));
})();

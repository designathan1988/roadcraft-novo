// Screen velocity for TRAA, with the main camera matrices set once per frame (without the jitter).
//
// three's `velocity` keeps the "previous" camera matrices in uniforms of the shared node, swapped per
// camera and per frame; with the CSM shadow passes in between, some objects came out with another camera's
// velocity (shadow areas appeared to move with everything still), TRAA gave full weight to the current frame there
// and those areas shimmered. Here: game objects do not move through the matrix (what moves, moves through
// `positionPrevious`, see `withPrevious`); what does move through its matrix keeps its own previous matrix per frame.

import * as THREE from 'three/webgpu';
import { T } from './tsl.ts';

const { Fn, uniform, vec4, float, select, length, modelWorldMatrix, positionLocal, positionPrevious } = T;

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

/** World distance (m) under which a surface counts as not having moved itself: its two positions are worked out from the
 *  same numbers when it stands still (exactly equal); a walker covers ~2 cm a frame. */
const MOVED_EPS = 1e-4;

/**
 * Velocity in NDC (current − previous), like three's, with the object's own previous matrix (E23: it was the current
 * one, so what moved through its matrix had zero velocity and the anti-aliasing smeared it); z = 1 where the surface
 * itself moved since the last frame (a walker, a vehicle, a falling piece), whatever the camera did: the TRAA keeps its
 * "still thin line" history only where z is 0 (render/traa.ts). w = 1, as the vec2 it was wrote.
 */
export const stableVelocity = Fn(() => {
  const world = modelWorldMatrix.mul(vec4(positionLocal, 1));
  const prevWorld = prevModel.mul(vec4(positionPrevious, 1));
  const cur = curVP.mul(world);
  const prev = prevVP.mul(prevWorld);
  const moved = select(length(world.xyz.sub(prevWorld.xyz)).greaterThan(MOVED_EPS), float(1), float(0));
  return vec4(cur.xy.div(cur.w).sub(prev.xy.div(prev.w)), moved, 1);
})();

// A building part's place as the props pool takes it: a pose turned about the up axis (its place, its turn's cosine and
// sine, its scale on three axes), 8 floats in place of a 16-float matrix. What is left of 4.0's partPose.ts (its GLSL
// and posed copies were WebGL code this engine never ran).

/** Floats a part's pose takes: x, y, z (three's axes), the turn's cosine; its sine, then the scale along the model's x, y and z. The turn kept as its cosine and sine, as the matrix kept it: the same numbers to the float. */
export const POSE_FLOATS = 8;

/** A pose's matrix, column-major T * Ry * S, as its GLSL makes it (`partPoseShader`). */
export function poseMatrixInto(poses: ArrayLike<number>, at: number, out: Float32Array | number[], outAt: number): void {
  const c = poses[at + 3]!, s = poses[at + 4]!, sx = poses[at + 5]!, sy = poses[at + 6]!, sz = poses[at + 7]!;
  out[outAt] = c * sx; out[outAt + 1] = 0; out[outAt + 2] = -s * sx; out[outAt + 3] = 0;
  out[outAt + 4] = 0; out[outAt + 5] = sy; out[outAt + 6] = 0; out[outAt + 7] = 0;
  out[outAt + 8] = s * sz; out[outAt + 9] = 0; out[outAt + 10] = c * sz; out[outAt + 11] = 0;
  out[outAt + 12] = poses[at]!; out[outAt + 13] = poses[at + 1]!; out[outAt + 14] = poses[at + 2]!; out[outAt + 15] = 1;
}

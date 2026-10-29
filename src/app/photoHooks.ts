// Hooks used by the automated photos and the checks: put the camera at a view, wait for the meshes.
import type { CameraRig } from '../render/cameraRig.ts';
import type { JobPool } from '../jobs/pool.ts';

/** Places the camera as the photo scripts ask and waits for the meshes, exactly as the old Game methods did. */
export async function photoView(
  rig: CameraRig, settle: (frames?: number) => Promise<void>,
  setHour: (hour: number) => void,
  x: number, z: number, yaw: number, pitch: number, dist: number, hour?: number,
): Promise<void> {
  rig.restore(new Float64Array([x, z, yaw * Math.PI / 180, pitch * Math.PI / 180, dist, 0]));
  if (hour !== undefined) setHour(hour);
  await new Promise((r) => setTimeout(r, 500));
  await settle(4);
}

/** Waits until the worker pool has been idle for `frames` consecutive animation frames. */
export async function settlePool(pool: JobPool, frames = 20): Promise<void> {
  let quiet = 0;
  while (quiet < frames) {
    await new Promise((r) => requestAnimationFrame(r));
    quiet = pool.isIdle() ? quiet + 1 : 0;
  }
}

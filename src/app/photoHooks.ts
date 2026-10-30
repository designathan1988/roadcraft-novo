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

/**
 * Waits until the worker pool has been idle, and `steady()` held (nothing the layers draw changing: no mesh coming,
 * going or fading), for `frames` consecutive animation frames. With the pool alone the counts were read mid-change:
 * the same build measured 122 and 234 draws in one view (an outgoing level and the incoming one drawn together).
 */
export async function settlePool(pool: JobPool, frames = 20, steady: () => boolean = () => true): Promise<void> {
  let quiet = 0;
  const t0 = performance.now();
  while (quiet < frames) {
    await new Promise((r) => requestAnimationFrame(r));
    quiet = pool.isIdle() && steady() ? quiet + 1 : 0;
    // never waits for ever: a scene that keeps changing is said so (the meter flags its counts)
    if (performance.now() - t0 > SETTLE_LIMIT_MS) { console.warn('settle: the scene kept changing for ' + SETTLE_LIMIT_MS / 1000 + ' s'); return; }
  }
}

/** Longest `settlePool` waits for the scene to stop changing (ms). */
const SETTLE_LIMIT_MS = 30000;

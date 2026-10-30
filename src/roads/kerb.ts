// The road's edges against what is beside them. Where a bus stop's people wait: on the sidewalk beside the road the
// stop was put by (the shelter, on the page, and the waiting place, in the simulation, from this one rule). And where
// the ground meets a road (`edgeRise`): under it the terrain is pulled below the surface, beside it held level with
// the outer strip's top, so the footway's edge meets the ground (roadcraft 4.0 world/elevation.ts roadShapeAt: "beside
// it, held level with the footway's top, so the terrain meets the footway's edge on its own height"); the cells the
// edge crosses are cut along it near the camera (jobs/terrainSeams.ts).

import { bez, bezD, type Quad } from './geometry.ts';
import { PROFILE_INFO } from './profiles.ts';

const p2 = new Float64Array(2), d2 = new Float64Array(2);

/**
 * The waiting place of a stop clicked at (x, z) beside the segment of curve `q` and profile `profile`, at the curve's
 * parameter `t` (its nearest point): the middle of the sidewalk on the click's side (the road's edge where that side
 * has none), level with the click, into `out` (x, z, yaw facing the road). Returns the side: +1 = u+ (the left of
 * a → b), −1 = u−.
 */
export function stopSpot(q: Quad, profile: number, t: number, x: number, z: number, out: Float64Array): number {
  bez(q, t, p2); bezD(q, t, d2);
  const l = Math.hypot(d2[0], d2[1]) || 1, dx = d2[0] / l, dz = d2[1] / l;
  // u+ lies along (dz, −dx) of the curve's direction
  const side = (x - p2[0]) * dz - (z - p2[1]) * dx > 0 ? 1 : -1;
  const info = PROFILE_INFO[profile];
  let u = side > 0 ? info.walkLeft : info.walkRight;
  if (Number.isNaN(u)) u = side > 0 ? info.left : -info.right;
  out[0] = p2[0] + dz * u; out[1] = p2[1] - dx * u;
  out[2] = Math.atan2(p2[0] - out[0], p2[1] - out[1]);
  return side;
}

/** The footway's top over the carriageway (roadcraft 4.0 world/roadTypes.ts FOOTWAY_RISE), m. */
export const FOOTWAY_RISE = 0.15;
/** Below the road's surface, where the ground under a road is held (m): the road's own mesh covers it. */
export const UNDER_DROP = 0.06;
/** Below the outer strip's top, where the ground beside a road is held (m). */
export const BESIDE_DROP = 0.01;

/**
 * Height over the road's surface of the top of its outermost strip on its left (u+, `left`) or right side: a raised
 * footway's FOOTWAY_RISE, 0 for anything laid at the road's level (a flush footway, a shoulder, grass, a barrier's foot).
 */
export function edgeRise(profile: number, left: boolean): number {
  const edges = PROFILE_INFO[profile].edges;
  const e = left ? edges[edges.length - 1] : edges[0];
  return e && e.strip.kind === 'sidewalk' && !e.strip.flush ? FOOTWAY_RISE : 0;
}

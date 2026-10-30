// Where a bus stop's people wait: on the sidewalk beside the road the stop was put by. The point the player clicked
// may land on the carriageway; the shelter (the page) and the waiting place, where the riders walk to (the
// simulation), both come from this one rule, so they stand together on the sidewalk.

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

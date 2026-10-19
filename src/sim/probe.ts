// What the motion probe (tools/check-sim.mjs, through the worker's 'inspect') asks of the street under a point. Only
// on request, for the agents near the camera.

import { PROFILE_INFO } from '../roads/profiles.ts';
import { bez, bezD, type Quad } from '../roads/geometry.ts';
import type { SimNet } from './lanes.ts';

/** Strip kinds as numbers: none (no street within reach), then the profile strip kinds. */
export const STRIP_KINDS = ['none', 'lane', 'parking', 'bike', 'sidewalk', 'curb', 'median', 'shoulder', 'barrier'] as const;

const q: Quad = { x0: 0, z0: 0, cx: 0, cz: 0, x1: 0, z1: 0 };
const p = new Float64Array(2), d = new Float64Array(2);

/**
 * The strip of the nearest street under (x, z) (index in STRIP_KINDS) and how far the point is along the street past
 * the junction's edge (its setback) at the nearer end (m): the crosswalks lie in the first few metres, the junction
 * itself is below 0.
 */
export function stripAt(sim: SimNet, x: number, z: number): [number, number] {
  const net = sim.net;
  const near = net.nearestSeg(x, z, 30);
  if (!near) return [0, 0];
  const [s, t] = near;
  net.quad(s, q); bez(q, t, p); bezD(q, t, d);
  const l = Math.hypot(d[0], d[1]) || 1, dx = d[0] / l, dz = d[1] / l;
  // the street's u axis (as the sidewalks are laid out: u+ = (dz, −dx) of the direction a → b)
  const u = (x - p[0]) * dz - (z - p[1]) * dx;
  const L = sim.segLen(s), along = t * L, fromEnd = Math.min(along - sim.segS0(s), sim.segS1(s) - along);
  for (const e of PROFILE_INFO[net.segs.cols.profile[s]].edges) {
    if (u < e.u0 || u >= e.u1) continue;
    const k = STRIP_KINDS.indexOf(e.strip.kind as typeof STRIP_KINDS[number]);
    return [k < 0 ? 0 : k, fromEnd];
  }
  return [0, fromEnd];
}

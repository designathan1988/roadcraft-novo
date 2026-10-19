// Node shape, the same for drawing (mesh worker) and for traffic (simulation
// worker): the arm of each segment end and the setback of each arm.

import { armAngle, armRetreats, closestT, type Arm, type Quad } from './geometry.ts';
import { PROFILE_INFO } from './profiles.ts';
import type { RoadNetwork } from './network.ts';

/** Arm of a segment end: direction out of the node and half widths. */
export function armOf(q: Quad, profile: number, end: 0 | 1): Arm {
  const info = PROFILE_INFO[profile];
  let dx = end === 0 ? q.cx - q.x0 : q.cx - q.x1, dz = end === 0 ? q.cz - q.z0 : q.cz - q.z1;
  if (Math.hypot(dx, dz) < 1e-6) { dx = end === 0 ? q.x1 - q.x0 : q.x0 - q.x1; dz = end === 0 ? q.z1 - q.z0 : q.z0 - q.z1; }
  const l = Math.hypot(dx, dz) || 1;
  return end === 0
    ? { dx: dx / l, dz: dz / l, left: info.left, right: info.right, asphLeft: info.asphaltLeft, asphRight: info.asphaltRight }
    : { dx: dx / l, dz: dz / l, left: info.right, right: info.left, asphLeft: info.asphaltRight, asphRight: info.asphaltLeft };
}

const tmp = new Float64Array(16);

/** Turning bulb at a dead end (roadcraft `junction/bulb.ts`): asphalt radius and footway width. */
export const BULB_R = 10, BULB_WALK = 2.5;
/** Mark of a node with a bulb in the graph sent to the workers (`RoadGraph.nctl`). */
export const NODE_BULB = 200;

/**
 * Setback of a dead end with a bulb: where the asphalt circle meets the carriageway edge (0 = no bulb: wide road,
 * short segment). The segment ends there and the bulb draws the rest, with nothing on the same plane.
 */
export function bulbRetreat(arm: Arm, len: number): number {
  const half = Math.max(arm.asphLeft, arm.asphRight);
  if (half > 6.5 || half < 1 || len < 40) return 0;
  return Math.min(Math.sqrt(BULB_R * BULB_R - half * half), len * 0.45);
}

/**
 * Setback of each arm of a node (in the given order). `lens` caps the setback at 45%
 * of the segment. Also returns the counter-clockwise order of the arms.
 */
export function junctionRetreats(arms: Arm[], lens: number[], out: Float64Array, order: number[], bulb = false): void {
  const n = arms.length;
  order.length = 0;
  for (let i = 0; i < n; i++) order.push(i);
  if (n < 2) { if (n === 1) out[0] = bulb ? bulbRetreat(arms[0], lens[0]) : 0; return; }
  order.sort((a, b) => armAngle(arms[a].dx, arms[a].dz) - armAngle(arms[b].dx, arms[b].dz));
  armRetreats(order.map((i) => arms[i]), n >= 3 ? 3 : 0.3, tmp);
  for (let k = 0; k < n; k++) out[order[k]] = Math.min(tmp[k], lens[order[k]] * 0.45);
}

const bulbQ: Quad = { x0: 0, z0: 0, cx: 0, cz: 0, x1: 0, z1: 0 };

/**
 * The node is a dead end with a turning bulb: narrow road, long segment and no other road closer than the bulb
 * plus a margin (generation leaves ends touching other roads: there the circle would cover the other carriageway).
 * The page decides (and marks it in the graph, NODE_BULB); the simulation uses this same rule.
 */
export function bulbAt(net: RoadNetwork, n: number): boolean {
  const nc = net.nodes.cols;
  if (!net.nodes.alive[n] || nc.deg[n] !== 1) return false;
  // every cell touching the node asks again (mesh, lots, props): kept until the network changes
  let c = bulbCache.get(net);
  if (!c || c.version !== net.version) { c = { version: net.version, at: new Map() }; bulbCache.set(net, c); }
  const known = c.at.get(n);
  if (known !== undefined) return known;
  const v = bulbClear(net, n, net.junctions.get(n)?.end);
  c.at.set(n, v);
  return v;
}

const bulbCache = new WeakMap<RoadNetwork, { version: number; at: Map<number, boolean> }>();

function bulbClear(net: RoadNetwork, n: number, end?: 'bulb' | 'plain'): boolean {
  if (end === 'plain') return false;
  const nc = net.nodes.cols;
  const sc = net.segs.cols;
  const s = net.segsOf(n, [])[0];
  // trains do not turn round at the end of the line
  if (PROFILE_INFO[sc.profile[s]].rail) return false;
  if (bulbRetreat(armOf(net.quad(s), sc.profile[s], sc.a[s] === n ? 0 : 1), sc.len[s]) <= 0) return false;
  // the player asked for a bulb: it goes even with another road near (the automatic rule keeps clear of it)
  if (end === 'bulb') return true;
  const x = nc.x[n], z = nc.z[n], reach = BULB_R + BULB_WALK + 3;
  let clear = true;
  net.forSegsNear(x - reach - 30, z - reach - 30, x + reach + 30, z + reach + 30, (o) => {
    if (!clear || o === s) return;
    net.quad(o, bulbQ);
    const [, d] = closestT(bulbQ, x, z);
    if (d - PROFILE_INFO[sc.profile[o]].right < reach) clear = false;
  });
  return clear;
}

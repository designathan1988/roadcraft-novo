// Node shape, the same for drawing (mesh worker) and for traffic (simulation
// worker): the arm of each segment end and the setback of each arm.

import { armAngle, armRetreats, closestT, lineLine, type Arm, type Quad } from './geometry.ts';
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
  if (n === 2) {
    // a road going on through the node (bend, width step): the mitre and the 1:8 taper
    armRetreats(order.map((i) => arms[i]), 0.3, tmp);
    for (let k = 0; k < n; k++) out[order[k]] = Math.min(tmp[k], lens[order[k]] * 0.45);
    return;
  }
  // a junction: each leg set back as far as its two corners need (Roadcraft trim.ts: the largest demand)
  for (let k = 0; k < n; k++) tmp[k] = 0;
  for (let k = 0; k < n; k++) {
    const f = cornerFillet(arms[order[k]], arms[order[(k + 1) % n]]);
    tmp[k] = Math.max(tmp[k], f.trimA);
    tmp[(k + 1) % n] = Math.max(tmp[(k + 1) % n], f.trimB);
  }
  for (let k = 0; k < n; k++) out[order[k]] = Math.max(0, Math.min(tmp[k], 60, lens[order[k]] * 0.45));
}

/** Kerb return radius bounds (m) and the angles under which a corner is not rounded (Roadcraft corners.ts). */
const CURB_R_MIN = 2.8, CURB_R_MAX = 7.2, TAPER_ANGLE = (12 * Math.PI) / 180, ACUTE = (12 * Math.PI) / 180, CORNER_MITER = 2.5;

/** The corner between arm `a` and the next arm counter-clockwise, `b`, where a's left kerb meets b's right kerb. */
export interface Corner {
  /** fillet: a circular kerb return; bevel: a straight cut (very sharp corner); taper: a width step on a near-straight
   *  pair; none: the arms run opposite (no corner between them). */
  mode: 'fillet' | 'bevel' | 'taper' | 'none';
  /** How far along each arm (from the node) the corner reaches: the arm's mouth may not be nearer than this. */
  trimA: number; trimB: number;
  /** The kerb return: radius and centre (fillet only). */
  r: number; cx: number; cz: number;
}

/**
 * Roadcraft 4.0 `junction/corners.ts` on this engine's arms: the kerbs (carriageway edges) of two neighbouring arms
 * meet at a point; a fillet of radius clamp(0.5 × the narrower road's half width, 2.8, 7.2) m rounds them, tangent
 * to both, and each arm is cut where its tangent point is. A corner sharper than 12°, or whose kerbs meet more than
 * 2.5 half widths out, is bevelled at the distance where the two carriageways stand side by side. A near-straight
 * pair with a width step tapers at 12°.
 */
export function cornerFillet(a: Arm, b: Arm): Corner {
  const none: Corner = { mode: 'none', trimA: 0, trimB: 0, r: 0, cx: 0, cz: 0 };
  const aw = a.asphLeft, bw = b.asphRight;
  const dot = Math.max(-1, Math.min(1, a.dx * b.dx + a.dz * b.dz));
  const psi = Math.acos(dot);
  if (psi > Math.PI - 1e-3) return none;
  const step = Math.abs(aw - bw);
  if (Math.PI - psi < TAPER_ANGLE) {
    if (step < 0.05) return none;
    const run = step / Math.tan(TAPER_ANGLE) / 2;
    return { mode: 'taper', trimA: run, trimB: run, r: 0, cx: 0, cz: 0 };
  }
  // a's left kerb: (a.dz, −a.dx)·aw + a·s; b's right kerb: (−b.dz, b.dx)·bw + b·t
  const hit = lineLine(a.dz * aw, -a.dx * aw, a.dx, a.dz, -b.dz * bw, b.dx * bw, b.dx, b.dz);
  const maxHw = Math.max(a.left, a.right, b.left, b.right);
  if (!hit || psi < ACUTE || Math.hypot(a.dz * aw + a.dx * hit[0], -a.dx * aw + a.dz * hit[0]) > CORNER_MITER * maxHw || hit[0] < -maxHw || hit[1] < -maxHw) {
    const t = (1.02 * (aw + bw)) / (2 * Math.sin(Math.max(psi, 1e-3) / 2));
    return { mode: 'bevel', trimA: t, trimB: t, r: 0, cx: 0, cz: 0 };
  }
  const r = Math.max(CURB_R_MIN, Math.min(CURB_R_MAX, 0.5 * Math.min(a.left, b.right)));
  const run = r / Math.tan(psi / 2);
  const xx = a.dz * aw + a.dx * hit[0], xz = -a.dx * aw + a.dz * hit[0];
  const bx = a.dx + b.dx, bz = a.dz + b.dz, bl = Math.hypot(bx, bz) || 1, k = r / Math.sin(psi / 2);
  return { mode: 'fillet', trimA: hit[0] + run, trimB: hit[1] + run, r, cx: xx + (bx / bl) * k, cz: xz + (bz / bl) * k };
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

// What a road holds at a point of the ground: nothing, its footway (sidewalk and kerb) or its carriageway (lanes,
// parking, bike lanes, median). Asked for the things standing on the ground: a road being built clears what is on
// its ground and what stands on its carriageway is never placed (the owner, 2026-10-30: only the sidewalk takes
// poles, lamps, benches, bins and street furniture; nothing stands in the middle of a road). A bridge's deck and a
// tunnel are not on the ground: what is under or over them stays (as Roadcraft 4.0's `onRoadGround`).

import { bez, bezD, closestT, type Quad } from './geometry.ts';
import { BuildKind, kindOfFlags } from './economy.ts';
import type { RoadNetwork } from './network.ts';
import { PROFILE_INFO } from './profiles.ts';

export const RoadGround = { None: 0, Footway: 1, Carriageway: 2 } as const;

const q: Quad = { x0: 0, z0: 0, cx: 0, cz: 0, x1: 0, z1: 0 };
const p = new Float64Array(2), d = new Float64Array(2);

/** The strip of the road of profile `profile` along curve `quad` at (x, z): None, Footway or Carriageway. */
export function stripOfRoad(quad: Quad, profile: number, x: number, z: number): number {
  const info = PROFILE_INFO[profile];
  if (!info) return RoadGround.None;
  const [t, dist] = closestT(quad, x, z);
  if (dist >= Math.max(info.left, info.right)) return RoadGround.None;
  // the signed offset across the road: + to the left of its direction (geometry.ts), the profile's u
  bez(quad, t, p); bezD(quad, t, d);
  const len = Math.hypot(d[0], d[1]) || 1;
  const u = ((x - p[0]) * d[1] - (z - p[1]) * d[0]) / len;
  for (const e of info.edges) {
    if (u < e.u0 || u > e.u1) continue;
    return e.strip.kind === 'sidewalk' || e.strip.kind === 'curb' ? RoadGround.Footway : RoadGround.Carriageway;
  }
  return RoadGround.None;
}

/** The strip of road ground at (x, z): the most of every road there (a carriageway wins over a footway), or None. */
export function roadGroundAt(net: RoadNetwork, x: number, z: number): number {
  const sc = net.segs.cols;
  let out: number = RoadGround.None;
  net.forSegsNear(x - 1, z - 1, x + 1, z + 1, (s) => {
    if (out === RoadGround.Carriageway || !net.segs.alive[s]) return;
    const kind = kindOfFlags(sc.flags[s]);
    if (kind === BuildKind.Bridge || kind === BuildKind.Tunnel) return;
    out = Math.max(out, stripOfRoad(net.quad(s, q), sc.profile[s], x, z));
  });
  return out;
}

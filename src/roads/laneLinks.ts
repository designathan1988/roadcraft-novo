// Lane connections chosen by hand at a junction: for each incoming lane, the exit roads it may take. The same count
// runs on the page (painted arrows, panel) and in the simulation (the connections cars use), so the arrow always
// matches the behaviour.

import { armOf } from './junction.ts';
import { PROFILE_INFO, TurnBit } from './profiles.ts';
import { banned, type JunctionSpec } from './control.ts';
import type { RoadNetwork } from './network.ts';
import type { NodeId, SegId } from '../core/ids.ts';

/** Lanes of a segment in one direction (+1 from a to b). */
export function lanesIn(profile: number, dir: number): number {
  const info = PROFILE_INFO[profile];
  return dir > 0 ? info.lanesFwd : info.lanesBack;
}

/** Effective arrows: the lane's own, or by position (the right lane turns right, the left one left). */
export function defaultTurns(turns: number, idx: number, count: number): number {
  if (turns) return turns;
  if (count === 1) return TurnBit.Left | TurnBit.Straight | TurnBit.Right;
  if (idx === 0) return TurnBit.Right | TurnBit.Straight;
  if (idx === count - 1) return TurnBit.Left | TurnBit.Straight;
  return TurnBit.Straight;
}

/** A movement arriving on heading h and leaving by arm o: its arrow bit (left, straight, right). */
export function turnBit(hx: number, hz: number, ox: number, oz: number): number {
  const left = ox * hz - oz * hx;
  const fwd = ox * hx + oz * hz;
  return fwd > 0.7 ? TurnBit.Straight : left > 0 ? TurnBit.Left : TurnBit.Right;
}

/** Exit roads chosen by hand for lane `idx` arriving by `seg`, or null (automatic). */
export function customExits(spec: JunctionSpec | undefined, seg: SegId, idx: number): SegId[] | null {
  const l = spec?.lanes;
  if (!l) return null;
  for (const [s, i, to] of l) if (s === seg && i === idx) return to;
  return null;
}

/** The node's arms: segment, end (0 = a), exit direction. */
export function armsOf(net: RoadNetwork, n: NodeId): Array<{ s: SegId; end: 0 | 1; dx: number; dz: number }> {
  const sc = net.segs.cols;
  return net.segsOf(n, []).map((s) => {
    const end: 0 | 1 = sc.a[s] === n ? 0 : 1;
    const a = armOf(net.quad(s), sc.profile[s], end);
    return { s, end, dx: a.dx, dz: a.dz };
  });
}

/**
 * Automatic and effective exits of each lane arriving by `seg` at node `n`: a list per lane of
 * [exit segment, arrow bit]. `custom` says whether the lane was set by hand.
 */
export function laneExits(net: RoadNetwork, n: NodeId, seg: SegId, spec = net.junctions.get(n)): Array<{ exits: Array<[SegId, number]>; auto: Array<[SegId, number]>; custom: boolean }> {
  const sc = net.segs.cols;
  const arms = armsOf(net, n);
  const me = arms.find((a) => a.s === seg);
  if (!me) return [];
  const inDir = me.end === 1 ? 1 : -1;
  const m = lanesIn(sc.profile[seg], inDir);
  const info = PROFILE_INFO[sc.profile[seg]];
  const lanes = inDir > 0 ? info.fwd : info.back;
  const out: Array<{ exits: Array<[SegId, number]>; auto: Array<[SegId, number]>; custom: boolean }> = [];
  for (let a = 0; a < m; a++) {
    const auto: Array<[SegId, number]> = [], all: Array<[SegId, number]> = [];
    const turns = defaultTurns(lanes[a]?.turns ?? 0, a, m);
    for (const o of arms) {
      if (o.s === seg) continue;
      if (banned(spec, seg, o.s)) continue;
      if (PROFILE_INFO[sc.profile[seg]].rail !== PROFILE_INFO[sc.profile[o.s]].rail) continue;
      if (lanesIn(sc.profile[o.s], o.end === 0 ? 1 : -1) === 0) continue;
      const bit = arms.length <= 2 ? TurnBit.Straight : turnBit(-me.dx, -me.dz, o.dx, o.dz);
      all.push([o.s, bit]);
      if (arms.length <= 2 || (turns & bit)) auto.push([o.s, bit]);
    }
    const c = customExits(spec, seg, a);
    out.push({ exits: c ? all.filter(([s]) => c.includes(s)) : auto, auto, custom: !!c });
  }
  return out;
}

/** The end's painted arrows (3 bits per lane, lane 0 in the low bits), or 0 when no lane was set by hand. */
export function arrowCode(net: RoadNetwork, n: NodeId, seg: SegId): number {
  const ex = laneExits(net, n, seg);
  if (!ex.some((e) => e.custom)) return 0;
  let code = 0;
  ex.forEach((e, a) => { if (a < 5) code += (e.exits.reduce((b, [, bit]) => b | bit, 0) || TurnBit.Straight) * 8 ** a; });
  return code;
}

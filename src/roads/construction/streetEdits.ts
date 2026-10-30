import type { World } from '../../world/world.ts';
import { arcTable, type Quad } from '../geometry.ts';
import { SegFlag } from '../flags.ts';
import { PROFILE_INFO } from '../profiles.ts';
import { armOf } from '../junction.ts';
import { RoadJournal } from './journal.ts';
import { clearAndConform } from './execute.ts';

// ------------------------------------------------------------ other edits

/** Demolishes a segment; nodes left loose go with it. */
export function demolishSeg(world: World, s: number): RoadJournal {
  const net = world.roads;
  const j = new RoadJournal(world, 'demolir via');
  const rec = j.removeSeg(s);
  for (const n of [rec.a, rec.b]) if (net.nodes.alive[n] && net.nodes.cols.deg[n] === 0) j.removeNode(n);
  return j;
}

export function changeProfile(world: World, s: number, profile: number): RoadJournal {
  const j = new RoadJournal(world, 'trocar perfil');
  if (world.roads.segs.cols.flags[s] & SegFlag.Ring) return j;
  j.guard(() => { j.setProfile(s, profile); settleUnder(j, world, s); });
  return j;
}

/** After a profile change: like a new road, what the (wider) road now covers goes and the terrain settles under it. */
function settleUnder(j: RoadJournal, world: World, s: number): void {
  const net = world.roads, sc = net.segs.cols, nc = net.nodes.cols;
  const sq = net.quad(s), t = arcTable(sq, 32), L = t[t.length - 1];
  const ya = nc.y[sc.a[s]], yb = nc.y[sc.b[s]];
  clearAndConform(j, world, sq, sc.profile[s], (d) => ya + (yb - ya) * d / L, t, (sc.flags[s] & SegFlag.Wall) !== 0);
}

/**
 * The whole street of a segment: walks through the nodes picking, at each one, the segment
 * that continues straightest (up to 35°) with the same profile (`anyProfile`: whatever its profile, never from a
 * road onto rails or back). One-way roads only follow the same direction.
 */
export function streetChain(world: World, s0: number, anyProfile = false): number[] {
  const net = world.roads, sc = net.segs.cols;
  const prof = sc.profile[s0];
  const oneWay = PROFILE_INFO[prof].oneWay;
  const out = [s0];
  const seen = new Set([s0]);
  const q: Quad = { x0: 0, z0: 0, cx: 0, cz: 0, x1: 0, z1: 0 };
  const list: number[] = [];
  for (const startEnd of [1, 0] as const) {
    let s = s0, end: 0 | 1 = startEnd;
    for (let guard = 0; guard < 4000; guard++) {
      const n = end === 1 ? sc.b[s] : sc.a[s];
      const here = armOf(net.quad(s, q), prof, end);
      // arrival heading = opposite of the arm
      const hx = -here.dx, hz = -here.dz;
      let best = -1, bestDot = Math.cos(35 * Math.PI / 180), bestEnd: 0 | 1 = 0;
      for (const t of net.segsOf(n, list)) {
        if (seen.has(t) || (sc.flags[t] & SegFlag.Ring)) continue;
        if (anyProfile ? PROFILE_INFO[sc.profile[t]].rail !== PROFILE_INFO[prof].rail : sc.profile[t] !== prof) continue;
        const tEnd: 0 | 1 = sc.a[t] === n ? 0 : 1;
        if (oneWay && PROFILE_INFO[sc.profile[t]].oneWay && tEnd !== (end === 1 ? 0 : 1)) continue;
        const arm = armOf(net.quad(t, q), prof, tEnd);
        const d = arm.dx * hx + arm.dz * hz;
        if (d > bestDot) { bestDot = d; best = t; bestEnd = tEnd; }
      }
      if (best < 0) break;
      seen.add(best); out.push(best);
      s = best; end = bestEnd === 0 ? 1 : 0;
    }
  }
  return out;
}

/** Changes the profile of several segments in a single command. */
export function changeProfiles(world: World, segs: number[], profile: number, ref = segs[0]): RoadJournal {
  const j = new RoadJournal(world, 'trocar perfil da rua');
  const net = world.roads;
  // a profile that is not the same seen from both ends (parking on one side, a bus lane…) is laid the way `ref` runs:
  // segments of the street drawn the other way are turned round first, so it lands on the same side of every block
  const along = mirrorSymmetric(profile) ? null : alongStreet(world, segs, ref);
  j.guard(() => {
    for (let s of segs) {
      if (!net.segs.alive[s] || (net.segs.cols.flags[s] & SegFlag.Ring)) continue;
      if (along && along.get(s) === false) {
        const r = j.removeSeg(s);
        s = j.addSeg({ a: r.b, b: r.a, cx: r.cx, cz: r.cz, profile: r.profile, flags: r.flags, zl: r.zr, zr: r.zl });
      }
      j.setProfile(s, profile);
      settleUnder(j, world, s);
    }
  });
  return j;
}

/** The profile reads the same from both ends (its strips mirrored, with each lane's direction turned, are itself). */
export function mirrorSymmetric(profile: number): boolean {
  const st = PROFILE_INFO[profile].strips, n = st.length;
  for (let i = 0; i < n; i++) {
    const a = st[i], b = st[n - 1 - i];
    if (a.kind !== b.kind || Math.abs(a.width - b.width) > 0.01 || !!a.bus !== !!b.bus || !!a.rail !== !!b.rail || (a.pave ?? 0) !== (b.pave ?? 0)) return false;
    if (a.kind === 'lane' && (a.dir ?? 1) !== -(b.dir ?? 1)) return false;
  }
  return true;
}

/**
 * Whether each segment of a connected street runs the way `ref` does (true) or against it, walking from `ref` through
 * the nodes the segments share.
 */
export function alongStreet(world: World, segs: number[], ref: number): Map<number, boolean> {
  const sc = world.roads.segs.cols, set = new Set(segs);
  const out = new Map<number, boolean>([[ref, true]]);
  const queue = [ref];
  while (queue.length) {
    const s = queue.pop()!, fwd = out.get(s)!;
    // the node where the street leaves s going forward, and where it comes in
    const ahead = fwd ? sc.b[s] : sc.a[s], behind = fwd ? sc.a[s] : sc.b[s];
    for (const t of world.roads.segsOf(ahead, [])) if (set.has(t) && !out.has(t)) { out.set(t, sc.a[t] === ahead); queue.push(t); }
    for (const t of world.roads.segsOf(behind, [])) if (set.has(t) && !out.has(t)) { out.set(t, sc.b[t] === behind); queue.push(t); }
  }
  return out;
}

/**
 * Roundabout: cuts the roads inside the circle, connects the ends to the ring and closes the
 * ring in arcs (counter-clockwise traffic seen from above).
 */
/**
 * Why a roundabout cannot go at (cx, cz), or '' when it can (the tool shows it and the preview turns red): another
 * roundabout in the circle, water under the ring (a roundabout never fills the sea or a river), or, unless `cut`, a
 * road the ring would cut (Roadcraft puts roundabouts on vacant ground; cutting roads in is asked for).
 */

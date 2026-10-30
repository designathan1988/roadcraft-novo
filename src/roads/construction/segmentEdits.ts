import { MAP_HALF } from '../../config.ts';
import { heightAt } from '../../world/heights.ts';
import type { World } from '../../world/world.ts';
import { arcTable, bezD, bezLength, intersectQuads, type Quad } from '../geometry.ts';
import { MAX_SEG_LEN, type RoadNetwork } from '../network.ts';
import { t as text } from '../../shared/i18n/index.ts';
import { SegFlag } from '../flags.ts';
import { PROFILE_INFO } from '../profiles.ts';
import { KIND_MASK } from '../economy.ts';
import { dirOut } from '../control.ts';
import { MIN_LEG_ANGLE } from '../impossible.ts';
import { RoadJournal } from './journal.ts';
import { buildRoad, clearAndConform, splitSeg } from './execute.ts';
import { segHeightAt, snap } from './snap.ts';
import type { Anchor } from './snap.ts';
import { planRoad } from './plan.ts';
import type { NodeId, SegId } from '../../core/ids.ts';

export function segPreview(net: RoadNetwork, s: SegId): { quad: Quad; ya: number; yb: number; half: number } {
  const sc = net.segs.cols, nc = net.nodes.cols;
  return { quad: net.quad(s), ya: nc.y[sc.a[s]], yb: nc.y[sc.b[s]], half: PROFILE_INFO[sc.profile[s]].right };
}


// ------------------------------------------- move, split, reverse, join, duplicate

/** Segments of the road between two junctions (through degree-2 nodes with the same profile), in order. */
export function roadBetweenJunctions(world: World, s0: SegId): SegId[] {
  const net = world.roads, sc = net.segs.cols, nc = net.nodes.cols;
  const prof = sc.profile[s0];
  const walk = (from: SegId, node: NodeId): SegId[] => {
    const out: SegId[] = [];
    let s = from, n = node;
    for (let guard = 0; guard < 2000 && nc.deg[n] === 2; guard++) {
      const t = net.segsOf(n, []).find((x) => x !== s);
      if (t === undefined || sc.profile[t] !== prof || (sc.flags[t] & SegFlag.Ring) || out.includes(t) || t === s0) break;
      out.push(t);
      n = sc.a[t] === n ? sc.b[t] : sc.a[t];
      s = t;
    }
    return out;
  };
  return [...walk(s0, sc.a[s0]).reverse(), s0, ...walk(s0, sc.b[s0])];
}

/** Splits the segment at `t` (0..1) with a new node. */
export function splitAt(world: World, s: SegId, t = 0.5): RoadJournal {
  const j = new RoadJournal(world, 'dividir via');
  const L = world.roads.segs.cols.len[s];
  if (t * L < 4 || (1 - t) * L < 4) return j;
  splitSeg(j, world.roads, s, t, null);
  return j;
}

/** Pedestrian crossing mid-segment: a new node at `t` with the control (zebra or traffic light). */
export function addCrossing(world: World, s: SegId, t: number, ctl: number): RoadJournal | string {
  const net = world.roads, sc = net.segs.cols;
  if (!PROFILE_INFO[sc.profile[s]].walk) return 'Esta via não tem pedestres.';
  const L = sc.len[s];
  if (t * L < 14 || (1 - t) * L < 14) return 'A faixa precisa de espaço para uma fila de carros dos dois lados.';
  const j = new RoadJournal(world, 'faixa de pedestres');
  const n = splitSeg(j, net, s, t, null);
  j.setJunction(n, { ctl });
  return j;
}

/** U-turn through the median: a new node at `t` where the left lane turns back the other way. */
export function addUTurn(world: World, s: SegId, t: number): RoadJournal | string {
  const net = world.roads, sc = net.segs.cols;
  const info = PROFILE_INFO[sc.profile[s]];
  const med = info.edges.find((e) => e.strip.kind === 'median');
  if (info.oneWay || !med) return 'O retorno precisa de uma via de mão dupla com canteiro central.';
  if (med.u1 - med.u0 < 1.5) return 'Canteiro estreito demais para um retorno.';
  const L = sc.len[s];
  if (t * L < 16 || (1 - t) * L < 16) return 'O retorno precisa de espaço para uma fila de carros dos dois lados.';
  const j = new RoadJournal(world, 'retorno');
  const n = splitSeg(j, net, s, t, null);
  j.setJunction(n, { ctl: 11 });
  return j;
}

/** Reverses the direction of the one-way road between two junctions (each segment's ends swap). */
export function reverseRoad(world: World, s: SegId): RoadJournal {
  const net = world.roads, j = new RoadJournal(world, 'inverter mão');
  if (!PROFILE_INFO[net.segs.cols.profile[s]].oneWay) return j;
  for (const id of roadBetweenJunctions(world, s)) {
    const r = j.removeSeg(id);
    j.addSeg({ a: r.b, b: r.a, cx: r.cx, cz: r.cz, profile: r.profile, flags: r.flags, zl: r.zr, zr: r.zl });
  }
  return j;
}

/** Joins the two roads of a degree-2 node (same profile) into one segment. Empty if not possible. */
export function joinAt(world: World, n: NodeId): RoadJournal {
  const net = world.roads, sc = net.segs.cols, nc = net.nodes.cols;
  const j = new RoadJournal(world, 'unir vias');
  const segs = net.segsOf(n, []);
  if (segs.length !== 2) return j;
  const [s1, s2] = segs;
  if (sc.profile[s1] !== sc.profile[s2] || (sc.flags[s1] & ~KIND_MASK) !== (sc.flags[s2] & ~KIND_MASK) || (sc.flags[s1] & SegFlag.Ring)) return j;
  // the spatial index finds a segment by its midpoint: none may be longer than MAX_SEG_LEN
  if (sc.len[s1] + sc.len[s2] > MAX_SEG_LEN) return j;
  // ends in order (s1 arrives at the node, s2 leaves it), respecting the one-way direction
  const p = sc.a[s1] === n ? sc.b[s1] : sc.a[s1], q = sc.a[s2] === n ? sc.b[s2] : sc.a[s2];
  if (p === q) return j;
  const forward = sc.b[s1] === n;
  if (PROFILE_INFO[sc.profile[s1]].oneWay && forward !== (sc.a[s2] === n)) return j;
  // the joined segment runs the way s1 does; s2's sides seen that way must hold the same zones
  const s2Along = forward ? sc.a[s2] === n : sc.b[s2] === n;
  const zl2 = s2Along ? sc.zl[s2] : sc.zr[s2], zr2 = s2Along ? sc.zr[s2] : sc.zl[s2];
  if (zl2 !== sc.zl[s1] || zr2 !== sc.zr[s1]) return j;
  // one segment is straight in height between its nodes: a node off that line would be lost
  if (Math.abs(nc.y[n] - (nc.y[p] + nc.y[q]) / 2) > 0.3) return j;
  // control point that makes the curve pass through the node at t = 0.5
  const cx = 2 * nc.x[n] - (nc.x[p] + nc.x[q]) / 2, cz = 2 * nc.z[n] - (nc.z[p] + nc.z[q]) / 2;
  const r1 = j.removeSeg(s1); j.removeSeg(s2);
  j.removeNode(n);
  const [a, b] = forward ? [p, q] : [q, p];
  const joined = j.addSeg({ a, b, cx, cz, profile: r1.profile, flags: r1.flags, zl: r1.zl, zr: r1.zr });
  j.inherit(s1, [joined]); j.inherit(s2, [joined]);
  return j;
}

/** Moves the node to (x, z): attached roads follow (curves translated by half). Refuses roads that get too short. */
export function moveNode(world: World, n: NodeId, x: number, z: number): RoadJournal | string {
  const net = world.roads, sc = net.segs.cols, nc = net.nodes.cols;
  const j = new RoadJournal(world, 'mover nó');
  const dx = x - nc.x[n], dz = z - nc.z[n];
  if (Math.abs(x) > MAP_HALF - 20 || Math.abs(z) > MAP_HALF - 20) return text('road.move.outside');
  const ground = heightAt(world.heights, x, z);
  const y = ground > nc.y[n] + 4 || ground < nc.y[n] - 4 ? nc.y[n] : Math.max(nc.y[n], ground);
  const segs = net.segsOf(n, []);
  const eq: Quad = { x0: 0, z0: 0, cx: 0, cz: 0, x1: 0, z1: 0 };
  for (const s of segs) {
    const o = sc.a[s] === n ? sc.b[s] : sc.a[s];
    if (Math.hypot(nc.x[o] - x, nc.z[o] - z) < 8) return 'uma via ali ficaria curta demais';
    // the curve's length after the move (control point translated by half), within the spatial index's limit
    const q = net.quad(s);
    if (sc.a[s] === n) { q.x0 = x; q.z0 = z; } else { q.x1 = x; q.z1 = z; }
    q.cx += dx / 2; q.cz += dz / 2;
    if (bezLength(q) > MAX_SEG_LEN) return text('road.move.tooLong', { max: MAX_SEG_LEN });
    if (sc.flags[s] & SegFlag.Ring) return 'nó de rotatória não se move';
    // the moved road may not run into another one at its level (that would need a junction)
    let crosses = false;
    const yo = nc.y[o];
    net.forSegsNear(Math.min(q.x0, q.cx, q.x1), Math.min(q.z0, q.cz, q.z1), Math.max(q.x0, q.cx, q.x1), Math.max(q.z0, q.cz, q.z1), (t) => {
      if (crosses || t === s || sc.a[t] === n || sc.b[t] === n || sc.a[t] === o || sc.b[t] === o) return;
      net.quad(t, eq);
      for (const [tn, to] of intersectQuads(q, eq)) {
        const yNew = sc.a[s] === n ? y + (yo - y) * tn : yo + (y - yo) * tn;
        if (Math.abs(yNew - segHeightAt(net, t, to)) < 4.5) crosses = true;
      }
    });
    if (crosses) return text('road.move.crosses');
  }
  const recs = segs.map((s) => j.removeSeg(s));
  const rec = net.nodeRec(n);
  j.removeNode(n);
  net.addNode({ ...rec, x, z, y });
  j.recordAddNode(n);
  j.guard(() => {
    for (const r of recs) {
      const s = j.addSeg({ ...r, cx: r.cx + dx / 2, cz: r.cz + dz / 2 });
      // like a new road: what stands in the way goes, the terrain settles under it
      const sq = net.quad(s), t = arcTable(sq, 32), L = t[t.length - 1];
      const ya = nc.y[sc.a[s]], yb = nc.y[sc.b[s]];
      clearAndConform(j, world, sq, sc.profile[s], (d) => ya + (yb - ya) * d / L, t, (sc.flags[s] & SegFlag.Wall) !== 0);
    }
  });
  return j;
}

/**
 * Bends a road (Roadcraft 4.0 core/bezier.ts controlPoint, ui/inspector.ts:325-341): its control point `h` metres off
 * the chord (signed, left of a → b positive) at `t` (0.15..0.85) along it. Refused like a moved node: longer than the
 * spatial index holds, running into another road at its level, or leaving a leg sharper than MIN_LEG_ANGLE to its
 * neighbour at either end. What stands in the way goes and the terrain settles under it, like a new road.
 */
export function bendRoad(world: World, s: SegId, t: number, h: number): RoadJournal | string {
  const net = world.roads, sc = net.segs.cols, nc = net.nodes.cols;
  if (sc.flags[s] & SegFlag.Ring) return text('road.bend.ring');
  const a = sc.a[s], b = sc.b[s];
  const dx = nc.x[b] - nc.x[a], dz = nc.z[b] - nc.z[a], L = Math.hypot(dx, dz) || 1;
  const tt = Math.max(0.15, Math.min(0.85, t));
  // left of a → b: (dz, −dx) in this engine's frame (as the profiles' u)
  const cx = nc.x[a] + dx * tt + (dz / L) * h, cz = nc.z[a] + dz * tt - (dx / L) * h;
  const q: Quad = { x0: nc.x[a], z0: nc.z[a], cx, cz, x1: nc.x[b], z1: nc.z[b] };
  if (bezLength(q) > MAX_SEG_LEN) return text('road.move.tooLong', { max: MAX_SEG_LEN });
  const eq: Quad = { x0: 0, z0: 0, cx: 0, cz: 0, x1: 0, z1: 0 };
  let crosses = false;
  net.forSegsNear(Math.min(q.x0, q.cx, q.x1), Math.min(q.z0, q.cz, q.z1), Math.max(q.x0, q.cx, q.x1), Math.max(q.z0, q.cz, q.z1), (o) => {
    if (crosses || o === s || sc.a[o] === a || sc.b[o] === a || sc.a[o] === b || sc.b[o] === b) return;
    net.quad(o, eq);
    for (const [ts, to] of intersectQuads(q, eq)) if (Math.abs(nc.y[a] + (nc.y[b] - nc.y[a]) * ts - segHeightAt(net, o, to)) < 4.5) crosses = true;
  });
  if (crosses) return text('road.move.crosses');
  // the leg's new direction at each end against the other roads there
  for (const [n, tx, tz] of [[a, cx - nc.x[a], cz - nc.z[a]], [b, cx - nc.x[b], cz - nc.z[b]]] as Array<[NodeId, number, number]>) {
    const ang = Math.atan2(tz, tx);
    for (const o of net.segsOf(n, [])) {
      if (o === s) continue;
      const d = dirOut(net, n, o);
      let gap = Math.abs(Math.atan2(d[1], d[0]) - ang) % (2 * Math.PI);
      gap = Math.min(gap, 2 * Math.PI - gap) * 180 / Math.PI;
      if (gap < MIN_LEG_ANGLE) return text('road.bend.sharp', { angle: Math.round(gap) });
    }
  }
  const j = new RoadJournal(world, 'curvar via');
  const r = j.removeSeg(s);
  j.guard(() => {
    const id = j.addSeg({ ...r, cx, cz });
    const sq = net.quad(id), tab = arcTable(sq, 32), len = tab[tab.length - 1];
    const ya = nc.y[a], yb = nc.y[b];
    clearAndConform(j, world, sq, sc.profile[id], (d) => ya + (yb - ya) * d / len, tab, (sc.flags[id] & SegFlag.Wall) !== 0);
  });
  return j;
}

/** Roadcraft 4.0's upgrade ladder (world/roadTypes.ts:232-233: local, urban, avenue, boulevard), by our profiles' names. */
const UPGRADE_LADDER = ['Rua local', 'Rua urbana', 'Avenida', 'Bulevar'];

/**
 * The class one step up the ladder from `profile` (by its priority: a street with parking is on the urban rung),
 * or −1 at the top, and for highways, rails and rings, which are not on the ladder.
 */
export function upgradeStep(profile: number): number {
  const info = PROFILE_INFO[profile];
  if (!info || info.ring || info.rail || (info.priority ?? 0) >= 4) return -1;
  const rungs = UPGRADE_LADDER.map((name) => PROFILE_INFO.findIndex((p) => p?.name === name)).filter((i) => i >= 0);
  const next = rungs.find((i) => (PROFILE_INFO[i].priority ?? 0) > (info.priority ?? 0) && i !== profile);
  return next ?? -1;
}

/** A height point on the road (Roadcraft 4.0 ui/inspector.ts:264): the road split in the middle; its new node. */
export function addHeightPoint(world: World, s: SegId): { journal: RoadJournal; node: NodeId } | string {
  const L = world.roads.segs.cols.len[s];
  if (L < 16) return text('road.heightPoint.short');
  const j = new RoadJournal(world, 'ponto de altura');
  const node = splitSeg(j, world.roads, s, 0.5, null);
  return { journal: j, node };
}

/** An identical road parallel to the road between junctions, alongside (to the right of the drawing direction). */
export function duplicateRoad(world: World, s: SegId): RoadJournal | string {
  const net = world.roads, sc = net.segs.cols, nc = net.nodes.cols;
  const road = roadBetweenJunctions(world, s);
  const prof = sc.profile[s];
  const info = PROFILE_INFO[prof];
  const off = info.left + info.right + 2;
  // points in order along the road
  const first = road[0];
  let start = road.length > 1 && (sc.a[first] === sc.a[road[1]] || sc.a[first] === sc.b[road[1]]) ? sc.b[first] : sc.a[first];
  const total = new RoadJournal(world, 'duplicar via');
  let prev: Anchor | null = null;
  const d = new Float64Array(2);
  for (const id of road) {
    const fwd = sc.a[id] === start;
    const q = net.quad(id);
    const pts = fwd ? [q.x0, q.z0, q.cx, q.cz, q.x1, q.z1] : [q.x1, q.z1, q.cx, q.cz, q.x0, q.z0];
    const shifted: number[] = [];
    for (const [i, t] of [[0, 0], [1, 0.5], [2, 1]] as const) {
      bezD(q, fwd ? t : 1 - t, d);
      const l = Math.hypot(d[0], d[1]) || 1, sgn = fwd ? 1 : -1;
      const nx = (d[1] / l) * sgn, nz = (-d[0] / l) * sgn;
      shifted.push(pts[i * 2] + nx * off, pts[i * 2 + 1] + nz * off);
    }
    const a: Anchor = prev ?? snap(net, shifted[0], shifted[1], 2);
    const b = snap(net, shifted[4], shifted[5], 2);
    const plan = planRoad(world, a, { x: shifted[2], z: shifted[3] }, b, prof, 0);
    if (!plan.ok) { total.invert(); return plan.reason; }
    const j = buildRoad(world, plan, a, b, prof, 0, 'duplicar via');
    total.append(j);
    prev = snap(net, shifted[4], shifted[5], 1.5);
    start = fwd ? sc.b[id] : sc.a[id];
  }
  void nc;
  return total;
}

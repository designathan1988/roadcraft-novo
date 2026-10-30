import { SEA_LEVEL } from '../../config.ts';
import { heightAt } from '../../world/heights.ts';
import type { World } from '../../world/world.ts';
import { arcTable, bez, subQuad, type Quad } from '../geometry.ts';
import { t as text } from '../../shared/i18n/index.ts';
import { SegFlag } from '../flags.ts';
import { PROFILE_INFO, RING_PROFILE } from '../profiles.ts';
import { edgeRise } from '../kerb.ts';
import { RoadJournal } from './journal.ts';
import { smoothGround } from './grade.ts';
import { clearAndConform, conformDisc } from './execute.ts';
import { NO_NODE, type NodeId, type SegId } from '../../core/ids.ts';

export function roundaboutRefusal(world: World, cx: number, cz: number, radius: number, cut = true): string {
  const net = world.roads, p = new Float64Array(2);
  let ring = false, road = false;
  const reach = radius + PROFILE_INFO[RING_PROFILE].right;
  net.forSegsNear(cx - reach, cz - reach, cx + reach, cz + reach, (s) => {
    if (ring) return;
    const q = net.quad(s), isRing = (net.segs.cols.flags[s] & SegFlag.Ring) !== 0;
    for (let k = 0; k <= 16; k++) {
      bez(q, k / 16, p);
      const d = Math.hypot(p[0] - cx, p[1] - cz);
      if (isRing && d < radius) { ring = true; return; }
      if (!isRing && d < reach) road = true;
    }
  });
  if (ring) return text('road.ring.exists');
  if (road && !cut) return text('road.ring.cuts');
  const half = PROFILE_INFO[RING_PROFILE].right;
  for (const r of [radius - half, radius, radius + half]) for (let k = 0; k < 48; k++) {
    const a = (k / 48) * Math.PI * 2;
    if (heightAt(world.heights, cx + Math.cos(a) * r, cz + Math.sin(a) * r) < SEA_LEVEL + 0.3) return text('road.ring.water');
  }
  return '';
}

/**
 * Roundabout at (cx, cz). On vacant ground: the ring and four approaches of APPROACH m (Roadcraft). Over roads, when
 * `cutRoads`: the roads inside are cut and their ends joined to the ring.
 */
export function buildRoundabout(world: World, cx: number, cz: number, radius: number, cutRoads = true): RoadJournal | null {
  const net = world.roads;
  if (roundaboutRefusal(world, cx, cz, radius, cutRoads)) return null;
  const j = new RoadJournal(world, 'rotatória');
  const y = smoothGround(world.heights, cx, cz);
  const cut = radius;
  const p = new Float64Array(2);
  // every road the circle touches, before anything changes: an existing roundabout there refuses it untouched
  const hits: Array<{ s: SegId; q: Quad; crossings: number[] }> = [];
  let ringThere = false;
  net.forSegsNear(cx - cut, cz - cut, cx + cut, cz + cut, (s) => {
    const q = net.quad(s);
    const inside = (t: number) => { bez(q, t, p); return Math.hypot(p[0] - cx, p[1] - cz) < cut; };
    // crossings with the circle by sampling + bisection
    const crossings: number[] = [];
    const N = 32;
    for (let k = 0; k < N; k++) {
      const a = k / N, b = (k + 1) / N;
      if (inside(a) !== inside(b)) {
        let lo = a, hi = b;
        for (let it = 0; it < 24; it++) { const m = (lo + hi) / 2; if (inside(m) === inside(a)) lo = m; else hi = m; }
        crossings.push((lo + hi) / 2);
      }
    }
    if (!inside(0) && !inside(1) && crossings.length === 0) return;
    if (net.segs.cols.flags[s] & SegFlag.Ring) ringThere = true;
    hits.push({ s, q, crossings });
  });
  if (ringThere) return null;
  j.guard(() => roundaboutLive(j, world, cx, cz, radius, y, hits));
  return j;
}

/** Length of each approach a roundabout on vacant ground gets (m, Roadcraft). */
const APPROACH = 40;

/** Roads that meet a roundabout's circle closer than this (m) enter the ring at the same node. */
const ENTRY_MERGE = 6;

function roundaboutLive(j: RoadJournal, world: World, cx: number, cz: number, radius: number, y: number,
  hits: Array<{ s: SegId; q: Quad; crossings: number[] }>): void {
  const net = world.roads;
  const cut = radius;
  const entries: Array<{ angle: number; node: NodeId }> = [];
  const approaches: SegId[] = [];
  /**
   * The ring node where a road meets the circle: roads that meet it within ENTRY_MERGE metres share one node, so
   * the ring never gets a piece of almost no length nor goes round twice.
   */
  const entryNode = (x: number, z: number): NodeId => {
    const angle = Math.atan2(-(z - cz), x - cx);
    for (const e of entries) {
      let d = Math.abs(e.angle - angle);
      if (d > Math.PI) d = 2 * Math.PI - d;
      if (d * radius < ENTRY_MERGE) return e.node;
    }
    const node = j.addNode(x, z, y);
    entries.push({ angle, node });
    return node;
  };
  const p = new Float64Array(2);
  const created = new Set<SegId>(); // new ids may reuse victims' ids
  for (const { s, q, crossings } of hits) {
    if (!net.segs.alive[s] || created.has(s)) continue;
    const inside = (t: number) => { bez(q, t, p); return Math.hypot(p[0] - cx, p[1] - cz) < cut; };
    const rec = net.segRec(s);
    j.removeSeg(s);
    // keep the outside parts
    const pts = [0, ...crossings, 1];
    for (let k = 0; k + 1 < pts.length; k++) {
      const t0 = pts[k], t1 = pts[k + 1];
      if (inside((t0 + t1) / 2)) continue;
      let sub = subQuad(q, t0, t1);
      // the ring is flat at the center's height; the entry ramps to the rest of the road
      let na = t0 === 0 ? rec.a : entryNode(sub.x0, sub.z0);
      let nb = t1 === 1 ? rec.b : entryNode(sub.x1, sub.z1);
      // short piece up to a plain joint of the same road: swallow the joint
      const outer = t0 === 0 ? rec.a : t1 === 1 ? rec.b : NO_NODE;
      const pieceLen = Math.hypot(sub.x1 - sub.x0, sub.z1 - sub.z0);
      if (outer >= 0 && pieceLen < 14 && net.nodes.cols.deg[outer] === 1) {
        const [other] = net.segsOf(outer);
        const orec = j.removeSeg(other);
        const far = orec.a === outer ? orec.b : orec.a;
        const ring = outer === na ? nb : na;
        j.removeNode(outer);
        const nc2 = net.nodes.cols;
        sub = { x0: 0, z0: 0, cx: (nc2.x[far] + nc2.x[ring]) / 2, cz: (nc2.z[far] + nc2.z[ring]) / 2, x1: 0, z1: 0 };
        if (outer === na) { na = far; nb = ring; } else { na = ring; nb = far; }
      }
      const ns = j.addSeg({ a: na, b: nb, cx: sub.cx, cz: sub.cz, profile: rec.profile, flags: rec.flags, zl: rec.zl, zr: rec.zr });
      created.add(ns);
      j.inherit(s, [ns]);
      approaches.push(ns);
    }
  }
  // nodes left inside and loose
  const loose: NodeId[] = [];
  net.nodeIndex.query(cx - cut, cz - cut, cx + cut, cz + cut, (n) => { if (net.nodes.cols.deg[n] === 0) loose.push(n); });
  for (const n of loose) j.removeNode(n);

  // vacant ground: four approaches, two-way local streets out from the ring (Roadcraft editor/roundabout.ts)
  if (entries.length === 0) {
    for (let k = 0; k < 4; k++) {
      const ang = k * Math.PI / 2, ux = Math.cos(ang), uz = -Math.sin(ang);
      const e = j.addNode(cx + ux * radius, cz + uz * radius, y);
      entries.push({ angle: ang, node: e });
      const fx = cx + ux * (radius + APPROACH), fz = cz + uz * (radius + APPROACH);
      const far = j.addNode(fx, fz, smoothGround(world.heights, fx, fz));
      j.setJunction(far, { ctl: 0, end: 'plain' }); // an approach waits to be extended: no turning bulb
      approaches.push(j.addSeg({ a: far, b: e, cx: cx + ux * (radius + APPROACH / 2), cz: cz + uz * (radius + APPROACH / 2), profile: 0, flags: 0 }));
    }
  }
  // ring: entry nodes (already on the circle) + extra nodes for arcs of at most 50°
  const ring = entries.map((e) => ({ angle: e.angle, node: e.node }));
  const maxArc = Math.PI * 50 / 180;
  ring.sort((a, b) => a.angle - b.angle);
  const filled: Array<{ angle: number; node: NodeId }> = [];
  const nRing = ring.length;
  if (nRing === 0) {
    const k = 6;
    for (let i = 0; i < k; i++) {
      const a = -Math.PI + (2 * Math.PI * i) / k;
      filled.push({ angle: a, node: j.addNode(cx + Math.cos(a) * radius, cz - Math.sin(a) * radius, y) });
    }
  } else {
    for (let i = 0; i < nRing; i++) {
      const a = ring[i], b = ring[(i + 1) % nRing];
      filled.push(a);
      let span = b.angle - a.angle;
      if (span <= 0) span += Math.PI * 2;
      const extra = Math.ceil(span / maxArc) - 1;
      for (let k = 1; k <= extra; k++) {
        const ang = a.angle + span * k / (extra + 1);
        filled.push({ angle: ang, node: j.addNode(cx + Math.cos(ang) * radius, cz - Math.sin(ang) * radius, y) });
      }
    }
  }
  const ringSegs: SegId[] = [];
  for (let i = 0; i < filled.length; i++) {
    const a = filled[i], b = filled[(i + 1) % filled.length];
    let span = b.angle - a.angle;
    if (span <= 0) span += Math.PI * 2;
    const mid = a.angle + span / 2;
    const r = radius / Math.cos(span / 2);
    ringSegs.push(j.addSeg({ a: a.node, b: b.node, cx: cx + Math.cos(mid) * r, cz: cz - Math.sin(mid) * r, profile: RING_PROFILE, flags: SegFlag.Ring }));
  }
  // terrain under the ring, then the ring clears what stands in its way like any road
  conformDisc(j, world, cx, cz, radius + PROFILE_INFO[RING_PROFILE].right + 6, y, radius + PROFILE_INFO[RING_PROFILE].right, Math.max(edgeRise(RING_PROFILE, true), edgeRise(RING_PROFILE, false)));
  for (const s of ringSegs) { const sq = net.quad(s); clearAndConform(j, world, sq, RING_PROFILE, () => y, arcTable(sq, 32)); }
  // the entries settle on top of the disc
  for (const s of approaches) {
    if (!net.segs.alive[s]) continue;
    const sq = net.quad(s);
    const t = arcTable(sq, 32);
    const ya = net.nodes.cols.y[net.segs.cols.a[s]], yb = net.nodes.cols.y[net.segs.cols.b[s]];
    const L = t[t.length - 1];
    clearAndConform(j, world, sq, net.segs.cols.profile[s], (d) => ya + (yb - ya) * d / L, t);
  }
}


/** Preview of an existing segment (for demolish/change). */

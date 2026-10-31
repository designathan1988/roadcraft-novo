import { heightAt } from '../../world/heights.ts';
import type { World } from '../../world/world.ts';
import { arcTable, bez, bezD, closestT, intersectQuads, tAtLength, type Quad } from '../geometry.ts';
import { MAX_DEG, MAX_SEG_LEN, type RoadNetwork } from '../network.ts';
import { t as text } from '../../shared/i18n/index.ts';
import { PROFILE_INFO } from '../profiles.ts';
import { buildKindAt, chargeFor, dominantKind, segmentPrice } from '../economy.ts';
import { waterAt } from '../../world/ground.ts';
import { segHeightAt } from './snap.ts';
import type { Anchor } from './snap.ts';
import { heightProfile, profileY } from './grade.ts';
import type { Fixed } from './grade.ts';
import type { SegId } from '../../core/ids.ts';

export interface RoadPlan {
  ok: boolean;
  reason: string;
  quad: Quad;
  /** Heights along the road, for the preview. */
  profile: { at: Float64Array; y: Float64Array };
  len: number;
  /** At-grade junctions: [t on the new road, existing segment, t on the existing one]. */
  junctions: Array<[number, SegId, number]>;
}

const MIN_LEN = 8;

/** Plans without changing anything (preview and validation). */
export function planRoad(world: World, start: Anchor, control: { x: number; z: number } | null, end: Anchor, profile: number, offset: number): RoadPlan {
  const net = world.roads;
  const q: Quad = {
    x0: start.x, z0: start.z, x1: end.x, z1: end.z,
    cx: control ? control.x : (start.x + end.x) / 2, cz: control ? control.z : (start.z + end.z) / 2,
  };
  const table = arcTable(q, 64);
  const len = table[table.length - 1];
  const info = PROFILE_INFO[profile];
  const maxGrade = info.speed >= 80 ? 0.05 : 0.08;
  const fixed: Fixed[] = [];
  const nc = net.nodes.cols;
  if (start.node >= 0) fixed.push({ at: 0, y: nc.y[start.node] });
  else if (start.seg >= 0) fixed.push({ at: 0, y: segHeightAt(net, start.seg, start.t) });
  if (end.node >= 0) fixed.push({ at: len, y: nc.y[end.node] });
  else if (end.seg >= 0) fixed.push({ at: len, y: segHeightAt(net, end.seg, end.t) });
  let pr = heightProfile(world.heights, q, table, offset, maxGrade, fixed, 6, world.water);

  const fail = (reason: string): RoadPlan => ({ ok: false, reason, quad: q, profile: pr, len, junctions: [] });
  if (len < MIN_LEN) return fail(text('refuse.road.tooShort'));
  if (start.node >= 0 && start.node === end.node) return fail(text('refuse.road.selfLoop'));

  // junctions with the roads crossed
  const junctions: Array<[number, SegId, number]> = [];
  const minX = Math.min(q.x0, q.cx, q.x1), maxX = Math.max(q.x0, q.cx, q.x1);
  const minZ = Math.min(q.z0, q.cz, q.z1), maxZ = Math.max(q.z0, q.cz, q.z1);
  const skip = new Set<SegId>();
  for (const a of [start, end]) {
    if (a.node >= 0) for (const s of net.segsOf(a.node)) skip.add(s);
    if (a.seg >= 0) skip.add(a.seg);
  }
  const eq: Quad = { x0: 0, z0: 0, cx: 0, cz: 0, x1: 0, z1: 0 };
  const d1 = new Float64Array(2), d2 = new Float64Array(2);
  let bad = '';
  net.forSegsNear(minX, minZ, maxX, maxZ, (s) => {
    if (skip.has(s) || bad) return;
    net.quad(s, eq);
    for (const [tn, to] of intersectQuads(q, eq)) {
      const yNew = profileY(pr, arcAtT(table, tn));
      const yOld = segHeightAt(net, s, to);
      if (Math.abs(yNew - yOld) < 4.5) {
        // junction angle
        bezD(q, tn, d1); bezD(eq, to, d2);
        const cos = Math.abs(d1[0] * d2[0] + d1[1] * d2[1]) / (Math.hypot(d1[0], d1[1]) * Math.hypot(d2[0], d2[1]) || 1);
        if (cos > 0.94) { bad = text('refuse.road.sharpAngle'); return; }
        junctions.push([tn, s, to]);
      }
    }
  });
  if (bad) return fail(bad);
  junctions.sort((a, b) => a[0] - b[0]);
  // the same point found on two segments (passes through an existing node): keep only one
  for (let i = junctions.length - 1; i > 0; i--) {
    if ((junctions[i][0] - junctions[i - 1][0]) * len < 3) junctions.splice(i, 1);
  }
  // a junction right at an end of the new road becomes that end
  while (junctions.length && junctions[0][0] * len < 3) junctions.shift();
  while (junctions.length && (1 - junctions[junctions.length - 1][0]) * len < 3) junctions.pop();
  // junctions pin the height and go into the profile
  if (junctions.length) {
    for (const [tn, s, to] of junctions) fixed.push({ at: arcAtT(table, tn), y: segHeightAt(net, s, to) });
    pr = heightProfile(world.heights, q, table, offset, maxGrade, fixed, 6, world.water);
  }
  if (overlapsRoad(net, q, table, profile, pr)) return { ...fail(text('road.reason.overlap')), junctions };
  // no node may end up with more roads than it holds: an end on a node takes one more, a junction on a node two more
  const extra = new Map<number, number>();
  const more = (n: number, k: number) => extra.set(n, (extra.get(n) ?? 0) + k);
  if (start.node >= 0) more(start.node, 1);
  if (end.node >= 0) more(end.node, 1);
  for (const [, s, to] of junctions) {
    const sl = net.segs.cols.len[s];
    if (to * sl < 6) more(net.segs.cols.a[s], 2); else if ((1 - to) * sl < 6) more(net.segs.cols.b[s], 2);
  }
  for (const [n, k] of extra) if (nc.deg[n] + k > MAX_DEG) return { ...fail(text('road.reason.fullNode', { max: MAX_DEG })), junctions };
  // fixed points too close together
  const ats = [0, ...junctions.map((j) => arcAtT(table, j[0])), len];
  for (let i = 1; i < ats.length; i++) if (ats[i] - ats[i - 1] < 6) return { ...fail(text('refuse.road.junctionsClose')), junctions };
  // is the grade possible?
  for (let i = 1; i < pr.at.length; i++) {
    if (Math.abs(pr.y[i] - pr.y[i - 1]) / (pr.at[i] - pr.at[i - 1]) > maxGrade * 1.9) return { ...fail(text('refuse.road.steep')), junctions };
  }
  return { ok: true, reason: '', quad: q, profile: pr, len, junctions };
}

/**
 * The new road would run over another one: along it (nearly parallel, at the same level) closer than three quarters
 * of their half widths added, for 8 m or more away from its ends. A second road between the same two nodes is one.
 */
function overlapsRoad(net: RoadNetwork, q: Quad, table: Float64Array, profile: number, pr: { at: Float64Array; y: Float64Array }): boolean {
  const len = table[table.length - 1], half = PROFILE_INFO[profile].right;
  const cands: SegId[] = [];
  net.forSegsNear(Math.min(q.x0, q.cx, q.x1) - half - 30, Math.min(q.z0, q.cz, q.z1) - half - 30, Math.max(q.x0, q.cx, q.x1) + half + 30, Math.max(q.z0, q.cz, q.z1) + half + 30, (s) => cands.push(s));
  if (!cands.length) return false;
  const p = new Float64Array(2), d = new Float64Array(2), e = new Float64Array(2), oq: Quad = { x0: 0, z0: 0, cx: 0, cz: 0, x1: 0, z1: 0 };
  const gap = half + 10;
  let run = 0;
  for (let s = gap; s <= len - gap; s += 4) {
    const t = tAtLength(table, s);
    bez(q, t, p); bezD(q, t, d);
    const dl = Math.hypot(d[0], d[1]) || 1;
    let over = false;
    for (const o of cands) {
      net.quad(o, oq);
      const [to, dist] = closestT(oq, p[0], p[1]);
      if (dist >= (half + PROFILE_INFO[net.segs.cols.profile[o]].right) * 0.75) continue;
      bezD(oq, to, e);
      if (Math.abs(d[0] * e[0] + d[1] * e[1]) / (dl * (Math.hypot(e[0], e[1]) || 1)) < 0.9) continue;
      if (Math.abs(profileY(pr, s) - segHeightAt(net, o, to)) >= 4.5) continue;
      over = true; break;
    }
    run = over ? run + 4 : 0;
    if (run >= 8) return true;
  }
  return false;
}

/**
 * What building the plan will cost, for the preview: the road cut where buildRoad cuts it (at the junctions, then in
 * halves while longer than MAX_SEG_LEN or bending away from the straight line between its ends), each piece priced by how it is built over the ground and water (five samples, as the
 * journal does). The roads it splits keep their value.
 */
export function planPrice(world: World, plan: RoadPlan, profile: number): number {
  if (!plan.ok) return 0;
  const q = plan.quad, table = arcTable(q, 64), len = table[table.length - 1];
  const stops = [0, ...plan.junctions.map((j) => arcAtT(table, j[0])), len];
  const p = new Float64Array(2);
  let total = 0;
  const piece = (s0: number, s1: number, depth: number) => {
    const y0 = profileY(plan.profile, s0), y1 = profileY(plan.profile, s1), L = s1 - s0;
    let worst = 0;
    for (let f = 0.125; f < 1; f += 0.125) worst = Math.max(worst, Math.abs(profileY(plan.profile, s0 + L * f) - (y0 + (y1 - y0) * f)));
    if ((L > MAX_SEG_LEN || (worst > 0.4 && L > 30)) && depth < 8) { const m = (s0 + s1) / 2; piece(s0, m, depth + 1); piece(m, s1, depth + 1); return; }
    const kinds: number[] = [];
    for (const f of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const s = s0 + (s1 - s0) * f;
      bez(q, tAtLength(table, s), p);
      kinds.push(buildKindAt(y0 + (y1 - y0) * f, heightAt(world.heights, p[0], p[1]), waterAt(world.water, p[0], p[1])));
    }
    total += segmentPrice(profile, s1 - s0, dominantKind(kinds));
  };
  for (let i = 1; i < stops.length; i++) piece(stops[i - 1], stops[i], 0);
  return chargeFor(total);
}

export function arcAtT(table: Float64Array, t: number): number {
  const n = table.length - 1;
  const f = t * n, i = Math.min(n - 1, Math.floor(f));
  return table[i] + (table[i + 1] - table[i]) * (f - i);
}


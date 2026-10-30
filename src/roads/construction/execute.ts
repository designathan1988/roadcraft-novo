import { HEIGHT_MAP_RES, SEA_LEVEL, TERRAIN_MAX_Y, TERRAIN_MIN_Y } from '../../config.ts';
import { heightAt, heightIndex, sampleCoord, worldOfSample } from '../../world/heights.ts';
import type { World } from '../../world/world.ts';
import { arcTable, bez, closestT, splitQuad, subQuad, tAtLength, type Quad } from '../geometry.ts';
import { MAX_SEG_LEN, type RoadNetwork } from '../network.ts';
import { SegFlag } from '../flags.ts';
import { PROFILE_INFO } from '../profiles.ts';
import { BESIDE_DROP, FOOTWAY_RISE, UNDER_DROP, edgeRise } from '../kerb.ts';
import { BULB_R, BULB_WALK, bulbAt } from '../junction.ts';
import { ROAD_TUNING, TUNNEL } from '../tuning.ts';
import { ARCHES, archFor, eraAt } from '../../world/arch.ts';
import { waterAt } from '../../world/ground.ts';
import { Item, isBarrier, isSidewalkFurniture } from '../../world/items.ts';
import { RoadGround, stripOfRoad } from '../ground.ts';
import { RoadJournal } from './journal.ts';
import { segHeightAt, snap } from './snap.ts';
import type { Anchor } from './snap.ts';
import { arcAtT } from './plan.ts';
import type { RoadPlan } from './plan.ts';
import { profileY } from './grade.ts';
import type { NodeId, SegId } from '../../core/ids.ts';

// ------------------------------------------------------------ execution

/** Splits a segment at t, returning the new node. */
export function splitSeg(j: RoadJournal, net: RoadNetwork, s: SegId, t: number, y: number | null): NodeId {
  const q = net.quad(s);
  const rec = net.segRec(s);
  const [a, b] = splitQuad(q, t);
  const yy = y ?? segHeightAt(net, s, t);
  j.removeSeg(s);
  const n = j.addNode(a.x1, a.z1, yy);
  const pa = j.addSeg({ a: rec.a, b: n, cx: a.cx, cz: a.cz, profile: rec.profile, flags: rec.flags, zl: rec.zl, zr: rec.zr });
  const pb = j.addSeg({ a: n, b: rec.b, cx: b.cx, cz: b.cz, profile: rec.profile, flags: rec.flags, zl: rec.zl, zr: rec.zr });
  j.inherit(s, [pa, pb]);
  return n;
}

/**
 * Segment s still runs through (x, z) as it did when the point was taken: a split frees its id and one of the pieces
 * may take it, and the old `t` would cut the piece in the wrong place.
 */
function stillThere(net: RoadNetwork, s: SegId, x: number, z: number): boolean {
  if (!net.segs.alive[s]) return false;
  const sc = net.segs.cols, nc = net.nodes.cols;
  const [, d] = closestT(net.quad(s), x, z);
  return d < 0.5 && Math.hypot(nc.x[sc.a[s]] - x, nc.z[sc.a[s]] - z) > 0.5 && Math.hypot(nc.x[sc.b[s]] - x, nc.z[sc.b[s]] - z) > 0.5;
}

/** Resolves an anchor to a node (splitting the segment if needed). */
function anchorNode(j: RoadJournal, net: RoadNetwork, a: Anchor, y: number): NodeId {
  if (a.node >= 0 && net.nodes.alive[a.node]) return a.node;
  if (a.seg >= 0 && stillThere(net, a.seg, a.x, a.z)) return splitSeg(j, net, a.seg, closestT(net.quad(a.seg), a.x, a.z)[0], null);
  // the segment may have been split by the other end (and its id taken by a piece): search again
  const again = snap(net, a.x, a.z, 3);
  if (again.node >= 0) return again.node;
  if (again.seg >= 0) return splitSeg(j, net, again.seg, again.t, null);
  return j.addNode(a.x, a.z, y);
}

/** Builds a planned road. If anything throws half way, the whole build goes back before the error goes on. */
export function buildRoad(world: World, plan: RoadPlan, start: Anchor, end: Anchor, profile: number, flags = 0, label = 'construir via'): RoadJournal {
  const j = new RoadJournal(world, label);
  j.guard(() => buildLive(j, world, plan, start, end, profile, flags));
  return j;
}

function buildLive(j: RoadJournal, world: World, plan: RoadPlan, start: Anchor, end: Anchor, profile: number, flags: number): void {
  const net = world.roads;
  const q = plan.quad;
  const table = arcTable(q, 64);
  const pr = plan.profile;

  // stops along the road: ends, junctions and length splits
  const stops: Array<{ t: number; node: NodeId }> = [];
  stops.push({ t: 0, node: anchorNode(j, net, start, pr.y[0]) });
  for (const [tn, s, to] of plan.junctions) {
    // the crossed segment may already have been split by another junction: find the right piece
    const p = new Float64Array(2); bez(q, tn, p);
    let seg = s, tt = to;
    if (stillThere(net, seg, p[0], p[1])) tt = closestT(net.quad(seg), p[0], p[1])[0];
    else {
      const near = net.nearestSeg(p[0], p[1], 3);
      if (!near) continue;
      seg = near[0]; tt = near[1];
    }
    const sl = net.segs.cols.len[seg];
    let node: NodeId;
    if (tt * sl < 6) node = net.segs.cols.a[seg];
    else if ((1 - tt) * sl < 6) node = net.segs.cols.b[seg];
    else node = splitSeg(j, net, seg, tt, null);
    stops.push({ t: tn, node });
  }
  stops.push({ t: 1, node: anchorNode(j, net, end, pr.y[pr.y.length - 1]) });

  const nc = net.nodes.cols;
  // final heights per segment (linear between nodes): the terrain is settled to them
  const knotS: number[] = [], knotY: number[] = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    const a = stops[i], b = stops[i + 1];
    if (a.node === b.node) continue;
    const sa = arcAtT(table, a.t), sb = arcAtT(table, b.t);
    const ya = nc.y[a.node], yb = nc.y[b.node];
    // adaptive split: pieces where the straight line between nodes strays from the profile become two
    const cuts: number[] = [sa, sb];
    const cutY = new Map<number, number>([[sa, ya], [sb, yb]]);
    const yAtCut = (x: number) => cutY.get(x) ?? profileY(pr, x);
    const refine = (s0: number, s1: number, depth: number) => {
      const len = s1 - s0;
      let worst = 0;
      const y0 = yAtCut(s0), y1 = yAtCut(s1);
      for (let f = 0.125; f < 1; f += 0.125) worst = Math.max(worst, Math.abs(profileY(pr, s0 + len * f) - (y0 + (y1 - y0) * f)));
      if ((len > MAX_SEG_LEN || (worst > 0.4 && len > 30)) && depth < 8) {
        const m = (s0 + s1) / 2;
        cuts.push(m);
        refine(s0, m, depth + 1);
        refine(m, s1, depth + 1);
      }
    };
    refine(sa, sb, 0);
    cuts.sort((x, y) => x - y);
    const pieces = cuts.length - 1;
    const yOf = (k: number, _n: number) => yAtCut(cuts[k]);
    let prev = a.node;
    for (let k = 1; k <= pieces; k++) {
      const s1 = cuts[k];
      const t0 = tAtLength(table, cuts[k - 1]), t1 = tAtLength(table, s1);
      const sub = subQuad(q, t0, t1);
      const next = k === pieces ? b.node : j.addNode(sub.x1, sub.z1, yOf(k, pieces));
      // the curve joins the actual nodes (which may have slipped a few centimeters)
      const cx = sub.cx + ((nc.x[prev] - sub.x0) + (nc.x[next] - sub.x1)) / 2;
      const cz = sub.cz + ((nc.z[prev] - sub.z0) + (nc.z[next] - sub.z1)) / 2;
      j.addSeg({ a: prev, b: next, cx, cz, profile, flags });
      knotS.push(cuts[k - 1]); knotY.push(nc.y[prev]);
      prev = next;
    }
    knotS.push(sb); knotY.push(nc.y[b.node]);
  }
  const yLinear = (s: number): number => {
    if (knotS.length === 0) return profileY(pr, s);
    if (s <= knotS[0]) return knotY[0];
    for (let i = 1; i < knotS.length; i++) {
      if (s <= knotS[i]) {
        const f = (s - knotS[i - 1]) / Math.max(1e-6, knotS[i] - knotS[i - 1]);
        return knotY[i - 1] + (knotY[i] - knotY[i - 1]) * f;
      }
    }
    return knotY[knotY.length - 1];
  };
  clearAndConform(j, world, q, profile, yLinear, table, (flags & SegFlag.Wall) !== 0);
  // dead ends with a turning bulb: the terrain settles under the circle
  for (const n of [stops[0].node, stops[stops.length - 1].node]) if (bulbAt(net, n)) conformDisc(j, world, nc.x[n], nc.z[n], BULB_R + BULB_WALK + 6, nc.y[n], BULB_R + BULB_WALK, FOOTWAY_RISE);
}


/**
 * Removes buildings in the way and settles the terrain under the road where it is
 * close to the ground (not under bridges nor over tunnels).
 */
export function clearAndConform(j: RoadJournal, world: World, q: Quad, profile: number, yAt: (s: number) => number, table: Float64Array, wallCut = false): void {
  const len = table[table.length - 1];
  const half = PROFILE_INFO[profile].right;
  const blend = 7;
  const reach = half + blend;
  // centerline points every 2 m
  const n = Math.max(2, Math.ceil(len / 2) + 1);
  const px = new Float64Array(n), pz = new Float64Array(n), py = new Float64Array(n);
  const p = new Float64Array(2);
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const s = len * i / (n - 1);
    bez(q, tAtLength(table, s), p);
    px[i] = p[0]; pz[i] = p[1]; py[i] = yAt(s);
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]);
  }
  const nearest = (x: number, z: number): [number, number] => {
    let bd = Infinity, bi = 0;
    for (let i = 0; i < n; i++) { const d = (px[i] - x) ** 2 + (pz[i] - z) ** 2; if (d < bd) { bd = d; bi = i; } }
    return [Math.sqrt(bd), bi];
  };

  // buildings in the way
  const col = world.buildings.cols;
  const doomed: number[] = [];
  world.buildingIndex.query(minX - reach - 40, minZ - reach - 40, maxX + reach + 40, maxZ + reach + 40, (id) => {
    const r = Math.hypot(col.w[id], col.d[id]) / 2;
    const [d] = nearest(col.x[id], col.z[id]);
    if (d >= half + r) return;
    // the road's footprint (centreline points widened by its half width) over any part of the lot's rectangle
    const c = Math.cos(col.rot[id]), s = Math.sin(col.rot[id]), hw = col.w[id] / 2 + half - 0.3, hd = col.d[id] / 2 + half - 0.3;
    let i = -1;
    for (let k = 0; k < n && i < 0; k++) {
      const dx = px[k] - col.x[id], dz = pz[k] - col.z[id];
      if (Math.abs(dx * c - dz * s) < hw && Math.abs(dx * s + dz * c) < hd) i = k;
    }
    if (i < 0) return;
    // a deck that passes over the roof, or a tunnel deep under the lot, leaves the building standing
    const g = heightAt(world.heights, col.x[id], col.z[id]);
    if (py[i] - DECK_DEPTH > g + buildingTop(col, id)) return;
    if (py[i] < g - TUNNEL.portalDepth) return;
    doomed.push(id);
  });
  for (const id of doomed) j.removeBuilding(id);

  // what stands on its ground: everything within the construction limits is cleared (Ohio DOT Item 201, Toronto TS
  // 2.00: the trees within the clearing limits are removed); the footway keeps its street furniture (the owner,
  // 2026-10-30), a carriageway keeps nothing; over a tunnel everything stays
  const items = world.items, ic = items.t.cols, cleared: number[] = [];
  items.index.query(minX - half, minZ - half, maxX + half, maxZ + half, (id) => {
    const type = ic.type[id], keepOnFoot = isSidewalkFurniture(type);
    // a run (fence, wall, hedge, rail) by its metres; a power line by its two poles; anything else by its point (an
    // object's x1/z1 are its heading and height, not a place)
    const run = isBarrier(type);
    const x0 = ic.x0[id], z0 = ic.z0[id], x1 = run ? ic.x1[id] : x0, z1 = run ? ic.z1[id] : z0;
    const len = type === Item.PoleLine ? 0 : Math.hypot(x1 - x0, z1 - z0);
    const steps = Math.ceil(len), ends = type === Item.PoleLine ? 2 : 1;
    for (let e = 0; e < ends; e++) for (let k = 0; k <= steps; k++) {
      const f = steps ? k / steps : e, x = x0 + (x1 - x0) * f, z = z0 + (z1 - z0) * f;
      const strip = stripOfRoad(q, profile, x, z);
      if (strip === RoadGround.None || (strip === RoadGround.Footway && keepOnFoot)) continue;
      const [, i] = nearest(x, z);
      if (py[i] < heightAt(world.heights, x, z) - TUNNEL.portalDepth) continue;
      cleared.push(id);
      return;
    }
  });
  for (const id of cleared) j.removeItem(id);

  // terrain
  const h = world.heights;
  const gx0 = Math.max(0, Math.floor(sampleCoord(minX - reach))), gx1 = Math.min(HEIGHT_MAP_RES - 1, Math.ceil(sampleCoord(maxX + reach)));
  const gz0 = Math.max(0, Math.floor(sampleCoord(minZ - reach))), gz1 = Math.min(HEIGHT_MAP_RES - 1, Math.ceil(sampleCoord(maxZ + reach)));
  const idx: number[] = [], before: number[] = [], after: number[] = [];
  for (let gz = gz0; gz <= gz1; gz++) {
    const z = worldOfSample(gz);
    for (let gx = gx0; gx <= gx1; gx++) {
      const x = worldOfSample(gx);
      const [d, i] = nearest(x, z);
      if (d >= reach) continue;
      // beyond the ends do not touch: the neighbouring roads rule there
      if (i === 0 && (x - px[0]) * (px[1] - px[0]) + (z - pz[0]) * (pz[1] - pz[0]) < 0) continue;
      if (i === n - 1 && (x - px[n - 1]) * (px[n - 2] - px[n - 1]) + (z - pz[n - 1]) * (pz[n - 2] - pz[n - 1]) < 0) continue;
      const k = heightIndex(gx, gz);
      const old = h[k];
      const under = py[i] - UNDER_DROP;
      const gap = under - old; // + fill, - cut
      if (gap > 4.5 || gap < -TUNNEL.portalDepth) continue; // bridge or tunnel: the terrain stays
      if (old < SEA_LEVEL + 0.3 || waterAt(world.water, x, z) > old) continue; // never fills water: it becomes a bridge
      // cut with a retaining wall: the ground rises right at the edge (the wall covers it); embankment: 7 m slope
      const bl = wallCut && gap < 0 ? 1.2 : blend;
      if (d >= half + bl) continue;
      // under the road below its surface; beside it level with its outer strip's top on that side (roads/kerb.ts),
      // unless the point is under another road (a junction's other arm, a road beside): under wins, never raised there
      let target = under;
      if (d >= half && !underARoad(world, x, z)) {
        const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
        const left = (x - px[i]) * (pz[b] - pz[a]) - (z - pz[i]) * (px[b] - px[a]) > 0;
        target = py[i] + edgeRise(profile, left) - BESIDE_DROP;
      }
      const w = d <= half + 0.5 ? 1 : 1 - smooth((d - half - 0.5) / (bl - 0.5));
      const v = Math.max(TERRAIN_MIN_Y, Math.min(TERRAIN_MAX_Y, old + (target - old) * w));
      if (Math.abs(v - old) < 0.005) continue;
      idx.push(k); before.push(old); after.push(v);
    }
  }
  if (idx.length) j.terrain(new Int32Array(idx), new Float32Array(before), new Float32Array(after), [minX - reach, minZ - reach, maxX + reach, maxZ + reach]);
}

/**
 * Is (x, z) under a road of the network (within its half width)? Asked only for a point beside the road being settled,
 * so that road itself never counts; its continuation or a crossing road does.
 */
export function underARoad(world: World, x: number, z: number): boolean {
  const net = world.roads, sc = net.segs.cols;
  const r = MAX_SEG_LEN / 2 + 20;
  let hit = false;
  net.segIndex.query(x - r, z - r, x + r, z + r, (s) => {
    if (hit || !net.segs.alive[s]) return;
    const [, d] = closestT(net.quad(s), x, z);
    if (d < PROFILE_INFO[sc.profile[s]].right) hit = true;
  });
  return hit;
}


/** Deck and girders under a road surface on a bridge (m): a roof must stay below this much under the road. */
const DECK_DEPTH = 2;
/** Highest a building may reach over its ground (m): its storeys at the height of its architecture, plus roof and crown. */
function buildingTop(col: World['buildings']['cols'], id: number): number {
  const arch = ARCHES[archFor(col.zone[id], col.floors[id], eraAt(col.x[id], col.z[id]), col.style[id])];
  return col.floors[id] * (arch?.floorH ?? 5.6) + 4;
}

export function smooth(t: number): number { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); }

/**
 * The ground under a disc of road (a turning bulb, a roundabout) whose paved edge is `edge` m from (cx, cz): below its
 * surface under it, level with its outer strip's top (`rise` over the surface) beside it unless under another road,
 * blending back to the ground by `r`.
 */
export function conformDisc(j: RoadJournal, world: World, cx: number, cz: number, r: number, y: number, edge = r - 6, rise = 0): void {
  const h = world.heights;
  const gx0 = Math.max(0, Math.floor(sampleCoord(cx - r))), gx1 = Math.min(HEIGHT_MAP_RES - 1, Math.ceil(sampleCoord(cx + r)));
  const gz0 = Math.max(0, Math.floor(sampleCoord(cz - r))), gz1 = Math.min(HEIGHT_MAP_RES - 1, Math.ceil(sampleCoord(cz + r)));
  const idx: number[] = [], before: number[] = [], after: number[] = [];
  for (let gz = gz0; gz <= gz1; gz++) for (let gx = gx0; gx <= gx1; gx++) {
    const d = Math.hypot(worldOfSample(gx) - cx, worldOfSample(gz) - cz);
    if (d > r) continue;
    const k = heightIndex(gx, gz);
    // as under a road: water is never filled, and a disc high above or deep below the ground leaves it alone
    const gap = y - UNDER_DROP - h[k];
    if (h[k] < SEA_LEVEL + 0.3 || gap > ROAD_TUNING.economy.bridgeFrom || gap < -ROAD_TUNING.economy.tunnelFrom) continue;
    const target = d < edge || underARoad(world, worldOfSample(gx), worldOfSample(gz)) ? y - UNDER_DROP : y + rise - BESIDE_DROP;
    const w = d < edge + 0.5 ? 1 : 1 - smooth((d - edge - 0.5) / Math.max(0.5, r - edge - 0.5));
    const v = h[k] + (target - h[k]) * w;
    idx.push(k); before.push(h[k]); after.push(v);
  }
  if (idx.length) j.terrain(new Int32Array(idx), new Float32Array(before), new Float32Array(after), [cx - r, cz - r, cx + r, cz + r]);
}

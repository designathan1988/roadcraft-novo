// Generator of the whole city from the seed (worker). Centres on flat ground
// near the river; radial avenues and a ring round the main centre; an
// expressway across the map; local streets in a grid per district (each centre's
// orientation), cut by water and steep slopes. Everything becomes a planar graph:
// crossings found through a grid of buckets, nearby nodes merged. Zones by the
// distance to the centres and avenues. The page only inserts the result.

import { MAP_HALF, SEA_LEVEL } from '../config.ts';
import { Rng, fbm } from '../core/rng.ts';
import { baseHeight, waterLevelAt } from './terrainGen.ts';
import { Zone } from '../roads/zones.ts';
import { PROFILES, PROFILE_INFO } from '../roads/profiles.ts';
import { MIN_LEG_ANGLE } from '../roads/impossible.ts';
import { blockLines, districtField, districtLevels, simplifyLine, traceStreets, type CityStyle, type P2 } from './cityField.ts';

export const GEN = { Local: 1, Avenue: 3, AvenueBike: 4, Expressway: 5, Collector: 7 } as const;

export interface CityRoads {
  /** x, z, y per node. */
  nodes: Float32Array;
  /** a, b, profile, left zone, right zone per segment. */
  segs: Int32Array;
  /** Centres (x, z, radius). */
  centers: Float32Array;
}

interface Poly { pts: number[]; profile: number; bridge: boolean }
interface Center { x: number; z: number; r: number; angle: number; bx: number; bz: number }

const MERGE = 7;
/** Longest generated segment (m): under MAX_SEG_LEN (roads/network.ts), the spatial index's limit. */
const GEN_SEG_LEN = 100;
const MAX_LOCAL_GRADE = 0.11;
const MAX_ART_GRADE = 0.08;

/**
 * The city from the seed. `style` lays the local streets of each district: 'classic' a rotated grid (this engine's
 * first generator), or one of Roadcraft 4.0's (grid, organic, radial, mixed: streets along a tensor field; blocks:
 * a straight grid of 120 × 72 m blocks). The arterials, the water and slope rules and the zones are the same for all.
 */
/** `medium`: one town round the map's middle (Roadcraft 2.0 and 4.0's medium city, about 4 km across), not the whole map. */
export function generateCity(seed: number, style: CityStyle = 'blocks', medium = false): CityRoads {
  const rng = new Rng(seed * 7919 + 13);
  const H = (x: number, z: number) => baseHeight(x, z, seed);
  const land = (x: number, z: number) => { const h = H(x, z); return h > SEA_LEVEL + 1.2 && waterLevelAt(x, z, seed) < h - 1.2; };
  const slope = (x: number, z: number) => {
    const d = 12;
    return Math.hypot(H(x + d, z) - H(x - d, z), H(x, z + d) - H(x, z - d)) / (2 * d);
  };
  let town: [number, number] | null = null;
  const inside = (x: number, z: number, m = 380) => Math.max(Math.abs(x), Math.abs(z)) < MAP_HALF - m && (!town || Math.hypot(x - town[0], z - town[1]) < 2100);

  // ---------------------------------------------------------------- centres
  const pick = (cx: number, cz: number, rad: number, avoid: Center[], minD: number): [number, number] | null => {
    let best: [number, number] | null = null, bs = Infinity;
    for (let k = 0; k < 400; k++) {
      const x = cx + rng.range(-rad, rad), z = cz + rng.range(-rad, rad);
      if (!inside(x, z, 1500) || !land(x, z)) continue;
      if (avoid.some((c) => Math.hypot(c.x - x, c.z - z) < minD)) continue;
      // flat and near (but not in) the river
      let s = 0;
      for (const [dx, dz] of [[0, 0], [200, 0], [-200, 0], [0, 200], [0, -200]]) s += slope(x + dx, z + dz);
      let water = 1e9;
      for (let a = 0; a < 8; a++) for (const r of [250, 500, 800]) {
        if (!land(x + Math.cos(a * 0.785) * r, z + Math.sin(a * 0.785) * r)) water = Math.min(water, r);
      }
      const score = s * 40 + (water < 1e9 ? Math.abs(water - 600) / 400 : 2) + Math.hypot(x - cx, z - cz) / rad;
      if (score < bs) { bs = score; best = [x, z]; }
    }
    return best;
  };
  const centers: Center[] = [];
  const c0 = pick(0, 0, 2200, [], 0) ?? [0, 1500];
  centers.push({ x: c0[0], z: c0[1], r: medium ? 800 : 3600, angle: rng.range(-0.4, 0.4), bx: 104, bz: 92 });
  if (medium) town = c0;
  for (let i = 0; i < (medium ? 0 : 2); i++) {
    const a = rng.range(0, Math.PI * 2);
    const p = pick(c0[0] + Math.cos(a) * 3800, c0[1] + Math.sin(a) * 3800, 1600, centers, 3000);
    if (p) centers.push({ x: p[0], z: p[1], r: 2200, angle: rng.range(-0.8, 0.8), bx: 118, bz: 100 });
  }
  // bigger maps: more satellite districts around, in proportion to the extra area
  const extra = medium ? 0 : Math.round(2 * ((MAP_HALF * MAP_HALF) / (5120 * 5120) - 1));
  for (let i = 0, tries = 0; i < extra && tries < extra * 4; tries++) {
    const a = rng.range(0, Math.PI * 2), d = rng.range(5500, MAP_HALF - 1800);
    const p = pick(c0[0] + Math.cos(a) * d, c0[1] + Math.sin(a) * d, 1800, centers, 4200);
    if (!p) continue;
    centers.push({ x: p[0], z: p[1], r: rng.range(1700, 2600), angle: rng.range(-0.8, 0.8), bx: 112 + rng.range(0, 14), bz: 96 + rng.range(0, 10) });
    i++;
  }

  // ---------------------------------------------------------------- lines
  const polys: Poly[] = [];
  /** Marches a line through points; water becomes a (short) bridge or a cut; a steep slope cuts. */
  const march = (pts: Array<[number, number]>, profile: number, allowBridge: boolean, maxGrade: number) => {
    let cur: number[] = [];
    let lastLand: [number, number] | null = null;
    let wet = 0;
    const flush = () => { if (cur.length >= 4) polys.push({ pts: cur, profile, bridge: allowBridge }); cur = []; };
    for (let i = 0; i < pts.length; i++) {
      const [x, z] = pts[i];
      if (!inside(x, z)) { flush(); lastLand = null; continue; }
      if (!land(x, z)) {
        if (!allowBridge || !lastLand) { flush(); lastLand = null; continue; }
        wet += Math.hypot(x - (pts[i - 1]?.[0] ?? x), z - (pts[i - 1]?.[1] ?? z));
        if (wet > 320) { flush(); lastLand = null; wet = 0; }
        continue; // bridge: the next point on land links straight to it
      }
      if (lastLand && wet === 0) {
        const g = Math.abs(H(x, z) - H(lastLand[0], lastLand[1])) / Math.max(1, Math.hypot(x - lastLand[0], z - lastLand[1]));
        if (g > maxGrade) { flush(); }
      }
      wet = 0;
      cur.push(x, z);
      lastLand = [x, z];
    }
    flush();
  };

  // Roadcraft 4.0's city (largeCity.ts: "the same 'blocks' style, the same straight grid ... Every block is built"):
  // ONE straight grid of 120 x 72 m blocks over the whole city, avenues every 4 blocks, collectors between, local
  // streets the rest; no expressway, radials or rings. Its span is 1.7 radii (4.0: ~8.85 km at radius 5,200 m on
  // the 10 km map); water is bridged by the avenues and collectors, the local streets stop at it.
  if (style === 'blocks' && !medium) {
    const R = Math.min(5200, ((MAP_HALF - 420) * 2) / 1.7);
    // centred on the map's middle, as 4.0 lays its city round the origin
    const at: [number, number] = [0, 0];
    for (const l of blockLines(at[0], at[1], R)) {
      const profile = l.level === 0 ? GEN.Avenue : l.level === 1 ? GEN.Collector : GEN.Local;
      const first = polys.length;
      march(l.points.map((p) => [p.x, p.z] as [number, number]), profile, l.level < 2, l.level < 2 ? MAX_ART_GRADE : MAX_LOCAL_GRADE);
      // a grid line is straight: march walked its dense points for water and slope, the street keeps only its ends,
      // so its nodes are the crossings (every point would be a node, a block side cut in 30 m pieces)
      for (let k = first; k < polys.length; k++) { const q = polys[k].pts; polys[k].pts = [q[0], q[1], q[q.length - 2], q[q.length - 1]]; }
    }
    return withoutSpurs(buildGraph(polys, [{ ...centers[0], x: at[0], z: at[1], r: R * 0.85 }], H, seed));
  }
  // the medium town (Roadcraft 2.0's): only its straight block grid, no expressway, radials or rings
  if (!medium) {
  // expressway: along the river, moved to one side, from edge to edge
  const side = rng.next() < 0.5 ? 1 : -1;
  const riverZ = (x: number) => {
    // looks for the water nearest the line z = c0.z
    let best = c0[1], bd = Infinity;
    for (let z = -MAP_HALF; z < MAP_HALF; z += 40) if (!land(x, z)) { const d = Math.abs(z - c0[1]); if (d < bd) { bd = d; best = z; } }
    return bd < Infinity ? best : NaN;
  };
  {
    const pts: Array<[number, number]> = [];
    let lastZ = c0[1] + side * 1600;
    for (let x = -MAP_HALF + 400; x <= MAP_HALF - 400; x += 160) {
      const rz = riverZ(x);
      const target = Number.isFinite(rz) ? rz + side * 1700 : lastZ;
      lastZ += Math.max(-60, Math.min(60, target - lastZ)); // soft curve
      pts.push([x, lastZ]);
    }
    march(pts, GEN.Expressway, true, MAX_ART_GRADE);
    // and a north-south one across the river, beside the centre
    const pts2: Array<[number, number]> = [];
    const x0 = c0[0] + rng.range(1100, 1500) * (rng.next() < 0.5 ? 1 : -1);
    for (let z = -MAP_HALF + 400; z <= MAP_HALF - 400; z += 160) pts2.push([x0 + 200 * Math.sin(z / 1700), z]);
    march(pts2, GEN.Expressway, true, MAX_ART_GRADE);
  }

  // radial avenues and the main centre's ring
  centers.forEach((c, ci) => {
    const rays = ci === 0 ? 8 : 5;
    for (let k = 0; k < rays; k++) {
      const a0 = c.angle + (k / rays) * Math.PI * 2 + rng.range(-0.12, 0.12);
      const len = c.r * rng.range(0.85, 1.15);
      const pts: Array<[number, number]> = [];
      let a = a0;
      for (let d = 150; d <= len; d += 100) {
        a += rng.range(-0.04, 0.04);
        pts.push([c.x + Math.cos(a) * d, c.z + Math.sin(a) * d]);
      }
      march(pts, ci === 0 && k % 2 === 0 ? GEN.AvenueBike : GEN.Avenue, ci === 0, MAX_ART_GRADE);
    }
    // a small ring round the central square: the radials start on it (no node with too many arms)
    for (const rr of ci === 0 ? [150, 850, 2100] : [150, 700]) {
      const pts: Array<[number, number]> = [];
      const n = Math.max(12, Math.ceil((Math.PI * 2 * rr) / 110));
      for (let i = 0; i <= n; i++) {
        const t = (i / n) * Math.PI * 2;
        const w = 1 + 0.08 * fbm(Math.cos(t) * 2, Math.sin(t) * 2, seed + ci * 11 + rr, 2);
        pts.push([c.x + Math.cos(t) * rr * w, c.z + Math.sin(t) * rr * w]);
      }
      march(pts, GEN.Avenue, ci === 0, MAX_ART_GRADE);
    }
  });

  // roads between districts: each satellite links to the nearest centre already placed
  for (let i = 1; i < centers.length; i++) {
    const c = centers[i];
    let j = 0, bd = Infinity;
    for (let k = 0; k < i; k++) { const d = Math.hypot(centers[k].x - c.x, centers[k].z - c.z); if (d < bd) { bd = d; j = k; } }
    const o = centers[j];
    const L = Math.hypot(o.x - c.x, o.z - c.z);
    if (L < c.r + o.r * 0.9) continue; // the radials already cross
    const pts: Array<[number, number]> = [];
    const nx = -(o.z - c.z) / L, nz = (o.x - c.x) / L, bow = rng.range(-0.08, 0.08) * L;
    for (let d = 150; d <= L - 150; d += 120) {
      const t = d / L, b = Math.sin(t * Math.PI) * bow;
      pts.push([c.x + (o.x - c.x) * t + nx * b, c.z + (o.z - c.z) * t + nz * b]);
    }
    march(pts, GEN.Avenue, true, MAX_ART_GRADE);
  }

  }

  // local streets: each centre's grid, only in its own area (the "strongest" centre wins)
  const owner = (x: number, z: number): number => {
    if (medium) return 0; // one town, one square grid (Roadcraft 2.0 plan.ts blockGrid)
    let best = -1, bs = Infinity;
    centers.forEach((c, i) => { const s = Math.hypot(x - c.x, z - c.z) / c.r; if (s < bs) { bs = s; best = i; } });
    return bs < 1.12 ? best : -1;
  };
  if (style !== 'classic') {
    centers.forEach((c, ci) => fieldStreets(c, ci));
    return buildGraph(polys, centers, H, seed);
  }
  centers.forEach((c, ci) => {
    const ca = Math.cos(c.angle), sa = Math.sin(c.angle);
    const R = c.r * 1.12;
    const toW = (u: number, v: number): [number, number] => [c.x + u * ca - v * sa, c.z + u * sa + v * ca];
    for (const dirU of [true, false]) {
      const step = dirU ? c.bz : c.bx;
      const along = dirU ? c.bx : c.bz;
      for (let off = -R; off <= R; off += step) {
        // sparser streets far from the centre
        const keepP = 1 - Math.max(0, Math.abs(off) / R - 0.55) * 1.6;
        if (rng.next() > keepP) continue;
        const pts: Array<[number, number]> = [];
        const flushPts = () => { if (pts.length >= 2) march(pts.splice(0), GEN.Local, false, MAX_LOCAL_GRADE); else pts.length = 0; };
        for (let t = -R; t <= R; t += along / 2) {
          const [x, z] = dirU ? toW(t, off) : toW(off, t);
          const d = Math.hypot(x - c.x, z - c.z);
          if (d > R || owner(x, z) !== ci || (d > c.r * 0.7 && fbm(x / 900, z / 900, seed + 51, 2) < -0.25)) { flushPts(); continue; }
          pts.push([x, z]);
        }
        flushPts();
      }
    }
  });

  return buildGraph(polys, centers, H, seed);

  /**
   * Local streets of district `ci` in one of Roadcraft's styles: traced over its own ground (its share of the map,
   * on land, not too steep, with the same countryside gaps as the classic grid), cut by water and slope by `march`.
   */
  function fieldStreets(c: Center, ci: number): void {
    const R = c.r * 1.12;
    const insideP = (p: P2): boolean => {
      const d = medium ? Math.max(Math.abs(p.x - c.x), Math.abs(p.z - c.z)) : Math.hypot(p.x - c.x, p.z - c.z);
      if (d > R || !inside(p.x, p.z) || !land(p.x, p.z) || owner(p.x, p.z) !== ci) return false;
      if (!medium && d > c.r * 0.7 && fbm(p.x / 900, p.z / 900, seed + 51, 2) < -0.25) return false;
      return slope(p.x, p.z) < MAX_LOCAL_GRADE * 1.6;
    };
    const lay = (level: number, points: P2[]) => {
      // split where the line leaves the district's ground; each piece is marched (bridges are not built here)
      // each piece with one point every 20 m or so where it bends (the graph merges anything under 16 m into a node)
      let run: P2[] = [];
      const flushRun = () => {
        if (run.length >= 2) march(simplifyLine(run, 1.2, 20).map((p) => [p.x, p.z] as [number, number]), level === 0 && style === 'blocks' ? GEN.Avenue : GEN.Local, false, MAX_LOCAL_GRADE);
        run = [];
      };
      for (const p of points) { if (insideP(p)) run.push(p); else flushRun(); }
      flushRun();
    };
    if (style === 'blocks') { for (const l of blockLines(c.x, c.z, R)) lay(l.level, l.points); return; }
    const field = districtField(style, c.x, c.z, c.r, rng, seed + ci * 101)!;
    const lines = traceStreets(field, insideP, { x0: c.x - R, z0: c.z - R, x1: c.x + R, z1: c.z + R }, districtLevels(c.r), rng);
    for (const l of lines) lay(l.level, l.points);
  }
}

/**
 * The grid without its spurs: a street cut by water or a steep slope ends at the bank, a dead end the grid never
 * has (4.0's blocks: every street a whole line between crossings). Ends of one arm are taken away until none is
 * left; the nodes left are renumbered.
 */
export function withoutSpurs(r: CityRoads): CityRoads {
  const nn = r.nodes.length / 3, ns = r.segs.length / 5;
  const deg = new Int32Array(nn), gone = new Uint8Array(ns);
  const at: number[][] = Array.from({ length: nn }, () => []);
  for (let s = 0; s < ns; s++) { const a = r.segs[s * 5], b = r.segs[s * 5 + 1]; deg[a]++; deg[b]++; at[a].push(s); at[b].push(s); }
  const ends: number[] = [];
  for (let n = 0; n < nn; n++) if (deg[n] === 1) ends.push(n);
  while (ends.length) {
    const n = ends.pop()!;
    if (deg[n] !== 1) continue;
    const s = at[n].find((k) => !gone[k])!;
    gone[s] = 1;
    const a = r.segs[s * 5], b = r.segs[s * 5 + 1], o = a === n ? b : a;
    deg[n]--; deg[o]--;
    if (deg[o] === 1) ends.push(o);
  }
  const map = new Int32Array(nn).fill(-1), nodes: number[] = [], segs: number[] = [];
  for (let n = 0; n < nn; n++) if (deg[n] > 0) { map[n] = nodes.length / 3; nodes.push(r.nodes[n * 3], r.nodes[n * 3 + 1], r.nodes[n * 3 + 2]); }
  for (let s = 0; s < ns; s++) {
    if (gone[s]) continue;
    segs.push(map[r.segs[s * 5]], map[r.segs[s * 5 + 1]], r.segs[s * 5 + 2], r.segs[s * 5 + 3], r.segs[s * 5 + 4]);
  }
  return { nodes: new Float32Array(nodes), segs: new Int32Array(segs), centers: r.centers };
}

// ---------------------------------------------------------------- planar graph

function buildGraph(polys: Poly[], centers: Center[], H: (x: number, z: number) => number, seed: number): CityRoads {
  // straight pieces
  const sx0: number[] = [], sz0: number[] = [], sx1: number[] = [], sz1: number[] = [], sp: number[] = [];
  for (const p of polys) {
    for (let i = 0; i + 3 < p.pts.length; i += 2) {
      sx0.push(p.pts[i]); sz0.push(p.pts[i + 1]); sx1.push(p.pts[i + 2]); sz1.push(p.pts[i + 3]); sp.push(p.profile);
    }
  }
  const n = sp.length;
  // crossings by 96 m buckets
  const B = 96;
  const buckets = new Map<number, number[]>();
  const key = (i: number, j: number) => (i + 2000) * 4096 + (j + 2000);
  for (let s = 0; s < n; s++) {
    const i0 = Math.floor(Math.min(sx0[s], sx1[s]) / B), i1 = Math.floor(Math.max(sx0[s], sx1[s]) / B);
    const j0 = Math.floor(Math.min(sz0[s], sz1[s]) / B), j1 = Math.floor(Math.max(sz0[s], sz1[s]) / B);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = key(i, j);
      let l = buckets.get(k);
      if (!l) { l = []; buckets.set(k, l); }
      l.push(s);
    }
  }
  // a local street hugging and nearly parallel to an avenue/expressway goes (no overlapping roads)
  const dead = new Uint8Array(n);
  for (const list of buckets.values()) {
    for (const s of list) {
      if (sp[s] !== GEN.Local || dead[s]) continue;
      const mx = (sx0[s] + sx1[s]) / 2, mz = (sz0[s] + sz1[s]) / 2;
      const ls = Math.hypot(sx1[s] - sx0[s], sz1[s] - sz0[s]) || 1;
      for (const t of list) {
        if (sp[t] === GEN.Local) continue;
        const dx = sx1[t] - sx0[t], dz = sz1[t] - sz0[t];
        const lt = Math.hypot(dx, dz) || 1;
        const cos = Math.abs(((sx1[s] - sx0[s]) * dx + (sz1[s] - sz0[s]) * dz) / (ls * lt));
        if (cos < 0.93) continue;
        const u = Math.max(0, Math.min(1, ((mx - sx0[t]) * dx + (mz - sz0[t]) * dz) / (lt * lt)));
        if (Math.hypot(mx - (sx0[t] + dx * u), mz - (sz0[t] + dz * u)) < 26) { dead[s] = 1; break; }
      }
    }
  }
  const cuts: number[][] = Array.from({ length: n }, (_, s) => (dead[s] ? [] : [0, 1]));
  const seen = new Set<number>();
  for (const list of buckets.values()) {
    for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
      const s = list[a], t = list[b];
      if (dead[s] || dead[t]) continue;
      const pk = s < t ? s * n + t : t * n + s;
      if (seen.has(pk)) continue;
      seen.add(pk);
      const dx1 = sx1[s] - sx0[s], dz1 = sz1[s] - sz0[s], dx2 = sx1[t] - sx0[t], dz2 = sz1[t] - sz0[t];
      const den = dx1 * dz2 - dz1 * dx2;
      if (Math.abs(den) < 1e-9) continue;
      const wx = sx0[t] - sx0[s], wz = sz0[t] - sz0[s];
      const u = (wx * dz2 - wz * dx2) / den, v = (wx * dz1 - wz * dx1) / den;
      if (u > 1e-6 && u < 1 - 1e-6 && v > 1e-6 && v < 1 - 1e-6) { cuts[s].push(u); cuts[t].push(v); }
    }
  }
  // nodes merged through a hash grid
  const nx: number[] = [], nz: number[] = [];
  const grid = new Map<number, number[]>();
  const nodeAt = (x: number, z: number): number => {
    const i = Math.floor(x / MERGE), j = Math.floor(z / MERGE);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const l = grid.get(key(i + di, j + dj));
      if (l) for (const id of l) if (Math.hypot(nx[id] - x, nz[id] - z) < MERGE) return id;
    }
    const id = nx.length;
    nx.push(x); nz.push(z);
    const k = key(i, j);
    let l = grid.get(k);
    if (!l) { l = []; grid.set(k, l); }
    l.push(id);
    return id;
  };
  const edges = new Map<number, number>(); // node pair → profile (the strongest)
  const rank = (p: number) => (p === GEN.Expressway ? 3 : p === GEN.AvenueBike ? 2 : p === GEN.Avenue ? 1 : 0);
  for (let s = 0; s < n; s++) {
    const c = cuts[s].sort((a, b) => a - b);
    let prev = -1;
    for (const u of c) {
      const id = nodeAt(sx0[s] + (sx1[s] - sx0[s]) * u, sz0[s] + (sz1[s] - sz0[s]) * u);
      if (prev >= 0 && prev !== id) {
        const k = prev < id ? prev * 1e6 + id : id * 1e6 + prev;
        const old = edges.get(k);
        if (old === undefined || rank(sp[s]) > rank(old)) edges.set(k, sp[s]);
      }
      prev = id;
    }
  }
  // segments too short become a single node (union by root)
  const root = nx.map((_, i) => i);
  const find = (i: number): number => { while (root[i] !== i) { root[i] = root[root[i]]; i = root[i]; } return i; };
  for (const k of edges.keys()) {
    const a = Math.floor(k / 1e6), b = k - a * 1e6;
    if (Math.hypot(nx[a] - nx[b], nz[a] - nz[b]) < 16) { const ra = find(a), rb = find(b); if (ra !== rb) root[rb] = ra; }
  }
  const merged = new Map<number, number>();
  for (const [k, p] of edges) {
    const a = find(Math.floor(k / 1e6)), b = find(k - Math.floor(k / 1e6) * 1e6);
    if (a === b) continue;
    const kk = a < b ? a * 1e6 + b : b * 1e6 + a;
    const old = merged.get(kk);
    if (old === undefined || rank(p) > rank(old)) merged.set(kk, p);
  }
  // at most 8 links per node (the strongest stay)
  const deg = new Int32Array(nx.length);
  const sorted = [...merged.entries()].sort((x, y) => rank(y[1]) - rank(x[1]));
  edges.clear();
  for (const [k, p] of sorted) {
    const a = Math.floor(k / 1e6), b = k - a * 1e6;
    if (deg[a] >= 6 || deg[b] >= 6) continue;
    deg[a]++; deg[b]++;
    edges.set(k, p);
  }
  // loose pieces (small components) go
  {
    const adj = new Map<number, number[]>();
    for (const k of edges.keys()) {
      const a = Math.floor(k / 1e6), b = k - a * 1e6;
      (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
      (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
    }
    const comp = new Map<number, number>();
    const size: number[] = [];
    for (const start of adj.keys()) {
      if (comp.has(start)) continue;
      const id = size.length;
      let count = 0;
      const stack = [start];
      comp.set(start, id);
      while (stack.length) {
        const x = stack.pop()!;
        count++;
        for (const y of adj.get(x)!) if (!comp.has(y)) { comp.set(y, id); stack.push(y); }
      }
      size.push(count);
    }
    for (const k of [...edges.keys()]) if (size[comp.get(Math.floor(k / 1e6))!] < 30) edges.delete(k);
  }
  // distance to the expressway (for industry)
  const expNodes: number[] = [];
  for (const [k, p] of edges) if (p === GEN.Expressway) expNodes.push(Math.floor(k / 1e6));
  const nearExp = (x: number, z: number) => {
    let best = Infinity;
    for (const id of expNodes) { const d = Math.abs(nx[id] - x) + Math.abs(nz[id] - z); if (d < best) best = d; }
    return best;
  };
  // node heights: smoothed terrain; a node in the water (bridge) at the average of its neighbours
  const ny = nx.map((x, i) => {
    let h = 0;
    for (const [dx, dz] of [[0, 0], [8, 0], [-8, 0], [0, 8], [0, -8]]) h += H(x + dx, nz[i] + dz);
    return Math.max(SEA_LEVEL + 1.5, h / 5);
  });
  // zones by the distance to the centres, the avenues and the expressway
  const nearCenter = (x: number, z: number) => {
    let best = Infinity;
    for (const c of centers) best = Math.min(best, Math.hypot(x - c.x, z - c.z) / c.r);
    return best;
  };
  const zr = new Rng(seed * 31 + 7);
  const segs: number[] = [], strength: number[] = [];
  // catalogue variety by district (broad noise: a whole street stays the same)
  const P = (name: string) => { const i = PROFILES.findIndex((p) => p.name === name); return i < 0 ? 0 : i; };
  const V = {
    wide: P('Calçadas largas'), park: 1, urban: P('Rua urbana'), cobble: P('Rua de paralelepípedo'), green: P('Rua com canteiro central'),
    concrete: P('Estrada de concreto'), bike: P('Rua com ciclofaixa'), busSide: P('Faixa de ônibus lateral'), boulevard: P('Bulevar'),
    av4: P('Avenida 4 faixas'),
  };
  const variant = (profile: number, zone: number, d: number, x: number, z: number): number => {
    const n = fbm(x / 650, z / 650, seed + 313, 2), m = fbm(x / 1400, z / 1400, seed + 919, 2);
    if (profile === GEN.Local) {
      // commercial centre: 30 km/h wide-pavement streets in part of the streets only (with it on every street the
      // centre did not pass 13 km/h at the peak); the rest, 50 km/h urban streets or with parking
      if (zone === Zone.Commercial) return n > 0.45 ? V.wide : n > 0.1 ? V.urban : V.park;
      if (zone === Zone.Industrial) return V.concrete;
      if (zone === Zone.Mixed) return n > 0.25 ? V.bike : n < -0.25 ? V.green : V.park;
      if (d > 0.9 && m > 0.2) return V.cobble;
      return n > 0.3 ? V.urban : profile;
    }
    if (profile === GEN.Avenue) {
      if (d < 0.5 && m > 0.15) return V.busSide;
      if (m < -0.3) return V.boulevard;
      if (n > 0.35) return V.av4;
    }
    return profile;
  };
  for (const [k, profile] of edges) {
    const a = Math.floor(k / 1e6), b = k - a * 1e6;
    const mx = (nx[a] + nx[b]) / 2, mz = (nz[a] + nz[b]) / 2;
    const d = nearCenter(mx, mz);
    let zone: number = Zone.None;
    if (profile !== GEN.Expressway) {
      const avenue = profile !== GEN.Local;
      if (d < 0.08 && avenue) zone = Zone.ComHigh;
      else if (d < 0.16 || (avenue && d < 0.35)) zone = Zone.Commercial;
      else if (d < 0.32 || (avenue && d < 0.7)) zone = Zone.Mixed;
      else if (d < 1.05) zone = nearExp(mx, mz) < 800 && fbm(mx / 900, mz / 900, seed + 77, 2) > 0.05 ? Zone.Industrial : d > 0.75 ? Zone.ResLow : Zone.Residential;
      else zone = zr.next() < 0.5 ? Zone.Residential : Zone.None;
    }
    // no segment longer than the spatial index holds (MAX_SEG_LEN): long straight edges get nodes along them
    const L = Math.hypot(nx[b] - nx[a], nz[b] - nz[a]), pieces = Math.ceil(L / GEN_SEG_LEN), prof = variant(profile, zone, d, mx, mz);
    let from = a;
    for (let k = 1; k <= pieces; k++) {
      let to = b;
      if (k < pieces) {
        const t = k / pieces, x = nx[a] + (nx[b] - nx[a]) * t, z = nz[a] + (nz[b] - nz[a]) * t;
        to = nx.length;
        nx.push(x); nz.push(z); ny.push(ny[a] + (ny[b] - ny[a]) * t);
      }
      segs.push(from, to, prof, zone, zone); strength.push(rank(profile));
      from = to;
    }
  }
  tidyGraph(nx, nz, ny, segs, strength, (x, z) => { const h = H(x, z); return h > SEA_LEVEL + 1.2 && waterLevelAt(x, z, seed) < h - 1.2; });
  // only the nodes in use, with new indices
  const remap = new Int32Array(nx.length).fill(-1);
  const out: number[] = [];
  for (let i = 0; i < segs.length; i += 5) {
    for (const k of [0, 1]) {
      const id = segs[i + k];
      if (remap[id] < 0) { remap[id] = out.length / 3; out.push(nx[id], nz[id], ny[id]); }
      segs[i + k] = remap[id];
    }
  }
  const nodes = new Float32Array(out);
  return { nodes, segs: new Int32Array(segs), centers: new Float32Array(centers.flatMap((c) => [c.x, c.z, c.r])) };
}

/** A dead end closer than this to another road's ends is a near miss, not inside it (roads/repair.ts END_GAP). */
const END_GAP = 4;
/** Shortest piece a split or a moved end may leave (the generator's own floor, test/citygen.test.ts). */
const MIN_PIECE = 9;

/**
 * The graph the city is born with must open clean: no node where two roads leave at less than MIN_LEG_ANGLE (an
 * impossible junction) and no dead end lying inside another road (what repairDanglingEnds would join on reopening).
 * At a too sharp pair the weaker leg goes (on a tie, the one whose far end keeps another road, then the shorter).
 * A dead end inside a road becomes a junction with it (the road split at the closest point) when its street meets
 * the road at MIN_LEG_ANGLE or more; within MIN_PIECE of the road's end it ends on that end's node; else (or over water, on a bridge)
 * its last piece goes. Repeated until nothing changes. `segs` is rewritten
 * in place (a, b, profile, zl, zr); `nx`, `nz`, `ny` grow by the split nodes.
 */
function tidyGraph(nx: number[], nz: number[], ny: number[], segs: number[], strength: number[], land: (x: number, z: number) => boolean): void {
  const a: number[] = [], b: number[] = [], prof: number[] = [], zl: number[] = [], zr: number[] = [], rk: number[] = [], alive: boolean[] = [];
  const legs = new Map<number, number[]>();
  const legsOf = (n: number): number[] => legs.get(n) ?? legs.set(n, []).get(n)!;
  // a segment is filed in every cell its box, widened by the widest road, touches
  const C = 64, PAD = 12, cells = new Map<number, number[]>();
  const ck = (i: number, j: number) => (i + 4000) * 8192 + (j + 4000);
  const add = (sa: number, sb: number, p: number, l: number, r: number, k: number): number => {
    const s = a.length;
    a.push(sa); b.push(sb); prof.push(p); zl.push(l); zr.push(r); rk.push(k); alive.push(true);
    legsOf(sa).push(s); legsOf(sb).push(s);
    const i0 = Math.floor((Math.min(nx[sa], nx[sb]) - PAD) / C), i1 = Math.floor((Math.max(nx[sa], nx[sb]) + PAD) / C);
    const j0 = Math.floor((Math.min(nz[sa], nz[sb]) - PAD) / C), j1 = Math.floor((Math.max(nz[sa], nz[sb]) + PAD) / C);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) (cells.get(ck(i, j)) ?? cells.set(ck(i, j), []).get(ck(i, j))!).push(s);
    return s;
  };
  const remove = (s: number): void => {
    alive[s] = false;
    for (const n of [a[s], b[s]]) { const l = legs.get(n)!; l.splice(l.indexOf(s), 1); }
  };
  const other = (s: number, n: number) => (a[s] === n ? b[s] : a[s]);
  const heading = (n: number, m: number) => Math.atan2(nz[m] - nz[n], nx[m] - nx[n]) * 180 / Math.PI;
  const gapBetween = (h1: number, h2: number) => { const d = Math.abs(h1 - h2) % 360; return Math.min(d, 360 - d); };
  for (let i = 0; i < segs.length; i += 5) add(segs[i], segs[i + 1], segs[i + 2], segs[i + 3], segs[i + 4], strength[i / 5]);

  /** The two neighbouring legs at `n` closest in angle, if closer than MIN_LEG_ANGLE. */
  const sharpPair = (n: number): [number, number] | null => {
    const l = legs.get(n);
    if (!l || l.length < 2) return null;
    const hs = l.map((s) => ({ s, h: heading(n, other(s, n)) })).sort((x, y) => x.h - y.h);
    let best: [number, number] | null = null, gap = MIN_LEG_ANGLE;
    for (let i = 0; i < hs.length; i++) {
      const j = (i + 1) % hs.length, g = j === 0 ? hs[0].h + 360 - hs[i].h : hs[j].h - hs[i].h;
      if (g < gap) { gap = g; best = [hs[i].s, hs[j].s]; }
    }
    return best;
  };
  const weaker = (n: number, s: number, t: number): number => {
    if (rk[s] !== rk[t]) return rk[s] < rk[t] ? s : t;
    const keeps = (x: number) => legsOf(other(x, n)).length >= 3;
    if (keeps(s) !== keeps(t)) return keeps(s) ? s : t;
    const len = (x: number) => Math.hypot(nx[a[x]] - nx[b[x]], nz[a[x]] - nz[b[x]]);
    return len(s) <= len(t) ? s : t;
  };
  /** The road a dead end lies inside (repairDanglingEnds' test): segment, position along it, or −1. */
  const inside = (n: number, own: number): [number, number] => {
    const x = nx[n], z = nz[n];
    let best = -1, bt = 0, bd = Infinity;
    const l = cells.get(ck(Math.floor(x / C), Math.floor(z / C)));
    if (l) for (const s of l) {
      if (!alive[s] || s === own || a[s] === n || b[s] === n) continue;
      const dx = nx[b[s]] - nx[a[s]], dz = nz[b[s]] - nz[a[s]], L = Math.hypot(dx, dz);
      if (L < 1e-6) continue;
      const t = Math.max(0, Math.min(1, ((x - nx[a[s]]) * dx + (z - nz[a[s]]) * dz) / (L * L)));
      const d = Math.hypot(x - nx[a[s]] - dx * t, z - nz[a[s]] - dz * t);
      if (d > Math.max(1.5, PROFILE_INFO[prof[s]]?.asphaltRight ?? 3) || d >= bd) continue;
      if (t * L < END_GAP || (1 - t) * L < END_GAP) continue;
      if (Math.abs(ny[a[s]] + (ny[b[s]] - ny[a[s]]) * t - ny[n]) > 2) continue;
      best = s; bt = t; bd = d;
    }
    return [best, bt];
  };
  for (let changed = true, pass = 0; changed && pass < 20; pass++) {
    changed = false;
    for (const n of [...legs.keys()]) {
      for (let p = sharpPair(n); p; p = sharpPair(n)) { remove(weaker(n, p[0], p[1])); changed = true; }
    }
    for (const n of [...legs.keys()]) {
      const l = legs.get(n)!;
      if (l.length !== 1) continue;
      const own = l[0], [s, t] = inside(n, own);
      if (s < 0) continue;
      changed = true;
      const far = other(own, n);
      const x = nx[a[s]] + (nx[b[s]] - nx[a[s]]) * t, z = nz[a[s]] + (nz[b[s]] - nz[a[s]]) * t;
      const h = Math.atan2(nz[far] - z, nx[far] - x) * 180 / Math.PI, hr = heading(a[s], b[s]);
      const L = Math.hypot(nx[b[s]] - nx[a[s]], nz[b[s]] - nz[a[s]]);
      if (t * L < MIN_PIECE || (1 - t) * L < MIN_PIECE) {
        // too near the road's end for a piece of its own: the street ends on that node instead
        const e = t * L < MIN_PIECE ? a[s] : b[s];
        const free = legsOf(e).length < 6 && land(nx[e], nz[e]) && !legsOf(e).some((x) => other(x, e) === far);
        remove(own);
        if (free && Math.hypot(nx[far] - nx[e], nz[far] - nz[e]) >= MIN_PIECE) add(a[own] === n ? e : a[own], a[own] === n ? b[own] : e, prof[own], zl[own], zr[own], rk[own]);
        continue;
      }
      if (gapBetween(h, hr) < MIN_LEG_ANGLE || gapBetween(h, hr + 180) < MIN_LEG_ANGLE || Math.hypot(nx[far] - x, nz[far] - z) < MIN_PIECE || !land(x, z)) { remove(own); continue; }
      // split the road there and bring the street's end onto the new node
      const m = nx.length;
      nx.push(x); nz.push(z); ny.push(ny[a[s]] + (ny[b[s]] - ny[a[s]]) * t);
      remove(s);
      add(a[s], m, prof[s], zl[s], zr[s], rk[s]);
      add(m, b[s], prof[s], zl[s], zr[s], rk[s]);
      remove(own);
      if (a[own] === n) add(m, b[own], prof[own], zl[own], zr[own], rk[own]);
      else add(a[own], m, prof[own], zl[own], zr[own], rk[own]);
    }
  }
  segs.length = 0;
  for (let s = 0; s < a.length; s++) if (alive[s]) segs.push(a[s], b[s], prof[s], zl[s], zr[s]);
}

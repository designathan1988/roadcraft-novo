// Builds the road mesh of a piece of the network (worker). Segments become strips
// by the profile's cross-section (asphalt, kerb, sidewalk, median, barrier); nodes with
// 3+ arms become junctions with rounded corners; loose ends get
// a finish. Zebra crossings, stop lines and painted lines are in the
// shader (extra attribute: u, v, to the end, code). Dropped kerbs at the
// zebra crossings. High segments become bridges (deck, parapet, piers) and
// buried segments become tunnels with a portal.

import { SEA_LEVEL } from '../config.ts';
import { arcTable, bez, bezD, tAtLength, type Arm, type Quad } from '../roads/geometry.ts';
import { armOf, BULB_R, BULB_WALK, NODE_BULB, bulbRetreat, cornerFillet, junctionRetreats } from '../roads/junction.ts';
import { PROFILE_INFO, Paving, Surface, type ProfileInfo, type Strip } from '../roads/profiles.ts';
import { SegFlag } from '../roads/flags.ts';
import { heightAt } from '../world/heights.ts';
import { ZONE_COLORS } from '../roads/zones.ts';
import { MeshBuilder } from './meshBuilder.ts';
import type { PackedMesh, RoadGraph } from './protocol.ts';

export const RMAT = { Asphalt: 2, Plain: 3, Sidewalk: 4, Grass: 5, Concrete: 6, Curb: 7, Zone: 8, Pavers: 9, Stone: 10 } as const;
export const CURB_H = 0.15;
const DECK = 1.3;
const SKIRT = 0.7;
/** Dropped kerb (Roadcraft curbRamps.ts): the zebra runs 0.7–3.6 m from the mouth; the kerb is down across it, at
 *  RAMP_LOW, rising back to full height towards the mouth and over a 1.5 m flare (1:10) past it; the walk ramps up
 *  over RAMP_RUN (1:12) away from the kerb. */
const RAMP_LOW = 0.02, RAMP_RUN = 1.8, RAMP_FROM = 0.65, RAMP_TO = 3.65, RAMP_FLARE = 1.5;
const RAMP_MARKS = [RAMP_FROM, RAMP_TO, RAMP_TO + RAMP_FLARE];
/** Height share (0 down, 1 full) of the kerb at `d` metres from the mouth. */
function rampShare(d: number): number {
  if (d < RAMP_FROM) return Math.max(0, (RAMP_FROM - d) / RAMP_FROM);
  if (d <= RAMP_TO) return 0;
  return Math.min(1, (d - RAMP_TO) / RAMP_FLARE);
}
/** Bridges (Roadcraft render/structures.ts): pier spacing on land (viaduct) and over water, the crossbeam's height and
 *  overhang, an abutment's length, and how near an abutment a pier may stand. */
export const PIER_SPACING_ELEVATED = 29.6, PIER_SPACING_BRIDGE = 38.4;
const CAP_H = 0.72, CAP_OVERHANG = 0.64, ABUTMENT_LEN = 1.6, ABUTMENT_CLEAR = 10.4, PARAPET_FROM = 0.64, PARAPET_FULL = 1.28;
const smooth01 = (t: number) => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); };

/** Where the piers of a span from s0 to s1 go: every `spacing` from half a spacing in, never within ABUTMENT_CLEAR of an
 *  abutment; one at mid-span when none fits. */
export function pierStations(s0: number, s1: number, spacing: number, abutments: readonly number[]): number[] {
  const out: number[] = [];
  for (let d = s0 + spacing * 0.5; d < s1 - spacing * 0.35; d += spacing) if (!abutments.some((a) => Math.abs(a - d) < ABUTMENT_CLEAR)) out.push(d);
  if (!out.length) { const mid = (s0 + s1) / 2; if (!abutments.some((a) => Math.abs(a - mid) < ABUTMENT_CLEAR)) out.push(mid); }
  return out;
}

/** A bent under a deck of half width `halfDeck`: column offsets across the road, the column's width (thicker when
 *  taller: an eighth of its height, between r and 1.8 r) and r (wider over water). */
export function bentColumns(halfDeck: number, height: number, overWater: boolean): { offsets: number[]; width: number; radius: number } {
  const radius = overWater ? 1.28 : 1.04;
  const spread = Math.max(0, Math.min(0.55 * halfDeck, halfDeck - radius - 1));
  return { offsets: spread > 0 ? [-spread, spread] : [0], width: Math.min(radius * 1.8, Math.max(radius, height / 8)), radius };
}

const COLOR = {
  asphalt: 0x3a3c40, parking: 0x404246, bike: 0x9a4a3e, shoulder: 0x4a4c4f,
  sidewalk: 0xb3b0aa, curb: 0xd3cec4, grass: 0x5a7a3e, concrete: 0xa9a59d,
};

/** Flags in the vertex code (code = segment * 16 + flags). */
export const RoadCode = { CrossA: 1, CrossB: 2, OneWay: 4, Ring: 8 } as const;

interface ArmRef { seg: number; end: 0 | 1; arm: Arm }

const p2 = new Float64Array(2), d2 = new Float64Array(2);

/** Carriageway colour by its surface. */
function surfaceColor(surface: number | undefined): number {
  return surface === Surface.Concrete ? 0x8e8b85 : surface === Surface.Cobble ? 0x6e675f : surface === Surface.Ballast ? 0x7a746b : COLOR.asphalt;
}

function stripColor(st: Strip, surface?: number): number {
  switch (st.kind) {
    case 'parking': return surface ? surfaceColor(surface) : COLOR.parking;
    case 'bike': return COLOR.bike;
    case 'shoulder': return surface === Surface.Ballast ? surfaceColor(surface) : COLOR.shoulder;
    case 'sidewalk': return st.pave === Paving.Pavers ? 0xa89c8c : st.pave === Paving.Stone ? 0xc9c3b8 : COLOR.sidewalk;
    case 'curb': return COLOR.curb;
    case 'median': return st.pave === Paving.Concrete ? COLOR.concrete : st.pave === Paving.Pavers ? 0xa89c8c : COLOR.grass;
    case 'barrier': return COLOR.concrete;
    default: return surfaceColor(surface);
  }
}

function stripMat(st: Strip): number {
  switch (st.kind) {
    case 'sidewalk': return st.pave === Paving.Pavers ? RMAT.Pavers : st.pave === Paving.Stone ? RMAT.Stone : RMAT.Sidewalk;
    case 'curb': return RMAT.Curb;
    case 'median': return st.pave === Paving.Concrete ? RMAT.Concrete : st.pave === Paving.Pavers ? RMAT.Pavers : st.pave === Paving.Stone ? RMAT.Stone : RMAT.Grass;
    case 'barrier': return RMAT.Concrete;
    default: return RMAT.Asphalt;
  }
}

function stripHeight(st: Strip): number {
  if (st.flush) return st.kind === 'barrier' ? 0.9 : 0;
  switch (st.kind) {
    case 'sidewalk': case 'curb': case 'median': return CURB_H;
    case 'barrier': return 0.9;
    default: return 0;
  }
}

export function buildRoadMesh(heights: Float32Array, g: RoadGraph, originX: number, originZ: number, extent: number, lod: number): PackedMesh | null {
  const mb = new MeshBuilder(true);
  const quads: Quad[] = [];
  for (let s = 0; s < g.segCount; s++) {
    quads.push({ x0: g.nx[g.sa[s]], z0: g.nz[g.sa[s]], cx: g.scx[s], cz: g.scz[s], x1: g.nx[g.sb[s]], z1: g.nz[g.sb[s]] });
  }
  const tables = quads.map((q) => arcTable(q, 48));
  const lens = tables.map((t) => t[t.length - 1]);

  // arms of each node, sorted, and the setback of each segment end
  const armsOf: ArmRef[][] = Array.from({ length: g.nodeCount }, () => []);
  for (let s = 0; s < g.segCount; s++) {
    for (const end of [0, 1] as const) armsOf[end === 0 ? g.sa[s] : g.sb[s]].push({ seg: s, end, arm: armOf(quads[s], g.sprofile[s], end) });
  }
  const retreat = new Float64Array(g.segCount * 2);
  const r16 = new Float64Array(16);
  const order: number[] = [];
  for (let n = 0; n < g.nodeCount; n++) {
    const list = armsOf[n];
    if (list.length === 1 && g.nctl[n] === NODE_BULB) retreat[list[0].seg * 2 + list[0].end] = bulbRetreat(list[0].arm, lens[list[0].seg]);
    if (list.length < 2) continue;
    junctionRetreats(list.map((r) => r.arm), list.map((r) => lens[r.seg]), r16, order);
    list.forEach((r, i) => { retreat[r.seg * 2 + r.end] = r16[i]; });
    // the junction is built in counter-clockwise order
    const sorted = order.map((i) => list[i]);
    list.length = 0; list.push(...sorted);
  }
  // mid-block crossing: the two-road node paints the zebra like a junction
  const deg = (n: number) => armsOf[n].length === 2 && (g.nctl[n] === 9 || g.nctl[n] === 10) ? 3 : armsOf[n].length;

  for (let s = 0; s < g.segCount; s++) {
    if (!g.segOwn[s]) continue;
    buildSegment(mb, heights, g, s, quads[s], tables[s], lens[s], retreat[s * 2], retreat[s * 2 + 1], deg(g.sa[s]), deg(g.sb[s]), lod);
  }
  for (let n = 0; n < g.nodeCount; n++) {
    if (!g.nodeOwn[n]) continue;
    const list = armsOf[n];
    // junction surface: that of the road with the most priority
    let best = list[0] ? g.sprofile[list[0].seg] : 0;
    for (const r of list) if ((PROFILE_INFO[g.sprofile[r.seg]].priority ?? 0) > (PROFILE_INFO[best].priority ?? 0)) best = g.sprofile[r.seg];
    mb.curTag = best;
    if (list.length === 1) {
      const r = list[0], d = retreat[r.seg * 2 + r.end];
      if (d > 0.05) buildBulb(mb, g, n, r, quads[r.seg], tables[r.seg], lens[r.seg], d, lod);
      else buildDeadEnd(mb, g, n, r, quads[r.seg]);
    }
    else if (list.length >= 2 && list.some((r) => retreat[r.seg * 2 + r.end] > 0.05)) buildJunction(mb, g, n, list, quads, tables, lens, retreat, lod);
  }
  return mb.pack(originX, originZ, extent);
}

/** Frame at point s (length) of the segment: position, direction, height. */
function frameAt(g: RoadGraph, s: number, q: Quad, table: Float64Array, len: number, at: number, out: Float64Array): void {
  const t = tAtLength(table, at);
  bez(q, t, p2); bezD(q, t, d2);
  const l = Math.hypot(d2[0], d2[1]) || 1;
  const ya = g.ny[g.sa[s]], yb = g.ny[g.sb[s]];
  out[0] = p2[0]; out[1] = p2[1]; out[2] = d2[0] / l; out[3] = d2[1] / l;
  out[4] = ya + (yb - ya) * (len > 0 ? at / len : 0);
}

function buildSegment(mb: MeshBuilder, heights: Float32Array, g: RoadGraph, s: number, q: Quad, table: Float64Array, len: number,
  rA: number, rB: number, degA: number, degB: number, lod: number): void {
  const info = PROFILE_INFO[g.sprofile[s]];
  const s0 = rA, s1 = len - rB;
  if (s1 - s0 < 0.2) return;
  const ring = (g.sflags[s] & SegFlag.Ring) !== 0;
  const crossA = degA >= 3 && !ring, crossB = degB >= 3 && !ring;
  // code: segment id * 16 + bits (exact in float32 up to 1 million segments); the profile goes in position.w
  mb.curTag = info.id | (g.srule[s] & 7) << 8 | ((g.srule[s] >> 3) & 7) << 11;
  const code = g.sid[s] * 16 + (crossA ? RoadCode.CrossA : 0) + (crossB ? RoadCode.CrossB : 0) + (info.oneWay ? RoadCode.OneWay : 0) + (ring ? RoadCode.Ring : 0);

  // sample positions: a regular step + the dropped kerb's points
  const step = lod === 0 ? 3 : 10;
  const marks = new Set<number>();
  const n0 = Math.max(1, Math.ceil((s1 - s0) / step));
  for (let k = 0; k <= n0; k++) marks.add(s0 + (s1 - s0) * k / n0);
  if (lod === 0) {
    if (crossA) for (const d of RAMP_MARKS) if (s0 + d < s1) marks.add(s0 + d);
    if (crossB) for (const d of RAMP_MARKS) if (s1 - d > s0) marks.add(s1 - d);
  }
  const at = [...marks].sort((a, b) => a - b);
  const n = at.length;
  const F = new Float64Array(n * 5);
  const f = new Float64Array(5);
  const ground = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    frameAt(g, s, q, table, len, at[k], f);
    F.set(f, k * 5);
    ground[k] = heightAt(heights, f[0], f[1]);
  }
  const slope = (g.ny[g.sb[s]] - g.ny[g.sa[s]]) / Math.max(1, len);
  const elevated = (k: number) => F[k * 5 + 4] - ground[k] > 1.2;
  const buried = (k: number) => ground[k] - F[k * 5 + 4] > 4;

  /**
   * Dropped kerb at the crossings (Roadcraft curbRamps.ts): across the zebra's width the kerb comes down to 2 cm and
   * the sidewalk rises back over RAMP_RUN (1:12) into the walk; past the zebra it flares back up. At the junction's
   * mouth the kerb is full height again, so it meets the corner without a step. Height of the kerb's top at sample k.
   */
  const kerbH = (k: number): number => {
    if (lod !== 0) return CURB_H;
    let f = 1;
    if (crossA) f = Math.min(f, rampShare(at[k] - s0));
    if (crossB) f = Math.min(f, rampShare(s1 - at[k]));
    return RAMP_LOW + (CURB_H - RAMP_LOW) * f;
  };
  const ramps = lod === 0 && (crossA || crossB);

  const edges = info.edges;
  // U-turn through the median: the median opens (becomes carriageway) in the 9 m by the U-turn's node
  const uA = g.nctl[g.sa[s]] === 11, uB = g.nctl[g.sb[s]] === 11;
  const laneEdge = edges.find((e) => e.strip.kind === 'lane');
  // top vertices: per sample, per strip edge (u0 and u1 of each strip)
  const tops: number[][] = edges.map(() => []);
  /** The second band of a sidewalk split for its dropped kerb (empty otherwise). */
  const split: number[][] = edges.map(() => []);
  for (let k = 0; k < n; k++) {
    const o = k * 5;
    const px = F[o], pz = F[o + 1], dx = F[o + 2], dz = F[o + 3], y = F[o + 4];
    const lx = dz, lz = -dx;
    // top normal: cross(3D tangent, left)
    const tx = dx, ty = slope, tz = dz;
    const nx = ty * lz - 0, ny = tz * lx - tx * lz, nz = 0 - ty * lx;
    const v = at[k] - s0, toEnd = s1 - at[k];
    edges.forEach((e, i) => {
      const kind = e.strip.kind;
      let h = stripHeight(e.strip);
      if (kind === 'curb') h = kerbH(k);
      let col = stripColor(e.strip, info.surface), mat = stripMat(e.strip);
      if ((kind === 'median' || kind === 'barrier') && laneEdge && ((uA && v < 9) || (uB && toEnd < 9))) {
        h = stripHeight(laneEdge.strip); col = stripColor(laneEdge.strip, info.surface); mat = stripMat(laneEdge.strip);
      }
      // a sidewalk by a kerb with a dropped kerb: the ramp band next to the kerb, then the rest of the walk
      const kerbSide = ramps && kind === 'sidewalk' && !e.strip.flush ? (edges[i + 1]?.strip.kind === 'curb' ? 1 : edges[i - 1]?.strip.kind === 'curb' ? 0 : -1) : -1;
      if (kerbSide >= 0) {
        const run = Math.min(RAMP_RUN, e.u1 - e.u0 - 0.2), um = kerbSide === 1 ? e.u1 - run : e.u0 + run, hk = kerbH(k);
        const h0 = kerbSide === 0 ? hk : h, h1 = kerbSide === 1 ? hk : h;
        const a = mb.vert(px + lx * e.u0, y + h0, pz + lz * e.u0, nx, ny, nz, col, mat, e.u0, v, toEnd, code);
        const m = mb.vert(px + lx * um, y + h, pz + lz * um, nx, ny, nz, col, mat, um, v, toEnd, code);
        const b = mb.vert(px + lx * e.u1, y + h1, pz + lz * e.u1, nx, ny, nz, col, mat, e.u1, v, toEnd, code);
        tops[i].push(a, m);
        split[i].push(m, b);
        return;
      }
      const a = mb.vert(px + lx * e.u0, y + h, pz + lz * e.u0, nx, ny, nz, col, mat, e.u0, v, toEnd, code);
      const b = mb.vert(px + lx * e.u1, y + h, pz + lz * e.u1, nx, ny, nz, col, mat, e.u1, v, toEnd, code);
      tops[i].push(a, b);
    });
  }
  const hidden = (k: number) => buried(k) && buried(k + 1);
  for (const bands of [tops, split]) for (let i = 0; i < edges.length; i++) {
    const T = bands[i];
    if (!T.length) continue;
    for (let k = 0; k + 1 < n; k++) {
      if (hidden(k)) continue;
      mb.quad(T[k * 2], T[k * 2 + 1], T[k * 2 + 3], T[k * 2 + 2], 0, 1, 0);
    }
  }

  // zone band outside the sidewalk (shown with the zone tool only)
  for (const [zone, uEdge, dir] of [[g.szl[s], edges[edges.length - 1].u1, 1], [g.szr[s], edges[0].u0, -1]] as Array<[number, number, number]>) {
    if (!zone) continue;
    const zc = ZONE_COLORS[zone];
    let prev: [number, number] | null = null;
    for (let k = 0; k < n; k++) {
      const o = k * 5;
      const px = F[o], pz = F[o + 1], dx = F[o + 2], dz = F[o + 3], y = F[o + 4];
      const lx = dz, lz = -dx;
      const v = at[k] - s0, toEnd = s1 - at[k];
      const ua = uEdge + dir * 0.6, ub = uEdge + dir * 6.6;
      const xa = px + lx * ua, za = pz + lz * ua, xb = px + lx * ub, zb = pz + lz * ub;
      const cur: [number, number] = [
        mb.vert(xa, Math.max(y, heightAt(heights, xa, za)) + 0.3, za, 0, 1, 0, zc, RMAT.Zone, ua, v, toEnd, code),
        mb.vert(xb, Math.max(y, heightAt(heights, xb, zb)) + 0.3, zb, 0, 1, 0, zc, RMAT.Zone, ub, v, toEnd, code),
      ];
      if (prev && !elevated(k) && !elevated(k - 1) && !hidden(k - 1)) mb.quad(prev[0], prev[1], cur[1], cur[0], 0, 1, 0);
      prev = cur;
    }
  }

  // retaining wall: at the edges, where the ground is above the sidewalk (road in a cutting)
  if ((g.sflags[s] & 8) !== 0 && lod < 2) {
    for (const [uEdge, outSign] of [[edges[edges.length - 1].u1, 1], [edges[0].u0, -1]] as Array<[number, number]>) {
      for (let k = 0; k + 1 < n; k++) {
        if (hidden(k)) continue;
        const pt = (kk: number) => {
          const o = kk * 5;
          const lx = F[o + 3], lz = -F[o + 2];
          const x = F[o] + lx * (uEdge + outSign * 0.15), z = F[o + 1] + lz * (uEdge + outSign * 0.15);
          return { x, z, y: F[o + 4], g: heightAt(heights, F[o] + lx * (uEdge + outSign * 1.6), F[o + 1] + lz * (uEdge + outSign * 1.6)), nx: -lx * outSign, nz: -lz * outSign };
        };
        const A = pt(k), B = pt(k + 1);
        const topA = A.g + 0.6, topB = B.g + 0.6;
        if (topA - A.y < 1 && topB - B.y < 1) continue;
        const v = at[k] - s0, toEnd = s1 - at[k];
        const a0 = mb.vert(A.x, A.y, A.z, A.nx, 0, A.nz, COLOR.concrete, RMAT.Concrete, uEdge, v, toEnd, code);
        const b0 = mb.vert(B.x, B.y, B.z, B.nx, 0, B.nz, COLOR.concrete, RMAT.Concrete, uEdge, v, toEnd, code);
        const b1 = mb.vert(B.x, Math.max(B.y, topB), B.z, B.nx, 0, B.nz, COLOR.concrete, RMAT.Concrete, uEdge, v, toEnd, code);
        const a1 = mb.vert(A.x, Math.max(A.y, topA), A.z, A.nx, 0, A.nz, COLOR.concrete, RMAT.Concrete, uEdge, v, toEnd, code);
        mb.quad(a0, b0, b1, a1, A.nx, 0, A.nz);
        // top of the wall (30 cm coping), facing up
        const ox = -A.nx * 0.3, oz = -A.nz * 0.3;
        const t0 = mb.vert(A.x, Math.max(A.y, topA), A.z, 0, 1, 0, COLOR.concrete, RMAT.Concrete, uEdge, v, toEnd, code);
        const t1 = mb.vert(B.x, Math.max(B.y, topB), B.z, 0, 1, 0, COLOR.concrete, RMAT.Concrete, uEdge, v, toEnd, code);
        const t2 = mb.vert(B.x + ox, Math.max(B.y, topB), B.z + oz, 0, 1, 0, COLOR.concrete, RMAT.Concrete, uEdge, v, toEnd, code);
        const t3 = mb.vert(A.x + ox, Math.max(A.y, topA), A.z + oz, 0, 1, 0, COLOR.concrete, RMAT.Concrete, uEdge, v, toEnd, code);
        mb.quad(t0, t1, t2, t3, 0, 1, 0);
      }
    }
  }

  // vertical faces between strips of different heights (kerb, barrier)
  const side = (k: number, u: number, y0: number, y1: number, toLeft: boolean, col: number, mat: number): [number, number] => {
    const o = k * 5;
    const px = F[o], pz = F[o + 1], dx = F[o + 2], dz = F[o + 3], y = F[o + 4];
    const lx = dz, lz = -dx;
    const nx = toLeft ? lx : -lx, nz = toLeft ? lz : -lz;
    const v = at[k] - s0, toEnd = s1 - at[k];
    return [
      mb.vert(px + lx * u, y + y0, pz + lz * u, nx, 0, nz, col, mat, u, v, toEnd, code),
      mb.vert(px + lx * u, y + y1, pz + lz * u, nx, 0, nz, col, mat, u, v, toEnd, code),
    ];
  };
  const wall = (u: number, h0: (k: number) => number, h1: (k: number) => number, toLeft: boolean, col: number, mat: number, only?: (k: number) => boolean) => {
    let prev: [number, number] | null = null;
    for (let k = 0; k < n; k++) {
      const cur = side(k, u, h0(k), h1(k), toLeft, col, mat);
      if (prev && !hidden(k - 1) && (!only || (only(k - 1) && only(k)))) {
        const o = k * 5;
        const lx = F[o + 3], lz = -F[o + 2];
        mb.quad(prev[0], cur[0], cur[1], prev[1], toLeft ? lx : -lx, 0, toLeft ? lz : -lz);
      }
      prev = cur;
    }
  };
  const hOf = (i: number) => (k: number) => edges[i].strip.kind === 'curb' ? kerbH(k) : stripHeight(edges[i].strip);
  if (lod === 0) {
    for (let i = 0; i + 1 < edges.length; i++) {
      const ha = hOf(i), hb = hOf(i + 1);
      const u = edges[i].u1;
      // the face looks towards the lower side
      const leftLower = stripHeight(edges[i + 1].strip) < stripHeight(edges[i].strip);
      const rightLower = stripHeight(edges[i].strip) < stripHeight(edges[i + 1].strip);
      if (leftLower) wall(u, hb, ha, true, stripColor(edges[i].strip, info.surface), stripMat(edges[i].strip));
      else if (rightLower) wall(u, ha, hb, false, stripColor(edges[i + 1].strip, info.surface), stripMat(edges[i + 1].strip));
    }
  }
  // outer edges: a skirt down to the ground (or the deck, on a bridge)
  const first = edges[0], last = edges[edges.length - 1];
  const below = (k: number) => elevated(k) ? -DECK : -SKIRT;
  wall(first.u0, below, hOf(0), false, elevatedAny(n, elevated) ? COLOR.concrete : stripColor(first.strip, info.surface), RMAT.Concrete);
  wall(last.u1, below, hOf(edges.length - 1), true, elevatedAny(n, elevated) ? COLOR.concrete : stripColor(last.strip, info.surface), RMAT.Concrete);

  // bridge: deck underneath, parapets and piers
  const bridge = (k: number) => elevated(k);
  if (elevatedAny(n, elevated)) {
    let prev: [number, number] | null = null;
    for (let k = 0; k < n; k++) {
      const o = k * 5;
      const px = F[o], pz = F[o + 1], dx = F[o + 2], dz = F[o + 3], y = F[o + 4];
      const lx = dz, lz = -dx;
      const a = mb.vert(px + lx * first.u0, y - DECK, pz + lz * first.u0, 0, -1, 0, COLOR.concrete, RMAT.Concrete);
      const b = mb.vert(px + lx * last.u1, y - DECK, pz + lz * last.u1, 0, -1, 0, COLOR.concrete, RMAT.Concrete);
      if (prev && (bridge(k) || bridge(k - 1))) mb.quad(prev[0], a, b, prev[1], 0, -1, 0);
      prev = [a, b];
    }
    // parapets on both edges, growing in with the deck's height over the ground (Roadcraft: smoothstep 0.64–1.28 m)
    const lift = (k: number) => F[k * 5 + 4] - ground[k];
    const railed = (k: number) => lift(k) > PARAPET_FROM;
    const parapet = (k: number) => CURB_H + (1.0 - CURB_H) * smooth01((lift(k) - PARAPET_FROM) / (PARAPET_FULL - PARAPET_FROM));
    const top = (h: number) => () => h;
    for (const [u, inward] of [[first.u0, true], [last.u1, false]] as Array<[number, boolean]>) {
      const w = inward ? 0.25 : -0.25;
      wall(u, top(CURB_H), parapet, !inward, COLOR.concrete, RMAT.Concrete, railed);
      wall(u + w, top(CURB_H), parapet, inward, COLOR.concrete, RMAT.Concrete, railed);
      // parapet coping: the top of the wall, a little wider than it
      let pc: [number, number] | null = null;
      for (let k = 0; k < n; k++) {
        const o = k * 5;
        const lx = F[o + 3], lz = -F[o + 2], y = F[o + 4] + parapet(k);
        const ua = u - (inward ? 0.03 : -0.03), ub = u + w + (inward ? 0.03 : -0.03);
        const cur: [number, number] = [
          mb.vert(F[o] + lx * ua, y, F[o + 1] + lz * ua, 0, 1, 0, COLOR.curb, RMAT.Concrete),
          mb.vert(F[o] + lx * ub, y, F[o + 1] + lz * ub, 0, 1, 0, COLOR.curb, RMAT.Concrete),
        ];
        if (pc && railed(k) && railed(k - 1)) mb.quad(pc[0], cur[0], cur[1], pc[1], 0, 1, 0);
        pc = cur;
      }
    }
    // girders: longitudinal beams under the deck (Roadcraft structures.ts), one every ~4 m across
    if (lod < 2) {
      const span = last.u1 - first.u0;
      const nb = Math.max(2, Math.round(span / 4));
      for (let i = 0; i < nb; i++) {
        const ug = first.u0 + span * (i + 0.5) / nb;
        for (let k = 0; k + 1 < n; k++) {
          if (!bridge(k) || !bridge(k + 1)) continue;
          const a = k * 5, b = (k + 1) * 5;
          const ax = F[a] + F[a + 3] * ug, az = F[a + 1] - F[a + 2] * ug;
          const bx = F[b] + F[b + 3] * ug, bz = F[b + 1] - F[b + 2] * ug;
          const L = Math.hypot(bx - ax, bz - az);
          if (L < 0.05) continue;
          const ym = (F[a + 4] + F[b + 4]) / 2;
          mb.box((ax + bx) / 2, (az + bz) / 2, ym - DECK - 1.1, ym - DECK, (bx - ax) / L, (bz - az) / L, L / 2 + 0.02, 0.28, COLOR.concrete, RMAT.Concrete, true);
        }
      }
    }
    // Roadcraft structures.ts: an abutment where the deck leaves the ground, piers spaced by kind (over water wider)
    // clear of the abutments, each a two-column bent under a crossbeam, the columns thicker the taller they are
    const width = last.u1 - first.u0, halfDeck = width / 2;
    const abutments: number[] = [];
    let wet = false;
    for (let k = 0; k < n; k++) {
      if (ground[k] < SEA_LEVEL + 0.3) wet = true;
      if (k + 1 < n && elevated(k) !== elevated(k + 1)) abutments.push(at[elevated(k) ? k + 1 : k]);
    }
    for (const d of abutments) {
      frameAt(g, s, q, table, len, d, f);
      const gy = heightAt(heights, f[0], f[1]), soffit = f[4] - DECK;
      mb.box(f[0], f[1], Math.min(gy, soffit) - 1, soffit, f[2], f[3], ABUTMENT_LEN / 2, halfDeck + 0.3, COLOR.concrete, RMAT.Concrete, true);
    }
    for (const d of pierStations(s0, s1, wet ? PIER_SPACING_BRIDGE : PIER_SPACING_ELEVATED, abutments)) {
      frameAt(g, s, q, table, len, d, f);
      const gy = heightAt(heights, f[0], f[1]);
      const soffit = f[4] - DECK - 1.1, beam = soffit - CAP_H;
      if (f[4] - gy <= 1.2 || beam - gy < 0.36) continue;
      const bent = bentColumns(halfDeck, beam - gy, gy < SEA_LEVEL + 0.3);
      const lx = f[3], lz = -f[2];
      for (const off of bent.offsets) {
        // round pier near (octagonal prism), square farther
        if (lod === 0) prism(mb, f[0] + lx * off, f[1] + lz * off, gy - 1, beam, bent.width / 2, 8, COLOR.concrete, RMAT.Concrete);
        else mb.box(f[0] + lx * off, f[1] + lz * off, gy - 1, beam, f[2], f[3], bent.width / 2, bent.width / 2, COLOR.concrete, RMAT.Concrete);
      }
      // crossbeam under the girders, past the columns by its overhang
      const reach = bent.offsets.length > 1 ? Math.abs(bent.offsets[0]) + bent.width / 2 + CAP_OVERHANG : halfDeck - 0.3;
      mb.box(f[0], f[1], beam, soffit, f[2], f[3], bent.width * 1.1, Math.min(halfDeck - 0.1, reach), COLOR.concrete, RMAT.Concrete, true);
    }
  }

  // tunnel: a portal where the open road goes under
  for (let k = 0; k + 1 < n; k++) {
    if (buried(k) === buried(k + 1)) continue;
    const kk = buried(k) ? k + 1 : k; // open side
    const o = kk * 5;
    const px = F[o], pz = F[o + 1], dx = F[o + 2], dz = F[o + 3], y = F[o + 4];
    const half = (last.u1 - first.u0) / 2 + 0.6;
    const cu = (last.u1 + first.u0) / 2;
    const cx = px + dz * cu, cz = pz - dx * cu;
    mb.box(cx, cz, y + 5.8, y + 7.4, dx, dz, 0.6, half, COLOR.concrete, RMAT.Concrete, true);
    for (const sgn of [-1, 1]) {
      mb.box(cx + dz * sgn * half, cz - dx * sgn * half, y - 0.5, y + 5.8, dx, dz, 0.6, 0.6, COLOR.concrete, RMAT.Concrete);
    }
    // wing walls: from each side of the portal, splayed 30° out toward the open side, falling from the headwall
    // to 1.2 m over 7 m (they hold back the slope cut around the mouth)
    const ow = buried(k) ? 1 : -1;
    for (const sgn of [-1, 1]) {
      const x0 = cx + dz * sgn * (half + 0.6), z0 = cz - dx * sgn * (half + 0.6);
      const x1 = x0 + dx * ow * 7 + dz * sgn * 4, z1 = z0 + dz * ow * 7 - dx * sgn * 4;
      const wl = Math.hypot(x1 - x0, z1 - z0), tx = (x1 - x0) / wl, tz = (z1 - z0) / wl;
      const nx = -tz, nz = tx; // one side; the other face gets the opposite normal
      const t = 0.5;
      const ox = nx * t / 2, oz = nz * t / 2;
      for (const side of [1, -1]) {
        const sx = ox * side, sz = oz * side;
        const a = mb.vert(x0 + sx, y - 0.5, z0 + sz, nx * side, 0, nz * side, COLOR.concrete, RMAT.Concrete);
        const b = mb.vert(x1 + sx, y - 0.5, z1 + sz, nx * side, 0, nz * side, COLOR.concrete, RMAT.Concrete);
        const c = mb.vert(x1 + sx, y + 1.2, z1 + sz, nx * side, 0, nz * side, COLOR.concrete, RMAT.Concrete);
        const d = mb.vert(x0 + sx, y + 7.4, z0 + sz, nx * side, 0, nz * side, COLOR.concrete, RMAT.Concrete);
        mb.quad(a, b, c, d, nx * side, 0, nz * side);
      }
      const ta = mb.vert(x0 + ox, y + 7.4, z0 + oz, 0, 1, 0, COLOR.curb, RMAT.Concrete), tb = mb.vert(x1 + ox, y + 1.2, z1 + oz, 0, 1, 0, COLOR.curb, RMAT.Concrete);
      const tc = mb.vert(x1 - ox, y + 1.2, z1 - oz, 0, 1, 0, COLOR.curb, RMAT.Concrete), td = mb.vert(x0 - ox, y + 7.4, z0 - oz, 0, 1, 0, COLOR.curb, RMAT.Concrete);
      mb.quad(ta, tb, tc, td, 0, 1, 0);
    }
  }

  // finish of the raised strips at the segment's ends (sidewalk front, median nose)
  for (const kEnd of [0, n - 1]) {
    const o = kEnd * 5;
    const px = F[o], pz = F[o + 1], dx = F[o + 2], dz = F[o + 3], y = F[o + 4];
    const out = kEnd === 0 ? -1 : 1; // normal out of the segment
    const lx = dz, lz = -dx;
    edges.forEach((e, i) => {
      const h = hOf(i)(kEnd);
      if (h <= 0.01) return;
      const col = stripColor(e.strip, info.surface);
      const a = mb.vert(px + lx * e.u0, y, pz + lz * e.u0, dx * out, 0, dz * out, col, RMAT.Curb);
      const b = mb.vert(px + lx * e.u1, y, pz + lz * e.u1, dx * out, 0, dz * out, col, RMAT.Curb);
      const c = mb.vert(px + lx * e.u1, y + h, pz + lz * e.u1, dx * out, 0, dz * out, col, RMAT.Curb);
      const d = mb.vert(px + lx * e.u0, y + h, pz + lz * e.u0, dx * out, 0, dz * out, col, RMAT.Curb);
      mb.quad(a, b, c, d, dx * out, 0, dz * out);
    });
  }
}

/** Vertical prism of n sides (round pier), radius r, from y0 to y1, with a top. */
function prism(mb: MeshBuilder, cx: number, cz: number, y0: number, y1: number, r: number, sides: number, rgb: number, mat: number): void {
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2, a1 = ((i + 1) / sides) * Math.PI * 2, am = (a0 + a1) / 2;
    const nx = Math.cos(am), nz = Math.sin(am);
    const p0x = cx + Math.cos(a0) * r, p0z = cz + Math.sin(a0) * r, p1x = cx + Math.cos(a1) * r, p1z = cz + Math.sin(a1) * r;
    const a = mb.vert(p0x, y0, p0z, nx, 0, nz, rgb, mat), b = mb.vert(p1x, y0, p1z, nx, 0, nz, rgb, mat);
    const c = mb.vert(p1x, y1, p1z, nx, 0, nz, rgb, mat), d = mb.vert(p0x, y1, p0z, nx, 0, nz, rgb, mat);
    mb.quad(a, b, c, d, nx, 0, nz);
  }
}

function elevatedAny(n: number, fn: (k: number) => boolean): boolean {
  for (let k = 0; k < n; k++) if (fn(k)) return true;
  return false;
}

/**
 * Turning bulb (roadcraft `junction/bulb.ts`): asphalt in a circle of radius BULB_R round the node and a sidewalk with
 * a kerb outside, open towards the segment, which ends at the setback `d` (where the circle meets the carriageway edge).
 */
function buildBulb(mb: MeshBuilder, g: RoadGraph, node: number, ref: ArmRef, q: Quad, table: Float64Array, len: number, d: number, lod: number): void {
  const { arm, seg, end } = ref;
  const x = g.nx[node], z = g.nz[node], y0 = g.ny[node];
  const f = new Float64Array(5);
  frameAt(g, seg, q, table, len, end === 0 ? d : len - d, f);
  const ySeam = f[4];
  const dx = arm.dx, dz = arm.dz, lx = dz, lz = -dx;
  const yAt = (along: number) => (along <= 0 ? y0 : y0 + (ySeam - y0) * Math.min(1, along / d));
  const R = BULB_R, Ro = BULB_R + BULB_WALK;
  const aIn = Math.acos(Math.min(1, d / R)), aOut = Math.acos(Math.min(1, d / Ro));
  const N = lod === 0 ? 28 : 12;
  const at = (r: number, phi: number): [number, number, number] => {
    const along = r * Math.cos(phi), u = r * Math.sin(phi);
    return [x + dx * along + lx * u, yAt(along), z + dz * along + lz * u];
  };
  const paved = surfaceColor(PROFILE_INFO[mb.curTag]?.surface);
  // asphalt: a fan from the node, from the mouth's left side, round the back, to the right side
  const center = mb.vert(x, y0, z, 0, 1, 0, paved, RMAT.Plain);
  const rim: number[] = [];
  for (let i = 0; i <= N; i++) {
    const [px, py, pz] = at(R, aIn + (i / N) * (Math.PI * 2 - 2 * aIn));
    rim.push(mb.vert(px, py, pz, 0, 1, 0, paved, RMAT.Plain));
  }
  for (let i = 0; i < N; i++) mb.tri(center, rim[i], rim[i + 1], 0, 1, 0);
  mb.tri(center, rim[N], rim[0], 0, 1, 0);
  // sidewalk ring, kerb facing in and a skirt outside
  let prev: number[] | null = null;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const [ix, iy, iz] = at(R, aIn + t * (Math.PI * 2 - 2 * aIn));
    const [ox, oy, oz] = at(Ro, aOut + t * (Math.PI * 2 - 2 * aOut));
    const nx = x - ix, nz = z - iz;
    const cur = [
      mb.vert(ix, iy + CURB_H, iz, 0, 1, 0, COLOR.sidewalk, RMAT.Sidewalk), mb.vert(ox, oy + CURB_H, oz, 0, 1, 0, COLOR.sidewalk, RMAT.Sidewalk),
      mb.vert(ix, iy, iz, nx, 0, nz, COLOR.curb, RMAT.Curb), mb.vert(ix, iy + CURB_H, iz, nx, 0, nz, COLOR.curb, RMAT.Curb),
      mb.vert(ox, oy - SKIRT, oz, -nx, 0, -nz, COLOR.sidewalk, RMAT.Sidewalk), mb.vert(ox, oy + CURB_H, oz, -nx, 0, -nz, COLOR.sidewalk, RMAT.Sidewalk),
    ];
    if (prev) {
      mb.quad(prev[0], cur[0], cur[1], prev[1], 0, 1, 0);
      mb.quad(prev[2], cur[2], cur[3], prev[3], nx, 0, nz);
      mb.quad(prev[4], cur[4], cur[5], prev[5], -nx, 0, -nz);
    }
    prev = cur;
  }
}

/** Finish of a dead end: a sidewalk strip across the end. */
function buildDeadEnd(mb: MeshBuilder, g: RoadGraph, node: number, ref: ArmRef, q: Quad): void {
  void q;
  const { arm } = ref;
  const x = g.nx[node], z = g.nz[node], y = g.ny[node];
  const dx = arm.dx, dz = arm.dz, lx = dz, lz = -dx;
  const depth = 3;
  const P = (u: number, back: number, h: number, nx: number, ny: number, nz: number, col: number, mat: number) =>
    mb.vert(x + lx * u - dx * back, y + h, z + lz * u - dz * back, nx, ny, nz, col, mat);
  const L = arm.left, R = -arm.right;
  const t = [P(R, 0, CURB_H, 0, 1, 0, COLOR.sidewalk, RMAT.Sidewalk), P(L, 0, CURB_H, 0, 1, 0, COLOR.sidewalk, RMAT.Sidewalk),
    P(L, depth, CURB_H, 0, 1, 0, COLOR.sidewalk, RMAT.Sidewalk), P(R, depth, CURB_H, 0, 1, 0, COLOR.sidewalk, RMAT.Sidewalk)];
  mb.quad(t[0], t[1], t[2], t[3], 0, 1, 0);
  // kerb facing the street
  const c = [P(-arm.asphRight, 0, 0, dx, 0, dz, COLOR.curb, RMAT.Curb), P(arm.asphLeft, 0, 0, dx, 0, dz, COLOR.curb, RMAT.Curb),
    P(arm.asphLeft, 0, CURB_H, dx, 0, dz, COLOR.curb, RMAT.Curb), P(-arm.asphRight, 0, CURB_H, dx, 0, dz, COLOR.curb, RMAT.Curb)];
  mb.quad(c[0], c[1], c[2], c[3], dx, 0, dz);
  // skirt behind
  const s = [P(R, depth, -SKIRT, -dx, 0, -dz, COLOR.sidewalk, RMAT.Sidewalk), P(L, depth, -SKIRT, -dx, 0, -dz, COLOR.sidewalk, RMAT.Sidewalk),
    P(L, depth, CURB_H, -dx, 0, -dz, COLOR.sidewalk, RMAT.Sidewalk), P(R, depth, CURB_H, -dx, 0, -dz, COLOR.sidewalk, RMAT.Sidewalk)];
  mb.quad(s[0], s[1], s[2], s[3], -dx, 0, -dz);
}

interface ArmEnd { px: number; pz: number; y: number; dx: number; dz: number; info: ProfileInfo; arm: Arm; /** setback of the mouth */ at: number }

/** Junction: an asphalt fan from the node, corners with rounded sidewalk and kerb. */
function buildJunction(mb: MeshBuilder, g: RoadGraph, node: number, list: ArmRef[], quads: Quad[], tables: Float64Array[], lens: number[],
  retreat: Float64Array, lod: number): void {
  const cx = g.nx[node], cz = g.nz[node], cy = g.ny[node];
  const f = new Float64Array(5);
  const ends: ArmEnd[] = list.map((r) => {
    const s = r.seg, len = lens[s];
    const at = r.end === 0 ? retreat[s * 2] : len - retreat[s * 2 + 1];
    frameAt(g, s, quads[s], tables[s], len, at, f);
    const sgn = r.end === 0 ? 1 : -1;
    return { px: f[0], pz: f[1], y: f[4], dx: f[2] * sgn, dz: f[3] * sgn, info: PROFILE_INFO[g.sprofile[s]], arm: r.arm, at: r.end === 0 ? at : len - at };
  });
  const m = lod === 0 ? 7 : 3;
  const point = (e: ArmEnd, u: number): [number, number, number] => [e.px + e.dz * u, e.pz - e.dx * u, e.y];
  /**
   * Corner between a's left side (u = ua) and b's right side (u = −ub). Where the two kerbs get a kerb return
   * (`roads/junction.ts` cornerFillet, Roadcraft corners.ts) the line runs from a's mouth to the tangent point, round the
   * circle and on to b's mouth; the sidewalk's outer line is the same circle less the sidewalk width. Otherwise (bevel,
   * taper, a setback capped on a short segment) a smooth curve between the mouths.
   */
  const corner = (a: ArmEnd, ua: number, b: ArmEnd, ub: number): Array<[number, number, number]> => {
    const fc = cornerFillet(a.arm, b.arm);
    if (fc.mode === 'fillet' && a.at >= fc.trimA - 0.05 && b.at >= fc.trimB - 0.05) {
      const ccx = cx + fc.cx, ccz = cz + fc.cz;
      const ta: [number, number] = [cx + a.arm.dx * fc.trimA + a.arm.dz * ua, cz + a.arm.dz * fc.trimA - a.arm.dx * ua];
      const tb: [number, number] = [cx + b.arm.dx * fc.trimB - b.arm.dz * ub, cz + b.arm.dz * fc.trimB + b.arm.dx * ub];
      const a0 = Math.atan2(ta[1] - ccz, ta[0] - ccx);
      let sweep = Math.atan2(tb[1] - ccz, tb[0] - ccx) - a0;
      while (sweep > Math.PI) sweep -= 2 * Math.PI;
      while (sweep < -Math.PI) sweep += 2 * Math.PI;
      const rho = Math.max(0.05, Math.hypot(ta[0] - ccx, ta[1] - ccz));
      const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / (lod === 0 ? 16 : 6))));
      const out: Array<[number, number, number]> = [];
      const [mx, mz] = point(a, ua), [nx2, nz2] = point(b, -ub);
      out.push([mx, mz, a.y]);
      for (let i = 0; i <= steps; i++) {
        const t = i / steps, ang = a0 + sweep * t;
        out.push([ccx + Math.cos(ang) * rho, ccz + Math.sin(ang) * rho, a.y + (b.y - a.y) * t]);
      }
      out.push([nx2, nz2, b.y]);
      return out;
    }
    const [ax, az] = point(a, ua), [bx, bz] = point(b, -ub);
    // control: where the edges, carried inwards, cross
    const den = a.dx * b.dz - a.dz * b.dx;
    let kx = (ax + bx) / 2, kz = (az + bz) / 2;
    if (Math.abs(den) > 1e-3) {
      const wx = bx - ax, wz = bz - az;
      const sa = (wx * b.dz - wz * b.dx) / den, sb = (wx * a.dz - wz * a.dx) / den;
      if (sa < 0.5 && sb < 0.5 && sa > -60 && sb > -60) { kx = ax + a.dx * sa; kz = az + a.dz * sa; }
    }
    const out: Array<[number, number, number]> = [];
    for (let i = 0; i <= m; i++) {
      const t = i / m, s = 1 - t;
      out.push([s * s * ax + 2 * s * t * kx + t * t * bx, s * s * az + 2 * s * t * kz + t * t * bz, a.y + (b.y - a.y) * t]);
    }
    return out;
  };

  // asphalt: a fan from the centre
  const ring: Array<[number, number, number]> = [];
  const nArms = ends.length;
  for (let i = 0; i < nArms; i++) {
    const a = ends[i], b = ends[(i + 1) % nArms];
    ring.push(point(a, -a.arm.asphRight));
    ring.push(...corner(a, a.arm.asphLeft, b, b.arm.asphRight));
  }
  const paved = surfaceColor(PROFILE_INFO[mb.curTag]?.surface);
  const center = mb.vert(cx, cy, cz, 0, 1, 0, paved, RMAT.Plain);
  const rv = ring.map(([x, z, y]) => mb.vert(x, y, z, 0, 1, 0, paved, RMAT.Plain));
  for (let i = 0; i < rv.length; i++) mb.tri(center, rv[i], rv[(i + 1) % rv.length], 0, 1, 0);

  // corners: sidewalk between the asphalt curve and the outer curve
  for (let i = 0; i < nArms; i++) {
    const a = ends[i], b = ends[(i + 1) % nArms];
    const inner = corner(a, a.arm.asphLeft, b, b.arm.asphRight);
    const outer = corner(a, a.arm.left, b, b.arm.right);
    let pi: number[] | null = null;
    for (let k = 0; k < Math.min(inner.length, outer.length); k++) {
      const [ix, iz, iy] = inner[k], [ox, oz, oy] = outer[k];
      const nx = cx - ix, nz = cz - iz; // the kerb faces the centre
      const top0 = mb.vert(ix, iy + CURB_H, iz, 0, 1, 0, COLOR.sidewalk, RMAT.Sidewalk);
      const top1 = mb.vert(ox, oy + CURB_H, oz, 0, 1, 0, COLOR.sidewalk, RMAT.Sidewalk);
      const c0 = mb.vert(ix, iy, iz, nx, 0, nz, COLOR.curb, RMAT.Curb);
      const c1 = mb.vert(ix, iy + CURB_H, iz, nx, 0, nz, COLOR.curb, RMAT.Curb);
      const s0 = mb.vert(ox, oy - SKIRT, oz, -nx, 0, -nz, COLOR.sidewalk, RMAT.Sidewalk);
      const s1 = mb.vert(ox, oy + CURB_H, oz, -nx, 0, -nz, COLOR.sidewalk, RMAT.Sidewalk);
      const cur = [top0, top1, c0, c1, s0, s1];
      if (pi) {
        mb.quad(pi[0], top0, top1, pi[1], 0, 1, 0);
        mb.quad(pi[2], c0, c1, pi[3], nx, 0, nz);
        mb.quad(pi[4], s0, s1, pi[5], -nx, 0, -nz);
      }
      pi = cur;
    }
  }
}

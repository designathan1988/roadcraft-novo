// A closed block cut into lots as Roadcraft 4.0 cuts it (world/lots.ts blockPlan, :710-781): the land between the
// streets is found on a raster (paved = carriageway and footway), each closed piece of land is a block; its oriented
// box (the least-area rectangle round its cells) is cut into rows - two back to back when the block is at least
// TWO_ROWS deep, so the lots meet in its middle and no inner yard is left - and each row into equal columns of about
// LOT_FRONTAGE. Every lot reaches the footway: the block is covered from street to street.
// Pure: the same lots in every cell that sees the whole block (the cell's graph reaches MARGIN past it).

import { CELL_SIZE } from '../config.ts';
import { bez, type Quad } from '../roads/geometry.ts';
import { PROFILE_INFO } from '../roads/profiles.ts';
import type { RoadGraph } from '../shared/contracts/worker.ts';

/** 4.0 world/lots.ts:30-35. */
const LOT_FRONTAGE = 22, TWO_ROWS = 44, MIN_LOT = 10;
/** Raster step (m): the land's edge to within half of it. */
const RES = 1;
/** A piece of land wider than this is open land, not a block (4.0 MAX_BLOCK is a world tile; a city block is far less). */
const MAX_BLOCK = 320;

export interface BlockLot { x: number; z: number; w: number; d: number; rot: number; zone: number; profile: number; corners: number[] }

const p = new Float64Array(2);

/**
 * The lots of the closed blocks round cell (x0, z0) (its square plus `margin`). `zoneAt` tells, for a lot's front
 * middle and its outward direction, the zone and profile of the street it faces (zone 0: unzoned, no lot).
 */
export function blockLots(g: RoadGraph, quads: Quad[], lens: number[], x0: number, z0: number, margin: number,
  zoneAt: (fx: number, fz: number, ox: number, oz: number) => [number, number]): BlockLot[] {
  const ax = x0 - margin, az = z0 - margin, W = Math.ceil((CELL_SIZE + margin * 2) / RES);
  const paved = new Uint8Array(W * W);
  const disc = (x: number, z: number, r: number) => {
    const i0 = Math.max(0, Math.floor((x - r - ax) / RES)), i1 = Math.min(W - 1, Math.floor((x + r - ax) / RES));
    const j0 = Math.max(0, Math.floor((z - r - az) / RES)), j1 = Math.min(W - 1, Math.floor((z + r - az) / RES));
    const r2 = r * r;
    for (let j = j0; j <= j1; j++) {
      const dz = az + (j + 0.5) * RES - z;
      for (let i = i0; i <= i1; i++) { const dx = ax + (i + 0.5) * RES - x; if (dx * dx + dz * dz <= r2) paved[j * W + i] = 1; }
    }
  };
  // the streets' ground: carriageway and footways, every metre along each road
  const nodeHalf = new Float32Array(g.nodeCount), deg = new Uint8Array(g.nodeCount);
  for (let s = 0; s < g.segCount; s++) {
    const info = PROFILE_INFO[g.sprofile[s]], half = Math.max(info.left, info.right);
    nodeHalf[g.sa[s]] = Math.max(nodeHalf[g.sa[s]], half); nodeHalf[g.sb[s]] = Math.max(nodeHalf[g.sb[s]], half);
    deg[g.sa[s]]++; deg[g.sb[s]]++;
    const n = Math.max(2, Math.ceil(lens[s] / RES) + 1);
    for (let k = 0; k < n; k++) { bez(quads[s], k / (n - 1), p); disc(p[0], p[1], half); }
  }
  // a junction's plate reaches past its arms' sides by the kerb returns
  for (let n = 0; n < g.nodeCount; n++) if (deg[n] >= 3) disc(g.nx[n], g.nz[n], nodeHalf[n] * 1.15);

  // the pieces of land: flooded once each, bounded (open land touches the raster's edge or grows past MAX_BLOCK)
  const label = new Int32Array(W * W).fill(-1);
  const out: BlockLot[] = [];
  const stack: number[] = [];
  const cells: number[] = [];
  const cap = MAX_BLOCK / RES;
  for (let start = 0; start < W * W; start++) {
    if (paved[start] || label[start] >= 0) continue;
    const id = start;
    let open = false, i0 = W, i1 = -1, j0 = W, j1 = -1;
    cells.length = 0; stack.length = 0;
    stack.push(start); label[start] = id;
    while (stack.length) {
      const k = stack.pop()!, i = k % W, j = (k / W) | 0;
      cells.push(k);
      if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j;
      if (i === 0 || j === 0 || i === W - 1 || j === W - 1 || i1 - i0 > cap || j1 - j0 > cap) open = true;
      if (i > 0) { const q = k - 1; if (!paved[q] && label[q] < 0) { label[q] = id; stack.push(q); } }
      if (i < W - 1) { const q = k + 1; if (!paved[q] && label[q] < 0) { label[q] = id; stack.push(q); } }
      if (j > 0) { const q = k - W; if (!paved[q] && label[q] < 0) { label[q] = id; stack.push(q); } }
      if (j < W - 1) { const q = k + W; if (!paved[q] && label[q] < 0) { label[q] = id; stack.push(q); } }
    }
    if (open || cells.length * RES * RES < MIN_LOT * MIN_LOT * 2) continue;
    cutBlock(cells, id);
  }
  return out;

  function cutBlock(blockCells: number[], id: number): void {
    // the hull of the cell centres: each row's first and last (4.0 :713-721)
    const first = new Map<number, number>(), last = new Map<number, number>();
    for (const k of blockCells) {
      const i = k % W, j = (k / W) | 0;
      if (!first.has(j) || i < first.get(j)!) first.set(j, i);
      if (!last.has(j) || i > last.get(j)!) last.set(j, i);
    }
    const pts: Array<[number, number]> = [];
    for (const [j, i] of first) { pts.push([ax + (i + 0.5) * RES, az + (j + 0.5) * RES]); const l = last.get(j)!; if (l !== i) pts.push([ax + (l + 0.5) * RES, az + (j + 0.5) * RES]); }
    const hull = convexHull(pts);
    const box = minAreaBox(hull);
    if (!box) return;
    // grown by half a raster cell each side: its points are cell centres (4.0 :725)
    const L = box.L + RES, D = box.D + RES;
    const at = (s: number, t: number): [number, number] => [box.cx + box.ux * s + box.vx * t, box.cz + box.uz * s + box.vz * t];
    const rows = D >= TWO_ROWS ? 2 : 1, depth = D / rows;
    const columns = Math.max(1, Math.round(L / Math.max(MIN_LOT, Math.min(depth, LOT_FRONTAGE))));
    const width = L / columns;
    const landAt = (x: number, z: number) => {
      const i = Math.floor((x - ax) / RES), j = Math.floor((z - az) / RES);
      return i >= 0 && j >= 0 && i < W && j < W && label[j * W + i] === id;
    };
    for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) {
      const s0 = -L / 2 + c * width, s1 = s0 + width, t0 = -D / 2 + r * depth, t1 = t0 + depth;
      // most of it on this block's land (a block that is no rectangle, 4.0 :769-775)
      let inside = 0, total = 0;
      for (let a = 0.1; a < 1; a += 0.2) for (let b = 0.1; b < 1; b += 0.2) { total++; if (landAt(...at(s0 + (s1 - s0) * a, t0 + (t1 - t0) * b))) inside++; }
      if (inside / total < 0.5) continue;
      // the front faces the street: two rows, the outer long edge; one row, the side with a street nearer
      const towardMinus = rows === 2 ? r === 0 : nearerMinus(s0, s1);
      const ox = towardMinus ? -box.vx : box.vx, oz = towardMinus ? -box.vz : box.vz; // out of the lot, to the street
      const [fx, fz] = at((s0 + s1) / 2, towardMinus ? t0 : t1);
      const [zone, profile] = zoneAt(fx, fz, ox, oz);
      if (!zone) continue;
      const [cx, cz] = at((s0 + s1) / 2, (t0 + t1) / 2);
      // the lot's local frame as lots.ts writes it: w along the front, d away from the street; rot faces the street
      const lx = -ox, lz = -oz;
      out.push({ x: cx, z: cz, w: width, d: depth, rot: Math.atan2(-lx, -lz), zone, profile,
        corners: [...at(s0, t0), ...at(s1, t0), ...at(s1, t1), ...at(s0, t1)] });
    }

    function nearerMinus(s0: number, s1: number): boolean {
      const s = (s0 + s1) / 2;
      for (let d = 0; d < 12; d += 1) {
        const [mx, mz] = at(s, -D / 2 - d), [px, pz] = at(s, D / 2 + d);
        const minus = !landAt(mx, mz) && pavedAt(mx, mz), plus = !landAt(px, pz) && pavedAt(px, pz);
        if (minus !== plus) return minus;
      }
      return true;
    }
  }

  function pavedAt(x: number, z: number): boolean {
    const i = Math.floor((x - ax) / RES), j = Math.floor((z - az) / RES);
    return i >= 0 && j >= 0 && i < W && j < W && paved[j * W + i] === 1;
  }
}

/** Monotone-chain convex hull (counter-clockwise). */
function convexHull(pts: Array<[number, number]>): Array<[number, number]> {
  const s = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (s.length < 3) return s;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Array<[number, number]> = [], upper: Array<[number, number]> = [];
  for (const q of s) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let k = s.length - 1; k >= 0; k--) { const q = s[k]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** The least-area rectangle round a convex hull (one of its sides lies on a hull edge): centre, axes, length >= depth. */
function minAreaBox(h: Array<[number, number]>): { cx: number; cz: number; ux: number; uz: number; vx: number; vz: number; L: number; D: number } | null {
  if (h.length < 3) return null;
  let best: ReturnType<typeof minAreaBox> = null, bestA = Infinity;
  for (let e = 0; e < h.length; e++) {
    const a = h[e], b = h[(e + 1) % h.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l < 1e-9) continue;
    const ux = (b[0] - a[0]) / l, uz = (b[1] - a[1]) / l, vx = -uz, vz = ux;
    let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
    for (const q of h) { const s = q[0] * ux + q[1] * uz, t = q[0] * vx + q[1] * vz; s0 = Math.min(s0, s); s1 = Math.max(s1, s); t0 = Math.min(t0, t); t1 = Math.max(t1, t); }
    const area = (s1 - s0) * (t1 - t0);
    if (area < bestA - 1e-6) {
      bestA = area;
      const sm = (s0 + s1) / 2, tm = (t0 + t1) / 2, Ls = s1 - s0, Dt = t1 - t0;
      const cx = ux * sm + vx * tm, cz = uz * sm + vz * tm;
      // the longer side is the length (u), the shorter the depth (v)
      best = Ls >= Dt ? { cx, cz, ux, uz, vx, vz, L: Ls, D: Dt } : { cx, cz, ux: vx, uz: vz, vx: -ux, vz: -uz, L: Dt, D: Ls };
    }
  }
  return best;
}

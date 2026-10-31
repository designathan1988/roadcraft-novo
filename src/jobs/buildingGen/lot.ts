// Lot surfaces: ground, walls, gates, walkways, parking, foundations and polygon outlines. The lot state of one
// building lives between beginLot/endLot; the drawing helpers take the caller's mesh, frame and heights.

import { hash2 } from '../../core/rng.ts';
import type { BoxColumns } from '../../shared/contracts/worker.ts';
import { heightAt } from '../../world/heights.ts';
import type { MeshBuilder } from '../meshBuilder.ts';
import { BMAT, Facade } from './materials.ts';
import { blank, nx, nz, shadeHex, wx, wz, type Frame } from './geometry.ts';
import { prism } from './shell.ts';
import { LEDGE_JAMB, ledge, setFac } from './windows.ts';

/** Runs draw() with no building tag on mb and on the detail layer (lot ground, walls, gates, trees). */
export function untagged(mb: MeshBuilder, f: Frame, draw: () => void): void {
  const t = mb.curTag, d = f.out?.detail, td = d ? d.curTag : 0;
  mb.curTag = 0;
  if (d) d.curTag = 0;
  try { draw(); } finally { mb.curTag = t; if (d) d.curTag = td; }
}

/** The polygon of the lot being generated, in its frame (null = a rectangle lot), and what its walls look like. */
let lotPoly: Array<[number, number]> | null = null;
let polyGrid: YardGrid | null = null;
/** Lot wall styles the generator asked for ([height, thickness, colour]): on the street front and elsewhere. */
let fenceFront: [number, number, number] | null = null, fenceBack: [number, number, number] | null = null;
/** The gate the generator put on the front ([x0, x1, z] in the frame), when it stands on the polygon's outline. */
let gateAt: [number, number, number] | null = null;

export function beginLot(poly: Array<[number, number]> | null): void {
  lotPoly = poly; polyGrid = null; fenceFront = fenceBack = null; gateAt = null;
}

export function endLot(): void { lotPoly = null; }

/** A straight wall between two local points, following the ground. */
/** wall, without the building's tag (it is the lot's, not the building's: the inside view's cut leaves it). */
export function wall(...a: Parameters<typeof wallTagged>): void { untagged(a[0], a[2], () => wallTagged(...a)); }
function wallTagged(mb: MeshBuilder, heights: Float32Array, f: Frame, ax: number, az: number, bx: number, bz: number, h: number, t: number, col: number, mat: number = BMAT.Fence): void {
  const len = Math.hypot(bx - ax, bz - az);
  const n = Math.max(1, Math.ceil(len / 6));
  const dx = (bx - ax) / len, dz = (bz - az) / len;
  for (let i = 0; i < n; i++) {
    const s0 = (len * i) / n, s1 = (len * (i + 1)) / n;
    const mx = ax + dx * (s0 + s1) / 2, mz = az + dz * (s0 + s1) / 2;
    const gy = heightAt(heights, wx(f, mx, mz), wz(f, mx, mz));
    const g: Frame = f;
    // a thin box along the wall, in local coordinates
    const half = (s1 - s0) / 2;
    const px = -dz * t / 2, pz = dx * t / 2;
    const c0x = mx - dx * half, c0z = mz - dz * half, c1x = mx + dx * half, c1z = mz + dz * half;
    const quadSide = (sx: number, sz: number, ex: number, ez: number, nxL: number, nzL: number) => {
      const NX = nx(g, nxL, nzL), NZ = nz(g, nxL, nzL);
      const v0 = mb.vert(wx(g, sx, sz), gy - 0.4, wz(g, sx, sz), NX, 0, NZ, col, mat);
      const v1 = mb.vert(wx(g, ex, ez), gy - 0.4, wz(g, ex, ez), NX, 0, NZ, col, mat);
      const v2 = mb.vert(wx(g, ex, ez), gy + h, wz(g, ex, ez), NX, 0, NZ, col, mat);
      const v3 = mb.vert(wx(g, sx, sz), gy + h, wz(g, sx, sz), NX, 0, NZ, col, mat);
      mb.quad(v0, v1, v2, v3, NX, 0, NZ);
    };
    quadSide(c0x + px, c0z + pz, c1x + px, c1z + pz, -dz, dx);
    quadSide(c1x - px, c1z - pz, c0x - px, c0z - pz, dz, -dx);
    const top = [[c0x + px, c0z + pz], [c1x + px, c1z + pz], [c1x - px, c1z - pz], [c0x - px, c0z - pz]].map(([x, z]) => mb.vert(wx(g, x, z), gy + h, wz(g, x, z), 0, 1, 0, col, mat));
    mb.quad(top[0], top[1], top[2], top[3], 0, 1, 0);
  }
}

/** The relief grid of a lot's ground. */
interface YardGrid { NX: number; NZ: number; lxOf: (i: number) => number; lzOf: (j: number) => number; hAt: (i: number, j: number) => number; at: (lx: number, lz: number) => number }

export function yardGrid(heights: Float32Array, f: Frame, w: number, d: number): YardGrid {
  // a polygon lot: one grid over the polygon, whatever part of the lot asks
  if (lotPoly && polyGrid) return polyGrid;
  let gx0 = -w / 2, gx1 = w / 2, gz0 = -d / 2 + Math.min(0.5, d * 0.05), gz1 = d / 2;
  if (lotPoly) {
    gx0 = gz0 = Infinity; gx1 = gz1 = -Infinity;
    for (const [x, z] of lotPoly) { gx0 = Math.min(gx0, x); gx1 = Math.max(gx1, x); gz0 = Math.min(gz0, z); gz1 = Math.max(gz1, z); }
    d = gz1 - gz0;
  }
  const gw = gx1 - gx0, gd = gz1 - gz0;
  const NX = Math.max(2, Math.ceil(gw / 6)), NZ = Math.max(2, Math.ceil(d / 6));
  const lift = 0.18 + (hash2(Math.round(wx(f, 0, 0) * 4), Math.round(wz(f, 0, 0) * 4), 7) % 3) * 0.03;
  const lxOf = (i: number) => gx0 + (gw * i) / NX, lzOf = (j: number) => gz0 + (gd * j) / NZ;
  const hAt = (i: number, j: number) => { const X = wx(f, lxOf(i), lzOf(j)), Z = wz(f, lxOf(i), lzOf(j)); return heightAt(heights, X, Z) + lift; };
  /** Height of the lot's ground at the local point (by the grid, not the relief: what lies on top does not cross the ground). */
  const at = (lx: number, lz: number) => {
    const fi = Math.max(0, Math.min(NX - 1e-6, (lx - gx0) / gw * NX)), fj = Math.max(0, Math.min(NZ - 1e-6, (lz - gz0) / gd * NZ));
    const i = Math.floor(fi), j = Math.floor(fj), ti = fi - i, tj = fj - j;
    // the mesh's own triangle (the diagonal runs from (i, j) to (i + 1, j + 1))
    const h00 = hAt(i, j), h11 = hAt(i + 1, j + 1);
    return ti >= tj ? h00 + (hAt(i + 1, j) - h00) * ti + (h11 - hAt(i + 1, j)) * tj : h00 + (hAt(i, j + 1) - h00) * tj + (h11 - hAt(i, j + 1)) * ti;
  };
  const grid = { NX, NZ, lxOf, lzOf, hAt, at };
  if (lotPoly) polyGrid = grid;
  return grid;
}

/** The lot's ground (grass or paving) following the relief. */
/** yard, without the building's tag (it is the lot's, not the building's: the inside view's cut leaves it). */
export function yard(...a: Parameters<typeof yardTagged>): void { untagged(a[0], a[2], () => yardTagged(...a)); }
function yardTagged(mb: MeshBuilder, heights: Float32Array, f: Frame, w: number, d: number, col: number, mat: number): void {
  if (lotPoly) { polyYard(mb, heights, f, lotPoly, col, mat); return; }
  const { NX, NZ, lxOf, lzOf, hAt } = yardGrid(heights, f, w, d);
  const first = mb.v;
  for (let j = 0; j <= NZ; j++) for (let i = 0; i <= NX; i++) {
    const X = wx(f, lxOf(i), lzOf(j)), Z = wz(f, lxOf(i), lzOf(j));
    mb.vert(X, hAt(i, j), Z, 0, 1, 0, col, mat);
  }
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
    const a = first + j * (NX + 1) + i;
    mb.quad(a, a + 1, a + NX + 2, a + NX + 1, 0, 1, 0);
  }
}

/**
 * Entrance path (roadcraft `lotDoors`): paving from the gate at the lot's front to the door, 6 cm above the lot's ground
 * (by the ground's grid: on a slope the path does not cut through the grass).
 */
/** walkway, without the building's tag (it is the lot's, not the building's: the inside view's cut leaves it). */
export function walkway(...a: Parameters<typeof walkwayTagged>): void { untagged(a[0], a[2], () => walkwayTagged(...a)); }
function walkwayTagged(mb: MeshBuilder, heights: Float32Array, f: Frame, W: number, D: number, xa: number, za: number, xb: number, zb: number, width: number): void {
  const grid = yardGrid(heights, f, W, D);
  const len = Math.hypot(xb - xa, zb - za);
  if (len < 0.8) return;
  const n = Math.max(1, Math.ceil(len / 1.5));
  const px = -(zb - za) / len * width / 2, pz = (xb - xa) / len * width / 2;
  let prev: [number, number] | null = null;
  for (let k = 0; k <= n; k++) {
    const t = k / n, cx = xa + (xb - xa) * t, cz = za + (zb - za) * t;
    const v = [[cx + px, cz + pz], [cx - px, cz - pz]].map(([lx, lz]) => mb.vert(wx(f, lx, lz), grid.at(lx, lz) + 0.06, wz(f, lx, lz), 0, 1, 0, 0xb9b2a6, BMAT.Paving));
    if (prev) mb.quad(prev[0], prev[1], v[1], v[0], 0, 1, 0);
    prev = [v[0], v[1]];
  }
}

/** A wall on the lot's boundary: on a polygon lot only its style is kept, and the walls follow the polygon. */
export function lotWall(mb: MeshBuilder, heights: Float32Array, f: Frame, ax: number, az: number, bx: number, bz: number, h: number, t: number, col: number): void {
  if (!lotPoly) { wall(mb, heights, f, ax, az, bx, bz, h, t, col); return; }
  const front = Math.abs(az - bz) < 0.01 && az > 0;
  if (front) fenceFront ??= [h, t, col]; else fenceBack ??= [h, t, col];
}

/** The lot's gate: on a polygon lot only where it stands on the outline (the wall there leaves its gap). */
export function lotGate(mb: MeshBuilder, heights: Float32Array, f: Frame, ax: number, az: number, bx: number, bz: number, h: number): void {
  if (lotPoly) {
    const z = (az + bz) / 2, g0 = Math.min(ax, bx), g1 = Math.max(ax, bx);
    let onEdge = false;
    for (let k = 0; k < lotPoly.length; k++) {
      const [px, pz] = lotPoly[k], [qx, qz] = lotPoly[(k + 1) % lotPoly.length];
      if (Math.abs(pz - z) < 0.3 && Math.abs(qz - z) < 0.3 && Math.min(px, qx) <= g0 + 0.1 && Math.max(px, qx) >= g1 - 0.1) onEdge = true;
    }
    if (!onEdge) return;
    gateAt = [g0, g1, z];
  }
  gate(mb, heights, f, ax, az, bx, bz, h);
}

/** The lot's walls along the polygon: the front style on the edges that face the street, the other elsewhere. */
export function polyWalls(mb: MeshBuilder, heights: Float32Array, f: Frame): void {
  const p = lotPoly;
  if (!p || (!fenceFront && !fenceBack)) return;
  for (let k = 0; k < p.length; k++) {
    const [ax, az] = p[k], [bx, bz] = p[(k + 1) % p.length];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.3) continue;
    // outward normal of a counter-clockwise edge: (dz, −dx) / len
    const facesStreet = -(bx - ax) / len > 0.5;
    const st = (facesStreet ? fenceFront ?? fenceBack : fenceBack ?? fenceFront)!;
    const g = gateAt;
    if (g && facesStreet && Math.abs(az - g[2]) < 0.3 && Math.abs(bz - g[2]) < 0.3) {
      // the gate's gap (a front edge runs from right to left, counter-clockwise)
      const hi = Math.max(ax, bx), lo = Math.min(ax, bx);
      if (hi - g[1] > 0.2) wall(mb, heights, f, hi, az, g[1], az, st[0], st[1], st[2]);
      if (g[0] - lo > 0.2) wall(mb, heights, f, g[0], az, lo, az, st[0], st[1], st[2]);
      continue;
    }
    wall(mb, heights, f, ax, az, bx, bz, st[0], st[1], st[2]);
  }
}

/** Ear clipping of a simple counter-clockwise polygon: triangles as index triples. */
function earClip(p: Array<[number, number]>): number[] {
  const idx = p.map((_, k) => k), out: number[] = [];
  const cross = (a: number, b: number, c: number) => (p[b][0] - p[a][0]) * (p[c][1] - p[a][1]) - (p[b][1] - p[a][1]) * (p[c][0] - p[a][0]);
  let guard = 0;
  while (idx.length > 3 && guard++ < 1000) {
    let cut = false;
    for (let k = 0; k < idx.length; k++) {
      const a = idx[(k + idx.length - 1) % idx.length], b = idx[k], c = idx[(k + 1) % idx.length];
      if (cross(a, b, c) <= 1e-9) continue;
      let empty = true;
      for (const q of idx) {
        if (q === a || q === b || q === c) continue;
        if (cross(a, b, q) >= 0 && cross(b, c, q) >= 0 && cross(c, a, q) >= 0) { empty = false; break; }
      }
      if (!empty) continue;
      out.push(a, b, c); idx.splice(k, 1); cut = true; break;
    }
    if (!cut) break;
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}

/** A convex polygon clipped to the half-plane left of a → b (one Sutherland–Hodgman step). */
function clipLeft(poly: Array<[number, number]>, ax: number, az: number, bx: number, bz: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const side = (q: [number, number]) => (bx - ax) * (q[1] - az) - (bz - az) * (q[0] - ax);
  for (let k = 0; k < poly.length; k++) {
    const P = poly[k], Q = poly[(k + 1) % poly.length], sp = side(P), sq = side(Q);
    if (sp >= 0) out.push(P);
    if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); out.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]); }
  }
  return out;
}

/**
 * Lot ground over a polygon, on the same relief grid as the rest of the lot: each triangle of the polygon is cut by
 * each triangle of the grid, so every piece lies flat on the grid and nothing reaches past the outline.
 */
function polyYard(mb: MeshBuilder, heights: Float32Array, f: Frame, p: Array<[number, number]>, col: number, mat: number): void {
  const g = yardGrid(heights, f, 0, 0);
  const tris = earClip(p);
  for (let t = 0; t + 2 < tris.length; t += 3) {
    const T: Array<[number, number]> = [p[tris[t]], p[tris[t + 1]], p[tris[t + 2]]];
    const tx0 = Math.min(T[0][0], T[1][0], T[2][0]), tx1 = Math.max(T[0][0], T[1][0], T[2][0]);
    const tz0 = Math.min(T[0][1], T[1][1], T[2][1]), tz1 = Math.max(T[0][1], T[1][1], T[2][1]);
    for (let j = 0; j < g.NZ; j++) for (let i = 0; i < g.NX; i++) {
      const xa = g.lxOf(i), xb = g.lxOf(i + 1), za = g.lzOf(j), zb = g.lzOf(j + 1);
      if (xb < tx0 || xa > tx1 || zb < tz0 || za > tz1) continue;
      // the grid's two triangles, (i, j)(i+1, j)(i+1, j+1) and (i, j)(i+1, j+1)(i, j+1), counter-clockwise
      for (const G of [[[xa, za], [xb, za], [xb, zb]], [[xa, za], [xb, zb], [xa, zb]]] as Array<Array<[number, number]>>) {
        let piece = T;
        for (let e = 0; e < 3 && piece.length >= 3; e++) piece = clipLeft(piece, G[e][0], G[e][1], G[(e + 1) % 3][0], G[(e + 1) % 3][1]);
        if (piece.length < 3) continue;
        const v = piece.map(([lx, lz]) => mb.vert(wx(f, lx, lz), g.at(lx, lz), wz(f, lx, lz), 0, 1, 0, col, mat));
        for (let k = 1; k + 1 < v.length; k++) mb.tri(v[0], v[k], v[k + 1], 0, 1, 0);
      }
    }
  }
}

export function groundRange(heights: Float32Array, f: Frame, w: number, d: number): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const [a, b] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5], [0, 0]]) {
    const X = wx(f, a * w, b * d), Z = wz(f, a * w, b * d);
    const y = heightAt(heights, X, Z);
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  return [lo, hi];
}

/** The car park's paving and the bays' markings, following the relief. */
/** parkingLots, without the building's tag (it is the lot's, not the building's: the inside view's cut leaves it). */
export function parkingLots(...a: Parameters<typeof parkingLotsTagged>): void { untagged(a[0], a[2], () => parkingLotsTagged(...a)); }
function parkingLotsTagged(mb: MeshBuilder, heights: Float32Array, f: Frame, rows: number[]): void {
  blank(mb);
  for (let k = 0; k + 3 < rows.length; k += 4) {
    const ax = rows[k], az = rows[k + 1], bx = rows[k + 2], bz = rows[k + 3];
    const L = Math.hypot(bx - ax, bz - az), tx = (bx - ax) / L, tz = (bz - az) / L, px = -tz, pz = tx;
    const n = Math.floor(L / 2.5);
    // paving: 2.5 m strips (one per bay), 2.5 m to each side of the line
    const at = (s: number, o: number, lift: number, col: number, mat: number, nrmUp = true) => {
      const lx = ax + tx * s + px * o, lz = az + tz * s + pz * o;
      const X = wx(f, lx, lz), Z = wz(f, lx, lz);
      return mb.vert(X, heightAt(heights, X, Z) + lift, Z, 0, nrmUp ? 1 : 0, 0, col, mat);
    };
    for (let j = 0; j < n; j++) {
      const s0 = j * 2.5 + (L - n * 2.5) / 2, s1 = s0 + 2.5;
      mb.quad(at(s0, -2.6, 0.22, 0x5a5b5d, BMAT.Paving), at(s1, -2.6, 0.22, 0x5a5b5d, BMAT.Paving), at(s1, 2.6, 0.22, 0x5a5b5d, BMAT.Paving), at(s0, 2.6, 0.22, 0x5a5b5d, BMAT.Paving), 0, 1, 0);
    }
    for (let j = 0; j <= n; j++) {
      const s = j * 2.5 + (L - n * 2.5) / 2;
      // the marking 8 cm above the paving: on a slope the paving is straight between the corners and the relief under the marking curved
      mb.quad(at(s - 0.06, -2.4, 0.3, 0xe8e6df, BMAT.Plain), at(s + 0.06, -2.4, 0.3, 0xe8e6df, BMAT.Plain), at(s + 0.06, 2.4, 0.3, 0xe8e6df, BMAT.Plain), at(s - 0.06, 2.4, 0.3, 0xe8e6df, BMAT.Plain), 0, 1, 0);
    }
  }
}

export function legacyBox(mb: MeshBuilder, heights: Float32Array, b: BoxColumns, i: number, f: Frame): void {
  const [lo, hi] = groundRange(heights, f, b.w[i], b.d[i]);
  f.base = lo - 1.5;
  mb.curBase = f.base;
  mb.curBase = hi;
  setFac(mb, b.style[i], b.seed[i] || i, Facade.Punched, 3.1, 3.3);
  prism(mb, f, -b.w[i] / 2, b.w[i] / 2, -b.d[i] / 2, b.d[i] / 2, f.base, hi + b.h[i], b.color[i], BMAT.Wall, 3.1, shadeHex(b.color[i], 0.82), BMAT.RoofFlat);
}

/** An empty lot: only its boundary, a low concrete kerb around it (no building). */
export function emptyLot(mb: MeshBuilder, heights: Float32Array, W: number, D: number, f: Frame): void {
  const [lo, hi] = groundRange(heights, f, W, D);
  f.base = lo - 0.3;
  mb.curBase = f.base;
  blank(mb);
  const t = 0.25, y1 = hi + 0.3, col = 0xb9b4a8;
  if (lotPoly) {
    // the curb along the outline the player drew
    for (let k = 0; k < lotPoly.length; k++) {
      const [ax, az] = lotPoly[k], [bx, bz] = lotPoly[(k + 1) % lotPoly.length];
      if (Math.hypot(bx - ax, bz - az) > 0.3) wall(mb, heights, f, ax, az, bx, bz, 0.3, t, col, BMAT.Plain);
    }
    return;
  }
  prism(mb, f, -W / 2, W / 2, D / 2 - t, D / 2, f.base, y1, col, BMAT.Plain, 50, col, BMAT.Plain);
  prism(mb, f, -W / 2, W / 2, -D / 2, -D / 2 + t, f.base, y1, col, BMAT.Plain, 50, col, BMAT.Plain);
  prism(mb, f, -W / 2, -W / 2 + t, -D / 2, D / 2, f.base, y1, col, BMAT.Plain, 50, col, BMAT.Plain);
  prism(mb, f, W / 2 - t, W / 2, -D / 2, D / 2, f.base, y1, col, BMAT.Plain, 50, col, BMAT.Plain);
}

/** A patch of lot ground (paving, asphalt, grass) over the lot's ground grid, `lift` above it. */
/** groundPatch, without the building's tag (it is the lot's, not the building's: the inside view's cut leaves it). */
export function groundPatch(...a: Parameters<typeof groundPatchTagged>): void { untagged(a[0], a[2], () => groundPatchTagged(...a)); }
function groundPatchTagged(mb: MeshBuilder, heights: Float32Array, f: Frame, W: number, D: number, x0: number, x1: number, z0: number, z1: number, col: number, mat: number, lift: number): void {
  const grid = yardGrid(heights, f, W, D);
  const cx = (a: number) => Math.max(-W / 2, Math.min(W / 2, a)), cz = (a: number) => Math.max(-D / 2, Math.min(D / 2, a));
  x0 = cx(x0); x1 = cx(x1); z0 = cz(z0); z1 = cz(z1);
  if (x1 - x0 < 0.05 || z1 - z0 < 0.05) return;
  blank(mb);
  const nx2 = Math.max(1, Math.ceil((x1 - x0) / 6)), nz2 = Math.max(1, Math.ceil((z1 - z0) / 6));
  const first = mb.v;
  for (let j = 0; j <= nz2; j++) for (let i = 0; i <= nx2; i++) {
    const lx = x0 + (x1 - x0) * i / nx2, lz = z0 + (z1 - z0) * j / nz2;
    mb.vert(wx(f, lx, lz), grid.at(lx, lz) + lift, wz(f, lx, lz), 0, 1, 0, col, mat);
  }
  for (let j = 0; j < nz2; j++) for (let i = 0; i < nx2; i++) { const a = first + j * (nx2 + 1) + i; mb.quad(a, a + 1, a + nx2 + 2, a + nx2 + 1, 0, 1, 0); }
}

/** Gate of vertical bars between two local points along x (lot entrance). */
/** gate, without the building's tag (it is the lot's, not the building's: the inside view's cut leaves it). */
export function gate(...a: Parameters<typeof gateTagged>): void { untagged(a[0], a[2], () => gateTagged(...a)); }
function gateTagged(mb: MeshBuilder, heights: Float32Array, f: Frame, ax: number, az: number, bx: number, bz: number, h: number): void {
  blank(mb);
  const len = Math.hypot(bx - ax, bz - az);
  if (len < 0.5) return;
  const gy = heightAt(heights, wx(f, (ax + bx) / 2, (az + bz) / 2), wz(f, (ax + bx) / 2, (az + bz) / 2));
  const col = 0x3a3f43, x0 = Math.min(ax, bx), z = (az + bz) / 2;
  prism(mb, f, x0, x0 + len, z - 0.03, z + 0.03, gy + h - 0.06, gy + h, col, BMAT.Metal, 50, col, BMAT.Metal);
  prism(mb, f, x0, x0 + len, z - 0.03, z + 0.03, gy + 0.08, gy + 0.14, col, BMAT.Metal, 50, col, BMAT.Metal);
  // the bars in the detail layer (near): from afar the gate reads by its rails
  const dm = f.out?.detail;
  if (!dm) return;
  blank(dm);
  for (let u = 0.06; u < len; u += 0.14) ledge(dm, f, x0, z - 0.015, 1, 0, 0, 1, u - 0.015, u + 0.015, gy + 0.08, gy + h, 0.03, col, LEDGE_JAMB);
}

// The terrain cut along the edges of the roads laid on it, for a cell near the camera, in a worker (roadcraft 4.0
// render/terrainSeams.ts: the cells a road's edge crosses are cut along it, as a TIN takes a breakline — ESRI,
// "Breaklines in surface models", https://pro.arcgis.com/en/pro-app/latest/help/data/tin/breaklines-in-surface-models.htm).
//
// The terrain is a grid of 4 m cells (one per height sample, render/terrain.ts); a road's edge runs anywhere across
// them, and a 15 cm footway cannot be met by a grid that cannot bend there: the ground stood a step below the edge,
// or rose through the footway. Here, from the road's own drawn surfaces (the triangles of its lod 0 mesh that face up
// and lie on the ground, not a bridge's deck nor a tunnel's floor):
// - a 4 m cell the road covers is a hole: the terrain does not draw it (the road does);
// - a cell the road's edge crosses is a hole too, and its part off the road is drawn here: 0.5 m sub-squares, those
//   clear of the road whole (merged along a row), the ones the edge cuts cut on it — the cut found by bisection on
//   the road's own triangles (1.6 cm), its points at the road surface's height there less SEAM_BELOW, so the ground
//   meets the footway's edge on its height and never stands over it.
// The cut cell's ground is bilinear over its four corners (the height samples). A corner the road covers is under the
// road: the ground beside cannot take its height (the road's underside), so it takes the nearest uncovered corner's
// — one value per corner, the same in every cell that shares it, so two cut cells meet without a crack. On a side of
// the cut cell between two uncovered corners the ground is the terrain itself: the shader reads it from the height
// texture there, as the terrain draws its neighbouring cells (the packed position is quantised; the lattice
// coordinates snap in the shader). The `col` alpha says what each point is (POINT_*).

import { CELL_SIZE, HEIGHT_SPACING } from '../config.ts';
import type { PackedMesh } from '../shared/contracts/worker.ts';
import { heightAt } from '../world/heights.ts';
import { MeshBuilder } from './meshBuilder.ts';
import { RMAT } from './roadMesh.ts';

/** Sub-squares a side of a 4 m cell (0.5 m). */
export const SEAM_SUB = 8;
/** How far under the road's surface the ground meets its edge (m): never over it, never a visible step. */
export const SEAM_BELOW = 0.02;
/**
 * What a seam point is (`col` alpha): a point of the terrain itself (its height read from the height texture, both
 * coordinates snapped to the lattice), a point of the cut cell's own ground (its height given, both snapped), or a
 * point of the road's edge on a sub-square's side along x or along z (its height given, the lattice one snapped).
 */
export const POINT_GROUND = 1, POINT_EDGE_X = 2, POINT_EDGE_Z = 3, POINT_SET = 4;
/** A road surface this far over or under the ground (a bridge's deck, a tunnel's floor) does not cut it (m). */
const ON_GROUND = 1.2;
/** Cells a side of a road cell. */
export const SEAM_CELLS = CELL_SIZE / HEIGHT_SPACING;
/** Cells round a road cell whose corners' cover is read too (a covered corner takes the nearest uncovered one's). */
export const SEAM_PAD = 6;
const STEP = HEIGHT_SPACING / SEAM_SUB;
const BISECT = 5;

export interface TerrainSeams {
  /** The cut cells' parts off the road (null: none). */
  mesh: PackedMesh | null;
  /** Per 4 m cell of the road cell (row by row, SEAM_CELLS a side): 1 where the terrain does not draw its own cell. */
  holes: Uint8Array;
}

/**
 * The seams of the road cell at (originX, originZ) (CELL_SIZE a side, on the 4 m grid), from the lod 0 mesh of every
 * road reaching within SEAM_PAD cells of it (`buildRoadMesh`) and the heights the terrain draws.
 */
export function buildTerrainSeams(heights: Float32Array, road: PackedMesh | null, originX: number, originZ: number): TerrainSeams {
  const holes = new Uint8Array(SEAM_CELLS * SEAM_CELLS);
  if (!road) return { mesh: null, holes };
  // the road's surfaces on the ground, by the 4 m cell their box touches (this road cell's and SEAM_PAD round it)
  const W = SEAM_CELLS + 2 * SEAM_PAD, gx0 = originX - SEAM_PAD * HEIGHT_SPACING, gz0 = originZ - SEAM_PAD * HEIGHT_SPACING;
  const k = road.scale / 32767, P = road.position;
  const X = (i: number) => road.originX + P[i * 4] * k, Y = (i: number) => road.originY + P[i * 4 + 1] * k, Z = (i: number) => road.originZ + P[i * 4 + 2] * k;
  const tris: number[] = [];
  const bucket: number[][] = Array.from({ length: W * W }, () => []);
  for (let t = 0; t < road.index.length; t += 3) {
    const a = road.index[t], b = road.index[t + 1], c = road.index[t + 2];
    if ((road.color[a * 4 + 3] & 15) === RMAT.Zone) continue;
    const ax = X(a), az = Z(a), bx = X(b), bz = Z(b), cx = X(c), cz = Z(c);
    const ay = Y(a), by = Y(b), cy = Y(c);
    // facing up (walls, skirts and kerb faces are not a surface the ground meets from above)
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az, e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    if (Math.abs(ny) < 0.5 * Math.hypot(nx, ny, nz)) continue;
    const mx = (ax + bx + cx) / 3, mz = (az + bz + cz) / 3;
    if (Math.abs((ay + by + cy) / 3 - heightAt(heights, mx, mz)) > ON_GROUND) continue;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - gx0) / HEIGHT_SPACING)), i1 = Math.min(W - 1, Math.floor((Math.max(ax, bx, cx) - gx0) / HEIGHT_SPACING));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - gz0) / HEIGHT_SPACING)), j1 = Math.min(W - 1, Math.floor((Math.max(az, bz, cz) - gz0) / HEIGHT_SPACING));
    if (i0 > i1 || j0 > j1) continue;
    const id = tris.length / 9;
    tris.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) bucket[j * W + i].push(id);
  }
  if (tris.length === 0) return { mesh: null, holes };

  /** The road's surface height at (x, z) (NaN where the road does not cover it). */
  const surface = (x: number, z: number): number => {
    const i = Math.min(W - 1, Math.max(0, Math.floor((x - gx0) / HEIGHT_SPACING)));
    const j = Math.min(W - 1, Math.max(0, Math.floor((z - gz0) / HEIGHT_SPACING)));
    let best = NaN;
    for (const id of bucket[j * W + i]) {
      const o = id * 9;
      const ax = tris[o], az = tris[o + 2], bx = tris[o + 3], bz = tris[o + 5], cx = tris[o + 6], cz = tris[o + 8];
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-12) continue;
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      if (l1 < -1e-7 || l2 < -1e-7 || l1 + l2 > 1 + 1e-7) continue;
      const y = l1 * tris[o + 1] + l2 * tris[o + 4] + (1 - l1 - l2) * tris[o + 7];
      if (!(y <= best)) best = y;
    }
    return best;
  };

  // the 4 m corners (height samples), indexed over the padded grid: covered by the road or not, and the height a cut
  // cell's ground takes there
  const NC = W + 1;
  const covered = new Int8Array(NC * NC).fill(-1);
  const isCovered = (i: number, j: number): boolean => {
    const c = j * NC + i;
    if (covered[c] < 0) covered[c] = Number.isNaN(surface(gx0 + i * HEIGHT_SPACING, gz0 + j * HEIGHT_SPACING)) ? 0 : 1;
    return covered[c] === 1;
  };
  const sample = (i: number, j: number): number => heightAt(heights, gx0 + i * HEIGHT_SPACING, gz0 + j * HEIGHT_SPACING);
  const cornerMemo = new Float64Array(NC * NC).fill(NaN);
  const cornerH = (i: number, j: number): number => {
    const c = j * NC + i;
    if (!Number.isNaN(cornerMemo[c])) return cornerMemo[c];
    let h = sample(i, j);
    if (isCovered(i, j)) {
      // the nearest uncovered corner, ring by ring (ties: the first in row order)
      let best = Infinity;
      for (let r = 1; r <= SEAM_PAD && best === Infinity; r++) {
        for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= NC || jj >= NC || isCovered(ii, jj)) continue;
          const d = di * di + dj * dj;
          if (d < best) { best = d; h = sample(ii, jj); }
        }
      }
    }
    cornerMemo[c] = h;
    return h;
  };

  const mb = new MeshBuilder();
  const N = SEAM_SUB + 1;
  const cov = new Float64Array(N * N);
  for (let cj = 0; cj < SEAM_CELLS; cj++) for (let ci = 0; ci < SEAM_CELLS; ci++) {
    const bi = ci + SEAM_PAD, bj = cj + SEAM_PAD;
    if (bucket[bj * W + bi].length === 0) continue;
    const x0 = originX + ci * HEIGHT_SPACING, z0 = originZ + cj * HEIGHT_SPACING;
    let inside = 0;
    for (let b = 0; b < N; b++) for (let a = 0; a < N; a++) {
      const y = surface(x0 + a * STEP, z0 + b * STEP);
      cov[b * N + a] = y;
      if (!Number.isNaN(y)) inside++;
    }
    if (inside === 0) continue;
    holes[cj * SEAM_CELLS + ci] = 1;
    if (inside === N * N) continue;
    const isIn = (a: number, b: number) => !Number.isNaN(cov[b * N + a]);
    const h00 = cornerH(bi, bj), h10 = cornerH(bi + 1, bj), h01 = cornerH(bi, bj + 1), h11 = cornerH(bi + 1, bj + 1);
    // the cell's sides (z0, x1, z1, x0) that are the terrain's own: both their corners uncovered
    const own = [!isCovered(bi, bj) && !isCovered(bi + 1, bj), !isCovered(bi + 1, bj) && !isCovered(bi + 1, bj + 1),
      !isCovered(bi, bj + 1) && !isCovered(bi + 1, bj + 1), !isCovered(bi, bj) && !isCovered(bi, bj + 1)];
    /** The ground at sub-corner (a, b): the terrain's own on its own sides, the cut cell's bilinear elsewhere. */
    const ground = (a: number, b: number): number => {
      const x = x0 + a * STEP, z = z0 + b * STEP, u = a / SEAM_SUB, v = b / SEAM_SUB;
      const terrain = (b === 0 && own[0]) || (a === SEAM_SUB && own[1]) || (b === SEAM_SUB && own[2]) || (a === 0 && own[3]);
      const y = terrain ? heightAt(heights, x, z) : (h00 * (1 - u) + h10 * u) * (1 - v) + (h01 * (1 - u) + h11 * u) * v;
      return mb.vert(x, y, z, 0, 1, 0, 0, terrain ? POINT_GROUND : POINT_SET);
    };
    /** Where a sub-square's side from (a0, b0) to (a1, b1) leaves the road: bisected on the road's own triangles. */
    const edge = (a0: number, b0: number, a1: number, b1: number): number => {
      // lo: on the road (from the inside end), hi: off it
      const inFirst = isIn(a0, b0);
      let lo = 0, hi = 1, y = inFirst ? cov[b0 * N + a0] : cov[b1 * N + a1];
      for (let it = 0; it < BISECT; it++) {
        const m = (lo + hi) / 2, t = inFirst ? m : 1 - m;
        const s = surface(x0 + (a0 + (a1 - a0) * t) * STEP, z0 + (b0 + (b1 - b0) * t) * STEP);
        if (Number.isNaN(s)) hi = m; else { lo = m; y = s; }
      }
      const t = inFirst ? lo : 1 - lo;
      const x = x0 + (a0 + (a1 - a0) * t) * STEP, z = z0 + (b0 + (b1 - b0) * t) * STEP;
      return mb.vert(x, y - SEAM_BELOW, z, 0, 1, 0, 0, b0 === b1 ? POINT_EDGE_X : POINT_EDGE_Z);
    };
    for (let b = 0; b < SEAM_SUB; b++) {
      let run = -1;
      for (let a = 0; a <= SEAM_SUB; a++) {
        const clear = a < SEAM_SUB && !isIn(a, b) && !isIn(a + 1, b) && !isIn(a + 1, b + 1) && !isIn(a, b + 1);
        if (clear) { if (run < 0) run = a; continue; }
        // a run of sub-squares clear of the road: one quad (bilinear is linear along a row)
        if (run >= 0) {
          mb.quad(ground(run, b), ground(a, b), ground(a, b + 1), ground(run, b + 1), 0, 1, 0);
          run = -1;
        }
        if (a === SEAM_SUB) break;
        // a sub-square the edge cuts: round it, each corner off the road and the edge's point on each side it crosses
        const corners: Array<[number, number]> = [[a, b], [a + 1, b], [a + 1, b + 1], [a, b + 1]];
        const out = corners.map(([p, q]) => !isIn(p, q));
        if (!out.some(Boolean)) continue;
        const saddle = out[0] === out[2] && out[1] === out[3] && out[0] !== out[1];
        const pts: number[] = [], cornerV = [-1, -1, -1, -1], sideV = [-1, -1, -1, -1];
        for (let e = 0; e < 4; e++) {
          const [p, q] = corners[e], [p2, q2] = corners[(e + 1) & 3];
          if (out[e]) pts.push(cornerV[e] = ground(p, q));
          if (out[e] !== out[(e + 1) & 3]) pts.push(sideV[e] = edge(p, q, p2, q2));
        }
        // a saddle whose middle is on the road: two separate corners off it, each with the edge's points on its sides
        if (saddle && !Number.isNaN(surface(x0 + (a + 0.5) * STEP, z0 + (b + 0.5) * STEP))) {
          for (let e = 0; e < 4; e++) if (out[e]) mb.tri(sideV[(e + 3) & 3], cornerV[e], sideV[e], 0, 1, 0);
          continue;
        }
        // otherwise the part off the road is convex (a square less a corner cut off by a line, or two): a fan
        for (let s = 1; s + 1 < pts.length; s++) mb.tri(pts[0], pts[s], pts[s + 1], 0, 1, 0);
      }
    }
  }
  return { mesh: mb.pack(originX, originZ, CELL_SIZE), holes };
}

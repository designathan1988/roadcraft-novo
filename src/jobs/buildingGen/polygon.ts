// Polygon lots: the outline the player drew, the largest rectangle inside it and point tests. Pure functions of the
// building boxes; the generator's per-lot wall state stays in buildingGen.
import { SHAPE_SCALE, SHAPE_STRIDE, type BoxColumns } from '../../shared/contracts/worker.ts';

export interface LotFit { cx: number; cz: number; W: number; D: number; ox: number; oz: number; poly: Array<[number, number]> | null }

/** The polygon of a lot in its frame (metres, counter-clockwise), or null for a rectangle lot. */
export function lotPolygon(b: BoxColumns, i: number): Array<[number, number]> | null {
  const n = b.shapeN[i];
  if (n < 3) return null;
  const pts: Array<[number, number]> = [];
  for (let k = 0; k < n; k++) pts.push([b.shape[i * SHAPE_STRIDE + k * 2] / SHAPE_SCALE, b.shape[i * SHAPE_STRIDE + k * 2 + 1] / SHAPE_SCALE]);
  return pts;
}

export function lotFit(b: BoxColumns, i: number): LotFit {
  const pts = lotPolygon(b, i);
  if (!pts) return { cx: b.x[i], cz: b.z[i], W: b.w[i], D: b.d[i], ox: 0, oz: 0, poly: null };
  const [rx0, rx1, rz0, rz1] = inscribedRect(pts);
  const ox = (rx0 + rx1) / 2, oz = (rz0 + rz1) / 2, c = Math.cos(b.rot[i]), s = Math.sin(b.rot[i]);
  return { cx: b.x[i] + ox * c + oz * s, cz: b.z[i] - ox * s + oz * c, W: rx1 - rx0, D: rz1 - rz0, ox, oz, poly: pts.map(([x, z]) => [x - ox, z - oz] as [number, number]) };
}

/** Whether a point is inside a polygon or within `tol` of its outline. */
export function inPolygon(p: Array<[number, number]>, x: number, z: number, tol = 0): boolean {
  let inside = false;
  for (let k = 0, j = p.length - 1; k < p.length; j = k++) {
    const [ax, az] = p[j], [bx, bz] = p[k];
    if ((az > z) !== (bz > z) && x < ax + (z - az) * (bx - ax) / (bz - az)) inside = !inside;
    if (tol > 0) {
      const dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz;
      const t = L > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L)) : 0;
      if (Math.hypot(x - ax - t * dx, z - az - t * dz) <= tol) return true;
    }
  }
  return inside;
}

/**
 * Largest axis-aligned rectangle [x0, x1, z0, z1] inside a polygon (half-metre grid), scored by area and by how close
 * its front is to the lot's front (a building stands on the street, not 12 m behind a cut corner).
 */
function inscribedRect(p: Array<[number, number]>): [number, number, number, number] {
  const RES = 0.5;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of p) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const nx = Math.max(1, Math.round((x1 - x0) / RES)), nz = Math.max(1, Math.round((z1 - z0) / RES));
  // corner (i, j): x0 + i·RES, z1 − j·RES (row 0 = the front)
  const cin = new Uint8Array((nx + 1) * (nz + 1));
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) cin[j * (nx + 1) + i] = inPolygon(p, x0 + i * RES, z1 - j * RES, 0.02) ? 1 : 0;
  const h = new Int32Array(nx);
  let best = -1, out: [number, number, number, number] = [x0, x1, z0, z1];
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, ok = cin[a] && cin[a + 1] && cin[a + nx + 1] && cin[a + nx + 2];
      h[i] = ok ? h[i] + 1 : 0;
    }
    for (let i = 0; i < nx; i++) {
      const hh = h[i];
      if (!hh) continue;
      let l = i, r = i;
      while (l > 0 && h[l - 1] >= hh) l--;
      while (r < nx - 1 && h[r + 1] >= hh) r++;
      const gap = (j - hh + 1) * RES, score = (r - l + 1) * hh * Math.max(0.05, 1 - 0.03 * gap);
      if (score > best) { best = score; out = [x0 + l * RES, x0 + (r + 1) * RES, z1 - (j + 1) * RES, z1 - (j - hh + 1) * RES]; }
    }
  }
  return out;
}

// Pure geometry for the building generator: the lot frame, slim boxes, pitched roofs and shop awnings. No module
// state here; everything the caller needs is a parameter, so the shell/facade passes can move out next.

import type { MeshBuilder } from '../meshBuilder.ts';
import { BMAT } from './materials.ts';
import type { GenOutputs } from './outputs.ts';

interface Frame { cx: number; cz: number; c: number; s: number; base: number; out?: GenOutputs }
export type { Frame };

/** Local (x along the front, z towards the street) → world. */
function wx(f: Frame, lx: number, lz: number): number { return f.cx + lx * f.c + lz * f.s; }
function wz(f: Frame, lx: number, lz: number): number { return f.cz - lx * f.s + lz * f.c; }
/** Local normal → world. */
function nx(f: Frame, x: number, z: number): number { return x * f.c + z * f.s; }
function nz(f: Frame, x: number, z: number): number { return -x * f.s + z * f.c; }
export { wx, wz, nx, nz };

/** Parts of a frame: the top, the underside of the overhang, the inside walls. */
const FR_TOP = 1, FR_BOTTOM = 2, FR_INNER = 4;
export { FR_TOP, FR_BOTTOM, FR_INNER };

/** Blind wall (parapets, machine rooms, appliances). */
function blank(mb: MeshBuilder): void { mb.curFac[3] = 0; }
export { blank };

/** 4.0 copingOf (buildingMesh.ts:1288-1296): the trim, or aluminium where the trim is a strong colour. */
function copingOf(trim: number): number {
  const r = (trim >> 16) & 255, g = (trim >> 8) & 255, b = trim & 255, hi = Math.max(r, g, b), lo = Math.min(r, g, b);
  return hi > 0 && (hi - lo) / hi > 0.45 ? 0xb9bcbd : trim;
}
export { copingOf };

/** 4.0 GOURMET_OUT (buildingMesh.ts:201): how far a varanda gourmet's slab stands out. */
const GOURMET_OUT = 1.6;
/** 4.0 PARAPET_H, PARAPET_T (buildingMesh.ts:185-186). */
const PARAPET_H = 0.85, PARAPET_T = 0.25;
export { GOURMET_OUT, PARAPET_H, PARAPET_T };

/** 4.0 EAVES and ROOF_THICK (buildingMesh.ts:191-193): the overhang, and the roof's body read at the fascia. */
const EAVES = 0.45, ROOF_THICK = 0.18;
export { EAVES, ROOF_THICK };

function shadeHex(rgb: number, k: number): number {
  const r = Math.round(((rgb >> 16) & 255) * k), g = Math.round(((rgb >> 8) & 255) * k), b = Math.round((rgb & 255) * k);
  return (r << 16) | (g << 8) | b;
}
export { shadeHex };

/**
 * A pitched roof as the 4.0 draws it (buildingMesh.ts:3473-3541): the slopes over a 45 cm overhang, the roof's body
 * 18 cm thick (a fascia in the trim x 0.92 round the edge, the soffit under the overhang in the trim x 0.7), the ridge
 * capped by a rounded row of tiles; a hip roof's ends are slopes too (hips at 45°), a gable's ends are barge boards up
 * each rake over a wall-coloured gable triangle. The ridge runs along the longer side; `rise` is the ridge's height.
 */
function pitchedRoof(mb: MeshBuilder, f: Frame, x0: number, x1: number, z0: number, z1: number, y: number, rise: number,
  roofCol: number, trim: number, wallCol: number, hipped: boolean, alongX = x1 - x0 >= z1 - z0): void {
  if (!alongX) {
    // the ridge along z: the same roof in a frame turned a quarter (local x becomes z)
    const ang = Math.atan2(f.s, f.c) + Math.PI / 2;
    pitchedRoof(mb, { ...f, c: Math.cos(ang), s: Math.sin(ang) }, -z1, -z0, x0, x1, y, rise, roofCol, trim, wallCol, hipped, true);
    return;
  }
  const o = EAVES, T = ROOF_THICK;
  const span = z1 - z0, slope = rise / (span / 2);
  const eave = y - o * slope, ridge = y + rise, cm = (z0 + z1) / 2;
  const hipIn = hipped ? Math.min(span / 2, (x1 - x0) / 2) : 0;
  const r0 = x0 + hipIn, r1 = x1 - hipIn;
  const fascia = shadeHex(trim, 0.92), soffit = shadeHex(trim, 0.7), cap = shadeHex(roofCol, 0.85);
  type P3 = [number, number, number];
  /** A face (3 or 4 local points), its normal from its corners turned to the side of `hint`. */
  const face = (pts: P3[], col: number, mat: number, hint: P3): void => {
    const [a, b, c] = pts;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let n0 = uy * vz - uz * vy, n1 = uz * vx - ux * vz, n2 = ux * vy - uy * vx;
    const l = Math.hypot(n0, n1, n2);
    if (l < 1e-9) return;
    n0 /= l; n1 /= l; n2 /= l;
    if (n0 * hint[0] + n1 * hint[1] + n2 * hint[2] < 0) { n0 = -n0; n1 = -n1; n2 = -n2; }
    const N0 = nx(f, n0, n2), N2 = nz(f, n0, n2);
    const ids = pts.map((q) => mb.vert(wx(f, q[0], q[2]), q[1], wz(f, q[0], q[2]), N0, n1, N2, col, mat));
    if (ids.length === 3) mb.tri(ids[0], ids[1], ids[2], N0, n1, N2);
    else mb.quad(ids[0], ids[1], ids[2], ids[3], N0, n1, N2);
  };
  blank(mb);
  const RT = BMAT.RoofTile, PL = BMAT.Plain;
  // the two long slopes
  face([[x0 - o, eave, z1 + o], [x1 + o, eave, z1 + o], [r1, ridge, cm], [r0, ridge, cm]], roofCol, RT, [0, 1, 1]);
  face([[x1 + o, eave, z0 - o], [x0 - o, eave, z0 - o], [r0, ridge, cm], [r1, ridge, cm]], roofCol, RT, [0, 1, -1]);
  // far (level 1 and up) the slopes and the gables only: the body and the cap are under a pixel there (4.0 far level)
  const body = mb.lod === 0;
  // the body along the eaves: fascia and soffit
  if (body) for (const [ze, zw, sz] of [[z1 + o, z1, 1], [z0 - o, z0, -1]] as const) {
    face([[x0 - o, eave - T, ze], [x1 + o, eave - T, ze], [x1 + o, eave, ze], [x0 - o, eave, ze]], fascia, PL, [0, 0, sz]);
    face([[x0 - o, eave - T, ze], [x1 + o, eave - T, ze], [x1, y - T, zw], [x0, y - T, zw]], soffit, PL, [0, -1, 0]);
  }
  // the ridge cap: two narrow slopes over the ridge, 7 cm proud
  if (body && r1 > r0 + 1e-3) {
    const w = 0.14, lift = 0.07, lo = ridge - w * slope + 0.01;
    face([[r0, lo, cm + w], [r1, lo, cm + w], [r1, ridge + lift, cm], [r0, ridge + lift, cm]], cap, RT, [0, 1, 1]);
    face([[r1, lo, cm - w], [r0, lo, cm - w], [r0, ridge + lift, cm], [r1, ridge + lift, cm]], cap, RT, [0, 1, -1]);
  }
  if (hipped) {
    for (const [xe, xw, sx, rr] of [[x0 - o, x0, -1, r0], [x1 + o, x1, 1, r1]] as const) {
      face([[xe, eave, z0 - o], [xe, eave, z1 + o], [rr, ridge, cm]], roofCol, RT, [sx, 1, 0]);
      if (!body) continue;
      face([[xe, eave - T, z0 - o], [xe, eave - T, z1 + o], [xe, eave, z1 + o], [xe, eave, z0 - o]], fascia, PL, [sx, 0, 0]);
      face([[xe, eave - T, z0 - o], [xe, eave - T, z1 + o], [xw, y - T, z1], [xw, y - T, z0]], soffit, PL, [0, -1, 0]);
    }
  } else {
    for (const [xe, xw, sx] of [[x0 - o, x0, -1], [x1 + o, x1, 1]] as const) {
      // barge boards up each rake, their underside over the gable, the gable triangle in the wall's colour
      face([[xw, y, z0], [xw, y, z1], [xw, ridge, cm]], wallCol, PL, [sx, 0, 0]);
      if (!body) continue;
      face([[xe, eave - T, z0 - o], [xe, ridge - T, cm], [xe, ridge, cm], [xe, eave, z0 - o]], fascia, PL, [sx, 0, 0]);
      face([[xe, ridge - T, cm], [xe, eave - T, z1 + o], [xe, eave, z1 + o], [xe, ridge, cm]], fascia, PL, [sx, 0, 0]);
      face([[xe, eave - T, z0 - o], [xw, eave - T, z0 - o], [xw, ridge - T, cm], [xe, ridge - T, cm]], soffit, PL, [0, -1, 0]);
      face([[xe, ridge - T, cm], [xw, ridge - T, cm], [xw, eave - T, z1 + o], [xe, eave - T, z1 + o]], soffit, PL, [0, -1, 0]);
    }
  }
}
export { pitchedRoof };

/** A gable roof with its ridge along x (or z when !alongX): the 4.0's (pitchedRoof). */
function gable(mb: MeshBuilder, f: Frame, x0: number, x1: number, z0: number, z1: number, y: number, h: number,
  roofCol: number, wallCol: number, alongX: boolean, trim = 0xf4efe4): void {
  pitchedRoof(mb, f, x0, x1, z0, z1, y, h, roofCol, trim, wallCol, false, alongX);
}
export { gable };

/** Awning colours (roadcraft `procedural.ts`). */
const AWNINGS = [0xb8382e, 0x2f6b4f, 0x2f4f7a, 0xd9a43a, 0x6b3f6b, 0x3d3d3d, 0xc7652f, 0x1f5f6b, 0x8a2f3c, 0x3f7f8f, 0x5c6b2f, 0xd06d8a];
export { AWNINGS };

/**
 * Shop awning (roadcraft `kit.ts`): a slanted canvas from the wall (z, y) outwards and down, with a valance at the
 * front; top and bottom faces, triangular sides.
 */
function awning(mb: MeshBuilder, f: Frame, x0: number, x1: number, z: number, y: number, depth: number, drop: number, col: number): void {
  const P = (lx: number, ly: number, lz: number, n: [number, number, number], c: number) =>
    mb.vert(wx(f, lx, lz), ly, wz(f, lx, lz), nx(f, n[0], n[2]), n[1], nz(f, n[0], n[2]), c, BMAT.Plain);
  const l = Math.hypot(drop, depth), up: [number, number, number] = [0, depth / l, drop / l], dn: [number, number, number] = [0, -depth / l, -drop / l];
  const yF = y - drop, zF = z + depth;
  let a = P(x0, y, z, up, col), b = P(x1, y, z, up, col), c = P(x1, yF, zF, up, col), d = P(x0, yF, zF, up, col);
  mb.quad(a, b, c, d, nx(f, 0, up[2]), up[1], nz(f, 0, up[2]));
  const under = shadeHex(col, 0.7);
  a = P(x0, y, z, dn, under); b = P(x1, y, z, dn, under); c = P(x1, yF, zF, dn, under); d = P(x0, yF, zF, dn, under);
  mb.quad(a, b, c, d, nx(f, 0, dn[2]), dn[1], nz(f, 0, dn[2]));
  // valance: a 28 cm strip hanging from the front edge
  a = P(x0, yF, zF, [0, 0, 1], col); b = P(x1, yF, zF, [0, 0, 1], col); c = P(x1, yF - 0.28, zF, [0, 0, 1], col); d = P(x0, yF - 0.28, zF, [0, 0, 1], col);
  mb.quad(a, b, c, d, nx(f, 0, 1), 0, nz(f, 0, 1));
  for (const [xx, sx] of [[x0, -1], [x1, 1]] as Array<[number, number]>) {
    const t0 = P(xx, y, z, [sx, 0, 0], col), t1 = P(xx, yF, zF, [sx, 0, 0], col), t2 = P(xx, yF - 0.28, zF, [sx, 0, 0], col), t3 = P(xx, yF - 0.28, z, [sx, 0, 0], under);
    mb.tri(t0, t1, t2, nx(f, sx, 0), 0, nz(f, sx, 0));
    mb.tri(t0, t2, t3, nx(f, sx, 0), 0, nz(f, sx, 0));
  }
}
export { awning };

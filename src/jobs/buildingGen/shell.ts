// Shell drawing: slim prisms, frames and parapets, plus the repeated-part sink and the output captures. The caller's
// mesh, frame and GenOutputs are the whole context; no generator state lives here.

import { hash2 } from '../../core/rng.ts';
import type { MeshBuilder } from '../meshBuilder.ts';
import { BMAT, Facade } from './materials.ts';
import { FR_BOTTOM, FR_INNER, FR_TOP, blank, nx, nz, shadeHex, wx, wz, type Frame } from './geometry.ts';
import { CURTAIN_MULLIONS, LEDGE_JAMB, curtainFins, ledge, windowDetail } from './windows.ts';
import type { GenOutputs } from './outputs.ts';

/** Variantes de peça de fachada (mobiliário 8..15 no pool de props). */
export const PART = { WallAc: 8, RoofAc: 9, Vase: 10, Clothesline: 11, Dish: 12, Vent: 13, Chair: 14, Tank: 15 } as const;
/** Emite uma peça na posição local (lx, y, lz) com a frente para a normal local (nlx, nlz). */
export function part(f: Frame, variant: number, lx: number, y: number, lz: number, nlx: number, nlz: number, scale = 1, kind?: number): void {
  const emit = f.out?.part;
  if (!emit) return;
  emit(variant, wx(f, lx, lz), y, wz(f, lx, lz), Math.atan2(f.s, f.c) + Math.atan2(nlx, nlz), scale, kind);
}

/**
 * Footprints of what stands on each building's lot floor (walls, pools, courts, porches, garages, tree trunks) go to
 * `out.foot` (the parts pass): [centre x, centre z, half width, half depth, turn] × n, in the world.
 */
export function captureFoot(out: GenOutputs, f: Frame, x0: number, x1: number, z0: number, z1: number, y0: number): void {
  if (!out.foot || out.footI < 0 || y0 > out.footGround + 0.6) return;
  const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
  out.foot[out.footI].push(wx(f, mx, mz), wz(f, mx, mz), (x1 - x0) / 2, (z1 - z0) / 2, Math.atan2(f.s, f.c));
}

export function captureVolume(out: GenOutputs, mb: MeshBuilder, f: Frame, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, wallMat: number): void {
  const fc = mb.curFac, m = wallMat & 15;
  if (!out.layout || fc[3] === 0 || (m !== BMAT.Wall && m !== BMAT.Curtain && m !== BMAT.Metal) || y1 - y0 < 2) return;
  const fh = (fc[2] >> 3) / 10 + 2.5, mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
  out.layout.push({ cx: wx(f, mx, mz), cz: wz(f, mx, mz), hw: (x1 - x0) / 2, hd: (z1 - z0) / 2, rot: Math.atan2(f.s, f.c), y0, y1, base: mb.curBase, ground: fc[2] & Facade.ShopBit ? 4.4 : fh, fh });
}

/**
 * Prisma reto no espaço local: paredes com coordenada de fachada (u em
 * colunas, alinhadas a cada parede), topo opcional.
 */
export function prism(mb: MeshBuilder, f: Frame, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number,
  wallCol: number, wallMat: number, colW: number, top: number, topMat: number, bottom = false, skip = 0): void {
  const out = f.out;
  if (out?.layout) captureVolume(out, mb, f, x0, x1, z0, z1, y0, y1, wallMat);
  if (out?.foot) captureFoot(out, f, x0, x1, z0, z1, y0);
  const dm = out?.detail;
  if (dm && mb !== dm) {
    const fc = mb.curFac, kind = fc[2] & 3;
    if (opensWindows(fc, wallMat)) {
      windowDetail(dm, f, x0, x1, z0, z1, y0, y1, mb.curBase, (fc[2] & 4) !== 0, colW, (fc[2] >> 3) / 10 + 2.5, fc[0], fc[1], skip);
    } else if (fc[3] > 0 && kind === Facade.Curtain) curtainFins(dm, f, x0, x1, z0, z1, y0, y1, colW, skip, mb.curBase, (fc[2] >> 3) / 10 + 2.5, CURTAIN_MULLIONS[(fc[1] + fc[0] * 256) % 4]);
    return;
  }
  const corners: Array<[number, number]> = [[x0, z1], [x1, z1], [x1, z0], [x0, z0]]; // frente, direita, fundo, esquerda
  const normals: Array<[number, number]> = [[0, 1], [1, 0], [0, -1], [-1, 0]];
  const open = opensWindows(mb.curFac, wallMat), fac3 = mb.curFac[3];
  if (open) mb.curFac[3] |= 1;
  for (let k = 0; k < 4; k++) {
    // a side against a wall (skip bit k: 1 front, 2 right, 4 back, 8 left) is never seen
    if (skip & (1 << k)) continue;
    const [ax, az] = corners[k], [bx, bz] = corners[(k + 1) & 3];
    const len = Math.hypot(bx - ax, bz - az);
    const cols = Math.max(1, Math.round(len / colW));
    const [lnx, lnz] = normals[k];
    const NX = nx(f, lnx, lnz), NZ = nz(f, lnx, lnz);
    mb.curU = 0;
    const a = mb.vert(wx(f, ax, az), y0, wz(f, ax, az), NX, 0, NZ, wallCol, wallMat);
    const d = mb.vert(wx(f, ax, az), y1, wz(f, ax, az), NX, 0, NZ, wallCol, wallMat);
    mb.curU = cols;
    const b = mb.vert(wx(f, bx, bz), y0, wz(f, bx, bz), NX, 0, NZ, wallCol, wallMat);
    const c = mb.vert(wx(f, bx, bz), y1, wz(f, bx, bz), NX, 0, NZ, wallCol, wallMat);
    mb.quad(a, b, c, d, NX, 0, NZ);
  }
  mb.curU = 0;
  mb.curFac[3] = fac3;
  if (top >= 0) {
    const t = corners.map(([x, z]) => mb.vert(wx(f, x, z), y1, wz(f, x, z), 0, 1, 0, top, topMat));
    mb.quad(t[0], t[1], t[2], t[3], 0, 1, 0);
  }
  if (bottom) {
    const t = corners.map(([x, z]) => mb.vert(wx(f, x, z), y0, wz(f, x, z), 0, -1, 0, wallCol, wallMat));
    mb.quad(t[0], t[1], t[2], t[3], 0, -1, 0);
  }
}

/**
 * A rectangular frame from y0 to y1: the band between the outer rectangle (`out` past x0..x1 × z0..z1) and the inner
 * one (`inset` inside it). The outer walls always; the top, the underside of the overhang and the inner walls (a band
 * that rises above a roof) by `parts`. Never a lid: whatever lies inside the inner rectangle stays in view.
 */
export function frame(mb: MeshBuilder, f: Frame, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number,
  out: number, inset: number, col: number, mat: number, parts: number, innerCol = col): void {
  prism(mb, f, x0 - out, x1 + out, z0 - out, z1 + out, y0, y1, col, mat, 50, -1, 0);
  const dm = f.out?.detail;
  if ((dm && mb !== dm) || !parts) return;
  const ix = Math.min(inset, (x1 - x0) / 2 - 0.01), iz = Math.min(inset, (z1 - z0) / 2 - 0.01);
  const o: Array<[number, number]> = [[x0 - out, z1 + out], [x1 + out, z1 + out], [x1 + out, z0 - out], [x0 - out, z0 - out]];
  const i: Array<[number, number]> = [[x0 + ix, z1 - iz], [x1 - ix, z1 - iz], [x1 - ix, z0 + iz], [x0 + ix, z0 + iz]];
  const inN: Array<[number, number]> = [[0, -1], [-1, 0], [0, 1], [1, 0]];
  const V = (q: [number, number], y: number, n0: number, n1: number, n2: number, c: number) => mb.vert(wx(f, q[0], q[1]), y, wz(f, q[0], q[1]), n0, n1, n2, c, mat);
  for (let k = 0; k < 4; k++) {
    const k1 = (k + 1) & 3;
    if (parts & FR_TOP) mb.quad(V(o[k], y1, 0, 1, 0, col), V(o[k1], y1, 0, 1, 0, col), V(i[k1], y1, 0, 1, 0, col), V(i[k], y1, 0, 1, 0, col), 0, 1, 0);
    if (parts & FR_BOTTOM) mb.quad(V(o[k], y0, 0, -1, 0, col), V(o[k1], y0, 0, -1, 0, col), V(i[k1], y0, 0, -1, 0, col), V(i[k], y0, 0, -1, 0, col), 0, -1, 0);
    if (!(parts & FR_INNER)) continue;
    const NX = nx(f, inN[k][0], inN[k][1]), NZ = nz(f, inN[k][0], inN[k][1]);
    mb.quad(V(i[k], y0, NX, 0, NZ, innerCol), V(i[k1], y0, NX, 0, NZ, innerCol), V(i[k1], y1, NX, 0, NZ, innerCol), V(i[k], y1, NX, 0, NZ, innerCol), NX, 0, NZ);
  }
}

/**
 * Parapet: a low wall round the slab, its inside face and a concrete coping on top (frames: the roof stays in view).
 * Far (level 1) the 8 cm coping is under a pixel: the wall gets a plain top instead.
 */
export function parapet(mb: MeshBuilder, f: Frame, x0: number, x1: number, z0: number, z1: number, y: number, h: number, t: number, col: number,
  inner = shadeHex(col, 0.85), coping = 0xd6d3cc): void {
  if (mb.lod > 0) { frame(mb, f, x0, x1, z0, z1, y, y + h, 0, t, col, BMAT.Plain, FR_TOP | FR_INNER, inner); return; }
  // the wall (its top hidden under the coping), then the coping: 6 cm, 5 cm proud on both sides so the rain drips clear
  // (4.0 buildingMesh.ts:3458-3465)
  frame(mb, f, x0, x1, z0, z1, y, y + h - 0.06, 0, t, col, BMAT.Plain, FR_INNER, inner);
  frame(mb, f, x0, x1, z0, z1, y + h - 0.06, y + h, 0.05, t + 0.05, coping, BMAT.Plain, FR_TOP | FR_BOTTOM | FR_INNER);
}

/** Whether a wall with the current facade has its windows drawn open by the detail layer (and opens in the shader). */
export function opensWindows(fc: Uint8Array | number[], mat: number): boolean {
  return fc[3] > 0 && (fc[2] & 3) !== Facade.Curtain && ((mat & 15) === BMAT.Wall || (mat & 15) === BMAT.Metal);
}

/**
 * A band standing `out` proud round the volume (cornice, storey band, crown slab): only its outside, the top and the
 * underside of the overhang, and the inside face where it rises above a roof (`overRoof`). Never a lid over the roof.
 * Far (level 1) a band on the wall is just its outside, and a crown loses the underside.
 */
export function ring(mb: MeshBuilder, f: Frame, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, out: number, col: number, overRoof = true): void {
  blank(mb);
  const parts = overRoof ? FR_TOP | FR_INNER | (mb.lod > 0 ? 0 : FR_BOTTOM) : mb.lod > 0 ? 0 : FR_TOP | FR_BOTTOM;
  frame(mb, f, x0, x1, z0, z1, y0, y1, out, 0, col, BMAT.Plain, parts);
}

/** Pilares salientes na frente e no fundo, nas divisas das colunas. */
export function piers(mb: MeshBuilder, f: Frame, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, module: number, every: number, col: number): void {
  blank(mb);
  const cols = Math.max(1, Math.round((x1 - x0) / module));
  const cw = (x1 - x0) / cols;
  for (let c = 0; c <= cols; c += every) {
    const x = x0 + c * cw;
    prism(mb, f, x - 0.22, x + 0.22, z1 - 0.05, z1 + 0.32, y0, y1, col, BMAT.Plain, 50, col, BMAT.Plain);
    prism(mb, f, x - 0.22, x + 0.22, z0 - 0.32, z0 + 0.05, y0, y1, col, BMAT.Plain, 50, col, BMAT.Plain);
  }
}

/** Vida na sacada (peças do pool): vaso no canto, cadeira, varal; pelo hash da sacada (não usa o sorteio do prédio). */
export function balconyLife(f: Frame, seed: number, c: number, fl: number, x0: number, x1: number, z1: number, depth: number, y: number): void {
  if (!f.out?.part) return;
  const h = hash2(seed ^ 0x5ac, c * 131 + fl, 0x77);
  const k = h % 100;
  if (k < 28) part(f, PART.Vase, x1 - 0.35, y, z1 + depth - 0.35, 0, 1, 0.85 + ((h >>> 8) & 7) * 0.05);
  if (k >= 18 && k < 40) part(f, PART.Chair, x0 + 0.5 + ((h >>> 12) & 3) * 0.15, y, z1 + depth * 0.5, (h >>> 14) & 1 ? 1 : -1, 0.3);
  if (k >= 70 && k < 82 && x1 - x0 > 2) part(f, PART.Clothesline, (x0 + x1) / 2, y, z1 + depth * 0.45, 0, 1, Math.min(1.6, (x1 - x0 - 0.6) / 1.8));
}

/** Porta de entrada na parede z = z1 (local), centrada em x: marco, folha de madeira e, nos prédios, marquise. */
export function door(mb: MeshBuilder, f: Frame, x: number, z1: number, y: number, trim: number, canopy: boolean): void {
  blank(mb);
  const w = canopy ? 1.8 : 1.0, hgt = canopy ? 2.6 : 2.2;

  prism(mb, f, x - w / 2, x + w / 2, z1, z1 + 0.11, y, y + hgt, canopy ? 0x2f3438 : 0x5a3c26, canopy ? BMAT.Metal : BMAT.Plain, 50, -1, 0);
  if (canopy) prism(mb, f, x - w / 2 - 0.6, x + w / 2 + 0.6, z1, z1 + 1.3, y + hgt + 0.25, y + hgt + 0.45, 0xd8d6d0, BMAT.Plain, 50, 0xcfcdc6, BMAT.Plain, true);
  // the frame and the step in the detail layer (near)
  const dm = f.out?.detail;
  if (!dm) return;
  blank(dm);
  prism(dm, f, x - w / 2 - 0.12, x + w / 2 + 0.12, z1 - 0.02, z1 + 0.08, y - 0.05, y + hgt + 0.12, trim, BMAT.Plain, 50, trim, BMAT.Plain);
  prism(dm, f, x - w / 2 - 0.15, x + w / 2 + 0.15, z1, z1 + 0.45, y - 0.15, y + 0.04, 0xbdb7ab, BMAT.Paving, 50, 0xbdb7ab, BMAT.Paving);
}

/**
 * Guarda-corpo de metal ao longo de z (local), de x0 a x1, sobre a laje em y: corrimão, travessa de baixo e
 * montantes a cada ~1,2 m na malha; na camada de detalhe (perto), os balaústres a cada 12 cm.
 */
export function railing(mb: MeshBuilder, f: Frame, x0: number, x1: number, z: number, y: number, col: number): void {
  blank(mb);
  prism(mb, f, x0, x1, z - 0.06, z, y + 0.98, y + 1.05, col, BMAT.Metal, 50, col, BMAT.Metal);
  // the handrail in the mesh; the bottom rail, the posts and the balusters in the detail layer (near)
  const det = f.out?.detail;
  if (!det) return;
  blank(det);
  for (const x of [x0 + 0.03, x1 - 0.03]) prism(det, f, x - 0.03, x + 0.03, z - 0.06, z, y, y + 0.98, col, BMAT.Metal, 50, -1, 0);
  prism(det, f, x0, x1, z - 0.05, z - 0.01, y + 0.1, y + 0.15, col, BMAT.Metal, 50, col, BMAT.Metal);
  const n = Math.max(1, Math.round((x1 - x0) / 1.2));
  for (let k = 1; k < n; k++) { const x = x0 + 0.03 + (x1 - x0 - 0.06) * k / n; prism(det, f, x - 0.03, x + 0.03, z - 0.06, z, y, y + 0.98, col, BMAT.Metal, 50, -1, 0); }
  const m = Math.floor((x1 - x0) / 0.12);
  for (let k = 1; k < m; k++) {
    const x = x0 + (x1 - x0) * k / m;
    ledge(det, f, x0, z - 0.05, 1, 0, 0, 1, x - x0 - 0.012, x - x0 + 0.012, y + 0.15, y + 0.98, 0.024, col, LEDGE_JAMB);
  }
}

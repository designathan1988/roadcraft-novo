// Window openings and their 3D details (reveals, frames, sills, moulded surrounds) and curtain-wall fins. Pure facade
// drawing: no generator state; the caller's frame and builder are all the context.

import { ARCHES, facadeArch, facadeWindowTable } from '../../world/arch.ts';
import type { MeshBuilder } from '../meshBuilder.ts';
import { BMAT, Facade } from './materials.ts';
import { blank, nx, nz, shadeHex, wx, wz, type Frame } from './geometry.ts';

const WIN_TABLE = facadeWindowTable();

/**
 * Fachada dos próximos vértices: [estilo, semente, tipo | pé-direito, largura da coluna].
 * Tipo nos bits 0-2, pé-direito (2,5 a 5,6 m em décimos) nos bits 3-7; coluna 0 = parede cega.
 */
export function setFac(mb: MeshBuilder, style: number, seed: number, kind: number, colW: number, fh: number): void {
  const fhq = Math.max(0, Math.min(31, Math.round((fh - 2.5) * 10)));
  mb.curFac[0] = style; mb.curFac[1] = seed & 255; mb.curFac[2] = (kind & 7) | (fhq << 3); mb.curFac[3] = Math.min(127, Math.round(colW * 10)) * 2;
}

function mixHex(a: number, b: number, t: number): number {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/**
 * Janelas em 3D (camada de detalhe): peitoril saliente com a pingadeira e verga em cima de cada janela, nas
 * mesmas colunas e andares que o shader desenha (u em colunas por parede, andares a partir de y0, térreo de
 * loja com 4,4 m). Só a frente e as pontas de cada peça (o fundo encosta na parede).
 */
export function windowDetail(mb: MeshBuilder, f: Frame, x0: number, x1: number, z0: number, z1: number, wy0: number, wy1: number,
  base: number, shop: boolean, colW: number, fh: number, arch: number, seed = 0, skip = 0): void {
  const corners: Array<[number, number]> = [[x0, z1], [x1, z1], [x1, z0], [x0, z0]];
  const normals: Array<[number, number]> = [[0, 1], [1, 0], [0, -1], [-1, 0]];
  for (let k = 0; k < 4; k++) if (!(skip & (1 << k))) windowDetailWall(mb, f, corners[k][0], corners[k][1], corners[(k + 1) & 3][0], corners[(k + 1) & 3][1], normals[k][0], normals[k][1], wy0, wy1, base, shop, colW, fh, arch, seed);
}

/** The window pieces of one wall, from (ax, az) to (bx, bz) facing (nxl, nzl) (local), as windowDetail draws each side. */
export function windowDetailWall(mb: MeshBuilder, f: Frame, ax: number, az: number, bx: number, bz: number, nxl: number, nzl: number,
  wy0: number, wy1: number, base: number, shop: boolean, colW: number, fh: number, arch: number, seed = 0): void {
  const [ww, wLow, wHigh] = WIN_TABLE[arch] ?? WIN_TABLE[0];
  const style = facadeArch(arch);
  const trim = (ARCHES[style] ?? ARCHES[0]).trim;
  const bays = WIN_TABLE[arch]?.[3] ?? 0;
  const ground = shop ? 4.4 : 0;
  const y0 = base;
  // every row whose window overlaps the wall (the shader paints, and opens, the part inside it)
  const first = Math.max(0, Math.floor((wy0 - base - ground) / fh - wHigh + 1e-3) + 1);
  const rows = Math.ceil((wy1 - base - ground) / fh - wLow - 1e-3);
  if (rows <= first || colW <= 0.5) return;
  const len = Math.hypot(bx - ax, bz - az);
  if (len < 1e-3) return;
  const cols = Math.max(1, Math.round(len / colW)), cw = len / cols;
  const dx = (bx - ax) / len, dz = (bz - az) / len;
  // Roadcraft 4.0 emitBay: the reveals in the wall's shadow (trim x 0.68), the head's a little darker, the inner
  // sill in the trim; the frame 3 cm in front of the glass; the sill 7 cm proud with a drip under its front.
  const reveal = shadeHex(mixHex(0xe4dfd4, trim, 0.35), WIN_REVEAL_SHADE), head = shadeHex(reveal, 0.8), inner = shadeHex(mixHex(0xe4dfd4, trim, 0.35), 0.92);
  const sillCol = mixHex(0xe4dfd4, trim, 0.15);
  const frameCol = (ARCHES[style] ?? ARCHES[0]).trim;
  const molded = (ARCHES[style] ?? ARCHES[0]).frame, moldCol = mixHex(0xeeeae2, trim, 0.4);
  const D = WIN_REVEAL;
  const NX = nx(f, nxl, nzl), NZ = nz(f, nxl, nzl), TX = nx(f, dx, dz), TZ = nz(f, dx, dz);
  /** A point of the wall: u along it, o out of it (negative: into the opening), y up. */
  const P = (u: number, o: number): [number, number] => [ax + dx * u + nxl * o, az + dz * u + nzl * o];
  const V = (u: number, o: number, y: number, n0: number, n1: number, n2: number, col: number, mat: number) => { const q = P(u, o); return mb.vert(wx(f, q[0], q[1]), y, wz(f, q[0], q[1]), n0, n1, n2, col, mat); };
  for (let c = 0; c < cols; c++) {
    if ((bays & 4 && c % 3 === 1) || (bays & 8 && c % 3 !== 0)) continue; // the pattern's blank bays
    const a0 = (c + ww) * cw, a1 = (c + 1 - ww) * cw;
    for (let fl = first; fl < rows; fl++) {
      const yb0 = y0 + ground + (fl + wLow) * fh, yt0 = y0 + ground + (fl + wHigh) * fh;
      const yb = Math.max(yb0, wy0), yt = Math.min(yt0, wy1), cutB = yb > yb0, cutT = yt < yt0;
      if (yt - yb < 0.02) continue;
      blank(mb);
      // the reveals: the opening's sides, head and sill, from the wall's face D into it (the main wall opens here,
      // render/city.ts, where this layer is drawn)
      mb.quad(V(a0, 0, yb, TX, 0, TZ, reveal, BMAT.Plain), V(a0, -D, yb, TX, 0, TZ, reveal, BMAT.Plain), V(a0, -D, yt, TX, 0, TZ, reveal, BMAT.Plain), V(a0, 0, yt, TX, 0, TZ, reveal, BMAT.Plain), TX, 0, TZ);
      mb.quad(V(a1, 0, yb, -TX, 0, -TZ, reveal, BMAT.Plain), V(a1, -D, yb, -TX, 0, -TZ, reveal, BMAT.Plain), V(a1, -D, yt, -TX, 0, -TZ, reveal, BMAT.Plain), V(a1, 0, yt, -TX, 0, -TZ, reveal, BMAT.Plain), -TX, 0, -TZ);
      if (!cutT) mb.quad(V(a0, 0, yt, 0, -1, 0, head, BMAT.Plain), V(a1, 0, yt, 0, -1, 0, head, BMAT.Plain), V(a1, -D, yt, 0, -1, 0, head, BMAT.Plain), V(a0, -D, yt, 0, -1, 0, head, BMAT.Plain), 0, -1, 0);
      if (!cutB) mb.quad(V(a0, 0, yb, 0, 1, 0, inner, BMAT.Plain), V(a1, 0, yb, 0, 1, 0, inner, BMAT.Plain), V(a1, -D, yb, 0, 1, 0, inner, BMAT.Plain), V(a0, -D, yb, 0, 1, 0, inner, BMAT.Plain), 0, 1, 0);
      // the glass at the back of the opening, with the wall's facade: the shader draws the pane, the room behind it,
      // the blind or the curtain, and the light at night (material WinGlass: no painted recess on it)
      setFac(mb, arch, seed, shop ? Facade.ShopBit : Facade.Punched, colW, fh);
      mb.curBase = base;
      mb.curU = c + ww; const g0 = V(a0, -D, yb, NX, 0, NZ, 0x101418, BMAT.WinGlass), g3 = V(a0, -D, yt, NX, 0, NZ, 0x101418, BMAT.WinGlass);
      mb.curU = c + 1 - ww; const g1 = V(a1, -D, yb, NX, 0, NZ, 0x101418, BMAT.WinGlass), g2 = V(a1, -D, yt, NX, 0, NZ, 0x101418, BMAT.WinGlass);
      mb.quad(g0, g1, g2, g3, NX, 0, NZ);
      mb.curU = 0;
      blank(mb);
      // the frame: a bar round the pane 3 cm in front of it, a mullion in a wide pane, a transom in a tall one
      // 4.0 frame (kit.ts:239-257, buildingMesh.ts:1631): 6 cm deep in front of the pane, its bars 4.5 % of the
      // opening (the border with its inner sides, a mullion in the middle and a transom at 68 % of the height, 80 %
      // as thick), in the trim
      const tw = FRAME_BAR * (a1 - a0), th = FRAME_BAR * (yt0 - yb0), fo = -D;
      const bar = (u0: number, u1: number, ya: number, yb2: number, faces: number) => ledge(mb, f, ax, az, dx, dz, nxl, nzl, u0, u1, ya, yb2, 0.06, frameCol, faces, fo);
      bar(a0, a0 + tw, yb, yt, 1 | 8); bar(a1 - tw, a1, yb, yt, 1 | 8);
      if (!cutT) bar(a0 + tw, a1 - tw, yt - th, yt, 1 | 4);
      if (!cutB) bar(a0 + tw, a1 - tw, yb, yb + th, 1 | 2);
      { const m = (a0 + a1) / 2, h = tw * 0.4; bar(m - h, m + h, Math.max(yb, yb0 + th), Math.min(yt, yt0 - th), 1); }
      { const y = yb0 + (yt0 - yb0) * 0.68, h = th * 0.4; if (y - h > yb && y + h < yt) bar(a0 + tw, a1 - tw, y - h, y + h, 1); }
      // the sill: 7 cm out past the wall, 6 cm thick, with its drip
      if (!cutB && yb - y0 > 0.25) ledge(mb, f, ax, az, dx, dz, nxl, nzl, a0 - 0.07, a1 + 0.07, yb - 0.06, yb, 0.07, sillCol, LEDGE_SILL | 8);
      // a moulded surround in the styles that have one
      if (molded && !cutT && !cutB) {
        ledge(mb, f, ax, az, dx, dz, nxl, nzl, a0 - 0.12, a0, yb, yt + 0.12, 0.035, moldCol, LEDGE_JAMB);
        ledge(mb, f, ax, az, dx, dz, nxl, nzl, a1, a1 + 0.12, yb, yt + 0.12, 0.035, moldCol, LEDGE_JAMB);
        ledge(mb, f, ax, az, dx, dz, nxl, nzl, a0, a1, yt, yt + 0.12, 0.035, moldCol, LEDGE_HEAD | 2);
      }
    }
  }
}

/** Vidro inteiriço: montantes verticais (aletas de alumínio) entre os painéis, na altura toda da parede. */
export function curtainFins(mb: MeshBuilder, f: Frame, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, colW: number,
  skip: number, base: number, fh: number, col: number): void {
  // 4.0 curtain (facadeKit.ts:235-247): a fin 14 cm wide, 20 cm proud, at every bay's edge (the shader's mullions), a
  // transom half as proud at every slab, in the mullions' colour
  blank(mb);
  const corners: Array<[number, number]> = [[x0, z1], [x1, z1], [x1, z0], [x0, z0]];
  const normals: Array<[number, number]> = [[0, 1], [1, 0], [0, -1], [-1, 0]];
  for (let k = 0; k < 4; k++) {
    if (skip & (1 << k)) continue;
    const [ax, az] = corners[k], [bx, bz] = corners[(k + 1) & 3];
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.round(len / colW)), cw = len / n;
    const dx = (bx - ax) / len, dz = (bz - az) / len, [nl, ml] = normals[k];
    for (let c = 1; c < n; c++) ledge(mb, f, ax, az, dx, dz, nl, ml, c * cw - 0.07, c * cw + 0.07, y0, y1, 0.2, col, LEDGE_JAMB | 2);
    for (let y = base + Math.ceil((y0 - base) / fh + 1e-3) * fh; y < y1 - 0.1; y += fh) ledge(mb, f, ax, az, dx, dz, nl, ml, 0, len, y - 0.04, y + 0.04, 0.1, col, LEDGE_SILL);
  }
}

/** The 4.0 curtain walls' mullion colours (signature.ts:150-152), by the facade's seed as render/city.ts picks them. */
export const CURTAIN_MULLIONS = [0xd5dadd, 0x5a6168, 0xe8efee, 0xcfd6d3];

/** Faces de uma peça saliente: 1 frente, 2 topo, 4 base, 8 pontas. */
const LEDGE_ALL = 15, LEDGE_SILL = 1 | 2 | 4, LEDGE_HEAD = 1 | 4;
export const LEDGE_JAMB = 1 | 8;
/** 4.0 FRAME_BAR (kit.ts:240): a window frame's bar, as a share of the opening. */
export const FRAME_BAR = 0.045;
/** Depth of a window's opening (Roadcraft 4.0 REVEAL) and how much light its reveals keep (REVEAL_SHADE). */
export const WIN_REVEAL = 0.2, WIN_REVEAL_SHADE = 0.68;
/** Roadcraft 4.0 storey band and cornice (BAND_OUT, BAND_H, CORNICE_OUT) and plinth (PLINTH_GROW, PLINTH_MATERIAL). */
export const BAND_OUT = 0.07, BAND_H = 0.22, CORNICE_OUT = 0.16, PLINTH_GROW = 0.12, PLINTH_COL = 0x7f786d;

/** Peça saliente na parede: de u0 a u1 ao longo da parede, de y0 a y1, saindo `out` metros (faces escolhidas). */
export function ledge(mb: MeshBuilder, f: Frame, ax: number, az: number, dx: number, dz: number, nxl: number, nzl: number,
  u0: number, u1: number, y0: number, y1: number, out: number, col: number, faces = LEDGE_ALL, from = 0): void {
  // `from`: the piece stands out of a plane that far from the wall (into an opening when negative)
  const p = (u: number, o: number): [number, number] => [ax + dx * u + nxl * (from + o), az + dz * u + nzl * (from + o)];
  const W = (q: [number, number]) => [wx(f, q[0], q[1]), wz(f, q[0], q[1])];
  const [a0x, a0z] = W(p(u0, 0)), [b0x, b0z] = W(p(u1, 0)), [a1x, a1z] = W(p(u0, out)), [b1x, b1z] = W(p(u1, out));
  const NX = nx(f, nxl, nzl), NZ = nz(f, nxl, nzl), TX = nx(f, dx, dz), TZ = nz(f, dx, dz);
  let v: number[];
  // frente
  if (faces & 1) {
  v = [mb.vert(a1x, y0, a1z, NX, 0, NZ, col, BMAT.Plain), mb.vert(b1x, y0, b1z, NX, 0, NZ, col, BMAT.Plain), mb.vert(b1x, y1, b1z, NX, 0, NZ, col, BMAT.Plain), mb.vert(a1x, y1, a1z, NX, 0, NZ, col, BMAT.Plain)];
  mb.quad(v[0], v[1], v[2], v[3], NX, 0, NZ);
  }
  // topo
  if (faces & 2) {
  v = [mb.vert(a1x, y1, a1z, 0, 1, 0, col, BMAT.Plain), mb.vert(b1x, y1, b1z, 0, 1, 0, col, BMAT.Plain), mb.vert(b0x, y1, b0z, 0, 1, 0, col, BMAT.Plain), mb.vert(a0x, y1, a0z, 0, 1, 0, col, BMAT.Plain)];
  mb.quad(v[0], v[1], v[2], v[3], 0, 1, 0);
  }
  // base
  if (faces & 4) {
  v = [mb.vert(a0x, y0, a0z, 0, -1, 0, col, BMAT.Plain), mb.vert(b0x, y0, b0z, 0, -1, 0, col, BMAT.Plain), mb.vert(b1x, y0, b1z, 0, -1, 0, col, BMAT.Plain), mb.vert(a1x, y0, a1z, 0, -1, 0, col, BMAT.Plain)];
  mb.quad(v[0], v[1], v[2], v[3], 0, -1, 0);
  }
  if (!(faces & 8)) return;
  // pontas
  v = [mb.vert(a0x, y0, a0z, -TX, 0, -TZ, col, BMAT.Plain), mb.vert(a1x, y0, a1z, -TX, 0, -TZ, col, BMAT.Plain), mb.vert(a1x, y1, a1z, -TX, 0, -TZ, col, BMAT.Plain), mb.vert(a0x, y1, a0z, -TX, 0, -TZ, col, BMAT.Plain)];
  mb.quad(v[0], v[1], v[2], v[3], -TX, 0, -TZ);
  v = [mb.vert(b1x, y0, b1z, TX, 0, TZ, col, BMAT.Plain), mb.vert(b0x, y0, b0z, TX, 0, TZ, col, BMAT.Plain), mb.vert(b0x, y1, b0z, TX, 0, TZ, col, BMAT.Plain), mb.vert(b1x, y1, b1z, TX, 0, TZ, col, BMAT.Plain)];
  mb.quad(v[0], v[1], v[2], v[3], TX, 0, TZ);
}

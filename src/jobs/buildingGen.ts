// Gerador procedural de prédios (worker). Determinístico: lote + zona +
// andares + semente + estilo → sempre o mesmo prédio nesta versão do gerador.
// Casas com telhado e quintal, prédios de apartamento com sacadas, lojas,
// torres de escritório com pódio, galpões. Janelas e interiores ficam no
// shader (interior mapping); aqui só volumes, telhados, sacadas, muros.
// lod 0 = célula perto (tudo); 1 = célula longe (sem peças pequenas);
// 2 = ladrilho (sem platibandas); 3 = placa (só volumes e telhados).

import { Rng, hash2 } from '../core/rng.ts';
import { Zone } from '../roads/zones.ts';
import { heightAt } from '../world/heights.ts';
import { MeshBuilder } from './meshBuilder.ts';
import { ARCHES, ArchId, Balcony, Crown, Fn, Win, archWindowTable, chimneyOf, pickArch, type Arch } from '../world/arch.ts';
import type { BoxColumns, PackedMesh } from './protocol.ts';
import { CIVIC_DESIGNS, GEAR, decodeDesign, footprint, hasDesign, type Design } from '../world/design.ts';

export const GEN_VERSION = 14;
/** Camada de detalhe: para onde vão as peças 3D das janelas enquanto o gerador roda num descarte. */
let detailOut: MeshBuilder | null = null;
/** Lajes: manta clara, cimento, piche, cinza escuro, telhado verde. */
const ROOF_FLATS = [0x8f8b84, 0xa8a49b, 0x5d5f61, 0x77736c, 0x6f8a55, 0xb9b2a6];

/** Materiais dos prédios (canal alfa da cor). */
export const BMAT = { Wall: 0, RoofFlat: 1, RoofTile: 2, Curtain: 3, Plain: 4, Metal: 5, Paving: 6, Grass: 7, Fence: 8, Shop: 9 } as const;
/** Tipo de fachada (bits 0-1 do byte de tipo); bit 2 = térreo de loja. */
export const Facade = { Punched: 0, Curtain: 1, House: 2, Industrial: 3, ShopBit: 4 } as const;

const PLASTER = [0xece6da, 0xe3d6bd, 0xd9c7a6, 0xc9b79c, 0xb7b1a7, 0xdcd2c2, 0xe7d8c9, 0xc2c6c8, 0xd6c3a5, 0xefe9df, 0xc9a98a, 0xa9b4b8, 0xe2cfb4, 0xd0b48f];
const TILE = [0x9b4a32, 0x8a3f2b, 0x6e3b2c, 0x5a5d61, 0x7a4a36, 0xa65a3c];
const METAL = [0xb9bec2, 0x9aa4ab, 0xc7c2b8, 0x8f9aa0, 0xd0d3d4, 0x7f8b7a];

interface Frame { cx: number; cz: number; c: number; s: number; base: number }

/** Local (x ao longo da frente, z para a via) → mundo. */
function wx(f: Frame, lx: number, lz: number): number { return f.cx + lx * f.c + lz * f.s; }
function wz(f: Frame, lx: number, lz: number): number { return f.cz - lx * f.s + lz * f.c; }
/** Normal local → mundo. */
function nx(f: Frame, x: number, z: number): number { return x * f.c + z * f.s; }
function nz(f: Frame, x: number, z: number): number { return -x * f.s + z * f.c; }

/**
 * Prisma reto no espaço local: paredes com coordenada de fachada (u em
 * colunas, alinhadas a cada parede), topo opcional.
 */
function prism(mb: MeshBuilder, f: Frame, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number,
  wallCol: number, wallMat: number, colW: number, top: number, topMat: number, bottom = false): void {
  if (detailOut && mb !== detailOut) {
    const fc = mb.curFac, kind = fc[2] & 3;
    if (fc[3] > 0 && kind !== Facade.Curtain && (wallMat === BMAT.Wall || wallMat === BMAT.Metal)) {
      windowDetail(detailOut, f, x0, x1, z0, z1, y0, y1, mb.curBase, (fc[2] & 4) !== 0, colW, (fc[2] >> 3) / 10 + 2.5, fc[0]);
    } else if (fc[3] > 0 && kind === Facade.Curtain) curtainFins(detailOut, f, x0, x1, z0, z1, y0, y1, colW * 2);
    return;
  }
  const corners: Array<[number, number]> = [[x0, z1], [x1, z1], [x1, z0], [x0, z0]]; // frente, direita, fundo, esquerda
  const normals: Array<[number, number]> = [[0, 1], [1, 0], [0, -1], [-1, 0]];
  for (let k = 0; k < 4; k++) {
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
  if (top >= 0) {
    const t = corners.map(([x, z]) => mb.vert(wx(f, x, z), y1, wz(f, x, z), 0, 1, 0, top, topMat));
    mb.quad(t[0], t[1], t[2], t[3], 0, 1, 0);
  }
  if (bottom) {
    const t = corners.map(([x, z]) => mb.vert(wx(f, x, z), y0, wz(f, x, z), 0, -1, 0, wallCol, wallMat));
    mb.quad(t[0], t[1], t[2], t[3], 0, -1, 0);
  }
}

/** Platibanda: mureta em volta da laje, com face de dentro e topo (vista de cima não fura). */
function parapet(mb: MeshBuilder, f: Frame, x0: number, x1: number, z0: number, z1: number, y: number, h: number, t: number, col: number): void {
  prism(mb, f, x0, x1, z0, z1, y, y + h, col, BMAT.Plain, 50, -1, 0);
  const o: Array<[number, number]> = [[x0, z1], [x1, z1], [x1, z0], [x0, z0]];
  const i: Array<[number, number]> = [[x0 + t, z1 - t], [x1 - t, z1 - t], [x1 - t, z0 + t], [x0 + t, z0 + t]];
  const inN: Array<[number, number]> = [[0, -1], [-1, 0], [0, 1], [1, 0]];
  const inner = shadeHex(col, 0.85);
  for (let k = 0; k < 4; k++) {
    const [ax, az] = i[k], [bx, bz] = i[(k + 1) & 3];
    const NX = nx(f, inN[k][0], inN[k][1]), NZ = nz(f, inN[k][0], inN[k][1]);
    const a = mb.vert(wx(f, ax, az), y, wz(f, ax, az), NX, 0, NZ, inner, BMAT.Plain), b = mb.vert(wx(f, bx, bz), y, wz(f, bx, bz), NX, 0, NZ, inner, BMAT.Plain);
    const c = mb.vert(wx(f, bx, bz), y + h, wz(f, bx, bz), NX, 0, NZ, inner, BMAT.Plain), d = mb.vert(wx(f, ax, az), y + h, wz(f, ax, az), NX, 0, NZ, inner, BMAT.Plain);
    mb.quad(a, b, c, d, NX, 0, NZ);
    const [ox, oz] = o[k], [px, pz] = o[(k + 1) & 3];
    const e = mb.vert(wx(f, ox, oz), y + h, wz(f, ox, oz), 0, 1, 0, col, BMAT.Plain), g = mb.vert(wx(f, px, pz), y + h, wz(f, px, pz), 0, 1, 0, col, BMAT.Plain);
    const c2 = mb.vert(wx(f, bx, bz), y + h, wz(f, bx, bz), 0, 1, 0, col, BMAT.Plain), d2 = mb.vert(wx(f, ax, az), y + h, wz(f, ax, az), 0, 1, 0, col, BMAT.Plain);
    mb.quad(e, g, c2, d2, 0, 1, 0);
  }
}

/** Telhado de duas águas com cumeeira ao longo de x (ou z), beiral e oitões. */
function gable(mb: MeshBuilder, f: Frame, x0: number, x1: number, z0: number, z1: number, y: number, h: number,
  roofCol: number, wallCol: number, alongX: boolean): void {
  const o = 0.45; // beiral
  if (!alongX) {
    // gira o problema: cumeeira ao longo de z
    const g: Frame = { ...f, c: f.c * 0 + Math.cos(Math.atan2(f.s, f.c) + Math.PI / 2), s: Math.sin(Math.atan2(f.s, f.c) + Math.PI / 2) };
    // em g, x local vira z: troca os limites
    gable(mb, g, -z1, -z0, x0, x1, y, h, roofCol, wallCol, true);
    return;
  }
  const zm = (z0 + z1) / 2, half = (z1 - z0) / 2 + o;
  const slope = h / half;
  const yE = y - o * slope; // beiral um pouco abaixo
  const P = (lx: number, ly: number, lz: number, n: [number, number, number], col: number, mat: number) =>
    mb.vert(wx(f, lx, lz), ly, wz(f, lx, lz), nx(f, n[0], n[2]), n[1], nz(f, n[0], n[2]), col, mat);
  const nl = Math.hypot(1, slope);
  const nFront: [number, number, number] = [0, 1 / nl, slope / nl], nBack: [number, number, number] = [0, 1 / nl, -slope / nl];
  // água da frente e do fundo
  let a = P(x0 - o, yE, z1 + o, nFront, roofCol, BMAT.RoofTile), b = P(x1 + o, yE, z1 + o, nFront, roofCol, BMAT.RoofTile);
  let c = P(x1 + o, y + h, zm, nFront, roofCol, BMAT.RoofTile), d = P(x0 - o, y + h, zm, nFront, roofCol, BMAT.RoofTile);
  mb.quad(a, b, c, d, nx(f, 0, nFront[2]), nFront[1], nz(f, 0, nFront[2]));
  a = P(x1 + o, yE, z0 - o, nBack, roofCol, BMAT.RoofTile); b = P(x0 - o, yE, z0 - o, nBack, roofCol, BMAT.RoofTile);
  c = P(x0 - o, y + h, zm, nBack, roofCol, BMAT.RoofTile); d = P(x1 + o, y + h, zm, nBack, roofCol, BMAT.RoofTile);
  mb.quad(a, b, c, d, nx(f, 0, nBack[2]), nBack[1], nz(f, 0, nBack[2]));
  // oitões (triângulos de parede)
  for (const [xx, sx] of [[x0, -1], [x1, 1]] as Array<[number, number]>) {
    const n: [number, number, number] = [sx, 0, 0];
    const t0 = P(xx, y, z0, n, wallCol, BMAT.Plain), t1 = P(xx, y, z1, n, wallCol, BMAT.Plain), t2 = P(xx, y + h - o * 0, zm, n, wallCol, BMAT.Plain);
    mb.tri(t0, t1, t2, nx(f, sx, 0), 0, nz(f, sx, 0));
  }
  // forro do beiral (por baixo), para não ver através
  const u = [P(x0 - o, yE, z1 + o, [0, -1, 0], wallCol, BMAT.Plain), P(x1 + o, yE, z1 + o, [0, -1, 0], wallCol, BMAT.Plain),
    P(x1 + o, yE, z0 - o, [0, -1, 0], wallCol, BMAT.Plain), P(x0 - o, yE, z0 - o, [0, -1, 0], wallCol, BMAT.Plain)];
  mb.quad(u[0], u[1], u[2], u[3], 0, -1, 0);
}

/** Cores de toldo (roadcraft `procedural.ts`). */
const AWNINGS = [0xb8382e, 0x2f6b4f, 0x2f4f7a, 0xd9a43a, 0x6b3f6b, 0x3d3d3d, 0xc7652f, 0x1f5f6b, 0x8a2f3c, 0x3f7f8f, 0x5c6b2f, 0xd06d8a];

/**
 * Toldo de loja (roadcraft `kit.ts`): lona inclinada da parede (z, y) para fora e para baixo, com babado na
 * frente; faces de cima e de baixo, lados em triângulo.
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
  // babado: faixa de 28 cm pendurada na borda
  a = P(x0, yF, zF, [0, 0, 1], col); b = P(x1, yF, zF, [0, 0, 1], col); c = P(x1, yF - 0.28, zF, [0, 0, 1], col); d = P(x0, yF - 0.28, zF, [0, 0, 1], col);
  mb.quad(a, b, c, d, nx(f, 0, 1), 0, nz(f, 0, 1));
  for (const [xx, sx] of [[x0, -1], [x1, 1]] as Array<[number, number]>) {
    const t0 = P(xx, y, z, [sx, 0, 0], col), t1 = P(xx, yF, zF, [sx, 0, 0], col), t2 = P(xx, yF - 0.28, zF, [sx, 0, 0], col), t3 = P(xx, yF - 0.28, z, [sx, 0, 0], under);
    mb.tri(t0, t1, t2, nx(f, sx, 0), 0, nz(f, sx, 0));
    mb.tri(t0, t2, t3, nx(f, sx, 0), 0, nz(f, sx, 0));
  }
}

/** Muro reto entre dois pontos locais, acompanhando o chão. */
function wall(mb: MeshBuilder, heights: Float32Array, f: Frame, ax: number, az: number, bx: number, bz: number, h: number, t: number, col: number): void {
  const len = Math.hypot(bx - ax, bz - az);
  const n = Math.max(1, Math.ceil(len / 6));
  const dx = (bx - ax) / len, dz = (bz - az) / len;
  for (let i = 0; i < n; i++) {
    const s0 = (len * i) / n, s1 = (len * (i + 1)) / n;
    const mx = ax + dx * (s0 + s1) / 2, mz = az + dz * (s0 + s1) / 2;
    const gy = heightAt(heights, wx(f, mx, mz), wz(f, mx, mz));
    const g: Frame = f;
    // caixa fina ao longo do muro, em coordenadas locais
    const half = (s1 - s0) / 2;
    const px = -dz * t / 2, pz = dx * t / 2;
    const c0x = mx - dx * half, c0z = mz - dz * half, c1x = mx + dx * half, c1z = mz + dz * half;
    const quadSide = (sx: number, sz: number, ex: number, ez: number, nxL: number, nzL: number) => {
      const NX = nx(g, nxL, nzL), NZ = nz(g, nxL, nzL);
      const v0 = mb.vert(wx(g, sx, sz), gy - 0.4, wz(g, sx, sz), NX, 0, NZ, col, BMAT.Fence);
      const v1 = mb.vert(wx(g, ex, ez), gy - 0.4, wz(g, ex, ez), NX, 0, NZ, col, BMAT.Fence);
      const v2 = mb.vert(wx(g, ex, ez), gy + h, wz(g, ex, ez), NX, 0, NZ, col, BMAT.Fence);
      const v3 = mb.vert(wx(g, sx, sz), gy + h, wz(g, sx, sz), NX, 0, NZ, col, BMAT.Fence);
      mb.quad(v0, v1, v2, v3, NX, 0, NZ);
    };
    quadSide(c0x + px, c0z + pz, c1x + px, c1z + pz, -dz, dx);
    quadSide(c1x - px, c1z - pz, c0x - px, c0z - pz, dz, -dx);
    const top = [[c0x + px, c0z + pz], [c1x + px, c1z + pz], [c1x - px, c1z - pz], [c0x - px, c0z - pz]].map(([x, z]) => mb.vert(wx(g, x, z), gy + h, wz(g, x, z), 0, 1, 0, col, BMAT.Fence));
    mb.quad(top[0], top[1], top[2], top[3], 0, 1, 0);
  }
}

/**
 * Grade do chão do lote: passo de ~6 m (acompanha o relevo de 4 m sem afundar). Lotes vizinhos se sobrepõem um
 * pouco nos fundos e nas esquinas: o fundo recua 0,5 m e cada lote fica num de três níveis (3 cm entre eles, 4 passos
 * da quantização da malha): dois chãos no mesmo plano piscavam um sobre o outro.
 */
function yardGrid(heights: Float32Array, f: Frame, w: number, d: number) {
  const NX = Math.max(2, Math.ceil(w / 6)), NZ = Math.max(2, Math.ceil(d / 6));
  const lift = 0.18 + (hash2(Math.round(wx(f, 0, 0) * 4), Math.round(wz(f, 0, 0) * 4), 7) % 3) * 0.03;
  const back = Math.min(0.5, d * 0.05);
  const lxOf = (i: number) => -w / 2 + (w * i) / NX, lzOf = (j: number) => -d / 2 + back + ((d - back) * j) / NZ;
  const hAt = (i: number, j: number) => { const X = wx(f, lxOf(i), lzOf(j)), Z = wz(f, lxOf(i), lzOf(j)); return heightAt(heights, X, Z) + lift; };
  /** Altura do chão do lote no ponto local (pela grade, não pelo relevo: o que fica por cima não cruza o chão). */
  const at = (lx: number, lz: number) => {
    const fi = Math.max(0, Math.min(NX - 1e-6, (lx + w / 2) / w * NX)), fj = Math.max(0, Math.min(NZ - 1e-6, (lz - (-d / 2 + back)) / (d - back) * NZ));
    const i = Math.floor(fi), j = Math.floor(fj), ti = fi - i, tj = fj - j;
    // o mesmo triângulo da malha (a diagonal vai de (i, j) a (i + 1, j + 1))
    const h00 = hAt(i, j), h11 = hAt(i + 1, j + 1);
    return ti >= tj ? h00 + (hAt(i + 1, j) - h00) * ti + (h11 - hAt(i + 1, j)) * tj : h00 + (hAt(i, j + 1) - h00) * tj + (h11 - hAt(i, j + 1)) * ti;
  };
  return { NX, NZ, lxOf, lzOf, hAt, at };
}

/** Chão do lote (grama ou piso) acompanhando o relevo. */
function yard(mb: MeshBuilder, heights: Float32Array, f: Frame, w: number, d: number, col: number, mat: number): void {
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
 * Caminho de entrada (roadcraft `lotDoors`): piso do portão na frente do lote até a porta, 6 cm acima do chão do lote
 * (pela grade do chão: em declive o caminho não cruza a grama).
 */
function walkway(mb: MeshBuilder, heights: Float32Array, f: Frame, W: number, D: number, xa: number, za: number, xb: number, zb: number, width: number): void {
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

export function buildBuildings(heights: Float32Array, b: BoxColumns, originX: number, originZ: number, extent: number, lod: number): PackedMesh | null {
  const mb = new MeshBuilder(false, true);
  for (let i = 0; i < b.count; i++) {
    const rot = b.rot[i];
    const f: Frame = { cx: b.x[i], cz: b.z[i], c: Math.cos(rot), s: Math.sin(rot), base: 0 };
    const zone = b.zone[i];
    if (lod < 0 && (b.floors[i] === 0 || zone === 0)) continue;
    if (b.floors[i] === 0) { emptyLot(mb, heights, b.w[i], b.d[i], f); continue; }
    if (zone === 0) { legacyBox(mb, heights, b, i, f); continue; }
    const r = new Rng((b.seed[i] ^ (b.style[i] * 2654435761)) >>> 0);
    const W = b.w[i], D = b.d[i];
    const [lo, hi] = groundRange(heights, f, W, D);
    f.base = lo - 0.4;
    mb.curBase = f.base;
    const floors = Math.max(1, b.floors[i]);
    const arch = pickArch(zone, floors, b.x[i], b.z[i], b.style[i]);
    const g: Gen = { mb, heights, f, W, D, floors, arch, a: ARCHES[arch], r, hi, lod, seed: b.seed[i], zone, rows: lod <= 1 ? lotParking(b, i) : [] };
    if (lod < 0) {
      // camada de detalhe: o gerador roda inteiro num descarte (mesmo sorteio, mesmas medidas) e cada parede com
      // janelas desenhadas manda as peças 3D para a malha de verdade (prism → windowDetail)
      const sink = new MeshBuilder(false, true);
      sink.curBase = f.base;
      detailOut = mb;
      g.mb = sink; g.lod = 0;
    }
    if (hasDesign(b.color[i])) design(g, decodeDesign(b.color[i], b.h[i]));
    else if (b.fn[i] === Fn.Cemetery || b.fn[i] === Fn.Playground) openLot(g, b.fn[i]);
    else if (CIVIC_DESIGNS[b.fn[i]]) { const [ds, minF] = CIVIC_DESIGNS[b.fn[i]]; design({ ...g, floors: Math.max(minF, Math.min(floors, minF * 2)) }, ds); }
    else if (b.fn[i]) civic(g, b.fn[i]);
    else if (zone === Zone.Industrial) {
      warehouse(g.mb, heights, f, W, D, floors, arch, r, hi, g.lod);
      const ch = chimneyOf(b.seed[i], W, D, floors);
      if (ch) chimney(g.mb, f, ch[0], ch[1], f.base, hi + ch[2], g.lod);
    }
    else if (arch >= ArchId.ColonialHouse && arch <= ArchId.Sobrado) house(g);
    else if (zone === Zone.Commercial && floors >= 8) tower(g);
    else block(g);
    detailOut = null;
  }
  return mb.pack(originX, originZ, extent);
}

/**
 * Estacionamento do lote (prédio baixo de loja ou de apartamentos): fileiras de vagas de 2,5 × 5 m nos fundos e
 * nas laterais livres. Cada fileira = [ax, az, bx, bz] (linha do meio, local); a vaga se estende 2,5 m para cada lado
 * na perpendicular. A mesma conta no gerador (piso e faixas) e nas peças (carros), sem guardar nada.
 */
export function lotParking(b: BoxColumns, i: number): number[] {
  const zone = b.zone[i], floors = Math.max(1, b.floors[i]);
  if (b.floors[i] === 0 || zone === 0 || zone === Zone.Industrial || b.fn[i] || hasDesign(b.color[i])) return [];
  const arch = pickArch(zone, floors, b.x[i], b.z[i], b.style[i]);
  if (arch >= ArchId.ColonialHouse && arch <= ArchId.Sobrado) return [];
  if (zone === Zone.Commercial && floors >= 8) return [];
  const W = b.w[i], D = b.d[i], shop = zone === Zone.Commercial || zone === Zone.Mixed;
  const bw = Math.max(8, Math.min(W - (shop ? 0.6 : 3), 40)), bd = Math.max(8, Math.min(D - (shop ? 4 : 7), D > 42 ? 50 : 26));
  const out: number[] = [];
  const xL = -W / 2 + 0.8, xR = W / 2 - 0.8;
  // fundos: entre a divisa e o fundo do prédio (o mais recuado que o sorteio deixa)
  const back = D / 2 - (shop ? 0.4 : 4.5) - bd - 0.8, front = -D / 2 + 0.6;
  if (xR - xL >= 7.5) {
    if (back - front >= 16) out.push(xL, front + 2.5, xR, front + 2.5, xL, back - 2.5, xR, back - 2.5);
    else if (back - front >= 5.6) out.push(xL, front + 2.6, xR, front + 2.6);
  }
  // laterais: faixa entre a parede do prédio e a divisa
  const side = (W - bw) / 2 - 1.2;
  if (side >= 5.4 && D >= 12) {
    const z0 = Math.max(front, back + 0.8) + 0.4, z1 = D / 2 - 1.5;
    if (z1 - z0 >= 7.5) out.push(-W / 2 + 0.7 + 2.5, z0, -W / 2 + 0.7 + 2.5, z1, W / 2 - 0.7 - 2.5, z0, W / 2 - 0.7 - 2.5, z1);
  }
  return out;
}

/** Piso do estacionamento e as faixas das vagas, acompanhando o relevo. */
function parkingLots(mb: MeshBuilder, heights: Float32Array, f: Frame, rows: number[]): void {
  blank(mb);
  for (let k = 0; k + 3 < rows.length; k += 4) {
    const ax = rows[k], az = rows[k + 1], bx = rows[k + 2], bz = rows[k + 3];
    const L = Math.hypot(bx - ax, bz - az), tx = (bx - ax) / L, tz = (bz - az) / L, px = -tz, pz = tx;
    const n = Math.floor(L / 2.5);
    // piso: tiras de 2,5 m (uma por vaga), 2,5 m para cada lado da linha
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
      // faixa 8 cm acima do piso: em declive o piso é reto entre os cantos e o relevo sob a faixa, curvo
      mb.quad(at(s - 0.06, -2.4, 0.3, 0xe8e6df, BMAT.Plain), at(s + 0.06, -2.4, 0.3, 0xe8e6df, BMAT.Plain), at(s + 0.06, 2.4, 0.3, 0xe8e6df, BMAT.Plain), at(s - 0.06, 2.4, 0.3, 0xe8e6df, BMAT.Plain), 0, 1, 0);
    }
  }
}

/** Tudo o que um gerador de prédio precisa. */
interface Gen {
  mb: MeshBuilder; heights: Float32Array; f: Frame; W: number; D: number; floors: number;
  arch: number; a: Arch; r: Rng; hi: number; lod: number; seed: number; zone: number;
  /** Vagas do estacionamento (`lotParking`). */
  rows: number[];
}


/**
 * Fachada dos próximos vértices: [estilo, semente, tipo | pé-direito, largura da coluna].
 * Tipo nos bits 0-2, pé-direito (2,5 a 5,6 m em décimos) nos bits 3-7; coluna 0 = parede cega.
 */
function setFac(mb: MeshBuilder, style: number, seed: number, kind: number, colW: number, fh: number): void {
  const fhq = Math.max(0, Math.min(31, Math.round((fh - 2.5) * 10)));
  mb.curFac[0] = style; mb.curFac[1] = seed & 255; mb.curFac[2] = (kind & 7) | (fhq << 3); mb.curFac[3] = Math.min(255, Math.round(colW * 20));
}
/** Parede cega (platibandas, casas de máquinas, aparelhos). */
function blank(mb: MeshBuilder): void { mb.curFac[3] = 0; }

function legacyBox(mb: MeshBuilder, heights: Float32Array, b: BoxColumns, i: number, f: Frame): void {
  const [lo, hi] = groundRange(heights, f, b.w[i], b.d[i]);
  f.base = lo - 1.5;
  mb.curBase = f.base;
  mb.curBase = hi;
  setFac(mb, b.style[i], b.seed[i] || i, Facade.Punched, 3.1, 3.3);
  prism(mb, f, -b.w[i] / 2, b.w[i] / 2, -b.d[i] / 2, b.d[i] / 2, f.base, hi + b.h[i], b.color[i], BMAT.Wall, 3.1, shadeHex(b.color[i], 0.82), BMAT.RoofFlat);
}

/** Lote vazio: só a divisa, um meio-fio baixo de concreto em volta (sem prédio). */
function emptyLot(mb: MeshBuilder, heights: Float32Array, W: number, D: number, f: Frame): void {
  const [lo, hi] = groundRange(heights, f, W, D);
  f.base = lo - 0.3;
  mb.curBase = f.base;
  blank(mb);
  const t = 0.25, y1 = hi + 0.3, col = 0xb9b4a8;
  prism(mb, f, -W / 2, W / 2, D / 2 - t, D / 2, f.base, y1, col, BMAT.Plain, 50, col, BMAT.Plain);
  prism(mb, f, -W / 2, W / 2, -D / 2, -D / 2 + t, f.base, y1, col, BMAT.Plain, 50, col, BMAT.Plain);
  prism(mb, f, -W / 2, -W / 2 + t, -D / 2, D / 2, f.base, y1, col, BMAT.Plain, 50, col, BMAT.Plain);
  prism(mb, f, W / 2 - t, W / 2, -D / 2, D / 2, f.base, y1, col, BMAT.Plain, 50, col, BMAT.Plain);
}

/** Faixa saliente em volta do volume (cornija, faixa de andar, laje do coroamento). */
function ring(mb: MeshBuilder, f: Frame, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, out: number, col: number): void {
  blank(mb);
  prism(mb, f, x0 - out, x1 + out, z0 - out, z1 + out, y0, y1, col, BMAT.Plain, 50, col, BMAT.Plain, true);
}

/** Pilares salientes na frente e no fundo, nas divisas das colunas. */
function piers(mb: MeshBuilder, f: Frame, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, module: number, every: number, col: number): void {
  blank(mb);
  const cols = Math.max(1, Math.round((x1 - x0) / module));
  const cw = (x1 - x0) / cols;
  for (let c = 0; c <= cols; c += every) {
    const x = x0 + c * cw;
    prism(mb, f, x - 0.22, x + 0.22, z1 - 0.05, z1 + 0.32, y0, y1, col, BMAT.Plain, 50, col, BMAT.Plain);
    prism(mb, f, x - 0.22, x + 0.22, z0 - 0.32, z0 + 0.05, y0, y1, col, BMAT.Plain, 50, col, BMAT.Plain);
  }
}

/** Telhado de quatro águas com beiral (casas). */
function hip(mb: MeshBuilder, f: Frame, x0: number, x1: number, z0: number, z1: number, y: number, h: number, roofCol: number, soffit: number): void {
  const o = 0.6;
  const X0 = x0 - o, X1 = x1 + o, Z0 = z0 - o, Z1 = z1 + o;
  const w = X1 - X0, d = Z1 - Z0;
  const ridge = Math.max(0, (w - d) / 2), ridgeZ = Math.max(0, (d - w) / 2);
  const cx = (X0 + X1) / 2, cz = (Z0 + Z1) / 2;
  const yE = y - 0.25;
  const top = y + h;
  // cumeeira (ponto ou segmento ao longo do lado maior)
  const rA: [number, number] = [cx - ridge, cz - ridgeZ], rB: [number, number] = [cx + ridge, cz + ridgeZ];
  const P = (lx: number, ly: number, lz: number) => [wx(f, lx, lz), ly, wz(f, lx, lz)] as const;
  const face = (pts: Array<readonly [number, number, number]>) => {
    // normal pela regra da mão (para fora e para cima)
    const [a, b, c] = pts;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx2 = uy * vz - uz * vy, ny2 = uz * vx - ux * vz, nz2 = ux * vy - uy * vx;
    if (ny2 < 0) { nx2 = -nx2; ny2 = -ny2; nz2 = -nz2; }
    const ids = pts.map((p) => mb.vert(p[0], p[1], p[2], nx2, ny2, nz2, roofCol, BMAT.RoofTile));
    if (ids.length === 3) mb.tri(ids[0], ids[1], ids[2], nx2, ny2, nz2);
    else mb.quad(ids[0], ids[1], ids[2], ids[3], nx2, ny2, nz2);
  };
  const A = P(X0, yE, Z1), B = P(X1, yE, Z1), C = P(X1, yE, Z0), D = P(X0, yE, Z0);
  const RA = P(rA[0], top, rA[1]), RB = P(rB[0], top, rB[1]);
  if (w >= d) {
    face([A, B, RB, RA]); face([C, D, RA, RB]); face([B, C, RB]); face([D, A, RA]);
  } else {
    face([B, C, RB, RA]); face([D, A, RA, RB]); face([A, B, RA]); face([C, D, RB]);
  }
  // forro do beiral
  const u = [A, B, C, D].map((p) => mb.vert(p[0], p[1], p[2], 0, -1, 0, soffit, BMAT.Plain));
  mb.quad(u[0], u[1], u[2], u[3], 0, -1, 0);
}

/** Facha da (estilo, semente, tipo) para o volume principal. */
function facade(g: Gen, kind: number, colW: number, fh: number): void { setFac(g.mb, g.arch, g.seed, kind, colW, fh); }

function house(g: Gen): void {
  const { mb, heights, f, W, D, floors, a, r, hi, lod } = g;
  const wallCol = a.walls[r.int(0, a.walls.length)];
  const roofCol = TILE[r.int(0, TILE.length)];
  const sobrado = g.arch === ArchId.Sobrado;
  const modern = g.arch === ArchId.ModernHouse;
  // sobrado encosta nas divisas (geminado); os outros têm recuo e quintal
  const bw = sobrado ? Math.max(6, W - 0.4) : Math.min(W - 3, r.range(8, 12.5));
  const bd = Math.min(D - (sobrado ? 6 : 9), r.range(8, 13));
  const front = D / 2 - (sobrado ? r.range(1, 3) : r.range(4, 6.5));
  const off = sobrado ? 0 : r.range(-1, 1) * Math.max(0, (W - 3 - bw) / 2);
  const x0 = off - bw / 2, x1 = off + bw / 2, z1 = front, z0 = front - bd;
  const fh = a.floorH;
  const fl = sobrado ? Math.max(2, floors) : floors;
  const top = hi + 0.4 + fl * fh;
  mb.curBase = hi + 0.4;
  facade(g, Facade.House, a.module, fh);
  prism(mb, f, x0, x1, z0, z1, f.base, top, wallCol, BMAT.Wall, a.module, modern ? 0x8f8b84 : -1, BMAT.RoofFlat);
  // embasamento (rodapé de pedra) e soleira
  if (a.base >= 0 && lod < 2) { blank(mb); prism(mb, f, x0 - 0.05, x1 + 0.05, z0 - 0.05, z1 + 0.05, f.base, hi + 0.7, a.base, BMAT.Plain, 50, -1, 0); }
  if (modern) {
    // laje plana com beiral saliente e platibanda fina
    if (lod < 3) ring(mb, f, x0, x1, z0, z1, top, top + 0.35, 0.8, a.trim === 0x3a3f43 ? 0xe8e8e4 : a.trim);
    // segundo volume deslocado (casa em L)
    if (lod < 2 && r.next() < 0.6 && bd > 9) {
      facade(g, Facade.House, a.module, fh);
      // 5 cm para dentro da parede da casa: no mesmo plano as duas paredes piscavam
      const sx = r.next() < 0.5 ? x0 + 0.05 : x1 - 0.05 - bw * 0.45;
      prism(mb, f, sx, sx + bw * 0.45, z0 - 3, z0 + 2, f.base, hi + 0.4 + fh, shadeHex(wallCol, 0.85), BMAT.Wall, a.module, 0x8f8b84, BMAT.RoofFlat);
    }
  } else if (a.roof === 'hip') hip(mb, f, x0, x1, z0, z1, top, r.range(1.6, 2.6), roofCol, a.trim);
  else gable(mb, f, x0, x1, z0, z1, top, r.range(1.8, 3.0), roofCol, wallCol, bw >= bd);
  if (lod > 0) return;
  // varanda na frente (bangalô e casa colonial): laje, pilares e telhadinho
  if ((g.arch === ArchId.Bungalow || g.arch === ArchId.ColonialHouse) && D / 2 - z1 > 3.2) {
    const pw = Math.min(bw - 1, r.range(4, 7)), px0 = off - pw / 2 + r.range(-1, 1) * (bw - pw) / 2;
    blank(mb);
    prism(mb, f, px0, px0 + pw, z1, z1 + 2.4, f.base, hi + 0.55, 0xc9c3b8, BMAT.Plain, 50, 0xb8b0a2, BMAT.Paving);
    for (const cx of [px0 + 0.25, px0 + pw - 0.25]) prism(mb, f, cx - 0.12, cx + 0.12, z1 + 2.0, z1 + 2.24, hi + 0.55, hi + 0.4 + fh - 0.1, a.trim, BMAT.Plain, 50, a.trim, BMAT.Plain);
    prism(mb, f, px0 - 0.3, px0 + pw + 0.3, z1, z1 + 2.7, hi + 0.4 + fh - 0.1, hi + 0.4 + fh + 0.12, roofCol, BMAT.RoofTile, 50, roofCol, BMAT.RoofTile, true);
  }
  // sobrado: sacadinha no andar de cima
  if (sobrado && fl >= 2) {
    blank(mb);
    const y = hi + 0.4 + fh;
    prism(mb, f, x0 + bw * 0.25, x1 - bw * 0.25, z1, z1 + 0.9, y - 0.12, y, 0xd8d6d0, BMAT.Plain, 50, 0xcfcdc6, BMAT.Plain, true);
    prism(mb, f, x0 + bw * 0.25, x1 - bw * 0.25, z1 + 0.82, z1 + 0.9, y, y + 0.95, 0x2c3034, BMAT.Metal, 50, 0x2c3034, BMAT.Metal);
  }
  // garagem ao lado, quando cabe
  if (!sobrado && W - bw > 6.5 && r.next() < 0.7) {
    const gx0 = x1 + 0.2 > W / 2 - 3.2 ? x0 - 3.4 : x1 + 0.2, gx1 = gx0 + 3.2;
    if (gx0 > -W / 2 + 0.5 && gx1 < W / 2 - 0.5) {
      blank(mb);
      prism(mb, f, gx0, gx1, z1 - 6, z1 - 0.5, f.base, hi + 2.8, wallCol, BMAT.Plain, 3.2, 0x8c8c88, BMAT.RoofFlat);
    }
  }
  // caixa d'água no telhado
  if (!modern && r.next() < 0.5) { blank(mb); prism(mb, f, x0 + 1, x0 + 2.2, z0 + 1, z0 + 2.2, top, top + 1.4, 0x3d6aa0, BMAT.Plain, 50, 0x3d6aa0, BMAT.Plain); }
  // piscina no quintal dos fundos (como nas casas do roadcraft): borda clara e água
  const backD = z0 - 1.2 - (-D / 2 + 1.2);
  if (!sobrado && backD >= 4.2 && W >= 9 && r.next() < 0.45) {
    const pl = Math.min(W - 4, r.range(5, 8)), pd = Math.min(backD, r.range(3, 4.2));
    const pcx = r.range(-W / 2 + 2 + pl / 2, W / 2 - 2 - pl / 2), pcz = -D / 2 + 1.2 + backD / 2;
    const gy = heightAt(heights, wx(f, pcx, pcz), wz(f, pcx, pcz)) + 0.18;
    blank(mb);
    prism(mb, f, pcx - pl / 2 - 0.45, pcx + pl / 2 + 0.45, pcz - pd / 2 - 0.45, pcz + pd / 2 + 0.45, gy - 0.3, gy + 0.12, 0xe6e1d6, BMAT.Plain, 50, 0xe6e1d6, BMAT.Paving);
    // água 4 cm acima da borda (5 mm somem na quantização de 7,8 mm da malha e as duas superfícies piscavam)
    const P = (lx: number, lz: number) => mb.vert(wx(f, lx, lz), gy + 0.16, wz(f, lx, lz), 0, 1, 0, 0x52c0e0, BMAT.Plain);
    mb.quad(P(pcx - pl / 2, pcz + pd / 2), P(pcx + pl / 2, pcz + pd / 2), P(pcx + pl / 2, pcz - pd / 2), P(pcx - pl / 2, pcz - pd / 2), 0, 1, 0);
  }
  // quintal e muros
  yard(mb, heights, f, W, D, 0x587a3c, BMAT.Grass);
  const fence = PLASTER[r.int(0, PLASTER.length)];
  const gate = r.range(-W / 2 + 2, W / 2 - 5);
  // caminho do portão até a porta
  if (lod < 2) walkway(mb, heights, f, W, D, gate + 1.6, D / 2 - 0.25, Math.max(x0 + 0.9, Math.min(x1 - 0.9, gate + 1.6)), z1 + 0.1, 1.2);
  const fh2 = modern ? 1.8 : 1.0;
  wall(mb, heights, f, -W / 2, D / 2, gate, D / 2, fh2, 0.2, fence);
  wall(mb, heights, f, gate + 3.2, D / 2, W / 2, D / 2, fh2, 0.2, fence);
  if (!sobrado) {
    wall(mb, heights, f, -W / 2, -D / 2, -W / 2, D / 2, 1.8, 0.18, fence);
    wall(mb, heights, f, W / 2, -D / 2, W / 2, D / 2, 1.8, 0.18, fence);
  }
  wall(mb, heights, f, -W / 2, -D / 2, W / 2, -D / 2, 1.8, 0.18, fence);
}

/** Prédio de apartamentos ou de uso misto, na gramática do estilo. */
function block(g: Gen): void {
  const { mb, heights, f, W, D, floors, a, r, hi, lod, zone } = g;
  const shop = zone === Zone.Commercial || zone === Zone.Mixed;
  const wallCol = a.walls[r.int(0, a.walls.length)];
  const trim = a.trim;
  const fh = a.floorH;
  const groundH = shop ? 4.4 : fh;
  // lote fundo do centro: o prédio ocupa quase todo (até 50 m), sem gramado no miolo da quadra
  const bw = Math.max(8, Math.min(W - (shop ? 0.6 : 3), 40)), bd = Math.max(8, Math.min(D - (shop ? 4 : 7), D > 42 ? 50 : 26));
  const z1 = D / 2 - (shop ? 0.4 : r.range(2.5, 4.5)), z0 = z1 - bd;
  const x0 = -bw / 2, x1 = bw / 2;
  const y0 = hi + 0.2;
  const colW = a.module * r.range(0.92, 1.08);
  const kind = (a.win === Win.Ribbon ? Facade.Industrial : a.win === Win.Curtain ? Facade.Curtain : Facade.Punched) | (shop ? Facade.ShopBit : 0);
  // escalonamento no topo (art déco, contemporâneo, vidro) em prédios altos
  const steps = floors >= 8 ? a.setbacks : 0;
  const lower = steps ? floors - Math.min(floors - 3, steps * 2) : floors;
  const top = y0 + groundH + (lower - 1) * fh;
  mb.curBase = y0;
  facade(g, kind, colW, fh);
  // laje: manta clara, cimento, piche escuro ou telhado verde
  const roofC = ROOF_FLATS[r.int(0, ROOF_FLATS.length)];
  prism(mb, f, x0, x1, z0, z1, f.base, top, wallCol, BMAT.Wall, colW, roofC, roofC === 0x6f8a55 ? BMAT.Grass : BMAT.RoofFlat);
  let roofY = top, tx0 = x0, tx1 = x1, tz0 = z0, tz1 = z1;
  for (let s = 0; s < steps; s++) {
    const n = Math.min(2, floors - lower - s * 2);
    if (n <= 0) break;
    const k = 2.2 + s * 1.2;
    tx0 += k; tx1 -= k; tz0 += k * 0.7; tz1 -= k;
    if (tx1 - tx0 < 6 || tz1 - tz0 < 6) break;
    facade(g, kind & 3, colW, fh);
    prism(mb, f, tx0, tx1, tz0, tz1, roofY, roofY + n * fh, wallCol, BMAT.Wall, colW, roofC, roofC === 0x6f8a55 ? BMAT.Grass : BMAT.RoofFlat);
    if (lod < 2) { blank(mb); parapet(mb, f, tx0 - k, tx1 + k, tz0 - k * 0.7, tz1 + k, roofY, 1.0, 0.2, wallCol); }
    roofY += n * fh;
  }
  // base em pedra (térreo) quando o estilo tem
  if (a.base >= 0 && lod < 2) {
    facade(g, kind, colW, fh);
    prism(mb, f, x0 - 0.06, x1 + 0.06, z0 - 0.06, z1 + 0.06, f.base, y0 + Math.min(groundH, 1.1), a.base, BMAT.Plain, 50, -1, 0);
  }
  // coroamento
  if (lod < 2) {
    if (a.crown === Crown.Cornice) { ring(mb, f, tx0, tx1, tz0, tz1, roofY - 0.1, roofY + 0.45, 0.35, trim); parapet(mb, f, tx0, tx1, tz0, tz1, roofY + 0.45, 0.6, 0.25, wallCol); }
    else if (a.crown === Crown.Slab) ring(mb, f, tx0, tx1, tz0, tz1, roofY, roofY + 0.4, 0.9, shadeHex(wallCol, 0.92));
    else if (a.crown === Crown.Stepped) { parapet(mb, f, tx0, tx1, tz0, tz1, roofY, 1.6, 0.3, trim); ring(mb, f, (tx0 + tx1) / 2 - 2, (tx0 + tx1) / 2 + 2, tz1 - 1, tz1, roofY, roofY + 3.2, 0.1, trim); }
    else { blank(mb); parapet(mb, f, tx0, tx1, tz0, tz1, roofY, 1.0, 0.25, wallCol); }
  }
  if (lod > 1) return;
  // pilares e faixas de andar (relevo da fachada)
  if (a.piers) piers(mb, f, x0, x1, z0, z1, y0 + groundH, top, colW, a.piers, shadeHex(wallCol, 1.06));
  if (a.bands) for (let fl = 1; fl < lower; fl += a.bands) {
    const y = y0 + groundH + (fl - 1) * fh;
    ring(mb, f, x0, x1, z0, z1, y - 0.12, y + 0.08, 0.14, trim);
  }
  // lojas: toldo de lona por vão (ruas antigas, como no roadcraft) ou marquise de concreto (prédios modernos)
  if (shop) {
    blank(mb);
    const classic = g.arch === ArchId.Colonial || g.arch === ArchId.Brick || g.arch === ArchId.ArtDeco || g.arch === ArchId.Tropical || g.arch === ArchId.Modernist;
    if (classic && r.next() < 0.75) {
      const col = AWNINGS[r.int(0, AWNINGS.length)];
      const bays = Math.max(1, Math.round(bw / colW)), bwid = bw / bays;
      const yA = y0 + groundH - 0.25, depth = r.range(1.1, 1.5);
      // um toldo inteiro na largura da loja ou um por vão
      if (r.next() < 0.35) awning(mb, f, x0 + 0.2, x1 - 0.2, z1, yA, depth, depth * 0.62, col);
      else for (let k = 0; k < bays; k++) awning(mb, f, x0 + k * bwid + 0.18, x0 + (k + 1) * bwid - 0.18, z1, yA, depth, depth * 0.62, col);
    } else {
      prism(mb, f, x0 - 0.1, x1 + 0.1, z1, z1 + 1.6, y0 + groundH - 0.35, y0 + groundH - 0.1, trim === 0xf7f4ec ? 0xe8e4dc : 0x5a5f63, BMAT.Plain, 50, 0x8f8b84, BMAT.Plain, true);
    }
  }
  if (lod > 0) return;
  // sacadas
  if (zone !== Zone.Commercial && floors >= 2 && a.balcony !== Balcony.None) {
    const cols = Math.max(1, Math.round(bw / colW));
    const cw = bw / cols;
    const glassRail = a.balcony === Balcony.Continuous && r.next() < 0.6;
    const railCol = glassRail ? 0x8fb0c0 : r.next() < 0.5 ? 0xe8e8e4 : 0x2c3034;
    const depth = a.balcony === Balcony.Continuous ? 1.4 : 1.0;
    for (let fl = 1; fl < lower; fl++) {
      const y = y0 + groundH + (fl - 1) * fh;
      if (a.balcony === Balcony.Continuous) {
        blank(mb);
        prism(mb, f, x0, x1, z1, z1 + depth, y - 0.18, y, 0xe2e0da, BMAT.Plain, 50, 0xd6d3cc, BMAT.Plain, true);
        prism(mb, f, x0, x1, z1 + depth - 0.06, z1 + depth, y, y + 1.05, railCol, glassRail ? BMAT.Curtain : BMAT.Metal, 50, railCol, BMAT.Metal);
        // vasos/plantas no estilo tropical
        if (g.arch === ArchId.Tropical) for (let c = 0; c < cols; c += 2) prism(mb, f, x0 + c * cw + 0.3, x0 + c * cw + 1.1, z1 + 0.2, z1 + 0.9, y, y + 0.7, 0x4f7a34, BMAT.Grass, 50, 0x4f7a34, BMAT.Grass);
        continue;
      }
      for (let c = 0; c < cols; c++) {
        if (a.balcony === Balcony.Alternate && (c + fl) % 2 !== 0) continue;
        const cx0 = x0 + c * cw + cw * a.winSide * 0.6, cx1 = x0 + (c + 1) * cw - cw * a.winSide * 0.6;
        blank(mb);
        prism(mb, f, cx0, cx1, z1, z1 + depth, y - 0.15, y, 0xd8d6d0, BMAT.Plain, 50, 0xcfcdc6, BMAT.Plain, true);
        prism(mb, f, cx0, cx1, z1 + depth - 0.06, z1 + depth, y, y + 1.0, railCol, BMAT.Metal, 50, railCol, BMAT.Metal);
      }
    }
  }
  // ar-condicionado pendurado sob algumas janelas da frente (prédios de janelas soltas, perto da câmera)
  if (a.win !== Win.Curtain && lower >= 2) {
    blank(mb);
    const cols = Math.max(1, Math.round(bw / colW));
    const n = r.int(1, Math.min(7, cols * (lower - 1) / 3 + 2));
    for (let k = 0; k < n; k++) {
      const c = r.int(0, cols), fl = r.int(1, lower);
      const cx = x0 + (c + 0.5) * (bw / cols) + r.range(-0.3, 0.3);
      const y = y0 + groundH + (fl - 1) * fh + fh * 0.12;
      prism(mb, f, cx - 0.4, cx + 0.4, z1, z1 + 0.45, y, y + 0.5, 0xd9dad6, BMAT.Metal, 50, 0xc9cac6, BMAT.Metal);
    }
  }
  // telhado: casa de máquinas, caixa d'água, aparelhos, antena
  blank(mb);
  const mx = r.range(tx0 + 2, Math.max(tx0 + 2.1, tx1 - 6));
  prism(mb, f, mx, mx + 4, tz0 + 2, tz0 + 6, roofY, roofY + 3.0, 0xb8b4ab, BMAT.Plain, 50, 0x8f8b84, BMAT.RoofFlat);
  if (r.next() < 0.8) prism(mb, f, mx + 0.5, mx + 3.5, tz0 + 2.5, tz0 + 5.5, roofY + 3.0, roofY + 4.4, 0x6d7478, BMAT.Plain, 50, 0x6d7478, BMAT.RoofFlat);
  for (let k = 0; k < r.int(1, 5); k++) {
    const ax = r.range(tx0 + 1, tx1 - 2), az = r.range(tz0 + 1, tz1 - 2);
    prism(mb, f, ax, ax + 1.2, az, az + 0.9, roofY, roofY + 0.9, 0xd4d4d0, BMAT.Metal, 50, 0xbfbfbb, BMAT.Metal);
  }
  if (r.next() < 0.3) prism(mb, f, mx + 1.9, mx + 2.1, tz0 + 3.9, tz0 + 4.1, roofY + 3, roofY + 8, 0x8a8e92, BMAT.Metal, 50, 0x8a8e92, BMAT.Metal);
  roofClutter(mb, f, r, tx0, tx1, tz0, tz1, roofY, mx);
  // chão do lote e o estacionamento (vagas nos fundos e nas laterais; os carros são peças)
  yard(mb, heights, f, W, D, shop ? 0x9c968c : 0x5c7b42, shop ? BMAT.Paving : BMAT.Grass);
  if (g.rows.length) parkingLots(mb, heights, f, g.rows);
  if (!shop) {
    const fence = 0x9e9a92;
    if (lod < 2) walkway(mb, heights, f, W, D, 0, D / 2 - 0.25, 0, z1 + 0.1, 2.4);
    wall(mb, heights, f, -W / 2, D / 2, -1.6, D / 2, 1.2, 0.2, fence);
    wall(mb, heights, f, 1.6, D / 2, W / 2, D / 2, 1.2, 0.2, fence);
  }
}

const WIN_TABLE = archWindowTable();

/**
 * Janelas em 3D (camada de detalhe): peitoril saliente com a pingadeira e verga em cima de cada janela, nas
 * mesmas colunas e andares que o shader desenha (u em colunas por parede, andares a partir de y0, térreo de
 * loja com 4,4 m). Só a frente e as pontas de cada peça (o fundo encosta na parede).
 */
function windowDetail(mb: MeshBuilder, f: Frame, x0: number, x1: number, z0: number, z1: number, wy0: number, wy1: number,
  base: number, shop: boolean, colW: number, fh: number, arch: number): void {
  const [ww, wLow, wHigh] = WIN_TABLE[arch] ?? WIN_TABLE[0];
  const trim = (ARCHES[arch] ?? ARCHES[0]).trim;
  const ground = shop ? 4.4 : 0;
  const y0 = base;
  const first = Math.max(0, Math.ceil((wy0 - base - ground) / fh - wLow - 1e-3));
  const rows = Math.floor((wy1 - base - ground) / fh - wHigh + 1e-3) + 1;
  if (rows <= first || colW <= 0.5) return;
  blank(mb);
  // peitoril e verga de pedra clara (como no prédio de verdade), puxando um pouco para o acabamento do estilo
  const sillCol = mixHex(0xe4dfd4, trim, 0.15), headCol = mixHex(0xd9d3c7, trim, 0.2);
  const corners: Array<[number, number]> = [[x0, z1], [x1, z1], [x1, z0], [x0, z0]];
  const normals: Array<[number, number]> = [[0, 1], [1, 0], [0, -1], [-1, 0]];
  for (let k = 0; k < 4; k++) {
    const [ax, az] = corners[k], [bx, bz] = corners[(k + 1) & 3];
    const len = Math.hypot(bx - ax, bz - az);
    const cols = Math.max(1, Math.round(len / colW)), cw = len / cols;
    const dx = (bx - ax) / len, dz = (bz - az) / len;
    const [nxl, nzl] = normals[k];
    for (let c = 0; c < cols; c++) {
      const u0 = (c + ww) * cw - 0.06, u1 = (c + 1 - ww) * cw + 0.06;
      for (let fl = first; fl < rows; fl++) {
        const yb = y0 + ground + (fl + wLow) * fh, yt = y0 + ground + (fl + wHigh) * fh;
        // só as faces que aparecem (metade da malha: menos para subir à GPU quando a quadra chega)
        ledge(mb, f, ax, az, dx, dz, nxl, nzl, u0 - 0.04, u1 + 0.04, yb - 0.09, yb, 0.16, sillCol, LEDGE_SILL);
        ledge(mb, f, ax, az, dx, dz, nxl, nzl, u0, u1, yt, yt + 0.11, 0.07, headCol, LEDGE_HEAD);
      }
    }
  }
}

/** Vidro inteiriço: montantes verticais (aletas de alumínio) entre os painéis, na altura toda da parede. */
function curtainFins(mb: MeshBuilder, f: Frame, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, span: number): void {
  blank(mb);
  const corners: Array<[number, number]> = [[x0, z1], [x1, z1], [x1, z0], [x0, z0]];
  const normals: Array<[number, number]> = [[0, 1], [1, 0], [0, -1], [-1, 0]];
  for (let k = 0; k < 4; k++) {
    const [ax, az] = corners[k], [bx, bz] = corners[(k + 1) & 3];
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.round(len / span)), cw = len / n;
    const dx = (bx - ax) / len, dz = (bz - az) / len;
    for (let c = 1; c < n; c++) ledge(mb, f, ax, az, dx, dz, normals[k][0], normals[k][1], c * cw - 0.05, c * cw + 0.05, y0, y1, 0.22, 0x9aa3a8);
  }
}

/** Faces de uma peça saliente: 1 frente, 2 topo, 4 base, 8 pontas. */
const LEDGE_ALL = 15, LEDGE_SILL = 1 | 2 | 4, LEDGE_HEAD = 1 | 4;

/** Peça saliente na parede: de u0 a u1 ao longo da parede, de y0 a y1, saindo `out` metros (faces escolhidas). */
function ledge(mb: MeshBuilder, f: Frame, ax: number, az: number, dx: number, dz: number, nxl: number, nzl: number,
  u0: number, u1: number, y0: number, y1: number, out: number, col: number, faces = LEDGE_ALL): void {
  const p = (u: number, o: number): [number, number] => [ax + dx * u + nxl * o, az + dz * u + nzl * o];
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

/** Telhado com vida: respiros, claraboias, caixa d'água sobre pés, placas solares (só perto da câmera). */
function roofClutter(mb: MeshBuilder, f: Frame, r: Rng, x0: number, x1: number, z0: number, z1: number, y: number, mx: number): void {
  const w = x1 - x0, d = z1 - z0;
  if (w < 8 || d < 8) return;
  const free = (ax: number, az: number, s: number) => ax + s < mx - 0.3 || ax > mx + 4.3 || az > z0 + 6.3 || az + s < z0 + 1.7;
  // respiros (canos curtos com chapéu)
  for (let k = 0; k < r.int(2, 6); k++) {
    const ax = r.range(x0 + 0.8, x1 - 1), az = r.range(z0 + 0.8, z1 - 1);
    if (!free(ax, az, 0.4)) continue;
    prism(mb, f, ax, ax + 0.25, az, az + 0.25, y, y + 0.7, 0x9a9c9e, BMAT.Metal, 50, -1, 0);
    prism(mb, f, ax - 0.08, ax + 0.33, az - 0.08, az + 0.33, y + 0.7, y + 0.8, 0x7c7f82, BMAT.Metal, 50, 0x7c7f82, BMAT.Metal);
  }
  // claraboias (vidro escuro numa moldura)
  if (r.next() < 0.45) for (let k = 0; k < r.int(1, 4); k++) {
    const ax = x0 + 1.5 + k * 2.6;
    if (ax + 1.6 > x1 - 1 || !free(ax, z1 - 3.5, 1.6)) break;
    prism(mb, f, ax, ax + 1.6, z1 - 3.5, z1 - 1.6, y, y + 0.35, 0xc9c6bf, BMAT.Plain, 50, 0x2a3540, BMAT.Curtain);
  }
  // caixa d'água sobre pés
  if (r.next() < 0.35) {
    const ax = r.range(x0 + 1, x1 - 3.2), az = r.range(z0 + 1, z1 - 3.2);
    if (free(ax, az, 2.4)) {
      for (const [lx, lz] of [[0, 0], [2.1, 0], [0, 2.1], [2.1, 2.1]]) prism(mb, f, ax + lx, ax + lx + 0.18, az + lz, az + lz + 0.18, y, y + 1.6, 0x5a5e62, BMAT.Metal, 50, -1, 0);
      prism(mb, f, ax - 0.1, ax + 2.4, az - 0.1, az + 2.4, y + 1.6, y + 3.3, 0x8a6f52, BMAT.Plain, 50, 0x6e5a44, BMAT.Plain);
    }
  }
  // placas solares em fileiras
  if (r.next() < 0.25 && d > 12) {
    const rows = Math.min(4, Math.floor((d - 8) / 2.4));
    for (let q = 0; q < rows; q++) {
      const z = z1 - 2 - q * 2.4 - 1.5;
      prism(mb, f, x0 + 1.2, x0 + Math.min(w - 1.2, 9), z, z + 1.5, y + 0.3, y + 0.7, 0x1d2c44, BMAT.Metal, 50, 0x23395a, BMAT.Metal);
    }
  }
}

/** Bola grosseira (copa de árvore) feita de dois prismas cruzados: barata e legível de longe. */
function treeGeo(mb: MeshBuilder, f: Frame, x: number, z: number, y: number, h: number, r: number): void {
  blank(mb);
  prism(mb, f, x - 0.15, x + 0.15, z - 0.15, z + 0.15, y, y + h * 0.5, 0x6a5238, BMAT.Plain, 50, -1, 0);
  prism(mb, f, x - r, x + r, z - r * 0.7, z + r * 0.7, y + h * 0.45, y + h, 0x5a8a3a, BMAT.Grass, 50, 0x6a9a45, BMAT.Grass);
  prism(mb, f, x - r * 0.7, x + r * 0.7, z - r, z + r, y + h * 0.5, y + h * 1.05, 0x4f7a34, BMAT.Grass, 50, 0x5a8a3a, BMAT.Grass);
}

/** Prédios especiais (escola, igreja, hospital, praça, parque, posto…), cada um com a sua forma. */
function civic(g: Gen, fn: number): void {
  const { mb, heights, f, W, D, r, hi, lod } = g;
  const y0 = hi + 0.2;
  mb.curBase = y0;
  const box = (x0: number, x1: number, z0: number, z1: number, h: number, col: number, kind: number, colW: number, fh: number, roof = 0x8f8b84) => {
    setFac(mb, ArchId.Civic, g.seed, kind, colW, fh);
    prism(mb, f, x0, x1, z0, z1, g.f.base, y0 + h, col, BMAT.Wall, colW, roof, BMAT.RoofFlat);
  };
  const solid = (x0: number, x1: number, z0: number, z1: number, ya: number, yb: number, col: number, mat: number = BMAT.Plain, top = col) => {
    blank(mb); prism(mb, f, x0, x1, z0, z1, ya, yb, col, mat, 50, top, mat === BMAT.Plain ? BMAT.Plain : mat);
  };
  const ground = (col: number, mat: number) => yard(mb, heights, f, W, D, col, mat);
  const zf = D / 2;
  switch (fn) {
    case Fn.School: {
      // bloco em L de 2-3 andares, quadra pintada e muro
      const fl = r.int(2, 4);
      const bw = Math.min(W - 4, 40), bd = Math.min(12, D * 0.35);
      box(-bw / 2, bw / 2, zf - 3 - bd, zf - 3, fl * 3.6, 0xf2e6c8, Facade.Punched, 3.4, 3.6);
      box(-bw / 2, -bw / 2 + 10, zf - 3 - bd - 16, zf - 3 - bd, fl * 3.6, 0xf2e6c8, Facade.Punched, 3.4, 3.6);
      if (lod < 2) solid(-bw / 2 - 0.3, bw / 2 + 0.3, zf - 3 - bd - 0.3, zf - 2.7, y0 + fl * 3.6, y0 + fl * 3.6 + 0.6, 0x3d6aa0);
      if (lod > 0) break;
      ground(0x8a8478, BMAT.Paving);
      // quadra: piso verde com linhas, alambrado
      const cx = Math.min(bw / 2 - 12, 6), cz = zf - 3 - bd - 14;
      solid(cx - 9, cx + 9, cz - 14, cz + 2, y0, y0 + 0.08, 0x2f7a4a);
      solid(cx - 8.5, cx + 8.5, cz - 6.1, cz - 5.9, y0 + 0.08, y0 + 0.1, 0xf2f2ee);
      for (const [a, b2] of [[cx - 9, cx - 8.9], [cx + 8.9, cx + 9]]) solid(a, b2, cz - 14, cz + 2, y0, y0 + 4, 0x6c7276, BMAT.Fence);
      wall(mb, heights, f, -W / 2, zf, W / 2, zf, 2.2, 0.2, 0xe8e2d4);
      break;
    }
    case Fn.Church: {
      // nave com telhado de duas águas, torre com pináculo e cruz, adro
      const nw = Math.min(W - 6, 14), nd = Math.min(D - 10, 30);
      const z1 = zf - 6, z0 = z1 - nd;
      setFac(mb, ArchId.Civic, g.seed, Facade.Punched, 3.6, 7);
      prism(mb, f, -nw / 2, nw / 2, z0, z1, g.f.base, y0 + 9, 0xf4efe4, BMAT.Wall, 3.6, -1, 0);
      gable(mb, f, -nw / 2, nw / 2, z0, z1, y0 + 9, 5, 0x8a3f2b, 0xf4efe4, false);
      const tw = 4.4;
      setFac(mb, ArchId.Civic, g.seed, Facade.Punched, 2.2, 5);
      prism(mb, f, -tw / 2, tw / 2, z1 - 1, z1 + 2, g.f.base, y0 + 20, 0xf4efe4, BMAT.Wall, 2.2, -1, 0);
      hip(mb, f, -tw / 2 + 0.6, tw / 2 - 0.6, z1 - 0.4, z1 + 1.4, y0 + 20, 6, 0x5a5d61, 0xf4efe4);
      if (lod < 2) { solid(-0.12, 0.12, z1 + 0.38, z1 + 0.62, y0 + 26, y0 + 28.4, 0xe0c060, BMAT.Metal); solid(-0.7, 0.7, z1 + 0.38, z1 + 0.62, y0 + 27.3, y0 + 27.6, 0xe0c060, BMAT.Metal); }
      if (lod > 0) break;
      ground(0xc9c3b8, BMAT.Paving);
      for (let k = 0; k < 4; k++) treeGeo(mb, f, (k < 2 ? -1 : 1) * (W / 2 - 3), zf - 3 - (k % 2) * 8, y0, 6, 2);
      break;
    }
    case Fn.Hospital: case Fn.Clinic: {
      const big = fn === Fn.Hospital;
      const fl = big ? r.int(5, 10) : 2;
      const bw = Math.min(W - 4, big ? 44 : 24), bd = Math.min(D - 10, big ? 22 : 14);
      const z1 = zf - 6;
      box(-bw / 2, bw / 2, z1 - bd, z1, fl * 3.6, 0xf4f4f0, Facade.Industrial, 3.2, 3.6, 0x9aa0a4);
      if (lod < 2) {
        solid(-bw / 2 - 0.2, bw / 2 + 0.2, z1 - bd - 0.2, z1 + 0.2, y0 + fl * 3.6, y0 + fl * 3.6 + 0.8, 0x2f7ab0);
        // cruz vermelha na fachada
        solid(-0.5, 0.5, z1, z1 + 0.15, y0 + fl * 3.6 - 3.2, y0 + fl * 3.6 - 0.4, 0xc8241c);
        solid(-1.4, 1.4, z1, z1 + 0.15, y0 + fl * 3.6 - 2.3, y0 + fl * 3.6 - 1.3, 0xc8241c);
      }
      if (lod > 0) break;
      // marquise da emergência
      solid(-6, 6, z1, z1 + 5, y0 + 3.4, y0 + 3.7, 0xd8d6d0);
      for (const x of [-5.5, 5.5]) solid(x - 0.15, x + 0.15, z1 + 4.6, z1 + 4.9, y0, y0 + 3.4, 0xd8d6d0);
      // heliponto sobre a laje de 0,8 m (antes ficava escondido dentro dela)
      if (big) { const yh = y0 + fl * 3.6 + 0.8; solid(-6, 6, z1 - bd + 3, z1 - bd + 15, yh, yh + 0.2, 0x4a4d50); solid(-2, 2, z1 - bd + 8.7, z1 - bd + 9.3, yh + 0.2, yh + 0.25, 0xf2f2ee); }
      ground(0xa29c92, BMAT.Paving);
      break;
    }
    case Fn.Square: case Fn.Park: {
      // praça: piso, canteiros, bancos, chafariz; parque: gramado, caminhos e árvores
      const park = fn === Fn.Park;
      ground(park ? 0x6f9a4c : 0xc4beb2, park ? BMAT.Grass : BMAT.Paving);
      if (lod > 1) break;
      if (!park) {
        for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) solid(x * W / 4 - W / 8, x * W / 4 + W / 8, z * D / 4 - D / 8, z * D / 4 + D / 8, y0, y0 + 0.45, 0x5f8a3e, BMAT.Grass);
        solid(-2.5, 2.5, -2.5, 2.5, y0, y0 + 0.7, 0xd8d2c6);
        solid(-1.8, 1.8, -1.8, 1.8, y0 + 0.7, y0 + 0.75, 0x6f9fc0);
        solid(-0.3, 0.3, -0.3, 0.3, y0 + 0.7, y0 + 2.4, 0xd8d2c6);
      } else {
        solid(-W / 2 + 1, W / 2 - 1, -1.2, 1.2, y0, y0 + 0.06, 0xc9b996);
        solid(-1.2, 1.2, -D / 2 + 1, D / 2 - 1, y0, y0 + 0.06, 0xc9b996);
        if (W > 40 && D > 40) solid(W / 6, W / 3, -D / 3, -D / 6, y0, y0 + 0.08, 0x4f7fa0);
      }
      if (lod > 0) break;
      const n = Math.min(14, Math.floor(W * D / (park ? 120 : 260)));
      for (let k = 0; k < n; k++) {
        const x = r.range(-W / 2 + 3, W / 2 - 3), z = r.range(-D / 2 + 3, D / 2 - 3);
        if (Math.abs(x) < 3 || Math.abs(z) < 3) continue;
        treeGeo(mb, f, x, z, y0, r.range(5, 9), r.range(1.6, 2.8));
      }
      break;
    }
    case Fn.SportsCourt: {
      ground(0x6f9a4c, BMAT.Grass);
      solid(-10, 10, -16, 16, y0, y0 + 0.08, 0x2f6a9a);
      solid(-9.5, 9.5, -0.1, 0.1, y0 + 0.08, y0 + 0.1, 0xf2f2ee);
      for (const z of [-15.5, 15.5]) solid(-1.5, 1.5, z - 0.1, z + 0.1, y0, y0 + 2.4, 0xf2f2ee, BMAT.Metal);
      if (lod === 0) for (const [a, b2] of [[-10.2, -10], [10, 10.2]]) solid(a, b2, -16, 16, y0, y0 + 4, 0x6c7276, BMAT.Fence);
      break;
    }
    case Fn.GasStation: {
      // cobertura sobre as bombas, lojinha, totem
      const cz = zf - 9;
      solid(-9, 9, cz - 6, cz + 6, y0 + 5, y0 + 5.9, 0xf2f2ee);
      // faixa colorida 5 cm acima do teto da cobertura (no mesmo plano, as duas cores piscavam)
      if (lod < 2) solid(-9.05, 9.05, cz - 6.05, cz + 6.05, y0 + 5.4, y0 + 5.95, r.next() < 0.5 ? 0xc8241c : 0x1f8a4a);
      for (const [x, z] of [[-5, -3], [5, -3], [-5, 3], [5, 3]]) solid(x - 0.25, x + 0.25, cz + z - 0.25, cz + z + 0.25, y0, y0 + 5, 0xd8d6d0);
      if (lod > 0) break;
      for (const [x, z] of [[-5, 0], [5, 0]]) solid(x - 0.6, x + 0.6, cz + z - 1.2, cz + z + 1.2, y0, y0 + 1.6, 0x5a5f63, BMAT.Metal);
      box(-W / 2 + 2, -W / 2 + 12, cz - 18, cz - 9, 3.6, 0xf2f2ee, Facade.Punched | Facade.ShopBit, 3, 3.6);
      solid(W / 2 - 2.5, W / 2 - 1.5, zf - 2, zf - 1.5, y0, y0 + 7, 0xc8241c);
      ground(0x6a6d70, BMAT.Paving);
      break;
    }
    case Fn.Supermarket: case Fn.Mall: {
      const mall = fn === Fn.Mall;
      const bw = Math.min(W - 4, mall ? 70 : 46), bd = Math.min(D - (mall ? 6 : 20), mall ? 60 : 34);
      const z0 = -D / 2 + 3, z1 = z0 + bd;
      box(-bw / 2, bw / 2, z0, z1, mall ? 14 : 7, mall ? 0xe8e2d4 : 0xf2f2ee, Facade.Industrial, 4, mall ? 7 : 7, 0x9aa0a4);
      if (lod < 2) solid(-bw / 2 - 0.3, bw / 2 + 0.3, z1 - 0.2, z1 + 0.3, y0 + (mall ? 14 : 7) - 1.6, y0 + (mall ? 14 : 7) + 0.05, r.next() < 0.5 ? 0xd8432a : 0x1f6fb0);
      if (lod > 0) break;
      // entrada envidraçada e estacionamento pintado
      setFac(mb, ArchId.Glass, g.seed, Facade.Curtain, 1.6, 3.6);
      prism(mb, f, -8, 8, z1, z1 + 2, g.f.base, y0 + 6, 0x4a6274, BMAT.Curtain, 1.6, 0x8f8b84, BMAT.RoofFlat);
      ground(0x55585b, BMAT.Paving);
      for (let x = -W / 2 + 3; x < W / 2 - 3; x += 2.6) solid(x, x + 0.1, z1 + 4, z1 + 9, y0 + 0.02, y0 + 0.05, 0xf2f2ee);
      break;
    }
    case Fn.CityHall: {
      // três andares, pórtico de colunas, frontão e mastro com bandeira
      const bw = Math.min(W - 6, 36), bd = Math.min(D - 12, 22);
      const z1 = zf - 8;
      box(-bw / 2, bw / 2, z1 - bd, z1, 13, 0xefe9de, Facade.Punched, 3.4, 4.2);
      if (lod < 2) {
        ring(mb, f, -bw / 2, bw / 2, z1 - bd, z1, y0 + 13, y0 + 13.6, 0.4, 0xffffff);
        for (let k = 0; k < 6; k++) { const x = -7.5 + k * 3; solid(x - 0.35, x + 0.35, z1 + 2.6, z1 + 3.3, y0 + 1, y0 + 9, 0xffffff); }
        solid(-9, 9, z1, z1 + 3.6, y0, y0 + 1, 0xd8d2c6);
        solid(-9, 9, z1, z1 + 3.6, y0 + 9, y0 + 10, 0xffffff);
        solid(-0.1, 0.1, z1 + 6, z1 + 6.2, y0, y0 + 14, 0xc0c4c8, BMAT.Metal);
        solid(0.1, 2.3, z1 + 6, z1 + 6.08, y0 + 12.4, y0 + 13.8, 0x1f8a4a);
      }
      if (lod > 0) break;
      ground(0xd0cabe, BMAT.Paving);
      for (let k = 0; k < 6; k++) treeGeo(mb, f, (k % 2 ? 1 : -1) * (bw / 2 + 2 + (k >> 1) * 3), zf - 3, y0, 7, 2.2);
      break;
    }
    case Fn.Police: case Fn.FireStation: {
      const fire = fn === Fn.FireStation;
      const bw = Math.min(W - 4, 28), bd = Math.min(D - 8, 18);
      const z1 = zf - 5;
      box(-bw / 2, bw / 2, z1 - bd, z1, 8, fire ? 0xc8402c : 0xe8e8e4, Facade.Punched, 3.2, 4);
      if (lod < 2) solid(-bw / 2, bw / 2, z1, z1 + 0.15, y0 + 6.3, y0 + 7.3, fire ? 0xf2f2ee : 0x1f3f8a);
      if (fire) {
        // portões da garagem e torre de treino
        if (lod < 2) for (let k = 0; k < 3; k++) solid(-bw / 2 + 2 + k * 6, -bw / 2 + 6.5 + k * 6, z1, z1 + 0.1, y0, y0 + 4.5, 0xa02a1c);
        setFac(mb, ArchId.Civic, g.seed, Facade.Punched, 2.4, 3.2);
        // torre 10 cm para fora das paredes do quartel (no mesmo plano, as janelas das duas piscavam)
        prism(mb, f, bw / 2 - 4.9, bw / 2 + 0.1, z1 - bd - 0.1, z1 - bd + 4.9, g.f.base, y0 + 18, 0xc8402c, BMAT.Wall, 2.4, 0x8f8b84, BMAT.RoofFlat);
      }
      if (lod > 0) break;
      ground(0x8a8478, BMAT.Paving);
      break;
    }
    default: block(g);
  }
}

/** Torre de escritórios: pódio de lojas, torre recuada (vidro, contemporânea ou art déco) e coroa. */
function tower(g: Gen): void {
  const { mb, heights, f, W, D, floors, a, r, hi, lod } = g;
  const skin = a.walls[r.int(0, a.walls.length)];
  const podiumCol = a.base >= 0 ? a.base : PLASTER[r.int(0, PLASTER.length)];
  const fh = a.floorH;
  const podium = 2;
  // lote fundo do centro: o embasamento vai até o fundo (sem gramado atrás da torre)
  const pw = Math.min(W - 0.6, 40), pd = Math.min(D - 3, D > 42 ? 60 : 36);
  const z1 = D / 2 - 0.5, z0 = z1 - pd;
  const yP = hi + 0.2 + 4.4 + fh * (podium - 1);
  mb.curBase = hi + 0.2;
  facade(g, Facade.Punched | Facade.ShopBit, 3.2, fh);
  prism(mb, f, -pw / 2, pw / 2, z0, z1, f.base, yP, podiumCol, BMAT.Wall, 3.2, 0x8f8b84, BMAT.RoofFlat);
  if (lod < 2) ring(mb, f, -pw / 2, pw / 2, z0, z1, yP - 0.1, yP + 0.3, 0.3, 0xd8d6d0);
  let tw = Math.max(10, pw - r.range(4, 10)), td = Math.max(10, Math.min(34, pd - r.range(4, 10)));
  let y = yP;
  let left = floors - podium;
  const tiers = left > 12 && r.next() < 0.6 ? Math.max(1, a.setbacks) : 1;
  const zc = (z0 + z1) / 2;
  const glass = g.arch === ArchId.Glass;
  for (let t = 0; t < tiers; t++) {
    const fl = t === tiers - 1 ? left : Math.round(left * r.range(0.55, 0.75));
    left -= fl;
    const y1 = y + fl * fh;
    mb.curBase = yP;
    const colW = glass ? 1.6 : a.module;
    facade(g, glass ? Facade.Curtain : g.arch === ArchId.Contemporary ? Facade.Industrial : Facade.Punched, colW, fh);
    prism(mb, f, -tw / 2, tw / 2, zc - td / 2, zc + td / 2, y, y1, skin, glass ? BMAT.Curtain : BMAT.Wall, colW, 0x7d7f80, BMAT.RoofFlat);
    if (!glass && a.piers && lod < 2) piers(mb, f, -tw / 2, tw / 2, zc - td / 2, zc + td / 2, y, y1, colW, a.piers, shadeHex(skin, 1.05));
    if (lod < 2 && t < tiers - 1) ring(mb, f, -tw / 2, tw / 2, zc - td / 2, zc + td / 2, y1 - 0.2, y1 + 0.3, 0.25, a.trim);
    y = y1;
    tw *= 0.78; td *= 0.78;
  }
  // coroa
  blank(mb);
  if (g.arch === ArchId.ArtDeco) {
    prism(mb, f, -tw / 2, tw / 2, zc - td / 2, zc + td / 2, y, y + 3, a.trim, BMAT.Plain, 50, 0x7d7f80, BMAT.RoofFlat);
    prism(mb, f, -tw / 4, tw / 4, zc - td / 4, zc + td / 4, y + 3, y + 7, a.trim, BMAT.Plain, 50, 0x7d7f80, BMAT.RoofFlat);
    prism(mb, f, -0.3, 0.3, zc - 0.3, zc + 0.3, y + 7, y + 14, 0x8a8e92, BMAT.Metal, 50, 0x8a8e92, BMAT.Metal);
  } else {
    prism(mb, f, -tw / 2, tw / 2, zc - td / 2, zc + td / 2, y, y + 4, 0x9aa0a4, BMAT.Plain, 50, 0x7d7f80, BMAT.RoofFlat);
    if (lod < 2 && r.next() < 0.5) prism(mb, f, -tw / 2 + 1, -tw / 2 + 1.4, zc - 0.2, zc + 0.2, y + 4, y + 12, 0xc8241c, BMAT.Metal, 50, 0xc8241c, BMAT.Metal);
  }
  if (lod > 0) return;
  for (let k = 0; k < 3; k++) {
    const ax = r.range(-pw / 2 + 2, pw / 2 - 3), az = r.range(z0 + 2, z1 - 3);
    prism(mb, f, ax, ax + 1.5, az, az + 1.0, yP, yP + 1.1, 0xd4d4d0, BMAT.Metal, 50, 0xbfbfbb, BMAT.Metal);
  }
  // marquise na entrada
  prism(mb, f, -4, 4, z1, z1 + 3, hi + 0.2 + 3.6, hi + 0.2 + 3.85, 0x5a5f63, BMAT.Metal, 50, 0x5a5f63, BMAT.Metal, true);
  yard(mb, heights, f, W, D, 0xa29c92, BMAT.Paving);
}

function warehouse(mb: MeshBuilder, heights: Float32Array, f: Frame, W: number, D: number, floors: number, style: number, r: Rng, hi: number, lod: number): void {
  const metal = METAL[r.int(0, METAL.length)];
  const bw = Math.max(12, W - r.range(4, 10)), bd = Math.max(14, D - r.range(8, 16));
  const z1 = D / 2 - r.range(6, 10), z0 = z1 - bd;
  const h = 6 + floors * 2.5 + r.range(0, 2);
  mb.curBase = hi;
  setFac(mb, style, r.nextU32(), Facade.Industrial, 4, 5.6);
  prism(mb, f, -bw / 2, bw / 2, z0, z1, f.base, hi + h, metal, BMAT.Metal, 4, 0x9da3a6, BMAT.RoofFlat);
  // telhado em dente de serra
  if (r.next() < 0.5 && lod < 3) {
    const n = Math.max(2, Math.floor(bd / 8));
    const step = bd / n;
    for (let k = 0; k < n; k++) {
      const za = z0 + k * step;
      prism(mb, f, -bw / 2, bw / 2, za, za + step * 0.25, hi + h, hi + h + 2.2, 0x8fa2ad, BMAT.Curtain, 2, 0x9da3a6, BMAT.Metal);
    }
  }
  if (lod > 0) return;
  // escritório na frente
  setFac(mb, style, r.nextU32(), Facade.Punched, 3, 3.2);
  prism(mb, f, -bw / 2, -bw / 2 + Math.min(14, bw * 0.4), z1, z1 + 4, f.base, hi + 6.5, 0xe6e2da, BMAT.Wall, 3, 0x8f8b84, BMAT.RoofFlat);
  yard(mb, heights, f, W, D, 0xa7a299, BMAT.Paving);
  const fence = 0x6c7276;
  wall(mb, heights, f, -W / 2, D / 2, -W / 2 + 6, D / 2, 2.0, 0.1, fence);
  wall(mb, heights, f, -W / 2 + 14, D / 2, W / 2, D / 2, 2.0, 0.1, fence);
  wall(mb, heights, f, -W / 2, -D / 2, -W / 2, D / 2, 2.0, 0.1, fence);
  wall(mb, heights, f, W / 2, -D / 2, W / 2, D / 2, 2.0, 0.1, fence);
  wall(mb, heights, f, -W / 2, -D / 2, W / 2, -D / 2, 2.0, 0.1, fence);
}

/** Chaminé de tijolo com anel branco e vermelho no topo (a fumaça sai dela). */
function chimney(mb: MeshBuilder, f: Frame, x: number, z: number, y0: number, y1: number, lod: number): void {
  blank(mb);
  const r0 = 1.3, r1 = 0.9;
  if (lod >= 2) { prism(mb, f, x - r0, x + r0, z - r0, z + r0, y0, y1, 0x8c4430, BMAT.Plain, 4, 0x2a2624, BMAT.RoofFlat); return; }
  // tronco que afina: três trechos
  const H = y1 - y0;
  for (let k = 0; k < 3; k++) {
    const r = r0 + (r1 - r0) * (k / 2);
    prism(mb, f, x - r, x + r, z - r, z + r, y0 + H * k / 3, y0 + H * (k + 1) / 3 - (k === 2 ? 2.2 : 0), 0x9a4a32, BMAT.Plain, 4, -1, BMAT.RoofFlat);
  }
  prism(mb, f, x - r1 - 0.1, x + r1 + 0.1, z - r1 - 0.1, z + r1 + 0.1, y1 - 2.2, y1 - 1.1, 0xf2f2ee, BMAT.Plain, 4, -1, BMAT.RoofFlat);
  prism(mb, f, x - r1 - 0.1, x + r1 + 0.1, z - r1 - 0.1, z + r1 + 0.1, y1 - 1.1, y1, 0xb8322c, BMAT.Plain, 4, 0x1e1a18, BMAT.RoofFlat);
}

// ------------------------------------------------------------ projeto do jogador (criador)

/** Prisma de planta poligonal (convexa), paredes com coordenada de fachada; topo em leque opcional. */
function polyPrism(mb: MeshBuilder, f: Frame, pts: Array<[number, number]>, y0: number, y1: number, wallCol: number, colW: number, top: number, topMat: number): void {
  let cx = 0, cz = 0;
  for (const [x, z] of pts) { cx += x; cz += z; }
  cx /= pts.length; cz /= pts.length;
  for (let k = 0; k < pts.length; k++) {
    const [ax, az] = pts[k], [bx, bz] = pts[(k + 1) % pts.length];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-3) continue;
    let lnx = (bz - az) / len, lnz = -(bx - ax) / len;
    if ((ax + bx) / 2 * lnx - cx * lnx + ((az + bz) / 2 - cz) * lnz < 0) { lnx = -lnx; lnz = -lnz; }
    const NX = nx(f, lnx, lnz), NZ = nz(f, lnx, lnz);
    const cols = Math.max(1, Math.round(len / colW));
    mb.curU = 0;
    const a = mb.vert(wx(f, ax, az), y0, wz(f, ax, az), NX, 0, NZ, wallCol, BMAT.Wall);
    const d = mb.vert(wx(f, ax, az), y1, wz(f, ax, az), NX, 0, NZ, wallCol, BMAT.Wall);
    mb.curU = cols;
    const b = mb.vert(wx(f, bx, bz), y0, wz(f, bx, bz), NX, 0, NZ, wallCol, BMAT.Wall);
    const c = mb.vert(wx(f, bx, bz), y1, wz(f, bx, bz), NX, 0, NZ, wallCol, BMAT.Wall);
    mb.quad(a, b, c, d, NX, 0, NZ);
  }
  mb.curU = 0;
  if (top < 0) return;
  const ctr = mb.vert(wx(f, cx, cz), y1, wz(f, cx, cz), 0, 1, 0, top, topMat);
  const ring = pts.map(([x, z]) => mb.vert(wx(f, x, z), y1, wz(f, x, z), 0, 1, 0, top, topMat));
  for (let k = 0; k < ring.length; k++) mb.tri(ctr, ring[k], ring[(k + 1) % ring.length], 0, 1, 0);
}

/** Pirâmide sobre a planta poligonal (telhado de polígono). */
function pyramid(mb: MeshBuilder, f: Frame, pts: Array<[number, number]>, y: number, h: number, col: number): void {
  let cx = 0, cz = 0;
  for (const [x, z] of pts) { cx += x; cz += z; }
  cx /= pts.length; cz /= pts.length;
  const apex = [wx(f, cx, cz), y + h, wz(f, cx, cz)] as const;
  for (let k = 0; k < pts.length; k++) {
    const [ax, az] = pts[k], [bx, bz] = pts[(k + 1) % pts.length];
    const A = [wx(f, ax + (ax - cx) * 0.06, az + (az - cz) * 0.06), y - 0.2, wz(f, ax + (ax - cx) * 0.06, az + (az - cz) * 0.06)] as const;
    const B = [wx(f, bx + (bx - cx) * 0.06, bz + (bz - cz) * 0.06), y - 0.2, wz(f, bx + (bx - cx) * 0.06, bz + (bz - cz) * 0.06)] as const;
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = apex[0] - A[0], vy = apex[1] - A[1], vz = apex[2] - A[2];
    let n0 = uy * vz - uz * vy, n1 = uz * vx - ux * vz, n2 = ux * vy - uy * vx;
    if (n1 < 0) { n0 = -n0; n1 = -n1; n2 = -n2; }
    const ia = mb.vert(A[0], A[1], A[2], n0, n1, n2, col, BMAT.RoofTile), ib = mb.vert(B[0], B[1], B[2], n0, n1, n2, col, BMAT.RoofTile);
    const ic = mb.vert(apex[0], apex[1], apex[2], n0, n1, n2, col, BMAT.RoofTile);
    mb.tri(ia, ib, ic, n0, n1, n2);
  }
}

/** Telhado de uma água: cai da frente (alta, z0) para o fundo (z1)? não: alto no fundo, caindo para a frente. */
function shed(mb: MeshBuilder, f: Frame, x0: number, x1: number, z0: number, z1: number, y: number, h: number, roofCol: number, wallCol: number): void {
  const o = 0.4;
  const P = (lx: number, ly: number, lz: number, n: [number, number, number], col: number, mat: number) =>
    mb.vert(wx(f, lx, lz), ly, wz(f, lx, lz), nx(f, n[0], n[2]), n[1], nz(f, n[0], n[2]), col, mat);
  const slope = h / (z1 - z0), nl = Math.hypot(1, slope);
  const n: [number, number, number] = [0, 1 / nl, slope / nl];
  const a = P(x0 - o, y, z1 + o, n, roofCol, BMAT.RoofTile), b = P(x1 + o, y, z1 + o, n, roofCol, BMAT.RoofTile);
  const c = P(x1 + o, y + h, z0 - o, n, roofCol, BMAT.RoofTile), d = P(x0 - o, y + h, z0 - o, n, roofCol, BMAT.RoofTile);
  mb.quad(a, b, c, d, nx(f, 0, n[2]), n[1], nz(f, 0, n[2]));
  // parede alta do fundo e os dois triângulos dos lados
  const nb: [number, number, number] = [0, 0, -1];
  const e = P(x0, y, z0, nb, wallCol, BMAT.Plain), g = P(x1, y, z0, nb, wallCol, BMAT.Plain), hh = P(x1, y + h, z0, nb, wallCol, BMAT.Plain), i = P(x0, y + h, z0, nb, wallCol, BMAT.Plain);
  mb.quad(g, e, i, hh, nx(f, 0, -1), 0, nz(f, 0, -1));
  for (const [xx, sx] of [[x0, -1], [x1, 1]] as Array<[number, number]>) {
    const ns: [number, number, number] = [sx, 0, 0];
    mb.tri(P(xx, y, z0, ns, wallCol, BMAT.Plain), P(xx, y, z1, ns, wallCol, BMAT.Plain), P(xx, y + h, z0, ns, wallCol, BMAT.Plain), nx(f, sx, 0), 0, nz(f, sx, 0));
  }
}

/** Dente de serra (galpão com luz do fundo): sheds seguidos ao longo da frente. */
function sawtooth(mb: MeshBuilder, f: Frame, x0: number, x1: number, z0: number, z1: number, y: number, roofCol: number, wallCol: number): void {
  const n = Math.max(2, Math.round((z1 - z0) / 7));
  const step = (z1 - z0) / n;
  for (let k = 0; k < n; k++) shed(mb, f, x0, x1, z0 + k * step, z0 + (k + 1) * step, y, Math.min(3.2, step * 0.45), roofCol, k % 2 ? 0xbfd3dc : wallCol);
}

/** Cemitério (muro, caminhos, túmulos em fileiras, capela) e parquinho (piso, brinquedos). */
function openLot(g: Gen, fn: number): void {
  const { mb, heights, f, W, D, hi, lod } = g;
  const y0 = hi + 0.2;
  mb.curBase = y0;
  blank(mb);
  const sol = (x0: number, x1: number, z0: number, z1: number, ya: number, yb: number, col: number) => prism(mb, f, x0, x1, z0, z1, ya, yb, col, BMAT.Plain, 50, col, BMAT.Plain);
  if (lod < 2) yard(mb, heights, f, W, D, fn === Fn.Cemetery ? 0x6b8a4a : 0x8a8478, fn === Fn.Cemetery ? BMAT.Grass : BMAT.Paving);
  if (fn === Fn.Cemetery) {
    for (const [ax, az, bx, bz] of [[-W / 2, D / 2, W / 2, D / 2], [-W / 2, -D / 2, W / 2, -D / 2], [-W / 2, -D / 2, -W / 2, D / 2], [W / 2, -D / 2, W / 2, D / 2]]) wall(mb, heights, f, ax, az, bx, bz, 2.2, 0.3, 0xe8e2d4);
    // capela no fundo
    setFac(mb, ArchId.Civic, g.seed, Facade.Punched, 3, 4);
    prism(mb, f, -4, 4, -D / 2 + 2, -D / 2 + 10, f.base, y0 + 5, 0xf4efe4, BMAT.Wall, 3, -1, 0);
    gable(mb, f, -4, 4, -D / 2 + 2, -D / 2 + 10, y0 + 5, 3, 0x8a3f2b, 0xf4efe4, false);
    blank(mb);
    if (lod > 0) return;
    for (let z = -D / 2 + 13; z < D / 2 - 3; z += 3.2) for (let x = -W / 2 + 2.5; x < W / 2 - 2; x += 2.6) {
      if (Math.abs(x) < 1.6) continue; // caminho do meio
      sol(x - 0.5, x + 0.5, z - 1, z + 1, y0, y0 + 0.4, 0xb4b0a8);
      sol(x - 0.45, x + 0.45, z - 1.05, z - 0.85, y0 + 0.4, y0 + 1.3, 0xc9c5bd);
    }
    return;
  }
  // parquinho: escorregador, balanço, gangorra, gira-gira e areia
  if (lod > 0) return;
  sol(-W / 4 - 3, -W / 4 + 3, -3, 3, y0, y0 + 0.15, 0xd8c69a);
  sol(-W / 4 - 2.2, -W / 4 - 1.8, -0.2, 0.2, y0, y0 + 2.2, 0xd63c3c); sol(-W / 4 + 1.8, -W / 4 + 2.2, -0.2, 0.2, y0, y0 + 2.2, 0xd63c3c);
  sol(-W / 4 - 2.2, -W / 4 + 2.2, -0.2, 0.2, y0 + 2.2, y0 + 2.4, 0xd63c3c);
  sol(-W / 4 - 0.8, -W / 4 - 0.3, -0.1, 0.1, y0 + 0.5, y0 + 2.2, 0x555b61); sol(-W / 4 + 0.3, -W / 4 + 0.8, -0.1, 0.1, y0 + 0.5, y0 + 2.2, 0x555b61);
  sol(W / 4 - 1, W / 4 + 1, -1, 1, y0, y0 + 2, 0x3d6aa0);
  sol(W / 4 - 0.6, W / 4 + 0.6, 1, 4, y0 + 0.4, y0 + 1.2, 0xf2c21a);
  sol(-1.5, 1.5, D / 4 - 0.2, D / 4 + 0.2, y0 + 0.5, y0 + 0.6, 0x9b5de5);
  sol(-0.2, 0.2, D / 4 - 0.2, D / 4 + 0.2, y0, y0 + 0.55, 0x555b61);
}

function design(g: Gen, ds: Design): void {
  const { mb, f, W, D, floors, hi, lod, zone, seed } = g;
  const shop = zone === Zone.Commercial || zone === Zone.Mixed;
  const fh = ds.finish === 2 ? 3.6 : 3.2;
  const wallCol = ds.wall;
  const arch = [ArchId.Colonial, ArchId.Brick, ArchId.Glass, ArchId.Modernist, ArchId.Industrial, ArchId.Tropical, ArchId.ArtDeco][ds.finish] ?? ArchId.Contemporary;
  const win = ds.windows ?? 0;
  const kind = (win === 1 || (!win && ds.finish === 2) ? Facade.Curtain : !win && ds.finish === 4 ? Facade.Industrial : Facade.Punched) | (shop ? Facade.ShopBit : 0);
  const colW = (win === 1 ? 1.6 : ds.finish === 2 ? 1.6 : ds.finish === 4 ? 4 : 3.1) * (win === 2 ? 1.7 : win === 3 ? 0.7 : 1);
  const bw = Math.max(5, W - 1.2), bd = Math.max(5, D - 2.4);
  const lf: Frame = { ...f, cx: wx(f, 0, 0.6), cz: wz(f, 0, 0.6) }; // encostado na frente
  // ala: o corpo principal estreita e a ala (um terço dos andares) ocupa o lado
  const wing = ds.wing ?? 0, wn = wing === 3 ? 2 : wing ? 1 : 0;
  const ww = wn && bw >= 14 ? bw * (wn === 2 ? 0.25 : 0.36) : 0;
  const offX = !ww ? 0 : wing === 1 ? ww / 2 : wing === 2 ? -ww / 2 : 0;
  const mf: Frame = offX ? { ...lf, cx: wx(lf, offX, 0), cz: wz(lf, offX, 0) } : lf;
  const { rects, poly } = footprint(ds.shape, bw - ww * (ww ? wn : 0), bd);
  const y0 = hi + 0.2;
  const set = Math.min(ds.setback, Math.max(0, floors - 1));
  const lower = floors - set;
  const top1 = y0 + lower * fh;
  const top2 = top1 + set * fh;
  const flat = 0x8f8b84, tile = ds.finish === 1 ? 0x6e3b2c : ds.finish === 4 ? 0x7f8b8f : 0x9b4a32;
  mb.curBase = y0;
  const facade = () => { setFac(mb, arch, seed, kind, colW, fh); if (win === 4) blank(mb); };
  facade();
  if (ww) {
    const wf = Math.max(1, Math.round(lower / 3)), wy = y0 + wf * fh;
    for (const side of wing === 3 ? [-1, 1] : wing === 1 ? [-1] : [1]) {
      const x0 = side < 0 ? -bw / 2 : bw / 2 - ww, x1 = x0 + ww, z0 = -bd / 2 + bd * 0.12, z1 = bd / 2;
      facade();
      prism(mb, lf, x0, x1, z0, z1, f.base, wy, wallCol, BMAT.Wall, colW, flat, BMAT.RoofFlat);
      blank(mb);
      if (lod < 2) parapet(mb, lf, x0, x1, z0, z1, wy, 0.9, 0.22, wallCol);
    }
    facade();
  }
  // volumes de baixo (até o recuo) e, se houver, o andar recuado (2,5 m para dentro)
  const inset = 2.5;
  const topRects: Array<[number, number, number, number]> = [];
  let topPoly: Array<[number, number]> | null = null;
  const pitched = ds.roof >= 2 && ds.roof <= 5;
  for (const [x0, x1, z0, z1] of rects) {
    prism(mb, mf, x0, x1, z0, z1, f.base, top1, wallCol, BMAT.Wall, colW, pitched && !set ? -1 : flat, BMAT.RoofFlat);
    if (set && x1 - x0 > inset * 2 + 4 && z1 - z0 > inset * 2 + 4) {
      setFac(mb, arch, seed, kind & 3, colW, fh); if (win === 4) blank(mb);
      prism(mb, mf, x0 + inset, x1 - inset, z0 + inset, z1 - inset, top1, top2, wallCol, BMAT.Wall, colW, pitched ? -1 : flat, BMAT.RoofFlat);
      topRects.push([x0 + inset, x1 - inset, z0 + inset, z1 - inset]);
    } else topRects.push([x0, x1, z0, z1]);
  }
  if (poly) {
    polyPrism(mb, mf, poly, f.base, top1, wallCol, colW, pitched && !set ? -1 : flat, BMAT.RoofFlat);
    topPoly = poly;
    if (set) {
      const k = 1 - inset * 2 / Math.min(bw, bd);
      topPoly = poly.map(([x, z]) => [x * k, z * k] as [number, number]);
      setFac(mb, arch, seed, kind & 3, colW, fh); if (win === 4) blank(mb);
      polyPrism(mb, mf, topPoly, top1, top2, wallCol, colW, pitched ? -1 : flat, BMAT.RoofFlat);
    }
  }
  const roofY = set ? top2 : top1;
  blank(mb);
  // telhado
  for (const [x0, x1, z0, z1] of (poly ? [] : (set ? topRects : rects))) {
    const w = x1 - x0, d = z1 - z0;
    if (ds.roof === 0 && lod < 2) parapet(mb, mf, x0, x1, z0, z1, roofY, 0.9, 0.22, wallCol);
    else if (ds.roof === 1) {
      parapet(mb, mf, x0, x1, z0, z1, roofY, 1.1, 0.22, wallCol);
      if (lod < 2) for (let q = 0; q < 3; q++) prism(mb, mf, x0 + 1 + q * (w - 2) / 3, x0 + 1 + q * (w - 2) / 3 + Math.min(2, w / 4), z1 - 2.2, z1 - 1, roofY, roofY + 0.7, 0x7a6a58, BMAT.Plain, 50, 0x4f7a34, BMAT.Grass);
    } else if (ds.roof === 2) gable(mb, mf, x0, x1, z0, z1, roofY, Math.min(w, d) * 0.32, tile, wallCol, w >= d);
    else if (ds.roof === 3) hip(mb, mf, x0, x1, z0, z1, roofY, Math.min(w, d) * 0.3, tile, wallCol);
    else if (ds.roof === 4) shed(mb, mf, x0, x1, z0, z1, roofY, Math.min(w, d) * 0.22, tile, wallCol);
    else if (ds.roof === 5) sawtooth(mb, mf, x0, x1, z0, z1, roofY, 0x9aa4ab, wallCol);
  }
  if (topPoly) {
    if (pitched) pyramid(mb, mf, topPoly, roofY, Math.min(bw, bd) * 0.3, tile);
    else if (lod < 2) for (let k = 0; k < topPoly.length; k++) {
      const [ax, az] = topPoly[k], [bx, bz] = topPoly[(k + 1) % topPoly.length];
      wallSeg(mb, mf, ax, az, bx, bz, roofY, ds.roof === 1 ? 1.1 : 0.9, wallCol);
    }
  }
  // peças no telhado (só nos telhados planos e no terraço; agulha e antena em qualquer um)
  if (lod >= 2) return;
  const [rx0, rx1, rz0, rz1] = poly ? [-bw * 0.3, bw * 0.3, -bd * 0.3, bd * 0.3] : (set ? topRects : rects)[0];
  const cx = (rx0 + rx1) / 2, cz = (rz0 + rz1) / 2, rw = rx1 - rx0, rd = rz1 - rz0;
  const flatTop = !pitched;
  if (flatTop && ds.gear & GEAR.Tank) {
    prism(mb, mf, rx0 + 1, rx0 + 3.6, rz0 + 1, rz0 + 3.6, roofY, roofY + 1.2, 0x8f8b84, BMAT.Plain, 50, -1, BMAT.RoofFlat);
    prism(mb, mf, rx0 + 1.2, rx0 + 3.4, rz0 + 1.2, rz0 + 3.4, roofY + 1.2, roofY + 3.2, 0x5b7fa6, BMAT.Metal, 50, 0x46617f, BMAT.Metal);
  }
  if (flatTop && ds.gear & GEAR.Solar) {
    const rows = Math.max(1, Math.floor((rd - 4) / 2.6));
    for (let q = 0; q < rows; q++) {
      const z = rz0 + 2 + q * 2.6;
      prism(mb, mf, cx - rw * 0.3, cx + rw * 0.3, z, z + 1.7, roofY + 0.3, roofY + 0.9, 0x1d2c44, BMAT.Metal, 50, 0x23395a, BMAT.Metal);
    }
  }
  if (ds.gear & GEAR.Chimney) chimney(mb, mf, rx1 - 2, rz0 + 2, roofY, roofY + 6, lod);
  if (flatTop && ds.gear & GEAR.AC) for (let q = 0; q < 4; q++) prism(mb, mf, rx1 - 2.2 - q * 1.6, rx1 - 1.2 - q * 1.6, rz1 - 2, rz1 - 1.2, roofY, roofY + 0.8, 0xc9ccce, BMAT.Metal, 50, 0xa9adb0, BMAT.Metal);
  const peak = roofY + (pitched ? Math.min(rw, rd) * 0.32 : 0);
  if (ds.gear & GEAR.Spire) {
    // agulha: base, haste em três trechos que afinam
    prism(mb, mf, cx - 1.6, cx + 1.6, cz - 1.6, cz + 1.6, peak, peak + 2.5, wallCol, BMAT.Plain, 50, -1, BMAT.RoofFlat);
    for (let q = 0; q < 3; q++) { const r = 1 - q * 0.3; prism(mb, mf, cx - r, cx + r, cz - r, cz + r, peak + 2.5 + q * 4, peak + 6.5 + q * 4, 0xc8c3b4, BMAT.Metal, 50, -1, BMAT.Metal); }
    prism(mb, mf, cx - 0.12, cx + 0.12, cz - 0.12, cz + 0.12, peak + 14.5, peak + 22, 0xd9d4c4, BMAT.Metal, 50, 0xd9d4c4, BMAT.Metal);
  }
  if (ds.gear & GEAR.Antenna) prism(mb, mf, rx0 + 2, rx0 + 2.2, rz1 - 2.2, rz1 - 2, peak, peak + 14, 0x9aa4ab, BMAT.Metal, 50, 0x9aa4ab, BMAT.Metal);
}

/** Mureta reta entre dois pontos do telhado (platibanda de planta poligonal). */
function wallSeg(mb: MeshBuilder, f: Frame, ax: number, az: number, bx: number, bz: number, y: number, h: number, col: number): void {
  const len = Math.hypot(bx - ax, bz - az);
  if (len < 0.1) return;
  const dx = (bx - ax) / len, dz = (bz - az) / len, t = 0.22;
  const px = -dz * t / 2, pz = dx * t / 2;
  for (const s of [1, -1]) {
    const NX = nx(f, -dz * s, dx * s), NZ = nz(f, -dz * s, dx * s);
    const v0 = mb.vert(wx(f, ax + px * s, az + pz * s), y, wz(f, ax + px * s, az + pz * s), NX, 0, NZ, col, BMAT.Plain);
    const v1 = mb.vert(wx(f, bx + px * s, bz + pz * s), y, wz(f, bx + px * s, bz + pz * s), NX, 0, NZ, col, BMAT.Plain);
    const v2 = mb.vert(wx(f, bx + px * s, bz + pz * s), y + h, wz(f, bx + px * s, bz + pz * s), NX, 0, NZ, col, BMAT.Plain);
    const v3 = mb.vert(wx(f, ax + px * s, az + pz * s), y + h, wz(f, ax + px * s, az + pz * s), NX, 0, NZ, col, BMAT.Plain);
    mb.quad(v0, v1, v2, v3, NX, 0, NZ);
  }
}

function mixHex(a: number, b: number, t: number): number {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

function shadeHex(rgb: number, k: number): number {
  const r = Math.round(((rgb >> 16) & 255) * k), g = Math.round(((rgb >> 8) & 255) * k), b = Math.round((rgb & 255) * k);
  return (r << 16) | (g << 8) | b;
}

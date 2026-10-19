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
import { ARCHES, ARCH_COUNT, ArchId, Balcony, Crown, Fn, Pattern, Win, chimneyOf, facadeArch, facadeWindowTable, pickArch, type Arch } from '../world/arch.ts';
import { cellId, cellOriginX, cellX } from '../core/grid.ts';
import { CELL_SIZE } from '../config.ts';
import { SHAPE_SCALE, SHAPE_STRIDE, type BoxColumns, type PackedMesh } from './protocol.ts';
import { CATALOG, CIVIC_CATALOG, CIVIC_DESIGNS, CatElem, CatFill, GEAR, catalogLevels, decodeDesign, footprint, hasDesign, type CatalogEntry, type Design } from '../world/design.ts';
import { FIN } from './buildingFinishes.ts';

export const GEN_VERSION = 15;
/** Camada de detalhe: para onde vão as peças 3D das janelas enquanto o gerador roda num descarte. */
let detailOut: MeshBuilder | null = null;
/** Peças repetidas (pool de props): para onde vão enquanto o gerador roda no modo peças (lod −2). */
export type PartEmit = (variant: number, x: number, y: number, z: number, yaw: number, scale: number) => void;
let partsOut: PartEmit | null = null;
/** Variantes de peça de fachada (mobiliário 8..15 no pool de props). */
export const PART = { WallAc: 8, RoofAc: 9, Vase: 10, Clothesline: 11, Dish: 12, Vent: 13, Chair: 14, Tank: 15 } as const;
/** Emite uma peça na posição local (lx, y, lz) com a frente para a normal local (nlx, nlz). */
function part(f: Frame, variant: number, lx: number, y: number, lz: number, nlx: number, nlz: number, scale = 1): void {
  if (!partsOut) return;
  partsOut(variant, wx(f, lx, lz), y, wz(f, lx, lz), Math.atan2(f.s, f.c) + Math.atan2(nlx, nlz), scale);
}
/**
 * The main mesh of a pass that does not want it (detail layer, parts): keeps the facade state the detail reads
 * (curFac, curBase, curU) and stores no vertex.
 */
class NoMesh extends MeshBuilder {
  override vert(): number { return 0; }
  override tri(): void {}
  override quad(): void {}
  override box(): void {}
}
const NO_MESH = new NoMesh(false, true);
/**
 * A volume of a building with storeys (walls with windows), as the generator laid it: centre in the world, half width
 * and depth along the lot's turn, from y0 to y1; storeys start at `base` (the ground storey `ground` high, then
 * `fh` each). What the inside view and the camera need, without guessing 3.2 m storeys.
 */
export interface Volume { cx: number; cz: number; hw: number; hd: number; rot: number; y0: number; y1: number; base: number; ground: number; fh: number }
/**
 * Footprints of what stands on each building's lot floor (walls, pools, courts, porches, garages, tree trunks), per
 * building of the boxes: [centre x, centre z, half width, half depth, turn] × n, in the world. Filled by the parts pass
 * when asked (buildBuildingParts): the yard props keep out of them.
 */
let footOut: number[][] | null = null;
let footI = -1, footGround = 0;

function captureFoot(f: Frame, x0: number, x1: number, z0: number, z1: number, y0: number): void {
  if (!footOut || footI < 0 || y0 > footGround + 0.6) return;
  const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
  footOut[footI].push(wx(f, mx, mz), wz(f, mx, mz), (x1 - x0) / 2, (z1 - z0) / 2, Math.atan2(f.s, f.c));
}

/** Where the volumes go while a building's layout is taken (buildingVolumes). */
let layoutOut: Volume[] | null = null;

function captureVolume(mb: MeshBuilder, f: Frame, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, wallMat: number): void {
  const fc = mb.curFac, m = wallMat & 15;
  if (!layoutOut || fc[3] === 0 || (m !== BMAT.Wall && m !== BMAT.Curtain && m !== BMAT.Metal) || y1 - y0 < 2) return;
  const fh = (fc[2] >> 3) / 10 + 2.5, mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
  layoutOut.push({ cx: wx(f, mx, mz), cz: wz(f, mx, mz), hw: (x1 - x0) / 2, hd: (z1 - z0) / 2, rot: Math.atan2(f.s, f.c), y0, y1, base: mb.curBase, ground: fc[2] & Facade.ShopBit ? 4.4 : fh, fh });
}

/**
 * The volumes of building i of the boxes (the boxes of its cell: the cell plan picks facades and landmarks), from the
 * same generator, sorted from the largest footprint. Empty for an empty lot. A few milliseconds: for one building.
 */
export function buildingVolumes(heights: Float32Array, b: BoxColumns, i: number): Volume[] {
  const out: Volume[] = [];
  layoutOut = out;
  try { genOne(NO_MESH, heights, b, i, planCells(b), -3); } finally { layoutOut = null; lotPoly = null; detailOut = null; }
  return out.sort((p, q) => q.hw * q.hd - p.hw * p.hd);
}

/** Height of the civic buildings' tallest walls (m), by function (the shapes in civic()). */
const CIVIC_TOP: number[] = [];
CIVIC_TOP[Fn.School] = 10.8; CIVIC_TOP[Fn.Church] = 20; CIVIC_TOP[Fn.Hospital] = 36; CIVIC_TOP[Fn.Clinic] = 7.2;
CIVIC_TOP[Fn.Square] = 2.4; CIVIC_TOP[Fn.Park] = 1; CIVIC_TOP[Fn.GasStation] = 6; CIVIC_TOP[Fn.Supermarket] = 7;
CIVIC_TOP[Fn.CityHall] = 13.6; CIVIC_TOP[Fn.Police] = 8; CIVIC_TOP[Fn.FireStation] = 18; CIVIC_TOP[Fn.Mall] = 14;
CIVIC_TOP[Fn.SportsCourt] = 4; CIVIC_TOP[Fn.Cemetery] = 5; CIVIC_TOP[Fn.Playground] = 2.4;

/**
 * How high a building's walls rise above its ground storey (m), from the record alone, by the generator's storey
 * rules (style, shop ground storey, design, catalog project, civic shape). Cheap: for the camera and the collapse,
 * which ask every frame or for many buildings; the inside view takes the exact layout (buildingVolumes).
 */
export function wallsHeight(zone: number, floors: number, x: number, z: number, style: number, fn: number, color: number, h: number): number {
  const fl = Math.max(1, floors);
  if (hasDesign(color)) {
    const ds = decodeDesign(color, h), e = ds.catalog ? CATALOG[ds.catalog - 1] : undefined;
    if (e) return e.gh + (catalogLevels(e) - 1) * e.sh;
    return fl * (ds.finish === 2 ? 3.6 : 3.2);
  }
  if (CIVIC_DESIGNS[fn]) { const [ds, minF] = CIVIC_DESIGNS[fn]; return Math.max(minF, Math.min(fl, minF * 2)) * (ds.finish === 2 ? 3.6 : 3.2); }
  if (fn) return CIVIC_TOP[fn] ?? 3.6 * fl;
  if (zone === Zone.Industrial) return 6 + fl * 2.5 + 2;
  const arch = pickArch(zone, fl, x, z, style), a = ARCHES[arch];
  if (arch >= ArchId.ColonialHouse && arch <= ArchId.Sobrado) return (arch === ArchId.Sobrado ? Math.max(2, fl) : fl) * a.floorH + 0.2;
  const shop = zone === Zone.Commercial || zone === Zone.Mixed;
  return (shop ? 4.4 : a.floorH) + (fl - 1) * a.floorH;
}

/**
 * The tag of a building's own vertices (15 bits, never 0), in position.w of the mesh: the inside view cuts only the
 * chosen building's vertices, never a neighbour's. The same sum on the page (inside.ts) from the record.
 */
export function buildingTag(seed: number, x: number, z: number): number {
  return (hash2(seed, Math.round(x * 8), Math.round(z * 8)) & 0x7ffe) | 1;
}

/** Runs draw() with no building tag on mb and on the detail layer (lot ground, walls, gates, trees). */
function untagged(mb: MeshBuilder, draw: () => void): void {
  const t = mb.curTag, d = detailOut, td = d ? d.curTag : 0;
  mb.curTag = 0;
  if (d) d.curTag = 0;
  try { draw(); } finally { mb.curTag = t; if (d) d.curTag = td; }
}

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
  if (layoutOut) captureVolume(mb, f, x0, x1, z0, z1, y0, y1, wallMat);
  if (footOut) captureFoot(f, x0, x1, z0, z1, y0);
  if (detailOut && mb !== detailOut) {
    const fc = mb.curFac, kind = fc[2] & 3;
    if (fc[3] > 0 && kind !== Facade.Curtain && ((wallMat & 15) === BMAT.Wall || (wallMat & 15) === BMAT.Metal)) {
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

/** Parts of a frame: the top, the underside of the overhang, the inside walls. */
const FR_TOP = 1, FR_BOTTOM = 2, FR_INNER = 4;
/** Level of the building being generated (0 near; 1 far cell: a frame keeps only what reads at a pixel). */
let genLod = 0;

/**
 * A rectangular frame from y0 to y1: the band between the outer rectangle (`out` past x0..x1 × z0..z1) and the inner
 * one (`inset` inside it). The outer walls always; the top, the underside of the overhang and the inner walls (a band
 * that rises above a roof) by `parts`. Never a lid: whatever lies inside the inner rectangle stays in view.
 */
function frame(mb: MeshBuilder, f: Frame, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number,
  out: number, inset: number, col: number, mat: number, parts: number, innerCol = col): void {
  prism(mb, f, x0 - out, x1 + out, z0 - out, z1 + out, y0, y1, col, mat, 50, -1, 0);
  if ((detailOut && mb !== detailOut) || !parts) return;
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
function parapet(mb: MeshBuilder, f: Frame, x0: number, x1: number, z0: number, z1: number, y: number, h: number, t: number, col: number): void {
  const inner = shadeHex(col, 0.85);
  if (genLod > 0) { frame(mb, f, x0, x1, z0, z1, y, y + h, 0, t, col, BMAT.Plain, FR_TOP | FR_INNER, inner); return; }
  // the wall (its top hidden under the coping), then the coping: 8 cm of concrete, 5 cm proud on both sides
  frame(mb, f, x0, x1, z0, z1, y, y + h, 0, t, col, BMAT.Plain, FR_INNER, inner);
  frame(mb, f, x0, x1, z0, z1, y + h, y + h + 0.08, 0.05, t + 0.05, 0xd6d3cc, BMAT.Plain, FR_TOP | FR_BOTTOM | FR_INNER);
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
/** wall, without the building's tag (it is the lot's, not the building's: the inside view's cut leaves it). */
function wall(...a: Parameters<typeof wallTagged>): void { untagged(a[0], () => wallTagged(...a)); }
function wallTagged(mb: MeshBuilder, heights: Float32Array, f: Frame, ax: number, az: number, bx: number, bz: number, h: number, t: number, col: number, mat: number = BMAT.Fence): void {
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

/**
 * Grade do chão do lote: passo de ~6 m (acompanha o relevo de 4 m sem afundar). Lotes vizinhos se sobrepõem um
 * pouco nos fundos e nas esquinas: o fundo recua 0,5 m e cada lote fica num de três níveis (3 cm entre eles, 4 passos
 * da quantização da malha): dois chãos no mesmo plano piscavam um sobre o outro.
 */
/** The relief grid of a lot's ground. */
interface YardGrid { NX: number; NZ: number; lxOf: (i: number) => number; lzOf: (j: number) => number; hAt: (i: number, j: number) => number; at: (lx: number, lz: number) => number }

function yardGrid(heights: Float32Array, f: Frame, w: number, d: number): YardGrid {
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
  /** Altura do chão do lote no ponto local (pela grade, não pelo relevo: o que fica por cima não cruza o chão). */
  const at = (lx: number, lz: number) => {
    const fi = Math.max(0, Math.min(NX - 1e-6, (lx - gx0) / gw * NX)), fj = Math.max(0, Math.min(NZ - 1e-6, (lz - gz0) / gd * NZ));
    const i = Math.floor(fi), j = Math.floor(fj), ti = fi - i, tj = fj - j;
    // o mesmo triângulo da malha (a diagonal vai de (i, j) a (i + 1, j + 1))
    const h00 = hAt(i, j), h11 = hAt(i + 1, j + 1);
    return ti >= tj ? h00 + (hAt(i + 1, j) - h00) * ti + (h11 - hAt(i + 1, j)) * tj : h00 + (hAt(i, j + 1) - h00) * tj + (h11 - hAt(i, j + 1)) * ti;
  };
  const grid = { NX, NZ, lxOf, lzOf, hAt, at };
  if (lotPoly) polyGrid = grid;
  return grid;
}

/** Chão do lote (grama ou piso) acompanhando o relevo. */
/** yard, without the building's tag (it is the lot's, not the building's: the inside view's cut leaves it). */
function yard(...a: Parameters<typeof yardTagged>): void { untagged(a[0], () => yardTagged(...a)); }
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
 * Caminho de entrada (roadcraft `lotDoors`): piso do portão na frente do lote até a porta, 6 cm acima do chão do lote
 * (pela grade do chão: em declive o caminho não cruza a grama).
 */
/** walkway, without the building's tag (it is the lot's, not the building's: the inside view's cut leaves it). */
function walkway(...a: Parameters<typeof walkwayTagged>): void { untagged(a[0], () => walkwayTagged(...a)); }
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

// ------------------------------------------------------------ polygon lots (the outline the player drew)

/**
 * A lot as the generator builds it: the rectangle the building goes in (centre in the world, front W, depth D, in the
 * lot's turn; ox, oz = its centre in the lot frame) and, for a polygon lot, the polygon in that rectangle's frame. A
 * rectangle lot is itself; a polygon lot gets the largest rectangle inside its polygon, preferring the street front.
 */
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

/** The polygon of the lot being generated, in its frame (null = a rectangle lot), and what its walls look like. */
let lotPoly: Array<[number, number]> | null = null;
let polyGrid: YardGrid | null = null;
/** Lot wall styles the generator asked for ([height, thickness, colour]): on the street front and elsewhere. */
let fenceFront: [number, number, number] | null = null, fenceBack: [number, number, number] | null = null;
/** The gate the generator put on the front ([x0, x1, z] in the frame), when it stands on the polygon's outline. */
let gateAt: [number, number, number] | null = null;

/** A wall on the lot's boundary: on a polygon lot only its style is kept, and the walls follow the polygon. */
function lotWall(mb: MeshBuilder, heights: Float32Array, f: Frame, ax: number, az: number, bx: number, bz: number, h: number, t: number, col: number): void {
  if (!lotPoly) { wall(mb, heights, f, ax, az, bx, bz, h, t, col); return; }
  const front = Math.abs(az - bz) < 0.01 && az > 0;
  if (front) fenceFront ??= [h, t, col]; else fenceBack ??= [h, t, col];
}

/** The lot's gate: on a polygon lot only where it stands on the outline (the wall there leaves its gap). */
function lotGate(mb: MeshBuilder, heights: Float32Array, f: Frame, ax: number, az: number, bx: number, bz: number, h: number): void {
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
function polyWalls(mb: MeshBuilder, heights: Float32Array, f: Frame): void {
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

export function buildBuildings(heights: Float32Array, b: BoxColumns, originX: number, originZ: number, extent: number, lod: number): PackedMesh | null {
  const mb = new MeshBuilder(false, true);
  const plan = planCells(b);
  for (let i = 0; i < b.count; i++) {
    mb.curTag = buildingTag(b.seed[i], b.x[i], b.z[i]);
    genOne(mb, heights, b, i, plan, lod);
    mb.curTag = 0;
  }
  return mb.pack(originX, originZ, extent);
}

/** One building of the boxes (the cell plan already made) into mb, at level lod. */
function genOne(mb: MeshBuilder, heights: Float32Array, b: BoxColumns, i: number, plan: CellPlan, lod: number): void {
  const rot = b.rot[i];
  const zone = b.zone[i];
  if (lod < 0 && (b.floors[i] === 0 || zone === 0)) return;
  if (zone === 0) { legacyBox(mb, heights, b, i, { cx: b.x[i], cz: b.z[i], c: Math.cos(rot), s: Math.sin(rot), base: 0 }); return; }
  // the building goes in the lot's rectangle, or in the largest one inside a polygon lot (yard and walls follow it)
  const fit = lotFit(b, i);
  const f: Frame = { cx: fit.cx, cz: fit.cz, c: Math.cos(rot), s: Math.sin(rot), base: 0 };
  lotPoly = fit.poly; polyGrid = null; fenceFront = fenceBack = null; gateAt = null;
  if (b.floors[i] === 0) { emptyLot(mb, heights, fit.W, fit.D, f); lotPoly = null; return; }
  const r = new Rng((b.seed[i] ^ (b.style[i] * 2654435761)) >>> 0);
  const W = fit.W, D = fit.D;
  const rows = lod <= 1 ? lotParking(b, i) : [];
  for (let k = 0; k < rows.length; k += 2) { rows[k] -= fit.ox; rows[k + 1] -= fit.oz; }
  const [lo, hi] = groundRange(heights, f, W, D);
  f.base = lo - 0.4;
  mb.curBase = f.base;
  footI = i; footGround = hi;
  const floors = Math.max(1, b.floors[i]);
  const arch = pickArch(zone, floors, b.x[i], b.z[i], b.style[i]);
  const g: Gen = { mb, heights, f, W, D, floors, arch, a: ARCHES[arch], r, hi, lod, seed: b.seed[i], zone, rows, pattern: plan.pattern[i], side: plan.side[i] };
  if (lod < 0) {
    // one pass, the outputs this job asks for: the parts (lod -2, part -> partsOut) or the detail layer (lod -1,
    // prism -> windowDetail into the real mesh); the main geometry goes to a builder that keeps nothing
    NO_MESH.curBase = f.base;
    if (lod === -1) detailOut = mb;
    g.mb = NO_MESH; g.lod = 0;
  }
  genLod = g.lod;
  const v0 = mb.v;
  const ds = hasDesign(b.color[i]) ? decodeDesign(b.color[i], b.h[i]) : null;
  const cat = ds?.catalog ? ds.catalog : plan.landmark[i];
  if (cat && CATALOG[cat - 1]) catalogBuilding(g, CATALOG[cat - 1], ds ? ds.wall : -1);
  else if (ds) design(g, ds);
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
  polyWalls(g.mb, heights, f);
  lotPoly = null;
  detailOut = null;
  applyFinishes(mb, v0, finishTable(arch, b.seed[i], b.fn[i], zone, ds));
}

/**
 * Peças repetidas dos prédios (ar-condicionado, vasos, varais, antenas, exaustores, caixas d'água) para o pool de
 * props: o mesmo gerador, no modo peças, com o mesmo sorteio da malha. Roda no job de peças da célula.
 */
export function buildBuildingParts(heights: Float32Array, b: BoxColumns, emit: PartEmit, foot?: number[][]): void {
  partsOut = emit;
  footOut = foot ?? null;
  try { buildBuildings(heights, b, 0, 0, 256, -2); } finally { partsOut = null; footOut = null; footI = -1; }
}

/** Whether (x, z) is within `margin` of one of the footprints (captureFoot) of a building. */
export function inFootprints(rects: number[], x: number, z: number, margin: number): boolean {
  for (let k = 0; k + 4 < rects.length; k += 5) {
    const c = Math.cos(rects[k + 4]), s = Math.sin(rects[k + 4]), dx = x - rects[k], dz = z - rects[k + 1];
    if (Math.abs(dx * c - dz * s) <= rects[k + 2] + margin && Math.abs(dx * s + dz * c) <= rects[k + 3] + margin) return true;
  }
  return false;
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
  // in the lot frame: the rows are laid in the building's rectangle (lotFit) and moved by its centre
  const fit = lotFit(b, i), W = fit.W, D = fit.D, shop = zone === Zone.Commercial || zone === Zone.Mixed;
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
  for (let k = 0; k < out.length; k += 2) { out[k] += fit.ox; out[k + 1] += fit.oz; }
  return out;
}

/** Piso do estacionamento e as faixas das vagas, acompanhando o relevo. */
/** parkingLots, without the building's tag (it is the lot's, not the building's: the inside view's cut leaves it). */
function parkingLots(...a: Parameters<typeof parkingLotsTagged>): void { untagged(a[0], () => parkingLotsTagged(...a)); }
function parkingLotsTagged(mb: MeshBuilder, heights: Float32Array, f: Frame, rows: number[]): void {
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
  /** Facade pattern picked by the cell plan (Pattern). */
  pattern: number;
  /** Free sides of the lot (corner): 1 = -x, 2 = +x. */
  side: number;
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

/**
 * A band standing `out` proud round the volume (cornice, storey band, crown slab): only its outside, the top and the
 * underside of the overhang, and the inside face where it rises above a roof (`overRoof`). Never a lid over the roof.
 * Far (level 1) a band on the wall is just its outside, and a crown loses the underside.
 */
function ring(mb: MeshBuilder, f: Frame, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, out: number, col: number, overRoof = true): void {
  blank(mb);
  const parts = overRoof ? FR_TOP | FR_INNER | (genLod > 0 ? 0 : FR_BOTTOM) : genLod > 0 ? 0 : FR_TOP | FR_BOTTOM;
  frame(mb, f, x0, x1, z0, z1, y0, y1, out, 0, col, BMAT.Plain, parts);
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
export function hip(mb: MeshBuilder, f: Frame, x0: number, x1: number, z0: number, z1: number, y: number, h: number, roofCol: number, soffit: number): void {
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
    // ridge along z: RA at the back (Z0, side C-D), RB at the front (Z1, side A-B)
    face([B, C, RA, RB]); face([D, A, RB, RA]); face([A, B, RB]); face([C, D, RA]);
  }
  // forro do beiral
  const u = [A, B, C, D].map((p) => mb.vert(p[0], p[1], p[2], 0, -1, 0, soffit, BMAT.Plain));
  mb.quad(u[0], u[1], u[2], u[3], 0, -1, 0);
}

/** Facha da (estilo, semente, tipo) para o volume principal. */
function facade(g: Gen, kind: number, colW: number, fh: number): void { setFac(g.mb, g.arch + ARCH_COUNT * g.pattern, g.seed, kind, colW, fh); }

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
  door(mb, f, Math.max(x0 + 1.2, Math.min(x1 - 1.2, off + (hash2(g.seed, 0xd0) & 1 ? -1 : 1) * bw * 0.22)), z1, hi + 0.4, a.trim, false);
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
  if (!modern && r.next() < 0.5) part(f, PART.Tank, x0 + 1.6, top + 0.3, z0 + 1.6, 0, 1);
  else if (modern) part(f, PART.Tank, x0 + 1.6, top + 0.35, z0 + 1.6, 0, 1);
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
  const gateX = r.range(-W / 2 + 2, W / 2 - 5);
  // caminho do portão até a porta
  if (lod < 2) walkway(mb, heights, f, W, D, gateX + 1.6, D / 2 - 0.25, Math.max(x0 + 0.9, Math.min(x1 - 0.9, gateX + 1.6)), z1 + 0.1, 1.2);
  const fh2 = modern ? 1.8 : 1.0;
  lotWall(mb, heights, f, -W / 2, D / 2, gateX, D / 2, fh2, 0.2, fence);
  lotWall(mb, heights, f, gateX + 3.2, D / 2, W / 2, D / 2, fh2, 0.2, fence);
  lotGate(mb, heights, f, gateX, D / 2 - 0.05, gateX + 3.2, D / 2 - 0.05, Math.max(1.2, fh2));
  hillside(g, x0, x1, z0, z1, wallCol, fh, fl, sobrado || modern);
  if (!sobrado) {
    lotWall(mb, heights, f, -W / 2, -D / 2, -W / 2, D / 2, 1.8, 0.18, fence);
    lotWall(mb, heights, f, W / 2, -D / 2, W / 2, D / 2, 1.8, 0.18, fence);
  }
  lotWall(mb, heights, f, -W / 2, -D / 2, W / 2, -D / 2, 1.8, 0.18, fence);
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
  let bw = Math.max(8, Math.min(W - (shop ? 0.6 : 3), 40));
  const bd = Math.max(8, Math.min(D - (shop ? 4 : 7), D > 42 ? 50 : 26));
  const z1 = D / 2 - (shop ? 0.4 : r.range(2.5, 4.5)), z0 = z1 - bd;
  let x0 = -bw / 2, x1 = bw / 2;
  // corner: the building gives 4 m to a side garden on the free side
  const corner = !shop && g.side && (W - bw) / 2 < 4 && bw > 14 ? (g.side & 1 ? -1 : 1) : 0;
  if (corner < 0) x0 += 4; else if (corner > 0) x1 -= 4;
  bw = x1 - x0;
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
  const arcade = g.pattern === Pattern.Arcade && shop;
  if (arcade) {
    // arcade: the shop front 1.8 m in, under the upper floors, with a column on every bay line
    prism(mb, f, x0, x1, z0, z1 - 1.8, f.base, y0 + groundH, wallCol, BMAT.Wall, colW, -1, 0);
    prism(mb, f, x0, x1, z0, z1, y0 + groundH, top, wallCol, BMAT.Wall, colW, roofC, roofC === 0x6f8a55 ? BMAT.Grass : BMAT.RoofFlat, true);
    if (lod < 2) {
      blank(mb);
      const bays = Math.max(1, Math.round(bw / colW)), bwid = bw / bays, pc = shadeHex(a.trim, 0.95);
      for (let k = 0; k <= bays; k++) { const x = Math.max(x0 + 0.25, Math.min(x1 - 0.25, x0 + k * bwid)); prism(mb, f, x - 0.25, x + 0.25, z1 - 0.5, z1, f.base, y0 + groundH, pc, BMAT.Plain, 50, -1, 0); }
      facade(g, kind, colW, fh);
    }
  } else prism(mb, f, x0, x1, z0, z1, f.base, top, wallCol, BMAT.Wall, colW, roofC, roofC === 0x6f8a55 ? BMAT.Grass : BMAT.RoofFlat);
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
    const crown = g.pattern === Pattern.ArtDecoCrown ? Crown.Stepped : a.crown;
    if (crown === Crown.Cornice) { ring(mb, f, tx0, tx1, tz0, tz1, roofY - 0.1, roofY + 0.45, 0.35, trim); parapet(mb, f, tx0, tx1, tz0, tz1, roofY + 0.45, 0.6, 0.25, wallCol); }
    else if (crown === Crown.Slab) ring(mb, f, tx0, tx1, tz0, tz1, roofY, roofY + 0.4, 0.9, shadeHex(wallCol, 0.92));
    else if (crown === Crown.Stepped) { parapet(mb, f, tx0, tx1, tz0, tz1, roofY, 1.6, 0.3, trim); blank(mb); prism(mb, f, (tx0 + tx1) / 2 - 2.1, (tx0 + tx1) / 2 + 2.1, tz1 - 1.1, tz1 + 0.1, roofY, roofY + 3.2, trim, BMAT.Plain, 50, trim, BMAT.Plain); }
    else { blank(mb); parapet(mb, f, tx0, tx1, tz0, tz1, roofY, 1.0, 0.25, wallCol); }
  }
  if (lod > 1) return;
  // pilares e faixas de andar (relevo da fachada)
  if (a.piers) piers(mb, f, x0, x1, z0, z1, y0 + groundH, top, colW, a.piers, shadeHex(wallCol, 1.06));
  else if (g.pattern === Pattern.Gallery) piers(mb, f, x0, x1, z0, z1, y0 + groundH, top, colW, 1, shadeHex(wallCol, 1.08));
  if (a.bands) for (let fl = 1; fl < lower; fl += a.bands) {
    const y = y0 + groundH + (fl - 1) * fh;
    ring(mb, f, x0, x1, z0, z1, y - 0.12, y + 0.08, 0.14, trim, false);
  }
  if (lod === 0) facadeRelief(g, x0, x1, z0, z1, y0, groundH, fh, lower, colW, wallCol, shop);
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
  const balc = a.balcony === Balcony.None && g.pattern === Pattern.Residential && a.win !== Win.Curtain ? Balcony.Alternate : a.balcony;
  if (zone !== Zone.Commercial && floors >= 2 && balc !== Balcony.None) {
    const cols = Math.max(1, Math.round(bw / colW));
    const cw = bw / cols;
    const glassRail = balc === Balcony.Continuous && r.next() < 0.6;
    const railCol = glassRail ? 0x8fb0c0 : r.next() < 0.5 ? 0xe8e8e4 : 0x2c3034;
    const depth = balc === Balcony.Continuous ? 1.4 : 1.0;
    for (let fl = 1; fl < lower; fl++) {
      const y = y0 + groundH + (fl - 1) * fh;
      if (balc === Balcony.Continuous) {
        blank(mb);
        prism(mb, f, x0, x1, z1, z1 + depth, y - 0.18, y, 0xe2e0da, BMAT.Plain, 50, 0xd6d3cc, BMAT.Plain, true);
        if (glassRail) prism(mb, f, x0, x1, z1 + depth - 0.06, z1 + depth, y, y + 1.05, railCol, BMAT.Curtain, 50, railCol, BMAT.Metal);
        else railing(mb, f, x0, x1, z1 + depth, y, railCol);
        // vasos/plantas no estilo tropical
        if (g.arch === ArchId.Tropical) for (let c = 0; c < cols; c += 2) prism(mb, f, x0 + c * cw + 0.3, x0 + c * cw + 1.1, z1 + 0.2, z1 + 0.9, y, y + 0.7, 0x4f7a34, BMAT.Grass, 50, 0x4f7a34, BMAT.Grass);
        for (let c = 0; c < cols; c++) balconyLife(f, g.seed, c, fl, x0 + c * cw, x0 + (c + 1) * cw, z1, depth, y);
        continue;
      }
      for (let c = 0; c < cols; c++) {
        if (balc === Balcony.Alternate && (c + fl) % 2 !== 0) continue;
        const cx0 = x0 + c * cw + cw * a.winSide * 0.6, cx1 = x0 + (c + 1) * cw - cw * a.winSide * 0.6;
        blank(mb);
        prism(mb, f, cx0, cx1, z1, z1 + depth, y - 0.15, y, 0xd8d6d0, BMAT.Plain, 50, 0xcfcdc6, BMAT.Plain, true);
        railing(mb, f, cx0, cx1, z1 + depth, y, railCol);
        if (depth > 0) { prism(mb, f, cx0, cx0 + 0.05, z1, z1 + depth, y + 0.95, y + 1.0, railCol, BMAT.Metal, 50, railCol, BMAT.Metal); prism(mb, f, cx1 - 0.05, cx1, z1, z1 + depth, y + 0.95, y + 1.0, railCol, BMAT.Metal, 50, railCol, BMAT.Metal); }
        balconyLife(f, g.seed, c, fl, cx0, cx1, z1, depth, y);
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
      part(f, PART.WallAc, cx, y, z1, 0, 1);
    }
    // e nos fundos (sorteio próprio: não mexe no da frente)
    const hb = hash2(g.seed, 0xac);
    for (let k = 0; k < (hb & 7); k++) {
      const c = hash2(g.seed, k, 0xb1) % cols, fl = 1 + hash2(g.seed, k, 0xb2) % Math.max(1, lower - 1);
      part(f, PART.WallAc, x0 + (c + 0.5) * (bw / cols), y0 + groundH + (fl - 1) * fh + fh * 0.12, z0, 0, -1);
    }
  }
  // telhado: casa de máquinas, caixa d'água, aparelhos, antena
  blank(mb);
  const mx = r.range(tx0 + 2, Math.max(tx0 + 2.1, tx1 - 6));
  prism(mb, f, mx, mx + 4, tz0 + 2, tz0 + 6, roofY, roofY + 3.0, 0xb8b4ab, BMAT.Plain, 50, 0x8f8b84, BMAT.RoofFlat);
  if (r.next() < 0.8) prism(mb, f, mx + 0.5, mx + 3.5, tz0 + 2.5, tz0 + 5.5, roofY + 3.0, roofY + 4.4, 0x6d7478, BMAT.Plain, 50, 0x6d7478, BMAT.RoofFlat);
  for (let k = 0; k < r.int(1, 5); k++) {
    const ax = r.range(tx0 + 1, tx1 - 2), az = r.range(tz0 + 1, tz1 - 2);
    part(f, PART.RoofAc, ax + 0.6, roofY, az + 0.45, k & 1 ? 1 : 0, k & 1 ? 0 : 1);
  }
  // antena parabólica nos prédios de moradia
  if (zone !== Zone.Commercial && hash2(g.seed, 0xd1) % 10 < 5) part(f, PART.Dish, tx1 - 1.2, roofY, tz1 - 1.2, 0, 1);
  if (r.next() < 0.3) prism(mb, f, mx + 1.9, mx + 2.1, tz0 + 3.9, tz0 + 4.1, roofY + 3, roofY + 8, 0x8a8e92, BMAT.Metal, 50, 0x8a8e92, BMAT.Metal);
  roofClutter(mb, f, r, tx0, tx1, tz0, tz1, roofY, mx);
  // chão do lote e o estacionamento (vagas nos fundos e nas laterais; os carros são peças)
  yard(mb, heights, f, W, D, shop ? 0x9c968c : 0x5c7b42, shop ? BMAT.Paving : BMAT.Grass);
  if (g.rows.length) parkingLots(mb, heights, f, g.rows);
  if (!shop) {
    const fence = 0x9e9a92;
    if (lod < 2) walkway(mb, heights, f, W, D, 0, D / 2 - 0.25, 0, z1 + 0.1, 2.4);
    lotWall(mb, heights, f, -W / 2, D / 2, -1.6, D / 2, 1.2, 0.2, fence);
    lotWall(mb, heights, f, 1.6, D / 2, W / 2, D / 2, 1.2, 0.2, fence);
    lotGate(mb, heights, f, -1.6, D / 2 - 0.05, 1.6, D / 2 - 0.05, 1.4);
    // party walls on the sides and the back
    lotWall(mb, heights, f, -W / 2, -D / 2, W / 2, -D / 2, 2.0, 0.18, fence);
    if (corner >= 0) lotWall(mb, heights, f, -W / 2, -D / 2, -W / 2, D / 2 - 0.2, 2.0, 0.18, fence);
    if (corner <= 0) lotWall(mb, heights, f, W / 2, -D / 2, W / 2, D / 2 - 0.2, 2.0, 0.18, fence);
    if (corner) sideGarden(g, corner, x0, x1, z0, bd, fence);
  }
}

const WIN_TABLE = facadeWindowTable();

/**
 * Janelas em 3D (camada de detalhe): peitoril saliente com a pingadeira e verga em cima de cada janela, nas
 * mesmas colunas e andares que o shader desenha (u em colunas por parede, andares a partir de y0, térreo de
 * loja com 4,4 m). Só a frente e as pontas de cada peça (o fundo encosta na parede).
 */
function windowDetail(mb: MeshBuilder, f: Frame, x0: number, x1: number, z0: number, z1: number, wy0: number, wy1: number,
  base: number, shop: boolean, colW: number, fh: number, arch: number): void {
  const [ww, wLow, wHigh] = WIN_TABLE[arch] ?? WIN_TABLE[0];
  const style = facadeArch(arch);
  const trim = (ARCHES[style] ?? ARCHES[0]).trim;
  const bays = WIN_TABLE[arch]?.[3] ?? 0;
  const ground = shop ? 4.4 : 0;
  const y0 = base;
  const first = Math.max(0, Math.ceil((wy0 - base - ground) / fh - wLow - 1e-3));
  const rows = Math.floor((wy1 - base - ground) / fh - wHigh + 1e-3) + 1;
  if (rows <= first || colW <= 0.5) return;
  blank(mb);
  // peitoril e verga de pedra clara (como no prédio de verdade), puxando um pouco para o acabamento do estilo
  const sillCol = mixHex(0xe4dfd4, trim, 0.15), headCol = mixHex(0xd9d3c7, trim, 0.2);
  const frameCol = FRAME_COLORS[style] ?? 0xe6e6e2;
  const molded = (ARCHES[style] ?? ARCHES[0]).frame, moldCol = mixHex(0xeeeae2, trim, 0.4);
  const corners: Array<[number, number]> = [[x0, z1], [x1, z1], [x1, z0], [x0, z0]];
  const normals: Array<[number, number]> = [[0, 1], [1, 0], [0, -1], [-1, 0]];
  for (let k = 0; k < 4; k++) {
    const [ax, az] = corners[k], [bx, bz] = corners[(k + 1) & 3];
    const len = Math.hypot(bx - ax, bz - az);
    const cols = Math.max(1, Math.round(len / colW)), cw = len / cols;
    const dx = (bx - ax) / len, dz = (bz - az) / len;
    const [nxl, nzl] = normals[k];
    for (let c = 0; c < cols; c++) {
      if ((bays & 4 && c % 3 === 1) || (bays & 8 && c % 3 !== 0)) continue; // the pattern's blank bays
      const u0 = (c + ww) * cw - 0.06, u1 = (c + 1 - ww) * cw + 0.06;
      for (let fl = first; fl < rows; fl++) {
        const yb = y0 + ground + (fl + wLow) * fh, yt = y0 + ground + (fl + wHigh) * fh;
        // só as faces que aparecem (metade da malha: menos para subir à GPU quando a quadra chega)
        ledge(mb, f, ax, az, dx, dz, nxl, nzl, u0 - 0.04, u1 + 0.04, yb - 0.09, yb, 0.16, sillCol, LEDGE_SILL);
        ledge(mb, f, ax, az, dx, dz, nxl, nzl, u0, u1, yt, yt + 0.11, 0.07, headCol, LEDGE_HEAD);
        // moldura de argamassa em volta do vão (estilos com moldura)
        if (molded) {
          ledge(mb, f, ax, az, dx, dz, nxl, nzl, u0 - 0.1, u0 + 0.02, yb, yt + 0.11, 0.035, moldCol, LEDGE_JAMB);
          ledge(mb, f, ax, az, dx, dz, nxl, nzl, u1 - 0.02, u1 + 0.1, yb, yt + 0.11, 0.035, moldCol, LEDGE_JAMB);
        }
        // caixilho: marco em volta do vão, montante no meio das janelas largas e travessa nas altas
        const a0 = (c + ww) * cw, a1 = (c + 1 - ww) * cw, t = 0.06;
        ledge(mb, f, ax, az, dx, dz, nxl, nzl, a0, a0 + t, yb, yt, 0.05, frameCol, LEDGE_JAMB);
        ledge(mb, f, ax, az, dx, dz, nxl, nzl, a1 - t, a1, yb, yt, 0.05, frameCol, LEDGE_JAMB);
        ledge(mb, f, ax, az, dx, dz, nxl, nzl, a0, a1, yt - t, yt, 0.05, frameCol, LEDGE_BAR);
        ledge(mb, f, ax, az, dx, dz, nxl, nzl, a0, a1, yb, yb + t, 0.05, frameCol, LEDGE_BAR);
        if (a1 - a0 > 1.1) { const m = (a0 + a1) / 2; ledge(mb, f, ax, az, dx, dz, nxl, nzl, m - 0.025, m + 0.025, yb, yt, 0.04, frameCol, LEDGE_JAMB); }
        if (yt - yb > 1.7) { const y = yb + (yt - yb) * 0.72; ledge(mb, f, ax, az, dx, dz, nxl, nzl, a0, a1, y - 0.025, y + 0.025, 0.04, frameCol, LEDGE_BAR); }
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
const LEDGE_ALL = 15, LEDGE_SILL = 1 | 2 | 4, LEDGE_HEAD = 1 | 4, LEDGE_JAMB = 1 | 8, LEDGE_BAR = 1 | 2 | 4;
/** Cor do caixilho por estilo: alumínio branco, preto nos contemporâneos, madeira nas casas antigas. */
const FRAME_COLORS: number[] = [];
FRAME_COLORS[ArchId.Colonial] = 0xf2efe8; FRAME_COLORS[ArchId.ArtDeco] = 0x4a4f53; FRAME_COLORS[ArchId.Modernist] = 0xe8e8e4;
FRAME_COLORS[ArchId.Contemporary] = 0x2c3034; FRAME_COLORS[ArchId.Brick] = 0xf2efe8; FRAME_COLORS[ArchId.Tropical] = 0xe8e8e4;
FRAME_COLORS[ArchId.Industrial] = 0x5c6064; FRAME_COLORS[ArchId.ColonialHouse] = 0x6b4a32; FRAME_COLORS[ArchId.Bungalow] = 0xf4f4f0;
FRAME_COLORS[ArchId.ModernHouse] = 0x2c3034; FRAME_COLORS[ArchId.Sobrado] = 0x7a5538; FRAME_COLORS[ArchId.Civic] = 0x3f4448;

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
    part(f, PART.Vent, ax + 0.12, y, az + 0.12, 0, 1);
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
/** treeGeo, without the building's tag (it is the lot's, not the building's: the inside view's cut leaves it). */
function treeGeo(...a: Parameters<typeof treeGeoTagged>): void { untagged(a[0], () => treeGeoTagged(...a)); }
function treeGeoTagged(mb: MeshBuilder, f: Frame, x: number, z: number, y: number, h: number, r: number): void {
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
      // the wing of the L goes back as far as the lot lets it (up to 16 m)
      const wingD = Math.min(16, zf - 3 - bd - (-D / 2 + 0.5)), wingW = Math.min(10, bw);
      if (wingD >= 4) box(-bw / 2, -bw / 2 + wingW, zf - 3 - bd - wingD, zf - 3 - bd, fl * 3.6, 0xf2e6c8, Facade.Punched, 3.4, 3.6);
      if (lod < 2) ring(mb, f, -bw / 2, bw / 2, zf - 3 - bd, zf - 3, y0 + fl * 3.6, y0 + fl * 3.6 + 0.6, 0.3, 0x3d6aa0);
      if (lod > 0) break;
      ground(0x8a8478, BMAT.Paving);
      // court (green floor, a line, fences), beside the wing and behind the block, as big as fits (up to 18 × 16 m)
      const ca = -bw / 2 + wingW + 1, cb = Math.min(ca + 18, W / 2 - 0.5), ct = zf - 3 - bd - 1, cbk = Math.max(ct - 16, -D / 2 + 0.5);
      if (cb - ca >= 8 && ct - cbk >= 8) {
        const cm = (ct + cbk) / 2;
        solid(ca, cb, cbk, ct, y0, y0 + 0.08, 0x2f7a4a);
        solid(ca + 0.5, cb - 0.5, cm - 0.1, cm + 0.1, y0 + 0.08, y0 + 0.1, 0xf2f2ee);
        for (const [a, b2] of [[ca, ca + 0.1], [cb - 0.1, cb]]) solid(a, b2, cbk, ct, y0, y0 + 4, 0x6c7276, BMAT.Fence);
      }
      lotWall(mb, heights, f, -W / 2, zf, W / 2, zf, 2.2, 0.2, 0xe8e2d4);
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
        ring(mb, f, -bw / 2, bw / 2, z1 - bd, z1, y0 + fl * 3.6, y0 + fl * 3.6 + 0.8, 0.2, 0x2f7ab0);
        // cruz vermelha na fachada
        solid(-0.5, 0.5, z1, z1 + 0.15, y0 + fl * 3.6 - 3.2, y0 + fl * 3.6 - 0.4, 0xc8241c);
        solid(-1.4, 1.4, z1, z1 + 0.15, y0 + fl * 3.6 - 2.3, y0 + fl * 3.6 - 1.3, 0xc8241c);
      }
      if (lod > 0) break;
      // marquise da emergência
      solid(-6, 6, z1, z1 + 5, y0 + 3.4, y0 + 3.7, 0xd8d6d0);
      for (const x of [-5.5, 5.5]) solid(x - 0.15, x + 0.15, z1 + 4.6, z1 + 4.9, y0, y0 + 3.4, 0xd8d6d0);
      // helipad on the roof, inside the 0.8 m band
      if (big) { const yh = y0 + fl * 3.6; solid(-6, 6, z1 - bd + 3, z1 - bd + 15, yh, yh + 0.2, 0x4a4d50); solid(-2, 2, z1 - bd + 8.7, z1 - bd + 9.3, yh + 0.2, yh + 0.25, 0xf2f2ee); }
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
      // a 20 × 32 m court, smaller on a smaller lot
      const hw = Math.min(10, W / 2 - 0.5), hd = Math.min(16, D / 2 - 0.5);
      solid(-hw, hw, -hd, hd, y0, y0 + 0.08, 0x2f6a9a);
      solid(-hw + 0.5, hw - 0.5, -0.1, 0.1, y0 + 0.08, y0 + 0.1, 0xf2f2ee);
      for (const z of [-hd + 0.5, hd - 0.5]) solid(-1.5, 1.5, z - 0.1, z + 0.1, y0, y0 + 2.4, 0xf2f2ee, BMAT.Metal);
      if (lod === 0) for (const [a, b2] of [[-hw, -hw + 0.2], [hw - 0.2, hw]]) solid(a, b2, -hd, hd, y0, y0 + 4, 0x6c7276, BMAT.Fence);
      break;
    }
    case Fn.GasStation: {
      // cobertura sobre as bombas, lojinha, totem
      const cz = zf - 9, ch = Math.min(9, W / 2 - 0.6);
      solid(-ch, ch, cz - 6, cz + 6, y0 + 5, y0 + 5.9, 0xf2f2ee);
      // faixa colorida 5 cm acima do teto da cobertura (no mesmo plano, as duas cores piscavam)
      if (lod < 2) solid(-ch - 0.05, ch + 0.05, cz - 6.05, cz + 6.05, y0 + 5.4, y0 + 5.95, r.next() < 0.5 ? 0xc8241c : 0x1f8a4a);
      for (const [x, z] of [[-5, -3], [5, -3], [-5, 3], [5, 3]]) solid(x - 0.25, x + 0.25, cz + z - 0.25, cz + z + 0.25, y0, y0 + 5, 0xd8d6d0);
      if (lod > 0) break;
      for (const [x, z] of [[-5, 0], [5, 0]]) solid(x - 0.6, x + 0.6, cz + z - 1.2, cz + z + 1.2, y0, y0 + 1.6, 0x5a5f63, BMAT.Metal);
      // the shop behind the canopy, as deep as the lot lets it (up to 9 m)
      if (cz - 9 - Math.max(cz - 18, -D / 2 + 0.5) >= 4) box(-W / 2 + 2, -W / 2 + 12, Math.max(cz - 18, -D / 2 + 0.5), cz - 9, 3.6, 0xf2f2ee, Facade.Punched | Facade.ShopBit, 3, 3.6);
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
      // painted bays in front of the entrance, when the lot has room for them (not in the street)
      if (z1 + 9 <= D / 2 - 0.5) for (let x = -W / 2 + 3; x < W / 2 - 3; x += 2.6) solid(x, x + 0.1, z1 + 4, z1 + 9, y0 + 0.02, y0 + 0.05, 0xf2f2ee);
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
      // trees on both sides of the front, those that fit in the lot
      for (let k = 0; k < 6; k++) { const x = bw / 2 + 2 + (k >> 1) * 3; if (x + 2.3 <= W / 2) treeGeo(mb, f, (k % 2 ? 1 : -1) * x, zf - 3, y0, 7, 2.2); }
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
        // garage doors along the front, as many as fit (up to three)
        if (lod < 2) for (let k = 0; k < 3 && -bw / 2 + 6.5 + k * 6 <= bw / 2 - 0.5; k++) solid(-bw / 2 + 2 + k * 6, -bw / 2 + 6.5 + k * 6, z1, z1 + 0.1, y0, y0 + 4.5, 0xa02a1c);
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
  if (g.pattern === Pattern.Observation && lod < 2) {
    // observation: a glass storey round the top, 12 cm proud of the walls, under a thin slab
    setFac(mb, ArchId.Glass, g.seed, Facade.Curtain, 1.6, fh);
    mb.curBase = y - fh;
    prism(mb, f, -tw / 2 - 0.12, tw / 2 + 0.12, zc - td / 2 - 0.12, zc + td / 2 + 0.12, y - fh, y, 0x3d5260, BMAT.Curtain, 1.6, -1, 0);
    blank(mb);
    ring(mb, f, -tw / 2, tw / 2, zc - td / 2, zc + td / 2, y, y + 0.35, 0.6, 0xe8e8e4);
  }
  if (g.arch === ArchId.ArtDeco || g.pattern === Pattern.ArtDecoCrown) {
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
    part(f, PART.RoofAc, ax + 0.75, yP, az + 0.5, 0, 1, 1.2);
  }
  // marquise na entrada e pilastras de pedra na frente do embasamento
  prism(mb, f, -4, 4, z1, z1 + 3, hi + 0.2 + 3.6, hi + 0.2 + 3.85, 0x5a5f63, BMAT.Metal, 50, 0x5a5f63, BMAT.Metal, true);
  {
    const n = Math.max(2, Math.round(pw / 6.4)), step = pw / n, pc = shadeHex(podiumCol, 0.92);
    for (let k = 0; k <= n; k++) { const x = -pw / 2 + k * step; if (Math.abs(x) < 4.4) continue; prism(mb, f, x - 0.35, x + 0.35, z1 - 0.05, z1 + 0.5, f.base, yP - 0.1, pc, BMAT.Plain, 50, pc, BMAT.Plain); }
  }
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
  docks(mb, f, bw, z1, hi, f.base);
  // escritório na frente
  setFac(mb, style, r.nextU32(), Facade.Punched, 3, 3.2);
  prism(mb, f, -bw / 2, -bw / 2 + Math.min(14, bw * 0.4), z1, z1 + 4, f.base, hi + 6.5, 0xe6e2da, BMAT.Wall, 3, 0x8f8b84, BMAT.RoofFlat);
  yard(mb, heights, f, W, D, 0xa7a299, BMAT.Paving);
  const fence = 0x6c7276;
  lotWall(mb, heights, f, -W / 2, D / 2, -W / 2 + 6, D / 2, 2.0, 0.1, fence);
  lotWall(mb, heights, f, -W / 2 + 14, D / 2, W / 2, D / 2, 2.0, 0.1, fence);
  lotWall(mb, heights, f, -W / 2, -D / 2, -W / 2, D / 2, 2.0, 0.1, fence);
  lotWall(mb, heights, f, W / 2, -D / 2, W / 2, D / 2, 2.0, 0.1, fence);
  lotWall(mb, heights, f, -W / 2, -D / 2, W / 2, -D / 2, 2.0, 0.1, fence);
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
function polyPrism(mb: MeshBuilder, f: Frame, pts: Array<[number, number]>, y0: number, y1: number, wallCol: number, colW: number, top: number, topMat: number, wallMat: number = BMAT.Wall): void {
  if (footOut) captureFoot(f, Math.min(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[1])), y0);
  if (layoutOut) captureVolume(mb, f, Math.min(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[1])), y0, y1, wallMat);
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
    const a = mb.vert(wx(f, ax, az), y0, wz(f, ax, az), NX, 0, NZ, wallCol, wallMat);
    const d = mb.vert(wx(f, ax, az), y1, wz(f, ax, az), NX, 0, NZ, wallCol, wallMat);
    mb.curU = cols;
    const b = mb.vert(wx(f, bx, bz), y0, wz(f, bx, bz), NX, 0, NZ, wallCol, wallMat);
    const c = mb.vert(wx(f, bx, bz), y1, wz(f, bx, bz), NX, 0, NZ, wallCol, wallMat);
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
    for (const [ax, az, bx, bz] of [[-W / 2, D / 2, W / 2, D / 2], [-W / 2, -D / 2, W / 2, -D / 2], [-W / 2, -D / 2, -W / 2, D / 2], [W / 2, -D / 2, W / 2, D / 2]]) lotWall(mb, heights, f, ax, az, bx, bz, 2.2, 0.3, 0xe8e2d4);
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
  // the creator's wall finishes (world/design.ts FINISHES) -> the facade grammar; glass walls are curtain glass
  const arch = DESIGN_ARCH[ds.finish] ?? ArchId.Contemporary;
  const wallMat = ds.finish === 2 ? BMAT.Curtain : BMAT.Wall;
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
  const flat = 0x8f8b84, tile = DESIGN_SLATE.has(ds.finish) ? 0x55595e : DESIGN_METAL_ROOF.has(ds.finish) ? 0x7f8b8f : ds.finish === 1 ? 0x6e3b2c : 0x9b4a32;
  mb.curBase = y0;
  const facade = () => { setFac(mb, arch, seed, kind, colW, fh); if (win === 4) blank(mb); };
  facade();
  if (ww) {
    const wf = Math.max(1, Math.round(lower / 3)), wy = y0 + wf * fh;
    for (const side of wing === 3 ? [-1, 1] : wing === 1 ? [-1] : [1]) {
      const x0 = side < 0 ? -bw / 2 : bw / 2 - ww, x1 = x0 + ww, z0 = -bd / 2 + bd * 0.12, z1 = bd / 2;
      facade();
      prism(mb, lf, x0, x1, z0, z1, f.base, wy, wallCol, wallMat, colW, flat, BMAT.RoofFlat);
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
    prism(mb, mf, x0, x1, z0, z1, f.base, top1, wallCol, wallMat, colW, pitched && !set ? -1 : flat, BMAT.RoofFlat);
    if (set && x1 - x0 > inset * 2 + 4 && z1 - z0 > inset * 2 + 4) {
      setFac(mb, arch, seed, kind & 3, colW, fh); if (win === 4) blank(mb);
      prism(mb, mf, x0 + inset, x1 - inset, z0 + inset, z1 - inset, top1, top2, wallCol, wallMat, colW, pitched ? -1 : flat, BMAT.RoofFlat);
      topRects.push([x0 + inset, x1 - inset, z0 + inset, z1 - inset]);
    } else topRects.push([x0, x1, z0, z1]);
  }
  if (poly) {
    polyPrism(mb, mf, poly, f.base, top1, wallCol, colW, pitched && !set ? -1 : flat, BMAT.RoofFlat, wallMat);
    topPoly = poly;
    if (set) {
      const k = 1 - inset * 2 / Math.min(bw, bd);
      topPoly = poly.map(([x, z]) => [x * k, z * k] as [number, number]);
      setFac(mb, arch, seed, kind & 3, colW, fh); if (win === 4) blank(mb);
      polyPrism(mb, mf, topPoly, top1, top2, wallCol, colW, pitched ? -1 : flat, BMAT.RoofFlat, wallMat);
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

// ------------------------------------------------------------ finishes (texture-array layer per vertex)

/** Finish per building material for one building (index = BMAT); 0 = the shader's default for that material. */
const finTable = new Uint8Array(16);

/** Wall finish by style, picked from the seed (a hash, not the generator's Rng: the layout stays as it was). */
const WALL_FINISHES: number[][] = [];
WALL_FINISHES[ArchId.Colonial] = [FIN.Plaster, FIN.Plaster, FIN.Stucco];
WALL_FINISHES[ArchId.ArtDeco] = [FIN.Stucco, FIN.Stone, FIN.Plaster];
WALL_FINISHES[ArchId.Modernist] = [FIN.Ceramic, FIN.Ceramic, FIN.Plaster];
WALL_FINISHES[ArchId.Contemporary] = [FIN.Panel, FIN.Concrete, FIN.Plaster, FIN.Plaster];
WALL_FINISHES[ArchId.Brick] = [FIN.Brick];
WALL_FINISHES[ArchId.Tropical] = [FIN.Ceramic, FIN.Plaster, FIN.Plaster];
WALL_FINISHES[ArchId.Glass] = [FIN.Stone, FIN.Concrete];
WALL_FINISHES[ArchId.Industrial] = [FIN.Concrete, FIN.Plaster];
WALL_FINISHES[ArchId.ColonialHouse] = [FIN.Plaster, FIN.Stucco];
WALL_FINISHES[ArchId.Bungalow] = [FIN.Stucco, FIN.Plaster];
WALL_FINISHES[ArchId.ModernHouse] = [FIN.Concrete, FIN.Plaster, FIN.Plaster, FIN.Wood];
WALL_FINISHES[ArchId.Sobrado] = [FIN.Plaster, FIN.Plaster, FIN.Brick];
WALL_FINISHES[ArchId.Civic] = [FIN.Stone, FIN.Plaster];

/** Creator wall finishes (design.ts FINISHES order) → finish id, and the facade grammar each one draws. */
const DESIGN_FINISH = [FIN.Plaster, FIN.Brick, FIN.Glass, FIN.Concrete, FIN.Metal, FIN.Wood, FIN.Stone, FIN.Ceramic, FIN.Stucco, FIN.Panel];
const DESIGN_ARCH = [ArchId.Colonial, ArchId.Brick, ArchId.Glass, ArchId.Modernist, ArchId.Industrial, ArchId.Tropical, ArchId.ArtDeco, ArchId.Modernist, ArchId.ArtDeco, ArchId.Contemporary];
/** Creator wall finishes whose pitched roof is slate (stone, stucco) or metal sheet (metal, glass, concrete, panel). */
const DESIGN_SLATE = new Set([6, 8]), DESIGN_METAL_ROOF = new Set([2, 3, 4, 9]);

/** The finish of each material of one building (shared table, filled per call). */
export function finishTable(arch: number, seed: number, fn: number, zone: number, ds: Design | null): Uint8Array {
  finTable.fill(0);
  const h = hash2(seed, arch, 0x51f15e);
  const list = WALL_FINISHES[fn ? ArchId.Civic : arch] ?? WALL_FINISHES[ArchId.Colonial];
  let wall = list[h % list.length];
  if (ds) wall = DESIGN_FINISH[ds.finish] ?? FIN.Plaster;
  if (ds) {
    // a design's roofs follow its wall finish, by the player's choice (no draw): every finish is reachable
    finTable[BMAT.Wall] = finTable[BMAT.Shop] = finTable[BMAT.Curtain] = wall;
    finTable[BMAT.Plain] = wall === FIN.Brick || wall === FIN.Ceramic || wall === FIN.Wood || wall === FIN.Panel || wall === FIN.Glass ? FIN.Plaster : wall;
    const hard = DESIGN_METAL_ROOF.has(ds.finish);
    finTable[BMAT.RoofFlat] = hard ? FIN.Concrete : FIN.Roofing;
    finTable[BMAT.RoofTile] = DESIGN_SLATE.has(ds.finish) ? FIN.Slate : hard ? FIN.Metal : FIN.Tile;
    return finTable;
  }
  finTable[BMAT.Wall] = wall;
  finTable[BMAT.Shop] = wall;
  // trim and parapets follow a plain wall; brick, tile, wood and panel buildings get rendered parapets and cornices
  finTable[BMAT.Plain] = wall === FIN.Brick || wall === FIN.Ceramic || wall === FIN.Wood || wall === FIN.Panel ? FIN.Plaster : wall;
  finTable[BMAT.RoofFlat] = (h >>> 8) % 10 < 3 ? FIN.Concrete : FIN.Roofing;
  finTable[BMAT.RoofTile] = (h >>> 12) % 10 < 1 && zone !== Zone.Industrial ? FIN.Slate : FIN.Tile;
  if (zone === Zone.Industrial && !ds) finTable[BMAT.Metal] = FIN.Metal;
  return finTable;
}

/** Writes the finish (high nibble of the material byte) on the vertices of one building. */
function applyFinishes(mb: MeshBuilder, v0: number, table: Uint8Array): void {
  const m = mb.mat;
  for (let i = v0; i < mb.v; i++) { const k = m[i]; if (k < 16) m[i] = k | (table[k] << 4); }
}

/** Vida na sacada (peças do pool): vaso no canto, cadeira, varal; pelo hash da sacada (não usa o sorteio do prédio). */
function balconyLife(f: Frame, seed: number, c: number, fl: number, x0: number, x1: number, z1: number, depth: number, y: number): void {
  if (!partsOut) return;
  const h = hash2(seed ^ 0x5ac, c * 131 + fl, 0x77);
  const k = h % 100;
  if (k < 28) part(f, PART.Vase, x1 - 0.35, y, z1 + depth - 0.35, 0, 1, 0.85 + ((h >>> 8) & 7) * 0.05);
  if (k >= 18 && k < 40) part(f, PART.Chair, x0 + 0.5 + ((h >>> 12) & 3) * 0.15, y, z1 + depth * 0.5, (h >>> 14) & 1 ? 1 : -1, 0.3);
  if (k >= 70 && k < 82 && x1 - x0 > 2) part(f, PART.Clothesline, (x0 + x1) / 2, y, z1 + depth * 0.45, 0, 1, Math.min(1.6, (x1 - x0 - 0.6) / 1.8));
}

/**
 * Relevo da fachada no nível 0 (prédio baixo de apartamentos ou misto): friso de laje em cada andar, brises verticais
 * nos contemporâneos, pilastras entre as vitrines das lojas antigas e a porta de entrada dos prédios de moradia.
 */
function facadeRelief(g: Gen, x0: number, x1: number, z0: number, z1: number, y0: number, groundH: number, fh: number,
  lower: number, colW: number, wallCol: number, shop: boolean): void {
  const { mb, f, a, seed } = g;
  blank(mb);
  const h = hash2(seed, 0xfa);
  // friso de laje (quem não tem faixas do estilo): 14 cm, 6 cm para fora
  // (detail layer only: under a pixel past 220 m, where the shader's slab line takes over)
  const dm = detailOut;
  if (dm && !a.bands && a.win !== Win.Curtain) {
    const fc = shadeHex(wallCol, 0.9);
    for (let fl = 1; fl < lower; fl++) {
      const y = y0 + groundH + (fl - 1) * fh;
      ring(dm, f, x0, x1, z0, z1, y - 0.07, y + 0.07, 0.06, fc, false);
    }
  }
  // brise vertical (lâminas de concreto) na frente dos contemporâneos, metade deles
  if (g.arch === ArchId.Contemporary && h % 2 === 0 && lower >= 3) {
    const cols = Math.max(1, Math.round((x1 - x0) / colW)), cw = (x1 - x0) / cols, bc = shadeHex(wallCol, 1.08);
    for (let c = 0; c <= cols; c++) {
      const x = x0 + c * cw;
      prism(mb, f, x - 0.05, x + 0.05, z1 - 0.02, z1 + 0.55, y0 + groundH, y0 + groundH + (lower - 1) * fh, bc, BMAT.Plain, 50, bc, BMAT.Plain);
    }
  }
  // pilastras entre as vitrines (ruas antigas)
  const classic = g.arch === ArchId.Colonial || g.arch === ArchId.Brick || g.arch === ArchId.ArtDeco;
  if (shop && classic) {
    const bays = Math.max(1, Math.round((x1 - x0) / colW)), bwid = (x1 - x0) / bays, pc = shadeHex(a.trim, 0.94);
    for (let k = 0; k <= bays; k++) { const x = x0 + k * bwid; prism(mb, f, x - 0.18, x + 0.18, z1 - 0.02, z1 + 0.16, f.base, y0 + groundH - 0.3, pc, BMAT.Plain, 50, pc, BMAT.Plain); }
  }
  if (!shop) door(mb, f, 0, z1, y0, a.trim, true);
}

/** Porta de entrada na parede z = z1 (local), centrada em x: marco, folha de madeira e, nos prédios, marquise. */
function door(mb: MeshBuilder, f: Frame, x: number, z1: number, y: number, trim: number, canopy: boolean): void {
  blank(mb);
  const w = canopy ? 1.8 : 1.0, hgt = canopy ? 2.6 : 2.2;

  prism(mb, f, x - w / 2, x + w / 2, z1, z1 + 0.11, y, y + hgt, canopy ? 0x2f3438 : 0x5a3c26, canopy ? BMAT.Metal : BMAT.Plain, 50, -1, 0);
  if (canopy) prism(mb, f, x - w / 2 - 0.6, x + w / 2 + 0.6, z1, z1 + 1.3, y + hgt + 0.25, y + hgt + 0.45, 0xd8d6d0, BMAT.Plain, 50, 0xcfcdc6, BMAT.Plain, true);
  // the frame and the step in the detail layer (near)
  const dm = detailOut;
  if (!dm) return;
  blank(dm);
  prism(dm, f, x - w / 2 - 0.12, x + w / 2 + 0.12, z1 - 0.02, z1 + 0.08, y - 0.05, y + hgt + 0.12, trim, BMAT.Plain, 50, trim, BMAT.Plain);
  prism(dm, f, x - w / 2 - 0.15, x + w / 2 + 0.15, z1, z1 + 0.45, y - 0.15, y + 0.04, 0xbdb7ab, BMAT.Paving, 50, 0xbdb7ab, BMAT.Paving);
}

/**
 * Guarda-corpo de metal ao longo de z (local), de x0 a x1, sobre a laje em y: corrimão, travessa de baixo e
 * montantes a cada ~1,2 m na malha; na camada de detalhe (perto), os balaústres a cada 12 cm.
 */
function railing(mb: MeshBuilder, f: Frame, x0: number, x1: number, z: number, y: number, col: number): void {
  blank(mb);
  prism(mb, f, x0, x1, z - 0.06, z, y + 0.98, y + 1.05, col, BMAT.Metal, 50, col, BMAT.Metal);
  // the handrail in the mesh; the bottom rail, the posts and the balusters in the detail layer (near)
  const det = detailOut;
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

// ------------------------------------------------------------ cell plan: facade patterns and landmarks

/** Landmark towers: the catalog projects that are not civic (index into CATALOG). */
const TOWER_CATALOG: number[] = CATALOG.map((_, k) => k).filter((k) => !CIVIC_CATALOG.has(CATALOG[k].name));
/** Share of commercial towers drawn as a catalog landmark (%). */
const LANDMARK_SHARE = 22;
/** Radius in which a landmark is never repeated (m); the cell colouring keeps it across cell borders. */
const LANDMARK_GAP = 250;
/** Radius of the neighbours a facade pattern is compared with (m). */
const SIGNATURE_RADIUS = 90;

export interface CellPlan { pattern: Uint8Array; landmark: Uint8Array; /** Free side (corner): 1 = -x, 2 = +x. */ side: Uint8Array }

/**
 * Per cell, in a fixed order (seed, then x): each building takes the facade pattern whose signature (style,
 * pattern, height) is least like the buildings already placed within 90 m, and ~22 % of the commercial towers
 * become a catalog landmark. Only buildings of the same cell are read, so a cell, its tile and its plate (L0..L3)
 * and the props job all reach the same plan; neighbouring cells use disjoint quarters of the landmark list
 * (2 x 2 colouring), so the same landmark is never closer than one cell (256 m) across a border.
 */
export function planCells(b: BoxColumns): CellPlan {
  const n = b.count;
  const pattern = new Uint8Array(n), landmark = new Uint8Array(n), arch = new Uint8Array(n), side = new Uint8Array(n);
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    if (b.floors[i] === 0 || b.zone[i] === 0) continue;
    const key = cellId(cellX(b.x[i]), cellX(b.z[i]));
    let list = groups.get(key);
    if (!list) groups.set(key, list = []);
    list.push(i);
  }
  for (const list of groups.values()) {
    list.sort((p, q) => (b.seed[p] - b.seed[q]) || (b.x[p] - b.x[q]));
    const done: number[] = [];
    for (const i of list) {
      const floors = Math.max(1, b.floors[i]), zone = b.zone[i];
      arch[i] = pickArch(zone, floors, b.x[i], b.z[i], b.style[i]);
      const house = arch[i] >= ArchId.ColonialHouse && arch[i] <= ArchId.Sobrado;
      if (b.fn[i] || hasDesign(b.color[i]) || zone === Zone.Industrial || house) { done.push(i); continue; }
      const tower = zone === Zone.Commercial && floors >= 8;
      if (tower && hash2(b.seed[i], 0x1a4d) % 100 < LANDMARK_SHARE) {
        const colour = (cellX(b.x[i]) & 1) | ((cellX(b.z[i]) & 1) << 1);
        const cands = TOWER_CATALOG.filter((_, j) => j % 4 === colour);
        const start = hash2(b.seed[i], 0x77) % cands.length;
        for (let t = 0; t < cands.length && !landmark[i]; t++) {
          const k = cands[(start + t) % cands.length], e = CATALOG[k];
          if (Math.min(b.w[i] / e.w, b.d[i] / e.d) < 0.6) continue;
          const near = done.some((j) => landmark[j] === k + 1 && Math.hypot(b.x[j] - b.x[i], b.z[j] - b.z[i]) < LANDMARK_GAP);
          if (!near) landmark[i] = k + 1;
        }
        if (landmark[i]) { done.push(i); continue; }
      }
      const cands: number[] = tower ? [Pattern.Office, Pattern.Observation, Pattern.ArtDecoCrown, Pattern.ArtDeco]
        : zone === Zone.Commercial || zone === Zone.Mixed ? [Pattern.Storefront, Pattern.Arcade, Pattern.ArtDeco, Pattern.Office, Pattern.Gallery]
          : [Pattern.Residential, Pattern.Gallery, Pattern.ArtDeco, Pattern.Office];
      let best = cands[0], bestScore = Infinity;
      for (let c = 0; c < cands.length; c++) {
        let score = (hash2(b.seed[i], c, 0x51) & 255) / 4096; // tie-break
        for (const j of done) {
          if (Math.hypot(b.x[j] - b.x[i], b.z[j] - b.z[i]) > SIGNATURE_RADIUS) continue;
          score += (arch[j] === arch[i] ? 1 : 0) + (pattern[j] === cands[c] ? 2 : 0) + (Math.abs(b.floors[j] - floors) < 3 ? 0.5 : 0);
        }
        if (score < bestScore) { bestScore = score; best = cands[c]; }
      }
      pattern[i] = best;
      side[i] = freeSides(b, i, list);
      done.push(i);
    }
  }
  return { pattern, landmark, side };
}

/** Catalog finish and fill -> the engine's facade: [facade id, kind, column width]. */
function catalogFacade(fin: number, fill: number, shopGround: boolean): [number, number, number] {
  const style = fin === FIN.Glass ? ArchId.Glass : fin === FIN.Brick ? ArchId.Brick : fin === FIN.Stone ? ArchId.Civic
    : fin === FIN.Ceramic ? ArchId.Modernist : fin === FIN.Stucco ? ArchId.ArtDeco : fin === FIN.Panel || fin === FIN.Metal ? ArchId.Contemporary : ArchId.Colonial;
  const shop = shopGround ? Facade.ShopBit : 0;
  if (fin === FIN.Glass) return [style, Facade.Curtain | shop, 1.6];
  if (fill === CatFill.Wide) return [style + ARCH_COUNT * Pattern.Office, Facade.Punched | shop, 3.2];
  if (fill === CatFill.Ribbon) return [style + ARCH_COUNT * Pattern.Office, Facade.Industrial | shop, 3];
  return [style, Facade.Punched | shop, ARCHES[style].module];
}

/**
 * A building drawn from a catalog project (a Roadcraft 4.0 lot): its volumes in levels (ground storey `gh`, the rest
 * `sh`), each with its finish, colour and facade, flat or terrace roofs with parapets, balconies, doors; open
 * ground (paving, asphalt, grass), trees, planters, lot walls and gates. Scaled in plan to the lot (heights kept).
 */
function catalogBuilding(g: Gen, e: CatalogEntry, wallOverride: number): void {
  const { mb, heights, f, W, D, hi, lod, seed } = g;
  const s = Math.min(1.15, W / e.w, D / e.d);
  const y0 = hi + 0.2;
  const levelY = (k: number) => y0 + (k <= 0 ? 0 : e.gh + (k - 1) * e.sh);
  const X = (x: number) => x * s, Z = (z: number) => D / 2 - z * s;
  mb.curBase = y0;
  const tops: Array<[number, number, number, number, number]> = [];
  // ground: the lot paved, then its open volumes over it
  if (lod < 2) { blank(mb); yard(mb, heights, f, W, D, 0xa9a398, BMAT.Paving); }
  for (const v of e.vols) {
    const [vx, vz, vw, vd, base, storeys, roof, fill, fin, col] = v as number[];
    const x0 = X(vx), x1 = X(vx + vw), z1 = Z(vz), z0 = Z(vz + vd);
    if (!storeys) {
      if (lod > 1) continue;
      groundPatch(mb, heights, f, W, D, x0, x1, z0, z1, fin === 2 ? 0x55585b : fin === 3 ? 0x587a3c : 0xb9b2a6, fin === 3 ? BMAT.Grass : BMAT.Paving, fin === 2 ? 0.05 : 0.04);
      continue;
    }
    const ya = base === 0 ? f.base : levelY(base), yb = levelY(base + storeys);
    const wallCol = wallOverride >= 0 ? wallOverride : col;
    const upper = fill & 7, ground = (fill >> 3) & 7;
    const shopGround = base === 0 && ground === CatFill.Shop;
    const [style, kind, colW] = catalogFacade(fin, upper, shopGround);
    const wallMat = (fin === FIN.Glass ? BMAT.Curtain : BMAT.Wall) | (fin << 4);
    mb.curBase = base === 0 ? y0 : levelY(base);
    const fh = Math.max(2.5, Math.min(5.6, e.sh));
    setFac(mb, style, seed, kind, colW, fh);
    if (upper === CatFill.Wall && ground === CatFill.Wall) blank(mb);
    const outline = v[10] as number[] | undefined;
    if (outline && outline.length >= 6) {
      const pts: Array<[number, number]> = [];
      for (let k = 0; k + 1 < outline.length; k += 2) pts.push([x0 + outline[k] * (x1 - x0), z1 - outline[k + 1] * (z1 - z0)]);
      polyPrism(mb, f, pts, ya, yb, wallCol, colW, 0x8f8b84, BMAT.RoofFlat, wallMat);
      if (lod < 2) for (let k = 0; k < pts.length; k++) wallSeg(mb, f, pts[k][0], pts[k][1], pts[(k + 1) % pts.length][0], pts[(k + 1) % pts.length][1], yb, 0.9, wallCol);
    } else {
      prism(mb, f, x0, x1, z0, z1, ya, yb, wallCol, wallMat, colW, roof ? 0x6f8a55 : e.roof[1] & 0xffffff, roof ? BMAT.Grass : BMAT.RoofFlat | (e.roof[0] << 4));
      if (lod < 2) { blank(mb); parapet(mb, f, x0, x1, z0, z1, yb, roof ? 1.1 : 0.9, 0.22, wallCol); }
      tops.push([x0, x1, z0, z1, yb]);
    }
    if (lod > 0) continue;
    // balconies on the front, every other bay, on every storey above the ground
    if (fill & 64) {
      const cols = Math.max(1, Math.round((x1 - x0) / colW)), cw = (x1 - x0) / cols;
      for (let k = Math.max(1, base); k < base + storeys; k++) {
        const y = levelY(k);
        for (let c = (k & 1); c < cols; c += 2) {
          const cx0 = x0 + c * cw + 0.2, cx1 = x0 + (c + 1) * cw - 0.2;
          blank(mb);
          prism(mb, f, cx0, cx1, z1, z1 + 1.1, y - 0.15, y, 0xd8d6d0, BMAT.Plain, 50, 0xcfcdc6, BMAT.Plain, true);
          railing(mb, f, cx0, cx1, z1 + 1.1, y, 0x2c3034);
          balconyLife(f, seed, c, k, cx0, cx1, z1, 1.1, y);
        }
      }
    }
    if (fill & 128 && base === 0) door(mb, f, (x0 + x1) / 2, z1, y0, e.trim[1], true);
  }
  // the highest roof gets the machine room and the units
  if (tops.length && lod < 2) {
    let t = tops[0];
    for (const q of tops) if (q[4] > t[4]) t = q;
    const [x0, x1, z0, z1, y] = t;
    if (x1 - x0 > 8 && z1 - z0 > 8) {
      blank(mb);
      const mx = (x0 + x1) / 2 - 2;
      prism(mb, f, mx, mx + 4, z0 + 2, z0 + 6, y, y + 3, 0xb8b4ab, BMAT.Plain, 50, 0x8f8b84, BMAT.RoofFlat);
      for (let k = 0; k < 4; k++) part(f, PART.RoofAc, x0 + 1.5 + k * 1.6, y, z1 - 1.5, 0, 1);
    }
  }
  if (lod > 0) return;
  for (const el of e.elems) {
    const [kind, ex, ez, ew, ed, eh] = el;
    const x = X(ex), z = Z(ez), gy = heightAt(heights, wx(f, x, z), wz(f, x, z)) + 0.2;
    if (Math.abs(x) > W / 2 || Math.abs(z) > D / 2) continue;
    if (kind === CatElem.Tree) treeGeo(mb, f, x, z, gy, Math.max(4, eh), Math.max(1.2, ew * 0.4));
    else if (kind === CatElem.Planter || kind === CatElem.Shrub || kind === CatElem.Flowers) {
      blank(mb);
      prism(mb, f, x - ew * s / 2, x + ew * s / 2, z - ed * s / 2, z + ed * s / 2, gy, gy + Math.min(0.6, eh), 0x9d8f7c, BMAT.Plain, 50, 0x4f7a34, BMAT.Grass);
    } else if (kind === CatElem.Wall || kind === CatElem.Fence) {
      const hl = Math.max(ew, ed) * s / 2, h = Math.min(2.2, Math.max(0.8, eh)), col = kind === CatElem.Wall ? 0xd8d0c2 : 0x6c7276;
      if (ew >= ed) wall(mb, heights, f, x - hl, z, x + hl, z, h, 0.2, col);
      else wall(mb, heights, f, x, z - hl, x, z + hl, h, 0.2, col);
    } else if (kind === CatElem.Gate) gate(mb, heights, f, x - Math.max(ew, ed) * s / 2, z, x + Math.max(ew, ed) * s / 2, z, 1.8);
  }
}

/** A patch of lot ground (paving, asphalt, grass) over the lot's ground grid, `lift` above it. */
/** groundPatch, without the building's tag (it is the lot's, not the building's: the inside view's cut leaves it). */
function groundPatch(...a: Parameters<typeof groundPatchTagged>): void { untagged(a[0], () => groundPatchTagged(...a)); }
function groundPatchTagged(mb: MeshBuilder, heights: Float32Array, f: Frame, W: number, D: number, x0: number, x1: number, z0: number, z1: number, col: number, mat: number, lift: number): void {
  const grid = yardGrid(heights, f, W, D);
  const cx = (a: number) => Math.max(-W / 2, Math.min(W / 2, a)), cz = (a: number) => Math.max(-D / 2, Math.min(D / 2, a));
  x0 = cx(x0); x1 = cx(x1); z0 = cz(z0); z1 = cz(z1);
  if (x1 - x0 < 0.5 || z1 - z0 < 0.5) return;
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
function gate(...a: Parameters<typeof gateTagged>): void { untagged(a[0], () => gateTagged(...a)); }
function gateTagged(mb: MeshBuilder, heights: Float32Array, f: Frame, ax: number, az: number, bx: number, bz: number, h: number): void {
  blank(mb);
  const len = Math.hypot(bx - ax, bz - az);
  if (len < 0.5) return;
  const gy = heightAt(heights, wx(f, (ax + bx) / 2, (az + bz) / 2), wz(f, (ax + bx) / 2, (az + bz) / 2));
  const col = 0x3a3f43, x0 = Math.min(ax, bx), z = (az + bz) / 2;
  prism(mb, f, x0, x0 + len, z - 0.03, z + 0.03, gy + h - 0.06, gy + h, col, BMAT.Metal, 50, col, BMAT.Metal);
  prism(mb, f, x0, x0 + len, z - 0.03, z + 0.03, gy + 0.08, gy + 0.14, col, BMAT.Metal, 50, col, BMAT.Metal);
  // the bars in the detail layer (near): from afar the gate reads by its rails
  const dm = detailOut;
  if (!dm) return;
  blank(dm);
  for (let u = 0.06; u < len; u += 0.14) ledge(dm, f, x0, z - 0.015, 1, 0, 0, 1, u - 0.015, u + 0.015, gy + 0.08, gy + h, 0.03, col, LEDGE_JAMB);
}

/**
 * Sides of a lot with no neighbour (a corner): only trusted 40 m or more inside the cell (the neighbours across the
 * border are not read), so a cell border never makes a false corner.
 */
function freeSides(b: BoxColumns, i: number, list: number[]): number {
  const c = Math.cos(b.rot[i]), s = Math.sin(b.rot[i]), W = b.w[i], D = b.d[i];
  const ox = cellOriginX(cellX(b.x[i])), oz = cellOriginX(cellX(b.z[i]));
  let out = 0;
  for (const sx of [-1, 1]) {
    // the point 30 m out on that side, in the world
    const px = b.x[i] + sx * (W / 2 + 30) * c, pz = b.z[i] - sx * (W / 2 + 30) * s;
    if (px - ox < 40 || ox + CELL_SIZE - px < 40 || pz - oz < 40 || oz + CELL_SIZE - pz < 40) continue;
    let taken = false;
    for (const j of list) {
      if (j === i) continue;
      const dx = b.x[j] - b.x[i], dz = b.z[j] - b.z[i];
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      if (Math.sign(lx) === sx && Math.abs(lx) < W / 2 + Math.max(b.w[j], b.d[j]) / 2 + 6 && Math.abs(lz) < D / 2 + 4) { taken = true; break; }
    }
    if (!taken) out |= sx < 0 ? 1 : 2;
  }
  return out;
}

/** Side garden of a corner lot: lawn strip, two trees, a low wall with planters along the side street. */
function sideGarden(g: Gen, corner: number, x0: number, x1: number, z0: number, bd: number, fence: number): void {
  const { mb, heights, f, W, D } = g;
  const gx0 = corner < 0 ? -W / 2 + 0.3 : x1 + 0.4, gx1 = corner < 0 ? x0 - 0.4 : W / 2 - 0.3;
  groundPatch(mb, heights, f, W, D, gx0, gx1, z0, D / 2 - 0.4, 0x5f8a3e, BMAT.Grass, 0.06);
  const gxm = (gx0 + gx1) / 2;
  for (const zt of [z0 + bd * 0.3, z0 + bd * 0.75]) treeGeo(mb, f, gxm, zt, heightAt(heights, wx(f, gxm, zt), wz(f, gxm, zt)) + 0.2, 6.5, 1.8);
  const ws = corner < 0 ? -W / 2 + 0.1 : W / 2 - 0.1;
  wall(mb, heights, f, ws, -D / 2, ws, D / 2 - 0.2, 0.7, 0.25, fence);
  for (let zz = z0 + 1; zz < D / 2 - 1; zz += 2.4) part(f, PART.Vase, ws - corner * 0.6, heightAt(heights, wx(f, ws, zz), wz(f, ws, zz)) + 0.2, zz, -corner, 0, 1.3);
}

/**
 * Hillside house: on a lot that drops to the street, a garage under the house with its door and drive; on one that
 * rises at the back, a half-level wing; on a steep lot, a stone retaining wall across the back yard.
 */
function hillside(g: Gen, x0: number, x1: number, z0: number, z1: number, wallCol: number, fh: number, fl: number, plainBox: boolean): void {
  const { mb, heights, f, W, D, hi } = g;
  const at = (lx: number, lz: number) => heightAt(heights, wx(f, lx, lz), wz(f, lx, lz));
  const gx = x0 + 1.9, front = at(gx, z1 + 0.6), back = at((x0 + x1) / 2, -D / 2 + 1);
  const floorY = hi + 0.4;
  if (floorY - front > 2.3 && x1 - x0 > 6) {
    blank(mb);
    prism(mb, f, gx - 1.55, gx + 1.55, z1 - 0.02, z1 + 0.1, front - 0.1, front + Math.min(2.6, floorY - front - 0.15), 0xd6d3cc, BMAT.Plain, 50, -1, 0);
    prism(mb, f, gx - 1.4, gx + 1.4, z1, z1 + 0.13, front, front + Math.min(2.45, floorY - front - 0.3), 0x6c7276, BMAT.Metal, 50, -1, 0);
    walkway(mb, heights, f, W, D, gx, D / 2 - 0.25, gx, z1 + 0.15, 2.8);
  }
  if (!plainBox && back - front > 2.2 && z0 - 4 > -D / 2 + 1.5) {
    mb.curBase = floorY;
    setFac(mb, g.arch, g.seed, Facade.House, g.a.module, fh);
    const top = floorY + fh * (fl + 0.5);
    prism(mb, f, x0 + 0.05, x1 - 0.05, z0 - 4, z0 + 0.05, back - 0.4, top, shadeHex(wallCol, 0.95), BMAT.Wall, g.a.module, 0x8f8b84, BMAT.RoofFlat);
    blank(mb);
    parapet(mb, f, x0 + 0.05, x1 - 0.05, z0 - 4, z0 + 0.05, top, 0.6, 0.2, wallCol);
  }
  const lo = Math.min(front, back), hiG = Math.max(front, back);
  if (hiG - lo > 2.5) {
    const zr = Math.max(-D / 2 + 1.5, z0 - 2.5);
    wall(mb, heights, f, -W / 2 + 0.2, zr, W / 2 - 0.2, zr, 1.1, 0.35, 0x8a8478);
  }
}

/** Loading docks on a warehouse front: platform, roller doors, bumpers and a canopy. */
function docks(mb: MeshBuilder, f: Frame, bw: number, z1: number, hi: number, base: number): void {
  const n = Math.min(4, Math.floor(bw * 0.5 / 4.5));
  if (n < 1) return;
  blank(mb);
  const xe = bw / 2 - 1, xs = xe - n * 4.5, yd = hi + 1.2;
  prism(mb, f, xs, xe, z1, z1 + 2.4, base, yd, 0xb4b0a8, BMAT.Plain, 50, 0xa9a59d, BMAT.Paving);
  for (let k = 0; k < n; k++) {
    const xd = xs + 0.65 + k * 4.5;
    prism(mb, f, xd, xd + 3.2, z1 - 0.02, z1 + 0.07, yd, yd + 3.4, 0x5a6066, BMAT.Metal, 50, -1, 0);
    for (const xb of [xd - 0.25, xd + 3.25]) prism(mb, f, xb - 0.12, xb + 0.12, z1 + 2.4, z1 + 2.55, yd - 0.6, yd - 0.1, 0x1e1f21, BMAT.Plain, 50, 0x1e1f21, BMAT.Plain);
  }
  prism(mb, f, xs - 0.3, xe + 0.3, z1, z1 + 3.4, yd + 3.8, yd + 4.0, 0x9aa4ab, BMAT.Metal, 50, 0x9aa4ab, BMAT.Metal, true);
}

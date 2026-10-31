import { Rng } from '../../core/rng.ts';
import { Zone } from '../../roads/zones.ts';
import {  } from '../../world/heights.ts';
import { MeshBuilder } from '../meshBuilder.ts';
import { ArchId, Pattern } from '../../world/arch.ts';
import { GEAR, footprint, type Design } from '../../world/design.ts';
import { FIN } from '../buildingFinishes.ts';
import {  } from './polygon.ts';
import { BMAT, Facade } from './materials.ts';
import { blank, gable, nx, nz, shadeHex, wx, wz, type Frame } from './geometry.ts';
import { DESIGN_ARCH, DESIGN_METAL_ROOF, DESIGN_SLATE } from './finishes.ts';
import { setFac } from './windows.ts';
import { PART, captureFoot, captureVolume, parapet, part, piers, prism, ring } from './shell.ts';
import { lotWall, yard } from './lot.ts';
import type { GenContext } from './context.ts';
import { METAL, PLASTER, facade, hip } from './plans.ts';
export function tower(g: GenContext): void {
  const { mb, heights, f, W, D, floors, a, r, hi, lod } = g;
  const skin = a.walls[r.int(0, a.walls.length)];
  const podiumCol = a.base >= 0 ? a.base : PLASTER[r.int(0, PLASTER.length)];
  const fh = a.floorH;
  const podium = 2;
  // a deep lot downtown: the podium reaches the back (no lawn behind the tower)
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
  // the entrance canopy (4.0 door canopy: a concrete slab, 0xaaa99d) and stone piers along the podium
  blank(mb);
  prism(mb, f, -4, 4, z1, z1 + 3, hi + 0.2 + 3.6, hi + 0.2 + 3.85, 0xaaa99d, BMAT.Plain | (FIN.Concrete << 4), 50, 0xaaa99d, BMAT.Plain | (FIN.Concrete << 4), true);
  {
    const n = Math.max(2, Math.round(pw / 6.4)), step = pw / n, pc = shadeHex(podiumCol, 0.92);
    for (let k = 0; k <= n; k++) { const x = -pw / 2 + k * step; if (Math.abs(x) < 4.4) continue; prism(mb, f, x - 0.35, x + 0.35, z1 - 0.05, z1 + 0.5, f.base, yP - 0.1, pc, BMAT.Plain, 50, pc, BMAT.Plain); }
  }
  yard(mb, heights, f, W, D, 0xa29c92, BMAT.Paving);
}

export function warehouse(mb: MeshBuilder, heights: Float32Array, f: Frame, W: number, D: number, floors: number, style: number, r: Rng, hi: number, lod: number): void {
  const metal = METAL[r.int(0, METAL.length)];
  const bw = Math.max(12, W - r.range(4, 10)), bd = Math.max(14, D - r.range(8, 16));
  const z1 = D / 2 - r.range(6, 10), z0 = z1 - bd;
  const h = 6 + floors * 2.5 + r.range(0, 2);
  mb.curBase = hi;
  setFac(mb, style, r.nextU32(), Facade.Industrial, 4, 5.6);
  prism(mb, f, -bw / 2, bw / 2, z0, z1, f.base, hi + h, metal, BMAT.Metal, 4, 0x9da3a6, BMAT.RoofFlat);
  // sawtooth roof
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
  // the office at the front
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

/** A brick chimney with a white and red ring at the top (the smoke comes out of it). */
export function chimney(mb: MeshBuilder, f: Frame, x: number, z: number, y0: number, y1: number, lod: number): void {
  blank(mb);
  const r0 = 1.3, r1 = 0.9;
  if (lod >= 2) { prism(mb, f, x - r0, x + r0, z - r0, z + r0, y0, y1, 0x8c4430, BMAT.Plain, 4, 0x2a2624, BMAT.RoofFlat); return; }
  // a tapering shaft: three sections
  const H = y1 - y0;
  for (let k = 0; k < 3; k++) {
    const r = r0 + (r1 - r0) * (k / 2);
    prism(mb, f, x - r, x + r, z - r, z + r, y0 + H * k / 3, y0 + H * (k + 1) / 3 - (k === 2 ? 2.2 : 0), 0x9a4a32, BMAT.Plain, 4, -1, BMAT.RoofFlat);
  }
  prism(mb, f, x - r1 - 0.1, x + r1 + 0.1, z - r1 - 0.1, z + r1 + 0.1, y1 - 2.2, y1 - 1.1, 0xf2f2ee, BMAT.Plain, 4, -1, BMAT.RoofFlat);
  prism(mb, f, x - r1 - 0.1, x + r1 + 0.1, z - r1 - 0.1, z + r1 + 0.1, y1 - 1.1, y1, 0xb8322c, BMAT.Plain, 4, 0x1e1a18, BMAT.RoofFlat);
}

// ------------------------------------------------------------ the player's design (creator)

/** A prism on a polygonal (convex) plan, walls with facade coordinates; an optional fan-shaped top. */
export function polyPrism(mb: MeshBuilder, f: Frame, pts: Array<[number, number]>, y0: number, y1: number, wallCol: number, colW: number, top: number, topMat: number, wallMat: number = BMAT.Wall): void {
  const sink = f.out;
  if (sink?.foot) captureFoot(sink, f, Math.min(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[1])), y0);
  if (sink?.layout) captureVolume(sink, mb, f, Math.min(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[1])), y0, y1, wallMat);
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

/** A pyramid over the polygonal plan (a polygon roof). */
export function pyramid(mb: MeshBuilder, f: Frame, pts: Array<[number, number]>, y: number, h: number, col: number): void {
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

/** A shed roof: high at the back, falling towards the front. */
export function shed(mb: MeshBuilder, f: Frame, x0: number, x1: number, z0: number, z1: number, y: number, h: number, roofCol: number, wallCol: number): void {
  const o = 0.4;
  const P = (lx: number, ly: number, lz: number, n: [number, number, number], col: number, mat: number) =>
    mb.vert(wx(f, lx, lz), ly, wz(f, lx, lz), nx(f, n[0], n[2]), n[1], nz(f, n[0], n[2]), col, mat);
  const slope = h / (z1 - z0), nl = Math.hypot(1, slope);
  const n: [number, number, number] = [0, 1 / nl, slope / nl];
  const a = P(x0 - o, y, z1 + o, n, roofCol, BMAT.RoofTile), b = P(x1 + o, y, z1 + o, n, roofCol, BMAT.RoofTile);
  const c = P(x1 + o, y + h, z0 - o, n, roofCol, BMAT.RoofTile), d = P(x0 - o, y + h, z0 - o, n, roofCol, BMAT.RoofTile);
  mb.quad(a, b, c, d, nx(f, 0, n[2]), n[1], nz(f, 0, n[2]));
  // the high back wall and the two side triangles
  const nb: [number, number, number] = [0, 0, -1];
  const e = P(x0, y, z0, nb, wallCol, BMAT.Plain), g = P(x1, y, z0, nb, wallCol, BMAT.Plain), hh = P(x1, y + h, z0, nb, wallCol, BMAT.Plain), i = P(x0, y + h, z0, nb, wallCol, BMAT.Plain);
  mb.quad(g, e, i, hh, nx(f, 0, -1), 0, nz(f, 0, -1));
  for (const [xx, sx] of [[x0, -1], [x1, 1]] as Array<[number, number]>) {
    const ns: [number, number, number] = [sx, 0, 0];
    mb.tri(P(xx, y, z0, ns, wallCol, BMAT.Plain), P(xx, y, z1, ns, wallCol, BMAT.Plain), P(xx, y + h, z0, ns, wallCol, BMAT.Plain), nx(f, sx, 0), 0, nz(f, sx, 0));
  }
}

/** Sawtooth (a shed lit from the back): sheds in a row along the front. */
export function sawtooth(mb: MeshBuilder, f: Frame, x0: number, x1: number, z0: number, z1: number, y: number, roofCol: number, wallCol: number): void {
  const n = Math.max(2, Math.round((z1 - z0) / 7));
  const step = (z1 - z0) / n;
  for (let k = 0; k < n; k++) shed(mb, f, x0, x1, z0 + k * step, z0 + (k + 1) * step, y, Math.min(3.2, step * 0.45), roofCol, k % 2 ? 0xbfd3dc : wallCol);
}

/** Cemetery (wall, paths, rows of graves, chapel) and playground (ground, play equipment). */
export function design(g: GenContext, ds: Design): void {
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
  // wing: the main body narrows and the wing (a third of the floors) takes the side
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
  // the lower volumes (up to the setback) and, if any, the set-back floor (2.5 m in)
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
  // rooftop gear (only on flat roofs and the terrace; spire and antenna on any)
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
    // spire: base, a shaft in three tapering sections
    prism(mb, mf, cx - 1.6, cx + 1.6, cz - 1.6, cz + 1.6, peak, peak + 2.5, wallCol, BMAT.Plain, 50, -1, BMAT.RoofFlat);
    for (let q = 0; q < 3; q++) { const r = 1 - q * 0.3; prism(mb, mf, cx - r, cx + r, cz - r, cz + r, peak + 2.5 + q * 4, peak + 6.5 + q * 4, 0xc8c3b4, BMAT.Metal, 50, -1, BMAT.Metal); }
    prism(mb, mf, cx - 0.12, cx + 0.12, cz - 0.12, cz + 0.12, peak + 14.5, peak + 22, 0xd9d4c4, BMAT.Metal, 50, 0xd9d4c4, BMAT.Metal);
  }
  if (ds.gear & GEAR.Antenna) prism(mb, mf, rx0 + 2, rx0 + 2.2, rz1 - 2.2, rz1 - 2, peak, peak + 14, 0x9aa4ab, BMAT.Metal, 50, 0x9aa4ab, BMAT.Metal);
}

/** A straight low wall between two roof points (the parapet of a polygonal plan). */
export function wallSeg(mb: MeshBuilder, f: Frame, ax: number, az: number, bx: number, bz: number, y: number, h: number, col: number): void {
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




// ------------------------------------------------------------ catalog projects (the 38 Roadcraft 4.0 lots, whole)

/** Catalog finish (CAT_FINISHES index) → finish id. */
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

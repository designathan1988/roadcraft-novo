import { hash2 } from '../../core/rng.ts';
import { Zone } from '../../roads/zones.ts';
import { heightAt } from '../../world/heights.ts';
import { MeshBuilder } from '../meshBuilder.ts';
import { ARCH_COUNT, ArchId, Balcony, Crown, Pattern, Win } from '../../world/arch.ts';
import { FIN } from '../buildingFinishes.ts';
import { FLAT_ROOFS, ROOF_COLOURS, planRoofPlant, type RoofPlantItem } from '../../world/roofPlant.ts';
import {  } from './polygon.ts';
import { BMAT, Facade } from './materials.ts';
import { AWNINGS, GOURMET_OUT, PARAPET_H, PARAPET_T, awning, blank, copingOf, gable, pitchedRoof, shadeHex, wx, wz, type Frame } from './geometry.ts';
import { setFac } from './windows.ts';
import { PART, balconyLife, captureFoot, door, parapet, part, piers, prism, railing, ring, facadeRelief } from './shell.ts';
import { groundPatch, lotGate, lotWall, parkingLots, wall, walkway, yard } from './lot.ts';
import type { GenContext } from './context.ts';
export const P_TREE = 0, P_BUSH = 2, P_LAMP = 3, P_BENCH = 6, P_BIN = 7, P_FURN = 11;
export const F_DRAIN = 3, F_BOLLARD = 4, F_PLANTER = 5;
export const PLASTER = [0xece6da, 0xe3d6bd, 0xd9c7a6, 0xc9b79c, 0xb7b1a7, 0xdcd2c2, 0xe7d8c9, 0xc2c6c8, 0xd6c3a5, 0xefe9df, 0xc9a98a, 0xa9b4b8, 0xe2cfb4, 0xd0b48f];
export const TILE = [0x9b4a32, 0x8a3f2b, 0x6e3b2c, 0x5a5d61, 0x7a4a36, 0xa65a3c];
export const METAL = [0xb9bec2, 0x9aa4ab, 0xc7c2b8, 0x8f9aa0, 0xd0d3d4, 0x7f8b7a];
/**
 * The plant on a flat roof (4.0 emitRoofPlant, buildingMesh.ts:1903-1993, planned by world/roofPlant.ts): the big
 * pieces in the mesh (lift room, water tank box, hatch, air handlers, solar arrays, skylights, chimney), the repeated
 * ones from the props pool (condensers, fibreglass tanks, dishes, vents), the thin ones near only (doors, lids,
 * ladders, fans, masts, drains).
 */
export function roofPlant(g: GenContext, items: readonly RoofPlantItem[], x0: number, x1: number, z0: number, z1: number, y: number, trim: number): void {
  const { mb, f } = g;
  const dm = f.out?.detail;
  const PLANT = BMAT.Plain | (FIN.Concrete << 4), METAL = BMAT.Metal | (FIN.Metal << 4), GLASS = BMAT.Plain | (FIN.Glass << 4);
  const box = (m: MeshBuilder, a0: number, a1: number, b0: number, b1: number, ya: number, yb: number, col: number, mat: number, top = col, topMat = mat): void =>
    prism(m, f, a0, a1, b0, b1, ya, yb, col, mat, 50, top, topMat);
  blank(mb);
  if (dm) {
    blank(dm);
    // drains in two opposite corners
    for (const [dx, dz] of [[x0 + 0.7, z0 + 0.7], [x1 - 0.7, z1 - 0.7]]) box(dm, dx - 0.18, dx + 0.18, dz - 0.18, dz + 0.18, y, y + 0.02, ROOF_COLOURS.drain, METAL);
  }
  for (const it of items) {
    const cx = (it.x0 + it.x1) / 2, cz = (it.z0 + it.z1) / 2, w = it.x1 - it.x0, d = it.z1 - it.z0;
    switch (it.kind) {
      case 'liftRoom':
        box(mb, it.x0, it.x1, it.z0, it.z1, y, y + it.h, trim, BMAT.Plain, ROOF_COLOURS.plant, PLANT);
        if (dm) box(dm, cx - 0.45, cx + 0.45, it.z1, it.z1 + 0.04, y + 0.05, y + 2.1, 0x5c6468, METAL);
        break;
      case 'tankBox':
        box(mb, it.x0, it.x1, it.z0, it.z1, y, y + it.h, trim, BMAT.Plain, ROOF_COLOURS.plant, PLANT);
        if (dm) {
          box(dm, it.x0 + 0.3, it.x0 + 1.1, it.z0 + 0.3, it.z0 + 1.1, y + it.h, y + it.h + 0.12, ROOF_COLOURS.drain, METAL);
          box(dm, it.x1, it.x1 + 0.05, cz - 0.25, cz + 0.25, y, y + it.h + 0.9, ROOF_COLOURS.drain, METAL);
        }
        break;
      case 'tank':
        box(mb, it.x0, it.x1, it.z0, it.z1, y, y + 0.3, ROOF_COLOURS.plant, PLANT);
        part(f, PART.Tank, cx, y + 0.3, cz, 0, 1, Math.min(w, d) / 1.9);
        break;
      case 'hatch': box(mb, it.x0, it.x1, it.z0, it.z1, y, y + it.h, ROOF_COLOURS.plant, PLANT); break;
      case 'condenser': part(f, PART.RoofAc, cx, y, cz, w > d ? 0 : 1, w > d ? 1 : 0); break;
      case 'airHandler': {
        box(mb, it.x0, it.x1, it.z0, it.z1, y + 0.2, y + it.h, ROOF_COLOURS.condenser, METAL);
        if (dm) {
          const along = w >= d, r = Math.min(w, d) * 0.32;
          for (const k of [0.25, 0.75]) { const fx = along ? it.x0 + w * k : cx, fz = along ? cz : it.z0 + d * k; box(dm, fx - r, fx + r, fz - r, fz + r, y + it.h, y + it.h + 0.12, ROOF_COLOURS.drain, METAL); }
        }
        break;
      }
      case 'solar': {
        const rows = Math.max(1, Math.floor(d / 1.7));
        for (let q = 0; q < rows; q++) {
          const pz = it.z0 + q * (d / rows);
          for (let px = it.x0; px + 1.05 <= it.x1 + 1e-6; px += 1.15) {
            box(mb, px, px + 1.05, pz, pz + Math.min(1.6, d / rows - 0.1), y + 0.25, y + 0.32, ROOF_COLOURS.solar, GLASS);
            if (dm) box(dm, px + 0.45, px + 0.6, pz + 1.2, pz + 1.35, y, y + 0.25, ROOF_COLOURS.drain, METAL);
          }
        }
        break;
      }
      case 'mast':
        if (dm) {
          box(dm, cx - 0.04, cx + 0.04, cz - 0.04, cz + 0.04, y, y + it.h, ROOF_COLOURS.drain, METAL);
          box(dm, cx - 0.6, cx + 0.6, cz - 0.02, cz + 0.02, y + it.h - 0.4, y + it.h - 0.36, ROOF_COLOURS.drain, METAL);
          if (it.variant % 2 === 1) box(dm, cx - 0.02, cx + 0.02, cz - 0.45, cz + 0.45, y + it.h - 0.9, y + it.h - 0.86, ROOF_COLOURS.drain, METAL);
        }
        break;
      case 'dish': part(f, PART.Dish, cx, y, cz, 0, 1); break;
      case 'skylight': box(mb, it.x0, it.x1, it.z0, it.z1, y, y + it.h, ROOF_COLOURS.plant, PLANT, ROOF_COLOURS.skylight, GLASS); break;
      case 'vent': part(f, PART.Vent, cx, y, cz, 0, 1); break;
      case 'chimney': box(mb, cx - 0.4, cx + 0.4, cz - 0.4, cz + 0.4, y, y + it.h, ROOF_COLOURS.chimney, BMAT.Plain | (FIN.Brick << 4), ROOF_COLOURS.drain, METAL); break;
    }
  }
}


export function hip(mb: MeshBuilder, f: Frame, x0: number, x1: number, z0: number, z1: number, y: number, h: number, roofCol: number, trim: number): void {
  pitchedRoof(mb, f, x0, x1, z0, z1, y, h, roofCol, trim, trim, true);
}

/** Facha da (estilo, semente, tipo) para o volume principal. */
export function facade(g: GenContext, kind: number, colW: number, fh: number): void { setFac(g.mb, g.arch + ARCH_COUNT * g.pattern, g.seed, kind, colW, fh); }

export function house(g: GenContext): void {
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
  else gable(mb, f, x0, x1, z0, z1, top, r.range(1.8, 3.0), roofCol, wallCol, bw >= bd, a.trim);
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
export function block(g: GenContext): void {
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
  // the membrane: 4.0 FLAT_ROOFS (materials.ts:84-92), the concrete one in concrete
  const roofC = FLAT_ROOFS[r.int(0, FLAT_ROOFS.length)];
  const roofMat = roofC === 0x9d9a92 ? BMAT.RoofFlat | (FIN.Concrete << 4) : BMAT.RoofFlat;
  const arcade = g.pattern === Pattern.Arcade && shop;
  if (arcade) {
    // arcade: the shop front 1.8 m in, under the upper floors, with a column on every bay line
    prism(mb, f, x0, x1, z0, z1 - 1.8, f.base, y0 + groundH, wallCol, BMAT.Wall, colW, -1, 0);
    prism(mb, f, x0, x1, z0, z1, y0 + groundH, top, wallCol, BMAT.Wall, colW, roofC, roofMat, true);
    if (lod < 2) {
      blank(mb);
      const bays = Math.max(1, Math.round(bw / colW)), bwid = bw / bays, pc = shadeHex(a.trim, 0.95);
      for (let k = 0; k <= bays; k++) { const x = Math.max(x0 + 0.25, Math.min(x1 - 0.25, x0 + k * bwid)); prism(mb, f, x - 0.25, x + 0.25, z1 - 0.5, z1, f.base, y0 + groundH, pc, BMAT.Plain, 50, -1, 0); }
      facade(g, kind, colW, fh);
    }
  } else prism(mb, f, x0, x1, z0, z1, f.base, top, wallCol, BMAT.Wall, colW, roofC, roofMat);
  let roofY = top, tx0 = x0, tx1 = x1, tz0 = z0, tz1 = z1;
  for (let s = 0; s < steps; s++) {
    const n = Math.min(2, floors - lower - s * 2);
    if (n <= 0) break;
    const k = 2.2 + s * 1.2;
    tx0 += k; tx1 -= k; tz0 += k * 0.7; tz1 -= k;
    if (tx1 - tx0 < 6 || tz1 - tz0 < 6) break;
    facade(g, kind & 3, colW, fh);
    prism(mb, f, tx0, tx1, tz0, tz1, roofY, roofY + n * fh, wallCol, BMAT.Wall, colW, roofC, roofMat);
    if (lod < 2) { blank(mb); parapet(mb, f, tx0 - k, tx1 + k, tz0 - k * 0.7, tz1 + k, roofY, PARAPET_H, PARAPET_T, wallCol, shadeHex(roofC, 0.9), copingOf(trim)); }
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
    // every flat roof ends in the 4.0 parapet, 0.85 m over the roof (the cornice and the slab crown under it)
    const pin = shadeHex(roofC, 0.9), pco = copingOf(trim);
    if (crown === Crown.Cornice) { ring(mb, f, tx0, tx1, tz0, tz1, roofY - 0.1, roofY + 0.45, 0.35, trim); parapet(mb, f, tx0, tx1, tz0, tz1, roofY + 0.45, PARAPET_H - 0.45, PARAPET_T, wallCol, pin, pco); }
    else if (crown === Crown.Slab) { ring(mb, f, tx0, tx1, tz0, tz1, roofY, roofY + 0.4, 0.9, shadeHex(wallCol, 0.92)); parapet(mb, f, tx0, tx1, tz0, tz1, roofY + 0.4, PARAPET_H - 0.4, PARAPET_T, wallCol, pin, pco); }
    else if (crown === Crown.Stepped) { parapet(mb, f, tx0, tx1, tz0, tz1, roofY, 1.6, 0.3, trim); blank(mb); prism(mb, f, (tx0 + tx1) / 2 - 2.1, (tx0 + tx1) / 2 + 2.1, tz1 - 1.1, tz1 + 0.1, roofY, roofY + 3.2, trim, BMAT.Plain, 50, trim, BMAT.Plain); }
    else { blank(mb); parapet(mb, f, tx0, tx1, tz0, tz1, roofY, PARAPET_H, PARAPET_T, wallCol, shadeHex(roofC, 0.9), copingOf(trim)); }
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
      prism(mb, f, x0 - 0.1, x1 + 0.1, z1, z1 + 1.6, y0 + groundH - 0.35, y0 + groundH - 0.1, trim === 0xf7f4ec ? 0xe8e4dc : 0xaaa99d, BMAT.Plain, 50, 0x9d9a92, BMAT.Plain, true);
    }
  }
  if (lod > 0) return;
  // sacadas
  const balc = a.balcony === Balcony.None && g.pattern === Pattern.Residential && a.win !== Win.Curtain ? Balcony.Alternate : a.balcony;
  if (zone !== Zone.Commercial && floors >= 2 && balc !== Balcony.None) {
    const cols = Math.max(1, Math.round(bw / colW));
    const cw = bw / cols;
    const glassRail = balc === Balcony.Continuous && r.next() < 0.6;
    // 4.0: the railing in the trim (buildingMesh.ts:1645), the slab of a varanda gourmet the wall's own x 0.92
    // (slabColour :3144-3149), a balcony's slab concrete
    const railCol = glassRail ? 0x8fb0c0 : (r.next(), trim);
    const depth = balc === Balcony.Continuous ? GOURMET_OUT : 1.3;
    const slabCol = shadeHex(wallCol, 0.92);
    for (let fl = 1; fl < lower; fl++) {
      const y = y0 + groundH + (fl - 1) * fh;
      if (balc === Balcony.Continuous) {
        // the 4.0 varanda gourmet (buildingMesh.ts:1719-1738): the slab 24 cm, its edge beam with a drip under the front,
        // a glass parapet with its metal cap (or a railing), the side walls closing the run storey on storey
        blank(mb);
        prism(mb, f, x0, x1, z1, z1 + depth, y - 0.24, y, slabCol, BMAT.Plain, 50, slabCol, BMAT.Plain, true);
        // the yard keeps its plants out from under the balconies
        if (fl === 1 && f.out) captureFoot(f.out, f, x0, x1, z1, z1 + depth + 0.05, f.out.footGround);
        prism(mb, f, x0, x1, z1 + depth - 0.14, z1 + depth + 0.02, y - 0.29, y - 0.11, slabCol, BMAT.Plain, 50, -1, 0, true);
        if (glassRail) {
          prism(mb, f, x0 + 0.2, x1 - 0.2, z1 + depth - 0.05, z1 + depth - 0.03, y, y + 1.05, railCol, BMAT.Curtain, 50, railCol, BMAT.Metal);
          prism(mb, f, x0 + 0.2, x1 - 0.2, z1 + depth - 0.07, z1 + depth - 0.01, y + 1.05, y + 1.1, trim, BMAT.Metal, 50, trim, BMAT.Metal);
        } else railing(mb, f, x0 + 0.2, x1 - 0.2, z1 + depth - 0.01, y, railCol);
        for (const [c0, c1] of [[x0, x0 + 0.2], [x1 - 0.2, x1]]) prism(mb, f, c0, c1, z1, z1 + depth + 0.05, y - 0.307, y - 0.307 + fh, slabCol, BMAT.Plain, 50, slabCol, BMAT.Plain);
        // vasos/plantas no estilo tropical
        if (g.arch === ArchId.Tropical) for (let c = 0; c < cols; c += 2) prism(mb, f, x0 + c * cw + 0.3, x0 + c * cw + 1.1, z1 + 0.2, z1 + 0.9, y, y + 0.7, 0xb3ada0, BMAT.Plain | (FIN.Concrete << 4), 50, 0x4f7a34, BMAT.Grass);
        for (let c = 0; c < cols; c++) balconyLife(f, g.seed, c, fl, x0 + c * cw, x0 + (c + 1) * cw, z1, depth, y);
        continue;
      }
      for (let c = 0; c < cols; c++) {
        if (balc === Balcony.Alternate && (c + fl) % 2 !== 0) continue;
        const cx0 = x0 + c * cw + 0.15, cx1 = x0 + (c + 1) * cw - 0.15;
        // the 4.0 balcony (buildingMesh.ts:1641-1646): a concrete slab 18 cm the bay's width less 30 cm, 1.3 m out,
        // the railing on its three sides in the trim
        blank(mb);
        prism(mb, f, cx0, cx1, z1, z1 + depth, y - 0.18, y, 0xc4c1b8, BMAT.Plain | (FIN.Concrete << 4), 50, 0xc4c1b8, BMAT.Plain | (FIN.Concrete << 4), true);
        if (fl <= 2 && f.out) captureFoot(f.out, f, cx0, cx1, z1, z1 + depth, f.out.footGround);
        railing(mb, f, cx0, cx1, z1 + depth, y, railCol);
        prism(mb, f, cx0, cx0 + 0.05, z1, z1 + depth, y + 0.97, y + 1.03, railCol, BMAT.Metal, 50, railCol, BMAT.Metal);
        prism(mb, f, cx1 - 0.05, cx1, z1, z1 + depth, y + 0.97, y + 1.03, railCol, BMAT.Metal, 50, railCol, BMAT.Metal);
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
  // the roof's plant, as the 4.0 plans it (by use, storeys, area and age); far (level 1) only what stands 1.5 m up
  if (lod < 2) {
    const use = zone === Zone.Industrial ? 'industrial' : shop ? 'commercial' : 'residential';
    const plant = planRoofPlant({ seed: g.seed, volume: 0, use, storeys: floors, x0: tx0, z0: tz0, x1: tx1, z1: tz1, age: (hash2(g.seed, 0xa9e) % 1000) / 1000 });
    roofPlant(g, lod > 0 ? plant.filter((it) => it.h >= 1.5) : plant, tx0, tx1, tz0, tz1, roofY, trim);
  }
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

/**
 * A tree of a lot (a square, a park, a civic forecourt): a real tree from the props pool, as the lots' trees in
 * jobs/props.ts, scaled to its height (the pool's tree stands ~7 m). The box trees it replaces took the lawn's
 * material, whose grass is laid by world x, z: stripes on their sides.
 */
export function treeGeo(_mb: MeshBuilder, f: Frame, x: number, z: number, y: number, h: number, _r: number): void {
  part(f, 0, x, y, z, 0, 1, Math.max(0.6, Math.min(1.4, h / 7)), P_TREE);
}

/** Prédios especiais (escola, igreja, hospital, praça, parque, posto…), cada um com a sua forma. */
function sideGarden(g: GenContext, corner: number, x0: number, x1: number, z0: number, bd: number, fence: number): void {
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
function hillside(g: GenContext, x0: number, x1: number, z0: number, z1: number, wallCol: number, fh: number, fl: number, plainBox: boolean): void {
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

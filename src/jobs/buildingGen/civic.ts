import {  } from '../../world/heights.ts';
import {  } from '../meshBuilder.ts';
import { ArchId, Fn } from '../../world/arch.ts';
import { FIN } from '../buildingFinishes.ts';
import {  } from './polygon.ts';
import { BMAT, Facade } from './materials.ts';
import { FR_INNER, FR_TOP, blank, gable } from './geometry.ts';
import { setFac } from './windows.ts';
import { part, prism, ring, frame } from './shell.ts';
import { lotWall, yard } from './lot.ts';
import type { GenContext } from './context.ts';
import { P_BUSH, block, hip, treeGeo } from './plans.ts';
export function civic(g: GenContext, fn: number): void {
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
      // nave with a gable roof, a tower with a pinnacle and cross, churchyard
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
      // the emergency entrance's canopy
      solid(-6, 6, z1, z1 + 5, y0 + 3.4, y0 + 3.7, 0xd8d6d0);
      for (const x of [-5.5, 5.5]) solid(x - 0.15, x + 0.15, z1 + 4.6, z1 + 4.9, y0, y0 + 3.4, 0xd8d6d0);
      // helipad on the roof, inside the 0.8 m band
      if (big) { const yh = y0 + fl * 3.6; solid(-6, 6, z1 - bd + 3, z1 - bd + 15, yh, yh + 0.2, 0x4a4d50); solid(-2, 2, z1 - bd + 8.7, z1 - bd + 9.3, yh + 0.2, yh + 0.25, 0xf2f2ee); }
      ground(0xa29c92, BMAT.Paving);
      break;
    }
    case Fn.Square: case Fn.Park: {
      // square: paving, flower beds, benches, fountain; park: lawn, paths and trees
      const park = fn === Fn.Park;
      ground(park ? 0x6f9a4c : 0xc4beb2, park ? BMAT.Grass : BMAT.Paving);
      if (lod > 1) break;
      if (!park) {
        for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          // a raised bed: a concrete kerb 45 cm high round it, the soil's lawn on top just under the kerb's edge
          const bx0 = x * W / 4 - W / 8, bx1 = x * W / 4 + W / 8, bz0 = z * D / 4 - D / 8, bz1 = z * D / 4 + D / 8;
          blank(mb);
          frame(mb, f, bx0, bx1, bz0, bz1, y0, y0 + 0.45, 0, 0.15, 0xb3ada0, BMAT.Plain | (FIN.Concrete << 4), FR_TOP | FR_INNER);
          prism(mb, f, bx0 + 0.15, bx1 - 0.15, bz0 + 0.15, bz1 - 0.15, y0 + 0.38, y0 + 0.38, 0x5f8a3e, BMAT.Grass, 50, 0x5f8a3e, BMAT.Grass, false, 15);
          // a bush at each bed's centre
          part(f, 0, x * W / 4, y0 + 0.38, z * D / 4, 0, 1, 1.2, P_BUSH);
        }
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
      // a coloured band 5 cm above the canopy's top (on the same plane the two colours flickered)
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
      // glazed entrance and a painted car park
      setFac(mb, ArchId.Glass, g.seed, Facade.Curtain, 1.6, 3.6);
      prism(mb, f, -8, 8, z1, z1 + 2, g.f.base, y0 + 6, 0x4a6274, BMAT.Curtain, 1.6, 0x8f8b84, BMAT.RoofFlat);
      ground(0x55585b, BMAT.Paving);
      // painted bays in front of the entrance, when the lot has room for them (not in the street)
      if (z1 + 9 <= D / 2 - 0.5) for (let x = -W / 2 + 3; x < W / 2 - 3; x += 2.6) solid(x, x + 0.1, z1 + 4, z1 + 9, y0 + 0.02, y0 + 0.05, 0xf2f2ee);
      break;
    }
    case Fn.CityHall: {
      // three floors, a portico of columns, a pediment and a flagpole with its flag
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
        // garage doors and the training tower
        // garage doors along the front, as many as fit (up to three)
        if (lod < 2) for (let k = 0; k < 3 && -bw / 2 + 6.5 + k * 6 <= bw / 2 - 0.5; k++) solid(-bw / 2 + 2 + k * 6, -bw / 2 + 6.5 + k * 6, z1, z1 + 0.1, y0, y0 + 4.5, 0xa02a1c);
        setFac(mb, ArchId.Civic, g.seed, Facade.Punched, 2.4, 3.2);
        // the tower 10 cm out of the station's walls (on the same plane the windows of both flickered)
        prism(mb, f, bw / 2 - 4.9, bw / 2 + 0.1, z1 - bd - 0.1, z1 - bd + 4.9, g.f.base, y0 + 18, 0xc8402c, BMAT.Wall, 2.4, 0x8f8b84, BMAT.RoofFlat);
      }
      if (lod > 0) break;
      ground(0x8a8478, BMAT.Paving);
      break;
    }
    default: block(g);
  }
}

/** Office tower: a podium of shops, a set-back tower (glass, contemporary or art deco) and a crown. */
export function openLot(g: GenContext, fn: number): void {
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
      if (Math.abs(x) < 1.6) continue; // the middle path
      sol(x - 0.5, x + 0.5, z - 1, z + 1, y0, y0 + 0.4, 0xb4b0a8);
      sol(x - 0.45, x + 0.45, z - 1.05, z - 0.85, y0 + 0.4, y0 + 1.3, 0xc9c5bd);
    }
    return;
  }
  // playground: slide, swing, seesaw, merry-go-round and sand
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


// Vias pintadas na textura do terreno, para a vista de longe: por texel de
// 4 m, quanto dele é asfalto (R) e quanto é calçada/canteiro (G). Pontes e
// túneis não são pintados no chão.

import { HEIGHT_SPACING, HEIGHT_TILE_RES, MAP_TILES } from '../config.ts';
import { tileOriginX } from '../core/grid.ts';
import { arcTable, bez, tAtLength, type Quad } from '../roads/geometry.ts';
import { PROFILE_INFO } from '../roads/profiles.ts';
import { heightAt } from '../world/heights.ts';
import type { RoadGraph } from './protocol.ts';

const p2 = new Float64Array(2);

/** Lado da versão grossa (média de blocos) usada bem de longe. */
export const PAINT_COARSE = 32;

/** Reduz por média de blocos (sem mipmaps de hardware: a camada muda sozinha). */
export function coarsen(fine: Uint8Array): Uint8Array {
  const R = HEIGHT_TILE_RES, C = PAINT_COARSE, f = R / C;
  const out = new Uint8Array(C * C * 4);
  for (let j = 0; j < C; j++) for (let i = 0; i < C; i++) {
    const acc = [0, 0, 0, 0];
    for (let y = 0; y < f; y++) for (let x = 0; x < f; x++) {
      const k = ((j * f + y) * R + i * f + x) * 4;
      for (let c = 0; c < 4; c++) acc[c] += fine[k + c];
    }
    for (let c = 0; c < 4; c++) out[(j * C + i) * 4 + c] = Math.round(acc[c] / (f * f));
  }
  return out;
}

export function paintRoadTile(heights: Float32Array, g: RoadGraph, tile: number): Uint8Array {
  const R = HEIGHT_TILE_RES, S = HEIGHT_SPACING;
  const out = new Uint8Array(R * R * 4);
  const asph = new Float32Array(R * R), side = new Float32Array(R * R);
  const tx = tile % MAP_TILES, tz = (tile / MAP_TILES) | 0;
  const ox = tileOriginX(tx), oz = tileOriginX(tz);
  for (let s = 0; s < g.segCount; s++) {
    const q: Quad = { x0: g.nx[g.sa[s]], z0: g.nz[g.sa[s]], cx: g.scx[s], cz: g.scz[s], x1: g.nx[g.sb[s]], z1: g.nz[g.sb[s]] };
    const info = PROFILE_INFO[g.sprofile[s]];
    const half = (info.left + info.right) / 2, ah = (info.asphaltLeft + info.asphaltRight) / 2;
    const table = arcTable(q, 32);
    const len = table[table.length - 1];
    const n = Math.max(2, Math.ceil(len / 3) + 1);
    const px = new Float64Array(n), pz = new Float64Array(n), py = new Float64Array(n);
    const ya = g.ny[g.sa[s]], yb = g.ny[g.sb[s]];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const d = len * i / (n - 1);
      bez(q, tAtLength(table, d), p2);
      px[i] = p2[0]; pz[i] = p2[1]; py[i] = ya + (yb - ya) * d / len;
      minX = Math.min(minX, p2[0]); maxX = Math.max(maxX, p2[0]); minZ = Math.min(minZ, p2[1]); maxZ = Math.max(maxZ, p2[1]);
    }
    const reach = half + S;
    const i0 = Math.max(0, Math.floor((minX - reach - ox) / S)), i1 = Math.min(R - 1, Math.ceil((maxX + reach - ox) / S));
    const j0 = Math.max(0, Math.floor((minZ - reach - oz) / S)), j1 = Math.min(R - 1, Math.ceil((maxZ + reach - oz) / S));
    for (let j = j0; j <= j1; j++) {
      const z = oz + (j + 0.5) * S;
      for (let i = i0; i <= i1; i++) {
        const x = ox + (i + 0.5) * S;
        // distância à linha central (polilinha) e altura da via ali
        let bd = Infinity, by = 0;
        for (let k = 0; k + 1 < n; k++) {
          const ex = px[k + 1] - px[k], ez = pz[k + 1] - pz[k];
          const l2 = ex * ex + ez * ez || 1;
          const t = Math.max(0, Math.min(1, ((x - px[k]) * ex + (z - pz[k]) * ez) / l2));
          const dx = px[k] + ex * t - x, dz = pz[k] + ez * t - z;
          const d = dx * dx + dz * dz;
          if (d < bd) { bd = d; by = py[k] + (py[k + 1] - py[k]) * t; }
        }
        const d = Math.sqrt(bd);
        if (d > reach) continue;
        const ground = heightAt(heights, x, z);
        if (by - ground > 2 || ground - by > 3) continue; // ponte ou túnel
        const a = Math.min(1, Math.max(0, (ah - d) / S + 0.5));
        const o = Math.min(1, Math.max(0, (half - d) / S + 0.5));
        const k = j * R + i;
        if (a > asph[k]) asph[k] = a;
        if (o - a > side[k]) side[k] = o - a;
      }
    }
  }
  for (let k = 0; k < R * R; k++) {
    out[k * 4] = Math.round(asph[k] * 255);
    out[k * 4 + 1] = Math.round(Math.min(side[k], 1 - asph[k]) * 255);
    out[k * 4 + 3] = asph[k] > 0 || side[k] > 0 ? 255 : 0;
  }
  return out;
}

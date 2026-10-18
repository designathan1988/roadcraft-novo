// Lotes ao longo das vias zoneadas (worker). Função pura da rede em volta da
// célula: o mesmo resultado em qualquer worker e em células vizinhas.
// Vias (e as esquinas dos nós) entram numa grade de ocupação de 2 m; cada lado
// zoneado de trecho é fatiado em lotes que só entram onde a grade está livre.

import { CELL_SIZE, MAP_CELLS, SEA_LEVEL } from '../config.ts';
import { cellOriginX } from '../core/grid.ts';
import { Rng, hash2 } from '../core/rng.ts';
import { arcTable, bez, bezD, tAtLength, type Quad } from '../roads/geometry.ts';
import { NODE_BULB, armOf, bulbRetreat, junctionRetreats } from '../roads/junction.ts';
import { PROFILE_INFO } from '../roads/profiles.ts';
import { Zone, baseZone } from '../roads/zones.ts';
import { heightAt } from '../world/heights.ts';
import { waterAt } from '../world/ground.ts';
import type { LotColumns, RoadGraph } from './protocol.ts';

const RES = 2;
const MARGIN = 120;

/** Faixas de frente e fundo por zona (m). */
export const LOT_SIZE: Record<number, { w: [number, number]; d: [number, number] }> = {
  [Zone.Residential]: { w: [12, 19], d: [26, 34] },
  [Zone.Commercial]: { w: [16, 28], d: [30, 40] },
  [Zone.Industrial]: { w: [30, 55], d: [40, 60] },
  [Zone.Mixed]: { w: [14, 22], d: [28, 36] },
};

/** Centro (comércio, misto, alta densidade): fundo maior, que alcança o miolo da quadra (o centro fica cheio). */
// casas: quintal fundo até o quintal do vizinho de trás (sem miolo de quadra vazio, como no roadcraft)
const DEEP: Record<number, [number, number]> = { [Zone.Residential]: [38, 48], [Zone.Commercial]: [55, 70], [Zone.Mixed]: [45, 58], [Zone.ResHigh]: [45, 58], [Zone.ComHigh]: [58, 72] };

const p2 = new Float64Array(2), d2 = new Float64Array(2);

export function buildLots(heights: Float32Array, g: RoadGraph, cell: number, water?: Float32Array): LotColumns {
  const cx0 = cellOriginX(cell % MAP_CELLS), cz0 = cellOriginX((cell / MAP_CELLS) | 0);
  const ax = cx0 - MARGIN, az = cz0 - MARGIN;
  const W = Math.ceil((CELL_SIZE + MARGIN * 2) / RES);
  const grid = new Uint8Array(W * W);
  const mark = (x: number, z: number, r: number, v: number) => {
    const i0 = Math.max(0, Math.floor((x - r - ax) / RES)), i1 = Math.min(W - 1, Math.ceil((x + r - ax) / RES));
    const j0 = Math.max(0, Math.floor((z - r - az) / RES)), j1 = Math.min(W - 1, Math.ceil((z + r - az) / RES));
    const r2 = r * r;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const px = ax + (i + 0.5) * RES - x, pz = az + (j + 0.5) * RES - z;
      if (px * px + pz * pz <= r2) grid[j * W + i] = v;
    }
  };

  const quads: Quad[] = [], tables: Float64Array[] = [], lens: number[] = [];
  for (let s = 0; s < g.segCount; s++) {
    const q: Quad = { x0: g.nx[g.sa[s]], z0: g.nz[g.sa[s]], cx: g.scx[s], cz: g.scz[s], x1: g.nx[g.sb[s]], z1: g.nz[g.sb[s]] };
    quads.push(q);
    const t = arcTable(q, 24);
    tables.push(t);
    lens.push(t[t.length - 1]);
  }

  // vias na grade
  for (let s = 0; s < g.segCount; s++) {
    const half = PROFILE_INFO[g.sprofile[s]].right + 0.4;
    const n = Math.max(2, Math.ceil(lens[s] / RES) + 1);
    for (let i = 0; i < n; i++) {
      bez(quads[s], tAtLength(tables[s], lens[s] * i / (n - 1)), p2);
      mark(p2[0], p2[1], half, 1);
    }
  }
  // esquinas: recuo de cada braço
  const retreat = new Float64Array(g.segCount * 2);
  const arms: Array<Array<{ s: number; end: 0 | 1 }>> = Array.from({ length: g.nodeCount }, () => []);
  for (let s = 0; s < g.segCount; s++) { arms[g.sa[s]].push({ s, end: 0 }); arms[g.sb[s]].push({ s, end: 1 }); }
  const tmp = new Float64Array(16);
  const order: number[] = [];
  for (let n = 0; n < g.nodeCount; n++) {
    const list = arms[n];
    if (list.length === 1 && g.nctl[n] === NODE_BULB) retreat[list[0].s * 2 + list[0].end] = bulbRetreat(armOf(quads[list[0].s], g.sprofile[list[0].s], list[0].end), lens[list[0].s]);
    if (list.length < 2) continue;
    junctionRetreats(list.map((r) => armOf(quads[r.s], g.sprofile[r.s], r.end)), list.map((r) => lens[r.s]), tmp, order);
    list.forEach((r, i) => { retreat[r.s * 2 + r.end] = tmp[i]; });
    let maxHalf = 0;
    for (const r of list) maxHalf = Math.max(maxHalf, PROFILE_INFO[g.sprofile[r.s]].right);
    if (list.length >= 3) mark(g.nx[n], g.nz[n], maxHalf + 4, 1);
  }

  // lados zoneados, numa ordem que não depende de ids
  const sides: Array<{ s: number; side: number; zone: number; key: number }> = [];
  for (let s = 0; s < g.segCount; s++) {
    bez(quads[s], 0.5, p2);
    for (const side of [0, 1]) {
      const zone = side === 0 ? g.szl[s] : g.szr[s];
      if (zone) sides.push({ s, side, zone, key: hash2(Math.round(p2[0] * 4), Math.round(p2[1] * 4), side + 77) });
    }
  }
  sides.sort((a, b) => a.key - b.key);

  const out = { x: [] as number[], z: [] as number[], w: [] as number[], d: [] as number[], rot: [] as number[], zone: [] as number[], seed: [] as number[], profile: [] as number[] };
  for (const { s, side, zone } of sides) {
    const info = PROFILE_INFO[g.sprofile[s]];
    const sign = side === 0 ? 1 : -1; // esquerda = u positivo
    const front = (side === 0 ? info.left : info.right) + 0.3;
    const size = LOT_SIZE[baseZone(zone)];
    if (!size) continue;
    const startS = retreat[s * 2] + 2, endS = lens[s] - retreat[s * 2 + 1] - 2;
    bez(quads[s], 0, p2);
    const rng = new Rng(hash2(Math.round(p2[0] * 2), Math.round(p2[1] * 2), side * 31 + zone));
    let at = startS;
    let narrowTried = false;
    while (endS - at >= size.w[0]) {
      // segunda tentativa no mesmo ponto: a largura mínima
      let w = narrowTried ? size.w[0] : rng.range(size.w[0], size.w[1]);
      if (endS - at - w < size.w[0] * 0.5) w = endS - at; // o resto vai para o último
      const mid = at + w / 2;
      const t = tAtLength(tables[s], mid);
      bez(quads[s], t, p2); bezD(quads[s], t, d2);
      const l = Math.hypot(d2[0], d2[1]) || 1;
      const tx = d2[0] / l, tz = d2[1] / l;
      const lx = tz * sign, lz = -tx * sign; // para longe da via
      let placed = false;
      const deep = DEEP[zone] ?? DEEP[baseZone(zone)];
      const deepD = deep ? rng.range(deep[0], deep[1]) : 0;
      const baseD = rng.range(size.d[0], size.d[1]);
      // fundos a tentar: o fundo do centro (até o miolo da quadra), o de sempre e daí encolhendo de 3 em 3 m até
      // encaixar no lote de trás (sem faixa de gramado sobrando entre os dois)
      const depths: number[] = deep ? [deepD] : [];
      for (let D = baseD; D >= 12; D -= 3) depths.push(D);
      for (const D of depths) {
        const cx = p2[0] + lx * (front + D / 2), cz = p2[1] + lz * (front + D / 2);
        if (!lotFree(grid, W, ax, az, cx, cz, tx, tz, lx, lz, w, D)) continue;
        // água ou encosta forte: sem lote
        const hc = heightAt(heights, cx, cz);
        if (hc < SEA_LEVEL + 0.5) break;
        let lo = hc, hi = hc, wet = water ? waterAt(water, cx, cz) > hc - 0.5 : false;
        for (const [fx, fz] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
          const px = cx + tx * w * fx + lx * D * fz, pz = cz + tz * w * fx + lz * D * fz;
          const y = heightAt(heights, px, pz);
          lo = Math.min(lo, y); hi = Math.max(hi, y);
          if (water && waterAt(water, px, pz) > y - 0.5) wet = true;
        }
        if (wet) break; // rio ou lago
        if (hi - lo > 7) break;
        markLot(grid, W, ax, az, cx, cz, tx, tz, lx, lz, w, D);
        if (Math.floor((cx - cx0) / CELL_SIZE) === 0 && Math.floor((cz - cz0) / CELL_SIZE) === 0) {
          out.x.push(cx); out.z.push(cz); out.w.push(w - 0.6); out.d.push(D); out.zone.push(zone);
          // frente (+z local) olha para a via: rumo = -longe
          out.rot.push(Math.atan2(-lx, -lz));
          out.seed.push(hash2(Math.round(cx * 2), Math.round(cz * 2), zone));
          out.profile.push(g.sprofile[s]);
        }
        placed = true;
        break;
      }
      if (!placed && w > size.w[0] + 1 && !narrowTried) { narrowTried = true; continue; }
      narrowTried = false;
      at += placed ? w : Math.max(4, w / 2);
    }
  }
  const n = out.x.length;
  return {
    count: n,
    x: new Float32Array(out.x), z: new Float32Array(out.z), w: new Float32Array(out.w), d: new Float32Array(out.d),
    rot: new Float32Array(out.rot), zone: new Uint8Array(out.zone), seed: new Uint32Array(out.seed), profile: new Uint8Array(out.profile),
  };
}

function lotFree(grid: Uint8Array, W: number, ax: number, az: number, cx: number, cz: number,
  tx: number, tz: number, lx: number, lz: number, w: number, D: number): boolean {
  let total = 0, busy = 0;
  for (let a = -w / 2 + 1; a <= w / 2 - 1; a += RES) {
    for (let b = -D / 2 + 1; b <= D / 2 - 1; b += RES) {
      const x = cx + tx * a + lx * b, z = cz + tz * a + lz * b;
      const i = Math.floor((x - ax) / RES), j = Math.floor((z - az) / RES);
      total++;
      if (i < 0 || j < 0 || i >= W || j >= W) continue;
      if (grid[j * W + i]) busy++;
    }
  }
  return busy <= total * 0.03;
}

function markLot(grid: Uint8Array, W: number, ax: number, az: number, cx: number, cz: number,
  tx: number, tz: number, lx: number, lz: number, w: number, D: number): void {
  for (let a = -w / 2; a <= w / 2; a += RES / 2) {
    for (let b = -D / 2; b <= D / 2; b += RES / 2) {
      const x = cx + tx * a + lx * b, z = cz + tz * a + lz * b;
      const i = Math.floor((x - ax) / RES), j = Math.floor((z - az) / RES);
      if (i >= 0 && j >= 0 && i < W && j < W) grid[j * W + i] = 2;
    }
  }
}

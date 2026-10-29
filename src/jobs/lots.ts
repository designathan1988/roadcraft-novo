// Lotes ao longo das vias zoneadas (worker). Função pura da rede em volta da
// célula: o mesmo resultado em qualquer worker e em células vizinhas.
// Vias (e as esquinas dos nós) entram numa grade de ocupação de 2 m; cada lado
// zoneado de trecho é fatiado em lotes que só entram onde a grade está livre.

import { CELL_SIZE, MAP_CELLS, SEA_LEVEL } from '../config.ts';
import { cellOriginX } from '../core/grid.ts';
import { Rng, hash2 } from '../core/rng.ts';
import { arcTable, bez, bezD, tAtLength, type Quad } from '../roads/geometry.ts';
import { BULB_R, BULB_WALK, NODE_BULB, armOf, bulbRetreat, junctionRetreats } from '../roads/junction.ts';
import { PROFILE_INFO } from '../roads/profiles.ts';
import { Zone, baseZone } from '../roads/zones.ts';
import { heightAt } from '../world/heights.ts';
import { waterAt } from '../world/ground.ts';
import type { LotColumns, RoadGraph } from '../shared/contracts/worker.ts';

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
    const half = Math.max(PROFILE_INFO[g.sprofile[s]].left, PROFILE_INFO[g.sprofile[s]].right) + 0.4;
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

  // exact clearances after the grid's first pass: each road's curve and half width (both sides), the dead ends'
  // bulbs (asphalt and sidewalk circle), and the lots already placed (their rectangles, not the grid's 2 m cells)
  const roads: Array<{ q: Quad; half: number; x0: number; x1: number; z0: number; z1: number }> = [];
  for (let s = 0; s < g.segCount; s++) {
    const q = quads[s], half = Math.max(PROFILE_INFO[g.sprofile[s]].left, PROFILE_INFO[g.sprofile[s]].right);
    roads.push({ q, half, x0: Math.min(q.x0, q.cx, q.x1) - half, x1: Math.max(q.x0, q.cx, q.x1) + half, z0: Math.min(q.z0, q.cz, q.z1) - half, z1: Math.max(q.z0, q.cz, q.z1) + half });
  }
  const bulbs: number[] = [];
  for (let n = 0; n < g.nodeCount; n++) if (arms[n].length === 1 && g.nctl[n] === NODE_BULB) bulbs.push(g.nx[n], g.nz[n]);
  const taken: number[] = [];
  const corners = (cx: number, cz: number, tx: number, tz: number, lx: number, lz: number, w: number, D: number, inset: number): number[] => {
    const hw = w / 2 - inset, hd = D / 2 - inset;
    return [cx - tx * hw - lx * hd, cz - tz * hw - lz * hd, cx + tx * hw - lx * hd, cz + tz * hw - lz * hd,
      cx + tx * hw + lx * hd, cz + tz * hw + lz * hd, cx - tx * hw + lx * hd, cz - tz * hw + lz * hd];
  };
  /** How far the lot must move back (along l) to clear every road's edge; Infinity when a bulb or a lot is in the way. */
  const exactShift = (cx: number, cz: number, tx: number, tz: number, lx: number, lz: number, w: number, D: number): number => {
    const c = corners(cx, cz, tx, tz, lx, lz, w, D, 0.3);
    // the outline: corners and the middles of the sides
    const pts: number[] = [...c];
    for (let k = 0; k < 4; k++) pts.push((c[k * 2] + c[((k + 1) % 4) * 2]) / 2, (c[k * 2 + 1] + c[((k + 1) % 4) * 2 + 1]) / 2);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let k = 0; k < pts.length; k += 2) { x0 = Math.min(x0, pts[k]); x1 = Math.max(x1, pts[k]); z0 = Math.min(z0, pts[k + 1]); z1 = Math.max(z1, pts[k + 1]); }
    let shift = 0;
    for (const r of roads) {
      if (r.x1 < x0 || r.x0 > x1 || r.z1 < z0 || r.z0 > z1) continue;
      for (let k = 0; k < pts.length; k += 2) {
        const x = pts[k], z = pts[k + 1];
        if (x < r.x0 || x > r.x1 || z < r.z0 || z > r.z1) continue;
        const d = curveDistance(r.q, x, z);
        if (d < r.half) shift = Math.max(shift, r.half - d);
      }
    }
    for (let k = 0; k < bulbs.length; k += 2) for (let m = 0; m < pts.length; m += 2) if (Math.hypot(pts[m] - bulbs[k], pts[m + 1] - bulbs[k + 1]) < BULB_R + BULB_WALK) return Infinity;
    for (let k = 0; k < taken.length; k += 8) if (rectsOverlap(c, taken, k)) return Infinity;
    return shift;
  };

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
        let cx = p2[0] + lx * (front + D / 2), cz = p2[1] + lz * (front + D / 2);
        if (!lotFree(grid, W, ax, az, cx, cz, tx, tz, lx, lz, w, D)) continue;
        // on a curve's inner side the corners come closer to the road than the middle: back by what they lack
        const back = exactShift(cx, cz, tx, tz, lx, lz, w, D);
        if (back > 0 && back < 3) { cx += lx * (back + 0.05); cz += lz * (back + 0.05); }
        if (back >= 3 || (back > 0 && (exactShift(cx, cz, tx, tz, lx, lz, w, D) > 0 || !lotFree(grid, W, ax, az, cx, cz, tx, tz, lx, lz, w, D)))) continue;
        // água ou encosta forte neste fundo: tenta o próximo (mais raso), o raso pode caber onde o fundo não coube
        const hc = heightAt(heights, cx, cz);
        if (hc < SEA_LEVEL + 0.5) continue;
        let lo = hc, hi = hc, wet = water ? waterAt(water, cx, cz) > hc - 0.5 : false;
        for (const [fx, fz] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
          const px = cx + tx * w * fx + lx * D * fz, pz = cz + tz * w * fx + lz * D * fz;
          const y = heightAt(heights, px, pz);
          lo = Math.min(lo, y); hi = Math.max(hi, y);
          if (water && waterAt(water, px, pz) > y - 0.5) wet = true;
        }
        if (wet) continue; // rio ou lago
        if (hi - lo > 10) continue;
        markLot(grid, W, ax, az, cx, cz, tx, tz, lx, lz, w, D);
        taken.push(...corners(cx, cz, tx, tz, lx, lz, w - 0.6, D, 0.15));
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
      at += placed ? w : Math.max(2, w / 4);
    }
  }
  const n = out.x.length;
  return {
    count: n,
    x: new Float32Array(out.x), z: new Float32Array(out.z), w: new Float32Array(out.w), d: new Float32Array(out.d),
    rot: new Float32Array(out.rot), zone: new Uint8Array(out.zone), seed: new Uint32Array(out.seed), profile: new Uint16Array(out.profile),
  };
}

const cd = new Float64Array(2);
/** Distance from (x, z) to a road's curve: 12 samples, then halving the step around the nearest (to 3 cm on 200 m). */
function curveDistance(q: Quad, x: number, z: number): number {
  let best = 0, bd = Infinity;
  for (let i = 0; i <= 12; i++) { bez(q, i / 12, cd); const d = (cd[0] - x) ** 2 + (cd[1] - z) ** 2; if (d < bd) { bd = d; best = i / 12; } }
  for (let step = 1 / 24; step > 1e-4; step /= 2) {
    for (const t of [best - step, best + step]) {
      if (t < 0 || t > 1) continue;
      bez(q, t, cd);
      const d = (cd[0] - x) ** 2 + (cd[1] - z) ** 2;
      if (d < bd) { bd = d; best = t; }
    }
  }
  return Math.sqrt(bd);
}

/** Whether quad a (8 numbers) and the quad of b at offset k overlap (separating axes; touching is not overlapping). */
function rectsOverlap(a: number[], b: number[], k: number): boolean {
  for (let pass = 0; pass < 2; pass++) {
    const p = pass ? b : a, o = pass ? k : 0;
    for (let e = 0; e < 4; e++) {
      const ex = p[o + ((e + 1) % 4) * 2] - p[o + e * 2], ez = p[o + ((e + 1) % 4) * 2 + 1] - p[o + e * 2 + 1];
      let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
      for (let v = 0; v < 4; v++) {
        const pa = a[v * 2] * ez - a[v * 2 + 1] * ex, pb = b[k + v * 2] * ez - b[k + v * 2 + 1] * ex;
        amin = Math.min(amin, pa); amax = Math.max(amax, pa); bmin = Math.min(bmin, pb); bmax = Math.max(bmax, pb);
      }
      if (amax <= bmin || bmax <= amin) return false;
    }
  }
  return true;
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

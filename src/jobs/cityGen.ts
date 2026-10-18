// Gerador da cidade inteira pela semente (worker). Centros em terreno plano
// perto do rio; avenidas radiais e um anel em volta do centro principal; via
// expressa atravessando o mapa; ruas locais em grade por bairro (orientação de
// cada centro), cortadas por água e encosta forte. Tudo vira um grafo planar:
// cruzamentos achados por grade de baldes, nós próximos fundidos. Zonas pela
// distância aos centros e às avenidas. A página só insere o resultado.

import { MAP_HALF, SEA_LEVEL } from '../config.ts';
import { Rng, fbm } from '../core/rng.ts';
import { baseHeight } from './terrainGen.ts';
import { Zone } from '../roads/zones.ts';
import { PROFILES } from '../roads/profiles.ts';

export const GEN = { Local: 1, Avenue: 3, AvenueBike: 4, Expressway: 5 } as const;

export interface CityRoads {
  /** x, z, y por nó. */
  nodes: Float32Array;
  /** a, b, perfil, zona esquerda, zona direita por trecho. */
  segs: Int32Array;
  /** Centros (x, z, raio). */
  centers: Float32Array;
}

interface Poly { pts: number[]; profile: number; bridge: boolean }
interface Center { x: number; z: number; r: number; angle: number; bx: number; bz: number }

const MERGE = 7;
const MAX_LOCAL_GRADE = 0.11;
const MAX_ART_GRADE = 0.08;

export function generateCity(seed: number): CityRoads {
  const rng = new Rng(seed * 7919 + 13);
  const H = (x: number, z: number) => baseHeight(x, z, seed);
  const land = (x: number, z: number) => H(x, z) > SEA_LEVEL + 1.2;
  const slope = (x: number, z: number) => {
    const d = 12;
    return Math.hypot(H(x + d, z) - H(x - d, z), H(x, z + d) - H(x, z - d)) / (2 * d);
  };
  const inside = (x: number, z: number, m = 380) => Math.max(Math.abs(x), Math.abs(z)) < MAP_HALF - m;

  // ---------------------------------------------------------------- centros
  const pick = (cx: number, cz: number, rad: number, avoid: Center[], minD: number): [number, number] | null => {
    let best: [number, number] | null = null, bs = Infinity;
    for (let k = 0; k < 400; k++) {
      const x = cx + rng.range(-rad, rad), z = cz + rng.range(-rad, rad);
      if (!inside(x, z, 1500) || !land(x, z)) continue;
      if (avoid.some((c) => Math.hypot(c.x - x, c.z - z) < minD)) continue;
      // plano e perto (mas não dentro) do rio
      let s = 0;
      for (const [dx, dz] of [[0, 0], [200, 0], [-200, 0], [0, 200], [0, -200]]) s += slope(x + dx, z + dz);
      let water = 1e9;
      for (let a = 0; a < 8; a++) for (const r of [250, 500, 800]) {
        if (!land(x + Math.cos(a * 0.785) * r, z + Math.sin(a * 0.785) * r)) water = Math.min(water, r);
      }
      const score = s * 40 + (water < 1e9 ? Math.abs(water - 600) / 400 : 2) + Math.hypot(x - cx, z - cz) / rad;
      if (score < bs) { bs = score; best = [x, z]; }
    }
    return best;
  };
  const centers: Center[] = [];
  const c0 = pick(0, 0, 2200, [], 0) ?? [0, 1500];
  centers.push({ x: c0[0], z: c0[1], r: 3600, angle: rng.range(-0.4, 0.4), bx: 104, bz: 92 });
  for (let i = 0; i < 2; i++) {
    const a = rng.range(0, Math.PI * 2);
    const p = pick(c0[0] + Math.cos(a) * 3800, c0[1] + Math.sin(a) * 3800, 1600, centers, 3000);
    if (p) centers.push({ x: p[0], z: p[1], r: 2200, angle: rng.range(-0.8, 0.8), bx: 118, bz: 100 });
  }
  // mapas maiores: mais bairros-satélite em volta, na proporção da área a mais
  const extra = Math.round(2 * ((MAP_HALF * MAP_HALF) / (5120 * 5120) - 1));
  for (let i = 0, tries = 0; i < extra && tries < extra * 4; tries++) {
    const a = rng.range(0, Math.PI * 2), d = rng.range(5500, MAP_HALF - 1800);
    const p = pick(c0[0] + Math.cos(a) * d, c0[1] + Math.sin(a) * d, 1800, centers, 4200);
    if (!p) continue;
    centers.push({ x: p[0], z: p[1], r: rng.range(1700, 2600), angle: rng.range(-0.8, 0.8), bx: 112 + rng.range(0, 14), bz: 96 + rng.range(0, 10) });
    i++;
  }

  // ---------------------------------------------------------------- linhas
  const polys: Poly[] = [];
  /** Marcha uma linha por pontos; água vira ponte (curta) ou corta; encosta forte corta. */
  const march = (pts: Array<[number, number]>, profile: number, allowBridge: boolean, maxGrade: number) => {
    let cur: number[] = [];
    let lastLand: [number, number] | null = null;
    let wet = 0;
    const flush = () => { if (cur.length >= 4) polys.push({ pts: cur, profile, bridge: allowBridge }); cur = []; };
    for (let i = 0; i < pts.length; i++) {
      const [x, z] = pts[i];
      if (!inside(x, z)) { flush(); lastLand = null; continue; }
      if (!land(x, z)) {
        if (!allowBridge || !lastLand) { flush(); lastLand = null; continue; }
        wet += Math.hypot(x - (pts[i - 1]?.[0] ?? x), z - (pts[i - 1]?.[1] ?? z));
        if (wet > 320) { flush(); lastLand = null; wet = 0; }
        continue; // ponte: o próximo ponto em terra liga direto
      }
      if (lastLand && wet === 0) {
        const g = Math.abs(H(x, z) - H(lastLand[0], lastLand[1])) / Math.max(1, Math.hypot(x - lastLand[0], z - lastLand[1]));
        if (g > maxGrade) { flush(); }
      }
      wet = 0;
      cur.push(x, z);
      lastLand = [x, z];
    }
    flush();
  };

  // via expressa: ao longo do rio, deslocada para um lado, de borda a borda
  const side = rng.next() < 0.5 ? 1 : -1;
  const riverZ = (x: number) => {
    // procura a água mais perto da linha z = c0.z
    let best = c0[1], bd = Infinity;
    for (let z = -MAP_HALF; z < MAP_HALF; z += 40) if (!land(x, z)) { const d = Math.abs(z - c0[1]); if (d < bd) { bd = d; best = z; } }
    return bd < Infinity ? best : NaN;
  };
  {
    const pts: Array<[number, number]> = [];
    let lastZ = c0[1] + side * 1600;
    for (let x = -MAP_HALF + 400; x <= MAP_HALF - 400; x += 160) {
      const rz = riverZ(x);
      const target = Number.isFinite(rz) ? rz + side * 1700 : lastZ;
      lastZ += Math.max(-60, Math.min(60, target - lastZ)); // curva suave
      pts.push([x, lastZ]);
    }
    march(pts, GEN.Expressway, true, MAX_ART_GRADE);
    // e uma norte-sul cruzando o rio, ao lado do centro
    const pts2: Array<[number, number]> = [];
    const x0 = c0[0] + rng.range(1100, 1500) * (rng.next() < 0.5 ? 1 : -1);
    for (let z = -MAP_HALF + 400; z <= MAP_HALF - 400; z += 160) pts2.push([x0 + 200 * Math.sin(z / 1700), z]);
    march(pts2, GEN.Expressway, true, MAX_ART_GRADE);
  }

  // avenidas radiais e anel do centro principal
  centers.forEach((c, ci) => {
    const rays = ci === 0 ? 8 : 5;
    for (let k = 0; k < rays; k++) {
      const a0 = c.angle + (k / rays) * Math.PI * 2 + rng.range(-0.12, 0.12);
      const len = c.r * rng.range(0.85, 1.15);
      const pts: Array<[number, number]> = [];
      let a = a0;
      for (let d = 150; d <= len; d += 100) {
        a += rng.range(-0.04, 0.04);
        pts.push([c.x + Math.cos(a) * d, c.z + Math.sin(a) * d]);
      }
      march(pts, ci === 0 && k % 2 === 0 ? GEN.AvenueBike : GEN.Avenue, ci === 0, MAX_ART_GRADE);
    }
    // anel pequeno em volta da praça central: as radiais nascem nele (sem nó com braços demais)
    for (const rr of ci === 0 ? [150, 850, 2100] : [150, 700]) {
      const pts: Array<[number, number]> = [];
      const n = Math.max(12, Math.ceil((Math.PI * 2 * rr) / 110));
      for (let i = 0; i <= n; i++) {
        const t = (i / n) * Math.PI * 2;
        const w = 1 + 0.08 * fbm(Math.cos(t) * 2, Math.sin(t) * 2, seed + ci * 11 + rr, 2);
        pts.push([c.x + Math.cos(t) * rr * w, c.z + Math.sin(t) * rr * w]);
      }
      march(pts, GEN.Avenue, ci === 0, MAX_ART_GRADE);
    }
  });

  // estradas entre bairros: cada satélite liga ao centro mais perto já posto
  for (let i = 1; i < centers.length; i++) {
    const c = centers[i];
    let j = 0, bd = Infinity;
    for (let k = 0; k < i; k++) { const d = Math.hypot(centers[k].x - c.x, centers[k].z - c.z); if (d < bd) { bd = d; j = k; } }
    const o = centers[j];
    const L = Math.hypot(o.x - c.x, o.z - c.z);
    if (L < c.r + o.r * 0.9) continue; // as radiais já se cruzam
    const pts: Array<[number, number]> = [];
    const nx = -(o.z - c.z) / L, nz = (o.x - c.x) / L, bow = rng.range(-0.08, 0.08) * L;
    for (let d = 150; d <= L - 150; d += 120) {
      const t = d / L, b = Math.sin(t * Math.PI) * bow;
      pts.push([c.x + (o.x - c.x) * t + nx * b, c.z + (o.z - c.z) * t + nz * b]);
    }
    march(pts, GEN.Avenue, true, MAX_ART_GRADE);
  }

  // ruas locais: grade de cada centro, só na área dele (o centro "mais forte" ganha)
  const owner = (x: number, z: number): number => {
    let best = -1, bs = Infinity;
    centers.forEach((c, i) => { const s = Math.hypot(x - c.x, z - c.z) / c.r; if (s < bs) { bs = s; best = i; } });
    return bs < 1.12 ? best : -1;
  };
  centers.forEach((c, ci) => {
    const ca = Math.cos(c.angle), sa = Math.sin(c.angle);
    const R = c.r * 1.12;
    const toW = (u: number, v: number): [number, number] => [c.x + u * ca - v * sa, c.z + u * sa + v * ca];
    for (const dirU of [true, false]) {
      const step = dirU ? c.bz : c.bx;
      const along = dirU ? c.bx : c.bz;
      for (let off = -R; off <= R; off += step) {
        // ruas mais ralas longe do centro
        const keepP = 1 - Math.max(0, Math.abs(off) / R - 0.55) * 1.6;
        if (rng.next() > keepP) continue;
        const pts: Array<[number, number]> = [];
        const flushPts = () => { if (pts.length >= 2) march(pts.splice(0), GEN.Local, false, MAX_LOCAL_GRADE); else pts.length = 0; };
        for (let t = -R; t <= R; t += along / 2) {
          const [x, z] = dirU ? toW(t, off) : toW(off, t);
          const d = Math.hypot(x - c.x, z - c.z);
          if (d > R || owner(x, z) !== ci || (d > c.r * 0.7 && fbm(x / 900, z / 900, seed + 51, 2) < -0.25)) { flushPts(); continue; }
          pts.push([x, z]);
        }
        flushPts();
      }
    }
  });

  return buildGraph(polys, centers, H, seed);
}

// ---------------------------------------------------------------- grafo planar

function buildGraph(polys: Poly[], centers: Center[], H: (x: number, z: number) => number, seed: number): CityRoads {
  // pedaços retos
  const sx0: number[] = [], sz0: number[] = [], sx1: number[] = [], sz1: number[] = [], sp: number[] = [];
  for (const p of polys) {
    for (let i = 0; i + 3 < p.pts.length; i += 2) {
      sx0.push(p.pts[i]); sz0.push(p.pts[i + 1]); sx1.push(p.pts[i + 2]); sz1.push(p.pts[i + 3]); sp.push(p.profile);
    }
  }
  const n = sp.length;
  // cruzamentos por baldes de 96 m
  const B = 96;
  const buckets = new Map<number, number[]>();
  const key = (i: number, j: number) => (i + 2000) * 4096 + (j + 2000);
  for (let s = 0; s < n; s++) {
    const i0 = Math.floor(Math.min(sx0[s], sx1[s]) / B), i1 = Math.floor(Math.max(sx0[s], sx1[s]) / B);
    const j0 = Math.floor(Math.min(sz0[s], sz1[s]) / B), j1 = Math.floor(Math.max(sz0[s], sz1[s]) / B);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = key(i, j);
      let l = buckets.get(k);
      if (!l) { l = []; buckets.set(k, l); }
      l.push(s);
    }
  }
  // rua local colada e quase paralela a uma avenida/expressa: sai (evita vias sobrepostas)
  const dead = new Uint8Array(n);
  for (const list of buckets.values()) {
    for (const s of list) {
      if (sp[s] !== GEN.Local || dead[s]) continue;
      const mx = (sx0[s] + sx1[s]) / 2, mz = (sz0[s] + sz1[s]) / 2;
      const ls = Math.hypot(sx1[s] - sx0[s], sz1[s] - sz0[s]) || 1;
      for (const t of list) {
        if (sp[t] === GEN.Local) continue;
        const dx = sx1[t] - sx0[t], dz = sz1[t] - sz0[t];
        const lt = Math.hypot(dx, dz) || 1;
        const cos = Math.abs(((sx1[s] - sx0[s]) * dx + (sz1[s] - sz0[s]) * dz) / (ls * lt));
        if (cos < 0.93) continue;
        const u = Math.max(0, Math.min(1, ((mx - sx0[t]) * dx + (mz - sz0[t]) * dz) / (lt * lt)));
        if (Math.hypot(mx - (sx0[t] + dx * u), mz - (sz0[t] + dz * u)) < 26) { dead[s] = 1; break; }
      }
    }
  }
  const cuts: number[][] = Array.from({ length: n }, (_, s) => (dead[s] ? [] : [0, 1]));
  const seen = new Set<number>();
  for (const list of buckets.values()) {
    for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
      const s = list[a], t = list[b];
      if (dead[s] || dead[t]) continue;
      const pk = s < t ? s * n + t : t * n + s;
      if (seen.has(pk)) continue;
      seen.add(pk);
      const dx1 = sx1[s] - sx0[s], dz1 = sz1[s] - sz0[s], dx2 = sx1[t] - sx0[t], dz2 = sz1[t] - sz0[t];
      const den = dx1 * dz2 - dz1 * dx2;
      if (Math.abs(den) < 1e-9) continue;
      const wx = sx0[t] - sx0[s], wz = sz0[t] - sz0[s];
      const u = (wx * dz2 - wz * dx2) / den, v = (wx * dz1 - wz * dx1) / den;
      if (u > 1e-6 && u < 1 - 1e-6 && v > 1e-6 && v < 1 - 1e-6) { cuts[s].push(u); cuts[t].push(v); }
    }
  }
  // nós com fusão por grade de hash
  const nx: number[] = [], nz: number[] = [];
  const grid = new Map<number, number[]>();
  const nodeAt = (x: number, z: number): number => {
    const i = Math.floor(x / MERGE), j = Math.floor(z / MERGE);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const l = grid.get(key(i + di, j + dj));
      if (l) for (const id of l) if (Math.hypot(nx[id] - x, nz[id] - z) < MERGE) return id;
    }
    const id = nx.length;
    nx.push(x); nz.push(z);
    const k = key(i, j);
    let l = grid.get(k);
    if (!l) { l = []; grid.set(k, l); }
    l.push(id);
    return id;
  };
  const edges = new Map<number, number>(); // par de nós → perfil (o mais forte)
  const rank = (p: number) => (p === GEN.Expressway ? 3 : p === GEN.AvenueBike ? 2 : p === GEN.Avenue ? 1 : 0);
  for (let s = 0; s < n; s++) {
    const c = cuts[s].sort((a, b) => a - b);
    let prev = -1;
    for (const u of c) {
      const id = nodeAt(sx0[s] + (sx1[s] - sx0[s]) * u, sz0[s] + (sz1[s] - sz0[s]) * u);
      if (prev >= 0 && prev !== id) {
        const k = prev < id ? prev * 1e6 + id : id * 1e6 + prev;
        const old = edges.get(k);
        if (old === undefined || rank(sp[s]) > rank(old)) edges.set(k, sp[s]);
      }
      prev = id;
    }
  }
  // trechos curtos demais viram um nó só (união por raiz)
  const root = nx.map((_, i) => i);
  const find = (i: number): number => { while (root[i] !== i) { root[i] = root[root[i]]; i = root[i]; } return i; };
  for (const k of edges.keys()) {
    const a = Math.floor(k / 1e6), b = k - a * 1e6;
    if (Math.hypot(nx[a] - nx[b], nz[a] - nz[b]) < 16) { const ra = find(a), rb = find(b); if (ra !== rb) root[rb] = ra; }
  }
  const merged = new Map<number, number>();
  for (const [k, p] of edges) {
    const a = find(Math.floor(k / 1e6)), b = find(k - Math.floor(k / 1e6) * 1e6);
    if (a === b) continue;
    const kk = a < b ? a * 1e6 + b : b * 1e6 + a;
    const old = merged.get(kk);
    if (old === undefined || rank(p) > rank(old)) merged.set(kk, p);
  }
  // no máximo 8 ligações por nó (fica com as mais fortes)
  const deg = new Int32Array(nx.length);
  const sorted = [...merged.entries()].sort((x, y) => rank(y[1]) - rank(x[1]));
  edges.clear();
  for (const [k, p] of sorted) {
    const a = Math.floor(k / 1e6), b = k - a * 1e6;
    if (deg[a] >= 6 || deg[b] >= 6) continue;
    deg[a]++; deg[b]++;
    edges.set(k, p);
  }
  // pedaços soltos (componentes pequenos) saem
  {
    const adj = new Map<number, number[]>();
    for (const k of edges.keys()) {
      const a = Math.floor(k / 1e6), b = k - a * 1e6;
      (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
      (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
    }
    const comp = new Map<number, number>();
    const size: number[] = [];
    for (const start of adj.keys()) {
      if (comp.has(start)) continue;
      const id = size.length;
      let count = 0;
      const stack = [start];
      comp.set(start, id);
      while (stack.length) {
        const x = stack.pop()!;
        count++;
        for (const y of adj.get(x)!) if (!comp.has(y)) { comp.set(y, id); stack.push(y); }
      }
      size.push(count);
    }
    for (const k of [...edges.keys()]) if (size[comp.get(Math.floor(k / 1e6))!] < 30) edges.delete(k);
  }
  // distância à expressa (para a indústria)
  const expNodes: number[] = [];
  for (const [k, p] of edges) if (p === GEN.Expressway) expNodes.push(Math.floor(k / 1e6));
  const nearExp = (x: number, z: number) => {
    let best = Infinity;
    for (const id of expNodes) { const d = Math.abs(nx[id] - x) + Math.abs(nz[id] - z); if (d < best) best = d; }
    return best;
  };
  // alturas dos nós: relevo suavizado; nó na água (ponte) fica na média dos vizinhos
  const ny = nx.map((x, i) => {
    let h = 0;
    for (const [dx, dz] of [[0, 0], [8, 0], [-8, 0], [0, 8], [0, -8]]) h += H(x + dx, nz[i] + dz);
    return Math.max(SEA_LEVEL + 1.5, h / 5);
  });
  // zonas pela distância aos centros, às avenidas e à expressa
  const nearCenter = (x: number, z: number) => {
    let best = Infinity;
    for (const c of centers) best = Math.min(best, Math.hypot(x - c.x, z - c.z) / c.r);
    return best;
  };
  const zr = new Rng(seed * 31 + 7);
  const segs: number[] = [];
  // variedade do catálogo por bairro (ruído largo: a rua inteira fica igual)
  const P = (name: string) => { const i = PROFILES.findIndex((p) => p.name === name); return i < 0 ? 0 : i; };
  const V = {
    wide: P('Calçadas largas'), park: 1, urban: P('Rua urbana'), cobble: P('Rua de paralelepípedo'), green: P('Rua com canteiro central'),
    concrete: P('Estrada de concreto'), bike: P('Rua com ciclofaixa'), busSide: P('Faixa de ônibus lateral'), boulevard: P('Bulevar'),
    av4: P('Avenida 4 faixas'),
  };
  const variant = (profile: number, zone: number, d: number, x: number, z: number): number => {
    const n = fbm(x / 650, z / 650, seed + 313, 2), m = fbm(x / 1400, z / 1400, seed + 919, 2);
    if (profile === GEN.Local) {
      // centro comercial: calçadão de 30 km/h só em parte das ruas (com ele em toda rua o centro não passava de
      // 13 km/h no pico); o resto, rua urbana de 50 km/h ou com estacionamento
      if (zone === Zone.Commercial) return n > 0.45 ? V.wide : n > 0.1 ? V.urban : V.park;
      if (zone === Zone.Industrial) return V.concrete;
      if (zone === Zone.Mixed) return n > 0.25 ? V.bike : n < -0.25 ? V.green : V.park;
      if (d > 0.9 && m > 0.2) return V.cobble;
      return n > 0.3 ? V.urban : profile;
    }
    if (profile === GEN.Avenue) {
      if (d < 0.5 && m > 0.15) return V.busSide;
      if (m < -0.3) return V.boulevard;
      if (n > 0.35) return V.av4;
    }
    return profile;
  };
  for (const [k, profile] of edges) {
    const a = Math.floor(k / 1e6), b = k - a * 1e6;
    const mx = (nx[a] + nx[b]) / 2, mz = (nz[a] + nz[b]) / 2;
    const d = nearCenter(mx, mz);
    let zone: number = Zone.None;
    if (profile !== GEN.Expressway) {
      const avenue = profile !== GEN.Local;
      if (d < 0.08 && avenue) zone = Zone.ComHigh;
      else if (d < 0.16 || (avenue && d < 0.35)) zone = Zone.Commercial;
      else if (d < 0.32 || (avenue && d < 0.7)) zone = Zone.Mixed;
      else if (d < 1.05) zone = nearExp(mx, mz) < 800 && fbm(mx / 900, mz / 900, seed + 77, 2) > 0.05 ? Zone.Industrial : d > 0.75 ? Zone.ResLow : Zone.Residential;
      else zone = zr.next() < 0.5 ? Zone.Residential : Zone.None;
    }
    segs.push(a, b, variant(profile, zone, d, mx, mz), zone, zone);
  }
  // só os nós usados, com índices novos
  const remap = new Int32Array(nx.length).fill(-1);
  const out: number[] = [];
  for (let i = 0; i < segs.length; i += 5) {
    for (const k of [0, 1]) {
      const id = segs[i + k];
      if (remap[id] < 0) { remap[id] = out.length / 3; out.push(nx[id], nz[id], ny[id]); }
      segs[i + k] = remap[id];
    }
  }
  const nodes = new Float32Array(out);
  return { nodes, segs: new Int32Array(segs), centers: new Float32Array(centers.flatMap((c) => [c.x, c.z, c.r])) };
}

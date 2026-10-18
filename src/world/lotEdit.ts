// Edição de lotes. O registro do prédio já é o lote (centro, frente w, fundo d, giro, zona):
// dividir, juntar, apagar, girar a frente e mover cantos são trocas desse registro num diário
// (desfazer volta com os mesmos ids). Lote vazio = registro com 0 andares: demarcado no chão e
// ocupado, então o crescimento automático não constrói nele.

import { Rng } from '../core/rng.ts';
import { RoadJournal } from '../roads/build.ts';
import { floorsFor } from './growth.ts';
import type { BuildingRec, World } from './world.ts';

/** Menor lado de um lote (m). */
export const MIN_LOT = 6;

export type SplitKind = 'side' | 'depth';

function rec(world: World, id: number): BuildingRec {
  const c = world.buildings.cols;
  return { x: c.x[id], z: c.z[id], w: c.w[id], d: c.d[id], h: c.h[id], rot: c.rot[id], color: c.color[id], seed: c.seed[id], zone: c.zone[id], floors: c.floors[id], style: c.style[id], fn: c.fn[id] };
}

/** Ponto do lote em coordenadas locais (x ao longo da frente, z para a frente) para o mundo. */
export function lotToWorld(r: { x: number; z: number; rot: number }, lx: number, lz: number): [number, number] {
  const c = Math.cos(r.rot), s = Math.sin(r.rot);
  return [r.x + lx * c + lz * s, r.z - lx * s + lz * c];
}

/** Ponto do mundo no lote (inverso de lotToWorld). */
export function worldToLot(r: { x: number; z: number; rot: number }, x: number, z: number): [number, number] {
  const c = Math.cos(r.rot), s = Math.sin(r.rot), dx = x - r.x, dz = z - r.z;
  return [dx * c - dz * s, dx * s + dz * c];
}

/** Lote (registro) sob o ponto, ou −1. */
export function lotAt(world: World, x: number, z: number): number {
  const col = world.buildings.cols;
  let best = -1, bd = Infinity;
  world.buildingIndex.query(x - 90, z - 90, x + 90, z + 90, (id) => {
    const [lx, lz] = worldToLot({ x: col.x[id], z: col.z[id], rot: col.rot[id] }, x, z);
    if (Math.abs(lx) <= col.w[id] / 2 + 0.5 && Math.abs(lz) <= col.d[id] / 2 + 0.5) {
      const d = lx * lx + lz * lz;
      if (d < bd) { bd = d; best = id; }
    }
  });
  return best;
}

/** Divide o lote em `n` partes iguais: lado a lado (ao longo da frente) ou frente e fundos. */
export function splitLot(world: World, id: number, kind: SplitKind, n: number): RoadJournal | string {
  const r = rec(world, id);
  const along = kind === 'side' ? r.w : r.d;
  if (along / n < MIN_LOT) return 'não sobra um lote que valha a pena aí';
  const j = new RoadJournal(world, 'dividir lote');
  j.removeBuilding(id);
  for (let k = 0; k < n; k++) {
    const off = -along / 2 + (k + 0.5) * along / n;
    const [x, z] = kind === 'side' ? lotToWorld(r, off, 0) : lotToWorld(r, 0, off);
    const seed = (Math.imul(r.seed ^ 0x9e3779b9, k + 1) + k * 7919) >>> 0;
    const w = kind === 'side' ? along / n : r.w, d = kind === 'side' ? r.d : along / n;
    const floors = r.floors === 0 ? 0 : floorsFor(r.zone, 0, new Rng(seed));
    j.addBuilding({ ...r, x, z, w, d, seed, floors, fn: 0 });
  }
  return j;
}

/** Junta dois lotes vizinhos alinhados (mesmo giro, um lado inteiro em comum) num só. */
export function joinLots(world: World, a: number, b: number): RoadJournal | string {
  if (a === b) return 'escolha dois lotes diferentes';
  const ra = rec(world, a), rb = rec(world, b);
  // giros iguais a menos de 180°: o de b vira o de a
  let dr = ((rb.rot - ra.rot) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
  const flip = Math.abs(Math.abs(dr) - Math.PI) < 0.05;
  if (!flip && Math.abs(dr) > 0.05) return 'esses lotes não têm um lado em comum';
  dr = 0;
  const [bx, bz] = worldToLot(ra, rb.x, rb.z);
  const tol = 1.5;
  let x0: number, x1: number, z0: number, z1: number;
  if (Math.abs(bz) < tol && Math.abs(rb.d - ra.d) < tol && Math.abs(Math.abs(bx) - (ra.w + rb.w) / 2) < tol) {
    x0 = Math.min(-ra.w / 2, bx - rb.w / 2); x1 = Math.max(ra.w / 2, bx + rb.w / 2); z0 = -ra.d / 2; z1 = ra.d / 2;
  } else if (Math.abs(bx) < tol && Math.abs(rb.w - ra.w) < tol && Math.abs(Math.abs(bz) - (ra.d + rb.d) / 2) < tol) {
    z0 = Math.min(-ra.d / 2, bz - rb.d / 2); z1 = Math.max(ra.d / 2, bz + rb.d / 2); x0 = -ra.w / 2; x1 = ra.w / 2;
  } else return 'esses lotes não têm um lado em comum';
  const [x, z] = lotToWorld(ra, (x0 + x1) / 2, (z0 + z1) / 2);
  const j = new RoadJournal(world, 'juntar lotes');
  j.removeBuilding(a); j.removeBuilding(b);
  j.addBuilding({ ...ra, x, z, w: x1 - x0, d: z1 - z0, floors: ra.floors === 0 && rb.floors === 0 ? 0 : Math.max(ra.floors, rb.floors, 1), fn: 0 });
  void dr;
  return j;
}

/** Apaga: prédio vira lote vazio demarcado; lote vazio some (a rua zoneada pode fazer crescer de novo). */
export function deleteLot(world: World, id: number): RoadJournal {
  const r = rec(world, id);
  const j = new RoadJournal(world, r.floors === 0 ? 'apagar lote' : 'demolir prédio');
  j.removeBuilding(id);
  if (r.floors !== 0) j.addBuilding({ ...r, floors: 0, fn: 0 });
  return j;
}

/** Vira a frente do lote para o lado mais perto de (x, z). Devolve null se já é a frente. */
export function setLotFront(world: World, id: number, x: number, z: number): RoadJournal | null {
  const r = rec(world, id);
  const [lx, lz] = worldToLot(r, x, z);
  // distância normalizada a cada lado: frente (+z), fundo, direita (+x), esquerda
  const sides: Array<[number, number]> = [[r.d / 2 - lz, 0], [lz + r.d / 2, Math.PI], [r.w / 2 - lx, Math.PI / 2], [lx + r.w / 2, -Math.PI / 2]];
  sides.sort((p, q) => p[0] - q[0]);
  const turn = sides[0][1];
  if (turn === 0) return null;
  const odd = Math.abs(turn) === Math.PI / 2;
  const j = new RoadJournal(world, 'frente do lote');
  j.removeBuilding(id);
  j.addBuilding({ ...r, rot: r.rot + turn, w: odd ? r.d : r.w, d: odd ? r.w : r.d });
  return j;
}

/** Canto do lote mais perto do ponto (0..3) e a distância, para pegar e arrastar. */
export function nearestCorner(world: World, id: number, x: number, z: number): [number, number] {
  const r = rec(world, id);
  let best = 0, bd = Infinity;
  for (let k = 0; k < 4; k++) {
    const [cx, cz] = lotToWorld(r, (k === 1 || k === 2 ? 0.5 : -0.5) * r.w, (k >= 2 ? 0.5 : -0.5) * r.d);
    const d = Math.hypot(cx - x, cz - z);
    if (d < bd) { bd = d; best = k; }
  }
  return [best, bd];
}

/** Arrasta o canto `k` até (x, z): o canto oposto fica, o lote continua retângulo no mesmo giro. */
export function moveLotCorner(world: World, id: number, k: number, x: number, z: number): RoadJournal | string {
  const r = rec(world, id);
  const sx = k === 1 || k === 2 ? 1 : -1, sz = k >= 2 ? 1 : -1;
  const ox = -sx * r.w / 2, oz = -sz * r.d / 2; // canto oposto (fixo)
  const [lx, lz] = worldToLot(r, x, z);
  const w = (lx - ox) * sx, d = (lz - oz) * sz;
  if (w < MIN_LOT || d < MIN_LOT) return 'lote pequeno demais';
  if (w > 200 || d > 200) return 'lote grande demais';
  const [cx, cz] = lotToWorld(r, ox + sx * w / 2, oz + sz * d / 2);
  const j = new RoadJournal(world, 'cantos do lote');
  j.removeBuilding(id);
  j.addBuilding({ ...r, x: cx, z: cz, w, d });
  return j;
}

/**
 * Lote por polígono: o retângulo de menor área que contém os pontos (lados da casca convexa),
 * com a frente no primeiro lado clicado. O prédio sai retangular dentro dele.
 */
export function polygonRect(pts: Array<[number, number]>): { x: number; z: number; w: number; d: number; rot: number } | null {
  if (pts.length < 3) return null;
  const hull = convexHull(pts);
  if (hull.length < 3) return null;
  let best: { x: number; z: number; w: number; d: number; rot: number; area: number } | null = null;
  for (let i = 0; i < hull.length; i++) {
    const [ax, az] = hull[i], [bx, bz] = hull[(i + 1) % hull.length];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1e-6) continue;
    const ux = (bx - ax) / L, uz = (bz - az) / L;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [px, pz] of hull) {
      const u = px * ux + pz * uz, v = -px * uz + pz * ux;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) {
      const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
      best = { x: cu * ux - cv * uz, z: cu * uz + cv * ux, w: u1 - u0, d: v1 - v0, rot: 0, area };
      // frente (+z local) virada para o lado que contém o primeiro lado clicado
      const [p0x, p0z] = pts[0], [p1x, p1z] = pts[1];
      const mx = (p0x + p1x) / 2 - best.x, mz = (p0z + p1z) / 2 - best.z;
      const fu = mx * ux + mz * uz, fv = -mx * uz + mz * ux;
      // direção da frente no mundo: o eixo (u ou v) mais alinhado com o meio do primeiro lado
      let fx: number, fz: number, w = best.w, d = best.d;
      if (Math.abs(fv) / Math.max(1e-6, d) >= Math.abs(fu) / Math.max(1e-6, w)) { const sg = Math.sign(fv) || 1; fx = -uz * sg; fz = ux * sg; }
      else { const sg = Math.sign(fu) || 1; fx = ux * sg; fz = uz * sg; [w, d] = [d, w]; }
      best.w = w; best.d = d;
      best.rot = Math.atan2(fx, fz); // (sen rot, cos rot) = frente
    }
  }
  if (!best || best.w < MIN_LOT || best.d < MIN_LOT) return null;
  return { x: best.x, z: best.z, w: best.w, d: best.d, rot: best.rot };
}

function convexHull(pts: Array<[number, number]>): Array<[number, number]> {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Array<[number, number]> = [], upper: Array<[number, number]> = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

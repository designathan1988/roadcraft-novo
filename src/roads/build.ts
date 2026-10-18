// Construção de vias: encaixe em nós e trechos, cruzamentos automáticos com
// as vias atravessadas, perfil de altura com rampas (pontes e túneis saem
// sozinhos), divisão em trechos curtos, assentamento do relevo e remoção dos
// prédios no caminho. Tudo vira um diário de operações que desfaz e refaz
// exatamente, com os mesmos ids.

import { HEIGHT_MAP_RES, HEIGHT_TILE_RES, SEA_LEVEL, TERRAIN_MAX_Y, TERRAIN_MIN_Y } from '../config.ts';
import { Dirty } from '../core/grid.ts';
import type { Command } from '../core/commands.ts';
import { heightAt, heightIndex, sampleCoord, worldOfSample } from '../world/heights.ts';
import type { BuildingRec, World } from '../world/world.ts';
import { arcTable, bez, bezD, closestT, intersectQuads, splitQuad, subQuad, tAtLength, type Quad } from './geometry.ts';
import { MAX_SEG_LEN, type NodeRec, type RoadNetwork, type SegRec } from './network.ts';
import { SegFlag } from './flags.ts';
import { PROFILE_INFO, RING_PROFILE } from './profiles.ts';
import { BULB_R, BULB_WALK, armOf, bulbAt } from './junction.ts';
import type { JunctionSpec } from './control.ts';

// --------------------------------------------------------------- diário

type Op =
  | { t: 'addNode'; rec: NodeRec }
  | { t: 'remNode'; rec: NodeRec }
  | { t: 'addSeg'; rec: SegRec }
  | { t: 'remSeg'; rec: SegRec }
  | { t: 'profile'; id: number; from: number; to: number }
  | { t: 'zone'; id: number; side: number; from: number; to: number }
  | { t: 'junction'; id: number; from: JunctionSpec | null; to: JunctionSpec | null }
  | { t: 'addBld'; rec: number[] }
  | { t: 'remBld'; rec: number[] }
  | { t: 'terrain'; idx: Int32Array; before: Float32Array; after: Float32Array; x0: number; z0: number; x1: number; z1: number };

export class RoadJournal implements Command {
  readonly label: string;
  private ops: Op[] = [];
  private world: World;
  private net: RoadNetwork;

  constructor(world: World, label: string) {
    this.world = world;
    this.net = world.roads;
    this.label = label;
  }

  get empty(): boolean { return this.ops.length === 0; }

  /** Diferença no valor das vias (R$) feita por este diário. */
  private value = 0;
  /** Quanto foi cobrado (negativo = devolvido). */
  charge = 0;

  /** Valor de um trecho como está: comprimento × preço do perfil × estrutura (ponte 3×, túnel 4×). */
  private segValue(id: number, profile = this.net.segs.cols.profile[id]): number {
    const net = this.net, sc = net.segs.cols, nc = net.nodes.cols;
    const a = sc.a[id], b = sc.b[id];
    const q = net.quad(id);
    const p = new Float64Array(2);
    let k = 0;
    for (const t of [0.25, 0.5, 0.75]) {
      bez(q, t, p);
      const y = nc.y[a] + (nc.y[b] - nc.y[a]) * t, g = heightAt(this.world.heights, p[0], p[1]);
      k += y - g > 4 ? 3 : g - y > 5 ? 4 : y - g > 1.5 || g - y > 1.5 ? 1.4 : 1;
    }
    return sc.len[id] * PROFILE_INFO[profile].cost * k / 3;
  }

  /**
   * Cobra o que o diário construiu (demolir devolve metade). Sem dinheiro, desfaz e devolve false.
   * Chamado uma vez, logo depois das operações ao vivo.
   */
  /** Quanto custaria (antes de settle). */
  get price(): number { return Math.round(this.value); }

  settle(): boolean {
    const v = this.value;
    const charge = this.world.unlimited ? 0 : Math.round(v > 0 ? v : v * 0.5);
    if (charge > 0 && charge > this.world.money) { this.invert(); this.ops.length = 0; this.value = 0; return false; }
    this.charge = charge;
    this.world.money -= charge;
    return true;
  }

  // operações ao vivo (registram)
  addNode(x: number, z: number, y: number): number {
    const id = this.net.addNode({ x, z, y });
    this.ops.push({ t: 'addNode', rec: this.net.nodeRec(id) });
    return id;
  }
  /** Sobe ou desce um nó (os trechos ligados acompanham): tira e recoloca com os mesmos ids. */
  moveNodeY(id: number, y: number): void {
    const net = this.net;
    const segs = net.segsOf(id, []);
    const recs = segs.map((s) => net.segRec(s));
    for (const s of segs) this.removeSeg(s);
    const rec = net.nodeRec(id);
    this.removeNode(id);
    net.addNode({ ...rec, y });
    this.ops.push({ t: 'addNode', rec: net.nodeRec(id) });
    for (const r of recs) { net.addSeg(r); this.ops.push({ t: 'addSeg', rec: net.segRec(r.id) }); }
  }
  removeNode(id: number): void {
    const rec = this.net.nodeRec(id);
    this.net.removeNode(id);
    this.ops.push({ t: 'remNode', rec });
  }
  /** Registra um nó que já foi posto na rede (mover nó: mesmo id em outro lugar). */
  recordAddNode(id: number): void { this.ops.push({ t: 'addNode', rec: this.net.nodeRec(id) }); }
  addSeg(rec: Omit<SegRec, 'id'>): number {
    const id = this.net.addSeg(rec);
    this.ops.push({ t: 'addSeg', rec: this.net.segRec(id) });
    this.value += this.segValue(id);
    return id;
  }
  removeSeg(id: number): SegRec {
    this.value -= this.segValue(id);
    const rec = this.net.removeSeg(id);
    this.ops.push({ t: 'remSeg', rec });
    return rec;
  }
  setProfile(id: number, to: number): void {
    const from = this.net.segs.cols.profile[id];
    if (from === to) return;
    this.value += this.segValue(id, to) - this.segValue(id, from);
    this.net.setProfile(id, to);
    this.ops.push({ t: 'profile', id, from, to });
  }
  setZone(id: number, side: number, to: number): void {
    const sc = this.net.segs.cols;
    const from = (side === 0 ? sc.zl : sc.zr)[id];
    if (from === to) return;
    this.net.setZone(id, side, to);
    this.ops.push({ t: 'zone', id, side, from, to });
  }
  setJunction(id: number, to: JunctionSpec | null): void {
    const from = this.net.junctions.get(id) ?? null;
    this.net.setJunction(id, to);
    this.ops.push({ t: 'junction', id, from, to });
  }
  addBuilding(rec: BuildingRec): number {
    const id = this.world.addBuilding(rec);
    this.ops.push({ t: 'addBld', rec: this.world.buildingRec(id) });
    return id;
  }
  removeBuilding(id: number): void {
    const rec = this.world.buildingRec(id);
    this.world.removeBuilding(id);
    this.ops.push({ t: 'remBld', rec });
  }
  terrain(idx: Int32Array, before: Float32Array, after: Float32Array, box: [number, number, number, number]): void {
    const op: Op = { t: 'terrain', idx, before, after, x0: box[0], z0: box[1], x1: box[2], z1: box[3] };
    this.writeTerrain(op, after);
    this.ops.push(op);
  }

  private writeTerrain(op: Extract<Op, { t: 'terrain' }>, values: Float32Array): void {
    const w = this.world, h = w.heights;
    const shift = 2 * Math.log2(HEIGHT_TILE_RES);
    for (let k = 0; k < op.idx.length; k++) {
      const i = op.idx[k];
      h[i] = values[k];
      const tile = i >> shift;
      if (values[k] < w.tileMin[tile]) w.tileMin[tile] = values[k];
      if (values[k] > w.tileMax[tile]) w.tileMax[tile] = values[k];
      w.layerDirty.add(tile);
    }
    w.touchRect(op.x0, op.z0, op.x1, op.z1, Dirty.Terrain | Dirty.Buildings | Dirty.Roads);
  }

  private exec(op: Op, forward: boolean): void {
    const net = this.net;
    const doAdd = forward;
    switch (op.t) {
      case 'addNode': if (doAdd) net.addNode(op.rec); else net.removeNode(op.rec.id); break;
      case 'remNode': if (doAdd) net.removeNode(op.rec.id); else net.addNode(op.rec); break;
      case 'addSeg': if (doAdd) net.addSeg(op.rec); else net.removeSeg(op.rec.id); break;
      case 'remSeg': if (doAdd) net.removeSeg(op.rec.id); else net.addSeg(op.rec); break;
      case 'profile': net.setProfile(op.id, doAdd ? op.to : op.from); break;
      case 'zone': net.setZone(op.id, op.side, doAdd ? op.to : op.from); break;
      case 'junction': net.setJunction(op.id, doAdd ? op.to : op.from); break;
      case 'addBld': if (doAdd) this.world.restoreBuilding(op.rec); else this.world.removeBuilding(op.rec[0]); break;
      case 'remBld': if (doAdd) this.world.removeBuilding(op.rec[0]); else this.world.restoreBuilding(op.rec); break;
      case 'terrain': this.writeTerrain(op, doAdd ? op.after : op.before); break;
    }
  }

  /** Junta outro diário (ainda não cobrado) a este: vira um passo só de desfazer. */
  append(other: RoadJournal): void { this.ops.push(...other.ops); this.value += other.value; }

  apply(): void { for (const op of this.ops) this.exec(op, true); this.world.money -= this.charge; }
  invert(): void { for (let i = this.ops.length - 1; i >= 0; i--) this.exec(this.ops[i], false); this.world.money += this.charge; }
}

// --------------------------------------------------------------- encaixe

export interface Anchor {
  x: number; z: number;
  node: number; // -1 se não for nó
  seg: number; // -1 se não for trecho
  t: number;
}

/** Encaixa um ponto num nó (prioridade) ou num trecho existente. */
export function snap(net: RoadNetwork, x: number, z: number, radius: number): Anchor {
  const n = net.nearestNode(x, z, radius);
  if (n >= 0) return { x: net.nodes.cols.x[n], z: net.nodes.cols.z[n], node: n, seg: -1, t: 0 };
  const s = net.nearestSeg(x, z, radius * 0.8);
  if (s) {
    const q = net.quad(s[0]);
    const p = new Float64Array(2);
    bez(q, s[1], p);
    // perto da ponta: usa o nó
    const len = net.segs.cols.len[s[0]];
    if (s[1] * len < 6) return snap(net, q.x0, q.z0, 1);
    if ((1 - s[1]) * len < 6) return snap(net, q.x1, q.z1, 1);
    return { x: p[0], z: p[1], node: -1, seg: s[0], t: s[1] };
  }
  return { x, z, node: -1, seg: -1, t: 0 };
}

/** Altura de um trecho existente em t (linear entre os nós, pelo parâmetro). */
function segHeightAt(net: RoadNetwork, s: number, t: number): number {
  const sc = net.segs.cols, nc = net.nodes.cols;
  return nc.y[sc.a[s]] + (nc.y[sc.b[s]] - nc.y[sc.a[s]]) * t;
}

// --------------------------------------------------------------- plano

export interface Fixed { at: number; y: number }

/** Relevo suavizado (média num raio pequeno) para a via não copiar cada ondinha. */
function smoothGround(h: Float32Array, x: number, z: number): number {
  let s = 0;
  for (const [dx, dz] of [[0, 0], [5, 0], [-5, 0], [0, 5], [0, -5]]) s += heightAt(h, x + dx, z + dz);
  return s / 5;
}

/**
 * Alturas ao longo do caminho, a cada `step` metros: segue o relevo + desnível
 * pedido, passa por cima da água, respeita os pontos fixos e a rampa máxima.
 */
export function heightProfile(h: Float32Array, q: Quad, table: Float64Array, offset: number, maxGrade: number, fixed: Fixed[], step = 6): { at: Float64Array; y: Float64Array } {
  const len = table[table.length - 1];
  const n = Math.max(2, Math.ceil(len / step) + 1);
  const at = new Float64Array(n), y = new Float64Array(n);
  const isFixed = new Uint8Array(n);
  const p = new Float64Array(2);
  for (let i = 0; i < n; i++) {
    at[i] = len * i / (n - 1);
    bez(q, tAtLength(table, at[i]), p);
    const g = smoothGround(h, p[0], p[1]);
    y[i] = g < SEA_LEVEL + 0.5 ? SEA_LEVEL + 7 + offset : g + offset;
  }
  for (const f of fixed) {
    const i = Math.round(f.at / len * (n - 1));
    y[i] = f.y; isFixed[i] = 1;
  }
  // suaviza (a via não acompanha cada ondinha do relevo)
  for (let pass = 0; pass < 4; pass++) {
    let prev = y[0];
    for (let i = 1; i < n - 1; i++) {
      const cur = y[i];
      if (!isFixed[i]) y[i] = (prev + 2 * cur + y[i + 1]) / 4;
      prev = cur;
    }
  }
  const d = len / (n - 1);
  const g = maxGrade * d;
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < n; i++) if (!isFixed[i]) y[i] = Math.min(y[i - 1] + g, Math.max(y[i - 1] - g, y[i]));
    for (let i = n - 2; i >= 0; i--) if (!isFixed[i]) y[i] = Math.min(y[i + 1] + g, Math.max(y[i + 1] - g, y[i]));
  }
  return { at, y };
}

function profileY(pr: { at: Float64Array; y: Float64Array }, s: number): number {
  const { at, y } = pr;
  const n = at.length;
  if (s <= 0) return y[0];
  if (s >= at[n - 1]) return y[n - 1];
  const f = s / at[n - 1] * (n - 1);
  const i = Math.floor(f);
  return y[i] + (y[i + 1] - y[i]) * (f - i);
}

export interface RoadPlan {
  ok: boolean;
  reason: string;
  quad: Quad;
  /** Alturas ao longo, para a pré-visualização. */
  profile: { at: Float64Array; y: Float64Array };
  len: number;
  /** Cruzamentos em nível: [t no novo, trecho existente, t no existente]. */
  junctions: Array<[number, number, number]>;
}

const MIN_LEN = 8;

/** Planeja sem mexer em nada (pré-visualização e validação). */
export function planRoad(world: World, start: Anchor, control: { x: number; z: number } | null, end: Anchor, profile: number, offset: number): RoadPlan {
  const net = world.roads;
  const q: Quad = {
    x0: start.x, z0: start.z, x1: end.x, z1: end.z,
    cx: control ? control.x : (start.x + end.x) / 2, cz: control ? control.z : (start.z + end.z) / 2,
  };
  const table = arcTable(q, 64);
  const len = table[table.length - 1];
  const info = PROFILE_INFO[profile];
  const maxGrade = info.speed >= 80 ? 0.05 : 0.08;
  const fixed: Fixed[] = [];
  const nc = net.nodes.cols;
  if (start.node >= 0) fixed.push({ at: 0, y: nc.y[start.node] });
  else if (start.seg >= 0) fixed.push({ at: 0, y: segHeightAt(net, start.seg, start.t) });
  if (end.node >= 0) fixed.push({ at: len, y: nc.y[end.node] });
  else if (end.seg >= 0) fixed.push({ at: len, y: segHeightAt(net, end.seg, end.t) });
  let pr = heightProfile(world.heights, q, table, offset, maxGrade, fixed);

  const fail = (reason: string): RoadPlan => ({ ok: false, reason, quad: q, profile: pr, len, junctions: [] });
  if (len < MIN_LEN) return fail('curta demais');
  if (start.node >= 0 && start.node === end.node) return fail('liga o nó a ele mesmo');

  // cruzamentos com as vias atravessadas
  const junctions: Array<[number, number, number]> = [];
  const minX = Math.min(q.x0, q.cx, q.x1), maxX = Math.max(q.x0, q.cx, q.x1);
  const minZ = Math.min(q.z0, q.cz, q.z1), maxZ = Math.max(q.z0, q.cz, q.z1);
  const skip = new Set<number>();
  for (const a of [start, end]) {
    if (a.node >= 0) for (const s of net.segsOf(a.node)) skip.add(s);
    if (a.seg >= 0) skip.add(a.seg);
  }
  const eq: Quad = { x0: 0, z0: 0, cx: 0, cz: 0, x1: 0, z1: 0 };
  const d1 = new Float64Array(2), d2 = new Float64Array(2);
  let bad = '';
  net.forSegsNear(minX, minZ, maxX, maxZ, (s) => {
    if (skip.has(s) || bad) return;
    net.quad(s, eq);
    for (const [tn, to] of intersectQuads(q, eq)) {
      const yNew = profileY(pr, arcAtT(table, tn));
      const yOld = segHeightAt(net, s, to);
      if (Math.abs(yNew - yOld) < 4.5) {
        // ângulo do cruzamento
        bezD(q, tn, d1); bezD(eq, to, d2);
        const cos = Math.abs(d1[0] * d2[0] + d1[1] * d2[1]) / (Math.hypot(d1[0], d1[1]) * Math.hypot(d2[0], d2[1]) || 1);
        if (cos > 0.94) { bad = 'ângulo fechado demais com outra via'; return; }
        junctions.push([tn, s, to]);
      }
    }
  });
  if (bad) return fail(bad);
  junctions.sort((a, b) => a[0] - b[0]);
  // o mesmo ponto achado em dois trechos (passa por um nó existente): fica um só
  for (let i = junctions.length - 1; i > 0; i--) {
    if ((junctions[i][0] - junctions[i - 1][0]) * len < 3) junctions.splice(i, 1);
  }
  // cruzamento colado numa ponta da via nova vira a própria ponta
  while (junctions.length && junctions[0][0] * len < 3) junctions.shift();
  while (junctions.length && (1 - junctions[junctions.length - 1][0]) * len < 3) junctions.pop();
  // cruzamentos fixam a altura e entram no perfil
  if (junctions.length) {
    for (const [tn, s, to] of junctions) fixed.push({ at: arcAtT(table, tn), y: segHeightAt(net, s, to) });
    pr = heightProfile(world.heights, q, table, offset, maxGrade, fixed);
  }
  // pontos fixos muito juntos
  const ats = [0, ...junctions.map((j) => arcAtT(table, j[0])), len];
  for (let i = 1; i < ats.length; i++) if (ats[i] - ats[i - 1] < 6) return { ...fail('cruzamentos muito próximos'), junctions };
  // rampa possível?
  for (let i = 1; i < pr.at.length; i++) {
    if (Math.abs(pr.y[i] - pr.y[i - 1]) / (pr.at[i] - pr.at[i - 1]) > maxGrade * 1.9) return { ...fail('rampa íngreme demais'), junctions };
  }
  return { ok: true, reason: '', quad: q, profile: pr, len, junctions };
}

function arcAtT(table: Float64Array, t: number): number {
  const n = table.length - 1;
  const f = t * n, i = Math.min(n - 1, Math.floor(f));
  return table[i] + (table[i + 1] - table[i]) * (f - i);
}

// ------------------------------------------------------------ execução

/** Divide um trecho em t, devolvendo o nó novo. */
function splitSeg(j: RoadJournal, net: RoadNetwork, s: number, t: number, y: number | null): number {
  const q = net.quad(s);
  const rec = net.segRec(s);
  const [a, b] = splitQuad(q, t);
  const yy = y ?? segHeightAt(net, s, t);
  j.removeSeg(s);
  const n = j.addNode(a.x1, a.z1, yy);
  j.addSeg({ a: rec.a, b: n, cx: a.cx, cz: a.cz, profile: rec.profile, flags: rec.flags, zl: rec.zl, zr: rec.zr });
  j.addSeg({ a: n, b: rec.b, cx: b.cx, cz: b.cz, profile: rec.profile, flags: rec.flags, zl: rec.zl, zr: rec.zr });
  return n;
}

/** Resolve uma âncora em nó (dividindo o trecho se preciso). */
function anchorNode(j: RoadJournal, net: RoadNetwork, a: Anchor, y: number): number {
  if (a.node >= 0 && net.nodes.alive[a.node]) return a.node;
  if (a.seg >= 0 && net.segs.alive[a.seg]) return splitSeg(j, net, a.seg, a.t, null);
  // o trecho pode ter sido dividido pela outra ponta: procura de novo
  const again = snap(net, a.x, a.z, 3);
  if (again.node >= 0) return again.node;
  if (again.seg >= 0) return splitSeg(j, net, again.seg, again.t, null);
  return j.addNode(a.x, a.z, y);
}

export function buildRoad(world: World, plan: RoadPlan, start: Anchor, end: Anchor, profile: number, flags = 0, label = 'construir via'): RoadJournal {
  const net = world.roads;
  const j = new RoadJournal(world, label);
  const q = plan.quad;
  const table = arcTable(q, 64);
  const pr = plan.profile;

  // pontos de parada ao longo: pontas, cruzamentos e divisões por comprimento
  const stops: Array<{ t: number; node: number }> = [];
  stops.push({ t: 0, node: anchorNode(j, net, start, pr.y[0]) });
  for (const [tn, s, to] of plan.junctions) {
    // o trecho atravessado pode já ter sido dividido por outro cruzamento: acha a parte certa
    const p = new Float64Array(2); bez(q, tn, p);
    let seg = s, tt = to;
    if (!net.segs.alive[seg]) {
      const near = net.nearestSeg(p[0], p[1], 3);
      if (!near) continue;
      seg = near[0]; tt = near[1];
    }
    const sl = net.segs.cols.len[seg];
    let node: number;
    if (tt * sl < 6) node = net.segs.cols.a[seg];
    else if ((1 - tt) * sl < 6) node = net.segs.cols.b[seg];
    else node = splitSeg(j, net, seg, tt, null);
    stops.push({ t: tn, node });
  }
  stops.push({ t: 1, node: anchorNode(j, net, end, pr.y[pr.y.length - 1]) });

  const nc = net.nodes.cols;
  // alturas finais por trecho (lineares entre nós): o relevo é assentado nelas
  const knotS: number[] = [], knotY: number[] = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    const a = stops[i], b = stops[i + 1];
    if (a.node === b.node) continue;
    const sa = arcAtT(table, a.t), sb = arcAtT(table, b.t);
    const ya = nc.y[a.node], yb = nc.y[b.node];
    // divisão adaptativa: pedaços onde a reta entre nós desvia do perfil viram dois
    const cuts: number[] = [sa, sb];
    const cutY = new Map<number, number>([[sa, ya], [sb, yb]]);
    const yAtCut = (x: number) => cutY.get(x) ?? profileY(pr, x);
    const refine = (s0: number, s1: number, depth: number) => {
      const len = s1 - s0;
      let worst = 0;
      const y0 = yAtCut(s0), y1 = yAtCut(s1);
      for (let f = 0.125; f < 1; f += 0.125) worst = Math.max(worst, Math.abs(profileY(pr, s0 + len * f) - (y0 + (y1 - y0) * f)));
      if ((len > MAX_SEG_LEN || (worst > 0.4 && len > 30)) && depth < 8) {
        const m = (s0 + s1) / 2;
        cuts.push(m);
        refine(s0, m, depth + 1);
        refine(m, s1, depth + 1);
      }
    };
    refine(sa, sb, 0);
    cuts.sort((x, y) => x - y);
    const pieces = cuts.length - 1;
    const yOf = (k: number, _n: number) => yAtCut(cuts[k]);
    let prev = a.node;
    for (let k = 1; k <= pieces; k++) {
      const s1 = cuts[k];
      const t0 = tAtLength(table, cuts[k - 1]), t1 = tAtLength(table, s1);
      const sub = subQuad(q, t0, t1);
      const next = k === pieces ? b.node : j.addNode(sub.x1, sub.z1, yOf(k, pieces));
      // a curva liga os nós reais (que podem ter escorregado uns centímetros)
      const cx = sub.cx + ((nc.x[prev] - sub.x0) + (nc.x[next] - sub.x1)) / 2;
      const cz = sub.cz + ((nc.z[prev] - sub.z0) + (nc.z[next] - sub.z1)) / 2;
      j.addSeg({ a: prev, b: next, cx, cz, profile, flags });
      knotS.push(cuts[k - 1]); knotY.push(nc.y[prev]);
      prev = next;
    }
    knotS.push(sb); knotY.push(nc.y[b.node]);
  }
  const yLinear = (s: number): number => {
    if (knotS.length === 0) return profileY(pr, s);
    if (s <= knotS[0]) return knotY[0];
    for (let i = 1; i < knotS.length; i++) {
      if (s <= knotS[i]) {
        const f = (s - knotS[i - 1]) / Math.max(1e-6, knotS[i] - knotS[i - 1]);
        return knotY[i - 1] + (knotY[i] - knotY[i - 1]) * f;
      }
    }
    return knotY[knotY.length - 1];
  };
  clearAndConform(j, world, q, profile, yLinear, table, (flags & SegFlag.Wall) !== 0);
  // pontas sem saída com balão: o relevo assenta no círculo
  for (const n of [stops[0].node, stops[stops.length - 1].node]) if (bulbAt(net, n)) conformDisc(j, world, nc.x[n], nc.z[n], BULB_R + BULB_WALK + 6, nc.y[n]);
  return j;
}

export { bulbAt };

/**
 * Tira os prédios do caminho e assenta o relevo sob a via onde ela está
 * perto do chão (não sob pontes nem sobre túneis).
 */
function clearAndConform(j: RoadJournal, world: World, q: Quad, profile: number, yAt: (s: number) => number, table: Float64Array, wallCut = false): void {
  const len = table[table.length - 1];
  const half = PROFILE_INFO[profile].right;
  const blend = 7;
  const reach = half + blend;
  // pontos da linha central a cada 2 m
  const n = Math.max(2, Math.ceil(len / 2) + 1);
  const px = new Float64Array(n), pz = new Float64Array(n), py = new Float64Array(n);
  const p = new Float64Array(2);
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const s = len * i / (n - 1);
    bez(q, tAtLength(table, s), p);
    px[i] = p[0]; pz[i] = p[1]; py[i] = yAt(s);
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]);
  }
  const nearest = (x: number, z: number): [number, number] => {
    let bd = Infinity, bi = 0;
    for (let i = 0; i < n; i++) { const d = (px[i] - x) ** 2 + (pz[i] - z) ** 2; if (d < bd) { bd = d; bi = i; } }
    return [Math.sqrt(bd), bi];
  };

  // prédios no caminho
  const col = world.buildings.cols;
  const doomed: number[] = [];
  world.buildingIndex.query(minX - reach - 40, minZ - reach - 40, maxX + reach + 40, maxZ + reach + 40, (id) => {
    const r = Math.hypot(col.w[id], col.d[id]) / 2;
    const [d] = nearest(col.x[id], col.z[id]);
    if (d < half + r * 0.8) doomed.push(id);
  });
  for (const id of doomed) j.removeBuilding(id);

  // relevo
  const h = world.heights;
  const gx0 = Math.max(0, Math.floor(sampleCoord(minX - reach))), gx1 = Math.min(HEIGHT_MAP_RES - 1, Math.ceil(sampleCoord(maxX + reach)));
  const gz0 = Math.max(0, Math.floor(sampleCoord(minZ - reach))), gz1 = Math.min(HEIGHT_MAP_RES - 1, Math.ceil(sampleCoord(maxZ + reach)));
  const idx: number[] = [], before: number[] = [], after: number[] = [];
  for (let gz = gz0; gz <= gz1; gz++) {
    const z = worldOfSample(gz);
    for (let gx = gx0; gx <= gx1; gx++) {
      const x = worldOfSample(gx);
      const [d, i] = nearest(x, z);
      if (d >= reach) continue;
      // além das pontas não mexe: lá mandam as vias vizinhas
      if (i === 0 && (x - px[0]) * (px[1] - px[0]) + (z - pz[0]) * (pz[1] - pz[0]) < 0) continue;
      if (i === n - 1 && (x - px[n - 1]) * (px[n - 2] - px[n - 1]) + (z - pz[n - 1]) * (pz[n - 2] - pz[n - 1]) < 0) continue;
      const k = heightIndex(gx, gz);
      const old = h[k];
      const target = py[i] - 0.06;
      const gap = target - old; // + aterro, - corte
      if (gap > 4.5 || gap < -7) continue; // ponte ou túnel: o relevo fica
      if (old < SEA_LEVEL + 0.3) continue; // nunca aterra a água: vira ponte
      // corte com muro de arrimo: o terreno sobe logo na borda (o muro cobre); talude: rampa de 7 m
      const bl = wallCut && gap < 0 ? 1.2 : blend;
      if (d >= half + bl) continue;
      const w = d <= half + 0.5 ? 1 : 1 - smooth((d - half - 0.5) / (bl - 0.5));
      const v = Math.max(TERRAIN_MIN_Y, Math.min(TERRAIN_MAX_Y, old + gap * w));
      if (Math.abs(v - old) < 0.005) continue;
      idx.push(k); before.push(old); after.push(v);
    }
  }
  if (idx.length) j.terrain(new Int32Array(idx), new Float32Array(before), new Float32Array(after), [minX - reach, minZ - reach, maxX + reach, maxZ + reach]);
}

function smooth(t: number): number { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); }

// ------------------------------------------------------------ outras edições

/** Demole um trecho; nós que ficam soltos somem junto. */
export function demolishSeg(world: World, s: number): RoadJournal {
  const net = world.roads;
  const j = new RoadJournal(world, 'demolir via');
  const rec = j.removeSeg(s);
  for (const n of [rec.a, rec.b]) if (net.nodes.alive[n] && net.nodes.cols.deg[n] === 0) j.removeNode(n);
  return j;
}

export function changeProfile(world: World, s: number, profile: number): RoadJournal {
  const j = new RoadJournal(world, 'trocar perfil');
  if (world.roads.segs.cols.flags[s] & SegFlag.Ring) return j;
  j.setProfile(s, profile);
  return j;
}

/**
 * A rua inteira de um trecho: segue pelos nós escolhendo, em cada um, o trecho
 * que continua mais reto (até 35°) e com o mesmo perfil. Mão única só segue no mesmo sentido.
 */
export function streetChain(world: World, s0: number): number[] {
  const net = world.roads, sc = net.segs.cols;
  const prof = sc.profile[s0];
  const oneWay = PROFILE_INFO[prof].oneWay;
  const out = [s0];
  const seen = new Set([s0]);
  const q: Quad = { x0: 0, z0: 0, cx: 0, cz: 0, x1: 0, z1: 0 };
  const list: number[] = [];
  for (const startEnd of [1, 0] as const) {
    let s = s0, end: 0 | 1 = startEnd;
    for (let guard = 0; guard < 4000; guard++) {
      const n = end === 1 ? sc.b[s] : sc.a[s];
      const here = armOf(net.quad(s, q), prof, end);
      // rumo de chegada = contrário do braço
      const hx = -here.dx, hz = -here.dz;
      let best = -1, bestDot = Math.cos(35 * Math.PI / 180), bestEnd: 0 | 1 = 0;
      for (const t of net.segsOf(n, list)) {
        if (seen.has(t) || sc.profile[t] !== prof || (sc.flags[t] & SegFlag.Ring)) continue;
        const tEnd: 0 | 1 = sc.a[t] === n ? 0 : 1;
        if (oneWay && tEnd !== (end === 1 ? 0 : 1)) continue;
        const arm = armOf(net.quad(t, q), prof, tEnd);
        const d = arm.dx * hx + arm.dz * hz;
        if (d > bestDot) { bestDot = d; best = t; bestEnd = tEnd; }
      }
      if (best < 0) break;
      seen.add(best); out.push(best);
      s = best; end = bestEnd === 0 ? 1 : 0;
    }
  }
  return out;
}

/** Troca o perfil de vários trechos num só comando. */
export function changeProfiles(world: World, segs: number[], profile: number): RoadJournal {
  const j = new RoadJournal(world, 'trocar perfil da rua');
  for (const s of segs) if (!(world.roads.segs.cols.flags[s] & SegFlag.Ring)) j.setProfile(s, profile);
  return j;
}

/**
 * Rotatória: corta as vias dentro do círculo, liga as pontas ao anel e fecha o
 * anel em arcos (mão anti-horária vista de cima).
 */
export function buildRoundabout(world: World, cx: number, cz: number, radius: number): RoadJournal | null {
  const net = world.roads;
  const j = new RoadJournal(world, 'rotatória');
  const y = smoothGround(world.heights, cx, cz);
  const cut = radius;
  const entries: Array<{ angle: number; node: number }> = [];
  const approaches: number[] = [];
  const victims: number[] = [];
  net.forSegsNear(cx - cut, cz - cut, cx + cut, cz + cut, (s) => victims.push(s));
  const q: Quad = { x0: 0, z0: 0, cx: 0, cz: 0, x1: 0, z1: 0 };
  const p = new Float64Array(2);
  const created = new Set<number>(); // ids novos podem reaproveitar ids de vítimas
  for (const s of victims) {
    if (!net.segs.alive[s] || created.has(s)) continue;
    net.quad(s, q);
    const inside = (t: number) => { bez(q, t, p); return Math.hypot(p[0] - cx, p[1] - cz) < cut; };
    const ia = inside(0), ib = inside(1);
    // acha cruzamentos com o círculo por amostragem + bisseção
    const crossings: number[] = [];
    const N = 32;
    for (let k = 0; k < N; k++) {
      const a = k / N, b = (k + 1) / N;
      if (inside(a) !== inside(b)) {
        let lo = a, hi = b;
        for (let it = 0; it < 24; it++) { const m = (lo + hi) / 2; if (inside(m) === inside(a)) lo = m; else hi = m; }
        crossings.push((lo + hi) / 2);
      }
    }
    if (!ia && !ib && crossings.length === 0) continue;
    const rec = net.segRec(s);
    if (rec.flags & SegFlag.Ring) return null; // já há rotatória aqui
    j.removeSeg(s);
    // mantém as partes de fora
    const pts = [0, ...crossings, 1];
    for (let k = 0; k + 1 < pts.length; k++) {
      const t0 = pts[k], t1 = pts[k + 1];
      if (inside((t0 + t1) / 2)) continue;
      let sub = subQuad(q, t0, t1);
      // o anel fica plano na altura do centro; a entrada rampa até o resto da via
      let na = t0 === 0 ? rec.a : j.addNode(sub.x0, sub.z0, y);
      let nb = t1 === 1 ? rec.b : j.addNode(sub.x1, sub.z1, y);
      if (t0 !== 0) entries.push({ angle: Math.atan2(-(sub.z0 - cz), sub.x0 - cx), node: na });
      if (t1 !== 1) entries.push({ angle: Math.atan2(-(sub.z1 - cz), sub.x1 - cx), node: nb });
      // pedaço curto até uma simples emenda da mesma via: engole a emenda
      const outer = t0 === 0 ? rec.a : t1 === 1 ? rec.b : -1;
      const pieceLen = Math.hypot(sub.x1 - sub.x0, sub.z1 - sub.z0);
      if (outer >= 0 && pieceLen < 14 && net.nodes.cols.deg[outer] === 1) {
        const [other] = net.segsOf(outer);
        const orec = j.removeSeg(other);
        const far = orec.a === outer ? orec.b : orec.a;
        const ring = outer === na ? nb : na;
        j.removeNode(outer);
        const nc2 = net.nodes.cols;
        sub = { x0: 0, z0: 0, cx: (nc2.x[far] + nc2.x[ring]) / 2, cz: (nc2.z[far] + nc2.z[ring]) / 2, x1: 0, z1: 0 };
        if (outer === na) { na = far; nb = ring; } else { na = ring; nb = far; }
      }
      const ns = j.addSeg({ a: na, b: nb, cx: sub.cx, cz: sub.cz, profile: rec.profile, flags: rec.flags, zl: rec.zl, zr: rec.zr });
      created.add(ns);
      approaches.push(ns);
    }
  }
  // nós que ficaram dentro e soltos
  const loose: number[] = [];
  net.nodeIndex.query(cx - cut, cz - cut, cx + cut, cz + cut, (n) => { if (net.nodes.cols.deg[n] === 0) loose.push(n); });
  for (const n of loose) j.removeNode(n);

  // anel: nós de entrada (já no círculo) + nós extras para arcos de no máximo 50°
  const ring = entries.map((e) => ({ angle: e.angle, node: e.node }));
  const maxArc = Math.PI * 50 / 180;
  ring.sort((a, b) => a.angle - b.angle);
  const filled: Array<{ angle: number; node: number }> = [];
  const nRing = ring.length;
  if (nRing === 0) {
    const k = 6;
    for (let i = 0; i < k; i++) {
      const a = -Math.PI + (2 * Math.PI * i) / k;
      filled.push({ angle: a, node: j.addNode(cx + Math.cos(a) * radius, cz - Math.sin(a) * radius, y) });
    }
  } else {
    for (let i = 0; i < nRing; i++) {
      const a = ring[i], b = ring[(i + 1) % nRing];
      filled.push(a);
      let span = b.angle - a.angle;
      if (span <= 0) span += Math.PI * 2;
      const extra = Math.ceil(span / maxArc) - 1;
      for (let k = 1; k <= extra; k++) {
        const ang = a.angle + span * k / (extra + 1);
        filled.push({ angle: ang, node: j.addNode(cx + Math.cos(ang) * radius, cz - Math.sin(ang) * radius, y) });
      }
    }
  }
  for (let i = 0; i < filled.length; i++) {
    const a = filled[i], b = filled[(i + 1) % filled.length];
    let span = b.angle - a.angle;
    if (span <= 0) span += Math.PI * 2;
    const mid = a.angle + span / 2;
    const r = radius / Math.cos(span / 2);
    j.addSeg({ a: a.node, b: b.node, cx: cx + Math.cos(mid) * r, cz: cz - Math.sin(mid) * r, profile: RING_PROFILE, flags: SegFlag.Ring });
  }
  // relevo sob o anel
  conformDisc(j, world, cx, cz, radius + PROFILE_INFO[RING_PROFILE].right + 6, y);
  // as entradas assentam por cima do disco
  for (const s of approaches) {
    if (!net.segs.alive[s]) continue;
    const sq = net.quad(s);
    const t = arcTable(sq, 32);
    const ya = net.nodes.cols.y[net.segs.cols.a[s]], yb = net.nodes.cols.y[net.segs.cols.b[s]];
    const L = t[t.length - 1];
    clearAndConform(j, world, sq, net.segs.cols.profile[s], (d) => ya + (yb - ya) * d / L, t);
  }
  return j;
}

function conformDisc(j: RoadJournal, world: World, cx: number, cz: number, r: number, y: number): void {
  const h = world.heights;
  const gx0 = Math.max(0, Math.floor(sampleCoord(cx - r))), gx1 = Math.min(HEIGHT_MAP_RES - 1, Math.ceil(sampleCoord(cx + r)));
  const gz0 = Math.max(0, Math.floor(sampleCoord(cz - r))), gz1 = Math.min(HEIGHT_MAP_RES - 1, Math.ceil(sampleCoord(cz + r)));
  const idx: number[] = [], before: number[] = [], after: number[] = [];
  for (let gz = gz0; gz <= gz1; gz++) for (let gx = gx0; gx <= gx1; gx++) {
    const d = Math.hypot(worldOfSample(gx) - cx, worldOfSample(gz) - cz);
    if (d > r) continue;
    const k = heightIndex(gx, gz);
    const w = d < r - 6 ? 1 : 1 - smooth((d - (r - 6)) / 6);
    const v = h[k] + (y - 0.06 - h[k]) * w;
    idx.push(k); before.push(h[k]); after.push(v);
  }
  if (idx.length) j.terrain(new Int32Array(idx), new Float32Array(before), new Float32Array(after), [cx - r, cz - r, cx + r, cz + r]);
}

/** Pré-visualização de um trecho existente (para demolir/trocar). */
export function segPreview(net: RoadNetwork, s: number): { quad: Quad; ya: number; yb: number; half: number } {
  const sc = net.segs.cols, nc = net.nodes.cols;
  return { quad: net.quad(s), ya: nc.y[sc.a[s]], yb: nc.y[sc.b[s]], half: PROFILE_INFO[sc.profile[s]].right };
}

export { closestT };

// ------------------------------------------- mover, dividir, inverter, unir, duplicar

/** Trechos da via entre dois cruzamentos (passa pelos nós de grau 2 com o mesmo perfil), em ordem. */
export function roadBetweenJunctions(world: World, s0: number): number[] {
  const net = world.roads, sc = net.segs.cols, nc = net.nodes.cols;
  const prof = sc.profile[s0];
  const walk = (from: number, node: number): number[] => {
    const out: number[] = [];
    let s = from, n = node;
    for (let guard = 0; guard < 2000 && nc.deg[n] === 2; guard++) {
      const t = net.segsOf(n, []).find((x) => x !== s);
      if (t === undefined || sc.profile[t] !== prof || (sc.flags[t] & SegFlag.Ring) || out.includes(t) || t === s0) break;
      out.push(t);
      n = sc.a[t] === n ? sc.b[t] : sc.a[t];
      s = t;
    }
    return out;
  };
  return [...walk(s0, sc.a[s0]).reverse(), s0, ...walk(s0, sc.b[s0])];
}

/** Divide o trecho em `t` (0..1) com um nó novo. */
export function splitAt(world: World, s: number, t = 0.5): RoadJournal {
  const j = new RoadJournal(world, 'dividir via');
  const L = world.roads.segs.cols.len[s];
  if (t * L < 4 || (1 - t) * L < 4) return j;
  splitSeg(j, world.roads, s, t, null);
  return j;
}

/** Faixa de pedestres no meio do trecho: um nó novo em `t` com o controle (zebra ou semáforo). */
export function addCrossing(world: World, s: number, t: number, ctl: number): RoadJournal | string {
  const net = world.roads, sc = net.segs.cols;
  if (!PROFILE_INFO[sc.profile[s]].walk) return 'Esta via não tem pedestres.';
  const L = sc.len[s];
  if (t * L < 14 || (1 - t) * L < 14) return 'A faixa precisa de espaço para uma fila de carros dos dois lados.';
  const j = new RoadJournal(world, 'faixa de pedestres');
  const n = splitSeg(j, net, s, t, null);
  j.setJunction(n, { ctl });
  return j;
}

/** Retorno no canteiro: um nó novo em `t` onde a faixa da esquerda volta pelo outro sentido. */
export function addUTurn(world: World, s: number, t: number): RoadJournal | string {
  const net = world.roads, sc = net.segs.cols;
  const info = PROFILE_INFO[sc.profile[s]];
  const med = info.edges.find((e) => e.strip.kind === 'median');
  if (info.oneWay || !med) return 'O retorno precisa de uma via de mão dupla com canteiro central.';
  if (med.u1 - med.u0 < 1.5) return 'Canteiro estreito demais para um retorno.';
  const L = sc.len[s];
  if (t * L < 16 || (1 - t) * L < 16) return 'O retorno precisa de espaço para uma fila de carros dos dois lados.';
  const j = new RoadJournal(world, 'retorno');
  const n = splitSeg(j, net, s, t, null);
  j.setJunction(n, { ctl: 11 });
  return j;
}

/** Inverte o sentido da via de mão única entre dois cruzamentos (as pontas de cada trecho trocam). */
export function reverseRoad(world: World, s: number): RoadJournal {
  const net = world.roads, j = new RoadJournal(world, 'inverter mão');
  if (!PROFILE_INFO[net.segs.cols.profile[s]].oneWay) return j;
  for (const id of roadBetweenJunctions(world, s)) {
    const r = j.removeSeg(id);
    j.addSeg({ a: r.b, b: r.a, cx: r.cx, cz: r.cz, profile: r.profile, flags: r.flags, zl: r.zr, zr: r.zl });
  }
  return j;
}

/** Une as duas vias de um nó de grau 2 (mesmo perfil) num trecho só. Vazio se não der. */
export function joinAt(world: World, n: number): RoadJournal {
  const net = world.roads, sc = net.segs.cols, nc = net.nodes.cols;
  const j = new RoadJournal(world, 'unir vias');
  const segs = net.segsOf(n, []);
  if (segs.length !== 2) return j;
  const [s1, s2] = segs;
  if (sc.profile[s1] !== sc.profile[s2] || sc.flags[s1] !== sc.flags[s2] || (sc.flags[s1] & SegFlag.Ring)) return j;
  if (sc.len[s1] + sc.len[s2] > MAX_SEG_LEN * 2) return j;
  // pontas em ordem (s1 chega ao nó, s2 sai dele), respeitando o sentido de mão única
  const p = sc.a[s1] === n ? sc.b[s1] : sc.a[s1], q = sc.a[s2] === n ? sc.b[s2] : sc.a[s2];
  if (p === q) return j;
  const forward = sc.b[s1] === n;
  if (PROFILE_INFO[sc.profile[s1]].oneWay && forward !== (sc.a[s2] === n)) return j;
  // controle que faz a curva passar pelo nó em t = 0,5
  const cx = 2 * nc.x[n] - (nc.x[p] + nc.x[q]) / 2, cz = 2 * nc.z[n] - (nc.z[p] + nc.z[q]) / 2;
  const r1 = j.removeSeg(s1); j.removeSeg(s2);
  j.removeNode(n);
  const [a, b] = forward ? [p, q] : [q, p];
  j.addSeg({ a, b, cx, cz, profile: r1.profile, flags: r1.flags, zl: forward ? r1.zl : r1.zr, zr: forward ? r1.zr : r1.zl });
  return j;
}

/** Leva o nó para (x, z): as vias ligadas acompanham (curvas transladadas pela metade). Recusa vias curtas demais. */
export function moveNode(world: World, n: number, x: number, z: number): RoadJournal | string {
  const net = world.roads, sc = net.segs.cols, nc = net.nodes.cols;
  const j = new RoadJournal(world, 'mover nó');
  const dx = x - nc.x[n], dz = z - nc.z[n];
  const segs = net.segsOf(n, []);
  for (const s of segs) {
    const o = sc.a[s] === n ? sc.b[s] : sc.a[s];
    if (Math.hypot(nc.x[o] - x, nc.z[o] - z) < 8) return 'uma via ali ficaria curta demais';
    if (sc.flags[s] & SegFlag.Ring) return 'nó de rotatória não se move';
  }
  const recs = segs.map((s) => j.removeSeg(s));
  const rec = net.nodeRec(n);
  j.removeNode(n);
  net.addNode({ ...rec, x, z, y: heightAt(world.heights, x, z) > rec.y + 4 || heightAt(world.heights, x, z) < rec.y - 4 ? rec.y : Math.max(rec.y, heightAt(world.heights, x, z)) });
  j.recordAddNode(n);
  for (const r of recs) j.addSeg({ ...r, cx: r.cx + dx / 2, cz: r.cz + dz / 2 });
  return j;
}

/** Via igual paralela à via entre cruzamentos, ao lado (pela direita do desenho). */
export function duplicateRoad(world: World, s: number): RoadJournal | string {
  const net = world.roads, sc = net.segs.cols, nc = net.nodes.cols;
  const road = roadBetweenJunctions(world, s);
  const prof = sc.profile[s];
  const info = PROFILE_INFO[prof];
  const off = info.left + info.right + 2;
  // pontos em ordem ao longo da via
  const first = road[0];
  let start = road.length > 1 && (sc.a[first] === sc.a[road[1]] || sc.a[first] === sc.b[road[1]]) ? sc.b[first] : sc.a[first];
  const total = new RoadJournal(world, 'duplicar via');
  let prev: Anchor | null = null;
  const d = new Float64Array(2);
  for (const id of road) {
    const fwd = sc.a[id] === start;
    const q = net.quad(id);
    const pts = fwd ? [q.x0, q.z0, q.cx, q.cz, q.x1, q.z1] : [q.x1, q.z1, q.cx, q.cz, q.x0, q.z0];
    const shifted: number[] = [];
    for (const [i, t] of [[0, 0], [1, 0.5], [2, 1]] as const) {
      bezD(q, fwd ? t : 1 - t, d);
      const l = Math.hypot(d[0], d[1]) || 1, sgn = fwd ? 1 : -1;
      const nx = (d[1] / l) * sgn, nz = (-d[0] / l) * sgn;
      shifted.push(pts[i * 2] + nx * off, pts[i * 2 + 1] + nz * off);
    }
    const a: Anchor = prev ?? snap(net, shifted[0], shifted[1], 2);
    const b = snap(net, shifted[4], shifted[5], 2);
    const plan = planRoad(world, a, { x: shifted[2], z: shifted[3] }, b, prof, 0);
    if (!plan.ok) { total.invert(); return plan.reason; }
    const j = buildRoad(world, plan, a, b, prof, 0, 'duplicar via');
    total.append(j);
    prev = snap(net, shifted[4], shifted[5], 1.5);
    start = fwd ? sc.b[id] : sc.a[id];
  }
  void nc;
  return total;
}

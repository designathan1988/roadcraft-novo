// Road network: nodes and segments in SoA tables, dense adjacency, spatial index.
// Every change goes through addNode/addSeg/removeSeg/removeNode, which mark the
// dirty cells (the segment, the nodes and the neighbours that depend on the nodes).

import { CELL_SIZE, CELLS_PER_TILE, MAP_TILES } from '../config.ts';
import { CELL_COUNT, Dirty, SpatialIndex, cellId, cellX } from '../core/grid.ts';
import { Table } from '../core/table.ts';
import { NODE_REC, SEG_REC, type RoadGraph, type RoadSave } from '../jobs/protocol.ts';
import { bez, bezLength, closestT, type Quad } from './geometry.ts';

export const MAX_DEG = 8;
/** Segments are split while drawing so they never exceed this (the index uses the midpoint). */
export const MAX_SEG_LEN = 112;
const SEG_MARGIN = MAX_SEG_LEN / 2 + 40;
/** How far from a road its lots reach: half the widest road (≈ 25 m), the deepest lot (72 m) and a margin. */
const LOT_REACH = 100;

export { SegFlag } from './flags.ts';
import { SegFlag } from './flags.ts';
import { kindOfFlags } from './economy.ts';

export const nodeSchema = { x: Float32Array, z: Float32Array, y: Float32Array, deg: Uint8Array, cell: Int32Array };
export const segSchema = {
  a: Int32Array, b: Int32Array, cx: Float32Array, cz: Float32Array,
  profile: Uint8Array, flags: Uint8Array, len: Float32Array, cell: Int32Array,
  mx: Float32Array, mz: Float32Array,
  /** Zone on each side (left/right in the a → b direction). */
  zl: Uint8Array, zr: Uint8Array,
};

/** Receiver of dirty-cell marks (the world on the page; nothing in the worker). */
export interface CellToucher { touchCell(cid: number, kinds: number): void }

/** A network change, to mirror elsewhere. */
export type NetOp =
  | { t: 'addNode'; rec: NodeRec }
  | { t: 'remNode'; id: number }
  | { t: 'addSeg'; rec: SegRec }
  | { t: 'remSeg'; id: number }
  | { t: 'profile'; id: number; profile: number }
  | { t: 'zone'; id: number; side: number; zone: number }
  | { t: 'junction'; id: number; spec: JunctionSpec | null }
  | { t: 'clear' };

/** A node's data, for recording in commands. */
export interface NodeRec { id: number; x: number; z: number; y: number; /** control chosen by the player */ j?: JunctionSpec }
export interface SegRec { id: number; a: number; b: number; cx: number; cz: number; profile: number; flags: number; zl?: number; zr?: number }
export { Zone } from './zones.ts';
import { effectiveControl, type JunctionSpec, isMidNode } from './control.ts';
import { BULB_R, NODE_BULB, bulbAt } from './junction.ts';

const p2 = new Float64Array(2);

export class RoadNetwork {
  readonly nodes = new Table(nodeSchema, 1 << 14);
  readonly segs = new Table(segSchema, 1 << 14);
  readonly nodeIndex = new SpatialIndex(1 << 14);
  readonly segIndex = new SpatialIndex(1 << 14);
  adj = new Int32Array((1 << 14) * MAX_DEG).fill(-1);
  /** Segments (by midpoint) and nodes per cell. */
  readonly cellCount = new Uint32Array(CELL_COUNT);
  private world: CellToucher;
  /** Change listeners (the simulation worker mirrors the network through here). */
  readonly listeners: Array<(op: NetOp) => void> = [];
  /** Junctions with a player-chosen control (the others are automatic). */
  readonly junctions = new Map<number, JunctionSpec>();
  /** What the flow measured by the simulation asks for at automatic junctions (Flow; page only, not sent to the sim). */
  readonly flow = new Map<number, number>();

  constructor(world: CellToucher) {
    this.world = world;
    this.nodes.onGrow((cap) => {
      this.nodeIndex.grow(cap);
      const a = new Int32Array(cap * MAX_DEG).fill(-1); a.set(this.adj); this.adj = a;
    });
    this.segs.onGrow((cap) => this.segIndex.grow(cap));
  }

  quad(s: number, out?: Quad): Quad {
    const c = this.segs.cols, n = this.nodes.cols;
    const q = out ?? { x0: 0, z0: 0, cx: 0, cz: 0, x1: 0, z1: 0 };
    q.x0 = n.x[c.a[s]]; q.z0 = n.z[c.a[s]];
    q.cx = c.cx[s]; q.cz = c.cz[s];
    q.x1 = n.x[c.b[s]]; q.z1 = n.z[c.b[s]];
    return q;
  }

  // ------------------------------------------------------------ changes

  addNode(rec: Omit<NodeRec, 'id'> & { id?: number }): number {
    const t = this.nodes;
    let id: number;
    if (rec.id !== undefined) { t.allocAt(rec.id); id = rec.id; } else id = t.alloc();
    const c = t.cols;
    c.x[id] = rec.x; c.z[id] = rec.z; c.y[id] = rec.y; c.deg[id] = 0;
    c.cell[id] = cellId(cellX(rec.x), cellX(rec.z));
    for (let k = 0; k < MAX_DEG; k++) this.adj[id * MAX_DEG + k] = -1;
    this.nodeIndex.insert(id, rec.x, rec.z);
    this.cellCount[c.cell[id]]++;
    this.touchNode(id);
    this.emit({ t: 'addNode', rec: { id, x: rec.x, z: rec.z, y: rec.y } });
    if (rec.j) this.setJunction(id, rec.j);
    return id;
  }

  removeNode(id: number): void {
    if (!this.nodes.alive[id]) return;
    if (this.nodes.cols.deg[id] !== 0) throw new Error('node still connected');
    this.touchNode(id);
    this.cellCount[this.nodes.cols.cell[id]]--;
    this.nodeIndex.remove(id);
    this.nodes.release(id);
    this.junctions.delete(id);
    this.flow.delete(id);
    this.emit({ t: 'remNode', id });
  }

  addSeg(rec: Omit<SegRec, 'id'> & { id?: number }): number {
    const t = this.segs;
    if (this.nodes.cols.deg[rec.a] >= MAX_DEG || this.nodes.cols.deg[rec.b] >= MAX_DEG) throw new Error('node has too many connections');
    let id: number;
    if (rec.id !== undefined) { t.allocAt(rec.id); id = rec.id; } else id = t.alloc();
    const c = t.cols;
    c.a[id] = rec.a; c.b[id] = rec.b; c.cx[id] = rec.cx; c.cz[id] = rec.cz;
    // a road that comes in without a recorded build kind (generated city, test city, old save) was free
    c.profile[id] = rec.profile; c.flags[id] = kindOfFlags(rec.flags) < 0 ? rec.flags | SegFlag.Free : rec.flags;
    c.zl[id] = rec.zl ?? 0; c.zr[id] = rec.zr ?? 0;
    const q = this.quad(id);
    c.len[id] = bezLength(q);
    bez(q, 0.5, p2);
    c.mx[id] = p2[0]; c.mz[id] = p2[1];
    c.cell[id] = cellId(cellX(p2[0]), cellX(p2[1]));
    this.segIndex.insert(id, p2[0], p2[1]);
    this.cellCount[c.cell[id]]++;
    this.link(rec.a, id);
    this.link(rec.b, id);
    this.touchSeg(id);
    this.emit({ t: 'addSeg', rec: { id, a: rec.a, b: rec.b, cx: rec.cx, cz: rec.cz, profile: rec.profile, flags: c.flags[id], zl: c.zl[id], zr: c.zr[id] } });
    return id;
  }

  removeSeg(id: number): SegRec {
    const c = this.segs.cols;
    const rec: SegRec = { id, a: c.a[id], b: c.b[id], cx: c.cx[id], cz: c.cz[id], profile: c.profile[id], flags: c.flags[id], zl: c.zl[id], zr: c.zr[id] };
    this.touchSeg(id);
    this.unlink(rec.a, id);
    this.unlink(rec.b, id);
    this.segIndex.remove(id);
    this.cellCount[c.cell[id]]--;
    this.segs.release(id);
    // the nodes' neighbours change shape
    this.touchNode(rec.a);
    this.touchNode(rec.b);
    this.emit({ t: 'remSeg', id });
    return rec;
  }

  nodeRec(id: number): NodeRec {
    const c = this.nodes.cols;
    const j = this.junctions.get(id);
    return j ? { id, x: c.x[id], z: c.z[id], y: c.y[id], j } : { id, x: c.x[id], z: c.z[id], y: c.y[id] };
  }

  /** Flow-based automatic mode switched the node's control (notice from the simulation): repaint, without sending back to the sim. */
  setFlow(id: number, flow: number): void {
    if (!this.nodes.alive[id] || (this.flow.get(id) ?? 0) === flow) return;
    if (flow) this.flow.set(id, flow); else this.flow.delete(id);
    this.touchNode(id);
  }

  /** Junction control chosen by the player (null = automatic). */
  setJunction(id: number, spec: JunctionSpec | null): void {
    // a missing node (−1 from a search that found nothing, or one already removed) is refused clearly
    if (!(id >= 0) || !this.nodes.alive[id]) throw new Error(`setJunction: node ${id} does not exist`);
    if (spec) this.junctions.set(id, spec); else this.junctions.delete(id);
    // new choice: the simulation measures again
    this.flow.delete(id);
    this.touchNode(id);
    this.emit({ t: 'junction', id, spec });
  }

  segRec(id: number): SegRec {
    const c = this.segs.cols;
    return { id, a: c.a[id], b: c.b[id], cx: c.cx[id], cz: c.cz[id], profile: c.profile[id], flags: c.flags[id], zl: c.zl[id], zr: c.zr[id] };
  }

  setProfile(id: number, profile: number): void {
    this.segs.cols.profile[id] = profile;
    this.touchSeg(id);
    this.emit({ t: 'profile', id, profile });
  }

  /** Zone of one side of the segment (0 = left, 1 = right). */
  setZone(id: number, side: number, zone: number): void {
    (side === 0 ? this.segs.cols.zl : this.segs.cols.zr)[id] = zone;
    this.markLots(id);
    this.emit({ t: 'zone', id, side, zone });
  }

  /** Changes on every edit (caches of network readers, such as the dead-end turning bulb). */
  version = 0;
  private emit(op: NetOp): void { this.version++; for (const l of this.listeners) l(op); }

  private link(n: number, s: number): void {
    const o = n * MAX_DEG;
    for (let k = 0; k < MAX_DEG; k++) if (this.adj[o + k] < 0) { this.adj[o + k] = s; this.nodes.cols.deg[n]++; return; }
  }

  private unlink(n: number, s: number): void {
    const o = n * MAX_DEG;
    for (let k = 0; k < MAX_DEG; k++) if (this.adj[o + k] === s) {
      // keep it compact
      const last = o + this.nodes.cols.deg[n] - 1;
      this.adj[o + k] = this.adj[last];
      this.adj[last] = -1;
      this.nodes.cols.deg[n]--;
      return;
    }
  }

  /** Segments connected to a node. */
  segsOf(n: number, out: number[] = []): number[] {
    out.length = 0;
    const o = n * MAX_DEG, d = this.nodes.cols.deg[n];
    for (let k = 0; k < d; k++) out.push(this.adj[o + k]);
    return out;
  }

  // ------------------------------------------------------- dirty marking

  private mark(x: number, z: number): void {
    this.world.touchCell(cellId(cellX(x), cellX(z)), Dirty.Roads | Dirty.RoadPaint | Dirty.Lots);
  }

  /**
   * The lots of every cell the segment's lots, or the lots it blocks, can stand in: its curve's box widened by
   * LOT_REACH (at most 3 × 3 cells). A cell's lots are cut from every road near it, not only the ones inside it.
   */
  private markLots(s: number): void {
    const sc = this.segs.cols, nc = this.nodes.cols, a = sc.a[s], b = sc.b[s];
    const x0 = cellX(Math.min(nc.x[a], nc.x[b], sc.cx[s]) - LOT_REACH), x1 = cellX(Math.max(nc.x[a], nc.x[b], sc.cx[s]) + LOT_REACH);
    const z0 = cellX(Math.min(nc.z[a], nc.z[b], sc.cz[s]) - LOT_REACH), z1 = cellX(Math.max(nc.z[a], nc.z[b], sc.cz[s]) + LOT_REACH);
    for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) this.world.touchCell(cellId(cx, cz), Dirty.Lots);
  }

  /** A node changed: its cell and the cell of each connected segment (their setback changes). */
  private touchNode(n: number): void {
    const nc = this.nodes.cols;
    this.mark(nc.x[n], nc.z[n]);
    const o = n * MAX_DEG, d = nc.deg[n];
    const sc = this.segs.cols;
    for (let k = 0; k < d; k++) {
      const s = this.adj[o + k];
      this.mark(sc.mx[s], sc.mz[s]);
      this.markLots(s);
      // the other node also uses this segment's shape
      const other = sc.a[s] === n ? sc.b[s] : sc.a[s];
      this.mark(nc.x[other], nc.z[other]);
    }
  }

  private touchSeg(s: number): void {
    const sc = this.segs.cols;
    this.mark(sc.mx[s], sc.mz[s]);
    // nearby dead ends: their turning bulb may appear or disappear
    const r = sc.len[s] / 2 + BULB_R + 20, nc = this.nodes.cols;
    this.nodeIndex.query(sc.mx[s] - r, sc.mz[s] - r, sc.mx[s] + r, sc.mz[s] + r, (n) => { if (nc.deg[n] === 1) this.mark(nc.x[n], nc.z[n]); });
    this.touchNode(sc.a[s]);
    this.touchNode(sc.b[s]);
  }

  // ------------------------------------------------------------ queries

  nearestNode(x: number, z: number, radius: number): number {
    let best = -1, bd = radius * radius;
    const c = this.nodes.cols;
    this.nodeIndex.query(x - radius, z - radius, x + radius, z + radius, (id) => {
      const d = (c.x[id] - x) ** 2 + (c.z[id] - z) ** 2;
      if (d < bd) { bd = d; best = id; }
    });
    return best;
  }

  /** Nearest segment within the radius of its edge: [segment, t, distance] or null. */
  nearestSeg(x: number, z: number, radius: number, accept?: (s: number) => boolean): [number, number, number] | null {
    let best: [number, number, number] | null = null;
    const q: Quad = { x0: 0, z0: 0, cx: 0, cz: 0, x1: 0, z1: 0 };
    this.forSegsNear(x - radius, z - radius, x + radius, z + radius, (s) => {
      if (accept && !accept(s)) return;
      this.quad(s, q);
      const [t, d] = closestT(q, x, z);
      if (d < radius && (!best || d < best[2])) best = [s, t, d];
    });
    return best;
  }

  /** Segments that may touch the rectangle (by midpoint + margin). */
  forSegsNear(minX: number, minZ: number, maxX: number, maxZ: number, fn: (s: number) => void): void {
    const sc = this.segs.cols;
    const m = SEG_MARGIN;
    this.segIndex.query(minX - m, minZ - m, maxX + m, maxZ + m, (s) => {
      const r = sc.len[s] / 2 + 40;
      if (sc.mx[s] + r < minX || sc.mx[s] - r > maxX || sc.mz[s] + r < minZ || sc.mz[s] - r > maxZ) return;
      fn(s);
    });
  }

  /** Segments and nodes of a cell (by midpoint / position). */
  cellContents(cid: number, segsOut: number[], nodesOut: number[]): void {
    const sc = this.segs.cols, nc = this.nodes.cols;
    this.segIndex.queryCell(cid, (s) => { if (sc.cell[s] === cid) segsOut.push(s); });
    this.nodeIndex.queryCell(cid, (n) => { if (nc.cell[n] === cid) nodesOut.push(n); });
  }

  /**
   * Piece of the network for a worker: the segments and nodes to build, plus all the
   * segments connected to the involved nodes (they define the setbacks and corners).
   */
  gather(ownSegs: number[], ownNodes: number[]): RoadGraph {
    const sc = this.segs.cols, nc = this.nodes.cols;
    const nodeIdx = new Map<number, number>();
    const segIdx = new Map<number, number>();
    const nodeList: number[] = [], segList: number[] = [];
    const addNode = (n: number) => { if (!nodeIdx.has(n)) { nodeIdx.set(n, nodeList.length); nodeList.push(n); } };
    const addSeg = (s: number) => {
      if (segIdx.has(s)) return;
      segIdx.set(s, segList.length); segList.push(s);
      addNode(sc.a[s]); addNode(sc.b[s]);
    };
    const involved = new Set<number>(ownNodes);
    for (const s of ownSegs) { involved.add(sc.a[s]); involved.add(sc.b[s]); }
    for (const s of ownSegs) addSeg(s);
    for (const n of involved) {
      addNode(n);
      const o = n * MAX_DEG, d = nc.deg[n];
      for (let k = 0; k < d; k++) addSeg(this.adj[o + k]);
    }
    const nn = nodeList.length, ns = segList.length;
    const g: RoadGraph = {
      nodeCount: nn, nx: new Float32Array(nn), nz: new Float32Array(nn), ny: new Float32Array(nn), nodeOwn: new Uint8Array(nn),
      segCount: ns, sa: new Int32Array(ns), sb: new Int32Array(ns), scx: new Float32Array(ns), scz: new Float32Array(ns),
      sprofile: new Uint8Array(ns), sflags: new Uint8Array(ns), segOwn: new Uint8Array(ns), sid: new Int32Array(ns),
      szl: new Uint8Array(ns), szr: new Uint8Array(ns), nid: new Int32Array(nn),
      nctl: new Uint8Array(nn), srule: new Uint8Array(ns),
    };
    nodeList.forEach((n, i) => { g.nx[i] = nc.x[n]; g.nz[i] = nc.z[n]; g.ny[i] = nc.y[n]; g.nid[i] = n; });
    // junction control and the rule at each end (signs, paint)
    for (const n of nodeList) {
      if (nc.deg[n] === 1) { if (bulbAt(this, n)) g.nctl[nodeIdx.get(n)!] = NODE_BULB; continue; }
      if (nc.deg[n] < 3 && !(nc.deg[n] === 2 && isMidNode(this.junctions.get(n)?.ctl ?? 0))) continue;
      const ctl = effectiveControl(this, n, this.junctions.get(n), this.flow.get(n));
      g.nctl[nodeIdx.get(n)!] = ctl.ctl;
      for (const [s, r] of ctl.legs) {
        const i = segIdx.get(s);
        if (i === undefined) continue;
        g.srule[i] |= sc.a[s] === n ? r : r << 3;
      }
    }
    for (const n of ownNodes) g.nodeOwn[nodeIdx.get(n)!] = 1;
    segList.forEach((s, i) => {
      g.sa[i] = nodeIdx.get(sc.a[s])!; g.sb[i] = nodeIdx.get(sc.b[s])!;
      g.scx[i] = sc.cx[s]; g.scz[i] = sc.cz[s]; g.sprofile[i] = sc.profile[s]; g.sflags[i] = sc.flags[s]; g.sid[i] = s;
      g.szl[i] = sc.zl[s]; g.szr[i] = sc.zr[s];
    });
    for (const s of ownSegs) g.segOwn[segIdx.get(s)!] = 1;
    return g;
  }

  /** Roads of a tile for saving: nodes by position, segments by node a. */
  saveTile(tile: number, tileOf: (x: number, z: number) => number): RoadSave {
    const nc = this.nodes.cols, sc = this.segs.cols;
    const nodes: number[] = [], segs: number[] = [];
    for (const c of this.cellsOfTile(tile)) {
      this.nodeIndex.queryCell(c, (n) => {
        if (tileOf(nc.x[n], nc.z[n]) !== tile) return;
        nodes.push(n, nc.x[n], nc.z[n], nc.y[n]);
        const o = n * MAX_DEG;
        for (let k = 0; k < nc.deg[n]; k++) {
          const s = this.adj[o + k];
          if (sc.a[s] === n) segs.push(s, sc.a[s], sc.b[s], sc.cx[s], sc.cz[s], sc.profile[s], sc.flags[s], sc.zl[s], sc.zr[s]);
        }
      });
    }
    return { nodes: new Float32Array(nodes), segs: new Float32Array(segs) };
  }

  /** Recreates saved nodes (first) or segments (after), with the same ids. */
  loadNodes(r: RoadSave): void {
    for (let k = 0; k < r.nodes.length; k += NODE_REC) this.addNode({ id: r.nodes[k], x: r.nodes[k + 1], z: r.nodes[k + 2], y: r.nodes[k + 3] });
  }
  loadSegs(r: RoadSave): void {
    const s = r.segs;
    for (let k = 0; k < s.length; k += SEG_REC) this.addSeg({ id: s[k], a: s[k + 1], b: s[k + 2], cx: s[k + 3], cz: s[k + 4], profile: s[k + 5], flags: s[k + 6], zl: s[k + 7], zr: s[k + 8] });
  }

  private cellsOfTile(tile: number): number[] {
    const per = CELLS_PER_TILE, tx = tile % MAP_TILES, tz = (tile / MAP_TILES) | 0;
    const out: number[] = [];
    for (let j = 0; j < per; j++) for (let i = 0; i < per; i++) out.push(cellId(tx * per + i, tz * per + j));
    return out;
  }

  clear(): void {
    this.nodes.clear(); this.segs.clear();
    this.nodeIndex.clear(); this.segIndex.clear();
    this.adj.fill(-1);
    this.cellCount.fill(0);
    this.junctions.clear();
    this.flow.clear();
    this.emit({ t: 'clear' });
  }

  /** Cell side length, for per-cell queries. */
  static readonly cellSize = CELL_SIZE;
}

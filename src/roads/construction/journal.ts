import { HEIGHT_TILE_RES } from '../../config.ts';
import { Dirty } from '../../core/grid.ts';
import type { Command } from '../../core/commands.ts';
import { cellsOfSamples, heightAt } from '../../world/heights.ts';
import type { BuildingRec, World } from '../../world/world.ts';
import { bez, type Quad } from '../geometry.ts';
import { type NodeRec, type RoadNetwork, type SegRec } from '../network.ts';
import { SegFlag } from '../flags.ts';
import { KIND_MASK, buildKindAt, chargeFor, dominantKind, kindOfFlags, segmentPrice, withKind } from '../economy.ts';
import { remapSpec, type JunctionSpec } from '../control.ts';
import { waterAt } from '../../world/ground.ts';
import { type ItemRec } from '../../world/items.ts';
import { NO_SEG, type NodeId, type SegId } from '../../core/ids.ts';


// --------------------------------------------------------------- journal

/** How far into the next cell a building's base may reach from its centre's cell (m): heights there move it too. */
export const BUILDING_REACH = 40;


type Op =
  | { t: 'addNode'; rec: NodeRec }
  | { t: 'remNode'; rec: NodeRec }
  | { t: 'addSeg'; rec: SegRec }
  | { t: 'remSeg'; rec: SegRec }
  | { t: 'profile'; id: SegId; from: number; to: number }
  | { t: 'zone'; id: SegId; side: number; from: number; to: number }
  | { t: 'junction'; id: NodeId; from: JunctionSpec | null; to: JunctionSpec | null }
  | { t: 'name'; id: SegId; from: string | undefined; to: string | undefined }
  | { t: 'addBld'; rec: number[] }
  | { t: 'remBld'; rec: number[] }
  | { t: 'remItem'; rec: ItemRec }
  | { t: 'terrain'; idx: Int32Array; before: Float32Array; after: Float32Array; x0: number; z0: number; x1: number; z1: number; cells?: number[]; near?: number[] };

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

  /** Memory kept for undo: the terrain samples (the rest is small records). */
  get bytes(): number {
    let n = this.ops.length * 64;
    for (const op of this.ops) if (op.t === 'terrain') n += op.idx.byteLength + op.before.byteLength + op.after.byteLength;
    return n;
  }

  /** Change in road value (R$) made by this journal, over the roads the player paid for. */
  private value = 0;
  /** The same over roads that were free (SegFlag.Free): costs when it grows, never gives anything back. */
  private freeValue = 0;
  /** How much was charged (negative = refunded). */
  charge = 0;

  private addValue(id: number, v: number): void {
    if (this.net.segs.cols.flags[id] & SegFlag.Free) this.freeValue += v; else this.value += v;
  }

  /** Value of a segment as it stands: length × price of its cross-section × how it is built (`roads/economy.ts`). */
  private segValue(id: SegId, profile = this.net.segs.cols.profile[id]): number {
    const sc = this.net.segs.cols;
    let kind = kindOfFlags(sc.flags[id]);
    if (kind < 0) kind = this.kindNow(sc.a[id], sc.b[id], this.net.quad(id));
    return segmentPrice(profile, sc.len[id], kind);
  }

  /** Build kind of a segment from a to b over the terrain as it is now (five samples along it). */
  private kindNow(a: number, b: number, q: Quad): number {
    const nc = this.net.nodes.cols, p = new Float64Array(2), kinds: number[] = [];
    for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      bez(q, t, p);
      kinds.push(buildKindAt(nc.y[a] + (nc.y[b] - nc.y[a]) * t, heightAt(this.world.heights, p[0], p[1]), waterAt(this.world.water, p[0], p[1])));
    }
    return dominantKind(kinds);
  }

  /** What the edit would cost (positive) or give back (negative), before settle. */
  get price(): number { return chargeFor(this.value) + (this.freeValue > 0 ? chargeFor(this.freeValue) : 0); }

  /**
   * Charges what the journal built (demolishing gives back a share, `roads/tuning.ts`; free roads give nothing).
   * Without enough money it undoes itself and returns false. Called once, right after the live operations.
   */
  settle(): boolean {
    this.tidy();
    const charge = this.world.unlimited ? 0 : this.price;
    if (charge > 0 && charge > this.world.money) { this.invert(); this.ops.length = 0; this.value = 0; this.freeValue = 0; return false; }
    this.charge = charge;
    this.world.money -= charge;
    return true;
  }

  // live operations (recorded)
  addNode(x: number, z: number, y: number): NodeId {
    const id = this.net.addNode({ x, z, y });
    this.ops.push({ t: 'addNode', rec: this.net.nodeRec(id) });
    return id;
  }
  /**
   * Raises or lowers a node (attached segments follow): removes and re-adds with the same ids. The segments go back
   * through `addSeg`, so their value is counted again with the build kind of the new height: the edit costs (or gives
   * back a share of) only the difference, never the whole value of the roads that stay.
   */
  moveNodeY(id: NodeId, y: number): void {
    const net = this.net;
    const segs = net.segsOf(id, []);
    const recs = segs.map((s) => net.segRec(s));
    for (const s of segs) this.removeSeg(s);
    const rec = net.nodeRec(id);
    this.removeNode(id);
    net.addNode({ ...rec, y });
    this.ops.push({ t: 'addNode', rec: net.nodeRec(id) });
    for (const r of recs) this.addSeg({ ...r, flags: r.flags & ~KIND_MASK });
  }
  removeNode(id: NodeId): void {
    const rec = this.net.nodeRec(id);
    this.net.removeNode(id);
    this.ops.push({ t: 'remNode', rec });
  }
  /** Records a node already placed in the network (move node: same id somewhere else). */
  recordAddNode(id: NodeId): void { this.ops.push({ t: 'addNode', rec: this.net.nodeRec(id) }); }
  addSeg(rec: Omit<SegRec, 'id'>): SegId {
    // a new road records how it is built over the terrain before it is conformed (the refund reads the same)
    if (kindOfFlags(rec.flags) < 0) {
      const nc = this.net.nodes.cols;
      const q: Quad = { x0: nc.x[rec.a], z0: nc.z[rec.a], cx: rec.cx, cz: rec.cz, x1: nc.x[rec.b], z1: nc.z[rec.b] };
      rec = { ...rec, flags: withKind(rec.flags, this.kindNow(rec.a, rec.b, q)) };
    }
    const id = this.net.addSeg(rec);
    this.ops.push({ t: 'addSeg', rec: this.net.segRec(id) });
    this.addValue(id, this.segValue(id));
    return id;
  }
  removeSeg(id: SegId): SegRec {
    this.addValue(id, -this.segValue(id));
    const rec = this.net.removeSeg(id);
    this.ops.push({ t: 'remSeg', rec });
    this.gone.push(rec);
    return rec;
  }

  /** Segments this journal removed, and the pieces that took over from a removed one (split, join, roundabout cut). */
  private gone: SegRec[] = [];
  private heirs = new Map<SegId, SegId[]>();
  /** `pieces` took over from the removed segment `from` (its name and its place in the junctions' settings). */
  inherit(from: SegId, pieces: SegId[]): void { this.heirs.set(from, [...(this.heirs.get(from) ?? []), ...pieces]); }

  /**
   * Junction settings and street names are kept by segment id, and ids are reused. After the live operations, every
   * removed segment hands them to its heirs (the pieces it was split into, or a segment between the same two nodes:
   * raised, moved, reversed) and they are taken off the ones that are gone, so nothing names a removed segment or
   * passes to a road that reuses the id. Recorded like any change: undo puts them back.
   */
  private tidy(): void {
    const net = this.net, sc = net.segs.cols, names = this.world.streetNames;
    const gone = this.gone;
    this.gone = [];
    const name = new Map<SegId, string>();
    // the names as they were before this journal, by the first removal of each id
    for (const op of this.ops) if (op.t === 'remSeg' && !name.has(op.rec.id)) { const v = this.nameBefore(op.rec.id); if (v !== undefined) name.set(op.rec.id, v); }
    const done = new Set<SegId>();
    for (const rec of gone) {
      if (done.has(rec.id)) continue;
      done.add(rec.id);
      const heirs = (this.heirs.get(rec.id) ?? []).filter((h) => net.segs.alive[h]);
      for (const n of [rec.a, rec.b]) {
        if (!net.nodes.alive[n]) continue;
        const between = net.segsOf(n, []).filter((s) => (sc.a[s] === rec.a && sc.b[s] === rec.b) || (sc.a[s] === rec.b && sc.b[s] === rec.a));
        for (const s of between) if (!heirs.includes(s)) heirs.push(s);
      }
      // street name: on every heir that has none, and off the id if it is no longer one of them
      const nm = name.get(rec.id);
      if (nm !== undefined) {
        for (const h of heirs) if (names.get(h) === undefined) this.setName(h, nm);
        if (!heirs.includes(rec.id) && names.get(rec.id) === nm) this.setName(rec.id, undefined);
      }
      // junction settings at both ends: the heir at that node, or nothing
      for (const n of [rec.a, rec.b]) {
        if (!net.nodes.alive[n]) continue;
        const spec = net.junctions.get(n);
        if (!spec) continue;
        const at = net.segsOf(n, []);
        if (at.includes(rec.id)) continue; // the id is at this node again (re-added, or the heir took it)
        const heir = heirs.find((h) => at.includes(h)) ?? NO_SEG;
        const next = remapSpec(spec, rec.id, heir, at);
        if (next !== spec) this.setJunction(n, next);
      }
    }
  }

  /** The street name of segment `id` before this journal's own name changes. */
  private nameBefore(id: SegId): string | undefined {
    let v = this.world.streetNames.get(id);
    for (let i = this.ops.length - 1; i >= 0; i--) { const op = this.ops[i]; if (op.t === 'name' && op.id === id) v = op.from; }
    return v;
  }

  private setName(id: SegId, to: string | undefined): void {
    const names = this.world.streetNames, from = names.get(id);
    if (from === to) return;
    if (to === undefined) names.delete(id); else names.set(id, to);
    this.ops.push({ t: 'name', id, from, to });
  }
  setProfile(id: SegId, to: number): void {
    const from = this.net.segs.cols.profile[id];
    if (from === to) return;
    this.addValue(id, this.segValue(id, to) - this.segValue(id, from));
    this.net.setProfile(id, to);
    this.ops.push({ t: 'profile', id, from, to });
  }
  setZone(id: SegId, side: number, to: number): void {
    const sc = this.net.segs.cols;
    const from = (side === 0 ? sc.zl : sc.zr)[id];
    if (from === to) return;
    this.net.setZone(id, side, to);
    this.ops.push({ t: 'zone', id, side, from, to });
  }
  setJunction(id: NodeId, to: JunctionSpec | null): void {
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
  removeItem(id: number): void {
    const rec = this.world.items.rec(id);
    this.world.items.remove(id);
    this.ops.push({ t: 'remItem', rec });
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
    // the cells the samples are in, not the whole box (a long diagonal road would mark every cell of its square)
    op.cells ??= cellsOfSamples(op.idx);
    op.near ??= cellsOfSamples(op.idx, BUILDING_REACH);
    for (const c of op.cells) w.touchCell(c, Dirty.Terrain | Dirty.Roads);
    for (const c of op.near) w.touchCell(c, Dirty.Buildings);
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
      case 'name': { const v = doAdd ? op.to : op.from; if (v === undefined) this.world.streetNames.delete(op.id); else this.world.streetNames.set(op.id, v); break; }
      case 'addBld': if (doAdd) this.world.restoreBuilding(op.rec); else this.world.removeBuilding(op.rec[0]); break;
      case 'remBld': if (doAdd) this.world.removeBuilding(op.rec[0]); else this.world.restoreBuilding(op.rec); break;
      case 'remItem': if (doAdd) this.world.items.remove(op.rec[0]); else this.world.items.add(op.rec, op.rec[0]); break;
      case 'terrain': this.writeTerrain(op, doAdd ? op.after : op.before); break;
    }
  }

  /**
   * Runs live operations. If they throw half way, everything this journal did goes back (it is left empty, nothing
   * half built and nothing charged) and the error goes on.
   */
  guard<T>(fn: () => T): T {
    try { return fn(); } catch (err) {
      for (let i = this.ops.length - 1; i >= 0; i--) this.exec(this.ops[i], false);
      this.ops.length = 0; this.value = 0; this.freeValue = 0;
      throw err;
    }
  }

  /** Appends another (not yet charged) journal to this one: it becomes a single undo step. */
  append(other: RoadJournal): void { this.ops.push(...other.ops); this.value += other.value; this.freeValue += other.freeValue; }

  /** Redo: runs the ops in order. If one throws, those already run go back and the error goes on: nothing changed. */
  apply(): void {
    const ops = this.ops;
    let k = 0;
    try { for (; k < ops.length; k++) this.exec(ops[k], true); } catch (err) {
      for (let i = k - 1; i >= 0; i--) this.exec(ops[i], false);
      throw err;
    }
    this.world.money -= this.charge;
  }
  /** Undo: runs the ops backwards. If one throws, those already undone are done again and the error goes on. */
  invert(): void {
    const ops = this.ops;
    let k = ops.length - 1;
    try { for (; k >= 0; k--) this.exec(ops[k], false); } catch (err) {
      for (let i = k + 1; i < ops.length; i++) this.exec(ops[i], true);
      throw err;
    }
    this.world.money += this.charge;
  }
}


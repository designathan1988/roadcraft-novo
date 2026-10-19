// Impossible nodes (Roadcraft `Network.impossible`, the top bar's "N nós impossíveis de construir"): a node where two
// neighbouring roads meet at less than MIN_LEG_ANGLE cannot close its junction (it is drawn degraded). Kept as a
// set updated from the network's own changes: each edit looks again only at the nodes it touched (their legs), so
// the count never walks the map. Opening a map feeds every segment once, as the load does anyway.

import { dirOut } from './control.ts';
import type { NetOp, RoadNetwork } from './network.ts';

/** Below this angle (degrees) between two neighbouring legs the junction does not close (Roadcraft MIN_LEG_ANGLE). */
export const MIN_LEG_ANGLE = 25;

export class ImpossibleNodes {
  /** Node → smallest angle between neighbouring legs (degrees), for the nodes under MIN_LEG_ANGLE. */
  readonly nodes = new Map<number, number>();
  /** Ends of each segment (the remove op carries only the id). */
  private segA = new Int32Array(1 << 14).fill(-1);
  private segB = new Int32Array(1 << 14).fill(-1);
  private net: RoadNetwork;
  /** Bumped when the set changes (the page refreshes the warning). */
  version = 0;

  constructor(net: RoadNetwork) {
    this.net = net;
    net.listeners.push((op) => this.onOp(op));
  }

  get count(): number { return this.nodes.size; }

  /** Smallest angle at the node if it is impossible, else −1. */
  angleAt(n: number): number { return this.nodes.get(n) ?? -1; }

  private onOp(op: NetOp): void {
    switch (op.t) {
      case 'addSeg': {
        const id = op.rec.id;
        if (id >= this.segA.length) this.grow(id + 1);
        this.segA[id] = op.rec.a; this.segB[id] = op.rec.b;
        this.check(op.rec.a); this.check(op.rec.b);
        break;
      }
      case 'remSeg': {
        const a = this.segA[op.id], b = this.segB[op.id];
        this.segA[op.id] = this.segB[op.id] = -1;
        if (a >= 0) this.check(a);
        if (b >= 0) this.check(b);
        break;
      }
      case 'remNode': if (this.nodes.delete(op.id)) this.version++; break;
      case 'clear': this.nodes.clear(); this.segA.fill(-1); this.segB.fill(-1); this.version++; break;
    }
  }

  private grow(min: number): void {
    let cap = this.segA.length;
    while (cap < min) cap *= 2;
    const a = new Int32Array(cap).fill(-1); a.set(this.segA); this.segA = a;
    const b = new Int32Array(cap).fill(-1); b.set(this.segB); this.segB = b;
  }

  /** Looks again at one node: the smallest angle between its neighbouring legs. */
  check(n: number): void {
    const net = this.net;
    let gap = 360;
    if (net.nodes.alive[n] && net.nodes.cols.deg[n] >= 2) {
      const angles = net.segsOf(n, []).map((s) => { const d = dirOut(net, n, s); return Math.atan2(d[1], d[0]) * 180 / Math.PI; }).sort((x, y) => x - y);
      for (let i = 0; i < angles.length; i++) {
        const next = i + 1 < angles.length ? angles[i + 1] : angles[0] + 360;
        gap = Math.min(gap, next - angles[i]);
      }
    }
    const was = this.nodes.get(n);
    if (gap < MIN_LEG_ANGLE) { if (was === undefined || Math.abs(was - gap) > 0.05) { this.nodes.set(n, gap); this.version++; } }
    else if (was !== undefined) { this.nodes.delete(n); this.version++; }
  }
}

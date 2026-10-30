import { bez } from '../geometry.ts';
import { type RoadNetwork } from '../network.ts';

// --------------------------------------------------------------- snapping

export interface Anchor {
  x: number; z: number;
  node: number; // -1 if not a node
  seg: number; // -1 if not a segment
  t: number;
}

/** Snaps a point to a node (preferred) or an existing segment. */
export function snap(net: RoadNetwork, x: number, z: number, radius: number): Anchor {
  const n = net.nearestNode(x, z, radius);
  if (n >= 0) return { x: net.nodes.cols.x[n], z: net.nodes.cols.z[n], node: n, seg: -1, t: 0 };
  const s = net.nearestSeg(x, z, radius * 0.8);
  if (s) {
    const q = net.quad(s[0]);
    const p = new Float64Array(2);
    bez(q, s[1], p);
    // near the end: use the node
    const len = net.segs.cols.len[s[0]];
    if (s[1] * len < 6) return snap(net, q.x0, q.z0, 1);
    if ((1 - s[1]) * len < 6) return snap(net, q.x1, q.z1, 1);
    return { x: p[0], z: p[1], node: -1, seg: s[0], t: s[1] };
  }
  return { x, z, node: -1, seg: -1, t: 0 };
}

/** Height of an existing segment at t (linear between the nodes, by parameter). */
export function segHeightAt(net: RoadNetwork, s: number, t: number): number {
  const sc = net.segs.cols, nc = net.nodes.cols;
  return nc.y[sc.a[s]] + (nc.y[sc.b[s]] - nc.y[sc.a[s]]) * t;
}


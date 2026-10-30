// Repair of old maps (Roadcraft "doc repair"): a dead end that lies inside another road (drawn before the snapping
// rules, or left by an old bug) becomes a junction when the map opens: the other road is split there and the loose
// end joins the new node. Runs once on load over the dead ends only (deg-1 nodes), each with one query in the
// spatial index; never during play.

import type { World } from '../world/world.ts';
import { RoadJournal } from './build.ts';
import { closestT, splitQuad } from './geometry.ts';
import { PROFILE_INFO } from './profiles.ts';
import { NO_SEG, asNode, type NodeId } from '../core/ids.ts';

/** Ends closer than this to a segment's ends are left alone (they are a near miss, not "inside"). */
const END_GAP = 4;

/** Joins every dead end lying inside another road to it. Returns how many were joined. */
export function repairDanglingEnds(world: World): number {
  const net = world.roads, nc = net.nodes.cols, sc = net.segs.cols;
  const ends: NodeId[] = [];
  for (let n = 0; n < net.nodes.end; n++) if (net.nodes.alive[n] && nc.deg[n] === 1) ends.push(asNode(n));
  let fixed = 0;
  const j = new RoadJournal(world, 'reparar mapa');
  for (const n of ends) {
    if (!net.nodes.alive[n] || nc.deg[n] !== 1) continue;
    const own = net.segsOf(n, [])[0];
    const x = nc.x[n], z = nc.z[n];
    let best = NO_SEG, bt = 0, bd = Infinity;
    net.forSegsNear(x - 30, z - 30, x + 30, z + 30, (s) => {
      if (s === own || sc.a[s] === n || sc.b[s] === n) return;
      const half = PROFILE_INFO[sc.profile[s]]?.asphaltRight ?? 3;
      const [t, d] = closestT(net.quad(s), x, z);
      if (d > Math.max(1.5, half) || d >= bd) return;
      if (t * sc.len[s] < END_GAP || (1 - t) * sc.len[s] < END_GAP) return;
      // only roads at the same height (a dead end under a bridge is not inside it)
      const y = nc.y[sc.a[s]] + (nc.y[sc.b[s]] - nc.y[sc.a[s]]) * t;
      if (Math.abs(y - nc.y[n]) > 2) return;
      best = s; bt = t; bd = d;
    });
    if (best < 0) continue;
    // split the other road at the closest point, then move the loose road's end onto the new node
    const q = net.quad(best), rec = net.segRec(best);
    const [qa, qb] = splitQuad(q, bt);
    const y = nc.y[rec.a] + (nc.y[rec.b] - nc.y[rec.a]) * bt;
    j.removeSeg(best);
    const m = j.addNode(qa.x1, qa.z1, y);
    j.addSeg({ a: rec.a, b: m, cx: qa.cx, cz: qa.cz, profile: rec.profile, flags: rec.flags, zl: rec.zl, zr: rec.zr });
    j.addSeg({ a: m, b: rec.b, cx: qb.cx, cz: qb.cz, profile: rec.profile, flags: rec.flags, zl: rec.zl, zr: rec.zr });
    const r = net.segRec(own);
    j.removeSeg(own);
    j.removeNode(n);
    const dx = qa.x1 - x, dz = qa.z1 - z;
    j.addSeg({ ...r, a: r.a === n ? m : r.a, b: r.b === n ? m : r.b, cx: r.cx + dx / 2, cz: r.cz + dz / 2 });
    fixed++;
  }
  return fixed;
}

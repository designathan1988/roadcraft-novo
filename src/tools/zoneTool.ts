// Zoning brush: paints the zone on the sides of the roads the brush touches.
// Changing the zone knocks down the buildings of the old zone on that side. A stroke is one command.

import type { CommandStack } from '../core/commands.ts';
import { RoadJournal } from '../roads/build.ts';
import { bez, bezD } from '../roads/geometry.ts';
import { PROFILE_INFO } from '../roads/profiles.ts';
import type { World } from '../world/world.ts';

const p2 = new Float64Array(2), d2 = new Float64Array(2);

export class ZoneTool {
  zone = 1;
  radius = 40;
  private stroke: RoadJournal | null = null;
  private world: World;
  private commands: CommandStack;

  constructor(world: World, commands: CommandStack) {
    this.world = world;
    this.commands = commands;
  }

  begin(): void { this.stroke = new RoadJournal(this.world, 'zonear'); }

  end(): void {
    if (this.stroke && !this.stroke.empty) this.commands.push(this.stroke);
    this.stroke = null;
  }

  /** Applies the brush at (x, z). */
  dab(x: number, z: number): void {
    const j = this.stroke;
    if (!j) return;
    const net = this.world.roads, sc = net.segs.cols;
    const r = this.radius;
    const hits: Array<[number, number]> = [];
    net.forSegsNear(x - r - 60, z - r - 60, x + r + 60, z + r + 60, (s) => {
      const info = PROFILE_INFO[sc.profile[s]];
      if (info.ring || sc.profile[s] === 5) return; // roundabouts and the expressway have no lots
      const q = net.quad(s);
      const len = sc.len[s];
      const n = Math.max(2, Math.ceil(len / 8));
      for (const side of [0, 1]) {
        const off = (side === 0 ? info.left : -info.right) + (side === 0 ? 14 : -14);
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          bez(q, t, p2); bezD(q, t, d2);
          const l = Math.hypot(d2[0], d2[1]) || 1;
          const px = p2[0] + (d2[1] / l) * off, pz = p2[1] - (d2[0] / l) * off;
          if ((px - x) ** 2 + (pz - z) ** 2 <= r * r) { hits.push([s, side]); break; }
        }
      }
    });
    for (const [s, side] of hits) {
      const cur = side === 0 ? sc.zl[s] : sc.zr[s];
      if (cur === this.zone) continue;
      if (cur !== 0) this.clearSide(j, s, side, this.zone);
      j.setZone(s, side, this.zone);
    }
  }

  /**
   * Zones the block around (x, z): walks round it through the network (at each node, the sharpest turn
   * towards the block) and paints the inner side of each segment. A single command.
   */
  fillBlock(x: number, z: number): string {
    const net = this.world.roads, sc = net.segs.cols;
    const near = net.nearestSeg(x, z, 200);
    if (!near) return 'Nenhuma via perto: desenhe as ruas da quadra primeiro.';
    const [s0, t0] = near;
    const q = net.quad(s0);
    bez(q, t0, p2); bezD(q, t0, d2);
    // side 0 of the segment is the normal (dz, −dx) in the a → b direction
    const u = (x - p2[0]) * d2[1] - (z - p2[1]) * d2[0];
    let s = s0, fwd = u > 0; // walks with the block always on side 0 of the walking direction
    const j = new RoadJournal(this.world, 'zonear quadra');
    const done = new Set<number>();
    const h = new Float64Array(2), o = new Float64Array(2);
    for (let step = 0; step < 300; step++) {
      const side = fwd ? 0 : 1;
      const key = s * 2 + side;
      if (done.has(key)) break;
      done.add(key);
      const info = PROFILE_INFO[sc.profile[s]];
      if (!info.ring && !info.rail && sc.profile[s] !== 5) {
        const cur = side === 0 ? sc.zl[s] : sc.zr[s];
        if (cur !== this.zone) { if (cur !== 0) this.clearSide(j, s, side, this.zone); j.setZone(s, side, this.zone); }
      }
      // reaches the node: arrival heading h; the block's normal n = (hz, −hx)
      const qs = net.quad(s);
      const n = fwd ? sc.b[s] : sc.a[s];
      bezD(qs, fwd ? 1 : 0, h);
      if (!fwd) { h[0] = -h[0]; h[1] = -h[1]; }
      let best = -1, bestA = -Infinity, bestFwd = true;
      for (const t of net.segsOf(n, [])) {
        const tf = sc.a[t] === n;
        bezD(net.quad(t), tf ? 0 : 1, o);
        if (!tf) { o[0] = -o[0]; o[1] = -o[1]; }
        if (t === s) continue;
        // angle of the branch measured from h towards the block (+) or away from it (−)
        const a = Math.atan2(o[0] * h[1] - o[1] * h[0], o[0] * h[0] + o[1] * h[1]);
        if (a > bestA) { bestA = a; best = t; bestFwd = tf; }
      }
      if (best < 0) { fwd = !fwd; continue; } // dead end: come back along the other side
      s = best; fwd = bestFwd;
      if (step === 299) { j.invert(); return 'Isso não é uma quadra fechada: feche as ruas em volta.'; }
    }
    if (j.empty) return 'Essa quadra já tem essa zona.';
    this.commands.push(j);
    return 'ok';
  }

  /** Knocks down the buildings of another zone that face this side of the segment. */
  private clearSide(j: RoadJournal, s: number, side: number, keepZone: number): void {
    const net = this.world.roads, sc = net.segs.cols, col = this.world.buildings.cols;
    const q = net.quad(s);
    const info = PROFILE_INFO[sc.profile[s]];
    const half = side === 0 ? info.left : info.right;
    const doomed: number[] = [];
    this.world.buildingIndex.query(sc.mx[s] - sc.len[s] / 2 - 70, sc.mz[s] - sc.len[s] / 2 - 70, sc.mx[s] + sc.len[s] / 2 + 70, sc.mz[s] + sc.len[s] / 2 + 70, (id) => {
      if (col.zone[id] === keepZone || col.zone[id] === 0) return;
      // projected on the segment: it must be on the right side and within 70 m of the road
      let best = Infinity, bu = 0;
      for (let i = 0; i <= 16; i++) {
        bez(q, i / 16, p2); bezD(q, i / 16, d2);
        const dx = col.x[id] - p2[0], dz = col.z[id] - p2[1];
        const dist = dx * dx + dz * dz;
        if (dist < best) { best = dist; const l = Math.hypot(d2[0], d2[1]) || 1; bu = dx * (d2[1] / l) + dz * (-d2[0] / l); }
      }
      const u = side === 0 ? bu : -bu;
      if (u > half && u < half + 70) doomed.push(id);
    });
    for (const id of doomed) j.removeBuilding(id);
  }
}

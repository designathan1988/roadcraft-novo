// The arrows painted at segment ends on junctions whose lane connections the player adjusted (roads/laneLinks.ts
// arrowCode): one value per segment end in the traffic look's arrows texture. Only the nodes a change touched are
// redone (a junction's control, a new node with a junction, a new segment's two ends); a removed segment's ends are
// cleared at once, and a cleared network clears them all.

import type { DataTexture } from 'three/webgpu';
import type { NodeId } from '../../core/ids.ts';
import { arrowCode } from '../../roads/laneLinks.ts';
import type { NetOp, RoadNetwork } from '../../roads/network.ts';

export class LaneArrows {
  private readonly net: RoadNetwork;
  private readonly tex: DataTexture;
  /** Nodes whose arrows are redone at the next update. */
  private readonly nodes = new Set<NodeId>();

  constructor(net: RoadNetwork, arrows: DataTexture) {
    this.net = net;
    this.tex = arrows;
  }

  /** A change of the network (the game's road listener). */
  note(op: NetOp): void {
    const arr = this.tex.image.data as Float32Array;
    if (op.t === 'junction') this.nodes.add(op.id);
    else if (op.t === 'addNode' && op.rec.j) this.nodes.add(op.rec.id);
    else if (op.t === 'addSeg') { this.nodes.add(op.rec.a); this.nodes.add(op.rec.b); }
    else if (op.t === 'remSeg') { if (op.id * 2 + 1 < arr.length && (arr[op.id * 2] || arr[op.id * 2 + 1])) { arr[op.id * 2] = arr[op.id * 2 + 1] = 0; this.tex.needsUpdate = true; } }
    else if (op.t === 'clear') { arr.fill(0); this.tex.needsUpdate = true; }
  }

  /** Redoes the arrows of the nodes that changed (a frame's work: those nodes only). */
  update(): void {
    if (!this.nodes.size) return;
    const net = this.net, sc = net.segs.cols, arr = this.tex.image.data as Float32Array;
    let changed = false;
    for (const n of this.nodes) {
      if (!net.nodes.alive[n]) continue;
      const spec = net.junctions.get(n);
      for (const s of net.segsOf(n, [])) {
        const k = s * 2 + (sc.a[s] === n ? 0 : 1);
        if (k >= arr.length) continue;
        const code = spec?.lanes?.length ? arrowCode(net, n, s) : 0;
        if (arr[k] !== code) { arr[k] = code; changed = true; }
      }
    }
    this.nodes.clear();
    if (changed) this.tex.needsUpdate = true;
  }
}

// Dashed lane lines are continuous along a road: the distance travelled is counted from the start of the road, not
// from the start of each segment. A segment gets the phase of the node it starts at; the shader adds it to `v`, so a
// road split at a node does not restart its dashes in the middle of the street.
export const DASH_PERIOD = 9;
/** Phase quantisation packed into the road vertex code (4 bits): 0.56 m at a 9 m period. */
export const DASH_STEPS = 16;

export interface DashGraph {
  readonly nodeCount: number;
  readonly segCount: number;
  readonly sa: Int32Array;
  readonly sb: Int32Array;
}

/**
 * Phase (metres along the dash period) of every segment at its `a` end. Nodes are visited once per connected
 * component, in edge order; a branch inherits the phase of the node it leaves, and a cycle keeps the phase of the
 * first path (a dash phase is visual, not a routing invariant).
 */
export function dashPhases(g: DashGraph, lens: ArrayLike<number>, period = DASH_PERIOD): Float32Array {
  const head = new Int32Array(g.nodeCount).fill(-1);
  const next = new Int32Array(g.segCount * 2).fill(-1);
  const other = new Int32Array(g.segCount * 2);
  for (let s = 0; s < g.segCount; s++) {
    const a = g.sa[s], b = g.sb[s];
    other[s * 2] = b; next[s * 2] = head[a]; head[a] = s * 2;
    other[s * 2 + 1] = a; next[s * 2 + 1] = head[b]; head[b] = s * 2 + 1;
  }
  const phase = new Float32Array(g.nodeCount), seen = new Uint8Array(g.nodeCount), queue = new Int32Array(g.nodeCount);
  for (let root = 0; root < g.nodeCount; root++) {
    if (seen[root]) continue;
    seen[root] = 1; phase[root] = 0;
    let q0 = 0, q1 = 1; queue[0] = root;
    while (q0 < q1) {
      const u = queue[q0++];
      for (let e = head[u]; e >= 0; e = next[e]) {
        const v = other[e], s = e >> 1;
        if (seen[v]) continue;
        seen[v] = 1;
        phase[v] = (phase[u] + Math.max(0, Number(lens[s]))) % period;
        queue[q1++] = v;
      }
    }
  }
  const out = new Float32Array(g.segCount);
  for (let s = 0; s < g.segCount; s++) out[s] = phase[g.sa[s]] ?? 0;
  return out;
}

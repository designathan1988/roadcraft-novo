// GPU time per pass of the frame, read from the renderer's timestamp queries (three r186: WebGPURenderer { trackTimestamp:
// true }, resolveTimestampsAsync, the backend's timestampQueryPool keyed 'r:<call>:<context id>:f<frame>' and
// 'c:<call>:<node id>:f<frame>'). Only with ?perf (the queries are the measurement, not part of the game). A pass is named
// by what it is, not by its place in the frame: the shadow cascades draw none, one or two passes each a frame (the still
// casters kept, scrolled or redrawn, the movers over them), so the n-th render call of one frame is not the n-th of the
// next. The label comes from the scene's name (post.ts names the shadow scene) and the target, read when the pass begins,
// keyed by the same uid the query pool files its timestamp under.
import type * as THREE from 'three/webgpu';

interface Pool { timestamps: Map<string, number> }
interface Context { width: number; height: number; textures?: Array<{ name?: string }> | null; depthTexture?: unknown; scene?: { name?: string } | null; renderTarget?: { texture?: { name?: string } } | null }
interface Group { id?: number; name?: string }
class Sums { readonly ms = new Map<string, number>(); readonly frames = new Set<number>(); total = 0 }

export class GpuTiming {
  private pending = false;
  private render = new Sums();
  private computes = new Sums();
  /** The label of each pass begun, by the uid its timestamp will carry (removed as the timestamp is read). */
  private readonly labels = new Map<string, string>();

  private readonly renderer: THREE.WebGPURenderer;

  constructor(renderer: THREE.WebGPURenderer) {
    this.renderer = renderer;
    const be = renderer.backend as unknown as { beginRender(c: Context): void; beginCompute(g: Group | Group[]): void; get(o: unknown): { timestampUID?: string } };
    const beginRender = be.beginRender.bind(be), beginCompute = be.beginCompute.bind(be);
    be.beginRender = (c) => {
      const uid = be.get(c).timestampUID;
      // the three cascades share a target name: the target's id tells them apart
      const rt = c.renderTarget as ({ id?: number; texture?: { name?: string } } | null | undefined);
      if (uid) this.labels.set(uid, `${c.scene?.name || 'scene'} > ${rt?.texture?.name || c.textures?.[0]?.name || (c.textures?.length ? 'target' : 'screen')}${rt?.texture?.name === 'ShadowMap' ? '#' + rt.id : ''} ${c.width}x${c.height}${c.depthTexture ? '+d' : ''}`);
      beginRender(c);
    };
    be.beginCompute = (g) => {
      const uid = be.get(g).timestampUID;
      if (uid) this.labels.set(uid, Array.isArray(g) ? g.map((n) => n.name || `compute ${n.id}`).join(',') : g.name || `compute ${g.id}`);
      beginCompute(g);
    };
  }

  private drain(kind: 'render' | 'compute', into: Sums): void {
    const pool = (this.renderer.backend as unknown as { timestampQueryPool: Record<string, Pool | undefined> }).timestampQueryPool[kind];
    if (!pool) return;
    for (const [uid, ms] of pool.timestamps) {
      const m = /:f(\d+)$/.exec(uid);
      if (!m) continue;
      const label = this.labels.get(uid) ?? uid.replace(/:f\d+$/, '');
      this.labels.delete(uid);
      into.ms.set(label, (into.ms.get(label) ?? 0) + ms);
      into.frames.add(Number(m[1]));
      into.total += ms;
    }
    pool.timestamps.clear();
  }

  /** After the frame's render calls: resolves the queries written so far (one resolve in flight at a time). */
  frameEnd(): void {
    if (this.pending) return;
    this.pending = true;
    void Promise.all([this.renderer.resolveTimestampsAsync('render'), this.renderer.resolveTimestampsAsync('compute')]).then(() => {
      this.drain('render', this.render);
      this.drain('compute', this.computes);
    }).finally(() => { this.pending = false; });
  }

  /** Mean GPU ms per frame since the last reset: in total and per pass (names and perCallMs aligned, the dearest first),
   *  the same for the compute passes. A pass drawn in some frames only carries its share of those frames in the mean. */
  snapshot(): { frames: number; totalMs: number; names: string[]; perCallMs: number[]; computeMs: number; computeNames: string[]; perComputeMs: number[] } {
    const list = (s: Sums) => {
      const n = Math.max(1, s.frames.size);
      const rows = [...s.ms].map(([k, v]) => [k, v / n] as const).sort((a, b) => b[1] - a[1]);
      return { names: rows.map((r) => r[0]), ms: rows.map((r) => r[1]), total: s.total / n };
    };
    const r = list(this.render), c = list(this.computes);
    return { frames: this.render.frames.size, totalMs: r.total, names: r.names, perCallMs: r.ms, computeMs: c.total, computeNames: c.names, perComputeMs: c.ms };
  }

  reset(): void { this.render = new Sums(); this.computes = new Sums(); }
}

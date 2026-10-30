// GPU time per render call of the frame, read from the renderer's timestamp queries (three r186: WebGPURenderer
// { trackTimestamp: true }, resolveTimestampsAsync, the backend's timestampQueryPool.render.timestamps keyed
// 'r:<call>:<context id>:f<frame>'). Only with ?perf (the queries are the measurement, not part of the game). The calls
// of one frame come in a fixed order (shadow cascades, scene, post passes: render/post.ts), so the call index names the
// pass; the sums are kept per index and per frame.
import type * as THREE from 'three/webgpu';

interface Pool { timestamps: Map<string, number> }

export class GpuTiming {
  private pending = false;
  private sums: number[] = [];
  private frames = new Set<number>();
  private total = 0;

  private readonly renderer: THREE.WebGPURenderer;

  constructor(renderer: THREE.WebGPURenderer) { this.renderer = renderer; }

  /** After the frame's render calls: resolves the queries written so far (one resolve in flight at a time). */
  frameEnd(): void {
    if (this.pending) return;
    this.pending = true;
    void this.renderer.resolveTimestampsAsync('render').then(() => {
      const pool = (this.renderer.backend as unknown as { timestampQueryPool: Record<string, Pool | undefined> }).timestampQueryPool.render;
      if (!pool) return;
      for (const [uid, ms] of pool.timestamps) {
        const m = /^r:(\d+):.*:f(\d+)$/.exec(uid);
        if (!m) continue;
        const call = Number(m[1]);
        this.sums[call] = (this.sums[call] ?? 0) + ms;
        this.frames.add(Number(m[2]));
        this.total += ms;
      }
    }).finally(() => { this.pending = false; });
  }

  /**
   * Mean GPU ms per frame, in total and per render call index, since the last reset. Every index up to the last one is
   * given: a call that wrote no timestamp in those frames is 0 ms (the sums are sparse, and map() skips the holes).
   */
  snapshot(): { frames: number; totalMs: number; perCallMs: number[] } {
    const n = Math.max(1, this.frames.size);
    return { frames: this.frames.size, totalMs: this.total / n, perCallMs: Array.from({ length: this.sums.length }, (_, i) => (this.sums[i] ?? 0) / n) };
  }

  reset(): void { this.sums = []; this.frames.clear(); this.total = 0; }
}

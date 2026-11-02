// GPU time per render call and per compute pass of the frame, read from the renderer's timestamp queries (three r186:
// WebGPURenderer { trackTimestamp: true }, resolveTimestampsAsync, the backend's timestampQueryPool keyed
// 'r:<call>:<context id>:f<frame>' and 'c:<call>:<node id>:f<frame>'). Only with ?perf (the queries are the measurement,
// not part of the game). The calls of one frame come in a fixed order (shadow cascades, scene, post passes:
// render/post.ts), so the call index names the pass; the sums are kept per index and per frame. `names` says what each
// render call drew into, read at its begin: its target's size, how many colour outputs and whether it has depth.
import type * as THREE from 'three/webgpu';

interface Pool { timestamps: Map<string, number> }
interface Context { width: number; height: number; textures?: unknown[] | null; depthTexture?: unknown }
interface Sum { sums: number[]; frames: Set<number>; total: number }

const sum = (): Sum => ({ sums: [], frames: new Set(), total: 0 });

export class GpuTiming {
  private pending = false;
  private render = sum();
  private computes = sum();
  private names: string[] = [];

  private readonly renderer: THREE.WebGPURenderer;

  constructor(renderer: THREE.WebGPURenderer) {
    this.renderer = renderer;
    const be = renderer.backend as unknown as { beginRender(c: Context): void };
    const begin = be.beginRender.bind(be);
    const info = renderer.info as unknown as { render: { frameCalls: number } };
    be.beginRender = (c) => {
      this.names[info.render.frameCalls] = `${c.width}x${c.height} ${c.textures?.length ?? 0}c${c.depthTexture ? '+d' : ''}`;
      begin(c);
    };
  }

  private drain(kind: 'render' | 'compute', into: Sum): void {
    const pool = (this.renderer.backend as unknown as { timestampQueryPool: Record<string, Pool | undefined> }).timestampQueryPool[kind];
    if (!pool) return;
    for (const [uid, ms] of pool.timestamps) {
      const m = /^[rc]:(\d+):.*:f(\d+)$/.exec(uid);
      if (!m) continue;
      const call = Number(m[1]);
      into.sums[call] = (into.sums[call] ?? 0) + ms;
      into.frames.add(Number(m[2]));
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

  /**
   * Mean GPU ms per frame, in total and per render call index, since the last reset; the same for the compute passes.
   * Every index up to the last one is given: a call that wrote no timestamp in those frames is 0 ms (the sums are sparse,
   * and map() skips the holes).
   */
  snapshot(): { frames: number; totalMs: number; perCallMs: number[]; names: string[]; computeMs: number; perComputeMs: number[] } {
    const per = (s: Sum, n: number) => Array.from({ length: s.sums.length }, (_, i) => (s.sums[i] ?? 0) / n);
    const n = Math.max(1, this.render.frames.size), c = Math.max(1, this.computes.frames.size);
    return { frames: this.render.frames.size, totalMs: this.render.total / n, perCallMs: per(this.render, n), names: this.names.slice(), computeMs: this.computes.total / c, perComputeMs: per(this.computes, c) };
  }

  reset(): void { this.render = sum(); this.computes = sum(); }
}

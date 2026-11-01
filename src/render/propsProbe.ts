// The props layer as the in-game render checks see it (the automation contract's render.props): what a Node test
// cannot reach, the GPU cull's output and the levels drawn. Implemented by PropRenderer.probe.
import type * as THREE from 'three/webgpu';
import type { PropColumns } from '../shared/contracts/worker.ts';

/**
 * The triangles the props drew in the last frame (D81). three counts an indirect draw as one instance (r186
 * WebGPUBackend.js:2171, renderer.info): `counted` is that number, `drawn` the real one, each level's draws times the
 * instance count the GPU cull wrote (the indirect arguments read back: vertices, instances).
 */
export async function drawnTriangleCounts(renderer: THREE.WebGPURenderer, enabled: boolean, counts: Uint32Array,
  drawAttr: THREE.IndirectStorageBufferAttribute, drawCount: number): Promise<{ counted: number; drawn: number }> {
  if (!enabled) return { counted: 0, drawn: 0 };
  const snap = counts.slice();
  const args = new Uint32Array(await renderer.getArrayBufferAsync(drawAttr));
  let counted = 0, drawn = 0;
  for (let k = 0; k < drawCount; k++) {
    if (!snap[k]) continue;
    const tris = args[k * 5] / 3;
    counted += snap[k] * tris;
    drawn += snap[k] * tris * args[k * 5 + 1];
  }
  return { counted, drawn };
}

/** The props layer as the render checks see it (see PropRenderer.probe). */
export interface PropsProbe {
  putCell(c: number, p: PropColumns): void;
  /** The draw arguments the GPU cull wrote: 5 numbers per kind and level (vertices, instances, …). */
  drawCounts(): Promise<Uint32Array>;
  kindOf(type: number, variant: number): number;
  /** The kind's level is drawn this frame (its band reaches the nearest possible prop). */
  levelShown(kind: number, level: number): boolean;
  kindRadius(kind: number): number;
  /** The view frustum as the cull tests it: a·x + b·y + c·z + d per plane. */
  planes(): Array<{ x: number; y: number; z: number; w: number }>;
}

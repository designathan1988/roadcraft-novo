// The props layer as the in-game render checks see it (the automation contract's render.props): what a Node test
// cannot reach, the GPU cull's output and the levels drawn. Implemented by PropRenderer.probe.
import type { PropColumns } from '../shared/contracts/worker.ts';

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

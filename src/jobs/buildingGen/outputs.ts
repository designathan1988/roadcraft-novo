// Outputs of one building-generator pass: the detail layer, the volume layout, the yard footprints and the repeated
// parts. A plain data holder owned by whoever runs the pass (worker job, parts job, inside-view query); the generator
// carries it on the lot's Frame, so no output lives at module scope.

import type { MeshBuilder } from '../meshBuilder.ts';

/**
 * A volume of a building with storeys (walls with windows), as the generator laid it: centre in the world, half width
 * and depth along the lot's turn, from y0 to y1; storeys start at `base` (the ground storey `ground` high, then
 * `fh` each). What the inside view and the camera need, without guessing 3.2 m storeys.
 */
export interface Volume { cx: number; cz: number; hw: number; hd: number; rot: number; y0: number; y1: number; base: number; ground: number; fh: number; roof?: string; crown?: string }

/** Sink for the repeated parts (the props pool). */
export type PartEmit = (variant: number, x: number, y: number, z: number, yaw: number, scale: number, kind?: number) => void;

export interface GenOutputs {
  detail: MeshBuilder | null;
  layout: Volume[] | null;
  foot: number[][] | null;
  part: PartEmit | null;
  /** Building index and ground of the footprints being captured. */
  footI: number;
  footGround: number;
  /** Per building of the pass, the height its walls were built to over the ground storey (m); left 0 where the
   *  generator does not say (the page estimates). */
  tops: Float32Array | null;
}

export function newOutputs(init: Partial<GenOutputs> = {}): GenOutputs {
  return { detail: null, layout: null, foot: null, part: null, footI: -1, footGround: 0, tops: null, ...init };
}

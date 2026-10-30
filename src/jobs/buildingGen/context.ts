// The context of one building being generated: its builder, lot frame, dimensions, storeys, style and random stream.
// A type-only contract shared by the generator and the shell/facade modules; no state of its own.

import type { Rng } from '../../core/rng.ts';
import type { Arch } from '../../world/arch.ts';
import type { MeshBuilder } from '../meshBuilder.ts';
import type { Frame } from './geometry.ts';

export interface GenContext {
  mb: MeshBuilder; heights: Float32Array; f: Frame; W: number; D: number; floors: number;
  arch: number; a: Arch; r: Rng; hi: number; lod: number; seed: number; zone: number;
  /** Vagas do estacionamento (`lotParking`). */
  rows: number[];
  /** Facade pattern picked by the cell plan (Pattern). */
  pattern: number;
  /** Free sides of the lot (corner): 1 = -x, 2 = +x. */
  side: number;
}

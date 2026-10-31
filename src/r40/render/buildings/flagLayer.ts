
import { type FlagDesign } from '../../world/buildings/flags.ts';

/** Every flag in the city, one instanced draw: a cloth that waves in the wind. */

/** One flag, in three's frame (y up): the top of the hoist, and its size. */
export interface FlagInstance {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly width: number;
  readonly height: number;
  readonly design: FlagDesign;
}

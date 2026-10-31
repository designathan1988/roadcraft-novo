import { clamp } from '../core/scalar.ts';
import { WORLD_REACH } from './tiles.ts';
import { m } from './units.ts';

/** THE WORLD'S PLATES: an unbounded grid of 2,048 m squares of ground, plate (pi, pj) centred on (pi, pj) x PLATE_SIZE (CLAUDE.md, "Streaming world") */

/** A plate's side: it holds 2 x 2 tiles of 1,024 m (`tiles.ts`), their edges on its centre lines and its own. */
export const PLATE_SIZE = m(2_048);

/** Plates each way from the origin a key can name: one past the tiles' reach, so every point with a tile has a plate. */
const PLATE_REACH = Math.ceil(WORLD_REACH / PLATE_SIZE) + 1;
const KEY_SIDE = PLATE_REACH * 2;

/** The plate column of a coordinate: a point on an edge is the plate's whose low edge it is (as `tiles.ts` tileIJ). */
const plateIndex = (v: number): number => Math.floor(v / PLATE_SIZE + 0.5);

/** A plate's key: its column and row packed in one number (each shifted to be positive). */
export function plateKey(pi: number, pj: number): number {
  if (pi < -PLATE_REACH || pi >= PLATE_REACH || pj < -PLATE_REACH || pj >= PLATE_REACH) throw new Error(`plate ${pi},${pj} is past the world's reach`);
  return (pi + PLATE_REACH) * KEY_SIDE + (pj + PLATE_REACH);
}

/** A plate column held to the keys' reach: only a point past the world's edge (an infinite ray's) is moved, onto its last plate. */
const inReach = (i: number): number => clamp(i, -PLATE_REACH, PLATE_REACH - 1);

/** The key of the plate a point lies in, anywhere (no map to hold it to: the world's reach alone). */
export const plateOf = (x: number, y: number): number => plateKey(inReach(plateIndex(x)), inReach(plateIndex(y)));

/** How far from the origin anything stands, each way: a plate inside the tiles' reach, so every point's tile and plate have a key. */
export const WORLD_HALF = WORLD_REACH - PLATE_SIZE;



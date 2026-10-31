import { CELL } from '../../world/cells.ts';
import { m } from '../../world/units.ts';
import type { PartBanding, PartBandings } from './cellArrays.ts';
import { PART_KINDS, type PartKind, type PartScreen } from './kit.ts';

/** A CELL'S PARTS FILED BY BAND AND SUB-CELL WHERE THE CELL IS MADE (`cellWork.ts`): the page is handed each band's buffers ready, never an instance to read (`partCells.ts` draws them) */

export type { PartBanding, PartBandings } from './cellArrays.ts';

/** Side of the sub-cells a cell's parts are filed by (four a side): each part kind's level is chosen per sub-cell, or per quadrant or cell where they agree (`partCells.ts`). DO NOT read it of `layerCells.ts`: that module reaches the shells, which reach the filing. */
export const DETAIL_CELL = m(64);
/** Sub-cells a side of a cell (the world's one grid, `layerCells.ts` BATCH_CELL): four, as `morton` is made for. */
export const SIDE = Math.round(CELL / DETAIL_CELL);
if (SIDE !== 4) throw new Error(`[buildings] a cell's parts are filed four sub-cells a side, not ${SIDE}`);
export const LEAVES = SIDE * SIDE;
/** What a draw is taken to cost in triangles: a band is kept apart only if it draws as much (three's per-object work on the page, `projectObject`/`renderObject`, outweighs this many triangles on the GPU). */
export const DRAW_TRIANGLES = 16384;

/** A sub-cell's index in Morton order from its column and row in the cell. */
export const morton = (u: number, v: number): number => (u & 1) | ((v & 1) << 1) | ((u & 2) << 1) | ((v & 2) << 2);

/** Each kind's banding off the kit's screens as they are now (a small prop's simplified levels come in once the simplifier has loaded). */
export function partBandings(screens: Readonly<Record<PartKind, PartScreen>>): PartBandings {
  return Object.fromEntries(PART_KINDS.map((kind) => {
    const s = screens[kind];
    return [kind, { first: s.levels.length > 1 ? s.levels[1]!.error : null, extent: s.extent, triangles: s.levels[0]!.triangles }];
  })) as Record<PartKind, PartBanding>;
}

/** One band of a kind's instances in the cell, by sub-cell in Morton order. */
export interface FiledBand {
  readonly kind: PartKind;
  /** Each sub-cell's first instance; the last entry is the band's count. */
  readonly start: Uint32Array;
  /** Each sub-cell's box in three's world (min x, y, z, max x, y, z). */
  readonly box: Float64Array;
  /** Each sub-cell's largest scale of an instance along each of the model's axes, then the cell's. */
  readonly scale: Float32Array;
  readonly poses: Float32Array;
  /** Tints in half floats, as the sub-cells' (`cellArrays.ts` `instanceColor`). */
  readonly colours: Uint16Array | null;
  /** The shell's parts: each one's finish, wear and ground (`shellParts.ts`). */
  readonly looks: Float32Array | null;
}

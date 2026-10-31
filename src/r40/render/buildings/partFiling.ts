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

/** A sub-cell's index in Morton order from its column and row in the cell. */
export const morton = (u: number, v: number): number => (u & 1) | ((v & 1) << 1) | ((u & 2) << 1) | ((v & 2) << 2);

/** Each kind's banding off the kit's screens as they are now (a small prop's simplified levels come in once the simplifier has loaded). */
export function partBandings(screens: Readonly<Record<PartKind, PartScreen>>): PartBandings {
  return Object.fromEntries(PART_KINDS.map((kind) => {
    const s = screens[kind];
    return [kind, { first: s.levels.length > 1 ? s.levels[1]!.error : null, extent: s.extent, triangles: s.levels[0]!.triangles }];
  })) as Record<PartKind, PartBanding>;
}

// The codes the far level's run vertices carry for their openings (buildingMesh.ts emitFacadeRuns, meshCore.ts): what
// is left of 4.0's facadeLevel.ts, whose shader (WebGL) this engine never ran.
import { m } from '../../world/units.ts';

/** How the far level fills a bay's opening (`facadeEmit.ts` `facadeKind` writes the same numbers), after `emitBay`'s panes. */
export const FACADE_KIND = { none: 0, window: 1, clear: 2, darkQuarter: 3, darkFifth: 4, door: 5, shutterDoor: 6 } as const;
/** Added to a vertex's kind where its run's bays go against its face's own horizontal: the direction turns round. */
export const FACADE_FLIP = 8;
/** Its run's rain streak times this added to a vertex's kind (`facadeEmit.ts` `streakOf`). */
export const FACADE_STREAK = 16;
/** How far under the opening a sill's streak starts, by the run's streak: the windows' sill, the shuttered window's deeper one. */
export const STREAK_SILL: readonly number[] = [0, m(0.06), m(0.08)];

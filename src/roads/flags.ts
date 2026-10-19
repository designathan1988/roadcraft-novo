/** Road segment bits (shared with the workers). */
export const SegFlag = {
  Ring: 1,
  /** street furniture: 0 full, 1 basic (lamp posts only), 2 none (bits 1-2) */
  FurnShift: 1,
  /** cut with a retaining wall (otherwise a slope) */
  Wall: 8,
  /**
   * Built for free: the generated city, the test city and roads of saves made before the build kind was recorded
   * (bits 4-6, `roads/economy.ts`). Demolishing or downgrading it gives nothing back; making it dearer still costs.
   */
  Free: 128,
} as const;
/** Street furniture of the segment (0 full, 1 basic, 2 none). */
export const furnOf = (flags: number) => (flags >> 1) & 3;

/** Authored land-use area. Buildings generated from it remain ordinary editable buildings. */
const ZONE_USES = ['residential', 'commercial', 'industrial'] as const;
const ZONE_DENSITIES = ['low', 'medium', 'high'] as const;
export type ZoneUse = (typeof ZONE_USES)[number];
export type ZoneDensity = (typeof ZONE_DENSITIES)[number];

export interface Zone {
  readonly id: number;
  readonly use: ZoneUse;
  readonly density: ZoneDensity;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly seed: number;
  readonly buildingIds: readonly number[];
}

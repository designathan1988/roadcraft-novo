// The building material vocabulary, with no behaviour: the type-only module that keeps the material
// implementation and the building records from importing each other.

export const FINISHES = ['plaster', 'stucco', 'ceramic', 'brick', 'stone', 'concrete', 'wood', 'metal', 'glass', 'tile', 'slate', 'panel', 'roofing'] as const;
export type Finish = (typeof FINISHES)[number];

export interface MaterialSpec {
  readonly finish: Finish;
  /** 0xRRGGBB, in sRGB. */
  readonly colour: number;
}

export const MATERIAL_SLOTS = ['wall', 'trim', 'roof', 'plinth'] as const;
export type MaterialSlot = (typeof MATERIAL_SLOTS)[number];

export type BuildingMaterials = Partial<Record<MaterialSlot, MaterialSpec>>;

export interface VolumeMaterials {
  /** Every wall of the volume. */
  wall?: MaterialSpec;
  /** One side's walls, over `wall` (FaceId values; kept as a number here so this module imports nothing). */
  sides?: Partial<Record<number, MaterialSpec>>;
  roof?: MaterialSpec;
}

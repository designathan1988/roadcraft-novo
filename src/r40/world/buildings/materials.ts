import type { Building, FaceId, RoofKind, Volume } from './types.ts';
import { FINISHES, type BuildingMaterials, type Finish, type MaterialSpec, type VolumeMaterials } from './materialTypes.ts';
export { FINISHES };
export type { BuildingMaterials, Finish, MaterialSpec, VolumeMaterials };

/** Each finish's own colour, as its swatch shows it: brick is brick-red before it is painted. */
export const FINISH_COLOUR: Readonly<Record<Finish, number>> = {
  plaster: 0xe6e0d4,
  stucco: 0xdcd4c4,
  ceramic: 0xcfd6da,
  brick: 0xa4563f,
  stone: 0xb7b2a6,
  concrete: 0xb4b4b0,
  wood: 0x9c6b43,
  metal: 0x9aa3a8,
  glass: 0x9db6c2,
  tile: 0xbd6a52,
  slate: 0x585b5f,
  panel: 0x8f9ba5,
  roofing: 0x7b4a37,
};

const spec = (finish: Finish, colour: number): MaterialSpec => ({ finish, colour });

/** The colour schemes a building starts with (`Building.palette`) */
export interface PaletteMaterials {
  readonly wall: MaterialSpec;
  readonly trim: MaterialSpec;
  /** Pitched roofs. */
  readonly roof: MaterialSpec;
  readonly awning: number;
}

export const PALETTE_MATERIALS: readonly PaletteMaterials[] = [
  { wall: spec('plaster', 0xe6d8bd), trim: spec('plaster', 0xf4eee2), roof: spec('tile', 0x9c4f3a), awning: 0x2f6f5e },
  { wall: spec('brick', 0xa4563f), trim: spec('plaster', 0xe0d6c6), roof: spec('tile', 0x4a4b50), awning: 0x8c2f2a },
  { wall: spec('concrete', 0xbdbcb4), trim: spec('concrete', 0xdcdcd6), roof: spec('metal', 0x55585c), awning: 0x2d4f7a },
  { wall: spec('plaster', 0xd8c297), trim: spec('plaster', 0xf0e6cf), roof: spec('tile', 0x8a5a3c), awning: 0xb5452b },
  { wall: spec('plaster', 0xf0efe9), trim: spec('concrete', 0xc9ccc9), roof: spec('tile', 0x5b5f63), awning: 0x2f6f5e },
  { wall: spec('brick', 0x72412f), trim: spec('stone', 0xd2c4b2), roof: spec('tile', 0x3d3e42), awning: 0xc4832d },
  { wall: spec('metal', 0x8f9ba5), trim: spec('metal', 0xe0e5e8), roof: spec('metal', 0x4f5357), awning: 0x2d4f7a },
  { wall: spec('metal', 0x939b91), trim: spec('concrete', 0xc4c8c1), roof: spec('metal', 0x6f7577), awning: 0xc4a02d },
];

/** A flat roof's default: a smooth membrane, whatever the palette (a panel grid read as a floor). */
export const FLAT_ROOF_MATERIAL = spec('roofing', 0x74716a);
const PLINTH_MATERIAL = spec('stone', 0x7f786d);

export const paletteOf = (b: Building): PaletteMaterials =>
  PALETTE_MATERIALS[((b.palette % PALETTE_MATERIALS.length) + PALETTE_MATERIALS.length) % PALETTE_MATERIALS.length] as PaletteMaterials;

const isPitched = (roof: RoofKind): boolean => roof !== 'flat' && roof !== 'terrace';

export function wallMaterial(b: Building, v: Volume, side: FaceId, storey?: number): MaterialSpec {
  return (storey === undefined ? undefined : v.storeys[storey]?.materials?.[side]) ??
    v.materials?.sides?.[side] ?? v.materials?.wall ?? b.materials?.wall ?? paletteOf(b).wall;
}

/** The slab the generator gives a tower or an office block (`procedural.ts`, `towerKit.ts`) */
export const GENERIC_SLAB = 0x8a8a86;

/** Flat roofs as a town has them: tar-dark membrane, grey membrane, white reflective sheet, beige gravel */
export const FLAT_ROOFS: readonly MaterialSpec[] = [
  FLAT_ROOF_MATERIAL,
  spec('roofing', 0x4f4d49),
  spec('roofing', 0x8f8c84),
  spec('roofing', 0xc8c5bc),
  spec('roofing', 0x8c8170),
  spec('concrete', 0x9d9a92),
  spec('roofing', 0x5f5a52),
];

export function roofMaterial(b: Building, v: Volume): MaterialSpec {
  const own = v.materials?.roof ?? b.materials?.roof;
  if (isPitched(v.roof)) return own ?? paletteOf(b).roof;
  // A flat roof or a terrace is a slab
  if (own && own.finish !== 'tile' && own.finish !== 'slate' && !(own.finish === 'concrete' && own.colour === GENERIC_SLAB)) return own;
  const pick = (Math.imul((b.id | 0) + 7, 2654435761) >>> 0) % FLAT_ROOFS.length;
  return FLAT_ROOFS[pick]!;
}

export const trimMaterial = (b: Building): MaterialSpec => b.materials?.trim ?? paletteOf(b).trim;
export const plinthMaterial = (b: Building): MaterialSpec => b.materials?.plinth ?? PLINTH_MATERIAL;

/** Factory styles: a coherent set of materials for a whole building, applied in one click and freely changed afterwards */
export const STYLES: readonly { readonly key: string; readonly materials: Required<BuildingMaterials> }[] = [
  {
    key: 'brick',
    materials: { wall: spec('brick', 0x9a5540), trim: spec('stone', 0xe3dccd), roof: spec('tile', 0x5a4a44), plinth: spec('stone', 0x6f6a62) },
  },
  {
    key: 'modern',
    materials: { wall: spec('plaster', 0xf1efe9), trim: spec('concrete', 0xb9bcbb), roof: spec('metal', 0x4d5256), plinth: spec('concrete', 0x8a8a84) },
  },
  {
    key: 'mediterranean',
    materials: { wall: spec('plaster', 0xe8cfa0), trim: spec('plaster', 0xf6efe2), roof: spec('tile', 0xa65a3c), plinth: spec('stone', 0x8f8069) },
  },
  {
    key: 'industrial',
    materials: { wall: spec('metal', 0x7f8a86), trim: spec('concrete', 0xc7c6be), roof: spec('metal', 0x5d6462), plinth: spec('concrete', 0x77766f) },
  },
  {
    key: 'timber',
    materials: { wall: spec('wood', 0x8a6a4a), trim: spec('plaster', 0xeee8dc), roof: spec('metal', 0x3f4447), plinth: spec('stone', 0x6d665c) },
  },
];

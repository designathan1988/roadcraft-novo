// The Roadcraft 4.0 subsystem's public surface. Code outside `src/r40` imports from here, never from its internals.
export { madeToMeasure } from './world/buildings/procedural.ts';
export { hypot3 } from './core/hypot.ts';
export { BUILDING_SCHEMA } from './world/buildings/types.ts';
export { furnishLot, lotKind, planLot } from './world/growth/lotPlan.ts';
export { emitChunk, letGoEmitted } from './render/buildings/buildingMesh.ts';
export { PartyWalls } from './render/buildings/partyWalls.ts';
export { PLATE_DETAIL, TILE_DETAIL, emitMassing } from './render/buildings/massing.ts';
export { partGeometries } from './render/buildings/kit.ts';
export { COLOURED_PARTS, COLOUR_RANGE, PAINT_UNIT, NORMAL_UNIT } from './render/buildings/cellArrays.ts';
export { POSE_FLOATS } from './render/buildings/partPose.ts';
export { LOOK_FLOATS } from './render/buildings/shellParts.ts';
export { FINISHES, roofMaterial, wallMaterial } from './world/buildings/materials.ts';
export { levelElevation, levelHeight, localToWorld, volumeElevation } from './world/buildings/geometry.ts';
export { floorHeight } from './world/buildings/foundation.ts';
export { interiorFurniture } from './render/buildings/buildingMesh.ts';
export { createFurnitureGeometries } from './render/buildings/furnitureKit.ts';
export type { PartKind } from './render/buildings/kit.ts';
export type {
  Building, RoofKind, Volume, Storey, Facade, Core, BuildingElement,
  FacadeGeometry, Relief, VolumeDress, Space, BuildingUse, BuildingFunction, LotSurface, BlockMode,
} from './world/buildings/types.ts';
export type { MaterialSpec, VolumeMaterials } from './world/buildings/materialTypes.ts';
export type { MadeBuilding, Envelope } from './world/buildings/procedural.ts';
export type { LotKind, LotPlan } from './world/growth/lotPlan.ts';
export type { BuildingChunk } from './render/buildings/chunk.ts';
export type { PartBatch } from './render/buildings/chunk.ts';
export type { MassDetail, MassingChunk } from './render/buildings/massing.ts';
export type { GroundAt, PavedAt } from './world/buildings/foundation.ts';

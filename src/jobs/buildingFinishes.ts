// Building finishes: the Roadcraft 4.0 cooked texture arrays (public/cooked/surfaces/building-finishes.{map,normal,
// rough}.ktx2: 13 layers of 512², rgba8, zstd), decoded in a worker and packed into the two arrays the building
// material samples: colour (rgb, sRGB) + roughness, and normal (rgb) + metalness. No three here: workers only.

/** Finish ids as the vertex carries them (high nibble of the material byte). 0 = by material (see FINISH_BY_MAT). */
export const FIN = {
  Auto: 0, Plaster: 1, Ceramic: 2, Brick: 3, Stone: 4, Concrete: 5, Wood: 6, Metal: 7, Glass: 8, Tile: 9, Roofing: 10,
  Stucco: 11, Panel: 12, Slate: 13,
} as const;
export const FINISH_COUNT = 13;
/** Texels per layer side (the cooked files' size). */
export const FINISH_SIZE = 512;

/** Finish names for the creator (index = id − 1). */
export const FINISH_KEYS = ['plaster', 'ceramic', 'brick', 'stone', 'concrete', 'wood', 'metal', 'glass', 'tile', 'roofing', 'stucco', 'panel', 'slate'] as const;
/** The layers of the cooked files: Roadcraft 4.0 `FINISHES` order. */
export const COOKED_FINISHES = ['plaster', 'stucco', 'ceramic', 'brick', 'stone', 'concrete', 'wood', 'metal', 'glass', 'tile', 'slate', 'panel', 'roofing'] as const;

export interface FinishLook {
  /** Metres one repeat of the finish covers. */
  worldSize: number;
  /** How many repeats its layer holds each way (4.0 `finishTiles`: a 256 texel finish is tiled 2 × 2 in 512). */
  tiles: number;
  /** Strength of the normal map. */
  normalScale: number;
  /** Metalness; `metallic`: scaled by the map (glass: the mullions are metal, the panes not). */
  metalness: number;
  metallic: boolean;
}

/** Roadcraft 4.0 `bake/finishRecipes.ts` LOOKS: [world size m, texels, normal scale, metalness, metallic]. */
const LOOKS_40: Record<(typeof FINISH_KEYS)[number], [number, number, number, number, boolean]> = {
  plaster: [4, 256, 0.2, 0, false], stucco: [3, 256, 0.22, 0, false], ceramic: [1, 256, 0.25, 0, false],
  brick: [2.4, 512, 0.55, 0, false], stone: [3.2, 512, 0.3, 0, false], concrete: [4.8, 256, 0.3, 0, false],
  wood: [2.4, 256, 0.45, 0, false], metal: [1.6, 256, 0.6, 0.55, false], glass: [3, 256, 0.3, 1, true],
  tile: [2, 256, 0.7, 0, false], slate: [2, 256, 0.6, 0, false], panel: [2.4, 256, 0.3, 0.15, false],
  roofing: [4, 256, 0.35, 0, false],
};

/** The look of each finish id (index = id; 0 unused). */
export const FINISH_LOOKS: FinishLook[] = [{ worldSize: 1, tiles: 1, normalScale: 0, metalness: 0, metallic: false },
  ...FINISH_KEYS.map((k) => { const [worldSize, size, normalScale, metalness, metallic] = LOOKS_40[k]; return { worldSize, tiles: FINISH_SIZE / size, normalScale, metalness, metallic }; })];

/** Finish for each building material (BMAT) when the vertex says Auto. 0 = no texture. */
export const FINISH_BY_MAT = [FIN.Plaster, FIN.Roofing, FIN.Tile, 0, FIN.Plaster, FIN.Metal, FIN.Concrete, 0, FIN.Plaster, FIN.Plaster, 0, 0, 0, 0, 0, 0];

/** The cooked files, by the name of the map. */
export const COOKED_FILES = { map: 'building-finishes.map.ktx2', normal: 'building-finishes.normal.ktx2', rough: 'building-finishes.rough.ktx2' } as const;

/**
 * Packs the three cooked arrays (level 0, layers in `COOKED_FINISHES` order) into the material's two, layer k =
 * finish id k + 1: `albedo` = the map's rgb (sRGB) + roughness (the rough map's green); `normal` = the normal map's
 * rgb + the metal mask (the rough map's blue where the finish is `metallic`, else 1).
 */
export function packFinishes(map: Uint8Array, normal: Uint8Array, rough: Uint8Array): { albedo: Uint8Array; normal: Uint8Array } {
  const n = FINISH_SIZE * FINISH_SIZE, per = n * 4;
  if (map.length !== per * FINISH_COUNT || normal.length !== per * FINISH_COUNT || rough.length !== per * FINISH_COUNT) {
    throw new Error(`building finishes: expected ${FINISH_COUNT} layers of ${FINISH_SIZE}², got ${map.length}/${normal.length}/${rough.length} bytes`);
  }
  const albedo = new Uint8Array(per * FINISH_COUNT), nrm = new Uint8Array(per * FINISH_COUNT);
  for (let id = 1; id <= FINISH_COUNT; id++) {
    const src = COOKED_FINISHES.indexOf(FINISH_KEYS[id - 1]) * per, dst = (id - 1) * per;
    const metallic = FINISH_LOOKS[id].metallic;
    for (let i = 0; i < per; i += 4) {
      albedo[dst + i] = map[src + i]; albedo[dst + i + 1] = map[src + i + 1]; albedo[dst + i + 2] = map[src + i + 2];
      albedo[dst + i + 3] = rough[src + i + 1];
      nrm[dst + i] = normal[src + i]; nrm[dst + i + 1] = normal[src + i + 1]; nrm[dst + i + 2] = normal[src + i + 2];
      nrm[dst + i + 3] = metallic ? rough[src + i + 2] : 255;
    }
  }
  return { albedo, normal: nrm };
}

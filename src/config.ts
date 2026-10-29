// World constants. The map size lives here and nowhere else.

/** Tile side in meters (unit of saving, terrain and the L2 level). */
export const TILE_SIZE = 1024;
/** Offered map sizes (tiles per side). 4 km is test-only and hidden from the start menu. */
export const MAP_SIZES = [4, 10, 16, 20, 24];

/**
 * Size chosen before any module builds arrays: on the page it comes from
 * ?mapa=N or the last choice (localStorage); in workers, from the worker name.
 * Changing the size reloads the page.
 */
function readMapTiles(): number {
  const g = globalThis as { name?: unknown; location?: { search?: string }; localStorage?: Storage; document?: unknown };
  let v = NaN;
  try {
    if (!g.document && typeof g.name === 'string') { const m = /mapa=(\d+)/.exec(g.name); if (m) v = Number(m[1]); }
    else {
      const m = /[?&]mapa=(\d+)/.exec(g.location?.search ?? '');
      if (m) v = Number(m[1]);
      else v = Number(g.localStorage?.getItem('cidade.mapa') ?? NaN);
    }
  } catch { /* no access: default size */ }
  return MAP_SIZES.includes(v) ? v : 10;
}

/** Tiles per map side. 10 → a 10,240 m map. */
export const MAP_TILES = readMapTiles();
/** Tag that passes the size to workers through the worker name. */
export const MAP_TAG = `mapa=${MAP_TILES}`;
/** Map side in meters. */
export const MAP_SIZE = TILE_SIZE * MAP_TILES;
/** Half the map: the world spans -MAP_HALF to +MAP_HALF in X and Z. */
export const MAP_HALF = MAP_SIZE / 2;

/** Spatial grid levels (side in meters). */
export const PLATE_SIZE = 2048;
export const CELL_SIZE = 256;
export const SUBCELL_SIZE = 64;

export const CELLS_PER_TILE = TILE_SIZE / CELL_SIZE; // 4
export const MAP_CELLS = MAP_SIZE / CELL_SIZE; // 40 on the 10 km map
export const MAP_SUBCELLS = MAP_SIZE / SUBCELL_SIZE; // 160
export const MAP_PLATES = Math.ceil(MAP_SIZE / PLATE_SIZE); // 5

/** Spacing of terrain height samples (m). */
export const HEIGHT_SPACING = 4;
/** Height samples per tile side (= texture layer). */
export const HEIGHT_TILE_RES = TILE_SIZE / HEIGHT_SPACING; // 256
/** Height samples per map side. */
export const HEIGHT_MAP_RES = HEIGHT_TILE_RES * MAP_TILES; // 2560

/** Terrain height range (m). */
export const TERRAIN_MIN_Y = -64;
export const TERRAIN_MAX_Y = 400;
/** Sea level. */
export const SEA_LEVEL = 0;

/** Save format version. */
export const SAVE_VERSION = 7;

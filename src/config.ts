// Constantes do mundo. O tamanho do mapa vive aqui e em nenhum outro lugar.

/** Lado do ladrilho em metros (unidade de salvamento, terreno e nível L2). */
export const TILE_SIZE = 1024;
/** Tamanhos de mapa oferecidos (ladrilhos por lado). */
export const MAP_SIZES = [10, 16, 20, 24];

/**
 * Tamanho escolhido antes de qualquer módulo montar arrays: na página vem de
 * ?mapa=N ou da última escolha (localStorage); nos workers, do nome do worker.
 * Trocar de tamanho recarrega a página.
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
  } catch { /* sem acesso: tamanho padrão */ }
  return MAP_SIZES.includes(v) ? v : 10;
}

/** Ladrilhos por lado do mapa. 10 → mapa de 10.240 m. */
export const MAP_TILES = readMapTiles();
/** Marca para passar o tamanho aos workers pelo nome. */
export const MAP_TAG = `mapa=${MAP_TILES}`;
/** Lado do mapa em metros. */
export const MAP_SIZE = TILE_SIZE * MAP_TILES;
/** Metade do mapa: o mundo vai de -MAP_HALF a +MAP_HALF em X e Z. */
export const MAP_HALF = MAP_SIZE / 2;

/** Níveis da grade espacial (lado em metros). */
export const PLATE_SIZE = 2048;
export const CELL_SIZE = 256;
export const SUBCELL_SIZE = 64;

export const CELLS_PER_TILE = TILE_SIZE / CELL_SIZE; // 4
export const MAP_CELLS = MAP_SIZE / CELL_SIZE; // 40 no mapa de 10 km
export const MAP_SUBCELLS = MAP_SIZE / SUBCELL_SIZE; // 160
export const MAP_PLATES = Math.ceil(MAP_SIZE / PLATE_SIZE); // 5

/** Espaçamento das amostras de altura do terreno (m). */
export const HEIGHT_SPACING = 4;
/** Amostras de altura por lado de ladrilho (= camada da textura). */
export const HEIGHT_TILE_RES = TILE_SIZE / HEIGHT_SPACING; // 256
/** Amostras de altura por lado do mapa. */
export const HEIGHT_MAP_RES = HEIGHT_TILE_RES * MAP_TILES; // 2560

/** Faixa de altura do terreno (m). */
export const TERRAIN_MIN_Y = -64;
export const TERRAIN_MAX_Y = 400;
/** Nível do mar. */
export const SEA_LEVEL = 0;

/** Versão do formato de salvamento. */
export const SAVE_VERSION = 7;

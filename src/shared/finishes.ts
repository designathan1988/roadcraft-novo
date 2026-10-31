// The building finish vocabulary: the ids the vertices carry (high nibble of the material byte) and the 4.0
// layer order of the cooked texture arrays. Data only, shared by the worker generator, the b40 tables and the page.

/** Finish ids as the vertex carries them. 0 = by material (see FINISH_BY_MAT). */
export const FIN = {
  Auto: 0, Plaster: 1, Ceramic: 2, Brick: 3, Stone: 4, Concrete: 5, Wood: 6, Metal: 7, Glass: 8, Tile: 9, Roofing: 10,
  Stucco: 11, Panel: 12, Slate: 13,
} as const;
export const FINISH_COUNT = 13;

/** Finish names for the creator (index = id − 1). */
export const FINISH_KEYS = ['plaster', 'ceramic', 'brick', 'stone', 'concrete', 'wood', 'metal', 'glass', 'tile', 'roofing', 'stucco', 'panel', 'slate'] as const;

/** The layers of the cooked files: Roadcraft 4.0 `FINISHES` order. */
export const COOKED_FINISHES = ['plaster', 'stucco', 'ceramic', 'brick', 'stone', 'concrete', 'wood', 'metal', 'glass', 'tile', 'slate', 'panel', 'roofing'] as const;

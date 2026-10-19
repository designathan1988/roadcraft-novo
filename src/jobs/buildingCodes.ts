// Codes shared by the building generators (jobs/buildingGen.ts, jobs/signature.ts) and read by the buildings' shader
// (render/city.ts): the material in the low nibble of the colour's alpha byte, the facade kind on the vertex.

/** Building materials (low nibble of the colour's alpha; the finish is the high nibble). */
export const BMAT = { Wall: 0, RoofFlat: 1, RoofTile: 2, Curtain: 3, Plain: 4, Metal: 5, Paving: 6, Grass: 7, Fence: 8, Shop: 9 } as const;
/** Facade kind (bits 0-1 of the kind byte); bit 2 = a shop ground storey. */
export const Facade = { Punched: 0, Curtain: 1, House: 2, Industrial: 3, ShopBit: 4 } as const;

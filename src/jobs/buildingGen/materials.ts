/** Building materials (alpha channel of the colour). */
export const BMAT = { Wall: 0, RoofFlat: 1, RoofTile: 2, Curtain: 3, Plain: 4, Metal: 5, Paving: 6, Grass: 7, Fence: 8, Shop: 9, WinGlass: 10 } as const;
/** Facade kind (bits 0-1 of the type byte); bit 2 = shop ground floor. */
export const Facade = { Punched: 0, Curtain: 1, House: 2, Industrial: 3, ShopBit: 4 } as const;

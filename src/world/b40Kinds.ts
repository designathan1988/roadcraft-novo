// The b40 vocabulary: every kind a Roadcraft 4.0 building carries, as dense numeric codes in the 4.0 order.
// The generator, the lot and the emitters read and write codes, never strings: a bay is one byte, a storey's fill
// is one byte, and the furniture sizes are one flat Float32Array (across, deep, high per kind).
// Values from Roadcraft 4.0: world/buildings/types.ts (kinds), architecture.ts (building kinds and ground roles),
// world/buildings/interior.ts (FURNITURE_KINDS and FURNITURE_SIZE).

/** `Building.use`, as the 4.0 lists it. */
export const B40_USE = { Residential: 0, Commercial: 1, Industrial: 2, Mixed: 3 } as const;
export type B40Use = (typeof B40_USE)[keyof typeof B40_USE];

/** `BAY_COMPONENTS`: the order is the 4.0 order and is part of the data (bay codes are written into bytes). */
export const B40_BAY = {
  Wall: 0, Window: 1, SashWindow: 2, FrenchWindow: 3, BayWindow: 4, Ribbon: 5, WideWindow: 6, Balcony: 7,
  Door: 8, DoubleDoor: 9, GarageDoor: 10, Shopfront: 11, LoadingDoor: 12, Pillar: 13,
  Loggia: 14, Brise: 15, ShutteredWindow: 16, Gourmet: 17,
} as const;
export type B40Bay = (typeof B40_BAY)[keyof typeof B40_BAY];
export const B40_BAY_COUNT = 18;

/** `FACADE_PATTERNS`, in the 4.0 order. */
export const B40_PATTERN = {
  Residential: 0, Storefront: 1, Office: 2, Industrial: 3, Arcade: 4, Gallery: 5, ArtDeco: 6, ArtDecoCrown: 7, Observation: 8,
} as const;
export type B40Pattern = (typeof B40_PATTERN)[keyof typeof B40_PATTERN];
export const B40_PATTERN_COUNT = 9;

/** `ROOF_KINDS`, in the 4.0 order. */
export const B40_ROOF = { Flat: 0, Terrace: 1, Gable: 2, Hip: 3, Shed: 4, Sawtooth: 5 } as const;
export type B40Roof = (typeof B40_ROOF)[keyof typeof B40_ROOF];

/** `CORE_KINDS`, in the 4.0 order. */
export const B40_CORE = { Stair: 0, Lift: 1, StairLift: 2 } as const;
export type B40Core = (typeof B40_CORE)[keyof typeof B40_CORE];

/** `SPACE_KINDS`, in the 4.0 order. */
export const B40_SPACE = { Unit: 0, Shop: 1, Office: 2, Workshop: 3, Corridor: 4, Lobby: 5 } as const;
export type B40Space = (typeof B40_SPACE)[keyof typeof B40_SPACE];

/** The keys of 4.0's `FOR`: what the procedural generator decides a lot is. */
export const B40_KIND = { House: 0, Flats: 1, Tower: 2, Shop: 3, Office: 4, Works: 5 } as const;
export type B40Kind = (typeof B40_KIND)[keyof typeof B40_KIND];

/** 4.0 `GroundRole`: what the ground floor of a block carries. */
export const B40_GROUND = { Shop: 0, Lobby: 1, House: 2, Works: 3 } as const;
export type B40Ground = (typeof B40_GROUND)[keyof typeof B40_GROUND];

/** A volume's faces in its local frame: 0 front (local −y, the street), 1 right (+x), 2 back, 3 left. */
export const B40_SIDE = { Front: 0, Right: 1, Back: 2, Left: 3 } as const;
export type B40Side = (typeof B40_SIDE)[keyof typeof B40_SIDE];

/** Roof details, in the 4.0 order. */
export const B40_ROOF_DETAIL = { Solar: 0, Skylight: 1, Vent: 2, Chimney: 3, WaterTank: 4, Spire: 5, Lantern: 6 } as const;
export type B40RoofDetail = (typeof B40_ROOF_DETAIL)[keyof typeof B40_ROOF_DETAIL];

/** `FURNITURE_KINDS`, in the 4.0 order: the ids written into the interior table. */
export const B40_FURNITURE = {
  Bed: 0, SingleBed: 1, Sofa: 2, Armchair: 3, Table: 4, Chair: 5, Desk: 6, OfficeChair: 7, Shelf: 8, Bookshelf: 9,
  Counter: 10, Fridge: 11, Stove: 12, Sink: 13, Toilet: 14, Bath: 15, Wardrobe: 16, Tv: 17, Plant: 18, Pew: 19,
  Seat: 20, WardBed: 21, Bars: 22, Screen: 23, Altar: 24, Machine: 25, Rack: 26, Locker: 27, Atm: 28, Stage: 29,
  BarCounter: 30, Blackboard: 31, Checkout: 32, Treadmill: 33, Pallet: 34, CeilingLamp: 35, FloorLamp: 36,
  TableLamp: 37, Stairs: 38, Stairwell: 39,
} as const;
export type B40Furniture = (typeof B40_FURNITURE)[keyof typeof B40_FURNITURE];
export const B40_FURNITURE_COUNT = 40;
export const B40_FURNITURE_STRIDE = 3;

/** Across, deep, high (metres), by the furniture kind's code: the 4.0 FURNITURE_SIZE table, one flat array. */
export const B40_FURNITURE_SIZE: Float32Array = new Float32Array([
  1.6, 2, 0.55,      // Bed
  0.9, 2, 0.5,       // SingleBed
  2.2, 0.9, 0.8,     // Sofa
  0.9, 0.9, 0.85,    // Armchair
  1.6, 0.9, 0.75,    // Table
  0.48, 0.48, 0.9,   // Chair
  1.4, 0.7, 0.75,    // Desk
  0.55, 0.55, 1,     // OfficeChair
  2, 0.5, 1.9,       // Shelf
  2.4, 0.4, 2.2,     // Bookshelf
  3, 0.7, 1.05,      // Counter
  0.7, 0.7, 1.8,     // Fridge
  0.7, 0.6, 0.9,     // Stove
  1, 0.6, 0.9,       // Sink
  0.45, 0.7, 0.8,    // Toilet
  0.8, 1.7, 0.6,     // Bath
  1.6, 0.6, 2,       // Wardrobe
  1.2, 0.4, 1.1,     // Tv
  0.5, 0.5, 1.2,     // Plant
  3.2, 0.6, 0.95,    // Pew
  0.6, 0.6, 1,       // Seat
  1, 2.1, 0.75,      // WardBed
  3, 0.12, 2.6,      // Bars
  8, 0.3, 4,         // Screen
  2, 1, 1.1,         // Altar
  1.6, 1.1, 1.6,     // Machine
  4, 1.1, 3.2,       // Rack
  0.5, 0.5, 1.9,     // Locker
  0.7, 0.6, 1.6,     // Atm
  5, 3, 0.6,         // Stage
  4, 0.7, 1.1,       // BarCounter
  4, 0.1, 1.2,       // Blackboard
  1.8, 0.8, 0.95,    // Checkout
  0.8, 1.9, 1.3,     // Treadmill
  1.2, 1, 1.2,       // Pallet
  0.6, 0.6, 0.35,    // CeilingLamp
  0.45, 0.45, 1.6,   // FloorLamp
  0.35, 0.35, 0.55,  // TableLamp
  1, 3.4, 2.9,       // Stairs
  1.15, 3.5, 1,      // Stairwell
]);

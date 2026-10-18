// Road numbers with a source. Values come from the Roadcraft 4.0 tuning table
// (`roadcraft-4.0-main/src/world/roads/tuning.ts`, the player's decision of 2026-10-09 for the economy).

export const ROAD_TUNING = {
  economy: {
    /** Money a new map starts with (R$). */
    startingFunds: 20_000_000,
    /** Price of one square metre of each element of the cross-section (R$/m²). */
    perSquareMetre: { carriageway: 150, median: 40, footway: 80 },
    /** Price multiplier by how the road is built. */
    structure: { ground: 1, embankment: 1.4, trench: 1.8, bridge: 2.5, tunnel: 6 },
    /** Share of a road's price given back when it is demolished. */
    demolitionRefund: 0.25,
    /** Height over the ground (m) from which a road at grade sits on an embankment (or in a trench below its negative). */
    fillFrom: 1,
    /**
     * Height over the ground (m) from which the road is a bridge, and depth below it from which it is a tunnel.
     * These are the engine's own limits (`roads/build.ts` clearAndConform: the terrain is left alone past them, so the
     * road is drawn with piers or buried), not Roadcraft's 2.8 m piers: the price follows what the player sees.
     */
    bridgeFrom: 4.5,
    tunnelFrom: 7,
  },
} as const;

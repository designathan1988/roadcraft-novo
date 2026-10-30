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
    /** The tunnel's own rule (TUNNEL.portalDepth): the price follows where the portal stands. */
    tunnelFrom: 7.4,
  },
} as const;

/**
 * Road tunnels (sources in tunel/ANALISE.md). The portal stands where the ground covers the tunnel's roof: FHWA-NHI-10-034
 * §1.3.5, "located at a point where the depth of the tunnel is suitably covered", in a cut-and-cover tunnel as close to
 * the surface as the roof allows; before it the road runs in an open cut (§5.2.1). Clear height 5.8 m (over AASHTO's
 * 4.9 m for highways, FHWA §2.3) and a 1.6 m roof slab: a road is in a tunnel where the ground is at least 7.4 m over
 * it, and only there; the terrain is cut down to the road everywhere shallower. Grade in a tunnel at most 5 % (FHWA
 * §2.2.1: preferably 4 %, up to 6 %; EU Directive 2004/54/EC Annex I 2.2.2: over 5 % not allowed in new tunnels).
 */
export const TUNNEL = { clearance: 5.8, roof: 1.6, portalDepth: 7.4, maxGrade: 0.05 } as const;

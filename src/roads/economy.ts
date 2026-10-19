// Road economy (Roadcraft's minimal economy): a road costs the area of each element of its cross-section
// (carriageway, median, footway) times the price per m², times the multiplier of how it is built (ground,
// embankment, trench, bridge, tunnel). Demolishing gives back a share. Values in `roads/tuning.ts`.
// Pure functions of the profile and heights; the build kind of each segment is stored in its flags (bits 4-6)
// when it is built, so the refund later reads the same kind even after the terrain was conformed under it.

import { SEA_LEVEL } from '../config.ts';
import { PROFILE_INFO } from './profiles.ts';
import { ROAD_TUNING } from './tuning.ts';

const E = ROAD_TUNING.economy;

export const BuildKind = { Ground: 0, Embankment: 1, Trench: 2, Bridge: 3, Tunnel: 4 } as const;
export const BUILD_KIND_KEYS = ['ground', 'embankment', 'trench', 'bridge', 'tunnel'] as const;

/** Segment flag bits holding the build kind + 1 (0 = not recorded: older saves and the generated city). */
export const KIND_SHIFT = 4;
export const KIND_MASK = 7 << KIND_SHIFT;

export function kindOfFlags(flags: number): number { return ((flags & KIND_MASK) >> KIND_SHIFT) - 1; }
export function withKind(flags: number, kind: number): number { return (flags & ~KIND_MASK) | ((kind + 1) << KIND_SHIFT); }

/** Price of one metre of this profile built at grade (R$/m): computed with the profile (`profiles.ts` derive). */
export function pricePerMetre(profile: number): number { return PROFILE_INFO[profile]?.cost ?? 0; }

/** How a point of road at height `y` over ground `ground` (and water at `water`, if any) is built. */
export function buildKindAt(y: number, ground: number, water = -Infinity): number {
  if ((ground < SEA_LEVEL + 0.3 || water > ground) && y > ground) return BuildKind.Bridge; // never filled over water
  const gap = y - ground;
  if (gap > E.bridgeFrom) return BuildKind.Bridge;
  if (gap >= E.fillFrom) return BuildKind.Embankment;
  if (gap < -E.tunnelFrom) return BuildKind.Tunnel;
  if (gap <= -E.fillFrom) return BuildKind.Trench;
  return BuildKind.Ground;
}

/** The kind that holds most of five samples (ties go to the dearer one). */
export function dominantKind(kinds: number[]): number {
  const n = [0, 0, 0, 0, 0];
  for (const k of kinds) n[k]++;
  let best = 0;
  for (let k = 1; k < 5; k++) if (n[k] >= n[best] && n[k] > 0) best = k;
  return best;
}

export function structureFactor(kind: number): number { return E.structure[BUILD_KIND_KEYS[kind] ?? 'ground']; }

/** Price of `len` metres of the profile built as `kind`. */
export function segmentPrice(profile: number, len: number, kind: number): number {
  return len * pricePerMetre(profile) * structureFactor(kind);
}

/** Money taken (positive) or given back (negative) for an edit that changed the road value by `delta`. */
export function chargeFor(delta: number): number {
  if (Math.abs(delta) < 1) return 0;
  return delta > 0 ? Math.round(delta) : -Math.round(-delta * E.demolitionRefund);
}

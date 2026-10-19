// Who a person in the pose buffer looks like and what they are doing, from the pose alone (no per-person state).
// No three.js here: the tests run it under Node.

import { CLIP, type CookedPeople } from './format.ts';

export interface LookChoice {
  variation: number;
  clip: number;
  /** Playback rate (walk matched to the speed, pedalling to the bike's). */
  rate: number;
  /** Offset into the clip, 0..1, so neighbours are not in step. */
  phase: number;
  /** Stable 24-bit hash: tints, hair colour, things held. */
  hash: number;
}

/** Integer hash (lowbias32). */
export function hash32(x: number): number {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** Natural walking speed of the cooked walk at its own rate, m/s (Rocketbox: ~1.5 m a cycle of ~1.1 s). */
const WALK_SPEED = 1.4;
/**
 * Fastest playback: the brisk walk (1.6x) at the fastest simulation speed (4x). The rate follows the ground speed seen
 * on screen, so at 2x and 4x the feet keep step with the ground instead of sliding.
 */
const MAX_RATE = 1.6 * 4;
/** Speed at which the cooked pedalling (one turn a second) matches the wheels. */
const PEDAL_SPEED = 5;

/**
 * The look of a pedestrian: its 16-bit appearance id (pose index 10, drawn when the person is born) with the pose's
 * kind and colour (`kind*256 + colour`; light bits above bit 16 left out), hashed; the clip from the speed, the rain
 * and the hash.
 */
export function pickLook(info: number, speed: number, bike: boolean, rain: number, meta: CookedPeople, out: LookChoice, look = 0): LookChoice {
  const id = ((Math.floor(info) % 65536) + (look & 0xffff) * 65536) >>> 0;
  const h = hash32(id * 2654435761 + 0x9e3779b9);
  const n = meta.variations.length;
  // cyclists are not children or the elderly too often
  let v = h % n;
  if (bike && (meta.variations[v].band === 'child' || meta.variations[v].band === 'senior')) v = (v + 4) % n;
  out.variation = v;
  out.hash = h & 0xffffff;
  out.phase = ((h >>> 20) & 1023) / 1024;
  const umbrella = rain > 0.3 && ((h >>> 3) % 10) < 6;
  const s = (h >>> 8) % 20;
  if (bike) {
    out.clip = CLIP.pedal;
    out.rate = quantize(Math.min(MAX_RATE, Math.max(0, speed / PEDAL_SPEED)));
  } else if (speed > 0.3) {
    out.clip = umbrella ? CLIP.walkUmbrella : s < 2 ? CLIP.walkPhone : s < 4 ? CLIP.walkCarry : CLIP.walk;
    const height = meta.variations[v].height;
    out.rate = quantize(Math.min(MAX_RATE, Math.max(0.6, speed / (WALK_SPEED * height / 1.75))));
  } else {
    out.clip = umbrella ? CLIP.umbrella : s < 4 ? CLIP.phone : s < 6 ? CLIP.read : s < 8 ? CLIP.drink : CLIP.idle;
    out.rate = 1;
  }
  return out;
}

/**
 * Hash of a seated person (the motorbike's rider, a cabin's occupants): the vehicle's kind and colour without its
 * light bits (braking or signalling must not change who rides it), its id (pose index 10) and the seat.
 */
export function riderHash(info: number, id: number, seat: number): number {
  return hash32(((Math.floor(info) % 65536) + (id & 0xffff) * 65536) * 31 + seat * 7919 + 17);
}

/** Rates in steps of 1/16: a rate that wobbles with the measured speed would jump the animation phase. */
const quantize = (r: number) => Math.round(r * 16) / 16;

// Paint helpers for the b40 generator: a material with its linear colour, the small lightness tint of a skin,
// and the hue/saturation/lightness nudge the 4.0 tables apply to roofs and second skins.
import { linearRgb } from '../../core/color.ts';
import type { Xoshiro128 } from '../../core/rng.ts';
import type { B40Paint } from '../../world/b40Styles.ts';

export const paintOf = (finish: number, colour: number): B40Paint => ({ finish, colour, linear: linearRgb(colour) });

/** Lightness, 0..1, of a colour (4.0 architecture.ts `light`). */
export const lightness = (c: number): number =>
  (Math.max((c >> 16) & 255, (c >> 8) & 255, c & 255) + Math.min((c >> 16) & 255, (c >> 8) & 255, c & 255)) / 510;

/** A colour nudged in lightness, 0.95..1.05 (4.0 architecture.ts `tint`): one float drawn. */
export function tint(c: number, rng: Xoshiro128): number {
  const k = 0.95 + rng.float() * 0.1;
  const ch = (s: number): number => Math.max(0, Math.min(255, Math.round(((c >> s) & 255) * k)));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** A colour nudged in hue, saturation and lightness, a little (4.0 procedural.ts `nudge`): three floats drawn. */
export function nudge(colour: number, rng: Xoshiro128, amount = 1): number {
  const r = ((colour >> 16) & 255) / 255, g = ((colour >> 8) & 255) / 255, b = (colour & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  const h2 = (h + (rng.float() - 0.5) * 0.03 * amount + 1) % 1;
  const s2 = Math.max(0, Math.min(1, s + (rng.float() - 0.5) * 0.1 * amount));
  const l2 = Math.max(0.05, Math.min(0.96, l + (rng.float() - 0.5) * 0.08 * amount));
  const q = l2 < 0.5 ? l2 * (1 + s2) : l2 + s2 - l2 * s2, p = 2 * l2 - q;
  const ch = (t: number): number => {
    const u = (t + 1) % 1;
    const v = u < 1 / 6 ? p + (q - p) * 6 * u : u < 1 / 2 ? q : u < 2 / 3 ? p + (q - p) * (2 / 3 - u) * 6 : p;
    return Math.round(Math.max(0, Math.min(1, v)) * 255);
  };
  return (ch(h2 + 1 / 3) << 16) | (ch(h2) << 8) | ch(h2 - 1 / 3);
}

// sRGB to linear: the IEC 61966-2-1 transfer function, precomputed once (no Math.pow per call).
// The building data carries colours as 0xRRGGBB in sRGB; the renderer and the workers want linear RGB.

const LINEAR = (() => {
  const table = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    table[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  return table;
})();

/** A channel 0..255 in sRGB to 0..1 linear. */
export function srgbToLinear(byte: number): number {
  return LINEAR[byte & 255]!;
}

/** Writes `hex`'s linear r, g, b at `at` in `out` (three floats): no array per colour. */
export function linearRgbInto(hex: number, out: Float32Array, at = 0): void {
  out[at] = srgbToLinear(hex >> 16);
  out[at + 1] = srgbToLinear(hex >> 8);
  out[at + 2] = srgbToLinear(hex);
}

/** `hex` as a new [r, g, b] triple: for module-level data only, never in a per-entity path. */
export function linearRgb(hex: number): readonly [number, number, number] {
  return [srgbToLinear(hex >> 16), srgbToLinear(hex >> 8), srgbToLinear(hex)];
}

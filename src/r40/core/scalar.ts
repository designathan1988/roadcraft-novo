

/** Generic floating-point slop for "are these the same point/number". */
export const EPS = 1e-9;

/** Guard against dividing by a quantity that is numerically zero. */
export const DIV_EPS = 1e-12;

/** Junction corner miter limit, as a multiple of the larger half-width. */
export const CORNER_MITER = 2.5;

/** Taper slope used where two collinear legs have different half-widths. */
export const TAPER_ANGLE = (12 * Math.PI) / 180;

/** `a / b` read to a millionth, for a count rounded from it (bays along a wall, posts along a run) */
export const steadyRatio = (a: number, b: number): number => Math.round((a / b) * 1e6) / 1e6;

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/** Two-argument hypotenuse, for inner loops. */
export const hypot2 = (x: number, y: number): number => Math.sqrt(x * x + y * y);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

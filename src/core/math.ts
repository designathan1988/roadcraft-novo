// The small numeric helpers every layer uses, in one place (P21): each had copies with the same formula.

/** Hermite step of t clamped to [0, 1]: 0 below 0, 1 above 1, 3t^2 - 2t^3 between. */
export function smoothstep01(t: number): number { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); }

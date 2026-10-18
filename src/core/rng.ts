// Aleatoriedade determinística: mesmo semente, mesmo resultado, em qualquer thread.

/** Hash inteiro de 32 bits (lowbias32). */
export function hash32(x: number): number {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x;
}

export function hash2(a: number, b: number, seed = 0): number {
  return hash32((hash32((a | 0) ^ seed) + Math.imul(b | 0, 0x9e3779b1)) >>> 0);
}

/** Gerador mulberry32. Estado num número; sem alocação por chamada. */
export class Rng {
  state: number;
  constructor(seed: number) { this.state = seed >>> 0; }
  nextU32(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }
  /** [0, 1) */
  next(): number { return this.nextU32() / 4294967296; }
  range(a: number, b: number): number { return a + (b - a) * this.next(); }
  int(a: number, bExclusive: number): number { return a + Math.floor(this.next() * (bExclusive - a)); }
}

const GRAD = new Float32Array([1, 0, -1, 0, 0, 1, 0, -1, 0.7071, 0.7071, -0.7071, 0.7071, 0.7071, -0.7071, -0.7071, -0.7071]);

/** Ruído de gradiente 2D em [-1, 1] aproximadamente. */
export function noise2(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  let h = (hash2(x0, y0, seed) & 7) * 2;
  const a = GRAD[h] * fx + GRAD[h + 1] * fy;
  h = (hash2(x0 + 1, y0, seed) & 7) * 2;
  const b = GRAD[h] * (fx - 1) + GRAD[h + 1] * fy;
  h = (hash2(x0, y0 + 1, seed) & 7) * 2;
  const c = GRAD[h] * fx + GRAD[h + 1] * (fy - 1);
  h = (hash2(x0 + 1, y0 + 1, seed) & 7) * 2;
  const d = GRAD[h] * (fx - 1) + GRAD[h + 1] * (fy - 1);
  const ab = a + (b - a) * u;
  return 1.4 * (ab + ((c + (d - c) * u) - ab) * v);
}

export function fbm(x: number, y: number, seed: number, octaves: number, lacunarity = 2, gain = 0.5): number {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(x * freq, y * freq, seed + i * 1013);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

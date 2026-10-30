// Grows a typed array in place of its owner (the arrays below the road network grow with it).

export function growArray<T extends Int32Array | Uint32Array | Float32Array | Float64Array | Uint16Array | Uint8Array>(a: T, cap: number, fill: number): T {
  if (cap <= a.length) return a;
  const b = new (a.constructor as new (n: number) => T)(cap);
  b.fill(fill);
  b.set(a);
  return b;
}

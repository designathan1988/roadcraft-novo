// A closed outline as flat x, y pairs inside a longer array: lots travel to the workers this way.

/** Whether (x, y) is inside the `n` corners starting at `at` (even-odd rule). */
export function insideOutline(o: ArrayLike<number>, at: number, n: number, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = o[at + i * 2], yi = o[at + i * 2 + 1], xj = o[at + j * 2], yj = o[at + j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

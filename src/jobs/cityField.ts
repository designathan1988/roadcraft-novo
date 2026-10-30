// The generated city's street grid, as Roadcraft 4.0 lays it (world/cityGen/plan.ts blockGrid): straight lines of
// 120 x 72 m blocks, avenues every 4 blocks, collectors between, local streets the rest. The tensor-field styles and
// the district grids were discarded by the owner (2026-10-30).

export interface P2 { x: number; z: number }

/** Blocks style (4.0): a straight grid of 120 × 72 m blocks, an avenue line every 4 blocks; lines as [level, points]. */
export function blockLines(cx: number, cz: number, R: number): Array<{ level: number; points: P2[] }> {
  const along = 120, across = 72, AVENUE_EVERY = 4;
  const nx = Math.max(2, Math.floor((R * 1.7) / along)), nz = Math.max(2, Math.floor((R * 1.7) / across));
  const x0 = cx - (nx * along) / 2, z0 = cz - (nz * across) / 2;
  // 4.0 plan.ts blockGrid levelOf: the edges and every AVENUE_EVERY-th line avenues, every other one between them a
  // collector, the rest local streets (a small grid: one collector down the middle)
  const levelOf = (k: number, n: number) => {
    if (k === 0 || k === n) return 0;
    if (n < AVENUE_EVERY * 2) return k === Math.floor(n / 2) ? 1 : 2;
    if (k % AVENUE_EVERY === 0) return 0;
    return k % (AVENUE_EVERY / 2) === 0 ? 1 : 2;
  };
  const out: Array<{ level: number; points: P2[] }> = [];
  for (let j = 0; j <= nz; j++) {
    const pts: P2[] = [];
    for (let i = 0; i <= nx * 4; i++) pts.push({ x: x0 + (i * along) / 4, z: z0 + j * across });
    out.push({ level: levelOf(j, nz), points: pts });
  }
  for (let i = 0; i <= nx; i++) {
    const pts: P2[] = [];
    for (let j = 0; j <= nz * 2; j++) pts.push({ x: x0 + i * along, z: z0 + (j * across) / 2 });
    out.push({ level: levelOf(i, nx), points: pts });
  }
  return out;
}

// The Camera panel's numbers, as Roadcraft 4.0 reads them (v2/shell.ts:644-645, render/isoViewport.ts:393-395).

/** The zoom: screen pixels per metre at the point looked at, in % (100 % = one pixel a metre). */
export function zoomPercent(viewHeightPx: number, dist: number, fovDeg: number): number {
  const seen = 2 * dist * Math.tan((fovDeg * Math.PI) / 360);
  return Math.round((viewHeightPx / Math.max(1e-6, seen)) * 100);
}

/** The point looked at: X east, Y north (the map's north is three.js −z). */
export function centreText(x: number, z: number, fmt: (v: number) => string): string {
  return `X ${fmt(Math.round(x) + 0)} · Y ${fmt(Math.round(-z) + 0)}`;
}

/** The simulation's demand as a factor, as Roadcraft 4.0 (v2/shell.ts:741): low 0.55, normal 1, peak 1.55. */
export function demandFactor(demand: string | undefined): number {
  return demand === 'baixa' ? 0.55 : demand === 'pico' ? 1.55 : 1;
}

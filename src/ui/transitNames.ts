// A transit line's name, as Roadcraft 4.0 gives it (world/transit.ts:134-138): its number among the lines of its mode,
// in the order they were made (ids grow), buses bare, trains with T, metro with M. Mode: 0 bus, 1 train, 2 metro.
// The line keeps no name of its own (world/transit.ts): a line removed renumbers the later ones of its mode.

export function lineName(lines: ReadonlyArray<{ id: number; mode: number }>, line: { id: number; mode: number }): string {
  let n = 0;
  for (const l of lines) if ((l.mode ?? 0) === (line.mode ?? 0) && l.id <= line.id) n++;
  return `${line.mode === 1 ? 'T' : line.mode === 2 ? 'M' : ''}${n}`;
}

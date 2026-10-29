// The bomb's force and blast, as Roadcraft 4.0 (v2/shell.ts:1632-1634, actionsWiring.ts:230,
// toolChoices.ts:214). Pure data and math, shared by the interface and the demolition feature.

/** The force the bomb starts with. */
export const BOMB_START = 5;

/** The force one step down (d < 0) or up: 1 at a time up to 10, 5 at a time above, between 1 and 50. */
export function bombStep(force: number, d: number): number {
  return d < 0 ? Math.max(1, force - (force > 10 ? 5 : 1)) : Math.min(50, force + (force >= 10 ? 5 : 1));
}

/** The blast's radius in metres. */
export function bombRadius(force: number): number {
  return 2.5 + force * 1.1;
}

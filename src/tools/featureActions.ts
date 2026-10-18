// Game capabilities added by the gameplay front that the interface front wires to buttons. They live in
// Game.hudActions next to the HUD's own actions (same object), so a panel calls `game.hudActions.lotLine()` the
// same way a script does. Each entry says what the player does and what happens.

export interface FeatureActions {
  /** Lot tool, "split by line": two clicks draw a line across a lot; it becomes two lots cut along it. */
  lotLine(): void;
  /** Lot tool, "curve side": click near a side of a lot, then click where the side should pass; it curves. */
  lotCurve(): void;
  /** Leaves the two modes above (back to the HUD's lot mode). */
  lotExtraOff(): void;
  /** Renovates the selected building (the same as Shift+click with the building tool): it is new again. */
  renovate(): void;
  /** Decay of the selected building, 0 (new) to 1 (falling apart); −1 with nothing selected. */
  decayOf(): number;
  /** Address of the selected building: "Rua Machado de Assis, 124" (metric: metres from the start of the street, even on the right). '' if none. */
  addressOf(): string;
  /** Name of the street nearest (x, z) (generated or typed by the player), '' away from streets. For name plates. */
  streetNameAt(x: number, z: number): string;
  /** Regional road paint of this map ('br', 'us', 'eu', 'classic'); saved with the map and restored when it opens. */
  mapPaint(style: string): void;
  /** Colour of the selected line (index into the vehicle palette, world/transit.ts LINE_COLORS). Undoable. */
  lineColor(color: number): void;
  /** Selected bus line as a ring (true) or out and back (false, Roadcraft's default: return trip on the other side). */
  lineLoop(loop: boolean): void;
  /** How many nodes are impossible to build (two neighbouring roads under 25°): the top bar's warning count. */
  impossibleNodes(): number;
  /** Smallest angle (degrees) between roads at the node if it is impossible, else −1 (the node inspector's "IMPOSSÍVEL DE CONSTRUIR"). */
  impossibleAngle(node: number): number;
  /** The impossible nodes as [node, x, z, angle, …], to point the camera at them from the warning. */
  impossibleList(): number[];
}

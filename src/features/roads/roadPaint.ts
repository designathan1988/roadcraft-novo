// The map's road paint (Brazilian, American, European, classic): part of the map (World.look.paint, saved with it), and
// choosing another is an edit the history can undo, as in Roadcraft 4.0 (roadcraft/src/main.ts:3993 setMarkingStyle:
// history.begin/end around doc.setMarkingStyle). The paint is drawn by the road shader (render/roads.ts).

import type { Command } from '../../core/commands.ts';
import { setPaintStyle } from '../../render/roads.ts';
import type { MapLook } from '../../world/mapLook.ts';

export interface RoadPaintHost {
  readonly look: MapLook;
  run(cmd: Command): void;
  /** The map changed and has to be saved. */
  changed(): void;
}

/** Paints the map's roads in `style` as one undoable step; the same style is no step. */
export function chooseRoadPaint(h: RoadPaintHost, style: string): void {
  const before = h.look.paint;
  if (style === before) return;
  const set = (s: string) => { h.look.paint = s; setPaintStyle(s); h.changed(); };
  h.run({ label: 'cmd.place.roadPaint', apply: () => set(style), invert: () => set(before) });
}

/** Shows the map's paint (after a map is opened or made). */
export function showRoadPaint(look: MapLook): void { setPaintStyle(look.paint); }

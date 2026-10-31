// The text typed on a street sign, as one undoable step: the sign's text and, for a street name plate, the name of
// the whole street (`chain`). Undo puts back what was there before: the sign's previous text and each segment's
// previous name (D47: undo used to delete the sign's text instead of restoring it).

import type { Command } from '../../core/commands.ts';
import type { SegId } from '../../core/ids.ts';
import type { World } from '../../world/world.ts';

/** Writes `text` on the sign at `key` (render/textSigns.ts signKey) and names `chain`; `changed` runs after each change. */
export function signTextCommand(world: World, key: string, text: string, chain: readonly SegId[], changed: () => void): Command {
  const prev = world.signTexts.get(key);
  const before = chain.map((s) => world.streetNames.get(s));
  return {
    label: 'cmd.place.signText',
    apply: () => { world.setSignText(key, text); for (const s of chain) world.setStreetName(s, text); changed(); },
    invert: () => {
      world.setSignText(key, prev);
      chain.forEach((s, i) => world.setStreetName(s, before[i]));
      changed();
    },
  };
}

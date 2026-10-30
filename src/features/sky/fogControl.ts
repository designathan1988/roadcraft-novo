// The fog's strength as the player sets it (the Sky panel's fog slider). The value is the map's (World.look, saved
// with it); this control edits it and shows it in the fog's uniform (render/scene.ts fogLevel).

import { fogLevel } from '../../render/scene.ts';
import type { MapLook } from '../../world/mapLook.ts';

export class FogControl {
  private look: MapLook;
  private changed: () => void;

  constructor(look: MapLook, changed: () => void) { this.look = look; this.changed = changed; }

  /** Sets the fog's strength (an edit of the map). */
  set(level: number): void {
    this.look.fog = level;
    this.changed();
    this.show();
  }

  /** Shows the map's fog (after a map is opened or made). */
  show(): void { fogLevel.value = this.look.fog; }
}

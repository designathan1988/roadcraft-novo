// The water's look as the player sets it (waves, foam, current: the Sky panel's water sliders). The values are the
// map's (World.look, saved with it); this control edits them and shows them in the water's uniforms.

import { currentU, foamU, waveU } from '../../render/scene.ts';
import type { MapLook, WaterCtl } from '../../world/mapLook.ts';

export class WaterControl {
  private look: MapLook;
  private changed: () => void;

  constructor(look: MapLook, changed: () => void) { this.look = look; this.changed = changed; }

  get ctl(): WaterCtl { return this.look.water; }

  /** Sets the water's look (an edit of the map). */
  set(w: WaterCtl): void {
    this.look.water = { ...w };
    this.changed();
    this.show();
  }

  /** Shows the map's water (after a map is opened or made). */
  show(): void {
    const w = this.look.water;
    waveU.value = w.waves; foamU.value = w.foam; currentU.value = w.current;
  }
}

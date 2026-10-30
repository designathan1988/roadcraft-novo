// The water's look as the player sets it (waves, foam, current: the Sky panel's water sliders, saved with the map).

import { currentU, foamU, waveU } from '../../render/scene.ts';

export interface WaterCtl { waves: number; foam: number; current: number }
export const DEFAULT_WATER: Readonly<WaterCtl> = { waves: 0.3, foam: 0.4, current: 0.5 };

export class WaterControl {
  private now: WaterCtl = { ...DEFAULT_WATER };
  private changed: () => void;

  constructor(changed: () => void) { this.changed = changed; }

  get ctl(): WaterCtl { return this.now; }

  /** Sets the water's look; `record` false for a map being opened (not an edit). */
  set(w: WaterCtl, record = true): void {
    this.now = { ...w };
    if (record) this.changed();
    waveU.value = w.waves; foamU.value = w.foam; currentU.value = w.current;
  }
}

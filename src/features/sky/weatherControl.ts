// The weather as the player sets it (the Sky panel; the value is the map's, World.look), and the option's preset when
// nothing is set by hand. One place for the presets: the option, the address (?chuva, ?tempestade, ?limpo) and the
// panel's "automatic" all read `weatherPreset`.

import type { Weather } from '../../render/weather.ts';
import { windDirU } from '../../render/weather.ts';
import type { MapLook, WeatherCtl } from '../../world/mapLook.ts';

/** The weather a preset name holds (the option's and the address's values; persisted names, so kept as they are). */
export function weatherPreset(name: string | undefined): Weather['fixed'] {
  return name === 'chuva' ? { clouds: 0.95, rain: 0.85 } : name === 'tempestade' ? { clouds: 1, rain: 1, storm: 1 } : name === 'limpo' ? { clouds: 0.15, rain: 0 } : null;
}

export interface WeatherHost {
  readonly weather: Weather;
  /** The map's look: its hand-set weather. */
  readonly look: MapLook;
  /** Thunder's loudness (Ambient.thunderVolume). */
  setThunder(volume: number): void;
  /** The option's preset name, when nothing is set by hand. */
  option(): string | undefined;
  changed(): void;
}

export class WeatherControl {
  private host: WeatherHost;

  constructor(host: WeatherHost) { this.host = host; }

  /** The weather set by hand (saved with the map), or null: it changes by itself, or follows the option. */
  get ctl(): WeatherCtl | null { return this.host.look.weather; }

  /** Sets the weather by hand (an edit of the map); null goes back to the automatic weather (or the option's preset). */
  set(w: WeatherCtl | null): void {
    this.host.look.weather = w ? { ...w } : null;
    this.host.changed();
    this.show();
  }

  /** Shows the map's weather: after a map is opened or made, or when the option changes (the hand-set weather stays). */
  show(): void {
    const w = this.host.look.weather, wt = this.host.weather;
    if (!w) {
      wt.windFixed = null; wt.lightningRate = 0; this.host.setThunder(1);
      wt.fixed = weatherPreset(this.host.option());
      return;
    }
    wt.fixed = { clouds: w.rain > 0 ? 0.6 + 0.4 * w.rain : w.lightning > 0 ? 0.85 : 0.25, rain: w.rain, storm: w.lightning > 0 ? 1 : 0 };
    wt.windFixed = Math.min(1, w.wind / 20);
    wt.lightningRate = w.lightning;
    const r = (w.dir * Math.PI) / 180;
    windDirU.value.set(Math.sin(r), Math.cos(r));
    this.host.setThunder(w.thunder);
  }
}

// The weather as the player sets it (the Sky panel, saved with the map), and the option's preset when nothing is set
// by hand. One place for the presets: the option, the address (?chuva, ?tempestade, ?limpo) and the
// panel's "automatic" all read `weatherPreset`.

import type { Weather } from '../../render/weather.ts';
import { windDirU } from '../../render/weather.ts';
import type { WeatherCtl } from '../../ui/hudActions.ts';

/** The weather a preset name holds (the option's and the address's values; persisted names, so kept as they are). */
export function weatherPreset(name: string | undefined): Weather['fixed'] {
  return name === 'chuva' ? { clouds: 0.95, rain: 0.85 } : name === 'tempestade' ? { clouds: 1, rain: 1, storm: 1 } : name === 'limpo' ? { clouds: 0.15, rain: 0 } : null;
}

export interface WeatherHost {
  readonly weather: Weather;
  /** Thunder's loudness (Ambient.thunderVolume). */
  setThunder(volume: number): void;
  /** The option's preset name, when nothing is set by hand. */
  option(): string | undefined;
  changed(): void;
}

export class WeatherControl {
  private manual: WeatherCtl | null = null;
  private host: WeatherHost;

  constructor(host: WeatherHost) { this.host = host; }

  /** The weather set by hand (saved with the map), or null: it changes by itself, or follows the option. */
  get ctl(): WeatherCtl | null { return this.manual; }

  /** Sets the weather by hand; null goes back to the automatic weather (or the option's preset). */
  set(w: WeatherCtl | null, record = true): void {
    this.manual = w;
    if (record) this.host.changed();
    const wt = this.host.weather;
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

  /** The option changed: the hand-set weather stays, otherwise the new preset applies (not an edit of the map). */
  optionChanged(): void { this.set(this.manual, false); }
}

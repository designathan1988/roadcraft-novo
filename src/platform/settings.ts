// The player's preferences (quality, resolution, weather option, simulation, road furniture, sky mode, road keys,
// sound), kept between runs in the browser/Electron storage. ONE owner: the game reads `now` and every change goes
// through `update` (the options dialog, the menu, the panels, the script API); a photo address (?simple, ?rain…)
// changes them for this run only and is never stored. Values stored under the older Portuguese names are read once
// and stored again in English.

import { readStored, writeStored } from '../shared/storage.ts';

export type Preset = 'low' | 'medium' | 'high' | 'ultra';
export type WeatherOption = 'auto' | 'clear' | 'rain' | 'storm';
export type Demand = 'low' | 'normal' | 'peak';
/** Always day, always night, or the light following the clock (the player's choice, kept between games). */
export type SkyMode = 'day' | 'night' | 'cycle';

export interface Settings {
  preset: Preset | 'custom';
  /** Fraction of the screen resolution (0.5 to 1). */
  resolution: number;
  shadows: boolean;
  ao: boolean;
  bloom: boolean;
  /** Multiplies the detail distances (0.6 to 1.6). */
  detail: number;
  weather: WeatherOption;
  /** Ambient sound volume (0..1). */
  volume?: number;
  /** Simulation: demand, traffic and people (fraction). */
  demand?: Demand;
  traffic?: number;
  people?: number;
  /** Furniture of new roads: 0 complete, 1 basic, 2 none. */
  furniture?: number;
  /** Always day, always night or the clock's light (Roadcraft 4.0 keeps it with the player, not with the map). */
  sky?: SkyMode;
  /** Road tool keys (key codes): raise and lower the road. */
  roadUp?: string;
  roadDown?: string;
  /** Road tool key that cycles the alignment: straight, curve, free (Roadcraft 4.0; default V). */
  roadAlign?: string;
}

export const PRESETS: Record<Preset, Omit<Settings, 'preset' | 'weather'>> = {
  low: { resolution: 0.75, shadows: false, ao: false, bloom: false, detail: 0.7 },
  medium: { resolution: 1, shadows: true, ao: false, bloom: true, detail: 0.9 },
  high: { resolution: 1, shadows: true, ao: true, bloom: true, detail: 1 },
  ultra: { resolution: 1, shadows: true, ao: true, bloom: true, detail: 1.4 },
};

export function defaultSettings(webgpu: boolean): Settings {
  return { preset: webgpu ? 'high' : 'low', ...PRESETS[webgpu ? 'high' : 'low'], weather: 'clear' };
}

/** The values older versions stored in Portuguese, by field. */
const RENAMED: Partial<Record<keyof Settings, Record<string, string>>> = {
  preset: { baixo: 'low', medio: 'medium', alto: 'high', personalizado: 'custom' },
  weather: { limpo: 'clear', chuva: 'rain', tempestade: 'storm' },
  demand: { baixa: 'low', pico: 'peak' },
};
/** Fields older versions stored that are no longer preferences (the road paint is the map's: World.look). */
const DROPPED = ['paint'];

/** The stored preferences over the defaults; older values renamed, dropped fields left out. */
export function readSettings(webgpu: boolean, text: string | null): Settings {
  const base = defaultSettings(webgpu);
  if (text) {
    try {
      const raw = JSON.parse(text) as Record<string, unknown>;
      for (const k of DROPPED) delete raw[k];
      for (const [k, names] of Object.entries(RENAMED)) { const v = raw[k]; if (typeof v === 'string' && names[v]) raw[k] = names[v]; }
      Object.assign(base, raw);
    } catch { /* unreadable: defaults */ }
  }
  // clear weather by default (the player, 2026-10-19): 'auto' brought rain; rain only when the player picks it
  if (base.weather === 'auto') base.weather = 'clear';
  return base;
}

export class Preferences {
  /** What the player chose (what is stored). */
  private chosen: Settings;
  /** This run's address overrides (photos, measurements): in force, never stored. */
  private run: Partial<Settings> = {};
  private merged: Settings;

  constructor(webgpu: boolean) {
    this.chosen = readSettings(webgpu, readStored('settings'));
    // compatibility mode (no WebGPU): always Low, for this run; the player's own quality stays stored
    if (!webgpu) this.run = { ...PRESETS.low, preset: 'low' };
    this.merged = { ...this.chosen, ...this.run };
    // stored again under the English name and values (a no-op when nothing changed)
    this.store();
  }

  /** The preferences in force: the player's, with this run's address overrides. */
  get now(): Readonly<Settings> { return this.merged; }

  /** The player changes `patch` (stored): it replaces an address override of the same fields. */
  update(patch: Partial<Settings>): void {
    Object.assign(this.chosen, patch);
    for (const k of Object.keys(patch) as Array<keyof Settings>) delete this.run[k];
    this.merged = { ...this.chosen, ...this.run };
    this.store();
  }

  /** The address changes `patch` for this run only (never stored). */
  forRun(patch: Partial<Settings>): void {
    Object.assign(this.run, patch);
    this.merged = { ...this.chosen, ...this.run };
  }

  private store(): void { writeStored('settings', JSON.stringify(this.chosen)); }
}

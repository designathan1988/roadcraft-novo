// The map's look, saved with the map and owned by the World: the water's look, the weather set by hand, the player's
// clouds, the fog and the road paint. Roadcraft 4.0 keeps the same values in its map document (doc.markingStyle,
// fog, weather: roadcraft/src/editor/saveLayers.ts:140) and a new map starts them over; the controls that show them
// (features/water, features/sky, render/roads) hold no copy.

export interface WaterCtl { waves: number; foam: number; current: number }
/** Rain 0..1, wind in m/s, direction in degrees (where it blows to), lightning per minute, thunder 0..1. */
export interface WeatherCtl { rain: number; wind: number; dir: number; lightning: number; thunder: number }
export interface Cloud { x: number; z: number; y: number; size: number; density: number }

export const DEFAULT_WATER: Readonly<WaterCtl> = { waves: 0.3, foam: 0.4, current: 0.5 };
/** No fog painted over the map: the fog strength a new map starts with (render/scene.ts fogLevel). */
export const DEFAULT_FOG = 1;
/** Brazilian road paint, the style a new map starts with (Roadcraft 4.0: roadcraft/src/main.ts:2072). */
export const DEFAULT_PAINT = 'br';

export class MapLook {
  water: WaterCtl = { ...DEFAULT_WATER };
  /** The weather set by hand, or null: it changes by itself or follows the option's preset. */
  weather: WeatherCtl | null = null;
  clouds: Cloud[] = [];
  fog = DEFAULT_FOG;
  paint = DEFAULT_PAINT;

  /** A new map's look. */
  reset(): void {
    this.water = { ...DEFAULT_WATER };
    this.weather = null;
    this.clouds = [];
    this.fog = DEFAULT_FOG;
    this.paint = DEFAULT_PAINT;
  }

  /** An opened map's look; a value the save does not have keeps the new map's. */
  load(saved: { water: WaterCtl | null; weather: WeatherCtl | null; clouds: readonly Cloud[]; fog: number; paint: string | null }): void {
    this.water = { ...(saved.water ?? DEFAULT_WATER) };
    this.weather = saved.weather ? { ...saved.weather } : null;
    this.clouds = saved.clouds.map((c) => ({ ...c }));
    this.fog = saved.fog;
    this.paint = saved.paint ?? DEFAULT_PAINT;
  }
}

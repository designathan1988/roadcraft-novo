// The map's extra description saved with it (meta.extra, JSON): hand-set weather and water, clouds, fog,
// transit terminals, sign texts, street names, clock, road paint and unlimited money. ONE codec for the writer
// (app/session.ts) and the reader (opening a map): each field is read and checked on its own, so one bad or missing
// field falls back to its default alone and never takes the others with it (before: one cast, one catch for all).

export interface ExtraWeather { rain: number; wind: number; dir: number; lightning: number; thunder: number }
export interface ExtraWater { waves: number; foam: number; current: number }
export interface ExtraCloud { x: number; z: number; y: number; size: number; density: number }

export interface MapExtra {
  weather: ExtraWeather | null;
  water: ExtraWater | null;
  clouds: ExtraCloud[];
  fog: number;
  terminals: number[];
  signs: Array<[string, string]>;
  streets: Array<[number, string]>;
  clock: number;
  paint: string | null;
  unlimited: boolean | null;
}

export function encodeExtra(x: MapExtra): string { return JSON.stringify(x); }

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const isNums = (o: unknown, keys: readonly string[]): boolean =>
  !!o && typeof o === 'object' && keys.every((k) => typeof (o as Record<string, unknown>)[k] === 'number');

/** The extra of a map file; anything absent or malformed comes back as its default, field by field. */
export function decodeExtra(text: string | undefined): MapExtra {
  let raw: Record<string, unknown> = {};
  if (text) { try { const v = JSON.parse(text) as unknown; if (v && typeof v === 'object') raw = v as Record<string, unknown>; } catch { /* not JSON: every field its default */ } }
  const list = (k: string): unknown[] => (Array.isArray(raw[k]) ? raw[k] as unknown[] : []);
  return {
    weather: isNums(raw.weather, ['rain', 'wind', 'dir', 'lightning', 'thunder']) ? raw.weather as ExtraWeather : null,
    water: isNums(raw.water, ['waves', 'foam', 'current']) ? raw.water as ExtraWater : null,
    clouds: list('clouds').filter((c) => isNums(c, ['x', 'z', 'y', 'size', 'density'])) as ExtraCloud[],
    fog: num(raw.fog, 1),
    terminals: list('terminals').filter((v) => typeof v === 'number') as number[],
    signs: list('signs').filter((e) => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string') as Array<[string, string]>,
    streets: list('streets').filter((e) => Array.isArray(e) && typeof e[0] === 'number' && typeof e[1] === 'string') as Array<[number, string]>,
    clock: num(raw.clock, 0),
    paint: typeof raw.paint === 'string' ? raw.paint : null,
    unlimited: typeof raw.unlimited === 'boolean' ? raw.unlimited : null,
  };
}

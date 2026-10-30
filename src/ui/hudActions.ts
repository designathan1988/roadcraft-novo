// The interface between the interface and the game, in a type-only module: drawers/hud/keys do not import
// each other for it.
import type { LaneChoice, ParkingPreset } from '../roads/roadVariant.ts';
import type { PersonOptions } from '../shared/contracts/people.ts';
import type { creatorCatalog } from '../render/people/creator.ts';
import type { WeatherCtl } from '../world/mapLook.ts';
export interface RoadKeys { roadUp: string; roadDown: string; roadAlign: string }

export type Category = 'roads' | 'zones' | 'build' | 'landscape' | 'transit' | 'demolish' | 'info';
export type Tool = 'camera' | 'inspect' | 'road' | 'curve' | 'roundabout' | 'upgrade' | 'blocks' | 'free' | 'move' | 'split' | 'bulldoze' | 'zone' | 'building' | 'transit' | 'streetscape' | 'barrier' | 'raise' | 'lower' | 'smooth' | 'flatten' | 'paint' | 'forest' | 'river' | 'weather' | 'landform' | 'elements' | 'sky' | 'person' | 'pistol' | 'bomb';
/** Terrain brushes. */
export const TERRAIN_TOOLS: Tool[] = ['raise', 'lower', 'smooth', 'flatten', 'landform'];
/** Ground brushes (they share the radius). */
export const GROUND_TOOLS: Tool[] = ['paint', 'forest', 'elements'];
export const ROAD_TOOLS: Tool[] = ['road', 'curve', 'free', 'roundabout', 'upgrade', 'blocks', 'move', 'split', 'bulldoze'];
/** Always day, always night, or the light following the clock (the player's choice, kept between games). */
export type SkyMode = 'day' | 'night' | 'cycle';
export interface SkyToolState { cloud: 'none' | 'add' | 'move' | 'edit' | 'remove'; fog: 'none' | 'lay' | 'erase'; size: number; base: number; density: number; fogHeight: number }
export type { WeatherCtl };
export type LotMode = 'edit' | 'rect' | 'poly' | 'split' | 'join' | 'delete' | 'front' | 'corner';
/** The simulation's settings the Simulation panel changes. */
export interface SimSettings { traffic: number; people: number; demand: 'baixa' | 'normal' | 'pico' }
/** The city's numbers for the top bar and the Simulation panel (counters the engine already keeps). */
export interface CityStatus {
  cars: number; peds: number; residents: number; jobs: number; buildings: number;
  speedKmh: number; tripsPerMin: number; lostPerMin: number; stopped: number; roads: number; nodes: number;
  /** Junctions that cannot be built (two roads under 25°). */
  impossible: number;
}

/** Capabilities other fronts publish in Game.hudActions (the gameplay front's src/tools/featureActions.ts). */
export interface OptionalActions {
  roadOptions?(): { lanes: LaneChoice | null; width: number | null; parking: ParkingPreset | null; ownLanes: number; ownWidth: number; base: number };
  roadLanes?(c: LaneChoice | null): void;
  roadWidth?(m: number | null): void;
  roadParking?(p: ParkingPreset | null): void;
  roadClasses?(): Array<[number, string]>;
  lotLine?(): void;
  lotCurve?(): void;
  lotExtraOff?(): void;
  renovate?(): void;
  decayOf?(): number;
  addressOf?(): string;
  streetNameAt?(x: number, z: number): string;
  lineColor?(color: number): void;
  lineLoop?(loop: boolean): void;
  showImpossible?(): void;
  healthLevel?(): string;
  personOptions?(o: Partial<PersonOptions>): void;
  peopleCatalog?(): ReturnType<typeof creatorCatalog> | null;
}

/** The lot tool's state as the panels show it (its owner: app/lotEditing.ts). */
export interface LotToolView {
  readonly lotMode: LotMode;
  /** Split by line or curve side under way, or none. */
  readonly lotExtra: 'line' | 'curve' | null;
  readonly splitKind: 'side' | 'depth';
  readonly splitParts: number;
  readonly lotUse: number;
  /** Style (−1: by neighbourhood) and function of the next lot drawn or built. */
  readonly newArch: number;
  readonly newFn: number;
}

/** What the HUD reads from the state owners (the tool in hand, the camera mode, the lot tool). */
export interface HudReads {
  tool(): Tool;
  view(): 'persp' | 'iso';
  lots(): LotToolView;
}

export interface HudActions extends OptionalActions {
  tool(t: Tool): void;
  radius(r: number): void;
  strength(s: number): void;
  profile(p: number): void;
  zone(z: number): void;
  zoneRadius(r: number): void;
  floors(delta: number): void;
  /** Architecture style (−1 = automatic by neighbourhood). */
  style(arch: number): void;
  buildingFn(fn: number): void;
  lotMode(mode: LotMode): void;
  lotSplit(kind: 'side' | 'depth', parts: number): void;
  zoneFill(block: boolean): void;
  lotUse(zone: number): void;
  demolishBuilding(): void;
  inside(cmd: 'toggle' | 'up' | 'down'): void;
  elevation(delta: number): void;
  roadSnap(mode: number): void;
  cutWalls(on: boolean): void;
  blocks(b: { cols: number; rows: number; size: number; angle: number }): void;
  undo(): void;
  redo(): void;
  view(v: 'persp' | 'iso' | 'top'): void;
  save(): void;
  load(): void;
  exportMap(): void;
  importMap(file: File): void;
  newMap(): void;
  testCity(): void;
  generate(): void;
  startScreen(): void;
  options(): void;
  help(): void;
  trafficView(): void;
  follow(): void;
  grid(): void;
  north(): void;
  line(id: number): void;
  newLine(): void;
  lineMode(mode: number): void;
  buses(delta: number): void;
  deleteLine(): void;
  item(kind: number): void;
  signType(kind: number): void;
  signText(text: string): void;
  barrierKind(kind: number): void;
  groundKind(kind: number): void;
  forestMode(cut: boolean): void;
  forestSpecies(species: number): void;
  forestOne(one: boolean): void;
  poleLights(mode: number): void;
  biome(b: number): void;
  riverWidth(w: number): void;
  landform(mode: string): void;
  elements(e: { kind: number; mode: 'lay' | 'eraseKind' | 'eraseAll'; density: number; size: number }): void;
  flattenMap(): void;
  weather(w: WeatherCtl | null): void;
  sky(mode: SkyMode): void;
  water(w: { waves: number; foam: number; current: number }): void;
  skyTool(s: SkyToolState): void;
  scatterClouds(count: number, variation: number): void;
  clearClouds(): void;
  fogLevel(v: number): void;
  personSpec(p: { color: number; height: number; walk: boolean; count: number }): void;
  bombForce(f: number): void;
  roadKeys(patch: Partial<RoadKeys>): void;
  speed(n: number): void;
  orbit(dx: number, dy: number): void;
  turn(dir: number): void;
  tilt(dir: number): void;
  zoneLayer(on: boolean): void;
  simulation(s: Partial<SimSettings>): void;
  settings(): SimSettings & { paint: string; furniture: number; roadUp: string; roadDown: string; roadAlign: string; preset: string; webgpu: boolean };
  quality(preset: string): void;
  resetView(): void;
  /** The map's road paint ('br', 'us', 'eu', 'classic'): an undoable edit of the map, saved with it. */
  paint(style: string): void;
  furniture(n: number): void;
  ring(f: number): void;
  terminal(on: boolean): void;
  health(): void;
  developer(): boolean;
  environment(): { water: { waves: number; foam: number; current: number }; weather: WeatherCtl | null; fog: number };
  itemRemove(on: boolean): void;
  cameraNumbers(): { zoom: number; x: number; z: number };
}

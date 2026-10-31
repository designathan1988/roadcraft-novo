// The game's one public automation surface (audit §13.6, plan P5): what photo scripts, in-game checks, the probe and
// the desktop shell may read and drive. Published as `window.__roadcraft`; the Game itself is not published. Every
// member delegates to the state's owner (no state is kept here); the world is read through it, and changes go through
// the script API's actions (one undo step each), the HUD's actions or the owners' public setters.
// The contract is versioned: a member is added in a new version, never changed in place (test/automation.test.ts).
import type * as THREE from 'three/webgpu';
import type { LifeState, Lifecycle } from './lifecycle.ts';
import type { ScriptApi } from './scriptApi.ts';
import type { HudActions, LotToolView, SkyMode, Tool } from '../ui/hudActions.ts';
import type { Settings } from '../platform/settings.ts';
import type { World } from '../world/world.ts';
import type { GpuTiming } from '../render/gpuTiming.ts';
import type { FrameProfile } from './frameProfile.ts';
import type { LaneChoice, ParkingPreset } from '../roads/roadVariant.ts';
import type { FromSim, ToSim } from '../sim/worker.ts';
import type { PoseReader } from '../shared/contracts/poses.ts';
import type { Line } from '../world/transit.ts';
import type { PropsProbe } from '../render/propsProbe.ts';
import type { FileStore } from '../platform/saveFiles.ts';
import type { Design } from '../world/design.ts';
import type { BuilderTab, BuilderTabRender } from '../ui/drawers.ts';

/** The camera as a script sees it. */
export interface CameraPose {
  /** The point looked at (y: its height). */
  x: number; y: number; z: number; yaw: number; pitch: number; dist: number;
  /** The turn still to come of an animated turn (yaw + turning is where the camera settles). */
  turning: number;
  mode: 'persp' | 'iso';
  eye: { x: number; y: number; z: number };
}

/** The tools' options as the panels set them (a read: the panels' actions change them). */
export interface ToolOptions {
  road: { mode: Tool; profile: number; base: number; lanes: LaneChoice | null; width: number | null; parking: ParkingPreset | null; elevation: number; ringRadius: number; snap: number; furniture: number; cutWalls: boolean; blocks: { cols: number; rows: number; size: number; angle: number } };
  zone: { zone: number; radius: number };
  brush: { mode: string; radius: number; strength: number };
  items: { poleLights: number; /** A wall is being traced (its first point is down). */ wallOpen: boolean };
  lots: LotToolView;
  /** Points clicked so far of a lot line or curve being drawn. */
  lotPoints: number;
}

/** What the page gives before any game exists: the lifecycle (it says Failed even when the game never started) and the language. */
export interface AutomationPage {
  readonly life: Pick<Lifecycle, 'state' | 'whenIdle' | 'unsaved'>;
  setLang(lang: string): void;
  lang(): string;
  t(key: string): string;
}

/** What the automation reads and drives, given by the Game (its owners, never copies). */
export interface AutomationHost {
  readonly world: World;
  readonly actions: ScriptApi;
  readonly ui: HudActions;
  view(x: number, z: number, yaw: number, pitch: number, dist: number, hour?: number): Promise<void>;
  pose(): CameraPose;
  place(p: { yaw?: number; pitch?: number; dist?: number }): void;
  pick(fx: number, fy: number): THREE.Vector3 | null;
  /** Where a world point is on the page (client pixels), for real pointer gestures; null behind the camera. */
  toScreen(x: number, y: number, z: number): { x: number; y: number } | null;
  settle(frames: number): Promise<void>;
  stats(): Record<string, number>;
  /** stats() plus the triangles the GPU drew (trisDrawn, D81). */
  drawnStats(): Promise<Record<string, number>>;
  gpu(): GpuTiming | null;
  /** The frame's time per system (?perf only, else null). */
  profile(): FrameProfile | null;
  tool(): Tool;
  /** A click of the tool in hand at (x, z) on the ground, through the same dispatch as the pointer's release. */
  click(x: number, z: number, shift: boolean, alt: boolean): void;
  toolOptions(): ToolOptions;
  options(): Readonly<Settings>;
  applyOptions(p: Partial<Settings>): Promise<void>;
  hour(): number;
  skyMode(): SkyMode;
  simStats(): Readonly<Record<string, unknown>> | null;
  /** The simulation worker's answer to an inspect message (vehicles, clashes and people round (x, z)). */
  simInspect(x: number, z: number, r: number): Promise<Extract<FromSim, { type: 'inspect' }>>;
  /** A message of the simulation protocol (checks send a change the worker cannot apply, to see the page resync). */
  simPost(msg: ToSim): void;
  /** The poses the page draws (vehicles and people, written by the simulation). */
  poses(): Readonly<PoseReader>;
  lines(): readonly Readonly<Line>[];
  propsProbe(): PropsProbe;
  sun(): { x: number; y: number; z: number };
  framesDrawn(): number;
  toast(text: string): void;
  following(): boolean;
  followAt(x: number, z: number, r: number): boolean;
  peopleReady(): boolean;
  growthRate(r?: number): number;
  signals(): Uint8Array;
  saveStore(): Promise<FileStore>;
  demolitionDrawn(): number;
  selected(): number;
  design(d: Design | null, floors?: number): void;
  peopleGroups(): number | null;
  hitKind(): 'pistol' | 'bomb' | null;
  bombForce(): number;
  boltShown(): boolean;
  layers(): Readonly<{ grid: boolean; zones: boolean; traffic: boolean }>;
  insideOn(): boolean;
  clouds(): number;
  terminals(): readonly number[];
  autosaveNow(): void;
  demandSentAt(): number;
  setHour(h: number): void;
  weather(): Readonly<{ clouds: number; rain: number; storm: number; wind: number | null }>;
  inspector(): { open: boolean; seg: number };
  insideId(): number;
  audioStart(): void;
  audioState(): AudioContextState | 'none';
  green(): number;
  previewShown(): boolean;
  registerBuilderTab(id: BuilderTab, render: BuilderTabRender): void;
  freeLots(): Promise<Array<[number, number]>>;
  lastPeople(): Readonly<{ count?: number; mode?: string }> | null;
  setTool(t: Tool): void;
  select(id: number): void;
  inspect(x: number, z: number): void;
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  save(quiet: boolean): Promise<boolean>;
  load(): Promise<boolean>;
  importMap(file: Blob): Promise<void>;
  newMap(seed?: number): Promise<void>;
  generated(medium: boolean): Promise<void>;
  testCity(): Promise<void>;
  paused(): boolean;
  togglePause(): void;
  speed(n: number): void;
}

/** Version 1 of the automation contract. */
export interface CityAutomation {
  readonly version: 1;
  /** The lifecycle's state (the desktop shell and the checks wait for 'ready'). */
  readonly status: LifeState;
  setLang(lang: string): void;
  /** The interface's language now (pt-BR, en). */
  lang(): string;
  t(key: string): string;
  readonly lifecycle: { state(): LifeState; whenIdle(ms: number): Promise<boolean>; unsaved(): boolean };
  readonly camera: {
    view(x: number, z: number, yaw: number, pitch: number, dist: number, hour?: number): Promise<void>;
    pose(): CameraPose;
    place(p: { yaw?: number; pitch?: number; dist?: number }): void;
    pick(fx: number, fy: number): THREE.Vector3 | null;
    toScreen(x: number, y: number, z: number): { x: number; y: number } | null;
    /** The camera follows a vehicle. */
    following(): boolean;
    /** Follows the vehicle nearest (x, z) within r m, as the player picks one; false: none there. */
    followAt(x: number, z: number, r: number): boolean;
  };
  /** The people drawn (the crowd's models are loaded). */
  readonly people: {
    ready(): boolean; /** Groups the people creator holds (null before it loads). */ groups(): number | null;
    /** The last group placed: its count and mode. */ last(): Readonly<{ count?: number; mode?: string }> | null;
  };
  /** The game's own tools for play (pistol, bomb): what the last shot hit, waiting for the simulation, and the force. */
  readonly demo: { hitKind(): 'pistol' | 'bomb' | null; force(): number };
  readonly frames: { settle(frames: number): Promise<void>; stats(): Record<string, number>; drawnStats(): Promise<Record<string, number>>; gpu(): GpuTiming | null; profile(): FrameProfile | null;
    /** Frames drawn since the game started (a still or hidden frame draws nothing). */
    drawn(): number;
  };
  /** The world, read (its tables, queries and indexes); changes go through `actions`. */
  readonly world: World;
  /** The tools' actions (one undo step each). */
  readonly actions: ScriptApi;
  readonly history: { undo(): boolean; redo(): boolean; canUndo(): boolean };
  readonly tools: {
    current(): Tool; set(t: Tool): void; select(id: number): void; inspect(x: number, z: number): void;
    /** The inspector panel: open, and the road it shows (-1: none). */
    inspector(): { open: boolean; seg: number };
    click(x: number, z: number, keys?: { shift?: boolean; alt?: boolean }): void;
    options(): ToolOptions;
    /** The building selected (-1: none). */
    selected(): number;
    /** The building Creator's design applied to the selected building (the panel's own action). */
    design(d: Design | null, floors?: number): void;
  };
  /** The player's options (Options panel): read, and applied as the panel applies them. */
  readonly options: { get(): Readonly<Settings>; apply(p: Partial<Settings>): Promise<void> };
  /** The time of day and the sky mode. */
  readonly sky: {
    hour(): number; mode(): SkyMode; /** Clouds placed in the sky. */ clouds(): number;
    /** Sets the time of day; the clock keeps running at its speed (a held hour stays held). */
    setHour(h: number): void;
    /** The weather as drawn: cloud cover, rain, storm (0..1) and the wind held by hand (0..1; null: it varies). */
    weather(): Readonly<{ clouds: number; rain: number; storm: number; wind: number | null }>;
  };
  /** The view's modes: the map layers shown, the camera inside a building. */
  readonly view: { layers(): Readonly<{ grid: boolean; zones: boolean; traffic: boolean }>; inside(): boolean; /** The building seen inside (-1: none). */ insideId(): number };
  /** The game's sound: started by the first input, its context's state, how much nature it hears (birds: 0..1). */
  readonly audio: { start(): void; state(): AudioContextState | 'none'; green(): number };
  /** The panels' extension point: a tab of the Build drawer drawn by its own code (the buildings session). */
  readonly panels: { registerBuilderTab(id: BuilderTab, render: BuilderTabRender): void };
  /** The HUD's actions (what the panels do). */
  readonly ui: HudActions;
  readonly saves: {
    save(quiet?: boolean): Promise<boolean>; load(): Promise<boolean>; importMap(file: Blob): Promise<void>;
    /** A new empty map: from `seed` when given (the same terrain again), else a random one. */
    newMap(seed?: number): Promise<void>;
    /** Where saves are written (browser private files or the desktop folders): the storage checks read and fail it. */
    store(): Promise<FileStore>;
    /** The autosave's 2-minute timer runs out now: the next frame saves if anything is unsaved. */
    autosaveNow(): void;
  };
  readonly cities: {
    generated(medium?: boolean): Promise<void>; testCity(): Promise<void>;
    /** How fast lots fill (0 holds the city as it is: photos and checks of a fixed scene); returns the rate in force. */
    growthRate(r?: number): number;
    /** The free lots (no building on them) once the lots are made: waits for the lot jobs of the zoned roads. */
    freeLots(): Promise<Array<[number, number]>>;
  };
  readonly sim: {
    paused(): boolean; togglePause(): void; speed(n: number): void; stats(): Readonly<Record<string, unknown>> | null;
    inspect(x: number, z: number, r: number): Promise<Extract<FromSim, { type: 'inspect' }>>;
    post(msg: ToSim): void;
    poses(): Readonly<PoseReader>;
    /** The traffic lights' states as the simulation writes them (one byte per node). */
    signals(): Uint8Array;
    /** When the page last sent the traffic demand to the simulation (ms, page clock; 0 = it is due again). */
    demandSentAt(): number;
  };
  /** Public transport, read (lines are drawn with the transit tool, R.actions.line). */
  readonly transit: { lines(): readonly Readonly<Line>[]; /** Stops marked as terminals (flat x, z pairs). */ terminals(): readonly number[] };
  /** Render inspection for the GPU checks (what a Node test cannot reach): the props layer and the sun. */
  /** A notice in the toast stack, as the game shows its own (photos of the stack). */
  readonly notices: { show(text: string): void };
  readonly render: {
    props(): PropsProbe; sun(): { x: number; y: number; z: number };
    /** The demolition's parts drawn now (wrecks, thrown debris, craters, soot): meshes shown with instances. */
    demolition(): number;
    /** A lightning bolt is drawn. */
    bolt(): boolean;
    /** The road or lot preview (a line from the first click) is drawn. */
    preview(): boolean;
  };
}

/** The contract over the page and the game it runs (null before the game starts or when it failed to). */
export function createAutomation(page: AutomationPage, game: () => AutomationHost | null): CityAutomation {
  const g = (): AutomationHost => {
    const h = game();
    if (!h) throw new Error('the game is not running (lifecycle ' + page.life.state + ')');
    return h;
  };
  return {
    version: 1,
    get status() { return page.life.state; },
    setLang: (lang) => page.setLang(lang),
    lang: () => page.lang(),
    t: (key) => page.t(key),
    lifecycle: { state: () => page.life.state, whenIdle: (ms) => page.life.whenIdle(ms), unsaved: () => page.life.unsaved },
    camera: {
      view: (x, z, yaw, pitch, dist, hour) => g().view(x, z, yaw, pitch, dist, hour),
      pose: () => g().pose(),
      place: (p) => g().place(p),
      pick: (fx, fy) => g().pick(fx, fy),
      toScreen: (x, y, z) => g().toScreen(x, y, z),
      following: () => g().following(), followAt: (x, z, r) => g().followAt(x, z, r),
    },
    frames: { settle: (n) => g().settle(n), stats: () => g().stats(), drawnStats: () => g().drawnStats(), gpu: () => g().gpu(), profile: () => g().profile(), drawn: () => g().framesDrawn() },
    get world() { return g().world; },
    get actions() { return g().actions; },
    history: { undo: () => g().undo(), redo: () => g().redo(), canUndo: () => g().canUndo() },
    tools: {
      current: () => g().tool(), set: (t) => g().setTool(t), select: (id) => g().select(id), inspect: (x, z) => g().inspect(x, z),
      click: (x, z, keys = {}) => g().click(x, z, !!keys.shift, !!keys.alt), options: () => g().toolOptions(),
      selected: () => g().selected(), design: (d, floors) => g().design(d, floors), inspector: () => g().inspector(),
    },
    options: { get: () => g().options(), apply: (p) => g().applyOptions(p) },
    sky: { hour: () => g().hour(), mode: () => g().skyMode(), clouds: () => g().clouds(), setHour: (h) => g().setHour(h), weather: () => g().weather() },
    view: { layers: () => g().layers(), inside: () => g().insideOn(), insideId: () => g().insideId() },
    audio: { start: () => g().audioStart(), state: () => g().audioState(), green: () => g().green() },
    panels: { registerBuilderTab: (id, render) => g().registerBuilderTab(id, render) },
    get ui() { return g().ui; },
    saves: { save: (quiet = false) => g().save(quiet), load: () => g().load(), importMap: (f) => g().importMap(f), newMap: (seed) => g().newMap(seed), store: () => g().saveStore(), autosaveNow: () => g().autosaveNow() },
    cities: { generated: (medium = false) => g().generated(medium), testCity: () => g().testCity(), growthRate: (r) => g().growthRate(r), freeLots: () => g().freeLots() },
    people: { ready: () => g().peopleReady(), groups: () => g().peopleGroups(), last: () => g().lastPeople() },
    demo: { hitKind: () => g().hitKind(), force: () => g().bombForce() },
    sim: { paused: () => g().paused(), togglePause: () => g().togglePause(), speed: (n) => g().speed(n), stats: () => g().simStats(),
      inspect: (x, z, r) => g().simInspect(x, z, r), post: (m) => g().simPost(m), poses: () => g().poses(), signals: () => g().signals(), demandSentAt: () => g().demandSentAt() },
    transit: { lines: () => g().lines(), terminals: () => g().terminals() },
    notices: { show: (text) => g().toast(text) },
    render: { props: () => g().propsProbe(), sun: () => g().sun(), demolition: () => g().demolitionDrawn(), bolt: () => g().boltShown(), preview: () => g().previewShown() },
  };
}

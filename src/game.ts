// Ties everything together: world, workers, camera, rendering, tools, saving and loading.
// The page only does input, interface, choosing what to draw, and drawing.

import { createTerrainSeams } from './render/terrainSeams.ts';
import * as THREE from 'three/webgpu';
import { MAP_SIZE, MAP_SIZES, MAP_TAG, MAP_TILES, TILE_SIZE } from './config.ts';

import { CommandStack } from './core/commands.ts';
import { CELL_COUNT, Dirty, TILE_COUNT, tileOfCell, tileOriginX } from './core/grid.ts';
import { JobPool } from './jobs/pool.ts';
import { wallsHeightOf } from './jobs/buildingGen.ts';
import { roadGraphTransfer } from './shared/contracts/worker.ts';
import { CameraRig } from './render/cameraRig.ts';
import { createCity, createCityDetail } from './render/city.ts';
import { createRoads, createTrafficLook, type TrafficLook } from './render/roads.ts';
import type { CellLayer } from './render/cellLayer.ts';
import { createScene, setTimeOfDay, type SceneParts } from './render/scene.ts';
import { GpuTiming } from './render/gpuTiming.ts';
import { TerrainRenderer } from './render/terrain.ts';
import { createPoseBuffers, PoseReader, viewPoseBuffers } from './shared/contracts/poses.ts';
import { VehicleRenderer } from './render/vehicles.ts';
import type { PersonOptions } from './shared/contracts/people.ts';
import { PropRenderer } from './render/props.ts';
import { TransitRenderer } from './render/transit.ts';
import { Post } from './render/post.ts';
import { achieve } from './platform/steam.ts';
import { OptionsPanel } from './ui/options.ts';
import { PRESETS, Preferences, type Preset, type Settings } from './platform/settings.ts';
import { readStored } from './shared/storage.ts';
import { StartMenu } from './ui/menu.ts';
import { Weather, cloudsU, flashU, rainU, windU } from './render/weather.ts';
import { Ambient } from './platform/audio.ts';
import { Particles } from './render/particles.ts';
import { fmtInt, onLanguageChange, plural, t } from './shared/i18n/index.ts';
import { HealthPanel } from './ui/health.ts';
import { Creator } from './ui/creator.ts';
import type { Design } from './world/design.ts';
import { nightU } from './render/scene.ts';
import { Transit } from './world/transit.ts';
import { PROFILES, customProfiles, onProfileAdded } from './roads/profiles.ts';
import { LaneArrows } from './features/roads/laneArrows.ts';
import type { FromSim, ToSim } from './sim/worker.ts';
import { Inspector } from './ui/inspector.ts';
import { BOMB_START } from './shared/contracts/bomb.ts';
import { Demolition } from './features/demolition/demolition.ts';
import { zoomPercent } from './ui/readouts.ts';
import { ItemTool } from './features/streetscape/itemTool.ts';
import { Hud, type HudActions, type LotMode, type SkyMode, type Tool } from './ui/hud.ts';
import { GROUND_TOOLS, ROAD_TOOLS, TERRAIN_TOOLS } from './ui/hudActions.ts';
import { Clouds } from './features/sky/clouds.ts';
import { RiverTool } from './features/terrain/riverTool.ts';
import { TransitTool } from './features/transit/transitTool.ts';
import type { MapExtra } from './platform/mapExtra.ts';
import { SaveFlow } from './app/saveFlow.ts';
import { CityFlows } from './app/cityFlows.ts';
import { insertBoxes } from './app/insertBoxes.ts';
import { WeatherControl } from './features/sky/weatherControl.ts';
import { WaterControl } from './features/water/waterControl.ts';
import { FogControl } from './features/sky/fogControl.ts';
import { ViewState } from './app/viewState.ts';
import { chooseRoadPaint, showRoadPaint } from './features/roads/roadPaint.ts';
import { InsideView } from './render/inside.ts';
import { TextSigns, signKey } from './render/textSigns.ts';
import type { FeatureActions, LotFeatureActions } from './app/featureActions.ts';
import { nameStreetCommand } from './roads/streetNames.ts';
import { laneCount, roadClasses } from './roads/roadVariant.ts';
import { Ground, GroundStroke, WATER_MAP_RES, waterCoord, waterIndex } from './world/ground.ts';
import { ElementStroke, Item, ItemsCommand } from './world/items.ts';
import { RoadTool } from './features/roads/roadTool.ts';
import { ZoneTool } from './features/zones/zoneTool.ts';
import { Growth } from './world/growth.ts';
import { streetChain, demolishSeg, segPreview } from './roads/build.ts';
import { RoadPreview } from './render/preview.ts';
import { BrushStroke, FlattenMap, LANDFORM_ROCK, type BrushMode, type BrushParams } from './world/brush.ts';
import { World } from './world/world.ts';
import { heightAt } from './world/heights.ts';
import { type SaveActions } from './platform/mapFile.ts';
import { photoView, settlePool } from './app/photoHooks.ts';
import { reloadWithMap } from './app/session.ts';
import { ToolState, skyHint as skyHintOf, type ToolHost } from './app/tools.ts';
import { createScriptApi, type ScriptApi } from './app/scriptApi.ts';
import { FrameProfile, PART } from './app/frameProfile.ts';
import type { AutomationHost } from './app/automation.ts';
import type { Lifecycle, Operation } from './app/lifecycle.ts';
import { Clock } from './app/clock.ts';
import { clickTool, type ClickHost } from './app/clicks.ts';
import { selectBuilding, showSelection as showSelectionOf, type SelectionHost } from './app/buildings.ts';
import { LotEditing } from './app/lotEditing.ts';
import { Gesture, bindInput, type InputControl } from './app/input.ts';
import type { SegId } from './core/ids.ts';
import { signTextCommand } from './features/streetscape/signText.ts';
import { SimLink } from './app/simLink.ts';

/** Still frames drawn before the loop rests (the temporal anti-aliasing converges in about this many). */
const STILL_FRAMES = 40;
/** Segments that fit in the occupancy map (2 directions per segment). */
export const OCCUPANCY_SEGS = 1 << 17;


/** The hours "always day" and "always night" light the city at (Roadcraft 4.0 render/renderer.ts:3876: 16:00 and 22:00). */
const DAY_LIGHT = 16, NIGHT_LIGHT = 22;

export class Game {
  readonly world = new World();
  readonly pool: JobPool;
  readonly commands = new CommandStack();
  readonly hud: Hud;
  /** The panel button actions (test scripts call the same thing the button does). */
  hudActions!: HudActions & FeatureActions & SaveActions;
  /** Measurement (?perf): where the time of slow frames went. */
  perfLog: string[] | null = null;
  /** The frame's time per system (?perf; read by the probe through the automation contract). */
  private profile: FrameProfile | null = null;
  /** Frames that drew (still and hidden frames do not): the idle checks read it. */
  private framesDrawn = 0;
  /** Measurement (?perf): GPU time per render call (tools/probe.mjs reads it). */
  gpuTiming: GpuTiming | null = null;
  private parts!: SceneParts;
  private rig: CameraRig;
  private terrain: TerrainRenderer;
  private city: CellLayer;
  private cityDetail: CellLayer;
  private roads: CellLayer;
  /** The terrain cut along the roads near the camera. */
  private seams: CellLayer;
  private layers: CellLayer[];
  private sim: Worker;
  private poses: PoseReader;
  private vehicles: VehicleRenderer;
  private props!: PropRenderer;
  private signalsSab = new SharedArrayBuffer(1 << 17);
  private simStats: FromSim | null = null;
  readonly transit = new Transit();
  private transitView = new TransitRenderer();
  private post: Post | null = null;
  private weather = new Weather();
  private ambient = new Ambient();
  private particles!: Particles;
  /** The player's preferences (platform/settings.ts): read through `settings`, changed only through `prefs.update`. */
  private prefs: Preferences | null = null;
  private get settings(): Readonly<Settings> { return this.prefs!.now; }
  private optionsPanel!: OptionsPanel;
  /** Simulation speed (1, 2, 4), the zone colours shown with any tool, stops clicked as terminals. */
  private transitTerminal = false;
  /** Clicks with the street item tools remove instead of placing (Remove poles; Shift+click does the same). */
  private itemRemove = false;
  private health!: HealthPanel;
  /** The developer panels (F8, F9, the worst case test): ?dev, roadcraft.dev = 1 in the browser's storage, or the dev server. */
  private readonly developer = ((): boolean => {
    let stored = false;
    stored = readStored('developer') === '1';
    return stored || new URLSearchParams(location.search).has('dev') || !!(import.meta as { env?: { DEV?: boolean } }).env?.DEV;
  })();
  /** The latest edits (the health panel's World tab): when, what. */
  private changesLog: Array<[number, string]> = [];
  /** The view the city opened with (Home goes back to it). */
  private homeView: Float64Array | null = null;
  private creator!: Creator;
  private occupancySab: SharedArrayBuffer;
  private trafficLook: TrafficLook;
  private occSent = 0;
  /** The page's link to the simulation worker (app/simLink.ts). */
  private simLink!: SimLink;
  /** Nodes whose hand-adjusted arrows need to be recomputed. */
  /** The arrows of hand-adjusted lane connections (features/roads/laneArrows.ts). */
  private laneArrows!: LaneArrows;
  /** Doors sent to the simulation: when, and from where (the camera moving or the city growing sends them again). */
  private canvas: HTMLCanvasElement;

  /** The tool in hand and the landform it raises (app/tools.ts). */
  private readonly tools = new ToolState();
  private get tool(): Tool { return this.tools.current; }
  private brush: BrushParams = { mode: 'raise', radius: 60, strength: 0.4 };
  private stroke: BrushStroke | GroundStroke | null = null;
  /** Chosen landform and the rock painted along with it. */
  private rockStroke: GroundStroke | null = null;
  /** Ground elements brush. */
  private elem = { kind: 30, mode: 'lay' as 'lay' | 'eraseKind' | 'eraseAll', density: 8, size: 7 };
  private elemStroke: ElementStroke | null = null;
  private groundKind: number = Ground.Sand;
  private forestCut = false;
  private forestSpecies = 0;
  /** Trees: one per click instead of the brush. */
  private forestOne = false;
  private pointer = { x: 0, y: 0, inside: false };
  /** The pointer gesture under way (app/input.ts drives it): none until the input is bound, and while nothing is dragged. */
  private readonly gesture = new Gesture();
  /** The page's input, bound once the parts it drives exist (the first tool is set before: there is no gesture yet to leave). */
  private input: InputControl | null = null;
  private roadTool: RoadTool;
  private inspector!: Inspector;
  private itemTool!: ItemTool;
  private zoneTool: ZoneTool;
  private growth: Growth;
  private selected = -1;
  /** Hand-drawn lot: points clicked so far (null = not in this mode). */
  /** Lot tool and its states (polygon, first lot of a join, dragged corner). */
  private zoneBlock = false;
  private preview = new RoadPreview();
  /** Lot and building editing (app/lotEditing.ts). */
  private readonly editing: LotEditing;
  private last = 0;
  /** Time of day and clock speed (game hours per real minute). */
  /** The time of day: the World's (one clock with the city's, as Roadcraft 4.0). */
  private get hour(): number { return this.world.hour; }
  /** Chosen sky and weather set by the player (both go into the save). */
  /** ?hour (photos at a set hour) follows the clock for this run without changing the player's choice. */
  private skyForRun: SkyMode | null = null;
  /** The sky mode: the player's choice, always day unless chosen otherwise (Roadcraft 4.0 main.ts:2292-2303). */
  private get skyMode(): SkyMode { return this.skyForRun ?? this.prefs?.now.sky ?? 'day'; }
  /** Clouds placed by the player and the state of the Sky tool. */
  /** Inside view: the building and the floor shown. */
  private inside = new InsideView();
  private textSigns!: TextSigns;
  /** The bomb: explosion, breaking buildings and what it throws (features/demolition). */
  private demolition!: Demolition;
  private clouds!: Clouds;
  private saving!: SaveFlow;
  private cities!: CityFlows;
  private river!: RiverTool;
  private lines!: TransitTool;
  private sky!: WeatherControl;
  private water!: WaterControl;
  private fog!: FogControl;
  private shakeOffset = new THREE.Vector3();
  /** People from the creator and the bomb strength. */
  private personSpec = { color: 3, height: 7, walk: false, count: 1 };
  private bombForce = BOMB_START;
  private hitKind: 'pistol' | 'bomb' | null = null;
  /** What the player chose to see (layers, the building seen inside): app/viewState.ts. */
  private readonly viewState = new ViewState();
  /** The ambient sound's input, one object written each frame (no literal per frame). */
  private readonly ambientIn: Parameters<Ambient['update']>[1] = { rain: 0, wind: 0, traffic: 0, height: 0, day: 1, green: 0 };
  private insideFloor = 0;
  /** Loading, ready, an operation under way, or failed; and what changed since the last save (app/lifecycle.ts). */
  readonly life: Lifecycle;
  /** Something changed since the last save (autosave every 2 min): a change to the world, or the world just made or opened (false). */
  private get unsaved(): boolean { return this.life.unsaved; }
  private set unsaved(v: boolean) { if (v) this.life.changed(); else this.life.clean(); }
  private autosaveAt = 0;
  /** Pause and speed of the simulation and the time of day (app/clock.ts). */
  readonly clock = new Clock();

  constructor(canvas: HTMLCanvasElement, life: Lifecycle) {
    this.canvas = canvas;
    this.life = life;
    this.pool = new JobPool({ heights: this.world.heightsSab, ground: this.world.groundSab, water: this.world.waterSab });
    this.rig = new CameraRig(this.world.heights);
    // the features the page wires: each owns its state (sky, water, river tool)
    const gs = this;
    this.saving = new SaveFlow({
      world: this.world, pool: this.pool, rig: this.rig, transit: this.transit,
      get hud() { return gs.hud; },
      life,
      get hour() { return gs.hour; },
      clearForOpen: () => gs.clearPage(),
      applyExtra: (ex) => gs.applyExtra(ex),
      setHour: (h) => gs.world.setHour(h),
      setBiome: (b) => gs.setBiome(b),
      insertBoxes: (b) => insertBoxes(gs.world, b),
      resetCity: () => gs.cities.reset(),
      generateTerrain: () => gs.generateTerrain(),
      endRebuild: (err, what) => gs.endRebuild(err, what),
      discardOk: () => gs.discardOk(),
    });
    this.cities = new CityFlows({
      world: this.world, pool: this.pool,
      get hud() { return gs.hud; },
      life,
      clearPage: () => gs.clearPage(),
      forgetSlot: () => { gs.saving.slotBase = null; },
      generateTerrain: () => gs.generateTerrain(),
      grow: async () => { gs.growth.processDirty(); await gs.pool.whenIdle(); return gs.growth.fillAll(); },
      endRebuild: (err, what) => gs.endRebuild(err, what),
    });
    this.water = new WaterControl(this.world.look, () => { this.unsaved = true; });
    this.fog = new FogControl(this.world.look, () => { this.unsaved = true; });
    this.sky = new WeatherControl({ weather: this.weather, look: this.world.look, setThunder: (v) => { this.ambient.thunderVolume = v; }, option: () => this.prefs?.now.weather, changed: () => { this.unsaved = true; } });
    this.lines = new TransitTool({
      transit: this.transit, roads: this.world.roads, heights: this.world.heights, dirty: this.world.dirty, view: this.transitView,
      run: (cmd) => this.commands.run(cmd), toast: (text) => this.hud.toast(text),
      lineMade: () => achieve('PRIMEIRA_LINHA'), sendLines: (lines) => this.sim.postMessage({ type: 'lines', lines } satisfies ToSim),
      showLines: (rows, current) => this.hud.setLines(rows, current),
    });
    this.river = new RiverTool({ world: this.world, preview: this.preview, run: (cmd) => this.commands.run(cmd), toast: (text) => this.hud.toast(text) });
    this.clouds = new Clouds({
      heights: this.world.heights, look: this.world.look, run: (cmd) => this.commands.run(cmd), toast: (text) => this.hud.toast(text),
      changed: () => { this.unsaved = true; }, target: () => this.rig.target,
    });
    // the camera never enters a building (roadcraft): core of the lot (70% × 60%) up to the top given by the floors
    this.rig.solid = (x, z) => {
      const col = this.world.buildings.cols;
      let top = -Infinity;
      this.world.buildingIndex.query(x - 40, z - 40, x + 40, z + 40, (id) => {
        const dx = x - col.x[id], dz = z - col.z[id];
        const s = Math.sin(col.rot[id]), c = Math.cos(col.rot[id]);
        const lx = dx * c - dz * s, lz = dx * s + dz * c;
        if (Math.abs(lx) <= col.w[id] * 0.35 && Math.abs(lz) <= col.d[id] * 0.3) top = Math.max(top, heightAt(this.world.heights, col.x[id], col.z[id]) + 1.5 + wallsHeightOf(col, id));
      });
      return top;
    };
    this.terrain = new TerrainRenderer(this.world);
    this.city = createCity(this.world, this.pool);
    this.cityDetail = createCityDetail(this.world, this.pool, this.city.material);
    // per segment: occupancy a→b, b→a, asphalt wear (simulation), free
    this.occupancySab = new SharedArrayBuffer(OCCUPANCY_SEGS * 4);
    this.trafficLook = createTrafficLook(this.occupancySab);
    this.roads = createRoads(this.world.roads, this.pool, this.world.dirty, this.trafficLook, this.world.heights);
    // the terrain cut along the roads near the camera (render/terrainSeams.ts)
    this.seams = createTerrainSeams(this.world.roads, this.pool, this.world.dirty, this.terrain);
    this.layers = [this.roads, this.city, this.cityDetail, this.seams];
    // the near levels are chosen by the 3D distance (from high up the cells under the camera are far)
    for (const l of this.layers) l.groundAt = (x, z) => heightAt(this.world.heights, x, z);

    const posesSab = createPoseBuffers();
    this.poses = new PoseReader(viewPoseBuffers(posesSab));
    this.sim = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module', name: `sim ${MAP_TAG}` });
    this.sim.onmessage = (e: MessageEvent<FromSim>) => {
      this.profile?.simMessage();
      if (e.data.type === 'stats') this.trackTrips(e.data);
      else if (e.data.type === 'probe') this.inspector?.showProbe(e.data);
      else if (e.data.type === 'probeNode') this.inspector?.showNodeProbe(e.data);
      else if (e.data.type === 'hit') this.onHit(e.data.people, e.data.vehicles);
      else if (e.data.type === 'autoControl') this.world.roads.setFlow(e.data.node, e.data.flow);
      else if (e.data.type === 'manoeuvres') { const r = this.manoeuvreWait; this.manoeuvreWait = null; r?.(e.data); }
      else if (e.data.type === 'resync') this.simLink.resync(e.data.reason);
      else if (e.data.type === 'inspect') { /* read by the motion probe's own listener (tools/check-sim.mjs) */ }
      else { console.error('simulation:', e.data.message); this.health?.add('error', t('health.msg.simulation', { message: e.data.message.split(String.fromCharCode(10))[0] })); }
    };
    this.sim.postMessage({ type: 'init', poses: posesSab, heights: this.world.heightsSab, occupancy: this.occupancySab, signals: this.signalsSab, tickHz: 20 } satisfies ToSim);
    this.vehicles = new VehicleRenderer(this.poses);
    // profiles made in the editor: the workers need them before the segments that use them
    onProfileAdded(() => {
      const list = customProfiles();
      this.pool.broadcast({ type: 'profiles', list });
      this.sim.postMessage({ type: 'profiles', list } satisfies ToSim);
    });
    // the simulation mirrors the network: changes go as a batch every frame (app/simLink.ts)
    this.simLink = new SimLink({
      world: this.world, target: () => this.rig.target, hour: () => this.hour,
      demandChoice: () => this.prefs?.now, hasLines: () => this.transit.lines.length > 0,
    }, this.sim);
    this.world.roads.listeners.push((op) => this.simLink.queue(op));
    // hand-adjusted arrows: nodes to redo when the control or the segments change (features/roads/laneArrows.ts)
    this.laneArrows = new LaneArrows(this.world.roads, this.trafficLook.arrows);
    this.world.roads.listeners.push((op) => this.laneArrows.note(op));

    const ge = this;
    this.editing = new LotEditing({
      world: this.world, preview: this.preview, get hud() { return ge.hud; }, commands: this.commands,
      get growth() { return ge.growth; },
      get selected() { return ge.selected; },
      rig: this.rig, inside: this.inside,
      get insideId() { return ge.viewState.insideId; }, set insideId(v) { ge.viewState.insideId = v; },
      get insideFloor() { return ge.insideFloor; }, set insideFloor(v) { ge.insideFloor = v; },
      get transit() { return ge.transit; },
      set unsaved(v: boolean) { ge.unsaved = v; },
      select: (id) => ge.select(id),
      setTool: (t) => ge.setTool(t),
      showSelection: () => ge.showSelection(),
    });
    this.hud = new Hud(this.hudActions = Object.assign(this.featureActions(), this.saving.actions(), {
      tool: (t) => this.setTool(t),
      item: (k) => { this.itemTool.item = k; },
      signType: (k) => { this.itemTool.sign = k; },
      signText: (t) => { this.itemTool.signText = t; },
      barrierKind: (k) => { this.itemTool.barrier = k; },
      groundKind: (k) => { this.groundKind = k; },
      forestMode: (cut) => { this.forestCut = cut; },
      forestSpecies: (s) => { this.forestSpecies = s; },
      forestOne: (one) => { this.forestOne = one; this.hud.setHint(one ? t('game.hint.forest.one') : t('game.hint.forest')); },
      poleLights: (m) => { this.itemTool.poleLights = m; },
      biome: (b) => this.setBiome(b),
      riverWidth: (w) => { this.river.width = w; },
      elements: (e) => { this.elem = e; },
      landform: (m) => this.tools.setLandform(this.brush, m as BrushMode),
      flattenMap: () => {
        if (!window.confirm(t('game.confirm.flattenMap'))) return;
        this.commands.run(new FlattenMap(this.world, heightAt(this.world.heights, this.rig.target.x, this.rig.target.z)));
        this.hud.toast(t('game.toast.flattened'));
      },
      weather: (w) => this.sky.set(w),
      sky: (m) => { this.skyForRun = null; this.prefs!.update({ sky: m }); },
      personSpec: (p) => { this.personSpec = p; },
      personOptions: (o) => { this.personOptions = o; },
      peopleCatalog: () => this.vehicles.people.catalog(),
      bombForce: (f) => { this.bombForce = f; },
      roadKeys: (patch) => { this.prefs!.update(patch); },
      water: (w) => this.water.set(w),
      skyTool: (s) => { this.clouds.tool = s; this.skyHint(); },
      scatterClouds: (n, v) => this.clouds.scatter(n, v),
      clearClouds: () => this.clouds.clear(),
      fogLevel: (v) => this.fog.set(v),
      radius: (r) => { this.brush.radius = r; },
      strength: (s) => { this.brush.strength = s; },
      undo: () => this.history(false),
      redo: () => this.history(true),
      view: (v) => this.setView(v),
      save: () => void this.saving.save(),
      load: () => { if (this.discardOk()) void this.saving.load(); },
      exportMap: () => void this.saving.exportMap(),
      importMap: (f) => { if (this.discardOk()) void this.saving.importMap(f); },
      newMap: () => { if (this.discardOk()) void this.saving.newMap(); },
      testCity: () => { if (this.discardOk()) void this.cities.testCity(); },
      // another city: a seed of its own (the title screen takes a chosen seed)
      // Roadcraft 4.0's New world (main.ts:2123-2128): always asked, then a city over the whole map with a seed of its own
      generate: () => {
        const dirty = this.unsaved || this.world.saveDirty.includes(1);
        if (!window.confirm(t('ui.confirm.newWorld', { km: fmtInt(MAP_SIZE / 1000) }) + (dirty ? ` ${t('save.discardConfirm')}` : ''))) return;
        this.world.seed = (Math.random() * 2 ** 31) >>> 0 || 1; void this.generatedCity();
      },
      startScreen: () => this.showStart(),
      options: () => this.optionsPanel?.open(),
      help: () => this.hud.toggleHelp(),
      trafficView: () => this.toggleTrafficView(),
      follow: () => this.toggleFollow(),
      grid: () => { this.viewState.set('grid', !this.viewState.layers.grid); this.hud.layersChanged(); },
      north: () => this.rig.turnTo(0),
      line: (id) => { this.lines.selected = id; },
      newLine: () => this.lines.newLine(),
      // a station tab works on a line of its mode: the last one of that mode, or a new one at the first click
      lineMode: (m) => this.lines.setMode(m),
      lineColor: (color: number) => this.lines.setColor(color),
      lineLoop: (loop: boolean) => this.lines.setLoop(loop),
      buses: (d) => this.lines.buses(d),
      deleteLine: () => this.lines.deleteLine(),
      profile: (p) => { this.roadTool.setProfile(p); },
      roadOptions: () => {
        const rt = this.roadTool, p = PROFILES[rt.base];
        return { ...rt.options, ownLanes: laneCount(p), ownWidth: Math.round(p.strips.reduce((s, x) => s + x.width, 0)), base: rt.base };
      },
      roadLanes: (c) => { if (!this.roadTool.setOptions({ lanes: c })) this.hud.toast(t('ui.catalog.tooMany')); },
      roadWidth: (m) => { if (!this.roadTool.setOptions({ width: m })) this.hud.toast(t('ui.catalog.tooMany')); },
      roadParking: (p) => { if (!this.roadTool.setOptions({ parking: p })) this.hud.toast(t('ui.catalog.tooMany')); },
      roadClasses: () => roadClasses(),
      zone: (z) => { this.zoneTool.zone = z; },
      zoneRadius: (r) => { this.zoneTool.radius = r; },
      // 1 to 60 floors; "−" on an empty lot (rubble) leaves it empty
      floors: (d) => { if (d > 0 || (this.selected >= 0 && this.world.buildings.cols.floors[this.selected] > 0)) this.editSelected(d); },
      style: (a) => { if (this.selected >= 0) this.editSelected(0, a); else this.editing.newArch = a; },
      buildingFn: (f) => { if (this.selected >= 0) this.editSelected(0, undefined, f); else this.editing.newFn = f; },
      lotMode: (m) => this.setLotMode(m),
      lotSplit: (k, n) => { this.editing.splitKind = k; this.editing.splitParts = n; },
      zoneFill: (b) => { this.zoneBlock = b; this.hud.setHint(b ? t('game.hint.zone.block') : t('game.hint.zone')); },
      lotUse: (z) => { this.editing.lotUse = z; },
      demolishBuilding: () => this.demolishSelected(),
      inside: (c) => this.insideCmd(c),
      elevation: (d) => this.setElevation(this.roadTool.elevation + d),
      roadSnap: (m) => { this.roadTool.snapMode = m; },
      cutWalls: (on) => { this.roadTool.cutWalls = on; },
      blocks: (b) => { this.roadTool.blocks = b; },
      speed: (n) => this.setSpeed(n),
      orbit: (dx, dy) => this.rig.rotate(dx, dy),
      turn: (d) => this.rig.turnTo(this.rig.yaw - d * Math.PI / 4), // left (−1) turns as Q does
      tilt: (d) => this.rig.rotate(0, d * 60),
      zoneLayer: (on) => { this.viewState.set('zones', on); this.hud.layersChanged(); },
      simulation: (sim) => { this.prefs!.update(sim); this.simLink.demandNow(); },
      settings: () => {
        const st = this.prefs?.now;
        return { traffic: st?.traffic ?? 1, people: st?.people ?? 1, demand: st?.demand ?? 'normal', paint: this.world.look.paint, furniture: st?.furniture ?? 0, roadUp: st?.roadUp ?? 'PageUp', roadDown: st?.roadDown ?? 'PageDown', roadAlign: st?.roadAlign ?? 'KeyV', preset: st?.preset ?? 'high', webgpu: !!this.parts?.isWebGPU };
      },
      paint: (style) => chooseRoadPaint({ look: this.world.look, run: (cmd) => this.commands.run(cmd), changed: () => { this.unsaved = true; } }, style),
      furniture: (n) => { this.prefs!.update({ furniture: n }); this.roadTool.furniture = n; },
      ring: (f) => { this.roadTool.ringBy(f); this.hud.setRing(this.roadTool.ringRadius); },
      terminal: (on) => { this.transitTerminal = on; },
      itemRemove: (on) => { this.itemRemove = on; },
      cameraNumbers: () => ({ zoom: zoomPercent(this.canvas.clientHeight, this.rig.dist, this.rig.persp.fov), x: this.rig.target.x, z: this.rig.target.z }),
      health: () => { if (this.developer) this.health.toggle(); },
      developer: () => this.developer,
      healthLevel: () => this.health?.level() ?? 'ok',
      quality: (p) => {
        if (!this.parts.isWebGPU || !(p in PRESETS)) return;
        this.prefs!.update({ ...PRESETS[p as Preset], preset: p as Preset });
        void this.applySettings();
      },
      resetView: () => { if (this.homeView) this.rig.restore(this.homeView); },
      environment: () => ({ water: { ...this.water.ctl }, weather: this.sky.ctl ? { ...this.sky.ctl } : null, fog: this.world.look.fog }),
      showImpossible: () => {
        // the next one after the last visited (the set is small: only the nodes under 25°)
        const ids = [...this.world.impossible.nodes.keys()];
        if (!ids.length) return;
        const n = ids[(ids.indexOf(this.impossibleVisit) + 1) % ids.length], nc = this.world.roads.nodes.cols;
        this.impossibleVisit = n;
        this.setTool('inspect');
        this.rig.restore(new Float64Array([nc.x[n], nc.z[n], this.rig.yaw, Math.max(0.5, this.rig.pitch), Math.min(this.rig.dist, 160), this.rig.mode === 'iso' ? 1 : 0]));
        this.inspector.pick(nc.x[n], nc.z[n]);
      },
    } satisfies HudActions), { tool: () => this.tools.current, view: () => this.rig.mode, lots: () => this.editing, layers: () => this.viewState.layers });
    this.roadTool = new RoadTool(this.world, this.commands, this.preview, this.hud);
    this.itemTool = new ItemTool(this.world, this.commands, this.preview, this.hud);
    this.zoneTool = new ZoneTool(this.world, this.commands);
    this.growth = new Growth(this.world, this.pool);
    this.inspector = new Inspector(this.world, this.commands, {
      probe: (seg) => this.sim.postMessage({ type: 'probe', seg } satisfies ToSim),
      probeNode: (node) => this.sim.postMessage({ type: 'probeNode', node } satisfies ToSim),
      useProfile: (id) => { this.setTool('road'); this.roadTool.setProfile(id); this.hud.setProfile(id); },
      toast: (t) => this.hud.toast(t),
      mark: (node, seg) => {
        const net = this.world.roads;
        if (node >= 0) { const nc = net.nodes.cols; this.preview.hide(); this.preview.showCircle(nc.x[node], nc.y[node], nc.z[node], 14, true); }
        else if (seg >= 0) { const sp = segPreview(net, seg); this.preview.circle.visible = false; this.preview.show(sp.quad, sp.half, [0, 1], [sp.ya, sp.yb], true, 0x5aa8ff); }
        else { this.preview.hide(); this.preview.circle.visible = false; }
      },
      streetName: (x, z) => this.hudActions.streetNameAt?.(x, z) ?? '',
      editProfile: (p, apply) => this.hud.catalog.editFor(p, apply),
      project: (x, z) => { const v = new THREE.Vector3(x, heightAt(this.world.heights, x, z), z).project(this.rig.camera); return { x: v.x * innerWidth / 2, y: -v.y * innerHeight / 2 }; },
      nameStreet: (seg, name) => this.commands.run(nameStreetCommand(this.world, seg, name, () => { this.textSigns.version++; this.unsaved = true; this.inspector.refresh(); })),
    });
    this.commands.onPush = (c) => {
      const l = c.label;
      this.changesLog.unshift([Date.now(), l]);
      if (this.changesLog.length > 40) this.changesLog.pop();
      // the label is a language key, cmd.<sound>.<name>: its middle part is the sound (build, demolish or place)
      const sound = l.split('.')[1];
      this.ambient.sfx(sound === 'demolish' || sound === 'build' ? sound : 'place');
    };
    this.commands.onChange = () => {
      this.unsaved = true; this.hud.setHistory(this.commands.canUndo, this.commands.canRedo); this.inspector.refresh();
      // the building panel shows the building as it is now (or none, once undo took it away)
      if (this.selected >= 0) this.select(this.selected);
    };
    this.commands.onError = (err, c, redo) => {
      console.error(err);
      this.hud.toast(t(redo ? 'history.redoFailed' : 'history.undoFailed', { label: t(c.label), message: (err as Error)?.message ?? String(err) }));
    };
    // the language changes without reloading (Roadcraft 4.0, main.ts:3832): the panels the game fills write again
    onLanguageChange(() => { this.inspector.refresh(); if (this.selected >= 0) this.select(this.selected); });
    // closing: in the desktop game the window waits for the save; in the browser the page asks before leaving
    const app = (window as { roadcraftApp?: { onClosing(fn: () => void): void; canClose(): void } }).roadcraftApp;
    if (app) app.onClosing(() => void this.saving.saveBeforeClose().finally(() => app.canClose()));
    else window.addEventListener('beforeunload', (e) => { if (this.unsaved || this.world.saveDirty.includes(1)) { e.preventDefault(); e.returnValue = ''; } });
    this.hud.setHistory(false, false);
    this.setTool('camera');
  }

  async start(): Promise<void> {
    const params = new URLSearchParams(location.search);
    this.world.seed = Number(params.get('seed') ?? 1) >>> 0;
    this.world.gameId = (Math.random() * 2 ** 32) >>> 0;
    // a photo at a set hour (?hora) shows that hour's light: the sky follows the clock
    if (params.has('hour')) { this.world.setHour(Number(params.get('hour')) % 24); this.clock.holdHour(); this.skyForRun = 'cycle'; }
    this.hud.setSky(this.skyMode);
    this.weather.onStrike = (d) => this.ambient.thunder(d);

    this.hud.showLoading(t('game.loading.video'));
    this.parts = await createScene(this.canvas);
    console.log(`camadas de textura: ${this.parts.maxLayers}, mapa ${MAP_TILES} (${location.search})`);
    if (MAP_TILES * MAP_TILES > this.parts.maxLayers) {
      // the GPU cannot hold this map size: fall back to the largest that fits
      const fit = [...MAP_SIZES].reverse().find((t) => t * t <= this.parts.maxLayers) ?? 10;
      reloadWithMap(fit, 'large');
      return;
    }
    const { scene, renderer } = this.parts;
    scene.add(this.terrain.mesh);
    scene.add(this.terrain.waterMesh);
    // the sea plane gets the terrain's water (it reads the ground's height under each pixel)
    this.parts.water.material = this.terrain.createSeaMaterial();
    for (const l of this.layers) scene.add(l.group);
    scene.add(this.preview.mesh, this.preview.marker, this.preview.circle);
    scene.add(this.vehicles.group);
    this.props = new PropRenderer(this.world, this.pool, this.signalsSab, this.parts.isWebGPU);
    scene.add(this.props.group);
    scene.add(this.transitView.group);
    scene.add(this.weather.group);
    this.particles = new Particles(this.world);
    this.demolition = new Demolition({
      world: this.world, vehicles: this.vehicles, burst: (x, y, z, kind, strength, seconds) => this.particles.burst(x, y, z, kind, strength, seconds),
      push: (cmd) => this.commands.push(cmd), sim: { postMessage: (msg) => this.sim.postMessage(msg) }, hud: this.hud, ambient: this.ambient, flash: flashU,
    });
    scene.add(this.particles.mesh);
    scene.add(this.clouds.view.mesh);
    scene.add(this.inside.group);
    scene.add(this.demolition.group);
    this.textSigns = new TextSigns(this.world, this.world.signTexts);
    scene.add(this.textSigns.group);
    this.itemTool.onText = (text, x, z, seg, street) => {
      const w = this.world, key = signKey(x, z);
      const chain = street && seg >= 0 ? streetChain(w, seg) : [];
      this.commands.run(signTextCommand(w, key, text, chain, () => { this.textSigns.version++; this.unsaved = true; }));
      if (street && chain.length) this.hud.toast(t('game.toast.streetNamed', { name: text }));
    };

    this.hud.showLoading(t('game.loading.terrain'));
    await this.generateTerrain();

    // all shaders compiled here, never during play
    this.hud.showLoading(t('game.loading.shaders'));
    // the sky's light first: the scene's environment map enters every lit material's pipeline key (three r186
    // NodeManager.getCacheKey), and without it everything compiled here was compiled again in play
    setTimeOfDay(this.parts, this.skyMode === 'day' ? DAY_LIGHT : this.skyMode === 'night' ? NIGHT_LIGHT : this.hour, cloudsU.value, rainU.value);
    const warm = new THREE.Group();
    for (const l of this.layers) warm.add(l.warmupMesh());
    warm.add(this.textSigns.warmup());
    this.demolition.warm(true);
    this.particles.warm(true);
    scene.add(warm);
    for (const m of [this.preview.mesh, this.preview.marker, this.preview.circle]) m.visible = true;
    this.inside.warm(); // compiles the inside-view materials at load
    this.transitView.showPaths = true;
    this.vehicles.warmup();
    this.rig.resize(window.innerWidth, window.innerHeight);
    this.updatePixelScale();
    this.rig.update(0);
    this.terrain.update(this.rig.persp, this.rig.eye);
    // the props compute runs once here (compiles at load)
    this.props.bake(renderer);
    if (this.props.enabled) this.props.update(renderer, this.rig.persp, this.rig.eye, performance.now());
    // options (quality): from last time, or by the GPU; ?simples etc. override them for photos
    const prefs = this.prefs = new Preferences(this.parts.isWebGPU);
    if (params.has('simple')) prefs.forRun({ shadows: false, ao: false, bloom: false });
    if (params.has('noshadows')) prefs.forRun({ shadows: false });
    // measurements: turn parts of the rendering on and off
    if (params.has('nodetail')) this.cityDetail.group.visible = false;
    if (params.has('perf')) { this.perfLog = []; this.profile = new FrameProfile(); if (this.parts.isWebGPU) this.gpuTiming = new GpuTiming(this.parts.renderer); }
    if (params.has('nopedestrians')) this.vehicles.hidePeople = true;
    if (params.has('noao')) prefs.forRun({ ao: false });
    if (params.has('nobloom')) prefs.forRun({ bloom: false });
    for (const w of ['rain', 'clear', 'storm'] as const) if (params.has(w)) prefs.forRun({ weather: w });
    this.health = new HealthPanel(document.getElementById('hud')!, { world: () => this.healthWorld(), state: () => this.healthState() });
    this.creator = new Creator({ apply: (d, fl) => this.applyDesign(d, fl) });
    this.hud.buildingSlot.append(this.creator.el);
    this.creator.el.style.display = 'none';
    this.optionsPanel = new OptionsPanel(document.getElementById('hud')!, () => this.settings, this.parts.isWebGPU, (s) => { this.prefs!.update(s); void this.applySettings(); },
      !this.developer ? [] : [[t('game.options.worstCase'), t('game.options.worstCaseTip'), () => { if (this.discardOk()) void this.cities.testCity(); }],
        [t('game.options.unlimited'), t('game.options.unlimitedTip'), () => { this.world.unlimited = !this.world.unlimited; this.hud.toast(this.world.unlimited ? t('game.toast.unlimitedOn') : t('game.toast.unlimitedOff')); }]], () => this.gpuName());
    await this.applySettings(false);
    this.showLook();
    await renderer.compileAsync(scene, this.rig.persp);
    await renderer.compileAsync(scene, this.rig.ortho);
    await this.warmPost();
    scene.remove(warm);
    warm.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.demolition.warm(false);
    this.particles.warm(false);
    this.preview.hideAll();
    this.inside.hide();
    this.transitView.showPaths = false;

    this.input = this.bindInput();
    this.bindResize();
    this.hud.hideLoading();
    if (params.has('large')) this.hud.toast(t('game.toast.mapTooBig'));
    if (!this.parts.isWebGPU) this.hud.toast(t('game.toast.webgl'));
    const cam = params.get('cam');
    if (cam) {
      const [x, z, yaw, pitch, dist] = cam.split(',').map(Number);
      this.rig.restore(new Float64Array([x, z, yaw * Math.PI / 180, pitch * Math.PI / 180, dist, params.has('iso') ? 1 : 0]));
    }
    this.last = performance.now();
    this.watchInput();
    renderer.setAnimationLoop((t) => this.frame(t));
    if (params.has('test')) await this.cities.testCity();
    else if (params.has('city')) await this.generatedCity(params.has('medium'));
    else if (params.has('open')) await this.saving.load();
    else if (params.has('start')) this.showStart();
    // straight into a medium town of straight streets, blocks and lots (Roadcraft 2.0's start): the start screen stays
    // on the menu (and ?inicio)
    else if (!params.has('cam') && !params.has('empty')) await this.generatedCity(true);
    await this.settle();
    this.homeView ??= this.rig.state();
    this.life.loaded();
  }

  /** Frame numbers (automated photos and debugging). */
  stats(): Record<string, number> {
    const info = this.parts.renderer.info.render as { drawCalls: number; triangles: number };
    return {
      draws: info.drawCalls, tris: info.triangles,
      buildings: this.world.buildings.size, segs: this.world.roads.segs.size,
      cityMB: Math.round(this.city.gpuBytes / 1e6), roadsMB: Math.round(this.roads.gpuBytes / 1e6),
      ...(this.simStats?.type === 'stats' ? { cars: this.simStats.cars, micro: this.simStats.micro, peds: this.simStats.peds } : {}),
    };
  }

  /**
   * stats() plus the triangles the GPU really drew (D81): three counts an indirect draw as one instance, so the props
   * (GPU-culled, drawn indirect) are missing from `tris`; `trisDrawn` replaces their count with the GPU-written one.
   */
  async drawnStats(): Promise<Record<string, number>> {
    const s = this.stats();
    const p = await this.props.drawnTriangles(this.parts.renderer);
    return { ...s, trisDrawn: s.tris - p.counted + p.drawn };
  }

  /** Camera and hour for automated photos; waits for the meshes to be ready. */
  async view(x: number, z: number, yaw: number, pitch: number, dist: number, hour?: number): Promise<void> {
    await photoView(this.rig, (frames) => this.settle(frames), (h) => { this.world.setHour(h); this.clock.holdHour(); }, x, z, yaw, pitch, dist, hour);
  }

  /** Waits for the workers to drain (for photos and tests). */
  async settle(frames = 20): Promise<void> { await settlePool(this.pool, frames, () => this.layers.every((l) => !l.changed)); }

  /** Generates the base terrain from the seed, one tile per job. */
  /** Terrain of every tile from the seed, in the workers; rejects if any tile fails. */
  private async generateTerrain(): Promise<void> {
    await Promise.all(Array.from({ length: TILE_COUNT }, async (_, t) => {
      const r = await this.pool.run('terrainGen', { seed: this.world.seed, tile: t }, { key: `terrain:${t}`, priority: 0 });
      this.world.tileMin[r.tile] = r.min;
      this.world.tileMax[r.tile] = r.max;
      this.world.tileWater[r.tile] = r.hasWater ? 1 : 0; this.world.waterDirty.add(r.tile);
      this.world.layerDirty.add(r.tile);
      // the tile's props (trees) depend on the terrain
      const tx = r.tile % MAP_TILES, tz = (r.tile / MAP_TILES) | 0;
      this.world.dirty.markRect(tileOriginX(tx), tileOriginX(tz), tileOriginX(tx) + TILE_SIZE - 1, tileOriginX(tz) + TILE_SIZE - 1, Dirty.Props);
    }));
  }

  // ----------------------------------------------------------------- frame

  /** Frames in a row with nothing to draw (paused, camera still, no input, no work arriving). */
  private stillFrames = 0;
  private lastInput = 0;
  private drawnView = new THREE.Matrix4();
  private drawnProj = new THREE.Matrix4();

  /** Input marks the frames as live (hover previews, brush ring, menus over the 3D view). */
  private watchInput(): void {
    const mark = () => { this.lastInput = performance.now(); this.stillFrames = 0; };
    for (const e of ['pointermove', 'pointerdown', 'pointerup', 'wheel', 'keydown', 'keyup', 'resize']) window.addEventListener(e, mark, { capture: true, passive: true });
    document.addEventListener('visibilitychange', mark);
  }

  private frame(now: number): void {
    // the props count their draws per animation-loop frame, as three counts its own (D81)
    this.props.frameStart();
    // minimized or hidden: nothing is drawn; the simulation goes on in its worker (the clock does not jump on return)
    if (document.hidden) { this.last = now; return; }
    this.health?.frame(now - this.last);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const pr = this.profile;
    pr?.begin(performance.now());
    const { renderer, scene } = this.parts;

    this.rig.update(dt);
    pr?.lap(PART.camera, performance.now());
    // an explosion shakes the camera for a moment (4.0 renderer.ts: a random offset each frame, gone the next)
    const shake = this.demolition.shake();
    if (shake > 0) {
      this.rig.camera.position.add(this.shakeOffset.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(shake));
      this.rig.camera.updateMatrixWorld();
    }
    // inside view: gone with its building (demolished, undone, another city), laid out again when it is edited
    if (this.viewState.insideId >= 0) {
      this.inside.follow(this.world);
      if (!this.inside.on) { this.viewState.insideId = -1; this.hud.setInside(-1); }
    }
    const cam = this.rig.camera;
    // always day (or night) fixes the light only: the clock, and the traffic demand that follows it, go on
    const light = this.skyMode === 'day' ? DAY_LIGHT : this.skyMode === 'night' ? NIGHT_LIGHT : this.hour;
    // city clock in minutes (building decay); the sky mode only fixes the light
    if (!this.clock.paused) this.world.advanceClock(dt * this.clock.daySpeed);
    if (now > this.autosaveAt) { this.autosaveAt = now + 120000; if ((this.unsaved || this.world.saveDirty.includes(1)) && this.life.editable) void this.saving.save(true); }
    const groundY = heightAt(this.world.heights, this.rig.eye.x, this.rig.eye.z);
    this.weather.viewAngle = Math.atan2(this.rig.target.z - this.rig.eye.z, this.rig.target.x - this.rig.eye.x);
    // the rain box round the eye; isometric: round what is looked at (round the perspective eye it was a block of rain)
    this.weather.update(dt, dt * this.clock.daySpeed * 60, this.rig.mode === 'iso' ? this.rig.target : this.rig.eye, groundY, (this.parts.scene.fog as THREE.FogExp2).color);
    setTimeOfDay(this.parts, light, cloudsU.value, rainU.value, this.rig.eye.y - groundY, flashU.value);
    pr?.lap(PART.weather, performance.now());
    this.particles.update(dt, this.rig.eye);
    this.textSigns.update(this.rig.eye);
    this.demolition.update(dt);
    pr?.lap(PART.effects, performance.now());
    {
      const st = this.simStats?.type === 'stats' ? this.simStats : null;
      const a = this.ambientIn;
      a.rain = rainU.value; a.wind = windU.value; a.traffic = Math.min(1, (st?.micro ?? 0) / 120);
      a.height = this.rig.eye.y - groundY; a.day = 1 - nightU.value; a.green = this.green;
      this.ambient.update(dt, a);
    }
    this.hud.setClock(this.hour, this.clock.speed, this.clock.paused);
    this.hud.setMoney(this.world.money, this.world.unlimited);
    this.hud.setCompass(this.rig.yaw);
    pr?.lap(PART.audioHud, performance.now());

    // tool under the cursor
    let hit: THREE.Vector3 | null = null;
    if (this.tool !== 'camera' && this.pointer.inside && this.gesture.drag !== 'pan' && this.gesture.drag !== 'rotate') hit = this.rig.pick(this.ndcX(), this.ndcY());
    const terrainTool = TERRAIN_TOOLS.includes(this.tool) || GROUND_TOOLS.includes(this.tool) || (this.tool === 'sky' && this.clouds.tool.fog !== 'none');
    if (terrainTool && hit) this.terrain.overlays.showBrush(hit.x, hit.z, this.brush.radius);
    else if (this.tool === 'zone' && hit) this.terrain.overlays.showBrush(hit.x, hit.z, this.zoneTool.radius);
    else this.terrain.overlays.hideBrush();
    if (this.gesture.drag === 'zone' && hit) this.zoneTool.dab(hit.x, hit.z);
    if (this.tool === 'building') this.hoverLotTool(hit);
    if (this.gesture.drag === 'brush' && this.elemStroke && hit) {
      if (this.tool === 'sky') this.elemStroke.dab(hit.x, hit.z, this.brush.radius, Item.Mist, 0.25, this.clouds.tool.fogHeight, this.clouds.tool.fog === 'erase' ? 'eraseKind' : 'lay', dt, 22);
      else this.elemStroke.dab(hit.x, hit.z, this.brush.radius, this.elem.kind, this.elem.density, this.elem.size, this.elem.mode, dt);
    }
    if (this.gesture.drag === 'brush' && this.stroke && hit) {
      if (this.stroke instanceof GroundStroke) this.stroke.dab(hit.x, hit.z, this.brush.radius, this.tool === 'paint' ? 'paint' : this.forestCut ? 'cut' : 'forest', this.groundKind, this.brush.strength, dt, this.forestSpecies);
      else {
        this.stroke.dab(hit.x, hit.z, this.brush, dt);
        const rock = LANDFORM_ROCK[this.brush.mode];
        if (this.rockStroke && rock !== undefined) this.rockStroke.dab(hit.x, hit.z, this.brush.radius * (this.brush.mode === 'gully' ? 0.6 : 0.95), 'paint', rock, 1, 1);
      }
    }
    if (this.tool === 'river') this.river.hover(hit);
    if (this.gesture.drag === 'free') this.roadTool.freeMove(hit);
    else if (this.gesture.drag === 'row' && this.gesture.boxStart) this.itemTool.hoverRow(this.gesture.boxStart.x, this.gesture.boxStart.z, hit);
    else if (this.gesture.drag === 'box' && this.gesture.boxStart && hit) {
      // drag rectangle on the ground (red)
      const a = this.gesture.boxStart, cz = (a.z + hit.z) / 2, H = (x: number, z: number) => heightAt(this.world.heights, x, z) + 0.8;
      this.preview.marker.visible = false;
      this.preview.show({ x0: (a.x + hit.x) / 2, z0: a.z, cx: (a.x + hit.x) / 2, cz, x1: (a.x + hit.x) / 2, z1: hit.z }, Math.abs(hit.x - a.x) / 2, [0, 1], [H(a.x, a.z), H(hit.x, hit.z)], true, 0xe2564b);
    } else if (ROAD_TOOLS.includes(this.tool) && this.tool !== 'free' && this.gesture.drag !== 'pan' && this.gesture.drag !== 'rotate') this.roadTool.hover(hit);
    if ((this.tool === 'streetscape' || this.tool === 'barrier') && this.gesture.drag !== 'pan' && this.gesture.drag !== 'rotate' && this.gesture.drag !== 'row') this.itemTool.hover(hit);
    pr?.lap(PART.tools, performance.now());

    // Drawn only when something visible can change: the camera, the simulation or the clock running, input, meshes
    // arriving, weather. Paused and idle, after STILL_FRAMES (the anti-aliasing settles) nothing is drawn; water and
    // leaves stand still until something moves.
    const live = !this.clock.paused || now - this.lastInput < 800 || !this.pool.isIdle() || this.cities.terrainUnderway || rainU.value > 0.01 || flashU.value > 0 || this.demolition.active()
      || !this.drawnView.equals(cam.matrixWorld) || !this.drawnProj.equals(cam.projectionMatrix);
    this.stillFrames = live ? 0 : this.stillFrames + 1;
    this.drawnView.copy(cam.matrixWorld);
    this.drawnProj.copy(cam.projectionMatrix);
    if (this.stillFrames > STILL_FRAMES) return;
    this.framesDrawn++;
    pr?.drew();

    const pf = this.perfLog, T0 = pf ? performance.now() : 0;
    for (const l of this.layers) l.processDirty();
    pr?.lap(PART.layersDirty, performance.now());
    // (the terrain's dirty cells are read by the seam layer, render/terrainSeams.ts)
    this.processRoadPaint();
    this.laneArrows.update();
    const T1 = pf ? performance.now() : 0;
    pr?.lap(PART.roadPaint, T1);
    if (!this.cities.terrainUnderway) this.growth.processDirty();
    this.growth.tick(dt, this.clock.running);
    const T2 = pf ? performance.now() : 0;
    pr?.lap(PART.growth, T2);
    this.terrain.uploadDirtyLayers();
    this.terrain.update(cam, this.rig.eye);
    pr?.lap(PART.terrain, performance.now());
    for (const l of this.layers) l.update(cam, this.rig.eye);
    const T3 = pf ? performance.now() : 0;
    pr?.lap(PART.layersUpdate, T3);
    this.syncSim(now);
    this.lines.sync(this.simLink.roadsVersion, this.tool === 'transit', this.simStats?.type === 'stats' ? this.simStats.lines : null);
    this.updateInfo(now);
    pr?.lap(PART.sim, performance.now());
    this.vehicles.update(cam, this.rig.eye, now);
    if (this.vehicles.follow) { const p = this.vehicles.followPose; this.rig.followPose(p[0], p[1], p[2], p[3], dt); }
    else if (this.rig.followY !== null) { this.rig.followY = null; this.hud.toast(t('game.toast.followLost')); }
    const T4 = pf ? performance.now() : 0;
    pr?.lap(PART.vehicles, T4);
    this.props.processDirty();
    this.props.update(renderer, cam, this.rig.eye, now);
    const T5 = pf ? performance.now() : 0;
    pr?.lap(PART.props, T5);

    if (this.post) {
      // the shadow cascades are redrawn only when something casting changed or moves (render/post.ts prepareShadows)
      if (this.props.changed || this.layers.some((l) => l.changed)) this.post.invalidateShadows();
      this.props.changed = false;
      this.post.setCamera(cam);
      this.post.render(!this.clock.paused || windU.value > 0.001 || this.demolition.moving());
    }
    else renderer.render(scene, cam);
    this.gpuTiming?.frameEnd();
    pr?.lap(PART.draw, performance.now());
    // measurement (?perf): frames over 30 ms say where the time went
    if (pf) { const T6 = performance.now(); if (T6 - T0 > 30) pf.push(`layers ${(T1 - T0).toFixed(0)} growth ${(T2 - T1).toFixed(0)} terrain+lod ${(T3 - T2).toFixed(0)} sim+vehicles ${(T4 - T3).toFixed(0)} props ${(T5 - T4).toFixed(0)} draw ${(T6 - T5).toFixed(0)}`); } // not for the player: ?perf measurement log
  }

  private toggleTrafficView(): void {
    this.viewState.set('traffic', !this.viewState.layers.traffic);
    this.hud.layersChanged();
  }

  /** Trips completed and given up per minute (from the simulation's running totals). */
  private tripsPerMin = 0;
  private lostPerMin = 0;
  private lastTrips: { t: number; arrived: number; lost: number } | null = null;
  private trackTrips(st: Extract<FromSim, { type: 'stats' }>): void {
    this.simStats = st;
    // per simulated minute (at 2x and 4x as at 1x; paused, the figures stay)
    const t = st.simTime * 1000;
    if (!this.lastTrips || st.arrived < this.lastTrips.arrived || t < this.lastTrips.t) { this.lastTrips = { t, arrived: st.arrived, lost: st.lost }; return; }
    if (t - this.lastTrips.t < 10000) return;
    const k = 60000 / (t - this.lastTrips.t);
    this.tripsPerMin = (st.arrived - this.lastTrips.arrived) * k;
    this.lostPerMin = (st.lost - this.lastTrips.lost) * k;
    this.lastTrips = { t, arrived: st.arrived, lost: st.lost };
  }

  private infoTimer = 0;
  /** Trees near the camera, 0..1 (the birds sing only with trees around). */
  green = 0.7;

  /**
   * How green the place under the camera is: trees placed by the player and planted forest count; buildings and roads
   * take room from the trees the map grows by itself. A query of 80 m around the camera (bounded, twice a second).
   */
  private greenAt(x: number, z: number): number {
    const w = this.world, R = 80, ic = w.items.t.cols;
    let trees = 0;
    w.items.index.query(x - R, z - R, x + R, z + R, (i) => { if (ic.type[i] === Item.Tree || ic.type[i] === Item.Conifer || ic.type[i] === Item.Palm) trees++; });
    let built = 0;
    const bc = w.buildings.cols;
    w.buildingIndex.query(x - R, z - R, x + R, z + R, (id) => { built += bc.w[id] * bc.d[id]; });
    let road = 0;
    w.roads.forSegsNear(x - R, z - R, x + R, z + R, () => { road++; });
    // planted forest: the ground's blue channel at a few points
    let forest = 0;
    for (const [dx, dz] of [[0, 0], [40, 0], [-40, 0], [0, 40], [0, -40]]) {
      const gx = Math.max(0, Math.min(WATER_MAP_RES - 1, Math.floor(waterCoord(x + dx)))), gz = Math.max(0, Math.min(WATER_MAP_RES - 1, Math.floor(waterCoord(z + dz))));
      forest += ((w.ground32[waterIndex(gx, gz)] >> 16) & 255) / 255 / 5;
    }
    const open = Math.max(0, 1 - built / (Math.PI * R * R * 0.35) - road / 12);
    return Math.min(1, trees / 8 + forest + 0.7 * open);
  }
  /** City numbers in the corner (twice per second). */
  private updateInfo(now: number): void {
    if (now - this.infoTimer < 500) return;
    this.infoTimer = now;
    this.green = this.greenAt(this.rig.target.x, this.rig.target.z);
    const w = this.world, st = this.simStats?.type === 'stats' ? this.simStats : null;
    this.hud.setStatus({
      cars: st?.cars ?? 0, peds: st?.peds ?? 0, residents: w.residents, jobs: w.jobs, buildings: w.buildings.size,
      speedKmh: st ? st.speed * 3.6 : 0, tripsPerMin: this.tripsPerMin, lostPerMin: this.lostPerMin, stopped: st?.stopped ?? 0,
      roads: w.roads.segs.size, nodes: w.roads.nodes.size, impossible: w.impossible.count,
    });
  }

  /** Pauses or resumes: the clock and the simulation (cars, pedestrians, buses) stop together. */
  togglePause(): void {
    this.clock.togglePause();
    this.sim.postMessage({ type: 'speed', value: this.clock.running } satisfies ToSim);
    this.hud.toast(this.clock.paused ? t('game.toast.paused') : t('game.toast.resumed'));
  }

  /** Simulation speed from the top bar: 0 pauses, 1, 2 or 4 (the clock keeps pace, unless frozen for a photo). */
  private setSpeed(n: number): void {
    this.clock.setSpeed(n);
    this.sim.postMessage({ type: 'speed', value: this.clock.running } satisfies ToSim);
  }

  /** The camera's spot for the traffic overlay and the occupancy texture, then the simulation link's batch and timers. */
  private syncSim(now: number): void {
    this.simLink.sync(now);
    this.trafficLook.center.value.set(this.rig.target.x, this.rig.target.z);
    if (now - this.occSent > 500) { this.occSent = now; this.trafficLook.occupancy.needsUpdate = true; }
  }

  /** Repaints, in the worker, the tiles whose roads changed. */
  private processRoadPaint(): void {
    const cells = this.world.dirty.drain(Dirty.RoadPaint);
    if (cells.length === 0) return;
    const tiles = new Set<number>();
    for (const c of cells) tiles.add(tileOfCell(c));
    const net = this.world.roads;
    for (const t of tiles) {
      const tx = t % MAP_TILES, tz = (t / MAP_TILES) | 0;
      const x0 = tileOriginX(tx), z0 = tileOriginX(tz);
      const segs: SegId[] = [];
      net.forSegsNear(x0 - 30, z0 - 30, x0 + TILE_SIZE + 30, z0 + TILE_SIZE + 30, (s) => segs.push(s));
      const graph = net.gather(segs, []);
      this.pool.submit('roadPaint', { graph, tile: t }, (r) => this.terrain.setRoadPaint(r.tile, r.texels, r.coarse),
        { key: `paint:${t}`, priority: 3000, transfer: roadGraphTransfer(graph) });
    }
  }

  // ----------------------------------------------------------------- input

  private ndcX(): number { return (this.pointer.x / this.canvas.clientWidth) * 2 - 1; }
  private ndcY(): number { return -(this.pointer.y / this.canvas.clientHeight) * 2 + 1; }

  private bindInput(): InputControl {
    const g = this;
    return bindInput({
      life: this.life,
      canvas: this.canvas,
      ambient: this.ambient,
      commands: this.commands,
      rig: this.rig,
      hud: this.hud,
      world: this.world,
      preview: this.preview,
      roadTool: this.roadTool,
      itemTool: this.itemTool,
      zoneTool: this.zoneTool,
      inspector: this.inspector,
      health: this.health,
      optionsPanel: this.optionsPanel,
      get startMenu() { return g.startMenu; },
      inside: this.inside,
      vehicles: this.vehicles,
      get developer() { return g.developer; },
      get selected() { return g.selected; },
      get tool() { return g.tool; },
      brush: this.brush,
      get skyTool() { return g.clouds.tool; },
      get forestOne() { return g.forestOne; },
      get zoneBlock() { return g.zoneBlock; },
      get simSpeed() { return g.clock.speed; },
      get paused() { return g.clock.paused; },
      get homeView() { return g.homeView; },
      riverPts: this.river.points,
      editing: this.editing,
      get insideId() { return g.viewState.insideId; },
      get cloudGrab() { return g.clouds.grabbed; },
      get pointer() { return g.pointer; },
      get stroke() { return g.stroke; }, set stroke(v) { g.stroke = v; },
      get rockStroke() { return g.rockStroke; }, set rockStroke(v) { g.rockStroke = v; },
      get elemStroke() { return g.elemStroke; }, set elemStroke(v) { g.elemStroke = v; },
      ndcX: () => g.ndcX(), ndcY: () => g.ndcY(),
      clickHost: () => g.clickHost(),
      grabCloud: (hit) => !!hit && g.clouds.grab(hit.x, hit.z),
      dropCloud: (hit) => g.clouds.drop(hit),
      grabCorner: (hit) => g.grabCorner(hit),
      dropCorner: (hit) => g.dropCorner(hit),
      finishRiver: () => g.river.finish(),
      finishPoly: () => g.finishPoly(),
      insideCmd: (c) => g.insideCmd(c),
      setTool: (t) => g.setTool(t),
      setSpeed: (n) => g.setSpeed(n),
      setView: (v) => g.setView(v),
      toggleTrafficView: () => g.toggleTrafficView(),
      toggleFollow: () => g.toggleFollow(),
      toolKey: (e) => g.toolKey(e),
      history: (r) => g.history(r),
      save: () => g.saving.save(),
    }, this.gesture);
  }

  private removePole(hit: THREE.Vector3 | null): void {
    const items = this.world.items, id = hit ? items.nearest(hit.x, hit.z, 3) : -1;
    if (id < 0 || items.t.cols.type[id] !== Item.PoleLine) return;
    const c = new ItemsCommand(items, 'cmd.demolish.item');
    c.remove(id);
    this.commands.push(c);
  }

  /** The keys the tool in hand reads itself; false: not one of its keys (the table goes on). */
  private toolKey(e: KeyboardEvent): boolean {
    const t = this.tool, c = e.code;
    if (t === 'building' && this.selected >= 0) {
      if (c === 'Delete') { this.demolishSelected(); return true; }
      if (c === 'PageUp' || c === 'PageDown') { this.editSelected(c === 'PageUp' ? 1 : -1); return true; }
    }
    if (t === 'building' && this.editing.lotMode === 'poly' && c === 'Enter') { this.finishPoly(); return true; }
    if (t === 'building' && this.editing.lotMode === 'poly' && c === 'Backspace') { this.editing.polyPts.pop(); return true; }
    if (t === 'barrier' && c === 'Backspace') { this.itemTool.back(); return true; }
    if (t === 'barrier' && c === 'Enter') { this.itemTool.cancel(); return true; }
    if (t === 'river' && c === 'Enter') { this.river.finish(); return true; }
    if (t === 'river' && c === 'Backspace') { this.river.points.pop(); return true; }
    if (t === 'inspect' && (c === 'Delete' || c === 'Backspace') && this.inspector.seg >= 0) {
      const j = demolishSeg(this.world, this.inspector.seg);
      if (j.settle()) this.commands.push(j);
      return true;
    }
    const road = ROAD_TOOLS.includes(t) && t !== 'bulldoze';
    if (road && c === (this.settings.roadUp ?? 'PageUp')) { this.setElevation(this.roadTool.elevation + 4); return true; }
    if (road && c === (this.settings.roadDown ?? 'PageDown')) { this.setElevation(this.roadTool.elevation - 4); return true; }
    // the alignment key (V): straight, curve, free, straight again (Roadcraft 4.0)
    const drawing: Tool[] = ['road', 'curve', 'free', 'blocks'];
    if (drawing.includes(t) && c === (this.settings.roadAlign ?? 'KeyV') && !e.shiftKey) { this.setTool(t === 'road' ? 'curve' : t === 'curve' ? 'free' : 'road'); return true; }
    if (c === 'BracketLeft' || c === 'BracketRight') {
      const f = c === 'BracketLeft' ? 1 / 1.2 : 1.2;
      if (t === 'roundabout') { this.roadTool.ringBy(f); this.hud.setRing(this.roadTool.ringRadius); return true; }
      if (t === 'zone') { this.zoneTool.radius = Math.max(10, Math.min(200, Math.round(this.zoneTool.radius * f / 5) * 5)); this.hud.setZoneRadius(this.zoneTool.radius); return true; }
      if (TERRAIN_TOOLS.includes(t) || GROUND_TOOLS.includes(t) || t === 'sky') { this.setRadius(this.brush.radius * f); return true; }
    }
    return false;
  }

  private bindResize(): void {
    window.addEventListener('resize', () => {
      this.parts.renderer.setSize(window.innerWidth, window.innerHeight, false);
      this.rig.resize(window.innerWidth, window.innerHeight);
      this.updatePixelScale();
    });
  }

  /** Applies the options: resolution, detail, final image (rebuilt and compiled here, never mid-game) and weather. */
  private async applySettings(compile = true): Promise<void> {
    const s = this.settings;
    const { renderer, scene } = this.parts;
    renderer.setPixelRatio(window.devicePixelRatio * s.resolution);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.updatePixelScale();
    // the option's weather; weather set by hand in the Sky panel (the map's) stays
    this.sky.show();
    this.ambient.setVolume(s.volume ?? 0.6);
    this.roadTool.furniture = s.furniture ?? 0;
    const want = this.parts.isWebGPU && (s.shadows || s.ao || s.bloom);
    const same = this.post && want && this.post.opts.shadows === s.shadows && this.post.opts.ao === s.ao && this.post.opts.bloom === s.bloom;
    if (same) return;
    if (this.post) { this.post.dispose(); this.post = null; }
    this.parts.sun.castShadow = false;
    renderer.shadowMap.enabled = false;
    if (want) this.post = new Post(renderer, scene, this.rig.persp, this.parts.sun, { shadows: s.shadows, ao: s.ao, bloom: s.bloom });
    if (compile) {
      this.hud.showLoading(t('game.loading.options'));
      // the explosion's pieces: shadows switched on are 3 more pipelines for them (compiled here, not at the next bomb)
      this.demolition.warm(true);
      await renderer.compileAsync(scene, this.rig.persp);
      await this.warmPost();
      this.demolition.warm(false);
      this.hud.hideLoading();
    }
  }

  /**
   * Renders the final image once with each camera (compiles its shaders at load). One animation frame per render: the
   * scene passes update once per frame (three r186 PassNode, NodeUpdateType.FRAME; the frame id advances in the
   * renderer's own animation loop), so four renders in a row drew the scene only with the first camera and every
   * material compiled again for the perspective camera the first time it showed up in play.
   */
  private async warmPost(): Promise<void> {
    if (!this.post) return;
    // both outputs (day without bloom, night with it) compiled at load: dusk does not stall
    for (const night of [true, false]) for (const cam of [this.rig.ortho, this.rig.persp]) {
      await new Promise((r) => requestAnimationFrame(r));
      this.post.bloomOverride = night;
      this.post.setCamera(cam); this.post.render();
    }
    this.post.bloomOverride = null;
  }

  /** Detail distances by screen-space error: more pixels, detail reaches farther. */
  private updatePixelScale(): void {
    // only the window and the player's resolution and detail: never the frame time (no quality cut to pass a budget)
    const res = this.prefs ? this.settings.resolution * this.settings.detail : 1;
    const k = Math.min(3, Math.max(0.3, window.innerHeight * window.devicePixelRatio * res / 1080));
    // (the seams keep their reach: the terrain cuts within a fixed distance, render/terrain.ts SEAM_REACH)
    for (const l of this.layers) if (l !== this.seams) l.pixelScale = k;
    if (this.props) this.props.pixelScale = k;
  }

  /** Undo (false) or redo (true), with sound. */
  private history(redo: boolean): void {
    // a brush, zoning or free road still being dragged is recorded on release: undo waits for it
    if (this.gesture.drag === 'brush' || this.gesture.drag === 'zone' || this.gesture.drag === 'free' || this.gesture.drag === 'node' || this.gesture.drag === 'lots') return;
    if (redo ? this.commands.redo() : this.commands.undo()) this.ambient.sfx('undo');
  }

  private setTool(tool: Tool): void { this.tools.set(this.toolHost(), tool); }

  /** The tool state as the tools module sees it: accessors, never copies. */
  private toolHost(): ToolHost {
    const g = this;
    return {
      view: g.viewState, brush: g.brush, lotMode: g.editing.lotMode, skyTool: g.clouds.tool,
      riverPts: g.river.points, roadTool: g.roadTool, itemTool: g.itemTool, inspector: g.inspector, transitView: g.transitView,
      preview: g.preview, creator: g.creator, inside: g.inside,
      hud: g.hud, health: g.health, canvas: g.canvas, ambient: g.ambient,
      select: (id) => g.select(id), setLotMode: (mode) => g.setLotMode(mode),
      cancelGesture: () => g.input?.cancel(), exitLots: () => g.editing.exit(),
    };
  }

  /** The click dispatch as the clicks module sees it: tools and actions, never a copy of the world. */
  private clickHost(): ClickHost {
    const g = this;
    return {
      tool: g.tool, itemRemove: g.itemRemove, forestOne: g.forestOne, zoneBlock: g.zoneBlock, transitTerminal: g.transitTerminal,
      inspector: g.inspector, riverPts: g.river.points, itemTool: g.itemTool, roadTool: g.roadTool, zoneTool: g.zoneTool, hud: g.hud,
      removePole: (hit) => g.removePole(hit),
      clickBuilding: (hit, shift) => g.clickBuilding(hit, shift),
      clickTransit: (hit, terminal) => g.lines.click(hit, terminal),
      clickSky: (x, z) => g.clouds.click(x, z),
      plantTree: (x, z) => g.plantTree(x, z),
      placePerson: (x, z) => g.placePerson(x, z),
      shoot: (x, z) => g.shoot(x, z),
      bomb: (x, z) => g.bomb(x, z),
      weatherStrike: (hit) => g.weather.strikeAt(g.rig.eye, hit.x, hit.z, heightAt(g.world.heights, hit.x, hit.z)),
    };
  }

  /**
   * For photo scripts, in-game checks and tests: the same actions as the tools (app/scriptApi.ts). Built as a field, so
   * before the constructor's body: every part is read through an accessor when an action runs, never captured here
   * (most parts are made in the constructor).
   */
  readonly api: ScriptApi = (() => {
    const g = this;
    return createScriptApi({
      get world() { return g.world; }, get commands() { return g.commands; }, get pool() { return g.pool; },
      get vehicles() { return g.vehicles; }, get rig() { return g.rig; }, get weather() { return g.weather; },
      get river() { return g.river; }, get itemTool() { return g.itemTool; }, get roadTool() { return g.roadTool; },
      get zoneTool() { return g.zoneTool; }, get lines() { return g.lines; }, get transit() { return g.transit; },
      get growth() { return g.growth; }, get saving() { return g.saving; }, get editing() { return g.editing; },
      get selected() { return g.selected; },
      toggleFollow: () => g.toggleFollow(), setBiome: (b) => g.setBiome(b), bomb: (x, z) => g.bomb(x, z),
      manoeuvres: () => new Promise((resolve) => { g.manoeuvreWait = resolve; g.sim.postMessage({ type: 'probeManoeuvres' } satisfies ToSim); }),
    });
  })();

  /**
   * What the automation contract drives (app/automation.ts, published by main.ts as window.__roadcraft): the owners,
   * read when a member runs (a field, so before the constructor's body: nothing is captured here).
   */
  readonly automation: AutomationHost = (() => {
    const g = this;
    return {
      get world() { return g.world; }, get actions() { return g.api; }, get ui() { return g.hudActions; },
      view: (x, z, yaw, pitch, dist, hour) => g.view(x, z, yaw, pitch, dist, hour),
      pose: () => ({ x: g.rig.target.x, y: g.rig.target.y, z: g.rig.target.z, yaw: g.rig.yaw, pitch: g.rig.pitch, dist: g.rig.dist, turning: g.rig.turning, mode: g.rig.mode, eye: { x: g.rig.eye.x, y: g.rig.eye.y, z: g.rig.eye.z } }),
      place: (p) => { if (p.yaw !== undefined) g.rig.yaw = p.yaw; if (p.pitch !== undefined) g.rig.pitch = p.pitch; if (p.dist !== undefined) g.rig.dist = p.dist; },
      pick: (fx, fy) => g.rig.pick(fx, fy),
      toScreen: (x, y, z) => {
        const v = new THREE.Vector3(x, y, z).project(g.rig.camera);
        if (v.z > 1) return null;
        const r = g.canvas.getBoundingClientRect();
        return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
      },
      settle: (n) => g.settle(n), stats: () => g.stats(), drawnStats: () => g.drawnStats(), gpu: () => g.gpuTiming,
      profile: () => g.profile,
      tool: () => g.tool,
      click: (x, z, shift, alt) => {
        const hit = new THREE.Vector3(x, heightAt(g.world.heights, x, z), z);
        // the hover a still pointer gets from the frame before its release (split, upgrade and bulldoze act on it)
        if (g.tool === 'building') g.hoverLotTool(hit);
        else if (g.tool === 'river') g.river.hover(hit);
        else if (ROAD_TOOLS.includes(g.tool) && g.tool !== 'free') g.roadTool.hover(hit);
        else if (g.tool === 'streetscape' || g.tool === 'barrier') g.itemTool.hover(hit);
        clickTool(g.clickHost(), hit, shift, alt);
      },
      toolOptions: () => {
        const r = g.roadTool;
        return {
          road: { mode: r.mode, profile: r.profile, base: r.base, lanes: r.options.lanes, width: r.options.width, parking: r.options.parking, elevation: r.elevation, ringRadius: r.ringRadius, snap: r.snapMode, furniture: r.furniture, cutWalls: r.cutWalls, blocks: { ...r.blocks } },
          zone: { zone: g.zoneTool.zone, radius: g.zoneTool.radius },
          brush: { mode: g.brush.mode, radius: g.brush.radius, strength: g.brush.strength },
          items: { poleLights: g.itemTool.poleLights, wallOpen: g.itemTool.open },
          lotPoints: g.editing.lotExtraPts.length,
          lots: { lotMode: g.editing.lotMode, lotExtra: g.editing.lotExtra, splitKind: g.editing.splitKind, splitParts: g.editing.splitParts, lotUse: g.editing.lotUse, newArch: g.editing.newArch, newFn: g.editing.newFn },
        };
      },
      options: () => ({ ...g.settings }), applyOptions: (p) => { g.prefs!.update(p); return g.applySettings(); },
      hour: () => g.hour, skyMode: () => g.skyMode,
      simStats: () => (g.simStats ? { ...g.simStats } : null),
      simInspect: (x, z, r) => new Promise((resolve) => {
        const h = (e: MessageEvent<FromSim>) => { if (e.data?.type === 'inspect') { g.sim.removeEventListener('message', h); resolve(e.data); } };
        g.sim.addEventListener('message', h);
        g.sim.postMessage({ type: 'inspect', x, z, r } satisfies ToSim);
      }),
      simPost: (m) => g.sim.postMessage(m),
      poses: () => g.poses,
      lines: () => g.transit.lines,
      propsProbe: () => g.props.probe(g.parts.renderer),
      sun: () => { const p = g.parts.sun.position, l = p.length() || 1; return { x: p.x / l, y: p.y / l, z: p.z / l }; },
      framesDrawn: () => g.framesDrawn,
      toast: (text) => g.hud.toast(text),
      following: () => !!g.vehicles.follow,
      followAt: (x, z, r) => g.vehicles.pick(x, z, r),
      peopleReady: () => g.vehicles.people.ready,
      growthRate: (r) => { if (r !== undefined) g.growth.rate = r; return g.growth.rate; },
      signals: () => new Uint8Array(g.signalsSab),
      saveStore: () => g.saving.saveStore,
      selected: () => g.selected,
      design: (d, floors) => g.applyDesign(d, floors),
      peopleGroups: () => g.vehicles.people.creator?.size ?? null,
      hitKind: () => g.hitKind,
      bombForce: () => g.bombForce,
      boltShown: () => g.weather.boltShown,
      layers: () => ({ ...g.viewState.layers }),
      insideOn: () => g.inside.on,
      clouds: () => g.clouds.list.length,
      terminals: () => g.transit.terminals,
      autosaveNow: () => { g.autosaveAt = 0; },
      demandSentAt: () => g.simLink.demandSentAt,
      setHour: (h) => g.world.setHour(h),
      weather: () => ({ clouds: g.weather.fixed?.clouds ?? cloudsU.value, rain: g.weather.fixed?.rain ?? rainU.value, storm: g.weather.fixed?.storm ?? 0, wind: g.weather.windFixed }),
      inspector: () => ({ open: g.inspector.isOpen, seg: g.inspector.seg }),
      insideId: () => g.viewState.insideId,
      audioStart: () => g.ambient.start(),
      audioState: () => g.ambient.state,
      green: () => g.green,
      previewShown: () => g.preview.mesh.visible,
      registerBuilderTab: (id, render) => g.hud.registerBuilderTab(id, render),
      freeLots: async () => {
        // the lots are made by jobs for the dirty cells: asked, then waited for, as the frame asks for them
        for (let k = 0; k < 40 && !g.growth.hasLots; k++) { g.growth.processDirty(); await g.pool.whenIdle(); await new Promise((r) => setTimeout(r, 250)); }
        return g.growth.freeLots();
      },
      lastPeople: () => g.vehicles.people.creator?.lastOptions ?? null,
      demolitionDrawn: () => {
        let n = 0;
        g.demolition.group.traverseVisible((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh).count > 0 : (o as THREE.Mesh).isMesh) n++; });
        return n;
      },
      setTool: (t) => g.setTool(t), select: (id) => g.select(id), inspect: (x, z) => g.inspector.pick(x, z),
      undo: () => g.commands.undo(), redo: () => g.commands.redo(), canUndo: () => g.commands.canUndo,
      save: (quiet) => g.saving.save(quiet), load: () => g.saving.load(), importMap: (f) => g.saving.importMap(f), newMap: (seed) => g.saving.newMap(seed),
      generated: (medium) => g.cities.generated(medium), testCity: () => g.cities.testCity(),
      paused: () => g.clock.paused, togglePause: () => g.togglePause(), speed: (n) => g.setSpeed(n),
    };
  })();

  private skyHint(): void { skyHintOf(this.toolHost()); }

  /** People creator: standing (saved item) or walking (simulation pedestrians in the chosen clothes). */
  /** The people creator screen's choices (src/render/people/creator.ts), used when the cooked people are loaded. */
  private personOptions: Partial<PersonOptions> = {};

  private placePerson(x: number, z: number): void {
    // the cooked people (people front): a group of 1 to 20 with the screen's clothes, height, mode and object
    if (this.vehicles.people.creator) {
      const n = this.personOptions.count ?? 1;
      if (this.api.people(x, z, this.personOptions)) { this.hud.toast(n === 1 ? t('game.toast.personCreated') : t('game.toast.peopleCreated', { n })); return; }
    }
    const p = this.personSpec;
    if (p.walk) {
      this.sim.postMessage({ type: 'people', x, z, count: p.count, color: p.color } satisfies ToSim);
      this.hud.toast(p.count === 1 ? t('game.toast.personWalks') : t('game.toast.peopleWalk', { n: p.count }));
      return;
    }
    const c = new ItemsCommand(this.world.items, 'cmd.place.person');
    for (let k = 0; k < p.count; k++) {
      const a = (k / Math.max(1, p.count)) * Math.PI * 2, d = k ? 1.4 + k * 0.15 : 0;
      const yaw = Math.atan2(this.rig.eye.x - x, this.rig.eye.z - z);
      c.add([x + Math.cos(a) * d, z + Math.sin(a) * d, yaw, 0, Item.Person, (p.color & 15) | ((p.height & 15) << 4)]);
    }
    this.commands.push(c);
  }

  private shoot(x: number, z: number): void {
    this.ambient.sfx('shot');
    this.hitKind = 'pistol';
    this.sim.postMessage({ type: 'hit', x, z, r: 3, one: true } satisfies ToSim);
  }

  /** Bomb: the feature owns the world change and the effect context; the page only wires them. */
  private bomb(x: number, z: number): void {
    this.demolition.bomb(x, z, this.bombForce, this.rig.camera.position, (kind) => { this.hitKind = kind; });
  }

  private onHit(people: number, vehicles: number): void {
    const k = this.hitKind;
    this.hitKind = null;
    if (k === 'pistol') this.hud.toast(people ? t('game.toast.hit') : t('game.toast.missed'));
    else if (k === 'bomb' && people + vehicles > 0) this.hud.toast(t('game.toast.victims', { people: plural('status.people', people), vehicles: plural('status.vehicles', vehicles) }));
  }

  /** One tree of the chosen species (mixed: oak or cypress at random). */
  private plantTree(x: number, z: number): void {
    const sp = this.forestSpecies === 0 ? (Math.random() < 0.5 ? 1 : 2) : this.forestSpecies;
    const type = sp === 1 ? Item.Tree : sp === 2 ? Item.Conifer : Item.Palm;
    const c = new ItemsCommand(this.world.items, 'cmd.place.tree');
    c.add([x, z, Math.random() * Math.PI * 2, 0, type, 0]);
    this.commands.push(c);
  }

  private setBiome(b: number): void {
    this.world.biome = b;
    this.terrain.setBiome(b);
    this.hud.setBiome(b);
    // the trees of the whole map change species: rebuild the props
    for (let c = 0; c < CELL_COUNT; c++) this.world.dirty.mark(c, Dirty.Props);
  }

  private setElevation(e: number): void {
    this.roadTool.setElevation(e);
    this.hud.setElevation(this.roadTool.elevation);
  }

  private setRadius(r: number): void {
    this.brush.radius = Math.max(5, Math.min(400, r));
    this.hud.setRadius(this.brush.radius);
  }

  private setView(v: 'persp' | 'iso' | 'top'): void {
    if (v === 'top') this.rig.topDown(); else this.rig.setMode(v);
    this.hud.viewChanged();
  }

  // ----------------------------------------------------------- buildings

  private select(id: number): void { selectBuilding(this.selectionHost(), id); }

  private showSelection(): void { showSelectionOf(this.selectionHost()); }

  /** The selection as the buildings module sees it: the Game keeps the selected id and the world. */
  private selectionHost(): SelectionHost {
    const g = this;
    return {
      get selected() { return g.selected; }, set selected(v) { g.selected = v; },
      world: g.world, hud: g.hud, preview: g.preview, tool: g.tool, creator: g.creator,
      addressOf: () => g.hudActions.addressOf(),
    };
  }

  /**
   * The title screen: at start, and again from the menu. A new city from its seed and size (another size reloads the
   * page with it), an empty map, the last game (with no save it comes back), the options. A city on screen with
   * unsaved work is asked about first.
   */
  private showStart(): void {
    if (this.startMenu) { this.startMenu.show(); return; }
    this.startMenu = new StartMenu(document.getElementById('hud')!, this.parts.maxLayers, {
      newCity: (seed, tiles) => {
        if (!this.discardOk()) { this.startMenu?.show(); return; }
        if (tiles !== MAP_TILES) { reloadWithMap(tiles, `city&seed=${seed}`); return; }
        this.world.seed = seed; void this.generatedCity();
      },
      empty: (tiles) => {
        if (!this.discardOk()) { this.startMenu?.show(); return; }
        if (tiles !== MAP_TILES) reloadWithMap(tiles, 'empty');
        else if (this.world.roads.segs.size || this.world.buildings.size) void this.saving.newMap();
      },
      load: () => {
        if (!this.discardOk()) { this.startMenu?.show(); return; }
        void this.saving.load().then((ok) => { if (!ok) this.startMenu?.show(); });
      },
      options: () => this.optionsPanel.open(),
    });
  }

  /** The graphics card's name as the driver gives it ('' when the browser does not say). */
  private gpuName(): string {
    const backend = (this.parts.renderer as unknown as { backend?: { device?: { adapterInfo?: { description?: string; vendor?: string; architecture?: string } }; gl?: WebGL2RenderingContext } }).backend;
    const info = backend?.device?.adapterInfo;
    if (info) return info.description || [info.vendor, info.architecture].filter(Boolean).join(' ');
    const gl = backend?.gl, ext = gl?.getExtension('WEBGL_debug_renderer_info');
    const raw = gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    // "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x…) Direct3D11 …)" → "NVIDIA GeForce RTX 3060", as Roadcraft 4.0
    return raw.replace(/^ANGLE \([^,]*,\s*/, '').replace(/\s*\(0x[0-9A-Fa-f]+\).*$/, '').replace(/\s*Direct3D.*$/, '');
  }

  /** The health panel's World tab: the latest edits and what the world holds now. */
  private healthWorld(): Array<[string, string]> {
    const w = this.world, now = Date.now();
    let dirty = 0;
    for (let i = 0; i < w.saveDirty.length; i++) dirty += w.saveDirty[i];
    return [
      ['buildings', String(w.buildings.size)], ['segments', String(w.roads.segs.size)], ['nodes', String(w.roads.nodes.size)],
      ['items', String(w.items.size)], ['impossible nodes', String(w.impossible.count)], ['lines', String(this.transit.lines.length)],
      ['unsaved tiles', String(dirty)], ['jobs idle', String(this.pool.isIdle())],
      ...this.changesLog.slice(0, 20).map(([at, label]): [string, string] => [`${((now - at) / 1000).toFixed(0)} s`, t(label)]),
    ];
  }

  /** The health panel's State tab: the game's state now. */
  private healthState(): Array<[string, string]> {
    const r = this.rig, st = this.simStats?.type === 'stats' ? this.simStats : null;
    return [
      ['tool', this.tool], ['lot mode', this.editing.lotMode], ['selected building', String(this.selected)], ['inspector', this.inspector.isOpen ? `segment ${this.inspector.seg}` : 'closed'],
      ['paused', String(this.clock.paused)], ['speed', String(this.clock.speed)], ['clock', `${this.hour.toFixed(2)} h ×${this.clock.daySpeed}`], ['sky', this.skyMode],
      ['camera', `${r.mode} ${r.target.x.toFixed(0)}, ${r.target.z.toFixed(0)} · ${r.dist.toFixed(0)} m · yaw ${(r.yaw * 180 / Math.PI).toFixed(0)}°`],
      ['undo / redo', `${this.commands.canUndo} / ${this.commands.canRedo}`], ['unsaved', String(this.unsaved)], ['lifecycle', this.life.state],
      ['money', this.world.unlimited ? '∞' : String(Math.round(this.world.money))],
      ['simulation', st ? `${st.cars} cars · ${st.micro} near · ${st.peds} pedestrians` : '—'],
    ];
  }

  /** Follows the vehicle nearest the centre of the screen, or lets go. */
  private toggleFollow(): void {
    if (this.vehicles.follow) { this.vehicles.follow = null; return; }
    const c = this.rig.target;
    if (!this.vehicles.pick(c.x, c.z, Math.max(30, this.rig.dist * 0.4))) { this.hud.toast(t('game.toast.followNone')); return; }
    this.rig.dist = 16; this.rig.pitch = THREE.MathUtils.degToRad(14);
    this.hud.toast(t('game.toast.following'));
  }

  /** The start screen (shown at start, and again from the menu). */
  private startMenu: StartMenu | null = null;
  /** The impossible junction the top bar's warning showed last. */
  private impossibleVisit = -1;

  private setLotMode(m: LotMode): void { this.editing.setLotMode(m); }
  private hoverLotTool(hit: THREE.Vector3 | null): void { this.editing.hoverLotTool(hit); }
  /** Lot tool click by the verification scripts (the lot mode decides what it does). */
  clickLotTool(hit: THREE.Vector3): void { this.editing.clickLotTool(hit); }
  private finishPoly(): void { this.editing.finishPoly(); }
  private grabCorner(hit: THREE.Vector3 | null): boolean { return this.editing.grabCorner(hit); }
  private dropCorner(hit: THREE.Vector3 | null): void { this.editing.dropCorner(hit); }
  private featureActions(): LotFeatureActions { return this.editing.featureActions(); }
  private clickBuilding(hit: THREE.Vector3 | null, shift = false): void { this.editing.clickBuilding(hit, shift); }
  private editSelected(dFloors: number, arch?: number, fn?: number): void { this.editing.editSelected(dFloors, arch, fn); }
  private insideCmd(c: 'toggle' | 'up' | 'down'): void { this.editing.insideCmd(c); }
  private applyDesign(d: Design | null, floors?: number): void { this.editing.applyDesign(d, floors); }
  private demolishSelected(): void { this.editing.demolishSelected(); }

  private manoeuvreWait: ((m: Extract<FromSim, { type: 'manoeuvres' }>) => void) | null = null;
  /** Lot modes added by the gameplay front (split by line, curve side) and the points clicked so far. */

  // ------------------------------------------------------ generated city



  /** Lets go of everything the page holds of the city on screen, before another one opens or is made. */
  private clearPage(): void {
    this.growth.clear();
    // lots still being made for the city that was on screen are not taken in by the next one
    this.pool.cancel('lots:');
    for (const l of this.layers) l.reset();
    this.props.clear();
    // the last city's wrecks, craters and soot
    this.demolition.clear();
    this.transit.clear();
    this.commands.clear();
    this.showLook();
    this.textSigns.version++;
  }

  /** Shows the map's look (World.look): water, weather, clouds, fog and road paint. */
  private showLook(): void {
    this.water.show(); this.fog.show(); this.sky.show(); this.clouds.show();
    showRoadPaint(this.world.look);
  }

  /**
   * Before an action that replaces the city on screen: when it has work not yet saved (edits, growth, ageing), the
   * player is asked. Synchronous, from the click (the buttons call it; the game's own flows do not ask).
   */
  private discardOk(): boolean {
    if (!this.unsaved && !this.world.saveDirty.includes(1)) return true;
    return window.confirm(t('save.discardConfirm'));
  }

  /** An opened map's extra (platform/mapExtra.ts) into the page's state: water, clock, money mode, paint, signs, names, terminals, clouds, fog, sky, weather. */
  private applyExtra(ex: MapExtra): void {
    const w = this.world;
    // the save's city clock (decay filed again); the time of day it set stays
    w.setClock(ex.clock);
    if (ex.unlimited !== null) w.unlimited = ex.unlimited;
    w.signTexts.clear(); for (const [k, v] of ex.signs) w.signTexts.set(k, v);
    w.streetNames.clear(); for (const [k, v] of ex.streets) w.streetNames.set(k, v);
    this.textSigns.version++;
    this.transit.terminals = ex.terminals; this.transit.version++;
    // the map's look (water, hand-set weather, clouds, fog, road paint); the sky mode is the player's, not the map's
    w.look.load(ex);
    this.showLook();
  }

  /** Ends a flow that rebuilds the world: the loading screen goes, the game is free; on failure, says why. */
  private endRebuild(err: unknown, what: string): void {
    this.hud.hideLoading();
    // the operation under way (a generation or an opening) ends: ready, or failed when the world is half built
    this.life.end(this.life.state as Operation, err);
    if (err === null) { this.homeView = this.rig.state(); return; }
    console.error(`${what} failed:`, err);
    this.hud.toast(t('game.toast.flowFailed', { what, message: (err as Error)?.message ?? String(err) }));
  }




  /** The whole city from the seed (app/cityFlows.ts); public for the checks (tools/check-save.mjs). */
  generatedCity(medium = false): Promise<void> { return this.cities.generated(medium); }

  // -------------------------------------------------- saving and loading





}


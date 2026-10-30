// Ties everything together: world, workers, camera, rendering, tools, saving and loading.
// The page only does input, interface, choosing what to draw, and drawing.

import * as THREE from 'three/webgpu';
import { MAP_SIZE, MAP_SIZES, MAP_TAG, MAP_TILES, TILE_SIZE } from './config.ts';

const FLASH_COLOR = new THREE.Color(0xdde6ff);
import { CommandStack } from './core/commands.ts';
import { CELL_COUNT, Dirty, TILE_COUNT, cellsOfTile, tileId, tileOfCell, tileOriginX, tileX } from './core/grid.ts';
import { JobPool } from './jobs/pool.ts';
import { wallsHeightOf } from './jobs/buildingGen.ts';
import { SEG_REC, SHAPE_SCALE, SHAPE_STRIDE, roadGraphTransfer, type BoxColumns, type JobResults, type RoadSave } from './shared/contracts/worker.ts';
import { CameraRig } from './render/cameraRig.ts';
import { createCity, createCityDetail } from './render/city.ts';
import { createRoads, createTrafficLook, setPaintStyle, trafficOverlayU, zoneOverlayU, type TrafficLook } from './render/roads.ts';
import type { CellLayer } from './render/cellLayer.ts';
import { createScene, setTimeOfDay, type SceneParts } from './render/scene.ts';
import { TerrainRenderer, gridU } from './render/terrain.ts';
import { MapSizeError, decodeMeta } from './platform/save.ts';
import { createPoseBuffers, PoseReader, viewPoseBuffers } from './shared/contracts/poses.ts';
import { encodeOps } from './sim/lanes.ts';
import { VehicleRenderer } from './render/vehicles.ts';
import type { PersonOptions } from './shared/contracts/people.ts';
import { PropRenderer } from './render/props.ts';
import { TransitRenderer } from './render/transit.ts';
import { Post } from './render/post.ts';
import { achieve } from './platform/steam.ts';
import { OptionsPanel, PRESETS, keepOverAddress, loadSettings, saveSettings, type Preset, type Settings } from './ui/options.ts';
import { StartMenu } from './ui/menu.ts';
import { Weather, cloudsU, flashU, rainU, windDirU, windU } from './render/weather.ts';
import { Ambient } from './platform/audio.ts';
import { Particles } from './render/particles.ts';
import { fmtInt, followLanguage, loose, onLanguageChange, plural, setLang, t } from './shared/i18n/index.ts';
import { HealthPanel } from './ui/health.ts';
import { Creator } from './ui/creator.ts';
import type { Design } from './world/design.ts';
import { currentU, fogLevel, foamU, nightU, waveU } from './render/scene.ts';
import { Transit } from './world/transit.ts';
import type { JunctionSpec } from './roads/control.ts';
import { PROFILES, PROFILE_INFO, customProfiles, onProfileAdded, setCustomProfiles, type Profile } from './roads/profiles.ts';
import { bez, bezD } from './roads/geometry.ts';
import { arrowCode } from './roads/laneLinks.ts';
import type { NetOp } from './roads/network.ts';
import type { FromSim, ToSim } from './sim/worker.ts';
import { Inspector } from './ui/inspector.ts';
import { BOMB_START } from './shared/contracts/bomb.ts';
import { dropBomb } from './features/demolition/bomb.ts';
import { demandFactor, zoomPercent } from './ui/readouts.ts';
import { ItemTool } from './tools/itemTool.ts';
import { GROUND_TOOLS, Hud, ROAD_TOOLS, TERRAIN_TOOLS, type HudActions, type LotMode, type SkyMode, type SkyToolState, type Tool, type WeatherCtl } from './ui/hud.ts';
import { CloudPuffs, MAX_CLOUDS, type Cloud } from './render/cloudPuffs.ts';
import { InsideView } from './render/inside.ts';
import { Blast } from './render/blast.ts';
import { TextSigns, signKey } from './render/textSigns.ts';
import { demolishBox } from './tools/demolish.ts';
import { lotAt, lotToWorld, polygonLot } from './world/lotEdit.ts';
import type { FeatureActions } from './tools/featureActions.ts';
import { addressAt, nameStreetCommand } from './roads/streetNames.ts';
import { laneCount, roadClasses } from './roads/roadVariant.ts';
import { CITY_STYLES, type CityStyle } from './jobs/cityField.ts';
import { Ground, GroundStroke, RiverCommand, WATER_MAP_RES, waterCoord, waterIndex } from './world/ground.ts';
import { ElementStroke, Item, ItemsCommand } from './world/items.ts';
import { RoadTool } from './tools/roadTool.ts';
import { ZoneTool } from './tools/zoneTool.ts';
import { Growth } from './world/growth.ts';
import { addCrossing, addUTurn, buildRoad, streetChain, demolishSeg, duplicateRoad, joinAt, moveNode, planRoad, reverseRoad, segPreview, snap, splitAt, bulbAt } from './roads/build.ts';
import { BULB_R, BULB_WALK } from './roads/junction.ts';
import { Zone } from './roads/zones.ts';
import { RoadPreview } from './render/preview.ts';
import { BrushStroke, FlattenMap, LANDFORM_ROCK, type BrushMode, type BrushParams } from './world/brush.ts';
import { START_MONEY, World } from './world/world.ts';
import { heightAt } from './world/heights.ts';
import { lineProfile } from './jobs/debugCity.ts';
import { FLAT_BIT } from './jobs/terrainGen.ts';
import { MapFileError, keepPreviousCity, packSlot, previousCities, readPackage, restorePrevious, savedIn, type SaveActions } from './platform/mapFile.ts';
import { SaveSlot, SlotLock, TileFileError, WRITES_AT_ONCE, limiter, openSaveStore, type FileStore, type Generation } from './platform/saveFiles.ts';
import { repairDanglingEnds } from './roads/repair.ts';
import { photoView, settlePool } from './app/photoHooks.ts';
import { loadSession, newMapSession, reloadWithMap, saveSession, type LoadHost, type NewMapHost, type SaveHost } from './app/session.ts';
import { setTool as setGameTool, skyHint as skyHintOf, type ToolHost } from './app/tools.ts';
import type { ClickHost } from './app/clicks.ts';
import { selectBuilding, showSelection as showSelectionOf, type SelectionHost } from './app/buildings.ts';
import { LotEditing } from './app/lotEditing.ts';
import { bindInput } from './app/input.ts';
import { errorText } from './shared/errors.ts';

const SLOT = 'cidade-1';
/** Still frames drawn before the loop rests (the temporal anti-aliasing converges in about this many). */
const STILL_FRAMES = 40;
/** Segments that fit in the occupancy map (2 directions per segment). */
export const OCCUPANCY_SEGS = 1 << 17;

export const status = { value: 'carregando' };
/** State exposed to the shell (automated photos and checks): `setLang` is the language menu's own action. */
const debug: { status: string; game: unknown; setLang: typeof setLang } = { get status() { return status.value; }, game: null, setLang };
(globalThis as { __cidade?: unknown }).__cidade = debug;

export class Game {
  readonly world = new World();
  readonly pool: JobPool;
  readonly commands = new CommandStack();
  readonly hud: Hud;
  /** The panel button actions (test scripts call the same thing the button does). */
  hudActions!: HudActions & FeatureActions & SaveActions;
  /** Measurement (?perf): where the time of slow frames went. */
  perfLog: string[] | null = null;
  private parts!: SceneParts;
  private rig: CameraRig;
  private terrain: TerrainRenderer;
  private city: CellLayer;
  private cityDetail: CellLayer;
  private roads: CellLayer;
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
  private settings!: Settings;
  private optionsPanel!: OptionsPanel;
  /** Simulation speed (1, 2, 4), the zone colours shown with any tool, stops clicked as terminals. */
  private simSpeed = 1;
  private zoneLayer = false;
  private transitTerminal = false;
  /** Clicks with the street item tools remove instead of placing (Remove poles; Shift+click does the same). */
  private itemRemove = false;
  /** A wall is being traced with the barrier tool (its first point was clicked). */
  private wallOpen = false;
  private health!: HealthPanel;
  /** The developer panels (F8, F9, the worst case test): ?dev, roadcraft.dev = 1 in the browser's storage, or the dev server. */
  private readonly developer = ((): boolean => {
    let stored = false;
    try { stored = localStorage.getItem('roadcraft.dev') === '1'; } catch { /* no storage */ }
    return stored || new URLSearchParams(location.search).has('dev') || !!(import.meta as { env?: { DEV?: boolean } }).env?.DEV;
  })();
  /** The latest edits (the health panel's World tab): when, what. */
  private changesLog: Array<[number, string]> = [];
  /** The view the city opened with (Home goes back to it). */
  private homeView: Float64Array | null = null;
  private creator!: Creator;
  private lineSel = 0;
  private linesSent = -1;
  private roadsVersion = 0;
  private occupancySab: SharedArrayBuffer;
  private trafficLook: TrafficLook;
  private occSent = 0;
  private netOps: NetOp[] = [];
  /** Nodes whose hand-adjusted arrows need to be recomputed. */
  private arrowNodes = new Set<number>();
  private camSent = 0;
  /** Doors sent to the simulation: when, and from where (the camera moving or the city growing sends them again). */
  private doorsSent = 0;
  private doorsAt = { x: Infinity, z: Infinity, count: -1 };
  private demandSent = 0;
  private canvas: HTMLCanvasElement;

  private tool: Tool = 'camera';
  private brush: BrushParams = { mode: 'raise', radius: 60, strength: 0.4 };
  private stroke: BrushStroke | GroundStroke | null = null;
  /** Chosen landform and the rock painted along with it. */
  private landformMode: BrushMode = 'mesa';
  private rockStroke: GroundStroke | null = null;
  /** Ground elements brush. */
  private elem = { kind: 30, mode: 'lay' as 'lay' | 'eraseKind' | 'eraseAll', density: 8, size: 7 };
  private elemStroke: ElementStroke | null = null;
  private groundKind: number = Ground.Sand;
  private forestCut = false;
  private forestSpecies = 0;
  /** Trees: one per click instead of the brush. */
  private forestOne = false;
  private riverWidth = 14;
  private riverPts: Array<[number, number]> = [];
  private pointer = { x: 0, y: 0, inside: false };
  private drag: 'none' | 'pan' | 'rotate' | 'brush' | 'click' | 'zone' | 'node' | 'box' | 'row' | 'free' | 'lots' = 'none';
  /** Points of the lot delete stroke being dragged (Roadcraft: every lot under it goes, in one step). */
  private lotStroke: Array<[number, number]> = [];
  /** Demolish by rectangle: corner where the drag started. */
  private boxStart: THREE.Vector3 | null = null;
  private roadTool: RoadTool;
  private inspector!: Inspector;
  private itemTool!: ItemTool;
  private zoneTool: ZoneTool;
  private growth: Growth;
  private selected = -1;
  /** Hand-drawn lot: points clicked so far (null = not in this mode). */
  private lotPts: Array<[number, number]> | null = null;
  /** Lot tool and its states (polygon, first lot of a join, dragged corner). */
  private lotMode: LotMode = 'edit';
  private polyPts: Array<[number, number]> = [];
  private joinFirst = -1;
  private cornerDrag: { id: number; k: number } | null = null;
  private splitKind: 'side' | 'depth' = 'side';
  private splitParts = 2;
  private zoneBlock = false;
  private lotUse = 1;
  private newArch = -1;
  private newFn = 0;
  private preview = new RoadPreview();
  /** Lot and building editing (app/lotEditing.ts). */
  private readonly editing: LotEditing;
  private last = 0;
  private busy = false;
  /** Generating the city: lots wait for the terrain to be conformed. */
  private generating = false;
  /** Time of day and clock speed (game hours per real minute). */
  private hour = 10;
  private clockSpeed = 1;
  /** Chosen sky and weather set by the player (both go into the save). */
  private skyMode: SkyMode = 'dia'; // as Roadcraft 4.0: a game opens in "always day"
  private weatherCtl: WeatherCtl | null = null;
  private waterCtl = { waves: 0.3, foam: 0.4, current: 0.5 };
  /** Clouds placed by the player and the state of the Sky tool. */
  private clouds: Cloud[] = [];
  private cloudView = new CloudPuffs();
  private skyTool: SkyToolState = { cloud: 'add', fog: 'none', size: 500, base: 900, density: 0.8, fogHeight: 6 };
  private cloudGrab = -1;
  /** Inside view: the building and the floor shown. */
  private inside = new InsideView();
  private textSigns!: TextSigns;
  private blast = new Blast();
  /** People from the creator and the bomb strength. */
  private personSpec = { color: 3, height: 7, walk: false, count: 1 };
  private bombForce = BOMB_START;
  private hitKind: 'pistol' | 'bomb' | null = null;
  private insideId = -1;
  private insideFloor = 0;
  /** Something changed since the last save (autosave every 2 min). Every change bumps `unsavedSerial`. */
  private unsavedNow = false;
  private unsavedSerial = 0;
  private get unsaved(): boolean { return this.unsavedNow; }
  private set unsaved(v: boolean) { if (v) this.unsavedSerial++; this.unsavedNow = v; }
  private autosaveAt = 0;
  /** Pause (Space): clock and simulation stopped. */
  private paused = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    debug.game = this;
    this.pool = new JobPool({ heights: this.world.heightsSab, ground: this.world.groundSab, water: this.world.waterSab });
    this.rig = new CameraRig(this.world.heights);
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
    this.layers = [this.roads, this.city, this.cityDetail];
    // the near levels are chosen by the 3D distance (from high up the cells under the camera are far)
    for (const l of this.layers) l.groundAt = (x, z) => heightAt(this.world.heights, x, z);

    const posesSab = createPoseBuffers();
    this.poses = new PoseReader(viewPoseBuffers(posesSab));
    this.sim = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module', name: `sim ${MAP_TAG}` });
    this.sim.onmessage = (e: MessageEvent<FromSim>) => {
      if (e.data.type === 'stats') this.trackTrips(e.data);
      else if (e.data.type === 'probe') this.inspector?.showProbe(e.data);
      else if (e.data.type === 'probeNode') this.inspector?.showNodeProbe(e.data);
      else if (e.data.type === 'hit') this.onHit(e.data.people, e.data.vehicles);
      else if (e.data.type === 'autoControl') this.world.roads.setFlow(e.data.node, e.data.flow);
      else if (e.data.type === 'manoeuvres') { const r = this.manoeuvreWait; this.manoeuvreWait = null; r?.(e.data); }
      else if (e.data.type === 'resync') this.resyncSim(e.data.reason);
      else if (e.data.type === 'inspect') { /* read by the motion probe's own listener (tools/check-sim.mjs) */ }
      else { console.error('simulação:', e.data.message); this.health?.add('erro', `simulação: ${e.data.message.split(String.fromCharCode(10))[0]}`); }
    };
    this.sim.postMessage({ type: 'init', poses: posesSab, heights: this.world.heightsSab, occupancy: this.occupancySab, signals: this.signalsSab, tickHz: 20 } satisfies ToSim);
    this.vehicles = new VehicleRenderer(this.poses);
    // profiles made in the editor: the workers need them before the segments that use them
    onProfileAdded(() => {
      const list = customProfiles();
      this.pool.broadcast({ type: 'profiles', list });
      this.sim.postMessage({ type: 'profiles', list } satisfies ToSim);
    });
    // the simulation mirrors the network: changes go as a batch every frame
    this.world.roads.listeners.push((op) => this.netOps.push(op));
    // hand-adjusted arrows: nodes to redo when the control or the segments change
    this.world.roads.listeners.push((op) => {
      const arr = this.trafficLook.arrows.image.data as Float32Array;
      if (op.t === 'junction') this.arrowNodes.add(op.id);
      else if (op.t === 'addNode' && op.rec.j) this.arrowNodes.add(op.rec.id);
      else if (op.t === 'addSeg') { this.arrowNodes.add(op.rec.a); this.arrowNodes.add(op.rec.b); }
      else if (op.t === 'remSeg') { if (op.id * 2 + 1 < arr.length && (arr[op.id * 2] || arr[op.id * 2 + 1])) { arr[op.id * 2] = arr[op.id * 2 + 1] = 0; this.trafficLook.arrows.needsUpdate = true; } }
      else if (op.t === 'clear') { arr.fill(0); this.trafficLook.arrows.needsUpdate = true; }
    });

    const ge = this;
    this.editing = new LotEditing({
      world: this.world, preview: this.preview, get hud() { return ge.hud; }, commands: this.commands,
      get growth() { return ge.growth; },
      get selected() { return ge.selected; },
      rig: this.rig, inside: this.inside,
      get insideId() { return ge.insideId; }, set insideId(v) { ge.insideId = v; },
      get insideFloor() { return ge.insideFloor; }, set insideFloor(v) { ge.insideFloor = v; },
      get settings() { return ge.settings; },
      get transit() { return ge.transit; },
      get lineSel() { return ge.lineSel; }, set lineSel(v) { ge.lineSel = v; },
      get lotPts() { return ge.lotPts; }, set lotPts(v) { ge.lotPts = v; },
      get lotMode() { return ge.lotMode; }, set lotMode(v) { ge.lotMode = v; },
      get lotExtra() { return ge.lotExtra; }, set lotExtra(v) { ge.lotExtra = v; },
      get lotExtraPts() { return ge.lotExtraPts; }, set lotExtraPts(v) { ge.lotExtraPts = v; },
      get polyPts() { return ge.polyPts; },
      get joinFirst() { return ge.joinFirst; }, set joinFirst(v) { ge.joinFirst = v; },
      get cornerDrag() { return ge.cornerDrag; }, set cornerDrag(v) { ge.cornerDrag = v; },
      get splitKind() { return ge.splitKind; },
      get splitParts() { return ge.splitParts; },
      get lotUse() { return ge.lotUse; },
      get newArch() { return ge.newArch; },
      get newFn() { return ge.newFn; },
      set unsaved(v: boolean) { ge.unsaved = v; },
      select: (id) => ge.select(id),
      setTool: (t) => ge.setTool(t),
      showSelection: () => ge.showSelection(),
    });
    this.hud = new Hud(this.hudActions = Object.assign(this.featureActions(), this.saveActions(), {
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
      riverWidth: (w) => { this.riverWidth = w; },
      elements: (e) => { this.elem = e; },
      landform: (m) => { this.landformMode = m as BrushMode; if (this.tool === 'landform') this.brush.mode = this.landformMode; },
      flattenMap: () => {
        if (!window.confirm(t('game.confirm.flattenMap'))) return;
        this.commands.run(new FlattenMap(this.world, heightAt(this.world.heights, this.rig.target.x, this.rig.target.z)));
        this.hud.toast(t('game.toast.flattened'));
      },
      weather: (w) => this.setWeather(w),
      sky: (m) => { this.skyMode = m; this.unsaved = true; },
      personSpec: (p) => { this.personSpec = p; },
      personOptions: (o) => { this.personOptions = o; },
      peopleCatalog: () => this.vehicles.people.catalog(),
      bombForce: (f) => { this.bombForce = f; },
      roadKeys: (patch) => { Object.assign(this.settings, patch); saveSettings(this.settings); },
      water: (w) => this.setWater(w),
      skyTool: (s) => { this.skyTool = s; this.skyHint(); },
      scatterClouds: (n, v) => this.scatterClouds(n, v),
      clearClouds: () => this.setClouds([], 'apagar nuvens'),
      fogLevel: (v) => { fogLevel.value = v; this.unsaved = true; },
      radius: (r) => { this.brush.radius = r; },
      strength: (s) => { this.brush.strength = s; },
      undo: () => this.history(false),
      redo: () => this.history(true),
      view: (v) => this.setView(v),
      save: () => void this.save(),
      load: () => { if (this.discardOk()) void this.load(); },
      exportMap: () => void this.exportMap(),
      importMap: (f) => { if (this.discardOk()) void this.importMap(f); },
      newMap: () => { if (this.discardOk()) void this.newMap(); },
      testCity: () => { if (this.discardOk()) void this.testCity(); },
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
      grid: () => { gridU.value = gridU.value > 0.5 ? 0 : 1; this.hud.setGrid(gridU.value > 0.5); },
      north: () => this.rig.turnTo(0),
      line: (id) => { this.lineSel = id; },
      newLine: () => this.newLine(),
      // a station tab works on a line of its mode: the last one of that mode, or a new one at the first click
      lineMode: (m) => {
        this.lineMode = m;
        if ((this.transit.line(this.lineSel)?.mode ?? 0) !== m) this.lineSel = [...this.transit.lines].reverse().find((l) => (l.mode ?? 0) === m)?.id ?? 0;
      },
      buses: (d) => { const l = this.transit.line(this.lineSel); const c = l && this.transit.setBuses(l.id, l.buses + d); if (c) this.commands.run(c); },
      deleteLine: () => { const c = this.transit.removeLine(this.lineSel); if (c) { this.commands.run(c); this.lineSel = this.transit.lines[0]?.id ?? 0; } },
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
      style: (a) => { if (this.selected >= 0) this.editSelected(0, a); else this.newArch = a; },
      buildingFn: (f) => { if (this.selected >= 0) this.editSelected(0, undefined, f); else this.newFn = f; },
      lotMode: (m) => this.setLotMode(m),
      lotSplit: (k, n) => { this.splitKind = k; this.splitParts = n; },
      zoneFill: (b) => { this.zoneBlock = b; this.hud.setHint(b ? t('game.hint.zone.block') : t('game.hint.zone')); },
      lotUse: (z) => { this.lotUse = z; },
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
      zoneLayer: (on) => { this.zoneLayer = on; zoneOverlayU.value = on || this.tool === 'zone' ? 1 : 0; },
      simulation: (sim) => { Object.assign(this.settings, sim); saveSettings(this.settings); this.demandSent = 0; },
      settings: () => {
        const st = this.settings;
        return { traffic: st?.traffic ?? 1, people: st?.people ?? 1, demand: st?.demand ?? 'normal', paint: st?.paint ?? 'br', furniture: st?.furniture ?? 0, roadUp: st?.roadUp ?? 'PageUp', roadDown: st?.roadDown ?? 'PageDown', roadAlign: st?.roadAlign ?? 'KeyV', preset: st?.preset ?? 'alto', webgpu: !!this.parts?.isWebGPU };
      },
      paint: (style) => { this.settings.paint = style; saveSettings(this.settings); setPaintStyle(style); },
      furniture: (n) => { this.settings.furniture = n; saveSettings(this.settings); this.roadTool.furniture = n; },
      ring: (f) => { this.roadTool.ringBy(f); this.hud.setRing(this.roadTool.ringRadius); },
      terminal: (on) => { this.transitTerminal = on; },
      itemRemove: (on) => { this.itemRemove = on; },
      cameraNumbers: () => ({ zoom: zoomPercent(this.canvas.clientHeight, this.rig.dist, this.rig.persp.fov), x: this.rig.target.x, z: this.rig.target.z }),
      health: () => { if (this.developer) this.health.toggle(); },
      developer: () => this.developer,
      healthLevel: () => this.health?.level() ?? 'ok',
      quality: (p) => {
        if (!this.parts.isWebGPU || !(p in PRESETS)) return;
        const s = { ...this.settings, ...PRESETS[p as Preset], preset: p as Preset };
        saveSettings(s);
        void this.applySettings(s);
      },
      resetView: () => { if (this.homeView) this.rig.restore(this.homeView); },
      environment: () => ({ water: { ...this.waterCtl }, weather: this.weatherCtl ? { ...this.weatherCtl } : null, fog: fogLevel.value }),
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
    } satisfies HudActions));
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
      this.ambient.sfx(l.startsWith('demolir') || l.startsWith('remover') || l.startsWith('tirar') || l.startsWith('apagar') ? 'demolish'
        : l.startsWith('construir') || l === 'rotatória' || l.startsWith('trocar') || l === 'lote desenhado' || l === 'muro' ? 'build' : 'place'); // not for the player: undo labels pick the sound (B60)
    };
    this.commands.onChange = () => {
      this.unsaved = true; this.hud.setHistory(this.commands.canUndo, this.commands.canRedo); this.inspector.refresh();
      // the building panel shows the building as it is now (or none, once undo took it away)
      if (this.selected >= 0) this.select(this.selected);
    };
    this.commands.onError = (err, c, redo) => {
      console.error(err);
      this.hud.toast(t(redo ? 'history.redoFailed' : 'history.undoFailed', { label: loose(c.label), message: (err as Error)?.message ?? String(err) }));
    };
    // the language changes without reloading (Roadcraft 4.0, main.ts:3832): the panels the game fills write again
    onLanguageChange(() => { this.inspector.refresh(); if (this.selected >= 0) this.select(this.selected); });
    // closing: in the desktop game the window waits for the save; in the browser the page asks before leaving
    const app = (window as { roadcraftApp?: { onClosing(fn: () => void): void; canClose(): void } }).roadcraftApp;
    if (app) app.onClosing(() => void this.saveBeforeClose().finally(() => app.canClose()));
    else window.addEventListener('beforeunload', (e) => { if (this.unsaved || this.world.saveDirty.includes(1)) { e.preventDefault(); e.returnValue = ''; } });
    this.hud.setHistory(false, false);
    this.setTool('camera');
  }

  async start(): Promise<void> {
    const params = new URLSearchParams(location.search);
    this.world.seed = Number(params.get('seed') ?? 1) >>> 0;
    this.world.gameId = (Math.random() * 2 ** 32) >>> 0;
    // a photo at a set hour (?hora) shows that hour's light: the sky follows the clock
    if (params.has('hora')) { this.hour = Number(params.get('hora')) % 24; this.clockSpeed = 0; this.skyMode = 'ciclo'; }
    this.hud.setSky(this.skyMode);
    this.weather.onStrike = (d) => this.ambient.thunder(d);
    if (params.has('tempestade')) this.weather.fixed = { clouds: 1, rain: 1, storm: 1 };
    else if (params.has('chuva')) this.weather.fixed = { clouds: 0.95, rain: 0.9 };
    else if (params.has('limpo')) this.weather.fixed = { clouds: 0.15, rain: 0 };

    this.hud.showLoading(t('game.loading.video'));
    this.parts = await createScene(this.canvas);
    console.log(`camadas de textura: ${this.parts.maxLayers}, mapa ${MAP_TILES} (${location.search})`);
    if (MAP_TILES * MAP_TILES > this.parts.maxLayers) {
      // the GPU cannot hold this map size: fall back to the largest that fits
      const fit = [...MAP_SIZES].reverse().find((t) => t * t <= this.parts.maxLayers) ?? 10;
      reloadWithMap(fit, 'grande');
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
    scene.add(this.particles.mesh);
    scene.add(this.cloudView.mesh);
    scene.add(this.inside.group);
    scene.add(this.blast.group);
    this.textSigns = new TextSigns(this.world, this.world.signTexts);
    scene.add(this.textSigns.group);
    this.itemTool.onText = (text, x, z, seg, street) => {
      const w = this.world, key = signKey(x, z);
      const chain = street && seg >= 0 ? streetChain(w, seg) : [];
      const before = chain.map((s) => w.streetNames.get(s));
      const apply = () => { w.signTexts.set(key, text); for (const s of chain) w.streetNames.set(s, text); this.textSigns.version++; this.unsaved = true; };
      const invert = () => { w.signTexts.delete(key); chain.forEach((s, i) => { const b = before[i]; if (b === undefined) w.streetNames.delete(s); else w.streetNames.set(s, b); }); this.textSigns.version++; };
      this.commands.run({ label: 'texto da placa', apply, invert });
      if (street && chain.length) this.hud.toast(t('game.toast.streetNamed', { name: text }));
    };

    this.hud.showLoading(t('game.loading.terrain'));
    await this.generateTerrain();

    // all shaders compiled here, never during play
    this.hud.showLoading(t('game.loading.shaders'));
    const warm = new THREE.Group();
    for (const l of this.layers) warm.add(l.warmupMesh());
    warm.add(this.textSigns.warmup());
    for (const o of this.blast.warmup()) warm.add(o);
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
    this.settings = loadSettings(this.parts.isWebGPU);
    const asStored = { ...this.settings };
    if (params.has('simples')) Object.assign(this.settings, { shadows: false, ao: false, bloom: false });
    if (params.has('semsombra')) this.settings.shadows = false;
    // measurements: turn parts of the rendering on and off
    if (params.has('semdetalhe')) this.cityDetail.group.visible = false;
    if (params.has('perf')) this.perfLog = [];
    if (params.has('sempedestres')) this.vehicles.hidePeople = true;
    if (params.has('semao')) this.settings.ao = false;
    if (params.has('sembrilho')) this.settings.bloom = false;
    if (params.has('chuva')) this.settings.weather = 'chuva';
    if (params.has('limpo')) this.settings.weather = 'limpo';
    if (params.has('tempestade')) this.settings.weather = 'tempestade';
    // the address's photo parameters hold for this run only: the player's options keep their own values
    keepOverAddress(asStored, this.settings);
    this.health = new HealthPanel(document.getElementById('hud')!, { world: () => this.healthWorld(), state: () => this.healthState() });
    this.creator = new Creator({ apply: (d, fl) => this.applyDesign(d, fl) });
    this.hud.buildingSlot.append(this.creator.el);
    followLanguage(this.creator.el);
    this.creator.el.style.display = 'none';
    this.optionsPanel = new OptionsPanel(document.getElementById('hud')!, () => this.settings, this.parts.isWebGPU, (s) => void this.applySettings(s),
      !this.developer ? [] : [[t('game.options.worstCase'), t('game.options.worstCaseTip'), () => { if (this.discardOk()) void this.testCity(); }],
        [t('game.options.unlimited'), t('game.options.unlimitedTip'), () => { this.world.unlimited = !this.world.unlimited; this.hud.toast(this.world.unlimited ? t('game.toast.unlimitedOn') : t('game.toast.unlimitedOff')); }]], () => this.gpuName());
    await this.applySettings(this.settings, false);
    await renderer.compileAsync(scene, this.rig.persp);
    await renderer.compileAsync(scene, this.rig.ortho);
    this.warmPost();
    scene.remove(warm);
    warm.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.preview.hideAll();
    this.inside.hide();
    this.transitView.showPaths = false;

    this.bindInput();
    this.bindResize();
    this.hud.hideLoading();
    if (params.has('grande')) this.hud.toast(t('game.toast.mapTooBig'));
    if (!this.parts.isWebGPU) this.hud.toast(t('game.toast.webgl'));
    const cam = params.get('cam');
    if (cam) {
      const [x, z, yaw, pitch, dist] = cam.split(',').map(Number);
      this.rig.restore(new Float64Array([x, z, yaw * Math.PI / 180, pitch * Math.PI / 180, dist, params.has('iso') ? 1 : 0]));
    }
    this.last = performance.now();
    this.watchInput();
    renderer.setAnimationLoop((t) => this.frame(t));
    if (params.has('teste')) await this.testCity();
    else if (params.has('cidade')) await this.generatedCity((CITY_STYLES as readonly string[]).includes(params.get('estilo') ?? '') ? params.get('estilo') as CityStyle : 'classic', params.has('media'));
    else if (params.has('carregar')) await this.load();
    else if (params.has('inicio')) this.showStart();
    // straight into a medium town of straight streets, blocks and lots (Roadcraft 2.0's start): the start screen stays
    // on the menu (and ?inicio)
    else if (!params.has('cam') && !params.has('vazio')) await this.generatedCity('blocks', true);
    await this.settle();
    this.homeView ??= this.rig.state();
    status.value = 'pronto';
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

  /** Camera and hour for automated photos; waits for the meshes to be ready. */
  async view(x: number, z: number, yaw: number, pitch: number, dist: number, hour?: number): Promise<void> {
    await photoView(this.rig, (frames) => this.settle(frames), (h) => { this.hour = h; this.clockSpeed = 0; }, x, z, yaw, pitch, dist, hour);
  }

  /** Waits for the workers to drain (for photos and tests). */
  async settle(frames = 20): Promise<void> { await settlePool(this.pool, frames); }

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
    // minimized or hidden: nothing is drawn; the simulation goes on in its worker (the clock does not jump on return)
    if (document.hidden) { this.last = now; return; }
    this.health?.frame(now - this.last);
    this.adaptDetail(now - this.last);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const { renderer, scene } = this.parts;

    this.rig.update(dt);
    // inside view: gone with its building (demolished, undone, another city), laid out again when it is edited
    if (this.insideId >= 0) {
      this.inside.follow(this.world);
      if (!this.inside.on) { this.insideId = -1; this.hud.setInside(-1); }
    }
    const cam = this.rig.camera;
    // always day (or night) fixes the light only: the clock, and the traffic demand that follows it, go on
    if (!this.paused) this.hour = (this.hour + dt * this.clockSpeed / 60) % 24;
    const light = this.skyMode === 'dia' ? 12 : this.skyMode === 'noite' ? 22 : this.hour;
    // city clock in minutes (building decay); the sky mode only fixes the light
    if (!this.paused) this.world.advanceClock(dt * this.clockSpeed);
    if (now > this.autosaveAt) { this.autosaveAt = now + 120000; if ((this.unsaved || this.world.saveDirty.includes(1)) && !this.busy && !this.saveBlocked) void this.save(true); }
    const groundY = heightAt(this.world.heights, this.rig.eye.x, this.rig.eye.z);
    this.weather.viewAngle = Math.atan2(this.rig.target.z - this.rig.eye.z, this.rig.target.x - this.rig.eye.x);
    // the rain box round the eye; isometric: round what is looked at (round the perspective eye it was a block of rain)
    this.weather.update(dt, dt * this.clockSpeed * 60, this.rig.mode === 'iso' ? this.rig.target : this.rig.eye, groundY, (this.parts.scene.fog as THREE.FogExp2).color);
    setTimeOfDay(this.parts, light, cloudsU.value, rainU.value, this.rig.eye.y - groundY);
    this.particles.update(dt, this.rig.eye);
    this.textSigns.update(this.rig.eye);
    this.blast.update(dt);
    if (flashU.value > 0) { this.parts.hemi.intensity += flashU.value * 4; this.parts.hemi.color.lerp(FLASH_COLOR, flashU.value * 0.6); }
    {
      const st = this.simStats?.type === 'stats' ? this.simStats : null;
      this.ambient.update(dt, {
        rain: rainU.value, wind: windU.value, traffic: Math.min(1, (st?.micro ?? 0) / 120),
        height: this.rig.eye.y - groundY, day: 1 - nightU.value, green: this.green,
      });
    }
    this.hud.setClock(this.hour, this.simSpeed, this.paused);
    this.hud.setMoney(this.world.money, this.world.unlimited);
    this.hud.setCompass(this.rig.yaw);

    // tool under the cursor
    let hit: THREE.Vector3 | null = null;
    if (this.tool !== 'camera' && this.pointer.inside && this.drag !== 'pan' && this.drag !== 'rotate') hit = this.rig.pick(this.ndcX(), this.ndcY());
    const terrainTool = TERRAIN_TOOLS.includes(this.tool) || GROUND_TOOLS.includes(this.tool) || (this.tool === 'sky' && this.skyTool.fog !== 'none');
    if (terrainTool && hit) this.terrain.brush.value.set(hit.x, hit.z, this.brush.radius, 1);
    else if (this.tool === 'zone' && hit) this.terrain.brush.value.set(hit.x, hit.z, this.zoneTool.radius, 1);
    else this.terrain.brush.value.w = 0;
    if (this.drag === 'zone' && hit) this.zoneTool.dab(hit.x, hit.z);
    if (this.tool === 'building') this.hoverLotTool(hit);
    if (this.drag === 'brush' && this.elemStroke && hit) {
      if (this.tool === 'sky') this.elemStroke.dab(hit.x, hit.z, this.brush.radius, Item.Mist, 0.25, this.skyTool.fogHeight, this.skyTool.fog === 'erase' ? 'eraseKind' : 'lay', dt, 22);
      else this.elemStroke.dab(hit.x, hit.z, this.brush.radius, this.elem.kind, this.elem.density, this.elem.size, this.elem.mode, dt);
    }
    if (this.drag === 'brush' && this.stroke && hit) {
      if (this.stroke instanceof GroundStroke) this.stroke.dab(hit.x, hit.z, this.brush.radius, this.tool === 'paint' ? 'paint' : this.forestCut ? 'cut' : 'forest', this.groundKind, this.brush.strength, dt, this.forestSpecies);
      else {
        this.stroke.dab(hit.x, hit.z, this.brush, dt);
        const rock = LANDFORM_ROCK[this.brush.mode];
        if (this.rockStroke && rock !== undefined) this.rockStroke.dab(hit.x, hit.z, this.brush.radius * (this.brush.mode === 'gully' ? 0.6 : 0.95), 'paint', rock, 1, 1);
      }
    }
    if (this.tool === 'river') this.hoverRiver(hit);
    if (this.drag === 'free') this.roadTool.freeMove(hit);
    else if (this.drag === 'row' && this.boxStart) this.itemTool.hoverRow(this.boxStart.x, this.boxStart.z, hit);
    else if (this.drag === 'box' && this.boxStart && hit) {
      // drag rectangle on the ground (red)
      const a = this.boxStart, cz = (a.z + hit.z) / 2, H = (x: number, z: number) => heightAt(this.world.heights, x, z) + 0.8;
      this.preview.marker.visible = false;
      this.preview.show({ x0: (a.x + hit.x) / 2, z0: a.z, cx: (a.x + hit.x) / 2, cz, x1: (a.x + hit.x) / 2, z1: hit.z }, Math.abs(hit.x - a.x) / 2, [0, 1], [H(a.x, a.z), H(hit.x, hit.z)], true, 0xe2564b);
    } else if (ROAD_TOOLS.includes(this.tool) && this.tool !== 'free' && this.drag !== 'pan' && this.drag !== 'rotate') this.roadTool.hover(hit);
    if ((this.tool === 'streetscape' || this.tool === 'barrier') && this.drag !== 'pan' && this.drag !== 'rotate' && this.drag !== 'row') this.itemTool.hover(hit);

    // Drawn only when something visible can change: the camera, the simulation or the clock running, input, meshes
    // arriving, weather. Paused and idle, after STILL_FRAMES (the anti-aliasing settles) nothing is drawn; water and
    // leaves stand still until something moves.
    const live = !this.paused || now - this.lastInput < 800 || !this.pool.isIdle() || this.generating || rainU.value > 0.01 || flashU.value > 0
      || !this.drawnView.equals(cam.matrixWorld) || !this.drawnProj.equals(cam.projectionMatrix);
    this.stillFrames = live ? 0 : this.stillFrames + 1;
    this.drawnView.copy(cam.matrixWorld);
    this.drawnProj.copy(cam.projectionMatrix);
    if (this.stillFrames > STILL_FRAMES) return;

    const pf = this.perfLog, T0 = pf ? performance.now() : 0;
    for (const l of this.layers) l.processDirty();
    this.world.dirty.drain(Dirty.Terrain); // nothing but rendering depends on this yet
    this.processRoadPaint();
    if (this.arrowNodes.size) this.updateArrows();
    const T1 = pf ? performance.now() : 0;
    if (!this.generating) this.growth.processDirty();
    this.growth.tick(dt, this.paused ? 0 : this.simSpeed);
    const T2 = pf ? performance.now() : 0;
    this.terrain.uploadDirtyLayers();
    this.terrain.update(cam, this.rig.eye);
    for (const l of this.layers) l.update(cam, this.rig.eye);
    const T3 = pf ? performance.now() : 0;
    this.syncSim(now);
    this.syncTransit();
    this.updateInfo(now);
    this.vehicles.update(cam, this.rig.eye, now);
    if (this.vehicles.follow) { const p = this.vehicles.followPose; this.rig.followPose(p[0], p[1], p[2], p[3], dt); }
    else if (this.rig.followY !== null) { this.rig.followY = null; this.hud.toast(t('game.toast.followLost')); }
    const T4 = pf ? performance.now() : 0;
    this.props.processDirty();
    this.props.update(renderer, cam, this.rig.eye, now);
    const T5 = pf ? performance.now() : 0;

    if (this.post) {
      // the shadow cascades are redrawn only when something casting changed or moves (render/post.ts prepareShadows)
      if (this.props.changed || this.layers.some((l) => l.changed)) this.post.invalidateShadows();
      this.props.changed = false;
      this.post.setCamera(cam);
      this.post.render(!this.paused || windU.value > 0.001);
    }
    else renderer.render(scene, cam);
    // measurement (?perf): frames over 30 ms say where the time went
    if (pf) { const T6 = performance.now(); if (T6 - T0 > 30) pf.push(`camadas ${(T1 - T0).toFixed(0)} cresc ${(T2 - T1).toFixed(0)} terreno+lod ${(T3 - T2).toFixed(0)} sim+veic ${(T4 - T3).toFixed(0)} props ${(T5 - T4).toFixed(0)} desenho ${(T6 - T5).toFixed(0)}`); } // not for the player: ?perf measurement log
  }

  private toggleTrafficView(): void {
    trafficOverlayU.value = trafficOverlayU.value > 0.5 ? 0 : 1;
    this.hud.setTrafficView(trafficOverlayU.value > 0.5);
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
    this.paused = !this.paused;
    this.sim.postMessage({ type: 'speed', value: this.paused ? 0 : this.simSpeed } satisfies ToSim);
    this.hud.toast(this.paused ? t('game.toast.paused') : t('game.toast.resumed'));
  }

  /** Simulation speed from the top bar: 0 pauses, 1, 2 or 4 (the clock keeps pace, unless frozen for a photo). */
  private setSpeed(n: number): void {
    this.paused = n === 0;
    if (n > 0) { this.simSpeed = n; if (this.clockSpeed > 0) this.clockSpeed = n; }
    this.sim.postMessage({ type: 'speed', value: this.paused ? 0 : this.simSpeed } satisfies ToSim);
  }

  /**
   * The simulation's mirror of the network failed to apply a change: send it the whole network again (a 'clear', then
   * every node, segment and junction; pending changes are already in it). Its vehicles start over, and the flow-based
   * controls it had chosen are forgotten on both sides.
   */
  private resyncSim(reason: string): void {
    const net = this.world.roads, nc = net.nodes.cols, ops: NetOp[] = [{ t: 'clear' }];
    for (let n = 0; n < net.nodes.end; n++) if (net.nodes.alive[n]) ops.push({ t: 'addNode', rec: { id: n, x: nc.x[n], z: nc.z[n], y: nc.y[n] } });
    for (let s = 0; s < net.segs.end; s++) if (net.segs.alive[s]) ops.push({ t: 'addSeg', rec: net.segRec(s) });
    for (const [id, spec] of net.junctions) ops.push({ t: 'junction', id, spec });
    for (const id of [...net.flow.keys()]) net.setFlow(id, 0);
    this.netOps.length = 0;
    const extra: string[] = [];
    const enc = encodeOps(ops, extra);
    this.sim.postMessage({ type: 'ops', ops: enc, extra } satisfies ToSim, [enc.buffer]);
    this.roadsVersion++;
    console.error('simulação: rede reenviada inteira', reason);
  }

  /** Sends the network changes and the camera position to the simulation. */
  private syncSim(now: number): void {
    if (this.netOps.length) {
      // the stops follow the roads: resend the lines only when segments changed (a zone dab or a junction control does not)
      if (this.transit.lines.length && this.netOps.some((op) => op.t === 'addSeg' || op.t === 'remSeg' || op.t === 'profile' || op.t === 'clear')) this.roadsVersion++;
      const extra: string[] = [];
      const ops = encodeOps(this.netOps, extra);
      this.netOps.length = 0;
      this.sim.postMessage({ type: 'ops', ops, extra } satisfies ToSim, [ops.buffer]);
    }
    this.trafficLook.center.value.set(this.rig.target.x, this.rig.target.z);
    if (now - this.occSent > 500) { this.occSent = now; this.trafficLook.occupancy.needsUpdate = true; }
    if (now - this.demandSent > 2000) {
      this.demandSent = now;
      const st = this.settings;
      const demand = demandFactor(st?.demand);
      this.sim.postMessage({ type: 'demand', hour: this.hour, demand, traffic: st?.traffic ?? 1, people: st?.people ?? 1 } satisfies ToSim);
    }
    if (now - this.camSent > 250) {
      this.camSent = now;
      this.sim.postMessage({ type: 'camera', x: this.rig.target.x, z: this.rig.target.z } satisfies ToSim);
    }
    if (now - this.doorsSent > 3000) this.sendDoors(now);
  }

  /**
   * Doors of the buildings near the camera (roadcraft `lotDoors`): the middle of the lot's front, facing the road.
   * Pedestrians spawned there walk out of them to the sidewalk. Only when the camera moved 80 m or the city changed.
   */
  private sendDoors(now: number): void {
    this.doorsSent = now;
    const t = this.rig.target, w = this.world, col = w.buildings.cols;
    const moved = Math.hypot(t.x - this.doorsAt.x, t.z - this.doorsAt.z) > 80;
    if (!moved && w.buildings.size === this.doorsAt.count) return;
    this.doorsAt = { x: t.x, z: t.z, count: w.buildings.size };
    const R = 450, pts: number[] = [], docks: number[] = [];
    w.buildingIndex.query(t.x - R, t.z - R, t.x + R, t.z + R, (id) => {
      if (pts.length >= 6000 || col.floors[id] === 0) return;
      const k = col.d[id] / 2 - 0.3, s = Math.sin(col.rot[id]), c = Math.cos(col.rot[id]);
      pts.push(col.x[id] + s * k, col.z[id] + c * k);
      // warehouse loading dock (trucks back into it): inside the gate, lot frame (−w/2 + 10, d/2 − 6), facing the street
      if (col.zone[id] === Zone.Industrial && docks.length < 1500) {
        const [dx, dz] = lotToWorld({ x: col.x[id], z: col.z[id], rot: col.rot[id] }, -col.w[id] / 2 + 10, col.d[id] / 2 - 6);
        docks.push(dx, dz, col.rot[id]);
      }
    });
    const arr = new Float32Array(pts), dk = new Float32Array(docks);
    this.sim.postMessage({ type: 'doors', pts: arr } satisfies ToSim, [arr.buffer]);
    this.sim.postMessage({ type: 'docks', pts: dk } satisfies ToSim, [dk.buffer]);
  }

  /** Arrows at segment ends on nodes with adjusted lane connections (only the nodes that changed). */
  private updateArrows(): void {
    const net = this.world.roads, sc = net.segs.cols, arr = this.trafficLook.arrows.image.data as Float32Array;
    let changed = false;
    for (const n of this.arrowNodes) {
      if (!net.nodes.alive[n]) continue;
      const spec = net.junctions.get(n);
      for (const s of net.segsOf(n, [])) {
        const k = s * 2 + (sc.a[s] === n ? 0 : 1);
        if (k >= arr.length) continue;
        const code = spec?.lanes?.length ? arrowCode(net, n, s) : 0;
        if (arr[k] !== code) { arr[k] = code; changed = true; }
      }
    }
    this.arrowNodes.clear();
    if (changed) this.trafficLook.arrows.needsUpdate = true;
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
      const segs: number[] = [];
      net.forSegsNear(x0 - 30, z0 - 30, x0 + TILE_SIZE + 30, z0 + TILE_SIZE + 30, (s) => segs.push(s));
      const graph = net.gather(segs, []);
      this.pool.submit('roadPaint', { graph, tile: t }, (r) => this.terrain.setRoadPaint(r.tile, r.texels, r.coarse),
        { key: `paint:${t}`, priority: 3000, transfer: roadGraphTransfer(graph) });
    }
  }

  // ----------------------------------------------------------------- input

  private ndcX(): number { return (this.pointer.x / this.canvas.clientWidth) * 2 - 1; }
  private ndcY(): number { return -(this.pointer.y / this.canvas.clientHeight) * 2 + 1; }

  private bindInput(): void {
    const g = this;
    bindInput({
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
      skyTool: this.skyTool,
      get forestOne() { return g.forestOne; },
      get zoneBlock() { return g.zoneBlock; },
      get simSpeed() { return g.simSpeed; },
      get paused() { return g.paused; },
      get homeView() { return g.homeView; },
      polyPts: this.polyPts,
      riverPts: this.riverPts,
      lotStroke: this.lotStroke,
      get lotPts() { return g.lotPts; },
      get lotMode() { return g.lotMode; },
      get lotExtraPts() { return g.lotExtraPts; }, set lotExtraPts(v) { g.lotExtraPts = v; },
      get lotExtra() { return g.lotExtra; }, set lotExtra(v) { g.lotExtra = v; },
      get joinFirst() { return g.joinFirst; }, set joinFirst(v) { g.joinFirst = v; },
      get cornerDrag() { return g.cornerDrag; }, set cornerDrag(v) { g.cornerDrag = v; },
      get insideId() { return g.insideId; },
      get cloudGrab() { return g.cloudGrab; },
      get pointer() { return g.pointer; },
      get drag() { return g.drag; }, set drag(v) { g.drag = v; },
      get stroke() { return g.stroke; }, set stroke(v) { g.stroke = v; },
      get rockStroke() { return g.rockStroke; }, set rockStroke(v) { g.rockStroke = v; },
      get elemStroke() { return g.elemStroke; }, set elemStroke(v) { g.elemStroke = v; },
      get boxStart() { return g.boxStart; }, set boxStart(v) { g.boxStart = v; },
      get wallOpen() { return g.wallOpen; }, set wallOpen(v) { g.wallOpen = v; },
      ndcX: () => g.ndcX(), ndcY: () => g.ndcY(),
      clickHost: () => g.clickHost(),
      grabCloud: (hit) => g.grabCloud(hit),
      dropCloud: (hit) => g.dropCloud(hit),
      grabCorner: (hit) => g.grabCorner(hit),
      dropCorner: (hit) => g.dropCorner(hit),
      finishRiver: () => g.finishRiver(),
      finishPoly: () => g.finishPoly(),
      insideCmd: (c) => g.insideCmd(c),
      setTool: (t) => g.setTool(t),
      setSpeed: (n) => g.setSpeed(n),
      setView: (v) => g.setView(v),
      toggleTrafficView: () => g.toggleTrafficView(),
      toggleFollow: () => g.toggleFollow(),
      toolKey: (e) => g.toolKey(e),
      history: (r) => g.history(r),
      save: () => g.save(),
    });
  }

  private removePole(hit: THREE.Vector3 | null): void {
    const items = this.world.items, id = hit ? items.nearest(hit.x, hit.z, 3) : -1;
    if (id < 0 || items.t.cols.type[id] !== Item.PoleLine) return;
    const c = new ItemsCommand(items, 'remover item');
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
    if (t === 'building' && this.lotMode === 'poly' && c === 'Enter') { this.finishPoly(); return true; }
    if (t === 'building' && this.lotMode === 'poly' && c === 'Backspace') { this.polyPts.pop(); return true; }
    if (t === 'barrier' && c === 'Backspace') { this.itemTool.back(); return true; }
    if (t === 'barrier' && c === 'Enter') { this.itemTool.cancel(); this.wallOpen = false; return true; }
    if (t === 'river' && c === 'Enter') { this.finishRiver(); return true; }
    if (t === 'river' && c === 'Backspace') { this.riverPts.pop(); return true; }
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
  private async applySettings(s: Settings, compile = true): Promise<void> {
    this.settings = s;
    const { renderer, scene } = this.parts;
    renderer.setPixelRatio(window.devicePixelRatio * s.resolution);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.updatePixelScale();
    // the option's weather; weather set by hand in the Sky panel (saved with the map) stays
    if (this.weatherCtl) { const was = this.unsavedNow; this.setWeather(this.weatherCtl); this.unsavedNow = was; }
    else this.weather.fixed = s.weather === 'chuva' ? { clouds: 0.95, rain: 0.85 } : s.weather === 'tempestade' ? { clouds: 1, rain: 1, storm: 1 } : s.weather === 'limpo' ? { clouds: 0.15, rain: 0 } : null;
    this.ambient.setVolume(s.volume ?? 0.6);
    setPaintStyle(s.paint ?? 'br');
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
      await renderer.compileAsync(scene, this.rig.persp);
      this.warmPost();
      this.hud.hideLoading();
    }
  }

  /** Renders the final image once with each camera (compiles its shaders at load). */
  private warmPost(): void {
    if (!this.post) return;
    // both outputs (day without bloom, night with it) compiled at load: dusk does not stall
    for (const night of [true, false]) {
      this.post.bloomOverride = night;
      this.post.setCamera(this.rig.ortho); this.post.render();
      this.post.setCamera(this.rig.persp); this.post.render();
    }
    this.post.bloomOverride = null;
  }

  /**
   * Detail kept to what the GPU draws in time (screen-space error with a frame-time budget, as the engines that show
   * whole cities do): every 3 s, the frames of the window over 20 ms (a slower card) raise the pixel error a little,
   * frames all at the screen's rate bring it back; on a card with room it stays at the full detail.
   */
  private frameTimes: number[] = [];
  private detailAuto = 1;
  private adaptDetail(ms: number): void {
    if (ms <= 0 || ms > 250) return;
    const t = this.frameTimes;
    t.push(ms);
    if (t.length < 180) return;
    t.sort((a, b) => a - b);
    const p90 = t[Math.floor(t.length * 0.9)];
    t.length = 0;
    const before = this.detailAuto;
    if (p90 > 20) this.detailAuto = Math.max(0.35, this.detailAuto * 0.85);
    else if (p90 < 17.5) this.detailAuto = Math.min(1, this.detailAuto * 1.1);
    if (this.detailAuto !== before) this.updatePixelScale();
  }

  /** Detail distances by screen-space error: more pixels, detail reaches farther. */
  private updatePixelScale(): void {
    const res = (this.settings ? this.settings.resolution * this.settings.detail : 1) * this.detailAuto;
    const k = Math.min(3, Math.max(0.3, window.innerHeight * window.devicePixelRatio * res / 1080));
    for (const l of this.layers) l.pixelScale = k;
    if (this.props) this.props.pixelScale = k;
  }

  /** Undo (false) or redo (true), with sound. */
  private history(redo: boolean): void {
    // a brush, zoning or free road still being dragged is recorded on release: undo waits for it
    if (this.drag === 'brush' || this.drag === 'zone' || this.drag === 'free' || this.drag === 'node' || this.drag === 'lots') return;
    if (redo ? this.commands.redo() : this.commands.undo()) this.ambient.sfx('undo');
  }

  private setTool(tool: Tool): void { setGameTool(this.toolHost(), tool); }

  /** The tool state as the tools module sees it: accessors, never copies. */
  private toolHost(): ToolHost {
    const g = this;
    return {
      get tool() { return g.tool; }, set tool(v) { g.tool = v; },
      get wallOpen() { return g.wallOpen; }, set wallOpen(v) { g.wallOpen = v; },
      zoneLayer: g.zoneLayer, brush: g.brush, landformMode: g.landformMode, lotMode: g.lotMode, skyTool: g.skyTool,
      riverPts: g.riverPts, roadTool: g.roadTool, itemTool: g.itemTool, inspector: g.inspector, transitView: g.transitView,
      preview: g.preview, creator: g.creator, inside: g.inside,
      get insideId() { return g.insideId; }, set insideId(v) { g.insideId = v; },
      hud: g.hud, health: g.health, canvas: g.canvas, ambient: g.ambient,
      select: (id) => g.select(id), setLotMode: (mode) => g.setLotMode(mode),
    };
  }

  /** The click dispatch as the clicks module sees it: tools and actions, never a copy of the world. */
  private clickHost(): ClickHost {
    const g = this;
    return {
      tool: g.tool, itemRemove: g.itemRemove, forestOne: g.forestOne, zoneBlock: g.zoneBlock, transitTerminal: g.transitTerminal,
      get wallOpen() { return g.wallOpen; }, set wallOpen(v) { g.wallOpen = v; },
      inspector: g.inspector, riverPts: g.riverPts, itemTool: g.itemTool, roadTool: g.roadTool, zoneTool: g.zoneTool, hud: g.hud,
      removePole: (hit) => g.removePole(hit),
      clickBuilding: (hit, shift) => g.clickBuilding(hit, shift),
      clickTransit: (hit, terminal) => g.clickTransit(hit, terminal),
      clickSky: (x, z) => g.clickSky(x, z),
      plantTree: (x, z) => g.plantTree(x, z),
      placePerson: (x, z) => g.placePerson(x, z),
      shoot: (x, z) => g.shoot(x, z),
      bomb: (x, z) => g.bomb(x, z),
      weatherStrike: (hit) => g.weather.strikeAt(g.rig.eye, hit.x, hit.z, heightAt(g.world.heights, hit.x, hit.z)),
    };
  }

  /** For photo scripts and tests: the same actions as the tools. */
  readonly api = {
    /** People creator (src/render/people/creator.ts): a group of 1 to 20 at (x, z), with undo; returns the id (0 before loading). */
    people: (x: number, z: number, options: Partial<PersonOptions> = {}) => {
      const c = this.vehicles.people.creator;
      if (!c) return 0;
      c.ground ??= (px: number, pz: number) => heightAt(this.world.heights, px, pz);
      const cmd = c.placeCommand(x, z, heightAt(this.world.heights, x, z), options);
      this.commands.run(cmd);
      return cmd.id;
    },
    /** What the creator screen offers (clothes by sex and age, colours, modes, objects); null before loading. */
    peopleCatalog: () => this.vehicles.people.catalog(),
    river: (pts: Array<[number, number]>, width = 14) => { this.riverPts = pts.slice(); this.riverWidth = width; this.finishRiver(); },
    paint: (x: number, z: number, r: number, kind: number, mode: 'paint' | 'forest' | 'cut' = 'paint', species = 0) => {
      const s = new GroundStroke(this.world);
      s.dab(x, z, r, mode, kind, 1, 1, species);
      if (s.finish()) this.commands.push(s);
    },
    item: (x: number, z: number, kind: number, variant = 0) => { this.itemTool.item = kind; this.itemTool.sign = variant; this.itemTool.mode = 'streetscape'; this.itemTool.click({ x, z } as THREE.Vector3, false); },
    poleLine: (ax: number, az: number, bx: number, bz: number, lights = 0) => this.itemTool.placePoleLine(ax, az, bx, bz, lights),
    /** Drawn lot: front A→B, back out to C. */
    lot: (ax: number, az: number, bx: number, bz: number, cx: number, cz: number, use = 1, floors?: number) => {
      this.lotUse = use;
      this.lotPts = [[ax, az], [bx, bz]];
      this.clickLot({ x: cx, z: cz } as THREE.Vector3);
      this.lotPts = null;
      if (floors !== undefined && this.selected >= 0) this.editSelected(floors - this.world.buildings.cols.floors[this.selected]);
      return this.selected;
    },
    follow: () => { this.toggleFollow(); return !!this.vehicles.follow; },
    /** Lightning strike now (storm photos). */
    strike: () => this.weather.strikeNow(this.rig.eye, heightAt(this.world.heights, this.rig.eye.x, this.rig.eye.z)),
    biome: (b: number) => this.setBiome(b),
    /** Straight road from (ax, az) to (bx, bz) with the profile by name (or id). */
    road: (ax: number, az: number, bx: number, bz: number, profile: string | number = 0, elevation = 0) => {
      const id = typeof profile === 'number' ? profile : PROFILES.findIndex((p) => p.name === profile);
      const a = snap(this.world.roads, ax, az, 10), b = snap(this.world.roads, bx, bz, 10);
      const plan = planRoad(this.world, a, null, b, Math.max(0, id), elevation);
      if (!plan.ok) return plan.reason;
      const j = buildRoad(this.world, plan, a, b, Math.max(0, id), this.roadTool.segFlags());
      const price = j.price;
      if (!j.settle()) return `dinheiro insuficiente: custa R$ ${price.toLocaleString('pt-BR')}`;
      this.commands.push(j);
      return 'ok';
    },
    zone: (x: number, z: number, r: number, zone: number) => { this.zoneTool.zone = zone; this.zoneTool.radius = r; this.zoneTool.begin(); this.zoneTool.dab(x, z); this.zoneTool.end(); },
    line: (mode: number, stops: number[], vehicles = 2) => {
      this.lineMode = mode; this.newLine();
      for (let i = 0; i + 1 < stops.length; i += 2) this.clickTransit({ x: stops[i], z: stops[i + 1] } as THREE.Vector3);
      const l = this.transit.line(this.lineSel);
      const c = l && this.transit.setBuses(l.id, vehicles);
      if (c) this.commands.run(c);
    },
    grow: async () => { this.growth.processDirty(); await this.pool.whenIdle(); return this.growth.fillAll(); },
    /** The style the next generated city lays its local streets in (Roadcraft's grid, organic, radial, mixed, blocks; or classic). */
    cityStyle: (style: CityStyle) => { if (CITY_STYLES.includes(style)) this.cityStyle = style; return this.cityStyle; },
    /** Road edits at the point (x, z): split, reverse, duplicate, join (node) and move node to (tx, tz). */
    edit: (what: 'split' | 'reverse' | 'duplicate' | 'join' | 'move', x: number, z: number, tx = 0, tz = 0) => {
      const net = this.world.roads;
      const s = net.nearestSeg(x, z, 10), n = net.nearestNode(x, z, 10);
      const j = what === 'split' ? (s ? splitAt(this.world, s[0], s[1]) : null)
        : what === 'reverse' ? (s ? reverseRoad(this.world, s[0]) : null)
        : what === 'duplicate' ? (s ? duplicateRoad(this.world, s[0]) : null)
        : what === 'join' ? (n >= 0 ? joinAt(this.world, n) : null)
        : n >= 0 ? moveNode(this.world, n, tx, tz) : null;
      if (!j || typeof j === 'string') return j ?? 'nada aqui';
      if (j.empty || !j.settle()) return 'recusado';
      this.commands.push(j);
      return 'ok';
    },
    /** The save package (what Export downloads) and opening a package (what Open file does). */
    packMap: async () => packSlot(await this.slot()),
    openMap: (b: Blob) => this.importMap(b),
    /** One terrain brush stroke (landforms included) at (x, z). */
    terrain: (mode: BrushMode, x: number, z: number, radius = 80, strength = 0.4) => {
      const st = new BrushStroke(this.world), rk = LANDFORM_ROCK[mode];
      const p = { mode, radius, strength };
      st.dab(x, z, p, 1);
      const g = rk !== undefined ? new GroundStroke(this.world) : null;
      if (g && rk !== undefined) g.dab(x, z, radius * 0.95, 'paint', rk, 1, 1);
      if (st.finish()) { if (g?.finish()) this.commands.push({ label: 'relevo', apply: () => { st.apply(); g.apply(); }, invert: () => { g.invert(); st.invert(); } }); else this.commands.push(st); }
    },
    /** Ground elements (kind 30..40) scattered in a circle. */
    elements: (kind: number, x: number, z: number, r = 12, density = 20, size = 7) => {
      const st = new ElementStroke(this.world.items);
      for (let i = 0; i < 6; i++) st.dab(x, z, r, kind, density, size, 'lay', 1);
      if (!st.cmd.empty) this.commands.push(st.cmd);
      return this.world.items.size;
    },
    /** Pedestrian crossing mid-road at (x, z): 9 zebra, 10 with traffic lights. */
    crossing: (x: number, z: number, ctl: number) => {
      const s = this.world.roads.nearestSeg(x, z, 10);
      if (!s) return 'sem via';
      const r = addCrossing(this.world, s[0], s[1], ctl);
      if (typeof r === 'string') return r;
      this.commands.push(r);
      return 'ok';
    },
    /** U-turn through the median on the road at (x, z). */
    uturn: (x: number, z: number) => {
      const s = this.world.roads.nearestSeg(x, z, 10);
      if (!s) return 'sem via';
      const r = addUTurn(this.world, s[0], s[1]);
      if (typeof r === 'string') return r;
      this.commands.push(r);
      return 'ok';
    },
    /** Demolish everything in the rectangle. */
    demolish: (x0: number, z0: number, x1: number, z1: number) => { const r = demolishBox(this.world, x0, z0, x1, z1); if (r) this.commands.push(r.cmd); return r?.count ?? 0; },
    bomb: (x: number, z: number) => { this.bomb(x, z); },
    /** Terrain height at (x, z). */
    ground: (x: number, z: number) => heightAt(this.world.heights, x, z),
    junction: (x: number, z: number, ctl: number) => { const n = this.world.roads.nearestNode(x, z, 20); if (n >= 0) this.world.roads.setJunction(n, { ctl }); },
    /** Polygon lot from flat corners [x0, z0, x1, z1, …] (the first side is the front); returns its id or the refusal. */
    lotPoly: (pts: number[], use = 1) => {
      this.lotUse = use; this.polyPts = [];
      for (let i = 0; i + 1 < pts.length; i += 2) this.polyPts.push([pts[i], pts[i + 1]]);
      const before = this.world.buildings.end, size = this.world.buildings.size;
      const r = polygonLot(this.polyPts, this.world);
      this.finishPoly();
      if (typeof r === 'string') return r;
      if (this.world.buildings.size === size) return 'não criou';
      // the new lot is the last id handed out (or one reused from the free list): find it at its centre
      return lotAt(this.world, r.x, r.z) >= 0 ? lotAt(this.world, r.x, r.z) : before;
    },
    /** Split the lot under the line (ax, az)-(bx, bz) along it. */
    lotLine: (ax: number, az: number, bx: number, bz: number) => { this.lotExtra = 'line'; this.lotExtraPts = []; this.clickLotExtra({ x: ax, z: az } as THREE.Vector3); this.clickLotExtra({ x: bx, z: bz } as THREE.Vector3); this.lotExtra = null; },
    /** Curve the side of a lot near (x, z) through (px, pz). */
    lotCurve: (x: number, z: number, px: number, pz: number) => { this.lotExtra = 'curve'; this.lotExtraPts = []; this.clickLotExtra({ x, z } as THREE.Vector3); this.clickLotExtra({ x: px, z: pz } as THREE.Vector3); this.lotExtra = null; },
    /** Renovate the building at (x, z) (Shift+click). */
    renovate: (x: number, z: number) => this.renovate(lotAt(this.world, x, z)),
    /** Manoeuvres going on in the simulation (parking, pulling out, trucks at docks, kerb stops), for photos and tests. */
    manoeuvres: () => new Promise<Extract<FromSim, { type: 'manoeuvres' }>>((resolve) => { this.manoeuvreWait = resolve; this.sim.postMessage({ type: 'probeManoeuvres' } satisfies ToSim); }),
    /** Address (street name and metric number) of the point (x, z), or null away from streets. */
    address: (x: number, z: number) => addressAt(this.world, x, z),
    /** Advance the city clock by `minutes` (decay and anything else on the city clock). */
    passTime: (minutes: number) => this.world.advanceClock(minutes),
  };

  /** River: shows the stretch from the last point to the cursor. */
  private hoverRiver(hit: THREE.Vector3 | null): void {
    const pv = this.preview;
    if (!hit || this.riverPts.length === 0) { pv.hide(); return; }
    const [ax, az] = this.riverPts[this.riverPts.length - 1];
    const ya = heightAt(this.world.heights, ax, az), yb = heightAt(this.world.heights, hit.x, hit.z);
    pv.show({ x0: ax, z0: az, cx: (ax + hit.x) / 2, cz: (az + hit.z) / 2, x1: hit.x, z1: hit.z }, this.riverWidth / 2, [0, 1], [ya + 0.3, yb + 0.3], true, 0x3d8fd0);
  }

  private finishRiver(): void {
    if (this.riverPts.length >= 2) {
      const c = new RiverCommand(this.world, this.riverPts, this.riverWidth, Math.min(4, 1.2 + this.riverWidth / 12));
      if (!c.empty) { this.commands.run(c); this.hud.toast(t('game.toast.river')); }
    }
    this.riverPts.length = 0;
    this.preview.hideAll();
  }

  private skyHint(): void { skyHintOf(this.toolHost()); }

  /** Replaces the cloud list as a command (undo brings back the previous one). */
  private setClouds(next: Cloud[], label: string): void {
    const before = this.clouds.map((c) => ({ ...c })), after = next.map((c) => ({ ...c }));
    const set = (l: Cloud[]) => { this.clouds = l.map((c) => ({ ...c })); this.cloudView.set(this.clouds); this.unsaved = true; };
    this.commands.run({ label, apply: () => set(after), invert: () => set(before) });
  }

  /** Cloud whose projection on the ground is near (x, z), or −1. */
  private cloudAt(x: number, z: number): number {
    let best = -1, bd = Infinity;
    this.clouds.forEach((c, i) => { const d = Math.hypot(c.x - x, c.z - z); if (d < c.size && d < bd) { bd = d; best = i; } });
    return best;
  }

  private clickSky(x: number, z: number): void {
    const s = this.skyTool;
    if (s.fog !== 'none') return;
    const i = this.cloudAt(x, z);
    if (s.cloud === 'add') {
      if (this.clouds.length >= MAX_CLOUDS) { this.hud.toast(t('game.toast.maxClouds', { n: MAX_CLOUDS })); return; }
      const y = heightAt(this.world.heights, x, z) + s.base;
      this.setClouds([...this.clouds, { x, z, y, size: s.size, density: s.density }], 'criar nuvem');
    } else if (s.cloud === 'remove' && i >= 0) this.setClouds(this.clouds.filter((_, k) => k !== i), 'apagar nuvem');
    else if (s.cloud === 'edit' && i >= 0) {
      const c = this.clouds[i];
      this.setClouds(this.clouds.map((d, k) => k === i ? { ...c, size: s.size, density: s.density, y: c.y - (c.y - heightAt(this.world.heights, c.x, c.z)) + s.base } : d), 'ajustar nuvem');
    } else if (i < 0 && s.cloud !== 'none') this.hud.toast(t('game.toast.noCloud'));
  }

  private grabCloud(hit: THREE.Vector3 | null): boolean {
    this.cloudGrab = hit ? this.cloudAt(hit.x, hit.z) : -1;
    return this.cloudGrab >= 0;
  }

  private dropCloud(hit: THREE.Vector3 | null): void {
    const i = this.cloudGrab;
    this.cloudGrab = -1;
    if (i < 0 || !hit) return;
    const c = this.clouds[i];
    const ground = heightAt(this.world.heights, hit.x, hit.z), base = c.y - heightAt(this.world.heights, c.x, c.z);
    this.setClouds(this.clouds.map((d, k) => k === i ? { ...c, x: hit.x, z: hit.z, y: ground + base } : d), 'mover nuvem');
  }

  /** Scatters clouds around the camera (size and base from the sliders, with variation). */
  private scatterClouds(n: number, variation: number): void {
    const s = this.skyTool, out = this.clouds.slice(0, Math.max(0, MAX_CLOUDS - n));
    const t = this.rig.target;
    for (let k = 0; k < n && out.length < MAX_CLOUDS; k++) {
      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * 5000;
      const x = t.x + Math.cos(a) * d, z = t.z + Math.sin(a) * d;
      const vary = (v: number) => v * (1 + (Math.random() * 2 - 1) * variation);
      out.push({ x, z, y: heightAt(this.world.heights, x, z) + vary(s.base), size: vary(s.size), density: Math.min(1, vary(s.density)) });
    }
    this.setClouds(out, 'espalhar nuvens');
  }

  private setWater(w: { waves: number; foam: number; current: number }): void {
    this.waterCtl = w; this.unsaved = true;
    waveU.value = w.waves; foamU.value = w.foam; currentU.value = w.current;
  }

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
    const c = new ItemsCommand(this.world.items, 'pôr pessoa');
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
    dropBomb({
      world: this.world,
      push: (cmd) => this.commands.push(cmd),
      blast: this.blast,
      particles: this.particles,
      sim: { postMessage: (msg) => this.sim.postMessage(msg) },
      hud: this.hud,
      ambient: this.ambient,
      flash: flashU,
      force: this.bombForce,
      setHitKind: (kind) => { this.hitKind = kind; },
    }, x, z);
  }

  private onHit(people: number, vehicles: number): void {
    const k = this.hitKind;
    this.hitKind = null;
    if (k === 'pistol') this.hud.toast(people ? t('game.toast.hit') : t('game.toast.missed'));
    else if (k === 'bomb' && people + vehicles > 0) this.hud.toast(t('game.toast.victims', { people: plural('status.people', people), vehicles: plural('status.vehicles', vehicles) }));
  }

  /** Weather from the panel: rain, wind, direction, lightning and thunder; null goes back to weather that changes by itself (or to the option). */
  private setWeather(w: WeatherCtl | null): void {
    this.weatherCtl = w;
    this.unsaved = true;
    const wt = this.weather;
    if (!w) {
      wt.windFixed = null; wt.lightningRate = 0; this.ambient.thunderVolume = 1;
      const s = this.settings?.weather;
      wt.fixed = s === 'chuva' ? { clouds: 0.95, rain: 0.85 } : s === 'tempestade' ? { clouds: 1, rain: 1, storm: 1 } : s === 'limpo' ? { clouds: 0.15, rain: 0 } : null;
      return;
    }
    wt.fixed = { clouds: w.rain > 0 ? 0.6 + 0.4 * w.rain : w.lightning > 0 ? 0.85 : 0.25, rain: w.rain, storm: w.lightning > 0 ? 1 : 0 };
    wt.windFixed = Math.min(1, w.wind / 20);
    wt.lightningRate = w.lightning;
    const r = w.dir * Math.PI / 180;
    windDirU.value.set(Math.sin(r), Math.cos(r));
    this.ambient.thunderVolume = w.thunder;
  }

  /** One tree of the chosen species (mixed: oak or cypress at random). */
  private plantTree(x: number, z: number): void {
    const sp = this.forestSpecies === 0 ? (Math.random() < 0.5 ? 1 : 2) : this.forestSpecies;
    const type = sp === 1 ? Item.Tree : sp === 2 ? Item.Conifer : Item.Palm;
    const c = new ItemsCommand(this.world.items, 'plantar árvore');
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
    this.hud.setView(this.rig.mode);
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
        if (tiles !== MAP_TILES) { reloadWithMap(tiles, `cidade&seed=${seed}`); return; }
        this.world.seed = seed; void this.generatedCity();
      },
      empty: (tiles) => {
        if (!this.discardOk()) { this.startMenu?.show(); return; }
        if (tiles !== MAP_TILES) reloadWithMap(tiles, 'vazio');
        else if (this.world.roads.segs.size || this.world.buildings.size) void this.newMap();
      },
      load: () => {
        if (!this.discardOk()) { this.startMenu?.show(); return; }
        void this.load().then((ok) => { if (!ok) this.startMenu?.show(); });
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
      ...this.changesLog.slice(0, 20).map(([at, label]): [string, string] => [`${((now - at) / 1000).toFixed(0)} s`, label]),
    ];
  }

  /** The health panel's State tab: the game's state now. */
  private healthState(): Array<[string, string]> {
    const r = this.rig, st = this.simStats?.type === 'stats' ? this.simStats : null;
    return [
      ['tool', this.tool], ['lot mode', this.lotMode], ['selected building', String(this.selected)], ['inspector', this.inspector.isOpen ? `segment ${this.inspector.seg}` : 'closed'],
      ['paused', String(this.paused)], ['speed', String(this.simSpeed)], ['clock', `${this.hour.toFixed(2)} h ×${this.clockSpeed}`], ['sky', this.skyMode],
      ['camera', `${r.mode} ${r.target.x.toFixed(0)}, ${r.target.z.toFixed(0)} · ${r.dist.toFixed(0)} m · yaw ${(r.yaw * 180 / Math.PI).toFixed(0)}°`],
      ['undo / redo', `${this.commands.canUndo} / ${this.commands.canRedo}`], ['unsaved', String(this.unsaved)], ['save blocked', String(this.saveBlocked)],
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

  private lineMode = 0;
  /** The start screen (shown at start, and again from the menu). */
  private startMenu: StartMenu | null = null;
  /** The impossible junction the top bar's warning showed last. */
  private impossibleVisit = -1;

  private newLine(): void {
    achieve('PRIMEIRA_LINHA');
    const { cmd, id } = this.transit.addLine(this.lineMode);
    this.commands.run(cmd);
    this.lineSel = id;
  }

  /** Stop: removes the one nearby, or puts a new one on the nearest sidewalk. */
  private clickTransit(hit: THREE.Vector3 | null, shift = false): void {
    if (!hit) return;
    // Shift+click on a stop: turns the terminal on or off
    if (shift) {
      const s = this.transit.stopNear(hit.x, hit.z, 9);
      if (!s) { this.hud.toast(t('game.toast.terminalHow')); return; }
      const l = this.transit.line(s[0])!;
      const x = l.stops[s[1] * 2], z = l.stops[s[1] * 2 + 1];
      const was = this.transit.terminalNear(x, z, 9) >= 0;
      this.commands.run(this.transit.toggleTerminal(x, z));
      this.hud.toast(was ? t('game.toast.terminalOff') : t('game.toast.terminalOn'));
      return;
    }
    const near = this.transit.stopNear(hit.x, hit.z, 9);
    if (near) {
      const c = this.transit.removeStop(near[0], near[1]);
      if (c) this.commands.run(c);
      this.lineSel = near[0];
      return;
    }
    const net = this.world.roads, sc = net.segs.cols;
    if (!this.transit.line(this.lineSel)) this.newLine();
    const line = this.transit.line(this.lineSel)!;
    const rail = (line.mode ?? 0) > 0;
    const seg = net.nearestSeg(hit.x, hit.z, 30, (s) => PROFILE_INFO[sc.profile[s]].rail === rail);
    if (!seg) { this.hud.toast(rail ? t('game.toast.stationOnTrack') : t('game.toast.stopNearRoad')); return; }
    const q = net.quad(seg[0]);
    const p2 = new Float64Array(2), d2 = new Float64Array(2);
    bez(q, seg[1], p2); bezD(q, seg[1], d2);
    if (rail) {
      // station: on the track centreline
      const c = this.transit.addStop(this.lineSel, p2[0], p2[1]);
      if (c) this.commands.run(c);
      return;
    }
    const info = PROFILE_INFO[sc.profile[seg[0]]];
    if (!info.strips.some((s) => s.kind === 'sidewalk')) { this.hud.toast(t('game.toast.noSidewalk')); return; }
    const l = Math.hypot(d2[0], d2[1]) || 1;
    const lx = d2[1] / l, lz = -d2[0] / l;
    const side = (hit.x - p2[0]) * lx + (hit.z - p2[1]) * lz > 0 ? 1 : -1;
    const e = side > 0 ? info.edges[info.edges.length - 1] : info.edges[0];
    const other = side > 0 ? info.edges[0] : info.edges[info.edges.length - 1];
    const sw = e.strip.kind === 'sidewalk' ? e : other;
    const u = (sw.u0 + sw.u1) / 2;
    const c = this.transit.addStop(this.lineSel, p2[0] + lx * u, p2[1] + lz * u);
    if (c) this.commands.run(c);
  }

  /** Lines for the simulation and for rendering, when they change (or when the roads change). */
  private syncTransit(): void {
    const v = this.transit.version * 100000 + this.roadsVersion;
    // the stops: rebuilt when the lines change or a road is edited near a stop (not on every road edit)
    this.transitView.update(this.transit, this.world.roads, this.world.heights, this.transit.version, this.world.dirty);
    if (v !== this.linesSent) {
      this.linesSent = v;
      this.sim.postMessage({ type: 'lines', lines: this.transit.lines.map((l) => ({ id: l.id, color: l.color, buses: l.buses, stops: [...l.stops], mode: l.mode ?? 0, term: this.transit.terminalStops(l), loop: !!l.loop })) } satisfies ToSim);
    }
    if (this.tool === 'transit') {
      // no line chosen: the first of the tab's mode (none: the first click makes one)
      const ids = this.transit.lines.filter((l) => (l.mode ?? 0) === this.lineMode).map((l) => l.id);
      if (!this.transit.line(this.lineSel) && ids.length) this.lineSel = ids[0];
      const stats = this.simStats?.type === 'stats' ? this.simStats.lines : [];
      this.hud.setLines(this.transit.lines.map((l) => {
        const q = stats.find((x) => x.id === l.id);
        return { id: l.id, mode: l.mode ?? 0, color: l.color, loop: !!l.loop, buses: l.buses, stops: l.stops.length / 2, perHour: q ? q.perHour : 0, waiting: q ? q.waiting : 0 };
      }), this.lineSel);
    }
  }

  private clickLot(hit: THREE.Vector3 | null): void { this.editing.clickLot(hit); }
  private setLotMode(m: LotMode): void { this.editing.setLotMode(m); }
  private hoverLotTool(hit: THREE.Vector3 | null): void { this.editing.hoverLotTool(hit); }
  /** Lot tool click by the verification scripts (the lot mode decides what it does). */
  clickLotTool(hit: THREE.Vector3): void { this.editing.clickLotTool(hit); }
  private finishPoly(): void { this.editing.finishPoly(); }
  private grabCorner(hit: THREE.Vector3 | null): boolean { return this.editing.grabCorner(hit); }
  private dropCorner(hit: THREE.Vector3 | null): void { this.editing.dropCorner(hit); }
  private featureActions(): FeatureActions { return this.editing.featureActions(); }
  private clickLotExtra(hit: THREE.Vector3): void { this.editing.clickLotExtra(hit); }
  private renovate(id: number): void { this.editing.renovate(id); }
  private clickBuilding(hit: THREE.Vector3 | null, shift = false): void { this.editing.clickBuilding(hit, shift); }
  private editSelected(dFloors: number, arch?: number, fn?: number): void { this.editing.editSelected(dFloors, arch, fn); }
  private insideCmd(c: 'toggle' | 'up' | 'down'): void { this.editing.insideCmd(c); }
  private applyDesign(d: Design | null, floors?: number): void { this.editing.applyDesign(d, floors); }
  private demolishSelected(): void { this.editing.demolishSelected(); }

  private manoeuvreWait: ((m: Extract<FromSim, { type: 'manoeuvres' }>) => void) | null = null;
  /** Lot modes added by the gameplay front (split by line, curve side) and the points clicked so far. */
  private lotExtra: 'line' | 'curve' | null = null;
  private lotExtraPts: Array<[number, number]> = [];

  // ------------------------------------------------------ generated city

  /** Forgets the current city (roads, buildings, lines, history). */
  private resetCity(): void {
    const w = this.world;
    w.clearBuildings();
    w.items.clear();
    w.clearGround();
    w.roads.clear();
    this.growth.clear();
    this.pool.cancel('lots:');
    for (const l of this.layers) l.reset();
    this.props.clear();
    this.transit.clear();
    this.commands.clear();
    this.clouds = []; this.cloudView.set([]);
    w.signTexts.clear(); w.streetNames.clear(); this.textSigns.version++;
    w.money = START_MONEY;
    // another city: nothing of it is in the save yet, and it is not the city the slot holds
    w.tileInSave.fill(0);
    this.slotBase = null;
    w.gameId = (Math.random() * 2 ** 32) >>> 0;
  }

  /**
   * After a flow that rebuilds the world failed half way: the world on screen is incomplete, so saving is refused until
   * another city is opened or made (an autosave would write the half-built world over the player's save).
   */
  private saveBlocked = false;

  /** The window is closing: a save under way is waited for, then what is still unsaved is written. */
  private async saveBeforeClose(): Promise<void> {
    for (let k = 0; this.busy && k < 100; k++) await new Promise((r) => setTimeout(r, 200));
    if ((this.unsaved || this.world.saveDirty.includes(1)) && !this.saveBlocked) await this.save(true);
  }

  /**
   * Before an action that replaces the city on screen: when it has work not yet saved (edits, growth, ageing), the
   * player is asked. Synchronous, from the click (the buttons call it; the game's own flows do not ask).
   */
  private discardOk(): boolean {
    if (!this.unsaved && !this.world.saveDirty.includes(1)) return true;
    return window.confirm(t('save.discardConfirm'));
  }

  /** Ends a flow that rebuilds the world: the loading screen goes, the game is free; on failure, says why. */
  private endRebuild(err: unknown, what: string): void {
    this.generating = false;
    this.hud.hideLoading();
    this.busy = false;
    if (err === null) { this.saveBlocked = false; this.homeView = this.rig.state(); return; }
    console.error(`${what} failed:`, err);
    this.saveBlocked = true;
    this.hud.toast(t('game.toast.flowFailed', { what, message: (err as Error)?.message ?? String(err) }));
  }

  /** Whole city from the seed: terrain again, roads in a worker, terrain conformed per tile in parallel, lots and buildings. */
  /** How the generator lays each district's local streets (`jobs/cityField.ts`; ?estilo= in the address, or api). */
  cityStyle: CityStyle = 'classic';

  async generatedCity(style: CityStyle = this.cityStyle, medium = false): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    // the medium town is laid on a level plain (Roadcraft 2.0's flat map); the whole map keeps its relief
    this.world.seed = (medium ? this.world.seed | FLAT_BIT : this.world.seed & ~FLAT_BIT) >>> 0;
    const t0 = performance.now();
    const phase = (name: string) => console.log(`fase: ${name} ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    this.hud.showLoading(t('game.loading.city'));
    const w = this.world;
    try {
      this.resetCity();
      this.generating = true;
      await this.generateTerrain();
      phase('relevo');
      const city = await this.pool.run('cityGen', { seed: w.seed, style, medium }, { priority: 0 });
      phase('malha viária');
      this.hud.showLoading(t('game.loading.roads'));
      const ids: number[] = [];
      for (let i = 0; i < city.nodes.length; i += 3) ids.push(w.roads.addNode({ x: city.nodes[i], z: city.nodes[i + 1], y: city.nodes[i + 2] }));
      const nc = w.roads.nodes.cols;
      const perTile: number[][] = Array.from({ length: TILE_COUNT }, () => []);
      for (let k = 0; k < city.segs.length; k += 5) {
        const a = ids[city.segs[k]], b = ids[city.segs[k + 1]], profile = city.segs[k + 2];
        const mx = (nc.x[a] + nc.x[b]) / 2, mz = (nc.z[a] + nc.z[b]) / 2;
        try {
          w.roads.addSeg({ a, b, cx: mx, cz: mz, profile, flags: 0, zl: city.segs[k + 3], zr: city.segs[k + 4] });
        } catch { continue; }
        // straight segment to conform the terrain to, in every tile it touches
        const half = PROFILE_INFO[profile].right + 0.5;
        const rec = [nc.x[a], nc.z[a], nc.y[a], nc.x[b], nc.z[b], nc.y[b], half];
        const r = half + 8;
        const tx0 = tileX(Math.min(nc.x[a], nc.x[b]) - r), tx1 = tileX(Math.max(nc.x[a], nc.x[b]) + r);
        const tz0 = tileX(Math.min(nc.z[a], nc.z[b]) - r), tz1 = tileX(Math.max(nc.z[a], nc.z[b]) + r);
        for (let tz = tz0; tz <= tz1; tz++) for (let tx = tx0; tx <= tx1; tx++) perTile[tileId(tx, tz)].push(...rec);
      }
      // dead ends with a turning bulb: a disc when conforming the terrain
      for (const n of ids) {
        if (!bulbAt(w.roads, n)) continue;
        const half = BULB_R + BULB_WALK + 1, r = half + 8;
        const rec = [nc.x[n], nc.z[n], nc.y[n], nc.x[n], nc.z[n], nc.y[n], half];
        for (let tz = tileX(nc.z[n] - r); tz <= tileX(nc.z[n] + r); tz++) for (let tx = tileX(nc.x[n] - r); tx <= tileX(nc.x[n] + r); tx++) perTile[tileId(tx, tz)].push(...rec);
      }
      phase('vias inseridas');
      await Promise.all(perTile.map(async (list, t) => {
        if (!list.length) return;
        const segs = new Float32Array(list);
        const r = await this.pool.run('conform', { tile: t, segs }, { priority: 0, transfer: [segs.buffer] });
        w.tileMin[r.tile] = r.min; w.tileMax[r.tile] = r.max;
        w.layerDirty.add(r.tile);
        const tx = r.tile % MAP_TILES, tz = (r.tile / MAP_TILES) | 0;
        w.touchRect(tileOriginX(tx), tileOriginX(tz), tileOriginX(tx) + TILE_SIZE - 1, tileOriginX(tz) + TILE_SIZE - 1, Dirty.Terrain);
      }));
      this.generating = false;
      phase('relevo assentado');
      this.hud.showLoading(t('game.loading.lots'));
      this.growth.processDirty();
      await this.pool.whenIdle();
      phase('lotes');
      const n = this.growth.fillAll();
      phase('prédios');
      this.endRebuild(null, '');
      achieve('CIDADE_GERADA');
      const secs = ((performance.now() - t0) / 1000).toFixed(0);
      this.hud.toast(t('game.toast.generated', { secs, buildings: fmtInt(n), roads: fmtInt(w.roads.segs.size) }));
    } catch (err) {
      this.endRebuild(err, t('game.flow.generate'));
    }
  }

  // ------------------------------------------------------------- test city

  /** Worst case: fills the map with zoned streets and lets buildings grow on every lot. */
  private async testCity(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.hud.toast(t('game.toast.testCity'));
    const w = this.world;
    try {
      this.resetCity();
      const nodes: Float32Array[] = [], segs: Int32Array[] = [];
      await Promise.all(Array.from({ length: TILE_COUNT }, async (_, t) => {
        const r = await this.pool.run('debugTile', { seed: w.seed, tile: t }, { priority: 1 });
        // the tile's terrain is made again here: its range is its own (never widened by the previous map's)
        w.tileMin[r.tile] = r.min;
        w.tileMax[r.tile] = r.max;
        w.layerDirty.add(r.tile);
        nodes.push(r.roadNodes); segs.push(r.roadSegs);
      }));
      // streets: all the nodes first, then the segments (which may link tiles)
      const key = new Map<number, number>();
      for (const a of nodes) for (let k = 0; k < a.length; k += 5) {
        key.set(a[k] * 1000 + a[k + 1], w.roads.addNode({ x: a[k + 2], z: a[k + 3], y: a[k + 4] }));
      }
      const nc = w.roads.nodes.cols;
      for (const a of segs) for (let k = 0; k < a.length; k += 4) {
        const na = key.get(a[k] * 1000 + a[k + 1]), nb = key.get(a[k + 2] * 1000 + a[k + 3]);
        if (na === undefined || nb === undefined) continue;
        const mx = (nc.x[na] + nc.x[nb]) / 2, mz = (nc.z[na] + nc.z[nb]) / 2;
        const r = Math.hypot(mx, mz);
        const zone = r < 1300 ? Zone.Commercial : r < 2600 ? Zone.Mixed : mx > 2800 ? Zone.Industrial : Zone.Residential;
        // a horizontal segment (same j) follows line j; a vertical one, line i
        const profile = a[k + 1] === a[k + 3] ? lineProfile(a[k + 1]) : lineProfile(a[k]);
        w.roads.addSeg({ a: na, b: nb, cx: mx, cz: mz, profile, flags: 0, zl: zone, zr: zone });
      }
      // lots in the workers, then a building on every free lot
      this.growth.processDirty();
      await this.pool.whenIdle();
      const n = this.growth.fillAll();
      this.endRebuild(null, '');
      this.hud.toast(t('game.toast.testCityDone', { buildings: fmtInt(n), roads: fmtInt(w.roads.segs.size) }));
    } catch (err) {
      this.endRebuild(err, t('game.flow.testCity'));
    }
  }

  private insertBoxes(b: BoxColumns): void {
    for (let i = 0; i < b.count; i++) {
      this.world.addBuilding({ x: b.x[i], z: b.z[i], w: b.w[i], d: b.d[i], h: b.h[i], rot: b.rot[i], color: b.color[i], seed: b.seed[i], zone: b.zone[i], floors: b.floors[i], style: b.style[i], fn: b.fn[i], built: b.built[i], shape: b.shapeN[i] ? Array.from(b.shape.subarray(i * SHAPE_STRIDE, i * SHAPE_STRIDE + b.shapeN[i] * 2), (v) => v / SHAPE_SCALE) : undefined });
    }
  }

  // -------------------------------------------------- saving and loading

  /** The save files (saveFiles.ts): the browser's storage, or real files in the desktop game. */
  readonly saveStore: Promise<FileStore> = openSaveStore();
  /**
   * The committed generation of this city a save builds on (the one opened or saved last): a save writes only the
   * tiles that changed since and keeps the others' files. null: none (a new city): every tile in the save is written.
   */
  private slotBase: Generation | null = null;

  private async slot(): Promise<SaveSlot> { return new SaveSlot(await this.saveStore, SLOT); }

  /** In the browser, only the tab holding the slot's lock writes it (another tab of the game only reads). */
  private readonly slotLock = new SlotLock(SLOT, () => this.hud.toast(t('save.nowWriter')));

  /** Whether this tab writes the save (says why not when it does not). */
  private async mayWrite(): Promise<boolean> {
    await this.slotLock.ready;
    if (!this.slotLock.writer) this.hud.toast(t('save.otherTab'));
    return this.slotLock.writer;
  }

  /**
   * Writes a new generation of the save: the changed tiles, the map's description and the manifest, then the commit
   * (saveFiles.ts); until the commit the save before stays the one that opens. Everything is copied at the start, in
   * one go (tiles, their ground and water, money, clock, junctions…), so the files describe one moment. A tile's mark
   * and `unsaved` are cleared only once the commit is written, and only if nothing changed after the copy; a failed
   * save leaves them set and the next save tries again. True when the save completed.
   */
  private async save(auto = false): Promise<boolean> {
    const g = this;
    const host: SaveHost = {
      world: g.world, pool: g.pool, hud: g.hud, rig: g.rig, transit: g.transit, settings: g.settings,
      skyMode: g.skyMode, weatherCtl: g.weatherCtl, waterCtl: g.waterCtl, clouds: g.clouds, hour: g.hour,
      get saveBlocked() { return g.saveBlocked; },
      get unsavedSerial() { return g.unsavedSerial; },
      get busy() { return g.busy; }, set busy(v) { g.busy = v; },
      get unsaved() { return g.unsaved; }, set unsaved(v) { g.unsaved = v; },
      get slotBase() { return g.slotBase; }, set slotBase(v) { g.slotBase = v; },
      mayWrite: () => g.mayWrite(), slot: () => g.slot(), keepSlotForThisCity: (slot) => g.keepSlotForThisCity(slot),
    };
    return saveSession(host, auto);
  }

  /**
   * Opens the saved city: its committed generation, or the one before it when that one cannot be used (a file gone or
   * damaged); when no generation can be fully read, the newest is opened and its unreadable tiles come back from the
   * seed. Any failure after the world was cleared ends the flow (no hung loading screen) and blocks saving until
   * another city is opened or made, so the half-built world never overwrites the save. A storage that fails stops the
   * opening and touches nothing. True when the city opened.
   */
  private async load(): Promise<boolean> {
    const g = this;
    const host: LoadHost = {
      get busy() { return g.busy; }, set busy(v) { g.busy = v; },
      hud: g.hud,
      slot: () => g.slot(),
      openGeneration: (slot, gen, last) => g.openGeneration(slot, gen, last),
      endRebuild: (err, what) => g.endRebuild(err, what),
    };
    return loadSession(host);
  }

  /**
   * Rebuilds the world from generation `g`. A tile file that cannot be used (gone, cut, damaged, undecodable): with
   * `last` false the result is null and the world is left half built (the caller opens another generation); with
   * `last` its terrain comes back from the seed and it is counted. A storage failure throws.
   */
  private async openGeneration(slot: SaveSlot, g: Generation, last: boolean): Promise<{ missing: number; damaged: number; repaired: number; cut: number } | null> {
    const w = this.world;
    const meta = decodeMeta(g.metaBytes);
    w.clearBuildings();
    w.items.clear();
    w.clearGround();
    w.roads.clear();
    this.growth.clear();
    // lots still being made for the city that was on screen are not taken in by this one
    this.pool.cancel('lots:');
    for (const l of this.layers) l.reset();
    this.props.clear();
    this.transit.clear();
    this.commands.clear();
    try { setCustomProfiles(meta.profiles ? JSON.parse(meta.profiles) as Profile[] : []); } catch { setCustomProfiles([]); }
    w.clearGround();
    this.setBiome(meta.biome ?? 0);
    // the balance is saved even with unlimited money on (older saves wrote NaN then: the starting cash comes back)
    w.unlimited = meta.money !== undefined && Number.isNaN(meta.money);
    w.money = meta.money !== undefined && !Number.isNaN(meta.money) ? meta.money : START_MONEY;
    const roads: RoadSave[] = [];
    w.seed = meta.seed;
    w.gameId = meta.gameId;
    if (meta.hour !== undefined) this.hour = meta.hour;
    if (meta.transit) this.transit.decode(meta.transit); else this.transit.clear();
    try {
      const extra = meta.extra ? JSON.parse(meta.extra) as { sky?: SkyMode; weather?: WeatherCtl | null; water?: { waves: number; foam: number; current: number } } : {};
      this.setWater(extra.water ?? { waves: 0.3, foam: 0.4, current: 0.5 });
      const ex = extra as { clouds?: Cloud[]; fog?: number; terminals?: number[]; signs?: Array<[string, string]>; streets?: Array<[number, string]>; clock?: number; paint?: string; unlimited?: boolean };
      w.clock = ex.clock ?? 0;
      if (ex.unlimited !== undefined) w.unlimited = ex.unlimited;
      // regional road paint is part of the map (Roadcraft): a map saved in "EUA" opens in "EUA"
      if (ex.paint && ex.paint !== this.settings.paint) { this.settings.paint = ex.paint; setPaintStyle(ex.paint); }
      w.signTexts.clear(); for (const [k, v] of ex.signs ?? []) w.signTexts.set(k, v);
      w.streetNames.clear(); for (const [k, v] of ex.streets ?? []) w.streetNames.set(k, v);
      this.textSigns.version++;
      this.transit.terminals = ex.terminals ?? []; this.transit.version++;
      this.clouds = ex.clouds ?? []; this.cloudView.set(this.clouds); fogLevel.value = ex.fog ?? 1;
      this.skyMode = extra.sky ?? 'ciclo'; this.hud.setSky(this.skyMode);
      this.setWeather(extra.weather ?? null);
    } catch { /* old save */ }
    w.tileInSave.fill(0);
    for (const t of g.tiles.keys()) w.tileInSave[t] = 1;
    const unreadable: number[] = [];
    let missing = 0;
    const reads = limiter(WRITES_AT_ONCE);
    // every tile ends before the opening goes on or gives up (a tile still arriving would land in the next opening)
    const done = await Promise.allSettled(Array.from({ length: TILE_COUNT }, async (_, t) => {
      const ref = g.tiles.get(t);
      let r: JobResults['unpackTile'] | null = null;
      if (ref) {
        let why = g.missing.get(t) ?? '';
        let gone = !!why;
        if (!why) {
          try {
            const data = await reads(() => slot.readTile(g, t));
            r = await this.pool.run('unpackTile', { tile: t, data, hash: ref.hash }, { key: `terrain:${t}`, priority: 0, transfer: [data.buffer as ArrayBuffer] });
            why = r.ok ? '' : r.reason ?? 'unreadable';
          } catch (err) {
            // a storage failure stops the opening; a file that is gone or cut is a tile that cannot be used
            if (!(err instanceof TileFileError)) throw err;
            why = err.message; gone = true;
          }
        }
        if (why) { console.warn(`save: tile ${t} of generation ${g.gen} cannot be used: ${why}`); unreadable.push(t); if (gone) missing++; r = null; }
        else if (r) {
          if (!ref.hash) ref.hash = r.hash; // a save from before generations: the next one records it
          w.tileMin[t] = r.min; w.tileMax[t] = r.max;
          if (r.boxes) this.insertBoxes(r.boxes);
          if (r.roads) roads.push(r.roads);
          if (r.roads?.items) w.items.loadTile(r.roads.items);
          w.groundDirty.add(t); w.waterDirty.add(t);
          w.tileWater[t] = r.hasWater ? 1 : 0;
        }
      }
      if (!r && (last || !ref)) {
        // not in the save, or (as a last resort) unusable: the terrain comes back from the seed
        const gr = await this.pool.run('terrainGen', { seed: w.seed, tile: t }, { key: `terrain:${t}`, priority: 0 });
        w.tileMin[t] = gr.min; w.tileMax[t] = gr.max; w.tileWater[t] = gr.hasWater ? 1 : 0; w.waterDirty.add(t);
      }
      w.layerDirty.add(t);
      for (const c of cellsOfTile(t)) w.touchCell(c, Dirty.Terrain | Dirty.Buildings);
    }));
    const failed = done.find((r) => r.status === 'rejected');
    if (failed) throw (failed as PromiseRejectedResult).reason;
    if (unreadable.length && !last) return null;
    // roads: all nodes before the segments (segments link tiles). A segment saved with its first end whose other end
    // was in a tile that could not be read is left out (it would link to a node that is not there); its tile is
    // written again at the next save
    for (const r of roads) w.roads.loadNodes(r);
    const alive = w.roads.nodes.alive, nc = w.roads.nodes.cols, cutTiles = new Set<number>();
    let cut = 0;
    for (const r of roads) {
      const s = r.segs, keep: number[] = [];
      for (let k = 0; k < s.length; k += SEG_REC) {
        if (alive[s[k + 1]] && alive[s[k + 2]]) { for (let i = 0; i < SEG_REC; i++) keep.push(s[k + i]); continue; }
        cut++;
        const end = alive[s[k + 1]] ? s[k + 1] : s[k + 2];
        if (alive[end]) cutTiles.add(tileId(tileX(nc.x[end]), tileX(nc.z[end])));
      }
      w.roads.loadSegs(keep.length === s.length ? r : { ...r, segs: new Float32Array(keep) });
    }
    // the far road paint of every tile is made again (a tile that lost its roads would keep the old paint)
    for (let t = 0; t < TILE_COUNT; t++) w.dirty.mark(cellsOfTile(t)[0], Dirty.RoadPaint);
    try {
      for (const [id, spec] of meta.junctions ? JSON.parse(meta.junctions) as Array<[number, JunctionSpec]> : []) if (w.roads.nodes.alive[id]) w.roads.setJunction(id, spec);
    } catch { /* save without chosen junctions */ }
    // what was read is what the save holds (opening itself marked it unsaved: clearing the history, water, weather);
    // only the repair below and the tiles that lost a segment or could not be read need writing
    this.unsaved = false;
    w.saveDirty.fill(0);
    // a tile that could not be read now holds the seed's terrain: the next save writes it, so the damaged file stops
    // coming back at every opening (it was kept in quarantine)
    for (const t of [...cutTiles, ...unreadable]) { w.saveDirty[t] = 1; w.saveVer[t]++; }
    if (unreadable.length) this.unsaved = true;
    if (cut) this.unsaved = true;
    // old maps: dead ends lying inside another road become junctions (marked to save)
    const repaired = repairDanglingEnds(w);
    if (repaired) this.unsaved = true;
    this.rig.restore(meta.camera);
    this.hud.setView(this.rig.mode);
    this.saveBlocked = false;
    this.slotGame = meta.gameId;
    this.slotBase = g;
    return { missing, damaged: unreadable.length - missing, repaired, cut };
  }

  /** Saves and downloads the whole map as a .cidade file (only a save that completed is exported, nothing else). */
  private async exportMap(): Promise<void> {
    if (!await this.save()) { this.hud.toast(t('save.exportNotSaved')); return; }
    if (this.busy) return;
    this.busy = true;
    let blob: Blob | null;
    try { blob = await packSlot(await this.slot()); } catch (err) {
      this.hud.toast(t('save.failed', { message: errorText(err) }));
      return;
    } finally { this.busy = false; }
    if (!blob) { this.hud.toast(t('save.exportNothing')); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `cidade-${this.world.seed}.cidade`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    this.hud.toast(t('save.exported', { mb: (blob.size / 1024 / 1024).toFixed(1) }));
  }

  /**
   * Opens a map from a file. The file is read and checked (its map description and every file it lists) before
   * anything is touched; the city saved before is kept as a previous city; then the file's save is committed as a new
   * generation of the slot and opened.
   */
  private async importMap(file: Blob): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    if (!await this.mayWrite()) { this.busy = false; return; }
    let kept: string | null;
    try {
      const saved = await savedIn(await readPackage(file));
      try { decodeMeta(saved.meta); } catch (err) {
        if (!(err instanceof MapSizeError && MAP_SIZES.includes(err.tiles))) throw new MapFileError(/newer/.test(errorText(err)) ? 'save.file.newer' : 'save.file.damaged', errorText(err));
      }
      const slot = await this.slot();
      kept = await keepPreviousCity(slot);
      await slot.adopt(saved.meta, saved.tiles, saved.gameId, saved.seed);
    } catch (err) {
      this.hud.toast(t('save.importFailed', { why: err instanceof MapFileError ? t(err.key) : errorText(err) }));
      return;
    } finally {
      this.busy = false;
    }
    this.slotGame = null;
    this.slotBase = null;
    if (kept) this.hud.toast(t('save.keptPrevious', { folder: kept }));
    await this.load();
  }

  /**
   * The slot holds one city. Before the first save of another city (a new map, a generated one, an imported one), the
   * city saved there is copied aside as a previous city, never overwritten. Throws when the copy fails (nothing is
   * written then).
   */
  private async keepSlotForThisCity(slot: SaveSlot): Promise<void> {
    const w = this.world;
    if (this.slotGame === w.gameId) return;
    const opened = await slot.open();
    // a save that cannot be read (damaged) is kept aside too
    if (opened.found && opened.generations[0]?.game !== w.gameId) {
      const kept = await keepPreviousCity(slot);
      if (kept) this.hud.toast(t('save.keptPrevious', { folder: kept }));
    }
    this.slotGame = w.gameId;
  }

  /** The gameId of the city in the save slot (null: not known yet). */
  private slotGame: number | null = null;

  /** The previous cities kept aside (mapFile.ts), for the interface (hudActions). */
  private saveActions(): SaveActions {
    return {
      previousCities: async () => previousCities(await this.saveStore, SLOT),
      openPreviousCity: (folder) => { if (this.discardOk()) void this.openPreviousCity(folder); },
    };
  }

  /**
   * Puts a previous city back in the save and opens it: the city in the save goes aside first (a previous city in its
   * turn), then the previous city's save becomes a new generation of the slot.
   */
  private async openPreviousCity(folder: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    if (!await this.mayWrite()) { this.busy = false; return; }
    let kept: string | null;
    try { kept = await restorePrevious(await this.slot(), folder); } catch (err) {
      this.hud.toast(t('save.previousFailed', { why: errorText(err) }));
      return;
    } finally {
      this.busy = false;
    }
    this.slotGame = null;
    this.slotBase = null;
    if (kept) this.hud.toast(t('save.keptPrevious', { folder: kept }));
    await this.load();
  }

  private async newMap(): Promise<void> {
    const g = this;
    const host: NewMapHost = {
      get busy() { return g.busy; }, set busy(v) { g.busy = v; },
      world: g.world, hud: g.hud,
      resetCity: () => g.resetCity(),
      generateTerrain: () => g.generateTerrain(),
      endRebuild: (err, what) => g.endRebuild(err, what),
    };
    return newMapSession(host);
  }
}


// Ties everything together: world, workers, camera, rendering, tools, saving and loading.
// The page only does input, interface, choosing what to draw, and drawing.

import * as THREE from 'three/webgpu';
import { CELLS_PER_TILE, MAP_SIZES, MAP_TAG, MAP_TILES, TILE_SIZE } from './config.ts';

/** Changes the map size: the world arrays are sized to the map, so the page reloads. */
const FLASH_COLOR = new THREE.Color(0xdde6ff);

function reloadWithMap(tiles: number, then: string): void {
  try { localStorage.setItem('cidade.mapa', String(tiles)); } catch { /* no storage: it goes through the URL */ }
  location.href = `${location.pathname}?mapa=${tiles}&${then}`;
}
import { CommandStack } from './core/commands.ts';
import { CELL_COUNT, Dirty, TILE_COUNT, cellId, tileId, tileOfCell, tileOriginX, tileX } from './core/grid.ts';
import { JobPool } from './jobs/pool.ts';
import { packTileHeights } from './jobs/storage.ts';
import { SHAPE_SCALE, SHAPE_STRIDE, boxTransfer, roadGraphTransfer, type BoxColumns, type RoadSave } from './jobs/protocol.ts';
import { CameraRig } from './render/cameraRig.ts';
import { createCity, createCityDetail } from './render/city.ts';
import { createRoads, createTrafficLook, setPaintStyle, trafficOverlayU, zoneOverlayU, type TrafficLook } from './render/roads.ts';
import type { CellLayer } from './render/cellLayer.ts';
import { createScene, setTimeOfDay, type SceneParts } from './render/scene.ts';
import { TerrainRenderer, gridU } from './render/terrain.ts';
import { MapSizeError, decodeMeta, encodeMeta } from './save.ts';
import { createPoseBuffers, PoseReader, viewPoseBuffers } from './sim/poses.ts';
import { encodeOps } from './sim/lanes.ts';
import { VehicleRenderer } from './render/vehicles.ts';
import type { PersonOptions } from './render/people/creator.ts';
import { PropRenderer } from './render/props.ts';
import { TransitRenderer } from './render/transit.ts';
import { Post } from './render/post.ts';
import { achieve } from './steam.ts';
import { OptionsPanel, PRESETS, keepOverAddress, loadSettings, saveSettings, type Preset, type Settings } from './ui/options.ts';
import { StartMenu } from './ui/menu.ts';
import { Weather, cloudsU, flashU, rainU, windDirU, windU } from './render/weather.ts';
import { Ambient } from './audio.ts';
import { Particles } from './render/particles.ts';
import { fmtDec, fmtInt, followLanguage, loose, money, onLanguageReload, plural, setLang, t } from './ui/i18n.ts';
import { HealthPanel } from './ui/health.ts';
import { Creator } from './ui/creator.ts';
import { decodeDesign, encodeDesign, hasDesign, type Design } from './world/design.ts';
import { currentU, fogLevel, foamU, nightU, waveU } from './render/scene.ts';
import { Transit } from './world/transit.ts';
import type { JunctionSpec } from './roads/control.ts';
import { PROFILES, PROFILE_INFO, customProfiles, onProfileAdded, setCustomProfiles, type Profile } from './roads/profiles.ts';
import { bez, bezD } from './roads/geometry.ts';
import { arrowCode } from './roads/laneLinks.ts';
import type { NetOp } from './roads/network.ts';
import type { FromSim, ToSim } from './sim/worker.ts';
import { Inspector } from './ui/inspector.ts';
import { installKeys } from './ui/keys.ts';
import { attachPinch } from './ui/touch.ts';
import { BOMB_START, bombRadius } from './ui/strike.ts';
import { ItemTool } from './tools/itemTool.ts';
import { GROUND_TOOLS, Hud, ROAD_TOOLS, TERRAIN_TOOLS, type HudActions, type LotMode, type SkyMode, type SkyToolState, type Tool, type WeatherCtl } from './ui/hud.ts';
import { CloudPuffs, MAX_CLOUDS, type Cloud } from './render/cloudPuffs.ts';
import { InsideView } from './render/inside.ts';
import { Blast } from './render/blast.ts';
import { TextSigns, signKey } from './render/textSigns.ts';
import { demolishBox } from './tools/demolish.ts';
import { curveLotSide, deleteLot, joinLots, lotAt, lotToWorld, moveLotCorner, nearestCorner, polygonLot, polygonRect, setLotFront, splitLot, splitLotByLine } from './world/lotEdit.ts';
import type { FeatureActions } from './tools/featureActions.ts';
import { addressAt } from './roads/streetNames.ts';
import { Ground, GroundStroke, RiverCommand, WATER_MAP_RES, WATER_TILE_RES, waterCoord, waterIndex } from './world/ground.ts';
import { ElementStroke, Item, ItemsCommand } from './world/items.ts';
import { RoadTool } from './tools/roadTool.ts';
import { ZoneTool } from './tools/zoneTool.ts';
import { Growth, floorsFor } from './world/growth.ts';
import { Rng } from './core/rng.ts';
import { RoadJournal, addCrossing, addUTurn, buildRoad, streetChain, demolishSeg, duplicateRoad, joinAt, moveNode, planRoad, reverseRoad, segPreview, snap, splitAt, bulbAt } from './roads/build.ts';
import { BULB_R, BULB_WALK } from './roads/junction.ts';
import { Zone } from './roads/zones.ts';
import { RoadPreview } from './render/preview.ts';
import { BrushStroke, FlattenMap, LANDFORM_ROCK, type BrushMode, type BrushParams } from './world/brush.ts';
import { START_MONEY, World } from './world/world.ts';
import { heightAt } from './world/heights.ts';
import { lineProfile } from './jobs/debugCity.ts';
import { keepPreviousCity, packSlot, quarantineSlot, unpackToSlot } from './mapFile.ts';
import { repairDanglingEnds } from './roads/repair.ts';

const SLOT = 'cidade-1';
/** Segments that fit in the occupancy map (2 directions per segment). */
export const OCCUPANCY_SEGS = 1 << 17;

export const status = { value: 'carregando' };
/** State exposed to the shell (automated photos and checks): `setLang` is the language menu's own action. */
const debug: { status: string; game: unknown; setLang: typeof setLang } = { get status() { return status.value; }, game: null, setLang };
(globalThis as { __cidade?: unknown }).__cidade = debug;

function cellsOfTile(t: number): number[] {
  const tx = t % MAP_TILES, tz = (t / MAP_TILES) | 0;
  const out: number[] = [];
  for (let j = 0; j < CELLS_PER_TILE; j++) for (let i = 0; i < CELLS_PER_TILE; i++) out.push(cellId(tx * CELLS_PER_TILE + i, tz * CELLS_PER_TILE + j));
  return out;
}

export class Game {
  readonly world = new World();
  readonly pool: JobPool;
  readonly commands = new CommandStack();
  readonly hud: Hud;
  /** The panel button actions (test scripts call the same thing the button does). */
  hudActions!: HudActions & FeatureActions;
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
  private drag: 'none' | 'pan' | 'rotate' | 'brush' | 'click' | 'zone' | 'node' | 'box' | 'row' | 'free' = 'none';
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
        if (Math.abs(lx) <= col.w[id] * 0.35 && Math.abs(lz) <= col.d[id] * 0.3) top = Math.max(top, heightAt(this.world.heights, col.x[id], col.z[id]) + 1.5 + col.floors[id] * 3.2);
      });
      return top;
    };
    this.terrain = new TerrainRenderer(this.world);
    this.city = createCity(this.world, this.pool);
    this.cityDetail = createCityDetail(this.world, this.pool, this.city.material);
    // per segment: occupancy a→b, b→a, asphalt wear (simulation), free
    this.occupancySab = new SharedArrayBuffer(OCCUPANCY_SEGS * 4);
    this.trafficLook = createTrafficLook(this.occupancySab);
    this.roads = createRoads(this.world.roads, this.pool, this.world.dirty, this.trafficLook);
    this.layers = [this.roads, this.city, this.cityDetail];

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

    this.hud = new Hud(this.hudActions = Object.assign(this.featureActions(), {
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
      generate: () => { if (this.discardOk()) { this.world.seed = (Math.random() * 2 ** 31) >>> 0 || 1; void this.generatedCity(); } },
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
      cameraNumbers: () => ({ dist: this.rig.dist, x: this.rig.target.x, z: this.rig.target.z }),
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
      nameStreet: (seg, name) => {
        const w = this.world, chain = streetChain(w, seg);
        const before = chain.map((x) => w.streetNames.get(x));
        this.commands.run({
          label: 'nome da rua',
          apply: () => { for (const x of chain) w.streetNames.set(x, name); this.textSigns.version++; this.unsaved = true; },
          invert: () => { chain.forEach((x, i) => { const b = before[i]; if (b === undefined) w.streetNames.delete(x); else w.streetNames.set(x, b); }); this.textSigns.version++; },
        });
      },
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
    // changing the language reloads the page: the city is saved first; if that fails, the player decides
    onLanguageReload(async () => {
      if (!this.unsaved && !this.world.saveDirty.includes(1)) return true;
      if (await this.save()) return true;
      return window.confirm(t('save.languageDiscard'));
    });
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
    this.inside.show(0, 0, 20, 20, 0, -1000, 0, 3.2); // compiles the inside-view materials at load
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
    renderer.setAnimationLoop((t) => this.frame(t));
    if (params.has('teste')) await this.testCity();
    else if (params.has('cidade')) await this.generatedCity();
    else if (params.has('carregar')) await this.load();
    else if (!params.has('cam') && !params.has('vazio')) {
      // start screen (automated photos skip it with ?cam, ?teste or ?cidade)
      this.showStart();
    }
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
    this.rig.restore(new Float64Array([x, z, yaw * Math.PI / 180, pitch * Math.PI / 180, dist, 0]));
    if (hour !== undefined) { this.hour = hour; this.clockSpeed = 0; }
    await new Promise((r) => setTimeout(r, 500));
    await this.settle(4);
  }

  /** Waits for the workers to drain (for photos and tests). */
  async settle(frames = 20): Promise<void> {
    let quiet = 0;
    while (quiet < frames) {
      await new Promise((r) => requestAnimationFrame(r));
      quiet = this.pool.isIdle() ? quiet + 1 : 0;
    }
  }

  /** Generates the base terrain from the seed, one tile per job. */
  /** Terrain of every tile from the seed, in the workers; rejects if any tile fails. */
  private async generateTerrain(): Promise<void> {
    await Promise.all(Array.from({ length: TILE_COUNT }, async (_, t) => {
      const r = await this.pool.run('terrainGen', { seed: this.world.seed, tile: t }, { key: `terrain:${t}`, priority: 0 });
      this.world.tileMin[r.tile] = r.min;
      this.world.tileMax[r.tile] = r.max;
      this.world.layerDirty.add(r.tile);
      // the tile's props (trees) depend on the terrain
      const tx = r.tile % MAP_TILES, tz = (r.tile / MAP_TILES) | 0;
      this.world.dirty.markRect(tileOriginX(tx), tileOriginX(tz), tileOriginX(tx) + TILE_SIZE - 1, tileOriginX(tz) + TILE_SIZE - 1, Dirty.Props);
    }));
  }

  // ----------------------------------------------------------------- frame

  private frame(now: number): void {
    this.health?.frame(now - this.last);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const { renderer, scene } = this.parts;

    this.rig.update(dt);
    const cam = this.rig.camera;
    // always day (or night) fixes the light only: the clock, and the traffic demand that follows it, go on
    if (!this.paused) this.hour = (this.hour + dt * this.clockSpeed / 60) % 24;
    const light = this.skyMode === 'dia' ? 12 : this.skyMode === 'noite' ? 22 : this.hour;
    // city clock in minutes (building decay); the sky mode only fixes the light
    if (!this.paused) this.world.advanceClock(dt * this.clockSpeed);
    if (now > this.autosaveAt) { this.autosaveAt = now + 120000; if ((this.unsaved || this.world.saveDirty.includes(1)) && !this.busy && !this.saveBlocked) void this.save(true); }
    const groundY = heightAt(this.world.heights, this.rig.eye.x, this.rig.eye.z);
    this.weather.viewAngle = Math.atan2(this.rig.target.z - this.rig.eye.z, this.rig.target.x - this.rig.eye.x);
    this.weather.update(dt, dt * this.clockSpeed * 60, this.rig.eye, groundY, (this.parts.scene.fog as THREE.FogExp2).color);
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

    const pf = this.perfLog, T0 = pf ? performance.now() : 0;
    for (const l of this.layers) l.processDirty();
    this.world.dirty.drain(Dirty.Terrain); // nothing but rendering depends on this yet
    this.processRoadPaint();
    if (this.arrowNodes.size) this.updateArrows();
    const T1 = pf ? performance.now() : 0;
    if (!this.generating) this.growth.processDirty();
    this.growth.step(dt);
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

    if (this.post) { this.post.setCamera(cam); this.post.render(); }
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
    const t = performance.now();
    if (!this.lastTrips || st.arrived < this.lastTrips.arrived) { this.lastTrips = { t, arrived: st.arrived, lost: st.lost }; return; }
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

  /** Sends the network changes and the camera position to the simulation. */
  private syncSim(now: number): void {
    if (this.netOps.length) {
      if (this.transit.lines.length) this.roadsVersion++;
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
      const demand = st?.demand === 'baixa' ? 0.6 : st?.demand === 'pico' ? 1.5 : 1;
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
    const c = this.canvas;
    const down = { x: 0, y: 0, button: -1 };
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    // two fingers zoom (src/ui/touch.ts runs before the listeners below)
    attachPinch(c, this.rig);
    c.addEventListener('pointerdown', (e) => {
      this.ambient.start();
      c.setPointerCapture(e.pointerId);
      this.pointer.x = e.offsetX; this.pointer.y = e.offsetY;
      down.x = e.offsetX; down.y = e.offsetY; down.button = e.button;
      if (e.button === 2) this.drag = 'rotate';
      else if (e.button === 1 || (e.button === 0 && this.tool === 'camera')) {
        this.drag = 'pan';
        this.rig.beginPan(this.ndcX(), this.ndcY());
      } else if (e.button === 0 && TERRAIN_TOOLS.includes(this.tool)) {
        this.drag = 'brush';
        this.stroke = new BrushStroke(this.world);
        this.rockStroke = LANDFORM_ROCK[this.brush.mode] !== undefined ? new GroundStroke(this.world) : null;
      } else if (e.button === 0 && this.tool === 'sky' && this.skyTool.fog !== 'none') {
        this.drag = 'brush';
        this.elemStroke = new ElementStroke(this.world.items);
      } else if (e.button === 0 && this.tool === 'sky' && this.skyTool.cloud === 'move' && this.grabCloud(this.rig.pick(this.ndcX(), this.ndcY()))) {
        this.drag = 'node';
      } else if (e.button === 0 && this.tool === 'elements') {
        this.drag = 'brush';
        this.elemStroke = new ElementStroke(this.world.items);
      } else if (e.button === 0 && this.tool === 'forest' && this.forestOne) {
        this.drag = 'click';
      } else if (e.button === 0 && GROUND_TOOLS.includes(this.tool)) {
        this.drag = 'brush';
        this.stroke = new GroundStroke(this.world);
      } else if (e.button === 0 && this.tool === 'free' && this.roadTool.freeBegin(this.rig.pick(this.ndcX(), this.ndcY()))) {
        this.drag = 'free';
      } else if (e.button === 0 && this.tool === 'move' && this.roadTool.grab(this.rig.pick(this.ndcX(), this.ndcY()))) {
        this.drag = 'node';
      } else if (e.button === 0 && this.tool === 'building' && this.lotMode === 'corner' && this.grabCorner(this.rig.pick(this.ndcX(), this.ndcY()))) {
        this.drag = 'node';
      } else if (e.button === 0 && this.tool === 'zone' && !this.zoneBlock) {
        this.drag = 'zone';
        this.zoneTool.begin();
      } else if (e.button === 0) {
        this.drag = 'click'; // becomes a camera drag if it moves
      }
      e.preventDefault();
    });
    c.addEventListener('pointermove', (e) => {
      const dx = e.offsetX - this.pointer.x, dy = e.offsetY - this.pointer.y;
      this.pointer.x = e.offsetX; this.pointer.y = e.offsetY;
      this.pointer.inside = true;
      if (this.drag === 'click' && (this.tool === 'bulldoze' || this.tool === 'streetscape') && Math.hypot(e.offsetX - down.x, e.offsetY - down.y) > 5) {
        const px = this.pointer.x, py = this.pointer.y;
        this.pointer.x = down.x; this.pointer.y = down.y;
        this.boxStart = this.rig.pick(this.ndcX(), this.ndcY());
        this.pointer.x = px; this.pointer.y = py;
        if (this.boxStart) this.drag = this.tool === 'streetscape' ? 'row' : 'box';
      }
      if (this.drag === 'click' && Math.hypot(e.offsetX - down.x, e.offsetY - down.y) > 5) {
        this.drag = 'pan';
        this.pointer.x = down.x; this.pointer.y = down.y;
        this.rig.beginPan(this.ndcX(), this.ndcY());
        this.pointer.x = e.offsetX; this.pointer.y = e.offsetY;
      }
      if (this.drag === 'rotate') this.rig.rotate(dx, dy);
      else if (this.drag === 'pan') this.rig.pan(this.ndcX(), this.ndcY());
    });
    const end = (e: PointerEvent) => {
      if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
      const still = Math.hypot(e.offsetX - down.x, e.offsetY - down.y) <= 5;
      if (this.drag === 'brush' && this.elemStroke) {
        if (!this.elemStroke.cmd.empty) this.commands.push(this.elemStroke.cmd);
        this.elemStroke = null;
      }
      if (this.drag === 'brush' && this.stroke) {
        const rock = this.rockStroke;
        this.rockStroke = null;
        if (this.stroke.finish()) {
          // landform: the terrain and the painted rock are a single undo step
          const terr = this.stroke;
          if (rock && rock.finish()) this.commands.push({ label: 'relevo', apply: () => { terr.apply(); rock.apply(); }, invert: () => { rock.invert(); terr.invert(); } });
          else this.commands.push(terr);
        }
        this.stroke = null;
      }
      if (this.drag === 'zone') this.zoneTool.end();
      if (this.drag === 'free') this.roadTool.freeEnd(this.rig.pick(this.ndcX(), this.ndcY()));
      if (this.drag === 'row' && this.boxStart) {
        const b = this.rig.pick(this.ndcX(), this.ndcY());
        if (b) this.itemTool.row(this.boxStart.x, this.boxStart.z, b.x, b.z);
        this.preview.hideAll();
        this.boxStart = null;
      }
      if (this.drag === 'box' && this.boxStart) {
        const b = this.rig.pick(this.ndcX(), this.ndcY());
        const r = b ? demolishBox(this.world, this.boxStart.x, this.boxStart.z, b.x, b.z) : null;
        this.preview.hideAll();
        if (r) { this.commands.push(r.cmd); this.hud.toast((plural('game.toast.demolished', r.count) + (r.charge < 0 ? t('game.toast.refunded', { money: money(-r.charge) }) : '') + '.')); }
        this.boxStart = null;
      }
      if (this.drag === 'node' && this.cloudGrab >= 0) { this.dropCloud(this.rig.pick(this.ndcX(), this.ndcY())); }
      else if (this.drag === 'node' && this.cornerDrag) this.dropCorner(this.rig.pick(this.ndcX(), this.ndcY()));
      else if (this.drag === 'node') this.roadTool.drop(this.rig.pick(this.ndcX(), this.ndcY()));
      if (this.drag === 'click' && still && e.type === 'pointerup') {
        const hit = this.rig.pick(this.ndcX(), this.ndcY());
        if (this.tool === 'inspect') { if (hit) this.inspector.pick(hit.x, hit.z); }
        else if (this.tool === 'river') { if (hit) this.riverPts.push([hit.x, hit.z]); }
        else if (this.tool === 'barrier' && this.itemRemove) this.removePole(hit);
        else if (this.tool === 'streetscape' || this.tool === 'barrier') { this.itemTool.click(hit, e.shiftKey); if (this.tool === 'barrier' && !e.shiftKey && hit) this.wallOpen = true; }
        else if (this.tool === 'building') this.clickBuilding(hit, e.shiftKey);
        else if (this.tool === 'transit') this.clickTransit(hit, e.shiftKey || this.transitTerminal);
        else if (this.tool === 'forest' && this.forestOne) { if (hit) this.plantTree(hit.x, hit.z); }
        else if (this.tool === 'sky') { if (hit) this.clickSky(hit.x, hit.z); }
        else if (this.tool === 'person') { if (hit) this.placePerson(hit.x, hit.z); }
        else if (this.tool === 'pistol') { if (hit) this.shoot(hit.x, hit.z); }
        else if (this.tool === 'bomb') { if (hit) this.bomb(hit.x, hit.z); }
        else if (this.tool === 'weather') { if (hit) this.weather.strikeAt(this.rig.eye, hit.x, hit.z, heightAt(this.world.heights, hit.x, hit.z)); }
        else if (this.tool === 'zone' && this.zoneBlock) { if (hit) { const r = this.zoneTool.fillBlock(hit.x, hit.z); if (r !== 'ok') this.hud.toast(r); } }
        else if (e.altKey && ROAD_TOOLS.includes(this.tool)) {
          const p = this.roadTool.pick(hit);
          if (p >= 0) { this.hud.setProfile(p); this.hud.toast(t('game.toast.profileCopied', { name: loose(PROFILE_INFO[p].name) })); }
        } else this.roadTool.click(hit, e.shiftKey);
      }
      if (this.drag === 'rotate' && still && ROAD_TOOLS.includes(this.tool)) this.roadTool.cancel();
      if (this.drag === 'pan') this.rig.endPan();
      this.drag = 'none';
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('dblclick', () => {
      if (this.tool === 'river') this.finishRiver();
      if (this.tool === 'building' && this.lotMode === 'poly') this.finishPoly();
      // the building picked by the first click: see it inside (the hint of "See inside" says so)
      else if (this.tool === 'building' && this.lotMode === 'edit' && !this.lotExtra && this.selected >= 0 && !(this.inside.on && this.insideId === this.selected)) this.insideCmd('toggle');
      // a wall ends (the barrier hint: double click or Enter)
      if (this.tool === 'barrier' && this.wallOpen) { this.itemTool.cancel(); this.wallOpen = false; }
    });
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => { this.pointer.inside = false; });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      this.rig.zoomAt(Math.exp(delta * 0.0012), this.ndcX(), this.ndcY());
    }, { passive: false });

    // every key in one table (src/ui/keys.ts); the tool reads its own keys in toolKey
    installKeys({
      tool: () => this.tool,
      setTool: (t) => this.setTool(t),
      openCategory: (c) => this.hud.openCategory(c),
      dialog: () => this.optionsPanel.isOpen || this.hud.aboutOpen || !!this.startMenu?.open,
      closeDialog: () => { if (this.optionsPanel.isOpen) this.optionsPanel.close(); else if (this.hud.aboutOpen) this.hud.closeAbout(); else this.startMenu?.hide(); },
      closeMenu: () => this.hud.escape(),
      closePanel: () => {
        if (this.optionsPanel.isOpen) { this.optionsPanel.close(); return true; }
        if (this.health.close()) return true;
        if (this.hud.catalog.editor.isOpen) { this.hud.catalog.editor.close(); return true; }
        if (this.inspector.isOpen) { this.inspector.close(); return true; }
        return false;
      },
      cancelStroke: () => {
        if (this.vehicles.follow) { this.vehicles.follow = null; return true; }
        // a wall being traced ends and the tool stays (the next Esc puts it down)
        if (this.tool === 'barrier' && this.wallOpen) { this.itemTool.cancel(); this.wallOpen = false; return true; }
        if (this.tool === 'building' && this.lotExtraPts.length) { this.lotExtraPts = []; this.preview.hideAll(); return true; }
        if (this.tool === 'building' && (this.lotPts?.length || this.polyPts.length || this.joinFirst >= 0)) { if (this.lotPts) this.lotPts.length = 0; this.polyPts.length = 0; this.joinFirst = -1; this.preview.hideAll(); return true; }
        if (this.tool === 'river' && this.riverPts.length) { this.riverPts.length = 0; this.preview.hideAll(); return true; }
        if (ROAD_TOOLS.includes(this.tool) && this.roadTool.busy) { this.roadTool.cancel(); return true; }
        return false;
      },
      toolKey: (e) => this.toolKey(e),
      undo: () => this.history(false),
      redo: () => this.history(true),
      save: () => void this.save(),
      help: () => this.hud.toggleHelp(),
      health: () => this.health.toggle(),
      changes: () => this.health.show('world'),
      developer: () => this.developer,
      openMap: () => this.hud.openFile(),
      duplicate: () => {
        const s = this.inspector.isOpen ? this.inspector.seg : -1;
        const j = s >= 0 ? duplicateRoad(this.world, s) : null;
        if (!j) return;
        if (typeof j === 'string') { this.hud.toast(loose(j)); return; }
        if (!j.empty && j.settle()) this.commands.push(j);
      },
      home: () => { if (this.homeView) this.rig.restore(this.homeView); },
      // as Q (−1) or E (+1), a quarter at once
      quarterTurn: (d) => this.rig.turnTo(this.rig.yaw - d * Math.PI / 2),
      pause: () => this.setSpeed(this.paused ? this.simSpeed : 0),
      nextSpeed: () => this.setSpeed(this.paused ? this.simSpeed : this.simSpeed === 1 ? 2 : this.simSpeed === 2 ? 4 : 1),
      toggleIso: () => this.setView(this.rig.mode === 'iso' ? 'persp' : 'iso'),
      congestion: () => this.toggleTrafficView(),
      follow: () => this.toggleFollow(),
      wake: () => this.ambient.start(),
      camera: this.rig,
    });
  }

  /** Remove poles: the pole line under the click goes; walls, fences, hedges and guardrails stay. */
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

  /** Detail distances by screen-space error: more pixels, detail reaches farther. */
  private updatePixelScale(): void {
    const res = this.settings ? this.settings.resolution * this.settings.detail : 1;
    const k = Math.min(3, Math.max(0.5, window.innerHeight * window.devicePixelRatio * res / 1080));
    for (const l of this.layers) l.pixelScale = k;
    if (this.props) this.props.pixelScale = k;
  }

  /** Undo (false) or redo (true), with sound. */
  private history(redo: boolean): void {
    if (redo ? this.commands.redo() : this.commands.undo()) this.ambient.sfx('undo');
  }

  private setTool(tool: Tool): void {
    if (tool !== this.tool) this.ambient.sfx('click');
    this.wallOpen = false;
    this.tool = tool;
    zoneOverlayU.value = tool === 'zone' || this.zoneLayer ? 1 : 0;
    if (TERRAIN_TOOLS.includes(tool)) this.brush.mode = tool === 'landform' ? this.landformMode : tool as BrushParams['mode'];
    if (ROAD_TOOLS.includes(tool)) this.roadTool.setMode(tool);
    else { this.roadTool.cancel(); this.hud.setHint(''); }
    if (tool === 'zone') this.hud.setHint(t('game.hint.zone'));
    if (tool === 'building') { this.select(-1); this.setLotMode(this.lotMode); }
    if (tool !== 'inspect') this.inspector?.close();
    if (tool === 'streetscape' || tool === 'barrier') this.itemTool.setMode(tool); else if (this.itemTool) this.itemTool.cancel(false);
    if (tool === 'inspect') this.hud.setHint(t('game.hint.inspect'));
    if (tool === 'paint') this.hud.setHint(t('game.hint.paint'));
    if (tool === 'forest') this.hud.setHint(t('game.hint.forest'));
    if (tool === 'elements') this.hud.setHint(t('game.hint.elements'));
    if (tool === 'landform') this.hud.setHint(t('game.hint.landform'));
    if (tool === 'sky') this.skyHint();
    if (tool === 'person') this.hud.setHint(t('game.hint.person'));
    if (tool === 'pistol') this.hud.setHint(t('game.hint.pistol'));
    if (tool === 'bomb') this.hud.setHint(t('game.hint.bomb'));
    if (tool === 'weather') this.hud.setHint(t('game.hint.weather'));
    if (tool === 'river') this.hud.setHint(t('game.hint.river'));
    if (tool !== 'river') this.riverPts.length = 0;
    if (tool === 'transit') this.hud.setHint(t('game.hint.transit'));
    this.transitView.showPaths = tool === 'transit';
    if (tool !== 'building') { this.preview.circle.visible = false; if (this.creator) this.creator.el.style.display = 'none'; if (this.inside.on) { this.inside.hide(); this.insideId = -1; this.hud.setInside(-1); } }
    this.hud.setTool(tool);
    if (this.health) this.health.context = `ferramenta ${tool}`;
    this.canvas.style.cursor = tool === 'camera' ? 'grab' : 'crosshair';
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
    packMap: () => packSlot(SLOT),
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
    /** Terrain height at (x, z). */
    ground: (x: number, z: number) => heightAt(this.world.heights, x, z),
    junction: (x: number, z: number, ctl: number) => { const n = this.world.roads.nearestNode(x, z, 20); if (n >= 0) this.world.roads.setJunction(n, { ctl }); },
    /** Polygon lot from flat corners [x0, z0, x1, z1, …] (the first side is the front); returns its id or the refusal. */
    lotPoly: (pts: number[], use = 1) => {
      this.lotUse = use; this.polyPts = [];
      for (let i = 0; i + 1 < pts.length; i += 2) this.polyPts.push([pts[i], pts[i + 1]]);
      const before = this.world.buildings.end, size = this.world.buildings.size;
      const r = polygonLot(this.polyPts);
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

  private skyHint(): void {
    const s = this.skyTool;
    this.hud.setHint(s.fog === 'lay' ? t('game.hint.fog.lay') : s.fog === 'erase' ? t('game.hint.fog.erase')
      : s.cloud === 'add' ? t('game.hint.cloud.add')
        : s.cloud === 'move' ? t('game.hint.cloud.move') : s.cloud === 'edit' ? t('game.hint.cloud.edit')
          : s.cloud === 'remove' ? t('game.hint.cloud.remove') : t('game.hint.sky'));
  }

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

  /** Bomb: flash, fire and smoke; buildings in the radius collapse into rubble (one command); the simulation removes whoever was near. */
  private bomb(x: number, z: number): void {
    const w = this.world, col = w.buildings.cols;
    const r = bombRadius(this.bombForce);
    const y = heightAt(w.heights, x, z);
    this.blast.boom(x, y, z, r);
    this.ambient.sfx('boom');
    this.particles.burst(x, y + 1, z, 2, 8, 12);
    this.particles.burst(x, y + 2, z, 0, 10, 40);
    this.particles.burst(x, y + 0.5, z, 6, 10, 3);
    this.particles.burst(x, y + 0.5, z, 4, 12, 15);
    flashU.value = 1;
    const doomed: number[] = [];
    w.buildingIndex.query(x - r - 40, z - r - 40, x + r + 40, z + r + 40, (id) => {
      if (col.floors[id] === 0) return;
      if (Math.hypot(col.x[id] - x, col.z[id] - z) < r + Math.min(col.w[id], col.d[id]) * 0.3) doomed.push(id);
    });
    if (doomed.length) {
      const j = new RoadJournal(w, 'bomba');
      const rubble = new ItemsCommand(w.items, 'entulho');
      for (const id of doomed) {
        const gy = heightAt(w.heights, col.x[id], col.z[id]);
        this.blast.collapse(col.x[id], gy, col.z[id], col.w[id], col.d[id], Math.max(3, col.floors[id] * 3.2), col.rot[id]);
        this.particles.burst(col.x[id], gy + 1, col.z[id], 4, 14, 10);
        const rec = w.buildingRec(id);
        j.removeBuilding(id);
        // rubble: the lot is left empty and full of stones and gravel
        j.addBuilding({ x: rec[1], z: rec[2], w: rec[3], d: rec[4], h: 0, rot: rec[6], color: 0, seed: rec[8], zone: rec[9], floors: 0, style: rec[11], fn: 0 });
        const n = Math.min(40, Math.round(rec[3] * rec[4] / 12));
        for (let k = 0; k < n; k++) {
          const lx = (Math.random() - 0.5) * rec[3] * 0.85, lz = (Math.random() - 0.5) * rec[4] * 0.85, c = Math.cos(rec[6]), s = Math.sin(rec[6]);
          rubble.add([rec[1] + lx * c + lz * s, rec[2] - lx * s + lz * c, Math.random() * 6, 0, k % 3 === 0 ? Item.Gravel : Item.Stones, 12]);
        }
      }
      const both = { label: 'bomba', apply: () => { j.apply(); rubble.apply(); }, invert: () => { rubble.invert(); j.invert(); } };
      this.commands.push(both);
    }
    this.hitKind = 'bomb';
    this.sim.postMessage({ type: 'hit', x, z, r, one: false } satisfies ToSim);
    this.hud.toast(doomed.length ? plural('game.toast.collapsed', doomed.length) : t('game.toast.bombGround'));
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

  private select(id: number): void {
    this.selected = id;
    const col = this.world.buildings.cols;
    if (id < 0 || !this.world.buildings.alive[id]) { this.selected = -1; this.hud.setBuilding(null); this.preview.circle.visible = false; if (this.creator) this.creator.el.style.display = 'none'; return; }
    const z = col.zone[id];
    this.creator?.show(hasDesign(col.color[id]) ? decodeDesign(col.color[id], col.h[id]) : null, col.floors[id]);
    if (this.creator) this.creator.el.style.display = this.tool === 'building' && col.floors[id] > 0 ? '' : 'none';
    this.hud.setBuilding({ fn: col.fn[id], zone: z, floors: col.floors[id], arch: col.style[id] >= 128 ? col.style[id] - 128 : -1, address: this.hudActions.addressOf(), decay: col.decay[id] });
  }

  private showSelection(): void {
    const id = this.selected;
    if (id < 0 || !this.world.buildings.alive[id]) { this.preview.circle.visible = false; return; }
    const col = this.world.buildings.cols;
    const y = heightAt(this.world.heights, col.x[id], col.z[id]);
    this.preview.showCircle(col.x[id], y, col.z[id], Math.hypot(col.w[id], col.d[id]) / 2 + 2, true);
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
    this.transitView.update(this.transit, this.world.roads, this.world.heights, v);
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

  /** Lot rectangle: front A→B, depth out to the cursor's distance from the front. */
  private lotRect(c: [number, number]): { x: number; z: number; w: number; d: number; rot: number } | null {
    const [a, b] = this.lotPts!;
    const ex = b[0] - a[0], ez = b[1] - a[1], W = Math.hypot(ex, ez);
    if (W < 6) return null;
    // normal of the front, toward the side of the third point
    let nx = -ez / W, nz = ex / W;
    let D = (c[0] - a[0]) * nx + (c[1] - a[1]) * nz;
    if (D < 0) { nx = -nx; nz = -nz; D = -D; }
    D = Math.min(120, Math.max(6, D));
    // the building front (local +z) points at line A-B: (sin rot, cos rot) = −n
    return { x: (a[0] + b[0]) / 2 + nx * D / 2, z: (a[1] + b[1]) / 2 + nz * D / 2, w: Math.min(160, W), d: D, rot: Math.atan2(-nx, -nz) };
  }

  private hoverLot(hit: THREE.Vector3 | null): void {
    const pts = this.lotPts!;
    if (!hit) return;
    const H = (x: number, z: number) => heightAt(this.world.heights, x, z) + 0.6;
    if (pts.length === 0) { this.preview.showCircle(hit.x, H(hit.x, hit.z), hit.z, 2, true); return; }
    if (pts.length === 1) {
      const [a] = pts;
      this.preview.show({ x0: a[0], z0: a[1], cx: (a[0] + hit.x) / 2, cz: (a[1] + hit.z) / 2, x1: hit.x, z1: hit.z }, 0.4, [0, 1], [H(a[0], a[1]), H(hit.x, hit.z)], true, 0xffd36b);
      return;
    }
    const r = this.lotRect([hit.x, hit.z]);
    if (!r) return;
    // strip along the lot axis with the width of the front: covers the rectangle
    const c = Math.cos(r.rot), s = Math.sin(r.rot), fx = s * r.d / 2, fz = c * r.d / 2;
    this.preview.show({ x0: r.x + fx, z0: r.z + fz, cx: r.x, cz: r.z, x1: r.x - fx, z1: r.z - fz }, r.w / 2, [0, 1], [H(r.x + fx, r.z + fz), H(r.x - fx, r.z - fz)], true, 0x5aa8ff);
  }

  private clickLot(hit: THREE.Vector3 | null): void {
    if (!hit || !this.lotPts) return;
    const pts = this.lotPts;
    if (pts.length < 2) { pts.push([hit.x, hit.z]); return; }
    const r = this.lotRect([hit.x, hit.z]);
    if (!r) { this.hud.toast(t('game.toast.lotNarrow')); pts.length = 0; return; }
    const seed = (Math.random() * 2 ** 31) >>> 0;
    const zone = this.lotUse;
    const rec = {
      ...r, h: 0, color: 0, seed, zone, fn: this.newFn,
      floors: floorsFor(zone, 0, new Rng(seed)),
      style: this.newArch >= 0 ? 128 + this.newArch : seed & 127,
    };
    const j = new RoadJournal(this.world, 'lote desenhado');
    const id = j.addBuilding(rec);
    this.commands.push(j);
    pts.length = 0;
    this.preview.hide();
    this.select(id);
  }

  private setLotMode(m: LotMode): void {
    this.lotMode = m;
    this.lotExtra = null; this.lotExtraPts = [];
    this.lotPts = m === 'rect' ? [] : null;
    this.polyPts.length = 0; this.joinFirst = -1; this.cornerDrag = null;
    this.preview.hideAll();
    if (m !== 'edit') this.select(-1);
    this.hud.setLotMode(m);
    const hints: Record<LotMode, string> = {
      edit: t('game.hint.lot.edit'),
      rect: t('game.hint.lot.rect'),
      poly: t('game.hint.lot.poly'),
      split: t('game.hint.lot.split'),
      join: t('game.hint.lot.join'),
      delete: t('game.hint.lot.delete'),
      front: t('game.hint.lot.front'),
      corner: t('game.hint.lot.corner'),
    };
    this.hud.setHint(hints[m]);
  }

  /** Outline of a lot (record) on the ground. */
  private showLot(id: number, color: number): void {
    const col = this.world.buildings.cols;
    const r = { x: col.x[id], z: col.z[id], rot: col.rot[id] };
    const [fx, fz] = lotToWorld(r, 0, col.d[id] / 2), [bx, bz] = lotToWorld(r, 0, -col.d[id] / 2);
    const H = (x: number, z: number) => heightAt(this.world.heights, x, z) + 0.7;
    this.preview.show({ x0: fx, z0: fz, cx: r.x, cz: r.z, x1: bx, z1: bz }, col.w[id] / 2, [0, 1], [H(fx, fz), H(bx, bz)], true, color);
  }

  private hoverLotTool(hit: THREE.Vector3 | null): void {
    // split by line, curve side: the line from the first click to the cursor (yellow), or the point to click
    if (this.lotExtra) {
      if (!hit) return;
      const H = (x: number, z: number) => heightAt(this.world.heights, x, z) + 0.7;
      const p = this.lotExtraPts[0];
      if (p) this.preview.show({ x0: p[0], z0: p[1], cx: (p[0] + hit.x) / 2, cz: (p[1] + hit.z) / 2, x1: hit.x, z1: hit.z }, 0.4, [0, 1], [H(p[0], p[1]), H(hit.x, hit.z)], true, 0xffd36b);
      else { this.preview.hide(); this.preview.showCircle(hit.x, H(hit.x, hit.z), hit.z, 2, true); }
      return;
    }
    if (this.lotMode === 'edit') { this.showSelection(); return; }
    if (this.lotMode === 'rect') { if (this.lotPts) this.hoverLot(hit); return; }
    if (!hit) return;
    const H = (x: number, z: number) => heightAt(this.world.heights, x, z) + 0.7;
    if (this.lotMode === 'poly') {
      const pts: Array<[number, number]> = [...this.polyPts, [hit.x, hit.z]];
      const r = pts.length >= 3 ? polygonRect(pts) : null;
      if (r) {
        const [fx, fz] = lotToWorld(r, 0, r.d / 2), [bx, bz] = lotToWorld(r, 0, -r.d / 2);
        this.preview.show({ x0: fx, z0: fz, cx: r.x, cz: r.z, x1: bx, z1: bz }, r.w / 2, [0, 1], [H(fx, fz), H(bx, bz)], true, 0x5aa8ff);
      } else if (pts.length === 2) {
        const [a, b] = pts;
        this.preview.show({ x0: a[0], z0: a[1], cx: (a[0] + b[0]) / 2, cz: (a[1] + b[1]) / 2, x1: b[0], z1: b[1] }, 0.4, [0, 1], [H(a[0], a[1]), H(b[0], b[1])], true, 0xffd36b);
      } else this.preview.showCircle(hit.x, H(hit.x, hit.z), hit.z, 2, true);
      return;
    }
    if (this.cornerDrag) {
      this.showLot(this.cornerDrag.id, 0x5aa8ff);
      this.preview.showCircle(hit.x, H(hit.x, hit.z), hit.z, 2, true);
      return;
    }
    const id = lotAt(this.world, hit.x, hit.z);
    if (id < 0) { this.preview.hide(); return; }
    this.showLot(id, this.lotMode === 'delete' ? 0xe2564b : this.lotMode === 'join' && this.joinFirst >= 0 ? 0x4cd28a : 0x5aa8ff);
  }

  private clickLotTool(hit: THREE.Vector3): void {
    if (this.lotMode === 'poly') { this.polyPts.push([hit.x, hit.z]); return; }
    const id = lotAt(this.world, hit.x, hit.z);
    if (id < 0) { this.hud.toast(t('game.toast.noLot')); return; }
    let r: RoadJournal | string | null = null;
    if (this.lotMode === 'split') r = splitLot(this.world, id, this.splitKind, this.splitParts);
    else if (this.lotMode === 'delete') r = deleteLot(this.world, id);
    else if (this.lotMode === 'front') { r = setLotFront(this.world, id, hit.x, hit.z); if (!r) { this.hud.toast(t('game.toast.alreadyFront')); return; } }
    else if (this.lotMode === 'join') {
      if (this.joinFirst < 0 || !this.world.buildings.alive[this.joinFirst]) { this.joinFirst = id; this.hud.setHint(t('game.hint.lot.joinSecond')); return; }
      r = joinLots(this.world, this.joinFirst, id);
      this.joinFirst = -1;
      this.hud.setHint(t('game.hint.lot.join'));
    }
    if (!r) return;
    if (typeof r === 'string') { this.hud.toast(r[0].toUpperCase() + r.slice(1) + '.'); return; }
    this.commands.push(r);
    this.preview.hide();
    this.hud.toast(this.lotMode === 'split' ? t('game.toast.lotSplit') : this.lotMode === 'join' ? t('game.toast.lotsJoined') : this.lotMode === 'front' ? t('game.toast.frontSet') : t('game.toast.deleted'));
  }

  private finishPoly(): void {
    const r = polygonLot(this.polyPts);
    this.polyPts.length = 0;
    this.preview.hideAll();
    if (typeof r === 'string') { this.hud.toast(r[0].toUpperCase() + r.slice(1) + '.'); return; }
    const seed = (Math.random() * 2 ** 31) >>> 0, zone = this.lotUse;
    const j = new RoadJournal(this.world, 'lote desenhado');
    j.addBuilding({ ...r, h: 0, color: 0, seed, zone, fn: this.newFn, floors: floorsFor(zone, 0, new Rng(seed)), style: this.newArch >= 0 ? 128 + this.newArch : seed & 127 });
    this.commands.push(j);
    this.hud.toast(t('game.toast.lotCreated'));
  }

  private grabCorner(hit: THREE.Vector3 | null): boolean {
    if (!hit) return false;
    const id = lotAt(this.world, hit.x, hit.z);
    if (id < 0) return false;
    const [k, d] = nearestCorner(this.world, id, hit.x, hit.z);
    if (d > 8) return false;
    this.cornerDrag = { id, k };
    return true;
  }

  private dropCorner(hit: THREE.Vector3 | null): void {
    const c = this.cornerDrag;
    this.cornerDrag = null;
    this.preview.hideAll();
    if (!c || !hit || !this.world.buildings.alive[c.id]) return;
    const r = moveLotCorner(this.world, c.id, c.k, hit.x, hit.z);
    if (typeof r === 'string') { this.hud.toast(t('game.toast.notChanged', { why: loose(r) })); return; }
    this.commands.push(r);
  }

  private manoeuvreWait: ((m: Extract<FromSim, { type: 'manoeuvres' }>) => void) | null = null;
  /** Lot modes added by the gameplay front (split by line, curve side) and the points clicked so far. */
  private lotExtra: 'line' | 'curve' | null = null;
  private lotExtraPts: Array<[number, number]> = [];

  private featureActions(): FeatureActions {
    const hints = { line: t('game.hint.lot.line'), curve: t('game.hint.lot.curve') };
    const enter = (m: 'line' | 'curve') => { this.setTool('building'); this.lotExtra = m; this.lotExtraPts = []; this.hud.setHint(hints[m]); };
    return {
      lotLine: () => enter('line'),
      lotCurve: () => enter('curve'),
      lotExtraOff: () => { this.lotExtra = null; this.lotExtraPts = []; },
      renovate: () => this.renovate(this.selected),
      decayOf: () => this.selected >= 0 && this.world.buildings.alive[this.selected] ? this.world.buildings.cols.decay[this.selected] / 10 : -1,
      addressOf: () => {
        const id = this.selected, w = this.world, c = w.buildings.cols;
        if (id < 0 || !w.buildings.alive[id]) return '';
        // the door: middle of the lot's front
        const [x, z] = lotToWorld({ x: c.x[id], z: c.z[id], rot: c.rot[id] }, 0, c.d[id] / 2);
        const a = addressAt(w, x, z);
        return a ? `${a.name}, ${a.number}` : '';
      },
      streetNameAt: (x, z) => { const a = addressAt(this.world, x, z, 30); return a ? a.name : ''; },
      mapPaint: (style) => { this.settings.paint = style; setPaintStyle(style); this.unsaved = true; },
      lineColor: (color) => { const c = this.transit.setColor(this.lineSel, color); if (c) this.commands.run(c); },
      lineLoop: (loop) => { const c = this.transit.setLoop(this.lineSel, loop); if (c) this.commands.run(c); },
      impossibleNodes: () => this.world.impossible.count,
      impossibleAngle: (n) => this.world.impossible.angleAt(n),
      impossibleList: () => { const nc = this.world.roads.nodes.cols, out: number[] = []; for (const [n, a] of this.world.impossible.nodes) out.push(n, nc.x[n], nc.z[n], a); return out; },
    };
  }

  /** Split by line or curve side: the second click does it. */
  private clickLotExtra(hit: THREE.Vector3): void {
    const pts = this.lotExtraPts;
    pts.push([hit.x, hit.z]);
    if (pts.length < 2) return;
    const [[ax, az], [bx, bz]] = pts;
    this.lotExtraPts = [];
    let r: RoadJournal | string;
    if (this.lotExtra === 'line') {
      // the lot the line crosses: under its middle, or under either end
      const id = [lotAt(this.world, (ax + bx) / 2, (az + bz) / 2), lotAt(this.world, ax, az), lotAt(this.world, bx, bz)].find((i) => i >= 0) ?? -1;
      r = id < 0 ? t('game.refuse.lineNoLot') : splitLotByLine(this.world, id, ax, az, bx, bz);
    } else {
      const id = lotAt(this.world, ax, az);
      r = id < 0 ? t('game.refuse.curveFirst') : curveLotSide(this.world, id, ax, az, bx, bz);
    }
    if (typeof r === 'string') { this.hud.toast(r[0].toUpperCase() + r.slice(1) + '.'); return; }
    this.commands.push(r);
    this.hud.toast(this.lotExtra === 'line' ? t('game.toast.lotSplitLine') : t('game.toast.sideCurved'));
  }

  /** Renovation (Roadcraft Shift+click): the building is new again; undo brings the old age back. */
  private renovate(id: number): void {
    const w = this.world;
    if (id < 0 || !w.buildings.alive[id] || w.buildings.cols.floors[id] === 0) { this.hud.toast(t('game.toast.renovatePick')); return; }
    const before = w.buildings.cols.built[id], now = w.clock;
    if (w.buildings.cols.decay[id] === 0 && now - before < 1) { this.hud.toast(t('game.toast.alreadyNew')); return; }
    this.commands.run({
      label: 'reformar prédio',
      apply: () => { if (w.buildings.alive[id]) w.setBuilt(id, now); },
      invert: () => { if (w.buildings.alive[id]) w.setBuilt(id, before); },
    });
    this.hud.toast(t('game.toast.renovated'));
  }

  private clickBuilding(hit: THREE.Vector3 | null, shift = false): void {
    if (!hit) return;
    if (this.lotExtra) { this.clickLotExtra(hit); return; }
    if (this.lotMode !== 'edit' && this.lotMode !== 'rect') { this.clickLotTool(hit); return; }
    if (this.lotPts) { this.clickLot(hit); return; }
    // building under the click?
    const col = this.world.buildings.cols;
    let best = -1, bd = Infinity;
    this.world.buildingIndex.query(hit.x - 40, hit.z - 40, hit.x + 40, hit.z + 40, (id) => {
      const dx = hit.x - col.x[id], dz = hit.z - col.z[id];
      const s = Math.sin(col.rot[id]), c = Math.cos(col.rot[id]);
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      if (Math.abs(lx) <= col.w[id] / 2 + 1 && Math.abs(lz) <= col.d[id] / 2 + 1) {
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; best = id; }
      }
    });
    if (best >= 0) { if (shift) this.renovate(best); this.select(best); return; }
    // free lot: build
    const lot = this.growth.lotAt(hit.x, hit.z);
    if (!lot) { this.hud.toast(t('game.toast.buildWhere')); return; }
    const j = new RoadJournal(this.world, 'construir prédio');
    // the style and function chosen for the next building (the Build panel) win over the neighbourhood's
    const rec = this.growth.recordFor(lot.lots, lot.i);
    if (this.newArch >= 0) rec.style = 128 + this.newArch;
    if (this.newFn > 0) rec.fn = this.newFn;
    const id = j.addBuilding(rec);
    this.commands.push(j);
    this.select(id);
  }

  /** Changes floors, style (−1 = automatic) and function of the selected building. */
  private editSelected(dFloors: number, arch?: number, fn?: number): void {
    const id = this.selected;
    if (id < 0 || !this.world.buildings.alive[id]) return;
    const col = this.world.buildings.cols;
    const from = [col.floors[id], col.style[id], col.fn[id]];
    const style = arch === undefined ? col.style[id] : arch < 0 ? col.seed[id] & 127 : 128 + arch;
    const to = [Math.max(1, Math.min(60, col.floors[id] + dFloors)), style, fn ?? col.fn[id]];
    if (from.every((v, i) => v === to[i])) return;
    const world = this.world;
    this.commands.run({
      label: 'editar prédio',
      apply: () => { if (world.buildings.alive[id]) world.editBuilding(id, to[0], to[1], to[2]); },
      invert: () => { if (world.buildings.alive[id]) world.editBuilding(id, from[0], from[1], from[2]); },
    });
    this.select(id);
  }

  /** Inside view: the selected building, or the one at the centre of the screen; floor up and down. */
  private insideCmd(c: 'toggle' | 'up' | 'down'): void {
    const w = this.world, col = w.buildings.cols;
    if (c === 'toggle' && this.inside.on) { this.inside.hide(); this.insideId = -1; this.hud.setInside(-1); return; }
    if (c === 'toggle') {
      const id = this.selected >= 0 ? this.selected : lotAt(w, this.rig.target.x, this.rig.target.z);
      if (id < 0 || col.floors[id] === 0) { this.hud.toast(t('game.toast.insideNone')); return; }
      this.insideId = id;
      this.insideFloor = 0;
    } else if (!this.inside.on) return;
    else this.insideFloor += c === 'up' ? 1 : -1;
    const id = this.insideId;
    if (!w.buildings.alive[id]) { this.inside.hide(); return; }
    this.insideFloor = Math.max(0, Math.min(col.floors[id] - 1, this.insideFloor));
    const base = heightAt(w.heights, col.x[id], col.z[id]) + 0.2;
    this.inside.show(col.x[id], col.z[id], col.w[id], col.d[id], col.rot[id], base, this.insideFloor, 3.2);
    this.hud.setInside(this.insideFloor);
  }

  /** Creator: puts (or removes) the design on the selected building; optional floors (ready-made model). */
  private applyDesign(d: Design | null, floors?: number): void {
    const id = this.selected;
    if (id < 0 || !this.world.buildings.alive[id]) { this.hud.toast(t('game.toast.selectFirst')); return; }
    const col = this.world.buildings.cols, w = this.world;
    const before = [col.color[id], col.h[id], col.floors[id]];
    const enc = d ? encodeDesign(d) : { color: 0, h: 0 };
    const after = [enc.color, enc.h, Math.max(1, Math.min(60, floors ?? col.floors[id]))];
    if (before.every((v, i) => v === after[i])) return;
    this.commands.run({
      label: 'projeto do prédio',
      apply: () => { if (w.buildings.alive[id]) w.setDesign(id, after[0], after[1], after[2]); },
      invert: () => { if (w.buildings.alive[id]) w.setDesign(id, before[0], before[1], before[2]); },
    });
    this.select(id);
  }

  private demolishSelected(): void {
    const id = this.selected;
    if (id < 0 || !this.world.buildings.alive[id]) return;
    const j = new RoadJournal(this.world, 'demolir prédio');
    j.removeBuilding(id);
    this.commands.push(j);
    this.select(-1);
  }

  // ------------------------------------------------------ generated city

  /** Forgets the current city (roads, buildings, lines, history). */
  private resetCity(): void {
    const w = this.world;
    w.clearBuildings();
    w.items.clear();
    w.clearGround();
    w.roads.clear();
    this.growth.clear();
    for (const l of this.layers) l.reset();
    this.props.clear();
    this.transit.clear();
    this.commands.clear();
    this.clouds = []; this.cloudView.set([]);
    w.signTexts.clear(); w.streetNames.clear(); this.textSigns.version++;
    w.money = START_MONEY;
    // another city: nothing of it is in the save yet, and it is not the city the slot holds
    w.tileInSave.fill(0);
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
  async generatedCity(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const t0 = performance.now();
    const phase = (name: string) => console.log(`fase: ${name} ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    this.hud.showLoading(t('game.loading.city'));
    const w = this.world;
    try {
      this.resetCity();
      this.generating = true;
      await this.generateTerrain();
      phase('relevo');
      const city = await this.pool.run('cityGen', { seed: w.seed }, { priority: 0 });
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
        w.tileMin[r.tile] = Math.min(w.tileMin[r.tile], r.min);
        w.tileMax[r.tile] = Math.max(w.tileMax[r.tile], r.max);
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

  /**
   * Writes the changed tiles and the map's description. Everything is copied at the start, in one go (tiles, their
   * ground and water, money, clock, junctions…), so the files describe one moment. A tile's mark and `unsaved` are
   * cleared only once every file is written, and only if nothing changed after the copy; a failed write leaves them
   * set and the next save tries again. True when the save completed.
   */
  private async save(auto = false): Promise<boolean> {
    if (this.busy) return false;
    if (this.saveBlocked) {
      if (!auto) this.hud.toast(t('game.toast.saveBlocked'));
      return false;
    }
    this.busy = true;
    try { await this.keepSlotForThisCity(); } catch (err) {
      this.busy = false;
      this.hud.toast(t('game.toast.keepFailed', { message: (err as Error).message }));
      return false;
    }
    const w = this.world;
    const serial = this.unsavedSerial;
    const tiles: number[] = [];
    for (let t = 0; t < TILE_COUNT; t++) if (w.saveDirty[t]) tiles.push(t);
    const versions = tiles.map((t) => w.saveVer[t]);
    const listed = new Uint8Array(w.tileInSave);
    for (const t of tiles) listed[t] = 1;
    const tileOf = (x: number, z: number) => tileId(tileX(x), tileX(z));
    const gl = WATER_TILE_RES * WATER_TILE_RES;
    const writes = tiles.map((t) => {
      const heights = packTileHeights(w.heights, t);
      const boxes = w.gatherBoxes(cellsOfTile(t));
      const roads = w.roads.saveTile(t, tileOf);
      roads.items = w.items.saveTile(tileOf, t, cellsOfTile(t));
      const ground = w.ground32.slice(t * gl, (t + 1) * gl), water = w.water.slice(t * gl, (t + 1) * gl);
      return this.pool.run('saveTile', { slot: SLOT, tile: t, heights, boxes, roads, ground, water }, { priority: -1,
        transfer: [heights.buffer as ArrayBuffer, ...boxTransfer(boxes), roads.nodes.buffer as ArrayBuffer, roads.segs.buffer as ArrayBuffer, roads.items.buffer as ArrayBuffer, ground.buffer, water.buffer] });
    });
    const meta = encodeMeta({ seed: w.seed, gameId: w.gameId, tiles: listed, camera: this.rig.state(), hour: this.hour, transit: this.transit.encode(), profiles: JSON.stringify(customProfiles()), money: w.unlimited ? NaN : w.money, junctions: JSON.stringify([...w.roads.junctions]), biome: w.biome,
      extra: JSON.stringify({ sky: this.skyMode, weather: this.weatherCtl, water: this.waterCtl, clouds: this.clouds, fog: fogLevel.value, terminals: this.transit.terminals,
        signs: [...w.signTexts], streets: [...w.streetNames], clock: w.clock, paint: this.settings.paint ?? 'br' }) });
    try {
      let bytes = 0;
      for (const r of await Promise.all(writes)) bytes += r.bytes;
      await this.pool.run('saveMeta', { slot: SLOT, meta }, { priority: -1 });
      tiles.forEach((t, k) => { w.tileInSave[t] = 1; if (w.saveVer[t] === versions[k]) w.saveDirty[t] = 0; });
      if (this.unsavedSerial === serial) this.unsaved = false;
      if (auto) this.hud.toast(t('game.toast.autosaved'));
      else this.hud.toast(tiles.length ? t('game.toast.savedTiles', { tiles: tiles.length, mb: fmtDec(bytes / 1024 / 1024) }) : t('game.toast.saved'));
      return true;
    } catch (err) {
      this.hud.toast(t('game.toast.saveFailed', { message: (err as Error).message ?? String(err) }));
      return false;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Opens the saved city. Any failure after the world was cleared ends the flow (no hung loading screen) and blocks
   * saving until another city is opened or made, so the half-built world never overwrites the save. Dead ends of old
   * maps repaired here stay marked: the next save writes the repair (otherwise the ids the repair freed and new roads
   * reuse would be in two files at the next opening). True when the city opened.
   */
  private async load(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    const w = this.world;
    let raw: Uint8Array | null;
    try { raw = (await this.pool.run('loadMeta', { slot: SLOT }, { priority: -1 })).meta; } catch (err) {
      this.busy = false;
      this.hud.toast(t('game.toast.readFailed', { message: (err as Error).message }));
      return false;
    }
    if (!raw) { this.busy = false; this.hud.toast(t('game.toast.noSave')); return false; }
    let meta;
    try { meta = decodeMeta(raw); } catch (err) {
      this.busy = false;
      if (err instanceof MapSizeError && MAP_SIZES.includes(err.tiles)) { reloadWithMap(err.tiles, 'carregar'); return false; }
      const q = await quarantineSlot(SLOT).catch(() => null);
      this.hud.toast(q ? t('game.toast.quarantined', { message: (err as Error).message, where: q }) : String(err));
      return false;
    }
    this.hud.showLoading(t('game.loading.load'));
    try {
      w.clearBuildings();
      w.items.clear();
      w.clearGround();
      w.roads.clear();
      this.growth.clear();
      for (const l of this.layers) l.reset();
      this.props.clear();
      this.transit.clear();
      this.commands.clear();
      try { setCustomProfiles(meta.profiles ? JSON.parse(meta.profiles) as Profile[] : []); } catch { setCustomProfiles([]); }
      w.clearGround();
      this.setBiome(meta.biome ?? 0);
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
        const ex = extra as { clouds?: Cloud[]; fog?: number; terminals?: number[]; signs?: Array<[string, string]>; streets?: Array<[number, string]>; clock?: number; paint?: string };
        w.clock = ex.clock ?? 0;
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
      w.tileInSave.set(meta.tiles);
      let corrupt = 0;
      await Promise.all(Array.from({ length: TILE_COUNT }, async (_, t) => {
        if (meta.tiles[t]) {
          const r = await this.pool.run('loadTile', { slot: SLOT, tile: t }, { key: `terrain:${t}`, priority: 0 });
          if (r.corrupt) {
            // unreadable tile: its terrain comes back from the seed; the save goes to quarantine below
            corrupt++;
            const g = await this.pool.run('terrainGen', { seed: w.seed, tile: t }, { key: `terrain:${t}`, priority: 0 });
            w.tileMin[t] = g.min; w.tileMax[t] = g.max;
          } else if (r.found) {
            w.tileMin[t] = r.min; w.tileMax[t] = r.max;
            if (r.boxes) this.insertBoxes(r.boxes);
            if (r.roads) roads.push(r.roads);
            if (r.roads?.items) w.items.loadTile(r.roads.items);
            w.groundDirty.add(t); w.waterDirty.add(t);
            w.tileWater[t] = r.hasWater ? 1 : 0;
          }
        } else {
          const r = await this.pool.run('terrainGen', { seed: w.seed, tile: t }, { key: `terrain:${t}`, priority: 0 });
          w.tileMin[t] = r.min; w.tileMax[t] = r.max;
        }
        w.layerDirty.add(t);
        for (const c of cellsOfTile(t)) w.touchCell(c, Dirty.Terrain | Dirty.Buildings);
      }));
      // roads: all nodes before the segments (segments link tiles)
      for (const r of roads) w.roads.loadNodes(r);
      for (const r of roads) w.roads.loadSegs(r);
      // the far road paint of every tile is made again (a tile that lost its roads would keep the old paint)
      for (let t = 0; t < TILE_COUNT; t++) w.dirty.mark(cellsOfTile(t)[0], Dirty.RoadPaint);
      try {
        for (const [id, spec] of meta.junctions ? JSON.parse(meta.junctions) as Array<[number, JunctionSpec]> : []) if (w.roads.nodes.alive[id]) w.roads.setJunction(id, spec);
      } catch { /* save without chosen junctions */ }
      // what was read is what the save holds; only the repair below needs writing
      w.saveDirty.fill(0);
      // old maps: dead ends lying inside another road become junctions (marked to save)
      const repaired = repairDanglingEnds(w);
      if (repaired) this.unsaved = true;
      if (corrupt) {
        const q = await quarantineSlot(SLOT).catch(() => null);
        this.hud.toast((plural('game.toast.corrupt', corrupt) + (q ? t('game.toast.corruptKept', { where: q }) : '') + '.'));
      }
      if (repaired) this.hud.toast(plural('game.toast.repaired', repaired));
      this.rig.restore(meta.camera);
      this.hud.setView(this.rig.mode);
      this.saveBlocked = false;
      this.slotGame = meta.gameId;
      this.endRebuild(null, '');
      this.hud.toast(t('game.toast.loaded'));
      return true;
    } catch (err) {
      this.endRebuild(err, t('game.flow.load'));
      return false;
    }
  }

  /** Saves and downloads the whole map as a .cidade file (only a save that completed is exported). */
  private async exportMap(): Promise<void> {
    if (!await this.save()) { this.hud.toast(t('game.toast.exportNoSave')); return; }
    const blob = await packSlot(SLOT);
    if (!blob) { this.hud.toast(t('game.toast.exportNothing')); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `cidade-${this.world.seed}.cidade`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    this.hud.toast(t('game.toast.exported', { mb: fmtDec(blob.size / 1024 / 1024) }));
  }

  /**
   * Opens a map from a file. The file is read and its map description checked before anything is touched; the city
   * saved before is kept as a previous city; then the file replaces the save and is opened.
   */
  private async importMap(file: Blob): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    let kept: string | null;
    try {
      kept = await unpackToSlot(SLOT, file, (metaBytes) => {
        try { decodeMeta(metaBytes); } catch (err) { if (!(err instanceof MapSizeError && MAP_SIZES.includes(err.tiles))) throw err; }
      });
    } catch (err) {
      this.hud.toast(t('game.toast.importFailed', { message: (err as Error).message }));
      return;
    } finally {
      this.busy = false;
    }
    this.slotGame = null;
    if (kept) this.hud.toast(t('game.toast.keptAs', { where: kept }));
    await this.load();
  }

  /**
   * The slot holds one city. Before the first save of another city (a new map, a generated one, an imported one), the
   * city saved there is copied aside as a previous city, never overwritten. Throws when the copy fails (nothing is
   * written then).
   */
  private async keepSlotForThisCity(): Promise<void> {
    const w = this.world;
    if (this.slotGame === w.gameId) return;
    const { meta } = await this.pool.run('loadMeta', { slot: SLOT }, { priority: -1 });
    let other = meta !== null;
    // a description that cannot be read (damaged, or a map of another size) is kept aside too
    if (meta) { try { other = decodeMeta(meta).gameId !== w.gameId; } catch { other = true; } }
    if (other) {
      const kept = await keepPreviousCity(SLOT);
      if (kept) this.hud.toast(t('game.toast.keptAs', { where: kept }));
    }
    this.slotGame = w.gameId;
  }

  /** The gameId of the city in the save slot (null: not known yet). */
  private slotGame: number | null = null;

  private async newMap(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.hud.showLoading(t('game.loading.terrain'));
    const w = this.world;
    try {
      this.resetCity();
      w.seed = (Math.random() * 2 ** 32) >>> 0;
      w.gameId = (Math.random() * 2 ** 32) >>> 0;
      await this.generateTerrain();
      for (let t = 0; t < TILE_COUNT; t++) for (const c of cellsOfTile(t)) w.touchCell(c, Dirty.Terrain);
      // the new terrain comes from the seed: it only needs to be written after being edited
      w.saveDirty.fill(0);
      this.endRebuild(null, '');
    } catch (err) {
      this.endRebuild(err, t('game.flow.newMap'));
    }
  }
}

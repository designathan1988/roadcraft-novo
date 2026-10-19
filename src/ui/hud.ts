// The game's interface, with Roadcraft's look and layout: a thin bar on top (sky, clock, money, counts, speed,
// layers, simulation, camera, undo, redo, health, help, menu), the dock of seven categories at the bottom, the
// drawer of each category with its tabs and things, the tool options at the bottom left, the selection panel on
// the right, the compass, toasts and the tool's hint. The DOM is built once; per-frame calls only write a text
// node when its value changed. Tools act through HudActions (implemented in game.ts).

import './shell.css';
import './engine.css';
import { RoadCatalog } from './roadCatalog.ts';
import { button, closeDropdown, el, orow, range, choices } from './dom.ts';
import { svg } from './icons.ts';
import { LANGUAGES, fmtCount, fmtDec, fmtInt, forTouch, isTouch, lang, loose, money, plural, setLang, t } from './i18n.ts';
import { mountCompass, type Compass } from './compass.ts';
import { keyHelp, keyName } from './keys.ts';
import { ROAD_TUNING } from '../roads/tuning.ts';
import { AboutBox } from './about.ts';
import { centreText } from './readouts.ts';
import type { PersonOptions, creatorCatalog } from '../render/people/creator.ts';
import {
  CATS, ShellState, categoriesOf, lineInfo, renderBuild, renderDemolish, renderLandscape, renderRoads, renderTransit, renderZones,
  type BuilderTab, type BuilderTabRender, type BuildingInfo, type Category, type DrawerHost, type DrawerParts, type LineRow,
} from './drawers.ts';

declare const __BUILD__: string;

export type Tool = 'camera' | 'inspect' | 'road' | 'curve' | 'roundabout' | 'upgrade' | 'blocks' | 'free' | 'move' | 'split' | 'bulldoze' | 'zone' | 'building' | 'transit' | 'streetscape' | 'barrier' | 'raise' | 'lower' | 'smooth' | 'flatten' | 'paint' | 'forest' | 'river' | 'weather' | 'landform' | 'elements' | 'sky' | 'person' | 'pistol' | 'bomb';
export type SkyMode = 'ciclo' | 'dia' | 'noite';
export interface SkyToolState { cloud: 'none' | 'add' | 'move' | 'edit' | 'remove'; fog: 'none' | 'lay' | 'erase'; size: number; base: number; density: number; fogHeight: number }
/** Rain 0..1, wind in m/s, direction in degrees (where it blows to), lightning per minute, thunder 0..1. */
export interface WeatherCtl { rain: number; wind: number; dir: number; lightning: number; thunder: number }
export type LotMode = 'edit' | 'rect' | 'poly' | 'split' | 'join' | 'delete' | 'front' | 'corner';
export const TERRAIN_TOOLS: Tool[] = ['raise', 'lower', 'smooth', 'flatten', 'landform'];
/** Ground brushes (they share the radius). */
export const GROUND_TOOLS: Tool[] = ['paint', 'forest', 'elements'];
export const ROAD_TOOLS: Tool[] = ['road', 'curve', 'free', 'roundabout', 'upgrade', 'blocks', 'move', 'split', 'bulldoze'];

/** The simulation's settings the Simulation panel changes. */
export interface SimSettings { traffic: number; people: number; demand: 'baixa' | 'normal' | 'pico' }

/** The city's numbers for the top bar and the Simulation panel (counters the engine already keeps). */
export interface CityStatus {
  cars: number; peds: number; residents: number; jobs: number; buildings: number;
  speedKmh: number; tripsPerMin: number; lostPerMin: number; stopped: number; roads: number; nodes: number;
  /** Junctions that cannot be built (two roads under 25°). */
  impossible: number;
}

/**
 * Capabilities other fronts publish in Game.hudActions (the gameplay front's src/tools/featureActions.ts). They are
 * optional here: a panel turns its button on when the action exists, and leaves it "being built" otherwise.
 */
export interface OptionalActions {
  /** Lot: split by a line drawn across it (two clicks). */
  lotLine?(): void;
  /** Lot: curve a side (click near it, then where it should pass). */
  lotCurve?(): void;
  /** Leaves the two lot modes above. */
  lotExtraOff?(): void;
  /** Renovates the selected building. */
  renovate?(): void;
  /** Decay of the selected building, 0..1 (−1: none). */
  decayOf?(): number;
  /** Address of the selected building ("Rua X, 124"), '' when none. */
  addressOf?(): string;
  /** Name of the street nearest (x, z), '' away from streets. */
  streetNameAt?(x: number, z: number): string;
  /** Regional road paint of this map, saved with it. */
  mapPaint?(style: string): void;
  /** Colour of the chosen transit line (index into the vehicle paints, world/transit.ts LINE_COLORS). */
  lineColor?(color: number): void;
  /** The chosen bus line as a ring (true) or out and back. */
  lineLoop?(loop: boolean): void;
  /** Points the camera at the next impossible junction and inspects it (the top bar's warning). */
  showImpossible?(): void;
  /** The health panel's state for the dot on its button: ok, slow, broken. */
  healthLevel?(): string;
  /** The people creator's choices (people front, src/render/people/creator.ts). */
  personOptions?(o: Partial<PersonOptions>): void;
  /** What the people creator offers; null until the cooked people load. */
  peopleCatalog?(): ReturnType<typeof creatorCatalog> | null;
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
  /** Lot tool: edit building, draw (rectangle, polygon), split, join, delete, front, corners. */
  lotMode(mode: LotMode): void;
  /** Split: side by side or front and back, into how many. */
  lotSplit(kind: 'side' | 'depth', parts: number): void;
  /** Zone: brush or whole block. */
  zoneFill(block: boolean): void;
  lotUse(zone: number): void;
  demolishBuilding(): void;
  /** See inside: on/off and floor (+1 / −1). */
  inside(cmd: 'toggle' | 'up' | 'down'): void;
  elevation(delta: number): void;
  /** Road snapping: 0 off, 1 angles, 2 angles and grid. */
  roadSnap(mode: number): void;
  /** Sides of a lowered road: batter or retaining walls. */
  cutWalls(on: boolean): void;
  /** Blocks: columns, rows, block (m), rotation (°). */
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
  /** The title screen (seed, map size, empty map, last game). */
  startScreen(): void;
  options(): void;
  help(): void;
  trafficView(): void;
  follow(): void;
  /** Map grid (on/off). */
  grid(): void;
  /** Compass: north up. */
  north(): void;
  line(id: number): void;
  newLine(): void;
  lineMode(mode: number): void;
  buses(delta: number): void;
  deleteLine(): void;
  item(kind: number): void;
  signType(kind: number): void;
  /** Sign text (street name etc.). */
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
  // ---- added with the Roadcraft interface
  /** Simulation speed: 0 paused, 1, 2 or 4. */
  speed(n: number): void;
  /** The compass dragged: turn and tilt as a right-button drag of so many pixels. */
  orbit(dx: number, dy: number): void;
  /** A quarter of a right angle to the left (−1) or right (+1). */
  turn(dir: number): void;
  /** Tilt towards the top view (+1) or the horizon (−1). */
  tilt(dir: number): void;
  /** The zone colours shown with any tool. */
  zoneLayer(on: boolean): void;
  /** Traffic %, people % and demand. */
  simulation(s: Partial<SimSettings>): void;
  settings(): SimSettings & { paint: string; furniture: number; roadUp: string; roadDown: string; roadAlign: string; preset: string; webgpu: boolean };
  /** A quality preset (baixo, medio, alto, ultra), applied and kept. */
  quality(preset: string): void;
  /** The view the city opened with (Home). */
  resetView(): void;
  /** Regional road markings: br, us, eu, classic. */
  paint(style: string): void;
  /** Furniture of new roads: 0 complete, 1 basic, 2 none. */
  furniture(n: number): void;
  /** Roundabout radius ×f. */
  ring(f: number): void;
  /** Stops become terminals when clicked. */
  terminal(on: boolean): void;
  /** The F9 panel (a developer's tool). */
  health(): void;
  /** The developer panels are on (?dev, or roadcraft.dev in the browser's storage, or the development server). */
  developer(): boolean;
  /** Water, weather set by hand (null: automatic) and overall haze (0..2) of the map on screen (saved with it). */
  environment(): { water: { waves: number; foam: number; current: number }; weather: WeatherCtl | null; fog: number };
  /** Street item clicks remove (on) or place (off). */
  itemRemove(on: boolean): void;
  /** Camera distance to its target (m) and the target on the map. */
  cameraNumbers(): { zoom: number; x: number; z: number };
}

type PopId = 'menu' | 'layers' | 'sim' | 'camera' | 'help';

/** The keys of each tool, for the help panel: [key, what it does]. */
const TOOL_KEYS: Partial<Record<Tool | 'roads' | 'terrain', Array<[string, string]>>> = {
  roads: [['help.key.click', 'ui.do.roadPoint'], ['ui.key.altClick', 'ui.do.copyProfile'], ['help.key.pageUpDown', 'palette.height'], ['ui.key.v', 'roadKeys.alignment'], ['help.key.esc', 'ui.do.cancel']],
  roundabout: [['help.key.click', 'ui.do.roundabout'], ['ui.key.brackets', 'v2.roundabout.radius']],
  terrain: [['v2.key.drag', 'ui.do.brush'], ['ui.key.brackets', 'terrain.radius']],
  bulldoze: [['help.key.click', 'help.do.remove'], ['v2.key.drag', 'ui.do.boxRemove'], ['help.key.undo', 'help.do.undo']],
  streetscape: [['help.key.click', 'help.do.streetscape'], ['v2.key.drag', 'hint.streetscape.row'], ['help.key.shiftClick', 'help.do.streetscapeRemove']],
  barrier: [['help.key.click', 'help.do.barrierPoint'], ['help.key.doubleClickEnter', 'help.do.barrierEnd'], ['help.key.backspace', 'help.do.barrierBack'], ['help.key.shiftClick', 'help.do.barrierRemove'], ['help.key.esc', 'help.do.barrierCancel']],
  inspect: [['help.key.click', 'help.do.pick'], ['ui.key.delete', 'ui.do.deleteRoad'], ['help.key.esc', 'help.do.close']],
  transit: [['help.key.click', 'ui.do.stop'], ['help.key.shiftClick', 'ui.do.terminal']],
  building: [['help.key.click', 'ui.do.pickBuilding'], ['help.key.pageUpDown', 'ui.build.floors'], ['ui.key.delete', 'inspector.demolish'], ['help.key.doubleClickEnter', 'ui.do.closePolygon']],
  river: [['help.key.click', 'ui.do.riverPoint'], ['help.key.doubleClickEnter', 'ui.do.riverEnd'], ['help.key.backspace', 'help.do.barrierBack']],
  zone: [['v2.key.drag', 'ui.do.zone'], ['ui.key.brackets', 'terrain.radius']],
};
const CAMERA_KEYS: Array<[string, string]> = [['help.key.orbitDrag', 'help.do.orbit'], ['help.key.panDrag', 'help.do.pan'], ['help.key.wheel', 'help.do.zoom'], ['help.key.qe', 'ui.do.turn'],
  ['ui.key.rf', 'ui.do.tilt']];

export class Hud {
  readonly root: HTMLElement;
  readonly catalog: RoadCatalog;
  /** The selection column on the right: the inspector lives here. */
  readonly side: HTMLElement;
  /** Extension point of the Build drawer: the buildings session mounts its editor (creator.ts) here. */
  readonly buildingSlot: HTMLElement;
  private a: HudActions;
  private s = new ShellState();
  private current: Tool = 'camera';
  private cat: Category | null = null;
  private open = false;
  private lastTool = new Map<Category, Tool>();
  // top bar
  private clockText = document.createTextNode('');
  private moneyText = document.createTextNode('');
  private statsText = document.createTextNode('');
  private impossibleB: HTMLButtonElement;
  private impossibleText = document.createTextNode('');
  private impossibleShown = 0;
  private healthB!: HTMLButtonElement;
  private stats: HTMLElement;
  private skyButtons: HTMLButtonElement[] = [];
  private speedButtons: HTMLButtonElement[] = [];
  private undoB: HTMLButtonElement;
  private redoB: HTMLButtonElement;
  private insideBar: HTMLElement;
  private insideLevel: HTMLElement;
  private speedNow = 1;
  private status: CityStatus | null = null;
  private moneyShown = NaN;
  private clockShown = '';
  // popovers
  private pop: HTMLElement;
  private popId: PopId | null = null;
  private popAnchor: HTMLElement | null = null;
  private metrics: HTMLElement | null = null;
  private layers = { grid: false, zones: false, traffic: false };
  private view: 'persp' | 'iso' = 'persp';
  private insideFloor = -1;
  private about = new AboutBox();
  private readoutTimer = 0;
  // dock and drawer
  private catButtons = new Map<Category, HTMLButtonElement>();
  private drawer: HTMLElement;
  private toolOptions: HTMLElement;
  private parts: DrawerParts;
  private hint: HTMLElement;
  /** The toasts shown now (newest first). */
  private toasts: HTMLElement;
  private tip: HTMLElement;
  private tipFor: HTMLElement | null = null;
  private compass: Compass;
  private loading: HTMLElement;
  private loadingText: HTMLElement;
  private rows: LineRow[] = [];
  private rowsKey = '';
  private rowsNums = '';
  private stripSignature = '';
  private lineNow = 0;
  private picked: BuildingInfo | null = null;
  private peopleShown = false;
  private builderTabs = new Map<BuilderTab, BuilderTabRender>();
  private host: DrawerHost;
  private fileIn: HTMLInputElement;

  constructor(a: HudActions) {
    this.a = a;
    this.root = document.getElementById('hud')!;
    this.root.className = 'v2';
    this.loading = document.getElementById('loading')!;
    this.loadingText = document.getElementById('loading-text')!;
    this.catalog = new RoadCatalog({ use: (id) => a.profile(id), toast: (text) => this.toast(text) });

    // ============================================================ top bar
    const hud = el('header', 'v2-hud');
    const city = el('div', 'v2-city');
    const sky = el('div', 'v2-seg v2-sky');
    for (const [mode, key, icon] of [['dia', 'sky.day', 'sun'], ['noite', 'sky.night', 'moon'], ['ciclo', 'sky.cycle', 'cycle']] as const) {
      const b = button('v2-seg-b', t(key), () => { a.sky(mode); this.setSky(mode); }, svg(icon, 16));
      b.dataset.sky = mode;
      this.skyButtons.push(b);
      sky.append(b);
    }
    sky.title = t('sky.title');
    const clock = el('strong', 'v2-clock');
    clock.append(this.clockText);
    const moneyEl = el('strong', 'v2-money');
    moneyEl.append(this.moneyText);
    moneyEl.title = t('ui.money.tip', { refund: Math.round(ROAD_TUNING.economy.demolitionRefund * 100) });
    this.stats = el('div', 'v2-stats');
    this.stats.append(this.statsText);
    // junctions that cannot be built: their count, and a click visits them one by one
    this.impossibleB = button('v2-warn', '', () => a.showImpossible?.(), svg('warn', 16));
    this.impossibleB.append(this.impossibleText);
    this.impossibleB.hidden = true;
    city.append(sky, clock, moneyEl, this.impossibleB, this.stats);

    const speed = el('div', 'v2-speed');
    for (const n of [0, 1, 2, 4]) {
      const b = el('button', 'v2-speed-b');
      b.type = 'button';
      b.dataset.speed = String(n);
      b.innerHTML = n === 0 ? svg('pause', 16) : `${n}×`;
      b.title = n === 0 ? `${t('sim.pause')} (${t('v2.key.space')})` : `${t('sim.speed')} ${n}×`;
      b.addEventListener('click', (e) => { e.stopPropagation(); a.speed(n); });
      this.speedButtons.push(b);
      speed.append(b);
    }

    const actions = el('div', 'v2-actions');
    this.insideLevel = el('span', 'v2-inside-level');
    this.insideBar = el('div', 'v2-inside');
    this.insideBar.append(button('v2-icon on', t('inside.toggle'), () => a.inside('toggle'), svg('interiorView', 18)),
      button('v2-icon', t('inside.down'), () => a.inside('down'), svg('floorDown', 16)), this.insideLevel,
      button('v2-icon', t('inside.up'), () => a.inside('up'), svg('floorUp', 16)));
    this.insideBar.hidden = true;
    const layersB = button('v2-pill', t('v2.layers'), () => this.toggle('layers', layersB), svg('layers', 18));
    const simB = button('v2-pill', t('builder.menu.simulation'), () => this.toggle('sim', simB), svg('advanced', 18));
    const camB = button('v2-pill', t('camera.label'), () => this.toggle('camera', camB), svg('camera', 18));
    this.undoB = button('v2-icon', t('action.undo'), () => a.undo(), svg('undo', 18));
    this.redoB = button('v2-icon', t('action.redo'), () => a.redo(), svg('redo', 18));
    // the health panel is a developer's tool: its button only when the developer panels are on
    const healthB = button('v2-icon health-btn', t('health.button'), () => a.health(), svg('health', 18));
    healthB.append(el('i', 'health-dot'));
    healthB.hidden = !a.developer();
    this.healthB = healthB;
    const helpB = button('v2-icon', `${t('builder.help')} (F1)`, () => this.toggle('help', helpB), svg('help', 18));
    helpB.dataset.pop = 'help';
    const menuB = button('v2-pill', t('builder.menu.app'), () => this.toggle('menu', menuB), svg('menu', 18));
    for (const [b, id] of [[layersB, 'layers'], [simB, 'sim'], [camB, 'camera'], [menuB, 'menu']] as const) b.dataset.pop = id;
    actions.append(this.insideBar, layersB, simB, camB, this.undoB, this.redoB, healthB, helpB, menuB);
    hud.append(city, speed, actions);

    this.pop = el('div', 'v2-pop');
    this.pop.hidden = true;
    document.addEventListener('pointerdown', (e) => {
      if (!this.popId) return;
      const target = e.target as Node;
      if (!this.pop.contains(target) && !this.popAnchor?.contains(target)) this.closePop();
    }, true);
    this.fileIn = el('input');
    this.fileIn.type = 'file'; this.fileIn.accept = '.cidade'; this.fileIn.hidden = true;
    this.fileIn.addEventListener('change', () => { const f = this.fileIn.files?.[0]; if (f) a.importMap(f); this.fileIn.value = ''; });

    // ============================================================ dock
    const dock = el('nav', 'v2-dock');
    for (const c of CATS) {
      const b = el('button', `v2-cat${c.id === 'demolish' ? ' danger' : ''}`);
      b.type = 'button';
      b.dataset.cat = c.id;
      b.innerHTML = svg(c.icon, 24);
      b.append(el('span', 'v2-cat-name', t(`v2.dock.${c.id}`)));
      b.title = `${t(`ui.cat.${c.id}`)}  ${c.key}`;
      b.addEventListener('click', (e) => { e.stopPropagation(); this.openCategory(c.id, true); });
      this.catButtons.set(c.id, b);
      dock.append(b);
    }

    // ============================================================ drawer and tool options
    this.drawer = el('section', 'v2-drawer');
    const head = el('div', 'v2-drawer-head');
    const tabs = el('div', 'v2-tabs');
    tabs.setAttribute('role', 'tablist');
    head.append(tabs);
    const body = el('div', 'v2-drawer-body');
    const strip = el('div', 'v2-strip');
    body.append(strip);
    // a row that scrolls sideways fades at the side with more in it (Roadcraft 4.0; the look is in shell.css)
    strip.addEventListener('scroll', (e) => { if (e.target instanceof HTMLElement) fadeEdges(e.target); }, { passive: true, capture: true });
    strip.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { strip.scrollLeft += e.deltaY; e.preventDefault(); }
      e.stopPropagation();
    }, { passive: false });
    const close = button('v2-icon', t('v2.close'), () => { this.open = false; a.tool('camera'); this.render(); }, svg('close', 18));
    this.drawer.append(head, body, close);
    this.toolOptions = el('section', 'v2-toolopts');
    const options = el('div', 'v2-options');
    const tools = el('div', 'v2-head-tools');
    this.toolOptions.append(options, tools);
    this.parts = { tabs, options, strip, tools };
    this.buildingSlot = el('div', 'v2-building-slot');

    this.side = el('aside', 'v2-side');
    this.hint = el('div', 'v2-hintbar');
    this.hint.hidden = true;
    this.toasts = el('div', 'v2-toasts');
    this.toasts.setAttribute('role', 'status');
    this.toasts.setAttribute('aria-live', 'polite');
    this.tip = el('div', 'v2-tip');
    this.tip.hidden = true;

    this.root.append(hud, this.pop, this.drawer, this.toolOptions, this.side, this.hint, dock, this.toasts, this.tip, this.about.root, this.fileIn);
    this.compass = mountCompass(this.root, { north: () => a.north(), drag: (dx, dy) => a.orbit(dx, dy) });
    // the panels never let a click or a wheel through to the map
    for (const e of [hud, this.pop, this.drawer, this.toolOptions, this.side, dock]) {
      e.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      e.addEventListener('wheel', (ev) => ev.stopPropagation(), { passive: true });
    }
    this.bindTips();
    window.addEventListener('resize', () => this.fitDrawer());
    // the tool options panel follows the side panel: the drawer gives way to both
    new ResizeObserver(() => this.fitDrawer()).observe(this.side);

    const self = this;
    this.host = {
      a, s: this.s, catalog: this.catalog, buildingSlot: this.buildingSlot,
      tool: () => self.current,
      pick: (tool) => { a.tool(tool); },
      render: () => self.render(),
      lines: () => ({ rows: self.rows, current: self.lineNow }),
      building: () => self.picked,
      insideFloor: () => self.insideFloor,
      builderTabs: this.builderTabs,
      // short names, so the three fit in the pill (Roadcraft 4.0: PgUp · PgDn · V)
      roadKeys: () => { const k = a.settings(); const n = (c: string): string => keyName(c).replace('Page Up', 'PgUp').replace('Page Down', 'PgDn'); return `${n(k.roadUp)} · ${n(k.roadDown)} · ${n(k.roadAlign)}`; },
    };
    this.setSky('ciclo');
    this.syncSpeed();
    this.render();
  }

  // ================================================================ categories
  /** Opens a category's drawer with its tool (the dock button, or its key). A second press puts the tool down. */
  openCategory(id: Category, fromDock = false): void {
    if (this.cat === id && this.open && (fromDock || id === 'info')) {
      this.open = false;
      this.a.tool('camera');
      this.render();
      return;
    }
    this.cat = id;
    this.open = true;
    // Build edits buildings: a lot mode left on by the Zones tab (split, join...) goes back to editing
    if (id === 'build' && !['edit', 'rect', 'poly'].includes(this.s.lotMode)) { this.a.lotExtraOff?.(); this.s.lotExtra = null; this.s.lotMode = 'edit'; this.a.lotMode('edit'); }
    const def = CATS.find((c) => c.id === id)!.tool;
    const keep = categoriesOf(this.current).includes(id);
    if (!keep) this.a.tool(this.lastTool.get(id) ?? def);
    else this.render();
  }

  /** The category a key or the game put the tool in. */
  setTool(tool: Tool): void {
    this.current = tool;
    const cats = categoriesOf(tool);
    if (!cats.length) this.open = false;
    else {
      if (!this.cat || !cats.includes(this.cat)) this.cat = cats[0];
      this.open = true;
      this.lastTool.set(this.cat, tool);
    }
    const hint = `hint.tool.${tool}`;
    const own = t(hint);
    if (own !== hint) this.setHint(own);
    this.render();
  }

  private render(): void {
    for (const [id, b] of this.catButtons) b.classList.toggle('on', this.open && id === this.cat);
    const p = this.parts;
    closeDropdown();
    // the same panel rebuilt (a pick in it): the strip keeps its scroll (Roadcraft 4.0)
    const signature = `${this.cat}|${this.current}|${this.s.landTab}|${this.s.transitTab}`;
    const scroll = p.strip.scrollLeft;
    p.tabs.replaceChildren(); p.options.replaceChildren(); p.strip.replaceChildren(); p.tools.replaceChildren();
    const show = this.open && this.cat !== null && this.cat !== 'info';
    if (show) {
      if (this.cat !== 'roads' && this.cat !== 'transit') this.catalog.visible = false;
      switch (this.cat) {
        case 'roads': renderRoads(this.host, p); break;
        case 'zones': renderZones(this.host, p); break;
        case 'build': renderBuild(this.host, p); break;
        case 'landscape': renderLandscape(this.host, p); break;
        case 'transit': renderTransit(this.host, p); break;
        case 'demolish': renderDemolish(this.host, p); break;
      }
      if (this.cat === 'transit' && this.current === 'road') { this.catalog.visible = false; }
    } else this.catalog.visible = false;
    this.drawer.hidden = !show || (p.tabs.childElementCount === 0 && p.strip.childElementCount === 0);
    this.toolOptions.hidden = !show || p.options.childElementCount === 0;
    p.strip.classList.toggle('two-rows', p.strip.querySelectorAll('.v2-card').length > 10);
    if (signature === this.stripSignature) p.strip.scrollLeft = scroll;
    this.stripSignature = signature;
    fadeEdges(p.strip);
    this.root.dataset.tool = this.current;
    this.fitDrawer();
    this.tipCheck();
    if (this.popId === 'help') this.fillPop('help');
  }

  /** The drawer stands centred in the room between the tool options (left) and the selection panel (right). */
  private fitDrawer(): void {
    if (this.drawer.hidden) return;
    const vw = window.innerWidth;
    let left = 12, right = vw - 12;
    if (!this.toolOptions.hidden) left = Math.max(left, this.toolOptions.getBoundingClientRect().right + 12);
    const sr = this.side.getBoundingClientRect();
    if (sr.width > 0 && sr.bottom > this.drawer.getBoundingClientRect().top - 4) right = Math.min(right, sr.left - 12);
    const room = Math.max(320, right - left);
    // a narrow screen pins the drawer to both edges (shell.css, max-width: 780px), as Roadcraft 4.0
    this.drawer.style.left = vw <= 780 ? '' : `${Math.round(right - left >= 320 ? (left + right) / 2 : vw / 2)}px`;
    this.drawer.style.maxWidth = vw <= 780 ? '' : `${Math.floor(room)}px`;
    // a card whose name has a word wider than the card grows to the word
    for (const name of this.parts.strip.querySelectorAll<HTMLElement>('.v2-card-name')) {
      const over = name.scrollWidth - name.clientWidth, card = name.parentElement;
      if (over > 1 && card) card.style.width = `${Math.ceil(card.offsetWidth + over)}px`;
    }
    // the modes keep their names while they fit; when they do not, only the one in use keeps its name, then none
    const tabs = this.parts.tabs, head = tabs.parentElement!;
    tabs.classList.remove('compact', 'tight');
    if (tabs.scrollWidth > head.clientWidth - 8) tabs.classList.add('compact');
    if (tabs.scrollWidth > head.clientWidth - 8) tabs.classList.add('tight');
  }

  // ================================================================ popovers
  private toggle(id: PopId, anchor: HTMLElement): void {
    if (this.popId === id) { this.closePop(); return; }
    // another menu open: it closes (and its button goes out) first
    if (this.popId) this.closePop();
    this.popId = id;
    this.popAnchor = anchor;
    this.fillPop(id);
    this.pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    this.pop.style.top = `${Math.round(r.bottom + 8)}px`;
    this.pop.style.right = `${Math.max(12, Math.round(window.innerWidth - r.right))}px`;
    anchor.classList.add('on');
  }

  private closePop(): void {
    this.popAnchor?.classList.remove('on');
    this.pop.hidden = true;
    this.popId = null;
    this.popAnchor = null;
    this.metrics = null;
  }

  /** The help panel (F1, or the "?" button). */
  toggleHelp(): void {
    const b = this.root.querySelector<HTMLElement>('[data-pop="help"]');
    if (b) this.toggle('help', b);
  }

  get helpOpen(): boolean { return this.popId === 'help'; }
  /** Ctrl+O: the file picker of "Open file". */
  openFile(): void { this.fileIn.click(); }
  /** The About box (a dialog over the game). */
  get aboutOpen(): boolean { return this.about.isOpen; }
  closeAbout(): void { this.about.close(); }

  /** Esc: closes the open menu, then the About box. False: nothing was open here. */
  escape(): boolean {
    // the menu closes and its button takes the focus back (as in Roadcraft 4.0)
    if (this.popId) { const anchor = this.popAnchor; this.closePop(); anchor?.focus({ preventScroll: true }); return true; }
    if (this.about.isOpen) { this.about.close(); return true; }
    return false;
  }

  private row(label: string, run: () => void, icon: string): HTMLButtonElement {
    return button('v2-row', label, () => { run(); this.closePop(); }, svg(icon, 18));
  }

  private seg(label: string, items: ReadonlyArray<readonly [string, string]>, value: string, pick: (v: string) => void): HTMLElement {
    return orow(label, choices(items.map(([v, name]) => ({ label: name, on: v === value, run: () => { pick(v); if (this.popId) this.fillPop(this.popId); } }))));
  }

  private fillPop(id: PopId): void {
    const a = this.a;
    const titles: Partial<Record<PopId, string>> = { layers: 'v2.layers', sim: 'builder.menu.simulation', camera: 'camera.label', help: 'builder.help' };
    const body = el('div', 'v2-pop-body');
    this.metrics = null;
    clearInterval(this.readoutTimer);
    if (id === 'menu') {
      const st = a.settings();
      body.append(
        this.row(t('action.newMap'), () => a.newMap(), 'm_new'),
        this.row(t('ui.menu.start'), () => a.startScreen(), 'roads'),
        this.row(t('ui.menu.generate'), () => a.generate(), 'generate'),
        this.row(t('ui.menu.load'), () => a.load(), 'm_open'),
        this.row(t('action.openMap'), () => this.fileIn.click(), 'm_open'),
        this.row(t('ui.menu.save'), () => a.save(), 'm_save'),
        this.row(t('action.saveMap'), () => a.exportMap(), 'm_save'),
        el('hr'),
        // the four quality presets in the menu, as in Roadcraft 4.0 (Graphics options has the rest)
        this.seg(t('menu.quality'), (['baixo', 'medio', 'alto', 'ultra'] as const).map((q) => [q, t(`quality.${q === 'baixo' ? 'low' : q === 'medio' ? 'medium' : q === 'alto' ? 'high' : 'ultra'}`)] as const), st.preset, (v) => a.quality(v)),
        this.row(t('menu.graphicsOptions'), () => a.options(), 'm_quality'),
        this.seg(t('menu.language'), LANGUAGES, lang(), (v) => setLang(v as 'pt-BR' | 'en')),
        this.seg(t('menu.paint'), (['br', 'us', 'eu', 'classic'] as const).map((p) => [p, t(`paint.${p}`)] as const), st.paint, (v) => { a.paint(v); a.mapPaint?.(v); }),
        el('hr'),
        ...(a.developer() ? [this.row(t('ui.menu.testCity'), () => a.testCity(), 'generate')] : []),
        this.row(t('action.about'), () => this.about.open(), 'm_about'),
      );
    } else if (id === 'layers') {
      const layer = (key: string, tip: string, icon: string, on: boolean, flip: () => void): HTMLButtonElement => {
        const b = button(`v2-row v2-switch${on ? ' on' : ''}`, t(key), () => { flip(); this.fillPop('layers'); }, svg(icon, 18));
        b.setAttribute('role', 'switch');
        b.setAttribute('aria-checked', String(on));
        b.title = t(tip);
        return b;
      };
      body.append(
        layer('v2.layer.grid', 'v2.grid.toggle', 'grid', this.layers.grid, () => a.grid()),
        layer('zone.colours', 'zone.colours', 'zones', this.layers.zones, () => { this.layers.zones = !this.layers.zones; a.zoneLayer(this.layers.zones); }),
        layer('sim.congestionLabel', 'sim.congestion', 'heat', this.layers.traffic, () => a.trafficView()),
        layer('v2.layer.inside', 'inside.toggle', 'interiorView', this.insideFloor >= 0, () => a.inside('toggle')),
      );
    } else if (id === 'sim') {
      const st = a.settings();
      body.append(
        range(t('sim.traffic'), 0, 300, 10, Math.round(st.traffic * 100), (v) => `${v}%`, (v) => a.simulation({ traffic: v / 100 })),
        range(t('sim.people'), 0, 300, 10, Math.round(st.people * 100), (v) => `${v}%`, (v) => a.simulation({ people: v / 100 })),
        this.seg(t('sim.demand'), [['baixa', t('sim.demand.low')], ['normal', t('sim.demand.normal')], ['pico', t('sim.demand.peak')]], st.demand, (v) => a.simulation({ demand: v as SimSettings['demand'] })),
      );
      this.metrics = el('dl', 'v2-metrics');
      body.append(this.metrics);
      this.syncMetrics();
    } else if (id === 'camera') {
      body.classList.add('icons');
      // the name without its key or its explanation: "Girar à esquerda", not "… (Q)" (Roadcraft 4.0 v2/shell.ts:759)
      const cam = (key: string, icon: string, run: () => void, on = false): HTMLButtonElement => button(`v2-icon${on ? ' on' : ''}`, t(key).replace(/\s*[(·].*$/, ''), run, svg(icon, 18));
      body.append(
        cam('ui.camera.turnLeft', 'undo', () => a.turn(-1)),
        cam('camera.tiltDown', 'lower', () => a.tilt(-1)),
        cam('camera.north', 'roundabout', () => a.north()),
        cam('camera.tiltUp', 'raise', () => a.tilt(1)),
        cam('ui.camera.turnRight', 'redo', () => a.turn(1)),
        cam('camera.perspective', 'mass', () => { a.view(this.view === 'iso' ? 'persp' : 'iso'); this.fillPop('camera'); }, this.view === 'persp'),
        cam('ui.camera.top', 'top', () => a.view('top')),
        cam('ui.camera.follow', 'follow', () => a.follow()),
        cam('action.resetView', 'resetView', () => a.resetView()),
      );
      const dl = el('dl', 'v2-metrics');
      const zoom = el('dd', '', ''), centre = el('dd', '', '');
      dl.append(el('dt', '', t('camera.zoom')), zoom, el('dt', '', t('camera.centre')), centre);
      const sync = (): void => {
        const c = a.cameraNumbers();
        // as Roadcraft 4.0 (v2/shell.ts:644-645): pixels per metre in %, and the centre with Y the map's north
        const zt = `${fmtInt(c.zoom)} %`, ct = centreText(c.x, c.z, fmtInt);
        if (zoom.textContent !== zt) zoom.textContent = zt;
        if (centre.textContent !== ct) centre.textContent = ct;
      };
      sync();
      this.readoutTimer = window.setInterval(() => { if (this.popId === 'camera') sync(); else clearInterval(this.readoutTimer); }, 250);
      this.pop.replaceChildren(el('div', 'v2-pop-title', t('camera.label')), body, dl);
      return;
    } else {
      body.classList.add('help');
      const keyList = (title: string, rows: Array<[string, string]>): HTMLElement => {
        const box = el('div', 'v2-keys');
        box.append(el('div', 'v2-subhead', title));
        const dl = el('dl');
        for (const [k, d] of rows) { const dt = el('dt'); dt.append(el('kbd', '', t(k))); dl.append(dt, el('dd', '', t(d))); }
        box.append(dl);
        return box;
      };
      const c = this.current;
      const own = TOOL_KEYS[c] ?? (categoriesOf(c)[0] === 'roads' ? TOOL_KEYS.roads : categoriesOf(c)[0] === 'landscape' ? TOOL_KEYS.terrain : undefined);
      if (own) body.append(keyList(`${t('help.section.tool')}: ${t(`ui.toolName.${c}`)}`, own));
      if (isTouch()) body.append(keyList(t('ui.touch.title'), [['ui.touch.tapKey', 'ui.touch.tapDo'], ['ui.touch.dragKey', 'ui.touch.dragDo'], ['ui.touch.compassKey', 'ui.touch.compassDo']]));
      // the shortcuts and the tool keys come from the key table (keys.ts): the help never drifts from the keys
      const keys = keyHelp(a.developer());
      const raw = (title: string, rows: Array<[string, string]>): HTMLElement => {
        const box = el('div', 'v2-keys');
        box.append(el('div', 'v2-subhead', title));
        const dl = el('dl');
        for (const [k, d] of rows) { const dt = el('dt'); dt.append(el('kbd', '', k)); dl.append(dt, el('dd', '', d)); }
        box.append(dl);
        return box;
      };
      body.append(keyList(t('help.section.camera'), CAMERA_KEYS), raw(t('keys.section.game'), keys.game), raw(t('keys.section.tools'), keys.tools));
    }
    const key = titles[id];
    this.pop.replaceChildren(...(key ? [el('div', 'v2-pop-title', t(key))] : []), body);
  }

  private syncMetrics(): void {
    const m = this.metrics, s = this.status;
    if (!m) return;
    const rows: Array<[string, string]> = s ? [
      ['sim.metric.trips', t('ui.perMin', { n: fmtInt(s.tripsPerMin) })], ['sim.metric.lost', t('ui.perMin', { n: fmtInt(s.lostPerMin) })],
      ['sim.metric.speed', `${fmtInt(s.speedKmh)} km/h`], ['sim.metric.queued', fmtInt(s.stopped)],
      ['ui.metric.vehicles', fmtInt(s.cars)], ['ui.metric.peds', fmtInt(s.peds)], ['ui.metric.residents', fmtCount(s.residents)], ['ui.metric.jobs', fmtCount(s.jobs)],
      ['ui.metric.buildings', fmtCount(s.buildings)], ['sim.metric.network', `${plural('status.roads', s.roads)} · ${plural('status.nodes', s.nodes)}`],
    ] : [];
    if (m.childElementCount !== rows.length * 2) {
      m.replaceChildren();
      for (const [k] of rows) m.append(el('dt', '', t(k)), el('dd', '', ''));
    }
    const dds = m.querySelectorAll('dd');
    rows.forEach(([, v], i) => { if (dds[i].textContent !== v) dds[i].textContent = v; });
  }

  // ================================================================ tooltip
  /** A control rebuilt or removed under the pointer takes its tooltip with it. */
  private tipCheck(): void {
    if (this.tipFor && (!this.tipFor.isConnected || this.tipFor.getBoundingClientRect().width === 0)) { this.tipFor = null; this.tip.hidden = true; }
  }

  private bindTips(): void {
    const tip = this.tip;
    /** Whether a control's name is on screen: an icon button keeps its name in a span clipped to nothing. */
    const nameShown = (c: HTMLElement): boolean => [...c.querySelectorAll('span')].every((s) => { const r = s.getBoundingClientRect(); return r.width > 2 && r.height > 2; });
    /** Whether a control's own text is cut short (an ellipsis): its tip then says it whole. */
    const cutShort = (c: HTMLElement): boolean => c.scrollWidth > c.clientWidth + 1 || [...c.querySelectorAll('span')].some((s) => s.scrollWidth > s.clientWidth + 1);
    this.root.addEventListener('pointerover', (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[title], [data-tip]');
      if (!target || !this.root.contains(target)) return;
      if (target.title) { target.dataset.tip = target.title; target.removeAttribute('title'); }
      const text = target.dataset.tip ?? '';
      if (!text) return;
      // a control that already shows its whole name: the tip would only say it again (Roadcraft 4.0)
      if (nameShown(target) && target.innerText.trim() === text && !cutShort(target)) return;
      this.tipFor = target;
      tip.textContent = text;
      tip.hidden = false;
      const r = target.getBoundingClientRect();
      const w = tip.offsetWidth, h = tip.offsetHeight;
      const above = r.top - h - 8 >= 4;
      tip.style.left = `${Math.round(Math.max(6, Math.min(window.innerWidth - w - 6, r.left + r.width / 2 - w / 2)))}px`;
      tip.style.top = `${Math.round(above ? r.top - h - 8 : r.bottom + 8)}px`;
    });
    this.root.addEventListener('pointerout', (e) => {
      if (!this.tipFor) return;
      const to = e.relatedTarget as Node | null;
      if (to && this.tipFor.contains(to)) return;
      this.tipFor = null;
      tip.hidden = true;
    });
    this.root.addEventListener('pointerdown', () => { tip.hidden = true; });
  }

  // ================================================================ what the game tells
  setLines(rows: LineRow[], current: number): void {
    // the passengers an hour change all the time: only their text is written; the panel is rebuilt when lines change
    const key = `${current}|${rows.map((r) => `${r.id},${r.mode},${r.color},${r.loop},${r.buses},${r.stops}`).join(';')}`;
    this.rows = rows;
    this.lineNow = current;
    if (key !== this.rowsKey) {
      this.rowsKey = key;
      if (this.cat === 'transit' && this.open) this.render();
      return;
    }
    const nums = rows.map((r) => Math.round(r.perHour)).join(',');
    if (nums === this.rowsNums) return;
    this.rowsNums = nums;
    for (const r of rows) {
      const info = this.drawer.querySelector(`.v2-transit-line[data-line="${r.id}"] .v2-transit-info`);
      const text = lineInfo(r);
      if (info && info.textContent !== text) info.textContent = text;
    }
  }

  setRadius(r: number): void { this.s.radius = Math.round(r); if (this.cat === 'landscape' && this.open) this.render(); }
  setProfile(p: number): void { this.catalog.select(p); }
  setBiome(b: number): void { this.s.biome = b; }
  setSky(m: SkyMode): void {

    for (const b of this.skyButtons) { const on = b.dataset.sky === m; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
  }
  setLotMode(m: LotMode): void {
    this.s.lotExtra = null;
    if (this.s.lotMode === m) return;
    this.s.lotMode = m;
    if (this.open && (this.cat === 'build' || this.cat === 'zones')) this.render();
  }
  /**
   * Mount point for the buildings session: the Build drawer's tab `id` (Models, Facade, Roof, Parts, Colours) turns
   * on and, when open, `render` fills the tool options for the building picked. Until then the tab says "being built".
   */
  registerBuilderTab(id: BuilderTab, render: BuilderTabRender): void {
    this.builderTabs.set(id, render);
    if (this.open && this.cat === 'build') this.render();
  }

  /** The building picked with the Build tool (null: none). */
  setBuilding(b: BuildingInfo | null): void {
    this.picked = b;
    if (this.open && this.cat === 'build') this.render();
  }
  /** The road height (the stepper, PageUp and PageDown): the open panel shows it. */
  setElevation(e: number): void { this.s.elevation = e; if (this.open && (this.cat === 'roads' || this.cat === 'transit')) this.render(); }
  /** The roundabout radius ([ and ]). */
  setRing(r: number): void { this.s.ring = r; if (this.open && this.cat === 'roads') this.render(); }
  /** The zone brush radius ([ and ] with the zone tool). */
  setZoneRadius(r: number): void { this.s.zoneRadius = Math.round(r); if (this.cat === 'zones' && this.open) this.render(); }
  /** See inside: the floor shown (−1: off). */
  setInside(floor: number): void {
    this.insideFloor = floor;
    this.insideBar.hidden = floor < 0;
    const text = floor <= 0 ? t('inside.ground') : t('inside.floor', { n: floor });
    if (this.insideLevel.textContent !== text) this.insideLevel.textContent = text;
    if (this.popId === 'layers') this.fillPop('layers');
  }

  /** Every frame: writes the clock only when the shown minute changes. */
  setClock(hour: number, simSpeed: number, paused = false): void {
    const h = Math.floor(hour), m = Math.floor((hour - h) * 60);
    const text = `${String(h).padStart(2, '0')}:${String(m - (m % 5)).padStart(2, '0')}`;
    if (text !== this.clockShown) { this.clockShown = text; this.clockText.data = text; }
    const now = paused ? 0 : simSpeed;
    if (now !== this.speedNow) { this.speedNow = now; this.syncSpeed(); }
  }

  private syncSpeed(): void {
    for (const b of this.speedButtons) { const on = Number(b.dataset.speed) === this.speedNow; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
  }

  setMoney(v: number, unlimited: boolean): void {
    const shown = unlimited ? Infinity : Math.round(v);
    if (shown === this.moneyShown) return;
    this.moneyShown = shown;
    this.moneyText.data = unlimited ? t('ui.money.unlimited') : money(shown);
  }

  /** The city's numbers (twice a second). */
  setStatus(s: CityStatus): void {
    this.status = s;
    // the People tab shown before the cooked people loaded: it becomes the full creator when they arrive
    if (!this.peopleShown && this.a.peopleCatalog?.()) { this.peopleShown = true; if (this.open && this.cat === 'landscape' && this.s.landTab === 'people') this.render(); }
    const line = s.cars + s.peds > 0 ? `${plural('status.vehicles', s.cars)} · ${plural('status.people', s.peds)}` : '';
    if (this.statsText.data !== line) this.statsText.data = line;
    const tip = t('ui.stats.tip', { residents: fmtCount(s.residents), jobs: fmtCount(s.jobs), buildings: fmtCount(s.buildings), speed: fmtInt(s.speedKmh) });
    if (this.stats.title !== tip && !this.stats.dataset.tip) this.stats.title = tip; else if (this.stats.dataset.tip) this.stats.dataset.tip = tip;
    this.syncMetrics();
    // the health button's dot: green, amber (a slow frame in 30 s) or red (an error)
    if (!this.healthB.hidden) { const lv = this.a.healthLevel?.() ?? 'ok'; if (this.healthB.dataset.status !== lv) this.healthB.dataset.status = lv; }
    // the decay of the building in the Build panel follows the city clock
    const decayEl = this.open && this.cat === 'build' ? this.toolOptions.querySelector('.v2-decay') : null;
    if (decayEl) { const d = `${Math.round(Math.max(0, this.a.decayOf?.() ?? 0) * 100)}%`; if (decayEl.textContent !== d) decayEl.textContent = d; }
    if (s.impossible !== this.impossibleShown) {
      this.impossibleShown = s.impossible;
      this.impossibleB.hidden = s.impossible === 0;
      this.impossibleText.data = fmtInt(s.impossible);
      const tip = `${plural('status.impossible', s.impossible)} · ${t('ui.impossible.visit')}`;
      this.impossibleB.title = tip; this.impossibleB.dataset.tip = tip;
      this.impossibleB.querySelector('span')!.textContent = tip;
    }
  }

  setTrafficView(on: boolean): void { this.layers.traffic = on; if (this.popId === 'layers') this.fillPop('layers'); }
  setGrid(on: boolean): void { this.layers.grid = on; if (this.popId === 'layers') this.fillPop('layers'); }

  /** Camera heading (rad): the needle points to north on the screen. */
  setCompass(yaw: number): void { this.compass.point(yaw); }

  setHint(text: string): void {
    const shown = forTouch(loose(text));
    if (this.hint.textContent !== shown) this.hint.textContent = shown;
    this.hint.hidden = !shown;
  }

  setHistory(canUndo: boolean, canRedo: boolean): void {
    this.undoB.disabled = !canUndo;
    this.redoB.disabled = !canRedo;
  }

  setView(mode: 'persp' | 'iso'): void { this.view = mode; if (this.popId === 'camera') this.fillPop('camera'); }

  /**
   * A short message. Several can show at once (a repair notice is not hidden by "City loaded"): the newest on top, at
   * most four, each for as long as it takes to read; the same text again only restarts its time.
   */
  toast(text: string): void {
    const shown = forTouch(loose(text));
    let box = [...this.toasts.children].find((e) => e.textContent === shown) as HTMLElement | undefined;
    if (!box) {
      box = el('div', 'v2-toast', shown);
      this.toasts.prepend(box);
      while (this.toasts.childElementCount > 4) this.toasts.lastElementChild!.remove();
    } else this.toasts.prepend(box);
    clearTimeout(Number(box.dataset.timer));
    const b = box;
    b.dataset.timer = String(window.setTimeout(() => b.remove(), Math.min(9000, 2600 + shown.length * 45)));
  }

  showLoading(text: string): void {
    this.loadingText.textContent = loose(text);
    this.loading.classList.remove('hidden');
  }

  hideLoading(): void { this.loading.classList.add('hidden'); }

  /** The decimal notation of the interface (for panels of other areas). */
  static dec(n: number, d = 1): string { return fmtDec(n, d); }
}

/** Marks a sideways-scrolling row with the side that has more (data-more: left, right, both). */
function fadeEdges(box: HTMLElement): void {
  const more = box.scrollWidth - box.clientWidth;
  const left = more > 1 && box.scrollLeft > 1, right = more > 1 && box.scrollLeft < more - 1;
  const v = left && right ? 'both' : left ? 'left' : right ? 'right' : '';
  if ((box.dataset.more ?? '') !== v) { if (v) box.dataset.more = v; else delete box.dataset.more; }
}

/** A key code as the player reads it. */
export { keyName };

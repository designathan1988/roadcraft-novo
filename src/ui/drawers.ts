// The asset panel of each dock category (the drawer at the bottom, with its tabs and its things) and the tool's
// options (bottom left), laid out like Roadcraft's shell. Each is rebuilt on a player action, never per frame.
// The shell keeps its own copy of every choice (ShellState): the engine's tools take them through HudActions.

import { Item } from '../world/items.ts';
import { GROUND_COLORS, Ground } from '../world/ground.ts';
import { ARCHES, FN_NAMES } from '../world/arch.ts';
import { PROFILES } from '../roads/profiles.ts';
import { DEFAULT_PERSON_OPTIONS, type PersonOptions } from '../render/people/creator.ts';
import { renderPeople } from './peoplePanel.ts';
import type { HudActions, LotMode, SkyToolState, Tool, WeatherCtl } from './hud.ts';
import type { RoadCatalog } from './roadCatalog.ts';
import { button, card, choices, el, orow, range, select, soon, stepper, subhead, swatchArt, tab, textInput, type Choice } from './dom.ts';
import { svg } from './icons.ts';
import { fmtDec, fmtInt, loose, plural, t } from './i18n.ts';

export type Category = 'roads' | 'zones' | 'build' | 'landscape' | 'transit' | 'demolish' | 'info';

/** The dock: category, the tool it opens, its key (the key table in keys.ts reads this too). */
export const CATS: ReadonlyArray<{ id: Category; tool: Tool; key: string; icon: string }> = [
  { id: 'roads', tool: 'road', key: '1', icon: 'roads' },
  { id: 'zones', tool: 'zone', key: 'Z', icon: 'zones' },
  { id: 'build', tool: 'building', key: 'H', icon: 'build' },
  { id: 'landscape', tool: 'raise', key: 'T', icon: 'landscape' },
  { id: 'transit', tool: 'transit', key: 'O', icon: 'transit' },
  { id: 'demolish', tool: 'bulldoze', key: 'B', icon: 'demolish' },
  { id: 'info', tool: 'inspect', key: 'I', icon: 'info' },
];

/** The categories a tool may be shown under (the first is its own). */
export function categoriesOf(tool: Tool): Category[] {
  switch (tool) {
    case 'road': return ['roads', 'transit'];
    case 'curve': case 'free': case 'blocks': case 'upgrade': case 'move': case 'split': case 'roundabout': return ['roads'];
    case 'zone': return ['zones'];
    case 'building': return ['build', 'zones'];
    case 'transit': return ['transit'];
    case 'bulldoze': case 'pistol': case 'bomb': return ['demolish'];
    case 'inspect': return ['info', 'roads'];
    case 'camera': return [];
    default: return ['landscape'];
  }
}

const ZONE_COLOURS = { residential: '#58c26f', commercial: '#4aa3e8', industrial: '#e6b84a', mixed: '#b07ad6' } as const;
type ZoneUse = keyof typeof ZONE_COLOURS | 'remove';
type Density = 'low' | 'medium' | 'high';
/** The engine's zone number for a use and a density (roads/zones.ts `Zone`). */
function zoneId(use: ZoneUse, d: Density): number {
  if (use === 'remove') return 0;
  if (use === 'residential') return d === 'low' ? 5 : d === 'high' ? 6 : 1;
  if (use === 'commercial') return d === 'low' ? 7 : d === 'high' ? 8 : 2;
  return use === 'industrial' ? 3 : 4;
}

const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;
const BIOME_COLOURS = ['', '#b8933e', '#2f6b34', '#1b4f27', '#a08b68', '#86ad4c', '#4e8f7c'];
const BIOME_KEYS = ['terrain.mapBiome.none', 'paint.kind.cerrado', 'paint.kind.atlantic', 'paint.kind.amazon', 'paint.kind.caatinga', 'paint.kind.pampa', 'paint.kind.pantanal'];
const GROUND_KEYS: Array<[number, string]> = [
  [Ground.Auto, 'paint.kind.grass'], [Ground.Sand, 'paint.kind.sand'], [Ground.Soil, 'paint.kind.soil'], [Ground.Meadow, 'paint.kind.meadow'],
  [Ground.Snow, 'paint.kind.snow'], [Ground.Gravel, 'paint.kind.gravel'], [Ground.Asphalt, 'paint.kind.asphalt'], [Ground.Concrete, 'paint.kind.concrete'],
  [Ground.Flowers, 'paint.kind.flowers'], [Ground.Rocks, 'paint.kind.rocks'], [Ground.Mud, 'paint.kind.mud'], [Ground.Cerrado, 'paint.kind.cerrado'],
  [Ground.Granite, 'paint.kind.granite'], [Ground.Sandstone, 'paint.kind.sandstone'], [Ground.Basalt, 'paint.kind.basalt'],
];
const TREES: Array<[number, string, string]> = [[0, 'tree.kind.mixed', 'tk_mixed'], [1, 'tree.kind.oak', 'tk_oak'], [2, 'tree.kind.cypress', 'tk_cypress'], [3, 'tree.kind.palm', 'tk_palm']];
const PLANTS: Array<[number, string]> = [[Item.Grass, 'grass'], [Item.TallGrass, 'tallGrass'], [Item.Scrub, 'scrub'], [Item.Fern, 'fern'], [Item.Clover, 'clover'],
  [Item.Flowers, 'flowers'], [Item.Mushrooms, 'mushrooms'], [Item.Stones, 'stones'], [Item.Pebbles, 'pebbles'], [Item.Gravel, 'gravel'], [Item.Leaves, 'leaves']];
const EFFECTS: Array<[number, string]> = [[Item.Smoke, 'smoke'], [Item.Fire, 'fire'], [Item.Steam, 'steam'], [Item.Dust, 'dust'], [Item.Soot, 'soot'], [Item.Sparks, 'sparks'], [Item.Spray, 'spray']];
const STREET: Array<[number, string, string]> = [
  [Item.Tree, 'streetscape.tree', 'ls_tree'], [Item.Conifer, 'streetscape.conifer', 'conifer'], [Item.Palm, 'tree.kind.palm', 'tk_palm'], [Item.Bush, 'streetscape.shrub', 'ls_shrub'],
  [Item.Bench, 'streetscape.bench', 'ls_bench'], [Item.Bin, 'streetscape.bin', 'ls_bin'], [Item.Lamp, 'streetscape.lamp', 'ls_lamp'], [Item.Hydrant, 'streetscape.hydrant', 'ls_hydrant'],
  [Item.Postbox, 'streetscape.postbox', 'ls_postbox'], [Item.Phone, 'streetscape.phone', 'ls_phone'], [Item.Drain, 'streetscape.drain', 'ls_drain'], [Item.Bollard, 'streetscape.bollard', 'bollard'],
  [Item.Planter, 'streetscape.planter', 'planter'], [Item.Sign, 'streetscape.sign', 'ls_sign'], [Item.Fountain, 'streetscape.fountain', 'fountain'],
];
const WALLS: Array<[number, string, string]> = [[Item.Fence, 'barrier.kind.fence', 'fenceRun'], [Item.Wall, 'barrier.kind.wall', 'wallRun'], [Item.Hedge, 'barrier.kind.hedge', 'hedge'],
  [Item.Guardrail, 'barrier.kind.guardrail', 'guardrail'], [Item.Railing, 'barrier.kind.railing', 'railing']];
const SIGNS: Array<[number, string]> = [[4, 'sign.type.stop'], [1, 'sign.type.yield'], [0, 'sign.type.speed'], [5, 'sign.type.noParking'], [6, 'sign.type.noEntry'],
  [7, 'sign.type.pedestrian'], [8, 'sign.type.school'], [9, 'sign.type.direction'], [2, 'sign.type.street'], [10, 'sign.type.info'], [3, 'sign.type.oneWay']];
const CLOTHES = ['#c8ccd0', '#2f4f7a', '#b8382e', '#e8e4dc', '#3d3d3d', '#7a8f4f', '#d9a441', '#6a4c93', '#e07a5f', '#3d8f8f', '#f2cc8f', '#81b29a', '#9c6644', '#264653', '#e9c46a', '#f4a261'];

export type LandTab = 'relief' | 'ground' | 'nature' | 'sky' | 'street' | 'people';
export type TransitTab = 'stop' | 'terminal' | 'trainTrack' | 'trainStation' | 'metroTrack' | 'metroStation';

/** Every choice the panels show, as the shell last set it (the engine starts with the same values). */
export class ShellState {
  snap = 0;
  elevation = 0;
  cutWalls = false;
  furniture = 0;
  ring = 22;
  blocks = { cols: 3, rows: 3, size: 100, angle: 0 };
  zoneUse: ZoneUse = 'residential';
  density: Density = 'medium';
  zoneFill = false;
  zoneRadius = 40;
  lotMode: LotMode = 'edit';
  /** The lot mode last used under Zones (the Lots tab goes back to it). */
  lastLotMode: LotMode = 'rect';
  /** A lot mode of the gameplay front in use (split by line, curve side), or none. */
  lotExtra: 'line' | 'curve' | null = null;
  splitKind: 'side' | 'depth' = 'side';
  splitParts = 2;
  lotUse = 1;
  radius = 60;
  strength = 40;
  riverWidth = 14;
  ground: number = Ground.Sand;
  biome = 0;
  forest: 'plant' | 'one' | 'cut' = 'plant';
  species = 0;
  elements = { kind: 30, mode: 'lay' as 'lay' | 'eraseKind' | 'eraseAll', density: 8, size: 7 };
  skyTool: SkyToolState = { cloud: 'add', fog: 'none', size: 500, base: 900, density: 0.8, fogHeight: 6 };
  fogAll = 100;
  cloudCount = 8;
  weather: WeatherCtl & { manual: boolean } = { rain: 0, wind: 4, dir: 65, lightning: 0, thunder: 1, manual: false };
  water = { waves: 0.3, foam: 0.4, current: 0.5 };
  item: number = Item.Tree;
  sign = 4;
  signText = '';
  barrier: number = Item.Fence;
  poleLights = 0;
  /** Remove poles: clicks with the item tools take things away. */
  itemRemove = false;
  person = { color: 3, height: 7, walk: false, count: 1 };
  /** The people creator's choices (DEFAULT_PERSON_OPTIONS, one person standing to start). */
  people: PersonOptions = { ...DEFAULT_PERSON_OPTIONS, count: 1, mode: 'stand' };
  bomb = 3;
  landTab: LandTab = 'relief';
  transitTab: TransitTab = 'stop';
}

/** A transit line as the panel lists it. */
export interface LineRow { id: number; mode: number; color: number; buses: number; stops: number; perHour: number; waiting: number }

/** The building picked with the Build tool. */
export interface BuildingInfo { fn: number; zone: number; floors: number; arch: number; address?: string; decay?: number }

export interface DrawerHost {
  readonly a: HudActions;
  readonly s: ShellState;
  readonly catalog: RoadCatalog;
  /** Where the buildings session's own panel goes (the creator). */
  readonly buildingSlot: HTMLElement;
  tool(): Tool;
  /** Takes a tool in hand (keeping the drawer's category). */
  pick(tool: Tool): void;
  render(): void;
  lines(): { rows: readonly LineRow[]; current: number };
  building(): BuildingInfo | null;
  /** Inside view: on, and the floor shown (−1: off). */
  insideFloor(): number;
  roadKeys(): string;
}

/** What a render fills. */
export interface DrawerParts { tabs: HTMLElement; options: HTMLElement; strip: HTMLElement; tools: HTMLElement }

const SOON = (): string => t('ui.soon');

/** The section of things in the strip: a group with its title (for screen readers) and its cards. */
export function section(strip: HTMLElement, label: string): HTMLElement {
  const box = el('div', 'v2-section');
  box.append(el('div', 'v2-section-title', label));
  const items = el('div', 'v2-section-items');
  box.append(items);
  strip.append(box);
  return items;
}

// ------------------------------------------------------------------ roads
export function renderRoads(h: DrawerHost, p: DrawerParts): void {
  const cur = h.tool(), s = h.s, a = h.a;
  const drawing = cur === 'road' || cur === 'curve' || cur === 'free' || cur === 'blocks';
  const modes: Array<[string, Tool, string, boolean]> = [
    ['tool.draw', 'road', 'draw', drawing], ['tool.upgrade', 'upgrade', 'upgrade', cur === 'upgrade'], ['tool.move', 'move', 'move', cur === 'move'],
    ['tool.split', 'split', 'split', cur === 'split'], ['tool.control', 'inspect', 'control', cur === 'inspect'], ['tool.roundabout', 'roundabout', 'roundabout', cur === 'roundabout'],
  ];
  for (const [key, tool, icon, on] of modes) p.tabs.append(tab(t(key), on, () => { if (!on) h.pick(tool); }, svg(icon, 18)));
  if (drawing) {
    const trace = (tool: Tool, key: string, icon: string): Choice => ({ label: t(key), on: cur === tool, run: () => h.pick(tool), icon: svg(icon, 18) });
    p.options.append(orow(t('palette.trace'), choices([trace('road', 'palette.alignment.straight', 'straight'), trace('curve', 'palette.alignment.curve', 'curve'),
      trace('free', 'palette.alignment.free', 'free'), trace('blocks', 'palette.blocks', 'blocks')])));
    if (cur === 'blocks') {
      const b = s.blocks, send = (): void => a.blocks({ ...b });
      p.options.append(
        orow(t('v2.blocks.count'),
          stepper(t('palette.blocks.cols'), `${b.cols}`, (d) => { b.cols = Math.max(1, Math.min(12, b.cols + d)); send(); return `${b.cols}`; }),
          stepper(t('palette.blocks.rows'), `${b.rows}`, (d) => { b.rows = Math.max(1, Math.min(12, b.rows + d)); send(); return `${b.rows}`; })),
        orow(t('v2.blocks.measure'),
          stepper(t('palette.blocks.size'), `${b.size} m`, (d) => { b.size = Math.max(40, Math.min(300, b.size + d * 10)); send(); return `${b.size} m`; }),
          stepper(t('palette.blocks.angle'), `${b.angle}°`, (d) => { b.angle = Math.max(-90, Math.min(90, b.angle + d * 15)); send(); return `${b.angle}°`; })));
    }
    const snap = (mode: number): void => { s.snap = mode; a.roadSnap(mode); h.render(); };
    p.options.append(orow(t('v2.snap.title'), choices([
      { label: t('v2.snap.on'), on: s.snap > 0, run: () => snap(s.snap > 0 ? 0 : 1), icon: svg('magnet', 18) },
      { label: t('v2.snap.angles'), on: s.snap >= 1, run: () => snap(s.snap >= 1 ? 0 : 1), icon: svg('angle', 18), disabled: s.snap === 0 },
      { label: t('v2.snap.grid'), on: s.snap === 2, run: () => snap(s.snap === 2 ? 1 : 2), icon: svg('cells', 18), disabled: s.snap === 0 },
    ])));
  }
  if (drawing || cur === 'upgrade') {
    const heightText = (): string => (s.elevation === 0 ? t('ui.height.ground') : `${s.elevation > 0 ? '+' : ''}${s.elevation} m`);
    const hr = orow(t('v2.row.height'), stepper(t('palette.height'), heightText(), (d) => {
      a.elevation(d * 4);
      s.elevation = Math.max(-12, Math.min(16, s.elevation + d * 4));
      return heightText();
    }));
    hr.title = `${t('palette.height')} (${h.roadKeys()})`;
    p.options.append(hr);
    const seg = (items: Array<[string, boolean, () => void]>, data: string): HTMLElement => {
      const r = el('div', 'v2-seg');
      for (const [label, on, run] of items) {
        const b = button(`v2-seg-b rp-seg-text${on ? ' on' : ''}`, label, () => { run(); h.render(); });
        b.dataset[data] = label;
        r.append(b);
      }
      return r;
    };
    p.options.append(orow(t('cutSides.row'), seg([[t('cutSides.batter'), !s.cutWalls, () => { s.cutWalls = false; a.cutWalls(false); }],
      [t('cutSides.walls'), s.cutWalls, () => { s.cutWalls = true; a.cutWalls(true); }]], 'cut')));
    const furn = orow(t('roadFurniture.row'), seg((['complete', 'basic', 'none'] as const).map((k, i) => [t(`roadFurniture.${k}`), s.furniture === i,
      () => { s.furniture = i; a.furniture(i); }] as [string, boolean, () => void]), 'furniture'));
    furn.title = t('roadFurniture.tip');
    p.options.append(furn);
    const keys = button('v2-pill rp-open', h.roadKeys(), () => a.options(), svg('keyboard', 16));
    keys.title = t('roadKeys.title');
    p.options.append(orow(t('roadKeys.row'), keys));
    // the catalogue of ready roads: tabs by category, a card drawn for each
    h.catalog.visible = true;
    p.strip.append(h.catalog.el);
  } else h.catalog.visible = false;
  if (cur === 'roundabout') {
    p.options.append(orow(t('v2.roundabout.radius'), stepper(t('v2.roundabout.radius'), `${s.ring} m`, (d) => {
      a.ring(d > 0 ? 1.2 : 1 / 1.2);
      s.ring = Math.round(Math.max(14, Math.min(60, s.ring * (d > 0 ? 1.2 : 1 / 1.2))));
      return `${s.ring} m`;
    })));
  }
}

// ------------------------------------------------------------------ zones
export function renderZones(h: DrawerHost, p: DrawerParts): void {
  const s = h.s, a = h.a;
  const painting = h.tool() === 'zone';
  p.tabs.append(
    tab(t('v2.zone.paint'), painting, () => { if (!painting) h.pick('zone'); }, svg('brush', 18)),
    tab(t('zone.lots'), !painting, () => { if (painting) { s.lotMode = s.lastLotMode; a.lotMode(s.lotMode); h.pick('building'); } }, svg('lotEdit', 18)),
  );
  if (painting) {
    const use = section(p.strip, t('v2.zone.use'));
    const setZone = (u: ZoneUse): void => { s.zoneUse = u; a.zone(zoneId(u, s.density)); h.render(); };
    for (const k of ['residential', 'commercial', 'industrial', 'mixed'] as const) {
      use.append(card(t(`zone.${k}`), s.zoneUse === k, () => setZone(k), `<i class="v2-zone-swatch" style="--zone:${ZONE_COLOURS[k]}"></i>`));
    }
    use.append(card(t('zone.remove'), s.zoneUse === 'remove', () => setZone('remove'), svg('eraser', 30), 'danger'));
    const denseOk = s.zoneUse === 'residential' || s.zoneUse === 'commercial';
    p.options.append(orow(t('v2.zone.density'), choices((['low', 'medium', 'high'] as const).map((d) => ({
      label: `${t('v2.zone.density')}: ${t(`zone.${d}`)}`, on: s.density === d, disabled: !denseOk, icon: svg(d, 18),
      run: () => { s.density = d; a.zone(zoneId(s.zoneUse, d)); h.render(); },
    })))));
    p.options.append(orow(t('v2.row.brush'), choices([
      { label: t('zone.brush'), on: !s.zoneFill, run: () => { s.zoneFill = false; a.zoneFill(false); h.render(); }, icon: svg('brush', 18) },
      { label: t('zone.fill'), on: s.zoneFill, run: () => { s.zoneFill = true; a.zoneFill(true); h.render(); }, icon: svg('fill', 18) },
    ])));
    if (!s.zoneFill) p.options.append(range(t('terrain.radius'), 10, 200, 5, s.zoneRadius, (v) => `${v} m`, (v) => { s.zoneRadius = v; a.zoneRadius(v); }));
    return;
  }
  const lots = section(p.strip, t('zone.lots'));
  const LOTS: Array<[LotMode | 'curve', string, string]> = [['rect', 'zone.lot.shape.rect', 'plus'], ['poly', 'zone.lot.shape.polygon', 'lotPolygon'], ['corner', 'zone.lot.edit', 'lotEdit'],
    ['curve', 'zone.lot.curve', 'lotCurve'], ['front', 'zone.lot.front', 'lotFront'], ['split', 'zone.lot.split', 'split'], ['join', 'zone.lot.join', 'join'], ['delete', 'zone.lot.delete', 'lotDelete']];
  for (const [mode, key, icon] of LOTS) {
    const on = mode === 'curve' ? s.lotExtra === 'curve' : s.lotExtra === null && s.lotMode === mode;
    const c = card(t(key), on, () => {
      if (mode === 'curve') { if (a.lotCurve) { a.lotCurve(); s.lotExtra = 'curve'; h.render(); } return; }
      a.lotExtraOff?.(); s.lotExtra = null;
      s.lotMode = mode; s.lastLotMode = mode; a.lotMode(mode); h.render();
    }, svg(icon, 30), mode === 'delete' ? 'danger' : '');
    if (mode === 'curve' && !a.lotCurve) soon(c, SOON());
    lots.append(c);
  }
  if (s.lotMode === 'split' || s.lotExtra === 'line') {
    p.options.append(orow(t('v2.row.cut'), choices([
      { label: t('zone.split.vertical'), on: s.lotExtra === null && s.splitKind === 'side', run: () => { a.lotExtraOff?.(); s.lotExtra = null; s.lotMode = 'split'; a.lotMode('split'); s.splitKind = 'side'; a.lotSplit('side', s.splitParts); h.render(); }, icon: svg('split_vertical', 18) },
      { label: t('zone.split.horizontal'), on: s.lotExtra === null && s.splitKind === 'depth', run: () => { a.lotExtraOff?.(); s.lotExtra = null; s.lotMode = 'split'; a.lotMode('split'); s.splitKind = 'depth'; a.lotSplit('depth', s.splitParts); h.render(); }, icon: svg('split_horizontal', 18) },
      { label: t('zone.split.line'), on: s.lotExtra === 'line', run: () => { if (a.lotLine) { a.lotLine(); s.lotExtra = 'line'; h.render(); } }, icon: svg('split_line', 18), soon: a.lotLine ? undefined : SOON() },
    ])));
    if (s.lotExtra !== 'line') p.options.append(orow(t('v2.row.parts'), choices([2, 3, 4, 5, 6].map((n) => ({
      label: `${t('zone.split.into')} ${n}`, on: s.splitParts === n, run: () => { s.splitParts = n; a.lotSplit(s.splitKind, n); h.render(); }, icon: `<b class="v2-num">${n}</b>`,
    })))));
  }
  if (s.lotMode === 'rect' || s.lotMode === 'poly') {
    p.options.append(orow(t('v2.zone.use'), select(t('v2.zone.use'), [[1, t('zone.residential')], [2, t('zone.commercial')], [3, t('zone.industrial')], [4, t('zone.mixed')]], s.lotUse,
      (v) => { s.lotUse = Number(v); a.lotUse(s.lotUse); })));
  }
}

// ------------------------------------------------------------------ build
export function renderBuild(h: DrawerHost, p: DrawerParts): void {
  const s = h.s, a = h.a, b = h.building();
  const editing = s.lotMode === 'edit';
  const tabs: Array<[string, string, (() => void) | null, boolean]> = [
    ['builder.category.models', 'models', null, false],
    ['ui.build.edit', 'mass', () => { s.lotMode = 'edit'; a.lotMode('edit'); h.render(); }, editing],
    ['builder.category.draw', 'draw', () => { s.lotMode = 'rect'; a.lotMode('rect'); h.render(); }, s.lotMode === 'rect' || s.lotMode === 'poly'],
    ['builder.category.facade', 'face', null, false], ['builder.category.roof', 'roof', null, false], ['builder.category.parts', 'components', null, false],
    ['builder.category.interior', 'interiorView', () => a.inside('toggle'), h.insideFloor() >= 0], ['builder.category.paint', 'paint', null, false],
  ];
  for (const [key, icon, run, on] of tabs) p.tabs.append(tab(t(key), on, run ?? (() => undefined), svg(icon, 18), run ? undefined : t('ui.soon.buildings')));
  if (editing) {
    if (b) {
      p.options.append(el('div', 'v2-pop-title', `${b.fn ? loose(FN_NAMES[b.fn]) : t(`zone.name.${b.zone}`)} · ${plural('ui.floors', b.floors)}`));
      // the address under the title (the decay has its own row below, with Renovate)
      const address = b.address || (a.addressOf?.() ?? '');
      if (address) p.options.append(el('div', 'v2-pop-sub', address));
      p.options.append(orow(t('builder.field.function'), select(t('builder.field.function'), FN_NAMES.map((n, i) => [i, i ? loose(n) : t('building.fn.none')] as const), b.fn, (v) => a.buildingFn(Number(v)))));
      p.options.append(orow(t('ui.build.floors'), stepper(t('ui.build.floors'), String(b.floors), (d) => { a.floors(d); return String(Math.max(1, b.floors + d)); })));
      p.options.append(orow(t('ui.build.style'), select(t('ui.build.style'), [[-1, t('ui.build.styleAuto')], ...ARCHES.map((x, i) => [i, loose(x.name)] as const)], b.arch, (v) => a.style(Number(v)))));
      p.options.append(orow(t('ui.build.actions'),
        button('v2-act danger', t('inspector.demolish'), () => a.demolishBuilding(), svg('demolish', 16)),
        button(`v2-act${h.insideFloor() >= 0 ? ' on' : ''}`, t('inside.toggle'), () => a.inside('toggle'), svg('interiorView', 16)),
        button('v2-act', t('inside.down'), () => a.inside('down'), svg('floorDown', 16)),
        button('v2-act', t('inside.up'), () => a.inside('up'), svg('floorUp', 16))));
      const decay = a.decayOf?.() ?? -1;
      if (decay >= 0) {
        const renovate = button('v2-pill rp-open', t('ui.build.renovate'), () => { a.renovate?.(); h.render(); }, svg('build', 16));
        if (!a.renovate) soon(renovate, SOON());
        renovate.title = t('ui.build.renovateTip');
        p.options.append(orow(t('ui.build.decay'), el('span', 'v2-stepper-value', `${Math.round(decay * 100)}%`), renovate));
      }
    } else {
      p.strip.append(el('p', 'v2-note', t('v2.build.selectToEdit')));
      p.options.append(subhead(t('ui.build.next')));
      p.options.append(orow(t('ui.build.style'), select(t('ui.build.style'), [[-1, t('ui.build.styleAuto')], ...ARCHES.map((x, i) => [i, loose(x.name)] as const)], -1, (v) => a.style(Number(v)))));
      p.options.append(orow(t('builder.field.function'), select(t('builder.field.function'), FN_NAMES.map((n, i) => [i, i ? loose(n) : t('building.fn.none')] as const), 0, (v) => a.buildingFn(Number(v)))));
    }
    // extension point: the buildings session mounts its editor here (src/ui/creator.ts)
    p.options.append(h.buildingSlot);
  } else {
    const draw = section(p.strip, t('builder.category.draw'));
    draw.append(card(t('zone.lot.shape.rect'), s.lotMode === 'rect', () => { s.lotMode = 'rect'; a.lotMode('rect'); h.render(); }, svg('plus', 30)),
      card(t('zone.lot.shape.polygon'), s.lotMode === 'poly', () => { s.lotMode = 'poly'; a.lotMode('poly'); h.render(); }, svg('lotPolygon', 30)));
    p.options.append(orow(t('v2.zone.use'), select(t('v2.zone.use'), [[1, t('zone.residential')], [2, t('zone.commercial')], [3, t('zone.industrial')], [4, t('zone.mixed')]], s.lotUse,
      (v) => { s.lotUse = Number(v); a.lotUse(s.lotUse); })));
  }
}

// ------------------------------------------------------------------ landscape
export function landTabOf(tool: Tool, item: number): LandTab {
  if (tool === 'paint') return 'ground';
  if (tool === 'forest' || tool === 'elements') return 'nature';
  if (tool === 'sky' || tool === 'weather') return 'sky';
  if (tool === 'streetscape') return EFFECTS.some(([k]) => k === item) ? 'sky' : 'street';
  if (tool === 'barrier') return 'street';
  if (tool === 'person') return 'people';
  return 'relief';
}

export function renderLandscape(h: DrawerHost, p: DrawerParts): void {
  const s = h.s, a = h.a, cur = h.tool();
  const now = landTabOf(cur, s.item);
  s.landTab = now;
  const first: Record<LandTab, () => void> = {
    relief: () => h.pick('raise'), ground: () => h.pick('paint'), nature: () => h.pick('forest'),
    sky: () => h.pick('sky'), street: () => { s.item = Item.Tree; a.item(s.item); h.pick('streetscape'); }, people: () => h.pick('person'),
  };
  for (const [id, key, icon] of [['relief', 'v2.land.relief', 'terrain'], ['ground', 'v2.land.ground', 'paint'], ['nature', 'v2.land.nature', 'ls_tree'],
    ['sky', 'v2.land.sky', 'cloud'], ['street', 'v2.land.street', 'ls_bench'], ['people', 'tool.person', 'people']] as const) {
    p.tabs.append(tab(t(key), now === id, () => { if (now !== id) first[id](); }, svg(icon, 18)));
  }
  const radius = (): HTMLElement => range(t('terrain.radius'), 5, 400, 5, s.radius, (v) => `${v} m`, (v) => { s.radius = v; a.radius(v); });
  const strength = (): HTMLElement => range(t('terrain.strength'), 1, 100, 1, s.strength, (v) => `${v}%`, (v) => { s.strength = v; a.strength(v / 100); });
  if (now === 'relief') {
    const brush = section(p.strip, t('v2.terrain.brush'));
    const landform = (m: string): void => { a.landform(m); h.pick('landform'); };
    for (const [tool, key, icon] of [['raise', 'terrain.raise', 'raise'], ['lower', 'terrain.lower', 'lower'], ['smooth', 'terrain.smooth', 'smooth'],
      ['flatten', 'terrain.flatten', 'flatten'], ['river', 'terrain.river', 'river']] as const) {
      brush.append(card(t(key), cur === tool, () => h.pick(tool), svg(icon, 30)));
    }
    brush.append(card(t('terrain.gully'), cur === 'landform' && landformNow === 'gully', () => { landformNow = 'gully'; landform('gully'); }, svg('gully', 30)));
    const forms = section(p.strip, t('v2.terrain.landforms'));
    for (const m of ['mesa', 'canyon', 'escarpment', 'sugarloaf'] as const) {
      forms.append(card(t(`terrain.${m}`), cur === 'landform' && landformNow === m, () => { landformNow = m; landform(m); }, svg(m, 30)));
    }
    if (cur === 'river') p.options.append(range(t('ui.river.width'), 6, 60, 1, s.riverWidth, (v) => `${v} m`, (v) => { s.riverWidth = v; a.riverWidth(v); }));
    else p.options.append(radius(), strength());
    const w = s.water, send = (): void => a.water({ ...w });
    p.options.append(subhead(t('water.title')),
      range(t('water.waves'), 0, 100, 1, Math.round(w.waves * 100), (v) => `${v}%`, (v) => { w.waves = v / 100; send(); }),
      range(t('water.foam'), 0, 100, 1, Math.round(w.foam * 100), (v) => `${v}%`, (v) => { w.foam = v / 100; send(); }),
      range(t('water.current'), 0, 3, 0.1, w.current, (v) => `${fmtDec(v)} m/s`, (v) => { w.current = v; send(); }));
    p.options.append(subhead(t('v2.map')), orow(t('v2.row.clear'), button('v2-act danger', t('terrain.clear'), () => a.flattenMap(), svg('flatten', 16))));
  } else if (now === 'ground') {
    const ground = section(p.strip, t('paint.kind'));
    for (const [g, key] of GROUND_KEYS) ground.append(card(t(key), s.ground === g, () => { s.ground = g; a.groundKind(g); h.render(); }, swatchArt(hex(GROUND_COLORS[g]))));
    p.options.append(radius(), strength());
    p.options.append(subhead(t('v2.map')), orow(t('v2.row.biome'), choices(BIOME_KEYS.map((key, i) => ({
      label: `${t('terrain.mapBiome')}: ${t(key)}`, on: s.biome === i, run: () => { s.biome = i; a.biome(i); h.render(); },
      icon: i === 0 ? '<i class="v2-ground none"></i>' : `<i class="v2-ground" style="--c:${BIOME_COLOURS[i]}"></i>`,
    })))));
  } else if (now === 'nature') {
    const trees = section(p.strip, t('tree.kind'));
    for (const [k, key, icon] of TREES) trees.append(card(t(key), cur === 'forest' && s.species === k, () => { s.species = k; a.forestSpecies(k); h.pick('forest'); }, svg(icon, 30)));
    const plants = section(p.strip, t('el.plants'));
    for (const [k, name] of PLANTS) plants.append(card(t(`el.kind.${name}`), cur === 'elements' && s.elements.kind === k, () => { s.elements.kind = k; a.elements({ ...s.elements }); h.pick('elements'); }, svg(`el_${name}`, 30)));
    if (cur === 'forest') {
      const mode = (m: 'plant' | 'one' | 'cut'): void => { s.forest = m; a.forestMode(m === 'cut'); a.forestOne(m === 'one'); h.render(); };
      p.options.append(orow(t('v2.row.brush'), choices([
        { label: t('tree.mode.plant'), on: s.forest === 'plant', run: () => mode('plant'), icon: svg('brush', 18) },
        { label: t('tree.mode.one'), on: s.forest === 'one', run: () => mode('one'), icon: svg('plus', 18) },
        { label: t('tree.mode.cut'), on: s.forest === 'cut', run: () => mode('cut'), icon: svg('eraser', 18) },
      ])));
      if (s.forest !== 'one') p.options.append(radius());
    } else if (cur === 'elements') elementRows(h, p);
  } else if (now === 'sky') {
    const sky = section(p.strip, t('atmo.title'));
    const st = s.skyTool, sendSky = (): void => { a.skyTool({ ...st }); };
    const cloudOn = cur === 'sky' && st.fog === 'none', fogOn = cur === 'sky' && st.fog !== 'none';
    sky.append(
      card(t('terrain.cloud'), cloudOn, () => { if (st.cloud === 'none') st.cloud = 'add'; st.fog = 'none'; sendSky(); h.pick('sky'); }, svg('cloud', 30)),
      card(t('terrain.fog'), fogOn, () => { st.fog = 'lay'; st.cloud = 'none'; sendSky(); h.pick('sky'); }, svg('fog', 30)),
      card(t('terrain.weather'), cur === 'weather', () => h.pick('weather'), svg('storm', 30)));
    const effects = section(p.strip, t('el.effects'));
    for (const [k, name] of EFFECTS) effects.append(card(t(`el.kind.${name}`), cur === 'streetscape' && s.item === k, () => { s.item = k; a.item(k); h.pick('streetscape'); }, svg(`el_${name}`, 30)));
    if (cloudOn) {
      const icons = { add: 'plus', move: 'move', edit: 'draw', remove: 'eraser' } as const;
      p.options.append(orow(t('v2.row.brush'), choices((['add', 'move', 'edit', 'remove'] as const).map((m) => ({
        label: t(`cloud.${m}`), on: st.cloud === m, run: () => { st.cloud = m; sendSky(); h.render(); }, icon: svg(icons[m], 18),
      })))),
      range(t('cloud.size'), 100, 1500, 50, st.size, (v) => `${v} m`, (v) => { st.size = v; sendSky(); }),
      range(t('cloud.height'), 300, 2500, 50, st.base, (v) => `${v} m`, (v) => { st.base = v; sendSky(); }, t('v2.s.base')),
      range(t('cloud.density'), 10, 100, 1, Math.round(st.density * 100), (v) => `${v}%`, (v) => { st.density = v / 100; sendSky(); }),
      subhead(t('cloud.spread')),
      range(t('cloud.count'), 1, 24, 1, s.cloudCount, (v) => String(v), (v) => { s.cloudCount = v; }),
      orow(t('v2.row.sky'), button('v2-act', t('cloud.scatter'), () => a.scatterClouds(s.cloudCount, 0.5), svg('scatter', 16)),
        button('v2-act danger', t('cloud.clear'), () => a.clearClouds(), svg('trash', 16))));
    } else if (fogOn) {
      p.options.append(orow(t('v2.row.brush'), choices([
        { label: t('fog.lay'), on: st.fog === 'lay', run: () => { st.fog = 'lay'; sendSky(); h.render(); }, icon: svg('brush', 18) },
        { label: t('fog.erase'), on: st.fog === 'erase', run: () => { st.fog = 'erase'; sendSky(); h.render(); }, icon: svg('eraser', 18) },
      ])), radius(), range(t('fog.height'), 1, 15, 1, st.fogHeight, (v) => String(v), (v) => { st.fogHeight = v; sendSky(); }),
      subhead(t('v2.map')), range(t('atmo.fog'), 0, 200, 5, s.fogAll, (v) => `${v}%`, (v) => { s.fogAll = v; a.fogLevel(v / 100); }, t('v2.s.fogAll')));
    } else if (cur === 'weather') {
      const w = s.weather;
      const send = (): void => a.weather(w.manual ? { rain: w.rain, wind: w.wind, dir: w.dir, lightning: w.lightning, thunder: w.thunder } : null);
      const manual = (): void => { if (!w.manual) { w.manual = true; h.render(); } send(); };
      p.options.append(orow(t('ui.weather.mode'), choices([
        { label: t('ui.weather.auto'), on: !w.manual, run: () => { w.manual = false; send(); h.render(); } },
        { label: t('ui.weather.manual'), on: w.manual, run: () => { w.manual = true; send(); h.render(); } },
      ])),
      range(t('weather.rain'), 0, 100, 1, Math.round(w.rain * 100), (v) => `${v}%`, (v) => { w.rain = v / 100; manual(); }),
      range(t('weather.wind'), 0, 25, 1, w.wind, (v) => `${v} m/s`, (v) => { w.wind = v; manual(); }),
      range(t('weather.windDirection'), 0, 359, 1, w.dir, (v) => `${v}°`, (v) => { w.dir = v; manual(); }, t('v2.s.direction')),
      subhead(t('weather.storm')),
      range(t('weather.lightning'), 0, 12, 1, w.lightning, (v) => String(v), (v) => { w.lightning = v; manual(); }, t('v2.s.lightning')),
      range(t('weather.thunder'), 0, 100, 1, Math.round(w.thunder * 100), (v) => `${v}%`, (v) => { w.thunder = v / 100; manual(); }, t('v2.s.thunder')));
    }
  } else if (now === 'street') {
    const furniture = section(p.strip, t('tool.streetscape'));
    for (const [k, key, icon] of STREET) furniture.append(card(t(key), cur === 'streetscape' && s.item === k, () => { s.itemRemove = false; a.itemRemove(false); s.item = k; a.item(k); h.pick('streetscape'); h.render(); }, svg(icon, 30)));
    const walls = section(p.strip, t('v2.land.walls'));
    for (const [k, key, icon] of WALLS) walls.append(card(t(key), cur === 'barrier' && s.barrier === k, () => { s.itemRemove = false; a.itemRemove(false); s.barrier = k; a.barrierKind(k); h.pick('barrier'); h.render(); }, svg(icon, 30)));
    const poles = section(p.strip, t('tool.pole'));
    const poleOn = cur === 'barrier' && s.barrier === Item.PoleLine;
    poles.append(card(t('pole.mode.build'), poleOn && !s.itemRemove, () => { s.itemRemove = false; a.itemRemove(false); s.barrier = Item.PoleLine; a.barrierKind(Item.PoleLine); h.pick('barrier'); h.render(); }, svg('pole_build', 30)));
    poles.append(card(t('pole.mode.remove'), poleOn && s.itemRemove, () => { s.itemRemove = true; a.itemRemove(true); s.barrier = Item.PoleLine; a.barrierKind(Item.PoleLine); h.pick('barrier'); h.render(); }, svg('pole_remove', 30)));
    if (cur === 'streetscape' && s.item === Item.Sign) {
      p.options.append(orow(t('v2.row.sign'), select(t('sign.type'), SIGNS.map(([k, key]) => [k, t(key)] as const), s.sign, (v) => { s.sign = Number(v); a.signType(s.sign); h.render(); })));
      p.options.append(orow(t('v2.row.text'), textInput(t(s.sign === 2 ? 'sign.street.placeholder' : s.sign === 0 ? 'sign.text.speed' : 'sign.text'), s.signText, (v) => { s.signText = v; a.signText(v); })));
    }
    if (cur === 'barrier' && s.barrier === Item.PoleLine && !s.itemRemove) {
      p.options.append(orow(t('v2.row.lights'), choices((['none', 'alternate', 'all'] as const).map((m, i) => ({
        label: `${t('pole.lamps')}: ${t(`pole.lamps.${m}`)}`, on: s.poleLights === i, run: () => { s.poleLights = i; a.poleLights(i); h.render(); }, icon: svg(`pl_${m}`, 18),
      })))));
    }
  } else {
    renderPeople(h, p, CLOTHES);
  }
}
/** The landform the relief tab has in hand. */
let landformNow = 'mesa';

function elementRows(h: DrawerHost, p: DrawerParts): void {
  const e = h.s.elements, a = h.a, send = (): void => a.elements({ ...e });
  const icons = { lay: 'brush', eraseKind: 'eraser', eraseAll: 'trash' } as const;
  p.options.append(orow(t('v2.row.brush'), choices((['lay', 'eraseKind', 'eraseAll'] as const).map((m) => ({
    label: t(`el.mode.${m}`), on: e.mode === m, run: () => { e.mode = m; send(); h.render(); }, icon: svg(icons[m], 18),
  })))),
  range(t('terrain.radius'), 5, 400, 5, h.s.radius, (v) => `${v} m`, (v) => { h.s.radius = v; a.radius(v); }),
  range(t('el.density'), 1, 40, 1, e.density, (v) => String(v), (v) => { e.density = v; send(); }),
  range(t('el.size'), 0, 15, 1, e.size, (v) => `${Math.round((0.6 + v / 15) * 100 / 1.07)}%`, (v) => { e.size = v; send(); }));
}

// ------------------------------------------------------------------ transit
const RAIL = { trainTrack: 'Ferrovia dupla', metroTrack: 'Metrô (duplo)' } as const;

export function transitTabOf(tool: Tool, s: ShellState): TransitTab {
  if (tool === 'road') return s.transitTab === 'metroTrack' ? 'metroTrack' : 'trainTrack';
  return s.transitTab === 'trainTrack' || s.transitTab === 'metroTrack' ? 'stop' : s.transitTab;
}

export function renderTransit(h: DrawerHost, p: DrawerParts): void {
  const s = h.s, a = h.a;
  const now = transitTabOf(h.tool(), s);
  const go = (tb: TransitTab): void => {
    s.transitTab = tb;
    if (tb === 'trainTrack' || tb === 'metroTrack') {
      const id = PROFILES.findIndex((x) => x.name === RAIL[tb]);
      if (id >= 0) { a.profile(id); h.catalog.select(id); }
      a.terminal(false);
      h.pick('road');
      return;
    }
    a.terminal(tb === 'terminal');
    a.lineMode(tb === 'trainStation' ? 1 : tb === 'metroStation' ? 2 : 0);
    if (h.tool() !== 'transit') h.pick('transit'); else h.render();
  };
  for (const [tb, key, icon] of [['stop', 'transit.tool.stop', 'tr_stop'], ['terminal', 'transit.tool.terminal', 'tr_terminal'], ['trainTrack', 'transit.tool.trainTrack', 'tr_track'],
    ['trainStation', 'transit.tool.trainStation', 'tr_station'], ['metroTrack', 'transit.tool.metroTrack', 'tr_metro'], ['metroStation', 'transit.tool.metroStation', 'tr_station']] as const) {
    p.tabs.append(tab(t(key), now === tb, () => go(tb), svg(icon, 18)));
  }
  p.tabs.append(tab(t('transit.tool.line'), false, () => { a.newLine(); h.render(); }, svg('tr_line', 18)));
  const { rows, current } = h.lines();
  const items = section(p.strip, t('transit.lines'));
  for (const l of rows) {
    const row = el('div', `v2-transit-line${l.id === current ? ' on' : ''}`);
    const sw = el('i');
    sw.style.background = hex(l.color);
    const name = el('b', '', t('ui.transit.line', { n: l.id }));
    const info = el('span', '', `${t(`transit.mode.${['bus', 'train', 'metro'][l.mode] ?? 'bus'}`)} · ${plural(l.mode ? 'ui.transit.stations' : 'ui.transit.stops', l.stops)} · ${t('ui.transit.perHour', { n: fmtInt(l.perHour) })}`);
    const count = el('span', 'v2-transit-count', String(l.buses));
    count.title = t('transit.vehicles');
    const pickLine = (): void => { a.line(l.id); };
    row.addEventListener('click', (e) => { e.stopPropagation(); pickLine(); h.render(); });
    row.append(sw, name, info,
      button('v2-icon', t('transit.fewer'), () => { pickLine(); a.buses(-1); }, svg('minus', 14)), count,
      button('v2-icon', t('transit.more'), () => { pickLine(); a.buses(1); }, svg('plus', 14)),
      button('v2-icon danger', t('transit.remove'), () => { pickLine(); a.deleteLine(); }, svg('demolish', 14)));
    items.append(row);
  }
  p.strip.append(el('p', 'v2-note', t(`ui.transit.help.${now}`)));
}

// ------------------------------------------------------------------ demolish
export function renderDemolish(h: DrawerHost, p: DrawerParts): void {
  const cur = h.tool(), s = h.s, a = h.a;
  for (const [tool, key, icon] of [['bulldoze', 'tool.bulldoze', 'demolish'], ['pistol', 'actions.pistol', 'actions'], ['bomb', 'actions.bomb', 'bomb']] as const) {
    p.tabs.append(tab(t(key), cur === tool, () => { if (cur !== tool) h.pick(tool); }, svg(icon, 18)));
  }
  if (cur === 'bomb') p.options.append(orow(t('strike.force'), stepper(t('strike.force'), String(s.bomb), (d) => { s.bomb = Math.max(1, Math.min(5, s.bomb + d)); a.bombForce(s.bomb); return String(s.bomb); })));
  p.strip.append(el('p', 'v2-note', t(cur === 'bulldoze' ? 'help.tool.bulldoze' : cur === 'pistol' ? 'help.strike.shoot' : 'help.strike.strike')));
}

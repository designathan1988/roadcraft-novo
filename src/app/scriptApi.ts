// The script API: the same actions as the tools, for photo scripts, in-game checks and tests (the automation API's
// `actions`). Each action builds its command and pushes it on the game's history (one undo step), as the tool does.
// Answers are codes: 'ok', or the refusal ('no road', 'nothing here', 'refused', 'not created', 'not enough money'),
// or the planner's own reason.
import type * as THREE from 'three/webgpu';
import type { CommandStack } from '../core/commands.ts';
import type { JobPool } from '../jobs/pool.ts';
import type { World } from '../world/world.ts';
import type { VehicleRenderer } from '../render/vehicles.ts';
import type { CameraRig } from '../render/cameraRig.ts';
import type { Weather } from '../render/weather.ts';
import type { RiverTool } from '../features/terrain/riverTool.ts';
import type { ItemTool } from '../features/streetscape/itemTool.ts';
import type { RoadTool } from '../features/roads/roadTool.ts';
import type { ZoneTool } from '../features/zones/zoneTool.ts';
import type { TransitTool } from '../features/transit/transitTool.ts';
import type { Transit } from '../world/transit.ts';
import type { Growth } from '../world/growth.ts';
import type { SaveFlow } from './saveFlow.ts';
import type { LotEditing } from './lotEditing.ts';
import type { PersonOptions } from '../shared/contracts/people.ts';
import type { FromSim } from '../sim/worker.ts';
import { PROFILES, profileName } from '../roads/profiles.ts';
import { addCrossing, addUTurn, buildRoad, duplicateRoad, joinAt, moveNode, planRoad, reverseRoad, snap, splitAt } from '../roads/build.ts';
import { heightAt } from '../world/heights.ts';
import { GroundStroke, waterAt } from '../world/ground.ts';
import { ElementStroke } from '../world/items.ts';
import { BrushStroke, LANDFORM_ROCK, landformRockRadius, type BrushMode } from '../world/brush.ts';
import { demolishBox } from '../features/demolition/demolish.ts';
import { lotAt, polygonLot } from '../world/lotEdit.ts';
import { addressAt } from '../roads/streetNames.ts';

export type Manoeuvres = Extract<FromSim, { type: 'manoeuvres' }>;

/** What the script API reads and drives: the game's parts (the lot tool's state is the lot editing's own). */
export interface ScriptApiHost {
  readonly world: World;
  readonly commands: CommandStack;
  readonly pool: JobPool;
  readonly vehicles: VehicleRenderer;
  readonly rig: CameraRig;
  readonly weather: Weather;
  readonly river: RiverTool;
  readonly itemTool: ItemTool;
  readonly roadTool: RoadTool;
  readonly zoneTool: ZoneTool;
  readonly lines: TransitTool;
  readonly transit: Transit;
  readonly growth: Growth;
  readonly saving: SaveFlow;
  readonly editing: LotEditing;
  readonly selected: number;
  toggleFollow(): void;
  setBiome(b: number): void;
  bomb(x: number, z: number): void;
  /** The simulation's running manoeuvres (asked of the worker). */
  manoeuvres(): Promise<Manoeuvres>;
}

const at = (x: number, z: number) => ({ x, z }) as THREE.Vector3;

export function createScriptApi(h: ScriptApiHost) {
  const w = h.world;
  return {
    /** People creator (src/render/people/creator.ts): a group of 1 to 20 at (x, z), with undo; returns the id (0 before loading). */
    people: (x: number, z: number, options: Partial<PersonOptions> = {}) => {
      const c = h.vehicles.people.creator;
      if (!c) return 0;
      c.ground ??= (px: number, pz: number) => heightAt(w.heights, px, pz);
      const cmd = c.placeCommand(x, z, heightAt(w.heights, x, z), options);
      h.commands.run(cmd);
      return cmd.id;
    },
    /** What the creator screen offers (clothes by sex and age, colours, modes, objects); null before loading. */
    peopleCatalog: () => h.vehicles.people.catalog(),
    river: (pts: Array<[number, number]>, width = 14) => h.river.lay(pts, width),
    paint: (x: number, z: number, r: number, kind: number, mode: 'paint' | 'forest' | 'cut' = 'paint', species = 0) => {
      const s = new GroundStroke(w);
      s.dab(x, z, r, mode, kind, 1, 1, species);
      if (s.finish()) h.commands.push(s);
    },
    item: (x: number, z: number, kind: number, variant = 0) => { h.itemTool.item = kind; h.itemTool.sign = variant; h.itemTool.mode = 'streetscape'; h.itemTool.click(at(x, z), false); },
    /** The water's level at (x, z) (NO_WATER where dry). */
    water: (x: number, z: number) => waterAt(w.water, x, z),
    poleLine: (ax: number, az: number, bx: number, bz: number, lights = 0) => h.itemTool.placePoleLine(ax, az, bx, bz, lights),
    /** Drawn lot: front A→B, back out to C. */
    lot: (ax: number, az: number, bx: number, bz: number, cx: number, cz: number, use = 1, floors?: number) => {
      h.editing.lotUse = use;
      h.editing.lotPts = [[ax, az], [bx, bz]];
      h.editing.clickLot(at(cx, cz));
      h.editing.lotPts = null;
      if (floors !== undefined && h.selected >= 0) h.editing.editSelected(floors - w.buildings.cols.floors[h.selected]);
      return h.selected;
    },
    follow: () => { h.toggleFollow(); return !!h.vehicles.follow; },
    /** Lightning strike now (storm photos). */
    strike: () => h.weather.strikeNow(h.rig.eye, heightAt(w.heights, h.rig.eye.x, h.rig.eye.z)),
    biome: (b: number) => h.setBiome(b),
    /** Straight road from (ax, az) to (bx, bz) with the profile by name (or id). */
    road: (ax: number, az: number, bx: number, bz: number, profile: string | number = 0, elevation = 0) => {
      const id = typeof profile === 'number' ? profile : PROFILES.findIndex((p) => p.name === profile || profileName(p) === profile);
      const a = snap(w.roads, ax, az, 10), b = snap(w.roads, bx, bz, 10);
      const plan = planRoad(w, a, null, b, Math.max(0, id), elevation);
      if (!plan.ok) return plan.reason;
      const j = buildRoad(w, plan, a, b, Math.max(0, id), h.roadTool.segFlags());
      const price = j.price;
      if (!j.settle()) return `not enough money: costs ${Math.round(price)}`;
      h.commands.push(j);
      return 'ok';
    },
    zone: (x: number, z: number, r: number, zone: number) => { h.zoneTool.zone = zone; h.zoneTool.radius = r; h.zoneTool.begin(); h.zoneTool.dab(x, z); h.zoneTool.end(); },
    line: (mode: number, stops: number[], vehicles = 2) => {
      h.lines.mode = mode; h.lines.newLine();
      for (let i = 0; i + 1 < stops.length; i += 2) h.lines.click({ x: stops[i], z: stops[i + 1] });
      const l = h.transit.line(h.lines.selected);
      const c = l && h.transit.setBuses(l.id, vehicles);
      if (c) h.commands.run(c);
    },
    grow: async () => { h.growth.processDirty(); await h.pool.whenIdle(); return h.growth.fillAll(); },
    /** Road edits at the point (x, z): split, reverse, duplicate, join (node) and move node to (tx, tz). */
    edit: (what: 'split' | 'reverse' | 'duplicate' | 'join' | 'move', x: number, z: number, tx = 0, tz = 0) => {
      const net = w.roads;
      const s = net.nearestSeg(x, z, 10), n = net.nearestNode(x, z, 10);
      const j = what === 'split' ? (s ? splitAt(w, s[0], s[1]) : null)
        : what === 'reverse' ? (s ? reverseRoad(w, s[0]) : null)
        : what === 'duplicate' ? (s ? duplicateRoad(w, s[0]) : null)
        : what === 'join' ? (n >= 0 ? joinAt(w, n) : null)
        : n >= 0 ? moveNode(w, n, tx, tz) : null;
      if (!j || typeof j === 'string') return j ?? 'nothing here';
      if (j.empty || !j.settle()) return 'refused';
      h.commands.push(j);
      return 'ok';
    },
    /** The save package (what Export downloads) and opening a package (what Open file does). */
    packMap: () => h.saving.pack(),
    openMap: (b: Blob) => h.saving.importMap(b),
    /** One terrain brush stroke (landforms included) at (x, z): relief and the landform's rock in one undo step. */
    terrain: (mode: BrushMode, x: number, z: number, radius = 80, strength = 0.4) => {
      const st = new BrushStroke(w), rk = LANDFORM_ROCK[mode];
      st.dab(x, z, { mode, radius, strength }, 1);
      const g = rk !== undefined ? new GroundStroke(w) : null;
      // the same rock as the tool's dab (D6: the API painted a gully's at 0.95 of the radius, the tool at 0.6)
      if (g && rk !== undefined) g.dab(x, z, landformRockRadius(mode, radius), 'paint', rk, 1, 1);
      if (st.finish()) { if (g?.finish()) h.commands.push({ label: 'cmd.place.terrain', apply: () => { st.apply(); g.apply(); }, invert: () => { g.invert(); st.invert(); } }); else h.commands.push(st); }
    },
    /** Ground elements (kind 30..40) scattered in a circle. */
    elements: (kind: number, x: number, z: number, r = 12, density = 20, size = 7) => {
      const st = new ElementStroke(w.items);
      for (let i = 0; i < 6; i++) st.dab(x, z, r, kind, density, size, 'lay', 1);
      if (!st.cmd.empty) h.commands.push(st.cmd);
      return w.items.size;
    },
    /** Pedestrian crossing mid-road at (x, z): 9 zebra, 10 with traffic lights. */
    crossing: (x: number, z: number, ctl: number) => {
      const s = w.roads.nearestSeg(x, z, 10);
      if (!s) return 'no road';
      const r = addCrossing(w, s[0], s[1], ctl);
      if (typeof r === 'string') return r;
      // settled like every road edit: the split segment's name and junction specs go to its pieces, and it is charged
      if (r.empty || !r.settle()) return 'refused';
      h.commands.push(r);
      return 'ok';
    },
    /** U-turn through the median on the road at (x, z). */
    uturn: (x: number, z: number) => {
      const s = w.roads.nearestSeg(x, z, 10);
      if (!s) return 'no road';
      const r = addUTurn(w, s[0], s[1]);
      if (typeof r === 'string') return r;
      // settled like every road edit: the split segment's name and junction specs go to its pieces, and it is charged
      if (r.empty || !r.settle()) return 'refused';
      h.commands.push(r);
      return 'ok';
    },
    /** Demolish everything in the rectangle. */
    demolish: (x0: number, z0: number, x1: number, z1: number) => { const r = demolishBox(w, x0, z0, x1, z1); if (r) h.commands.push(r.cmd); return r?.count ?? 0; },
    bomb: (x: number, z: number) => { h.bomb(x, z); },
    /** Terrain height at (x, z). */
    ground: (x: number, z: number) => heightAt(w.heights, x, z),
    junction: (x: number, z: number, ctl: number) => { const n = w.roads.nearestNode(x, z, 20); if (n >= 0) w.roads.setJunction(n, { ctl }); },
    /** Polygon lot from flat corners [x0, z0, x1, z1, …] (the first side is the front); returns its id or the refusal. */
    lotPoly: (pts: number[], use = 1) => {
      h.editing.lotUse = use; h.editing.polyPts.length = 0;
      for (let i = 0; i + 1 < pts.length; i += 2) h.editing.polyPts.push([pts[i], pts[i + 1]]);
      const before = w.buildings.end, size = w.buildings.size;
      const r = polygonLot(h.editing.polyPts, w);
      h.editing.finishPoly();
      if (typeof r === 'string') return r;
      if (w.buildings.size === size) return 'not created';
      // the new lot is the last id handed out (or one reused from the free list): find it at its centre
      return lotAt(w, r.x, r.z) >= 0 ? lotAt(w, r.x, r.z) : before;
    },
    /** Split the lot under the line (ax, az)-(bx, bz) along it. */
    lotLine: (ax: number, az: number, bx: number, bz: number) => { h.editing.lotExtra = 'line'; h.editing.lotExtraPts = []; h.editing.clickLotExtra(at(ax, az)); h.editing.clickLotExtra(at(bx, bz)); h.editing.lotExtra = null; },
    /** Curve the side of a lot near (x, z) through (px, pz). */
    lotCurve: (x: number, z: number, px: number, pz: number) => { h.editing.lotExtra = 'curve'; h.editing.lotExtraPts = []; h.editing.clickLotExtra(at(x, z)); h.editing.clickLotExtra(at(px, pz)); h.editing.lotExtra = null; },
    /** Renovate the building at (x, z) (Shift+click). */
    renovate: (x: number, z: number) => h.editing.renovate(lotAt(w, x, z)),
    /** Manoeuvres going on in the simulation (parking, pulling out, trucks at docks, kerb stops), for photos and tests. */
    manoeuvres: () => h.manoeuvres(),
    /** Address (street name and metric number) of the point (x, z), or null away from streets. */
    address: (x: number, z: number) => addressAt(w, x, z),
    /** Advance the city clock by `minutes` (decay and anything else on the city clock). */
    passTime: (minutes: number) => w.advanceClock(minutes),
  };
}

export type ScriptApi = ReturnType<typeof createScriptApi>;

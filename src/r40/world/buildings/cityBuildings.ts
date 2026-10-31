import { m } from '../units.ts';
import { type BlueprintBody, DEFAULT_GROUND_HEIGHT, DEFAULT_STOREY_HEIGHT } from './blueprints.ts';
import type { MaterialSpec } from './materials.ts';
import {
  type BayComponent,
  BUILDING_SCHEMA,
  type BuildingElement,
  type BuildingFunction,
  type BuildingUse,
  type CoreKind,
  type ElementKind,
  type FacadePattern,
  type LotSurface,
  type RoofKind,
  type Side,
  type Storey,
  type Volume,
  DEFAULT_MODULE,
  bayKey,
} from './types.ts';

interface BlockSpec {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly d: number;
  readonly base?: number;
  readonly storeys?: number;
  readonly roof?: RoofKind;
  readonly pitch?: number;
  readonly fill?: BayComponent;
  /** Ground floor fill (the street floor), when it differs. */
  readonly ground?: BayComponent;
  /** The front side's ground bays, by index from the left. */
  readonly door?: number | 'middle';
  readonly doorKind?: BayComponent;
  readonly pattern?: FacadePattern;
  readonly wall?: MaterialSpec;
  readonly roofMaterial?: MaterialSpec;
  readonly shape?: Volume['outline'];
  readonly open?: LotSurface;
}

/** A model being put together, block by block. */
export class Model {
  private readonly volumes: Volume[] = [];
  private readonly elements: BuildingElement[] = [];
  private readonly cores: { x: number; y: number; kind: CoreKind; from: number; to: number }[] = [];
  private storeyHeight = DEFAULT_STOREY_HEIGHT;
  private groundHeight = DEFAULT_GROUND_HEIGHT;
  private materials: BlueprintBody['materials'] = undefined;

  private readonly fn: BuildingFunction;
  private readonly use: BuildingUse;
  private readonly palette: number;
  constructor(fn: BuildingFunction, use: BuildingUse, palette: number) { this.fn = fn; this.use = use; this.palette = palette; }

  heights(ground: number, storey: number): this {
    this.groundHeight = m(ground);
    this.storeyHeight = m(storey);
    return this;
  }

  look(wall: MaterialSpec, roof?: MaterialSpec, trim?: MaterialSpec): this {
    this.materials = { wall, ...(roof ? { roof } : {}), ...(trim ? { trim } : {}) };
    return this;
  }

  block(s: BlockSpec): this {
    const storeys = s.storeys ?? 1;
    const fill = s.fill ?? 'window';
    const across = Math.max(1, Math.round(s.w / 3));
    const doorAt = s.door === 'middle' ? Math.floor(across / 2) : s.door;
    const list: Storey[] = Array.from({ length: storeys }, (_, k) => {
      const level = (s.base ?? 0) + k;
      const facade: Storey['facade'] = { fill: level === 0 && s.ground ? s.ground : fill };
      if (level === 0 && doorAt !== undefined) facade.bays = { [bayKey(0, doorAt)]: s.doorKind ?? 'door' };
      return { facade };
    });
    const v: Volume = {
      id: this.volumes.length + 1,
      x: m(s.x), y: m(s.y), w: m(s.w), d: m(s.d),
      base: s.base ?? 0,
      roof: s.roof ?? 'flat',
      storeys: list,
    };
    if (s.pitch !== undefined) v.pitch = s.pitch;
    if (s.pattern) v.facadePattern = s.pattern;
    if (s.shape) v.outline = s.shape;
    if (s.open) v.open = s.open;
    if (s.wall || s.roofMaterial) v.materials = { ...(s.wall ? { wall: s.wall } : {}), ...(s.roofMaterial ? { roof: s.roofMaterial } : {}) };
    this.volumes.push(v);
    return this;
  }

  /** An open block: a lot of grass, paving, gravel, sand or water. */
  lot(x: number, y: number, w: number, d: number, surface: LotSurface): this {
    return this.block({ x, y, w, d, open: surface, fill: 'wall' });
  }

  el(kind: ElementKind, x: number, y: number, facing: Side = 0, size?: { w?: number; d?: number; h?: number; z?: number; material?: MaterialSpec }): this {
    const defaults: Partial<Record<ElementKind, [number, number, number]>> = {
      tree: [3, 3, 5], bench: [1.6, 0.5, 0.45], planter: [1, 1, 0.5], flowers: [1.4, 1.4, 0.4], rocks: [1.6, 1.6, 0.7],
      fence: [2, 0.12, 1.1], wall: [4, 0.25, 1.8], pavement: [4, 3, 0.12], slab: [4, 4, 0.25], pillar: [0.4, 0.4, 3],
      canopy: [2.4, 1.2, 0.15], parking: [6, 5, 0.12], railing: [2, 0.12, 1.05], clock: [3, 0.25, 3], awning: [3, 1.2, 0.12],
    };
    const [dw, dd, dh] = defaults[kind] ?? [1, 1, 1];
    this.elements.push({
      id: this.elements.length + 1, kind, x: m(x), y: m(y), facing,
      w: m(size?.w ?? dw), d: m(size?.d ?? dd), h: m(size?.h ?? dh), z: m(size?.z ?? 0),
      ...(size?.material ? { material: size.material } : {}),
    });
    return this;
  }

  /** A row of trees (or any part) from (x0,y0) to (x1,y1), `n` of them. */
  row(kind: ElementKind, x0: number, y0: number, x1: number, y1: number, n: number, facing: Side = 0): this {
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      this.el(kind, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, facing);
    }
    return this;
  }

  /** A fence (or wall) all round a rectangle, in pieces. */
  ring(kind: 'fence' | 'wall', x: number, y: number, w: number, d: number, gate = 4): this {
    const piece = 4;
    for (let a = 0; a + piece <= w + 0.01; a += piece) {
      if (Math.abs(a + piece / 2 - w / 2) > gate / 2) this.el(kind, x + a + piece / 2, y, 0, { w: piece });
      this.el(kind, x + a + piece / 2, y + d, 2, { w: piece });
    }
    for (let a = 0; a + piece <= d + 0.01; a += piece) {
      this.el(kind, x, y + a + piece / 2, 3, { w: piece });
      this.el(kind, x + w, y + a + piece / 2, 1, { w: piece });
    }
    return this;
  }

  core(kind: CoreKind, x: number, y: number, to: number): this {
    this.cores.push({ x: m(x), y: m(y), kind, from: 0, to });
    return this;
  }

  build(): BlueprintBody {
    return {
      schema: BUILDING_SCHEMA,
      use: this.use,
      function: this.fn,
      module: DEFAULT_MODULE,
      groundHeight: this.groundHeight,
      storeyHeight: this.storeyHeight,
      palette: this.palette,
      ...(this.materials ? { materials: this.materials } : {}),
      volumes: this.volumes,
      ...(this.elements.length ? { elements: this.elements, nextElementId: this.elements.length + 1 } : {}),
      cores: this.cores.map((c, i) => ({ id: i + 1, ...c })),
      nextVolumeId: this.volumes.length + 1,
    };
  }
}

export const mat = (finish: MaterialSpec['finish'], colour: number): MaterialSpec => ({ finish, colour });
/** A retaining wall's stone, and the flights cut through one (`world/growth/lotPlan.ts` terraces) */
export const RETAINING_STONE = mat('stone', 0x9a948a);
/** Whether a material is the retaining wall's stone. */
export const isRetainingStone = (spec: MaterialSpec | undefined): boolean =>
  spec !== undefined && spec.finish === RETAINING_STONE.finish && spec.colour === RETAINING_STONE.colour;

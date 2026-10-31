import { steadyRatio } from '../../core/scalar.ts';
import { m } from '../units.ts';
import {
  type BayComponent,
  type Building,
  type BuildingUse,
  type Facade,
  type RoofKind,
  type Storey,
  type Volume,
  BUILDING_SCHEMA,
  DEFAULT_MODULE,
  bayKey,
  componentAt,
} from './types.ts';

/** Reusable building definitions: everything a building is except where it stands. */
export type BlueprintBody = Omit<Building, 'id' | 'x' | 'y' | 'rotation'>;

export const DEFAULT_GROUND_HEIGHT = m(3.6);
export const DEFAULT_STOREY_HEIGHT = m(3.1);

/** The default facade of one storey, by use and level. */
function defaultFacade(use: BuildingUse, level: number, width: number, rich = true): Facade {
  const door = Math.floor(width / 2);
  const front: Record<string, BayComponent> = {};
  switch (use) {
    case 'residential':
      if (level === 0) {
        front[bayKey(0, door)] = 'door';
        return { fill: 'window', bays: front };
      }
      return rich && width >= 3 ? { fill: 'window', sides: { 0: 'balcony' } } : { fill: 'window' };
    case 'commercial':
      if (level === 0) {
        front[bayKey(0, door)] = 'door';
        return { fill: 'window', sides: { 0: 'shopfront' }, bays: front };
      }
      return { fill: 'wideWindow' };
    case 'industrial':
      if (level === 0) {
        for (let i = 0; i < width; i += 2) front[bayKey(0, i)] = 'loadingDoor';
        front[bayKey(0, width - 1)] = 'door';
        return { fill: 'wall', sides: { 1: 'window', 3: 'window' }, bays: front };
      }
      return { fill: 'window' };
    case 'mixed':
      return level === 0 ? defaultFacade('commercial', 0, width) : defaultFacade('residential', level, width, rich);
  }
}

/** The use a storey of a building of `use` has at `level`. */
const storeyUse = (use: BuildingUse, level: number): BuildingUse | undefined =>
  use === 'mixed' ? (level === 0 ? 'commercial' : 'residential') : undefined;

function defaultStorey(use: BuildingUse, level: number, width: number): Storey {
  const storey: Storey = { facade: defaultFacade(use, level, width) };
  const own = storeyUse(use, level);
  if (own) storey.use = own;
  return storey;
}

function defaultRoof(use: BuildingUse, storeys: number): RoofKind {
  if (use === 'industrial') return storeys === 1 ? 'sawtooth' : 'flat';
  if (use === 'residential') return storeys <= 3 ? 'gable' : 'flat';
  return 'flat';
}

const DEFAULT_PALETTE: Readonly<Record<BuildingUse, number>> = {
  residential: 0,
  commercial: 2,
  industrial: 7,
  mixed: 3,
};

/** Whole bays along a length, at about one module each. */
const bayCount = (length: number, module: number): number => Math.max(1, Math.round(steadyRatio(length, module)));

/** The parametric generator: a single volume `w x d` world units and `storeys` storeys */
export function generateBody(
  use: BuildingUse,
  w: number,
  d: number,
  storeys: number,
  options: { module?: number; groundHeight?: number; storeyHeight?: number; roof?: RoofKind; palette?: number } = {},
): BlueprintBody {
  const across = bayCount(w, options.module ?? DEFAULT_MODULE);
  const volume: Volume = {
    id: 1,
    x: 0,
    y: 0,
    w,
    d,
    base: 0,
    roof: options.roof ?? defaultRoof(use, storeys),
    storeys: Array.from({ length: storeys }, (_, level) => defaultStorey(use, level, across)),
  };
  return {
    schema: BUILDING_SCHEMA,
    use,
    module: options.module ?? DEFAULT_MODULE,
    groundHeight: options.groundHeight ?? (use === 'industrial' ? m(6) : DEFAULT_GROUND_HEIGHT),
    storeyHeight: options.storeyHeight ?? DEFAULT_STOREY_HEIGHT,
    palette: options.palette ?? DEFAULT_PALETTE[use],
    volumes: [volume],
    cores: [],
    nextVolumeId: 2,
  };
}

/** What an access component becomes on a storey above the street. */
const ABOVE_STREET: Partial<Record<BayComponent, BayComponent>> = {
  door: 'window',
  shopfront: 'wideWindow',
  loadingDoor: 'window',
};

/** A storey for above `source`, in the building's own style rather than a category's: the same facade, with every way in */
export function upperStoreyFrom(source: Storey): Storey {
  const lift = (c: BayComponent): BayComponent => ABOVE_STREET[c] ?? c;
  const facade: Facade = { fill: lift(source.facade.fill) };
  if (source.facade.pattern) facade.pattern = source.facade.pattern;
  if (source.facade.patterns) facade.patterns = { ...source.facade.patterns };
  if (source.facade.sides) {
    facade.sides = Object.fromEntries(Object.entries(source.facade.sides).map(([k, c]) => [k, lift(c ?? facade.fill)]));
  }
  if (source.facade.bays) {
    // A single-bay override that now says what its side says anyway is dropped.
    const kept = Object.entries(source.facade.bays)
      .map(([key, c]) => [key, lift(c)] as const)
      .filter(([key, c]) => c !== componentAt({ ...facade, bays: {} }, Number(key.split(':')[0]), 0));
    if (kept.length > 0) facade.bays = Object.fromEntries(kept);
  }
  const storey: Storey = { facade };
  if (source.use) storey.use = source.use;
  if (source.materials) storey.materials = structuredClone(source.materials);
  return storey;
}

/** The neutral starting block: no category, just a mass of `w x d` units and `storeys` storeys with windows all round */
export function generateBlock(
  w: number,
  d: number,
  storeys: number,
  options: { module?: number; groundHeight?: number; storeyHeight?: number; roof?: RoofKind; palette?: number } = {},
): BlueprintBody {
  const across = bayCount(w, options.module ?? DEFAULT_MODULE);
  const ground: Storey = { facade: { fill: 'window', bays: { [bayKey(0, Math.floor(across / 2))]: 'door' } } };
  const volume: Volume = {
    id: 1,
    x: 0,
    y: 0,
    w,
    d,
    base: 0,
    roof: options.roof ?? 'flat',
    storeys: Array.from({ length: storeys }, (_, level) => (level === 0 ? ground : upperStoreyFrom(ground))),
  };
  return {
    schema: BUILDING_SCHEMA,
    use: 'mixed',
    module: options.module ?? DEFAULT_MODULE,
    groundHeight: options.groundHeight ?? DEFAULT_GROUND_HEIGHT,
    storeyHeight: options.storeyHeight ?? DEFAULT_STOREY_HEIGHT,
    palette: options.palette ?? 4,
    volumes: [volume],
    cores: [],
    nextVolumeId: 2,
  };
}

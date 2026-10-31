// The road in hand varied by the road tool's options (Roadcraft 4.0: lanes 2/4/6 or with a median, main.ts:1489-1512;
// total width on whole metres, ui/v2/shell.ts:1251-1258 and world/roadSection.ts:246-259 sectionForWidth; the parking a
// new road is drawn with, editor/roadParking.ts:4-46). Pure: the tool registers what it returns.

import { PROFILES, registerProfile, type Profile, type Strip } from './profiles.ts';
import { fromWork, toWork } from './profileWork.ts';

export type LaneChoice = 2 | 4 | 6 | 'median';
export const LANE_CHOICES: readonly LaneChoice[] = [2, 4, 6, 'median'];
export const PARKING_PRESETS = ['none', 'parallel', 'parallelRight', 'parallelLeft', 'cycle', 'cycleParking'] as const;
export type ParkingPreset = (typeof PARKING_PRESETS)[number];

export interface RoadOptions {
  /** Lanes both ways together (one-way: all of them), or the same lanes with a median between the directions; null: the road's own. */
  lanes: LaneChoice | null;
  /** Total width (m); null: the road's own. */
  width: number | null;
  /** Parking at the kerbs; null: the road's own. */
  parking: ParkingPreset | null;
}

const MEDIAN = 3;
const kerbBand = (s: Strip | undefined): boolean => s?.kind === 'parking' || s?.kind === 'bike';

/** The editor's strips (left to right seen from A to B) split into: left edge, lanes towards A, middle, lanes towards B, right edge. */
function parts(work: Strip[]): { left: Strip[]; back: Strip[]; mid: Strip[]; fwd: Strip[]; right: Strip[] } {
  const lane = (s: Strip) => s.kind === 'lane';
  const first = work.findIndex(lane), last = work.map(lane).lastIndexOf(true);
  if (first < 0) return { left: work, back: [], mid: [], fwd: [], right: [] };
  const inner = work.slice(first, last + 1);
  const firstFwd = inner.findIndex((s) => lane(s) && (s.dir ?? 1) === 1);
  const lastBack = inner.map((s) => lane(s) && s.dir === -1).lastIndexOf(true);
  const back = firstFwd < 0 ? inner : inner.slice(0, lastBack + 1).filter(lane);
  const fwd = firstFwd < 0 ? [] : inner.slice(firstFwd).filter(lane);
  const mid = firstFwd < 0 || lastBack < 0 ? [] : inner.slice(lastBack + 1, firstFwd);
  return { left: work.slice(0, first), back: firstFwd < 0 ? inner.filter(lane) : back, mid, fwd: lastBack < 0 && firstFwd >= 0 ? inner.filter(lane) : fwd, right: work.slice(last + 1) };
}

/** The road `p` with the tool's options applied (the road unchanged when an option does not fit it: rails, rings). */
export function variantOf(p: Omit<Profile, 'id'>, o: RoadOptions): Omit<Profile, 'id'> {
  if (p.ring || p.strips.some((s) => s.rail)) return p;
  let work = toWork(p);
  let { left, back, mid, fwd, right } = parts(work);
  const oneWay = back.length === 0 || fwd.length === 0;
  if (o.lanes !== null) {
    const template = (dir: 1 | -1): Strip => {
      const like = (dir === 1 ? fwd : back)[0] ?? fwd[0] ?? back[0];
      return { kind: 'lane', width: like?.width ?? 3.2, dir };
    };
    if (o.lanes === 'median') {
      if (!oneWay && !mid.some((s) => s.kind === 'median' && !s.flush)) mid = [{ kind: 'median', width: MEDIAN }];
    } else if (oneWay) {
      const dir: 1 | -1 = fwd.length ? 1 : -1;
      const n = Math.max(1, o.lanes / 2);
      const lanes = Array.from({ length: n }, () => template(dir));
      if (dir === 1) fwd = lanes; else back = lanes;
    } else {
      const n = o.lanes / 2;
      back = Array.from({ length: n }, () => template(-1));
      fwd = Array.from({ length: n }, () => template(1));
    }
  }
  if (o.parking !== null && (p.priority ?? 0) < 4) {
    // the kerb bands go, then the preset's come right inside the sidewalks (4.0 roadParking.ts:30-46)
    while (kerbBand(left[left.length - 1])) left.pop();
    while (kerbBand(right[0])) right.shift();
    const park: Strip = { kind: 'parking', width: 2.3 }, bike: Strip = { kind: 'bike', width: 1.6 };
    const [l, r] = o.parking === 'parallel' ? [park, park] : o.parking === 'parallelLeft' ? [park, null] : o.parking === 'parallelRight' ? [null, park]
      : o.parking === 'cycle' ? [bike, bike] : o.parking === 'cycleParking' ? [park, bike] : [null, null];
    if (l) left.push({ ...l });
    if (r) right.unshift({ ...r });
  }
  work = [...left, ...back, ...mid, ...fwd, ...right];
  let out = fromWork(p, work);
  if (o.width !== null) out = withTotalWidth(out, o.width);
  return out;
}

/** The road made `metres` wide: the lanes share what the fixed strips leave, within 2.5..4.5 m, the sidewalks the rest
 *  within 1..12 m (4.0 world/roadSection.ts:246-259 sectionForWidth). */
export function withTotalWidth(p: Omit<Profile, 'id'>, metres: number): Omit<Profile, 'id'> {
  const lanes = p.strips.filter((s) => s.kind === 'lane'), walks = p.strips.filter((s) => s.kind === 'sidewalk');
  if (!lanes.length) return p;
  const total = Math.round(metres);
  const fixed = p.strips.reduce((s, x) => s + (x.kind === 'lane' || x.kind === 'sidewalk' ? 0 : x.width), 0);
  let walk = walks.length ? walks[0].width : 0;
  let lane = (total - fixed - walks.length * walk) / lanes.length;
  if (lane < 2.5 || lane > 4.5) {
    lane = Math.max(2.5, Math.min(4.5, lane));
    if (walks.length) walk = Math.max(1, Math.min(12, (total - fixed - lanes.length * lane) / walks.length));
  }
  const r = (v: number) => Math.round(v * 10) / 10;
  return { ...p, strips: p.strips.map((s) => (s.kind === 'lane' ? { ...s, width: r(lane) } : s.kind === 'sidewalk' ? { ...s, width: r(walk) } : s)) };
}

/** The road's own lane count both ways (what the lane choice shows lit with no choice made). */
export function laneCount(p: Omit<Profile, 'id'>): number { return p.strips.filter((s) => s.kind === 'lane').length; }

/** Registers the variant of profile `id` (deduplicated by its section), marked as made from `id`; −1 when full. */
export function registerVariant(id: number, o: RoadOptions): number {
  const p = PROFILES[id];
  if (!p || (o.lanes === null && o.width === null && o.parking === null)) return id;
  const v = variantOf(p, o);
  if (v === p) return id;
  return registerProfile({ ...v, name: p.name, custom: true, category: p.category, variantOf: p.variantOf ?? id });
}

/** Roadcraft 4.0's road classes (world/roadTypes.ts:99-209: local, urban, avenue, boulevard, highway, ramp) as this
 *  engine's roads, with their names' keys: the cards of the Upgrade tool (ui/v2/shell.ts:1308-1314). */
export const ROAD_CLASSES: ReadonlyArray<readonly [string, string]> = [
  ['profile.localStreet', 'road.local'], ['profile.urbanStreet', 'road.urban'], ['profile.avenue', 'road.avenue'], ['profile.boulevard', 'road.boulevard'],
  ['profile.highway6Lanes', 'road.highway'], ['profile.ramp', 'road.ramp'],
];

/** The class cards' profiles: [id, name key] for those this engine has. */
export function roadClasses(): Array<[number, string]> {
  return ROAD_CLASSES.map(([name, key]) => [PROFILES.findIndex((p) => p?.name === name), key] as [number, string]).filter(([id]) => id >= 0);
}

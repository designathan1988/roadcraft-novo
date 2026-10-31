// Building heights: the cheap estimate from the record (camera and collapse) and the catalog level arithmetic. Pure
// data and a small cache; no mesh, no generator pass.

import { ArchId, ARCHES, Fn, pickArch } from '../../world/arch.ts';
import { CAT_UNIT, catalogProjects } from '../../world/catalog.ts';
import { CIVIC_DESIGNS, decodeDesign, hasDesign } from '../../world/design.ts';
import { Zone, zoneDensity } from '../../roads/zones.ts';
import { volumes40, type Lot40 } from '../building40.ts';

/** Zones whose buildings are the Roadcraft 4.0 ones near the camera (jobs/building40.ts). */
export const R40_ZONES = new Set<number>([Zone.Residential, Zone.ResLow, Zone.ResHigh, Zone.Commercial, Zone.ComLow, Zone.ComHigh, Zone.Mixed]);

/** Height of the civic buildings' tallest walls (m), by function (the shapes in civic()). */
const CIVIC_TOP: number[] = [];
CIVIC_TOP[Fn.School] = 10.8; CIVIC_TOP[Fn.Church] = 20; CIVIC_TOP[Fn.Hospital] = 36; CIVIC_TOP[Fn.Clinic] = 7.2;
CIVIC_TOP[Fn.Square] = 2.4; CIVIC_TOP[Fn.Park] = 1; CIVIC_TOP[Fn.GasStation] = 6; CIVIC_TOP[Fn.Supermarket] = 7;
CIVIC_TOP[Fn.CityHall] = 13.6; CIVIC_TOP[Fn.Police] = 8; CIVIC_TOP[Fn.FireStation] = 18; CIVIC_TOP[Fn.Mall] = 14;
CIVIC_TOP[Fn.SportsCourt] = 4; CIVIC_TOP[Fn.Cemetery] = 5; CIVIC_TOP[Fn.Playground] = 2.4;

/**
 * How high a building's walls rise above its ground storey (m), from the record alone, by the generator's storey
 * rules (style, shop ground storey, design, catalog project, civic shape). Cheap: for the camera and the collapse,
 * which ask every frame or for many buildings; the inside view takes the exact layout (buildingVolumes).
 */
export interface HeightRec { x: Float32Array; z: Float32Array; w: Float32Array; d: Float32Array; rot: Float32Array; zone: Uint8Array; floors: Uint8Array; seed: Uint32Array; style: Uint8Array; fn: Uint8Array; color: Uint32Array; h: Float32Array; shapeN?: Uint8Array }
const walls40Top = new Map<string, number>();
/** Built wall height for a record: the 4.0's own volumes where it draws the building, the old estimate otherwise. */
export function wallsHeightOf(b: HeightRec, i: number): number {
  const zone = b.zone[i];
  if (R40_ZONES.has(zone) && !b.fn[i] && !hasDesign(b.color[i]) && !b.shapeN?.[i]) {
    // the effective seed and the exact size: what volumes40 reads (D65: seed 0 and a rounded size made different
    // buildings share one height)
    const seed = b.seed[i] || i + 1;
    const key = seed + '|' + zone + '|' + b.floors[i] + '|' + b.w[i] + 'x' + b.d[i];
    let top = walls40Top.get(key);
    if (top === undefined) {
      const dens = zoneDensity(zone);
      const use = zone === Zone.Commercial || zone === Zone.ComLow || zone === Zone.ComHigh || zone === Zone.Mixed ? 'commercial' : 'residential';
      const density = dens === 0 || (use === 'residential' && b.floors[i] <= 2) ? 'low' : dens === 2 || (use === 'commercial' && b.floors[i] >= 8) ? 'high' : 'medium';
      const lot: Lot40 = { cx: b.x[i], cz: b.z[i], W: b.w[i], D: b.d[i], rot: b.rot[i], use, density, seed, groundAt: () => 0 };
      top = Math.max(0, ...volumes40(lot).map((v) => v.y1));
      if (walls40Top.size > 4096) walls40Top.clear();
      walls40Top.set(key, top);
    }
    return top;
  }
  return wallsHeight(zone, b.floors[i], b.x[i], b.z[i], b.style[i], b.fn[i], b.color[i], b.h[i]);
}

export function wallsHeight(zone: number, floors: number, x: number, z: number, style: number, fn: number, color: number, h: number): number {
  const fl = Math.max(1, floors);
  if (hasDesign(color)) {
    const ds = decodeDesign(color, h), e = ds.catalog ? catalogProjects()[ds.catalog - 1] : undefined;
    if (e) return (e.groundHeight + (catalogLevels(e, fl)[1] - 1) * e.storeyHeight) * CAT_UNIT;
    return fl * (ds.finish === 2 ? 3.6 : 3.2);
  }
  if (CIVIC_DESIGNS[fn]) { const [ds, minF] = CIVIC_DESIGNS[fn]; return Math.max(minF, Math.min(fl, minF * 2)) * (ds.finish === 2 ? 3.6 : 3.2); }
  if (fn) return CIVIC_TOP[fn] ?? 3.6 * fl;
  if (zone === Zone.Industrial) return 6 + fl * 2.5 + 2;
  const arch = pickArch(zone, fl, x, z, style), a = ARCHES[arch];
  if (arch >= ArchId.ColonialHouse && arch <= ArchId.Sobrado) return (arch === ArchId.Sobrado ? Math.max(2, fl) : fl) * a.floorH + 0.2;
  const shop = zone === Zone.Commercial || zone === Zone.Mixed;
  return (shop ? 4.4 : a.floorH) + (fl - 1) * a.floorH;
}

/**
 * Levels of a project drawn for a record of `floors` storeys: [the project's top level, the drawn top level]. The
 * volumes that reach the top grow (or shrink) by the difference; never below the podiums (the other volumes' tops).
 */
export function catalogLevels(p: { volumes: Array<{ open: number; base: number; storeys: unknown[] }> }, floors: number): [number, number] {
  let top = 0, podium = 1;
  for (const v of p.volumes) if (v.open < 0) top = Math.max(top, v.base + v.storeys.length);
  for (const v of p.volumes) if (v.open < 0 && v.base + v.storeys.length < top) podium = Math.max(podium, v.base + v.storeys.length + 1);
  return [top, Math.max(podium, floors > 0 ? floors : top)];
}

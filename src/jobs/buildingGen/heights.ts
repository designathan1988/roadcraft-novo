// Building heights: the cheap estimate from the record (camera and collapse) and the catalog level arithmetic. Pure
// data and a small cache; no mesh, no generator pass.

import { ArchId, ARCHES, Fn, pickArch } from '../../world/arch.ts';
import { CAT_UNIT, catalogProjects } from '../../world/catalog.ts';
import { CIVIC_DESIGNS, decodeDesign, hasDesign } from '../../world/design.ts';
import { Zone } from '../../roads/zones.ts';

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
export interface HeightRec { x: Float32Array; z: Float32Array; w: Float32Array; d: Float32Array; rot: Float32Array; zone: Uint8Array; floors: Uint8Array; seed: Uint32Array; style: Uint8Array; fn: Uint8Array; color: Uint32Array; h: Float32Array; shapeN?: Uint8Array; top?: Float32Array }
/**
 * Built wall height for a record: the height the worker that meshed its cell built it to (the `top` column,
 * World.setBuiltTops), the estimate from the record until then. DO NOT generate the building here to read its height:
 * the page ran the whole 4.0 lot plan, massing and yard per building asked (a blast, the camera), and kept a string
 * key per call (2026-10-31).
 */
export function wallsHeightOf(b: HeightRec, i: number): number {
  const top = b.top?.[i] ?? 0;
  if (top > 0) return top;
  return wallsHeight(b.zone[i], b.floors[i], b.x[i], b.z[i], b.style[i], b.fn[i], b.color[i], b.h[i]);
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

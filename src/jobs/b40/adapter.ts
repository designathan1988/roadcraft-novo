// Temporary bridge between the b40 SoA body and the 4.0 `Building` record the r40 emitter still reads.
// `toBuilding40` builds the object graph for r40/render; `fromBuilding40` fills the table from a record (the
// differential tests use both directions). Both disappear with src/r40 at the end of the rewrite.
import { BUILDING_SCHEMA } from '../../r40/api.ts';
import type {
  Building, RoofKind, Volume, Storey, Facade, Core, BuildingElement, MaterialSpec, VolumeMaterials,
  FacadeGeometry, Relief, VolumeDress, BuildingUse, BuildingFunction, LotSurface, BlockMode,
} from '../../r40/api.ts';
import { FINISH_KEYS } from '../../shared/finishes.ts';
import {
  B40_BAY_NAME, B40_CORE_NAME, B40_CROWN_NAME, B40_ELEMENT_NAME, B40_LINES_NAME, B40_PATTERN_NAME, B40_ROOF_NAME,
  B40_SURFACE_NAME, B40_USE_NAME,
} from '../../world/b40Kinds.ts';
import { MAX_BAYS, MAX_SIDES, MAX_STOREYS, type B40Table } from './volumes.ts';

const NONE = -1;
const UNSET = 255;
const MODE_NAME = ['union', 'void', 'intersect', 'xor'] as const;

const finishName = (id: number): MaterialSpec['finish'] => (FINISH_KEYS[id - 1] ?? 'plaster') as MaterialSpec['finish'];
const finishId = (name: string): number => FINISH_KEYS.indexOf(name as (typeof FINISH_KEYS)[number]) + 1;

function matOf(t: B40Table, ref: number): MaterialSpec | undefined {
  if (ref < 0) return undefined;
  return { finish: finishName(t.matFinish[ref]!), colour: t.matColour[ref]! };
}

const matRef = (t: B40Table, spec: MaterialSpec): number => t.material({ finish: finishId(spec.finish), colour: spec.colour });

/** The 4.0 record of a b40 body, for the r40 emitter (temporary). */
export function toBuilding40(t: B40Table, id: number, x: number, y: number, rotation: number): Building {
  const volumes: Volume[] = [];
  for (let v = 0; v < t.n; v++) {
    const storeys: Storey[] = [];
    const count = t.storeys[v]!;
    for (let k = 0; k < count; k++) {
      const fill = t.fillOf(v, k);
      const bays: Record<string, string> = {};
      for (let side = 0; side < MAX_SIDES; side++) {
        for (let i = 0; i < MAX_BAYS; i++) {
          const code = t.bay(v, k, side, i);
          if (code !== UNSET) bays[`${side}:${i}`] = B40_BAY_NAME[code]!;
        }
      }
      const sides: Record<number, string> = {};
      const patterns: Record<number, string> = {};
      for (let side = 0; side < MAX_SIDES; side++) {
        const at = (v * MAX_STOREYS + k) * MAX_SIDES + side;
        const sf = t.sideFill[at]!, sp = t.sidePattern[at]!;
        if (sf >= 0) sides[side] = B40_BAY_NAME[sf]!;
        if (sp >= 0) patterns[side] = B40_PATTERN_NAME[sp]!;
      }
      const materials: Record<number, MaterialSpec> = {};
      for (let side = 0; side < MAX_SIDES; side++) {
        const m = matOf(t, t.storeySideMat[(v * MAX_STOREYS + k) * MAX_SIDES + side]!);
        if (m) materials[side] = m;
      }
      const facade = {
        fill: B40_BAY_NAME[fill]!,
        ...(t.storeyPattern[v * MAX_STOREYS + k]! >= 0 ? { pattern: B40_PATTERN_NAME[t.storeyPattern[v * MAX_STOREYS + k]!] } : {}),
        ...(Object.keys(patterns).length ? { patterns: patterns as Facade['patterns'] } : {}),
        ...(Object.keys(sides).length ? { sides: sides as Facade['sides'] } : {}),
        ...(Object.keys(bays).length ? { bays: bays as Facade['bays'] } : {}),
      } as Facade;
      const useCode = t.storeyUse[v * MAX_STOREYS + k]!;
      storeys.push({
        facade,
        ...(useCode >= 0 ? { use: B40_USE_NAME[useCode] as BuildingUse } : {}),
        ...(Object.keys(materials).length ? { materials } : {}),
      });
    }

    const outline = t.outlineN[v]! > 0
      ? Array.from({ length: t.outlineN[v]! }, (_, i) => ({ x: t.outline[t.outlineAt[v]! + i * 2]!, y: t.outline[t.outlineAt[v]! + i * 2 + 1]! }))
      : undefined;
    const facadeGeometry: Partial<Record<number, FacadeGeometry>> = {};
    for (let side = 0; side < MAX_SIDES; side++) {
      const at = v * MAX_SIDES + side;
      if (t.fgBays[at]! < 0) continue;
      facadeGeometry[side] = {
        bays: t.fgBays[at]!,
        windowWidth: t.fgWindowW[at]!,
        windowHeight: t.fgWindowH[at]!,
        sill: t.fgSill[at]!,
        ...(Number.isFinite(t.fgPierW[at]) ? { pierWidth: t.fgPierW[at]!, pierDepth: t.fgPierD[at]!, pierEvery: t.fgPierEvery[at]! } : {}),
      };
    }
    const reliefs: Relief[] = [];
    if (t.reliefStart[v]! >= 0) {
      for (let r = t.reliefStart[v]!, e = r + t.reliefCount[v]!; r < e; r++) {
        reliefs.push({ side: t.reliefSide[r]!, bay0: t.reliefBay0[r]!, bay1: t.reliefBay1[r]!, storey0: t.reliefStorey0[r]!, storey1: t.reliefStorey1[r]!, depth: t.reliefDepth[r]! });
      }
    }
    const dress: VolumeDress | undefined = t.dressLines[v]! >= 0 || t.dressCrown[v]! >= 0
      ? {
        ...(t.dressLines[v]! >= 0 ? { lines: B40_LINES_NAME[t.dressLines[v]!] } : {}),
        ...(t.dressCrown[v]! >= 0 ? { crown: B40_CROWN_NAME[t.dressCrown[v]!] } : {}),
      }
      : undefined;
    const materials: VolumeMaterials = {
      ...(t.wallMat[v]! >= 0 ? { wall: matOf(t, t.wallMat[v]!) } : {}),
      ...(t.roofMat[v]! >= 0 ? { roof: matOf(t, t.roofMat[v]!) } : {}),
    };
    const volume: Volume = {
      id: v + 1,
      x: t.x[v]!, y: t.y[v]!, w: t.w[v]!, d: t.d[v]!,
      base: t.base[v]!,
      roof: B40_ROOF_NAME[t.roof[v]!] as RoofKind,
      storeys,
      ...(outline ? { outline } : {}),
      ...(t.pattern[v]! >= 0 ? { facadePattern: B40_PATTERN_NAME[t.pattern[v]!] } : {}),
      ...(Object.keys(facadeGeometry).length ? { facadeGeometry } : {}),
      ...(Object.keys(materials).length ? { materials } : {}),
      ...(reliefs.length ? { reliefs } : {}),
      ...(dress ? { dress } : {}),
      ...(Number.isFinite(t.pitch[v]) ? { pitch: t.pitch[v]! } : {}),
      ...(t.ridge[v]! >= 0 ? { ridge: t.ridge[v]! === 0 ? 'x' as const : 'y' as const } : {}),
      ...(t.fall[v]! >= 0 ? { fall: t.fall[v] as 0 | 1 | 2 | 3 } : {}),
      ...(t.open[v]! >= 0 ? { open: B40_SURFACE_NAME[t.open[v]!] as LotSurface } : {}),
      ...(t.mode[v]! > 0 ? { mode: MODE_NAME[t.mode[v]!] as BlockMode } : {}),
      ...(Number.isFinite(t.terrace[v]) ? { terrace: t.terrace[v]! } : {}),
      ...(Number.isFinite(t.ramp[v]) ? { ramp: t.ramp[v]! } : {}),
      ...(Number.isFinite(t.lift[v]) ? { lift: t.lift[v]! } : {}),
    };
    volumes.push(volume);
  }

  const cores: Core[] = [];
  for (let c = 0; c < t.coreN; c++) {
    cores.push({ id: c + 1, x: t.coreX[c]!, y: t.coreY[c]!, kind: B40_CORE_NAME[t.coreKind[c]!] as Core['kind'], from: t.coreFrom[c]!, to: t.coreTo[c]! });
  }
  const elements: BuildingElement[] = [];
  for (let e = 0; e < t.elN; e++) {
    elements.push({
      id: e + 1, kind: B40_ELEMENT_NAME[t.elKind[e]!] as BuildingElement['kind'],
      x: t.elX[e]!, y: t.elY[e]!, facing: t.elFacing[e] as 0 | 1 | 2 | 3,
      w: t.elW[e]!, d: t.elD[e]!, z: t.elZ[e]!, h: t.elH[e]!,
      ...(Number.isFinite(t.elAngle[e]) ? { angle: t.elAngle[e]! } : {}),
      ...(t.elMat[e]! >= 0 ? { material: matOf(t, t.elMat[e]!) } : {}),
    });
  }
  const bm = {
    ...(matOf(t, t.wallRef) ? { wall: matOf(t, t.wallRef) } : {}),
    ...(matOf(t, t.roofRef) ? { roof: matOf(t, t.roofRef) } : {}),
    ...(matOf(t, t.trimRef) ? { trim: matOf(t, t.trimRef) } : {}),
    ...(matOf(t, t.plinthRef) ? { plinth: matOf(t, t.plinthRef) } : {}),
  };
  return {
    id: id as Building['id'],
    schema: BUILDING_SCHEMA,
    x, y, rotation,
    use: B40_USE_NAME[t.use] as BuildingUse,
    module: t.module,
    groundHeight: t.groundHeight,
    storeyHeight: t.storeyHeight,
    palette: t.palette,
    ...(Object.keys(bm).length ? { materials: bm } : {}),
    volumes,
    ...(elements.length ? { elements, nextElementId: elements.length + 1 } : {}),
    cores,
    ...(t.functionName ? { function: t.functionName as BuildingFunction } : {}),
    nextVolumeId: volumes.length + 1,
  };
}

/** Fills a b40 table from a 4.0 record (the differential tests and the transition). */
export function fromBuilding40(t: B40Table, b: Building): void {
  t.clear();
  t.use = Math.max(0, B40_USE_NAME.indexOf(b.use as (typeof B40_USE_NAME)[number]));
  t.functionName = b.function ?? '';
  t.palette = b.palette;
  t.module = b.module;
  t.groundHeight = b.groundHeight;
  t.storeyHeight = b.storeyHeight;
  if (b.materials?.wall) t.wallRef = matRef(t, b.materials.wall);
  if (b.materials?.roof) t.roofRef = matRef(t, b.materials.roof);
  if (b.materials?.trim) t.trimRef = matRef(t, b.materials.trim);
  if (b.materials?.plinth) t.plinthRef = matRef(t, b.materials.plinth);

  for (const v of b.volumes) {
    const vi = t.n++;
    t.x[vi] = v.x; t.y[vi] = v.y; t.w[vi] = v.w; t.d[vi] = v.d;
    t.base[vi] = v.base; t.storeys[vi] = v.storeys.length;
    t.roof[vi] = Math.max(0, B40_ROOF_NAME.indexOf(v.roof as (typeof B40_ROOF_NAME)[number]));
    if (v.pitch !== undefined) t.pitch[vi] = v.pitch;
    if (v.ridge) t.ridge[vi] = v.ridge === 'x' ? 0 : 1;
    if (v.fall !== undefined) t.fall[vi] = v.fall;
    if (v.open !== undefined) t.open[vi] = Math.max(0, B40_SURFACE_NAME.indexOf(v.open as (typeof B40_SURFACE_NAME)[number]));
    if (v.mode) t.mode[vi] = Math.max(1, MODE_NAME.indexOf(v.mode));
    if (v.terrace !== undefined) t.terrace[vi] = v.terrace;
    if (v.ramp !== undefined) t.ramp[vi] = v.ramp;
    if (v.lift !== undefined) t.lift[vi] = v.lift;
    if (v.facadePattern) t.pattern[vi] = Math.max(0, B40_PATTERN_NAME.indexOf(v.facadePattern as (typeof B40_PATTERN_NAME)[number]));
    if (v.materials?.wall) t.wallMat[vi] = matRef(t, v.materials.wall);
    if (v.materials?.roof) t.roofMat[vi] = matRef(t, v.materials.roof);
    if (v.outline) {
      const at = t.outlineUsed;
      for (let i = 0; i < v.outline.length; i++) { t.outline[at + i * 2] = v.outline[i]!.x; t.outline[at + i * 2 + 1] = v.outline[i]!.y; }
      t.outlineAt[vi] = at; t.outlineN[vi] = v.outline.length; t.outlineUsed = at + v.outline.length * 2;
    }
    if (v.dress?.lines) t.dressLines[vi] = Math.max(0, B40_LINES_NAME.indexOf(v.dress.lines));
    if (v.dress?.crown) t.dressCrown[vi] = Math.max(0, B40_CROWN_NAME.indexOf(v.dress.crown));
    for (let side = 0; side < MAX_SIDES; side++) {
      const g = v.facadeGeometry?.[side];
      if (g) t.setFacadeGeometry(vi, side, g.bays ?? 0, g.windowWidth ?? NaN, g.windowHeight ?? NaN, g.sill ?? NaN, g.pierWidth ?? NaN, g.pierDepth ?? NaN, g.pierEvery ?? NONE);
    }
    for (const r of v.reliefs ?? []) t.addRelief(vi, r.side, r.bay0, r.bay1, r.storey0, r.storey1, r.depth);
    v.storeys.forEach((s, k) => {
      t.fill[vi * MAX_STOREYS + k] = Math.max(0, B40_BAY_NAME.indexOf(s.facade.fill as (typeof B40_BAY_NAME)[number]));
      if (s.facade.pattern) t.storeyPattern[vi * MAX_STOREYS + k] = Math.max(0, B40_PATTERN_NAME.indexOf(s.facade.pattern as (typeof B40_PATTERN_NAME)[number]));
      if (s.use) t.storeyUse[vi * MAX_STOREYS + k] = Math.max(0, B40_USE_NAME.indexOf(s.use as (typeof B40_USE_NAME)[number]));
      for (const [side, code] of Object.entries(s.facade.sides ?? {})) t.setSide(vi, k, Number(side), Math.max(0, B40_BAY_NAME.indexOf(code as (typeof B40_BAY_NAME)[number])), NONE);
      for (const [side, code] of Object.entries(s.facade.patterns ?? {})) t.setSide(vi, k, Number(side), NONE, Math.max(0, B40_PATTERN_NAME.indexOf(code as (typeof B40_PATTERN_NAME)[number])));
      for (const [key, code] of Object.entries(s.facade.bays ?? {})) {
        const [side, bay] = key.split(':').map(Number);
        t.setBay(vi, k, side!, bay!, Math.max(0, B40_BAY_NAME.indexOf(code as (typeof B40_BAY_NAME)[number])));
      }
      for (const [side, spec] of Object.entries(s.materials ?? {})) if (spec) t.setStoreyMaterial(vi, k, Number(side), matRef(t, spec));
    });
  }

  for (const c of b.cores) {
    const ci = t.coreN++;
    t.coreKind[ci] = Math.max(0, B40_CORE_NAME.indexOf(c.kind as (typeof B40_CORE_NAME)[number]));
    t.coreX[ci] = c.x; t.coreY[ci] = c.y; t.coreFrom[ci] = c.from; t.coreTo[ci] = c.to;
  }
  for (const e of b.elements ?? []) {
    const ei = t.elN++;
    t.elKind[ei] = Math.max(0, B40_ELEMENT_NAME.indexOf(e.kind as (typeof B40_ELEMENT_NAME)[number]));
    t.elX[ei] = e.x; t.elY[ei] = e.y; t.elW[ei] = e.w; t.elD[ei] = e.d; t.elZ[ei] = e.z; t.elH[ei] = e.h;
    t.elFacing[ei] = e.facing;
    if (e.angle !== undefined) t.elAngle[ei] = e.angle;
    if (e.material) t.elMat[ei] = matRef(t, e.material);
  }
}

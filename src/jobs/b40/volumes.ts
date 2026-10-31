// The b40 building body: one SoA table per lot. Blocks, their storeys' facade fills and per-bay overrides,
// facade geometry, materials, reliefs, outlines, cores and free parts are typed columns; the generator writes
// codes into them and the emitters read codes out. No object per volume, storey or bay.
import { B40_BAY, B40_ELEMENT, B40_ROOF, B40_USE } from '../../world/b40Kinds.ts';
import type { B40Paint } from '../../world/b40Styles.ts';

export const MAX_VOLUMES = 32;
export const MAX_STOREYS = 64;
export const MAX_BAYS = 32;
export const MAX_SIDES = 16;
export const MAX_ELEMENTS = 128;
export const MAX_CORES = 8;
export const MAX_OUTLINE = 512;
export const MAX_MATERIALS = 64;
export const MAX_RELIEFS = 64;

const NONE = -1;
const UNSET = 255;

/** A material as the table stores it: the engine's finish id and the sRGB colour. */
interface MatSpec { readonly finish: number; readonly colour: number }

/** An open rectangle of the envelope the building leaves free (metres, envelope frame). */
export interface B40Free { x0: number; y0: number; x1: number; y1: number }

/** What a made body returns: the table plus the door positions and the free rectangles the yard may use. */
export interface B40Made {
  readonly body: B40Table;
  /** The front door's middle, metres from the envelope's left. */
  readonly entrance: number;
  readonly backDoor?: number;
  readonly free: B40Free[];
}

interface BlockSpec {
  x: number; y: number; w: number; d: number;
  base?: number; storeys?: number; roof?: number; pitch?: number;
  fill?: number; ground?: number;
  door?: number | 'middle'; doorKind?: number;
  pattern?: number;
  wall?: MatSpec; roofMaterial?: MatSpec;
  shape?: readonly { x: number; y: number }[];
  open?: number;
}

const ELEMENT_DEFAULT: Partial<Record<number, readonly [number, number, number]>> = {
  [B40_ELEMENT.Tree]: [3, 3, 5], [B40_ELEMENT.Bench]: [1.6, 0.5, 0.45], [B40_ELEMENT.Planter]: [1, 1, 0.5],
  [B40_ELEMENT.Flowers]: [1.4, 1.4, 0.4], [B40_ELEMENT.Rocks]: [1.6, 1.6, 0.7], [B40_ELEMENT.Fence]: [2, 0.12, 1.1],
  [B40_ELEMENT.Wall]: [4, 0.25, 1.8], [B40_ELEMENT.Pavement]: [4, 3, 0.12], [B40_ELEMENT.Slab]: [4, 4, 0.25],
  [B40_ELEMENT.Pillar]: [0.4, 0.4, 3], [B40_ELEMENT.Canopy]: [2.4, 1.2, 0.15], [B40_ELEMENT.Parking]: [6, 5, 0.12],
  [B40_ELEMENT.Railing]: [2, 0.12, 1.05], [B40_ELEMENT.Clock]: [3, 0.25, 3], [B40_ELEMENT.Awning]: [3, 1.2, 0.12],
};

export class B40Table {
  /** Volumes. */
  n = 0;
  readonly x = new Float64Array(MAX_VOLUMES);
  readonly y = new Float64Array(MAX_VOLUMES);
  readonly w = new Float64Array(MAX_VOLUMES);
  readonly d = new Float64Array(MAX_VOLUMES);
  readonly base = new Int16Array(MAX_VOLUMES);
  readonly storeys = new Int16Array(MAX_VOLUMES);
  readonly roof = new Uint8Array(MAX_VOLUMES);
  /** NaN: the 4.0 default for the roof kind applies. */
  readonly pitch = new Float64Array(MAX_VOLUMES).fill(NaN);
  /** −1 absent, 0 ridge along x, 1 along y. */
  readonly ridge = new Int8Array(MAX_VOLUMES).fill(NONE);
  /** −1 absent, else the side a lean-to falls to. */
  readonly fall = new Int8Array(MAX_VOLUMES).fill(NONE);
  /** −1: a building block; else a lot surface code. */
  readonly open = new Int8Array(MAX_VOLUMES).fill(NONE);
  /** 0 union, 1 void, 2 intersect, 3 xor. */
  readonly mode = new Uint8Array(MAX_VOLUMES);
  readonly terrace = new Float64Array(MAX_VOLUMES).fill(NaN);
  readonly ramp = new Float64Array(MAX_VOLUMES).fill(NaN);
  readonly lift = new Float64Array(MAX_VOLUMES).fill(NaN);
  readonly outlineAt = new Int32Array(MAX_VOLUMES);
  readonly outlineN = new Int16Array(MAX_VOLUMES);
  readonly dressLines = new Int8Array(MAX_VOLUMES).fill(NONE);
  readonly dressCrown = new Int8Array(MAX_VOLUMES).fill(NONE);
  readonly pattern = new Int8Array(MAX_VOLUMES).fill(NONE);
  readonly wallMat = new Int16Array(MAX_VOLUMES).fill(NONE);
  readonly roofMat = new Int16Array(MAX_VOLUMES).fill(NONE);

  /** Per volume and side: the composed facade geometry (−1 bays: not composed). */
  readonly fgBays = new Int16Array(MAX_VOLUMES * MAX_SIDES).fill(NONE);
  readonly fgWindowW = new Float64Array(MAX_VOLUMES * MAX_SIDES).fill(NaN);
  readonly fgWindowH = new Float64Array(MAX_VOLUMES * MAX_SIDES).fill(NaN);
  readonly fgSill = new Float64Array(MAX_VOLUMES * MAX_SIDES).fill(NaN);
  readonly fgPierW = new Float64Array(MAX_VOLUMES * MAX_SIDES).fill(NaN);
  readonly fgPierD = new Float64Array(MAX_VOLUMES * MAX_SIDES).fill(NaN);
  readonly fgPierEvery = new Int16Array(MAX_VOLUMES * MAX_SIDES).fill(NONE);

  /** Per volume and storey: the default bay code (255 unset), its pattern and its use override. */
  readonly fill = new Uint8Array(MAX_VOLUMES * MAX_STOREYS).fill(UNSET);
  readonly storeyPattern = new Int8Array(MAX_VOLUMES * MAX_STOREYS).fill(NONE);
  readonly storeyUse = new Int8Array(MAX_VOLUMES * MAX_STOREYS).fill(NONE);
  /** Per volume, storey and side: a whole-side fill or pattern override (−1 none). */
  readonly sideFill = new Int8Array(MAX_VOLUMES * MAX_STOREYS * MAX_SIDES).fill(NONE);
  readonly sidePattern = new Int8Array(MAX_VOLUMES * MAX_STOREYS * MAX_SIDES).fill(NONE);
  /** Per volume, storey and side: a material override (−1 none). */
  readonly storeySideMat = new Int16Array(MAX_VOLUMES * MAX_STOREYS * MAX_SIDES).fill(NONE);

  /** Per volume, storey, side and bay: a bay override (255 = the storey's fill). */
  readonly bays = new Uint8Array(MAX_VOLUMES * MAX_STOREYS * MAX_SIDES * MAX_BAYS).fill(UNSET);

  /** Outline points, normalized to the volume's rectangle (x, y pairs). */
  readonly outline = new Float64Array(MAX_OUTLINE);
  outlineUsed = 0;

  /** Reliefs, grouped by volume. */
  reliefN = 0;
  readonly reliefStart = new Int16Array(MAX_VOLUMES).fill(NONE);
  readonly reliefCount = new Int16Array(MAX_VOLUMES);
  readonly reliefSide = new Int16Array(MAX_RELIEFS);
  readonly reliefBay0 = new Int16Array(MAX_RELIEFS);
  readonly reliefBay1 = new Int16Array(MAX_RELIEFS);
  readonly reliefStorey0 = new Int16Array(MAX_RELIEFS);
  readonly reliefStorey1 = new Int16Array(MAX_RELIEFS);
  readonly reliefDepth = new Float64Array(MAX_RELIEFS);

  /** Free parts. */
  elN = 0;
  readonly elKind = new Uint8Array(MAX_ELEMENTS);
  readonly elX = new Float64Array(MAX_ELEMENTS);
  readonly elY = new Float64Array(MAX_ELEMENTS);
  readonly elW = new Float64Array(MAX_ELEMENTS);
  readonly elD = new Float64Array(MAX_ELEMENTS);
  readonly elZ = new Float64Array(MAX_ELEMENTS);
  readonly elH = new Float64Array(MAX_ELEMENTS);
  readonly elFacing = new Uint8Array(MAX_ELEMENTS);
  readonly elAngle = new Float64Array(MAX_ELEMENTS).fill(NaN);
  readonly elMat = new Int16Array(MAX_ELEMENTS).fill(NONE);

  /** Cores. */
  coreN = 0;
  readonly coreKind = new Uint8Array(MAX_CORES);
  readonly coreX = new Float64Array(MAX_CORES);
  readonly coreY = new Float64Array(MAX_CORES);
  readonly coreFrom = new Int16Array(MAX_CORES);
  readonly coreTo = new Int16Array(MAX_CORES);

  /** Materials: finish id and sRGB colour, shared by every reference. */
  matN = 0;
  readonly matFinish = new Uint8Array(MAX_MATERIALS);
  readonly matColour = new Uint32Array(MAX_MATERIALS);

  /** The building's own vocabulary. */
  use: number = B40_USE.Residential;
  functionName = '';
  palette = 0;
  module = 3;
  groundHeight = 3.6;
  storeyHeight = 3.1;
  wallRef: number = NONE;
  roofRef: number = NONE;
  trimRef: number = NONE;
  plinthRef: number = NONE;

  clear(): void {
    this.n = 0; this.elN = 0; this.coreN = 0; this.matN = 0; this.reliefN = 0; this.outlineUsed = 0;
    this.outlineN.fill(0); this.outlineAt.fill(0);
    this.fill.fill(UNSET);
    this.bays.fill(UNSET);
    this.storeySideMat.fill(NONE);
    this.sideFill.fill(NONE);
    this.sidePattern.fill(NONE);
    this.storeyPattern.fill(NONE);
    this.storeyUse.fill(NONE);
    this.fgBays.fill(NONE);
    this.fgWindowW.fill(NaN); this.fgWindowH.fill(NaN); this.fgSill.fill(NaN);
    this.fgPierW.fill(NaN); this.fgPierD.fill(NaN); this.fgPierEvery.fill(NONE);
    this.reliefStart.fill(NONE); this.reliefCount.fill(0);
    this.pitch.fill(NaN); this.ridge.fill(NONE); this.fall.fill(NONE); this.open.fill(NONE);
    this.terrace.fill(NaN); this.ramp.fill(NaN); this.lift.fill(NaN);
    this.dressLines.fill(NONE); this.dressCrown.fill(NONE); this.pattern.fill(NONE);
    this.wallMat.fill(NONE); this.roofMat.fill(NONE);
    this.elAngle.fill(NaN); this.elMat.fill(NONE);
    this.wallRef = NONE; this.roofRef = NONE; this.trimRef = NONE; this.plinthRef = NONE;
    this.functionName = ''; this.palette = 0; this.module = 3; this.groundHeight = 3.6; this.storeyHeight = 3.1;
  }

  /** The reference for a material, sharing an equal one already added. */
  material(spec: B40Paint | MatSpec): number {
    for (let i = 0; i < this.matN; i++) if (this.matFinish[i] === spec.finish && this.matColour[i] === spec.colour) return i;
    if (this.matN >= MAX_MATERIALS) return NONE;
    const ref = this.matN++;
    this.matFinish[ref] = spec.finish;
    this.matColour[ref] = spec.colour;
    return ref;
  }

  heights(ground: number, storey: number): this { this.groundHeight = ground; this.storeyHeight = storey; return this; }

  look(wall: B40Paint | MatSpec, roof?: B40Paint | MatSpec, trim?: B40Paint | MatSpec): this {
    this.wallRef = this.material(wall);
    if (roof) this.roofRef = this.material(roof);
    if (trim) this.trimRef = this.material(trim);
    return this;
  }

  /** A rectangular block, as 4.0's Model.block: its storeys get the fill (the ground its own), the door is a bay. */
  block(s: BlockSpec): number {
    if (this.n >= MAX_VOLUMES) throw new Error('b40: too many volumes in a lot');
    const v = this.n++;
    this.x[v] = s.x; this.y[v] = s.y; this.w[v] = s.w; this.d[v] = s.d;
    this.base[v] = s.base ?? 0;
    this.storeys[v] = s.storeys ?? 1;
    this.roof[v] = s.roof ?? B40_ROOF.Flat;
    if (s.pitch !== undefined) this.pitch[v] = s.pitch;
    if (s.pattern !== undefined) this.pattern[v] = s.pattern;
    if (s.open !== undefined) this.open[v] = s.open;
    if (s.wall) this.wallMat[v] = this.material(s.wall);
    if (s.roofMaterial) this.roofMat[v] = this.material(s.roofMaterial);
    const fill = s.fill ?? B40_BAY.Window;
    const storeys = this.storeys[v]!;
    for (let k = 0; k < storeys; k++) {
      const at = v * MAX_STOREYS + k;
      this.fill[at] = k === 0 && s.ground !== undefined ? s.ground : fill;
      this.storeyPattern[at] = NONE;
      this.storeyUse[at] = NONE;
    }
    if (s.door !== undefined) {
      const across = Math.max(1, Math.round(s.w / 3));
      const bay = s.door === 'middle' ? across >> 1 : s.door;
      this.setBay(v, 0, 0, bay, s.doorKind ?? B40_BAY.Door);
    }
    if (s.shape && s.shape.length >= 3) {
      const at = this.outlineUsed;
      if (at + s.shape.length * 2 <= MAX_OUTLINE) {
        for (let i = 0; i < s.shape.length; i++) { this.outline[at + i * 2] = s.shape[i]!.x; this.outline[at + i * 2 + 1] = s.shape[i]!.y; }
        this.outlineAt[v] = at; this.outlineN[v] = s.shape.length; this.outlineUsed = at + s.shape.length * 2;
      }
    }
    return v;
  }

  lot(x: number, y: number, w: number, d: number, surface: number): number {
    return this.block({ x, y, w, d, open: surface, fill: B40_BAY.Wall });
  }

  el(kind: number, x: number, y: number, facing = 0, size?: { w?: number; d?: number; h?: number; z?: number; material?: B40Paint | MatSpec }): number {
    if (this.elN >= MAX_ELEMENTS) return NONE;
    const e = this.elN++;
    const dflt = ELEMENT_DEFAULT[kind] ?? [1, 1, 1];
    this.elKind[e] = kind; this.elFacing[e] = facing;
    this.elX[e] = x; this.elY[e] = y;
    this.elW[e] = size?.w ?? dflt[0]; this.elD[e] = size?.d ?? dflt[1]; this.elH[e] = size?.h ?? dflt[2];
    this.elZ[e] = size?.z ?? 0;
    if (size?.material) this.elMat[e] = this.material(size.material);
    return e;
  }

  row(kind: number, x0: number, y0: number, x1: number, y1: number, n: number, facing = 0): void {
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      this.el(kind, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, facing);
    }
  }

  ring(kind: number, x: number, y: number, w: number, d: number, gate = 4): void {
    const piece = 4;
    for (let a = 0; a + piece <= w + 0.01; a += piece) {
      if (Math.abs(a + piece / 2 - w / 2) > gate / 2) this.el(kind, x + a + piece / 2, y, 0, { w: piece });
      this.el(kind, x + a + piece / 2, y + d, 2, { w: piece });
    }
    for (let a = 0; a + piece <= d + 0.01; a += piece) {
      this.el(kind, x, y + a + piece / 2, 3, { w: piece });
      this.el(kind, x + w, y + a + piece / 2, 1, { w: piece });
    }
  }

  core(kind: number, x: number, y: number, to: number, from = 0): void {
    if (this.coreN >= MAX_CORES) return;
    const c = this.coreN++;
    this.coreKind[c] = kind; this.coreX[c] = x; this.coreY[c] = y; this.coreFrom[c] = from; this.coreTo[c] = to;
  }

  setBay(v: number, storey: number, side: number, bay: number, code: number): void {
    if (bay < 0 || bay >= MAX_BAYS) return;
    this.bays[((v * MAX_STOREYS + storey) * MAX_SIDES + side) * MAX_BAYS + bay] = code;
  }

  bay(v: number, storey: number, side: number, bay: number): number {
    return this.bays[((v * MAX_STOREYS + storey) * MAX_SIDES + side) * MAX_BAYS + bay]!;
  }

  fillOf(v: number, storey: number): number {
    return this.fill[v * MAX_STOREYS + storey]!;
  }

  setFill(v: number, storey: number, code: number): void {
    this.fill[v * MAX_STOREYS + storey] = code;
  }

  setStoreyMaterial(v: number, storey: number, side: number, ref: number): void {
    this.storeySideMat[(v * MAX_STOREYS + storey) * MAX_SIDES + side] = ref;
  }

  setSide(v: number, storey: number, side: number, fill: number, pattern: number): void {
    const at = (v * MAX_STOREYS + storey) * MAX_SIDES + side;
    this.sideFill[at] = fill;
    this.sidePattern[at] = pattern;
  }

  /** The composed geometry of a face: bays, opening fractions, sill, piers. */
  setFacadeGeometry(v: number, side: number, bays: number, windowWidth: number, windowHeight: number, sill: number,
    pierWidth = NaN, pierDepth = NaN, pierEvery = NONE): void {
    const at = v * MAX_SIDES + side;
    this.fgBays[at] = bays; this.fgWindowW[at] = windowWidth; this.fgWindowH[at] = windowHeight; this.fgSill[at] = sill;
    this.fgPierW[at] = pierWidth; this.fgPierD[at] = pierDepth; this.fgPierEvery[at] = pierEvery;
  }

  addRelief(v: number, side: number, bay0: number, bay1: number, storey0: number, storey1: number, depth: number): void {
    if (this.reliefN >= MAX_RELIEFS) return;
    if (this.reliefStart[v] === NONE) this.reliefStart[v] = this.reliefN;
    const r = this.reliefN++;
    this.reliefSide[r] = side; this.reliefBay0[r] = bay0; this.reliefBay1[r] = bay1;
    this.reliefStorey0[r] = storey0; this.reliefStorey1[r] = storey1; this.reliefDepth[r] = depth;
    this.reliefCount[v] = this.reliefCount[v]! + 1;
  }
}

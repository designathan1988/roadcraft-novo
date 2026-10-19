// The 38 Roadcraft 4.0 lot projects (data/lots-roadcraft/*.json), whole: every volume with its storeys, the facade of
// each storey and each side, the single-bay overrides (doors), the window geometry of each face (window width and
// height, sill, piers), outlines, open ground, and every element (trees, benches, lamps, bollards, walls, fences,
// gates, slabs, pavements, parking...) with its size, height, elevation, facing and material. Packed losslessly by
// data/lots-roadcraft/pack.mjs into catalogData.ts (volumes in int16 at 1/160 of a project unit; elements and outlines in float32) and decoded
// once per worker or page (catalog.ts). This module is the format: enums, types and the decoder. Lengths stay in project units (CAT_UNIT metres each), as in the 4.0 files.

/** Metres per project unit. */
export const CAT_UNIT = 0.4;
/** Fixed point of every packed length: units × 160 (2.5 mm). */
export const CAT_Q = 160;

/** Roadcraft 4.0 enumerations, in their order there (types.ts, materials.ts). */
export const CAT_BAYS = ['wall', 'window', 'sashWindow', 'frenchWindow', 'bayWindow', 'ribbon', 'wideWindow', 'balcony', 'door', 'doubleDoor',
  'garageDoor', 'shopfront', 'loadingDoor', 'pillar', 'loggia', 'brise', 'shutteredWindow', 'gourmet'] as const;
export const CAT_PATTERNS = ['residential', 'storefront', 'office', 'industrial', 'arcade', 'gallery', 'artDeco', 'artDecoCrown', 'observation'] as const;
export const CAT_ROOFS = ['flat', 'terrace', 'gable', 'hip', 'shed', 'sawtooth'] as const;
export const CAT_SURFACES = ['grass', 'paving', 'gravel', 'sand', 'water', 'asphalt', 'concrete', 'pavers', 'tiles'] as const;
export const CAT_FINISHES = ['plaster', 'stucco', 'ceramic', 'brick', 'stone', 'concrete', 'wood', 'metal', 'glass', 'tile', 'slate', 'panel', 'roofing'] as const;
export const CAT_ELEMENTS = ['stair', 'ramp', 'pillar', 'canopy', 'wall', 'slab', 'pavement', 'fence', 'tree', 'bench', 'ac', 'planter', 'railing',
  'awning', 'flowers', 'rocks', 'parking', 'clock', 'hedge', 'shrub', 'gate', 'bin', 'lamp', 'bollard', 'drain'] as const;
export const CAT_USES = ['residential', 'commercial', 'industrial', 'mixed'] as const;
export const CAT_DENSITIES = ['low', 'medium', 'high'] as const;
export const CAT_FUNCTIONS = ['house', 'townhouse', 'apartments', 'residentialTower', 'cityHall', 'council', 'courthouse', 'postOffice', 'police',
  'fireStation', 'hospital', 'clinic', 'school', 'university', 'library', 'museum', 'prison', 'church', 'cemetery', 'busStation', 'shop',
  'supermarket', 'mall', 'bank', 'pharmacy', 'bakery', 'restaurant', 'snackBar', 'bar', 'nightclub', 'cinema', 'hotel', 'gym', 'club',
  'gasStation', 'office', 'factory', 'warehouse', 'park', 'square', 'playground', 'sportsCourt'] as const;
/** Index of each name in its list. */
export const catIndex = <T extends readonly string[]>(list: T, name: string): number => list.indexOf(name as T[number]);

/** A finish (index into CAT_FINISHES) and a colour (0xRRGGBB). */
export interface CatMaterial { finish: number; colour: number }
/** One face's window and pier geometry (4.0 FacadeGeometry): fractions of the bay and the storey, units for the rest. */
export interface CatGeometry { bays?: number; windowWidth?: number; windowHeight?: number; sill?: number; pierWidth?: number; pierDepth?: number; pierEvery?: number }
/** A storey's facade: the fill, a fill per face (-1 = the storey's own), and single bays [face, index, component]. */
export interface CatStorey { fill: number; sides: [number, number, number, number]; bays: Array<[number, number, number]> }
export interface CatVolume {
  x: number; y: number; w: number; d: number;
  /** Level the volume stands on, and its roof (CAT_ROOFS). */
  base: number; roof: number;
  /** An open block (CAT_SURFACES index): lot ground, no storeys; -1 = a building block. */
  open: number;
  material: CatMaterial | null;
  /** The facade pattern the volume was composed with (CAT_PATTERNS), -1 = none. */
  pattern: number;
  /** Counterclockwise outline, x/y pairs normalized to the volume's box; null = the box. */
  outline: number[] | null;
  /** Window geometry of faces 0 (front, -y) .. 3 (left); null = the defaults. */
  geometry: Array<CatGeometry | null>;
  storeys: CatStorey[];
}
export interface CatElement { kind: number; x: number; y: number; facing: number; w: number; d: number; z: number; h: number; material: CatMaterial | null }
export interface CatProject {
  /** Use of the lot in the library and of the building itself (CAT_USES; they differ for loftBrick). */
  name: string; use: number; buildingUse: number; fn: number;
  /** Growth density the project was saved for (CAT_DENSITIES). */
  density: number;
  /** Bay module, ground storey and upper storey heights (units). */
  module: number; groundHeight: number; storeyHeight: number;
  palette: number; lotPlan: number;
  wall: CatMaterial; trim: CatMaterial; roof: CatMaterial;
  volumes: CatVolume[];
  elements: CatElement[];
}

/** Bits of a volume's flags byte. */
export const VOL_MATERIAL = 1, VOL_OUTLINE = 2, VOL_PATTERN = 4;
/** Bits of a face geometry's fields byte, in the order the values follow. */
export const GEOM_FIELDS = ['bays', 'windowWidth', 'windowHeight', 'sill', 'pierWidth', 'pierDepth', 'pierEvery'] as const;

/** Reads the packed catalog (the layout written by data/lots-roadcraft/pack.mjs). */
export function decodeCatalog(bytes: Uint8Array, names: readonly string[]): CatProject[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const u8 = () => dv.getUint8(o++);
  const u16 = () => { const v = dv.getUint16(o, true); o += 2; return v; };
  const len = () => { const v = dv.getInt16(o, true); o += 2; return v / CAT_Q; };
  const f32 = () => { const v = dv.getFloat32(o, true); o += 4; return v; };
  const mat = (): CatMaterial => { const finish = u8(); const colour = u8() | (u8() << 8) | (u8() << 16); return { finish, colour }; };
  const out: CatProject[] = [];
  const count = u8();
  for (let p = 0; p < count; p++) {
    const use = u8(), buildingUse = u8(), fn = u8(), density = u8(), module = len(), groundHeight = len(), storeyHeight = len(), palette = u8(), lotPlan = u8();
    const wall = mat(), trim = mat(), roof = mat();
    const volumes: CatVolume[] = [];
    for (let n = u16(), v = 0; v < n; v++) {
      const x = len(), y = len(), w = len(), d = len(), base = u8(), roof = u8(), open = u8() - 1, flags = u8();
      const material = flags & VOL_MATERIAL ? mat() : null;
      const pattern = flags & VOL_PATTERN ? u8() : -1;
      let outline: number[] | null = null;
      if (flags & VOL_OUTLINE) { outline = []; for (let k = u8() * 2; k > 0; k--) outline.push(f32()); }
      const geometry: Array<CatGeometry | null> = [null, null, null, null];
      const faces = u8();
      for (let f = 0; f < 4; f++) {
        if (!(faces & (1 << f))) continue;
        const fields = u8(), g: CatGeometry = {};
        if (fields & 1) g.bays = u8();
        if (fields & 2) g.windowWidth = u8() / 100;
        if (fields & 4) g.windowHeight = u8() / 100;
        if (fields & 8) g.sill = len();
        if (fields & 16) g.pierWidth = len();
        if (fields & 32) g.pierDepth = len();
        if (fields & 64) g.pierEvery = u8();
        geometry[f] = g;
      }
      const storeys: CatStorey[] = [];
      for (let ns = u8(), s = 0; s < ns; s++) {
        const fill = u8(), mask = u8();
        const sides: [number, number, number, number] = [-1, -1, -1, -1];
        for (let f = 0; f < 4; f++) if (mask & (1 << f)) sides[f] = u8();
        const bays: Array<[number, number, number]> = [];
        for (let nb = u8(), b = 0; b < nb; b++) bays.push([u8(), u8(), u8()]);
        storeys.push({ fill, sides, bays });
      }
      volumes.push({ x, y, w, d, base, roof, open, material, pattern, outline, geometry, storeys });
    }
    const elements: CatElement[] = [];
    for (let n = u16(), e = 0; e < n; e++) {
      const kind = u8(), x = f32(), y = f32(), facing = u8(), w = f32(), d = f32(), z = f32(), h = f32(), has = u8();
      elements.push({ kind, x, y, facing, w, d, z, h, material: has ? mat() : null });
    }
    out.push({ name: names[p], use, buildingUse, fn, density, module, groundHeight, storeyHeight, palette, lotPlan: lotPlan === 255 ? -1 : lotPlan, wall, trim, roof, volumes, elements });
  }
  if (o !== bytes.length) throw new Error(`catalog: ${bytes.length - o} bytes left over`);
  return out;
}


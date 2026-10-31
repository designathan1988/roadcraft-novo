// The Roadcraft 4.0 building parts in the props pool: which pool type and variant each part kind is drawn as, how
// far each type is drawn, and how an instance's per-axis scale, colour and variant are packed into the pool's record
// (render/props.ts reads them back). Shared by the props job (jobs/props.ts) and the renderer (render/propMeshes.ts).
/** The pool types of the 4.0 building parts (24..29: the buildings' share of the 5-bit type, jobs/props.ts PROP). */
export const PART_PROP = { BFrame: 24, BBox: 25, BRail: 26, BMisc: 27, BPropA: 28, BPropB: 29, BLot: 30 } as const;
const PROP = PART_PROP;

/** Pool type and variant of each 4.0 part kind laid as an instance (the rest go into the shell, jobs/building40.ts). */
export const POOL_PARTS: Readonly<Record<string, readonly [number, number]>> = {
  frame: [PROP.BFrame, 0],
  concrete: [PROP.BBox, 0], shutter: [PROP.BBox, 0], fin: [PROP.BBox, 0], lamp: [PROP.BBox, 0],
  railing: [PROP.BRail, 0],
  door: [PROP.BMisc, 0], awning: [PROP.BMisc, 1], column: [PROP.BMisc, 2], louvre: [PROP.BMisc, 3], brise: [PROP.BMisc, 4],
  glassRail: [PROP.BMisc, 5], roofRailing: [PROP.BMisc, 6],
  acUnit: [PROP.BPropA, 0], pot: [PROP.BPropA, 1], foliage: [PROP.BPropA, 2], bush: [PROP.BPropA, 3], lounger: [PROP.BPropA, 4],
  lotBox: [PROP.BLot, 0], lotRail: [PROP.BLot, 1], lotSlab: [PROP.BLot, 2],
  bike: [PROP.BPropB, 0], chair: [PROP.BPropB, 1], table: [PROP.BPropB, 2], airer: [PROP.BPropB, 3], dish: [PROP.BPropB, 4],
};

/** The building part types (their own geometry, scale per axis, colour per instance). */
export const PART_TYPES: readonly number[] = [PROP.BFrame, PROP.BBox, PROP.BRail, PROP.BMisc, PROP.BPropA, PROP.BPropB, PROP.BLot];
/** Types whose instances carry a variant (all variants in one mesh, the shader keeps the instance's own). */
export const VARIANT_TYPES = new Set<number>([PROP.BMisc, PROP.BPropA, PROP.BPropB, PROP.BLot]);
/** Metres each type is drawn to, at 1080p: the 4.0 draws a part by its size on the screen (partFiling.ts). */
export const PART_DIST: Readonly<Record<number, number>> = {
  [PROP.BFrame]: 400, [PROP.BBox]: 600, [PROP.BRail]: 300, [PROP.BMisc]: 400, [PROP.BPropA]: 250, [PROP.BPropB]: 150, [PROP.BLot]: 800,
};
/** How far from the camera a cell asks for its building parts (the farthest type, and a cell's reach). */
export const PARTS_RANGE = 800 + 128;

/** Scale range of the log code, metres: SCALE_MIN * 2^(code / max * SCALE_OCTAVES). */
export const SCALE_MIN = 0.005, SCALE_OCTAVES = 13;
function q(s: number, bits: number): number {
  const max = (1 << bits) - 1;
  return Math.max(0, Math.min(max, Math.round(Math.log2(Math.max(SCALE_MIN, Math.abs(s)) / SCALE_MIN) / SCALE_OCTAVES * max)));
}
/** The pool record's key (27 bits): x, y, z scale, 9 bits each; with a variant, 8 bits each and the variant on top. */
export function partKey(type: number, sx: number, sy: number, sz: number, variant: number): number {
  if (VARIANT_TYPES.has(type)) return (q(sx, 8) | (q(sy, 8) << 8) | (q(sz, 8) << 16) | ((variant & 7) << 24)) >>> 0;
  return (q(sx, 9) | (q(sy, 9) << 9) | (q(sz, 9) << 18)) >>> 0;
}
/** The record's w (24 bits, exact in a float): the turn (12 bits) and the colour, sRGB 4 + 4 + 4 bits. */
export function partW(yaw: number, rgb: number): number {
  const a = ((yaw / (Math.PI * 2)) % 1 + 1) % 1;
  const yq = Math.min(4095, Math.round(a * 4096) & 4095);
  const c = (((rgb >> 20) & 15) << 8) | (((rgb >> 12) & 15) << 4) | ((rgb >> 4) & 15);
  return yq + c * 4096;
}

/**
 * Each pooled kind's base colour (sRGB) and whether it is metal: the 4.0 kit's material (kit.ts createBuildingKit,
 * :484-534); the instance colour tints it (white for the kinds the 4.0 does not colour per instance).
 */
export const PART_BASE: Readonly<Record<string, readonly [number, boolean]>> = {
  frame: [0xffffff, true], concrete: [0xcfc9bd, false], door: [0x6b4a33, false], shutter: [0x9aa1a4, true],
  railing: [0xffffff, true], roofRailing: [0x33373a, true], awning: [0xffffff, false], column: [0xcfc9bd, false],
  lamp: [0xf1ebdd, false], fin: [0xffffff, false], brise: [0xffffff, false], louvre: [0xffffff, false],
  glassRail: [0xa9c4c4, false], acUnit: [0xffffff, true], pot: [0xffffff, false], foliage: [0xffffff, false],
  bush: [0xffffff, false], lounger: [0xffffff, false], bike: [0xffffff, true], chair: [0xffffff, false],
  table: [0xffffff, false], airer: [0xffffff, false], dish: [0xffffff, true],
  lotBox: [0xffffff, false], lotRail: [0xffffff, true], lotSlab: [0xffffff, false],
};

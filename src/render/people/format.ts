// The cooked people (`tools/cook-people.mjs` -> `public/cooked/people/people.{json,bin}`): what the file holds and
// what its numbers mean. No three.js here: the tests read it under Node.

/** Must equal `COOK_VERSION` of `tools/cook-people.mjs` and the `version` of `people.json`. */
export const PEOPLE_COOK_VERSION = 1;

/** Region of a vertex (top byte of its colour word): each is tinted its own way. Props show only when held. */
export const REGION = { skin: 0, hair: 1, top: 2, bottom: 3, shoes: 4, hat: 5, eyes: 6, phone: 8, cup: 9, bag: 10, paper: 11, umbrella: 12, helmet: 13 } as const;

/** Clips every variation carries, in the cook's order. */
export const CLIP = { walk: 0, idle: 1, sit: 2, walkPhone: 3, phone: 4, read: 5, drink: 6, walkUmbrella: 7, umbrella: 8, walkCarry: 9, pedal: 10 } as const;
export type ClipName = keyof typeof CLIP;

/** The thing held in each clip (a region of REGION), or 0 for none. */
export const CLIP_PROP: readonly number[] = [0, 0, 0, REGION.phone, REGION.phone, REGION.paper, REGION.cup, REGION.umbrella, REGION.umbrella, REGION.bag, REGION.helmet];

export interface CookedClip { name: ClipName; start: number; frames: number; fps: number; loop: boolean }
export interface CookedVariation {
  clipSet: number; paletteStart: number; sex: 'female' | 'male'; band: 'child' | 'young' | 'adult' | 'senior'; years: number;
  height: number; outfit: string; hair: string; shoes: string; hat: string | null; skin: string;
  /** Per level: first index and triangle count in `index`. */
  lod: [[number, number], [number, number]];
  /** Pelvis height and forward offset in the sitting clip, metres. */
  sitPelvis: [number, number];
}
export interface CookedSection { byteOffset: number; count: number }
export interface CookedPeople {
  format: string; version: number; bytes: number; bones: string[]; parents: number[];
  clipSets: [CookedClip[], CookedClip[]]; paletteFrames: number; maxTris: [number, number]; vertices: number;
  layout: { vpos: CookedSection; vattr: CookedSection; index: CookedSection; palette: CookedSection };
  variations: CookedVariation[];
}

/** Checks a cooked file against this build; returns the problem, or null. */
export function checkCooked(meta: CookedPeople, byteLength: number): string | null {
  if (meta.version !== PEOPLE_COOK_VERSION) return `cooked people version ${meta.version}, the game wants ${PEOPLE_COOK_VERSION}: run npm run cook:people`;
  if (meta.bytes !== byteLength) return `people.bin has ${byteLength} bytes, people.json says ${meta.bytes}`;
  const L = meta.layout;
  if (L.vpos.count !== meta.vertices * 4 || L.vattr.count !== meta.vertices * 4) return 'vertex sections disagree with the vertex count';
  if (L.palette.count !== meta.paletteFrames * meta.bones.length * 12) return 'palette section disagrees with the frame count';
  for (const v of meta.variations) {
    const frames = meta.clipSets[v.clipSet].reduce((s, c) => s + c.frames, 0);
    if (v.paletteStart + frames > meta.paletteFrames) return 'a variation runs past the palettes';
    if (v.lod[0][1] > meta.maxTris[0] || v.lod[1][1] > meta.maxTris[1]) return 'a variation has more triangles than the maximum';
    if (v.lod[0][0] + v.lod[0][1] * 3 > L.index.count || v.lod[1][0] + v.lod[1][1] * 3 > L.index.count) return 'a level runs past the index';
  }
  const names = Object.keys(CLIP);
  for (const set of meta.clipSets) if (set.length !== names.length || set.some((c, i) => c.name !== names[i])) return 'clip order differs from CLIP';
  return null;
}

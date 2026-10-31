// The people creator of the Roadcraft (the screen is the interface's; this is the logic): groups of 1 to 20 people
// placed by the player, with their outfit, colours, height, and standing, walking round or talking in a ring.
// A group is a few numbers; its people are drawn by the PeopleRenderer like everyone else (no object per person,
// nothing per frame but their placement, and only for the groups near and in view).
// No three.js here: the tests run it under Node.

import { CLIP, type CookedPeople } from './format.ts';
import { hash32 } from './looks.ts';

import { DEFAULT_PERSON_OPTIONS, type CreatorHold, type CreatorMode, type PersonOptions } from '../../shared/contracts/people.ts';
export { DEFAULT_PERSON_OPTIONS } from '../../shared/contracts/people.ts';
export type { CreatorHold, CreatorMode, PersonOptions } from '../../shared/contracts/people.ts';

/** The colours the shader can tint to, in its order (`crowd.ts` CLOTHES and HAIR), for the screen's swatches. */
export const CREATOR_PALETTES = {
  clothes: [0x1d2433, 0x2b2b2e, 0x6d7177, 0xe6e4df, 0x3b5a8a, 0x7d2a2a, 0x2f5a3b, 0xb79c74, 0x5a3d6e, 0xcf7a2c, 0x8a8f5a, 0x9a3c5a, 0x2d6f7a, 0xd8c9a3, 0x4a4f8c, 0xc23b32],
  hair: [0x16110d, 0x2a1b12, 0x4a2f1c, 0x6b4426, 0x1a1a1a, 0x8a5a2b, 0xb08850, 0x3b2a20],
} as const;

/** What the screen offers: the cooked outfits by sex and age, the hairstyles, the limits. */
export function creatorCatalog(meta: CookedPeople) {
  const outfits = [...new Set(meta.variations.map((v) => v.outfit))].map((name) => ({
    name, sexes: [...new Set(meta.variations.filter((v) => v.outfit === name).map((v) => v.sex))],
    bands: [...new Set(meta.variations.filter((v) => v.outfit === name).map((v) => v.band))],
  }));
  return { outfits, hairs: [...new Set(meta.variations.map((v) => v.hair))], palettes: CREATOR_PALETTES, maxCount: 20, modes: ['stand', 'walk', 'group'] as CreatorMode[],
    holds: ['none', 'phone', 'cup', 'paper', 'bag', 'umbrella'] as CreatorHold[] };
}

/** One placed person, as the renderer wants it. */
export interface PlacedPerson { x: number; y: number; z: number; yaw: number; px: number; pz: number; pyaw: number; variation: number; clip: number; hash: number; scale: number }

interface Group { id: number; x: number; z: number; y: number; o: PersonOptions; variations: number[]; hashes: number[]; seed: number }

const WALK_SPEED = 1.3;
const MAX_GROUPS = 256;

export class PeopleCreator {
  private groups: Group[] = [];
  /** The options of the last group placed (count, mode…), or null. */
  get lastOptions(): Readonly<Group['o']> | null { return this.groups[this.groups.length - 1]?.o ?? null; }
  private nextId = 1;
  /** Ground height for each placed person (set by the game: the terrain's heights); the group's own height without it. */
  ground: ((x: number, z: number) => number) | null = null;
  private readonly meta: CookedPeople;
  constructor(meta: CookedPeople) { this.meta = meta; }

  get size(): number { return this.groups.length; }

  /** Places a group at (x, z) on the ground height `y`; returns its id (0 when full). Use `placeCommand` for undo. */
  place(x: number, z: number, y: number, options: Partial<PersonOptions> = {}, id = 0): number {
    if (this.groups.length >= MAX_GROUPS) return 0;
    const o = { ...DEFAULT_PERSON_OPTIONS, ...options };
    o.count = Math.max(1, Math.min(20, Math.round(o.count)));
    o.height = Math.max(0.85, Math.min(1.15, o.height));
    const gid = id || this.nextId++;
    this.nextId = Math.max(this.nextId, gid + 1);
    const seed = hash32(gid * 2654435761 + Math.floor(x * 7) + Math.floor(z * 13));
    const pool = this.meta.variations.map((v, i) => ({ v, i })).filter(({ v }) =>
      (o.sex === 'any' || v.sex === o.sex) && (o.band === 'any' || v.band === o.band) && (o.outfit === 'any' || v.outfit === o.outfit)).map(({ i }) => i);
    const all = pool.length ? pool : this.meta.variations.map((_, i) => i);
    const variations: number[] = [], hashes: number[] = [];
    for (let k = 0; k < o.count; k++) {
      const h = hash32(seed + k * 40503);
      variations.push(all[(o.mixed ? h : seed) % all.length]);
      hashes.push(this.hashWith(o.mixed ? h : seed, o));
    }
    this.groups.push({ id: gid, x, z, y, o, variations, hashes, seed });
    return gid;
  }

  remove(id: number): boolean {
    const i = this.groups.findIndex((g) => g.id === id);
    if (i < 0) return false;
    this.groups.splice(i, 1);
    return true;
  }

  clear(): void { this.groups.length = 0; }

  /** The same placement as a command with its inverse (`core/commands.ts`): undo removes it, redo puts it back with the same id. */
  placeCommand(x: number, z: number, y: number, options: Partial<PersonOptions> = {}) {
    let id = 0;
    return {
      label: 'cmd.place.people', apply: () => { id = this.place(x, z, y, options, id); }, invert: () => { this.remove(id); },
      get id() { return id; },
    };
  }

  /**
   * The colour fields of the shader's hash (`crowd.ts`): bits 0-1 tint the top, 2-3 the bottom, 4-7 the top's
   * colour, 9-12 the bottom's, 14-15 grey hair, 18-20 the hair colour. Fixed colours overwrite their fields.
   */
  private hashWith(h: number, o: PersonOptions): number {
    let x = h & 0xffffff;
    if (o.top >= 0) x = (x & ~0xf3) | 1 | ((o.top & 15) << 4);
    if (o.bottom >= 0) x = (x & ~(0xc | (15 << 9))) | 4 | ((o.bottom & 15) << 9);
    if (o.hair >= 0) x = (x & ~((3 << 14) | (7 << 18))) | ((o.hair & 7) << 18);
    return x >>> 0;
  }

  private clipOf(o: PersonOptions, h: number): number {
    const walking = o.mode === 'walk';
    switch (o.hold) {
      case 'phone': return walking ? CLIP.walkPhone : CLIP.phone;
      case 'umbrella': return walking ? CLIP.walkUmbrella : CLIP.umbrella;
      case 'bag': return CLIP.walkCarry;
      case 'cup': return walking ? CLIP.walk : CLIP.drink;
      case 'paper': return walking ? CLIP.walk : CLIP.read;
    }
    if (walking) return CLIP.walk;
    // standing about: some on the phone, some drinking, most idle
    const s = (h >>> 9) % 10;
    return s < 2 ? CLIP.phone : s < 3 ? CLIP.drink : CLIP.idle;
  }

  /**
   * Every placed person of the groups whose centre is within `radius` of (ex, ez) and for which `visible(x, z, r)`
   * says yes, at time `t` seconds (and `dt` before, for the motion vectors). Calls `out` for each; allocates nothing.
   */
  forEach(ex: number, ez: number, radius: number, t: number, dt: number, visible: (x: number, y: number, z: number, r: number) => boolean, out: (p: PlacedPerson) => void): void {
    const p = this.tmp;
    for (const g of this.groups) {
      const o = g.o, n = o.count;
      const ring = 1.2 + n * 0.35;
      if (Math.hypot(g.x - ex, g.z - ez) > radius + ring || !visible(g.x, g.y + 1, g.z, ring + 1)) continue;
      for (let k = 0; k < n; k++) {
        const h = g.hashes[k];
        const a0 = (k / n) * Math.PI * 2 + (g.seed % 628) / 100;
        if (o.mode === 'walk') {
          const r = ring + ((h >>> 3) % 5) * 0.25;
          const w = WALK_SPEED / r;
          const a = a0 + t * w, b = a0 + (t - dt) * w;
          p.x = g.x + Math.cos(a) * r; p.z = g.z + Math.sin(a) * r; p.yaw = Math.atan2(-Math.sin(a), Math.cos(a));
          p.px = g.x + Math.cos(b) * r; p.pz = g.z + Math.sin(b) * r; p.pyaw = Math.atan2(-Math.sin(b), Math.cos(b));
        } else if (o.mode === 'group') {
          const r = n === 1 ? 0 : Math.max(0.55, n * 0.12);
          p.x = g.x + Math.cos(a0) * r; p.z = g.z + Math.sin(a0) * r;
          p.yaw = Math.atan2(-Math.cos(a0), -Math.sin(a0)); p.px = p.x; p.pz = p.z; p.pyaw = p.yaw;
        } else {
          // standing scattered on a loose grid, each turned its own way
          const cols = Math.ceil(Math.sqrt(n));
          const jx = (((h >>> 4) & 255) / 255 - 0.5) * 0.6, jz = (((h >>> 12) & 255) / 255 - 0.5) * 0.6;
          p.x = g.x + ((k % cols) - (cols - 1) / 2) * 1.1 + jx; p.z = g.z + (Math.floor(k / cols) - (cols - 1) / 2) * 1.1 + jz;
          p.yaw = ((h >>> 20) & 1023) / 1024 * Math.PI * 2; p.px = p.x; p.pz = p.z; p.pyaw = p.yaw;
        }
        p.y = this.ground ? this.ground(p.x, p.z) : g.y; p.variation = g.variations[k]; p.clip = this.clipOf(o, h); p.hash = h; p.scale = o.height;
        out(p);
      }
    }
  }

  private tmp: PlacedPerson = { x: 0, y: 0, z: 0, yaw: 0, px: 0, pz: 0, pyaw: 0, variation: 0, clip: 0, hash: 0, scale: 1 };
}

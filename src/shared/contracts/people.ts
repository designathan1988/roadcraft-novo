// Person creator contract: types and defaults shared by the interface and the people renderer.
// Pure data and types; no three.js, no UI.

export type CreatorMode = 'stand' | 'walk' | 'group';
export type CreatorHold = 'none' | 'phone' | 'cup' | 'paper' | 'bag' | 'umbrella';

/** What the creator's screen sets. Colours are indices into CREATOR_PALETTES (-1: as the clothes come). */
export interface PersonOptions {
  count: number;
  sex: 'any' | 'female' | 'male';
  band: 'any' | 'child' | 'young' | 'adult' | 'senior';
  /** A cooked outfit name (`creatorCatalog().outfits`), or 'any'. */
  outfit: string;
  top: number;
  bottom: number;
  hair: number;
  /** 0.85..1.15 of the body's own height. */
  height: number;
  mode: CreatorMode;
  hold: CreatorHold;
  /** Mixed looks within the group (each person its own variation and colours where not fixed). */
  mixed: boolean;
}

export const DEFAULT_PERSON_OPTIONS: PersonOptions = {
  count: 6, sex: 'any', band: 'any', outfit: 'any', top: -1, bottom: -1, hair: -1, height: 1, mode: 'walk', hold: 'none', mixed: true,
};

/** Flags: a generic, customizable flag flown from a mast (a spire, a lantern's mast, a flagpole). */
export const FLAG_PATTERNS = [
  'solid', 'bicolourH', 'bicolourV', 'tricolourH', 'tricolourV', 'cross', 'nordic',
  'diagonal', 'saltire', 'canton', 'stripes', 'border', 'disc', 'chevron',
] as const;
type FlagPattern = (typeof FLAG_PATTERNS)[number];

export interface FlagDesign {
  readonly pattern: FlagPattern;
  /** Field, second and third colours (0xrrggbb). */
  readonly colours: readonly [number, number, number];
}

/** The designs of the first, fixed flags, kept so old maps fly the same flags. */
export function legacyFlag(flag: 'plain' | 'saoPaulo' | 'saoPauloState'): FlagDesign {
  if (flag === 'saoPaulo') return { pattern: 'cross', colours: [0xffffff, 0xc8102e, 0xc8102e] };
  if (flag === 'saoPauloState') return { pattern: 'stripes', colours: [0xffffff, 0x111418, 0xc8102e] };
  return { pattern: 'solid', colours: [0x3f688d, 0x3f688d, 0x3f688d] };
}

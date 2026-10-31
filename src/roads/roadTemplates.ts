// The player's road templates (profiles made in the section editor), kept in the browser: they serve every map.

import type { Profile } from './profiles.ts';
import { readStored, writeStored } from '../shared/storage.ts';

/** The player's templates, kept in the browser (they serve every map). */
export function readTemplates(): Array<Omit<Profile, 'id'>> {
  try {
    const raw = readStored('roadTemplates');
    const list = raw ? JSON.parse(raw) as Array<Omit<Profile, 'id'>> : [];
    return Array.isArray(list) ? list.filter((p) => p && Array.isArray(p.strips) && p.strips.length > 0) : [];
  } catch { return []; }
}
export function writeTemplates(list: Array<Omit<Profile, 'id'>>): boolean {
  return writeStored('roadTemplates', JSON.stringify(list));
}


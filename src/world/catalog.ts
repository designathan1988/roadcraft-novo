// The packed 38 Roadcraft 4.0 projects (catalogData.ts, written by data/lots-roadcraft/pack.mjs), decoded once.

import { CATALOG_BYTES, CATALOG_NAMES } from './catalogData.ts';
import { decodeCatalog, type CatProject } from './catalogFormat.ts';

export * from './catalogFormat.ts';

function fromBase64(s: string): Uint8Array {
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let projects: CatProject[] | null = null;
/** The 38 projects, decoded on first use (in each worker and on the page). */
export function catalogProjects(): CatProject[] {
  return projects ??= decodeCatalog(fromBase64(CATALOG_BYTES), CATALOG_NAMES);
}

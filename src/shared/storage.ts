// The browser storage (localStorage) the game keeps between runs: the names of its keys, in one place, and the move
// from the older Portuguese names. A value under an old name is moved to the new one the first time it is read, so a
// player's choices survive the rename. Without storage (blocked, private window, a worker) nothing is read or kept.

export const STORAGE = {
  settings: { key: 'roadcraft.settings', old: 'cidade.opcoes' },
  mapTiles: { key: 'roadcraft.mapTiles', old: 'cidade.mapa' },
  language: { key: 'roadcraft.language', old: 'cidade.idioma' },
  buildingDesigns: { key: 'roadcraft.buildingDesigns', old: 'cidade.modelos-predio' },
  roadTemplates: { key: 'roadcraft.roadTemplates', old: 'cidade.modelosDeVia' },
  developer: { key: 'roadcraft.dev', old: null },
} as const satisfies Record<string, { key: string; old: string | null }>;

export type StoredValue = keyof typeof STORAGE;

function store(): Storage | null {
  try { return (globalThis as { localStorage?: Storage }).localStorage ?? null; } catch { return null; }
}

/** The stored text of `what`, or null; a value still under the old name is moved to the new one. */
export function readStored(what: StoredValue): string | null {
  const s = store();
  if (!s) return null;
  const { key, old } = STORAGE[what];
  try {
    const v = s.getItem(key);
    if (v !== null || !old) return v;
    const was = s.getItem(old);
    if (was !== null) { s.setItem(key, was); s.removeItem(old); }
    return was;
  } catch { return null; }
}

/** Keeps `text` as `what`; false when the storage is full or blocked. */
export function writeStored(what: StoredValue, text: string): boolean {
  const s = store();
  if (!s) return false;
  try { s.setItem(STORAGE[what].key, text); return true; } catch { return false; }
}


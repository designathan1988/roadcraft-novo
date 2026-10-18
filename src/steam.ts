// Steam na página: só o que a casca Electron expõe (pelo preload). No navegador não há nada.

interface SteamBridge { info(): Promise<{ available: boolean; name: string }>; unlock(id: string): Promise<boolean> }

const bridge = (globalThis as { cidadeSteam?: SteamBridge }).cidadeSteam;
const done = new Set<string>();

/** Conquista (uma vez por sessão; o Steam guarda as permanentes). */
export function achieve(id: string): void {
  if (!bridge || done.has(id)) return;
  done.add(id);
  void bridge.unlock(id).catch(() => false);
}

export async function steamName(): Promise<string> {
  if (!bridge) return '';
  try { const i = await bridge.info(); return i.available ? i.name : ''; } catch { return ''; }
}

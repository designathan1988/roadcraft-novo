// Steam on the page: only what the Electron shell exposes (through the preload). In the browser there is nothing.

interface SteamBridge { info(): Promise<{ available: boolean; name: string }>; unlock(id: string): Promise<boolean> }

const bridge = (globalThis as { cidadeSteam?: SteamBridge }).cidadeSteam;
const done = new Set<string>();

/** Achievement (once per session; Steam keeps the permanent ones). */
export function achieve(id: string): void {
  if (!bridge || done.has(id)) return;
  done.add(id);
  void bridge.unlock(id).catch(() => false);
}

export async function steamName(): Promise<string> {
  if (!bridge) return '';
  try { const i = await bridge.info(); return i.available ? i.name : ''; } catch { return ''; }
}

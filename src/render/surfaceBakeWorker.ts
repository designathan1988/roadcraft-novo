// Bakes the procedural surfaces (render/surfaceRecipes.ts) off the main thread and sends each one's texels back,
// transferred; render/surfaceBake.ts fills its textures with them.
import { bakeAsphalt, bakeGrass, bakeTerrainNoise, bakeWaterNormals } from './surfaceRecipes.ts';

export type BakedSurface = 'asphalt' | 'grass' | 'water' | 'noise';

const scope = self as unknown as { onmessage: (() => void) | null; postMessage(m: unknown, t?: Transferable[]): void; close(): void };
scope.onmessage = () => {
  const send = (name: BakedSurface, data: Uint8Array) => scope.postMessage({ name, data }, [data.buffer as ArrayBuffer]);
  // the land's noise and the water first: the terrain draws before the roads and the lawns
  send('noise', bakeTerrainNoise());
  send('water', bakeWaterNormals());
  send('asphalt', bakeAsphalt());
  send('grass', bakeGrass());
  scope.close();
};

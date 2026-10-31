// Roadcraft 4.0's baked surface textures (public/cooked/surfaces, copied from the 4.0 project): grass, the land's
// detail/rock/dirt array, asphalt, footway, kerb, verge, concrete detail. Each is a texture made now with its final size
// and neutral texels (the image is the same as before they arrive), filled when the worker has read its file; the GPU
// makes the mipmaps. Colour maps hold sRGB texels: the shaders convert (sRGBTransferEOTF).

import * as THREE from 'three/webgpu';

type Fill = [number, number, number, number];

function tex(size: number, fill: Fill, layers = 1): THREE.DataTexture | THREE.DataArrayTexture {
  const n = size * size * layers, data = new Uint8Array(n * 4);
  // the same bytes as one set() per texel, in one fill (little-endian RGBA packed; 12 M calls at load before)
  new Uint32Array(data.buffer).fill(((fill[3] << 24) | (fill[2] << 16) | (fill[1] << 8) | fill[0]) >>> 0);
  const t = layers > 1 ? new THREE.DataArrayTexture(data, size, size, layers) : new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

const GREY: Fill = [128, 128, 128, 255], FLAT: Fill = [128, 128, 255, 255], ROUGH: Fill = [220, 220, 220, 255];

/** The surfaces, by file stem (the file is `<stem>.ktx2`). Sizes and layers as the 4.0 baked them. */
export const COOKED = {
  'terrain-grass.map': tex(1024, [74, 89, 49, 255]),
  'terrain-grass.normal': tex(1024, FLAT),
  /** Layers: 0 grass detail, 1 soil detail, 2..7 rock face/top (granite, sandstone, basalt), 8 dirt. */
  'terrain-land.map': tex(512, GREY, 9),
  'terrain-land.normal': tex(512, FLAT, 8),
  'asphalt.map': tex(512, [70, 72, 76, 255]),
  'asphalt.normal': tex(512, FLAT),
  'asphalt.rough': tex(512, ROUGH),
  'asphalt.detail': tex(512, GREY),
  'asphalt.detail-normal': tex(512, FLAT),
  'footway.map': tex(1024, [180, 176, 168, 255]),
  'footway.normal': tex(1024, FLAT),
  'footway.rough': tex(1024, ROUGH),
  'kerb.map': tex(256, [190, 188, 182, 255]),
  'kerb.normal': tex(256, FLAT),
  'kerb.rough': tex(256, ROUGH),
  'verge.map': tex(512, [92, 110, 60, 255]),
  'verge.normal': tex(512, FLAT),
  'concrete.detail': tex(512, GREY),
  'concrete.detail-normal': tex(512, FLAT),
} as const;
export type CookedName = keyof typeof COOKED;

/** Land array layers (4.0 `bake/catalogue.ts`). */
export const LAND = { GrassDetail: 0, SoilDetail: 1, GraniteFace: 2, GraniteTop: 3, Dirt: 8 } as const;

let started = false;
/** Surfaces filled so far (the stats and the checks read it). */
export const cookedLoaded = { count: 0, failed: [] as string[] };

/** Starts reading the files (once): each texture is filled and sent to the GPU again as its file arrives. */
export function loadCookedSurfaces(): void {
  if (started || typeof Worker === 'undefined' || typeof document === 'undefined') return;
  started = true;
  const w = new Worker(new URL('./cookedWorker.ts', import.meta.url), { type: 'module', name: 'cooked' });
  w.onmessage = (e: MessageEvent<{ file?: string; width?: number; layers?: number; data?: Uint8Array; error?: string; done?: boolean }>) => {
    const m = e.data;
    if (m.done) { w.terminate(); console.info(`cooked surfaces: ${cookedLoaded.count} read, ${cookedLoaded.failed.length} failed`); return; }
    const name = m.file!.replace(/\.ktx2$/, '') as CookedName;
    const t = COOKED[name];
    if (m.error || !m.data || !t) { cookedLoaded.failed.push(`${m.file}: ${m.error ?? 'unknown'}`); console.error('cooked surface', m.file, m.error); return; }
    const dst = t.image.data as Uint8Array;
    if (m.data.length !== dst.length) { cookedLoaded.failed.push(`${m.file}: ${m.data.length} bytes, expected ${dst.length}`); return; }
    // the worker's array becomes the texture's data (checked above: the same size): no copy on the main thread
    t.image.data = m.data;
    t.needsUpdate = true;
    cookedLoaded.count++;
  };
  w.postMessage({ base: new URL('cooked/surfaces/', document.baseURI).href, files: Object.keys(COOKED).map((k) => `${k}.ktx2`) });
}

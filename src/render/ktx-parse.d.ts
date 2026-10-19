// The part of three's bundled ktx-parse that render/cookedWorker.ts uses (it ships without types).
declare module 'three/examples/jsm/libs/ktx-parse.module.js' {
  export const KHR_SUPERCOMPRESSION_ZSTD: number;
  export interface KTX2Level { levelData: Uint8Array; uncompressedByteLength: number }
  export interface KTX2Container { pixelWidth: number; pixelHeight: number; layerCount: number; vkFormat: number; supercompressionScheme: number; levels: KTX2Level[] }
  export function read(data: Uint8Array): KTX2Container;
}

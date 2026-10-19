/** The part of three's bundled ktx-parse (`examples/jsm/libs`, Don McCurdy's KTX 2.0 reader) the finish loader uses. */
declare module 'three/examples/jsm/libs/ktx-parse.module.js' {
  export interface KTX2Level {
    levelData: Uint8Array;
    uncompressedByteLength: number;
  }
  export interface KTX2Container {
    vkFormat: number;
    pixelWidth: number;
    pixelHeight: number;
    layerCount: number;
    supercompressionScheme: number;
    /** Level 0, the largest, first. */
    levels: KTX2Level[];
  }
  export function read(data: Uint8Array): KTX2Container;
}

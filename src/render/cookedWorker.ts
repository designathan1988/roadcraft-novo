// Reads Roadcraft 4.0's baked surfaces (public/cooked/surfaces/*.ktx2: RGBA8, Zstandard supercompressed) off the main
// thread: fetches each file, undoes the Zstandard of its full-size level and sends the texels back (transferred). The
// smaller levels are left out: the GPU makes the mipmaps.
import { read, KHR_SUPERCOMPRESSION_ZSTD } from 'three/examples/jsm/libs/ktx-parse.module.js';
import { ZSTDDecoder } from 'three/examples/jsm/libs/zstddec.module.js';

interface Ask { base: string; files: string[] }
export interface CookedSurface { file: string; width: number; height: number; layers: number; data: Uint8Array }

const scope = self as unknown as { onmessage: ((e: MessageEvent<Ask>) => void) | null; postMessage(m: unknown, t?: Transferable[]): void };
scope.onmessage = async (e) => {
  const zstd = new ZSTDDecoder();
  await zstd.init();
  for (const file of e.data.files) {
    try {
      const res = await fetch(e.data.base + file);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const c = read(new Uint8Array(await res.arrayBuffer()));
      const level = c.levels[0];
      const data = c.supercompressionScheme === KHR_SUPERCOMPRESSION_ZSTD ? zstd.decode(level.levelData, Number(level.uncompressedByteLength)) : level.levelData.slice();
      const out: CookedSurface = { file, width: c.pixelWidth, height: c.pixelHeight, layers: Math.max(1, c.layerCount), data };
      scope.postMessage(out, [data.buffer as ArrayBuffer]);
    } catch (err) {
      scope.postMessage({ file, error: String(err) });
    }
  }
  scope.postMessage({ done: true });
};

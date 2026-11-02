// Reads Roadcraft 4.0's baked surfaces (public/cooked/surfaces/*.ktx2: RGBA8, Zstandard supercompressed) off the main
// thread: fetches each file, undoes the Zstandard of its full-size level and sends the texels back (transferred). The
// smaller levels are left out: the GPU makes the mipmaps.
import { read, KHR_SUPERCOMPRESSION_ZSTD } from 'three/examples/jsm/libs/ktx-parse.module.js';
import { ZSTDDecoder } from 'three/examples/jsm/libs/zstddec.module.js';

interface Ask { base: string; files: string[]; /** the BC7 folder, when the adapter reads BC */ bc7?: string }
export interface CookedSurface { file: string; width: number; height: number; layers: number; data: Uint8Array }

const scope = self as unknown as { onmessage: ((e: MessageEvent<Ask>) => void) | null; postMessage(m: unknown, t?: Transferable[]): void };
scope.onmessage = async (e) => {
  const zstd = new ZSTDDecoder();
  await zstd.init();
  for (const file of e.data.files) {
    try {
      if (e.data.bc7) {
        const r = await fetch(`${e.data.bc7}${file.replace(/\.ktx2$/, '.bc7')}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const all = new Uint8Array(await r.arrayBuffer());
        const head = new DataView(all.buffer, all.byteOffset, 12);
        const size = head.getUint32(0, true), layers = head.getUint32(4, true);
        const data = zstd.decode(all.subarray(12), head.getUint32(8, true));
        scope.postMessage({ file, width: size, height: size, layers, data, compressed: true }, [data.buffer as ArrayBuffer]);
        continue;
      }
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

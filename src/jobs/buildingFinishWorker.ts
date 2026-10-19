// Loads the building finishes once, off the main thread: the three cooked KTX2 arrays (zstd) are fetched, decoded
// and packed into the material's two arrays, sent back transferred. The page posts the folder's address.
import { read } from 'three/examples/jsm/libs/ktx-parse.module.js';
import { ZSTDDecoder } from 'three/examples/jsm/libs/zstddec.module.js';
import { COOKED_FILES, packFinishes } from './buildingFinishes.ts';

const post = (m: unknown, t: Transferable[] = []): void => (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(m, t);

self.onmessage = async (e: MessageEvent<{ base: string }>) => {
  try {
    const zstd = new ZSTDDecoder();
    await zstd.init();
    const level0 = async (file: string): Promise<Uint8Array> => {
      const res = await fetch(new URL(file, e.data.base));
      if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
      const c = read(new Uint8Array(await res.arrayBuffer()));
      const l = c.levels[0];
      return c.supercompressionScheme === 2 ? zstd.decode(l.levelData, l.uncompressedByteLength) : l.levelData;
    };
    const [map, normal, rough] = await Promise.all([level0(COOKED_FILES.map), level0(COOKED_FILES.normal), level0(COOKED_FILES.rough)]);
    const out = packFinishes(map, normal, rough);
    post(out, [out.albedo.buffer, out.normal.buffer]);
  } catch (err) {
    post({ error: String(err) });
  }
};

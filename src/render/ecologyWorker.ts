// Computes the ecology field (render/ecology.ts) tile by tile, off the main thread, reading the map's shared height and
// water buffers and writing into the shared field buffer; answers each tile's id when it is written.
import { ECO_RES, ecologyTile } from './ecology.ts';

interface Init { heights: SharedArrayBuffer; water: SharedArrayBuffer; field: SharedArrayBuffer }
let buf: { heights: Float32Array; water: Float32Array; field: Uint8Array } | null = null;
const scope = self as unknown as { onmessage: ((e: MessageEvent<Init | number>) => void) | null; postMessage(m: unknown): void };
scope.onmessage = (e) => {
  if (typeof e.data !== 'number') { buf = { heights: new Float32Array(e.data.heights), water: new Float32Array(e.data.water), field: new Uint8Array(e.data.field) }; return; }
  const tile = e.data, size = ECO_RES * ECO_RES * 4;
  // every tile asked is answered: a failure answers -1 - tile, so the page's queue never hangs on it (D34)
  if (!buf) { scope.postMessage(-1 - tile); return; }
  try {
    ecologyTile(buf.heights, buf.water, tile, buf.field.subarray(tile * size, (tile + 1) * size));
    scope.postMessage(tile);
  } catch (err) {
    console.error(`ecology tile ${tile}:`, err);
    scope.postMessage(-1 - tile);
  }
};

// The surfaces cooked in BC7 (tools/cook-bc7.mjs): a texture made as neutral RGBA turns into its compressed self when its
// file arrives, with its whole mip chain. The materials hold the texture object, so it stays the same object; three makes
// its GPU texture again from what it finds. An adapter without BC keeps reading the RGBA files.

import * as THREE from 'three/webgpu';

/** The adapter reads BC textures: decided by the scene once the device exists (`decideBc7`); the loaders wait for it. The
 *  surfaces are asked for in the game's constructor, before the scene: asked at once they went for the RGBA files every time. */
let decide: (on: boolean) => void = () => {};
export const bc7 = { on: false, ready: new Promise<boolean>((r) => { decide = r; }) };
export function decideBc7(on: boolean): void { bc7.on = on; decide(on); }

/** Three u32 before the zstd: size, layers, raw bytes. */
export const BC7_HEAD = 12;

type Flags = { isDataTexture?: boolean; isDataArrayTexture?: boolean; isCompressedTexture?: boolean; isCompressedArrayTexture?: boolean };

/** `t` becomes its BC7 self: `bytes` holds every level, largest first, all layers of a level together. */
export function becomeBc7(t: THREE.DataTexture | THREE.DataArrayTexture, bytes: Uint8Array, size: number, layers: number): void {
  const mipmaps: Array<{ data: Uint8Array; width: number; height: number }> = [];
  let at = 0;
  for (let s = size; ; s >>= 1) {
    const side = Math.max(1, s), n = Math.ceil(side / 4) ** 2 * 16 * layers;
    mipmaps.push({ data: bytes.subarray(at, at + n), width: side, height: side });
    at += n;
    if (side === 1) break;
  }
  t.dispose();
  const f = t as unknown as Flags;
  if (layers > 1) { f.isDataArrayTexture = false; f.isCompressedArrayTexture = true; } else { f.isDataTexture = false; f.isCompressedTexture = true; }
  (t as unknown as { mipmaps: typeof mipmaps }).mipmaps = mipmaps;
  (t as unknown as { image: unknown }).image = { width: size, height: size, depth: layers };
  t.format = THREE.RGBA_BPTC_Format as unknown as THREE.PixelFormat;
  t.generateMipmaps = false;
  // once uploaded only the levels' count is read again: the bytes leave the page
  t.onUpdate = () => { t.onUpdate = null; for (const m of mipmaps) m.data = new Uint8Array(0); };
  t.needsUpdate = true;
}

# Textures and large GPU buffers

Data: `data/textures.json` (`scripts/textures.ts`). KTX2 rows are read from the files' headers (KTX 2.0 layout:
vkFormat at byte 12, size at 20/24, layers at 32, levels at 40, supercompression at 44). Code-made rows are
transcribed from their creation sites (file:line below) with the sizes of `src/config.ts` etc. GPU sizes are what the
code uploads (format, layers, + 1/3 for mipmaps where it generates them); render-target depth formats are the
backend's choice, so those rows are estimates. Nothing was read back from the GPU.

## Cooked surfaces (`public/cooked/surfaces/*.ktx2`, Roadcraft 4.0's bakes)

All are **R8G8B8A8 (UNORM or SRGB), Zstandard-supercompressed, with a full mip chain in the file**. The worker reads
**only level 0**, undoes the Zstandard and uploads RGBA8; the GPU regenerates the mips (`render/cookedWorker.ts:1-3,
19-20`, `render/cookedSurfaces.ts:10-19`). No block compression (BC7 / ASTC) anywhere.

| File | Size | Layers | Levels in file | File KB | GPU MB as uploaded (RGBA8 + mips) | Same in BC7 |
|---|---|---|---|---|---|---|
| terrain-grass.map / .normal | 1024 | 1 | 11 | 2,049 / 2,843 | 5.33 + 5.33 | 1.33 + 1.33 |
| terrain-land.map (grass, soil, 3 rocks x 2, dirt) | 512 | 9 | 10 | 3,614 | 12.0 | 3.0 |
| terrain-land.normal | 512 | 8 | 10 | 5,347 | 10.67 | 2.67 |
| footway.map / .normal / .rough | 1024 | 1 | 11 | 1,264 / 1,598 / 710 | 3 x 5.33 | 3 x 1.33 |
| asphalt.map / .normal / .rough / .detail / .detail-normal | 512 | 1 | 10 | 186-782 | 5 x 1.33 | 5 x 0.33 |
| concrete.detail / .detail-normal | 512 | 1 | 10 | 250 / 817 | 2 x 1.33 | 2 x 0.33 |
| verge.map / .normal | 512 | 1 | 10 | 376 / 659 | 2 x 1.33 | 2 x 0.33 |
| kerb.map / .normal / .rough | 256 | 1 | 9 | 35-87 | 3 x 0.33 | 3 x 0.08 |
| **Subtotal (cooked surfaces)** | | | | | **62.3** | **15.5** |
| building-finishes.map / .normal / .rough (13 layers) | 512 | 13 | 10 | 1,001 / 1,546 / 42 | packed into the two finish arrays below | |

The `.rough` maps are separate RGBA8 textures holding one channel each (asphalt, footway, kerb): 4 bytes for 1.

## Made by the code

| Texture | Site | Size | Format | GPU MB |
|---|---|---|---|---|
| Building finishes, albedo | `render/city.ts:30-42` | 512 x 512 x 13 | RGBA8 sRGB + mips, aniso 8 | 17.33 |
| Building finishes, normal + metal | `render/city.ts:30-42` | 512 x 512 x 13 | RGBA8 + mips | 17.33 |
| Wall noise | `render/city.ts:62-81` | 128 x 128 | RGBA8 (2 channels used) | 0.08 |
| Terrain heights | `render/terrain.ts:152-158` | 256 x 256 x 100 | R32F | 25.0 |
| Road paint, fine | `render/terrain.ts:160-171` | 256 x 256 x 100 | RGBA8 | 25.0 |
| Road paint, coarse | `render/terrain.ts:172` | 32 x 32 x 100 | RGBA8 | 0.39 |
| Painted ground | `render/terrain.ts:173-179` | 128 x 128 x 100 | RGBA8 | 6.25 |
| Water level | `render/terrain.ts:180-186` | 128 x 128 x 100 | R32F | 6.25 |
| Ecology | `render/terrain.ts:188-195` | 128 x 128 x 100 | RGBA8 | 6.25 |
| Grass / asphalt / footway bakes | `render/surfaceBake.ts:56-151` | 3 x 512 | RGBA8 + mips | 4.0 |
| Rock albedo + normal | `render/surfaceBake.ts:191-223` | 2 x 512 | RGBA8 + mips | 2.67 |
| Water normals, terrain noise | `render/surfaceBake.ts:160-237` | 2 x 256 | RGBA8 + mips | 0.67 |
| Traffic occupancy | `render/roads.ts:40-46` | 512 x 256 | RGBA8 | 0.5 |
| Lane arrows | `render/roads.ts:47` | 512 x 256 | RG32F | 1.0 |
| Road profile table | `render/roads.ts:152` | 18 x 512 | RGBA32F | 0.14 |
| Signal states | `render/props.ts:150` | 512 x 256 | R8, re-uploaded every 250 ms | 0.13 |
| Sign atlas | `render/propMeshes.ts:181-260` | 1024 x 384 | canvas RGBA8 | 2.0 |
| Leaf atlas | `render/treeMeshes.ts:290-320` | 512 x 256 | canvas RGBA8 | 0.67 |
| **Tree impostor colour atlas** | `render/impostor.ts:73-81` | **6144 x 1024** | RGBA8 render target + mips | **32.0** |
| **Tree impostor normal atlas** | `render/impostor.ts:73-81` | **6144 x 1024** | RGBA8 render target + mips | **32.0** |
| Impostor depth buffers (kept with the targets, `props.ts:488`) | `render/impostor.ts:74` | 2 x 6144 x 1024 | depth (estimate 4 B) | ~48 |
| Street-name signs | `render/textSigns.ts:39-50` | 512 x 128 each | canvas RGBA8 | 0.33 each |
| Crater / soot decals | `features/demolition/blast/marks.ts:111-198` | 2 x 512 + 128 | canvas RGBA8 | 2.75 |
| Particles, clouds tables | `render/particles.ts:52`, `cloudShadow.ts:16` | 512 x 1, 24 x 2 | RGBA32F | 0.01 |
| Sun shadow cascades | `render/post.ts:73-80` | 3 x 2048 x 2048 | depth (estimate 4 B) | ~48 |

## Large storage buffers (not textures, for scale)

| Buffer | Site | Size |
|---|---|---|
| Props pool (pose, key, visible list) | `render/props.ts:33-36, 70-71, 142-145` | 28 MB |
| People palettes | `render/people/crowd.ts:103` | 23.7 MB |
| People vertices, attributes, index | `crowd.ts:100-102` | 4.5 MB |

Total of the rows above (textures + these buffers, without the screen-sized post targets): **~397 MB**.

## Findings

- **No GPU block compression.** BC7 (desktop WebGPU feature `texture-compression-bc`) is 1 byte per texel against 4:
  the cooked surfaces would go from 62.3 to 15.5 MB, the two finish arrays from 34.7 to 8.7 MB. The files already
  hold the mip chain the worker throws away.
- **Impostors: 64 MB of atlases and ~48 MB of depth kept for good** for 6 tree types at 128 px per view; the depth
  buffers are needed only while baking.
- **Single-channel data in four channels:** the `.rough` maps, the wall noise (2 of 4 used).
- **The CPU keeps a copy** of every DataTexture/DataArrayTexture it filled (`image.data`), e.g. the 25 MB height
  array is the world's own (shared, fine), but the cooked surfaces' 46 MB of level-0 texels stay in the page's heap
  after upload (read: `cookedSurfaces.ts:60-68` writes into `t.image.data`; nothing frees it). Not measured.

# People (the cooked crowd)

Data: `data/people.json` (`scripts/people.ts`, reading `public/cooked/people/people.{json,bin}` with the layout of
`render/people/format.ts`). Instance counts on screen come from the simulation and were not measured
(`tools/budget.json`: 36,379-58,319 pedestrians in the simulation per view, not on screen).

## How they are drawn (read, `render/people/crowd.ts`)

- 32 variations (MakeHuman CC0 bodies, clothes and hair; Rocketbox animations), 23 bones, 11 clips baked as bone
  palettes (22,528 frames). Cook: `tools/cook-people.mjs`, version 2.
- **Vertex pulling:** vertices, attributes, index and palettes live in storage buffers (`crowd.ts:100-103`); each level
  is one instanced draw of a dummy geometry with `maxTris[level] x 3` vertices (`:116-121`), so **every instance draws
  the level's maximum triangle count** and collapses the rest.
- Levels by height on screen: L0 above 60 px (`LOD0_PX`), L1 down to 15 px, L2 down to 3 px, dithered bands
  (`crowd.ts:26-34`). For a 1.7 m adult (1080p, 45 deg): **L0 to ~37 m, L1 to ~148 m, L2 to ~740 m**.
- Caps 2,048 / 8,192 / 16,384 instances per level (`:35`). Only level 1 casts a shadow, standing in for all levels
  within 90 m (`:32, 203, 219`).
- 3 draws for the whole crowd (+ the L1 shadow draw per cascade). The vehicles' simple figure (350 triangles) is drawn
  until the cooked file loads (`render/vehicles.ts`).

## Levels (measured over the 32 variations)

| Level | Max (drawn per instance) | Mean own triangles | Padding wasted | Held-thing triangles in it | Vertices referenced (mean) |
|---|---|---|---|---|---|
| L0 (> 60 px) | 4,138 | 3,980 | 158 (4 %) | 220 (5.5 %) | 2,722 |
| L1 (15-60 px) | 636 | 579 | 57 (9 %) | **220 (38 %)** | 436 |
| L2 (3-15 px) | 166 | 149 | 17 (10 %) | 52 (35 %) | 113 |

"Held things" are the phone, cup, bag, newspaper, umbrella (pole + 10-sided canopy) and bike helmet, modelled once per
body at the same count in every level (`tools/cook-people.mjs:470-505`, `budget: [12, 12, 12]` or the full count) and
shown by the shader only in the clip that holds them (`format.ts:15` `CLIP_PROP`). In the L1 band a person walking
without an umbrella still runs the umbrella's vertices.

L0 at 4,138 triangles is drawn only above 60 px tall (~37 m): ~70 triangles per pixel of height. L1 at 15-60 px has
~10-40 triangles per pixel of height; L2 at 3-15 px 11-55.

## Memory (measured from the file layout)

| Buffer | Size | Format |
|---|---|---|
| Palettes: 22,528 frames x 23 bones x 3 x 4 affine | **23.7 MB** | f32 storage |
| Vertex positions (89,188 x vec4) | 1.4 MB | f32 |
| Vertex attributes (normal oct, colour+region, joints, weights) | 1.4 MB | u32 x 4 |
| Index (451,935) | 1.8 MB | u32 |
| `people.bin` total | 28.2 MB (29,533,184 B) | |

The palettes are 84 % of the file and of the GPU memory; `docs/ESTADO.md` already names them as the thing to halve
(half precision). A quaternion + translation per bone would be 8 floats instead of 12.

## Sheet

- `sheets/people-levels.png`: 4 variations at L0 / L1 / L2 in the bind posture, every held thing visible (umbrella,
  newspaper...) as the mesh holds them. Not the game's shading (grey by region).

# Vegetation, ground clutter and impostors

Data: `data/props.json` (`scripts/propsCatalog.ts`), `data/views.json`. Trees and bushes are props-pool kinds
(see [props.md](props.md) for the pool: 56 B non-indexed vertices, GPU cull, indirect draws).

## Trees and bushes (measured)

Built by `render/treeMeshes.ts` (Roadcraft 4.0's low-poly style: a faceted heart in shade, a trunk of 6 sides, and
leaf cards that turn to the camera in the vertex shader, cut by the leaf atlas). Cards are stored as collapsed points
with their corner in `pext`, so in object space each card's two triangles are degenerate by construction: the
"cards" column counts them (degenerate / 2). Levels: `cardTree` near to 200 m, mid (35 % of the cards, 1.55 x their
size: `treeMeshes.ts:205`) to 650 m, octahedral impostor to 3,600 m (`render/propMeshes.ts:63-65`).

| Kind | L0 triangles (cards) | L1 triangles (cards) | L2 impostor | Height | Screen size at L1 start (200 m) / L2 start (650 m) |
|---|---|---|---|---|---|
| Mixed tree | 180 (34) | 56 (12) | 2 | 7.8 m | 51 px / 16 px |
| Yellow ipe (tree variant 3) | 240 (54) | 70 (19) | 2 | 7.1 m | 46 / 14 |
| Cypress (conifer) | 158 (70) | 68 (25) | 2 | 9.8 m | 64 / 20 |
| Oak | 282 (40) | 80 (14) | 2 | 6.7 m | 44 / 13 |
| Pink ipe (oak variant 3) | 240 (54) | 70 (19) | 2 | 7.1 m | 46 / 14 |
| Palm (frond strips, no cards) | 400 | 124 | 2 | 10 m | 65 / 20 |
| Shrub | 132 (26) to 130 m | 38 (9) to 420 m | - | 1.7 m | |
| Flowering bush | 112 (16) | 32 (6) | - | 1.9 m | |
| Hedge | 120 (20) to 150 m | 34 (7) to 480 m | - | 1.8 m | |

Trees are well balanced: ~3.5 triangles per screen pixel of height at the near/mid switch, 2 triangles past 650 m.
Cost to watch is not triangles but **alpha-tested cards**: each card discards outside the leaf (overdraw without
early depth for the cut fragments), and the mid level makes them 1.55 x larger. Not measured (needs the GPU).

Modelled street view: 6,718 mixed-tree impostors (13,436 triangles), 163 mixed trees at mid level, 3,737 oak
impostors; all street props and vegetation together are 132,932 triangles of the modelled 8.15 M frame.

## Ground clutter (props type Ground, split per variant: `propMeshes.ts:458-490, 585-590`)

One level only, drawn to 260 m. Variants 0-10: pebbles, gravel, chips, dry leaves, grass blades, reeds, clumps,
fronds, moss, flowers, mushrooms, each 72-256 triangles of ~1.5 m clumps; variant 11 is a **7.8 m palm (264 triangles)**
kept in the clutter type with the same 260 m distance and no lower level. At 260 m a 1.5 m clump is 7.5 px for
100-250 triangles; flowers 256 triangles with 48 tiny (< 1 cm^2) triangles.

## Grass tufts (terrain, not the pool)

`render/terrain.ts:44-64, 693-760`: 7 blades (7 triangles, 21 vertices, non-indexed) per tuft, a camera-locked
160 x 160 grid (0.9 m step), **always 25,600 instances = 179,200 triangles** while the eye is under 140 m; tufts
over roads, water or steep ground are skipped in the vertex shader (still submitted). One draw.

## Octahedral impostors (`render/impostor.ts`)

- 6 tree models (mixed, cypress, oak, palm, yellow ipe, pink ipe), each photographed from 8 x 8 hemi-octahedral
  directions at 128 x 128 px: two atlases (colour, normal) of **6,144 x 1,024 RGBA8 with mipmaps (32 MB each)**,
  rendered once at load (`impostor.ts:79-139`).
- Render targets made with `depthBuffer: true` (`impostor.ts:74`) and kept for the session (`render/props.ts:488`
  `impRT`): two 6,144 x 1,024 depth buffers (~24 MB each if 32-bit; the backend's choice, not measured) live as long
  as the atlases although nothing renders into them again.
- The far quad is 2 triangles (non-indexed, 6 vertices at 56 B).
- Screen size: at 650 m a 7 m tree is ~14 px; at 3,600 m ~2.5 px. The 128 px frame is mip-mapped down, so the atlas
  resolution costs memory, not bandwidth.

## Sheets

- `sheets/prop-mixed-tree-L0/L1/L2.png`, `prop-ipe-yellow-*`, `prop-oak-*`, `prop-cypress-*`, `prop-palm-*`,
  `prop-shrub-*`, `prop-ground-clutter-L0.png`. The cards render as collapsed points (shader-expanded); the sheet
  shows the trunk, heart and triangle count.

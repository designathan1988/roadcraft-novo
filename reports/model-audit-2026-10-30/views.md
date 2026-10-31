# What the budget views submit (modelled from the real meshes)

`scripts/views.ts`, seed 1 city (37,750 buildings, 20,220 segments), the four cameras of `tools/budget.mjs`
(target (0, 0), 1920 x 1080, 45 deg). For each layer the script picks the meshes the layer would draw by the layer's
own distance rules, culls them by box against the frustum, and adds their triangles; the props are banded per
instance as the cull pass does (`render/props.ts:184-215`). **Main view only**: no shadow cascades, no vehicles, people,
sky, clouds, particles or post. It is a model of the submission built from measured meshes, not a GPU count.

## Totals

| View | Eye (x, y, z) m | Modelled draws | Modelled triangles | Triangles per screen pixel | `tools/budget.json` (draws / triangles, GPU, all passes) |
|---|---|---|---|---|---|
| street (yaw 35, pitch 18, 90 m) | 49, 24, 70 | 206 | 8,150,240 | 3.9 | 485 / 17,524,287 |
| district (pitch 50, 420 m) | 155, 318, 221 | 82 | 4,846,678 | 2.3 | 227 / 13,198,493 |
| city (pitch 45, 2,200 m) | 892, 1,552, 1,274 | 187 | 4,494,259 | 2.2 | 179 / 3,370,273 |
| map (yaw 0, pitch 75, 11 km) | 0, 10,621, 2,847 | 207 | 4,354,798 | 2.1 | 211 / 4,403,720 |

(`docs/ESTADO.md` quotes a later budget run: street 418 / 11,483,609; district 175 / 7,103,905; city 123 / 4,002,312;
map 178 / 4,463,246.) The budget's triangles include the shadow cascades and the vehicles and people but **not the
props pool's instances** (three r186 counts an indirect draw as one instance: `RenderObject.js:617-629`,
`WebGPUBackend.js:2198`), so the two columns do not add up the same things. In the city view the model exceeds the
budget's count: the model draws every L1 cell up to 1,800 m and the tiles beyond; the game falls back to coarser
levels while cells are not ready and evicts under the 256 MB layer budget, which the model does not.

## By layer

| Layer | street draws | street triangles | district | city | map |
|---|---|---|---|---|---|
| buildings L0 cells (0-700 m) | 14 | 2,148,380 | 17 / 2,469,136 | - | - |
| buildings L1 cells (700-1,800 m) | 57 | 2,324,578 | 11 / 507,032 | 57 / 1,807,804 | - |
| buildings detail layer (0-150 m) | 3 | 146,446 | - | - | - |
| buildings L2 tiles (1,800-4,200 m) | 16 | 399,648 | - | 17 / 510,054 | - |
| buildings L3 plates (> 4,200 m) | 1 | 714 | - | 3 / 241,002 | 23 / 1,437,486 |
| roads L0 cells (0-600 m, no eye height) | 12 | 243,515 | 16 / 314,780 | 10 / 208,382 | 25 / 241,604 |
| roads L1 cells (600-1,400 m) | 43 | 204,302 | 12 / 54,026 | 72 / 319,811 | 113 / 360,893 |
| roads tiles, lod 1 (1,400-5,500 m) | 18 | 812,029 | - | 19 / 1,241,398 | 45 / 2,263,615 |
| terrain CDLOD patches | 1 | 206,848 (101 patches) | 1 / 96,256 | 1 / 124,928 | 1 / 51,200 |
| grass tufts (eye < 140 m) | 1 | 179,200 | - | - | - |
| props: street furniture and vegetation | 31 | 132,932 | 19 / 38,976 | 8 / 40,880 | - |
| props: 4.0 building parts | 9 | 1,351,648 | 6 / 1,366,472 | - | - |

Terrain seams (to 440 m) are not in the model; they add ~19 k triangles per road cell in reach (`roads.md`).

## The heaviest prop kinds per view (instances and triangles after the cull's bands)

| View | Kind | Level | Instances | Triangles each | Triangles |
|---|---|---|---|---|---|
| street | BBox (4 coincident boxes: concrete/shutter/fin/lamp) | 0 | 12,305 | 48 | 590,640 |
| street | BLot kind 2 (lotSlab mesh: where lotBoxes are misfiled) | 0 | 34,348 | 10 | 343,480 |
| street | BFrame (window frames) | 0 | 5,457 | 56 | 305,592 |
| street | BMisc kind 6 (roofRailing mesh) | 0 | 1,154 | 84 | 96,936 |
| street | Lamp | 2 | 1,282 | 12 | 15,384 |
| street | Tree (impostor) | 2 | 6,718 | 2 | 13,436 |
| street | Parked cars (3 kinds) | 1 | 54 | 504 | 27,216 |
| district | BBox | 0 | 14,865 | 48 | 713,520 |
| district | BFrame | 0 | 5,699 | 56 | 319,144 |
| district | BLot kind 2 | 0 | 26,074 | 10 | 260,740 |
| city | Lamp | 2 | 982 | 12 | 11,784 |
| city | Tree (impostor) | 2 | 5,570 | 2 | 11,140 |

Resident pool instances in the cells inside the frustum: street 452,757 (176 cells), district 434,620, city 689,241
(228 cells), map 680,635 (566 cells) against the pool's 1,048,576 slots (`render/props.ts:33`). The cull compute
runs over every used slot every frame.

## Reading

- **Street:** buildings 4.6 M (L1 cells beyond 700 m are as heavy as L0 cells near), building parts 1.35 M, roads
  1.26 M (two thirds of it in tiles beyond 1,400 m), terrain + grass 0.39 M, street props 0.13 M.
- **District:** looking down from 318 m, 4.85 M of which L0 buildings 2.47 M and building parts 1.37 M.
- **City:** buildings 2.56 M and roads 1.77 M at 700-5,500 m, where a building is 1-10 px tall.
- **Map:** roads 2.87 M (66 %), including 602 k in lod-0/lod-1 cells right under a camera 10.6 km up; buildings
  1.44 M in 23 plates. About 2 triangles per screen pixel for a view where a building is ~2 px.

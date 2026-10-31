# Model audit of Roadcraft 5 (roadcraft-novo-port), 2026-10-30

A census of every model the game draws (buildings, building parts, props pool, vegetation and impostors, roads and
terrain seams, vehicles, people, terrain and water, demolition pieces, textures), measured by running the game's own
mesh builders in Node, in the format of the old game's studies (`lab/roadcraft/reports/model-audit/models.md`,
`model-catalog/*`, `elements-optimization/*`, `geometry-optimization-research.md`). Analysis only: no game file was
changed; everything here lives in this folder.

## Start here

| File | What it holds |
|---|---|
| [Ranked problems](#ranked-problems) (below) | **The final summary**: problems by severity, with evidence (file:line) and numbers |
| [views.md](views.md) | What the 4 budget views submit, layer by layer (a model built from the real meshes) |
| [models.md](models.md) | One table of every piece and level measured (1,083 rows, sorted by triangles) |
| [buildings.md](buildings.md) | Building shells per level (cell L0/L1, detail, tile L2, plate L3), per kind, per cell |
| [props.md](props.md) | The props pool: street furniture, signals, wires, signs, parked cars, the 4.0 building parts |
| [vegetation.md](vegetation.md) | Trees, bushes, ground clutter, octahedral impostors, grass tufts |
| [roads.md](roads.md) | Road cells and tiles, materials (kerbs, zone strips), terrain seams |
| [vehicles.md](vehicles.md) | The 32 vehicle batches (near, glass, near-without-shadow, mid) |
| [people.md](people.md) | The cooked MakeHuman/Rocketbox crowd: levels, padding, held props, palettes |
| [terrain-water.md](terrain-water.md) | CDLOD terrain, shadow copy, grass, water grids, sky and weather meshes |
| [demolition.md](demolition.md) | Ruins (fractured shells), debris and wreck pools |
| [textures.md](textures.md) | Every texture and large GPU buffer: size, format, mips, memory |
| `sheets/*.png` | Contact sheets (shaded + wireframe, software-rendered here; not the game's shading) |
| `data/*.json, *.csv` | Raw numbers each table is built from |
| `scripts/*.ts` | The measuring scripts (run with `node <script>.ts` from `scripts/`) |

## Input (checked before measuring)

- **Code:** worktree `lab/roadcraft-novo-port`, branch `port/roadcraft-features`, HEAD `4af1c7e` (the worktree also
  had an uncommitted `CLAUDE.md` change by someone else; no script reads it). **Another session edited this worktree
  while the audit ran** (uncommitted, 13:25-13:28: `src/jobs/props.ts` lamp placement and tree crowns,
  `src/roads/build.ts`, `junction.ts`, new `src/roads/ground.ts`, `src/world/items.ts`, `src/tools/itemTool.ts`, i18n).
  Every measurement here finished by 13:21:36 (file times in `data/`), so the numbers are of HEAD; the line numbers
  cited for `src/jobs/props.ts` (69, 467) are HEAD's (`git show HEAD:src/jobs/props.ts`). Street props placement
  (lamps, wild trees) may differ after that session's change; no file under `src/render`, `src/r40` or the building
  and road generators was changed.
- **City:** grown live in Node by `scripts/city.ts`, which repeats `Game.generatedCity` (`src/game.ts:1835-1903`):
  terrain per tile (`generateTerrainTile`), `generateCity`, the terrain conformed (`conformTile`), lots per cell
  (`buildLots`, as `test/growth.test.ts` does it), every lot filled (`Growth.fillAll`). Not a cooked or saved city.
- **Seed 1, style classic, 10 x 10 tiles = 10,240 m map** (`MAP_TILES` 10): the seed the budget views use
  (`tools/budget.mjs` opens `?cidade&mapa=10`, `game.ts:517` seed = `?seed` or 1). Result: **37,750 buildings,
  20,220 road segments**. The segment count equals `tools/budget.json` (20,220); the building count does not
  (budget: 36,204; 4 % fewer). The cause of that difference was not found.
- A second city (seed 20261030, 31,044 buildings, 17,265 segments) was measured for buildings only:
  `data/seed20261030/`. Its numbers agree in kind with seed 1 (same L2 ~ L3, same part counts per building).
- **Screen:** 1080 rows, 45 deg vertical field of view (`render/cameraRig.ts:123`): pixels per metre = 1304 / distance
  (1.86 at 700 m, 0.72 at 1800 m, 0.31 at 4200 m, 0.12 at 11 km).

## Method

1. **Builders called directly** (all read-only imports of `src/`): `buildBuildings` at lod 0, 1, 2, 3 and -1 (detail
   layer) and `buildBuildingParts` (lod -2, the parts sink), exactly as `render/city.ts` asks for them per cell, tile and
   plate; `buildRoadMesh` per cell (lod 0/1) and per tile (lod 1) as `render/roads.ts` asks;
   `buildTerrainSeams` as `render/terrainSeams.ts`; `buildProps` per cell as `render/props.ts:508-520`;
   `buildPropDefs`/`buildPropKinds` (the pool's meshes); the `VehicleRenderer` constructed in Node and its batches'
   geometries read; `buildingForRuin` + `fractureBuilding` (the ruin worker); `people.bin` parsed with its layout.
2. **Measured per mesh:** vertices, triangles, indexed or not, bytes per vertex as uploaded (engine meshes: the
   cell layer's attributes, `render/cellLayer.ts:242-250`), weldable vertices (equal in every attribute to another),
   distinct positions (1 mm), degenerate (< 1e-8 m^2) and tiny (< 1 cm^2) triangles, duplicated triangles, bounding
   box, median edge.
3. **Screen size:** each level's largest size on screen at the distance it starts (1080p, 45 deg).
4. **Frame model (views.md):** the four budget cameras rebuilt (`tools/budget.mjs` VIEWS, eye from
   `render/cameraRig.ts:331`), each layer's choice of cell/tile/plate/level by distance as `render/cellLayer.ts` makes
   it, frustum culling by mesh box, the terrain quadtree as `render/terrain.ts:1048-1066`, the props per instance as the
   cull pass bands them (`render/props.ts:184-215`). Main view only.
5. **Contact sheets** rendered by a small software rasteriser (`scripts/raster.ts`): flat shading + vertex colour,
   orthographic, plus the wireframe. They show shape and triangle density, not the game's materials.

## What was not measured, and why

- **Nothing was run on the GPU.** No draw call, triangle or MB figure here comes from `renderer.info`; GPU timings
  were not taken. The view model leaves out the shadow cascades, vehicles, people, sky, particles and post (they
  depend on the simulation and the GPU). Where only the browser can tell, the files say "estimate from code".
- **Vehicle and pedestrian counts per view** (they come from the simulation worker). `tools/budget.json` reports
  them per view (e.g. street: 5,672 cars, 36,379 pedestrians in the simulation, not on screen).
- **Real fragment cost / overdraw** (needs a GPU capture). Overdraw findings are argued from geometry (coincident
  faces, discarded strips, sub-pixel parts), not measured in pixels.
- **The props pool on WebGL 2** (fallback path) was not modelled; the numbers are the WebGPU path.
- **Interiors / inside view, flags, text signs, previews, editor gizmos:** listed in passing, not measured.
- `scripts/views.ts` rounds the layers' hysteresis and eye-height details; it is a model of the submission, not a
  measurement of it.

## Rerun

```
cd reports/model-audit-2026-10-30/scripts
node propsCatalog.ts        # props pool kinds + 4.0 kit (1 s)        -> data/props.json, sheets/props-*, kit40-parts
node buildings.ts 1         # seed 1 city, buildings (~2 min)         -> data/buildings.json, building-cells.csv, sheets/building-*
node roadsAudit.ts 1        # roads + seams (~1.5 min)                -> data/roads.json, sheets/road-*
node roadMaterials.ts       # road triangles by material (~1.5 min)   -> data/road-materials.json
node views.ts 1             # the 4 budget views modelled (~2 min)    -> data/views.json
node vehicles.ts; node people.ts; node ruins.ts; node textures.ts; node variant-probe.ts
node models.ts              # rebuilds models.md from data/*.json
```

## Ranked problems

Seed 1 city, HEAD `4af1c7e`. "Read" = seen in the code; "measured" = counted by the scripts here in Node; "estimate" =
derived from code and counts, not seen in the game. **Nothing in this list was verified in the running game or on
the GPU.** Severity: **High** = large waste in the views the owner complains about, or a wrong image; **Medium** =
clear waste with a bounded cost; **Low** = small or cosmetic.

| # | Severity | Problem | Evidence | Size of it |
|---|---|---|---|---|
| 1 | High (wrong image + waste) | **92 % of the pooled 4.0 parts of the variant types are filed under another variant's mesh and collapsed by the vertex shader** (doors, AC units, lot boxes, lot rails, brises, awnings, glass rails: drawn as nothing, still paid for) | Read: the cull picks the kind from `(pose.w >> 12) & 15` (`render/props.ts:184`), but a part's `pose.w` is `partW(yaw, rgb)`, whose bits 12-15 are the colour's blue nibble (`jobs/parts40.ts:43-48`, written by `jobs/props.ts:467`); the shader's real variant comes from the key (`props.ts:327, 331`) and `wrongFace` collapses other variants' faces (`props.ts:345-347, 368`). Measured: `scripts/variant-probe.ts` over 160 buildings | 35,803 of 38,875 instances misfiled (lotBox 0 of 29,746 under its own mesh; door 0 of 462). **Not seen in a game photo: confirm with one before fixing** |
| 2 | High | **`BBox` draws 4 identical unit boxes per instance** (concrete, shutter, fin, lamp merged with no variant split): 48 triangles where 12 are needed, coplanar faces in 4 colours (z-fight risk), and it casts shadows | Read: `render/propMeshes.ts:514-536` merges every kind of a type; `BBox` is not in `VARIANT_TYPES` (`jobs/parts40.ts:23`); `props.ts:264` lets BBox cast. Measured: kind 62 = 48 triangles, 36 of them duplicates (`data/props.json`) | Street view: 12,305 instances, 590,640 triangles (the top kind); district: 713,520. The shadow passes repeat it |
| 3 | High (measurement) | **The props pool's instances are not counted by `game.stats()` / `npm run budget`**: three r186 counts an indirect draw as one instance | Read: `node_modules/three/src/renderers/common/RenderObject.js:617-629` (instanceCount 1 for a plain Mesh), `renderers/webgpu/WebGPUBackend.js:2171, 2198` (`info.update(object, count, instanceCount)`); the props draw indirectly (`props.ts:258`) | Modelled street view: 1.48 M prop triangles (1.35 M of them building parts) absent from the budget's count. Every prop finding here is invisible to the gate |
| 4 | High | **Building parts are too many and drawn too far for their size**: 408 pool instances per building; half are `lotBox` (posts, slats, 2-28 cm boxes), drawn to 800 m by type, not by size | Measured: 2,813,521 part instances in the 144 densest cells (6,903 buildings): lotBox 1,407,781, frame 562,472, concrete 351,080 (`data/buildings.json` partCount). Read: `PART_DIST` per type (`jobs/parts40.ts:25-27`) | At 800 m a pixel is 0.61 m: a 5 cm post is 0.08 px. Median 20,359 parts per dense cell; the ~42 cells inside `PARTS_RANGE` (928 m) need ~0.85 M of the pool's 1,048,576 slots (estimate); the cull compute runs over every used slot every frame |
| 5 | High | **Roads have no level beyond lod 1, and a road tile is exactly the sum of its cells**, drawn to 5,500 m | Measured: 74 tiles = 3,244,192 triangles = all 943 cells at lod 1, 3,244,192 (`data/roads.json`). Read: `render/roads.ts:95-105` (tile = lod 1), `jobs/roadMesh.ts:196` (only 3 m / 10 m steps) | Map view: roads 2.87 M of 4.35 M modelled triangles (66 %); city view 1.77 M |
| 6 | High | **Road (and terrain-seam) levels ignore the eye's height**: from 10 km up the cells under the camera are drawn at lod 0 | Read: `render/roads.ts:105` passes no `eyeHeight`; `render/cellLayer.ts:188-192` adds the height only when given (buildings give it: `render/city.ts:102`) | Map view (eye 10.6 km up): 25 lod-0 + 113 lod-1 road cells, 602 k triangles, 138 draws (modelled) |
| 7 | High | **The buildings' plate level (L3) is no cheaper than the tile level (L2)** | Measured: 38.1 vs 41.6 triangles per building; most kinds identical at L2 and L3 (`data/buildings.json`). Read: `jobs/building40.ts:334-337` (L3 drops volumes under 8 m instead of 3 m, nothing else) | Map view: 23 plates, 1.44 M triangles at 0.12 px/m (a 15 m building ~2 px wide) |
| 8 | High | **Moving vehicles keep the full model to 200 m and a 536-triangle silhouette to 1,700 m**, non-indexed, 48 B/vertex | Measured: sedan 8,242 triangles, 24,726 vertices, 72 % weldable, 631 degenerate; the same model 90-200 m without shadow (`data/vehicles.json`). Read: `render/vehicles.ts:23-24, 395, 650-676` | At 200 m a 4.4 m car is 29 px long for 8 k triangles; at 1,700 m 3.4 px for 536. Parked cars: 5,828 triangles to 55 m, 504 to 320 m |
| 9 | High | **Ruins are 7-24 x the intact building, non-indexed, with no level of detail** | Measured: 15,188-101,184 triangles per ruin, 36 B/vertex, 87 % weldable, 1.6-10.7 MB each; fracture 0.2-2.2 s per building in Node (`data/ruins.json`). Read: `features/demolition/ruin/ruinMesh.ts:15-16, 90-100` (32 slots, shadow, no index) | 32 ruins can hold ~340 MB of vertices and ~3 M shadow-casting triangles. Consistent with the owner's "bomb at 100 % CPU/GPU" (inference, not measured) |
| 10 | Medium | **Kerbs are 38 % of road triangles and stay in the far levels; zone strips (9-11 %) are always submitted and discarded per fragment** | Measured: lod 0 kerbs 5,646,050 of 14,726,532; lod 1/tile 917,748 of 3,244,192; zone strips 1,296,492 / 346,432 (`data/road-materials.json`). Read: strips always built (`jobs/roadMesh.ts:286-303`), hidden by `maskNode` (`render/roads.ts:489-492`), so the whole road material alpha-tests | A 15 cm kerb at 1,400 m is 0.17 px. 1,160 degenerate triangles in the heaviest lod-0 cell |
| 11 | Medium | **Building L0 and L1 are dense for their distance** | Measured: L0 2,284, L1 795 triangles per building in the centre; L0 cell median 104,530 (max 213,702) triangles, 5.2 MB; 138 of 144 cells need 32-bit indices; 1.56 vertices per triangle (`data/building-cells.csv`) | At 1,800 m (L1's far end) a building is ~11 x 22 px for ~800 triangles. Modelled street view: 4.5 M building triangles |
| 12 | Medium | **Every prop mesh is non-indexed at 56 B/vertex** (position f32x3, normal f32x3, pcol f32x4, pext f32x4); the 4.0 kit models are indexed at source and flattened | Read: `render/propMeshes.ts:34-47` (`toNonIndexed`), `:623-645`. Measured: 50-73 % weldable vertices (parked car 12,751 of 17,484) | 3 vertex-shader runs per triangle for ~1.5 M pooled triangles in the street view |
| 13 | Medium | **People draw their held things at every level** (phone, cup, bag, newspaper, umbrella, helmet), hidden in the shader | Measured: 220 of 579 mean L1 triangles (38 %), 52 of 149 at L2 (`data/people.json`); every instance draws `maxTris` (4,138 / 636 / 166) | Palettes 23.7 MB in f32 |
| 14 | Medium | **Textures are uploaded uncompressed (RGBA8) and the impostor atlases keep depth buffers** | Measured: KTX2 headers R8G8B8A8 + Zstandard, 9-11 levels of which only level 0 is read (`render/cookedWorker.ts:19`). Read: `render/impostor.ts:73-81`, `props.ts:488` keeps the targets | Cooked surfaces 62.3 MB (BC7: 15.5 MB) + finish arrays 34.7 MB (BC7: 8.7 MB); impostor atlases 64 MB + ~48 MB depth (estimate) |
| 15 | Low | Grass tufts always 25,600 x 7 triangles below 140 m eye height; near water tiles 32,768 triangles each (32-bit index) | Read: `render/terrain.ts:44-64, 236-250, 698-720` | 179,200 triangles in the street view |
| 16 | Low | Stale comment "Four draw calls for the whole fleet" | Read: `render/vehicles.ts:4`; the renderer builds 32 batches + 3 crowd levels | Documentation |

### What is fine

- **Terrain:** one instanced CDLOD draw, 2,048-triangle patches, 101 patches in the street view (207 k triangles).
- **Trees:** 158-400 triangles near (to 200 m), 56-124 mid (to 650 m), a 2-triangle octahedral impostor to 3,600 m.
- **Quantised building and road vertices:** 24 B and 32 B per vertex with 16-bit positions (15.6 mm steps in cells,
  62.5 mm in tiles).
- **Building shells carry no waste of their own:** 0 degenerate triangles, ~0.1 % weldable vertices, a handful of
  duplicated triangles per cell.
- **People:** one draw per level for the whole crowd (vertex pulling), 3 levels by screen height (60 / 15 / 3 px).

### Order suggested by gain and risk (each change needs before/after photos and counts, per CLAUDE.md)

1. Measurement first: count the props pool's instances in `game.stats()` (#3), or the budget cannot see the rest.
2. #1 and #2: the props packing (the cull's variant from the key; split `BBox` or give it variants). The image changes
   only where parts reappear.
3. #4 parts filed by their size on screen (4.0's `partFiling.ts` rule), then #12 indexed pool meshes.
4. #5, #6, #10 roads: a coarse tile level without kerbs and zone strips; eye height in the road layer.
5. #8 vehicles, #9 ruins: simplified levels (meshoptimizer, as the old game did:
   `lab/roadcraft/reports/geometry-optimization-research.md`), indices, a ruin level by distance.
6. #7, #11 buildings: an L3 that reduces (drop walls under a pixel), L1 density by distance.
7. #13, #14: held things in their own small draw; BC7/ASTC textures (WebGPU `texture-compression-bc`).

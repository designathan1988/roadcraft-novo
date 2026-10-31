# Demolition: ruins, debris, wrecks, marks

Data: `data/ruins.json` (`scripts/ruins.ts`: `buildingForRuin` + `fractureBuilding` exactly as
`features/demolition/ruin/worker.ts` calls them, on flat ground, one building per case). The rest is read.

## Ruins (measured)

A struck building is laid again with every part as geometry, cut into Voronoi fragments of ~2.8 m (larger when it would
exceed 480 fragments), each with wall thickness behind its faces and a side along every cut
(`ruin/fracture.ts:1-8, 51-58, 122`). The fragments are one **non-indexed** buffer in the building material's format
plus a fragment index: position f32x4 (16 B), normal 4, colour 4, facade 4, wall uv 4, frag f32 4 = **36 B/vertex**
(`ruin/ruinMesh.ts:90-100`). The parts and furniture go to one BatchedMesh of kit models (16,384 slots,
`ruinMesh.ts:17, 70-79`).

| Case | Intact L0 shell triangles | Ruin triangles | x intact | Vertices | Weldable | Fragments | Attached part instances | MB | Fracture time (Node) |
|---|---|---|---|---|---|---|---|---|---|
| house, 2 floors | 626 | 15,188 | 24 | 45,564 | 40,117 (88 %) | 82 | 290 | 1.6 | 251 ms |
| apartments, 4 floors | 2,808 | 67,048 | 24 | 201,144 | 176,546 | 240 | 523 | 6.9 | 877 ms |
| mixed, 8 floors | 10,080 | 94,210 | 9 | 282,630 | 245,508 | 317 | 1,233 | 9.7 | 2,156 ms |
| commercial, 16 floors | 8,892 | 101,184 | 11 | 303,552 | 264,737 | 325 | 1,175 | 10.4 | 333 ms |
| commercial, 30 floors | 3,608 | 69,154 | 19 | 207,462 | 183,702 | 454 | 1,020 | 7.1 | 176 ms |

- Up to **32 ruins** at once (`MAX_RUINS`, `ruinMesh.ts:15`): at ~10 MB and ~95 k triangles each, up to ~340 MB of
  vertex data and ~3 M triangles, each ruin one draw that **casts shadows** (`ruinMesh.ts:64`) and has **no level by
  distance** (the same mesh at 20 m and at 2 km).
- Every fragment's pose is a row in one storage buffer (`MAX_FRAGMENTS` 16,384 x 5 vec4 = 1.3 MB) and the vertex
  shader moves each vertex by its fragment: cost is per vertex, and these meshes have 3 vertices per triangle with
  88 % exact copies.
- The fracture runs off the page (a ruin worker), 0.2-2.2 s per building in Node.
- The owner reports "bomb wrong and 100 % CPU/GPU when used". These numbers are consistent with a GPU cost (a few
  ruins = several hundred thousand shadow-casting, non-indexed triangles), but that link is an inference: no GPU
  measurement was taken.

## Debris and wrecks (read, `blast/debris.ts`)

| Pool | Shape | Cap | Draw |
|---|---|---|---|
| Box, cylinder (9 sides), broken slab (extruded jagged outline, bevelled), car shell (extruded side) | 12 / 36 triangles; slab and shell: extruded outlines (not measured) | 1,400 pieces each (`MAX_PIECES`) | one InstancedMesh per shape, shadows |
| Burnt vehicles: one per model (5 cars, motorbike, bus, truck) | the full near model with glass (`blast.ts:225-238 centred`): 6,870-7,902 triangles per car, 540 motorbike, 3,226 bus, 2,426 truck (measured, `data/vehicles.json` wreckModels) | 48 each (`WRECKS`) | one InstancedMesh per model, shadows, double-sided carcass material |

Pieces at rest cost nothing on the CPU (matrices rewritten only while moving: `debris.ts:1-8`); on the GPU every piece
and wreck is drawn every frame at full detail with shadows. 48 wrecks of one car model = up to ~380 k triangles.

## Marks (read, `blast/marks.ts`)

Crater and soot decals from canvases (512 x 512 and 128 x 128), a crater mesh with its rim heaved in slabs; small.

## Sheets

- `sheets/ruin-house-2-floors.png`, `ruin-apartments-4-floors.png`, `ruin-mixed-8-floors.png`,
  `ruin-commercial-16-floors.png`, `ruin-commercial-30-floors.png`: the fractured shell before it falls (wireframe
  shows the fragment cuts).

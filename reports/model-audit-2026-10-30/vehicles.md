# Vehicles

Data: `data/vehicles.json` (`scripts/vehicles.ts`: the `VehicleRenderer` is constructed in Node and its batches'
geometries are read). Counts on screen depend on the simulation and were not measured; `tools/budget.json` reports
5,672-13,409 cars in the simulation for the budget views.

## How they are drawn (read, `render/vehicles.ts`)

- Poses from the simulation worker, interpolated on the page; per vehicle a level by distance: **near model to 200 m**
  (`NEAR`, `:23`) with a shadow **to 90 m** (`SHADOW_NEAR`, `:395`), the same model without shadow and with a blob
  shadow from 90 to 200 m (`nearFar`, `:668`), a silhouette (cars) or a scaled box (buses, trucks, people, bikes)
  **to 1,700 m** (`MID`, `:24`); beyond, "density cars" are painted by the road shader.
- Every batch is an `InstancedBufferGeometry` with per-instance `ipos`, `iinfo`, `iprev` (f32x4 each, 48 B per
  instance, re-uploaded by update range each frame). **32 batches** (11 near, 7 glass, 8 near-without-shadow, 1 mid
  box, 5 mid cars) + 3 crowd levels: up to 35 draws plus shadow passes of the 11 near ones (empty batches are skipped:
  three r186 `RenderObject.js:629`). The file's header still says "Four draw calls for the whole fleet" (`:4`).
- Near bodies are drawn double-sided (the cabin seen through the glass, `:460-470`); glass is a separate transparent
  draw.
- Vertex format **48 B, non-indexed** (position, normal, colour f32x3; paint, glow, limb f32): `tagged()` and
  `fromBody()` call `toNonIndexed()` (`:115-117, 182-184`).

## Batches (measured)

| Batch | Model | Triangles | Vertices | Weldable | Degenerate | Cap | Shadow | Two-sided |
|---|---|---|---|---|---|---|---|---|
| near 0-90 m | car sedan | 8,242 | 24,726 | 17,795 (72 %) | 631 | 6,000 | yes | yes |
| near | car hatch | 7,830 | 23,490 | 16,687 | 532 | 6,000 | yes | yes |
| near | car SUV | 7,770 | 23,310 | 16,520 | 474 | 3,000 | yes | yes |
| near | car van | 6,891 | 20,673 | 14,718 | 184 | 3,000 | yes | yes |
| near | car pickup | 8,222 | 24,666 | 17,915 | 748 | 3,000 | yes | yes |
| near | motorbike (+ rider) | 540 | 1,620 | 746 | 0 | 3,000 | yes | no |
| near | bus | 3,134 | 9,402 | 3,532 | 0 | 1,024 | yes | yes |
| near | truck | 2,398 | 7,194 | 2,874 | 0 | 1,024 | yes | yes |
| near | person (simple, until the crowd loads) | 350 | 1,050 | 668 | 0 | 8,000 | yes | no |
| near | rail wagon | 96 | 192 | 0 (indexed) | 0 | 512 | yes | no |
| near | bicycle (+ rider) | 510 | 1,530 | 1,014 | 0 | 2,000 | yes | no |
| glass | sedan / hatch / SUV / van / pickup | 312 / 448 / 448 / 432 / 264 | | | 8-24 | | no | yes, transparent |
| glass | bus / truck | 92 / 28 | | | 0 | 1,024 | no | yes, transparent |
| near 90-200 m (+ blob) | sedan / hatch / SUV / van / pickup | 7,904 / 7,628 / 7,536 / 6,872 / 7,900 | ~23 k | 72 % | 204-756 | as near | no | no |
| near 90-200 m (+ blob) | motorbike / bus / truck | 542 / 3,228 / 2,428 | | | 0 | | no | no |
| mid 200-1,700 m | scaled box (bus, truck, people, bikes) | 12 | 24 (indexed) | 0 | 0 | 30,000 | no | no |
| mid 200-1,700 m | car silhouettes sedan / hatch / SUV / van / pickup | 536 / 536 / 536 / 488 / 536 | 1,608 | 47 % | 0 | 15,000 | no | no |

## Screen size against triangles

| Level | Distance | A 4.4 m car on screen (1080p, 45 deg) | Triangles |
|---|---|---|---|
| near | 10 m | 570 px | 8,242 |
| near, no shadow | 90 m | 64 px | 7,904 |
| near, no shadow | 200 m (end) | **29 px** | 7,904 |
| mid silhouette | 200 m | 29 px | 536 |
| mid silhouette | 1,700 m (end) | **3.4 px** | 536 |

The near model spans 570 px down to 29 px with the same 8 k triangles; the step to the next level is 15 x. The 4.0 had
a meshoptimizer ladder for its cars (`lab/roadcraft/reports/elements-optimization/vehicle-hubs/summary.md`: e.g.
a sedan's level at 1.25 px/m 333 -> 217 triangles).

## Mesh quality

- 72 % of a car's vertices are exact copies (non-indexed); 500-750 degenerate triangles per car body (the 4.0 body's
  rounded-edge stations at 24 x 8 x 3, `vehicles.ts:221` `buildCarBody(a, style, 24, 8, 3)`), 300-570 under 1 cm^2.
- Wheels: 12-sided tyre, ring, 10-sided hub and 5 spoke boxes per wheel, rolled and steered in the vertex shader.

## Wrecks (blast)

The burnt-out wrecks are the full near models with glass (`wreckModels`, 6,870-7,902 triangles per car), one InstancedMesh per
model with 48 slots, drawn at any distance with shadows (`features/demolition/blast/debris.ts:86-96`). See
[demolition.md](demolition.md).

## Sheets

- `sheets/vehicles-batches.png`: all 32 batches (wheels look purple: their colour slot holds the wheel centre).
- `sheets/vehicle-near-sedan.png`, `-bus.png`, `-truck.png`, `-motorbike.png`.

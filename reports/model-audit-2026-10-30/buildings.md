# Buildings

Seed 1 city (37,750 buildings), HEAD `4af1c7e`. Data: `data/buildings.json`, `data/building-cells.csv`
(`scripts/buildings.ts`); second city in `data/seed20261030/`.

## How they are drawn (read)

| Level | Built by | Unit | Distance (eye height counted) | Draw |
|---|---|---|---|---|
| detail (lod -1) | `buildBuildings(..., -1)`: window reveals, sills of the generic (non-4.0) buildings and catalogue landmarks | cell 256 m | 0-150 m (`render/city.ts:127-129`, near 1,100, no shadow) | 1 mesh per cell |
| L0 (lod 0) | 4.0 `layLot40` shell + panes and pool water (`jobs/building40.ts` COARSE_PARTS); other parts go to the props pool | cell | 0-700 m | 1 mesh per cell, casts shadows |
| L1 (lod 1) | 4.0 facade level (`layLot40(..., true)`), no small parts | cell | 700-1,800 m | 1 mesh per cell |
| L2 (lod 2) | `massLot40`, `TILE_DETAIL` (drops volumes < 3 m) | tile 1,024 m | 1,800-4,200 m | 1 mesh per tile |
| L3 (lod 3) | `massLot40`, `PLATE_DETAIL` (drops volumes < 8 m) | plate 2,048 m | > 4,200 m | 1 mesh per plate |

`render/city.ts:102`: `near 1800, evict 3000, detail 700, plate 4200, budget 256e6`. One material for the whole layer
(`createBuildingMaterial`: finish texture array, facade windows in the shader). Vertex format
(`jobs/meshBuilder.ts:122-158`, `render/cellLayer.ts:242-250`): position snorm16x4 (8 B, w = building tag), normal
oct snorm8x4 (4 B), colour+material unorm8x4 (4 B), facade unorm8x4 (4 B), wall uv snorm16x2 (4 B) = **24 B/vertex**,
16-bit index under 65,536 vertices, else 32-bit. Positions are quantised to the mesh's extent: 15.6 mm steps in cells
(extent doubles to 512 m when a building overhangs), 62.5 mm in tiles.

## Whole layer (measured)

| Level | Meshes measured | Buildings | Triangles | Vertices | GPU bytes | Triangles / building | Notes |
|---|---|---|---|---|---|---|---|
| L0 cells | 144 (3 x 3 densest tiles round tile 36) | 6,903 | 15,764,182 | 24,881,422 | 786 MB | 2,284 | 138 of 144 cells need 32-bit indices |
| L1 cells | 144 | 6,903 | 5,491,108 | 8,528,695 | 250 MB | 795 | |
| detail cells | 144 | 6,903 | 755,550 | 1,511,100 | 43 MB | 109 | only generic/catalogue buildings have any |
| L2 tiles | 70 (all) | 37,750 | 1,571,010 | 3,192,101 | 88 MB | 41.6 | max 37,780 per tile |
| L3 plates | 23 (all) | 37,750 | 1,437,486 | 2,852,891 | 85 MB | 38.1 | max 124,398 per plate; 17 of 23 need 32-bit indices |

Per cell (144 dense cells): L0 median 104,530 triangles (p90 166,798, max 213,702), 5.2 MB (p90 8.3 MB, max 10.6 MB);
L1 median 36,366 (max 77,140), 1.6 MB. Worker time in Node per cell: L0 117 ms median (max 255), L1 62 ms, parts 86 ms.

**L3 is no cheaper than L2:** 38.1 vs 41.6 triangles per building (-8 %); in the per-kind table below most kinds have
exactly the same count at L2 and L3. `jobs/building40.ts:334-337` changes only which small volumes are dropped.
At 4,200 m (0.31 px/m) a 15 x 30 m building covers about 5 x 9 px; at the map view (11 km, 0.12 px/m) about 2 x 4 px,
for ~38 triangles each.

**L1 at its far end:** at 1,800 m (0.72 px/m) a typical 15 x 30 x 15 m building is ~11 x 22 px; it carries ~800
triangles there (~3 per pixel of its footprint on screen).

## Mesh quality (measured on the 6 heaviest L0 cells, their L1 and detail, and the busiest tile)

| Mesh | Triangles | Vertices | Distinct positions | Weldable | Degenerate | Duplicated | Quantum |
|---|---|---|---|---|---|---|---|
| cell 622 L0 | 213,702 | 333,239 | 156,544 | 243 | 0 | 12 | 15.6 mm |
| cell 622 L1 | 66,826 | 102,356 | 56,971 | 1,020 | 0 | 12 | 15.6 mm |
| cell 703 L0 | 209,470 | 325,848 | 152,196 | 190 | 0 | 16 | 15.6 mm |
| cell 703 detail | 30,560 | 61,120 | 29,616 | 2,904 | 0 | 0 | 7.8 mm |
| cell 383 L0 | 199,268 | 307,978 | 145,215 | 109 | 0 | 2 | 15.6 mm |
| tile 36 L2 | 37,576 | 76,534 | 34,755 | 11,167 | 0 | 0 | 62.5 mm |

The shells are clean: no degenerate triangles, almost no exact duplicates. The cost is structural: flat-shaded quads
(4 vertices per face, each position used by ~2.1 vertices for its different normals), 1.56 vertices per triangle.
L2 tiles have 15 % weldable vertices (identical copies the builder emits).

## By kind (one building of each kind, laid alone; 185 kinds; first 20 by count)

L0..L3 triangles of the shell; "parts" = props-pool instances the parts pass sends for it, "part tris" = the triangles
those instances draw in the pool (each type's mesh, `data/props.json`).

| Kind | In city | Floors | L0 | L1 | L2 | L3 | Detail | Parts | Part tris |
|---|---|---|---|---|---|---|---|---|---|
| Residential 1-2 fl Bangalo | 7,801 | 2 | 1,038 | 632 | 26 | 26 | 0 | 412 | 5,336 |
| Residential 1-2 fl Sobrado | 6,466 | 2 | 1,096 | 386 | 46 | 42 | 0 | 363 | 7,770 |
| Residential 1-2 fl Casa moderna | 4,927 | 1 | 1,424 | 676 | 46 | 42 | 0 | 444 | 14,762 |
| Residential 1-2 fl Casa colonial | 4,409 | 1 | 528 | 348 | 42 | 34 | 0 | 381 | 4,582 |
| Industrial 1-2 fl | 2,684 | 2 | 390 | 50 | 50 | 10 | 3,344 | 0 | 0 |
| Residential 3-5 fl Contemporaneo | 831 | 5 | 4,108 | 1,008 | 74 | 74 | 0 | 657 | 28,562 |
| Residential 3-5 fl Tropical | 789 | 4 | 2,420 | 718 | 36 | 36 | 0 | 430 | 11,700 |
| Residential 3-5 fl Modernista | 698 | 4 | 4,154 | 1,608 | 68 | 68 | 0 | 721 | 26,720 |
| Residential 3-5 fl Tijolinho | 569 | 5 | 3,846 | 1,098 | 62 | 62 | 0 | 636 | 30,352 |
| Mixed 6-10 fl Tropical | 569 | 10 | 6,910 | 1,336 | 54 | 54 | 0 | 791 | 26,584 |
| Residential 3-5 fl Bangalo | 568 | 3 | 2,018 | 966 | 40 | 40 | 0 | 344 | 9,460 |
| Mixed 6-10 fl Contemporaneo | 488 | 6 | 2,454 | 1,210 | 30 | 30 | 0 | 234 | 8,192 |

The full table (185 kinds, with vertices, footprint, weldable, duplicates and the part kinds) is
`data/buildings.json` `catalogue`; every kind and level is also a row of [models.md](models.md).

**Parts dominate the near cost.** A 2-floor house is ~1,000 shell triangles and ~400 part instances (5-15 k
triangles); a 10-floor block 6,910 shell triangles and 791 parts (26.6 k triangles). In the 144 dense cells:
2,813,521 part instances (408 per building): lotBox 1,407,781, frame 562,472, concrete 351,080, fin 110,011,
lotSlab 92,628, lotRail 42,284, louvre 37,044, shutter 34,016, roofRailing 28,823, brise 23,933, lamp 23,383,
awning 22,299, door 17,197, glassRail 16,233, acUnit 14,447 ... (see [props.md](props.md) for how they are drawn and
the two packing defects that hide or quadruple them).

## Sheets

- `sheets/building-kinds-L0.png`: the 36 most common kinds at L0.
- `sheets/building-levels-*.png`: the 6 most common kinds, L0 / L1 / L2 / L3 / detail side by side (wireframe):
  L2 and L3 identical for the residential kinds.
- `sheets/building-cell-622-L0.png`, `-L1.png`: the heaviest cell (213,702 / 66,826 triangles, one draw each).

## Problems (ranked in README.md)

- L3 = L2 (README, ranked problem 7).
- L0/L1 density for their distance; 32-bit indices on 96 % of dense L0 cells; 5.2 MB median per L0 cell, which with
  L1 out to 1,800 m exceeds the layer's 256 MB budget in the centre (estimate: ~30 L0 cells x 5 MB + ~120 L1 cells
  x 1.6 MB = ~340 MB); `tools/budget.json` reports `cityMB` 611-693 in the near views.
- Possible reduction that keeps the image (to be proven with 1:1 photos at the switch distance): face normals from
  derivatives (weld to distinct positions: ~-50 % vertices), L1 per-building walls under a pixel merged, L3 dropping
  walls under a pixel and merging coplanar roofs.

# Roads and terrain seams

Seed 1 city: 943 road cells, 74 road tiles, 20,220 segments. Data: `data/roads.json` (`scripts/roadsAudit.ts`),
`data/road-materials.json` (`scripts/roadMaterials.ts`).

## How they are drawn (read)

- `render/roads.ts:78-105`: a cell layer, **L0 = lod 0 per cell to 600 m, L1 = lod 1 per cell to 1,400 m, the tile =
  lod 1 over 4 x 4 cells from 1,400 m to 5,500 m**, nothing beyond; no plate level; no shadows except cells with a
  bridge. **No `eyeHeight`** option, so the distance is horizontal only (`render/cellLayer.ts:188-192`).
- `jobs/roadMesh.ts`: strips by the profile's cross-section (asphalt, kerb, footway, verge, median, barrier),
  junctions with fillets, bulbs, bridges and tunnels; lod 0 samples every 3 m, lod 1 every 10 m
  (`roadMesh.ts:196`); arc steps pi/16 vs pi/6 in junction corners (`:681`), 28 vs 12 in bulbs (`:554`).
- Vertex format **32 B**: position snorm16x4, normal oct snorm8x4, colour+material unorm8x4, `road` f32x4 (u, v, to the
  end, code) for the shader's paint, lanes and crossings. Indexed (16-bit in cells; 32-bit in 37 of 74 tiles).
- One material; the zone strips and the lod fade are masked in it (`render/roads.ts:489-492`), so the whole road
  material alpha-tests.

## Totals (measured)

| Level | Meshes | Triangles | Vertices | GPU bytes | Per mesh (max) | Worker time in Node |
|---|---|---|---|---|---|---|
| lod 0 cells | 943 | 14,726,532 | 15,779,018 | 593 MB | 15.6 k avg (34,479) | 2.3 s total |
| lod 1 cells | 943 | 3,244,192 | 4,338,706 | 158 MB | 3.4 k avg | 0.7 s |
| tiles (lod 1) | 74 | **3,244,192** | 4,338,706 | 173 MB | 43.8 k avg (80,930) | 0.7 s |
| terrain seams (25 busiest cells) | 25 | 480,923 | 965,075 | | 19.2 k avg | 1.6 s |

**The tile is exactly the sum of its cells at lod 1** (same triangles, same vertices): drawing by tile saves draw
calls, not a single triangle, from 1,400 m to 5,500 m. At 1,400 m one pixel is 1.07 m; at 5,500 m 4.2 m. The median
edge of a tile mesh is 8.5 m.

## Triangles by material (measured, whole map)

| Material | lod 0 | % | lod 1 = tiles | % |
|---|---|---|---|---|
| Kerb | 5,646,050 | 38.3 | 917,748 | 28.3 |
| Footway | 3,448,332 | 23.4 | 804,296 | 24.8 |
| Asphalt | 2,452,004 | 16.6 | 657,640 | 20.3 |
| Concrete (medians, bridges) | 1,472,630 | 10.0 | 383,786 | 11.8 |
| **Zone strip (hidden unless the zone tool is on)** | 1,296,492 | 8.8 | 346,432 | 10.7 |
| Plain | 233,064 | 1.6 | 118,048 | 3.6 |
| Grass (verge) | 159,264 | 1.1 | 13,786 | 0.4 |
| Pavers | 18,696 | 0.1 | 2,456 | 0.1 |

- **Kerbs** (15 cm stones in blocks, dropped at crossings) are the largest share at every level, including the tiles
  seen from 5 km where a kerb is a twentieth of a pixel.
- **Zone strips** (6 m bands 0.3 m above the ground beside zoned roads, `jobs/roadMesh.ts:286-303`) are always in the
  mesh and discarded per fragment unless the zone tool is on: they are rasterised over the lots in every frame.

## Mesh quality (measured)

| Mesh | Triangles | Vertices | Distinct positions | Weldable | Degenerate | Duplicated | Median edge |
|---|---|---|---|---|---|---|---|
| cell 539 lod 0 (heaviest) | 34,479 | 37,641 | 19,155 | 1,665 | **1,160** | 47 | 2.80 m |
| cell 539 lod 1 | 7,051 | 9,844 | 5,627 | 344 | 80 | 44 | 8.04 m |
| tile 34 (heaviest) | 80,930 | 111,244 | 57,005 | 4,885 | 816 | 734 | 8.54 m |

3.4 % of the heaviest lod-0 cell's triangles have no area; 4.4 % of its vertices are exact copies.

## Per view (modelled, `views.md`)

| View | lod-0 cells | lod-1 cells | tiles | Road triangles |
|---|---|---|---|---|
| street | 12 | 43 | 18 | 1,259,846 |
| district | 16 | 12 | 0 | 368,806 |
| city | 10 | 72 | 19 | 1,769,591 |
| map (eye 10.6 km up) | **25** | **113** | 45 | **2,866,112** |

In the map view the cells under the camera are chosen by horizontal distance and drawn at lod 0 and 1 from 10 km.

## Terrain seams (`render/terrainSeams.ts`, `jobs/terrainSeams.ts`)

To 440 m (`SEAM_REACH`), each road cell asks for the terrain cut along its roads: a lod-0 road mesh over 512 m
(`CELL_SIZE * 2`) is built in the worker only to cut the ground (86-102 k road triangles per busy cell), then
~19 k seam triangles per cell (measured: 15-21 k, 0.6-0.8 MB) and ~2,000 4 m terrain cells marked as holes. The road
mesh it is cut from is thrown away: a busy cell's seam job builds ~3 x the triangles of the cell's own lod-0 road.

## Sheets

- `sheets/road-cell-539-L0.png`, `-L1.png`: the heaviest cell (34,479 / 7,051 triangles). The sheet draws the
  zone strips (blue, purple) that the game hides; they are in the mesh.
- `sheets/road-tile-34.png`: the heaviest tile (80,930 triangles, drawn 1,400-5,500 m).

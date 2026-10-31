# Terrain, water, sky and weather

Read in `render/terrain.ts`, `render/scene.ts`, `render/weather.ts`, `render/cloudPuffs.ts`, `render/particles.ts`;
patch counts modelled by `scripts/views.ts` (the quadtree of `terrain.ts:1048-1066` repeated in Node).

## Terrain (CDLOD, one instanced draw)

| Piece | Triangles | Vertices | Format | Instances | Drawn |
|---|---|---|---|---|---|
| Patch 32 x 32 (`GRID`, `:44`) | 2,048 | 1,089 | position f32x3 (12 B), u16 index; per instance vec4 (x, z, size, level) | up to 4,096 (`MAX_NODES`) | quadtree from 128 m leaves (4 m spacing) to 2,048 m roots; band of level l = 128 x 2^l x 5 m (`lodFactor` 5: 640, 1,280, 2,560, 5,120, 10,240 m) |
| Shadow copy patch 16 x 16 (`SHADOW_GRID`) | 512 | 289 | same | up to 1,024 | every patch within 1,600 m (`SHADOW_REACH`), coarser bands (x 1.6), view not tested; shadow-only layer |
| Grass tuft (7 blades) | 7 | 21 (non-indexed) | position, normal f32x3, tip f32 (28 B) | **always 25,600** (160 x 160, 0.9 m) | eye under 140 m; tufts on roads/water/slopes collapsed in the shader |

Heights come from a 256 x 256 x 100-layer R32F texture (one layer per tile, 25 MB), so the patch mesh carries no
height. Modelled patches: street 101 (206,848 triangles), district 47, city 61, map 25. The terrain is the best-built
layer measured here: one draw, a bounded patch count, no per-tile meshes.

Points to watch (read, not measured): the shadow copy draws up to 1,024 patches x 512 triangles into each of the 3
cascades without a view test (`:974-977`); the grass is a fixed 179,200 triangles whatever is on screen.

## Water

| Piece | Triangles | Vertices | Index | Instances |
|---|---|---|---|---|
| Near grid per water tile (8 m, `WATER_TILE_RES` 128) | 32,768 | 16,641 | **u32** (`terrain.ts:243`) although 16,641 < 65,536 | each water tile in view within 1,500 m |
| Far grid per water tile (32 m) | 2,048 | 1,089 | u32 | each water tile in view beyond 1,500 m |
| Sea plane (`scene.ts:91`) | 2 | 4 | | 1, 8 x the map |

A near water tile is 16 terrain patches' worth of triangles; with u32 indices its index buffer is twice what u16
would need. Seed 1 has rivers/lakes in some tiles; their number per view was not modelled.

## Sky, clouds, weather, particles (read)

| Mesh | Triangles | Draw | Note |
|---|---|---|---|
| Sky sphere 48 x 24 (`scene.ts:122`) | 2,208 | 1 | back side, no depth write |
| Horizon skirt cylinder 48 segments (`weather.ts:177`) | 96 | 1 | |
| Cloud layer plane 80 km (`weather.ts:103`) | 2 | 1 | |
| Cloud puffs (`cloudPuffs.ts:30-35`) | 2 per puff, 64 puffs per cloud, up to 24 clouds | 1 instanced | billboards, transparent (overdraw, not measured) |
| Rain (`weather.ts:110-114`) | 2 per drop, 14,000 drops | 1 instanced | only with rain |
| Splashes (`weather.ts:142-154`) | 2 per splash, 2,500 | 1 instanced | |
| Particles (`particles.ts:55-60`) | 2 per puff, 24 per emitter, 512 emitters | 1 instanced | smoke, fire, dust, sparks |

These are small; the transparent ones cost fill rate, which needs a GPU capture to measure.

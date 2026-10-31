# The props pool (street furniture, parked cars, building parts)

Data: `data/props.json` (`scripts/propsCatalog.ts`), `data/views.json`, `scripts/variant-probe.ts`. Trees, bushes and
ground clutter are in [vegetation.md](vegetation.md).

## How it is drawn (read)

- One pool of **1,048,576 instances** (`render/props.ts:33`): pose vec4 f32 + one u32 (type 5 bits, key 27 bits), a
  2,097,152-entry visible list; 28 MB of storage buffers.
- **84 kinds x 3 levels = 252 indirect draws** (`props.ts:39-40, 255-269`): a compute pass culls every used slot
  every frame against the frustum (and the sun's shadow sweep for kinds that cast), bands it by distance with a
  12 % dithered fade (`props.ts:184-215`) and writes the draws' instance counts; levels whose band cannot be reached
  are not drawn (`props.ts:755-770`). One material for all.
- Residency: every cell within the farthest band (3,600 m, the tree impostors) + 256 m holds its props
  (`props.ts:531-575`); cells within `PARTS_RANGE` 928 m (x 1.25 hysteresis) also hold their 4.0 building parts
  (`props.ts:526-529`, `jobs/parts40.ts:31`).
- **Vertex format: 56 B, never indexed.** `part()` (`render/propMeshes.ts:34-47`) calls `toNonIndexed()` and adds
  `pcol` f32x4 and `pext` f32x4 to position f32x3 and normal f32x3. Every prop mesh is three vertices per triangle.
- Shadows: only level 0, never wires or flat things (`propMeshes.ts:699-712`); of the building parts only `BBox` and
  `BLot` cast (`props.ts:264`).
- Not in the budget's count: indirect draws count one instance each in three r186 (README, problem 3).

## Street furniture, signals, signs, wires, parked cars, creator people (measured, per level)

| Kind | L0 triangles (to m) | L1 triangles (to m) | L2 triangles (to m) | Size | Weldable L0 | Note |
|---|---|---|---|---|---|---|
| Lamp (utility pole + arm) | 92 (220) | 48 (750) | 12 (2,200) | 9.7 m | 122 of 276 | L2 = the lamp heads only (0.9 m: 1.6 px at 750 m) |
| Lamp, double | 136 (220) | 60 (750) | 24 (2,200) | 8.2 m | 205 of 408 | |
| Signal | 836 (260) | 156 (1,100) | - | 5.8 m | 1,538 of 2,508 | heaviest street prop; heads on both faces |
| Bench | 48 (150) | - | - | 1.7 m | 48 of 144 | |
| Bin | 80 (130) | - | - | 0.95 m | 156 of 240 | 10-sided cylinders |
| Wire span (4 cables, 12 segments each) | 400 (90) | - | - | 1.5 m (stretched) | 752 of 1,200 | 3.5 cm cables: 0.5 px at 90 m |
| Sign (post + atlas face) | 28 (140) | - | - | 3.6 m | 50 of 84 | |
| Sign, street name | 64 (140) | - | - | 3.7 m | 86 of 192 | |
| Pole (no lamp) | 80 (220) | 24 (750) | - | 9.7 m | 110 of 240 | |
| Barriers (5 kinds) | 12-84 (180) | 12 (700) | - | 1-2 m units | | stretched along the wall |
| Furniture (hydrant, postbox, phone, drain, bollard, planter, 8 facade pieces) | 12-144 (140) | - | - | 0.75-2.7 m | 12-322 | split per variant (`propMeshes.ts:585-590`) |
| Parked sedan | 5,828 (55) | 504 (320) | - | 4.4 m | 12,751 of 17,484 | 440 degenerate, 272 tiny, 312 duplicated triangles |
| Parked hatch | 5,552 (55) | 504 (320) | - | 3.9 m | 11,988 of 16,656 | |
| Parked SUV | 5,828 (55) | 504 (320) | - | 4.6 m | 12,686 of 17,484 | |
| Creator person (box figure) | 280 (90) | 12 (260) | - | 1.8 m | 516 of 840 | |

Parked cars: the 4.0 body (`render/carBody.ts buildCarBody(a, style, 12, 4, 2)`) with glass, trim, lamps, 4 wheels of
12 sides and rims (`propMeshes.ts:433-450`); at 55 m the car is 104 px long, 5.8 k triangles, 956 KB of vertex data
for one mesh (non-indexed). At 320 m (L1's end) it is 18 px for 504 triangles.

## The Roadcraft 4.0 building parts (pool types 24-30)

The kit models (`r40/render/buildings/kit.ts partGeometries`) are indexed, 32-44 B/vertex; the pool flattens them to
56 B non-indexed and merges every kind of a type into one mesh (`propMeshes.ts:514-536`). **One level only**, drawn to
`PART_DIST` by type (`jobs/parts40.ts:25-27`), whatever the instance's size.

| Pool type (to m) | Kinds in it | Kind model triangles (source) | Pool mesh triangles per instance | Instances in 144 dense cells |
|---|---|---|---|---|
| BFrame (400) | frame | 56 | 56 | 562,472 |
| **BBox (600), no variants** | concrete, shutter, fin, lamp | 12 each (identical unit boxes) | **48 (4 coincident boxes)** | 518,490 (351,080 + 34,016 + 110,011 + 23,383) |
| BRail (300) | railing | 252 | 252 | 8,474 |
| BMisc (400), variants | door, awning, column, louvre, brise, glassRail, roofRailing | 72, 24, 24, 136, 72, 12, 84 | per variant | 145,529 |
| BPropA (250), variants | acUnit, pot, foliage, bush, lounger | 316, 126, 192, 168, 84 | per variant | 25,177 |
| BPropB (150), variants | bike, chair, table, airer, dish | 240, 96, 160, 168, 146 | per variant | 10,686 |
| BLot (800), variants | lotBox, lotRail, lotSlab | 10, 8, 10 | per variant | 1,542,693 (lotBox 1,407,781) |

(Instance counts: `data/buildings.json` partCount, the 3 x 3 densest tiles, 6,903 buildings: 408 parts per building.)

### Defect A: the cull files most variant-type parts under the wrong mesh

The cull pass chooses an instance's kind from `(pose.w >> 12) & 15` (`render/props.ts:184`). That is the variant for
ordinary props (`jobs/props.ts:69`), but a part's `pose.w` is `partW(yaw, rgb)` = turn + colour << 12
(`jobs/parts40.ts:43-48`, `jobs/props.ts:467`): bits 12-15 are the **blue nibble of the part's colour**. The vertex
shader then takes the real variant from the key (`props.ts:327, 331`) and collapses every face of another variant
(`wrongFace`, `props.ts:345-347, 368`). Emulated with the game's own packing over 160 buildings
(`scripts/variant-probe.ts`):

| Kind | Under its own variant's mesh | Under another's (drawn as nothing) |
|---|---|---|
| lotBox | 0 | 29,746 |
| lotRail | 0 | 1,654 |
| lotSlab | 1,222 | 0 |
| door | 0 | 462 |
| acUnit | 0 | 559 |
| brise | 0 | 984 |
| awning | 0 | 661 |
| glassRail | 0 | 946 |
| louvre | 328 | 480 |
| roofRailing | 1,152 | 0 |
| all variant types | 3,072 (7.9 %) | 35,803 (92.1 %) |

So most doors, AC units, lot walls/posts, brises, awnings and glass rails are paid for in the vertex shader (the full
mesh of the wrong kind, then collapsed) and not seen. This is read in the code and emulated, **not seen in a game
photo**; a close photo of a house's lot and doors would confirm it.

### Defect B: BBox draws four coincident boxes

`concrete`, `shutter`, `fin` and `lamp` are four identical unit boxes (12 triangles each). `BBox` is not a variant
type, so its mesh is the four merged (48 triangles, 36 of them exact duplicates in `data/props.json`), each in its own
base colour and finish (`PART_BASE`, `propMeshes.ts:524`), and the shader keeps all four. Each of the ~518 k BBox
instances in the dense centre draws 4 x the triangles and 4 coincident surfaces (a z-fight between the four colours is
possible; not seen). BBox casts shadows (`props.ts:264`), so the cascades draw it 4 x as well. Street view (modelled):
12,305 instances, 590,640 triangles, the largest prop kind on screen.

### Defect C: size on screen is not considered

Lot boxes measured in a parts-pass probe: 0.28 x 0.07 x 2.0 m (x36 on one house), 0.05 x 1.7 x 0.04 m posts,
0.03 x 0.00 x 0.40 m (zero-height boxes), drawn to 800 m where a pixel is 0.61 m. Window frames (5 cm bars) to 400 m.
4.0 filed parts by their projected size (`partFiling.ts`, mirrored as `r40/render/buildings/partFiling.ts`); the pool
uses one distance per type.

### Pool capacity (estimate)

Median 20,359 parts per dense cell; `PARTS_RANGE` 928 m covers ~42 cells (~0.85 M parts) and the 1.25 x hysteresis
~66 cells (~1.3 M), against 1,048,576 slots shared with every tree and lamp out to 3.9 km. Cells that do not fit wait in
`pending` (`props.ts:84`) until blocks free up. Not measured in the game.

## Sheets

- `sheets/props-kinds-1.png` .. `-3.png`: every kind's first level (thumbnail numbering, not kind ids). Tree cards are
  expanded in the shader, so trees show trunk and collapsed cards only.
- `sheets/kit40-parts.png`: the 30 kit models as the r40 kit makes them (indexed).
- `sheets/prop-parked-sedan-L0.png` / `-L1.png`, `prop-signal-L0/L1`, `prop-lamp-L0..L2`, `prop-creator-person-L0/L1`,
  `prop-ground-clutter-L0`.

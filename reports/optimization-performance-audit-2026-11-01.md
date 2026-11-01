# Optimization and performance audit — Roadcraft 5

Date: 2026-11-01. Repository: `roadcraft-novo` (main) and `roadcraft-novo-port` (same commit, same tree).
Commit audited: `8235e51074d02e61ea70fc4002e2a58c2b4cd126` (2026-10-31, "props: the thin parts from afar as 4.0's cards").
Scope: GPU cost, draw submission, visibility, LOD, shadows, post-processing, memory, and the measurement that tells what is
being drawn. This is an analysis: **nothing was changed, and no game, build, test, budget or photo was run in this session**
(the owner's standing order). Every number quoted as "recorded" comes from `MEMORY/STATE.md`, `MEMORY/DECISIONS.md` or
`tools/budget.json`, with its commit/date; every other statement is read from the code and cites file:line.

Labels used below: **(a)** read in the code; **(b)** official documentation, paper, or a measurement already recorded by the
project; **(c)** inference from (a)/(b).

**Provenance of the code.** `roadcraft-novo` (main) and `roadcraft-novo-port` (`port/roadcraft-features`) are the **same
commit and the same git tree** (`8235e51`, 932 tracked files, 163.9 MB). The byte differences between the two working
folders are line endings (LF in main, CRLF in the worktree; the git blob hashes are identical). The folder sizes differ for
non-code reasons: main holds the real `.git` (207 MB), `node_modules` (514 MB) and the Electron package `out/` (514 MB);
the port holds 2.8 GB of `test-results/` (3,633 files, 1,126 images) and shares `node_modules` (a symlink) and `.git` (a
99-byte worktree pointer). Every line number in this report applies to both.

---

## 0. Executive summary

Roadcraft 5 is **not** an engine without culling. It has working per-object frustum culling in the cell layers
(`src/render/cellLayer.ts:296,318,386`), a GPU compute cull for every prop instance (`src/render/props.ts:261-266`), CDLOD
terrain selection (`src/render/terrain.ts:1000-1018`), per-tile and per-instance tests for traffic and people
(`src/render/vehicles.ts:401-455`, `src/render/people/crowd.ts:260-273`), SoA simulation tables, workers for generation and
meshing, and a depth prepass for the buildings. Those are real and must be kept.

What it does **not** have, and what keeps the GPU at 100 %, is a second and third layer of visibility and a measurement
that attributes cost:

1. **No occlusion culling anywhere** (a): every box or instance inside the frustum and inside a fixed distance is drawn,
   including the buildings, cars and trees behind the buildings in front of the eye. 4.0 has a conservative software
   occlusion buffer and reports that a 2.5D city hides 80–90 % of what the frustum keeps (`lab/roadcraft/src/render/
   occlusion.ts:1-20`; Downs, Akenine-Möller & Séquin, I3D 2001; Hasselgren et al., HPG 2016).
2. **LOD is chosen by distance, not by measured screen error** (a): cells L0 to 700 m, L1 to 1800 m, tiles (L2) to 4200 m,
   plates (L3) beyond (`src/render/city.ts:124`), roads 600/1400/5500 m (`src/render/roads.ts:106`), terrain by CDLOD
   distance, props by per-kind metres. 4.0 chooses a building level when the level's own geometric error spans a fixed
   number of pixels: `FAR_ERROR` 1.5 m at 2 px, `FACADE_ERROR` 0.3 m at 0.5 px, hysteresis 0.85, detail reach 1.4 km
   (`lab/roadcraft/src/render/buildings/massCells.ts:19-42`). At 1080p those constants put the L1→mass switch near 978 m,
   **not 1800 m** — a 3.4× larger L1 area. The distance bands are then multiplied by `pixelScale`, up to **3×**
   (`src/game.ts:1132-1138`), which on a high-DPI screen also pushes the roads' far limit to 16.5 km on a 10 km map.
3. **Overdraw**: every opaque material contains `discard` (buildings, props, roads, terrain, vehicles, people), so with
   depth writes on the fragment shader runs before the depth test; only the buildings have a depth prepass
   (`src/render/depthPrepass.ts:27-31`, `src/render/city.ts:185`). Measured by MJP (2025): a discard that never fires
   raised pixel-shader invocations from 440,640 to ~582,000 in a front-to-back test; with depth writes off, "Early-Z is
   totally compatible with shader discard".
4. **Shadow work**: the static shadow cache exists and works (`src/render/post.ts:53-104`), but the movers are drawn into
   every cascade every frame because the default wind (0.2) makes `moving` true (`src/game.ts:866`,
   `src/render/weather.ts:22`), every cascade copies its 2048² depth store into the map every frame
   (`post.ts:91`, 48 MB/frame at 60 Hz), the props/vehicles/people are **not culled per cascade** (one visible list from
   the view, `props.ts:790-822`; `frustumCulled=false` at `props.ts:282`, `vehicles.ts:66`, `crowd.ts:230`), and a turn
   of the camera redraws all still casters (no CSM scrolling: 4.0 `sunCascades.ts:44,206-222,563-641`; Acton 2012).
5. **Per-pixel post-processing**: the clouds' shadow is evaluated analytically for every pixel of the frame — a 4-octave
   fractal noise plus a fixed loop over 24 clouds (`src/render/cloudShadow.ts:33-50`, read by `post.ts:219-224`) — while
   4.0 draws a cloud-shadow map and only redraws it when its inputs change (`lab/roadcraft/src/render/
   cloudShadowStamp.ts:1-54`). The sea plane is 8× the map size, always submitted (`src/render/scene.ts:93-96`,
   `src/game.ts:558`) with a transparent, discarding, depth-writing water shader (`src/render/terrain.ts:787,842-848`).
   The grass field is 25,600 tufts × 7 blades = 179,200 triangles, `frustumCulled=false`, drawn whenever the eye is under
   140 m (`terrain.ts:54-59,688,739,930`).
6. **Draw submission**: the props pool has **84 kinds** (31 types with variant splits; 78 with geometry) × 3 levels =
   252 indirect slots (`props.ts:44-45`; `propMeshes.ts:681-691,752-769`). Each visible slot is one draw call and is also
   submitted to the three shadow cascades. Cell layers, the detail layer and the roads add one mesh per cell/tile/plate.
   Recorded: city view 264 draws vs 179 allowed (`MEMORY/STATE.md`, 2026-10-30); street 418 draws (2026-10-29).
7. **No accounting**: `stats()` returns total draws/triangles and only two memory figures (`src/game.ts:666-674`); three
   counts an indirect props draw as **one instance** (`node_modules/three/src/renderers/common/Info.js:156-162`), so the
   total hides every tree, pole and facade part past the first of each indirect draw; `drawnStats()` repairs this for the
   props only (`game.ts:680-684`, `props.ts:757-769`). There is no per-pass, per-layer, per-class or occlusion counter, no
   GPU-memory ledger, and the budget baseline was recorded at a lower detail than the current gate (`tools/budget.json`;
   `tools/budget.mjs:23-27`), so the budget can pass while the GPU is at 100 %.

Recorded totals at the last measurement (`MEMORY/STATE.md`, D81, commit `4393481`, real GPU, 1920×1080-class views):

| view | tris (three) | drawn (GPU) | limit (budget) | state |
|---|---:|---:|---:|---|
| street | 27,557,464 | 33,137,676 | 35,048,574 | passes, but 33.1 M triangles drawn |
| district | 21,209,234 | 26,325,324 | 26,396,986 | passes by 0.3 % |
| city | 13,294,708 | 13,296,410 | 4,044,328 | **3.29× over** |
| map | 7,691,542 | 7,691,518 | 5,284,464 | **1.46× over** |
| night | 30,473,168 | 36,082,780 | 35,088,390 | **2.8 % over** |

At `8235e51` the street view measured 8.80 ms GPU with the camera still and 11.53 ms turning (RTX 3060, 2544×993, high
preset; recorded in `MEMORY/STATE.md`), down from 25.45 ms at the start of 2026-10-31. The frame budget at 60 Hz is 16.7 ms;
the street still fits, the city view does not, and the figures above are counts from an older commit.

The rest of this report separates the findings (section 3), gives the architecture that removes each cause without lowering
quality (section 4), and the proof required (section 5).

---

## 1. What draws what (the pipeline as it stands)

| system | source | submission | visibility today |
|---|---|---|---|
| buildings L0/L1 | worker `buildingMesh`, levels −1/0/1 | `CellLayer`: one mesh per 256 m cell (`src/render/cellLayer.ts`) | frustum box test per mesh, distance to camera, L0/L1 split by `detail` 700 m, L1/tile by `near` 1800 m (`city.ts:124`) |
| building detail | worker level −1 | second `CellLayer`, cells only, material shared with L0 (`city.ts:135-150`) | frustum, 3D distance; drawn only within `detail` 150 m; publishes `DETAIL_SHOWN` |
| tiles L2 | worker level 2 | one mesh per 1024 m tile (`city.ts:99-107`) | frustum, distance; fallback while cells are not ready |
| plates L3 | worker level 3 | one mesh per 2048 m plate (`city.ts:108-120`) | frustum, distance; fallback for tiles |
| roads | worker `roadMesh`, levels 0/1 | `CellLayer` per cell and per tile (`roads.ts:79-107`) | frustum, 600 m detail, 1400 m near, 5500 m far |
| terrain | CDLOD, one instanced draw (`terrain.ts:208-233`) | one draw of selected nodes | per-node frustum + distance bands (`terrain.ts:922-1018`) |
| grass | one instanced grid locked to the camera (`terrain.ts:672-743`) | one draw | `frustumCulled=false`; only eye height < 140 m |
| water (rivers/lakes) | one grid per water tile, instanced (`terrain.ts:235-262`) | one draw per near/far grid | water tiles chosen per frame by frustum + distance (`terrain.ts:968-983`) |
| sea | one plane 8× the map (`scene.ts:93-96`), water material (`game.ts:558`) | one draw, always submitted | `frustumCulled=false` |
| props and 4.0 parts | one pool of 1,048,576 instances, rebuilt per cell (`props.ts`) | one indirect draw per kind and level; cull in compute | frustum + distance + per-instance size for 4.0 parts (`props.ts:214-246`; `partSize.ts`) |
| traffic | pose buffer, batches per model (`vehicles.ts`) | one draw per model/level | tile box + per-vehicle sphere frustum on the CPU (`vehicles.ts:401-455`); batches `frustumCulled=false` |
| people | cooked meshes, 3 LODs, vertex pulling (`crowd.ts`) | one draw per LOD | per-person screen height + frustum (`crowd.ts:329-339`) |
| weather, particles, clouds | shader-animated instances (`weather.ts`, `particles.ts`, `cloudPuffs.ts`) | one draw each | `frustumCulled=false`, camera-locked |
| shadows | CSM 3×2048², static cache + movers (`post.ts:53-135`) | one scene render per cascade | cell meshes frustum-culled per cascade (`cellLayer.ts:271-273`); props/vehicles/people are not |
| post | GTAO half size + denoise, cloud shadow, aerial perspective, TRAA, CAS/grade, bloom (`post.ts:183-312`) | full-screen passes | none (screen) |

---

## 2. What is already correct and must not be broken

These were verified in the code and are part of the solution, not the problem:

- **SoA and dense ids** in the simulation and world tables; workers for terrain, building meshes, props, roads, people and
  the ecology; no one-object-per-entity in the render path except the static cell meshes that three needs.
- **Cell LOD fallback without holes**: plate → tile → cell while the wanted level is not built (`cellLayer.ts:327-356,471-495`).
  The choice is stable (early-out when view, scale and sun are unchanged, `cellLayer.ts:289-295`).
- **GPU instanced prop cull**: two compute passes over the pool, compact visible list, indirect draws, per-kind level ends,
  per-instance size rules for the 4.0 parts (`props.ts:174-266`; `partSize.ts:83-109`), and sub-pixel part cards
  (`partCards.ts`). This is the right architecture; it needs to be extended, not replaced.
- **Building depth prepass**: the heavy building material writes depth first through a depth-only twin, then runs once per
  covered pixel with no depth write (`depthPrepass.ts:35-89`; `city.ts:185`). Measured: street still 10.64 → 9.92 ms
  (`MEMORY/STATE.md`, `bc6ca0f`). The turning case got worse (12.49 → 13.14 ms) and is open; the cause is the shadow
  redraw, not the prepass itself.
- **Static shadow cache**: still casters are kept in a depth store and copied into the map; movers are drawn over it
  (`post.ts:53-104`). The store is redrawn only when the cascade's matrices change, something casting changed, or the
  safety frame passes; safety draws are staggered (`post.ts:39-43`).
- **AO at the occlusion's resolution with a dedicated denoise pass** (`aoDenoise.ts`, measured 11.90 → 10.64 ms on
  2026-10-31), **TRAA with Catmull-Rom history** (`traa.ts`), **staggered shader warm-up**, **CPU copies of geometry
  freed after upload** (`cellLayer.ts:73-81,517`), **instanced demolition debris** and **BatchedMesh ruins**
  (`features/demolition/blast/debris.ts:5,93`; `ruin/ruinMesh.ts:5,79`), **instanced transit** (`transit.ts:98-104`).
- **The frame loop already stops drawing on a paused, idle, still scene** after `STILL_FRAMES` (`game.ts:94-95,813-820`).

The rest of the report attacks the gaps, not these.

---

## 3. Findings

Severity: **S1** = structural cause of the 100 % GPU / budget overrun; **S2** = large, measurable cost or a fidelity risk;
**S3** = smaller cost or a maintainability/measurement gap.

### F1 — S1: no occlusion culling; the frustum is the only visibility test

**Where.** `src/render/cellLayer.ts:382-398` (box tested against the frustum, plus a shadow-stretch test for casters),
`src/render/props.ts:214-246` (six frustum planes per instance), `src/render/terrain.ts:1000-1018` (CDLOD node frustum),
`src/render/vehicles.ts:401-455` (tile box + per-vehicle sphere), `src/render/people/crowd.ts:65,260-273` (sphere).
There is no occlusion buffer, no depth pyramid, no visibility state anywhere in `src/render` (grep for
`occlusion`/`occlud` finds only the AO comments).

**Why it costs.** In a street the depth complexity is high: the first row of façades hides the second, the roads behind it,
the cars and the trees. All of them are still inside the frustum and inside the LOD radii, so the GPU processes their
vertices and (for the visible pixels of the first row) still shades the fragments that fail the late depth test. The
recorded street view draws 33.1 M triangles (`MEMORY/STATE.md`, D81); 4.0's software occluder is documented to hide 80–90 %
of what a 2.5D city's frustum keeps (`lab/roadcraft/src/render/occlusion.ts:1-20`). The same is true from above: the city
view draws the tiles and cells under the camera whose front faces are already covered by the roofs.

**Fix.** Section 4.2 (P1): a conservative occlusion buffer built from the building volumes of the cells drawn in detail,
used by the cell layers and the road layer; a GPU depth pyramid (or the same software buffer uploaded as a storage texture)
used by the prop cull and the vehicle/person lists. 4.0 is the reference mechanism: 256 texels wide, 1500 m occluder reach,
1.5 texel minimum, 8192 texel read cap (`occlusion.ts:21-35`), occluders only from cells drawn in their own detail, the
buffer laid at the farthest corner of each face so it is never nearer than what stands, and the colour pass restores every
hidden mesh for the shadow passes (`lab/roadcraft/src/render/buildings/layer.ts:135,1154-1172`). The test is conservative:
a box is hidden only when every texel under it holds an occluder nearer than the box's nearest point; a false negative
(drawing something visible) is allowed, a false positive (hiding something visible) is not. That is what keeps the 1:1
photo identical.

**Quality gate.** Photos of the standard street/district/city/night views next to the same views at 4.0, plus a frame
sequence while turning; no hole, no popping; the occlusion stats must show a stable hidden share (expected tens of percent,
not a hand-picked scene). A new test: a box fully behind a known wall is hidden; the same box moved 1 cm into the opening is
not.

### F2 — S1: LOD by fixed distance, not by measured screen error; the bands are also too long

**Where.** `src/render/city.ts:124` (`near: 1800, evict: 3000, detail: 700, plate: 4200`), `roads.ts:106`
(`near: 1400, detail: 600, far: 5500`), `terrain.ts:273-278` (CDLOD ranges = `LEAF × 2^level × lodFactor`),
`props.ts:800` (`dist × pixelScale` per kind), `propMeshes.ts:108` (tree distances 200/650/3600 m).

**Why it costs.** At 1080p with a 45° vertical FOV a metre spans 1,304 px at 1 m. 4.0's constants give:

- L2 masses (error 1.5 m) may stand in when 1.5 m spans at least `NEAR_PIXELS` = 2 px → **978 m**;
- L0 detail may drop when the facade's 0.3 m flattening spans at least `FINE_PIXELS` = 0.5 px → **782 m**;
- tile masses carry a 1.4 m drop (`TILE_DETAIL`, `massing.ts:40`), plate masses 8 m (`PLATE_DETAIL`, `massing.ts:42`);
- hysteresis 0.85 and a 1.4 km detail reach where the view is dense enough (`massCells.ts:19-42`).

R5 keeps L1 cell meshes to **1800 m** (1.84× farther, 3.4× the area) and L0 to 700 m (vs 782 m, slightly early). The L1 band
is therefore the largest LOD area in the district/street views, and it is not derived from any measured error. The
same file's `pixelScale` multiplies every distance by up to 3 (`game.ts:1132-1138`); at ultra (detail 1.4) and a high-DPI
window the L1 radius becomes 5.4 km and the road far limit 16.5 km on a 10 km map. Terrain and roads have no per-node
screen-error test at all.

**Fix.** Section 4.3 (P2): replace the fixed bands with the 4.0 rule, using each R5 level's **measured** geometric error
(not assumed): distance = `error_m × pxPerMetre(distance) / threshold_px`; `pxPerMetre` from the actual projection
(perspective: `H / (2 tan(fov/2))`; orthographic: `H / (top − bottom)`), not from `innerHeight` alone; hysteresis 0.85;
detail reach 1.4 km where the view is dense. Keep the plate as the always-ready fallback. Measure R5's L1/L2/L3 error by
comparing the worker meshes (surface sampling or meshopt's `surfaceOff`) and record the values in
`MEMORY/SOURCES.md`; 4.0's 1.5/0.3/1.4/8 m are the reference, not a substitute. The switch must not show a difference in
the 1:1 photo at the switch distance; if R5's L2 is coarser than 4.0's tile masses, improve the L2 mesh (architecture)
rather than drawing L1 farther.

**Quality gate.** Same-view photos at the exact switch distance before/after, plus a frame sequence while moving the camera
through the switch; no popping, no visible simplification at 1:1.

### F3 — S1: the city view is 3.3× over its triangle budget and nothing attributes the triangles

**Where/evidence.** Recorded (`MEMORY/STATE.md`, D81, `4393481`): city `tris` 13,294,708, `drawn` 13,296,410, limit
4,044,328; map 7,691,542 vs 5,284,464; night 36,082,780 vs 35,088,390. Draws: city 264 > 179 (2026-10-30). The city view
is the 2200 m, 45° perspective view (`tools/photos/views.mjs:12`), so its eye is ~1556 m above the target; the
`CellLayer` adds the eye height to every cell distance (`cellLayer.ts:194-199`) and the shadow cascades reach 1600 m from
the eye (`post.ts:177`), so an unknown share of the 13.3 M is in the three shadow passes, not the colour pass.

**Why it is a finding in itself.** `stats()` reports one total for the whole frame (`game.ts:666-669`); the three cascades,
the scene pass and every post pass are summed. The budget tool prints the same total (`budget.mjs:75-99`). Without a
per-pass and per-class breakdown there is no way to know whether a change moves the right triangles; this is the
"nobody knows what is being drawn" part of the owner's diagnosis, and it blocks every optimisation below.

**Fix.** Section 4.1 (P0): a `RenderLedger` (4.0 `gpuLedger.ts` is the reference: bytes and triangles per class and owner,
`gpuLedger.ts:1-70`) and per-pass counters (shadow cascade 0/1/2, scene colour, AO, denoise, TRAA, bloom, grade), with the
indirect draws' real instance counts read back once per frame in measurement mode. `?perf` already has per-call GPU
timestamps (`gpuTiming.ts`) and the props probe already reads the indirect arguments (`props.ts:757-783`); wire them into
`stats()` and `budget.mjs` instead of adding a second measurement path. Add `frames.settle()` + `drawnStats()` to the tool
(the budget already does this, `budget.mjs:39-42`).

**Quality gate.** `npm run budget` prints draws/triangles/bytes per class and per pass; the budget compares the same
classes; the owner reviews the new baseline on `main` (the baseline is the owner's to change).

### F4 — S1: props are processed and submitted for the whole residency ring, not for what can be drawn

**Where.** `props.ts:535-579`: residency keeps every cell within the farthest level band of **any** kind
(`range = reach × pixelScale`, `reach` = max over kinds) plus a cell, and on a move of 32 m re-scans the ring. Trees reach
3600 m (`propMeshes.ts:108`), so at `pixelScale` 3 the ring is 10.8 km — the whole 10 km map, and most of a 24 km map.
Every instance in that ring is in the pool and is processed by **two full compute passes per frame** (`props.ts:250-266`:
count, then fill), regardless of whether it is in the frustum or behind a building. The pool is fixed at
1,048,576 instances (`props.ts:38-41`); cells that do not fit go to `pending` and are asked again when blocks free
(`props.ts:661-671`) — a capacity limit not surfaced to the player at large maps.

**Why it costs.** The compute work and the pool memory grow with the map area, not with what is drawn (CLAUDE.md forbidden
list item 5: "work per frame that grows with city size"). At a high-DPI/ultra setting it is at its worst exactly when the
GPU is already full.

**Fix.** Section 4.4 (P3/P6): keep cells by **each kind's own reach and the view**, not by one global circle; separate the
long-range, tiny impostors from the near props into their own pool/renderer with a quadtree or per-tile list; cap the total
by the measured instances in view; test the instances against the occlusion buffer in the same compute pass that culls the
frustum. The visible list already supports a compact per-kind run (`props.ts:174-179`); the change is where the pool gets
filled, not the draw path.

**Quality gate.** A city-view/street photo pair; the props' near/far transition must be unchanged at 1:1; `pending` must be
zero at a steady camera and the pool must hold only what the view needs; measure the compute dispatch time.

### F5 — S1: shadow casters are submitted to every cascade and the store is copied every frame

**Where.** `post.ts:53-104`: each cascade keeps a depth store; on a kept frame it copies store → map (line 91) and then
draws the movers over it; on a redraw frame it renders the still casters (line 83) and copies map → store (line 85).
`game.ts:866` passes `moving = !paused || wind > 0.001 || demolition.moving()`; `windU` is 0.2 by default
(`weather.ts:22`), so `moving` is true in every normal frame. Props/vehicles/people are not culled per cascade:
`props.ts:790-822` builds one list from the main camera; the prop meshes are `frustumCulled=false` (`props.ts:282`);
vehicle and people batches are `frustumCulled=false` (`vehicles.ts:66`, `crowd.ts:230`). A camera turn changes every
cascade's matrices, so `kept` is false for all three and all still casters are drawn again (`post.ts:77`).
4.0 keeps casters under a `KeptFrustum` grown by the cascades' cover box so a pan does not throw the store away
(`lab/roadcraft/src/render/cellInstances.ts:56-62`), scrolls the store and redraws only the exposed strips
(`sunCascades.ts:44,563-641`), chooses a caster's shape by the cascade's texel
(`shadowLevels.ts:1-20`, `SMALL_CAST_TEXELS = 2`), and stops movers at their last cascade (`sunCascades.ts:424`).

**Why it costs.** 3 × 2048² depth copy = 48 MiB per frame (≈2.9 GiB/s at 60 Hz) before any shading; every mover instance is
vertex-shaded in up to three cascades even if the cascade cannot see it; a turn redraws the whole near city in all three
cascades. Recorded: turning 13.14 ms vs still 9.92 ms after the building prepass (`MEMORY/STATE.md`, `bc6ca0f`), and
shadow redraws while turning are the open cause of the 43.7 ms p99 hitches.

**Fix.** Section 4.5 (P5): per-cascade visible lists (the props cull compute can run once per cascade with that cascade's
planes, or write per-cascade offsets); pass `moving` only when a mover is actually in a cascade and moves; restore the
caster visibility for the shadow pass (4.0 `layer.ts:135`); keep casters under the cascade cover (4.0 `KeptFrustum`);
scroll the store instead of redrawing it (4.0 `sunCascades.ts`; Acton 2012); choose simplified caster shapes by the
cascade's texel (4.0 `shadowLevels.ts`, meshopt absolute error). The store→map copy must be replaced by a ping-pong pair or
a separate mover map sampled with `max` in the shadow filter; measure the copy first, do not assume it.

**Quality gate.** Shadow photos of the same street at morning and at low sun, before/after; a frame sequence while turning;
no missing or doubled shadows; the shadow map's texel size and the cascade splits unchanged.

### F6 — S1: `discard` in every opaque material; the depth prepass covers only the buildings

**Where.** Building mask `city.ts:277-279` (`lodFadeMask ∧ cutMask ∧ hole`), props `props.ts:484`, roads `roads.ts:493`,
terrain `terrain.ts:482`, vehicles `vehicles.ts:226`, people `crowd.ts:227`. The building material is laid depth-first
(`city.ts:185`); nothing else is (`grep layDepthFirst` finds only `city.ts`). `cutMask` also runs `hiddenMask()`, a
16-entry loop per vertex, on **every** building vertex even when the inside view is off and no building is hidden
(`inside.ts:21-51`; `city.ts:277-279`).

**Why it costs.** With depth writes on and any discard in the shader, the depth write cannot be committed until the
fragment shader finishes; MJP measured 440,640 → ~582,000 pixel-shader invocations with a discard that never fires. The
street view has high depth complexity behind the façades; every hidden fragment of roads, props, terrain, vehicles and
people runs its shader. The building prepass already demonstrates the fix and its cost (one extra depth-only pass, not a
second full shading pass); the previous "all opaque materials" attempt measured worse because it drew the props' full
vertex program twice (`depthPrepass.ts:21-26`) — with the part cards and size cull now in place, that trade must be
re-measured per material, not assumed.

**Fix.** Section 4.6 (P4): (1) a mask-free material variant for meshes not fading/cut/opened, drawn before the masked ones
(Unity's LOD cross-fade variant pattern); (2) extend the depth twin to the other materials whose pixel cost is high and whose
overdraw is measured (terrain and roads first; props only if re-measured after the cards); (3) make the inside/hidden cut a
shader variant selected by the view, not an always-on homogeneous loop; (4) put the LOD fade mask in the depth twin and use
depth-write-off in the colour pass for the materials that keep a mask.

**Quality gate.** Before/after photos in the four standard views; the 1:1 image is the reference; the depth prepass must not
change edges (measure invariant depth or use the documented polygon offset, as `depthFirst.ts`/`depthPrepass.ts` do).

### F7 — S1: the cloud shadow is computed per pixel with fractal noise and a fixed 24-iteration loop

**Where.** `post.ts:219-224` calls `cloudShadowAt(world, sun)` for every pixel with a valid depth; `cloudShadow.ts:33-50`
evaluates `layerCover` — `mx_fractal_noise_float(..., 4, 2, 0.5)`, four octaves — and then `Loop(MAX_CLOUDS, ...)` with two
`textureLoad`s per iteration, `MAX_CLOUDS = 24` (`cloudShadow.ts:12`), always 24 iterations (`on = select(i < count, 1, 0)`
multiplies instead of skipping). The same noise is also drawn in the cloud layer's own material (`weather.ts:97-107`).
4.0 keeps a cloud-shadow map and a stamp that redraws it only when the clouds, the sun, the rectangle or the plane change
(`lab/roadcraft/src/render/cloudShadowStamp.ts:1-54`; the map is `CLOUD_SHADOW_MAP_MAIN` in `postprocess.ts`).

**Why it costs.** The composite is a fixed per-pixel floor; the recorded street frame's composite was 2.83 ms before the
AO denoise was moved out, and the `MEMORY/STATE.md` note attributes 7.9 % of the frame to the composite (4.0's cloud-shadow
map). A four-octave noise plus a 24-iteration loop on every pixel is a prime candidate for the remainder; the frame's
`rawDepth.greaterThan(0)` only gates the result, not the evaluation.

**Fix.** Section 4.7: render the weather cloud cover and the player's clouds into a small world-space shadow map (e.g. 256²
or 512² over the view's ground box) in a compute/fragment pass, refresh only when the inputs change (stamp), and sample it in
the composite; keep the analytic path as the reference for a photo comparison. Break the 24-cloud loop at the uniform count
(`If(i < cloudCountU)`) even before the map exists. This is 4.0's mechanism and its appearance is the accepted look.

**Quality gate.** Same-view photos day/overcast; compare cloud-shadow positions and softness with 4.0; the stamp test:
changing a cloud redraws, a still camera/cloud does not.

### F8 — S2: the sea plane and the water shader

**Where.** `scene.ts:93-96` creates `PlaneGeometry(MAP_SIZE * 8, MAP_SIZE * 8)`, `frustumCulled=false`; `game.ts:558`
assigns the terrain's water material; `terrain.ts:753-851` builds a transparent `WaterNodeMaterial` with many texture reads,
`heightAt` per pixel, a `maskNode` (discard) and **depthWrite left at its default true** (only `transparent: true` is set at
line 787); the sea's mask discards where there is no water (lines 842-848). Water tiles use a 128×128 grid per 1024 m tile
(8 m spacing, 32,768 triangles) near and 32×32 far (`terrain.ts:237-262`; `WATER_TILE_RES = 128`, `world/ground.ts:49-51`).

**Why it costs.** A transparent, discarding, depth-writing material has late-Z and writes depth; the sea is always submitted
and its shader runs wherever the plane covers the screen, including land hidden under terrain (the mask discards after the
texture reads). Water tiles near the camera are 32 k triangles each; a river through the view can add hundreds of thousands
of triangles for a flat surface. The material's depth write is also a correctness risk for transparent sorting.

**Fix.** Section 4.7: set `depthWrite = false` on water (transparent) and give it an early-out from the scene depth (sample
the depth already in the target, reconstruct the world point, discard before the expensive shading if the sea is behind
land); clip the sea plane to the sea's visible region/horizon rather than 8× the map; choose water grid resolution by the
projected size of the tile (the far grid already exists), keeping 8 m where the shoreline needs it; keep the look (4.0's
water shader) and compare photos.

**Quality gate.** Sea, river, lake and night photos at the standard views and from the air; the shoreline and water colour
must match 4.0 at 1:1; the depth behaviour of transparent water must not hide the bed or the objects behind it.

### F9 — S2: the grass field is never culled

**Where.** `terrain.ts:54-59` (`TUFT_STEP 0.9`, `TUFT_SIDE 160`, `BLADES 7`), `terrain.ts:688` (`instanceCount =
25,600`), `terrain.ts:739` (`frustumCulled=false`), `terrain.ts:930` (visible under 140 m eye height). Each vertex samples
the height texture, the slope, the ground paint and the road cover (`terrain.ts:692-724`).

**Why it costs.** 179,200 triangles and ~537,600 vertex invocations for a field that is behind the camera half the time,
plus the fragment cost of the blades; the field's 144 m square is larger than the near view at street level and the field
does not adapt to the frustum. The `MEMORY/STATE.md` note records the 179,200 unculled blades.

**Fix.** Section 4.7: select the tuft blocks on the CPU by the frustum (a 160/8 = 20×20 block grid is 400 boxes per frame,
bounded) and write the visible block list into the instance buffer, or group the tufts into blocks in the shader and test
one box per block; keep the same field, density and look. The field is already camera-locked; the block list preserves it.

**Quality gate.** Street photos at day and night, with the eye moving; no visible edge or density change; the grass
transition at 140 m remains as it is.

### F10 — S2: draw submission: 252 prop slots, one mesh per cell, one traversal per pass

**Where.** `props.ts:44-45` (`DRAWS = KINDS * LODS`), `propMeshes.ts:681-691,752-769` (84 kinds), `props.ts:278-293` (one
mesh per slot, `frustumCulled=false`), each visible slot drawn in the main pass and, for casters, in every cascade.
`cellLayer.ts:264-281` makes one mesh per cell/tile/plate; `cellLayer.ts:498-545` rebuilds the group's children list on a
change. `textSigns.ts:79-95` creates two meshes with a unique canvas material per sign within 450 m. The scene is traversed
once for the colour pass and once per cascade (`post.ts:83,99`; three's `renderer.render`), with every cell mesh and every
batch object.

**Why it costs.** 252 possible prop draws + ~180 cell meshes at street + 3 cascades × casters + post passes = the recorded
418 street draws. Draw calls are not the only cost (the triangles and fill dominate), but they are CPU and command-buffer
cost, and they multiply in the shadow passes. The 84 kinds are an artefact of splitting variants into separate meshes to
avoid drawing every variant's vertices; the people renderer shows the better pattern: one draw per LOD with vertex pulling
and padded degenerate triangles (`crowd.ts:1-10,117-130`).

**Fix.** Section 4.4 (P3): group prop kinds into a few vertex-count/geometry buckets and draw each bucket with vertex pulling
(one storage buffer of vertices, one of indices, a per-instance geometry record), or use a `BatchedMesh` per bucket — noting
that three's `BatchedMesh` still issues one indirect draw per geometry range (`WebGPUBackend.js:2128-2136`), so it saves CPU
and object overhead more than GPU draw calls. The people renderer is the in-repo precedent; the 4.0 `gpuBatchedMesh` is the
reference for per-instance occlusion. Do the same for the vehicle model batches and the text signs (atlas + instancing) only
after the measured draw-call share justifies it.

**Quality gate.** Draw calls within the budget in all views; the images unchanged; the props' variants must still look
distinct (the bucket must not collapse variants; each instance keeps its geometry id).

### F11 — S2: memory: per-tile texture arrays exceed WebGPU's guaranteed limit at 24 km; layer budgets are soft

**Where.** `config.ts:8` offers 24 km; `terrain.ts:140-191` creates height, fine paint, coarse paint, ground, water, ecology
and slope arrays with **one layer per tile** (`MAP_TILES²`): at 24 km that is 576 layers. WebGPU's default
`maxTextureArrayLayers` is **256** (W3C WebGPU spec, limits table); `scene.ts:30-42` asks the adapter for its maximum and
`game.ts:548-553` reloads a smaller map when `MAP_TILES² > maxLayers`. The texture sizes at 24 km: height 256²×4 B×576
≈151 MB, fine paint ≈151 MB, ground/water/eco 128²×4 B×576 ≈37.7 MB each, slope ≈9.4 MB, coarse paint ≈2.4 MB — about
**427 MB** before mipmaps, plus the CPU-side shared arrays. `cellLayer.ts:127-133` has a per-layer `budget` (buildings 256 MB,
detail 48 MB, roads 192 MB) but it only lowers `evictScale` to 0, where the near radius still keeps the cells; the recorded
`cityMB`/`roadsMB` are 665/227 MB at the street view (`tools/budget.json`), above those "ceilings". No RTs, shadow maps,
props pool, terrain textures or people buffers are counted (`game.ts:666-674`; `budget.mjs:91` uses only cityMB+roadsMB).

**Why it costs.** 24 km is offered but silently falls back to 16 km on 256-layer hardware (the smallest map that fits); on
hardware that accepts 576 layers the VRAM cost is large, and the memory gate does not see it. The GPU-memory ledger of 4.0
(`gpuLedger.ts`) is the missing instrument.

**Fix.** Section 4.8 (P6): store heights/ground/water/paint in a 2D atlas (map-res × map-res) or a small set of arrays under
256 layers and update sub-rectangles with `writeTexture`/staging; or use a sparse per-tile texture table with an indirection
sampled by tile id. Add a global `GpuLedger` (4.0 `gpuLedger.ts`) and a budget limit for every class (buildings, roads,
terrain, props, vehicles, people, shadow maps, render targets); make the layer budgets hard (stop requesting when full,
fall back a level, never draw a hole), and count the RTs. Keep 24 km as a supported size, not a fallback.

**Quality gate.** 24 km opens and runs on a 256-layer adapter; the save/reopen and the four views still pass; the ledger
reconciles with `renderer.info.memory` and the budget's MB column; no visual difference.

### F12 — S2: no observability of what is drawn, culled, or resident

**Where.** `game.ts:666-684` (`stats`, `drawnStats`), `gpuTiming.ts` (only `?perf`), `props.ts:775-783` (`probe`),
`budget.mjs`. There is no counter for: instances in the pool vs visible, cells tested vs drawn vs occluded, meshes per
layer, draw calls per pass, triangles per pass, bytes per class, or LOD level distribution. `renderer.info` counts an
indirect draw as one instance (`Info.js:156-162`), so `tris` is not the GPU's triangle count; D81 fixed that only for the
props (`props.ts:757-769`). The budget baseline in `tools/budget.json` is from an older/lower-detail run (city 179 draws,
3.37 M baseline; the current city is 13.3 M), and the limits are relative: street may double its baseline and add 150 draws,
district may double (`budget.mjs:23-27`). The gate can pass with the GPU at 100 %.
**Fix.** Section 4.1: the ledger and per-pass counters above, exposed through `game.stats()` and the automation contract;
`budget.mjs` prints them and compares the classes. Re-record the baseline on `main` after the owner's review (the baseline
is the owner's to change; this report does not change it). Add a `visible` counter to the props cull (atomic add) and an
occlusion counter to the new visibility buffer.

**Quality gate.** The report of a change must name the class and pass that moved; a count that cannot be attributed fails
the review.

### F13 — S3: the building LOD switch and the detail layer disagree with 4.0's screen-error rule

**Where.** L0 700 m (`city.ts:124`) vs 4.0's `FINE_PIXELS` 0.5 on a 0.3 m error (782 m at 1080p); L1 1800 m vs 978 m;
the separate detail layer (3D window reveals/sills/heads) is drawn only within 150 m (`city.ts:148`), while 4.0 draws the
detail level itself within 1.4 km and falls back by pixels (`massCells.ts:35-37`). The building shader fakes the reveal
beyond 150 m (`city.ts:443-461`), so the image may still match; that has not been proven with a 4.0 photo pair.

**Why it matters.** It is a fidelity risk in both directions: more cost than 4.0 between ~900 and 1800 m, and possibly less
3D relief than 4.0 between 150 and ~780 m. "Roadcraft 5 is not automatically right either" (CLAUDE.md).
**Fix.** Fold the detail layer's switch into the same measured-error rule; if the 1:1 photo at the switch distance differs
from 4.0, extend the 3D detail or improve the shader's fake; if it is identical, record the photo evidence and keep it.

### F14 — S3: overdraw from the transparent/effect layers and the post floor

**Where.** `weather.ts:107-143` clouds 80 km plane, rain 14,000 instanced quads (`RAIN_DROPS`), stars 2,500; `particles.ts`
512 emitters × 24 quads; `cloudPuffs.ts` 24×64; `post.ts:240-298` TRAA, CAS (5 taps, each tone-mapped and `pow(2.2)`),
grade, bloom with a second TRAA at night; `post.ts:287-298`.
**Why it costs.** When active these are full-screen transparent draws and full-screen passes; they are bounded and necessary
for the look. The night path holds two TRAA graphs and two histories (`post.ts:240-298`); only one is evaluated per frame,
but the memory and the pipeline are both there. The CAS `toDisplay`/`pow` per tap is a candidate to fold into one pass.
**Fix.** No change is proposed without a measured share: `?perf` per-pass GPU timestamps are the tool (section 4.1). If
CAS/grade is a measurable pass, fold it into the TRAA/grade output; if the second TRAA is only for bloom, share the
resolved image and add bloom as a post step (it already is) and drop the duplicate history.

### F15 — S3: the hidden/cut mask is compiled into every building vertex

**Where.** `inside.ts:21-51` `hiddenMask()` loops `HIDDEN = 16` uniforms; `cutMask()` includes it; `city.ts:277-279` uses
`cutMask()` in both mask nodes of the building material and of the detail layer.
**Why it costs.** 16 comparisons and a flat varying per building vertex, on every cell, in the colour pass and in the
depth prepass, even when the inside view is closed and no building is hidden.
**Fix.** A material variant for the inside/cut/hidden state (or an `If` on a uniform that is 0 in normal play), chosen when
the inside view opens/closes; keep the exact result when active.

### F16 — S3: pixel scale, orthographic view and the FOV

**Where.** `game.ts:1132-1138` uses `innerHeight × devicePixelRatio × resolution × detail / 1080`, capped 0.3–3; it does
not include the vertical FOV or the orthographic zoom. `partSize.setView` does handle the orthographic pixels-per-metre
(`partSize.ts:48-60`), but the cell layers and the terrain do not. The camera can be perspective (45°) or orthographic
(`cameraRig.ts:125-126,377-385`).
**Why it costs.** On a 4K/2× window the distances can be 3× while the pixels are 4–8×; on the orthographic view the LOD
distances do not follow the zoom. The result is both over- and under-detailed views depending on the mode.
**Fix.** A single `ViewScale` derived from the actual projection (pixels per metre at the reference view, perspective or
orthographic) used by cells, props, terrain, roads and parts; clamp to what exists (map edge) and never cut visible detail.

### F17 — S3: the frame loop and the CPU cost of four scene traversals

**Where.** `game.ts:726-873`; `post.ts:83,99` (one `renderer.render` per cascade plus the scene pass);
`renderer.setAnimationLoop` (`game.ts:652`). `live` is true whenever the clock runs or input was seen (`game.ts:813-816`).
**Why it costs.** The clock runs in normal play, so a frame is drawn every vsync; that is expected for a living city, and
the still-frame stop after 40 frames already covers the paused case. The issue is the cost of each of those frames: the
scene graph is traversed four times (colour + 3 cascades) over every cell mesh, prop slot, vehicle/people batch and effect;
the cell group can hold hundreds of meshes. The CPU timings in `?perf` are only logged for frames over 30 ms
(`game.ts:872`) and were not recorded in this session.
**Fix.** Reduce the object count (section 4.4), give the shadow pass only the casters (4.0 `KeptFrustum` and per-cascade
lists), and keep the per-frame counters so a regression is attributable. Do not add a frame cap or lower the refresh rate:
CLAUDE.md forbids hiding the cost.

### F18 — S3: opening and generated-city cost (recorded, not re-measured)

Recorded in `MEMORY/STATE.md` (2026-10-31): ~26 s to a drawn city (ready 6 s, generation 8 s, meshing 12 s). The code path is
workers (`jobs/pool.ts`, `jobs/worker.ts`) and the loading screen (`game.ts:584-662`); the budget does not cover it. This
report does not change it; it is listed because it is a performance defect of the application as a whole, not of the GPU
frame. It needs its own measurement and architecture pass (worker count, job priority, first-view coverage), and must not
be traded for visual quality.

---

## 4. The correct solution (architecture, order, and acceptance)

The order is dependency-driven: measurement first, then visibility, then LOD, then submission/fill, then shadows and
memory. Nothing here lowers quality, removes a feature or changes a budget/test threshold. Every step is measured with the
existing tools (`?perf`, `game.stats()`, `drawnStats()`, `npm run budget`, `tools/fotos.mjs`) and photographed in the same
views before/after.

### 4.1 P0 — Make the renderer account for itself

**New modules (feature folders):** `src/render/ledger.ts` (a `GpuLedger` like 4.0's `gpuLedger.ts`: `set(owner, class,
bytes, triangles)`, `remove`, `bytes(class?)`, `triangles(class?)`; classes: `building L0/L1/tile/plate/detail`, `roads`,
`terrain`, `props`, `vehicles`, `people`, `shadow maps`, `render targets`, `textures`, `other`); `src/render/passStats.ts`
(per render call: id/name, draws, triangles, instances, GPU ms; the `GpuTiming` pool already keys timestamps by call index,
`gpuTiming.ts:20-35`).
**Wiring:** every owner registers its bytes when it uploads (CellLayer `setMesh`, `Props`, `Terrain`, `Vehicles`, `Crowd`,
`Post` for targets/shadow maps); `stats()`/`drawnStats()` expose `classes` and `passes`; `budget.mjs` prints them and adds
limits per class (after the owner's review). Add `visible`/`culled`/`occluded` counters to the props cull and the new
visibility buffer. Keep `?perf`-only cost: no per-frame readback in play; the counters are atomics already on the GPU, read
back only when the tool asks (the props probe path, `props.ts:757-783`).
**Proof:** `npm run budget` output before/after; the JSON in the report; no visual change.

### 4.2 P1 — Visibility: occlusion culling (the missing layer)

**Mechanism (4.0's, reimplemented in R5's architecture, not copied):** a conservative software occlusion buffer in
`src/render/visibility.ts`:
- 256 texels across, height from the aspect (4.0 `occlusion.ts:21-35`);
- occluders are the solid walls of buildings of cells drawn in their own detail (R5 source: `world.buildings` columns,
  `world.gatherBoxes`, `buildingVolumes`, the same data the cell worker uses; no roof, no building with voids, no ruin);
- each face laid at the farthest corner and only over whole texels; a mip chain keeps the farthest depth under each level;
- `hidden(box)` tests the eight corners, projects them, and returns true only when every texel under the box has an
  occluder nearer than the box's nearest point; boxes over the read cap or touching the near plane are not hidden;
- 1500 m reach, 1.5 texel minimum, 8192 texel cap (4.0 values); the buffer is built before the frame's choice, from this
  frame's camera, so nothing is a frame late (no popping).
**Integration:** `CellLayer.update` consults `hidden(cell/tile/plate box)` before adding a mesh (for both the colour pass and
the shadow stretch: a box hidden in colour may still cast into the view, so the shadow stretch test remains); the road and
city-detail layers use the same buffer; the props cull reads the buffer as a small depth texture (or its mip chain) and
tests the instance sphere in the compute pass; the vehicle/person lists test their spheres on the CPU. The colour pass
restores visibility for the shadow passes (4.0 `layer.ts:135,1154-1172`): a caster is never culled from a cascade by the
colour occlusion.
**GPU alternative/extension:** after the opaque depth prepass, build a hierarchical depth pyramid in compute (three's
`renderer.compute` on a storage texture) and test instance boxes in the props cull; this is the natural fit for the
existing GPU cull and does not need a CPU readback. Use the software buffer for the cells/roads (it is conservative and
cheap at 256²) and the GPU pyramid for the instances. Do not rely on hardware occlusion queries: WebGPU specifies
`GPUQuerySet` type `"occlusion"` (MDN: queries available on render passes), but it is not Baseline and does not work in
some major browsers; the console/Electron target and the WebGL fallback need a portable path.
**Acceptance:** a hidden-share stat per view (recorded, not hand-picked); a test that a box behind a wall is hidden and a
box 1 cm into the opening is not; photos in the four views and a turn sequence with no hole; `npm run budget` per class.

### 4.3 P2 — LOD by measured screen error

- **Buildings:** replace `near/detail/plate` fixed values with `distance = error × pxPerMetre / threshold`; R5's level
  errors measured by sampling each level's surface against the finer one (the `surfaceOff` approach of 4.0
  `shadowLevels.ts`; no new runtime dependency is needed for the measurement); 4.0 reference: `FAR_ERROR` 1.5 m at 2 px,
  `FACADE_ERROR` 0.3 m at 0.5 px, hysteresis 0.85, detail reach 1.4 km, `TILE_DETAIL` 1.4 m, `PLATE_DETAIL` 8 m
  (`massCells.ts:19-42`, `massing.ts:40-42`). Keep the plate/tile fallback and the 0.35 s dither fade.
- **Roads:** measure the L0/L1/tile mesh error (section height, junction fan tessellation) and use the same rule; the road
  shader's analytic markings stay at every level (they are in the material, not the mesh).
- **Props:** keep the per-instance `PartSize` rule for 4.0 parts (`partSize.ts`), extend it to the kinds whose model has a
  measured simplification error (trees, shrubs, furniture variants) instead of per-kind metres; keep `BAR_PIXELS` 0.5 and
  `PART_ERROR_PX` 1.5 (4.0 `partCells.ts:26-27`, `kit.ts:112`).
- **Terrain:** CDLOD ranges from the node's measured height error and the actual `pxPerMetre`, not only a distance; keep
  the morph band and the 4 m finest spacing so the 1:1 image is unchanged.
- **View scale:** one `ViewScale` for perspective/orthographic, FOV and pixel ratio; clamp to the map.
**Acceptance:** 1:1 photo at each switch distance (before/after and next to 4.0), a frame sequence through the switch, no
popping; per-class counts down; no test threshold changed.

### 4.4 P3 — Draw submission

- **Props:** group kinds into vertex-count buckets and draw each with vertex pulling (the people renderer precedent,
  `crowd.ts:1-10`), or a `BatchedMesh` per bucket (three r186: "reduce the number of draw calls",
  `node_modules/three/src/objects/BatchedMesh.js:143-151`; note its per-geometry indirect loop at
  `WebGPUBackend.js:2128-2136`). The cull compute writes the per-instance geometry id and the per-bucket offsets; the
  visible list stays compact. Target a small fixed number of draws per level instead of 78–84.
- **Cells:** keep one mesh per cell for the LOD and occlusion (it is the unit of visibility); if the draw-call count remains
  high, a `BatchedMesh` per layer/level with per-object visibility can cut the CPU object count without losing the cell
  culling; measure both.
- **Vehicles/people:** one vertex-pulled batch per level (people already are); the 19 vehicle batches are acceptable until
  measured; do not add batching that breaks the per-instance cull.
- **Text signs:** one texture atlas + one instanced draw for the plates, or a single dynamic geometry; the unique canvas
  material per text is the cost.
**Acceptance:** draw calls within the budget in all views; the image unchanged; the per-instance cull still exact (a
screenshot of a dense street with a hidden instance test).

### 4.5 P4 — Overdraw and fill

- **Depth prepass:** keep the building prepass; add the terrain and roads (their pixel cost and overdraw are high), and
  re-measure props after the part cards and size cull; the twin must carry the same position and mask and write depth only;
  the colour pass writes no depth (the building pattern).
- **Mask-free variants:** two materials per masked family: a plain one for meshes not fading/cut/opened, drawn before the
  masked ones; the fade/inside/hidden state selects the variant. This is the Unity cross-fade variant pattern and keeps
  the exact appearance.
- **Inside/cut/hidden:** a variant or a uniform branch that skips the 16-entry `hiddenMask` loop in normal play.
- **Cloud shadow:** the 4.0 map + stamp (section F7); the analytic path stays as the reference for one photo comparison.
- **Sea/water:** `depthWrite=false`, a depth-based early-out, a sea plane clipped to the visible water region, water grid
  by projected size.
- **Grass:** per-block frustum selection (section F9).
**Acceptance:** per-pass GPU ms and per-class counts before/after; the four-view photos identical at 1:1; a night view.

### 4.6 P5 — Shadows

- **Per-cascade lists:** run the props cull once per cascade (or write per-cascade offsets in one compute); vehicle/person
  lists per cascade; the movers' last cascade (4.0 `sunCascades.ts:424`).
- **Still-caster protection:** keep casters under the cascades' cover box so a pan does not invalidate the store
  (4.0 `cellInstances.ts:56-62`); restore hidden casters for the shadow pass.
- **Scroll:** scroll the cached store and redraw only the exposed strips (4.0 `sunCascades.ts:44,563-641`; Acton 2012),
  instead of redrawing all three cascades on a turn.
- **Caster shapes:** simplified caster meshes by cascade texel (4.0 `shadowLevels.ts:1-20`; meshoptimizer with an absolute
  error, as 4.0 does). If R5 adopts the simplifier, it must be a declared dependency or vendored — the npm registry is
  blocked on this machine, and the installed `node_modules/meshoptimizer` is not declared in `package.json`; the near
  cascade keeps the full model where the texel needs it.
- **Store copy:** replace the 3 × 16 MB/frame store→map copy with a ping-pong pair or a separate mover map sampled with
  `max` in the shadow filter; measure the copy before changing it.
- **`moving`:** pass true only when a mover is in a cascade and actually moves (not merely because `windU > 0.001`).
**Acceptance:** shadow photos (morning, low sun, night), a turn sequence, no missing/doubled shadows, the shadow map size
and splits unchanged, GPU ms and draws per cascade recorded.

### 4.7 P6 — Memory and the 24 km map

- 2D atlas or split arrays for heights, ground, water, paint, ecology and slope; sub-rectangle updates; never more than
  256 array layers on a default adapter (WebGPU spec); keep per-tile updates bounded (only the edited tile).
- A global `GpuLedger` and a budget for every class; make layer budgets hard (stop requesting, fall back a level, never a
  hole) and count RTs, shadow maps, the props pool, the people buffers and the terrain textures.
- Props pool: per-kind/view residency and a measured capacity; no whole-map ring.
**Acceptance:** 24 km opens on a 256-layer adapter; save/reopen; the four views and the ledger pass; no visual change.

### 4.8 P7 — Loop, view scale and the quality gates

- Keep vsync and the still-frame stop; no adaptive detail and no frame cap to hide cost (CLAUDE.md).
- One `ViewScale` (section F16) used by all LOD selection.
- Every change: `npx tsc --noEmit`, `npm test`, `npx vite build`, `node tools/verificar.mjs`, `npm run arch:check`, and
  `npm run budget` when drawing changed; photos opened with Read in the same views before/after and next to 4.0; a frame
  sequence only for motion/flicker; the report states what the photos showed. Never weaken a test or a threshold.

---

## 5. Verification protocol for this audit and for every fix

**This audit:** code read at `8235e51`; official/technical sources below; recorded measurements quoted with their commit and
date; no game/build/budget/photo run (owner rule). The ranking of GPU milliseconds is not measured in this session; the
findings are ranked by structure and by the recorded totals. The ranking must be confirmed with `?perf` per-pass GPU
timestamps before a fix is chosen, as the previous report also stated (`reports/gpu-load-2026-10-31.md:247-254`).

**For each fix:** (1) the before/after `?perf` per-pass ms and the budget table per class; (2) the four standard photos
(street, district, city, night) at the same views, plus a 4.0 photo at the switch distance for LOD/occlusion; (3) a turn
sequence or a short frame sequence when the defect is motion; (4) the exact commands in the commit and the report; (5) no
change to `tools/budget.json` except on `main` after the owner's review; (6) a new test that fails before the fix and passes
after (occlusion conservative; LOD switch; mask variant; cloud-shadow map equal to the analytic reference within the
photo/measure tolerance).

---

## 6. Recorded open items outside this audit (not re-verified here)

These are in `MEMORY/STATE.md`/`MEMORY/DECISIONS.md` and are relevant to performance but were not re-measured in this
session. They are listed so the picture is complete; each needs its own measurement before a number is used:

- Opening a generated city ~26 s (ready 6 s, generation 8 s, meshing 12 s), 2026-10-31.
- City budget 3.29× over and map/night over (section F3; D81 table).
- The turning p99 43.7 ms hitches, cause not measured (2026-10-31).
- The bomb's +4,906 draws recorded in the 2026-10-30 audit; the current code uses instanced debris and a BatchedMesh ruin
  (`features/demolition/blast/debris.ts:5,93`; `ruin/ruinMesh.ts:5,79`), so re-measure before acting.
- Routing (`router.route` 18.36 ms/step in the 2026-10-30 audit; later 0.49–0.97 ms/route and 30.5 ms/step in the D45
  runs) and the 250k-building density target are simulation/CPU topics, not GPU frame topics.
- The 24 km map's 576 texture-array layers (section F11) is both a feature gap and a memory issue.

---

## 7. Sources

**Official documentation and papers**

- W3C, *WebGPU* (limits: `maxTextureArrayLayers` default 256; `GPUQuerySet`; occlusion queries): https://www.w3.org/TR/webgpu/
- MDN, `GPUDevice.createQuerySet()` (type `"occlusion"`; occlusion queries on render passes; not Baseline): https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/createQuerySet
- MDN, `Window.requestAnimationFrame()` (callbacks match the display refresh rate): https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame
- Microsoft Learn, *Cascaded Shadow Maps* ("A null pixel shader is bound because only the depth is needed"; maps rendered one at a time): https://learn.microsoft.com/en-us/windows/win32/dxtecharts/cascaded-shadow-maps
- Unity HDRP 16.0, *Set a shadow update mode* (cached shadow maps; OnEnable/OnDemand; Every Frame does not cache): https://docs.unity3d.com/Packages/com.unity.render-pipelines.high-definition@16.0/manual/shadow-update-mode.html
- Epic Games, *Optimizing LOD Screen Size per Platform* ("UE5 uses the current size of the Static Meshes size in Screen Space"): https://dev.epicgames.com/documentation/en-us/unreal-engine/optimizing-lod-screen-size-per-platform-in-unreal-engine
- MJP, *To Early-Z, or Not To Early-Z* (discard + depth writes; 440,640 → ~582,000 PS invocations; depth writes off: "Early-Z is totally compatible with shader discard"): https://therealmjp.github.io/posts/to-earlyz-or-not-to-earlyz/
- Intel, *Masked Software Occlusion Culling* (3× faster than previous work; removes 98 % of the triangles culled by a full-resolution depth buffer): https://www.intel.com/content/www/us/en/developer/articles/technical/masked-software-occlusion-culling.html
- ACM DL, *Masked software occlusion culling* (Hasselgren, Andersson, Akenine-Möller, HPG 2016): https://dl.acm.org/doi/abs/10.5555/2977336.2977340
- Greene, Kass, Miller, *Hierarchical Z-buffer visibility* (SIGGRAPH 1993): https://history.siggraph.org/learning/hierarchical-z-buffer-visibility-by-greene-kass-and-miller/
- Acton, Day, Hastings, *CSM Scrolling* (SIGGRAPH 2012): https://advances.realtimerendering.com/s2012/insomniac/Acton-CSM_Scrolling(Siggraph2012).pdf
- Haar, Akenine-Möller et al., *GPU-Driven Rendering Pipelines* (SIGGRAPH 2015): https://www.realtimerendering.com/advances/s2015/index.html (the talk PDF is linked there)

**Roadcraft 4.0 local source (reference for mechanisms and values; never copied)**

- `lab/roadcraft/src/render/occlusion.ts:1-35` (software occluder; 80–90 % hidden; 256-wide buffer, 1500 m, 1.5 texel,
  8192 texel cap; Downs 2001; Hasselgren 2016; Greene 1993)
- `lab/roadcraft/src/render/buildings/layer.ts:135,1154-1172` (hide in the colour pass, restore for the shadow passes)
- `lab/roadcraft/src/render/buildings/massCells.ts:19-42` (`FAR_ERROR` 1.5, `FACADE_ERROR` 0.3, `NEAR_PIXELS` 2,
  `FINE_PIXELS` 0.5, `HYSTERESIS` 0.85, `DETAIL_REACH` 1400, `DETAIL_REACH_VISIBLE` 0.5)
- `lab/roadcraft/src/render/buildings/massing.ts:40-42` (`TILE_DETAIL` 1.4 m, `PLATE_DETAIL` 8 m)
- `lab/roadcraft/src/render/buildings/partCells.ts:26-27`, `kit.ts:112` (`BAR_PIXELS` 0.5, `PART_ERROR_PX` 1.5)
- `lab/roadcraft/src/render/sunCascades.ts:44,58-60,206-222,424,563-641` (STATIC SHADOW CACHE, `SCROLL_MOST` 0.5,
  `SAFETY_FRAMES` 600/`SAFETY_STAGGER` 10, movers' max cascade, strips and scroll)
- `lab/roadcraft/src/render/shadowLevels.ts:1-20` (caster shapes by cascade texel; meshopt absolute error)
- `lab/roadcraft/src/render/cellInstances.ts:56-62` (`KeptFrustum` under the cascades' cover box; `SMALL_CAST_TEXELS` 2)
- `lab/roadcraft/src/render/cloudShadowStamp.ts:1-54` (cloud-shadow map stamp)
- `lab/roadcraft/src/render/gpuLedger.ts:1-70` (GPU bytes/triangles by class and owner)
- `lab/roadcraft/src/render/depthFirst.ts:1-109` (depth prepass; polygon offset; reversed depth)
- `lab/roadcraft/src/render/buildings/gpuBatchedMesh.ts:60-95` (per-instance colour occlusion; shadow passes keep the
  instances)
- `lab/roadcraft/src/render/buildings/massCells.ts:177-182` ("DO NOT give detail to a cell out of `view`"; the detail
  residency cap in bytes)

**Roadcraft 5 local source (this audit)**

- `src/render/cellLayer.ts:289-310,360-380,382-398,404-457,471-495,498-545`
- `src/render/city.ts:90-125,133-150,183-280,443-461`
- `src/render/roads.ts:79-107,141-526`
- `src/render/terrain.ts:54-59,140-191,208-271,672-743,753-851,922-1018`
- `src/render/scene.ts:28-100,109-145,185-230`
- `src/render/props.ts:38-45,174-293,535-579,757-783,790-822`
- `src/render/propMeshes.ts:100-152,630-691,714-769,792-823`
- `src/render/partSize.ts:44-109`, `src/render/partCards.ts:1-99`
- `src/render/post.ts:53-135,160-181,183-312,316-442`
- `src/render/cloudShadow.ts:1-55`
- `src/render/vehicles.ts:24-27,43-70,370-467`
- `src/render/people/crowd.ts:27-36,117-130,230,329-339`
- `src/render/depthPrepass.ts:1-89`
- `src/render/inside.ts:21-51`
- `src/render/weather.ts:15-28,96-206,264-321`
- `src/game.ts:548-553,584-662,666-684,726-873,1085-1091,1132-1138`
- `src/config.ts:5-46`
- `src/platform/settings.ts:42-47`
- `tools/budget.mjs:20-27,39-42,55,75-99`; `tools/photos/views.mjs:9-15`; `tools/budget.json`
- `node_modules/three/src/objects/BatchedMesh.js:143-151,211`; `src/renderers/common/Info.js:156-162`;
  `src/renderers/webgpu/WebGPUBackend.js:2128-2136`; `src/nodes/lighting/ShadowNode.js:675-679`
- `reports/gpu-load-2026-10-31.md` (previous analysis; its §2.1/§2.2 items are partly superseded by the part cards and
  the size cull at `8235e51`; its §2.4, §2.3 and §2.5 remain aligned with this audit)

---

## 8. What this audit did not verify

- No GPU time per pass, frame time, budget run or photo was produced here; the ms and triangle figures are recorded ones,
  not new measurements.
- The ranking of the causes by milliseconds is inference from code structure and the recorded totals; the per-pass
  measurement (P0) is the first fix precisely because it is missing.
- The exact geometric error of each R5 LOD mesh (L1 vs L0, L2 vs L1, L3 vs L2) has not been measured; the fix plan says to
  measure it before choosing the switch distances. 4.0's 1.5/0.3/1.4/8 m are the reference values, not R5's.
- The 24 km VRAM figure (≈427 MB for the seven arrays) is arithmetic from the code and `config.ts`, not a GPU reading.
- The effect of each proposed change on the image is not claimed; each must pass the 1:1 photo and the four-view protocol.

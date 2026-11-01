# The far levels' geometric error (cause fixed) and the SSE switches — Roadcraft 5

Date: 2026-11-01. Tree: `roadcraft-novo`, working tree on `main` (nothing committed; the working tree is the source).
Scope: audit item 1 (the cause of the far levels' error) and item 2 (one SSE traversal feeding the cell switches).

## 1. The cause, found (item 1)

The probe `test-results/lodErrorProbe.ts` measured the error of L0 against L1/L2/L3 for the real levels:
L1 0.2–3.5 m, L2 1.5–3.5 m, L3 1.7–3.5 m, worst at the crowns (y ≈ 36/67 m) of style-10/3 towers. Reproduced in
this session before any change (same numbers).

Instrumenting the worst vertices (`test-results/lodErrorFeature.ts`, `lodErrorShape.ts`) named the features: a
**mast 0.08 m thick and 3.5 m tall** on the tower's roof (`world/roofPlant.ts` kind `mast`, `h: 3.5`, 70 % of
buildings with ≥ 10 storeys) and **tankBox ladders 3.1 m tall** — dark `#2d3033`, exactly the measured points.

**The mechanism:** `r40/render/buildings/roofMesh.ts` skipped thin structures at the far level by THICKNESS
(`if (far) break` on the mast, the tankBox ladder, the dish post; the pergola posts and the parasol poles too), but
the geometric error of an omission is the feature's LARGEST dimension, not its thickness. Roadcraft 4.0 has the same
code and the same defect — but its own comment states the intent the code breaks: "THE FAR LEVEL LEAVES OUT WHAT IS
UNDER ITS ERROR (`FLAT_DEPTH`, 0.3 m)" (`buildingMesh.ts:2298`). R5 inherited the defect and made it measurable.

A second, independent deviation: R5's `TILE_DETAIL` drop was **3 m** where 4.0's is **1.4 m**
(`lab/roadcraft/src/render/buildings/massing.ts:40` — verified in the source; the task list said 3 m, the reference
says 1.4), so R5's tile masses dropped attic crowns (1.5 m) and machine rooms (3 m) that 4.0's tile keeps. And the
massing's roof plant lacked the mast entirely (4.0's mass program does too — `DRAWN_PLANT` without `mast` — which is
4.0's own inconsistency against its `TILE_DETAIL` rule; the fix draws it and lets the level's `leaves(it.h)` decide).

## 2. The fix (geometry, never a constant to hide the symptom)

- `r40/render/buildings/roofMesh.ts`: the far level keeps every structure taller than its documented error budget
  (FLAT_DEPTH, 0.3 m) in its largest dimension: the mast (3.5 m, shaft + arms), the tankBox ladder (it.h + 0.9),
  the dish post (0.7 m), the pergola posts (2.4 m) and the parasol poles (2.3 m). Fittings a few centimetres proud
  stay far-left-out (drains, lids, fans, solar feet).
- `r40/render/buildings/massing.ts`: `TILE_DETAIL` drop 3 → **1.4 m** (4.0's value); the mast enters the massing's
  roof plant gated by `w.leaves(it.h)` — drawn at the tile (3.5 > 1.4), left out at the plate (3.5 ≤ 8, inside the
  plate's own drop).

## 3. The metric, formalized (the task's requirement)

The naive distance-to-mass is wrong (a fence 16 m from the building is not "16 m of error"). The level's error is
the largest feature it misrepresents: per connected component of fine vertices standing clear of the coarse surface,
the error is min(displacement from the represented surface, the feature's own rise). A full implementation lives in
this session's history of `test/lodLevels.test.ts`; it proved the before/after (L1 3.5 → ≤ 0.31) but its exact
point-to-mesh distance was too slow for the suite (~60 s per call on the 15 k-vertex L0 against the massing's large
triangles, even triangle-centric). The committed test pins the same contract the cheap way — the skyline
(`topOf(L0) − topOf(level)`), which is exactly the largest omission, plus the drops' constants and the SSE
derivations; the expensive metric stays out of the suite. Honest limit: the committed test would not catch a buried
3.1 m omission that is not the tallest thing; the photo pairs and the probe cover that.

## 4. Item 2: the switches derive from the measured errors, one rule

- **New `src/render/viewError.ts`**: the screen-space-error rule (Cesium 3D Tiles selection,
  `maximumScreenSpaceError`) — `distance = error × PX_PER_METRE_AT_1080 / threshold`, with the pixel budgets
  documented (NEAR_PIXELS 2, FINE_PIXELS 0.5 — 4.0 `massCells.ts:23,28`) and `viewScale(camera, framePx)` reading
  the ACTUAL projection: the perspective's fov (was missing, audit F16) and the orthographic's frustum height, so
  the zoom drives the switches instead of a distance that ignores it.
- **`src/render/city.ts`**: `near`/`detail`/`plate` are no longer literals; they derive from the levels' own errors —
  `max(FAR_ERROR 1.5, TILE_DETAIL.drop)` at 2 px → 978 m, `FLAT_DEPTH 0.3` at 0.5 px → 782 m,
  `PLATE_DETAIL.drop 8` at 2 px → 5216 m. Change a level's drop in `massing.ts` and its switch follows. The same
  numbers as before at the reference view (behaviour preserved), now one cause.
- **`src/game.ts`**: `updatePixelScale` uses `viewScale` on the real camera and runs every frame (the ortho zoom
  changes it per frame; the layers' own `lastScale` check keeps it free when still). Roads/seams keep CDLOD.
- The single traversal (frustum + occlusion + error distance in one `CellLayer.update`) was already the
  architecture; what changed is what feeds it.

## 5. Proof

### Gates
- `npx tsc --noEmit` clean; `npm test` **540/540** (was 534; +6 = `test/lodLevels.test.ts`); `npx vite build` ok;
- `npm run arch:check` ok; `node tools/verificar.mjs` **145 ok, 1 failed** — "road keys can be changed", the same
  pre-existing failure recorded 2026-10-31 (an earlier capped run reported a different failure: my 60 s timeout, not
  the game);
- `npm run budget`: recorded below when the run finished.

### Photos (opened and described by the writer)
All under `test-results/lod-fix/`, test city `?test&map=4`, tower (1646,1663) 14 storeys, 1600×900, machine GPU.

| pair | what was seen |
|---|---|
| `recon.png` / `recon-before.png` (1100 m wide) | same skyline; the AFTER towers carry small dark roofline needles (masts/ladders) the BEFORE lacks beyond the switch |
| `crown-before-850.png` / `crown-after-850.png` (1:1 crop) | BEFORE: clean flat rooflines; AFTER: dark needles on the same towers (the masts 3.8 px tall at 850 m) |
| `crown-before-1000.png` / `crown-after-1000.png` | same: needles present only AFTER |
| `crop-after-700` vs `crop-before-700` (control, L0) | identical — the fix touches only the far levels |
| `sse-850.png` (+ `sse-crown-850.png`) | the same view with the derived switches: no change of level behaviour, crowns identical to `after-850`; SSIM 0.974 against it (rest = sim motion: vehicles, people, grass) |
| `after-wide.png` | full view: skyline intact, no holes, no popping; the floating grass over the sea is the camera-locked field seen from off the coast — pre-existing (present in every ladder photo, both states) |

Numeric compare (`images.mjs compare`): before/after 850 full frame — 23.4 % pixels changed, SSIM 0.983 (the crown
needles plus sim motion); control 700 m crown band — MAE 0.0047 (lowest of the rungs), 850 m — MAE 0.0074, 1000 m —
0.0062, 1150 m — 0.0056: the far-level bands differ more than the L0 control, as the added far geometry predicts.

### Numbers
- The probe (before → after): L1 max error 3.5 m → ≤ 0.31 m (FLAT_DEPTH); L2 3.5/1.5–1.98 → within
  max(1.5, TILE 1.4); L3 1.7–3.5 → within its 8 m drop (unchanged, was already inside).
- Switch distances (1080p/45°): near 978 m, detail 782 m, plate 5216 m — same values, now derived; at the shot's
  1600×900 the scale is 0.833 → near 815 m (unchanged behaviour).
- Cost: the far shell gains ~30–60 triangles per mast/ladder/pole-bearing roof; the massing gains the mast box at
  tile distance. Budget table below when the run printed.

## 6. Failed attempts and reverts (honest record)

- The exact Hausdorff-style metric in the committed test: correct but far too slow for the suite (60 s+ per real
  mesh pair even after triangle-centric scatter); replaced by the skyline contract + synthetic metric cases. The
  slow version lives in the session history and proved the fix.
- Three photo sessions failed before the working one: the in-app browser cannot host the game (no COOP/COEP
  isolation inside the embedded view); `rc.view` does not exist (the published path is `rc.camera.view`);
  top-level `await` is invalid in Electron's `executeJavaScript` (scripts must be IIFEs). Each failure left the
  camera at the boot pose and produced top-down photos — those runs were discarded, not analysed as evidence.
- One `verificar` run reported a new failure ("furniture from the menu"): my 60 s timeout killed it mid-script; the
  full run returned the pre-existing single failure.

## 7. Still open

- The budget's city/map rows (running when this section was written; see `tools/budget.log` output in the session).
- The audit items: per-cascade shadow culling/scroll, cloud-shadow map, water early-out, draw-slot batching,
  24 km texture arrays, per-pass attribution, memory budget, `?webgl` re-run, the minicity occlusion turn sequence.
- The pre-existing `verificar` failure ("road keys can be changed").

# STATE — Roadcraft 5 (roadcraft-novo), 2026-11-01 (2nd session)

Active memory of this repository. The 4.0 reference is `../roadcraft` (visual/functional only, never a code or
optimization reference — its code is NOT assumed correct; every technique is verified against documentation).

## Fixed today (causes, with proof)
1. **The far levels' error (audit item 1).** The far shell skipped thin roof structures by THICKNESS: the mast
   (0.08 m thick, 3.5 m TALL), tankBox ladders (3.1 m), dish posts, pergola posts, parasol poles — its measured
   error was 3.5 m where 4.0's documented intent is 0.3 m (`FLAT_DEPTH`; 4.0 has the same defect). The far level now
   keeps anything taller than FLAT_DEPTH in its largest dimension. The massing's `TILE_DETAIL` drop 3 → 1.4 m
   (4.0's value; the task list's "3 m" was wrong, the source says 1.4) and the mast entered the massing's plant
   (`leaves(it.h)`: drawn at tile, dropped at plate). Files: `r40/render/buildings/roofMesh.ts`, `massing.ts`.
2. **The switches derive from the levels' errors (audit item 2).** New `src/render/viewError.ts` (Cesium SSE rule,
   NEAR_PIXELS 2 / FINE_PIXELS 0.5 from 4.0 massCells.ts; `viewScale` reads the real fov / ortho zoom — audit F16).
   `city.ts` derives near 978 / detail 782 / plate 5216 from FAR_ERROR, FLAT_DEPTH and PLATE_DETAIL.drop (imports
   the drops, never copies). `game.ts updatePixelScale` uses `viewScale` per frame (ortho zoom drives it).

## Gates (this tree)
- `npx tsc --noEmit` clean; `npm test` **540/540** (+6 `test/lodLevels.test.ts`); `vite build` ok; `arch:check` ok;
  `verificar.mjs` **145 ok, 1 failed** (pre-existing "road keys can be changed", recorded 2026-10-31);
  `npm run budget` — see the report for the table when the run printed.
- Photos (opened and described): `test-results/lod-fix/` — before/after pairs at 1100/850/1000/1150 m + L0 control
  at 700 m; the mast needles appear on the far towers only after the fix; `sse-850.png` proves the derived switches
  draw the same image (SSIM 0.974 vs after-850; rest is sim motion).
- Report: `reports/lod-error-and-sse-2026-11-01.md`.

5. **The void is never seen (the owner's photo).** The camera's eye was not clamped to the map - only
   the target was - so at an edge target with distance the camera flew outside and the edge hills' trees and
   the camera-locked grass read as floating in the void. The eye now clamps to the map (cameraRig.syncCamera);
   the grass tufts past the edge never grow (material + GPU cull). Commits on port/roadcraft-features-dev:
   814c4fd (levels + SSE + GPU floors), badb328 + 7797f30 (memory, eye clamp).

## Open (2026-11-02)
- The colour cull was invalid from 93a768c to 2026-11-02 (9 storage buffers): every number recorded in that window for props is void.
- Far-road shimmer: the fix (density cars to their mean under a pixel) is not confirmed in motion on the big map.
- Second TRAA history held for the night image; props/pyramid CPU mirrors (about 30 MB); uncompressed RGBA8 textures.
- Nothing committed. See MEMORY/WORKLOG.md (2026-11-02 entries) for the causes fixed and their proofs.

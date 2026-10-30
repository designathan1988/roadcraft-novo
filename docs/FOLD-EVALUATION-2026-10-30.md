# FOLD engine — evaluation against the game (2026-10-30)

Source: `C:\Users\Jonathan\Documents\Projects\engine` (README.md, docs/VERIFICATION.md read in full; tools run).

## What was run

| Command | Result |
|---|---|
| `npm run verify` (default) | passes: 39/39 tests, contract, game-mesh 5.06x, real-city 4.91x / 9.99 B per triangle, cell-stream 100% exact at rest. **But it reads `lab/roadcraft-novo`, which is on the old branch `density-probe-250k`, not the code of this branch.** |
| `ROADCRAFT_DIR=…/roadcraft-novo-port npm run verify` | **fails**: the contract and the real-data tools import `src/jobs/protocol.ts`, moved to `src/shared/contracts/worker.ts` in the reorganisation. Only `game-mesh` runs (5.06x, roundtrip exact). |

So the FOLD's own proofs are of an older game; against the current code its tools do not run.

## Each fold against what the game already does

| FOLD part | Claim | In the game today | Decision |
|---|---|---|---|
| Mesh codec (archive) | 4.91x smaller meshes, exact | Meshes are generated in workers and handed to the page as transferable buffers (zero copy); they are never stored or sent over a network. A codec would add a decode on the page (main-thread CPU) and save nothing at run time. | **Not used.** Would only pay for a mesh cache on disk, which the rules forbid as a requirement. |
| GPU layout 12 B/vertex | 2x on the vertex | The game packs 16 B: position snorm16x4 (8; `w` is used: road tag in render/roads.ts:169, cut tag in render/inside.ts:28), normal snorm8x4 (4; only `xy` read, render/tsl.ts useCompactVertex), colour rgb + material (4). FOLD drops `position.w` and replaces the colour by a 16-bit palette index. Keeping `w`, a separate 2-byte normal buffer is not allowed (WebGPU arrayStride must be a multiple of 4); the gain needs an interleaved buffer and a per-mesh palette lookup in three materials. | **Candidate, not now**: at most 4 B of 16-24 B per vertex (-17% to -25% of vertex bytes), against a material rework; GPU memory is not the measured limit (all views within their MB limits). Revisit if VRAM becomes the limit. |
| Stream (cell + LOD residency, prefetch, fallback) | 5.8x resident vs all LODs, never a hole | `render/cellLayer.ts` already does this: L0/L1 per cell, L2 per tile, L3 per plate, built in workers, coarser level shown until the finer arrives, eviction by distance and budget. | **Already in the game** (same design). |
| Atlas (dedup of identical buildings) | up to 29x on a synthetic city | FOLD's own measurement on the real generator: U/N = 1.00 (every building unique): 1.40x. | **Blocked**, as FOLD itself says. |
| View governor | resolution scale, LOD bias, shadow cadence | `game.ts adaptDetail` already shrinks detail distances when the 90th percentile frame passes 20 ms; there is a resolution setting. Not present: shadow cadence. | **To measure later**, in game, with GPU time before/after and photos (shadow cadence can lag moving shadows: a quality risk). |
| Time fold (events instead of visits) | ~95x on the worst tick | Pedestrians are an event heap (sim/peds.ts), far traffic is the meso event heap (sim/traffic/meso.ts); micro only near the camera. | **Already in the game.** |

## Conclusion

Nothing of the FOLD is integrated now: what would help (stream, events) is already the game's design; what it adds
either costs main-thread work for no run-time gain (codec), is blocked by its own measurement (atlas), or is a
modest VRAM saving with a material rework that no current limit asks for (vertex layout). The one item worth a
measured trial is shadow cadence in the governor, with GPU time and photos before and after. The FOLD's tools must
be pointed at `src/shared/contracts/worker.ts` before any of its numbers can be re-checked against this code.

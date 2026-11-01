# DECISIONS — Roadcraft 5 (roadcraft-novo), active record

## 2026-11-01 — Workspace and worktree
- Work in `roadcraft-novo`; the port branch worktree is inside `.claude/worktrees/port` (owner's instruction). The old
  sibling `roadcraft-novo-port` was moved there, not deleted. The old lab/MEMORY stays as history; this repository
  MEMORY is the active one. No old memories or outdated documents were brought over.

## 2026-11-01 — Prop `pext` semantics
- `pext` carries two different payloads: the tree/impostor cards' atlas uv + billboard corner, and a thin building
  part's bar width/tone/pattern. The material now disambiguates by finish (`foliage`: Leaf, LeafCard, Impostor) and
  never applies the thin reading to foliage. The alternative (a new per-vertex attribute) was rejected: it would add
  16 B/vertex to every prop geometry for a field only thin parts use; the finish is the semantic owner of the payload.

## 2026-11-01 — LOD transition
- The permanent spatial dither (fixed IGN mask over a distance band) was replaced by a timed dissolve per instance:
  Cesium's documented dithered LOD transition (threshold ramped in time, noise changing every frame, TAA resolves;
  0.5 s default, 450 ms here; 6 % distance hysteresis). One level per instance at rest. The state (key, from/to, start)
  lives in a read-write `StorageBufferAttribute` (three.js StorageBufferNode docs). The camera turn/transition sequence
  is the proof; the still after the dissolve shows no pattern.

## 2026-11-01 — File ownership
- `props.ts` and `terrain.ts` crossed the file-size rule; split by responsibility, not by raising a ceiling:
  `propMaterial.ts` (the material), `propFallback.ts` (WebGL 2 cells), `propsProbe.ts` (measurements),
  `grassCulling.ts` (GPU grass cull + height range). `arch:check` passes.

## 2026-11-01 — The far level's omission rule
- The far level leaves out only what is under FLAT_DEPTH (0.3 m) in the feature's LARGEST dimension (its height or
  depth), never by thickness. 4.0 documents this intent and breaks it in code (the 3.5 m mast is `near()`-only);
  the fix follows the intent, not the defect. 4.0's code is a visual/functional reference only and is not assumed
  correct — verified against its own sources (massCells.ts FAR_ERROR, massing.ts TILE 1.4/PLATE 8).
- The massing draws the mast gated by `leaves(it.h)`: the level's own drop decides (tile keeps 3.5 m, plate drops
  it) — no per-level special cases.

## 2026-11-01 — The switch distances are derived, never literals
- near/detail/plate come from the levels' geometric errors through viewError.ts's SSE rule with documented pixel
  budgets (2 px far/plate, 0.5 px facade). Changing a level's drop in massing.ts moves its switch; nothing to sync.
- The view scale reads the camera's real projection per frame (fov; ortho zoom) — the old scalar ignored both
  (audit F16). The 0.3–3 clamp stays as a pathological-view guard, documented.

## 2026-11-01 — The error metric in the suite
- The committed test pins the skyline contract (topOf(L0) − topOf(level) ≤ the level's reference): cheap and it
  catches the mast class of defect (the tallest omission). The exact per-feature metric (min(displacement, rise)
  over connected components) proved the fix but costs ~60 s per real mesh pair; it stays out of the suite until it
  has a real acceleration (BVH), and its absence is recorded as an honest limit: a buried omission that is not the
  tallest thing is caught by photos/probes, not by the suite today.

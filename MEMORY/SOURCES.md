# SOURCES — Roadcraft 5 (roadcraft-novo), active record

Sources used by the current work. The previous full research log is in `reports/optimization-research-and-working-set-
2026-11-01.md`.

- Cesium 3D Tiles selection (geometric error, `maximumScreenSpaceError`, screen-space error refinement):
  https://cesium.com/learn/cesium-native/ref-doc/selection-algorithm-details.html
- Cesium, Smoother LOD Transitions with Dithered Opacity Masking (timed dither threshold, noise every frame, TAA,
  0.5 s default): https://cesium.com/blog/2022/10/20/smoother-lod-transitions-in-cesium-for-unreal/
- three.js local docs: `docs/pages/StorageBufferNode.md` (access `readWrite`, `.element()`, `toReadOnly`/`toAtomic`),
  `docs/pages/StorageArrayElementNode.md`, `docs/pages/IndirectStorageBufferAttribute.md`, and the compute examples —
  `C:\Users\Jonathan\Documents\three\docs\site-threejs.org-20261018-161507\paginas`.
- Unity URP `LODCrossFadeDitheringType` (Bayer/BlueNoise/Stencil) and Unreal `AllowDitheredLODTransition` — reference
  for the dither variants only; the implementation is three.js TSL/WebGPU.
- Roadcraft 4.0 (`../roadcraft`): visual reference (tree crowns, LOD appearance). Its code is not an optimization or
  architecture reference; every technique used here was checked against the official documentation above.
- Cesium 3D Tiles selection (geometric error, maximumScreenSpaceError, SSE refinement) — reused for viewError.ts:
  https://cesium.com/learn/cesium-native/ref-doc/selection-algorithm-details.html
- Roadcraft 4.0 (read-only, visual/functional reference; NOT assumed correct): `massing.ts:36-45` CELL/TILE(1.4)/
  PLATE(8) MassDetail; `massCells.ts:19-42` FAR_ERROR 1.5, FACADE_ERROR=FLAT_DEPTH, NEAR_PIXELS 2, FINE_PIXELS 0.5,
  HYSTERESIS 0.85; `buildingMesh.ts:2294-2300` the far level's documented 0.3 m budget (broken by its own mast code);
  `buildingMesh.ts:1555-1648` recordRoofPlant/recordRoofSlab (the mass program's plant groups; DRAWN_PLANT without
  mast — its own inconsistency); `world/buildings/roofPlant.ts:69` mast h 3.5.
- Ericson, Real-Time Collision Detection — point-to-triangle distance (the metric's inner loop).

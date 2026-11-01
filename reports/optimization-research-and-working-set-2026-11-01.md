# Optimization research and consolidation — the view-driven working set

Date: 2026-11-01. Repository: `roadcraft-novo` (the same tree as `roadcraft-novo-port`). This document records the
research, the causal analysis of the CPU/GPU/memory behaviour, the consolidated solution, and the first step applied to
the game. **No new measurement or test was run after the owner's order to stop measuring**; the numbers quoted as
"recorded" were produced before it, and the code of the new step has not been compiled or run since.

---

## 0. The question, answered directly

**Why do GPU, CPU and memory rise?**
They are three different resources used by one frame pipeline:

- **CPU** does the frame's logic and the render submission: scene traversal, visibility choices, draw-call encoding,
  uniform/buffer updates, the simulation worker, the meshing workers, and JavaScript allocation/GC.
- **GPU** executes the submitted passes: scene, three shadow cascades, post-processing. It is busy for as long as the
  submitted triangles, fragments, shadow pages and post passes take.
- **Memory** is the **resident working set**: geometry kept on the GPU/CPU, props pool, shadow maps, render targets,
  terrain textures, worker copies, and the renderer's caches. It is not produced by CPU or GPU utilization; it is what
  the game has decided to keep resident.

**Why does lowering CPU raise GPU, and lowering GPU raise CPU?**
Because CPU and GPU are **two stages of the same pipeline**, and the frame has a fixed amount of work. If the CPU is the
slower stage, the GPU waits and shows low utilization. Making the CPU faster (for example, using 4 workers instead of 30)
does not remove any GPU work; it feeds the same work faster, so the GPU becomes the new bottleneck and its utilization
rises to 100 %. Making the GPU faster (for example, disabling shadows) removes GPU work but not CPU work; the CPU then
becomes the bottleneck and its utilization rises. This is the bottleneck moving, not the game creating work on the other
side. The same total work remains, and memory does not fall because nothing was evicted or compressed.

**What the recorded diagnostics showed in this game (before the owner's stop order):**

| observation | value |
|---|---|
| default worker pool | `hardwareConcurrency − 2`; on the test machine this opened ~30 workers |
| turning camera, normal play | CPU total 100 % in 25 of 37 samples; GPU 42–68 %; private memory up to 8 GB |
| turning camera, simulation paused | CPU still 100 % in 20 of 29 samples; GPU 40–76 % |
| turning camera, no shadows | CPU still 100 % (18 of 29); GPU ~48 %; scene 16.7 M triangles, 228 draws |
| turning camera, shadows on | 45.9 M triangles, 418 draws; three shadow cascades are ~29 M of those triangles |
| street still | GPU 9.0 ms, CPU `draw` ~9.1 ms; before the worker cap |
| after capping workers to 4 | CPU max 74 %, no sample ≥ 90 %; GPU became the limiter (p95 100 %) |
| geometry resident | city 1.2 GB, roads 0.31 GB; VRAM ~3.3 GB; private memory ~8 GB peak |

The conclusion is exact: **CPU and GPU are not independent problems.** The only change that lowers both is reducing the
work per frame; the only change that lowers memory is reducing the resident set. The design below does both by making the
**visible working set** drive what is generated, uploaded, kept and drawn.

---

## 1. Research log — what the sources say

The rule for this log: every claim that shaped the design is recorded with its source. These are official documentation,
papers, or engine/API references, not the old Roadcraft code.

### 1.1 Frame pipeline, CPU/GPU bottlenecks and workers

- **PresentMon (Intel/GameTechDev)** defines the metrics that separate the stages: `MsCPUBusy` = "How long the CPU spent
  working on this frame before presenting it"; `MsGPUWait` = "How long the GPU was idle while working on this frame";
  `MsGPUBusy` = "How long the GPU was actively working on this frame". This is the measurement model for the causal
  analysis: a low `GPUBusy` with a high `CPUBusy` is CPU-bound; the opposite is GPU-bound.
  https://github.com/GameTechDev/PresentMon (README-ConsoleApplication.md)
- **Unreal Engine, Visibility and Occlusion Culling**: culling methods "are applied in this order based on their cost":
  Distance, View Frustum, Precomputed Visibility, Dynamic Occlusion. Hardware occlusion status is "read back one frame
  later", which causes popping; "The cost of hardware occlusion scales with the number of queries performed on the GPU."
  It also says "Visible Static Mesh Elements is the single biggest contributor to rendering thread time".
  https://dev.epicgames.com/documentation/en-us/unreal-engine/visibility-and-occlusion-culling-in-unreal-engine
- **Unity, Occlusion Culling**: "Preventing wasted rendering operations can save on both CPU and GPU time. Unity's
  built-in occlusion culling performs runtime calculations on the CPU, which can offset the CPU time that it saves.
  Occlusion culling is therefore most likely to result in performance improvements when a Project is GPU-bound due to
  overdraw." It also says baked occlusion "is not suitable" for geometry generated at runtime.
  https://docs.unity.com/en-us/engine/current/manual/cameras/occlusion-culling/occlusion-culling
- **Godot, Occlusion Culling**: the CPU rasterises occluder geometry into "a low-resolution buffer", with an Embree BVH;
  an object is culled only when its AABB is "fully occluded". The gain is "fewer vertices to render and fewer draw calls".
  https://docs.godotengine.org/en/stable/tutorials/3d/occlusion_culling.html
- **MDN, `navigator.hardwareConcurrency`**: "returns the number of logical processors available to run threads on the
  user's computer"; the browser "may choose to report a lower number"; it is not an absolute core count. A pool sized to
  the reported number can oversubscribe the machine and starve the page.
  https://developer.mozilla.org/en-US/docs/Web/API/Navigator/hardwareConcurrency

### 1.2 Visibility and occlusion culling

- **Intel, Masked Software Occlusion Culling** (Hasselgren, Andersson, Akenine-Möller, HPG 2016): the method "has very low
  memory overhead", is "3x faster than previous work", and removes "98 % of all triangles culled by a full resolution
  depth buffer approach". It supports "interleaving occluder rasterization and occlusion queries without penalty", which
  makes it "easy to use in scene graph traversal or rendering code".
  https://www.intel.com/content/www/us/en/developer/articles/technical/masked-software-occlusion-culling.html
- **Greene, Kass, Miller, Hierarchical Z-buffer visibility, SIGGRAPH 1993**: the hierarchical depth pyramid tests boxes
  against the farthest occluder under them; the basis of the conservative software occluder.
  https://history.siggraph.org/learning/hierarchical-z-buffer-visibility-by-greene-kass-and-miller/
- **Downs, Akenine-Möller, Séquin, Occlusion horizons for driving through urban scenery, I3D 2001**: a 2.5D city occludes
  most of what the frustum keeps; city geometry is its own best occluder.
- **Unity** (above): occlusion culling pays when GPU-bound by overdraw, but its CPU cost can offset the gain; use the
  simplest occluders; occlusion does not help a CPU-bound renderer by itself.
- **Godot** (above): conservative AABB test; smaller objects are easier to cull; moving occluders force BVH rebuilds.
- **Unreal** (above): cull in cost order; hardware queries have a one-frame latency; reduce query count with distance and
  precomputed visibility.

### 1.3 LOD, HLOD and screen-space error

- **Cesium, `Cesium3DTileset`**: `maximumScreenSpaceError` is the error threshold that drives refinement: "If this value
  exceeds `maximumScreenSpaceError` the tile refines to its descendants"; SSE is "roughly equivalent to the number of
  pixels wide" that a sphere of the tile's geometric error would span. `cacheBytes` is "The amount of GPU memory (in
  bytes) used to cache tiles"; "Tiles not in view are unloaded to enforce this." `maximumCacheOverflowBytes` allows the
  view to exceed the cache to meet the SSE target; if the required tiles exceed cache + overflow,
  "`memoryAdjustedScreenSpaceError` will be adjusted" until they fit. This is the exact model for a view-driven working
  set with a memory budget.
  https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html
- **Unreal, World Partition — Hierarchical Level of Detail**: HLOD "uses custom HLOD Layers to organize large amounts of
  Static Mesh Actors and generate a single proxy mesh and Material" "to visualize unloaded World Partition grid cells, to
  reduce the number of draw calls per frame, and to increase performance." "Screen Size" "Determines size of the
  resulting proxy mesh in pixels." Loading Range/Always Loaded control streaming; large geometry has a high memory cost.
  https://dev.epicgames.com/documentation/en-us/unreal-engine/world-partition---hierarchical-level-of-detail-in-unreal-engine
- **Unreal, Optimizing LOD Screen Size per Platform**: "UE5 uses the current size of the Static Meshes size in Screen
  Space" to choose an LOD; transitions are set by screen size, with per-platform overrides.
  https://dev.epicgames.com/documentation/en-us/unreal-engine/optimizing-lod-screen-size-per-platform-in-unreal-engine
- **Unity, LOD Group**: LOD levels are percentages of screen height: "A LOD level box. Displays a percentage of the
  screen height." "Object Size" sets the object's size in metres for the calculations; changing it moves the transitions.
  https://docs.unity.com/en-us/engine/current/manual/analysis/graphics-performance-profiling/lod/lod-group/class-lodgroup
- **Unreal, Nanite Virtualized Geometry**: "It intelligently does work on only the detail that is visible on-screen and no
  more"; clusters "are culled individually on the GPU"; "Data is streamed in on demand so that only visible detail needs
  to reside in memory"; the format is compressed; Nanite "completely bypasses traditional draw calls", so frame budgets
  are no longer constrained by polycounts, draw calls and mesh memory. Practical limits (instances, triangles, materials,
  resolution, target hardware) still remain.
  https://dev.epicgames.com/documentation/en-us/unreal-engine/nanite-virtualized-geometry-in-unreal-engine
- **meshoptimizer**: simplification returns a normalized error so LOD distance can be controlled by the error ("1e-2
  means ... below 1 % of the mesh extents"); chaining LODs from the previous LOD is more efficient and gives smoother
  transitions; meshlets support cone/frustum culling; vertex/index compression is typically 2–4x and 1–1.2 bytes per
  triangle, decoded at GB/s. This is the tool for measuring/encoding LOD error and compressing the working set.
  https://github.com/zeux/meshoptimizer

### 1.4 Draw submission, CPU cost and batching

- **WebGPU render bundles (toji.dev)**: bundles "can significantly reduce the amount of CPU time spent issuing repeated
  rendered commands, especially in the browser"; they only help when the CPU is the limit. "You want to include as many
  draw calls in your render bundles as is practical", but only when reused; rebuilding per frame is not worth it.
  Indirect draws keep the CPU out of the loop because draw arguments are read from a buffer; GPU-driven culling with
  indirect draws is recommended, with the caveat that culled objects still cost empty draw calls.
  https://toji.dev/webgpu-best-practices/render-bundles.html
- **Dawn, multi_draw_indirect**: "allows issuing multiple draws with a single command"; without it, the CPU must submit
  every draw or read the GPU count back, "which can be a performance bottleneck"; the feature avoids that. It is a Dawn
  feature, not a core WebGPU guarantee, so it must be an optional path.
  https://dawn.googlesource.com/dawn/+/HEAD/docs/dawn/features/multi_draw_indirect.md
- **Unity, static batching**: combines meshes with the same material into one vertex/index buffer so the engine uses
  "fewer updates to the render state"; it can improve "performance, memory efficiency, and reduce CPU overhead". The
  trade-off: manually combined meshes "can't cull meshes individually".
  https://docs.unity.com/en-us/engine/current/manual/analysis/graphics-performance-profiling/reduce-draw-calls/draw-call-batching/draw-call-batching
- **three r186** (local source): `BatchedMesh` exists "to reduce the number of draw calls"; indirect draws are supported
  (`IndirectStorageBufferAttribute`), and three counts an indirect draw as one instance in `Info` unless the real
  arguments are read back. Those are the tools available in this project.

### 1.5 Shadows

- **Microsoft, Cascaded Shadow Maps**: cascades are rendered one at a time into the shadow buffer, with "a null pixel
  shader ... because only the depth is needed". A depth-only pass is the correct shadow baseline.
  https://learn.microsoft.com/en-us/windows/win32/dxtecharts/cascaded-shadow-maps
- **Unreal, Virtual Shadow Maps**: pages are "allocated and rendered only as needed to shade on-screen pixels"; they are
  cached between frames unless invalidated by moving objects or light; "Cached pages are very low cost and will have
  almost no impact on performance." Static caching can be separated. Shadow Depths cost depends on how many pages and
  how much geometry must be rendered; Shadow Projection is a function of the total samples. Non-Nanite instances are
  removed when they do not overlap required pages or are occluded. 
  https://dev.epicgames.com/documentation/en-us/unreal-engine/virtual-shadow-maps-in-unreal-engine
- **Unreal** (visibility doc): cull in cost order; hardware occlusion has one-frame latency; large bounds can impact
  shadow quality. 
- The standard caster-LOD principle: a caster drawn into a cascade need only be as detailed as that cascade's texel; a
  simplified shape within a texel casts the same shadow. This is why the near cascade uses cells and the far cascades use
  tile massings.

### 1.6 Memory, streaming and compression

- **Cesium** (above): `cacheBytes`, `maximumCacheOverflowBytes`, unload out of view, adjust SSE when the working set does
  not fit. The cache is a **budget**, not a suggestion.
- **Unreal, Texture Streaming Overview**: the streamer checks "if the streaming memory pool is big enough to hold those
  resolutions"; if not, it drops "one mip at a time" until under budget. It keeps landscape/forced/on-screen mips,
  drops "mips that are not visible, dropping the last recently seen first", and limits the memory updated per batch to
  keep "the number of inflight requests low". The 4.15 work cut "CPU usage, memory usage, and load times".
  https://dev.epicgames.com/documentation/en-us/unreal-engine/texture-streaming-overview-for-unreal-engine
- **W3C WebGPU limits**: `maxTextureArrayLayers` default 256; the 24 km map currently needs 576 layers.
  https://www.w3.org/TR/webgpu/
- **Nanite** (above): compressed data, streamed pages, only visible detail resident.
- **meshoptimizer** (above): 2–4x vertex compression, 1–1.2 bytes/triangle index compression, decoded at GB/s.

### 1.7 Overdraw and depth

- **MJP, To Early-Z or Not To Early-Z (2025)**: with depth writes on, a shader containing discard cannot commit depth
  before it runs; a discard that never fires raised pixel-shader invocations from 440,640 to ~582,000 in a front-to-back
  test. With depth writes off, "Early-Z is totally compatible with shader discard". The consequence: mask-free variants
  and depth prepasses are not cosmetic; they decide how much of the heavy materials run on hidden pixels.
  https://therealmjp.github.io/posts/to-earlyz-or-not-to-earlyz/
- **Microsoft HLSL proposal 0053** and the **Khronos Early Fragment Test** page agree on the late depth mode caused by
  discard. 

### 1.8 three.js documentation (the local copy at `C:\Users\Jonathan\Documents\three\docs\site-threejs.org-20261018-161507\paginas`)

- **BatchedMesh** (`docs/pages/BatchedMesh.md`): a special mesh "with multi draw batch rendering support ... to reduce the
  number of draw calls"; `perObjectFrustumCulled` = "When set to `true`, the individual objects of a batch are frustum
  culled"; `sortObjects` sorts front-to-back for opaque materials; `setVisibleAt(instanceId, visible)` changes an
  instance's visibility; `dispose()` frees its GPU resources. This is the native batching path for the working set.
- **SceneOptimizer** (`docs/pages/SceneOptimizer.md`): a three addon with `toBatchedMesh()`, which "identifies groups of
  meshes in the scene that can be represented as a single BatchedMesh" and removes the redundant meshes. It is an
  offline/static-scene optimization; it must not replace per-cell visibility for dynamic cells.
- **LOD** (`docs/pages/LOD.md`): levels are chosen by distance; `addLevel(object, distance, hysteresis)` and the
  `hysteresis` argument exist "to avoid flickering at LOD boundaries, as a fraction of distance"; `autoUpdate` can be
  turned off and `update(camera)` called by the app. This is the native distance LOD, not screen-space error; the latter
  is what Cesium/Unreal/Unity docs describe.
- **InstancedMesh** (`docs/pages/InstancedMesh.md`): `count` controls the instances; `computeBoundingSphere()` is
  "automatically computed when it is needed, e.g., for ray casting or view frustum culling"; it must be recomputed when
  instance matrices change. A whole instanced mesh is culled by one bounding sphere, so per-instance culling needs a
  compute pass or a spatial partition, not `frustumCulled`.
- **Object3D** (`docs/pages/Object3D.md`): `frustumCulled` default `true`; `layers` — "The 3D object is only visible if it
  has at least one layer in common with the camera in use"; `visible` and `traverseVisible`. The caster LOD layers used in
  this step are exactly this documented mechanism.
- **Info** (`docs/pages/Info.md`): `renderer.info` holds `memory.attributesSize`, `geometries`, `indexAttributesSize`,
  `renderTargets`, `textures`, `texturesSize`, `programs`, `programsSize`, `storageAttributesSize`,
  `uniformBuffersSize`, `total`, and `render.drawCalls/triangles`. This is a **native per-class ledger**; the game only
  exposed two geometry classes.
- **WebGPURenderer** (`docs/pages/WebGPURenderer.md`): `outputBufferType` default `HalfFloatType` is "recommend for best
  quality. To save memory and bandwidth, `UnsignedByteType` might be used. This will reduce rendering quality though";
  `forceWebGL` chooses WebGL 2; `antialias` default `false`; `reversedDepthBuffer` and `logarithmicDepthBuffer` are
  options. These are the quality/coverage choices for a medium GPU.
- **Renderer** (`docs/pages/Renderer.md`): `setPixelRatio`, `setSize`, `info`, `shadowMap`, `setRenderTarget`,
  `compileAsync`, `compute/computeAsync`; `waitForGPU()` "CPU waits for the GPU to complete its operation" (deprecated).
  Avoid readbacks/waitForGPU in play.
- **RenderPipeline** (`docs/pages/RenderPipeline.md`): the post-processing pipeline; `outputColorTransform` and
  `outputNode`; `needsUpdate` when the output changes; `render()` inside the loop. `PostProcessing` is deprecated since
  r183 and is a wrapper for `RenderPipeline`.
- **Manual, optimize lots of objects** (`manual/pages/optimize-lots-of-objects.md`): merging geometry reduces the number
  of draws; "Rather than 100 trees you might merge the trees into 1 geometry", but "The problem with making everything
  one mesh though is it's no longer easy to move any part that was previously separate." Batch groups, not the whole
  scene.
- **Manual, rendering on demand** (`manual/pages/rendering-on-demand.md`): render only when something changes; continuous
  rAF is a waste for a still scene. The game already stops after `STILL_FRAMES` when paused; the live clock/traffic is the
  reason it keeps drawing in play.
- **Manual, how to dispose of objects** (`manual/pages/how-to-dispose-of-objects.md`): geometries, materials, textures and
  render targets are not released automatically; `dispose()` is required; `renderer.info.memory` is the way to find
  leaks. The cell layer's `freeCpuCopy`/dispose and the shadow store disposal follow this.
- **Material** (`docs/pages/Material.md`): `depthTest`, `depthWrite`, `transparent`, `alphaTest`, `side`,
  `polygonOffset`. These are the switches behind the overdraw/water findings.
- **Texture** (`docs/pages/Texture.md`): `anisotropy`, `generateMipmaps`, `mipmaps`, `colorSpace`, `dispose()`.
- **TSL** (`docs/pages/TSL.md`): `If`, `Loop`, `select`, `discard`; `discard` is a real shader operation, which is why a
  mask branch in a material changes early-Z. `renderer.compute` and the node inspector hooks (`InspectorBase`) are
  three-native ways to see compute and render calls.

### 1.9 What the sources mean together

There is no separate "CPU optimization" and "GPU optimization" that can both reduce total consumption: they move the
bottleneck. The sources converge on one architecture:

1. **A spatial hierarchy with an error per level** (Cesium, Unreal HLOD, Unity LOD, Nanite).
2. **Visibility tests (frustum + conservative occlusion) before work** (Unreal order, Intel/Godot occlusion).
3. **Screen-space error decides the level**, so only the detail the screen can show is requested and drawn.
4. **A bounded cache** (Cesium cacheBytes/overflow, Unreal texture pool) so memory is a budget; out-of-view data is
   unloaded, not kept.
5. **Batch/indirect submission** for what remains (WebGPU render bundles/indirect, Unity batching, three BatchedMesh).
6. **Shadow work follows the same working set** (caster LOD, cached pages, per-cascade culling).
7. **Workers are bounded and only run jobs the working set asked for**; they must not starve the main/GPU stage.

---

## 2. What is actually happening in Roadcraft 5 (causal analysis)

### 2.1 CPU

The measured CPU cost on the turning camera is not one thing:

- **The worker pool** opened `hardwareConcurrency − 2` workers (~30 on the test machine). A camera turn caused ~249
  meshing jobs in 120 frames; those workers used every logical core. The main thread and the GPU process were starved:
  CPU 100 %, GPU 48 %. Capping the pool to 4 removed the CPU saturation (max 74 %, no sample ≥ 90 %).
- **The main thread** then became the render submission path: the probe recorded `draw` ~35 ms of the ~45 ms frame,
  with `layersUpdate` 4.5 ms and props 3.6 ms. The draw cost is dominated by the amount of submitted geometry/draws
  (418 draws, 45.9 M triangles with shadows) and by the shadow passes; it is not a single slow JS function.
- **The simulation worker** is a separate CPU consumer, but pausing it did not remove the 100 % (20/29 samples), so the
  simulation is not the primary cause on the turning view.
- **GC**: 2.4 MB/frame allocated, 600 minor and 46 major GCs in 120 frames in the probe; the per-frame Sets, callbacks,
  spreads and worker messages contribute. This is a symptom of the same architecture (rebuilding the working set every
  frame) more than a separate bug.

### 2.2 GPU

- With shadows: 45.9 M triangles, 418 draws. Without shadows: 16.7 M triangles, 228 draws. The three cascades add
  ~29 M triangles; the color scene is ~16.7 M. The shadow passes are the largest single GPU block, then the scene, then
  post.
- The GPU is not at 100 % when the CPU is the bottleneck; after the worker cap it reaches 100 % because the same GPU
  work is now submitted fast enough. This is the bottleneck moving, not new work.
- VRAM ~3.3 GB and city geometry 1.2 GB show that the resident set is large; it is not freed by making the CPU or GPU
  faster.

### 2.3 Memory

- The city geometry (L0/L1 cells, tiles, plates, detail) is ~1.2 GB; roads ~0.31 GB; VRAM ~3.3 GB; Electron private
  memory peaks at ~8 GB with the 30-worker pool and ~5.3 GB with 4 workers.
- The causes are: resident cell meshes that are hidden or far, the props pool (up to 1 M instances), shadow maps and
  render targets, terrain texture arrays, CPU copies of meshes, and worker job payloads/duplicates. Capping workers
  reduced some of it, but only eviction/streaming/compression reduces the resident set.

### 2.4 The exact answer to "why lowering one raises the other"

Let `T_cpu` be the CPU time and `T_gpu` the GPU time of a frame. The frame time is at least `max(T_cpu, T_gpu)` (plus
sync). Utilization of the smaller stage is `T_small / T_large`. Making the smaller stage faster does not change
`T_large`; it only changes which stage is smaller. Memory is the sum of resident bytes, independent of `T_cpu/T_gpu`;
it changes only when something is loaded, kept or freed. Therefore:

- reducing CPU work alone → `T_cpu` falls → GPU becomes the maximum → GPU utilization rises;
- reducing GPU work alone → `T_gpu` falls → CPU becomes the maximum → CPU utilization rises;
- reducing **total work and resident bytes** → both `T_cpu` and `T_gpu` fall, and memory falls.

That is the target of the architecture below.

---

### 2.5 The hardware envelope: a medium PC, not only this machine

The game will be sold on Steam; the target is not the development machine. The design envelope used here is:
**1080p, 60 Hz, a mid-range discrete GPU or a modern integrated one, 4–8 logical cores, 8–16 GB RAM, 4–8 GB VRAM,
Windows 10/11, WebGPU where available and the WebGL 2 fallback where not.** This is a design envelope, not a measured
claim about a particular machine.

The recorded numbers above exceed that envelope on the turning view: 45.9 M triangles and 418 draws, 3.3 GB VRAM and
~8 GB private memory, with a 30-worker pool. The worker cap removed the CPU saturation; the GPU then reached 100 %,
which is the same GPU work becoming the bottleneck. On a medium GPU the same work is worse. Therefore:

- **The high preset must fit 1080p/60 on the envelope** after the working-set/visibility/batching/shadow changes; the
  medium preset is for weaker hardware, and both must keep every feature (only the resolution/detail/shadow/AO/bloom
  choices differ, as the existing options already define).
- **VRAM and RAM budgets are part of the design**, not a post-hoc number: geometry, props pool, shadow maps, render
  targets, terrain texture arrays and worker copies all count. `renderer.info.memory` is the native ledger (three docs).
- **High-DPI is a risk**: `pixelScale` multiplies every LOD distance by up to 3; on a 4K/2× window this can push the
  roads' far limit past the map and load full-detail cells far away. The envelope must use the actual projection and a
  resolution budget, not a blind multiplier.
- **24 km is a hardware-limits problem**: 576 texture-array layers exceed WebGPU's guaranteed 256; medium GPUs commonly
  report 256. The map size cannot silently rely on a high-limit adapter; an atlas/split-array/streaming path is required.
- **WebGL 2 fallback** must keep the game's features (at least the near props/cells) rather than dropping props; this is a
  Steam-hardware requirement, not an optional compatibility mode.
- **Workers** are capped at 4 (2 on a 4-core machine) and only run jobs the working set asked for; the page, simulation
  and GPU process keep cores. The current cap is the first step of this policy.

## 3. The consolidated solution — view-driven working set

The renderer keeps one **working set** per frame: the nodes and instances that can contribute a visible pixel at the
required screen-space error. Everything else is neither requested, nor built, nor uploaded, nor kept, nor drawn.

### 3.1 Hierarchy and screen-space error

- Hierarchy: plate (2048 m) → tile (1024 m) → cell (256 m); each level has a geometric error `e_l` (metres) measured
  when the level is produced (the maximum deviation/omitted feature from the finer level).
- Screen-space error, following Cesium:
  `sse = e_l * viewportHeight / (2 * tan(fov / 2) * distance)` (perspective), or
  `sse = e_l * viewportHeight / (top - bottom)` (orthographic).
- A node is drawn at level `l` when `sse(e_l) <= maxSSE` and its children are not needed; refine while `sse > maxSSE`
  and the children are in view. Use hysteresis (e.g. 0.85/1.15) so a camera at a boundary does not rebuild every frame.
- `maxSSE` is a **quality** parameter, not a performance knob: at the switch distance the level's error is at most
  `maxSSE` pixels, so the 1:1 image is preserved. The current step uses the distances corresponding to 0.5–2 px; the
  next step replaces the constants with the measured `e_l` from the generator and a single traversal.

### 3.2 Visibility

- Frustum cull every node.
- Occlusion cull with a conservative occluder (software depth buffer or HZB). A box is hidden only when every texel
  under it has an occluder in front of the box's nearest point; an uncovered texel is empty (never hidden). Occluders
  are only geometry actually drawn in detail; a hidden node is not an occluder.
- A node hidden from the colour camera still needs its **shadow proxy** if its shadow can reach a cascade. The proxy is
  the coarser level whose error is under the cascade's texel (near: cell facade; far: tile massing), never the L0 detail.
- Order the tests by cost: distance/region, frustum, occlusion, then the exact draw choice (Unreal's order).

### 3.3 Residency and cache

- The traversal yields `needed` (draw now), `wanted` (missing, request), and `keep` (small hysteresis cache).
- Resident bytes have a budget per class (Cesium's `cacheBytes`; Unreal's texture pool): when over, unload nodes that are
  not `needed` or `wanted`, farthest/last-seen first; never evict a visible node. If the visible set alone exceeds the
  budget, the content must be reduced by **architecture** (better LOD, batching, compression), not by lowering the
  visible quality.
- Only `wanted` nodes become worker jobs. Cancel or ignore stale results by version. A camera turn must not request a
  cell that is hidden, far, or already resident.

### 3.4 Submission

- Batch what remains: cells by level, props/parts by geometry class, vehicles/people by model, with indirect draws or a
  `BatchedMesh`-style vertex-pulling batch. One material per batch.
- Use render bundles where the command list is static and reused (WebGPU; only a CPU win), indirect draws for dynamic
  counts; do not rebuild bundles per frame.
- Keep one draw per batch, not one per kind/level/cascade.

### 3.5 Shadows

- Caster LOD by cascade texel (near cells, far tile masses) — applied in the first step.
- Per-cascade caster lists (a prop/vehicle outside a cascade is not submitted to it); static cache/pages; scroll or page
  invalidation instead of redrawing the whole city on every camera move.
- The shadow work follows the same working set: no casters for nodes that are neither visible nor needed as proxies.

### 3.6 Post, water and grass

- Cloud shadows as a small map refreshed on input change, not a fractal noise per screen pixel.
- Water: no depth write; early-out where land covers it; no full-screen sea shading behind terrain.
- Grass: per-block frustum selection, not 179,200 unculled blades.
- AO at half size with a dedicated denoise; TRAA with a validated history; bloom only at night.

### 3.7 Workers

- A bounded pool (4 on this machine, `?workers=N` for measurement) with priority by SSE/distance and a queue that can
  cancel stale keys. The page, the simulation and the GPU process keep cores. Worker jobs only for `wanted` nodes; no
  hidden/far generation.

### 3.8 Memory

- Stream per tile; evict out-of-view/hidden full detail; keep only proxies for shadows; free CPU copies once uploaded
  (including hidden meshes after their shadow draw).
- Compact geometry (positions/normals/colors already compact; index compression; meshopt where applicable).
- Texture arrays under the device limit; use a 2D atlas or split arrays for 24 km; budget every class (geometry,
  textures, RTs, shadow pages, props) in a ledger.
- Props: residency by view and kind reach, not a whole-map ring; no 1 M pool when the view needs a fraction.

### 3.9 Quality guarantees

- The occlusion is conservative: a visible box is never hidden. The shadow proxy is only used where the cascade cannot
  resolve the finer detail. The LOD threshold is screen-space error, so at the switch distance the 1:1 image is the
  same. The final proof is a photo at the switch distance and a turn sequence with no holes/popping, not a counter.

### 3.10 Why all three fall together

- Fewer visible/needed nodes → fewer worker jobs (CPU), fewer triangles/draws/passes (GPU), fewer resident meshes and
  textures (memory).
- Batching/indirect → less CPU submission; same GPU work.
- Caster LOD/caches → less GPU and CPU shadow work; fewer resident shadow pages.
- The cache budget → bounded memory; the same visibility decision prevents rebuilding what was evicted.

---

### 3.11 Hardware tiers and budgets (Steam / medium PC)

- **Tiers** are the existing `low`, `medium`, `high` and `ultra` presets: resolution scale, shadows, AO, bloom and detail
  are already player choices. The architecture must make the default/high tier fit the envelope; the weaker tier keeps
  the same features and changes only the documented quality parameters. No per-frame adaptive quality and no frame cap:
  the owner's rule forbids hiding the cost.
- **Per-class budgets** (Cesium's `cacheBytes` concept, three's `Info.memory` fields):
  - geometry/attributes and indices;
  - textures (terrain arrays, finishes, atlases), render targets, shadow maps, programs, storage/uniform buffers.
  A budget is a hard eviction criterion for **non-visible** data; a visible set that does not fit is an architecture
  problem (better LOD/batching/compression), never a silent quality drop.
- **Device detection** (`navigator.gpu.requestAdapter().info`, adapter limits, `navigator.hardwareConcurrency`,
  `devicePixelRatio`) may choose the **initial recommendation** (e.g. medium on a 4-core/high-DPI or low-limit device),
  but the player can override it; no benchmark and no adaptive scaling.
- **Resolution**: the render scale is the player's preset; the working-set distances come from the actual projection
  (`fov`, viewport, ortho zoom), not from `innerHeight` alone. At high DPI, a detail radius may not exceed what the screen
  can resolve; clamp to the map/visibility.
- **WebGL 2**: the fallback must keep the near props and cells; the current prop fallback exists but needs verification
  and a full feature pass (no silent loss of props on a machine without WebGPU).
- **24 km**: an atlas or split arrays for heights/ground/water/paint (under 256 layers), or streaming; the ledger must
  include it. The current "reload a smaller map" is a feature gap, not a solution.
- **Workers**: 4 maximum (2 on 4 cores), jobs only for the working set, priority by SSE/distance; a camera move must not
  create a job wall.
- **Acceptance**: when the owner allows photos/tests, the envelope is proved at 1080p/60 on a representative mid-range
  machine, with the four standard views and a turn sequence; the machine-specific RTX 3060 numbers are not the criterion.

## 4. Applied in the repository (first step)

The first step implements the working-set principle on the cell layers and the shadow casters. These files are changed;
they have **not** been measured or tested after the owner's stop order.

- `src/jobs/pool.ts`: the worker pool is capped at 4 (`MAX_WORKERS`), with `?workers=N` as an override. It no longer
  opens one worker per reported logical processor and starves the main thread/GPU. This is the CPU part of the step.
- `src/render/visibility.ts`: a conservative software occluder (256-texel buffer, nearest-occluder depth, max pyramid,
  1500 m reach, whole-texel coverage) and `BuildingOccluders`, which caches each cell's solid wall boxes and rebuilds
  them only when the cell version changes. Hidden boxes are never visible.
- `src/render/cellLayer.ts`:
  - occlusion is built from the cells the building layer drew at L0/L1 (last shown frame), so only geometry that stands
    is an occluder;
  - a hidden cell is not coloured; it keeps only the facade level (L1) as a shadow proxy while the sun can reach it, and
    its L0 detail is not requested or kept; farther, the tile massing is the proxy;
  - the world box of every mesh feeds the occluder; hidden meshes are shown again inside the shadow passes
    (`Post`'s `CachedShadowNode`), so a caster does not lose its shadow;
  - CPU copies of hidden meshes are freed once the mesh has been drawn, and visible meshes are freed after upload;
  - tile/tile-mass shadow twins and cell caster layers implement caster LOD: near cascade = cells, far cascades = tile
    massings; the colour camera does not see the shadow-only layer.
- `src/render/city.ts`: the cell switches use the screen-space-error distances at 1080p/45° (978 m for L2 masses at
  2 px, 782 m for the facade at 0.5 px, 5216 m for plate masses at 2 px), scaled by `pixelScale`; the city layer builds
  occluders and uses caster LOD.
- `src/render/sun.ts`, `src/render/post.ts`, `src/render/cameraRig.ts`: `CELL_CASTER_LAYER` and `TILE_CASTER_LAYER`;
  near/far cascades draw the correct caster level; the view sees cells but not shadow-only twins.
- `src/game.ts`: `stats()` now exposes three's own memory ledger — `memMB` (`renderer.info.memory.total`), `texMB`,
  `attrsMB`, `indexMB`, `rt` (render targets), `progMB`, `storMB`, `uniMB` — beside the two cell layers. This is the
  native budget the medium-hardware work needs; three's `Info` documents every field.
- `tools/render-audit/`: the audit suite created earlier (static catalog with negative fixtures, runtime scenarios,
  image metrics, hardware sampler, tests). It remains in the repository; no further run is made.

This step attacks the three resources at once by construction:

- hidden/far L0 cells are not requested/built/uploaded/drawn → CPU, GPU and memory;
- far cascades draw tile masses, not every cell → GPU/CPU shadow work;
- the worker pool no longer saturates the machine → CPU; the GPU can then be the limiter, which is expected and is
  addressed by the remaining GPU work reduction (the next steps), not by re-saturating the CPU.

---

### 4.1 The tooling gap (the owner's question)

The owner asked why the tools were created/installed to test and identify all problems, and why that was not finished.
The honest answer:

- **Created in the repository:** `tools/render-audit/catalog.mjs` (the technique catalog with sources), `static.mjs`
  (the source detector with positive/negative fixtures), `runtime.mjs` (one Electron session for visibility/LOD/slot
  measurements), `images.mjs` + `imgmetrics.py` (lossless 1:1 image metrics), `audit.mjs` (the combined entry),
  `hw.ps1` (CPU/GPU/VRAM/RAM sampling of every reading, not one value), `test/renderAudit.test.ts`,
  `test/occlusion.test.ts`, and the audit/hardware sections of this document.
- **Not installed:** external RenderDoc/PresentMon/WebGPU Inspector. The existing Electron + CDP probe and three's own
  `renderer.info`/InspectorBase cover most of the same ground; installing another capture stack was deferred.
- **Why the suite was not delivered as a finished gate:** after creating the static detector and proving it catches a
  missing occluder, I spent the next time on the game's diagnostics and on fixing the runtime script's settle bug instead
  of finishing the external-tool integration. That is a delivery failure, not an owner problem. The suite remains in the
  repository; it is not run again until the owner asks, per the latest order.
- **What it already proved:** the static catalog detects the absence of occlusion, screen-error LOD, mask-free variants,
  shadow caster LOD, cloud-shadow map, water early-out, grass culling, GPU ledger, pass attribution and batching; the
  fixtures make each detector fail on the "bad" tree and pass on the "good" tree. That is the property a measurement-only
  tool cannot give.

## 5. Remaining steps (one at a time, no measurement until the owner asks)

1. **Measured LOD error + one SSE traversal.** Add the geometric error to each generated level (worker-side, measured
   against the finer level), and make a single traversal decide draw/request/keep from SSE + frustum + occlusion. This
   replaces the remaining distance constants and makes the working set correct at any FOV/resolution and on any GPU.
2. **Working-set cache.** Cesium-style `cacheBytes`/overflow per class, using three's `renderer.info.memory` ledger;
   evict only non-needed nodes; no visible-quality reduction; report if the visible set cannot fit (architecture, not
   quality). Include a hardware envelope and a WebGL 2 feature pass.
3. **Batch submission.** Cells by level and props/parts by geometry class; indirect/BatchedMesh (three docs); one draw
   per batch, not one per kind/level/cascade; render bundles only where static and reused (WebGPU CPU win).
4. **Shadows.** Per-cascade caster lists for props/vehicles/people; static page/cache or scroll; no full redraw of the
   still city on camera movement; keep caster LOD.
5. **Post/water/grass.** Cloud-shadow map; water depth-write/early-out; grass block culling; AO/TRAA budgets.
6. **Memory.** Texture atlas/split arrays for 24 km (under 256 layers); compact attributes/index compression; global
   ledger; props residency by view; free all CPU copies after upload; budget for 4–8 GB VRAM / 8–16 GB RAM.
7. **Quality and gates on a medium PC.** 1080p/60 on the envelope, 1:1 photos at the switch distance, turn sequence,
   shadow/water/night photos; the audit tools (static/runtime/image) are the gate; no measurements/tests are run until the
   owner asks.

---

## 6. Sources (complete list used in this research)

- Intel/GameTechDev, PresentMon console metrics: https://github.com/GameTechDev/PresentMon (README-ConsoleApplication.md)
- Unreal Engine, Visibility and Occlusion Culling: https://dev.epicgames.com/documentation/en-us/unreal-engine/visibility-and-occlusion-culling-in-unreal-engine
- Unity, Occlusion Culling: https://docs.unity.com/en-us/engine/current/manual/cameras/occlusion-culling/occlusion-culling
- Godot, Occlusion Culling: https://docs.godotengine.org/en/stable/tutorials/3d/occlusion_culling.html
- MDN, `navigator.hardwareConcurrency`: https://developer.mozilla.org/en-US/docs/Web/API/Navigator/hardwareConcurrency
- Intel, Masked Software Occlusion Culling: https://www.intel.com/content/www/us/en/developer/articles/technical/masked-software-occlusion-culling.html
- Hasselgren, Andersson, Akenine-Möller, Masked software occlusion culling, HPG 2016: https://dl.acm.org/doi/abs/10.5555/2977336.2977340
- Greene, Kass, Miller, Hierarchical Z-buffer visibility, SIGGRAPH 1993: https://history.siggraph.org/learning/hierarchical-z-buffer-visibility-by-greene-kass-and-miller/
- Downs, Akenine-Möller, Séquin, Occlusion horizons for driving through urban scenery, I3D 2001
- Cesium, `Cesium3DTileset` (`maximumScreenSpaceError`, `cacheBytes`, `maximumCacheOverflowBytes`): https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html
- Unreal Engine, World Partition — Hierarchical Level of Detail: https://dev.epicgames.com/documentation/en-us/unreal-engine/world-partition---hierarchical-level-of-detail-in-unreal-engine
- Unreal Engine, Optimizing LOD Screen Size per Platform: https://dev.epicgames.com/documentation/en-us/unreal-engine/optimizing-lod-screen-size-per-platform-in-unreal-engine
- Unity, LOD Group: https://docs.unity.com/en-us/engine/current/manual/analysis/graphics-performance-profiling/lod/lod-group/class-lodgroup
- Unreal Engine, Nanite Virtualized Geometry: https://dev.epicgames.com/documentation/en-us/unreal-engine/nanite-virtualized-geometry-in-unreal-engine
- meshoptimizer: https://github.com/zeux/meshoptimizer
- WebGPU render bundles (toji.dev): https://toji.dev/webgpu-best-practices/render-bundles.html
- Dawn, multi_draw_indirect: https://dawn.googlesource.com/dawn/+/HEAD/docs/dawn/features/multi_draw_indirect.md
- Unity, static batching: https://docs.unity.com/en-us/engine/current/manual/analysis/graphics-performance-profiling/reduce-draw-calls/draw-call-batching/draw-call-batching
- Microsoft, Cascaded Shadow Maps: https://learn.microsoft.com/en-us/windows/win32/dxtecharts/cascaded-shadow-maps
- Unreal Engine, Virtual Shadow Maps: https://dev.epicgames.com/documentation/en-us/unreal-engine/virtual-shadow-maps-in-unreal-engine
- Unreal Engine, Texture Streaming Overview: https://dev.epicgames.com/documentation/en-us/unreal-engine/texture-streaming-overview-for-unreal-engine
- W3C WebGPU (limits, `maxTextureArrayLayers` 256): https://www.w3.org/TR/webgpu/
- MJP, To Early-Z or Not To Early-Z: https://therealmjp.github.io/posts/to-earlyz-or-not-to-earlyz/
- three r186 local: `objects/BatchedMesh.js`, `renderers/common/Info.js`, `renderers/webgpu/WebGPUBackend.js`
- three.js documentation, local copy at `C:\Users\Jonathan\Documents\three\docs\site-threejs.org-20261018-161507\paginas`:
  `docs/pages/BatchedMesh.md`, `docs/pages/SceneOptimizer.md`, `docs/pages/LOD.md`, `docs/pages/InstancedMesh.md`,
  `docs/pages/Object3D.md`, `docs/pages/Info.md`, `docs/pages/WebGPURenderer.md`, `docs/pages/Renderer.md`,
  `docs/pages/RenderPipeline.md`, `docs/pages/Material.md`, `docs/pages/Texture.md`, `docs/pages/TSL.md`,
  `docs/pages/InspectorBase.md`, `manual/pages/optimize-lots-of-objects.md`, `manual/pages/rendering-on-demand.md`,
  `manual/pages/how-to-dispose-of-objects.md`.
- Steam Hardware Survey (hardware distribution for the medium-PC envelope): https://store.steampowered.com/hwsurvey
- Project records used only as prior observations: `MEMORY/STATE.md`, `MEMORY/DECISIONS.md`, the audit report of
  2026-11-01.

---

## 7. What is not verified

- The new code (visibility-driven residency, caster LOD, worker cap) was written after the owner's stop order and was
  **not compiled, tested, measured or photographed** afterwards. The previous compile/test results apply to the
  earlier state only. The next proof, when the owner allows it, is the four-view photo set plus a turn sequence at 1:1,
  not a counter.
- The geometric errors used by the current distances are initial values (0.3/1.5/1.4/8 m); the correct next step is to
  have the generator measure and publish them, and to use one SSE traversal. The report does not claim they are measured.

---

## 8. Addendum — corrections of the same day (second pass)

- **The occluder's 1500 m reach is now real.** `OCCLUDER_REACH` was exported dead code: the §4 claim above ("1500 m
  reach") was not enforced anywhere, and at a high `pixelScale` the drawn cells could lay occluders much farther. The
  reach is now checked per building in `OcclusionBuffer.addBox` (visibility.ts), with a unit test (a wall past the
  reach hides nothing). Fewer occluders can only show more, never hide something visible: the change is conservative.
- **Four pre-existing test regressions fixed** (none caused by the first step, proven on a clean HEAD worktree):
  the two save round-trip tests compared the per-session `id` column that the tile format never persisted
  (`gatherBoxes` now fills it to map the workers' answers back); `bikeModel` had moved to `render/vehicleModels.ts`;
  the style gate listed `src/r40/render/buildings/signature.ts`, deleted as dead 4.0 code in c0aa72a. The suite is
  green again (531/531).
- **The static catalog no longer contradicts the shipped code:** `shadow-caster-lod` and `gpu-ledger` were reported
  absent while both mechanisms exist (the two caster layers and three's `renderer.info.memory` ledger); their checks
  now recognize the shipped forms and still discriminate (an absent tree stays absent). static.mjs's comment about a
  `fixtures/` directory now points at the fixtures the test builds on the fly.
- **The grass field is culled on the GPU** (the audit's `grass-culling` finding, applied): a compute pass keeps the
  tufts whose column is inside the view (six frustum planes against the field's conservative height range, sampled on
  the CPU from the shared heights — no texture read in the compute) and the draw reads its count and list indirectly,
  the props' pattern. WebGL 2 keeps the whole field, unchanged. Verified on the machine's GPU: the wild-terrain view
  keeps 9,377 of 25,600 tufts (63 % less vertex work) with the image at parity (872,671 vs 872,948 green pixels,
  SSIM 0.982; the street pair SSIM 0.986, green −1.6 % within the grass's own wind sway). `drawnStats()` now replaces
  the field's counted triangles with the kept ones (an indexed indirect draw is counted with the geometry's own
  instance count, so `tris` alone cannot see the cull).

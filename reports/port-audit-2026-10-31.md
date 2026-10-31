# Port audit — copied code and performance defects (2026-10-31)

Scope: `roadcraft-novo-port` (branch `port/roadcraft-features`, HEAD `7e478ed`) against `roadcraft` 4.0.
Question answered: what was ported wrong or negligently, what was copied, and what is wrong for performance —
with file, line, code and the reason.

**Method and limits.**
(a) Verbatim/fingerprint scan of every source file against 4.0: `node tools/copy-check.mjs` (the tool committed
with the 2026-10-31 audit; k-grams winnowed as in MOSS), run in this session; raw JSON kept at
`reports/port-audit-2026-10-31.copy-scan.json`. (b) Reading of the code named below, in the worktree. (c) Documentation and
official sources cited per finding (section 9). No build, test suite, budget run or photo was executed in this
session: the owner's standing order is to look, research and fix without long processes. Every number marked
**(recorded)** comes from `MEMORY/STATE.md` or the audit commit `8fa05a4`, not from a measurement of this
session. Everything marked **(suspected)** still needs a 1:1 photo or a counter before it can be called a
defect.

---

## 0. The numbers

| measure | value |
|---|---|
| files scanned | 458 (48,329 code lines) |
| identical lines to 4.0 (all) | 9,386 |
| — in `src/r40` | **6,525 of 7,248 code lines = 90.0 %**, 38 whole files |
| — in the rest of `src` | 1,287 of 28,287 code lines = 4.5 %, no whole file |
| — in `data/textos-roadcraft` (player strings) | 1,362 lines (695 + 667), 100 % (asset, see §3) |
| files citing 4.0 in comments | 170 |

Top of `src/r40` (identical / code lines): `world/growth/lotPlan.ts` 651/652, `world/buildings/interior.ts`
506/507, `world/buildings/procedural.ts` 420/422, `render/buildings/elementMesh.ts` 406/469,
`render/buildings/roofMesh.ts` 383/426, `world/buildings/geometry.ts` 326/326, `render/buildings/meshCore.ts`
295/378, `render/buildings/facadeEmit.ts` 239/284, `render/buildings/cellArrays.ts` 226/235,
`world/buildings/architecture.ts` 179/179, `render/buildings/massing.ts` 178/365.

Conclusion that the rest of this report substantiates: **the whole near-building pipeline is still 4.0 code
wrapped in an adapter** (`src/jobs/building40.ts`), not a port. The adapter converts 4.0's object graph into
this engine's mesh and part batches, so the *output* looks right while the *architecture* remains 4.0's:
objects per entity, string keys, O(n²) scans, per-call allocations, five generation passes per lot, and the
same building regenerated on the main thread when the inside view opens. The planned `jobs/b40` rewrite
(`MEMORY/B40-PLAN.md`) is therefore not an optimisation; it is the port that was never done.

---

## 1. Copied 4.0 subsystem (`src/r40`)

### C1 — The 4.0 building generator is copied whole

**Where:** `src/r40/**` — 62 files, 7,248 code lines, 6,525 identical to 4.0, 38 whole files.
`src/r40/api.ts` re-exports 4.0's functions unchanged:

```ts
// src/r40/api.ts:1-18
export { madeToMeasure } from './world/buildings/procedural.ts';
export { furnishLot, lotKind, planLot } from './world/growth/lotPlan.ts';
export { emitChunk, letGoEmitted } from './render/buildings/buildingMesh.ts';
export { PartyWalls } from './render/buildings/partyWalls.ts';
...
```

**Why it is wrong:** the project's first rule is that 4.0's code is never copied — its values and results are
rebuilt in R5's architecture. A wrapper that calls `planLot` + `madeToMeasure` + `furnishLot` + `emitChunk`
is the 4.0 program, not a reimplementation: the functions, data structures and algorithms are 4.0's. It also
carries 4.0's defects (C2–C5) into R5, and no amount of tuning inside `jobs/building40.ts` can remove them.

**Correct solution:** `jobs/b40` + `world/b40*` as specified in `MEMORY/B40-PLAN.md` (SoA volumes, bay codes
in typed arrays, one emission per lot per job, no object per volume/bay/element). The values listed in
`MEMORY/R40-AUDIT.md` are what the rewrite must preserve.

**Source:** project rules `CLAUDE.md` ("Fidelity", "Forbidden"); `MEMORY/COPY-AUDIT.md`; `MEMORY/R40-AUDIT.md`;
`MEMORY/B40-PLAN.md`.

---

### C2 — One object per entity: the 4.0 record graph, kept and cached

**Where:** `src/r40/world/buildings/types.ts:81-120, 145-175, 277-331`;
`src/r40/render/buildings/buildingMesh.ts:51, 75, 109-113`;
`src/jobs/building40.ts:114-148`.

```ts
// src/r40/world/buildings/types.ts:81-89
export interface Facade {
  fill: BayComponent;
  pattern?: FacadePattern;
  patterns?: Partial<Record<FaceId, FacadePattern>>;
  sides?: Partial<Record<FaceId, BayComponent>>;
  bays?: Record<string, BayComponent>;   // "side:index" string keys
}

// src/r40/world/buildings/types.ts:145-160
export interface Volume {
  id: number; x: number; y: number; w: number; d: number;
  outline?: Vec2[];
  storeys: Storey[];
  reliefs?: Relief[];
  dress?: VolumeDress;
  ...
}

// src/jobs/building40.ts:114-137 — a Map of whole 4.0 records kept per worker
const BODIES = new Map<number, KeptBody>();
const BODIES_KEPT = 512;
...
const fresh: KeptBody = { use: lot.use, density: lot.density, W: lot.W, D: lot.D, body };
BODIES.set(seed, fresh);
if (BODIES.size > BODIES_KEPT) BODIES.delete(BODIES.keys().next().value!);
```

Every building is a `Building` holding `Volume[]` holding `Storey[]` holding `Facade` holding `Record<string,
BayComponent>`; every element, core, relief and furniture piece is another object. A 10 km city has 36,204
buildings (budget baseline). The cache keeps up to 512 full records **per worker**, and a separate copy on the
page, so the GC sees tens of thousands of short-lived objects per tile, then keeps hundreds of graphs alive
in each thread.

**Why it is wrong:** this is exactly `CLAUDE.md` "Forbidden" item 1 ("One JS object per entity"), and the
opposite of `core/table.ts` ("SoA table: one typed array per field... No object per entity"). Object-per-entity
means: one allocation per field-bearing record, pointer chasing on every read, a hidden-class/GC cost for
every building, and no possibility of a worker streaming the data as typed arrays. V8 documents both costs:
objects with many shapes and properties added/deleted go to dictionary mode
([V8, *Fast properties*](https://v8.dev/blog/fast-properties)), and collection work is what produces jank
([V8, *Trash talk*](https://v8.dev/blog/trash-talk)). The data-oriented alternative is the struct-of-arrays
layout the engine already uses (`core/table.ts`; Fabian, *Data-Oriented Design*, "Structs of arrays",
<https://dataorienteddesign.com/dodbook/>).

**Correct solution:** `jobs/b40/volumes.ts` — the lot's blocks and storeys as a SoA table; bays as
`Uint8Array(volume × side × storey × bay)`; lot elements as a packed table (B40-PLAN steps 2–8).

---

### C3 — String keys allocated per bay and per floor

**Where:** `src/r40/world/buildings/types.ts:328-333`;
`src/r40/world/buildings/geometry.ts:590`;
`src/r40/world/buildings/architecture.ts:308`;
`src/r40/world/buildings/cityBuildings.ts:77`;
`src/r40/world/buildings/interior.ts:162-173`.

```ts
// types.ts:328-333
export const bayKey = (side: FaceId, index: number): string => `${side}:${index}`;

export function componentAt(facade: Facade, side: FaceId, index: number): BayComponent {
  return facade.bays?.[bayKey(side, index)] ?? facade.sides?.[side] ?? facade.fill;
}

// interior.ts:162-173 — a string built by concatenation over every volume, per floor, per building
function floorType(b: Building, level: number, storeys: Map<object, number>): string | null {
  ...
  let key = `${level === 0 ? 'g' : 'u'}${levelHeight(b, level)}`;
  b.cores.forEach((c, i) => { if (c.from <= level && c.to >= level) key += `c${i}`; });
  b.volumes.forEach((v, i) => {
    ...
    key += `|${i}:${id}${k === 0 ? 'f' : ''}${k === v.storeys.length - 1 ? 't' : ''}`;
  });
  return key;
}
```

`componentAt` is called for every bay of every volume (`geometry.ts:590`); each call allocates a new string
and performs a dictionary lookup. `floorType` builds a potentially long string per level per building, then
looks it up in a `Map<string, FloorInterior>`. Note that `render/buildings/meshCore.ts:881` already has a
**numeric** `bayKey` (`((volume * 2048 + level + 1024) * 4 + side) * 1_048_576 + index + 1`) — the model layer
was not moved to it.

**Why it is wrong:** string keys per entity are the "no object per entity" rule applied to keys: allocation in
the hottest generation loops, dictionary-mode property access, and GC pressure. V8: objects with added/deleted
properties degrade to slow (dictionary) properties, and inline caches fail on them
([V8, *Fast properties*](https://v8.dev/blog/fast-properties)). A packed integer key or a direct index costs
no allocation and is cache-friendly.

**Correct solution:** the bay code array from B40-PLAN step 4 (`Uint8Array` indexed by volume/side/storey/bay);
floor types keyed by an integer hash or a packed record, not by a concatenated string.

---

### C4 — O(n²) clash scans inside lot furnishing and party walls

**Where:** `src/r40/world/growth/lotPlan.ts:381, 429, 451, 1084`;
`src/r40/render/buildings/partyWalls.ts:64-73`;
`src/r40/world/buildings/interior.ts:206`.

```ts
// lotPlan.ts:381 — every candidate against every placed rectangle
return taken.some((t) => x + r > t.x0 && x - r < t.x1 && y + r > t.y0 && y - r < t.y1);

// lotPlan.ts:429
if (taken.some((t) => fx0 < t.x1 && t.x0 < fx1 && fy0 < t.y1 && t.y0 < fy1)) return false;

// lotPlan.ts:451 and 1084 — array rebuilt through filter + spread for each edit
elements.splice(0, elements.length, ...elements.filter((el) => !clear(el)));

// partyWalls.ts:64-73 — every building against every other building of the job
for (const o of this.boxes) {
  if (o.b === b || o.minX > box.maxX + PARTY_REACH || ...) continue;
  for (const c of this.coversOf(o.b)) out.push(c);
}
```

**Why it is wrong:** per lot, placing each yard element scans every element already placed; per cell job,
`PartyWalls` scans every building against every other and then expands every neighbour's covers. Cost grows
quadratically with the lot's elements and with the job's buildings, which is `CLAUDE.md` "Forbidden" item 5
(work per edit that grows with size) and the documented reason to use a spatial index: a uniform grid/hash
turns broad-phase overlap queries from O(n²) into near O(n) (Teschner et al., *Optimized Spatial Hashing for
Collision Detection of Deformable Objects*, 2003,
<https://cgl.ethz.ch/Downloads/Publications/Papers/2003/Tes03/Tes03.pdf>). The engine already has a spatial
index (plate/tile/cell/subcell) and `buildingIndex` for exactly this.

**Correct solution:** the per-lot 1 m occupancy grid of B40-PLAN step 5 (`fits`/`put`/`busy` over a bit grid)
and party-wall culling at cell level with the existing index, not nested loops over object arrays.

---

### C5 — Allocations inside the per-vertex / per-call path

**Where:** `src/r40/world/buildings/footprints.ts:16-18`;
`src/r40/render/buildings/meshCore.ts:723-735`;
`src/r40/render/buildings/buildingMesh.ts:75, 107, 109-113`;
`src/jobs/building40.ts:364`.

```ts
// footprints.ts:16-18 — a new array and new points on every call
export function localFootprint(v: Volume): Vec2[] {
  return v.outline ? v.outline.map((p) => ({ x: v.x + p.x * v.w, y: v.y + p.y * v.d }))
    : [{ x: v.x, y: v.y }, { x: v.x + v.w, y: v.y }, { x: v.x + v.w, y: v.y + v.d }, { x: v.x, y: v.y + v.d }];
}

// meshCore.ts:723-735 — a new [x, y, z] for every corner asked
L(lx: number, ly: number, z: number): V3 {
  return [this.b.x + lx * this.c - ly * this.s, this.b.y + lx * this.s + ly * this.c, z];
}
N(dx: number, dy: number, dz = 0): V3 { return [dx * this.c - dy * this.s, dx * this.s + dy * this.c, dz]; }

// buildingMesh.ts:75 — a Map per volume, per emission
const notches = new Map<FaceId, { a0: number; a1: number; recess: number }[]>();

// building40.ts:364 — array of arrays rebuilt per volume
const corners = [[v.x, v.y], [v.x + v.w, v.y], [v.x + v.w, v.y + v.d], [v.x, v.y + v.d]].map(([lx, ly]) => localToWorld(b, lx, ly));
```

`localFootprint` is called from `foundation`, `footprints`, clash tests and `partyWalls`; `Emitter.L/N` are
called for every face corner in the emitters (the class already has a reusable `quad`/`spot` for `rect`, so the
optimisation exists but is not applied to `L`/`N`). Every call allocates a heap array.

**Why it is wrong:** `CLAUDE.md` "Forbidden" item 7 (per-frame/per-edit allocations in hot paths; use pools and
typed arrays). These are per-lot/per-vertex allocations in the meshing worker, they feed V8's young generation
and they are avoidable. V8's own guidance: most allocation cost is paid by surviving objects and GC work on the
main/worker threads ([V8, *Trash talk*](https://v8.dev/blog/trash-talk)).

**Correct solution:** ring buffer written into a caller-owned `Float64Array` (as `footprints.ts` already does
for edge frames), `L/N` writing into reusable `V3` arrays, notch lists as packed per-face arrays, no `.map` in
per-volume loops.

---

### C6 — The same lot is planned and furnished again for every level and every worker

**Where:** `src/jobs/buildingGen.ts:95-99, 173-205`; `src/jobs/building40.ts:114-148`;
`src/render/inside.ts:109-116`.

```ts
// buildingGen.ts:95-99 — every L0/L1 job rebuilds the lot list and the party walls
if (!legacy && (lod === 0 || lod === 1)) {
  const lots: Lot40[] = [];
  for (let i = 0; i < b.count; i++) if (isLot40(b, i, plan)) lots.push(lot40Of(b, i, lotFit(b, i), ...));
  party = partyWallsOf(lots);
}

// buildingGen.ts:191-205 — the -3, 0, -2 passes each call building40(lot) again
if (lod === -3) { ... volumes40(lot40) ... }
if (lod === 0) { ... layLot40(...) ... }
else if (lod === -2) { ... layLot40(...) ... }
```

The BODIES cache (C2) keeps a body per seed **per worker** (512 entries). It reduces repeats inside one worker,
but: the same lot's L0, L1, L−1, L−2 and L−3 jobs are distributed over a pool of `hardwareConcurrency − 2`
workers (`jobs/pool.ts:249-252`), so up to five workers plan the same lot independently; after 512 entries the
oldest body is evicted and is generated again when another level of that lot arrives late; and the page has its
own module instance (`inside.ts` → `buildingGen` → `building40`), so opening the inside view generates the lot
on the **main thread** (P1/P2).

**Why it is wrong:** generation is the expensive part (`planLot` + `madeToMeasure` + `furnishLot` with its
O(n²) clash tests, C4). Doing it once per level per worker multiplies it by the number of levels and workers,
which is precisely the cost that made the opening slower and the inside view hitch. The rule is one generation
per lot per job, fanned out to the levels (`MEMORY/B40-PLAN.md`, "Pipeline").

**Correct solution:** generate the lot's volumes/bays/elements once in one job, then fan the same typed data out
to shell, parts, layout and mass; never regenerate on the page.

---

### C7 — Work computed and thrown away

**Where:** `src/r40/render/buildings/buildingMesh.ts:107, 169-176, 328-349`;
`src/jobs/buildingGen.ts:193-204`; `src/jobs/building40.ts:37`.

```ts
// buildingMesh.ts:107 — computed for every building, even when rooms are off
const spacesOf = deriveSpaces(b);

// buildingMesh.ts:169-176 — the room/slot machinery only runs with rooms=true...
e.slot = rooms ? slotOfBay(b, v, bay, spacesOf, slots) : -1;
if (rooms && b.id >= 0 && b.cutaway === undefined) { ... }

// buildingMesh.ts:328-349 — flags are collected...
const flags: FlagInstance[] = [];
setFlagSink(flags);
...
return flags.length ? { ...withGround, flags } : withGround;

// building40.ts:205 — ...and layLot40 never reads chunk.flags
const chunk = emitChunk(b, ..., true, party, false);

// buildingGen.ts:193-204 — with no part sink, the generic generator still runs per building into NO_MESH
if (parts40Out) { ... } else { if (arch >= ... ) house(g); else ... block(g); }
```

`emitChunk` is called **only** from `jobs/building40.ts:205`, always with `rooms = false` (last argument), so
`deriveSpaces`, `roomsOf`, `roomsOfStorey`, `slotOfBay`, `lightSlots.ts` and `roomBehind.ts` never produce
anything the game reads — but `deriveSpaces(b)` still runs for every building and `new Map`s are allocated.
Flags are produced and dropped.

The generic `house`/`tower`/`block` pass at `buildingGen.ts:193-204` is a different case and the first version of
this report got it wrong: it is **not** discarded. It writes the footprints the yard props must avoid
(`captureFoot`, `jobs/buildingGen/plans.ts:303,322`; read at `f.out.foot`), which is why it still runs when the
4.0 part sink is absent. The defect is that it gets that data by running the whole generic generator into
`NO_MESH`: the 4.0 layout already knows the footprints (`laid.footprints` at `buildingGen.ts:201`), so the
correct fix is to emit them directly from the lot table, not to skip the pass.

One more sign of a port left half-adapted: `layLot40` chooses the material with

```ts
// src/jobs/building40.ts:213 — both branches are identical
const mat = (finish === 'glass' ? MAT.Plain : MAT.Plain) | (fin << 4);
```

so whatever distinction the code meant to make for glass is not made (a dead ternary, at best; a lost glass
material, at worst).

**Why it is wrong:** `CLAUDE.md` "Forbidden" item 5 (work that grows with size) and the most basic rule of the
project: no work for nothing. It is also a fidelity statement in disguise: the rooms/slots/light path (4.0's
lit rooms by hour) is not implemented, only executed and discarded (see F2).

**Correct solution:** delete the unused rooms/slots/light path (or wire it to a reader, if the 4.0 result is
required); build flags and draw them; emit the footprints from the 4.0 lot layout instead of running the generic
generator into `NO_MESH` only to capture them.

---

### C8 — `Math.hypot` and `Math.pow` per vertex in the meshing hot loop

**Where:** `src/jobs/building40.ts:52-60, 75, 313`.

```ts
// building40.ts:52-60 — three Math.pow per vertex through srgbByte
const srgbByte = (x: number): number => {
  const c = Math.max(0, Math.min(1, x));
  return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
};
const hexOf = (r, g, b) => (srgbByte(r) << 16) | (srgbByte(g) << 8) | srgbByte(b);

// building40.ts:75 — built-in hypot in unfold, called per shell vertex
const l = Math.hypot(x, y, z) || 1;
```

The project already documents the cost of the built-in and has a replacement: `src/r40/core/hypot.ts` says V8's
`Math.hypot` "arguments go in an array and its result comes back boxed, one heap number a call", and
`meshCore.ts:571` uses `hypot3`. `jobs/building40.ts`, the file that writes every 4.0 shell vertex, still calls
the built-in in `unfold` (line 75) and in the normal renormalisation (line 313); `hexOf` calls `Math.pow` up to
three times per vertex.

**Why it is wrong:** this is per-vertex work in the worker path that builds the near city; a transcendental
call per channel per vertex is measurable and avoidable. The correct fix is not a micro-tweak: use `hypot3`
(already in the repo) and a 256/1024-entry sRGB LUT (sRGB encoding is a fixed 8-bit transfer function; a table
is exact and allocation-free).

**Source:** `src/r40/core/hypot.ts` (the project's own measurement/comment); V8 builtins `math.tq` referenced
there.

---

### C9 — Dead code that is still shipped

**Where:** `src/r40/world/buildings/intern.ts`, `recordTable.ts` (row map built on first call),
`world/lotRings.ts`, `world/tiles.ts` — unreachable from the four entry points (`api.ts`,
`jobs/building40.ts`, `jobs/buildingGen.ts`, `render/propMeshes.ts`, `ruin/ruinMesh.ts`), verified by tracing
imports in this session. Inside reachable files: `lightSlots.ts` and `roomBehind.ts` are unreachable in practice
(only read when `rooms = true`, never passed), `flagLayer.ts` is a type only, `cloneBuilding`/`jsonCopy` in
`types.ts:335-355` are unused, and `masLot40`'s single-finish mapping leaves per-volume finishes unused (C10).

**Why it is wrong:** dead code in the bundle and in the review surface; it also hides how much of the 4.0
subsystem is actually needed. `CLAUDE.md` item 10 forbids committed DEV-only code, and the "correct solution"
requires knowing the real surface.

**Correct solution:** delete what the b40 rewrite does not use; do not carry 4.0 modules "for later".

---

## 2. Copies outside `src/r40`

### C10 — `heavyBody.ts`, `treeMeshes.ts`, `carBody.ts`

**Where:** `src/render/heavyBody.ts:124-150` (67/208 identical lines, longest run 27 at 67 % fingerprints);
`src/render/treeMeshes.ts:30-42` (67/246, `noise3` 13 lines at 100 % from 4.0 `natureNoise.ts:4-16`);
`src/render/carBody.ts:52-130` (101/395, longest run 56 at 100 %).

```ts
// heavyBody.ts:124-150 — 4.0's arch/door-span lower-body construction, line for line
const archTop = (x: number): number => {
  let y = -Infinity;
  for (const ax of axles) {
    const dx = x - ax;
    if (Math.abs(dx) < archR) y = Math.max(y, r + Math.sqrt(archR * archR - dx * dx));
  }
  return y;
};
const xs = new Set<number>([back, front]);
for (const ax of axles) for (let i = 0; i <= 16; i++) xs.add(ax - archR + (2 * archR * i) / 16);
...
```

**Why it is wrong:** the commit `carBody/heavyBody/... rewritten` claims an R5 rewrite, but the scan still
finds 4.0's geometry code verbatim in the new bodies. The car style table in `carBody.ts` is numeric
appearance data (values — allowed to come from 4.0), but `heavyBody.ts:124-150` is **code**: geometry
construction, with per-call `Set`, array and callback allocations in a model builder. `treeMeshes.ts:30-42` is
4.0's noise function verbatim, in a builder that was also declared rewritten.

**Correct solution:** rewrite the heavy-vehicle lower body and the tree noise as R5 code (the pattern already
exists in `vehicleParts.ts`/`carCabin.ts`), keeping only the numeric profiles from 4.0. A data table of
dimensions may stay identical; the construction may not.

---

### C11 — UI DOM copied from 4.0

**Where:** `src/ui/hud.ts` (48/480 identical), `src/ui/dom.ts` (42/116), `src/ui/roadKeysPanel.ts` (37/56),
`src/ui/roadCatalog.ts` (34/602), `src/ui/compass.ts` (18/30).

```ts
// src/ui/hud.ts:410-432 — the drawer layout, 4.0 shell.ts:1935-1955 with renamed locals
const sr = this.side.getBoundingClientRect();
if (sr.width > 0 && sr.bottom > this.drawer.getBoundingClientRect().top - 4) right = Math.min(right, sr.left - 12);
const room = Math.max(320, right - left);
this.drawer.style.left = vw <= 780 ? '' : `${Math.round(right - left >= 320 ? (left + right) / 2 : vw / 2)}px`;
...
tabs.classList.remove('compact', 'tight');
if (tabs.scrollWidth > head.clientWidth - 8) tabs.classList.add('compact');
if (tabs.scrollWidth > head.clientWidth - 8) tabs.classList.add('tight');
```

`roadKeysPanel.ts:25-75` is a near-verbatim copy of 4.0 `ui/roads/keysPanel.ts` with the same class names
(`rp-keys`, `rp-keys-head`, `rp-icon`) and element order.

**Why it is wrong:** the rule covers all code, not just rendering code; copied DOM construction means the 4.0
markup and CSS classes are now the R5 contract, and every change must be made twice. It is also the kind of
copy that makes the "port" look complete while leaving the new UI architecture unbuilt. No performance impact
comparable to C1–C8, but it is negligence and a maintenance hazard.

**Correct solution:** R5's own UI modules, matching 4.0's appearance (classes/geometry may match), not its
construction code.

---

### C12 — `world/roofPlant.ts`: 4.0's roof-plant algorithm transliterated, with objects per piece

**Where:** `src/world/roofPlant.ts:70-116` (46/69 identical; the file cites 4.0 lines 94-145).

```ts
// world/roofPlant.ts:77-84 — a Uint8Array, two closures and a per-item object per roof
const used = new Uint8Array(nx * nz);
const free = (i0, j0, i1, j1): boolean => { ... };
const take = (i0, j0, i1, j1): void => { ... };
...
out.push({ kind: k.kind, x0: ..., z0: ..., x1: ..., z1: ..., h: k.h, variant });
```

The same algorithm also exists in `src/r40/world/buildings/roofPlant.ts` (63/63 identical to 4.0). R5 runs two
copies of the same 4.0 generator: one for generic roofs, one inside the r40 path.

**Why it is wrong:** object per roof-plant piece, closures per roof, a 24-try random placement loop, and a
duplicated algorithm that can diverge. The scale is small (a few items per roof), but the rule is categorical:
no object per entity, no duplicated implementation.

**Correct solution:** one roof-plant planner in `jobs/b40` (or a shared world module) writing into a packed
table reused across roofs; generic and 4.0 paths read the same table.

---

## 3. Kept as values/assets (classified, not defects)

These are in the scan but are not code that must be rewritten; they are listed so the number is not misread:

- `src/ui/icons.ts` — 174/188 identical SVG paths. Player-facing appearance, must match 4.0 (assets).
- `src/roads/markings.ts` — 26/65 identical marking glyphs/tables (appearance data).
- `data/textos-roadcraft/*.ts` — 695 + 667 = 1,362 lines, 100 % of 4.0's player strings, imported by
  `src/shared/i18n/index.ts:6-7`. Player text must match 4.0; `tools/textos.mjs` guards coverage.
- `src/shared/i18n/lang/engine.*.ts` — 29 + 30 identical lines: player strings, same reason.
- Colour tables (`treeMeshes` tones, `roofPlant` catalogue values, finish palettes): numeric values, allowed.

`src/render/carBody.ts`'s 56-line `Style` interface/table is borderline: the **values** are allowed, the
interface/table structure is code. It is listed under C10 with that distinction.

---

## 4. Performance and architecture defects in R5 code

### P1 — Meshing and generation on the main thread at load and on interaction

**Where:** `src/render/props.ts:140-147`;
`src/render/propMeshes.ts:538`;
`src/features/demolition/ruin/ruinMesh.ts:73`;
`src/render/inside.ts:10, 109-116`;
`src/game.ts:11`; `src/features/demolition/bomb.ts:14`.

```ts
// props.ts:140-147 — at game start, on the page
this.partModels = buildingPartModels();
this.defs = buildPropDefs(this.partModels);
const built = buildPropKinds(this.defs);
...
impostorFrames(impostorSources(this.defs));

// propMeshes.ts:538 — this is r40's kit, building three geometries on the main thread
return partGeometries() as unknown as Record<string, THREE.BufferGeometry>;

// ruinMesh.ts:73 — a second full set of furniture geometries on the main thread
for (const [kind, g] of Object.entries(createFurnitureGeometries())) models.push(['f:' + kind, g, 0xffffff]);

// inside.ts:109-116 — opening the inside view generates the whole 4.0 lot on the page
export function insidePlanOf(world: World, id: number, k: number): InsidePlan | null {
  ...
  return insidePlan(buildingVolumes(world.heights, boxes, i), ...);
}
```

`buildingVolumes` calls `genOne(..., -3)` → `volumes40` → `building40` → `planLot` + `madeToMeasure` +
`furnishLot` (C6). `game.ts:11` and `inside.ts:10` import `jobs/buildingGen.ts`, which imports
`jobs/building40.ts`, which imports the whole r40 subsystem — so the page's module graph carries the worker
generator, and the same code can (and does) run on the page.

**Why it is wrong:** `CLAUDE.md` "Forbidden" item 4 (generation/meshing on the main thread; they run in
workers) and item 1 of "Correct optimization" ("the main thread only sends commands and draws"). MDN: workers
exist so that "processor-intensive calculations" do not block "the user interface thread"
([MDN, *Using Web Workers*](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers)).
A full lot plan on the click that opens the inside view is a guaranteed hitch; how long was not measured in this
session **(suspected magnitude)**.

**Correct solution:** split the height helper (`wallsHeightOf`) from the generator so the page never imports
`buildingGen`; generate and mesh all model geometries in a worker and transfer them; have the inside view
consume a layout already produced by the worker that meshed the cell (a per-cell typed layout), not regenerate.

---

### P2 — God files

**Where:** `src/game.ts` (1,554 lines, 88 imports, 92 methods), `src/sim/traffic.ts` (1,711 lines),
`src/sim/peds.ts` (1,357 lines), `src/ui/roadCatalog.ts` (59 KB), `src/ui/inspector.ts` (47 KB),
`src/ui/drawers.ts` (47 KB), `src/ui/hud.ts` (45 KB), `src/render/terrain.ts` (62 KB),
`src/jobs/roadMesh.ts` (44 KB).

**Why it is wrong:** `CLAUDE.md` "Forbidden" item 3 (god files mixing responsibilities) and "Organization"
(one responsibility per module, one public entry). `game.ts` mixes scene creation, camera, weather, tools,
saving, simulation link, UI and input; the file-size gate (150 KB) does not catch it because the gate measures
bytes, not responsibilities. `MEMORY/DECISIONS.md:135` already records the extraction plan (`app/session`,
`app/tools`, `features/demolition/bomb`, `app/photoHooks`, then `traffic`, `buildingGen`, `r40/buildingMesh`).

**Correct solution:** execute the recorded extraction order; the file-size gate alone is not the rule.

---

### P3 — 24 km maps depend on a texture-array limit above the WebGPU guarantee

**Where:** `src/render/scene.ts:61-65`, `src/game.ts:547-551`, `src/ui/menu.ts:49`.

```ts
// scene.ts:61-65 — one texture array layer per tile
let maxLayers = 256;
if (isWebGPU && be.device) maxLayers = be.device.limits.maxTextureArrayLayers;
...

// game.ts:548-551 — a 24 km map needs 24 × 24 = 576 layers, or the game falls back
if (MAP_TILES * MAP_TILES > this.parts.maxLayers) {
  const fit = [...MAP_SIZES].reverse().find((t) => t * t <= this.parts.maxLayers) ?? 10;
  reloadWithMap(fit, 'large');
}
```

**Why it is wrong:** the WebGPU specification guarantees only `maxTextureArrayLayers = 256`; adapters may
report more, but a design that needs 576 layers for the stated 24 km goal fails on any adapter at the
guaranteed minimum, and the menu then disables the 24 km option. The goal is "opening and running 10–24 km
cities"; a hard GPU-limit dependency is an architecture risk, not a quality setting.

**Source:** W3C WebGPU spec, `maxTextureArrayLayers` default 256, "always guaranteed to support the defaults or
better" (<https://www.w3.org/TR/webgpu/#limits>).

**Correct solution:** tile the height/ground/water data across bindings or an atlas (e.g. a 2D array of tiles
per atlas page) so the layer count is bounded independently of map size; verify the actual limit on the target
GPU before keeping the fallback as the answer.

---

### P4 — Two sources of truth for the same generator (roof plant, heights, 4.0/generic buildings)

**Where:** `src/world/roofPlant.ts` vs `src/r40/world/buildings/roofPlant.ts`;
`src/jobs/buildingGen/heights.ts` (`wallsHeight`) vs the generated volumes;
`src/jobs/buildingGen.ts:108-113` (`isLot40`) duplicating the branch tests inside `genOne`.

`isLot40` repeats the tests of `genOne` "in its order" (comment at `buildingGen.ts:108`); if one changes, the
party-wall/lot list and the actual emission silently disagree.

**Why it is wrong:** duplicated logic that must stay in lockstep is a latent correctness bug, and in this case
it decides which lots get party walls — a wrong answer draws hidden walls (extra geometry) or drops real ones.
The rule is one responsibility and one source of truth; the fix is to compute the predicate once and pass it.

---

## 5. Quality and measurement

### Q1 — Maximum quality is below 4.0's maximum

**Where:** `src/render/post.ts:63-68, 120-122`; `src/platform/settings.ts:42-50`;
`src/render/city.ts:37`, `src/render/cookedSurfaces.ts:18`, `src/render/propMeshes.ts:260`,
`src/render/surfaceBake.ts:15`.

```ts
// post.ts:122 — AO at half size at every preset, including ultra
aoPass.resolutionScale = 0.5;

// settings.ts:42-47 — ultra differs from high only by detail distance
high:  { resolution: 1, shadows: true, ao: true, bloom: true, detail: 1 },
ultra: { resolution: 1, shadows: true, ao: true, bloom: true, detail: 1.4 },

// city.ts:37 — anisotropy fixed at 8, not a preset value
t.anisotropy = 8;
```

4.0's ultra tier, read in the reference (`roadcraft/src/render/quality.ts`):

```ts
// roadcraft/src/render/quality.ts:221, 234, 238
pixelRatio: 2,
aoFull: true,
anisotropy: 16,
```

**Why it is wrong:** `CLAUDE.md` requires 4.0's appearance at **maximum quality** and forbids quality cuts to
pass performance. R5's ultra renders AO at half resolution (4.0 high's setting, not ultra's), caps pixel ratio
at 1 (on a 1× display; 4.0 ultra renders at 2×) and uses anisotropy 8 (4.0 high; ultra is 16). The r186 GTAO
node documents `resolutionScale = 1` as "full resolution for best quality"
(`node_modules/three/examples/jsm/tsl/display/GTAONode.js:85-91`), and the project comment itself cites
4.0's high tier for the half-size choice (`post.ts:115-116`) — the ultra tier of R5 never restores it. This is
a documented quality regression, not a measurement inference.

**Correct solution:** make AO scale, pixel ratio and anisotropy preset-dependent with ultra matching 4.0 ultra
(full AO, pixel ratio 2, anisotropy 16); if the GPU cannot pay for it, fix the AO implementation (e.g. a cheaper
depth-only AO or a better denoise) — the rule says architecture, never a quality cut.

---

### Q2 — The budget baseline was recorded at default (high), not maximum quality

**Where:** `tools/budget.mjs:31` ("the detail does not depend on the frame time"), `tools/photos/views.mjs`
(the standard views set no preset), `src/platform/settings.ts:49-50` (default `high` on WebGPU),
`tools/budget.json` (city: 179 draws, 3,370,273 triangles).

**(Recorded)** `MEMORY/STATE.md:82-86`: with full detail, the city view is **264 > 179 draws** and
**6.29 M > 4.04 M triangles** — the limit derived from the baseline. The audit `8fa05a4` §12 records 13.75 M
triangles for the city view in another run. The "budget ok" messages therefore do not prove the maximum-quality
requirement; they prove the default preset.

**Why it is wrong:** `CLAUDE.md`: measure with "maximum quality settings"; a view over its limit may not be
made to pass by lowering detail. A baseline captured at `high` bakes the quality cut into the threshold, so
future regressions can hide under it.

**Correct solution:** re-record and re-check with the ultra preset (and the AO/pixel-ratio/anisotropy of Q1);
report both presets until ultra passes, or keep the over-limit view listed as open.

---

### Q3 — Opening time remains far from the interaction budget **(recorded)**

`MEMORY/STATE.md:36`: opening profiled on 2026-10-31 at ~26 s to a drawn city (ready 6 s, generation 8 s,
meshing 12 s); the 2026-10-31 audit records ~31 s. No new measurement was taken here. The causes map to
C1–C8 and P1: generation repeated per level/worker, O(n²) furnishing, object churn, and main-thread model
building. This is stated as a recorded defect, not a new measurement.

---

## 6. 4.0 results that are missing (fidelity gaps)

**F1 — Flags never drawn.** `emitChunk` collects `FlagInstance[]` (`r40/render/buildings/buildingMesh.ts:328-349`),
but the only caller (`jobs/building40.ts:205`) reads `shells`, `runs`, parts and furniture and drops `flags`.
4.0's flags on civic buildings therefore do not exist in R5.

**F2 — Rooms lit by the hour never drawn.** The only `emitChunk` call passes `rooms = false`
(`jobs/building40.ts:205`); `lightSlots.ts`, `roomBehind.ts` and the pane slot/room path are dead (C7). The
4.0 result "which room is lit at which hour" is not implemented; a shader approximation may exist, but the
room data is not produced. The audit `8fa05a4` §11 lists this as one of the four missing 4.0 results.

**F3 — Porch lamp's wash skipped.** `jobs/building40.ts:37` `const SKIPPED = new Set(['wash'])`: the porch lamp
light on the wall is never laid. The audit lists the porch ("alpendre") as missing; this is the concrete part
of it visible in code.

**F4 — Small parts at distance.** The far level is emitted with `far = true` and draws walls/windows by shader
without the small parts (`jobs/building40.ts:203-205`, comment). The audit `8fa05a4` §11 records "peças de
longe" as missing from 4.0. **(Recorded by the prior audit; not re-photographed here.)**

**Why they matter:** fidelity is the first priority after honesty; a missing 4.0 result is not a performance
trade-off and may not be reclassified as "acceptable" (`CLAUDE.md`, "Fidelity" and "The correct solution").

---

## 7. Verified correct — not everything is wrong

To keep the report honest, these were read and are sound; they should not be rewritten with the b40 work:

1. **SoA tables.** `src/core/table.ts` is a real SoA table with dense ids and a free list; `world.buildings` is
   one (`world/world.ts:96`). The engine's core is not object-per-entity; the exception is the r40 subsystem.
2. **Traffic/regions/advisor/signals.** `sim/traffic/regions.ts` divides only changed regions every 4 s (D55);
   `FlowAdvisor.step` judges only watched/due junctions; `LightBoard.step` uses a time heap; `peds.step` uses
   an event heap and bounded lists. These are the right architecture and already replace 4.0's whole-map scans.
3. **Vehicles.** `render/vehicles.ts` uses instanced batches, typed pose arrays, tile-level frustum/box culling
   and reusable `Frustum`/`Sphere`/`Box3`; no per-vehicle object and no allocation in the loop.
4. **Props.** `render/props.ts` uses GPU compute culling, indirect draws, a bounded pool and typed arrays; the
   empty-level visibility test is explicit. The per-frame `forEach` closures are minor, not the problem.
5. **Cell layers.** `render/cellLayer.ts` rebuilds only dirty cells, keeps per-layer triangle/memory budgets
   and freezes CPU copies after upload; `processDirty` drains typed dirty lists.
6. **Workers and transferables.** `jobs/pool.ts` is a priority heap with deduplication, cancellation and
   transferred buffers; `jobs/worker.ts` returns `meshTransfer`/`boxTransfer` buffers. This matches MDN's
   zero-copy transfer guidance ([MDN, *Transferable objects*](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects))
   and web.dev's worker model ([web.dev, *Workers overview*](https://web.dev/articles/workers-overview)).
7. **Some r40 hot spots were hand-optimised**: `meshCore` has a reusable `quad`, `Grow` typed arrays, a numeric
   `bayKey`, a custom open-addressing `weld` and `hypot3`; `PartRows` writes into reusable arrays. The problem
   is the surrounding 4.0 architecture, not the absence of any optimisation.

---

## 8. Order of work

1. **b40 rewrite (C1–C8).** One generation per lot per job, SoA volumes/bays/elements, no string keys, no
   O(n²), no discarded work; delete `src/r40` at the end (B40-PLAN steps 1–8). This removes ~6,525 copied
   lines and the main-thread generation path.
2. **Remove main-thread meshing/generation (P1).** Split `heights` from the generator; move part/furniture
   models to a worker and transfer; inside view consumes a worker-built layout.
3. **Fix discarded work (C7, F1).** Wire flags, delete rooms/slots/light path or implement it, and emit the
   footprints directly instead of running the generic generator into `NO_MESH` for them.
4. **Rewrite the remaining copies (C10–C12).** heavyBody lower body, tree noise, UI construction, roof plant;
   keep the numeric values.
5. **Restore 4.0 maximum quality (Q1) and re-base the budget at ultra (Q2).**
6. **Split the god files (P2)** in the order already recorded in `MEMORY/DECISIONS.md:135`.
7. **Resolve the 24 km texture-layer dependency (P3)** before claiming the 10–24 km goal.

---

## 9. Sources

Documentation used for the causes above (all opened in this session unless marked):

- W3C, *WebGPU Specification — Limits*: <https://www.w3.org/TR/webgpu/#limits> (maxTextureArrayLayers default
  256, guaranteed floor).
- MDN, *Using Web Workers*: <https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers>
  ("perform processor-intensive calculations without blocking the user interface thread").
- MDN, *Transferable objects*:
  <https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects> (zero-copy buffer
  transfer).
- web.dev, *Workers overview*: <https://web.dev/articles/workers-overview> (off-main-thread work, UI
  responsiveness).
- V8, *Fast properties*: <https://v8.dev/blog/fast-properties> (hidden classes; added/deleted properties go to
  dictionary mode; inline caches).
- V8, *Trash talk*: <https://v8.dev/blog/trash-talk> (GC work, main-thread jank, survivor cost).
- three.js r186, `InstancedMesh`: `node_modules/three/src/objects/InstancedMesh.js:16-22` — "reduce the number
  of draw calls and thus improve the overall rendering performance".
- three.js r186, `BatchedMesh`: `node_modules/three/src/objects/BatchedMesh.js:150` — same statement for
  batched geometries.
- three.js r186, `GTAONode`: `node_modules/three/examples/jsm/tsl/display/GTAONode.js:85-91` —
  `resolutionScale = 1` default, "full resolution for best quality".
- three.js r186, `Texture`: `node_modules/three/src/textures/Texture.js:155-163` — anisotropy's cost/behaviour.
- Teschner et al., *Optimized Spatial Hashing for Collision Detection of Deformable Objects* (2003):
  <https://cgl.ethz.ch/Downloads/Publications/Papers/2003/Tes03/Tes03.pdf> (spatial hashing for broad-phase
  overlap queries).
- Fabian, *Data-Oriented Design*: <https://dataorienteddesign.com/dodbook/> ("Structs of arrays";
  component-based objects).
- 4.0 reference read for the quality comparison: `roadcraft/src/render/quality.ts:196, 221, 234, 238`
  (`aoFull`, `pixelRatio`, `anisotropy` per tier); `roadcraft/src/render/postprocess.ts:185-228` (GTAOPass
  at the frame's size).
- Project records: `MEMORY/STATE.md` (recorded measurements, opening profile, budget findings),
  `MEMORY/COPY-AUDIT.md`, `MEMORY/R40-AUDIT.md`, `MEMORY/B40-PLAN.md`, `MEMORY/DECISIONS.md:135`.

**Not verified in this session:** any runtime cost, frame time, draw/triangle count or image. The numbers in
Q2/Q3 are quoted from the project's records; the code-level findings are from reading the code and from the
copy scan. The items marked **(suspected)** must be confirmed with the standard views (street, district,
city, night) beside 4.0 before they are reported as fixed.

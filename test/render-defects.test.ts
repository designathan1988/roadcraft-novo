/// <reference types="node" />
// Regression tests for the drawing defects (section E of DEFEITOS-roadcraft-novo.md), one test per defect id. Each one
// failed on the code before its fix (the commit that fixed it quotes the result before and after).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { World } from '../src/world/world.ts';
import { CellLayer, type LayerSource } from '../src/render/cellLayer.ts';
import { TILE_COUNT, Dirty } from '../src/core/grid.ts';
import type { PackedMesh } from '../src/shared/contracts/worker.ts';
import { splitGlass } from '../src/render/vehicleModels.ts';

/** A one-triangle packed mesh. */
function triangle(): PackedMesh {
  return { originX: 0, originY: 0, originZ: 0, scale: 256, vertexCount: 3, minY: 0, maxY: 1,
    position: new Int16Array([0, 0, 0, 0, 100, 0, 0, 0, 0, 0, 100, 0]), normal: new Int8Array(12), color: new Uint8Array(12),
    index: new Uint16Array([0, 1, 2]) };
}

type Slot = { mesh: THREE.Mesh | null; requested: number; built: number };
interface LayerInside { cells: Slot[][]; tiles: Slot[]; plates: Slot[]; setMesh(s: Slot, m: PackedMesh | null, v: number): void }
const inside = (l: CellLayer) => l as unknown as LayerInside;

/** A layer source that records every request and keeps its callbacks, to answer them by hand. */
function recordingSource(): LayerSource & { cells: Array<{ c: number; level: number; done: (m: PackedMesh | null) => void }> } {
  const cells: Array<{ c: number; level: number; done: (m: PackedMesh | null) => void }> = [];
  return {
    cells,
    buildCell(c, level, _p, done) { cells.push({ c, level, done }); },
    buildTile(_t, _p, done) { done(null); },
    hasContent: () => true,
  };
}

test('E10: two layers fed by the same kind of dirty cells both rebuild an edited cell', () => {
  const w = new World();
  const material = new THREE.MeshBasicNodeMaterial();
  const srcA = recordingSource(), srcB = recordingSource();
  const city = new CellLayer(srcA, w.dirty, Dirty.Buildings, material, { near: 1400, evict: 2600, margin: 40 });
  const detail = new CellLayer(srcB, w.dirty, Dirty.Buildings, material, { near: 1100, evict: 1400, margin: 30, sparse: true });
  const c = 5;
  for (const l of [city, detail]) inside(l).setMesh(inside(l).cells[0][c], triangle(), 1);
  w.dirty.mark(c, Dirty.Buildings);
  city.processDirty();
  detail.processDirty();
  assert.deepEqual(srcA.cells.map((r) => r.c), [c], 'the city layer asked for the edited cell');
  assert.deepEqual(srcB.cells.map((r) => r.c), [c], 'the detail layer asked for the edited cell too');
});

test('E11: a mesh of the previous city that arrives after reset is thrown away', () => {
  const w = new World();
  const src = recordingSource();
  const layer = new CellLayer(src, w.dirty, Dirty.Buildings, new THREE.MeshBasicNodeMaterial(), { near: 1400, evict: 2600, margin: 40 });
  const L = inside(layer);
  const c = 7;
  // the old city asks for the cell (its job is still running when the player loads another map)
  (layer as unknown as { requestCell(c: number, level: number): void }).requestCell(c, 0);
  const old = src.cells.pop()!;
  layer.reset();
  // the new city asks for the same cell
  (layer as unknown as { requestCell(c: number, level: number): void }).requestCell(c, 0);
  const fresh = src.cells.pop()!;
  old.done(triangle());
  assert.ok(L.cells[0][c].mesh === null, 'the old city\'s mesh was not taken');
  fresh.done(triangle());
  assert.ok(L.cells[0][c].mesh !== null, 'the new city\'s mesh was taken');
});

/** A source that answers tiles and plates at once (cells are left pending), counting the requests. */
function farSource(): LayerSource & { tileAsks: number[]; plateAsks: number[] } {
  const tileAsks: number[] = [], plateAsks: number[] = [];
  return {
    tileAsks, plateAsks,
    buildCell() { /* near cells never answer: the far bands are under test */ },
    buildTile(t, _p, done) { tileAsks.push(t); done(triangle()); },
    buildPlate(p, _q, done) { plateAsks.push(p); done(triangle()); },
    hasContent: () => true,
  };
}

/** A camera at the map's south-west corner, 300 m up, looking at the centre with a 90° view. */
function cornerCamera(): { camera: THREE.PerspectiveCamera; eye: THREE.Vector3 } {
  const camera = new THREE.PerspectiveCamera(90, 1, 1, 30000);
  const eye = new THREE.Vector3(-5100, 300, -5100);
  camera.position.copy(eye);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return { camera, eye };
}

test('E12: every tile in view between 4.2 and 6 km is covered by its tile or by its plate', async () => {
  const { MAP_TILES, MAP_PLATES, TILE_SIZE, PLATE_SIZE } = await import('../src/config.ts');
  const w = new World();
  const src = farSource();
  // the building layer's own options (render/city.ts)
  const layer = new CellLayer(src, w.dirty, Dirty.Buildings, new THREE.MeshBasicNodeMaterial(), { near: 1400, evict: 2600, margin: 40, detail: 650, plate: 4200, budget: 256e6 });
  const L = inside(layer);
  const { camera, eye } = cornerCamera();
  for (let i = 0; i < 4; i++) layer.update(camera, eye);
  const drawn = new Set(layer.group.children);
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const per = PLATE_SIZE / TILE_SIZE;
  const missing: string[] = [];
  for (let tz = 0; tz < MAP_TILES; tz++) for (let tx = 0; tx < MAP_TILES; tx++) {
    const x = -MAP_TILES * TILE_SIZE / 2 + tx * TILE_SIZE, z = -MAP_TILES * TILE_SIZE / 2 + tz * TILE_SIZE;
    const box = new THREE.Box3(new THREE.Vector3(x + 1, 0, z + 1), new THREE.Vector3(x + TILE_SIZE - 1, 1, z + TILE_SIZE - 1));
    if (!frustum.intersectsBox(box)) continue;
    const d = Math.hypot(Math.max(0, x - eye.x), Math.max(0, z - eye.z));
    if (d < 1600) continue; // the near band draws by cells (they never answer here)
    const t = tz * MAP_TILES + tx, p = Math.floor(tz / per) * MAP_PLATES + Math.floor(tx / per);
    const covered = (L.tiles[t].mesh && drawn.has(L.tiles[t].mesh!)) || (L.plates[p].mesh && drawn.has(L.plates[p].mesh!));
    if (!covered) missing.push(`tile ${tx},${tz} at ${(d / 1000).toFixed(1)} km`);
  }
  assert.deepEqual(missing, [], 'tiles in view with nothing drawn');
});

test('E9: a plate the camera came close to leaves the GPU once its tiles cover it', () => {
  const w = new World();
  const src = { ...farSource(), buildCell(_c: number, _l: number, _p: number, done: (m: PackedMesh | null) => void) { done(triangle()); } };
  const layer = new CellLayer(src, w.dirty, Dirty.Buildings, new THREE.MeshBasicNodeMaterial(), { near: 1400, evict: 2600, margin: 40, detail: 650, plate: 4200, budget: 256e6 });
  const L = inside(layer);
  const { camera, eye } = cornerCamera();
  for (let i = 0; i < 3; i++) layer.update(camera, eye);
  const centre = 2 * 5 + 2; // plate (2, 2) of the 10 km map: far from the corner
  assert.ok(L.plates[centre].mesh !== null, 'seen from the corner the centre plate is drawn');
  // fly to the centre: the plate's tiles and cells take over
  eye.set(0, 300, 0); camera.position.copy(eye); camera.lookAt(500, 0, 500); camera.updateMatrixWorld();
  for (let i = 0; i < 3; i++) layer.update(camera, eye);
  assert.ok(L.plates[centre].mesh === null, 'the plate under the camera was let go');
});

test('E13: the road layer keeps and draws its tiles to the same distance at every resolution', async () => {
  const { MAP_TILES, TILE_SIZE } = await import('../src/config.ts');
  for (const pixelScale of [0.5, 2]) {
    const w = new World();
    const src = farSource();
    // the road layer's own options (render/roads.ts)
    const layer = new CellLayer(src, w.dirty, Dirty.Roads, new THREE.MeshBasicNodeMaterial(), { near: 1400, evict: 2200, margin: 80, shadows: false, far: 5500, detail: 600, budget: 192e6 });
    layer.pixelScale = pixelScale;
    const L = inside(layer);
    const { camera, eye } = cornerCamera();
    for (let i = 0; i < 3; i++) layer.update(camera, eye);
    const drawn = new Set(layer.group.children);
    const limit = 5500 * Math.max(1, pixelScale);
    const kept: number[] = [], shown: number[] = [];
    for (let t = 0; t < MAP_TILES * MAP_TILES; t++) {
      const x = -MAP_TILES * TILE_SIZE / 2 + (t % MAP_TILES) * TILE_SIZE, z = -MAP_TILES * TILE_SIZE / 2 + Math.floor(t / MAP_TILES) * TILE_SIZE;
      const d = Math.hypot(Math.max(0, x - eye.x), Math.max(0, z - eye.z));
      if (d < 1600) continue;
      const m = L.tiles[t].mesh;
      if (m) kept.push(d);
      if (m && drawn.has(m)) shown.push(d);
    }
    const farKept = Math.max(...kept), farShown = Math.max(...shown);
    assert.ok(farShown > limit - 1500, `pixel scale ${pixelScale}: roads drawn only to ${(farShown / 1000).toFixed(1)} km (limit ${limit / 1000} km)`);
    assert.ok(farKept < limit * 1.2, `pixel scale ${pixelScale}: tiles kept to ${(farKept / 1000).toFixed(1)} km but drawn to ${(farShown / 1000).toFixed(1)} km`);
  }
});

test('E21: a new cell mesh comes with its bounds (three never walks its vertices on the main thread)', () => {
  const w = new World();
  const layer = new CellLayer(recordingSource(), w.dirty, Dirty.Buildings, new THREE.MeshBasicNodeMaterial(), { near: 1400, evict: 2600, margin: 40 });
  const L = inside(layer);
  const s = L.cells[0][0];
  L.setMesh(s, triangle(), 1);
  const g = s.mesh!.geometry;
  assert.ok(g.boundingSphere !== null, 'the bounding sphere is set with the mesh (null: computed from the vertices at first draw)');
  assert.ok(g.boundingBox !== null, 'the bounding box is set with the mesh');
  // the given bounds hold every vertex
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const v = new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i));
    assert.ok(g.boundingSphere!.containsPoint(v), `vertex ${i} inside the sphere`);
  }
});

test('E4: a cell mesh outside a shadow cascade is not drawn into it', () => {
  const w = new World();
  const layer = new CellLayer(recordingSource(), w.dirty, Dirty.Buildings, new THREE.MeshBasicNodeMaterial(), { near: 1400, evict: 2600, margin: 40 });
  const L = inside(layer);
  const s = L.cells[0][0]; // the map's south-west corner cell
  L.setMesh(s, { ...triangle(), originX: -5120, originZ: -5120 }, 1);
  const mesh = s.mesh!;
  // a cascade's camera: 300 m square round a point 3 km away, looking down
  const cascade = new THREE.OrthographicCamera(-150, 150, 150, -150, 1, 2000);
  cascade.position.set(-2000, 1000, -2000); cascade.lookAt(-2000, 0, -2000); cascade.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cascade.projectionMatrix, cascade.matrixWorldInverse));
  // three's renderer draws an object when `!object.frustumCulled || object.intersectsFrustum(frustum)`
  const drawn = !mesh.frustumCulled || mesh.intersectsFrustum(frustum);
  assert.equal(drawn, false, 'the corner cell was drawn into a cascade 4 km away');
  cascade.position.set(-5000, 1000, -5000); cascade.lookAt(-5000, 0, -5000); cascade.updateMatrixWorld();
  frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cascade.projectionMatrix, cascade.matrixWorldInverse));
  assert.equal(mesh.intersectsFrustum(frustum), true, 'a cascade over the cell draws it');
});

/** A renderer stand-in: enough for the post-processing to build its node graph (nothing is drawn). */
const fakeRenderer = () => ({ shadowMap: {}, coordinateSystem: THREE.WebGPUCoordinateSystem, reversedDepthBuffer: false }) as unknown as THREE.WebGPURenderer;

test('E7: rebuilding the final image frees every render target the old one held', async () => {
  const { Post } = await import('../src/render/post.ts');
  const GTAONode = (await import('three/addons/tsl/display/GTAONode.js')).default;
  const BloomNode = (await import('three/addons/tsl/display/BloomNode.js')).default;
  const { CSMShadowNode } = await import('three/addons/csm/CSMShadowNode.js');
  const TRAANode = (await import('../src/render/traa.ts')).default;
  // every class that owns GPU targets: count the instances disposed
  const classes = { PassNode: THREE.PassNode, RTTNode: THREE.RTTNode, ShadowNode: THREE.ShadowNode, GTAONode, BloomNode, TRAANode, CSMShadowNode } as Record<string, { prototype: { dispose(): void } }>;
  const disposed = new Map<string, Set<unknown>>();
  const restore: Array<() => void> = [];
  for (const [name, C] of Object.entries(classes)) {
    const own = Object.prototype.hasOwnProperty.call(C.prototype, 'dispose') ? C.prototype.dispose : undefined;
    const orig = C.prototype.dispose;
    C.prototype.dispose = function (this: unknown) { if (!disposed.has(name)) disposed.set(name, new Set()); disposed.get(name)!.add(this); return orig.call(this); };
    restore.push(() => { if (own) C.prototype.dispose = own; else delete (C.prototype as { dispose?: unknown }).dispose; });
  }
  try {
    const renderer = fakeRenderer();
    const camera = new THREE.PerspectiveCamera(50, 16 / 9, 1, 30000), sun = new THREE.DirectionalLight();
    const scene = new THREE.Scene(); scene.add(sun);
    const post = new Post(renderer, scene, camera, sun, { shadows: true, ao: true, bloom: true });
    // the first frame builds the cascades (3 shadow maps)
    (post.csm as unknown as { _init(b: unknown): void })._init({ camera, renderer });
    post.dispose();
    const count = (k: string) => disposed.get(k)?.size ?? 0;
    assert.ok(count('PassNode') >= 1, `scene pass freed (${count('PassNode')})`);
    assert.equal(count('GTAONode'), 1, 'ambient occlusion freed');
    assert.equal(count('BloomNode'), 1, 'bloom freed');
    assert.equal(count('TRAANode'), 2, 'both anti-aliasing histories freed');
    // the two copies of the image fed to the anti-aliasing, and the occlusion's denoised target (render/aoDenoise.ts)
    assert.equal(count('RTTNode'), 3, 'the two copies of the image fed to the anti-aliasing and the denoised occlusion freed');
    assert.equal(count('CSMShadowNode'), 1, 'cascades freed');
    assert.equal(count('ShadowNode'), 3, 'the three cascade shadow maps freed');
  } finally { for (const r of restore) r(); }
});

test('E17: the shadow cascades follow the isometric camera and the window\'s shape', async () => {
  const { Post } = await import('../src/render/post.ts');
  const renderer = fakeRenderer();
  const persp = new THREE.PerspectiveCamera(50, 16 / 9, 1, 30000), sun = new THREE.DirectionalLight();
  const scene = new THREE.Scene(); scene.add(sun);
  const post = new Post(renderer, scene, persp, sun, { shadows: true, ao: false, bloom: false });
  const csm = post.csm as unknown as { _init(b: unknown): void; frustums: Array<{ vertices: { far: THREE.Vector3[] } }>; maxFar: number; camera: THREE.Camera };
  csm._init({ camera: persp, renderer });
  // the isometric camera of render/cameraRig.ts: 3 km from what it looks at, 1 km of view across
  const iso = new THREE.OrthographicCamera(-889, 889, 500, -500, 1, 6000);
  iso.position.set(0, 2000, 2236); iso.lookAt(0, 0, 0); iso.updateMatrixWorld();
  post.setCamera(iso);
  const last = csm.frustums[csm.frustums.length - 1].vertices.far[0];
  assert.ok(Math.min(csm.maxFar, iso.far) >= 3000 && last.z <= -3000, `the cascades end ${(-last.z).toFixed(0)} m from the isometric camera: the ground 3 km away has no sun shadow`);
  assert.ok(Math.abs(last.x) >= 889, `the cascades cover ${Math.abs(last.x).toFixed(0)} m sideways of the 889 m view`);
  // back to perspective, then the window gets twice as wide
  post.setCamera(persp);
  persp.aspect = 32 / 9; persp.updateProjectionMatrix();
  post.setCamera(persp);
  const f = csm.frustums[0].vertices.far[0];
  const want = Math.tan(THREE.MathUtils.degToRad(25)) * persp.aspect;
  assert.ok(Math.abs(Math.abs(f.x / f.z) - want) < 0.01, `after the resize the cascades span ${Math.abs(f.x / f.z).toFixed(2)} sideways per metre, the view ${want.toFixed(2)}`);
});

test('E18: the ambient occlusion reads the depth with the matrices of the camera in use', async () => {
  const { Post } = await import('../src/render/post.ts');
  const persp = new THREE.PerspectiveCamera(50, 16 / 9, 1, 30000), sun = new THREE.DirectionalLight();
  const post = new Post(fakeRenderer(), new THREE.Scene(), persp, sun, { shadows: false, ao: true, bloom: false });
  const iso = new THREE.OrthographicCamera(-889, 889, 500, -500, 1, 6000);
  post.setCamera(iso);
  type U = { value: unknown };
  const inner = post as unknown as { owned: Array<{ _cameraProjectionMatrix?: U; _cameraProjectionMatrixInverse?: U; _cameraNear?: { object: unknown } }> };
  const aoNode = inner.owned.find((n) => n._cameraProjectionMatrix)!;
  const denoiseNode = inner.owned.find((n) => n._cameraProjectionMatrixInverse && !n._cameraProjectionMatrix)!;
  assert.ok(aoNode._cameraProjectionMatrix!.value === iso.projectionMatrix, 'GTAO projects with the isometric camera');
  assert.ok(aoNode._cameraProjectionMatrixInverse!.value === iso.projectionMatrixInverse, 'GTAO unprojects with the isometric camera');
  assert.ok(aoNode._cameraNear!.object === iso, 'GTAO reads the isometric camera\'s near and far');
  assert.ok(denoiseNode._cameraProjectionMatrixInverse!.value === iso.projectionMatrixInverse, 'the denoise unprojects with the isometric camera');
});

test('the ambient occlusion reads the depth alone, at half resolution (no shading normal, no 100 % GPU)', async () => {
  // Roadcraft 4.0 postprocess.ts:214 (normals rebuilt from the depth). The shading normal shaded a flat ground up to a
  // line; at the frame's full size the pass ran the GPU to 100 % in the standard views (the owner, 2026-10-31).
  const { Post } = await import('../src/render/post.ts');
  const persp = new THREE.PerspectiveCamera(50, 16 / 9, 1, 30000), sun = new THREE.DirectionalLight();
  const post = new Post(fakeRenderer(), new THREE.Scene(), persp, sun, { shadows: false, ao: true, bloom: false });
  type AONode = { _cameraProjectionMatrix?: unknown; _cameraProjectionMatrixInverse?: unknown; normalNode?: unknown; resolutionScale?: number };
  const owned = (post as unknown as { owned: AONode[] }).owned;
  const aoNode = owned.find((n) => n._cameraProjectionMatrix)!;
  const denoiseNode = owned.find((n) => n._cameraProjectionMatrixInverse && !n._cameraProjectionMatrix)!;
  assert.equal(aoNode.normalNode, null, 'GTAO rebuilds its normals from the depth');
  assert.equal(denoiseNode.normalNode, null, 'the denoise rebuilds its normals from the depth');
  assert.equal(aoNode.resolutionScale, 0.5, 'GTAO at half the frame\'s size');
});

test('E5, E25: each prop draw carries one variant only (a hydrant does not process the vertices of 13 other pieces)', async () => {
  const PM = await import('../src/render/propMeshes.ts') as Record<string, unknown> & typeof import('../src/render/propMeshes.ts');
  const { PROP } = await import('../src/jobs/props.ts');
  const defs = PM.buildPropDefs(PM.buildingPartModels());
  // what the renderer draws: one geometry per kind and level (before: per type and level)
  const build = PM.buildPropKinds as ((d: typeof defs) => { kinds: Array<{ type: number; lods: Array<THREE.BufferGeometry | null> }> }) | undefined;
  const draws = build ? build(defs).kinds : defs.map((d, type) => ({ type, lods: d.lods }));
  const mixed: string[] = [];
  let hydrant = Infinity;
  for (const k of draws) {
    for (const [l, g] of k.lods.entries()) {
      if (!g) continue;
      const col = g.attributes.pcol as THREE.BufferAttribute, variants = new Set<number>();
      for (let i = 0; i < col.count; i++) {
        const mat = Math.round(col.getW(i) * 255);
        if (mat >= PM.PMAT.Sign0 && mat <= PM.FACE_LAST) variants.add(mat - PM.PMAT.Sign0);
      }
      if (variants.size > 1) mixed.push(`type ${k.type} level ${l}: ${variants.size} variants, ${col.count} vertices per instance`);
      if (k.type === PROP.Furniture && variants.size === 1 && variants.has(0)) hydrant = col.count;
    }
  }
  assert.deepEqual(mixed, [], 'draws that carry several variants');
  assert.ok(hydrant < 600, `a hydrant draws ${hydrant} vertices`);
});

test('E26: props that lie on the ground cast no sun shadow', async () => {
  const PM = await import('../src/render/propMeshes.ts') as Record<string, unknown> & typeof import('../src/render/propMeshes.ts');
  const { PROP } = await import('../src/jobs/props.ts');
  const { kinds } = PM.buildPropKinds(PM.buildPropDefs(PM.buildingPartModels()));
  // the rule the renderer uses (before: every near level but the wires)
  const casts = (PM.propCastsShadow as ((k: (typeof kinds)[number], l: number) => boolean) | undefined) ?? ((k, l) => l === 0 && k.type !== PROP.Wire);
  const flat: string[] = [];
  for (const k of kinds) {
    const g = k.lods[0];
    if (!g) continue;
    g.computeBoundingBox();
    const h = g.boundingBox!.max.y - Math.max(0, g.boundingBox!.min.y);
    if (h < 0.3 && casts(k, 0)) flat.push(`type ${k.type}: ${h.toFixed(2)} m tall casts a shadow`);
  }
  assert.deepEqual(flat, [], 'ground-hugging props in the shadow maps');
  const palm = kinds.find((k) => k.type === PROP.Ground && (k.lods[0]?.attributes.position.count ?? 0) > 0 && (k.lods[0]!.computeBoundingBox(), k.lods[0]!.boundingBox!.max.y > 5));
  assert.ok(palm && casts(palm, 0), 'the ground palm (8 m) still casts');
});

test('E27: the cull sphere of every prop holds the whole piece at its largest scale', async () => {
  const PM = await import('../src/render/propMeshes.ts') as Record<string, unknown> & typeof import('../src/render/propMeshes.ts');
  const { PROP } = await import('../src/jobs/props.ts');
  const { kinds } = PM.buildPropKinds(PM.buildPropDefs(PM.buildingPartModels()));
  // the radius the cull pass uses for an instance (before: the kind's radius, whatever the scale)
  const cullRadius = (PM.propCullRadius as ((k: (typeof kinds)[number], w: number) => number) | undefined) ?? ((k) => k.radius);
  const out: string[] = [];
  for (const k of kinds) {
    // the largest pose: scale bits at 63 (2× for pieces, a 63 m span for wires, 6.3 m for walls)
    const w = 63 << 16, scale = 63 / 42 + 0.5;
    for (const [l, g] of k.lods.entries()) {
      if (!g || Math.round((g.attributes.pcol as THREE.BufferAttribute).getW(0) * 255) === PM.PMAT.Impostor) continue; // camera-facing photo of the near mesh
      const p = g.attributes.position as THREE.BufferAttribute, e = g.attributes.pext as THREE.BufferAttribute;
      let far = 0;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const v = k.type === PROP.Wire ? [x, y, z * 63] : k.type === PROP.Barrier ? [x, y, z * 6.3] : [x * scale, y * scale, z * scale];
        // leaf cards turn to the camera round their centre: their corner offset counts in any direction
        far = Math.max(far, Math.hypot(v[0], v[1], v[2]) + Math.hypot(e.getZ(i), e.getW(i)) * scale);
      }
      const r = cullRadius(k, w);
      if (far > r + 1e-3) out.push(`type ${k.type} level ${l}: reaches ${far.toFixed(1)} m, sphere ${r.toFixed(1)} m`);
    }
  }
  assert.deepEqual(out, [], 'pieces that stick out of their cull sphere (cut at the screen edge)');
});

test('E14: a building outside the view whose shadow falls into it is drawn into the shadow maps', async () => {
  const { sunDirection } = await import('../src/render/sun.ts');
  const w = new World();
  const c = 18 * 40 + 16;
  const layer = new CellLayer({ ...recordingSource(), hasContent: (cc: number) => cc === c }, w.dirty, Dirty.Buildings, new THREE.MeshBasicNodeMaterial(), { near: 1400, evict: 2600, margin: 40 });
  const L = inside(layer);
  // camera at (0, 60, 0) looking north (−z), 60° view: x = ±0.58·depth is the edge of the view
  const camera = new THREE.PerspectiveCamera(60, 1, 1, 30000);
  const eye = new THREE.Vector3(0, 60, 0);
  camera.position.copy(eye); camera.lookAt(0, 0, -1000); camera.updateMatrixWorld();
  // low sun from the west (+x is east): shadows fall east
  sunDirection.set(-1, 0.35, 0).normalize();
  // a 300 m tower in cell (16, 18) of the 10 km map (x −1024..−768, z −512..−256), wholly west of the view; its
  // shadow (300 m / tan 19° ≈ 850 m) reaches east into it
  L.setMesh(L.cells[0][c], { ...triangle(), originX: -1024, originZ: -512, minY: 0, maxY: 300 }, 1);
  for (let i = 0; i < 2; i++) layer.update(camera, eye);
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  assert.equal(frustum.intersectsBox(new THREE.Box3(new THREE.Vector3(-1064, 0, -552), new THREE.Vector3(-728, 300, -216))), false, 'the tower is outside the view');
  try {
    assert.ok(layer.group.children.includes(L.cells[0][c].mesh!), 'the tower west of the view, whose shadow falls into it, is a shadow caster');
  } finally { sunDirection.set(0, 1, 0); }
});

test('E15: road cells with a bridge cast a sun shadow; flat road cells do not', async () => {
  const { createRoads, createTrafficLook } = await import('../src/render/roads.ts');
  const { buildRoad, planRoad, snap } = await import('../src/roads/build.ts');
  const { cellId, cellX } = await import('../src/core/grid.ts');
  const { HEIGHT_TILE_RES, MAP_TILES, TILE_SIZE, HEIGHT_SPACING } = await import('../src/config.ts');
  const w = new World();
  w.heights.fill(10); w.tileMin.fill(-20); w.tileMax.fill(10);
  w.money = 1e9;
  // a valley 20 m deep and 80 m wide across x = −40..40 (rows of the height grid, tile by tile)
  const res = HEIGHT_TILE_RES * MAP_TILES, half = MAP_TILES * TILE_SIZE / 2;
  for (let gz = 0; gz < res; gz++) for (let gx = 0; gx < res; gx++) {
    const x = gx * HEIGHT_SPACING - half;
    if (Math.abs(x) > 40) continue;
    const t = Math.floor(gz / HEIGHT_TILE_RES) * MAP_TILES + Math.floor(gx / HEIGHT_TILE_RES);
    w.heights[t * HEIGHT_TILE_RES * HEIGHT_TILE_RES + (gz % HEIGHT_TILE_RES) * HEIGHT_TILE_RES + (gx % HEIGHT_TILE_RES)] = -10;
  }
  const a = snap(w.roads, -200, 0, 8), b = snap(w.roads, 200, 0, 8);
  const plan = planRoad(w, a, null, b, 0, 0);
  assert.ok(plan.ok, plan.reason);
  assert.ok(buildRoad(w, plan, a, b, 0).settle());
  const flat = snap(w.roads, 100, 2000, 8), flat2 = snap(w.roads, 400, 2000, 8); // east of the valley
  const plan2 = planRoad(w, flat, null, flat2, 0, 0);
  assert.ok(buildRoad(w, plan2, flat, flat2, 0).settle());
  const layer = (createRoads as (...a: unknown[]) => CellLayer)(w.roads, null, w.dirty, createTrafficLook(new SharedArrayBuffer(512 * 512 * 4)), w.heights);
  const L = inside(layer);
  const bridgeCell = cellId(cellX(0), cellX(0)), flatCell = cellId(cellX(250), cellX(2000));
  L.setMesh(L.cells[0][bridgeCell], triangle(), 1);
  L.setMesh(L.cells[0][flatCell], triangle(), 1);
  assert.equal(L.cells[0][bridgeCell].mesh!.castShadow, true, 'the bridge over the valley casts a shadow');
  assert.equal(L.cells[0][flatCell].mesh!.castShadow, false, 'a road on flat ground casts none (its shadow would be under it)');
});

test('E19: with nothing moving the shadow cascades are not redrawn', async () => {
  const { Post } = await import('../src/render/post.ts');
  const renderer = fakeRenderer();
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 1, 30000), sun = new THREE.DirectionalLight();
  const scene = new THREE.Scene(); scene.add(sun);
  const post = new Post(renderer, scene, camera, sun, { shadows: true, ao: false, bloom: false });
  const csm = post.csm as unknown as { _init(b: unknown): void; lights: Array<{ shadow: THREE.LightShadow }> };
  csm._init({ camera, renderer });
  const prepare = (moving: boolean) => (post as unknown as { prepareShadows?(m: boolean): void }).prepareShadows?.(moving);
  const redrawn = () => csm.lights.map((l) => l.shadow.autoUpdate || l.shadow.needsUpdate);
  post.setCamera(camera); prepare(false);
  assert.deepEqual(redrawn(), [true, true, true], 'the first frame draws the cascades');
  post.setCamera(camera); prepare(false);
  assert.deepEqual(redrawn(), [false, false, false], 'a still frame redraws none of the 3 cascades');
  post.setCamera(camera); prepare(true);
  assert.deepEqual(redrawn(), [true, true, true], 'moving casters (traffic, wind) redraw them');
  camera.position.x += 1; camera.updateMatrixWorld();
  post.setCamera(camera); prepare(false);
  assert.deepEqual(redrawn(), [true, true, true], 'the camera moved: redrawn');
  post.invalidateShadows?.();
  post.setCamera(camera); prepare(false);
  assert.deepEqual(redrawn(), [true, true, true], 'the city changed: redrawn');
});

test('E42: a road edit far from every stop does not rebuild the stops; one next to a stop does', async () => {
  const { TransitRenderer } = await import('../src/render/transit.ts');
  const { Transit } = await import('../src/world/transit.ts');
  const { buildRoad, planRoad, snap } = await import('../src/roads/build.ts');
  const w = new World();
  w.heights.fill(10); w.tileMin.fill(10); w.tileMax.fill(10); w.money = 1e9;
  const road = (ax: number, az: number, bx: number, bz: number) => {
    const a = snap(w.roads, ax, az, 8), b = snap(w.roads, bx, bz, 8);
    const p = planRoad(w, a, null, b, 0, 0);
    assert.ok(p.ok, p.reason);
    assert.ok(buildRoad(w, p, a, b, 0).settle());
  };
  road(-200, 0, 200, 0);
  const transit = new Transit();
  const { id, cmd } = transit.addLine();
  cmd.apply();
  transit.addStop(id, -100, 8)!.apply();
  transit.addStop(id, 100, 8)!.apply();
  const view = new TransitRenderer();
  let rebuilds = 0;
  const shelters = (view as unknown as { shelters: THREE.InstancedMesh }).shelters;
  const set = shelters.setMatrixAt.bind(shelters);
  shelters.setMatrixAt = (i: number, m: THREE.Matrix4) => { rebuilds++; return set(i, m); };
  const sync = () => (view.update as (...a: unknown[]) => void)(transit, w.roads, w.heights, transit.version, w.dirty);
  sync();
  const first = rebuilds;
  assert.ok(first > 0, 'the stops are built');
  road(3000, 3000, 3300, 3000); // 3 km away
  sync();
  assert.equal(rebuilds, first, 'a road built 3 km from every stop rebuilt the stops');
  road(-100, -60, -100, 60); // through a stop
  sync();
  assert.ok(rebuilds > first, 'a road next to a stop rebuilds them');
});

test('E38: light rain draws only the drops that show', async () => {
  const { Weather, rainU } = await import('../src/render/weather.ts');
  const weather = new Weather();
  const drops = (weather as unknown as { rain: THREE.Mesh }).rain;
  const all = (drops.geometry as THREE.InstancedBufferGeometry).instanceCount;
  weather.fixed = { clouds: 0.9, rain: 0.1 };
  weather.update(0.016, 1, new THREE.Vector3(0, 50, 0));
  assert.equal(rainU.value, 0.1);
  const drawn = (drops.geometry as THREE.InstancedBufferGeometry).instanceCount;
  assert.ok(drawn <= Math.ceil(all * 0.1) + 1, `rain at 10% draws ${drawn} of ${all} drops`);
  assert.ok(drawn > 0);
});

test('E39: a factory turned into something else stops smoking', async () => {
  const { Particles } = await import('../src/render/particles.ts');
  const { chimneyOf } = await import('../src/world/arch.ts');
  const { Zone } = await import('../src/roads/zones.ts');
  const w = new World();
  w.heights.fill(10); w.tileMin.fill(10); w.tileMax.fill(10);
  let seed = 1;
  while (!chimneyOf(seed, 30, 40, 2)) seed++;
  const id = w.growBuilding({ x: 100, z: 100, w: 30, d: 40, h: 0, rot: 0, color: 0, seed, zone: Zone.Industrial, floors: 2, style: 0 });
  const p = new Particles(w);
  const eye = new THREE.Vector3(100, 50, 100);
  p.update(1, eye);
  assert.equal(p.count, 1, 'the factory\'s chimney smokes');
  // the player turns it into something else (a function: no chimney); same number of buildings and items
  w.editBuilding(id, 2, 0, 1);
  p.update(1, eye);
  assert.equal(p.count, 0, 'the old chimney still smokes');
});

test('E40: an explosion keeps its smoke and fire when the area is full of emitters', async () => {
  const { Particles, Puff } = await import('../src/render/particles.ts');
  const { Item } = await import('../src/world/items.ts');
  const w = new World();
  w.heights.fill(10); w.tileMin.fill(10); w.tileMax.fill(10);
  for (let i = 0; i < 700; i++) w.items.add([(i % 30) * 10, Math.floor(i / 30) * 10, 0, 0, Item.Smoke, 1]);
  const p = new Particles(w);
  const eye = new THREE.Vector3(150, 50, 100);
  p.burst(150, 12, 100, Puff.Fire, 3, 10);
  p.update(1, eye);
  const d = (p as unknown as { data: Float32Array }).data;
  let fire = false;
  for (let i = 0; i < p.count; i++) if (d[i * 4 + 3] % 16 === Puff.Fire && Math.abs(d[i * 4] - 150) < 0.01) fire = true;
  assert.ok(fire, `the explosion's fire is one of the ${p.count} emitters`);
});

/** A stand-in for the page's document: canvases that draw nothing (sign textures in Node). */
function fakeDocument(): void {
  const ctx = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? () => ({ width: 10 }) : () => {}), set: () => true });
  (globalThis as { document?: unknown }).document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
}

test('E8: a sign whose text changed, or that left the area, frees its texture', async () => {
  fakeDocument();
  const { TextSigns, signKey } = await import('../src/render/textSigns.ts');
  const { Item } = await import('../src/world/items.ts');
  const w = new World();
  w.items.add([0, 0, 0, 0, Item.Sign, 1]);
  const texts = new Map([[signKey(0, 0), 'Padaria']]);
  const signs = new TextSigns(w, texts);
  signs.update(new THREE.Vector3(0, 10, 0));
  const cache = (signs as unknown as { cache: Map<string, THREE.MeshBasicNodeMaterial> }).cache;
  const first = [...cache.values()][0];
  let freed = 0;
  first.map!.addEventListener('dispose', () => freed++);
  texts.set(signKey(0, 0), 'Farmácia');
  signs.version++;
  signs.update(new THREE.Vector3(0, 10, 0));
  assert.equal(cache.size, 1, `${cache.size} sign textures kept for 1 sign`);
  assert.equal(freed, 1, 'the old text\'s texture was freed');
});

test('E41: every bus stop gets its shelter, past 2,048', async () => {
  const { TransitRenderer } = await import('../src/render/transit.ts');
  const { Transit } = await import('../src/world/transit.ts');
  const w = new World();
  const transit = new Transit();
  const { id, cmd } = transit.addLine();
  cmd.apply();
  for (let k = 0; k < 2500; k++) transit.addStop(id, -4000 + (k % 100) * 80, -4000 + Math.floor(k / 100) * 80)!.apply();
  const view = new TransitRenderer();
  view.update(transit, w.roads, w.heights, transit.version, w.dirty);
  const shelters = (view as unknown as { shelters: THREE.InstancedMesh }).shelters;
  assert.equal(shelters.count, 2500, `${shelters.count} shelters for 2,500 stops`);
});

test('E43: stop shelters cast shadows and are culled by camera', async () => {
  const { TransitRenderer } = await import('../src/render/transit.ts');
  const { Transit } = await import('../src/world/transit.ts');
  const w = new World();
  const transit = new Transit();
  const { id, cmd } = transit.addLine();
  cmd.apply();
  transit.addStop(id, 1000, 1000)!.apply(); transit.addStop(id, 1100, 1000)!.apply();
  const view = new TransitRenderer();
  view.update(transit, w.roads, w.heights, transit.version, w.dirty);
  const shelters = (view as unknown as { shelters: THREE.InstancedMesh }).shelters;
  assert.equal(shelters.castShadow, true, 'shelters cast a sun shadow');
  const cam = new THREE.PerspectiveCamera(50, 1, 1, 30000);
  cam.position.set(-3000, 100, -3000); cam.lookAt(-4000, 0, -4000); cam.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  assert.equal(!shelters.frustumCulled || shelters.intersectsFrustum(frustum), false, 'shelters 5 km behind the camera are drawn');
});

/** Drives a layer's fades by hand: `show(meshes)` is one frame drawing exactly those meshes at time `t` (s). */
function fadeRig() {
  const w = new World();
  const layer = new CellLayer(recordingSource(), w.dirty, Dirty.Buildings, new THREE.MeshBasicNodeMaterial(), { near: 1400, evict: 2600, margin: 40 });
  const inner = layer as unknown as { next: Set<THREE.Mesh>; applyFades(): void };
  let now = 1000;
  const realNow = performance.now.bind(performance);
  const show = (meshes: THREE.Mesh[], t: number) => {
    now = t * 1000;
    performance.now = () => now;
    try { inner.next.clear(); for (const m of meshes) inner.next.add(m); inner.applyFades(); } finally { performance.now = realNow; }
  };
  const L = inside(layer);
  const mesh = (c: number) => { L.setMesh(L.cells[0][c], triangle(), 1); return L.cells[0][c].mesh!; };
  const fade = (m: THREE.Mesh) => (m.userData as { fade: number }).fade;
  return { layer, L, show, mesh, fade };
}

test('E44: when the outgoing mesh is thrown away mid-fade, the incoming one shows whole at once', () => {
  const { L, show, mesh, fade } = fadeRig();
  const a = mesh(1), b = mesh(2);
  show([a], 10);
  show([b], 10.05); // b fades in, a fades out
  L.setMesh(L.cells[0][1], null, 0); // a is evicted mid-fade
  show([b], 10.1);
  assert.equal(fade(b), 1, `the incoming mesh is at ${fade(b).toFixed(2)}: dithered holes where the outgoing one was`);
});

test('E45: a mesh that comes back while fading out goes on from where it was', () => {
  const { show, mesh, fade } = fadeRig();
  const a = mesh(1), b = mesh(2);
  show([a], 10);
  show([b], 10.5); // a starts fading out
  show([a, b], 10.6); // a comes back 0.1 s later: it was still ~71% visible
  assert.ok(fade(a) > 0.6, `the returning mesh restarted its fade at ${fade(a).toFixed(2)} (a visible jump)`);
});

test('E46: a hidden layer keeps its meshes\' data until they are really drawn', () => {
  const { layer, show, mesh } = fadeRig();
  layer.group.visible = false; // ?semdetalhe hides the detail layer
  const a = mesh(1);
  for (let i = 0; i < 4; i++) show([a], 10 + i * 0.02);
  assert.ok((a.geometry.attributes.position.array as ArrayLike<number>).length > 0, 'the CPU copy was freed before the mesh ever reached the GPU');
});

test('E3: with the camera still and nothing arriving, the layer does not visit the map again', () => {
  const w = new World();
  const layer = new CellLayer(farSource(), w.dirty, Dirty.Buildings, new THREE.MeshBasicNodeMaterial(), { near: 1400, evict: 2600, margin: 40, detail: 650, plate: 4200 });
  let visits = 0;
  const inner = layer as unknown as { manageTile(tx: number, tz: number, n: boolean): boolean };
  const manage = inner.manageTile.bind(layer);
  inner.manageTile = (tx, tz, n) => { visits++; return manage(tx, tz, n); };
  const { camera, eye } = cornerCamera();
  for (let i = 0; i < 4; i++) layer.update(camera, eye);
  visits = 0;
  layer.update(camera, eye);
  assert.equal(visits, 0, `a still frame visited ${visits} tiles`);
});

test('E3: moving, the tiles of far plates that stand in for them are not visited', () => {
  const w = new World();
  const layer = new CellLayer(farSource(), w.dirty, Dirty.Buildings, new THREE.MeshBasicNodeMaterial(), { near: 1400, evict: 2600, margin: 40, detail: 650, plate: 4200 });
  let visits = 0;
  const inner = layer as unknown as { manageTile(tx: number, tz: number, n: boolean): boolean };
  const manage = inner.manageTile.bind(layer);
  inner.manageTile = (tx, tz, n) => { visits++; return manage(tx, tz, n); };
  const { camera, eye } = cornerCamera();
  for (let i = 0; i < 4; i++) { camera.position.x += 1; eye.x += 1; camera.updateMatrixWorld(); layer.update(camera, eye); }
  visits = 0;
  camera.position.x += 1; eye.x += 1; camera.updateMatrixWorld();
  layer.update(camera, eye);
  // the 10 km map has 100 tiles; from the corner, the plates beyond 4.6 km stand in for theirs
  assert.ok(visits < 70, `a moving frame visited ${visits} of 100 tiles`);
});

test('E30: the far trees\' photo atlas has mipmaps (no shimmer far away)', async () => {
  const imp = await import('../src/render/impostor.ts') as Record<string, unknown>;
  const make = imp.impostorTarget as ((w: number, h: number) => THREE.RenderTarget) | undefined;
  assert.ok(make, 'the atlas targets are made by one function');
  const rt = make!(1024, 256);
  assert.equal(rt.texture.generateMipmaps, true, 'mipmaps are generated after the bake');
  assert.equal(rt.texture.minFilter, THREE.LinearMipmapLinearFilter, 'minification reads the mipmaps');
});

test('E22: switching between the day and the night image starts the new one\'s history from the current frame', async () => {
  const { Post } = await import('../src/render/post.ts');
  const { nightU } = await import('../src/render/scene.ts');
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 1, 30000), sun = new THREE.DirectionalLight();
  const post = new Post(fakeRenderer(), new THREE.Scene(), camera, sun, { shadows: false, ao: false, bloom: true });
  const inner = post as unknown as { traas: Array<{ restartHistory?: boolean }>; selectOutput?(): void };
  assert.equal(typeof inner.selectOutput, 'function', 'the output is chosen in one place');
  nightU.value = 0; inner.selectOutput!();
  for (const t of inner.traas) t.restartHistory = false;
  nightU.value = 1; inner.selectOutput!(); // dusk: the night image (with bloom) takes over
  assert.equal(inner.traas[1].restartHistory, true, 'the night image\'s anti-aliasing restarts from the current frame');
  nightU.value = 0;
});

test('sky (4.0 port): at street level by day the horizon is a saturated pale blue, not white haze', async () => {
  const sc = await import('../src/render/scene.ts') as Record<string, unknown> & typeof import('../src/render/scene.ts');
  const Sky = sc.GradientSky as (new (r: number) => THREE.Mesh & { horizon: { value: THREE.Color }; low: { value: number } }) | undefined;
  assert.ok(Sky, 'a gradient sky');
  const sky = new Sky!(1);
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xffffff, 0.0001);
  scene.background = new THREE.Color();
  const parts = { sun: new THREE.DirectionalLight(), hemi: new THREE.HemisphereLight(), sky, scene, env: { update() {} } } as unknown as Parameters<typeof sc.setTimeOfDay>[0];
  sc.setTimeOfDay(parts, 11, 0.15, 0, 20);
  const fog = (scene.fog as THREE.FogExp2).color;
  assert.ok(sky.low.value > 0.9, 'the street-level horizon is on');
  assert.ok(fog.b - fog.r > 0.25 && fog.r < 0.65, `the horizon/fog at street level is r ${fog.r.toFixed(2)} g ${fog.g.toFixed(2)} b ${fog.b.toFixed(2)} (white haze before: a8c3e2)`);
});

test('shadows (4.0 port): low props cast only into the near cascade; the far cascades take the tall casters', async () => {
  const PM = await import('../src/render/propMeshes.ts') as Record<string, unknown> & typeof import('../src/render/propMeshes.ts');
  const sun = await import('../src/render/sun.ts') as Record<string, unknown>;
  const { Post } = await import('../src/render/post.ts');
  const { PROP } = await import('../src/jobs/props.ts');
  const { kinds } = PM.buildPropKinds(PM.buildPropDefs(PM.buildingPartModels()));
  const smallLayer = sun.SMALL_CASTER_LAYER as number | undefined;
  assert.equal(typeof smallLayer, 'number', 'a layer for the small casters');
  const small = PM.propIsSmallCaster as ((k: (typeof kinds)[number]) => boolean) | undefined;
  assert.ok(small, 'a rule for which props are small');
  const bench = kinds.find((k) => k.type === PROP.Bench)!, tree = kinds.find((k) => k.type === PROP.Tree)!;
  assert.equal(small!(bench), true, 'a bench (0.95 m) is a small caster');
  assert.equal(small!(tree), false, 'a tree is not');
  const renderer = fakeRenderer();
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 1, 30000), light = new THREE.DirectionalLight();
  const scene = new THREE.Scene(); scene.add(light);
  const post = new Post(renderer, scene, camera, light, { shadows: true, ao: false, bloom: false });
  const csm = post.csm as unknown as { _init(b: unknown): void; lights: Array<{ shadow: THREE.LightShadow }> };
  csm._init({ camera, renderer });
  post.setCamera(camera);
  const mesh = new THREE.Object3D(); mesh.layers.set(smallLayer!);
  assert.equal(mesh.layers.test(csm.lights[0].shadow.camera.layers), true, 'the near cascade draws the small casters');
  assert.equal(mesh.layers.test(csm.lights[1].shadow.camera.layers), false, 'the middle cascade does not');
  assert.equal(mesh.layers.test(csm.lights[2].shadow.camera.layers), false, 'the far cascade does not');
  const city = new THREE.Object3D();
  assert.equal(city.layers.test(csm.lights[2].shadow.camera.layers), true, 'the far cascade still draws the city');
});

test('GPU 100 % (2026-10-31): the far cascades keep their own layers when three draws them, so the small casters stay out', async () => {
  const sun = await import('../src/render/sun.ts') as Record<string, unknown>;
  const { Post } = await import('../src/render/post.ts');
  const smallLayer = sun.SMALL_CASTER_LAYER as number;
  const renderer = fakeRenderer();
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 1, 30000), light = new THREE.DirectionalLight();
  camera.layers.enable(smallLayer); // the views draw the small casters (cameraRig.ts)
  const scene = new THREE.Scene(); scene.add(light);
  const post = new Post(renderer, scene, camera, light, { shadows: true, ao: false, bloom: false });
  const csm = post.csm as unknown as { _init(b: unknown): void; lights: Array<{ shadow: THREE.LightShadow }> };
  csm._init({ camera, renderer });
  post.setCamera(camera);
  // three r186 ShadowNode.updateShadow (ShadowNode.js:677): a shadow camera holding nothing but layer 0 is drawn with the
  // view camera's layers, the small casters' among them
  const drawn = (shadowCam: THREE.Camera): number => ((shadowCam.layers.mask & 0xFFFFFFFE) === 0 ? camera.layers.mask : shadowCam.layers.mask);
  const small = 1 << smallLayer;
  assert.notEqual(drawn(csm.lights[0].shadow.camera) & small, 0, 'the near cascade draws the small casters');
  assert.equal(drawn(csm.lights[1].shadow.camera) & small, 0, 'the middle cascade does not');
  assert.equal(drawn(csm.lights[2].shadow.camera) & small, 0, 'the far cascade does not');
  assert.notEqual(drawn(csm.lights[2].shadow.camera) & 1, 0, 'the far cascade still draws the city (layer 0)');
});

test('GPU 100 % (2026-10-31): of the 4.0 building parts only the boxes and the lot pieces cast, read by the kind\'s type, not its index', async () => {
  const PM = await import('../src/render/propMeshes.ts') as Record<string, unknown> & typeof import('../src/render/propMeshes.ts');
  const { PART_PROP } = await import('../src/jobs/parts40.ts');
  const { PROP, FURN } = await import('../src/jobs/props.ts');
  const { kinds, kindOf } = PM.buildPropKinds(PM.buildPropDefs(PM.buildingPartModels()));
  const casts = PM.propKindCasts as ((k: (typeof kinds)[number], index: number) => boolean) | undefined;
  assert.ok(casts, 'one rule for whether a kind casts, read by the renderer');
  const thin: number[] = [PART_PROP.BFrame, PART_PROP.BRail, PART_PROP.BMisc, PART_PROP.BPropA, PART_PROP.BPropB];
  const wrong: string[] = [];
  kinds.forEach((k, i) => { if (thin.includes(k.type) && casts!(k, i)) wrong.push(`kind ${i} (part type ${k.type})`); });
  assert.deepEqual(wrong, [], 'thin building parts (frames, railings, doors, small parts) drawn into the shadow cascades');
  const box = kinds.findIndex((k) => k.type === PART_PROP.BBox), lot = kinds.findIndex((k) => k.type === PART_PROP.BLot);
  assert.ok(casts!(kinds[box], box), 'the boxes (sills, fins, shutters) cast');
  assert.ok(casts!(kinds[lot], lot), 'the lot pieces cast');
  const roofAc = kindOf[PROP.Furniture * PM.VARIANTS + FURN.RoofAc];
  assert.ok(casts!(kinds[roofAc], roofAc), `a rooftop condenser (kind ${roofAc}) casts`);
});

test('GPU 100 % (2026-10-31): a box part (sill, shutter, fin, lamp) draws one box, its own colour in the instance', async () => {
  const PM = await import('../src/render/propMeshes.ts') as Record<string, unknown> & typeof import('../src/render/propMeshes.ts');
  const P40 = await import('../src/jobs/parts40.ts') as Record<string, unknown> & typeof import('../src/jobs/parts40.ts');
  const { kinds } = PM.buildPropKinds(PM.buildPropDefs(PM.buildingPartModels()));
  const box = kinds.filter((k) => k.type === P40.PART_PROP.BBox);
  assert.equal(box.length, 1, 'one kind draws the box parts');
  const tris = (box[0].lods[0]!.attributes.position.count) / 3;
  assert.equal(tris, 12, `a box part draws ${tris} triangles (the four kinds' boxes merged one over another drew 48)`);
  const tint = P40.poolTint as ((kind: string, rgb: number) => number) | undefined;
  assert.ok(tint, 'the instance carries its kind\'s colour');
  assert.equal(tint!('concrete', 0xffffff), 0xcfc9bd, 'a concrete sill keeps the kit\'s concrete colour');
  assert.equal(tint!('shutter', 0xffffff), 0x9aa1a4, 'a shutter keeps the kit\'s shutter colour');
  assert.equal(tint!('frame', 0x123456), 0x123456, 'a part with a model of its own keeps its tint');
});

test('GPU 100 % (2026-10-31): the 4.0 parts carry their size rules: bars, and a lot part\'s top as its far level', async () => {
  const PM = await import('../src/render/propMeshes.ts') as Record<string, unknown> & typeof import('../src/render/propMeshes.ts');
  const { PART_PROP } = await import('../src/jobs/parts40.ts');
  const { kinds } = PM.buildPropKinds(PM.buildPropDefs(PM.buildingPartModels()));
  type K = (typeof kinds)[number] & { part?: { extent: number[]; pieces: number[][]; topLevel: boolean } };
  const parts = (kinds as K[]).filter((k) => k.type >= PART_PROP.BFrame);
  assert.ok(parts.every((k) => !k.lods[0] || k.part), 'every building part kind has its size rules');
  const frame = (kinds as K[]).find((k) => k.type === PART_PROP.BFrame)!;
  assert.equal(frame.part?.pieces.length, 2, 'a frame is judged by its bars (rails and stiles)');
  const rail = (kinds as K[]).find((k) => k.type === PART_PROP.BRail)!;
  assert.equal(rail.part?.pieces.length, 3, 'a railing by its rails and balusters');
  const lots = (kinds as K[]).filter((k) => k.type === PART_PROP.BLot && k.lods[0]);
  assert.equal(lots.length, 3, 'a lot\'s box, rail and slab');
  for (const k of lots) {
    assert.ok(k.part?.topLevel && k.lods[1], 'a lot part has its top as its far level');
    const near = k.lods[0]!.attributes.position.count / 3, far = k.lods[1]!.attributes.position.count / 3;
    assert.ok(far < near, `its top draws fewer triangles (${far} < ${near})`);
  }
});

test('GPU 100 % (2026-10-31): a cascade keeps its still casters and draws only the movers over them while it stays put', async () => {
  const { Post } = await import('../src/render/post.ts');
  const sun = await import('../src/render/sun.ts') as unknown as Record<string, number>;
  const renderer = fakeRenderer();
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 1, 30000), light = new THREE.DirectionalLight();
  const scene = new THREE.Scene(); scene.add(light);
  const post = new Post(renderer, scene, camera, light, { shadows: true, ao: false, bloom: false });
  const csm = post.csm as unknown as { _init(b: unknown): void; lights: Array<THREE.DirectionalLight & { shadow: THREE.LightShadow }>; _shadowNodes: Array<Record<string, unknown> & { renderShadow(f: unknown): void }> };
  csm._init({ camera, renderer });
  post.setCamera(camera);
  const l = csm.lights[0];
  l.position.set(0, 100, 0); l.target.position.set(10, 0, 0); l.updateMatrixWorld(); l.target.updateMatrixWorld();
  const node = csm._shadowNodes[0];
  const map = { setSize() { /* fixed */ }, depth: 1, depthTexture: new THREE.DepthTexture(2048, 2048) };
  node.shadowMap = map;
  const calls: string[] = [];
  const r = {
    autoClear: true,
    render: (_s: unknown, cam: THREE.Camera) => calls.push(`render ${(cam.layers.mask & sun.MOVER_BITS) === cam.layers.mask ? 'movers' : (cam.layers.mask & sun.MOVER_BITS) === 0 ? 'still' : 'mixed'} clear=${r.autoClear}`),
    copyTextureToTexture: (a: unknown) => calls.push(a === map.depthTexture ? 'copy map>store' : 'copy store>map'),
  };
  assert.equal(typeof node.renderShadow, 'function', 'the cascade draws through its own renderShadow');
  node.renderShadow({ renderer: r, scene: new THREE.Scene() });
  assert.deepEqual(calls, ['render still clear=true', 'copy map>store', 'render movers clear=false'], 'first frame: the still casters, kept, the movers over them');
  calls.length = 0;
  node.renderShadow({ renderer: r, scene: new THREE.Scene() });
  assert.deepEqual(calls, ['copy store>map', 'render movers clear=false'], 'the cascade stayed put: its still casters come from the store');
  calls.length = 0;
  post.invalidateShadows(); post.prepareShadows(true);
  node.renderShadow({ renderer: r, scene: new THREE.Scene() });
  assert.deepEqual(calls[0], 'render still clear=true', 'something casting changed: the still casters drawn again');
});

test('E23: an object moved by its matrix has the previous frame\'s matrix in its velocity', async () => {
  const vel = await import('../src/render/velocity.ts') as Record<string, unknown>;
  const prev = vel.previousModelMatrix as ((o: THREE.Object3D, frameId: number) => THREE.Matrix4) | undefined;
  assert.ok(prev, 'the velocity reads a previous model matrix per object');
  const box = new THREE.Mesh();
  box.updateMatrixWorld();
  prev!(box, 10);
  box.scale.y = 0.5; box.updateMatrixWorld(); // the collapse animation shrinks it
  const p = prev!(box, 11);
  assert.equal(p.elements[5], 1, 'frame 11 sees frame 10\'s matrix (scale 1)');
  assert.equal(prev!(box, 11).elements[5], 1, 'the shadow passes of frame 11 see the same');
  box.scale.y = 0.25; box.updateMatrixWorld();
  assert.equal(prev!(box, 30).elements[5], 0.25, 'after frames not drawn it starts still (no jump)');
});

test('level of detail by the 3D distance: a camera 300 m over a cell does not draw its near detail', () => {
  const w = new World();
  const src = { ...recordingSource(), buildCell(c: number, level: number, _p: number, done: (m: PackedMesh | null) => void) { src.cells.push({ c, level, done }); } };
  const layer = new CellLayer(src, w.dirty, Dirty.Buildings, new THREE.MeshBasicNodeMaterial(), { near: 1100, evict: 1400, margin: 30, detail: 220, sparse: true });
  (layer as unknown as { groundAt: (x: number, z: number) => number }).groundAt = () => 0;
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 1, 30000);
  const eye = new THREE.Vector3(10, 320, 10);
  camera.position.copy(eye); camera.lookAt(300, 0, 300); camera.updateMatrixWorld();
  layer.update(camera, eye);
  const fine = src.cells.filter((r) => r.level === 0).length;
  assert.equal(fine, 0, `${fine} cells asked at the near level 320 m up`);
});

test('a near-level mesh is not drawn in place of a far level that is built and empty (the detail layer from far)', () => {
  const w = new World();
  const src = recordingSource();
  const layer = new CellLayer(src, w.dirty, Dirty.Buildings, new THREE.MeshBasicNodeMaterial(), { near: 1100, evict: 1400, margin: 30, detail: 220, sparse: true });
  const L = inside(layer) as LayerInside & { cellVer: Uint32Array; cellFine: Uint8Array };
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 1, 30000);
  const eye = new THREE.Vector3(-5120 + 128, 600, -5120 + 600);
  camera.position.copy(eye); camera.lookAt(-5120 + 128, 0, -5120 + 128); camera.updateMatrixWorld();
  const c = 0;
  L.setMesh(L.cells[0][c], { ...triangle(), originX: -5120, originZ: -5120 }, L.cellVer[c]);
  L.setMesh(L.cells[1][c], null, L.cellVer[c]); // the far level: built, nothing to draw
  layer.update(camera, eye);
  assert.ok(!layer.group.children.includes(L.cells[0][c].mesh!), 'the near level was drawn for the empty far one');
});

test('the shadows fade out at the far end of their reach (no straight line across the ground)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync('src/render/post.ts', 'utf8');
  assert.ok(/class FadingCSM extends CSMShadowNode/.test(src) && src.includes('new FadingCSM('), 'the sun uses cascades that fade at their far end');
});

test('vehicles: the glass is split from the opaque body for the transparent cabin draw', () => {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(18), nrm = new Float32Array(18), col = new Float32Array(18), paint = new Float32Array(6), limb = new Float32Array(6);
  for (let i = 0; i < 6; i++) { pos[i * 3] = i; nrm[i * 3 + 1] = 1; col[i * 3] = 1; }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('paint', new THREE.BufferAttribute(paint, 1));
  g.setAttribute('limb', new THREE.BufferAttribute(limb, 1));
  g.setAttribute('glow', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 5, 5, 5]), 1));
  const { solid, glass } = splitGlass(g);
  assert.equal(solid.getAttribute('position').count, 3, 'the opaque body keeps one triangle');
  assert.ok(glass && glass.getAttribute('position').count === 3, 'the glass keeps the other triangle');
  assert.equal(solid.getAttribute('glow').getX(0), 0);
  assert.equal(glass!.getAttribute('glow').getX(0), 5);
});

test('cars: from above, the road never shows through the near car\'s glass (the cabin fills the body)', async () => {
  const { CAR_SIZES, buildCarBody } = await import('../src/render/carBody.ts');
  const { buildCarCabin } = await import('../src/render/carCabin.ts');
  // the triangles of a geometry, and the heights where a vertical ray at (x, z) crosses them
  const tris = (g: THREE.BufferGeometry): number[][] => {
    const p = g.getAttribute('position').array, idx = g.index?.array, n = idx ? idx.length : p.length / 3, out: number[][] = [];
    for (let i = 0; i < n; i += 3) {
      const v = [idx ? idx[i] : i, idx ? idx[i + 1] : i + 1, idx ? idx[i + 2] : i + 2];
      out.push(v.flatMap((k) => [p[k * 3], p[k * 3 + 1], p[k * 3 + 2]]));
    }
    return out;
  };
  const top = (T: number[][], x: number, z: number): number => {
    let y = -Infinity;
    for (const [ax, ay, az, bx, by, bz, cx, cy, cz] of T) {
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-12) continue;
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      if (l1 >= 0 && l2 >= 0 && l1 + l2 <= 1) y = Math.max(y, l1 * ay + l2 * by + (1 - l1 - l2) * cy);
    }
    return y;
  };
  for (const style of ['sedan', 'hatch', 'suv', 'van', 'pickup'] as const) {
    const a = CAR_SIZES[style], b = buildCarBody(a, style, 24, 8, 3);
    const solid = [...tris(b.shell), ...tris(b.trim), ...tris(buildCarCabin(a, style))], glass = tris(b.glass);
    let underGlass = 0, road = 0;
    for (let i = 0; i < 40; i++) for (let j = 0; j < 14; j++) {
      const x = -a.length / 2 + (i + 0.5) * a.length / 40, z = -a.width / 2 + (j + 0.5) * a.width / 14;
      const g = top(glass, x, z), s = top(solid, x, z);
      if (g <= s) continue;
      underGlass++;
      // under the glass something stops the eye above the road (the floor is at 0.24-0.4 m)
      if (top(solid.filter((t) => Math.max(t[1], t[4], t[7]) < g - 0.02), x, z) < 0.18) road++;
    }
    assert.ok(underGlass > 20, `${style}: glass seen from above at ${underGlass} points`);
    assert.equal(road, 0, `${style}: the road shows through the glass at ${road} of ${underGlass} points`);
  }
});

test('cars: seen at a slant through the glass, the near car is closed (cabin, and its body\'s inner side drawn)', async () => {
  const { CAR_SIZES, buildCarBody } = await import('../src/render/carBody.ts');
  const { buildCarCabin } = await import('../src/render/carCabin.ts');
  const flat = (g: THREE.BufferGeometry): Float64Array => {
    const p = g.getAttribute('position').array, idx = g.index?.array, n = idx ? idx.length : p.length / 3, out = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) { const k = idx ? idx[i] : i; out[i * 3] = p[k * 3]; out[i * 3 + 1] = p[k * 3 + 1]; out[i * 3 + 2] = p[k * 3 + 2]; }
    return out;
  };
  // nearest hit of a ray on a triangle list (Möller–Trumbore), either side: the near body is drawn on both sides
  const nearest = (T: Float64Array, o: number[], d: number[]): number => {
    let best = Infinity;
    for (let i = 0; i < T.length; i += 9) {
      const e1 = [T[i + 3] - T[i], T[i + 4] - T[i + 1], T[i + 5] - T[i + 2]], e2 = [T[i + 6] - T[i], T[i + 7] - T[i + 1], T[i + 8] - T[i + 2]];
      const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
      const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
      if (Math.abs(det) < 1e-12) continue;
      const t0 = [o[0] - T[i], o[1] - T[i + 1], o[2] - T[i + 2]];
      const u = (t0[0] * p[0] + t0[1] * p[1] + t0[2] * p[2]) / det; if (u < 0 || u > 1) continue;
      const q = [t0[1] * e1[2] - t0[2] * e1[1], t0[2] * e1[0] - t0[0] * e1[2], t0[0] * e1[1] - t0[1] * e1[0]];
      const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det; if (v < 0 || u + v > 1) continue;
      const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
      if (t > 1e-4 && t < best) best = t;
    }
    return best;
  };
  for (const style of ['sedan', 'hatch', 'suv', 'van', 'pickup'] as const) {
    const a = CAR_SIZES[style], b = buildCarBody(a, style, 24, 8, 3);
    const solid = new Float64Array([...flat(b.shell), ...flat(b.trim), ...flat(buildCarCabin(a, style))]), glass = flat(b.glass);
    let through = 0, road = 0;
    for (let pitch = 20; pitch <= 80; pitch += 30) for (let yaw = 0; yaw < 360; yaw += 45) {
      const pr = pitch * Math.PI / 180, yr = yaw * Math.PI / 180, d = [-Math.cos(pr) * Math.cos(yr), -Math.sin(pr), -Math.cos(pr) * Math.sin(yr)];
      for (let i = 0; i < 12; i++) for (let j = 0; j < 5; j++) {
        const x = -a.length / 2 + (i + 0.5) * a.length / 12, z = -a.width / 2 + (j + 0.5) * a.width / 5, y = a.height * 0.75;
        const o = [x - d[0] * 10, y - d[1] * 10, z - d[2] * 10];
        const tg = nearest(glass, o, d), ts = nearest(solid, o, d);
        if (!(tg < ts)) continue;
        through++;
        // past the glass: some part of the car before the road (y = 0) under it
        const o2 = [o[0] + d[0] * tg, o[1] + d[1] * tg, o[2] + d[2] * tg];
        const t2 = nearest(solid, o2, d), tRoad = -o2[1] / d[1];
        const gx = o2[0] + d[0] * tRoad, gz = o2[2] + d[2] * tRoad;
        if (!(t2 < tRoad) && Math.abs(gx) < a.length / 2 && Math.abs(gz) < a.width / 2) road++;
      }
    }
    assert.ok(through > 50, `${style}: rays through the glass ${through}`);
    assert.equal(road, 0, `${style}: ${road} of ${through} slanting rays through the glass reach the road under the car`);
  }
});

test('cars: every level of a car is built facing outward (the far silhouette was inside out: a car seen on its side)', async () => {
  const { CAR_SIZES, buildCarBody, buildCarSilhouette } = await import('../src/render/carBody.ts');
  const { buildCarCabin } = await import('../src/render/carCabin.ts');
  // rays from all round; the first triangle each meets must face it (met from behind, the GPU culls it)
  const backShare = (g: THREE.BufferGeometry): number => {
    const p = g.getAttribute('position').array, idx = g.index?.array, n = idx ? idx.length : p.length / 3;
    const T = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) { const k = idx ? idx[i] : i; T[i * 3] = p[k * 3]; T[i * 3 + 1] = p[k * 3 + 1]; T[i * 3 + 2] = p[k * 3 + 2]; }
    g.computeBoundingBox();
    const b = g.boundingBox!;
    let hits = 0, back = 0;
    for (let pitch = 10; pitch <= 70; pitch += 30) for (let yaw = 0; yaw < 360; yaw += 45) {
      const pr = pitch * Math.PI / 180, yr = yaw * Math.PI / 180, d = [-Math.cos(pr) * Math.cos(yr), -Math.sin(pr), -Math.cos(pr) * Math.sin(yr)];
      for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) {
        // (off the stations: a ray exactly on the edge two triangles share can miss both in floating point)
        const tx = b.min.x + (i + 0.43) * (b.max.x - b.min.x) / 6, tz = b.min.z + (j + 0.57) * (b.max.z - b.min.z) / 4, ty = (b.min.y + b.max.y) / 2;
        const o = [tx - d[0] * 50, ty - d[1] * 50, tz - d[2] * 50];
        let best = Infinity, face = 0;
        for (let k = 0; k < T.length; k += 9) {
          const e1 = [T[k + 3] - T[k], T[k + 4] - T[k + 1], T[k + 5] - T[k + 2]], e2 = [T[k + 6] - T[k], T[k + 7] - T[k + 1], T[k + 8] - T[k + 2]];
          const q = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
          const det = e1[0] * q[0] + e1[1] * q[1] + e1[2] * q[2];
          if (Math.abs(det) < 1e-12) continue;
          const s = [o[0] - T[k], o[1] - T[k + 1], o[2] - T[k + 2]];
          const u = (s[0] * q[0] + s[1] * q[1] + s[2] * q[2]) / det; if (u < 0 || u > 1) continue;
          const r = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
          const v = (d[0] * r[0] + d[1] * r[1] + d[2] * r[2]) / det; if (v < 0 || u + v > 1) continue;
          const t = (e2[0] * r[0] + e2[1] * r[1] + e2[2] * r[2]) / det;
          if (t > 1e-4 && t < best) { best = t; face = (e1[1] * e2[2] - e1[2] * e2[1]) * d[0] + (e1[2] * e2[0] - e1[0] * e2[2]) * d[1] + (e1[0] * e2[1] - e1[1] * e2[0]) * d[2]; }
        }
        if (best < Infinity) { hits++; if (face > 0) back++; }
      }
    }
    return back / Math.max(1, hits);
  };
  for (const style of ['sedan', 'hatch', 'suv', 'van', 'pickup'] as const) {
    const a = CAR_SIZES[style], b = buildCarBody(a, style, 24, 8, 3);
    for (const [part, g] of [['silhouette', buildCarSilhouette(a, style)], ['far', b.far], ['trim', b.trim], ['cabin', buildCarCabin(a, style)]] as const) {
      const share = backShare(g);
      assert.ok(share < 0.03, `${style} ${part}: ${(share * 100).toFixed(0)}% of what is seen from outside is a face's back`);
    }
  }
});

test('cars: lamps and plates lie on the body (boxes stood out of the rounded corners by up to 15 cm)', async () => {
  const { CAR_SIZES, buildCarBody } = await import('../src/render/carBody.ts');
  for (const style of ['sedan', 'hatch', 'suv', 'van', 'pickup'] as const) {
    const b = buildCarBody(CAR_SIZES[style], style, 24, 8, 3);
    // the body's surface: triangles of shell and glass
    const tris: number[][] = [];
    for (const g of [b.shell, b.glass]) {
      const p = g.getAttribute('position').array, idx = g.index?.array, n = idx ? idx.length : p.length / 3;
      for (let i = 0; i < n; i += 3) tris.push([0, 1, 2].flatMap((k) => { const v = idx ? idx[i + k] : i + k; return [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]]; }));
    }
    // the x of the surface at (y, z) nearest to x0 (a ray along the length)
    const nearestX = (x0: number, y: number, z: number): number => {
      let best = Infinity;
      for (const [ax, ay, az, bx, by, bz, cx, cy, cz] of tris) {
        const d = (by - cy) * (az - cz) + (cz - bz) * (ay - cy);
        if (Math.abs(d) < 1e-12) continue;
        const l1 = ((by - cy) * (z - cz) + (cz - bz) * (y - cy)) / d, l2 = ((cy - ay) * (z - cz) + (az - cz) * (y - cy)) / d;
        if (l1 < 0 || l2 < 0 || l1 + l2 > 1) continue;
        const x = l1 * ax + l2 * bx + (1 - l1 - l2) * cx;
        if (Math.abs(x - x0) < Math.abs(best - x0)) best = x;
      }
      return best;
    };
    for (const l of [...b.headlamps, ...b.taillamps, ...b.indicators, ...b.plates]) {
      assert.ok(l.face, `${style}: a lamp without its face`);
      const p = l.face.getAttribute('position').array;
      assert.equal(p.length / 9, 16, `${style}: lamp at ${l.x.toFixed(2)},${l.z.toFixed(2)} lost cells off the body`);
      for (let i = 0; i < p.length; i += 3) {
        const off = Math.abs(p[i] - nearestX(p[i], p[i + 1], p[i + 2]));
        assert.ok(off < 0.01, `${style}: a lamp corner ${(off * 100).toFixed(1)} cm off the body`);
      }
    }
  }
});

/** Whether triangle (a, b, c) overlaps the box centred at `m` with half sizes `h` (separating axes, Akenine-Möller). */
function triBox(t: number[], m: number[], h: number[]): boolean {
  const v = [0, 1, 2].map((k) => [t[3 * k] - m[0], t[3 * k + 1] - m[1], t[3 * k + 2] - m[2]]);
  const e = [0, 1, 2].map((k) => [0, 1, 2].map((j) => v[(k + 1) % 3][j] - v[k][j]));
  const sep = (ax: number[]): boolean => {
    const p = v.map((w) => w[0] * ax[0] + w[1] * ax[1] + w[2] * ax[2]);
    const r = h[0] * Math.abs(ax[0]) + h[1] * Math.abs(ax[1]) + h[2] * Math.abs(ax[2]);
    return Math.min(...p) > r - 1e-6 || Math.max(...p) < -r + 1e-6;
  };
  for (const ed of e) for (const u of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
    const ax = [u[1] * ed[2] - u[2] * ed[1], u[2] * ed[0] - u[0] * ed[2], u[0] * ed[1] - u[1] * ed[0]];
    if (Math.hypot(...ax) > 1e-9 && sep(ax)) return false;
  }
  for (const u of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) if (sep(u)) return false;
  const n = [e[0][1] * e[1][2] - e[0][2] * e[1][1], e[0][2] * e[1][0] - e[0][0] * e[1][2], e[0][0] * e[1][1] - e[0][1] * e[1][0]];
  return !(Math.hypot(...n) > 1e-12 && sep(n));
}

test('cars: the cabin stays clear of the wheels (its door trim stood in the rear arch, over the wheel)', async () => {
  const { CAR_SIZES, axlesOf } = await import('../src/render/carBody.ts');
  const { buildCarCabin } = await import('../src/render/carCabin.ts');
  for (const style of ['sedan', 'hatch', 'suv', 'van', 'pickup'] as const) {
    const a = CAR_SIZES[style], g = buildCarCabin(a, style), archR = a.wheelRadius + 0.07;
    const p = g.getAttribute('position').array, idx = g.index ? g.index.array : null;
    const n = idx ? idx.length : p.length / 3;
    // the wheel's space: the arch's reach along the length, below its top, out where the tyre is (each side)
    const inner = a.width / 2 - a.width * 0.14 - 0.05, outer = a.width / 2 + 0.3, topY = 2 * a.wheelRadius + 0.07;
    let inside = 0;
    for (let k = 0; k < n; k += 3) {
      const t: number[] = [];
      for (let j = 0; j < 3; j++) { const i = idx ? idx[k + j] : k + j; t.push(p[3 * i], p[3 * i + 1], p[3 * i + 2]); }
      for (const ax of axlesOf(a)) for (const sd of [-1, 1]) {
        if (triBox(t, [ax, topY / 2 - 0.5, sd * (inner + outer) / 2], [archR, topY / 2 + 0.5, (outer - inner) / 2])) inside++;
      }
    }
    assert.equal(inside, 0, `${style}: ${inside} cabin triangles in a wheel's space`);
  }
});

test('D53: reset uninstalls through the source every cell that held a mesh (the seams clear their terrain holes)', () => {
  const w = new World();
  const uninstalled: Array<[number, number]> = [];
  const src = { ...recordingSource(), installed: (c: number, level: number, m: PackedMesh | null) => { if (m === null) uninstalled.push([c, level]); } };
  const layer = new CellLayer(src, w.dirty, Dirty.Buildings, new THREE.MeshBasicNodeMaterial(), { near: 1400, evict: 2600, margin: 40 });
  const L = layer as unknown as { cells: Slot[][]; setMesh(s: Slot, m: PackedMesh | null, v: number, cell: number, level: number): void };
  L.setMesh(L.cells[0][9], triangle(), 1, 9, 0);
  uninstalled.length = 0;
  layer.reset();
  assert.deepEqual(uninstalled, [[9, 0]]);
});

test('D52: thousands of explosion bursts keep a fixed pool; the newest stay', async () => {
  const { Particles } = await import('../src/render/particles.ts');
  const w = new World();
  const p = new Particles(w);
  for (let i = 0; i < 10_000; i++) p.burst(i % 100, 10, 0, 1, 3, 5 + i * 1e-4);
  const inner = p as unknown as { burstN?: number; bursts: ArrayLike<unknown> };
  const held = inner.burstN ?? inner.bursts.length;
  assert.ok(held <= 128, `${held} bursts held`);
  p.update(1, new THREE.Vector3(0, 50, 0));
  assert.ok(p.count <= 512);
});

test('D40: a layer visits only the tiles within its reach, not the whole map, when the camera moves', () => {
  const w = new World();
  const src = recordingSource();
  // far 1500 m: the layer asks for, draws and evicts nothing farther than its reach (about 3 km here: a rectangle of
  // at most 7 x 7 tiles round the camera on the 10 km map's 100)
  const layer = new CellLayer(src, w.dirty, Dirty.Buildings, new THREE.MeshBasicNodeMaterial(), { near: 1400, evict: 2600, margin: 40, far: 1500 });
  const cam = new THREE.PerspectiveCamera(45, 1, 1, 1e5);
  cam.position.set(0, 300, 0); cam.lookAt(100, 0, 0); cam.updateMatrixWorld(true); cam.updateProjectionMatrix();
  layer.update(cam, cam.position);
  const total = TILE_COUNT;
  assert.ok(layer.visited > 0 && layer.visited <= 49 && layer.visited < total, `visited ${layer.visited} of ${total} tiles`);
  // the camera moves 100 m: the visit stays bounded (the still-frame gate is not what keeps it small)
  cam.position.set(100, 300, 0); cam.updateMatrixWorld(true);
  layer.update(cam, cam.position);
  assert.ok(layer.visited <= 49, `visited ${layer.visited} after a move`);
});

test('TRAA: the history read through Catmull-Rom keeps its detail when read again every frame (walkers went soft)', async () => {
  const { catmullRomTaps } = await import('../src/render/traa.ts');
  // numbers with the node methods the taps use
  class Num {
    readonly v: number;
    constructor(v: number) { this.v = v; }
    private n(o: Num | number) { return typeof o === 'number' ? o : o.v; }
    mul(o: Num | number) { return new Num(this.v * this.n(o)); }
    add(o: Num | number) { return new Num(this.v + this.n(o)); }
    sub(o: Num | number) { return new Num(this.v - this.n(o)); }
    div(o: Num | number) { return new Num(this.v / this.n(o)); }
  }
  // on a texel nothing changes: the read lands on it alone
  const still = catmullRomTaps(new Num(0));
  assert.deepEqual([still.w0.v, still.w12.v, still.w3.v, still.at12.v].map((v) => v + 0), [0, 1, 0, 0]);
  // a periodic row of 3-pixel bars; texel centres at i + ½; a bilinear read between texels, as the GPU does
  const W = 64, row: number[] = Array.from({ length: W }, (_, i) => (i % 11 < 3 ? 1 : 0.1));
  const texel = (s: number[], i: number) => s[((i % W) + W) % W];
  const bilinear = (s: number[], p: number) => { const a = Math.floor(p - 0.5), t = p - 0.5 - a; return texel(s, a) * (1 - t) + texel(s, a + 1) * t; };
  const catmull = (s: number[], p: number) => {
    const t1 = Math.floor(p - 0.5) + 0.5, { w0, w12, w3, at12 } = catmullRomTaps(new Num(p - t1));
    return bilinear(s, t1 - 1) * w0.v + bilinear(s, t1 + at12.v) * w12.v + bilinear(s, t1 + 2) * w3.v;
  };
  // the survey's fig. 8 worst case: the history moves half a pixel every frame, 100 frames
  const energy = (s: number[]) => s.reduce((e, v, i) => e + (texel(s, i + 1) - v) ** 2, 0);
  const moved = (read: (s: number[], p: number) => number) => {
    let s = row;
    for (let k = 0; k < 100; k++) s = s.map((_, i) => read(s, i + 0.5 - 0.5));
    return energy(s) / energy(row);
  };
  const bl = moved(bilinear), cr = moved(catmull);
  // bilinear wipes the bars out (1e-4 of their detail left); Catmull-Rom keeps two orders of magnitude more (0.13)
  assert.ok(cr > 100 * bl, `detail kept after 100 half-pixel reads: Catmull-Rom ${cr.toExponential(2)}, bilinear ${bl.toExponential(2)}`);
});

/// <reference types="node" />
// Regression tests for the drawing defects (section E of DEFEITOS-roadcraft-novo.md), one test per defect id. Each one
// failed on the code before its fix (the commit that fixed it quotes the result before and after).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { World } from '../src/world/world.ts';
import { CellLayer, type LayerSource } from '../src/render/cellLayer.ts';
import { Dirty } from '../src/core/grid.ts';
import type { PackedMesh } from '../src/jobs/protocol.ts';

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
    assert.equal(count('RTTNode'), 2, 'the two copies of the image fed to the anti-aliasing freed');
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

test('E5, E25: each prop draw carries one variant only (a hydrant does not process the vertices of 13 other pieces)', async () => {
  const PM = await import('../src/render/propMeshes.ts') as Record<string, unknown> & typeof import('../src/render/propMeshes.ts');
  const { PROP } = await import('../src/jobs/props.ts');
  const defs = PM.buildPropDefs();
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
  const { kinds } = PM.buildPropKinds(PM.buildPropDefs());
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
  const { kinds } = PM.buildPropKinds(PM.buildPropDefs());
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
  assert.ok(layer.group.children.includes(L.cells[0][c].mesh!), 'the tower west of the view, whose shadow falls into it, is a shadow caster');
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

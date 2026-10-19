/// <reference types="node" />
// Terrain and water drawing defects on the 24 km map (section E of DEFEITOS-roadcraft-novo.md). The map size is read
// when config.ts loads, so this file sets it before importing anything of the game (each test file is its own process).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';

(globalThis as { location?: unknown }).location = { search: '?mapa=24' };
const { MAP_SIZE } = await import('../src/config.ts');
const { World } = await import('../src/world/world.ts');
const { TerrainRenderer } = await import('../src/render/terrain.ts');

/** A camera at the map's centre, 200 m up, looking north (−z). */
function centreCamera(): { camera: THREE.PerspectiveCamera; eye: THREE.Vector3 } {
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 1, 60000);
  const eye = new THREE.Vector3(0, 200, 0);
  camera.position.copy(eye); camera.lookAt(0, 0, -1000); camera.updateMatrixWorld();
  return { camera, eye };
}

test('E34: on the 24 km map no terrain patch behind the camera is drawn', () => {
  assert.equal(MAP_SIZE, 24 * 1024);
  const w = new World();
  w.tileMin.fill(0); w.tileMax.fill(50);
  const terrain = new TerrainRenderer(w);
  const { camera, eye } = centreCamera();
  terrain.update(camera, eye);
  const inner = terrain as unknown as { count: number; instArray: Float32Array };
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const behind: string[] = [];
  for (let i = 0; i < inner.count; i++) {
    const [x, z, size] = inner.instArray.subarray(i * 4, i * 4 + 3);
    const box = new THREE.Box3(new THREE.Vector3(x, 0, z), new THREE.Vector3(x + size, 50, z + size));
    if (!frustum.intersectsBox(box)) behind.push(`${size} m patch at ${x}, ${z}`);
  }
  assert.deepEqual(behind.slice(0, 5), [], `${behind.length} of ${inner.count} patches are outside the view`);
});

test('E33: water is drawn only on the tiles in view, with a coarse grid far away', async () => {
  const { MAP_TILES, TILE_SIZE } = await import('../src/config.ts');
  const w = new World();
  w.tileMin.fill(0); w.tileMax.fill(50);
  // a long river: water on every tile of the map
  w.tileWater.fill(1);
  for (let t = 0; t < MAP_TILES * MAP_TILES; t++) w.waterDirty.add(t);
  const terrain = new TerrainRenderer(w);
  terrain.uploadDirtyLayers();
  const { camera, eye } = centreCamera();
  terrain.update(camera, eye);
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const meshes = [terrain.waterMesh, ...((terrain as unknown as { waterFar?: THREE.Mesh }).waterFar ? [(terrain as unknown as { waterFar: THREE.Mesh }).waterFar] : [])];
  let tris = 0;
  const outside: number[] = [];
  for (const m of meshes) {
    const g = m.geometry as THREE.InstancedBufferGeometry;
    const tiles = g.attributes.wtile as THREE.InstancedBufferAttribute;
    for (let i = 0; i < g.instanceCount; i++) {
      const t = tiles.getX(i), tx = t % MAP_TILES, tz = Math.floor(t / MAP_TILES);
      const x = tx * TILE_SIZE - MAP_TILES * TILE_SIZE / 2, z = tz * TILE_SIZE - MAP_TILES * TILE_SIZE / 2;
      if (!frustum.intersectsBox(new THREE.Box3(new THREE.Vector3(x, -10, z), new THREE.Vector3(x + TILE_SIZE, 60, z + TILE_SIZE)))) outside.push(t);
    }
    tris += g.instanceCount * g.index!.count / 3;
  }
  assert.deepEqual(outside.slice(0, 5), [], `${outside.length} water tiles drawn outside the view`);
  assert.ok(tris < 2e6, `${(tris / 1e6).toFixed(1)} M water triangles for one river`);
});

test('E36: the terrain casts sun shadows round the camera, seen only by the shadow cascades', async () => {
  const sunMod = await import('../src/render/sun.ts') as Record<string, unknown>;
  const { Post } = await import('../src/render/post.ts');
  const w = new World();
  w.tileMin.fill(0); w.tileMax.fill(300);
  const terrain = new TerrainRenderer(w);
  const { camera, eye } = centreCamera();
  terrain.update(camera, eye);
  const casters: THREE.Mesh[] = [];
  terrain.mesh.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.castShadow && (m.geometry as THREE.InstancedBufferGeometry).instanceCount > 0) casters.push(m); });
  if (terrain.mesh.castShadow) casters.push(terrain.mesh);
  for (const m of [(terrain as unknown as { shadowMesh?: THREE.Mesh }).shadowMesh]) if (m?.castShadow && (m.geometry as THREE.InstancedBufferGeometry).instanceCount > 0) casters.push(m);
  assert.ok(casters.length > 0, 'some terrain mesh casts a shadow');
  const caster = casters[0];
  // it covers the ground behind the camera too (a ridge behind the camera shadows the valley in view)
  const g = caster.geometry as THREE.InstancedBufferGeometry, node = g.attributes.node as THREE.InstancedBufferAttribute;
  let behind = false;
  for (let i = 0; i < g.instanceCount; i++) if (node.getY(i) > 200) behind = true;
  assert.ok(behind, 'patches south of the camera (behind it) cast too');
  // the main view does not draw the shadow copy; the cascades do
  if (caster !== terrain.mesh) {
    assert.equal(caster.layers.test(camera.layers), false, 'the main camera does not see the shadow copy');
    const sun = new THREE.DirectionalLight();
    new Post({ shadowMap: {}, coordinateSystem: THREE.WebGPUCoordinateSystem, reversedDepthBuffer: false } as unknown as THREE.WebGPURenderer, new THREE.Scene(), camera, sun, { shadows: true, ao: false, bloom: false });
    assert.ok(caster.layers.test(sun.shadow.camera.layers), 'the cascades\' cameras see it');
    assert.ok(typeof sunMod.SHADOW_ONLY_LAYER === 'number');
  }
});

test('E35: the grass shows by the eye\'s height over the ground under it, not over the tile\'s mean', async () => {
  const { HEIGHT_TILE_RES } = await import('../src/config.ts');
  const w = new World();
  // a tile from 0 to 300 m: its mean is 150 m; the ground under the eye is at 290 m
  w.heights.fill(290); w.tileMin.fill(0); w.tileMax.fill(300);
  void HEIGHT_TILE_RES;
  const terrain = new TerrainRenderer(w);
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 1, 60000);
  const eye = new THREE.Vector3(0, 340, 0); // 50 m over the ground
  camera.position.copy(eye); camera.lookAt(0, 290, -100); camera.updateMatrixWorld();
  terrain.update(camera, eye);
  assert.equal(terrain.grassMesh.visible, true, 'the grass is hidden 50 m over the ground (190 m over the tile\'s mean)');
});

test('water (4.0 port): see-through, its depth read per pixel, and the sea uses the same water', () => {
  const w = new World();
  const terrain = new TerrainRenderer(w);
  const river = terrain.waterMesh.material as THREE.MeshStandardNodeMaterial;
  assert.equal(river.transparent, true, 'the river is see-through');
  assert.ok(river.opacityNode, 'its opacity follows the depth');
  const sea = (terrain as unknown as { createSeaMaterial?(): THREE.MeshStandardNodeMaterial }).createSeaMaterial?.();
  assert.ok(sea && sea.transparent && sea.opacityNode, 'the sea plane has the same water');
});

test('ecology (4.0 port): ground by a lake is wet, a ridge far from water is dry, a cliff is bare', async () => {
  const { ecologyTile, ECO_RES } = await import('../src/render/ecology.ts');
  const { HEIGHT_TILE_RES, MAP_TILES } = await import('../src/config.ts');
  const { WATER_TILE_RES } = await import('../src/world/ground.ts');
  const w = new World();
  // tile (5, 5): a lake on the west third, a ridge in the east, a cliff in the north-east corner
  const t = 5 * MAP_TILES + 5, HR = HEIGHT_TILE_RES, WR = WATER_TILE_RES;
  for (let j = 0; j < HR; j++) for (let i = 0; i < HR; i++) {
    const x = i * 4, z = j * 4;
    let hgt = 20 + 30 * Math.exp(-(((x - 800) / 60) ** 2));
    if (x > 900 && z < 120) hgt += (x - 900) * 1.5;
    w.heights[t * HR * HR + j * HR + i] = hgt;
  }
  for (let j = 0; j < WR; j++) for (let i = 0; i < WR; i++) w.water[t * WR * WR + j * WR + i] = i < 40 ? 21 : -1000;
  const out = new Uint8Array(ECO_RES * ECO_RES * 4);
  ecologyTile(w.heights, w.water, t, out);
  const at = (x: number, z: number, c: number) => out[(Math.floor(z / 8) * ECO_RES + Math.floor(x / 8)) * 4 + c];
  assert.ok(at(340, 500, 1) > 150, `beside the lake the ground is wet (${at(340, 500, 1)})`);
  assert.ok(at(800, 600, 1) < 40, `on the ridge it is not (${at(800, 600, 1)})`);
  assert.ok(at(800, 600, 0) > at(500, 600, 0), `the ridge is drier than the plain (${at(800, 600, 0)} vs ${at(500, 600, 0)})`);
  assert.ok(at(990, 40, 2) > 80, `the cliff is bare (${at(990, 40, 2)})`);
});

test('terrain (4.0 port): the grass, dirt and rock come from the 4.0 baked surfaces, and the files are there', async () => {
  const fs = await import('node:fs');
  const { COOKED } = await import('../src/render/cookedSurfaces.ts');
  for (const name of Object.keys(COOKED)) assert.ok(fs.existsSync(`public/cooked/surfaces/${name}.ktx2`), `${name}.ktx2 is in public/cooked/surfaces`);
  const src = fs.readFileSync('src/render/terrain.ts', 'utf8');
  for (const k of ["COOKED['terrain-grass.map']", "COOKED['terrain-land.map']", "COOKED['terrain-land.normal']", "COOKED['terrain-grass.normal']"]) assert.ok(src.includes(k), `the terrain reads ${k}`);
});

// 4.0 water.ts:177: the water sees the sky at 0.42 where 4.0's usual finish sees 0.6 (ours: SkyEnvironment.INTENSITY)
test('water sees the environment at 4.0 share (envMapIntensity 0.42)', async () => {
  const sc = await import('../src/render/scene.ts') as Record<string, unknown> & typeof import('../src/render/scene.ts');
  assert.equal(typeof sc.waterEnv, 'function', 'no per-material share of the environment');
  const THREE = await import('three/webgpu');
  const m = new THREE.MeshStandardNodeMaterial();
  sc.waterEnv(m);
  const scene = new THREE.Scene();
  new sc.SkyEnvironment(null as never, scene, false).update(new THREE.Vector3(0, 1, 0), 1);
  assert.ok(Math.abs(m.envMapIntensity - scene.environmentIntensity * 0.42 / 0.6) < 1e-9, `water ${m.envMapIntensity}, scene ${scene.environmentIntensity}`);
});

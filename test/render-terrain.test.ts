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

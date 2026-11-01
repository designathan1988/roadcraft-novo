import test from 'node:test';
import assert from 'node:assert/strict';
import { OcclusionBuffer, markOccluded, showOccludedForShadows, clearOccluded, occludedMeshes, type WorldBox } from '../src/render/visibility.ts';

/**
 * A camera at (0, 0, 10) looking down -Z, 60 degrees, near 0.1. The matrices are written out so the test does not need a
 * DOM or a renderer: visibility.ts only reads projectionMatrix, matrixWorldInverse, matrixWorld and near.
 */
function camera() {
  const f = 1 / Math.tan(Math.PI / 6);
  const n = 0.1, far = 1000;
  const projection = [
    f, 0, 0, 0,
    0, f, 0, 0,
    0, 0, -(far + n) / (far - n), -1,
    0, 0, -2 * far * n / (far - n), 0,
  ];
  const view = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, -10, 1,
  ];
  const world = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 10, 1,
  ];
  return { projectionMatrix: { elements: projection }, matrixWorldInverse: { elements: view }, matrixWorld: { elements: world }, near: n };
}

const behind: WorldBox = { x0: -1, x1: 1, y0: -1, y1: 1, z0: -5, z1: -4 };
const beside: WorldBox = { x0: 10, x1: 11, y0: -1, y1: 1, z0: -5, z1: -4 };
const front: WorldBox = { x0: -1, x1: 1, y0: -1, y1: 1, z0: 5, z1: 6 };
const wide: WorldBox = { x0: -40, x1: 40, y0: -1, y1: 1, z0: -5, z1: -4 };

test('the occluder hides a box behind a wall', () => {
  const b = new OcclusionBuffer();
  b.begin(camera() as never, 1);
  b.addBox(0, 0, 5, 0.1, 0, -5, 5);
  b.end();
  assert.equal(b.hidden(behind), true, 'a box directly behind the wall is hidden');
});

test('the occluder never hides a box beside, in front of, or wider than the wall', () => {
  const b = new OcclusionBuffer();
  b.begin(camera() as never, 1);
  b.addBox(0, 0, 5, 0.1, 0, -5, 5);
  b.end();
  assert.equal(b.hidden(beside), false, 'beside the wall is visible');
  assert.equal(b.hidden(front), false, 'in front of the wall is visible');
  assert.equal(b.hidden(wide), false, 'a box whose screen area leaves the wall is never hidden');
});

test('an empty buffer hides nothing', () => {
  const b = new OcclusionBuffer();
  b.begin(camera() as never, 1);
  b.end();
  assert.equal(b.hidden(behind), false);
});

test('a wall beyond the occluder reach is not laid (past it a wall spans a few texels and hides little)', () => {
  // within the reach (110 m from the eye): the wall hides the box behind it
  const near = new OcclusionBuffer();
  near.begin(camera() as never, 1);
  near.addBox(0, -100, 5, 0.1, 0, -5, 5);
  near.end();
  assert.equal(near.hidden({ x0: -1, x1: 1, y0: -1, y1: 1, z0: -101, z1: -100 }), true, 'a wall inside the reach occludes');
  // past the reach (1511 m from the eye at z = 10): the same wall is not an occluder
  const far = new OcclusionBuffer();
  far.begin(camera() as never, 1);
  far.addBox(0, -1501, 5, 0.1, 0, -5, 5);
  far.end();
  assert.equal(far.hidden({ x0: -1, x1: 1, y0: -1, y1: 1, z0: -1502, z1: -1501 }), false, 'a wall past the reach hides nothing');
});

test('shadow passes show the colour-hidden meshes and hide them again', () => {
  const mesh = { visible: true } as { visible: boolean };
  clearOccluded();
  markOccluded(mesh as never, true);
  assert.equal(mesh.visible, false);
  assert.equal(occludedMeshes(), 1);
  showOccludedForShadows(true);
  assert.equal(mesh.visible, true, 'a caster is shown inside the shadow pass');
  showOccludedForShadows(false);
  assert.equal(mesh.visible, false, 'and hidden again for the colour pass');
  markOccluded(mesh as never, false);
  assert.equal(mesh.visible, true);
  assert.equal(occludedMeshes(), 0);
});

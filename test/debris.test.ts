/// <reference types="node" />
// Debris of an explosion: the pieces of one shape simulated are never more than its batch draws (D42: pieces past
// the shell batch's 48 were stepped every frame and never drawn).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { Debris, PieceSpec, Shape } from '../src/features/demolition/blast/debris.ts';

test('D42: shells past the batch capacity replace the oldest shell instead of piling up unseen', () => {
  const d = new Debris([], new THREE.MeshBasicNodeMaterial());
  const spec = new PieceSpec();
  for (let i = 0; i < 60; i++) { spec.reset(); spec.shape = Shape.Shell; spec.x = i; spec.y = 5; spec.sx = 4; spec.sz = 2; spec.wx = spec.wy = spec.wz = 0; d.add(spec); }
  d.update(1 / 60, () => 0);
  const inner = d as unknown as { n: number; shape: Uint8Array; meshes: THREE.InstancedMesh[] };
  let shells = 0;
  for (let i = 0; i < inner.n; i++) if (inner.shape[i] === Shape.Shell) shells++;
  const drawn = inner.meshes[Shape.Shell].count;
  assert.ok(shells <= 48, `${shells} shells simulated`);
  assert.equal(shells, drawn, 'simulated = drawn');
});

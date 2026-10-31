/// <reference types="node" />
// A building that would fracture into more fragments than a ruin's slot holds is cut coarser until it fits (D28: the
// ruin was dropped with no record, and every later bomb on it fractured and dropped it again).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MeshBuilder } from '../src/jobs/meshBuilder.ts';
import { FRAGMENT_LIMIT, fractureBuilding } from '../src/features/demolition/ruin/fracture.ts';

test('D28: a building of more than 512 would-be fragments fractures into at most the slot', () => {
  const mb = new MeshBuilder(false, true);
  // a wide, thin slab of concrete: a large surface at 2.8 m cells gives more than 480 fragments
  // (the estimate area / size squared is not a cap: the occupied cells can run over 512)
  const W = 120, D = 120;
  const a = mb.vert(-W / 2, 0, -D / 2, 0, 1, 0, 0x999999, 0), b = mb.vert(W / 2, 0, -D / 2, 0, 1, 0, 0x999999, 0);
  const c = mb.vert(W / 2, 0, D / 2, 0, 1, 0, 0x999999, 0), d = mb.vert(-W / 2, 0, D / 2, 0, 1, 0, 0x999999, 0);
  mb.quad(a, b, c, d, 0, 1, 0);
  const r = fractureBuilding(mb, 7, 1, { kinds: [], rows: [] });
  assert.ok(r, 'a ruin');
  assert.ok(r!.fragmentCount > 0 && r!.fragmentCount <= FRAGMENT_LIMIT, `${r!.fragmentCount} fragments`);
});

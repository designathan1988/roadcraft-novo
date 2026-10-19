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

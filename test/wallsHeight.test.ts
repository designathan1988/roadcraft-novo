/// <reference types="node" />
// The cached wall height of a 4.0 building is its own: the cache key names the effective seed and the exact size
// (D65: seed 0 and a rounded size made different buildings share one height).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wallsHeightOf, type HeightRec } from '../src/jobs/buildingGen/heights.ts';
import { volumes40, type Lot40 } from '../src/jobs/building40.ts';
import { Zone } from '../src/roads/zones.ts';

function rec(n: number): HeightRec {
  const f = () => new Float32Array(n), u8 = () => new Uint8Array(n);
  return { x: f(), z: f(), w: f(), d: f(), rot: f(), zone: u8().fill(Zone.Residential), floors: u8().fill(3), seed: new Uint32Array(n), style: u8(), fn: u8(), color: new Uint32Array(n), h: f() };
}
const expected = (b: HeightRec, i: number): number => {
  const lot: Lot40 = { cx: b.x[i], cz: b.z[i], W: b.w[i], D: b.d[i], rot: b.rot[i], use: 'residential', density: 'medium', seed: b.seed[i] || i + 1, groundAt: () => 0 };
  return Math.max(0, ...volumes40(lot).map((v) => v.y1));
};

test('D65: two buildings with seed 0 and the same rounded size each get their own wall height', () => {
  const b = rec(8);
  for (let i = 0; i < 8; i++) { b.w[i] = i % 2 ? 20.4 : 19.6; b.d[i] = 14 + (i % 3) * 0.3; }
  const own = Array.from({ length: 8 }, (_, i) => expected(b, i));
  assert.ok(new Set(own).size > 1, `the fixture's heights differ: ${own.join(', ')}`);
  for (let i = 0; i < 8; i++) assert.equal(wallsHeightOf(b, i), own[i], `building ${i}`);
});

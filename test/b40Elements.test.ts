/// <reference types="node" />
// The b40 element rules must answer exactly as 4.0 elementsMeet: random parts of every kind, size, height, facing,
// turn and material, compared pair by pair.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elementsMeet as meet40 } from '../src/r40/world/buildings/elements.ts';
import { Rng } from '../src/core/rng.ts';
import { B40_ELEMENT_NAME } from '../src/world/b40Kinds.ts';
import { elementsMeet as meetB40, type ElementFields } from '../src/jobs/b40/elements.ts';

const to40 = (e: ElementFields) => ({
  id: 1, kind: B40_ELEMENT_NAME[e.kind]!, x: e.x, y: e.y, facing: e.facing as 0 | 1 | 2 | 3,
  w: e.w, d: e.d, z: e.z, h: e.h,
  ...(e.angle ? { angle: e.angle } : {}),
  ...(e.matFinish >= 0 ? { material: { finish: e.matFinish === 4 ? 'stone' as const : 'concrete' as const, colour: e.matColour } } : {}),
});

test('b40 elementsMeet answers exactly as 4.0', () => {
  const r = new Rng(0x9e3779b9);
  for (let i = 0; i < 40_000; i++) {
    const make = (): ElementFields => {
      const kind = r.int(0, B40_ELEMENT_NAME.length - 1);
      const retaining = kind === 5 && r.next() < 0.3;
      return {
        kind, x: r.range(-6, 6), y: r.range(-6, 6), z: r.next() < 0.7 ? 0 : r.range(0, 3),
        w: r.range(0.05, 5), d: r.range(0.05, 5), h: r.range(0.2, 3), facing: r.int(0, 3),
        angle: r.next() < 0.2 ? r.range(-1.5, 1.5) : 0,
        matFinish: retaining ? 4 : -1, matColour: retaining ? 0x9a948a : 0,
      };
    };
    const a = make(), b = make();
    assert.equal(meetB40(a, b), meet40(to40(a), to40(b)), `pair ${i}: ${JSON.stringify([a, b])}`);
  }
});

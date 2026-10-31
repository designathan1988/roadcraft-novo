/// <reference types="node" />
// The b40 style table: every bay code, finish id, weight and linear colour is valid, so a transcription slip in the
// 4.0 values fails here instead of in a building.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { srgbToLinear } from '../src/core/color.ts';
import { FINISH_COUNT } from '../src/shared/finishes.ts';
import { B40_BAY_COUNT, B40_KIND } from '../src/world/b40Kinds.ts';
import { B40_ERA_AFFINITY, B40_FOR, B40_STYLE_COUNT, B40_STYLES } from '../src/world/b40Styles.ts';

const isBay = (v: number): boolean => Number.isInteger(v) && v >= 0 && v < B40_BAY_COUNT;

test('the style table has one entry per 4.0 style', () => {
  assert.equal(B40_STYLES.length, B40_STYLE_COUNT);
});

test('every style field is inside its table', () => {
  B40_STYLES.forEach((s, i) => {
    assert.ok(s.skins.length > 0, `style ${i}: no skins`);
    assert.ok(s.trims.length > 0, `style ${i}: no trims`);
    assert.ok(s.rhythms.length > 0, `style ${i}: no rhythms`);
    for (const rhythm of s.rhythms) {
      assert.ok(rhythm.length > 0, `style ${i}: empty rhythm`);
      for (const bay of rhythm) assert.ok(isBay(bay), `style ${i}: bay ${bay}`);
    }
    assert.ok(isBay(s.sideFill), `style ${i}: side fill ${s.sideFill}`);
    assert.ok(isBay(s.groundFill), `style ${i}: ground fill ${s.groundFill}`);
    assert.ok(s.top === null || isBay(s.top), `style ${i}: top ${s.top}`);
    assert.ok(s.module > 0, `style ${i}: module ${s.module}`);
    const { width, height, sill } = s.opening;
    assert.ok(width[0] > 0 && width[0] <= width[1] && width[1] <= 1, `style ${i}: opening width`);
    assert.ok(height[0] > 0 && height[0] <= height[1] && height[1] <= 1, `style ${i}: opening height`);
    assert.ok(sill >= 0, `style ${i}: sill ${sill}`);
    for (const p of [...s.skins, ...s.trims]) {
      assert.ok(Number.isInteger(p.finish) && p.finish > 0 && p.finish <= FINISH_COUNT, `style ${i}: finish ${p.finish}`);
      assert.ok(p.colour >= 0 && p.colour <= 0xffffff, `style ${i}: colour ${p.colour}`);
      const want = [srgbToLinear(p.colour >> 16), srgbToLinear(p.colour >> 8), srgbToLinear(p.colour)];
      want.forEach((v, k) => assert.ok(Math.abs(v - p.linear[k]!) < 1e-9, `style ${i}: linear ${k}`));
    }
  });
});

test('the weights reference real styles and the era affinity covers them', () => {
  for (const kind of [B40_KIND.House, B40_KIND.Flats, B40_KIND.Tower, B40_KIND.Shop, B40_KIND.Office, B40_KIND.Works]) {
    const list = B40_FOR[kind]!;
    assert.ok(list.length > 0, `kind ${kind}: no styles`);
    for (const [style, weight] of list) {
      assert.ok(Number.isInteger(style) && style >= 0 && style < B40_STYLE_COUNT, `kind ${kind}: style ${style}`);
      assert.ok(weight > 0, `kind ${kind}: weight ${weight}`);
    }
  }
  assert.equal(B40_ERA_AFFINITY.length, B40_STYLE_COUNT);
  for (const [i, era] of B40_ERA_AFFINITY.entries()) {
    assert.equal(era.length, 3, `style ${i}: era triple`);
    for (const v of era) assert.ok(v >= 0, `style ${i}: era weight ${v}`);
  }
});

/// <reference types="node" />
// D6: a landform dab paints the same rock from the tool and from the scripts' API (the API painted a gully's rock at
// 0.95 of the radius, the tool at 0.6): one rule, world/brush.ts landformRockRadius, used by both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { landformRockRadius } from '../src/world/brush.ts';

test('a landform\'s rock reaches its cliff as in 4.0 (render/coverRaster.ts rasterGeology: flat to 0.78 of the dab)', async () => {
  const { World } = await import('../src/world/world.ts');
  const { GroundStroke, waterCoord, waterIndex, WATER_SPACING } = await import('../src/world/ground.ts');
  const w = new World();
  const x = 1500, z = 1500, R = landformRockRadius('mesa', 90);
  const st = new GroundStroke(w);
  st.dab(x, z, R, 'paint', 9, 1, 1);
  const cx = waterCoord(x), cz = waterCoord(z), r = R / WATER_SPACING;
  let cliff = 0;
  for (let gz = Math.floor(cz - r); gz <= Math.ceil(cz + r); gz++) for (let gx = Math.floor(cx - r); gx <= Math.ceil(cx + r); gx++) {
    const d = Math.hypot(gx - cx, gz - cz) / r;
    if (d >= 1) continue;
    const v = w.ground32[waterIndex(gx, gz)];
    // 4.0's weight, written out here: 1 − smoothstep(0.78, 1, d)
    const t = Math.min(1, Math.max(0, (d - 0.78) / 0.22)), want = 255 * (1 - t * t * (3 - 2 * t));
    assert.equal(v & 255, 9, 'sandstone laid');
    assert.ok(Math.abs(((v >> 8) & 255) - want) <= 1, `weight at ${d.toFixed(2)} of the dab: ${(v >> 8) & 255}, 4.0 ${want.toFixed(0)}`);
    // the mesa's cliff stands at 90 / 103.5 = 0.87 of the rock's dab: sandstone there (4.0 geologyOf: weight ≥ 0.5)
    if (d > 0.84 && d < 0.89) { cliff++; assert.ok(((v >> 8) & 255) >= 128, `the rock holds at the cliff (${(v >> 8) & 255} at ${d.toFixed(2)})`); }
  }
  assert.ok(cliff > 4, `samples at the cliff ${cliff}`);
});

test('D6: one rock radius rule for the tool and the API', () => {
  assert.equal(landformRockRadius('gully', 100), 60);
  // a landform's geology: 1.15 of the dab (Roadcraft 4.0 editor/terrainBrush.ts:136)
  assert.equal(landformRockRadius('mesa', 100), 100 * 1.15);
  for (const f of ['src/game.ts', 'src/app/scriptApi.ts']) {
    const s = fs.readFileSync(f, 'utf8');
    assert.match(s, /landformRockRadius\(/, `${f} paints the rock by the shared rule`);
    assert.doesNotMatch(s, /radius \* 0\.95|0\.6 : 0\.95/, `${f} keeps no factor of its own`);
  }
});

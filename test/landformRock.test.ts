/// <reference types="node" />
// D6: a landform dab paints the same rock from the tool and from the scripts' API (the API painted a gully's rock at
// 0.95 of the radius, the tool at 0.6): one rule, world/brush.ts landformRockRadius, used by both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { landformRockRadius } from '../src/world/brush.ts';

test('D6: one rock radius rule for the tool and the API', () => {
  assert.equal(landformRockRadius('gully', 100), 60);
  assert.equal(landformRockRadius('mesa', 100), 95);
  for (const f of ['src/game.ts', 'src/app/scriptApi.ts']) {
    const s = fs.readFileSync(f, 'utf8');
    assert.match(s, /landformRockRadius\(/, `${f} paints the rock by the shared rule`);
    assert.doesNotMatch(s, /radius \* 0\.95|0\.6 : 0\.95/, `${f} keeps no factor of its own`);
  }
});

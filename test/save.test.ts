/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TILE_COUNT } from '../src/core/grid.ts';
import { decodeMeta, encodeMeta } from '../src/platform/save.ts';

test('meta: céu e clima do jogador vão e voltam; salvamento antigo (sem eles) ainda abre', () => {
  const tiles = new Uint8Array(TILE_COUNT); tiles[4] = 1;
  const extra = JSON.stringify({ sky: 'noite', weather: { rain: 0.5, wind: 8, dir: 90, lightning: 3, thunder: 0.4 } });
  const enc = encodeMeta({ seed: 9, gameId: 3, tiles, camera: new Float64Array([1, 2]), hour: 7, biome: 2, extra });
  const dec = decodeMeta(enc);
  assert.equal(dec.extra, extra);
  assert.equal(dec.biome, 2);
  assert.equal(dec.hour, 7);
  // versão 5: termina no bioma (sem o campo extra)
  const old = enc.slice(0, enc.length - 4 - new TextEncoder().encode(extra).length);
  const d5 = decodeMeta(old);
  assert.equal(d5.extra, undefined);
  assert.equal(d5.biome, 2);
  assert.deepEqual(d5.tiles, tiles);
});

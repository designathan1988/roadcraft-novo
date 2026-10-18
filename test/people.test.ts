/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkCooked, PEOPLE_COOK_VERSION, CLIP, CLIP_PROP, type CookedPeople } from '../src/render/people/format.ts';

const dir = new URL('../public/cooked/people/', import.meta.url);

test('people cooked for this build (version, sizes, sections)', () => {
  const meta = JSON.parse(fs.readFileSync(new URL('people.json', dir), 'utf8')) as CookedPeople;
  const bytes = fs.statSync(new URL('people.bin', dir)).size;
  assert.equal(meta.version, PEOPLE_COOK_VERSION);
  assert.equal(checkCooked(meta, bytes), null);
  const cook = fs.readFileSync(new URL('../tools/cook-people.mjs', import.meta.url), 'utf8');
  assert.match(cook, new RegExp(`export const COOK_VERSION = ${PEOPLE_COOK_VERSION};`));
});

test('people cooked within the budget (memory, triangles, variety)', () => {
  const meta = JSON.parse(fs.readFileSync(new URL('people.json', dir), 'utf8')) as CookedPeople;
  assert.ok(meta.bytes < 60e6, `cooked people ${meta.bytes} bytes`);
  assert.ok(meta.maxTris[0] <= 4500 && meta.maxTris[1] <= 700 && meta.maxTris[2] <= 200, `triangles a person ${meta.maxTris}`);
  assert.ok(meta.variations.length >= 16);
  assert.equal(new Set(meta.variations.map((v) => v.outfit)).size >= 8, true);
  assert.equal(CLIP_PROP.length, Object.keys(CLIP).length);
});

test('a broken cook is refused', () => {
  const meta = JSON.parse(fs.readFileSync(new URL('people.json', dir), 'utf8')) as CookedPeople;
  assert.match(checkCooked({ ...meta, version: meta.version + 1 }, meta.bytes) ?? '', /version/);
  assert.match(checkCooked(meta, meta.bytes - 4) ?? '', /bytes/);
});

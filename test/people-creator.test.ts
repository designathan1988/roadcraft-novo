/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PeopleCreator, creatorCatalog, type PlacedPerson } from '../src/render/people/creator.ts';
import { CLIP, type CookedPeople } from '../src/render/people/format.ts';

const meta = JSON.parse(fs.readFileSync(new URL('../public/cooked/people/people.json', import.meta.url), 'utf8')) as CookedPeople;
const all = () => true;
const collect = (c: PeopleCreator, t = 0) => { const out: PlacedPerson[] = []; c.forEach(0, 0, 1000, t, 0.1, all, (p) => out.push({ ...p })); return out; };

test('creator places 1 to 20 people as asked, and undo takes them away', () => {
  const c = new PeopleCreator(meta);
  const cmd = c.placeCommand(10, 20, 3, { count: 50, sex: 'female', band: 'adult', mode: 'stand', hold: 'phone' });
  cmd.apply();
  const people = collect(c);
  assert.equal(people.length, 20);
  assert.ok(people.every((p) => meta.variations[p.variation].sex === 'female' && meta.variations[p.variation].band === 'adult'));
  assert.ok(people.every((p) => p.clip === CLIP.phone && p.y === 3));
  const id = cmd.id;
  cmd.invert();
  assert.equal(collect(c).length, 0);
  cmd.apply();
  assert.equal(cmd.id, id, 'redo keeps the id');
  assert.equal(collect(c).length, 20);
});

test('creator fixes the colours in the shader hash fields', () => {
  const c = new PeopleCreator(meta);
  c.place(0, 0, 0, { count: 5, top: 5, bottom: 9, hair: 3 });
  for (const p of collect(c)) {
    assert.equal((p.hash >>> 4) & 15, 5);
    assert.notEqual(p.hash & 3, 0);
    assert.equal((p.hash >>> 9) & 15, 9);
    assert.equal((p.hash >>> 18) & 7, 3);
    assert.equal((p.hash >>> 14) & 3, 0, 'no grey over a chosen hair colour');
  }
});

test('walkers go round their group, facing the way they walk; far groups cost nothing', () => {
  const c = new PeopleCreator(meta);
  c.place(100, 100, 0, { count: 4, mode: 'walk' });
  const a = collect(c, 0), b = collect(c, 1);
  for (let i = 0; i < a.length; i++) {
    const step = Math.hypot(b[i].x - a[i].x, b[i].z - a[i].z);
    assert.ok(step > 1 && step < 1.4, `walked ${step} m in a second`);
    const dir = Math.atan2(b[i].x - a[i].x, b[i].z - a[i].z);
    const d = Math.abs(((dir - a[i].yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    assert.ok(d < 0.4, 'faces where it walks');
  }
  let n = 0;
  c.forEach(5000, 5000, 700, 0, 0, all, () => n++);
  assert.equal(n, 0);
  assert.ok(creatorCatalog(meta).outfits.length >= 8);
});

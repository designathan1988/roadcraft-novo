/// <reference types="node" />
// The plan of a lot (Roadcraft 4.0 world/growth/lotPlan.ts) on this engine's lots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rng } from '../src/core/rng.ts';
import { Zone } from '../src/roads/zones.ts';
import { AISLE, STALL, YARD_FULL, docksFor, driveSide, envelope, garageRamp, lotKind, planLot, yardRamp, type LotKind } from '../src/world/lotPlan.ts';

test('zones map to the lot kinds Roadcraft plans for', () => {
  assert.equal(lotKind(Zone.ResLow), 'house');
  assert.equal(lotKind(Zone.Residential), 'flats');
  assert.equal(lotKind(Zone.ResHigh), 'tower');
  assert.equal(lotKind(Zone.Commercial), 'shop');
  assert.equal(lotKind(Zone.ComHigh), 'office');
  assert.equal(lotKind(Zone.Industrial), 'industry');
});

test('every plan leaves a building of at least 6 m inside the lot, in this engine\'s frame too', () => {
  const kinds: LotKind[] = ['house', 'flats', 'tower', 'shop', 'office', 'industry'];
  for (const kind of kinds) for (let i = 0; i < 200; i++) {
    const rng = new Rng(i * 7919 + 13), W = 8 + (i % 40), D = 14 + ((i * 7) % 60);
    const p = planLot(kind, W, D, rng, i % 5 === 0 ? 'left' : undefined);
    const b = p.building;
    assert.ok(b.x1 - b.x0 >= 6 - 1e-9 || (kind === 'house' && W < 8.5), `${kind} ${W}×${D}: building ${b.x1 - b.x0} m wide`);
    assert.ok(b.x0 >= 0 && b.x1 <= W && b.y0 >= 0 && b.y1 <= D && b.y1 > b.y0, `${kind} ${W}×${D}: ${JSON.stringify(b)}`);
    const e = envelope(p);
    assert.ok(e.x0 >= -W / 2 - 1e-9 && e.x1 <= W / 2 + 1e-9 && e.z0 >= -D / 2 - 1e-9 && e.z1 <= D / 2 + 1e-9);
    if (p.back.use === 'parking') assert.ok(driveSide(p) !== null, `${kind}: a car park with no drive to it`);
  }
});

test('a deep industrial lot gets a full loading yard with docks; flats get a two-row car park', () => {
  const ind = planLot('industry', 40, 80, new Rng(3));
  assert.equal(ind.back.use, 'loading');
  assert.equal(ind.back.depth, YARD_FULL);
  assert.ok(docksFor(ind) >= 5, `${docksFor(ind)} docks`);
  assert.equal(yardRamp(ind)?.grade, 0.1);
  let two = 0;
  for (let i = 0; i < 50; i++) { const p = planLot('flats', 24, 50, new Rng(i + 1)); if (p.back.use === 'parking' && p.back.rows === 2) { two++; assert.equal(p.back.depth, STALL * 2 + AISLE); } }
  assert.ok(two > 0, 'no flats with a two-row car park');
  const house = planLot('house', 14, 32, new Rng(5));
  assert.equal(garageRamp(house)?.grade, 0.25);
});

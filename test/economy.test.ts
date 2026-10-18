/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { buildRoad, demolishSeg, planRoad, snap } from '../src/roads/build.ts';
import { PROFILE_INFO } from '../src/roads/profiles.ts';
import { BuildKind, buildKindAt, chargeFor, kindOfFlags, segmentPrice } from '../src/roads/economy.ts';
import { ROAD_TUNING } from '../src/roads/tuning.ts';

const E = ROAD_TUNING.economy;

function flatWorld(money: number): World {
  const w = new World();
  w.heights.fill(10); w.tileMin.fill(10); w.tileMax.fill(10);
  w.money = money;
  return w;
}

function build(w: World, ax: number, bx: number, profile: number, elevation = 0) {
  const a = snap(w.roads, ax, 0, 8), b = snap(w.roads, bx, 0, 8);
  const p = planRoad(w, a, null, b, profile, elevation);
  assert.ok(p.ok, p.reason);
  return buildRoad(w, p, a, b, profile);
}

test('preço da via: m² de pista, canteiro e calçada × preço do roadcraft', () => {
  const p = PROFILE_INFO[0];
  let c = 0, m = 0, f = 0;
  for (const e of p.edges) {
    const k = e.strip.kind, wd = e.u1 - e.u0;
    if (k === 'sidewalk' || k === 'curb') f += wd; else if (k === 'median' || k === 'barrier') m += wd; else c += wd;
  }
  assert.equal(p.cost, Math.round(c * 150 + m * 40 + f * 80));
  assert.equal(segmentPrice(0, 100, BuildKind.Bridge), 100 * p.cost * 2.5);
  assert.equal(segmentPrice(0, 100, BuildKind.Tunnel), 100 * p.cost * 6);
});

test('modo de construção pela altura sobre o chão', () => {
  assert.equal(buildKindAt(10, 10), BuildKind.Ground);
  assert.equal(buildKindAt(12, 10), BuildKind.Embankment);
  assert.equal(buildKindAt(16, 10), BuildKind.Bridge);
  assert.equal(buildKindAt(7, 10), BuildKind.Trench);
  assert.equal(buildKindAt(1, 10), BuildKind.Tunnel);
  assert.equal(buildKindAt(2, -1), BuildKind.Bridge, 'sobre a água é ponte');
});

test('construir cobra, demolir devolve 25 %, desfazer devolve o dinheiro', () => {
  const w = flatWorld(10_000_000);
  const j = build(w, -100, 100, 0);
  const price = j.price;
  assert.ok(j.settle());
  assert.equal(w.money, 10_000_000 - price);
  let len = 0;
  const sc = w.roads.segs.cols;
  for (let s = 0; s < w.roads.segs.end; s++) if (w.roads.segs.alive[s]) { len += sc.len[s]; assert.equal(kindOfFlags(sc.flags[s]), BuildKind.Ground); }
  assert.ok(Math.abs(price - len * PROFILE_INFO[0].cost) <= 2, `${price} vs ${len * PROFILE_INFO[0].cost}`);
  const after = w.money;
  const s = w.roads.nearestSeg(0, 0, 5)![0];
  const segPrice = sc.len[s] * PROFILE_INFO[0].cost;
  const d = demolishSeg(w, s);
  assert.ok(d.settle());
  assert.ok(Math.abs(w.money - after - segPrice * E.demolitionRefund) <= 1, `devolveu ${w.money - after}`);
  d.invert(); j.invert();
  assert.equal(w.money, 10_000_000);
});

test('ponte custa 2,5× e sem saldo a obra é recusada sem deixar nada', () => {
  const w = flatWorld(1e9);
  const j = build(w, -150, 150, 0, 9);
  const sc = w.roads.segs.cols;
  const kinds = new Set<number>();
  for (let s = 0; s < w.roads.segs.end; s++) if (w.roads.segs.alive[s]) kinds.add(kindOfFlags(sc.flags[s]));
  assert.ok(kinds.has(BuildKind.Bridge), `modos ${[...kinds]}`);
  j.invert();
  const poor = flatWorld(1000);
  const k = build(poor, -100, 100, 0);
  assert.equal(k.settle(), false);
  assert.equal(poor.money, 1000);
  assert.equal(poor.roads.segs.size, 0);
});

test('devolução e cobrança arredondadas', () => {
  assert.equal(chargeFor(1000.4), 1000);
  assert.equal(chargeFor(-1000), -250);
  assert.equal(chargeFor(0.5), 0);
});

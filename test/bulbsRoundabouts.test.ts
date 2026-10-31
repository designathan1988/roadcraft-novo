/// <reference types="node" />
// Player-placed turning bulbs and roundabouts on vacant ground (Roadcraft 4.0 junction/bulb.ts, editor/roundabout.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { RoadJournal, buildRoad, buildRoundabout, bulbAt, planRoad, roundaboutRefusal, snap } from '../src/roads/build.ts';
import { SegFlag } from '../src/roads/flags.ts';
import { waterCoord, waterIndex } from '../src/world/ground.ts';
import { heightIndex, sampleCoord } from '../src/world/heights.ts';
import { t } from '../src/shared/i18n/index.ts';

function world(): World {
  const w = new World();
  w.heights.fill(10); w.tileMin.fill(10); w.tileMax.fill(10);
  w.money = 1e9;
  return w;
}
function road(w: World, ax: number, az: number, bx: number, bz: number): void {
  const a = snap(w.roads, ax, az, 8), b = snap(w.roads, bx, bz, 8);
  const p = planRoad(w, a, null, b, 0, 0);
  assert.ok(p.ok, p.reason);
  assert.ok(buildRoad(w, p, a, b, 0).settle());
}

test('the player chooses a dead end\'s shape: a turning bulb or a plain end, over the automatic one', () => {
  const w = world();
  road(w, 0, 0, 200, 0);
  const end = w.roads.nearestNode(200, 0, 1);
  assert.equal(bulbAt(w.roads, end), true, 'a long local dead end gets a bulb on its own');
  const j = new RoadJournal(w, 'end');
  j.setJunction(end, { ctl: 0, end: 'plain' });
  assert.equal(bulbAt(w.roads, end), false, 'the player asked for a plain end');
  // a dead end that touches another road gets no bulb on its own; the player can still ask for one
  road(w, 0, 30, 100, 30);
  const near = w.roads.nearestNode(100, 30, 1);
  w.roads.addNode({ x: 100, z: 46, y: 10 });
  road(w, 100, 46, 160, 46);
  assert.equal(bulbAt(w.roads, near), false);
  const k = new RoadJournal(w, 'end');
  k.setJunction(near, { ctl: 0, end: 'bulb' });
  assert.equal(bulbAt(w.roads, near), true, 'the player asked for a bulb');
  k.invert();
  assert.equal(bulbAt(w.roads, near), false, 'undo takes the choice back');
});

test('a roundabout on vacant ground comes with four approaches; over roads it cuts them only when asked', () => {
  const w = world();
  const j = buildRoundabout(w, 0, 0, 30);
  assert.ok(j && j.settle());
  const net = w.roads, sc = net.segs.cols, nc = net.nodes.cols;
  let ring = 0, stubs = 0;
  for (let s = 0; s < net.segs.end; s++) if (net.segs.alive[s]) { if (sc.flags[s] & SegFlag.Ring) ring++; else stubs++; }
  assert.ok(ring >= 8, `${ring} ring segments`);
  assert.equal(stubs, 4, `${stubs} approach roads`);
  let entries = 0, ends = 0;
  for (let n = 0; n < net.nodes.end; n++) if (net.nodes.alive[n]) { if (nc.deg[n] === 3) entries++; if (nc.deg[n] === 1) ends++; }
  assert.equal(entries, 4); assert.equal(ends, 4);
  // over an existing road, without asking: refused with the reason, nothing touched
  const v = world();
  road(v, -150, 10, 150, 10);
  const size = v.roads.segs.size;
  assert.notEqual(roundaboutRefusal(v, 0, 0, 30, false), '', 'the tool says the circle would cut a road');
  assert.equal(buildRoundabout(v, 0, 0, 30, false), null);
  assert.equal(v.roads.segs.size, size);
  const cut = buildRoundabout(v, 0, 0, 30, true);
  assert.ok(cut && cut.settle(), 'asked to cut: the roundabout takes the road in');
});

test('D49: a roundabout over a river the player drew is refused like one over the sea', () => {
  const w = world();
  const ground = w.heights[0];
  // a band of water above the ground across the ring's place
  for (let z = -60; z <= 60; z += 2) for (let x = -10; x <= 10; x += 2) w.water[waterIndex(waterCoord(x), waterCoord(z))] = ground + 1;
  assert.equal(roundaboutRefusal(w, 0, 0, 25), t('road.ring.water'));
});

test('D49: a dead end\'s turning bulb does not fill a pond the player drew at its edge', () => {
  const w = world();
  // a small pond (level 10.4 over ground 10) just beyond the end of a 200 m street: within the bulb's disc (18.5 m),
  // but not in the road's corridor (water there lifts the road onto a bridge and no terrain is touched at all)
  for (let z = -4; z <= 4; z += 2) for (let x = 216; x <= 220; x += 2) w.water[waterIndex(waterCoord(x), waterCoord(z))] = 10.4;
  road(w, 0, 0, 200, 0);
  const end = w.roads.nearestNode(200, 0, 1);
  assert.equal(bulbAt(w.roads, end), true);
  assert.equal(w.roads.nodes.cols.y[end], 10, 'the street stays on the ground');
  for (const x of [216, 218]) {
    const i = heightIndex(sampleCoord(x), sampleCoord(0));
    assert.ok(Math.abs(w.heights[i] - 10) < 1e-6, `ground changed under the pond at x = ${x}: ${w.heights[i]}`);
  }
});

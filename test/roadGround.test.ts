/// <reference types="node" />
// A road clears its ground (roads/ground.ts, clearAndConform): nothing stands on a carriageway, the sidewalk keeps its
// street furniture, the player's trees there go (the owner, 2026-10-30); undone, everything comes back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.ts';
import { Item } from '../src/world/items.ts';
import { RoadJournal, buildRoad, planRoad, snap } from '../src/roads/build.ts';
import { PROFILE_INFO } from '../src/roads/profiles.ts';
import { RoadGround, roadGroundAt } from '../src/roads/ground.ts';

const AVENUE = PROFILE_INFO.findIndex((p) => p.name === 'profile.avenue');

function world(): World {
  const w = new World();
  w.heights.fill(10); w.tileMin.fill(10); w.tileMax.fill(10);
  w.money = 1e9;
  return w;
}
function road(w: World, ax: number, az: number, bx: number, bz: number, profile: number): RoadJournal {
  const a = snap(w.roads, ax, az, 8), b = snap(w.roads, bx, bz, 8);
  const p = planRoad(w, a, null, b, profile, 0);
  assert.ok(p.ok, p.reason);
  const j = buildRoad(w, p, a, b, profile);
  assert.ok(j.settle());
  return j;
}
const point = (x: number, z: number, type: number): [number, number, number, number, number, number] => [x, z, 0, 0, type, 0];

test('the strips across an avenue: carriageway in the middle, footway at the sides, nothing past them', () => {
  const w = world();
  road(w, 1000, 1000, 1200, 1000, AVENUE);
  const info = PROFILE_INFO[AVENUE], side = Math.max(info.left, info.right);
  assert.equal(roadGroundAt(w.roads, 1100, 1000), RoadGround.Carriageway);
  assert.equal(roadGroundAt(w.roads, 1100, 1000 + side - 0.5), RoadGround.Footway);
  assert.equal(roadGroundAt(w.roads, 1100, 1000 - side + 0.5), RoadGround.Footway);
  assert.equal(roadGroundAt(w.roads, 1100, 1000 + side + 1), RoadGround.None);
});

test('a road built over the player\'s things clears its carriageway and the plants on its sidewalk; the furniture there stays', () => {
  const w = world();
  const info = PROFILE_INFO[AVENUE], walk = Math.max(info.left, info.right) - 0.8;
  const onRoad = [point(1100, 1000, Item.Tree), point(1110, 1001, Item.Bench), point(1120, 999, Item.Fountain)];
  const onWalk = { tree: point(1130, 1000 + walk, Item.Tree), bench: point(1140, 1000 + walk, Item.Bench), lamp: point(1150, 1000 - walk, Item.Lamp) };
  const away = point(1100, 1040, Item.Tree);
  for (const r of [...onRoad, onWalk.tree, onWalk.bench, onWalk.lamp, away]) w.items.add(r);
  const before = w.items.size;
  const j = road(w, 1000, 1000, 1200, 1000, AVENUE);
  const types: number[] = [];
  w.items.index.query(1000, 960, 1200, 1060, (id) => { types.push(w.items.t.cols.type[id]); });
  // left: the bench and the lamp on the sidewalks, the tree away from the road
  assert.deepEqual(types.sort((a, b) => a - b), [Item.Tree, Item.Bench, Item.Lamp].sort((a, b) => a - b));
  assert.equal(w.items.size, 3);
  j.invert();
  assert.equal(w.items.size, before, 'undone, the cleared things come back');
});

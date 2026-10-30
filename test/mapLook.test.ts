/// <reference types="node" />
// The map's look is the World's (world/mapLook.ts): the controls that show it keep no copy, a new map starts it over,
// an opened map brings its own, and the road paint is an undoable edit of the map (Roadcraft 4.0 setMarkingStyle).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FOG, DEFAULT_PAINT, DEFAULT_WATER, MapLook } from '../src/world/mapLook.ts';
import { WaterControl } from '../src/features/water/waterControl.ts';
import { Clouds } from '../src/features/sky/clouds.ts';
import { chooseRoadPaint } from '../src/features/roads/roadPaint.ts';
import { CommandStack } from '../src/core/commands.ts';

const saved = {
  water: { waves: 0.9, foam: 0.1, current: 0.2 }, weather: { rain: 0.5, wind: 8, dir: 90, lightning: 0, thunder: 1 },
  clouds: [{ x: 1, z: 2, y: 300, size: 400, density: 0.7 }], fog: 0.4, paint: 'us',
};

test('a new map starts the look over; an opened one brings its own', () => {
  const look = new MapLook();
  look.load(saved);
  assert.deepEqual({ ...look }, saved);
  look.reset();
  assert.deepEqual({ ...look }, { water: { ...DEFAULT_WATER }, weather: null, clouds: [], fog: DEFAULT_FOG, paint: DEFAULT_PAINT });
  look.load({ ...saved, water: null, paint: null });
  assert.deepEqual(look.water, DEFAULT_WATER);
  assert.equal(look.paint, DEFAULT_PAINT);
});

test('the water and cloud controls show the map look and keep no copy of it', () => {
  const look = new MapLook(), commands = new CommandStack();
  let changed = 0;
  const water = new WaterControl(look, () => changed++);
  water.set({ waves: 0.7, foam: 0.3, current: 0.1 });
  assert.equal(look.water.waves, 0.7);
  look.load(saved);
  assert.equal(water.ctl.waves, 0.9, 'an opened map is what the control reads');
  const clouds = new Clouds({ heights: new Float32Array(4), look, run: (c) => commands.run(c), toast: () => {}, changed: () => changed++, target: () => ({ x: 0, z: 0 }) });
  assert.equal(clouds.list.length, 1);
  clouds.clear();
  assert.equal(look.clouds.length, 0);
  commands.undo();
  assert.deepEqual(look.clouds, saved.clouds);
  look.reset();
  assert.equal(clouds.list.length, 0, 'a new map has no clouds');
  assert.equal(changed, 3);
});

test('choosing the road paint is an undoable edit of the map', () => {
  const look = new MapLook(), commands = new CommandStack();
  let changed = 0;
  const host = { look, run: (c: Parameters<CommandStack['run']>[0]) => commands.run(c), changed: () => changed++ };
  chooseRoadPaint(host, 'eu');
  assert.equal(look.paint, 'eu');
  chooseRoadPaint(host, 'eu');
  assert.equal(changed, 1, 'the same paint is no step');
  commands.undo();
  assert.equal(look.paint, DEFAULT_PAINT);
  commands.redo();
  assert.equal(look.paint, 'eu');
});

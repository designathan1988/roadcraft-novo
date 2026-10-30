/// <reference types="node" />
// The player's preferences have one owner (platform/settings.ts): older Portuguese keys and values are moved to the
// English ones, a photo address never reaches the storage, and the road paint is no longer a preference.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Preferences, readSettings } from '../src/platform/settings.ts';
import { readStored } from '../src/shared/storage.ts';

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null { return this.m.get(k) ?? null; }
  setItem(k: string, v: string): void { this.m.set(k, String(v)); }
  removeItem(k: string): void { this.m.delete(k); }
  keys(): string[] { return [...this.m.keys()]; }
}
let mem: MemoryStorage;
beforeEach(() => { mem = new MemoryStorage(); (globalThis as { localStorage?: unknown }).localStorage = mem; });

test('an older save of the options is read once and kept under the English key and values', () => {
  mem.setItem('cidade.opcoes', JSON.stringify({ preset: 'medio', weather: 'chuva', demand: 'pico', paint: 'us', volume: 0.3 }));
  const p = new Preferences(true);
  assert.equal(p.now.preset, 'medium');
  assert.equal(p.now.weather, 'rain');
  assert.equal(p.now.demand, 'peak');
  assert.equal(p.now.volume, 0.3);
  assert.equal('paint' in p.now, false, 'the road paint is the map\'s, not a preference');
  assert.deepEqual(mem.keys(), ['roadcraft.settings']);
  assert.equal(JSON.parse(mem.getItem('roadcraft.settings')!).preset, 'medium');
});

test('a photo address holds for the run only; the player\'s change of the same option is kept', () => {
  mem.setItem('roadcraft.settings', JSON.stringify({ shadows: true }));
  const p = new Preferences(true);
  p.forRun({ shadows: false, weather: 'storm' });
  assert.equal(p.now.shadows, false);
  p.update({ furniture: 1 });
  let stored = JSON.parse(mem.getItem('roadcraft.settings')!);
  assert.equal(stored.shadows, true, 'the address is not stored');
  assert.equal(stored.weather, 'clear');
  assert.equal(stored.furniture, 1);
  p.update({ shadows: false });
  stored = JSON.parse(mem.getItem('roadcraft.settings')!);
  assert.equal(stored.shadows, false, 'the player chose it');
  assert.equal(p.now.weather, 'storm');
});

test('the compatibility mode runs at Low without overwriting the player\'s quality', () => {
  mem.setItem('roadcraft.settings', JSON.stringify({ preset: 'ultra', detail: 1.4 }));
  const p = new Preferences(false);
  assert.equal(p.now.preset, 'low');
  assert.equal(JSON.parse(mem.getItem('roadcraft.settings')!).preset, 'ultra');
});

test('the other stored values move from their old names; no storage reads nothing', () => {
  mem.setItem('cidade.mapa', '16');
  assert.equal(readStored('mapTiles'), '16');
  assert.deepEqual(mem.keys(), ['roadcraft.mapTiles']);
  assert.equal(readSettings(true, 'not json').preset, 'high');
  delete (globalThis as { localStorage?: unknown }).localStorage;
  assert.equal(readStored('language'), null);
});

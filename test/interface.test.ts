/// <reference types="node" />
// The interface's pure parts with the real modules (keys.ts): the game's one keyboard listener, fed key events the
// way the browser sends them. Defect ids refer to DEFEITOS-roadcraft-novo.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installKeys, type GameKeyDeps } from '../src/ui/keys.ts';

type Listener = (e: unknown) => void;
/** A window with listeners, enough for installKeys (no DOM in Node). */
function fakeWindow(): { send(type: string, e: Partial<KeyboardEvent>): { prevented: boolean } } {
  const on = new Map<string, Listener[]>();
  const g = globalThis as Record<string, unknown>;
  g.window = { addEventListener: (type: string, fn: Listener) => on.set(type, [...(on.get(type) ?? []), fn]) };
  for (const n of ['HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLButtonElement']) g[n] ??= class {};
  return {
    send(type, e) {
      const ev = { prevented: false, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, repeat: false, target: null, key: e.code, ...e, preventDefault() { ev.prevented = true; } };
      for (const fn of on.get(type) ?? []) fn(ev);
      return ev;
    },
  };
}

/** Every action a key can reach, counted. */
function deps(over: Partial<GameKeyDeps> = {}): { d: GameKeyDeps; calls: string[] } {
  const calls: string[] = [];
  const log = (name: string) => () => { calls.push(name); };
  const d: GameKeyDeps = {
    tool: () => 'camera', setTool: (t) => calls.push(`tool ${t}`), openCategory: (c) => calls.push(`category ${c}`),
    dialog: () => false, closeDialog: () => undefined, closeMenu: () => false, closePanel: () => false, cancelStroke: () => false, toolKey: () => false,
    undo: log('undo'), redo: log('redo'), save: log('save'), help: log('help'), health: log('health'), pause: log('pause'),
    nextSpeed: log('speed'), toggleIso: log('iso'), congestion: log('congestion'), follow: log('follow'), wake: () => undefined,
    camera: { keyDown: (c) => calls.push(`camera ${c}`), keyUp: () => undefined, clearKeys: () => undefined },
    ...over,
  };
  return { d, calls };
}

test('B3: Ctrl + a letter, a digit or Space never reaches the plain game shortcuts', () => {
  const w = fakeWindow();
  const { d, calls } = deps();
  installKeys(d);
  for (const code of ['KeyC', 'KeyV', 'KeyK', 'KeyP', 'Space', 'Digit1', 'KeyZ', 'KeyH', 'KeyT', 'KeyW', 'KeyQ']) {
    for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
      calls.length = 0;
      w.send('keydown', { code, ...mod });
      const wrong = calls.filter((c) => c !== 'undo');
      assert.deepEqual(wrong, [], `${Object.keys(mod)[0]}+${code} did ${wrong.join(', ')}`);
    }
  }
  calls.length = 0;
  w.send('keydown', { code: 'KeyZ', ctrlKey: true });
  assert.deepEqual(calls, ['undo'], 'Ctrl+Z still undoes');
});

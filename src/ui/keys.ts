// The game's keys in one table and one listener (Roadcraft's gameKeys): the first rule that matches and does not
// pass acts. The tool in hand reads its own keys first and answers "pass" for the others. Escape steps back one
// thing at a time: the open menu, then the open panel, then the stroke in progress, then the tool.

import type { Tool } from './hud.ts';
import type { Category } from './drawers.ts';

export type KeyResult = 'done' | 'pass';

export interface KeyRule {
  /** Key codes (KeyboardEvent.code) the rule answers. Absent: any key. */
  code?: string | readonly string[];
  /** Ctrl (or ⌘) must be held (true), must not be (false), or either (absent). */
  ctrl?: boolean;
  shift?: boolean;
  when?: () => boolean;
  /** preventDefault when the rule acts (default true). */
  prevent?: boolean;
  run(e: KeyboardEvent): KeyResult | void;
}

export interface GameKeyDeps {
  tool(): Tool;
  setTool(t: Tool): void;
  openCategory(c: Category): void;
  /** Escape, step 1: the open menu or box of the top bar. */
  closeMenu(): boolean;
  /** Escape, step 2: the open panel (options, health, section editor, inspector). */
  closePanel(): boolean;
  /** Escape, step 3: the stroke in progress (a road being drawn, a wall, a lot, a river, a followed vehicle). */
  cancelStroke(): boolean;
  /** The tool's own keys; whether it used this one. */
  toolKey(e: KeyboardEvent): boolean;
  undo(): void;
  redo(): void;
  save(): void;
  help(): void;
  health(): void;
  pause(): void;
  nextSpeed(): void;
  toggleIso(): void;
  congestion(): void;
  follow(): void;
  /** Any key starts the ambient sound (browsers allow sound only after a key or a click). */
  wake(): void;
  camera: { keyDown(code: string): void; keyUp(code: string): void; clearKeys(): void };
}

/** The dock's keys (the same letters the dock shows). */
export const DOCK_KEYS: Readonly<Record<string, Category>> = {
  Digit1: 'roads', KeyZ: 'zones', KeyH: 'build', KeyT: 'landscape', KeyO: 'transit', KeyB: 'demolish', KeyI: 'info',
};
/** Direct keys of single tools, as the engine had them. */
const TOOL_KEYS: Readonly<Record<string, Tool>> = {
  Digit2: 'curve', Digit3: 'free', Digit4: 'roundabout', Digit5: 'upgrade', Digit7: 'raise', Digit8: 'lower', Digit9: 'smooth', Digit0: 'flatten',
  KeyU: 'upgrade', KeyM: 'move', KeyX: 'split', KeyG: 'streetscape', KeyN: 'river',
};

export function gameKeyRules(d: GameKeyDeps): KeyRule[] {
  return [
    { code: 'F9', run: () => d.health() },
    { code: 'F1', run: () => d.help() },
    { code: 'Escape', run: () => (d.closeMenu() || d.closePanel() || d.cancelStroke() ? 'done' : d.tool() !== 'camera' ? (d.setTool('camera'), 'done') : 'pass') },
    { code: 'KeyZ', ctrl: true, shift: false, run: () => d.undo() },
    { code: 'KeyZ', ctrl: true, shift: true, run: () => d.redo() },
    { code: 'KeyY', ctrl: true, run: () => d.redo() },
    { code: 'KeyS', ctrl: true, run: () => d.save() },
    // any other Ctrl (or ⌘) key stops here: the browser keeps its own (copy, paste…), the game's letters never see it
    { ctrl: true, prevent: false, run: () => 'done' },
    // the tool in hand reads its own keys first
    { ctrl: false, run: (e) => (d.toolKey(e) ? 'done' : 'pass') },
    { code: 'Space', run: () => d.pause() },
    { code: 'KeyP', run: () => d.nextSpeed() },
    { code: 'KeyV', run: () => d.toggleIso() },
    { code: 'KeyK', run: () => d.congestion() },
    { code: 'KeyC', run: () => d.follow() },
    { code: Object.keys(DOCK_KEYS), shift: false, run: (e) => d.openCategory(DOCK_KEYS[e.code]) },
    { code: Object.keys(TOOL_KEYS), shift: false, run: (e) => d.setTool(TOOL_KEYS[e.code]) },
    // W A S D, arrows, Q E, R F, + − move the camera while held
    { prevent: false, run: (e) => { d.camera.keyDown(e.code); } },
  ];
}

const matches = (r: KeyRule, e: KeyboardEvent): boolean => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (r.code !== undefined && !(typeof r.code === 'string' ? r.code === e.code : r.code.includes(e.code))) return false;
  if (r.ctrl !== undefined && r.ctrl !== ctrl) return false;
  if (r.shift !== undefined && r.shift !== e.shiftKey) return false;
  return !r.when || r.when();
};

/** The one keyboard listener of the game. */
export function installKeys(d: GameKeyDeps): void {
  const rules = gameKeyRules(d);
  window.addEventListener('keydown', (e) => {
    d.wake();
    // typing in a box: the box keeps its keys
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
    for (const r of rules) {
      if (!matches(r, e)) continue;
      if (r.run(e) === 'pass') continue;
      if (r.prevent !== false) e.preventDefault();
      return;
    }
  });
  window.addEventListener('keyup', (e) => d.camera.keyUp(e.code));
  window.addEventListener('blur', () => d.camera.clearKeys());
}

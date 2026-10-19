// The game's keys in one table and one listener (Roadcraft's gameKeys): the first rule that matches and does not
// pass acts. The tool in hand reads its own keys first and answers "pass" for the others. Escape steps back one
// thing at a time: the open menu, then the open panel, then the stroke in progress, then the tool. The help (F1)
// and the keys the road keys cannot take are read from the same table, so they never drift from what the keys do.

import type { Tool } from './hud.ts';
import type { Category } from './drawers.ts';
import { t } from './i18n.ts';

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
  /** A dialog over the game (options, About, the start screen): the game's keys wait; Escape closes it. */
  dialog(): boolean;
  closeDialog(): void;
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
  /** Ctrl+O: a map file to open. */
  openMap(): void;
  /** Ctrl+D: the road shown in the inspector, duplicated alongside. */
  duplicate(): void;
  /** Home: the view the city opened with. */
  home(): void;
  /** Shift+Q / Shift+E: a quarter turn (−1 as Q, +1 as E). */
  quarterTurn(dir: number): void;
  help(): void;
  /** F9 (developer): the health panel; F8: the same panel on the world's changes. */
  health(): void;
  changes(): void;
  /** The developer panels are on (F8, F9). */
  developer(): boolean;
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
export const TOOL_KEYS: Readonly<Record<string, Tool>> = {
  Digit2: 'curve', Digit3: 'free', Digit4: 'roundabout', Digit5: 'upgrade', Digit7: 'raise', Digit8: 'lower', Digit9: 'smooth', Digit0: 'flatten',
  KeyU: 'upgrade', KeyM: 'move', KeyX: 'split', KeyG: 'streetscape', KeyN: 'river',
};
/** The camera's held keys (render/cameraRig.ts reads the same codes). */
export const CAMERA_CODES: readonly string[] = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyQ', 'KeyE', 'KeyR', 'KeyF',
  'PageUp', 'PageDown', 'Equal', 'NumpadAdd', 'Minus', 'NumpadSubtract', 'ShiftLeft', 'ShiftRight'];

/** A key of the game's own (not a tool's): its codes and modifiers, what the help calls it and says it does, and the action. */
interface GameKey {
  code: string | readonly string[];
  ctrl?: boolean;
  shift?: boolean;
  /** The key as the player reads it: a dictionary key, or the key itself (a letter, F1). */
  label: string;
  does: string;
  /** Only for developers (not in the player's help). */
  dev?: boolean;
  act(d: GameKeyDeps, e: KeyboardEvent): void;
}

const GAME_KEYS: readonly GameKey[] = [
  { code: 'KeyZ', ctrl: true, shift: false, label: 'help.key.undo', does: 'v2.do.undo', act: (d) => d.undo() },
  { code: 'KeyY', ctrl: true, label: 'v2.key.redo', does: 'v2.do.redo', act: (d) => d.redo() },
  { code: 'KeyZ', ctrl: true, shift: true, label: 'keys.ctrlShiftZ', does: 'v2.do.redo', act: (d) => d.redo() },
  { code: 'KeyS', ctrl: true, label: 'ui.key.save', does: 'keys.do.save', act: (d) => d.save() },
  { code: 'KeyO', ctrl: true, label: 'keys.ctrlO', does: 'keys.do.open', act: (d) => d.openMap() },
  { code: 'KeyD', ctrl: true, label: 'keys.ctrlD', does: 'keys.do.duplicate', act: (d) => d.duplicate() },
  { code: 'Space', ctrl: false, label: 'v2.key.space', does: 'v2.do.pause', act: (d) => d.pause() },
  { code: 'KeyP', ctrl: false, label: 'P', does: 'sim.speed', act: (d) => d.nextSpeed() },
  { code: 'KeyV', ctrl: false, label: 'V', does: 'ui.do.iso', act: (d) => d.toggleIso() },
  { code: 'KeyK', ctrl: false, label: 'K', does: 'sim.congestionLabel', act: (d) => d.congestion() },
  { code: 'KeyC', ctrl: false, label: 'C', does: 'ui.do.follow', act: (d) => d.follow() },
  { code: 'Home', ctrl: false, label: 'help.key.home', does: 'keys.do.home', act: (d) => d.home() },
  { code: ['KeyQ', 'KeyE'], ctrl: false, shift: true, label: 'keys.shiftQE', does: 'keys.do.quarterTurn', act: (d, e) => { if (!e.repeat) d.quarterTurn(e.code === 'KeyQ' ? -1 : 1); } },
  { code: 'F1', label: 'F1', does: 'builder.help', act: (d) => d.help() },
  { code: 'F9', label: 'F9', does: 'v2.do.health', dev: true, act: (d) => d.health() },
  { code: 'F8', label: 'F8', does: 'keys.do.changes', dev: true, act: (d) => d.changes() },
];

export function gameKeyRules(d: GameKeyDeps): KeyRule[] {
  const own = (k: GameKey): KeyRule => ({ code: k.code, ctrl: k.ctrl, shift: k.shift, when: k.dev ? () => d.developer() : undefined, run: (e) => k.act(d, e) });
  const fn = GAME_KEYS.filter((k) => /^F\d/.test(String(k.code))).map(own);
  const ctrl = GAME_KEYS.filter((k) => k.ctrl === true).map(own);
  const plain = GAME_KEYS.filter((k) => k.ctrl !== true && !/^F\d/.test(String(k.code))).map(own);
  return [
    { when: () => d.dialog(), prevent: false, run: (e) => { if (e.code === 'Escape') d.closeDialog(); } },
    ...fn,
    { code: 'Escape', run: () => (d.closeMenu() || d.closePanel() || d.cancelStroke() ? 'done' : d.tool() !== 'camera' ? (d.setTool('camera'), 'done') : 'pass') },
    ...ctrl,
    // any other Ctrl (or ⌘) key stops here: the browser keeps its own (copy, paste…), the game's letters never see it
    { ctrl: true, prevent: false, run: () => 'done' },
    // the tool in hand reads its own keys first
    { ctrl: false, run: (e) => (d.toolKey(e) ? 'done' : 'pass') },
    ...plain,
    { code: Object.keys(DOCK_KEYS), shift: false, run: (e) => d.openCategory(DOCK_KEYS[e.code]) },
    { code: Object.keys(TOOL_KEYS), shift: false, run: (e) => d.setTool(TOOL_KEYS[e.code]) },
    // W A S D, arrows, Q E, R F, + − move the camera while held
    { prevent: false, run: (e) => { d.camera.keyDown(e.code); } },
  ];
}

/** A key code as the player reads it ("KeyQ" → "Q", "PageUp" → "Page Up"). */
export function keyName(code: string): string {
  return code.replace(/^Key/, '').replace(/^Digit/, '').replace('PageUp', 'Page Up').replace('PageDown', 'Page Down');
}

/** The help's lists, read from the key table: [key, what it does], in the player's language. */
export function keyHelp(developer = false): { game: Array<[string, string]>; tools: Array<[string, string]> } {
  const name = (label: string): string => (label.includes('.') ? t(label) : label);
  const game = GAME_KEYS.filter((k) => developer || !k.dev).map((k): [string, string] => [name(k.label), t(k.does)]);
  game.push([t('help.key.esc'), t('ui.do.escape')]);
  const tools: Array<[string, string]> = [
    ...Object.entries(DOCK_KEYS).map(([c, cat]): [string, string] => [keyName(c), t(`ui.cat.${cat}`)]),
    ...Object.entries(TOOL_KEYS).map(([c, tool]): [string, string] => [keyName(c), t(`ui.toolName.${tool}`)]),
  ];
  return { game, tools };
}

/** Keys the game already answers: the road tool's keys (Options) cannot take them. */
export function reservedKeys(): Set<string> {
  const codes = new Set<string>(['Escape', 'Enter', 'NumpadEnter', 'Backspace', 'Delete', 'BracketLeft', 'BracketRight', 'Tab', ...CAMERA_CODES, ...Object.keys(DOCK_KEYS), ...Object.keys(TOOL_KEYS)]);
  for (const k of GAME_KEYS) for (const c of typeof k.code === 'string' ? [k.code] : k.code) codes.add(c);
  // Page Up / Down are the road keys' own default (the road tool reads them before the camera's tilt)
  codes.delete('PageUp'); codes.delete('PageDown');
  return codes;
}

/** The one keyboard listener of the game. */
export function installKeys(d: GameKeyDeps): void {
  const rules = gameKeyRules(d);
  window.addEventListener('keydown', (e) => {
    d.wake();
    // the browser's reload keys (Ctrl+R, Ctrl+Shift+R, F5) would throw away the city's unsaved work: the page reloads
    // and nothing is saved. The game keeps them, even while typing in a box (Electron's menu sees the key as used).
    if (e.code === 'F5' || (e.code === 'KeyR' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); return; }
    // typing in a box: the box keeps its keys
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
    // a button clicked before keeps the focus: Enter or Space must not click it again (they are the game's keys)
    if (e.target instanceof HTMLButtonElement && (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space')) { e.target.blur(); e.preventDefault(); }
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

const matches = (r: KeyRule, e: KeyboardEvent): boolean => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (r.code !== undefined && !(typeof r.code === 'string' ? r.code === e.code : r.code.includes(e.code))) return false;
  if (r.ctrl !== undefined && r.ctrl !== ctrl) return false;
  if (r.shift !== undefined && r.shift !== e.shiftKey) return false;
  return !r.when || r.when();
};

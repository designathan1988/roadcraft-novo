// The road tool's keys in a small panel beside the tool's options, as Roadcraft 4.0 (roads/keysPanel.ts): a chip per
// key; a click on a chip makes it wait, and the next key pressed is its own (a game key is refused); Esc lets the
// waiting chip go, then closes the panel; Restore defaults gives the three keys back.

import { t } from './i18n.ts';
import { keyName, reservedKeys } from './keys.ts';

export interface RoadKeys { roadUp: string; roadDown: string; roadAlign: string }

/** The defaults, which are game keys too (Page Up / Down tilt the camera elsewhere, V turns the view). */
const DEFAULTS: RoadKeys = { roadUp: 'PageUp', roadDown: 'PageDown', roadAlign: 'KeyV' };
const ROWS: Array<[keyof RoadKeys, string]> = [['roadUp', 'roadKeys.heightUp'], ['roadDown', 'roadKeys.heightDown'], ['roadAlign', 'roadKeys.alignment']];

let open: { root: HTMLElement; listening: AbortController } | null = null;

export function closeRoadKeys(): void {
  open?.listening.abort();
  open?.root.remove();
  open = null;
}

export const roadKeysOpen = (): boolean => open !== null;

/** `keys` reads the keys as they are now; `set` keeps a change (and the pill shows it). */
export function openRoadKeys(anchor: HTMLElement, keys: () => RoadKeys, set: (patch: Partial<RoadKeys>) => void): void {
  closeRoadKeys();
  const reserved = reservedKeys();
  const root = document.createElement('section');
  root.className = 'rp-keys';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', t('roadKeys.title'));
  root.addEventListener('pointerdown', (e) => e.stopPropagation());
  let waiting: keyof RoadKeys | null = null;
  let note = '';

  const render = (): void => {
    root.replaceChildren();
    const head = document.createElement('div');
    head.className = 'rp-keys-head';
    const title = document.createElement('span');
    title.className = 'rp-title';
    title.textContent = t('roadKeys.title');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'rp-icon';
    close.setAttribute('aria-label', t('v2.close'));
    close.title = t('v2.close');
    close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    close.onclick = closeRoadKeys;
    head.append(title, close);
    root.append(head);
    const now = keys();
    for (const [action, key] of ROWS) {
      const row = document.createElement('div');
      row.className = 'rp-keys-row';
      const label = document.createElement('span');
      label.textContent = t(key);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `rp-key${waiting === action ? ' waiting' : ''}`;
      chip.dataset.action = action;
      chip.textContent = waiting === action ? t('roadKeys.press') : keyName(now[action]);
      chip.onclick = () => { waiting = waiting === action ? null : action; note = ''; render(); };
      row.append(label, chip);
      root.append(row);
    }
    if (note) {
      const n = document.createElement('div');
      n.className = 'rp-note';
      n.setAttribute('role', 'status');
      n.textContent = note;
      root.append(n);
    }
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'rp-btn';
    reset.textContent = t('roadKeys.reset');
    reset.onclick = () => { set({ ...DEFAULTS }); waiting = null; note = ''; render(); };
    root.append(reset);
  };

  // while a chip waits, the next key is its own, before the game sees it
  const onKey = (e: KeyboardEvent): void => {
    if (!waiting) {
      if (e.code === 'Escape') { closeRoadKeys(); e.stopPropagation(); e.preventDefault(); }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape') { waiting = null; note = ''; render(); return; }
    if (reserved.has(e.code) && !Object.values(DEFAULTS).includes(e.code)) { note = t('roadKeys.reserved', { key: keyName(e.code) }); render(); return; }
    set({ [waiting]: e.code });
    waiting = null;
    note = '';
    render();
  };
  const listening = new AbortController();
  window.addEventListener('keydown', onKey, { capture: true, signal: listening.signal });

  const box = anchor.getBoundingClientRect();
  root.style.left = `${Math.round(Math.min(window.innerWidth - 276, box.right + 10))}px`;
  root.style.bottom = `${Math.round(Math.max(12, window.innerHeight - box.bottom))}px`;
  document.getElementById('hud')!.append(root);
  open = { root, listening };
  render();
}

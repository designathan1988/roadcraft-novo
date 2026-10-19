// Small DOM builders shared by the panels (the look is in shell.css). Every control is made once; panels that
// change rebuild only on a player action, never per frame.

import { svg } from './icons.ts';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A button: its icon and its name (the name is hidden for icon buttons and shown as the tooltip). */
export function button(className: string, label: string, run: () => void, icon?: string): HTMLButtonElement {
  const b = el('button', className);
  b.type = 'button';
  b.innerHTML = icon ?? '';
  b.append(el('span', '', label));
  b.title = label;
  b.addEventListener('click', (e) => { e.stopPropagation(); run(); });
  return b;
}

/** A button that exists but does nothing yet: the tooltip says the feature is being built. */
export function soon(b: HTMLButtonElement, note: string): HTMLButtonElement {
  b.disabled = true;
  b.classList.add('soon');
  b.title = `${b.title} · ${note}`;
  return b;
}

export interface Choice { label: string; on: boolean; run: () => void; disabled?: boolean; icon?: string; soon?: string }

/** A row of choices, the one in use lit (icons when they read, words otherwise). */
export function choices(items: readonly Choice[]): HTMLElement {
  const wrap = el('div', 'v2-choices');
  for (const item of items) {
    const b = button(`v2-choice${item.on ? ' on' : ''}${item.icon ? ' icon' : ''}`, item.label, item.run, item.icon);
    b.disabled = item.disabled ?? false;
    b.setAttribute('aria-pressed', String(item.on));
    if (item.soon) soon(b, item.soon);
    wrap.append(b);
  }
  return wrap;
}

/** One row of options: a short name at the left, the controls at the right. */
export function orow(label: string, ...controls: Array<HTMLElement | null | undefined>): HTMLElement {
  const r = el('div', 'v2-orow');
  r.setAttribute('role', 'group');
  r.setAttribute('aria-label', label);
  const name = el('span', 'v2-orow-name', label);
  name.title = label;
  const box = el('div', 'v2-orow-ctrls');
  for (const c of controls) if (c) box.append(c);
  r.append(name, box);
  return r;
}

export const subhead = (label: string): HTMLElement => el('div', 'v2-subhead', label);

/** Less, the value, more. `run` gets −1 or +1 and returns the new text. */
export function stepper(label: string, value: string, run: (d: number) => string): HTMLElement {
  const s = el('div', 'v2-stepper');
  s.title = label;
  const out = el('output', 'v2-stepper-value', value);
  s.append(
    button('v2-icon', `${label} −`, () => { out.textContent = run(-1); }, svg('minus', 14)),
    out,
    button('v2-icon', `${label} +`, () => { out.textContent = run(1); }, svg('plus', 14)),
  );
  return s;
}

/** A slider row: its name, the slider, the number with its unit. */
export function range(label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, set: (v: number) => void, short?: string): HTMLElement {
  const input = el('input', 'v2-range');
  input.type = 'range';
  input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value);
  input.setAttribute('aria-label', label);
  const out = el('output', 'v2-range-out', fmt(value));
  input.addEventListener('input', () => { const v = Number(input.value); out.textContent = fmt(v); set(v); });
  input.addEventListener('keydown', (e) => e.stopPropagation());
  const r = orow(short ?? label, input, out);
  r.title = label;
  r.classList.add('range');
  return r;
}

/** A thing to pick: its picture (an icon or an image) and its name under it. */
export function card(label: string, on: boolean, run: () => void, art: string, extra = ''): HTMLButtonElement {
  const b = el('button', `v2-card${on ? ' on' : ''}${extra ? ` ${extra}` : ''}`);
  b.type = 'button';
  b.title = label;
  b.innerHTML = art.startsWith('data:') ? `<img class="v2-card-art" src="${art}" alt="">` : `<span class="v2-card-art glyph">${art}</span>`;
  b.append(el('span', 'v2-card-name', label.replace(/\s*\([^)]*\)\s*$/, '')));
  b.setAttribute('aria-label', label);
  b.addEventListener('click', (e) => { e.stopPropagation(); run(); });
  return b;
}

/** A mode of the tool (a tab): its icon and its name. */
export function tab(label: string, on: boolean, run: () => void, icon?: string, disabledNote?: string): HTMLButtonElement {
  const b = button(`v2-tab${on ? ' on' : ''}${icon ? ' icon' : ''}`, label, run, icon);
  b.setAttribute('role', 'tab');
  b.setAttribute('aria-selected', String(on));
  if (disabledNote) soon(b, disabledNote);
  return b;
}

/** A dropdown in the theme (a native select, dark). */
export function select(label: string, items: ReadonlyArray<readonly [string | number, string]>, value: string | number, pick: (v: string) => void): HTMLSelectElement {
  const s = el('select', 'v2-select');
  s.title = label;
  s.setAttribute('aria-label', label);
  for (const [v, name] of items) { const o = el('option', '', name); o.value = String(v); s.append(o); }
  s.value = String(value);
  s.addEventListener('change', () => { pick(s.value); s.blur(); });
  s.addEventListener('keydown', (e) => e.stopPropagation());
  return s;
}

/** The open themed list, and its button. */
let ddOpen: { list: HTMLElement; anchor: HTMLButtonElement } | null = null;

/** Closes the open themed list (a click elsewhere, Esc, a pick, or the panel rebuilt). */
export function closeDropdown(): void {
  if (!ddOpen) return;
  ddOpen.list.remove();
  ddOpen.anchor.setAttribute('aria-expanded', 'false');
  ddOpen = null;
}

/**
 * A list of choices in the theme, in place of the browser's white select (Roadcraft 4.0 shell.ts:971-1040): a button
 * naming the choice and, open, the list under it (above it in the lower half of the screen). Up, Down, Home and End
 * move through the list and Enter picks (the list's own keys: no listener on the window); Esc closes it and gives the
 * focus back to the button, and the game never sees that Esc.
 */
export function dropdown(label: string, items: ReadonlyArray<readonly [string | number, string]>, value: string | number, pick: (v: string) => void): HTMLButtonElement {
  const b = el('button', 'v2-dd');
  b.type = 'button';
  b.title = label;
  b.dataset.value = String(value);
  b.setAttribute('aria-label', label);
  b.setAttribute('aria-haspopup', 'listbox');
  b.setAttribute('aria-expanded', 'false');
  b.append(el('span', 'v2-dd-value', items.find(([v]) => String(v) === String(value))?.[1] ?? ''));
  b.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>');
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (ddOpen?.anchor === b) { closeDropdown(); return; }
    closeDropdown();
    const list = el('div', 'v2-dd-list');
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', label);
    for (const [v, name] of items) {
      const on = String(v) === b.dataset.value;
      const o = el('button', `v2-dd-opt${on ? ' on' : ''}`, name);
      o.type = 'button';
      o.dataset.value = String(v);
      o.setAttribute('role', 'option');
      o.setAttribute('aria-selected', String(on));
      // the button names the new choice at once (as a select does), then the choice is passed on
      o.addEventListener('click', (ev) => { ev.stopPropagation(); closeDropdown(); b.dataset.value = String(v); b.querySelector('.v2-dd-value')!.textContent = name; b.focus(); pick(String(v)); });
      list.append(o);
    }
    list.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape') { ev.preventDefault(); closeDropdown(); b.focus(); return; }
      const opts = [...list.querySelectorAll<HTMLButtonElement>('.v2-dd-opt')];
      const at = opts.indexOf(document.activeElement as HTMLButtonElement);
      const to = ev.key === 'ArrowDown' ? Math.min(opts.length - 1, at + 1) : ev.key === 'ArrowUp' ? Math.max(0, at - 1)
        : ev.key === 'Home' ? 0 : ev.key === 'End' ? opts.length - 1 : -1;
      if (to >= 0) { ev.preventDefault(); opts[to].focus(); }
    });
    list.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    list.addEventListener('wheel', (ev) => ev.stopPropagation(), { passive: true });
    (b.closest('.v2') ?? document.body).append(list);
    const r = b.getBoundingClientRect();
    list.style.minWidth = `${Math.round(r.width)}px`;
    list.style.left = `${Math.round(Math.min(r.left, window.innerWidth - list.offsetWidth - 8))}px`;
    if (r.top > window.innerHeight / 2) list.style.bottom = `${Math.round(window.innerHeight - r.top + 4)}px`;
    else list.style.top = `${Math.round(r.bottom + 4)}px`;
    ddOpen = { list, anchor: b };
    b.setAttribute('aria-expanded', 'true');
    const chosen = list.querySelector<HTMLElement>('.on') ?? list.querySelector<HTMLElement>('.v2-dd-opt');
    chosen?.scrollIntoView({ block: 'nearest' });
    chosen?.focus({ preventScroll: true });
  });
  // Down on the closed button opens the list, as a select does
  b.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' && ddOpen?.anchor !== b) { e.preventDefault(); e.stopPropagation(); b.click(); } });
  return b;
}

if (typeof document !== 'undefined') {
  // a click anywhere else closes the open list
  document.addEventListener('pointerdown', (e) => {
    if (ddOpen && !ddOpen.list.contains(e.target as Node) && !ddOpen.anchor.contains(e.target as Node)) closeDropdown();
  }, true);
}

/** A text box: the keys typed stay in it (the game's shortcuts do not see them). */
export function textInput(placeholder: string, value: string, set: (v: string) => void, max = 40): HTMLInputElement {
  const i = el('input', 'v2-search');
  i.type = 'text';
  i.maxLength = max;
  i.placeholder = placeholder;
  i.value = value;
  i.addEventListener('input', () => set(i.value));
  i.addEventListener('keydown', (e) => e.stopPropagation());
  return i;
}

/** A colour swatch as card art. */
export const swatchArt = (colour: string): string => `<i class="v2-ground" style="--c:${colour}"></i>`;

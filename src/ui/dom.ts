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

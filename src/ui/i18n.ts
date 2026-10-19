// The interface's language: one dictionary per language, keyed like Roadcraft's (data/textos-roadcraft) plus the
// keys of what the engine has and Roadcraft did not (lang/engine.ts). Every string the interface shows comes from
// here through `t(key)`. Changing the language reloads the page (the panels are built once, in one language).
// Text that other engine areas still write in Portuguese (toasts, tool hints) goes through `loose()`.

import { PT_BR as RC_PT } from '../../data/textos-roadcraft/pt-BR.ts';
import { EN as RC_EN } from '../../data/textos-roadcraft/en.ts';
import { ENGINE_PT } from './lang/engine.pt-BR.ts';
import { ENGINE_EN } from './lang/engine.en.ts';
import { translate as legacyTranslate } from './lang/legacy.ts';

export type Lang = 'pt-BR' | 'en';
export const LANGUAGES: ReadonlyArray<readonly [Lang, string]> = [['pt-BR', 'Português'], ['en', 'English']];

const KEY = 'roadcraft.language';
const OLD_KEY = 'cidade.idioma';

const TABLES: Record<Lang, Record<string, string>> = {
  'pt-BR': { ...RC_PT, ...ENGINE_PT },
  en: { ...RC_EN, ...ENGINE_EN },
};

let current: Lang = 'pt-BR';

/** The language stored by the player (Portuguese when none). */
export function storedLang(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'pt-BR' || v === 'en') return v;
    const old = localStorage.getItem(OLD_KEY);
    if (old === 'en') return 'en';
  } catch { /* no storage */ }
  return 'pt-BR';
}

/** Sets the language for this page (called once at start-up). */
export function initLang(l: Lang): void {
  current = l;
  if (typeof document !== 'undefined') document.documentElement.lang = l;
}

export function lang(): Lang { return current; }

/** Called before the page reloads for another language (the game saves the city); false keeps the current language. */
let beforeReload: (() => Promise<boolean>) | null = null;
export function onLanguageReload(fn: () => Promise<boolean>): void { beforeReload = fn; }

/** Keeps the choice and reloads, once the game has saved: the panels are built again in the new language. */
export async function setLang(l: Lang): Promise<void> {
  if (l !== current && beforeReload && !(await beforeReload())) return;
  try { localStorage.setItem(KEY, l); localStorage.setItem(OLD_KEY, l === 'en' ? 'en' : 'pt'); } catch { /* no storage */ }
  if (l !== current) location.reload();
}

/** The text of a key, with `{name}` placeholders filled from `params`. A missing key shows itself (easy to spot). */
export function t(key: string, params?: Readonly<Record<string, string | number>>): string {
  const s = TABLES[current][key] ?? TABLES['pt-BR'][key] ?? key;
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

/** Whether a key exists in the dictionary. */
export function has(key: string): boolean { return key in TABLES[current]; }

/** The `.one` or `.other` form by count, the count passed as `{count}`. */
export function plural(key: string, count: number, params?: Readonly<Record<string, string | number>>): string {
  return t(count === 1 ? `${key}.one` : `${key}.other`, { count: fmtInt(count), ...params });
}

const ints = new Map<string, Intl.NumberFormat>();
/** A whole number in the language's notation ("12.345" or "12,345"). */
export function fmtInt(n: number): string {
  let f = ints.get(current);
  if (!f) ints.set(current, f = new Intl.NumberFormat(current, { maximumFractionDigits: 0 }));
  return f.format(Math.round(n));
}

/** A measure with `digits` decimals ("3,5" or "3.5"). */
export function fmtDec(n: number, digits = 1): string {
  return new Intl.NumberFormat(current, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}

/** A big count shortened ("17 mil" / "17k"). */
export function fmtCount(n: number): string {
  return n >= 10000 ? t('fmt.thousands', { n: Math.round(n / 1000) }) : fmtInt(n);
}

/** Money as the game shows it ("R$ 20.000.000"). */
export function money(n: number): string { return t('economy.money', { value: fmtInt(n) }); }

/** Text written in Portuguese elsewhere in the engine, shown in the player's language. */
export function loose(s: string): string { return current === 'en' ? legacyTranslate(s) : s; }

/** Kept for the engine's test of the phrase table. */
export const translate = legacyTranslate;

/**
 * Keeps an element written by another area in Portuguese (the buildings session's creator) in the player's
 * language: its text is translated now and whenever it changes. Nothing to do in Portuguese.
 */
export function followLanguage(el: HTMLElement): void {
  if (current !== 'en') return;
  const walk = (n: Node): void => {
    if (n.nodeType === Node.TEXT_NODE) { const v = n.nodeValue ?? ''; const x = legacyTranslate(v); if (x !== v) n.nodeValue = x; return; }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const e = n as Element;
    for (const a of ['title', 'placeholder', 'aria-label']) { const v = e.getAttribute(a); if (v) { const x = legacyTranslate(v); if (x !== v) e.setAttribute(a, x); } }
    for (let c = e.firstChild; c; c = c.nextSibling) walk(c);
  };
  walk(el);
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'childList') m.addedNodes.forEach(walk);
      else walk(m.target);
    }
  }).observe(el, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title', 'placeholder', 'aria-label'] });
}

/** A touch screen (a finger, not a mouse): the hints say "tap" where they say "click". */
export const isTouch = (): boolean => typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

/** A hint as a touch player reads it. */
export function forTouch(s: string): string {
  if (!isTouch()) return s;
  const from = t('ui.touch.click'), to = t('ui.touch.tap');
  return s.split(from).join(to).split(from.toLowerCase()).join(to.toLowerCase());
}

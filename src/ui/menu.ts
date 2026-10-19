// The start screen, in Roadcraft's look: a new city from a seed, an empty map, the last game, options, language
// and (in the executable) quit, over the map as it loads behind.

import { MAP_SIZES, MAP_TILES, TILE_SIZE } from '../config.ts';
import { choices, el, orow, select } from './dom.ts';
import { svg } from './icons.ts';
import { LANGUAGES, lang, onLanguageChange, setLang, t } from './i18n.ts';

export interface MenuActions {
  newCity(seed: number, tiles: number): void;
  empty(tiles: number): void;
  load(): void;
  options(): void;
}

export class StartMenu {
  readonly root: HTMLElement;

  private seedNow = String(1 + Math.floor(Math.random() * 9999));
  private tilesNow = MAP_TILES;

  constructor(parent: HTMLElement, maxLayers: number, a: MenuActions) {
    const r = el('div', 'v2-start');
    r.addEventListener('pointerdown', (e) => e.stopPropagation());
    r.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    parent.append(r);
    this.root = r;
    this.build(maxLayers, a);
    // another language: the screen written again, the seed and the size kept (Roadcraft 4.0 changes it in place)
    onLanguageChange(() => this.build(maxLayers, a));
  }

  private build(maxLayers: number, a: MenuActions): void {
    const r = this.root;
    const box = el('div', 'v2-start-box');
    const brand = el('div', 'v2-start-brand');
    brand.innerHTML = svg('roads', 40);
    const h = el('h1');
    h.append('Road', el('b', '', 'craft'));
    brand.append(h);
    const sub = el('p', 'v2-start-sub', t('ui.start.sub'));
    const seed = el('input', 'v2-search');
    seed.type = 'number'; seed.min = '1'; seed.value = this.seedNow;
    seed.addEventListener('input', () => { this.seedNow = seed.value; });
    seed.addEventListener('keydown', (e) => e.stopPropagation());
    const sizes = MAP_SIZES.map((tiles) => [tiles, `${Math.round(tiles * TILE_SIZE / 1000)} km × ${Math.round(tiles * TILE_SIZE / 1000)} km`] as const);
    const size = select(t('ui.start.size'), sizes, this.tilesNow, (v) => { this.tilesNow = Number(v); });
    // one tile per texture layer: cards with few layers cannot open the larger maps
    for (const o of size.options) if (Number(o.value) ** 2 > maxLayers) o.disabled = true;
    const tiles = (): number => Number(size.value);
    const close = (): void => r.classList.add('hidden');
    const big = (label: string, icon: string, fn: () => void, primary = false): HTMLButtonElement => {
      const b = el('button', `v2-btn${primary ? ' primary' : ''}`);
      b.type = 'button';
      b.innerHTML = svg(icon, 18);
      b.append(el('span', '', label));
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      return b;
    };
    const list = el('div', 'v2-start-buttons');
    list.append(
      big(t('ui.start.generate'), 'generate', () => { close(); a.newCity(Math.max(1, Number(seed.value) >>> 0), tiles()); }, true),
      big(t('ui.start.empty'), 'm_new', () => { close(); a.empty(tiles()); }),
      big(t('ui.menu.load'), 'm_open', () => { close(); a.load(); }),
      big(t('ui.options.title'), 'm_quality', () => a.options()),
    );
    // quitting only makes sense in the executable
    // through the main process: closing the window that way saves first (window.close() from the page would skip it)
    const app = (globalThis as { roadcraftApp?: { quit(): void } }).roadcraftApp;
    if (app) list.append(big(t('ui.start.quit'), 'close', () => app.quit()));
    const langs = el('div', 'v2-start-langs');
    langs.append(choices(LANGUAGES.map(([code, name]) => ({ label: name, on: lang() === code, run: () => setLang(code) }))));
    box.append(brand, sub, orow(t('ui.start.seed'), seed), orow(t('ui.start.size'), size), list, langs);
    r.replaceChildren(box);
  }

  get open(): boolean { return !this.root.classList.contains('hidden'); }
  show(): void { this.root.classList.remove('hidden'); }
  hide(): void { this.root.classList.add('hidden'); }
}

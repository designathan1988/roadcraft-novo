// The game's options (quality, resolution, weather, simulation, road markings, sound, language) with presets,
// in Roadcraft's dialog look. Kept in the browser/Electron (localStorage when it works); without it, the defaults.

import { LANGUAGES, lang, loose, onLanguageChange, setLang, t, type Lang } from '../shared/i18n/index.ts';
import type { SkyMode } from './hudActions.ts';
import { keyName, reservedKeys } from './keys.ts';

export type Preset = 'baixo' | 'medio' | 'alto' | 'ultra';

export interface Settings {
  preset: Preset | 'personalizado';
  /** Fraction of the screen resolution (0.5 to 1). */
  resolution: number;
  shadows: boolean;
  ao: boolean;
  bloom: boolean;
  /** Multiplies the detail distances (0.6 to 1.6). */
  detail: number;
  weather: 'auto' | 'limpo' | 'chuva' | 'tempestade';
  /** Ambient sound volume (0..1). */
  volume?: number;
  /** Simulation: demand (low, normal, peak), traffic and people (fraction). */
  demand?: 'baixa' | 'normal' | 'pico';
  traffic?: number;
  people?: number;
  /** Furniture of new roads: 0 complete, 1 basic, 2 none. */
  furniture?: number;
  /** Always day, always night or the clock's light (Roadcraft 4.0 keeps it with the player, not with the map). */
  sky?: SkyMode;
  /** Road tool keys (key codes): raise and lower the road. */
  roadUp?: string;
  roadDown?: string;
  /** Road tool key that cycles the alignment: straight, curve, free (Roadcraft 4.0; default V). */
  roadAlign?: string;
}

/** Keys the game already uses (they cannot be picked for the road): read from the key table (keys.ts). */
const RESERVED = reservedKeys();
/** The road keys' defaults: Page Up, Page Down, V. */
const ROAD_DEFAULTS = ['PageUp', 'PageDown', 'KeyV'];

export const PRESETS: Record<Preset, Omit<Settings, 'preset' | 'weather'>> = {
  baixo: { resolution: 0.75, shadows: false, ao: false, bloom: false, detail: 0.7 },
  medio: { resolution: 1, shadows: true, ao: false, bloom: true, detail: 0.9 },
  alto: { resolution: 1, shadows: true, ao: true, bloom: true, detail: 1 },
  ultra: { resolution: 1, shadows: true, ao: true, bloom: true, detail: 1.4 },
};

const KEY = 'cidade.opcoes';

export function defaultSettings(webgpu: boolean): Settings {
  return { preset: webgpu ? 'alto' : 'baixo', ...PRESETS[webgpu ? 'alto' : 'baixo'], weather: 'limpo' };
}

export function loadSettings(webgpu: boolean): Settings {
  const base = defaultSettings(webgpu);
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) Object.assign(base, JSON.parse(raw));
  } catch { /* no storage: defaults */ }
  if (!webgpu) Object.assign(base, PRESETS.baixo, { preset: 'baixo' }); // compatibility mode: always Low
  // clear weather by default (the player, 2026-10-19): 'auto' brought rain; rain only when the player picks it
  if (base.weather === 'auto') base.weather = 'limpo';
  return base;
}

/** The player's own values of the options a photo parameter in the address replaced (they are what is kept). */
let fromAddress: Partial<Settings> = {};

/** After the address changed some options for this run (?simples, ?semsombra…): those are never stored. */
export function keepOverAddress(before: Settings, after: Settings): void {
  fromAddress = {};
  for (const k of Object.keys(after) as Array<keyof Settings>) if (after[k] !== before[k]) (fromAddress as Record<string, unknown>)[k] = before[k];
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify({ ...s, ...fromAddress })); } catch { /* ignored */ }
}

/** The options dialog. `apply` receives the new options; `current` gives the game's options as they are now. */
export class OptionsPanel {
  readonly root: HTMLElement;
  private current: () => Settings;
  private apply: (s: Settings) => void;
  private webgpu: boolean;
  private extra: Array<[string, string, () => void]>;

  /** The graphics card's name as the driver gives it (the dialog shows it, as Roadcraft 4.0). */
  private gpu: () => string;

  constructor(parent: HTMLElement, current: () => Settings, webgpu: boolean, apply: (s: Settings) => void, extra: Array<[string, string, () => void]> = [], gpu: () => string = () => '') {
    this.gpu = gpu;
    this.current = current;
    this.extra = extra;
    this.apply = apply;
    this.webgpu = webgpu;
    this.root = document.createElement('div');
    this.root.className = 'v2-dialog-back hidden';
    this.root.addEventListener('pointerdown', (e) => { e.stopPropagation(); if (e.target === this.root) this.close(); });
    this.root.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    parent.append(this.root);
    // another language (this dialog's own row among them): written again at once, the choices not yet applied kept
    onLanguageChange(() => { if (this.isOpen) this.render(this.shown); });
  }

  /** The choices the dialog shows now (not applied yet). */
  private shown: Settings = {} as Settings;

  /** The game's options when the dialog opened. */
  private opened: Settings = {} as Settings;
  open(): void { this.opened = { ...this.current() }; this.root.classList.remove('hidden'); this.render({ ...this.opened }); }
  close(): void { this.root.classList.add('hidden'); this.stopCapture(); }
  /** A road key being captured (click on the key, then the key): closing the dialog drops it. */
  private stopCapture = (): void => undefined;
  get isOpen(): boolean { return !this.root.classList.contains('hidden'); }

  /** `s`: a copy of the game's options, taken when the dialog opens (Close leaves the game's options untouched). */
  private render(s: Settings): void {
    this.shown = s;
    const box = document.createElement('div');
    box.className = 'v2-dialog';
    const h = document.createElement('h2');
    h.textContent = t('ui.options.title');
    box.append(h);
    const row = (label: string, el: HTMLElement): void => {
      const d = document.createElement('div'); d.className = 'opt-row';
      const l = document.createElement('span'); l.textContent = label;
      d.append(l, el); box.append(d);
    };
    const select = <V extends string>(value: V, opts: Array<[V, string]>, on: (v: V) => void, disabled = false): HTMLSelectElement => {
      const e = document.createElement('select');
      for (const [v, text] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = text; e.append(o); }
      e.value = value; e.disabled = disabled;
      e.addEventListener('change', () => on(e.value as V));
      return e;
    };
    const check = (value: boolean, on: (v: boolean) => void): HTMLInputElement => {
      const e = document.createElement('input'); e.type = 'checkbox'; e.checked = value; e.disabled = !this.webgpu;
      e.addEventListener('change', () => on(e.checked));
      return e;
    };
    const range = (value: number, min: number, max: number, step: number, fmt: (v: number) => string, on: (v: number) => void): HTMLElement => {
      const wrap = document.createElement('span');
      const e = document.createElement('input'); e.type = 'range'; e.min = String(min); e.max = String(max); e.step = String(step); e.value = String(value);
      const v = document.createElement('span'); v.className = 'value'; v.textContent = fmt(value);
      e.addEventListener('input', () => { v.textContent = fmt(Number(e.value)); });
      e.addEventListener('change', () => on(Number(e.value)));
      wrap.append(e, v);
      return wrap;
    };
    const pct = (v: number): string => `${Math.round(v * 100)}%`;
    const custom = (): void => { s.preset = 'personalizado'; presetSel.value = 'personalizado'; };
    const presetSel = select(s.preset, [['baixo', t('quality.low')], ['medio', t('quality.medium')], ['alto', t('quality.high')], ['ultra', t('quality.ultra')], ['personalizado', t('ui.options.custom')]], (v) => {
      if (v !== 'personalizado') Object.assign(s, PRESETS[v as Preset]);
      s.preset = v; this.render(s);
    }, !this.webgpu);
    row(t('gfx.preset'), presetSel);
    row(t('ui.options.resolution'), range(s.resolution, 0.5, 1, 0.05, pct, (v) => { s.resolution = v; custom(); }));
    row(t('ui.options.detail'), range(s.detail, 0.6, 1.6, 0.1, (v) => `${v.toFixed(1)}×`, (v) => { s.detail = v; custom(); }));
    row(t('gfx.shadows'), check(s.shadows, (v) => { s.shadows = v; custom(); }));
    row(t('gfx.ao'), check(s.ao, (v) => { s.ao = v; custom(); }));
    row(t('ui.options.bloom'), check(s.bloom, (v) => { s.bloom = v; custom(); }));
    row(t('sim.demand'), select(s.demand ?? 'normal', [['baixa', t('sim.demand.low')], ['normal', t('sim.demand.normal')], ['pico', t('sim.demand.peak')]], (v) => { s.demand = v; }));
    row(t('sim.traffic'), range(s.traffic ?? 1, 0.1, 2, 0.1, pct, (v) => { s.traffic = v; }));
    row(t('sim.people'), range(s.people ?? 1, 0.1, 2, 0.1, pct, (v) => { s.people = v; }));
    row(t('roadFurniture.row'), select(String(s.furniture ?? 0), [['0', t('roadFurniture.complete')], ['1', t('roadFurniture.basic')], ['2', t('roadFurniture.none')]], (v) => { s.furniture = Number(v); }));
    {
      // road keys: click and press the new key
      const keyBtn = (get: () => string, set: (c: string) => void): HTMLButtonElement => {
        const b = document.createElement('button');
        b.className = 'v2-btn';
        b.textContent = keyName(get());
        b.addEventListener('click', () => {
          b.textContent = t('roadKeys.press');
          this.stopCapture();
          const on = (ev: KeyboardEvent): void => {
            ev.preventDefault(); ev.stopPropagation();
            this.stopCapture();
            if (ev.code === 'Escape') { b.textContent = keyName(get()); return; }
            // the game's keys are refused, except the road keys' own defaults (Page Up / Down tilt the camera, V the view)
            if (RESERVED.has(ev.code) && !ROAD_DEFAULTS.includes(ev.code)) { b.textContent = t('roadKeys.reserved', { key: keyName(ev.code) }); setTimeout(() => { b.textContent = keyName(get()); }, 1600); return; }
            set(ev.code); b.textContent = keyName(ev.code);
          };
          window.addEventListener('keydown', on, true);
          this.stopCapture = () => { window.removeEventListener('keydown', on, true); this.stopCapture = () => undefined; };
        });
        return b;
      };
      const wrap = document.createElement('span');
      const lu = document.createElement('span'); lu.textContent = t('roadKeys.heightUp');
      const ld = document.createElement('span'); ld.textContent = t('roadKeys.heightDown');
      const la = document.createElement('span'); la.textContent = t('roadKeys.alignment');
      const reset = document.createElement('button'); reset.className = 'v2-btn'; reset.textContent = t('roadKeys.reset');
      reset.addEventListener('click', () => { this.stopCapture(); s.roadUp = 'PageUp'; s.roadDown = 'PageDown'; s.roadAlign = 'KeyV'; this.render(s); });
      wrap.append(lu, keyBtn(() => s.roadUp ?? 'PageUp', (c) => { s.roadUp = c; }), ld, keyBtn(() => s.roadDown ?? 'PageDown', (c) => { s.roadDown = c; }),
        la, keyBtn(() => s.roadAlign ?? 'KeyV', (c) => { s.roadAlign = c; }), reset);
      row(t('roadKeys.title'), wrap);
    }
    row(t('ui.options.weather'), select(s.weather, [['auto', t('ui.weather.auto')], ['limpo', t('ui.options.clear')], ['chuva', t('weather.rain').replace(/\s*\(.*$/, '')], ['tempestade', t('weather.storm')]], (v) => { s.weather = v; }));
    row(t('menu.language'), select<Lang>(lang(), LANGUAGES.map(([c, name]) => [c, name] as [Lang, string]), (v) => setLang(v)));
    row(t('ui.options.volume'), range(s.volume ?? 0.6, 0, 1, 0.05, pct, (v) => { s.volume = v; }));
    {
      // full screen at once, as Roadcraft 4.0 (it is the window's state, not an option kept)
      const fs = document.createElement('input'); fs.type = 'checkbox'; fs.checked = !!document.fullscreenElement;
      fs.addEventListener('change', () => { if (fs.checked) void document.documentElement.requestFullscreen?.().catch(() => { fs.checked = false; }); else void document.exitFullscreen?.().catch(() => undefined); });
      row(t('gfx.fullscreen'), fs);
    }
    if (!this.webgpu) {
      const p = document.createElement('p'); p.className = 'opt-note';
      p.textContent = t('ui.options.compat');
      box.append(p);
    }
    for (const [label, title, fn] of this.extra) {
      const b = document.createElement('button'); b.className = 'v2-btn'; b.textContent = loose(label); b.title = loose(title);
      b.addEventListener('click', () => { this.close(); fn(); });
      row(t('ui.options.game'), b);
    }
    const name = this.gpu();
    if (name) { const g = document.createElement('p'); g.className = 'opt-note opt-gpu'; g.textContent = `${t('gfx.gpu')}: ${name}`; box.append(g); }
    const buttons = document.createElement('div'); buttons.className = 'opt-buttons';
    const ok = document.createElement('button'); ok.className = 'v2-btn primary'; ok.textContent = t('ui.options.apply');
    // what other panels changed while the dialog was open (simulation and furniture) is kept
    ok.addEventListener('click', () => {
      const now = this.current(), opened = this.opened;
      for (const k of Object.keys(s) as Array<keyof Settings>) if (s[k] === opened[k] && now[k] !== opened[k]) (s as unknown as Record<string, unknown>)[k] = now[k];
      saveSettings(s); this.apply({ ...s }); this.close();
    });
    const cancel = document.createElement('button'); cancel.className = 'v2-btn'; cancel.textContent = t('gfx.close');
    cancel.addEventListener('click', () => this.close());
    buttons.append(cancel, ok);
    box.append(buttons);
    this.root.replaceChildren(box);
  }
}

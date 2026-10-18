// Opções do jogo (qualidade, resolução, tempo) com presets. Guardadas no
// navegador/Electron (localStorage, se der); sem ele, valem os padrões.

import { currentLang, setLang, type Lang } from './i18n.ts';

export type Preset = 'baixo' | 'medio' | 'alto' | 'ultra';

export interface Settings {
  preset: Preset | 'personalizado';
  /** Fração da resolução da tela (0,5 a 1). */
  resolution: number;
  shadows: boolean;
  ao: boolean;
  bloom: boolean;
  /** Multiplica as distâncias de detalhe (0,6 a 1,6). */
  detail: number;
  weather: 'auto' | 'limpo' | 'chuva' | 'tempestade';
  /** Volume do som ambiente (0..1). */
  volume?: number;
  /** Simulação: demanda (baixa, normal, pico), tráfego e pessoas (fração). */
  demand?: 'baixa' | 'normal' | 'pico';
  traffic?: number;
  people?: number;
  /** Pintura das vias: br, us, eu, classic. */
  paint?: string;
  /** Mobiliário das vias novas: 0 completo, 1 básico, 2 nenhum. */
  furniture?: number;
  /** Teclas da ferramenta de vias (código da tecla): subir e descer a via. */
  roadUp?: string;
  roadDown?: string;
}

/** Teclas que o jogo já usa (não podem ser escolhidas para a via). */
const RESERVED = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyR', 'KeyF', 'KeyZ', 'KeyB', 'KeyL', 'KeyC', 'KeyV', 'KeyP', 'KeyK', 'KeyO', 'KeyT', 'KeyI', 'KeyJ', 'KeyM', 'KeyU', 'KeyG', 'KeyN', 'KeyH', 'KeyX', 'KeyY',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Space', 'Escape', 'Enter', 'Backspace', 'Delete', 'F1', 'F9', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'BracketLeft', 'BracketRight']);

/** Nome legível de uma tecla. */
export function keyName(code: string): string { return code.replace(/^Key/, '').replace(/^Digit/, '').replace('PageUp', 'Page Up').replace('PageDown', 'Page Down'); }

export const PRESETS: Record<Preset, Omit<Settings, 'preset' | 'weather'>> = {
  baixo: { resolution: 0.75, shadows: false, ao: false, bloom: false, detail: 0.7 },
  medio: { resolution: 1, shadows: true, ao: false, bloom: true, detail: 0.9 },
  alto: { resolution: 1, shadows: true, ao: true, bloom: true, detail: 1 },
  ultra: { resolution: 1, shadows: true, ao: true, bloom: true, detail: 1.4 },
};

const KEY = 'cidade.opcoes';

export function defaultSettings(webgpu: boolean): Settings {
  return { preset: webgpu ? 'alto' : 'baixo', ...PRESETS[webgpu ? 'alto' : 'baixo'], weather: 'auto' };
}

export function loadSettings(webgpu: boolean): Settings {
  const base = defaultSettings(webgpu);
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) Object.assign(base, JSON.parse(raw));
  } catch { /* sem armazenamento: padrões */ }
  if (!webgpu) Object.assign(base, PRESETS.baixo, { preset: 'baixo' }); // compatibilidade: sempre Baixo
  return base;
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignora */ }
}

/** Painel de opções (modal simples). `apply` recebe as opções novas. */
export class OptionsPanel {
  readonly root: HTMLElement;
  private s: Settings;
  private apply: (s: Settings) => void;
  private webgpu: boolean;

  private extra: Array<[string, string, () => void]>;

  constructor(parent: HTMLElement, s: Settings, webgpu: boolean, apply: (s: Settings) => void, extra: Array<[string, string, () => void]> = []) {
    this.s = { ...s };
    this.extra = extra;
    this.apply = apply;
    this.webgpu = webgpu;
    this.root = document.createElement('div');
    this.root.className = 'options hidden';
    parent.append(this.root);
    this.render();
  }

  open(): void { this.root.classList.remove('hidden'); this.render(); }
  close(): void { this.root.classList.add('hidden'); }
  get isOpen(): boolean { return !this.root.classList.contains('hidden'); }

  private render(): void {
    const s = this.s;
    const r = this.root;
    r.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'options-box';
    const h = document.createElement('h2');
    h.textContent = 'Opções';
    box.append(h);
    const row = (label: string, el: HTMLElement) => {
      const d = document.createElement('div'); d.className = 'opt-row';
      const l = document.createElement('span'); l.textContent = label;
      d.append(l, el); box.append(d);
    };
    const select = <V extends string>(value: V, opts: Array<[V, string]>, on: (v: V) => void, disabled = false) => {
      const e = document.createElement('select');
      for (const [v, t] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = t; e.append(o); }
      e.value = value; e.disabled = disabled;
      e.addEventListener('change', () => on(e.value as V));
      return e;
    };
    const check = (value: boolean, on: (v: boolean) => void) => {
      const e = document.createElement('input'); e.type = 'checkbox'; e.checked = value; e.disabled = !this.webgpu;
      e.addEventListener('change', () => on(e.checked));
      return e;
    };
    const range = (value: number, min: number, max: number, step: number, fmt: (v: number) => string, on: (v: number) => void) => {
      const wrap = document.createElement('span');
      const e = document.createElement('input'); e.type = 'range'; e.min = String(min); e.max = String(max); e.step = String(step); e.value = String(value);
      const t = document.createElement('span'); t.className = 'value'; t.textContent = fmt(value);
      e.addEventListener('input', () => { t.textContent = fmt(Number(e.value)); });
      e.addEventListener('change', () => on(Number(e.value)));
      wrap.append(e, t);
      return wrap;
    };
    const custom = () => { s.preset = 'personalizado'; this.render(); };
    row('Qualidade', select(s.preset, [['baixo', 'Baixo'], ['medio', 'Médio'], ['alto', 'Alto'], ['ultra', 'Ultra'], ['personalizado', 'Personalizado']], (v) => {
      if (v !== 'personalizado') Object.assign(s, PRESETS[v as Preset]);
      s.preset = v; this.render();
    }, !this.webgpu));
    row('Resolução', range(s.resolution, 0.5, 1, 0.05, (v) => `${Math.round(v * 100)}%`, (v) => { s.resolution = v; custom(); }));
    row('Detalhe ao longe', range(s.detail, 0.6, 1.6, 0.1, (v) => `${v.toFixed(1)}×`, (v) => { s.detail = v; custom(); }));
    row('Sombras', check(s.shadows, (v) => { s.shadows = v; custom(); }));
    row('Oclusão de ambiente', check(s.ao, (v) => { s.ao = v; custom(); }));
    row('Brilho das luzes', check(s.bloom, (v) => { s.bloom = v; custom(); }));
    row('Demanda de viagens', select(s.demand ?? 'normal', [['baixa', 'Baixa'], ['normal', 'Normal'], ['pico', 'Pico']], (v) => { s.demand = v; }));
    row('Tráfego', range(s.traffic ?? 1, 0.1, 2, 0.1, (v) => `${Math.round(v * 100)}%`, (v) => { s.traffic = v; }));
    row('Pessoas', range(s.people ?? 1, 0.1, 2, 0.1, (v) => `${Math.round(v * 100)}%`, (v) => { s.people = v; }));
    row('Pintura das vias', select(s.paint ?? 'br', [['br', 'Brasil'], ['us', 'EUA'], ['eu', 'Europa'], ['classic', 'Clássica']], (v) => { s.paint = v; }));
    row('Mobiliário das vias novas', select(String(s.furniture ?? 0), [['0', 'Completo'], ['1', 'Básico (só postes)'], ['2', 'Nenhum']], (v) => { s.furniture = Number(v); }));
    {
      // teclas da via: clique e aperte a tecla nova
      const keyBtn = (get: () => string, set: (c: string) => void) => {
        const b = document.createElement('button');
        b.textContent = keyName(get());
        b.addEventListener('click', () => {
          b.textContent = 'Aperte uma tecla…';
          const on = (ev: KeyboardEvent) => {
            ev.preventDefault(); ev.stopPropagation();
            window.removeEventListener('keydown', on, true);
            if (ev.code === 'Escape') { b.textContent = keyName(get()); return; }
            if (RESERVED.has(ev.code)) { b.textContent = `${keyName(ev.code)} já é usada pelo jogo. Escolha outra.`; setTimeout(() => { b.textContent = keyName(get()); }, 1600); return; }
            set(ev.code); b.textContent = keyName(ev.code);
          };
          window.addEventListener('keydown', on, true);
        });
        return b;
      };
      const wrap = document.createElement('span'); wrap.className = 'inline';
      const lu = document.createElement('span'); lu.textContent = 'Subir';
      const ld = document.createElement('span'); ld.textContent = 'Descer';
      wrap.append(lu, keyBtn(() => s.roadUp ?? 'PageUp', (c) => { s.roadUp = c; }), ld, keyBtn(() => s.roadDown ?? 'PageDown', (c) => { s.roadDown = c; }));
      row('Teclas da via', wrap);
    }
    row('Tempo', select(s.weather, [['auto', 'Muda sozinho'], ['limpo', 'Sempre limpo'], ['chuva', 'Chuva'], ['tempestade', 'Tempestade']], (v) => { s.weather = v; }));
    {
      const lang = document.createElement('select');
      for (const [v, t] of [['pt', 'Português'], ['en', 'English']]) { const o = document.createElement('option'); o.value = v; o.textContent = t; lang.append(o); }
      lang.value = currentLang();
      lang.addEventListener('change', () => setLang(lang.value as Lang));
      row('Idioma', lang);
    }
    row('Som ambiente', range(s.volume ?? 0.6, 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`, (v) => { s.volume = v; }));
    if (!this.webgpu) {
      const p = document.createElement('p'); p.className = 'opt-note';
      p.textContent = 'Modo de compatibilidade (WebGL 2): qualidade Baixo.';
      box.append(p);
    }
    for (const [label, title, fn] of this.extra) {
      const b = document.createElement('button'); b.textContent = label; b.title = title;
      b.addEventListener('click', () => { this.close(); fn(); });
      row(label === 'Carregar o pior caso' ? 'Teste' : 'Jogo', b);
    }
    const buttons = document.createElement('div'); buttons.className = 'opt-buttons';
    const ok = document.createElement('button'); ok.textContent = 'Aplicar';
    ok.addEventListener('click', () => { saveSettings(s); this.apply({ ...s }); this.close(); });
    const cancel = document.createElement('button'); cancel.textContent = 'Fechar';
    cancel.addEventListener('click', () => this.close());
    buttons.append(cancel, ok);
    box.append(buttons);
    r.append(box);
  }
}

// The road catalogue in the Roads drawer (Roadcraft's catalogPanel: tabs by category, a card drawn from above for
// each road, its width and price) and the cross-section editor (Roadcraft's profile editor, Streetmix-like): the
// player builds the road strip by strip, sets widths, direction, bus lanes, arrows, paving and speed, and draws
// with it or saves it as a template. Cards are drawn once per category shown; picking a road only moves the ring.

import {
  PROFILES, PROFILE_INFO, Paving, Surface, TurnBit, normalize, profileIssues, registerProfile,
  type Category, type ProfileIssue, type Centre, type Profile, type Strip, type StripKind,
} from '../roads/profiles.ts';
import { el } from './dom.ts';
import { svg } from './icons.ts';
import { fmtDec, loose, money, plural, t } from './i18n.ts';

const CATS: Array<[Category, string]> = [['ruas', 'catalog.cat.streets'], ['avenidas', 'catalog.cat.avenues'], ['rodovias', 'catalog.cat.highways'],
  ['especiais', 'catalog.cat.special'], ['trilhos', 'catalog.cat.rails'], ['meus', 'catalog.cat.mine']];
const KIND_KEY: Record<StripKind, string> = {
  sidewalk: 'profile.element.footway', curb: 'ui.strip.curb', parking: 'profile.element.parking', bike: 'profile.element.cycle', lane: 'profile.element.lane',
  median: 'profile.element.median', shoulder: 'ui.strip.shoulder', barrier: 'ui.strip.barrier',
};
const KIND_COLOR: Record<StripKind, string> = {
  sidewalk: '#bcb5a7', curb: '#e0dbd2', parking: '#55585c', bike: '#3f8f55', lane: '#45484c', median: '#5e8a46', shoulder: '#5f6164', barrier: '#a9a59d',
};
const WIDTH_LIMIT: Record<StripKind, [number, number]> = {
  sidewalk: [1, 12], curb: [0.1, 0.4], parking: [2, 3], bike: [1.2, 2.5], lane: [2.5, 4.5], median: [0.5, 20], shoulder: [0.5, 4], barrier: [0.3, 1.2],
};
const TURNS: Array<[number, string]> = [
  [0, 'ui.turn.auto'], [TurnBit.Left | TurnBit.Straight | TurnBit.Right, 'road.turn.all'], [TurnBit.Left, 'road.turn.left'], [TurnBit.Straight, 'road.turn.through'],
  [TurnBit.Right, 'road.turn.right'], [TurnBit.Left | TurnBit.Straight, 'road.turn.leftThrough'], [TurnBit.Straight | TurnBit.Right, 'road.turn.throughRight'],
];
const STORE = 'cidade.modelosDeVia';

export interface CatalogActions {
  use(id: number): void;
  toast(text: string): void;
}

/** The player's templates, kept in the browser (they serve every map). */
function readTemplates(): Array<Omit<Profile, 'id'>> {
  try {
    const raw = localStorage.getItem(STORE);
    const list = raw ? JSON.parse(raw) as Array<Omit<Profile, 'id'>> : [];
    return Array.isArray(list) ? list.filter((p) => p && Array.isArray(p.strips) && p.strips.length > 0) : [];
  } catch { return []; }
}
function writeTemplates(list: Array<Omit<Profile, 'id'>>): boolean {
  try { localStorage.setItem(STORE, JSON.stringify(list)); return true; } catch { return false; }
}

/** A road's name in the player's language (the engine names its profiles in Portuguese). */
export const profileName = (p: { name: string; custom?: boolean }): string => (p.custom ? p.name : loose(p.name));

/** The strips from the image's left edge to its right (seen from A to B, the right edge on the right). */
const leftToRight = (p: Omit<Profile, 'id'>): Strip[] => p.strips.slice().reverse();

/**
 * A road seen FROM ABOVE, as the game draws it (Roadcraft's profileSwatch): pavements in their paving, kerbs,
 * asphalt, parked cars, lane lines, arrows on one-way roads. The strips run across the tile from top to bottom.
 */
export function topSwatch(p: Omit<Profile, 'id'>, span: number, width = 124, height = 64, dpr = 2): string {
  const cv = document.createElement('canvas');
  cv.width = width * dpr; cv.height = height * dpr;
  const g = cv.getContext('2d');
  if (!g) return '';
  g.scale(dpr, dpr);
  const bg = g.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, '#55753f'); bg.addColorStop(1, '#476536');
  g.fillStyle = bg; g.fillRect(0, 0, width, height);
  const strips = leftToRight(p);
  const total = strips.reduce((s, x) => s + x.width, 0) || 1;
  const fill = 0.62 + 0.24 * Math.min(1, total / Math.max(span, 1e-6));
  const k = height * fill / total;
  const asphalt = p.surface === Surface.Concrete ? '#9a9a94' : p.surface === Surface.Cobble ? '#7d7468' : p.surface === Surface.Ballast ? '#6b6258' : '#3f4245';
  const cars = ['#c8ccd0', '#2f4f7a', '#b8382e', '#e8e4dc', '#3d3d3d', '#7a8f4f'];
  let y = (height - total * k) / 2;
  const bands: Array<{ s: Strip; y0: number; y1: number }> = [];
  for (const s of strips) {
    const h = Math.max(0.6, s.width * k), y0 = y, y1 = y + h;
    switch (s.kind) {
      case 'sidewalk':
        g.fillStyle = s.pave === Paving.Pavers ? '#c4c0b4' : s.pave === Paving.Stone ? '#a9a294' : '#bdbdb7';
        g.fillRect(0, y0, width, h);
        g.fillStyle = 'rgba(0,0,0,0.08)';
        for (let x = 3; x < width; x += 6) g.fillRect(x, y0, 0.6, h);
        break;
      case 'median':
        g.fillStyle = s.pave === Paving.Concrete ? '#a8a69e' : s.pave === Paving.Pavers ? '#b6b0a2' : '#5e8a46';
        g.fillRect(0, y0, width, h);
        if ((s.pave ?? Paving.Grass) === Paving.Grass && h >= 3) {
          for (let x = 8; x < width; x += 18) {
            g.fillStyle = '#2f5a2a'; g.beginPath(); g.arc(x, (y0 + y1) / 2, Math.min(h * 0.9, 5), 0, Math.PI * 2); g.fill();
            g.fillStyle = '#4f8a3f'; g.beginPath(); g.arc(x - 1, (y0 + y1) / 2 - 1, Math.min(h * 0.55, 3), 0, Math.PI * 2); g.fill();
          }
        }
        break;
      case 'bike': g.fillStyle = '#3f8f55'; g.fillRect(0, y0, width, h); break;
      case 'curb': g.fillStyle = '#e4e1d8'; g.fillRect(0, y0, width, h); break;
      case 'barrier': g.fillStyle = '#a9a59d'; g.fillRect(0, y0, width, h); break;
      case 'shoulder': g.fillStyle = '#4b4e52'; g.fillRect(0, y0, width, h); break;
      case 'parking':
        g.fillStyle = asphalt; g.fillRect(0, y0, width, h);
        g.fillStyle = '#f2f2ee';
        for (let x = 0; x < width; x += 14) g.fillRect(x, y0, 0.8, h);
        for (let x = 2, n = 0; x + 10 < width; x += 14, n++) {
          if ((n * 7) % 3 === 2) continue;
          g.fillStyle = cars[n % cars.length]; g.fillRect(x + 1, y0 + h * 0.18, 9, h * 0.64);
          g.fillStyle = 'rgba(20,30,40,0.55)'; g.fillRect(x + 3, y0 + h * 0.24, 2.5, h * 0.52);
        }
        break;
      case 'lane':
        g.fillStyle = s.bus ? '#8f3a33' : asphalt; g.fillRect(0, y0, width, h);
        if (s.rail) { g.fillStyle = '#8a8a86'; g.fillRect(0, y0 + h * 0.3, width, 0.9); g.fillRect(0, y0 + h * 0.7, width, 0.9); g.fillStyle = 'rgba(80,60,40,0.7)'; for (let x = 1; x < width; x += 4) g.fillRect(x, y0 + h * 0.2, 1.4, h * 0.6); }
        break;
    }
    bands.push({ s, y0, y1 });
    y = y1;
  }
  const lanes = bands.filter((b) => b.s.kind === 'lane' && !b.s.rail);
  for (let i = 0; i + 1 < bands.length; i++) {
    const a = bands[i], b = bands[i + 1];
    if (a.s.kind !== 'lane' || b.s.kind !== 'lane' || a.s.rail) continue;
    const yy = a.y1;
    if ((a.s.dir ?? 1) !== (b.s.dir ?? 1)) { g.fillStyle = '#e8c440'; g.fillRect(0, yy - 1.4, width, 0.9); g.fillRect(0, yy + 0.5, width, 0.9); }
    else { g.fillStyle = '#f2f2ee'; if (b.s.solid) g.fillRect(0, yy - 0.5, width, 1); else for (let x = 2; x < width; x += 10) g.fillRect(x, yy - 0.5, 5, 1); }
  }
  if (p.oneWay) {
    g.fillStyle = '#f2f2ee';
    for (const b of lanes) {
      const cy = (b.y0 + b.y1) / 2, sz = Math.min(3, (b.y1 - b.y0) * 0.35), back = b.s.dir === -1;
      for (const x of [width * 0.3, width * 0.72]) {
        g.beginPath(); g.moveTo(x + (back ? -sz * 1.6 : sz * 1.6), cy); g.lineTo(x + (back ? sz : -sz), cy - sz); g.lineTo(x + (back ? sz : -sz), cy + sz); g.closePath(); g.fill();
      }
    }
  }
  return cv.toDataURL('image/png');
}

/** The cross-section seen across the road (the editor): strips side by side, raised ones higher. */
export function drawSection(cv: HTMLCanvasElement, p: Omit<Profile, 'id'>, selected = -1): Array<[number, number]> {
  const g = cv.getContext('2d')!;
  const W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  const total = p.strips.reduce((s, x) => s + x.width, 0) || 1;
  const k = (W - 4) / total;
  const ranges: Array<[number, number]> = [];
  let x = 2;
  for (let i = p.strips.length - 1; i >= 0; i--) {
    const s = p.strips[i];
    const w = Math.max(1, s.width * k);
    const raised = !s.flush && (s.kind === 'sidewalk' || s.kind === 'median' || s.kind === 'curb');
    const y0 = s.kind === 'barrier' ? H * 0.2 : raised ? H * 0.42 : H * 0.5;
    let col = KIND_COLOR[s.kind];
    if (s.kind === 'lane' && s.bus) col = '#8f3a33';
    if (s.kind === 'lane' && p.surface === Surface.Cobble) col = '#6e675f';
    if (s.kind === 'lane' && p.surface === Surface.Concrete) col = '#8e8b85';
    if (s.kind === 'median' && s.pave === Paving.Concrete) col = KIND_COLOR.barrier;
    if ((s.kind === 'median' || s.kind === 'sidewalk') && s.pave === Paving.Pavers) col = '#a89c8c';
    if (s.kind === 'sidewalk' && s.pave === Paving.Stone) col = '#d8d2c6';
    g.fillStyle = col;
    g.fillRect(x, y0, w, H - y0 - 2);
    if (s.kind === 'lane') {
      g.fillStyle = '#e8e6df';
      const mid = x + w / 2, y = H * 0.72;
      g.beginPath();
      if (s.dir === -1) { g.moveTo(mid - 4, y - 4); g.lineTo(mid + 4, y - 4); g.lineTo(mid, y + 4); }
      else { g.moveTo(mid - 4, y + 4); g.lineTo(mid + 4, y + 4); g.lineTo(mid, y - 4); }
      g.fill();
    }
    if (s.kind === 'median' && (s.pave ?? Paving.Grass) === Paving.Grass && w > 6) {
      g.fillStyle = '#4f6e33';
      g.beginPath(); g.arc(x + w / 2, y0 - 6, Math.min(8, w / 3), 0, Math.PI * 2); g.fill();
    }
    if (i === selected) { g.strokeStyle = '#4fe0bf'; g.lineWidth = 3; g.strokeRect(x + 1.5, 2, w - 3, H - 4); }
    ranges[i] = [x, x + w];
    x += w;
  }
  return ranges;
}

export class RoadCatalog {
  readonly el: HTMLElement;
  readonly editor: SectionEditor;
  private tabs: HTMLElement;
  private grid: HTMLElement;
  private cat: Category = 'ruas';
  private current = 0;
  private built = '';
  private cards = new Map<number, HTMLElement>();
  private art = new Map<string, string>();
  private a: CatalogActions;

  constructor(a: CatalogActions) {
    this.a = a;
    this.el = el('div', 'rc-catalog');
    this.tabs = el('div', 'rc-tabs');
    this.tabs.setAttribute('role', 'tablist');
    this.grid = el('div', 'rc-cards');
    this.grid.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { this.grid.scrollLeft += e.deltaY; e.preventDefault(); } e.stopPropagation(); }, { passive: false });
    this.el.append(this.tabs, this.grid);
    this.editor = new SectionEditor((def, save) => this.fromEditor(def, save), (text) => a.toast(text));
    document.getElementById('hud')!.append(this.editor.el);
  }

  set visible(v: boolean) {
    if (v) this.build(); else { this.el.remove(); this.editor.close(); }
  }

  /** A road picked from outside (eyedropper, key). */
  select(id: number): void {
    this.current = id;
    const p = PROFILES[id];
    if (p?.category && p.category !== this.cat && !p.custom) { this.cat = p.category; this.built = ''; }
    if (this.el.isConnected) this.build();
  }

  private fromEditor(def: Omit<Profile, 'id'>, save: boolean): void {
    if (save) {
      const list = readTemplates().filter((x) => x.name !== def.name);
      list.push({ ...def, category: 'meus', custom: true });
      if (!writeTemplates(list)) this.a.toast(t('profile.notStored'));
      else this.a.toast(t('ui.catalog.saved', { name: def.name }));
    }
    const id = registerProfile({ ...def, category: 'meus', custom: true });
    if (id < 0) { this.a.toast(t('ui.catalog.tooMany')); return; }
    this.current = id;
    if (save) this.cat = 'meus';
    this.built = '';
    this.build();
    this.a.use(id);
  }

  /** Builds the tabs and cards when the category or the list changed; otherwise only moves the ring. */
  private build(): void {
    const items: Array<{ def: Omit<Profile, 'id'>; id: number; del?: () => void }> = [];
    if (this.cat === 'meus') {
      for (const tp of readTemplates()) items.push({ def: tp, id: -1, del: () => { writeTemplates(readTemplates().filter((x) => x.name !== tp.name)); this.built = ''; this.build(); } });
      for (const p of PROFILES) if (p.custom && !items.some((i) => i.def.name === p.name)) items.push({ def: p, id: p.id });
    } else for (const p of PROFILES) if (!p.custom && !p.ring && p.category === this.cat) items.push({ def: p, id: p.id });
    const key = `${this.cat}|${PROFILES.length}|${items.map((i) => i.def.name).join(',')}`;
    if (key !== this.built) {
      this.built = key;
      this.tabs.replaceChildren();
      for (const [c, k] of CATS) {
        const b = el('button', `rc-tab${c === this.cat ? ' on' : ''}`);
        b.type = 'button';
        b.setAttribute('role', 'tab');
        b.dataset.category = c;
        const count = c === 'meus' ? readTemplates().length + PROFILES.filter((p) => p.custom).length : PROFILES.filter((p) => !p.custom && !p.ring && p.category === c).length;
        b.append(el('span', '', t(k)), el('em', '', String(count)));
        b.addEventListener('click', (e) => { e.stopPropagation(); this.cat = c; this.build(); });
        this.tabs.append(b);
      }
      this.grid.replaceChildren();
      this.cards.clear();
      if (!items.length) this.grid.append(el('div', 'rc-empty', t(this.cat === 'meus' ? 'catalog.mineEmpty' : 'catalog.empty')));
      const span = Math.max(...PROFILES.filter((p) => !p.ring).map((p) => p.strips.reduce((s, x) => s + x.width, 0)));
      for (const it of items) {
        const cardEl = el('div', 'rc-card');
        const main = el('button', 'rc-card-main');
        main.type = 'button';
        const info = it.id >= 0 ? PROFILE_INFO[it.id] : null;
        const width = it.def.strips.reduce((s, x) => s + x.width, 0);
        const lanes = it.def.strips.filter((s) => s.kind === 'lane').length;
        const cost = info ? info.cost : Math.round(width * 60);
        main.title = t('catalog.tip', { name: profileName(it.def), lanes: plural('palette.lanes.count', lanes), way: t(it.def.oneWay ? 'catalog.oneWay' : 'catalog.twoWay'), speed: it.def.speed });
        const artKey = `${JSON.stringify(it.def.strips)}|${it.def.surface ?? 0}|${it.def.oneWay}|${span}`;
        let src = this.art.get(artKey);
        if (!src) { src = topSwatch(it.def, span); this.art.set(artKey, src); }
        const img = el('img', 'rc-art');
        img.src = src; img.alt = ''; img.draggable = false;
        main.append(img, el('span', 'rc-name', profileName(it.def)), el('span', 'rc-meta', t('catalog.meta', { width: fmtDec(width), price: money(cost) })));
        main.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = it.id >= 0 ? it.id : registerProfile({ ...it.def, category: 'meus', custom: true });
          if (id < 0) { this.a.toast(t('ui.catalog.tooMany')); return; }
          this.current = id;
          this.editor.close();
          if (it.id < 0) { this.built = ''; this.build(); } else this.mark();
          this.a.use(id);
        });
        cardEl.append(main);
        if (it.del) {
          const x = el('button', 'rc-custom');
          x.type = 'button';
          x.title = t('profileEditor.deleteTemplate');
          x.innerHTML = svg('close', 14);
          x.style.color = 'var(--v-danger-ink)';
          x.addEventListener('click', (e) => { e.stopPropagation(); it.del!(); });
          cardEl.append(x);
        }
        if (it.id >= 0) this.cards.set(it.id, cardEl);
        this.grid.append(cardEl);
      }
    }
    this.mark();
  }

  /** The picked card ringed, with the "Customise…" button on it. */
  private mark(): void {
    for (const [id, c] of this.cards) {
      const on = id === this.current;
      c.classList.toggle('on', on);
      const custom = c.querySelector('.rc-custom.edit');
      if (on && !custom) {
        const b = el('button', 'rc-custom edit');
        b.type = 'button';
        b.title = t('catalog.customise');
        b.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 11.5V13h1.5l6.9-6.9-1.5-1.5L3 11.5zm9.7-6.2a.8.8 0 000-1.1l-.9-.9a.8.8 0 00-1.1 0l-.8.8 1.5 1.5.8-.8z" fill="currentColor"/></svg>';
        const name = el('span', '', t('catalog.customise'));
        name.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)';
        b.append(name);
        b.addEventListener('click', (e) => { e.stopPropagation(); this.editor.open(PROFILES[id]); });
        c.append(b);
      } else if (!on) custom?.remove();
    }
  }
}

/** The cross-section editor (an rp-panel over the map, beside the tool options). */
class SectionEditor {
  readonly el: HTMLElement;
  private def: Omit<Profile, 'id'> | null = null;
  private sel = -1;
  private cv: HTMLCanvasElement;
  private ranges: Array<[number, number]> = [];
  private props: HTMLElement;
  private head: HTMLElement;
  private width: HTMLElement;
  private problems: HTMLElement;
  private nameInput: HTMLInputElement;
  private done: (def: Omit<Profile, 'id'>, save: boolean) => void;
  private toast: (text: string) => void;

  constructor(done: (def: Omit<Profile, 'id'>, save: boolean) => void, toast: (text: string) => void) {
    this.done = done; this.toast = toast;
    this.el = el('div', 'rp-panel section-editor hidden');
    const top = el('div', 'rp-head');
    this.width = el('span', 'rp-chip');
    const close = btn('', () => this.close(), 'rp-icon', t('profileEditor.close'));
    close.innerHTML = svg('close', 18);
    top.append(el('span', 'rp-title', t('profileEditor.title')), el('span', 'rp-sub', t('ui.editor.sub')), this.width, close);
    this.cv = el('canvas', 'section-canvas');
    this.cv.width = 900; this.cv.height = 110;
    this.cv.addEventListener('click', (e) => {
      const r = this.cv.getBoundingClientRect();
      const x = (e.clientX - r.left) * this.cv.width / r.width;
      this.sel = this.ranges.findIndex((q) => q && x >= q[0] && x <= q[1]);
      this.refresh();
    });
    const adds = el('div', 'row');
    adds.append(el('span', 'rp-label', t('profileEditor.add')));
    const add = (kind: StripKind, w: number, extra: Partial<Strip> = {}): HTMLButtonElement => {
      const b = btn(t(KIND_KEY[kind]), () => this.insert({ kind, width: w, ...extra }), 'rp-tool');
      const i = el('i'); i.style.background = KIND_COLOR[kind];
      b.prepend(i);
      return b;
    };
    adds.append(add('lane', 3.2, { dir: 1 }), add('parking', 2.3), add('bike', 1.6), add('median', 2, { pave: Paving.Grass }),
      add('sidewalk', 2.5), add('shoulder', 2), add('barrier', 0.6), add('curb', 0.2));
    this.head = el('div', 'grid2');
    this.props = el('div', 'grid2');
    this.problems = el('div', 'problems');
    this.nameInput = el('input', 'v2-search');
    this.nameInput.placeholder = t('profile.templateName');
    this.nameInput.addEventListener('keydown', (e) => e.stopPropagation());
    const foot = el('div', 'rp-foot row');
    foot.style.justifyContent = 'flex-end';
    foot.append(this.nameInput, btn(t('profileEditor.cancel'), () => this.close(), 'rp-btn'), btn(t('profileEditor.saveShort'), () => this.finish(true), 'rp-btn'),
      btn(t('profileEditor.drawWith'), () => this.finish(false), 'rp-btn primary'));
    this.el.append(top, this.cv, adds, this.head, this.props, this.problems, foot);
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  }

  get isOpen(): boolean { return !this.el.classList.contains('hidden'); }

  open(p: Profile | Omit<Profile, 'id'>): void {
    this.def = JSON.parse(JSON.stringify({ ...p, id: undefined })) as Omit<Profile, 'id'>;
    this.def.ring = false;
    this.nameInput.value = p.custom ? p.name : t('ui.editor.mine', { name: profileName(p) });
    this.sel = -1;
    this.el.classList.remove('hidden');
    this.refresh();
  }

  close(): void { this.el.classList.add('hidden'); this.def = null; }

  private insert(s: Strip): void {
    const d = this.def!;
    const at = this.sel >= 0 ? this.sel + 1 : Math.floor(d.strips.length / 2);
    d.strips.splice(at, 0, s);
    this.sel = at;
    this.refresh();
  }

  private finish(save: boolean): void {
    const d = this.def!;
    const probs = problemsOf(d);
    if (probs.length) { this.toast(probs[0]); return; }
    const name = this.nameInput.value.trim();
    if (save && !name) { this.toast(t('profile.notSaved')); return; }
    const out = normalize({ ...d, name: name || t('profileEditor.custom') });
    this.close();
    this.done(out, save);
  }

  private refresh(): void {
    const d = this.def;
    if (!d) return;
    this.ranges = drawSection(this.cv, d, this.sel);
    const total = d.strips.reduce((s, x) => s + x.width, 0);
    this.width.textContent = t('profileEditor.totalWidth', { width: fmtDec(total) });
    this.head.replaceChildren(
      lbl(t('profileEditor.speed')), range(10, 130, 5, d.speed, (v) => { d.speed = v; }, (v) => t('profileEditor.speedValue', { speed: v })),
      lbl(t('road.section.priority')), range(0, 5, 1, d.priority ?? 0, (v) => { d.priority = v; }, (v) => String(v)),
      lbl(t('profile.material.carriageway')), choice([[Surface.Asphalt, t('profile.materialName.asphalt')], [Surface.Concrete, t('profile.materialName.concrete')], [Surface.Cobble, t('profile.materialName.cobble')]], d.surface ?? 0, (v) => { d.surface = v; this.refresh(); }),
      lbl(t('profileEditor.centreLine')), choice([[0, t('profileEditor.centreLineName.double')], [1, t('profileEditor.centreLineName.solid')], [2, t('profileEditor.centreLineName.dashed')]], ['double', 'solid', 'dashed'].indexOf(d.centre ?? 'double'),
        (v) => { d.centre = (['double', 'solid', 'dashed'] as Centre[])[v]; this.refresh(); }),
    );
    this.props.replaceChildren();
    const s = d.strips[this.sel];
    if (s) {
      const [lo, hi] = WIDTH_LIMIT[s.kind];
      this.props.append(lbl(t('ui.editor.strip', { kind: t(KIND_KEY[s.kind]), n: this.sel + 1, of: d.strips.length })), rowOf(
        btn('◀', () => this.move(1), 'v2-btn', t('profileEditor.moveLeft')), btn('▶', () => this.move(-1), 'v2-btn', t('profileEditor.moveRight')),
        btn(t('ui.editor.duplicate'), () => { d.strips.splice(this.sel, 0, { ...s }); this.refresh(); }, 'v2-btn'),
        btn(t('profileEditor.remove'), () => { d.strips.splice(this.sel, 1); this.sel = Math.min(this.sel, d.strips.length - 1); this.refresh(); }, 'v2-btn')));
      this.props.append(lbl(t('profileEditor.width')), range(lo, hi, 0.1, Math.min(hi, Math.max(lo, s.width)), (v) => { s.width = v; this.ranges = drawSection(this.cv, d, this.sel); this.width.textContent = t('profileEditor.totalWidth', { width: fmtDec(d.strips.reduce((q, x) => q + x.width, 0)) }); }, (v) => `${fmtDec(v)} m`));
      if (s.kind === 'lane') {
        this.props.append(
          lbl(t('profileEditor.direction')), choice([[1, t('profileEditor.dirForward')], [-1, t('profileEditor.dirBackward')]], s.dir ?? 1, (v) => { s.dir = v as 1 | -1; this.refresh(); }),
          lbl(t('profileEditor.use')), choice([[0, t('profileEditor.useAll')], [1, t('profileEditor.useBus')]], s.bus ? 1 : 0, (v) => { s.bus = v === 1; this.refresh(); }),
          lbl(t('road.section.turns')), choice(TURNS.map(([v, k]) => [v, t(k)]), s.turns ?? 0, (v) => { s.turns = v; }),
          lbl(t('ui.editor.lineLeft')), choice([[0, t('profileEditor.lineDashed')], [1, t('profileEditor.lineSolid')]], s.solid ? 1 : 0, (v) => { s.solid = v === 1; }),
        );
      }
      if (s.kind === 'sidewalk') {
        this.props.append(
          lbl(t('profileEditor.paving')), choice([[Paving.Concrete, t('profile.materialName.concrete')], [Paving.Pavers, t('profile.materialName.pavers')], [Paving.Stone, t('ui.paving.portuguese')]], s.pave ?? 0, (v) => { s.pave = v; this.refresh(); }),
          lbl(t('ui.editor.level')), choice([[0, t('ui.editor.withCurb')], [1, t('profileEditor.flush')]], s.flush ? 1 : 0, (v) => { s.flush = v === 1; this.refresh(); }),
        );
      }
      if (s.kind === 'median') {
        this.props.append(
          lbl(t('profileEditor.paving')), choice([[Paving.Grass, t('profile.materialName.grass')], [Paving.Concrete, t('profile.materialName.concrete')], [Paving.Pavers, t('profile.materialName.pavers')]], s.pave ?? Paving.Grass, (v) => { s.pave = v; this.refresh(); }),
          lbl(t('ui.editor.level')), choice([[0, t('ui.editor.raised')], [1, t('profileEditor.medianFlush')]], s.flush ? 1 : 0, (v) => { s.flush = v === 1; this.refresh(); }),
        );
      }
    } else this.props.append(lbl(t('profileEditor.pick')));
    const probs = problemsOf(d);
    this.problems.textContent = probs.length ? probs.join(' ') : t('profileEditor.ok');
    this.problems.classList.toggle('ok', !probs.length);
  }

  private move(delta: number): void {
    // ◀ on the image is a higher index in the list (u grows to the left)
    const d = this.def!, i = this.sel, j = i + delta;
    if (j < 0 || j >= d.strips.length) return;
    [d.strips[i], d.strips[j]] = [d.strips[j], d.strips[i]];
    this.sel = j;
    this.refresh();
  }
}

/** What stops a profile from being built (sentences for the player). */
/** The section's problems in the player's words (the checks are `roads/profiles.ts` profileIssues). */
export function problemsOf(d: Omit<Profile, 'id'>): string[] {
  const key: Record<ProfileIssue, string> = {
    noLanes: 'profile.problem.noLanes', maxLanes: 'ui.problem.maxLanes', busOnly: 'profile.problem.busOnly', order: 'ui.problem.order',
    footways: 'ui.problem.footways', wide: 'ui.problem.wide', laneBalance: 'profile.problem.laneBalance', parkingSide: 'profile.problem.parkingSide',
    width: 'profile.problem.width', median: 'profile.problem.median', class: 'profile.problem.class',
  };
  return profileIssues(d).map((p) => t(key[p]));
}

function btn(text: string, fn: () => void, cls = '', title = ''): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  if (title) b.title = title;
  b.addEventListener('click', (e) => { e.stopPropagation(); fn(); b.blur(); });
  return b;
}
function lbl(text: string): HTMLElement { return el('span', 'label', text); }
function rowOf(...c: HTMLElement[]): HTMLElement { const e = el('div', 'row'); e.append(...c); return e; }
function range(min: number, max: number, step: number, value: number, fn: (v: number) => void, fmt: (v: number) => string): HTMLElement {
  const wrap = el('div', 'row');
  const i = el('input');
  i.type = 'range'; i.min = String(min); i.max = String(max); i.step = String(step); i.value = String(value);
  const v = el('span', 'value', fmt(value));
  i.addEventListener('input', () => { const x = Number(i.value); v.textContent = fmt(x); fn(x); });
  wrap.append(i, v);
  return wrap;
}
function choice(opts: Array<[number, string]>, value: number, fn: (v: number) => void): HTMLSelectElement {
  const s = el('select');
  for (const [v, text] of opts) { const o = el('option', '', text); o.value = String(v); s.append(o); }
  s.value = String(value);
  s.addEventListener('change', () => { fn(Number(s.value)); s.blur(); });
  s.addEventListener('keydown', (e) => e.stopPropagation());
  return s;
}

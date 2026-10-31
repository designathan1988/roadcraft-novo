// Building creator: the chosen building's design (plan, roof, finish, colour, rooftop gear, setback floors), ready
// templates and the player's own templates (kept in the browser). Every text is a language key, written again when
// the language changes.

import { DEFAULT_DESIGN, FINISHES, GEAR, GEAR_NAMES, PALETTE, ROOFS, SHAPES, WINDOWS, WINGS, type Design } from '../world/design.ts';
import { readStored, writeStored } from '../shared/storage.ts';
import { onLanguageChange, plural, t } from '../shared/i18n/index.ts';

export interface CreatorActions {
  /** Applies a design (null = no design: back to the automatic building) and, optionally, the floors. */
  apply(d: Design | null, floors?: number): void;
}

/** Ready templates: [name key, design, floors]. */
export const PRESETS: Array<[string, Design, number]> = [
  ['creator.preset.house', { shape: 0, roof: 2, finish: 0, gear: GEAR.Chimney, setback: 0, wall: 0xf1e3c6 }, 1],
  ['creator.preset.terracedTownhouse', { shape: 0, roof: 2, finish: 1, gear: 0, setback: 0, wall: 0xa5553a }, 2],
  ['creator.preset.apartmentBlock', { shape: 0, roof: 0, finish: 0, gear: GEAR.Tank | GEAR.AC, setback: 0, wall: 0xe3d6bd }, 8],
  ['creator.preset.towerOnPodium', { shape: 0, roof: 1, finish: 2, gear: GEAR.Antenna, setback: 10, wall: 0x3d5568 }, 24],
  ['creator.preset.shop', { shape: 0, roof: 0, finish: 3, gear: GEAR.AC, setback: 0, wall: 0xd6d4cf }, 1],
  ['creator.preset.officeBuilding', { shape: 6, roof: 0, finish: 2, gear: GEAR.Solar, setback: 0, wall: 0x4a6274 }, 14],
  ['creator.preset.courtyardBlock', { shape: 2, roof: 1, finish: 0, gear: 0, setback: 0, wall: 0xd9c7a6 }, 5],
  ['creator.preset.roundTower', { shape: 3, roof: 0, finish: 2, gear: GEAR.Spire, setback: 3, wall: 0x557080 }, 20],
  ['creator.preset.warehouse', { shape: 0, roof: 5, finish: 4, gear: 0, setback: 0, wall: 0xb9bec2 }, 2],
  ['creator.preset.factory', { shape: 1, roof: 5, finish: 1, gear: GEAR.Chimney, setback: 0, wall: 0x9a4a32 }, 3],
  ['creator.preset.churchWithTower', { shape: 6, roof: 3, finish: 6, gear: GEAR.Spire, setback: 0, wall: 0xe8e2d4 }, 3],
];

/** Setback floors offered (0 = none). */
const SETBACK_MAX = 12;

function loadMine(): Array<[string, Design, number]> {
  try { return JSON.parse(readStored('buildingDesigns') ?? '[]') as Array<[string, Design, number]>; } catch { return []; }
}

export class Creator {
  readonly el: HTMLElement;
  private d: Design = { ...DEFAULT_DESIGN };
  private floors = 4;
  private fields: Record<string, HTMLSelectElement> = {};
  private gearBoxes = new Map<number, HTMLInputElement>();
  private swatch!: HTMLInputElement;
  private presetSel!: HTMLSelectElement;
  private a: CreatorActions;
  /** What writes each text again in the current language. */
  private readonly texts: Array<() => void> = [];

  constructor(a: CreatorActions) {
    this.a = a;
    const el = document.createElement('div');
    el.className = 'group brush creator';
    const text = (write: () => void): void => { write(); this.texts.push(write); };
    const lab = (key: string) => { const s = document.createElement('span'); s.className = 'label'; text(() => { s.textContent = t(key); }); return s; };
    const sel = (key: string, opts: readonly string[], field: keyof Design) => {
      const s = document.createElement('select');
      opts.forEach((o, i) => { const op = document.createElement('option'); op.value = String(i); text(() => { op.textContent = t(o); }); s.append(op); });
      s.addEventListener('change', () => { (this.d[field] as number) = Number(s.value); this.push(); s.blur(); });
      this.fields[field] = s;
      el.append(lab(key), s);
    };
    // templates: ready ones and the player's
    this.presetSel = document.createElement('select');
    this.fillPresets();
    this.texts.push(() => this.fillPresets());
    this.presetSel.addEventListener('change', () => {
      const v = this.presetSel.value;
      this.presetSel.value = '';
      this.presetSel.blur();
      if (!v) return;
      const [, d, fl] = v.startsWith('m') ? loadMine()[Number(v.slice(1))] : PRESETS[Number(v.slice(1))];
      if (!d) return;
      this.d = { ...d }; this.floors = fl; this.sync(); this.a.apply({ ...this.d }, fl);
    });
    el.append(lab('creator.design'), this.presetSel);
    sel('creator.plan', SHAPES, 'shape');
    sel('creator.roof', ROOFS, 'roof');
    sel('creator.finish', FINISHES, 'finish');
    sel('creator.windows', WINDOWS, 'windows');
    sel('creator.wing', WINGS, 'wing');
    const rec = document.createElement('select');
    for (let k = 0; k <= SETBACK_MAX; k++) {
      const op = document.createElement('option'); op.value = String(k);
      text(() => { op.textContent = k ? plural('creator.setbacks', k) : t('creator.none'); });
      rec.append(op);
    }
    rec.addEventListener('change', () => { this.d.setback = Number(rec.value); this.push(); rec.blur(); });
    this.fields.setback = rec;
    el.append(lab('creator.setbackFloors'), rec);
    // colour: palette and free choice
    const pal = document.createElement('span');
    pal.className = 'inline';
    for (const c of PALETTE) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = `#${c.toString(16).padStart(6, '0')}`;
      text(() => { b.title = t('creator.facadeColour'); });
      b.addEventListener('click', (e) => { e.stopPropagation(); this.d.wall = c; this.swatch.value = b.style.background ? `#${c.toString(16).padStart(6, '0')}` : '#ffffff'; this.push(); });
      pal.append(b);
    }
    this.swatch = document.createElement('input');
    this.swatch.type = 'color';
    this.swatch.addEventListener('change', () => { this.d.wall = parseInt(this.swatch.value.slice(1), 16); this.push(); });
    el.append(lab('creator.colour'), pal, this.swatch);
    // rooftop gear
    for (const [bit, key] of GEAR_NAMES) {
      const l = document.createElement('label');
      l.className = 'check';
      const cb = document.createElement('input'); cb.type = 'checkbox';
      cb.addEventListener('change', () => { this.d.gear = cb.checked ? this.d.gear | bit : this.d.gear & ~bit; this.push(); });
      this.gearBoxes.set(bit, cb);
      const name = document.createTextNode('');
      text(() => { name.nodeValue = ` ${t(key)}`; });
      l.append(cb, name);
      el.append(l);
    }
    const save = document.createElement('button');
    text(() => { save.textContent = t('creator.save'); save.title = t('creator.saveTip'); });
    save.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = window.prompt(t('creator.templateName'), t('creator.myBuilding'));
      if (!name) return;
      const list = loadMine();
      list.push([name.slice(0, 40), { ...this.d }, this.floors]);
      if (!writeStored('buildingDesigns', JSON.stringify(list))) { window.alert(t('creator.notSaved')); }
      this.fillPresets();
    });
    const auto = document.createElement('button');
    text(() => { auto.textContent = t('creator.noDesign'); auto.title = t('creator.noDesignTip'); });
    auto.addEventListener('click', (e) => { e.stopPropagation(); this.a.apply(null); });
    el.append(save, auto);
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el = el;
    onLanguageChange(() => { for (const write of this.texts) write(); });
  }

  private fillPresets(): void {
    const s = this.presetSel;
    s.innerHTML = '';
    const head = document.createElement('option'); head.value = ''; head.textContent = t('creator.chooseTemplate'); s.append(head);
    const group = (label: string, list: Array<[string, Design, number]>, p: string, name: (n: string) => string) => {
      if (!list.length) return;
      const g = document.createElement('optgroup'); g.label = label;
      list.forEach(([n], i) => { const op = document.createElement('option'); op.value = `${p}${i}`; op.textContent = name(n); g.append(op); });
      s.append(g);
    };
    group(t('creator.ready'), PRESETS, 'p', (n) => t(n));
    // the player's templates keep the names the player gave them
    group(t('creator.mine'), loadMine(), 'm', (n) => n);
  }

  private push(): void { this.a.apply({ ...this.d }); }

  /** Shows the chosen building's design (or the default one, if it has none). */
  show(d: Design | null, floors: number): void {
    this.d = d ? { ...d } : { ...DEFAULT_DESIGN };
    this.floors = floors;
    this.sync();
  }

  private sync(): void {
    for (const k of ['shape', 'roof', 'finish', 'setback', 'windows', 'wing'] as const) this.fields[k].value = String(this.d[k] ?? 0);
    for (const [bit, cb] of this.gearBoxes) cb.checked = (this.d.gear & bit) !== 0;
    this.swatch.value = `#${this.d.wall.toString(16).padStart(6, '0')}`;
  }
}

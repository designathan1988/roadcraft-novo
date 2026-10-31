// Criador de prédio: o projeto do prédio escolhido (planta, telhado, acabamento, cor, peças no
// telhado, andares recuados), modelos prontos e modelos do jogador (guardados no navegador).

import { DEFAULT_DESIGN, FINISHES, GEAR, GEAR_NAMES, PALETTE, ROOFS, SHAPES, WINDOWS, WINGS, type Design } from '../world/design.ts';
import { readStored, writeStored } from '../shared/storage.ts';

export interface CreatorActions {
  /** Aplica um projeto (null = tirar o projeto: volta ao prédio automático) e, opcionalmente, os andares. */
  apply(d: Design | null, floors?: number): void;
}

/** Modelos prontos: [nome, projeto, andares]. */
export const PRESETS: Array<[string, Design, number]> = [
  ['Casa', { shape: 0, roof: 2, finish: 0, gear: GEAR.Chimney, setback: 0, wall: 0xf1e3c6 }, 1],
  ['Sobrado geminado', { shape: 0, roof: 2, finish: 1, gear: 0, setback: 0, wall: 0xa5553a }, 2],
  ['Prédio residencial', { shape: 0, roof: 0, finish: 0, gear: GEAR.Tank | GEAR.AC, setback: 0, wall: 0xe3d6bd }, 8],
  ['Torre com embasamento', { shape: 0, roof: 1, finish: 2, gear: GEAR.Antenna, setback: 10, wall: 0x3d5568 }, 24],
  ['Loja', { shape: 0, roof: 0, finish: 3, gear: GEAR.AC, setback: 0, wall: 0xd6d4cf }, 1],
  ['Edifício de escritórios', { shape: 6, roof: 0, finish: 2, gear: GEAR.Solar, setback: 0, wall: 0x4a6274 }, 14],
  ['Prédio com pátio (U)', { shape: 2, roof: 1, finish: 0, gear: 0, setback: 0, wall: 0xd9c7a6 }, 5],
  ['Torre redonda', { shape: 3, roof: 0, finish: 2, gear: GEAR.Spire, setback: 3, wall: 0x557080 }, 20],
  ['Galpão', { shape: 0, roof: 5, finish: 4, gear: 0, setback: 0, wall: 0xb9bec2 }, 2],
  ['Fábrica', { shape: 1, roof: 5, finish: 1, gear: GEAR.Chimney, setback: 0, wall: 0x9a4a32 }, 3],
  ['Igreja de torre', { shape: 6, roof: 3, finish: 6, gear: GEAR.Spire, setback: 0, wall: 0xe8e2d4 }, 3],
];


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

  constructor(a: CreatorActions) {
    this.a = a;
    const el = document.createElement('div');
    el.className = 'group brush creator';
    const lab = (t: string) => { const s = document.createElement('span'); s.className = 'label'; s.textContent = t; return s; };
    const sel = (name: string, opts: readonly string[], key: keyof Design) => {
      const s = document.createElement('select');
      opts.forEach((o, i) => { const op = document.createElement('option'); op.value = String(i); op.textContent = o; s.append(op); });
      s.addEventListener('change', () => { (this.d[key] as number) = Number(s.value); this.push(); s.blur(); });
      this.fields[key] = s;
      el.append(lab(name), s);
    };
    // modelos: prontos e do jogador
    this.presetSel = document.createElement('select');
    this.fillPresets();
    this.presetSel.addEventListener('change', () => {
      const v = this.presetSel.value;
      this.presetSel.value = '';
      this.presetSel.blur();
      if (!v) return;
      const [, d, fl] = v.startsWith('m') ? loadMine()[Number(v.slice(1))] : PRESETS[Number(v.slice(1))];
      if (!d) return;
      this.d = { ...d }; this.floors = fl; this.sync(); this.a.apply({ ...this.d }, fl);
    });
    el.append(lab('Projeto'), this.presetSel);
    sel('Planta', SHAPES, 'shape');
    sel('Telhado', ROOFS, 'roof');
    sel('Acabamento', FINISHES, 'finish');
    sel('Janelas', WINDOWS, 'windows');
    sel('Ala', WINGS, 'wing');
    const rec = document.createElement('select');
    for (let k = 0; k <= 12; k++) { const op = document.createElement('option'); op.value = String(k); op.textContent = k ? `${k} recuado${k > 1 ? 's' : ''}` : 'Nenhum'; rec.append(op); }
    rec.addEventListener('change', () => { this.d.setback = Number(rec.value); this.push(); rec.blur(); });
    this.fields.setback = rec;
    el.append(lab('Andares recuados'), rec);
    // cor: paleta e escolha livre
    const pal = document.createElement('span');
    pal.className = 'inline';
    for (const c of PALETTE) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = `#${c.toString(16).padStart(6, '0')}`;
      b.title = 'Cor da fachada';
      b.addEventListener('click', (e) => { e.stopPropagation(); this.d.wall = c; this.swatch.value = b.style.background ? `#${c.toString(16).padStart(6, '0')}` : '#ffffff'; this.push(); });
      pal.append(b);
    }
    this.swatch = document.createElement('input');
    this.swatch.type = 'color';
    this.swatch.addEventListener('change', () => { this.d.wall = parseInt(this.swatch.value.slice(1), 16); this.push(); });
    el.append(lab('Cor'), pal, this.swatch);
    // peças no telhado
    for (const [bit, name] of GEAR_NAMES) {
      const l = document.createElement('label');
      l.className = 'check';
      const cb = document.createElement('input'); cb.type = 'checkbox';
      cb.addEventListener('change', () => { this.d.gear = cb.checked ? this.d.gear | bit : this.d.gear & ~bit; this.push(); });
      this.gearBoxes.set(bit, cb);
      l.append(cb, document.createTextNode(` ${name}`));
      el.append(l);
    }
    const save = document.createElement('button');
    save.textContent = 'Salvar como modelo';
    save.title = 'Guarda este projeto (com os andares) na lista de modelos';
    save.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = window.prompt('Nome do modelo', 'Meu prédio');
      if (!name) return;
      const list = loadMine();
      list.push([name.slice(0, 40), { ...this.d }, this.floors]);
      if (!writeStored('buildingDesigns', JSON.stringify(list))) { window.alert('Não salvo: o armazenamento do navegador está cheio ou bloqueado.'); }
      this.fillPresets();
    });
    const auto = document.createElement('button');
    auto.textContent = 'Sem projeto';
    auto.title = 'Volta ao prédio automático do gerador (pelo estilo e pela zona)';
    auto.addEventListener('click', (e) => { e.stopPropagation(); this.a.apply(null); });
    el.append(save, auto);
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el = el;
  }

  private fillPresets(): void {
    const s = this.presetSel;
    s.innerHTML = '';
    const head = document.createElement('option'); head.value = ''; head.textContent = 'Escolher modelo…'; s.append(head);
    const group = (label: string, list: Array<[string, Design, number]>, p: string) => {
      if (!list.length) return;
      const g = document.createElement('optgroup'); g.label = label;
      list.forEach(([n], i) => { const op = document.createElement('option'); op.value = `${p}${i}`; op.textContent = n; g.append(op); });
      s.append(g);
    };
    group('Prontos', PRESETS, 'p');
    group('Meus modelos', loadMine(), 'm');
  }

  private push(): void { this.a.apply({ ...this.d }); }

  /** Mostra o projeto do prédio escolhido (ou o padrão, se ele não tiver). */
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

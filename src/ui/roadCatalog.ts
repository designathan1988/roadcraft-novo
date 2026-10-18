// Catálogo de vias (categorias, desenho da seção, preço por metro) e o editor
// de seção transversal: o jogador monta a via faixa por faixa, ajusta larguras,
// sentido, ônibus, setas, pisos e velocidade, usa ou salva como modelo.

import {
  PROFILES, PROFILE_INFO, Paving, Surface, TurnBit, normalize, registerProfile,
  type Category, type Centre, type Profile, type Strip, type StripKind,
} from '../roads/profiles.ts';

const CATS: Array<[Category, string]> = [['ruas', 'Ruas'], ['avenidas', 'Avenidas'], ['rodovias', 'Rodovias'], ['especiais', 'Especiais'], ['trilhos', 'Trilhos'], ['meus', 'Meus modelos']];
const KIND_NAME: Record<StripKind, string> = {
  sidewalk: 'Calçada', curb: 'Meio-fio', parking: 'Estacionamento', bike: 'Ciclofaixa', lane: 'Faixa',
  median: 'Canteiro', shoulder: 'Acostamento', barrier: 'Mureta',
};
const KIND_COLOR: Record<StripKind, string> = {
  sidewalk: '#bcb5a7', curb: '#e0dbd2', parking: '#55585c', bike: '#9a4a3e', lane: '#45484c',
  median: '#6c8a48', shoulder: '#5f6164', barrier: '#a9a59d',
};
const WIDTH_LIMIT: Record<StripKind, [number, number]> = {
  sidewalk: [1, 12], curb: [0.1, 0.4], parking: [2, 3], bike: [1.2, 2.5], lane: [2.5, 4.5],
  median: [0.5, 20], shoulder: [0.5, 4], barrier: [0.3, 1.2],
};
const TURNS: Array<[number, string]> = [
  [0, 'Automático'], [TurnBit.Left | TurnBit.Straight | TurnBit.Right, 'Todas as direções'], [TurnBit.Left, '← Só esquerda'],
  [TurnBit.Straight, '↑ Só em frente'], [TurnBit.Right, '→ Só direita'], [TurnBit.Left | TurnBit.Straight, '← ↑ Esquerda ou em frente'],
  [TurnBit.Straight | TurnBit.Right, '↑ → Em frente ou direita'],
];
const STORE = 'cidade.modelosDeVia';

export interface CatalogActions {
  /** Desenhar com este perfil. */
  use(id: number): void;
  /** Avisos curtos. */
  toast(t: string): void;
}

/** Modelos do jogador guardados no navegador (valem para todos os mapas). */
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

/** Desenha a seção (vista de a para b: a borda direita fica à direita da imagem). */
export function drawSection(cv: HTMLCanvasElement, p: Omit<Profile, 'id'>, selected = -1): Array<[number, number]> {
  const g = cv.getContext('2d')!;
  const W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  const total = p.strips.reduce((s, x) => s + x.width, 0) || 1;
  const k = (W - 4) / total;
  const ranges: Array<[number, number]> = [];
  // da esquerda da imagem (u positivo) para a direita (u negativo): de quem olha no sentido a → b
  let x = 2;
  for (let i = p.strips.length - 1; i >= 0; i--) {
    const s = p.strips[i];
    const w = Math.max(1, s.width * k);
    const raised = !s.flush && (s.kind === 'sidewalk' || s.kind === 'median' || s.kind === 'curb');
    const y0 = s.kind === 'barrier' ? H * 0.2 : raised ? H * 0.42 : H * 0.5;
    let col = KIND_COLOR[s.kind];
    if (s.kind === 'lane' && s.bus) col = '#7a2f26';
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
      if (s.dir === -1) { g.moveTo(mid - 3, y - 3); g.lineTo(mid + 3, y - 3); g.lineTo(mid, y + 3); }
      else { g.moveTo(mid - 3, y + 3); g.lineTo(mid + 3, y + 3); g.lineTo(mid, y - 3); }
      g.fill();
    }
    if (s.kind === 'median' && (s.pave ?? Paving.Grass) === Paving.Grass && w > 6) {
      g.fillStyle = '#4f6e33';
      g.beginPath(); g.arc(x + w / 2, y0 - 5, Math.min(6, w / 3), 0, Math.PI * 2); g.fill();
    }
    if (i === selected) { g.strokeStyle = '#ffd36b'; g.lineWidth = 2; g.strokeRect(x + 1, 2, w - 2, H - 4); }
    ranges[i] = [x, x + w];
    x += w;
  }
  return ranges;
}

export class RoadCatalog {
  readonly el: HTMLElement;
  private grid: HTMLElement;
  private cat: Category = 'ruas';
  private current = 0;
  private editor: SectionEditor;
  private a: CatalogActions;

  constructor(a: CatalogActions) {
    this.a = a;
    this.el = document.createElement('div');
    this.el.className = 'catalog';
    const tabs = document.createElement('div');
    tabs.className = 'cat-tabs';
    for (const [c, name] of CATS) {
      const b = document.createElement('button');
      b.textContent = name; b.dataset.cat = c;
      b.addEventListener('click', (e) => { e.stopPropagation(); this.cat = c; this.render(); b.blur(); });
      tabs.append(b);
    }
    this.grid = document.createElement('div');
    this.grid.className = 'cat-grid';
    const foot = document.createElement('div');
    foot.className = 'cat-foot';
    const edit = document.createElement('button');
    edit.textContent = 'Personalizar…';
    edit.title = 'Abrir a seção transversal da via escolhida para mudar faixa por faixa';
    edit.addEventListener('click', (e) => { e.stopPropagation(); this.editor.open(PROFILES[this.current]); edit.blur(); });
    foot.append(edit);
    this.el.append(tabs, this.grid, foot);
    this.editor = new SectionEditor((def, save) => this.fromEditor(def, save), a.toast);
    document.getElementById('hud')!.append(this.editor.el);
    this.render();
  }

  set visible(v: boolean) { this.el.style.display = v ? '' : 'none'; if (!v) this.editor.close(); }

  /** Perfil escolhido de fora (conta-gotas, atalho). */
  select(id: number): void {
    this.current = id;
    const p = PROFILES[id];
    if (p?.category && p.category !== this.cat && !p.custom) this.cat = p.category;
    this.render();
  }

  /** Editor terminou: registra o perfil (e guarda como modelo). */
  private fromEditor(def: Omit<Profile, 'id'>, save: boolean): void {
    if (save) {
      const list = readTemplates().filter((t) => t.name !== def.name);
      list.push({ ...def, category: 'meus', custom: true });
      if (!writeTemplates(list)) this.a.toast('Não salvo: o armazenamento do navegador está cheio ou bloqueado.');
      else this.a.toast(`Modelo "${def.name}" salvo.`);
    }
    const id = registerProfile({ ...def, category: 'meus', custom: true });
    if (id < 0) { this.a.toast('Perfis demais neste mapa (máximo 256).'); return; }
    this.current = id;
    if (save) this.cat = 'meus';
    this.render();
    this.a.use(id);
  }

  private render(): void {
    for (const b of this.el.querySelectorAll<HTMLButtonElement>('.cat-tabs button')) b.classList.toggle('active', b.dataset.cat === this.cat);
    this.grid.innerHTML = '';
    const items: Array<{ def: Omit<Profile, 'id'>; id: number; del?: () => void }> = [];
    if (this.cat === 'meus') {
      for (const t of readTemplates()) {
        items.push({ def: t, id: -1, del: () => { writeTemplates(readTemplates().filter((x) => x.name !== t.name)); this.render(); } });
      }
      // perfis só deste mapa (usados sem salvar como modelo)
      for (const p of PROFILES) if (p.custom && !items.some((i) => i.def.name === p.name)) items.push({ def: p, id: p.id });
      if (items.length === 0) {
        const e = document.createElement('div');
        e.className = 'cat-empty';
        e.textContent = 'Seus modelos aparecem aqui: escolha uma via, clique em "Personalizar…" e salve como modelo.';
        this.grid.append(e);
        return;
      }
    } else {
      for (const p of PROFILES) if (!p.custom && !p.ring && p.category === this.cat) items.push({ def: p, id: p.id });
    }
    for (const it of items) {
      const card = document.createElement('button');
      card.className = 'road-card';
      const info = it.id >= 0 ? PROFILE_INFO[it.id] : null;
      const width = it.def.strips.reduce((s, x) => s + x.width, 0);
      const lanes = it.def.strips.filter((s) => s.kind === 'lane').length;
      const cost = info ? info.cost : Math.round(width * 60);
      card.title = `${it.def.name}: ${lanes} faixa${lanes > 1 ? 's' : ''}, ${it.def.oneWay ? 'mão única' : 'mão dupla'}, ${it.def.speed} km/h. Clique para desenhar com ela.`;
      if (it.id >= 0 && it.id === this.current) card.classList.add('active');
      const cv = document.createElement('canvas');
      cv.width = 132; cv.height = 34;
      drawSection(cv, it.def);
      const name = document.createElement('div');
      name.className = 'road-name'; name.textContent = it.def.name;
      const meta = document.createElement('div');
      meta.className = 'road-meta'; meta.textContent = `${width.toFixed(1).replace('.', ',')} m · R$ ${cost.toLocaleString('pt-BR')}/m`;
      card.append(cv, name, meta);
      card.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = it.id >= 0 ? it.id : registerProfile({ ...it.def, category: 'meus', custom: true });
        if (id < 0) { this.a.toast('Perfis demais neste mapa (máximo 256).'); return; }
        this.current = id; this.render(); this.a.use(id);
      });
      if (it.del) {
        const x = document.createElement('span');
        x.className = 'road-del'; x.textContent = '×'; x.title = 'Apagar o modelo';
        x.addEventListener('click', (e) => { e.stopPropagation(); it.del!(); });
        card.append(x);
      }
      this.grid.append(card);
    }
  }
}

/** Editor da seção transversal. */
class SectionEditor {
  readonly el: HTMLElement;
  private def: Omit<Profile, 'id'> | null = null;
  private sel = -1;
  private cv: HTMLCanvasElement;
  private ranges: Array<[number, number]> = [];
  private props: HTMLElement;
  private head: HTMLElement;
  private problems: HTMLElement;
  private nameInput: HTMLInputElement;
  private done: (def: Omit<Profile, 'id'>, save: boolean) => void;
  private toast: (t: string) => void;

  constructor(done: (def: Omit<Profile, 'id'>, save: boolean) => void, toast: (t: string) => void) {
    this.done = done; this.toast = toast;
    this.el = document.createElement('div');
    this.el.className = 'section-editor hidden';
    const title = document.createElement('h3');
    title.textContent = 'Seção transversal';
    const sub = document.createElement('div');
    sub.className = 'muted';
    sub.textContent = 'A via de lado a lado, vista no sentido em que você desenha. Clique numa faixa para mudá-la.';
    this.cv = document.createElement('canvas');
    this.cv.width = 560; this.cv.height = 90;
    this.cv.className = 'section-canvas';
    this.cv.addEventListener('click', (e) => {
      const r = this.cv.getBoundingClientRect();
      const x = (e.clientX - r.left) * this.cv.width / r.width;
      this.sel = this.ranges.findIndex((q) => q && x >= q[0] && x <= q[1]);
      this.refresh();
    });
    const adds = document.createElement('div');
    adds.className = 'row';
    const add = (kind: StripKind, w: number, extra: Partial<Strip> = {}) => btn(`+ ${KIND_NAME[kind]}`, () => this.insert({ kind, width: w, ...extra }));
    adds.append(add('lane', 3.2, { dir: 1 }), add('parking', 2.3), add('bike', 1.6), add('median', 2, { pave: Paving.Grass }),
      add('sidewalk', 2.5), add('shoulder', 2), add('barrier', 0.6), add('curb', 0.2));
    this.head = document.createElement('div');
    this.head.className = 'grid2';
    this.props = document.createElement('div');
    this.props.className = 'grid2';
    this.problems = document.createElement('div');
    this.problems.className = 'problems';
    this.nameInput = document.createElement('input');
    this.nameInput.className = 'text';
    this.nameInput.placeholder = 'Nome do modelo';
    const foot = document.createElement('div');
    foot.className = 'row end';
    foot.append(this.nameInput,
      btn('Cancelar', () => this.close()),
      btn('Salvar como modelo', () => this.finish(true)),
      btn('Desenhar com este perfil', () => this.finish(false), 'main'));
    this.el.append(title, sub, this.cv, adds, this.head, this.props, this.problems, foot);
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el.addEventListener('wheel', (e) => e.stopPropagation());
  }

  open(p: Profile | Omit<Profile, 'id'>): void {
    this.def = JSON.parse(JSON.stringify({ ...p, id: undefined })) as Omit<Profile, 'id'>;
    this.def.ring = false;
    this.nameInput.value = p.custom ? p.name : `${p.name} (minha)`;
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
    if (save && !name) { this.toast('Não salvo: dê um nome.'); return; }
    const out = normalize({ ...d, name: name || 'Via personalizada' });
    this.close();
    this.done(out, save);
  }

  private refresh(): void {
    const d = this.def;
    if (!d) return;
    this.ranges = drawSection(this.cv, d, this.sel);
    // via inteira
    this.head.innerHTML = '';
    const total = d.strips.reduce((s, x) => s + x.width, 0);
    this.head.append(
      lbl('Largura total'), txt(`${total.toFixed(1).replace('.', ',')} m`),
      lbl('Limite de velocidade'), range(10, 130, 5, d.speed, (v) => { d.speed = v; }, (v) => `${v} km/h`),
      lbl('Preferência (maior passa primeiro)'), range(0, 5, 1, d.priority ?? 0, (v) => { d.priority = v; }, (v) => String(v)),
      lbl('Pista'), choice([[Surface.Asphalt, 'Asfalto'], [Surface.Concrete, 'Concreto'], [Surface.Cobble, 'Paralelepípedo']], d.surface ?? 0, (v) => { d.surface = v; this.refresh(); }),
      lbl('Linha entre os sentidos'), choice([[0, 'Dupla contínua'], [1, 'Contínua'], [2, 'Tracejada']], ['double', 'solid', 'dashed'].indexOf(d.centre ?? 'double'),
        (v) => { d.centre = (['double', 'solid', 'dashed'] as Centre[])[v]; this.refresh(); }),
    );
    // faixa escolhida
    this.props.innerHTML = '';
    const s = d.strips[this.sel];
    if (s) {
      const [lo, hi] = WIDTH_LIMIT[s.kind];
      this.props.append(lbl(`${KIND_NAME[s.kind]} ${this.sel + 1} de ${d.strips.length}`), rowOf(
        btn('◀', () => this.move(1), '', 'Mover para a esquerda'), btn('▶', () => this.move(-1), '', 'Mover para a direita'),
        btn('Duplicar', () => { d.strips.splice(this.sel, 0, { ...s }); this.refresh(); }),
        btn('Apagar', () => { d.strips.splice(this.sel, 1); this.sel = Math.min(this.sel, d.strips.length - 1); this.refresh(); })));
      this.props.append(lbl('Largura'), range(lo, hi, 0.1, Math.min(hi, Math.max(lo, s.width)), (v) => { s.width = v; this.ranges = drawSection(this.cv, d, this.sel); }, (v) => `${v.toFixed(1).replace('.', ',')} m`));
      if (s.kind === 'lane') {
        this.props.append(
          lbl('Sentido'), choice([[1, 'A → B (com o desenho)'], [-1, 'B → A (contra)']], s.dir ?? 1, (v) => { s.dir = v as 1 | -1; this.refresh(); }),
          lbl('Quem usa'), choice([[0, 'Todos os veículos'], [1, 'Só ônibus']], s.bus ? 1 : 0, (v) => { s.bus = v === 1; this.refresh(); }),
          lbl('Setas de conversão'), choice(TURNS, s.turns ?? 0, (v) => { s.turns = v; }),
          lbl('Linha à esquerda'), choice([[0, 'Tracejada (pode trocar)'], [1, 'Contínua (não troca)']], s.solid ? 1 : 0, (v) => { s.solid = v === 1; }),
        );
      }
      if (s.kind === 'sidewalk') {
        this.props.append(
          lbl('Piso'), choice([[Paving.Concrete, 'Concreto'], [Paving.Pavers, 'Bloquete'], [Paving.Stone, 'Pedra portuguesa']], s.pave ?? 0, (v) => { s.pave = v; this.refresh(); }),
          lbl('Nível'), choice([[0, 'Com meio-fio'], [1, 'No nível da pista']], s.flush ? 1 : 0, (v) => { s.flush = v === 1; this.refresh(); }),
        );
      }
      if (s.kind === 'median') {
        this.props.append(
          lbl('Piso'), choice([[Paving.Grass, 'Grama'], [Paving.Concrete, 'Concreto'], [Paving.Pavers, 'Bloquete']], s.pave ?? Paving.Grass, (v) => { s.pave = v; this.refresh(); }),
          lbl('Tipo'), choice([[0, 'Elevado'], [1, 'Só pintado']], s.flush ? 1 : 0, (v) => { s.flush = v === 1; this.refresh(); }),
        );
      }
    } else {
      this.props.append(lbl('Clique numa faixa da seção para mudá-la.'));
    }
    const probs = problemsOf(d);
    this.problems.textContent = probs.join(' ');
  }

  private move(delta: number): void {
    // ◀ na imagem é u maior (índice maior na lista)
    const d = this.def!, i = this.sel, j = i + delta;
    if (j < 0 || j >= d.strips.length) return;
    [d.strips[i], d.strips[j]] = [d.strips[j], d.strips[i]];
    this.sel = j;
    this.refresh();
  }
}

/** O que impede de construir (frases para o jogador). */
export function problemsOf(d: Omit<Profile, 'id'>): string[] {
  const out: string[] = [];
  const lanes = d.strips.filter((s) => s.kind === 'lane');
  if (lanes.length === 0) out.push('A via precisa de pelo menos uma faixa.');
  if (lanes.length > 8) out.push('No máximo 8 faixas.');
  const fwd = lanes.filter((s) => (s.dir ?? 1) === 1), back = lanes.filter((s) => s.dir === -1);
  if (fwd.length > 0 && fwd.every((s) => s.bus) || back.length > 0 && back.every((s) => s.bus)) out.push('Cada sentido precisa de uma faixa para todos os veículos, além das de ônibus.');
  // faixas de a→b ficam à direita (u menor) das de b→a
  const firstBack = d.strips.findIndex((s) => s.kind === 'lane' && s.dir === -1);
  const lastFwd = d.strips.map((s) => s.kind === 'lane' && (s.dir ?? 1) === 1).lastIndexOf(true);
  if (firstBack >= 0 && lastFwd > firstBack) out.push('As faixas de cada sentido ficam juntas, com a mão à direita.');
  const inner = d.strips.slice(1, -1);
  if (inner.some((s) => s.kind === 'sidewalk')) out.push('Calçada só nas bordas.');
  if (d.strips.reduce((s, x) => s + x.width, 0) > 70) out.push('Larga demais (máximo 70 m).');
  return out;
}

function btn(text: string, fn: () => void, cls = '', title = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  if (cls) b.className = cls;
  if (title) b.title = title;
  b.addEventListener('click', (e) => { e.stopPropagation(); fn(); b.blur(); });
  return b;
}
function lbl(t: string): HTMLElement { const e = document.createElement('span'); e.className = 'label'; e.textContent = t; return e; }
function txt(t: string): HTMLElement { const e = document.createElement('span'); e.textContent = t; return e; }
function rowOf(...c: HTMLElement[]): HTMLElement { const e = document.createElement('div'); e.className = 'row'; e.append(...c); return e; }
function range(min: number, max: number, step: number, value: number, fn: (v: number) => void, fmt: (v: number) => string): HTMLElement {
  const wrap = document.createElement('div'); wrap.className = 'row';
  const i = document.createElement('input');
  i.type = 'range'; i.min = String(min); i.max = String(max); i.step = String(step); i.value = String(value);
  const v = document.createElement('span'); v.className = 'value'; v.textContent = fmt(value);
  i.addEventListener('input', () => { const x = Number(i.value); v.textContent = fmt(x); fn(x); });
  wrap.append(i, v);
  return wrap;
}
function choice(opts: Array<[number, string]>, value: number, fn: (v: number) => void): HTMLSelectElement {
  const s = document.createElement('select');
  for (const [v, t] of opts) { const o = document.createElement('option'); o.value = String(v); o.textContent = t; s.append(o); }
  s.value = String(value);
  s.addEventListener('change', () => { fn(Number(s.value)); s.blur(); });
  return s;
}

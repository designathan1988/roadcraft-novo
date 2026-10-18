// Interface: barra de ferramentas, painel da ferramenta e avisos. DOM simples.

import { RoadCatalog } from './roadCatalog.ts';
import { BARRIER_KINDS, SIGN_TYPES, STREET_ITEMS } from '../tools/itemTool.ts';
import { Item } from '../world/items.ts';
import { BIOMES, GROUND_NAMES, Ground, TREE_SPECIES } from '../world/ground.ts';
import { ARCHES, FN_NAMES } from '../world/arch.ts';
import { MODE_NAMES } from '../world/transit.ts';
import { ZONE_NAMES } from '../roads/zones.ts';
import { PAINTS } from '../render/vehicles.ts';

const PAINT_SWATCHES = PAINTS.map((p) => `#${p.toString(16).padStart(6, '0')}`);

export type Tool = 'camera' | 'inspect' | 'road' | 'curve' | 'roundabout' | 'upgrade' | 'blocks' | 'free' | 'move' | 'split' | 'bulldoze' | 'zone' | 'building' | 'transit' | 'streetscape' | 'barrier' | 'raise' | 'lower' | 'smooth' | 'flatten' | 'paint' | 'forest' | 'river' | 'weather' | 'landform' | 'elements' | 'sky' | 'person' | 'pistol' | 'bomb';
export type SkyMode = 'ciclo' | 'dia' | 'noite';
export interface SkyToolState { cloud: 'none' | 'add' | 'move' | 'edit' | 'remove'; fog: 'none' | 'lay' | 'erase'; size: number; base: number; density: number; fogHeight: number }
/** Chuva 0..1, vento em m/s, direção em graus (para onde sopra), raios por minuto, trovão 0..1. */
export interface WeatherCtl { rain: number; wind: number; dir: number; lightning: number; thunder: number }
export type LotMode = 'edit' | 'rect' | 'poly' | 'split' | 'join' | 'delete' | 'front' | 'corner';
export const LOT_MODES: Array<[LotMode, string]> = [
  ['edit', 'Editar prédio'], ['rect', 'Desenhar lote (retângulo)'], ['poly', 'Desenhar lote (polígono)'], ['split', 'Dividir lote'],
  ['join', 'Juntar lotes'], ['delete', 'Apagar lotes e construções'], ['front', 'Definir frente'], ['corner', 'Mover cantos'],
];
export const TERRAIN_TOOLS: Tool[] = ['raise', 'lower', 'smooth', 'flatten', 'landform'];
/** Pincéis de chão (usam o mesmo raio). */
export const GROUND_TOOLS: Tool[] = ['paint', 'forest', 'elements'];
export const ROAD_TOOLS: Tool[] = ['road', 'curve', 'free', 'roundabout', 'upgrade', 'blocks', 'move', 'split', 'bulldoze'];

export interface HudActions {
  tool(t: Tool): void;
  radius(r: number): void;
  strength(s: number): void;
  profile(p: number): void;
  zone(z: number): void;
  zoneRadius(r: number): void;
  floors(delta: number): void;
  /** Estilo de arquitetura (−1 = automático pelo bairro). */
  style(arch: number): void;
  buildingFn(fn: number): void;
  /** Ferramenta de lote: editar prédio, desenhar (retângulo, polígono), dividir, juntar, apagar, frente, cantos. */
  lotMode(mode: LotMode): void;
  /** Divisão: lado a lado ou frente e fundos, em quantas partes. */
  lotSplit(kind: 'side' | 'depth', parts: number): void;
  /** Zona: pincel ou quadra inteira. */
  zoneFill(block: boolean): void;
  lotUse(zone: number): void;
  demolishBuilding(): void;
  /** Ver por dentro: liga/desliga e muda o andar (+1 / −1). */
  inside(cmd: 'toggle' | 'up' | 'down'): void;
  elevation(delta: number): void;
  /** Encaixe da via: 0 desligado, 1 ângulos, 2 ângulos e grade. */
  roadSnap(mode: number): void;
  /** Corte da via rebaixada: talude ou muro de arrimo. */
  cutWalls(on: boolean): void;
  /** Quarteirões: colunas, linhas, quadra (m), giro (°). */
  blocks(b: { cols: number; rows: number; size: number; angle: number }): void;
  undo(): void;
  redo(): void;
  view(v: 'persp' | 'iso' | 'top'): void;
  save(): void;
  load(): void;
  exportMap(): void;
  importMap(file: File): void;
  newMap(): void;
  testCity(): void;
  generate(): void;
  options(): void;
  help(): void;
  trafficView(): void;
  follow(): void;
  /** Grade no mapa (liga/desliga). */
  grid(): void;
  /** Bússola: norte para cima. */
  north(): void;
  timeSpeed(): void;
  pause(): void;
  line(id: number): void;
  newLine(): void;
  lineMode(mode: number): void;
  buses(delta: number): void;
  deleteLine(): void;
  item(kind: number): void;
  signType(kind: number): void;
  /** Texto da placa (nome da rua etc.). */
  signText(text: string): void;
  barrierKind(kind: number): void;
  groundKind(kind: number): void;
  forestMode(cut: boolean): void;
  /** Espécie do bosque e modo uma árvore por clique. */
  forestSpecies(species: number): void;
  forestOne(one: boolean): void;
  /** Luz dos postes com fios. */
  poleLights(mode: number): void;
  biome(b: number): void;
  riverWidth(w: number): void;
  /** Relevo pronto do pincel. */
  landform(mode: string): void;
  /** Pincel de elementos: tipo (item), modo, densidade (por 100 m²) e tamanho (0..15). */
  elements(e: { kind: number; mode: 'lay' | 'eraseKind' | 'eraseAll'; density: number; size: number }): void;
  /** Aplainar o mapa inteiro. */
  flattenMap(): void;
  /** Clima ajustado pelo jogador (null = muda sozinho). */
  weather(w: WeatherCtl | null): void;
  /** Céu: ciclo de dia e noite, sempre dia ou sempre noite. */
  sky(mode: SkyMode): void;
  /** Água dos rios e do mar: ondas e espuma 0..1, correnteza em m/s. */
  water(w: { waves: number; foam: number; current: number }): void;
  /** Ferramenta Céu: o que o clique faz com as nuvens ou a neblina, e os valores das barras. */
  skyTool(s: SkyToolState): void;
  /** Espalhar nuvens pelo céu, ou apagar todas. */
  scatterClouds(count: number, variation: number): void;
  clearClouds(): void;
  /** Névoa geral (0..2). */
  fogLevel(v: number): void;
  /** Pessoas: cor da roupa (0..15), altura (0..15), andando (true) ou parada, quantas. */
  personSpec(p: { color: number; height: number; walk: boolean; count: number }): void;
  /** Força da bomba (1..5). */
  bombForce(f: number): void;
}

/** Categorias da barra: cada ferramenta mora numa; a linha de baixo mostra as da categoria escolhida. */
const CATEGORIES: Array<[string, string, Tool[]]> = [
  ['vias', 'Vias', ['road', 'curve', 'free', 'roundabout', 'upgrade', 'blocks', 'move', 'split', 'bulldoze']],
  ['cidade', 'Zonas e prédios', ['zone', 'building']],
  ['transporte', 'Transporte', ['transit']],
  ['rua', 'Rua', ['streetscape', 'barrier']],
  ['terreno', 'Terreno', ['raise', 'lower', 'smooth', 'flatten', 'landform', 'river']],
  ['natureza', 'Natureza', ['paint', 'elements', 'forest']],
  ['ceu', 'Céu e clima', ['weather', 'sky']],
  ['pessoas', 'Pessoas e ações', ['person', 'pistol', 'bomb']],
];

const TOOLS: Array<[Tool, string, string]> = [
  ['camera', 'Câmera', '1'],
  ['inspect', 'Inspecionar', 'I'],
  ['road', 'Via', '2'],
  ['curve', 'Curva', '3'],
  ['free', 'Livre', ''],
  ['roundabout', 'Rotatória', '4'],
  ['upgrade', 'Perfil', '5'],
  ['blocks', 'Quarteirões', ''],
  ['move', 'Mover', 'Y'],
  ['split', 'Dividir', 'X'],
  ['bulldoze', 'Demolir', '6'],
  ['zone', 'Zona', 'Z'],
  ['building', 'Prédio', 'B'],
  ['transit', 'Ônibus', 'L'],
  ['streetscape', 'Paisagismo', 'J'],
  ['barrier', 'Muros', 'M'],
  ['raise', 'Subir', '7'],
  ['lower', 'Descer', '8'],
  ['smooth', 'Alisar', '9'],
  ['flatten', 'Nivelar', '0'],
  ['landform', 'Relevos', ''],
  ['paint', 'Pintar', 'U'],
  ['elements', 'Elementos', ''],
  ['forest', 'Árvores', 'G'],
  ['river', 'Rio', 'N'],
  ['weather', 'Clima', ''],
  ['sky', 'Céu', ''],
  ['person', 'Pessoas', ''],
  ['pistol', 'Pistola', ''],
  ['bomb', 'Bomba', ''],
];

export class Hud {
  readonly root: HTMLElement;
  private toolButtons = new Map<Tool, HTMLButtonElement>();
  private subBar!: HTMLElement;
  private catButtons = new Map<HTMLElement, HTMLButtonElement>();
  private toolCat = new Map<Tool, HTMLElement>();
  private catRow: HTMLElement | null = null;
  private current: Tool = 'camera';

  private showCategory(row: HTMLElement | null): void {
    for (const [r, b] of this.catButtons) { r.style.display = r === row ? '' : 'none'; b.classList.toggle('open', r === row); }
    this.catRow = row;
  }
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private viewBtn!: HTMLButtonElement;
  private clockLabel!: HTMLElement;
  private info!: HTMLElement;
  private trafficBtn!: HTMLButtonElement;
  private gridBtn!: HTMLButtonElement;
  private compass!: HTMLElement;
  private compassDeg = 999;
  private speedBtn!: HTMLButtonElement;
  private pauseBtn!: HTMLButtonElement;
  private moneyLabel!: HTMLElement;
  private radiusInput!: HTMLInputElement;
  private radiusLabel!: HTMLElement;
  private brushPanel!: HTMLElement;
  private roadPanel!: HTMLElement;
  private blocksRow!: HTMLElement;
  private zonePanel!: HTMLElement;
  private zoneSel!: HTMLSelectElement;
  private buildingPanel!: HTMLElement;
  private buildingInfo!: HTMLElement;
  private archSel!: HTMLSelectElement;
  private lotSel!: HTMLSelectElement;
  private splitRow!: HTMLElement;
  private fnSel!: HTMLSelectElement;
  private elevLabel!: HTMLElement;
  private transitPanel!: HTMLElement;
  private itemPanel!: HTMLElement;
  private groundPanel!: HTMLElement;
  private forestPanel!: HTMLElement;
  private riverPanel!: HTMLElement;
  private landPanel!: HTMLElement;
  private elemPanel!: HTMLElement;
  private skyPanel!: HTMLElement;
  private personPanel!: HTMLElement;
  private bombPanel!: HTMLElement;
  private weatherPanel!: HTMLElement;
  private skySel!: HTMLSelectElement;
  private biomeSel!: HTMLSelectElement;
  private barrierPanel!: HTMLElement;
  private lineSel!: HTMLSelectElement;
  private lineInfo!: HTMLElement;
  private catalog!: RoadCatalog;
  private hint!: HTMLElement;
  private toastEl: HTMLElement;
  private toastTimer = 0;
  private loading: HTMLElement;
  private loadingText: HTMLElement;

  constructor(a: HudActions) {
    this.root = document.getElementById('hud')!;
    this.toastEl = document.getElementById('toast')!;
    this.loading = document.getElementById('loading')!;
    this.loadingText = document.getElementById('loading-text')!;

    const bar = el('div', 'bar');
    const tools = el('div', 'group');
    // câmera e inspecionar soltas; o resto por categoria (a linha de ferramentas aparece embaixo)
    this.subBar = el('div', 'subbar');
    const info = new Map(TOOLS.map(([t, l, k]) => [t, [l, k] as [string, string]]));
    const mk = (t: Tool) => {
      const [label, key] = info.get(t)!;
      const b = button(label, () => a.tool(t), key ? `${label} (${key})` : label);
      this.toolButtons.set(t, b);
      return b;
    };
    tools.append(mk('camera'), mk('inspect'), el('span', 'sep'));
    for (const [id, name, list] of CATEGORIES) {
      const row = el('div', 'group sub');
      for (const t of list) row.append(mk(t));
      row.style.display = 'none';
      this.subBar.append(row);
      const cb = button(name, () => {
        const open = this.catRow === row && row.style.display !== 'none';
        this.showCategory(open ? null : row);
        if (!open && !list.includes(this.current)) a.tool(list[0]);
      }, `${name}: ${list.map((t) => info.get(t)![0]).join(', ')}`);
      cb.dataset.cat = id;
      this.catButtons.set(row, cb);
      for (const t of list) this.toolCat.set(t, row);
      tools.append(cb);
    }
    bar.append(tools);

    const edit = el('div', 'group');
    this.undoBtn = button('↶', a.undo, 'Desfazer (Ctrl+Z)');
    this.redoBtn = button('↷', a.redo, 'Refazer (Ctrl+Y)');
    edit.append(this.undoBtn, this.redoBtn);
    bar.append(edit);

    const view = el('div', 'group');
    this.viewBtn = button('Perspectiva', () => a.view(this.viewBtn.dataset.mode === 'iso' ? 'persp' : 'iso'), 'Alternar perspectiva e isométrica (V)');
    this.trafficBtn = button('Trânsito', a.trafficView, 'Mostrar o congestionamento nas vias (K)');
    view.append(this.viewBtn, button('De cima', () => a.view('top'), 'Vista de cima (T)'), this.trafficBtn,
      button('Seguir', a.follow, 'Seguir o veículo mais perto do centro da tela (C); Esc solta'),
      (this.gridBtn = button('Grade', a.grid, 'Grade no mapa: linhas a cada 64 m (mostrar ou ocultar)')));
    // canto esquerdo: Menu (arquivo, opções, ajuda) e a vista; canto direito: relógio e dinheiro
    const left = el('div', 'corner-left'), right = el('div', 'corner-right');

    const fileIn = document.createElement('input');
    fileIn.type = 'file'; fileIn.accept = '.cidade'; fileIn.style.display = 'none';
    fileIn.addEventListener('change', () => { const f = fileIn.files?.[0]; if (f) a.importMap(f); fileIn.value = ''; });
    document.body.append(fileIn);
    const file = el('div', 'group menu-list hidden');
    const menuBtn = button('☰ Menu', () => file.classList.toggle('hidden'), 'Salvar, carregar, exportar, mapa novo, opções e ajuda');
    file.addEventListener('click', () => file.classList.add('hidden'));
    file.append(
      button('Salvar', a.save, 'Salvar (Ctrl+S)'),
      button('Carregar', a.load, 'Carregar o último salvamento'),
      button('Exportar', a.exportMap, 'Salvar o mapa num arquivo (para guardar ou levar para outro computador)'),
      button('Abrir arquivo', () => fileIn.click(), 'Abrir um mapa salvo em arquivo'),
      button('Novo mapa', a.newMap, 'Gerar outro relevo'),
      button('Gerar cidade', a.generate, 'Gerar uma cidade inteira pela semente do mapa'),
      button('Opções', a.options, 'Qualidade, resolução e tempo (O)'),
      button('Ajuda (F1)', a.help, 'Ajuda: ferramentas, teclas e sobre o jogo'),
    );
    const menuBox = el('div', 'group');
    menuBox.append(menuBtn);
    left.append(menuBox, view, file);

    const clock = el('div', 'group');
    this.clockLabel = el('span', 'value');
    this.speedBtn = button('1×', a.timeSpeed, 'Velocidade do relógio (P)');
    this.moneyLabel = el('span', 'value money');
    this.moneyLabel.title = 'Dinheiro em caixa. Vias custam pela largura e pelo comprimento; pontes e túneis custam mais. Demolir devolve metade.';
    this.pauseBtn = button('⏸', a.pause, 'Pausar ou continuar (Espaço)');
    this.skySel = selectOf([[0, '◐ Dia e noite'], [1, '☀ Sempre dia'], [2, '☾ Sempre noite']], 0, (v) => a.sky((['ciclo', 'dia', 'noite'] as const)[v]));
    this.skySel.title = 'Céu: o ciclo de dia e noite, sempre dia ou sempre noite';
    clock.append(this.clockLabel, this.pauseBtn, this.speedBtn, this.skySel, this.moneyLabel);
    right.append(clock);
    // bússola: gira com a câmera; clique deixa o norte para cima
    this.compass = el('button', 'compass');
    this.compass.title = 'Bússola: clique para ficar de frente para o norte';
    this.compass.innerHTML = '<svg viewBox="-20 -20 40 40" width="40" height="40"><circle r="18" fill="rgba(18,22,28,0.85)" stroke="rgba(255,255,255,0.25)"/><g class="needle"><path d="M0,-15 L5,0 L0,3 L-5,0 Z" fill="#e2564b"/><path d="M0,15 L5,0 L0,-3 L-5,0 Z" fill="#d9dde2"/><text y="-6" x="0" font-size="7" text-anchor="middle" fill="#fff" font-family="sans-serif" font-weight="700">N</text></g></svg>';
    this.compass.addEventListener('click', (e) => { e.stopPropagation(); a.north(); });
    right.append(this.compass);
    this.root.append(bar, this.subBar, left, right);
    // números da cidade, no canto
    this.info = el('div', 'info');
    this.root.append(this.info);

    // painel do pincel
    const panels = el('div', 'panels');
    this.brushPanel = el('div', 'group brush');
    this.radiusLabel = el('span', 'value');
    this.radiusInput = slider(5, 400, 60, (v) => { this.radiusLabel.textContent = `${v} m`; a.radius(v); });
    this.radiusLabel.textContent = '60 m';
    const strength = slider(1, 100, 40, (v) => a.strength(v / 100));
    this.brushPanel.append(label('Raio'), this.radiusInput, this.radiusLabel, label('Força'), strength);

    // painel das vias
    this.roadPanel = el('div', 'group brush');
    this.catalog = new RoadCatalog({ use: (id) => a.profile(id), toast: (t) => this.toast(t) });
    this.root.append(this.catalog.el);
    this.elevLabel = el('span', 'value');
    const blk = { cols: 3, rows: 3, size: 100, angle: 0 };
    const num = (v: number, min: number, max: number, step: number, set: (n: number) => void) => {
      const i = document.createElement('input'); i.type = 'number'; i.min = String(min); i.max = String(max); i.step = String(step); i.value = String(v); i.className = 'num';
      i.addEventListener('change', () => { set(Math.max(min, Math.min(max, Number(i.value) || min))); a.blocks({ ...blk }); });
      i.addEventListener('keydown', (e) => e.stopPropagation());
      return i;
    };
    this.blocksRow = el('span', 'inline');
    this.blocksRow.append(label('Colunas'), num(3, 1, 12, 1, (n) => { blk.cols = n; }), label('Linhas'), num(3, 1, 12, 1, (n) => { blk.rows = n; }),
      label('Lado (m)'), num(100, 40, 300, 10, (n) => { blk.size = n; }), label('Giro'), num(0, -90, 90, 5, (n) => { blk.angle = n; }));
    this.roadPanel.append(label('Corte'), selectOf([[0, 'Talude'], [1, 'Muro de arrimo']], 0, (v) => a.cutWalls(v === 1)), label('Encaixe'), selectOf([[0, 'Desligado'], [1, 'Ângulos de 15°'], [2, 'Ângulos e grade de 1 m']], 0, a.roadSnap), this.blocksRow,
      label('Altura'),
      button('−', () => a.elevation(-4), 'Mais baixo (Page Down)'), this.elevLabel, button('+', () => a.elevation(4), 'Mais alto (Page Up)'));
    // painel de zona
    this.zonePanel = el('div', 'group brush');
    this.zoneSel = document.createElement('select');
    ZONE_NAMES.forEach((name, z) => {
      const o = document.createElement('option');
      o.value = String(z); o.textContent = z === 0 ? 'Tirar zona' : name;
      this.zoneSel.append(o);
    });
    this.zoneSel.value = '1';
    this.zoneSel.addEventListener('change', () => { a.zone(Number(this.zoneSel.value)); this.zoneSel.blur(); });
    const zr = el('span', 'value');
    zr.textContent = '40 m';
    const zs = slider(10, 200, 40, (v) => { zr.textContent = `${v} m`; a.zoneRadius(v); });
    this.zonePanel.append(label('Zona'), this.zoneSel, selectOf([[0, 'Pincel'], [1, 'Quadra inteira']], 0, (v) => a.zoneFill(v === 1)), label('Raio'), zs, zr);

    // painel de prédio
    this.buildingPanel = el('div', 'group brush');
    this.archSel = selectOf([[-1, 'Automático (bairro)'], ...ARCHES.map((x, i) => [i, x.name] as [number, string])], -1, a.style);
    this.fnSel = selectOf(FN_NAMES.map((n, i) => [i, n || 'Comum'] as [number, string]), 0, a.buildingFn);
    this.buildingInfo = el('span', 'value');
    this.buildingPanel.append(this.buildingInfo,
      label('Andares'), button('−', () => a.floors(-1), 'Menos andares'), button('+', () => a.floors(1), 'Mais andares'),
      label('Estilo'), this.archSel, label('Função'), this.fnSel,
      button('Demolir', () => a.demolishBuilding(), 'Demolir o prédio'));
    const modes = LOT_MODES.map(([, n], i) => [i, n] as [number, string]);
    this.lotSel = selectOf(modes, 0, (i) => { this.splitRow.style.display = LOT_MODES[i][0] === 'split' ? '' : 'none'; a.lotMode(LOT_MODES[i][0]); });
    let splitKind: 'side' | 'depth' = 'side', parts = 2;
    this.splitRow = el('span', 'inline');
    this.splitRow.append(selectOf([[0, 'Lado a lado'], [1, 'Frente e fundos']], 0, (v) => { splitKind = v ? 'depth' : 'side'; a.lotSplit(splitKind, parts); }),
      selectOf([2, 3, 4, 5, 6].map((n) => [n, `${n} lotes`] as [number, string]), 2, (v) => { parts = v; a.lotSplit(splitKind, parts); }));
    this.splitRow.style.display = 'none';
    this.buildingPanel.append(button('Ver por dentro', () => a.inside('toggle'), 'Ver por dentro: o prédio escolhido (ou o do centro da tela) cortado num andar'),
      button('▼', () => a.inside('down'), 'Andar abaixo'), button('▲', () => a.inside('up'), 'Andar acima'));
    this.buildingPanel.append(label('Lote'), this.lotSel, this.splitRow, label('Uso'),
      selectOf([[1, 'Residencial'], [2, 'Comercial'], [3, 'Industrial'], [4, 'Misto']] as Array<[number, string]>, 1, a.lotUse));
    // painel de ônibus
    this.transitPanel = el('div', 'group brush');
    this.lineSel = document.createElement('select');
    this.lineSel.addEventListener('change', () => { a.line(Number(this.lineSel.value)); this.lineSel.blur(); });
    this.lineInfo = el('span', 'value');
    this.transitPanel.append(label('Linha'), this.lineSel, selectOf(MODE_NAMES.map((n, i) => [i, n] as [number, string]), 0, a.lineMode),
      button('Nova linha', () => a.newLine(), 'Começar outra linha (ônibus: paradas na calçada; trem e metrô: estações nos trilhos)'),
      label('Ônibus'), button('−', () => a.buses(-1), 'Menos ônibus'), button('+', () => a.buses(1), 'Mais ônibus'),
      this.lineInfo, button('Apagar linha', () => a.deleteLine(), 'Apagar a linha escolhida'));
    // paisagismo e muros
    this.itemPanel = el('div', 'group brush');
    const signText = document.createElement('input');
    signText.type = 'text'; signText.maxLength = 32; signText.className = 'text';
    signText.placeholder = 'Texto da placa (opcional)';
    signText.addEventListener('keydown', (e) => e.stopPropagation());
    signText.addEventListener('input', () => a.signText(signText.value));
    const signSel = selectOf(SIGN_TYPES, 4, (v) => { signText.placeholder = v === 2 ? 'Nome da rua, depois clique nela' : 'Texto da placa (opcional)'; a.signType(v); });
    signSel.style.display = 'none'; signText.style.display = 'none';
    this.itemPanel.append(label('Item'), selectOf(STREET_ITEMS, Item.Tree, (v) => { signSel.style.display = signText.style.display = v === Item.Sign ? '' : 'none'; a.item(v); }), signSel, signText);
    this.barrierPanel = el('div', 'group brush');
    const lights = selectOf([[0, 'Sem luz'], [1, 'Luz em postes alternados'], [2, 'Luz em todos os postes']], 0, a.poleLights);
    lights.style.display = 'none';
    this.barrierPanel.append(label('Tipo'), selectOf(BARRIER_KINDS, Item.Fence, (v) => { lights.style.display = v === Item.PoleLine ? '' : 'none'; a.barrierKind(v); }), lights);
    // chão, árvores e rio
    this.groundPanel = el('div', 'group brush');
    this.groundPanel.append(label('Chão'), selectOf(GROUND_NAMES, Ground.Sand, a.groundKind));
    this.forestPanel = el('div', 'group brush');
    this.forestPanel.append(label('Árvores'), selectOf([[0, 'Plantar bosque'], [1, 'Cortar árvores'], [2, 'Uma árvore por clique']], 0, (v) => { a.forestMode(v === 1); a.forestOne(v === 2); }),
      label('Espécie'), selectOf(TREE_SPECIES, 0, a.forestSpecies),
      label('Bioma do mapa'), (this.biomeSel = selectOf(BIOMES.map((n, i) => [i, n] as [number, string]), 0, a.biome)));
    this.riverPanel = el('div', 'group brush');
    const rw = el('span', 'value'); rw.textContent = '14 m';
    this.riverPanel.append(label('Largura'), slider(6, 60, 14, (v) => { rw.textContent = `${v} m`; a.riverWidth(v); }), rw);
    // clima: barras que valem na hora; clique no mapa faz cair um raio
    this.weatherPanel = el('div', 'group brush');
    const wc: WeatherCtl = { rain: 0, wind: 4, dir: 65, lightning: 0, thunder: 1 };
    let manual = false;
    const send = () => a.weather(manual ? { ...wc } : null);
    const modeSel = selectOf([[0, 'Muda sozinho'], [1, 'Ajustado aqui']], 0, (v) => { manual = v === 1; send(); });
    const wbar = (name: string, min: number, max: number, v: number, unit: string, set: (n: number) => void): HTMLElement[] => {
      const val = el('span', 'value'); val.textContent = `${v}${unit}`;
      const sl = slider(min, max, v, (n) => { val.textContent = `${n}${unit}`; set(n); manual = true; modeSel.value = '1'; send(); });
      return [label(name), sl, val];
    };
    this.weatherPanel.append(label('Tempo'), modeSel,
      ...wbar('Chuva', 0, 100, 0, '%', (n) => { wc.rain = n / 100; }),
      ...wbar('Vento', 0, 25, 4, ' m/s', (n) => { wc.wind = n; }),
      ...wbar('Direção', 0, 359, 65, '°', (n) => { wc.dir = n; }),
      ...wbar('Raios', 0, 12, 0, '/min', (n) => { wc.lightning = n; }),
      ...wbar('Trovão', 0, 100, 100, '%', (n) => { wc.thunder = n / 100; }));
    const wa = { waves: 0.3, foam: 0.4, current: 0.5 };
    const abar = (name: string, min: number, max: number, v: number, unit: string, set: (n: number) => void): HTMLElement[] => {
      const val = el('span', 'value'); val.textContent = `${v}${unit}`;
      return [label(name), slider(min, max, v, (n) => { val.textContent = `${n}${unit}`; set(n); a.water({ ...wa }); }), val];
    };
    this.weatherPanel.append(el('span', 'sep'), label('Água:'),
      ...abar('Ondas', 0, 100, 30, '%', (n) => { wa.waves = n / 100; }),
      ...abar('Espuma', 0, 100, 40, '%', (n) => { wa.foam = n / 100; }),
      ...abar('Correnteza', 0, 3, 0.5, ' m/s', (n) => { wa.current = n; }));
    this.landPanel = el('div', 'group brush');
    this.landPanel.append(label('Relevo'), selectOf([[0, 'Chapada (arenito)'], [1, 'Cânion (arenito)'], [2, 'Escarpa de basalto'], [3, 'Pão de açúcar (granito)'], [4, 'Ravina']], 0,
      (v) => a.landform(['mesa', 'canyon', 'escarpment', 'sugarloaf', 'gully'][v])),
      button('Aplainar mapa inteiro', () => a.flattenMap(), 'Deixa todo o relevo plano na altura do centro da tela (desfaz com Ctrl+Z)'));
    this.elemPanel = el('div', 'group brush');
    const ec = { kind: 30, mode: 'lay' as 'lay' | 'eraseKind' | 'eraseAll', density: 8, size: 7 };
    const ELEMS: Array<[number, string]> = [[30, 'Pedras'], [31, 'Seixos'], [32, 'Cascalho'], [33, 'Folhas secas'], [34, 'Grama'], [35, 'Capim alto'],
      [36, 'Mato'], [37, 'Samambaia'], [38, 'Trevo'], [39, 'Flores'], [40, 'Cogumelos']];
    const ed = el('span', 'value'); ed.textContent = '8';
    const es = el('span', 'value'); es.textContent = '100%';
    this.elemPanel.append(label('Elemento'), selectOf(ELEMS, 30, (v) => { ec.kind = v; a.elements({ ...ec }); }),
      selectOf([[0, 'Colocar'], [1, 'Apagar este tipo'], [2, 'Apagar tudo']], 0, (v) => { ec.mode = (['lay', 'eraseKind', 'eraseAll'] as const)[v]; a.elements({ ...ec }); }),
      label('Densidade'), slider(1, 40, 8, (v) => { ec.density = v; ed.textContent = String(v); a.elements({ ...ec }); }), ed,
      label('Tamanho'), slider(0, 15, 7, (v) => { ec.size = v; es.textContent = `${Math.round((0.6 + v / 15) * 100 / 1.07)}%`; a.elements({ ...ec }); }), es);
    this.skyPanel = el('div', 'group brush');
    const sk: SkyToolState = { cloud: 'add', fog: 'none', size: 500, base: 900, density: 0.8, fogHeight: 6 };
    const skVal = (t: string) => { const v = el('span', 'value'); v.textContent = t; return v; };
    const sv = skVal('500 m'), bv = skVal('900 m'), dv = skVal('80%'), hv = skVal('6'), gv = skVal('100%'), cv = skVal('8');
    let count = 8;
    const cloudSel = selectOf([[0, 'Criar nuvem'], [1, 'Mover nuvem'], [2, 'Ajustar nuvem'], [3, 'Apagar nuvem'], [4, '—']], 0, (v) => {
      sk.cloud = (['add', 'move', 'edit', 'remove', 'none'] as const)[v]; if (v < 4) { sk.fog = 'none'; fogSel.value = '0'; } a.skyTool({ ...sk });
    });
    const fogSel = selectOf([[0, '—'], [1, 'Pôr neblina'], [2, 'Apagar neblina']], 0, (v) => {
      sk.fog = (['none', 'lay', 'erase'] as const)[v]; if (v > 0) { sk.cloud = 'none'; cloudSel.value = '4'; } a.skyTool({ ...sk });
    });
    this.skyPanel.append(label('Nuvem'), cloudSel,
      label('Tamanho'), slider(100, 1500, 500, (v) => { sk.size = v; sv.textContent = `${v} m`; a.skyTool({ ...sk }); }), sv,
      label('Base'), slider(300, 2500, 900, (v) => { sk.base = v; bv.textContent = `${v} m`; a.skyTool({ ...sk }); }), bv,
      label('Densidade'), slider(10, 100, 80, (v) => { sk.density = v / 100; dv.textContent = `${v}%`; a.skyTool({ ...sk }); }), dv,
      slider(1, 24, 8, (v) => { count = v; cv.textContent = String(v); }), cv,
      button('Espalhar nuvens', () => a.scatterClouds(count, 0.5), 'Espalha nuvens pelo céu em volta da câmera'),
      button('Apagar todas', () => a.clearClouds(), 'Apaga todas as nuvens do céu'),
      el('span', 'sep'), label('Neblina'), fogSel,
      label('Altura'), slider(1, 15, 6, (v) => { sk.fogHeight = v; hv.textContent = String(v); a.skyTool({ ...sk }); }), hv,
      label('Névoa geral'), slider(0, 200, 100, (v) => { gv.textContent = `${v}%`; a.fogLevel(v / 100); }), gv);
    // criador de pessoas: roupa, altura e se fica parada ou sai andando
    this.personPanel = el('div', 'group brush');
    const ps = { color: 3, height: 7, walk: false, count: 1 };
    const pal = el('span', 'inline');
    PAINT_SWATCHES.forEach((c, i) => {
      const b = document.createElement('button'); b.className = 'swatch'; b.style.background = c; b.title = 'Cor da roupa';
      b.addEventListener('click', (e) => { e.stopPropagation(); ps.color = i; for (const o of pal.children) (o as HTMLElement).classList.remove('active'); b.classList.add('active'); a.personSpec({ ...ps }); });
      if (i === ps.color) b.classList.add('active');
      pal.append(b);
    });
    const phv = el('span', 'value'); phv.textContent = '1,72 m';
    this.personPanel.append(label('Roupa'), pal, label('Altura'), slider(0, 15, 7, (v) => { ps.height = v; phv.textContent = `${((0.86 + v * 0.02) * 1.75).toFixed(2).replace('.', ',')} m`; a.personSpec({ ...ps }); }), phv,
      selectOf([[0, 'Parada (fica aqui)'], [1, 'Andando pela calçada']], 0, (v) => { ps.walk = v === 1; a.personSpec({ ...ps }); }),
      label('Quantas'), selectOf([1, 2, 5, 10, 20].map((n) => [n, String(n)] as [number, string]), 1, (v) => { ps.count = v; a.personSpec({ ...ps }); }));
    this.bombPanel = el('div', 'group brush');
    const fv = el('span', 'value'); fv.textContent = '3';
    this.bombPanel.append(label('Força'), slider(1, 5, 3, (v) => { fv.textContent = String(v); a.bombForce(v); }), fv);
    panels.append(this.personPanel, this.bombPanel, this.skyPanel, this.elemPanel, this.landPanel, this.weatherPanel, this.groundPanel, this.forestPanel, this.riverPanel, this.itemPanel, this.barrierPanel, this.brushPanel, this.roadPanel, this.zonePanel, this.buildingPanel, this.transitPanel);
    this.root.append(panels);

    this.hint = el('div', 'hint');
    this.root.append(this.hint);

    const help = el('div', 'help');
    help.innerHTML =
      '<b>Botão direito</b> gira · <b>meio</b> ou <b>arrastar</b> move · <b>roda</b> aproxima · ' +
      '<b>WASD</b> move · <b>Q/E</b> gira · <b>R/F</b> inclina · <b>Esc</b> cancela';
    this.root.append(help);
    this.setElevation(0);
  }

  setTool(t: Tool): void {
    this.current = t;
    for (const [k, b] of this.toolButtons) b.classList.toggle('active', k === t);
    // a categoria da ferramenta fica aberta e marcada (atalho de teclado também abre)
    const row = this.toolCat.get(t) ?? null;
    if (row) this.showCategory(row);
    for (const [r, b] of this.catButtons) b.classList.toggle('active', r === row);
    this.brushPanel.style.display = TERRAIN_TOOLS.includes(t) || GROUND_TOOLS.includes(t) || t === 'sky' ? '' : 'none';
    this.groundPanel.style.display = t === 'paint' ? '' : 'none';
    this.forestPanel.style.display = t === 'forest' ? '' : 'none';
    this.riverPanel.style.display = t === 'river' ? '' : 'none';
    this.weatherPanel.style.display = t === 'weather' ? '' : 'none';
    this.landPanel.style.display = t === 'landform' ? '' : 'none';
    this.elemPanel.style.display = t === 'elements' ? '' : 'none';
    this.skyPanel.style.display = t === 'sky' ? '' : 'none';
    this.personPanel.style.display = t === 'person' ? '' : 'none';
    this.bombPanel.style.display = t === 'bomb' ? '' : 'none';
    this.roadPanel.style.display = ROAD_TOOLS.includes(t) && t !== 'bulldoze' && t !== 'move' && t !== 'split' ? '' : 'none';
    this.catalog.visible = ROAD_TOOLS.includes(t) && t !== 'bulldoze' && t !== 'roundabout' && t !== 'move' && t !== 'split';
    void 0;
    this.zonePanel.style.display = t === 'zone' ? '' : 'none';
    this.blocksRow.style.display = t === 'blocks' ? '' : 'none';
    this.buildingPanel.style.display = t === 'building' ? '' : 'none';
    this.transitPanel.style.display = t === 'transit' ? '' : 'none';
    this.itemPanel.style.display = t === 'streetscape' ? '' : 'none';
    this.barrierPanel.style.display = t === 'barrier' ? '' : 'none';
  }

  /** Lista de linhas e a escolhida. */
  /** Modo de cada linha (para o nome na lista). */
  lineModes = new Map<number, number>();

  setLines(ids: number[], current: number): void {
    const key = ids.join(',') + '|' + current + '|' + [...this.lineModes.values()].join(',');
    if (this.lineSel.dataset.key === key) return;
    this.lineSel.dataset.key = key;
    this.lineSel.innerHTML = '';
    for (const id of ids) {
      const o = document.createElement('option');
      o.value = String(id); o.textContent = `Linha ${id}${this.lineModes.get(id) ? ` (${MODE_NAMES[this.lineModes.get(id)!]})` : ''}`;
      this.lineSel.append(o);
    }
    if (ids.length === 0) { const o = document.createElement('option'); o.textContent = '—'; this.lineSel.append(o); }
    this.lineSel.value = String(current);
  }

  setLineInfo(text: string): void { if (this.lineInfo.textContent !== text) this.lineInfo.textContent = text; }

  setRadius(r: number): void {
    this.radiusInput.value = String(r);
    this.radiusLabel.textContent = `${Math.round(r)} m`;
  }

  setProfile(p: number): void { this.catalog.select(p); }

  setBiome(b: number): void { this.biomeSel.value = String(b); }

  setSky(m: SkyMode): void { this.skySel.value = String(['ciclo', 'dia', 'noite'].indexOf(m)); }

  setZone(z: number): void { this.zoneSel.value = String(z); }

  /** Prédio selecionado (ou nenhum). */
  setLotMode(mode: LotMode): void { this.lotSel.value = String(LOT_MODES.findIndex(([m]) => m === mode)); this.splitRow.style.display = mode === 'split' ? '' : 'none'; }

  setBuilding(text: string, arch = -1, fn = 0): void {
    this.buildingInfo.textContent = text;
    this.archSel.value = String(arch); this.fnSel.value = String(fn);
    const on = text.includes('andar');
    // sem prédio escolhido, estilo e função valem para o próximo lote desenhado
    for (const b of this.buildingPanel.querySelectorAll('button')) if (!['Ver por dentro', '▼', '▲'].includes(b.textContent ?? '')) (b as HTMLButtonElement).disabled = !on;
  }

  setElevation(e: number): void {
    this.elevLabel.textContent = e === 0 ? 'no chão' : `${e > 0 ? '+' : ''}${e} m`;
  }

  setClock(hour: number, speed: number, paused = false): void {
    const p = paused ? '▶' : '⏸';
    if (this.pauseBtn.textContent !== p) { this.pauseBtn.textContent = p; this.pauseBtn.classList.toggle('active', paused); }
    const h = Math.floor(hour), m = Math.floor((hour - h) * 60);
    const t = `${String(h).padStart(2, '0')}:${String(m - (m % 5)).padStart(2, '0')}`;
    if (this.clockLabel.textContent !== t) this.clockLabel.textContent = t;
    const s = speed === 0 ? 'Pausa' : `${speed}×`;
    if (this.speedBtn.textContent !== s) this.speedBtn.textContent = s;
  }

  setMoney(v: number, unlimited: boolean): void {
    const t = unlimited ? 'R$ ∞' : `R$ ${Math.round(v).toLocaleString('pt-BR')}`;
    if (this.moneyLabel.textContent !== t) this.moneyLabel.textContent = t;
  }

  setInfo(html: string): void { if (this.info.innerHTML !== html) this.info.innerHTML = html; }

  setTrafficView(on: boolean): void { this.trafficBtn.classList.toggle('active', on); }

  setGrid(on: boolean): void { this.gridBtn.classList.toggle('active', on); }

  /** Rumo da câmera (rad): a agulha aponta para o norte na tela. */
  setCompass(yaw: number): void {
    const d = Math.round(yaw * 180 / Math.PI);
    if (d === this.compassDeg) return;
    this.compassDeg = d;
    (this.compass.querySelector('.needle') as SVGGElement).setAttribute('transform', `rotate(${d})`);
  }

  setHint(text: string): void {
    this.hint.textContent = text;
    this.hint.style.display = text ? '' : 'none';
  }

  setHistory(canUndo: boolean, canRedo: boolean): void {
    this.undoBtn.disabled = !canUndo;
    this.redoBtn.disabled = !canRedo;
  }

  setView(mode: 'persp' | 'iso'): void {
    this.viewBtn.dataset.mode = mode;
    this.viewBtn.textContent = mode === 'iso' ? 'Isométrica' : 'Perspectiva';
  }

  toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 2600);
  }

  showLoading(text: string): void {
    this.loadingText.textContent = text;
    this.loading.classList.remove('hidden');
  }

  hideLoading(): void { this.loading.classList.add('hidden'); }

  fatal(text: string): void {
    this.loadingText.textContent = text;
    this.loading.classList.add('error');
    this.loading.classList.remove('hidden');
  }
}

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

function label(t: string): HTMLElement {
  const e = el('span', 'label');
  e.textContent = t;
  return e;
}

function button(text: string, fn: () => void, title = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.title = title;
  b.addEventListener('click', (e) => { e.stopPropagation(); fn(); (e.currentTarget as HTMLElement).blur(); });
  return b;
}

function selectOf(opts: Array<[number, string]>, value: number, fn: (v: number) => void): HTMLSelectElement {
  const s = document.createElement('select');
  for (const [v, t] of opts) { const o = document.createElement('option'); o.value = String(v); o.textContent = t; s.append(o); }
  s.value = String(value);
  s.addEventListener('change', () => { fn(Number(s.value)); s.blur(); });
  return s;
}

function slider(min: number, max: number, value: number, fn: (v: number) => void): HTMLInputElement {
  const i = document.createElement('input');
  i.type = 'range';
  i.min = String(min); i.max = String(max); i.value = String(value);
  if (max - min <= 5) i.step = '0.1';
  i.addEventListener('input', () => fn(Number(i.value)));
  return i;
}

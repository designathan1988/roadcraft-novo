// Tela de entrada: cidade nova pela semente, mapa vazio, carregar, opções, sair.

import { MAP_SIZES, MAP_TILES, TILE_SIZE } from '../config.ts';

export interface MenuActions {
  newCity(seed: number, tiles: number): void;
  empty(tiles: number): void;
  load(): void;
  options(): void;
}

export class StartMenu {
  readonly root: HTMLElement;

  constructor(parent: HTMLElement, maxLayers: number, a: MenuActions) {
    const r = document.createElement('div');
    r.className = 'options menu';
    const box = document.createElement('div');
    box.className = 'options-box menu-box';
    const title = document.createElement('h1');
    title.textContent = 'Cidade';
    const sub = document.createElement('p');
    sub.className = 'opt-note';
    sub.textContent = 'Vias, trânsito e cidades inteiras de 10 a 24 km.';
    const seedRow = document.createElement('div'); seedRow.className = 'opt-row';
    const seedLabel = document.createElement('span'); seedLabel.textContent = 'Semente';
    const seed = document.createElement('input'); seed.type = 'number'; seed.min = '1'; seed.value = String(1 + Math.floor(Math.random() * 9999));
    seed.className = 'seed';
    seedRow.append(seedLabel, seed);
    const sizeRow = document.createElement('div'); sizeRow.className = 'opt-row';
    const sizeLabel = document.createElement('span'); sizeLabel.textContent = 'Tamanho do mapa';
    const size = document.createElement('select');
    for (const t of MAP_SIZES) {
      const o = document.createElement('option');
      o.value = String(t);
      // um ladrilho por camada de textura: placas com poucas camadas não abrem os mapas maiores
      if (t * t > maxLayers) o.disabled = true;
      o.textContent = `${Math.round(t * TILE_SIZE / 1000)} km × ${Math.round(t * TILE_SIZE / 1000)} km`;
      size.append(o);
    }
    size.value = String(MAP_TILES);
    sizeRow.append(sizeLabel, size);
    const tiles = () => Number(size.value);
    const btn = (label: string, fn: () => void, main = false) => {
      const b = document.createElement('button'); b.textContent = label;
      if (main) b.className = 'main';
      b.addEventListener('click', () => { fn(); });
      return b;
    };
    const close = () => r.classList.add('hidden');
    const list = document.createElement('div'); list.className = 'menu-buttons';
    list.append(
      btn('Gerar cidade nova', () => { close(); a.newCity(Math.max(1, Number(seed.value) >>> 0), tiles()); }, true),
      btn('Começar num mapa vazio', () => { close(); a.empty(tiles()); }),
      btn('Carregar o último jogo', () => { close(); a.load(); }),
      btn('Opções', () => a.options()),
    );
    // sair só faz sentido no executável
    if ((globalThis as { cidadeSteam?: unknown }).cidadeSteam) list.append(btn('Sair', () => window.close()));
    box.append(title, sub, seedRow, sizeRow, list);
    r.append(box);
    parent.append(r);
    this.root = r;
  }

  show(): void { this.root.classList.remove('hidden'); }
  hide(): void { this.root.classList.add('hidden'); }
}

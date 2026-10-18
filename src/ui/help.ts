declare const __BUILD__: string;
// Ajuda: o que cada ferramenta faz, com a tecla, e os atalhos da câmera (F1 ou H).

const TOOLS_HELP: Array<[string, string, string]> = [
  ['Câmera', '1', 'Só olha: arrasta, gira e aproxima sem mexer em nada.'],
  ['Inspecionar', 'I', 'Clique num cruzamento para escolher semáforo, placas, regras de cada via, movimentos proibidos e tempos; ou numa via para ver o perfil.'],
  ['Via', '2', 'Clique e clique: desenha um trecho reto com o perfil escolhido no catálogo (ruas, avenidas, rodovias, trilhos). Alt+clique copia o perfil de uma via.'],
  ['Curva', '3', 'Três cliques: começo, ponto de controle e fim.'],
  ['Livre', '', 'Arraste: a via segue o cursor em curvas suaves.'],
  ['Rotatória', '4', 'Clique num cruzamento ou no chão; [ e ] mudam o raio.'],
  ['Perfil', '5', 'Troca o perfil de uma via existente; Shift troca a rua inteira.'],
  ['Quarteirões', '', 'Clique: uma grade de ruas inteira (colunas, linhas, tamanho da quadra e giro).'],
  ['Mover', 'Y', 'Arrasta um nó; as vias ligadas acompanham.'],
  ['Dividir', 'X', 'Clique numa via para dividi-la em duas.'],
  ['Demolir', '6', 'Clique numa via, prédio, item ou muro; arraste um retângulo para tirar tudo dentro (vias devolvem metade).'],
  ['Zona', 'Z', 'Pincel dos lados das vias, ou a quadra inteira num clique: residencial, comercial, industrial, misto. Os prédios nascem sozinhos.'],
  ['Prédio', 'B', 'Prédio e lotes: andares, estilo e função; desenhar lote (retângulo ou polígono), dividir, juntar, apagar, frente e cantos.'],
  ['Ônibus', 'L', 'Linhas de ônibus (paradas na calçada), trem e metrô (estações nos trilhos).'],
  ['Paisagismo', 'J', 'Árvores, bancos, postes, placas, hidrantes, fumaça, fogo, vapor e chafariz.'],
  ['Muros', 'M', 'Traços de cerca, muro, sebe, defensa, gradil e postes com fios.'],
  ['Subir / Descer', '7 / 8', 'Pincel de relevo.'],
  ['Alisar / Nivelar', '9 / 0', 'Suaviza o terreno ou o deixa na altura de onde começou o traço.'],
  ['Elementos', '', 'Pincel de pedras, seixos, cascalho, folhas, grama, capim, mato, samambaia, trevo, flores e cogumelos.'],
  ['Relevos', '', 'Chapada, cânion, escarpa, pão de açúcar e ravina, com a rocha certa; e aplainar o mapa inteiro.'],
  ['Pintar', 'U', 'Pinta o chão: terra, areia, cascalho, flores, pedras… (Grama apaga).'],
  ['Árvores', 'G', 'Planta um bosque ou abre clareira.'],
  ['Céu', '', 'Nuvens: criar, mover, ajustar, apagar e espalhar; neblina em pincel e névoa geral.'],
  ['Pessoas', '', 'Criador de pessoas: roupa e altura; parada ou andando pela calçada.'],
  ['Pistola / Bomba', '', 'Clique numa pessoa (pistola) ou onde a bomba cai: prédios no raio desabam e viram entulho.'],
  ['Clima', '', 'Chuva, vento, direção, raios por minuto e trovão; clique no mapa: cai um raio.'],
  ['Rio', 'N', 'Clique os pontos do rio de cima para baixo; Enter termina.'],
];

const KEYS_HELP: Array<[string, string]> = [
  ['Botão direito / Q e E', 'Girar a câmera'],
  ['Meio ou arrastar / WASD', 'Mover a câmera'],
  ['Roda / + e −', 'Aproximar e afastar'],
  ['R / F', 'Inclinar'],
  ['V / T', 'Isométrica e vista de cima'],
  ['C', 'Seguir o veículo mais perto do centro (Esc solta)'],
  ['K', 'Mapa de congestionamento'],
  ['Espaço', 'Pausar ou continuar (carros e relógio)'],
  ['P', 'Velocidade do relógio'],
  ['Ctrl+Z / Ctrl+Y', 'Desfazer e refazer'],
  ['Ctrl+S', 'Salvar'],
  ['O', 'Opções'],
  ['F9', 'Saúde do jogo (erros e quadros lentos)'],
  ['Esc', 'Cancelar ou voltar à câmera'],
];

export class HelpPanel {
  readonly root: HTMLElement;

  constructor(parent: HTMLElement) {
    const r = document.createElement('div');
    r.className = 'options hidden';
    const box = document.createElement('div');
    box.className = 'options-box help-box';
    const h = document.createElement('h2'); h.textContent = 'Ajuda';
    box.append(h);
    const table = (rows: Array<string[]>, title: string) => {
      const t = document.createElement('h3'); t.textContent = title;
      const g = document.createElement('div'); g.className = 'help-grid';
      for (const row of rows) for (const cell of row) { const c = document.createElement('span'); c.textContent = cell; g.append(c); }
      box.append(t, g);
    };
    table(TOOLS_HELP, 'Ferramentas');
    table(KEYS_HELP.map(([k, d]) => [k, '', d]), 'Teclas');
    // sobre: versão e créditos
    const about = document.createElement('h3'); about.textContent = 'Sobre';
    const ab = document.createElement('p'); ab.className = 'about';
    ab.textContent = `Cidade ${typeof __BUILD__ === 'string' ? __BUILD__ : ''}. Feito com three.js (MIT), Vite (MIT), Electron (MIT) e steamworks.js (MIT). ` +
      'Sons sintetizados no próprio jogo; árvores, prédios e veículos gerados por código.';
    box.append(about, ab);
    const close = document.createElement('button'); close.textContent = 'Fechar';
    close.addEventListener('click', () => this.close());
    box.append(close);
    r.append(box);
    r.addEventListener('pointerdown', (e) => { if (e.target === r) this.close(); });
    parent.append(r);
    this.root = r;
  }

  get open(): boolean { return !this.root.classList.contains('hidden'); }
  toggle(): void { this.root.classList.toggle('hidden'); }
  close(): void { this.root.classList.add('hidden'); }
}

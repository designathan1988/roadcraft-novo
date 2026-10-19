# Recursos: o que o jogo tem que ter (a lista do Roadcraft) e o estado aqui

Fonte da lista: o Roadcraft 4.0 (`C:\Users\Jonathan\Documents\Projects\roadcraft\roadcraft-4.0-main`, só leitura),
seus dicionários (`data/textos-roadcraft/pt-BR.ts`, 1.760 linhas: cada chave é um recurso) e o inventário feito em
2026-10-18. `docs/PARIDADE-roadcraft-3.md` tem o critério de pronto de cada linha ("clico X, vejo Y") e o estado em
que o motor chegou. Estado aqui: ✅ existe e foi visto · 🟡 existe, mas abaixo do Roadcraft · ❌ falta.
Quem termina um item põe ✅, o commit e o nome da foto.

## 1. Interface (a do Roadcraft, não a do motor) — ✅ (ramo da interface, commits 9c833c2…; fotos `test-results/interface/*.png` e `test-results/nome/*.png` por `node tools/fotos-interface.mjs`). Correções de 2026-10-19 (ramo `area/interface`, roteiro `node tools/check-interface.mjs`): aviso de nós impossíveis na barra ✅ (B40); abas do construtor com ponto de encaixe `Hud.registerBuilderTab` ✅, o conteúdo é da sessão de prédios (🟡 até lá); bloco "IMPOSSÍVEL DE CONSTRUIR" no inspetor de nó 🟡 (`ui/inspector.ts`, outra sessão).
- Dock de baixo com 7 categorias e teclas: Vias (1), Zonas (Z), Construir (H), Paisagem (T), Transporte (O),
  Demolir (B), Informação (I); gaveta de cada uma com abas e opções; dicas de ferramenta; dicas para toque.
- Barra de cima: céu (dia, noite, ciclo), relógio, dinheiro, aviso de nós impossíveis, contagens, velocidade
  (pausa, 1×, 2×, 4×), Interior, Camadas, Simulação, Câmera, desfazer, refazer, Ajuda, Menu. A contagem dos nós
  impossíveis existe na lógica ✅ (`roads/impossible.ts`) e na barra ✅ (commit do B40: o aviso vermelho com a contagem;
  o clique leva a câmera a cada nó e abre o inspetor; foto `test-results/interface-b/nos-impossiveis.png`, 36 a 38 na
  cidade gerada de 10 km).
- Menu: novo, tela inicial (semente e tamanho do mapa ✅ B43), gerar, abrir, salvar, exportar; Gráficos; Idioma (pt-BR, en);
  Pintura regional; Sobre. Teclas do 4.0 ✅: Ctrl+O, Ctrl+D, Home, Shift+Q/E, F8 (desenvolvedor); a ajuda (F1) é lida da
  tabela de teclas (`ui/keys.ts`).
- Painéis: inspetor de via, de nó e de cruzamento (`ui/roads/*`), catálogo de vias com cartões desenhados, editor de
  seção transversal (Streetmix), painel de conectores de faixa, painel do cruzamento, workspace do construtor
  (`ui/builder/*`), painel de gráficos, saúde (F9, só para desenvolvedor: `?dev`; abas Saúde, Mudanças, Estado), bússola,
  ajuda.
- Visual: `src/ui/v2/shell.css` e `src/ui/app.css` do Roadcraft. Textos nos dois dicionários: 🟡 — a interface e
  `game.ts` ✅ (teste `test/texts.test.ts` reprova frase solta); `src/tools`, `src/world`, `src/roads` ainda escrevem
  em português (as chaves `tools.*`/`refuse.*` já estão nos dicionários; a troca no código é das sessões donas).

## 2. Vias — ✅ quase tudo no motor; conferir contra o catálogo e o editor do Roadcraft
- Traçado reto, curva, livre, quarteirões, rotatória; encaixe 90/45/15° e grade; altura (ponte, viaduto, túnel,
  corte com talude ou muro); recusas com motivo; prévia com trechos (🟡 a prévia **não** mostra o custo: defeito D39).
- Catálogo: 31 modelos em Ruas, Avenidas, Rodovias, Especiais, Trilhos, Meus modelos; editor de seção faixa a
  faixa com validação; materiais da pista (asfalto, concreto, paralelepípedo, bloquete, pedra portuguesa, grama).
- Edições: melhorar (Shift = rua inteira), conta-gotas, mover nó, dividir, unir, inverter, duplicar, zebra e
  semáforo de meio de quadra, retorno no canteiro, vagas por lado, balão de retorno, transição de largura, nome e
  numeração de rua (✅ nome gerado por rua e numeração métrica, par à direita: `roads/streetNames.ts`; o painel
  do prédio mostra "Rua São Bento, 253", foto `desgaste.png`; placa de rua sem texto recebe o nome), placas
  automáticas de velocidade, desgaste do asfalto. Placa = regra ✅: Pare/Dê a preferência posta na calçada junto
  a um braço de cruzamento muda a regra dele (`roads/signRule.ts`). Pintura regional salva com o mapa ✅.
- Cruzamentos: controle (auto, semáforo, placas, pare em todas, preferência, minirrotatória, sem), regra por
  perna, semáforo adaptativo/fixo com fases, defasagem, onda verde, ônibus; movimentos proibidos; conectores
  manuais; altura do nó; automático pelo fluxo com trava.
- Economia das vias ✅ (commit "Economia das vias do Roadcraft", foto `economia.png`): preço por m² de pista,
  canteiro e calçada × modo de construção, devolve 25 % ao demolir, recusa sem saldo, cidade gerada grátis.
- Pintura regional (Brasil, EUA, Europa, Clássica); mobiliário automático (completo, básico, nenhum).
- Postes com fios e luz (nenhum, alternados, todos); muros, cercas, sebes, defensas, gradis; paisagismo de calçada
  (árvore, arbusto, banco, lixeira, hidrante, correio, orelhão, boca de lobo, placas com regra).

## 3. Trânsito — ✅ no motor (micro perto, meso longe)
- IDM + MOBIL; 8 tipos de veículo com medidas reais; luz de freio e setas; ocupantes; sombra de mancha; estacionar
  na guia com manobra ✅, caminhões em docas de galpão com manobra de ré e o trânsito esperando ✅, paradas no
  meio-fio deixando passageiro ✅ (Reeds-Shepp `sim/reedsShepp.ts`, `sim/manoeuvres.ts`: só a 350 m da câmera,
  4 planos por passo; fotos `manobra-doca.png`, `manobra-vaga.png`, `manobra-meio-fio.png`). A doca fica no
  portão do galpão (lote (−w/2 + 10, d/2 − 6)): a sessão de prédios desenha a doca ali.
- Demanda baixa/normal/pico; % de tráfego e pessoas; pausa e velocidades; mapa de congestionamento; métricas;
  seguir veículo; pedestres nas calçadas e saindo das portas; bicicletas.
- Ônibus (pontos, terminais, linhas), trem e metrô (trilhos, estações, linhas). ✅ como o Roadcraft: linha de
  ônibus vai e volta (as paradas da volta do outro lado da rua, as pontas terminais), circular e cor da linha com
  botões no painel de transporte ✅ (só desde o B39; antes não havia botão), ± veículos; passageiros 🟡 (esperam e
  embarcam, mas **não** andam até a parada nem descem a pé: somem e aparecem no cruzamento, defeito C25); trem em
  laço próprio com cancela 🟡 (fecha com o trem a 160 m, mas **só perto da câmera**, defeito C32; o desenho da
  cancela é da sessão de vias). Foto `transporte-cancela.png`.

## 4. Zonas, lotes e crescimento — ✅ no motor
- Zonas R/C/I/misto × densidade; pincel, quadra inteira, tirar; lotes propostos ao longo das vias.
- Lote à mão: retângulo, polígono, curvar lado, mover cantos, dividir (lado a lado, frente e fundos, por linha,
  N partes), juntar, frente, apagar. ✅ na lógica (polígono de até 16 cantos no registro, salvamento versão 7,
  foto `lote-poligono.png`); 🟡 o prédio e a mureta ainda saem pelo retângulo envolvente: a sessão de prédios lê
  `BoxColumns.shapeN/shape` (formato em `jobs/protocol.ts`).
- Crescimento como o Roadcraft ✅ (`world/growth.ts`, foto `crescimento.png`): o próximo lote é o livre mais perto
  do último que cresceu (a rua enche em sequência), no máximo 3 andares acima do vizinho mais alto a 30 m (no
  crescimento ao longo do tempo; a cidade gerada nasce madura), uma praça por bairro de 2×2 células, nomes de
  rua desde a geração (`roads/streetNames.ts`).
- Crescimento: vizinhos diferentes, marcos a ~22 % das torres (`data/lots-roadcraft/*.json`, 38 projetos — ❌
  converter para o gerador), esquina com jardim, portões, estacionamento nos fundos, encosta com split-level,
  garagem, terraços e docas (❌ aqui), paletas brasileiras, desgaste e reforma (✅ na lógica: 5 dias de graça,
  30 dias até cair aos pedaços, Shift+clique reforma, `decay` 0..10 no registro, foto `desgaste.png`; o visual
  do desgaste é da sessão de prédios).

## 5. Construtor de prédios — 🟡 (planta, volumes, telhados, acabamentos, peças de telhado, modelos, ver por dentro)
- Falta do Roadcraft: booleanas (união, subtração, interseção), extrudar/inset/offset/chanfro, primitivas, planta
  livre por cantos, fachada vão a vão (tipos de abertura, alcance, ritmo, relevo), 9 padrões de fachada, bandeiras,
  elementos (escada, rampa, pilar, marquise, toldo, corrimão, árvore, ar-condicionado, vagas), interior
  mobiliado por função com circulação, referência 3D (.glb) e "construir a partir da referência", gizmos, encaixe,
  copiar/colar/duplicar/agrupar, validação com motivos, 43 funções cívicas com mobília própria.

## 6. Paisagem, céu e clima — ✅ no motor
- Relevo (elevar, rebaixar, alisar, nivelar, aplainar, rio, chapada, cânion, escarpa, pão de açúcar, ravinas);
  pintura do chão e 6 biomas; árvores (bosque, uma, cortar, espécies); elementos (pedras, folhas, capim, flores,
  cogumelos) e efeitos (fumaça, fogo, vapor, poeira, fuligem, faíscas, borrifo); água (ondas, espuma, correnteza).
- Céu dia/noite/ciclo; nuvens editáveis; neblina pintada; clima (chuva, vento, raios, trovão); raio no clique.

## 7. Visual (a aparência do Roadcraft) — ❌ a portar para o pipeline do motor
- Prédios: 13 acabamentos com textura (reboco, pastilha, tijolo, pedra, concreto, madeira, metal, vidro, telha,
  manta, estuque, painel, ardósia) num texture array; peças de fachada instanciadas no pool de props (caixilho,
  veneziana, guarda-corpo, varanda, toldo, brise, coluna, ar-condicionado, vaso, varal); interior mapping com luzes
  pelo horário; telhados com equipamentos; bandeiras; sujeira por idade.
- Vias: meio-fio, calçada em painéis, sarjeta, rampas 1:12, piso tátil, pilares e parapeitos de viaduto, portais
  de túnel, muros de corte; placas em atlas; semáforos com lentes; postes e fios.
- Pessoas: corpos MakeHuman cozidos (PCA), roupas, cabelo, chapéu, expressão, objetos na mão, ocupantes sentados;
  LOD por altura na tela; paletas de osso na GPU. Assets em `roadcraft-4.0-main/public/models/{people,citizens}`.
- Veículos: carrocerias por perfil, rodas que rolam e esterçam, portas, faróis, escapamento.
- Mundo: árvores low-poly com cards de folhas, grama em tufos, relevo fino de erosão, paredões de rocha, florestas
  como impostores, jardins; luz PMREM do céu, ACES, GTAO, SMAA/TRAA, CAS, vinheta, bloom à noite; luz do cânion.
- Destruição: explosão em camadas, prédios pré-fraturados, ragdoll (prioridade baixa; o motor tem a versão simples).

## 8. Produto — ✅ no motor
- Mapas antigos e reparo ✅ (`roads/repair.ts`, `mapFile.ts` quarantineSlot; fotos `reparo.png`, `quarentena.png`):
  ponta solta dentro de outra via vira cruzamento ao abrir; mapa ou ladrilho ilegível volta do relevo original e o
  salvamento inteiro é copiado intacto para `saves/quarentena-<data>-<slot>`, nunca apagado.
- Salvar/carregar por ladrilho, autosave, exportar/abrir arquivo, desfazer/refazer, menu inicial com semente e
  tamanho (10/16/20/24 km), opções e presets, idioma, ajuda, saúde (F9), Electron, Steam, empacotamento.

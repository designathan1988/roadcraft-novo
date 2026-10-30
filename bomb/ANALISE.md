# A bomba do Roadcraft 4.0 — registro fotográfico e diagnóstico

Data: 2026-10-30. Pedido do dono: abrir o Roadcraft original **num mapa vazio**, criar um prédio, aplicar a bomba
várias vezes, fotografar do início ao fim, analisar cada foto e fechar o diagnóstico do efeito visual e funcional.

## Como foi feito (entrada conferida)

- Jogo: `lab/roadcraft` (Roadcraft 4.0), servidor de desenvolvimento (`vite`, porta 5300), aberto no Chrome da
  máquina com **perfil próprio** (nunca o save do jogador). Sem cidade gerada: botão **"Começar a construir"**,
  mapa vazio conferido pelo documento do jogo (`doc.buildings` = 0 prédios).
- Prédio 1: catálogo **Construir → "Prédio residencial"**, 6 andares, 18 × 12 m, estuque, colocado com o mouse
  (id 1, em x −43, y 28). Prédio 2: o mesmo modelo, em outro ponto (id 2, x 34, y −48).
- Bomba: **Demolir → Bomba**, clique na fachada; força ajustada pelo `+`/`−` do painel (5, 10, 20, 50).
- Cada bomba: fotos automáticas aos 0,1 / 0,3 / 0,6 / 1 / 1,5 / 2,5 / 4 / 6 / 9 / 12 s depois do clique, na mesma
  câmera. Depois da primeira bomba o jogo ficou lento e cada captura levou ~2 s: o instante real de cada foto está na
  tabela (coluna "t real"); os nomes guardam o instante pedido.
- Fotos convertidas de PNG para JPEG qualidade 92 (mesma imagem; 203 MB → 41 MB). Folhas de contato de cada
  sequência em `folhas/`.
- O código lido para conferir o que as fotos mostram: `roadcraft/src/actionsWiring.ts` (explodeAt, strikeAt,
  breakDeferred), `roadcraft/src/render/destruction.ts` (inteiro), `roadcraft/src/render/buildings/fracture.ts`
  (inteiro), `roadcraft/src/render/blast.ts` (inteiro), `roadcraft/src/render/playEffects.ts:406-560`.

## Foto por foto

### Preparação

| Foto | O que mostra | Análise |
|---|---|---|
| `00-abertura.jpg` | Tela de carregamento do 4.0. | Jogo abrindo pelo servidor de desenvolvimento. |
| `01-tela-inicial.jpg` | Tela inicial com "Começar a construir / Abrir mapa / Opções". | Nenhum mapa carregado ainda. |
| `02-mapa-vazio.jpg` | Gramado vazio, árvores na borda, 0 veículos · 0 pessoas. | Mapa vazio, sem vias nem prédios (conferido no documento: 0 prédios). |
| `03-construir.jpg` | Gaveta "Construir" com o catálogo de modelos. | Escolhido "Prédio residencial". |
| `04-predio-cursor.jpg` | O modelo seguindo o cursor antes do clique. | Pré-visualização do prédio. |
| `05-predio-colocado.jpg` | Prédio de 6 andares colocado; painel do prédio aberto. | 18 × 12 m, estuque, varandas com guarda-corpo, telhado com caixas d'água e equipamentos. |
| `06-predio-perto.jpg` | O prédio intacto, câmera lateral. | Foto de referência "antes". |
| `07-demolir.jpg` | Gaveta "Demolir": Demolir / Pistola / Bomba. | A bomba é uma das três ações. |
| `08-bomba-ferramenta.jpg` | Bomba selecionada; "Força 5"; dica "Clique onde a bomba cai: no chão ou num prédio". | Força padrão 5 (`strikeChoice.strength = 5`). |

### Bomba 1 — força 5, canto superior direito da fachada (folha `folhas/10-b1f5.jpg`)

| Foto | t real | O que mostra | Análise |
|---|---|---|---|
| `10-b1f5-0_1s.jpg` | 0,10 s | O prédio **sumiu da imagem**; no lugar, bola de fogo, fumaça branca, faíscas, anel de choque claro no chão (~25 m), manchas de fuligem já postas. | Nesse quadro o prédio deixa de ser desenhado como prédio e ainda não há ruína: a fratura roda num worker (`destruction.ts make` → `fracture.worker`). O efeito de explosão (flash, anel, fuligem, fumaça) sai na hora (`blast.explode`). |
| `10-b1f5-0_3s.jpg` | 10,1 s | O prédio volta, **já como ruína**: a parte direita da fachada arrancada em placas grandes que voam e giram, fogo dentro, pedaços com varanda inteira. | A ruína substituiu o prédio (`ruined`). As peças na distância de alcance (`1,4 + 0,55 × força` m ≈ 4,2 m) foram soltas com velocidade para fora do ponto de impacto. A captura levou 10 s: o jogo travou ao trocar o prédio pela ruína (custo da fratura e do envio da malha). |
| `10-b1f5-0_6s.jpg` | 10,9 s | Pedaços caindo; um bloco grande (parede com varandas) já no chão à esquerda. | Peças soltas caem com gravidade e giro; o que ficou sem apoio também cai (`unsupported`). |
| `10-b1f5-1s.jpg` .. `-2_5s.jpg` | 11,6–12,9 s | Nuvem de poeira/fumaça branca saindo pela direita; buraco aberto mostrando os andares. | Poeira onde cada peça se solta (`exhaust.burst` em `loosen`) e no impacto. |
| `10-b1f5-4s.jpg` .. `-12s.jpg` | 13,5–15,6 s | O prédio **em pé**, com um rombo de ~3 andares × 3 vãos no canto direito; dentro, salas com móveis; um monte de escombros encostado na base; a fumaça se dissipa; fuligem preta no chão. | **A bomba não derrubou o prédio**: abriu um buraco. Os pedaços assentados ficam no lugar para sempre ("não fazer o entulho sumir", `destruction.ts land`). |
| `11-b1-rombo-perto.jpg` | — | De perto: duas salas abertas em dois andares, com sofás, armários, camas, mesas, vasos; lajes inteiras; borda do rombo **irregular** (dentes, não retangular); varandas pendem; na base, monte de placas de parede (estuque de um lado, cinza do outro), guarda-corpos e móveis. | O interior é mobiliado por função (`interiorFurniture`). Fratura Voronoi (células de 2,8 m) com a espessura da parede em cinza (`WALL` 0,28 m, `BROKEN`). Peças inteiras (varanda, guarda-corpo, móvel) não se partem: vão para um só fragmento. |
| `12-b1-outro-lado.jpg` | — | O lado oposto: fachada intacta, a quina direita recortada em degraus, escombros dos dois lados da base. | O dano é local: só o que estava no alcance se soltou. |
| `13-b1-de-cima.jpg` | — | De cima: telhado inteiro, a quina com um recorte, os andares abertos visíveis pela fresta, fogo laranja dentro. | O telhado só cai se perder o apoio. Fogo continua dentro. |

### Bomba 2 — força 5, parte baixa da fachada esquerda (folha `folhas/21-b2f5.jpg`)

| Foto | t real | O que mostra | Análise |
|---|---|---|---|
| `20-antes-b2.jpg` | — | O prédio depois da bomba 1, já assentado. | Estado de partida. |
| `21-b2f5-0_1s.jpg` | 0,11 s | Igual ao antes; aviso **"Atingido: continue batendo para derrubar"** aparece logo depois. | O prédio já é ruína: o golpe é aplicado na hora (`strike`), sem esperar o worker. |
| `21-b2f5-0_3s.jpg` | 2,6 s | Bola de fogo na fachada esquerda, anel de choque, pedaços saindo. | Mesmo efeito de explosão; a captura atrasou 2,5 s (o jogo ficou pesado desde a primeira ruína). |
| `21-b2f5-0_6s.jpg` .. `-12s.jpg` | 4,7–20,5 s | Novo rombo na metade inferior esquerda, ligado ao primeiro; o monte de escombros na base cresce; fumaça cinza sobe. | Cada bomba abre mais; o golpe procura a primeira peça em pé na linha de visão (`strike` com `eye`). Ainda em pé: menos de 65 % das peças altas caíram. |

### Bomba 3 — força 10, alto da fachada esquerda (folha `folhas/31-b3f10.jpg`)

| Foto | t real | O que mostra | Análise |
|---|---|---|---|
| `30-forca10.jpg` | — | Força 10 no painel. | Alcance `1,4 + 0,55 × 10` ≈ 6,9 m. |
| `31-b3f10-0_3s.jpg` | 2,8 s | **"Atingido: continue batendo para derrubar"**; anel maior (~45 m); bola de fogo no alto à esquerda; a quina do telhado arrancada voando; pedaços em leque. | Força maior = alcance e empurrão maiores (`power = 2 + 1,1 × força`). |
| `31-b3f10-0_6s.jpg` .. `-2_5s.jpg` | 4,7–11,6 s | Fogo no topo; a frente esquerda inteira se abre; pedaços caem. | O que perdeu apoio cai junto (`unsupported`). |
| `31-b3f10-4s.jpg` .. `-12s.jpg` | 13,6–20,6 s | O prédio **ainda em pé**, com quase toda a frente aberta: dá para ver todos os andares com móveis, lajes, divisórias; **vários focos de fogo** dentro; nuvem de poeira cobrindo o topo; pedaços espalhados até ~30 m. | Prédio "em corte": a estrutura de lajes e paredes do fundo segura o resto. Fogo persiste dentro (incêndio do prédio atingido, `ignite`). |

### Bomba 4 — força 10, lado esquerdo restante (folha `folhas/41-b4f10.jpg`)

| Foto | t real | O que mostra | Análise |
|---|---|---|---|
| `41-b4f10-0_1s.jpg` | 0,12 s | Flash amarelo forte iluminando o chão e o prédio. | A luz do clarão (`flashAt`, ponto de luz) ilumina a cena. Desta vez as capturas saíram no tempo pedido. |
| `41-b4f10-0_3s.jpg` .. `-1_5s.jpg` | 0,5–1,6 s | Fogo e fumaça na esquerda; a parede esquerda some em pedaços. | Mesmo mecanismo. |
| `41-b4f10-2_5s.jpg` .. `-12s.jpg` | 2,5–12 s | Prédio em pé, só a fachada direita e o fundo inteiros; interior inteiro à mostra; fogo em um andar; monte de escombros ao redor da base inteira. | **Quatro bombas e ainda de pé**: o colapso só vem quando sobra pouco das peças acima do térreo. |

### Bomba 5 — força 20, fachada direita (folha `folhas/51-b5f20.jpg`)

| Foto | t real | O que mostra | Análise |
|---|---|---|---|
| `51-b5f20-0_3s.jpg` | 2,6 s | Aviso **"Construção desabou"**; anel enorme (~90 m); fogo em toda a altura do lado direito; o prédio inteiro desmanchando. | Menos de 35 % das peças acima do térreo em pé → **colapso** (`COLLAPSE_BELOW`): todas as peças soltas com empurrão pequeno (caem, não voam), o térreo e o piso ficam. O prédio sai do documento (0 prédios). |
| `51-b5f20-1s.jpg` | 7,1 s | Massa de pedaços caindo, nuvem de poeira e fogo cobrindo metade do prédio, pedaços voando alto (uma placa acima do topo). | Poeira grande do colapso (`exhaust.burst` 60, raio 10 m) e "papéis" esvoaçando (120 partículas finas por 22 s). |
| `51-b5f20-1_5s.jpg` .. `-12s.jpg` | 9,4–20,2 s | O prédio virou um **monte de escombros** baixo, mais largo que a planta; nuvem de poeira branca persistente à direita; pedaços pequenos espalhados. | O monte é feito das próprias peças do prédio (placas de parede, lajes, guarda-corpos, móveis). |
| `52-monte-perto.jpg` | — | De perto: monte de placas de parede (estuque bege de um lado, cinza do outro), lajes, guarda-corpos brancos, escadas, móveis, vasos; pedaços isolados a 10–20 m; fuligem preta no chão; chamas pequenas ao fundo. | Entulho = fragmentos reais do prédio, com as faces e cores originais; nada some. |
| `53-monte-de-cima.jpg` | — | De cima: monte oval cobrindo ~1,5× a planta; pedaços maiores espalhados em volta; manchas de fuligem; partículas claras (papéis) no ar à direita. | O monte se espalha pela queda e pelos empurrões das 5 bombas. |

### Prédio 2 — uma única bomba de força 50 (folha `folhas/61-p2-b1f50.jpg`)

| Foto | t real | O que mostra | Análise |
|---|---|---|---|
| `60-predio2-forca50.jpg` | — | Prédio 2 intacto, força 50; o monte do prédio 1 ao fundo. | Novo prédio, nunca atingido. |
| `61-p2-b1f50-0_1s.jpg` | 0,11 s | Prédio ainda inteiro. | Primeiro golpe: a ruína ainda está sendo feita no worker. |
| `61-p2-b1f50-0_3s.jpg` | 2,7 s | "Atingido: continue batendo para derrubar"; o prédio já é um bloco de pedaços em chamas; anel enorme cortando a tela. | Com força 50 o alcance (~29 m) cobre o prédio inteiro: todas as peças soltam no mesmo golpe → abaixo de 35 % → colapso no mesmo golpe, mesmo com o aviso de "atingido" (o aviso é do primeiro instante). |
| `61-p2-b1f50-0_6s.jpg` .. `-1_5s.jpg` | 4,7–9,1 s | Explosão de pedaços em todas as direções, nuvem branca grande. | `power = 2 + 1,1 × 50` = 57 m/s: os pedaços são arremessados longe. |
| `61-p2-b1f50-2_5s.jpg` .. `-12s.jpg` | 11,4–20 s | Nuvem branca enorme cobrindo o centro; pedaços espalhados num leque de dezenas de metros. | Força alta **pulveriza** o prédio em vez de deixá-lo em pé. |
| `62-p2-assentado.jpg` | — | De cima, depois de assentar: **campo de destroços espalhado** (~80 m), não um monte; fuligem; fumaça baixa. | O resultado depende da força: força baixa = rombos e prédio em pé; força alta = prédio estilhaçado e espalhado. |

### Bomba no chão — força 9 no gramado (folha `folhas/70-chao-f5.jpg`)

Nota: o nome do arquivo diz "f5", mas o painel mostra **Força 9** (os cliques de "−" pararam em 9).

| Foto | t real | O que mostra | Análise |
|---|---|---|---|
| `70-chao-f5-0_3s.jpg` | 2,6 s | Aviso **"Impacto no chão"**; bola de fogo; anel; **placas de terra marrons erguidas** em volta. | `crater`: a borda quebrada (placas inclinadas) e placas do chão levantadas (`still`). Chão "earth" porque não há via. |
| `70-chao-f5-0_6s.jpg` .. `-2_5s.jpg` | 5–11,6 s | O anel passa a uma faixa escura que se expande; fogo e fumaça no centro. | O anel desbota (opacidade 0,55 → 0). |
| `70-chao-f5-4s.jpg` .. `-12s.jpg` | 13,7–20,6 s | **Cratera** marrom com bordas claras e pedrinhas, placas em volta, manchas de fuligem, fumaça cinza subindo. | A cratera e as placas ficam; o fogo no buraco dura `6 + raio × 0,05` s. |

## Diagnóstico global

**Funcional (o que a bomba faz)**

1. Explosão no ponto clicado (no prédio: o primeiro ponto do prédio na linha do mouse; no chão: o terreno).
2. Ao atingir um prédio pela primeira vez, ele é **trocado por uma ruína**: o próprio prédio (casca, janelas,
   varandas, peças, **interior mobiliado** e **lajes de cada andar**) cortado em fragmentos Voronoi de ~2,8 m num
   worker; cada fragmento é sólido (face original + espessura de parede em cinza + lados do corte). Enquanto o worker
   corta, sai só a poeira do impacto.
3. Cada golpe solta os fragmentos dentro de `1,4 + 0,55 × força` m do impacto, empurrados para fora com
   `2 + 1,1 × força` m/s (mais um pouco para cima e giro). O que fica sem caminho de apoio até o chão (grafo de
   vizinhos dos fragmentos) **cai** também.
4. O prédio **continua em pé com rombos** que mostram o interior até que menos de **35 %** dos fragmentos acima do
   térreo estejam em pé: então desaba inteiro ("Construção desabou"), com poeira grande e papéis no ar.
   Com força alta (50) um só golpe solta quase tudo: desaba e espalha os pedaços longe.
5. Todo fragmento que pousa fica **para sempre** como entulho, com as faces originais (o monte é o próprio prédio).
6. Chão: cratera com borda de placas e placas de terra levantadas, fuligem, fogo no buraco.
7. Em volta (já portado em `9f317f6`): anel de choque, clarão com luz, tremor de câmera, fuligem espalhada, fogo e
   fumaça, objetos da rua arremessados, veículos como carcaças queimando, hidrantes jorrando.
8. Avisos: "Atingido: continue batendo para derrubar", "Construção desabou", "Impacto no chão".

**Visual**

- Rombo de borda irregular (Voronoi), lajes e divisórias visíveis, salas com móveis, faces de corte cinza com
  espessura; varandas e guarda-corpos inteiros pendurados ou caídos; fogo dentro do prédio que dura; poeira branca
  densa que paira por mais de 12 s; monte de entulho colorido com as cores do prédio.

**Custo observado no 4.0 (defeito dele, não copiar)**

- O primeiro golpe num prédio travou o jogo ~10 s (foto 0,3 s saiu aos 10,1 s) e depois disso cada captura levou
  ~2 s (o jogo ficou pesado com a ruína: cada fragmento em voo é um `Mesh` próprio com geometria própria, e o 4.0
  fatia a soltura das peças em 4 ms por quadro — "amortizar", proibido aqui).

**O que falta no roadcraft-novo (comparação com `9f317f6`)**

- Hoje um prédio atingido é trocado por painéis-caixa que caem: **errado**. Não há ruína, não há rombo, não há
  interior, não há dano progressivo, não há colapso por perda de apoio, e o entulho é trocado por pedras genéricas.
- A explosão em volta (anel, fuligem, cratera, placas, carcaças, objetos) já está portada.

**Como aplicar no roadcraft-novo (respeitando a arquitetura e a ordem do dono de não espalhar código)**

- Tudo da bomba numa pasta da funcionalidade, com camadas separadas: `src/features/demolition/` (regras: golpe,
  alcance, apoio, colapso, comando com inverso), `src/render/blast/` (desenho: explosão, detritos, marcas, ruína),
  `src/jobs/ruin.ts` (fratura no worker). `game.ts` só liga.
- Ruína em **um único buffer por prédio** (não um objeto por fragmento): cada vértice carrega o índice do fragmento;
  a pose de cada fragmento (posição + rotação) vive numa textura/armazenamento lido pelo vertex shader; o prédio
  original é escondido pelo mesmo corte por tag que a vista interna já usa.
- Física dos fragmentos soltos com o passo do 4.0 em tabelas SoA, limite fixo; fragmento pousado deixa de ser
  simulado e fica na pose final (entulho permanente, custo zero por quadro).
- Interior: a fonte da ruína inclui as lajes e os móveis por função (o gerador de interior já existe).
- Sem fatiar trabalho por quadros: a fratura é feita inteira no worker; a página só recebe o buffer pronto.

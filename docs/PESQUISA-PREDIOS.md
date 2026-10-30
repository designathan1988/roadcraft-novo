# Pesquisa: os prédios do Roadcraft 4.0 numa cidade de 10 a 24 km a 60 fps

Escrito em 2026-10-18. Objetivo: reproduzir **toda** a qualidade visual dos prédios do Roadcraft 4.0 (fotos
`docs/referencia-visual/roadcraft-*.png`) no motor novo, com custo **por pixel ou por célula**, nunca por prédio.
O que matou o Roadcraft está em `docs/LICOES.md` A7-A9, A11, D2 e D4: ~10.800 vértices de casca e 113 peças por
prédio, 0,6 MB de GPU cada, ~43 chamadas por célula, ~7 ms de emissão por prédio na thread principal, registro de
7-9,5 KB guardado duas vezes como texto.

Convenções deste documento:
- "RC4" = Roadcraft 4.0 (`C:\Users\Jonathan\Documents\Projects\lab\roadcraft`, só leitura).
- "Motor" = este repositório, ramo `main` (`989d4b3`) mais o commit não integrado `1e58ca2` do ramo
  `claude/predios-roadcraft-f42ed6` onde dito.
- Todo número sem fonte é **estimativa** e está marcado como tal. Contagens de triângulos de um quad: o
  `MeshBuilder` do motor não compartilha vértices (4 vértices e 2 triângulos por quad, `src/jobs/meshBuilder.ts:74-89`).
- Pixels por metro a 1080p e 45° de abertura vertical (o `pixelScale = 1` do motor, `src/render/cellLayer.ts:88`):
  `px/m = 1080 / (2·d·tan 22,5°) ≈ 1304 / d`. Logo uma peça de `s` metros tem 1 px a `d ≈ 1304·s` m. **Calculado,
  não medido.** Caixilho 5 cm → 65 m; peitoril 16 cm → 210 m; ar-condicionado 0,72 m → 940 m; varanda 1,3 m →
  1,7 km; janela 1,2 m → 1,56 km; prédio de 12 m → 15,6 km.

---

## §1. O que o Roadcraft 4.0 fazia, elemento por elemento, e o que custava

Leitura de `src/render/buildings/*.ts` (26.735 linhas; `buildingMesh.ts` tem 4.105 na versão lida, não 3.686) e
`src/world/buildings/*.ts`. Custo "declarado" é o que o código ou `LICOES.md` dizem; o resto é contado do código.

| Elemento visual | Como o RC4 fazia (arquivo:linha) | Custo que isso tinha |
|---|---|---|
| **Casca (paredes)** | `buildingMesh.ts:1015 emitBuilding` → por baía (`emitBay`, `:1562`): 4 retângulos de parede em volta do vão + 2 ombreiras + peitoril + verga (`:1600-1612`), cada um uma face própria no `Shell`. Vértice: posição 4×u16 na grade da célula (`cellArrays.ts:49-52`), normal octaédrica 2×i16 (`:82,104`), pintura + id de acabamento + desgaste 4×u16 (`:84,102,111`). Uma malha por acabamento por célula (`meshesOf`, `:3864-3900`). | ~10.800 vértices por prédio (`LICOES.md:25`); 8 faces por janela só na parede; uma chamada por acabamento presente na célula (até 13). |
| **Janelas (vidro, caixilho, persiana)** | Peças instanciadas do kit (`kit.ts:64-85 PART_KINDS`: 17 tipos próprios + 10 props de fachada + 3 peças de lote = **30 tipos**, ~27 materiais, `kit.ts:485-534`). Caixilho = 6 caixas unidas (`kit.ts:240-262`), comentário "60 triângulos onde 72 desenhavam o mesmo" (contado: 56); versão longe só com as faces da rua (`frameFarGeometry`, `:290`). Vidro escuro/claro e persiana baixada sorteados por `bayHash` (`buildingMesh.ts:1620-1627`). Pose de instância 8 floats = 32 B (`partPose.ts`), tinta 6 B; vidro leva ainda 4 B de slot de luz + 24 B de sala = **66 B por vidraça**. | 1 instância de `glass` + 1 de `frame` (+ `shutter` + peitoril) **por janela** (~70 tris por janela simples, ~378 com venezianas); um `InstancedMesh` por tipo × banda de erro × run de sub-células (`partCells.ts:1-20`, `partFiling.ts:19`: uma banda só se separa com ≥ 16.384 triângulos, "o trabalho por objeto do three pesa mais que isso de GPU"). |
| **Interior das janelas** | Interior mapping por pixel no material do vidro (`glassRoom.ts:6-70`): sala real do interior do prédio (`roomBehind.ts`, 12 floats por sala, `ROOM_FLOATS`), 3 atributos vec4 por instância (`roomA/B/C`), móveis sólidos vistos como caixas (`roomBehind.ts:15-24`), piso por função. Luz por horário: tabela ATUS de pessoas acordadas por hora (`kit.ts:40-53`), 43 % das luzes externas a noite toda (`:96`). | Por pixel de vidro: 3 interseções + móveis; por instância: 48 B de sala + cálculo em `roomBehind.ts` por pane na emissão (CPU). |
| **Varandas** | `emitBay` caso `balcony` (`buildingMesh.ts:1634-1639`): vidro + caixilho + laje de concreto (peça) + guarda-corpo (peça). Guarda-corpo = 4 caixas + 11 balaústres + 6 laterais = 21 caixas (`kit.ts:265-280`). | 252 tris por guarda-corpo (21 × 12) **a qualquer distância ≥ 1 px**; versão longe de quads dupla-face (`:302-318`). |
| **Portas, toldos, marquises** | `emitBay` caso `door` (`:1640-1651`): folha com 6 caixas (`kit.ts:338-350`, 72 tris) + marquise de 2 peças de concreto + 2 mãos-francesas + lanterna com `wash` de luz (`emitPorchLight`, `buildingMesh.ts:981`). Toldo: lona + sanefa (`kit.ts:401-412`). | 4-6 peças por porta; lanterna e wash com shader próprio (`kit.ts:103-121`). |
| **Brises, venezianas, pilastras, cornijas, frisos** | Brise: 6 lâminas = 6 caixas (`kit.ts:383-391`, 72 tris) por baía; veneziana: 5 caixas + 9 lâminas (`:353-374`, ~168 tris); cornija e bandas no shell (`emitCornice :3158`, `band :3104`); arcada com coluna (`:1581-1590`). | Peças de 72-168 tris por baía; a casca ganha faces por banda. |
| **Telhados** | `emitRoof` (`:3415-3615`): laje, platibanda com rufo proud dos dois lados (`:3453-3465`), terraço com guarda-corpo por baía, telhados de 2/4 águas, shed, sawtooth, polígono (`emitPolygonRoof :3308`). | Platibanda em pedaços do tamanho da baía (`:3448-3451`): dezenas de faces por telhado. |
| **Equipamentos de telhado** | `roofPlant.ts` escolhe e empacota por prédio (tank, tankBox, hatch, condenser, airHandler, solar, mast, dish, skylight, vent, liftRoom, chimney); `emitRoofPlant` (`buildingMesh.ts:1904-2008`) desenha cilindros e caixas no shell, menos no "far" (`FLAT_DEPTH` 0,3 m, `:1908`). `emitRoofDetails` (`:3169`) os detalhes do construtor (solar, claraboia, respiro, agulha com 8 lados × 3 anéis, chaminé, lanterna). | Cilindros no shell (vértices por prédio); caixa d'água = 1 caixa + 3 cilindros. |
| **Peças de fachada (AC, vaso, varal, antena, cadeira, bicicleta)** | `facadeProps.ts:6-7` (10 tipos), colocadas só acima do térreo e por hash da baía (`:61-161`: AC em 7 % das janelas residenciais, 6 % mistas, 4 % comerciais; antena 5 %; 45 % das varandas vazias, as outras com 1-4 itens, pior caso ~9 instâncias por varanda). Modelos em `facadePropModels.ts`: AC `:49` ≈ 508 v / 316 t (longe 82 v), vaso `:97` ≈ 192 v, varal `:190` 336 v, antena `:219` ≈ 171 v, bicicleta `:297` ≈ 344 v; níveis simplificados por meshoptimizer a erros 0,01/0,025/0,06 m (`kit.ts:181-225`); instância não desenhada sob 1 px (`PartScreen.extent`). | Um AC de 316 triângulos por janela a até ~1 km; `LICOES.md:77-80`: peças pequenas instanciadas uma a uma, um `InstancedMesh` por tipo × banda × trecho: **2,6 ms instanciadas contra 0,6 ms unidas** (medido pelo jogador; o número não está no código do RC4, só nas lições). |
| **Acabamentos (13)** | `materials.ts:6`: plaster, stucco, ceramic, brick, stone, concrete, wood, metal, glass, tile, slate, panel, roofing; o registro só guarda `{finish, colour}` (`materials.ts:9-13`), sem rugosidade/metal/emissivo. Receitas procedurais em `render/bake/finishRecipes.ts:49-347` (256², tijolo e pedra 512²; 1-4,8 m por tile), assadas **em build** (`textureBaker.ts:1-141`: cor + normal por diferença central + rugosidade/metal; `scripts/vite/ktx2.ts` grava KTX2 RGBA8 ou UASTC→BC7 com Zstd), uma texture array por mapa, uma camada por acabamento (`finishes.ts:4`, `bake/catalogue.ts:45-58`, `FINISH_LAYER_SIZE` 512), UV em metros no plano da face (`shellParts.ts:55-69`), tangente sem pré-cálculo (Schüler, `finishes.ts:34-55`); **um** material para todos os acabamentos da casca (`finishes.ts:204-208`). | 3 arrays × 13 × 512² × 4 B = 39 MiB no mip 0, ~52 MiB com mips em RGBA8. Barato por pixel; o problema era o resto. |
| **Sujeira e idade** | `finishes.ts WEATHERING` (`:70-110`): macro-variação por 3 oitavas de ruído 3D **por pixel**, escorridos, grime por `decay` do registro (`types.ts:316`). | `LICOES.md D4`: 40-48 `sin` por pixel; quadro limitado por pixel (22,9 ms a 3 M e a 13 M de triângulos). |
| **Nível "fachada" (L1)** | `facadeLevel.ts:33-143`: fachada analítica no shader da massa: pulso periódico integrado sobre o footprint do pixel (`facadePulse`, sem moiré), `bayHash` idêntico ao da emissão; paredes de andares iguais fundidas numa só face (`massing.ts:359-446`). | Boa ideia, já no motor. Mas o RC4 só tinha **dois** níveis (`LICOES.md:30`). |
| **Longe** | Na versão final o RC4 tinha seis níveis: L0 detalhe, L1 fachada, massas por célula (`massing.ts:204`, vértice de 44 B, `cellArrays.ts:323`), ladrilho de 16 células (corta < 3 m) e placa de 64 (corta < 8 m, `massing.ts:43-45`), e quadtree de caixas instanciadas (`farTiles.ts`, `massBoxes.ts`: 18 números por caixa, agregadas por quadrado de 1/128 do nó, mínimo 4 px, `farLevels.ts:19`: "um milhão de caixas e cinco triângulos por pixel em 16 km"). `frameBudget.ts`: governador de tempo que mudava o detalhe no meio da medição (removido por ordem do jogador). `massCells.ts:105`: "45 células, 981 MB, GPU sem memória" na cidade de 10 km. | Os níveis grossos chegaram tarde e por cima de um L0 impossível (`LICOES.md:30`); a medição de 2026-10-16 (`core/perfBudget.ts:43`): distrito 13 M, rua 5,4 M, mapa 4,9 M de triângulos "no nível de fachada cheio"; `frameBudget.ts:110,114`: "22,9 ms a 2,96 M de triângulos na RTX 3060, o mesmo a 13 M"; "só a pipeline de pixels custa 15-20 ms a 1080p". |
| **Marcos e assinatura** | `towerKit.ts:3-14`: 38 projetos (10 torres paramétricas `TowerLook` + 10 de geometria explícita, 13 cívicos, 5 marcos do kit de fachada); `signature.ts` (1.780 linhas): **60 materiais nomeados + 24 fachadas em CanvasTexture 256² pintadas em runtime** (`:48-183, :195-353`), toda peça `toNonIndexed` (36 v por caixa), uma malha por material por prédio (`:1755-1766`), sem nível distante; `landmarks.ts`: 5 em módulos do `facadeKit.ts`. Os 38 `lots/*.json` têm em média 8.304 B minificados e 52,8 elementos cada (2.008 no total). | Dezenas de draws e materiais por prédio-assinatura, sem LOD; só os parâmetros W, D, térreo, pé-direito e andares vinham do registro. |
| **Lote** | `emitLots` (`:2084-2265`) e `elements.ts`: muros, cercas, portões, pilares, escadas, rampas, estacionamento, piscina com água separada, flores, pedras; `shellParts.ts` (lotBox/lotRail/lotSlab) como peças com acabamento + sujeira + chão. `MAX_ELEMENTS = 128` (`types.ts:366`). | Até 128 elementos por prédio no registro; cada um geometria própria. |
| **Encosta, docas, jardins** | `splitLevel.ts:100 stepToSlope` (meia-ala), `garageUnder` (`:286`), `siteGrading.ts`, `docks.ts` (baías de caminhão, `LORRY_DOCK` 3,2 m). | Lógica boa (reaproveitada no motor); custo era o da emissão. |
| **Bandeiras** | `flags.ts` (14 padrões, 3 cores), `flagLayer.ts`: um draw instanciado para a cidade, `PlaneGeometry(1, 1, 24, 12)` = 325 v / 576 t por bandeira, vento no vertex shader. | Um draw; porém "prédios longe só pela bandeira: ~7 ms por quadro durante 40 s" (`layer.ts:728`). A lanterna do Altino Arantes (`emitLantern`, `:3243`) sozinha ≈ 1.700 v. |
| **Interior mobiliado** | `interior.ts` (914 linhas): 40 tipos de móvel, plantas por função (apartamento, escritório, hospital, escola…), `cutOpen` para ver por dentro. | Mobília emitida como peças por andar cortado; sala por janela calculada na CPU. |
| **Registro** | `types.ts:284-331`: objeto JSON com volumes (cada um com `facadeGeometry` das 4 faces sempre preenchido pelo gerador, `architecture.ts:279-287`), andares, fachada por baía (`Facade.bays` por `"lado:índice"`), até 128 elementos, núcleos, materiais, mobília; serializado como JSON (`serialize.ts:58`); tabela binária por ladrilho com hash-consing (`recordTable.ts`, `intern.ts`: ~39.000 entradas por ladrilho denso, "a página morreu em ~7,5 GB"). | "~7 KB" por prédio (`editor/chunkedSave.ts:23`), cópia de tráfego "~6 KB" (`sim/agents/trafficBuildings.ts:74`); 900 registros = 100-300 ms por ladrilho (`store.ts:244`); 110-150 KB de heap por prédio (`LICOES.md:10`). O próprio `CLAUDE.md:47` do RC4 já pedia "12 números por prédio + gerador versionado" e o real tinha ~22 só na linha de crescimento (`growth/rows.ts`). |
| **Montagem** | Emissão em worker (`cell.worker.ts`) mas ainda ~7 ms por prédio (`LICOES.md:13`); `Shell.face` era "2,5-3 s dos 6 s de prédios da abertura" (`buildingMesh.ts:690`); por célula: uma malha por pedaço de casca (≤ 65.535 v) + um `InstancedMesh` por tipo de peça × banda × run de sub-células (`partCells.ts:278-289`); uploads a "~2,6 ms por MiB de `bufferData`", teto de 4 MiB por quadro (`render/uploads.ts:561-562`); orçamentos de VRAM para 80 mil prédios: cascas L0 300 MB, peças 150, L1 120, L2 60, L3 15, texturas 600 (`core/perfBudget.ts:53-66`). | **~43 chamadas por célula, ~120 materiais** (`LICOES.md:28-29`); "uma célula densa segurava 15 MB de mobília e 9 MB de baías como objetos JS" (`buildingMesh.ts:3629`). |
| **Sombras** | Tudo projetava num mapa único redesenhado por heurística; cache invalidado pela matriz da câmera (`LICOES.md:33, 72-74`). | 19 M dos 42 M de triângulos de uma rua eram sombra. |

O que se vê nas fotos de referência e tem de ser reproduzido (`roadcraft-rua-dia.png`, `-noite.png`,
`-transversal.png`, `-bairro.png`): rejunte de pastilha e tijolo legível a 30-60 m; caixilhos brancos com
peitoril claro; vidro com reflexo e sala atrás; varandas com guarda-corpo de ferro e laje; AC nas fachadas;
telhados cheios (caixas de HVAC listradas, caixas d'água, respiros, claraboias); platibanda com rufo; cornijas;
cortinas de vidro com montantes; à noite, janelas acesas com temperaturas de cor diferentes, umas poucas muito
claras, lojas e letreiros; variedade de cor e altura por quarteirão. A foto do motor (`motor-rua-dia.png`) mostra
caixas lisas de cor chapada com grade de janelas: falta textura, relevo, peças e telhados.

---

## §2. Técnica recomendada por elemento, onde entra, custo esperado, fontes

Ponto de partida do motor (relatório do pipeline, `docs/ARQUITETURA.md`, `src/jobs/buildingGen.ts`,
`src/render/city.ts`, `src/render/props.ts`): registro de 54 B na tabela (+64 B de lote em polígono), gerador
determinístico por `seed ^ style` com `GEN_VERSION = 15`, malha por célula de 256 m em worker com vértice de 24 B
(posição i16×4, normal i8×4 com 2 bytes livres, cor+material u8×4, `fac` u8×4, `fuv` i16×2), **um** material para
L0-L3 e camada de detalhe, fachada analítica no fragment shader com interior mapping, 13 acabamentos em texture
array 256²×13, L0 < 650 m, L1 650-1400 m, L2 (ladrilho) > 1400 m, L3 (placa) > 4200 m, camada de detalhe ≤ 220 m
(`city.ts:114,135`), pool de props com cull em compute e `drawIndirect` por tipo × nível (16 tipos × 3), impostores
octaédricos só de árvores.

### 2.1 Fachadas: o que vira geometria, o que vira textura, o que vira shader

**Regra de decisão** (silhueta e paralaxe, não "parece bonito"): vira geometria o que muda a silhueta do prédio
ou projeta sombra visível a partir da distância em que tem ≥ 2 px (peitoril, verga saliente, varanda, toldo,
marquise, pilastra, brise, cornija, platibanda); vira normal map + paralaxe o que é relevo raso e não muda a
silhueta (rejunte, juntas de concreto, reboco, caixilho visto de frente, persiana). Fonte da regra: normal map não
altera silhueta nem paralaxe (slides de Tarini, 3DVG; polycount); "polígonos reais nos cantos de um painel com
paralaxe preservam a silhueta" (polycount). O demo medido de Fagerlund recomenda POM em paredes planas e geometria
em colunas e reveals de janela.

- **Geometria (L0, camada de detalhe ≤ 220 m)**: já existe (`windowDetail`, `buildingGen.ts:759-807`: peitoril 12
  verts, verga 8, caixilho 48, moldura +24, montante/travessa +12; máx. 116 verts por janela). O commit `1e58ca2`
  move friso de laje, balaústres, marco de porta e barras de portão para esta camada (distrito 2,24 M → 1,87 M
  tris). **Recomendado integrar.** Custo: só células a ≤ 220 m, sem sombra, orçamento 48 MB (`city.ts:135`).
- **Caixilho além de 65 m e persiana sempre**: shader (já é; `city.ts:187-199`). Manter.
- **Rejunte, reboco, juntas**: texture array de acabamentos com normal (já é). O que falta para a foto: densidade
  de texels. A 30 m, 1 m = 43 px; a camada de 256 px cobrindo 1,2 m (tijolo, `buildingFinishes.ts:95`) dá 213
  px/m: suficiente; pastilha a 1 m/256 px também. Reboco a 4 m/256 px = 64 px/m: granulado a 30 m. Correção
  barata: textura de detalhe (segunda amostra da mesma array em escala 1/7, só quando `fwidth` indica < 2 m de
  footprint). Custo: +1 fetch por pixel de parede perto, 0 longe.
- **Paralaxe**: o recuo do vidro já é analítico (22 cm, `city.ts:328-337`), custo de 2 `band`. Para rejunte e
  juntas **não** usar POM: Fagerlund mediu em Iris Xe a 960×540, parede cheia: +0,55 ms a 8 passos, +1,01 ms a 32,
  +2,89 ms a 128; em RTX 4090 a 1080p, 0,07 ms a 32 passos. Numa GPU integrada a 1080p (4× os pixels) a conta
  passa de 2-4 ms só de parede: não cabe no orçamento de 16,7 ms. Normal map + sombra do peitoril pintada
  (já existe, `city.ts:321-327`) dá 90 % da leitura.
- **Trim sheet vs texture array**: a array de camadas por acabamento é a escolha certa aqui porque cada camada
  **repete** (tiling) e o atlas sangra nos mips (webglfundamentals; polycount: "array é o jeito melhor para tiles").
  Trim sheet entra para as **peças** (perfis de cornija, rufo, moldura, guarda-corpo visto de longe): uma faixa
  2048×256 BC7 = 0,7 MB com mips; UV das peças na faixa, uma só amostra. Limite WebGPU: `maxTextureArrayLayers`
  padrão 256, até 2048 pedindo (Chrome 126).
- **Referência**: Cities: Skylines II exige por prédio BaseColor + ControlMask (3 máscaras de cor) + MaskMap +
  Normal + Emissive, 512-4096², e LOD1 < 50 % dos triângulos, LOD2 ≤ 500 triângulos com textura 512-1024
  (wiki oficial do CS2, "Asset Pipeline: Buildings"). SimCity 2013: "um prédio de 16 × 32 m usa até 256
  triângulos", relief mapping para janelas e portas, interior mapping (GDC 2013, via habrador).

### 2.2 Interior das janelas, noite

- **Técnica**: interior mapping (van Dongen 2008; Alan Zucconi; usado em SimCity 2013 e, muito provavelmente, em
  Marvel's Spider-Man). O motor já faz a versão analítica sem textura (`city.ts:224-245`): 3 planos, tons por hash.
  Para chegar à foto do RC4 (móveis como caixas, piso por função) sem CPU: **atlas de salas** 2D (uma textura
  1024² com 16 salas de 256², fundo + chão + teto + parede lateral), 1 fetch extra por pixel de vidro, sala
  escolhida por `hash(coluna, andar, semente)` e função do prédio. Variante com profundidade (Dual Depth Parallax
  Interior Mapping) dá móveis com paralaxe correta "por custo parecido com POM"; não é necessária aqui.
- **Limites conhecidos** (van Dongen): móveis planos, portas onde devia haver janela, salas diferentes em cantos.
  Aceitável: ninguém olha de perto.
- **Luz por horário**: trocar a quota fixa `mix(0.15, 0.62, sty)` (`city.ts:248`) pela tabela ATUS do RC4
  (`kit.ts:40-53`: 17 % acordados às 0 h, 6 % às 2 h, 34 % às 6 h, 95 % às 11 h, 85 % às 21 h) como uniform por
  hora; sala acesa = `hash < acordados(hora)`; 43 % das lojas/entradas a noite toda. Custo: zero (um uniform).
  CS2 faz o equivalente com 25 valores de cor no UV ("always on", "Room 01-23", "always off").
- **Temperatura e intensidade**: já há quente/frio por hash; acrescentar 3 % de janelas a 3× (a janela "muito
  clara" da foto noturna) e cortina acesa por trás (já existe).
- **Bloom**: só à noite (já é, `post.ts`). Dual Kawase (Bjørge 2015): 4-8 amostras por passe, meia resolução;
  custo por pixel de tela, independente da cidade. **Sem luzes pontuais**: a lanterna de porta do RC4 vira um
  "wash" emissivo pintado na parede pelo shader (gradiente radial no `fuv` da porta), 0 draws.

### 2.3 Peças repetidas (AC, guarda-corpo, caixilho, vaso, varal, antena, caixa d'água, chaminé, respiro)

- **Quando instanciar e quando unir** (números do próprio projeto): RC4 mediu 2,6 ms instanciadas contra 0,6 ms
  unidas para caixinhas de 4-24 vértices (`LICOES.md:77-80`). O vkguide descreve a mesma lição: "malhas pequenas
  culladas são fundidas numa malha maior ao desenhar, evitando os pitfalls de desenhar objetos pequenos"; o método
  de Assassin's Creed Unity culla por objeto e por cluster de 64 triângulos e grava um índice único por material.
  Regra para o motor:
  - peça **grande ou com nível próprio** (caixa d'água 2,4 m, HVAC de telhado, antena parabólica, árvore do lote,
    carro estacionado) → pool de props (frustum + distância em compute, `drawIndirect`);
  - peça **pequena e colada na fachada** (caixilho, peitoril, balaústre, friso, pilastra, brise, toldo, cornija,
    AC de parede) → unida na malha da célula (L0) ou da camada de detalhe, **sem** instância;
  - AC de parede (0,72 m, 1 px a 940 m): hoje vai ao pool (`PART.WallAc`); 20-40 por prédio × 150 prédios por
    célula = 3-6 mil instâncias por célula só de AC. É o caso-limite: manter no pool só se o número de instâncias
    visíveis ficar abaixo de ~50 mil (estimativa); senão unir na malha L0 (24 verts cada; 150 prédios × 30 AC × 24
    = 108 k verts por célula, 2,6 MB a 24 B/vértice: **cabe**).
- **Defeito a corrigir primeiro**: os 14 variantes de `Furniture` estão numa **única** geometria não indexada
  (~3.624 vértices) e o vertex shader colapsa o que não é da variante (`propMeshes.ts:299-358`,
  `props.ts:233-236`). Cada vaso, varal ou AC processa 3.624 vértices. Com 5 mil AC visíveis são 18 M de
  vértices processados por quadro para nada. Correção: variante → slot de draw próprio (o campo de tipo tem 5 bits,
  `PROP_FREE = 31`; `DRAWS` cresce de 48 para ~48 + 8×3) ou sub-malha por variante com `firstVertex` no indirect.
- **Clustering por célula**: o pool já aloca blocos de 64 por célula (`props.ts:384-415`). Manter.
- **LOD de peça por tamanho na tela**: a regra que falhou no CS2 (dentes de 6.108 vértices sem LOD; varais de
  25 k; pilha de toras de 100 k só na sombra; guarita de 40 k sem LOD) é não ter cutoff. Aqui: cada tipo tem
  distâncias por nível (`propMeshes.ts`) e some; manter e calibrar pela tabela de 1 px acima (AC some a ≤ 450 m,
  metade do 1 px, porque com TRAA um objeto de 2 px já é ruído).

### 2.4 Telhados

- **Laje, platibanda e rufo**: geometria em L0-L1 (já: `parapet`, 72 verts, `buildingGen.ts:95-114`); em L2/L3,
  cor da laje com a borda **pintada** pelo shader (faixa de 0,4 m na borda do topo via `fwidth` da posição
  local): 0 vértices.
- **Telhas e manta**: texture array (telha 2 m/256 px, relief 5,5; manta 4 m) com normal: já existe. Acrescentar
  **águas e calhas** só como sombra pintada na cumeeira e na beirada (banda escura de 10 cm no shader).
- **Equipamentos**: hoje `roofClutter` (`buildingGen.ts:864-897`) só em prédios ≥ 8 m de lado, respiros como
  props, claraboias/caixa d'água/solar na malha. Para a foto do RC4 (telhados cheios): empacotar por telhado como
  `roofPlant.ts` do RC4 (12 tipos, variante 0..3, `age`), emitir **caixas** na malha L0 (HVAC listrado = caixa +
  textura de ventilação na trim sheet; caixa d'água cilíndrica = prisma de 8 lados, 32 verts) e **só** os cilindros
  grandes (tanque de fibra, chaminé industrial) no pool. Em L1 ficam as caixas > 1,5 m; em L2 nada (um ruído de
  cinza na laje pintado pelo shader sugere equipamentos a > 1,4 km).
- **Variedade barata (CS1/CS2, Anno, Manor Lords)**: CS1 limitava prédios a 1-5 k triângulos (10-15 k excepcionais)
  com textura 1024² e LOD em atlas 4096² compartilhado; a variedade vem de cores por máscara (CS2 ControlMask RGB =
  3 cores variáveis por prédio) e de **skins** (Anno 1800: 12-18 skins por tier de residência, só textura e cor).
  Aqui: paleta por `hash(seed)` já existe (`ARCHES[].walls`, `arch.ts:48-88`); acrescentar 2.ª cor (detalhe/guarnição)
  e variante de laje (`ROOF_FLATS`, 6 cores) já cobre o que o CS2 faz com 3 máscaras. Não achei fonte técnica
  pública sobre Manor Lords; omitido.

### 2.5 Variedade sem custo

- **Shape grammar** (Müller, Wonka et al., SIGGRAPH 2006, CGA shape): massa → fachada → janelas por regras de
  split/repeat, sensíveis ao contexto. O motor já aplica a parte útil: split em colunas e andares **no shader**
  (`fuv`), padrões por regra de baía (bits 4 e 8 em `ARCH_WIN`), 9 padrões × 13 estilos = 117 fachadas
  (`arch.ts:200-210`). Não vale levar CGA inteiro para a malha: cada regra que gera geometria volta a custar por prédio.
- **Seleção do candidato menos parecido com os vizinhos**: `planCells` (`buildingGen.ts:1575-1625`): +1 mesmo
  estilo, +2 mesmo padrão, +0,5 altura parecida num raio de 90 m, ordem fixa por (semente, x), só prédios da
  mesma célula → L0..L3 e props chegam ao mesmo plano. **É a técnica certa e é determinística.** No RC4 ela
  custava "alguns milissegundos por tentativa", 6 tentativas e 4 candidatos gerados inteiros por lote
  (`world/growth/zoning.ts:82,158-162`), porque cada candidato era um corpo completo (`Signature` de
  `procedural.ts:683-705`); aqui o candidato é um byte de padrão e a comparação é aritmética. Estender a cor de
  parede (hoje só por hash): penalizar a mesma cor nos 3 vizinhos da frente.
- **38 projetos de marcos como bits**: `design.ts:68-79` (shape 3 bits, roof 3, finish 3, gear 6, setback 4,
  windows 3, wing 2, catalog 6 = 30 bits em `color`, parede em `h`), 22 % das torres, nunca repetido a < 250 m,
  coloração 2×2 de células (`:1558-1605`). Custo de registro: 0 bytes extras. Os 24 desenhos do `signature.ts` do
  RC4 com texturas de canvas próprias **não** voltam: o catálogo os descreve como volumes + fill + acabamento e o
  shader único os desenha.
- **Townscaper** (Stålberg, IndieCade 2019): grade irregular + regras locais que decoram a partir dos blocos
  colocados, sem instrução do usuário; a lição aplicável é "decoração por regra local" (esquina → jardim lateral,
  lado livre → portão), já em `sideGarden`/`freeSides`. **Introversion (Subversion)**: geração por camadas
  sucessivas, cada uma lendo o espaço entre as anteriores e decidindo "arranha-céu ou casa"; equivale ao
  `pickArch` por era (ruído a 900 m, `arch.ts:155`).

### 2.6 Sujeira, idade e desgaste

- **Hoje**: `decay` (0..10) está no registro e é transferido, mas **nenhum gerador nem shader o lê**. O RC4 lia
  (`finishes.ts WEATHERING`), com 3 oitavas de ruído 3D por pixel (caro, `LICOES.md D4`).
- **Técnica**: (a) **vertex AO** analítico gravado no gerador num dos 2 bytes livres da normal: cânion urbano
  (altura do vizinho / distância), sob varanda, sob cornija, canto côncavo; 1 byte, 0 fetch (Cesium bake de AO;
  VTAO; "cheap and far more performant than a post AO"). (b) **desgaste** no outro byte livre: `decay` do
  registro misturado com `hash(seed)` (prédios "novos" também variam). (c) no shader: ruído **assado** (a
  `WALL_NOISE` 128² já existe, `city.ts:56-79`) lido em 2 escalas → escorridos sob peitoril e AC (já há sob
  janela, `:313-315`), grime na base (0..1,2 m, `GRIME_REACH` do RC4), descascado do reboco (mistura para a
  camada "concreto" onde ruído > 1 − decay), manchas escuras na laje. Custo: +1 fetch e ~15 ALU por pixel de
  parede; nada por prédio. (d) **decals**: não valem aqui (um draw por decal ou um pass de decals em tela): o
  escorrido analítico cobre o caso. Não achei fonte técnica sobre weathering do Horizon; a entrevista da Guerrilla
  descreve "World Data Maps" (umidade, temperatura, distância de rio) consultados por shaders e colocação: a versão
  disso aqui é a **era** por ruído a 900 m e o `decay` por prédio.

### 2.7 HLOD de prédios

- **Níveis** (o motor já tem 4; o RC4 tinha 2):
  - L0 (< 650 m): malha completa menos o que vai para a camada de detalhe (≤ 220 m).
  - L1 (650-1400 m): volumes + telhado + platibanda + sacadas como **faixa pintada** (banda escura/clara no shader
    na altura da laje: a varanda a 1 km tem 1,3 px). Tirar guarda-corpos e peças pequenas (já é, `if (lod>0) return`).
  - L2 (ladrilho, > 1,4 km): "sem platibandas" (já é). Meta: 20-40 tris por prédio (`PESQUISA-CIDADE-GRANDE` §8.3).
  - L3 (placa, > 4,2 km): hoje é L2 quantizado a 6,25 cm. Deve virar **10-12 tris por prédio** (prisma sem topo
    separado, vizinhos de mesma altura fundidos num só prisma por quarteirão quando a diferença de altura < 1 px:
    a 5 km, 1 px = 3,8 m) ou **cartão por ladrilho**: um quad com a foto do ladrilho de cima e de 4 lados (2-4 vistas,
    `PESQUISA-WEB` §1.3). Impostor octaédrico por prédio **não**: paralaxe forte e objetos grandes (§3 de
    `PESQUISA-CIDADE-GRANDE`; yummers.dev: com 8×8 quadros os cards "clipam em ângulos rasantes"). Octaédrico só
    para os ~30 marcos (atlas 8×8 de 128 px, 2 MB).
  - Critério Cesium/3D Tiles: erro geométrico em metros → erro em pixels pela distância; refinar quando erro > 1,5-2
    px com histerese (o `CellLayer` já usa distância × `pixelScale` com histerese 0,85/1,15; trocar por erro em px é
    a mesma conta com nome melhor). Unreal World Partition HLOD: camadas Instancing → Merged → Simplified →
    Approximated, cada uma com a sua distância; Simplygon remesh por célula com "proxy para um tamanho na tela".
  - meshoptimizer para L2/L3 **não** (malhas de caixas quantizadas simplificam mal por seams planas; o README
    avisa que faceted meshes "travam"); gerar L2/L3 direto do registro, como já é.
- **Transição**: pontilhado complementar por 0,35 s (já é, `lodFadeMask`, `cellLayer.ts:46`); igual ao
  `LOD_FADE_CROSSFADE` do Unity HDRP e ao DitheredLODTransition do Unreal. Manter; o custo é zero.
- **Oclusão**: na vista de rua a maior parte dos prédios de trás está oculta. Hi-Z de dois passos em compute
  (profundidade do quadro anterior) é o método (vkguide; VTK WebGPU culler). O caso IfcOpenShell (18 modelos,
  survivors de 140 k → 65 k, FPS igual porque o pré-passe custou o ganho) é o aviso: **só** vale para o pool de
  props e para as células L0 inteiras (teste de caixa da célula contra o Hi-Z), não por prédio.

### 2.8 Sombras

- **O erro a não repetir**: CS2 no lançamento: 4.828 de 6.705 draws (72 %) em sombra, ~40 ms do quadro, 4
  cascatas de 2048², "todo objeto 3D é potencial caster em qualquer qualidade" (Paavo Huhtala). RC4: 19 M dos 42 M
  de triângulos de uma rua eram sombra; cache invalidado pela matriz da câmera (`LICOES.md:33, 72-74`).
- **No motor**: CSM 3 cascatas de 2048, `maxFar 1600` (`post.ts:44-56`); camada de detalhe sem sombra; props só
  no nível 0. Falta:
  1. **casters por tamanho na tela do texel**: uma peça menor que 1 texel da cascata não projeta (RC4 já fazia por
     peça, `kit.ts:140-143 PartScreen.shadow`; Unreal `r.Shadow.RadiusThreshold`); por célula: L1 só na cascata 2-3,
     L2 nunca.
  2. **cache de sombra estática**: a cidade não se mexe. Cascatas 2 e 3 só se redesenham quando o sol anda > 0,25°
     (≈ 1 min de jogo a 1×) ou uma célula dentro delas muda (Crytek "cached shadow maps"; UE Virtual Shadow Maps
     reutilizam páginas entre quadros; Bittner et al. relatam 3-10× com mapas estaticamente focados). Com relógio
     parado (modo de medição) as cascatas longe custam 0.
  3. **cascatas estáveis**: splits fixos e snap ao texel (MS "Cascaded Shadow Maps"; Crytek) para o cache não
     tremer.
  Custo esperado: a passagem de sombra cai para ~1/3 (estimativa; medir pela sonda: triângulos por passe).

### 2.9 Memória

- **Vértice**: 24 B hoje. Possível 20 B: `fac` (4 B) cabe nos 2 bytes livres da normal + `position.w` (tag, 2 B)
  → 20 B; ou `fuv` em u8×2 com escala por célula (u ≤ 255 colunas, h ≤ 255 m a 1 m… **não**, h precisa de 1,5 cm).
  Ganho de 17 %: fazer só se a VRAM apertar (hoje `cityMB` 61-87 MB nas 5 vistas, orçamento 256 MB). A literatura
  confirma 16 B como piso prático com posição 3×i16 + oct normal (Khronos; Android vertex guide; meshoptimizer).
- **Texturas**: acabamentos 2 arrays × 256² × 13 × 4 B × 1,33 = 9,1 MB RGBA8; a 512² = 36 MB RGBA8 ou 9 MB em
  BC7 (1 B/px). Para comparar: o RC4 gastava ~52 MiB (3 arrays × 13 × 512² com mips) e **tinha** o caminho KTX2
  UASTC→BC7 em `scripts/vite/ktx2.ts`; a ideia vale, o caminho não (o motor assa em worker). Atlas de salas 1024² = 5,6 MB RGBA8 / 1,4 MB BC7. Trim sheet 2048×256 = 2,8 MB / 0,7 MB BC7.
  Impostores de marcos 2048×2048 × 2 (cor, normal) = 33 MB RGBA8: **caro**, usar 1024² (8 MB) ou BC7 após baixar
  da GPU (não trivial em WebGPU: assar offline e carregar KTX2). `texture-compression-bc` está em 99,99 % dos
  relatórios Windows do web3dsurvey (86 % geral); ASTC/ETC2 ≈ 0 % no Windows: no desktop, BC7 via KTX2 (Basis UASTC
  transcodifica para BC7 em NVIDIA/AMD; um normal map 2048² RGBA8 de 21,3 MB cai para 5,3 MB). Texturas assadas em
  worker (as atuais) ficam RGBA8: só vale KTX2 para texturas de arquivo.
- **Orçamento por célula** (RTX 3060 12 GB; integrada compartilha RAM, `maxBufferSize` padrão 256 MB,
  `maxStorageBufferBindingSize` Intel 1 GiB em 100 % dos relatórios): L0 ≤ 3 MB por célula (125 k vértices ×
  24 B), detalhe ≤ 1 MB, pool de props 16 + 4 MB fixos + 25 MB de listas visíveis (hoje). Com 36 células L0 (raio
  650 m) são 108 MB + 36 MB: dentro dos 256 + 48 MB. GPU integrada: `pixelScale` menor já reduz raios; prever
  perfil "integrada" com L0 a 400 m, detalhe 120 m, cascata 1 só.

### 2.10 Produção em worker

- **Determinismo**: `hash2(seed, const)` por decisão lateral e `Rng` por prédio; plano por célula em ordem fixa
  (`planCells`). Correto e igual ao que a literatura recomenda ("seeding é hashing, não aritmética": derivar
  sub-sementes por hash, não por soma; hash por chunk em vez de PRNG sequencial para gerar qualquer célula sem as
  outras). `GEN_VERSION` versiona a malha derivada; o save guarda só registros.
- **Tempo por célula**: o gerador roda **4 vezes** por célula perto (L0, L1, −1 detalhe, −2 peças) mais ladrilho e
  placa. Mudar para **uma passada com 3 sinks** (L0, detalhe, peças) e L1 derivado do mesmo percurso com a flag:
  corta ~60 % do trabalho de worker na chegada de um bairro (estimativa; medir com `performance.now()` por job,
  escrevendo no `game.stats()`). O RC4 estourava porque emitia ~7 ms por prédio **na página**; aqui a página só
  sobe buffers, então o risco é só latência de chegada (buraco coberto pelo nível mais grosso pronto).
- **Critério**: uma célula L0 de 150 prédios em ≤ 8 ms de worker (estimativa de meta; RTX 3060 + Ryzen de
  referência). Se passar, o culpado é geometria por prédio, não o worker.
- **Upload**: o RC4 mediu "~2,6 ms por MiB de `bufferData`" em WebGL e limitou a 4 MiB por quadro
  (`render/uploads.ts:561-562`). Em WebGPU o `writeBuffer` é outro caminho, mas o teto por quadro continua
  valendo: uma célula L0 de 3 MB não pode subir no mesmo quadro que outras três. O `CellLayer` já solta a cópia da
  CPU dois quadros depois; falta medir o custo de subida por MiB na sonda (contagem de bytes por quadro).

---

## §3. Orçamento proposto por vista (só prédios) e comparação com a linha de base

Linha de base `tools/budget.json` (commit `f8099a1`, antes dos itens 1-3 dos prédios; `cityMB` = só a `CellLayer`
dos prédios, sem detalhe nem props), limites do `tools/budget.mjs` (rua/noite: draws +150, tris ×2; distrito: +100,
×2; cidade/mapa: +0, ×1,2) e o estado depois do item 3 (`docs/ESTADO.md:34`) e do commit `1e58ca2`:

| Vista | Base draws / tris / cityMB | Limite do budget | Depois item 3 | `1e58ca2` | **Proposta (prédios)** |
|---|---|---|---|---|---|
| rua (90 m, 11 h) | 459 / 2,93 M / 68 | 609 / 5,87 M | 461 / 3,35 M | 3,16 M | ≤ 120 draws de prédios (36 células L0 + 12 detalhe + 10 L1 + ladrilhos + 48 slots de props) · ≤ 2,2 M tris de prédios · ≤ 110 MB (L0 90 + detalhe 20) |
| bairro (420 m) | 186 / 1,26 M / 69 | 286 / 2,52 M | 186 / 2,23 M | 1,87 M | ≤ 100 draws · ≤ 1,6 M tris · ≤ 110 MB |
| cidade (2,2 km) | 548 / 3,39 M / 77 | 548 / 4,06 M | 548 / 3,96 M | 3,67 M | ≤ 150 draws (ladrilhos L2 ≈ 100 + placas) · ≤ 2,0 M tris (L2 a 30 tris × 37,5 k prédios = 1,1 M; L0/L1 perto 0,9 M) · ≤ 120 MB |
| mapa (11 km) | 956 / 5,90 M / 61 | 956 / 7,08 M | — | 6,44 M | ≤ 100 draws de prédios (25 placas a 10 km + ladrilhos perto) · ≤ 0,6 M tris (L3 a 12 tris × 37,5 k = 0,45 M) · ≤ 60 MB |
| noite (rua, 21 h) | 476 / 3,14 M / 87 | 626 / 6,27 M | 478 | 533 draws | igual à rua + bloom (custo por pixel) |

Observações numéricas:
- O item 3 quase dobrou o distrito (1,26 → 2,23 M, limite 2,52 M) e o `1e58ca2` devolve 0,36 M. O que o distrito
  vê a 420 m é L0: cada peça fina que entra em L0 custa aqui. **Tudo que tem < 2 px a 420 m (peças < 0,65 m) tem de
  estar na camada de detalhe ou no shader**, não em L0.
- Na vista cidade, 548 draws com 0 de folga: o teto de ~270 malhas de célula (`ARQUITETURA.md:73`, three sem
  multi-draw-indirect) é estrutural; prédios não podem acrescentar draws nessa vista além dos 48 slots de props.
- O mapa a 11 km tem 5,9 M tris com os prédios em L3 "igual a L2": a meta de 12 tris por prédio corta ~1,5 M
  (estimativa: 37,5 k prédios × (50 − 12) tris).
- Comparado com `PESQUISA-CIDADE-GRANDE` §8.6 (rua ≤ 10 M tris e ≤ 700+300 draws; mapa ≤ 4 M, ≤ 300+100): os tetos
  reais do `budget.mjs` são mais apertados em draws (548 na cidade) e mais folgados em triângulos; este documento
  segue o `budget.mjs`, que é o que a integração roda.
- Por pixel (não entra no budget, medir pela sonda e pelo tempo de GPU com a máquina livre): parede perto = 2
  fetches de acabamento + 1 de detalhe + 1 de ruído + 1 de sala (vidro) + interior analítico ≈ 5 fetches; alvo ≤ 2,5
  ms de GPU para o passe opaco dos prédios a 1080p na RTX 3060 (estimativa de meta).

---

## §4. Plano de implementação, em ordem de imagem por custo

Cada passo: o que muda, onde, critério de aceite em **foto** (4 vistas de `node tools/fotos.mjs` + a foto nomeada)
e em **contagem** (`game.stats()` e `npm run budget`; triângulos de sombra pela sonda quando houver).

1. **Integrar `1e58ca2`** (relevos finos só na camada de detalhe). Aceite: distrito ≤ 1,9 M tris; foto
   `02-bairro.png` sem perda visível de friso a 420 m (ele tem < 1 px lá).
2. **Peças do pool por variante** (`propMeshes.ts:299-358`, `props.ts`): uma geometria e um slot de draw por
   variante de `Furniture`/peça de fachada; vértices processados por instância caem de ~3.624 para 24-200. Aceite:
   `game.stats()` com "vértices do pool por quadro" (novo campo) ≤ 1/10 do atual na rua; draws +24 no máximo.
3. **Densidade de textura e detalhe** (`buildingFinishes.ts`, `city.ts`): camadas a 512² (36 MB RGBA8) e segunda
   amostra de detalhe a 1/7 só com footprint < 2 m. Aceite: foto `05-predios.png` a 40 m com rejunte de pastilha e
   tijolo legível como em `roadcraft-rua-dia.png`; cityMB +27 no máximo; draws e tris iguais.
4. **Vertex AO + desgaste nos 2 bytes livres da normal** (`meshBuilder.ts:55-71,116-147`, gerador, shader):
   cânion, sob varanda/cornija, base suja, escorridos sob AC e peitoril, reboco descascado por `decay`. Aceite: foto
   `09-desgaste.png` com 3 prédios do mesmo tipo em `decay` 0, 5 e 10 distinguíveis a 60 m; `desgaste.png` da
   frente de funcionalidades passa a mostrar o visual; contagens iguais (só shader e 2 bytes já alocados).
5. **Telhados cheios** (`roofClutter` → empacotador por telhado como `roofPlant.ts` do RC4): HVAC em caixa com
   trim sheet, caixa d'água octogonal, respiros, claraboias, platibanda com rufo em L0-L1, borda pintada em L2/L3.
   Aceite: foto `10-telhados.png` de cima a 120 m parecida com `roadcraft-rua-dia.png` (canto superior esquerdo);
   distrito ≤ 2,0 M tris; mapa −1 M tris (L3 a 12 tris/prédio entra aqui).
6. **Janelas: atlas de salas + luz por hora (ATUS) + janelas muito claras** (`city.ts:224-252`). Aceite: foto
   `06-predios-noite.png` com salas de fundo/chão distintos e mistura quente/fria como `roadcraft-rua-noite.png`;
   às 2 h ≤ 10 % acesas, às 21 h ≈ 50 % (contar pixels emissivos na foto); +1 fetch por pixel de vidro, 0 draws.
7. **Varandas e guarda-corpos**: laje + guarda-corpo unidos em L0 (já), balaústres na camada de detalhe (passo 1),
   faixa pintada em L1; toldos e marquises com sombra pintada embaixo. Aceite: foto `11-varandas.png` a 50 m igual
   à foto transversal do RC4; distrito sem aumento.
8. **Sombras: casters por texel e cache das cascatas 2-3** (`post.ts`, `cellLayer.ts` com flag de "mudou"). Aceite:
   sonda em "parado": triângulos do passe de sombra das cascatas 2-3 = 0 entre atualizações; "jogando": passe de
   sombra ≤ 1/3 dos triângulos do passe principal; fotos iguais às anteriores (sombra sem tremor ao girar a câmera).
9. **L3 por quarteirão e cartão de ladrilho** (`buildPlate`, `city.ts:100-112`): prismas fundidos quando a diferença
   de altura < 1 px a 4,2 km; opcional: cartão por ladrilho além de 8 km. Aceite: mapa ≤ 0,6 M tris de prédios; foto
   `03-cidade.png` e `map.png` sem buracos nem mudança de cor média.
10. **Gerador em uma passada com 3 sinks** (`buildBuildings`): tempo de worker por célula no `game.stats()`.
    Aceite: tempo médio de job `buildingMesh` L0 cai ≥ 40 %; malhas idênticas (hash dos buffers antes/depois).
11. **Impostores octaédricos só dos marcos** (atlas 1024², 8×8) acima de 2 km; **Hi-Z por célula** para o pool e
    L0 na vista de rua. Aceite: contagem de instâncias de props visíveis na rua cai ≥ 30 % (compute escreve o
    contador); tempo do pré-passe < ganho (se não, descartar, como no caso IfcOpenShell).
12. **Memória**: KTX2/BC7 para trim sheet, atlas de salas e impostores; perfil "integrada". Aceite: `cityMB +
    texturas de prédio ≤ 150 MB` na rua; jogo abre em Iris Xe sem `device lost` (teste manual, máquina livre).

O construtor (item 4 da frente) e a tradução dos comentários continuam na frente dos prédios; este plano só mexe
em técnica de desenho.

---

## §5. Armadilhas (o que NÃO fazer)

1. **Geometria de arquiteto por prédio.** RC4: ~10.800 vértices de casca, 113 peças, 0,6 MB por prédio
   (`LICOES.md:25`). Cada janela era um buraco de 8 quads na parede mais caixilho de ~56 triângulos, vidro com 66 B
   de instância, peitoril, e guarda-corpo de 252 triângulos, AC de 316, a qualquer distância em que tivesse 1 px.
   Até os orçamentos do RC4 eram de arquiteto: 16 M de triângulos na rua e 700+300 draws (`core/perfBudget.ts:44`),
   e mesmo assim a pipeline de pixels sozinha dava 15-20 ms. Regra: nada com < 2 px na vista de distrito entra em L0.
2. **Instanciar caixinhas.** 2,6 ms instanciadas contra 0,6 ms unidas (`LICOES.md:79`); CS2 com 50 floats por
   instância e buffers de 60 MB. Peça pequena vai unida; o pool é para o grande e repetido. E **nunca** uma
   geometria única para todas as variantes com colapso no vertex shader (defeito atual do `Furniture`).
3. **Um draw por acabamento/tipo por célula.** RC4: ~43 chamadas por célula e ~120 materiais (`LICOES.md:28`). Um
   material, id no vértice, camada na texture array.
4. **Sem LOD ou sem cutoff.** CS2: dentes de 6.108 vértices renderizados 13 vezes com 0 pixels visíveis, varais de
   25-30 k, pilha de toras de 100 k só na sombra, guarita de 40 k sem LOD, ~121 M de vértices de entrada por quadro.
   RC4: só 2 níveis e tudo emitido ao menos uma vez (`LICOES.md:30`).
5. **Sombra de tudo.** CS2: 72 % dos draws e ~40 ms em 4 cascatas de 2048; configuração de resolução "não ligada a
   nada". RC4: 19 M de 42 M tris em sombra; cache invalidado pela câmera. Casters por nível e por texel; cache
   estático.
6. **Custo por pixel ignorado.** RC4: 40-48 `sin` de ruído por pixel, MSAA 8× em HalfFloat, 22,9 ms tanto a 3 M
   quanto a 13 M de triângulos (`LICOES.md:84-87`). POM em paredes numa integrada: +2-4 ms a 1080p (extrapolado de
   Fagerlund). Ruído assado; sem POM; uma amostra a mais só perto.
7. **Registro grande e texto.** 7-9,5 KB por prédio em JSON duas vezes; 110-150 KB de heap (`LICOES.md:10,26`). O
   registro é de 54 B e o que não cabe em bits não entra (os 38 projetos cabem em 30 bits).
8. **Emitir na página.** ~7 ms por prédio na thread principal (`LICOES.md:13`). Tudo em worker; a página sobe buffers.
9. **Governador de qualidade automático.** Mudava a cena no meio de toda medição (`CLAUDE.md` do RC4; `LICOES.md D9`).
   Nunca.
10. **Impostor octaédrico de prédio.** Paralaxe forte, cards clipando em ângulos rasantes com 8×8 quadros; atlas de
    33 MB. Só marcos, só longe.
11. **Simplificar L2/L3 por meshoptimizer a partir do L0.** Seams planas travam o simplificador; gerar do registro.
12. **Medir com a máquina ocupada e anunciar "feito" sem foto.** `LICOES.md B`: 17, 22 ou 37 ms para a mesma cena.
    Toda afirmação deste plano vira contagem (`game.stats()`, sonda) e foto nomeada antes de valer.

---

## §6. Fontes

Código lido (só leitura): RC4 `src/render/buildings/{kit,buildingMesh,glassRoom,roomBehind,facadeProps,
facadePropModels,facadeKit,facadeLevel,finishes,massing,farTiles,farGrid,partCells,shellParts,cellArrays,layer,
landmarks,signature,flagLayer}.ts`, `src/render/mesh/textureBaker.ts`, `src/world/buildings/{types,materials,
procedural,architecture,interior,splitLevel,docks,roofPlant,flags,facadePatterns,towerKit,elements,serialize}.ts`;
Motor `docs/{ARQUITETURA,ESTADO,LICOES,PESQUISA-CIDADE-GRANDE,PESQUISA-WEB-2026-10-18}.md`, `tools/budget.json`,
`tools/budget.mjs`, `src/jobs/{buildingGen,meshBuilder,props,protocol,buildingFinishes}.ts`,
`src/render/{city,cellLayer,props,propMeshes,impostor,inside}.ts`, `src/world/{arch,design}.ts`; fotos
`docs/referencia-visual/*.png`.

Web (acessadas em 2026-10-18):
- Paavo Huhtala, "Why Cities: Skylines 2 performs poorly" — https://blog.paavo.me/cities-skylines-2-performance/
- PC Gamer sobre a análise do CS2 — https://www.pcgamer.com/a-tech-analysis-of-cities-skylines-2-proves-its-rendering-way-too-many-polygons-making-cyberpunk-2077-look-like-minecraft-in-comparison/
- CS2 wiki, "Asset Pipeline: Buildings" (LOD1 < 50 %, LOD2 ≤ 500 tris, janelas/salas por UV, emissivo) — https://cs2.paradoxwikis.com/Asset_Pipeline:_Buildings
- CS2 wiki, "Common Asset Principles" — https://cs2.paradoxwikis.com/Assets:_Common_Asset_Principles
- CS1, limites de triângulos e atlas de LOD (comunidade/Paradox) — https://steamcommunity.com/app/255710/discussions/0/152390648087024418 ; https://admin-forum.paradoxplaza.com/forum/threads/official-tutorial-guide-how-to-turn-a-model-into-game-ready-asset-3ds-max.857689
- Joost van Dongen, "Interior Mapping: rendering real rooms without geometry" — https://www.gamedeveloper.com/programming/interior-mapping-rendering-real-rooms-without-geometry ; blog — http://joostdevblog.blogspot.com/2018/09/interior-mapping-real-rooms-without.html
- Alan Zucconi, "Shader Showcase Saturday #9: Interior Mapping" — https://www.alanzucconi.com/2018/09/10/shader-showcase-9/
- Dual Depth Parallax Interior Mapping — https://answer.cc/dual-depth-parallax-interior-mapping/
- three-fenestra (interior mapping em three.js) — https://github.com/codedgar/three-fenestra
- Automaton, janelas do Spider-Man — https://automaton-media.com/en/news/20231201-23558/
- GDC 2019, "Marvel's Spider-Man: A Technical Postmortem" — https://www.gdcvault.com/play/1026496/-Marvel-s-Spider-Man ; "Procedurally Crafting Manhattan" — https://www.gdcvault.com/play/1025765 ; Houdini — https://vimeo.com/326448655
- SimCity 2013, arte (256 tris por prédio de 16×32 m, interior mapping) — https://blog.habrador.com/2015/03/the-secrets-behind-art-of-city-building_16.html ; relief mapping/deferred — https://www.pcgameshardware.de/Sim-City-Spiel-15619/Specials/Sim-City-5-Technik-Interview-vor-Release-1057030/
- Fagerlund, parallax-mapping-demo (custos medidos de POM) — https://github.com/mfagerlund/parallax-mapping-demo
- Tatarchuk, "Practical Parallax Occlusion Mapping" (SIGGRAPH 2006) — https://advances.realtimerendering.com/s2006/Tatarchuk-POM.pdf
- Tarini, slides de texturas (normal map não muda silhueta) — https://tarini.di.unimi.it/teaching/3DVG2026/10_textures_2.pdf
- Polycount, silhueta vs normal map — https://polycount.com/discussion/comment/2629940/
- Trim sheets (Frozenbyte wiki; craftpbr) — https://wiki.frozenbyte.com/index.php/3D_Asset_Workflow:_Tile_Textures_and_Trimsheets ; https://craftpbr.com/guides/trim-sheets
- Sangramento em atlas vs texture array — https://webgl2fundamentals.org/webgl/lessons/webgl-qna-how-to-prevent-texture-bleeding-with-a-texture-atlas.html ; https://community.khronos.org/t/texture-atlas-and-repeating-textures/52706
- vkguide, "Draw Indirect" (fundir malhas pequenas; AC Unity clusters) — https://vkguide.dev/docs/gpudriven/draw_indirect/
- Krupitskas, "Modern rendering culling techniques" — https://krupitskas.com/posts/modern_culling_techniques/
- VTK WebGPU occlusion culler (Hi-Z de dois passos) — https://www.vtk.org/doc/nightly/html/classvtkWebGPUComputeOcclusionCuller.html
- IfcOpenShell, HiZ no mesmo quadro (ganho anulado pelo pré-passe) — https://dev.glassvision.dedyn.io/Glassvision/IfcOpenShell/src/commit/a34c36d22e8357c126ad5a20a02f5afce5314ced
- Impostores octaédricos em WebGPU (Mancini) — https://github.com/ektogamat/octahedral-impostor-component ; hemi-octaédricos e limites — https://www.yummers.dev/hemi-octahedral-impostors.html ; Godot — https://deepwiki.com/wojtekpil/Godot-Octahedral-Impostors
- meshoptimizer (simplify, seams, LockBorder) — https://github.com/zeux/meshoptimizer ; https://meshoptimizer.org/
- Unreal World Partition HLOD — https://dev.epicgames.com/documentation/en-us/unreal-engine/world-partition---hierarchical-level-of-detail-in-unreal-engine ; Simplygon HLOD/remesh — https://documentation.simplygon.com/SimplygonSDK_10.3.500.0/ue5/concepts/hlod.html ; https://simplygon.com/posts/369cb2bd-7007-4a58-ba7e-8c8c9a58211c
- 3D Tiles (erro geométrico → SSE) — https://github.com/CesiumGS/3d-tiles/blob/main/specification ; cesium-native seleção — https://cesium.com/learn/cesium-native/ref-doc/selection-algorithm-details.html ; issue sobre altura de prédios — https://github.com/CesiumGS/cesium/issues/4043
- Unity, LOD cross-fade por dithering — https://docs.unity3d.com/Manual/lod/lod-transitions-mesh-lod.html ; Unreal EDitherState — https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/FMeshBatch/EDitherState
- Sombras: MS "Cascaded Shadow Maps" — https://learn.microsoft.com/en-us/windows/win32/dxtecharts/cascaded-shadow-maps ; Crytek "Playing with Real-Time Shadows" — https://www.realtimeshadows.com/sites/default/files/Playing%20with%20Real-Time%20Shadows_0.pdf ; Bittner et al., "Shadow Caster Culling" — https://arisilvennoinen.github.io/Publications/Shadow_Caster_Culling_for_Efficient_Shadow_Mapping.pdf ; UE Virtual Shadow Maps — https://dev.epicgames.com/documentation/unreal-engine/virtual-shadow-maps-in-unreal-engine ; UE `r.Shadow.RadiusThreshold` — https://answers.unrealengine.com/questions/701365/view.html
- Bloom dual Kawase (Bjørge 2015) — https://www.mintlify.com/xarblu/kwin-effects-better-blur-dx/development/blur-algorithm ; WGSL de bloom (kiss3d) — https://docs.rs/crate/kiss3d/0.45.1/source/src/builtin/hdr_bloom.wgsl
- Vertex AO: Cesium — https://cesium.com/blog/2016/08/08/ambient-occlusion/ ; VTAO — https://github.com/Helix128/VTAO ; Ben Davies — https://bendavies.org/ambient-occlusion-vertex-baker.html ; Sloan — https://users.cs.utah.edu/~ladislav/sloan13ambient/sloan13ambient.pdf
- Vértice compacto — https://community.khronos.org/t/a-good-compact-vertex-format/69273 ; https://developer.android.com/games/optimize/vertex-data-management ; https://daniilvinn.github.io/2024/05/04/omniforce-vertex-quantization.html
- WebGPU limites — https://www.w3.org/TR/webgpu/ ; Chrome 126 `maxTextureArrayLayers` 2048 — https://developer.chrome.com/blog/new-in-webgpu-126 ; MDN GPUSupportedLimits — https://developer.mozilla.org/en-US/docs/Web/API/GPUSupportedLimits ; webgpufundamentals — https://webgpufundamentals.org/webgpu/lessons/webgpu-limits-and-features.html ; `maxBufferSize` (Chrome 117) — https://developer.chrome.com/blog/new-in-webgpu-117
- web3dsurvey, `texture-compression-bc` no Windows — https://web3dsurvey.com/webgpu/features/texture-compression-bc/platform/Windows ; `maxStorageBufferBindingSize` Intel — https://web3dsurvey.com/webgpu/limits/maxStorageBufferBindingSize/platform/Chromium%20OS
- KTX2/Basis em WebGPU (21,3 → 5,3 MB) — https://github.com/Siroko/kansei/pull/77 ; three.js KTX2 WebGPU — https://threejs.org/examples/webgpu_loader_texture_ktx2.html ; loaders.gl formatos — https://loaders.gl/docs/modules/textures/formats/compressed-textures ; Castaño, "Choosing Texture Formats for WebGPU" — https://www.ludicon.com/castano/blog/2026/01/choosing-texture-formats-for-webgpu-applications/
- Müller, Wonka et al., "Procedural Modeling of Buildings" (SIGGRAPH 2006) — https://course.ccs.neu.edu/cs5150f13/readings/muller_buildings.pdf ; https://history.siggraph.org/?p=113547
- GDC "Building Blocks: Artist Driven Procedural Buildings" — https://gdcvault.com/play/1012655/Building-Blocks-Artist-Driven-Procedural
- Townscaper (Stålberg) — https://www.gamedeveloper.com/game-platforms/how-townscaper-works-a-story-four-games-in-the-making ; https://en.wikipedia.org/wiki/Townscaper
- Introversion / Subversion — https://bldgblog.com/2009/08/procedural-destruction-and-the-algorithmic-fiction-of-the-city/ ; https://www.moddb.com/games/subversion-city-generator/images
- Anno 1800 skins por tier — https://anno1800.fandom.com/wiki/Buildings_skins ; engine — https://anno-union.com/devblog-the-anno-engine/
- Horizon Zero Dawn, "World Data Maps" — https://80.lv/articles/horizon-zero-dawn-interview-with-the-team
- Determinismo por hash — https://lechynte.srht.site/blog/seeding-is-hashing.html ; https://abratabia.com/procedural-generation/seeds-and-determinism.php

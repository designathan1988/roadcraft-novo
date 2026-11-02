# Relatório completo — Roadcraft 5, dia 2026-11-01

Repositório: `C:\Projects\roadcraft-novo` (branch local `port/roadcraft-features-dev`, criado de `main`;
`port/roadcraft-features` está preso ao worktree antigo em `lab/` e não foi tocado).
Estado inicial: nada commitado; a árvore de trabalho era a fonte. Estado final: **16 commits locais**
(`814c4fd`…`294ffb7` + memória), suíte **540/540**, tsc limpo, build ok, `arch:check` ok, `verificar` 145 ok/1
falha pré-existente ("road keys can be changed", de 2026-10-31).

---

## 1. Estado em que os trabalhos começaram

- Budget (medido no dia, antes das correções): street 14,9M/35,0M desenhados (dentro), district 13,0M/26,4M
  (dentro), **city 4,62M > 4,04M e 505 > 449 MB (fora)**, **map 10,97M > 5,28M e 482 > 395 MB (fora)**,
  night 12,3M/35,1M (dentro). Draws: city 175/179.
- A sonda `test-results/lodErrorProbe.ts` media o erro dos níveis distantes contra o L0:
  **L1 0,2–3,5 m, L2 1,5–3,5 m, L3 1,7–3,5 m**, piores nas coroas (y ≈ 36/67 m).
- A auditoria (`reports/optimization-performance-audit-2026-11-01.md`) listava 18 achados; as referências do 4.0:
  FAR_ERROR 1,5 m, FACADE_ERROR/FLAT_DEPTH 0,3 m, TILE_DETAIL **1,4 m**, PLATE_DETAIL 8 m.
- Sessões anteriores deixaram na árvore (não commitado): `visibility.ts` (oclusor por software das células),
  `grassCulling.ts` (cull de grama na GPU), `propMaterial.ts`/`propFallback.ts`/`propsProbe.ts` (extrações),
  camadas de caster em `sun.ts`, limite de workers em `jobs/pool.ts`.

## 2. A causa do erro dos níveis distantes (item 1 do plano) — CORRIGIDA

**Investigação.** Reproduzi a sonda e instrumentei os piores vértices
(`test-results/lodErrorFeature.ts`, `lodErrorShape.ts`): o erro era um **mastro de 8 cm de espessura e 3,5 m de
altura** (`world/roofPlant.ts`, kind `mast`, `h: 3.5`, 70 % dos prédios com ≥ 10 andares) e **escadas de caixa
d'água de 3,1 m** — cor `#2d3033`, exatamente os pontos medidos. O mecanismo: `roofMesh.ts` pulava estruturas
finas no nível distante **por espessura** (`if (far) break`), mas o erro geométrico de uma omissão é a **maior
dimensão** da feição. O 4.0 tem o mesmo defeito no código, porém o comentário dele documenta a intenção certa:
"THE FAR LEVEL LEAVES OUT WHAT IS UNDER ITS ERROR (FLAT_DEPTH, 0.3 m)". Segunda desviação: o `TILE_DETAIL` do R5
valia **3 m** onde o do 4.0 é **1,4 m** (verificado na fonte; o prompt dizia 3 m — a fonte manda).

**Correção (arquivo → mudança):**
- `src/r40/render/buildings/roofMesh.ts` — o nível distante mantém toda estrutura mais alta que FLAT_DEPTH
  (0,3 m) na maior dimensão: mastro (haste+braços), escada da caixa (it.h+0,9), poste do prato (0,7), postes de
  pergolado (2,4), varas de guarda-sol (2,3). Continuam omitidos só os acessórios abaixo de 0,3 m (ralos, tampas,
  ventoinhas, pés de solar).
- `src/r40/render/buildings/massing.ts` — `TILE_DETAIL` 3 → **1,4 m** (o valor do 4.0) e o **mastro entrou no
  plantio da massa** com `w.leaves(it.h)`: desenhado no tile (3,5 > 1,4), omitido no plate (3,5 ≤ 8, dentro do
  drop do próprio nível).

**Resultado medido:** erro do L1 **3,5 m → ≤ 0,31 m**. Fotos `test-results/lod-fix/`: `crown-before-850.png` ×
`crown-after-850.png` (rooflines limpas × agulhas escuras nos mesmos topos), ídem 1000/1150 m, controle L0 em
700 m idêntico.

## 3. SSE — as distâncias derivam do erro de cada nível (item 2) — CORRIGIDA

- **NOVO `src/render/viewError.ts`**: a regra de erro em tela do Cesium
  (`distance = erro × PX_PER_METRE_AT_1080 / limiar`), com os orçamentos em pixels documentados
  (NEAR_PIXELS 2, FINE_PIXELS 0,5 — 4.0 `massCells.ts:23,28`) e `viewScale(câmera, framePx)` lendo a **projeção
  real**: o fov da perspectiva e a altura do frustum da ortográfica (o escalar antigo ignorava ambos — achado F16).
- `src/render/city.ts` — `near`/`detail`/`plate` deixaram de ser literais: derivam de
  `max(FAR_ERROR 1,5; TILE_DETAIL.drop)` a 2 px → **978 m**, de `FLAT_DEPTH 0,3` a 0,5 px → **782 m**, e de
  `PLATE_DETAIL.drop 8` a 2 px → **5216 m**. Mudou um drop em `massing.ts`, muda a chave — nada a sincronizar.
- `src/game.ts` — `updatePixelScale` usa `viewScale` na câmera real e roda **por quadro** (o zoom ortográfico
  muda por quadro; o `lastScale` do layer torna isso grátis quando parado). Estradas/seams mantêm CDLOD.
- Teste: `test/lodLevels.test.ts` — as derivas 978/782/5216, o comportamento em fov 60 e ortográfico, e o
  contrato de skyline dos níveis (abaixo).

## 4. As cinco causas-raiz do GPU a 100 % — todas corrigidas no código

### 4.1 Sombras: movers inteiros ×3 cascatas
- `src/render/post.ts` — `ShadowHooks` (`cascade(cam)`/`main()`); `CachedShadowNode.renderShadow` chama
  `hooks.cascade(cam)` **entre passes**, antes do render da própria cascata, e `hooks.main()` após a última
  (índice 2), restaurando os argumentos da cor.
- `src/render/props.ts` — o compute de cull foi dividido: o **estado da dissolução** roda 1×/quadro; o novo
  `shCount`/`shCull` preenche a lista de casters **com o frustum da própria cascata** (mesma varredura ao sol,
  nível 0, sem estado). `prepareCascade`/`prepareMain` expõem isso.
- `src/render/vehicles.ts` — as listas da cor são **fotografadas** por quadro (`snapshot`); `prepareCascade`
  compacta cada batch para as instâncias que o frustum da cascata varre (raio conservador: 12 m para veículos
  onde o flag do pose se perde — nada visível é cortado por chute) e re-envia; `prepareMain` restaura.
- `src/render/people/crowd.ts` — o mesmo para os 3 LODs (pos/prev/info/anim, raio 0,6 m).
- `src/game.ts` — os hooks ligados em `setShadowHooks`.
- **Medido:** street **16,21M → 15,36M** instâncias/quadro (−843k), district −480k, night −80k.
  Fotos: `shadow-street.png`, `shadow-props.png` (sombras dos condensadores nítidas), `cascade-vehicles.png`.

### 4.2 Nada esconde o que está atrás dos prédios (pools)
- **NOVO `src/render/depthOcclusion.ts`**: pirâmide de profundidade hierárquica **conservadora** — cada célula
  guarda o occlusor **mais distante** (menor reversed-Z) — reduzida da profundidade do quadro **anterior**
  (o esquema padrão, 1 quadro de atraso) e testada no compute do cull dos props: a instância cujo quadrado na
  tela inteiro está atrás do occlusor mais distante de cada célula coberta não desenha. O ponto de teste é puxado
  1 m para a câmera e projetado **pelas mesmas matrizes do quadro** (sem risco de convenção de profundidade);
  a varredura de sombra **não** é gateada — a árvore atrás do prédio continua sombreando a rua.
- Consumo: `post.ts` ganhou `frameEnd(depth)` (o fim do `render`); `game.ts` liga
  `props.occl.build(renderer, depth)`.
- **Medido:** **city draws 191 → 174 (voltou para dentro do limite 179)**; city desenhado −443k; night −868k;
  street ~igual (canyon: pouco escondido); map ~igual (de cima nada se esconde).
  Foto: `occl-street.png` (canyon denso sem um buraco; os blocos de trás aparecem pelos vãos, como devem).

### 4.3 discard quebrando o early-Z
- A **presença** do discard (não o valor) desliga o early-Z — portões `If` não devolvem. A correção certa é a
  **variante sem máscara**: `src/render/cellLayer.ts` ganhou `materials: { masked, plain, plainFor(u) }` e
  `applyFades` troca o material de cada malha (e do twin de sombra, agora rastreado em `FadeData.twin`) por
  estado: inteira → plain (early-Z volta), em fade/corte/buraco → mascarada.
- `src/render/city.ts` — `createBuildingMaterial(moved?, plainMask)`: a variante plain é **o mesmo shader sem os
  discards**; `plainFor`: fade em repouso, corte fechado (`insideCutOpen()`, novo em `inside.ts`) e célula sem
  janela aberta pelo detalhe. `src/render/roads.ts` — **revertido com causa**: o termo de zona do mask faz
  trabalho real (pixels pintados de zona são descartados com a ferramenta desligada, pixel a pixel); a foto
  `cloudmap-city.png` pegou a pintura atravessando em listras — reverti e reverifiquei (`cloudmap-city2.png`).

### 4.4 Sombra de nuvem por pixel
- `src/render/cloudShadow.ts` reescrito: o fator é **assado uma vez por quadro** em 256×256 células do mapa
  inteiro (a mesma fórmula exata — camada de 4 oitavas + laço de 24 nuvens, com os portões `If` de céu limpo por
  célula) e o composite amostra **bilinear** pela posição no mundo: 65k avaliações/quadro em vez de uma por pixel.
  Mecanismo do 4.0 (`cloudShadowStamp.ts`), o plano de chão e o paralaxe aceitos.
- `game.ts` — `frameEnd` também chama `buildCloudMap(renderer, sunDirection)`.

### 4.5 O mar: plano 8× mascarado
- **NOVO `src/render/seaGeometry.ts`**: a malha do mar sobre o mapa, vértice só onde o mar era visível
  (chão sob o nível do mar + 2 m de folga sob a praia; nenhum rio/lago acima — a regra do próprio mask);
  `terrain.ts` perdeu o `maskNode` do mar (sem discard: early-Z) e `depthWrite = false` na água;
  `scene.ts`/`game.ts` — a geometria substitui o plano (frustumCulled = true agora vale) e é reconstruída quando
  a tabela de água edita (`waterWasDirty` checado antes de `uploadDirtyLayers` consumir).
- **E o registro que você fez:** nunca houve mar ao redor do mapa — o anel do plano antigo desenhava com alpha 0
  (o depth fora do mapa é 0) e o cinza que se via é a cor de chão do céu. A malha nova não tem anel.

## 5. Os defeitos que você apontou com foto

- **Grama fora do mapa** (`src/render/terrain.ts` + `src/render/grassCulling.ts`): o tuft cuja coluna cai fora de
  [−MAP_HALF, +MAP_HALF] não nasce — no material (cobre o fallback WebGL 2) e no cull GPU. Foto
  `grass-edge-fixed.png` (antes: `sea-edge2.png`, tufts pendurados no vazio).
- **A câmera saía do mapa** (`src/render/cameraRig.ts`): o alvo era preso aos limites, o **olho não** — com alvo
  na borda e distância, a câmera voava para fora e tudo lia como flutuando no vazio. O olho agora é preso ao mapa
  em `syncCamera` (o alvo fica; a câmera desliza até a borda). Foto `edge-clamped.png`: o quadro é todo mundo.

## 6. O resto do dia

- **Níveis distantes**: além da causa (§2), o mask-free (§4.3) e o SSE (§3) fecham o item 1+2 do plano.
- `electron/main.mjs` — o log da página imprime também a **pilha** do console (usado para achar o crash do boot).
- `src/features/demolition/ruin/ruins.ts` — mantém `hiddenCountU` (incrementa ao esconder, decrementa ao expirar).
- **Sondas/ferramentas em `test-results/`** (não commitadas, por decisão anterior):
  `lodErrorFeature.ts`, `lodErrorShape.ts`, `lodMetricTime.ts` (a investigação da causa),
  `ladder-first.js` + scripts de escada (as fotos antes/depois num boot só), `query-towers.js`,
  `perf-city.js`. ~30 fotos em `test-results/lod-fix/`.

## 7. Teste novo

`test/lodLevels.test.ts` (6 testes): os drops do 4.0 cravados (tile 1,4/plate 8), as derivas do SSE
(978/782/5216 m e a regra `erro × px/m ÷ distância = limiar`), o `viewScale` (fov, zoom ortográfico), o contrato
de **skyline** (`topOf(L0) − topOf(nível) ≤ referência do nível`) sobre 6 prédios reais + varredura de 12, e a
métrica de feitura sintética (o mastro lê a própria altura). **Falhou antes da correção** (L1 3,5 m), passa depois.
Limite honesto registrado: o contrato de skyline não pega omissão enterrada que não seja o topo — isso ficou
coberto pelas fotos/sondas; a métrica exata (min(deslocamento, altura) por componente conexo) provou a correção
mas custa ~60 s por par de malhas e ficou fora da suíte até ter aceleração real (BVH).

## 8. Portões finais

tsc limpo · **suíte 540/540** · build ok · `arch:check` ok (o `terrain.ts` voltou para baixo do teto com o mar
extraído para `seaGeometry.ts`) · `verificar` 145 ok/1 falha pré-existente · budget: street 15,36M/35,0M,
district 13,0M/26,4M, night 12,45M/35,1M (todos dentro), **city 6,66M desenhados com 176 draws (dentro de 179) e
617 > 449 MB; map 10,97M > 5,28M e 482 > 395 MB** — as linhas de city/map carregam o custo da fidelidade do tile
(que agora iguala o 4.0) mais o baseline antigo (gravado com tile mais grosso); a resolução é arquitetura +
regravar o baseline com você, nunca baixar qualidade.

## 9. Falhas, erros e reverts (registro honesto)

1. A primeira variante do mask-free nos **prédios** usou `If` do TSL **fora de Fn** → crash no boot
   ("reading 'If'"; `If` precisa da pilha de um Fn). Corrigido envolvendo `hiddenMask` numa invocação de Fn.
2. A variante sem máscara nas **estradas** mostrou a pintura de zona atravessando (o termo de zona faz trabalho
   real) — revertida; a dos prédios ficou.
3. O mar passou do teto de tamanho do `terrain.ts` — extraído para `seaGeometry.ts`; na cirurgia cortei bloco
   errado por causa do CRLF e restaurei do git antes de refazer por marcadores exatos.
4. As fotos do navegador embutido não existem: o jogo não roda nele (sem COOP/COEP no contexto embutido). Todas
   as fotos são do Electron com a GPU da máquina (`tools/shot.mjs`).
5. Três rodadas de foto falharam antes da certa: `rc.view` não existe (o caminho é `rc.camera.view`), top-level
   `await` é inválido no `executeJavaScript` (scripts são IIFEs), e o `Table.size` (não `count`) quebrou o script
   das torres — as fotos dessas rodadas mostravam o pose padrão do boot e foram descartadas.
6. Um `verificar` reportou falha nova ("furniture from the menu"): meu timeout de 60 s matou o script no meio; o
   run completo voltou com a única falha pré-existente.

## 10. O que continua aberto (com o mecanismo de cada um)

1. **A cópia loja→mapa** nas sombras (3×16 MiB/quadro ≈ 0,1–0,3 ms de blit): a correção real é o mapa de movers
   separado amostrado com `max` no filtro — reescreve o sombreamento de sombra de **todo material** (three
   r186 não expõe gancho). Custo hoje é secundário; a peça abre a próxima sessão.
2. **Oclusão de cor para veículos/pessoas**: exige portar os dois sistemas para o padrão indirect (pool
   compartilhado + computes + indireção no shader — as regras de sim/follow/occupants vão junto). O pool pesado
   (props) já tem a pirâmide.
3. **O mapa de nuvens para dias nublados** está feito; o que restaria nele é só polimento de resolução.
4. **Budget city/map**: as linhas de triângulos/MB seguem acima **pelo custo da fidelidade do tile** (igualar o
   4.0) + o baseline antigo; a resolução é a arquitetura de atribuição por passe (P0 da auditoria) e **regravar o
   baseline com você** — o baseline é seu, não meu, mudar.
5. `?webgl` (preset low) e a sequência de giro da minicidade com oclusão continuam sem rodada dedicada.

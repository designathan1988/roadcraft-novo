# Auditoria de arquitetura do Roadcraft 5 — 2026-10-30

Worktree `lab/roadcraft-novo-port`, branch `port/roadcraft-features`, **commit auditado `fae9836`** (cópia congelada por
`git archive`, porque outra sessão está mexendo no worktree: `src/game.ts` modificado, `src/app/saveFlow.ts` e
`tools/prune-imports.mjs` novos, `CLAUDE.md` apagado, sem commit). Só análise: nenhum código foi alterado.

**Depois de `fae9836`, enquanto esta auditoria corria, a outra sessão empurrou três commits** (lidos pelo título, pelo
`--stat` e, no caso do D1, pelo código):

| Commit | O que fez | Relação com este relatório |
|---|---|---|
| `244847b` | Gravar e abrir saem do `game.ts` para `src/app/saveFlow.ts` | Faz parte do passo M1.3 (destino diferente do proposto: `app/` em vez de `features/save/`). |
| `f24bef7` | Cidade gerada e de teste para `src/app/cityFlows.ts`; uma limpeza única `clearPage()` para nova cidade e mapa aberto | Corrige o defeito D1 (conferido: `game.ts:1635–1647` em `c58034f` chama `demolition.clear()`) e a duplicação U1, **sem o teste que falha antes** (o commit não tem arquivo de teste). |
| `c58034f` | `roads/build.ts` dividido em `src/roads/construction/` (8 arquivos) | Faz parte do passo M4.3. |

Os números, linhas e vereditos abaixo são de `fae9836`. Quem executar o plano confere cada passo contra o código do
momento.

Legenda das fontes de cada afirmação, usada no relatório inteiro:

- **(a)** lido no código. **(a-c)** lido pelo coordenador linha a linha. **(a-l)** lido por um leitor de lote (agente
  que leu o arquivo inteiro) e não reconferido linha a linha pelo coordenador; as afirmações (a-l) que viraram
  veredito diferente de MANTER ou defeito foram reabertas pelo coordenador nas linhas citadas (lista em §1.4).
- **(b)** medido por script (inventário, grafo, alcance, exports mortos, superfície usada pelas ferramentas).
- **(c)** inferência.

## 1. Resumo

### 1.1 Cobertura (b)

| Medida | Número |
|---|---:|
| Arquivos rastreados no commit `fae9836` | 762 |
| Fora do escopo (vendor, regra da tarefa) | 6 |
| **Arquivos no inventário** | **756** |
| **Arquivos auditados neste relatório (com veredito e seção própria)** | **756** |
| … de código, teste, ferramenta, script, electron e configuração, lidos inteiros | 426 |
| … documentos (lidos pelo cabeçalho e propósito, não linha a linha) | 30 |
| … dados, imagens, modelos e assets cozidos (binários ou gerados; veredito pela função) | 299 |
| … gerado e não lido (`package-lock.json`) | 1 |

A prova de cobertura (script que compara a lista do inventário com os arquivos citados no relatório) está no §9.

Fora do escopo, por quê:

| Arquivo | Motivo |
|---|---|
| `src/vendor/LICENSE-earcut`, `src/vendor/LICENSE-polygon-clipping.md`, `src/vendor/earcut.d.ts`, `src/vendor/earcut.js`, `src/vendor/polygonClipping.d.ts`, `src/vendor/polygonClipping.js` | Código de terceiros (regra da tarefa). |
| `node_modules/`, `dist/`, `test-results/` | Não rastreados (junção e saídas geradas). |
| `reports/`, `src/app/saveFlow.ts`, `tools/prune-imports.mjs` | Não existem no commit `fae9836` (trabalho sem commit de outra sessão). |

### 1.2 Totais por veredito (b, sobre os vereditos do coordenador)

| Veredito | Código/teste/config | Outros | Total |
|---|---:|---:|---:|
| MANTER | 182 | 193 | 375 |
| DIVIDIR | 77 | 0 | 77 |
| JUNTAR | 52 | 4 | 56 |
| MOVER | 64 | 124 | 188 |
| RENOMEAR | 26 | 8 | 34 |
| APAGAR | 25 | 1 | 26 |

"MANTER" quer dizer que o arquivo fica onde está com a mesma responsabilidade; muitos MANTER ainda têm defeitos ou
alocações listados na seção do arquivo.

### 1.3 Os 10 maiores problemas, por impacto

1. **`src/game.ts` é o arquivo-deus e as ferramentas dependem das entranhas dele (a-c, b).** 2.090 linhas, 121 KB,
   ≥17 responsabilidades, ~85 campos espalhados pelo arquivo, **8 objetos host** que só repassam getters/setters
   (`game.ts:323–349`, `1025–1087`, `1239–1270`, `1497–1504`, `1818–1846`, `2079–2085`). O estado dos lotes, do pincel e
   da ferramenta mora no `Game` e é usado por `app/lotEditing.ts`, `app/input.ts`, `app/tools.ts`. Pior: **as
   ferramentas e scripts usam 95 membros do `Game` por nome** via `window.__cidade.game` (muitos privados: `rig`,
   `roadTool`, `drag`, `lotStroke`, `autosaveAt`, `busy`…), sem checagem de tipo — conascência de nome atravessando o
   processo. Qualquer extração quebra ferramentas em silêncio, como já aconteceu: `tools/check-interface.mjs:307` lê
   `g.waterCtl`, que não existe mais.
2. **Dois geradores de prédio rodando juntos (a-c).** O caminho de produção é o do 4.0 (`src/r40` via
   `jobs/building40.ts`), mas o gerador genérico antigo continua: na passada de peças, **cada prédio do 4.0 roda também
   o corpo `house/tower/block` antigo com a saída desligada** (`jobs/buildingGen.ts:178–189`), e quatro arquivos de
   teste (`buildingDefects`, `buildingFinishes`, `buildingLook`, `defects`) testam o gerador antigo
   (`buildBuildingsLegacy`, `buildingGen.ts:101–104, 212–215`), não o de produção. Do mesmo par saem duplicatas:
   dois `roofPlant`, dois `lotPlan` (um deles sem nenhum uso no jogo), dois `Rng`, duas bibliotecas de polígono, dois
   tipos `Zone`, duas grades espaciais além do índice único.
3. **`src/r40` (85 arquivos) é cópia do 4.0 e carrega muito código que nunca roda (a-c, b).** DECISIONS registra 77% de
   linhas idênticas ao 4.0. `createBuildingKit` (`r40/render/buildings/kit.ts:485`) **não tem chamador**: todos os
   materiais em GLSL por `onBeforeCompile` do `WebGLRenderer` (kit, `massingMaterial`, `facadeLevel`, `finishes`,
   `glassRoom`, `thinParts`, `depthConvention`, `lightLevels`, `furnitureKit` material) só existem para ele; `wind.ts`,
   `shadowCasters.ts`, `flagLayer.createFlagLayer`, `recordTable.ts`, `aabb.ts` só são importados como tipo (script de
   alcance); `buildingMesh.ts` tem 31 exports mortos (a montagem de malhas na thread principal). No total, **622 nomes
   exportados nunca importados em 140 arquivos** (b).
4. **Trabalho que cresce com o tamanho da cidade, por passo ou por edição (a-c, regra 5/6 do Forbidden).**
   `sim/traffic/regions.ts:50–61` percorre todos os segmentos a cada 4 s; `sim/advisor.ts:52–58` fatia todos os nós do
   mapa, 64 por passo (amortizar); `sim/traffic.ts:1149–1152` visita todo nó semaforizado a cada passo;
   `sim/peds.ts:1198–1214` processa eventos da população inteira; `render/cellLayer.ts` tem um objeto por célula do
   mapa e visita todas as placas a cada quadro com mudança (`:294`); `render/terrain.ts:977–987` visita todas as raízes
   do mapa a cada quadro; `render/transit.ts:125–211` reconstrói todas as paradas da cidade a cada edição perto de uma;
   `render/props.ts:752` envia a textura de estado de todos os semáforos a cada 250 ms; `roads/junction.ts:122–123`
   descarta o cache de bulbos a cada edição em qualquer ponto.
5. **Trabalho pesado na thread principal na carga (a-c).** `render/surfaceBake.ts:151–153` calcula ~1,4 milhão de
   texels de ruído na importação do módulo; `render/city.ts:30–84` e `render/cookedSurfaces.ts:10–45` também enchem
   arrays grandes na importação; `jobs/buildingGen/heights.ts:28–41` (importado pela página em `game.ts:12` e
   `features/demolition/bomb.ts:14`) refaz um prédio 4.0 inteiro na thread principal numa falta de cache.
6. **O portão de verificação prova menos do que diz (a-c).** `scripts/verificacao/*.js` (rodados por
   `tools/verificar.mjs`, portão de "pronto" do CLAUDE.md) têm **27 verificações que devolvem `true` sem medir o
   efeito**; `plantTree` usa `>=` (sempre verdadeiro); "idioma inglês" só confere que a palavra portuguesa "Câmera" está
   na tela. Testes conferem regex no texto da fonte (`render-defects.test.ts:749–753`, `render-terrain.test.ts:148–149`).
   Ferramentas quebradas sem ninguém perceber: `check-interface.mjs:307`, `shadercheck/mats.mjs:37–40`, `shot.sh:7`,
   cinco ferramentas de foto que tiram a foto 01 duas vezes.
7. **Três sistemas de tradução e muito texto do jogador fora deles (a-c).** `shared/i18n/lang/engine.*.ts` (chaves,
   o único que o CLAUDE.md admite), `data/textos-roadcraft/` (segundo sistema completo com `t()` próprio) e
   `shared/i18n/lang/legacy.ts` (traduz **pelo texto português exato** escrito nos chamadores). Textos do jogador em
   português fixo em `features/roads/roadTool.ts`, `features/streetscape/itemTool.ts`, `ui/creator.ts`,
   `roads/build.ts`, `world/transit.ts`, `world/ground.ts`, `world/arch.ts`, `roads/control.ts`, `roads/zones.ts`,
   `roads/streetNames.ts`, `render/propMeshes.ts` ('PARE'). E a **identidade por nome em português**: perfis de via
   achados pelo nome exibido em `jobs/cityGen.ts:302–306`, `roads/build.ts:1509, 1518`, `roads/roadVariant.ts:110–117`,
   `ui/drawers.ts:588, 606` e em ~15 testes.
8. **Comportamento escolhido por texto (a-c).** O som de cada comando é escolhido pelo começo do rótulo português do
   desfazer (`game.ts:502–503`); o estado da página para as ferramentas é `'carregando'/'pronto'/'falhou'`; clima por
   `'chuva'/'tempestade'/'limpo'`; céu por `'dia'/'noite'/'ciclo'`; demanda por `'baixa'/'pico'`; pastas do save por
   prefixo `'anterior-'`/`'quarentena-'` fatiado como texto (`platform/mapFile.ts:198, 210`).
9. **Alocações no caminho quente (a-c).** `sim/traffic/micro.ts:90, 97` copia dois `Set` em arrays novos a cada passo;
   `render/terrain.ts:961` e `render/velocity.ts:20` criam `Matrix4` a cada quadro; `render/props.ts:756, 759`
   closures a cada quadro; `render/people/crowd.ts:344` array por LOD por quadro; `render/cameraRig.ts:251, 254` dois
   objetos por quadro; `render/scene.ts:237` `Vector3` por `setSun`; `shared/contracts/poses.ts:77` um `subarray` por
   registro publicado; `sim/manoeuvres.ts:55–62` objeto e arrays por pose.
10. **Defeitos de comportamento achados no caminho (§7).** Os mais graves: abrir um save não limpa os escombros da
    bomba (`game.ts:1855–1868`); `Peds.clear()` deixa passageiros de ônibus da cidade anterior (`sim/peds.ts:1622–1626`);
    a cidade gerada nunca zoneia indústria pela regra da via expressa (`jobs/cityGen.ts:80, 281–286, 336`); o balcão da
    boate recebe `cx` como y (`r40/world/buildings/interior.ts:506`); o texto do jogador diz que demolir devolve metade
    e o código devolve 25% (`shared/i18n/lang/legacy.ts:22` × `roads/tuning.ts:13`); o detalhe adaptativo baixa a
    qualidade em jogo contra a regra do CLAUDE.md (`game.ts:1195–1207`).

### 1.4 Afirmações de leitores reabertas pelo coordenador

Abri nas linhas citadas, antes de usar: `render/terrain.ts:961`, `render/velocity.ts:20`, `render/traa.ts:1–3` (cópia do
`TRAANode.js` do three, 641 linhas no node_modules), `sim/peds.ts:1620–1627, 380–385`, `sim/traffic.ts:1147–1153`,
`sim/traffic/micro.ts:88–98`, `sim/traffic/regions.ts:45–64`, `sim/advisor.ts:10–14, 52–58`, `ui/drawers.ts:1–5, 94–100`,
`ui/creator.ts:58–66`, `ui/roadCatalog.ts:526`, `roads/tuning.ts:13`, `shared/i18n/lang/legacy.ts:22, 226`,
`roads/profiles.ts:294–299`, `roads/profileWork.ts:99–104`, `world/transit.ts:9` (e o uso de `MODE_NAMES`),
`platform/mapExtra.ts:16, 41`, `test/props.test.ts:26–30`, `test/building40.test.ts:112–116`, `jobs/props.ts:70, 75`,
`render/props.ts:604`, `test/simCity.ts:10–40`, `test/streetNames.test.ts:70–80`, `render/surfaceBake.ts:148–156`,
`render/roads.ts:380–400`, `render/cameraRig.ts:24–29, 322–330`, `jobs/ktxParse.d.ts`, `render/ktx-parse.d.ts`,
`r40/world/buildings/interior.ts:498–510`, `r40/render/buildings/kit.ts:405–596, 679, 689`, `r40/api.ts`, as importações
do `r40` fora do `r40`, `jobs/pool.ts:138–160`, `jobs/cityGen.ts:16, 80, 215, 276–288, 331–336`,
`jobs/buildingGen.ts:98–106, 178–192, 210–220`, os importadores de `buildBuildingsLegacy`,
`scripts/verificacao/1-ferramentas-e-acoes.js:80–92`, `2-vias-cruzamentos-lotes-ceu.js:97–99`,
`3-inspetor-opcoes-detalhes.js:44–47`, `tools/shadercheck/mats.mjs:36–41`, `tools/shot.sh`, `electron/main.mjs:118–128`,
`tools/fotos-carro.mjs:10–28`, `app/input.ts:178–196`, `tools/check-interface.mjs:300–312` e `tools/check-vias.mjs`
inteiro (o leitor do lote 17 declarou 17 de 17 mas não escreveu a seção desse arquivo).

Duas alegações de leitores **não procedem** e foram descartadas: "os terminais de transporte não são gravados"
(`world/transit.ts`) — são gravados por `platform/mapExtra.ts:16, 41`; "os junctions não entram no save"
(`roads/network.ts:389–404`) — entram no meta, lidos em `game.ts:1957`.

### 1.5 Método e fontes

#### 1.5.1 Pesquisa (passo 0)

| Fonte | O que foi usado |
|---|---|
| J. Ousterhout, *A Philosophy of Software Design* — resumos: https://blog.pragmaticengineer.com/a-philosophy-of-software-design-review/ , https://freshman.tech/philosophy-of-software-design-summary | Módulos profundos × rasos; vazamento de informação (o mesmo conhecimento em dois lugares; a correção é juntar num dono); decomposição temporal como causa de vazamento. Critério para "juntar arquivos de uma função" e para os hosts que só repassam. |
| Conascência (Meilir Page-Jones) — https://en.wikipedia.org/wiki/Connascence | Força (nome < tipo < significado < posição < algoritmo) e localidade. Usado para as strings mágicas (conascência de significado entre arquivos), para os layouts binários redeclarados nas ferramentas (conascência de posição) e para as ferramentas que usam membros privados do `Game` por nome. |
| Métricas de pacote de R. C. Martin (Ca, Ce, instabilidade) — https://en.wikipedia.org/wiki/Software_package_metrics | Fan-in e fan-out da tabela do inventário (Ca/Ce por arquivo). |
| LCOM4 (Hitz e Montazeri) — https://aivosto.com/project/help/pm-oo-cohesion.html | Componentes conexos de métodos que compartilham estado = responsabilidades separáveis; usado para contar responsabilidades de `game.ts`, `sim/peds.ts`, `sim/traffic.ts`, `roads/build.ts`. |
| Vertical slice (J. Bogard) — https://jimmybogard.com/vertical-slice-architecture/ ; https://milanjovanovic.tech/blog/vertical-slice-architecture | "Minimizar o acoplamento entre fatias e maximizar dentro da fatia": base do mapa por recurso (§4) e da regra do CLAUDE.md "cada recurso concentrado na pasta da sua categoria". |
| Ferramentas do projeto: `tools/arch-audit.mjs`, `tools/arch-baseline.json`, `tools/quick-check.mjs` (lidos inteiros) | Regras de camada (`allowed`, `arch-audit.mjs:131–147`), portão de tamanho e ciclos; achados sobre a própria ferramenta em §5.5. |

#### 1.5.2 Inventário por script (passo 1)

Script `inventory.mjs` (TypeScript compiler API sobre a cópia congelada): para cada arquivo rastreado, bytes, linhas,
camada, exports, imports estáticos, `export … from`, `import()` dinâmico e `new URL('./x.ts', import.meta.url)` (entradas
de worker); grafo de dependências; ciclos de runtime e de tipo (Tarjan); vazamentos de camada pelas regras
`allowed` do `tools/arch-audit.mjs`, aplicadas também a imports só de tipo; órfãos; exports nunca importados. Script
`reach.mjs`: arquivos alcançáveis a partir de `src/main.ts` (por valor e por tipo). Script `surface.mjs`: membros do
`Game` usados por `tools/**` e `scripts/**`.

#### 1.5.3 Leitura (passo 2)

`src/game.ts` e `tools/check-vias.mjs` lidos pelo coordenador. Os outros 424 arquivos de código foram lidos inteiros
por 19 leitores de lote (cada um com a lista exata de arquivos e um formato fixo de saída: responsabilidades com
faixa de linhas, estado, etiquetas de recurso, achados com arquivo:linha). **Os vereditos são todos do coordenador.**
Cobertura dos lotes conferida por script (uma seção por arquivo da lista).

## 2. Tabela do inventário (b)

756 arquivos. Fan-in = arquivos que importam este (src, test e ferramentas); fan-out = arquivos que este importa. Camada pela pasta (`app(root)` = `src/game.ts` e `src/main.ts`).

| Arquivo | Bytes | Linhas | Camada | Fan-in | Fan-out | Veredito |
|---|---:|---:|---|---:|---:|---|
| `.gitignore` | 58 | 7 | .gitignore | 0 | 0 | MANTER |
| `.npmrc` | 40 | 2 | .npmrc | 0 | 0 | MANTER |
| `bomb/00-abertura.jpg` | 34486 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/01-tela-inicial.jpg` | 242140 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/02-mapa-vazio.jpg` | 429686 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/03-construir.jpg` | 398939 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/04-predio-cursor.jpg` | 401818 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/05-predio-colocado.jpg` | 389148 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/06-predio-perto.jpg` | 458544 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/07-demolir.jpg` | 455532 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/08-bomba-ferramenta.jpg` | 454642 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/10-b1f5-0_1s.jpg` | 429898 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/10-b1f5-0_3s.jpg` | 445049 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/10-b1f5-0_6s.jpg` | 441301 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/10-b1f5-1_5s.jpg` | 437538 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/10-b1f5-12s.jpg` | 436952 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/10-b1f5-1s.jpg` | 439198 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/10-b1f5-2_5s.jpg` | 435915 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/10-b1f5-4s.jpg` | 435480 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/10-b1f5-6s.jpg` | 435155 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/10-b1f5-9s.jpg` | 435932 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/11-b1-rombo-perto.jpg` | 455343 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/12-b1-outro-lado.jpg` | 442657 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/13-b1-de-cima.jpg` | 452910 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/20-antes-b2.jpg` | 445906 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/21-b2f5-0_1s.jpg` | 445813 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/21-b2f5-0_3s.jpg` | 451604 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/21-b2f5-0_6s.jpg` | 446357 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/21-b2f5-1_5s.jpg` | 443652 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/21-b2f5-12s.jpg` | 440677 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/21-b2f5-1s.jpg` | 444834 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/21-b2f5-2_5s.jpg` | 442435 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/21-b2f5-4s.jpg` | 441913 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/21-b2f5-6s.jpg` | 441356 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/21-b2f5-9s.jpg` | 440876 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/30-forca10.jpg` | 441405 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/31-b3f10-0_1s.jpg` | 440485 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/31-b3f10-0_3s.jpg` | 450133 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/31-b3f10-0_6s.jpg` | 443695 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/31-b3f10-1_5s.jpg` | 440834 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/31-b3f10-12s.jpg` | 439107 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/31-b3f10-1s.jpg` | 441654 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/31-b3f10-2_5s.jpg` | 439744 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/31-b3f10-4s.jpg` | 438575 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/31-b3f10-6s.jpg` | 439414 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/31-b3f10-9s.jpg` | 438872 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/41-b4f10-0_1s.jpg` | 469322 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/41-b4f10-0_3s.jpg` | 447963 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/41-b4f10-0_6s.jpg` | 447267 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/41-b4f10-1_5s.jpg` | 446050 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/41-b4f10-12s.jpg` | 447721 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/41-b4f10-1s.jpg` | 446877 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/41-b4f10-2_5s.jpg` | 443250 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/41-b4f10-4s.jpg` | 444861 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/41-b4f10-6s.jpg` | 446041 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/41-b4f10-9s.jpg` | 446134 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/51-b5f20-0_1s.jpg` | 447980 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/51-b5f20-0_3s.jpg` | 439994 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/51-b5f20-0_6s.jpg` | 431456 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/51-b5f20-1_5s.jpg` | 425774 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/51-b5f20-12s.jpg` | 404371 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/51-b5f20-1s.jpg` | 430790 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/51-b5f20-2_5s.jpg` | 418097 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/51-b5f20-4s.jpg` | 409760 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/51-b5f20-6s.jpg` | 405364 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/51-b5f20-9s.jpg` | 403154 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/52-monte-perto.jpg` | 449180 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/53-monte-de-cima.jpg` | 483984 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/60-predio2-forca50.jpg` | 440219 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/61-p2-b1f50-0_1s.jpg` | 439712 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/61-p2-b1f50-0_3s.jpg` | 394646 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/61-p2-b1f50-0_6s.jpg` | 386779 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/61-p2-b1f50-1_5s.jpg` | 374181 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/61-p2-b1f50-12s.jpg` | 344104 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/61-p2-b1f50-1s.jpg` | 384391 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/61-p2-b1f50-2_5s.jpg` | 363273 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/61-p2-b1f50-4s.jpg` | 350748 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/61-p2-b1f50-6s.jpg` | 343936 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/61-p2-b1f50-9s.jpg` | 341259 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/62-p2-assentado.jpg` | 458465 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/70-chao-f5-0_1s.jpg` | 440685 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/70-chao-f5-0_3s.jpg` | 439746 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/70-chao-f5-0_6s.jpg` | 441839 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/70-chao-f5-1_5s.jpg` | 437947 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/70-chao-f5-12s.jpg` | 434305 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/70-chao-f5-1s.jpg` | 438267 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/70-chao-f5-2_5s.jpg` | 437379 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/70-chao-f5-4s.jpg` | 436195 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/70-chao-f5-6s.jpg` | 435441 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/70-chao-f5-9s.jpg` | 435025 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/ANALISE.md` | 16777 | 160 | bomb | 0 | 0 | MOVER |
| `bomb/folhas/10-b1f5.jpg` | 710251 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/folhas/21-b2f5.jpg` | 725099 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/folhas/31-b3f10.jpg` | 728734 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/folhas/41-b4f10.jpg` | 745156 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/folhas/51-b5f20.jpg` | 712791 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/folhas/61-p2-b1f50.jpg` | 640713 | 0 | bomb | 0 | 0 | MOVER |
| `bomb/folhas/70-chao-f5.jpg` | 701669 | 0 | bomb | 0 | 0 | MOVER |
| `CLAUDE.md` | 5140 | 62 | CLAUDE.md | 0 | 0 | MANTER |
| `data/lots-roadcraft/artDeco.json` | 21074 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/balconyMid.json` | 21783 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/bank.json` | 15430 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/beauxArts.json` | 3516 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/beigeClassic.json` | 24528 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/brickFrame.json` | 36159 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/cemetery.json` | 20701 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/church.json` | 18561 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/cityHallBrick.json` | 17141 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/cityHallWhite.json` | 18314 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/cubeBalcony.json` | 20096 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/darkGlass.json` | 20465 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/darkGrid.json` | 25781 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/decoSpire.json` | 23286 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/decoTower.json` | 5423 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/fireStation.json` | 17788 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/forum.json` | 17054 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/glassBalcony.json` | 29253 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/glassOffice.json` | 32109 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/glassSpire.json` | 5573 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/hexTerracotta.json` | 22028 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/hospitalA.json` | 20656 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/hospitalB.json` | 20121 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/loftBrick.json` | 17166 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/modernOffice.json` | 4548 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/octCopper.json` | 19796 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/pack.mjs` | 7025 | 0 | data | 0 | 0 | MOVER |
| `data/lots-roadcraft/pinkCorner.json` | 17095 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/police.json` | 17470 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/residentialTerrace.json` | 5297 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/roundGlass.json` | 27244 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/school.json` | 20316 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/stackedBlocks.json` | 22761 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/stepGarden.json` | 21880 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/triangleDark.json` | 20446 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/twinNavy.json` | 21242 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/twistGreen.json` | 22549 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/waveWhite.json` | 21241 | 0 | data | 0 | 0 | MANTER |
| `data/lots-roadcraft/whiteBalcony.json` | 32895 | 0 | data | 0 | 0 | MANTER |
| `data/textos-roadcraft/en.ts` | 88982 | 0 | data | 1 | 0 | JUNTAR |
| `data/textos-roadcraft/index.ts` | 5438 | 0 | data | 0 | 0 | APAGAR |
| `data/textos-roadcraft/pt-BR.ts` | 92636 | 0 | data | 1 | 0 | JUNTAR |
| `docs/ARQUITETURA.md` | 6792 | 79 | docs | 0 | 0 | JUNTAR |
| `docs/AUDIT-2026-10-30.md` | 6583 | 56 | docs | 0 | 0 | MOVER |
| `docs/AUDIT-PORT.md` | 7904 | 126 | docs | 0 | 0 | MOVER |
| `docs/ESTADO.md` | 21461 | 133 | docs | 0 | 0 | APAGAR |
| `docs/ESTRUTURA.md` | 6665 | 92 | docs | 0 | 0 | JUNTAR |
| `docs/FOLD-EVALUATION-2026-10-30.md` | 3809 | 32 | docs | 0 | 0 | MOVER |
| `docs/historico-defeitos-roadcraft-4.md` | 4584 | 34 | docs | 0 | 0 | MOVER |
| `docs/historico-OTIMIZACAO-roadcraft-2.md` | 42453 | 137 | docs | 0 | 0 | MOVER |
| `docs/historico-PROBLEMAS-roadcraft-1.md` | 221003 | 351 | docs | 0 | 0 | MOVER |
| `docs/historico-PROBLEMAS-roadcraft-2.md` | 23411 | 109 | docs | 0 | 0 | MOVER |
| `docs/LICOES.md` | 10322 | 106 | docs | 0 | 0 | RENOMEAR |
| `docs/OPTIMIZATION.md` | 5013 | 65 | docs | 0 | 0 | MANTER |
| `docs/ORGANIZACAO.md` | 18367 | 254 | docs | 0 | 0 | JUNTAR |
| `docs/PARIDADE-roadcraft-3.md` | 29627 | 240 | docs | 0 | 0 | MOVER |
| `docs/PESQUISA-CIDADE-GRANDE.md` | 64112 | 898 | docs | 0 | 0 | MOVER |
| `docs/PESQUISA-PREDIOS.md` | 55089 | 461 | docs | 0 | 0 | MOVER |
| `docs/PESQUISA-WEB-2026-10-18.md` | 59933 | 264 | docs | 0 | 0 | MOVER |
| `docs/RECURSOS.md` | 11130 | 112 | docs | 0 | 0 | RENOMEAR |
| `docs/referencia-visual/motor-rua-dia.png` | 1524263 | 0 | docs | 0 | 0 | RENOMEAR |
| `docs/referencia-visual/motor-rua-noite.png` | 1297967 | 0 | docs | 0 | 0 | RENOMEAR |
| `docs/referencia-visual/roadcraft-bairro.png` | 4176302 | 0 | docs | 0 | 0 | RENOMEAR |
| `docs/referencia-visual/roadcraft-rua-dia.png` | 3393055 | 0 | docs | 0 | 0 | RENOMEAR |
| `docs/referencia-visual/roadcraft-rua-noite.png` | 2617569 | 0 | docs | 0 | 0 | RENOMEAR |
| `docs/referencia-visual/roadcraft-rua-transversal.png` | 3028337 | 0 | docs | 0 | 0 | RENOMEAR |
| `docs/STATE-OWNERSHIP.md` | 5368 | 67 | docs | 0 | 0 | JUNTAR |
| `docs/VERIFY-PORT.md` | 4874 | 26 | docs | 0 | 0 | MOVER |
| `docs/VISUAL-QA.md` | 4573 | 78 | docs | 0 | 0 | MANTER |
| `electron/files.mjs` | 3896 | 82 | electron | 1 | 0 | MANTER |
| `electron/icon.ico` | 13572 | 0 | electron | 0 | 0 | MANTER |
| `electron/icon.png` | 6357 | 0 | electron | 0 | 0 | MANTER |
| `electron/main.mjs` | 12361 | 213 | electron | 0 | 2 | DIVIDIR |
| `electron/preload.cjs` | 1467 | 24 | electron | 0 | 0 | MANTER |
| `electron/steam.mjs` | 1629 | 44 | electron | 1 | 0 | MANTER |
| `index.html` | 682 | 18 | index.html | 0 | 0 | MANTER |
| `jogar.bat` | 372 | 12 | jogar.bat | 0 | 0 | MANTER |
| `jogar.sh` | 304 | 9 | jogar.sh | 0 | 0 | MANTER |
| `package-lock.json` | 55128 | 1616 | package-lock.json | 0 | 0 | MANTER |
| `package.json` | 1571 | 44 | package.json | 0 | 0 | MANTER |
| `postes/00-mapa-vazio.jpg` | 35721 | 0 | postes | 0 | 0 | MOVER |
| `postes/01-novo-mapa.jpg` | 420199 | 0 | postes | 0 | 0 | MOVER |
| `postes/02-gaveta-vias.jpg` | 399129 | 0 | postes | 0 | 0 | MOVER |
| `postes/03-rua-desenhada.jpg` | 421579 | 0 | postes | 0 | 0 | MOVER |
| `postes/04-rua-perto.jpg` | 420853 | 0 | postes | 0 | 0 | MOVER |
| `postes/05-linha-urbana.jpg` | 408094 | 0 | postes | 0 | 0 | MOVER |
| `postes/06-topo-transformador.jpg` | 469304 | 0 | postes | 0 | 0 | MOVER |
| `postes/07-poste-lampada.jpg` | 488744 | 0 | postes | 0 | 0 | MOVER |
| `postes/08-poste-cruzeta-costas.jpg` | 523248 | 0 | postes | 0 | 0 | MOVER |
| `postes/09-rural.jpg` | 498579 | 0 | postes | 0 | 0 | MOVER |
| `postes/10-de-cima.jpg` | 419401 | 0 | postes | 0 | 0 | MOVER |
| `postes/11-noite.jpg` | 216288 | 0 | postes | 0 | 0 | MOVER |
| `postes/ESTUDO.md` | 3154 | 36 | postes | 0 | 0 | MOVER |
| `PROMPT-ANALISE.md` | 6190 | 90 | PROMPT-ANALISE.md | 0 | 0 | MOVER |
| `PROMPT-CONTINUAR.md` | 8729 | 103 | PROMPT-CONTINUAR.md | 0 | 0 | MOVER |
| `public/cooked/people/people.bin` | 29533184 | 0 | public | 0 | 0 | MANTER |
| `public/cooked/people/people.json` | 19589 | 0 | public | 1 | 0 | MANTER |
| `public/cooked/surfaces/asphalt.detail-normal.ktx2` | 591337 | 0 | public | 0 | 0 | MANTER |
| `public/cooked/surfaces/asphalt.detail.ktx2` | 249777 | 0 | public | 0 | 0 | MANTER |
| `public/cooked/surfaces/asphalt.map.ktx2` | 381167 | 0 | public | 0 | 0 | MANTER |
| `public/cooked/surfaces/asphalt.normal.ktx2` | 801199 | 0 | public | 0 | 0 | MANTER |
| `public/cooked/surfaces/asphalt.rough.ktx2` | 190029 | 0 | public | 0 | 0 | MANTER |
| `public/cooked/surfaces/building-finishes.map.ktx2` | 1024651 | 0 | public | 0 | 0 | MANTER |
| `public/cooked/surfaces/building-finishes.normal.ktx2` | 1582699 | 0 | public | 0 | 0 | MANTER |
| `public/cooked/surfaces/building-finishes.rough.ktx2` | 42956 | 0 | public | 0 | 0 | MANTER |
| `public/cooked/surfaces/concrete.detail-normal.ktx2` | 836509 | 0 | public | 0 | 0 | MANTER |
| `public/cooked/surfaces/concrete.detail.ktx2` | 256443 | 0 | public | 0 | 0 | MANTER |
| `public/cooked/surfaces/footway.map.ktx2` | 1293846 | 0 | public | 0 | 0 | MANTER |
| `public/cooked/surfaces/footway.normal.ktx2` | 1636273 | 0 | public | 0 | 0 | MANTER |
| `public/cooked/surfaces/footway.rough.ktx2` | 727133 | 0 | public | 0 | 0 | MANTER |
| `public/cooked/surfaces/kerb.map.ktx2` | 89335 | 0 | public | 0 | 0 | MANTER |
| `public/cooked/surfaces/kerb.normal.ktx2` | 83934 | 0 | public | 0 | 0 | MANTER |
| `public/cooked/surfaces/kerb.rough.ktx2` | 36010 | 0 | public | 0 | 0 | MANTER |
| `public/cooked/surfaces/terrain-grass.map.ktx2` | 2097856 | 0 | public | 0 | 0 | MANTER |
| `public/cooked/surfaces/terrain-grass.normal.ktx2` | 2911211 | 0 | public | 0 | 0 | MANTER |
| `public/cooked/surfaces/terrain-land.map.ktx2` | 3700918 | 0 | public | 0 | 0 | MANTER |
| `public/cooked/surfaces/terrain-land.normal.ktx2` | 5475353 | 0 | public | 0 | 0 | MANTER |
| `public/cooked/surfaces/verge.map.ktx2` | 384532 | 0 | public | 0 | 0 | MANTER |
| `public/cooked/surfaces/verge.normal.ktx2` | 675248 | 0 | public | 0 | 0 | MANTER |
| `public/models/citizens/LICENSE-ANIMATIONS.txt` | 329 | 12 | public | 0 | 0 | MANTER |
| `public/models/citizens/LICENSE-MICROSOFT.txt` | 1087 | 22 | public | 0 | 0 | MANTER |
| `public/models/citizens/rocketboxFemale.json` | 6659464 | 0 | public | 0 | 0 | MANTER |
| `public/models/citizens/rocketboxMale.json` | 7703181 | 0 | public | 0 | 0 | MANTER |
| `public/models/citizens/walkFemale.json` | 113592 | 0 | public | 0 | 0 | MANTER |
| `public/models/citizens/walkMale.json` | 99742 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/base.bin` | 711736 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/base.json` | 28832 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/LICENSE-MakeHuman-CC0.txt` | 7629 | 50 | public | 0 | 0 | MANTER |
| `public/models/people/LICENSES.json` | 680286 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/modifiers.json` | 83066 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/afro01.bin` | 126448 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/afro01.json` | 689 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/afro01.webp` | 134328 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/bob01.bin` | 363972 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/bob01.json` | 692 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/bob01.webp` | 45736 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/bob02.bin` | 104372 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/bob02.json` | 684 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/bob02.webp` | 45036 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/braid01.bin` | 276140 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/braid01.json` | 697 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/braid01.webp` | 18138 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/fedora01.bin` | 45816 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/fedora01.json` | 697 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/fedora01.webp` | 68278 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/female_casualsuit01.bin` | 178184 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/female_casualsuit01.json` | 739 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/female_casualsuit01.webp` | 30844 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/female_casualsuit02.bin` | 217696 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/female_casualsuit02.json` | 740 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/female_casualsuit02.webp` | 47864 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/female_elegantsuit01.bin` | 174472 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/female_elegantsuit01.json` | 742 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/female_elegantsuit01.webp` | 29398 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/female_sportsuit01.bin` | 147328 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/female_sportsuit01.json` | 735 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/female_sportsuit01.webp` | 16696 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/index.json` | 6531 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/long01.bin` | 195112 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/long01.json` | 690 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/long01.webp` | 37658 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/male_casualsuit01.bin` | 629080 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/male_casualsuit01.json` | 741 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/male_casualsuit01.webp` | 21942 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/male_casualsuit02.bin` | 177028 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/male_casualsuit02.json` | 733 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/male_casualsuit02.webp` | 23946 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/male_casualsuit03.bin` | 204856 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/male_casualsuit03.json` | 734 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/male_casualsuit03.webp` | 50876 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/male_casualsuit04.bin` | 142012 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/male_casualsuit04.json` | 731 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/male_casualsuit04.webp` | 23952 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/male_casualsuit05.bin` | 266508 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/male_casualsuit05.json` | 737 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/male_casualsuit05.webp` | 26588 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/male_casualsuit06.bin` | 283660 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/male_casualsuit06.json` | 737 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/male_casualsuit06.webp` | 18566 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/male_elegantsuit01.bin` | 580080 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/male_elegantsuit01.json` | 744 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/male_elegantsuit01.webp` | 6840 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/male_worksuit01.bin` | 278608 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/male_worksuit01.json` | 732 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/male_worksuit01.webp` | 33532 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/ponytail01.bin` | 242380 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/ponytail01.json` | 705 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/ponytail01.webp` | 81772 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/shoes01.bin` | 136440 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/shoes01.json` | 708 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/shoes01.webp` | 32632 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/shoes02.bin` | 126328 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/shoes02.json` | 708 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/shoes02.webp` | 32084 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/shoes03.bin` | 174208 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/shoes03.json` | 710 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/shoes03.webp` | 8266 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/shoes04.bin` | 136440 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/shoes04.json` | 708 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/shoes04.webp` | 19556 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/shoes05.bin` | 126328 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/shoes05.json` | 708 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/shoes05.webp` | 33654 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/shoes06.bin` | 126328 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/shoes06.json` | 708 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/shoes06.webp` | 44288 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/short01.bin` | 183924 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/short01.json` | 694 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/short01.webp` | 103364 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/short02.bin` | 130812 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/short02.json` | 691 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/short02.webp` | 40190 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/short03.bin` | 70188 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/short03.json` | 689 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/short03.webp` | 32718 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/short04.bin` | 56204 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/short04.json` | 687 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/proxies/short04.webp` | 62274 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/skeleton-game-engine.json` | 21903 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/skins/index.json` | 9382 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/skins/middleage_african_female.webp` | 40158 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/skins/middleage_african_male.webp` | 50500 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/skins/middleage_asian_female.webp` | 55886 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/skins/middleage_asian_male.webp` | 77554 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/skins/middleage_caucasian_female.webp` | 66502 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/skins/middleage_caucasian_male.webp` | 72282 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/skins/old_african_female.webp` | 42660 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/skins/old_african_male.webp` | 67112 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/skins/old_asian_female.webp` | 99406 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/skins/old_asian_male.webp` | 100546 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/skins/old_caucasian_female.webp` | 95124 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/skins/old_caucasian_male.webp` | 128004 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/skins/young_african_female.webp` | 44018 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/skins/young_african_male.webp` | 45016 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/skins/young_asian_female.webp` | 63384 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/skins/young_asian_male.webp` | 65254 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/skins/young_caucasian_female.webp` | 77904 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/skins/young_caucasian_male.webp` | 72238 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/targets-local.bin` | 6641856 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/targets-local.json` | 140920 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/targets-macro-pca.bin` | 10541002 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/targets-macro-pca.json` | 65651 | 0 | public | 0 | 0 | MANTER |
| `public/models/people/weights-game-engine.bin` | 229896 | 0 | public | 0 | 0 | MANTER |
| `scripts/fotos/crescimento.js` | 854 | 14 | scripts | 0 | 0 | JUNTAR |
| `scripts/fotos/desgaste.js` | 935 | 13 | scripts | 0 | 0 | JUNTAR |
| `scripts/fotos/economia.js` | 976 | 19 | scripts | 0 | 0 | JUNTAR |
| `scripts/fotos/lote-poligono.js` | 1564 | 24 | scripts | 0 | 0 | JUNTAR |
| `scripts/fotos/manobras.js` | 1809 | 27 | scripts | 0 | 0 | JUNTAR |
| `scripts/fotos/nos-impossiveis.js` | 649 | 9 | scripts | 0 | 0 | JUNTAR |
| `scripts/fotos/quarentena.js` | 1112 | 14 | scripts | 0 | 0 | JUNTAR |
| `scripts/fotos/reparo.js` | 1048 | 17 | scripts | 0 | 0 | JUNTAR |
| `scripts/fotos/transporte.js` | 1682 | 25 | scripts | 0 | 0 | JUNTAR |
| `scripts/lotes.ts` | 2942 | 48 | scripts | 0 | 6 | MOVER |
| `scripts/transito.ts` | 13250 | 186 | scripts | 0 | 5 | MOVER |
| `scripts/verificacao/1-ferramentas-e-acoes.js` | 10674 | 140 | scripts | 0 | 0 | DIVIDIR |
| `scripts/verificacao/2-vias-cruzamentos-lotes-ceu.js` | 13594 | 118 | scripts | 0 | 0 | DIVIDIR |
| `scripts/verificacao/3-inspetor-opcoes-detalhes.js` | 6355 | 51 | scripts | 0 | 0 | DIVIDIR |
| `src/app/buildings.ts` | 2216 | 44 | app | 1 | 7 | JUNTAR |
| `src/app/clicks.ts` | 3284 | 62 | app | 2 | 8 | MANTER |
| `src/app/featureActions.ts` | 2402 | 36 | app | 2 | 0 | JUNTAR |
| `src/app/input.ts` | 15064 | 298 | app | 1 | 25 | MANTER |
| `src/app/lotEditing.ts` | 20106 | 390 | app | 1 | 18 | MOVER |
| `src/app/photoHooks.ts` | 1800 | 35 | app | 1 | 2 | MANTER |
| `src/app/session.ts` | 12032 | 224 | app | 1 | 19 | MOVER |
| `src/app/tools.ts` | 4568 | 90 | app | 1 | 14 | MANTER |
| `src/config.ts` | 2426 | 61 | shared | 52 | 0 | MANTER |
| `src/core/commands.ts` | 3988 | 104 | core | 26 | 0 | MANTER |
| `src/core/grid.ts` | 8987 | 259 | core | 41 | 1 | MANTER |
| `src/core/rng.ts` | 2406 | 63 | core | 24 | 0 | MANTER |
| `src/core/table.ts` | 3869 | 112 | core | 13 | 0 | MANTER |
| `src/features/demolition/blast/blast.ts` | 14026 | 261 | features | 2 | 4 | MANTER |
| `src/features/demolition/blast/debris.ts` | 16698 | 334 | features | 2 | 0 | MANTER |
| `src/features/demolition/blast/marks.ts` | 9612 | 202 | features | 1 | 0 | MANTER |
| `src/features/demolition/blast/thrown.ts` | 7432 | 120 | features | 1 | 4 | MANTER |
| `src/features/demolition/bomb.ts` | 10591 | 185 | features | 1 | 9 | MANTER |
| `src/features/demolition/demolish.ts` | 4628 | 88 | features | 4 | 6 | MANTER |
| `src/features/demolition/demolition.ts` | 3746 | 79 | features | 1 | 9 | MANTER |
| `src/features/demolition/ruin/fracture.ts` | 18057 | 312 | features | 3 | 3 | MANTER |
| `src/features/demolition/ruin/ruinMesh.ts` | 8911 | 172 | features | 1 | 5 | MANTER |
| `src/features/demolition/ruin/ruins.ts` | 19831 | 384 | features | 1 | 8 | MANTER |
| `src/features/demolition/ruin/worker.ts` | 1668 | 30 | features | 1 | 3 | MANTER |
| `src/features/roads/roadTool.ts` | 19588 | 389 | features | 4 | 13 | DIVIDIR |
| `src/features/sky/clouds.ts` | 4851 | 100 | features | 1 | 5 | MANTER |
| `src/features/sky/weatherControl.ts` | 2378 | 53 | features | 1 | 2 | MANTER |
| `src/features/streetscape/itemTool.ts` | 14564 | 269 | features | 5 | 14 | DIVIDIR |
| `src/features/terrain/riverTool.ts` | 2305 | 54 | features | 1 | 6 | MOVER |
| `src/features/transit/transitTool.ts` | 7099 | 152 | features | 1 | 7 | MANTER |
| `src/features/water/waterControl.ts` | 854 | 23 | features | 1 | 1 | MANTER |
| `src/features/zones/zoneTool.ts` | 7107 | 158 | features | 5 | 6 | MANTER |
| `src/game.ts` | 121234 | 2090 | app(root) | 1 | 82 | DIVIDIR |
| `src/jobs/blockLots.ts` | 10235 | 171 | jobs | 1 | 4 | MANTER |
| `src/jobs/boxMesh.ts` | 4615 | 112 | jobs | 3 | 2 | MANTER |
| `src/jobs/building40.ts` | 22047 | 367 | jobs | 3 | 3 | DIVIDIR |
| `src/jobs/buildingFinishes.ts` | 4725 | 73 | jobs | 12 | 0 | MANTER |
| `src/jobs/buildingFinishWorker.ts` | 1445 | 27 | jobs | 1 | 1 | MANTER |
| `src/jobs/buildingGen.ts` | 15742 | 265 | jobs | 16 | 24 | DIVIDIR |
| `src/jobs/buildingGen/catalog.ts` | 22784 | 316 | jobs | 1 | 16 | MANTER |
| `src/jobs/buildingGen/civic.ts` | 14555 | 235 | jobs | 1 | 12 | MANTER |
| `src/jobs/buildingGen/context.ts` | 856 | 19 | jobs | 6 | 4 | MANTER |
| `src/jobs/buildingGen/finishes.ts` | 4400 | 68 | jobs | 2 | 7 | MANTER |
| `src/jobs/buildingGen/geometry.ts` | 9646 | 159 | jobs | 9 | 3 | MANTER |
| `src/jobs/buildingGen/heights.ts` | 5008 | 73 | jobs | 2 | 5 | MANTER |
| `src/jobs/buildingGen/lot.ts` | 20285 | 344 | jobs | 5 | 8 | DIVIDIR |
| `src/jobs/buildingGen/materials.ts` | 519 | 6 | jobs | 10 | 0 | MANTER |
| `src/jobs/buildingGen/outputs.ts` | 1511 | 30 | jobs | 3 | 1 | MANTER |
| `src/jobs/buildingGen/plan.ts` | 6404 | 113 | jobs | 3 | 8 | MANTER |
| `src/jobs/buildingGen/plans.ts` | 27757 | 423 | jobs | 4 | 14 | MANTER |
| `src/jobs/buildingGen/plans2.ts` | 22356 | 355 | jobs | 2 | 16 | RENOMEAR |
| `src/jobs/buildingGen/polygon.ts` | 3763 | 70 | jobs | 6 | 1 | JUNTAR |
| `src/jobs/buildingGen/shell.ts` | 16048 | 248 | jobs | 6 | 9 | MANTER |
| `src/jobs/buildingGen/windows.ts` | 12933 | 174 | jobs | 7 | 4 | MANTER |
| `src/jobs/cityField.ts` | 1783 | 33 | jobs | 1 | 0 | JUNTAR |
| `src/jobs/cityGen.ts` | 25288 | 482 | jobs | 7 | 7 | MANTER |
| `src/jobs/conform.ts` | 4314 | 83 | jobs | 1 | 3 | JUNTAR |
| `src/jobs/debugCity.ts` | 8646 | 179 | jobs | 3 | 8 | MOVER |
| `src/jobs/ktxParse.d.ts` | 593 | 18 | jobs | 0 | 0 | JUNTAR |
| `src/jobs/lots.ts` | 18951 | 331 | jobs | 7 | 11 | MANTER |
| `src/jobs/meshBuilder.ts` | 8117 | 167 | jobs | 19 | 2 | MANTER |
| `src/jobs/parts40.ts` | 4787 | 67 | jobs | 3 | 0 | MOVER |
| `src/jobs/pool.ts` | 10029 | 241 | jobs | 12 | 3 | MANTER |
| `src/jobs/props.ts` | 35657 | 604 | jobs | 8 | 15 | DIVIDIR |
| `src/jobs/roadMesh.ts` | 45062 | 768 | jobs | 9 | 12 | DIVIDIR |
| `src/jobs/roadPaint.ts` | 4460 | 91 | jobs | 2 | 7 | MANTER |
| `src/jobs/storage.ts` | 7804 | 151 | jobs | 8 | 4 | MANTER |
| `src/jobs/terrainGen.ts` | 17344 | 323 | jobs | 10 | 4 | MANTER |
| `src/jobs/terrainSeams.ts` | 13175 | 212 | jobs | 4 | 5 | MANTER |
| `src/jobs/worker.ts` | 6673 | 124 | jobs | 1 | 15 | MANTER |
| `src/main.ts` | 938 | 22 | app(root) | 0 | 3 | MANTER |
| `src/platform/audio.ts` | 7970 | 165 | platform | 3 | 0 | MANTER |
| `src/platform/mapExtra.ts` | 2895 | 49 | platform | 3 | 0 | MANTER |
| `src/platform/mapFile.ts` | 12580 | 228 | platform | 3 | 3 | DIVIDIR |
| `src/platform/save.ts` | 5947 | 128 | platform | 7 | 2 | MANTER |
| `src/platform/saveFiles.ts` | 29082 | 546 | platform | 4 | 2 | DIVIDIR |
| `src/platform/steam.ts` | 755 | 19 | platform | 2 | 0 | MANTER |
| `src/r40/api.ts` | 1592 | 22 | r40 | 3 | 15 | APAGAR |
| `src/r40/core/aabb.ts` | 1193 | 47 | r40 | 1 | 1 | APAGAR |
| `src/r40/core/forkMap.ts` | 5921 | 177 | r40 | 1 | 0 | MOVER |
| `src/r40/core/hypot.ts` | 2301 | 49 | r40 | 4 | 0 | JUNTAR |
| `src/r40/core/identityMemo.ts` | 606 | 17 | r40 | 7 | 0 | DIVIDIR |
| `src/r40/core/intersect.ts` | 2066 | 69 | r40 | 1 | 2 | JUNTAR |
| `src/r40/core/minMax.ts` | 746 | 10 | r40 | 1 | 0 | JUNTAR |
| `src/r40/core/polygon.ts` | 3460 | 91 | r40 | 6 | 2 | JUNTAR |
| `src/r40/core/rng.ts` | 3598 | 119 | r40 | 5 | 1 | JUNTAR |
| `src/r40/core/scalar.ts` | 2712 | 73 | r40 | 7 | 1 | DIVIDIR |
| `src/r40/core/units.ts` | 1057 | 20 | r40 | 2 | 0 | APAGAR |
| `src/r40/core/vec2.ts` | 1654 | 47 | r40 | 19 | 1 | JUNTAR |
| `src/r40/render/bake/finishRecipes.ts` | 13687 | 383 | r40 | 1 | 3 | MOVER |
| `src/r40/render/buildings/buildingMesh.ts` | 44025 | 773 | r40 | 1 | 31 | DIVIDIR |
| `src/r40/render/buildings/cellArrays.ts` | 34752 | 588 | r40 | 8 | 10 | DIVIDIR |
| `src/r40/render/buildings/chunk.ts` | 5593 | 116 | r40 | 8 | 5 | MOVER |
| `src/r40/render/buildings/elementMesh.ts` | 38169 | 822 | r40 | 2 | 11 | DIVIDIR |
| `src/r40/render/buildings/facadeEmit.ts` | 27461 | 521 | r40 | 1 | 12 | MOVER |
| `src/r40/render/buildings/facadeKit.ts` | 22742 | 451 | r40 | 1 | 0 | MOVER |
| `src/r40/render/buildings/facadeLevel.ts` | 12034 | 202 | r40 | 3 | 3 | APAGAR |
| `src/r40/render/buildings/facadePropModels.ts` | 14544 | 328 | r40 | 1 | 2 | MOVER |
| `src/r40/render/buildings/facadeProps.ts` | 10622 | 193 | r40 | 5 | 2 | MOVER |
| `src/r40/render/buildings/fade.ts` | 2085 | 44 | r40 | 1 | 3 | APAGAR |
| `src/r40/render/buildings/finishes.ts` | 13952 | 249 | r40 | 1 | 5 | DIVIDIR |
| `src/r40/render/buildings/flagLayer.ts` | 6802 | 171 | r40 | 3 | 3 | DIVIDIR |
| `src/r40/render/buildings/furnitureKit.ts` | 18341 | 346 | r40 | 2 | 2 | DIVIDIR |
| `src/r40/render/buildings/glassRoom.ts` | 13520 | 256 | r40 | 1 | 2 | APAGAR |
| `src/r40/render/buildings/interiorMesh.ts` | 7755 | 141 | r40 | 1 | 8 | MOVER |
| `src/r40/render/buildings/kit.ts` | 36639 | 706 | r40 | 6 | 19 | DIVIDIR |
| `src/r40/render/buildings/landmarks.ts` | 27669 | 422 | r40 | 1 | 1 | MOVER |
| `src/r40/render/buildings/lawnGround.ts` | 2523 | 63 | r40 | 1 | 0 | JUNTAR |
| `src/r40/render/buildings/lightSlots.ts` | 1557 | 30 | r40 | 1 | 0 | RENOMEAR |
| `src/r40/render/buildings/lotMesh.ts` | 14025 | 267 | r40 | 1 | 16 | MOVER |
| `src/r40/render/buildings/massBoxes.ts` | 3276 | 57 | r40 | 1 | 2 | APAGAR |
| `src/r40/render/buildings/massing.ts` | 38618 | 657 | r40 | 3 | 11 | DIVIDIR |
| `src/r40/render/buildings/massingMaterial.ts` | 8196 | 136 | r40 | 2 | 1 | APAGAR |
| `src/r40/render/buildings/meshCore.ts` | 39362 | 886 | r40 | 6 | 19 | DIVIDIR |
| `src/r40/render/buildings/partFiling.ts` | 11593 | 208 | r40 | 1 | 6 | MOVER |
| `src/r40/render/buildings/partPose.ts` | 6089 | 99 | r40 | 6 | 0 | DIVIDIR |
| `src/r40/render/buildings/partyWalls.ts` | 7088 | 121 | r40 | 1 | 9 | MOVER |
| `src/r40/render/buildings/roofMesh.ts` | 37699 | 681 | r40 | 2 | 8 | DIVIDIR |
| `src/r40/render/buildings/roofPlan.ts` | 4454 | 84 | r40 | 4 | 3 | MOVER |
| `src/r40/render/buildings/roomBehind.ts` | 8617 | 171 | r40 | 4 | 4 | MOVER |
| `src/r40/render/buildings/roomLamps.ts` | 2971 | 63 | r40 | 3 | 0 | DIVIDIR |
| `src/r40/render/buildings/shellParts.ts` | 9909 | 165 | r40 | 10 | 2 | DIVIDIR |
| `src/r40/render/buildings/signature.ts` | 108069 | 1781 | r40 | 2 | 5 | DIVIDIR |
| `src/r40/render/buildings/thinParts.ts` | 3976 | 69 | r40 | 1 | 0 | APAGAR |
| `src/r40/render/depthConvention.ts` | 1702 | 37 | r40 | 1 | 0 | APAGAR |
| `src/r40/render/lightLevels.ts` | 2508 | 62 | r40 | 1 | 0 | APAGAR |
| `src/r40/render/mesh/gpuOnly.ts` | 2739 | 57 | r40 | 2 | 0 | MOVER |
| `src/r40/render/mesh/textureBaker.ts` | 5699 | 142 | r40 | 1 | 0 | MOVER |
| `src/r40/render/mesh/weld.ts` | 3941 | 81 | r40 | 3 | 0 | MOVER |
| `src/r40/render/shadowCasters.ts` | 1418 | 29 | r40 | 1 | 0 | APAGAR |
| `src/r40/render/surfaceTextures.ts` | 4814 | 105 | r40 | 1 | 0 | MOVER |
| `src/r40/render/terrainGrid.ts` | 673 | 13 | r40 | 1 | 1 | JUNTAR |
| `src/r40/render/wind.ts` | 9577 | 194 | r40 | 1 | 1 | APAGAR |
| `src/r40/world/bounds.ts` | 4510 | 94 | r40 | 1 | 4 | APAGAR |
| `src/r40/world/buildings/architecture.ts` | 17780 | 326 | r40 | 1 | 7 | MOVER |
| `src/r40/world/buildings/blocks.ts` | 6644 | 134 | r40 | 4 | 6 | MOVER |
| `src/r40/world/buildings/blueprints.ts` | 13470 | 331 | r40 | 3 | 5 | JUNTAR |
| `src/r40/world/buildings/cityBuildings.ts` | 21000 | 345 | r40 | 5 | 4 | JUNTAR |
| `src/r40/world/buildings/elements.ts` | 23989 | 503 | r40 | 5 | 8 | DIVIDIR |
| `src/r40/world/buildings/flags.ts` | 2084 | 39 | r40 | 4 | 0 | MOVER |
| `src/r40/world/buildings/footprints.ts` | 10029 | 182 | r40 | 17 | 6 | MOVER |
| `src/r40/world/buildings/foundation.ts` | 15000 | 341 | r40 | 10 | 5 | MOVER |
| `src/r40/world/buildings/geometry.ts` | 36170 | 798 | r40 | 20 | 7 | MOVER |
| `src/r40/world/buildings/interior.ts` | 44863 | 921 | r40 | 9 | 9 | DIVIDIR |
| `src/r40/world/buildings/intern.ts` | 5336 | 113 | r40 | 1 | 0 | MOVER |
| `src/r40/world/buildings/lots.ts` | 4353 | 86 | r40 | 4 | 4 | JUNTAR |
| `src/r40/world/buildings/materials.ts` | 12424 | 275 | r40 | 15 | 3 | DIVIDIR |
| `src/r40/world/buildings/materialTypes.ts` | 1013 | 25 | r40 | 2 | 0 | MANTER |
| `src/r40/world/buildings/pads.ts` | 17255 | 352 | r40 | 1 | 7 | MOVER |
| `src/r40/world/buildings/procedural.ts` | 41755 | 706 | r40 | 2 | 9 | MOVER |
| `src/r40/world/buildings/recordTable.ts` | 18270 | 376 | r40 | 1 | 1 | MOVER |
| `src/r40/world/buildings/roofPlant.ts` | 7320 | 146 | r40 | 1 | 2 | JUNTAR |
| `src/r40/world/buildings/spaces.ts` | 6279 | 150 | r40 | 3 | 4 | MOVER |
| `src/r40/world/buildings/towerKit.ts` | 1340 | 22 | r40 | 1 | 0 | JUNTAR |
| `src/r40/world/buildings/types.ts` | 19190 | 470 | r40 | 31 | 5 | DIVIDIR |
| `src/r40/world/cells.ts` | 9062 | 211 | r40 | 3 | 3 | APAGAR |
| `src/r40/world/growth/lotBoundaryRuns.ts` | 2674 | 59 | r40 | 1 | 0 | MOVER |
| `src/r40/world/growth/lotPlan.ts` | 70231 | 1093 | r40 | 1 | 11 | DIVIDIR |
| `src/r40/world/lotRings.ts` | 3395 | 67 | r40 | 1 | 1 | MANTER |
| `src/r40/world/tiles.ts` | 6064 | 103 | r40 | 1 | 3 | APAGAR |
| `src/r40/world/units.ts` | 227 | 3 | r40 | 37 | 1 | APAGAR |
| `src/r40/world/zones.ts` | 1418 | 37 | r40 | 1 | 0 | APAGAR |
| `src/render/cameraRig.ts` | 19701 | 426 | render | 5 | 3 | MANTER |
| `src/render/carBody.ts` | 63466 | 1170 | render | 5 | 0 | DIVIDIR |
| `src/render/cellLayer.ts` | 29285 | 548 | render | 6 | 4 | MANTER |
| `src/render/city.ts` | 37357 | 492 | render | 3 | 15 | DIVIDIR |
| `src/render/cloudPuffs.ts` | 4465 | 90 | render | 2 | 4 | JUNTAR |
| `src/render/cloudShadow.ts` | 2871 | 56 | render | 2 | 2 | MANTER |
| `src/render/cookedSurfaces.ts` | 3982 | 74 | render | 3 | 1 | MANTER |
| `src/render/cookedWorker.ts` | 1619 | 29 | render | 1 | 0 | MANTER |
| `src/render/ecology.ts` | 6056 | 93 | render | 3 | 2 | MOVER |
| `src/render/ecologyWorker.ts` | 1011 | 15 | render | 1 | 1 | MOVER |
| `src/render/heavyBody.ts` | 27598 | 525 | render | 1 | 1 | DIVIDIR |
| `src/render/impostor.ts` | 7776 | 152 | render | 3 | 1 | MANTER |
| `src/render/inside.ts` | 12635 | 234 | render | 7 | 4 | DIVIDIR |
| `src/render/ktx-parse.d.ts` | 534 | 8 | render | 0 | 0 | JUNTAR |
| `src/render/particles.ts` | 13786 | 235 | render | 5 | 11 | MANTER |
| `src/render/people/creator.ts` | 8346 | 153 | render | 3 | 3 | MOVER |
| `src/render/people/crowd.ts` | 22201 | 360 | render | 2 | 6 | MANTER |
| `src/render/people/format.ts` | 3659 | 54 | render | 5 | 0 | MANTER |
| `src/render/people/looks.ts` | 3401 | 77 | render | 4 | 1 | MOVER |
| `src/render/people/occupants.ts` | 2138 | 44 | render | 1 | 1 | MANTER |
| `src/render/post.ts` | 19599 | 353 | render | 3 | 6 | DIVIDIR |
| `src/render/preview.ts` | 5395 | 118 | render | 8 | 2 | MANTER |
| `src/render/propBlocks.ts` | 4546 | 112 | render | 2 | 0 | MANTER |
| `src/render/propMeshes.ts` | 39867 | 713 | render | 2 | 7 | DIVIDIR |
| `src/render/props.ts` | 47341 | 799 | render | 2 | 16 | DIVIDIR |
| `src/render/roads.ts` | 34213 | 526 | render | 5 | 16 | MANTER |
| `src/render/scene.ts` | 17583 | 329 | render | 14 | 3 | DIVIDIR |
| `src/render/sun.ts` | 1223 | 25 | render | 9 | 0 | MANTER |
| `src/render/surfaceBake.ts` | 12886 | 238 | render | 3 | 0 | MOVER |
| `src/render/terrain.ts` | 66020 | 1086 | render | 4 | 15 | DIVIDIR |
| `src/render/terrainSeams.ts` | 3454 | 54 | render | 1 | 8 | MANTER |
| `src/render/textSigns.ts` | 4175 | 97 | render | 2 | 3 | MOVER |
| `src/render/traa.ts` | 23198 | 707 | render | 2 | 0 | MANTER |
| `src/render/transit.ts` | 11745 | 223 | render | 3 | 9 | MOVER |
| `src/render/treeMeshes.ts` | 21034 | 355 | render | 2 | 0 | MANTER |
| `src/render/tsl.ts` | 3289 | 67 | render | 19 | 0 | MANTER |
| `src/render/vehicles.ts` | 53191 | 849 | render | 5 | 8 | DIVIDIR |
| `src/render/velocity.ts` | 2918 | 53 | render | 2 | 1 | MANTER |
| `src/render/weather.ts` | 18313 | 324 | render | 12 | 2 | DIVIDIR |
| `src/roads/build.ts` | 79413 | 1568 | roads | 32 | 20 | DIVIDIR |
| `src/roads/control.ts` | 11829 | 228 | roads | 23 | 3 | MANTER |
| `src/roads/dash.ts` | 2154 | 49 | roads | 3 | 0 | MANTER |
| `src/roads/economy.ts` | 3049 | 58 | roads | 5 | 3 | MANTER |
| `src/roads/flags.ts` | 658 | 16 | roads | 13 | 0 | JUNTAR |
| `src/roads/geometry.ts` | 7806 | 180 | roads | 29 | 0 | MANTER |
| `src/roads/ground.ts` | 2464 | 46 | roads | 3 | 4 | MANTER |
| `src/roads/impossible.ts` | 3302 | 76 | roads | 3 | 2 | MANTER |
| `src/roads/junction.ts` | 8267 | 153 | roads | 13 | 3 | MANTER |
| `src/roads/kerb.ts` | 2760 | 48 | roads | 7 | 2 | DIVIDIR |
| `src/roads/laneLinks.ts` | 4316 | 90 | roads | 5 | 4 | MANTER |
| `src/roads/markings.ts` | 7481 | 133 | roads | 1 | 0 | APAGAR |
| `src/roads/network.ts` | 19830 | 435 | roads | 27 | 10 | MANTER |
| `src/roads/networkView.ts` | 1185 | 35 | roads | 2 | 1 | MANTER |
| `src/roads/profiles.ts` | 26904 | 446 | roads | 67 | 1 | DIVIDIR |
| `src/roads/profileWork.ts` | 5778 | 104 | roads | 3 | 1 | MANTER |
| `src/roads/repair.ts` | 2819 | 55 | roads | 3 | 4 | MANTER |
| `src/roads/roadVariant.ts` | 7017 | 119 | roads | 5 | 2 | MANTER |
| `src/roads/signRule.ts` | 3049 | 53 | roads | 4 | 4 | MANTER |
| `src/roads/streetNames.ts` | 8846 | 151 | roads | 5 | 7 | MOVER |
| `src/roads/tuning.ts` | 2208 | 36 | roads | 9 | 0 | MANTER |
| `src/roads/zones.ts` | 873 | 11 | roads | 35 | 0 | MOVER |
| `src/shared/contracts/bomb.ts` | 669 | 16 | shared | 4 | 0 | MANTER |
| `src/shared/contracts/people.ts` | 1110 | 28 | shared | 5 | 0 | MANTER |
| `src/shared/contracts/poses.ts` | 5920 | 130 | shared | 5 | 0 | MANTER |
| `src/shared/contracts/worker.ts` | 10476 | 221 | shared | 40 | 1 | MANTER |
| `src/shared/errors.ts` | 153 | 3 | shared | 2 | 0 | MANTER |
| `src/shared/i18n/index.ts` | 6821 | 150 | shared | 30 | 5 | DIVIDIR |
| `src/shared/i18n/lang/engine.en.ts` | 33107 | 541 | shared | 2 | 0 | MANTER |
| `src/shared/i18n/lang/engine.pt-BR.ts` | 34339 | 541 | shared | 2 | 0 | MANTER |
| `src/shared/i18n/lang/legacy.ts` | 46170 | 327 | shared | 1 | 0 | APAGAR |
| `src/shared/vehiclePaints.ts` | 510 | 9 | shared | 4 | 0 | MANTER |
| `src/sim/advisor.ts` | 4456 | 96 | sim | 3 | 2 | MANTER |
| `src/sim/drivers.ts` | 9028 | 155 | sim | 7 | 0 | MANTER |
| `src/sim/lanes.ts` | 31251 | 594 | sim | 23 | 8 | MANTER |
| `src/sim/manoeuvres.ts` | 4443 | 94 | sim | 2 | 2 | MANTER |
| `src/sim/peds.ts` | 90606 | 1628 | sim | 4 | 12 | DIVIDIR |
| `src/sim/probe.ts` | 1778 | 36 | sim | 2 | 3 | MANTER |
| `src/sim/reedsShepp.ts` | 6433 | 142 | sim | 2 | 0 | MANTER |
| `src/sim/routing.ts` | 13086 | 265 | sim | 6 | 4 | MANTER |
| `src/sim/signals.ts` | 15180 | 307 | sim | 3 | 2 | MANTER |
| `src/sim/traffic.ts` | 89346 | 1727 | sim | 10 | 26 | DIVIDIR |
| `src/sim/traffic/buses.ts` | 12865 | 271 | sim | 3 | 8 | MANTER |
| `src/sim/traffic/grow.ts` | 399 | 10 | sim | 2 | 0 | JUNTAR |
| `src/sim/traffic/junctions.ts` | 27262 | 463 | sim | 2 | 9 | MANTER |
| `src/sim/traffic/laneChanges.ts` | 5937 | 132 | sim | 2 | 3 | MANTER |
| `src/sim/traffic/lines.ts` | 6416 | 111 | sim | 7 | 5 | MANTER |
| `src/sim/traffic/measure.ts` | 4369 | 85 | sim | 1 | 2 | MANTER |
| `src/sim/traffic/meso.ts` | 14644 | 305 | sim | 2 | 10 | MANTER |
| `src/sim/traffic/micro.ts` | 29320 | 510 | sim | 1 | 12 | MANTER |
| `src/sim/traffic/regions.ts` | 3100 | 71 | sim | 2 | 3 | MANTER |
| `src/sim/traffic/state.ts` | 5595 | 91 | sim | 6 | 1 | MANTER |
| `src/sim/traffic/stops.ts` | 4381 | 80 | sim | 2 | 2 | MANTER |
| `src/sim/worker.ts` | 12410 | 226 | sim | 4 | 6 | MANTER |
| `src/ui/about.ts` | 6089 | 130 | ui | 1 | 3 | MANTER |
| `src/ui/boot.ts` | 1103 | 28 | ui | 2 | 1 | MANTER |
| `src/ui/compass.ts` | 2805 | 71 | ui | 1 | 1 | MANTER |
| `src/ui/creator.ts` | 7884 | 152 | ui | 3 | 1 | MOVER |
| `src/ui/css.d.ts` | 97 | 3 | ui | 0 | 0 | MANTER |
| `src/ui/dom.ts` | 10872 | 224 | ui | 9 | 1 | MANTER |
| `src/ui/drawers.ts` | 47687 | 677 | ui | 2 | 18 | DIVIDIR |
| `src/ui/engine.css` | 15114 | 0 | ui | 1 | 0 | JUNTAR |
| `src/ui/health.ts` | 7084 | 144 | ui | 3 | 2 | MANTER |
| `src/ui/hud.ts` | 45853 | 810 | ui | 8 | 15 | DIVIDIR |
| `src/ui/hudActions.ts` | 6040 | 134 | ui | 11 | 3 | DIVIDIR |
| `src/ui/icons.ts` | 22328 | 217 | ui | 7 | 0 | MANTER |
| `src/ui/inspector.ts` | 47810 | 797 | ui | 4 | 13 | DIVIDIR |
| `src/ui/keys.ts` | 10621 | 189 | ui | 5 | 2 | MANTER |
| `src/ui/menu.ts` | 4106 | 81 | ui | 2 | 4 | MANTER |
| `src/ui/options.ts` | 13964 | 235 | ui | 3 | 2 | DIVIDIR |
| `src/ui/panelParts.ts` | 605 | 15 | ui | 2 | 1 | MANTER |
| `src/ui/peoplePanel.ts` | 6294 | 104 | ui | 1 | 6 | MOVER |
| `src/ui/readouts.ts` | 940 | 18 | ui | 3 | 0 | DIVIDIR |
| `src/ui/roadCatalog.ts` | 60976 | 1001 | ui | 3 | 5 | DIVIDIR |
| `src/ui/roadKeysPanel.ts` | 4620 | 106 | ui | 2 | 3 | JUNTAR |
| `src/ui/shell.css` | 49724 | 0 | ui | 1 | 0 | MANTER |
| `src/ui/touch.ts` | 2563 | 57 | ui | 1 | 0 | MANTER |
| `src/ui/transitNames.ts` | 652 | 10 | ui | 2 | 0 | MOVER |
| `src/world/arch.ts` | 8680 | 143 | world | 22 | 4 | DIVIDIR |
| `src/world/archData.ts` | 6354 | 85 | world | 2 | 0 | MOVER |
| `src/world/brush.ts` | 11718 | 231 | world | 5 | 6 | MOVER |
| `src/world/catalog.ts` | 755 | 19 | world | 7 | 2 | JUNTAR |
| `src/world/catalogData.json` | 88876 | 0 | world | 1 | 0 | MANTER |
| `src/world/catalogFacade.ts` | 6024 | 96 | world | 3 | 2 | MOVER |
| `src/world/catalogFormat.ts` | 8606 | 128 | world | 1 | 0 | JUNTAR |
| `src/world/decay.ts` | 2969 | 77 | world | 5 | 0 | MOVER |
| `src/world/design.ts` | 7950 | 108 | world | 13 | 0 | MOVER |
| `src/world/ground.ts` | 13138 | 252 | world | 20 | 4 | DIVIDIR |
| `src/world/growth.ts` | 14526 | 321 | world | 6 | 11 | MOVER |
| `src/world/heights.ts` | 3734 | 78 | world | 44 | 2 | MANTER |
| `src/world/items.ts` | 9955 | 214 | world | 14 | 4 | MANTER |
| `src/world/lotEdit.ts` | 28734 | 542 | world | 10 | 9 | DIVIDIR |
| `src/world/lotPlan.ts` | 10085 | 166 | world | 1 | 2 | JUNTAR |
| `src/world/roofPlant.ts` | 7096 | 130 | world | 2 | 0 | MOVER |
| `src/world/transit.ts` | 7138 | 171 | world | 8 | 1 | DIVIDIR |
| `src/world/world.ts` | 19406 | 420 | world | 68 | 12 | DIVIDIR |
| `test/blockLots.test.ts` | 2307 | 38 | test | 0 | 5 | MANTER |
| `test/building40.test.ts` | 7394 | 130 | test | 0 | 8 | MANTER |
| `test/buildingDefects.test.ts` | 48938 | 761 | test | 0 | 19 | DIVIDIR |
| `test/buildingDesign.test.ts` | 3825 | 72 | test | 0 | 10 | RENOMEAR |
| `test/buildingFinishes.test.ts` | 4995 | 80 | test | 0 | 6 | RENOMEAR |
| `test/buildingLook.test.ts` | 17475 | 279 | test | 0 | 8 | RENOMEAR |
| `test/buildings.test.ts` | 1904 | 41 | test | 0 | 5 | RENOMEAR |
| `test/bulbsRoundabouts.test.ts` | 3189 | 65 | test | 0 | 3 | MANTER |
| `test/citygen.test.ts` | 2581 | 50 | test | 0 | 4 | RENOMEAR |
| `test/citySpurs.test.ts` | 1107 | 21 | test | 0 | 1 | MANTER |
| `test/cityStyles.test.ts` | 1937 | 42 | test | 0 | 2 | RENOMEAR |
| `test/core.test.ts` | 2861 | 84 | test | 0 | 4 | RENOMEAR |
| `test/decay.test.ts` | 3063 | 68 | test | 0 | 3 | RENOMEAR |
| `test/defects.test.ts` | 10421 | 195 | test | 0 | 11 | RENOMEAR |
| `test/economy.test.ts` | 3668 | 87 | test | 0 | 5 | RENOMEAR |
| `test/gradeLine.test.ts` | 2812 | 56 | test | 0 | 1 | MANTER |
| `test/growth.test.ts` | 5272 | 109 | test | 0 | 9 | RENOMEAR |
| `test/i18n.test.ts` | 637 | 14 | test | 0 | 1 | MANTER |
| `test/impossible.test.ts` | 1105 | 24 | test | 0 | 1 | RENOMEAR |
| `test/inspectorRoad.test.ts` | 3163 | 67 | test | 0 | 4 | MANTER |
| `test/interface.test.ts` | 10555 | 173 | test | 0 | 9 | DIVIDIR |
| `test/junctionCorners.test.ts` | 3230 | 55 | test | 0 | 3 | MANTER |
| `test/kerbs.test.ts` | 6648 | 107 | test | 0 | 4 | MANTER |
| `test/lotEditsShared.test.ts` | 2991 | 65 | test | 0 | 3 | MANTER |
| `test/lotPlan.test.ts` | 2505 | 44 | test | 0 | 3 | MANTER |
| `test/lots.test.ts` | 5901 | 133 | test | 0 | 6 | RENOMEAR |
| `test/lotsShortSide.test.ts` | 1631 | 25 | test | 0 | 4 | MANTER |
| `test/manoeuvres.test.ts` | 5425 | 101 | test | 0 | 8 | RENOMEAR |
| `test/mapExtra.test.ts` | 1560 | 34 | test | 0 | 1 | MANTER |
| `test/markings.test.ts` | 2260 | 43 | test | 0 | 1 | MANTER |
| `test/people-creator.test.ts` | 2568 | 56 | test | 0 | 3 | RENOMEAR |
| `test/people.test.ts` | 1732 | 32 | test | 0 | 2 | MANTER |
| `test/polygonLots.test.ts` | 7536 | 145 | test | 0 | 5 | RENOMEAR |
| `test/profileChecks.test.ts` | 1933 | 28 | test | 0 | 1 | MANTER |
| `test/profileEditor.test.ts` | 3102 | 56 | test | 0 | 2 | MANTER |
| `test/profileLimit.test.ts` | 2451 | 48 | test | 0 | 4 | MANTER |
| `test/props.test.ts` | 2624 | 52 | test | 0 | 6 | RENOMEAR |
| `test/reedsShepp.test.ts` | 2147 | 46 | test | 0 | 1 | RENOMEAR |
| `test/render-defects.test.ts` | 61276 | 973 | test | 0 | 25 | DIVIDIR |
| `test/render-terrain.test.ts` | 10263 | 163 | test | 0 | 9 | MANTER |
| `test/repair.test.ts` | 1546 | 33 | test | 0 | 2 | JUNTAR |
| `test/roadContinuity.test.ts` | 3444 | 65 | test | 0 | 5 | MANTER |
| `test/roadDefects.test.ts` | 59637 | 1031 | test | 0 | 26 | DIVIDIR |
| `test/roadEdits.test.ts` | 3538 | 90 | test | 0 | 3 | RENOMEAR |
| `test/roadGround.test.ts` | 3108 | 57 | test | 0 | 5 | MANTER |
| `test/roads.test.ts` | 12609 | 275 | test | 0 | 10 | DIVIDIR |
| `test/roadVariant.test.ts` | 3151 | 54 | test | 0 | 2 | MANTER |
| `test/save.test.ts` | 1039 | 22 | test | 0 | 2 | JUNTAR |
| `test/saving.test.ts` | 16527 | 264 | test | 0 | 6 | DIVIDIR |
| `test/simCity.ts` | 3211 | 74 | test | 3 | 5 | MOVER |
| `test/simDefects.test.ts` | 59483 | 1032 | test | 0 | 12 | DIVIDIR |
| `test/simMotion.test.ts` | 17579 | 300 | test | 0 | 3 | MANTER |
| `test/simPort.test.ts` | 9862 | 174 | test | 0 | 4 | MANTER |
| `test/simWorker.test.ts` | 10419 | 176 | test | 0 | 7 | DIVIDIR |
| `test/streetNames.test.ts` | 4195 | 90 | test | 0 | 6 | RENOMEAR |
| `test/structures.test.ts` | 1662 | 25 | test | 0 | 1 | MANTER |
| `test/terrain-gen.test.ts` | 6908 | 125 | test | 0 | 5 | RENOMEAR |
| `test/terrainSeams.test.ts` | 7055 | 115 | test | 0 | 8 | MANTER |
| `test/texts.test.ts` | 4048 | 56 | test | 0 | 0 | MANTER |
| `test/traffic.test.ts` | 24691 | 515 | test | 0 | 10 | RENOMEAR |
| `test/transit.test.ts` | 4783 | 98 | test | 0 | 8 | RENOMEAR |
| `test/world.test.ts` | 7734 | 164 | test | 0 | 13 | DIVIDIR |
| `tools/arch-audit.mjs` | 12928 | 230 | tools | 0 | 0 | MANTER |
| `tools/arch-baseline.json` | 7022 | 355 | tools | 0 | 0 | MANTER |
| `tools/budget.json` | 1147 | 63 | tools | 0 | 0 | MANTER |
| `tools/budget.mjs` | 5443 | 103 | tools | 0 | 0 | MANTER |
| `tools/check-interface.mjs` | 66555 | 877 | tools | 0 | 0 | DIVIDIR |
| `tools/check-reload-keys.mjs` | 6766 | 98 | tools | 0 | 0 | JUNTAR |
| `tools/check-render.mjs` | 13124 | 237 | tools | 0 | 0 | MOVER |
| `tools/check-save.mjs` | 46000 | 683 | tools | 0 | 0 | DIVIDIR |
| `tools/check-sim.mjs` | 24274 | 376 | tools | 0 | 0 | MOVER |
| `tools/check-user-data.mjs` | 3287 | 55 | tools | 0 | 0 | MOVER |
| `tools/check-vias.mjs` | 17796 | 260 | tools | 0 | 0 | MANTER |
| `tools/cook-people-decode.cjs` | 2170 | 42 | tools | 0 | 0 | MOVER |
| `tools/cook-people.mjs` | 54532 | 914 | tools | 1 | 0 | DIVIDIR |
| `tools/foto-seguir.mjs` | 1046 | 19 | tools | 0 | 0 | JUNTAR |
| `tools/fotos-carro.mjs` | 1680 | 28 | tools | 0 | 0 | JUNTAR |
| `tools/fotos-carros-qa.mjs` | 2043 | 32 | tools | 0 | 0 | JUNTAR |
| `tools/fotos-interface.mjs` | 9884 | 76 | tools | 0 | 0 | MOVER |
| `tools/fotos-onibus-curva.mjs` | 1812 | 32 | tools | 0 | 0 | JUNTAR |
| `tools/fotos-onibus-qa.mjs` | 3078 | 69 | tools | 0 | 0 | JUNTAR |
| `tools/fotos-pacote.mjs` | 7025 | 99 | tools | 0 | 0 | DIVIDIR |
| `tools/fotos-pessoas-qa.mjs` | 1869 | 29 | tools | 0 | 0 | JUNTAR |
| `tools/fotos-survey.mjs` | 2533 | 38 | tools | 0 | 0 | JUNTAR |
| `tools/fotos-testemunho.mjs` | 1892 | 31 | tools | 0 | 0 | JUNTAR |
| `tools/fotos.mjs` | 1735 | 34 | tools | 0 | 0 | MANTER |
| `tools/make-icon.mjs` | 4884 | 89 | tools | 0 | 0 | MOVER |
| `tools/move-modules.mjs` | 2029 | 35 | tools | 0 | 0 | APAGAR |
| `tools/package-web.mjs` | 3671 | 63 | tools | 0 | 0 | JUNTAR |
| `tools/package.mjs` | 4061 | 70 | tools | 0 | 0 | JUNTAR |
| `tools/quick-check.mjs` | 1171 | 22 | tools | 0 | 0 | MANTER |
| `tools/serve.mjs` | 3661 | 64 | tools | 0 | 0 | MANTER |
| `tools/shadercheck/check.mjs` | 1320 | 29 | tools | 0 | 0 | MANTER |
| `tools/shadercheck/mats.mjs` | 3295 | 63 | tools | 0 | 7 | MANTER |
| `tools/shot.mjs` | 1780 | 33 | tools | 0 | 0 | MANTER |
| `tools/shot.sh` | 657 | 8 | tools | 0 | 0 | APAGAR |
| `tools/simdefect-sweep.sh` | 510 | 13 | tools | 0 | 0 | APAGAR |
| `tools/test-sweep.sh` | 399 | 14 | tools | 0 | 0 | APAGAR |
| `tools/textos.mjs` | 4696 | 54 | tools | 0 | 0 | RENOMEAR |
| `tools/verificar.mjs` | 2476 | 38 | tools | 0 | 0 | MANTER |
| `tsconfig.json` | 590 | 28 | tsconfig.json | 0 | 0 | MANTER |
| `tunel/ANALISE.md` | 4923 | 63 | tunel | 0 | 0 | MOVER |
| `vite.config.ts` | 1002 | 27 | vite.config.ts | 0 | 0 | MANTER |

## 3. Achados por arquivo

Cada seção: veredito e destino (coordenador); evidência e regra (coordenador; "conferido" = linha reaberta pelo coordenador); responsabilidades com faixa de linhas e achados do leitor (a-l, etiquetas do formato do leitor: [OBJ] objeto por entidade, [ALLOC] alocação em caminho quente, [OMAP] trabalho O(mapa), [MAIN] trabalho pesado na thread principal, [DEV] código só de desenvolvimento, [TEXT] acoplamento por texto, [DUP] duplicação, [HOST] host/estado em dois lugares, [MIX] responsabilidades misturadas, [DEAD] código morto, [SMALL] arquivo pequeno, [NAME] nome, [LAYER] camada, [BUG] defeito provável, [R40COPY] origem no 4.0); exports nunca importados (b).

### 3.1 Código, testes, ferramentas, scripts, electron e configuração (lidos inteiros)

#### `.gitignore`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Ignora node_modules, dist, out, logs, build, test-results; reports/ (sem rastreio no worktree) não está nele.
- **Responsabilidades (a-l):** L1–6 ignores node_modules, dist, out, logs, build, test-results
- **Superfície pública:** n/a

#### `.npmrc`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Registro do npm.
- **Responsabilidades (a-l):** L1 registry set to registry.yarnpkg.com
- **Achados do leitor (a-l):**
  - [SMALL] .npmrc:1 — mirror registry (CLAUDE.md says the npm registry is blocked on this machine; this is the workaround).
- **Superfície pública:** n/a

#### `data/lots-roadcraft/pack.mjs`

- **Veredito: MOVER** → tools/pack-lot-catalog.mjs
- **Evidência e regra (coordenador):** Lido inteiro: empacotador dos 38 projetos de lote do 4.0 em src/world/catalogData.json (ferramenta de build, não dado).
- **Responsabilidades (a-c):** lido inteiro pelo coordenador; ver evidência acima.

#### `data/textos-roadcraft/en.ts`

- **Veredito: JUNTAR** → src/shared/i18n/lang/engine.en.ts (um dicionário por idioma, só com as chaves usadas)
- **Evidência e regra (coordenador):** Dicionário do 4.0 trazido inteiro (1.730 chaves) e usado como base por src/shared/i18n/index.ts:7–8; 781 chaves não aparecem em src (busca de texto); roadKeys.heightUp/Down existem nos dois sistemas com valores diferentes (1 m aqui, 4 m em engine.*); 55 chaves do engine repetem o texto de uma chave daqui.
- **Responsabilidades (a-l):** `L1` type import of `Dictionary` from `./index`; `L4–1771` one flat `EN` record, 1730 keys, grouped by comment headers: zoning/lots L5–59, roundabout/section L60–83, shell/camera/help/gfx L84–224, tools/streetscape/poles L226–283, sim L285–295, palette/road classes L297–339, terrain/elements/weather/trees/gullies/clouds/fog/paint/landforms L341–488, inspector/junction/control L490–623, hints/rules/catalog/profile editor/connectors/economy L625–844, minimap (empty) L847, statusbar/health/gestures L849–930, quality L932–937, buildings/creator L939–1009, Builder workspace L1011–1737, transit L1738–1769, `map.loading` L1770.
- **Achados do leitor (a-l):**
  - `[DUP]` data/textos-roadcraft/en.ts:1 — this is a SECOND dictionary system. `src/shared/i18n/index.ts:7-8,19-22` merges it as `{ ...RC_EN, ...ENGINE_EN }`. CLAUDE.md says player text lives only in `src/shared/i18n/lang/engine.en.ts`/`engine.pt-BR.ts`; this file (outside `src/` and outside any layer) holds 1730 keys vs 533 in engine.en.ts.
  - `[DEAD]` en.ts:1 — `Dictionary` comes from `data/textos-roadcraft/index.ts` (141 lines), which carries a whole parallel i18n runtime (`detect()`, `t()`, `LANGUAGES`, listeners, same storage key `roadcraft.language`, EN fallback). Only `src/shared/i18n/index.ts`, `test/texts.test.ts` and `tools/textos.mjs` reference `data/textos-roadcraft`, and only the `en.ts`/`pt-BR.ts` files; nothing imports `index.ts` at runtime (grep). Fallback rules also differ: shared t() falls back to pt-BR (`src/shared/i18n/index.ts:59`), data/index t() falls back to EN.
  - `[DUP]` keys present in BOTH systems: 2 — `roadKeys.heightUp` (en.ts:650 'Raise the road 1 m') and `roadKeys.heightDown` (en.ts:651) are overridden by engine.en.ts:538-539 ('… 4 m'). The data values are dead and contradict the engine's.
  - `[BUG]` en.ts:799-800 `hint.road.curve` / `hint.road.free` say "height ±1 m" while the engine override says the key step is 4 m (engine.en.ts:538) — player is told two different step sizes (text-level inconsistency; which one the code uses not verified here).
  - `[DUP]` same meaning under different keys across systems: 55 engine.en keys have exactly the EN value of a data key, e.g. `ui.cat.roads`=`v2.dock.roads` "Roads", `ui.floors.one/other`=`building.floors.one/other`, `ui.cat.demolish`=`inspector.demolish`/`v2.dock.demolish`, `ui.about.title`=`about.title`, `zone.name.1..3`=`zone.residential/commercial/industrial`, `ui.cat.transit`=`tool.transit`. Also `hint.transit` (en.ts:828) vs engine `game.hint.transit` (engine.en.ts:370, the one used at src/app/tools.ts:70).
  - `[DEAD]` usage heuristic over src/ (+index.html), dictionaries excluded: 598 keys appear as a quoted literal (or plural base), 351 more have their family prefix quoted (possible dynamic build), **781 keys have no trace at all**. Biggest families with no trace: `hint.builder.*` 189, `builder.tool.*` 172, `builder.lot.*` 38, `builder.section.*` 28, `hint.terrain.*` 17, `builder.flagColour.*` 16, `builder.flagPattern.*` 14, `building.finish.*` 13, `building.problem.*` 12, `hint.lot.*` 10, `builder.help.*`/`builder.snap.*` 10 each, `health.system.*` 9, `creator.pattern.*` 9, all 22 `gesture.*`, `app.title/region/canvas` L85-87, `confirm.newMap/newWorld/clearTerrain` L222-224. (Heuristic: a key built from variables without its prefix quoted would be missed.)
  - `[R40COPY]` en.ts:4-1771 — the file is Roadcraft 4.0's dictionary carried whole (header comment of src/shared/i18n/index.ts:1 "keyed like Roadcraft's (data/textos-roadcraft)"; `v2.*` namespace = 4.0's "v2" shell, L27,33,1215-1301); explains the ~780 untraced keys (the 4.0 Builder workspace L1011-1737 alone is ~720 lines).
  - `[TEXT]` numbers duplicated in prose instead of placeholders/constants: 25° (L524, L629), 32–128 m roundabout radius (L62), 12.8 m U-turn (L553), 1.20 m clear walk (L202), 24 clouds (L435), 0.5 m junction step (L583-584), 10 km × 10 km (L91, L224), 30 s health window (L884-886), key lists `'1 Z H T O B I'` (L1265), `'1 – 6'` (L1264), `R`, `PageUp`, `Ctrl+…` in many hints. Each must stay in sync with code by hand.
  - `[TEXT]` en.ts:897-898 `health.msg.webglLost/webglRestored` speak of a WebGL context; the renderer is WebGPU (CLAUDE.md goal) — stale wording (inference: maybe meant for the WebGL2 fallback backend).
  - `[DEAD]` en.ts:847 empty "minimap" section header with no keys.
  - `[DUP]` 142 EN values shared by several keys in this file, e.g. the 8 identical `hint.builder.prim*` (L1388-1395), `hint.builder.turnBlockLeft/Right` (L1442-1443), `hint.builder.offset`=`pushpull` (L1612-1613), `hint.builder.draw.new`=`sketch` (L1603,1607).
  - `[NAME]` en.ts:1011 header comment "builder The Builder Workspace" garbled; en.ts:1335 "put down: tv" lowercase (generated-looking template text).
- **Superfície pública:** `EN` — English dictionary, merged under the engine's in `src/shared/i18n/index.ts`.

#### `data/textos-roadcraft/index.ts`

- **Veredito: APAGAR** → —
- **Evidência e regra (coordenador):** Lido inteiro: segundo sistema de i18n completo (t, plural, setLanguage, applyTranslations, chave roadcraft.language, recai no inglês) que nenhum arquivo importa (inventário: fan-in 0); src/shared/i18n/index.ts importa só en.ts e pt-BR.ts.
- **Responsabilidades (a-c):** lido inteiro pelo coordenador; ver evidência acima.

#### `data/textos-roadcraft/pt-BR.ts`

- **Veredito: JUNTAR** → src/shared/i18n/lang/engine.pt-BR.ts
- **Evidência e regra (coordenador):** O mesmo de en.ts: 1.730 chaves, 781 sem uso; as dicas hint.road.curve e hint.road.free dizem 'altura ±1 m' (L792–793, conferido) enquanto a tecla sobe 4 m (game.ts:1117–1118).
- **Responsabilidades (a-l):** `L1` type import; `L4–1761` flat `PT_BR` record, 1730 keys, same order and grouping as en.ts (section header comments mostly dropped).
- **Achados do leitor (a-l):**
  - `[DUP]` pt-BR.ts:643-644 `roadKeys.heightUp/Down` 'Subir/Descer a via 1 m' shadowed by engine.pt-BR.ts:538-539 '… 4 m' (same 2 overlap keys as EN; overlap total = 2).
  - `[BUG]` pt-BR.ts:792-793 "altura ±1 m" vs engine '4 m' — same contradiction as en.ts:799-800.
  - `[TEXT]` pt-BR.ts:788 `economy.money` 'R$ {value}' vs en.ts:795 '$ {value}' — the currency symbol changes with the interface language for the same game money (inference: intended localisation, but the unit is not a translation).
  - `[NAME]` non-English comments in a source file (CLAUDE.md: comments in English): pt-BR.ts:929 `// edifícios`, pt-BR.ts:1227 `// Nomes curtos das linhas de opções…`, pt-BR.ts:1267 `// Uma palavra ao lado da barra…`.
  - `[TEXT]` untranslated English in Portuguese strings: pt-BR.ts:1016 "Builder", pt-BR.ts:1601 "handle".
  - 49 keys have the same value in both languages; all checked by eye are legitimate (proper names, key caps, units: e.g. `paint.kind.cerrado`, `help.key.esc`, `v2.key.tools`, `catalog.meta`, `build.stamp`).
  - `[DEAD]`/`[R40COPY]` same 781 untraced keys as en.ts (mirrored).
- **Superfície pública:** `PT_BR` — Brazilian Portuguese dictionary, merged under `ENGINE_PT`.

#### `electron/files.mjs`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Arquivos do save no desktop.
- **Responsabilidades (a-l):** L8–12 name validation; L17–24 rename with retry on Windows busy errors; L29–81 file store (read/write atomic tmp+fsync+rename, list, remove, folders, removeFolder)
- **Achados do leitor (a-l):**
  - files.mjs:68 — `list` stats files one by one sequentially (await in loop); fine for save folders of ~hundreds of tiles.
- **Superfície pública:** `fileStore(root)` — save-file store used by main.mjs IPC.

#### `electron/main.mjs`

- **Veredito: DIVIDIR** → electron/main.mjs (janela, protocolo, menu) + electron/shotHarness.mjs (laço de captura, CIDADE_SEQ, diferença de pixels, test:key)
- **Evidência e regra (coordenador):** O laço de fotos e a diferença de pixels moram no processo principal do jogo (L113–155); IPC test:key só em execução de foto (L170–190); variáveis CIDADE_* e host app://cidade em português.
- **Responsabilidades (a-l):** L18–41 Chromium switches (Linux WebGPU, shot, novsync, software); L43–57 single instance + per-run userData for shots; L59–67 app:// scheme + COOP/COEP; L69–156 window creation, keys, close-saves handshake, screenshot/sequence/diff harness; L158–166 Steam + file IPC + quit; L170–190 test-only key press IPC; L192–209 protocol handler serving dist/; L211–212 lifecycle
- **Achados do leitor (a-l):**
  - [MIX] main.mjs:113–155 — the photo/diff test harness (capture loop, CIDADE_SEQ, pixel diff L136–150) lives in the product shell next to window creation.
  - [DEV] main.mjs:170–190 — `test:key` IPC (menu accelerator matching) registered only when CIDADE_SHOT; test-only code shipped in the product entry.
  - [TEXT] main.mjs:119–120 — readiness polled through `window.__cidade?.status` with Portuguese status strings 'carregando'/'pronto'/'falhou' shared with the page.
  - [NAME] main.mjs:14–16,29,34,48 — env vars `CIDADE_*` (Portuguese) and protocol host `app://cidade` (L82).
  - [MAIN] main.mjs:140–146 — per-pixel diff in JS in the Electron main process (tooling only, shot runs).
- **Superfície pública:** none (Electron entry).

#### `electron/preload.cjs`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Ponte da página; testKey exposto a toda página (L12–13); globais 'cidadeSteam' e 'roadcraftApp' com dois esquemas de nome.
- **Responsabilidades (a-l):** L3–6 Steam bridge; L8–23 app bridge (closing handshake, quit, testKey, files IPC)
- **Achados do leitor (a-l):**
  - [DEV] preload.cjs:12–13 — `testKey` exposed to every page, although its handler exists only in shot runs (main.mjs:170); in normal play the invoke just rejects.
  - [NAME] preload.cjs:3 — global `cidadeSteam` (Portuguese) next to `roadcraftApp` (L8): two naming schemes.
- **Superfície pública:** `window.cidadeSteam{info,unlock}`, `window.roadcraftApp{onClosing,canClose,quit,testKey,files}`.

#### `electron/steam.mjs`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Steam no processo principal.
- **Responsabilidades (a-l):** L12–28 init steamworks.js (appId file or 480); L31–33 overlay; L35–38 player name; L40–43 achievement unlock
- **Superfície pública:** `initSteam`, `enableOverlay`, `steamInfo`, `unlock`.

#### `index.html`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Página de entrada.
- **Responsabilidades (a-l):** L1–17 page shell: canvas#view, #hud, #loading, module entry src/main.ts
- **Achados do leitor (a-l):**
  - index.html:12 — `aria-describedby="v2Hint"` refers to an id not in this file (inference: created by the HUD later). index.html:2 — `lang="pt-BR"` fixed while the UI is localized (en/pt-BR).
- **Superfície pública:** n/a

#### `jogar.bat`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Atalho do jogador no Windows.
- **Responsabilidades (a-l):** L1–11 Windows launcher: checks node, runs tools/serve.mjs --abrir
- **Achados do leitor (a-l):**
  - [NAME] jogar.bat — file name, comment (L2) and flag `--abrir` in Portuguese (CLAUDE.md: everything but player text in English; the echo lines are player-facing).
- **Superfície pública:** n/a

#### `jogar.sh`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Atalho no Linux.
- **Responsabilidades (a-l):** L1–8 POSIX launcher, same as jogar.bat
- **Achados do leitor (a-l):**
  - [NAME] jogar.sh — Portuguese name/comment/flag. [DUP] same logic as jogar.bat.
- **Superfície pública:** n/a

#### `package.json`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Configuração; `shaders` usa prefixo POSIX `WHICH=glsl` que não roda no cmd do Windows (L16) e `shot` aponta para tools/shot.sh (L18); descrição e nomes de script em português.
- **Responsabilidades (a-l):** L1–7 metadata; L8–28 scripts; L29–40 deps
- **Achados do leitor (a-l):**
  - [BUG] package.json:16 — `shaders` uses `WHICH=glsl node ...` (POSIX env prefix), fails under Windows cmd, the owner's platform.
  - [BUG] package.json:18 — `shot` runs `tools/shot.sh` (shell script) — not runnable from npm on Windows cmd (inference).
  - [NAME] package.json:5,22,26–27 — Portuguese description and script names (`fotos`, `fotos:pacote`, `fotos:navegador`).
  - package.json:15 — `npm test` = `node --test test/*.test.ts` (glob expanded by the shell; on Windows cmd node receives the literal pattern; inference: node ≥21 resolves globs itself).
- **Superfície pública:** n/a

#### `scripts/fotos/crescimento.js`

- **Veredito: JUNTAR** → tools/photos/scenes/ (um arquivo de cenas com nome em inglês)
- **Evidência e regra (coordenador):** Cena de foto de uma linha de script injetado; nove arquivos minúsculos do mesmo tipo.
- **Responsabilidades (a-l):** L3–13 photo script: road + zones, growth at 2/s for 7 s, prints building order, sets view
- **Achados do leitor (a-l):**
  - [NAME] crescimento.js — Portuguese file name, comments, output keys. [DEV] crescimento.js:6,9 — drives `g.growth.rate` directly (internal field). crescimento.js:10 — scans every building id (tooling only).
- **Superfície pública:** none (eval'd script).

#### `scripts/fotos/desgaste.js`

- **Veredito: JUNTAR** → tools/photos/scenes/
- **Evidência e regra (coordenador):** Cena de foto pequena.
- **Responsabilidades (a-l):** L2–12 decay photo: road, zones, grow, pass 25 days, renovate left half, select one
- **Achados do leitor (a-l):**
  - [NAME] Portuguese name/comments/keys. desgaste.js:10 — reads `w.decayChanges` (internal counter).
- **Superfície pública:** none

#### `scripts/fotos/economia.js`

- **Veredito: JUNTAR** → tools/photos/scenes/
- **Evidência e regra (coordenador):** Cena de foto pequena.
- **Responsabilidades (a-l):** L3–18 economy photo: ground vs bridge cost, demolish refund, refusal without money
- **Achados do leitor (a-l):**
  - [NAME] Portuguese. economia.js:12,15 — writes `w.money` directly (bypasses commands; test setup). [DUP] same scenario as scripts/verificacao/2-vias-cruzamentos-lotes-ceu.js:58–65.
- **Superfície pública:** none

#### `scripts/fotos/lote-poligono.js`

- **Veredito: JUNTAR** → tools/photos/scenes/
- **Evidência e regra (coordenador):** Cena de foto pequena.
- **Responsabilidades (a-l):** L3–24 polygon/split/curved lot photo; L6–14 outlines each lot with wall items
- **Achados do leitor (a-l):**
  - [NAME] Portuguese. lote-poligono.js:12 — adds items straight to `w.items.add` (no command), so the outline cannot be undone (test-only). lote-poligono.js:12 — item type 21 as a magic number [TEXT].
- **Superfície pública:** none

#### `scripts/fotos/manobras.js`

- **Veredito: JUNTAR** → tools/photos/scenes/
- **Evidência e regra (coordenador):** Cena de foto pequena.
- **Responsabilidades (a-l):** L4–27 manoeuvre photos: builds district once, polls `a.manoeuvres()` up to 120 s for a manoeuvre type, aims camera
- **Achados do leitor (a-l):**
  - [NAME] Portuguese. manobras.js:17 — `globalThis.MANOBRA` global as parameter [TEXT]; manoeuvre codes 1–4 magic.
- **Superfície pública:** none

#### `scripts/fotos/nos-impossiveis.js`

- **Veredito: JUNTAR** → tools/photos/scenes/
- **Evidência e regra (coordenador):** Cena de foto pequena.
- **Responsabilidades (a-l):** L3–9 counts impossible nodes, aims camera, toasts
- **Achados do leitor (a-l):**
  - [NAME] Portuguese; [TEXT] nos-impossiveis.js:7 — hard-coded Portuguese toast via `g.hud.toast` (not i18n; photo-only).
- **Superfície pública:** none

#### `scripts/fotos/quarentena.js`

- **Veredito: JUNTAR** → tools/photos/scenes/
- **Evidência e regra (coordenador):** Cena de foto pequena.
- **Responsabilidades (a-l):** L3–14 corrupts one tile in OPFS save, reloads, lists quarantine folders
- **Achados do leitor (a-l):**
  - [BUG] quarentena.js:8 — hard-coded `tile_0066.bin` assumes the 10 km map and slot `cidade-1`; on any other map size it corrupts a tile away from the scene (comment admits it). [NAME] Portuguese. quarentena.js:6 — uses OPFS directly, not the Electron file store (browser-only path).
- **Superfície pública:** none

#### `scripts/fotos/reparo.js`

- **Veredito: JUNTAR** → tools/photos/scenes/
- **Evidência e regra (coordenador):** Cena de foto pequena.
- **Responsabilidades (a-l):** L3–17 creates a dangling road end via raw `net.addNode/addSeg`, saves, loads, checks repair
- **Achados do leitor (a-l):**
  - [NAME] Portuguese. reparo.js:7–8 — bypasses commands on purpose to mimic an old save (intentional).
- **Superfície pública:** none

#### `scripts/fotos/transporte.js`

- **Veredito: JUNTAR** → tools/photos/scenes/
- **Evidência e regra (coordenador):** Cena de foto pequena.
- **Responsabilidades (a-l):** L4–25 rail crossing + bus line photo; polls signals SAB and crossings
- **Achados do leitor (a-l):**
  - [NAME] Portuguese. [TEXT] transporte.js:19 — reads bit 128 of `g.signalsSab` per node (layout of a shared buffer known by a script).
- **Superfície pública:** none

#### `scripts/lotes.ts`

- **Veredito: MOVER** → tools/probes/lots.ts
- **Evidência e regra (coordenador):** Sonda de linha de comando; carregamento da cidade no World igual a scripts/transito.ts:19–29 (L17–26).
- **Responsabilidades (a-l):** L6–8 args, worker-name map size; L10–26 load generated city into a World; L27–45 build lots per cell near centre, sum areas; L46–47 print coverage
- **Achados do leitor (a-l):**
  - [DUP] lotes.ts:17–26 — city-into-World loading identical to scripts/transito.ts:19–29.
  - lotes.ts:31 — `z0 = cellOriginX(j)` uses the X helper for Z (correct only because the grid is symmetric; there is no cellOriginZ).
  - [NAME] Portuguese comments/output.
- **Superfície pública:** none

#### `scripts/transito.ts`

- **Veredito: MOVER** → tools/probes/traffic.ts
- **Evidência e regra (coordenador):** Sonda de tráfego que troca métodos privados de Traffic por `as any` (L47, L82–100) e rededuz as causas de parada dos campos privados (L51–78).
- **Responsabilidades (a-l):** L7–17 args/imports; L18–44 build city, SimNet, Traffic, env options; L51–78 `cause()` stop-reason classifier; L80–100 monkey-patches Traffic internals for counters/experiments; L103–185 per-minute simulation loop + report
- **Achados do leitor (a-l):**
  - [DEV] transito.ts:47,82–89,95–100 — `tr as any`, replaces private methods (`reconsider`, `jamRelease`, `addMicro`, `mesoEnter`…) to switch off parts and count; diagnostic tightly coupled to Traffic internals.
  - [DUP] transito.ts:51–78 — re-derives Traffic's stop causes from its private fields (nextSeg, exitRoom, stageGreen, gateRules); drifts silently if Traffic changes.
  - transito.ts:137,161 — scans all segments × 16 lanes and all vehicles each simulated minute (tooling, whole-map OK here).
  - transito.ts:173 — region grid constants R=400 and centring recomputed here (duplicates Traffic's region layout; inference).
  - [NAME] Portuguese comments, env vars (RELOGIO, JANELA, FLUXO_X, SEM, QUENTE, CENTRO), output.
- **Superfície pública:** none

#### `scripts/verificacao/1-ferramentas-e-acoes.js`

- **Veredito: DIVIDIR** → tools/checks/verify/tools.mjs com verificações que medem o efeito; o arnês comum (L2–19) em tools/checks/verify/harness.mjs
- **Evidência e regra (coordenador):** 11 verificações devolvem true sem conferir o efeito (pintar chão, floresta, 9 relevos, rio, bioma, raio, seguir, noite e dia: L82–92, conferido); `btn` calculado e não usado (L42).
- **Responsabilidades (a-l):** L2–26 harness (error capture, check()); L28–51 every tool clicked; L53–65 roads; L67–74 zones/lots/creator; L76–92 transit, items, terrain, weather, camera; L94–124 people, pistol, bomb; L126–136 save/load/export/undo-all
- **Achados do leitor (a-l):**
  - [DEAD] 1-ferramentas-e-acoes.js:42 — `btn` computed with `.find((b) => b.onclick || true)` and never used: the "button" part of the check is not tested.
  - [BUG] 1-ferramentas-e-acoes.js:82–88,90–92 — checks return `true` unconditionally (paint, forest, terrain ×9, river, biome, strike, follow, night/day): pass unless the console errors; prove nothing about the result.
  - 1-ferramentas-e-acoes.js:61–63 — accepts `'recusado'` as pass.
  - [DUP] lines 2–19 harness copied in files 2 and 3.
  - [NAME] Portuguese file name/strings.
- **Superfície pública:** none

#### `scripts/verificacao/2-vias-cruzamentos-lotes-ceu.js`

- **Veredito: DIVIDIR** → tools/checks/verify/roadsLotsSky.mjs com verificações que medem o efeito
- **Evidência e regra (coordenador):** 7 verificações devolvem true sem conferir (L80–111); árvore conferida com `>=`, sempre verdadeiro (L98, conferido); painel achado por texto em português (L109).
- **Responsabilidades (a-l):** L2–32 harness; L34–65 drawing modes, bridge/tunnel/cut, profile, roundabout, furniture, rules, economy; L67–74 junction control; L76–81 sim/transit; L83–92 zones/lots/buildings/inside; L94–99 effects, walls, tree, flatten; L101–105 sky/weather; L107–114 panels, F9, autosave
- **Achados do leitor (a-l):**
  - [BUG] 2-vias…:98 — `items() >= n` is always true (tree check proves nothing).
  - [DEAD] 2-vias…:74 — `y0` read and unused; check accepts 'recusado' — node height not verified.
  - [BUG] 2-vias…:80,89,99,103,105,111 — return `true` unconditionally (terminal, lot front, flatten, weather, fog, grid/north/views).
  - [TEXT] 2-vias…:109 — panel detected by Portuguese text regex /Gráficos|Qualidade|Opções/ (fails under English UI).
  - [DUP] harness L2–19 = file 1.
- **Superfície pública:** none

#### `scripts/verificacao/3-inspetor-opcoes-detalhes.js`

- **Veredito: DIVIDIR** → tools/checks/verify/inspectorOptions.mjs com verificações que medem o efeito
- **Evidência e regra (coordenador):** 9 verificações devolvem true sem conferir (L32–47); 'idioma inglês' só confere que 'Câmera' (português) está na página e nunca troca o idioma (L46, conferido); `return true` inalcançável (L33).
- **Responsabilidades (a-l):** L2–26 harness; L27–29 setup; L31–47 eyedropper, catalog, section editor, inspector, parking, lane links, settings, lot corner, zones, poles, water, landscaping, language, new map
- **Achados do leitor (a-l):**
  - [BUG] 3-inspetor…:46 — "idioma inglês" (English language) only checks that Portuguese 'Câmera' is on the page; never switches to English.
  - [DEAD] 3-inspetor…:33 — unreachable `return true` after the return.
  - [BUG] 3-inspetor…:32,37–40,42,44,47 — unconditional `return true` checks.
  - [TEXT] 3-inspetor…:33,35 — finds controls by Portuguese text/aria-label (/Personalizar/, /à direita/).
- **Superfície pública:** none

#### `src/app/buildings.ts`

- **Veredito: JUNTAR** → src/features/buildings/selection.ts (com o estado de seleção que hoje fica em game.ts)
- **Evidência e regra (coordenador):** Seleção de prédio por host (game.ts:1497–1504); convenção style ≥ 128 = arquitetura escolhida repetida em lotEditing.ts (L33).
- **Responsabilidades (a-l):** L11–19 SelectionHost; L22–34 select a building, fill panel and creator; L37–43 selection circle
- **Achados do leitor (a-l):**
  - [TEXT] buildings.ts:33 — style ≥128 means "chosen architecture" (bit convention also in lotEditing.ts:105,209,318,331).
  - buildings.ts:27,32 — writes `creator.el.style.display` directly (same in tools.ts:74).
- **Superfície pública:** `SelectionHost`, `selectBuilding`, `showSelection`.

#### `src/app/clicks.ts`

- **Veredito: MANTER** → src/app/clicks.ts
- **Evidência e regra (coordenador):** Despacho de cliques por ferramenta; ROAD_TOOLS de ui/hud e Tool de ui/hudActions (L3, L7).
- **Responsabilidades (a-l):** L14–36 ClickHost; L39–61 click dispatch by tool
- **Achados do leitor (a-l):**
  - [TEXT] clicks.ts:40–60 — dispatch on tool name strings (Tool union, typed).
  - [LAYER] clicks.ts:3 — imports value `ROAD_TOOLS` from ui/hud while the Tool type comes from ui/hudActions (L7): app depends on two UI modules for one concept.
- **Superfície pública:** `ClickHost`, `clickTool`.

#### `src/app/featureActions.ts`

- **Veredito: JUNTAR** → src/features/buildings/actions.ts (contrato das ações de lote)
- **Evidência e regra (coordenador):** Contrato só de tipos (o script de alcance mostra: só importado como tipo) das ações de lote/transporte/vias; deve morar com cada recurso.
- **Responsabilidades (a-l):** L5–32 interface of gameplay actions exposed via hudActions; L35 subset for lot editing
- **Achados do leitor (a-l):**
  - [SMALL] types only (implemented by lotEditing.ts:235–258 and the transit tool). [MIX] featureActions.ts:6–31 — lot modes, decay, address, street names, paint style, line colour, impossible nodes in one bag.
- **Superfície pública:** `FeatureActions`, `LotFeatureActions`.

#### `src/app/input.ts`

- **Veredito: MANTER** → src/app/input.ts (InputHost reduzido quando o estado sair do Game)
- **Evidência e regra (coordenador):** Entrada de ponteiro e teclado; InputHost expõe ~60 campos do Game, muitos graváveis (L32–95); monta o comando relevo+rocha inline (L183–186), terceira cópia da combinação (game.ts:773–779, :1348–1355); toast 'Apagado.' fixo (L194–195).
- **Responsabilidades (a-l):** L32–95 InputHost (≈60 members); L97–146 pointerdown → drag mode per tool; L147–171 pointermove; L172–227 drag finish per mode (strokes, lots delete, free road, row, box demolish, node drops, click dispatch); L229–243 dblclick, cancel, wheel; L246–296 key table wiring
- **Achados do leitor (a-l):**
  - [HOST] input.ts:32–95 — InputHost exposes ~60 fields/methods of Game, many writable (`drag`, `stroke`, `lotStroke`, `cornerDrag`…): drag state lives in Game but is driven only here.
  - [TEXT] input.ts:194–195,185 — Portuguese hard-coded toast 'Apagado.' and command label 'relevo' (not i18n); refusal strings capitalised `r[0].toUpperCase() + r.slice(1) + '.'` — same idiom in lotEditing.ts:99,196,206,275 [DUP].
  - [MIX] input.ts:183–186 — builds a composite command (terrain + rock) inline in the input layer.
  - input.ts:7 — Tool types from ui/hud while clicks.ts uses ui/hudActions.
  - input.ts:114–128 — `new BrushStroke/GroundStroke/ElementStroke` per pointerdown (per stroke, not per frame; fine).
- **Superfície pública:** `InputHost`, `bindInput`.
- **Exports nunca importados (b):** `InputHost`

#### `src/app/lotEditing.ts`

- **Veredito: MOVER** → src/features/buildings/lotEditing.ts (dono do estado dos lotes que hoje mora em game.ts:195–206, 1602–1603)
- **Evidência e regra (coordenador):** Edição de lotes e prédios; o estado mora no Game e chega por 14 pares get/set (game.ts:323–349); mapPaint muda o estilo de pintura das vias dentro do módulo de lote (L253); registro do prédio novo montado duas vezes (L102–106, L209).
- **Responsabilidades (a-l):** L25–55 LotEditHost; L62–113 rectangle lot (geometry, hover, click); L115–134 lot modes/hints; L137–179 lot hover previews; L181–212 split/delete/front/join/poly; L214–233 corner drag; L235–258 feature actions (address, street name, map paint, impossible nodes); L261–278 split-by-line/curve; L281–292 renovate; L294–323 building pick/build on free lot; L326–341 edit floors/style/fn; L344–361 inside view; L364–378 creator design; L380–387 demolish selected
- **Achados do leitor (a-l):**
  - [MIX] lotEditing.ts:253 — `mapPaint` sets road paint style (render/roads setPaintStyle) and settings inside the lot module; L254–256 impossible road nodes; L344–361 inside view: unrelated to lot editing.
  - [BUG] (inference) lotEditing.ts:286–290,335–339,372–376 — closure commands keyed by building id guarded only by `alive[id]`; Table.alloc reuses freed ids (core/table.ts:61), so if the building is removed by a path outside this history (growth, bomb collapse) and the id is reused, undo/redo edits a different building.
  - [TEXT] lotEditing.ts:107,208,287,315,336,373,383 — Portuguese command labels ('lote desenhado', 'reformar prédio'…), not English identifiers.
  - [TEXT] lotEditing.ts:243 — decay /10 magic scale; L105,209,318,331 style 128+arch convention.
  - [DUP] lotEditing.ts:102–106 vs 209 — the same new-building record built twice (rect and poly).
  - [LAYER] lotEditing.ts:13–16 — value imports of render classes (`RoadPreview`, `CameraRig`, `InsideView`) used only as types.
- **Superfície pública:** `LotEditHost`, `LotEditing` (lotRect, hoverLot, clickLot, setLotMode, showLot, hoverLotTool, clickLotTool, finishPoly, grabCorner, dropCorner, featureActions, clickLotExtra, renovate, clickBuilding, editSelected, insideCmd, applyDesign, demolishSelected).
- **Exports nunca importados (b):** `LotEditHost`

#### `src/app/photoHooks.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Ganchos de foto (view, settle) usados pela API de automação.
- **Responsabilidades (a-l):** L6–15 camera placement for photo scripts; L22–31 wait for pool idle + steady frames; L34 limit
- **Achados do leitor (a-l):**
  - [DEV] photoHooks.ts — helpers only for photos/checks, in the app layer. photoHooks.ts:29 vs 34 — const used before its declaration line (works at runtime: called later). photoHooks.ts:11 — Float64Array per call (not hot).
- **Superfície pública:** `photoView`, `settlePool`.

#### `src/app/session.ts`

- **Veredito: MOVER** → src/features/save/session.ts
- **Evidência e regra (coordenador):** Fluxos de gravar/abrir/novo mapa por hosts; chave 'cidade.mapa' e parâmetro 'carregar' compartilhados com config.ts:21 (L27, L93).
- **Responsabilidades (a-l):** L26–29 reload with map size; L34–61 new map; L64–123 open save (generation fallback, quarantine, reports); L126–146 SaveHost; L155–223 save a generation (dirty tiles packed in workers, meta, commit)
- **Achados do leitor (a-l):**
  - session.ts:189–192 — per dirty tile, `gatherBoxes`, `saveTile`, `slice` of ground/water run on the main thread (copy proportional to dirty tiles, not map).
  - session.ts:197 — `JSON.stringify([...w.roads.junctions])` and all sign texts/street names serialised every save (grows with city; per save, not per frame).
  - [TEXT] session.ts:27,93 — `cidade.mapa` storage key and `carregar` URL flag shared with config.ts:21 and the start-up code.
  - session.ts:54 — new map marks every cell of every tile Terrain-dirty (one-shot full-map rebuild on new map).
- **Superfície pública:** `SaveWater`, `reloadWithMap`, `LoadReport`, `NewMapHost`, `newMapSession`, `LoadHost`, `loadSession`, `SaveHost`, `saveSession`.
- **Exports nunca importados (b):** `SaveWater`, `LoadReport`

#### `src/app/tools.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Troca de ferramenta; recebe zoneLayer, landformMode e lotMode copiados por valor pelo toolHost (game.ts:1244).
- **Responsabilidades (a-l):** L20–43 ToolHost; L46–80 switching tool (cancel previous, hints, overlays, cursor); L83–89 sky hint
- **Achados do leitor (a-l):**
  - [NAME] tools.ts:78 — Portuguese `ferramenta ${tool}` written to the health panel context.
  - tools.ts:54–70 — chain of `if (tool === …) setHint` (a table would do; minor).
  - tools.ts:50 — writes render uniform `zoneOverlayU` from the app layer.
- **Superfície pública:** `ToolHost`, `setTool`, `skyHint`.

#### `src/config.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Constantes do mapa, fan-in 52; tamanho do mapa por 'mapa=' e chave 'cidade.mapa' em português (L17–30).
- **Responsabilidades (a-l):** L4–6 tile size, map sizes; L13–25 map size from URL/localStorage/worker name; L28–60 derived grid, height and save constants
- **Achados do leitor (a-l):**
  - [TEXT] config.ts:17,19,21,30 — map size passed by Portuguese tags `mapa=` (worker name, URL) and key `cidade.mapa`, also in session.ts:27 and scripts/*.ts:8.
  - config.ts:6 — 4 km size offered (test-only per comment).
- **Superfície pública:** `TILE_SIZE`, `MAP_SIZES`, `MAP_TILES`, `MAP_TAG`, `MAP_SIZE`, `MAP_HALF`, `PLATE_SIZE`, `CELL_SIZE`, `SUBCELL_SIZE`, `CELLS_PER_TILE`, `MAP_CELLS`, `MAP_SUBCELLS`, `MAP_PLATES`, `HEIGHT_*`, `TERRAIN_*`, `SEA_LEVEL`, `SAVE_VERSION`.

#### `src/core/commands.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Pilha de comandos com inverso, fan-in 26.
- **Responsabilidades (a-l):** L4–13 Command interface; L16 history byte budget; L18–103 CommandStack (run/push/merge groups, hold, undo/redo with error, clear)
- **Achados do leitor (a-l):**
  - commands.ts:49–51 — every push re-sums `bytes` over the whole history (≤500 entries) and `shift()` is O(n); bounded, not per frame.
- **Superfície pública:** `Command`, `HISTORY_BYTES`, `CommandStack`.
- **Exports nunca importados (b):** `HISTORY_BYTES`

#### `src/core/grid.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Índice espacial único, fan-in 41; cabeçalho diz 'chaves Morton' mas os ids são por linha (L2 × L46–47); ajudantes Morton sem uso (L28–33).
- **Responsabilidades (a-l):** L9–33 Morton encode/decode; L36–53 grid index helpers; L56–70 tile/cell mapping; L77–154 SpatialIndex (intrusive lists per subcell); L157–166 Dirty kinds; L169–193 DirtyReader; L200–258 DirtyCells
- **Achados do leitor (a-l):**
  - [NAME] grid.ts:2 — header says "Keys are Morton codes" but cell/tile ids are row-major (L46–47); Morton helpers L28–33 not used in this file (inference: possibly unused elsewhere).
  - [ALLOC] grid.ts:255 — `pending()` for reader kinds allocates via `map` + spread each call (if polled per frame).
  - grid.ts:64–70 — `cellsOfTile` allocates an array per call (used per save tile, per new map).
- **Superfície pública:** `morton`, `mortonX/Z`, `gridIndex`, `cellX`, `subcellX`, `tileX`, `cellId`, `tileId`, `CELL_COUNT`, `TILE_COUNT`, `SUBCELL_COUNT`, `cellOriginX`, `tileOriginX`, `tileOfCell`, `cellsOfTile`, `SpatialIndex`, `Dirty`, `DirtyKind`, `DirtyReader`, `DirtyCells`.

#### `src/core/rng.ts`

- **Veredito: MANTER** → src/core/rng.ts (recebe o Rng do r40)
- **Evidência e regra (coordenador):** Gerador do jogo, fan-in 24.
- **Responsabilidades (a-l):** L4–15 hashes; L18–31 mulberry32 Rng; L33–51 gradient noise; L53–62 fBm
- **Superfície pública:** `hash32`, `hash2`, `Rng`, `noise2`, `fbm`.
- **Exports nunca importados (b):** `hash32`, `noise2`

#### `src/core/table.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Tabelas SoA com free list, fan-in 13.
- **Responsabilidades (a-l):** L4–11 schema types; L13–111 SoA Table (alloc with free list, allocAt for undo, release, grow listeners, clear)
- **Achados do leitor (a-l):**
  - table.ts:59–62 — `alloc()` reuses freed ids by default; only `fresh` avoids it (see lotEditing id-reuse risk).
- **Superfície pública:** `Schema`, `Columns`, `Table`.

#### `src/features/demolition/blast/blast.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Explosão; importa render/tsl e render/particles (L8, L11).
- **Responsabilidades (a-l):** L16–19 debris colours; L27–224 Blast: ring shockwave, shake, lasting fires table, explode (bursts, shrapnel), crater (rim slabs, heaved plates), soot, update, clear, warm; L227–237 centre vehicle body; L243–260 carcass TSL material
- **Achados do leitor (a-l):**
  - blast.ts:101–102,138,144–145 — arrays/Color/Quaternion/Vector3 allocated per explosion and per plate (event path, not per frame).
  - [R40COPY] blast.ts:1–2,86,240 — port notes cite 4.0 render/blast.ts, playEffects.ts (values ported; code reimplemented).
  - [LAYER] blast.ts:8,11 — feature imports render/tsl and render/particles (Puff enum).
- **Superfície pública:** `Kind`, `BlastGround`, `Blast`.
- **Exports nunca importados (b):** `BlastGround`

#### `src/features/demolition/blast/debris.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Destroços; array alocado por malha a cada quadro com destroços ativos (L281).
- **Responsabilidades (a-l):** L10–18 limits/shapes; L21–46 PieceSpec (reusable input); L50–300 Debris: SoA rows, add/victim, stillNear, fixed-step rigid physics with ground contact, instanced draw, warm; L303–333 wreck, slab, shell geometries
- **Achados do leitor (a-l):**
  - [ALLOC] debris.ts:281 — `for (const a of [mesh.instanceMatrix, …])` allocates an array per mesh on every draw (every frame while a piece moves).
  - debris.ts:107–110 — `moving()` scans all pieces; called per frame by Blast.active and Blast.moving (bounded 1400).
  - debris.ts:263 — shapes over their batch capacity (WRECKS 48) are silently skipped while still simulated.
  - [R40COPY] debris.ts:2,129,180 — cites 4.0 stepPiece/COLORS.
- **Superfície pública:** `MAX_PIECES`, `Shape`, `PieceSpec`, `Debris`.
- **Exports nunca importados (b):** `MAX_PIECES`

#### `src/features/demolition/blast/marks.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Marcas de explosão; 30% de linhas iguais ao 4.0 (DECISIONS 2026-10-30: reescrever).
- **Responsabilidades (a-l):** L9–15 limits; L18–81 MarkBatch (ring buffer of ground grids, partial uploads); L83–108 Marks (road/earth craters, soot); L111–180 crater canvas texture; L183–201 soot texture
- **Achados do leitor (a-l):**
  - marks.ts:62 — array literal per `lay` (event path).
  - marks.ts:85–86 — two crater batches share name 'blast-craters' (3 draws when all visible).
  - [R40COPY] marks.ts:2,110,146,152 — 4.0 texture recipe noted.
- **Superfície pública:** `Marks`.

#### `src/features/demolition/blast/thrown.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Objetos arremessados; model === 5 = moto, índice mágico de render/vehicles (L98).
- **Responsabilidades (a-l):** L14–19 radial push; L25–85 item pieces by type (tree, bush, lamp, hydrant, misc); L88–90 which items are struck; L96–119 vehicle wreck + wheels
- **Achados do leitor (a-l):**
  - [TEXT] thrown.ts:98 — `model === 5` means motorbike (magic model index from render/vehicles).
  - thrown.ts:89 — "struck" set relies on Item enum ordering (`type <= Item.Sign`).
  - [R40COPY] thrown.ts:1,14,69 — 4.0 references (GEYSER_SECONDS 45).
- **Superfície pública:** `away`, `throwItem`, `struckItem`, `throwVehicle`.
- **Exports nunca importados (b):** `away`

#### `src/features/demolition/bomb.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Bomba; registro lido por índices numéricos rec[1..11] (L111–115); importa wallsHeightOf de jobs/buildingGen e ToSim de sim/worker (L14, L17).
- **Responsabilidades (a-l):** L19–55 ports (blast, ruins, throw, context); L61–90 ray-walk first building (8 m steps, index queries, slab test); L93–99 footprint distance; L105–118 building down → empty lot + rubble items command; L123–184 drop bomb (effects, strike buildings in reach, wrecks, items struck, soot, sim hit, toast)
- **Achados do leitor (a-l):**
  - [BUG] (inference) bomb.ts:183 with demolition.ts:45 — a strike that brings a building down synchronously fires `down()` (toast bombDown) and then dropBomb toasts bombDown again: two identical toasts.
  - [TEXT] bomb.ts:111,114–115 — `buildingRec` read by numeric indices rec[1..11]; command labels 'bomba', 'entulho' Portuguese (L107–108,117,162,173).
  - [LAYER] bomb.ts:14,17 — feature imports jobs/buildingGen value `wallsHeightOf` and sim/worker type `ToSim`.
  - bomb.ts:65 — Set per ray (event).
- **Superfície pública:** `BombBlast`, `BombRuins`, `BombThrow`, `BombContext`, `buildingDown`, `dropBomb`.
- **Exports nunca importados (b):** `BombBlast`, `BombRuins`, `BombThrow`, `BombContext`

#### `src/features/demolition/demolish.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Demolir por retângulo; idioma de comando combinado também em bomb.ts:117 e features/streetscape/itemTool.ts:27.
- **Responsabilidades (a-l):** L14–22 target under cursor; L28–46 remove items (sign rules too); L49–52 combine commands; L55–62 demolish target; L64–68 remove seg + orphan nodes; L71–87 demolish rectangle
- **Achados do leitor (a-l):**
  - [TEXT] demolish.ts:56–57,81,85–86 — Portuguese command labels.
  - [DUP] demolish.ts:49–52 — journal+items combined-command idiom also in bomb.ts:117.
- **Superfície pública:** `Target`, `targetAt`, `demolishTarget`, `demolishBox`.

#### `src/features/demolition/demolition.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Fachada da demolição; clear() existe mas game.ts openGeneration não o chama (defeito D1).
- **Responsabilidades (a-l):** L16–27 host; L29–77 Demolition entry: builds Blast + Ruins, bomb wiring, update, shake/active/moving, clear, warm
- **Superfície pública:** `DemolitionHost`, `Demolition`.
- **Exports nunca importados (b):** `DemolitionHost`

#### `src/features/demolition/ruin/fracture.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Fratura no worker; um objeto Tri por triângulo (L72–169, transitório); limite de 480 é estimativa por área (L55, L127).
- **Responsabilidades (a-l):** L14–39 RuinData/attached formats; L42–49 attach sink; L51–64 constants; L66–67 transfer list; L78–95 subdivide; L98–119 triangles of a MeshBuilder; L122–260 Voronoi fracture (cells, faces, wall backs, cut sides, reach/low, adjacency, attached → fragment); L263–311 packed vertex Writer
- **Achados do leitor (a-l):**
  - [OBJ] fracture.ts:72,103,116,169 — one JS object (`Tri` + Float64Array) per triangle and per subdivided triangle (worker, transient, up to 200 000 at L85).
  - fracture.ts:190,201 — string keys built per vertex/edge (`vkey`, `ek`) in Maps: heavy GC in the worker.
  - [BUG] (inference) fracture.ts:55,127 — MOST_FRAGMENTS 480 is only an area estimate; Voronoi cells over 3D surfaces can exceed it, and ruins.ts:164 then drops a ruin with more than SLOT (512) fragments silently (no error), so that building can never be broken.
  - fracture.ts:215–226 — every solid triangle gets a back face and every cut edge 2 triangles (thickness is visible after destruction).
  - [R40COPY] fracture.ts:1,51,56,59 — 4.0 fractureData values.
- **Superfície pública:** `RuinData`, `Attached`, `ATTACHED`, `ATTACH`, `gather`, `PART_GROUP`, `ruinTransfer`, `fractureBuilding`.
- **Exports nunca importados (b):** `ATTACHED`, `PART_GROUP`

#### `src/features/demolition/ruin/ruinMesh.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Malha das ruínas; 512 literal igual a MAX_FRAGMENTS/MAX_RUINS (L65); importa render/city, r40/api e jobs/building40 (L9–11).
- **Responsabilidades (a-l):** L15–19 limits; L24–27 TSL quaternion rotate; L29–157 RuinDraw: pose storage buffer, 32 shell meshes on building material with pose offsets, BatchedMesh of kit parts/furniture, show/hide, attached instances, partial upload, warm; L160–169 model normaliser
- **Achados do leitor (a-l):**
  - [DUP] ruinMesh.ts:65 — literal `512` per-ruin fragment base duplicates `MAX_FRAGMENTS / MAX_RUINS` (L16; ruins.ts:18 SLOT).
  - [LAYER] ruinMesh.ts:9–11 — feature imports render/city (material), r40/api (geometries) and jobs/building40 (`partBase`).
  - ruinMesh.ts:61–68 — 32 separate shell meshes (one draw per visible ruin).
  - ruinMesh.ts:86–92 — new BufferGeometry per ruin shown (event).
- **Superfície pública:** `MAX_RUINS`, `MAX_FRAGMENTS`, `RuinDraw`, `POSE_ROWS`.

#### `src/features/demolition/ruin/ruins.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Ruínas; uma ruína com mais fragmentos que SLOT é descartada sem registro (L164–167).
- **Responsabilidades (a-l):** L18–29 constants; L31–59 Ruin record and host; L61–93 tables + worker; L102–122 strike (claim slot, request ruin, queue blows); L125–156 clear/forget/claim/free; L159–190 ruin made (poses, attach, hide building by tag, waiting blows); L193–212 attached instances by fragment; L215–281 blow (target fragment, release, collapse); L284–305 unsupported fall (flood fill); L308–319 release; L322–360 per-frame flight; L363–375 attached follow; L378–383 empty record
- **Achados do leitor (a-l):**
  - ruins.ts:65,89,155,378–383 — one object per ruin (bounded 32), reallocated by `emptyRuin()` on every free/fail.
  - [BUG] (inference) ruins.ts:164–167 — fragmentCount > SLOT discards the ruin with no log (msg.error unset) and the queued blows are lost; the bomb reported 'pending'.
  - ruins.ts:109 — `gatherBoxes` of the building's whole cell on the main thread per first strike to find one box.
  - ruins.ts:103,129,160 — `findIndex` closures per strike/message (event).
  - ruins.ts:173 — `[0, 1, 3]` array per fragment in `made` (event path).
  - [R40COPY] ruins.ts:1–5,20–23 — 4.0 COLLAPSE_BELOW, strike formulas.
- **Superfície pública:** `Struck`, `RuinHost`, `Ruins` (moving, strike, clear, forget, update, draw).
- **Exports nunca importados (b):** `Struck`, `RuinHost`

#### `src/features/demolition/ruin/worker.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Worker da fratura.
- **Responsabilidades (a-l):** L8–9 message types; L13–29 worker: init heights SAB, build building for ruin, fracture, post with transfer
- **Superfície pública:** `ToRuinWorker`, `FromRuinWorker`.

#### `src/features/roads/roadTool.ts`

- **Veredito: DIVIDIR** → src/features/roads/roadTool.ts (desenhar) + src/features/demolition/bulldozeTool.ts (modo demolir)
- **Evidência e regra (coordenador):** O modo demolir (alvo, comando, toast de reembolso) mora na ferramenta de via (L133–146, L194–205); dicas e toasts em português fixo (L80–89, L202…L254) e dinheiro formatado à mão com pt-BR (L202, L252, L254) enquanto L178 usa money(); new Float64Array(2) a cada hover (L128) com rascunho p2 existente (L19).
- **Responsabilidades (a-l):** L21–59 tool state (mode, profile/base/options, elevation, ring radius, snap, furniture, cut walls, block grid, node move); L61–91 mode switch/cancel/hint text per mode; L101–179 hover preview for every mode (blocks, move, split, bulldoze, upgrade, roundabout, road/curve + live price); L182–189 eyedropper; L191–246 click per mode (bulldoze, blocks, split, upgrade, roundabout, road/curve continue-from-end); L249–256 commit/charge; L262–271 angle/grid snapping; L274–320 free-hand drawing (drag points → midpoint Béziers, one journal); L323–340 block-grid builder; L343–362 node move grab/drop; L365–387 profile/variant/elevation/ring setters.
- **Achados do leitor (a-l):**
  - [MIX] roadTool.ts:133–146,194–205 — the bulldoze mode (target preview for items/buildings, demolish command, refund toast) lives in the road tool although demolition has its own folder (`features/demolition/demolish.ts`); the file also owns block-grid generation (L323–340), free drawing (L274–320), node move and split: nine tools in one class.
  - [TEXT] roadTool.ts:80–89 — every hint is a hard-coded Portuguese literal, not `t()`; same for toasts L202, L210, L229, L237, L252, L254, L316, L336, L339, L360. Only L178 uses `t('road.preview.cost')`. Player text outside `engine.*.ts`.
  - [DUP] roadTool.ts:202,252,254 — money formatted by hand `R$ ${x.toLocaleString('pt-BR')}` while L178 uses `money()` from i18n; locale hard-coded.
  - [NAME] roadTool.ts:303,331,337 — journal labels in Portuguese ('construir via', 'quarteirões') — identifiers/labels must be English.
  - [TEXT] roadTool.ts:185 — `flags & 1` magic bit instead of a named `SegFlag` (other places use `SegFlag.Ring`).
  - [ALLOC] roadTool.ts:128 — `new Float64Array(2)` on every hover in split mode (pointer-move path) although module scratch `p2` exists (L19).
  - [ALLOC] roadTool.ts:171,264,270 — object spreads `{ ...a, ... }` and `planRoad` result per hover (pointer move); bounded, per pointer event.
  - [ALLOC] roadTool.ts:304–312 — free drawing builds tuple arrays (fine, per release).
  - (inference) [BUG] roadTool.ts:243 — after a successful segment the next start is snapped with radius 1.5 m; if `buildRoad` merged into an existing node farther than 1.5 m (snap radius `snapRadius()` ≥ 8 m) the next piece starts on a free point instead of the node. Not verified.
- **Superfície pública:** `RoadTool` (hover/click/pick/freeBegin/freeMove/freeEnd/grab/drop/setProfile/setOptions/setElevation/ringBy/segFlags/cancel/setMode/busy).

#### `src/features/sky/clouds.ts`

- **Veredito: MANTER** → src/features/sky/clouds.ts (+ a loja de nuvens hoje em render/cloudShadow.ts)
- **Evidência e regra (coordenador):** Dono das nuvens do jogador; cópia profunda da lista inteira duas vezes por edição (L83); tipo da ferramenta definido em ui/hudActions.ts (L9).
- **Responsabilidades (a-l):** L11–20 host interface; L22–37 cloud list + view + tool state + load; L40–52 click add/remove/edit; L55–64 drag grab/drop; L67–76 scatter around camera; L79 clear; L82–86 replace-list command (undo = previous list); L89–96 nearest cloud; L98 ground height.
- **Achados do leitor (a-l):**
  - [OBJ] clouds.ts:25 — one JS object per cloud (`Cloud[]`), bounded by `MAX_CLOUDS`; small but not SoA.
  - [ALLOC] clouds.ts:83 — every edit deep-copies the whole list twice (before/after snapshots); O(clouds) per edit, bounded by MAX_CLOUDS.
  - [LAYER] clouds.ts:9 — feature imports a type (`SkyToolState`) from `ui/hudActions.ts`; tool state shape is defined in the UI layer.
- **Superfície pública:** `CloudHost`, `Clouds` (list, grabbed, load, click, grab, drop, scatter, clear, view, tool).
- **Exports nunca importados (b):** `CloudHost`

#### `src/features/sky/weatherControl.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Controle do clima; chaves 'chuva'/'tempestade'/'limpo' compartilhadas com game.ts:532 e options.ts (L11); escreve windDirU global de render/weather.ts (L46).
- **Responsabilidades (a-l):** L10–12 preset name → fixed weather; L14–21 host interface; L23–51 manual weather set/reset, writes Weather fields and global wind-direction uniform; L51 option change.
- **Achados do leitor (a-l):**
  - [TEXT][NAME] weatherControl.ts:11 — preset keys are Portuguese strings ('chuva', 'tempestade', 'limpo'), matched as magic strings shared with URL params and the option (comment L2–3, L9 says persisted).
  - [HOST] weatherControl.ts:46 — writes the module-global uniform `windDirU` of `render/weather.ts` directly; wind direction state lives in a render global, not in the owner.
  - (inference) [BUG] weatherControl.ts:37–40 — returning to automatic weather resets windFixed/lightning/thunder but not `windDirU`; the last manual direction stays unless `render/weather.ts` rewrites it each frame (not visible here).
  - [LAYER] weatherControl.ts:7 — imports type `WeatherCtl` from `ui/hudActions.ts`.
  - magic coefficients L42–43 (0.6+0.4·rain, 0.85, 0.25, wind/20) without source.
- **Superfície pública:** `weatherPreset`, `WeatherHost`, `WeatherControl`.
- **Exports nunca importados (b):** `WeatherHost`

#### `src/features/streetscape/itemTool.ts`

- **Veredito: DIVIDIR** → src/features/streetscape/itemTool.ts (mobiliário e placas) + src/features/streetscape/barrierTool.ts (muros, fileiras) + src/features/streetscape/poleLineTool.ts + catálogos para i18n
- **Evidência e regra (coordenador):** Mobiliário, barreiras, linhas de postes, placas de regra e texto de rua numa ferramenta; catálogos com rótulos em português exportados (L31–45); placePoleLine muda mode/barrier/poleLights da ferramenta como efeito colateral (L217–218); both() igual a features/demolition/demolish.ts:49 (L27).
- **Responsabilidades (a-l):** L27–29 composite command helper; L31–45 player-facing catalogues (items, sign types, barrier kinds); L89–112 snap to sidewalk (curb or back); L114–124 hover preview; L126–189 click: shift-remove (with sign rule), place item/sign (+sign rule, sign text), barrier/pole-line runs; L192–196 row spacing table; L199–214 pole ground/water validation; L217–225 pole run API; L228–230 carriageway rejection; L233–246 rows; L249–253 row preview; L259–267 Backspace undo of last run.
- **Achados do leitor (a-l):**
  - [TEXT] itemTool.ts:31–45 — exported catalogues with Portuguese labels ('Árvore', 'Pare', 'Cerca'…) — player-facing text not in `engine.*.ts`.
  - [TEXT] itemTool.ts:84–85,150,200,202,244 — hard-coded Portuguese hints/toasts; only L143 uses `t()`.
  - [NAME] itemTool.ts:133,144,173,180,221,237 — command labels Portuguese ('remover item', 'pôr item', 'muro', 'fileira'…).
  - [TEXT] itemTool.ts:40,155 — sign kinds as bare numbers (4 = Stop, 2 = street sign) ; `this.sign === 2` magic.
  - [DUP] itemTool.ts:27 `both(a,b)` composite command — same idea as `features/demolition/demolish.ts:49 both(label, j, items)`; probably belongs in `core/commands.ts`.
  - [ALLOC] itemTool.ts:193 — `spacing()` builds a Record literal on every call (per row; minor).
  - [BUG] itemTool.ts:217–218 — `placePoleLine` ("from the page/tests") overwrites the tool's `mode`, `barrier` and `poleLights` as a side effect: an API call changes what the player's tool will place next.
  - [MIX] itemTool.ts — streetscape objects, barriers, pole lines, signs-as-junction-rules and street-name text in one tool.
- **Superfície pública:** `STREET_ITEMS`, `SIGN_TYPES`, `BARRIER_KINDS`, `ItemTool` (hover/click/row/hoverRow/back/placePoleLine/cancel/hint/setMode/onText).

#### `src/features/terrain/riverTool.ts`

- **Veredito: MOVER** → src/features/water/riverTool.ts
- **Evidência e regra (coordenador):** Rio é água; a aparência da água mora em features/water e a ferramenta em features/terrain.
- **Responsabilidades (a-l):** L12–17 host interface; L19–25 points + width; L28–34 hover preview; L37–44 lay as `RiverCommand`; L47–52 API lay.
- **Achados do leitor (a-l):**
  - L39 depth formula `min(4, 1.2 + width/12)` without source (magic).
  - [NAME] folder: river tool lives under `features/terrain` while water look lives in `features/water` (category split).
- **Superfície pública:** `RiverHost`, `RiverTool`.
- **Exports nunca importados (b):** `RiverHost`

#### `src/features/transit/transitTool.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Ferramenta de linhas; chave tr.version*100000+roadsVersion colide depois de 100.000 versões (L135); cada edição de via reenvia todas as linhas com cópia das paradas (L136–138); LineRow importado de ui/drawers.ts (L12).
- **Responsabilidades (a-l):** L15 sim stat type; L17–28 host interface; L44–80 line create/mode/buses/color/loop/delete; L83–126 map click: terminal toggle, stop remove, stop add (rail centre line / bus on sidewalk); L133–150 sync lines to sim and panel.
- **Achados do leitor (a-l):**
  - [BUG] transitTool.ts:135 — change key `tr.version * 100000 + roadsVersion`: once `roadsVersion` reaches 100000 different (version, roadsVersion) pairs collide (e.g. (1,0) vs (0,100000)) and the lines are not resent to the sim.
  - [OMAP] transitTool.ts:136–138 — every road edit (roadsVersion change) re-sends every line with a copy of every stop array; grows with lines/stops, not with the edit.
  - [ALLOC] transitTool.ts:146–148 — rebuilds all rows with `stats.find` per line (O(lines×stats)) whenever stats object changes (sim stats arrive periodically).
  - [OBJ] transitTool.ts:58,138 — lines are JS objects (`tr.lines[i]`, world/transit.ts) with `stops` number arrays; few, but not SoA.
  - (inference) [BUG] transitTool.ts:104,112/124 — first click with no line runs `newLine()` (one command) then `addStop` (second command): one click needs two undos.
  - [LAYER] transitTool.ts:12 — imports type `LineRow` from `ui/drawers.ts`.
- **Superfície pública:** `LineStat`, `TransitHost`, `TransitTool`.
- **Exports nunca importados (b):** `LineStat`, `TransitHost`

#### `src/features/water/waterControl.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Controle da água; escreve globais waveU/foamU/currentU de render/scene.ts (L20).
- **Responsabilidades (a-l):** L5–6 water look type/defaults; L8–21 set/get, writes render uniforms.
- **Achados do leitor (a-l):**
  - [SMALL] 23 lines, one setter; writes globals `waveU/foamU/currentU` of `render/scene.ts` (L20) — [HOST] state mirrored in render-global uniforms.
  - Not a command: water look edits are not undoable (record only sets `changed`).
- **Superfície pública:** `WaterCtl`, `DEFAULT_WATER`, `WaterControl`.
- **Exports nunca importados (b):** `WaterCtl`

#### `src/features/zones/zoneTool.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Pincel de zona; 'não é quadra fechada' só detectado no passo 299 (L95–121); mensagens em português e 'ok' mágico como sucesso (L85–125); array por segmento a cada pincelada (L52, L59).
- **Responsabilidades (a-l):** L17–20 zonable profile test; L22–44 stroke begin/end (one journal per stroke); L47–76 brush dab: segments near brush, side hit test, set zone; L82–126 fill block by walking the face; L129–156 knock down buildings of other zone facing a segment side.
- **Achados do leitor (a-l):**
  - [ALLOC] zoneTool.ts:52,59 — `hits` array and `[0, 1]` literal per segment on every dab (pointer move while painting).
  - [BUG] zoneTool.ts:95–121 — "not a closed block" is only detected at `step === 299` (L121), and the dead-end branch `continue` (L119) skips that check. A face walk around an open street tree terminates via `done.has(key)` (L98) and commits zoning of every side it walked (possibly a large outer face) instead of refusing.
  - (inference) [BUG] zoneTool.ts:34–37 — `begin()` called while a stroke is open replaces `this.stroke` without pushing it: the old stroke's applied zone changes become un-undoable.
  - [TEXT] zoneTool.ts:85,121,123,125 — returns Portuguese user messages and the magic string `'ok'` as the success signal; L36,92 Portuguese journal labels.
  - L10–12 constant declared between imports; `LOW_DENSITY_FLOORS = 4` duplicates `world/growth.ts floorsFor` (comment L10) — [DUP].
  - L142–147 16-sample projection per building in `clearSide` (approximate nearest point).
- **Superfície pública:** `zonable`, `ZoneTool`.

#### `src/game.ts`

- **Veredito: DIVIDIR** → ver plano de migração (app/simLink.ts, app/saveSlot.ts, app/scriptApi.ts, features/*/actions.ts, features/terrain/brushTool.ts, app/lotState dentro de LotEditing, render/layers.ts, render/warmup.ts, app/launchParams.ts, app/frameGate.ts, app/clock.ts, app/healthFeed.ts, world/greenness.ts, world/doors.ts, world/buildingTop.ts)
- **Evidência e regra (coordenador):** Arquivo-deus: ≥17 responsabilidades (L246–2087), ~85 campos, 8 objetos host que só repassam getters/setters (L323–349, L1025–1087, L1239–1270, L1497–1504, L1818–1846, L2079–2085).
- **Responsabilidades (a-c):** L1–89 imports (FLASH_COLOR declared inside imports L8); L91–100 constants + global debug handle `__cidade` (status, game, setLang); L102–245 ~85 fields (tools, brush, lot state, sim timers, clock, save state); L246–522 constructor: features construction L252–263, camera solid query L265–275, layer creation L276–287, sim worker + message switch L289–303, profile broadcast L306–310, network listeners (sim ops, arrows) L312–321, LotEditing host 14 getter/setter pairs L323–349, HUD action object ~125 entries L350–477, tools/inspector L478–497, command hooks (log, sound by Portuguese label prefix) L498–513, language/close hooks L514–521; L524–661 start(): URL params, scene, warmup/compile, settings, panels, launch flow; L664–680 stats/view/settle (tool API); L684–695 generateTerrain; L700–836 frame loop (clock, weather, hover per tool, brush dabs incl. landform+rock L773–779, redraw gate L795–800, layers/growth/terrain/sim/vehicles/props/post, ?perf log); L838–896 traffic view, trips/min, greenAt (80 m query), updateInfo; L899–1016 sim link: pause/speed, resyncSim (whole network), syncSim (ops, occupancy, demand, camera, doors), sendDoors (450 m query), updateArrows, processRoadPaint; L1018–1137 input: bindInput host (~45 getters/setters), removePole, toolKey, bindResize; L1140–1184 applySettings, warmPost; L1186–1227 adaptDetail/fixDetail/updatePixelScale; L1230–1270 history, toolHost, clickHost; L1273–1411 `api` for tools (people, paint, item, lot, road, zone, line, grow, edit, packMap, terrain, elements, crossing, uturn, demolish, bomb, junction, lotPoly, lotLine, lotCurve, renovate, manoeuvres, address, passTime); L1413–1488 person/shoot/bomb/onHit/plantTree/setBiome/setElevation/setRadius/setView; L1492–1504 selection host; L1511–1541 start screen, gpuName; L1544–1567 health panel feeds; L1570–1603 follow + 16 one-line forwarders to LotEditing; L1608–1629 resetCity; L1635–1661 saveBlocked, saveBeforeClose, discardOk, endRebuild; L1665–1733 generatedCity (incl. per-tile conform packing L1685–1717); L1738–1785 testCity, insertBoxes; L1790–1807 save store/lock; L1816–1848 save/load hosts; L1855–1977 openGeneration; L1980–2087 export/import/keepSlot/previous cities/newMap.
- **Achados (a-c):**
  - [MIX] god file: ≥17 responsibilities above; arch-baseline lists it (160,779 B at baseline; 121,234 B now).
  - [HOST] L323–349 LotEditing host forwards 14 lot fields as getters/setters; L1025–1087 bindInput host forwards the same lot fields again (lotExtra, lotExtraPts, joinFirst, cornerDrag) plus stroke/drag state; L1239–1251 toolHost; L1254–1270 clickHost; L1497–1504 selectionHost; L1818–1827 SaveHost; L1840–1846 LoadHost; L2079–2085 NewMapHost. State lives in Game but is used by app/lotEditing.ts, app/input.ts, app/tools.ts, app/clicks.ts, app/buildings.ts, app/session.ts.
  - [TEXT] L502–503 the command sound is chosen by the Portuguese undo label prefix ('demolir', 'remover', 'tirar', 'apagar', 'construir', 'rotatória', 'trocar', 'lote desenhado', 'muro').
  - [DUP] L1348–1355 api.terrain repeats the landform+rock combination of the frame loop L773–779, and they differ: the tool paints rock at radius×0.6 for 'gully' (L778), the API always at radius×0.95 (L1353).
  - [DUP] L1309–1319 api.road repeats snap→plan→build→settle→push of features/roads/roadTool.ts with its own refusal strings in Portuguese ('dinheiro insuficiente: custa R$ …', 'nada aqui', 'recusado', 'sem via', 'não criou').
  - [DUP] L1608–1629 resetCity and L1856–1868 openGeneration each list what is cleared; they diverge (openGeneration lacks demolition.clear(), clouds before ex, signs ok, tileInSave handled later).
  - [BUG] openGeneration L1855–1868 never calls this.demolition.clear(): wrecks, craters and soot of the city on screen survive a Load (resetCity L1619 clears them).
  - [BUG?] L1689–1691 generatedCity drops a segment whose addSeg throws (`catch { continue; }`) silently: hides the cause.
  - [RULE] L1195–1207 adaptDetail lowers detail (×0.85 down to 0.35) in play when p90 > 20 ms: CLAUDE.md "Never pass the budget with quality tricks: adaptive detail…" and "maximum quality". Decision on the feature is the owner's (not mine to remove), recorded as open.
  - [OMAP] L1472 setBiome marks every cell Dirty.Props (CELL_COUNT loop) — whole-map change by nature (all tree species change); L1955 marks every tile's RoadPaint on load; L917–929 resyncSim sends the whole network (failure path only).
  - [ALLOC] L828 `this.layers.some((l) => …)` closure per frame; L725 fine (reuses shakeOffset); L878 array of 5 arrays per call (2/s); L1783 insertBoxes builds one object + Array per building at load (World.addBuilding takes an object).
  - [DEV] L144–148 developer flag also true on the Vite dev server (`import.meta.env.DEV`); L624–625 developer-only options (worst case, unlimited money); L99–100 global `__cidade` handle (the automation interface used by tools/*.mjs: justified); L609 + L835 ?perf log; L605–615 photo URL parameters.
  - [NAME] SLOT = 'cidade-1', file name `cidade-<seed>.cidade`, status values 'carregando'/'pronto', console messages in Portuguese (L537, L928, L1671 phases 'relevo', 'malha viária'…): not English (CLAUDE.md Language). 'carregando'/'pronto' are read by tools (check before renaming).
  - [LAYER] imports jobs/debugCity.lineProfile (L77) and jobs/buildingGen.wallsHeightOf (L12) into app: allowed by the arch rule (app may import jobs) but means main thread links worker modules.
  - Prior analysis (WORKLOG "game.ts split analysis", e84f206) checked: "clearGround() called twice in openGeneration (1860 and 1870)" was true at e84f206 and is already fixed at fae9836 (only L1860). "openGeneration does not call demolition.clear()" — confirmed. "sound by Portuguese label prefix" — confirmed L502–503. "api.terrain duplicates landform+rock" — confirmed and they diverge (gully radius). "adaptDetail lowers detail in play" — confirmed. Line ranges of the prior table are within ±2 lines of fae9836.
- **Superfície pública:** Game (world, pool, commands, hud, hudActions, perfLog, transit, api, stats, view, settle, fixDetail, clickLotTool, generatedCity, togglePause, saveStore, green), OCCUPANCY_SEGS, status.
- **Exports nunca importados (b):** `OCCUPANCY_SEGS`

#### `src/jobs/blockLots.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Lotes por quadra no worker; rasteriza todos os segmentos do grafo por chamada (L43–49).
- **Responsabilidades (a-l):** L13–20 constants and lot type; L28–78 raster the streets (1 m) round a cell, flood-fill land pieces, skip open/small; L80–131 cut a block: hull → min-area box → rows/columns → lots facing the street; L133–136 paved test; L140–148 convex hull; L151–170 min-area rectangle.
- **Achados do leitor (a-l):**
  - [R40COPY] blockLots.ts:1–5,13,81,93,105 — mechanism and constants cited from 4.0 `world/lots.ts` line ranges (values ported; code reimplemented).
  - [OMAP] blockLots.ts:43–49 — rasterises EVERY segment of the graph `g` (`for s < g.segCount`), with ~len/1 m disc stamps each; cost bounded by what the cell graph contains (comment L6 "the cell's graph reaches MARGIN past it"), not by the raster; segments far outside still stamp (cheap clipping by i0/i1 only).
  - [ALLOC] blockLots.ts:31,54 — W×W Uint8 + Int32 per call (W = 256+2·margin at 1 m), Map×2 + tuple arrays per block (L82–90), `corners` spread arrays (L119); runs in worker, per cell rebuild.
  - [OBJ] blockLots.ts:118 — returns one object per lot (`BlockLot[]`) — worker output, transient.
- **Superfície pública:** `BlockLot`, `blockLots`.
- **Exports nunca importados (b):** `BlockLot`

#### `src/jobs/boxMesh.ts`

- **Veredito: MANTER** → src/jobs/boxMesh.ts (comentários em inglês)
- **Evidência e regra (coordenador):** Malha de caixas; shade igual a buildingGen/geometry.ts:44 shadeHex.
- **Responsabilidades (a-l):** L8–17 octahedral normal encode; L19–20 material ids; L24–106 packed mesh of generic boxes (4 walls + roof, foundation sunk 1.5 m); L108–111 shade.
- **Achados do leitor (a-l):**
  - [NAME] boxMesh.ts:1–2,7,33,46,75,81,86,93 — comments in Portuguese (language rule: English).
  - [ALLOC] boxMesh.ts:76–77 — four JS arrays (`px,pz,wx,wz`) per box in the meshing loop (worker).
  - boxMesh.ts:46 — 1.5 m buried foundation: wall area below ground is drawn but hidden (small invisible geometry; intended to avoid gaps on slopes).
  - (inference) [DUP] `octEncode` (L8) — octahedral encoding likely also exists in other mesh builders (search `octEncode`).
- **Superfície pública:** `octEncode`, `MAT_WALL`, `MAT_ROOF`, `buildBoxMesh`.
- **Exports nunca importados (b):** `MAT_WALL`, `MAT_ROOF`

#### `src/jobs/building40.ts`

- **Veredito: DIVIDIR** → src/jobs/buildingGen/r40Lot.ts (layLot40 e plano) + src/jobs/buildingGen/r40Parts.ts + src/jobs/buildingGen/r40Ruin.ts
- **Evidência e regra (coordenador):** Constrói, instancia, arruína e faz a massa dos prédios 4.0 num arquivo; refaz plano + sob medida + mobília a cada chamada building40(lot) (L105, L127, L151, L335); MAT redeclara BMAT (L13); ramo `glass ? Plain : Plain` (L161); fonte de ruína global ligada/desligada em volta da chamada (L47–49).
- **Responsabilidades (a-l):** L12–36 material ids, 4.0 finish/part look tables, coarse/skipped part sets; L38–53 lazy part models cache and ruin sink hook; L56–76 half-float, sRGB, octahedral helpers; L78–97 lot/output/sink types; L105–121 run the 4.0 pipeline for a lot (planLot → madeToMeasure → furnishLot) into a 4.0 `Building`; L125–148 4.0 volumes as engine layout; L150–299 lay a lot: shell faces, far-level runs, parts to pool, coarse parts (glass/water) as geometry, ruin attach, lot ground, footprints; L305–326 ruin interior (slabs + furniture); L334–366 far massing (L2/L3).
- **Achados do leitor (a-l):**
  - [HOST] building40.ts:47–49 — the ruin sink is a module-global set/cleared around a call (`setRuinSource`, used by `buildingGen.ts:69–73`): an implicit parameter; any re-entrant or interleaved call sees the wrong sink.
  - [DUP] building40.ts:105, 127, 151, 335 — `building40(lot)` re-runs the whole 4.0 plan + made-to-measure + furnish for every call; `volumes40`, `layLot40` (L0, far, parts pass) and `massLot40` each regenerate the same building per level/pass.
  - [DEAD] building40.ts:161 — `(finish === 'glass' ? MAT.Plain : MAT.Plain)`: both branches identical.
  - [DEAD] building40.ts:217 — `for (const parts of [shell])` loop over a one-element array (only a disguised `if (shell)`).
  - [NAME] building40.ts:99–104 — two stacked doc comments: the `layLot40` doc sits above `building40()` (L105), `layLot40` (L150) has none.
  - [DUP] building40.ts:13 — `MAT` re-declares `BMAT` ids of `buildingGen/materials.ts:3` (comment L12 says so).
  - [TEXT] building40.ts:246 `kind.startsWith('lot')`, L324 `'f:' + kind` string prefix protocol with the ruin sink, L34/L36 part kinds as strings.
  - [ALLOC] building40.ts:132 (array literals per volume corner), 294–297 (tuple per footprint), 314 (corners arrays), 324 (string concat per furniture instance) — worker meshing path, per building.
  - [R40COPY] building40.ts:22–28 — PART_LOOK copied from 4.0 `kit.ts createBuildingKit` values; whole file drives the 4.0 code via `r40/api.ts` (layer `r40`, allowed).
  - [LAYER] building40.ts:8 — `three` `BufferGeometry` (type) and `partGeometries()` build three geometries inside a jobs/worker module.
  - (inference) building40.ts:154 `letGoEmitted(b)` is called right after emitChunk while `b` is still used at L287 (layInside) and L294 (volumes); safe only if letGo frees emitted buffers only.
  - [MIX] one file: 4.0 building build, near shell, far runs, part instancing, ruin parts/interiors, massing LOD.
- **Superfície pública:** `COARSE_PARTS`, `AttachSink`, `setRuinSource`, `partBase`, `Lot40`, `Laid40`, `PartSink`, `Volume40`, `volumes40`, `layLot40`, `massLot40`.
- **Exports nunca importados (b):** `COARSE_PARTS`, `Laid40`, `Volume40`

#### `src/jobs/buildingFinishes.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Tabela de acabamentos; FINISH_BY_MAT posicional por índice de BMAT (L45).
- **Responsabilidades (a-l):** L6–17 finish ids/keys/cooked layer order; L19–42 finish looks from 4.0 recipes; L45 finish by material; L48 cooked file names; L55–72 pack three cooked arrays into two.
- **Achados do leitor (a-l):**
  - [R40COPY] buildingFinishes.ts:31–38 — table of 4.0 `bake/finishRecipes.ts LOOKS` values (values with source; fine).
  - [TEXT] buildingFinishes.ts:45 — `FINISH_BY_MAT` positional array keyed by BMAT index (magic order coupled to another file's enum).
- **Superfície pública:** `FIN`, `FINISH_COUNT`, `FINISH_SIZE`, `FINISH_KEYS`, `COOKED_FINISHES`, `FinishLook`, `FINISH_LOOKS`, `FINISH_BY_MAT`, `COOKED_FILES`, `packFinishes`.

#### `src/jobs/buildingFinishWorker.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Entrada do worker de acabamentos; decodificação fora da thread principal.
- **Responsabilidades (a-l):** L9–26 worker entry: fetch 3 KTX2, zstd decode, pack, transfer back.
- **Achados do leitor (a-l):**
  - [SMALL] worker entry, 27 lines. [OK] heavy decode off the main thread, transfers buffers.
  - buildingFinishWorker.ts:11–12 — new ZSTDDecoder per message (expected once).
- **Superfície pública:** none (worker `onmessage`).

#### `src/jobs/buildingGen.ts`

- **Veredito: DIVIDIR** → src/jobs/buildingGen/index.ts (despacho) + parking.ts + ruinEntry.ts; os geradores legados só para teste (buildBuildingsLegacy, buildBuildingPartsLegacy) saem com os testes que só os exercitam
- **Evidência e regra (coordenador):** Na passada de peças cada prédio 4.0 roda também o corpo genérico house/tower/block com a saída desligada (L178–189, conferido): trabalho jogado fora por prédio; geradores legados existem só para testes (L101–104, L212–215; conferido em buildingDefects/buildingFinishes/buildingLook/defects.test.ts) — esses testes não provam o caminho de produção; saídas por globais de módulo (L204–219).
- **Responsabilidades (a-l):** L9–38 imports and re-export barrel of buildingGen/*; L40 version; L45–51 no-op MeshBuilder singleton; L57–61 one building's layout volumes; L67–75 one building for a ruin; L81–83 vertex tag; L89–104 cell buildings mesh (+ legacy entry); L107–112 Lot40 from a record; L115–195 per-building dispatcher (empty lot, catalog, design, open lot, civic design, civic, industrial, 4.0 at L1/L2+/L0/parts/layout, generic house/tower/block, finishes); L202–219 parts pass with module-global sinks; L222–228 footprint test; L235–260 lot parking rows.
- **Achados do leitor (a-l):**
  - [HOST] buildingGen.ts:204–208, 217–219 — parts-pass outputs passed through module globals (`grounds40Out`, `parts40Out`) instead of `GenOutputs`; contradicts outputs.ts header "no output lives at module scope".
  - [DUP] buildingGen.ts:185 — in the parts pass (lod −2) every 4.0 R/C/M building also runs the old generic `house/tower/block` body into NO_MESH (comment L170): a second whole generator per building per parts job; its `captureFoot` footprints are of a building that is not drawn (yard props avoid it) — (inference) [BUG] props kept off a phantom footprint.
  - [DEV] buildingGen.ts:101–104, 212–215 — `buildBuildingsLegacy` / `buildBuildingPartsLegacy` exist "for its regression tests"; production code paths kept only for tests.
  - [DUP] buildingGen.ts:109–110 — use/density from zone duplicated in `buildingGen/heights.ts:35–36`.
  - [DUP] buildingGen.ts:237–240 — `lotParking` repeats the house/tower/block arch selection of `genOne` L134,189–191 (pickArch + same thresholds).
  - [DEAD] buildingGen.ts:85, 87, 264 — orphan doc comments with no declaration (one Portuguese, one at EOF "A hip roof").
  - [NAME] buildingGen.ts:1–7, 197–199, 230–234, 246, 252 — Portuguese comments.
  - [MIX] dispatcher + barrel re-exports (L30–38) + parking + footprint test + ruin entry + layout query in one file.
  - [MAIN] (from callers) `buildingVolumes` (L57) is imported by `src/render/inside.ts:10` and `buildingTag` by `features/demolition/ruin/ruins.ts:11`: `buildingVolumes` runs `planCells(b)` over every box passed plus a full generator pass on the page (inference: main thread).
  - Mixed generators: polygon lots (`shapeN`) and `legacy` skip the 4.0 path (L159,163,167) and use the old generic house/block — two different building generators for the same zone depending on lot shape.
- **Superfície pública:** `GEN_VERSION`, `buildingVolumes`, `buildingForRuin`, `buildingTag`, `buildBuildings`, `buildBuildingsLegacy`, `LotGround40`, `buildBuildingParts`, `buildBuildingPartsLegacy`, `inFootprints`, `lotParking` + re-exports (groundRange, hip, FRAME_BAR, WIN_REVEAL*, PART, BMAT, Facade, finishTable, catalogLevels, wallsHeight*, HeightRec, PartEmit, Volume).

#### `src/jobs/buildingGen/catalog.ts`

- **Veredito: MANTER** → src/jobs/buildingGen/catalog.ts
- **Evidência e regra (coordenador):** Projetos do catálogo; imports vazios (L1, L7) e comentário órfão no fim (L315).
- **Responsabilidades (a-l):** L17 catalog finish map; L19–26 storeys resized to drawn height; L29–50 one facade wall (or its window detail); L61–193 catalog project building: ground, volumes, faces in fill bands, balconies, doors, piers, roof caps/parapets, machine room, elements; L196–217 catalog balcony; L223–254 parapets on uncovered edges; L257–312 catalog element by kind (props, walls, gates, slabs, pavements, parking).
- **Achados do leitor (a-l):**
  - [DEAD] catalog.ts:1, 7 — empty imports `import {  } from ...`; L315 orphan doc comment at EOF ("Side garden of a corner lot") with no function.
  - (inference) [BUG] catalog.ts:140–145 — doors are filtered per face but drawn only when `face === 0`; doors the project puts on side/back faces are silently dropped.
  - catalog.ts:173, 185–187, 272, 290 — coplanarity offsets (2 cm per volume, 3.874 m machine room, 1.2 cm lift by index mod 5, 2.5 cm on z runs) to avoid z-fighting: data-driven nudges instead of fixing coplanar input (note for the rule "hide a symptom").
  - catalog.ts:178–190 — "machine room and units on the highest roof" not cited to 4.0 (possible invention; unverified).
  - [ALLOC] catalog.ts:74, 76, 97–98, 118–119, 164–165, 174, 200, 229, 232, 241 — arrays/objects per volume/face/edge in the worker; [OMAP-local] L86, 127, 131, 156 `boxes.findIndex/some` per bay×storey (bounded by one building).
  - [TEXT] catalog.ts:17 finish names capitalised into `FIN` keys by string; L82, 268, 277–310 behaviour by kind strings ('grass', 'asphalt', 'tree', 'wall'…).
  - [LAYER-local] catalog.ts:15–16 — imports prop ids (`P_*`, `F_*`) from `plans.ts` and `polyPrism/wallSeg` from `plans2.ts`: sibling plan files used as libraries.
  - No file header comment.
- **Superfície pública:** `catalogBuilding`.

#### `src/jobs/buildingGen/civic.ts`

- **Veredito: MANTER** → src/jobs/buildingGen/civic.ts (comentários em inglês)
- **Evidência e regra (coordenador):** Prédios cívicos; imports vazios (L1, L2, L5); ramos idênticos `mall ? 7 : 7` (L148); comentário de outra função (L200).
- **Responsabilidades (a-l):** L13–198 civic buildings by function (school, church, hospital/clinic, square/park, sports court, gas station, supermarket/mall, city hall, police/fire station, default block); L201–233 open lots (cemetery, playground).
- **Achados do leitor (a-l):**
  - [DEAD] civic.ts:1, 2, 5 — empty imports.
  - [DEAD] civic.ts:148 — `mall ? 7 : 7` identical branches; L22 `mat === BMAT.Plain ? BMAT.Plain : mat` is just `mat`.
  - [NAME] civic.ts:200 — doc "Torre de escritórios: pódio de lojas…" sits above `openLot` (wrong doc); Portuguese comments L28, 50, 74, 79, 88, 130, 133, 151, 160, 185, 189, 210, 217, 223.
  - civic.ts:133–134, 189–190 — offsets added because "the two colours/windows flickered" in the same plane (z-fighting patched by nudging geometry).
  - (inference) [R40COPY-absent] no 4.0 source cited for any civic shape or size (hard-coded dimensions/colours throughout); `heights.ts:14–18 CIVIC_TOP` must be kept in sync by hand ([DUP]).
  - [ALLOC] civic.ts:44, 81, 93, 125–126, 135, 137, 209 — array literals in loops (worker, per building).
- **Superfície pública:** `civic`, `openLot`.

#### `src/jobs/buildingGen/context.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Contrato só de tipos do gerador.
- **Responsabilidades (a-l):** L9–18 `GenContext` type (builder, frame, size, storeys, style, rng, lod, parking rows, pattern, free sides).
- **Achados do leitor (a-l):**
  - [SMALL] type-only contract; [OK] documented.
  - [NAME] context.ts:12 — Portuguese doc ("Vagas do estacionamento").
- **Superfície pública:** `GenContext`.

#### `src/jobs/buildingGen/finishes.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Devolve um buffer mutável compartilhado (L13, L38); `!ds` sempre verdadeiro (L59); regra do 'plain' escrita duas vezes (L47, L56).
- **Responsabilidades (a-l):** L13 shared finish table; L16–29 wall finishes by style; L32–35 creator finish → finish/arch/roof sets; L38–61 finish table for one building; L64–67 write finish nibble on vertices.
- **Achados do leitor (a-l):**
  - [HOST] finishes.ts:13,38 — returns a shared mutable buffer; a second call before `applyFinishes` overwrites the first result (caller buildingGen.ts:194 uses it immediately).
  - [DEAD] finishes.ts:59 — `!ds` always true (the `ds` branch returned at L51).
  - [DUP] finishes.ts:47 and 56 — same "plain follows wall unless brick/ceramic/wood/panel" rule twice.
  - [TEXT] finishes.ts:35 — creator finish indices as bare numbers (`[6, 8]`, `[2, 3, 4, 9]`); also used as `ds.finish === 2` (glass) in plans2.ts:212 and heights.ts:52.
- **Superfície pública:** `DESIGN_ARCH`, `DESIGN_SLATE`, `DESIGN_METAL_ROOF`, `finishTable`, `applyFinishes`.

#### `src/jobs/buildingGen/geometry.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Geometria do gerador; shadeHex igual a boxMesh.ts:108 shade (L44).
- **Responsabilidades (a-l):** L8–17 lot frame and local→world transforms; L20–25 frame part bits, blank wall; L28–42 4.0 coping/parapet/eaves constants; L44–47 shade; L56–121 4.0 pitched roof (hip/gable, fascia, soffit, ridge cap, LOD); L125–128 gable; L132 awning colours; L139–157 shop awning.
- **Achados do leitor (a-l):**
  - [DUP] geometry.ts:44 `shadeHex` = `boxMesh.ts:108 shade` (same code).
  - [ALLOC] geometry.ts:61 (frame spread per recursion), 72–84 closure + `pts.map` per face, 88–118 nested array literals per face (worker).
  - [R40COPY] geometry.ts:131–136 — awning colours and shape from 4.0 `procedural.ts`/`kit.ts` (values).
- **Superfície pública:** `Frame`, `wx`, `wz`, `nx`, `nz`, `FR_*`, `blank`, `copingOf`, `GOURMET_OUT`, `PARAPET_H`, `PARAPET_T`, `EAVES`, `ROOF_THICK`, `shadeHex`, `pitchedRoof`, `gable`, `AWNINGS`, `awning`.

#### `src/jobs/buildingGen/heights.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Altura das paredes; importado na página por game.ts:12 e features/demolition/bomb.ts:14: numa falta de cache refaz o prédio 4.0 na thread principal (L28–41); cache esvaziado inteiro acima de 4096 (L39).
- **Responsabilidades (a-l):** L11 4.0 zones set; L14–18 civic wall heights; L25 record type; L26–45 wall height from the 4.0 volumes (cached by string key) or estimate; L47–61 estimate by design/civic/industrial/style; L67–72 catalog level arithmetic.
- **Achados do leitor (a-l):**
  - [MAIN] heights.ts:28–41 — `wallsHeightOf` is imported by `src/game.ts:12` and `src/features/demolition/bomb.ts:14` (page side); on a cache miss it runs `volumes40` → the whole 4.0 planLot + madeToMeasure + furnishLot on the main thread (comment L22–23: "camera and collapse, which ask every frame or for many buildings").
  - [OMAP] heights.ts:39 — cache is cleared wholesale above 4096 entries: a city with more buildings than that thrashes and regenerates 4.0 buildings repeatedly.
  - [ALLOC] heights.ts:31 string key concatenation per call (per frame per asked building); L38 `Math.max(0, ...map)` array + spread.
  - [DUP] heights.ts:35–36 — use/density of `buildingGen.ts:109–110`; L14–18 CIVIC_TOP hand-synced with civic.ts shapes (e.g. Church spire reaches y0+28.4 at civic.ts:60 but CIVIC_TOP is 20).
  - [TEXT] heights.ts:52,54 — `ds.finish === 2` (glass) magic.
- **Superfície pública:** `R40_ZONES`, `HeightRec`, `wallsHeightOf`, `wallsHeight`, `catalogLevels`.

#### `src/jobs/buildingGen/lot.ts`

- **Veredito: DIVIDIR** → src/jobs/buildingGen/lot.ts (estado do lote) + earClip/clipLeft para src/core/polygon.ts
- **Evidência e regra (coordenador):** Estado do lote em globais de módulo entre beginLot/endLot e endLot só limpa lotPoly (L22–33); algoritmos genéricos de polígono no arquivo (L180, L204); docs duplicados por função (L35–328).
- **Responsabilidades (a-l):** L14–19 untagged draw wrapper; L22–33 per-lot module state (polygon, grid, fence styles, gate) with begin/end; L37–64 ground-following wall; L67–94 lot relief grid; L98–111 yard; L118–132 walkway; L135–154 lot wall/gate (polygon-aware); L157–177 polygon walls; L180–213 ear clipping and half-plane clip; L219–239 polygon yard; L241–250 ground range; L254–277 parking floor/stripes; L279–286 legacy box; L289–307 empty lot curb; L311–325 ground patch; L329–343 gate.
- **Achados do leitor (a-l):**
  - [HOST] lot.ts:22–33 — lot state in module globals between `beginLot`/`endLot`; `endLot` (L33) clears only `lotPoly` (others left stale until next `beginLot`).
  - [DEAD] lot.ts:35–36, 96–97, 113–117, 252–253, 309–310, 327–328 — two stacked doc comments per function (old Portuguese + new wrapper doc).
  - [DEAD] lot.ts:46 `const g: Frame = f;` useless alias; L282–283 `mb.curBase = f.base; mb.curBase = hi;` first write dead.
  - [ALLOC] lot.ts:61, 128, 230, 234 — arrays per wall segment / walkway step / grid cell (worker).
  - lot.ts:82–89 — `at()` calls `hAt` 3× and each `hAt` calls `heightAt` (no grid cache): every ground query re-samples the terrain 3 times.
  - lot.ts:53 — wall sides extend 0.4 m under ground (hidden geometry, small).
  - [MIX] lot state + generic polygon algorithms (earClip L180, clipLeft L204) + parking + legacy box + empty lot + gate in one file.
  - [NAME] Portuguese comments L35, 47, 83, 87, 96, 113–115, 252, 261, 273, 288.
- **Superfície pública:** `untagged`, `beginLot`, `endLot`, `wall`, `yardGrid`, `yard`, `walkway`, `lotWall`, `lotGate`, `polyWalls`, `groundRange`, `parkingLots`, `legacyBox`, `emptyLot`, `groundPatch`, `gate`.
- **Exports nunca importados (b):** `untagged`

#### `src/jobs/buildingGen/materials.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Ids de material; redeclarados como MAT em building40.ts:13.
- **Responsabilidades (a-l):** L3 building material ids; L5 facade kinds.
- **Achados do leitor (a-l):**
  - [SMALL] 6 lines, two constant objects; [DUP] re-declared as `MAT` in building40.ts:13.
  - L1–2 two stacked doc comments (the second documents only `Indoor`).
- **Superfície pública:** `BMAT`, `Facade`.

#### `src/jobs/buildingGen/outputs.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Saídas do gerador; o cabeçalho diz que nada mora no escopo do módulo, contradito por buildingGen.ts:217–219 e building40.ts:47 (L2–3).
- **Responsabilidades (a-l):** L12 volume layout type; L15 part sink type; L17–25 outputs holder; L27–29 factory.
- **Achados do leitor (a-l):**
  - [SMALL] data holder. Header L2–3 claims "no output lives at module scope", contradicted by `buildingGen.ts:217–219` and `building40.ts:47`.
  - [OBJ] outputs.ts:20 — `foot: number[][]` one JS array per building.
- **Superfície pública:** `Volume`, `PartEmit`, `GenOutputs`, `newOutputs`.

#### `src/jobs/buildingGen/plan.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Plano do prédio; seleção casa/torre/bloco repetida de buildingGen.ts:134, 185–190 (L47–50).
- **Responsabilidades (a-l):** L13–20 landmark list cache and constants; L31–81 cell plan: group by cell, landmark pick with 2×2 colouring, facade pattern by neighbour signature; L84–88 catalog extent; L94–112 free (corner) sides.
- **Achados do leitor (a-l):**
  - [ALLOC] plan.ts:53 — `TOWER_CATALOG().filter(...)` per tower per call.
  - plan.ts:58, 69 — O(n²) over `done` per cell (bounded by buildings of one cell).
  - [DUP] plan.ts:47–50 — pickArch + house/tower thresholds again (same as buildingGen.ts:134,185–190, lotParking).
- **Superfície pública:** `CellPlan`, `planCells`, `catalogExtent`.

#### `src/jobs/buildingGen/plans.ts`

- **Veredito: MANTER** → src/jobs/buildingGen/plans.ts (ids de props para buildingGen/props.ts)
- **Evidência e regra (coordenador):** Planos; ids e paletas de props compartilhados exportados de um arquivo de plano (L15–19); import vazio (L8); comentários de outra função (L380, L422).
- **Responsabilidades (a-l):** L15–19 prop ids and palettes; L26–90 4.0 roof plant; L93–95 hip; L98 facade setter; L100–188 generic house (body, roof, porch, garage, tank, pool, yard, walls, hillside); L191–369 generic apartment/mixed block (arcade, setbacks, crown, piers, bands, relief, awnings, balconies, ACs, roof plant, yard/parking/walls, corner garden); L376–378 lot tree as prop; L381–390 side garden; L396–420 hillside garage/wing/retaining wall.
- **Achados do leitor (a-l):**
  - [DEAD] plans.ts:8 empty import; L380 doc "Prédios especiais (escola, igreja…)" sits on `sideGarden`; L422 orphan doc at EOF ("Loading docks"); L376 `treeGeo(_mb, …, _r)` unused params.
  - [TEXT] plans.ts:292 — `(r.next(), trim)` comma expression only to consume an RNG draw.
  - plans.ts:126–128, 168–170 — geometry nudged 5 cm / 4 cm because surfaces "flickered" in the same plane (z-fighting patched by offset).
  - [MIX] plans.ts:15–19 — shared prop ids/palettes exported from a plan file and imported by catalog.ts, civic.ts, plans2.ts.
  - [NAME] plans.ts:97 doc typo/Portuguese ("Facha da"); Portuguese comments L106, 118, 121, 123, 134, 142, 149, 157, 160, 168, 172, 176, 190, 198, 210, 216, 244, 249, 260, 268, 276, 284, 310, 330, 341, 354.
  - [ALLOC] plans.ts:36, 62, 139, 309, 352 (`plant.filter`) — arrays per call (worker).
  - Note: house/block are the generic (pre-4.0) generator, still used for polygon lots, legacy tests and the parts-pass footprints (buildingGen.ts:185–191).
- **Superfície pública:** `P_TREE`, `P_BUSH`, `P_LAMP`, `P_BENCH`, `P_BIN`, `P_FURN`, `F_DRAIN`, `F_BOLLARD`, `F_PLANTER`, `PLASTER`, `TILE`, `METAL`, `roofPlant`, `hip`, `facade`, `house`, `block`, `treeGeo`.
- **Exports nunca importados (b):** `TILE`, `roofPlant`

#### `src/jobs/buildingGen/plans2.ts`

- **Veredito: RENOMEAR** → src/jobs/buildingGen/towersAndWarehouses.ts (e designs do criador em creatorDesigns.ts)
- **Evidência e regra (coordenador):** O nome não diz nada; torres, galpões, chaminés, projetos do criador e telhados genéricos juntos; imports vazios (L3, L8).
- **Responsabilidades (a-l):** L17–81 office tower (podium, tiers, crown, canopy, piers); L83–112 warehouse; L115–127 industrial chimney; L132–160 polygon prism; L163–179 pyramid roof; L182–199 shed roof; L202–206 sawtooth; L209–318 player-designed building (creator); L321–334 roof wall segment; L342–354 loading docks.
- **Achados do leitor (a-l):**
  - [NAME] plans2.ts — file name says nothing ("plans2"); [MIX] towers, warehouses, chimneys, creator designs and generic roof primitives in one file.
  - [DEAD] plans2.ts:3, 8 empty imports; L208 doc "Cemitério… parquinho" sits on `design()`; L339–341 section header "catalog projects" and doc "Catalog finish → finish id" sit on `docks()`; L181 self-contradicting Portuguese doc.
  - [ALLOC] plans2.ts:134–135 — six `Math.min/max(...pts.map())` spreads per polygon prism; L170–171 tuple per edge.
  - (inference) [BUG] plans2.ts:294 — `(set ? topRects : rects)[0]` destructured without check; a design whose `footprint()` returns no rects and no poly would throw.
  - [TEXT] plans2.ts:212, 216, 218–219, 233 — creator finishes/windows/roofs by bare numbers (`finish === 2`, `win === 4`, `roof === 5`).
  - [NAME] Portuguese comments L23, 50, 91, 102, 114, 119, 129, 131, 162, 181, 191, 201, 221–222, 248, 273, 292, 312, 320.
- **Superfície pública:** `tower`, `warehouse`, `chimney`, `polyPrism`, `pyramid`, `shed`, `sawtooth`, `design`, `wallSeg`.
- **Exports nunca importados (b):** `pyramid`, `shed`, `sawtooth`

#### `src/jobs/buildingGen/polygon.ts`

- **Veredito: JUNTAR** → src/core/polygon.ts
- **Evidência e regra (coordenador):** inPolygon igual a r40/core/polygon.ts pointInPolygon; cabeçalho aponta para buildingGen mas o estado mora em lot.ts (L2).
- **Responsabilidades (a-l):** L8–14 lot polygon from packed shape; L16–22 building fit (largest rectangle) for a lot; L25–37 point-in-polygon with tolerance; L43–69 largest inscribed rectangle on a 0.5 m grid.
- **Achados do leitor (a-l):**
  - [NAME] polygon.ts:2 — header says "the generator's per-lot wall state stays in buildingGen"; it lives in `buildingGen/lot.ts:22–27`.
  - polygon.ts:50 — `inPolygon` per grid corner: O(grid × edges); `lotFit` is recomputed for the same building by `genOne` (buildingGen.ts:121) and `lotParking` (buildingGen.ts:242) — [DUP] work.
  - [ALLOC] polygon.ts:11–12, 21 tuple arrays per call.
- **Superfície pública:** `LotFit`, `lotPolygon`, `lotFit`, `inPolygon`.
- **Exports nunca importados (b):** `LotFit`

#### `src/jobs/buildingGen/shell.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Primitivas de desenho; prism aloca corners/normals a cada chamada (L57–58), tabelas iguais em windows.ts e catalog.ts.
- **Responsabilidades (a-l):** L15–21 facade part ids and part sink; L27–38 footprint/volume capture; L44–87 prism (walls with facade u, top, bottom, skip) or its window/curtain detail; L94–112 frame band; L118–125 parapet (4.0 coping); L128–130 open-window test; L137–141 ring band; L144–153 piers; L156–163 balcony props; L166–178 door; L184–200 railing (balusters every 12 cm in detail layer); L203 luma; L209–247 4.0 facade relief (bands, cornice, plinth, brises, pilasters, door).
- **Achados do leitor (a-l):**
  - [ALLOC] shell.ts:57–58 — `corners` and `normals` arrays allocated on every `prism` call (the most called primitive), L80, 84 `corners.map`, L100–102 arrays per frame (worker meshing hot path).
  - [DUP] shell.ts:57–58 = windows.ts:32–33 = windows.ts:117–118 = catalog.ts:97–98 (same corner/normal tables).
  - shell.ts:47–48 — every prism (piers, doors, pillars, slabs) near the ground pushes a footprint via `captureFoot` when `out.foot` is set (inference: many tiny footprints per building).
  - shell.ts:195–199 — railing balusters every 12 cm as separate ledges (detail layer, near only) — dense small geometry; check against 4.0 view (not verified).
  - [MIX] drawing primitives + part sink + layout/footprint capture + 4.0 facade relief (uses GenContext) in one module.
  - [NAME] Portuguese comments L14, 16, 41–42, 57, 143, 155, 165, 181–182, 205–207, 232, 240.
- **Superfície pública:** `PART`, `part`, `captureFoot`, `captureVolume`, `prism`, `frame`, `parapet`, `opensWindows`, `ring`, `piers`, `balconyLife`, `door`, `railing`, `facadeRelief`.

#### `src/jobs/buildingGen/windows.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Janelas; tupla nova por vértice (L63–64); tabelas de canto/normal duplicadas (L32–33, L117–118).
- **Responsabilidades (a-l):** L9 window table; L15–18 facade state setter; L20–23 colour mix; L30–35 window detail for a prism; L38–109 one wall's windows: reveals, glass (WinGlass), frame bars, sill, moulded surround; L112–128 curtain-wall fins and transoms; L131–141 4.0 constants; L144–173 ledge primitive.
- **Achados do leitor (a-l):**
  - [ALLOC] windows.ts:63–64 — `P` returns a new tuple for every vertex `V` emits (per window ~20 vertices); L147–149 `p`/`W` tuples and L154–171 `v` arrays per ledge (ledge is called per frame bar, sill, baluster) — worker meshing hot path.
  - [DUP] windows.ts:32–33, 117–118 corner/normal tables (also shell.ts:57–58); L42 and L58 the same `(ARCHES[style] ?? ARCHES[0]).trim` twice.
  - windows.ts:134 — `LEDGE_ALL`, `LEDGE_SILL`, `LEDGE_HEAD` declared after first use (L100, 105; hoisting of const at module level is fine at call time).
  - [NAME] Portuguese comments L12–13, 26–28, 111, 133, 143, 152, 157, 162, 168.
- **Superfície pública:** `setFac`, `windowDetail`, `windowDetailWall`, `curtainFins`, `CURTAIN_MULLIONS`, `LEDGE_JAMB`, `FRAME_BAR`, `WIN_REVEAL`, `WIN_REVEAL_SHADE`, `BAND_OUT`, `BAND_H`, `CORNICE_OUT`, `PLINTH_GROW`, `PLINTH_COL`, `ledge`.

#### `src/jobs/cityField.ts`

- **Veredito: JUNTAR** → src/jobs/cityGen.ts
- **Evidência e regra (coordenador):** Uma função (blockLines) com um único chamador (cityGen.ts); o nome fala do campo tensorial descartado (L2–3).
- **Responsabilidades (a-l):** L8–32 generated city street grid lines (120×72 m blocks, avenue every 4, collectors between).
- **Achados do leitor (a-l):**
  - [NAME] cityField.ts — file name refers to the discarded tensor field (header L2–3); content is `blockLines`. Called by `src/jobs/cityGen.ts:14`.
  - [SMALL] one function.
  - [R40COPY] cityField.ts:1–2, 12 — reproduces 4.0 `cityGen/plan.ts blockGrid` levels (values cited).
  - [OBJ] cityField.ts:23, 28 — one `{x, z}` object per point (generation output, transient).
- **Superfície pública:** `P2`, `blockLines`.
- **Exports nunca importados (b):** `P2`

#### `src/jobs/cityGen.ts`

- **Veredito: MANTER** → src/jobs/cityGen.ts (cabeçalho e GEN atualizados)
- **Evidência e regra (coordenador):** Gerador da cidade no worker; perfis escolhidos pelo nome em português (L302–306); GEN.Expressway nunca é gerado (L80 só emite Avenue/Collector/Local), então nearExp é sempre infinito e a regra da indústria da L336 nunca dispara (conferido); cabeçalho descreve anéis e expressas descartados (L1–6); comentário 8 × código 6 ligações (L244, L250).
- **Responsabilidades (a-l):** L1–6 header; L16–34 GEN profile ids, CityRoads record, tuning consts; L43–87 `generateCity` (one straight block grid via `blockLines`, `march` cuts lines at water/slope, bridges for levels 0–1); L93–105 `dryCrossings` (drop segs into wet junctions); L112–135 `withoutSpurs` (peel dead ends, renumber); L139–366 `buildGraph` (pieces, 96 m buckets, kill locals parallel to arterials, crossings, 7 m hash-grid node merge, union of <16 m edges, degree cap, small-component removal, zoning, profile variants, split to ≤100 m, remap); L382–481 `tidyGraph` (remove sharp leg pairs, snap dead ends into roads, ≤20 passes).
- **Achados do leitor (a-l):**
  - [TEXT] cityGen.ts:302–306 — road profiles picked by Portuguese display name (`P('Calçadas largas')`, `'Rua urbana'`, `'Bulevar'`…) via `PROFILES.findIndex(p.name === name)`; a renamed/localized label silently falls back to index 0; `park: 1` is a bare index.
  - [BUG] cityGen.ts:279–286 + 336 — `expNodes` only collects `GEN.Expressway` edges, but `generateCity` (L80) emits only Avenue/Collector/Local, so `nearExp` is always Infinity and `Zone.Industrial` is never assigned by the generator (generated cities have no industrial zone). (inference: no other buildGraph caller in this file.)
  - [DEAD] cityGen.ts:16 `GEN.AvenueBike`/`GEN.Expressway` never produced; cityGen.ts:28 `Center.angle/bx/bz` (set L85) never read.
  - [NAME] cityGen.ts:1–6 header still describes radial avenues, ring, expressway, per-district rotated grids that L39–41 says were discarded — stale comment.
  - [BUG] cityGen.ts:244 comment says "at most 8 links per node", code caps at 6 (L250).
  - [OBJ] cityGen.ts:27,48 `Poly` object per polyline; L115 `number[][]` per node; L383–385 parallel JS arrays + `Map` of leg arrays in tidyGraph — transient worker generation, not persistent entities.
  - [LAYER] cityGen.ts:11–13 jobs imports `roads/zones`, `roads/profiles`, `roads/impossible` (jobs → roads).
  - Magic tuning with no cited source: L30 MERGE 7, L33–34 grades 0.11/0.08, L61 wet>320, L176 26 m, L234 16 m, L277 component <30.
- **Superfície pública:** `GEN` (generator profile ids), `CityRoads`, `generateCity(seed, medium)`, `dryCrossings`, `withoutSpurs`.

#### `src/jobs/conform.ts`

- **Veredito: JUNTAR** → src/jobs/conform.ts (regra única usada também pelo gerador de teste)
- **Evidência e regra (coordenador):** smooth idêntico a debugCity.ts:131 (L82); regra sob/ao lado da via duplicada de debugCity.ts:114–123 (L56–72); cabeçalho em português.
- **Responsabilidades (a-l):** L1–3 header (Portuguese); L14–16 record stride/blend/bucket consts; L18–80 `conformTile` (settles one height tile under straight road records: under-road drop, beside-road blend, skips high fills/deep cuts); L82 `smooth`.
- **Achados do leitor (a-l):**
  - [NAME] conform.ts:1–3 header comment in Portuguese.
  - [DUP] conform.ts:82 `smooth` identical to debugCity.ts:131; the under/beside rule (L56–72) duplicates debugCity.ts:114–123 (`conformTileToGrid`).
  - Magic thresholds conform.ts:70 (`< 6` fill, `< 14` cut), L15 BLEND 7, L16 BUCKET 32 — no source cited.
  - [ALLOC] conform.ts:23 `Array.from(nb*nb, () => [])` per call — per-tile worker job, not per frame.
- **Superfície pública:** `CONFORM_REC` (record stride 9), `conformTile(heights, tile, segs)`.
- **Exports nunca importados (b):** `CONFORM_REC`

#### `src/jobs/debugCity.ts`

- **Veredito: MOVER** → tools/ ou test/ (cidade de pior caso para medição), fora do código do jogo; ou APAGAR se o dono não usar o menu de pior caso
- **Evidência e regra (coordenador):** Gerador de cidade de estresse no código de produção (L1–4) com grade, perfis e caixas próprios; é um tipo de trabalho do worker de produção (jobs/worker.ts:39–44) e alimenta o formato de ladrilho do save (test/world.test.ts:95–101); capacidade fixa 14*14*12 sem checagem (L136, L161–166).
- **Responsabilidades (a-l):** L1–4 header ("worst-case loader"); L15–26 grid consts/palette; L29–41 grid node height + grade test; L49–75 `debugTileRoads`; L78–129 `conformTileToGrid`; L131 smooth; L134–178 `debugTileBoxes` (generic boxes in blocks).
- **Achados do leitor (a-l):**
  - [DEV] debugCity.ts:1–4 — a stress/"worst-case" debug city generator living in `src/jobs` (product code) with its own grid, profiles and box buildings.
  - [OMAP] debugCity.ts:59–62 — each per-tile job loops all LINES² (≈106²) grid nodes and filters by tile; L140–144 same over all blocks — per-tile cost grows with map size (tile index range could be computed directly).
  - [DUP] debugCity.ts:52–58 and 82–88 identical cached `H` closures; L146 calls `gridNodeHeight` uncached (4 per block × 5 `baseHeight`).
  - [DUP] debugCity.ts:131 `smooth` = conform.ts:82; L78–129 parallels conform.ts:18–80.
  - debugCity.ts:62 redundant condition (`tileId(..) !== tile || tileX(x) !== tx || tileX(z) !== tz`); L22 "106" and header "10 km" hard-wire MAP_SIZE assumptions.
  - [BUG] (inference) debugCity.ts:136 fixed capacity `14*14*12` boxes per tile with no bound check at L161–166 — overflows silently (typed-array writes past end are dropped) if tile size/BLOCK change.
- **Superfície pública:** `BLOCK`, `DEBUG_PROFILE`, `DEBUG_AVENUE`, `lineProfile`, `gridNodeHeight`, `DebugRoads`, `debugTileRoads`, `conformTileToGrid`, `debugTileBoxes`.
- **Exports nunca importados (b):** `BLOCK`, `DEBUG_PROFILE`, `DEBUG_AVENUE`, `gridNodeHeight`, `DebugRoads`

#### `src/jobs/ktxParse.d.ts`

- **Veredito: JUNTAR** → src/render/types.d.ts (uma declaração do módulo ktx-parse)
- **Evidência e regra (coordenador):** Declara o mesmo módulo que render/ktx-parse.d.ts com membros diferentes (conferido).
- **Responsabilidades (a-l):** L1–17 ambient type declaration for three's bundled `ktx-parse.module.js` (`read`, KTX2Container/Level).
- **Achados do leitor (a-l):**
  - [SMALL] ktxParse.d.ts — declaration only; header names "the finish loader" as user (caller not visible here).
  - (inference) [LAYER] ambient declaration for a texture library sits in `jobs/`; a types/shared place would fit better.
- **Superfície pública:** typings for module `three/examples/jsm/libs/ktx-parse.module.js`.

#### `src/jobs/lots.ts`

- **Veredito: MANTER** → src/jobs/lots.ts (comentários em inglês)
- **Evidência e regra (coordenador):** Lotes no worker; exactShift e facing varrem todos os segmentos do grafo por chamada e os lotes tomados (L109, L119, L140: O(lotes²) por célula); comentários em português.
- **Responsabilidades (a-l):** L1–4 header (Portuguese); L18–31 lot size tables by zone; L35–271 `buildLots`: L36–48 2 m occupancy grid, L50–67 roads marked, L69–83 junction retreats/corner marks, L85–121 exact clearance vs road curves/bulbs/taken lots, L123–132 zoned sides sorted by position hash, L134–174 closed-block lots via `blockLots`, L175–264 street-side lot cutting, L265–270 packing; L275–287 `curveDistance`; L290–304 `rectsOverlap`; L306–319 `lotFree`; L321–330 `markLot`.
- **Achados do leitor (a-l):**
  - [NAME] lots.ts:1–4, 29–30, 59, 68, 123, 177, 208, 213–214, 224, 234, 251 comments in Portuguese.
  - [OBJ] lots.ts:50–57 `Quad` object per segment, L87–91 `roads` object per segment, L70–71 `{s,end}` per arm, L124–131 `sides` objects — transient per-cell worker job.
  - [OMAP] lots.ts:109, 140 — `exactShift` and `facing` scan every segment of `g` per call; L119 scans every taken lot per call (O(lots²) per cell). Bounded only if `g` is the radius-limited network around the cell (header L1–2 says so; not verified here).
  - [ALLOC] lots.ts:104 `pts` array per `exactShift` call, L167/248 spread into `taken`, L228 literal arrays per depth try — worker job, not per frame.
  - [DEAD] lots.ts:197 ternary `span >= size.w[0] ? … : span` else-branch unreachable (L196 already `continue`s).
  - Magic: L61 +0.4, L82 maxHalf+4, L165/246 slope 10, L184 corner 2, L318 3 % busy, L222 back<3 — no source cited.
  - [R40COPY] lots.ts:187–188 quotes a 4.0 world/lots.ts comment (behaviour reference, not code).
- **Superfície pública:** `LOT_SIZE` (frontage/depth by zone), `buildLots(heights, graph, cell, water)` → `LotColumns`.

#### `src/jobs/meshBuilder.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Construtor de malha dos workers, fan-in 19; box() aloca tuplas por caixa (L96–112).
- **Responsabilidades (a-l):** L7–35 `MeshBuilder` growable SoA vertex/index buffers (pos, nrm, col, mat, tag, extra, facade); L37–55 growth; L57–73 `vert`; L76–91 `tri`/`quad` winding by wanted normal; L94–115 `box`; L122–158 `pack` to snorm16 / oct normal / u8 colour; L162–166 `packFuv`.
- **Achados do leitor (a-l):**
  - [ALLOC] meshBuilder.ts:96–101, 109, 112 `box()` allocates corner tuples and two `map` arrays per box — worker meshing inner loop.
  - meshBuilder.ts:135,144 normal stored as `Int8Array(n*4)` with only 2 oct components written — 2 of 4 bytes per vertex unused (inference: alignment padding).
  - [DEAD] meshBuilder.ts:9 `lod` never read in this file (set externally per comment).
  - meshBuilder.ts:164 facade uv scale 512 m hard-wired; values beyond ±512 m clamp.
- **Superfície pública:** `MeshBuilder` (vert/tri/quad/box/pack).

#### `src/jobs/parts40.ts`

- **Veredito: MOVER** → src/shared/contracts/parts.ts
- **Evidência e regra (coordenador):** Contrato de peças usado por jobs/props.ts e render/propMeshes.ts (render importando de jobs); duas tabelas pelas mesmas strings de tipo (L9–18, L58–66); comentário de faixa de tipos errado (L4).
- **Responsabilidades (a-l):** L5–6 pool type ids; L9–18 part kind → pool type/variant; L21–29 type lists, draw distances, range; L32–52 log-scale/yaw/colour codec (`partKey`, `partW`, `partScale`); L58–66 per-kind base colour/metal flag.
- **Achados do leitor (a-l):**
  - [TEXT] parts40.ts:9–18 and 58–66 — two tables keyed by the same part-kind strings (`'frame'`, `'acUnit'`, `'lotSlab'`…) that must match the kinds emitted by jobs/building40.ts; no shared enum.
  - [LAYER] parts40.ts:3 — used by jobs/props.ts and render/propMeshes.ts: render imports from `jobs/`; a shared contract belongs in `shared/`.
  - [DUP] parts40.ts:29 `PARTS_RANGE = 800 + 128` repeats max of `PART_DIST` (L26) by hand.
  - [NAME] parts40.ts:4 comment says types "24..29" but `BLot: 30` (L5); file named after "40".
- **Superfície pública:** `PART_PROP`, `POOL_PARTS`, `PART_TYPES`, `VARIANT_TYPES`, `PART_DIST`, `PARTS_RANGE`, `SCALE_MIN`, `SCALE_OCTAVES`, `partKey`, `partW`, `partScale`, `PART_BASE`.
- **Exports nunca importados (b):** `partScale` (nem no arquivo)

#### `src/jobs/pool.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Pool de workers; trabalhos cancelados ficam no heap até serem tirados e contam em isIdle/queued (L143, L153–155); ?workers=N lido no produto (L236–239); cancelamento por prefixo de texto da chave (L142).
- **Responsabilidades (a-l):** L1–5 header; L10–20 `Pending` job record; L23–55 binary min-heap by (priority, seq); L57–65 `SubmitOptions`; L70–230 `JobPool`: L87–90 broadcast (remembered for respawned workers), L93–114 construct/spawn workers, L116–136 submit/run with key dedup, L142–145 cancel by key prefix, L148–155 idle queries, L157–183 pump dispatch, L189–205 worker death/unreadable answer, L207–222 result delivery (stale/cancelled checks), L225–228 safe failure callback; L232–234 module worker factory; L237–240 worker count from cores or `?workers=`.
- **Achados do leitor (a-l):**
  - [BUG] pool.ts:143, 155 — cancelled jobs stay in the heap until popped, so `queued` (L155) and `isIdle` (L153) count them; `cancel()` never calls `pump()`, so idle waiters are only released on the next pool event (inference: a loading screen awaiting `whenIdle` right after `cancel` can wait for an unrelated job).
  - [ALLOC] pool.ts:124–127 one `Pending` object per job, L135 Promise per `run` — per job, not per frame.
  - [DEV] pool.ts:236–239 `?workers=N` URL switch "for photos and tests" read in product code (tooling hook).
  - [TEXT] pool.ts:142 cancellation by string key prefix (`startsWith`) — key naming convention shared with callers.
- **Superfície pública:** `SubmitOptions`, `JobPool` (`submit`, `run`, `broadcast`, `cancel`, `whenIdle`, `isIdle`, `queued`, `size`).

#### `src/jobs/props.ts`

- **Veredito: DIVIDIR** → src/jobs/props/items.ts (itens do jogador), signs.ts (placas e semáforos), lamps.ts (postes e fios), parked.ts (carros estacionados), plants.ts (vegetação)
- **Evidência e regra (coordenador):** Arquivo de 35,7 KB com cinco famílias; comentários em português; códigos de item numéricos soltos (L85–138); célula de 256 m fixa em vez de CELL_SIZE (L457–529); comentário de bits velho (L22 × L38–40).
- **Responsabilidades (a-l):** L1–4 header (Portuguese); L22–47 prop type enums (PROP, FURN, BARRIER, SIGN), packing consts, lamp spacing; L49–81 `Out` packer (cell ownership, yaw/scale/variant/key packing, 4.0 parts); L84–144 `placeItems` (player-placed items by numeric item code → props); L147 `propScale`; L154–167 crown radii and biome tree table; L170 `PropEnv`; L172–558 `buildProps`: L176–196 quads/junction retreats, L197–259 stop/yield/signal/name/roundabout signs, L262–417 per segment lamps + wires, speed/one-way signs, parked cars, street furniture, benches/bins, L419–443 cars in lot car parks, L445–453 4.0 building parts + yard props, L455–553 wild trees/shrubs by biome with road/lot occupancy grids; L560–563 `yAt`; L569–603 `lotYardProps`.
- **Achados do leitor (a-l):**
  - [MIX] props.ts — one 604-line file handles player item expansion, traffic signs and signals, lamps and wires, parked cars on streets and in lots, street furniture, 4.0 building parts dispatch (L448–452 calls `buildBuildingParts`), yard plants and the biome forest.
  - [NAME] Portuguese comments throughout: L1–4, 22, 27, 29, 31, 33, 35, 37, 39, 42, 54, 77, 83, 93, 100, 114, 120, 132, 146, 169, 197, 199, 225, 233, 245, 268, 288, 309, 321–322, 338, 349, 406, 409, 419, 425, 437, 526, 531, 537.
  - [NAME] props.ts:22 says "4 bits; 15 = free slot" but `Person: 15` (L23), `PROP_FREE = 31`, `TYPE_BITS = 5` (L38–40) — stale; L526 biome comment omits the palm share (5th field, L158).
  - [TEXT] props.ts:85–89, 92, 113, 118, 119, 124, 138 — player items decoded by bare numeric item codes (25 pole line, 43 person, 41, 30–40 ground, 20–25 barriers, 11 sign, 0–12 objects) that must match the item writer elsewhere; L92 handles 25 before L124's `20..25` range, so 25 in that range is unreachable (overlapping code meaning).
  - [TEXT] props.ts:271–274, 341 — strip behaviour chosen by string `strip.kind` (`'median'`, `'barrier'`, `'sidewalk'`, `'parking'`).
  - [BUG] (risk) props.ts:457, 486, 488, 528–529 — cell size hard-coded as 256 m (`W = 128` × `RES = 2`, `x0 + 256`) instead of `CELL_SIZE`; silently wrong if the cell size constant changes.
  - [DUP] props.ts:66–67 yaw quantization = parts40.ts:44–45 `partW`; L157 `CROWN_REACH` re-types 5.36 (CROWN_R palm) and 1.4 (BIOME_TREES Amazon scale) by hand; L176–196 quads/arcTables/arms/junctionRetreats block = lots.ts:50–83.
  - [ALLOC] props.ts:276–281 `frame()` returns a new object per call; L318 tuple per pole; L360, 397 tuple arrays per segment; L447 `number[]` per building; L520 literal array per `free()` call — worker job per cell, not per frame.
  - [OMAP] props.ts:320 `nearLamp` linear scan over the segment's lamp list per placement (small); L479–491 samples every segment of `g` every 2 m — bounded only if `g` is the cell's neighbourhood.
  - [R40COPY] props.ts:59, 356, 577 reference 4.0 behaviour ("Roadcraft's complete / basic / none", "the old generator's plants") — behaviour references, not code.
- **Superfície pública:** `PROP`, `PROP_TYPES`, `FURN`, `BARRIER`, `SIGN`, `WIRE_Y`, `PROP_FREE`, `TYPE_BITS`, `LAMP_FIRST`, `LAMP_STEP`, `propScale`, `PropEnv`, `buildProps`, `lotYardProps`.

#### `src/jobs/roadMesh.ts`

- **Veredito: DIVIDIR** → src/jobs/roadMesh/strips.ts, kerbs.ts, structures.ts (pontes, vigas, pilares), deadEnds.ts, zoneBand.ts
- **Evidência e regra (coordenador):** 45 KB, 21 responsabilidades; faixa de zona embutida na malha das vias e desenhada sempre (L286–305); uma caixa fechada por intervalo de ~3 m por viga (L420–435: geometria excessiva); vértices emitidos onde nenhum quad usa (L299–392); controles 9/10/11 e bit 8 como números soltos (L150, L237, L308).
- **Responsabilidades (a-l):** L1–7 header; L22–45 material ids, kerb/median heights, dropped-kerb and bridge constants (4.0 values); L49–62 `pierStations`, `bentColumns`; L64–119 strip colour/material/height/kerb width; L121–171 `buildRoadMesh` (quads, arc tables, dash phases, arms + setbacks, segments, bulbs/dead ends/junctions, pack); L174–181 `frameAt`; L183–523 `buildSegment`: L195–231 sampling + dropped kerb, L233–284 strip tops, L286–305 zone overlay band, L307–336 retaining walls, L338–381 kerb faces and skirts, L383–467 bridge deck/parapets/coping/girders/abutments/piers, L469–504 tunnel portals + wing walls, L506–522 raised-strip end caps; L526–535 `prism`; L537–540 `elevatedAny`; L546–584 `buildBulb`; L588–614 `cornerSection`/`cornerQuads`; L617–648 `buildDeadEnd`; L650–767 `buildJunction` (fillet/bevel corners, asphalt fan, kerb + footway corners).
- **Achados do leitor (a-l):**
  - [MIX] roadMesh.ts — 768 lines / 45 KB (close to the 50 KB new-file gate): carriageway strips, dropped kerbs, zone-tool overlay band, retaining walls, bridges (deck, parapet, girders, abutments, piers), tunnel portals and wing walls, bulbs, dead ends and junctions in one module; structures (L383–504) are a separable responsibility.
  - [TEXT] roadMesh.ts:150 `g.nctl[n] === 9 || === 10` (mid-block crossing), L237 `=== 11` (U-turn), L308 `g.sflags[s] & 8` (retaining wall) — bare control/flag codes instead of `Ctl`/`SegFlag` constants; L82–111, 235, 238, 256, 260, 364 behaviour by `strip.kind` strings.
  - [MIX] roadMesh.ts:286–305 zone overlay band ("shown with the zone tool only") baked into the road mesh: (inference) its triangles exist in every road mesh even when the zone tool is off — invisible geometry kept resident.
  - [BUG] excess geometry roadMesh.ts:420–435 — girders are one closed `box` per sample interval (≈3 m at LOD 0) per girder, each with its own end faces (meshBuilder.ts:102–108 builds all 4 sides), so every internal joint has two hidden faces; plus `bottom = true`.
  - [ALLOC]/excess roadMesh.ts:391–392, 299–300, 353 — deck, zone-band and wall vertices are emitted for every sample even where no quad uses them (non-bridge samples, elevated/hidden samples, non-railed parapet samples) — unused vertices in the packed mesh.
  - [ALLOC] roadMesh.ts:127–135 arrays/objects per segment end, L197 `Set` + L204 spread/sort, L240–242 arrays per edge, L316 object per `pt()` call, L549/656 `Float64Array` per bulb/junction, L557, 593–602, 657, 684 tuples/spreads per vertex section — worker meshing.
  - [NAME] roadMesh.ts:525 doc says the prism has "a top" but L526–534 builds sides only.
  - [DEAD] roadMesh.ts:617–618 `buildDeadEnd` parameter `q` unused (`void q`).
  - [R40COPY] roadMesh.ts:25, 30, 41, 396, 419, 437, 543, 668 cite 4.0 files (roadSurfaceReads.ts, curbRamps.ts, structures.ts, junction/bulb.ts, corners.ts) as sources of values — references, not copied code.
- **Superfície pública:** `RMAT`, `CURB_H`, `KERB_TOP`, `MEDIAN_TOP`, `PIER_SPACING_ELEVATED`, `PIER_SPACING_BRIDGE`, `pierStations`, `bentColumns`, `RoadCode`, `buildRoadMesh`.
- **Exports nunca importados (b):** `CURB_H`, `KERB_TOP`, `MEDIAN_TOP`

#### `src/jobs/roadPaint.ts`

- **Veredito: MANTER** → src/jobs/roadPaint.ts (comentários em inglês)
- **Evidência e regra (coordenador):** Pintura de longe das vias; teste de ponte/túnel duplicado de roadMesh.ts:215–217 com outro limiar (L75); perfil assimétrico pintado pelo meio (L42).
- **Responsabilidades (a-l):** L1–3 header (Portuguese); L16 coarse side; L19–31 `coarsen` (block-average RGBA tile to 32²); L33–90 `paintRoadTile` (per 4 m texel: asphalt share in R, sidewalk/median share in G, A = covered; skips bridges and tunnels).
- **Achados do leitor (a-l):**
  - [NAME] roadPaint.ts:1–3, 15, 18, 62 comments in Portuguese.
  - [BUG] roadPaint.ts:42 — `half` and `ah` are the mean of left/right widths and distance is measured from the centre line, so an asymmetric profile (left ≠ right) is painted symmetric about the centre line: the far-view paint is offset from the real road on one side.
  - [DUP] roadPaint.ts:75 bridge/tunnel test (`by - ground > 2`, `ground - by >= TUNNEL.portalDepth`) duplicates roadMesh.ts:215–217 with a different bridge threshold (2 m here vs 1.2 m `elevated` there) — (inference) a road 1.2–2 m above ground gets both a bridge deck and ground paint under it.
  - [OMAP] roadPaint.ts:64–71 — for each texel in a segment's box, a linear scan of all the segment's polyline pieces (texels × samples per segment); bounded per tile only if `g` is the tile's local network.
  - [ALLOC] roadPaint.ts:23 `[0,0,0,0]` per coarse texel; L40, 43, 46 objects/typed arrays per segment — worker job.
  - roadPaint.ts:84–88 channel B never written (always 0).
- **Superfície pública:** `PAINT_COARSE`, `coarsen`, `paintRoadTile`.

#### `src/jobs/storage.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Codificação do ladrilho; colunas por versão escolhidas por contagens soltas 16/12/11/7 (L73); encode escreve todas as colunas e decode lê até 16 (L21–35).
- **Responsabilidades (a-l):** L1–2 header; L9–17 magic + height quantization (cm, u16); L19–57 `encodeTile` (heights, box columns, roads v2, items v4, ground+water v5); L59–101 `decodeTile` with version migrations; L104–110 `packTileHeights`; L113–124 `unpackTileHeights`; L127–132 `widenSegs` (v2 → zones); L134–142 deflate-raw compress/decompress; L145–150 SHA-256 hex.
- **Achados do leitor (a-l):**
  - [TEXT] storage.ts:73 — the box columns saved per version are chosen by bare counts (`16 / 12 / 11 / 7`) of `boxColumnList` order; adding or reordering a column in shared/contracts silently breaks old-save decoding (no column ids in the file).
  - [BUG] (risk) storage.ts:21–22, 35 — `encodeTile` writes every column `boxColumnList` returns, while `decodeTile` (L73) reads at most 16 for version ≥ 7; a 17th column added without a `SAVE_VERSION` bump + decode branch is written but never read, and every later field would be read at the wrong offset.
  - storage.ts:59–101 — no length checks; a truncated file fails with a DataView RangeError rather than a clear message.
  - [LAYER] storage.ts:7 jobs imports `world/decay.ts`.
  - storage.ts:103 `packTileHeights` documented as run on the page (per tile, proportional to the tile).
- **Superfície pública:** `quantizeHeight`, `dequantizeHeight`, `HEIGHT_MAX_Q`, `encodeTile`, `decodeTile`, `packTileHeights`, `unpackTileHeights`, `compress`, `decompress`, `sha256`.

#### `src/jobs/terrainGen.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Terreno no worker; basinsNear aloca a cada land() (L52–53); hash2 local sombreia o de core/rng.ts (L58); cada worker refaz os mesmos lagos (L172–248).
- **Responsabilidades (a-l):** L1–9 header (4.0 river and lake sources); L16–41 river/canal/lake constants from 4.0; L44–55 lake basin per 2.2 km square; L57–72 4.0 value noise and bed profile; L80 `courseZ` (straight canal); L83–107 `land` (hills, valley, basins, edge ranges); L110–150 river level plan per seed (8 m steps, smoothed, monotone fall); L153–164 `riverAt`; L172–248 `lakeOf` (descent to bottom, priority flood to rim, BFS fill, shore ring); L249–257 neighbour tables, `lakesNear`; L263–265 flat-map seed bit; L268–275 `baseHeight`; L278–295 water level per sample / at point; L298–322 `generateTerrainTile`.
- **Achados do leitor (a-l):**
  - [ALLOC] terrainGen.ts:52–53 `basinsNear` allocates an array (and tuples from `basinOf`, L49) on every `land()` call; `baseHeight` → `land` is the hottest generation call (every height sample, cityGen.ts:44–45, debugCity.ts:32, plan L127–132 nine calls per step); L153 `riverAt` returns a new object per `baseHeight` call.
  - [R40COPY] terrainGen.ts:57–68 — `hash2`/`valueNoise` described as "4.0's value noise (`world/terrain.ts:65-84`)": algorithm reproduced from the 4.0 code (constants identical per comment).
  - [NAME] terrainGen.ts:58 local `hash2(x, y)` shadows the different `hash2(x, z, seed)` of core/rng.ts (used by debugCity.ts:149 etc.) — same name, different function.
  - [DEAD] terrainGen.ts:74 orphan doc comment ("The river's course: z of its middle at x.") immediately followed by a second doc for the same export (L75–79); `courseZ` ignores both parameters (L80) so `riverAt` slope (L160) is always 0.
  - [DUP] (inference) terrainGen.ts:172–248 each worker rebuilds the same lakes for the same seed (module cache is per worker).
- **Superfície pública:** `courseZ`, `FLAT_BIT`, `FLAT_Y`, `isFlat`, `baseHeight`, `waterLevelAt`, `generateTerrainTile`.
- **Exports nunca importados (b):** `FLAT_Y`, `isFlat`

#### `src/jobs/terrainSeams.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Recortes do terreno; o trabalho refaz a malha inteira das vias em LOD 0 só para ler os triângulos (jobs/worker.ts:53–58): segunda malhagem da mesma via por célula; teste de 'virado para cima' com Math.abs (L74–76).
- **Responsabilidades (a-l):** L1–19 header (method + ESRI breakline source); L27–44 seam constants, point kinds; L46–51 `TerrainSeams` result; L57–211 `buildTerrainSeams`: L60–84 bucket the road mesh's up-facing on-ground triangles per 4 m cell, L87–102 road surface height at a point, L104–134 corner cover + nearest-uncovered corner height, L136–209 per cut cell: holes, 0.5 m sub-squares, merged clear runs, bisected edge points, saddle case, fan; L210 pack.
- **Achados do leitor (a-l):**
  - [BUG] (inference) terrainSeams.ts:74–76 — the "faces up" test uses `Math.abs(ny)`, so down-facing triangles (bridge deck soffit at y − 1.3 m, roadMesh.ts:391–393; girder bottoms) pass it, and for a low bridge (deck 1.2–2.5 m over ground) their height is within ON_GROUND (1.2 m) of the ground: the terrain under a low bridge would be marked as covered (`holes`) and cut although no road surface is drawn on the ground there.
  - [DUP] (with worker.ts:56) the seam job meshes the whole lod-0 road graph again (`buildRoadMesh`) only to read its triangles — the same meshing the roadMesh job does for the cell.
  - [TEXT] terrainSeams.ts:68 — the zone overlay band is recognised by material id in the packed colour alpha (`& 15 === RMAT.Zone`): coupling to roadMesh's packing.
  - [ALLOC] terrainSeams.ts:65 `number[]` per bucket cell, L152–177 closures per cut cell, L190–194 arrays per cut sub-square — worker job.
- **Superfície pública:** `SEAM_SUB`, `SEAM_BELOW`, `POINT_GROUND`, `POINT_EDGE_X`, `POINT_EDGE_Z`, `POINT_SET`, `SEAM_CELLS`, `SEAM_PAD`, `TerrainSeams`, `buildTerrainSeams`.
- **Exports nunca importados (b):** `SEAM_BELOW`, `POINT_SET`, `TerrainSeams`

#### `src/jobs/worker.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Entrada do worker dos trabalhos; debugTile no worker de produção (L39–44).
- **Responsabilidades (a-l):** L1 header; L20–24 worker scope typing; L26–35 shared buffer views + guard; L37–105 handler per job kind (terrainGen, debugTile, buildingMesh, roadMesh, terrainSeams, roadPaint, lots, props, cityGen, conform, packTile, unpackTile); L107–123 message loop (init, profiles broadcast, job → done/error).
- **Achados do leitor (a-l):**
  - [DEV] worker.ts:39–44 `debugTile` (worst-case debug city, debugCity.ts) is a job kind of the production worker.
  - [DUP] worker.ts:53–58 `terrainSeams` calls `buildRoadMesh` on the graph at LOD 0 every time — a second full meshing of the same roads per cell (see terrainSeams.ts).
  - (inference) [BUG] worker.ts:38, 40, 77, 95 several job kinds write the shared height buffer per tile (`terrainGen`, `debugTile`, `conform`, `unpackTile`) from any worker; correctness depends on the page never running two of them on one tile at once (not enforced here).
  - worker.ts:81–82 slices the shared ground/water when the page sent none — page and worker may read different moments of the same tile.
  - [LAYER] worker.ts:3 jobs imports `roads/profiles` mutable custom-profile state (second copy per worker, set by broadcast).
- **Superfície pública:** none (module worker entry).

#### `src/main.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Entrada da página; status 'falhou' em português lido pelas ferramentas (L17); ?lang para fotos (L6–8).
- **Responsabilidades (a-l):** L5–19 page boot: language from `?lang` or storage, title/loading text, `bootGame` with the `Game` factory and failure hooks; L21 start.
- **Achados do leitor (a-l):**
  - [SMALL] main.ts — entry point, one function.
  - [TEXT] main.ts:17 `status.value = 'falhou'` — Portuguese magic status string, (inference) read by the test/photo tools that poll `status`.
  - [DEV] main.ts:6–8 `?lang=en|pt` switch "for photos and tests".
- **Superfície pública:** none.

#### `src/platform/audio.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Áudio do jogo.
- **Responsabilidades (a-l):** L5–17 `AmbientState` input; L19–164 `Ambient`: L32–63 lazy AudioContext, shared 2 s noise buffer, rain/wind/hum filtered loops, visibility suspend; L65–68 volume; L70–89 per-frame layer gains from game state + bird timer; L91–107 bird chirps; L110–138 one-shot effects (click, shot, boom, place, undo, build, demolish); L142–163 thunder delayed by distance.
- **Achados do leitor (a-l):**
  - audio.ts:70–81 `update` schedules five `setTargetAtTime` automation events every frame (per-frame Web Audio calls; (inference) the automation timeline gets a new event each frame).
  - [ALLOC] audio.ts:94–105, 114–128, 150–161 new nodes per chirp/effect/thunder — event-driven, not per frame.
  - [NAME] audio.ts:140–141 two stacked doc comments: the thunder method's doc sits above the `thunderVolume` field.
  - [TEXT] audio.ts:110 effect chosen by string kind (`'build' | 'demolish' | …`) — typed union, fine.
  - audio.ts:38 `visibilitychange` listener added once, never removed (lives with the page).
- **Superfície pública:** `AmbientState`, `Ambient` (`start`, `setVolume`, `update`, `sfx`, `thunder`, `volume`, `thunderVolume`).
- **Exports nunca importados (b):** `AmbientState`

#### `src/platform/mapExtra.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Codec único do extra do mapa (commit fae9836); padrão 'ciclo' em português (L36).
- **Responsabilidades (a-l):** L1–4 header; L6–22 `MapExtra` shape (sky, weather, water, clouds, fog, terminals, signs, streets, clock, paint, unlimited money); L24 encode; L26–28 validators; L31–48 field-by-field decode with defaults.
- **Achados do leitor (a-l):**
  - [TEXT] mapExtra.ts:36 default sky mode is the Portuguese string `'ciclo'` — (inference) must match the sky mode names used by the sky code.
  - mapExtra.ts:39–43 no size limits on lists (clouds, signs, streets) from a file.
- **Superfície pública:** `ExtraWeather`, `ExtraWater`, `ExtraCloud`, `MapExtra`, `encodeExtra`, `decodeExtra`.
- **Exports nunca importados (b):** `ExtraWeather`, `ExtraWater`, `ExtraCloud`

#### `src/platform/mapFile.ts`

- **Veredito: DIVIDIR** → src/platform/mapFile.ts (formato do pacote) + SaveActions para src/features/save/actions.ts
- **Evidência e regra (coordenador):** Interface de ações do HUD declarada no módulo do formato de arquivo (L222–227); MAGIC 'CIDADE-MAPA-1' e pastas 'anterior'/'quarentena' em português, analisadas por fatiamento de texto (L198, L210); manifesto sem conferência de forma (L85–87).
- **Responsabilidades (a-l):** L1–4 header; L13–16 `MapFileError` (i18n key); L19–31 `packFiles`; L34–37 `packSlot`; L40–60 `readPackage` (bounds + name checks); L63–100 `savedIn` (generation or legacy save, checked); L103–128 folder naming/listing/pruning; L135–150 `keepPreviousCity`; L158–184 `quarantineSlot` (dedup by key); L186–203 `previousCities`; L209–219 `restorePrevious`; L222–227 `SaveActions` interface for the HUD.
- **Achados do leitor (a-l):**
  - [NAME] mapFile.ts:10 `MAGIC = 'CIDADE-MAPA-1'`, folder prefixes `'anterior'` / `'quarentena'` (L3–4, 146, 170, 175, 191, 198, 210) are Portuguese identifiers in file formats.
  - [TEXT] mapFile.ts:198, 210 the folder prefix `'anterior-'` is parsed back by string slicing (`slice('anterior-'.length, … + 19)`) — format coupled to `stamp()` (L103).
  - [BUG] mapFile.ts:85–87 — the manifest JSON is cast without checks; a manifest without `tiles` or `meta` throws a TypeError, not a `MapFileError` with a player key (savedIn's contract, L66–69).
  - [MIX] mapFile.ts:222–227 — HUD action interface (`SaveActions`) declared in the platform file-format module.
  - [LAYER] mapFile.ts:8 platform imports `sha256` from `jobs/storage.ts`.
- **Superfície pública:** `MapFileError`, `packFiles`, `packSlot`, `readPackage`, `PackedSave`, `savedIn`, `QUARANTINE_UNREADABLE_TILES`, `keepPreviousCity`, `quarantineSlot`, `PreviousCity`, `previousCities`, `restorePrevious`, `SaveActions`.

#### `src/platform/save.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Meta do save; decodificação do conjunto de bits de ladrilhos escrita duas vezes (L46, L94).
- **Responsabilidades (a-l):** L1–2 header; L9–28 `SaveMeta`; L31–34 `MapSizeError`; L40–48 `metaHeader` (any map size); L50–80 `encodeMeta`; L82–127 `decodeMeta` (optional trailing fields by remaining length).
- **Achados do leitor (a-l):**
  - [DUP] save.ts:46 and 94 the same tile bit-set decode written twice.
  - [TEXT] save.ts:18–27 profiles, junctions and extra stored as free JSON strings inside the binary meta (schemas live elsewhere).
  - save.ts:67 default hour `10` and L73 `NaN` money sentinel (older "sandbox" meaning, L20) — magic values.
  - save.ts:96–98 no bounds check before reading the camera array: a cut file raises a raw RangeError.
- **Superfície pública:** `SaveMeta`, `MapSizeError`, `metaHeader`, `encodeMeta`, `decodeMeta`.
- **Exports nunca importados (b):** `SaveMeta`

#### `src/platform/saveFiles.ts`

- **Veredito: DIVIDIR** → src/platform/saveStore/browser.ts, desktop.ts, migrate.ts, lock.ts (várias abas), generation.ts
- **Evidência e regra (coordenador):** 29 KB com dois backends, migração, trava entre abas e formato da geração.
- **Responsabilidades (a-l):** L1–13 header (generation/commit design); L18–43 `FileStore` interface, `StoreError`, `checkName`; L47–119 `OpfsStore`; L124–154 `FilesBridge` + `AppStore` (Electron IPC); L157–182 one-time OPFS → files migration; L189–210 `SlotLock` (navigator.locks writer tab); L216–229 `openSaveStore`; L234–290 generation records and file naming; L293–304 `limiter`; L307 `TileFileError`; L310–487 `SaveSlot` (open/fallback, legacy, checks, readTile, begin, copy, pack, adopt); L490–542 `SaveWriter` (tiles, commit, cleanup); L545 `KeptFileMissing`.
- **Achados do leitor (a-l):**
  - [MIX] saveFiles.ts — 546 lines / 29 KB: two storage backends, migration, multi-tab locking, and the generation format in one module.
  - [BUG] (inference) saveFiles.ts:430–434 + 536–538 — `begin()` numbers a writer above every file present; if a second save begins while a first commit runs its cleanup, the cleanup deletes the second writer's freshly written tile files (not in `keep`), and the second `commit` only re-checks *kept* files (L520–523), so it can commit a manifest naming deleted tiles. Safe only if callers serialize saves (not enforced here).
  - [LAYER] saveFiles.ts:16 platform imports `sha256` from `jobs/storage.ts`.
  - [NAME] saveFiles.ts:195, 217 desktop bridge global `roadcraftApp` vs steam.ts:5 `cidadeSteam` — two naming schemes for the preload globals.
  - saveFiles.ts:93 `list()` awaits `getFile()` per entry sequentially (size of every file to list a folder).
- **Superfície pública:** `FileEntry`, `FileStore`, `StoreError`, `checkName`, `OpfsStore`, `FilesBridge`, `AppStore`, `MIGRATED`, `migrateOnce`, `SlotLock`, `openSaveStore`, `FileRef`, `Generation`, `Opened`, `CURRENT`, `WRITES_AT_ONCE`, `limiter`, `TileFileError`, `SaveSlot`, `SaveWriter`, `KeptFileMissing`.

#### `src/platform/steam.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Ponte do Steam; global 'cidadeSteam' em português ao lado de 'roadcraftApp' (L5).
- **Responsabilidades (a-l):** L3 bridge type; L5–6 bridge lookup + session set; L9–13 `achieve`; L15–18 `steamName`.
- **Achados do leitor (a-l):**
  - [SMALL] steam.ts — two functions over the Electron preload bridge.
  - [NAME] steam.ts:5 preload global `cidadeSteam` (Portuguese; desktop file bridge is `roadcraftApp`, saveFiles.ts:217).
  - [TEXT] steam.ts:9 achievements by free string id.
- **Superfície pública:** `achieve(id)`, `steamName()`.

#### `src/r40/api.ts`

- **Veredito: APAGAR** → — (cada consumidor importa do dono novo depois da reescrita do r40)
- **Evidência e regra (coordenador):** Fachada do subsistema copiado do 4.0, com subcamadas world/ e render/ próprias (L3–15); exporta uma segunda Rng (L2).
- **Responsabilidades (a-l):** L1–21 public façade of the r40 subsystem: re-exports Rng, building generation (`madeToMeasure`, lot planning/furnishing), building meshing (chunks, massing, part kit, cell arrays, poses, shell looks), materials, geometry/foundation helpers, interior furniture, and their types.
- **Achados do leitor (a-l):**
  - [LAYER] r40/api.ts:3–15 the r40 layer carries its own `world/` and `render/` sub-layers and exports both world planning and render meshing through one façade.
  - [DUP] r40/api.ts:2 exports a second `Rng` (`r40/core/rng.ts`) beside `core/rng.ts` `Rng` (used by jobs/*).
  - [R40COPY] r40/ — the folder is the 4.0 building subsystem (names `Building`, `RoofKind`, `furnishLot`, `planLot`…); (inference) structure follows 4.0's own tree (world/buildings, render/buildings).
- **Superfície pública:** `Rng`, `madeToMeasure`, `furnishLot`, `lotKind`, `planLot`, `emitChunk`, `letGoEmitted`, `PLATE_DETAIL`, `TILE_DETAIL`, `emitMassing`, `partGeometries`, `COLOURED_PARTS`, `COLOUR_RANGE`, `PAINT_UNIT`, `NORMAL_UNIT`, `POSE_FLOATS`, `LOOK_FLOATS`, `FINISHES`, `roofMaterial`, `wallMaterial`, `levelElevation`, `levelHeight`, `localToWorld`, `volumeElevation`, `floorHeight`, `interiorFurniture`, `createFurnitureGeometries`; types `PartKind`, `Building`, `RoofKind`, `BuildingChunk`, `PartBatch`, `MassDetail`, `MassingChunk`, `GroundAt`, `PavedAt`.
- **Exports nunca importados (b):** `BuildingChunk` (nem no arquivo), `PartBatch` (nem no arquivo), `MassDetail` (nem no arquivo), `MassingChunk` (nem no arquivo), `GroundAt` (nem no arquivo), `PavedAt` (nem no arquivo)

#### `src/r40/core/aabb.ts`

- **Veredito: APAGAR** → —
- **Evidência e regra (coordenador):** Só pads.ts importa, e só como tipo (script de alcance): o código nunca roda.
- **Responsabilidades (a-l):** L3–8 `Aabb` record; L10–22 from `Vec2[]`; L25–39 from flat xy buffer; L41–46 `expand`.
- **Achados do leitor (a-l):**
  - [ALLOC] aabb.ts:21, 38, 41–46 a new object per call (immutable records); `fromPoints` takes `Vec2` objects (one object per point).
  - [R40COPY] aabb.ts:31–32 `as number` casts on typed-array reads — the 4.0 code style (noUncheckedIndexedAccess); (inference) carried over from 4.0's core.
  - [DUP] (inference) generic box helper; core/ has its own spatial types.
- **Superfície pública:** `Aabb`, `fromPoints`, `fromFlat`, `expand`.
- **Exports nunca importados (b):** `fromPoints` (nem no arquivo), `fromFlat` (nem no arquivo), `expand` (nem no arquivo)

#### `src/r40/core/forkMap.ts`

- **Veredito: MOVER** → src/core/forkMap.ts
- **Evidência e regra (coordenador):** Mapa com cópias de trabalho; contador global de medição no código de biblioteca (L45, L176); comentários cortados no meio (L64, L100, L175).
- **Responsabilidades (a-l):** L2–108 `ForkMap` copy-on-write Map over a read-only base (replaced/added/gone, `writable` copy-on-first-write, `changes`, `applyTo`); L111–173 `ForkSet` over `ForkMap<K,true>`; L176 `forkWork` counter.
- **Achados do leitor (a-l):**
  - [DEV] forkMap.ts:176 global work counter (measurement hook) mutated from library code (L45).
  - [NAME] forkMap.ts:64, 100, 175 doc comments cut mid-sentence ("it marks every key below", "…held", L175 "The work of the working copies , and the lists and indices a document's fork copies when it writes them: records") — garbled/truncated docs.
  - forkMap.ts:115–121 `ForkSet` passes a partial object cast `as unknown as ReadonlyMap` (only get/has/size/iterator/keys) — works only because ForkMap uses no other member.
  - forkMap.ts:71–77 iteration order differs from a real Map (re-added keys move to the end).
- **Superfície pública:** `ForkMap`, `ForkSet`, `forkWork`.
- **Exports nunca importados (b):** `ForkSet` (nem no arquivo), `forkWork`

#### `src/r40/core/hypot.ts`

- **Veredito: JUNTAR** → src/core/math.ts
- **Evidência e regra (coordenador):** Substitui Math.hypot só no r40 enquanto o resto usa Math.hypot nos laços quentes.
- **Responsabilidades (a-l):** L1–4 rationale (V8 `Math.hypot` builtin boxes its result; source `src/builtins/math.tq`); L7–24 `hypot2`; L27–48 `hypot3` (bit-exact Kahan-summed reimplementation).
- **Achados do leitor (a-l):**
  - [DUP] hypot.ts — replaces `Math.hypot`, which the rest of this batch uses freely in hot worker loops (jobs/lots.ts, roadMesh.ts, terrainSeams.ts); two conventions in one codebase.
  - [NAME] hypot.ts:1 all-caps header doc.
- **Superfície pública:** `hypot2`, `hypot3`.

#### `src/r40/core/identityMemo.ts`

- **Veredito: DIVIDIR** → memo → src/core/memo.ts; contador → junto do seu único uso
- **Evidência e regra (coordenador):** Dois ajudantes sem relação; o nome só cobre o primeiro.
- **Responsabilidades (a-l):** L2–10 `identityMemo` (WeakMap memo by object identity); L13–16 `uniqueCounter`.
- **Achados do leitor (a-l):**
  - [SMALL] identityMemo.ts — two unrelated helpers; [MIX] counter has nothing to do with memoization; file name only covers the first.
  - [NAME] identityMemo.ts:13 doc sentence lacks its end ("a stamp that must not match any other's").
- **Superfície pública:** `identityMemo`, `uniqueCounter`.

#### `src/r40/core/intersect.ts`

- **Veredito: JUNTAR** → src/core/geom2d.ts (com as distâncias de cityGen.ts:189–194, conform.ts:49–52 e lots.ts)
- **Evidência e regra (coordenador):** Interseções que alocam Vec2 por chamada (L14–64); mesmas contas repetidas em jobs/.
- **Responsabilidades (a-l):** L5–18 `lineLine`; L21–36 `segSeg`; L39–54 `closestOnSegment`; L57–68 `inForwardSlab` — all on `Vec2` objects.
- **Achados do leitor (a-l):**
  - [ALLOC] intersect.ts:14–17, 27–35, 44–53, 64 every call allocates `Vec2` objects via `sub/add/scale` and a result object; polygon.ts:7 records this cost ("it makes vectors each call: 21 s of the tile workers' junction rings").
  - [NAME] intersect.ts:4 doc cut mid-sentence ("…the infinite line through `b0` with direction").
  - [DUP] (inference) segment/point distance and intersection exist again in jobs (cityGen.ts:189–194, conform.ts:49–52, lots.ts curveDistance) on raw numbers.
- **Superfície pública:** `lineLine`, `segSeg`, `closestOnSegment`, `inForwardSlab`.
- **Exports nunca importados (b):** `lineLine` (nem no arquivo), `closestOnSegment` (nem no arquivo), `inForwardSlab` (nem no arquivo)

#### `src/r40/core/minMax.ts`

- **Veredito: JUNTAR** → src/core/math.ts
- **Evidência e regra (coordenador):** Duas funções de uma linha com um chamador (cellArrays.ts).
- **Responsabilidades (a-l):** L6 `least` (bit-exact Math.min of two); L9 `most` (bit-exact Math.max of two).
- **Achados do leitor (a-l):**
  - [SMALL] minMax.ts — two one-line functions; header L2–3 names the caller (`cellArrays.ts` `boxOfInstances`).
  - [DUP] minMax.ts — same micro-optimisation convention as hypot.ts, not used by the jobs/ code in this batch.
- **Superfície pública:** `least`, `most`.

#### `src/r40/core/polygon.ts`

- **Veredito: JUNTAR** → src/core/polygon.ts (com jobs/buildingGen/polygon.ts inPolygon)
- **Evidência e regra (coordenador):** pointInPolygon igual a inPolygon de jobs/buildingGen/polygon.ts (L40–51); convexHull devolve a entrada sem orientar para menos de 4 pontos (L55).
- **Responsabilidades (a-l):** L5 box gap; L8–27 `isSimple` (edge boxes prefilter, then `segSeg`); L29–37 `signedArea`; L40–51 `pointInPolygon`; L54–90 `convexHull` (monotone chain).
- **Achados do leitor (a-l):**
  - [DEV] polygon.ts:7 doc cites a profiling run ("21 s … in an opening, wprof5") — measurement note in product code.
  - [BUG] polygon.ts:55 — for fewer than 4 points `convexHull` returns the input unchanged, not "wound to positive signed area" as documented (L53): a clockwise triangle comes back clockwise.
  - [DUP] polygon.ts:40–51 `pointInPolygon` duplicates `inPolygon` in jobs/buildingGen/polygon.ts (imported by jobs/props.ts:20).
  - polygon.ts:17–25 still O(n²) edge pairs (boxes only skip the `segSeg` call).
- **Superfície pública:** `isSimple`, `signedArea`, `pointInPolygon`, `convexHull`.

#### `src/r40/core/rng.ts`

- **Veredito: JUNTAR** → src/core/rng.ts (um gerador só)
- **Evidência e regra (coordenador):** Segunda classe Rng com outro algoritmo além de src/core/rng.ts:18 (L6); mulberry32 que o comentário proíbe copiar está copiado em facadePropModels.ts:109–117 e facadeProps.ts:65–70; closure por u32() (L42).
- **Responsabilidades (a-l):** L2–3 `RngState` type; L5–106 `Rng` xoshiro128** seeded by splitmix32 (state/fromState L29–39, u32 L41–54, float/range/int/bool/pick/normal/weighted L56–96, fork by string tag L98–105); L108–118 `mulberry32` closure generator
- **Achados do leitor (a-l):**
  - `[DUP]` rng.ts:6 — a second `Rng` class exists in `src/core/rng.ts:18` (mulberry32-based, different algorithm). `r40/api.ts:2` re-exports this one, so the codebase has two incompatible `Rng` types under the same name.
  - `[DUP]` rng.ts:108 — its comment forbids copying `mulberry32`, but the same body is still inlined at `r40/render/buildings/facadePropModels.ts:109-117` (`leafStream`), `r40/render/buildings/facadeProps.ts:65-70`, `r40/world/buildings/roofPlant.ts:86`, `world/roofPlant.ts:68`, `render/treeMeshes.ts:31` and `core/rng.ts:22`.
  - `[ALLOC]` rng.ts:42 — `u32()` creates the closure `rot` on every call. The cost depends on how hot the callers are (inference: per draw in generation workers).
  - `[ALLOC]` rng.ts:30 — `state()` returns a new array on every call (meant for messages, so this is acceptable).
  - `[R40COPY]` the file lives under `r40/` (the 4.0 subsystem). Nothing in it says it was copied.
- **Superfície pública:** `RngState`, `Rng` (deterministic stream, forkable, serialisable), `mulberry32`
- **Exports nunca importados (b):** `RngState`, `mulberry32` (nem no arquivo)

#### `src/r40/core/scalar.ts`

- **Veredito: DIVIDIR** → tolerâncias → src/core/scalar.ts; constantes de via (MITER_LIMIT, CORNER_MITER, MIN_RIBBON, SEAM_OVERLAP, SURFACE_END_STEP) → src/roads/tuning.ts
- **Evidência e regra (coordenador):** Constantes de via num módulo genérico (L35–51); 16 exports mortos; outros arquivos usam 1e-6 solto em vez dele.
- **Responsabilidades (a-l):** L5–51 numeric tolerances and geometry constants (EPS, GEO_EPS, DIV_EPS, miter/taper/flatten tolerances, ribbon/seam sizes); L53–72 helpers `steadyRatio`, `clamp`, `hypot2`, `lerp`, `normalizeAngle`
- **Achados do leitor (a-l):**
  - `[DUP]` other files in this batch ignore it and use bare literals: `buildingMesh.ts:294` (`1e-6`), `facadeEmit.ts:82` (`sameLength`, `1e-6`), `facadeEmit.ts:234` (`1e-6`), `facadeEmit.ts:408,446` (`1e-4`), `elementMesh.ts:375,387,395` (`1e-6`), `elementMesh.ts:614` (`1e-6`).
  - `[MIX]` scalar.ts:35–51 — road-specific constants (MITER_LIMIT, CORNER_MITER, MIN_RIBBON, SEAM_OVERLAP, SURFACE_END_STEP) sit in a generic `core` file (minor).
- **Superfície pública:** the tolerance constants listed above, plus `steadyRatio`, `clamp`, `hypot2`, `lerp`, `normalizeAngle`
- **Exports nunca importados (b):** `COARSE_EPS` (nem no arquivo), `FINE_EPS` (nem no arquivo), `MIN_ITER_STEP` (nem no arquivo), `SIN_EPS` (nem no arquivo), `ACUTE_EPS` (nem no arquivo), `MITER_LIMIT` (nem no arquivo), `CORNER_MITER` (nem no arquivo), `FLATTEN_TOL` (nem no arquivo), `ARC_TOL` (nem no arquivo), `TAPER_ANGLE` (nem no arquivo), `MIN_RIBBON` (nem no arquivo), `SEAM_OVERLAP` (nem no arquivo), `SURFACE_END_STEP` (nem no arquivo), `hypot2` (nem no arquivo), `lerp` (nem no arquivo), `normalizeAngle` (nem no arquivo)

#### `src/r40/core/units.ts`

- **Veredito: APAGAR** → — (m() e perM() são a identidade: METERS_PER_UNIT = 1, L2)
- **Evidência e regra (coordenador):** Funções identidade mantidas por história (L2, L11–12); comentários cortados no meio (L8, L14).
- **Responsabilidades (a-l):** L1–19 the world unit system (`METERS_PER_UNIT`=1, `m`, `perM`, `TUNED_UNIT`, `stepsIn`, `kmh`)
- **Achados do leitor (a-l):**
  - `[SMALL]` 20 lines. It is re-exported unchanged by `r40/world/units.ts:2` ("where world, sim, editor, render and ui have always imported it from"), so there are two import paths for one module. Every render file in this batch imports `../../world/units.ts`, not `core/units.ts`.
  - `[DEAD]` (inference) units.ts:2 — `METERS_PER_UNIT` is 1, so `m()` and `perM()` are identity functions kept for history (`TUNED_UNIT` L11–12 "until it moved to metres").
  - `[NAME]` units.ts:8 — the comment is cut off mid-sentence ("into the same per"). Line 14 is cut off the same way.
- **Superfície pública:** `METERS_PER_UNIT`, `UNITS_PER_METER`, `m`, `perM`, `TUNED_UNIT`, `stepsIn`, `kmh`

#### `src/r40/core/vec2.ts`

- **Veredito: JUNTAR** → src/core/vec2.ts (com versões com saída `out` sem alocação)
- **Evidência e regra (coordenador):** Todo ajudante devolve um {x,y} novo (L9–46), importado por 19 arquivos; addScaled diz evitar alocação mas aloca (L42).
- **Responsabilidades (a-l):** L4–7 the `Vec2` interface; L9–46 immutable vector helpers (add/sub/scale/neg/dot/cross/len/dist/perp/normalize/lerpVec/angleOf/fromAngle/addScaled)
- **Achados do leitor (a-l):**
  - `[ALLOC]` vec2.ts:9–46 — every helper except dot/cross/len returns a new `{x,y}` object. It is imported by 16 files under `src` (count from `grep "from '.*core/vec2"`), so any hot loop that uses it allocates per call.
  - `[NAME]` vec2.ts:42 — the comment on `addScaled` says it avoids an allocation "at the call site", but it still allocates one object.
  - `[OBJ]` (inference) `Vec2` objects are the point representation for footprints and rings (for example `elementMesh.ts:344–351`) instead of typed arrays.
- **Superfície pública:** `Vec2`, `add`, `sub`, `scale`, `neg`, `dot`, `cross`, `lenSq`, `len`, `dist`, `perp`, `normalize`, `lerpVec`, `angleOf`, `fromAngle`, `addScaled`
- **Exports nunca importados (b):** `neg` (nem no arquivo), `len` (nem no arquivo), `dist` (nem no arquivo), `perp` (nem no arquivo), `normalize` (nem no arquivo), `lerpVec` (nem no arquivo), `angleOf` (nem no arquivo), `fromAngle` (nem no arquivo), `addScaled` (nem no arquivo)

#### `src/r40/render/bake/finishRecipes.ts`

- **Veredito: MOVER** → src/render/bake/finishRecipes.ts
- **Evidência e regra (coordenador):** Receitas de acabamento cozidas na build; cellHash com os multiplicadores de facadeEmit.ts:173 bayHash (L24–28).
- **Responsabilidades (a-l):** L9–21 `FinishLook` record; L23–29 `cellHash`; L31–47 `grey` and running-bond helper `bond`; L49–372 per-finish procedural texture recipes (roofing, stucco, panel, slate, plaster, ceramic, brick, stone, concrete, wood, metal, glass, tile); L374–382 `FINISH_LAYER_SIZE` and `finishTiles`
- **Achados do leitor (a-l):**
  - `[ALLOC]` finishRecipes.ts:38–46 — `bond()` returns a new object per texel (brick L197, stone L226). This runs at build-time bake (`scripts/vite/surface-bake-plugin.ts`, L5) and in `finishes.ts:225–244` `finishAlbedo` (48×48 samples per finish), which `massing.ts` calls.
  - `[DUP]` finishRecipes.ts:24–28 — `cellHash` uses the same multipliers (0x27d4eb2d, 0x165667b1, 0x85ebca6b) as `facadeEmit.ts:173` `bayHash` and `shellParts.ts:43`. It is a family of hand-copied hashes rather than one helper.
  - `[TEXT]` the finish names (`'roofing'`, `'glass'`, ...) are the `Finish` union keys, and `finishes.ts:28–29` branches on them by string.
- **Superfície pública:** `LOOKS` (recipe per finish; used by jobs/buildingFinishes, finishes.ts, signature.ts, render/city.ts), `FINISH_LAYER_SIZE`, `finishTiles`
- **Exports nunca importados (b):** `FINISH_LAYER_SIZE`

#### `src/r40/render/buildings/buildingMesh.ts`

- **Veredito: DIVIDIR** → src/jobs/buildingMesh/emitBuilding.ts (emissão no worker) + APAGAR a montagem de malhas na thread principal (assembleBuildingMeshes, meshesOf, buildBuildingMeshes, withShellParts, shellPartFaces…)
- **Evidência e regra (coordenador):** 44 KB, 22 responsabilidades; 31 exports mortos — a montagem na thread principal (L536–764) não tem chamador fora do arquivo; flagSink global ligado e desligado em volta de emitBuilding sem try/finally (L370–377).
- **Responsabilidades (a-l):** - L35–47 interfaces - L49–316 `emitBuilding`, all of one building's geometry: plinth L88–121, facade bays L123–219, reliefs L221–224, bands L226–242, roofs L244–250, entrance steps L252–283, lot L286, free elements L288–306, machine rooms L308–314 - L318–334 helpers (`MACHINE_ROOM`, `fliesFlag`, `signatureFloorOf`, `letGoEmitted`) - L336–349 `ShellWriter` - L351–394 `emitChunk` (one building into typed-array chunks) - L396–421 `chunkSummary` - L423–443 shell/run chunk copy-or-view - L445–511 `shellPartFaces` and `withShellParts` (instanced shell parts baked back into faces) - L513–532 `kitBoxes` - L534–743 `assembleBuildingMeshes` and `meshesOf` (three.js Mesh and InstancedMesh assembly, GPU-only attributes, dispose) - L745–753 bounds helpers - L755–764 `buildBuildingMeshes` - L766–772 re-exports
- **Achados do leitor (a-l):**
  - `[MIX]` buildingMesh.ts:49–421 vs 536–764 — worker-side emission (`emitBuilding`/`emitChunk`) sits in one 773-line, 44 KB file with main-thread three.js mesh assembly (`meshesOf` builds `Mesh`/`InstancedMesh`/`Group`).
  - `[DEAD]` no caller outside this file for `assembleBuildingMeshes`, `meshesOf`, `buildBuildingMeshes`, `withShellParts`, `shellPartFaces`, `chunkSummary`, `fliesFlag`, `signatureFloorOf`, `kitBoxes`, `KIT_BOXES`, `WHOLE`, `gridBounds`, `boxOf`, `sphereOf`, `MACHINE_ROOM` (only internal), `runChunks`, `shellChunks`. `ShellWriter` is also named in `meshCore.ts`, probably only in a comment (not checked). `r40/api.ts:5,14` exposes only `emitChunk`, `letGoEmitted` and `interiorFurniture`, and the only external caller is `jobs/building40.ts:153` (`emitChunk`). Roughly L396–764 looks unreachable from the product.
  - `[MAIN]` buildingMesh.ts:755–764 — `buildBuildingMeshes` emits every building of an iterable synchronously and then assembles meshes. It has no caller (dead), but it would be whole-set meshing on the caller's thread.
  - `[OBJ]` buildingMesh.ts:49–50 — emission walks a per-building `Building` object graph (volumes, storeys, elements, reliefs). `emitChunk` L374 spreads `{ ...resolved, volumes: closed }` for each building.
  - `[ALLOC]` emission path, per building, inside workers:
  - Maps: `entrances` L68, `notches` per volume L92, `componentAt` L126, `volumes` L128, `roomsOf` L130
  - `paint({...})` objects created per bay: L152–153 (observation grammar) and L164 (cutaway inner wall)
  - a spread `BayFace` per entrance at L259
  - `emitChunk` L389–393 chains 4–5 object spreads per building
  - `[ALLOC]` buildingMesh.ts:459–475 — `shellPartFaces` creates an `at` closure per instance and a `points.map` array per face per instance (dead path).
  - `[TEXT]` grammar strings decide geometry: buildingMesh.ts:149 `'observation'`, L204/207 `'artDecoCrown'`/`'artDeco'`, plus `'metal'`/`'plaster'`/`'glass'` finish checks at L81, 83, 313.
  - `[HOST]` buildingMesh.ts:180–184 and 197–200 — `shell.ground` and `e.flat`, `e.slot`, `e.room` on the emitter are mutated around each call as implicit parameters.
  - `[BUG]` (inference) buildingMesh.ts:370–377 — the flag sink is global: `setFlagSink(flags)` … `setFlagSink(null)`. If `emitBuilding` throws, the sink stays set, and the next building's flags land in the previous array.
  - `[NAME]` buildingMesh.ts:162 — comment "walled as The Sims walls it".
  - `[R40COPY]` buildingMesh.ts:1 — "Part of the R40 building mesh pipeline (split by responsibility)". Other files cite "4.0 buildingMesh.ts:1659" (render/city.ts:467), so this file is the 4.0 mesher split up.
- **Superfície pública:** `emitBuilding`, `emitChunk` (used via api), `letGoEmitted`, `chunkSummary`, `ShellWriter`, `shellChunks`/`runChunks`/`shellChunkOf`, `shellPartFaces`/`withShellParts`, `kitBoxes`, `assembleBuildingMeshes`/`meshesOf`/`buildBuildingMeshes`, bounds helpers; re-exports `COLOURED_PARTS`, `FLAT_DEPTH`, `lotGroundAgain`, `interiorFurniture`, chunk types
- **Exports nunca importados (b):** `BuildingChunk`, `LotGround`, `LotGroundRecipe` (nem no arquivo), `PartBatch`, `COLOURED_PARTS` (nem no arquivo), `FLAT_DEPTH`, `SlotAllocator`, `lotGroundAgain` (nem no arquivo), `BuildingMeshes`, `AssemblySelection`, `emitBuilding`, `MACHINE_ROOM`, `fliesFlag`, `signatureFloorOf` (nem no arquivo), `ShellWriter`, `chunkSummary` (nem no arquivo), `shellChunkOf`, `shellChunks`, `runChunks`, `SHELL_PART_MATRIX`, `shellPartFaces`, `withShellParts` (nem no arquivo), `KIT_BOXES`, `kitBoxes`, `WHOLE`, `assembleBuildingMeshes`, `meshesOf`, `gridBounds`, `boxOf`, `sphereOf`, `buildBuildingMeshes` (nem no arquivo)

#### `src/r40/render/buildings/cellArrays.ts`

- **Veredito: DIVIDIR** → src/jobs/buildingMesh/nearArrays.ts + src/jobs/buildingMesh/farMass.ts (com massing.ts)
- **Evidência e regra (coordenador):** Fusão dos níveis de longe (L225–346) dentro do arquivo dos lotes de perto; onGrid e massOnGrid com o mesmo laço (L56–71 × L275–287); 22 exports mortos.
- **Responsabilidades (a-l):** - L16 `COLOURED_PARTS` - L19–53 selection, banding and shell-grid types and constants - L55–71 `onGrid` quantisation - L73–132 vertex encoding (paint shorts, snorm16, wear byte, octahedral normal encode/decode) - L134–216 `cellArrays` (merges building chunks into one batch) - L218–223 far-level attribute sizes - L225–346 far-mass merge and quantisation (`CellMass`, `massGrid`, `massOnGrid`, `cellMass`, `BoxMass`) - L348–379 byte count and transfer lists - L381–459 shell piece splitting and concatenation - L461–504 instance arrays - L506–587 bounds (`shellBounds`, `instanceBounds`) with scratch arrays
- **Achados do leitor (a-l):**
  - `[DEAD]` no caller outside this file for `cellArrays()`, `cellMass`, `massOnGrid`, `massPlaces`, `massGrid`, `cellBytes`, `cellBuffers`, `cellMassBuffers`, `farMassBuffers`, `isBoxMass`, `indexArray`, `shellBounds`, `cellShellGrid`, `octDecode`. `cellArrays()` is called only from `buildingMesh.ts:545`, which is itself dead. Only the encoders (`octNormal`, `paintShort`, `finishWear`, `snorm16`), `COLOURED_PARTS` and the constants are used elsewhere.
  - `[MIX]` cellArrays.ts:225–346 — far-level mass merging (massing/LOD) sits in the near-batch array file.
  - `[DUP]` cellArrays.ts:56–71 vs 275–287 — `onGrid` and `massOnGrid` contain the same quantisation loop. `snorm` (L465, 8-bit) vs `snorm16` (L99).
  - `[ALLOC]` cellArrays.ts:183 — `[...shellPieces(...), ...shellPieces(...)]`; L402/409 `chunks.slice`. The allocations are per batch, not per frame.
  - `[ALLOC]` cellArrays.ts:521, 558 — `Float64Array.of` per bounds call (per batch).
  - `[NAME]` cellArrays.ts:218 — the comment names `buildingMesh.ts FacadeStamp`, which is not in that file (the stamp lives on `shell.stamp`).
- **Superfície pública:** encoding helpers and constants (`octNormal`, `paintShort`, `snorm16`, `finishWear`, `wearByte`, `COLOUR_RANGE`, `PAINT_UNIT`, `NORMAL_UNIT`, attribute names), `cellArrays`, `CellArrays`/`CellSelection`/`KitBoxes`/`ShellGrid` types, mass merge API, transfer-list helpers, `shellBounds`
- **Exports nunca importados (b):** `SHELL_GRID_MARGIN`, `SHELL_GRID_STEP`, `cellShellGrid`, `snorm16`, `octDecode` (nem no arquivo), `CellMass`, `indexArray`, `MassSquare`, `massGrid`, `massPlaces`, `massOnGrid`, `cellMass` (nem no arquivo), `MASS_FACADE`, `MASS_GRID`, `cellMassBuffers`, `FarMass`, `isBoxMass`, `farMassBuffers` (nem no arquivo), `cellBytes` (nem no arquivo), `cellBuffers` (nem no arquivo), `SHELL_PIECE`, `shellBounds`

#### `src/r40/render/buildings/chunk.ts`

- **Veredito: MOVER** → src/shared/contracts/buildingChunk.ts (só tipos)
- **Evidência e regra (coordenador):** Só tipos atravessam o worker (o script de alcance mostra que só é importado como tipo); LotGround.heightAt é função dentro de um registro de chunk (L103–108).
- **Responsabilidades (a-l):** L8–29 the `PartKind` union; L34–51 cell entry types and `sameEntries`; L53–64 `PartBatch`; L66–101 `ShellChunk`, `RunChunk` and `BuildingChunk` (one building's typed-array contribution); L103–114 `LotGround` and its recipe
- **Achados do leitor (a-l):**
  - `[HOST]` chunk.ts:103–108 — `LotGround.heightAt` is a function on a chunk record, so it cannot cross a worker boundary. It needs the recipe (L106) to rebuild it (`lotGroundAgain`).
  - `[NAME]` chunk.ts:67 — the comment cites `buildingMesh.ts ShellPart.weld`, but `ShellPart` lives in meshCore.ts.
  - `[NAME]` chunk.ts:33 — the comment cites `cellWork.ts` and `cellPool.ts`, which are not in this batch (not verified).
- **Superfície pública:** `PartKind`, `CellEntry`, `CellJobEntry`, `sameEntries` (used by partyWalls.ts), `PartBatch`, `ShellChunk`, `RunChunk`, `BuildingChunk`, `LotGround`, `LotGroundRecipe`
- **Exports nunca importados (b):** `CellEntry`, `sameEntries` (nem no arquivo), `CellJobEntry` (nem no arquivo)

#### `src/r40/render/buildings/elementMesh.ts`

- **Veredito: DIVIDIR** → src/jobs/buildingMesh/elements/<família>.ts (portões, escadas, muros, piscinas…)
- **Evidência e regra (coordenador):** Cadeia longa de if por kind (L101–267); portões de carro e de pessoa duplicados (L738–773); closure P escrita duas vezes (L452–501); 45 exports mortos.
- **Responsabilidades (a-l):** - L25–41 element paints - L43–76 clock - L78–82 `looseParts` (memoised) - L84–268 `emitElement`/`layElement`, a dispatcher by element kind: stair/ramp L105–158, awning, bench, ac, planter, canopy, boundary wall, pavement - L270–289 lot constants and `flightSpan` - L291–339 `flightFeet` and `clearOf` (cut elements around stair feet) - L341–430 `emitLot` (paved apron and path to the street) - L432–591 stairs (open, rails, turned, rail line) - L593–634 fence and railing - L636–690 flowers, rocks and parking - L692–803 lot parts (gate, bin, lamp, bollard, drain) - L805–821 `shadeOf` and `postAt`
- **Achados do leitor (a-l):**
  - `[TEXT]` elementMesh.ts:101–267 — a long `if (el.kind === '...')` chain. The same kind strings also drive `elementPaint` L28–40 and `emitLotPart` L722.
  - `[DUP]` elementMesh.ts:738–756 vs 757–773 — the car-gate and person-gate leaf code is duplicated (rails, bars loop).
  - `[DUP]` elementMesh.ts:452–459 vs 494–501 — the same `P` closure is written twice (`emitOpenStair`, `emitStairRails`). L508–516 vs L583–590 — two copies of the handrail-and-posts logic (`emitStairRails`, `emitRailLine`).
  - `[DEAD]` dead values:
  - elementMesh.ts:185/188 — `n` is computed and discarded with `void n`
  - L655/665 — `t` is computed and discarded with `void t`
  - L4–7, 16–18, 20–21 — empty lines left over from the split
  - `[ALLOC]` emission path (workers), per element or segment:
  - `strip` L349–354: two Vec2 objects, a quad array, `map` and `some` per 2 m piece
  - L358–366 `flights` Map with template-string keys and array spreads
  - L304–311 xs/ys arrays and `Math.min(...xs)`
  - L338 new element objects from `clearOf`
  - L34–38 and L808 a `paint()` per call in `elementPaint`/`shadeOf`
  - `[BUG]` (inference) elementMesh.ts:253 — the boundary-wall plinth height is staggered by `m(0.02) * (el.id % 3)` so that crossing walls do not coincide (comment dated 2026-10-13). This is an id-based offset that hides coplanar faces, which is symptom-hiding by the project's rules.
  - `[R40COPY]` elementMesh.ts:2 — "Part of the R40 building mesh pipeline".
- **Superfície pública:** `emitElement`/`layElement`, `elementPaint`, `looseParts`, `emitLot`, `flightSpan`/`flightFeet`/`clearOf` (used by lotMesh.ts), the stair/fence/rocks/parking/lot-part emitters, paint and size constants
- **Exports nunca importados (b):** `ELEMENT_CONCRETE`, `CLOCK_FACE`, `CLOCK_INK`, `emitClock`, `layElement`, `COPING`, `APRON`, `PATH_WIDTH`, `PATH_REACH`, `LOT_LIFT`, `PAVING`, `flightSpan`, `PlanRect`, `STAIR_SOLID`, `TREAD`, `WAIST`, `HANDRAIL`, `emitOpenStair`, `emitStairRails`, `RAIL`, `PLANTER_SOIL`, `TRUNK`, `sub2`, `emitTurnedStair`, `emitRailLine`, `emitFence`, `RAIL_OFF`, `FLOWER_KERB`, `emitFlowers`, `emitRocks`, `emitParking`, `PARKING_ASPHALT`, `GATE_PAINT`, `CAR_GATE_OPEN`, `GATE_POST`, `BIN_BODY`, `BIN_LID`, `LAMP_POST`, `GATE_LANTERN`, `BOLLARD_BAND`, `DRAIN_GRATE`, `emitLotPart`, `PARKING_LINE`, `shadeOf`, `postAt`

#### `src/r40/render/buildings/facadeEmit.ts`

- **Veredito: MOVER** → src/jobs/buildingMesh/facadeEmit.ts
- **Evidência e regra (coordenador):** Emissão da fachada; bayHash espelhado bit a bit em GLSL em facadeLevel.ts:61–66 (L173–178); teste de escritório por uso repetido em facadeProps.ts:51 (L150).
- **Responsabilidades (a-l):** - L16–34 porch light - L36–51 rain streak - L53–80 `FarBay`, `streakOf`, `facadeKind` - L84–156 `emitFacadeRuns` (far level: merges alike bays into runs, then storeys) - L158–178 `alikeBays` and `bayHash` - L184–383 `emitBay` (near-level bay geometry by component: window, door, shopfront, loggia, brise, gourmet, ...) - L385–463 `emitPlinth` - L465–496 `emitRecessedFlight` - L498–520 `emitRelief`
- **Achados do leitor (a-l):**
  - `[ALLOC]` emission path, per bay and per run:
  - facadeEmit.ts:94–98 `keyOf` builds a long template string with 8× `toFixed`
  - L121 a slot string per row
  - L158 `sameFixed` calls `toFixed` twice per comparison, about 8 times per `alikeBays`
  - L100 `[...list].sort`
  - L141 a spread `BayFace` per run
  - L147–149 `stamp` arrays per run
  - L222 a spread opening per recessed bay
  - `[TEXT]` facadeEmit.ts:150 — `e.building.use === 'commercial' || === 'industrial'` picks offices. The same test is at `facadeProps.ts:51`. Component strings drive `facadeKind` L69–79 and `streakOf` L64–65.
  - `[DUP]` facadeEmit.ts:398–424 vs 429–462 — the outline and rectangle branches of `emitPlinth` repeat the same `wallTo` and notch logic.
  - `[DUP]` facadeEmit.ts:173–178 — `bayHash` is mirrored bit-for-bit in GLSL at `facadeLevel.ts:61–66`. The two must be kept in sync by hand, and the comment there says so.
  - `[DUP]` facadeEmit.ts:82 — `sameLength` uses a local `1e-6` instead of `core/scalar.ts`.
  - `[R40COPY]` facadeEmit.ts:1 — split from the R40 mesher.
- **Superfície pública:** `emitBay`, `emitFacadeRuns`, `FarBay`/`FarRun`, `streakOf`, `facadeKind`, `bayHash`, `emitPlinth`, `emitRecessedFlight`, `emitRelief`, `emitStreak`, `emitPorchLight`, constants
- **Exports nunca importados (b):** `DOWN`, `EITHER_SIDE`, `PORCH_WASH`, `emitPorchLight`, `REVEAL_SHADE`, `STREAKED`, `emitStreak`, `facadeKind`, `sameLength`, `FarRun`, `sameFixed`, `alikeBays`, `bayHash`, `canopyAt`

#### `src/r40/render/buildings/facadeKit.ts`

- **Veredito: MOVER** → src/jobs/buildingMesh/facadeKit.ts
- **Evidência e regra (coordenador):** Geometrias de fachada; uma ExtrudeGeometry/BoxGeometry nova por peça (L149…L418); medidas sem m() (L93, L207, L397).
- **Responsabilidades (a-l):** - L6–17 the `Sink` interface (string-material draw API) - L19–55 face model (`Face`, `facesOf`, `fbox`, `fpoint`, `turn`) - L57–61 CGA-style `repeat` - L68–145 punched window - L147–188 extrusions on a face (arch fill, arch ring, pediment) - L190–247 rail, cornice, band, pier, curtain wall - L249–288 balcony and awning - L290–323 door - L325–386 spire, finial, bell mansard, arched dormer - L388–428 balustrade, consoles, cartouche - L430–450 planted tree, hedge, lamp post
- **Achados do leitor (a-l):**
  - `[TEXT]` material names are bare strings passed through `Sink` (`mat: string`): `'glass'`, `'frame'`, `'glassLit'`, `'gold'`, `'glassRail'`, `'slab'`, `'white'`, `'stoneLight'`, `'soil'`, `'woodDark'`, `'leafDark'`, `'blackSteel'`, `'sconce'` (L105, 261–264, 297, 305, 381, 410, 432–449). The receiving side must match each spelling.
  - `[ALLOC]` facadeKit.ts:149, 279, 330, 335, 343, 346, 418 — a new three `ExtrudeGeometry`, `BoxGeometry`, `CylinderGeometry` or `ConeGeometry` per arch, awning, spire, finial or cartouche boss, pushed as raw geometry (`pushRaw`). This happens per signature building (inference: in the worker, via landmarks.ts → signature.ts → buildingMesh `emitChunk`).
  - `[DUP]` facadeKit.ts:93, 207, 397 and others — sizes are bare metre literals (0.3, 0.12, 0.32, ...) without `m()`, unlike the rest of `r40/render/buildings`.
  - `[DEAD]` facadeKit.ts:292/322 — `w` is computed and discarded with `void w`. `facesOf` (L30) has no caller outside this file.
  - `[BUG]` (inference) facadeKit.ts:373–378 — the dormer's round head is built from 5 stacked boxes; `half` is computed at the slice's lower edge. This produces a stepped silhouette.
- **Superfície pública:** `Sink`, `Face`, `facesOf`, `span`, `fbox`, `fpoint`, `repeat`, `WALL`, `WindowSpec`/`punched`, `railFace`, `cornice`, `band`, `pier`, `CurtainSpec`/`curtain`, `balcony`, `awning`, `door`, `spire`, `finial`, `bellMansard`, `archedDormer`, `balustrade`, `consoles`, `cartouche`, `plantedTree`, `hedge`, `lampPost` (used by landmarks.ts and signature.ts)
- **Exports nunca importados (b):** `Face`, `WindowSpec`, `CurtainSpec`, `BalconyKind`

#### `src/r40/render/buildings/facadeLevel.ts`

- **Veredito: APAGAR** → —
- **Evidência e regra (coordenador):** createFacadeMaterial só é chamado por kit.ts:600, dentro do createBuildingKit sem chamador; é GLSL por onBeforeCompile (L152–199).
- **Responsabilidades (a-l):** L9–15 far-level kind, flip and streak codes; L17–27 frame width and `FacadePanes`; L29–72 GLSL declarations, box-filtered pulse and `facadeBayHash`; L74–140 GLSL opening, pane, shutter, streak and night-light colouring; L142–201 `createFacadeMaterial` (patches `MeshStandardMaterial` through `onBeforeCompile` string replacement)
- **Achados do leitor (a-l):**
  - `[BUG]` facadeLevel.ts:152–199 — the material is built from GLSL `onBeforeCompile` chunk replacement on `MeshStandardMaterial`. The game renders with `THREE.WebGPURenderer` (`render/scene.ts:44`), which builds node materials and does not run `onBeforeCompile`/GLSL chunks (inference from r186 design; not run). So this path cannot work in the product renderer.
  - `[DEAD]` `createFacadeMaterial` is called only from `kit.ts:600`, inside `createBuildingKit`. `createBuildingKit` has no caller (only comments in jobs/building40.ts:21 and jobs/parts40.ts:55 name it).
  - `[DUP]` facadeLevel.ts:61–66 — the GLSL copy of `facadeEmit.ts:173` `bayHash` and of the pick rules of `emitBay` (L95–113 vs facadeEmit.ts:246–251). L116–125 is the GLSL copy of `emitStreak`.
  - `[NAME]` facadeLevel.ts:8, 12 — the comments say `buildingMesh.ts facadeKind/streakOf`, but these now live in facadeEmit.ts.
- **Superfície pública:** `FACADE_KIND`, `FACADE_FLIP`, `FACADE_STREAK`, `STREAK_SILL`, `FacadePanes`, `createFacadeMaterial`

#### `src/r40/render/buildings/facadePropModels.ts`

- **Veredito: MOVER** → src/render/props/facadePropModels.ts
- **Evidência e regra (coordenador):** createFacadePropGeometries está vivo; acFarGeometry só no kit morto (L231); mulberry32 copiado (L109–117).
- **Responsabilidades (a-l):** L22–46 helpers (`tone` vertex colour plus weld, `block`, `merged`); L48–94 AC condenser model; L96–117 pot and `leafStream` RNG; L119–163 foliage; L165–228 chair, table, airer, dish; L230–238 far condenser; L240–254 `createFacadePropGeometries`; L256–326 bush, lounger, bike
- **Achados do leitor (a-l):**
  - `[DUP]` facadePropModels.ts:109–117 — `leafStream` is a verbatim copy of `mulberry32` (`r40/core/rng.ts:109-118`), whose comment forbids copying it. L157 and L263 even create a new stream per vertex just to draw one number.
  - `[DEAD]` `acFarGeometry` (L231) is called only from `kit.ts:611` inside the uncalled `createBuildingKit`. `createFacadePropGeometries` is live through `kit.ts:480` `partGeometries` (exported in api).
  - `[BUG]` (inference) facadePropModels.ts:290–291 — the comment says the cushion is "a shade lighter", but it uses `grey(1.0)`, the same tone as the bed.
  - `[NAME]` facadePropModels.ts:189 — "varal de chao" (Portuguese) and L283 "espreguicadeira" in English comments (minor).
- **Superfície pública:** `createFacadePropGeometries` (one geometry per `FacadePropKind`), `acFarGeometry`

#### `src/r40/render/buildings/facadeProps.ts`

- **Veredito: MOVER** → src/jobs/buildingMesh/facadeProps.ts
- **Evidência e regra (coordenador):** Vida nas sacadas; mulberry32 inline (L65–70); `if (level < 1) break` inalcançável (L153, L169).
- **Responsabilidades (a-l):** L6–16 prop kinds, shadow and thin lists, pot/AC sizes; L20–46 `FacadeProp`, colour palettes and opening type; L48–54 `standardOf`; L56–58 eligible components; L60–192 `facadeProps` (seeded choice of AC units, dishes, balcony furniture, plants, airers, bikes per bay)
- **Achados do leitor (a-l):**
  - `[DUP]` facadeProps.ts:65–70 — an inline mulberry32 again (see `r40/core/rng.ts:109`).
  - `[ALLOC]` per furnished bay (emission, worker): closures `rnd`, `pick`, `one`, `plant`, `furnish` and its inner closures (L65–146), a `FacadeProp` object per prop, and `AC_CASES.slice(0,4)` per AC (L77). L62 returns early for bays without props, with a reason.
  - `[TEXT]` facadeProps.ts:51, 76, 161, 179 — the building use strings `'commercial'`, `'industrial'`, `'residential'`, `'mixed'` select behaviour. The same office test is at `facadeEmit.ts:150`.
  - `[DEAD]` facadeProps.ts:153, 169 — `if (level < 1) break;` can never be true, because L62 already returns for `level < 1`.
  - `[NAME]` facadeProps.ts:129 — "No barbecue on any balcony (the player, 2026-10-14)": a dated decision recorded in a code comment.
- **Superfície pública:** `FacadePropKind`, `FACADE_PROP_KINDS`, `SHADOWED_PROPS`, `THIN_PROPS`, `POT_HIGH`, `AC`, `FacadeProp`, `PropOpening`, `facadeProps`
- **Exports nunca importados (b):** `FacadeProp`, `PropOpening`

#### `src/r40/render/buildings/fade.ts`

- **Veredito: APAGAR** → —
- **Evidência e regra (coordenador):** fadeMeshes sem chamador; partLook só usado por meshesOf, que também é morto (buildingMesh.ts:648).
- **Responsabilidades (a-l):** L10–15 `partLook` (material and order for a part kind, faded or not); L17–43 `fadeMeshes` (walks a scene subtree and swaps materials by mesh name)
- **Achados do leitor (a-l):**
  - `[TEXT]` fade.ts:7, 20, 28, 34–36 — behaviour is chosen by mesh-name strings (`'building-furniture-'`, `'building-'` prefix, `SHELL_MESH`). The part kind is parsed out of the name. Those names are written in `buildingMesh.ts:612, 652, 700`.
  - `[DEAD]` `fadeMeshes` has no caller outside this file. `partLook` is used only by `buildingMesh.ts:648` `meshesOf`, which is dead too.
  - `[OMAP]` (inference) fade.ts:18 — `root.traverse` over every building mesh of the subtree on each toggle; `includes` over `PART_KINDS` per node (L36).
  - `[SMALL]` 44 lines, two functions.
- **Superfície pública:** `partLook`, `fadeMeshes`
- **Exports nunca importados (b):** `fadeMeshes` (nem no arquivo)

#### `src/r40/render/buildings/finishes.ts`

- **Veredito: DIVIDIR** → finishAlbedo (usado pela massa nos workers, L224–245) → src/render/bake/finishAlbedo.ts; createShellMaterial e o GLSL (L121–216) → APAGAR
- **Evidência e regra (coordenador):** createShellMaterial só é chamado pelo createBuildingKit morto; finishAlbedo faz 48×48 shade() por chamada sem cache (L233–239).
- **Responsabilidades (a-l):** L12–32 `finishLookTable` (per-finish scalar table); L34–118 GLSL fragments (finish declarations, texture-array maps with a derivative tangent frame, weathering noise, octahedral normal unfold); L120–201 `shellShader` (`onBeforeCompile` string patching); L203–222 `createShellMaterial`; L224–248 `finishAlbedo` (mean colour of each recipe)
- **Achados do leitor (a-l):**
  - `[BUG]` finishes.ts:121–216 — this is also a GLSL `onBeforeCompile` patch of `MeshStandardMaterial` (uses `WebGLProgramParametersWithUniforms`, `ShaderChunk`). It does not match the product's `WebGPURenderer` and TSL (inference, as for facadeLevel.ts).
  - `[DEAD]` `createShellMaterial` is called only by `kit.ts` `createBuildingKit` (no caller). `finishLookTable` and `SHELL_NORMAL_GLSL` are only used inside the r40 kit. `finishAlbedo` is live (`massing.ts`, `massingMaterial.ts`).
  - `[MIX]` finishes.ts:224–245 — `finishAlbedo` (a CPU recipe average, used by massing in workers) lives in the same file as the GLSL material builder. Importing it pulls three's `MeshStandardMaterial`/`ShaderChunk` and `surfaceTextures` into its importers (`massing.ts`).
  - `[ALLOC]` finishes.ts:233–239 — 48×48 calls to `shade()` per finish on every `finishAlbedo()` call. The results are not cached in this file (callers may cache them; not verified).
  - `[TEXT]` finishes.ts:28–29, 241 — branches on finish name strings `'roofing'`, `'tile'`, `'slate'`, `'glass'`, `'metal'`.
  - `[NAME]` finishes.ts:77 — "the player's order of 2026-10-05" in a code comment.
- **Superfície pública:** `finishLookTable`, `SHELL_NORMAL_GLSL`, `createShellMaterial`, `finishAlbedo`
- **Exports nunca importados (b):** `finishLookTable`

#### `src/r40/render/buildings/flagLayer.ts`

- **Veredito: DIVIDIR** → FlagInstance (tipo) → src/shared/contracts/buildingChunk.ts; createFlagLayer → APAGAR
- **Evidência e regra (coordenador):** createFlagLayer sem chamador; só o tipo FlagInstance é importado (o script de alcance confirma: só como tipo); GLSL por onBeforeCompile (L59–98).
- **Responsabilidades (a-l):** L20–33 `FlagInstance` and `FlagLayer` types; L35–54 GLSL flag patterns; L56–101 waving cloth material (`onBeforeCompile`); L103–170 `createFlagLayer` (one InstancedMesh rebuilt on every `set`)
- **Achados do leitor (a-l):**
  - `[DEAD]` `createFlagLayer` has no caller outside this file. Only the `FlagInstance` type is imported (buildingMesh.ts, chunk.ts, meshCore.ts), so flags are collected in chunks but this layer never draws them.
  - `[BUG]` (inference) flagLayer.ts:59–98 — GLSL `onBeforeCompile` on `MeshStandardMaterial`; it would not run under the product's `WebGPURenderer`.
  - `[OMAP]` flagLayer.ts:117–161 — "Every flag in the city, one instanced draw" (L17). `set(flags)` throws away and rebuilds the whole instanced mesh, cloned geometry and five attribute arrays for the whole city's flags on every call, with `frustumCulled = false` (L157).
  - `[ALLOC]` flagLayer.ts:141 — two `new Vector3` per flag inside `forEach`; L145 a tuple array per flag.
  - `[BUG]` (inference) flagLayer.ts:134–136 — wind yaw is baked into the instance matrices at `set` time. A later change of `uWindDir` leaves every flag facing the old wind until the next `set`.
- **Superfície pública:** `FlagInstance`, `FlagLayer`, `createFlagLayer`
- **Exports nunca importados (b):** `FlagLayer`, `createFlagLayer` (nem no arquivo)

#### `src/r40/render/buildings/furnitureKit.ts`

- **Veredito: DIVIDIR** → createFurnitureGeometries (vivo, usado por ruinMesh.ts) → src/render/buildings/furnitureGeometries.ts; createFurnitureMaterial e furnitureTones → APAGAR
- **Evidência e regra (coordenador):** Material e tons só usados pelo kit morto e por glassRoom.ts (também morto); cantos arredondados caros por peça (L51).
- **Responsabilidades (a-l):** L15–37 colour palette; L39–65 primitive helpers (`paint` vertex colour plus weld, `rbox`, `cyl`, `ball`, `legs`); L67–296 `build(kind)`, one model per furniture kind (beds, sofas, tables, shelves, kitchen, bath, lamps, stairs, ...); L298–322 `createFurnitureGeometries` (merge per kind) and `createFurnitureMaterial`; L324–345 `furnitureTones` (area-weighted mean colour)
- **Achados do leitor (a-l):**
  - `[DUP]` furnitureKit.ts:40–47 `paint` vs `facadePropModels.ts:22–31` `tone` — the same "fill colour attribute, weld if non-indexed" helper. They differ in uv handling (one deletes uv, the other adds a zero uv at L307).
  - `[DEAD]` `createFurnitureMaterial` and `furnitureTones` are used only by kit.ts and glassRoom.ts, both on the uncalled `createBuildingKit` path. `createFurnitureGeometries` is live (`r40/api.ts`, `features/demolition/ruin/ruinMesh.ts`).
  - `[BUG]` (inference) furnitureKit.ts:51 — `RoundedBoxGeometry(..., 2, r)`: the rounded corners cost many triangles per piece. A bookshelf (L177–191) emits dozens of rounded books per shelf, all instanced behind every window, so this may be excess geometry. The triangle count was not measured.
  - `[DUP]` furnitureKit.ts:8 vs 10 — imports `three/examples/jsm/...`, while facadePropModels.ts:12 imports `three/addons/...` for the same utility.
  - `[NAME]` furnitureKit.ts:271 — the comment "Lights: a shade lit warm from inside" sits above `case 'stairs'`. The lamp cases come later (L289).
- **Superfície pública:** `createFurnitureGeometries`, `createFurnitureMaterial`, `furnitureTones`

#### `src/r40/render/buildings/glassRoom.ts`

- **Veredito: APAGAR** → —
- **Evidência e regra (coordenador):** roomBehindGlass só é chamado pelo createBuildingKit morto; um GLSL de 150 linhas por onBeforeCompile (L21–254).
- **Responsabilidades (a-l):** L6–255 `roomBehindGlass`: patches a pane material through `onBeforeCompile` with interior-mapping GLSL. It covers the room box ray-cast, floor, ceiling and wall finishes, a picture or TV, a furniture box, curtains/blinds/sheers, Fresnel, a tiny-pane fallback, night lamp emission and TV flicker.
- **Achados do leitor (a-l):**
  - `[BUG]` (inference) glassRoom.ts:21–254 — a GLSL `onBeforeCompile` patch (comment L253 cites `WebGLRenderer.getProgram`). The product uses `WebGPURenderer` (`render/scene.ts:44`).
  - `[DEAD]` `roomBehindGlass` is called only from kit.ts (`createBuildingKit`, which has no caller).
  - `[MIX]` glassRoom.ts:84–233 — one 150-line GLSL string mixes room ray-casting, flooring patterns, wall art and TV, furniture, window dressings and lighting.
  - `[HOST]` glassRoom.ts:20 — `const glassy = material;` is a pointless alias, and the function mutates its argument instead of returning a material.
  - `[NAME]` glassRoom.ts:64 — the comment cites "ATUS" (American Time Use Survey) as the source for `roomsAwake` (good: a source is named).
- **Superfície pública:** `roomBehindGlass`

#### `src/r40/render/buildings/interiorMesh.ts`

- **Veredito: MOVER** → src/features/interiors/interiorMesh.ts (reescrito)
- **Evidência e regra (coordenador):** Emissão do interior para prédios quebrados; corte arbitrário em 140 peças (L131); PartSink vazio por cast (L121); fragmento de um arquivo-deus dividido do 4.0 (L1).
- **Responsabilidades (a-l):** L12–22, L117 interior paints (floor finishes, shaft, cab, step, partition); L24–108 `emitInterior`: cut-floor slabs (earcut), lift/stair cores (shaft walls, cab, 12-step flight), split-level flights, room partitions (lowered to 0.9 m when facing the cut view), furniture; L110–115 `placeFurniture` (furniture instance rows); L119–140 `interiorFurniture` (all floors' furniture as batches for a breaking building)
- **Achados do leitor (a-l):**
  - `[ALLOC]` interiorMesh.ts:37 — per triangle `[..].map(k => e.L(...))` allocates an array + 3 V3 (worker build path).
  - `[ALLOC]` interiorMesh.ts:131 — `Object.values(placed).reduce(...)` every level of the loop.
  - `[BUG]` interiorMesh.ts:131 — arbitrary cap: furniture for a breaking building stops after >140 pieces ("a tower's every chair cost a second"); a tall tower's upper floors break with no furniture (quality cut by a magic number).
  - `[HOST]`/`[BUG]` interiorMesh.ts:121 — `new Emitter(b, new Shell(), {} as PartSink, placed)`: an empty-cast PartSink; any `put`/`box` with `apart` on this emitter would throw (only safe because only `furnitureRows` is used).
  - `[NAME]` interiorMesh.ts:117 — `PARTITION` defined after its first use at L101 (works, but split constant block).
  - `[MAIN]` (inference) interiorMesh.ts:24 — only safe if `emitInterior` runs in the building worker (`buildingMesh.ts`), not checked here.
  - `[R40COPY]` interiorMesh.ts:1 — header "Part of the R40 building mesh pipeline (split by responsibility)": fragment of a split god file (`buildingMesh.ts`).
- **Superfície pública:** paints (`FLOOR_FINISH`, `WOOD_FLOOR`, `PORCELAIN_FLOOR`, `SHAFT`, `CAB`, `STEP`, `PARTITION`); `emitInterior`, `placeFurniture`, `interiorFurniture` (re-exported via r40/api.ts, used by jobs/building40.ts).
- **Exports nunca importados (b):** `FLOOR_FINISH`, `WOOD_FLOOR`, `PORCELAIN_FLOOR`, `SHAFT`, `CAB`, `STEP`, `placeFurniture`, `PARTITION`

#### `src/r40/render/buildings/kit.ts`

- **Veredito: DIVIDIR** → partGeometries (L457–484) → src/render/buildings/partGeometries.ts; createBuildingKit e tudo que só ele usa (L485–705) → APAGAR
- **Evidência e regra (coordenador):** createBuildingKit não tem chamador em src (L485, conferido): materiais MeshStandardMaterial com GLSL por onBeforeCompile, horários de luz, simplificação meshoptimizer — nada disso roda; meshCore.ts:15 e partFiling.ts:4 puxam kit.ts (três materiais + meshoptimizer) para o worker só por PART_KINDS.
- **Responsabilidades (a-l):** L39–58 sleep-survey awake share + module uniforms; L86–121 porch lamp constants, outside-light schedule GLSL patch; L123–177 types (Axes, PartLevel, PartScreen, BuildingKit); L179–217 meshoptimizer simplified LODs; L219–454 part model geometries (frame, railing, roof railing, door, louvre, glass rail, brise, awning, shell parts, far versions); L457–483 `partGeometries`; L485–705 `createBuildingKit`: all part materials, night/lamp logic, ghost/dim materials, massing/facade materials, LOD tables, shadow pieces, dispose
- **Achados do leitor (a-l):**
  - `[MIX]` kit.ts:39–705 — time-of-day statistics, lamp scheduling shader patches, geometry modelling, LOD simplification, material factory, ghost/dim preview materials and night control in one 36 KB file.
  - `[DEAD]` kit.ts:485 — `createBuildingKit` has no caller in src (only comments: jobs/building40.ts:21, jobs/parts40.ts:55); its type `BuildingKit` is still consumed by buildingMesh.ts:19/513/548/758 and fade.ts:10. Half the file (L485–705, plus massingMaterial.ts, massBoxes.ts) looks unreachable.
  - `[LAYER]`/`[BUG]` (inference) kit.ts:110–121, 543–575 — materials are classic `MeshStandardMaterial` patched with GLSL via `onBeforeCompile`/`customProgramCacheKey` and comments cite r186 `WebGLProgram`/`WebGLShadowMap`; the app renders with `THREE.WebGPURenderer` (src/render/scene.ts:12), which does not run GLSL `onBeforeCompile` patches — if this path were live, the lamp lot, room-behind-glass, posing and ghost-normal patches would silently not apply.
  - `[HOST]` kit.ts:53–58, 101 — uniforms are module singletons, so two kits (two renderers) would share and overwrite night state.
  - `[ALLOC]` kit.ts:685 — `setNight` reads `performance.now()` for the TV clock each call (fine), but `for (const [kind,k] of [['glass',1],['glassDark',0.64]])` L680 allocates arrays each call (per-frame if called per frame).
  - `[NAME]` kit.ts:350–351 — doc comment "A shop awning…" sits above `louvreGeometry` (orphan); kit.ts:512–513 comment "The light the lantern throws on the wall" sits on the `fin` material (belongs to `wash`).
  - `[DEAD]` kit.ts:375–380 — `glassRailGeometry` runs `mergeGeometries([pane])` on a single geometry.
  - `[MAIN]` (inference) kit.ts:636–641 — meshoptimizer simplification runs wherever the kit is created; `partGeometries` is called in jobs/building40.ts:219 (worker side), OK.
  - `[R40COPY]` kit.ts:456 — "(Roadcraft 5: jobs/building40.ts)": file is the 4.0 kit kept as reference/port.
  - `[DEP]`/`[LAYER]` (inference) — meshCore.ts:15 and partFiling.ts:4 import `PART_KINDS` from kit.ts, pulling three materials + meshoptimizer into worker bundles that only need the kind list.
- **Superfície pública:** `PART_KINDS`, `PartKind` (re-export), `PORCH_LAMP`, `Axes`, `PartLevel`, `PartScreen`, `BuildingKit`, `partGeometries` (used by jobs), `createBuildingKit`.
- **Exports nunca importados (b):** `Axes`, `PartLevel`, `createBuildingKit` (nem no arquivo)

#### `src/r40/render/buildings/landmarks.ts`

- **Veredito: MOVER** → src/world/buildings/landmarks.ts (dados de projeto)
- **Evidência e regra (coordenador):** Dados de projeto dos marcos (domínio) dentro de render/, importados por world/design.ts e world/growth.ts; materiais por strings mágicas (L18–414).
- **Responsabilidades (a-l):** L6–23 sink type, level helper, plaza, posts; L27–128 Beaux-Arts hotel; L132–229 Art Deco tower; L233–277 modernist office; L281–357 contemporary flats; L361–415 blue glass tower; L418–420 `LANDMARKS` table
- **Achados do leitor (a-l):**
  - `[TEXT]` landmarks.ts:18–414 — every material is a magic string ('limestone', 'rustic', 'glassLit', 'decoGold', 'frameBronze', 'leafDark'…) resolved in facadeKit.ts; `LANDMARKS` keyed by strings ('beauxArts', 'glassSpire' → glassTower L419) shared with signature.ts, world/design.ts, world/growth.ts.
  - `[NAME]` landmarks.ts:419 — key `glassSpire` maps to `glassTower`.
  - (inference) many hand-placed numeric dimensions per design (e.g. L101 mh 5.6, inset 2.9) — design data, not tunables; source cited L6 ("reference sheet the player gave on 2026-10-09").
  - `[LAYER]` (inference) landmarks.ts — building design data (world/generation concern) lives under render/; world/design.ts and world/growth.ts import it from render.
- **Superfície pública:** `LANDMARKS` (signature buildings' design functions by kind).

#### `src/r40/render/buildings/lawnGround.ts`

- **Veredito: JUNTAR** → src/render/buildings/lotMesh.ts
- **Evidência e regra (coordenador):** Uma função com um único chamador (lotMesh.ts:197); supõe polígono convexo (L42–53).
- **Responsabilidades (a-l):** L4 `GroundLattice`; L6–62 `highestGroundUnder`: max terrain height under a convex quad, sampling corners, crossings with the terrain triangle edges (4 line families) and grid corners inside
- **Achados do leitor (a-l):**
  - `[SMALL]` lawnGround.ts:6 — one function; sole caller lotMesh.ts:197.
  - `[ALLOC]` lawnGround.ts:16–22 — closures and a 4-closure array per call (per lawn-seated element group in the worker build).
  - `[BUG]` (inference) lawnGround.ts:42–53 — `inside` assumes a convex polygon (comment L41 "a convex quad"); fine for the 4-corner rects passed today.
- **Superfície pública:** `GroundLattice`, `highestGroundUnder`.
- **Exports nunca importados (b):** `GroundLattice`

#### `src/r40/render/buildings/lightSlots.ts`

- **Veredito: RENOMEAR** → src/render/buildings/roomSeed.ts
- **Evidência e regra (coordenador):** O nome 'lightSlots' guarda só um hash de semente (L19); um chamador (buildingMesh.ts).
- **Responsabilidades (a-l):** L3–16 FNV-1a hashing of integers digit by digit without strings; L19–29 `spaceSeed` (seed of a building space for its window light slot)
- **Achados do leitor (a-l):**
  - `[SMALL]` lightSlots.ts:19 — one public function; caller buildingMesh.ts.
  - `[NAME]` lightSlots.ts — file named "lightSlots" holds only a seed hash; L1 comment "DO NOT number the spaces in the order they are asked for (a table on the page, as this was)" describes removed code.
- **Superfície pública:** `spaceSeed`.

#### `src/r40/render/buildings/lotMesh.ts`

- **Veredito: MOVER** → src/render/buildings/lotMesh.ts (reescrito)
- **Evidência e regra (coordenador):** Malha do lote; insideRing igual a core/polygon.ts pointInPolygon (L259–266); nível do piso calculado igual a massing.ts:326–334 (L60–66); 9 exports mortos.
- **Responsabilidades (a-l):** L25–49 lot paints, kerb/pool constants, lawn lattice; L51–229 `emitLots`: lot plates (shaped earcut or 3 m grid following ground), pools (water part, coping, tiled sides), kerbs, seating of element groups on lawns, element emission per piece/host; L231–235 `lotGroundAgain`; L237–257 `lotGroundOf` (height query over lots/parking bays); L259–266 `insideRing`
- **Achados do leitor (a-l):**
  - `[DUP]` lotMesh.ts:259–266 — `insideRing` is an even-odd point-in-polygon; same as core/polygon.ts `pointInPolygon` (used by partyWalls.ts:1).
  - `[DUP]` lotMesh.ts:60–66 vs massing.ts:326–334 — lot floor level (max ground over footprints and centres + 0.12 m) computed twice with the same rule.
  - `[ALLOC]` lotMesh.ts:111, 117–119, 141–151 — per triangle/per face `.map` arrays and `e.L` V3 arrays; L211 `{ ...el, z }` per element; L198 `Math.max(...lawn.map(...))`; L218 `flatMap` per element.
  - `[OMAP]` (inference) lotMesh.ts:158–166, 250–253 — `hostAt` scans all lots per piece; `heightAt` scans all surfaces/bays per query; bounded by one building's lots (not city size).
  - `[DEAD]` lotMesh.ts:85 — `LOT_PAINT[v.open ?? 'grass'] ?? LOT_KERB`: grass already skipped at L82, fallbacks unreachable.
  - `[LAYER]`/`[MIX]` lotMesh.ts:20 — near-mesh module imports `LOT_COLOURS` from massing.ts (far-mesh module) for its paints.
  - `[DEAD]` lotMesh.ts:259 — `insideRing` exported but used only inside this file.
- **Superfície pública:** `LOT_PAINT`, `LOT_KERB`, `KERB_INSET`, `POOL_*`, `LAWN_LATTICE`, `emitLots`, `lotGroundAgain`, `lotGroundOf`, `insideRing`.
- **Exports nunca importados (b):** `LOT_PAINT`, `LOT_KERB`, `KERB_INSET`, `POOL_TILE`, `POOL_FLOOR`, `POOL_COPING`, `POOL_WATER_DROP`, `LAWN_LATTICE`, `insideRing`

#### `src/r40/render/buildings/massBoxes.ts`

- **Veredito: APAGAR** → —
- **Evidência e regra (coordenador):** boxesMesh sem chamador (L31); unitBox só usado por kit.ts:597, dentro do createBuildingKit morto.
- **Responsabilidades (a-l):** L8 `BoxKit` host interface; L13–28 `unitBox` (20-vertex instanced unit box, vertices named by attribute); L31–56 `boxesMesh` (instanced box level mesh over interleaved per-box floats)
- **Achados do leitor (a-l):**
  - `[DEAD]` massBoxes.ts:31 — `boxesMesh` has no caller in src; `unitBox` only used by kit.ts:597 (itself unreachable via `createBuildingKit`).
  - `[LAYER]` (inference) massBoxes.ts:49 — `gpuOnlyAttributes` + classic `Mesh` with GLSL-patched material (see kit.ts finding on WebGPURenderer).
- **Superfície pública:** `unitBox`, `boxesMesh`.
- **Exports nunca importados (b):** `boxesMesh` (nem no arquivo)

#### `src/r40/render/buildings/massing.ts`

- **Veredito: DIVIDIR** → src/render/buildings/farMass.ts (níveis de longe) + roofs vindos de um módulo único src/render/buildings/roofShapes.ts
- **Evidência e regra (coordenador):** Formas de telhado reimplementadas ao lado de roofMesh.ts:379–680 (L454–605); Grown igual a meshCore.ts:226 Grow (L72–94); rgbOf igual a meshCore.ts:37 linear (L61–64); emitBoxes/emitMassingLevels/massFloor sem chamador fora do arquivo (L204–314).
- **Responsabilidades (a-l):** L19–56 `MassingChunk`, `MassDetail` levels (cell/tile/plate), constants; L58–94 colour helper and `Grown` typed-array builder; L96–198 `MassWriter` (points, faces, polygons, error tracking); L200–260 entry points `massFloor`, `emitMassing`, `emitMassingLevels`, `massWriter`; L262–314 `emitBoxes` (far boxes as floats); L316–349 lot colours + lot plates; L351–452 `emitVolume` (bay runs merged per storey and stacked, reliefs, parapets); L454–540 `emitRoof` (flat/gable/hip/shed/sawtooth); L543–605 `emitPolygonRoof`; L608–614 `box`; L617–656 roof plant and machine rooms
- **Achados do leitor (a-l):**
  - `[DUP]` massing.ts:72–94 `Grown` duplicates meshCore.ts:226–267 `Grow` (doubling typed-array builder).
  - `[DUP]` massing.ts:61–64 `rgbOf` duplicates meshCore.ts:37–40 `linear`.
  - `[DUP]` massing.ts:454–540, 543–605 — roof shapes (gable/hip/shed/sawtooth/polygon patches) re-implemented beside roofMesh.ts:379–680 with the same formulas; constants `PARAPET_H`, `ATTIC_H`, `PARAPET_T`, `EAVES`, `ARCADE` L50–54/359 duplicated in meshCore.ts:76–88.
  - `[DUP]` massing.ts:201, 243–244, 280–281 — shade and seed formulas repeated inside the file (`emitBoxes` re-derives what `massWriter` derives).
  - `[ALLOC]` massing.ts:62 — `rgbOf` makes a `three.Color` per call; called per run/face (L339, 472, 621, 631–641).
  - `[OMAP]` (inference) massing.ts:369 — `emitVolume` iterates `bayLayout(b)` once per volume (comment says "worked out once"; cost is O(blocks × bays) per building unless `bayLayout` caches).
  - `[DEAD]` massing.ts:263–314 `emitBoxes`/`BOX_FLOATS`, 224–233 `emitMassingLevels`, 204 `massFloor` — no caller outside this file in src (`emitBoxes` writes into a `number[]` L267 contrary to the file's own rule at L71).
  - `[DEAD]` massing.ts:539 — `void floor;` unused parameter of `emitRoof`.
  - `[NAME]` massing.ts comments reference `buildingMesh.ts` `emitChunk`/`emitRoof` as the source of truth throughout (L200–256, 433, 440).
- **Superfície pública:** `MassingChunk`, `MassDetail`, `CELL_DETAIL`, `TILE_DETAIL`, `PLATE_DETAIL`, `BURY`, `rgbOf`, `massFloor`, `emitMassing`, `emitMassingLevels`, `BOX_FLOATS`, `emitBoxes`, `LOT_COLOURS`, `GLASS_SHARE`.
- **Exports nunca importados (b):** `CELL_DETAIL`, `BURY`, `rgbOf`, `massFloor`, `emitMassingLevels` (nem no arquivo), `BOX_FLOATS` (nem no arquivo), `emitBoxes` (nem no arquivo), `GLASS_SHARE`

#### `src/r40/render/buildings/massingMaterial.ts`

- **Veredito: APAGAR** → — (as janelas de longe já são desenhadas pelo material TSL de render/city.ts)
- **Evidência e regra (coordenador):** Só kit.ts:594–596 cria esse material, dentro do createBuildingKit sem chamador: GLSL por onBeforeCompile (L52–118) que nunca roda; MassingUniforms é só tipo para facadeLevel.ts.
- **Responsabilidades (a-l):** L7–18 glass/sill/head constants, uniforms interface; L21–45 GLSL for instanced box levels; L48–122 `createMassingMaterial` (GLSL patch: windows by bay/storey pulse filter, lit rooms, lamp colours); L125–135 `createMassBoxDepth`
- **Achados do leitor (a-l):**
  - `[LAYER]`/`[BUG]` (inference) massingMaterial.ts:52–118 — window drawing exists only as GLSL `onBeforeCompile` string replacement on `MeshStandardMaterial`; under `WebGPURenderer` (src/render/scene.ts:12) it would not apply. Only caller is kit.ts `createBuildingKit` (no caller) → `[DEAD]` chain.
  - `[TEXT]` massingMaterial.ts:55–116 — relies on three r186 chunk names (`#include <color_vertex>` etc.) as replacement anchors; L58 comment records a past silent failure (all box levels drawn as nothing).
  - `[DEAD]` massingMaterial.ts:119–120 — comment about a lot overlay "not part of this engine's materials".
- **Superfície pública:** `MassingUniforms`, `createMassingMaterial`, `createMassBoxDepth`.

#### `src/r40/render/buildings/meshCore.ts`

- **Veredito: DIVIDIR** → src/render/buildings/emit/shell.ts (Shell e emissor), grow.ts (Grow), paints.ts, facadeRules.ts (regras de abertura, domínio)
- **Evidência e regra (coordenador):** Bandeiras, tintas, regras de fachada, crescimento de arrays, linhas de instância, solda e emissor juntos; flagSink global mutável exportado e escrito por roofMesh.ts:310–312 (L23–25); array de 8 por Shell.face no caminho quente do worker (L637–639); 17 exports mortos.
- **Responsabilidades (a-l):** L23–28 flag sink + `flagOf`; L30–62 paint/colour helpers; L64–104 ~20 dimension constants; L106–222 `openingOf` (opening size per bay component); L224–267 `Grow`; L269–365 `PartRows` (instance rows per part kind) + sinks; L373–494 `hashWord`, `ShellPart` (vertex weld with open-addressing hash); L496–657 `Shell` (face writer: octahedral normals, tone noise, grime, run stamps); L659–692 `V3`, `BayFace`, `sideFrame(Into)`; L694–864 `Emitter` (local→world, rect/box/slab/strip/jamb/cylinder, part placement); L866–885 `slotOfBay`, `bayKey`, `shaded`, `wearShort`
- **Achados do leitor (a-l):**
  - `[MIX]` meshCore.ts:1–886 — flags, paints, facade opening rules (domain values), typed-array growth, instance rows, vertex welding, shell writer, emitter and slot lookup in one 39 KB file.
  - `[HOST]` meshCore.ts:23–25 — global mutable `flagSink` exported as a live `let` and read by roofMesh.ts:310–312; emission side channel instead of passing the sink through `Emitter`.
  - `[ALLOC]` meshCore.ts:637–639 — `runBytes` allocates an 8-element array per `Shell.face` call on a stamped run (hot worker path; file's own comment L580 says every shell vertex passes here).
  - `[ALLOC]` meshCore.ts:723–735 — `L`, `N`, `P` return a new array per call; `box`/`slab`/`cylinder` L766–804 allocate 4–5 point arrays + lists per face (the quad scratch at L738 is used only by rect/strip/jamb).
  - `[ALLOC]` meshCore.ts:883 — `shaded` allocates a new Paint per call (called per face/bay in roofMesh.ts).
  - `[DUP]` meshCore.ts:226 `Grow` = massing.ts:72 `Grown`; meshCore.ts:37 `linear` = massing.ts:61 `rgbOf`; meshCore.ts:76–88 constants = massing.ts:50–56/359.
  - `[DEAD]` meshCore.ts:874–875 — `const along = …; void along;` in `slotOfBay`.
  - `[NAME]` meshCore.ts:762–763, 821–822 — orphan doc comments ("An axis-aligned box…" above `cylinder`; "An instance placed on a bay face…" above field `slot`).
  - `[OMAP]` (inference) meshCore.ts:870, 876 — `slotOfBay` does `spaces.find` + `floor.spaces.find` linear scans per bay (per building, not city).
  - `[LAYER]` (inference) meshCore.ts:15 — imports `PART_KINDS` from kit.ts (three materials, meshoptimizer) into the worker emission core.
- **Superfície pública:** `flagSink`/`setFlagSink`/`flagOf`, `Paint`/`paint`/`linear`/paint constants, dimension constants, `openingOf`, `Grow`, `PartRows`, `partSink`, `furnitureRows`, `ShellPart`, `Shell`, `FacadeStamp`, `Emitter`, `BayFace`, `sideFrame(Into)`, `slotOfBay`, `bayKey`, `shaded`, `wearShort`, `toByte`, `hashWord`.
- **Exports nunca importados (b):** `Rgb`, `linear`, `WHITE_RGB`, `PART_DEFAULT_COLOUR`, `trimColours`, `SHADER_DRAWN`, `LOGGIA_DEPTH`, `Typed`, `Grow`, `PartRows`, `Stream`, `hashWord`, `FACE_NORMAL`, `faceIds`, `FacadeStamp`, `toByte`, `wearShort`

#### `src/r40/render/buildings/partFiling.ts`

- **Veredito: MOVER** → src/render/buildings/partFiling.ts
- **Evidência e regra (coordenador):** Só partBandings é usado; fileParts, filingBuffers, filingBytes sem chamador (L66, L196); chaves 'coluna,linha' em string (L67–72).
- **Responsabilidades (a-l):** L12–22 sub-cell constants (64 m, 4×4, Morton); L25–30 `partBandings`; L33–51 types; L54–60 band by error; L66–79 `fileParts`; L83–121 per-sub-cell banding and copy; L124–193 `fileKind` (bands, merging small bands, packing per sub-cell); L196–207 transfer buffers / byte count
- **Achados do leitor (a-l):**
  - `[DEAD]` partFiling.ts:66, 196 — `fileParts`, `filingBuffers`, `filingBytes` have no caller in src (only `partBandings` is used, buildingMesh.ts).
  - `[TEXT]` partFiling.ts:67–72 — sub-cell keys parsed from "column,row" strings.
  - `[ALLOC]` partFiling.ts:140–155 — Maps, spread arrays and typed arrays per kind per cell (a filing job, bounded).
  - `[LAYER]` (inference) partFiling.ts:4 — imports from kit.ts (materials) for `PART_KINDS`.
  - `[NAME]` partFiling.ts:83–86 — parameter `m` shadows the imported `m()` units helper.
- **Superfície pública:** `DETAIL_CELL`, `SIDE`, `LEAVES`, `DRAW_TRIANGLES`, `morton`, `partBandings`, `FiledBand`, `PartFiling`, `fileParts`, `filingBuffers`, `filingBytes`.
- **Exports nunca importados (b):** `PartBanding`, `PartBandings`, `DETAIL_CELL`, `SIDE`, `LEAVES`, `DRAW_TRIANGLES`, `morton`, `FiledBand`, `PartFiling`, `fileParts` (nem no arquivo), `filingBuffers` (nem no arquivo), `filingBytes` (nem no arquivo)

#### `src/r40/render/buildings/partPose.ts`

- **Veredito: DIVIDIR** → partes de dados (POSE_FLOATS, poseMatrixInto, posedCopy) ficam; o remendo GLSL (L78–92) é APAGADO
- **Evidência e regra (coordenador):** O remendo de pose em GLSL por onBeforeCompile (L78–92) só faz sentido no WebGL; poseMatrices sem chamador (L22); chave de cache pelo texto da função (L84).
- **Responsabilidades (a-l):** L6–26 8-float pose layout and matrix expansion; L29–48 posed geometry copy / release sharing model buffers; L51–71 GLSL pose-matrix injection; L73–98 `posePart` material patch and per-material depth material
- **Achados do leitor (a-l):**
  - `[DEAD]` partPose.ts:22 — `poseMatrices` has no caller in src (comment says used by fracture.ts).
  - `[LAYER]`/`[BUG]` (inference) partPose.ts:78–92 — pose decoding exists only as GLSL `onBeforeCompile` patch (r186 WebGL program internals named); WebGPURenderer would ignore it and draw instances at the origin/identity.
  - `[TEXT]` partPose.ts:84 — cache key derived from `onBeforeCompile.toString()` source text.
- **Superfície pública:** `POSE_FLOATS`, `poseMatrixInto`, `poseMatrices`, `posedCopy`, `letGoPosed`, `partPoseShader`, `posePart`, `partPoseDepth`.
- **Exports nunca importados (b):** `poseMatrices` (nem no arquivo), `partPoseShader`

#### `src/r40/render/buildings/partyWalls.ts`

- **Veredito: MOVER** → src/render/buildings/partyWalls.ts
- **Evidência e regra (coordenador):** Remoção de paredes de divisa invisíveis; regra do piso duplicada de massing.ts:204–206 (L58–59); arcada achada pela string 'pillar' (L95).
- **Responsabilidades (a-l):** L14–30 `Cover` type and sampling constants; L33–103 `PartyWalls` (job's buildings' floors and block covers, neighbour query by box); L106–120 `hiddenByCovers` (stretch of wall fully inside neighbours' blocks)
- **Achados do leitor (a-l):**
  - `[OMAP]` (inference) partyWalls.ts:69–72 — `coversNear` scans every building of the job per call (O(job²) over a job); bounded by the job, not the city.
  - `[ALLOC]` partyWalls.ts:111 — `{x, y}` object per sample step; L88 ring `.map` per volume.
  - `[OBJ]` (inference) partyWalls.ts:34–36 — caches keyed by `Building` object identity (per-building JS objects held for the job; worker-local).
  - `[DUP]` partyWalls.ts:58–59 — floor rule duplicates massing.ts:204–206 `massFloor`.
  - `[TEXT]` partyWalls.ts:95 — arcade detection by the string `'pillar'` inside facade fill/sides/bays.
- **Superfície pública:** `Cover`, `PARTY_NUDGE`, `PartyWalls`, `hiddenByCovers`.
- **Exports nunca importados (b):** `PARTY_NUDGE`

#### `src/r40/render/buildings/roofMesh.ts`

- **Veredito: DIVIDIR** → src/render/buildings/roofShapes.ts (formas, único com massing) + src/render/buildings/roofDetails.ts
- **Evidência e regra (coordenador):** Mesmas regras de telhado de massing.ts (L379–680); cores de veneziana e laje (fachada) no módulo do telhado (L216–232); 21 exports mortos; parapeito do telhado com contorno sem coveredSpans (L470–478).
- **Responsabilidades (a-l):** L14–21 coping choice; L23–112 `emitRoofPlant` (drains, tanks, condensers, air handlers, solar, masts, dishes, skylights, vents, lift rooms, chimneys); L114–130/178–180 paints; L132–176 `emitTerrace` (deck, pots, parasols, loungers, pergola, tank); L182–214 bands/mouldings and covered span intersection; L216–232 shutter/slab colours; L234–242 cornice; L244–307 roof details (solar, skylight, vent, spire, chimney); L309–313 flag emit; L315–377 lantern/lighthouse; L379–483 shaped-block roofs; L485–680 rectangular roofs (flat parapets, gable/hip with fascia/soffit/ridge, shed, sawtooth)
- **Achados do leitor (a-l):**
  - `[MIX]` roofMesh.ts:216–232 — shutter and slab colour helpers (facade concerns) live in the roof module.
  - `[ALLOC]` roofMesh.ts:246–250, 275, 319–325 — `paint()` (a `three.Color` each) created on every call of `emitRoofDetails`/`emitLantern`/per spire; L531–535 `shaded()` and `copingOf()` per bay piece; L524 `{...sideFrame(...)}` per piece; L443–444 `.map` objects per triangle.
  - `[DUP]` roofMesh.ts:379–680 vs massing.ts:454–605 — same roof geometry rules in two files (see massing).
  - `[DUP]` roofMesh.ts:26 — `if (v.outline) return` repeats roofPlan.ts:21 (`roofPlantOf` already returns [] for shaped blocks); for shaped blocks drains are skipped too.
  - `[BUG]` (inference) roofMesh.ts:470–478 — shaped (outline) flat roof lays its parapet along every side with no `coveredSpans` check, while the rectangular path (L514–518) and the far mass (massing.ts:432–437) skip sides against a taller neighbour block: a parapet can stand inside an adjoining block (hidden geometry / near–far mismatch).
  - `[BUG]` (inference) roofMesh.ts:481–482 — shaped terrace gets cornice but no `emitTerrace` (terraceDeck returns null for outline, roofPlan.ts:66), consistent with roofPlan; and `emitRoofPlant` call at L482 is dead for outline blocks (returns at L26).
  - `[HOST]` roofMesh.ts:310–312 — writes into meshCore's global `flagSink`.
  - `[TEXT]` roofMesh.ts:252–305 — roof detail kinds dispatched on strings.
  - `[R40COPY]` roofMesh.ts:1 — header "Part of the R40 building mesh pipeline"; L569 "the player's order of 2026-10-05".
- **Superfície pública:** `ALUMINIUM_COPING`, `copingOf`, `emitRoofPlant`, paints (`TANK_PAINTS`, `CHIMNEY`, `DRAIN`, `SOLAR`, `SKYLIGHT`, `DECK`, `POT`, `POT_SOIL`, `PARASOL`, `CONDENSER`, `DOOR_PAINT`), `emitTerrace`, `band`, `flushBand`, `bothCovered`, `SHUTTER_PAINTS`, `slabColour(s)`, `shutterColour`, `emitCornice`, `emitRoofDetails`, `emitFlag`, `emitLantern`, `emitPolygonRoof`, `emitRoof`.
- **Exports nunca importados (b):** `ALUMINIUM_COPING`, `copingOf`, `emitRoofPlant`, `TANK_PAINTS`, `CHIMNEY`, `DRAIN`, `SOLAR`, `SKYLIGHT`, `DECK`, `POT`, `POT_SOIL`, `PARASOL`, `emitTerrace`, `CONDENSER`, `DOOR_PAINT`, `SHUTTER_PAINTS`, `slabColours`, `emitCornice`, `emitFlag`, `emitLantern`, `emitPolygonRoof`

#### `src/r40/render/buildings/roofPlan.ts`

- **Veredito: MOVER** → src/jobs/buildingGen/roofPlan.ts (com o roofPlant único)
- **Evidência e regra (coordenador):** Planejamento do que fica no telhado (domínio) em render/; roofPlantOf refaz machineRooms a cada chamada (L31–32).
- **Responsabilidades (a-l):** L8–17 roof colours and tank colours; L20–35 `roofPlantOf` (seeded plan for flat roofs, blocked by blocks and machine rooms); L38–59 `machineRooms`; L62–78 terrace seed, deck and parasols; L81–83 parasol sizes
- **Achados do leitor (a-l):**
  - `[ALLOC]`/`[OMAP]` (inference) roofPlan.ts:31–32 — `roofPlantOf` filters all volumes and recomputes `machineRooms(b)` (O(cores × volumes)) on every call; called per flat volume by both levels.
  - `[DUP]` roofPlan.ts:62 — seed hash `b.id * 2654435761` pattern also in massing.ts:201/244, roofPlan L27 uses another constant.
  - `[LAYER]` (inference) — planning data (what stands on a roof) in render/, wraps world/buildings/roofPlant.ts.
- **Superfície pública:** `ROOF_COLOURS`, `TANK_COLOURS`, `roofPlantOf`, `machineRooms`, `terraceSeed`, `terraceDeck`, `terraceParasols`, `PARASOL_HALF/LOW/HIGH`.

#### `src/r40/render/buildings/roomBehind.ts`

- **Veredito: MOVER** → src/features/interiors/roomBehind.ts
- **Evidência e regra (coordenador):** Sala atrás da janela; tipos por string (L15–24, L45–47); floorKind usado por interiorMesh.ts:5 (L44).
- **Responsabilidades (a-l):** L7–24 room layout constants and furniture kinds seen through panes; L27–38 ray/segment hit; L41–50 `floorKind`; L56–114 `PaneMemo` (hash table keyed by 9 floats); L117–170 `roomsOfStorey` (closure computing a pane's room box, floor, ceiling, biggest furniture piece)
- **Achados do leitor (a-l):**
  - `[TEXT]` roomBehind.ts:15–24 — furniture kinds chosen by string switch; L162 `FURNITURE_KINDS.indexOf(f.kind)` string search per selected piece.
  - `[TEXT]` roomBehind.ts:45–47 — floor kind decided by building function strings ('house', 'hotel', …).
  - `[ALLOC]` roomBehind.ts:166–168 — a 12-number array per new pane room (memoised per storey); L118–124 `walls` number[] per storey.
  - `[OMAP]` (inference) roomBehind.ts:146–163 — every pane scans all furniture of the storey and all walls (O(panes × furniture)) per storey, bounded per building.
  - `[MIX]` roomBehind.ts:44 — `floorKind` (interior floor finish rule) lives here and is imported by interiorMesh.ts:5.
- **Superfície pública:** `ROOM_FLOATS`, `FloorKind`, `floorKind`, `roomsOfStorey`.
- **Exports nunca importados (b):** `FloorKind`

#### `src/r40/render/buildings/roomLamps.ts`

- **Veredito: DIVIDIR** → lampVec (dados) fica; ROOM_LAMP_GLSL só serve aos materiais GLSL mortos e sai com eles
- **Evidência e regra (coordenador):** Normalização da cor Kelvin escrita duas vezes (L15–20 × L36–41); só GLSL, sem equivalente TSL (L46).
- **Responsabilidades (a-l):** L4–20 black-body sRGB table → linear normalised GLSL vec3; L23–43 home/office lamp mixes as GLSL; L46–59 `ROOM_LAMP_GLSL` (lamp pick, mean, TV flicker); L62 `TV_SHARE`
- **Achados do leitor (a-l):**
  - `[DUP]` roomLamps.ts:15–20 vs 36–41 — the normalisation of a Kelvin colour is written twice (lampVec and meanGlsl).
  - `[LAYER]` (inference) roomLamps.ts:46 — GLSL string only; no TSL/WGSL equivalent here for the WebGPURenderer.
  - (inference) Kelvin table and mixes are uncited in the file (no source for 0.36/0.24/0.1/0.3 or 12 % TV).
- **Superfície pública:** `ROOM_LAMP_GLSL`, `TV_SHARE`.

#### `src/r40/render/buildings/shellParts.ts`

- **Veredito: DIVIDIR** → dados e ruído em TS ficam; o espelho GLSL (L115–164) sai com os materiais mortos
- **Evidência e regra (coordenador):** Mesmo ruído em TS e GLSL mantidos à mão (L29–52 × L115–137); shellUv espelhado (L55–77).
- **Responsabilidades (a-l):** L4–26 shell part kinds and look constants; L29–52 allocation-free 3D value noise; L55–77 planar uv (TS + GLSL); L80–109 unit models of box/rail/slab faces; L111–164 GLSL for instanced shell parts (noise, paving inset, uv/tone/grime)
- **Achados do leitor (a-l):**
  - `[DUP]` shellParts.ts:29–52 vs 115–137 — the same noise in TS and GLSL (intentional mirror; must be kept in lockstep by hand).
  - `[DUP]` shellParts.ts:55–66 vs 69–77 — `shellUv` mirrored in GLSL.
  - `[LAYER]` (inference) shellParts.ts:115–164 — GLSL only, relies on three WebGL chunk variables (`instanceMatrix`, `vColor`, `objectNormal`).
- **Superfície pública:** `ShellPartKind`, `SHELL_PART_KINDS`, `SHELL_PARTS`, `LOOK_FLOATS`, `GROUND_ATTRIBUTE`, `NO_GROUND`, `MACRO_SCALE`, `GRIME_REACH`, `COVER_INSET`, `macroNoiseInto`, `shellUv`, `SHELL_UV_GLSL`, `ShellPartFace`, `SHELL_PART_FACES`, `SHELL_PART_PARS`, `SHELL_PART_BEGIN`, `shellPartVertex`.
- **Exports nunca importados (b):** `shellUv` (nem no arquivo)

#### `src/r40/render/buildings/signature.ts`

- **Veredito: DIVIDIR** → src/render/buildings/landmarks/painters.ts (pintura em canvas), materials.ts, kit.ts (geometria), designs/<grupo>.ts (~35 projetos em 5–6 arquivos)
- **Evidência e regra (coordenador):** 108 KB (> 50 KB; maior arquivo de src); pintura de textura, biblioteca de materiais, kit de geometria e ~35 projetos à mão; texto do jogador em português pintado nas fachadas (L1348–1662); heliponto é um decal vertical de 10 m no telhado (L1357); um Group com um Mesh por material por prédio (L1753–1766); toda geometria convertida para não indexada antes do merge (L367: 24→36 vértices por caixa).
- **Responsabilidades (a-l):** L37–41 FNV seed of a name; L43–181 `facade()` canvas-painted facade pictures (24 styles) + material cache; L183–193 canvas texture helper; L195–354 `makeMaterials()` ~60 shared MeshStandardMaterials with canvas textures (stone, wood, slats, railing alpha, ashlar, speckle, rusticated, deco, seams, chevrons, courses); L357–597 `Parts` geometry builder (box, rail, plant, cone, bush, ellipse, prism, gable, hip, dome, steps, decal, lamp, flag, tree, cypress, cylinder, windowFront, windowSide); L600–704 design `balconyMid`; L707–883 `TowerLook` table + `towerOf` parametric tower; L889–936 roofRing/archOpening/podium2/roofPlant helpers; L938–1140 ten "second set" designs; L1144–1227 canvas painters (lettering, clock, red cross, helipad, flags, garage door, badge, scales, rose window, arch door, iron gate, banner); L1229–1244 colonnade/balustrade; L1246–1724 civic designs (2 city halls, deco spire, hospital A/B, lofts, forum, church, bank, school, fire station, police, cemetery); L1726–1732 DESIGNS registry (+LANDMARKS); L1735–1780 public build/dispose.
- **Achados do leitor (a-l):**
  - [MIX] signature.ts:1–1781 — 108 KB / 1781 lines: texture painting, material library, geometry kit, ~35 hand-modelled designs and canvas painters in one file; above the 50 KB new-file gate (under 150 KB).
  - [MAIN] signature.ts:184,523 — `document.createElement('canvas')` + Canvas2D painting and all BoxGeometry/mergeGeometries building (L1741–1776) need the DOM, so the whole body build runs on the main thread (inference: no OffscreenCanvas/worker path).
  - [OBJ] signature.ts:1753–1766 — each signature building is its own Group with one Mesh per material used (dozens of materials → dozens of draw calls per building), no instancing/batching across buildings.
  - [ALLOC] signature.ts:381,410,422,429,437,451,505,532,568 — every part is a fresh three geometry (thousands of BoxGeometry for a tall tower: per-floor loops L637–673, L818–853, L1002–1020, L1032–1046) then `toNonIndexed()` (L367) and merged; build path per building, grows with storeys.
  - [OBJ]/[excess geometry] signature.ts:367 — `push` turns every geometry non-indexed (boxes 24→36 verts) before merge: more vertices than needed.
  - [excess geometry] signature.ts:479–491 — `gable` pushes every triangle twice (both windings) "rather than trust the order": doubled triangles instead of a correct winding.
  - [excess geometry] signature.ts:377–380 — any facade-material box (`mat.includes('|')`) gets a roofing cap even when another block sits on it (e.g. stacked shaft/crown L806–811, pinkCorner L1110 under the 0.5 m white cap L1123, decoSpire tiers L1305): hidden caps.
  - [excess geometry] signature.ts:944–946 — twistGreen draws a closed prism per floor (`openEnded=false`, L451): internal top/bottom caps between every floor.
  - [TEXT] signature.ts:378 — facade vs shared material decided by the key containing `'|'` and not starting `'decal|'`; L1762 shadow casting decided by material name strings `'glass'`/`'sconce'`; L858 `'curtainStrip'` magic material name.
  - [TEXT]/[NAME] signature.ts:1348–1366,1383,1399,1432,1435,1474,1543–1548,1566,1577,1600,1604,1612,1621,1632–1662 — player-visible Portuguese text painted into textures ('HOSPITAL', 'EMERGÊNCIA', 'PRONTO-SOCORRO', 'CORPO DE BOMBEIROS', 'POLÍCIA CIVIL', 'BANCO', 'ESCOLA'...) hard-coded, not through `engine.en.ts`/`engine.pt-BR.ts`.
  - [BUG] signature.ts:1357 — helipad is a `decal` (vertical PlaneGeometry, faces only front/left/right, L517–537) placed at roof height: a 10 m upright billboard on the roof, not a pad lying on it.
  - [BUG] signature.ts:974–993 — stepGarden `break`s when tiers get too narrow (L991) but `roofPlant` is placed at full `g + upper*s` (L993): plant room floats above the last tier on narrow lots. Same in decoSpire L1304 (`break`) vs crown fins/spire at `top` (L1316–1323).
  - [BUG] signature.ts:810–813,863–876 — towerOf skips crown tiers when the shaft is too small (`sw - 2c > 4`) but still sets the roof/parapet at `top` inset by `cTop`: roof floats above `crownZ` on small footprints (inference from the arithmetic).
  - [BUG] signature.ts:519–531 — decal material cached by key only; same key reused with a different aspect (e.g. 'archDoorTall' 3.2×5.6 at L1259 vs 2.4×4.4 at L1434) reuses the first canvas → mild stretching.
  - [BUG] signature.ts:440–445 — `ellipse` UV from atan2 wraps at the seam: one strip of faces interpolates u across the full circumference (inference).
  - [DEAD] signature.ts:1747 — `_g` unused in cityHallBrick/cityHallWhite (designs ignore storey data, fixed sizes).
  - [R40COPY] signature.ts:599,706,885 — "Image 1", "reference sheets", "the second set" comments and names like 'RIVERTON & CIA' suggest a transcription of 4.0's reference designs (inference).
  - [LAYER] OK: imports only r40/core, r40/world, sibling landmarks.
- **Superfície pública:** `drawsSignature(b)` whether a building is drawn here; `buildSignature(b, floor)` builds its Group; `disposeSignature(group)` disposes geometries.
- **Exports nunca importados (b):** `buildSignature` (nem no arquivo), `disposeSignature` (nem no arquivo)

#### `src/r40/render/buildings/thinParts.ts`

- **Veredito: APAGAR** → —
- **Evidência e regra (coordenador):** só é chamado dentro de createBuildingKit (kit.ts:485–700), que não tem chamador em src (conferido): código que nunca roda; além disso é onBeforeCompile/GLSL do WebGLRenderer (L45–66), sem efeito no WebGPURenderer.
- **Responsabilidades (a-l):** L4–31 `twoSided` indexed two-sided copy of a geometry; L34–68 `prefilterThinParts` shader patch fading sub-pixel bars (frames, railings) to a background tone.
- **Achados do leitor (a-l):**
  - [BUG] thinParts.ts:45–66 — patch uses `onBeforeCompile`/`customProgramCacheKey` and GLSL chunks (`#include <color_fragment>`); these are WebGLRenderer mechanisms; under the project's `WebGPURenderer` (node materials) they are not applied (inference: depends on which renderer draws these materials).
  - [BUG] thinParts.ts:66 — one cache key `'thin-part-prefiltered-v2'` for every kind while uniforms are per material; comment says intended, ok, but `thinBar` values differ per kind only through uniforms (fine) — no defect if uniforms are rebound per material (inference).
  - [BUG] thinParts.ts:9–16 — copies only position and normal; uv/colour/other attributes of the source are dropped (any textured thin part loses UVs).
- **Superfície pública:** `twoSided(g)`; `prefilterThinParts(materials, more)`.

#### `src/r40/render/depthConvention.ts`

- **Veredito: APAGAR** → —
- **Evidência e regra (coordenador):** só é chamado dentro de createBuildingKit (kit.ts:485–700), que não tem chamador em src (conferido): código que nunca roda; API do WebGL (onBeforeRender + reversedDepthBuffer, L33–35).
- **Responsabilidades (a-l):** L6–22 GLSL helpers for normal vs reversed depth; L28–36 `pullTowardEye` polygon offset with sign flipped for reversed depth.
- **Achados do leitor (a-l):**
  - [SMALL] depthConvention.ts — 37 lines, one constant + one function.
  - [BUG] depthConvention.ts:33–35 — relies on `onBeforeRender(renderer)` and `renderer.capabilities.reversedDepthBuffer` (WebGLRenderer API); GLSL `DEPTH_GLSL` unusable by TSL/WebGPU passes (inference: WebGPU path would need a TSL twin).
  - [BUG] depthConvention.ts:33 — `onBeforeRender` overwrites any previous handler on the material (no chaining).
- **Superfície pública:** `DEPTH_GLSL`; `pullTowardEye(material, slope, steps)`.
- **Exports nunca importados (b):** `DEPTH_GLSL` (nem no arquivo)

#### `src/r40/render/lightLevels.ts`

- **Veredito: APAGAR** → — (os valores de luminância, se forem os do 4.0, vão para o material TSL de render/buildings)
- **Evidência e regra (coordenador):** só é chamado dentro de createBuildingKit (kit.ts:485–700), que não tem chamador em src (conferido): código que nunca roda; usado só em kit.ts:535, :679, :689.
- **Responsabilidades (a-l):** L4–23 night luminance table for lights; L28–36 luminance / night gain; L39–61 light-pool DataTexture.
- **Achados do leitor (a-l):**
  - [SMALL] lightLevels.ts — small utility module.
- **Superfície pública:** `NIGHT_LUMINANCE`, `luminanceOf`, `nightGain`, `lightPoolTexture`.
- **Exports nunca importados (b):** `nightGain` (nem no arquivo)

#### `src/r40/render/mesh/gpuOnly.ts`

- **Veredito: MOVER** → src/render/mesh/gpuOnly.ts
- **Evidência e regra (coordenador):** Comportamento por chaves de texto em userData ('refillArrays', L11–12, L32–33); grava keptBytes em atributos do three (L17).
- **Responsabilidades (a-l):** L14–19 drop CPU arrays after upload (remember byte size); L22–34 register refill/fill callbacks in `userData`; L37–56 fill / refill helpers (context restore).
- **Achados do leitor (a-l):**
  - [TEXT] gpuOnly.ts:11–12,32–33 — behaviour attached via string keys 'refillArrays'/'fillArrays' in `userData`.
  - [HOST] gpuOnly.ts:17 — writes ad-hoc `keptBytes` onto three attributes for `memoryCounters.ts` (state hidden on a foreign object).
- **Superfície pública:** `GeometryArrays`, `gpuOnlyAttributes`, `fillArrays`, `gpuOnly`, `refillArrays`.
- **Exports nunca importados (b):** `GeometryArrays`, `fillArrays` (nem no arquivo), `gpuOnly` (nem no arquivo), `refillArrays` (nem no arquivo)

#### `src/r40/render/mesh/textureBaker.ts`

- **Veredito: MOVER** → src/render/bake/textureBaker.ts
- **Evidência e regra (coordenador):** Módulo de cozimento usado só por finishRecipes.ts; mora em render/mesh sem ser malha.
- **Responsabilidades (a-l):** L4–29 tiling value noise; L32–52 fbm; L55–76 normal texels from height; L81–95 `SurfaceRecipe`; L107–141 bake colour/normal/rough texels.
- **Achados do leitor (a-l):**
  - [LAYER] textureBaker.ts — lives under `render/mesh` but is a build-time pure module used by `scripts/vite` (inference: misplaced folder, not a runtime mesh util).
  - [ALLOC] textureBaker.ts:119 — `recipe.shade` called with a reused `out` object (good, no per-texel alloc).
- **Superfície pública:** `makeNoise`, `fbm`, `normalTexels`, `SurfaceRecipe`, `surfaceTexels`.
- **Exports nunca importados (b):** `normalTexels`, `surfaceTexels` (nem no arquivo)

#### `src/r40/render/mesh/weld.ts`

- **Veredito: MOVER** → src/render/mesh/weld.ts
- **Evidência e regra (coordenador):** Igual a mergeVertices do three por velocidade (L5); clona a geometria inteira só para trocar atributos (L62).
- **Responsabilidades (a-l):** L5–71 `weldGeometry` reimplementation of three's `mergeVertices` with a numeric open-addressing hash; L74–80 key compare.
- **Achados do leitor (a-l):**
  - [DUP] weld.ts:5 — same contract as three `BufferGeometryUtils.mergeVertices` (falls back to it L9–11); kept for speed.
  - [ALLOC] weld.ts:62 — `geometry.clone()` copies all old attributes and index only to replace them (wasted copy per weld; build path).
  - [BUG] weld.ts:62–69 — geometry groups are cloned unchanged while the index is rebuilt with the same count, so groups stay valid; morph/interleaved fall back (ok). No defect found beyond the copy.
- **Superfície pública:** `weldGeometry(geometry, tolerance)`.

#### `src/r40/render/shadowCasters.ts`

- **Veredito: APAGAR** → —
- **Evidência e regra (coordenador):** Só flagLayer.ts importa, e só como tipo: o código nunca roda (script de alcance a partir de main.ts); visita cada caster por cascata por quadro (L22–27).
- **Responsabilidades (a-l):** L6–10 `SizedCaster` interface; L12–18 registry; L21–28 per-cascade `castShadow` toggling by size.
- **Achados do leitor (a-l):**
  - [OMAP] shadowCasters.ts:22–27 — every registered caster is visited per cascade per frame; set size grows with the number of meshes registered in the loaded world (inference: bounded only by streaming).
  - [SMALL] shadowCasters.ts — 29 lines.
- **Superfície pública:** `SizedCaster`, `castBySize`, `castCastersInto`.
- **Exports nunca importados (b):** `SizedCaster`, `castCastersInto` (nem no arquivo)

#### `src/r40/render/surfaceTextures.ts`

- **Veredito: MOVER** → src/render/bake/surfaceTextures.ts
- **Evidência e regra (coordenador):** Anisotropia mudada numa textura compartilhada por todos os materiais (L66–73); 6 exports mortos.
- **Responsabilidades (a-l):** L17–37 texture set with let-go of texels after upload and re-request; L42–63 prime/refill/want-all; L66–98 lookup by name with anisotropy; L100–104 dispose.
- **Achados do leitor (a-l):**
  - [BUG] surfaceTextures.ts:66–73 — raising anisotropy mutates a shared texture used by every material with that surface; the last caller's higher anisotropy wins for all (by design "at least"), fine; but when texels were let go it calls `want` and returns a texture whose re-upload waits — the anisotropy change is only applied when refill arrives (inference: ok).
- **Superfície pública:** `SurfaceBake`, `primeSurfaceTextures`, `refillSurfaceTexels`, `wantAllTexels`, `surfaceTexture`, `surfaceMaps`, `requireSurfaceMaps`, `disposeSurfaceTextures`.
- **Exports nunca importados (b):** `primeSurfaceTextures` (nem no arquivo), `refillSurfaceTexels` (nem no arquivo), `wantAllTexels` (nem no arquivo), `surfaceTexture`, `requireSurfaceMaps` (nem no arquivo), `disposeSurfaceTextures` (nem no arquivo)

#### `src/r40/render/terrainGrid.ts`

- **Veredito: JUNTAR** → src/config.ts
- **Evidência e regra (coordenador):** 13 linhas de constantes de grade usadas por lotMesh.ts.
- **Responsabilidades (a-l):** L6–12 terrain plate constants for workers.
- **Achados do leitor (a-l):**
  - [SMALL] terrainGrid.ts — 13 lines of constants; used by workers (`buildings/buildingMesh.ts`) per comment L3.
- **Superfície pública:** `TERRAIN_SIZE`, `TERRAIN_SEGMENTS`, `TERRAIN_CELL`, `TERRAIN_HALF`.
- **Exports nunca importados (b):** `TERRAIN_SIZE`, `TERRAIN_SEGMENTS`

#### `src/r40/render/wind.ts`

- **Veredito: APAGAR** → — (se o balanço do vento nas peças for do 4.0 e visível, reescrever em TSL em src/render/wind.ts)
- **Evidência e regra (coordenador):** Só flagLayer.ts importa, e só como tipo: o código nunca roda; todo ele é onBeforeCompile/ShaderChunk do WebGL (L67–192); fórmula da rajada escrita 3 vezes (L50–51, L153–154, L183–184); 10 exports mortos.
- **Responsabilidades (a-l):** L14–27 shared wind uniforms + weather setter; L36–83 GLSL sway/flutter install into three's `project_vertex`; L86–98 near-camera dither fade; L101–110 sway marking; L113–132 `applyWind`, depth twin; L135–141 clock; L144–158 wire wind GLSL; L161–193 stiff structure sway.
- **Achados do leitor (a-l):**
  - [BUG] wind.ts:67–83,116–131,164–192 — all via `onBeforeCompile`, `ShaderChunk`, `MeshDepthMaterial(RGBADepthPacking)`; WebGL-only mechanisms, not applied by `WebGPURenderer` node materials (inference: the project's target renderer is WebGPU + TSL).
  - [BUG] wind.ts:192 — `customProgramCacheKey` `sway-${key}` per caller while L112 warns a key per user multiplied programs; uniforms already carry the per-structure numbers, so the per-key program split is the same pattern the file forbids for `applyWind`.
  - [DUP] wind.ts:50–51,153–154,183–184 — gust-front formula repeated three times in GLSL strings.
  - [MIX] wind.ts — foliage sway, near-camera fade, wire sway, structure sway and the shadow-mover marker in one file.
  - [DEAD] wind.ts:113,126 — `_name` parameter unused.
- **Superfície pública:** `windUniforms`, `setWindWeather`, `WindResponse`, `markSway`, `sways`, `applyWind`, `windDepthMaterial`, `advanceWind`, `WIRE_WIND_UNIFORMS_GLSL`, `wireWindGlsl`, `applyStructureSway`.
- **Exports nunca importados (b):** `setWindWeather` (nem no arquivo), `WindResponse`, `markSway`, `sways` (nem no arquivo), `applyWind` (nem no arquivo), `windDepthMaterial` (nem no arquivo), `advanceWind` (nem no arquivo), `WIRE_WIND_UNIFORMS_GLSL` (nem no arquivo), `wireWindGlsl` (nem no arquivo), `applyStructureSway` (nem no arquivo)

#### `src/r40/world/bounds.ts`

- **Veredito: APAGAR** → — (clampToWorld para src/config.ts se usado)
- **Evidência e regra (coordenador):** 13 exports mortos; limites de mundo sem fim do 4.0 contra a grade fixa do jogo; objetos novos por chamada (L34–88).
- **Responsabilidades (a-l):** L9–14 plate size/reach; L31–60 plate index, key packing, region; L63–78 plates over a rectangle / around a plate; L81–91 world half-extent, inside/clamp.
- **Achados do leitor (a-l):**
  - [ALLOC] bounds.ts:34,43,56,60,88 — returns new objects per call (`plateIJ`, `plateRegion`, `clampToWorld`); hot-path use would allocate (inference).
- **Superfície pública:** `PLATE_SIZE`, `PlateIJ`, `PlateRegion`, `plateIJ`, `plateKey`, `plateOfKey`, `plateOf`, `plateRegion`, `regionAt`, `platesOver`, `platesAround`, `WORLD_HALF`, `insideWorld`, `clampToWorld`.
- **Exports nunca importados (b):** `PlateIJ`, `PlateRegion`, `plateIJ` (nem no arquivo), `plateKey`, `plateOfKey`, `plateOf`, `plateRegion`, `regionAt` (nem no arquivo), `platesOver` (nem no arquivo), `platesAround` (nem no arquivo), `WORLD_HALF`, `insideWorld` (nem no arquivo), `clampToWorld` (nem no arquivo)

#### `src/r40/world/buildings/architecture.ts`

- **Veredito: MOVER** → src/jobs/buildingGen/architecture.ts (reescrito)
- **Evidência e regra (coordenador):** Gramática de fachada do 4.0; muda objetos Volume/Storey por prédio (L263–316); importa mat de cityBuildings.ts para uma fábrica de uma linha (L3).
- **Responsabilidades (a-l):** L11–40 style types; L44–179 12 style definitions; L182–197 style weights per kind and era; L200–211 `styleFor`; L217–236 paints; L239–253 column count / rhythm; L263–318 `composeFacades` writes facade grammar into volumes/storeys; L321–325 stone base.
- **Achados do leitor (a-l):**
  - [OBJ] architecture.ts:263–316 — mutates per-building `Volume`/`Storey` JS objects (`v.dress`, `v.facadeGeometry`, `storey.facade`, per-bay `bays` Record keyed by string) — expanded per-building records, not SoA.
  - [TEXT] architecture.ts:303,308 — bays keyed by `bayKey(side,i)` strings.
  - [LAYER] architecture.ts:3 — imports `mat` from `cityBuildings.ts` (a catalogue) for a one-line factory (dependency direction catalogue ← grammar).
- **Superfície pública:** `StyleKey`, `GroundRole`, `ArchStyle`, `STYLES`, `Era`, `styleFor`, `StylePaints`, `paintsOf`, `columnsFor`, `columnComponent`, `Composition`, `composeFacades`, `stoneBaseOf`.
- **Exports nunca importados (b):** `StyleKey`, `StylePaints`, `columnsFor`, `columnComponent`, `Composition`

#### `src/r40/world/buildings/blocks.ts`

- **Veredito: MOVER** → src/world/buildings/blocks.ts (reescrito)
- **Evidência e regra (coordenador):** `delete v.materials.sides` muda o objeto compartilhado da fonte (L119–130, spread raso); ids max+1000 instáveis (L20); polygonArea igual a footprints.ts:53–56 (L82–85).
- **Responsabilidades (a-l):** L11 memoized resolve; L13–80 boolean ops of volumes (void/intersect/xor) into pieces by level ranges; L82–85 area; L88–104 split polygons with holes; L106–133 volume from a ring.
- **Achados do leitor (a-l):**
  - [BUG] blocks.ts:119–130 — `v` is a shallow spread of `s`; `delete v.materials.sides` mutates the shared `s.materials` object, i.e. the stored source block — contradicts L10 "a stored record is never changed in place"; after one resolve the original block has lost its per-side materials.
  - [BUG] blocks.ts:20 — new ids `max(...)+1000` per resolve: ids of resolved pieces are not stable relative to the source and may collide with real ids if a building ever has >1000 more volumes (inference).
  - [ALLOC] blocks.ts:36 — full polygon clipping per solid/cutter pair to test touching (no box pre-test, unlike `overlapArea` in footprints.ts:63).
  - [DUP] blocks.ts:82–85 — `polygonArea` identical to footprints.ts:53–56.
- **Superfície pública:** `resolveBlocks`.

#### `src/r40/world/buildings/blueprints.ts`

- **Veredito: JUNTAR** → src/world/buildings/presets.ts (um catálogo só com cityBuildings.ts)
- **Evidência e regra (coordenador):** Dois catálogos de predefinições com tipos sobrepostos (L306–318 × cityBuildings.ts:200–340); cópia profunda por JSON (L33, L327).
- **Responsabilidades (a-l):** L21–46 blueprint types, instantiate/place; L52–95 default facade/storey/roof by use; L111–140 `generateBody`; L150–169 `upperStoreyFrom`; L172–201 `generateBlock`; L203–303 preset builders; L306–318 `BLUEPRINTS`; L321–330 lookup / strip placement.
- **Achados do leitor (a-l):**
  - [OBJ] blueprints.ts:119–139 — buildings are nested JS records (volumes → storeys → facade → bays Record) per building.
  - [ALLOC] blueprints.ts:33,327 — deep copy via `JSON.parse(JSON.stringify())`.
  - [TEXT] blueprints.ts:162 — parses side from bay key string `key.split(':')[0]`.
  - [DUP] blueprints.ts:306–318 vs cityBuildings.ts:200–340 — two preset catalogues with overlapping kinds (house, apartments, office, factory, warehouse, shop).
  - [TEXT] blueprints.ts:307–317 — i18n keys `building.preset.<key>` (ok, localized).
- **Superfície pública:** `BlueprintBody`, `Blueprint`, `instantiate`, `placeBody`, `DEFAULT_GROUND_HEIGHT`, `DEFAULT_STOREY_HEIGHT`, `generateBody`, `upperStoreyFrom`, `generateBlock`, `BLUEPRINTS`, `blueprintByKey`, `bodyOf`.
- **Exports nunca importados (b):** `Blueprint`, `instantiate` (nem no arquivo), `placeBody`, `generateBody`, `upperStoreyFrom`, `generateBlock`, `BLUEPRINTS`, `blueprintByKey` (nem no arquivo), `bodyOf` (nem no arquivo)

#### `src/r40/world/buildings/cityBuildings.ts`

- **Veredito: JUNTAR** → src/world/buildings/presets.ts
- **Evidência e regra (coordenador):** ring deixa vão no canto quando o lado não é múltiplo de 4 m (L136–146) e pula uma peça no meio com gate=0 (L139); pedra de arrimo dos lotes no catálogo (L172–177).
- **Responsabilidades (a-l):** L24–52 types; L55–170 `Model` builder (blocks, lots, elements, rows, rings, cores); L172–188 material specs + retaining stone; L191–194 octagon outline; L200–340 `CITY_BUILDINGS` catalogue (~40 functions); L342–344 lookup.
- **Achados do leitor (a-l):**
  - [BUG] cityBuildings.ts:136–146 — `ring` lays 4 m pieces only while `a + 4 <= w`; sides not a multiple of 4 m leave a gap at the far corner (club w=17 → 1 m gap, d=27 → 3 m; prison d=42 → 2 m; cemetery d=30 → 2 m).
  - [BUG] cityBuildings.ts:139 — `gate=0` still skips a piece whose centre is exactly at `w/2` (`> 0` false) — a hole where no gate was asked (occurs when w/2 ≡ 2 mod 4).
  - [MIX] cityBuildings.ts:172–177 — retaining-wall stone identity (`RETAINING_STONE`, `isRetainingStone`) for lot terraces lives in the catalogue file; elements.ts:6 and architecture.ts:3 import from it.
  - [TEXT] cityBuildings.ts:176–177 — retaining wall identified by equality of a material spec (finish + colour), a magic colour.
  - [DUP] cityBuildings.ts:79–104 — storey/door construction parallels blueprints.ts:84–89,111–140; `across = round(w/3)` hard-codes 3 m instead of `DEFAULT_MODULE`.
  - [OBJ] cityBuildings.ts:118–122 — one JS object per element.
- **Superfície pública:** `CityBuilding`, `Model`, `mat`, `RETAINING_STONE`, `isRetainingStone`, `CITY_BUILDINGS`, `cityBuilding`.
- **Exports nunca importados (b):** `CityBuilding`, `CITY_BUILDINGS`, `cityBuilding` (nem no arquivo)

#### `src/r40/world/buildings/elements.ts`

- **Veredito: DIVIDIR** → src/world/buildings/elementSnap.ts (encaixe do editor), elementSupport.ts (apoio estrutural), elementCollision.ts (colisão do crescimento)
- **Evidência e regra (coordenador):** Três responsabilidades (L256–412, L168–243, L416–502); takeElementId muda o registro recebido (L249).
- **Responsabilidades (a-l):** L30–91 element sizes and kind sets; L97–114 split ground-following runs; L119–133 element rings; L136–142 stair/ramp runs; L145–165 clash with volumes; L168–222 support analysis (fixed point); L225–243 contact groups (union-find); L246–251 id allocation; L256–404 snapping placements against a bay (editor); L407–412 free placement; L416–502 part-vs-part overlap (SAT) for growth.
- **Achados do leitor (a-l):**
  - [MIX] elements.ts — editor snapping (L256–412), structural support (L168–243) and growth collision (L416–502) in one file.
  - [OMAP] elements.ts:200–219 — fixed-point loop O(n²·iterations) over a building's elements; per building, bounded by element count (ok for lots, heavy for big lots).
  - [ALLOC] elements.ts:440 — [OK] scratch footprints reused to avoid per-pair allocation (cited profile).
  - [ALLOC] elements.ts:213 — `contacts.push(...square(...))` allocates arrays per pair inside the loop.
  - [NAME] elements.ts:476 — "Etapa 5a" (Portuguese) in a comment; L469–470 two stacked doc comments for one constant.
  - [TEXT] elements.ts:65–91,417–421 — behaviour by kind-name sets (data-driven, acceptable).
  - [BUG] elements.ts:249 — `takeElementId` mutates `b.nextElementId` on the record passed (records said to be immutable elsewhere, blocks.ts:10) (inference: caller passes a draft).
- **Superfície pública:** `MIN_ELEMENT`, `MAX_ELEMENT`, `ELEMENT_DEFAULTS`, `ON_FACADE`, `onGround`, `FOLLOWS_GROUND`, `followPieces`, `elementRect`, `elementRing`, `groundElements`, `stairSteps`, `runFor`, `elementClash`, `unsupportedElements`, `partGroups`, `takeElementId`, `BayRef`, `elementsAgainstBay`, `elementAt`, `isStructure`, `planReach`, `elementsMeet`.
- **Exports nunca importados (b):** `MIN_ELEMENT` (nem no arquivo), `MAX_ELEMENT` (nem no arquivo), `ELEMENT_DEFAULTS`, `ON_FACADE`, `elementRing`, `groundElements` (nem no arquivo), `runFor`, `takeElementId` (nem no arquivo), `BayRef`, `elementsAgainstBay` (nem no arquivo), `elementAt` (nem no arquivo)

#### `src/r40/world/buildings/flags.ts`

- **Veredito: MOVER** → src/world/buildings/flags.ts
- **Evidência e regra (coordenador):** Dados e migração das bandeiras.
- **Responsabilidades (a-l):** L2–12 flag patterns/design; L17–22 palette and default; L25–29 legacy flags; L32–38 migrate from save.
- **Achados do leitor (a-l):**
  - [SMALL] flags.ts — 39 lines of data + migration.
- **Superfície pública:** `FLAG_PATTERNS`, `FlagDesign`, `FLAG_COLOURS`, `DEFAULT_FLAG`, `legacyFlag`, `migrateFlagDesign`.
- **Exports nunca importados (b):** `FLAG_COLOURS` (nem no arquivo), `DEFAULT_FLAG` (nem no arquivo), `migrateFlagDesign` (nem no arquivo)

#### `src/r40/world/buildings/footprints.ts`

- **Veredito: MOVER** → src/world/buildings/footprints.ts
- **Evidência e regra (coordenador):** Cache por identidade revalidado copiando x/y/w/d/contorno (L27–37); polygonArea duplicado com blocks.ts.
- **Responsabilidades (a-l):** L10–15 outline validation; L17–22 footprint ring / sides; L27–49 memoized side frames; L51–67 overlap area (box test, convex Sutherland–Hodgman, else Martinez); L70–129 convex test, convex overlap, covered area, box test; L132–142 support share; L144–167 point containment, roof detail fit/ring; L170–181 ring offset.
- **Achados do leitor (a-l):**
  - [HOST] footprints.ts:27–37 — cache keyed by object identity revalidated by copying x/y/w/d/outline (second copy of the block's numbers), because editor ops mutate blocks in place (L26) — contradicts blocks.ts:10.
  - [ALLOC] footprints.ts:18–19,55,85–101 — new rings/arrays per call (`localFootprint`, `convexOverlap`); called per pair in growth (inference: hot in tile workers).
  - [DUP] footprints.ts:53–56 — same `polygonArea` as blocks.ts:82–85.
  - [BUG] footprints.ts:178 — miter scale clamped at 0.3 for sharp corners (spike capped but offset wrong for acute angles) — intended "small offsets" (inference).
- **Superfície pública:** `validOutline`, `localFootprint`, `volumeSides`, `EdgeFrame`, `edgeFrame`, `asPolygon`, `AREA_EPS`, `overlapArea`, `supportShare`, `supportedBy`, `containsPoint`, `roofPartFits`, `roofDetailRing`, `offsetRing`.
- **Exports nunca importados (b):** `EdgeFrame`, `AREA_EPS`, `supportedBy` (nem no arquivo), `roofDetailRing`

#### `src/r40/world/buildings/foundation.ts`

- **Veredito: MOVER** → src/world/buildings/foundation.ts
- **Evidência e regra (coordenador):** Até 25×25 amostras por volume por chamada e floorHeight sem cache refaz a mesma amostragem (L107–116, L289).
- **Responsabilidades (a-l):** L10–38 plinth/step constants; L41–85 Entrance/Foundation/FootprintGround types; L88–120 ground sampling under volumes; L125–159 flight run, paving at level, entrance paving from packed ground bays; L162–180 paving edge scan with bisection; L182–264 `foundationOf` (floor height, per-entrance steps/recess/threshold); L267–286 merge adjacent entrances; L289–317 floor height and lot front; L323–340 floor rule, steps.
- **Achados do leitor (a-l):**
  - [ALLOC] foundation.ts:194,201,309 — Map of volumes, closure per bay, `[0.25,0.5,0.75]`/`[1,-1]` arrays per edge; per building.
  - [OMAP] foundation.ts:107–116 — up to 25×25 ground samples per volume per call; `floorHeight` (L289) is "uncached" and recomputes the same sampling (inference: cost per call, not per frame).
  - [DEAD] foundation.ts:137 — orphan doc comment ("The highest paving any entrance opens onto") left above an unrelated constant.
  - [MIX] foundation.ts — ground sampling, floor rule and entrance flight design together (one domain, acceptable).
- **Superfície pública:** `PLINTH_MIN`, `PLINTH_BURY`, `MAX_PLINTH`, `LANDING_RISE`, `STEP_RISE`, `STEP_RUN`, `GroundAt`, `PavedAt`, `ACCESS_COMPONENTS`, `FLOOR_READ_REACH`, `Entrance`, `Foundation`, `FootprintGround`, `sampleFootprint`, `flightRun`, `foundationOf`, `floorHeight`, `THRESHOLD`.
- **Exports nunca importados (b):** `MAX_PLINTH`, `ACCESS_COMPONENTS`, `FLOOR_READ_REACH` (nem no arquivo), `FootprintGround`, `sampleFootprint`, `THRESHOLD`

#### `src/r40/world/buildings/geometry.ts`

- **Veredito: MOVER** → src/world/buildings/geometry.ts (reescrito)
- **Evidência e regra (coordenador):** Geometria do modelo de prédio do 4.0 (r40 é 77% cópia do 4.0, DECISIONS 2026-10-30: reescrever); 16 exports mortos; spansAgainst O(volumes² × lados × andares) por prédio (L338–393); duas regras de contagem de vãos (baysOn L310 × procedural.ts:143 baysOf).
- **Responsabilidades (a-l):** L20–85 frame transforms (local/world, BuildingFrame, SIDE_NORMAL); L87–143 levels/elevations/lifts and "stands against" by height; L145–278 plan: volume corners, footprints, footprint box/centre, element rect, world bounds + WeakMap cache; L280–302 overlap and support (cantilever bearing ≥0.3); L304–423 facade bays per side, covered/partly covered spans, exposed parts; L425–497 reliefs (lookup, projection rect, ground projections, bay centre); L499–729 bay layout (LocalBay/FacadeBay, rhythm memo, packed ground bays, workOutLayout, relief pushes); L731–797 roofs (pitch, ridge, rise, height at point, building height)
- **Achados do leitor (a-l):**
  - [OBJ] geometry.ts:572–578 bay layout is an array of `LocalBay` objects (one JS object per bay per storey); facadeBays L581–606 makes a fresh `FacadeBay` object per bay on every call ("a new list each time") — [ALLOC] if called per frame by a picker (callers not visible).
  - [OMAP] geometry.ts:338–393 `spansAgainst` loops all volumes per (volume, side, storey) inside workOutLayout L670–673: O(volumes² × sides × storeys) per building (bounded by MAX_VOLUMES=24, types.ts:341) — per building, not per city.
  - [ALLOC] geometry.ts:401–407 `insideSpans` allocates a point object per sample (up to ~64 per edge) inside the layout path; L297 isSupported filter+map; L450–451 `Math.min(...points.map(...))` four arrays.
  - [DUP] geometry.ts:310 `baysOn` (module + steadyRatio) vs procedural.ts:143 `baysOf` (3 m step, stepsIn) — two rules for bay count.
  - [DEAD] geometry.ts:68–70 `worldToLocalAt` is a pure alias of worldToLocal; L148 `volumeRectLocal` ignores its `_b` parameter.
  - [TEXT] geometry.ts:734 `DEFAULT_PITCH` keyed by plain string, not RoofKind.
  - [R40COPY] (inference, weak) geometry.ts:371 cites CityEngine `inside`; no 4.0 references.
- **Superfície pública:** GRID/MIN_SIZE/EPS; localToWorld/worldToLocal/frame* helpers; level*/volume* elevation helpers; footprint*/solidFootprints/buildingBounds/storedBounds; planOverlap/isSupported; baysOn/bayWidth/sideStart/coveredSpans/exposedParts; reliefAt/projectionRect/groundProjections; bayLayout/facadeBays/groundBays (+GB_* indices)/letGoLayout; Rhythm/rhythmOf/sameRhythm/closedBlocks; roof helpers and buildingHeight.
- **Exports nunca importados (b):** `worldToLocalAt` (nem no arquivo), `topLevel`, `volumeRectLocal`, `volumeCorners`, `footprintRects` (nem no arquivo), `footprintCentre` (nem no arquivo), `buildingBounds`, `planOverlap` (nem no arquivo), `isSupported` (nem no arquivo), `reliefAt` (nem no arquivo), `groundProjections` (nem no arquivo), `bayCentreLocal` (nem no arquivo), `GB_SIDE`, `GB_WIDTH`, `DEFAULT_PITCH`, `buildingHeight` (nem no arquivo)

#### `src/r40/world/buildings/interior.ts`

- **Veredito: DIVIDIR** → src/features/interiors/furnish.ts (programas por uso) + src/features/interiors/plan.ts (Plan e grade de 2 m) + cutOpen para src/features/interiors/insidePlan.ts
- **Evidência e regra (coordenador):** 44,9 KB; um objeto por móvel e divisória (L21–46, L340); balcão da boate recebe cx como y (L506, conferido); flatFloor e roomsFloor repetem moldura/paredes/porta (L543–599 × L616–644).
- **Responsabilidades (a-l):** L13–64 furniture vocabulary and sizes (metres); L66–80 `cutOpen` (draw-only record copy cut at a level); L82–143 split-level flights between lifted blocks; L145–207 per-blocks-list furnished-floor memo and floor "type" key; L209–260 furnishFloor, stored player furnishing, room lights, defaultFunction; L262–390 `Plan` class (occupancy spatial hash, put/grid/along/walls); L392–533 furnish by function (big switch); L535–920 layouts: lobby, flats, rooms-off-corridor (office/class/ward/hotel), back room, kitchen, house, home units, wards, classrooms, cells, dining, mall
- **Achados do leitor (a-l):**
  - [OBJ] interior.ts:21–46,340 every furniture piece and partition is its own JS object (`Furniture`, `Partition`); a tower floor yields hundreds — mitigated by floor-type sharing L178–207.
  - [BUG] interior.ts:506 nightclub `p.put('barCounter', p.x0 + m(3), cx, -RIGHT)` passes `cx` (the x centre) as the y coordinate: on any block whose x-centre is not inside its y-range the counter falls outside the ring and `free` (L315) silently rejects it; elsewhere it lands at an arbitrary depth.
  - [MAIN] (inference) interior.ts:194 `interiorAt` runs the whole furnishing on whatever thread asks; comment L193 says the cut-open view asks it, i.e. the page.
  - [ALLOC] interior.ts:70 `Math.max(0, ...map)`; L222–223 flights map/filter; L414 `[...p.items]` copy; L549/L621 closures per flat — generation path, not per frame.
  - [TEXT] interior.ts:744–745 house floor detects a garage by searching facade bay values for `'garageDoor'`; L180/225 furnishing keyed by `String(level)`; L181–189 floor type as concatenated string key.
  - [MIX] interior.ts:69–80 `cutOpen` (render-time cutaway record) lives in the furnishing module.
  - [DUP] interior.ts:543–599 `flatFloor` and L616–644 `roomsFloor` repeat the same flat frame/walls/door code; interior.ts:722 `face` duplicates the atan2 in L555–558 and L638.
- **Superfície pública:** FURNITURE_KINDS/FurnitureKind/Furniture/FloorInterior/FURNITURE_SIZE/LAMP_KINDS/isFurnitureKind; cutOpen; LevelFlight/levelFlights; interiorAt; letGoInterior; furnishingOf.
- **Exports nunca importados (b):** `LAMP_KINDS` (nem no arquivo), `isFurnitureKind`, `cutOpen` (nem no arquivo), `LevelFlight`, `furnishingOf` (nem no arquivo)

#### `src/r40/world/buildings/intern.ts`

- **Veredito: MOVER** → src/world/buildings/intern.ts (reescrito)
- **Evidência e regra (coordenador):** Internação de registros; congela membros compartilhados (L102) que materials.ts:147–196 muda no lugar.
- **Responsabilidades (a-l):** L1–29 weak hash-cons table with FinalizationRegistry cleanup and test counter; L31–54 FNV-1a hashing of keys/values; L56–69 shallow equality; L71–104 `intern` (canonicalise bottom-up, freeze); L106–112 internMembers
- **Achados do leitor (a-l):**
  - [BUG] (inference) intern.ts:102 freezes shared members, while materials.ts:147–196 `applyMaterial`/`applyStyle` `delete` and assign on `storey.materials`, `v.materials`, `b.materials` in place: if ever called on a stored (interned) record rather than a cloned draft, ES-module strict mode throws TypeError. Callers not visible here.
  - [ALLOC] intern.ts:65–66 `Object.keys` twice per comparison; L16 `indexOf` + splice per collected entry (O(bucket)).
  - [DEV] intern.ts:25 `internedEntries` exported for tests only.
- **Superfície pública:** intern, internMembers, internedEntries (tests).
- **Exports nunca importados (b):** `internedEntries` (nem no arquivo), `intern`

#### `src/r40/world/buildings/lots.ts`

- **Veredito: JUNTAR** → src/world/lots/lotSurface.ts (com o dono único do plano de lote)
- **Evidência e regra (coordenador):** Superfície do lote do caminho 4.0; rampa sem usar clamp01 duas linhas acima (L33).
- **Responsabilidades (a-l):** L6–25 LotSurface / LotSlope plain-data types; L27–42 lotHeightAt (level/ramp/street bilinear); L44–85 lotSurfaces: detect the street side by probing paving 0.6 m outside each edge, choose slope
- **Achados do leitor (a-l):**
  - [OBJ] lots.ts:82 one LotSurface object + closure `heightAt` per open lot per call.
  - [DUP] lots.ts:33 ramp clamp written inline instead of `clamp01` (L27) used two lines later.
- **Superfície pública:** LotSurface, LotSlope, lotHeightAt, PavingAt, lotSurfaces.
- **Exports nunca importados (b):** `PavingAt`

#### `src/r40/world/buildings/materials.ts`

- **Veredito: DIVIDIR** → src/world/buildings/materials.ts (resolução) + src/world/buildings/materialEdit.ts (edição e presets) + migração para o carregador do save
- **Evidência e regra (coordenador):** Resolução, edição, migração e presets juntos; detecção de mudança por JSON.stringify antes/depois (L131, L200, L266–273); laje genérica reconhecida pela cor 0x8a8a86 (L87); 13 exports mortos.
- **Responsabilidades (a-l):** L7–31 finish colours and validation; L35–60 palettes; L62–93 wall/roof/trim/plinth resolution (flat roof pick by id hash); L95–201 MaterialTarget get/apply (edit in place); L203–235 save migration; L237–274 STYLES and applyStyle
- **Achados do leitor (a-l):**
  - [ALLOC] materials.ts:131,200 and L266–273 change detection by `JSON.stringify` of all materials before and after each apply — per edit, one building.
  - [TEXT] materials.ts:87 a generator slab is recognised by colour equality with `GENERIC_SLAB` (0x8a8a86) — magic value shared with procedural.ts:597; L238–262 styles looked up by string key.
  - [BUG] (inference) see intern.ts: applyMaterial/applyStyle mutate the record in place (L143–197, L268–272) against the "records are replaced, never edited" rule of intern.ts:101 and recordTable.ts:336; not a command with an inverse inside this module.
  - [DEAD] materials.ts:112 `return null` after an exhaustive inner switch is unreachable.
  - [NAME] materials.ts:228 migration scans faces `0..63` (`Array.from({length:64})`) — arbitrary cap, FaceId is unbounded number (types.ts:77); a side ≥64 is dropped on load.
  - [MIX] materials.ts mixes resolution, editing, migration and style presets.
- **Superfície pública:** FINISHES, FINISH_COLOUR, PALETTE_MATERIALS/paletteOf, FLAT_ROOF_MATERIAL/FLAT_ROOFS, GENERIC_SLAB, wallMaterial/roofMaterial/trimMaterial/plinthMaterial, MaterialTarget/materialAt/applyMaterial, migrate*, STYLES/applyStyle.
- **Exports nunca importados (b):** `FINISH_COLOUR` (nem no arquivo), `PaletteMaterials`, `PALETTE_MATERIALS`, `FLAT_ROOF_MATERIAL`, `FLAT_ROOFS`, `MaterialTarget`, `materialAt` (nem no arquivo), `applyMaterial` (nem no arquivo), `migrateMaterial`, `migrateBuildingMaterials` (nem no arquivo), `migrateVolumeMaterials` (nem no arquivo), `STYLES`, `applyStyle` (nem no arquivo)

#### `src/r40/world/buildings/materialTypes.ts`

- **Veredito: MANTER** → src/world/buildings/materialTypes.ts
- **Evidência e regra (coordenador):** Existe para quebrar o ciclo materials↔types (L1–2).
- **Responsabilidades (a-l):** L4–24 finish list, MaterialSpec, slots and building/volume material types (type-only cycle breaker)
- **Achados do leitor (a-l):**
  - [SMALL] materialTypes.ts:1–2 exists to break the materials↔types import cycle; imported by materials.ts:3 and types.ts:4.
- **Superfície pública:** FINISHES, Finish, MaterialSpec, MATERIAL_SLOTS, MaterialSlot, BuildingMaterials, VolumeMaterials.

#### `src/r40/world/buildings/pads.ts`

- **Veredito: MOVER** → src/world/buildings/pads.ts (reescrito sobre o índice espacial único)
- **Evidência e regra (coordenador):** Terceira grade espacial privada (25,6 m, L158–175) fora do índice único do CLAUDE.md (placa/ladrilho/célula/subcélula); ponto-em-polígono reimplementado (L60–74) com core/polygon.ts existente; contador global padsWork no laço quente (L57, L253).
- **Responsabilidades (a-l):** L9–57 platform constants, PadLevel/Pad/BuildingPads types, work counter; L59–74 ring distance; L76–139 buildingPads (all buildings) and padOf (one building's rings/levels/bounds); L141–222 townPads: pads filed in a 25.6 m cell grid, put/cut; L224–236 padShaper for the ground worker; L238–256 Grading scratch; L258–349 shapeOverPads (nearest ring, water, split level, paving bank)
- **Achados do leitor (a-l):**
  - [OMAP] (inference) pads.ts:77–98 `buildingPads` iterates every building passed (`Iterable<Building>`) and re-files each into a new town grid each call; cached per record via `known` WeakMap but still O(buildings) per call — whether it is called per edit is not visible. L178 `shapeBounds` builds an array of every pad's box.
  - [OBJ] pads.ts:31–44,167 one `Pad` object (rings of Vec2 objects, level objects, boxes) and one `{pad, keys}` entry per building.
  - [DUP] pads.ts:158–175 own 25.6 m cell grid for pads, a third private spatial grid besides cells.ts CellFiling (256 m) and interior.ts Plan (2 m).
  - [DUP] pads.ts:60–74 point-in-polygon + segment distance re-implemented (core/polygon.ts pointInPolygon exists, used by geometry.ts:404).
  - [DEV] pads.ts:57 `padsWork` global counter incremented in the hot point loop L253 (measurement hook).
  - [ALLOC] pads.ts:209 an Int32Array per cell in `cut`; L227 Array.from per cell in padShaper.
- **Superfície pública:** PAD_BATTER, LOT_PLATE, POOL_SINK, POOL_TERRAIN_CLEARANCE, PadLevel/padLevelAt, Pad, BuildingPads, padsWork, buildingPads, padOf, TownPads, PadShapeCut, padShaper.
- **Exports nunca importados (b):** `PAD_BATTER`, `LOT_PLATE`, `POOL_TERRAIN_CLEARANCE`, `PadLevel`, `padLevelAt`, `Pad`, `BuildingPads`, `padsWork`, `buildingPads` (nem no arquivo), `padOf`, `TownPads`, `PadShapeCut`, `padShaper` (nem no arquivo)

#### `src/r40/world/buildings/procedural.ts`

- **Veredito: MOVER** → src/jobs/buildingGen/procedural.ts (reescrito)
- **Evidência e regra (coordenador):** Prédio sob medida; chaves de vão literais `0:${bay}` em vez de bayKey (L204…L663); hang espalha o corpo inteiro num Building falso por elemento (L136–137).
- **Responsabilidades (a-l):** L13–62 MadeBuilding/Envelope/Signature types and rng helpers; L64–127 colour nudging (HSL) and material lists; L129–254 facade dressing (canopies, reliefs, door moves, back door), signature and `finish`; L256–288 roof pitch/ridge drawing, tower plan shapes; L290–420 houses (6 forms); L422–540 setbacks and flats/towers; L542–590 shops; L592–630 offices; L632–672 works; L675–705 madeToMeasure entry, bodySignature, signatureDistance
- **Achados do leitor (a-l):**
  - [TEXT] procedural.ts:204,213,374,581,663 facade bay keys written as literal `` `0:${bay}` `` / `'0:0'` instead of `bayKey` (types.ts:360); behaviour by `style.key` string at L160,166,174,186,296–300,611; form strings `house:…`, `tower:…` feed signatures.
  - [DUP] procedural.ts:143 `baysOf` vs geometry.ts:310 `baysOn` (different rounding/module); procedural.ts:67–88 an HSL round-trip colour nudge (check for other colour utils).
  - [ALLOC] procedural.ts:136–137 `hang` spreads the whole body into a fake Building for every element tried and does `Math.max(...elements.map)` (O(n²) up to 96 elements) — generation path.
  - [MAIN] (inference) whether madeToMeasure runs in a worker is not visible here; it mutates the body in place.
  - [NAME] procedural.ts:449 Portuguese "fachada ativa" in a comment; style key `sobrado` (L299, L311).
  - [R40COPY] (inference, weak) procedural.ts:422 cites CityEngine `RecursiveSetbacks`; no 4.0 references.
- **Superfície pública:** Rect, Signature, MadeBuilding, Envelope, CLAY, WORKS_ROOFS, madeToMeasure, bodySignature, signatureDistance.
- **Exports nunca importados (b):** `Signature`, `Envelope`, `CLAY`, `WORKS_ROOFS`, `bodySignature` (nem no arquivo), `signatureDistance` (nem no arquivo)

#### `src/r40/world/buildings/recordTable.ts`

- **Veredito: MOVER** → src/world/buildings/recordTable.ts (reescrito)
- **Evidência e regra (coordenador):** tableRecords decodifica cada linha num objeto Building completo na página (L340–350): registro expandido por prédio (Forbidden 1 e 2).
- **Responsabilidades (a-l):** L1–52 binary format header/layout, SAB allocation; L54–74 growable byte Stream; L76–169 encodeRecords (shared nodes, strings, shapes, columns id/x/y/rotation); L171–205 RecordTable (column views, lazy id→row map); L207–328 TableReader (decode one row, shared nodes once, skip); L330–375 refs WeakMap, tableRecords/refOf/readRecords/eachRecord
- **Achados do leitor (a-l):**
  - [OBJ] recordTable.ts:340–350 `tableRecords` decodes every row of a tile into a full `Building` object on the page (expanded records per building), plus a RecordRef object each.
  - [ALLOC] recordTable.ts:356 `refOf` of an edited/new building encodes a whole one-row table (new SharedArrayBuffer) per record.
  - [OMAP] recordTable.ts:197 first `row(id)` builds a Map of all rows of the tile (once per table).
  - [DUP] recordTable.ts:142 key filter mirrors types.ts:373 `jsonCopy` JSON rules (undefined/function/symbol dropped).
- **Superfície pública:** encodeRecords, RecordTable, TableReader, RecordRef, tableRecords, refOf, readRecords, eachRecord.
- **Exports nunca importados (b):** `encodeRecords`, `RecordTable`, `TableReader`, `tableRecords` (nem no arquivo), `refOf` (nem no arquivo), `readRecords` (nem no arquivo), `eachRecord`

#### `src/r40/world/buildings/roofPlant.ts`

- **Veredito: JUNTAR** → um só roofPlant: src/jobs/buildingGen/roofPlant.ts (com src/world/roofPlant.ts)
- **Evidência e regra (coordenador):** Duas implementações do mesmo plano de telhado (esta para o caminho 4.0 via r40/render/buildings/roofPlan.ts, a outra para jobs/buildingGen/plans.ts; conferido); PRNG mulberry32 próprio (L83–92).
- **Responsabilidades (a-l):** L6–54 roof plant kinds, RoofSite, catalogue type; L56–74 catalogue with chances by use/storeys/age; L76–92 cell size, margins, mulberry32 stream; L94–145 planRoofPlant: occupancy grid, random placement tries
- **Achados do leitor (a-l):**
  - [DUP] roofPlant.ts:83–92 its own mulberry32 PRNG (core/rng.ts exists, imported by procedural.ts:1).
  - [NAME] roofPlant.ts:56 `USE` uppercase function; L61 Portuguese "castelo" in a comment.
  - [OBJ] roofPlant.ts:140 one RoofPlantItem object per piece.
- **Superfície pública:** RoofPlantItem, RoofSite, planRoofPlant.
- **Exports nunca importados (b):** `RoofSite`

#### `src/r40/world/buildings/spaces.ts`

- **Veredito: MOVER** → src/features/interiors/spaces.ts
- **Evidência e regra (coordenador):** Unidades e apartamentos; flatPlan recalculado a cada chamada de interior.ts:545, :617.
- **Responsabilidades (a-l):** L6–33 StoreySpaces and per-blocks-list memo; L35–68 workOutSpaces (stored spaces, flat plan, split by 4 modules); L70–149 flatPlan (corridor, double-loaded rows, flats of bay groups)
- **Achados do leitor (a-l):**
  - [OBJ] spaces.ts:46,58–60,134 one Space / FlatCell object per unit; flatPlan recomputed (not memoised) on every call from interior.ts:545,617.
  - [ALLOC] spaces.ts:43 `b.volumes.some(...)` inside the per-storey loop; L119,132–133 small objects per row/flat.
- **Superfície pública:** StoreySpaces, deriveSpaces, FlatPlan, flatPlan.
- **Exports nunca importados (b):** `StoreySpaces`, `FlatPlan`

#### `src/r40/world/buildings/towerKit.ts`

- **Veredito: JUNTAR** → src/render/buildings/landmarks.ts
- **Evidência e regra (coordenador):** Uma constante e uma função; desenho escolhido pelo prefixo de texto 'signature:' do campo blueprint 'só para a UI' (L19).
- **Responsabilidades (a-l):** L3–15 tower/signature kind list; L17–21 signatureKind from `blueprint`
- **Achados do leitor (a-l):**
  - [TEXT] towerKit.ts:19 behaviour chosen by the `blueprint` string prefix `'signature:'` (slice(10)) — a UI field (types.ts:326 "for the UI only") drives drawing.
  - [SMALL] towerKit.ts one constant + one function; comment L12 points at `render/buildings/landmarks.ts`.
  - [NAME] towerKit.ts file name "towerKit" holds civic kinds too (church, cemetery, school).
- **Superfície pública:** TOWER_KINDS, TowerKind, signatureKind.
- **Exports nunca importados (b):** `TOWER_KINDS`, `TowerKind`

#### `src/r40/world/buildings/types.ts`

- **Veredito: DIVIDIR** → src/world/buildings/types.ts (só tipos) + src/world/buildings/recordOps.ts (cópia profunda, settle, decadência, hash)
- **Evidência e regra (coordenador):** Building é um objeto JS aninhado por prédio (L284–328); 41 exports mortos; campos de desenho cutaway/cutView no registro persistido (L319–322).
- **Responsabilidades (a-l):** L8–71 ids, schema, uses, bay components, patterns, roof kinds, roof details; L73–197 Side/FaceId, cores, spaces, facade, storey, relief, facade geometry, dress, Volume, lot surfaces; L199–328 functions, furniture, elements, core, Building record; L330–365 limits, guards, bayKey/componentAt; L367–395 cloneBuilding/jsonCopy; L397–444 settleBuilding (normalise in place + intern); L446–469 volumeTop/volumeById, decay timing
- **Achados do leitor (a-l):**
  - [OBJ] types.ts:284–328 `Building` is a nested JS object per building (volumes, storeys, facades, elements), the whole model — mitigated by intern.ts sharing and recordTable.ts tables.
  - [MIX] types.ts:367–469 deep copy, settle/intern, decay maths and id hashing live in the types module; L319–322 draw-only fields `cutaway`/`cutView` on the persistent record.
  - [TEXT] types.ts:92,360 bay overrides keyed by string `"side:index"`; L218 `PlacedFurniture.kind: string`; L68 flag names as strings.
  - [NAME] types.ts:50 an import placed mid-file.
- **Superfície pública:** BuildingId/asBuildingId, BUILDING_SCHEMA, BuildingUse, BAY_COMPONENTS, FACADE_PATTERNS, ROOF_KINDS, RoofDetail, Side/SIDES/FaceId, CORE_KINDS, SPACE_KINDS, Facade, Space, Storey, Relief, FacadeGeometry, DRESS_*, Volume, MAX_TERRACE/MAX_LIFT, LOT_SURFACES, BUILDING_FUNCTIONS, PlacedFurniture, BlockMode, ELEMENT_KINDS, BuildingElement, Core, Building, limits (MIN/MAX_*), guards is*, bayKey/componentAt, cloneBuilding/jsonCopy, settleBuilding, volumeTop/volumeById, DECAY_*, generatedBuiltAt, decayOf.
- **Exports nunca importados (b):** `BuildingId`, `asBuildingId` (nem no arquivo), `FACADE_PATTERNS`, `isFacadePattern` (nem no arquivo), `ROOF_KINDS`, `RoofDetailKind`, `isRoofDetailKind` (nem no arquivo), `CORE_KINDS`, `SPACE_KINDS`, `DRESS_LINES`, `DRESS_CROWNS`, `MAX_LIFT` (nem no arquivo), `LOT_SURFACES`, `BUILDING_FUNCTIONS`, `BlockMode`, `ELEMENT_KINDS`, `MIN_MODULE` (nem no arquivo), `MAX_MODULE` (nem no arquivo), `MIN_STOREY_HEIGHT` (nem no arquivo), `MAX_STOREY_HEIGHT` (nem no arquivo), `MAX_GROUND_HEIGHT` (nem no arquivo), `MAX_STOREYS` (nem no arquivo), `MAX_SIZE` (nem no arquivo), `MAX_VOLUMES` (nem no arquivo), `MAX_RECESS` (nem no arquivo), `MAX_PROJECTION` (nem no arquivo), `MAX_PITCH` (nem no arquivo), `PALETTE_COUNT` (nem no arquivo), `isBuildingUse` (nem no arquivo), `isBayComponent` (nem no arquivo), `isRoofKind` (nem no arquivo), `isSide` (nem no arquivo), `isElementKind` (nem no arquivo), `cloneBuilding` (nem no arquivo), `jsonCopy`, `settleBuilding` (nem no arquivo), `volumeById` (nem no arquivo), `DECAY_GRACE`, `DECAY_SPAN`, `generatedBuiltAt` (nem no arquivo), `decayOf` (nem no arquivo)

#### `src/r40/world/cells.ts`

- **Veredito: APAGAR** → — (usar o índice espacial único de src/core/grid.ts)
- **Evidência e regra (coordenador):** Índice de células próprio do 4.0 com um objeto {item, rect, cells} por id e um Set por célula (L50–74): segunda grade espacial além da do CLAUDE.md; contadores cellWork em toda consulta (L42).
- **Responsabilidades (a-l):** L1–36 256 m cell keys, rect, cellAt, forCellsOver, grow, rectsMeet; L38–42 version clock and work counter; L44–210 `CellFiling` generic id→rect cell index with per-cell versions, forked working copies (ForkMap) and takeBack
- **Achados do leitor (a-l):**
  - [OBJ] cells.ts:50,74 one `{item, rect, cells}` entry object + cells array per filed id; L70 a Set per cell.
  - [ALLOC] cells.ts:152–156 `stamp` builds a string per call; L101–112 idsMeeting allocates a Set and sorted array per query; L67 closure per file.
  - [DEV] cells.ts:42 `cellWork` counters mutated in every query (perf budget hook, `core/perfBudget.ts`).
  - [NAME] cells.ts:1 `ChangeRect` type declared above the imports.
- **Superfície pública:** ChangeRect, CELL, cellRect, cellAt, grow, cellWork, CellFiling.
- **Exports nunca importados (b):** `cellRect` (nem no arquivo), `cellAt` (nem no arquivo), `grow` (nem no arquivo), `cellWork`, `CellFiling`

#### `src/r40/world/growth/lotBoundaryRuns.ts`

- **Veredito: MOVER** → src/world/lots/boundaries.ts
- **Evidência e regra (coordenador):** Uma função das divisas do lote; literais em metros sem m() ao contrário do resto (L9, L53).
- **Responsabilidades (a-l):** L3–9 CoverBox type, sample constants; L11–19 binary search; L21–58 openRunsAlong: difference-array coverage over samples, open runs
- **Achados do leitor (a-l):**
  - [SMALL] lotBoundaryRuns.ts one exported function (callers not visible).
  - [ALLOC] lotBoundaryRuns.ts:34–40 two closures per box, L24 a number[] of samples per edge.
  - [NAME] lotBoundaryRuns.ts:9,53 raw metre literals (0.3, 0.25, 0.4) with no `m()` units, unlike the rest of `r40/world` (units.ts) — caller must pass metres.
- **Superfície pública:** CoverBox, openRunsAlong.

#### `src/r40/world/growth/lotPlan.ts`

- **Veredito: DIVIDIR** → src/world/lots/lotPlan.ts (escolha do plano, única — junta com src/world/lotPlan.ts) + src/world/lots/layLot.ts (motor de distribuição) + src/world/lots/terrace.ts (patamares e arrimo) + src/world/lots/backYards.ts (os cinco programas de fundo) + src/world/lots/boundaries.ts
- **Evidência e regra (coordenador):** 70,2 KB (> 50 KB), 13 responsabilidades; espelha o caminho do 4.0 (código copiado a reescrever, DECISIONS 2026-10-30); lotKind/planLot/yardRamp/garageRamp/driveSide reimplementados em src/world/lotPlan.ts; espessura por tipo de divisa escrita 4 vezes (L350, L368, L975, L1021); sorteio mantido só para preservar a sequência de um churrasco removido (L760–761); furnishLot sempre devolve true (L1091).
- **Responsabilidades (a-l):** L15–21 zone use/density → lot kind; L23–67 plan types, constants, `loadingDoors` (reads facade components); L69–163 `planLot` (front/side/back strips per kind, corner lots); L165–189 `yardRamp`, `garageRamp`, `driveSide`; L196–237 furnishing constants, `Lot` interface, `apart` distance test; L239–387 `furnishLot` setup + `lot` laying API (surface/ramp/tile/fits/put/runX/runY/path/busy); L389–470 terrace helpers (`lift`, `retain`, `flightBack`, `stepYard`); L472–540 side strips, keep-clear zones, gates, free-court furnishing; L542–604 front zone; L606–674 side strips (drives, ramps, carports, alleys, gardens, split lift); L676–970 back zone switch (yard with pools/sheds/edicula variants, parking, service, courtyard, loading); L972–1085 boundary walls/gates + gap closing via `openRunsAlong`; L1086–1091 drop unsupported elements, write next ids.
- **Achados do leitor (a-l):**
  - [DUP] lotPlan.ts:17,70,167,179,188 — `lotKind`/`planLot`/`yardRamp`/`GARAGE_GRADE`/`garageRamp`/`driveSide` are re-implemented in `src/world/lotPlan.ts:14,50,139,148,149,157` (header there says it is 4.0 `world/growth/lotPlan.ts` too). Two copies of the lot plan.
  - [R40COPY] lotPlan.ts:1–163 — module mirrors 4.0 path `world/growth/lotPlan.ts` (same name/layout as the src/world copy's header cites); comments cite player orders of 2026-10-05 (L641, L742, L782).
  - [OMAP] lotPlan.ts:330,338 — `fits` loops all elements of the lot per candidate, `put` loops all elements again for structures: O(n²) per lot, bounded by `MAX_ELEMENTS` (L310); per-lot, not per city. Runs in jobs/building40.ts:116 (worker).
  - [ALLOC] lotPlan.ts:385 `busy` uses `taken.some` closures; L455, L1088 `elements.splice(0, len, ...filter())` rebuilds arrays; L296 `[...new Set(...)]` per `tile` call. Generation path (worker), not per frame.
  - [DEAD] lotPlan.ts:752–753 `const py = …; void py;` unused value kept.
  - [DEAD] lotPlan.ts:760–761 `rng.float()` kept only to preserve the RNG sequence of a removed barbecue ("DO NOT drop this draw").
  - [DEAD] lotPlan.ts:1091 `furnishLot` always returns `true`; the `boolean` return type carries no information.
  - [DUP] lotPlan.ts:350,368,975,1021 — thickness per boundary kind (`fence 0.12 / hedge 0.7 / else 0.2`) written four times.
  - [DUP] lotPlan.ts:1033 and 1075 — `lowFront` computed identically twice.
  - [DUP] lotPlan.ts:309 and 205 — boundary kind set written inline in `fits` although `BOUNDARY_SET` exists.
  - [TEXT] lotPlan.ts:23–25,544–545 — behaviour selected by string unions ('garden','carpad','plaza'…), `LotSurface` strings ('grass','asphalt'…) shared with buildings/types.ts.
  - [MIX] lotPlan.ts — one 70 KB file (1093 lines) holds plan selection, the lot-laying engine, terracing/retaining geometry, five back-yard furnishing programs and boundary closing; `furnishLot` alone is L240–1092 (~850 lines, one function).
- **Superfície pública:** `LotKind`, `lotKind`, `LotPlan`, `planLot`, `yardRamp`, `GARAGE_GRADE`, `garageRamp`, `driveSide`, `furnishLot` (lays a lot's surfaces/elements into a blueprint body).
- **Exports nunca importados (b):** `LotKind`, `LotPlan`, `yardRamp`, `GARAGE_GRADE`, `garageRamp`, `driveSide` (nem no arquivo)

#### `src/r40/world/lotRings.ts`

- **Veredito: MANTER** → src/world/lots/lotRings.ts (com a reescrita do r40)
- **Evidência e regra (coordenador):** Só lotCentre é usado; simplifyRing, hull e orientedBox sem importador (L6, L22, L33): exports mortos a apagar.
- **Responsabilidades (a-l):** L5–20 ring simplification (repeated removal of near-collinear points); L22–30 convex hull (monotone chain); L32–53 minimum-area oriented box; L55–66 polygon area centroid.
- **Achados do leitor (a-l):**
  - [DEAD] lotRings.ts:6,22,33 — `simplifyRing`, `hull`, `orientedBox`: no importer in `src` (grep: only lotRings.ts; tests not checked by name for hull). Only `lotCentre` is used (tiles.ts:3).
  - [OMAP] lotRings.ts:8–18 — `simplifyRing` is O(n²) (rescans the ring after each removal); per ring, small n.
  - [ALLOC] lotRings.ts:39,48,51 — new objects per edge in `orientedBox` (not hot).
- **Superfície pública:** `simplifyRing`, `hull`, `orientedBox`, `lotCentre`.
- **Exports nunca importados (b):** `simplifyRing` (nem no arquivo), `hull` (nem no arquivo), `orientedBox` (nem no arquivo)

#### `src/r40/world/tiles.ts`

- **Veredito: APAGAR** → — (WORLD_REACH vai para src/config.ts)
- **Evidência e regra (coordenador):** Modelo de ladrilhos sem limite do 4.0 que contradiz a grade fixa MAP_TILES do jogo; 14 exports mortos, só WORLD_REACH importado; OWNER.segment e OWNER.span iguais (L97, L99).
- **Responsabilidades (a-l):** L7–13 tile size and world reach; L15–40 tile i/j and packed key; L42–52 tile rect and per-tile id ranges; L54–67 deterministic edge-node ids; L69–81 tiles in rings around a tile; L83–102 record → owning tile (`tileOfRecord`, `OWNER`).
- **Achados do leitor (a-l):**
  - [TEXT] tiles.ts:90 — ownership decided by part name strings `'segments'`, `'poleSpans'`.
  - [DUP] tiles.ts:97,99 — `OWNER.segment` and `OWNER.span` identical bodies.
  - [DEAD] tiles.ts:49,52,85 — `tileIdBase`, `TILE_COUNTED`, `tileOfRecord`, `tileRect` have no importer outside this file in the snapshot (grep); only `WORLD_REACH` is imported (r40/world/bounds.ts:3).
  - [ALLOC] tiles.ts:22,37–39 — `tileKeyAt` builds a `{i,j}` object per call (used by every `OWNER.*`).
  - [LAYER] tiles.ts:1 — imports `ChangeRect` from `./cells.ts` (r40 world) — fine within r40; note the unbounded-tile model here conflicts with render's fixed `MAP_TILES` grid (cellLayer.ts, city.ts) (inference: two world models).
  - [BUG] (inference) tiles.ts:61 — `x === i * TILE` exact float equality: a node computed by arithmetic slightly off the edge gets `null` and a non-shared id.
- **Superfície pública:** `TILE`, `WORLD_REACH`, `TileIJ`, `tileIJ`, `tileKey`, `tileOfKey`, `tileKeyAt`, `tileRect`, `TILE_IDS`, `tileIdBase`, `TILE_COUNTED`, `edgeNodeId`, `tilesAround`, `tileOfRecord`, `OWNER`.
- **Exports nunca importados (b):** `TILE`, `TileIJ`, `tileIJ`, `tileKey`, `tileOfKey` (nem no arquivo), `tileKeyAt`, `tileRect` (nem no arquivo), `TILE_IDS`, `tileIdBase`, `TILE_COUNTED`, `edgeNodeId` (nem no arquivo), `tilesAround` (nem no arquivo), `tileOfRecord` (nem no arquivo), `OWNER`

#### `src/r40/world/units.ts`

- **Veredito: APAGAR** → — (importar direto de src/r40/core/units.ts ou do novo dono)
- **Evidência e regra (coordenador):** Uma linha de reexportação mantida só para caminhos antigos do 4.0 (L1–2), citando camadas que não existem ('editor').
- **Responsabilidades (a-l):** L1–2 re-export of `core/units.ts` names.
- **Achados do leitor (a-l):**
  - [SMALL] units.ts:2 — one re-export line; kept so old import paths (`world`, `sim`, `editor`, `render`, `ui`) keep working (comment L1). Used by lotPlan.ts:9, tiles.ts:2.
  - [NAME] units.ts:1 — comment names layers (`editor`) not in the layer list.
- **Superfície pública:** `METERS_PER_UNIT`, `TUNED_UNIT`, `UNITS_PER_METER`, `kmh`, `m`, `perM`, `stepsIn`.
- **Exports nunca importados (b):** `METERS_PER_UNIT` (nem no arquivo), `UNITS_PER_METER` (nem no arquivo), `kmh` (nem no arquivo)

#### `src/r40/world/zones.ts`

- **Veredito: APAGAR** → — (tipos ZoneUse/ZoneDensity para src/features/zones/zones.ts)
- **Evidência e regra (coordenador):** Segundo tipo Zone do código (o outro é roads/zones.ts); isZoneUse, isZoneDensity, isZoneMark, ZoneMark sem importador (L19–32); só tipos usados por lotPlan.ts.
- **Responsabilidades (a-l):** L1–20 zone use/density enums, `Zone` record type, guards; L22–36 `ZoneMark` (zoned grid cell) and its guard.
- **Achados do leitor (a-l):**
  - [OBJ] zones.ts:7–17 — `Zone` record holds `buildingIds: readonly number[]` per zone (array per entity); `ZoneMark` per zoned cell L23–30 is one object per cell (inference: if stored as such).
  - [DEAD] zones.ts:19,20,32 — `isZoneUse`, `isZoneDensity`, `isZoneMark`, `ZoneMark` have no importer in src (grep); lotPlan.ts imports only the `ZoneUse`/`ZoneDensity` types.
  - [DUP] (inference) roads/network.ts:48 re-exports a different `Zone` from `roads/zones.ts` — two `Zone` types in the codebase.
- **Superfície pública:** `ZoneUse`, `ZoneDensity`, `Zone`, `isZoneUse`, `isZoneDensity`, `ZoneMark`, `isZoneMark`.
- **Exports nunca importados (b):** `Zone` (nem no arquivo), `isZoneUse`, `isZoneDensity`, `ZoneMark`, `isZoneMark` (nem no arquivo)

#### `src/render/cameraRig.ts`

- **Veredito: MANTER** → src/render/cameraRig.ts (código do puxar-para-frente removido)
- **Evidência e regra (coordenador):** Câmera; PULL_IN_FRONT = false (L28) desligado a pedido do dono em 2026-10-19 (comentário L328): o raio de L326–344 e a consulta rig.solid de game.ts:265–275 ficam mortos; dois Record novos a cada quadro (L251, L254); pick() devolve Vector3 que os chamadores clonam de novo (L186–407).
- **Responsabilidades (a-l):** L16–61 constants, key map, distance→pitch profile; L63–129 CameraRig state, follow pose, constructor; L131–190 mode/turn/keys/rotate/wheel zoom input; L192–247 drag pan with fling, ground hold, clamp; L249–320 per-frame update (keys, inertia, turn, zoom, ground follow); L322–351 pull-in-front (disabled); L353–380 rebuild persp/ortho cameras; L382–408 terrain ray pick (march + bisection); L410–424 save/restore.
- **Achados do leitor (a-l):**
  - [ALLOC] cameraRig.ts:251,254 — `update` (per frame) allocates two `Record<Axis,number>` objects every frame.
  - [ALLOC] cameraRig.ts:203 — `pan` pushes a new tuple per pointer move; L204 `shift()`; L210 `filter` on release.
  - [ALLOC] cameraRig.ts:186,195,399,407 — `pick` returns `new Vector3`, then callers `.clone()` it again (double allocation per wheel notch/pan start).
  - [DEAD] cameraRig.ts:28,326–344 — `PULL_IN_FRONT = false`: the whole pull-in-front ray march is unreachable; `solid` (L82) is never consulted. Comment L328 says it was switched off after a player complaint — a feature disabled rather than fixed.
  - [DUP] cameraRig.ts:89–90 and 152–153 — same angle-wrap expression.
  - [R40COPY] cameraRig.ts:5–9,53 — cites roadcraft `view/cameraMotion.ts` and `cameraProfile.ts` for behaviour/values.
  - [LAYER] (inference) cameraRig.ts:13–14 — render imports `config.ts` `MAP_HALF` and `world/heights.ts`; target clamped to a fixed square map L244–247 (no unbounded world).
- **Superfície pública:** `ViewMode`, `CameraRig` (persp/ortho cameras, input handlers, `update`, `pick`, `state`/`restore`, `followPose`).
- **Exports nunca importados (b):** `ViewMode`

#### `src/render/carBody.ts`

- **Veredito: DIVIDIR** → src/render/vehicles/carShell.ts (loft), lamps.ts, cabin.ts, carve.ts, src/render/vehicles/meshKit.ts (tint/merge/box/bar/roundedSlab/extrude comuns com heavyBody)
- **Evidência e regra (coordenador):** 63,5 KB (> 50 KB); 57% de linhas iguais ao 4.0 (DECISIONS 2026-10-30: reescrever); ajudantes duplicados em heavyBody.ts:13–175; 'LOD longe' com a mesma contagem de triângulos do perto (L744–750); portas do 4.0 'deixadas para depois' (L4–5).
- **Responsabilidades (a-l):** L1–51 types (`CarStyle`, `CarArchetype`, `Lamp`, `CarBody`), palette; L53–159 style table, `CAR_SIZES`, `carSeatPoints`; L161–267 geometry helpers (tint, merge, box, bar, roundedSlab, extrude, monotone spline); L269–350 car shape functions; L352–803 `buildCarBody` (stations, sections, ring loft, face classification, caps, trim, lamps, far LOD, handles/mirrors, lamp faces); L805–873 triangle split, surface ray, lamp face grid; L875–1009 `buildCarCabin` (floor, dash, wheel, seats, trims, wheel-house carve and walls); L1011–1093 `face`, `carve` (Sutherland–Hodgman box cut); L1095–1109 `seat`; L1111–1169 `buildCarSilhouette` (mid LOD).
- **Achados do leitor (a-l):**
  - [R40COPY] carBody.ts:1–5,13,135,353,752,795,879–882,886 — explicitly "roadcraft 4.0's render/carBody.ts", cites 4.0 line ranges (`carBody.ts:382-949`, `:724-747`, `:922`).
  - [MAIN] (inference) carBody.ts:357 — geometry built on the main thread by render/vehicles.ts:221 and render/propMeshes.ts:439 (once per style; heavy loft + per-lamp ray scan over every triangle L836–850 × 15 grid points × up to 9 retries L788).
  - [BUG] carBody.ts:744–750 — "far LOD: the same surface, coarse" but it is built from the same `faces` list as the near shell (same triangle count); only glass is recoloured. Coarseness depends only on the caller's `stations` argument.
  - [DEAD] carBody.ts:429,433 `side` computed then `void side`; L658,670 `probeX` + `void probeX`; L41 `M` is identity; L694 `shellFaces = bodyPaint` alias; L663 `for (const attr of [p2])` single-element loop.
  - [DUP] carBody.ts:167–236 — `tint`, `merge`, `box`, `bar`, `roundedSlab`, `extrude`, `lerp`, `M`, palette consts duplicated in heavyBody.ts:13–175 (merge differs: heavy throws on empty L79, car returns empty geometry L187–193).
  - [DUP] carBody.ts:753–760 vs 424–428 — side bulge formula written twice (`sectionSideZ` vs `bulge`).
  - [ALLOC] carBody.ts:496–508 `ringPoint` returns a new object per vertex; L592 `new Float32Array([...positions, ...capVertices])` spread; build-time only.
  - [OMAP] carBody.ts:1071 — `boxes.indexOf(bx)` inside the per-triangle loop (build-time).
  - [NAME] carBody.ts:4–5 — "the opening doors of 4.0 are left out for now": feature postponed.
  - [MIX] carBody.ts — 63 KB: body loft, lamp projection, cabin interior, CSG carve, mid-LOD silhouette in one file.
- **Superfície pública:** `CarStyle`, `CarArchetype`, `Lamp`, `CarBody`, `CAR_SIZES`, `carSeatPoints`, `axlesOf`, `buildCarBody`, `buildCarCabin`, `buildCarSilhouette`.

#### `src/render/cellLayer.ts`

- **Veredito: MANTER** → src/render/cellLayer.ts
- **Evidência e regra (coordenador):** Camadas L0–L3; um objeto Slot por célula do mapa inteiro (L63, L87–88, L139–140) e visita a todas as placas a cada quadro com mudança (L294): O(mapa) — o mesmo item aberto no STATE (cellLayer.update O(mapa)); escreve mesh.parent e group.children direto (L272, L472, L545).
- **Responsabilidades (a-l):** L13–59 `LayerSource`/`LayerOptions` contracts; L61–81 slot record, constants, `freeCpuCopy`; L83–164 `CellLayer` fields, constructor, warmup mesh, plate index; L166–223 dirty processing and cell/tile/plate requests; L225–278 install mesh from worker `PackedMesh`; L280–370 per-frame choice (frustum, plates, draw with shadow-reach box); L372–467 tile management (L0/L1/L2 choice, eviction, readiness) and drawing; L469–533 dithered fades and publish of shown cells; L535–546 reset.
- **Achados do leitor (a-l):**
  - [OBJ] cellLayer.ts:63,87–88,139–140 — one JS `Slot` object per cell (×2 with `detail`), per tile and per plate for the whole map (`CELL_COUNT` entries), plus per-mesh `userData` FadeData objects L71.
  - [OMAP] cellLayer.ts:294 — every changed frame visits all `MAP_PLATES²` plates; non-idle plates visit all their tiles (L321–324) and near tiles all their cells; the early-out L285–286 only covers a still camera. Work grows with map size while the camera moves (comment L284 acknowledges the old cost).
  - [OMAP] cellLayer.ts:536–539 — `reset` walks every slot of the map.
  - [ALLOC] cellLayer.ts:168 — `[...new Set(this.dirty.flatMap(...))]` each frame with several dirty kinds; L203,212,222 a closure per request; L491 `fading.findIndex` per new mesh.
  - [HOST] cellLayer.ts:272,472,545 — writes `mesh.parent` and `group.children` directly (bypasses three's add/remove; Object3D events/matrices not maintained) (inference: deliberate for speed).
  - [LAYER] (inference) cellLayer.ts:8–9 — fixed-size map grid (`MAP_CELLS`, `MAP_PLATES`) from config/core; does not use the unbounded tile model of r40/world/tiles.ts.
  - [BUG] (inference) cellLayer.ts:329 — `dist < limit * 0.8` with `limit` 0 (layer without plates) is never true, fine; but for a layer with plates, a plate evicted at L329 while `!visible` keeps `ps.requested = 0`, and L311 only re-requests when `far && visible` — a plate behind the camera that becomes far is not prefetched (pop-in risk when turning).
- **Superfície pública:** `LayerSource`, `SlotScope`, `LayerOptions`, `CellLayer` (dirty processing, `update`, `warmupMesh`, `reset`, `gpuBytes`, `changed`).
- **Exports nunca importados (b):** `SlotScope`, `LayerOptions`

#### `src/render/city.ts`

- **Veredito: DIVIDIR** → src/render/buildings/cityLayer.ts (fontes das malhas), src/render/buildings/cityMaterial.ts (shader de ~320 linhas), src/render/buildings/noiseTex.ts (no worker)
- **Evidência e regra (coordenador):** Ruído 128² e dois arrays FINISH_SIZE²×13 calculados na thread principal na importação (L30–33, L62–84); gatherBoxes na thread principal antes de cada trabalho (L92–113); travessia da cena inteira a cada render até achar a luz (L151–153); tipos de janela 0/2/3 idênticos (L242–243); DETAIL_SHOWN global entre camadas (L130, L266–269).
- **Responsabilidades (a-l):** L26–59 building finish texture arrays + one-shot worker load, finish uniforms; L61–84 procedural wall-noise texture; L86–122 `createCity` (LayerSource for buildings L0/L1/L2/L3 via job pool); L125–147 `DETAIL_SHOWN` + `createCityDetail` (facade detail layer); L149–170 sun direction uniform, band helper, style/curtain/plinth/trim uniform tables; L172–491 `createBuildingMaterial` (TSL: windows, curtain walls, shop fronts, interior mapping, blinds/curtains/rollers, night lighting, finishes, weathering, reveals, frames, normals).
- **Achados do leitor (a-l):**
  - [MIX] city.ts — mesh-source wiring (L87–147), texture loading/worker (L30–56), CPU noise generation (L62–84) and a ~320-line shader (L180–491) in one file.
  - [MAIN] city.ts:62–84 — 128² noise texture computed at module import on the main thread; L30–33 fills two `FINISH_SIZE²×13` arrays on main thread at import.
  - [MAIN] (inference) city.ts:92,100,113 — `world.gatherBoxes` runs on the main thread before each job; for a plate it gathers every cell of the plate (L109–112).
  - [OMAP] city.ts:151–153 — `SUN_DIR.onRenderUpdate` traverses the whole scene each render until a directional light is found (every render if none exists).
  - [LAYER] city.ts:18–19 — render imports `jobs/buildingFinishes.ts` and `jobs/buildingGen.ts` (render → jobs).
  - [TEXT] city.ts:94,103,116,140 — job keys built as strings `cell${level}:${c}`, `tile:${t}`, `plate:${p}`, `detail:${c}` (allocation per request).
  - [DEAD] city.ts:242–243 — `houseWin = punched` and `strip` is the same expression as `punched`: kinds 0/2/3 draw identical windows; L365 `kind<2.5 ? 0.2 : 0.2` same both branches.
  - [HOST] city.ts:130,266–269 — `DETAIL_SHOWN` written by the detail layer (`publish`) and read per object by the main material: cross-layer state through a module global.
  - [R40COPY] city.ts:27,57,163,168,250,300,343,356,382,385,454,460,467 — values cited from 4.0 files (`signature.ts:150-152`, `facadeKit.ts:235-247`, `kit.ts:239-257`, `buildingMesh.ts:1659-1661`).
- **Superfície pública:** `FINISH_ALBEDO`, `FINISH_NORMAL`, `WALL_NOISE`, `createCity`, `DETAIL_SHOWN`, `createCityDetail`, `BuildingPlacement`, `createBuildingMaterial`.

#### `src/render/cloudPuffs.ts`

- **Veredito: JUNTAR** → src/features/sky/clouds.ts (o dono das nuvens do jogador) com a loja de dados hoje em cloudShadow.ts
- **Evidência e regra (coordenador):** Escreve os globais CLOUD_TEX/CLOUD_DATA de cloudShadow.ts (L25–26): o estado mora no módulo errado.
- **Responsabilidades (a-l):** L17–20 cloud record and puff count; L22–72 instanced billboard puffs computed in the shader from a cloud data texture; L74–88 `set` cloud list into the shared texture.
- **Achados do leitor (a-l):**
  - [HOST] cloudPuffs.ts:25–26 — `tex`/`data` are the module globals `CLOUD_TEX`/`CLOUD_DATA` of cloudShadow.ts: the state lives in the shadow module, written by this class (L76–87) and `cloudCountU` set here L85.
  - [DUP] cloudPuffs.ts:6,8 — two separate imports from `./tsl.ts`.
- **Superfície pública:** `Cloud`, `MAX_CLOUDS` (re-export), `CloudPuffs`.

#### `src/render/cloudShadow.ts`

- **Veredito: MANTER** → src/render/cloudShadow.ts (só a sombra; a loja das nuvens sai para features/sky)
- **Evidência e regra (coordenador):** Guarda a loja das nuvens do jogador que não é da sombra (L11–22).
- **Responsabilidades (a-l):** L11–22 cloud data buffer/texture/count shared with puffs; L24–50 TSL cloud-shadow function (weather layer + loop over 24 clouds); L52–55 shadow strength by night/overcast.
- **Achados do leitor (a-l):**
  - [R40COPY] cloudShadow.ts:1 — "as Roadcraft 4.0's (`postprocess.ts`)".
  - [MIX] (minor) cloudShadow.ts:11–22 — owns the player-cloud data store that cloudPuffs.ts writes; the store is not shadow-specific.
- **Superfície pública:** `MAX_CLOUDS`, `CLOUD_DATA`, `CLOUD_TEX`, `cloudCountU`, `cloudShadowAt`, `cloudShadowStrength`.

#### `src/render/cookedSurfaces.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Carrega superfícies cozidas; ~30 MB de texturas alocadas e preenchidas na importação na thread principal (L10–45); console.info a cada execução (L62); mesmo esquema de worker de city.ts:30–56.
- **Responsabilidades (a-l):** L8–21 neutral placeholder texture factory; L23–49 named cooked surface table and land layer ids; L51–73 one-shot worker load filling textures.
- **Achados do leitor (a-l):**
  - [MAIN] cookedSurfaces.ts:10–12,24–45 — at import allocates and fills ~19 textures on the main thread (two 1024² ×4 B, several 512², a 9-layer and 8-layer 512² array: ≈ 30 MB of `Uint8Array.set` loops).
  - [TEXT] cookedSurfaces.ts:25–44,63 — textures keyed by file-stem strings ('terrain-grass.map', …) that must match file names in public/cooked/surfaces.
  - [R40COPY] cookedSurfaces.ts:1,23,48 — files copied from 4.0; layer ids from 4.0 `bake/catalogue.ts`.
  - [DEV] cookedSurfaces.ts:62 — `console.info` load summary on every run.
  - [DUP] cookedSurfaces.ts:10–19 vs city.ts:30–40 — same "neutral data texture then filled by worker" pattern and same worker bootstrap (cookedSurfaces.ts:56–73 vs city.ts:45–56).
- **Superfície pública:** `COOKED`, `CookedName`, `LAND`, `cookedLoaded`, `loadCookedSurfaces`.

#### `src/render/cookedWorker.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Worker de descompressão; não confere vkFormat (L20).
- **Responsabilidades (a-l):** L1–28 worker: fetch each KTX2, Zstd-decode level 0, post texels transferred.
- **Achados do leitor (a-l):**
  - [SMALL] cookedWorker.ts — single handler; spawned by cookedSurfaces.ts:59.
  - [BUG] (inference) cookedWorker.ts:20 — uncompressed path `levelData.slice()` posts the whole level; fine. No check that `vkFormat` is RGBA8: a file in another format would be posted and rejected only by byte length at cookedSurfaces.ts:67.
- **Superfície pública:** `CookedSurface` type.

#### `src/render/ecology.ts`

- **Veredito: MOVER** → src/world/ecology.ts
- **Evidência e regra (coordenador):** Cálculo puro do mundo dentro de render/ (L5–6).
- **Responsabilidades (a-l):** L8–15 constants and smoothstep; L17–23 hash value noise; L25–92 `ecologyTile` (height/water sampling with border, chamfer distance to water, summed-area mean, dry/wet/bare per 8 m sample).
- **Achados do leitor (a-l):**
  - [R40COPY] ecology.ts:1,17 — "after Roadcraft 4.0's `world/ecology.ts`", noise periods from 4.0.
  - [LAYER] (inference) ecology.ts:5–6 — pure world computation placed in `render/`, importing `world/ground.ts`; fixed `MAP_TILES` grid indexing L33–45.
  - [ALLOC] ecology.ts:47,69 — new typed arrays per tile (worker, per tile job — acceptable, could be pooled).
  - [NAME] ecology.ts:17 — "Tileable-free value noise" (unclear wording).
- **Superfície pública:** `ECO_RES`, `ecologyTile`.

#### `src/render/ecologyWorker.ts`

- **Veredito: MOVER** → src/jobs/ecologyWorker.ts
- **Evidência e regra (coordenador):** Worker lançado por render/terrain.ts:197; mensagem antes do init é descartada sem resposta (L10).
- **Responsabilidades (a-l):** L5–14 worker: init shared buffers, compute one tile per message into the shared field, answer tile id.
- **Achados do leitor (a-l):**
  - [SMALL] ecologyWorker.ts — one handler; spawned by render/terrain.ts:197.
  - [BUG] (inference) ecologyWorker.ts:10 — a tile message arriving before init is silently dropped (no reply), the caller may wait forever for that tile.
- **Superfície pública:** none (worker entry).

#### `src/render/heavyBody.ts`

- **Veredito: DIVIDIR** → src/render/vehicles/bus.ts + src/render/vehicles/truck.ts usando src/render/vehicles/meshKit.ts
- **Evidência e regra (coordenador):** 87% de linhas iguais ao 4.0 (DECISIONS 2026-10-30: reescrever); ajudantes duplicados de carBody.ts (L13–175); cabines 'deixadas de fora enquanto o vidro é opaco' (L5–6).
- **Responsabilidades (a-l):** L12–46 types, axles, palette; L48–264 geometry helpers (tint, merge, clipX, clean, extrude, box, bar, roundedSlab, polygon, twoSided, loft, archOutline); L266–409 `buildBusBody` (walls with arches/doors, window band, windscreen, roof + AC pod, lamps, shut doors); L412–524 `buildTruckBody` (cab, doors, chassis, tank, guards, box body, lamps).
- **Achados do leitor (a-l):**
  - [DUP] heavyBody.ts:13,52–81,140–175,120–135 — `M`, `lerp`, `tint`, `merge`, `box`, `bar`, `roundedSlab`, `extrude` duplicate carBody.ts:41,164–236 (with small differences: extrude has curve/bevel segment params; merge throws on empty).
  - [R40COPY] heavyBody.ts:1–6,15,31,388,470 — "as roadcraft 4.0 builds them: render/vehicleModels.ts buildBusModel (:739-1022) and buildTruckModel (:1058-1233)", door line refs `4.0 :844-866`, `:1118-1134`.
  - [DEAD] heavyBody.ts:46 — comment "Cabin colours, sRGB." with no constants after it.
  - [NAME] heavyBody.ts:5–6,356 — "cabins inside … left out while the glass is opaque" (feature postponed; bus glass is built two-sided L323,350); L356 comment says "driver's side window" but the code lofts the windscreen.
  - [MAIN] (inference) heavyBody.ts:266,412 — built on the main thread by render/vehicles.ts:341,344 (once each).
  - [ALLOC] heavyBody.ts:193,235–238 — `clone()`/new Vector3 per triangle/quad (build-time only).
- **Superfície pública:** `HeavyArchetype`, `HeavyBody`, `heavyAxles`, `buildBusBody`, `buildTruckBody`.
- **Exports nunca importados (b):** `heavyAxles`

#### `src/render/impostor.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Impostores das árvores; colorMat, normalMat e scene nunca descartados depois do cozimento (L90–96, L136); IMP_FRAME global mutável (L16, L31).
- **Responsabilidades (a-l):** L11–33 impostor grid constants and per-type frame measurement; L35–66 hemi-octahedral encode/decode (JS and TSL), photo camera up; L68–77 atlas render target; L79–138 bake: render each tree type from 8×8 directions into colour and normal atlases; L140–151 far-level quad geometry.
- **Achados do leitor (a-l):**
  - [NAME] impostor.ts:13–14 — comment lists four types "(mixed, cypress, oak, palm)" but `IMP_TYPES = 6`.
  - [HOST] impostor.ts:16,31 — `IMP_FRAME` global mutated by one function and read by bake and by props.ts: state outside its owner.
  - [DEAD] impostor.ts:68–72 — two stacked doc comments; the first ("Photographs the trees") belongs to `bakeImpostors`.
  - [BUG] impostor.ts:90–96,136 — `colorMat`, `normalMat` and `scene` are never disposed after the bake (only geometries are, L136): GPU pipelines/bindings leak once per bake.
  - [ALLOC] impostor.ts:65 — `upFor` new Vector3 per photo (bake-time only).
  - (inference) impostor.ts:1–4 — far trees drawn as impostors; CLAUDE.md lists impostors among forbidden quality tricks when used to pass the budget — needs owner-level check of whether 4.0 shows the same at that distance.
- **Superfície pública:** `IMP_G`, `IMP_TYPES`, `IMP_FRAME`, `impostorFrames`, `hemiOctEncode`, `hemiOctDecode`, `hemiOctEncodeNode`, `hemiOctDecodeNode`, `upFor`, `impostorTarget`, `bakeImpostors`, `impostorQuad`.

#### `src/render/inside.ts`

- **Veredito: DIVIDIR** → src/features/interiors/insidePlan.ts (andares, alvo, plano) + src/features/interiors/insideView.ts (malhas) + uniforms de corte em src/render/cutMask.ts
- **Evidência e regra (coordenador):** Planejamento do andar e escolha do alvo (L63–131) são lógica de domínio num arquivo de render; um THREE.Mesh por caixa, dezenas de draws por andar (L150–155); gatherBoxes + buildingVolumes na thread principal (L112–115); warm() deixa a vista 'ligada' com id −1 (L220–223).
- **Responsabilidades (a-l):** L14–23 cut/hidden-building uniforms; L30–40 per-vertex hidden-building mask (16 slots); L43–51 cut mask for the buildings' material; L57–72 storey levels from generator volumes; L85–103 cut box/plan for floor k; L109–118 plan from the world record (gatherBoxes + buildingVolumes); L125–131 which building the inside view opens; L133–233 InsideView: box meshes for slab/walls/partitions/core/stairs/desks, follow/hide/warm
- **Achados do leitor (a-l):**
  - `[OBJ]` inside.ts:150–155 — one `THREE.Mesh` per box (slab, 4 walls, partitions, core, 8 stairs, desks): dozens of draw calls for one floor, not instanced; rebuilt on each `show`.
  - `[MAIN]` inside.ts:112–115 — `world.gatherBoxes` + `buildingVolumes` (generator code from jobs/buildingGen.ts) run on the main thread for one building per open/edit (bounded: one cell).
  - `[LAYER]` inside.ts:10–12 — render imports generator (`jobs/buildingGen.ts`) and world editing (`world/lotEdit.ts`); plan/target logic (L63–131) is domain logic in a render file.
  - `[MIX]` inside.ts — shader cut uniforms used by another material, floor planning, target selection and the interior mesh in one file.
  - `[BUG]` inside.ts:220–223 — `warm()` calls `show()`, which sets `group.visible = true` and `plan`; with `id = -1` the view counts as `on` until the next `follow()` hides it (via `alive[-1]` undefined). (inference) if `follow` is not called the frame after warm, `on` reports true and the dummy floor stays drawn at y −1000.
  - `[ALLOC]` inside.ts:159 — `[...this.group.children]` per show (event, not per frame); removed meshes are not disposed (geometry/material shared, so no GPU leak).
- **Superfície pública:** `cutBoxU/cutRotU/cutYU/cutTagU`, `HIDDEN`, `hiddenU`, `cutMask()` (for buildings material), `INSIDE_CUT`, `Storey`, `storeyLevels`, `InsideLot`, `InsidePlan`, `insidePlan`, `insidePlanOf`, `insideTarget`, `InsideView`.

#### `src/render/ktx-parse.d.ts`

- **Veredito: JUNTAR** → src/render/types.d.ts (com jobs/ktxParse.d.ts: o inventário mostra duas declarações do mesmo módulo ktx-parse)
- **Evidência e regra (coordenador):** Declaração de tipos do ktx-parse do three; jobs/ktxParse.d.ts declara o mesmo módulo.
- **Responsabilidades (a-l):** L2–7 ambient types for three's bundled ktx-parse
- **Achados do leitor (a-l):**
  - `[SMALL]` ktx-parse.d.ts:1 — type declaration only; comment names render/cookedWorker.ts as the user.
- **Superfície pública:** module `three/examples/jsm/libs/ktx-parse.module.js` (`read`, `KHR_SUPERCOMPRESSION_ZSTD`, `KTX2Container`, `KTX2Level`).

#### `src/render/particles.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Partículas por GPU com consulta por raio (L205, L212); importa world/arch, roads/zones e jobs/buildingGen para achar chaminés na thread principal (L16–18).
- **Responsabilidades (a-l):** L27–30 kinds and limits; L48–140 GPU-only particle material (emitter texture, per-kind trajectories/size/colour/alpha); L151–159 warm-up; L162–166 short-lived bursts; L168–188 throttled update (2 Hz, dirty readers, camera move > 120 m); L194–227 emitter gathering by radius (items index, industrial chimneys), nearest-first up to MAX_EMIT; L231–234 item→kind map
- **Achados do leitor (a-l):**
  - `[ALLOC]` particles.ts:174, 178 — `bursts.filter` and `[this.builtEdits, this.itemEdits]` every 0.5 s update tick.
  - `[ALLOC]` particles.ts:197–222 — closures, `found` array, per-chimney object `f` (L217), `groundRange` result, `Array.from(...).sort` on each rebuild (event-driven, not per frame).
  - `[OBJ]` particles.ts:144 — one JS tuple per burst (bounded by explosions, small).
  - `[DEAD]` particles.ts:135 — `void vec2; void select;` unused destructured names; L142 orphan doc comment ("Rebuilds the list…") sits above `bursts`, belongs to `update`.
  - `[LAYER]` particles.ts:16–18 — render imports `world/arch`, `roads/zones`, `jobs/buildingGen` (chimney position from generator helpers on the main thread).
  - `[DUP]` particles.ts:180 — cell centre from cell id (`cellOriginX(c % MAP_CELLS) + CELL_SIZE/2`), same pattern as props.ts:505.
- **Superfície pública:** `Puff` (kind codes), `Particles` (mesh, `warm`, `burst`, `update`, `rebuild`, `count`).

#### `src/render/people/creator.ts`

- **Veredito: MOVER** → src/features/people/creator.ts
- **Evidência e regra (coordenador):** Estado colocado pelo jogador e comandos com desfazer dentro de render/ (dono é o renderer, crowd.ts:56); 'bag' toca o clipe de andar para quem está parado (L105); paletas repetidas de crowd.ts:38–39 (L15–18); rótulo 'pessoas' (L83).
- **Responsabilidades (a-l):** L15–28 palettes and screen catalogue; L38–77 group store (place/remove/clear, MAX_GROUPS 256); L80–86 place as command with inverse; L92–98 colour bits into the hash; L100–113 clip by hold/mode; L119–149 per-frame placement of people of near, visible groups
- **Achados do leitor (a-l):**
  - `[OBJ]` creator.ts:33, 66 — one JS object per group with `variations`/`hashes` arrays and an options object (bounded 256 groups).
  - `[MIX]`/`[LAYER]` creator.ts — player-placed game state and undoable commands live in `render/people` and are owned by the renderer (crowd.ts:56); not a render responsibility.
  - `[TEXT]`/`[NAME]` creator.ts:83 — command label `'pessoas'` (Portuguese, not English).
  - `[BUG]` creator.ts:105 — hold `'bag'` returns `CLIP.walkCarry` even for mode `stand`/`group`: those people stay in place (L134–143) playing a walking clip (feet walking in place).
  - `[DUP]` creator.ts:15–18 — `CREATOR_PALETTES` repeats `CLOTHES`/`HAIR` of crowd.ts:38–39 (must be kept in sync by hand); `maxCount: 20` (L26) repeats the clamp at L52.
  - (inference) `[DUP]` creator.ts:35 `WALK_SPEED = 1.3` vs looks.ts:27 `WALK_SPEED = 1.4` — two walking speeds of the same name.
- **Superfície pública:** `DEFAULT_PERSON_OPTIONS`, types `CreatorHold/CreatorMode/PersonOptions` (re-exported), `CREATOR_PALETTES`, `creatorCatalog`, `PlacedPerson`, `PeopleCreator`.
- **Exports nunca importados (b):** `DEFAULT_PERSON_OPTIONS`, `CreatorHold`, `CreatorMode`, `PersonOptions`, `CREATOR_PALETTES`

#### `src/render/people/crowd.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Desenho da multidão; array por LOD a cada quadro (L344) e closure por veículo desenhado (L276); comentário do dither não bate com o código (L311–323).
- **Responsabilidades (a-l):** L26–41 LOD thresholds, caps, palettes; L75–95 fetch/validate cooked people; L97–224 storage buffers, vertex-pulling skinning shader per LOD, tints, dither masks; L227–240 frame start (frustum, px scale, creator people); L246–259 push from pose buffer; L273–300 vehicle occupants; L303–309 direct placement; L315–336 level choice and instance write; L338–346 upload ranges; L349–358 warm-up
- **Achados do leitor (a-l):**
  - `[ALLOC]` crowd.ts:344 — `[a.pos, a.prev, a.info, a.anim]` array allocated per LOD every frame in `end()`.
  - `[ALLOC]` crowd.ts:276 — closure `at` allocated on every `occupants()` call (per drawn vehicle per frame).
  - `[DEAD]` crowd.ts:311–313, 316–317 — doc says levels cross by complementary dither, code (L318–323) draws one level at a time; `LOD_BAND_PX`/`LOD2_BAND_PX` now only shift the thresholds (level 0 starts at 70 px, not the ~60 px of L8/L26); `dist` only used for the shadow test.
  - `[HOST]`/`[MIX]` crowd.ts:56–58, 235–239 — the renderer owns `PeopleCreator` (player state) and serves its catalogue.
  - `[DUP]` crowd.ts:38–39 — palettes duplicated in creator.ts:15–18.
  - (inference) crowd.ts:230 — px scale from `innerHeight` (CSS px), not the render target height; LOD thresholds depend on window size not pixel ratio.
  - `[LAYER]` crowd.ts:17 — occupants seat table depends on `render/carBody.ts` via occupants.ts (fine within render).
- **Superfície pública:** `PeopleRenderer` (`load`, `begin`, `push`, `occupants`, `pushPlaced`, `end`, `warmup`, `catalog`, `creator`, `seatedInCabins`, `OCCUPANT_NEAR`, `drawn`).

#### `src/render/people/format.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Formato das pessoas cozidas; COOK_VERSION mantido igual à mão com tools/cook-people.mjs (L4) — a ferramenta passa a importar daqui.
- **Responsabilidades (a-l):** L5 cook version; L8–15 region/clip/prop tables; L17–32 cooked file types; L35–53 file validation
- **Achados do leitor (a-l):**
  - `[TEXT]` format.ts:4 — must match `COOK_VERSION` in tools/cook-people.mjs by hand.
- **Superfície pública:** `PEOPLE_COOK_VERSION`, `REGION`, `CLIP`, `ClipName`, `CLIP_PROP`, `CookedClip/CookedVariation/CookedSection/CookedPeople`, `checkCooked`.
- **Exports nunca importados (b):** `ClipName`, `CookedClip`, `CookedVariation`, `CookedSection`

#### `src/render/people/looks.ts`

- **Veredito: MOVER** → src/shared/people/looks.ts
- **Evidência e regra (coordenador):** Lógica pura sem three usada por sim e render; hash inteiro repetido em surfaceBake.ts:10–14, 32–37.
- **Responsabilidades (a-l):** L18–24 lowbias32 hash; L41–65 look of a pedestrian from pose info (variation, clip, rate, phase); L71–73 seated person hash; L76 rate quantization
- **Achados do leitor (a-l):**
  - `[DUP]` looks.ts:18–24 — integer hash; other hand-written hashes exist (surfaceBake.ts:10–14, 32–37); (inference) more copies elsewhere.
  - `[LAYER]` — pure logic (no three) in `render/`; could sit in a shared/people module.
- **Superfície pública:** `LookChoice`, `hash32`, `pickLook`, `riderHash`.

#### `src/render/people/occupants.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Tabela de assentos; códigos 0/1/2 e índice de estilo como contrato implícito (L26–29).
- **Responsabilidades (a-l):** L10–11 car seats from carBody; L14–23 bus and lorry seats; L26–30 seats by kind/style; L36–40 people aboard from pose light bits; L43 moto rider pelvis
- **Achados do leitor (a-l):**
  - `[R40COPY]` occupants.ts:13 — bus seat values from "roadcraft 4.0 heavyBody" (values ported, cited).
  - `[TEXT]` occupants.ts:26–29 — kind codes 0/1/2 and style index into `CAR_STYLES` order are implicit contracts with the pose buffer/vehicles; style 5 (moto) handled in crowd.ts:288.
  - `[SMALL]` — small table module; used by crowd.ts:17.
- **Superfície pública:** `Seat`, `seatsOf`, `aboard`, `MOTO_PELVIS`.
- **Exports nunca importados (b):** `Seat`

#### `src/render/post.ts`

- **Veredito: DIVIDIR** → src/render/post.ts (grafo de pós-processo) + src/render/shadows.ts (cascatas e política de camadas)
- **Evidência e regra (coordenador):** Sombras e pós-processo juntos; escreve campos privados do three (_cameraProjectionMatrix, _shadowNodes; L248–254, L345); modos de depuração ?semtraa ?traadbg ?vel no produto (L196–208).
- **Responsabilidades (a-l):** L38–52 CSM with far fade; L61–211 pipeline: shadows setup, MRT scene pass, GTAO+denoise, cloud shadows, aerial perspective, TRAA (day/night), CAS + grade, bloom, debug outputs; L225–229 ownership; L238–257 camera switch; L268–285 cascade fitting/layers; L301–311 shadow redraw only on change; L318–326 day/night output switch; L329–334 render; L341–351 dispose
- **Achados do leitor (a-l):**
  - `[DEV]` post.ts:196–208 — `?semtraa`, `?traadbg`, `?vel` debug image modes read from the URL in product code.
  - `[BUG]` (fragility) post.ts:248–254, 345 — writes three's private fields (`_cameraProjectionMatrix`, `_cameraNear`, `_shadowNodes`); any three update silently breaks iso-camera AO or disposal.
  - `[DEAD]` post.ts:57, 350 — `renderer` field stored and only `void`ed.
  - `[MIX]` post.ts — shadow configuration and cascade layer policy live with the post-processing graph.
  - `[R40COPY]` post.ts:122, 142, 169 — values cited from 4.0 `postprocess.ts` lines (ported values, not code).
- **Superfície pública:** `PostOptions`, `Post` (`render`, `setCamera`, `invalidateShadows`, `prepareShadows`, `selectOutput`, `dispose`, `csm`, `bloomOverride`).

#### `src/render/preview.ts`

- **Veredito: MANTER** → src/render/preview.ts (comentários em inglês)
- **Evidência e regra (coordenador):** Pré-visualização das ferramentas; comentários em português.
- **Responsabilidades (a-l):** L14–78 road preview ribbon (shader-placed quadratic curve), snap marker, roundabout circle; L81–98 show curve with resampled heights; L100–116 markers and hiding
- **Achados do leitor (a-l):**
  - `[NAME]` preview.ts:1–3, 57, 59, 80, 89 — comments in Portuguese (rule: everything English).
  - `[TEXT]` preview.ts:102 — marker kind `'node' | 'seg' | 'free'` string union chooses colour.
  - `[DUP]` preview.ts:86, 112 — ok/error colours 0x4cd28a / 0xe2564b repeated literals.
- **Superfície pública:** `RoadPreview` (`mesh`, `marker`, `circle`, `show`, `hide`, `showMarker`, `showCircle`, `hideAll`).

#### `src/render/propBlocks.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Pool de blocos dos props.
- **Responsabilidades (a-l):** L9–13 placement result; L15–111 block allocator: min-heap free list, per-cell block lists, eviction of farther cells, high-water mark
- **Achados do leitor (a-l):**
  - `[ALLOC]` propBlocks.ts:65 — `[...resident].filter().sort()` when the pool is full (per placement under pressure; bounded by resident cells).
  - `[OBJ]` propBlocks.ts:22 — one JS array per resident cell (bounded by the range, not per entity).
- **Superfície pública:** `Placement`, `PropBlocks` (`place`, `release`, `blocksOf`, `setDistance`, `free`, `capacity`, `highBlock`, `resident`).

#### `src/render/propMeshes.ts`

- **Veredito: DIVIDIR** → src/render/props/meshes/<família>.ts + src/render/props/signAtlas.ts + src/render/props/kinds.ts
- **Evidência e regra (coordenador):** 40 KB com ~20 famílias de malha, atlas de placas, tabelas e política de sombra; 'PARE'/'Centro' na textura sem tradução (L237, L251); peças de fachada de prédio no tipo de mobiliário de calçada (L324–358); tipos 18..23 vazios 'por enquanto' (L560–562); boneco de caixa PROP.Person sobrando (L493–507); tudo construído na thread principal (L204–265, L540–565).
- **Responsabilidades (a-l):** L15–30 materials/def types; L34–58 part/merge helpers; L63–109 trees, bushes, lamps; L115–152 signal heads; L154–178 bench, bin, wire; L181–265 sign atlas (canvas drawing); L271–299 sign and pole; L302–394 furniture (incl. building facade pieces) and barriers; L397–400 impostor sources; L407–455 parked cars (carBody); L458–490 ground clutter; L493–507 placeholder person; L514–537 4.0 building parts; L540–565 all defs; L569–620 kinds, split/models tables; L623–656 variant geometry split and reach; L659–712 stretch, cull radius, shadow policy
- **Achados do leitor (a-l):**
  - `[MIX]` propMeshes.ts — mesh library for ~20 prop families, a canvas sign atlas, kind tables, cull math and shadow policy in one 40 KB file.
  - `[MAIN]` propMeshes.ts:540–565, 204–265 — all prop geometry (merges, car bodies, 4.0 parts) and the sign atlas built on the main thread at load.
  - `[TEXT]` propMeshes.ts:237, 251 — player-visible texture text `'PARE'`, `'Centro'` hard-coded (not localized).
  - `[NAME]` propMeshes.ts:563 — error message `'tipos de peça'` in Portuguese.
  - `[MIX]` propMeshes.ts:324–358 — building facade pieces (wall AC, roof AC, tank, dish…) live in the sidewalk-furniture type.
  - `[DEAD]` propMeshes.ts:493–507 — box "creator's person" prop (PROP.Person) while render/people draws cooked people; (inference) leftover simple figure.
  - `[DEAD]` propMeshes.ts:560–562 — types 18..23 "empty for now" placeholders; L473 `.rotateZ(0)` no-op.
  - `[R40COPY]` propMeshes.ts:403–455, 509–537 — 4.0 car body and 4.0 kit part geometries (via `r40/api`).
  - `[LAYER]` propMeshes.ts:7, 11–12 — render imports `jobs/props`, `jobs/parts40`, `r40/api`.
- **Superfície pública:** `PMAT`, `FACE_LAST`, `SIGN_PARTS`, `PropDef`, `SIGN_ATLAS`, `ATLAS_CELL`, `SIGN_FACES`, `buildSignAtlas`, `impostorSources`, `buildPropDefs`, `PropKind`, `VARIANTS`, `propKindTable`, `propStretch`, `propCullRadius`, `buildPropKinds`, `propCastsShadow`, `propIsSmallCaster`.

#### `src/render/props.ts`

- **Veredito: DIVIDIR** → src/render/props/stream.ts (pool e residência), src/render/props/cull.ts (compute), src/render/props/material.ts (shader), src/render/props/signals.ts (estado dos semáforos)
- **Evidência e regra (coordenador):** 47 KB rente ao limite; closures forEach a cada quadro (L756, L759); textura de estado de todos os semáforos do mapa enviada a cada 250 ms (L752); WebGL 2 mexe em group.children direto (L254, L722–733).
- **Responsabilidades (a-l):** L33–45 pool constants; L129–274 pool buffers, compute reset/count/prefix/cull, meshes per kind×level; L280–485 single prop material (instance decode, 4.0 parts, wires, barriers, signs, traffic lights, impostors, leaf cards, wind, ipê flowering, paint, masks); L488–494 impostor bake; L497–501 dirty; L504–539 cell distance/request/ranges; L545–588 residency by radius; L591–636 kind counts; L639–687 block upload per cell; L694–748 WebGL 2 fallback; L751–781 per-frame update; L784–792 clear; L796–798 variant decode
- **Achados do leitor (a-l):**
  - `[MIX]` props.ts — pool/streaming, compute cull, one 200-line shader covering traffic-light state decoding (L383–405), trees/impostors, signs, wires, barriers, 4.0 parts, plus a WebGL 2 fallback, in a 47 KB file (near the 50 KB gate).
  - `[ALLOC]` props.ts:756, 759 — `frustum.planes.forEach` and nested `kinds.forEach(d.dist.forEach(...))` closures every frame in `update`.
  - `[ALLOC]` props.ts:553, 562, 565, 622 — spreads/maps/sorts on residency updates (camera moved > 32 m; bounded by range).
  - `[OMAP]` (inference) props.ts:752 — whole signal-state texture (size of `signalsSab`, every node) marked for upload every 250 ms regardless of what is in view.
  - `[BUG]` (fragility) props.ts:254, 722, 732–733 — WebGL 2 path pushes meshes into `group.children` and sets `parent` by hand, bypassing `add/remove` (no events; `out.length = 0` clears the group's children array directly).
  - `[DUP]` props.ts:735–743 — hard-coded 128/256/264 instead of `CELL_SIZE` (cell bounds math duplicated from `cellOriginX`).
  - `[DUP]` props.ts:187–194 vs 606–608/propMeshes.ts:667–670 — variant and cull radius computed in shader and mirrored on CPU (documented intentional).
  - `[NAME]` props.ts:249 — comment `---- desenho` in Portuguese; L133 comment says props are left out on WebGL 2, contradicted by the fallback at L250–256.
  - `[TEXT]` props.ts:519 — literal 296 (= 256 + 40) margin for segment gathering.
- **Superfície pública:** `PropRenderer` (`update`, `processDirty`, `bake`, `clear`, `signalTex`, `pixelScale`, `changed`, `pendingCells`, `residentCells`, `impRT`, `group`, `enabled`).

#### `src/render/roads.ts`

- **Veredito: MANTER** → src/render/roads.ts (código morto removido)
- **Evidência e regra (coordenador):** Camada e material das vias; usePavers = float(0) e slabs = float(0) multiplicam por zero o código de lajotas (L380–399, conferido): shader morto compilado; sobreposição de tráfego dentro do material (L461–487).
- **Responsabilidades (a-l):** L31–52 traffic look textures; L58–72 bridge test per cell; L78–106 road CellLayer source (worker mesh jobs per cell/tile); L109–129 paint style/overlay uniforms; L140–525 road material: profile table, lines, crossings, stop/yield, lane arrows, asphalt/kerb/footway/verge cooked textures, gutter, drains, manholes, cobbles/pavers/stone, rails, bus lane, density cars, traffic overlay, zone strip, lamp pools, wet look
- **Achados do leitor (a-l):**
  - `[DEAD]` roads.ts:378–382, 387, 394–399 — `segPick` computed then `void`ed; `usePavers = float(0)` and `slabs = float(0)`: the slab/panel shading code is multiplied by zero but still in the shader.
  - `[MIX]` roads.ts:461–487 — traffic density cars and the traffic overlay drawn inside the road material; layer source, paint-style globals and material in one file.
  - `[TEXT]` roads.ts:116–126 — paint styles keyed by strings `'br' | 'us' | 'eu' | 'classic'` (shared with the options; inference).
  - `[MAIN]` roads.ts:58–72 — bridge test samples every segment of a cell/tile on the main thread when the layer asks for shadow casting (bounded by cell/tile).
  - (inference) `[BUG]` roads.ts:156 — each `createRoadMaterial` call registers another `onProfileAdded` listener that is never removed; a second material (or rebuild) leaks listeners and table textures.
  - `[R40COPY]` roads.ts:302, 337 — asphalt look "as Roadcraft's (ROAD_SPACE_FRAGMENT)", 4.0 cooked surfaces (ported values).
  - `[LAYER]` roads.ts:11, 14–16 — render imports `jobs/roadMesh`, `jobs/props`, `world/heights`, `roads/*`.
- **Superfície pública:** `TrafficLook`, `createTrafficLook`, `createRoads`, `zoneOverlayU`, `paintWhiteU`, `paintYellowU`, `paintStyleU`, `PAINT_STYLES`, `setPaintStyle`, `trafficOverlayU`, `createRoadMaterial`.

#### `src/render/scene.ts`

- **Veredito: DIVIDIR** → src/render/scene.ts (renderer e luz) + src/features/sky/skyShader.ts + src/features/water/seaMaterial.ts + src/features/sky/timeOfDay.ts
- **Evidência e regra (coordenador):** Inicialização do renderer, céu, sonda de ambiente, mar, modelo da hora e uniforms do clima num arquivo; new Vector3 a cada setSun (L237), chamado por quadro com o relógio andando.
- **Responsabilidades (a-l):** L28–98 renderer creation (limits, WebGL fallback), fog, sky, sun, hemi, sea plane, environment; L107–143 gradient sky mesh; L149–228 environment probe (PMREM on change) and per-material env intensity registry; L234–246 sun placement in 0.2° steps; L249–256 global weather/night uniforms; L279–328 time of day (sun/moon, hemi, sky colours, fog)
- **Achados do leitor (a-l):**
  - `[MIX]` scene.ts — renderer bootstrap, sky shader, env probe, sea material, time-of-day model and global weather uniforms (waves, foam, current, fog level) in one file.
  - `[ALLOC]` scene.ts:237 — `new THREE.Vector3()` on every `setSun` (called from `setTimeOfDay`; (inference) per frame while time runs).
  - `[DEV]` scene.ts:29 — `?webgl` query parameter forces compatibility mode.
  - (inference) `[BUG]` scene.ts:171–177 — `waterEnv` registry only grows: re-created materials stay referenced and updated forever.
  - `[R40COPY]` scene.ts:101–106, 166–170, 309 — values cited from 4.0 environment.ts / water.ts (ported values).
- **Superfície pública:** `SceneParts`, `TONE_EXPOSURE`, `createScene`, `GradientSky`, `waterEnv`, `SkyEnvironment`, `setSun`, `fogLevel`, `waveU`, `foamU`, `currentU`, `nightU`, `setTimeOfDay`.

#### `src/render/sun.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Constantes e vetor do sol compartilhados; global mutável sem dono (L7).
- **Responsabilidades (a-l):** L7 shared sun direction; L10–24 shadow reach/length, shadow-only and small-caster layers
- **Achados do leitor (a-l):**
  - `[SMALL]` sun.ts — constants + one shared vector; read by post.ts, props.ts, propMeshes.ts (and cell layers per its comment).
  - `[HOST]` sun.ts:7 — mutable module global written by scene.ts and read by many; no owner object.
- **Superfície pública:** `sunDirection`, `SHADOW_REACH`, `SHADOW_LENGTH`, `SHADOW_ONLY_LAYER`, `SMALL_CASTER_LAYER`, `SMALL_CASTER`.

#### `src/render/surfaceBake.ts`

- **Veredito: MOVER** → trabalho para um worker (src/render/surfaceBakeWorker.ts) ou textura cozida em public/cooked
- **Evidência e regra (coordenador):** ~1,4 milhão de texels de ruído calculados na thread principal na importação do módulo (L151–153, conferido: GRASS_TEX = grass() etc. no topo do arquivo); dois hashes inteiros no mesmo arquivo (L10–14, L32–37).
- **Responsabilidades (a-l):** L8–37 tileable value noise, fbm, cell hash; L39–46 DataTexture helper; L56–80 asphalt; L86–111 footway; L120–149 grass; L160–181 water normals; L191–223 rock albedo/normal; L229–237 terrain blend noise
- **Achados do leitor (a-l):**
  - `[MAIN]` surfaceBake.ts:151–237 — ~1.4 M texels of fbm noise computed in JS on the main thread as an import side effect (6× 512², 2× 256²), blocking load.
  - `[DUP]` surfaceBake.ts:10–14, 32–37 — two integer hashes in the same file; looks.ts:18 has a third.
  - (inference) `[DEAD]` surfaceBake.ts:153 — `FOOTWAY_TEX`: roads.ts:380 says the footway now uses the cooked 4.0 texture and imports only `ASPHALT_TEX/ASPHALT_TILE`; usage elsewhere not visible in this batch. Asphalt G channel (L76) not read by roads.ts (only `.r`, roads.ts:306).
  - `[R40COPY]` surfaceBake.ts:156–171, 186–188 — "exactly as 4.0's water.ts:105-111", 4.0 granite recipe (ported values).
- **Superfície pública:** `ASPHALT_TILE`, `FOOTWAY_TILE`, `GRASS_TILE`, `ROCK_TILE`, `GRASS_TEX`, `ASPHALT_TEX`, `FOOTWAY_TEX`, `WATER_TEX`, `ROCK_TEX`, `ROCK_NORMAL`, `TERRAIN_NOISE`.
- **Exports nunca importados (b):** `FOOTWAY_TILE` (nem no arquivo), `FOOTWAY_TEX` (nem no arquivo)

#### `src/render/terrain.ts`

- **Veredito: DIVIDIR** → src/render/terrain/cdlod.ts (terreno), src/features/water/waterRender.ts (rio, lago, mar), src/render/terrain/grass.ts, src/render/terrain/ecology.ts (agenda do worker), src/render/terrain/roadPaint.ts (pintura e recortes)
- **Evidência e regra (coordenador):** 66 KB (> 50 KB) com terreno, água, grama, sombra, ecologia e pintura de via numa classe (L83–1085); new Matrix4 a cada quadro (L961, conferido) e array literal a cada quadro (L992); laço por todas as raízes do mapa a cada quadro (L977–987, 144 a 24 km); nós calculados e descartados (L556–564, L758).
- **Responsabilidades (a-l):** L24–39 SEAM_REACH, gridU, TSL imports; L41–64 ground colour table + LOD/shadow/water/tuft constants; L72–81 WaterNodeMaterial (Fresnel specular); L83–290 TerrainRenderer ctor: height/paint/ground/water/eco DataArrayTextures, ecology worker spawn (L196–205), CDLOD patch grid, water near/far instanced grids, grass, shadow copy; L292–297 LOD factor; L299–378 TSL loaders (height, water, ground, road cover, seam state) + ground blend weights; L384–394 setSeams (writes paint blue channel); L399–690 terrain material (CDLOD morph, road sink, seam mask, triplanar rock, grass no-tile, relief normal, colour incl. ecology, painted ground, shore, road paint, brush ring, map grid, map edge); L698–769 grass tufts material/geometry; L779–880 water material (also sea); L883–902 shadow-copy material; L905–911 setBiome; L914–923 setRoadPaint; L926–956 ecology queue + dirty layer upload; L959–1081 per-frame CDLOD selection (view, shadow, water tiles).
- **Achados do leitor (a-l):**
  - [MIX] terrain.ts:83–1085 — one class owns terrain CDLOD, river/lake/sea water material and instancing, grass tufts, shadow copy, ecology worker scheduling, road paint/seams textures, brush ring and map grid overlay. 66 KB (> 50 KB new-file gate).
  - [ALLOC] terrain.ts:961 — `new THREE.Matrix4()` every frame in update() (hot path).
  - [ALLOC] terrain.ts:992 — array-of-tuples literal `[[...],[...]] as const` built every frame in update().
  - [OMAP] terrain.ts:977–987 — both root loops visit all (MAP_SIZE/PLATE_SIZE)² roots per frame (e.g. 144 at 24 km) and call bounds() for each; small but grows with map area, not view.
  - [DEAD] terrain.ts:556, 558, 564, 758 — `void grassB`, `void slope`, `void dirt` (computed nodes unused); grassB uniform (L126, L910) feeds nothing visible.
  - [BUG] (inference) terrain.ts:388–393 — setSeams only re-uploads the layer of the LAST cell it wrote (`tile` overwritten in the loop); correct only if a SEAM_CELLS block never straddles a 1024 m tile edge (holds if seam cells are aligned 256 m road cells; not checked here).
  - [LAYER] terrain.ts:17–18 — render imports constants from jobs/roadPaint.ts and jobs/terrainSeams.ts; L197 render spawns `./ecologyWorker.ts` itself.
  - [R40COPY] terrain.ts:309, 480, 498, 562, 567, 582, 615, 772–777, 822, 830, 862 — values cited from 4.0 terrain.ts/water.ts line numbers (ported values, comments only).
- **Superfície pública:** `SEAM_REACH`, `gridU`, `TerrainRenderer` (mesh, waterMesh, grassMesh, shadowMesh, seamMaterial, setLodFactor, setSeams, setBiome, setRoadPaint, uploadDirtyLayers, update, createSeaMaterial, brush, grassA/B).

#### `src/render/terrainSeams.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Fábrica da camada de recortes; origem da célula repetida 3 vezes (L21, L31, L43).
- **Responsabilidades (a-l):** L16–17 REACH; L19–53 createTerrainSeams: CellLayer source that queries segs/nodes near a cell (segIndex/nodeIndex), gathers a road graph and submits a `terrainSeams` worker job; on install hands holes to terrain.setSeams.
- **Achados do leitor (a-l):**
  - [SMALL] terrainSeams.ts:19 — single factory function; host passes terrain + pool (caller not visible here).
  - [NAME] terrainSeams.ts:47 — `holesOf` declared after `src` closures that use it (works at runtime since used later; reads oddly).
  - [DUP] terrainSeams.ts:21, 31, 43 — `cellOriginX(c % MAP_CELLS), cellOriginX((c / MAP_CELLS) | 0)` repeated three times.
- **Superfície pública:** `createTerrainSeams(net, pool, dirty, terrain): CellLayer`.

#### `src/render/textSigns.ts`

- **Veredito: MOVER** → src/features/streetscape/textSigns.ts
- **Evidência e regra (coordenador):** Placas com texto do jogador; chave por string de posição (L15) compartilhada com world.signTexts; WARMUP_KEY 's|Rua' em português (L12).
- **Responsabilidades (a-l):** L10–15 radius, warmup key, `signKey` (position string key); L17–96 TextSigns: canvas-texture material cache per text, rebuild of sign plates within 450 m when eye moves 60 m or texts change, cache eviction, warmup mesh.
- **Achados do leitor (a-l):**
  - [OBJ] textSigns.ts:72–78 — two `THREE.Mesh` per sign recreated on every rebuild (bounded by RADIUS query; few signs).
  - [ALLOC] textSigns.ts:62 — `[...this.group.children]` and new meshes each rebuild (not per frame: gated by 60 m / version).
  - [TEXT] textSigns.ts:15 — sign identity is a position string `"x*10,z*10"` (Map<string,string>), shared with whoever fills `texts`; WARMUP_KEY L12 is the literal `'s|Rua'` (Portuguese text baked in code).
- **Superfície pública:** `signKey`, `TextSigns` (group, version, update(eye), warmup()).

#### `src/render/traa.ts`

- **Veredito: MANTER** → src/render/traa.ts (cópia registrada do three r186 com a correção da profundidade anterior)
- **Evidência e regra (coordenador):** Cópia de three/examples/jsm/tsl/display/TRAANode.js (641 linhas no node_modules; conferido) com // @ts-nocheck (L1) e a correção; traaDebug compilado no shader do jogo (L15, L659–661); objeto viewOffset por quadro (L324–333).
- **Responsabilidades (a-l):** L1–11 vendored copy of three r186 TRAANode with previous-depth fix; L33–278 ctor (render targets, uniforms); L297–363 size, jitter view offset; L370–462 per-frame resolve + history/depth copies; L470–672 TSL setup (variance clipping, thin-line luma range, subpixel correction, reprojection with ortho/perspective uniform, motion memory in alpha, debug view); L678–687 dispose; L693–706 halton offsets, `traa` factory.
- **Achados do leitor (a-l):**
  - [DUP] traa.ts:1–706 — copy of node_modules three/examples/jsm/tsl/display/TRAANode.js with `// @ts-nocheck` (L1); tab-indented, untyped.
  - [DEV] traa.ts:15, 659–661 — `traaDebug` debug visualisation uniform compiled into the shipping shader.
  - [ALLOC] traa.ts:324–333 — `viewOffset` object literal created every frame (setViewOffset runs from OnBeforeRenderPipeline L478–483).
  - [NAME] traa.ts:150–163 — history RT doc comment detached from its field by the inserted `restartHistory` doc.
- **Superfície pública:** `traaDebug`, default `TRAANode`, `traa(beauty, depth, velocity, camera)`.

#### `src/render/transit.ts`

- **Veredito: MOVER** → src/features/transit/transitRender.ts
- **Evidência e regra (coordenador):** Qualquer edição a 48 m de uma parada reconstrói todas as paradas de todas as linhas (L125–211): O(paradas da cidade) por edição; Quaternion/Vector3 por parada (L170–193).
- **Responsabilidades (a-l):** L19–27 coloredBox geometry helper; L29–91 TransitRenderer ctor: merged shelter/marker/platform/metro-entrance geometries as InstancedMesh, path line group; L96–115 instanced/grown capacity; L121–221 update: rebuild all stops of all lines on version change or road edit near a stop.
- **Achados do leitor (a-l):**
  - [OMAP] transit.ts:125–211 — any road edit within 48 m of any stop (or a version bump) rebuilds every stop of every line city-wide, with nearestSeg queries per stop.
  - [ALLOC] transit.ts:170–171, 178, 193 — `new Quaternion/Vector3` per stop inside the rebuild loop; L141–149 new arrays per rebuild; L143 `[...children]`.
  - [OBJ] transit.ts:203–209 — one THREE.Line object per transit line (few).
  - [DUP] transit.ts:19–27 — coloredBox ≈ vehicles.ts `model()`/`tagged()` per-vertex colour box builders.
  - [BUG] (inference) transit.ts:163 — platform height interpolates node y linearly by bezier t (`hit[1]`), not by arc length; on curved/ramped tracks the platform may sit off the track height.
- **Superfície pública:** `TransitRenderer` (group, showPaths, update(transit, net, heights, version, dirty)).

#### `src/render/treeMeshes.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Malhas de árvore na carga; 30% de linhas iguais ao 4.0 (DECISIONS 2026-10-30): reescrever; expressão de ângulo que se cancela (L314).
- **Responsabilidades (a-l):** L9–26 TREE_MAT finishes and tone palette; L28–51 PRNG + value noise; L53–61 occlusion helpers; L66–184 Builder (flat triangles, lumpy crown mass, palm frond strip, billboard cards, finish → BufferGeometry with pcol/pext); L186–205 along/trunk/limbs/cards helpers; L208–354 tree species builders (mixed, oak, cypress, palm, shrub, ipê, flowering bush, hedge); L290–322 leaf atlas canvas texture.
- **Achados do leitor (a-l):**
  - [R40COPY] treeMeshes.ts:1, 22, 325 — "Roadcraft's one tree style (`lowPolyTrees.ts`)", ipê from 4.0 lowPolyTrees.ts.
  - [ALLOC] treeMeshes.ts:84, 92, 112–113, 130–137, 157 — Vector3/arrays per triangle/leaf; load-time builders only (not a hot path).
  - [DEAD] treeMeshes.ts:314 — angle expression `s * 0.35 + Math.PI / 2 * 0 + ... - s * 0.35` (terms cancel / multiplied by 0).
  - [BUG] (inference) treeMeshes.ts:94 — `Builder.add` disposes the caller's `geo` argument; harmless today (all callers pass fresh geometries) but surprising.
  - [MAIN] (inference) treeMeshes.ts:208–354 — CPU mesh building with canvas (L292 `document.createElement`) must run on main thread; once at load.
- **Superfície pública:** `TREE_MAT`, `TreeLod`, `mixedTree`, `oakTree`, `cypressTree`, `palmTree`, `shrub`, `ipeTree`, `floweringBush`, `hedge`, `buildLeafAtlas`.
- **Exports nunca importados (b):** `TREE_MAT`, `TreeLod`

#### `src/render/tsl.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Fachada da TSL, fan-in 19; `Node = any` desliga a checagem de tipo de todo shader (L6, L8).
- **Responsabilidades (a-l):** L3–8 untyped TSL alias `T`/`Node`; L14–30 useCompactVertex (snorm16/oct normal decode); L38–47 withPrevious (positionPrevious for TRAA velocity); L53–58 lodFadeMask dither; L62–66 colorOnly MRT.
- **Achados do leitor (a-l):**
  - [NAME] tsl.ts:6, 8 — `Node = any`, `T: Record<string, any>` disables type checking for all shader code project-wide.
- **Superfície pública:** `Node`, `T`, `useCompactVertex`, `withPrevious`, `lodFadeMask`, `colorOnly`.

#### `src/render/vehicles.ts`

- **Veredito: DIVIDIR** → src/render/vehicles/models.ts (construção dos modelos) + src/render/vehicles/fleet.ts (desenho por quadro) + src/render/vehicles/poseInfo.ts (decodificação única)
- **Evidência e regra (coordenador):** 53,2 KB (> 50 KB) com modelos, materiais e frota (L31–391 × L398–848); decodificação dos bits da pose escrita 3 vezes (L695, L715–718, L799–801); pick() varre a frota inteira por clique (L690–698); seta esquerda/direita distinguida pela cor 0xb8741a/0xb8741b (L54–55); warmup sem nearGlass (L845–847).
- **Responsabilidades (a-l):** L23–57 distances, caps, colour codes for lights/glass; L31–50 `model()` box-part builder; L60–108 wheel/puff/blob-shadow geometry; L115–140 tagged/profile helpers; L143–168 person model; L174–251 car body/cabin/mid models from carBody.ts; L254–307 moto/bike models; L310–344 bus/truck models; L346–365 wagon/box parts, KIND_DIMS, modelOf/dimsOf; L371–391 splitGlass; L398–457 Batch (instanced attrs ipos/iinfo/iprev); L468–595 vehicleMaterial (limb swing, wheel roll/steer, exhaust puff, paint palette, lights, occupants mask, blob, LOD dither); L598–619 glass material; L622–624 followMatch; L626–848 VehicleRenderer (batches, pick, vehiclesNear, per-frame interpolate/cull/LOD fill, follow tracking, warmup).
- **Achados do leitor (a-l):**
  - [MIX] vehicles.ts:31–391 vs 398–848 — procedural model building (cars, bus, truck, moto, bike, person, wagon), material shaders and the per-frame fleet renderer in one 53 KB file (> 50 KB); also owns PeopleRenderer (L642, L676–678) and follow-camera tracking (L685–702, L837–842).
  - [DUP] vehicles.ts:31–50 vs 115–128 — `model()` and `tagged()` build the same colour/paint/glow/limb attributes.
  - [DUP] vehicles.ts:715–718 vs 799–801 — pose `info` bit decoding (lights/kind/low/style) written twice; also L695 a third variant.
  - [OMAP] vehicles.ts:690–698 — `pick()` scans every pose of the fleet (r.count) per click instead of the tile grid that vehiclesNear uses (L724–733).
  - [TEXT] vehicles.ts:54–55 — left/right indicator told apart by colour values 0xb8741a vs 0xb8741b (glowOf maps colour → role).
  - [DEV] vehicles.ts:681–682 — `hidePeople` "Measurements: the people are not drawn" flag in product code.
  - [NAME] vehicles.ts:1–4 — header says "Four draw calls for the whole fleet"; there are ~6+3+8+1+5 batches plus glass. L737–738 stale doc comment stacked on `lastNow`. L353, 361 Portuguese words in comments ("truques", "bicicleta").
  - [BUG] (inference) vehicles.ts:845–847 — warmup() pushes into near/nearFar/mid/midCars but not `nearGlass`: the glass material compiles on first use (possible hitch when the first near car appears).
  - [R40COPY] vehicles.ts:171–173, 215–217, 309–316, 340–344 — bodies "as roadcraft 4.0 builds them" (via carBody.ts/heavyBody.ts, ported).
- **Superfície pública:** `bikeModel`, `splitGlass`, `followMatch`, `VehicleRenderer` (group, people, wreckModels, hidePeople, follow, followPose, pick, vehiclesNear, update, warmup).

#### `src/render/velocity.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Câmera anterior para o vetor de movimento; new Matrix4 a cada quadro (L20, conferido).
- **Responsabilidades (a-l):** L14–24 current/previous view-projection uniforms per frame; L33–42 per-object previous world matrix (userData); L44–52 stableVelocity TSL node.
- **Achados do leitor (a-l):**
  - [ALLOC] velocity.ts:20 — `new THREE.Matrix4()` every frame in updateVelocityCamera.
- **Superfície pública:** `updateVelocityCamera`, `previousModelMatrix`, `stableVelocity`.

#### `src/render/weather.ts`

- **Veredito: DIVIDIR** → src/features/sky/weatherSim.ts (alvos, perseguição, tempestade, chão molhado) + src/render/weather.ts (malhas e uniforms)
- **Evidência e regra (coordenador):** Simulação do clima dentro da classe de render (L260–310), com Math.random não semeado (L65, L294–300); estado do clima nos uniforms globais (L16–28).
- **Responsabilidades (a-l):** L15–28 global weather uniforms (clouds, rain, wet, wind, windDir, flash, cloudDrift); L31–36 layerCover noise; L44–58 boltPath midpoint displacement; L63–202 Weather ctor: cloud plane, instanced rain, stars, horizon skirt, bolt ribbon; L205–254 strike / strikeNow / strikeAt; L260–310 weather state machine (targets every 1–3 game hours, chase, wetness); L313–317 sizeRain; L321–323 wetLook.
- **Achados do leitor (a-l):**
  - [MIX] weather.ts:260–310 — the weather simulation (random targets, chase, storm, wet ground) lives in the render class next to its meshes.
  - [BUG] (inference) weather.ts:65, 294–300 — `Math.random` drives weather changes and strikes: not seeded, not saved; the weather after load/replay differs.
  - [HOST] weather.ts:16–28 — global mutable uniforms are the weather state, read/written by other modules (terrain/vehicles import windU, rainU).
  - [ALLOC] weather.ts:221–241 — per strike (event, not per frame): pieces objects, spread arrays `p.set([...L0, ...])`.
  - [NAME] weather.ts:39–40, 182 — stale comments ("40 pieces", "64 pieces") vs BOLT_SEGS 128+192.
- **Superfície pública:** `cloudsU`, `rainU`, `wetU`, `windU`, `windDirU`, `flashU`, `cloudDriftU`, `layerCover`, `CLOUD_Y`, `Weather`, `wetLook`.

#### `src/roads/build.ts`

- **Veredito: DIVIDIR** → src/roads/journal.ts (RoadJournal), snap.ts, alignment.ts (rampa vertical), plan.ts (validação e preço), earthwork.ts (terraplenagem), edits.ts (dividir, unir, mover, duplicar, inverter), roundabout.ts, crossings.ts
- **Evidência e regra (coordenador):** 79,4 KB (> 50 KB), 14 responsabilidades, fan-in 32; planPrice reimplementa a divisão de buildLive (L665–686 × L779–790); teste 'cruza outra via no mesmo nível' escrito 3 vezes (L578–592, L1435–1442, L1480–1484); recusas em português fora do i18n (L563…L1431); escada de upgrade pelos nomes em português (L1509, L1518); `ops.push(...other.ops)` sem limite (L311).
- **Responsabilidades (a-l):** L30–42 Op union; L44–333 RoadJournal (Command: recorded node/seg/profile/zone/junction/name/building/item/terrain ops, value/charge, tidy of names and junction specs to heirs, guard/apply/invert/append); L337–366 snap, segHeightAt; L373–432 heightProfile (smoothing, bridges over water, tunnel grade); L444–518 gradeLine DP + BreakHeap; L530–626 planRoad (junctions, overlap, degree, grade checks); L632–658 overlapsRoad; L665–692 planPrice/arcAtT; L697–730 splitSeg/stillThere/anchorNode; L733–824 buildRoad/buildLive; L832–968 clearAndConform (buildings, items, terrain), underARoad, buildingTop; L973–1082 demolish, profile changes, streetChain, mirrorSymmetric, alongStreet; L1093–1304 roundabout refusal/build/live, conformDisc; L1307–1567 segPreview, roadBetweenJunctions, splitAt, addCrossing, addUTurn, reverseRoad, joinAt, moveNode, bendRoad, upgradeStep, addHeightPoint, duplicateRoad.
- **Achados do leitor (a-l):**
  - [MIX] build.ts:1–1567 — 79 KB (> 50 KB): undo journal, snapping, vertical alignment solver, plan validation, pricing, building, earthwork, demolition, roundabout, and ten other edit tools in one file.
  - [TEXT]/[NAME] build.ts:563–564, 588, 620, 623, 1347, 1349, 1361–1364, 1425, 1431 — player-facing refusal reasons hard-coded in Portuguese (not via `text()`, while L607, 617, 1107–1112, 1418 do use i18n). Journal labels in Portuguese: L733 'construir via', L975, 982, 1036, 1124, 1337, 1350, 1365, 1373, 1385, 1416, 1497, 1527, 1542, 1560.
  - [TEXT] build.ts:1509, 1518 — upgrade ladder found by Portuguese profile display names ('Rua local', 'Avenida'…) matched against PROFILE_INFO[].name.
  - [DUP] build.ts:665–686 vs 779–790 — planPrice re-implements buildLive's adaptive split (MAX_SEG_LEN / 0.4 m / depth 8) to price the same pieces.
  - [DUP] build.ts:1435–1442 vs 1480–1484 vs 578–592 — "crosses another road at its level (<4.5 m)" test written three times.
  - [MAIN] (inference) build.ts:848–852, 906–911 — clearAndConform's `nearest()` scans all centreline points (every 2 m) for every height sample of the road's bounding box: O(samples × length) per edit, e.g. a 1 km diagonal road ≈ 6e4 samples × 500 points; runs synchronously wherever buildRoad is called (no worker here). L881–898 also walks barrier items metre by metre calling stripOfRoad.
  - [BUG] (inference) build.ts:1545–1564 — duplicateRoad builds piece by piece into the live network; if a later `buildRoad` throws (its own guard only reverts that piece), the exception escapes and the earlier pieces stay built with no journal returned (not undoable). `total.invert()` covers only the planRoad failure path.
  - [BUG] (inference) build.ts:311 — `this.ops.push(...other.ops)` spreads arbitrarily many ops as call arguments (RangeError past engine arg limit for very large journals).
  - [DEAD] build.ts:1084–1087 — orphaned doc comment ("Roundabout: cuts the roads…") stacked before roundaboutRefusal's own doc; L1565 `void nc`; L794 `_n` unused param.
  - [LAYER] build.ts:23 — roads imports world/arch.ts (building architecture table) to compute buildingTop L963–966.
  - [R40COPY] build.ts:1221, 1463, 1508, 1523 — behaviour cited from 4.0 files (editor/roundabout.ts, core/bezier.ts, roadTypes.ts, inspector.ts).
- **Superfície pública:** `RoadJournal`, `Anchor`, `snap`, `Fixed`, `heightProfile`, `gradeLine`, `RoadPlan`, `planRoad`, `planPrice`, `buildRoad`, `bulbAt` (re-export), `demolishSeg`, `changeProfile`, `streetChain`, `changeProfiles`, `mirrorSymmetric`, `alongStreet`, `roundaboutRefusal`, `buildRoundabout`, `segPreview`, `closestT` (re-export), `roadBetweenJunctions`, `splitAt`, `addCrossing`, `addUTurn`, `reverseRoad`, `joinAt`, `moveNode`, `bendRoad`, `upgradeStep`, `addHeightPoint`, `duplicateRoad`.

#### `src/roads/control.ts`

- **Veredito: MANTER** → src/roads/control.ts (CTL_NAMES/RULE_NAMES para chaves de i18n)
- **Evidência e regra (coordenador):** Controle dos cruzamentos, fan-in 23; nomes em português fora do i18n (L15, L18); closure pr e lógica de pernas principais escritas duas vezes (L68–71 × L102, L126–128); aloca Map e arrays por nó em effectiveControl (L66–126).
- **Responsabilidades (a-l):** L9–18 control kinds (Ctl), rule kinds (Rule) and their display names; L20–40 JunctionSpec/Control types; L44–61 flow thresholds + `warrantedControl` hysteresis; L63–72 `mainLegs`; L74–142 `effectiveControl` (auto resolution, ring, rail crossing, priority legs, manual legs); L144–167 geometry helpers (throughPair, mostOpposite, dirOut); L169–175 `banned`; L177–199 `signalStages`; L201–227 `remapSpec` (spec rewrite on segment split/removal)
- **Achados do leitor (a-l):**
  - [TEXT] control.ts:15,18 — `CTL_NAMES`/`RULE_NAMES` are hard-coded Portuguese player-facing labels outside `engine.*.ts` (translated only through legacy.ts phrase table L157–159).
  - [ALLOC] control.ts:66,80,81,84,107,111,126 — `effectiveControl`/`mainLegs` allocate a slice, a `Map`, filtered/sorted arrays and closures per call; called per node in `RoadNetwork.gather` (network.ts:370) for every worker job and by signRule; not per frame (inference), but per edit/cell rebuild.
  - [OBJ] control.ts:20–38 — JunctionSpec is a JS object per player-configured junction (kept in `Map` network.ts:66) with nested tuple arrays; sparse (only manually set nodes), so bounded by player edits.
  - [ALLOC] control.ts:161–166 — `dirOut` returns a new tuple per call; used in loops (mostOpposite O(n²), impossible.ts:65).
  - [DUP] control.ts:68,102 — `pr` closure defined twice (mainLegs and effectiveControl), and "most opposite / main legs" logic L69–71 duplicated at L126–128.
- **Superfície pública:** `Ctl`, `isMidCrossing`, `isMidNode`, `CTL_NAMES`, `Rule`, `RULE_NAMES`, `JunctionSpec`, `Control`, `Flow`, `FLOW`, `warrantedControl`, `mainLegs`, `effectiveControl`, `dirOut`, `banned`, `signalStages`, `remapSpec` — junction control rules for page, paint, sim.

#### `src/roads/dash.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Tracejado das faixas; uma responsabilidade.
- **Responsabilidades (a-l):** L1–13 dash constants and graph interface; L15–48 `dashPhases` BFS over a graph propagating dash phase per segment
- **Achados do leitor (a-l):**
  - (inference) [OMAP] dash.ts:30 — BFS covers whatever graph is passed; if called with a whole-network graph per edit it walks the map; caller not visible here.
  - [ALLOC] dash.ts:21–29,45 — 6 typed arrays allocated per call (fine for a per-job function).
- **Superfície pública:** `DASH_PERIOD`, `DASH_STEPS`, `DashGraph`, `dashPhases` — continuous dash phase for the road shader.
- **Exports nunca importados (b):** `DashGraph`

#### `src/roads/economy.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Preço das vias; KIND_MASK (bits 4–6) separado dos outros bits de flags.ts (L17).
- **Responsabilidades (a-l):** L13–21 build kind enum and flag bit packing; L23–35 price per metre and build kind from heights; L37–44 dominant kind; L46–57 price and charge/refund
- **Achados do leitor (a-l):**
  - [SMALL]-ish pure module; `KIND_MASK` (bits 4–6) coexists with SegFlag bits in flags.ts (Ring=1, Furn bits 1–2, Wall=8, Free=128): bit layout split across two files (flags.ts:1–15 vs economy.ts:17–18).
  - [LAYER] economy.ts:7 — imports `../config.ts` (root) — allowed root.
- **Superfície pública:** `BuildKind`, `BUILD_KIND_KEYS`, `KIND_SHIFT`, `KIND_MASK`, `kindOfFlags`, `withKind`, `pricePerMetre`, `buildKindAt`, `dominantKind`, `structureFactor`, `segmentPrice`, `chargeFor`.

#### `src/roads/flags.ts`

- **Veredito: JUNTAR** → src/roads/flags.ts com KIND_MASK de economy.ts: uma tabela dos 8 bits do segmento
- **Evidência e regra (coordenador):** Os bits do campo flags estão divididos entre flags.ts:5 e economy.ts:17 sem tabela única.
- **Responsabilidades (a-l):** L1–15 segment flag bits and `furnOf`
- **Achados do leitor (a-l):**
  - [SMALL] flags.ts — one const + one function; re-exported by network.ts:18.
  - [DUP] flags.ts:5 vs economy.ts:17 — flag bit map split across files (Furn bits 1–2 here, kind bits 4–6 in economy.ts); no single table of the 8 bits.
- **Superfície pública:** `SegFlag`, `furnOf`.

#### `src/roads/geometry.ts`

- **Veredito: MANTER** → src/roads/geometry.ts (comentários em inglês)
- **Evidência e regra (coordenador):** Geometria de Bézier, fan-in 29; comentários em português (L1…L176); `[best - step, best + step]` alocado 12× por closestT (L84); dois algoritmos de recuo de esquina (armRetreats L139–174 × junction.ts:52–59).
- **Responsabilidades (a-l):** L5–17 quadratic Bézier eval/derivative; L19–52 length and arc table, t at length; L54–70 split/sub-curve; L72–92 closest point; L94–129 curve/segment/line intersections; L131–179 arm retreats and arm angle
- **Achados do leitor (a-l):**
  - [NAME] geometry.ts:1–3,13,31,43,54,65,72,94,111,123,131,135–137,144,150,160–161,176 — comments in Portuguese (project rule: everything written in English).
  - [ALLOC] geometry.ts:84 — `for (const t of [best - step, best + step])` allocates an array 12× per `closestT` call; closestT is used in per-query loops (network.ts:302, junction.ts:148, ground.ts:21, repair.ts:29).
  - [ALLOC] geometry.ts:91,96–97,105 — `closestT` returns a tuple; `intersectQuads` allocates two Float64Arrays + result array per call.
  - [DUP] geometry.ts:139–174 `armRetreats` (n≥3 branch) vs junction.ts:52–59 `cornerFillet` path — two corner-setback algorithms; junction.ts only uses `armRetreats` for n===2 (junction.ts:48), so geometry.ts:158–173 n≥3 branch may be [DEAD] (inference; other callers not visible).
  - [R40COPY] geometry.ts:150–153 — cites roadcraft `junction/transition.ts` values (9.6 m, 1:8) — port of values, not code.
- **Superfície pública:** `Quad`, `bez`, `bezD`, `bezLength`, `arcTable`, `tAtLength`, `splitQuad`, `subQuad`, `closestT`, `intersectQuads`, `segSeg`, `lineLine`, `Arm`, `armRetreats`, `armAngle`.

#### `src/roads/ground.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Altura do chão junto à via.
- **Responsabilidades (a-l):** L12–15 RoadGround enum and scratch; L17–32 strip kind of a profile at a point; L34–45 road ground at a point via spatial query
- **Achados do leitor (a-l):**
  - [ALLOC] ground.ts:21,38 — `closestT` tuple + closure per call; per placed item (inference: not per frame).
  - [TEXT] ground.ts:29 — strip classification by string kind `'sidewalk' | 'curb'` (StripKind union, typed, acceptable).
- **Superfície pública:** `RoadGround`, `stripOfRoad`, `roadGroundAt`.

#### `src/roads/impossible.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Nós impossíveis; cópia própria das pontas dos segmentos (segA/segB, L16–17) porque o op remSeg só traz o id.
- **Responsabilidades (a-l):** L9–10 MIN_LEG_ANGLE; L12–75 `ImpossibleNodes` class: incremental set of nodes with legs under 25°, fed by network listener ops
- **Achados do leitor (a-l):**
  - [HOST] impossible.ts:16–17 — second copy of segment ends (`segA/segB`) kept because remSeg op carries only the id; duplicates `net.segs.cols.a/b` state.
  - [ALLOC] impossible.ts:65 — `segsOf(n, [])`, `.map` with tuple-returning `dirOut`, `.sort` per check.
  - (inference) impossible.ts:34–39 — on 'addSeg' the angle uses `dirOut` (segment control point); a later control-point-only change arrives as remSeg+addSeg, so it is re-checked. No defect found.
- **Superfície pública:** `MIN_LEG_ANGLE`, `ImpossibleNodes` (count, angleAt, version, check).

#### `src/roads/junction.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Geometria dos cruzamentos; bulbCache descartado a cada edição de qualquer ponto do mapa (L122–123: net.version muda em toda operação).
- **Responsabilidades (a-l):** L8–17 `armOf` arm of a segment end; L19–34 turning bulb constants and setback; L36–60 `junctionRetreats` per-arm setback ordering; L62–109 `cornerFillet` (fillet/bevel/taper corner); L111–152 `bulbAt` with WeakMap cache and `bulbClear` spatial query
- **Achados do leitor (a-l):**
  - [ALLOC] junction.ts:9–17,86,95,102,108 — `armOf` and `cornerFillet` return new objects per call (cornerFillet allocates `none` even when not returned, L86).
  - [ALLOC] junction.ts:48 — `order.map(...)` array per 2-arm node.
  - [OMAP] junction.ts:122–123 — `bulbCache` is discarded on every network edit (`net.version` bumps on every op, network.ts:202), so every edit invalidates all cached bulbs map-wide; recomputation is lazy per asked node, so cost is per query, not per map (OK), but the Map grows with nodes asked between edits.
  - [ALLOC] junction.ts:137,148 — `segsOf(n, [])`, `net.quad(s)` without out, and `closestT` tuples per bulb check (cached per network version).
  - [R40COPY] junction.ts:21,52,65,78–84 — values ported from 4.0 `junction/bulb.ts`, `trim.ts`, `corners.ts` (cited, reimplemented).
- **Superfície pública:** `armOf`, `BULB_R`, `BULB_WALK`, `NODE_BULB`, `bulbRetreat`, `junctionRetreats`, `CURB_R_MAX`, `Corner`, `cornerFillet`, `bulbAt`.

#### `src/roads/kerb.ts`

- **Veredito: DIVIDIR** → paradas de ônibus → src/features/transit/stops.ts; alturas da borda → src/roads/kerb.ts
- **Evidência e regra (coordenador):** Duas coisas diferentes no arquivo (L13–30 paradas, L32–47 alturas).
- **Responsabilidades (a-l):** L13–30 `stopSpot` (bus stop waiting place beside a road); L32–47 footway rise constants and `edgeRise`
- **Achados do leitor (a-l):**
  - [MIX] kerb.ts:13–30 vs 32–47 — bus stop placement and terrain/road edge heights in one file (both "road edge" but different features: transit vs terrain conform).
  - [R40COPY] kerb.ts:3–6,32 — quotes 4.0 `world/elevation.ts` comment text and FOOTWAY_RISE value.
- **Superfície pública:** `stopSpot`, `FOOTWAY_RISE`, `UNDER_DROP`, `BESIDE_DROP`, `edgeRise`.

#### `src/roads/laneLinks.ts`

- **Veredito: MANTER** → src/roads/laneLinks.ts (comentários em inglês)
- **Evidência e regra (coordenador):** Ligações de faixa; comentários em português; importa RoadNetwork enquanto control/junction usam NetworkView (L8).
- **Responsabilidades (a-l):** L10–14 lanes per direction; L16–23 default turn arrows; L25–30 turn bit from headings; L32–38 manual exits lookup; L40–48 arms of a node; L50–80 `laneExits`; L82–89 `arrowCode`
- **Achados do leitor (a-l):**
  - [NAME] laneLinks.ts:1–3,10,16,25,32,40,50–52,82 — comments in Portuguese.
  - [OBJ]/[ALLOC] laneLinks.ts:41–47,54–79 — `armsOf` returns one object per arm; `laneExits` returns arrays of objects with tuple arrays per lane; `arrowCode` (L83) calls `laneExits` and `.reduce` per segment end; called per road end in mesh/paint work (inference).
  - [LAYER] laneLinks.ts:8 — imports `RoadNetwork` type from network.ts while control/junction use `NetworkView` (networkView.ts:1) to avoid the cycle; inconsistent.
- **Superfície pública:** `lanesIn`, `defaultTurns`, `turnBit`, `customExits`, `armsOf`, `laneExits`, `arrowCode`.

#### `src/roads/markings.ts`

- **Veredito: APAGAR** → — (ou ligar ao mesh das vias, se o 4.0 desenha essas legendas: estudar antes)
- **Evidência e regra (coordenador):** Ninguém do jogo importa (só test/markings.test.ts, conferido no inventário) e 9 exports mortos: código de produção sem uso; 28% igual ao 4.0 (DECISIONS 2026-10-30). Se as legendas pintadas existem no 4.0, o certo é ligá-las ao jobs/roadMesh.ts; senão apagar.
- **Responsabilidades (a-l):** L7–39 regional marking styles; L41–67 stroked glyphs and yield symbol; L69–103 word strokes and legend layout; L105–110 bus word stations; L112–118 mini-roundabout island; L120–132 parking bay stations
- **Achados do leitor (a-l):**
  - [TEXT] markings.ts:29–35 — painted legends ('ÔNIBUS', 'PARE', 'BUS', 'STOP') chosen by regional style, not language; glyphs exist only for those letters (L48–61) — any other text silently renders nothing (L74 `?? []`).
  - [ALLOC] markings.ts:25–37 — `markingStyle` returns a new object with new closures per call; `wordStrokes` (L70) rebuilt per legend call (L93) — per legend per job (inference).
  - [R40COPY] markings.ts:1–5,120 — ports values from 4.0 `markingStyle.ts`, `parkingLayout.ts`.
- **Superfície pública:** `MarkingStyleId`, `PAINT_YELLOW`, `PAINT_WHITE`, `MarkingStyle`, `markingStyle`, `isMarkingStyle`, `GLYPHS`, `YIELD_SYMBOL`, `wordStrokes`, `LEGEND_STROKE`, `LEGEND_GAP`, `legendStrokes`, `busWordStations`, `miniIsland`, `PARKING`, `parkingBays`.
- **Exports nunca importados (b):** `MarkingStyleId`, `PAINT_YELLOW`, `PAINT_WHITE`, `MarkingStyle`, `isMarkingStyle` (nem no arquivo), `GLYPHS`, `YIELD_SYMBOL`, `LEGEND_STROKE` (nem no arquivo), `LEGEND_GAP`

#### `src/roads/network.ts`

- **Veredito: MANTER** → src/roads/network.ts (gather → src/roads/gather.ts)
- **Evidência e regra (coordenador):** Dono da rede, fan-in 27; gather mistura serialização para worker com derivação de controle (L330–386). Os junctions vão no meta do save (game.ts:1957), a alegação de que não são gravados não procede.
- **Responsabilidades (a-l):** L11–29 constants and SoA schemas; L31–47 NetOp/NodeRec/SegRec; L54–86 RoadNetwork tables, indexes, adjacency, `quad`; L88–198 edits (addNode/removeNode/addSeg/removeSeg/setFlow/setJunction/setProfile/setZone, records); L200–227 version/emit, adjacency link/unlink, segsOf; L229–281 dirty-cell marking; L283–324 spatial queries; L326–386 `gather` (worker RoadGraph incl. control/bulb/joint); L388–420 per-tile save/load; L422–433 clear
- **Achados do leitor (a-l):**
  - [OBJ] network.ts:66–68 — `junctions: Map<number, JunctionSpec>` (object per configured junction) and `flow: Map<number, number>` (per automatic junction switched by the sim) — not SoA.
  - [ALLOC] network.ts:101,138,202 — one NetOp object + rec object per edit emitted to listeners (per edit, acceptable); `removeSeg` (L144) and `segRec` allocate rec.
  - [ALLOC] network.ts:298,302 — `nearestSeg` allocates a Quad, closure and tuples per call (used by hover/sign/address tools, possibly per pointer move — inference).
  - [ALLOC] network.ts:332–356 — `gather` allocates 2 Maps, Set, arrays, closures and 18 typed arrays per job (per cell job; fine) and calls `effectiveControl` per node (control.ts allocations).
  - [MIX] network.ts:330–386 — network store also computes worker-facing control/bulb/joint derivations (imports control.ts and junction.ts, L49–50); `gather` mixes serialization with junction rule evaluation.
  - [BUG] network.ts:389–404 — `saveTile` writes only nodes and segments; `junctions` (player control specs) and street names are not in `RoadSave` (worker.ts:116); (inference) they must be saved elsewhere or are lost on reload — verify in save code.
  - [BUG] network.ts:403 — node/segment ids and `flags` written into Float32Array: ids exact only up to 2^24 (16.7 M) — fine at current scale; `profile` Uint16 fine.
  - [NAME] network.ts:18–20,48–50 — imports scattered mid-file between declarations.
  - [ALLOC] network.ts:415–419 — `cellsOfTile` array per save tile.
- **Superfície pública:** `MAX_DEG`, `MAX_SEG_LEN`, `SegFlag` (re-export), `nodeSchema`, `segSchema`, `CellToucher`, `NetOp`, `NodeRec`, `SegRec`, `Zone` (re-export), `RoadNetwork`.

#### `src/roads/networkView.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Interface mínima para quebrar ciclo; repete os campos de JunctionSpec à mão (L5–11).
- **Responsabilidades (a-l):** L4–11 `JunctionLike`; L13–34 `NetworkView` read interface (breaks network ↔ control/junction cycle)
- **Achados do leitor (a-l):**
  - [DUP] networkView.ts:5–11 — repeats the JunctionSpec fields (control.ts:20–38) by hand; drift risk.
- **Superfície pública:** `JunctionLike`, `NetworkView`.
- **Exports nunca importados (b):** `JunctionLike`

#### `src/roads/profiles.ts`

- **Veredito: DIVIDIR** → src/roads/profiles/catalog.ts (dados), registry.ts (registro e ids), rules.ts (validação e larguras), gpuTable.ts
- **Evidência e regra (coordenador):** Catálogo, registro, regras, geometria, custo e tabela da GPU juntos, fan-in 67; nomes em português usados como identidade (L124–189); STRIP_WIDTH (L296–298) e STEP_LIMITS de profileWork.ts:101–103 discordam (canteiro 0,3 × 1; acostamento 0,5 × 1; conferido); registerProfile sobrescreve byKey de um perfil embutido (L241–244).
- **Responsabilidades (a-l):** L8–87 strip/profile types and enums; L89–121 strip builders; L122–190 built-in profile catalogue (36 roads/rails); L192–206 tag packing and table constants; L208–248 registry (byKey dedup, register, listeners); L250–267 `withParking`; L269–290 custom profile save/restore; L292–346 profile validation (`profileIssueSpots`); L348–401 `derive` (edges, lines, lanes, walk, cost); L403–407 registration and helpers; L409–445 shader table row
- **Achados do leitor (a-l):**
  - [MIX] profiles.ts — catalogue data, registry, validation rules, derived geometry, economy cost and the GPU table layout in one 446-line file.
  - [TEXT]/[NAME] profiles.ts:124–189 — profile `name`s are Portuguese player-facing strings used as identity (roadVariant.ts:110–117 looks profiles up by these names; legacy.ts:114–125 translates them by string match); L17 `Category` values are Portuguese identifiers ('ruas', 'avenidas', ...).
  - [TEXT] profiles.ts:266 — `withParking` builds the name with Portuguese suffix `(vagas ajustadas)` and strips it by regex; legacy.ts:277 translates it by regex.
  - [BUG] profiles.ts:241–244,275–278 — `registerProfile(def, fixedId)` overwrites `byKey[key]` even when the key already maps to a built-in; `setCustomProfiles` then deletes that key (L277), so a custom profile identical in section to a built-in removes the built-in's dedup entry; later `registerProfile` of that built-in section creates a duplicate id (concrete: save with a custom equal to 'Rua local' then reload).
  - [BUG] profiles.ts:283 — vacant ids get copies of profile 0 without `byKey` entry or `custom` flag; `customProfiles()` (L270) skips them, so a later save renumbers nothing but leaves holes that are filled with local streets — segments referencing a deleted custom id silently become 'Rua local' (inference on save path).
  - [DUP] profiles.ts:296–298 `STRIP_WIDTH` vs profileWork.ts:101–103 `STEP_LIMITS` — two width-limit tables that disagree (median 0.3 vs 1, shoulder 0.5 vs 1, barrier 0.3–1.2 vs fixed).
  - [ALLOC] profiles.ts:220–221 — `profileKey` JSON.stringify per register (not hot).
  - [R40COPY] profiles.ts:292,295,311 — cites 4.0 `profile.ts` / `profileEditor.ts` for rules.
- **Superfície pública:** `StripKind`, `TurnBit`, `Surface`, `Paving`, `Centre`, `Category`, `Strip`, `Line`, `LineColor`, `MarkLine`, `Profile`, `LaneInfo`, `ProfileInfo`, `RING_PROFILE`, `MAX_PROFILES`, `TAG_RULE`, `packRoadTag`, `unpackRoadTag`, `MAX_LINES`, `BUILTIN_COUNT`, `PROFILES`, `PROFILE_INFO`, `profileRevision`, `onProfileAdded`, `profileKey`, `normalize`, `registerProfile`, `withParking`, `customProfiles`, `setCustomProfiles`, `profileCount`, `ProfileIssue`, `STRIP_WIDTH`, `profileIssues`, `profileIssueSpots`, `halfWidth`, `isAsphalt`, `TABLE_W`, `writeProfileRow`.

#### `src/roads/profileWork.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Rascunho do editor de perfil; limites de largura divergentes de profiles.ts (L101–103).
- **Responsabilidades (a-l):** L8–28 editor model conversion (strip lists without kerbs ↔ profile); L30–46 palette new strip; L48–82 insertion index; L84–98 width change and move; L100–103 step limits
- **Achados do leitor (a-l):**
  - [DUP] profileWork.ts:101–103 vs profiles.ts:296–298 — divergent width limits (see profiles.ts).
  - [R40COPY] profileWork.ts:1,30,33,48,84,91,100 — cites 4.0 `profileEditor.ts` line ranges (values/behaviour, reimplemented).
- **Superfície pública:** `toWork`, `fromWork`, `PaletteKind`, `newStrip`, `insertionIndex`, `withStripWidth`, `movedStrip`, `STEP_LIMITS`.

#### `src/roads/repair.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Reparo de mapas antigos na carga.
- **Responsabilidades (a-l):** L11–54 `repairDanglingEnds`: on map load, joins deg-1 nodes lying inside another road via the journal
- **Achados do leitor (a-l):**
  - [LAYER] repair.ts:6 — `roads` imports `World` type from `world/world.ts` (and `RoadJournal` from build.ts which needs World); (inference) roads ↔ world cycle at type level.
  - [OMAP] repair.ts:18 — loops all nodes once at load (`net.nodes.end`); documented load-only (L3–4), each end with one rectangle query: acceptable.
  - [TEXT] repair.ts:20 — journal label 'reparar mapa' in Portuguese.
  - [ALLOC] repair.ts:29,39 — `net.quad(s)` without `out` allocates a Quad per candidate.
- **Superfície pública:** `repairDanglingEnds`.

#### `src/roads/roadVariant.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Variações de via; cartões por nome em português (L110–117).
- **Responsabilidades (a-l):** L8–20 option types/presets; L22–37 split strips into parts; L39–77 `variantOf` (lanes/median/parking); L79–94 `withTotalWidth`; L96–106 lane count and `registerVariant`; L108–118 road classes for the Upgrade tool
- **Achados do leitor (a-l):**
  - [TEXT] roadVariant.ts:110–117 — road class cards found by matching Portuguese profile names (`p?.name === 'Rua local'`), coupling to profiles.ts:124–176 labels; renaming a built-in breaks the Upgrade cards silently.
  - [BUG] roadVariant.ts:56 — one-way with `o.lanes === 2` yields `n = max(1, 1) = 1` lane; lanes 4 → 2, 6 → 3: one-way road halved (may be intended as "both ways together", per L14 comment "one-way: all of them" says all lanes go one way → 2 should mean 2 lanes). Comment and code disagree.
  - [R40COPY] roadVariant.ts:1–3,64,80,108 — cites 4.0 files/line ranges.
- **Superfície pública:** `LaneChoice`, `LANE_CHOICES`, `PARKING_PRESETS`, `ParkingPreset`, `RoadOptions`, `variantOf`, `withTotalWidth`, `laneCount`, `registerVariant`, `ROAD_CLASSES`, `roadClasses`.
- **Exports nunca importados (b):** `ROAD_CLASSES`

#### `src/roads/signRule.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Placas de regra; recusa em português com chave inglesa equivalente já existente (L39 × engine.en.ts:536); números de placa copiados de jobs/props.ts SIGN (L11).
- **Responsabilidades (a-l):** L10–13 sign constants; L15–25 `signArm` (junction arm of a sign position); L27–52 `signRuleCommand` (sign ↔ junction rule as one command)
- **Achados do leitor (a-l):**
  - [TEXT] signRule.ts:39 — Portuguese refusal message returned as a string; an English key 'refuse.sign.noRule' exists (engine.en.ts:536) with the same text — duplicate path (inference: caller passes this through `loose()` or not at all).
  - [TEXT] signRule.ts:48 — command labels in Portuguese.
  - [TEXT] signRule.ts:11 — sign variant numbers mirror `jobs/props.ts SIGN` by hand (magic numbers shared across files).
  - [BUG] signRule.ts:44–46 — when the last rule sign is removed (`legs` empty) and `before.ctl` is Auto or Priority, `after` becomes `null`, dropping any other fields of `before` (bans, lanes, end, fixed/greens): removing a Stop sign at a junction with banned movements or custom lane links erases them (undo restores).
  - [LAYER] signRule.ts:6 — imports `World` type from world layer.
- **Superfície pública:** `SIGN_STOP`, `SIGN_YIELD`, `SIGN_REACH`, `signArm`, `signRuleCommand`.

#### `src/roads/streetNames.ts`

- **Veredito: MOVER** → src/features/roads/streetNames.ts (nomes gerados por chave de i18n)
- **Evidência e regra (coordenador):** Nomes gerados em português fixos (L16–38); caminhada de rua própria e a de build.ts unidas (L53–95, L112).
- **Responsabilidades (a-l):** L16–47 generated name lists and hash naming; L49–95 `streetOf` (walk the street chain and key it); L97–104 `streetName`; L106–120 `nameStreetCommand`; L122–150 `addressAt` (metric house number)
- **Achados do leitor (a-l):**
  - [TEXT] streetNames.ts:16–38 — Portuguese player-facing names and prefixes ('Rua', 'Avenida', 'Rodovia', 'Ferrovia') hard-coded, not localized.
  - [DUP] streetNames.ts:53–95 — own street-chain walk; L112 also calls `streetChain` from build.ts and unions both (comment L3 says it uses build.ts streetChain's rule) — two implementations of "the street".
  - [ALLOC] streetNames.ts:56–94 — Set, closures, tuple arrays per `streetOf`; `addressAt` (L128) calls it per query, plus `[q.x0,q.z0]` arrays L143; if used on hover per frame, per-frame allocation and walk of up to 4000 segments (inference).
  - [DEAD] streetNames.ts:141 — `void t;` unused destructured value.
  - [OBJ] streetNames.ts:99,117 — `world.streetNames` Map per named segment (player-typed only; sparse).
  - [LAYER] streetNames.ts:9–10 — imports `World` type and `build.ts`.
  - [TEXT] streetNames.ts:116 — Portuguese command label.
- **Superfície pública:** `Street`, `streetOf`, `streetName`, `nameStreetCommand`, `Address`, `addressAt`.
- **Exports nunca importados (b):** `Street`, `Address`

#### `src/roads/tuning.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Números de ajuste; demolitionRefund 0.25 (L13) enquanto o texto do jogador diz 'devolve metade' (legacy.ts:22, :226; conferido).
- **Responsabilidades (a-l):** L4–25 road economy tuning; L27–35 tunnel geometry constants with sources
- **Achados do leitor (a-l):**
  - [SMALL] tuning.ts — data only; used by economy.ts:9 and profiles.ts:6.
- **Superfície pública:** `ROAD_TUNING`, `TUNNEL`.

#### `src/roads/zones.ts`

- **Veredito: MOVER** → src/features/zones/zones.ts
- **Evidência e regra (coordenador):** Zoneamento é recurso; fan-in 35; ZONE_NAMES em português duplica zone.name.* do i18n (L3).
- **Responsabilidades (a-l):** L1–10 zone enum, names, colours, base zone and density
- **Achados do leitor (a-l):**
  - [NAME] zones.ts:1,5,8 — comments in Portuguese.
  - [TEXT]/[DUP] zones.ts:3 — `ZONE_NAMES` Portuguese labels duplicated by i18n keys `zone.name.0..8` (engine.en.ts:137–145, engine.pt-BR.ts:137–145).
  - [MIX]/[LAYER] zones.ts — zoning lives in `roads/` (zones are segment sides) rather than a zones folder.
  - [SMALL] zones.ts — re-exported by network.ts:48.
- **Superfície pública:** `Zone`, `ZONE_NAMES`, `ZONE_COLORS`, `baseZone`, `zoneDensity`.

#### `src/shared/contracts/bomb.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Contrato compartilhado da bomba.
- **Responsabilidades (a-l):** L4–15 bomb force start, step and radius
- **Achados do leitor (a-l):**
  - [SMALL] bomb.ts — three tiny pure items; shared by UI and demolition (L2).
  - [R40COPY] bomb.ts:1–2 — cites 4.0 shell/actionsWiring line numbers (values).
- **Superfície pública:** `BOMB_START`, `bombStep`, `bombRadius`.

#### `src/shared/contracts/people.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Contrato das pessoas; DEFAULT_PERSON_OPTIONS exportado sem congelar (L25).
- **Responsabilidades (a-l):** L4–27 person creator option types and defaults
- **Achados do leitor (a-l):**
  - [SMALL] people.ts — types + one default object.
  - [BUG] people.ts:25 — `DEFAULT_PERSON_OPTIONS` is a non-frozen exported object; any caller assigning fields into it mutates the default for everyone (inference: depends on callers).
- **Superfície pública:** `CreatorMode`, `CreatorHold`, `PersonOptions`, `DEFAULT_PERSON_OPTIONS`.

#### `src/shared/contracts/poses.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Buffers de pose; um subarray por registro publicado no passo da simulação (L77).
- **Responsabilidades (a-l):** L6–23 pose layout and tile grid constants; L25–50 SharedArrayBuffer layout and views; L52–79 tile origin and counting sort by tile; L81–106 `PoseWriter`; L108–129 `PoseReader`
- **Achados do leitor (a-l):**
  - [ALLOC] poses.ts:77 — `src.subarray(...)` creates a view object per record per publication (up to 131,072 per sim tick) in the sim hot path; a copy loop over the stride avoids it.
  - [ALLOC] poses.ts:73 — `cell.subarray(n, n + TILES)` one view per call (minor).
- **Superfície pública:** `POSE_STRIDE`, `MAX_AGENTS`, `TILE`, `TILE_GRID`, `TILES`, `PoseBuffers`, `createPoseBuffers`, `viewPoseBuffers`, `tileOrigin`, `sortByTile`, `PoseWriter`, `PoseReader`.
- **Exports nunca importados (b):** `PoseBuffers`

#### `src/shared/contracts/worker.ts`

- **Veredito: MANTER** → src/shared/contracts/worker.ts (tipo Profile movido para shared)
- **Evidência e regra (coordenador):** Registro central dos trabalhos; importa tipo de roads/profiles.ts (L3: vazamento shared→roads medido); trabalho 'debugTile' no contrato de produção (L76, L97).
- **Responsabilidades (a-l):** L5–11 shared world buffers; L13–53 building columns; L55–72 packed mesh; L74–113 job payload/result maps; L115–120 road save records; L122–129 worker messages; L131–154 box column helpers; L156–190 lots/props/mesh transfer; L192–220 RoadGraph and transfer
- **Achados do leitor (a-l):**
  - [LAYER] worker.ts:3 — `shared` imports type `Profile` from `roads/profiles.ts` (shared depending on a feature layer).
  - [DEV] worker.ts:76,97 — `debugTile` job kind in the production contract; worker.ts:18 mentions "the old worst-case loader" (zone 0 boxes).
  - [NAME] worker.ts:13–14 — two stacked doc comments for `BoxColumns` (the first one stale).
  - [MIX] worker.ts — one contract file for every job kind (terrain, buildings, roads, lots, props, save) — central registry by design.
  - [BUG] worker.ts:116 — `RoadSave` stores ids in Float32Array (see network.ts:403); and holds no junction specs (inference: saved elsewhere).
- **Superfície pública:** `SharedWorld`, `BoxColumns`, `SHAPE_MAX`, `SHAPE_STRIDE`, `SHAPE_SCALE`, `PackedMesh`, `JobPayloads`, `JobResults`, `JobKind`, `RoadSave`, `NODE_REC`, `SEG_REC`, `SEG_REC_V2`, `ToWorker`, `FromWorker`, `boxTransfer`, `boxColumnList`, `columnStride`, `emptyBoxes`, `LotColumns`, `lotTransfer`, `PropColumns`, `propTransfer`, `meshTransfer`, `RoadGraph`, `roadGraphTransfer`.

#### `src/shared/errors.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Uma função usada por game.ts e saveFiles (fan-in 2); objeto sem message vira '[object Object]' (L2).
- **Responsabilidades (a-l):** L1–2 `errorText`
- **Achados do leitor (a-l):**
  - [SMALL] errors.ts — one function; callers not visible.
  - [BUG] errors.ts:2 — `(err as Error)?.message ?? String(err)`: for a non-Error object with no `message` returns `undefined ?? String(err)` → '[object Object]' (minor).
- **Superfície pública:** `errorText`.

#### `src/shared/i18n/index.ts`

- **Veredito: DIVIDIR** → src/shared/i18n/index.ts (t, has, formatos) + src/ui/i18nDom.ts (followLanguage, MutationObserver)
- **Evidência e regra (coordenador):** Andador de DOM em shared (L99–139); importa data/textos-roadcraft fora de src (L7–8); has() olha só o idioma atual enquanto t() cai no pt-BR (L59, L65); fmtDec cria Intl.NumberFormat por chamada (L82).
- **Responsabilidades (a-l):** L13–35 language list, tables, stored language; L37–55 init/set + listeners; L57–91 `t`, `has`, `plural`, number/money formats; L93–97 legacy phrase translation; L99–139 `followLanguage` DOM translation via MutationObserver; L141–149 touch wording
- **Achados do leitor (a-l):**
  - [LAYER] index.ts:7–8 — `shared` imports `data/textos-roadcraft/*.ts` (outside src).
  - [MIX] index.ts:99–139 — DOM walker/MutationObserver (UI concern) in `shared`.
  - [TEXT] index.ts:94,103–138 — translation by matching Portuguese source phrases (`loose`, `followLanguage`) instead of keys; documented as transitional (L5).
  - [ALLOC] index.ts:82 — `fmtDec` creates an `Intl.NumberFormat` per call (expensive); if used per frame by HUD, a hot allocation (inference). `fmtInt` caches (L72–77), `fmtDec` does not.
  - [BUG] index.ts:65 — `has(key)` checks only the current language table, while `t` falls back to pt-BR (L59): `has` false yet `t` returns text.
  - [BUG] index.ts:132,133 — `followLanguage` registers a listener and a MutationObserver per call, never removed: leak if called for elements that are recreated.
  - [OLD] index.ts:17 — `OLD_KEY 'cidade.idioma'` legacy storage key migration.
- **Superfície pública:** `Lang`, `LANGUAGES`, `storedLang`, `initLang`, `lang`, `onLanguageChange`, `setLang`, `t`, `has`, `plural`, `fmtInt`, `fmtDec`, `fmtCount`, `money`, `loose`, `translate`, `followLanguage`, `isTouch`, `forTouch`.

#### `src/shared/i18n/lang/engine.en.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Dicionário inglês (arquivo nomeado no CLAUDE.md); save.* e game.toast.* repetem mensagens (L313–339 × L429–459).
- **Responsabilidades (a-l):** L2–540 English strings for engine-only keys (ui, insp, road, save, game toasts/hints, tools, refuse, keys)
- **Achados do leitor (a-l):**
  - [DUP] engine.en.ts:313–339 vs 429–459 — `save.*` and `game.toast.*` duplicate the same messages (e.g. save.auto/game.toast.autosaved, save.done/game.toast.saved, save.loaded/game.toast.loaded, save.exportNothing/game.toast.exportNothing, save.repaired.*/game.toast.repaired.*).
  - [DUP] engine.en.ts:175–190 `hint.tool.*` vs 341–378 `game.hint.*` — same hints twice with slightly different wording.
  - [DEV] engine.en.ts:48,349–350,427–428,451 — "worst case (test)" / test city entries in the player menu; 480 'Recent changes to the world (developer)' key in the player key table.
  - [DUP] engine.en.ts:137–145 — zone names duplicate zones.ts:3.
- **Superfície pública:** `ENGINE_EN`.

#### `src/shared/i18n/lang/engine.pt-BR.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Dicionário português (nomeado no CLAUDE.md); mesmas duplicações.
- **Responsabilidades (a-l):** L2–540 Portuguese strings, same keys as engine.en.ts
- **Achados do leitor (a-l):**
  - [DUP]/[DEV] same duplicates and test/developer entries as engine.en.ts (L313–339 vs 429–459; L48, 349–350, 480).
- **Superfície pública:** `ENGINE_PT`.

#### `src/shared/i18n/lang/legacy.ts`

- **Veredito: APAGAR** → — (cada texto vira chave em engine.*.ts e o chamador passa a usar t())
- **Evidência e regra (coordenador):** Tradução casada pelo texto português exato escrito em outros arquivos (L1–3): mudar uma palavra no chamador desliga a tradução; regras com defeito (L287 só um dígito, L298 perde $2/$4); diz 'devolve metade' com reembolso de 0,25.
- **Responsabilidades (a-l):** L5–247 phrase table Portuguese → English; L249–302 regex rules for phrases with numbers; L304–326 `part`/`translate`
- **Achados do leitor (a-l):**
  - [TEXT] legacy.ts:1–3 — whole-file mechanism: behaviour keyed by exact Portuguese text written elsewhere; any wording change in a caller silently stops translation.
  - [DUP] legacy.ts — many entries duplicate engine keys (e.g. L28 pause/resume, L111 'Salvo.', L157–159 = control.ts CTL_NAMES/RULE_NAMES, L114–125 = profiles.ts names, L170–172 = zones.ts names).
  - [BUG] legacy.ts:22–23,226 — phrases say demolishing refunds "half" ('Demolir devolve metade', 'devolve metade do custo') while tuning.ts:13 refund is 0.25 (the keyed text engine.en.ts:33 uses {refund}); if these phrases are still shown, the player is told the wrong refund.
  - [BUG] legacy.ts:298 — rule drops `$2`/`$4`: train/metro lines ("estações", "trens") are rendered in English as "stops" / "vehicles".
  - [BUG] legacy.ts:287 — `/^(\d) lotes$/` matches only one digit: "12 lotes" is not translated.
  - [ALLOC] legacy.ts:316–320 — regex scan over ~50 rules per untranslated string; if `loose()` runs per frame on HUD text, per-frame cost (inference).
- **Superfície pública:** `LEGACY_EN`, `translate`.
- **Exports nunca importados (b):** `LEGACY_EN`

#### `src/shared/vehiclePaints.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Paleta compartilhada por sim, render e UI.
- **Responsabilidades (a-l):** L5–8 vehicle paint palette
- **Achados do leitor (a-l):**
  - [SMALL] vehiclePaints.ts — one constant array; shared by sim, render, UI (L1–2).
- **Superfície pública:** `PAINTS`.

#### `src/sim/advisor.ts`

- **Veredito: MANTER** → src/sim/advisor.ts (comentários em inglês)
- **Evidência e regra (coordenador):** Escolha automática de controle; cursor que percorre todos os nós do mapa 64 por passo (L13, L52–58, conferido): trabalho O(mapa) fatiado entre passos (regra 6 do Forbidden); contadores por índice de braço quebram quando unlink compacta a adjacência (L67–74).
- **Responsabilidades (a-l):** L8–13 flow trend/settle constants and slice sizes; L15–87 `FlowAdvisor`: per-arm arrival counters, EMA rates, hysteresis switch signal ↔ signs, round-robin cursor; L89–95 typed array grow
- **Achados do leitor (a-l):**
  - [NAME] advisor.ts:1–3,8,10,12,17,20,22,27–29,32,34,45,51,64 — comments in Portuguese.
  - [OMAP] advisor.ts:52–85 — round-robin cursor over all nodes, 64 per step (L13, L56–58): whole-map work sliced across steps (rule 6 "amortizing"); the revisit period of each node grows with city size (16k nodes → every 256 steps).
  - [BUG] advisor.ts:67–74 — counters are per arm index `n*8+a` in adjacency order; network.ts:209–218 `unlink` compacts adjacency by moving the last arm into the removed slot, so after a segment removal the stored `pass/seen/rate` of the moved arm belong to another road (inference: SimNet uses the same adjacency); unless `reset(n)` is called on every remSeg (not visible here).
  - [NAME]/(magic) advisor.ts:31 — `scale = 2` tuned by observation (comment L27–30), not from a source.
- **Superfície pública:** `TREND`, `SETTLE`, `FlowAdvisor`.

#### `src/sim/drivers.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Modelo de motorista em colunas.
- **Responsabilidades (a-l):** L6–33 vehicle class figures and `archOf`; L35–53 driver SoA column schema; L55–84 `drawDriver`; L86–131 `driveAccel` (IIDM + CAH + jerk + emergency cap); L133–149 `bendSpeed`; L151–154 `desiredSpeed`
- **Achados do leitor (a-l):**
  - [ALLOC] drivers.ts:32 — `archOf` builds a 6-element array literal per call (per spawn; minor).
  - [R40COPY] drivers.ts:1,8,55,95,134,140 — cites 4.0 `vehicles/driver.ts`, `archetypes.ts`, `idm.ts`, `curvature.ts` (model ported, reimplemented on columns).
  - [NAME] drivers.ts:110 — queue-discharge relief constants (0.6, 4, 1.5) inline without source (engine's own calibration per L101).
- **Superfície pública:** `ARCH`, `archOf`, `driverSchema`, `VehicleColumns`, `drawDriver`, `JERK_UP`, `JERK_DOWN`, `driveAccel`, `bendSpeed`, `desiredSpeed`.

#### `src/sim/lanes.ts`

- **Veredito: MANTER** → src/sim/lanes.ts (grow → src/core/grow.ts)
- **Evidência e regra (coordenador):** Rede de faixas da simulação, fan-in 23; grow() igual a sim/traffic/grow.ts:3 e signals.ts:300 (L554); códigos de operação 1..8 sem nome (L568–591); índice de faixa em 3 bits (L18, L21).
- **Responsabilidades (a-l):** L15–28 lane id packing (seg*16+dir*8+idx), lane count/bus/speed helpers, Turn enum; L30–39 connection SoA schema; L43–127 `SimNet` worker mirror of the road network: per-node/arm/segment typed arrays + growth hooks; L129–177 `apply(NetOp)` (net edits, epoch, dirty nodes, removed/reprofiled lists, laneMeters); L195–203 `rebuild()` dirty nodes; L207–284 geometry (arc tables, lanePoint, connPoint); L288–308 clearNode; L311–315 turnOk; L318–322 dead-end bulbs dirtied by rect query; L324–438 rebuildNode (setbacks, control, stages, arm tables, lane-to-lane connections + Bézier control points); L441–466 conflict pairs; L469–495 connToward/laneToward; L499–505 laneTurns; L507–552 math (segCross, quadCurvature, connArcTable, tAtArc); L554–560 grow; L563–593 encodeOps/decodeOp (8 numbers per op + JSON side channel).
- **Achados do leitor (a-l):**
  - [OBJ] lanes.ts:77,465 — `conflicts: Map<number, Int32Array>`: one Map entry + one typed array per conflicting connection (grows with junction count; not SoA).
  - [DUP] lanes.ts:554 `grow` — same function as traffic/grow.ts:3 `growArray` and signals.ts:300 `grow`; routing.ts:62 and peds.ts:1458 have inline variants.
  - [ALLOC] lanes.ts:327–363,390,393,446,454 — rebuildNode/buildConflicts allocate arrays, Maps, closures, Float64Arrays per node rebuilt (per edit, bounded to touched nodes: acceptable, noted).
  - [TEXT] lanes.ts:568–591 — op codes 1..8 as bare numbers shared only between encodeOps/decodeOp; 'junction' spec travels as JSON string (L574, L590).
  - [BUG] (inference) lanes.ts:18,21 — lane index packed in 3 bits (max 8 lanes per direction); a profile with >8 lanes in one direction would alias into the other direction's ids. No guard visible here.
  - [BUG] (minor) lanes.ts:169–175 — `clear` resets most per-node arrays but not `epoch`/`nodeBorn`/`retreat`/`armStage`; harmless while every node is re-added through addNode (nodeBorn set there), noted only.
  - [LAYER] lanes.ts:6–12 — sim imports from roads (network, control, profiles, geometry, junction, laneLinks, flags): expected dependency direction sim→roads (OK if allowed).
- **Superfície pública:** `ARC_STEPS`, `CONN_ARC`, `laneId/laneSeg/laneDir/laneIdx/laneCount/laneBus/laneSpeed`, `Turn`, `SimNet` (network mirror), `laneTurns`, `quadCurvature`, `encodeOps`/`decodeOp` (page→worker op transport).

#### `src/sim/manoeuvres.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Manobras; path() cria objeto com dois arrays a cada pose() (L55–58) e gearAt um array por chamada (L62), no passo.
- **Responsabilidades (a-l):** L1–17 constants (plan budget, radius, speeds, MKind); L19–24 SoA schema of active manoeuvres; L26–93 `Manoeuvres`: budgeted Reeds-Shepp planning (start), gear at distance, advance with gear-change pause, pose, end/clear.
- **Achados do leitor (a-l):**
  - [ALLOC] manoeuvres.ts:55–58 — `path()` builds a new object with two arrays on every `pose()` call; `pose` runs per manoeuvring vehicle in `Traffic.stepManoeuvres` (per step) and `Traffic.centreOf` (per publish/frame).
  - [ALLOC] manoeuvres.ts:62 — `gearAt` allocates a 3-element array per call; called from `advance` every step per manoeuvre.
  - [TEXT] manoeuvres.ts:43 — magic 60 m path cap inline.
- **Superfície pública:** `PLAN_BUDGET`, `MANOEUVRE_RADIUS`, `MKind`, `Manoeuvres` (park/unpark/dock manoeuvre runtime used by traffic.ts).
- **Exports nunca importados (b):** `PLAN_BUDGET`

#### `src/sim/peds.ts`

- **Veredito: DIVIDIR** → src/sim/people/events.ts (fila de eventos e geração), busTrips.ts, cyclists.ts, crossings.ts (esquinas e faixas), kerbQueue.ts, crowd.ts (perto da câmera), publish.ts (poses)
- **Evidência e regra (coordenador):** 90,6 KB, 24 responsabilidades (L1–1628); eventos da população inteira da cidade a cada passo (L1198–1214, limitado a 20.000) — O(cidade); clear() não limpa outOfBus, startKey/startT, windowNodes, doors (L1622–1626, conferido): passageiros da cidade anterior descem depois de abrir outra; busca de célula escrita 5 vezes (L1243–1405).
- **Responsabilidades (a-l):** L22–116 constants + `bikeU`; L118–152 pedestrian SoA schema; L160–233 `Peds` fields, door cell index (setDoors/doorNear); L235–254 ctor/growth, demand; L258–287 event min-heap; L297–329 crossing queries for traffic (crossingReach/crossing/crossingArms); L333–346 per-node intrusive lists; L350–455 spawning (random node by zone, bus alighting queue, spawnAt, hit/explosion, spawn); L460–512 spawnFromPoint (door/kerb); L518–554 cyclists; L561–611 nodeAround/spawnFrom/spawnRoute/kill; L615–741 sidewalk helpers (segBetween, tracks, start spacing hash, sideU, startSidewalk, stop segment); L745–876 atNode + planCorner (crosswalk waypoints); L887–927 aheadPoint; L930–974 bikeThrough/armPoint; L977–1123 nextWay, keepRight mitre, kerb wait spots, standToCross; L1126–1194 posNow/advance/reroute/fadeOut; L1198–1216 step (spawn + event drain); L1219–1468 near-camera walker model (grid hash, vehicle bodies, stripe choice, IDM-like speed, push-apart, nudge, latRoom); L1475–1506 seenNow/keepSeen; L1509–1532 window + netRemoved; L1540–1594 writePoses (rope/turn-rate smoothing); L1602–1620 inspect; L1622–1626 clear.
- **Achados do leitor (a-l):**
  - [MIX] peds.ts (90 KB, 1628 lines) — event queue, spawning, bus trips, cyclists, corner/crosswalk planning, kerb queueing, near-camera crowd dynamics, pose publishing smoothing and probe in one class: god-file candidate (>50 KB).
  - [OMAP] peds.ts:1198–1214 — event processing covers the whole city's population (demand = laneMeters×density, L252); per-step cost grows with city size, capped at 20000 events/step (L1205): beyond that events lag (agents freeze/late), an implicit amortization.
  - [ALLOC] peds.ts:801–853 — `planCorner` allocates per call (`segsOf(n, [])`, `.map`, `.sort`, `rank` array, option objects, closures `fine`/`put`, `new Float64Array(3)` L853); runs on every node arrival event city-wide (atNode L785) and from `aheadPoint` (drawing path, L915).
  - [ALLOC] peds.ts:671–675,1445–1454,1349,1369 — `sideU`/`latRoom` return fresh tuples; `sideU` is reached from `posNow`→`trackU` (L1149,631) on every `posShown` (per near walker per step in seeEachOther L1280, per published person in writePoses L1551); `free`/`reserve` closures created per near walker per step (L1349, L1369).
  - [ALLOC] peds.ts:1015,1608 — array destructuring of `posShown` result; `fadeOut(lost)` builds an array (L1187); `toWaitSpot` closure + `stripAt` tuple per candidate spot (L1079,1092).
  - [DUP] peds.ts:638,1432,1450 — the same "half width of the sidewalk strip containing u" loop three times (trackOff, nudge, latRoom).
  - [DUP] peds.ts:1243–1257,1311–1313,1330–1332,1403–1405 — open-addressing cell lookup written 2 functions + 3 inline copies.
  - [DUP] peds.ts:615–623 `segBetween` ~ traffic.ts:847 `segBetween` (traffic variant prefers the lane-bearing shorter one); peds.ts:106 `bikeU` ~ traffic.ts:75 `parkU` (strip scan by kind).
  - [TEXT] peds.ts:837 — `sim.nodeCtl[n] === 9 || === 10` magic control values instead of `Ctl.*` names; L109,638,1432,1450 strip kinds by string ('bike','sidewalk'); L1586 pose kind code `(bike ? 5 : 3) * 256` shared with renderer/traffic kind codes.
  - [NAME] peds.ts:699 — `stretchKey(p, s, side, ±1, n1)` passes segment/side/dir/node into parameters named x0,z0,x1,z1 (used only as hash input, works, misleading).
  - [BUG] peds.ts:417 — `hit` queries nodes within r+120 m, but a person sits in the list of the node it walks *to* (up to a street length away, comment L1272 uses +150); someone on a long segment whose target node is >r+120 m away is not hit by an explosion at its feet.
  - [BUG] peds.ts:1622–1626 — `clear()` resets table/heads/heap but not `outOfBus` (L385), `startKey/startT`, `windowNodes`, `doors`: after a map clear/load, queued bus alighters are spawned at old-map coordinates by `stepOutOfBus` (L1200).
  - [BUG] (inference) peds.ts:1509–1512,1546 — `windowNodes` is refreshed only by `checkWindow` (camera moved); nodes built inside the window while the camera stays still are not in it, so people walking to them are not published until the camera moves.
  - [R40COPY] peds.ts:47–103,1259–1267 etc. — values and behaviour cited from roadcraft 4.0 `walk.ts` line numbers (ported parameters with citations; code itself is rewritten SoA, not a copy).
  - [DEAD] peds.ts:1597 — doc comment "within  m" (missing constant); L625 orphan doc comment above trackU; L1062 duplicate doc block above toWaitSpot.
- **Superfície pública:** `PED_INSPECT_STRIDE`; `Peds` (crowd sim: step, writePoses, inspect, setDoors, setBodies, spawnAt/spawnFromStop/spawnFromPoint, hit, netRemoved, checkWindow, crossing queries for traffic, callbacks walkOk/carsOn/onWait/pickTrip/onStop).

#### `src/sim/probe.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** A cabeça diz 'só para a sonda' mas peds.ts:1092 usa no jogo (toWaitSpot): renomear o comentário; tupla por chamada (L19).
- **Responsabilidades (a-l):** L8–9 `STRIP_KINDS` list; L19–35 `stripAt`: strip kind under a point and distance past the junction setback.
- **Achados do leitor (a-l):**
  - [TEXT] probe.ts:9,31 — strip kind resolved by `indexOf` of the profile's string kind; the string list must match roads/profiles strip kinds.
  - [ALLOC] probe.ts:19 — returns a new tuple per call; also used in gameplay, not only the probe: peds.ts:1092 `toWaitSpot` (per candidate spot on every kerb wait) — header L1–2 says "only on request", which is no longer true.
  - [SMALL] probe.ts — one function; callers peds.ts (inspect, toWaitSpot) and traffic.ts:1499 (inspect).
- **Superfície pública:** `STRIP_KINDS`, `stripAt`.

#### `src/sim/reedsShepp.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Caminhos de Reeds-Shepp; até 16 objetos por plano contra o que diz o cabeçalho (L5, L57–62); integrate só usado por teste (L87).
- **Responsabilidades (a-l):** L8–23 segment kinds, RSPath type, mod2pi/polar; L25–51 CSC/CCC family formulas (OMPL-based); L56–84 candidate enumeration (time-flip, reflection, backwards); L87–97 `integrate`; L103–117 `planRS` shortest path with reverse limit; L123–141 `poseAlong`.
- **Achados do leitor (a-l):**
  - [ALLOC] reedsShepp.ts:57–62 — `candidates` allocates up to 16 RSPath objects with arrays + closure per plan, contradicting header L5 ("no allocation per query beyond the result"); bounded by PLAN_BUDGET=4/step (manoeuvres.ts:11).
  - [DEAD] reedsShepp.ts:87 — `integrate` exported, not used in this file nor by manoeuvres.ts (inference: test-only).
  - Note: only CSC and CCC families (no CCCC/CCSC/CCSCC); comment L2–4 states this deliberately.
- **Superfície pública:** `Seg`, `RSPath`, `integrate`, `planRS`, `poseAlong`.
- **Exports nunca importados (b):** `Seg`, `integrate` (nem no arquivo)

#### `src/sim/routing.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** A*; até 40.000 expansões por busca (L31) com até 400 buscas por passo vindas de peds.ts:28.
- **Responsabilidades (a-l):** L10–17 speeds; L19–56 `Router` + `nodeCost` (junction cost by control/turn); L58–93 growable arrays + binary heap; L103–105 route dispatcher; L108–152 walking A* over nodes; L155–168 per-directed-segment state arrays; L175–263 driving A* over directed segments (turn legality via `turnOk`, BPR-like load cost, goal lane).
- **Achados do leitor (a-l):**
  - [ALLOC] routing.ts:115,186–190 — heuristic/drive/head closures created per search (small, per route).
  - [OMAP] (inference) routing.ts:31 — up to 40000 expansions per search; callers issue many searches per step (peds spawn up to SPAWN_FILL=400/step, peds.ts:28, each a walk A*), so a map-opening step can cost hundreds of A* runs.
  - [TEXT] routing.ts:49,54 — turn/wait seconds as magic numbers (0/2/6/15, 6/8/4/2).
  - [DUP] routing.ts:62 — inline typed-array grow (see lanes.ts:554).
- **Superfície pública:** `WALK_SPEED`, `Router` (route, nodeCost, segLoad, limit, counters).

#### `src/sim/signals.ts`

- **Veredito: MANTER** → src/sim/signals.ts (grow → src/core/grow.ts)
- **Evidência e regra (coordenador):** FSM dos semáforos; callbacks por atribuição (L77–81); grow duplicado (L300).
- **Responsabilidades (a-l):** L16–41 timings (SIGNAL, from 4.0 params.ts), Sub enum, ITE amber; L43–94 `Signals` per-node/per-stage arrays and growth; L100–130 rebuild plan per node (stages, walk masks, amber, greens, offset); L133–168 activation, seek, timed cycle; L174–216 queries (nextGreen, state, go, amberNow, walkOk, pedCall); L219–297 actuated step (gap-out/max-out, ped hold, bus priority, starvation, next stage).
- **Achados do leitor (a-l):**
  - [R40COPY] signals.ts:6,15 — timings and FSM behaviour cited from roadcraft 4.0 `signals/fsm.ts`/`params.ts` (values ported; code rewritten).
  - [HOST] signals.ts:77–81 — callbacks injected by assignment (traffic.ts:283–284); `pedsOn` is never assigned in traffic.ts L277–465 (inference: wired elsewhere or stays `() => false`, which would disable the pedestrian hold at L251).
  - [DUP] signals.ts:300 `grow` — see lanes.ts:554.
  - [BUG] (minor) signals.ts:153–168 — `timed` stores a side result in `timedIn` (hidden coupling with `seek`/`nextGreen`).
  - Note: no `clear()`; relies on SimNet clearing `nodePhases` (state per node stays stale but unused).
- **Superfície pública:** `SIGNAL`, `Sub`, `iteAmber`, `Signals`.
- **Exports nunca importados (b):** `SIGNAL`, `Sub`, `iteAmber`

#### `src/sim/traffic.ts`

- **Veredito: DIVIDIR** → src/sim/traffic/spawn.ts (demanda e geração), parking.ts (meio-fio, docas, vagas), lists.ts, window.ts (promoção na janela), publish.ts (poses), inspect.ts, tracks.ts — Traffic fica dono das tabelas
- **Evidência e regra (coordenador):** 89,3 KB, 20 responsabilidades; cinco hosts de getters (L314–464, ~105 membros); updateSignals percorre todos os nós semaforizados da cidade a cada passo (L1149–1152, conferido): O(cidade); tipos de veículo como números soltos 0..4 (L585…L1551).
- **Responsabilidades (a-l):** L35–87 constants, `parkU`; L89–275 `Traffic` fields, lane enter/leave figures, stopBack, clearAll, clearWear, blast, counters; L277–465 ctor: growth hooks + host objects for Junctions/Meso/Buses/LaneChanges/Micro; L472–484,788–840 micro lane/conn lists, lane counts, occupancy/wear, micro dense list; L501–541 manoeuvreList + dock cell index; L544–786 arrival behaviours (docks, kerb drop-off, bays, Reeds-Shepp manoeuvres, parkers); L844–913 route helpers; L917–1098 demand (random/zoned nodes, day curve, spawn, leaveBay, initVehicle); L1101–1128 lose/finish/despawn; L1138–1216 signals glue (lightState, armsQueue, busNearArms, nodesRebuilt); L1219–1272 segsRemoved/segsReprofiled; L1276–1311 forwarding to micro/buses/stops; L1316–1385 window (checkWindow, materialize); L1389–1415 step; L1418–1441 train wagons; L1449–1463 indicator bits; L1473–1537 inspect/crossAt; L1539–1581 writePoses/writeBodies; L1587–1678 headOf/centreOf pose; L1689–1725 `backAlong`.
- **Achados do leitor (a-l):**
  - [MIX] traffic.ts (89 KB, 1727 lines) — demand/spawning, parking/kerb/dock behaviour, list maintenance, signals glue, window promotion, pose publishing, inspection and track geometry (`backAlong`) in one class despite the extracted subsystems; >50 KB.
  - [HOST] traffic.ts:314–464 — five host objects of getters/forwarders (Junctions ~25 members, Meso ~35, Micro ~45 incl. get/set pairs for counters L438–442); plus forwarding wrappers on Traffic itself (L138–141, L240–241, L269–273, L964–977 regions getters/setters, L1138–1144, L1280–1286, L1299–1311).
  - [OMAP] traffic.ts:1149–1152 — `updateSignals` loops every signalled node of the city every step and recomputes `lightState` (comment L1324 confirms "updateSignals writes every signalled node"); grows with the number of lights, not with the window.
  - [OBJ] traffic.ts:1418–1423 — `wagonPrev: Map<number, Float32Array>`: one typed array per train vehicle; traffic/buses.ts `riders`/`realRiders` same pattern.
  - [ALLOC] traffic.ts:941–948 — `zoneWeights` builds three arrays per call (up to 3× per spawn attempt, up to 60 attempts/step); L1252 `[1, -1]` array per segment in segsReprofiled; L1654 `shift` closure per lane-changing vehicle in `centreOf` (per publish); L1319 new Set per checkWindow.
  - [ALLOC] traffic.ts:1544,1631–1637 — `centreOf`→`mvs.pose`→Manoeuvres.path allocates per manoeuvring vehicle per publish (see manoeuvres.ts:55).
  - [TEXT] traffic.ts:585–587,749,1011,1478,1544,1551 — vehicle kinds as bare numbers (0 car, 1 bus, 2 truck, 3 person/none, 4 train) and `dying` codes 1–4 (L252,631,674,737,1124,1329–1336) and pose code `kind*256` (L1552, L1434) shared with peds.ts and the renderer.
  - [DUP] traffic.ts:847–860 `segBetween` vs peds.ts:615; L75 `parkU` vs peds.ts:106 `bikeU`; L1518–1537 `crossAt` sampling a quad Bézier again (same evaluation as lanes.ts:450–451, 536).
  - [BUG] (inference) traffic.ts:1316–1326,1213–1214 — a signal node created inside the window while the camera is still is added to `signalNodes` but not to `windowSignals` (only `checkWindow` adds), so it stays on the timed cycle (not actuated) until the camera moves.
  - [DEAD] traffic.ts:1551 — `c.kind[v] === 3 ? 0` branch: kind 3 is never spawned as a vehicle here (spawn L1011 uses 0–2; buses 1/4).
  - [R40COPY] traffic.ts:37,67,1639–1643,1562 — behaviour/values cited from roadcraft 4.0 (STUCK_SECONDS, kerbStops/parking, pose.ts axleFrame, walk.ts CarZone).
- **Superfície pública:** re-exports of traffic/state.ts constants and regions constants (L22,33); `STUCK_SECONDS`; `Traffic` (step, writePoses, writeBodies, inspect, blast, setLines/setDocks, lineStats, writeStopPeople, nodesRebuilt/segsRemoved/segsReprofiled, checkWindow, signal/crossing queries, many counters); `backAlong` (path point behind the front).

#### `src/sim/traffic/buses.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Ônibus e trens nas linhas; um Float64Array por ônibus em dois Maps (L45–46); capacidade 600 e espera 120 fixas (L186, L235).
- **Responsabilidades (a-l):** L15–33 `BusHost` interface; L35–37 constants; L39–64 `Buses` state, clear, forget; L67–100 tick/setLines (carry lines across edits); L103–144 retireBus/carryLine; L147–181 keepBuses/spawnBus; L184–202 background demand accrual, pedAtStop; L205–216 pickTrip; L219–250 serve stop (alight/board); L253–269 busPlan.
- **Achados do leitor (a-l):**
  - [OBJ] buses.ts:45–46,138,225–226 — one `Float64Array` per bus in two Maps (riders by destination); per-line `Set<number>` L43 (fine, few lines).
  - [ALLOC] buses.ts:96 — `[...set]` copy (per edit only).
  - [TEXT] buses.ts:167–169 — vehicle kinds 4/1 as bare numbers; L186 `120` waiting cap, L235 train capacity 600 magic.
  - [HOST] buses.ts:23–26 — host exposes `time`, `rng`, `sample`, `onAlight` as getters of Traffic (traffic.ts:392–395).
  - [BUG] (inference) buses.ts:236–245 — `take` boards from `ln.waiting[i]` while `real`/`total` are summed from `realTo`/`waitTo`; if `waiting` drifts from Σ`waitTo` (it is set independently in carryLine L125 and accrue L191), boarded counts and per-destination remainders diverge.
- **Superfície pública:** `BusColumns`, `BusHost`, `TERMINAL_DWELL`, `BUS_CAP`, `Buses`.
- **Exports nunca importados (b):** `BusColumns`, `BusHost`

#### `src/sim/traffic/grow.ts`

- **Veredito: JUNTAR** → src/core/grow.ts
- **Evidência e regra (coordenador):** Uma função idêntica a lanes.ts:554 e signals.ts:300 (L3); variantes em routing.ts:62 e peds.ts:1458.
- **Responsabilidades (a-l):** L3–9 `growArray`: returns a larger typed array filled with a default and the old contents.
- **Achados do leitor (a-l):**
  - [SMALL] grow.ts — one function; imported by traffic.ts:28 (as `grow`).
  - [DUP] grow.ts:3 — identical to lanes.ts:554 `grow` and signals.ts:300 `grow`; similar inline growers in routing.ts:62 and peds.ts:1458.
- **Superfície pública:** `growArray`.

#### `src/sim/traffic/junctions.ts`

- **Veredito: MANTER** → src/sim/traffic/junctions.ts
- **Evidência e regra (coordenador):** Prioridade nos cruzamentos e passagens de nível; `[1, -1]` alocado por chamada no passo dos pedestres (L98); updateCrossings percorre todos os trens de todas as linhas a cada passo (L330–352); teste de cancela abaixada escrito duas vezes (L146, L370) e uma terceira em meso.ts:218; comentário fora do lugar (L417–418).
- **Responsabilidades (a-l):** L15–43 JunctionHost interface (25 members: forwarded Traffic state + callbacks); L45–78 claim arrays (pass, yield claim, exit claim) and growth; L83–90 micro-side exit claim / pass; L92–137 cars on a zebra arm (`carsOnCrossing`, courtesy); L144–161 box clear / pass holder; L170–196 pedestrians in the way, front time (admission travel time), exit arm; L199–224 signal stage / ring gate; L227–266 rule rank, priority (`outranks`), conflict busy test with impatience; L269–309 exit room (incl. back-to-back junction recursion); L312–320 gateFor; L328–365 level-crossing barrier state + signals buffer write; L367–415 gateRules (crossing, signal/amber, zebra, stop sign, right of way, starvation claim); L419–456 evacuate/resettle vehicles in a rebuilt junction; L462 laneSpeedOf helper.
- **Achados do leitor (a-l):**
  - [ALLOC] junctions.ts:98 — `for (const dir of [1, -1])` allocates an array per call; `carsOnCrossing` is called by Peds (`peds.carsOn`, worker.ts:68) in the pedestrian step.
  - [ALLOC] junctions.ts:357 — `sim.net.segsOf(n, [])` + `forEach` closure per closed crossing per sim step; L330 `this.h.lines.forEach((ln, li) => …)` closure per step.
  - [ALLOC] junctions.ts:81 — `closedCrossings()` spreads Map keys into a new array (inspector/drawing caller).
  - [OMAP] junctions.ts:330-352 — `updateCrossings` walks every train of every rail line every step (meso trains included), not only those in the window; grows with the train fleet, not the map (inference: bounded by line count).
  - [BUG] junctions.ts:417-418 — doc comment ("Steps the actuated lights and writes EVERY signalled node's state…") sits on `evacuateConn`, which does nothing of the sort; stale comment from a moved method. L458 orphan doc comment "Rebuilt nodes: a new plan for their lights" with no member under it.
  - [DEAD] junctions.ts:458 — dangling JSDoc at class end (method removed).
  - [R40COPY] junctions.ts:1,105,108,122,142,164-168,182,259,378-385 — many references to "roadcraft permission.ts / admission.ts / crossingSpans.ts" line numbers (values ported from 4.0; comments only, not copied code).
  - [TEXT] junctions.ts:254-262 — magic numbers in right-of-way (45 m look, 0.06 s/s impatience, 2.2/3/3.5 s gaps, 18 m ring look L219, 8 s stuck L400, 6 tenths claim L408, 7.5 m slot L307).
  - [DUP] junctions.ts:307 / measure.ts:67 / regions.ts:55 / meso.ts:157,236 — 7.5 m vehicle slot constant repeated as a literal across traffic files.
  - [DUP] junctions.ts:146 and :370 — same level-crossing-down test written twice (boxClear and gateRules).
  - [HOST] junctions.ts:27 — `signals: Uint8Array | null` mutable field on the host (writes into Traffic's buffer).
- **Superfície pública:** `JunctionHost` (host contract), `Junctions` (gateFor, gateRules, boxClear, exitRoom, claimExit, pass, pedsInWay, carsOnCrossing, stageGreen, gateOpen, updateCrossings, crossingDown, closedCrossings, evacuateConn, resettleBox, growConns, growLanes, clear).
- **Exports nunca importados (b):** `JunctionHost`

#### `src/sim/traffic/laneChanges.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Troca de faixa; tupla nova por chamada de around() no passo micro (L35–43) e arrays literais (L81, L121).
- **Responsabilidades (a-l):** L8–13 LaneColumns type; L16–27 LaneHost; L35–43 neighbours on a lane (linear scan); L45–59 MOBIL test; L61–71 perform a change; L77–89 escape a dead-end lane; L92–97 physical room beside; L99–110 mandatory change toward next turn; L112–130 discretionary keep-right change.
- **Achados do leitor (a-l):**
  - [ALLOC] laneChanges.ts:35-43 — `around()` returns a new 2-tuple per call; called from canChange/roomBeside in the micro step (per vehicle each time lcCool expires).
  - [ALLOC] laneChanges.ts:81, 121 — `for (const step of [1, -1])` / `[-1, 1]` array literal per call in the micro step.
  - [OMAP] laneChanges.ts:38 — `around` walks the target lane's list from its head (O(vehicles on lane)); bounded by lane, not map.
  - [TEXT] laneChanges.ts:52,54,58,96,120 — literals 2 m/3 m gaps, −3.5 safe decel, 0.25 threshold, 6 m/s² stop, 60 m near-node.
- **Superfície pública:** `LaneColumns`, `LaneHost`, `LaneChanges` (escape, mandatory, discretionary).
- **Exports nunca importados (b):** `LaneColumns`, `LaneHost`

#### `src/sim/traffic/lines.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Linhas na simulação; tabelas N×N por linha (L89–90); terminal marcado também na parada espelhada da volta (L68, defeito); matemática da célula repetida de regions.ts:37–41.
- **Responsabilidades (a-l):** L9–24 SimLine record; L27–32 LineSpec from page; L35 stop index grid constants; L38–92 resolve a line's stops to lanes (nearest seg, side, return-trip mirroring, sidewalk spot, yaw); L95–110 counting-sort stops into 600 m cells.
- **Achados do leitor (a-l):**
  - [OBJ] lines.ts:9-24,41-42 — one JS object per line with `number[]` per-stop arrays and per-stop `Float64Array` rows (L89-90 `waitTo`/`realTo` are N×N per line: O(stops²) memory). Lines are few (inference), but not SoA.
  - [ALLOC] lines.ts:50,72,76 — three typed arrays allocated per stop inside `addStop` (only when lines change; not hot).
  - [BUG] lines.ts:68 — `sp.term?.includes(i / 2)` is evaluated for flipped return-trip stops too (L87 passes original `kept[k]`), so a terminal index marks the mirrored stop as terminal as well (inference: return stops of a terminal-marked stop get long dwell).
  - [DUP] lines.ts:96-100 — cell-of function duplicates the clamp/floor grid math of regions.ts:37-41 and stops.ts:26-27.
  - [TEXT] lines.ts:46,70,78 — 40 m search, 8/14 m stop offsets, 0.15 m height literal.
- **Superfície pública:** `SimLine`, `LineSpec`, `STOP_CELL`, `STOP_CELLS`, `resolveLine`, `indexStops`.

#### `src/sim/traffic/measure.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Sonda do inspetor; teste de 'congestionado' repetido de regions.ts:59–60 (L54); MeasureHost redeclara colunas à mão (L9–12).
- **Responsabilidades (a-l):** L8–24 MeasureHost (forwarded Traffic arrays); L26–37 accumulators; L43–58 city average speed + stopped count (micro list + last region jam count); L61–83 segment probe for the inspector.
- **Achados do leitor (a-l):**
  - [ALLOC] measure.ts:63,66,82 — probe returns new object and `for (const dir of [1, -1])` (inspector only, not hot).
  - [DUP] measure.ts:54 vs regions.ts:59-60 — "jammed" test `load ≥ JAMMED × lanes × len / 7.5` written in both.
  - [HOST] measure.ts:43,61 — host passed per call rather than held; MeasureHost re-declares a subset of vehSchema columns by hand (L9-12) instead of `Pick<Columns<typeof vehSchema>>`.
- **Superfície pública:** `MeasureHost`, `Measure` (reset, addTrip, avgSpeed, probe).
- **Exports nunca importados (b):** `MeasureHost`

#### `src/sim/traffic/meso.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Modelo meso; DWELL duplicado de state.ts:8 (L26); regra de embarque e de liberação de congestionamento copiadas de micro.ts:183 e :337–341 (L146, L243–246); host de 40 membros (L31–72).
- **Responsabilidades (a-l):** L17–26 pace constants (alpha, crowd, S0, headway, DWELL); L31–72 MesoHost (40 members); L74–105 per-lane meso lists, event heap, grow/clear; L108–123 list link/unlink; L126–129 window test; L132–162 enter lane: BPR travel time + junction wait + capacity headway, schedule; L165–173 process due events; L176–273 advance at lane end (destination, replan, lane fix-up, crossing/zebra/light waits, queue/jam release, entering micro window); L275–303 binary heap.
- **Achados do leitor (a-l):**
  - [DUP] meso.ts:26 `DWELL = 14` duplicates state.ts:8 `DWELL = 14`; meso.ts:146 dwell rule `ln.mode ? 25 : ln.term.has(...) ? TERMINAL_DWELL : DWELL` duplicates micro.ts:183 (train dwell 25 is a literal in both).
  - [DUP] meso.ts:243-246 — jam-release rule duplicated from micro.ts:337-341 (JAM_SECONDS / releaseAt / jamAt / countJam).
  - [DUP] meso.ts:218 — crossing-down-and-not-rail test, third copy (junctions.ts:146,370).
  - [HOST] meso.ts:31-72 — 40-member host, many pure forwarders (countRelease, countJam, crossingDown, pedCrossing…).
  - [ALLOC] meso.ts:277-280 — heap doubles by allocation when full (rare; growth, acceptable).
  - [TEXT] meso.ts:155,236,239,251 — literals 2/3.6/2.6/1.8 s headways, 7.5/6.6 m slots, +2 s wait, 4 m margin.
- **Superfície pública:** `MesoColumns`, `MesoHost`, `Meso` (link, unlink, inWindow, enter, process, advance, grow, clear; fields head/tail/tries/full/alpha/crowd).
- **Exports nunca importados (b):** `MesoColumns`, `MesoHost`

#### `src/sim/traffic/micro.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Passo micro; copia activeConns e activeLanes em arrays novos a cada passo (L90, L97, conferido): alocação no caminho quente; muda router.limit de outro dono e restaura (L366–369, L413–416).
- **Responsabilidades (a-l):** L19–69 MicroHost (≈50 members); L76–85 IDM with queue-discharge; L87–105 micro step over active connections then lanes; L114–146 bend braking, bend curvature, connection after lane; L149–156 gap through node; L158–321 move on lane (bus stop, dock try, arrival, next connection, mandatory/escape lane change, reconsider, wait/detour/claim/jam release, commit at line, zebra/box checks, accel, enter connection); L324–328 admit; L337–348 jam release; L355–395 reconsider route (local detour) and splice; L401–426 detour through another free exit; L429–435 stop ahead; L437–507 move on connection (merge priority, zebra, bends, lane entry, replan, back to meso).
- **Achados do leitor (a-l):**
  - [ALLOC] micro.ts:90,97 — `[...this.h.activeConns]` and `[...this.h.activeLanes]` copy both Sets into new arrays every micro step (per sim step, hot path).
  - [ALLOC] micro.ts:149-156 — `aheadThrough` returns a new tuple; called per vehicle per step at L267.
  - [DUP] micro.ts:183 — bus/train dwell rule duplicated in meso.ts:146.
  - [DUP] micro.ts:337-341 vs meso.ts:243-246 — jammed-junction release rule.
  - [HOST] micro.ts:43-47 — mutable counters (released, jams, ranRed, reroutes, routeBudget) written through the host into Traffic.
  - [HOST] micro.ts:366-369,413-416 — temporarily overwrites the shared `router.limit` and restores it (state of another owner mutated in place).
  - [DEAD] micro.ts:191 — `if (c.dying[v]) { /* leaving */ }` empty branch used as an else-if guard; L274-275 orphan comment ("the turn ahead…") with no code.
  - [TEXT] micro.ts:193 — `(this.microStep + v) % 20 === 0` throttle; L197 30/12 m decide distances; L218 0.6×L/7.5; L282-283 `a = -9` literals.
  - [R40COPY] micro.ts:79,109,214,225,240,254,260,312,331,351 — references to roadcraft 4.0 functions (curveSpeedCap, reconsiderRoute, admission, claims.ts grantAll, invariants.ts) in comments.
  - [NAME] micro.ts:106,384-385 — fields declared between/after methods (microStep after stepMicro).
- **Superfície pública:** `MicroHost`, `Micro` (idm, stepMicro, bendBrake, bendK, connAfter, aheadThrough, moveOnLane, moveOnConn, admit, jamRelease, reconsider, splice, detour, stopAhead).
- **Exports nunca importados (b):** `MicroHost`

#### `src/sim/traffic/regions.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Ocupação por região; a cada 4 s percorre todos os segmentos do mapa (L50–61, conferido): trabalho O(mapa) periódico (regra 5/6 do Forbidden) — corrigir por contadores incrementais por região atualizados nas entradas/saídas de veículos.
- **Responsabilidades (a-l):** L9–13 constants (400 m region, jammed share, governor); L15–35 region state + reset; L37–41 region of a point; L44–69 every 4 s: occupancy per region, jam share, fleet governor.
- **Achados do leitor (a-l):**
  - [OMAP] regions.ts:50-61 — every REGION_EVERY (4 s) a full pass over all segments of the map (`net.segs.end`); cost grows with city size (periodic whole-map work, not a radius query).
  - [OMAP] regions.ts:62 — loop over all regions (map-size grid) in the same pass.
  - [DUP] regions.ts:37-41 — grid cell math duplicated in lines.ts:96-100 and stops.ts:26-27.
  - [DEAD] regions.ts:27 — `avoid` flag never read inside the file (inference: read by Traffic).
- **Superfície pública:** `REGION`, `REGION_OCC`, `REGION_SLOPE`, `REGION_EVERY`, `JAMMED`, `Regions` (of, measure, reset, occ, jamShare, jammedNow, gov, governed, avoid).

#### `src/sim/traffic/state.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Esquemas das tabelas do tráfego; CROSSWALK 4.2 igual a jobs/roadMesh.ts só por comentário (L15); bits de inspeção para tools/check-sim.mjs (L36–38).
- **Responsabilidades (a-l):** L5–47 shared traffic constants (route cap, dwell, crossings, body widths, inspect stride/bits, kind lengths, light bits, wagons); L49–87 vehicle SoA schema (incl. driverSchema); L90 trip end reasons.
- **Achados do leitor (a-l):**
  - [DUP] state.ts:8 `DWELL` duplicated in meso.ts:26.
  - [DEV] state.ts:36-38 — INSPECT_STRIDE / INSPECT_* bits exist for the inspect probe used by tools/check-sim.mjs (worker.ts:27) (inference: test tooling vocabulary in product state).
  - [R40COPY] state.ts:24,27,29 — constants cited from roadcraft crossingSpans.ts / admission.ts line numbers.
  - [TEXT] state.ts:15 — CROSSWALK 4.2 must match jobs/roadMesh.ts CROSSWALK by comment only (two definitions kept in sync by hand).
- **Superfície pública:** constants (`ROUTE_CAP`, `MAX_VEHICLES`, `DWELL`, `REJOIN`, `PARK_SIDE_S`, `JAM_SECONDS`, `RELEASE_EVERY`, `CROSSWALK`, `PED_*`, `BODY_HALF_W`, `SPAN_REACH`, `CLEAR_MARGIN`, `STARVE_SECONDS`, `CROSSING_REACH`, `INSPECT_*`, `KIND_LEN`, `CAR_STYLE_LEN`, `LIGHT_*`, `WAGONS`, `WAGON_LEN`), `vehSchema`, `End`.

#### `src/sim/traffic/stops.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Paradas; stats() escreve estado da linha (L71–72); raio de 600 m literal (L26–27).
- **Responsabilidades (a-l):** L8 background demand rate; L11–20 stop cell index; L23–62 write waiting people near the camera into the pose buffer (600 m cell query, shared places per spot); L65–78 per-line stats (passengers/hour, waiting).
- **Achados do leitor (a-l):**
  - [ALLOC] stops.ts:42 — `placed.set` with numeric keys per stop each publish (Map reused and cleared; entries churn per frame).
  - [ALLOC] stops.ts:66-77 — `lines.map` builds new objects per stats call (once a second; fine).
  - [DUP] stops.ts:26-27 — 600 m radius duplicated as literal and equal to STOP_CELL (lines.ts:35) by coincidence; L37,75 waiting formula `min(120, waiting + (time-lastT)*WAIT_RATE)` written twice.
  - [HOST] stops.ts:71-72 — `stats` mutates SimLine (perHour, boardings) — a reporting call writes line state.
- **Superfície pública:** `WAIT_RATE`, `Stops` (index, write, stats).

#### `src/sim/worker.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Entrada do worker da simulação; splice(0) em quatro arrays a cada passo (L133, L136); callbacks ligados atribuindo campos públicos de Traffic/Peds (L60–76); mensagens 'inspect' e 'probeManoeuvres' só para as ferramentas (L27–28, L197–203).
- **Responsabilidades (a-l):** L11–51 message types to/from the sim worker; L55–76 build SimNet/Traffic/Peds and wire their callbacks; L78–101 loop state, pose scratch, error ring; L104–112 error reporting with throttle; L114–127 fixed-step timer with lag cap; L129–173 step: apply network removals/rebuilds, traffic+peds substeps, window check, poses write+sort by tile, publish, stats each second; L175–225 message dispatch (init, camera, demand, lines, probe, inspect, hit, ops with resync).
- **Achados do leitor (a-l):**
  - [ALLOC] worker.ts:133,136 — `splice(0)` on four arrays each step creates new arrays every step (usually empty).
  - [ALLOC] worker.ts:171 — stats message object + lineStats array once a second (fine).
  - [DEV] worker.ts:27-28,19,197-203 — 'inspect' and 'probeManoeuvres' messages exist for tools/check-sim.mjs (comment L27); 'probeNode' (L204) likewise (inference).
  - [HOST] worker.ts:60-76 — cross-wiring by assigning function fields on Traffic/Peds/Signals (`traffic.pedCrossing = …`, `peds.carsOn = …`); callbacks are mutable public fields.
  - [NAME] worker.ts:53 — import placed mid-file after type declarations; L127 MAX_LAG_MS declared after its use in `step` (works at runtime).
  - [TEXT] worker.ts:143 — 180 m bodies radius literal; L148 0.5 s window check.
- **Superfície pública:** `ToSim`, `FromSim` (message contracts); worker module side effects.

#### `src/ui/about.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Diálogo Sobre; `if (p.licence)` sempre verdadeiro (L101).
- **Responsabilidades (a-l):** L14–19 asset pack table; L22–30 fetch a build file (dev fallback detection); L35–40 parse licence list shapes; L42–129 About dialog: build, Steam name, credits, per-pack licence groups and text fold, relocalized on language change.
- **Achados do leitor (a-l):**
  - [TEXT] about.ts:28 — detects a dev-server HTML fallback by `<!doctype`/`<html` prefix.
  - [DEAD] about.ts:101 — `if (p.licence)` always true (every PACKS entry has a licence).
  - [LAYER] about.ts:7 — ui imports platform/steam.ts (inference: allowed direction, noted).
- **Superfície pública:** `AboutBox` (open, close, isOpen, root).

#### `src/ui/boot.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Tela de falha na partida; uma função, chamada por main.ts.
- **Responsabilidades (a-l):** L7–16 boot dependencies; L18–27 start the game or show isolation/start error.
- **Achados do leitor (a-l):**
  - [SMALL] boot.ts:18-27 — one function (caller not visible in batch; inference: main entry).
  - [DEV] boot.ts:14-15 — `failed()` hook exists "for the automated photos and checks".
- **Superfície pública:** `BootDeps`, `bootGame`.

#### `src/ui/compass.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Bússola; uma responsabilidade.
- **Responsabilidades (a-l):** L17–70 compass button: SVG, click → north, drag → orbit/tilt, keyboard, needle rotation only on degree change, relabel.
- **Achados do leitor (a-l):**
  - [TEXT] compass.ts:48 — drag gains 2 and 1.5 literals.
- **Superfície pública:** `CompassHandlers`, `Compass`, `mountCompass`.
- **Exports nunca importados (b):** `CompassHandlers`

#### `src/ui/creator.ts`

- **Veredito: MOVER** → src/features/buildings/creator.ts (textos para shared/i18n)
- **Evidência e regra (coordenador):** Textos do jogador em português fora do i18n (L13–134): não muda de idioma; aplicar um modelo não atualiza this.floors (L62–64, conferido) e 'Salvar como modelo' grava o número antigo; persistência por localStorage + window.prompt dentro do painel (L28–30, L105–113).
- **Responsabilidades (a-l):** L12–24 building design presets; L26–30 player models in localStorage; L32–121 building creator panel (selects, setbacks, palette, gear checkboxes, save model, "no design"); L123–135 preset list; L140–150 show/sync a design.
- **Achados do leitor (a-l):**
  - [NAME] creator.ts:1-2,7,11,54,77,92,139 — comments in Portuguese (rule: everything written in English).
  - [TEXT] creator.ts:13-23,66-76,84,103-117,126,133-134 — player-facing text hard-coded in Portuguese, not through i18n (`t()`), so it never changes language; preset names are Portuguese literals.
  - [NAME] creator.ts:26 — localStorage key `'cidade.modelos-predio'` in Portuguese.
  - [BUG] creator.ts:62-64 — applying a preset passes its floors to the game but never sets `this.floors`; "Salvar como modelo" (L110) saves the stale `this.floors` unless `show()` is called back by the game (inference).
  - [DEAD] creator.ts:85 — `b.style.background ? … : '#ffffff'` always takes the first branch (background was just set).
  - [MIX] creator.ts:28-30,105-113 — persistence of player models (localStorage, `window.prompt`/`window.alert`) inside the panel builder.
  - [LAYER] creator.ts:4 — ui imports world/design.ts values (inference: allowed).
- **Superfície pública:** `CreatorActions`, `PRESETS`, `Creator` (el, show).
- **Exports nunca importados (b):** `CreatorActions`, `PRESETS`

#### `src/ui/css.d.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Declaração de módulo CSS para hud.ts:7–8 (órfão no grafo só porque .d.ts não é importado).
- **Responsabilidades (a-l):** L2 ambient module declaration for `*.css` imports.
- **Achados do leitor (a-l):**
  - [SMALL] css.d.ts:2 — one declaration; used by hud.ts:7-8 CSS imports.
- **Superfície pública:** ambient `declare module '*.css'`.

#### `src/ui/dom.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Construtores de DOM; ouvinte global instalado na importação (L203–208).
- **Responsabilidades (a-l):** L6–11 element builder; L14–37 button, rename, "soon" disabled state; L42–52 choice row; L55–67 option row, subhead; L70–95 stepper, slider row; L98–116 card, tab; L119–128 native select; L131–208 themed dropdown with keyboard, global outside-click closer; L211–220 text input; L223 swatch art.
- **Achados do leitor (a-l):**
  - [MIX] dom.ts:203-208 — import-time side effect (global document listener) in a builders module.
  - [R40COPY] dom.ts:142 — "Roadcraft 4.0 shell.ts:971-1040" reference (behaviour ported, comment only).
  - [TEXT] dom.ts:103 — card label strips a trailing "(...)" by regex to make the visible name.
  - [ALLOC] dom.ts:26 — `rename` spreads and reverses children per call (language change only).
- **Superfície pública:** `el`, `button`, `rename`, `soon`, `Choice`, `choices`, `orow`, `subhead`, `stepper`, `range`, `card`, `tab`, `select`, `closeDropdown`, `dropdown`, `textInput`, `swatchArt`.

#### `src/ui/drawers.ts`

- **Veredito: DIVIDIR** → src/features/<recurso>/drawer.ts (roads, zones, buildings, terrain, transit, demolition) + src/ui/drawers.ts (só o esqueleto)
- **Evidência e regra (coordenador):** Seis gavetas num arquivo de 47,7 KB (L190–676); ShellState é uma segunda cópia declarada de cada escolha das ferramentas (L3, L96–146, conferido); ids de zona e de placa duplicados (L55–60, L83–84); perfis achados pelo nome em português (L588, L606); dropdowns repetidos (L358–416).
- **Responsabilidades (a-l):** L26–49 dock categories and tool→category map; L51–85 zone colours/id mapping, ground/biome/tree/plant/effect/street/wall/sign/clothes tables; L87–93 builder/land/transit tab types; L96–146 ShellState (the shell's copy of every choice); L150–179 LineRow, BuildingInfo, DrawerHost, DrawerParts; L190–304 roads drawer (modes, blocks, snap, lanes/width/parking, height/cut, furniture, road keys, upgrade cards/catalogue, roundabout); L307–361 zones drawer (paint, lots, split); L364–418 build drawer (builder tabs, edit building, next style/fn); L421–585 landscape drawer (relief, ground, nature, sky/fog/weather, street furniture/walls/poles, people) + element rows; L588–666 transit drawer (tracks, stations, line list, colour, loop); L669–676 demolish drawer.
- **Achados do leitor (a-l):**
  - [MIX] drawers.ts:190-676 — six category drawers (roads, zones, build, landscape, transit, demolish) in one 47.7 KB file (close to the 50 KB new-file gate); each category's panel should live with its category.
  - [HOST] drawers.ts:3,96-146 — ShellState is an explicit second copy of every tool choice ("The shell keeps its own copy of every choice"); L434-437 re-syncs water/fog/weather from the engine on each render, others (radius, elevation, ring…) are pushed back by Hud setters — state kept in two places.
  - [TEXT] drawers.ts:588,606 — rail tool finds its profile by Portuguese display name (`'Ferrovia dupla'`, `'Metrô (duplo)'`) via `PROFILES.findIndex(x => x.name === …)`.
  - [DUP] drawers.ts:55-60 — zone ids hard-coded (5,6,1,7,8,2,3,4) duplicating roads/zones.ts `Zone` (comment L54).
  - [DUP] drawers.ts:358-359 and :415-416 — identical lot-use dropdown; :390 and :406 identical style dropdown; :388 and :407 identical function dropdown; :555-556 near-identical pole cards; :349-350 near-identical split choices.
  - [DUP] drawers.ts:83-84,560 — sign type ids as literals (`[0, 2, 9, 10]`) duplicating the SIGNS table semantics.
  - [NAME] drawers.ts:148-149 — duplicated doc comment on LineRow; L186-187 import + re-export placed mid-file.
  - [TEXT] drawers.ts:269 — hint keys per tool map; L592 mode name via array index `['bus','train','metro'][l.mode]`.
  - [ALLOC] drawers.ts:255 — `Math.max(...PROFILES.filter(...).map(...reduce))` recomputed every render of the upgrade drawer (player action only).
  - [R40COPY] drawers.ts:181,214,247,252,265,628 — references to 4.0 shell.ts line ranges (comments).
- **Superfície pública:** `CATS`, `categoriesOf`, `Category`, `BuilderTab`, `BuilderTabRender`, `LandTab`, `TransitTab`, `ShellState`, `LineRow`, `BuildingInfo`, `DrawerHost`, `DrawerParts`, `section` (re-export), `renderRoads`, `renderZones`, `renderBuild`, `landTabOf`, `renderLandscape`, `lineInfo`, `transitTabOf`, `renderTransit`, `renderDemolish`.
- **Exports nunca importados (b):** `LandTab`, `TransitTab`, `landTabOf`, `transitTabOf`

#### `src/ui/engine.css`

- **Veredito: JUNTAR** → src/ui/shell.css (uma folha de estilo com as variáveis de :root)
- **Evidência e regra (coordenador):** .v2-pill.on e .v2-act > span escritos nas duas folhas; o inspetor no painel lateral recebe display conflitante nas duas e o resultado depende da ordem de import; 3 classes sem uso (section-canvas, grid2, profile-art); estiliza .soon, botões 'em construção' visíveis ao jogador (dom.ts:34, drawers.ts:184, 378) — marcador de recurso faltando, proibido pelo CLAUDE.md.
- **Responsabilidades (a-l):** `L3–4` page base (html/body font, `#view` canvas); `L5–12` select/pill/act overrides for the v2 shell; `L16` hides the hint bar; `L19–21` side column/inspector layout; `L24–27` transit line rows; `L30–33,145–149` building slot + creator grid; `L36–54` dialog + `.v2-btn`; `L57–61` loading screen; `L64–77` F9 health panel; `L80–94` start screen; `L97–108` section editor; `L111–143` inspector pieces (cards, actions, chips, rows); `L151–159` About packs/licences; `L161` people swatch "any".
- **Achados do leitor (a-l):**
  - `[DEAD]` 3 of 76 class names never appear in src/ or index.html: `.section-canvas` L98, `.grid2` L99-100, `.profile-art` L139. All 3 ids used (`view`, `loading`, `loading-text`, index.html:12-14). (Generic tokens like `on`, `row`, `label` always match; no `v2-`/`rp-` class is built from a variable, grep.)
  - `[DUP]` with shell.css: `.v2-pill.on` L9 = shell.css:76 (same 3 declarations); `.v2-act > span` L12 = shell.css:43-44 (same sr-only block, already listed in that selector); `.v2-hintbar{display:none!important}` L16 parallels shell.css:159 `.v2-hint{display:none!important}` (the latter unused); `.v2-transit-line` split between L24-27 and shell.css:273-277; `.v2-side > .inspector` L20 vs shell.css:282 `.v2-side .inspector`.
  - `[BUG]` engine.css:20 vs shell.css:282 — same specificity (0,2,0), contradicting `display` (`flex` here, `block` there) and `gap`/`padding-right` vs `padding:0 !important`; result depends only on import order (src/ui/hud.ts:7-8 imports shell.css then engine.css). The `padding-right: 2px` here loses to shell's `padding: 0 !important`, so L20's padding never applies.
  - `[DUP]` the dark `select` look is written 5 times here (L5, L44, L106, L129, L147) plus shell.css:288-291: same height/padding/border/radius/background/color/`color-scheme: dark`, differing only in 28 vs 30 px and 7 px vs `--v-r-s`.
  - `[DUP]` button variants re-declared: `.v2-btn`/`.primary`/`:disabled` L50-54 vs `.inspect-actions button`/`.ins-btn` L120-124 vs shell.css `.rp-btn` 494-498 — three button systems with the same accent-fill/hover/disabled rules.
  - `[TEXT]` literals instead of tokens: `#10191b` L3 (= `--v-bg-solid`), `#4fe0bf` L59 (= `--v-accent`), `#a3b4b0` L60 (= `--v-muted`), `#ffb3aa` L61 (= `--v-danger-ink`), `rgba(14, 22, 24, 0.97)` L38 (also shell.css:383, 519) and `0.94` L83, `#ffc864` warning colour L69, L74 (no token exists), `rgba(5, 16, 18, 0.55)` L116, L131, `#4aa3e8` L133, L137, `#4ee08a` L134, `#ff5b50` L136, font stack L3 (repeated 8× in shell.css).
  - `[BUG]` engine.css:122 `rgba(255, 111, 99, 0.4)` — danger tint uses 99 where every other danger rgba (shell.css:66,132,294,487-488) and `--v-danger` (#ff6f61 = 255,111,97) use 97: off-by-two colour.
  - `[DEV]` engine.css:8 `.v2 .soon { opacity: .38; cursor: help }` styles placeholder controls ("being built", `ui.soon`/`ui.soon.buildings`, applied at src/ui/dom.ts:34, src/ui/drawers.ts:184,378) — a visible placeholder state, forbidden by CLAUDE.md ("placeholders").
  - `[DEV]` engine.css:63 comment calls the F9 health panel "The developer's F9 panel" (player-facing key `health.button` 'Game health (F9)'); whether 4.0 shows it is not verified here.
  - `[MIX]` engine.css:3-4 page/canvas base rules (`html, body`, `#view`) live in a UI-panel stylesheet.
- **Superfície pública:** stylesheet imported by src/ui/hud.ts:8.

#### `src/ui/health.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Painel de desenvolvedor F8/F9; decisão de mantê-lo é do dono (CLAUDE.md proíbe UI de depuração além da referência); aceita 'erro'/'lento' além de 'error'/'slow' (L88–89).
- **Responsabilidades (a-l):** L9–18 entry/tab/source types; L23–83 developer health panel (tabs, copy to clipboard, close, window error/rejection listeners); L88–96 record error/slow frame; L101–118 open/close with 1 s refresh; L121–126 level for the button dot; L128–142 render rows.
- **Achados do leitor (a-l):**
  - [DEV] health.ts:1-4 — developer panel (F9/F8), "not in the player's top bar"; debug UI beyond the 4.0 reference (inference) shipped in product code.
  - [NAME] health.ts:88-89 — `add` accepts Portuguese aliases `'erro' | 'lento'` besides `'error' | 'slow'` (legacy magic strings).
  - [ALLOC] health.ts:131-141 — filter/reverse/slice/map per 1 s refresh while open (dev panel only).
- **Superfície pública:** `HealthTab`, `HealthSources`, `HealthPanel` (add, frame, toggle, show, close, level, open, shownTab, context, root).
- **Exports nunca importados (b):** `HealthTab`, `HealthSources`

#### `src/ui/hud.ts`

- **Veredito: DIVIDIR** → src/ui/hud.ts (barra e dock) + src/ui/popovers.ts + src/ui/toasts.ts + src/ui/loading.ts + src/ui/tooltips.ts
- **Evidência e regra (coordenador):** 45,8 KB com barra, dock, popovers, dicas, toasts e tela de carregamento (L124–797); chamada opcional por duck typing a languageChanged 'enquanto não chega' (L321).
- **Responsabilidades (a-l):** L29–32 tool groups; L37–54 help key tables; L56–122 Hud fields; L124–310 constructor: top bar (sky, clock, money, impossible junctions, stats, speed, inside bar, layer/sim/camera/undo/redo/health/help/menu), popover closer, file input, dock, drawer/tool options, side panel, hint, toasts, tooltip, compass, resize/mutation observers and fade, DrawerHost, relabel list; L313–326 relabel on language change; L330–400 categories, setTool, render (drawer dispatch); L403–424 fit drawer layout; L427–468 popovers, help, file, about, escape; L478–587 popover contents (menu, layers, sim, camera readout timer, help keys); L589–604 sim metrics; L608–643 custom tooltips; L646–797 game→HUD setters (lines, radius, profile, sky, lot mode, builder tabs, building, elevation, ring, zone radius, inside, clock, speed, money, status, layers, compass, hint, history, view, toast, loading); L801–806 fade edges; L809 re-export keyName.
- **Achados do leitor (a-l):**
  - [MIX] hud.ts:124-797 — 45.8 KB/810 lines: top bar, dock, drawer layout, popovers (menu/layers/sim/camera/help), tooltip system, toasts, loading screen, all game→HUD setters in one class (god-ish UI file near the 50 KB gate).
  - [NAME] hud.ts:136,307 — sky modes `'dia' | 'noite' | 'ciclo'`; L498 quality ids `'baixo' | 'medio' | 'alto' | 'ultra'` mapped to English keys inline; L525 demand `'baixa' | 'pico'`; L200 file extension `.cidade` — Portuguese identifiers/values.
  - [TEXT] hud.ts:290 — road key names shortened by replacing the strings 'Page Up'/'Page Down'; L533 camera labels stripped by regex `/\s*[(·].*$/` from translated text; L322-323,357-359 hint existence detected by `t(key) !== key`.
  - [HOST] hud.ts:321 — `(this.catalog as { languageChanged?: () => void }).languageChanged?.()` duck-typed optional call "absent before that lands" (cross-session placeholder).
  - [DEAD] hud.ts:27 — `declare const __BUILD__` unused in this file; L34-35 orphan doc comment with no declaration; L670 empty line inside setSky.
  - [DEV] hud.ts:181-184,503,574 — developer-only health button, "test city" menu row and dev key help gated by `a.developer()`.
  - [ALLOC] hud.ts:648,656 — `setLines` builds a string key over all rows and a joined number string on every call (inference: called with each status, twice a second); L660 querySelector per row.
  - [ALLOC] hud.ts:415-418 — fitDrawer forces layout reads per card on every render (player action only).
  - [R40COPY] hud.ts:226,243,263-264,289,292,320,367,387,411,464,487,497,532,550 — references to 4.0 v2/shell.ts line ranges (comments).
  - [SMALL] hud.ts:797 — `static dec` only forwards to fmtDec; L809 re-exports keyName from keys.ts.
- **Superfície pública:** `TERRAIN_TOOLS`, `GROUND_TOOLS`, `ROAD_TOOLS`, `Hud` (catalog, side, buildingSlot, openCategory, setTool, toggleHelp, helpOpen, openFile, aboutOpen, closeAbout, escape, setLines, setRadius, setProfile, setBiome, setSky, setLotMode, registerBuilderTab, setBuilding, setElevation, setRing, setZoneRadius, setInside, setClock, setMoney, setStatus, setTrafficView, setGrid, setCompass, setHint, setHistory, setView, toast, showLoading, hideLoading, dec), re-exported types from hudActions, `keyName`.
- **Exports nunca importados (b):** `CityStatus`, `SimSettings`, `WeatherCtl` (nem no arquivo)

#### `src/ui/hudActions.ts`

- **Veredito: DIVIDIR** → contratos por recurso em src/features/<recurso>/actions.ts, unidos em src/ui/hudActions.ts
- **Evidência e regra (coordenador):** Uma interface com 85 métodos de todos os recursos (L48–133); importa tipo de render/people/creator.ts (L5, vazamento de camada ui→render medido pelo inventário).
- **Responsabilidades (a-l):** L6–23 shell types (RoadKeys, Category, Tool, SkyMode, SkyToolState, WeatherCtl, LotMode, SimSettings, CityStatus); L26–46 optional actions published by other fronts; L48–133 HudActions contract (≈85 methods the game implements).
- **Achados do leitor (a-l):**
  - [LAYER] hudActions.ts:5 — ui imports a type from `render/people/creator.ts` (`ReturnType<typeof creatorCatalog>`): UI contract depends on a render module.
  - [NAME] hudActions.ts:10,16 — `SkyMode = 'ciclo' | 'dia' | 'noite'`, `demand: 'baixa' | 'normal' | 'pico'` Portuguese values.
  - [MIX] hudActions.ts:48-133 — one interface spans every feature (85 methods); every tool's actions funnel through game.ts (inference: game.ts implements all).
  - [DEV] hudActions.ts:77,128-129 — `testCity`, `health`, `developer` in the player action contract.
- **Superfície pública:** `RoadKeys`, `Category`, `Tool`, `SkyMode`, `SkyToolState`, `WeatherCtl`, `LotMode`, `SimSettings`, `CityStatus`, `OptionalActions`, `HudActions`.
- **Exports nunca importados (b):** `OptionalActions`
- **Ações usadas pelas ferramentas (b):** `buildingFn`, `clearClouds`, `flattenMap`, `fogLevel`, `follow`, `grid`, `help`, `impossibleList`, `impossibleNodes`, `lotLine`, `lotMode`, `lotSplit`, `newMap`, `north`, `openPreviousCity`, `options`, `peopleCatalog`, `previousCities`, `scatterClouds`, `settings`, `sky`, `speed`, `style`, `tool`, `trafficView`, `view`, `water`, `weather`, `zone`, `zoneFill`

#### `src/ui/icons.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Ícones SVG; 13 nomes sem uso (L4…L185) e caminhos idênticos repetidos (L117/L158, L124/L156); nome desconhecido vira SVG vazio sem erro (L215).
- **Responsabilidades (a-l):** L3–211 icon path table (≈200 entries); L214–216 SVG string builder.
- **Achados do leitor (a-l):**
  - [DUP] icons.ts:124 vs :156 — `ls_meadow` and `el_grass` identical paths; :117 vs :158 `ls_shrub` and `el_scrub` identical; :47 `frame` vs :209 `resetView` same frame path (plus dot).
  - [DEAD] icons.ts:4,24,49-53,94-96,113,115,124,126,12,183,185 — `player`, `sim`, `hide`, `check`, `car`, `crowd`, `demand`, `walls`, `radius`, `strength`, `poles`, `streetscape`, `ls_meadow`, `ls_streetname`, `tr_bay`, `m_language`, `profile` not referenced in this batch's UI files (inference: may be used by other panels; needs a grep).
  - [BUG] icons.ts:215 — unknown icon name silently yields an empty SVG (`?? ''`); a typo in a name shows a blank button with no error.
  - [NAME] icons.ts:3 — mixed naming conventions (`tr_`, `ls_`, `el_`, `m_`, `park-…`, camelCase).
- **Superfície pública:** `ICON`, `svg`.
- **Exports nunca importados (b):** `ICON`

#### `src/ui/inspector.ts`

- **Veredito: DIVIDIR** → src/features/roads/inspector/roadPanel.ts, nodePanel.ts, junctionControl.ts, laneConnectors.ts, greenWave.ts + src/ui/widgets.ts (segmented/toggle/stepper)
- **Evidência e regra (coordenador):** Cinco painéis numa classe (L170–707), 47,8 KB rente ao limite; raise()/raiseNode() iguais (L508–513, L688–693); widgets iguais a roadCatalog.ts:956–989 (L729–760); fórmula do ciclo do semáforo copiada de sim/traffic.ts (L245, L536); rótulos de comando em português.
- **Responsabilidades (a-l):** L23–41 host interface `InspectActions`; L43–59 control choices, 4.0 signal limits, compass leg names; L61–168 Inspector class: pick (nearest node/seg), close, refresh, live probe readouts (node, road); L170–367 junction / height-point / dead-end panels (cards, control, legs rules, signal greens/offset, movements bans); L369–389 turn classification and screen-relative leg names; L391–487 lane-connector plan (SVG string built by hand, keyboard focus); L489–545 edit/crossing/raise/green-wave commands; L547–707 road panel (cards, numbering, name, profile summary, end heights, dead-end shape, parking per side, curvature sliders, actions, bend); L710–796 DOM widget helpers (btn, chip, segmented, toggle, stepper, range, select, cards).
- **Achados do leitor (a-l):**
  - [MIX] inspector.ts:170–707 — one class holds road panel, node panel, junction control/signal editor, lane-connector editor and green-wave planner; file 47 810 B, just under the 50 KB new-file gate.
  - [DUP] inspector.ts:508–513 `raise()` and :688–693 `raiseNode()` are the same journal code (one uses `this.node`).
  - [DUP] inspector.ts:222–230 (dead-end chips) and :609–622 (dead-end select) repeat the same JunctionSpec "end" merge logic.
  - [DUP] inspector.ts:245 and :536 the signal cycle formula `Math.max(5, g) + 4.5` and default green 20 s duplicated (comment L241 says it mirrors sim/traffic.ts); note `Math.max(5, …)` vs `GREEN_MIN = 6` (L46).
  - [DUP] inspector.ts:729–752,754–760 `segmented`/`toggle`/`stepper` are the same widgets as roadCatalog.ts:956–989 `edSeg`/`edToggle`/`edStepper`.
  - [TEXT] inspector.ts:148,205,207,228,277,303,306,317,327,332,336,361,472,483,509,527,617,689 — command labels are hard-coded Portuguese strings ('controle do cruzamento', 'onda verde', 'altura do nó'…), not English and not i18n keys.
  - [BUG] (inference) inspector.ts:527–541 — `greenWave` calls `j.setJunction` on each node, then returns without pushing when `count < 2`; if `RoadJournal.setJunction` applies immediately (roads/build.ts, not in this batch), the single changed junction stays changed with no undo entry.
  - [BUG] (inference) inspector.ts:148–153 — `apply()` pushes the journal without `settle()`, unlike `edit`/`raise`/`demolish` (L493, :511, :681); if settle is what finalises/charges a journal, junction edits skip it.
  - [ALLOC] inspector.ts:267,572 — `setInterval` probe every 2 s / 1 s while open (UI cadence, not per frame) [OK-ish]; `showNodeProbe` L129 does a `querySelector` per leg per probe.
  - [DEV] inspector.ts:764–765,774 — inline `style.cssText` "until the interface's stylesheet has the rule": a temporary layout committed.
  - [LAYER] inspector.ts:81 — constructor reaches into the DOM by class (`.v2-side` / `#hud`) instead of being given its parent.
  - [R40COPY] inspector.ts:45,122,185,194,247,269,279,294,309,339,380,392,554,557,574,587,603,608,624,639,651 — every block cites Roadcraft 4.0 file:line (port references of values/behaviour; no copied code seen).
- **Superfície pública:** `InspectActions` (host callbacks), `Inspector` (pick/close/refresh/showProbe/showNodeProbe, `node`/`seg`, `isOpen`).
- **Exports nunca importados (b):** `InspectActions`

#### `src/ui/keys.ts`

- **Veredito: MANTER** → src/ui/keys.ts
- **Evidência e regra (coordenador):** Tabela de teclas; CAMERA_CODES mantida à mão igual a render/cameraRig.ts (L76) deve vir de um lugar só; F8/F9 de desenvolvedor (L51–55).
- **Responsabilidades (a-l):** L10–64 key rule / deps types; L66–77 dock keys, tool keys, camera codes tables; L79–109 game key table (`GAME_KEYS`); L111–131 rule list (dialog → F-keys → Escape ladder → Ctrl keys → tool keys → plain → dock → tools → camera); L133–157 key names, help lists, reserved keys; L159–188 single window keydown/keyup/blur listener and matcher.
- **Achados do leitor (a-l):**
  - [DEV] keys.ts:51–55,107–108 — F9 health panel and F8 changes panel are developer panels shipped in the key table, gated by `d.developer()`.
  - [TEXT] keys.ts:113,115 — F-key rules picked by regex on the code string `/^F\d/`; keys.ts:140 — whether a label is a dictionary key is decided by `label.includes('.')`.
  - [DUP] keys.ts:76 `CAMERA_CODES` must match render/cameraRig.ts (comment says it reads "the same codes"): two lists kept by hand.
  - [BUG] (inference) keys.ts:166 — F5 / Ctrl+R are swallowed before the "typing in a box" check, so they are blocked everywhere (intended per comment); Ctrl+Shift+R also blocked.
- **Superfície pública:** `KeyResult`, `KeyRule`, `GameKeyDeps`, `DOCK_KEYS`, `TOOL_KEYS`, `CAMERA_CODES`, `gameKeyRules`, `keyName`, `keyHelp`, `reservedKeys`, `installKeys`.

#### `src/ui/menu.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Tela inicial; lê globalThis.roadcraftApp direto (L69) em vez de platform/.
- **Responsabilidades (a-l):** L9–14 menu actions interface; L16–80 StartMenu: seed field, map size select (disables sizes above texture layers), new/empty/load/options/quit buttons, language chips, rebuilt on language change.
- **Achados do leitor (a-l):**
  - [TEXT] menu.ts:39 — brand "Road"/"craft" hard-coded (brand, acceptable); menu.ts:46 — `tiles >= 10` magic filter of MAP_SIZES.
  - [LAYER] menu.ts:69 — reads `globalThis.roadcraftApp` (Electron preload bridge) directly from a UI module instead of `platform`.
- **Superfície pública:** `MenuActions`, `StartMenu` (root, open, show, hide).
- **Exports nunca importados (b):** `MenuActions`

#### `src/ui/options.ts`

- **Veredito: DIVIDIR** → src/platform/settings.ts (carregar/gravar, PRESETS) + src/ui/options.ts (diálogo)
- **Evidência e regra (coordenador):** Persistência (L48–77) e diálogo juntos; captura das teclas de via duplicada com roadKeysPanel.ts:10,82–95 (L169–196); valores e chave de armazenamento em português ('baixo', 'cidade.opcoes').
- **Responsabilidades (a-l):** L7–34 Settings type; L36–46 reserved keys, road-key defaults, quality presets; L48–77 load/save in localStorage with address-override bookkeeping; L79–234 OptionsPanel dialog (preset, resolution, detail, shadows, AO, bloom, demand, traffic, people, paint, furniture, road keys capture, weather, language, volume, fullscreen, extra buttons, GPU name, apply/close).
- **Achados do leitor (a-l):**
  - [NAME] options.ts:7,10,18,22,48,152,162,199 — option values and storage key in Portuguese ('baixo','medio','alto','personalizado','limpo','chuva','tempestade','baixa','pico','cidade.opcoes').
  - [TEXT] options.ts:22 + readouts.ts:16 — demand strings 'baixa'/'pico' shared across files as magic values.
  - [TEXT] options.ts:199 — rain label made by regex-stripping a translated string `t('weather.rain').replace(/\s*\(.*$/, '')`.
  - [DUP] options.ts:169–196 road-key capture (reserved check, defaults PageUp/PageDown/KeyV at L39, L194–196) duplicates roadKeysPanel.ts:10,82–95.
  - [MIX] options.ts — settings persistence (L48–77) and the dialog UI in one file.
  - Notes: options.ts:60 compatibility (non-WebGPU) forces Low preset; :61–62 'auto' weather forced to clear on load (owner decision 2026-10-19 cited).
  - Style inconsistency: builds DOM with raw `document.createElement` instead of `dom.ts` helpers used by the other ui files.
- **Superfície pública:** `Preset`, `Settings`, `PRESETS`, `defaultSettings`, `loadSettings`, `keepOverAddress`, `saveSettings`, `OptionsPanel`.
- **Exports nunca importados (b):** `defaultSettings`

#### `src/ui/panelParts.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Uma função que existe para quebrar um ciclo de runtime entre drawers.ts e peoplePanel.ts (conferido no comentário L1–2); juntar recria o ciclo.
- **Responsabilidades (a-l):** L6–14 `section(strip, label)` builds a titled card group.
- **Achados do leitor (a-l):**
  - [SMALL] panelParts.ts — one function; caller peoplePanel.ts:8,59,62 (and drawers.ts per comment L1–2); split exists only to break a runtime cycle.
- **Superfície pública:** `section`.

#### `src/ui/peoplePanel.ts`

- **Veredito: MOVER** → src/features/people/peoplePanel.ts
- **Evidência e regra (coordenador):** Painel de um recurso; PeopleHost expõe o estado inteiro da gaveta (L15–19); send() roda a cada render (L32, L56).
- **Responsabilidades (a-l):** L13–20 host/parts interfaces; L22–51 simple creator (before cooked people load: colour, height, behaviour, count); L52–76 cooked creator (outfit cards, behaviour cards, sex/age/top/bottom/hair/height/count/hold/mixed); L79–85 outfit display name; L87–103 colour swatches.
- **Achados do leitor (a-l):**
  - [HOST] peoplePanel.ts:15–19 — `PeopleHost` exposes the drawer's whole state `s` and `render()`; the panel mutates host state directly (L29, L39, L54).
  - [BUG] (inference) peoplePanel.ts:32,56 — `send()` runs on every render, pushing personSpec/personOptions to the host each time the drawer re-renders (side effect inside render).
  - [TEXT] peoplePanel.ts:81 — outfit names parsed by regex from asset file names (`male_casualsuit03`).
  - Magic: peoplePanel.ts:43 height formula `(0.86 + v*0.02)*1.75`; L48 count choices 1/2/5/10/20; L64 group min 6.
- **Superfície pública:** `renderPeople`, `outfitName`.
- **Exports nunca importados (b):** `outfitName`

#### `src/ui/readouts.ts`

- **Veredito: DIVIDIR** → zoomPercent → src/ui/readouts.ts; demandFactor → src/sim/demand.ts
- **Evidência e regra (coordenador):** demandFactor (simulação) dentro do módulo de leituras da câmera (L15–17); 'baixa'/'pico' compartilhados com options.ts:22.
- **Responsabilidades (a-l):** L3–7 zoom percent; L9–12 centre text; L14–17 demand factor.
- **Achados do leitor (a-l):**
  - [SMALL] readouts.ts — three pure helpers (callers not visible in batch).
  - [MIX] readouts.ts:15–17 — `demandFactor` (simulation) sits in a camera-readout module.
  - [TEXT] readouts.ts:16 — 'baixa'/'pico' magic strings shared with options.ts:22.
- **Superfície pública:** `zoomPercent`, `centreText`, `demandFactor`.

#### `src/ui/roadCatalog.ts`

- **Veredito: DIVIDIR** → src/features/roads/catalog/catalogPanel.ts, sectionPainter.ts, sectionEditor.ts, templates.ts (gravar modelos)
- **Evidência e regra (coordenador):** 61 KB (acima de 50 KB) com painel, pintura em canvas, SVG, editor e persistência; cada SectionEditor adiciona um ouvinte de resize nunca removido (L526, conferido) e languageChanged cria um editor novo a cada troca (L349–356); issues() 3× por render (L636–876).
- **Responsabilidades (a-l):** L15–33 category/strip/turn tables, storage key; L35–45 templates in localStorage; L47–51 profile name helpers; L53–133 `topSwatch` canvas painter (road seen from above → PNG data URL); L135–272 `sectionSvg` cross-section SVG generator (cars, people, trees, labels, flags, handles); L274–463 RoadCatalog (tabs, cards, art cache, templates, editFor, language rebuild); L465–915 SectionEditor (cards, stage drawing, edge/strip drag, props panel, issues, save/draw/apply); L917–989 icon set and widget helpers; L991–999 problem texts.
- **Achados do leitor (a-l):**
  - [MIX] roadCatalog.ts — 60 976 B / 1001 lines: catalogue panel + canvas painter + SVG section renderer + full section editor + template persistence in one file; above the 50 KB new-file gate.
  - [BUG] roadCatalog.ts:526 — each `SectionEditor` adds a window `resize` listener that is never removed; `languageChanged()` (L349–356) creates a new editor every language switch, so old editors stay referenced and keep running `place()` on a detached element.
  - [BUG] roadCatalog.ts:612–621 — `state()`/`restore()` drop `apply` and the docked class: an editor opened from the inspector ("this road") becomes a "new roads" editor after a language change (L618 forces `newRoads`), so Apply is lost.
  - [ALLOC] roadCatalog.ts:709–729,652–668 — every pointermove during a drag rebuilds the full SVG string and `innerHTML`, recomputes `issues()` (→ `fromWork` + `profileIssueSpots`) and `stageSize()` reads layout (`clientWidth`) via `svgX`; L681 builds a whole SVG only to get spans/ppm.
  - [DUP] roadCatalog.ts:636–642,657,876 — `issues()` computed 3× per render (drawStage, renderProps, renderFoot).
  - [DUP] roadCatalog.ts:956–989 widgets duplicate inspector.ts:729–760; roadCatalog.ts:918–932 own icon set alongside ui/icons.ts `svg()`; L454 inline pencil SVG; roadKeysPanel.ts:47 same close path.
  - [DUP] roadCatalog.ts:410 — fallback cost `width * 60` for templates (a price rule outside roads/profiles.ts).
  - [NAME] roadCatalog.ts:15–16,28,280,329,760 — category ids and storage key in Portuguese ('ruas','avenidas','meus','trilhos','cidade.modelosDeVia').
  - [LAYER] roadCatalog.ts:298,604 — appends to `#hud` / queries `.v2-drawer` by selector.
  - [OMAP] (minor) roadCatalog.ts:379,393,402 — scans all PROFILES on each build (profile count, not city size).
  - [R40COPY] roadCatalog.ts:135,143–159,327,375,381,485–491,583–601,677,741,786,816,845,873,917 — 4.0 file:line references for colours and layout (values, no copied code seen).
- **Superfície pública:** `CatalogActions`, `profileName`, `topSwatch`, `sectionSvg`, `RoadCatalog` (visible, select, editFor, languageChanged, editor).
- **Exports nunca importados (b):** `CatalogActions`

#### `src/ui/roadKeysPanel.ts`

- **Veredito: JUNTAR** → src/features/roads/roadKeys.ts (uma regra de teclas reservadas com options.ts)
- **Evidência e regra (coordenador):** Padrões e regra de tecla reservada duplicados de options.ts:39,180–181 (L10, L90).
- **Responsabilidades (a-l):** L9–11 defaults and rows; L13–21 open state, close, isOpen; L23–105 panel: chips per key, capture of next key (capture-phase listener with AbortController), reserved-key refusal, reset, placement next to anchor.
- **Achados do leitor (a-l):**
  - [DUP] roadKeysPanel.ts:10,90 duplicates options.ts:39,180–181 (defaults and the reserved-key rule).
  - [LAYER] roadKeysPanel.ts:102 — appends to `#hud` by id.
  - Magic: L100 panel width 276 px hard-coded for placement.
- **Superfície pública:** `closeRoadKeys`, `roadKeysOpen`, `openRoadKeys`.
- **Exports nunca importados (b):** `roadKeysOpen` (nem no arquivo)

#### `src/ui/shell.css`

- **Veredito: MANTER** → src/ui/shell.css (recebe engine.css)
- **Evidência e regra (coordenador):** Folha principal; 14 classes sem uso (bloco rp-junction/rp-lock/rp-moves, v2-verb, v2-group, inspect-select…); ~43 var(--v-*, reserva) repetem valores do próprio :root; select escuro escrito 6 vezes; três sistemas de botão; cor de perigo 111/99 × 111/97.
- **Responsabilidades (a-l):** `L3–25` design tokens `--v-*`; `L28–45` base + sr-only; `L48–80` HUD; `L83–117` popovers/help; `L120–134` dock; `L137–221` drawer, tabs, strip, cards, swatches, verbs; `L224–270` tool options rows/choices/steppers/acts/groups/search/swatches; `L273–277` transit rows; `L281–295` side/inspector; `L298–302` tooltip/toasts; `L305–323,372–374` responsive; `L326–341` custom dropdown; `L344–354` misc; `L358–371` compass; `L378–534` road panels (profile editor, palette, props, switch, issue, footer, summary, keys panel); `L537–573` cutting seg, lane connector art, junction panel; `L577–581` docked editor; `L585–607` road catalogue; `L610–613` V7/V8 tweaks.
- **Achados do leitor (a-l):**
  - `[DEAD]` 14 of 190 class names never appear in src/ or index.html: `.v2-verb` L213-220, `.v2-more` L113-114, `.v2-help` L115-117, `.v2-title` L150, `.v2-hint` L159, `.v2-style` L211-212, `.v2-group` L261-262/264, `.inspect-select` L287-292, `.rp-card-blank` L425-426, `.rp-junction` L555-565, `.rp-lock` L566, `.rp-moves` L570-571, `.rp-seg-tight` L610, `.rp-summary-actions` L613 (~45 lines of dead rules; the "docs/VIAS.md V5" junction panel block is entirely unused).
  - `[R40COPY]` shell.css:1-2 — header says it is 4.0's `src/ui/v2/shell.css`, `roads/roads.css` and parts of `app.css`; comments cite "docs/VIAS.md V3/V4/V5/V7/V8" (L516, L540, L554, L609, L612).
  - `[DUP]` the "panel reset" (box-sizing, `button{font;color;cursor}`, `:disabled` opacity .35, `:focus-visible` accent outline, panel font) is written 5 times: L29-34 (`.v2`), L393-396 (`.rp-panel`), L523-524+534 (`.rp-keys`), L556-559 (`.rp-junction`), L586-587 (`.rc-catalog`).
  - `[DUP]` panel chrome `background: rgba(14,22,24,0.97)` + border + radius + shadow + font repeated at L378-387 (`.rp-panel`) and L517-522 (`.rp-keys`); engine.css:38 again.
  - `[DUP]` `.rp-btn` re-declared with near-identical values 3 times: L532 (`.rp-keys`), L552 (`.rp-connectors`), L564 (`.rp-junction`); `.rp-junction .rp-block` L560 = `.rp-summary` L504 (same border/background literals).
  - `[DUP]` two implementations each of: switch (`.v2-switch` L90-95 / `.rp-switch` L481-485), segmented control (`.v2-seg` L58-64 / `.rp-seg` L467-474), stepper (`.v2-stepper` L252-254 / `.rp-step` L476-479), sr-only block (L42-45, L67, engine.css:12; also inline at src/ui/roadCatalog.ts:456).
  - `[TEXT]` 43 `var(--v-*, fallback)` uses in L379-603 repeat the `:root` values of L3-25 of this same file (e.g. `var(--v-text, #eef4f2)`, `var(--v-accent, #4fe0bf)`): redundant fallbacks that will silently diverge if a token changes.
  - `[TEXT]` raw literals for existing tokens: `#ff6f61` L369 (= `--v-danger`), `rgba(79,224,191,…)` accent alphas L93, 195, 218, 434, 484, 573 (only .14/.5 are tokens), `rgba(255,111,97,…)` danger alphas L66, 132, 294, 487-488 (no token), scrollbar colour `rgba(255,255,255,0.18) transparent` 6× (L145, 165, 228, 337, 411, 593) with two copies of the webkit scrollbar rules (L167-168, L412-414), font stack `Inter, ui-sans-serif, "Segoe UI", Roboto` 8× (L28, 371, 386, 436, 438, 521, 555, 585). Hard-coded geometry instead of tokens: `.rp-keys` `left: 330px; bottom: 80px` L518, `.v2-side` width 340px L281 vs `right: 364px` L391 (340+12+12 hand-derived), `.rp-panel.docked bottom: 160px` L577, toolopts `+ 160px` L322.
  - `[BUG]` (inference) shell.css:379 `.rp-panel` z-index 40 equals `#loading` z-index 40 (engine.css:57); stacking then depends on DOM order, and `.rp-keys` (z 41, L518) sits above the loading screen.
  - `[DUP]` shell.css:282 vs engine.css:20 — conflicting rules for the same element (see engine.css finding).
  - `[SMALL]`/size: 49,724 bytes — just under the 50 KB "new file" gate of `npm run arch:check`.
- **Superfície pública:** stylesheet imported by src/ui/hud.ts:7; defines the `--v-*` tokens used by engine.css and by inline styles.

#### `src/ui/touch.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Gestos de toque; uma responsabilidade.
- **Responsabilidades (a-l):** L6–9 zoomable interface; L11–56 two-finger pinch zoom (capture-phase pointer listeners, synthetic pointercancel for the first finger).
- **Achados do leitor (a-l):**
  - [ALLOC] touch.ts:16,41 — `[...touches.values()]` arrays per pointermove while pinching (input path, small).
- **Superfície pública:** `attachPinch`.

#### `src/ui/transitNames.ts`

- **Veredito: MOVER** → src/features/transit/names.ts
- **Evidência e regra (coordenador):** Uma função do recurso transporte; O(linhas) por chamada (L7).
- **Responsabilidades (a-l):** L5–9 line name by ordinal within mode.
- **Achados do leitor (a-l):**
  - [SMALL] transitNames.ts — one function.
  - [OMAP] (inference) transitNames.ts:7 — O(lines) per call; naming every line in a list is O(n²) in line count.
- **Superfície pública:** `lineName`.

#### `src/world/arch.ts`

- **Veredito: DIVIDIR** → src/world/buildings/arch.ts (estilos) + src/world/buildings/civic.ts (Fn, FN_BY_ZONE, civicFor) + nomes para i18n
- **Evidência e regra (coordenador):** Estilos, funções cívicas e chaminés num módulo; FN_NAMES em português fora do i18n (L30–33); PANE_ROW = 13*9+132 fixo (L142) e CAT_ROW0 = 117 em catalogFacade.ts:16: contagem escrita duas vezes; archWindowTable sem chamador (L18–20).
- **Responsabilidades (a-l):** L9–15 style ids and re-export of archData; L17–20 window table per style; L22–42 building functions (Fn), Portuguese names, weights per zone; L44–59 civic function per cell (hash); L61–71 warehouse chimney; L73–102 style by era/zone/seed; L104–123 facade patterns; L125–142 window table per facade id, PANE_ROW.
- **Achados do leitor (a-l):**
  - [MIX] arch.ts — architecture styles, civic building functions (Fn, FN_BY_ZONE, civicFor) and chimney placement in one module.
  - [TEXT] arch.ts:30–33 — `FN_NAMES` player-facing Portuguese names outside i18n.
  - [DUP] arch.ts:142 `PANE_ROW = 13 * 9 + 132` hard-codes ARCH_COUNT×PATTERN_COUNT and the catalog row count (132) instead of computing from `catalogWindowRows().length`; catalogFacade.ts:16 `CAT_ROW0 = 117` repeats 13×9 (checked there at L52, not here).
  - [DUP] arch.ts:110–120 PATTERNS names repeat catalogFormat.ts:16 CAT_PATTERNS.
  - [NAME] arch.ts:13 import placed mid-file after an export.
  - [DEAD] (inference) arch.ts:18–20 `archWindowTable` — superseded by `facadeWindowTable` (L126); no caller visible.
- **Superfície pública:** `ArchId`, `Fn`, `FN_NAMES`, `civicFor`, `chimneyOf`, `pickArch`, `eraAt`, `archFor`, `Pattern`, `PATTERNS`, `facadeArch`, `facadePattern`, `facadeWindowTable`, `archWindowTable`, `PANE_ROW`, re-exports from archData.

#### `src/world/archData.ts`

- **Veredito: MOVER** → src/world/buildings/archData.ts
- **Evidência e regra (coordenador):** Dados de estilo; nomes em português (L46–79) passam a chaves de i18n.
- **Responsabilidades (a-l):** L5–12 counts and enums (Win, Balcony, Crown); L14–39 Arch type; L41–82 the 13 style records; L84 pattern count.
- **Achados do leitor (a-l):**
  - [NAME] archData.ts:46–79 — style names in Portuguese ('Modernista','Contemporâneo','Tijolinho','Envidraçado','Bangalô'…); if shown to the player they bypass i18n.
  - [R40COPY] archData.ts:41 — window shares and paints taken from 4.0 architecture.ts:44–178 (values).
- **Superfície pública:** `ARCH_COUNT`, `Win`, `Balcony`, `Crown`, `Arch`, `ARCHES`, `PATTERN_COUNT`.

#### `src/world/brush.ts`

- **Veredito: MOVER** → src/features/terrain/brush.ts
- **Evidência e regra (coordenador):** Pincel de terreno é recurso; FlattenMap não sincroniza a água (L67–77) enquanto BrushStroke sincroniza (L151–175); padrão 'escrever alturas + água + marcar ladrilhos' igual a ground.ts:228–247.
- **Responsabilidades (a-l):** L12–21 modes and params; L23–35 dirty marking for sample rectangles; L37–43 tile bounds, smoothstep; L45–78 FlattenMap command (whole map, 16-bit undo); L80–230 BrushStroke command (dab per mode incl. landforms, water sync, finish into typed arrays, apply/invert by touched cells).
- **Achados do leitor (a-l):**
  - [OMAP] brush.ts:49–78 — FlattenMap touches every sample and tile (stated: whole-map edit by player request, once).
  - [BUG] (inference) brush.ts:67–77 — FlattenMap changes heights but never syncs water (BrushStroke does it at L151–175 to avoid water stripes over raised land); flattening above a lake leaves the water grid as it was.
  - [BUG] (minor) brush.ts:131–136 — 'smooth' reads neighbours already updated in the same pass (in-place), giving a directional bias.
  - [ALLOC] brush.ts:116,165–168 — Map inserts per touched sample per dab (edit path; bounded by brush radius).
  - [TEXT] brush.ts:50,81 — command labels in Portuguese ('aplainar mapa', 'pincel de terreno').
  - [DUP] brush.ts:202–220 vs ground.ts:228–247 — same "write heights + water, mark tiles" pattern; brush marks by touched cells, river by bounding box.
- **Superfície pública:** `BrushMode`, `LANDFORM_ROCK`, `BrushParams`, `TERRAIN_FOLLOWERS`, `FlattenMap`, `BrushStroke`.

#### `src/world/catalog.ts`

- **Veredito: JUNTAR** → src/world/buildings/catalog.ts (com catalogFormat.ts)
- **Evidência e regra (coordenador):** Uma função + export * de catalogFormat (L1–19): dois módulos formam uma entrada.
- **Responsabilidades (a-l):** L3–6 JSON import, re-export of the format; L8–12 base64 decode; L14–18 lazy decode once per context.
- **Achados do leitor (a-l):**
  - [SMALL] catalog.ts — one function + `export *` of catalogFormat (two modules form one public entry).
  - (inference) catalog.ts:16–17 — every worker and the page decode and keep their own copy of the 38 projects.
- **Superfície pública:** `catalogProjects`, everything of catalogFormat.ts.

#### `src/world/catalogFacade.ts`

- **Veredito: MOVER** → src/world/buildings/catalogFacade.ts
- **Evidência e regra (coordenador):** Linhas só para as alturas de andar padrão (L62, L93–94); CAT_ROW0 fixo (L16).
- **Responsabilidades (a-l):** L11–16 bay index map, shader kinds, first row id; L18–33 fill → window row; L35–43 nearest trim residue; L45–81 row table built from all projects; L83–95 rows and per-fill facade id lookup.
- **Achados do leitor (a-l):**
  - [BUG] (inference) catalogFacade.ts:62,93–94 — rows are built only for the project's ground and standard storey heights; `catalogFacade` called with any other `fh` misses the map and silently falls back to the style row `trimResidue(...)` (0..12), drawing that style's windows instead of the project's.
  - [DUP] catalogFacade.ts:16 `CAT_ROW0 = 117` vs arch.ts:142 `PANE_ROW = 13*9+132` (row count hard-coded twice).
- **Superfície pública:** `BAY`, `CAT_ROW0`, `fillLook`, `catalogWindowRows`, `catalogFacade`.
- **Exports nunca importados (b):** `CAT_ROW0`, `fillLook`

#### `src/world/catalogFormat.ts`

- **Veredito: JUNTAR** → src/world/buildings/catalog.ts
- **Evidência e regra (coordenador):** Cabeçalho diz 'catalogData.ts' mas catalog.ts importa catalogData.json (L5); CAT_PATTERNS repete arch.ts:110–120.
- **Responsabilidades (a-l):** L8–29 units, enum name lists, index helper; L31–64 project/volume/storey/element types; L66–69 flag bits; L71–126 binary decoder.
- **Achados do leitor (a-l):**
  - [NAME] catalogFormat.ts:5 — header says packed "into catalogData.ts" but catalog.ts:3 imports `catalogData.json`.
  - [DUP] catalogFormat.ts:16 CAT_PATTERNS = arch.ts:110–120 pattern names; catalogFormat.ts:24–27 CAT_FUNCTIONS overlaps arch.ts Fn list (different order/ids).
  - [OBJ] (acceptable) catalogFormat.ts:80–122 — one object per project/volume/storey/element; fixed 38-project asset, not world entities.
- **Superfície pública:** `CAT_UNIT`, `CAT_Q`, `CAT_*` enum lists, `catIndex`, `Cat*` types, `VOL_*`, `GEOM_FIELDS`, `decodeCatalog`.

#### `src/world/decay.ts`

- **Veredito: MOVER** → src/world/buildings/decay.ts
- **Evidência e regra (coordenador):** Regra de decadência dos prédios.
- **Responsabilidades (a-l):** L5–8 grace/span; L10–18 generated "built" minute; L20–31 tenths and next-tenth time; L33–76 typed-array min-heap.
- **Achados do leitor (a-l):**
  - [R40COPY] decay.ts:1 — rule from 4.0 types.ts decayOf / decayWatch.ts (values).
- **Superfície pública:** `DECAY_GRACE`, `DECAY_SPAN`, `generatedBuilt`, `decayTenths`, `nextTenthAt`, `MinuteHeap`.

#### `src/world/design.ts`

- **Veredito: MOVER** → src/world/buildings/design.ts
- **Evidência e regra (coordenador):** Comentários em português (L1–97); CIVIC_DESIGNS por números literais 14..33 em vez de Fn.* (L27–47); ramo `shape === 4 ? 0 : 0` morto (L92); design empacotado em color/h (L72–78).
- **Responsabilidades (a-l):** L5–16 creator option lists (shapes, roofs, finishes, windows, wings, gear, palette); L18–24 Design type and default; L26–47 civic designs by Fn id; L49–66 landmark designs; L68–79 bit encode/decode into `color`/`h`; L81–103 footprint parts per shape; L105–106 civic catalog name set.
- **Achados do leitor (a-l):**
  - [NAME] design.ts:1–3,8–15,26,49–51,81,86,88,97 — comments in Portuguese (project rule: English).
  - [TEXT] design.ts:5–14 — player-facing Portuguese option names outside i18n.
  - [TEXT] design.ts:27–47 — `CIVIC_DESIGNS` keyed by literal Fn numbers 14..33 instead of `Fn.*` (arch.ts:23–29).
  - [TEXT] design.ts:106 — `CIVIC_CATALOG` set of catalog project names as magic strings; its doc ("stand as landmark towers (the rest are civic)") contradicts the name.
  - [HOST] design.ts:1–3,72–78 — design packed into the record's `color` bits and `h` (wall colour) fields: two meanings per field.
  - [DEAD] design.ts:92 — `shape === 4 ? 0 : 0` both branches equal; L8 orphan doc comment ("Peças no telhado") above another doc.
- **Superfície pública:** `SHAPES`, `ROOFS`, `FINISHES`, `WINDOWS`, `WINGS`, `GEAR`, `GEAR_NAMES`, `PALETTE`, `Design`, `DEFAULT_DESIGN`, `CIVIC_DESIGNS`, `LANDMARKS`, `hasDesign`, `encodeDesign`, `decodeDesign`, `footprint`, `CIVIC_CATALOG`.

#### `src/world/ground.ts`

- **Veredito: DIVIDIR** → src/world/ground.ts (grade de pintura + água) + src/features/terrain/river.ts (RiverCommand) + nomes para i18n
- **Evidência e regra (coordenador):** Pintura, água, biomas e comando do rio num arquivo; GROUND_NAMES/BIOMES/TREE_SPECIES em português fora do i18n (L31–44, L78); waterIndex igual a heights.ts:21–23.
- **Responsabilidades (a-l):** L12–24 `GroundWorld` host slice; L26–44 ground types, names, colours, biomes; L46–74 water grid constants, index, buffers, sampling; L76–141 GroundStroke command (paint/forest/cut); L143–151 dirty marking; L153–251 RiverCommand (bed carving + water fill, packed undo).
- **Achados do leitor (a-l):**
  - [MIX] ground.ts — ground paint grid, water grid, biome list and the river command in one file.
  - [TEXT] ground.ts:31–36,44,78 — player-facing Portuguese names (`GROUND_NAMES`, `BIOMES`, `TREE_SPECIES`) outside i18n; L82,158 Portuguese command labels.
  - [DUP] ground.ts:52–54 `waterIndex` is the same tiled-index formula as heights.ts:21–23 `heightIndex`.
  - [BUG] (inference) ground.ts:228–247 — RiverCommand.write marks layer/water dirty but never calls `markSave` (GroundStroke does at L147); if save tiles depend on `markSave`, rivers may not mark their tiles for saving. Also only lowers `tileMin` (L235), never restores it on invert.
  - [ALLOC] ground.ts:107 — Map insert per touched texel per dab (edit path).
- **Superfície pública:** `GroundWorld`, `Ground`, `GROUND_NAMES`, `GROUND_COLORS`, `BIOMES`, `WATER_*`, `NO_WATER`, `waterIndex`, `waterCoord`, `createGroundBuffers`, `waterAt`, `GroundMode`, `TREE_SPECIES`, `GroundStroke`, `RiverCommand`.

#### `src/world/growth.ts`

- **Veredito: MOVER** → src/world/buildings/growth.ts
- **Evidência e regra (coordenador):** nearestFree aloca uma tupla por lote em 9 células e ordena, até 8×velocidade por quadro (L149–157); squareCell duas vezes (L197–198).
- **Responsabilidades (a-l):** L17–35 floors by zone/density/frontage; L37–84 Growth: lots per cell requested from workers on Dirty.Lots, cell list with swap-remove; L88–99 occupancy query; L101–164 organic growth step (nearest free lot to the last, random fallback, taken hints); L166–186 neighbourhood square cell; L188–219 building record for a lot (civic/square, organic height cap); L221–245 landmark designs; L247–277 most-unlike style among neighbours; L279–319 place, lotAt, fillAll, clear.
- **Achados do leitor (a-l):**
  - [ALLOC] growth.ts:149–157 — `nearestFree` (per growth try, up to 8×speed per frame) allocates a candidate tuple per lot in 9 cells and sorts it; L134 new `{x,z}` per grow; L115 return object.
  - [OMAP] (stated) growth.ts:297–309 — `fillAll` loops every lot of every cell (generation/test fill, once).
  - [DUP] growth.ts:197–198 — `squareCell(cell)` computed twice for the same lot.
  - [NAME] growth.ts:6,14 — two separate imports from '../core/rng.ts'.
  - [LAYER] growth.ts:15 — imports the World class value for the static `World.neighbourhood`; world/ imports roads/profiles and jobs/pool.
  - (inference) growth.ts:111–122 — when every lot is taken, `acc` stays at the 50 cap and each frame still runs up to 8 occupied-queries + a 9-cell `nearestFree` sort (constant, not city-sized).
  - [R40COPY] growth.ts:107,189–191,222,248–249 — rules from 4.0 growth/zoning.ts (described, not copied).
- **Superfície pública:** `floorsFor`, `Growth` (processDirty, lotsOf, step, tick, recordFor, place, lotAt, fillAll, pendingCells, clear, rate).

#### `src/world/heights.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Fan-in 44; amostragem de alturas, uma responsabilidade.
- **Responsabilidades (a-l):** L11–18 layer size, buffer; L20–30 tiled index and coordinate maps; L32–41 bilinear height; L43–56 height range of a rectangle; L58–62 index → sample; L64–77 cells touched by samples.
- **Achados do leitor (a-l):**
  - [ALLOC] heights.ts:72–74 — `sampleOfIndex` tuple and two literal arrays per sample in `cellsOfSamples` (run once per command, cached by brush.ts:217–218).
  - [DUP] heights.ts:21–23 same formula as ground.ts:52–54.
- **Superfície pública:** `LAYER_TEXELS`, `createHeightBuffer`, `heightIndex`, `sampleCoord`, `worldOfSample`, `heightAt`, `heightRange`, `sampleOfIndex`, `cellsOfSamples`.

#### `src/world/items.ts`

- **Veredito: MANTER** → src/world/items.ts
- **Evidência e regra (coordenador):** Tabela de itens; o desfazer guarda um array JS por item (L43, L181–198) e categorias por faixas numéricas (L27–39).
- **Responsabilidades (a-l):** L9–10 `ItemWorld` host slice; L12–39 item type ids and predicates; L41–47 schema and record types; L49–141 StreetItems SoA table + spatial index (add/remove/nearest/gather/saveTile/loadTile); L143–177 ElementStroke (ground-element scatter/erase brush); L179–213 ItemsCommand (add/remove with id-preserving swap and rollback).
- **Achados do leitor (a-l):**
  - [OBJ] items.ts:43,181–182,189–198 — undo keeps one JS array (`ItemRec`) per item added/removed; an element-brush stroke over a large area stores thousands of small arrays.
  - [MIX] items.ts:12–26 — one id space mixes street furniture, barriers, particle emitters (smoke, fire, mist), ground tufts and creator people.
  - [TEXT] items.ts:27–30,36–39 — category predicates by numeric id ranges (20..25, 26..29, 30..40) — adding an id in a gap silently changes categories.
  - [ALLOC] items.ts:117–124,129–135 — `number[]` push then Float32Array copy per gather/save (job input, not per frame).
  - [NAME] items.ts:143–144 — orphan doc comment "Putting and taking items, with undo." above ElementStroke (belongs to ItemsCommand); L150 Portuguese label 'elementos'.
  - (inference) items.ts:149 — ElementStroke seeds from `Math.random`; scatter is not reproducible from the command.
- **Superfície pública:** `ItemWorld`, `Item`, `isBarrier`, `isEffect`, `isGroundElement`, `isSidewalkFurniture`, `isPlant`, `ItemRec`, `ItemBody`, `MAX_RUN`, `StreetItems`, `ElementStroke`, `ItemsCommand`.

#### `src/world/lotEdit.ts`

- **Veredito: DIVIDIR** → src/world/lots/lotEdit.ts + src/core/polygon2d.ts (biblioteca de polígonos L43–120, L416–461)
- **Evidência e regra (coordenador):** Biblioteca genérica de polígonos dentro da edição de lotes; mensagens e rótulos em português; edições de lote gravadas no RoadJournal de roads/build.ts.
- **Responsabilidades (a-l):** L19–41 lot frame transforms; L43–120 polygon helpers (point-in-polygon, crossing, simple, tidy, half-plane clip, frameLot); L122–145 outline and lot under a point; L147–163 child record and replace; L165–214 `lotFits` (roads, water, other lots, by spatial queries); L216–414 edits: split, split by line, polygon lot, join, delete, front, nearest corner, move corner, curve side; L416–461 minimum-area rectangle and convex hull; L463–541 multi-lot edits (shared corner, split many by line, delete along a stroke).
- **Achados do leitor (a-l):**
  - [TEXT] lotEdit.ts:7,158,171,188,192,213,222,234,243,247,256–265,270,299,301,313,330,357–358,366–369,395,405,407,410,482,488–491,496,505,515,522,537–538 — player messages and journal labels are hard-coded Portuguese strings (header L7 says so), outside i18n.
  - [NAME]/[LAYER] lotEdit.ts:11,159,304,313,330,373,410,496,516,538 — lot edits are recorded in `RoadJournal` from roads/build.ts (the "road" journal is the generic edit journal; world → roads dependency).
  - [MIX] lotEdit.ts — generic 2D polygon library (L43–120, L416–461) inside the lot-edit module.
  - [OBJ] (edit path) lotEdit.ts:24,123–127 — outlines as arrays of `[x,z]` tuples; lotFits L205–212 builds a shrunk outline per neighbour within 120 m per call.
  - [DUP] lotEdit.ts:76–86 `tidy` restarts the scan after every removal (O(n²)), bounded by SHAPE_MAX.
  - Note lotEdit.ts:150 — child floors drawn with frontage profile 0 always (`floorsFor(r.zone, 0, …)`), ignoring the avenue rule of growth.ts:19.
- **Superfície pública:** `MIN_LOT`, `SplitKind`, `lotToWorld`, `worldToLot`, `pointInPolygon`, `isSimple`, `clipHalf`, `frameLot`, `lotOutlineWorld`, `lotAt`, `lotFits`, `splitLot`, `splitLotByLine`, `polygonLot`, `joinLots`, `deleteLot`, `setLotFront`, `nearestCorner`, `moveLotCorner`, `curveLotSide`, `polygonRect`, `moveSharedCorner`, `splitLotsByLine`, `deleteLotsAlong`.

#### `src/world/lotPlan.ts`

- **Veredito: JUNTAR** → um só plano de lote: src/world/lots/lotPlan.ts (substitui também src/r40/world/growth/lotPlan.ts)
- **Evidência e regra (coordenador):** Ninguém do jogo importa (só test/lotPlan.test.ts, conferido) e 10 exports mortos; o cabeçalho diz que jobs/buildingGen.ts usa (L4), o que não é verdade; o jogo usa r40/world/growth/lotPlan.ts via r40/api.ts. Duas implementações do mesmo plano.
- **Responsabilidades (a-l):** L11–19 lot kind by zone/density; L21–39 plan types; L41–47 sizes and helpers; L49–131 `planLot` (front/sides/back per kind, drive and corner rules, building envelope); L133–136 envelope in engine frame; L138–165 yard ramp, garage ramp, drive side, docks.
- **Achados do leitor (a-l):**
  - [R40COPY] lotPlan.ts:1,49 — "4.0's rules and numbers" from world/growth/lotPlan.ts (values/structure ported, code rewritten as far as visible).
  - [TEXT] lotPlan.ts:11,21–23 — kinds and uses as string unions passed to the generator (fine within TS, but string compares in hot generation path L119,158).
  - [ALLOC] lotPlan.ts:51–130 — several small objects per planned lot (worker generation path).
- **Superfície pública:** `LotKind`, `lotKind`, `FrontUse`, `SideUse`, `BackUse`, `LotPlan`, `YARD_FULL`, `DRIVE`, `HOUSE_DRIVE`, `FOOTPATH`, `TRUCK_LANE`, `STALL`, `AISLE`, `DOCK`, `planLot`, `envelope`, `yardRamp`, `GARAGE_GRADE`, `garageRamp`, `driveSide`, `docksFor`.
- **Exports nunca importados (b):** `FrontUse`, `SideUse`, `BackUse`, `LotPlan`, `DRIVE`, `HOUSE_DRIVE`, `FOOTPATH`, `TRUCK_LANE`, `DOCK`, `GARAGE_GRADE`

#### `src/world/roofPlant.ts`

- **Veredito: MOVER** → src/jobs/buildingGen/roofPlant.ts
- **Evidência e regra (coordenador):** Só o gerador de prédios (worker) usa (fan-in 2, ambos jobs); paletas de cor dentro do planejamento (L125–129); PRNG mulberry32 próprio (L65–74) igual ao de r40/core/rng.ts; 59% de linhas idênticas ao 4.0 (DECISIONS 2026-10-30).
- **Responsabilidades (a-l):** L4–32 types of roof plant pieces and roof site; L34–59 catalogue of 12 kinds with chances/sizes (4.0 values); L61–74 packing constants + mulberry32 stream; L76–123 `planRoofPlant` grid packing (0.5 m cells, 24 random tries per piece); L125–129 roof/tank/flat-roof colour tables
- **Achados do leitor (a-l):**
  - [R40COPY] roofPlant.ts:1-2,45,76,125,128 — comments cite 4.0 files and line ranges (roofPlant.ts:58-74, :94-145, roofPlan.ts:8-17, materials.ts FLAT_ROOFS); values ported, code reimplemented (looks like a port of values, not code copy; cannot confirm without 4.0 file)
  - [OBJ] roofPlant.ts:97,118 — returns one JS object per roof-plant item (`RoofPlantItem[]`); (inference) called per roof inside the building generator worker, so allocation is in worker meshing, not main thread
  - [ALLOC] roofPlant.ts:84,107,110 — per call: `Uint8Array(nx*nz)`, tuple arrays `[pw,pd]`, `[i,j]` per piece; worker-side generation path
  - [DUP] roofPlant.ts:65-74 — private mulberry32 `stream()`; same PRNG likely exists in core/rng.ts (`Rng`) and elsewhere (search "0x6d2b79f5")
  - [MIX] roofPlant.ts:125-129 — colour palettes (render concern, incl. FLAT_ROOFS of materials) live in the plant-planning module
  - [BUG] roofPlant.ts:109,115 — `break` on a piece that does not fit / no free place stops the whole kind, including perArea targets; intended (4.0?) but a large perArea target stops at first failed 24-try search (inference)
- **Superfície pública:** `RoofPlantKind`, `RoofPlantItem`, `RoofUse`, `RoofSite`, `planRoofPlant` (plan a roof's plant), `ROOF_COLOURS`, `TANK_COLOURS`, `FLAT_ROOFS`

#### `src/world/transit.ts`

- **Veredito: DIVIDIR** → src/features/transit/lines.ts (tabela de linhas + comandos) e textos para shared/i18n
- **Evidência e regra (coordenador):** MODE_NAMES em português (L9) é export morto (só a definição, conferido); rótulos de comando em português (L34…L116); stopNear varre todas as paradas de todas as linhas (L136–145, O(paradas) por movimento do ponteiro); um objeto JS por linha (L12, L18). Os terminais são gravados por platform/mapExtra.ts:16,41 (a alegação de que não são gravados não procede).
- **Responsabilidades (a-l):** L7–15 mode enum, mode display names, line colours; L17–26 Transit store (lines, terminals, version); L28–120 edit commands (add/remove line, add/remove stop, buses, colour, loop, terminal toggle); L122–145 proximity queries (terminal, terminal stops, nearest stop); L147–169 clear + Float64 encode/decode for save
- **Achados do leitor (a-l):**
  - [TEXT] transit.ts:9 — `MODE_NAMES = ['Ônibus','Trem','Metrô']` player-facing Portuguese text outside the i18n files
  - [TEXT] transit.ts:34,46,58,69,81,93,104,116 — command labels in Portuguese ('nova linha', 'parada', 'ônibus', 'linha circular'…) as literals
  - [OBJ] transit.ts:12,18 — one JS object per line with `stops: number[]`; small count (lines), acceptable scale but not SoA
  - [BUG] transit.ts:150-169 — `encode` writes only lines + nextId; `terminals` are not encoded and `decode` never resets them. (They appear in platform/mapExtra `terminals` per mapExtra.test.ts:9, so saved elsewhere: [HOST]-like split of one subsystem's save across two places)
  - [BUG] transit.ts:56-59 — `addStop` fixes `k` at command creation; if the line's stops change between creation and apply (e.g., redo after other edits undone in different order) the splice index may be stale; (inference) safe only with strict stack order
  - [BUG] transit.ts:111-119 — `toggleTerminal` captures `before/after` arrays at creation and replaces the whole list on apply/invert; correct only under strict stack order
  - [OMAP] transit.ts:136-145 — `stopNear` scans every stop of every line (O(total stops)); (inference) called on pointer moves by transit tool
  - [OMAP] transit.ts:129-133 — `terminalStops` is O(stops × terminals)
  - [LAYER] transit.ts:15 — comment ties colours to `render/vehicles.ts` PAINTS (world depends on render palette indices by convention)
- **Superfície pública:** `Mode`, `MODE_NAMES`, `Line`, `LINE_COLORS`, `Transit` (bus/train/metro lines store with command edits and save codec)

#### `src/world/world.ts`

- **Veredito: DIVIDIR** → src/world/world.ts (dono dos buffers e tabelas) + src/world/economy.ts (dinheiro, contadores) + src/world/cityClock.ts (relógio, decadência) + src/roads/streetNames.ts (streetNames) + src/world/signs.ts (signTexts)
- **Evidência e regra (coordenador):** Uma classe com terreno, pintura do chão, água, sujeira do save, prédios, placas, nomes de rua, dinheiro, relógio e população (L53–399), fan-in 68; comentário fora do lugar (L343–348).
- **Responsabilidades (a-l):** L17–41 building SoA schema + record type; L43–48 `polygonArea`; L50–51 START_MONEY; L53–129 World class fields: money, heights/ground/water SABs, dirty sets, tables, spatial index, cell versions, squares, roads/impossible/items, lot shapes, clock; L131–144 lot polygon/outline; L146–176 clock and decay heap; L178–208 renovation, dirty marking, save marks; L210–232 residents/jobs counters; L234–297 add/grow/fill/restore building; L299–307 overlap query; L309–341 edit/design/remove building; L343–379 ruined set + gatherBoxes for jobs; L381–398 clear ground/buildings; L401–419 SAT rect overlap
- **Achados do leitor (a-l):**
  - [MIX] world.ts:53-399 — one class holds terrain buffers, ground paint, water, save dirtiness, buildings table, sign texts, street names, economy money, city clock/decay, population counters, ruin state; a host/god object (420 lines)
  - [TEXT] world.ts:88 — `signTexts` keyed by string `signKey` position (Map<string,string>)
  - [ALLOC] world.ts:132-136,139-144 — `lotPolygon`/`lotOutline` allocate new arrays per call; (inference) used by lot editing/hit tests, possibly per pointer move
  - [ALLOC] world.ts:274 — `buildingRec` spreads into new array (command records, fine)
  - [OMAP] world.ts:162-167 — `setClock` refiles every building (load only, documented)
  - [OMAP] world.ts:382-387 — `clearGround` adds every tile to two Sets (new map/load)
  - [DUP] world.ts:343-348 — stale doc comment "Copies the buildings of a cell…" left above the `ruined` doc (belongs to gatherBoxes L359)
  - [BUG] world.ts:350-357 — `setRuined` bumps `cellVersion` and dirty but not `markSave`: fine if ruin is not saved; but `touchCell` paths elsewhere always mark save — inconsistent marking path (inference)
  - [BUG] world.ts:229-230 — polygon lot capacity uses `polygonArea(lotShape.subarray(...))` on int16 decimetres then `sqrt(...)/SHAPE_SCALE`: area is in dm², sqrt gives dm, divided by SHAPE_SCALE gives m — correct only if SHAPE_SCALE=10 (dm); consistent with L134
  - [ALLOC] world.ts:410 — `rectsOverlap` allocates 4 axis arrays per call; called per candidate in `buildingsOverlapping` (restore only)
  - [LAYER] world.ts:9 — world imports from shared/contracts/worker (fine); world.ts:11-13 world imports roads layer (RoadNetwork constructed inside World L116 with `this` as host)
- **Superfície pública:** `buildingSchema`, `BuildingRec`, `polygonArea`, `START_MONEY`, `World` (page-side world state owner)

#### `test/blockLots.test.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Assunto único (lotes por quadra).
- **Responsabilidades (a-l):** L12–37 a 120×72 m grid block yields two rows of lots covering >90 %
- **Achados do leitor (a-l):**
  - [R40COPY] blockLots.test.ts:2 — cites 4.0 world/lots.ts blockPlan
- **Superfície pública:** none (test)

#### `test/building40.test.ts`

- **Veredito: MANTER** → — (helpers oneBuilding/positions/flatUpAreas para test/helpers/buildings.ts)
- **Evidência e regra (coordenador):** Helpers copiados de buildingDefects.test.ts:14–53 (L12–53); B16 só confere que a contagem de vértices mudou (L67–68).
- **Responsabilidades (a-l):** L12–53 helpers (oneBuilding, positions, flatUpAreas, lidOverRoof); L55–69 B16 slope terracing; L71–86 B18 no roof lid; L88–104 B19 parts pass writes no vertex; L106–129 B17 yard plants on 4.0 ground
- **Achados do leitor (a-l):**
  - [DUP] building40.test.ts:12-53 — `oneBuilding`, `positions`, `flatUpAreas` duplicated from buildingDefects.test.ts:14-53 and positions also in buildingLook.test.ts:15, defects.test.ts:20
  - [DUP] building40.test.ts:88-104 — same "write no vertex" test as buildingDefects.test.ts:112-134 (F4) on the 4.0 path
  - [MIX] two building paths exist (`buildBuildings` 4.0 path vs `buildBuildingsLegacy`); this file tests the 4.0 one, others the legacy one
  - [BUG] building40.test.ts:67-68 — B16 asserts only vertex count differs/grows; proves "different geometry", not correct terracing (weak test)
- **Superfície pública:** none

#### `test/buildingDefects.test.ts`

- **Veredito: DIVIDIR** → test/buildingDefects.test.ts (gerador 4.0) + test/buildingLegacy.test.ts enquanto o gerador antigo existir, helpers em test/helpers/buildings.ts
- **Evidência e regra (coordenador):** 49 KB; mistura o gerador legado e o 4.0 (alias L7); acabamento achado pelo rótulo 'Vidro' (L376); sobras voidadas (L472–473, L534).
- **Responsabilidades (a-l):** L13–60 helpers; L62–90 F2 no lid; L92–110 F3 hip roof coverage; L112–134 F4 throwaway mesh; L136–216 F6 polygon lots (mesh, yards, parking); L218–254 B7/B8 inside view storeys; L256–336 B9/B14/B12/B11 inside view behaviour; L338–353 B15 heights; L355–377 F5 finishes; L379–396 F9 civic fit; L398–420 F10 cell-edge parts; L422–458 F11 plants on yards; L460–571 F12/F13 lots off roads and across cells; L573–628 F8/F31 catalog fidelity; L630–760 F16/F17/F15/F14 catalog buildings
- **Achados do leitor (a-l):**
  - [DUP] buildingDefects.test.ts:14-60 — helper set duplicated in building40/buildingLook/defects tests (should be a shared test helper)
  - [TEXT] buildingDefects.test.ts:376 — finds the glass finish by its Portuguese label `FINISHES.indexOf('Vidro')`
  - [DEAD] buildingDefects.test.ts:472-473,534 — nodes `e`,`f` created and `void`ed; imports `bez`, `p2` voided — leftover code
  - [NAME] buildingDefects.test.ts:2 — refers to DEFEITOS-roadcraft-novo.md (Portuguese doc name)
  - [MIX] tests mix legacy builder (`buildBuildings` = legacy alias L7) and 4.0 builder (`buildBuildings40`) in the same file — two generators coexist
  - [BUG] buildingDefects.test.ts:215,253,457,539,570 — asserts on `failures.slice(0, N)` (only report trimming; still fails if any) — fine
- **Superfície pública:** none

#### `test/buildingDesign.test.ts`

- **Veredito: RENOMEAR** → test/buildingDesign.test.ts (nomes em inglês)
- **Evidência e regra (coordenador):** Nomes em português (L15, L23, L36, L67).
- **Responsabilidades (a-l):** L15–21 design bit round trip; L23–34 catalog 38 projects + window table size; L36–65 landmarks/patterns deterministic and ≥250 m apart; L67–71 pane row last
- **Achados do leitor (a-l):**
  - [NAME] buildingDesign.test.ts:15,23,36,67 — test names and comments in Portuguese (CLAUDE.md: everything written is English)
  - [BUG] buildingDesign.test.ts:51 — shuffles only 8 columns (not h/color/rot/fn) — fine because they are zero; L54 only compares vertexCount after reordering (weak)
- **Superfície pública:** none

#### `test/buildingFinishes.test.ts`

- **Veredito: RENOMEAR** → test/buildingFinishes.test.ts (nomes em inglês)
- **Evidência e regra (coordenador):** Nomes e mensagens em português.
- **Responsabilidades (a-l):** L13–22 decode cooked KTX2 finish files; L24–42 13 finish layers packed in engine id order; L44–61 finish nibble in vertex material byte; L63–79 facade parts determinism
- **Achados do leitor (a-l):**
  - [NAME] buildingFinishes.test.ts:24,44,63,57,60,75 — Portuguese test names/messages
- **Superfície pública:** none

#### `test/buildingLook.test.ts`

- **Veredito: RENOMEAR** → test/buildingLook.test.ts (nomes em inglês)
- **Evidência e regra (coordenador):** Reimplementa em JS o `hole` das janelas do shader de render/city.ts (L71–85); laço até 33 fixo (L165); L259 não prova sacadas.
- **Responsabilidades (a-l):** L13–63 vector helpers, mixed block, triangles, barycentric; L65–118 every window opening has a pane 20 cm in (replicates shader `hole`); L120–150 muted paints, plinth and bands; L152–181 parapet and roof plant; L183–199 hip roof body; L201–230 pane frames/transom; L232–244 curtain-wall fins; L246–260 balconies; L262–278 square/park lawn and trees
- **Achados do leitor (a-l):**
  - [DUP] buildingLook.test.ts:71-85 — reimplements the shader's window `hole` from render/city.ts in JS (two copies of the rule; test can drift from shader)
  - [DUP] buildingLook.test.ts:15-22 — `positions` again
  - [NAME] buildingLook.test.ts:65,120,130,152,183,201,232,246,262 — test names prefixed with Portuguese ('janela', 'paredes', 'telhado', 'vidro', 'sacada', 'praça')
  - [BUG] buildingLook.test.ts:204 — filter condition `A && n[1]===0 || A && |n[1]|<0.1` redundant (first clause subsumed)
  - [BUG] buildingLook.test.ts:259 — `assert.ok(p.length > 0)` proves nothing about balconies
  - [BUG] buildingLook.test.ts:165 — loop to fixed `k < 33` instead of b.count (36), skips catalog buildings by magic number
- **Superfície pública:** none

#### `test/buildings.test.ts`

- **Veredito: RENOMEAR** → test/buildings.test.ts (nomes em inglês)
- **Evidência e regra (coordenador):** Nomes em português.
- **Responsabilidades (a-l):** L11–23 sample of 5 kinds; L25–40 determinism, valid indices, windows, LOD1 lighter
- **Achados do leitor (a-l):**
  - [NAME] buildings.test.ts:10,25,33,37 — Portuguese doc/test names/comments
- **Superfície pública:** none

#### `test/bulbsRoundabouts.test.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Assunto único.
- **Responsabilidades (a-l):** L9–20 helpers; L22–41 dead end shape chosen by player with undo; L43–64 roundabout on vacant ground / cutting roads on request
- **Achados do leitor (a-l):**
  - [TEXT] bulbsRoundabouts.test.ts:28,37 — junction end mode as string literals 'plain'/'bulb'
  - [R40COPY] bulbsRoundabouts.test.ts:2 — cites 4.0 junction/bulb.ts, editor/roundabout.ts
- **Superfície pública:** none

#### `test/citygen.test.ts`

- **Veredito: RENOMEAR** → test/cityGen.test.ts
- **Evidência e regra (coordenador):** Reimplementa a inserção da cidade gerada 'como game.ts generatedCity faz' (L36–45): passa a chamar a função extraída de game.ts (roads/conformRecords.ts).
- **Responsabilidades (a-l):** L7–30 generated city deterministic, clean graph, nodes on land; L32–49 no impossible node / dangling ends
- **Achados do leitor (a-l):**
  - [DUP] citygen.test.ts:36-45 — re-implements the insertion of a generated city "the way game.ts generatedCity does" (logic duplicated from game.ts)
  - [NAME] citygen.test.ts:7,18,22,25,28 — Portuguese test name/messages
  - [OMAP] citygen.test.ts:8 — generates the whole city twice (test cost only)
- **Superfície pública:** none

#### `test/citySpurs.test.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Um teste de jobs/cityGen.ts withoutSpurs; está no quick-check.
- **Responsabilidades (a-l):** L8–20 `withoutSpurs` removes a 2-piece spur, keeps the ring
- **Achados do leitor (a-l):**
  - [SMALL] one test of jobs/cityGen.ts `withoutSpurs`
- **Superfície pública:** none

#### `test/cityStyles.test.ts`

- **Veredito: RENOMEAR** → test/cityGrid.test.ts
- **Evidência e regra (coordenador):** Laço sobre um único estilo ['grid'] (L22): os outros estilos foram descartados e o nome não descreve mais o conteúdo.
- **Responsabilidades (a-l):** L8–19 axis share helper; L21–36 grid city fits MAX_SEG_LEN/MAX_DEG; L38–41 streets on axes
- **Achados do leitor (a-l):**
  - [DEAD] cityStyles.test.ts:22 — loop over a single style `['grid']` left from removed styles (comment L2: other styles discarded); file name "cityStyles" no longer describes content [NAME]
- **Superfície pública:** none

#### `test/core.test.ts`

- **Veredito: RENOMEAR** → test/core.test.ts (nomes em inglês)
- **Evidência e regra (coordenador):** Nomes em português; rótulo 'soma' (L62).
- **Responsabilidades (a-l):** L9–15 morton; L17–33 spatial index; L35–43 dirty cells; L45–58 SoA table; L60–76 command stack; L78–83 RNG/fbm
- **Achados do leitor (a-l):**
  - [NAME] core.test.ts:9,17,35,45,60,78 — Portuguese test names; command label 'soma' L62
- **Superfície pública:** none

#### `test/decay.test.ts`

- **Veredito: RENOMEAR** → test/decay.test.ts (nomes em inglês)
- **Evidência e regra (coordenador):** Nomes em português.
- **Responsabilidades (a-l):** L10–15 decay tenths; L17–24 MinuteHeap order; L26–49 clock ages only due buildings, renovation; L51–55 generated built spread; L57–67 undo restores built
- **Achados do leitor (a-l):**
  - [NAME] decay.test.ts:10,17,26,51,57 — Portuguese names/comments
- **Superfície pública:** none

#### `test/defects.test.ts`

- **Veredito: RENOMEAR** → test/cellLayerDefects.test.ts
- **Evidência e regra (coordenador):** Nome genérico; acessa privados de CellLayer (L115); Growth com pool nulo (L89).
- **Responsabilidades (a-l):** L19–41 helpers; L43–58 D1 node height money; L60–74 F1 overhang not flattened; L76–101 A20 undo after growth; L103–128 E6 cell mesh dispose; L130–153 E1/E2 prop block pool; L155–194 A3/A4 job pool errors with FakeWorker
- **Achados do leitor (a-l):**
  - [DUP] defects.test.ts:20-27 — `positions` helper again
  - [HOST] defects.test.ts:115 — reaches into CellLayer privates (`cells`, `setMesh`) via cast; L175 reads `run` via cast though it is public-intended
  - [LAYER] defects.test.ts:15-16 — test imports three/webgpu and render/cellLayer in a node test (fine for tests, but render layer constructed headless)
  - [BUG] defects.test.ts:89 — `new Growth(w, null as unknown as JobPool)` — Growth used with a null pool; works only because `place` does not touch pool (fragile)
  - [NAME] defects.test.ts:2 — references DEFEITOS-roadcraft-novo.md
- **Superfície pública:** none

#### `test/economy.test.ts`

- **Veredito: RENOMEAR** → test/economy.test.ts (nomes em inglês; preços lidos da tabela de custo)
- **Evidência e regra (coordenador):** Preços 150/40/80 copiados (L33): duas fontes da verdade.
- **Responsabilidades (a-l):** L12–24 helpers; L26–36 profile price; L38–45 build kind by height; L47–65 charge/refund/undo; L67–80 bridge price, refusal without money; L82–86 rounding
- **Achados do leitor (a-l):**
  - [TEXT] economy.test.ts:31 — strip kinds compared as string literals ('sidewalk','curb','median','barrier')
  - [NAME] economy.test.ts:26,38,47,67,82 — Portuguese test names
  - [BUG] economy.test.ts:33 — test hard-codes price constants 150/40/80 instead of reading tuning (two sources of truth)
- **Superfície pública:** none

#### `test/gradeLine.test.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Assunto único; no quick-check.
- **Responsabilidades (a-l):** L7–14 helpers; L16–55 gradeLine keeps ground, grade limit, symmetry, flat ends, fixed points/floor, per-station grade
- **Superfície pública:** none

#### `test/growth.test.ts`

- **Veredito: RENOMEAR** → test/growth.test.ts (nomes em inglês)
- **Evidência e regra (coordenador):** Consulta 'segmentos a 160 m da célula' duplicada (L36–53) com buildingDefects.test.ts:480–487.
- **Responsabilidades (a-l):** L14–43 helpers incl. growth with lots computed inline (bypassing pool); L45–55 lots refuse water; L57–74 next building near last; L76–91 max +3 floors over neighbour; L93–108 one square per neighbourhood
- **Achados do leitor (a-l):**
  - [HOST] growth.test.ts:29-30 — `Growth` with null pool and private `setLots` reached by cast
  - [DUP] growth.test.ts:36-41,49-53 — "segments within 160 m of the cell" query duplicated (also buildingDefects.test.ts:480-487, comment cites growth.ts)
  - [NAME] growth.test.ts:45,57,76,93 — Portuguese names/messages
- **Superfície pública:** none

#### `test/i18n.test.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Um teste; prova que a tradução é feita pelo texto português da fonte (L7–12), ver legacy.ts.
- **Responsabilidades (a-l):** L6–13 `translate` maps Portuguese phrases (incl. with numbers) to English
- **Achados do leitor (a-l):**
  - [TEXT] i18n.test.ts:7-12 — translation keyed by Portuguese source text ('Câmera', ' moradores · ', 'Escola · 3 andares'): UI text is written in Portuguese in code and translated by label text at runtime
  - [SMALL] one test
- **Superfície pública:** none

#### `test/impossible.test.ts`

- **Veredito: RENOMEAR** → test/impossible.test.ts (nome em inglês)
- **Evidência e regra (coordenador):** Nome em português; `void s1` (L20).
- **Responsabilidades (a-l):** L6–23 impossible nodes counted incrementally (<25°), cleared on remove/clear
- **Achados do leitor (a-l):**
  - [NAME] impossible.test.ts:6 — Portuguese test name
  - [DEAD] impossible.test.ts:20 — `void s1`
- **Superfície pública:** none

#### `test/inspectorRoad.test.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Assunto único; recusa reconhecida pelo texto da mensagem (L47).
- **Responsabilidades (a-l):** L11–20 helpers; L22–39 bend by curvature with undo; L41–52 refused bends; L54–66 upgrade class and height point
- **Achados do leitor (a-l):**
  - [TEXT] inspectorRoad.test.ts:47 — refusal recognised by message text regex `/passaria|run over/` (reason strings are behaviour)
  - [R40COPY] inspectorRoad.test.ts:2-3 — cites 4.0 ui/inspector.ts line numbers
- **Superfície pública:** none

#### `test/interface.test.ts`

- **Veredito: DIVIDIR** → test/keys.test.ts, test/boot.test.ts, test/readouts.test.ts, test/transitNames.test.ts
- **Evidência e regra (coordenador):** Teclas, i18n, inicialização, bomba, leituras da câmera, nomes de transporte e demanda num arquivo (L1–173); suja globalThis.window para os testes seguintes (L12–14).
- **Responsabilidades (a-l):** L8–38 fake window + key deps; L40–55 B3 Ctrl shortcuts; L57–65 B46 refund tip; L67–78 B56 boot errors; L80–88 B59 currency; L90–106 B35/B34 key tables and help; L108–120 check-interface scenarios compile; L122–130 reload keys blocked; L134–147 bomb steps; L151–158 camera readouts; L162–166 transit names; L169–172 demand factors
- **Achados do leitor (a-l):**
  - [TEXT] interface.test.ts:171 — `demandFactor('baixa'|'normal'|'pico')` Portuguese magic strings drive behaviour
  - [MIX] one test file covers keys, i18n, boot, bomb, camera readouts, transit names, demand (grab-bag)
  - [BUG] interface.test.ts:12-14 — pollutes `globalThis.window` for any later test in the same process
  - [R40COPY] interface.test.ts:132,149,160,168 — cites 4.0 v2/shell.ts etc. line numbers
- **Superfície pública:** none

#### `test/junctionCorners.test.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Assunto único; perfil pelo nome em português (L36).
- **Responsabilidades (a-l):** L11–21 helpers; L23–33 right-angle fillet/setback; L35–39 wider roads wider returns; L41–48 bevel; L50–54 45 % limit
- **Achados do leitor (a-l):**
  - [TEXT] junctionCorners.test.ts:36 — profile looked up by Portuguese display name 'Avenida 6 faixas com canteiro'
  - [TEXT] junctionCorners.test.ts:29,43 — fillet mode string 'fillet'/'bevel'
- **Superfície pública:** none

#### `test/kerbs.test.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Assunto único; perfis pelo nome em português (L45, L76).
- **Responsabilidades (a-l):** L14–41 decode road mesh helpers; L43–59 avenue kerb/median heights; L61–72 junction kerb; L74–106 skewed junction footway width
- **Achados do leitor (a-l):**
  - [TEXT] kerbs.test.ts:45,76 — profiles found by Portuguese names 'Avenida', 'Avenida com ciclovia'
- **Superfície pública:** none

#### `test/lotEditsShared.test.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Assunto único.
- **Responsabilidades (a-l):** L10–19 helpers; L21–38 shared corner move + undo; L40–49 split line across lots; L51–64 delete stroke
- **Superfície pública:** none

#### `test/lotPlan.test.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Assunto único.
- **Responsabilidades (a-l):** L9–16 zone → lot kind; L18–30 plan always leaves ≥6 m building inside lot; L32–43 industry yard / flats parking / ramps
- **Achados do leitor (a-l):**
  - [TEXT] lotPlan.test.ts:10-15,28,34 — lot kinds and back uses as strings ('house','flats','parking','loading')
- **Superfície pública:** none

#### `test/lots.test.ts`

- **Veredito: RENOMEAR** → test/lots.test.ts (nomes em inglês)
- **Evidência e regra (coordenador):** Nomes em português; retorno de deleteLot ignorado (L52, L57).
- **Responsabilidades (a-l):** L10–19 helpers; L21–38 split/join; L40–45 refusals; L47–59 delete lot → empty → gone; L61–70 set front; L72–81 move corner; L83–90 polygon rect; L92–118 zone fill block; L120–132 save round trip of edited lots
- **Achados do leitor (a-l):**
  - [NAME] lots.test.ts:21,40,47,61,72,83,92,120 — Portuguese test names
  - [TEXT] lots.test.ts:24,44,124 — split mode 'side'/'depth' strings; L105 `fillBlock` returns string 'ok'
  - [BUG] lots.test.ts:52,57 — `deleteLot` return value (a command?) is ignored; test exercises it without undo stack (inference)
- **Superfície pública:** none

#### `test/lotsShortSide.test.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Um teste; no quick-check.
- **Responsabilidades (a-l):** L12–24 a 12 m street side yields no lot and the lots job terminates (timeout 5 s)
- **Achados do leitor (a-l):**
  - [SMALL] one test
- **Superfície pública:** none

#### `test/manoeuvres.test.ts`

- **Veredito: RENOMEAR** → test/manoeuvres.test.ts (nomes em inglês)
- **Evidência e regra (coordenador):** maxQueueBehindTruck calculado e voidado (L69, L86–91, L99): a fila atrás do caminhão não é verificada.
- **Responsabilidades (a-l):** L13–42 parking grid sim net built from network ops; L44–100 parking/unparking/kerb drop-off/truck reversing at docks near camera
- **Achados do leitor (a-l):**
  - [TEXT] manoeuvres.test.ts:22 — profile found by Portuguese name 'Rua com estacionamento'
  - [DEAD] manoeuvres.test.ts:69,86-91,99 — `maxQueueBehindTruck` computed then `void`ed: queue-behind-truck behaviour is not asserted (test proves nothing for it)
  - [TEXT] manoeuvres.test.ts:87 — vehicle kind `2` and dying state `3` magic numbers
  - [NAME] manoeuvres.test.ts:44,52,78-98 — Portuguese test name/comments/messages
  - [OMAP] manoeuvres.test.ts:87 — scans all vehicles every 40 steps (test-only)
- **Superfície pública:** none

#### `test/mapExtra.test.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Assunto único; no quick-check.
- **Responsabilidades (a-l):** L7–11 full extra fixture; L13–15 round trip; L17–27 bad field falls back alone; L29–33 defaults
- **Achados do leitor (a-l):**
  - [TEXT] mapExtra.test.ts:8,25,31 — sky modes as Portuguese strings 'noite', 'ciclo' stored in save
  - [MIX] mapExtra.test.ts:8-10 — save "extra" bundles sky, weather, water, clouds, fog, transit terminals, signs, street names, clock, paint, unlimited (a catch-all JSON blob; terminals split from Transit.encode)
- **Superfície pública:** none

#### `test/markings.test.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Assunto único (testa roads/markings.ts, que só os testes importam).
- **Responsabilidades (a-l):** L7–14 regional marking styles; L16–22 stroke words; L24–33 stop legend fits; L35–42 bus words, island, parking bays
- **Achados do leitor (a-l):**
  - [TEXT] markings.test.ts:8,12 — region codes 'br'/'us'/'eu' and legend kind 'stop' strings
- **Superfície pública:** none

#### `test/people-creator.test.ts`

- **Veredito: RENOMEAR** → test/peopleCreator.test.ts
- **Evidência e regra (coordenador):** Hífen fora do padrão.
- **Responsabilidades (a-l):** L8–10 load cooked meta, collect helper; L12–26 place 1..20 with undo/redo keeping id; L28–38 colour hash fields; L40–55 walkers circle, far groups cost nothing
- **Achados do leitor (a-l):**
  - [ALLOC] people-creator.test.ts:10 — `forEach` callback receives a reused object (copied with spread here), suggesting pooled output (good) (inference)
  - [TEXT] people-creator.test.ts:14,42 — options as strings ('female','adult','stand','phone','walk')
- **Superfície pública:** none

#### `test/people.test.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Assunto único; versão conferida por regex no texto de tools/cook-people.mjs (L15).
- **Responsabilidades (a-l):** L9–16 cooked people version matches cook tool; L18–25 budget (bytes, tris, variety); L27–31 broken cook refused
- **Achados do leitor (a-l):**
  - [TEXT] people.test.ts:15 — checks version by regex over tools/cook-people.mjs source text
- **Superfície pública:** none

#### `test/polygonLots.test.ts`

- **Veredito: RENOMEAR** → test/polygonLots.test.ts (nomes em inglês)
- **Evidência e regra (coordenador):** Reimplementa o layout binário do ladrilho para forjar um v6 (L134–139).
- **Responsabilidades (a-l):** L9–29 helpers + pentagon via RoadJournal; L31–46 polygon stored ccw in dm; L48–53 refused over water; L55–60 self-crossing / >16 corners refused; L62–78 split by line, join, undo; L80–84 line missing lot refused; L86–100 curve side; L102–115 split and move corner on polygon; L117–144 save v7 round trip, v6 compatibility
- **Achados do leitor (a-l):**
  - [NAME] polygonLots.test.ts:26,31,48,55,62,80,86,102,117 — Portuguese names; journal label 'lote desenhado'
  - [DUP] polygonLots.test.ts:134-139 — reimplements the tile binary layout (header 16, 8×4+4×1 columns) to forge a v6 file: duplicates jobs/storage.ts layout knowledge
- **Superfície pública:** none

#### `test/profileChecks.test.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Assunto único.
- **Responsabilidades (a-l):** L7–11 strip builders; L13–15 built-ins pass checks; L17–27 each issue caught
- **Achados do leitor (a-l):**
  - [TEXT] profileChecks.test.ts:19-25 — issue ids as strings ('laneBalance','parkingSide','width'…) (typed union, acceptable)
- **Superfície pública:** none

#### `test/profileEditor.test.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Assunto único.
- **Responsabilidades (a-l):** L10–17 built-ins round trip through editor; L19–27 editor order without kerbs; L29–36 palette insertion; L38–45 widths and move; L47–55 issue spots
- **Achados do leitor (a-l):**
  - [R40COPY] profileEditor.test.ts:2-4 — cites 4.0 ui/roads/profileEditor.ts line ranges
- **Superfície pública:** none

#### `test/profileLimit.test.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Registra ~300 perfis no PROFILES global e nunca remove (L21, L34): vaza para os testes seguintes do mesmo processo (defeito do teste).
- **Responsabilidades (a-l):** L11–16 register a custom profile; L18–23 >256 profiles; L25–31 road tag packs profile + end rules; L33–47 profile 300 survives network, gather and mesh
- **Achados do leitor (a-l):**
  - [BUG] profileLimit.test.ts:21,34 — registers ~300 profiles into the global `PROFILES` registry and never removes them: module-level state leaks into other tests in the same process
  - [TEXT] profileLimit.test.ts:14 — category 'meus' (Portuguese) and name `Teste ${w}`
- **Superfície pública:** none

#### `test/props.test.ts`

- **Veredito: RENOMEAR** → test/props.test.ts (nomes em inglês)
- **Evidência e regra (coordenador):** Decodifica o tipo com `& 15` (L28) enquanto o formato é `& 31` (jobs/props.ts:70, render/props.ts:604; conferido).
- **Responsabilidades (a-l):** L12–51 props deterministic, inside their cell, priority junction has no signals, signalled junction one signal per arm, lamps and trees
- **Achados do leitor (a-l):**
  - [DUP] props.test.ts:27,31 — the four-cell array written twice
  - [NAME] props.test.ts:12,16,25,39,48,49 — Portuguese names/comments
  - [BUG] props.test.ts:28 vs 115 of building40 — mask `& 15` here vs `& 31` in building40.test.ts:114 / buildingDefects.test.ts:415 for the prop kind: inconsistent decoding of `extra` (if kinds ≥16 exist, `& 15` aliases them)
- **Superfície pública:** none

#### `test/reedsShepp.test.ts`

- **Veredito: RENOMEAR** → test/reedsShepp.test.ts (nomes em inglês)
- **Evidência e regra (coordenador):** Nomes em português.
- **Responsabilidades (a-l):** L9–24 RS path ends at requested pose (300 random); L26–36 parallel parking mostly reverse; L38–45 truck reversing to dock with reverse limit
- **Achados do leitor (a-l):**
  - [NAME] reedsShepp.test.ts:9,26,38 — Portuguese names/comments
- **Superfície pública:** none

#### `test/render-defects.test.ts`

- **Veredito: DIVIDIR** → test/renderCellLayer.test.ts, test/renderPost.test.ts, test/renderProps.test.ts, test/renderTransit.test.ts, test/renderWeather.test.ts, test/renderParticles.test.ts, test/renderSigns.test.ts, test/renderCarBody.test.ts + test/helpers/mesh.ts (desempacotar triângulos, raio×triângulo)
- **Evidência e regra (coordenador):** 61 KB, um arquivo para todos os defeitos de render (L1–972); mesmo laço de desempacotar repetido 5 vezes (L775–959) e Möller–Trumbore 2 vezes (L818–833, L875–885); L749–753 passa por regex no texto de post.ts (não prova comportamento).
- **Responsabilidades (a-l):** L13–33 helpers (one-triangle PackedMesh, private-field cast `inside`, recording LayerSource); L35–175 CellLayer defects E10, E11, E12, E9, E13, E21 (dirty fan-out, reset staleness, far tile/plate coverage, plate eviction, pixel-scale distance, bounds); L177–194 E4 cascade culling; L196–272 Post defects E7 (dispose of targets), E17 (CSM follows iso camera/aspect), E18 (GTAO camera matrices); L274–343 prop meshes E5/E25, E26, E27; L345–398 shadow casters E14 (CellLayer), E15 (road bridge cells); L400–422 E19 shadow redraw; L424–457 E42 transit stop rebuild locality; L459–470 E38 rain; L472–505 E39/E40 particles; L507–531 E8 sign textures (fake document); L533–563 E41/E43 shelters; L565–638 fade rig E44/E45/E46 and E3 tile visits; L640–661 E30 impostor mipmaps, E22 TRAA history; L663–704 sky colour and small-caster shadow layer; L706–753 E23 velocity, LOD by 3D distance, empty far level, FadingCSM source check; L755–972 vehicle glass split and car body geometry (raycasts, back faces, lamps on body, cabin vs wheel arch, triangle–box SAT).
- **Achados do leitor (a-l):**
  - [MIX] test/render-defects.test.ts:1–972 — one file for every section-E defect: CellLayer LOD, post-processing, props, transit, weather, particles, signs, sky, velocity and car body geometry (L755–972 is car-mesh validation, not a defect list item).
  - [DUP] test/render-defects.test.ts:775–782, 812–816, 862–864, 907–909, 958–959 — the same "unpack indexed/non-indexed position array into triangles" loop written five times.
  - [DUP] test/render-defects.test.ts:818–833 and 875–885 — Möller–Trumbore ray/triangle written twice in the same file.
  - [DEAD] test/render-defects.test.ts:279–280, 304, 323 — fallbacks to the pre-fix API (`build ? … : defs.map(...)`, `?? ((k, l) => l === 0 && …)`, `?? ((k) => k.radius)`); after the fix the exports exist, so the fallback branches never run; if an export is renamed the test silently tests the old rule.
  - [TEXT] test/render-defects.test.ts:749–753 — test passes by regex on the source text of src/render/post.ts (`class FadingCSM extends CSMShadowNode`); proves nothing about behaviour.
  - [BUG] test/render-defects.test.ts:84, 124, 348, 357, 636, 740, 960-style constants — camera at −5100, plate centre `2*5+2`, cell `18*40+16`, "the 10 km map has 100 tiles" hard-code the 10 km map; (inference) under `?mapa=24` or a changed default MAP_SIZE these tests assert on the wrong cells/plates.
  - [BUG] test/render-defects.test.ts:656–660 — `nightU.value` set to 1 and only reset at L660 after asserts; a failing assert at L659 leaves night on for later tests in the same process.
  - [NAME] test/render-defects.test.ts:604 — comment cites URL flag `?semdetalhe` (Portuguese).
  - [HOST] test/render-defects.test.ts:22, 265, 406, 444, 501, 522, 569, 614 — tests reach private fields by casts (`cells`, `owned`, `csm._init`, `shelters`, `data`, `cache`, `next`, `manageTile`); couples tests to internals.
- **Superfície pública:** none (test file).

#### `test/render-terrain.test.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Assunto único (terreno no render); L148–149 confere o texto da fonte em vez do comportamento; membros opcionais por duck typing (L51, L79, L117).
- **Responsabilidades (a-l):** L1–11 sets `location.search='?mapa=24'` before importing config/world/terrain; L13–19 centre camera helper; L21–37 E34 terrain patches only in frustum; L39–66 E33 water tiles only in view, < 2 M tris; L68–95 E36 terrain shadow caster via SHADOW_ONLY_LAYER; L97–109 E35 grass by eye height over local ground; L111–119 water material transparent + sea same water; L121–142 ecology wet/dry/bare; L144–150 cooked surfaces exist and are referenced; L152–162 water env intensity 0.42/0.6.
- **Achados do leitor (a-l):**
  - [TEXT] test/render-terrain.test.ts:148–149 — asserts that the source text of src/render/terrain.ts contains `COOKED['terrain-grass.map']` etc.; string match on source, not behaviour.
  - [DEAD] test/render-terrain.test.ts:98, 102 — `HEIGHT_TILE_RES` imported then `void`ed.
  - [DEAD] test/render-terrain.test.ts:88–94 — layer assertions only run `if (caster !== terrain.mesh)`; if the main mesh is the caster the shadow-only-layer part is skipped silently.
  - [DEAD] test/render-terrain.test.ts:51, 79, 117 — duck-typed optional members (`waterFar?`, `shadowMesh?`, `createSeaMaterial?.()`); test adapts to whichever API exists.
  - [R40COPY] test/render-terrain.test.ts:152 — cites "4.0 water.ts:177" for the 0.42 value (value source, not code copy).
  - [NAME] test/render-terrain.test.ts:8 — URL flag `?mapa=24` (Portuguese).
- **Superfície pública:** none.

#### `test/repair.test.ts`

- **Veredito: JUNTAR** → test/roadEdits.test.ts (com flatWorld de test/helpers/world.ts)
- **Evidência e regra (coordenador):** flatWorld idêntico em roadEdits.test.ts:8–13 e streetNames.test.ts:11–16 (L7–12); nome em português.
- **Responsabilidades (a-l):** L7–12 flat world; L14–32 `repairDanglingEnds` turns an old-save dangling end inside another road into a 3-way junction, leaves one under a bridge, idempotent.
- **Achados do leitor (a-l):**
  - [NAME] test/repair.test.ts:14–28 — test title and comments in Portuguese ("mapa antigo: ponta solta…").
  - [DUP] test/repair.test.ts:7–12 — `flatWorld` identical to roadEdits.test.ts:8–13, streetNames.test.ts:11–16 (and variants in roads.test.ts:109, roadDefects.test.ts:23).
- **Superfície pública:** none.

#### `test/roadContinuity.test.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Assunto único; empacotamento de material copiado de jobs/roadMesh (L25).
- **Responsabilidades (a-l):** L16–32 decode road mesh (quantized positions) into asphalt triangles; L34–38 point-in-triangle; L40–45 dash phase continuity across nodes; L47–64 no asphalt hole across a 4-way junction for profiles 0 and 18.
- **Achados do leitor (a-l):**
  - [TEXT] test/roadContinuity.test.ts:25 — material read as `color[i*4+3] & 15`, packing layout of jobs/roadMesh duplicated in the test.
  - [TEXT] test/roadContinuity.test.ts:48 — profile `18` by bare index.
- **Superfície pública:** none.

#### `test/roadDefects.test.ts`

- **Veredito: DIVIDIR** → test/roadDefects.test.ts (só vias) + test/zoneTool.test.ts, test/growth.test.ts (junto), test/core.test.ts (junto: tabela e pilha de desfazer), test/itemTool.test.ts, test/lotEditsShared.test.ts (junto)
- **Evidência e regra (coordenador):** 59,6 KB com vias, zonas, crescimento, relógio, tabela, pilha de desfazer, itens e lotes (L1–1031); perfis achados pelo nome em português (L103…L939); D13 passa vazio se todas as rotatórias forem recusadas (L522–586).
- **Responsabilidades (a-l):** L23–55 helpers (flatWorld, road, shape, generatedRoad); L57–110 D2 generated roads free/costs; L112–156 A21 undo/redo failure atomicity; L158–194 D4 max degree / journal guard rollback; L196–241 D3/D5 roundabout refusal, bridge/tunnel clearance; L243–285 D6 bulbs/sea; L287–309 D9/A41/A40 decay and clock; L311–363 D8 junction spec follows split legs; L365–388 A23 street names on id reuse; L390–406 D7 lots across cell edge; L408–426 A19 Table.allocAt O(n); L428–439 A44 undo byte budget; L441–479 D10/D11 brush/river dirty bits and bridges; L481–588 D12–D16 roundabouts, splits, joins, max segment length; L590–631 D17/D18 moveNode/changeProfile clearing; L633–666 D19 parking side; L668–708 D20/D21; L710–771 D22–D24 zone tool, stop sign demolition; L773–827 D25b/D25 ItemTool poles/walls; L829–846 D26 lot edits; L848–871 D27 growth speed; L873–928 D28/D30/D38/D39; L930–969 D33/D32 growth records; L971–1030 D35/D36/D43/D29.
- **Achados do leitor (a-l):**
  - [MIX] test/roadDefects.test.ts:1–1031 — roads, zone tool, growth, decay clock, Table free list, undo stack budget, item tool, lot edits in one file.
  - [TEXT] test/roadDefects.test.ts:103, 227, 617, 651, 673, 729, 902, 918, 939 — profiles found by Portuguese display name (`'Avenida 6 faixas com canteiro'`, `'Metrô'`, `'Estacionamento de um lado'`, `'Ferrovia dupla'`, `'Rodovia 6 faixas'`, …); renaming a profile label breaks behaviour lookups.
  - [DEAD] test/roadDefects.test.ts:856–861 — `cells` Map built in D27 and never read.
  - [DEAD] test/roadDefects.test.ts:361–362 — D8 ends with `commands.undo(); commands.undo();` and no assertion after it.
  - [DEAD] test/roadDefects.test.ts:522, 578, 586, 281 — conditional (`if (!j) continue`, `if (!j.empty)`, `if (typeof m !== 'string')`, `if (j)`): D13 passes vacuously if every roundabout is refused.
  - [BUG] test/roadDefects.test.ts:960 — `5120 % 512` and `-5120` hard-code the 10 km map's origin in D32 (inference: wrong cells on another map size).
  - [HOST] test/roadDefects.test.ts:862, 952 — private `Growth.setLots` reached by cast; L779/806 `Proxy` stub passed as `never` for ItemTool host.
  - [LAYER] test/roadDefects.test.ts:12, 711, 774 — imports `features/demolition`, `features/zones`, `features/streetscape` together with roads/world (fine for tests, notes the cross-feature coupling under test).
- **Superfície pública:** none.

#### `test/roadEdits.test.ts`

- **Veredito: RENOMEAR** → test/roadEdits.test.ts (nomes em inglês; helpers de test/helpers/world.ts)
- **Evidência e regra (coordenador):** Helpers flatWorld/road/shape duplicados (L8–30); nomes em português.
- **Responsabilidades (a-l):** L8–30 helpers (flatWorld, road, shape); L32–46 split/join + undo; L48–60 reverse one-way + undo; L62–75 moveNode + refusal; L77–89 duplicateRoad + undo.
- **Achados do leitor (a-l):**
  - [NAME] test/roadEdits.test.ts:22, 32, 48, 51, 57, 62, 77 — test titles and comments in Portuguese.
  - [DUP] test/roadEdits.test.ts:8–30 — flatWorld/road/shape duplicate roadDefects.test.ts:23–47 and streetNames.test.ts:11–22.
  - [BUG] test/roadEdits.test.ts:44 — `k.invert(); j.invert();` where `j` is the return of `splitAt` (L37); if `splitAt` returns a journal already settled this is fine (inference: not checked whether `j.settle()` is needed before invert, other tests call settle).
- **Superfície pública:** none.

#### `test/roadGround.test.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Assunto único; perfil pelo nome 'Avenida' (L12).
- **Responsabilidades (a-l):** L14–28 helpers; L30–38 `roadGroundAt` strips across an avenue; L40–56 building a road clears carriageway items and sidewalk plants, keeps furniture, undo restores.
- **Achados do leitor (a-l):**
  - [TEXT] test/roadGround.test.ts:12 — profile found by name `'Avenida'`.
  - [TEXT] test/roadGround.test.ts:28 — item record as positional tuple `[x, z, 0, 0, type, 0]`.
- **Superfície pública:** none.

#### `test/roads.test.ts`

- **Veredito: DIVIDIR** → test/roads.test.ts (construção) + test/lots.test.ts (junto) + test/roadWater.test.ts
- **Evidência e regra (coordenador):** Imports no meio do arquivo (L106, L228): cresceu por anexação; nomes em português; trincheira do rio presa a um tamanho de mapa (L171).
- **Responsabilidades (a-l):** L12–20 cross helper; L22–34 profile widths and lines; L36–60 arm retreats (cross, T, width ramp); L62–71 bezier split/intersect; L73–92 network adjacency, dirty, junction mesh + far ribbon; L94–104 remove/add seg; L106–226 build/undo/redo, long road split, bridge over river, demolish + roundabout, roundabout ring; L228–261 buildLots not over roads; L263–274 parking per side.
- **Achados do leitor (a-l):**
  - [NAME] test/roads.test.ts:22, 36, 49, 62, 73, 94, 125, 152, 168, 179, 206, 231, 263 — every test title and most comments in Portuguese.
  - [TEXT] test/roads.test.ts:29 — profile by name `'Avenida 4 faixas'`; L31 `PROFILE_INFO[2]`, L136 profile `3` by index.
  - [BUG] test/roads.test.ts:171 — river trench written with `gz < 2560` and `gx 1270..1290` (hard-coded height-map size/centre of one map size; inference: wrong place on other map sizes).
  - [MIX] test/roads.test.ts:106, 228 — imports mid-file (`build.ts`, `lots.ts`) after tests: file grew by appending.
  - [DUP] test/roads.test.ts:116–123 — `snapshot` same idea as roadDefects `shape` / roadEdits `shape`.
- **Superfície pública:** none.

#### `test/roadVariant.test.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Assunto único.
- **Responsabilidades (a-l):** L9–11 helpers; L13–22 lane variants 2/4/6/median buildable; L24–36 parking presets, none on highway; L38–45 total width sharing; L47–53 registerVariant dedup and marking.
- **Achados do leitor (a-l):**
  - [R40COPY] test/roadVariant.test.ts:2–3 — cites 4.0 main.ts:1489-1512, roadSection.ts:246-259, roadParking.ts:4-46 as the value source.
  - [TEXT] test/roadVariant.test.ts:25 — kerb position assumed at `strips[2]` and `strips[length-3]`.
- **Superfície pública:** none.

#### `test/save.test.ts`

- **Veredito: JUNTAR** → test/saveFiles.test.ts
- **Evidência e regra (coordenador):** Um teste só sobre o mesmo assunto de saving.test.ts.
- **Responsabilidades (a-l):** L7–21 meta encode/decode with `extra` JSON; version-5 meta without extra still decodes.
- **Achados do leitor (a-l):**
  - [NAME] test/save.test.ts:7, 15 — Portuguese title/comment; L9 sky value `'noite'` (Portuguese identifier-like value stored in save meta).
  - [SMALL] test/save.test.ts — one test; overlaps saving.test.ts topic (could live there).
- **Superfície pública:** none.

#### `test/saving.test.ts`

- **Veredito: DIVIDIR** → test/jobPool.test.ts + test/saveFiles.test.ts
- **Evidência e regra (coordenador):** Pool de trabalhos (L7–101) e arquivos do save (L103–263) no mesmo arquivo.
- **Responsabilidades (a-l):** L9–47 FakeWorker and job outcome helper; L49–101 JobPool A5/A6 (uncloneable, dying worker replaced, restart cap, superseded keys); L103–130 MemoryStore FileStore and save-generation helper; L132–185 A9 save generations (failed commit, fallback, legacy gen 0); L187–199 A14 quarantine; L201–211 A17 cancel by key prefix; L213–241 electron/files.mjs atomic file store; L243–263 migrateOnce OPFS → files.
- **Achados do leitor (a-l):**
  - [MIX] test/saving.test.ts:7–101 vs 103–263 — job pool tests and save file tests in one file.
  - [TEXT] test/saving.test.ts:194, 196 — quarantine folders recognised by Portuguese prefix `'quarentena-'`; L133 etc. slot `'cidade-1'`, L248 `'anterior-…'` (Portuguese folder names as on-disk format).
  - [TEXT] test/saving.test.ts:219–220 — `electron/files.mjs` imported through a variable (`where`) to dodge type checking.
- **Superfície pública:** none.

#### `test/simCity.ts`

- **Veredito: MOVER** → test/helpers/simCity.ts
- **Evidência e regra (coordenador):** Ajudante (não é teste); devolve `ops: []` novo (L37) enquanto o ouvinte da L19 continua enchendo o array local: o campo devolvido é morto (nenhum chamador o lê, conferido em simDefects.test.ts).
- **Responsabilidades (a-l):** L11–38 `gridCity` builds an n×n road grid via road tools and mirrors to SimNet; L40–45 `mirror` through the worker encoding; L47–52 `recordOps`; L54–62 `traffic` wired like the worker; L64–69 `syncNet`; L71–73 `inner` any-cast.
- **Achados do leitor (a-l):**
  - [BUG] test/simCity.ts:18–19, 37 — the listener pushed at L19 keeps appending every later network op to the local `ops` array forever, while the returned `ops` (L37) is a fresh empty array that nothing fills; (inference) unbounded growth during long tests and a misleading field.
  - [TEXT] test/simCity.ts:13–14, 26 — avenue profile `3` by bare index; two stacked doc comments for one function.
  - [HOST] test/simCity.ts:71–73 — `inner` returns `any` (eslint disabled) to reach private members; used across sim tests.
  - [DUP] (callers) wiring of peds↔traffic callbacks is not here; it is repeated in each test (see simMotion/simDefects).
- **Superfície pública:** `SimCity`, `gridCity`, `mirror`, `recordOps`, `traffic`, `syncNet`, `inner` — fixtures for sim tests.

#### `test/simDefects.test.ts`

- **Veredito: DIVIDIR** → test/simDefects.test.ts (só simulação) + os testes de render (L404–425, L793–802, L882–915) para test/renderPeople.test.ts e test/renderVehicles.test.ts
- **Evidência e regra (coordenador):** 59,5 KB; mistura render e simulação; empacotamento de faixas recodificado (L69…L677) em vez de laneSeg/laneId; v*96 em vez de ROUTE_CAP (L616).
- **Responsabilidades (a-l):** L10–33 helpers someConn/place; L35–52 C8 meso pass count; L54–110 C12 routing respects bans/lane connectors; L112–140 C9 resent lines keep buses/riders; L142–201 C11/C6 signals with no cars / far lights; L203–245 C1/C4 governor and dock bias; L247–272 C5 pedestrian birth; L274–360 C15/C16/C17 demolish/reuse/upgrade; L362–402 C2/C3 far lane capacity/banned turns; L404–425 C20/C27 render looks; L427–533 C21/C48/C50/C22/C19/C18; L533–656 C10/C31/C32/C42/C34; L658–720 C35/C37/C38; L722–823 C40/C45/C25/C28/C24; L825–915 C26/C51/C52/C43; L917–1031 C23/C33/bus stops/C39/far pace/turn curves.
- **Achados do leitor (a-l):**
  - [MIX] test/simDefects.test.ts:404–425, 793–802, 882–915 — render tests (people looks, vehicle follow match, bike model, PeopleRenderer batches) inside the sim defect file.
  - [TEXT] test/simDefects.test.ts:69, 298, 305, 326, 331, 357, 394, 399, 542, 546, 668, 672, 677 — lane id packing (`>> 4`, `& 7`, `& 8`, `seg * 16 + k`) re-coded in the test while `laneSeg`/`laneId` exist (L276, L534).
  - [BUG] test/simDefects.test.ts:616 — route offset `v * 96` hard-codes ROUTE_CAP (imported at L7 and used elsewhere as `ROUTE_CAP`); breaks silently if the cap changes.
  - [TEXT] test/simDefects.test.ts:437, 838 — pedestrian route stride `p * 32` hard-coded.
  - [TEXT] test/simDefects.test.ts:586, 728, 750, 808 — rail profile by Portuguese name `'Ferrovia dupla'` / `includes('ferro')`.
  - [DEAD] test/simDefects.test.ts:151–153, 257, 778 — `if ('x' in P)` / `typeof P.setDoors === 'function'` wiring that adapts to old/new APIs; L687 `void T` unused.
  - [DEAD] test/simDefects.test.ts:197–200 — C6 pedestrian assertion only `if (green)`.
  - [DUP] test/simDefects.test.ts:21–33 — `place` near-identical to simPort.test.ts:29–41 `placeOn`.
- **Superfície pública:** none.

#### `test/simMotion.test.ts`

- **Veredito: MANTER** → test/simMotion.test.ts (fiação peds↔traffic em test/helpers/simWiring.ts)
- **Evidência e regra (coordenador):** Fiação dos callbacks do worker copiada em 5 testes (L48–281).
- **Responsabilidades (a-l):** L9–39 walkers keep moving across expressway; L41–74 no walker jumps > 0.3 m per publication; L76–115 no fused pedestrians, pace 1.2–1.5 m/s; L117–167 cars stop before crosswalk, never inside a walker; L169–203 vehicle heading continuity out of turns; L205–236 body ends stay on path in turns; L238–266 pedestrian turn rate; L268–299 bus riders stay off carriageway.
- **Achados do leitor (a-l):**
  - [DUP] test/simMotion.test.ts:48–52, 83–85, 124–129, 245–248, 276–281 — the worker's peds↔traffic callback wiring (walkOk, onWait, pedCrossing, carsOn, pickTrip, onStop) copied in every test instead of a simCity helper; (inference) it can diverge from src/sim/worker.ts wiring.
  - [DEAD] test/simMotion.test.ts:127–129 — conditional `'pedCrossingArms' in T` wiring.
  - [TEXT] test/simMotion.test.ts:27–31, 95–106, 140–157, 291–294 — inspect record strides (12 for peds, 18 for vehicles) and field offsets as bare numbers; L130 vehicle widths `W` hard-coded.
  - [ALLOC] test/simMotion.test.ts:54 — `Float32Array(1 << 20)` ×3 per test (test only, not a game hot path).
- **Superfície pública:** none.

#### `test/simPort.test.ts`

- **Veredito: MANTER** → test/simPort.test.ts (placeOn em test/helpers/simCity.ts)
- **Evidência e regra (coordenador):** placeOn ≈ place de simDefects.test.ts:21–33 (L29–41); exporta ajudantes de dentro de um teste.
- **Responsabilidades (a-l):** L10–26 `straightRun` finder; L28–41 `placeOn` vehicle setup; L43–79 driver personality spread and following gap; L81–114 IDM with constant-acceleration heuristic and jerk limit; L116–141 truck docks at the gate; L143–173 lateral acceleration in turns.
- **Achados do leitor (a-l):**
  - [R40COPY] test/simPort.test.ts:2 — "Behaviour ported from roadcraft 4.0's traffic (src/sim of roadcraft-4.0-main)" (behaviour reference, rebuilt as columns).
  - [DUP] test/simPort.test.ts:29–41 — `placeOn` ≈ simDefects.test.ts:21–33 `place`.
  - [TEXT] test/simPort.test.ts:33 — `c.color[id] &= 15` bit layout re-coded in the test.
  - [SMALL] test/simPort.test.ts:11, 29 — exports `straightRun`/`placeOn` from a test file (only used here as far as this batch shows).
- **Superfície pública:** `straightRun`, `placeOn` (test helpers).
- **Exports nunca importados (b):** `straightRun`, `placeOn`

#### `test/simWorker.test.ts`

- **Veredito: DIVIDIR** → test/simWorker.test.ts + pickLook para test/renderPeople.test.ts
- **Evidência e regra (coordenador):** Teste de render pickLook dentro do teste do worker (L127–136).
- **Responsabilidades (a-l):** L12–43 fake `self`, fake clock and `setTimeout`, worker module loaded once, init message; L45–56 C13 bounded catch-up after a stall; L58–71 C14 failing op reported + resync; L73–84 C14 every distinct error reported; L86–100 C29 per-hour stats on simulated time; L102–125 C30 paused poses standing; L127–136 C30 walk rate at speed (render looks); L138–175 C7 VehicleRenderer reads only poses in view.
- **Achados do leitor (a-l):**
  - [MIX] test/simWorker.test.ts:127–136 — render `pickLook` test inside the worker loop file.
  - [HOST] test/simWorker.test.ts:79, 91 — monkey-patches `Traffic.prototype.step`/`lineStats` (restored in finally).
- **Superfície pública:** none.

#### `test/streetNames.test.ts`

- **Veredito: RENOMEAR** → test/streetNames.test.ts (nomes em inglês)
- **Evidência e regra (coordenador):** Assunto único; nomes em português; `rem.invert()` chamado duas vezes seguidas sem reaplicar (L76 e L78, conferido).
- **Responsabilidades (a-l):** L11–22 helpers; L24–44 street identity, stable name, metric even/odd numbering; L46–55 player-given name; L57–89 sign = rule (stop/yield sign changes junction leg rule, undo, signal ignores).
- **Achados do leitor (a-l):**
  - [NAME] test/streetNames.test.ts:24, 33, 40, 46, 57, 79, 84, 86 — Portuguese titles/comments.
  - [TEXT] test/streetNames.test.ts:31, 54 — behaviour asserted on Portuguese generated name prefixes `/^Rua /`, `/^Avenida /`; L52 profile by name `'Avenida'`.
  - [BUG] test/streetNames.test.ts:76–78 — `rem.invert()` is called at L76 and again at L78 (`add.invert(); rem.invert();`); (inference) inverting the same command twice without a re-apply; the test does not assert after L78, so the double inverse is untested and possibly corrupting state for the yield part.
  - [DUP] test/streetNames.test.ts:11–22 — same flatWorld/road helpers as roadEdits.test.ts.
- **Superfície pública:** none.

#### `test/structures.test.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Dois testes curtos; as regras de pilar moram em jobs/roadMesh.ts.
- **Responsabilidades (a-l):** L8–16 pier stations (29.6 m land, 38.4 m water, clear of abutments, mid-span fallback); L18–24 bent columns sizing.
- **Achados do leitor (a-l):**
  - [R40COPY] test/structures.test.ts:2 — values from "Roadcraft 4.0 render/structures.ts".
  - [LAYER] test/structures.test.ts:6 — pier/bent logic is exported from `jobs/roadMesh.ts` (structure rules living in the road mesher module).
  - [SMALL] test/structures.test.ts — two short tests.
- **Superfície pública:** none.

#### `test/terrain-gen.test.ts`

- **Veredito: RENOMEAR** → test/terrainGen.test.ts
- **Evidência e regra (coordenador):** Nome com hífen fora do padrão camelCase dos outros testes; resoluções fixas (L47–48) em vez de HEIGHT_TILE_RES/WATER_TILE_RES.
- **Responsabilidades (a-l):** L10–24 river middle finder; L26–44 generated river level above sea, monotonic, depth 6–12 m, dry banks; L46–54 tile generator writes water and hasWater; L57–90 generated city avoids river (nodes only as bridge middles, bridges ≤ 320 m); L92–124 lakes compact, flat, not discs.
- **Achados do leitor (a-l):**
  - [TEXT] test/terrain-gen.test.ts:47–48 — tile resolutions `256*256` and `128*128` hard-coded instead of HEIGHT_TILE_RES/WATER_TILE_RES.
  - [DEAD] test/terrain-gen.test.ts:11 — fallback `waterLevelAt ? … : NO_WATER` makes the test adapt to a missing export.
  - [TEXT] test/terrain-gen.test.ts:65, 83 — city output read as flat arrays with strides 5 (segs) and 3 (nodes) re-coded in the test.
  - [ALLOC] test/terrain-gen.test.ts:47–50 — allocates and generates every tile of the map on the test thread (TILE_COUNT×65536 floats); test cost, not game path.
  - [R40COPY] test/terrain-gen.test.ts:2, 37 — river depths from 4.0's river brush.
- **Superfície pública:** none.

#### `test/terrainSeams.test.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Testa um comportamento (recorte do terreno junto às vias); decodificação quantizada repetida (L17–24) deve vir de uma função do próprio render.
- **Responsabilidades (a-l):** L16–24 unpack a PackedMesh into world-space triangles + corner kind (colour alpha); L26–37 bucket triangles by 4 m square; L38–51 barycentric top-height lookup; L53–114 one test: 3x3 street grid, builds road mesh + terrain seams for the origin cell, checks ground never over road (L88–95) and no step at footway edge (L96–110), thresholds L111–113.
- **Achados do leitor (a-l):**
  - [DUP] test/terrainSeams.test.ts:17–24 — quantised position decode (`scale / 32767`, stride 4, origin) is the PackedMesh decode; same decode likely in render-side unpack (search `scale / 32767`).
  - [TEXT] test/terrainSeams.test.ts:100 — "clear of junctions" relies on the 100 m grid spacing literal (`x % 100`), tied to L57–58 layout.
- **Superfície pública:** none (test).

#### `test/texts.test.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Teste de textos; não varre subpastas de src/ui nem creator/inspector/roadCatalog (L15) e ignora linhas com `return '` (L17): defeito do teste registrado, não muda o veredito.
- **Responsabilidades (a-l):** L12–18 file list + exemption regexes; L20–35 source scanner for player-looking phrases; L37–40 test B57/B58 (no phrase outside dictionaries); L42–55 test B62 (every OptionalActions member and every Hud method is called somewhere).
- **Achados do leitor (a-l):**
  - [BUG] test/texts.test.ts:17 — NOT_PLAYER skips any line containing `return '` or `` return ` `` or `label: '`; a player sentence returned from a helper (`return 'Estrada bloqueada'`) is never reported, so the B57 gate has a wide hole.
  - [BUG] test/texts.test.ts:15 — `readdirSync('src/ui')` is not recursive and excludes creator.ts, inspector.ts, roadCatalog.ts: sub-folders of ui and those three files are never scanned; features outside ui (src/features/**, src/render/**) are not scanned either.
  - [TEXT] test/texts.test.ts:44–53 — B62 parses hud.ts and game.ts source by regex (`export interface OptionalActions` … `type PopId`, `this.hud = new Hud(... satisfies HudActions)`); renaming those anchors silently breaks the test (slice(-1) returns wrong ranges).
  - [NAME] test/texts.test.ts:3 — refers to `DEFEITOS-roadcraft-novo.md` and `data/textos-roadcraft` (Portuguese names).
- **Superfície pública:** none (test).

#### `test/traffic.test.ts`

- **Veredito: RENOMEAR** → test/traffic.test.ts (nomes de teste em inglês)
- **Evidência e regra (coordenador):** Nomes e comentários em português (L35…L492); acessa privados por cast (L319, L397–401); dump DBG (L325–328).
- **Responsabilidades (a-l):** L11–33 gridCity helper (builds roads, mirrors ops through encodeOps/decodeOp into SimNet); L35–54 network mirror lanes/conns/signals; L56–107 cars spawn/move/stop/arrive + give-way and no-overlap; L109–126 demolish under traffic; L128–158 pedestrians; L160–182 buses; L184–207 bus+ped transfer; L209–249 lane arrows/bus lane; L251–275 road cost undo/no money; L277–330 train on rail only; L332–365 manual lane links; L367–410 mid-block crossing zebra/ped signal; L412–436 U-turn; L438–490 auto control advisor with hysteresis; L492–514 gridlock no removals.
- **Achados do leitor (a-l):**
  - [NAME] test/traffic.test.ts:35,56,109,128,160,184,209,251,277,332,367,412,438,492 — test names and most comments in Portuguese (rule: tests in English).
  - [TEXT] test/traffic.test.ts:279 — rail profile found by display name `'Ferrovia dupla'` (same in test/transit.test.ts:63, tools/check-interface.mjs:96); Portuguese label used as identity.
  - [DEV] test/traffic.test.ts:325–328 — `process.env.DBG` console dump of segments left in a committed test.
  - [HOST] test/traffic.test.ts:319 and 397–401 — reaches private internals via casts (`tr.buses.sets[0]`, `(tr as any).junctions.gateRules`); tests couple to Traffic's private structure.
  - [DEAD] test/traffic.test.ts:394,402 — `k` assigned then `void k`.
  - [BUG] test/traffic.test.ts:64,97 — pose buffer allocated `100000 * 10` floats but written with stride 11 (`writePoses(data, 11)`); only safe if writePoses caps by buffer length (inference).
  - [R40COPY] test/traffic.test.ts:441,459 — thresholds "limiares (roadcraft)" 500/150/80% taken from 4.0 (values, not code).
- **Superfície pública:** none (test).

#### `test/transit.test.ts`

- **Veredito: RENOMEAR** → test/transit.test.ts (nomes em inglês; ajudante World→ops→SimNet em test/helpers/simNet.ts)
- **Evidência e regra (coordenador):** Nomes em português; helper igual ao de traffic.test.ts:11–33 (L13–29).
- **Responsabilidades (a-l):** L13–29 net helper (World → ops → SimNet); L31–46 bus line out-and-back stops and terminals, loop option; L48–60 Transit colour/loop as undoable commands + encode/decode; L62–97 level crossing: barrier down with train, no car enters, page sees signal bit 128.
- **Achados do leitor (a-l):**
  - [NAME] test/transit.test.ts:31,48,62 — test names/comments in Portuguese.
  - [TEXT] test/transit.test.ts:63 — rail profile by name `'Ferrovia dupla'`.
  - [DUP] test/transit.test.ts:13–29 — same World→ops→SimNet helper as test/traffic.test.ts:11–33 (gridCity) and :230–233, :295–299.
  - [TEXT] test/transit.test.ts:70,82,85 — magic `1 << 17` signals buffer size, bit `128` for barrier, vehicle kind `4` = train; layout constants repeated from sim (search `kind[v] === 4`).
- **Superfície pública:** none (test).

#### `test/world.test.ts`

- **Veredito: DIVIDIR** → test/terrainGen.test.ts, test/brush.test.ts, test/water.test.ts, test/tileStore.test.ts, test/poseBuffers.test.ts
- **Evidência e regra (coordenador):** Um arquivo testa 8 assuntos sem relação (L1–163); nomes em português.
- **Responsabilidades (a-l):** L19–26 terrain determinism; L28–36 debug city determinism/budget; L38–56 terrain brush undo/redo; L58–80 brush dries river water and undo restores; L82–90 box mesh counts; L92–111 tile + meta save round trip; L113–128 triple pose buffer; L130–163 river command and ground paint stroke undo.
- **Achados do leitor (a-l):**
  - [MIX] test/world.test.ts:1–163 — one file tests terrain gen, debug city, brush, water, box mesh, tile storage, meta, pose buffers, river; unrelated subjects (pose buffers L113–128 belong to shared/contracts).
  - [DEV] test/world.test.ts:13,31–35 — `debugTileBoxes` from `src/jobs/debugCity.ts`: a debug city generator lives in product `jobs/` and is part of the tile save format (L95–101 encodes boxes).
  - [NAME] test/world.test.ts:19,28,38,58,82,92,113,130 — test names in Portuguese.
  - [DUP] test/world.test.ts:6,131 — ground.ts imported statically (L6) and again dynamically (L131) for RiverCommand/waterAt/NO_WATER/GroundStroke; NO_WATER shadowed.
  - [TEXT] test/world.test.ts:24,104 — `44 % 10`, `65536` hard-code a 10-tile-wide grid and 256² heights per tile.
- **Superfície pública:** none (test).

#### `tools/arch-audit.mjs`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Ferramenta do portão; defeitos: isenta do limite de 50 KB todo arquivo da lista do baseline (L217–220, conferido), só olha imports de valor (vazamentos só de tipo passam), PLATFORM_FILES aponta para caminhos antigos da raiz (L14), camada 'tools' que não existe mais.
- **Responsabilidades (a-l):** L8–15 config/layer file sets; L17–66 walk src/, parse imports with TypeScript AST (static, re-export, dynamic import); L68–77 layer classifier; L79–113 edges + Tarjan SCC cycles (value vs type-only); L115–148 layer matrix and allowed-boundary rules; L150–202 report JSON/MD; L204–208 console; L210–229 `--check` gate vs baseline.
- **Achados do leitor (a-l):**
  - [BUG] tools/arch-audit.mjs:76,146–147 — directories not in the list (e.g. `domain`, listed as a layer in CLAUDE.md) map to `'other'`; `allowed['other']` is undefined so their imports are never checked, and imports into `other` are only checked from the importing side.
  - [BUG] tools/arch-audit.mjs:74 — any new root `src/*.ts` not in the three sets is classified `app` (widest permissions), silently.
  - [BUG] tools/arch-audit.mjs:217,220 — `--check` exempts every file present in baseline `files` (top 80 by size, many < 50 KB) from the size gate with no upper bound: game.ts, traffic.ts, buildingGen.ts, buildingMesh.ts are ≥150 KB (baseline over150k = 4) and can keep growing; CLAUDE.md "no file ≥150 KB" is not enforced.
  - [TEXT] tools/arch-audit.mjs:14,201 — PLATFORM_FILES lists root paths (`src/save.ts`, `src/steam.ts`, `src/audio.ts`) while other files reference `src/platform/audio.ts`, `src/platform/steam.ts` (test/texts.test.ts:14); footer says "`shared` = config/steam/save/mapFile/audio", contradicting L13–14. Stale mapping.
  - [LAYER] tools/arch-audit.mjs:76,138 — `tools` (src/tools) is treated as a layer, not in CLAUDE.md's layer list.
- **Superfície pública:** CLI only (`--check <baseline>`); writes test-results/architecture/audit.{json,md}.

#### `tools/arch-baseline.json`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Linha de base do portão (só muda em main com o dono); está velha: 228 arquivos contra 294 hoje, e congela 4 arquivos acima de 150 KB que já não existem nesse tamanho.
- **Responsabilidades (a-l):** L2–30 summary at baseline (228 files, 0 value cycles, 4 type-only cycles, 0 violations, 4 files ≥150 KB); L31–32 empty cycles/violations; L33–354 top 80 files by size.
- **Achados do leitor (a-l):**
  - [BUG] tools/arch-baseline.json:35–48 — four files over the 150 KB cap are frozen as baseline: src/r40/render/buildings/buildingMesh.ts 214,876 B, src/jobs/buildingGen.ts 171,124, src/sim/traffic.ts 167,035, src/game.ts 160,779 (god files); src/r40/render/buildings/signature.ts 108,069 and 7 more ≥50 KB.
  - [TEXT] tools/arch-baseline.json:163,339 — `src/saveFiles.ts`, `src/mapFile.ts` at src root (platform files outside src/platform at baseline time).
- **Superfície pública:** read by tools/arch-audit.mjs `--check`.

#### `tools/budget.json`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Limites do orçamento (só o dono muda).
- **Responsabilidades (a-l):** L1–62 per-view baseline counts (street, district, city, map, night): draws, tris, buildings, segs, cityMB, roadsMB, cars, micro, peds.
- **Achados do leitor (a-l):**
  - (inference) tools/budget.json:2–13,50–61 — street/night baselines are 17.5 M tris and ~485–499 draws; with budget.mjs limits (2x tris, +150 draws) the near views may reach 35 M tris before failing.
- **Superfície pública:** read/written by tools/budget.mjs.

#### `tools/budget.mjs`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Medidor do orçamento; vistas copiadas de fotos.mjs (L20–26) passam a vir de tools/photos/views.mjs.
- **Responsabilidades (a-l):** L13–17 paths/flags; L20–26 five fixed views; L29–36 limits relative to baseline; L39–42 in-page script (fixDetail, view, settle, stats); L44–51 spawn shot.mjs with CIDADE_SEQ; L53–63 parse `BUDGET {json}` lines; L65–80 compare or write baseline; L82–102 table + failure list.
- **Achados do leitor (a-l):**
  - [DEV] tools/budget.mjs:38–39 — counts run with `g.fixDetail(true)` ("detail held at full while counting"); (inference) the game has an adaptive detail mode that the budget switches off, so the measured state differs from normal play — CLAUDE.md forbids code that behaves differently under measurement and adaptive detail as a budget trick.
  - (inference) tools/budget.mjs:30–34 — street/district/night limits are generous (+150/+100 draws, 2x tris); only city/map are tight.
  - [DUP] tools/budget.mjs:20–26 — views duplicated from tools/fotos.mjs (comment L19 says "same views").
- **Superfície pública:** CLI (`--baseline`).

#### `tools/check-interface.mjs`

- **Veredito: DIVIDIR** → tools/checks/run.mjs (executor comum) + tools/checks/interface/<recurso>.mjs (vias, transporte, céu, prédios, gravar, áudio, teclas)
- **Evidência e regra (coordenador):** 66,5 KB num arquivo só com todos os cenários (L1–877); executor repetido em 5 arquivos (L842–876); lê g.waterCtl que não existe (L307).
- **Responsabilidades (a-l):** L14–49 PRELUDE page helpers (errors capture, frames, click/key/mapClick, road, themed list helpers); L52–837 ~50 UI scenarios (B16…B57, 4.0 top bar/drawers/options/keys/dropdown/new world/language/hint/keys panel/inspector fade, B27); L840 run only as program; L842–876 runner: one Electron session (tools/shot.mjs) per body, own user-data folder, CHECK line parsing.
- **Achados do leitor (a-l):**
  - [MIX] tools/check-interface.mjs:1–877 — 66 KB single file holding every interface scenario across all features (roads, transit, weather, buildings, save, audio, keys); over the 50 KB product limit (tools/ is outside arch-audit's src walk).
  - [TEXT] tools/check-interface.mjs:75,100,110–113,122,125,162,177–179,305,… — scenarios find controls by visible label regex (`'Estação de trem|Train station'`, `'Ferrovia dupla'` L96); a wording change breaks checks.
  - [DUP] tools/check-interface.mjs:842–876 — same spawn-shot/parse-CHECK runner as tools/check-render.mjs:202–236, check-save.mjs:637–682, check-vias.mjs:234–259, check-sim.mjs:346–375; PRELUDE helpers (wait, check, errors capture) repeated in each.
  - [DEV] tools/check-interface.mjs:15,541–559 — depends on `window.__cidade.game` global exposing internals (api, hudActions, world, rig) in the shipped page, and a `?dev` health panel (F9) for developers (B30) — (inference) dev-only UI in product.
  - [DEAD] tools/check-interface.mjs:577 — `w.money = w.money` no-op.
  - [HOST] tools/check-interface.mjs:351,233,750 — monkeypatches `g.simStats`, `g.sim.postMessage`, `g.generatedCity` to drive checks (test doubles inside the real page).
- **Superfície pública:** `PRELUDE`, `SCENARIOS` (importable by a test); CLI `[scenario...]`.
- **Exports nunca importados (b):** `SCENARIOS`

#### `tools/check-reload-keys.mjs`

- **Veredito: JUNTAR** → tools/checks/save/reload-keys.mjs usando o cliente CDP de tools/checks/cdp.mjs
- **Evidência e regra (coordenador):** Cliente CDP escrito duas vezes no mesmo arquivo (L30–35, L49–61) e de novo em check-save.mjs:553–635; alvo não verificado (L30–32, L74–75).
- **Responsabilidades (a-l):** L11–16 Electron exe path and key table; L19–24 open game with DevTools port; L27–40 reopen and count saved segments; L42–88 one session per key: build roads, send key via CDP Input.dispatchKeyEvent, detect close/reload/no-op, compare saved segments; L90–97 loop + exit code.
- **Achados do leitor (a-l):**
  - [BUG] tools/check-reload-keys.mjs:30–32 — `savedSegments` does not check `target` is found; if the reopened game never lists a page, `target.webSocketDebuggerUrl` throws TypeError (session() has the check at L53).
  - [BUG] tools/check-reload-keys.mjs:74–75 — after a reload the target lookup is not retried/guarded; if the page is momentarily absent, `target` is undefined and the run throws instead of reporting.
  - [DUP] tools/check-reload-keys.mjs:30–35,49–61 — CDP connect/evaluate code written twice in the same file; also overlaps the reload scenarios in tools/check-save.mjs:430–439.
  - [TEXT] tools/check-reload-keys.mjs:35,61,78 — readiness by Portuguese status string `'pronto'` (also check-save.mjs:563,599).
- **Superfície pública:** CLI only.

#### `tools/check-render.mjs`

- **Veredito: MOVER** → tools/checks/render.mjs
- **Evidência e regra (coordenador):** Constantes do mapa (L16), empacotamento dos props (L32) e layout dos slots (L18, L37, L53) copiados à mão do código do jogo; executor repetido.
- **Responsabilidades (a-l):** L13–38 PRELUDE (map constants, prop slot index, putProps packer writing straight to the prop pool, indirect-args readback); L40–200 scenarios: many-trees, rooftop-props, offscreen-shadow, still-shadows, idle-frames, still-trees, windy-trees, far-forest (pixel-diff via CIDADE_DIFF); L202–236 runner.
- **Achados do leitor (a-l):**
  - [DUP] tools/check-render.mjs:16 — hard-codes `MAP_HALF = 5120, CELL = 256, MAP_CELLS = 40` (config.ts constants) in a string.
  - [DUP] tools/check-render.mjs:32 — re-implements the prop record packing (`yaw | variant<<12 | scale<<16`, `type | key<<5`) of the props worker output (search jobs/props.ts); format drift would not be caught by tsc.
  - [DUP] tools/check-render.mjs:18,37,53 — draw-slot layout `kind * 3 + level` and indirect stride 5 duplicated from render props.
  - [DEAD] tools/check-render.mjs:160 — `const y = w.tileMax[0] ? 0 : 0;` unused and constant.
  - [TEXT] tools/check-render.mjs:62 — tile index `Math.floor(10 / 2) * 10 + 5` assumes 10x10 tiles.
  - [DUP] tools/check-render.mjs:202–236 — runner duplicated with other check-*.mjs (see check-interface).
- **Superfície pública:** CLI only (SCENARIOS not exported).

#### `tools/check-save.mjs`

- **Veredito: DIVIDIR** → tools/checks/save/*.mjs + tools/checks/cdp.mjs + tools/checks/window-message.ps1
- **Evidência e regra (coordenador):** Junta cenários, cliente Chrome/CDP e envio de mensagem de janela do Windows (L553–635); reimplementa o formato do pacote do mapa de platform/mapFile.ts (L95–104).
- **Responsabilidades (a-l):** L13–109 PRELUDE: failure injectors (failWrites, failStorage over FileStore/OPFS/pool), file helpers over FileStore or OPFS, tileFile via manifest, map package pack/unpack, toast capture; L111–498 Electron scenarios (failed save, repair, generate after load, broken import, close saves, interrupted save, missing tile, storage error, export, unreadable neighbour, quarantine, stale lots, overlap, unlimited money, test-city heights, app:// path, desktop files, OPFS migration, previous cities, reload keys, alt-f4, window keys, language saves); L501–516 Node-side SETUP/POST; L520–551 browser two-tabs scenario; L553–623 Chrome+serve.mjs driver over CDP; L626–635 Alt+F4 via PowerShell PostMessage; L637–682 runner.
- **Achados do leitor (a-l):**
  - [MIX] tools/check-save.mjs:553–635 — one file also contains a Chrome launcher/CDP client and a Windows PowerShell window-message sender besides the scenarios.
  - [DUP] tools/check-save.mjs:95–104 — re-implements the map package format (`'CIDADE-MAPA-1'`, header 13 bytes, u32 name/data lengths) of src/mapFile.ts.
  - [DUP] tools/check-save.mjs:60–61 — tile index from `1024` m tiles and `MT * 512` half-map, duplicating config/grid.
  - [TEXT] tools/check-save.mjs:244,263,319,256 — toast checks by Portuguese text regex only (`/pedaço|pedaços/`, `/ilegíve|pedaço|quarentena/`); English game would make them pass/fail wrongly. L312 folder name prefix `'quarentena-'`, L62 slot `'cidade-1'` shared magic strings.
  - [DEV] tools/check-save.mjs:434,476–484 — relies on `window.roadcraftApp.testKey` in the shipped preload: (inference) a test hook in product Electron code.
  - [BUG] tools/check-save.mjs:599–600 — the Chrome driver proceeds after 240 s even if a tab never became `'pronto'`; the following step then fails with a less precise reason (minor).
- **Superfície pública:** CLI `[scenario...]`.

#### `tools/check-sim.mjs`

- **Veredito: MOVER** → tools/checks/sim.mjs (formatos de inspeção e de pose importados de src/shared/contracts)
- **Evidência e regra (coordenador):** Passos V=18/Q=12 e bits de bandeira redeclarados (L196); layout de pose redeclarado (L171); espera o texto em português 'rede reenviada' (L81).
- **Responsabilidades (a-l):** L11–15 output folder argument; L17–28 PRELUDE; L30–87 scenarios: motion (multi-step probe), city-traffic (whole-city stats + photo), resync (forced sim failure → page resends network); L89–104 motion step list; L108–159 place picker (signal/plain junction, builds roundabout and bus line); L162–188 sampler (sim `inspect` messages + pose buffer every 0.25 s); L191–344 invariant checks (stall, wait, box, off-lane, overlap SAT, clashes, red-run, ped speed/sidewalk/red-cross/in-car/fused/walk-in-place/feet); L346–375 runner with CIDADE_SEQ photos.
- **Achados do leitor (a-l):**
  - [DUP] tools/check-sim.mjs:196 — inspect record strides `V = 18`, `Q = 12`, vehicle widths `W` and flag bits `RED…GATE` re-declared from the sim worker's inspect format (search `type: 'inspect'` in src/sim).
  - [DUP] tools/check-sim.mjs:171 — pose layout decode (`d[o+8] % 65536 / 256` = type, stride 11) re-declared from shared/contracts/poses.
  - [TEXT] tools/check-sim.mjs:76 — hand-encoded op `ops[0] = 2` (remove node opcode) instead of encodeOps.
  - [TEXT] tools/check-sim.mjs:81,83 — expects game error text `'rede reenviada'` (Portuguese log) and `'node still connected'`.
  - [R40COPY] tools/check-sim.mjs:31–33,190,231 — invariants taken from 4.0 `sim/invariants.ts` (named in comments; checks rewritten).
  - [BUG] tools/check-sim.mjs:60 — `s3.cars` read without null check (L41–47 guard s1/s2); if stats are null the scenario throws (caught as "ran to the end" failure, masking the cause).
- **Superfície pública:** CLI `[output-folder] [scenario...]`.

#### `tools/check-user-data.mjs`

- **Veredito: MOVER** → tools/checks/user-data.mjs
- **Evidência e regra (coordenador):** Uma verificação; nome de pasta e slot fixos (L13, L45).
- **Responsabilidades (a-l):** L11–13 locate the game's user-data folder; L16–25 recursive listing with size+mtime; L28–40 run shot.mjs with its own folder and save; L42–54 verify own folder used, save written there, game folder untouched.
- **Achados do leitor (a-l):**
  - [TEXT] tools/check-user-data.mjs:13 — product folder name `'Roadcraft'` hard-coded (must match Electron app name); L45 slot `'cidade-1'`.
  - [SMALL] tools/check-user-data.mjs — one check; standalone CLI.
- **Superfície pública:** CLI only.

#### `tools/check-vias.mjs`

- **Veredito: MANTER** → tools/checks/roads.mjs (com o executor comum de tools/checks/run.mjs)
- **Evidência e regra (coordenador):** Uma responsabilidade; executor e PRELUDE repetidos dos outros check-*.mjs (L13–21, L234–259); clica botões pelo texto em português (L161, L163).
- **Responsabilidades (a-c):** L1–21 header + PRELUDE page helpers (g/a/w handles, wait, check, road, pointer events); L23–232 eleven scenarios (tool error ends drag, road preview price, inspector join, lot delete stroke, impossible node warning, junction plan, profile editor, road options, street name clear, catalogue language, catalogue delete template); L234–259 runner: one Electron session per scenario via tools/shot.mjs, own user data folder, parses CHECK lines.
- **Achados (a-c):**
  - [HOST] reaches private Game members by name: g.setTool, g.roadTool, g.drag, g.lotStroke, g.setLotMode, g.inspector, g.hud.catalog internals (grid, tabs, editor, built, build, fromEditor, languageChanged), g.rig.state (L26–34, L73–75, L200–230). Any extraction from game.ts must keep these names or update this file.
  - [DUP] L13–21 PRELUDE and L234–259 runner repeat the same spawn/parse runner of check-interface.mjs, check-render.mjs, check-save.mjs, check-sim.mjs (reported by b17 at check-interface.mjs:842–876).
  - [TEXT] L161, L163 clicks buttons by Portuguese aria-label text ('4 faixas', 'Vagas paralelas nos dois lados'); L174 'Avenida'; L133 /Editar perfil|Edit profile/: tied to the pt-BR strings of engine.pt-BR.ts.
  - [TEXT] L215, L227 localStorage key 'cidade.modelosDeVia' duplicated from the source that writes it (inference: ui/roadCatalog.ts or roads/profiles.ts).
- **Superfície pública:** CLI `node tools/check-vias.mjs [scenario...]`.

#### `tools/cook-people-decode.cjs`

- **Veredito: MOVER** → tools/people/decode.cjs
- **Evidência e regra (coordenador):** Executor de um trabalho chamado só por cook-people.mjs.
- **Responsabilidades (a-l):** L8–41 Electron main: hidden sandboxed window decodes WebP files (from COOK_DECODE_JOB JSON) via createImageBitmap/OffscreenCanvas, downsizes to `size`, writes `[u32 w][u32 h][RGBA]`.
- **Achados do leitor (a-l):**
  - [SMALL] tools/cook-people-decode.cjs — single job runner; caller is tools/cook-people.mjs (per comment L1).
  - (inference) tools/cook-people-decode.cjs:15–18,26–28 — whole files and pixel data round-trip through base64 strings inside executeJavaScript; fine for an offline asset tool, memory-heavy for large textures.
- **Superfície pública:** Electron entry (no exports).

#### `tools/cook-people.mjs`

- **Veredito: DIVIDIR** → tools/people/cook.mjs (CLI) + importar REGION/CLIPS/versão de src/render/people/format.ts
- **Evidência e regra (coordenador):** Constantes duplicadas à mão com format.ts:5,8,15 (L18, L267, L666–671); medidas da bicicleta copiadas de render/vehicles.ts (L624–640); `await main()` no topo roda o cozimento inteiro quando alguém só importa as constantes (L913).
- **Responsabilidades (a-l):** L1–25 header, paths, flags; L27–70 quaternion/vector maths + mulberry32 rng; L72–105 load MakeHuman base mesh, PCA/local targets, rig weights; L107–128 23-bone rig, capture bone mapping, posture pairs; L130–204 macro-slider morphing (`stateWeights`, `macroWeights`, `shape`, `ageFromYears`); L206–231 proxy (clothes/hair) load + fit; L233–263 texture cache, sampling, Electron WebP decode spawn; L265–306 the cast (32 variations: sex x age band x 4); L308–459 `buildBody` (shape, posture correction, skinning, body/eyes + clothing parts with region/colour/budgets); L461–504 hand-held props (phone, cup, bag, paper, umbrella, helmet) as procedural boxes/cylinders; L506–563 Rocketbox capture load, clip decode, arm override, hand-forward frame, source FK; L565–646 retarget, topo order, FK, two-bone IK, procedural pedal frame; L648–701 bone palette 3x4 + loop closing; L703–729 normals, meshopt simplify (3 LODs), oct-encode; L731–773 PNG writer + CPU software rasteriser preview; L775–884 `main` cook (simplify, vertex pack, palettes, bin layout 256-aligned, people.json); L886–911 preview images.
- **Achados do leitor (a-l):**
  - [DUP] tools/cook-people.mjs:18 — `COOK_VERSION = 2` must match `PEOPLE_COOK_VERSION` in src/render/people/format.ts:5 (comment-enforced, no shared source).
  - [DUP] tools/cook-people.mjs:267 — `REGION` table duplicated verbatim in src/render/people/format.ts:8; `CLIPS` order (L666–671) duplicated by `CLIP_PROP` in format.ts:15.
  - [DUP] tools/cook-people.mjs:624–640 — bicycle dimensions (saddle 0.85/z -0.16, bars 0.92/0.38, bracket 0.4/0.05) copied by hand from src/render/vehicles.ts per the comment; a change there silently breaks the pedal pose.
  - [TEXT] tools/cook-people.mjs:896 — preview prop visibility chosen by hard-coded clip indexes (3,6,7,10,9) and `v.r < 8`, duplicating CLIPS order instead of `CLIP_PROP`; clips 4 (phone), 5 (read), 8 (umbrella) never show their prop in previews (they are not previewed at L905, so latent).
  - [TEXT] tools/cook-people.mjs:803, 848 — LOD2 exclusion and loop-closing selected by name string lists.
  - [BUG] tools/cook-people.mjs:861 — `+(x ? 1.495864 : 1.596625).toFixed(4) * (pelvisY / 0.9)`: `toFixed` applies only to the constant, the product is unrounded; magic constants 1.495864/1.596625 and divisor 0.9 have no source cited in file.
  - [BUG] tools/cook-people.mjs:18, 109, 913 — module exports `COOK_VERSION`/`BONES` but runs `await main()` at top level: importing it to read the constants runs the whole cook and rewrites public/cooked/people.
  - [DEAD] tools/cook-people.mjs:503 — `reg: p.reg.map((r) => r)` copy with no effect.
  - [ALLOC] tools/cook-people.mjs:365–375, 806–819 — per-vertex array allocations and string keys (`${part.name}:${v}:${flip}`) — offline only, not a runtime hot path.
  - (inference) tools/cook-people.mjs:258–261 — texture decode requires Electron binary from node_modules (tools/cook-people-decode.cjs, exists).
- **Superfície pública:** `COOK_VERSION` (cook format version), `BONES` (23 kept bone names); CLI `npm run cook:people [--preview]`.

#### `tools/foto-seguir.mjs`

- **Veredito: JUNTAR** → tools/photos/sets.mjs (um executor, conjuntos nomeados)
- **Evidência e regra (coordenador):** Mesmo esqueleto de spawn de shot.mjs em 8 arquivos (L7–18); nome em português.
- **Responsabilidades (a-l):** L1–18 one photo following a vehicle at (177,711) via shot.mjs and `g.hudActions.follow()`.
- **Achados do leitor (a-l):**
  - [DUP] tools/foto-seguir.mjs:7–18 — same spawn-shot.mjs boilerplate (root, out, wait, env, delete ELECTRON_RUN_AS_NODE, exit) as fotos-carro.mjs, fotos-carros-qa.mjs, fotos-survey.mjs, fotos-testemunho.mjs, fotos-pessoas-qa.mjs, fotos-onibus-*.mjs, fotos.mjs; no shared helper.
  - [NAME] tools/foto-seguir.mjs — Portuguese file name/output names ("seguir", "01-seguindo.png") against the English-only rule.
  - [SMALL] tools/foto-seguir.mjs — one-shot script; not referenced in package.json scripts.
- **Superfície pública:** none (CLI `node tools/foto-seguir.mjs [folder]`).

#### `tools/fotos-carro.mjs`

- **Veredito: JUNTAR** → tools/photos/sets.mjs
- **Evidência e regra (coordenador):** Esqueleto repetido; foto 01 tirada duas vezes (L13 e L24, conferido com electron/main.mjs:124–126).
- **Responsabilidades (a-l):** L1–27 seven close cabin photos at one junction, day/night, plus follow.
- **Achados do leitor (a-l):**
  - [BUG] tools/fotos-carro.mjs:13, 24 — the initial shot (no script) and `seq[0]` write the same file `01-carro-8m.png`; electron/main.mjs:124 runs `[shot, CIDADE_SCRIPT]` first then the seq, so the first photo is taken twice and overwritten (wasted settle time).
  - [DUP] tools/fotos-carro.mjs:7–27 — spawn boilerplate (see foto-seguir.mjs).
  - [NAME] Portuguese file/photo names.
- **Superfície pública:** none (CLI).

#### `tools/fotos-carros-qa.mjs`

- **Veredito: JUNTAR** → tools/photos/sets.mjs
- **Evidência e regra (coordenador):** Esqueleto repetido; foto 01 duplicada (L15, L28); escreve g.rig.dist/pitch direto (L13).
- **Responsabilidades (a-l):** L1–31 car opacity QA at 20/100/500 m day/night plus follow at same distances.
- **Achados do leitor (a-l):**
  - [BUG] tools/fotos-carros-qa.mjs:15, 28 — same double-shot of `01-carro-20m-dia.png` as fotos-carro.mjs.
  - [HOST] tools/fotos-carros-qa.mjs:13 — writes camera rig internals directly (`g.rig.dist`, `g.rig.pitch`) from the page script instead of a camera API.
  - [DUP] spawn boilerplate.
- **Superfície pública:** none (CLI).

#### `tools/fotos-interface.mjs`

- **Veredito: MOVER** → tools/photos/interface.mjs
- **Evidência e regra (coordenador):** Cenas acham botões pelo texto pt/en (L24–58); laço "prédio mais próximo" colado 3 vezes (L45, L50, L57); lê campos privados do Game (lotExtraPts L57).
- **Responsabilidades (a-l):** L13–19 in-page helper prelude (click, byText, esc, reset); L21–61 `SCENES` table of ~40 UI scenes driven by DOM clicks; L63–75 run first scene + seq via shot.mjs (lang/dev flags).
- **Achados do leitor (a-l):**
  - [TEXT] tools/fotos-interface.mjs:24–58 — scenes find controls by visible label regex in pt/en (`'Quarteir|Blocks'`, `'Bomba|Bomb'`, `'Opções gráficas|Graphics options'` ...); renaming a string in engine.*.ts breaks the scene silently (only a `console.log('script: ...')`, L19).
  - [HOST] tools/fotos-interface.mjs:42–45, 50, 57 — page scripts read SoA internals (`n.segs.cols.a`, `nodes.alive`, `buildings.cols.floors`) and set private state (`g.lotExtraPts=[A]` L57, `g.world.unlimited=true` L54).
  - [DUP] tools/fotos-interface.mjs:45, 50, 57 — the same "nearest building with floors filter" loop is pasted three times; L43 nearest-junction loop also in fotos-onibus-qa.mjs:15–23, 31–35.
  - [DEV] tools/fotos-interface.mjs:66–67 — `saude` (health panel) scene opens the game with `&dev`; the panel is developer-only.
  - [TEXT] tools/fotos-interface.mjs:55 — hard-coded Portuguese toast text injected (not via i18n).
  - [DEAD] tools/fotos-interface.mjs:21 — `SCENES` exported but no other tool imports it (grep of tools/).
  - [NAME] Portuguese scene and file names.
- **Superfície pública:** `SCENES` (scene name -> in-page script).
- **Exports nunca importados (b):** `SCENES`

#### `tools/fotos-onibus-curva.mjs`

- **Veredito: JUNTAR** → tools/photos/sets.mjs
- **Evidência e regra (coordenador):** Esqueleto repetido; script de montagem roda duas vezes (L23 e L29): vias e linha construídas em dobro.
- **Responsabilidades (a-l):** L1–31 empty-map square of roads, a 3-point bus line with a 90° last leg, 30 frames from a fixed camera.
- **Achados do leitor (a-l):**
  - [BUG] tools/fotos-onibus-curva.mjs:23, 29 — `build` script passed both as the initial CIDADE_SCRIPT (L29) and as `seq[0]` (L23) with the same file: roads and line are built twice (second set of `g.api.road` on the same coordinates, second `g.api.line(0, ...)`).
  - [DUP] spawn boilerplate.
  - [NAME] Portuguese names.
- **Superfície pública:** none (CLI).

#### `tools/fotos-onibus-qa.mjs`

- **Veredito: JUNTAR** → tools/photos/sets.mjs
- **Evidência e regra (coordenador):** Lê o buffer de poses com passo 11 e deslocamentos fixos (L37–42), cópia privada do formato de shared/contracts/poses.ts; linha criada duas vezes (L47, L66).
- **Responsabilidades (a-l):** L13–27 build a 4-corner bus line from nearest nodes around (177,711); L28–45 pick and follow the nearest bus to a junction; L46–68 14 frames.
- **Achados do leitor (a-l):**
  - [TEXT] tools/fotos-onibus-qa.mjs:37–42 — decodes the vehicle reader buffer with hard-coded stride 11 and offsets 4, 6, 8 and kind `floor((d[o+8]%65536)/256)===1`: duplicates the vehicle pose layout privately; a layout change breaks it silently.
  - [BUG] tools/fotos-onibus-qa.mjs:47, 66 — `makeLine` runs as the initial script and again as `seq[0]` (same file): two identical lines are created.
  - [OMAP] tools/fotos-onibus-qa.mjs:17, 31 — full scans of all nodes (tool only, not runtime).
  - [HOST] tools/fotos-onibus-qa.mjs:42 — writes `g.rig.dist/pitch` directly.
- **Superfície pública:** none (CLI).

#### `tools/fotos-pacote.mjs`

- **Veredito: DIVIDIR** → tools/photos/views.mjs (tabela única de vistas, usada também por fotos.mjs e budget.mjs) + tools/photos/package.mjs
- **Evidência e regra (coordenador):** Diz usar as vistas de fotos.mjs mas fotografa rua e noite em (0,0) (L20–27) e fotos.mjs em (177,711): duas tabelas de vistas divergentes; procura do Chrome duplicada com serve.mjs:43–46.
- **Responsabilidades (a-l):** L13–28 views and query; L30–43 run packaged Electron exe with its own profile; L44–98 browser path: start shipped serve.mjs, start Chrome with remote debugging, minimal CDP client, wait for status, evaluate scripts, capture screenshots.
- **Achados do leitor (a-l):**
  - [BUG] tools/fotos-pacote.mjs:1, 21–27 — header says "the views of tools/fotos.mjs", but `01-rua` and `04-noite` here are at (0,0) (QUERY L21, view L20) while tools/fotos.mjs:14, 20, 31 shoots them at the street (177,711); per fotos.mjs:13 (0,0) is the river. Package photos are not comparable to the standard ones.
  - [TEXT] tools/fotos-pacote.mjs:84–85 — game status compared to Portuguese strings `'pronto'`, `'falhou'`, `'carregando'` shared with the page (`window.__cidade.status`).
  - [DUP] tools/fotos-pacote.mjs:50–52 — Chrome path discovery duplicated in tools/serve.mjs:43–46.
  - [NAME] tools/fotos-pacote.mjs:14 — CLI flag `--navegador`, Portuguese.
- **Superfície pública:** none (CLI `npm run fotos:pacote` / `fotos:navegador`).

#### `tools/fotos-pessoas-qa.mjs`

- **Veredito: JUNTAR** → tools/photos/sets.mjs
- **Evidência e regra (coordenador):** Esqueleto repetido; foto 01 duplicada (L16, L25).
- **Responsabilidades (a-l):** L11–27 place a group and walkers with the game's people API, photos at 2/20/100 m day and 2/20 m night.
- **Achados do leitor (a-l):**
  - [BUG] tools/fotos-pessoas-qa.mjs:16, 25 — initial shot (after `place`) and `seq[0]` write the same file `01-pessoas-2m-dia.png`; the first is overwritten.
  - [LAYER] (inference) tools/fotos-pessoas-qa.mjs:12 — people readiness reached through `g.vehicles.people` (people owned by the vehicles subsystem object).
- **Superfície pública:** none (CLI).

#### `tools/fotos-survey.mjs`

- **Veredito: JUNTAR** → tools/photos/sets.mjs
- **Evidência e regra (coordenador):** Esqueleto e view() iguais a fotos-testemunho.mjs:12; foto 01 duplicada (L15, L34).
- **Responsabilidades (a-l):** L11–37 15 survey views over three junctions, river and whole city, day/night.
- **Achados do leitor (a-l):**
  - [BUG] tools/fotos-survey.mjs:15, 34 — double shot of `01-carro-a-perto-dia.png` (initial + seq[0]).
  - [DUP] tools/fotos-survey.mjs:12 — `view()` helper identical to fotos-testemunho.mjs:12; spawn boilerplate shared with the other foto tools.
- **Superfície pública:** none (CLI).

#### `tools/fotos-testemunho.mjs`

- **Veredito: JUNTAR** → tools/photos/sets.mjs
- **Evidência e regra (coordenador):** Vistas 01/04/05/06 iguais às de fotos.mjs; foto 01 duplicada (L15, L27).
- **Responsabilidades (a-l):** L11–30 eight evidence views (street, district, city, night) for a feature slice.
- **Achados do leitor (a-l):**
  - [BUG] tools/fotos-testemunho.mjs:15, 27 — double shot of `01-rua.png`.
  - [DUP] tools/fotos-testemunho.mjs:15–22 — 01/04/05/06 are the same views as tools/fotos.mjs:18–20, 31 (overlapping purpose with fotos.mjs and fotos-survey.mjs).
  - [NAME] Portuguese file name ("testemunho").
- **Superfície pública:** none (CLI).

#### `tools/fotos.mjs`

- **Veredito: MANTER** → tools/fotos.mjs (nome citado no CLAUDE.md; passa a ler tools/photos/views.mjs)
- **Evidência e regra (coordenador):** CLAUDE.md nomeia tools/fotos.mjs: só o dono muda o nome. game.view não aguardado (L16).
- **Responsabilidades (a-l):** L8–33 the four standard photos (street, district, city, night) over dist/.
- **Achados do leitor (a-l):**
  - [BUG] tools/fotos.mjs:16 — `game.view(...)` is not awaited (fotos-pacote.mjs:20 awaits it); the fixed wait is the only guard.
  - [NAME] tools/fotos.mjs:16 — parameter `hora` (Portuguese).
- **Superfície pública:** none (CLI `npm run fotos`).

#### `tools/make-icon.mjs`

- **Veredito: MOVER** → tools/package/make-icon.mjs + tools/lib/png.mjs
- **Evidência e regra (coordenador):** Escritor PNG/CRC duplicado com cook-people.mjs:732–741 (L64–72).
- **Responsabilidades (a-l):** L11–62 procedural icon drawing at 4x supersampling; L64–72 PNG encoder; L74–88 write electron/icon.png and multi-size icon.ico.
- **Achados do leitor (a-l):**
  - [DUP] tools/make-icon.mjs:64–72 — PNG/CRC writer duplicated in tools/cook-people.mjs:732–741 (RGB variant).
- **Superfície pública:** none (CLI `npm run icon`).

#### `tools/move-modules.mjs`

- **Veredito: APAGAR** → — (mover módulos com tsc + arch:check, ou um script baseado no serviço de linguagem do TypeScript)
- **Evidência e regra (coordenador):** Resolve especificadores literalmente (L23–24): ignora import sem extensão e `new URL('./x.ts', import.meta.url)` de workers (L16); deixa imports velhos que só o tsc pega.
- **Responsabilidades (a-l):** L8–14 parse moves, collect .ts/.mjs/.js in src/test/tools/scripts; L16–29 rewrite relative import specifiers; L30–34 `git mv`.
- **Achados do leitor (a-l):**
  - [BUG] (inference) tools/move-modules.mjs:23–24 — specifiers are resolved literally and matched against full file paths; an extensionless import (`'./foo'` for foo.ts) or a directory import is never matched, so it is left stale. Only works if every import carries the `.ts` extension (tsconfig.json:21 allows that).
  - [BUG] tools/move-modules.mjs:16 — regex misses `vi.mock('...')`/`new URL('...', import.meta.url)`/`new Worker(new URL(...))` worker references, so moved worker modules keep stale URLs.
- **Superfície pública:** none (CLI).

#### `tools/package-web.mjs`

- **Veredito: JUNTAR** → tools/package/ (common.mjs com ships/sizeOf/mb/zip)
- **Evidência e regra (coordenador):** ships() igual a package.mjs:30–31 (L16–21); README do jogador só em português (L37–47).
- **Responsabilidades (a-l):** L10–31 copy dist/ (no .map, only model licences) + serve.mjs; L32–47 launch scripts and LEIA-ME; L49–62 zip via tar/zip and print sizes.
- **Achados do leitor (a-l):**
  - [DUP] tools/package-web.mjs:16–21 — `ships()` filter duplicates tools/package.mjs:30–31 (comment says "the same choice").
  - [TEXT] tools/package-web.mjs:37–47 — player-facing README hard-coded in Portuguese only, not localized; says port 5173 although serve.mjs:55 may move to the next free port.
  - [NAME] tools/package-web.mjs:11, 59 — `Roadcraft-navegador`, Portuguese size labels.
- **Superfície pública:** none (CLI `npm run package:web`).

#### `tools/package.mjs`

- **Veredito: JUNTAR** → tools/package/ (common.mjs)
- **Evidência e regra (coordenador):** sizeOf/mb e zip iguais a package-web.mjs (L53–63); lê package.json relativo ao cwd (L9–13); steam_appid 480 de teste no pacote (L43).
- **Responsabilidades (a-l):** L8–41 Electron packager with ignore filter (dist, steamworks.js platform binary only, licences only); L42–43 steam_appid.txt; L45–50 prune Chromium locales; L52–69 zip and size report.
- **Achados do leitor (a-l):**
  - [DEV] tools/package.mjs:43 — writes `steam_appid.txt` with default `480` (Valve's test app) into the shipped package unless `STEAM_APPID` is set.
  - [BUG] tools/package.mjs:9–10, 13 — reads `package.json`/`node_modules/...` relative to cwd (other tools resolve `root`); running it from another folder fails or packages the wrong dir.
  - [DUP] tools/package.mjs:53–54 — `sizeOf`/`mb` identical to tools/package-web.mjs:56–57; zip invocation duplicated (L58–63 vs package-web.mjs:51–54).
  - [NAME] tools/package.mjs:66–67 — Portuguese labels.
- **Superfície pública:** none (CLI `npm run package:win|linux`).

#### `tools/quick-check.mjs`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Uma responsabilidade, citado no MEMORY e nas decisões; lista de testes rápidos por nome (L9) existe.
- **Responsabilidades (a-l):** L9–21 per-step check: tsc, arch-audit check, six fast tests.
- **Achados do leitor (a-l):**
  - [TEXT] tools/quick-check.mjs:9 — fast test list hard-coded by file name (all six exist in test/).
- **Superfície pública:** none (CLI).

#### `tools/serve.mjs`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Uma responsabilidade; guarda de travessia por prefixo de texto (L27) é defeito; cabeçalhos COOP/COEP repetidos de vite.config.ts.
- **Responsabilidades (a-l):** L11–22 locate dist/ and MIME table; L24–39 static server with COOP/COEP/CORP; L41–51 open Chrome/Edge/default browser; L53–63 listen with next-free-port retry.
- **Achados do leitor (a-l):**
  - [BUG] tools/serve.mjs:27 — traversal guard `file.startsWith(root)` is a string prefix: `/../dist-x/f` resolves to a sibling `dist-x` folder and passes. Bound to 127.0.0.1 (L59), so local only.
  - [DUP] tools/serve.mjs:43–46 — Chrome discovery duplicated in tools/fotos-pacote.mjs:50–52; COOP/COEP headers duplicated in vite.config.ts:14–17.
  - [TEXT] tools/serve.mjs:20, 61 — player-facing console text in Portuguese only.
- **Superfície pública:** none (CLI `npm start`, jogar.bat/sh).

#### `tools/shadercheck/check.mjs`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Uma responsabilidade (compilar shaders fora do jogo); remenda internos do three (L9–21), frágil mas é o propósito.
- **Responsabilidades (a-l):** L1–12 headless WebGPURenderer with stubbed backend; L14–24 `build()` node-builder to WGSL/GLSL; L25–28 expose globals and import material modules.
- **Achados do leitor (a-l):**
  - [HOST] tools/shadercheck/check.mjs:9–11, 20–21 — patches renderer internals (`r.backend.init`, `r._nodes.getFogNode`) — private three.js API, fragile across r186 updates.
  - [NAME] tools/shadercheck/check.mjs:1 — Portuguese comment.
- **Superfície pública:** `build(mesh, scene, camera, which)`.
- **Exports nunca importados (b):** `build`

#### `tools/shadercheck/mats.mjs`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Compila pr['clamp'] que não existe em render/props.ts (só reset L100 e cull L103): imprime ERRO sempre (defeito).
- **Responsabilidades (a-l):** L1–18 build a World, terrain, city/roads warmup meshes; L19–26 compile terrain/water/shells/roads; L27–46 props (WebGPU) + compute nodes; L47–55 weather; L56–62 props compat mode.
- **Achados do leitor (a-l):**
  - [BUG] tools/shadercheck/mats.mjs:37–40 — compiles `pr['clamp']`, but src/render/props.ts has only `reset` (L100) and `cull` (L103) compute members, no `clamp`: `b.compute = undefined` and this check prints "ERRO" every run (stale check).
  - [HOST] tools/shadercheck/mats.mjs:40 — reads private `reset`/`cull` fields of PropRenderer.
  - [NAME] tools/shadercheck/mats.mjs:20, 27, 34, 47 — Portuguese labels/comments ("terreno", "peças", "tempo", "ERRO").
- **Superfície pública:** none (loaded by check.mjs; `npm run shaders`).

#### `tools/shot.mjs`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Executor de fotos usado por todas as ferramentas.
- **Responsabilidades (a-l):** L9–32 launch Electron over dist/ with CIDADE_* env, filter output lines, timeout kill.
- **Achados do leitor (a-l):**
  - [TEXT] tools/shot.mjs:18 — output filter regex depends on log prefixes (`state:`, `photo:`, `[page]`) printed by electron/main.mjs:130.
- **Superfície pública:** none (CLI used by every foto tool and verificar.mjs).

#### `tools/shot.sh`

- **Veredito: APAGAR** → — (npm run shot passa a usar tools/shot.mjs)
- **Evidência e regra (coordenador):** Implementação paralela de shot.mjs; filtra 'página|estado|foto' (L7) mas electron/main.mjs:120,130 imprime 'state:'/'photo:' em inglês: esconde o estado e as fotos.
- **Responsabilidades (a-l):** L1–7 Linux SwiftShader/xvfb screenshot wrapper.
- **Achados do leitor (a-l):**
  - [BUG] tools/shot.sh:7 — greps Portuguese markers `página|estado|foto`, but electron/main.mjs now prints English `photo:` / `state:` (shot.mjs:18): the sh wrapper hides the state and photo lines.
  - [DUP] tools/shot.sh — parallel implementation of tools/shot.mjs; `npm run shot` (package.json:18) points to this Linux-only xvfb script, not shot.mjs.
  - [NAME] tools/shot.sh:2–3 — Portuguese comments.
- **Superfície pública:** none (CLI `npm run shot`).

#### `tools/simdefect-sweep.sh`

- **Veredito: APAGAR** → —
- **Evidência e regra (coordenador):** Varredura de depuração com 40 ids fixos sem explicação (L6), caminhos relativos sem cd (L3–9); nenhum script do package.json chama.
- **Responsabilidades (a-l):** L1–12 runs named simDefects tests (C1..C52 subset) one by one with 15 s timeout into a log.
- **Achados do leitor (a-l):**
  - [DEV] tools/simdefect-sweep.sh:6 — ad-hoc hard-coded list of 40 case ids with no comment or reason; one-off debugging sweep committed.
  - [BUG] tools/simdefect-sweep.sh:3–9 — relative paths, no `cd` to repo root: from another cwd it writes logs elsewhere and finds no test file.
  - [DUP] same structure as tools/test-sweep.sh.
- **Superfície pública:** none.

#### `tools/test-sweep.sh`

- **Veredito: APAGAR** → —
- **Evidência e regra (coordenador):** Varredura avulsa, caminhos relativos sem cd (L4–7); nenhum chamador.
- **Responsabilidades (a-l):** L1–13 each test file run with a 20 s limit into test-results/test-sweep.log.
- **Achados do leitor (a-l):**
  - [BUG] tools/test-sweep.sh:4–7 — relative paths without `cd` to root (same as simdefect-sweep.sh).
- **Superfície pública:** none.

#### `tools/textos.mjs`

- **Veredito: RENOMEAR** → tools/check-texts.mjs
- **Evidência e regra (coordenador):** Só varre src/ui/*.ts, main.ts e game.ts (L13): chaves pedidas por features/, render/, roads/ nunca são conferidas; listas copiadas à mão de hud.ts/drawers.ts (L28–43); nome e saída em português.
- **Responsabilidades (a-l):** L9–11 key sets from data/textos-roadcraft/{pt-BR,en}.ts + engine.{pt-BR,en}.ts; L13–26 scan code for t()/plural()/dotted literals; L27–43 template-built keys listed by hand; L44–53 report missing/one-sided keys.
- **Achados do leitor (a-l):**
  - [BUG] tools/textos.mjs:13 — scans only top-level `src/ui/*.ts`, `src/main.ts`, `src/game.ts`; keys requested from src/ui subfolders, features/, render/, roads/ etc. are never checked.
  - [DUP] [TEXT] tools/textos.mjs:28–43 — hand copies of code enumerations (tool names, zone names, el kinds, terrain landforms...) attributed to hud.ts/drawers.ts; they drift when code changes.
  - [TEXT] tools/textos.mjs:24 — long allow-list of key prefixes decides what counts as a key.
  - [LAYER] (inference) tools/textos.mjs:10–11 — a second dictionary in `data/textos-roadcraft/*.ts` besides src/shared/i18n/lang/engine.*.ts, which CLAUDE.md names as the only localized files.
  - [NAME] tools/textos.mjs:48–52 — Portuguese output.
- **Superfície pública:** none (CLI; exit 1 on problems).

#### `tools/verificar.mjs`

- **Veredito: MANTER** → tools/verificar.mjs (nome citado no CLAUDE.md)
- **Evidência e regra (coordenador):** Protocolo depende de marcadores em português 'VER ', 'VERIFICAÇÃO', 'FALHOU' (L27, L30–31) que os scripts imprimem; o nome está no CLAUDE.md.
- **Responsabilidades (a-l):** L11–37 run each scripts/verificacao/*.js in its own Electron session via shot.mjs on an empty map; parse `VER ` lines; count `FALHOU`; exit code.
- **Achados do leitor (a-l):**
  - [TEXT] tools/verificar.mjs:27, 30–31 — protocol depends on Portuguese markers `VER `, `VERIFICAÇÃO`, `FALHOU` printed by the scripts (scripts/verificacao/1-ferramentas-e-acoes.js:14–17).
  - [NAME] tools/verificar.mjs — Portuguese file name and output.
- **Superfície pública:** none (CLI gate `node tools/verificar.mjs`).

#### `tsconfig.json`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Configuração; inclui src, test e vite.config.ts.
- **Responsabilidades (a-l):** L2–22 strict ES2023 bundler config, `.ts` extension imports, erasable syntax only; L23–27 includes src, test, vite.config.ts.
- **Achados do leitor (a-l):**
  - (inference) tsconfig.json:23–27 — tools/*.mjs and shadercheck are not type-checked.
- **Superfície pública:** n/a.

#### `vite.config.ts`

- **Veredito: MANTER** → —
- **Evidência e regra (coordenador):** Configuração; 'sem git' aparece em Ajuda → Sobre sem tradução (L8); comentários em português.
- **Responsabilidades (a-l):** L6–11 build stamp (version, git hash, date); L13–17 COOP/COEP headers; L19–26 Vite config (relative base, ES workers, es2023, sourcemaps).
- **Achados do leitor (a-l):**
  - [TEXT] vite.config.ts:8 — fallback `'sem git'` is shown in Help → About (player-facing) and is not localized.
  - [NAME] vite.config.ts:5, 9, 13 — Portuguese comments.
  - [DUP] vite.config.ts:14–17 — COOP/COEP also in tools/serve.mjs:32–34.
  - (inference) vite.config.ts:25 — `chunkSizeWarningLimit: 4000` silences chunk-size warnings up to 4 MB.
- **Superfície pública:** default Vite config; `__BUILD__` define.
- **Exports nunca importados (b):** `default` (nem no arquivo)

### 3.2 Documentos, dados, imagens, modelos e arquivos gerados

Documentos: lidos pelo cabeçalho e propósito (não são código-fonte). Binários, modelos e assets cozidos: veredito pela função do arquivo e pelos seus leitores no código. Cada arquivo pelo nome.


**bomb/**

- `bomb/00-abertura.jpg` — **MOVER** → docs/studies/bomb/00-abertura.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/01-tela-inicial.jpg` — **MOVER** → docs/studies/bomb/01-tela-inicial.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/02-mapa-vazio.jpg` — **MOVER** → docs/studies/bomb/02-mapa-vazio.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/03-construir.jpg` — **MOVER** → docs/studies/bomb/03-construir.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/04-predio-cursor.jpg` — **MOVER** → docs/studies/bomb/04-predio-cursor.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/05-predio-colocado.jpg` — **MOVER** → docs/studies/bomb/05-predio-colocado.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/06-predio-perto.jpg` — **MOVER** → docs/studies/bomb/06-predio-perto.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/07-demolir.jpg` — **MOVER** → docs/studies/bomb/07-demolir.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/08-bomba-ferramenta.jpg` — **MOVER** → docs/studies/bomb/08-bomba-ferramenta.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/10-b1f5-0_1s.jpg` — **MOVER** → docs/studies/bomb/10-b1f5-0_1s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/10-b1f5-0_3s.jpg` — **MOVER** → docs/studies/bomb/10-b1f5-0_3s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/10-b1f5-0_6s.jpg` — **MOVER** → docs/studies/bomb/10-b1f5-0_6s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/10-b1f5-1_5s.jpg` — **MOVER** → docs/studies/bomb/10-b1f5-1_5s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/10-b1f5-12s.jpg` — **MOVER** → docs/studies/bomb/10-b1f5-12s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/10-b1f5-1s.jpg` — **MOVER** → docs/studies/bomb/10-b1f5-1s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/10-b1f5-2_5s.jpg` — **MOVER** → docs/studies/bomb/10-b1f5-2_5s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/10-b1f5-4s.jpg` — **MOVER** → docs/studies/bomb/10-b1f5-4s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/10-b1f5-6s.jpg` — **MOVER** → docs/studies/bomb/10-b1f5-6s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/10-b1f5-9s.jpg` — **MOVER** → docs/studies/bomb/10-b1f5-9s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/11-b1-rombo-perto.jpg` — **MOVER** → docs/studies/bomb/11-b1-rombo-perto.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/12-b1-outro-lado.jpg` — **MOVER** → docs/studies/bomb/12-b1-outro-lado.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/13-b1-de-cima.jpg` — **MOVER** → docs/studies/bomb/13-b1-de-cima.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/20-antes-b2.jpg` — **MOVER** → docs/studies/bomb/20-antes-b2.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/21-b2f5-0_1s.jpg` — **MOVER** → docs/studies/bomb/21-b2f5-0_1s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/21-b2f5-0_3s.jpg` — **MOVER** → docs/studies/bomb/21-b2f5-0_3s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/21-b2f5-0_6s.jpg` — **MOVER** → docs/studies/bomb/21-b2f5-0_6s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/21-b2f5-1_5s.jpg` — **MOVER** → docs/studies/bomb/21-b2f5-1_5s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/21-b2f5-12s.jpg` — **MOVER** → docs/studies/bomb/21-b2f5-12s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/21-b2f5-1s.jpg` — **MOVER** → docs/studies/bomb/21-b2f5-1s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/21-b2f5-2_5s.jpg` — **MOVER** → docs/studies/bomb/21-b2f5-2_5s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/21-b2f5-4s.jpg` — **MOVER** → docs/studies/bomb/21-b2f5-4s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/21-b2f5-6s.jpg` — **MOVER** → docs/studies/bomb/21-b2f5-6s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/21-b2f5-9s.jpg` — **MOVER** → docs/studies/bomb/21-b2f5-9s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/30-forca10.jpg` — **MOVER** → docs/studies/bomb/30-forca10.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/31-b3f10-0_1s.jpg` — **MOVER** → docs/studies/bomb/31-b3f10-0_1s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/31-b3f10-0_3s.jpg` — **MOVER** → docs/studies/bomb/31-b3f10-0_3s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/31-b3f10-0_6s.jpg` — **MOVER** → docs/studies/bomb/31-b3f10-0_6s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/31-b3f10-1_5s.jpg` — **MOVER** → docs/studies/bomb/31-b3f10-1_5s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/31-b3f10-12s.jpg` — **MOVER** → docs/studies/bomb/31-b3f10-12s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/31-b3f10-1s.jpg` — **MOVER** → docs/studies/bomb/31-b3f10-1s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/31-b3f10-2_5s.jpg` — **MOVER** → docs/studies/bomb/31-b3f10-2_5s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/31-b3f10-4s.jpg` — **MOVER** → docs/studies/bomb/31-b3f10-4s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/31-b3f10-6s.jpg` — **MOVER** → docs/studies/bomb/31-b3f10-6s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/31-b3f10-9s.jpg` — **MOVER** → docs/studies/bomb/31-b3f10-9s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/41-b4f10-0_1s.jpg` — **MOVER** → docs/studies/bomb/41-b4f10-0_1s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/41-b4f10-0_3s.jpg` — **MOVER** → docs/studies/bomb/41-b4f10-0_3s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/41-b4f10-0_6s.jpg` — **MOVER** → docs/studies/bomb/41-b4f10-0_6s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/41-b4f10-1_5s.jpg` — **MOVER** → docs/studies/bomb/41-b4f10-1_5s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/41-b4f10-12s.jpg` — **MOVER** → docs/studies/bomb/41-b4f10-12s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/41-b4f10-1s.jpg` — **MOVER** → docs/studies/bomb/41-b4f10-1s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/41-b4f10-2_5s.jpg` — **MOVER** → docs/studies/bomb/41-b4f10-2_5s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/41-b4f10-4s.jpg` — **MOVER** → docs/studies/bomb/41-b4f10-4s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/41-b4f10-6s.jpg` — **MOVER** → docs/studies/bomb/41-b4f10-6s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/41-b4f10-9s.jpg` — **MOVER** → docs/studies/bomb/41-b4f10-9s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/51-b5f20-0_1s.jpg` — **MOVER** → docs/studies/bomb/51-b5f20-0_1s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/51-b5f20-0_3s.jpg` — **MOVER** → docs/studies/bomb/51-b5f20-0_3s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/51-b5f20-0_6s.jpg` — **MOVER** → docs/studies/bomb/51-b5f20-0_6s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/51-b5f20-1_5s.jpg` — **MOVER** → docs/studies/bomb/51-b5f20-1_5s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/51-b5f20-12s.jpg` — **MOVER** → docs/studies/bomb/51-b5f20-12s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/51-b5f20-1s.jpg` — **MOVER** → docs/studies/bomb/51-b5f20-1s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/51-b5f20-2_5s.jpg` — **MOVER** → docs/studies/bomb/51-b5f20-2_5s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/51-b5f20-4s.jpg` — **MOVER** → docs/studies/bomb/51-b5f20-4s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/51-b5f20-6s.jpg` — **MOVER** → docs/studies/bomb/51-b5f20-6s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/51-b5f20-9s.jpg` — **MOVER** → docs/studies/bomb/51-b5f20-9s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/52-monte-perto.jpg` — **MOVER** → docs/studies/bomb/52-monte-perto.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/53-monte-de-cima.jpg` — **MOVER** → docs/studies/bomb/53-monte-de-cima.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/60-predio2-forca50.jpg` — **MOVER** → docs/studies/bomb/60-predio2-forca50.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/61-p2-b1f50-0_1s.jpg` — **MOVER** → docs/studies/bomb/61-p2-b1f50-0_1s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/61-p2-b1f50-0_3s.jpg` — **MOVER** → docs/studies/bomb/61-p2-b1f50-0_3s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/61-p2-b1f50-0_6s.jpg` — **MOVER** → docs/studies/bomb/61-p2-b1f50-0_6s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/61-p2-b1f50-1_5s.jpg` — **MOVER** → docs/studies/bomb/61-p2-b1f50-1_5s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/61-p2-b1f50-12s.jpg` — **MOVER** → docs/studies/bomb/61-p2-b1f50-12s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/61-p2-b1f50-1s.jpg` — **MOVER** → docs/studies/bomb/61-p2-b1f50-1s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/61-p2-b1f50-2_5s.jpg` — **MOVER** → docs/studies/bomb/61-p2-b1f50-2_5s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/61-p2-b1f50-4s.jpg` — **MOVER** → docs/studies/bomb/61-p2-b1f50-4s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/61-p2-b1f50-6s.jpg` — **MOVER** → docs/studies/bomb/61-p2-b1f50-6s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/61-p2-b1f50-9s.jpg` — **MOVER** → docs/studies/bomb/61-p2-b1f50-9s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/62-p2-assentado.jpg` — **MOVER** → docs/studies/bomb/62-p2-assentado.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/70-chao-f5-0_1s.jpg` — **MOVER** → docs/studies/bomb/70-chao-f5-0_1s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/70-chao-f5-0_3s.jpg` — **MOVER** → docs/studies/bomb/70-chao-f5-0_3s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/70-chao-f5-0_6s.jpg` — **MOVER** → docs/studies/bomb/70-chao-f5-0_6s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/70-chao-f5-1_5s.jpg` — **MOVER** → docs/studies/bomb/70-chao-f5-1_5s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/70-chao-f5-12s.jpg` — **MOVER** → docs/studies/bomb/70-chao-f5-12s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/70-chao-f5-1s.jpg` — **MOVER** → docs/studies/bomb/70-chao-f5-1s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/70-chao-f5-2_5s.jpg` — **MOVER** → docs/studies/bomb/70-chao-f5-2_5s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/70-chao-f5-4s.jpg` — **MOVER** → docs/studies/bomb/70-chao-f5-4s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/70-chao-f5-6s.jpg` — **MOVER** → docs/studies/bomb/70-chao-f5-6s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/70-chao-f5-9s.jpg` — **MOVER** → docs/studies/bomb/70-chao-f5-9s.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/ANALISE.md` — **MOVER** → docs/studies/bomb/ANALYSIS.md. Estudo do 4.0 (bomba) solto na raiz do repositório.

**bomb/folhas/**

- `bomb/folhas/10-b1f5.jpg` — **MOVER** → docs/studies/bomb/folhas/10-b1f5.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/folhas/21-b2f5.jpg` — **MOVER** → docs/studies/bomb/folhas/21-b2f5.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/folhas/31-b3f10.jpg` — **MOVER** → docs/studies/bomb/folhas/31-b3f10.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/folhas/41-b4f10.jpg` — **MOVER** → docs/studies/bomb/folhas/41-b4f10.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/folhas/51-b5f20.jpg` — **MOVER** → docs/studies/bomb/folhas/51-b5f20.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/folhas/61-p2-b1f50.jpg` — **MOVER** → docs/studies/bomb/folhas/61-p2-b1f50.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.
- `bomb/folhas/70-chao-f5.jpg` — **MOVER** → docs/studies/bomb/folhas/70-chao-f5.jpg. Foto do estudo da bomba do 4.0 (evidência citada em bomb/ANALISE.md) solta na raiz do repositório.

**(raiz)/**

- `CLAUDE.md` — **MANTER**. Arquivo do dono (só o dono muda). No worktree está apagado sem commit por outra sessão (git status: D CLAUDE.md): não é desta auditoria mexer.

**data/lots-roadcraft/**

- `data/lots-roadcraft/artDeco.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/balconyMid.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/bank.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/beauxArts.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/beigeClassic.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/brickFrame.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/cemetery.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/church.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/cityHallBrick.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/cityHallWhite.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/cubeBalcony.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/darkGlass.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/darkGrid.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/decoSpire.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/decoTower.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/fireStation.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/forum.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/glassBalcony.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/glassOffice.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/glassSpire.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/hexTerracotta.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/hospitalA.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/hospitalB.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/loftBrick.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/modernOffice.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/octCopper.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/pinkCorner.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/police.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/residentialTerrace.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/roundGlass.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/school.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/stackedBlocks.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/stepGarden.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/triangleDark.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/twinNavy.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/twistGreen.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/waveWhite.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).
- `data/lots-roadcraft/whiteBalcony.json` — **MANTER**. Projeto de lote do 4.0 (fonte do catálogo empacotado por pack.mjs; usado por test/buildingDefects.test.ts).

**docs/**

- `docs/ARQUITETURA.md` — **JUNTAR** → docs/ARCHITECTURE.md (um documento de arquitetura, em inglês). Quatro documentos de arquitetura se sobrepõem: ARQUITETURA, ORGANIZACAO, ESTRUTURA, STATE-OWNERSHIP.
- `docs/AUDIT-2026-10-30.md` — **MOVER** → docs/reports/AUDIT-2026-10-30.md. Relatório datado de fotos.
- `docs/AUDIT-PORT.md` — **MOVER** → docs/reports/AUDIT-PORT-2026-10-29.md. Relatório datado de outra worktree.
- `docs/ESTADO.md` — **APAGAR** → — (o estado vive em lab/MEMORY/STATE.md, CLAUDE.md "Memory continuity"). Segunda fonte do estado do trabalho (atualizado 2026-10-29 23h54), paralela ao MEMORY/STATE.md.
- `docs/ESTRUTURA.md` — **JUNTAR** → docs/ARCHITECTURE.md. Medição de estrutura de 2026-10-29 (228 arquivos; hoje 294): desatualizado.
- `docs/FOLD-EVALUATION-2026-10-30.md` — **MOVER** → docs/reports/FOLD-EVALUATION-2026-10-30.md. Relatório datado.
- `docs/historico-defeitos-roadcraft-4.md` — **MOVER** → docs/history/. Histórico de outra versão.
- `docs/historico-OTIMIZACAO-roadcraft-2.md` — **MOVER** → docs/history/. Histórico de outra versão.
- `docs/historico-PROBLEMAS-roadcraft-1.md` — **MOVER** → docs/history/. Histórico de outra versão (221 KB).
- `docs/historico-PROBLEMAS-roadcraft-2.md` — **MOVER** → docs/history/. Histórico de outra versão.
- `docs/LICOES.md` — **RENOMEAR** → docs/LESSONS.md (em inglês). Lições das versões anteriores: vale como regra; nome e texto em português.
- `docs/OPTIMIZATION.md` — **MANTER**. Orçamento e linha de base de otimização (texto em português).
- `docs/ORGANIZACAO.md` — **JUNTAR** → docs/ARCHITECTURE.md. Regra de organização e camadas; sobrepõe ARQUITETURA/ESTRUTURA.
- `docs/PARIDADE-roadcraft-3.md` — **MOVER** → docs/history/PARITY-roadcraft-3.md. Paridade com o 3.0; o objetivo hoje é o 4.0 (CLAUDE.md Goal).
- `docs/PESQUISA-CIDADE-GRANDE.md` — **MOVER** → docs/research/LARGE-CITY-2026-10-14.md. Pesquisa datada.
- `docs/PESQUISA-PREDIOS.md` — **MOVER** → docs/research/BUILDINGS-2026-10-18.md. Pesquisa datada.
- `docs/PESQUISA-WEB-2026-10-18.md` — **MOVER** → docs/research/WEB-2026-10-18.md. Pesquisa datada.
- `docs/RECURSOS.md` — **RENOMEAR** → docs/FEATURES.md. Lista de recursos do 4.0 e estado aqui.

**docs/referencia-visual/**

- `docs/referencia-visual/motor-rua-dia.png` — **RENOMEAR** → docs/reference/motor-rua-dia.png. Foto de referência visual (citada por docs/PESQUISA-PREDIOS.md).
- `docs/referencia-visual/motor-rua-noite.png` — **RENOMEAR** → docs/reference/motor-rua-noite.png. Foto de referência visual (citada por docs/PESQUISA-PREDIOS.md).
- `docs/referencia-visual/roadcraft-bairro.png` — **RENOMEAR** → docs/reference/roadcraft-bairro.png. Foto de referência visual (citada por docs/PESQUISA-PREDIOS.md).
- `docs/referencia-visual/roadcraft-rua-dia.png` — **RENOMEAR** → docs/reference/roadcraft-rua-dia.png. Foto de referência visual (citada por docs/PESQUISA-PREDIOS.md).
- `docs/referencia-visual/roadcraft-rua-noite.png` — **RENOMEAR** → docs/reference/roadcraft-rua-noite.png. Foto de referência visual (citada por docs/PESQUISA-PREDIOS.md).
- `docs/referencia-visual/roadcraft-rua-transversal.png` — **RENOMEAR** → docs/reference/roadcraft-rua-transversal.png. Foto de referência visual (citada por docs/PESQUISA-PREDIOS.md).

**docs/**

- `docs/STATE-OWNERSHIP.md` — **JUNTAR** → docs/ARCHITECTURE.md (seção dono do estado). Matriz de dono do estado; o código já diverge dela (estado dos lotes no Game, ShellState).
- `docs/VERIFY-PORT.md` — **MOVER** → docs/reports/VERIFY-PORT-2026-10-29.md. Relatório datado de verificação de commits.
- `docs/VISUAL-QA.md` — **MANTER**. Critérios de QA visual (texto em português).

**electron/**

- `electron/icon.ico` — **MANTER**. Ícone do app (gerado por tools/make-icon.mjs).
- `electron/icon.png` — **MANTER**. Ícone do app (gerado por tools/make-icon.mjs).

**(raiz)/**

- `package-lock.json` — **MANTER**. Gerado pelo npm (saída gerada): listado, não lido.

**postes/**

- `postes/00-mapa-vazio.jpg` — **MOVER** → docs/studies/poles/00-mapa-vazio.jpg. Foto do estudo dos postes do 4.0 solta na raiz.
- `postes/01-novo-mapa.jpg` — **MOVER** → docs/studies/poles/01-novo-mapa.jpg. Foto do estudo dos postes do 4.0 solta na raiz.
- `postes/02-gaveta-vias.jpg` — **MOVER** → docs/studies/poles/02-gaveta-vias.jpg. Foto do estudo dos postes do 4.0 solta na raiz.
- `postes/03-rua-desenhada.jpg` — **MOVER** → docs/studies/poles/03-rua-desenhada.jpg. Foto do estudo dos postes do 4.0 solta na raiz.
- `postes/04-rua-perto.jpg` — **MOVER** → docs/studies/poles/04-rua-perto.jpg. Foto do estudo dos postes do 4.0 solta na raiz.
- `postes/05-linha-urbana.jpg` — **MOVER** → docs/studies/poles/05-linha-urbana.jpg. Foto do estudo dos postes do 4.0 solta na raiz.
- `postes/06-topo-transformador.jpg` — **MOVER** → docs/studies/poles/06-topo-transformador.jpg. Foto do estudo dos postes do 4.0 solta na raiz.
- `postes/07-poste-lampada.jpg` — **MOVER** → docs/studies/poles/07-poste-lampada.jpg. Foto do estudo dos postes do 4.0 solta na raiz.
- `postes/08-poste-cruzeta-costas.jpg` — **MOVER** → docs/studies/poles/08-poste-cruzeta-costas.jpg. Foto do estudo dos postes do 4.0 solta na raiz.
- `postes/09-rural.jpg` — **MOVER** → docs/studies/poles/09-rural.jpg. Foto do estudo dos postes do 4.0 solta na raiz.
- `postes/10-de-cima.jpg` — **MOVER** → docs/studies/poles/10-de-cima.jpg. Foto do estudo dos postes do 4.0 solta na raiz.
- `postes/11-noite.jpg` — **MOVER** → docs/studies/poles/11-noite.jpg. Foto do estudo dos postes do 4.0 solta na raiz.
- `postes/ESTUDO.md` — **MOVER** → docs/studies/poles/STUDY.md. Estudo do 4.0 (postes) solto na raiz.

**(raiz)/**

- `PROMPT-ANALISE.md` — **MOVER** → lab/MEMORY/prompts/analise.md. Prompt de sessão na raiz do repositório do jogo; aponta para a pasta antiga roadcraft-novo.
- `PROMPT-CONTINUAR.md` — **MOVER** → lab/MEMORY/prompts/continuar.md. Prompt de sessão na raiz do repositório; aponta para a pasta antiga roadcraft-novo.

**public/cooked/people/**

- `public/cooked/people/people.bin` — **MANTER**. Asset cozido versionado (saída de tools/cook-people.mjs ou do cozimento de superfícies), carregado pelo jogo.
- `public/cooked/people/people.json` — **MANTER**. Asset cozido versionado (saída de tools/cook-people.mjs ou do cozimento de superfícies), carregado pelo jogo.

**public/cooked/surfaces/**

- `public/cooked/surfaces/asphalt.detail-normal.ktx2` — **MANTER**. Asset cozido versionado (saída de tools/cook-people.mjs ou do cozimento de superfícies), carregado pelo jogo.
- `public/cooked/surfaces/asphalt.detail.ktx2` — **MANTER**. Asset cozido versionado (saída de tools/cook-people.mjs ou do cozimento de superfícies), carregado pelo jogo.
- `public/cooked/surfaces/asphalt.map.ktx2` — **MANTER**. Asset cozido versionado (saída de tools/cook-people.mjs ou do cozimento de superfícies), carregado pelo jogo.
- `public/cooked/surfaces/asphalt.normal.ktx2` — **MANTER**. Asset cozido versionado (saída de tools/cook-people.mjs ou do cozimento de superfícies), carregado pelo jogo.
- `public/cooked/surfaces/asphalt.rough.ktx2` — **MANTER**. Asset cozido versionado (saída de tools/cook-people.mjs ou do cozimento de superfícies), carregado pelo jogo.
- `public/cooked/surfaces/building-finishes.map.ktx2` — **MANTER**. Asset cozido versionado (saída de tools/cook-people.mjs ou do cozimento de superfícies), carregado pelo jogo.
- `public/cooked/surfaces/building-finishes.normal.ktx2` — **MANTER**. Asset cozido versionado (saída de tools/cook-people.mjs ou do cozimento de superfícies), carregado pelo jogo.
- `public/cooked/surfaces/building-finishes.rough.ktx2` — **MANTER**. Asset cozido versionado (saída de tools/cook-people.mjs ou do cozimento de superfícies), carregado pelo jogo.
- `public/cooked/surfaces/concrete.detail-normal.ktx2` — **MANTER**. Asset cozido versionado (saída de tools/cook-people.mjs ou do cozimento de superfícies), carregado pelo jogo.
- `public/cooked/surfaces/concrete.detail.ktx2` — **MANTER**. Asset cozido versionado (saída de tools/cook-people.mjs ou do cozimento de superfícies), carregado pelo jogo.
- `public/cooked/surfaces/footway.map.ktx2` — **MANTER**. Asset cozido versionado (saída de tools/cook-people.mjs ou do cozimento de superfícies), carregado pelo jogo.
- `public/cooked/surfaces/footway.normal.ktx2` — **MANTER**. Asset cozido versionado (saída de tools/cook-people.mjs ou do cozimento de superfícies), carregado pelo jogo.
- `public/cooked/surfaces/footway.rough.ktx2` — **MANTER**. Asset cozido versionado (saída de tools/cook-people.mjs ou do cozimento de superfícies), carregado pelo jogo.
- `public/cooked/surfaces/kerb.map.ktx2` — **MANTER**. Asset cozido versionado (saída de tools/cook-people.mjs ou do cozimento de superfícies), carregado pelo jogo.
- `public/cooked/surfaces/kerb.normal.ktx2` — **MANTER**. Asset cozido versionado (saída de tools/cook-people.mjs ou do cozimento de superfícies), carregado pelo jogo.
- `public/cooked/surfaces/kerb.rough.ktx2` — **MANTER**. Asset cozido versionado (saída de tools/cook-people.mjs ou do cozimento de superfícies), carregado pelo jogo.
- `public/cooked/surfaces/terrain-grass.map.ktx2` — **MANTER**. Asset cozido versionado (saída de tools/cook-people.mjs ou do cozimento de superfícies), carregado pelo jogo.
- `public/cooked/surfaces/terrain-grass.normal.ktx2` — **MANTER**. Asset cozido versionado (saída de tools/cook-people.mjs ou do cozimento de superfícies), carregado pelo jogo.
- `public/cooked/surfaces/terrain-land.map.ktx2` — **MANTER**. Asset cozido versionado (saída de tools/cook-people.mjs ou do cozimento de superfícies), carregado pelo jogo.
- `public/cooked/surfaces/terrain-land.normal.ktx2` — **MANTER**. Asset cozido versionado (saída de tools/cook-people.mjs ou do cozimento de superfícies), carregado pelo jogo.
- `public/cooked/surfaces/verge.map.ktx2` — **MANTER**. Asset cozido versionado (saída de tools/cook-people.mjs ou do cozimento de superfícies), carregado pelo jogo.
- `public/cooked/surfaces/verge.normal.ktx2` — **MANTER**. Asset cozido versionado (saída de tools/cook-people.mjs ou do cozimento de superfícies), carregado pelo jogo.

**public/models/citizens/**

- `public/models/citizens/LICENSE-ANIMATIONS.txt` — **MANTER**. Licença de um asset distribuído.
- `public/models/citizens/LICENSE-MICROSOFT.txt` — **MANTER**. Licença de um asset distribuído.
- `public/models/citizens/rocketboxFemale.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/citizens/rocketboxMale.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/citizens/walkFemale.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/citizens/walkMale.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).

**public/models/people/**

- `public/models/people/base.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/base.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/LICENSE-MakeHuman-CC0.txt` — **MANTER**. Licença de um asset distribuído.
- `public/models/people/LICENSES.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/modifiers.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).

**public/models/people/proxies/**

- `public/models/people/proxies/afro01.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/afro01.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/afro01.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/bob01.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/bob01.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/bob01.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/bob02.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/bob02.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/bob02.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/braid01.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/braid01.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/braid01.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/fedora01.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/fedora01.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/fedora01.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/female_casualsuit01.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/female_casualsuit01.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/female_casualsuit01.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/female_casualsuit02.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/female_casualsuit02.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/female_casualsuit02.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/female_elegantsuit01.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/female_elegantsuit01.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/female_elegantsuit01.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/female_sportsuit01.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/female_sportsuit01.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/female_sportsuit01.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/index.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/long01.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/long01.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/long01.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/male_casualsuit01.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/male_casualsuit01.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/male_casualsuit01.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/male_casualsuit02.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/male_casualsuit02.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/male_casualsuit02.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/male_casualsuit03.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/male_casualsuit03.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/male_casualsuit03.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/male_casualsuit04.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/male_casualsuit04.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/male_casualsuit04.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/male_casualsuit05.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/male_casualsuit05.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/male_casualsuit05.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/male_casualsuit06.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/male_casualsuit06.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/male_casualsuit06.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/male_elegantsuit01.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/male_elegantsuit01.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/male_elegantsuit01.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/male_worksuit01.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/male_worksuit01.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/male_worksuit01.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/ponytail01.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/ponytail01.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/ponytail01.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/shoes01.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/shoes01.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/shoes01.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/shoes02.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/shoes02.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/shoes02.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/shoes03.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/shoes03.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/shoes03.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/shoes04.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/shoes04.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/shoes04.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/shoes05.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/shoes05.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/shoes05.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/shoes06.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/shoes06.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/shoes06.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/short01.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/short01.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/short01.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/short02.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/short02.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/short02.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/short03.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/short03.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/short03.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/short04.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/short04.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/proxies/short04.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).

**public/models/people/**

- `public/models/people/skeleton-game-engine.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).

**public/models/people/skins/**

- `public/models/people/skins/index.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/skins/middleage_african_female.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/skins/middleage_african_male.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/skins/middleage_asian_female.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/skins/middleage_asian_male.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/skins/middleage_caucasian_female.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/skins/middleage_caucasian_male.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/skins/old_african_female.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/skins/old_african_male.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/skins/old_asian_female.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/skins/old_asian_male.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/skins/old_caucasian_female.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/skins/old_caucasian_male.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/skins/young_african_female.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/skins/young_african_male.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/skins/young_asian_female.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/skins/young_asian_male.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/skins/young_caucasian_female.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/skins/young_caucasian_male.webp` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).

**public/models/people/**

- `public/models/people/targets-local.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/targets-local.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/targets-macro-pca.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/targets-macro-pca.json` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).
- `public/models/people/weights-game-engine.bin` — **MANTER**. Modelo/dado de pessoas distribuído com o jogo (entrada de tools/cook-people.mjs).

**src/world/**

- `src/world/catalogData.json` — **MANTER**. Gerado por data/lots-roadcraft/pack.mjs e importado por world/catalog.ts (saída gerada versionada).

**tunel/**

- `tunel/ANALISE.md` — **MOVER** → docs/studies/tunnels/ANALYSIS.md. Estudo de túneis solto na raiz.

## 4. Mapa por recurso (passo 3)

Lista (b) de todo arquivo de `src` cuja leitura registrou lógica ou estado do recurso (etiquetas dos leitores mais
`src/game.ts`, que toca todos). A pasta de destino é a decisão do coordenador: o recurso fica numa pasta
`src/features/<recurso>/` com a ferramenta, as ações do HUD, os painéis e o estado da ferramenta; os motores genéricos
continuam nas camadas (`world`, `roads`, `jobs`, `sim`, `render`), cada um com um arquivo por recurso quando o recurso
tem malha ou simulação própria. Regra do CLAUDE.md: "Each feature lives concentrated in the folder of its category".

| Recurso | Arquivos hoje (quantidade) | Pasta única de destino | O que está espalhado e precisa ir para lá |
|---|---:|---|---|
| Vias | 70 | `src/features/roads/` (ferramenta, inspetor, catálogo, nomes de rua, teclas) + `src/roads/` (domínio) + `jobs/roadMesh/` + `render/roads.ts` | `ui/inspector.ts`, `ui/roadCatalog.ts`, `ui/roadKeysPanel.ts`, `roads/streetNames.ts`, as ações de via de `game.ts:415–452` e `api.road` (`game.ts:1309–1319`). |
| Zonas | 13 | `src/features/zones/` | `roads/zones.ts` (35 importadores), gaveta de zonas em `ui/drawers.ts`, `zoneTool` + ações `game.ts:424–432`, segundo tipo `Zone` em `r40/world/zones.ts`. |
| Lotes e prédios | 128 | `src/features/buildings/` (edição, criador, seleção) + `src/world/buildings/` e `src/world/lots/` (domínio) + `src/jobs/buildingGen/` (um gerador) + `src/render/buildings/` | Estado dos lotes em `game.ts:195–206, 1602–1603`; `app/lotEditing.ts`, `app/buildings.ts`, `ui/creator.ts`; os dois geradores (`jobs/buildingGen*` e `r40/**`); dois `lotPlan`, dois `roofPlant`. |
| Pincel de terreno | 33 | `src/features/terrain/` | Estado do pincel em `game.ts:169–181`; a combinação relevo+rocha em três lugares (`game.ts:773–779`, `game.ts:1348–1355`, `app/input.ts:183–186`); `world/brush.ts`. |
| Água | 19 | `src/features/water/` | `features/terrain/riverTool.ts`, `RiverCommand` em `world/ground.ts:228–247`, material do mar em `render/scene.ts`, água em `render/terrain.ts`, globais `waveU/foamU/currentU`. |
| Céu e clima | 35 | `src/features/sky/` | Simulação do clima dentro de `render/weather.ts:260–310`; céu e hora em `render/scene.ts`; loja de nuvens em `render/cloudShadow.ts:11–22` escrita por `render/cloudPuffs.ts`; hora e `skyMode` em `game.ts:215–218, 735–744`. |
| Transporte | 30 | `src/features/transit/` | `world/transit.ts`, `render/transit.ts`, `ui/transitNames.ts`, paradas em `roads/kerb.ts:13–30`, ações `game.ts:407–414`. |
| Mobiliário urbano e postes | 38 | `src/features/streetscape/` | `render/textSigns.ts`, texto de placa em `game.ts:567–575`, `removePole` em `game.ts:1090–1096`, ações `game.ts:352–360`, `roads/signRule.ts`. |
| Demolição e bomba | 30 | `src/features/demolition/` | Modo demolir dentro de `features/roads/roadTool.ts:133–146, 194–205`; tiro e bomba em `game.ts:1440–1456`; `bombForce` em `game.ts:233`. |
| Pessoas | 32 | `src/features/people/` (criador e painel) + `src/sim/people/` + `src/render/people/` | Criador (estado do jogador) em `render/people/creator.ts`; painel em `ui/peoplePanel.ts`; `placePerson`/`personSpec` em `game.ts:232, 1415–1438`. |
| Veículos | 36 | `src/sim/traffic/` + `src/render/vehicles/` | `render/vehicles.ts` + `carBody.ts` + `heavyBody.ts` (modelos e frota juntos; ajudantes duplicados). |
| Interiores | 19 | `src/features/interiors/` | `render/inside.ts` (planejamento em arquivo de render), `r40/world/buildings/interior.ts`, `spaces.ts`, `r40/render/buildings/interiorMesh.ts`, `roomBehind.ts`; `insideId/insideFloor` em `game.ts:235–236`. |
| Gravar e abrir | 41 | `src/features/save/` (fluxos) + `src/platform/` (armazenamento e formatos) | `game.ts:1787–2087` (save, load, openGeneration, export/import, cidades anteriores), `app/session.ts`, `SaveActions` em `platform/mapFile.ts:222–227`. |
| Câmera | 14 | `src/render/cameraRig.ts` + `src/app/cameraActions.ts` | Ações de câmera em `game.ts:441–443, 465, 1485–1488, 1570–1576`; `CAMERA_CODES` mantido à mão em `ui/keys.ts:76`. |
| HUD | 53 | `src/ui/` (esqueleto) + cada recurso fornece suas ações e painéis | `ui/hudActions.ts` (85 métodos de todos os recursos), `ui/drawers.ts` (seis gavetas + `ShellState`, cópia de cada escolha), `ui/hud.ts`. |
| Núcleo de simulação | 56 | `src/sim/` | Ligação com o worker em `game.ts:289–321, 843–1016`. |
| Núcleo de render | 103 | `src/render/` | Criação das camadas e aquecimento em `game.ts:276–287, 580–636`; detalhe adaptativo `game.ts:1186–1227`. |
| Geração | 80 | `src/jobs/` | `generatedCity`/`testCity` e o empacotamento por ladrilho em `game.ts:1665–1785`; cidade de teste `jobs/debugCity.ts` no worker de produção. |
| Tradução | 22 | `src/shared/i18n/` (um sistema) | `data/textos-roadcraft/` e `shared/i18n/lang/legacy.ts`; textos fixos listados no problema 7. |

Arquivos de cada recurso (b):

- **roads** (70): `src/app/clicks.ts`, `src/app/featureActions.ts`, `src/app/input.ts`, `src/app/lotEditing.ts`, `src/app/tools.ts`, `src/features/demolition/demolish.ts`, `src/features/roads/roadTool.ts`, `src/features/streetscape/itemTool.ts`, `src/features/zones/zoneTool.ts`, `src/game.ts`, `src/jobs/cityField.ts`, `src/jobs/cityGen.ts`, `src/jobs/conform.ts`, `src/jobs/debugCity.ts`, `src/jobs/props.ts`, `src/jobs/roadMesh.ts`, `src/jobs/roadPaint.ts`, `src/jobs/terrainSeams.ts`, `src/jobs/worker.ts`, `src/platform/mapExtra.ts`, `src/platform/save.ts`, `src/r40/core/intersect.ts`, `src/r40/core/scalar.ts`, `src/r40/core/vec2.ts`, `src/r40/world/buildings/foundation.ts`, `src/r40/world/cells.ts`, `src/r40/world/tiles.ts`, `src/render/cookedSurfaces.ts`, `src/render/preview.ts`, `src/render/roads.ts`, `src/render/surfaceBake.ts`, `src/render/terrain.ts`, `src/render/terrainSeams.ts`, `src/render/transit.ts`, `src/roads/build.ts`, `src/roads/control.ts`, `src/roads/dash.ts`, `src/roads/economy.ts`, `src/roads/flags.ts`, `src/roads/geometry.ts`, `src/roads/ground.ts`, `src/roads/impossible.ts`, `src/roads/junction.ts`, `src/roads/kerb.ts`, `src/roads/laneLinks.ts`, `src/roads/markings.ts`, `src/roads/network.ts`, `src/roads/networkView.ts`, `src/roads/profileWork.ts`, `src/roads/profiles.ts`, `src/roads/repair.ts`, `src/roads/roadVariant.ts`, `src/roads/signRule.ts`, `src/roads/streetNames.ts`, `src/roads/tuning.ts`, `src/shared/contracts/worker.ts`, `src/sim/advisor.ts`, `src/sim/lanes.ts`, `src/sim/probe.ts`, `src/sim/signals.ts`, `src/sim/traffic.ts`, `src/sim/traffic/junctions.ts`, `src/ui/drawers.ts`, `src/ui/hudActions.ts`, `src/ui/inspector.ts`, `src/ui/roadCatalog.ts`, `src/ui/roadKeysPanel.ts`, `src/world/brush.ts`, `src/world/lotEdit.ts`, `src/world/world.ts`
- **zones** (13): `src/app/clicks.ts`, `src/features/zones/zoneTool.ts`, `src/game.ts`, `src/jobs/blockLots.ts`, `src/jobs/cityGen.ts`, `src/jobs/lots.ts`, `src/r40/world/zones.ts`, `src/render/roads.ts`, `src/roads/zones.ts`, `src/ui/drawers.ts`, `src/ui/hudActions.ts`, `src/world/growth.ts`, `src/world/lotEdit.ts`
- **lots/buildings** (128): `src/app/buildings.ts`, `src/app/clicks.ts`, `src/app/featureActions.ts`, `src/app/input.ts`, `src/app/lotEditing.ts`, `src/features/demolition/bomb.ts`, `src/features/demolition/demolish.ts`, `src/features/demolition/ruin/ruinMesh.ts`, `src/features/demolition/ruin/ruins.ts`, `src/features/zones/zoneTool.ts`, `src/game.ts`, `src/jobs/blockLots.ts`, `src/jobs/boxMesh.ts`, `src/jobs/building40.ts`, `src/jobs/buildingFinishWorker.ts`, `src/jobs/buildingFinishes.ts`, `src/jobs/buildingGen.ts`, `src/jobs/buildingGen/catalog.ts`, `src/jobs/buildingGen/civic.ts`, `src/jobs/buildingGen/context.ts`, `src/jobs/buildingGen/finishes.ts`, `src/jobs/buildingGen/geometry.ts`, `src/jobs/buildingGen/heights.ts`, `src/jobs/buildingGen/lot.ts`, `src/jobs/buildingGen/materials.ts`, `src/jobs/buildingGen/outputs.ts`, `src/jobs/buildingGen/plan.ts`, `src/jobs/buildingGen/plans.ts`, `src/jobs/buildingGen/plans2.ts`, `src/jobs/buildingGen/polygon.ts`, `src/jobs/buildingGen/shell.ts`, `src/jobs/buildingGen/windows.ts`, `src/jobs/debugCity.ts`, `src/jobs/lots.ts`, `src/jobs/parts40.ts`, `src/jobs/props.ts`, `src/jobs/worker.ts`, `src/r40/api.ts`, `src/r40/core/aabb.ts`, `src/r40/core/forkMap.ts`, `src/r40/core/hypot.ts`, `src/r40/core/intersect.ts`, `src/r40/core/minMax.ts`, `src/r40/core/polygon.ts`, `src/r40/render/bake/finishRecipes.ts`, `src/r40/render/buildings/buildingMesh.ts`, `src/r40/render/buildings/cellArrays.ts`, `src/r40/render/buildings/chunk.ts`, `src/r40/render/buildings/elementMesh.ts`, `src/r40/render/buildings/facadeEmit.ts`, `src/r40/render/buildings/facadeKit.ts`, `src/r40/render/buildings/facadeLevel.ts`, `src/r40/render/buildings/facadePropModels.ts`, `src/r40/render/buildings/facadeProps.ts`, `src/r40/render/buildings/fade.ts`, `src/r40/render/buildings/finishes.ts`, `src/r40/render/buildings/flagLayer.ts`, `src/r40/render/buildings/furnitureKit.ts`, `src/r40/render/buildings/glassRoom.ts`, `src/r40/render/buildings/interiorMesh.ts`, `src/r40/render/buildings/kit.ts`, `src/r40/render/buildings/landmarks.ts`, `src/r40/render/buildings/lawnGround.ts`, `src/r40/render/buildings/lightSlots.ts`, `src/r40/render/buildings/lotMesh.ts`, `src/r40/render/buildings/massBoxes.ts`, `src/r40/render/buildings/massing.ts`, `src/r40/render/buildings/massingMaterial.ts`, `src/r40/render/buildings/meshCore.ts`, `src/r40/render/buildings/partFiling.ts`, `src/r40/render/buildings/partPose.ts`, `src/r40/render/buildings/partyWalls.ts`, `src/r40/render/buildings/roofMesh.ts`, `src/r40/render/buildings/roofPlan.ts`, `src/r40/render/buildings/roomBehind.ts`, `src/r40/render/buildings/shellParts.ts`, `src/r40/render/buildings/signature.ts`, `src/r40/render/buildings/thinParts.ts`, `src/r40/render/lightLevels.ts`, `src/r40/world/buildings/architecture.ts`, `src/r40/world/buildings/blocks.ts`, `src/r40/world/buildings/blueprints.ts`, `src/r40/world/buildings/cityBuildings.ts`, `src/r40/world/buildings/elements.ts`, `src/r40/world/buildings/flags.ts`, `src/r40/world/buildings/footprints.ts`, `src/r40/world/buildings/foundation.ts`, `src/r40/world/buildings/geometry.ts`, `src/r40/world/buildings/interior.ts`, `src/r40/world/buildings/intern.ts`, `src/r40/world/buildings/lots.ts`, `src/r40/world/buildings/materialTypes.ts`, `src/r40/world/buildings/materials.ts`, `src/r40/world/buildings/pads.ts`, `src/r40/world/buildings/procedural.ts`, `src/r40/world/buildings/recordTable.ts`, `src/r40/world/buildings/roofPlant.ts`, `src/r40/world/buildings/spaces.ts`, `src/r40/world/buildings/towerKit.ts`, `src/r40/world/buildings/types.ts`, `src/r40/world/cells.ts`, `src/r40/world/growth/lotBoundaryRuns.ts`, `src/r40/world/growth/lotPlan.ts`, `src/r40/world/lotRings.ts`, `src/render/city.ts`, `src/render/inside.ts`, `src/render/particles.ts`, `src/render/propMeshes.ts`, `src/render/props.ts`, `src/roads/build.ts`, `src/shared/contracts/worker.ts`, `src/ui/creator.ts`, `src/ui/drawers.ts`, `src/ui/hud.ts`, `src/ui/hudActions.ts`, `src/world/arch.ts`, `src/world/archData.ts`, `src/world/brush.ts`, `src/world/catalog.ts`, `src/world/catalogFacade.ts`, `src/world/catalogFormat.ts`, `src/world/decay.ts`, `src/world/design.ts`, `src/world/growth.ts`, `src/world/lotEdit.ts`, `src/world/lotPlan.ts`, `src/world/roofPlant.ts`, `src/world/world.ts`
- **terrain-brush** (33): `src/app/input.ts`, `src/app/tools.ts`, `src/features/terrain/riverTool.ts`, `src/game.ts`, `src/jobs/conform.ts`, `src/jobs/debugCity.ts`, `src/jobs/props.ts`, `src/jobs/roadPaint.ts`, `src/jobs/terrainGen.ts`, `src/jobs/terrainSeams.ts`, `src/jobs/worker.ts`, `src/r40/render/buildings/lawnGround.ts`, `src/r40/render/buildings/lotMesh.ts`, `src/r40/render/terrainGrid.ts`, `src/r40/world/bounds.ts`, `src/r40/world/buildings/foundation.ts`, `src/r40/world/buildings/lots.ts`, `src/r40/world/buildings/pads.ts`, `src/render/cookedSurfaces.ts`, `src/render/ecology.ts`, `src/render/ecologyWorker.ts`, `src/render/surfaceBake.ts`, `src/render/terrain.ts`, `src/render/terrainSeams.ts`, `src/roads/build.ts`, `src/roads/kerb.ts`, `src/ui/drawers.ts`, `src/ui/hudActions.ts`, `src/world/brush.ts`, `src/world/ground.ts`, `src/world/heights.ts`, `src/world/items.ts`, `src/world/world.ts`
- **water** (19): `src/features/terrain/riverTool.ts`, `src/features/water/waterControl.ts`, `src/game.ts`, `src/jobs/terrainGen.ts`, `src/platform/mapExtra.ts`, `src/r40/render/buildings/lotMesh.ts`, `src/r40/render/buildings/roofMesh.ts`, `src/r40/world/buildings/pads.ts`, `src/render/ecology.ts`, `src/render/ecologyWorker.ts`, `src/render/scene.ts`, `src/render/surfaceBake.ts`, `src/render/terrain.ts`, `src/ui/drawers.ts`, `src/ui/hudActions.ts`, `src/world/brush.ts`, `src/world/ground.ts`, `src/world/lotEdit.ts`, `src/world/world.ts`
- **sky/weather** (35): `src/app/clicks.ts`, `src/app/input.ts`, `src/app/tools.ts`, `src/features/sky/clouds.ts`, `src/features/sky/weatherControl.ts`, `src/game.ts`, `src/platform/audio.ts`, `src/platform/mapExtra.ts`, `src/platform/save.ts`, `src/r40/render/buildings/facadeLevel.ts`, `src/r40/render/buildings/finishes.ts`, `src/r40/render/buildings/flagLayer.ts`, `src/r40/render/buildings/kit.ts`, `src/r40/render/buildings/lightSlots.ts`, `src/r40/render/buildings/massingMaterial.ts`, `src/r40/render/buildings/roomBehind.ts`, `src/r40/render/buildings/roomLamps.ts`, `src/r40/render/lightLevels.ts`, `src/r40/render/wind.ts`, `src/render/city.ts`, `src/render/cloudPuffs.ts`, `src/render/cloudShadow.ts`, `src/render/particles.ts`, `src/render/post.ts`, `src/render/props.ts`, `src/render/roads.ts`, `src/render/scene.ts`, `src/render/sun.ts`, `src/render/terrain.ts`, `src/render/weather.ts`, `src/ui/drawers.ts`, `src/ui/hud.ts`, `src/ui/hudActions.ts`, `src/ui/options.ts`, `src/world/items.ts`
- **transit** (30): `src/app/clicks.ts`, `src/app/featureActions.ts`, `src/app/tools.ts`, `src/features/transit/transitTool.ts`, `src/game.ts`, `src/platform/mapExtra.ts`, `src/platform/save.ts`, `src/render/heavyBody.ts`, `src/render/props.ts`, `src/render/roads.ts`, `src/render/transit.ts`, `src/render/vehicles.ts`, `src/roads/kerb.ts`, `src/sim/peds.ts`, `src/sim/routing.ts`, `src/sim/signals.ts`, `src/sim/traffic.ts`, `src/sim/traffic/buses.ts`, `src/sim/traffic/junctions.ts`, `src/sim/traffic/lines.ts`, `src/sim/traffic/meso.ts`, `src/sim/traffic/micro.ts`, `src/sim/traffic/state.ts`, `src/sim/traffic/stops.ts`, `src/sim/worker.ts`, `src/ui/drawers.ts`, `src/ui/hud.ts`, `src/ui/hudActions.ts`, `src/ui/transitNames.ts`, `src/world/transit.ts`
- **streetscape/poles** (38): `src/app/clicks.ts`, `src/app/input.ts`, `src/features/demolition/blast/thrown.ts`, `src/features/demolition/bomb.ts`, `src/features/demolition/demolish.ts`, `src/features/streetscape/itemTool.ts`, `src/game.ts`, `src/jobs/buildingGen/catalog.ts`, `src/jobs/buildingGen/plans.ts`, `src/jobs/props.ts`, `src/r40/render/buildings/buildingMesh.ts`, `src/r40/render/buildings/elementMesh.ts`, `src/r40/render/buildings/facadeKit.ts`, `src/r40/render/buildings/facadePropModels.ts`, `src/r40/render/buildings/kit.ts`, `src/r40/render/buildings/signature.ts`, `src/r40/render/buildings/thinParts.ts`, `src/r40/render/wind.ts`, `src/r40/world/buildings/elements.ts`, `src/r40/world/buildings/lots.ts`, `src/r40/world/growth/lotBoundaryRuns.ts`, `src/r40/world/growth/lotPlan.ts`, `src/render/impostor.ts`, `src/render/particles.ts`, `src/render/propBlocks.ts`, `src/render/propMeshes.ts`, `src/render/props.ts`, `src/render/textSigns.ts`, `src/render/treeMeshes.ts`, `src/roads/build.ts`, `src/roads/flags.ts`, `src/roads/ground.ts`, `src/roads/signRule.ts`, `src/shared/contracts/worker.ts`, `src/sim/traffic.ts`, `src/ui/drawers.ts`, `src/ui/hudActions.ts`, `src/world/items.ts`
- **demolition/bomb** (30): `src/app/clicks.ts`, `src/app/input.ts`, `src/features/demolition/blast/blast.ts`, `src/features/demolition/blast/debris.ts`, `src/features/demolition/blast/marks.ts`, `src/features/demolition/blast/thrown.ts`, `src/features/demolition/bomb.ts`, `src/features/demolition/demolish.ts`, `src/features/demolition/demolition.ts`, `src/features/demolition/ruin/fracture.ts`, `src/features/demolition/ruin/ruinMesh.ts`, `src/features/demolition/ruin/ruins.ts`, `src/features/demolition/ruin/worker.ts`, `src/features/roads/roadTool.ts`, `src/game.ts`, `src/jobs/building40.ts`, `src/jobs/buildingGen.ts`, `src/jobs/buildingGen/heights.ts`, `src/platform/audio.ts`, `src/r40/render/buildings/interiorMesh.ts`, `src/render/inside.ts`, `src/render/particles.ts`, `src/roads/ground.ts`, `src/shared/contracts/bomb.ts`, `src/sim/peds.ts`, `src/sim/traffic.ts`, `src/sim/worker.ts`, `src/ui/drawers.ts`, `src/ui/hudActions.ts`, `src/world/world.ts`
- **people** (32): `src/app/clicks.ts`, `src/game.ts`, `src/jobs/props.ts`, `src/r40/render/buildings/facadeProps.ts`, `src/r40/render/wind.ts`, `src/r40/world/buildings/spaces.ts`, `src/render/people/creator.ts`, `src/render/people/crowd.ts`, `src/render/people/format.ts`, `src/render/people/looks.ts`, `src/render/people/occupants.ts`, `src/render/propMeshes.ts`, `src/render/vehicles.ts`, `src/shared/contracts/people.ts`, `src/shared/contracts/poses.ts`, `src/sim/lanes.ts`, `src/sim/peds.ts`, `src/sim/probe.ts`, `src/sim/routing.ts`, `src/sim/signals.ts`, `src/sim/traffic.ts`, `src/sim/traffic/buses.ts`, `src/sim/traffic/junctions.ts`, `src/sim/traffic/lines.ts`, `src/sim/traffic/micro.ts`, `src/sim/traffic/state.ts`, `src/sim/traffic/stops.ts`, `src/sim/worker.ts`, `src/ui/drawers.ts`, `src/ui/hudActions.ts`, `src/ui/peoplePanel.ts`, `src/world/items.ts`
- **vehicles** (36): `src/features/demolition/blast/thrown.ts`, `src/features/demolition/bomb.ts`, `src/game.ts`, `src/jobs/props.ts`, `src/platform/audio.ts`, `src/r40/render/lightLevels.ts`, `src/r40/render/mesh/weld.ts`, `src/render/carBody.ts`, `src/render/heavyBody.ts`, `src/render/people/crowd.ts`, `src/render/people/looks.ts`, `src/render/people/occupants.ts`, `src/render/propMeshes.ts`, `src/render/props.ts`, `src/render/roads.ts`, `src/render/vehicles.ts`, `src/shared/contracts/poses.ts`, `src/shared/vehiclePaints.ts`, `src/sim/advisor.ts`, `src/sim/drivers.ts`, `src/sim/lanes.ts`, `src/sim/manoeuvres.ts`, `src/sim/peds.ts`, `src/sim/reedsShepp.ts`, `src/sim/routing.ts`, `src/sim/signals.ts`, `src/sim/traffic.ts`, `src/sim/traffic/buses.ts`, `src/sim/traffic/junctions.ts`, `src/sim/traffic/laneChanges.ts`, `src/sim/traffic/measure.ts`, `src/sim/traffic/meso.ts`, `src/sim/traffic/micro.ts`, `src/sim/traffic/regions.ts`, `src/sim/traffic/state.ts`, `src/sim/worker.ts`
- **interiors** (19): `src/app/lotEditing.ts`, `src/app/tools.ts`, `src/game.ts`, `src/jobs/building40.ts`, `src/jobs/buildingGen.ts`, `src/jobs/buildingGen/outputs.ts`, `src/r40/api.ts`, `src/r40/render/buildings/buildingMesh.ts`, `src/r40/render/buildings/cellArrays.ts`, `src/r40/render/buildings/furnitureKit.ts`, `src/r40/render/buildings/glassRoom.ts`, `src/r40/render/buildings/interiorMesh.ts`, `src/r40/render/buildings/kit.ts`, `src/r40/render/buildings/roomBehind.ts`, `src/r40/render/buildings/roomLamps.ts`, `src/r40/world/buildings/interior.ts`, `src/r40/world/buildings/spaces.ts`, `src/render/city.ts`, `src/render/inside.ts`
- **save/load** (41): `src/app/session.ts`, `src/config.ts`, `src/core/commands.ts`, `src/features/sky/clouds.ts`, `src/features/sky/weatherControl.ts`, `src/features/water/waterControl.ts`, `src/game.ts`, `src/jobs/storage.ts`, `src/jobs/worker.ts`, `src/platform/mapExtra.ts`, `src/platform/mapFile.ts`, `src/platform/save.ts`, `src/platform/saveFiles.ts`, `src/r40/render/surfaceTextures.ts`, `src/r40/world/bounds.ts`, `src/r40/world/buildings/blueprints.ts`, `src/r40/world/buildings/flags.ts`, `src/r40/world/buildings/intern.ts`, `src/r40/world/buildings/materials.ts`, `src/r40/world/buildings/recordTable.ts`, `src/r40/world/buildings/types.ts`, `src/r40/world/tiles.ts`, `src/render/people/creator.ts`, `src/roads/build.ts`, `src/roads/network.ts`, `src/roads/profiles.ts`, `src/roads/repair.ts`, `src/shared/contracts/worker.ts`, `src/sim/lanes.ts`, `src/ui/creator.ts`, `src/ui/hud.ts`, `src/ui/hudActions.ts`, `src/ui/menu.ts`, `src/ui/options.ts`, `src/ui/roadCatalog.ts`, `src/world/catalogFormat.ts`, `src/world/design.ts`, `src/world/ground.ts`, `src/world/items.ts`, `src/world/transit.ts`, `src/world/world.ts`
- **camera** (14): `src/app/input.ts`, `src/app/photoHooks.ts`, `src/game.ts`, `src/jobs/buildingGen/heights.ts`, `src/platform/save.ts`, `src/render/cameraRig.ts`, `src/render/post.ts`, `src/render/vehicles.ts`, `src/ui/compass.ts`, `src/ui/hud.ts`, `src/ui/hudActions.ts`, `src/ui/keys.ts`, `src/ui/readouts.ts`, `src/ui/touch.ts`
- **hud** (53): `src/app/buildings.ts`, `src/app/clicks.ts`, `src/app/featureActions.ts`, `src/app/input.ts`, `src/app/lotEditing.ts`, `src/app/tools.ts`, `src/features/roads/roadTool.ts`, `src/features/streetscape/itemTool.ts`, `src/features/transit/transitTool.ts`, `src/game.ts`, `src/main.ts`, `src/platform/audio.ts`, `src/platform/mapExtra.ts`, `src/platform/mapFile.ts`, `src/platform/steam.ts`, `src/r40/render/buildings/fade.ts`, `src/r40/world/buildings/materials.ts`, `src/render/people/creator.ts`, `src/render/preview.ts`, `src/render/textSigns.ts`, `src/roads/control.ts`, `src/roads/economy.ts`, `src/roads/impossible.ts`, `src/roads/profileWork.ts`, `src/roads/roadVariant.ts`, `src/roads/streetNames.ts`, `src/shared/contracts/people.ts`, `src/shared/errors.ts`, `src/shared/i18n/index.ts`, `src/shared/vehiclePaints.ts`, `src/sim/traffic.ts`, `src/sim/traffic/measure.ts`, `src/ui/about.ts`, `src/ui/boot.ts`, `src/ui/compass.ts`, `src/ui/creator.ts`, `src/ui/dom.ts`, `src/ui/drawers.ts`, `src/ui/health.ts`, `src/ui/hud.ts`, `src/ui/hudActions.ts`, `src/ui/icons.ts`, `src/ui/inspector.ts`, `src/ui/keys.ts`, `src/ui/menu.ts`, `src/ui/options.ts`, `src/ui/panelParts.ts`, `src/ui/peoplePanel.ts`, `src/ui/readouts.ts`, `src/ui/roadCatalog.ts`, `src/ui/roadKeysPanel.ts`, `src/ui/touch.ts`, `src/ui/transitNames.ts`
- **sim-core** (56): `src/config.ts`, `src/core/commands.ts`, `src/core/grid.ts`, `src/core/table.ts`, `src/features/transit/transitTool.ts`, `src/game.ts`, `src/jobs/pool.ts`, `src/jobs/worker.ts`, `src/r40/core/forkMap.ts`, `src/r40/core/identityMemo.ts`, `src/r40/core/rng.ts`, `src/r40/core/scalar.ts`, `src/r40/core/units.ts`, `src/r40/core/vec2.ts`, `src/r40/world/bounds.ts`, `src/r40/world/buildings/intern.ts`, `src/r40/world/buildings/recordTable.ts`, `src/r40/world/buildings/types.ts`, `src/r40/world/cells.ts`, `src/r40/world/units.ts`, `src/render/weather.ts`, `src/roads/build.ts`, `src/roads/control.ts`, `src/roads/geometry.ts`, `src/roads/junction.ts`, `src/roads/laneLinks.ts`, `src/roads/network.ts`, `src/roads/profiles.ts`, `src/shared/contracts/poses.ts`, `src/sim/advisor.ts`, `src/sim/drivers.ts`, `src/sim/lanes.ts`, `src/sim/manoeuvres.ts`, `src/sim/peds.ts`, `src/sim/reedsShepp.ts`, `src/sim/routing.ts`, `src/sim/signals.ts`, `src/sim/traffic.ts`, `src/sim/traffic/grow.ts`, `src/sim/traffic/junctions.ts`, `src/sim/traffic/laneChanges.ts`, `src/sim/traffic/lines.ts`, `src/sim/traffic/measure.ts`, `src/sim/traffic/meso.ts`, `src/sim/traffic/micro.ts`, `src/sim/traffic/regions.ts`, `src/sim/traffic/state.ts`, `src/sim/traffic/stops.ts`, `src/sim/worker.ts`, `src/ui/hud.ts`, `src/ui/inspector.ts`, `src/ui/options.ts`, `src/ui/readouts.ts`, `src/world/decay.ts`, `src/world/growth.ts`, `src/world/world.ts`
- **render-core** (103): `src/config.ts`, `src/core/grid.ts`, `src/features/demolition/blast/blast.ts`, `src/features/demolition/blast/debris.ts`, `src/features/demolition/blast/marks.ts`, `src/features/demolition/ruin/ruinMesh.ts`, `src/features/demolition/ruin/ruins.ts`, `src/features/sky/clouds.ts`, `src/features/water/waterControl.ts`, `src/game.ts`, `src/jobs/boxMesh.ts`, `src/jobs/building40.ts`, `src/jobs/buildingFinishWorker.ts`, `src/jobs/buildingFinishes.ts`, `src/jobs/buildingGen.ts`, `src/jobs/buildingGen/finishes.ts`, `src/jobs/buildingGen/materials.ts`, `src/jobs/buildingGen/windows.ts`, `src/jobs/ktxParse.d.ts`, `src/jobs/meshBuilder.ts`, `src/jobs/parts40.ts`, `src/jobs/pool.ts`, `src/jobs/roadMesh.ts`, `src/jobs/roadPaint.ts`, `src/jobs/terrainSeams.ts`, `src/r40/api.ts`, `src/r40/core/hypot.ts`, `src/r40/core/minMax.ts`, `src/r40/render/bake/finishRecipes.ts`, `src/r40/render/buildings/buildingMesh.ts`, `src/r40/render/buildings/cellArrays.ts`, `src/r40/render/buildings/chunk.ts`, `src/r40/render/buildings/facadeEmit.ts`, `src/r40/render/buildings/facadeLevel.ts`, `src/r40/render/buildings/fade.ts`, `src/r40/render/buildings/finishes.ts`, `src/r40/render/buildings/flagLayer.ts`, `src/r40/render/buildings/glassRoom.ts`, `src/r40/render/buildings/kit.ts`, `src/r40/render/buildings/massBoxes.ts`, `src/r40/render/buildings/massing.ts`, `src/r40/render/buildings/massingMaterial.ts`, `src/r40/render/buildings/meshCore.ts`, `src/r40/render/buildings/partFiling.ts`, `src/r40/render/buildings/partPose.ts`, `src/r40/render/buildings/partyWalls.ts`, `src/r40/render/buildings/roomLamps.ts`, `src/r40/render/buildings/shellParts.ts`, `src/r40/render/buildings/signature.ts`, `src/r40/render/buildings/thinParts.ts`, `src/r40/render/depthConvention.ts`, `src/r40/render/lightLevels.ts`, `src/r40/render/mesh/gpuOnly.ts`, `src/r40/render/mesh/textureBaker.ts`, `src/r40/render/mesh/weld.ts`, `src/r40/render/shadowCasters.ts`, `src/r40/render/surfaceTextures.ts`, `src/r40/render/terrainGrid.ts`, `src/r40/render/wind.ts`, `src/r40/world/buildings/geometry.ts`, `src/r40/world/buildings/towerKit.ts`, `src/render/carBody.ts`, `src/render/cellLayer.ts`, `src/render/city.ts`, `src/render/cloudShadow.ts`, `src/render/cookedSurfaces.ts`, `src/render/cookedWorker.ts`, `src/render/heavyBody.ts`, `src/render/impostor.ts`, `src/render/inside.ts`, `src/render/ktx-parse.d.ts`, `src/render/particles.ts`, `src/render/people/crowd.ts`, `src/render/post.ts`, `src/render/propBlocks.ts`, `src/render/propMeshes.ts`, `src/render/props.ts`, `src/render/roads.ts`, `src/render/scene.ts`, `src/render/sun.ts`, `src/render/surfaceBake.ts`, `src/render/terrain.ts`, `src/render/terrainSeams.ts`, `src/render/textSigns.ts`, `src/render/traa.ts`, `src/render/transit.ts`, `src/render/tsl.ts`, `src/render/vehicles.ts`, `src/render/velocity.ts`, `src/render/weather.ts`, `src/roads/dash.ts`, `src/roads/junction.ts`, `src/roads/laneLinks.ts`, `src/roads/markings.ts`, `src/roads/network.ts`, `src/roads/profiles.ts`, `src/shared/contracts/poses.ts`, `src/shared/contracts/worker.ts`, `src/shared/vehiclePaints.ts`, `src/ui/options.ts`, `src/world/arch.ts`, `src/world/catalogFacade.ts`, `src/world/heights.ts`
- **generation** (80): `src/core/rng.ts`, `src/features/demolition/ruin/fracture.ts`, `src/features/demolition/ruin/worker.ts`, `src/game.ts`, `src/jobs/blockLots.ts`, `src/jobs/boxMesh.ts`, `src/jobs/building40.ts`, `src/jobs/buildingGen.ts`, `src/jobs/buildingGen/catalog.ts`, `src/jobs/buildingGen/civic.ts`, `src/jobs/buildingGen/context.ts`, `src/jobs/buildingGen/geometry.ts`, `src/jobs/buildingGen/lot.ts`, `src/jobs/buildingGen/plan.ts`, `src/jobs/buildingGen/plans.ts`, `src/jobs/buildingGen/plans2.ts`, `src/jobs/buildingGen/polygon.ts`, `src/jobs/buildingGen/shell.ts`, `src/jobs/cityField.ts`, `src/jobs/cityGen.ts`, `src/jobs/conform.ts`, `src/jobs/debugCity.ts`, `src/jobs/lots.ts`, `src/jobs/meshBuilder.ts`, `src/jobs/props.ts`, `src/jobs/roadMesh.ts`, `src/jobs/terrainGen.ts`, `src/jobs/worker.ts`, `src/r40/api.ts`, `src/r40/core/aabb.ts`, `src/r40/core/intersect.ts`, `src/r40/core/polygon.ts`, `src/r40/core/rng.ts`, `src/r40/core/scalar.ts`, `src/r40/core/units.ts`, `src/r40/core/vec2.ts`, `src/r40/render/buildings/buildingMesh.ts`, `src/r40/render/buildings/elementMesh.ts`, `src/r40/render/buildings/facadeEmit.ts`, `src/r40/render/buildings/facadeKit.ts`, `src/r40/render/buildings/facadeProps.ts`, `src/r40/render/buildings/landmarks.ts`, `src/r40/render/buildings/massing.ts`, `src/r40/render/buildings/meshCore.ts`, `src/r40/render/buildings/roofMesh.ts`, `src/r40/render/buildings/roofPlan.ts`, `src/r40/render/buildings/signature.ts`, `src/r40/render/mesh/textureBaker.ts`, `src/r40/world/buildings/architecture.ts`, `src/r40/world/buildings/blocks.ts`, `src/r40/world/buildings/blueprints.ts`, `src/r40/world/buildings/cityBuildings.ts`, `src/r40/world/buildings/elements.ts`, `src/r40/world/buildings/footprints.ts`, `src/r40/world/buildings/foundation.ts`, `src/r40/world/buildings/geometry.ts`, `src/r40/world/buildings/interior.ts`, `src/r40/world/buildings/pads.ts`, `src/r40/world/buildings/procedural.ts`, `src/r40/world/buildings/roofPlant.ts`, `src/r40/world/growth/lotBoundaryRuns.ts`, `src/r40/world/growth/lotPlan.ts`, `src/r40/world/lotRings.ts`, `src/r40/world/tiles.ts`, `src/render/ecology.ts`, `src/render/terrain.ts`, `src/render/treeMeshes.ts`, `src/roads/geometry.ts`, `src/shared/contracts/worker.ts`, `src/world/arch.ts`, `src/world/archData.ts`, `src/world/catalog.ts`, `src/world/catalogFacade.ts`, `src/world/catalogFormat.ts`, `src/world/design.ts`, `src/world/ground.ts`, `src/world/growth.ts`, `src/world/heights.ts`, `src/world/lotPlan.ts`, `src/world/roofPlant.ts`
- **i18n** (22): `src/features/roads/roadTool.ts`, `src/features/streetscape/itemTool.ts`, `src/game.ts`, `src/main.ts`, `src/r40/render/buildings/signature.ts`, `src/roads/profiles.ts`, `src/roads/streetNames.ts`, `src/roads/zones.ts`, `src/shared/i18n/index.ts`, `src/shared/i18n/lang/engine.en.ts`, `src/shared/i18n/lang/engine.pt-BR.ts`, `src/shared/i18n/lang/legacy.ts`, `src/ui/about.ts`, `src/ui/boot.ts`, `src/ui/drawers.ts`, `src/ui/hud.ts`, `src/ui/inspector.ts`, `src/ui/menu.ts`, `src/ui/options.ts`, `src/ui/peoplePanel.ts`, `src/ui/roadCatalog.ts`, `src/world/transit.ts`

## 5. Duplicações, ciclos, vazamentos de camada, código morto e violações de regra

### 5.1 Duplicações (a-c salvo indicação)

| # | O mesmo em dois ou mais lugares | Dono único proposto |
|---|---|---|
| U1 | Lista do que se limpa ao trocar de cidade: `game.ts:1608–1629` (`resetCity`) × `game.ts:1856–1868` (`openGeneration`) — já divergem (defeito D1). | `app/cityReset.ts`: uma função `clearCity()` chamada pelos dois fluxos. |
| U2 | Relevo + rocha: `game.ts:773–779` (pincel no quadro), `game.ts:1348–1355` (`api.terrain`, raio da rocha diferente para `gully`), `app/input.ts:183–186` (comando composto 'relevo'). | `features/terrain/brushTool.ts`: um comando e uma pincelada. |
| U3 | Construir via: `game.ts:1309–1319` (`api.road`, recusas próprias em português) × `features/roads/roadTool.ts` (snap → plan → build → settle → push). | `features/roads/roadTool.ts` expõe `buildStraight()` usado pela ferramenta e pela API. |
| U4 | Dois geradores de prédio: `jobs/buildingGen.ts` + `jobs/buildingGen/*` (genérico) × `jobs/building40.ts` + `src/r40/**` (4.0, produção); a passada de peças roda os dois (`buildingGen.ts:178–189`). | Um gerador (o de produção, reescrito em `jobs/buildingGen/`), com os testes portados para ele. |
| U5 | Plano de lote: `src/world/lotPlan.ts` (sem uso no jogo) × `src/r40/world/growth/lotPlan.ts`. | `src/world/lots/lotPlan.ts`. |
| U6 | Plano de telhado: `src/world/roofPlant.ts` × `src/r40/world/buildings/roofPlant.ts`. | `src/jobs/buildingGen/roofPlant.ts`. |
| U7 | Gerador aleatório: `src/core/rng.ts` × `src/r40/core/rng.ts` (outro algoritmo); `mulberry32` copiado em `world/roofPlant.ts:65–74`, `r40/world/buildings/roofPlant.ts:83–92`, `r40/render/buildings/facadePropModels.ts:109–117`, `facadeProps.ts:65–70`. | `src/core/rng.ts`. |
| U8 | Polígono: `r40/core/polygon.ts` pointInPolygon × `jobs/buildingGen/polygon.ts` inPolygon × `r40/render/buildings/lotMesh.ts:259–266` × `r40/world/buildings/pads.ts:60–74`; `polygonArea` em `blocks.ts:82–85` e `footprints.ts:53–56`; biblioteca em `world/lotEdit.ts:43–120, 416–461`; `earClip`/`clipLeft` em `jobs/buildingGen/lot.ts:180, 204`. | `src/core/polygon.ts`. |
| U9 | Crescer typed array: `sim/lanes.ts:554`, `sim/traffic/grow.ts:3`, `sim/signals.ts:300`, variantes em `sim/routing.ts:62` e `sim/peds.ts:1458`; `Grow`/`Grown` em `r40/render/buildings/meshCore.ts:226` e `massing.ts:72`. | `src/core/grow.ts`. |
| U10 | Formas de telhado: `r40/render/buildings/massing.ts:454–605` × `roofMesh.ts:379–680`. | `render/buildings/roofShapes.ts`. |
| U11 | Ajudantes de malha de veículo: `render/carBody.ts:167–236` × `render/heavyBody.ts:13–175`; caixa colorida em `render/transit.ts:19–27` × `render/vehicles.ts:31–50, 115–128`; decodificação dos bits da pose 3× em `render/vehicles.ts:695, 715–718, 799–801`. | `render/vehicles/meshKit.ts`, `render/vehicles/poseInfo.ts`. |
| U12 | Widgets: `ui/inspector.ts:729–760` × `ui/roadCatalog.ts:956–989`; teclas de via: `ui/options.ts:169–196` × `ui/roadKeysPanel.ts:10, 82–95`. | `ui/widgets.ts`; `features/roads/roadKeys.ts`. |
| U13 | Regras da simulação: DWELL (`sim/traffic/state.ts:8` × `meso.ts:26`), embarque (`micro.ts:183` × `meso.ts:146`), liberação de congestionamento (`micro.ts:337–341` × `meso.ts:243–246`), cancela abaixada 3× (`junctions.ts:146, 370`, `meso.ts:218`), 'congestionado' (`measure.ts:54` × `regions.ts:59–60`), vaga de 7,5 m literal em 5 arquivos, ciclo do semáforo copiado em `ui/inspector.ts:245, 536`. | Constantes e funções em `sim/traffic/rules.ts`. |
| U14 | Larguras de faixa: `roads/profiles.ts:296–298` STRIP_WIDTH × `roads/profileWork.ts:101–103` STEP_LIMITS (discordam). | `roads/profiles/rules.ts`. |
| U15 | Formatos binários redeclarados nas ferramentas: pose (`tools/check-sim.mjs:171`, `tools/fotos-onibus-qa.mjs:37–42`), inspeção (`check-sim.mjs:196`), props (`check-render.mjs:32`), pacote do mapa (`check-save.mjs:95–104`), ladrilho (`test/polygonLots.test.ts:134–139`), constantes do mapa (`check-render.mjs:16`). | As ferramentas importam os formatos de `src/shared/contracts/` (Node já roda `.ts`, como os testes fazem). |
| U16 | Executor das verificações no Electron: `tools/check-interface.mjs:842–876`, `check-render.mjs:202–236`, `check-save.mjs:637–682`, `check-vias.mjs:234–259`, `check-sim.mjs:346–375`; esqueleto de spawn em 8 ferramentas de foto; tabela de vistas em `tools/fotos.mjs`, `fotos-pacote.mjs` (divergente), `budget.mjs`, `fotos-testemunho.mjs`. | `tools/checks/run.mjs`, `tools/photos/run.mjs`, `tools/photos/views.mjs`. |
| U17 | Dicionários: `shared/i18n/lang/engine.*.ts` × `data/textos-roadcraft/*` × `shared/i18n/lang/legacy.ts`; `ZONE_NAMES` (`roads/zones.ts:3`) × `zone.name.*`; `save.*` × `game.toast.*` (`engine.en.ts:313–339 × 429–459`). | `shared/i18n/lang/engine.*.ts`. |
| U18 | Teste de ponte/túnel: `jobs/roadPaint.ts:75` × `jobs/roadMesh.ts:215–217` (limiares diferentes); malhagem completa das vias repetida só para ler triângulos (`jobs/worker.ts:53–58`). | `roads/structures.ts` e um resultado de malha reaproveitado. |
| U19 | Declaração do módulo `ktx-parse`: `jobs/ktxParse.d.ts` × `render/ktx-parse.d.ts` (membros diferentes). | `src/render/types.d.ts`. |
| U20 | `flatWorld`/helpers de teste copiados em `test/repair`, `roadEdits`, `streetNames`, `roads`, `roadDefects`; `positions`/`oneBuilding` em `building40`, `buildingDefects`, `buildingLook`, `defects`; fiação peds↔traffic em 5 testes de `simMotion`. | `test/helpers/*.ts`. |

### 5.2 Ciclos (b)

**Nenhum ciclo de runtime e nenhum ciclo incluindo imports só de tipo** no grafo de `src` + `test` (Tarjan sobre 1.940
arestas, 312 só de tipo). Os ciclos foram quebrados com módulos-ponte, que ficam (a-c): `ui/panelParts.ts`
(drawers ↔ peoplePanel), `roads/networkView.ts` (network ↔ control/junction), `r40/world/buildings/materialTypes.ts`
(materials ↔ types).

### 5.3 Vazamentos de camada (b)

Pelas regras `allowed` de `tools/arch-audit.mjs:131–147` aplicadas a **todo** import (o portão só olha imports de valor,
por isso nenhum destes falha hoje):

| De → para | Import (só de tipo) | Correção |
|---|---|---|
| shared → roads | `src/shared/contracts/worker.ts` → `src/roads/profiles.ts` (tipo `Profile`) | O tipo `Profile` vai para `shared/contracts`. |
| ui → render | `src/ui/hudActions.ts` → `src/render/people/creator.ts` (`ReturnType<typeof creatorCatalog>`) | O tipo do catálogo vai para `shared/contracts/people.ts`. |
| world → jobs | `src/world/growth.ts` → `src/jobs/pool.ts` (tipo `JobPool`) | Interface mínima do pool em `shared/contracts`. |

Matriz de arestas entre camadas de `src` (b): app→ui 24, app→world 18, app→render 17, app(raiz)→render 17,
app(raiz)→roads 11, features→world 24, features→roads 21, features→render 14, features→jobs 7, features→ui 5,
jobs→world 42, jobs→roads 36, jobs→shared 31, jobs→core 18, render→shared 22, render→world 21, render→jobs 18,
render→roads 10, sim→roads 37, ui→shared 20, ui→roads 13, world→core 17, world→roads 10, roads→world 8, platform→jobs 2.
Notas (a-c): `render` importa `jobs` 18 vezes (`render/city.ts:18–19` puxa `jobs/buildingGen.ts` para a página;
`render/inside.ts:10`, `render/particles.ts:16–18`); `platform/mapFile.ts:8` e `platform/saveFiles.ts:16` importam
`sha256` de `jobs/storage.ts`; a camada `domain` do CLAUDE.md não existe em `src` e a camada `tools` do
`arch-audit.mjs` (`src/tools`) não existe mais.

### 5.4 Código morto (b, reaberto pelo coordenador onde indicado)

- **Arquivos que nunca rodam no jogo** (script de alcance a partir de `src/main.ts` e das entradas de worker):
  `src/roads/markings.ts` e `src/world/lotPlan.ts` (só testes os importam); `src/r40/render/wind.ts`,
  `src/r40/render/shadowCasters.ts`, `src/r40/render/buildings/flagLayer.ts`, `src/r40/render/buildings/chunk.ts`,
  `src/r40/world/buildings/recordTable.ts`, `src/r40/world/zones.ts`, `src/r40/core/aabb.ts` (só importados como tipo;
  `chunk.ts`, `flagLayer.ts` e `zones.ts` têm tipos vivos); `src/app/featureActions.ts`, `src/ui/hudActions.ts`,
  `src/roads/networkView.ts`, `src/jobs/buildingGen/context.ts` (módulos só de tipo, corretos).
- **Funções vivas no grafo mas sem chamador** (a-c): `createBuildingKit` (`r40/render/buildings/kit.ts:485`) e tudo que
  só ela usa (`massingMaterial.ts`, `facadeLevel.ts`, `glassRoom.ts`, `thinParts.ts`, `depthConvention.ts`,
  `lightLevels.ts`, `massBoxes.ts`, os materiais de `finishes.ts` e `furnitureKit.ts`, `facadePropModels.acFarGeometry`);
  a montagem de malhas na thread principal de `r40/render/buildings/buildingMesh.ts` (`assembleBuildingMeshes`,
  `meshesOf`, `buildBuildingMeshes`…); `fade.ts`; `MODE_NAMES` (`world/transit.ts:9`).
- **Código desligado**: o "puxar a câmera para a frente do prédio" (`render/cameraRig.ts:28, 326–344`), desligado a
  pedido do dono em 2026-10-19 (comentário `:328`), deixa morta a consulta `rig.solid` de `game.ts:265–275`;
  `usePavers = float(0)` e `slabs = float(0)` multiplicam por zero o shader de lajotas (`render/roads.ts:380–399`).
- **Exports nunca importados**: 622 nomes em 140 arquivos; 185 deles nem são usados dentro do próprio arquivo. Os maiores:
  `r40/render/buildings/elementMesh.ts` 45, `r40/world/buildings/types.ts` 41, `r40/render/buildings/buildingMesh.ts` 31,
  `cellArrays.ts` 22, `roofMesh.ts` 21, `meshCore.ts` 17, `r40/core/scalar.ts` 16, `r40/world/buildings/geometry.ts` 16.
  A lista completa por arquivo está na seção de cada arquivo (§3).
- **Órfãos**: `src/jobs/ktxParse.d.ts`, `src/render/ktx-parse.d.ts`, `src/ui/css.d.ts` (declarações ambientes: o grafo
  não as vê importadas; não são órfãos de verdade).

### 5.5 Violações das regras do CLAUDE.md

| Regra | Evidência |
|---|---|
| Forbidden 1 — um objeto JS por entidade | `r40/world/buildings/types.ts:284–328` (Building aninhado por prédio), `recordTable.ts:340–350` (registro expandido por prédio na página), `render/cellLayer.ts:63, 87–88, 139–140` (Slot por célula do mapa), `r40/world/cells.ts:50–74`, `r40/world/buildings/interior.ts:21–46` (móvel por objeto), `world/items.ts:43, 181–198` (desfazer guarda array por item), `world/transit.ts:12, 18` e `sim/traffic/lines.ts:9–24` (linha por objeto; poucas), `render/inside.ts:150–155` (Mesh por caixa). |
| Forbidden 3 — arquivo-deus | `game.ts` (121 KB), `r40/render/buildings/signature.ts` (108 KB), `sim/peds.ts` (91 KB), `sim/traffic.ts` (89 KB), `roads/build.ts` (79 KB), `r40/world/growth/lotPlan.ts` (70 KB), `render/terrain.ts` (66 KB), `render/carBody.ts` (63 KB), `ui/roadCatalog.ts` (61 KB), `render/vehicles.ts` (53 KB): os 10 acima de 50 KB, todos isentos pelo baseline. Entre 40 e 50 KB: `ui/inspector.ts`, `ui/drawers.ts`, `render/props.ts`, `shared/i18n/lang/legacy.ts`, `ui/hud.ts`, `jobs/roadMesh.ts`, `r40/world/buildings/interior.ts`, `r40/render/buildings/buildingMesh.ts`, `r40/world/buildings/procedural.ts`. |
| Forbidden 4 — trabalho pesado na thread principal | Problema 5 do resumo; mais `render/inside.ts:112–115`, `render/city.ts:92–113` (`gatherBoxes` antes de cada trabalho), toda a geometria de props e veículos na carga (`render/propMeshes.ts:204–265, 540–565`, `render/carBody.ts`, `render/heavyBody.ts`). |
| Forbidden 5/6 — O(mapa) por quadro/passo/edição, amortizar | Problema 4 do resumo; `sim/advisor.ts:52–58` é amortização declarada (64 nós por passo). |
| Forbidden 7 — alocação no caminho quente | Problema 9 do resumo. |
| Forbidden 8 — geometria excessiva ou invisível | Faixa de zona embutida na malha das vias sempre (`jobs/roadMesh.ts:286–305`); uma caixa fechada por intervalo de 3 m por viga (`jobs/roadMesh.ts:420–435`); vértices emitidos sem quad (`jobs/roadMesh.ts:299–392`); caixas não indexadas antes do merge (`r40/render/buildings/signature.ts:367`); "LOD de longe" com os mesmos triângulos do perto (`render/carBody.ts:744–750`). |
| Forbidden 10 — código só de desenvolvimento, UI de depuração além da referência | `ui/health.ts` (F8/F9), menu de pior caso e dinheiro ilimitado (`game.ts:624–625`), `jobs/debugCity.ts` como trabalho do worker de produção, `traaDebug` no shader (`render/traa.ts:15, 659–661`), `?semtraa ?traadbg ?vel` (`render/post.ts:196–208`), `hidePeople` (`render/vehicles.ts:681–682`), laço de fotos no processo principal do Electron (`electron/main.mjs:113–190`), `testKey` exposto a toda página (`electron/preload.cjs:12–13`), contadores globais de medição (`r40/core/forkMap.ts:176`, `r40/world/cells.ts:42`, `r40/world/buildings/pads.ts:57`). |
| "Never pass the budget with quality tricks: adaptive detail…" | `game.ts:1195–1207` baixa o detalhe até 0,35 em jogo quando o p90 passa de 20 ms. Remover ou manter é decisão do dono (baixar qualidade não é decisão minha; tirar um recurso também não). |
| Organização — host interfaces, o dono guarda o estado, sem segunda cópia | `ui/drawers.ts:3, 96–146` (`ShellState`: "the shell keeps its own copy of every choice"); estado dos lotes no `Game` repassado por 14 pares get/set; `render/cloudShadow.ts` guarda a loja das nuvens escrita por outro módulo; globais de módulo como estado do clima, da água e do sol (`render/weather.ts:16–28`, `render/scene.ts`, `render/sun.ts:7`); `flagSink` global (`r40/render/buildings/meshCore.ts:23–25`); saídas por globais em `jobs/buildingGen.ts:204–219` e `jobs/building40.ts:47–49`. |
| Language — tudo em inglês | Comentários em português em ~40 arquivos de `src` (lista nas seções), nomes de teste em português em ~25 testes, nomes de ferramenta e de script em português (`tools/fotos*.mjs`, `tools/verificar.mjs`, `scripts/**`), chaves de armazenamento (`cidade.opcoes`, `cidade.modelosDeVia`, `cidade.mapa`), globais (`__cidade`, `cidadeSteam`), formato (`'CIDADE-MAPA-1'`), docs. `tools/verificar.mjs` e `tools/fotos.mjs` são nomeados no CLAUDE.md: só o dono renomeia. |
| Fidelidade — não copiar o código do 4.0 | DECISIONS 2026-10-30: `src/r40` 77% idêntico; fora dele `render/heavyBody.ts` 87%, `world/roofPlant.ts` 59%, `render/carBody.ts` 57%, `world/lotPlan.ts` 40%, `render/treeMeshes.ts` 30%, `features/demolition/blast/marks.ts` 30%, `roads/markings.ts` 28%. `render/traa.ts` é cópia do `TRAANode.js` do three (fonte de terceiros, não do 4.0). |
| Proof — testes que não provam nada | Problema 6 do resumo; mais `test/manoeuvres.test.ts:69, 86–91, 99` (fila atrás do caminhão calculada e descartada), `test/roadDefects.test.ts:522–586` (D13 passa vazio se toda rotatória for recusada), `test/building40.test.ts:67–68`. |
| Ferramenta do portão de arquitetura | `tools/arch-audit.mjs:217–220`: todo arquivo citado no baseline (os 80 maiores de 2026-10-2x) fica isento do limite de 50 KB **sem teto** — `game.ts`, `sim/peds.ts` etc. podem crescer à vontade; só imports de valor são checados (os 3 vazamentos de tipo passam); `PLATFORM_FILES` aponta para caminhos antigos da raiz (`:14`); camada `tools` inexistente. `tools/arch-baseline.json` cita 4 arquivos que não existem mais e foi feito com 228 arquivos (hoje 294). Mudar o baseline e o portão só em `main` com o dono. |

## 6. Plano de migração

Ordem pensada para (1) primeiro dar ao portão poder de pegar regressão, (2) tirar estado do `Game` antes de mexer nos
fluxos que dependem dele, (3) apagar código morto antes de dividir os grandes (menos para mover), (4) só então juntar
duplicatas e dividir arquivos, (5) por último as correções de desempenho, que mudam medida e precisam de `budget`.
Cada linha é um commit. Portões de cada passo: `node tools/quick-check.mjs` (ordem do dono: tsc, arch:check, testes
rápidos); ao fechar cada fase: `npx tsc --noEmit`, `npm test`, `npx vite build`, `node tools/verificar.mjs`,
`npm run arch:check` e, quando o desenho pode mudar, `npm run budget` e `node tools/fotos.mjs` (rua, bairro, cidade,
noite) antes e depois, fotos abertas e comparadas.

**Superfície pública que toda extração do `Game` tem de manter (b, `surface.mjs`)** — `window.__cidade.game.<membro>`
usado por `tools/**` e `scripts/**`: `view` (28 arquivos), `api` (19), `world` (19), `hudActions` (10), `hud` (6),
`load` (6), `rig` (6), `roadTool` (5), `save` (5), `select` (5), `setTool` (5), `commands` (4), `inspector` (4),
`paused` (4), `stats` (4), `togglePause` (4), `transit` (4), `unsaved` (4), `vehicles` (4), `canvas` (3), `growth` (3),
`simStats` (3), e com 1–2 usos: `ambient`, `applyDesign`, `applySettings`, `autosaveAt`, `bomb`, `bombForce`, `brush`,
`busy`, `clickLotTool`, `clickTransit`, `clockSpeed`, `clouds`, `drag`, `dropCorner`, `editSelected`, `fixDetail`,
`generatedCity`, `grabCorner`, `green`, `hour`, `importMap`, `inside`, `insideCmd`, `insideId`, `itemTool`,
`lotExtraPts`, `lotStroke`, `newArch`, `newFn`, `newMap`, `optionsPanel`, `parts`, `personOptions`, `personSpec`,
`placePerson`, `plantTree`, `pool`, `poses`, `post`, `preview`, `props`, `saveBlocked`, `saveStore`, `selected`,
`setLotMode`, `settings`, `settle`, `shoot`, `signalsSab`, `sim`, `skyMode`, `testCity`, `wallOpen`, `weather`,
`zoneTool` (e `waterCtl`, que já não existe). `api.*` usados: `road` (17), `line` (8), `zone` (8), `ground` (6),
`grow` (5), `lot` (5), `item` (3), `demolish`, `edit`, `junction`, `manoeuvres`, `packMap`, `passTime`, `terrain` (2 cada),
`biome`, `crossing`, `elements`, `follow`, `lotCurve`, `lotLine`, `lotPoly`, `openMap`, `paint`, `people`, `renovate`,
`river`, `strike`, `uturn` (1 cada). `hudActions.*`: 30 nomes (§3, `src/ui/hudActions.ts`). Status lido pelas
ferramentas: `window.__cidade.status` = `'carregando'|'pronto'|'falhou'`.

| # | Commit | O que sai, de onde → para onde | API pública que tem de continuar igual | Risco | Prova |
|---|---|---|---|---|---|
| **Fase 0 — dar dentes ao portão** | | | | | |
| M0.1 | Verificações que medem o efeito | `scripts/verificacao/*.js`: as 27 verificações `return true` passam a medir o efeito (alturas mudaram no raio, chão pintado, rio com água, bioma no terreno, clima mudou, texto em inglês depois de trocar o idioma); `>=` → `>` em `2-vias…:98`. | Protocolo `VER`/`VERIFICAÇÃO`/`FALHOU` de `tools/verificar.mjs`. | Baixo; pode revelar defeitos escondidos (é o objetivo). | Rodar `verificar` antes (passa) e depois; cada verificação nova falha se a ação for trocada por nada. |
| M0.2 | Ferramentas quebradas | `tools/check-interface.mjs:307` (`g.waterCtl` → `g.hudActions.environment().water`), `tools/shadercheck/mats.mjs:37` (tira `clamp`), `tools/shot.sh` apagado e `npm run shot` → `tools/shot.mjs`, foto 01 em dobro nas 5 ferramentas e montagem em dobro em `fotos-onibus-*`. | CLI de cada ferramenta. | Baixo. | Rodar cada ferramenta afetada; `check-interface B23` passa a rodar até o fim. |
| M0.3 | Executor comum das verificações | `tools/checks/run.mjs` com PRELUDE/spawn/parse de `check-interface`, `check-render`, `check-save`, `check-vias`, `check-sim`; cliente CDP único `tools/checks/cdp.mjs`. | CLIs `node tools/check-*.mjs [cenário]`. | Médio (cinco ferramentas). | Mesmas contagens OK/FAILED antes e depois em cada ferramenta. |
| M0.4 | API de automação tipada | `app/automation.ts`: um objeto `__cidade` tipado que expõe só o que as ferramentas usam (lista da §6) como métodos do jogo, sem campos privados; as ferramentas passam a usá-lo; o `Game` continua expondo os nomes antigos até M1.x mover cada um. | `window.__cidade.status`, `.game.view/stats/settle/fixDetail/world/api/hudActions`. | Médio: 95 membros, 30 arquivos de ferramenta/script. | `verificar`, `check-*` e `budget` iguais antes/depois. |
| **Fase 1 — esvaziar o `game.ts`** (cada passo: `quick-check`, `verificar`, fotos das 4 vistas) | | | | | |
| M1.1 | Corrigir D1 antes de mexer | Teste do D1 (§7) e `openGeneration` passa a chamar a mesma `clearCity()` de `resetCity` (U1): `game.ts:1608–1629` + `1856–1868` → `app/cityReset.ts`. | `load`, `newMap`, `generatedCity`, `testCity`. | Baixo. | Teste novo falha antes e passa depois; `check-save`. |
| M1.2 | Ligação com a simulação | `game.ts:124–125, 155–165, 289–321, 843–1016, 1600` → `app/simLink.ts` (dono do worker, `netOps`, temporizadores, ocupação, portas, setas, `resyncSim`, pausa/velocidade). | `g.sim`, `g.simStats`, `g.paused`, `g.togglePause`, `g.signalsSab`, `g.poses`, `api.manoeuvres`. | Médio. | `check-sim`, `check-render`, fotos de trânsito; `budget` (não muda desenho). |
| M1.3 | Gravar e abrir | `game.ts:1787–2087` + `app/session.ts` → `features/save/saveSlot.ts` e `features/save/openGeneration.ts`; `SaveActions` sai de `platform/mapFile.ts:222–227`. | `g.save/load/importMap/newMap/saveStore/saveBlocked/busy/unsaved/autosaveAt`, `api.packMap/openMap`, `hudActions.previousCities/openPreviousCity`. | Alto (save do jogador). | `check-save` inteiro, `check-user-data`, `check-reload-keys`; abrir um save antigo. |
| M1.4 | Estado dos lotes com o dono | `game.ts:193–206, 1583–1603` e os 14 pares get/set (`323–349`) → `features/buildings/lotEditing.ts` (ex-`app/lotEditing.ts`) como dono; `app/buildings.ts` junta. | `g.select/selected/setLotMode/clickLotTool/editSelected/insideCmd/applyDesign/grabCorner/dropCorner/lotExtraPts/lotStroke/newArch/newFn/inside/insideId`, `api.lot/lotPoly/lotLine/lotCurve/renovate`. | Alto (muitas ferramentas). | `check-interface`, `check-vias`, cenas de lote do `verificar`; fotos de lote. |
| M1.5 | Pincel de terreno | `game.ts:169–181, 763–780, 1286–1290, 1348–1362, 1459–1483` + `app/input.ts:179–188` → `features/terrain/brushTool.ts` com um comando relevo+rocha (U2; corrige D6). | `g.brush`, `api.terrain/paint/elements`, `hudActions.radius/strength/landform/groundKind/forest*`. | Médio. | Teste do D6; fotos de relevo; `verificar`. |
| M1.6 | Ações dos botões por recurso | O objeto de `game.ts:350–477` → `features/<recurso>/actions.ts` (vias, transporte, céu, água, terreno, mobiliário, demolição, pessoas, câmera), unidos como `featureActions()` já faz. | Os 30 `hudActions.*` usados (§3 de `src/ui/hudActions.ts`). | Médio. | `check-interface`, `verificar`. |
| M1.7 | API dos scripts | `game.ts:1273–1411` → `app/scriptApi.ts`; `api.road` usa o caminho da ferramenta (U3). | Os 30 `api.*` usados (§6). | Médio. | Todas as ferramentas que usam `api`. |
| M1.8 | Camadas e aquecimento | `game.ts:276–287` → `render/layers.ts`; `game.ts:577–636, 1170–1184` → `render/warmup.ts`. | `g.props`, `g.parts`, `g.post`, `g.settle`. | Médio (compilação de shaders na carga). | `check-render` (nenhum shader compilado em jogo), `budget`, fotos. |
| M1.9 | Parâmetros do endereço, relógio, porta do quadro | `?hora ?simples ?perf ?cam ?teste…` (`game.ts:525–657`) → `app/launchParams.ts`; hora, `clockSpeed`, `skyMode` → `features/sky/clock.ts`; decisão de desenhar (`game.ts:795–800`) → `app/frameGate.ts`. | `g.hour`, `g.clockSpeed`, `g.skyMode`, `g.view`, URL das ferramentas. | Médio. | `fotos.mjs` com `?hora`, `budget`. |
| M1.10 | Detalhe adaptativo | `game.ts:1186–1227` → `render/detailControl.ts` (só move; a regra do CLAUDE.md sobre detalhe adaptativo é decisão do dono). | `g.fixDetail`, `stats().detail`. | Baixo. | `budget` igual. |
| M1.11 | Consultas ao mundo | `greenAt` (`game.ts:863–884`) → `world/greenness.ts`; `sendDoors` (`960–980`) → `world/doors.ts`; `rig.solid` (`265–275`) apagado com o código morto da câmera (decisão de 2026-10-19). | `g.green`. | Baixo. | Teste unitário de `greenAt`; fotos. |
| M1.12 | Pequenos | Tela inicial, `gpuName`, painel de saúde, `placePerson`/tiro/bomba, texto de placa → `app/startScreen.ts`, `render/gpuInfo.ts`, `app/healthFeed.ts`, `features/people`, `features/demolition`, `features/streetscape` (texto de placa vira comando como `nameStreetCommand`); som do comando escolhido pelo tipo do comando, não pelo rótulo (`game.ts:502–503`). | `g.placePerson/shoot/bomb/bombForce/personSpec/personOptions/plantTree/optionsPanel`. | Baixo. | `verificar`, `check-interface`. |
| **Fase 2 — apagar código morto** (cada passo: `quick-check`, `npm test`, `vite build`, `budget` igual) | | | | | |
| M2.1 | Kit GLSL do r40 | Apagar `createBuildingKit` e o que só ele usa: `massingMaterial.ts`, `facadeLevel.ts`, `glassRoom.ts`, `thinParts.ts`, `depthConvention.ts`, `lightLevels.ts`, `massBoxes.ts`, `fade.ts`, materiais de `finishes.ts`/`furnitureKit.ts`, GLSL de `partPose.ts`/`roomLamps.ts`/`shellParts.ts`, `wind.ts`, `shadowCasters.ts`, `createFlagLayer`, `aabb.ts`. | `r40/api.ts`: `partGeometries`, `createFurnitureGeometries`, `emitChunk`, `emitMassing` etc. | Baixo (nada disso roda). | `vite build` menor; `npm test`; `budget` e fotos iguais. |
| M2.2 | Montagem na thread principal do r40 | Apagar `assembleBuildingMeshes`, `meshesOf`, `buildBuildingMeshes`, `withShellParts`, `shellPartFaces`… (`r40/render/buildings/buildingMesh.ts`) e os 622 exports mortos arquivo por arquivo (só os que nem o próprio arquivo usa saem; os outros perdem o `export`). | Idem. | Baixo. | `tsc`, `arch:check`. |
| M2.3 | Modelo de mundo do 4.0 sem uso | Apagar `r40/world/tiles.ts`, `bounds.ts`, `units.ts`, `zones.ts`, `cells.ts` (trocando os usos pelo índice de `core/grid.ts`), `r40/core/units.ts`, `MODE_NAMES`, `data/textos-roadcraft/index.ts`, `tools/simdefect-sweep.sh`, `tools/test-sweep.sh`, `tools/move-modules.mjs`. | — | Baixo. | `tsc`, testes. |
| M2.4 | Lote e telhado em dobro | `world/lotPlan.ts` + `r40/world/growth/lotPlan.ts` → `world/lots/lotPlan.ts` (U5); `world/roofPlant.ts` + `r40/.../roofPlant.ts` → `jobs/buildingGen/roofPlant.ts` (U6); `test/lotPlan.test.ts` passa a testar o único. | `r40/api.ts` `lotKind/planLot/furnishLot`. | Médio (geração). | Fotos de lotes e telhados idênticas pixel a pixel na mesma semente; `budget`. |
| M2.5 | Gerador legado | Portar `test/buildingDefects`, `buildingFinishes`, `buildingLook`, `defects` para o caminho de produção (sem afrouxar nenhum teste: cada asserção reescrita contra o gerador 4.0) e só então apagar `buildBuildingsLegacy`, `buildBuildingPartsLegacy` e a passada dupla de `jobs/buildingGen.ts:178–189`. | Testes. | Alto (testes de prédio). | Cada teste portado falha se o defeito que ele guarda for reintroduzido; `budget` (trabalho a menos no worker). |
| M2.6 | Legendas pintadas e lajotas mortas | Estudar no 4.0 se as legendas de `roads/markings.ts` aparecem; se sim, ligar a `jobs/roadMesh`; se não, apagar. Apagar o shader multiplicado por zero de `render/roads.ts:380–399`. | — | Médio. | Fotos 4.0 × 5 nas mesmas vistas. |
| **Fase 3 — juntar duplicatas** (cada passo: `quick-check`; fotos quando toca geometria) | | | | | |
| M3.1 | Núcleo | `r40/core/rng.ts` → `core/rng.ts`; `vec2/intersect/hypot/minMax/polygon` do r40 + `jobs/buildingGen/polygon.ts` + polígonos de `world/lotEdit.ts` e `jobs/buildingGen/lot.ts` → `core/polygon.ts`, `core/geom2d.ts`, `core/math.ts`; `grow` → `core/grow.ts` (U7–U9). | Funções puras. | Médio (a sequência do Rng muda a geração: manter o algoritmo do caminho de produção). | Fotos na mesma semente idênticas; testes. |
| M3.2 | Regras do tráfego | U13 → `sim/traffic/rules.ts`. | — | Médio. | `npm test` (simDefects, simMotion), `check-sim`. |
| M3.3 | Perfis | U14 + `roads/profiles.ts` dividido (catálogo, registro, regras, tabela da GPU); perfis por id em vez de nome em português (cityGen, build, roadVariant, drawers, testes). | `PROFILES`, `PROFILE_INFO`, `registerProfile`. | Médio. | Testes de via; `verificar`. |
| M3.4 | Ferramentas de foto | 8 ferramentas `fotos-*` + `foto-seguir` + `scripts/fotos/*` → `tools/photos/run.mjs` + conjuntos nomeados; tabela única de vistas `tools/photos/views.mjs` lida por `fotos.mjs`, `fotos-pacote.mjs` e `budget.mjs` (U16). | `node tools/fotos.mjs`, `npm run budget` (nomes no CLAUDE.md). | Baixo. | As mesmas fotos saem com os mesmos nomes. |
| M3.5 | Tradução | `data/textos-roadcraft/{en,pt-BR}.ts` + `legacy.ts` → `shared/i18n/lang/engine.*.ts` (só chaves usadas); cada texto fixo vira `t(chave)`; a dica de altura passa a dizer o passo real (D11). | `t()`, `plural()`, `loose()` some. | Alto (todo o texto). | `test/texts.test.ts` corrigido para varrer tudo; `verificar` em inglês e português; fotos da interface. |
| **Fase 4 — dividir os grandes** (cada passo: `quick-check`, `arch:check`, testes do módulo; fotos/`budget` quando é render) | | | | | |
| M4.1 | `sim/peds.ts` | → `sim/people/{events,busTrips,cyclists,crossings,kerbQueue,crowd,publish}.ts`. | `Peds` (worker). | Alto. | `simDefects`, `simMotion`, `check-sim`. |
| M4.2 | `sim/traffic.ts` | → `sim/traffic/{spawn,parking,lists,window,publish,inspect,tracks}.ts`; hosts de getters viram leitura direta das tabelas. | `Traffic` (worker), formato `inspect`. | Alto. | Idem. |
| M4.3 | `roads/build.ts` | → `roads/{journal,snap,alignment,plan,earthwork,edits,roundabout,crossings}.ts`. | 32 importadores; `buildRoad`, `planRoad`, `snap`, `RoadJournal`… | Alto. | Testes de via, `check-vias`, fotos. |
| M4.4 | `render/terrain.ts` | → `render/terrain/{cdlod,grass,ecology,roadPaint}.ts` + `features/water/waterRender.ts`. | `TerrainRenderer`. | Alto (desenho). | `budget`, fotos das 4 vistas + água. |
| M4.5 | Veículos | `render/vehicles.ts` + `carBody.ts` + `heavyBody.ts` → `render/vehicles/{models,fleet,poseInfo,meshKit,carShell,bus,truck}.ts`, reescrevendo o código copiado do 4.0 pelo resultado (DECISIONS). | `VehicleRenderer`. | Alto. | Fotos de carro/ônibus/caminhão perto e longe, `budget`, comparação com o 4.0. |
| M4.6 | Interface | `ui/roadCatalog.ts`, `ui/inspector.ts`, `ui/drawers.ts` (apagando `ShellState`), `ui/hud.ts`, `ui/options.ts` → pastas de recurso (§3). | `Hud`, `hud.catalog.*` usados por `check-vias`. | Médio. | `check-interface`, `check-vias`, fotos da interface. |
| M4.7 | Prédios do r40 | `signature.ts`, `r40/world/growth/lotPlan.ts`, `cellArrays.ts`, `elementMesh.ts`, `meshCore.ts`, `massing.ts`, `roofMesh.ts`, `interior.ts`, `types.ts`, `materials.ts` → `world/buildings`, `world/lots`, `jobs/buildingGen`, `jobs/buildingMesh`, `render/buildings`, `features/interiors`; dissolve `src/r40`. | `r40/api.ts` vira imports diretos. | Alto. | Fotos de prédio em todas as distâncias, interior, bomba; `budget`. |
| M4.8 | Workers grandes | `jobs/props.ts`, `jobs/roadMesh.ts` (sem a faixa de zona fixa, sem vigas em caixas de 3 m), `jobs/building40.ts`, `jobs/buildingGen.ts`. | Contratos de `shared/contracts/worker.ts`. | Médio. | `budget` (triângulos podem cair: anotar), fotos. |
| M4.9 | `world/world.ts` | → `world/world.ts` + `economy.ts` + `cityClock.ts` + `signs.ts`; nomes de rua para `features/roads`. | `World` (fan-in 68). | Médio. | `tsc`, testes. |
| **Fase 5 — recursos nas suas pastas** | | | | | |
| M5.1 | Mover | `roads/zones.ts` → `features/zones`; `world/transit.ts`, `render/transit.ts`, `ui/transitNames.ts` → `features/transit`; `features/terrain/riverTool.ts` → `features/water`; `render/textSigns.ts` → `features/streetscape`; `render/people/creator.ts`, `ui/peoplePanel.ts` → `features/people`; `ui/creator.ts` → `features/buildings`; `render/inside.ts` → `features/interiors`; `render/ecology*.ts` → `world`/`jobs`; céu/mar de `render/scene.ts` → `features/sky`, `features/water`. Um commit por recurso. | Caminhos de import (tsc pega). | Baixo. | `quick-check`. |
| **Fase 6 — tirar o O(mapa)** (cada passo: medida antes/depois em cidade de 10 e 24 km, `budget`) | | | | | |
| M6.1 | Regiões | `sim/traffic/regions.ts:50–61` por contadores incrementais por região atualizados na entrada/saída de veículos. | — | Médio. | Tempo do passo do worker em 10 e 24 km; `check-sim`. |
| M6.2 | Conselheiro | `sim/advisor.ts` por eventos (nó com fila ou mudança) em vez do cursor no mapa inteiro. | — | Médio. | Idem. |
| M6.3 | Semáforos | `sim/traffic.ts:1149–1152` só nós na janela; os de fora em modo meso por tempo. | Estado dos semáforos para `render/props`. | Médio. | Idem; fotos de cruzamento. |
| M6.4 | Pedestres | `sim/peds.ts:1198–1214` eventos só da janela e um agregado de fora. | — | Alto. | `simDefects`, contagens de pedestres. |
| M6.5 | Render | `render/cellLayer.ts` (sem Slot por célula; consulta por raio), `render/terrain.ts:977–987`, `render/transit.ts:125–211` (paradas sujas por região), `render/props.ts:752` (textura dos semáforos por região), `roads/junction.ts:122–123` (cache por nó). | — | Alto. | `budget`, `stats()` antes/depois. |
| M6.6 | Carga | `render/surfaceBake.ts`, `render/city.ts:30–84`, `render/cookedSurfaces.ts` para worker ou textura cozida; `wallsHeightOf` da página por tabela vinda do worker. | — | Médio. | Tempo até pronto; fotos idênticas. |
| M6.7 | Alocações | As do problema 9 do resumo, uma por commit. | — | Baixo. | Alocações por quadro no `?perf` antes/depois. |
| **Fase 7 — testes** | | | | | |
| M7.1 | Dividir e renomear | Testes com `DIVIDIR`/`RENOMEAR` do §3 (nomes em inglês; um assunto por arquivo; ajudantes em `test/helpers/`), sem afrouxar nenhuma asserção. | `quick-check` FAST lista nomes de arquivo: atualizar junto. | Baixo. | Mesma contagem de testes antes/depois (`node --test` imprime o total). |

## 7. Defeitos encontrados (passo 5) — nada foi corrigido

Cada defeito tem um teste proposto que **falha antes** da correção. "Fonte": a-c / a-l / c como no topo.

| # | Defeito | Onde | Fonte | Teste proposto (falha antes da correção) |
|---|---|---|---|---|
| D1 | Abrir um save não limpa escombros, crateras e fuligem da cidade que estava na tela: `resetCity` chama `demolition.clear()` (`:1619`), `openGeneration` não. | `src/game.ts:1855–1868` (em `fae9836`; **corrigido depois em `f24bef7`** por outra sessão, conferido no código, sem teste) | a-c | Ainda falta o teste. `check-save`: soltar a bomba num prédio, gravar outra cidade e abrir; esperar `demolition.active() === false` e nenhum destroço (`g.demolition`) depois do load. |
| D2 | `Peds.clear()` limpa só tabela/cabeças/heap: `outOfBus`, `startKey/startT`, `windowNodes` e `doors` sobrevivem; passageiros da cidade anterior descem depois de abrir outra. | `src/sim/peds.ts:1622–1626` (`outOfBus` em `:380–385`) | a-c | Unitário: provocar descidas de ônibus (enchendo `outOfBus`), `clear()`, um passo; esperar zero pedestres gerados. |
| D3 | A cidade gerada nunca tem via expressa (`:80` só gera Avenue/Collector/Local), então `nearExp` é sempre infinito e a regra da indústria (`:336`) nunca dispara. | `src/jobs/cityGen.ts:80, 281–286, 336` | a-c | Gerar a cidade padrão de uma semente e contar lados de segmento com `Zone.Industrial`; esperar > 0 (antes conferir no 4.0 a regra e a fração de indústria). |
| D4 | Balcão da boate recebe `cx` (centro em x) como coordenada y. | `src/r40/world/buildings/interior.ts:506` | a-c | Mobiliar uma boate num bloco com `cx ≠ cy`; esperar o `barCounter` dentro do retângulo do bloco junto à parede `x0`. |
| D5 | O texto do jogador diz que demolir devolve metade; o código devolve 25%. | `src/shared/i18n/lang/legacy.ts:22, 226` × `src/roads/tuning.ts:13` | a-c | Ler o valor no 4.0; teste que constrói e demole uma via e compara o reembolso com o texto da ajuda. |
| D6 | `api.terrain('gully')` pinta a rocha com raio ×0,95; a ferramenta pinta com ×0,6. | `src/game.ts:1353` × `:778` | a-c | Mesma pincelada pela ferramenta e pela API; comparar a pintura do chão texel a texel. |
| D7 | A dica de altura das vias diz "±1 m" e a tecla sobe 4 m. | `data/textos-roadcraft/pt-BR.ts:792–793` × `src/game.ts:1117–1118` | a-c | Teste de textos: o passo citado em `hint.road.curve/free` igual à constante usada por `toolKey`. |
| D8 | Cada `SectionEditor` adiciona um ouvinte `resize` nunca removido e `languageChanged()` cria um editor novo a cada troca de idioma. | `src/ui/roadCatalog.ts:526, 349–356` | a-c | Espiar `addEventListener/removeEventListener` de `window`, trocar o idioma 3 vezes; esperar o mesmo número de ouvintes `resize`. |
| D9 | Aplicar um modelo no criador de prédio não atualiza `this.floors`; "Salvar como modelo" grava o número antigo. | `src/ui/creator.ts:62–64, 110` | a-c | Aplicar um modelo de 12 andares, salvar como modelo; esperar 12 no modelo salvo. |
| D10 | `tools/check-interface.mjs` lê `g.waterCtl`, que não existe mais: o cenário B23 termina em exceção. | `tools/check-interface.mjs:307` | a-c | Rodar `node tools/check-interface.mjs B23-panels-show-map`: hoje falha por TypeError, não pela verificação. |
| D11 | `tools/shadercheck/mats.mjs` compila `pr['clamp']`, que não existe em `render/props.ts`: imprime ERRO sempre. | `tools/shadercheck/mats.mjs:37–40` | a-c | `npm run shaders` sem ERRO depois. |
| D12 | `tools/shot.sh` filtra 'página\|estado\|foto' e o Electron imprime 'state:'/'photo:'; `npm run shot` usa esse script. | `tools/shot.sh:7`, `package.json:18`, `electron/main.mjs:120, 130` | a-c | `npm run shot` mostra as linhas `state:` e `photo:`. |
| D13 | Foto 01 tirada duas vezes (a primeira sobrescrita) e montagem de vias/linha em dobro. | `tools/fotos-carro.mjs:13, 24`; `fotos-carros-qa.mjs:15, 28`; `fotos-pessoas-qa.mjs:16, 25`; `fotos-survey.mjs:15, 34`; `fotos-testemunho.mjs:15, 27`; `fotos-onibus-curva.mjs:23, 29`; `fotos-onibus-qa.mjs:47, 66` | a-c (fotos-carro), a-l (demais) | Contar as linhas `photo:` e os segmentos criados: uma foto por arquivo, uma montagem. |
| D14 | 27 verificações do `verificar` devolvem `true` sem medir; `plantTree` com `>=`; "idioma inglês" nunca troca o idioma. | `scripts/verificacao/1-ferramentas-e-acoes.js:82–92`; `2-vias-cruzamentos-lotes-ceu.js:80–111, 98`; `3-inspetor-opcoes-detalhes.js:32–47` | a-c | Para cada uma, trocar a ação por nada e ver a verificação falhar (hoje passa). |
| D15 | `test/props.test.ts` decodifica o tipo com `& 15`; o formato usa 5 bits (`& 31`). | `test/props.test.ts:28` × `src/jobs/props.ts:70` | a-c | Um prop de tipo `PROP.Signal + 16` não pode contar como semáforo. |
| D16 | `rem.invert()` chamado duas vezes seguidas sem reaplicar. | `test/streetNames.test.ts:76, 78` | a-c | Asserção do estado depois da L78 (hoje ausente). |
| D17 | `gridCity` devolve `ops: []` novo e o ouvinte continua enchendo o array local. | `test/simCity.ts:18–19, 37` | a-c | — (campo morto; remover). |
| D18 | `test/profileLimit.test.ts` registra ~300 perfis no `PROFILES` global e não remove. | `test/profileLimit.test.ts:21, 34` | a-l | Rodar `profileLimit` antes de um teste que conta perfis no mesmo processo. |
| D19 | `npm run shaders` usa `WHICH=glsl node …` (sintaxe POSIX) no Windows. | `package.json:16` | a-l (c: falha no cmd) | Rodar no cmd do Windows. |
| D20 | Guarda contra travessia de caminho por prefixo de texto (`/../dist-x/` passa). | `tools/serve.mjs:27` | a-l | Pedir `/../dist-x/arquivo`; esperar 403. |
| D21 | O detalhe adaptativo baixa a qualidade em jogo (até 0,35) — regra "never … adaptive detail" e "maximum quality". | `src/game.ts:1195–1207` | a-c | Decisão do dono; teste: com `p90 > 20 ms` simulado, `detailAuto` fica 1. |
| D22 | Portão de arquitetura isenta sem teto todo arquivo do baseline e não checa vazamentos só de tipo. | `tools/arch-audit.mjs:217–220`, `:150` | a-c | Fazer `game.ts` crescer 10 KB num ramo: hoje `arch:check` passa. |
| D23 | Terminal marcado também na parada espelhada da volta. | `src/sim/traffic/lines.ts:68, 87` | a-l (c) | Linha ida-e-volta com terminal só na ida; esperar a parada espelhada sem a marca. |
| D24 | Contadores do conselheiro por índice de braço quebram quando `unlink` compacta a adjacência. | `src/sim/advisor.ts:67–74` × `src/roads/network.ts:209–218` | a-l (c) | Remover um braço do meio de um nó medido; esperar as contagens dos outros braços intactas. |
| D25 | `FlattenMap` muda alturas sem sincronizar a água (o `BrushStroke` sincroniza). | `src/world/brush.ts:67–77` × `:151–175` | a-l (c) | Aplainar acima de um lago; esperar nenhuma água sobre terra levantada. |
| D26 | Chave de mudança `tr.version * 100000 + roadsVersion` colide depois de 100.000 versões de via. | `src/features/transit/transitTool.ts:135` | a-l | Unitário com `roadsVersion = 100000` e `version` +1: hoje a chave não muda. |
| D27 | `RiverCommand.write` marca camada e água sujas mas não `markSave` (o `GroundStroke` marca). | `src/world/ground.ts:228–247` × `:147` | a-l (c) | Fazer um rio, gravar, abrir: esperar o rio de volta. |
| D28 | `ruins.ts` descarta uma ruína com fragmentos acima de `SLOT` sem registro. | `src/features/demolition/ruin/ruins.ts:164–167` | a-l | Prédio que gere > 512 fragmentos: esperar erro registrado. |
| D29 | `inside.warm()` deixa a vista interna "ligada" com id −1 até o próximo `follow()`. | `src/render/inside.ts:220–223` | a-l (c) | Depois de `warm()`, `inside.on === false`. |
| D30 | O "LOD de longe" do carro tem a mesma contagem de triângulos do perto. | `src/render/carBody.ts:744–750` | a-l | Contar triângulos do perto e do longe; esperar menos no longe (se o 4.0 tiver LOD). |
| D31 | Heliponto é um decal vertical de 10 m no telhado. | `src/r40/render/buildings/signature.ts:1357` (decal em `:517–537`) | a-l | Foto de cima do marco com heliponto; teste: normal do decal do heliponto aponta para cima. |
| D32 | `ring` deixa vão no canto quando o lado não é múltiplo de 4 m e pula a peça do meio com `gate = 0`. | `src/r40/world/buildings/cityBuildings.ts:136–146, 139` | a-l | Cerca de um lote de 17 m: esperar o perímetro inteiro coberto. |
| D33 | `delete v.materials.sides` muda o objeto compartilhado da fonte (spread raso). | `src/r40/world/buildings/blocks.ts:119–130` | a-l | Resolver o mesmo bloco duas vezes; esperar a fonte intacta. |
| D34 | `ecologyWorker` descarta sem resposta uma mensagem que chega antes do `init`. | `src/render/ecologyWorker.ts:10` | a-l (c) | Enviar um ladrilho antes do init; esperar resposta ou erro. |
| D35 | `impostor.ts` não descarta `colorMat`, `normalMat` e a cena depois do cozimento. | `src/render/impostor.ts:90–96, 136` | a-l | Contar pipelines/bindings antes e depois de dois cozimentos. |
| D36 | `test/interface.test.ts` deixa `globalThis.window` sujo para os testes seguintes. | `test/interface.test.ts:12–14` | a-l | Rodar outro teste que testa a ausência de `window` depois dele. |
| D37 | Os testes de prédio exercitam o gerador legado, não o de produção. | `test/buildingDefects.test.ts:7`, `buildingFinishes.test.ts:8`, `buildingLook.test.ts:7`, `defects.test.ts:8` | a-c | Reintroduzir um defeito no caminho 4.0 (ex.: vértice não finito) e ver que esses testes passam assim mesmo. |
| D38 | A passada de peças roda o corpo genérico antigo para cada prédio 4.0 com a saída desligada (trabalho jogado fora). | `src/jobs/buildingGen.ts:178–189` | a-c | Medida: tempo do trabalho de peças de uma célula antes/depois de tirar a chamada, peças idênticas. |

## 8. Separação das fontes

Todas as linhas deste relatório trazem a sua fonte: (a-c) lido pelo coordenador, (a-l) lido por um leitor de lote,
(b) medido por script, (c) inferência. Os vereditos do §3 são do coordenador; as "Responsabilidades" e os "Achados do
leitor" do §3 são (a-l), com as reaberturas do §1.4 marcadas como (a-c). Medidas (b): inventário, grafo, ciclos,
vazamentos, exports mortos, alcance, superfície das ferramentas, contagem por veredito e a prova de cobertura do §9.
Inferências (c) estão marcadas uma a uma.

## 9. Prova de cobertura

Script `coverage.mjs` (scratchpad da sessão), saída real:

```text
inventory files: 756
files in the §2 table: 756
files with an entry in §3: 756
inventory files missing from §2: 0 []
inventory files missing from §3: 0 []
§2 rows not in the inventory: 0 []
§3 entries not in the inventory: 0 []
DIFFERENCE: empty
```

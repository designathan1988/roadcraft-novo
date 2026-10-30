# Organização e arquitetura — plano de refatoração incremental

Data: 2026-10-29. Este documento é a regra de organização do projeto. Ele não descreve o motor (isso está em
`ARQUITETURA.md`); descreve **como o código é dividido, como as camadas dependem umas das outras e como impedir que
a dívida cresça**.

## 1. Decisão

**Não reescrever a fundação.** A auditoria de 2026-10-29 confirma que a arquitetura de dados é a parte certa:
tabelas SoA (`core/table.ts`), grade única, comandos com inverso, geração em worker, save por ladrilho e camadas
L0–L3. O problema é a **organização do código**: arquivos gigantes, dois ciclos de runtime, ciclos de tipos,
vazamentos de camada e funcionalidades espalhadas. Jogar a fundação fora repetiria o erro do Roadcraft antigo.

A migração é **incremental (Strangler Fig)**: cada fatia mantém o jogo compilando, rodando, com orçamento e foto;
nada de big-bang. A dívida existente fica registrada numa linha de base; o que não pode é crescer.

## 2. Estado auditado (2026-10-29)

Ferramenta: `node tools/arch-audit.mjs` (grava `test-results/architecture/audit.{json,md}`).

| Medida | Valor |
|---|---:|
| Arquivos TS | 252 |
| Bytes / linhas | 3.726.864 / 66.962 |
| Arquivos >= 50 KB | 11 |
| Arquivos >= 100 KB | 5 |
| Arquivos >= 150 KB | 3 |
| Arestas de import | 1023 (184 só de tipo) |
| Ciclos de runtime | **0** |
| Ciclos de tipos | **0** (eram 4; materialTypes, networkView, interfaces ground/items e hudActions, 2026-10-29) |
| Vazamentos de camada (valor) | 0 |

Maiores arquivos: `r40/render/buildings/buildingMesh.ts` (4.119 linhas), `sim/traffic.ts` (2.852),
`game.ts` (2.645), `jobs/buildingGen.ts` (1.905), `r40/render/buildings/signature.ts` (1.781),
`world/catalogData.ts` (87 KB em 5 linhas de dados).

Vazamentos atuais (linha de base, a pagar em fatias): `render/vehicles.ts -> sim/poses.ts`,
`roads/build.ts -> ui/i18n.ts`, `roads/network.ts -> jobs/protocol.ts`, `world/* -> jobs/protocol.ts`,
`ui/drawers.ts -> render/{vehicles,people/creator}`, e os arquivos de plataforma (`save`, `saveFiles`, `mapFile`)
classificados como `shared` importando `jobs/storage`.

## 3. O que a pesquisa diz (e como se aplica)

- **Arquitetura é sobre mudança**: o objetivo é reduzir o que se precisa manter na cabeça e o alcance de uma
  mudança; abstração demais também custa. Fonte: *Game Programming Patterns*, “Architecture, Performance, and
  Games”.
- **Camadas e dependência unidirecional**: `shared -> features -> app`; features não importam umas às outras;
  cada módulo expõe uma API pública e esconde o interno. Fonte: Bulletproof React e Feature-Sliced Design.
- **Fronteiras mecânicas**: regras de import que falham no lint/CI valem mais que convenção. Fonte: Nx
  `enforce-module-boundaries`, ESLint `import/no-restricted-paths`, dependency-cruiser.
- **Projetos TypeScript separados**: project references com `composite` e `tsc -b` impõem a direção de dependência,
  reduzem recompilação e organizam o código em unidades. Fonte: TypeScript Handbook, “Project References”.
- **Mudanças pequenas**: 100 linhas é razoável, 1.000 é grande; uma mudança deve fazer uma coisa; refactor separado
  de feature. Fonte: Google Engineering Practices, “Small CLs”.
- **Strangler Fig**: substituir por partes, com arquitetura transitória, em vez de rewrite; manter valor entregue
  durante a transição. Fonte: Martin Fowler, “StranglerFigApplication”.
- **Localidade de dados**: arrays contíguos por campo, hot/cold split, IDs em vez de ponteiros; é a razão pela qual
  a fundação SoA do novo está certa. Fonte: *Game Programming Patterns*, “Data Locality”.
- **CPU e GPU separados**: o JavaScript monta buffers, bind groups e command buffers; os shaders são o programa da
  GPU. O renderer deve ter uma fronteira clara entre “estado do mundo” e “recursos de GPU”. Fonte: WebGPU
  Fundamentals.
- **Sem barrels**: importar o arquivo direto evita barris que atrapalham tree-shaking e escondem dependências.
  Fonte: Bulletproof React.

## 4. Arquitetura-alvo

Não é para mover 232 arquivos de uma vez. É o destino das fatias.

```
src/
  app/          game.ts/main.ts: composição, sessão, entrada, câmera, fotos, hooks de teste
  shared/       config, contratos de worker, i18n, matemática, tipos puros
  core/         Table SoA, grid, rng, commands, eventos (sem domínio)
  domain/       world (buildings, lots, ground, items, growth) + roads (network, build, control, zones)
  simulation/   traffic, peds, transit, routing, signals, maneuvers
  generation/   cityGen, cityField, buildingGen, r40 atrás de uma fachada
  rendering/    layers, materials, LOD, effects, terrain, vehicles, people
  features/     ferramentas do jogador: vias, zonas, construção, demolição/bomba, transporte
  ui/           shell, hud, drawers, inspector, painéis; consome features por portas
  platform/     save, saveFiles, mapFile, steam, audio, arquivos
```

Regras de dependência (valor; tipos podem ser mais flexíveis):

| Camada | Pode importar |
|---|---|
| `shared` | `shared` |
| `core` | `core`, `shared` |
| `domain` | `core`, `shared`, `domain` (world/roads são pares) |
| `generation` | `core`, `shared`, `domain`, `generation` (`r40` atrás de `r40/api.ts`) |
| `simulation` | `core`, `shared`, `domain`, `simulation` |
| `rendering` | `core`, `shared`, `domain`, `generation` (contratos), `rendering` |
| `features` | `core`, `shared`, `domain`, `simulation`, `rendering` (portas), `ui` (portas) |
| `ui` | `core`, `shared`, `domain`, `simulation`, `ui`; não importa `rendering` direto |
| `platform` | `core`, `shared`, `platform`; storage por contrato |
| `app` | todas |

O `r40` é um subsistema portado do 4.0; ele fica atrás de uma fachada (`r40/api.ts`) e não vaza tipos internos para
`world`, `render` ou `jobs`. O `jobs/protocol.ts` vira `shared/contracts/worker.ts`; o `ui/i18n.ts` vira
`shared/i18n.ts`; `sim/poses.ts` vira contrato compartilhado. A plataforma (`save`, `saveFiles`, `mapFile`, `steam`,
`audio`) sai de `shared` para `platform`.

## 5. Regras para código novo (valem a partir de agora)

1. **Nenhum arquivo novo acima de ~40 KB / 600 linhas.** Se passar, dividir por responsabilidade, não por tamanho.
2. **Nenhum ciclo de runtime novo.** `npm run arch` é o portão.
3. **Nenhum vazamento novo** das regras da seção 4. Dívida existente fica na linha de base; não cresce.
4. **Uma coisa por commit.** Refactor separado de feature; migração de arquivo separada de mudança de comportamento.
5. **API pública explícita** por módulo (`api.ts`/`index.ts`), imports diretos; sem barrels globais.
6. **Sem `any` novo em contratos**; tipos de worker em `shared/contracts`.
7. **Toda fatia mantém** `tsc`, `vite build`, `npm run budget` e as fotos; se a suíte `npm test` estiver quebrada,
   registrar e não declarar verde.
8. **Nenhuma otimização “por quadro” que cresça com o mapa**; o padrão é lista por célula/raio + worker.
9. **Dados grandes** (catálogos, listas de projetos) vão para JSON/asset ou módulo de dados puro; não para um `.ts`
   de comportamento.

## 6. Migração, em fatias

### Fase 0 — medir e congelar (feita)

- `tools/arch-audit.mjs` e comando `npm run arch`.
- Linha de base em `tools/arch-baseline.json`: ciclos de runtime vazios e os vazamentos atuais permitidos.
- Regra: feature nova não começa enquanto a fatia de arquitetura atual não fechar.

### Fase 1 — ciclos de runtime (feita em 2026-10-29)

- `world/arch.ts` -> `world/archData.ts` (dados puros; `arch.ts` reexporta).
- `ui/drawers.ts` -> `ui/panelParts.ts` (`section`); `peoplePanel` importa `panelParts`, não `drawers`.
- Resultado: **2 -> 0 ciclos de runtime**; build limpo.

### Fase 2 — contratos compartilhados e plataforma (feita em 2026-10-29)

1. `jobs/protocol.ts` -> `shared/contracts/worker.ts`; imports atualizados (world, roads, render, jobs, app).
2. `ui/i18n.ts` + `ui/lang` -> `shared/i18n/`; `roads/build.ts` deixou de importar `ui`.
3. `sim/poses.ts` -> `shared/contracts/poses.ts`; `render/vehicles.ts` deixou de importar `sim`.
4. `save.ts`, `saveFiles.ts`, `mapFile.ts`, `steam.ts`, `audio.ts` classificados como `platform` no audit (a mover para
   `src/platform/` numa fatia mecânica; o contrato já está correto).
5. `PAINTS` -> `shared/vehiclePaints.ts`; `PersonOptions`/`DEFAULT_PERSON_OPTIONS` ->
   `shared/contracts/people.ts`; UI não importa `render` em valor.

Resultado: **0 ciclos de runtime, 0 vazamentos de valor**; 4 ciclos só de tipos; 12 arquivos >=50 KB.

**Integração da linha paralela (2026-10-29):** `b96ba41` (semáforo real em toda parte) e `eab1214` (cluster
morto do r40 removido, -1.846 linhas) e `e84a2cd` (docs/ESTRUTURA.md) cherry-picks `91e6e6f`, `23f2958`, `596d319`.
`cd34522` (encosta) foi rejeitado: usa `groundAt` local num contrato world; ver `docs/VERIFY-PORT.md`. O audit caiu
para 228 arquivos/65.979 linhas, 899 arestas e 0 vazamentos; 0 ciclos de runtime; 4 só de tipos.

### Fase 3 — arquivos gigantes, um por vez (em andamento)

**Feito em 2026-10-29:** a bomba saiu do `game.ts` para `features/demolition/bomb.ts` com contexto explícito
(`world`, `push`, `blast`, `particles`, `sim`, `hud`, `ambient`, `flash`, `force`, `setHitKind`); as constantes puras
foram para `shared/contracts/bomb.ts`. O `game.ts` só faz a ligação; `api.bomb(x,z)` existe para teste. O teste na
cidade de 4 km mostrou o alvo com `floors: 12` antes e `floors: 0` depois (a demolição lógica funciona), mas a foto
mostra uma caixa cinza gigante do `Blast.collapse`, não o interior do Roadcraft. O efeito/interior é a fatia de
feature seguinte; a extração não mudou o efeito.

Ordem por risco e valor (não por tamanho):

1. `game.ts` (2.807): extrair `app/session.ts` (novo/abrir/salvar), `app/tools.ts` (troca/click), `app/bomb.ts`,
   `app/photoHooks.ts`; `game.ts` fica composição + API. A bomba entra no módulo próprio, sem engordar `game.ts`.
2. `sim/traffic.ts` (3.118): `traffic/state.ts` (tabelas/contexto), `traffic/micro.ts`, `traffic/meso.ts`,
   `traffic/signals.ts`, `traffic/buses.ts`, `traffic/manoeuvres.ts`, `traffic/measure.ts`.
3. `jobs/buildingGen.ts` (2.650): `buildingGen/shell.ts`, `facade.ts`, `roof.ts`, `polygon.ts`, `lod.ts`, `civic.ts`
   com um `GenContext` explícito.
4. `r40/render/buildings/buildingMesh.ts` (4.120): isolar atrás de `r40/api.ts` primeiro; dividir só quando for
   tocado, com fotos/budget em cada passo (é o arquivo mais arriscado).
5. `world/catalogData.ts` (87 KB, 5 linhas): mover para JSON/asset e carregar; não é código.

### Fase 4 — fronteiras mecânicas

- `tsconfig` project references por camada, ou no mínimo um `arch:check` no CI/pre-commit.
- Regras de import (`import/no-restricted-paths` ou o audit local) por camada.
- Limite de tamanho de arquivo novo e “dívida” com allowlist.
- Testes por módulo e um teste de arquitetura que falha em ciclo/vazamento novo.

### Fase 5 — reorganização de pastas/feature slices

- Só depois que as fronteiras estiverem estáveis. Mover `world`/`roads` para `domain/` e `tools` para `features/`
  é cosmético se as regras já estiverem sendo cumpridas; fazer por último, com codemod e histórico preservado.

## 7. Status e próximo slice

- Feito: audit, 2 -> 0 ciclos de runtime, Fase 2 (contratos e plataforma), 0 vazamentos de valor, plano e mapa de
  teste 4 km.
- Em dívida: 4 ciclos só de tipos, 12 arquivos >50 KB (4 >150 KB), arquivos gigantes de aplicação/geração/render.
- Feito: **Fase 3.1** — `features/demolition/bomb.ts` e `shared/contracts/bomb.ts`; `game.ts` só faz a ligação;
  `api.bomb` para teste; `BOMB_BEFORE floors 12 -> BOMB_AFTER floors 0` na cidade de 4 km. O efeito atual é uma caixa
  cinza (`Blast.collapse`), não o interior; fica para a fatia de feature.
- Próximo slice: **Fase 3.2** — `app/photoHooks.ts` já saiu; extrair `app/session.ts` (novo/abrir/salvar) e
  `app/tools.ts` (troca/click) do `game.ts`, um por commit. O `game.ts` fica composição + API.
- Feito: `src/platform/` (save, saveFiles, mapFile, steam, audio); `ui/hudActions.ts` e zero ciclos de tipos;
  `src/app/photoHooks.ts` (`view`/`settle`).
- Feito em 2026-10-29: `app/session.ts` (gravação com `SaveHost`), `app/tools.ts` (troca de ferramenta com
  `ToolHost`) e `jobs/buildingGen/plan.ts` (plano de célula, `catalogExtent`, `freeSides`). `game.ts` caiu de 2.807
  para 2.691 linhas; `buildingGen.ts` de 2.650 para 2.591. `tsc` limpo e `arch:check` com 237 arquivos, 0 ciclos e 0
  vazamentos.
- Feito em 2026-10-29: `sim/traffic/laneChanges.ts` (MOBIL, obrigatória, escape e discricionária) com `LaneHost`;
  `sim/traffic/lines.ts` (`LineSpec`, `SimLine`, `resolveLine`, `indexStops`) e
  `jobs/buildingGen/polygon.ts` (`lotFit`, `lotPolygon`, `inPolygon`), com `props` importando direto.
- Feito: `app/clicks.ts` (despacho de clique com `ClickHost`) e `app/buildings.ts` (seleção/círculo com
  `SelectionHost`), depois de `app/session.ts` cobrir salvar/abrir/novo mapa; `game.ts` ainda tem entrada/pointer e
  edição de lote/edifício.
- Feito: `r40/api.ts` centraliza a superfície externa do 4.0; `jobs/building40.ts` e `render/propMeshes.ts` importam
  por ela. Vias: fase das tracejadas em `roads/dash.ts` e máscara de perfil no leque da junção em `render/roads.ts`,
  com `test/roadContinuity.test.ts`.
- Feito: `sim/traffic/state.ts` (vocabulário do worker) e `MeshBuilder.lod` + `GenContext` no gerador, sem estado
  global de nível; `traffic.ts` caiu para 2.894 linhas.
- Feito em 2026-10-29: `buildingGen/geometry.ts` (quadro do lote, `wx/wz/nx/nz`, planos, telhados inclinados,
  toldos e `shadeHex`) e `buildingGen/materials.ts` (`BMAT`/`Facade`), com o gerador de 2.521 para 2.379 linhas;
  junção, platibanda, chaminé e telhado-planta ficam para o `GenContext` porque ainda leem `detailOut`/`layoutOut`.
- Feito em 2026-10-29: `sim/traffic/regions.ts` (ocupação de 400 m, `regionOf`, governador de frota); `Traffic`
  publica getters/setters para scripts e testes e caiu de 2.894 para 2.852 linhas. A passagem continua a cada
  `REGION_EVERY` s, uma vez pelos segmentos; a otimização incremental fica pendente de medição.
- Feito em 2026-10-29: `buildingGen/outputs.ts` (`GenOutputs`) tirou `detailOut`, `layoutOut`, `footOut` e
  `partsOut` do escopo do módulo; o passe leva as saídas no `Frame` do lote e `buildBuildings`/`buildBuildingParts`/
  `buildingVolumes` criam o objeto. O gerador caiu de 2.379 para 2.368 linhas sem mudar as chamadas de `prism`.
- Feito em 2026-10-29: `buildingGen/finishes.ts` (tabela de acabamentos, `applyFinishes`, `DESIGN_ARCH`/`SLATE`/
  `METAL_ROOF`), com o gerador de 2.368 para 2.311 linhas. `node tools/verificar.mjs` fechou **146/146** depois
  de o select de estacionamento do inspetor receber `aria-label` e o teste passar a operar o select real.
- Feito em 2026-10-29: `buildingGen/heights.ts` (`wallsHeight`, `wallsHeightOf`, `HeightRec`, `CIVIC_TOP`,
  `R40_ZONES`, `catalogLevels`), com o gerador de 2.311 para 2.259 linhas e fora da faixa de 150 KB.
- Feito em 2026-10-29: `buildingGen/windows.ts` (janelas, `curtainFins`, `ledge`, `setFac`) e
  `buildingGen/shell.ts` (`prism`, `frame`, `parapet`, `ring`, `piers`, `part`/`PART`, capturas), com o gerador
  de 2.259 para 1.949 linhas. Falta o shell de alto nível/cívico.
- Em andamento: extrair o shell de alto nível/cívico do `buildingGen`; `sim/traffic.ts` por micro/meso/ônibus;
  `r40/buildingMesh.ts` continua por último.
- `simDefects` foi investigado: C48 foi reduzido de >5 min para 12 s; C11 caiu de 300 s para 60 s simulados e C25
  usa saída antecipada (≈13 s reais). A suíte completa fechou **370/370 em 66,0 s** antes da extração de regiões;
  depois dela, trânsito/defeitos/movimento 61/61 em 58,3 s. Não declarar a suíte completa verde depois de `b6f4857`
  sem rodá-la de novo.

## 8. Fontes

- TypeScript Handbook — Project References: https://www.typescriptlang.org/docs/handbook/project-references.html
- Nx — Enforce module boundaries (tags/depConstraints): https://nx.dev/docs/guides/enforce-module-boundaries/tag-multiple-dimensions
- Bulletproof React — Project Structure: https://github.com/alan2207/bulletproof-react/blob/9506629e/docs/project-structure.md?plain=1
- Feature-Sliced Design — folder structure: https://feature-sliced.design/blog/frontend-folder-structure
- dependency-cruiser: https://github.com/sverweij/dependency-cruiser
- ESLint import/no-restricted-paths: https://github.com/import-js/eslint-plugin-import/blob/main/docs/rules/no-restricted-paths.md
- Google Engineering Practices — Small CLs: https://google.github.io/eng-practices/review/developer/small-cls.html
- Game Programming Patterns — Architecture, Performance, and Games: https://gameprogrammingpatterns.com/architecture-performance-and-games.html
- Game Programming Patterns — Data Locality: https://gameprogrammingpatterns.com/data-locality.html
- WebGPU Fundamentals: https://webgpufundamentals.org/webgpu/lessons/webgpu-fundamentals.html
- Martin Fowler — StranglerFigApplication: https://martinfowler.com/bliki/StranglerFigApplication.html

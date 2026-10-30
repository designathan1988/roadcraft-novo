# Fonte única da verdade, estado e eventos

Data: 2026-10-29. Este documento é a matriz de propriedade do estado. Antes de adicionar estado, declare o dono
aqui; antes de ler estado de outro módulo, use a API/porta/snapshot, nunca a cópia interna.

## Matriz

| Estado | Dono | Mutação | Leitores | Persistência |
|---|---|---|---|---|
| Buildings, roads, items, terrain, lot shapes | `World` (page) | `CommandStack`/`RoadJournal`/`ItemsCommand`; growth usa `growBuilding` | render, save, UI, sim (snapshot de rede) | save por ladrilho (`jobs/storage.ts`) |
| Lots oficiais | `Growth` (page) | derivado de `World.roads`/zonas; `Dirty.Lots` | World/render | reconstruído; não salvo como cópia |
| Transit lines, stops, terminals | `Transit` (page) | comandos/`Transit` API | sim (mensagem `lines`), UI, render | meta/save |
| Vehicles, peds, signals, line runtime | `sim` worker | sim | page por `poses`/`stats` (snapshots) | não salvo na page; reconstruído |
| Mesh/caches de render | `render` | derivado de World/poses; invalidado por `Dirty`/cellVersion/tileVersion | GPU | não é gameplay |
| Câmera, seleção, ferramenta | `Game`/UI | input/ações | render/UI | opções/câmera no save quando previsto |
| Opções, painéis, escolhas | `Hud`/ShellState/UI | ações do jogador | UI | opções, não mundo |
| Config, perfis, cores, i18n, contratos | `shared/*`, `config.ts`, `roads/profiles.ts` | imutável | todos | arquivo |

## Regras

1. Um dono por estado. Caches são derivados, versionados e invalidados; nunca uma segunda cópia mutável.
2. A page não simula veículos/peds; o worker é o dono. A page só envia comandos (`ToSim`) e lê snapshots (`FromSim`).
3. A UI não muta o mundo; chama comandos/portas.
4. Constantes duplicadas são bug: `config.ts`, `shared/contracts/*`, `roads/profiles`, `shared/vehiclePaints`,
   `shared/i18n` são a fonte única.
5. IDs: nenhuma lista guarda id que possa ser reaproveitado sem versão/geração; `Table`/`allocAt` e `cellVersion`
   são a base.
6. Save/load reconstrói o estado do dono; não criar um segundo save paralelo.
7. Eventos: `ToSim`/`FromSim`, `Dirty`, `CommandStack` e snapshots. Callback ad-hoc que possa perder evento é bug.
8. Fluxo: input → Command/porta → World/sim → Dirty/version → render/UI. Renderer não decide gameplay; UI não altera
   arrays do World.
9. Testes de invariantes: contagem de prédios/vias, grafo de vias, linhas/paradas, poses; undo/redo;
   save→reload→undo; edição→sim→render; nenhum cache velho após edição.

## Riscos encontrados no HEAD (a verificar/consertar)

- `Transit` (page) e `sim.lines` (worker) são cópias por snapshot: a atualização precisa ser atômica e preservar
  ids/paradas; C9 (resend de linhas) é o teste de regressão.
- `Growth.lots` é derivado de `World.roads`; uma edição de via/zona precisa marcar `Dirty.Lots` e não deixar lote
  antigo no render (ver F12/F13).
- `render` mantém caches por célula/tile/placa; o `CellLayer` troca L0/L1/L2/L3 e faz fade por dither. Qualquer
  estado de LOD é derivado; não pode virar decisão de gameplay nem duplicar a lista de prédios.
- `sim` mantém sinais, filas, linhas, ônibus e passageiros; a page não deve manter uma segunda lista de veículos.
  O vocabulário puro do worker está em `sim/traffic/state.ts` (`vehSchema`, `End`, inspeção e tipos); não é uma
  segunda cópia mutável. A ocupação de regiões e o governador de frota têm um dono único, `sim/traffic/regions.ts`;
  `Traffic` só publica getters/setters para scripts e testes.
- `Game` concentra câmera, seleção, ferramenta, sessão e bomba; `app/session.ts`, `app/tools.ts`, `app/clicks.ts`,
  `app/buildings.ts` e `app/photoHooks.ts` já receberam as portas; a edição de lote/entrada continua nele.
- O nível de detalhe do gerador viaja em `MeshBuilder.lod`; não há mais `genLod` global. A geometria pura
  (quadro do lote, telhados, toldos, `shadeHex`) está em `buildingGen/geometry.ts`; `BMAT`/`Facade` em
  `buildingGen/materials.ts`, reexportados pelo gerador. As saídas de um passe (detalhe, volumes, footprints,
  peças) viajam em `GenOutputs` no `Frame` do lote (`buildingGen/outputs.ts`); não há sink de módulo.
- O r40 é uma dependência de geração/render atrás de `r40/api.ts`; nenhum consumidor externo importa seus módulos
  internos. O pipeline de `buildingMesh.ts` ainda precisa ser dividido por responsabilidade.
- `props` tem pool/cap e blocos por célula; o cap não pode virar corte silencioso nem mudar a cada quadro (E24).
- `network`/`control`/`junction` tiveram os ciclos de tipos removidos; não há ciclos runtime/tipo no HEAD.

## Portão

- `npm run arch:check` no HEAD: **258 arquivos/67.049 linhas, 0 ciclos de runtime, 0 de tipos, 0 vazamentos**.
- Cada nova feature atualiza esta matriz; nenhum estado novo sem dono.
- O `MeshBuilder` é contexto de geração passado por prédio; `vehSchema`/`End` são vocabulário puro do worker, não
  estado de jogo.

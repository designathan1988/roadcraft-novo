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
- `Game` concentra câmera, seleção, ferramenta, sessão e bomba; a Fase 3 está extraindo essas responsabilidades.
- `props` tem pool/cap e blocos por célula; o cap não pode virar corte silencioso nem mudar a cada quadro (E24).
- `network`/`control`/`junction` têm ciclos de tipos; não são runtime, mas devem ser quebrados por contratos.

## Portão

- `npm run arch:check` deve ficar limpo para ciclos/vazamentos novos.
- Cada nova feature atualiza esta matriz; nenhum estado novo sem dono.

# Estrutura e organização do roadcraft-novo

Data: 2026-10-29. Dono: "não cometer o erro do roadcraft original: arquivos desorganizados, enormes
ao lado de minúsculos, a mesma funcionalidade dividida em dezenas de arquivos. Se o novo já estiver
assim, parar e consertar a estrutura antes de continuar."

## O estado medido (branch `port/funcionalidades`, pós-limpeza)

235 → 228 arquivos TS, ~65,7 mil linhas. Distribuição: 142 arquivos <200 linhas, 56 entre 200–500,
29 entre 500–1.000, 4 entre 1.000–2.000, **4 acima de 2.000** (`r40/buildingMesh` 4.119 — cópia do
gerador 4.0; `sim/traffic` 3.114; `game.ts` 2.806; `jobs/buildingGen` 2.649).

Comparação com o roadcraft original (o erro a não repetir): 865 arquivos / 221 mil linhas,
renderer de 4.355 e main de 4.360 na thread da página, `doc.ts` de 3.943, a mesma funcionalidade
espalhada em dezenas de arquivos (`render/buildings/` com 48, `world/buildings/` com 39), camadas
de otimização empilhadas (cellKeeps, candidateKeep, uploads, stagedTexels, revealGate, stillTree,
pinned, frameBudget, partWarm...).

**Veredito: o novo NÃO é o roadcraft.** A organização por domínio (core/world/roads/sim/render/
jobs/ui/tools) está certa, a mediana dos arquivos é pequena e a arquitetura (SoA, workers, células,
comandos) é o motivo do desempenho. Não é base errada; são três dívidas delimitadas, tratadas abaixo.

## As três dívidas e o tratamento

### 1. `src/r40/` — a árvore do 4.0 embutida (77 arquivos, ~22 mil linhas, ~33% do código)

O gerador de prédios do Roadcraft 4.0 veio inteiro, com renderizador e infraestrutura de frame
do jogo velho. Tratamento em andamento:

- **Feito (eab1214)**: a fechadura de imports provou que o renderizador do frame velho estava
  tecelado no emissor (buildingMesh → finishes/massingMaterial → lotOverlay → activeTiles →
  cellKeeps/candidateKeep/derived/changes). As duas costuras (`applyLotOverlay`) foram cortadas e
  o cluster morto deletado (1.847 linhas). Critério de prova: fechadura de imports a partir dos
  pontos de entrada do motor + `tsc` limpo + cidade idêntica (mesmos stats e foto).
- **Regra daqui em diante**: `src/r40/` é um gerador vendado, com costura limpa. Motor nenhum
  arquivo fora de `jobs/building40.ts`/`jobs/parts40.ts` importa `r40/render` (materiais do 4.0
  não são os do motor). Toda migração do 4.0 entra por jobs/ e só traz lógica de geração. O que
  ficar inalcançável é recalculado na fechadura e deletado, nunca deixado.
- **Por que não dissolver o r40 nas árvores do motor agora**: o 4.0 ainda é a referência viva de
  onde vêm melhorias do gerador; manter o espelho com costura explícita permite comparar e portar.
  Dissolver é trabalho cosmético com risco de merges futuros; fica para quando o 4.0 parar de
  ser referência.

### 2. Os três arquivos grandes do motor (`traffic.ts`, `game.ts`, `buildingGen.ts`)

A própria documentação já marcava `game.ts`/`hud.ts` como pontos fracos ("dividir por área quando
mexer, sem mudar comportamento"). Plano em fatias, cada uma com a bateria completa (tsc, testes,
build, foto comparativa, commit):

- `sim/traffic.ts` (3.114) → dividir por responsabilidade: `sim/traffic/micro.ts` (janela e
  veículos), `sim/traffic/meso.ts` (eventos por trecho), `sim/traffic/junctions.ts` (yield/claims),
  `sim/traffic/parking.ts` (vagas, docas, manobras), `sim/traffic/transit.ts` (linhas/paradas),
  `sim/signals.ts` (já separado). Sem mudar comportamento; a divisão segue os blocos de comentário
  que já existem.
- `game.ts` (2.806) → extrair por área em ordem de risco crescente: save/load (já quase isolado),
  testCity/cityGen fluxos, ferramentas (bomb/shoot/grow), relógio/clima, HUD-wiring. Cada extração
  um commit.
- `jobs/buildingGen.ts` (2.649) → o gerador próprio (zona industrial/cívicos) separado do
  despachante 4.0 (building40) e do protocolo de LOD.
- Meta: nenhum arquivo do motor acima de ~1.500 linhas; um arquivo, uma responsabilidade; testes
  colados perto do que testam.

### 3. Suíte de defeitos de prédios já quebrada na base (achado, não causado por nós)

`test/buildingDefects.test.ts` tem **17 falhas no 3e67e9e puro** (confidado com stash: 17 antes e
depois da limpeza eab1214). As falhas incluem "the parts pass emits parts" (peças nem emitidas) e
parapeto/cornija — a integração WIP do caminho 4.0 no ramo `conserto/criticos` quebrou testes que
documentam o comportamento do gerador. **Corrigir isso é pré-requisito da divisão do
buildingGen.ts**: não se divide um arquivo cujos testes estão vermelhos — conserta-se os testes
(ou o regresso que os quebrou) primeiro, para a divisão ter rede.

## Regras de estrutura (da pesquisa e do historial dos dois jogos)

1. **Organizar por domínio/funcionalidade, não por camada** — arquivos que mudam juntos ficam
   juntos (features coesas, deleção fácil). O novo já segue; manter.
2. **Uma responsabilidade por arquivo; nenhum "god file"** — acima de ~1.500 linhas, dividir por
   responsabilidade com extração incremental e teste verde em cada passo (não big-bang).
3. **Acoplamento baixo entre módulos** — sim via workers/comandos; render não conhece sim; jobs
   não conhecem three (regra já existente e cumprida).
4. **Código morto é deletado na hora**, com prova de inalcançabilidade (fechadura de imports),
   nunca arquivado "por se acaso".
5. **Nada de árvore estrangeira sem costura** — vendored code (r40) isolado, com ponte única e
   explícita pelos jobs.
6. **Testes colados no que testam** e a bateria (tsc + testes + build + foto) roda em todo commit
   de estrutura.

## Fontes da pesquisa

- Organização por feature vs camada: [Mastering JavaScript Project Structure](https://medium.com/@mark.onyango_95482/mastering-javascript-project-structure-a-guide-to-modules-and-organization-33f010b0d136), [Code organization and best practices](https://medium.com/@creativebyte/code-organization-and-best-practices-b5d00fa1aa91)
- God files e divisão incremental com regressão: [Khan Academy — The Great Python Refactor](https://blog.khanacademy.org/the-great-python-refactor/), [Massive Project Code Refactoring Tips](https://medium.com/@ichirohirata/massive-project-code-refactoring-tips-b8b7dc5b9e30)
- Acoplamento em engines: [Game Engine Architecture best practice (gamedev.net)](https://gamedev.net/forums/topic/715804-game-engine-architecture-best-practice), [How Modular Architecture Shapes Modern Game Development](https://dev.to/bob_packer_7c9018a4d1a1f1f6d)

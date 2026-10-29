# Verificação da linha `port/funcionalidades`

Data: 2026-10-29. Worktree lida apenas por `git show`/`git grep`; nada foi escrito em `lab/roadcraft-port`.

| Commit | Veredito | Evidência | Ação |
|---|---|---|---|
| `b96ba41` signals | **Aceito e integrado** (`91e6e6f`) | `traffic.ts` `nodesRebuilt` adiciona todos os nós sinalizados a `signalNodes` (`:1800-1810`); `lightState(n)` lê o ciclo cronometrado de `signals.ts`; o commit troca `windowSignals` por `signalNodes` em `updateSignals` e deixa de zerar o estado ao sair da janela (`:1699-1704`, `:2750-2758`). O desenho passa a coincidir com o que os carros obedecem. Testes C6/C32 passam em 301 ms após o pick. Custo: um laço sobre os nós sinalizados por passo; a medir no budget/worker, sem `O(mapa)`. |
| `cd34522` slope | **REJEITADO** | `Lot40.groundAt` é **world**: `lot40Of` passa `heightAt(heights,x,z)` e `emitChunk` chama `groundAt(w[0],w[1])` com coordenadas de mundo (`buildingMesh.ts:2105,2649`). O commit chama `lot.groundAt(0,0)` e `lot.groundAt(0,-lot.D*0.75)`, coordenadas **locais/origem**. Teste `test-results/arch/r40-ground.ts`: lote em (500,500) com terreno 110 m assenta em ~107 m (world), mas o commit amostraria a origem (10 m). O `hill` fica errado e o portão de 0,3 m pode declarar plano um lote inclinado. Não integrar; corrigir depois com `lot.cx/cz/rot` e o frame do lote. | Rejeitado |
| `eab1214` r40 deletion | **Aceito e integrado** (`23f2958`) | `git grep` em `e84a2cd` não encontra import vivo de `lotOverlay`, `lotLattice`, `activeTiles`, `cellKeeps`, `candidateKeep`, `world/changes` ou `world/derived`; só uma referência em comentário em `massingMaterial.ts:119`. As duas costuras `applyLotOverlay` saem de `finishes.ts`/`massingMaterial.ts`; o motor usa o material próprio de `render/city.ts`, não esses. `tsc`/build/arch limpos após o pick (228 arquivos, 65.979 linhas, 0 ciclos/0 vazamentos). | Integrado |
| `e84a2cd` structure doc | **Aceito e integrado** (`596d319`) | Documento lido; baseline 235→228 arquivos e 17 falhas de `buildingDefects` no 3e67e9e puro, consistente com a varredura (`8` falhas no arquivo atual + testes de geometria; a suíte completa precisa ser recontada). É documentação, sem código. | Integrado |

## Diagnose da suíte de prédios

`test/buildingDefects.test.ts` tem falhas **pré-existentes** no 3e67e9e puro (17, segundo a outra linha; nossa varredura viu 8 no arquivo atual, além de `buildingFinishes`/`Look`/`defects`/`render-defects`/`simMotion`). É item 0 antes de dividir `jobs/buildingGen.ts`: consertar ou atualizar os testes com prova, sem silenciar. As falhas atuais incluem `0 plinth`, `0 parapet`, `parts pass`, `-Infinity` de fachada e chão poligonal; o caminho R40 versus o gerador genérico precisa ser separado.

## Observações

- `simDefects` não tem um laço infinito único: C11, C48 e C25 passam de 15 s; C25 passa em 75 s. `traffic.test.ts` passa em 113 s. O `npm test` completo é lento, não necessariamente travado; medir com os testes por nome e não declarar verde sem terminar.
- Nada foi integrado antes desta verificação; `cd34522` fica de fora até correção.

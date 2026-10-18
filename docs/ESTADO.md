# Estado do trabalho (reescrever a cada mudança; entra sozinho em toda sessão e depois de toda compactação)

Atualizado: 2026-10-18, 19h30.

## O que é este projeto e de onde veio
- Roadcraft 5 = o motor do "Cidade" (`C:\Users\Jonathan\Documents\Projects\city-game\city-game`, que abre cidades
  de 10 a 24 km) + a aparência, a interface e todos os recursos do Roadcraft 4.0
  (`C:\Users\Jonathan\Documents\Projects\roadcraft\roadcraft-4.0-main`, referência SÓ LEITURA; nunca copiar a
  arquitetura dele: objeto por entidade e tudo na thread principal foi o que o matou; ver `docs/LICOES.md`).
- Decisão do jogador (2026-10-18): não continuar nenhuma das quatro versões anteriores do Roadcraft. Este
  repositório é o único que anda. Prazo dele: ter o jogo funcionando com visual, interface e recursos do Roadcraft.
- Commit inicial `2db899c`: motor inteiro compilando (tsc limpo, 57 testes, `vite build` ok), `tools/fotos.mjs`,
  `data/lots-roadcraft/` (38 projetos de prédios do Roadcraft), `data/textos-roadcraft/` (dicionários pt-BR e en,
  1.760 linhas cada = inventário dos recursos), `docs/` (arquitetura, recursos, lições, pesquisas, históricos).
- Fotos do ponto de partida: `test-results/fotos/0{1..4}-*.png` (cidade de 10 km pronta em 25 s, 38 mil prédios).

## Como rodar e conferir
- `node_modules`: o registro npm está bloqueado nesta máquina; o `node_modules` foi copiado do city-game (mesmo
  lockfile). Num worktree novo: `cmd /c mklink /J node_modules C:\Users\Jonathan\Documents\Projects\roadcraft-novo\node_modules`.
- `npx tsc` · `npm test` · `npx vite build` · `node tools/fotos.mjs [pasta]` (Electron com a GPU, 4 vistas fixas
  na cidade gerada de 10 km; abrir cada PNG com Read) · `node tools/verificar.mjs` (146 verificações no jogo).
- Nunca o navegador embutido do app. Playwright só com `channel: 'chrome'`.

## Frentes abertas (uma sessão por frente, cada uma num worktree e nos seus arquivos; quem integra em `main` lê o
## diff inteiro, roda build + testes + fotos e confere as 4 vistas)
| Frente | Arquivos | Estado |
|---|---|---|
| Interface do Roadcraft (dock, barra, painéis, textos, CSS) | `src/ui/**` exceto `creator.ts`, `index.html`, ligação em `game.ts` (`hudActions`) | a começar |
| Prédios com o visual do Roadcraft + construtor completo | `src/jobs/buildingGen.ts`, `src/render/city.ts`, `src/render/inside.ts`, `src/world/arch.ts`, `src/world/design.ts`, `src/ui/creator.ts`, `data/lots-roadcraft` | em andamento (sessão predios-roadcraft). Pronto: item 1 (13 acabamentos em texture array, `test-results/depois-1/`), item 2 (caixilho, moldura, frisos, rufos, brises, pilastras, portas, guarda-corpos; peças de fachada como mobiliário 8..15 no pool de props, `test-results/depois-2/`), item 3 (9 padrões de fachada por assinatura a 90 m, 38 projetos do Roadcraft no catálogo `CATALOG` de `world/design.ts` e como marcos a 22 % das torres, nunca repetidos a menos de 250 m; esquina com jardim, portões, muros de divisa, garagem e meia-ala em encosta, muro de arrimo, docas; `test-results/depois-3/`). Contagens depois do item 3: chamadas 461/186/548/478 (antes 461/186/548/477), bairro 2,23 M tris (antes 1,25 M). Falta: item 4 (construtor), item 5 (desgaste/reforma), tradução para inglês dos comentários de `jobs/buildingGen.ts` e `render/city.ts` |
| Pessoas do Roadcraft (MakeHuman cozido, LOD, paletas na GPU) | novo `src/render/people/**`, `public/models/people`, gancho em `render/vehicles.ts` (só o ramo das pessoas) | a começar |
| Vias, terreno, vegetação, veículos, luz e pós com o visual do Roadcraft | `src/jobs/roadMesh.ts`, `roadPaint.ts`, `src/render/{roads,terrain,props,propMeshes,impostor,vehicles,post,scene,weather,particles,cloudPuffs}.ts`, `src/jobs/props.ts`, `src/world/ground.ts` | a começar |
| Funcionalidades que faltam ou estão abaixo do Roadcraft (`docs/RECURSOS.md`) | `src/tools/**`, `src/sim/**`, `src/roads/**`, `src/world/{lotEdit,transit,items,growth,world}.ts`, `src/save.ts`, `src/jobs/{lots,storage}.ts`, `test/**` | a começar |

## Regras que valem em toda frente (resumo; o resto em `CLAUDE.md` e `docs/ARQUITETURA.md`)
- Registro pequeno em tabela SoA; malha gerada em worker; página só envia; um material por camada; peças
  repetidas no pool de props com culling na GPU; nada por quadro/edição/passo que cresça com o mapa; sem amortizar.
- Toda mudança visual: `game.stats()` (draws, tris, MB) e foto antes e depois nas 4 vistas, no commit.
- "Pronto" só com foto aberta e nomeada. Nada "temporário" no repositório. Não dar push sem o jogador dizer.

## Próximo passo de quem abrir esta pasta sem contexto
1. Ler `CLAUDE.md`, este arquivo, `docs/RECURSOS.md` e `docs/LICOES.md`.
2. `git log --oneline -20` e `git branch -a` para ver o que cada frente já entregou (ramos `work/*`).
3. Rodar `npx tsc && npm test && npx vite build && node tools/fotos.mjs` e abrir as fotos antes de mexer.
4. Pegar a frente marcada "a começar" ou "parada" na tabela acima, atualizar a linha e seguir.

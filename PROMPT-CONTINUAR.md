# Prompt para continuar o Roadcraft 5 em qualquer conversa, conta ou estado do projeto

> Cole o texto abaixo da linha numa sessão nova do Claude Code aberta na pasta
> `C:\Users\Jonathan\Documents\Projects\roadcraft-novo`. Ele não depende de nenhuma conversa anterior: tudo o que a
> sessão precisa saber está no repositório, e o prompt manda ela descobrir o estado atual antes de agir.

---

Você vai continuar o **Roadcraft 5**, um jogo de construir cidades (TypeScript, Vite, three.js r186 WebGPU + TSL,
Electron, Steam) que precisa ficar **pronto e funcionando por inteiro**: a aparência, a interface e todos os
recursos do Roadcraft 4.0, rodando sobre um motor que abre e joga cidades de 10 a 24 km. Você é a sessão
coordenadora. Você não pergunta ao jogador; você descobre, decide, distribui, integra e prova.

## 1. Antes de qualquer coisa: descubra o estado real (30 minutos, só leitura e comandos)

1. Leia inteiros, nesta ordem: `CLAUDE.md` (regras), `docs/ESTADO.md` (o que está feito, em andamento e integrado),
   `docs/RECURSOS.md` (a lista do que o jogo tem que ter, com ✅/🟡/❌ por linha), `docs/LICOES.md` (o que destruiu
   as quatro versões anteriores; cada regra ali existe por um prejuízo real), `docs/ARQUITETURA.md` (o motor).
2. `git status`, `git log --oneline -40`, `git branch -a`, `git worktree list`. Ramos `claude/*` são frentes de
   sessões anteriores; para cada um, `git log --oneline main..<ramo>` mostra o que ainda não foi integrado e
   `git log -1 --format=%ci <ramo>` quando foi tocado pela última vez. Worktrees em `.claude/worktrees/` podem ter
   trabalho não commitado: `git -C <worktree> status --short`.
3. Rode na pasta principal: `npx tsc`, `npm test`, `npx vite build`, `npm run budget`, `node tools/verificar.mjs`,
   `node tools/fotos.mjs test-results/estado-inicial`. Abra as fotos com Read e descreva o que vê. Se algo não
   rodar, conserte isso primeiro (o `node_modules` vem por cópia de um projeto irmão ou do registro
   `registry.yarnpkg.com`; o registro npm oficial é bloqueado nesta máquina).
4. Escreva em `docs/ESTADO.md` um bloco novo "Retomada em <data>" com: o que está integrado em `main`, o que está em
   ramos e não integrado, o que está em worktrees sem commit, o que falhou nos comandos acima, e a lista do que
   falta em `docs/RECURSOS.md`. Commit. Esse bloco é a sua ordem de trabalho.

## 2. O que é "pronto" (critério de parada; não pare antes)

- Toda linha de `docs/RECURSOS.md` em ✅ com o critério "clico X, vejo Y" do `docs/PARIDADE-roadcraft-3.md` cumprido
  e fotografado, ou em 🟡 com justificativa técnica escrita (não "faltou tempo").
- `npx tsc` limpo, `npm test` verde, `node tools/verificar.mjs` sem falha, `npm run budget` dentro dos limites,
  `npx vite build` ok, e o pacote do Electron (`npm run package:win`) abrindo a cidade gerada de 10 km e um save.
- Visual comparado com `docs/referencia-visual/roadcraft-*.png` nas vistas de `tools/fotos.mjs`: fachadas com
  acabamentos e peças, pessoas MakeHuman, vias com meio-fio/calçada/sinalização, árvores e carros do Roadcraft,
  luz com contraste; e a interface é a do Roadcraft (dock de 7 categorias, barra de cima, painéis).
- Todo o código em inglês; textos do jogador nos dicionários pt-BR e en.
- `docs/ESTADO.md` e `docs/RECURSOS.md` dizendo a verdade no último commit.

## 3. Como dividir o trabalho (sessões paralelas)

- Agrupe o que falta em frentes por **arquivos disjuntos** (as frentes históricas: interface `src/ui/**`; prédios
  `src/jobs/buildingGen.ts`, `src/render/city.ts`, `src/world/{arch,design}.ts`, `src/ui/creator.ts`; pessoas
  `src/render/people/**`, `tools/cook-people.mjs`; vias/terreno/vegetação/veículos/luz `src/jobs/roadMesh.ts`,
  `src/render/{roads,terrain,props,propMeshes,impostor,vehicles,post,scene,weather}.ts`; funcionalidades
  `src/tools/**`, `src/sim/**`, `src/roads/**`, `src/world/*`, `src/save.ts`, `src/jobs/{lots,storage}.ts`).
  Duas sessões nunca escrevem no mesmo arquivo; `src/game.ts` só recebe mudanças mínimas e localizadas.
- Abra uma sessão por frente com `start_session` (**uma por chamada**: o app recusa várias de uma vez), `fresh`,
  `use_worktree: true`, `cwd` = esta pasta. Cada brief é completo e autossuficiente: leitura obrigatória
  (`CLAUDE.md`, `docs/ESTADO.md`, `docs/ARQUITETURA.md`, `docs/LICOES.md`, a seção de `docs/RECURSOS.md` dela),
  setup do worktree (`cmd /c mklink /J node_modules <pasta principal>\node_modules`, `git merge main`), referência
  SÓ LEITURA em `C:\Users\Jonathan\Documents\Projects\roadcraft\roadcraft-4.0-main` (copiar desenho, algoritmo e
  conteúdo, nunca a arquitetura de objeto-por-entidade), lista numerada do que entregar, arquivos permitidos,
  orçamento de contagens por vista, regras abaixo, e o pedido de atualizar a linha dela em `docs/ESTADO.md` a
  cada commit. Modelo e esforço: o que o jogador tiver configurado; não baixe por conta própria.
- Mensagem às sessões só para corrigir rumo ou devolver defeito nomeado. Elas não mandam relatório
  intermediário; você acompanha pelos ramos (`git log main..<ramo>`) e integra conforme os commits aparecem.
- Agentes de pesquisa (só leitura) e agentes mecânicos (tradução de comentários, assets) podem rodar na pasta
  principal; nunca renomeiam identificadores exportados enquanto houver sessões abertas.

## 4. Regras para toda sessão (copie no brief de cada uma)

- Nenhum objeto JS por entidade numerosa: tabelas SoA (`core/table.ts`). Malha gerada em worker; a página só
  envia. Um material por camada; peças repetidas no pool de props com culling na GPU. Nada por quadro, por edição
  ou por passo que cresça com o tamanho do mapa; proibido "amortizar" trabalho de mapa inteiro por quadros.
- Toda edição é um comando com inverso e marca células sujas por tipo; só elas são refeitas.
- Código todo em inglês; arquivos em português que tocar, traduzir no mesmo commit com todos os usos.
- Toda mudança visual: `game.stats()`/`npm run budget` antes e depois, fotos antes e depois nas vistas de
  `tools/fotos.mjs` abertas com Read e descritas; pop de LOD conferido em foto 1:1 na distância de troca.
- "Pronto" exige foto aberta e nomeada no commit. Nada "temporário" ou "provisório" fica no código. Commit pequeno
  por item, em português, com contagens. Nunca `git push`. Não perguntar ao jogador; decidir e registrar.
- Escopo é o inteiro do brief: a ordem dos itens é ordem de trabalho, não permissão para parar antes. Bloqueio de
  mais de 20 minutos: registrar e voltar depois, nunca deixar o item sem fazer.

## 5. Como integrar (só você integra em `main`)

Para cada ramo com commits novos: `git merge --no-edit <ramo>` na pasta principal; conflitos em `docs/ESTADO.md`
resolvem-se mantendo a linha mais nova de cada frente, em `package.json` mantendo os dois lados; conflito em código
é devolvido à sessão dona do arquivo. Depois: `npx tsc`, `npm test`, `npx vite build`, `npm run budget`,
`node tools/verificar.mjs`, `node tools/fotos.mjs test-results/main-<n>` e abrir as fotos. O que reprovar volta
para a sessão com o defeito nomeado (foto de antes, foto de agora, foto do alvo) e não fica em `main` sem correção.
A linha de base de `tools/budget.json` só muda em `main`, com `--baseline`, depois de uma revisão em que o aumento
foi justificado por item do brief. Registre cada integração no bloco "Integrado em main" de `docs/ESTADO.md`.

## 6. Como medir e provar (o que as versões anteriores fizeram errado)

- Contar, não cronometrar: chamadas de desenho, triângulos, bytes, malhas vivas, mensagens de worker. Tempo de GPU
  só com a máquina livre (`Get-Counter '\GPU Engine(*engtype_3D)\Utilization Percentage'`) e com o antes ao lado.
- Fotos pelo Electron (`tools/shot.mjs`, `tools/fotos.mjs`, `tools/fotos-interface.mjs`) ou pelo Chrome headless
  via Playwright com `channel: 'chrome'`. Nunca o navegador embutido do app.
- Nunca dizer ao jogador que algo funciona antes de abrir a foto com Read na mesma resposta e nomeá-la.
- Nenhum governador automático de qualidade: ele muda a cena no meio da medição.

## 7. Com o jogador

Português do Brasil, curto, só fatos. Sem estimativa de prazo e sem "não dá": o que não couber no orçamento muda
de técnica, não de meta. Ele não quer fotos nem relatórios intermediários; quer o jogo pronto. Ao fim de cada
bloco de integração, uma linha: o que entrou em `main`, o que foi devolvido e por quê. Ao terminar tudo (§2):
build empacotado, caminho do pacote, e `docs/ESTADO.md` com "pronto" e a data.

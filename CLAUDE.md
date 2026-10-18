# Roadcraft 5

Jogo de construir cidades no navegador e no Steam (TypeScript, Vite 8, three.js r186 `WebGPURenderer` + TSL,
Electron 44). Meta do produto: **a aparência e os recursos do Roadcraft, abrindo e rodando cidades de 10 a 24 km
como o motor abre hoje.** Fale com o jogador em português do Brasil. Commits em português. Nunca dê push sem um sim.

@docs/ESTADO.md

- `npm run dev` (Vite com COOP/COEP, porta 5173) · `npm run build` = `tsc && vite build` · `npm test` =
  `node --test test/*.test.ts` · `node tools/fotos.mjs` = 4 fotos padrão com a GPU (rua, bairro, cidade, noite),
  sobre `dist/` · `node tools/verificar.mjs` = 146 verificações dentro do jogo.
- Documentos: `docs/ARQUITETURA.md` (o motor e por que ele escala), `docs/RECURSOS.md` (a lista do que o jogo
  tem que ter, com estado), `docs/LICOES.md` (o que destruiu as quatro versões anteriores; não repetir),
  `docs/PESQUISA-CIDADE-GRANDE.md` e `docs/PESQUISA-WEB-2026-10-18.md` (fontes). Os `docs/historico-*` são os
  registros dos projetos antigos, só para consulta.

## O que é verdade neste projeto
- **Dizer que funciona exige ter visto.** "Pronto" é: tsc limpo, testes verdes, foto aberta com Read nesta mesma
  resposta mostrando a coisa funcionando, e o nome do arquivo da foto na mensagem. Sem foto é "compila, não vi".
- **Medir é contar, não cronometrar.** Chamadas de desenho, triângulos, bytes, malhas vivas, alocações por quadro,
  mensagens de worker (`game.stats()`, `?perf`). Tempo de GPU só com a máquina livre e sempre com o número de
  antes ao lado; nunca sozinho, nunca comparado entre cenas diferentes.
- **Nada por quadro, por edição ou por passo da simulação cresce com o tamanho da cidade.** Só com o que está
  perto da câmera. Consulta é por raio ou retângulo no índice espacial, ou por lista mantida. Proibido "amortizar"
  (fatiar um trabalho de mapa inteiro por quadros): isso esconde o custo até a cidade crescer.
- **Nenhum objeto JS por entidade numerosa.** Prédio, nó, trecho, veículo, pedestre, item, instância: índice em
  tabela SoA (`core/table.ts`). O registro é pequeno e tudo o que se desenha é derivado dele, em worker.
- **Toda edição é um comando com inverso** (`core/commands.ts`), marca células sujas por tipo e só elas são refeitas.
- **Um commit por mudança, com o antes e o depois no texto** (contagens, foto). Nada "temporário só em DEV" entra
  no repositório. Reverter é a exceção que exige dizer o que se aprendeu.
- **Qualidade visual nunca cai em silêncio:** mudança que altera a imagem vem com foto antes e depois nas
  mesmas vistas (`tools/fotos.mjs`). Trocar detalhe por nível mais grosso só se a foto 1:1 na distância de
  troca for igual.
- Este arquivo muda só quando o jogador mandar mudar as regras. Fatos (estado, caminhos) quem mexer atualiza.

## Como o trabalho se divide
- Sessões paralelas, cada uma num worktree próprio e num conjunto de arquivos próprio; nunca duas no mesmo
  arquivo. Integra em `main` quem abriu a sessão, depois de ler o diff inteiro e rodar build, testes e fotos.
- Agente de pesquisa é só leitura. Agente que escreve código trabalha no worktree dele e entrega commit + foto.
- Antes de uma técnica nova no three.js r186, leia a fonte em `node_modules/three/src` e `examples/jsm`.

## Armadilhas já pagas (o resto em `docs/LICOES.md`)
- Profundidade invertida: `polygonOffset` POSITIVO puxa para a câmera; o céu precisa de `renderOrder = -1000`.
- TRAA: usar `render/traa.ts` (o do three r186 trata toda câmera como ortográfica e a imagem treme). Materiais
  que montam a posição em `positionNode` chamam `withPrevious(m)` ou a velocidade sai errada.
- `RenderPipeline.outputNode` não devolve o que você pôs: compare com o seu próprio campo, senão o pipeline é
  refeito todo quadro.
- Ids vêm de lista livre: laço sobre "vítimas" pula ids criados durante o laço.
- O sol anda em degraus de 0,2°: luz girando todo quadro derrota o snapping das cascatas.
- Registro npm bloqueado nesta máquina: `.npmrc` aponta para `registry.yarnpkg.com`; se também falhar, copie
  `node_modules` de um projeto irmão com o mesmo lockfile.
- `erasableSyntaxOnly`: sem enums e sem parameter properties (o Node roda os `.ts` dos testes direto).
- Playwright: o Chromium baixado não abre nesta máquina; use `channel: 'chrome'`. Nunca o painel do app.

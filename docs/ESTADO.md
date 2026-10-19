# Estado do trabalho (reescrever a cada mudança; entra sozinho em toda sessão e depois de toda compactação)

Atualizado: 2026-10-18, 22h35.

## Integrado em `main` (quem integra: a sessão coordenadora, depois de tsc, testes, `npm run budget` e fotos)
- 20h25: interface do Roadcraft inteira (5 commits, merge `b466b35`); luz e pós (`5ac9b07` + contraste `f475137`);
  vias item 2 (`d73736e`); `npm run budget` com linha de base (`f8099a1`). Visto no teste e devolvido à sessão de
  vias: céu do horizonte ainda claro na vista de rua baixa. As outras frentes continuam nos ramos `claude/*`.
- 21h05: pessoas itens 1-2 (`99572ce`), prédios itens 1-3 (`85cc319`), funcionalidades itens 1-9 (`989d4b3`),
  interface: nome Roadcraft e Sobre com licenças (`933af65`); núcleo, Electron e ferramentas em inglês, limite do
  bairro 2× e `PROMPT-CONTINUAR.md` (`d13353b`). Verificado em `main`: tsc limpo, 95 testes, `npm run budget` ok
  nas 5 vistas; `verificar.mjs` 136/146: 9 falhas do inspetor de cruzamento devolvidas à interface, 1 de
  crescimento (densidade alta) devolvida a funcionalidades. Pesquisa dos prédios em andamento
  (`docs/PESQUISA-PREDIOS.md`).
- 21h25: pessoas completas, itens 3-5 (ocupantes, criador de pessoas com ação em `game.api`, objetos na mão,
  grupos), budget ok; interface: Sobre com licenças lidas da build, painéis ligados às ações de funcionalidades,
  inspetor de via com nome e numeração (`b5a35b4`); 98 testes. Causa das 10 falhas do `verificar.mjs` achada
  pela interface (o roteiro 2 fica sem dinheiro com a economia nova: `a.road` recusa e `setJunction(-1)` quebra)
  e passada a funcionalidades para corrigir.
- 21h40: vias/terreno/luz completas, itens 3-5 (árvores de cards, grama em tufos, relevo de rocha; veículos do
  Roadcraft com rodas, vidro, escapamento; mobiliário automático) (`8a27c71`); budget ok (cidade 479 chamadas,
  antes 548). Devolvido à sessão de vias: ocupantes sob o carro (alturas em `people/occupants.ts`), céu do
  horizonte, grama nos lotes, foto de ponte e túnel, inglês nos arquivos dela.
- 22h00: interface com o criador de pessoas, "remover postes" e zoom/centro no painel Câmera (`170941a`); prédios
  com relevos finos só na camada de detalhe (`b1d7fe7`, bairro 2,27 M tri); pesquisa dos prédios commitada
  (`docs/PESQUISA-PREDIOS.md`, plano em 12 passos, entregue à sessão de prédios junto com o defeito do pool de
  props: cada peça de fachada processa ~3.624 vértices); `PROMPT-ANALISE.md` (contexto + pedido de análise).
  98 testes, budget ok.
- 22h15: produto (`9482eff`): `npm run package:win` (executável Roadcraft, 168,6 MB em zip; conferido pela sessão
  coordenadora: cidade de 10 km pronta em 15,8 s no `.exe`, 4 fotos em `test-results/fotos-pacote/`),
  `npm run package:web` (zip de 22,5 MB, ainda exige Node), `fotos:pacote`/`fotos:navegador`. Visto no teste:
  na vista cidade os prédios longe são caixas lisas de cor chapada (devolvido à sessão de prédios).
- 22h35: funcionalidades completas (`957a471`): transporte com passageiros, nós impossíveis contados, roteiros em
  modo livre (correção das 10 falhas), pose com id de aparência (**falso pronto**: o id nunca é lido, só 16 pedestres
  diferentes; defeito C20 da lista de 2026-10-19). Em `main`: tsc limpo, 102 testes,
  **`verificar.mjs` 146/146**, budget ok (o 146/146 não pega os defeitos críticos da lista de 2026-10-19: G1). Frentes novas: funcionalidades → escala 16/20/24 km (`docs/ESCALA.md`);
  ex-pessoas → zip sem Node e teste de jogador no `.exe` (`docs/DEFEITOS.md`); interface → ligar ações novas,
  nós impossíveis, painel de linhas, textos nos dicionários; vias → cancela e placas de nome.

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
- Conferências no jogo com pasta de usuário própria (nunca o save do jogador), cada uma sai com código 1 se algo
  falha: `node tools/check-save.mjs` (salvar, falhar, carregar, fechar e reabrir) · `node tools/check-user-data.mjs`
  (as execuções de teste não tocam a pasta do jogo) · `node tools/check-interface.mjs [cenário…]` (um cenário por
  defeito da interface, clicando os botões e apertando as teclas de verdade). Todas sobre `dist/` (`npx vite build`
  antes). `node tools/textos.mjs` confere os dois dicionários.
- Nunca o navegador embutido do app. Playwright só com `channel: 'chrome'`.

## Frentes abertas (uma sessão por frente, cada uma num worktree e nos seus arquivos; quem integra em `main` lê o
## diff inteiro, roda build + testes + fotos e confere as 4 vistas)
| Frente | Arquivos | Estado |
|---|---|---|
| Interface do Roadcraft (dock, barra, painéis, textos, CSS) | `src/ui/**` exceto `creator.ts`, `index.html`, ligação em `game.ts` (`hudActions`, teclas) | ✅ pronta no ramo `claude/interface-roadcraft-da7d52` (5 commits, a integrar): 1 barra + dock de 7 categorias + gavetas; 2 menu, camadas, simulação, câmera, ajuda F1, saúde F9, opções, bússola, velocidades; 3 inspetores de via/nó/cruzamento com conectores, catálogo e editor de seção, painel do prédio com ponto de extensão `.v2-building-slot`; 4 tabela única de teclas `src/ui/keys.ts`, dicas, avisos, toque; 5 tela inicial. Dicionário único (chaves do Roadcraft + `src/ui/lang/engine.*`), `node tools/textos.mjs` confere. Fotos: `test-results/interface/*.png` (`node tools/fotos-interface.mjs`) e `test-results/depois/0{1..4}-*.png`. Falta (precisa de outra área): ferramentas do Roadcraft sem equivalente no motor ficam desabilitadas com "em construção" (curvar lado do lote, dividir por linha, remover poste, abas Modelos/Fachada/Telhado/Peças/Cores do construtor); aviso de nós impossíveis (o motor não conta); leitura de zoom/centro no painel Câmera; avisos e dicas escritos em português em `src/tools`, `src/world` e no resto de `game.ts` passam por `loose()` (tabela `src/ui/lang/legacy.ts`) em vez de chaves; `ItemTool` não expõe se há traço de muro em andamento. Depois da integração (ramo da interface, a integrar): nome Roadcraft no executável e no aviso de mapa inválido (`nome/inicio.png`); Sobre com as licenças dos pacotes de pessoas lidas da build (`nome/sobre-licencas.png`); painéis já ligados às ações opcionais da frente de funcionalidades (dividir por linha, curvar lado, reforma, endereço, desgaste, pintura do mapa, nome gerado da rua; acendem quando o ramo entrar em main; `nome/acoes-lotes.png`, `nome/acoes-predio.png`). Na integração do ramo de funcionalidades, ficar com `setBuilding({fn, zone, floors, arch})` em `select()`. A frente de pessoas ainda não publicou ações (criador de pessoas, docas): ligar quando aparecerem. Depois: criador de pessoas da frente de pessoas em Paisagem > Pessoas (sexo, idade, roupa em cartões, cores de cima/baixo/cabelo, altura, 1 a 20, parada/andando/em roda, objeto na mão; `nome/criador-pessoas.png`); Remover postes e zoom/centro no painel Câmera (`nome/remover-postes.png`). Ainda "em construção": abas Modelos/Fachada/Telhado/Peças/Cores do construtor (sessão de prédios) e aviso de nós impossíveis (o motor não conta). verificar.mjs: 136 ok; as 10 falhas são do roteiro sem dinheiro após a economia nova (com a sessão de funcionalidades). |
| Prédios com o visual do Roadcraft + construtor completo | `src/jobs/buildingGen.ts`, `src/render/city.ts`, `src/render/inside.ts`, `src/world/arch.ts`, `src/world/design.ts`, `src/ui/creator.ts`, `data/lots-roadcraft` | em andamento (sessão predios-roadcraft). Pronto: item 1 (13 acabamentos em texture array, `test-results/depois-1/`), item 2 (caixilho, moldura, frisos, rufos, brises, pilastras, portas, guarda-corpos; peças de fachada como mobiliário 8..15 no pool de props, `test-results/depois-2/`), item 3 (9 padrões de fachada por assinatura a 90 m, 38 projetos do Roadcraft no catálogo `CATALOG` de `world/design.ts` e como marcos a 22 % das torres, nunca repetidos a menos de 250 m; esquina com jardim, portões, muros de divisa, garagem e meia-ala em encosta, muro de arrimo, docas; `test-results/depois-3/`). Contagens depois do item 3: chamadas 461/186/548/478 (antes 461/186/548/477), bairro 2,23 M tris (antes 1,25 M). Falta: item 4 (construtor), item 5 (desgaste/reforma), tradução para inglês dos comentários de `jobs/buildingGen.ts` e `render/city.ts` |
| Pessoas do Roadcraft (MakeHuman cozido, LOD, paletas na GPU) | novo `src/render/people/**`, `public/models/people`, gancho em `render/vehicles.ts` (só o ramo das pessoas) | ramo `claude/pessoas-roadcraft-90b367`. Feitos: 1 cozimento (`npm run cook:people`, 32 variações, 11 clipes, 29,5 MB), 2 desenho (3 níveis, 1 chamada por nível, sombra só do nível 0; rua +4 draws +0,05 M tri, multidão a 20 m +6 draws +1,4 M; fotos `test-results/depois-c/09-perto-a.png`, `11-perto-noite-a.png`). 3 ocupantes (piloto da moto com capacete visível; motorista e passageiros pela lotação prontos atrás de `people.seatedInCabins`, que a frente de veículos liga quando o vidro mostrar o interior; fotos `test-results/item3/13-moto.png`, `15-carro-sentados.png`). 4 criador (lógica em `src/render/people/creator.ts`; `game.api.people(x, z, opções)` com desfazer e `game.api.peopleCatalog()` para a tela da interface; foto `test-results/item4/17-criador-perto.png`). 5 objetos na mão (celular, copo, jornal, sacola; guarda-chuva com chuva) e grupos em roda (fotos `test-results/item5/18-chuva.png`, `item5b/19-objetos.png`). Ciclista na ciclovia e pés na calçada em declive vistos (`test-results/fecho/20-bicicleta-2.png`, `21-declive-1.png`). ✅ em main. Pedidos repassados: id de pessoa com mais bits na pose (funcionalidades), `seatedInCabins` (vias/veículos) |
| Vias, terreno, vegetação, veículos, luz e pós com o visual do Roadcraft | `src/jobs/roadMesh.ts`, `roadPaint.ts`, `src/render/{roads,terrain,props,propMeshes,impostor,vehicles,post,scene,weather,particles,cloudPuffs}.ts`, `src/jobs/props.ts`, `src/world/ground.ts` | em andamento (ramo claude/vias-terreno-luz-dbc412). Feito: 1 luz e pós (ACES 0,92, grade do Roadcraft + CAS, céu como environment PMREM refeito a cada 2° de sol; contagens iguais nas 5 vistas; fotos test-results/1-luz/*, noite 1-luz-c); 2 vias (sarjeta, bocas de lobo, bueiros, meio-fio em blocos, calçada em painéis no espaço da via, piso tátil, zebra regional e gasta, placas em atlas, semáforos com lentes dos dois lados, vigas/pilares/coroa de ponte e muros de ala; fotos test-results/2-vias; pontes e túneis sem foto: a cidade gerada não tem). 3 vegetação e chão (árvores de cards do Roadcraft: mista, cipreste, carvalho, palmeira, arbusto; perto/meio/impostor octaédrico refotografado com os cards; grama em tufos perto da câmera, 1 chamada; relevo fino de rocha; níveis de peça vazios não desenhados: cidade 548 → 479; fotos test-results/3-veg). 4 veículos (carroceria com borda arredondada, rodas com pneu, calota e raios que rolam pela distância e esterçam pela curva no vertex shader, vidro liso refletindo o céu, fumaça do escapamento como partícula só no shader; foto test-results/4-veic/12-carro). 5 mobiliário automático (básico: hidrantes; completo: + correio e orelhão no comércio, floreiras nas travessias, lixeira em cada travessia, banco e lixeira em rua residencial; foto test-results/5-mobiliario/08-rua-detalhe). Os 5 itens estão commitados; npm run budget ok em todas as vistas. Falta: ocupantes cozidos nos carros (as alturas de assento de render/people/occupants.ts não batem com os carros; nota na pasta compartilhada), tufos de grama sobre os lotes, pontes e túneis sem foto (a cidade gerada não tem) |
| Funcionalidades que faltam ou estão abaixo do Roadcraft (`docs/RECURSOS.md`) | `src/tools/**`, `src/sim/**`, `src/roads/**`, `src/world/{lotEdit,transit,items,growth,world}.ts`, `src/save.ts`, `src/jobs/{lots,storage}.ts`, `test/**` | em andamento (ramo `claude/funcionalidades-roadcraft-8bee43`, com main mesclado): verificar.mjs 146/146, 100 testes. ✅ com foto (`test-results/recursos/`): economia das vias (`economia.png`); lote em polígono, dividir por linha, curvar lado (`lote-poligono.png`); desgaste e reforma, endereço métrico (`desgaste.png`); nomes de rua, placa = regra, pintura salva com o mapa; crescimento em sequência, 3 andares acima do vizinho, praça por bairro (`crescimento.png`); reparo de mapas antigos e quarentena (`reparo.png`, `quarentena.png`); manobras Reeds-Shepp: vaga, saída, caminhão de ré na doca, meio-fio (`manobra-*.png`); ônibus de ida e volta, cor da linha, cancela na passagem de nível (`transporte-cancela.png`); nós impossíveis (`nos-impossiveis.png`); pose com id de aparência de 16 bits no índice 10 (pedido da sessão de pessoas). Falta de outras sessões: prédio e mureta seguirem o polígono e visual do desgaste (prédios, formato em `jobs/protocol.ts`); desenho da cancela e das placas de nome com `streetNameAt` (vias); ligar as ações novas de `tools/featureActions.ts` (interface). |
| Produto (executável Windows, zip para navegador, fotos do pacote) | `tools/package.mjs`, `tools/serve.mjs`, `electron/**`, `src/steam.ts`, `jogar.*`, `package.json` (scripts) | ✅ 4 itens no ramo `claude/pessoas-roadcraft-90b367`. 1 executável: `npm run package:win` → `out/Roadcraft-win32-x64` (370 MB; zip 168,6 MB; Electron 245,6 MB, pessoas 29,6 MB, jogo 2,1 MB), ícone, título Roadcraft, `steam_appid.txt` 480, instância única; gera, salva, fecha e reabre o save (fotos `test-results/pacote/a-salvo.png`, `c-reaberto-enxuto.png`). 2 navegador: `npm run package:web` → `out/Roadcraft-navegador.zip` (22,5 MB; pasta 32,3 MB: pessoas 29,6, jogo 2,1, licenças 0,7) com `dist/`, `tools/serve.mjs`, `jogar.bat`/`jogar.sh` (precisa de Node); no Chrome `crossOriginIsolated=true` (fotos `test-results/fotos-navegador/01..04`). 3 fotos do que vai para o jogador: `npm run fotos:pacote` (o .exe de `out/`) e `npm run fotos:navegador` (a pasta do zip pelo próprio serve.mjs no Chrome), cada uma com perfil próprio (fotos `test-results/fotos-pacote/01..04`). 4 tamanhos: .exe zipado 168,6 MB (pasta 370 MB: o binário do Electron 44 é 235 MB, dxcompiler 25 MB, licenças do Chromium 20 MB, resources.pak 12 MB, ICU 11 MB; nosso: pessoas cozidas 29,6 MB, código do jogo com three.js 2,1 MB, steamworks.js 2,5 MB); navegador zipado 22,5 MB (pessoas 29,6 MB, código 2,1 MB, licenças 0,7 MB). O que dá para cortar depois: as paletas das pessoas (24,9 dos 29,6 MB) em meia precisão |

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

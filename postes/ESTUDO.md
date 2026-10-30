# Postes do Roadcraft 4.0 — estudo para o port

Data: 2026-10-30. Pedido do dono: portar os postes e o modo de criação deles em caminho, com o visual do Roadcraft e
sem os problemas de otimização e desempenho do 4.0.

## Fontes
- Código do 4.0 lido (relatório de pesquisa conferido por amostragem: `world/utilities.ts:9,30,45,57,59`,
  `render/utilities.ts:242`): `editor/poles.ts`, `editor/poleRoutes.ts`, `editor/roads/powerLine.ts`,
  `world/utilities.ts`, `world/poleLines.ts`, `world/lineEnds.ts`, `render/utilities.ts`, `render/poleBake.ts`,
  `render/poleLayer.ts`, `render/poleCells.ts`, `render/poleStores.ts`, `world/roads/tuning.ts`.
- 4.0 rodando num mapa vazio ("Novo mapa"), perfil próprio do Chrome; a linha foi posta pela API do documento
  (`doc.addPole`/`addPoleSpan`), a mesma que a ferramenta usa ao confirmar o traçado.

## Fotos
| Foto | O que mostra |
|---|---|
| `00-mapa-vazio.jpg`, `01-novo-mapa.jpg`, `02-gaveta-vias.jpg` | mapa vazio, gaveta de vias (mobiliário "Completo") |
| `03-rua-desenhada.jpg`, `04-rua-perto.jpg` | **defeito do 4.0**: a rua desenhada por arrasto existe no documento (1 segmento, R$ 114 mil debitados, pessoas andando nela) mas não é desenhada, e a linha automática de postes não apareceu (0 postes) |
| `05-linha-urbana.jpg` | 5 postes urbanos a 38 m: madeira, cruzeta de 2 m sobre um lado, 3 isoladores, 3 fios primários + 2 secundários com flecha; transformador (lata cinza) no poste de id%5==3 |
| `06-topo-transformador.jpg` | de baixo: lâmpada no braço de 1,6 m, fios em parábola, sombra dos fios no chão |
| `07-poste-lampada.jpg` | mastro de madeira com textura de veio, cônico |
| `08-poste-cruzeta-costas.jpg`, `09-rural.jpg`, `10-de-cima.jpg` | cruzeta vista de trás; linha rural (cruzeta centrada); vista de cima |
| `11-noite.jpg` | noite: só os postes com lâmpada (alternados) acendem; poça de luz no chão |

## O que portar (resultado) e o que não repetir (desempenho)
- Visual: mastro 8,5 m cônico (r 0,18→0,11) de madeira; cruzeta 0,1×0,1 (urbano 0..2 m sobre a rua; rural −1..1);
  3 isoladores de porcelana; mão-francesa de aço; rack secundário (urbano); transformador em 1 de cada 5; lâmpada a
  1,6 m do eixo, 2 m abaixo do topo, com poça de luz; fios: flecha = min(1,4; 0,018·vão), parábola, 3 + 2 fios.
- Ferramenta: traçar por cliques/arrasto em trechos; postes só na calçada (0,175 m atrás do meio-fio); espaçamento
  38 m (18..80) em vãos iguais por trecho; cantos por Ramer-Douglas-Peucker 1,5 m; fugir das faixas de pedestre;
  reaproveitar poste existente a 6 m; travessia de rua só quando encurta (custo +8 m); lâmpadas nenhuma/alternada/todas;
  urbano/rural; Shift+clique remove; Esc encerra; linha automática nas ruas novas (lado esquerdo, recuo 4 m nas bocas).
- Não repetir: um bloco de 1 km refeito a cada edição perto; `kerbward` por poste em cada refação; percorrer todas
  as peças de todos os blocos por vista; 11 lojas de peça + buckets de fio por bloco (muitas chamadas de desenho);
  prévia reconstruída do zero a cada movimento do mouse; dados duplicados na CPU.

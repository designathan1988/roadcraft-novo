# Paridade com o roadcraft-3.0

Referência: `../roadcraft-ref` (clone de https://github.com/designathan1988/roadcraft-3.0, commit `364ec67`).
Fonte principal: os textos da interface (`src/ui/i18n/pt-BR.ts`, 1.735 linhas) e o painel `src/ui/v2/shell.ts`.
Situação: ✅ pronto · 🟡 parcial (o que falta) · ❌ falta.

Verificação no jogo de verdade: `npx vite build && node tools/verificar.mjs` roda os roteiros de
`scripts/verificacao/` (146 verificações: cada ferramenta pelo botão e clique no mapa, e cada ação conferindo o
efeito no mundo, desfazer/refazer, salvar/carregar, exportar/abrir, painéis) sem nenhum erro no console. Última
rodada: 146 ok, 0 falhas. O que não cabe num roteiro (aparência) tem foto na conversa com o dono.

Os três 🟡 (automático pelo fluxo, lote em polígono, fachada vão a vão) foram aceitos pelo dono como estão em 16/10/2026. Save da versão 5 aberto na versão 6 dentro do jogo: mesmas vias, prédios e dinheiro (fotos oo_save_v5 e oo_save_aberto).

## Vias

| Funcionalidade | Referência | Aqui | Critério de pronto |
|---|---|---|---|
| Via reta encadeada | editor/roadTool.ts | ✅ | Clico, clico: o trecho sai e a próxima começa do fim. |
| Curva por três cliques | editor/roadTool.ts (`palette.alignment.curve`) | ✅ | Ferramenta Curva: começo, controle e fim desenham a curva. |
| Traçado livre (arrastar) | editor/roadPath.ts (`hint.road.free`) | ✅ | Na Via, modo Livre: arrasto e a via segue o cursor em trechos curvos. |
| Encaixe: ângulos 90/45/15° e grade de 1 m | editor/snap.ts (`v2.snap.*`) | ✅ | Com o encaixe ligado, a via desenhada sai em múltiplos de 15° e pontos inteiros. |
| Quarteirões de uma vez | editor/blocks.ts (`palette.blocks.*`) | ✅ | Escolho colunas, linhas, quadra e giro, clico: a grade de ruas aparece de uma vez (desfaz inteira). |
| Altura da via, pontes, viadutos, túneis | editor/roadTool.ts | ✅ | Page Up/Down antes de desenhar: a via sai elevada ou em túnel. |
| Corte: talude ou muro de arrimo | `cutSides.*` | ✅ | Via rebaixada com "Muro": a trincheira tem paredes verticais; com "Talude", rampa de terra. |
| Catálogo de perfis com abas e modelos | ui/roads | ✅ | Abas Ruas/Avenidas/Rodovias/Especiais/Trilhos/Meus modelos. |
| Editor de seção transversal | ui/roadSectionEditor.ts | ✅ | Personalizar…: mudo faixa por faixa e salvo como modelo. |
| Trocar perfil (rua inteira com Shift) | `tool.upgrade` | ✅ | Ferramenta Perfil, clique numa via: troca; Shift: a rua inteira. |
| Conta-gotas | `profile.drawWith` | ✅ | Alt+clique numa via: a ferramenta passa a desenhar com aquele perfil. |
| Mover nó | editor/nodeMover.ts (`tool.move`) | ✅ | Arrasto um nó: as vias ligadas acompanham; desfaz volta. |
| Dividir via | `tool.split`, `inspector.splitMiddle` | ✅ | Clico numa via: ela vira duas com um nó no ponto. |
| Unir vias alinhadas | `inspector.joinAligned` | ✅ | Num nó de duas vias iguais, "Unir" deixa uma via só. |
| Inverter mão única | `inspector.reverse` | ✅ | No inspetor da via de mão única, "Inverter": as setas e o trânsito trocam de sentido. |
| Duplicar via (paralela) | `inspector.duplicate` (Ctrl+D) | ✅ | No inspetor, "Duplicar": uma via igual aparece paralela, ao lado. |
| Inspetor da via: dados ao vivo | ui/inspector.ts (`inspector.*`) | ✅ | Clico numa via: vejo perfil, faixas, comprimento, veículos agora, velocidade média e fila. |
| Faixa de pedestres no meio da quadra | `inspector.addZebra`, `addSignalCrossing` | ✅ | No inspetor da via, "Faixa zebra": a faixa é pintada e os carros param para quem atravessa. |
| Retorno no canteiro | `inspector.addUturn*` | ✅ | Avenida com canteiro: "Retorno" abre o canteiro e carros fazem o retorno. |
| Estacionamento por lado | `inspector.parkingLeft/Right` | ✅ | No inspetor: escolho vagas à esquerda/direita e a via muda sem trocar de perfil manualmente. |
| Rotatória com raio | editor/roundabout.ts | ✅ | Clico: rotatória; [ e ] mudam o raio. |
| Mobiliário automático das vias (completo/básico/nenhum) | `roadFurniture.*` | ✅ | Escolho "Nenhum": vias novas saem sem postes, bancos e árvores na calçada. |
| Estilo de pintura (Brasil/EUA/Europa/Clássica) | `menu.paint`, `paint.*` | ✅ | Troco para EUA: a linha central fica amarela. |
| Teclas da via reconfiguráveis | `roadKeys.*` | ✅ (nas Opções) | Nas opções, troco a tecla de subir a via e ela passa a valer. |
| Regras de construção com motivo | editor/editRules.ts (`hint.rule.*`) | ✅ | Via sobre outra ou ângulo fechado: recusa com o motivo no aviso. |
| Economia: preço por largura e comprimento, devolve ao demolir | editor/roads/economy.ts | ✅ | O caixa desce ao construir e volta metade ao demolir. |
| Demolir por retângulo e demolir qualquer coisa | editor/bulldozer.ts (`gesture.bulldoze.box`) | ✅ | Demolir: clique remove via, prédio, item ou muro; arrastar remove tudo no retângulo. |
| Balão de retorno na ponta sem saída | world/junction/bulb.ts | ✅ automático em rua de mão dupla estreita (asfalto ≤ 6,5 m de cada lado, trecho ≥ 40 m) sem outra via a menos de ~16 m (`roads/junction.ts` `bulbAt`, a mesma regra na página, nos workers e na simulação; o retorno dos carros vai até o círculo; relevo assentado no disco) | Rua sem saída: o asfalto abre num círculo com meio-fio e calçada; os carros dão a volta nele. |
| Placas automáticas de velocidade | world/roads/derivedSigns.ts | ✅ em todo trecho de mais de 60 m, 14 m depois da boca, para quem sai (antes só nas avenidas de 60 km/h) | Rua local longa: placa de 30/40 logo depois da esquina. |
| Transição de largura (1 para 8) | world/junction/transition.ts | ✅ via que segue reta (dobra < 30°) mudando de largura: rampa de 1 para 8 da maior mudança de meia largura (calçada ou asfalto), no mínimo 9,6 m, metade de cada lado (`roads/geometry.ts` `armRetreats`, a mesma conta na malha, nos lotes, nas peças e na simulação) | Avenida de 4 faixas que vira rua de 2: as bordas afinam numa rampa longa, sem degrau. |
| Desgaste do asfalto pelo uso | render/wear.ts | ✅ por trecho, contado na simulação (micro e meso: o mapa inteiro envelhece) e lido pelo shader no canal B da textura de ocupação: trilha das rodas escurece, o asfalto perde o preto, gasto ganha remendos; trecho novo começa novo (o campo de 1 m do roadcraft não cabe em mapas de 24 km) | Avenida movimentada fica gasta depois de um tempo; rua nova, preta. |

## Cruzamentos

| Funcionalidade | Referência | Aqui | Critério de pronto |
|---|---|---|---|
| Controle (auto, semáforo, placas, pare, preferência, minirrotatória, sem) | `junction.control.*` | ✅ | Inspetor do cruzamento: escolho e os carros obedecem. |
| Regra de cada braço | `junction.legs` | ✅ | Escolho Pare num braço: só ele para. |
| Semáforo: adaptativo/fixo, verde por fase, defasagem, onda verde, ônibus | `junction.*` | ✅ | Mudo o verde da fase 1 e o tempo muda no semáforo. |
| Movimentos proibidos | `junction.movements` | ✅ | Proíbo esquerda: ninguém vira à esquerda ali. |
| Altura do nó | `junction.raise/lower` | ✅ | Subir 0,5 m: o nó e as vias sobem. |
| Conexões de faixa manuais | `connectors.*` | ✅ | Clico numa faixa que chega e liga/desligo as saídas; a seta pintada e os carros seguem a escolha. |
| Automático pelo fluxo, com trava | `junction.autoChoice`, `junction.locked` | ✅ a simulação mede o fluxo por braço (micro e meso, média de 5 min) e, depois de 10 min, põe semáforo onde a via principal e a secundária passam muito e tira o que a importância das vias punha onde quase ninguém passa (`sim/advisor.ts`, limiares do roadcraft ×2, histerese de 80%, 10 min entre trocas); "Travar esta escolha" fixa o controle e o automático esquece o que mediu. A página aplica a troca (`autoControl` → `RoadNetwork.setFlow`: pintura, placas, cabeças de semáforo e inspetor) | O automático diz o que escolheu e por quê; "Travar" fixa a escolha. |

## Trânsito

| Funcionalidade | Referência | Aqui | Critério de pronto |
|---|---|---|---|
| Carros com IDM e troca de faixa | sim/drive | ✅ | Carros seguem, freiam e trocam de faixa. |
| Tipos de veículo | sim/vehicles/archetypes.ts | ✅ sedã, hatch, SUV, van, picape e moto com piloto (comprimento próprio na simulação; estilo nos bits 4-6 da cor), ônibus, caminhão; bicicletas com ciclista nas ciclofaixas (10% das viagens que saem perto de uma; passeio pelas ciclofaixas, de preferência em frente, atravessando o cruzamento como um carro; eventos no mapa todo e posição só perto da câmera, no mesmo esquema dos pedestres) | Na rua aparecem os seis carros e a moto, cada um com o seu tamanho na fila. |
| Luz de freio e setas vindas da simulação | render/vehicleSignals.ts | ✅ freio ao frear forte ou parado (acende também de dia), seta na conversão (dentro do cruzamento ou a 45 m com a saída escolhida) e na troca de faixa, piscando a 1,5 Hz; bits × 65536 no campo tipo/cor da pose | Carro chegando para virar à esquerda: a seta esquerda pisca e a lanterna acende quando ele freia. |
| Sombra de mancha nos veículos | render/blobShadows.ts | ✅ nos veículos entre 90 m (fim da sombra das cascatas) e 200 m: mancha escura 3 cm acima da pista com a borda pontilhada (o TRAA suaviza), no mesmo material e na mesma chamada | De longe os carros assentam na pista, sem parecer flutuar. |
| Ocupantes nos veículos | render/occupants.ts | ✅ silhuetas nas janelas: motorista em carro e caminhão, passageiros do ônibus pela lotação da simulação (0-16 lugares; bits 3-5 das luzes na pose) | Ônibus cheio passa com gente em todas as janelas; vazio, só o motorista. |
| Estacionar na guia ao chegar | sim/agents/parking.ts, vehicles/kerbStops.ts | 🟡 o carro que chega ao destino numa faixa da direita com estacionamento ao lado sai da fila (quem vem atrás passa), freia encostando na vaga com a seta da direita, fica parado 3 s e some; quem começa a viagem a até 350 m da câmera numa faixa com vagas sai da vaga (parado na guia, seta da esquerda, entra na faixa com folga atrás). Não manobra com A* (o roadcraft faz). Simulação neutra: centro 13,7-14,5 km/h antes e depois, mesmo passo | Carro chegando numa rua com vagas encosta e para na vaga. |
| Demanda (baixa/normal/pico), % de tráfego e de pessoas | `sim.demand`, `sim.traffic` | ✅ | Opções: Pico aumenta o número de carros. |
| Pausar a simulação (Espaço) e velocidade | `sim.pause`, `v2.do.pause` | ✅ | Espaço: tudo para (carros e relógio); de novo, volta. |
| Mapa de congestionamento | `sim.congestion` | ✅ | K: vias coloridas pela lentidão. |
| Métricas: viagens, chegadas recusadas, velocidade, parados | `sim.metric.*` | ✅ | O painel mostra viagens concluídas, parados e velocidade média. |
| Seguir veículo | — (aqui é a mais) | ✅ | C: a câmera vai atrás de um carro. |
| Pedestres nas calçadas | sim/peds | ✅ | Pessoas andando nas calçadas perto da câmera. |
| Ônibus: pontos, linhas, veículos por linha | `transit.*` | ✅ | Faço uma linha com 3 pontos: ônibus param neles. |
| Terminal de ônibus | `transit.tool.terminal` | ✅ | Marco um ponto como terminal: os ônibus esperam e dão a volta ali. |
| Trem e metrô: trilhos, estações, linhas | `transit.tool.*Track/*Station` | ✅ | Trilho + estações + linha: o trem para nelas. |

## Zonas e lotes

| Funcionalidade | Referência | Aqui | Critério de pronto |
|---|---|---|---|
| Zonas (res., com., ind., misto) e densidade | `zone.*` | ✅ | Pinto residencial alta: torres crescem. |
| Pincel de zona | `zone.brush` | ✅ | Arrasto ao longo da via e a zona aparece. |
| Zonear a quadra inteira | `zone.fill` | ✅ | Modo Quadra: um clique zoneia todos os lotes da quadra. |
| Desenhar lote (retângulo) | `zone.lot.shape.rect` | ✅ | Três cliques: o lote e o prédio aparecem. |
| Lote em polígono | `zone.lot.shape.polygon` | 🟡 o lote vira o menor retângulo que contém o polígono (prédios são retangulares) | Clico 5 pontos e Enter: lote de 5 lados com prédio dentro. |
| Mover cantos do lote | `zone.lot.edit` | ✅ | Arrasto um canto: o lote muda e o prédio é refeito. |
| Dividir lote (lado a lado, frente e fundos, N partes) | `zone.lot.split`, `zone.split.*` | ✅ (falta "por linha") | Divido em 3: viram três lotes, cada um com seu prédio. |
| Juntar lotes | `zone.lot.join` | ✅ | Clico em dois vizinhos: viram um lote com um prédio maior. |
| Apagar lotes e construções | `zone.lot.delete` | ✅ | Clico num lote: some com o prédio; desfaz volta. |
| Definir frente do lote | `zone.lot.front` | ✅ | Clico num lado: o prédio vira de frente para ele. |
| Cores das zonas e grade no mapa | `zone.colours`, `v2.grid.toggle` | ✅ | Botão Grade: linhas de 64 m sobre o terreno. |

## Prédios

| Funcionalidade | Referência | Aqui | Critério de pronto |
|---|---|---|---|
| Vizinhos diferentes ao crescer | editor/zoning.ts (`unlikeness`) | ✅ o prédio novo escolhe, entre o estilo da semente e três alternativas, o mais diferente dos vizinhos a 30 m (estilo de arquitetura, altura, cor; quem está longe pesa menos); época do bairro calculada uma vez por lote (`world/arch.ts` `archFor`/`eraAt`), geração sem custo medível | Rua nova cresce sem dois prédios iguais lado a lado. |
| Marcos (catálogo de lotes nomeados) | lots/*.json | ✅ 12 projetos prontos (redonda de vidro, agulha de vidro, agulha art déco, octogonal de cobre, hexagonal de terracota, escalonada com jardim, U azul-marinho, chanfrada escura, onda branca, loft de tijolo, beaux-arts com alas, esquina rosa) dados a ~22% das torres comerciais de planta quase quadrada, nunca o mesmo a menos de 250 m (`world/design.ts` `LANDMARKS`, pelo caminho do criador) | O centro gerado tem torres de formas diferentes, sem marco repetido no mesmo bairro. |
| Caminho da porta até a calçada | sim/agents/lotDoors.ts | ✅ o piso do portão até a porta (casas e prédios residenciais, sobre a grade do quintal); metade dos pedestres que nascem perto da câmera sai de uma porta (a página manda as portas a 450 m quando a câmera anda 80 m ou a cidade cresce) e anda reto até a calçada do trecho mais perto, seguindo a rota dali | Casa com portão: um caminho de piso liga o portão à porta. |
| Crescimento automático nos lotes | world/buildings/cityBuildings.ts | ✅ | Zoneio e os prédios crescem sozinhos. |
| Editar andares, estilo e função | `builder.field.*` | ✅ | Prédio: + andares, estilo Art déco, função Escola. |
| Funções cívicas | `building.fn.*` (43 funções) | ✅ | Função inclui também biblioteca, museu, banco, hotel, rodoviária, cemitério etc. |
| Criador: planta (retângulo, L, U, círculo, hexágono, octógono, chanfrado) | `builder.tool.rect/shapeL/...` | ✅ | No criador escolho L e arrasto: o prédio sai em L. |
| Criador: volumes (empilhar, recuo, ala) | `builder.tool.stack/setback/wing` | ✅ andar recuado (volume menor empilhado em cima), planta em L/U e ala mais baixa de um lado ou dos dois (foto oo_alas) | "Andar recuado": um volume menor sobe em cima. |
| Criador: telhado (plano, terraço, 2 águas, 4 águas, 1 água, dente de serra) | `builder.tool.roof*` | ✅ | Escolho 2 águas: o telhado muda na hora. |
| Criador: cores e materiais | `building.finish.*`, `v2.build.colour` | ✅ | Escolho tijolo e uma cor: a fachada muda. |
| Criador: peças no telhado (caixa d'água, painéis, chaminé, agulha) | `builder.tool.solar/waterTank/...` | ✅ | Ligo caixa d'água: aparece no telhado. |
| Criador: modelos salvos e catálogo pronto | `builder.city.*`, `builder.quick.save` | ✅ | Salvo como modelo e coloco outro igual em outro lote. |
| Ver por dentro (andar por andar) | `inside.*` | ✅ | Ligo "Ver por dentro": o prédio é cortado no andar e vejo as salas; ↑/↓ muda o andar. |
| Fachada vão a vão, interior mobiliado, booleanas, referência 3D | `builder.tool.window/furn_*/block*/ref*` | 🟡 a fachada escolhe o tipo de janela do prédio inteiro (do acabamento, faixa de vidro, largas, estreitas, parede cega; foto oo_alas) e o interior aparece com salas acesas por andar. Não há edição janela por janela, móveis, corte booleano nem modelo 3D de referência: cada prédio é gerado de um registro pequeno em segundo plano, e guardar janela a janela ou móveis multiplicaria o tamanho do salvamento e o tempo de geração em cidades de 10 a 24 km | (prioridade baixa) |

## Terreno, paisagem e água

| Funcionalidade | Referência | Aqui | Critério de pronto |
|---|---|---|---|
| Elevar, rebaixar, alisar, nivelar | `terrain.*` | ✅ | Arrasto e o terreno muda. |
| Aplainar o mapa inteiro | `terrain.clear` | ✅ | Botão "Aplainar mapa": todo o relevo fica plano; desfaz volta. |
| Rio | `terrain.river` | ✅ | Clico os pontos e Enter: rio com água descendo. |
| Relevos: chapada, cânion, escarpa, pão de açúcar | `terrain.mesa/canyon/...` | ✅ | Escolho Pão de açúcar e clico: sobe uma cúpula de rocha. |
| Ravinas | `terrain.gully` | ✅ | Arrasto: abre uma ravina no terreno. |
| Pintar o chão e biomas | `paint.kind.*` | ✅ | Pinto areia e mudo o bioma. |
| Árvores: bosque, cortar, espécies, uma por clique | `tree.*` | ✅ | Escolho Palmeira e "uma por clique": uma palmeira por clique. |
| Elementos do chão (pedras, cascalho, folhas, capim, flores, cogumelos…) | `el.kind.*` | ✅ | Pincel de Pedras: pedrinhas espalhadas no chão. |
| Efeitos: fumaça, fogo, vapor, chafariz | `el.kind.smoke/fire/steam` | ✅ | Ponho fogo: chamas animadas. |
| Efeitos: poeira, fuligem, faíscas, borrifo | `el.kind.dust/soot/sparks/spray` | ✅ | Ponho faíscas: partículas brilhantes saltando. |
| Água: ondas, espuma, correnteza | `water.*` | ✅ | Mudo a correnteza: a água do rio corre mais rápido. |
| Paisagismo na calçada | `streetscape.*` | ✅ | Arrasto ao longo da calçada: uma fileira de árvores. |
| Muros, cercas, sebes, defensas, gradis | `barrier.kind.*` | ✅ | Traço um muro de 3 pontos. |
| Postes com fios e iluminação | `pole.*` | ✅ | Escolho "luz em postes alternados": metade dos postes acende à noite. |

## Céu e clima

| Funcionalidade | Referência | Aqui | Critério de pronto |
|---|---|---|---|
| Dia e noite | `sky.cycle` | ✅ | O relógio passa e anoitece. |
| Céu: sempre dia, sempre noite, ciclo | `sky.day/night/cycle` | ✅ | Botão Céu: Dia, Noite ou Ciclo. |
| Clima ajustável: chuva %, vento, direção, raios/min, trovão | `weather.*` | ✅ | Painel Clima: barra de chuva 0-100% muda a chuva na hora. |
| Raio onde eu clicar | `hint.terrain.weather` | ✅ | Clico no mapa: cai um raio ali. |
| Nuvens editáveis (criar, mover, ajustar, apagar, espalhar) | editor/cloudTool.ts | ✅ | Clico no céu: uma nuvem nova; "Espalhar" enche o céu. |
| Neblina: pincel e intensidade geral | `fog.*`, `atmo.*` | ✅ | Pincel de neblina num vale: neblina baixa ali. |

## Ações e pessoas (prioridade baixa)

| Funcionalidade | Referência | Aqui | Critério de pronto |
|---|---|---|---|
| Bomba e desabamento | `actions.bomb`, render/destruction.ts | ✅ clarão, fogo, fumaça e poeira; prédios no raio afundam e o lote vira entulho (um comando, Ctrl+Z desfaz); quem estava perto sai da simulação (foto oo_bomba5) | Clico num prédio com a bomba: explosão e o prédio desaba. |
| Pistola e vítimas | `actions.pistol`, render/ragdoll.ts | ✅ tiro com som; a pessoa mais perto do clique sai de cena (só nos nós perto, nunca a multidão inteira) | (prioridade baixa) |
| Criador de pessoas | `tool.person`, people/ | ✅ roupa (16 cores), altura, parada (salva como item) ou andando pela calçada, 1 a 20 de uma vez (foto oo_pessoas) | (prioridade baixa) |

## Câmera

| Funcionalidade | Referência | Aqui | Critério de pronto |
|---|---|---|---|
| Movimento suave sem tremor (estado único, suavização nas entradas, ponto do cursor preso no zoom e no arrasto, inércia) | view/cameraMotion.ts, cameraGestures.ts | ✅ `render/cameraRig.ts` | Giro a roda com o cursor numa esquina: a esquina fica sob o cursor do começo ao fim. |
| Inclinação pela distância | view/cameraProfile.ts | ✅ o zoom soma a diferença do perfil (48° de longe, 6° na calçada) à inclinação do jogador | Aproximo até a calçada: a vista vai para a horizontal. |
| Nunca dentro de um prédio | render/isoViewport.ts (`settle`) | ✅ olho puxado para a frente do prédio entre ele e o alvo (miolo do lote pelos andares), entrando em 0,08 s e voltando em 0,35 s | Giro a câmera baixa atrás de um prédio: ela passa na frente, sem entrar. |

## Produto

| Funcionalidade | Referência | Aqui | Critério de pronto |
|---|---|---|---|
| Salvar e carregar | editor/persistence.ts | ✅ | Ctrl+S e Carregar trazem a cidade de volta. |
| Exportar e abrir mapa em arquivo | editor/mapExport.ts (`action.saveMap/openMap`) | ✅ | "Salvar mapa" baixa um arquivo; "Abrir mapa" com ele restaura a cidade. |
| Salvamento automático | `hint.saveFailed` | ✅ | Depois de editar, em até 2 min o jogo salva sozinho. |
| Novo mapa | `action.newMap` | ✅ | Novo mapa: relevo novo e vazio. |
| Opções gráficas e idioma | `menu.quality`, `menu.language` | ✅ | Opções: Ultra/Baixo e inglês. |
| Ajuda | `builder.help`, `help.*` | ✅ | F1 abre a ajuda. |
| Sobre (versão e créditos) | ui/about.ts | ✅ (na Ajuda) | Botão Sobre mostra versão e créditos. |
| Bússola e botões da câmera | ui/v2/compass.ts | ✅ | Bússola no canto: clique deixa o norte para cima. |
| Saúde do jogo (F9) | ui/healthPanel.ts | ✅ | F9: painel com erros e quadros lentos recentes. |

## Achados (fora da funcionalidade atual)

- `setBiome` marca todas as células do mapa para refazer as peças (laço sobre o mapa por edição; é raro, mas foge da regra).
- Trânsito no centro (defeito 5): `node scripts/transito.ts <mapa> <min> <hora> <demanda>` mede (CENTRO=1, NOS=1,
  NODE=n detalham; RELOGIO=1 faz a hora andar como no jogo, 1 h por minuto; JANELA=1e6 põe o mapa inteiro em
  micro; SEM=reconsider,release,fluxo,lotacao desliga cada parte). Primeira rodada (antes desta etapa): meso no
  ritmo do micro; rota que foge da rua cheia; semáforo que corta o verde vazio; brecha de 3-3,5 s; quem tem a vez
  mas está preso não bloqueia o outro; trecho curto entre cruzamentos colados; viagens pelo comprimento de rua.
- Etapa 4 (16/10/2026): a divergência entre CLAUDE.md ("~10 km/h depois de ~10 min") e o ✅ acima era o relógio.
  As medições do ✅ eram com a hora parada às 12 h; no jogo a hora anda 1 h por minuto e começa às 10 h, então
  aos 8-10 min chega o pico das 18 h (fator do dia 0,95 contra 0,62 ao meio-dia): a frota fixa ganhava 50% de
  carros em dois minutos, nascidos no meio das ruas, e o centro caía para 12 km/h (normal) e 10 km/h (pico) até
  as 6 h. Além disso o meso andava a 6 km/h contra 20 do micro, então a janela esvaziava com o tempo (2824 →
  1328 carros em 20 min): os números ao meio-dia pareciam bons porque a câmera ficava cada vez mais vazia. E quem
  esperava 60 s na linha sumia (182 a 410 carros removidos em 20 min).
  Feito: (1) a frota cresce para o alvo no ritmo das viagens (constante de 10 min; o mapa abrindo enche de uma
  vez) e as viagens evitam começar ou terminar em rua engarrafada; (2) meso = 2,5 × (andar livre pela lotação +
  espera do cruzamento), conferido contra uma rodada toda em micro (o raio de 1,5 km do centro acumula carros no
  mesmo ritmo); (3) ninguém some por travamento: parado 10 s na fila de uma faixa cheia, o motorista reconsidera
  a rota (busca curta que volta à rota 6 nós adiante, como o reconsiderRoute do roadcraft; na linha quem desvia é
  o desvio para uma saída com espaço); esperando 30 s a mesma saída cheia, guarda a próxima vaga dela; faixa sem
  saída espera e troca de faixa; (4) cruzamento travado (invariants do roadcraft: ninguém passou há 20 s e alguém
  espera há 20 s) libera um veículo a cada 3 s, só com a caixa livre e nunca no vermelho; (5) controle automático
  pelo fluxo (`sim/advisor.ts`, ver Cruzamentos); (6) carro arranca a 2,8 m/s² e segue a 0,9 s (ônibus e
  caminhão a 2,2); duas conexões entrando na mesma faixa não se sobrepõem mais; a rota estima o resto do caminho a
  30 km/h (3× menos nós por busca) e guarda 96 nós.
  Medição de 20 min, cidade gerada de 16 km (semente 1), centro = 700 m do centro da cidade, faixas do minuto 3
  ao 20, antes → depois:
  | | centro (km/h) | janela (km/h) | carros na janela | removidos |
  |---|---|---|---|---|
  | normal, 12 h parada | 16,8-25,2 → 14,8-18,3 (min. 5/10/15/20: 16,8/16,6/15,8/15,8) | 19,8-29,1 → 17,9-21,8 | 2824→1328 → 2712→2639 | 182 → 0 |
  | normal, relógio 10 h→6 h | 12,1-19,1 (12,1 às 20 h) → 14,3-19,3 (14,3 às 20 h) | 16,5-24,1 → 16,8-22,3 | — | 249 → 0 |
  | pico, 12 h parada | 13,3-15,3 → 11,5-15,4 (13,7/13,4/12,8/11,5) | 16,0-18,1 → 13,6-17,3 | 3953→3105 → 3876→4793 | 256 → 0 |
  | pico, relógio 10 h→6 h | 9,8-14,6 (10 a 11 das 20 h às 6 h) → 10,9-15,3 (~12) | 12,4-16,7 → 12,9-17,1 | — | 410 → 0 |
  Em 20 min (normal, 12 h): 336 cruzamentos travaram e 381 veículos foram liberados; 1857 rotas reconsideradas;
  o automático trocou ~200 nós (105 → 188 semáforos), neutro na velocidade (A/B desligado/×2/×3: ±0,7 km/h).
  Passo do sim (Node, um núcleo, normal 12 h, minutos 2-20): antes 2,00-2,24 ms (média 2,10, com a janela
  esvaziando para metade), depois 1,64-2,51 ms (média 2,20, +5%, com 35% mais viagens concluídas por minuto e a
  janela cheia); primeiro minuto (o mapa enchendo) 15,9 → 7,3 ms.
  O que não fechou: com demanda "pico" o centro fica em 12-13 km/h e cai com o tempo (carros se juntam no centro;
  a rodada toda em micro mostra o mesmo, pior: é a capacidade do centro, não o meso); no mapa de 10 km, demanda
  normal, o centro vai de 17 a 12,5 km/h em 20 min (2694 → 4027 carros na janela). Normal no mapa de 16 km fica
  em 15-18 km/h: 1 minuto abaixo de 15 com a hora parada (14,8) e 3 com o relógio (14,3-14,6, das 20 às 23 h).

- Pico (17/10/2026): no pico a rede da cidade gerada não carrega a frota (tudo em micro, `JANELA=1e6`: 20,9 → 8,6 km/h
  em 12 min sem parar de cair). Diagnóstico (`CENTRO=1 NOS=1`): fila atrás de "saída cheia" crescendo, cada vez mais
  para emendas de grau 2 (31 → 196 em 20 min), cruzamentos de 5-6 braços só com placa, e cruzamentos colados (a faixa
  entre eles fica com ~1 m depois dos recuos: passava um carro por vez). Feito: (1) emenda livre (grau 2 sem controle)
  não pede vaga na saída, o IDM segue o carro da frente pelo nó; (2) faixa mais curta que um carro é parte dos dois
  cruzamentos: a vaga que conta é a da faixa seguinte da rota (`exitRoom` com `deep`); (3) automático: 5 braços ou
  mais têm semáforo (o fluxo baixo não o tira); (4) regiões de 400 m engarrafadas recebem menos viagens (`REGION_OCC`,
  medido a cada 4 s); (5) governador da frota (roadcraft `populationGovernor`, aqui pela velocidade média da janela
  micro: abaixo de 15 km/h corta o alvo até 75%, acima de 18 devolve). Medição de 20 min, 12 h, base → agora (centro
  700 m, km/h):
  | | min 1 | min 5 | min 10 | min 15 | min 20 |
  |---|---|---|---|---|---|
  | 16 km normal | 21,1 → 22,9 | 17,1 → 18,2 | 17,5 → 19,2 | 16,1 → 18,4 | 15,4 → 17,6 |
  | 16 km pico | 19,2 → 20,5 | 14,8 → 15,0 | 12,8 → 14,3 | 13,5 → 14,6 | 12,4 → 14,5 |
  | 10 km normal | 21,3 → 21,1 | 16,7 → 16,7 | 14,6 → 15,2 | 14,1 → 15,9 | 13,1 → 13,1 |
  | 10 km pico | 18,2 → 19,0 | 13,5 → 15,1 | 13,1 → 14,6 | 11,1 → 12,7 | 9,4 → 12,4 |
  Passo do sim igual ou menor (pico 10 km: 3,4 → 2,6 ms no min 20). Ainda aberto: o centro do mapa de 10 km ainda
  junta carros devagar (582 → 855 em 20 min na normal) por causa dos cruzamentos colados do gerador; separar esses
  nós no `cityGen` (ou recuos menores sem sobrepor a malha) é o próximo passo.

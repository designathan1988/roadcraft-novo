# Arquitetura do motor (o que já existe e por que escala)

Herdado do "Cidade" (city-game), que abre cidades geradas de 16 km com ~73 mil prédios, ~39 mil trechos de via,
~27 mil veículos e 1,5 milhão de moradores em 269 chamadas de desenho e 4,4 M de triângulos. Tudo abaixo é
regra, não sugestão. Quem precisar quebrar uma, escreve aqui o porquê antes.

## Threads
| Onde | O quê |
|---|---|
| Página | entrada, interface, escolher o nível de detalhe, enviar buffers prontos à GPU, desenhar. **Nada mais.** |
| Pool de jobs (`jobs/pool.ts`, `hardwareConcurrency − 2`) | malhas de célula (vias, prédios, detalhe), lotes, peças, pintura de via, relevo, geração da cidade, salvamento. Uma fila de prioridade; job com chave: um envio novo cancela o antigo. Resultados em `ArrayBuffer` transferidos. Workers nunca importam three. |
| Worker de simulação (`sim/worker.ts`) | veículos, pedestres, ônibus, trens, semáforos. Passo fixo de 50 ms. |

Memória compartilhada (`SharedArrayBuffer`, por isso COOP/COEP no Vite e no `app://` do Electron): alturas do
terreno (também é a `DataArrayTexture`, uma camada por ladrilho), chão pintado, água, poses (buffer triplo sem
trava, `sim/poses.ts`), ocupação e desgaste por trecho, estado dos semáforos.

## Dados
- `core/table.ts`: tabela SoA genérica, ids densos, lista livre, `allocAt` (desfazer com o mesmo id), `onGrow`.
  Prédios, nós, trechos, veículos, pedestres, itens: tudo nela. **Nenhum objeto por entidade.**
- `core/grid.ts`: uma grade só — placa 2048 m, ladrilho 1024 m, célula 256 m, subcélula 64 m, chaves Morton,
  `SpatialIndex` intrusivo por subcélula (inserir, mover e consultar por retângulo sem varrer), `DirtyCells` com
  lista por tipo de produto.
- Registro de prédio = lote + zona + andares + semente + estilo + função + design empacotado em bits. A malha é
  derivada, versionada (`GEN_VERSION`), gerada em worker. O save guarda só registros, por ladrilho, deflate, OPFS;
  ladrilho não tocado regenera da semente.
- `core/commands.ts`: toda edição é um comando com `apply`/`invert`; marca células sujas; só elas são refeitas.
- Tamanho do mapa só em `config.ts` (10/16/20/24 ladrilhos de 1024 m), lido na carga.

## Desenho
- `render/cellLayer.ts`: L0 e L1 por célula, L2 por ladrilho, L3 por placa; escolha por distância × `pixelScale`
  com histerese; cai no nível mais grosso **pronto** (a meta é nunca buraco; hoje faltam ladrilhos inteiros de prédios
  entre 4,2 e 6 km, defeito E12 (lista de defeitos `DEFEITOS-roadcraft-novo.md`, 2026-10-19)); troca por pontilhado complementar
  (`lodFadeMask`), sem transparência; orçamento de VRAM por camada; cópia da CPU solta dois quadros após o upload.
- Vértice compacto (`jobs/meshBuilder.ts`): posição snorm16 relativa à célula, normal octaédrica, cor + id de
  material em 4 bytes, atributos extras empacotados. **Um material por camada.**
- Prédios (`render/city.ts`): fachada no fragment shader a partir de coluna e andar (`fuv`, `fac`): janelas por
  estilo, interior mapping, persianas, salas acesas à noite, vidro com Fresnel, recuo por paralaxe, grão de reboco.
  Peitoris e vergas 3D só até 220 m (segunda `CellLayer`, esparsa).
- Vias (`jobs/roadMesh.ts` + `render/roads.ts`): a malha só tem a seção (asfalto, meio-fio, calçada, canteiro);
  **toda marcação é analítica no shader** por tabela de perfis (linhas, zebra, setas por SDF, desgaste vindo da
  simulação, poças de luz dos postes, "carros de densidade" pintados longe). Trocar pintura ou controle não refaz
  malha. Longe, as vias são pintura na textura do terreno (worker).
- Terreno (`render/terrain.ts`): CDLOD instanciado, **uma chamada**, altura lida da texture array no vertex shader.
- Peças/props (`render/props.ts`): pool único de instâncias para todas as células e tipos; compute pass de culling
  (frustum + distância com faixas de esmaecimento) → `drawIndirect` por tipo × nível; impostores octaédricos das
  árvores fotografados na carga (`render/impostor.ts`). Centenas de milhares de instâncias.
- Veículos (`render/vehicles.ts`): 3 materiais, ~20 lotes instanciados, pose interpolada entre ticks, sombra só
  até 90 m, caixas no meio, nada longe (as faixas pintam "carros de densidade").
- Pós (`render/post.ts`): MRT cor + normal + velocidade estável, CSM 3 cascatas de 2048, GTAO meia resolução,
  TRAA próprio (`render/traa.ts`), bloom só à noite, grade de cor; profundidade invertida; shaders compilados na
  carga com malhas de aquecimento.

## Simulação
- Micro (IDM + MOBIL, listas por faixa, `exitRoom`, regras de passagem e semáforos adaptativos) numa janela de
  1,5 km em volta da câmera; **meso por eventos** no resto: cada veículo é um evento num heap (tempo de saída da
  faixa = livre × BPR pela lotação + espera do cruzamento), custo ∝ eventos vencidos, não ∝ frota.
- Rotas A* com heurística a 30 km/h, custo por controle e conversão, BPR forte por lotação, 96 nós guardados,
  recálculo no caminho; reconsideração quando parado 10 s; cruzamento travado libera um a cada 3 s.
- Pedestres: eventos no mapa todo, posição só nos nós a ≤ 520 m da câmera; A* a pé; 10 % de bicicletas.
- Edição incremental: ops da rede em lote por quadro; conexões refeitas só nos nós tocados.
- Regras de passagem (`roads/control.ts`) compartilhadas entre página e simulação; conflitos pré-calculados.

## O que uma edição custa (e tem que continuar custando)
1. O comando marca as células tocadas (trecho, nós, vizinhos ligados, pontas próximas) por tipo: O(1).
2. No quadro seguinte cada consumidor drena só a sua lista: malha de via da célula (+ versão do ladrilho L2),
   malha de prédios (célula + ladrilho + placa), pintura do ladrilho, lotes da célula, peças da célula (blocos de
   64 no pool da GPU), camada de altura do ladrilho.
3. Jobs com a mesma chave cancelam o anterior: arrastar não enfileira lixo.
4. A simulação recebe as ops e refaz só os nós tocados. O autosave grava só os ladrilhos sujos, em worker.

## Limites conhecidos (decidir quando doer)
- three r186 não tem multi-draw-indirect: cada célula visível é uma chamada (hoje ~270 na cidade inteira).
- WebGPU na prática obrigatório; o fallback WebGL2 perde o contexto na cidade cheia.
- `CellLayer.update` visita todas as placas e ladrilhos por quadro (576 a 24 km): barato, mas O(mapa); e
  `Traffic.measureRegions` percorre todos os trechos a cada 4 s. Os dois únicos desvios da regra; conhecidos.
- `game.ts` (2.000 linhas) e `ui/hud.ts` (HTML por string) são os pontos fracos de organização: dividir por área
  quando mexer neles, sem mudar comportamento.

# Lições das quatro versões anteriores (não repetir)

Roadcraft 1 ("planeta-esfera"), 2.0, 3.0 e 4.0 foram o mesmo jogo reescrito quatro vezes entre 2026-10-05 e
2026-10-18. A 4.0 sozinha teve 1.919 commits em 7 dias (728 num dia), 81 reverts, 17 commits "temporários só em
DEV" que entraram e saíram, cadeias de `Revert "Reapply "Reapply …"""`, e o CLAUDE.md reescrito 92 vezes. Os
documentos da 2.0 registram item atrás de item "feito" e depois "desfeito (regressão)", "derrubado medindo",
"anunciada sem medir". Nenhuma das quatro abriu a cidade de 10 km de verdade. Isto aqui é o porquê.

## A. Arquitetura (o que tornou o objetivo impossível)
1. **Um objeto JS por entidade, em `Map`.** 110-150 KB de heap por prédio, GC de 30 MB/s, nada transferível
   para worker nem para a GPU. Extrapolado para o mapa: ~10 GB. → Tabelas SoA (`core/table.ts`).
2. **Tudo na thread principal:** simulação (9-14 ms/quadro), rede viária, topologia, elevação, superfícies, emissão
   de prédios (~7 ms cada), crescimento. "Num processador de 24 threads o jogo usa uma." → Página só desenha;
   pool de jobs e worker de simulação.
3. **Render e simulação sem fronteira:** o renderer lia os objetos da simulação direto, então nunca deu para levá-la
   a um worker. → Poses num buffer triplo em `SharedArrayBuffer` (`sim/poses.ts`).
4. **Produtos derivados refeitos para o mapa inteiro a cada edição:** faixas, conflitos (~30 ms por cruzamento; 51 s
   para abrir 1.369), calçadas (13 s), cenário inteiro, postes inteiros. Uma via isolada num mapa de 4,3 km custava
   6,8 s com o trânsito parado. → Células sujas por tipo; unidade de reconstrução de 256 m.
5. **Cada sistema com a sua grade** (placas de 2.048 m, ladrilhos de 76,8 m, células de 240/120 m, grade de 64 m
   acrescentada tarde): invalidação, streaming e LOD não falavam a mesma língua. → Uma grade só
   (2048 / 1024 / 256 / 64, Morton).
6. **Diário de mudanças num anel único:** uma enxurrada de um tipo fazia os outros leitores refazerem o mapa, até
   a cada quadro. → Listas de células sujas por tipo de produto.
7. **Prédio com geometria de arquiteto:** ~10.800 vértices de casca e 113 peças por prédio, 0,6 MB de GPU cada,
   registro de 7-9,5 KB guardado como texto duas vezes. → Registro de ~12 números + gerador versionado; malha em
   worker; detalhe no shader; HLOD de 4 níveis.
8. **~43 chamadas de desenho por célula** (uma malha por acabamento, um `InstancedMesh` por tipo de peça) e ~120
   materiais. → Um material por camada, id de material no vértice, peças num pool único com cull na GPU.
9. **Só dois níveis de detalhe** (detalhe e massa) e todo prédio emitido pelo menos uma vez. L2/L3 nunca existiram.
10. **Tráfego 100 % microscópico:** o passo crescia com o mapa mesmo com a mesma população; teto de 1.200 carros.
    → Micro perto, meso por eventos no resto.
11. **Sombra de tudo num mapa único** redesenhado por heurística; 19 M dos 42 M de triângulos de uma rua eram sombra.
    O mesmo erro derrubou o Cities: Skylines 2 (72 % das chamadas). → Casters por nível e por tamanho na tela.
12. **Pós-processamento caro por padrão** (MSAA 8× em HalfFloat a 1,5× de resolução, GTAO, raymarch de nuvens e
    névoa, SMAA 16 passos): 5,8 ms antes de desenhar um prédio.
13. **Pessoas e carros com fidelidade de jogo de personagem:** centenas de `InstancedMesh` pré-alocados com
    `frustumCulled = false`, ~30 mil composições de matriz por quadro na CPU, 3,7 ms de GPU de gente.
14. **Arquivos-deus** (`main.ts` 4.292 linhas, `renderer.ts` 3.570, `terrain.ts` 3.750, `buildingMesh.ts` 3.686):
    toda otimização local virava regressão em outra camada.
15. **`BatchedMesh` para o que muda:** guarda a capacidade inteira na CPU (1,1 GB; mapa a 14 fps). Desfeito.

## B. Processo (o que transformou trabalho em prejuízo)
- **"Nenhuma perda de qualidade" e "nada mais lento" como regra absoluta** impediram LOD em árvores, cortar peças
  invisíveis e trocar detalhe por massa. Sem orçamento de quadro antes da fidelidade, o mapa inteiro é impossível.
  Aqui: orçamento primeiro; o que não cabe muda de técnica, não de meta.
- **Medição com a máquina ocupada:** o jogo ficou aberto no painel do navegador do app e tomou 99 % da GPU; a
  mesma cena deu 17, 22 ou 37 ms e saíram conclusões falsas ("o desgaste caiu de 8,5 para 2,9 ms"). Aqui: contar
  em vez de cronometrar; tempo só com a máquina livre e com o antes ao lado.
- **"Feito" sem ver:** correções anunciadas por teste verde, por log, ou por "o código parece melhor". Aqui: foto
  aberta e nomeada na mesma resposta, ou é "não visto".
- **Portão estatístico que acusava piora inexistente** (114 "pioras" em código não alterado) e **auditorias com
  achados falsos** (4 de cada 5 "graves" derrubados ao medir). Aqui: achado é hipótese até a contagem confirmar.
- **Correções "temporárias" commitadas, revertidas e reaplicadas**; duas sessões no mesmo índice do git levando o
  trabalho uma da outra. Aqui: worktree por sessão, arquivos disjuntos, nada temporário no repositório.
- **Documentação que virou o trabalho:** memória, diário, estado, plano, auditoria, prompt de auditoria, 92
  reescritas do CLAUDE.md. Aqui: três documentos vivos (arquitetura, recursos, lições) e o histórico do git.
- **Amortizar em vez de corrigir:** fatiar o trabalho de mapa inteiro em 6 ms por quadro escondeu o custo até a
  cidade crescer. Aqui: proibido; o trabalho é por célula ou vai para worker.

## C. O que a 2.0 fez de bom e que vale trazer como ideia (não como arquivo)
- Gerador de ruas por campo tensorial (Chen 2008) e loteamento estilo CityEngine.
- Decisão procedural de prédio por forma e estilo, com `Signature` escolhendo o candidato menos parecido com os
  vizinhos; paletas brasileiras; split-level e docas em encosta.
- Shaders baratos: mapeamento interior das janelas com luzes pelo ATUS, asfalto em espaço de via, impostores
  octaédricos, vento no vertex shader, chuva sem CPU, relevo por erosão na GPU.
- Geometria de cruzamento: um corte por ponta alimentando boca, zebra, linha de parada e calçada; fases de semáforo
  pela matriz de conflito; amarelo pelo ITE; regras do CTB; números de via com fonte (`roads/tuning.ts`).
- Testes de escala por contagem de trabalho (N contra 4N) e o analisador de "laço do mapa dentro de laço do mapa".

## D. Da auditoria de 2026-10-18 do Roadcraft 4.0 (794 KB, 601 achados, nenhum medido em jogo): o que ainda vale aqui
O relatório é sobre o código abandonado; 90 % dele não se aplica a este motor. Estes padrões sim, porque qualquer um
pode repeti-los no motor novo, e cada um foi visto lá linha a linha:
1. **Cache de sombra invalidado pela matriz da câmera** em vez de pelo conjunto de projetores; vegetação que balança
   tratada como "sempre em movimento" mesmo sem vento; um efeito (`fx.busy`) forçando redesenho total por 12-50 s
   depois de acabar. Aqui: cascata só redesenha quando um projetor dela mudou; vento zero = estático.
2. **Peças pequenas instanciadas uma a uma** (caixas de 4-24 vértices, um `InstancedMesh` por tipo × banda × trecho,
   ~28 materiais; veículos com centenas de lotes por estilo × peça × nível; multidão com um material por classe ×
   item × nível). Medido pelo jogador: 2,6 ms instanciadas contra 0,6 ms unidas. Aqui: peça pequena vai unida na
   malha da célula; só o que é grande e repetido vai no pool de props.
3. **Um upload de textura por entidade por quadro** (`texSubImage2D` por pessoa, por linha, por lote). Aqui: um
   upload por textura e quadro, por bloco ou inteira.
4. **Custo por pixel ignorado:** o quadro era limitado por pixels (22,9 ms tanto a 3 M quanto a 13 M de triângulos);
   MSAA 8× em RGBA16F com SMAA por cima, ruído de desgaste com 40-48 `sin` por pixel, vidro e terreno desenhados
   antes do que os cobre (sem early-Z), passes de tela cheia não fundidos, névoa em raymarch de 36 passos. Aqui:
   opacos baratos primeiro, vidro e água por último; ruído assado em textura; um passe de saída.
5. **LOD recalculado todo quadro sem dirty flag** (olho, frustum, escala iguais → devia pular). Aqui: `CellLayer`
   compara antes de refazer.
6. **Laço de quadro em taxa cheia parado e minimizado** (40-124 quadros/s sem nada se mover; 4-16 ms/quadro com a
   janela minimizada no Electron). Aqui: desenha quando algo visível muda; minimizado não desenha.
7. **Invalidação errada refazendo o mapa** (uma pincelada de terreno zerava a região e refazia tudo; um bloco de via
   reconstruía 15 tiles vizinhos; a folha de placas repintada inteira; desgaste re-assando a célula inteira). Aqui:
   teste de escala por contagem: uma edição custa o mesmo numa cidade de N e de 4N.
8. **Trabalho de abertura em série e na página** (renderer e worker um depois do outro, zstd no main, "nova cidade"
   gerada no main por 1-8 s, cache derivado apagado a cada release). Aqui: geração e descompressão em worker;
   renderer e simulação sobem em paralelo.
9. **Qualidade "auto" que nunca agia** e **ferramentas de medição que mediam errado** (profiler congelava a
   simulação, orçamento somava os draws de aquecimento, VRAM sem mips/alvos/canvas: 200-750 MB invisíveis). Aqui:
   `game.stats()` conta tudo o que está vivo; nenhum governador automático de qualidade (ele muda a cena no meio da
   medição).
10. **Texturas RGBA8 sem compressão e pacote com assets duplicados** (300-370 MB a mais). Aqui: formato por
    conteúdo (R8, RG8), KTX2/BC7 quando entrar textura de arquivo, `cooked/` uma vez só.

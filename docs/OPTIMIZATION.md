# Otimização — revisão e orçamento

Data: 2026-10-29. Meta: qualidade visual com o máximo de desempenho possível, sem custo por quadro/edição/passo que
cresça com o mapa. Medir antes/depois; toda otimização é um commit separado.

## Baseline medido

- Cidade pequena `?teste&mapa=4` (4 km): ~8.689 prédios, 92 draws, 1,64 M tris, 7,2 s até pronto (após a integração; idêntico ao baseline).
- B0 10 km/70k: 125 draws, 3,54 M tris, 60,5 fps a 1600×900 (vsync), 5,44 GB WS, 2.389 MB VRAM.
- `traffic.test.ts`: o caso "ônibus levam pedestres" caiu de 96–122 s para **2,4 s** com densidade 1/12 e saída
  antecipada; a suíte completa fechou **370/370 em 61,6 s**.
- `simDefects.test.ts`: C48 virou invariante de demanda (12,3 s em vez de >5 min); C11 usa 120 s simulados (10,7 s
  reais) e C25 sai ao completar embarque/desembarque (2,4 s).
- `npm run budget` válido (10 km, quadro real por vista, pausa após 20 quadros): street 477 draws / 14,897 M tris;
  district 194 / 9,191 M; city 151 / **3,507 M** (limite 4,044 M); map 211 / 4,463 M; night 529 / 14,448 M; MB
  dentro. O medidor recusa vista com 0 draws/tris.
- Antes da integração o budget era street 496 / 16,97 M, district 205 / 10,30 M, city 166 / 3,80 M, map 211 / 4,46 M, night 574 / 17,80 M; as contagens caíram com a remoção do cluster morto do r40.
- Auditoria após integração: 243 arquivos, 66.759 linhas, 0 ciclos de runtime, 0 de tipos, 0 vazamentos de valor.

## Caminhos quentes conhecidos

| Caminho | Risco | Ação |
|---|---|---|
| `render/cellLayer.ts:274-287` | percorre placas/ladrilhos quando a vista muda; O(mapa) por mudança | listas visíveis/frustum/versões; não visitar placa fora da vista |
| `sim/traffic.ts:1034-1052` | `measureRegions` O(map) a cada 4 s | agregar por célula ou fatiar com orçamento fixo |
| `render/vehicles.ts` | loop de até 131k poses por quadro | tiles/frustum/cap; buffers persistentes; sem alocação |
| `render/props.ts` | pool/cap; corte por quadro (E24) | blocos estáveis, sem mudança de conjunto por quadro |
| `render/impostor.ts` | árvores distantes cintilam/pulam (E30) | mipmaps/anisotropia/estabilidade na troca |
| `sim/peds.ts` / `sim/traffic.ts` | listas/loops grandes; testes de 96 s | orçamento por tick; índices por nó/célula; sem varredura global |
| `jobs/buildingGen.ts` / `roadMesh.ts` | geração pesada no worker | medir por célula; paralelismo e transferência de arrays |
| `r40/*` | pipeline portado, arquivos enormes | medir; dividir por responsabilidade; não duplicar estado |

## Regras

- Nada por quadro/edição/passo que cresça com o mapa; consultas por raio/retângulo/listas mantidas.
- SoA/typed arrays; sem objeto JS por entidade numerosa; sem alocação por quadro; sem readback síncrono de GPU.
- Micro perto + meso longe; não remover o meso; otimizar o custo do meso com medição.
- LOD/impostor a distância é permitido como performance; no médio a identidade tem de se manter; no perto nada de
  caixa.
- Toda mudança: `game.stats()`, frame time p50/p95/p99, draws/tris/VRAM/RAM, `npm run budget`, foto quando visual.
- Não cortar qualidade em silêncio; não esconder custo com amortização; não usar cache obrigatório.

## Medição de 2026-10-29 — pedestres e modelo meso

- `sim/peds.ts`: o C48 antigo mantinha **110 mil pedestres vivos** e levava **>5 min** (O(pessoas × passos)); o
  `simDefects` inteiro passava de 6 min. O teste agora mede o invariante `demand`/`limit` e enche 36 mil pessoas
  reais em **12,3 s**. O `simDefects` fecha **44/44 em 232 s**.
- Isso **não** resolve o custo de produção: uma sonda com 86 mil pedestres mostrou passos de ~0,2 s (86 mil em
  ~700 passos = 97 s), porque o `step` processa eventos e rotas de toda a população. É um caminho quente para a
  cidade de 250 mil; a correção correta é LOD de simulação (micro perto, agregado/eventos longe), não um teto
  silencioso. Fica registrado como dívida de otimização, não como “verde”.
- `MESO_ALPHA` foi de 0.85 para **0.95**: a 1/15 o modelo longe media 7,4 km/h contra 5,7 perto; agora 6,7 contra
  5,9; 1/30 (10,6/10,9) e 1/100 (21,7/20,8) continuam dentro de 25%. Teste do invariante câmera/longe: 19,1 s.

## Próximos passos

1. Isolar `simDefects` por teste e registrar tempo/laço; corrigir o que for infinito e reduzir o que for apenas lento.
2. Reduzir o teste de passageiros de 96 s (ou provar que o custo é do teste, não do jogo); C11 e C25 ainda são os
   dois testes lentos do `simDefects` (90 s e 77 s).
3. Medir `CellLayer.update` e `measureRegions` em cidade pequena e 10 km; corrigir O(mapa) se confirmado.
4. Medir o loop de veículos com 10k/100k poses; cap/frustum.
5. Revisar props/impostores para E24/E30 (cintilação).
6. Repetir budget após cada feature; comparar com o baseline.
7. LOD de pedestres longe (dívida acima): medir custo do passo por faixa de distância antes de escolher a técnica.

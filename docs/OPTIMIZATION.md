# Otimização — revisão e orçamento

Data: 2026-10-29. Meta: qualidade visual com o máximo de desempenho possível, sem custo por quadro/edição/passo que
cresça com o mapa. Medir antes/depois; toda otimização é um commit separado.

## Baseline medido

- Cidade pequena `?teste&mapa=4` (4 km): ~8.689 prédios, 92 draws, 1,64 M tris, 7,2 s até pronto (após a integração; idêntico ao baseline).
- B0 10 km/70k: 125 draws, 3,54 M tris, 60,5 fps a 1600×900 (vsync), 5,44 GB WS, 2.389 MB VRAM.
- `traffic.test.ts`: 113 s; o teste "ônibus levam pedestres" sozinho levou 96 s.
- `simDefects.test.ts`: três testes lentos (C11, C48, C25); C25 passa em 75 s. Não é um laço único; o arquivo completo passa de 150 s.
- `npm run budget` (10 km, após integração signals/r40): street 451 draws / 14,88 M tris; district 191 / 9,27 M; city 151 / 3,51 M; map 178 / 4,46 M; night 465 / 14,85 M; budget ok.
- Antes da integração o budget era street 496 / 16,97 M, district 205 / 10,30 M, city 166 / 3,80 M, map 211 / 4,46 M, night 574 / 17,80 M; as contagens caíram com a remoção do cluster morto do r40.
- Auditoria após integração: 228 arquivos, 65.979 linhas, 0 ciclos de runtime, 0 vazamentos de valor, 4 ciclos só de tipos.

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

## Próximos passos

1. Isolar `simDefects` por teste e registrar tempo/laço; corrigir o que for infinito e reduzir o que for apenas lento.
2. Reduzir o teste de passageiros de 96 s (ou provar que o custo é do teste, não do jogo).
3. Medir `CellLayer.update` e `measureRegions` em cidade pequena e 10 km; corrigir O(mapa) se confirmado.
4. Medir o loop de veículos com 10k/100k poses; cap/frustum.
5. Revisar props/impostores para E24/E30 (cintilação).
6. Repetir budget após cada feature; comparar com o baseline.

# Túneis — análise do roadcraft-novo contra as fontes

Data: 2026-10-30. O dono avisou que o Roadcraft 4.0 também faz túneis errados: a referência aqui são manuais de
engenharia e a prática de jogos/motores, não o 4.0. Fontes completas em `lab/MEMORY/SOURCES.md` (2026-10-30, road
tunnels); as citações do FHWA foram conferidas no texto do manual (linhas 1340, 1524, 1552 do PDF extraído).

## O que as fontes dizem
- **Portal:** fica "at a point where the depth of the tunnel is suitably covered" (FHWA-NHI-10-034 §1.3.5); num túnel
  em corte e cobertura, tão perto da superfície quanto o teto permite com a folga do tráfego; túneis em rocha pedem
  1–2 diâmetros de cobertura (USACE EM 1110-2-2901 §5-6a). A aproximação ao portal é em corte aberto / corte e
  cobertura, com muros de arrimo (FHWA §5.2.1); a testada e os muros de ala fazem parte do portal (FHWA HIF-15-006,
  elemento 10051).
- **Gabarito:** altura livre mínima 4,9 m em rodovias, 4,3 m em ruas (AASHTO via FHWA §2.3); faixas ≥ 3,6 m;
  passeio elevado ≥ 0,7 m.
- **Rampa:** de preferência ≤ 4 %, até 6 % quando necessário (FHWA §2.2.1); > 5 % proibido em túneis novos
  (Diretiva 2004/54/CE, Anexo I 2.2.2).
- **Terreno nos jogos/motores:** furo por máscara na resolução do mapa de alturas (Unity SetHoles/Paint Holes,
  BeamNG camada 255, Unreal Visibility), com a malha do portal cobrindo a borda serrilhada do furo; Cities: Skylines
  faz a peça "Slope" (corte que desce) carregar o portal; CS2 faz a via passar por corte antes de virar túnel.

## O que o jogo faz hoje (medido: morro de ~40 m, via de x 1900 a 2300, scratch `portalcover.mjs`)
| x | chão | via | profundidade | cobertura sobre a abóbada de 5,8 m |
|---|---|---|---|---|
| 1970 | 14,0 | 18,9 | −4,9 | (buraco no terreno ao lado do aterro) |
| 2030 (portal) | 27,8 | 23,7 | 4,0 | **−1,8** |
| 2100 | 52,4 | 29,3 | 23,0 | 17,2 |
| 2170 (portal) | 29,6 | 25,9 | 3,7 | **−2,1** |

Defeitos, cada um contra a fonte:
1. **Portal onde a via está 4 m abaixo do chão** (`jobs/roadMesh.ts` `buried`: chão − via > 4): a abóbada (testada a
   5,8–7,4 m) sai do morro. Pelas fontes, o portal vai onde o chão cobre o teto (via + gabarito + laje).
2. **Rampa de ~16 % dentro do túnel** (o greide geral da via, `roads/build.ts`): acima dos 4–6 % das fontes.
3. **Aproximação** entre o chão e o portal: o terreno é rebaixado até a via (corte) sem muros de arrimo quando a
   via não tem a opção "Muro"; as fontes pedem corte com muros na aproximação.
4. **Buraco no terreno** a x 1970–1980 (5 m abaixo da via, ao lado do aterro): causa ainda não encontrada.
5. **Manchas marrons no topo do morro, na linha do túnel:** estão no terreno (escondendo cada camada de malha elas
   continuam: `tlayers/sheet.png`), não na malha das vias; causa ainda não encontrada.

## Plano (a aprovar/seguir)
1. Portal pela cobertura: o túnel começa onde chão ≥ via + gabarito (4,9 m + folga) + laje; antes disso, corte
   aberto com muros de arrimo e a testada/muros de ala no ponto do portal.
2. Greide do túnel limitado a 5 % (o resto do desnível nas rampas de aproximação a céu aberto).
3. Achar a causa do buraco (1970) e das manchas (topo) por medição, cada uma com a fonte do mecanismo.
4. Fotos antes/depois nas mesmas vistas (`test-results/tunel-2026-10-30/`).

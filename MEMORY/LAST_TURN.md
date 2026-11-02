# Último turno do assistente

Atualizado: 2026-11-02 02:01:47

A01 terminou com 22 achados, e todos vão para o registro com correção. Os principais, ainda sem conferência minha:
- O cull dos props roda de 5 a 11 vezes por quadro, e o primeiro nunca é lido.
- A cena do jogo é percorrida de 5 a 11 vezes por quadro.
- O teste que deveria pular o céu no AO está errado para a profundidade reversa, então o céu paga o custo inteiro.
- Provável: a compilação inicial prende um buffer MSAA sem uso, de 142 a 464 MB (valor calculado).

Terminaram 19 dos 24 agentes.

# Último turno do assistente

Atualizado: 2026-11-02 02:11:47

A24 terminou com 26 achados, e todos vão para o registro com correção. Os principais, ainda sem conferência minha:
- O cull de props despacha 1 milhão de invocações de 10 a 22 vezes por quadro, e parte desse trabalho é descartada.
- Cada passagem é um render completo do three, de 47 a 80 `queue.submit` por quadro pela conta dele. A orientação citada é de 1 a 5.
- O cull usa a pirâmide de um quadro com as matrizes de outro. A ordem está provada; o efeito visível, não.
- Na versão Steam, a ponte do overlay liga opções que nunca entraram nas medições.

A23, de memória, é o último que falta. Depois dele começo a revisão crítica e a conferência no código.

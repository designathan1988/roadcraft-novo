# QA visual — baseline e critérios

Data: 2026-10-29. Toda mudança visual precisa de foto nas mesmas vistas, 1:1 na distância de troca, `game.stats()` e
`npm run budget`. Este documento registra o baseline e os cenários obrigatórios.

## Baseline já capturado (cidade 4 km, `?teste&mapa=4&seed=123456789`)

- `test-results/port-small/lod/01-300.png` … `06-2200.png`: LOD de prédio a 300/600/900/1.200/1.600/2.200 m.
  A 300–900 m há fachada/telhado; a 1.600/2.200 m o massing L2 vira caixas. A faixa L1 (700–1.800 m) melhorou 1.600 m;
  2.200 m continua L2.
- `test-results/port-small/bomb/01-antes.png` e `02-bomba.png`: alvo `floors 12 -> 0`; a foto mostra uma caixa
  cinza grande do `Blast.collapse`, não o interior/efeito do Roadcraft.
- `test-results/port-small/lod-band/01..04`: cidade/rua/canto após L1 e refatorações.

## Cenários obrigatórios

### Carros

- Rua a 20 m, 100 m e 500 m, dia e noite; carro, ônibus, caminhão e moto.
- Corpo opaco; só vidro transparente; sem “see-through”, sem buraco, sem dither visível no corpo.
- Rodas no chão, faróis/lanternas/setas corretos, sombra coerente.
- Comparar com o Roadcraft 4.0.
- **Estado em 2026-10-29 (HEAD `e89f6ed`):** antes da mudança de vidro, `test-results/carros-qa-2026-10-29/01..09`
  (árvore de `084425c`) mostrou a carroceria opaca a 20/100 m; a 500 m os carros não resolvem no quadro, sem
  caixa nem transparência grosseira. Depois, `test-results/carros-vidro-perto-2026-10-29/01,07` mostra o motorista
  no carro preto a 8 m e passageiros brancos dentro do ônibus, com o vidro separado e transparente; a carroceria
  continua opaca. O LOD distante mantém o modelo fundido. Caminhão e moto ainda não foram isolados em foto; a
  500 m não há prova de detalhe.

### Pessoas

- 2 m, 20 m, 100 m e multidão; corpo inteiro, skinning, roupas/cabelo, sombra.
- Sem transparência/buraco/corte; LOD do mesmo modelo; grupos do criador visíveis.
- **Estado em 2026-10-29 (HEAD `80bfefc`):** `node tools/fotos-pessoas-qa.mjs test-results/pessoas-qa-2026-10-29`
  colocou 8 pessoas em roda e 4 andando pelo `api.people` e gerou `01..05` (2/20/100 m dia, 2/20 m noite).
  A 2 m o corpo inteiro, roupas/cabelo e mãos aparecem opacos, sem buraco/transparência; a 20 m o grupo
  continua legível; a 100 m são silhuetas pequenas, sem caixa ou corte grosseiro. A multidão e a animação
  de skinning em movimento não foram isoladas; o cenário completo ainda não está provado.

### Ônibus e trânsito

- Linha com curvas de 90° e rotatória; seguir o ônibus; registrar pose/yaw por passo.
- Sem tranco/salto/giro errado; rodas alinhadas; passageiros embarcam/descem no ponto.
- Semáforo, cancela, faixa de pedestre e conversões proibidas nos dois sentidos (perto/longe).

### Cintilação/sobreposição

- Câmera lenta por borda de célula (256 m), ladrilho (1.024 m) e placa (2.048 m); troca L0/L1/L2/L3.
- Capturar 2–3 quadros seguidos e `CIDADE_DIFF`; zero pixel piscando/sobreposto.
- Props, árvores/impostores, lotes, volumes empilhados, estacionamentos e sombras.

### Vias

- Reta, curva, T, X, rotatória, ponte e túnel; pista, faixas, calçada, meio-fio, sarjeta, zebra, conectores.
- Sem buraco/sobreposição; continuidade na junção; foto de cada caso.

### Prédios

- Lote retangular, poligonal, esquina, encosta, estreito; fundação, paredes, fachada, telhado, muro, calçada.
- Sem prédio achatado/cortado/invadindo via; LOD 1:1 na troca; F1/F12/F13/F15/F23.

### Bomba

- Antes/depois; fratura/entulho/pó/fumaça; interior/corte visível; desfazer; sem caixa cinza e sem custo por quadro
  crescente.

## Portões

- `tsc`, build, `npm test`, `npm run budget`, `npm run arch:check`.
- Foto 1:1 na transição; nenhuma mudança visual sem antes/depois.
- Se a suíte estiver lenta, registrar o tempo; não chamar de “verde” sem terminar.

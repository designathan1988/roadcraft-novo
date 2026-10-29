# Auditoria da worktree `roadcraft-port` (somente leitura)

Data: 2026-10-29. Autoria: sessão `port/roadcraft-features` (esta worktree). A worktree
`C:\Users\Jonathan\Documents\Projects\lab\roadcraft-port` foi lida com `git show`, `git diff` e
`Read`; **nada foi escrito nela**. O `git status` dela permaneceu com os mesmos quatro arquivos
modificados que já estavam lá quando a leitura começou.

## Estado encontrado

- Ramo `port/funcionalidades`, HEAD `7806342` ("Red suite: fix F2/F4/F10 to the 4.0 contract and
  the hill to world coordinates"), mais um merge `a778760` que já contém a nossa linha até
  `6066a74`.
- Alterações não commitadas: `src/jobs/building40.ts`, `src/jobs/buildingGen.ts`,
  `src/jobs/props.ts`, `test/buildingDefects.test.ts` (trabalho em andamento; não é uma entrega
  fechada).
- Documentos lidos inteiros: `CLAUDE.md`, `PROMPT-ANALISE.md`, `PROMPT-CONTINUAR.md`,
  `docs/ESTADO.md`, `docs/ARQUITETURA.md`, `docs/LICOES.md`, `docs/ESTRUTURA.md`,
  `docs/RECURSOS.md`, `docs/PARIDADE-roadcraft-3.md`, `docs/PESQUISA-PREDIOS.md`,
  `docs/PESQUISA-CIDADE-GRANDE.md`, `docs/PESQUISA-WEB-2026-10-18.md`.

## O que foi verificado e o que entrou nesta worktree

### 1. Slope do lote 4.0 (`building40.ts`)

O `7806342` corrige o `hill` para amostrar o terreno em **coordenadas de mundo**:

```
fx = cx + (D/2)·sin(rot), fz = cz + (D/2)·cos(rot)
g(ly) = groundAt(fx − ly·sin(rot), fz − ly·cos(rot))
landAt(x,y) = groundAt(fx + x·cos − y·sin, fz − x·sin − y·cos)
```

Conferimos contra `wx/wz` (`buildingGen.ts:147-148`) e contra o frame que `building40` devolve
(`x = fx`, `y = −fz`, `rotation = rot`): a conversão está correta. **Esta worktree já tinha essa
correção** (o commit antigo `cd34522` foi rejeitado justamente por amostrar `(0,0)`); portanto o
`building40.ts` do `7806342` não precisou ser aplicado. Entrou o teste de regressão `B16`
(`test/building40.test.ts`), que discrimina um lote plano na origem de um lote em (500,500) numa
encosta e exige geometria terraceada diferente.

### 2. F2 — telhado com “tampa”

O `7806342` troca o detector de `bigLevels` pelo `lidOverRoof`: uma tampa é um nível a ≤ 0,5 m
sobre outro do tamanho do telhado, cobrindo ≥ 80% dele; membranas/terraços do 4.0 e lajes
pequenas de varanda não contam. Verificamos o caso no **caminho de produção R40**, não só no
gerador genérico: `B18` monta 18 lotes (comercial, residencial e casa) em L0 e L1 e exige zero
tampas. Passa.

### 3. F4/F10 — dois sinks de peças

O `7806342` adapta os testes para o fato de que, desde o caminho 4.0, as peças saem por dois
sinks: o gerador antigo por `emit` e os prédios 4.0 por `parts40`. Nossa solução mantém os testes
do gerador genérico no caminho `legacy` (commits `22b87f9`/`6715a20`) e adiciona cobertura do
caminho real:

- `B19`: o passe de peças 4.0 entrega peças no sink e **não escreve vértice** em malha descartável;
  o passe de detalhe escreve exatamente o `vertexCount` devolvido.
- `B17`: o passe de peças devolve o ground 4.0 por lote; o sink recebe as peças; o lote distante sem
  sink continua com o yard genérico.

### 4. `yard40` (não commitado na outra linha) — **não integrado como estava**

O rascunho marcava `yard40[i] = true` para todo lote R40 no passe de peças, mesmo sem sink, e
`lotYardProps` pulava o yard inteiro. Isso esvaziaria o yard dos lotes distantes e, pior, o
próprio `roadcraft-port` encontrou a prova de que **o 4.0 não emite vegetação de lote**:
`r40/render/buildings/buildingMesh.ts:2454-2455` retorna para `tree`, `shrub` e `hedge`. A
vegetação do yard é do gerador antigo.

Implementação adotada em `71ef20f`: o passe de peças devolve, por lote, o `lotGround` do 4.0
(`Laid40.ground`) e os footprints dos volumes sólidos; `lotYardProps` usa essa altura (NaN fora do
ground → não planta) e mantém as plantas fora do prédio. Sem sink (lote distante), usa o ground
antigo. O teste `B17` prova os dois lados: perto tem plantas com `y` finito; longe também tem
plantas; o array devolvido tem função só para os lotes que passaram pelo sink.

## Achados de pesquisa que valem trabalho futuro (não implementados agora)

Ordenados por impacto e risco; todos vêm de `docs/PESQUISA-PREDIOS.md`/`PESQUISA-CIDADE-GRANDE.md`
e devem ser medidos por contagem + foto antes/depois.

1. **Textura de detalhe perto** (PESQUISA-PREDIOS §2.1/§4.3): segunda amostra da array de
   acabamentos em escala ~1/7 quando `fwidth` indica < 2 m por texel; rejunte de pastilha/tijolo
   legível a 30-60 m. Custo previsto: +1 fetch por pixel de parede perto, +27 MB se a array subir
   para 512²; medir `cityMB` e foto 1:1.
2. **AO de vértice + desgaste nos 2 bytes livres da normal** (§2.6/§4.4): cânion urbano, sombra sob
   varanda/cornija, base suja, escorrido sob AC/peitoril e reboco descascado por `decay`. Sem
   geometria nova; +1 fetch e ~15 ALU por pixel de parede. O `decay` já está no registro e nenhum
   shader o lê hoje.
3. **Telhados cheios** (§2.4/§4.5): empacotar HVAC, caixa d'água, respiros e claraboias no L0 como
   caixas/prismas; em L2/L3, borda pintada no shader. É o item que mais aproxima a foto de cima do
   4.0.
4. **Sombras** (§2.8/§4.8): casters por texel e cache das cascatas 2-3; a cidade é estática. A
   meta é o passe de sombra cair a ~1/3 e ficar em 0 com o relógio parado.
5. **L3 por quarteirão / 12 tris por prédio** (§2.7/§4.9): o mapa a 11 km ainda gasta ~4,46 M tris;
   fundir prismas quando a diferença de altura for < 1 px. Cuidado: nada de impostor octaédrico por
   prédio (paralaxe forte), só cartão por ladrilho ou prisma fundido.
6. **Uma passada do gerador com 3 sinks** (§2.10/§4.10): hoje o gerador roda quatro vezes por
   célula (L0, L1, detalhe, peças); uma passada com L0+detalhe+peças e L1 derivado reduz ~60% do
   trabalho de worker (estimativa a medir). É a maior melhoria de abertura, mas mexe no coração do
   `buildingGen.ts`; fazer depois da divisão estrutural.
7. **Hi-Z por célula/pool** (§2.7/§4.11): só se a vista de rua continuar limitada; o caso
   IfcOpenShell mostra que o pré-passe pode anular o ganho. Medir antes de manter.

## Divergências e riscos registrados

- `PESQUISA-WEB-2026-10-18.md` recomenda **WebGL2 agora** e diz que o `WebGPURenderer` custou ~2×
  CPU em cenas de muitos objetos; o projeto desta worktree usa `WebGPURenderer` + TSL. Não trocar
  o renderer por causa de um relatório de 2026-10-18: é uma decisão de arquitetura que exige
  benchmark A/B na cena real, com o mesmo `game.stats()` e a mesma máquina. Fica como risco
  aberto, não como mudança.
- O `7806342` diz “17 de 22 verdes” na suíte dele. Não rodamos a suíte na worktree dele (leitura
  apenas); a nossa suíte equivalente está verde em 82 testes. As cinco falhas restantes que ele
  cita (F6, F11, B7/B8, B9/B14, B15) incluem testes que, na nossa separação, rodam no gerador
  genérico e passam; o que continua sem cobertura é o **caminho de produção R40** para polígono,
  interior e peças — por isso os testes B16-B19 acima.
- Nada foi copiado de `src/r40` nem do renderer antigo; a regra de costura do `docs/ESTRUTURA.md`
  continua valendo.

## Evidência

- `node --test --test-concurrency=1 test/building40.test.ts test/buildingDefects.test.ts`:
  25/25 verdes (B16, B17, B18, B19 + F2/F4/F6/F10/F11/F12/F13/F14-F17/B7-B15).
- `node --test --test-concurrency=1` nos sete arquivos de prédios/trânsito: 84/84 verdes.
- `npm run typecheck`: limpo.
- `npm run arch:check`: 0 ciclos de runtime, 0 vazamentos de valor, baseline OK.
- Commits desta integração: `b58b5b7` (primeira versão, superseded) e `71ef20f` (ground do 4.0 +
  footprints; correção da hipótese de yard).

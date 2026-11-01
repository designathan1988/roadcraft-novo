# Último turno do assistente

Atualizado: 2026-11-01 16:37:08

**Casa e memória**
- O worktree foi movido para `roadcraft-novo/.claude/worktrees/port` (branch `port/roadcraft-features`); o irmão `roadcraft-novo-port` não existe mais. A sessão e a árvore de trabalho estão em `roadcraft-novo`; nada commitado.
- Os hooks foram convertidos para [.claude/settings.json](.claude/settings.json) e [.claude/hooks](.claude/hooks) (testei o `start`: `ROOT` resolve em `roadcraft-novo`). A memória ativa agora é [MEMORY/STATE.md](MEMORY/STATE.md), com WORKLOG/DECISIONS/SOURCES novos — **sem** o WORKLOG de 4 mil linhas, arquivos, auditorias vencidas ou documentos antigos. O `lab/MEMORY` fica intacto como histórico. Os hooks novos valem no próximo início de sessão; `.claude/worktrees/` entrou no `.gitignore` para o worktree não ser commitado.

**Causas corrigidas (com prova)**
1. **Franja branca/dither nas copas** — o material compartilhado lia o `pext` das cartas de árvore (UV do atlas + canto do billboard) como se fosse barra de peça fina. `partCardOn`/`partThinTone` agora recebem a máscara `foliage` (Leaf/LeafCard/Impostor) e nunca aplicam essa leitura às copas; as peças finas das fachadas continuam iguais. Provas: [final-empty.png](test-results/audit-2026-11-01/final-empty.png) e o zoom 7× (copas sólidas), [street.png](test-results/audit-2026-11-01/street.png) do budget (molduras, parapeitos e pergolados sem regressão).
2. **Xadrez do LOD dos props** — era um cross-fade **espacial permanente** (IGN fixo) sobre níveis geométricos diferentes. Virou uma **dissolução temporal por instância** (Cesium: limiar rampeado no tempo, ruído mudando a cada quadro, resolvido pelo TAA; 450 ms; histerese 6%; estado `key/from/to/start` em storage read-write, documentação do three.js). No regime parado desenha **um nível por instância**. Medições: cena vazia (mapa 10 km, 4500,4500, câmera dist 40→300) meio da dissolução **421.336** tris, final **368.006**; no still da cidade, antes/depois do lote **429.724 → 426.952**. Custo: **+13 MB** de estado (`storMB` 73 vs 60).
3. **Arquitetura** — `grassCulling.ts`, `propFallback.ts`, `propMaterial.ts`, `propsProbe.ts`; `props.ts` **54,2 → 35,6 KB**, `terrain.ts` **68,9 → 65,4 KB**; `arch:check` passa. A faixa de altura da grama agora lê os pontos reais da grade (teste novo: 2 casos). A oclusão é construída **no início do quadro com a câmera atual** (não usa mais a do quadro anterior); `cellHidden` morto removido.

**Gates (na pasta roadcraft-novo)**
- `npx tsc --noEmit` limpo; `npm test` **534/534**; `vite build` ok; `npm run arch:check` ok.
- `node tools/verificar.mjs`: **145 ok, 1 falha** — “road keys can be changed” (pré-existente, já registrada em 2026-10-31).
- `npm run budget` (cidade grande, desempenho): street 314/635 draws, 14,9M/35,0M, 1134/1338 MB; district 153/327, 13,0M/26,4M, 1161/1350; **city 175/179 draws, 4,62M > 4,04M, 505 > 449**; **map 308 > 211, 10,97M > 5,28M, 482 > 395**; night 275/649, 12,3M/35,1M, 1132/1385. O city melhorou muito vs. a base (13,29M), mas segue acima; **o map cresceu vs. a base 7,69M**.

**Fotos que abri e o que vi**
- `final-empty.png` e o zoom 7×: copas verdes/rosa sólidas, sem traços brancos e sem xadrez.
- `final-mid.png` (8 quadros após o salto): dois níveis na dissolução, sem popping visível no quadro; `final-final.png` (150 quadros): copas limpas, um nível.
- `budget/street.png` e `night.png`: fachadas, molduras, parapeitos, pergolados, carros e pessoas sem regressão; a cidade grande foi usada só para desempenho.
- A foto antiga de 30/10 que você apontou tem a retícula diagonal no céu; nas fotos atuais/HEAD o céu está liso nos recortes que medi.

**Tentativas que falharam/reverti**
- O jitter temporal sozinho não limpou o xadrez espacial permanente — revertido; a solução foi a dissolução temporal (o padrão deixa de existir fora da transição).
- O ramo de sombra novo desenhava o nível 0 de casters longe demais; corrigido com `d < ends[0]` (os stats voltaram de 902.979 para 426.952 tris).
- Minha primeira análise das fotos foi superficial (você apontou a franja); a regra de analisar em 1:1 e nomear todo artefato está na memória.

**Aberto**
- Budget **city/map** acima do limite; a próxima causa-raiz é o **erro geométrico medido + travessia SSE** (item 1 do relatório) — é o passo de arquitetura para o map/city, não um ajuste de constante.
- Itens do audit ainda abertos: sombras por cascata/scroll, mask-free/depth prepass, água com early-out, mapa de sombra das nuvens, batching por classe, camadas de textura para 24 km, atribuição por passe, orçamento de memória.
- `?webgl` não reexecutado; giro na minicidade com oclusão ainda não fotografado; a falha pré-existente do `verificar` segue aberta; nada commitado.

**Fontes**: Cesium 3D Tiles (seleção por `maximumScreenSpaceError`) e Cesium “Smoother LOD Transitions with Dithered Opacity Masking”; documentação local do three.js (`StorageBufferNode` read-write, `StorageArrayElementNode`, `IndirectStorageBufferAttribute`); Unity/Unreal apenas como referência dos tipos de dither. O código do 4.0 foi consultado só para o **visual** — nenhuma técnica foi adotada sem verificação na documentação.

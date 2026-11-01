# WORKLOG — Roadcraft 5 (roadcraft-novo)

Fresh active log, started 2026-11-01. The old lab/MEMORY/WORKLOG.md is history and is not copied here.

## 2026-11-01 — causes fixed in the current tree
- Owner's workspace rule: work in `roadcraft-novo`; the port worktree lives inside `.claude/worktrees/port`; old
  sibling `roadcraft-novo-port` moved; session in `roadcraft-novo`; nothing committed.
- Tree crowns' white bars: `pext` (atlas uv + billboard corner) was read as thin-part bar data by the shared material.
  Fixed with a `foliage` mask in `partCards.ts`/`propMaterial.ts`; building thin parts unchanged. Photos: final-empty
  and 7× (solid crowns), budget street (facades/frames unchanged).
- Props' LOD: permanent spatial dither replaced by a timed per-instance dissolve (Cesium/three docs); state in a
  read-write storage buffer; one level at rest. Empty scene: mid 421,336 / final 368,006 tris; city still 429,724 →
  426,952; +13 MB state.
- Architecture: grass cull, WebGL 2 fallback and the material extracted to their own modules; `arch:check` passes;
  grass range reads real height samples (new test). Occlusion built before the level choice with the current camera.
- Gates: tsc clean; tests 534/534; build ok; arch ok; verificar 145/146 (pre-existing road-key failure); budget:
  street/district/night within, city 4.62M > 4.04M, map 10.97M > 5.28M (map grew vs 7.69M base) — open; next = SSE.
- Photos opened: `test-results/audit-2026-11-01/final-empty.png`, `final-mid.png`, `final-final.png`, `street.png`,
  `night.png`; the tree crowns and the dissolve result show no white bars and no checkerboard.

---
## 2026-11-01 16:37:08 | ASSISTANT TURN END
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

---
## 2026-11-01 16:37:26 | USER PROMPT
Seguir com SSE

---
## 2026-11-01 16:44:18 | USER PROMPT
leia claude.md

---
## 2026-11-01 16:45:25 | USER PROMPT
QUAL DOIS CLAUDES VOCê LEU SEU LIXO?

---
## 2026-11-01 16:45:39 | USER PROMPT
QUAL DOIS CLAUDES?

---
## 2026-11-01 (2nd session) | far levels' error (cause) + SSE switches
- Item 1: the far shell's thin-structure filter decided by THICKNESS (mast 0.08 m × 3.5 m tall skipped; ladders
  3.1 m; pergola posts; parasol poles; dish post) — measured 3.5 m of error where 4.0's own comment sets 0.3 m
  (FLAT_DEPTH). Fixed in roofMesh.ts; TILE_DETAIL 3 → 1.4 m (4.0's real value) + mast in the massing plant.
- Item 2: viewError.ts (SSE rule, px budgets 2/0.5, viewScale with real fov/ortho zoom); city.ts derives
  978/782/5216 from the levels' errors; game.ts updates the scale per frame.
- Proof: probe before/after (L1 3.5 → ≤ 0.31 m); photo pairs in test-results/lod-fix/ (before/after at
  1100/850/1000/1150, L0 control at 700, sse-850); suite 540/540; tsc clean; build ok; arch ok; verificar 145/1
  (pre-existing road-key failure). Report: reports/lod-error-and-sse-2026-11-01.md.
- Photo-workflow facts learned (they cost three failed sessions): the game does not run in the in-app browser (no
  COOP/COEP there) — use tools/shot.mjs (Electron, machine GPU); scripts are IIFEs (no top-level await); the
  published camera path is `window.__roadcraft.camera.view(x,z,yaw°,pitch°,dist,hour)` + `frames.settle(n)`;
  ROADCRAFT_SEQ does script→settle→photo per entry in ONE boot; ROADCRAFT_LIMIT caps the run (shot.mjs exits 124
  if the game is killed under it); output folder must exist; ROADCRAFT_DIST shoots a frozen build.

---
## 2026-11-01 (3rd part) | GPU floors + the grass over the map edge — commit 814c4fd (branch port/roadcraft-features-dev)
- The five GPU root causes were named from the code (shadows' movers+copy, no occlusion for the pools, discard
  without early-Z, per-pixel cloud shadow, the sea plane). Fixed now, image-exact:
  cloudShadow (If gates: clear sky pays nothing), inside.hiddenMask (If by hiddenCountU; the ruins keep the count;
  `If` needs a Fn stack - the first attempt crashed the boot, fixed by wrapping in a Fn invocation), sea (geometry
  from the water table: keep a vertex only where the ground is under sea level and no river/lake stands above -
  there was never sea around the map, the old ring drew fully transparent and is gone; depthWrite=false), grass
  (a camera-locked tuft past the map's edge never grows - the material and the GPU cull both test the bounds).
- Photos: test-results/lod-fix/sea-map2.png (no ring, island intact), sea-edge2.png + grass-edge-fixed.png
  (the field ends at the skirt), sea-city.png. Boot crash found by photo round, fixed, re-verified.
- Commits: local commits on port/roadcraft-features-dev (port/roadcraft-features itself is checked out in the old
  lab worktree and cannot be touched from here). electron/main.mjs logs the page console's stack now.
- Open (the big GPU items): per-cascade mover lists, the kept-frame store copy, occlusion for props/vehicles/people,
  depth prepass + mask-free variants for props/roads/terrain, budget city/map architecture.

---
## 2026-11-01 (4th) | the void never seen — commit 7797f30
- The owner's photo showed trees and grass "in the empty space" past the map's edge. Root cause: the camera's eye
  was not clamped - the target was, the eye was not, so at an edge target with distance the camera flew outside
  and everything inside read as floating in the void. Fixed in cameraRig.syncCamera (the eye clamps to the map;
  the look target stays). The grass tufts past the edge never grow (material + GPU cull) - the field ends with the
  terrain. Photo: edge-clamped.png (the frame is all world), grass-edge-fixed.png.

---
## 2026-11-01 (5th) | each shadow cascade culls its own casters — commit (see git log)
- Cause 1 of the GPU-100% list, fixed: the cascades render sequentially inside the shadow phase, so the props'
  fill runs between passes - prepareCascade (casters only, level 0, the cascade's own frustum with the same sun
  sweep, no dissolve state) before each cascade's render, prepareMain after the last. The dissolve state runs once
  a frame. Budget, before -> after: street drawn 16,205,613 -> 15,362,635 (-843k), district 13,486,825 ->
  13,006,289 (-480k), night -80k; city/map unchanged (their shadows are the cell/tile casters). Photos:
  shadow-street.png (city shadows intact), shadow-props.png (rooftop plant shadows crisp at street level).
- Still open from the five causes: the kept-frame store copy (48 MiB/frame - needs the mover-map sampled with max),
  occlusion for props/vehicles/people (depth pyramid), depth prepass + mask-free variants, vehicles/people
  per-cascade lists (small), the cloud-shadow MAP, the budget city/map architecture (tile fidelity cost).

---
## 2026-11-01 (6th) | the pools' occlusion — commit 93a768c
- Cause 2 of the GPU-100% list, fixed for the props pool (the heaviest): src/render/depthOcclusion.ts - a
  hierarchical depth pyramid (the farthest stored depth per cell, conservative) reduced from the previous frame's
  scene depth at post's frame end, tested in the props' cull compute (colour emit only; the shadow sweep keeps
  casters behind buildings). The instance's nearest point is pulled 1 m toward the camera and projected by the same
  matrices the frame renders with - no convention mismatch; one frame late, the standard scheme.
- Budget, before -> after: city DRAWS 191 -> 174 (back within the 179 limit), city drawn 7,104,467 -> 6,661,253,
  night 13,320,181 -> 12,451,699, street ~unchanged (a canyon), map unchanged (nothing occluded from above).
  Photo: occl-street.png (dense canyon, no holes, deeper blocks through the gaps as they are).
- Day total on the drawn loads: street 16.21M -> 15.36M, city 7.10M -> 6.66M, night 13.40M -> 12.45M.
- Still open: the kept-frame store copy (mover map + max sampling), depth prepass + mask-free variants for
  props/roads/terrain, vehicles/people per-cascade lists, the cloud-shadow map, the budget's city/map
  architecture (the tile fidelity cost stands until then).

# Prompt: entender o projeto e analisar onde ele está

> Cole o texto abaixo numa conversa nova do Claude Code aberta em
> `C:\Users\Jonathan\Documents\Projects\roadcraft-novo`.

---

Preciso que você entenda este projeto e faça uma análise honesta de onde ele está. Não comece a mudar código. Leia,
rode, olhe e me diga o que encontrou.

## O que estávamos fazendo antes

O jogo se chama **Roadcraft**: um construtor de cidades no navegador e no desktop (TypeScript, three.js, Vite,
Electron), para vender no Steam. Ele teve quatro versões em sequência. Todas estão em
`C:\Users\Jonathan\Documents\Projects\roadcraft\` (`roadcraft-2.0-main`, `roadcraft-3.0-main`, `roadcraft-4.0-main`).
A mais recente e completa é a **4.0**.

O Roadcraft tem **o visual e as funcionalidades que eu quero**:
- prédios bonitos e variados: 13 acabamentos com textura, caixilhos, peitoris, varandas, toldos, peças de fachada
  (ar-condicionado, vasos, varais), telhados com equipamentos, interiores vistos pelas janelas, salas acesas à noite,
  marcos arquitetônicos, um construtor de prédios completo;
- pessoas MakeHuman com roupas, cabelo, animação; carros detalhados; árvores, grama, água, céu, clima, dia e noite;
- vias com meio-fio, calçada, sinalização, semáforos, pontes, túneis, rotatórias, editor de seção transversal;
- trânsito simulado, transporte público, zonas e lotes, terreno editável, paisagismo;
- uma interface própria (dock com 7 categorias, barra de cima, painéis, inspetores).

Fotos do visual dele: `docs/referencia-visual/roadcraft-*.png`. A lista de recursos: `docs/RECURSOS.md`. Os textos
da interface (inventário de tudo o que ele faz): `data/textos-roadcraft/pt-BR.ts`.

## Por que desistimos do Roadcraft

Ele nunca conseguiu ter **cidade grande com desempenho**. Com poucos milhares de prédios o jogo já ficava lento,
gastava vários GB de memória, demorava minutos para gerar a cidade e travava ao editar. A meta (cidade cobrindo o mapa
inteiro de 10 km) era impossível na arquitetura dele: um objeto JavaScript por prédio, carro e pessoa; simulação e
geração na thread principal; cada edição refazendo coisas do mapa inteiro; prédios com ~10.800 vértices e 113 peças
cada; dezenas de chamadas de desenho por célula. Foram mais de 1.900 commits em uma semana tentando consertar, sem
chegar lá. O registro disso está em `docs/LICOES.md` e nos `docs/historico-*`.

## O que estamos fazendo agora

Este projeto (`roadcraft-novo`) partiu de **outro jogo**, o "Cidade" (`C:\Users\Jonathan\Documents\Projects\city-game\city-game`),
que tem uma arquitetura que aguenta cidades grandes: tabelas de números em vez de objetos, simulação e geração em
workers, níveis de detalhe por região, malhas geradas fora da thread principal, simulação de trânsito detalhada só
perto da câmera. Ele abre uma cidade de 10 km com ~38 mil prédios e ~1 milhão de moradores em segundos. A arquitetura
está descrita em `docs/ARQUITETURA.md`.

O problema do "Cidade" é o contrário do Roadcraft: **desempenho bom, mas visual pobre e poucas funcionalidades**.

O objetivo deste projeto é juntar os dois:
- **a qualidade visual do Roadcraft**, com tudo o que ele tem de visual;
- **todas as funcionalidades do Roadcraft**, funcionando;
- **a interface do Roadcraft**;
- **mantendo o desempenho**: criar e abrir cidades grandes (10 a 24 km), navegar sem travar, editar e ver o
  resultado na hora, abrir rápido, salvar e carregar rápido, usar pouca memória.

Hoje o projeto **não chegou lá, nem de longe**, principalmente no visual dos prédios. Houve várias sessões
trabalhando em paralelo (interface, prédios, pessoas, vias/terreno/luz, funcionalidades, empacotamento), cada uma num
ramo `claude/*`, integradas em `main` aos poucos. O que cada uma diz ter feito está em `docs/ESTADO.md`. Não confie
nisso: confira.

## O que eu quero de você

Uma análise, não uma implementação. Faça assim:

1. Leia `CLAUDE.md`, `docs/ESTADO.md`, `docs/ARQUITETURA.md`, `docs/LICOES.md`, `docs/RECURSOS.md`. Veja
   `git log --oneline -60`, `git branch -a` e `git worktree list`.
2. Rode na pasta: `npx tsc`, `npm test`, `npx vite build`, `npm run budget`, `node tools/verificar.mjs` e
   `node tools/fotos.mjs test-results/analise`. Abra as fotos com Read. (Use o Electron das ferramentas ou o Chrome
   headless pelo Playwright com `channel: 'chrome'`; não use o navegador embutido do app.)
3. Compare as fotos com `docs/referencia-visual/roadcraft-*.png`. Se precisar, rode o próprio Roadcraft 4.0 e tire
   fotos nas mesmas vistas para comparar lado a lado.
4. Para cada linha de `docs/RECURSOS.md`, confira no código e, quando der, no jogo, se o recurso existe e funciona.

Depois me responda, em português, de forma direta:
- **Visual:** o que está igual ao Roadcraft, o que está parecido e o que está longe. Seja específico por elemento
  (fachadas, janelas, telhados, peças, pessoas, carros, árvores, vias, luz, noite). Mostre as fotos que provam.
- **Funcionalidades:** quantas linhas de `RECURSOS.md` existem e funcionam, quantas existem só no código, quantas
  faltam. Liste as que faltam.
- **Interface:** se é a do Roadcraft ou não, e o que está faltando ou quebrado.
- **Desempenho:** os números de `npm run budget` (chamadas de desenho, triângulos, memória por vista), quanto tempo a
  cidade de 10 km leva para abrir, e se algo do que foi feito está repetindo os erros listados em `docs/LICOES.md`.
- **Qualidade do código e do processo:** se as sessões fizeram o que dizem que fizeram, se há coisas "provisórias",
  comentários em português (a regra é código em inglês), testes que não testam nada.
- **O caminho:** na sua opinião técnica, o que falta para chegar ao objetivo, em que ordem, e o que é mais arriscado.
  Em especial: como chegar ao visual dos prédios do Roadcraft sem perder o desempenho (há uma pesquisa em
  `docs/PESQUISA-PREDIOS.md`, se já existir).

Não diga que algo funciona sem ter visto. Se não conseguiu rodar ou olhar alguma coisa, diga que não conseguiu e por
quê.

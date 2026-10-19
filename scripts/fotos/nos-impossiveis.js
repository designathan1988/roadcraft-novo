// Foto dos nós impossíveis (Roadcraft: duas vias vizinhas a menos de 25° não fecham a junção). Na cidade gerada:
// conta, e aponta a câmera para o primeiro (a barra de cima da interface mostra a contagem por hudActions).
(async () => {
  const g = __cidade.game, H = g.hudActions;
  const list = H.impossibleList();
  console.log('RESULTADO impossiveis ' + JSON.stringify({ total: H.impossibleNodes(), primeiros: list.slice(0, 20) }));
  if (list.length) { await g.view(list[1], list[2], 30, 55, 120, 11); g.hud.toast(`${H.impossibleNodes()} nós impossíveis de construir · este: ${list[3].toFixed(0)}° entre duas vias`); }
})()

#!/bin/sh
# Foto do jogo sem GPU (SwiftShader). Uso: tools/shot.sh saida.png "?cam=x,z,yaw,pitch,dist&teste" [script js]
# Mais fotos na mesma sessão: CIDADE_SEQ='[["b.png", "__cidade.game.view(x,z,yaw,pitch,dist,hora)"]]'
cd "$(dirname "$0")/.."
CIDADE_SOFTWARE=1 CIDADE_SHOT="$1" CIDADE_QUERY="$2" CIDADE_SCRIPT="$3" CIDADE_W=${CIDADE_W:-1280} CIDADE_H=${CIDADE_H:-720} \
  timeout ${CIDADE_LIMIT:-280} xvfb-run -a -s "-screen 0 1920x1080x24" node_modules/.bin/electron . --no-sandbox 2>&1 \
  | grep --line-buffered "página\|estado\|foto\|script" | grep --line-buffered -v "Security\|unsafe-eval\|electronjs\|once the app\|experimental on this"

#!/bin/sh
# Roadcraft no navegador: sobe o servidor local (COOP/COEP) e abre o Chrome.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "O Roadcraft no navegador precisa do Node.js 20 ou mais novo: https://nodejs.org"
  exit 1
fi
exec node tools/serve.mjs --abrir

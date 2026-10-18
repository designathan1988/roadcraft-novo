import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Versão, commit e data da build (mostrados em Ajuda → Sobre). */
function stamp(): string {
  const v = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
  let hash = 'sem git';
  try { hash = execSync('git rev-parse --short HEAD').toString().trim(); } catch { /* fora do repositório */ }
  return `${v} · ${hash} · ${new Date().toISOString().slice(0, 10)}`;
}

// COOP/COEP: sem eles não existe SharedArrayBuffer.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base: './',
  define: { __BUILD__: JSON.stringify(stamp()) },
  server: { headers: isolation },
  preview: { headers: isolation },
  worker: { format: 'es' },
  build: { target: 'es2023', sourcemap: true, chunkSizeWarningLimit: 4000 },
});

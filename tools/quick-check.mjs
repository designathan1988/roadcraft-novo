// The check of one step (seconds, not the full suite): types, the architecture gate and the fast behaviour tests.
// The full gates (npm test, vite build, verificar, budget, photos) run when a whole piece of work closes.
// Usage: node tools/quick-check.mjs
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAST = ['lotsShortSide', 'blockLots', 'roadGround', 'citySpurs', 'gradeLine', 'mapExtra', 'mapLook', 'settings', 'viewState'];
const steps = [
  ['types', 'npx tsc --noEmit'],
  ['architecture', 'node tools/arch-audit.mjs --check tools/arch-baseline.json'],
  // no new write of World/network/items state outside its owner, no new module `let`, no uniform read as a source
  ['state owners', 'node tools/state-check.mjs --fail'],
  ['fast tests', `node --test ${FAST.map((t) => `test/${t}.test.ts`).join(' ')}`],
];
let failed = false;
for (const [name, cmd] of steps) {
  const t0 = Date.now();
  try { execSync(cmd, { cwd: root, stdio: 'pipe' }); console.log(`ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); }
  catch (e) { failed = true; console.log(`FAIL ${name}\n${String(e.stdout ?? '').slice(-1500)}${String(e.stderr ?? '').slice(-800)}`); }
}
process.exit(failed ? 1 : 0);

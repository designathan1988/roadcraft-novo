// Standard game screenshots with the machine's GPU: street, district, city and night, in the generated 10 km city (the
// 'standard' set of tools/photos/run.mjs; the views are tools/photos/views.mjs, shared with tools/budget.mjs).
// Usage: node tools/fotos.mjs [output-folder]   (runs over dist/: npm run build first)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = [path.join(root, 'tools', 'photos', 'run.mjs'), 'standard', ...(process.argv[2] ? [process.argv[2]] : [])];
const p = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
p.on('exit', (code) => process.exit(code ?? 0));

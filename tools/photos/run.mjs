// Photos of a named set (tools/photos/sets.mjs) in one game session with the machine's GPU, over dist/ (npm run build
// first). Usage: node tools/photos/run.mjs <set> [output folder] [shot ...]   (no shot: all of the set's)
// Sets: standard car cars people survey witness bus-turn bus-follow follow interface growth wear economy polygon-lots
//       manoeuvres impossible-nodes repair-quarantine transit
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { root } from '../checks/run.mjs';
import { SETS } from './sets.mjs';

const [name, outArg, ...only] = process.argv.slice(2);
const set = SETS[name];
if (!set) { console.error(`usage: node tools/photos/run.mjs <set> [output folder] [shot ...]\nsets: ${Object.keys(SETS).join(' ')}`); process.exit(2); }
const shots = only.length ? set.shots.filter(([n]) => only.includes(n)) : set.shots;
if (!shots.length) { console.error(`no shot named ${only.join(', ')} in ${name}`); process.exit(2); }
const out = path.resolve(outArg ?? path.join(root, 'test-results', 'photos', name));
// Electron cannot write a photo into a folder that does not exist
fs.mkdirSync(out, { recursive: true });
const query = set.queryFor ? set.queryFor(shots.map(([n]) => n)) : set.query;
const env = { ...process.env, ROADCRAFT_W: '1920', ROADCRAFT_H: '1080', ...(set.env ?? {}), ROADCRAFT_SEQ: JSON.stringify(shots.slice(1).map(([n, s]) => [path.join(out, `${n}.png`), s])) };
delete env.ELECTRON_RUN_AS_NODE;
const p = spawn(process.execPath, [path.join(root, 'tools', 'shot.mjs'), path.join(out, `${shots[0][0]}.png`), query, shots[0][1]], { cwd: root, env, stdio: 'inherit' });
p.on('exit', (code) => process.exit(code ?? 0));

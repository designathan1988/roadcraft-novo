// The in-game check runner shared by tools/check-*.mjs: one Electron session per scenario body (tools/shot.mjs over
// dist/, the machine's GPU), the body wrapped with the check's PRELUDE, the `CHECK OK|FAILED name: why` lines collected,
// a session that never printed `CHECK END` reported as hung. Each check keeps its own scenarios and prelude.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The page script for one scenario body: the prelude, the body, a thrown error as a failed check, then `CHECK END`. */
export function wrap(prelude, body) {
  return `(async()=>{${prelude}\ntry {${body}\n} catch (e) { check('scenario ran to the end', false, e && e.stack || e); }\nconsole.log('CHECK END');})()`;
}

/**
 * Runs one session: `script` in the page opened at `query`, user data in `own` (a folder of the scenario). Resolves
 * with every stdout line. `env` adds to the process environment (no settle after the script: each scenario waits for its own conditions; ROADCRAFT_LIMIT 300 by default);
 * `onLine(line, child)` sees each line as it comes (a session that asks the shell for something mid-run).
 */
export function session({ query, script, own, env = {}, shot = path.join(own, 'shot.png'), onLine }) {
  return new Promise((resolve) => {
    const out = [];
    // the script by file: a command line holds 32 KB on Windows
    const file = path.join(own, `script-${Date.now()}.js`);
    fs.writeFileSync(file, script);
    const p = spawn(process.execPath, [path.join(root, 'tools', 'shot.mjs'), shot, query, '@' + file],
      { cwd: root, env: { ...process.env, ROADCRAFT_USER_DATA: own, ROADCRAFT_SETTLE: '0', ROADCRAFT_LIMIT: '300', ...env } });
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); out.push(line); buf = buf.slice(i + 1); onLine?.(line, p); }
    });
    p.on('exit', () => { if (buf) out.push(buf); resolve(out); });
  });
}

/** The CHECK results of a session's lines; a session that did not reach `CHECK END` adds a failure saying where it stopped. */
export function checksOf(lines) {
  const got = lines.filter((l) => l.includes('CHECK ')).map((l) => l.slice(l.indexOf('CHECK ') + 6).trim());
  if (!got.includes('END')) got.push('FAILED the session did not finish (hung or crashed) after: ' + (got[got.length - 1] ?? 'nothing'));
  return got.filter((c) => c !== 'END');
}

/** A fresh folder for a scenario's user data and captures; `done` removes it (CHECK_KEEP=folder keeps the captures). */
export function scenarioFolder(prefix, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    done() {
      if (process.env.CHECK_KEEP) {
        fs.mkdirSync(process.env.CHECK_KEEP, { recursive: true });
        for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.png'))) fs.copyFileSync(path.join(dir, f), path.join(process.env.CHECK_KEEP, `${name}-${f}`));
      }
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

/** Prints a scenario's results; returns how many failed. */
export function report(name, checks) {
  const bad = checks.filter((c) => c.startsWith('FAILED'));
  console.log(`${name}: ${checks.filter((c) => c.startsWith('OK')).length} ok, ${bad.length} failed`);
  for (const c of checks) console.log('  ' + c);
  return bad.length;
}

/**
 * One game for many scenarios: the page script runs `prelude` once, then for each scenario prints `CHECK SCENARIO name`,
 * puts the game back as it started (`reset`, page code) and runs the body in a function of its own (its names do not
 * reach the next one). Starting a game costs more than most scenarios (a 54-scenario check spent 980 of its 1,017 s
 * starting games); the scenarios that test the start itself, a URL, the window or closing keep a session of their own.
 */
export function sharedScript(prelude, reset, scenarios) {
  const parts = scenarios.map(([name, body]) => `console.log('CHECK SCENARIO ' + ${JSON.stringify(name)});
try { await __reset(); await (async () => {${body}
})(); } catch (e) { check('scenario ran to the end', false, e && e.stack || e); }`);
  return `(async()=>{${prelude}\nconst __reset = async () => {${reset}\n};\n${parts.join('\n')}\nconsole.log('CHECK END');})()`;
}

/**
 * The state a fresh ?empty session starts in, taken once in the page (`__start`, needs `R` and `w`), and the reset that
 * puts it back before each shared scenario: the same empty map from the same seed, the hour, the camera, no tool,
 * panels or toasts, the options, the language, the browser storage, the clock and the growth as they were.
 */
export const FRESH_SNAPSHOT = `
const __start = { seed: w.seed, lang: R.lang(), options: JSON.stringify(R.options.get()), paused: R.sim.paused(),
  growth: R.cities.growthRate(), unlimited: w.unlimited, pose: R.camera.pose(), hour: R.sky.hour(),
  storage: Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]) };
`;
export const FRESH_RESET = `
  for (let k = 0; k < 4; k++) window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }));
  R.tools.set('camera');
  localStorage.clear(); for (const [k, v] of __start.storage) localStorage.setItem(k, v);
  if (R.lang() !== __start.lang) R.setLang(__start.lang);
  if (JSON.stringify(R.options.get()) !== __start.options) await R.options.apply(JSON.parse(__start.options));
  R.sim.speed(__start.paused ? 0 : 1);
  R.cities.growthRate(__start.growth);
  w.unlimited = __start.unlimited;
  await R.saves.newMap(__start.seed);
  R.sky.setHour(__start.hour);
  { const p = __start.pose; await R.camera.view(p.x, p.z, p.yaw, p.pitch, p.dist); }
  for (const e of document.querySelectorAll('.v2-toast')) e.remove();
`;

/** The checks of a shared session, per scenario (a session cut short fails the scenario it stopped in and every one after). */
export function checksByScenario(lines, names) {
  const by = new Map(names.map((n) => [n, []]));
  let cur = null, ended = false;
  for (const l of lines) {
    if (!l.includes('CHECK ')) continue;
    const c = l.slice(l.indexOf('CHECK ') + 6).trim();
    if (c.startsWith('SCENARIO ')) { cur = c.slice(9); continue; }
    if (c === 'END') { ended = true; continue; }
    if (cur && by.has(cur)) by.get(cur).push(c);
  }
  if (!ended) {
    const at = cur ? names.indexOf(cur) : 0;
    for (const n of names.slice(Math.max(0, at))) by.get(n).push('FAILED the shared session did not finish (hung or crashed) in ' + (cur ?? 'its start'));
  }
  return by;
}

/** How many scenarios run at once: one (CHECK_JOBS may ask for more; the time goes to starting games, not to testing). */
export const JOBS = Math.max(1, Number(process.env.CHECK_JOBS ?? 1));

/**
 * Runs `fn(name)` (a scenario's checks) over `names`, `jobs` at once; the reports are printed in the scenarios' order as
 * soon as each one and those before it are done. Returns how many checks failed.
 */
export async function eachScenario(names, fn, jobs = JOBS) {
  const results = new Array(names.length);
  let next = 0, printed = 0, failed = 0;
  const flush = () => { while (printed < names.length && results[printed] !== undefined) { failed += report(names[printed], results[printed]); printed++; } };
  await Promise.all(Array.from({ length: Math.min(jobs, names.length) }, async () => {
    for (let i = next++; i < names.length; i = next++) { results[i] = await fn(names[i]); flush(); }
  }));
  return failed;
}

/** The scenario names asked on the command line (all when none), unknown names reported as failures. */
export function pick(scenarios) {
  const asked = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const names = asked.length ? asked : Object.keys(scenarios);
  const unknown = names.filter((n) => !(n in scenarios));
  for (const n of unknown) console.log(`unknown scenario ${n}`);
  return { names: names.filter((n) => n in scenarios), unknown: unknown.length };
}

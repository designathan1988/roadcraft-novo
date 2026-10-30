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
 * with every stdout line. `env` adds to the process environment (ROADCRAFT_SETTLE 1 and ROADCRAFT_LIMIT 300 by default);
 * `onLine(line, child)` sees each line as it comes (a session that asks the shell for something mid-run).
 */
export function session({ query, script, own, env = {}, shot = path.join(own, 'shot.png'), onLine }) {
  return new Promise((resolve) => {
    const out = [];
    const p = spawn(process.execPath, [path.join(root, 'tools', 'shot.mjs'), shot, query, script],
      { cwd: root, env: { ...process.env, ROADCRAFT_USER_DATA: own, ROADCRAFT_SETTLE: '1', ROADCRAFT_LIMIT: '300', ...env } });
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

/** The scenario names asked on the command line (all when none), unknown names reported as failures. */
export function pick(scenarios) {
  const asked = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const names = asked.length ? asked : Object.keys(scenarios);
  const unknown = names.filter((n) => !(n in scenarios));
  for (const n of unknown) console.log(`unknown scenario ${n}`);
  return { names: names.filter((n) => n in scenarios), unknown: unknown.length };
}

// The DevTools protocol client shared by the checks and the probe: find a page on a debugging port, talk to it
// (commands by id, page console lines collected), wait for the game to be ready. Electron (`--remote-debugging-port`)
// and Chrome both serve it.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The first page target on `port` whose url passes `accept`, waited for up to `tries` × `every` ms; null if none. */
export async function findPage(port, accept, { tries = 120, every = 500 } = {}) {
  for (let k = 0; k < tries; k++) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && accept(t.url));
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(every);
  }
  return null;
}

/**
 * A connection to one target: `send(method, params)` resolves with the reply, `evaluate(expr)` with the value (awaited,
 * by value), `lines` holds the page's console output once `Runtime.enable` was sent, `on(method, fn)` listens to events.
 */
export async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let seq = 0;
  const pending = new Map(), listeners = new Map();
  const tab = {
    id: target.id, ws, lines: [],
    send(method, params = {}) { return new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); }); },
    async evaluate(expression) { return (await tab.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value; },
    on(method, fn) { listeners.set(method, [...(listeners.get(method) ?? []), fn]); },
    close() { try { ws.close(); } catch { /* gone */ } },
  };
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled') tab.lines.push(m.params.args.map((x) => x.value ?? x.description ?? '').join(' '));
    for (const fn of listeners.get(m.method) ?? []) fn(m.params);
  });
  return tab;
}

/** Waits until the game says it is ready (`window.__roadcraft.status === 'ready'`); false after `ms`. */
export async function waitReady(tab, ms = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await tab.evaluate('window.__roadcraft?.status ?? "loading"') === 'ready') return true;
    await sleep(500);
  }
  return false;
}

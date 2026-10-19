// Electron shell. Serves the project through its own protocol with COOP/COEP,
// so the page gets SharedArrayBuffer, and turns on WebGPU where it needs a flag.
// CIDADE_SHOT=file.png takes a screenshot when the game is ready and exits.
import { app, BrowserWindow, protocol, net, ipcMain } from 'electron';
import { initSteam, enableOverlay, steamInfo, unlock } from './steam.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, '..', 'dist');
const devUrl = process.env.CIDADE_DEV_URL;
const shot = process.env.CIDADE_SHOT;
const query = process.env.CIDADE_QUERY ?? '';

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-unsafe-webgpu');
  app.commandLine.appendSwitch('enable-features', 'Vulkan,VulkanFromANGLE,DefaultANGLEVulkan');
}
if (shot) {
  // hidden screenshot window: without this Chromium throttles frames (2 per second) and the scene runs slowly
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}
if (process.env.CIDADE_NOVSYNC) {
  // performance measurement: without the display limit (60 frames), rAF counts how many frames the machine can do
  app.commandLine.appendSwitch('disable-frame-rate-limit');
  app.commandLine.appendSwitch('disable-gpu-vsync');
}
if (process.env.CIDADE_SOFTWARE) {
  // no GPU (server): WebGPU and WebGL through SwiftShader
  app.commandLine.appendSwitch('use-vulkan', 'swiftshader');
  app.commandLine.appendSwitch('use-webgpu-adapter', 'swiftshader');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
}

// One game at a time: a second copy would share the save storage (OPFS in the user data folder) and both would
// fail to write. The second one hands over to the first and quits.
app.setName('Roadcraft');
// Screenshot and test runs get a user data folder of their own (CIDADE_USER_DATA, or a fresh one in the temp folder,
// removed on exit): they edit, save and autosave, and must never touch the player's saves in the game's folder.
if (shot) {
  const own = process.env.CIDADE_USER_DATA ?? fs.mkdtempSync(path.join(os.tmpdir(), 'roadcraft-shot-'));
  app.setPath('userData', own);
  console.log(`userData: ${own}`);
  if (!process.env.CIDADE_USER_DATA) process.on('exit', () => { try { fs.rmSync(own, { recursive: true, force: true, maxRetries: 3 }); } catch { /* left for the system to clean */ } });
}
if (!shot && !app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => {
  const w = BrowserWindow.getAllWindows()[0];
  if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
});

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function createWindow() {
  const win = new BrowserWindow({
    // visible screenshot window (otherwise Chromium throttles frames), but off screen
    ...(shot && process.env.CIDADE_SHOW !== 'tela' ? { x: -20000, y: -20000 } : {}),
    width: Number(process.env.CIDADE_W ?? 1600),
    height: Number(process.env.CIDADE_H ?? 900),
    show: !shot,
    backgroundColor: '#0c0f14',
    autoHideMenuBar: true,
    title: 'Roadcraft',
    icon: path.join(here, 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: false, preload: path.join(here, 'preload.cjs') },
  });
  win.loadURL(devUrl ?? `app://cidade/index.html${query}`);
  // Closing saves first: the page is asked, saves what is not saved yet and answers; past the time limit the window
  // closes anyway. Screenshot runs close without it unless CIDADE_CLOSE_SAVES is set (the save checks set it).
  if (!shot || process.env.CIDADE_CLOSE_SAVES) {
    let asked = false;
    win.on('close', (e) => {
      if (asked) return;
      asked = true;
      e.preventDefault();
      const close = () => { if (!win.isDestroyed()) win.destroy(); };
      const limit = setTimeout(close, 30000);
      ipcMain.once('app:can-close', () => { clearTimeout(limit); close(); });
      win.webContents.send('app:closing');
    });
  }
  // screenshot: show without taking focus (the keyboard stays with whoever is using the machine)
  if (shot) win.showInactive();
  if (shot) {
    win.webContents.on('console-message', (e) => console.log(`[page] ${e.message}`));
    win.webContents.once('did-finish-load', async () => {
      const t0 = Date.now();
      const limit = Number(process.env.CIDADE_TIMEOUT ?? 240) * 1000;
      for (;;) {
        const s = await win.webContents.executeJavaScript('window.__cidade?.status ?? "carregando"').catch(() => 'error');
        if (s === 'pronto' || s === 'falhou' || Date.now() - t0 > limit) { console.log(`state: ${s} after ${((Date.now() - t0) / 1000).toFixed(1)} s`); break; }
        await new Promise((r) => setTimeout(r, 500));
      }
      // CIDADE_SEQ: more screenshots in the same session, JSON [[file, script], ...]
      const seq = [[shot, process.env.CIDADE_SCRIPT], ...JSON.parse(process.env.CIDADE_SEQ || '[]')];
      for (const [file, script] of seq) {
        if (script) await win.webContents.executeJavaScript(script).catch((e) => console.log('script:', e.message));
        await new Promise((r) => setTimeout(r, Number(process.env.CIDADE_SETTLE ?? 3) * 1000));
        const img = await win.webContents.capturePage();
        fs.writeFileSync(file, img.toPNG());
        console.log(`photo: ${file}`);
        // CIDADE_DIFF=ms: another capture after that time; measures what changed (shake, noise) and writes the difference map
        if (process.env.CIDADE_DIFF) {
          const fps = await win.webContents.executeJavaScript('new Promise((r)=>{let n=0;const t0=performance.now();const f=()=>{n++;if(performance.now()-t0<1000)requestAnimationFrame(f);else r(n)};requestAnimationFrame(f)})').catch(() => -1);
          await new Promise((r) => setTimeout(r, Number(process.env.CIDADE_DIFF)));
          const img2 = await win.webContents.capturePage();
          const a = img.toBitmap(), b = img2.toBitmap();
          const { width, height } = img.getSize();
          const out = Buffer.alloc(a.length);
          let changed = 0, sum = 0;
          for (let i = 0; i < a.length; i += 4) {
            const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
            sum += d;
            if (d > 24) changed++;
            const v = Math.min(255, d * 4);
            out[i] = v; out[i + 1] = v; out[i + 2] = v; out[i + 3] = 255;
          }
          const px = a.length / 4;
          console.log(`diff: ${(changed / px * 100).toFixed(2)}% of pixels changed, mean ${(sum / px).toFixed(2)}, ${fps} frames/s`);
          const { nativeImage } = await import('electron');
          fs.writeFileSync(file.replace(/\.png$/, '_diff.png'), nativeImage.createFromBitmap(out, { width, height }).toPNG());
        }
      }
      app.quit();
    });
  }
}

const steamOn = initSteam(path.resolve(here, '..'));
ipcMain.handle('steam:info', () => steamInfo());
ipcMain.handle('steam:unlock', (_e, id) => unlock(id));
// the game's own Quit: closes the window the normal way, so it saves first
ipcMain.on('app:quit', (e) => BrowserWindow.fromWebContents(e.sender)?.close());

app.whenReady().then(() => {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(rootDir, rel);
    if (!file.startsWith(rootDir)) return new Response('not found', { status: 404 });
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(isolation)) headers.set(k, v);
    if (file.endsWith('.js') || file.endsWith('.mjs')) headers.set('Content-Type', 'text/javascript');
    if (file.endsWith('.wasm')) headers.set('Content-Type', 'application/wasm');
    return new Response(res.body, { status: res.status, headers });
  });
  createWindow();
});

app.on('window-all-closed', () => app.quit());
if (steamOn) enableOverlay();

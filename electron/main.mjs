// Casca Electron. Serve o projeto por um protocolo próprio com COOP/COEP,
// para a página ter SharedArrayBuffer, e liga WebGPU onde precisa de flag.
// CIDADE_SHOT=arquivo.png tira uma foto da tela quando o jogo fica pronto e sai.
import { app, BrowserWindow, protocol, net, ipcMain } from 'electron';
import { initSteam, enableOverlay, steamInfo, unlock } from './steam.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
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
  // janela de foto escondida: sem isso o Chromium freia os quadros (2 por segundo) e a cena anda devagar
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}
if (process.env.CIDADE_NOVSYNC) {
  // medição de desempenho: sem o limite da tela (60 quadros), o rAF conta quantos quadros a máquina faz
  app.commandLine.appendSwitch('disable-frame-rate-limit');
  app.commandLine.appendSwitch('disable-gpu-vsync');
}
if (process.env.CIDADE_SOFTWARE) {
  // sem GPU (servidor): WebGPU e WebGL pelo SwiftShader
  app.commandLine.appendSwitch('use-vulkan', 'swiftshader');
  app.commandLine.appendSwitch('use-webgpu-adapter', 'swiftshader');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
}

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
    // janela de foto visível (senão o Chromium freia os quadros), mas fora da tela
    ...(shot && process.env.CIDADE_SHOW !== 'tela' ? { x: -20000, y: -20000 } : {}),
    width: Number(process.env.CIDADE_W ?? 1600),
    height: Number(process.env.CIDADE_H ?? 900),
    show: !shot,
    backgroundColor: '#0c0f14',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: false, preload: path.join(here, 'preload.cjs') },
  });
  win.loadURL(devUrl ?? `app://cidade/index.html${query}`);
  // foto: mostra sem tomar o foco (o teclado continua com quem está usando a máquina)
  if (shot) win.showInactive();
  if (shot) {
    win.webContents.on('console-message', (e) => console.log(`[página] ${e.message}`));
    win.webContents.once('did-finish-load', async () => {
      const t0 = Date.now();
      const limit = Number(process.env.CIDADE_TIMEOUT ?? 240) * 1000;
      for (;;) {
        const s = await win.webContents.executeJavaScript('window.__cidade?.status ?? "carregando"').catch(() => 'erro');
        if (s === 'pronto' || s === 'falhou' || Date.now() - t0 > limit) { console.log(`estado: ${s} em ${((Date.now() - t0) / 1000).toFixed(1)} s`); break; }
        await new Promise((r) => setTimeout(r, 500));
      }
      // CIDADE_SEQ: mais fotos na mesma sessão, JSON [[arquivo, script], ...]
      const seq = [[shot, process.env.CIDADE_SCRIPT], ...JSON.parse(process.env.CIDADE_SEQ || '[]')];
      for (const [file, script] of seq) {
        if (script) await win.webContents.executeJavaScript(script).catch((e) => console.log('script:', e.message));
        await new Promise((r) => setTimeout(r, Number(process.env.CIDADE_SETTLE ?? 3) * 1000));
        const img = await win.webContents.capturePage();
        fs.writeFileSync(file, img.toPNG());
        console.log(`foto: ${file}`);
        // CIDADE_DIFF=ms: outra captura depois desse tempo; mede o que mudou (tremor, ruído) e grava o mapa da diferença
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
          console.log(`diferença: ${(changed / px * 100).toFixed(2)}% dos pixels mudaram, média ${(sum / px).toFixed(2)}, ${fps} quadros/s`);
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

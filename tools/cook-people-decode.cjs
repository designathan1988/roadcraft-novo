// Electron main for `tools/cook-people.mjs`: decodes the WebP textures of the MakeHuman assets into raw RGBA
// (Node has no WebP decoder; Chromium does). Reads a JSON job from COOK_DECODE_JOB:
//   { files: [{ src, out, size }] }  -> each `out` gets [u32 width][u32 height][RGBA bytes], at most `size` per side.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const job = JSON.parse(fs.readFileSync(process.env.COOK_DECODE_JOB, 'utf8'));
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  await win.loadURL('data:text/html,<html></html>');
  let failed = 0;
  for (const f of job.files) {
    const b64 = fs.readFileSync(f.src).toString('base64');
    try {
      const out = await win.webContents.executeJavaScript(`(async () => {
        const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
        const full = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }));
        const k = Math.min(1, ${f.size} / Math.max(full.width, full.height));
        const w = Math.max(1, Math.round(full.width * k)), h = Math.max(1, Math.round(full.height * k));
        const c = new OffscreenCanvas(w, h);
        const g = c.getContext('2d');
        g.drawImage(full, 0, 0, w, h);
        const d = g.getImageData(0, 0, w, h).data;
        let s = '';
        for (let i = 0; i < d.length; i += 8192) s += String.fromCharCode.apply(null, d.subarray(i, i + 8192));
        return { w, h, data: btoa(s) };
      })()`);
      const head = Buffer.alloc(8);
      head.writeUInt32LE(out.w, 0); head.writeUInt32LE(out.h, 4);
      fs.mkdirSync(path.dirname(f.out), { recursive: true });
      fs.writeFileSync(f.out, Buffer.concat([head, Buffer.from(out.data, 'base64')]));
    } catch (e) {
      failed++;
      console.error(`decode failed: ${f.src}: ${e}`);
    }
  }
  console.log(`decoded ${job.files.length - failed} of ${job.files.length} textures`);
  app.exit(failed ? 1 : 0);
});

// Finds what blinks: the camera is stepped by a tiny amount, one screenshot per step, and a pixel that differs from both
// its neighbours in time while those two agree was only there (or only missing) for one step. Each cluster of such pixels
// is written as a crop, the frame before and the frame itself side by side. What a person sees as a flash too quick to
// name is then a picture to look at.
// Usage: npx vite build && node tools/flicker.mjs [--view=street|district|city] [--steps=60] [--yaw=0.002 (radians a step)] [--dist=0] [--query=extra] [--out=dir]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { connect, findPage, waitReady } from './checks/cdp.mjs';
import { root } from './checks/run.mjs';
import { VIEWS, viewScript } from './photos/views.mjs';

const flag = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const steps = Number(flag('steps', 60)), yawStep = Number(flag('yaw', 0.002)), distStep = Number(flag('dist', 0));
const extra = flag('query', ''), name = flag('view', 'street');
const out = path.resolve(root, flag('out', `test-results/flicker/${name}`));
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 8-bit RGB or RGBA, not interlaced (what the DevTools screenshot writes). */
function decodePng(buf) {
  let o = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8);
    if (type === 'IHDR') { w = buf.readUInt32BE(o + 8); h = buf.readUInt32BE(o + 12); ct = buf[o + 17]; }
    if (type === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3, stride = w * bpp, raw = zlib.inflateSync(Buffer.concat(idat)), px = new Uint8Array(w * h * 3);
  const prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], s = y * (stride + 1) + 1;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0, x = raw[s + i];
      let v = x;
      if (f === 1) v = x + a; else if (f === 2) v = x + b; else if (f === 3) v = x + ((a + b) >> 1);
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) { const i = x * bpp, d = (y * w + x) * 3; px[d] = cur[i]; px[d + 1] = cur[i + 1]; px[d + 2] = cur[i + 2]; }
    prev.set(cur);
  }
  return { w, h, px };
}

const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function encodePng(w, h, rgb) {
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t, 'latin1'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) rgb.subarray(y * w * 3, (y + 1) * w * 3).forEach((v, i) => { raw[y * (w * 3 + 1) + 1 + i] = v; });
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** The side-by-side crop (a, b, c: three frames) around a box, enlarged `k` times. */
function crop(fr, x0, y0, x1, y1, k) {
  const m = 24; x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(fr[0].w - 1, x1 + m); y1 = Math.min(fr[0].h - 1, y1 + m);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1, W = (cw * k + 6) * fr.length, H = ch * k, rgb = new Uint8Array(W * H * 3).fill(255);
  fr.forEach((f, n) => { for (let y = 0; y < H; y++) for (let x = 0; x < cw * k; x++) { const s = ((y0 + ((y / k) | 0)) * f.w + x0 + ((x / k) | 0)) * 3, d = (y * W + n * (cw * k + 6) + x) * 3; rgb[d] = f.px[s]; rgb[d + 1] = f.px[s + 1]; rgb[d + 2] = f.px[s + 2]; } });
  return { W, H, rgb };
}

/** Pixels that blink in `b` against `a` and `c`, grouped in 8 px tiles and joined into boxes. */
function blinks(a, b, c) {
  const { w, h } = b, T = 8, tw = Math.ceil(w / T), th = Math.ceil(h / T), hits = new Uint16Array(tw * th);
  let total = 0;
  const dist = (p, q, i) => Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    if (dist(b.px, a.px, i) > 70 && dist(b.px, c.px, i) > 70 && dist(a.px, c.px, i) < 36) { hits[((y / T) | 0) * tw + ((x / T) | 0)]++; total++; }
  }
  const seen = new Uint8Array(tw * th), boxes = [];
  for (let s = 0; s < tw * th; s++) {
    if (hits[s] < 3 || seen[s]) continue;
    const st = [s]; seen[s] = 1; let x0 = 1e9, y0 = 1e9, x1 = 0, y1 = 0, n = 0;
    while (st.length) {
      const t = st.pop(), tx = t % tw, ty = (t / tw) | 0; n += hits[t];
      x0 = Math.min(x0, tx); x1 = Math.max(x1, tx); y0 = Math.min(y0, ty); y1 = Math.max(y1, ty);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = tx + dx, ny = ty + dy; if (nx < 0 || ny < 0 || nx >= tw || ny >= th) continue; const q = ny * tw + nx; if (hits[q] >= 3 && !seen[q]) { seen[q] = 1; st.push(q); } }
    }
    boxes.push({ x0: x0 * T, y0: y0 * T, x1: x1 * T + T - 1, y1: y1 * T + T - 1, n });
  }
  return { total, boxes: boxes.sort((p, q) => q.n - p.n) };
}

const exe = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const own = fs.mkdtempSync(path.join(os.tmpdir(), 'roadcraft-flicker-'));
const port = 9700 + Math.floor(Math.random() * 90);
const query = `?city${flag('map', '4') === '4' ? '&medium' : ''}&map=${flag('map', '4')}&clear&hour=${(VIEWS.find((v) => v.name === name) ?? VIEWS[0]).hour}&perf${extra ? '&' + extra : ''}`;
const env = { ...process.env, ROADCRAFT_SHOT: path.join(own, 'shot.png'), ROADCRAFT_QUERY: query, ROADCRAFT_SCRIPT: '1', ROADCRAFT_SETTLE: '7200', ROADCRAFT_USER_DATA: own, ROADCRAFT_W: flag('w', '1600'), ROADCRAFT_H: flag('h', '900'), ROADCRAFT_NOVSYNC: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(exe, ['.', `--remote-debugging-port=${port}`], { cwd: root, env, stdio: 'ignore' });
// stopped from outside, it never leaves the game running
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { child.kill(); process.exit(130); });
let code = 0;
try {
  const target = await findPage(port, (u) => u.startsWith('app://'), { tries: 240, every: 500 });
  if (!target) throw new Error('the game did not open');
  const tab = await connect(target);
  if (!await waitReady(tab, 600000)) throw new Error('the game did not get ready');
  await tab.send('Page.enable');
  const v = VIEWS.find((x) => x.name === name);
  await Promise.race([tab.evaluate(`(async () => { await ${viewScript(v, { after: `await R.frames.settle(20); R.ui.speed(${flag('speed', 0)});` })}; return 1; })()`), sleep(120000)]);
  await sleep(1500);
  // only the scene: a toast fading or a tooltip under the mouse is not the render
  await tab.evaluate("document.getElementById('hud').style.display = 'none'");
  const pose = await tab.evaluate('window.__roadcraft.camera.pose()');
  console.log('pose', JSON.stringify(pose));
  const rate = await tab.evaluate(`new Promise((r) => { let n = 0; const t0 = performance.now(); const f = () => { if (++n < 30) requestAnimationFrame(f); else r(30000 / (performance.now() - t0)); }; requestAnimationFrame(f); })`);
  console.log('rAF rate', rate?.toFixed?.(1));
  const shot = async () => decodePng(Buffer.from((await tab.send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
  const yaw0 = pose.yaw ?? 0, dist0 = pose.dist ?? 0;
  const frames = [];
  let found = 0, totalBlink = 0;
  // what no blink test sees: a surface that never settles. With the camera still, each pixel's change between frames adds up
  let heat = null, noisy = 0, pairs = 0, last = null;
  const report = [];
  for (let k = 0; k <= steps; k++) {
    await tab.evaluate(`new Promise((r) => { window.__roadcraft.camera.place({ yaw: ${yaw0 + k * yawStep}${distStep ? `, dist: ${dist0 + k * distStep}` : ''} }); requestAnimationFrame(() => requestAnimationFrame(r)); })`);
    frames.push(await shot());
    const fresh = frames[frames.length - 1];
    if (last) {
      heat ??= new Float32Array(fresh.w * fresh.h);
      pairs++;
      for (let i = 0; i < heat.length; i++) { const o = i * 3, d = Math.abs(fresh.px[o] - last.px[o]) + Math.abs(fresh.px[o + 1] - last.px[o + 1]) + Math.abs(fresh.px[o + 2] - last.px[o + 2]); heat[i] += d; if (d > 24) noisy++; }
    }
    last = fresh;
    if (frames.length < 3) continue;
    if (frames.length > 3) frames.shift();
    const [a, b, c] = frames, r = blinks(a, b, c);
    totalBlink += r.total;
    if (r.total) report.push({ step: k - 1, pixels: r.total, boxes: r.boxes.slice(0, 4) });
    for (const box of r.boxes.slice(0, 2)) {
      if (found >= 16) break;
      const size = Math.max(box.x1 - box.x0, box.y1 - box.y0), z = size < 60 ? 4 : size < 160 ? 2 : 1;
      const cr = crop([a, b, c], box.x0, box.y0, box.x1, box.y1, z);
      fs.writeFileSync(path.join(out, `blink-${String(found).padStart(2, '0')}-s${k - 1}.png`), encodePng(cr.W, cr.H, cr.rgb));
      found++;
    }
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
  if (heat) {
    const hw = last.w, hh = last.h, rgb = new Uint8Array(hw * hh * 3);
    for (let i = 0; i < hw * hh; i++) { const v = Math.min(255, heat[i] / pairs * 4); rgb[i * 3] = v; rgb[i * 3 + 1] = v; rgb[i * 3 + 2] = v; }
    fs.writeFileSync(path.join(out, 'heat.png'), encodePng(hw, hh, rgb));
    fs.writeFileSync(path.join(out, 'last.png'), encodePng(hw, hh, last.px));
    console.log(`noise: ${(noisy / pairs).toFixed(0)} pixels changed a frame pair, of ${hw * hh}`);
  }
  console.log(`view ${name}: ${report.length} of ${steps - 1} steps blink, ${totalBlink} pixels, ${found} crops in ${path.relative(root, out)}`);
  tab.close();
} catch (err) {
  console.log('error: ' + (err && err.stack || err));
  code = 1;
} finally {
  child.kill();
  await sleep(1500);
  fs.rmSync(own, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(code);

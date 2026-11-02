// A BC7 block encoder, mode 6: one subset, RGBA endpoints of 7 bits plus a shared low bit each, 4-bit indices. The endpoints
// sit on the block's principal axis, then are refitted by least squares over the indices they gave.
// (Khronos Data Format Specification, BC7; Microsoft "BC7 Format".)

const WEIGHTS = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];
const pal = new Int32Array(64), idx = new Uint8Array(16), best = new Uint8Array(16);
const bestE = new Int32Array(8), e8 = new Int32Array(8);

/** The block's indices and squared error for the endpoints `e8` (8 bits each, as the decoder expands them). */
function fit() {
  for (let w = 0; w < 16; w++) for (let c = 0; c < 4; c++) pal[w * 4 + c] = ((64 - WEIGHTS[w]) * e8[c] + WEIGHTS[w] * e8[4 + c] + 32) >> 6;
}

function assign(px) {
  fit();
  let err = 0;
  for (let i = 0; i < 16; i++) {
    const o = i * 4, r = px[o], g = px[o + 1], b = px[o + 2], a = px[o + 3];
    let low = 1e9, at = 0;
    for (let w = 0; w < 16; w++) {
      const p = w * 4, dr = pal[p] - r, dg = pal[p + 1] - g, db = pal[p + 2] - b, da = pal[p + 3] - a, d = dr * dr + dg * dg + db * db + da * da;
      if (d < low) { low = d; at = w; }
    }
    idx[i] = at;
    err += low;
  }
  return err;
}

/** Two float endpoints to 7 + 1 bits: the shared low bit each takes is the one nearer. */
function quantize(lo, hi) {
  for (let side = 0; side < 2; side++) {
    const v = side ? hi : lo, at = side * 4;
    let bestErr = 1e18, bestP = 0;
    for (let p = 0; p < 2; p++) {
      let d = 0;
      for (let c = 0; c < 4; c++) { const q = Math.max(0, Math.min(127, Math.round((v[c] - p) / 2))), dv = ((q << 1) | p) - v[c]; d += dv * dv; }
      if (d < bestErr) { bestErr = d; bestP = p; }
    }
    for (let c = 0; c < 4; c++) e8[at + c] = (Math.max(0, Math.min(127, Math.round((v[c] - bestP) / 2))) << 1) | bestP;
  }
}

const mean = new Float64Array(4), axis = new Float64Array(4), lo = new Float64Array(4), hi = new Float64Array(4), cov = new Float64Array(16);

function principal(px) {
  mean.fill(0);
  for (let i = 0; i < 16; i++) for (let c = 0; c < 4; c++) mean[c] += px[i * 4 + c] / 16;
  cov.fill(0);
  for (let i = 0; i < 16; i++) {
    for (let a = 0; a < 4; a++) { const da = px[i * 4 + a] - mean[a]; for (let b = 0; b < 4; b++) cov[a * 4 + b] += da * (px[i * 4 + b] - mean[b]); }
  }
  axis[0] = 1; axis[1] = 0.9; axis[2] = 0.8; axis[3] = 0.7;
  for (let k = 0; k < 6; k++) {
    let x = 0, y = 0, z = 0, w = 0;
    for (let c = 0; c < 4; c++) { x += cov[c] * axis[c]; y += cov[4 + c] * axis[c]; z += cov[8 + c] * axis[c]; w += cov[12 + c] * axis[c]; }
    const m = Math.max(Math.abs(x), Math.abs(y), Math.abs(z), Math.abs(w)) || 1;
    axis[0] = x / m; axis[1] = y / m; axis[2] = z / m; axis[3] = w / m;
  }
  const len = Math.hypot(axis[0], axis[1], axis[2], axis[3]) || 1;
  for (let c = 0; c < 4; c++) axis[c] /= len;
  let t0 = 1e9, t1 = -1e9;
  for (let i = 0; i < 16; i++) {
    let t = 0;
    for (let c = 0; c < 4; c++) t += (px[i * 4 + c] - mean[c]) * axis[c];
    if (t < t0) t0 = t;
    if (t > t1) t1 = t;
  }
  for (let c = 0; c < 4; c++) { lo[c] = mean[c] + axis[c] * t0; hi[c] = mean[c] + axis[c] * t1; }
}

/** Endpoints by least squares over the weights the indices give. */
function refit(px) {
  let aa = 0, bb = 0, ab = 0;
  const ax = new Float64Array(4), bx = new Float64Array(4);
  for (let i = 0; i < 16; i++) {
    const w = WEIGHTS[idx[i]] / 64, v = 1 - w;
    aa += v * v; bb += w * w; ab += v * w;
    for (let c = 0; c < 4; c++) { ax[c] += v * px[i * 4 + c]; bx[c] += w * px[i * 4 + c]; }
  }
  const det = aa * bb - ab * ab;
  if (Math.abs(det) < 1e-9) return false;
  for (let c = 0; c < 4; c++) {
    lo[c] = Math.max(0, Math.min(255, (bb * ax[c] - ab * bx[c]) / det));
    hi[c] = Math.max(0, Math.min(255, (aa * bx[c] - ab * ax[c]) / det));
  }
  return true;
}

/** Encodes 16 RGBA pixels (`px`, 64 bytes, row by row) into 16 bytes of `out` at `at`. */
export function encodeBc7Block(px, out, at) {
  principal(px);
  quantize(lo, hi);
  let bestErr = assign(px);
  best.set(idx); bestE.set(e8);
  for (let k = 0; k < 2 && bestErr > 0; k++) {
    if (!refit(px)) break;
    quantize(lo, hi);
    const err = assign(px);
    if (err >= bestErr) break;
    bestErr = err; best.set(idx); bestE.set(e8);
  }
  // the first pixel's index has an implied top bit of 0: swapping the ends mirrors the indices
  if (best[0] >= 8) {
    for (let c = 0; c < 4; c++) { const t = bestE[c]; bestE[c] = bestE[4 + c]; bestE[4 + c] = t; }
    for (let i = 0; i < 16; i++) best[i] = 15 - best[i];
  }
  out.fill(0, at, at + 16);
  let bit = 0;
  const put = (v, n) => { for (let k = 0; k < n; k++, bit++) if ((v >> k) & 1) out[at + (bit >> 3)] |= 1 << (bit & 7); };
  put(1 << 6, 7);
  for (let c = 0; c < 4; c++) { put(bestE[c] >> 1, 7); put(bestE[4 + c] >> 1, 7); }
  put(bestE[0] & 1, 1); put(bestE[4] & 1, 1);
  put(best[0], 3);
  for (let i = 1; i < 16; i++) put(best[i], 4);
}

// Draws the blast marks' images off the main thread (OffscreenCanvas 2D) and sends each back as its RGBA texels
// (straight alpha, transferred); blast/marks.ts fills its textures with them. Values as Roadcraft 4.0's render/blast.ts (craterTexture, soot).
import { parkMiller } from '../../../core/rng.ts';

export type MarkImage = 'crater-road' | 'crater-earth' | 'soot';
/** Side of each mark's image (px): a crater 512 (4.0: 256; a strong bomb's crater is tens of metres across), soot 128. */
export const MARK_SIZE: Record<MarkImage, number> = { 'crater-road': 512, 'crater-earth': 512, soot: 128 };

type Ctx = OffscreenCanvasRenderingContext2D;
const TAU = Math.PI * 2;

/** A disc of `rgb` fading from `alpha` at its centre to nothing at `rad`. */
function blob(g: Ctx, x: number, y: number, rad: number, rgb: string, alpha: number, square: number): void {
  const grad = g.createRadialGradient(x, y, 0, x, y, rad);
  grad.addColorStop(0, `rgba(${rgb},${alpha})`);
  grad.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grad;
  if (square) g.fillRect(0, 0, square, square);
  else { g.beginPath(); g.arc(x, y, rad, 0, TAU); g.fill(); }
}

/** Crater: scorch, a dark hole with a lighter broken lip, clods and, through paving, cracks. */
function crater(road: boolean): Uint8Array {
  const size = MARK_SIZE['crater-road'], mid = size / 2, hole = size * 0.26, px = size / 256;
  const c = new OffscreenCanvas(size, size), g = c.getContext('2d')!;
  const rnd = parkMiller(road ? 7 : 13);
  // scorch: 40 soft blots round the centre
  for (let i = 0; i < 40; i++) {
    const a = rnd() * TAU, r = size * (0.15 + rnd() * 0.3);
    blob(g, mid + Math.cos(a) * r * 0.6, mid + Math.sin(a) * r * 0.6, size * (0.08 + rnd() * 0.14), '12, 10, 9', 0.55, 0);
  }
  // the hole: a 28-sided ragged outline, dark at the bottom, lighter to the lip
  g.beginPath();
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * TAU, r = hole * (0.82 + rnd() * 0.3);
    g.lineTo(mid + Math.cos(a) * r, mid + Math.sin(a) * r);
  }
  g.closePath();
  const fall = g.createRadialGradient(mid, mid, 0, mid, mid, hole * 1.1);
  fall.addColorStop(0, road ? 'rgba(28, 22, 17, 1)' : 'rgba(34, 25, 17, 1)');
  fall.addColorStop(0.7, road ? 'rgba(58, 46, 36, 1)' : 'rgba(70, 52, 34, 1)');
  fall.addColorStop(1, road ? 'rgba(92, 86, 80, 1)' : 'rgba(96, 74, 50, 1)');
  g.fillStyle = fall;
  g.fill();
  g.lineWidth = 3 * px;
  g.strokeStyle = road ? 'rgba(120, 116, 110, 0.9)' : 'rgba(110, 86, 60, 0.9)';
  g.stroke();
  // clods: four times 4.0's 160 at half the size (the same grit, finer on a crater tens of metres across), round
  for (let i = 0; i < 640; i++) {
    const a = rnd() * TAU, r = hole * (0.2 + rnd() * 1.6), d = (1 + rnd() * 3) * size / 512;
    const shade = road ? 40 + rnd() * 70 : 50 + rnd() * 50;
    g.fillStyle = road ? `rgba(${shade},${shade},${shade + 4},0.9)` : `rgba(${shade + 30},${shade + 12},${shade - 10},0.9)`;
    g.beginPath(); g.arc(mid + Math.cos(a) * r, mid + Math.sin(a) * r, d / 2, 0, TAU); g.fill();
  }
  // cracks through paving: 11 wandering lines from the lip, thinning, some forking
  if (road) {
    g.strokeStyle = 'rgba(14, 12, 12, 0.85)';
    for (let i = 0; i < 11; i++) {
      let a = rnd() * TAU, x = mid + Math.cos(a) * hole * 0.9, y = mid + Math.sin(a) * hole * 0.9;
      g.lineWidth = 2.2 * px;
      g.beginPath(); g.moveTo(x, y);
      const step = size * (0.12 + rnd() * 0.22) / 8;
      for (let s = 0; s < 8; s++) {
        a += (rnd() - 0.5) * 0.7;
        x += Math.cos(a) * step; y += Math.sin(a) * step;
        g.lineTo(x, y);
        g.lineWidth = Math.max(0.6, 2.2 - s * 0.25) * px;
        if (rnd() < 0.25) {
          const b = a + (rnd() < 0.5 ? 0.8 : -0.8);
          g.moveTo(x, y); g.lineTo(x + Math.cos(b) * step * 2, y + Math.sin(b) * step * 2); g.moveTo(x, y);
        }
      }
      g.stroke();
    }
  }
  return texels(g, size);
}

/** Soot: 26 soft dark blots over a 128² tile. */
function soot(): Uint8Array {
  const c = new OffscreenCanvas(128, 128), g = c.getContext('2d')!;
  const rnd = parkMiller(29);
  for (let k = 0; k < 26; k++) {
    const x = 64 + (rnd() - 0.5) * 70, y = 64 + (rnd() - 0.5) * 70, r = 10 + rnd() * 34;
    blob(g, x, y, r, '20,17,14', 0.25 + rnd() * 0.25, 128);
  }
  return texels(g, 128);
}

/** The canvas's texels, straight (not premultiplied) alpha: what the upload of a canvas gives a texture. */
function texels(g: Ctx, size: number): Uint8Array {
  const d = g.getImageData(0, 0, size, size).data;
  return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
}

const scope = self as unknown as { onmessage: (() => void) | null; postMessage(m: unknown, t?: Transferable[]): void; close(): void };
scope.onmessage = () => {
  const send = (name: MarkImage, data: Uint8Array) => scope.postMessage({ name, data }, [data.buffer as ArrayBuffer]);
  send('crater-road', crater(true));
  send('crater-earth', crater(false));
  send('soot', soot());
  scope.close();
};

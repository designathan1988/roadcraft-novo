// What the tools draw over the ground (render/terrain.ts mixes it into the terrain's colour): the brush ring under the
// cursor and the map's grid (the Layers panel's switch, app/viewState.ts writes gridU).

import * as THREE from 'three/webgpu';
import { T, type Node } from './tsl.ts';

const { abs, float, fract, fwidth, length, max, mix, smoothstep, vec3 } = T;

/** Grid on the map switched on (0/1). */
export const gridU = T.uniform(0);

export class GroundOverlays {
  /** The brush ring: centre x, z, radius, shown (1) or not (0). */
  private readonly brush: Node = T.uniform(new THREE.Vector4(0, 0, 50, 0));

  /** Shows the brush ring at (x, z), `radius` metres. */
  showBrush(x: number, z: number, radius: number): void { (this.brush.value as THREE.Vector4).set(x, z, radius, 1); }
  hideBrush(): void { (this.brush.value as THREE.Vector4).w = 0; }

  /** The ground colour `c` at world point `p` with the brush ring and the grid over it; `pix`: metres per pixel there. */
  over(c: Node, p: Node, pix: Node): Node {
    // brush ring
    const b = this.brush;
    const d = length(p.xz.sub(b.xy));
    const w = max(fwidth(d), float(0.15)).mul(1.5);
    const ring = smoothstep(b.z.sub(w.mul(2)), b.z.sub(w), d).mul(smoothstep(b.z.add(w), b.z, d)).mul(b.w);
    const inner = smoothstep(b.z, float(0), d).mul(0.12).mul(b.w);
    c = mix(c, vec3(1.0, 0.85, 0.35), max(ring, inner));
    // grid on the map (optional): lines every 64 m, stronger every 256 m; they vanish far away
    const gl = (stepM: number, wid: number) => {
      const g2b = abs(fract(p.xz.div(stepM)).sub(0.5)).mul(stepM);
      const fw = max(fwidth(p.x), float(0.02)).mul(wid);
      return max(smoothstep(fw.mul(2), fw, g2b.x.sub(stepM / 2).abs()), smoothstep(fw.mul(2), fw, g2b.y.sub(stepM / 2).abs()));
    };
    const grid = max(gl(64, 1).mul(0.35), gl(256, 1.6).mul(0.6)).mul(gridU).mul(smoothstep(float(3), float(0.6), pix));
    return mix(c, vec3(1, 1, 1), grid);
  }
}

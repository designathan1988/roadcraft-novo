// The building's drawn shell plus the parts a ruin shows when its walls open: floor slabs at every storey and thin
// interior partitions. The arrays go to the fracture worker; the mesh itself is never drawn as one intact box.
import { MeshBuilder } from '../jobs/meshBuilder.ts';
import { layLot40, volumes40, type Lot40 } from '../jobs/building40.ts';
import type { FractureInput } from './fracture.ts';

const SLAB = 0x8c8178, PARTITION = 0xe6dfd2;

function slab(mb: MeshBuilder, cx: number, cz: number, hw: number, hd: number, rot: number, y: number, thick: number): void {
  const c = Math.cos(rot), s = Math.sin(rot);
  const p = (x: number, z: number): [number, number] => [cx + x * c - z * s, cz + x * s + z * c];
  const [x0, z0] = p(-hw, -hd), [x1, z1] = p(hw, -hd), [x2, z2] = p(hw, hd), [x3, z3] = p(-hw, hd);
  for (const [sign, y0] of [[1, y], [-1, y - thick]] as const) {
    const a = mb.vert(x0, y0, z0, 0, sign, 0, SLAB, 0), b = mb.vert(x1, y0, z1, 0, sign, 0, SLAB, 0);
    const c2 = mb.vert(x2, y0, z2, 0, sign, 0, SLAB, 0), d = mb.vert(x3, y0, z3, 0, sign, 0, SLAB, 0);
    mb.quad(a, b, c2, d, 0, sign, 0);
  }
}

function partition(mb: MeshBuilder, cx: number, cz: number, hw: number, hd: number, rot: number, y0: number, y1: number): void {
  const c = Math.cos(rot), s = Math.sin(rot);
  const p = (x: number, z: number): [number, number] => [cx + x * c - z * s, cz + x * s + z * c];
  for (const [ax, az, bx, bz] of [[-hw, 0, hw, 0], [0, -hd, 0, hd]]) {
    const [x0, z0] = p(ax, az), [x1, z1] = p(bx, bz);
    const a = mb.vert(x0, y0, z0, c, 0, s, PARTITION, 0), b = mb.vert(x1, y0, z1, c, 0, s, PARTITION, 0);
    const c2 = mb.vert(x1, y1, z1, c, 0, s, PARTITION, 0), d = mb.vert(x0, y1, z0, c, 0, s, PARTITION, 0);
    mb.quad(a, b, c2, d, c, 0, s);
  }
}

/** The fracture input: the real 4.0 shell, the floor slabs and the partitions inside it. */
export function wreckInput(lot: Lot40): FractureInput {
  const mb = new MeshBuilder(false, true);
  layLot40(lot, mb, null, 0);
  for (const v of volumes40(lot)) {
    for (let y = v.y0 + v.fh; y < v.y1 - 0.05; y += v.fh) slab(mb, v.cx, v.cz, v.hw, v.hd, v.rot, y, 0.16);
    slab(mb, v.cx, v.cz, v.hw, v.hd, v.rot, v.y1, 0.16);
    for (let y = v.y0; y < v.y1 - 0.1; y += v.fh) partition(mb, v.cx, v.cz, v.hw * 0.72, v.hd * 0.72, v.rot, y, Math.min(v.y1, y + v.fh));
  }
  return { position: mb.pos.slice(0, mb.v * 3), normal: mb.nrm.slice(0, mb.v * 3), colour: mb.col.slice(0, mb.v), index: mb.idx.slice(0, mb.t), seed: lot.seed };
}

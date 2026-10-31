/// <reference types="node" />
// Geometry measurements shared by the audit scripts: counts, bytes per vertex, welding potential, degenerate, tiny and
// duplicated triangles. Works on plain arrays (positions xyz in metres + optional index) so it reads both the engine's
// PackedMesh and three.js BufferGeometry.
import type { PackedMesh } from '../../../src/shared/contracts/worker.ts';

export interface Flat { pos: Float32Array; index: Uint32Array | null; col?: Float32Array | null; nrm?: Float32Array | null }

export interface GeoStats {
  vertices: number;
  triangles: number;
  indexed: boolean;
  /** Distinct positions (1 mm grid): how many vertices share a place with another one. */
  uniquePositions: number;
  /** Vertices that are exact copies (all attributes equal) of another: what welding would remove. */
  weldable: number;
  degenerate: number;
  /** Triangles under 1 cm² (area). */
  tiny: number;
  /** Triangles that repeat another one's three corners (either winding). */
  duplicate: number;
  area: number;
  bbox: [number, number, number, number, number, number];
  /** Median triangle edge length (m). */
  medianEdge: number;
}

const key3 = (x: number, y: number, z: number) => `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;

export function stats(f: Flat, vertexKey?: (i: number) => string): GeoStats {
  const n = f.pos.length / 3;
  const idx = f.index ?? Uint32Array.from({ length: n }, (_, i) => i);
  const tris = idx.length / 3;
  const posKey: string[] = new Array(n);
  const uniq = new Set<string>();
  const bb: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const x = f.pos[i * 3], y = f.pos[i * 3 + 1], z = f.pos[i * 3 + 2];
    posKey[i] = key3(x, y, z); uniq.add(posKey[i]);
    if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y; if (z < bb[2]) bb[2] = z;
    if (x > bb[3]) bb[3] = x; if (y > bb[4]) bb[4] = y; if (z > bb[5]) bb[5] = z;
  }
  const full = new Set<string>();
  for (let i = 0; i < n; i++) full.add(vertexKey ? posKey[i] + '|' + vertexKey(i) : posKey[i]);
  let degenerate = 0, tiny = 0, duplicate = 0, area = 0;
  const seen = new Set<string>();
  const edges: number[] = [];
  for (let t = 0; t < tris; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    const ax = f.pos[a * 3], ay = f.pos[a * 3 + 1], az = f.pos[a * 3 + 2];
    const bx = f.pos[b * 3] - ax, by = f.pos[b * 3 + 1] - ay, bz = f.pos[b * 3 + 2] - az;
    const cx = f.pos[c * 3] - ax, cy = f.pos[c * 3 + 1] - ay, cz = f.pos[c * 3 + 2] - az;
    const ar = 0.5 * Math.hypot(by * cz - bz * cy, bz * cx - bx * cz, bx * cy - by * cx);
    area += ar;
    if (ar < 1e-8) degenerate++; else if (ar < 1e-4) tiny++;
    const k = [posKey[a], posKey[b], posKey[c]].sort().join('|');
    if (seen.has(k)) duplicate++; else seen.add(k);
    if (t % 7 === 0) edges.push(Math.hypot(bx, by, bz));
  }
  edges.sort((p, q) => p - q);
  return {
    vertices: n, triangles: tris, indexed: !!f.index, uniquePositions: uniq.size, weldable: n - full.size,
    degenerate, tiny, duplicate, area, bbox: bb, medianEdge: edges.length ? edges[edges.length >> 1] : 0,
  };
}

/** World positions (m) of a packed mesh, and its index. */
export function flatOfPacked(m: PackedMesh): Flat {
  const k = m.scale / 32767, n = m.vertexCount, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = m.originX + m.position[i * 4] * k;
    pos[i * 3 + 1] = m.originY + m.position[i * 4 + 1] * k;
    pos[i * 3 + 2] = m.originZ + m.position[i * 4 + 2] * k;
    col[i * 3] = m.color[i * 4] / 255; col[i * 3 + 1] = m.color[i * 4 + 1] / 255; col[i * 3 + 2] = m.color[i * 4 + 2] / 255;
  }
  return { pos, index: Uint32Array.from(m.index), col };
}

/** A packed mesh's vertex key (every attribute) for the welding count. */
export function packedKey(m: PackedMesh): (i: number) => string {
  return (i) => {
    const parts = [m.normal[i * 4], m.normal[i * 4 + 1], m.color[i * 4], m.color[i * 4 + 1], m.color[i * 4 + 2], m.color[i * 4 + 3], m.position[i * 4 + 3]];
    if (m.fac) parts.push(m.fac[i * 4], m.fac[i * 4 + 1], m.fac[i * 4 + 2], m.fac[i * 4 + 3]);
    if (m.fuv) parts.push(m.fuv[i * 2], m.fuv[i * 2 + 1]);
    if (m.extra) parts.push(m.extra[i * 4], m.extra[i * 4 + 1], m.extra[i * 4 + 2], m.extra[i * 4 + 3]);
    return parts.join(',');
  };
}

/** Bytes per vertex of a packed mesh as the cell layer uploads it (render/cellLayer.ts:242-250). */
export function packedVertexBytes(m: PackedMesh, facade: boolean, road: boolean): number {
  return 8 + 4 + 4 + (road ? 16 : 0) + (facade ? 4 + 4 : 0);
}
export function packedBytes(m: PackedMesh, facade: boolean, road: boolean): number {
  return m.vertexCount * packedVertexBytes(m, facade, road) + m.index.byteLength;
}

// three.js geometries (structural typing: no import of three here)
interface Attr { count: number; itemSize: number; array: ArrayLike<number> & { BYTES_PER_ELEMENT: number }; getX(i: number): number; getY(i: number): number; getZ(i: number): number; getComponent?(i: number, c: number): number; normalized?: boolean }
export interface Geo { attributes: Record<string, Attr>; index: Attr | null }

export function threeBytesPerVertex(g: Geo): { bytes: number; layout: string } {
  let bytes = 0;
  const parts: string[] = [];
  for (const [name, a] of Object.entries(g.attributes)) {
    const b = a.itemSize * a.array.BYTES_PER_ELEMENT;
    bytes += b;
    parts.push(`${name}:${a.itemSize}x${a.array.constructor.name.replace('Array', '')}=${b}B`);
  }
  return { bytes, layout: parts.join(' ') };
}

export function flatOfThree(g: Geo): Flat {
  const p = g.attributes.position;
  const pos = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) { pos[i * 3] = p.getX(i); pos[i * 3 + 1] = p.getY(i); pos[i * 3 + 2] = p.getZ(i); }
  const index = g.index ? Uint32Array.from({ length: g.index.count }, (_, i) => g.index!.getX(i)) : null;
  let col: Float32Array | null = null;
  const c = g.attributes.pcol ?? g.attributes.color;
  if (c) { col = new Float32Array(p.count * 3); for (let i = 0; i < p.count; i++) { col[i * 3] = c.getX(i); col[i * 3 + 1] = c.getY(i); col[i * 3 + 2] = c.getZ(i); } }
  return { pos, index, col };
}

export function threeKey(g: Geo): (i: number) => string {
  const names = Object.keys(g.attributes).filter((n) => n !== 'position');
  return (i) => {
    const out: number[] = [];
    for (const n of names) {
      const a = g.attributes[n];
      for (let c = 0; c < a.itemSize; c++) out.push(Math.round((a.array as ArrayLike<number>)[i * a.itemSize + c] * 1e4));
    }
    return out.join(',');
  };
}

export function geoStats(g: Geo): GeoStats & { bytesPerVertex: number; layout: string; indexBytes: number; bytes: number } {
  const s = stats(flatOfThree(g), threeKey(g));
  const { bytes, layout } = threeBytesPerVertex(g);
  const indexBytes = g.index ? g.index.count * g.index.array.BYTES_PER_ELEMENT : 0;
  return { ...s, bytesPerVertex: bytes, layout, indexBytes, bytes: bytes * s.vertices + indexBytes };
}

/** Pixels per metre at distance d (m) on a 1080-row screen with the game's 45° vertical field of view. */
export const pxPerMetre = (d: number, fovDeg = 45, rows = 1080) => rows / (2 * d * Math.tan((fovDeg * Math.PI) / 360));

export const fmt = (n: number, d = 0) => (Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }) : String(n));

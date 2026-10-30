import {  } from '../../world/heights.ts';
import { MeshBuilder } from '../meshBuilder.ts';
import { CAT_ELEMENTS, CAT_FINISHES, CAT_ROOFS, CAT_SURFACES, CAT_UNIT, type CatElement, type CatProject, type CatStorey, type CatVolume } from '../../world/catalog.ts';
import { BAY, catalogFacade } from '../../world/catalogFacade.ts';
import { FIN } from '../buildingFinishes.ts';
import { catalogExtent } from './plan.ts';
import {  } from './polygon.ts';
import { BMAT } from './materials.ts';
import { blank, nx, nz, shadeHex, wx, wz, type Frame } from './geometry.ts';
import { catalogLevels } from './heights.ts';
import { setFac, windowDetailWall } from './windows.ts';
import { PART, balconyLife, captureFoot, door, opensWindows, part, prism, railing } from './shell.ts';
import { gate, groundPatch, wall, yard, yardGrid } from './lot.ts';
import type { GenContext } from './context.ts';
import { P_BENCH, P_BIN, P_BUSH, P_FURN, P_LAMP, P_TREE, F_BOLLARD, F_DRAIN, F_PLANTER } from './plans.ts';
import { polyPrism, wallSeg } from './plans2.ts';
const CAT_FIN = CAT_FINISHES.map((n) => FIN[(n[0].toUpperCase() + n.slice(1)) as keyof typeof FIN] ?? FIN.Plaster);
/** A volume's storeys at the drawn height: the typical upper storey repeated (or removed) under the top one. */
function catalogStoreys(v: CatVolume, top: number, drawn: number): CatStorey[] {
  const n = v.storeys.length, d = drawn - top;
  if (v.base + n !== top || d === 0) return v.storeys;
  // fewer: the top storey stays, the ones under it go (at least the top one is left)
  if (d < 0) { const keep = Math.max(1, n + d); return [...v.storeys.slice(0, keep - 1), v.storeys[n - 1]]; }
  const typical = v.storeys[Math.max(0, n - 2)];
  return [...v.storeys.slice(0, n - 1), ...Array.from({ length: d }, () => typical), v.storeys[n - 1]];
}

/** One wall of a volume, from (ax, az) to (bx, bz) facing (nxl, nzl), y0 to y1, with the current facade. */
function facadeWall(mb: MeshBuilder, f: Frame, ax: number, az: number, bx: number, bz: number, nxl: number, nzl: number,
  y0: number, y1: number, col: number, mat: number, colW: number): void {
  const dm = f.out?.detail;
  if (dm && mb !== dm) {
    const fc = mb.curFac;
    if (opensWindows(fc, mat))
      windowDetailWall(dm, f, ax, az, bx, bz, nxl, nzl, y0, y1, mb.curBase, (fc[2] & 4) !== 0, colW, (fc[2] >> 3) / 10 + 2.5, fc[0], fc[1]);
    return;
  }
  const len = Math.hypot(bx - ax, bz - az);
  if (len < 1e-3) return;
  const NX = nx(f, nxl, nzl), NZ = nz(f, nxl, nzl);
  const fac3 = mb.curFac[3];
  if (opensWindows(mb.curFac, mat)) mb.curFac[3] |= 1;
  mb.curU = 0;
  const a = mb.vert(wx(f, ax, az), y0, wz(f, ax, az), NX, 0, NZ, col, mat), d = mb.vert(wx(f, ax, az), y1, wz(f, ax, az), NX, 0, NZ, col, mat);
  mb.curU = Math.max(1, Math.round(len / colW));
  const b = mb.vert(wx(f, bx, bz), y0, wz(f, bx, bz), NX, 0, NZ, col, mat), c = mb.vert(wx(f, bx, bz), y1, wz(f, bx, bz), NX, 0, NZ, col, mat);
  mb.quad(a, b, c, d, NX, 0, NZ);
  mb.curU = 0;
  mb.curFac[3] = fac3;
}

/**
 * A building drawn from a catalog project, whole (world/catalog.ts): its volumes in levels (ground storey `gh`, the
 * rest `sh`), each face drawn in bands of storeys with the same fill (the storey's or the face's), with the project's
 * window width, sill and head for that face (world/catalogFacade.ts) and its bay width; balconies per bay, doors at
 * their bays, piers from the face geometry, flat or terrace roofs with parapets where nothing stands against the edge;
 * open ground; every element (trees, shrubs, benches, lamps, bins, bollards and drains to the props pool; walls,
 * fences, railings, gates, slabs, pavements, parking, planters, pillars, canopies in the mesh) with its height,
 * elevation and facing. Scaled in plan to the lot (heights kept); the storeys follow the record's floors.
 */
export function catalogBuilding(g: GenContext, p: CatProject, wallOverride: number): void {
  const { mb, heights, f, W, D, hi, lod, seed } = g;
  const U = CAT_UNIT, ext = catalogExtent(p);
  const s = Math.min(1.15, W / ((ext.x1 - ext.x0) * U), D / (ext.y1 * U));
  const cx = (ext.x0 + ext.x1) / 2;
  const X = (x: number) => (x - cx) * U * s, Z = (y: number) => D / 2 - y * U * s;
  const y0 = hi + 0.2, gh = p.groundHeight * U, sh = p.storeyHeight * U;
  const levelY = (k: number) => y0 + (k <= 0 ? 0 : gh + (k - 1) * sh);
  const [top, drawn] = catalogLevels(p, g.floors);
  const trim = p.trim.colour;
  mb.curBase = y0;
  // ground: the lot paved, then its open blocks over it
  if (lod < 2) { blank(mb); yard(mb, heights, f, W, D, 0xa9a398, BMAT.Paving); }
  const vols = p.volumes.map((v) => ({ v, storeys: v.open >= 0 ? [] : catalogStoreys(v, top, drawn) }));
  // the plan rectangle and the drawn levels of every building volume (for the parapets' covered edges)
  const boxes = vols.filter((q) => q.v.open < 0).map((q) => ({ x0: X(q.v.x), x1: X(q.v.x + q.v.w), z0: Z(q.v.y + q.v.d), z1: Z(q.v.y), lo: q.v.base, hiL: q.v.base + q.storeys.length }));
  vols.forEach(({ v, storeys }, vi) => {
    const x0 = X(v.x), x1 = X(v.x + v.w), z1 = Z(v.y), z0 = Z(v.y + v.d);
    if (v.open >= 0) {
      if (lod > 1) return;
      const surf = CAT_SURFACES[v.open];
      const grass = surf === 'grass', dark = surf === 'asphalt';
      groundPatch(mb, heights, f, W, D, x0, x1, z0, z1, grass ? 0x587a3c : dark ? 0x55585b : surf === 'water' ? 0x52c0e0 : 0xb9b2a6, grass ? BMAT.Grass : surf === 'water' ? BMAT.Plain : BMAT.Paving, dark ? 0.05 : 0.04);
      return;
    }
    const n = storeys.length, volIndex = boxes.findIndex((o) => o.lo === v.base && Math.abs(o.x0 - x0) < 1e-6 && Math.abs(o.z1 - z1) < 1e-6 && Math.abs(o.x1 - x1) < 1e-6 && Math.abs(o.z0 - z0) < 1e-6);
    if (!n || v.base >= drawn) return;
    const m = v.material ?? p.wall, fin = CAT_FIN[m.finish];
    const wallCol = wallOverride >= 0 ? wallOverride : m.colour;
    const wallMat = (CAT_FINISHES[m.finish] === 'glass' ? BMAT.Curtain : BMAT.Wall) | (fin << 4);
    const ya = v.base === 0 ? f.base : levelY(v.base), yb = levelY(v.base + n);
    // the volume's storeys for the inside view and the camera, and its footprint for the yard props
    const sink = f.out;
    if (sink?.layout) sink.layout.push({ cx: wx(f, (x0 + x1) / 2, (z0 + z1) / 2), cz: wz(f, (x0 + x1) / 2, (z0 + z1) / 2), hw: (x1 - x0) / 2, hd: (z1 - z0) / 2, rot: Math.atan2(f.s, f.c), y0: ya, y1: yb, base: v.base === 0 ? y0 : levelY(v.base), ground: v.base === 0 ? gh : sh, fh: sh });
    if (sink?.foot) captureFoot(sink, f, x0, x1, z0, z1, ya);
    // the faces: 0 front (+z, the street), 1 right (+x), 2 back, 3 left; corners as prism()
    const corners: Array<[number, number]> = [[x0, z1], [x1, z1], [x1, z0], [x0, z0]];
    const normals: Array<[number, number]> = [[0, 1], [1, 0], [0, -1], [-1, 0]];
    const outline = v.outline && v.outline.length >= 6 ? v.outline : null;
    for (let face = 0; face < (outline ? 1 : 4); face++) {
      const [ax, az] = corners[face], [bx, bz] = corners[(face + 1) & 3];
      const len = outline ? 0 : Math.hypot(bx - ax, bz - az);
      const geo = v.geometry[face];
      const bays = Math.max(1, geo?.bays ?? Math.round((face & 1 ? v.d : v.w) / p.module));
      const colW = outline ? p.module * U * s : len / bays;
      // bands of storeys with the same fill (the ground storey is a band of its own: it has its own height)
      for (let k0 = 0; k0 < n;) {
        const fillOf = (k: number) => (outline || storeys[k].sides[face] < 0 ? storeys[k].fill : storeys[k].sides[face]);
        const fill = fillOf(k0);
        let k1 = k0 + 1;
        if (v.base + k0 > 0) while (k1 < n && fillOf(k1) === fill) k1++;
        const ground = v.base + k0 === 0, fh = ground ? gh : sh;
        const look = catalogFacade(p, fill, geo, fh, ground);
        if (look) setFac(mb, look.id, seed, look.kind, colW, fh); else blank(mb);
        mb.curBase = ground ? y0 : levelY(v.base + k0);
        const ba = k0 === 0 ? ya : levelY(v.base + k0), bb = levelY(v.base + k1);
        if (outline) {
          const pts: Array<[number, number]> = [];
          for (let q = 0; q + 1 < outline.length; q += 2) pts.push([x0 + outline[q] * (x1 - x0), z1 - outline[q + 1] * (z1 - z0)]);
          polyPrism(mb, f, pts, ba, bb, wallCol, colW, k1 === n ? p.roof.colour : -1, BMAT.RoofFlat | (CAT_FIN[p.roof.finish] << 4), wallMat);
        } else facadeWall(mb, f, ax, az, bx, bz, normals[face][0], normals[face][1], ba, bb, wallCol, wallMat, colW);
        // balconies: a slab and a railing at every bay of every storey of a balcony band (the ground storey has none)
        if (lod === 0 && !outline && (fill === BAY.balcony || fill === BAY.gourmet)) {
          for (let k = Math.max(k0, v.base === 0 ? 1 : 0); k < k1; k++) {
            // where another block's roof is the floor in front of this storey, that roof is the balcony
            const [mx, mz] = [(ax + bx) / 2 + normals[face][0] * 0.6, (az + bz) / 2 + normals[face][1] * 0.6];
            if (boxes.some((o) => o.hiL === v.base + k && mx > o.x0 && mx < o.x1 && mz > o.z0 && mz < o.z1)) continue;
            for (let c = 0; c < bays; c++) {
              // not into a block standing against this face at that storey
              const t = (c + 0.5) / bays, px = ax + (bx - ax) * t + normals[face][0] * 0.6, pz = az + (bz - az) * t + normals[face][1] * 0.6;
              if (boxes.some((o) => o.lo <= v.base + k && o.hiL > v.base + k && px > o.x0 && px < o.x1 && pz > o.z0 && pz < o.z1)) continue;
              catalogBalcony(g, face, corners, colW, c, levelY(v.base + k), c + k);
            }
          }
        }
        k0 = k1;
      }
      if (outline) continue;
      // doors at their bays (4.0: "side:index"), on the storey they are on
      if (lod === 0) storeys.forEach((st, k) => {
        for (const [bf, bi, comp] of st.bays) {
          if (bf !== face || (comp !== BAY.door && comp !== BAY.doubleDoor && comp !== BAY.garageDoor && comp !== BAY.loadingDoor)) continue;
          const u = (Math.min(bi, bays - 1) + 0.5) * colW;
          if (face === 0) door(mb, f, x0 + u, z1, levelY(v.base + k), trim, true);
        }
      });
      // piers standing out of the face (4.0 pierWidth, pierDepth, pierEvery)
      if (lod < 2 && geo?.pierDepth && geo.pierWidth) {
        blank(mb);
        // 2 cm shallower: the data sets some piers right against another block's wall
        const pw = geo.pierWidth * U * s, pd = geo.pierDepth * U - 0.02, every = Math.max(1, geo.pierEvery ?? 1), pc = shadeHex(wallCol, 1.06);
        const dx = (bx - ax) / len, dz = (bz - az) / len, [nxl, nzl] = normals[face];
        for (let c = 0; c <= bays; c += every) {
          const u = Math.max(pw / 2, Math.min(len - pw / 2, c * colW)), px = ax + dx * u, pz = az + dz * u;
          const ox = nxl * pd, oz = nzl * pd, hx = Math.abs(dx) * pw / 2, hz = Math.abs(dz) * pw / 2;
          if (boxes.some((o, oi) => oi !== volIndex && o.hiL > v.base && o.lo < v.base + n && px + nxl * 0.1 > o.x0 && px + nxl * 0.1 < o.x1 && pz + nzl * 0.1 > o.z0 && pz + nzl * 0.1 < o.z1)) continue;
          prism(mb, f, Math.min(px - hx, px - hx + ox), Math.max(px + hx, px + hx + ox), Math.min(pz - hz, pz - hz + oz), Math.max(pz + hz, pz + hz + oz), ya, yb, pc, BMAT.Plain, 50, pc, BMAT.Plain, false, 1 << ((face + 2) & 3));
        }
      }
    }
    if (outline) {
      if (lod < 2) {
        blank(mb);
        const pts: Array<[number, number]> = [];
        for (let q = 0; q + 1 < outline.length; q += 2) pts.push([x0 + outline[q] * (x1 - x0), z1 - outline[q + 1] * (z1 - z0)]);
        for (let k = 0; k < pts.length; k++) wallSeg(mb, f, pts[k][0], pts[k][1], pts[(k + 1) % pts.length][0], pts[(k + 1) % pts.length][1], yb, 0.9, wallCol);
      }
      return;
    }
    // roof: the cap (2 cm higher per volume: two volumes overlapping at the same top never share a plane), parapets
    // on the edges nothing stands against, a terrace's paving and railing
    blank(mb);
    const terrace = CAT_ROOFS[v.roof] === 'terrace', capY = yb + (vi % 4) * 0.02;
    const cap = [[x0, z1], [x1, z1], [x1, z0], [x0, z0]].map(([x, z]) => mb.vert(wx(f, x, z), capY, wz(f, x, z), 0, 1, 0, terrace ? 0xc9c3b8 : p.roof.colour, terrace ? BMAT.Paving : BMAT.RoofFlat | (CAT_FIN[p.roof.finish] << 4)));
    mb.quad(cap[0], cap[1], cap[2], cap[3], 0, 1, 0);
    if (lod < 2) catalogParapets(g, boxes, vi, x0, x1, z0, z1, v.base + n, capY, terrace ? 1.1 : 0.9, wallCol, terrace && lod === 0);
  });
  // the highest roof gets the machine room and the units
  if (lod < 2) {
    let t = -1, ty = -Infinity;
    boxes.forEach((b, k) => { if (levelY(b.hiL) > ty && b.x1 - b.x0 > 8 && b.z1 - b.z0 > 8) { ty = levelY(b.hiL); t = k; } });
    if (t >= 0) {
      const b = boxes[t], y = ty + 0.06;
      blank(mb);
      // 3.874 m wide: no project coordinate (multiples of 1/320 m) can put another block's edge in its sides' planes
      const mx = (b.x0 + b.x1) / 2 - 1.937;
      prism(mb, f, mx, mx + 3.874, b.z0 + 2.013, b.z0 + 5.987, y, y + 3, 0xb8b4ab, BMAT.Plain, 50, 0x8f8b84, BMAT.RoofFlat);
      for (let k = 0; k < 4; k++) part(f, PART.RoofAc, b.x0 + 1.5 + k * 1.6, y, b.z1 - 1.5, 0, 1);
    }
  }
  if (lod > 0) return;
  p.elements.forEach((e, k) => catalogElement(g, p, e, k, X, Z, s));
}

/** A balcony at bay c of a face, on the floor at y: a slab 1.1 m out and a railing (balusters on the front, near). */
function catalogBalcony(g: GenContext, face: number, corners: Array<[number, number]>, colW: number, c: number, y: number, key: number): void {
  const { mb, f, seed } = g;
  const [ax, az] = corners[face], [bx, bz] = corners[(face + 1) & 3];
  const len = Math.hypot(bx - ax, bz - az), dx = (bx - ax) / len, dz = (bz - az) / len;
  const nrm: Array<[number, number]> = [[0, 1], [1, 0], [0, -1], [-1, 0]];
  const [nxl, nzl] = nrm[face], depth = 1.1;
  const u0 = c * colW + 0.2, u1 = (c + 1) * colW - 0.2;
  if (u1 - u0 < 0.8) return;
  const pa: [number, number] = [ax + dx * u0, az + dz * u0], pb: [number, number] = [ax + dx * u1, az + dz * u1];
  const rx0 = Math.min(pa[0], pb[0], pa[0] + nxl * depth, pb[0] + nxl * depth), rx1 = Math.max(pa[0], pb[0], pa[0] + nxl * depth, pb[0] + nxl * depth);
  const rz0 = Math.min(pa[1], pb[1], pa[1] + nzl * depth, pb[1] + nzl * depth), rz1 = Math.max(pa[1], pb[1], pa[1] + nzl * depth, pb[1] + nzl * depth);
  blank(mb);
  prism(mb, f, rx0, rx1, rz0, rz1, y - 0.15, y, 0xd8d6d0, BMAT.Plain, 50, 0xcfcdc6, BMAT.Plain, true, 1 << ((face + 2) & 3));
  if (face === 0) { railing(mb, f, rx0, rx1, rz1, y, 0x2c3034); balconyLife(f, seed, c, key, rx0, rx1, rz0, depth, y); return; }
  // the other faces: the handrail and two posts (the balusters are a front-face detail)
  const t = 0.06, col = 0x2c3034;
  const ox = nxl * depth, oz = nzl * depth;
  const ex0 = Math.min(pa[0] + ox, pb[0] + ox) - (nxl ? t / 2 : 0), ex1 = Math.max(pa[0] + ox, pb[0] + ox) + (nxl ? t / 2 : 0);
  const ez0 = Math.min(pa[1] + oz, pb[1] + oz) - (nzl ? t / 2 : 0), ez1 = Math.max(pa[1] + oz, pb[1] + oz) + (nzl ? t / 2 : 0);
  prism(mb, f, ex0, ex1, ez0, ez1, y + 0.98, y + 1.05, col, BMAT.Metal, 50, col, BMAT.Metal);
  for (const [px, pz] of [pa, pb]) prism(mb, f, px + ox - 0.03, px + ox + 0.03, pz + oz - 0.03, pz + oz + 0.03, y, y + 0.98, col, BMAT.Metal, 50, -1, 0);
}

/**
 * Parapets of a volume's roof: on each edge, the stretches no other volume stands against (a taller block on the
 * roof, a neighbour block of the same height): a parapet there would sit inside its wall, both faces in one plane.
 */
function catalogParapets(g: GenContext, boxes: Array<{ x0: number; x1: number; z0: number; z1: number; lo: number; hiL: number }>, self: number,
  x0: number, x1: number, z0: number, z1: number, level: number, y: number, h: number, col: number, rail: boolean): void {
  const { mb, f } = g;
  const t = 0.22, eps = 0.06;
  // edges: [fixed coordinate, along x?, from, to, inward sign]
  // (the side edges stop at the front and back parapets' inner faces: corners are the front and back's, never shared)
  const edges: Array<[number, boolean, number, number, number]> = [[z1, true, x0, x1, -1], [x1, false, z0 + t, z1 - t, -1], [z0, true, x0, x1, 1], [x0, false, z0 + t, z1 - t, 1]];
  for (const [fix, alongX, a0, a1, inward] of edges) {
    // covered stretches: other volumes that span this edge's line at the parapet's height
    const cov: Array<[number, number]> = [];
    boxes.forEach((b, k) => {
      if (k === self || b.hiL <= level || b.lo > level) return;
      const onLine = alongX ? b.z0 - eps <= fix && fix <= b.z1 + eps : b.x0 - eps <= fix && fix <= b.x1 + eps;
      if (!onLine) return;
      const lo = Math.max(a0, alongX ? b.x0 : b.z0), hi2 = Math.min(a1, alongX ? b.x1 : b.z1);
      if (hi2 > lo) cov.push([lo, hi2]);
    });
    cov.sort((p, q) => p[0] - q[0]);
    const free: Array<[number, number]> = [];
    let at = a0;
    for (const [lo, hi2] of cov) { if (lo > at) free.push([at, lo]); at = Math.max(at, hi2); }
    if (at < a1) free.push([at, a1]);
    for (const [lo, hi2] of free) {
      if (hi2 - lo < 0.3) continue;
      // the edge's wall, t thick, inside the volume's plan; its top is the coping (a thin wall is no lid)
      const i0 = fix + inward * t;
      if (alongX) prism(mb, f, lo, hi2, Math.min(fix, i0), Math.max(fix, i0), y, y + h, col, BMAT.Plain, 50, 0xd6d3cc, BMAT.Plain);
      else prism(mb, f, Math.min(fix, i0), Math.max(fix, i0), lo, hi2, y, y + h, col, BMAT.Plain, 50, 0xd6d3cc, BMAT.Plain);
      if (rail && alongX && inward < 0) railing(mb, f, lo, hi2, fix - t, y + h - 0.02, 0x8fb0c0);
    }
  }
}

/** One element of a catalog project: its kind, size, height, elevation and facing (facing 1 and 3 turn it). */
function catalogElement(g: GenContext, p: CatProject, e: CatElement, index: number, X: (x: number) => number, Z: (y: number) => number, s: number): void {
  const { mb, heights, f, W, D } = g;
  const U = CAT_UNIT, x = X(e.x), z = Z(e.y);
  if (Math.abs(x) > W / 2 + 0.5 || Math.abs(z) > D / 2 + 0.5) return;
  const turned = e.facing === 1 || e.facing === 3;
  // its size on the lot: w along x for facing 0/2, along z for 1/3 (4.0 elementRect)
  const sx = (turned ? e.d : e.w) * U * s, sz = (turned ? e.w : e.d) * U * s, h = e.h * U;
  // on the lot floor (its relief grid, as the ground pieces), at the element's elevation
  const gy = yardGrid(heights, f, W, D).at(x, z) + e.z * U;
  const yaw = [0, Math.PI / 2, Math.PI, -Math.PI / 2][e.facing & 3];
  const kind = CAT_ELEMENTS[e.kind];
  const col = e.material ? e.material.colour : kind === 'wall' ? 0xd8d0c2 : 0x9d9a94;
  const fin = e.material ? CAT_FIN[e.material.finish] << 4 : 0;
  // each element a little apart from the others (1.2 cm up by index mod 5, 1 cm in by index mod 3): pieces the data
  // lays flush (stacked slabs, a slab on a parking floor, two paths) never share a plane
  const lift = (index % 5) * 0.012, inset = (index % 3) * 0.01;
  const box = (ya: number, yb: number, c: number, mat: number, topC = c) => { blank(mb); prism(mb, f, x - sx / 2 + inset, x + sx / 2 - inset, z - sz / 2 + inset, z + sz / 2 - inset, ya + lift, yb + lift, c, mat | fin, 50, topC, mat | fin); };
  const decal = 0.04 + Math.min(0.12, (e.z + e.h) * U) + lift;
  // a run along its long side, from end to end at the middle of its thickness
  const run = (): [number, number, number, number, number] => sx >= sz ? [x - sx / 2, z, x + sx / 2, z, sz] : [x, z - sz / 2, x, z + sz / 2, sx];
  switch (kind) {
    case 'tree': part(f, 0, x, gy, z, Math.sin(yaw), Math.cos(yaw), Math.max(0.5, Math.min(2, h / 7)), P_TREE); break;
    case 'shrub': case 'hedge': case 'flowers': part(f, 0, x, gy, z, 0, 1, Math.max(0.4, Math.min(1.6, Math.max(sx, sz) / 1.6)), P_BUSH); break;
    case 'bench': part(f, 0, x, gy, z, Math.sin(yaw), Math.cos(yaw), 1, P_BENCH); break;
    case 'lamp': part(f, 0, x, gy, z, Math.sin(yaw), Math.cos(yaw), 1, P_LAMP); break;
    case 'bin': part(f, 0, x, gy, z, Math.sin(yaw), Math.cos(yaw), 1, P_BIN); break;
    case 'bollard': part(f, F_BOLLARD, x, gy, z, 0, 1, 1, P_FURN); break;
    case 'drain': part(f, F_DRAIN, x, gy, z, 0, 1, 1, P_FURN); break;
    case 'planter': part(f, F_PLANTER, x, gy, z, Math.sin(yaw), Math.cos(yaw), Math.max(0.6, Math.min(1.6, Math.max(sx, sz) / 1.2)), P_FURN); break;
    case 'ac': part(f, PART.WallAc, x, gy, z, Math.sin(yaw), Math.cos(yaw)); break;
    case 'wall': case 'fence': case 'railing': {
      const [ax, az, bx, bz, t] = run();
      if (kind === 'railing') { blank(mb); prism(mb, f, Math.min(ax, bx) - (az === bz ? 0 : 0.03), Math.max(ax, bx) + (az === bz ? 0 : 0.03), Math.min(az, bz) - (az === bz ? 0.03 : 0), Math.max(az, bz) + (az === bz ? 0.03 : 0), gy + h - 0.06, gy + h, 0x5c6064, BMAT.Metal, 50, 0x5c6064, BMAT.Metal); }
      // the runs along z 2.5 cm higher: two walls meeting at a corner never share their top's plane
      if (kind !== 'railing') wall(mb, heights, f, ax, az, bx, bz, h + e.z * U + (ax === bx ? 0.025 : 0), Math.max(0.1, t), kind === 'fence' ? 0x6c7276 : col);
      break;
    }
    case 'gate': { const [ax, az, bx, bz] = run(); gate(mb, heights, f, ax, az, bx, bz, Math.max(1.2, h)); break; }
    case 'slab': case 'pillar': case 'stair': case 'ramp': case 'rocks': case 'clock': box(gy, gy + Math.max(0.1, h), col, BMAT.Plain); break;
    case 'canopy': case 'awning': box(gy + Math.max(0, h - 0.15), gy + Math.max(0.15, h), col, BMAT.Plain); break;
    // ground pieces at their own heights (4.0 lays a path's two layers 1 cm apart: one plane each)
    case 'pavement': if (sx > 0.5 && sz > 0.5) groundPatch(mb, heights, f, W, D, x - sx / 2, x + sx / 2, z - sz / 2, z + sz / 2, col, BMAT.Paving | fin, decal); break;
    case 'parking': {
      const lift = decal;
      groundPatch(mb, heights, f, W, D, x - sx / 2, x + sx / 2, z - sz / 2, z + sz / 2, 0x55585b, BMAT.Paving, lift);
      // bay lines 2.5 m apart across its long side
      const long = Math.max(sx, sz), nb = Math.floor(long / 2.5);
      for (let k = 0; k <= nb; k++) {
        const u = -long / 2 + (long - nb * 2.5) / 2 + k * 2.5;
        const [lx0, lx1, lz0, lz1] = sx >= sz ? [x + u - 0.06, x + u + 0.06, z - sz / 2 + 0.3, z + sz / 2 - 0.3] : [x - sx / 2 + 0.3, x + sx / 2 - 0.3, z + u - 0.06, z + u + 0.06];
        groundPatch(mb, heights, f, W, D, lx0, lx1, lz0, lz1, 0xe8e6df, BMAT.Plain, lift + 0.02);
      }
      break;
    }
  }
}


/** Side garden of a corner lot: lawn strip, two trees, a low wall with planters along the side street. */

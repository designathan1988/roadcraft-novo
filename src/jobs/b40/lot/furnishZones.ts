// The zones of a furnished lot, in the 4.0 order: the free courts, the front, the side strips, the back zone and
// the boundary. Every rule and draw order is Roadcraft 4.0 lotPlan.ts; the code works on the LotBuilder and the b40
// element table.
import type { Xoshiro128 } from '../../../core/rng.ts';
import { B40_ELEMENT, B40_SURFACE } from '../../../world/b40Kinds.ts';
import { FIN } from '../../../shared/finishes.ts';
import { paintOf } from '../paint.ts';
import { unsupportedElements } from '../elements.ts';
import type { B40Made } from '../volumes.ts';
import type { B40Rect } from './plan.ts';
import type { LotBuilder } from './furnish.ts';
import { backCourtyard, backLoading, backParking, backService, boundary } from './furnishBack.ts';

const STALL = 5, AISLE = 6, GARAGE_APRON = 6;
const TERRACE_MIN = 0.8;
const mat = (finish: number, colour: number) => paintOf(finish, colour);
const PAVERS = mat(FIN.Brick, 0x9a958c);
const CONCRETE_PATH = mat(FIN.Concrete, 0xc8c4bb);
const STONE_PATH = mat(FIN.Stone, 0xd2cbbd);

export function furnishZones(lot: LotBuilder, made: B40Made): void {
  const { W, D, F, Bk, env, plan, rng } = lot;
  const front = plan.front, back = plan.back, left = plan.left, right = plan.right;
  const L = lot.sideStrip('left'), R = lot.sideStrip('right');
  const drives = [L.drive, R.drive].filter((r): r is B40Rect => r !== null);
  const walks = [L.walk, R.walk].filter((r): r is B40Rect => r !== null);
  for (const r of drives) {
    const outer = lot.ramp ? 0.5 : 0.35;
    lot.keepClear.push({ x0: r.x0 + (r.x0 < W / 2 ? outer : 0.35), y0: 0, x1: r.x1 - (r.x0 < W / 2 ? 0.35 : outer), y1: Bk });
    if (back.use === 'parking') lot.keepClear.push({ x0: r.x0, y0: Bk - 0.5, x1: r.x1 + 0.5, y1: Math.min(D, Bk + (back.rows === 2 ? STALL + AISLE : AISLE)) });
  }
  const peopleGate = plan.kind === 'shop' || plan.kind === 'office' ? 2 : plan.kind === 'house' ? 1.2 : 1.6;
  if (F > 0) lot.gateWays.push({ x0: lot.door - peopleGate / 2 - 0.5, x1: lot.door + peopleGate / 2 + 0.5 });
  else for (const w of walks) lot.gateWays.push({ x0: w.x0 - 0.5, x1: w.x1 + 0.5 });

  for (const f of made.free) {
    const r = { x0: env.x0 + f.x0, y0: env.y0 + f.y0, x1: env.x0 + f.x1, y1: env.y0 + f.y1 };
    const raised = lot.split !== null && r.y0 >= lot.split.y - 1e-6;
    const fromVolume = lot.t.n, fromElement = lot.t.nextElementId;
    furnishFree(lot, r);
    if (raised) {
      lot.raiseSince(fromVolume, fromElement, lot.backLevel);
      if (r.x0 <= env.x0 + 1e-6 && left.width > 0) lot.hold(env.x0 + 0.15, r.y0, env.x0 + 0.15, r.y1);
      if (r.x1 >= env.x1 - 1e-6 && right.width > 0) lot.hold(env.x1 - 0.15, r.y0, env.x1 - 0.15, r.y1);
    }
  }

  // ---- front zone
  if (F > 0) {
    const frontSurface = front.use === 'garden' || front.use === 'carpad' ? B40_SURFACE.Grass
      : front.use === 'forecourt' ? B40_SURFACE.Pavers : front.use === 'plaza' ? B40_SURFACE.Paving : B40_SURFACE.Asphalt;
    const cuts = drives.map((r) => [r.x0, r.x1] as const).sort((p, q) => p[0] - q[0]);
    let x = 0;
    for (const [a, b] of [...cuts, [W, W] as const]) {
      if (a - x >= 2) lot.lay({ x0: x, y0: 0, x1: a, y1: F }, frontSurface);
      if (b > a) lot.lay({ x0: a, y0: 0, x1: b, y1: F }, lot.driveSurface);
      x = Math.max(x, b);
    }
    if (front.use === 'garden' || front.use === 'carpad') {
      const walkMat = lot.isHouse ? mat(FIN.Brick, 0xb08a6e) : PAVERS;
      lot.walk({ x0: lot.door - 0.7, y0: 0, x1: lot.door + 0.7, y1: F }, walkMat);
      for (const w of walks) {
        const [a, b] = w.x0 < lot.door ? [w.x0, lot.door - 0.7] : [lot.door + 0.7, w.x1];
        lot.walk({ x0: a, y0: F - 1.2, x1: b, y1: F }, walkMat);
      }
      if (front.use === 'carpad') {
        const padLeft = lot.door > W / 2;
        lot.walk(padLeft ? { x0: 0.3, y0: 0, x1: Math.min(3.3, lot.door - 1), y1: F - 0.2 }
          : { x0: Math.max(lot.door + 1, W - 3.3), y0: 0, x1: W - 0.3, y1: F - 0.2 }, CONCRETE_PATH);
      }
      for (let px = 1.2; px < W - 1; px += 2.6) {
        if (!lot.occupied(px, 1.5) && !drives.some((r) => px > r.x0 - 1 && px < r.x1 + 1)) {
          lot.place(rng.float() < 0.5 ? B40_ELEMENT.Shrub : B40_ELEMENT.Flowers, px, 1.5, 0, 1.2, 1.2, 0.8);
        }
      }
      if (F >= 4) {
        for (let px = env.x0 + 1.5; px < env.x1 - 1; px += 3.5) {
          if (!lot.occupied(px, F - 2.4, 1.2)) { lot.place(B40_ELEMENT.Tree, px, F - 2.4, 0, 2.6, 2.6, 4.5); break; }
        }
      }
      for (let px = env.x0 + 1; px < env.x1 - 0.8; px += 2) if (!lot.occupied(px, F - 0.6, 0.7)) lot.place(B40_ELEMENT.Flowers, px, F - 0.6, 0, 1.6, 0.8, 0.35);
    } else if (front.use === 'forecourt') {
      for (let px = 1.6; px < W - 1.2; px += 3.6) {
        if (Math.abs(px - lot.door) < 1.6) continue;
        if (rng.float() < 0.7 && F >= 3) {
          lot.place(B40_ELEMENT.Bench, px, F * 0.35, 0, 1.3, 0.45, 0.45);
          lot.place(B40_ELEMENT.Bench, px, F * 0.35 + 1.3, 2, 1.3, 0.45, 0.45);
        } else lot.place(B40_ELEMENT.Planter, px, F * 0.5, 0, 1, 1, 0.6);
      }
      for (let px = 0.8; px < W - 0.5; px += 1.8) if (Math.abs(px - lot.door) > 1.2 && !drives.some((r) => px > r.x0 - 0.3 && px < r.x1 + 0.3)) lot.place(B40_ELEMENT.Bollard, px, 0.35, 0, 0.2, 0.2, 0.9);
      lot.place(B40_ELEMENT.Bin, W - 1.2, F - 0.6, 0, 0.7, 0.6, 1);
    } else if (front.use === 'plaza') {
      for (let px = 2.5; px < W - 2; px += 6) {
        if (Math.abs(px - lot.door) < 3) continue;
        lot.place(B40_ELEMENT.Planter, px, F * 0.45, 0, 2, 2, 0.6);
        lot.place(B40_ELEMENT.Tree, px, F * 0.45, 0, 2.5, 2.5, 5);
        lot.place(B40_ELEMENT.Bench, px, F * 0.45 + 1.6, 0, 1.6, 0.5, 0.45);
      }
      for (const px of [1, W - 1]) lot.place(B40_ELEMENT.Lamp, px, F - 0.8, 0, 0.3, 0.3, 4.5);
      for (let px = 0.8; px < W - 0.5; px += 2) if (!drives.some((r) => px > r.x0 - 0.3 && px < r.x1 + 0.3)) lot.place(B40_ELEMENT.Bollard, px, 0.35, 0, 0.2, 0.2, 0.9);
    } else if (front.use === 'apron') {
      lot.walk({ x0: lot.door - 0.8, y0: 0, x1: lot.door + 0.8, y1: F }, CONCRETE_PATH);
      if (F >= STALL + AISLE - 1e-6) {
        for (let px = env.x0 + 0.3; px + 2.5 <= env.x1; px += 2.5) {
          if (Math.abs(px + 1.25 - lot.door) < 2.2) continue;
          lot.place(B40_ELEMENT.Parking, px + 1.25, F - 2.6, 2, 2.5, 5, 0.12);
        }
      }
      lot.place(B40_ELEMENT.Lamp, lot.door + 1.6, F - 0.6, 0, 0.3, 0.3, 5);
    }
  }

  // ---- side strips
  for (const s of [L, R]) {
    if (!s.drive) continue;
    const r = { ...s.drive, y0: Math.max(F, s.drive.y0) };
    if (lot.ramp && r.y1 - lot.ramp.start >= 2) {
      const r0 = Math.max(r.y0, lot.ramp.start);
      lot.lay({ ...r, y1: lot.ramp.start }, lot.driveSurface);
      lot.sloped({ ...r, y0: r0 }, lot.driveSurface, 0, lot.backLevel);
      const land = lot.hill?.landAt;
      if (land) {
        const wx = r.x0 < W / 2 ? r.x0 + 0.35 : r.x1 - 0.35;
        const n = Math.max(1, Math.round((r.y1 - r0) / 2));
        for (let k = 0; k < n; k++) {
          const ya = r0 + ((r.y1 - r0) * k) / n, yb = r0 + ((r.y1 - r0) * (k + 1)) / n, yc = (ya + yb) / 2;
          const surface = (lot.backLevel * (yc - r0)) / (r.y1 - r0);
          const cut = Math.max(land(wx, ya), land(wx, yb)) - surface, fill = surface - Math.min(land(wx, ya), land(wx, yb));
          if (cut > 0.3) lot.place(B40_ELEMENT.Slab, wx, yc, 1, yb - ya, 0.25, cut + 0.15, 0, mat(FIN.Stone, 0x9a948a));
          else if (fill > 0.3) lot.place(B40_ELEMENT.Slab, wx, yc, 1, yb - ya, 0.25, 0.95, 0, mat(FIN.Stone, 0x9a948a));
        }
      }
    } else lot.lay(r, lot.driveSurface);
    if (lot.isHouse && Bk - F >= 6 && !lot.garage) {
      const y0 = F + 0.3, y1 = F + 5.8, x0 = r.x0 + 0.05, x1 = r.x1 - 0.05;
      lot.place(B40_ELEMENT.Slab, (x0 + x1) / 2, (y0 + y1) / 2, 0, x1 - x0, y1 - y0, 0.15, 2.4, mat(FIN.Concrete, 0xd0ccc4));
      for (const [px, py] of [[x0 + 0.15, y0 + 0.15], [x1 - 0.15, y0 + 0.15], [x0 + 0.15, y1 - 0.15], [x1 - 0.15, y1 - 0.15]] as const) lot.place(B40_ELEMENT.Pillar, px, py, 0, 0.18, 0.18, 2.4);
    }
    lot.place(B40_ELEMENT.Drain, (r.x0 + r.x1) / 2, Math.min(Bk - 0.6, F + 7), 0, 0.5, 0.5, 0.1);
  }
  const stripVolumes = lot.t.n, stripElements = lot.t.nextElementId;
  for (const s of [L, R]) {
    if (s.walk) {
      lot.walk(s.walk, lot.isHouse ? CONCRETE_PATH : mat(FIN.Stone, 0x8a857c));
      if (!lot.isHouse && s.walk.y1 - s.walk.y0 > 12) lot.place(B40_ELEMENT.Lamp, s.walk.x0 + 0.3, (s.walk.y0 + s.walk.y1) / 2, 0, 0.3, 0.3, 3.5);
      if (!lot.isHouse) {
        const wx = (s.walk.x0 + s.walk.x1) / 2, len = s.walk.y1 - s.walk.y0;
        for (let py = s.walk.y0 + 2; py < s.walk.y1 - 1; py += 5) lot.place(B40_ELEMENT.Drain, wx, py, 0, 0.35, 0.35, 0.1);
        const side = s.walk.x1 - wx > 0.6 ? s.walk.x1 - 0.35 : wx;
        if (len > 6) {
          lot.place(B40_ELEMENT.Bin, side, s.walk.y1 - 2, 3, 1.1, 0.6, 1.1);
          lot.place(B40_ELEMENT.Slab, side, s.walk.y1 - 3.4, 0, 0.6, 0.8, 0.5, 0, mat(FIN.Wood, 0x7a5b3a));
          lot.place(B40_ELEMENT.Slab, side, s.walk.y1 - 3.4, 0, 0.5, 0.6, 0.4, 0.5, mat(FIN.Wood, 0x8b6a45));
        }
      }
    }
    if (s.garden) {
      const g = s.garden;
      const cut = lot.split && lot.split.y > g.y0 + 2 && lot.split.y < g.y1 - 2 ? lot.split.y : null;
      if (cut !== null) { lot.lay({ ...g, y1: cut }, B40_SURFACE.Grass); lot.lay({ ...g, y0: cut }, B40_SURFACE.Grass); }
      else lot.lay(g, B40_SURFACE.Grass);
      for (let py = g.y0 + 2; py < g.y1 - 1.5; py += 5) lot.place(py % 10 < 5 ? B40_ELEMENT.Tree : B40_ELEMENT.Shrub, (g.x0 + g.x1) / 2, py, 0, 2.4, 2.4, 4);
    }
  }
  if (lot.split) {
    lot.raiseSince(stripVolumes, stripElements, lot.backLevel, lot.split.y);
    for (const s of [L, R]) {
      if (s.walk && lot.split.y > s.walk.y0 + 1 && lot.split.y < s.walk.y1 - 1) lot.stepsAt((s.walk.x0 + s.walk.x1) / 2, lot.split.y, Math.max(0.8, s.walk.x1 - s.walk.x0 - 0.1));
      if (s.garden && lot.split.y > s.garden.y0 + 2 && lot.split.y < s.garden.y1 - 2) lot.hold(s.garden.x0 + 0.1, lot.split.y, s.garden.x1 - 0.1, lot.split.y);
      if (s.drive && D - Bk > 0 && !lot.ramp) lot.hold(s.drive.x0 + 0.1, Bk + 0.15, s.drive.x1 - 0.1, Bk + 0.15);
    }
  }

  // ---- back zone
  const by0 = Bk, by1 = D;
  const backVolumes = lot.t.n, backElements = lot.t.nextElementId;
  switch (back.use) {
    case 'yard': {
      const yardVolumes = lot.t.n, yardElements = lot.t.nextElementId;
      const drive = drives[0];
      const apronY = lot.garage ? Math.min(by0, lot.garage.y) : by0;
      const apron = lot.garage && drive && by1 - apronY >= GARAGE_APRON + 1
        ? { x0: Math.min(drive.x0, lot.garage.x - lot.garage.w / 2), y0: apronY, x1: Math.max(drive.x1, lot.garage.x + lot.garage.w / 2 + 0.3), y1: apronY + GARAGE_APRON }
        : null;
      const terrace = apron
        ? (apron.x0 > W / 2 ? { x0: env.x0, y0: by0, x1: Math.max(env.x0, apron.x0), y1: Math.min(by1, by0 + 3) } : { x0: Math.min(env.x1, apron.x1), y0: by0, x1: env.x1, y1: Math.min(by1, by0 + 3) })
        : { x0: env.x0, y0: by0, x1: env.x1, y1: Math.min(by1, by0 + 3) };
      const lawnY0 = terrace.y1, depth = by1 - lawnY0;
      const stepped = !!lot.hill && Math.abs(lot.hill.yard - lot.backLevel) >= TERRACE_MIN;
      const stepFrom = apron ? Math.max(lawnY0, apron.y1) : lawnY0;
      const poolW = Math.min(8, W - 5);
      const stairMid = (env.x0 + env.x1) / 2;
      const poolX0 = !stepped ? (W - poolW) / 2
        : stairMid + 1.2 + poolW <= W - 0.5 ? stairMid + 1.2
          : stairMid - 1.2 - poolW >= 0.5 ? stairMid - 1.2 - poolW : null;
      const poolAt = depth >= 6 && W >= 11 && poolX0 !== null && rng.float() < 0.45
        ? { x0: poolX0, y0: lawnY0 + 1, x1: poolX0 + poolW, y1: lawnY0 + 4.5 } : null;
      const pool = apron ? null : poolAt;
      if (apron) {
        lot.fillAround({ x0: 0, y0: by0, x1: W, y1: stepFrom }, [terrace, apron], B40_SURFACE.Grass);
        lot.fillAround({ x0: 0, y0: stepFrom, x1: W, y1: by1 }, [], B40_SURFACE.Grass);
      } else lot.fillAround({ x0: 0, y0: by0, x1: W, y1: by1 }, pool ? [terrace, pool] : [terrace], B40_SURFACE.Grass);
      lot.lay(terrace, B40_SURFACE.Tiles);
      if (apron) {
        lot.lay(apron, B40_SURFACE.Concrete);
        lot.taken.push(apron); lot.keepClear.push(apron);
        lot.place(B40_ELEMENT.Drain, (apron.x0 + apron.x1) / 2, apron.y0 + 1.2, 0, 0.5, 0.5, 0.1);
      }
      if (pool) {
        lot.lay(pool, B40_SURFACE.Water);
        lot.walk({ x0: pool.x0, y0: lawnY0, x1: pool.x1, y1: pool.y0 }, mat(FIN.Stone, 0xe0d8c8));
        for (const k of [0, 1]) lot.place(B40_ELEMENT.Bench, pool.x1 + 1.4, pool.y0 + 0.6 + k * 1.6, 3, 1.8, 0.65, 0.35, 0, mat(FIN.Wood, 0xe8e4dc));
      }
      lot.taken.push(terrace);
      lot.place(B40_ELEMENT.Bench, (terrace.x0 + terrace.x1) / 2 + 1.5, terrace.y0 + 1.6, 2, 1.4, 0.45, 0.45);
      const service = apron ? null : drives[0] ?? walks[0];
      if (service) {
        const sx0 = service.x0, sx1 = Math.max(service.x1, service.x0 + 2.5);
        lot.walk({ x0: sx0, y0: by0, x1: sx1, y1: Math.min(by1, by0 + 3) }, CONCRETE_PATH);
        lot.place(B40_ELEMENT.Bin, (sx0 + sx1) / 2, by0 + 2.4, 2, 1.3, 0.65, 1.1);
        lot.place(B40_ELEMENT.Drain, (sx0 + sx1) / 2, by0 + 1, 0, 0.5, 0.5, 0.1);
      }
      if (pool) lot.taken.push(pool);
      else if (depth >= 4) for (let px = 1.5; px < W - 1.5; px += 2.2) if (!lot.occupied(px, by1 - 1.2)) lot.place(B40_ELEMENT.Flowers, px, by1 - 1.2, 0, 1.6, 1.2, 0.4);
      if (depth >= 5) for (const px of [2.6, W - 2.6]) if (!lot.occupied(px, by1 - 2.8, 1.5)) lot.place(B40_ELEMENT.Tree, px, by1 - 2.8, 0, 3, 3, 5);
      if (depth >= 7 && W >= 9) {
        const shedX = rng.float() < 0.5 ? 1.6 : W - 1.6;
        if (!lot.occupied(shedX, by1 - 1.4, 1.4)) {
          lot.place(B40_ELEMENT.Wall, shedX, by1 - 1.4, 2, 2.4, 1.9, 2.1, 0, mat(FIN.Wood, 0x8a6a48));
          lot.place(B40_ELEMENT.Slab, shedX, by1 - 1.4, 2, 2.8, 2.3, 0.12, 2.1, mat(FIN.Metal, 0x5a5f61));
          lot.walk({ x0: shedX - 0.5, y0: lawnY0, x1: shedX + 0.5, y1: by1 - 2.5 }, mat(FIN.Stone, 0xbdb6a8));
        }
      }
      if (terrace.x1 - terrace.x0 >= 5 && terrace.y1 - terrace.y0 >= 2.5) {
        const px0 = terrace.x0 + 0.3, px1 = Math.min(terrace.x1 - 0.3, terrace.x0 + 5.5);
        lot.place(B40_ELEMENT.Planter, (px0 + px1) / 2, (terrace.y0 + terrace.y1) / 2, 0, 1.4, 0.8, 0.75, 0, mat(FIN.Wood, 0x9c7a55));
      }
      if (!pool && depth >= 8) {
        const vx = W * (0.35 + rng.float() * 0.3);
        for (let k = 0; k < 3; k++) if (!lot.occupied(vx + k * 1.3, lawnY0 + 3, 0.7)) lot.place(B40_ELEMENT.Planter, vx + k * 1.3, lawnY0 + 3, 0, 0.9, 2.6, 0.35, 0, mat(FIN.Wood, 0x6b4f35));
      }
      rng.float();
      if (depth >= 6 && W >= 8 && rng.float() < 0.55) {
        const cy = lawnY0 + depth * (0.4 + rng.float() * 0.3), cx0 = W * (0.15 + rng.float() * 0.2), cx1 = cx0 + W * 0.4;
        if (!lot.occupied(cx0, cy, 0.4) && !lot.occupied(cx1, cy, 0.4)) {
          for (const cx of [cx0, cx1]) lot.place(B40_ELEMENT.Pillar, cx, cy, 0, 0.08, 0.08, 1.9, 0, mat(FIN.Metal, 0x9aa0a2));
          lot.place(B40_ELEMENT.Slab, (cx0 + cx1) / 2, cy, 0, cx1 - cx0, 0.03, 0.02, 1.8, mat(FIN.Metal, 0xd8d8d0));
          lot.place(B40_ELEMENT.Slab, (cx0 + cx1) / 2 - 0.6, cy, 0, 0.7, 0.03, 0.6, 1.2, mat(FIN.Plaster, 0xc85a5a));
          lot.place(B40_ELEMENT.Slab, (cx0 + cx1) / 2 + 0.5, cy, 0, 0.6, 0.03, 0.5, 1.3, mat(FIN.Plaster, 0xe8e4d4));
        }
      }
      if (W >= 7 && rng.float() < 0.6) {
        const tx = rng.float() < 0.5 ? W - 1.3 : 1.3, ty = by0 + 1.2;
        if (!lot.occupied(tx, ty, 0.7)) lot.place(B40_ELEMENT.Wall, tx, ty, 0, 0.7, 0.55, 0.85, 0, mat(FIN.Concrete, 0xbdb8ae));
      }
      for (const px of [1.5, W - 1.5]) for (let py = lawnY0 + 1.5; py < by1 - 3; py += 3.2) if (!lot.occupied(px, py, 0.9)) lot.place(B40_ELEMENT.Shrub, px, py, 0, 1.3, 1.3, 1.4);
      if (depth >= 10 && W >= 8) longYard(lot, terrace, lawnY0, by1, depth, rng);
      for (let px = terrace.x0 + 0.6; px < terrace.x1 - 0.5; px += 1.6) if (!lot.occupied(px, terrace.y1 - 0.4, 0.3)) lot.place(B40_ELEMENT.Planter, px, terrace.y1 - 0.4, 0, 0.5, 0.5, 0.55);
      if (stepped) lot.terraceYard(stepFrom, by1, lot.hill!.yard - lot.backLevel, yardVolumes, yardElements, (env.x0 + env.x1) / 2, lot.backLevel);
      break;
    }
    case 'parking': backParking(lot, by0, by1, W, D, back, drives, rng); break;
    case 'service': backService(lot, by0, by1, W, env); break;
    case 'courtyard': backCourtyard(lot, by0, by1, W, env, walks); break;
    case 'loading': backLoading(lot, by0, by1, W, D, env); break;
    default: break;
  }
  if (lot.split) lot.raiseSince(backVolumes, backElements, lot.backLevel);

  boundary(lot, W, D, F, Bk, env, left, right, L, R, walks, drives, rng);
  const loose = unsupportedElements(lot.t);
  for (let i = lot.t.elN - 1; i >= 0; i--) if (loose.has(i)) lot.t.removeElement(i);
}


function furnishFree(lot: LotBuilder, r: B40Rect): void {
  const plan = lot.plan;
  if (plan.kind === 'industry') {
    lot.lay(r, B40_SURFACE.Asphalt);
    for (let x = r.x0 + 0.3; x + 2.5 <= r.x1 - 0.2; x += 2.5) lot.place(B40_ELEMENT.Parking, x + 1.25, r.y0 + Math.min(2.5, (r.y1 - r.y0) / 2), 0, 2.5, Math.min(5, r.y1 - r.y0 - 0.2), 0.12);
  } else if (r.y1 - r.y0 <= 6 && r.x1 - r.x0 <= 8) {
    lot.lay(r, B40_SURFACE.Tiles);
    lot.place(B40_ELEMENT.Planter, r.x1 - 0.8, r.y1 - 0.8, 0, 1, 1, 0.6);
    lot.place(B40_ELEMENT.Bench, (r.x0 + r.x1) / 2, r.y1 - 0.5, 2, 1.4, 0.45, 0.45);
  } else {
    const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
    const pw = Math.min(r.x1 - r.x0 - 2, 6), pd = Math.min(r.y1 - r.y0 - 2, 6);
    if (pw >= 2 && pd >= 2) {
      lot.walk({ x0: cx - pw / 2, y0: cy - pd / 2, x1: cx + pw / 2, y1: cy + pd / 2 }, STONE_PATH);
      lot.place(B40_ELEMENT.Bench, cx, cy - pd / 2 + 0.6, 0, 1.6, 0.5, 0.45);
      lot.place(B40_ELEMENT.Bench, cx, cy + pd / 2 - 0.6, 2, 1.6, 0.5, 0.45);
    }
    for (const [x, y] of [[r.x0 + 1.5, r.y0 + 1.5], [r.x1 - 1.5, r.y1 - 1.5]] as const) lot.place(B40_ELEMENT.Tree, x, y, 0, 3, 3, 5);
    lot.place(B40_ELEMENT.Flowers, r.x1 - 1.2, r.y0 + 1.2, 0, 1.4, 1.4, 0.4);
  }
}

function longYard(lot: LotBuilder, terrace: B40Rect, lawnY0: number, by1: number, depth: number, rng: Xoshiro128): void {
  const W = lot.W, far = by1 - 0.4;
  const flip = rng.float() < 0.5;
  const fx = (x: number): number => (flip ? W - x : x);
  const pick = rng.int(0, 4);
  const jit = (a: number): number => a + (rng.float() - 0.5) * 1.2;
  const put = (kind: number, x: number, y: number, f: 0 | 1 | 2 | 3, w: number, d: number, h: number, z?: number, mt?: { finish: number; colour: number }): boolean =>
    !lot.occupied(fx(x), y, Math.max(w, d) / 2) && lot.place(kind, fx(x), y, f, w, d, h, z, mt);
  const edicula = (x: number, y: number, wide: number, deep: number): void => {
    if (!put(B40_ELEMENT.Wall, x, y, 2, wide, deep, 2.6, undefined, mat(FIN.Plaster, [0xe9dcc4, 0xd8c7a8, 0xc9d4c4, 0xe4cfc0][rng.int(0, 3)]!))) return;
    lot.place(B40_ELEMENT.Slab, fx(x), y, 2, wide + 0.6, deep + 0.6, 0.22, 2.6, mat(FIN.Tile, [0xa4533a, 0x8a4a35, 0x6e6a64][rng.int(0, 2)]!));
    for (let k = 1; k < 7; k++) {
      const t = k / 7, sx = (terrace.x0 + terrace.x1) / 2 + (fx(x) - (terrace.x0 + terrace.x1) / 2) * t;
      const sy = lawnY0 + (y - deep / 2 - 0.6 - lawnY0) * t;
      if (!lot.occupied(sx, sy, 0.3)) lot.place(B40_ELEMENT.Pavement, sx, sy, 0, 0.7, 0.55, 0.06, 0, mat(FIN.Stone, 0xb8b2a6));
    }
  };
  const trees = (n: number, y: number): void => { for (let k = 0; k < n; k++) put(B40_ELEMENT.Tree, jit(1.8 + k * ((W - 3.6) / Math.max(1, n - 1))), jit(y), 0, 3, 3, 3.6 + rng.float() * 1.8); };
  const beds = (x0: number, y0: number, cols: number, rows: number): void => {
    for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) put(B40_ELEMENT.Planter, x0 + i * 1.5, y0 + j * 1.25, 0, 1.15, 0.85, 0.35, undefined, mat(FIN.Wood, 0x7a5636));
  };
  const swing = (x: number, y: number): void => {
    if (!put(B40_ELEMENT.Pillar, x - 1.1, y, 0, 0.1, 0.1, 2.2, undefined, mat(FIN.Metal, 0x2f6e9e))) return;
    lot.place(B40_ELEMENT.Pillar, fx(x + 1.1), y, 0, 0.1, 0.1, 2.2, undefined, mat(FIN.Metal, 0x2f6e9e));
    lot.place(B40_ELEMENT.Slab, fx(x), y, 0, 2.3, 0.08, 0.08, 2.2, mat(FIN.Metal, 0x2f6e9e));
    for (const k of [-1, 1]) lot.place(B40_ELEMENT.Pillar, fx(x) + k * 0.22, y, 0, 0.02, 0.02, 1.7, 0.5, mat(FIN.Metal, 0x8a8f94));
    lot.place(B40_ELEMENT.Slab, fx(x), y, 0, 0.5, 0.25, 0.05, 0.45, mat(FIN.Wood, 0x8a6040));
  };
  const table = (x: number, y: number): void => {
    if (!put(B40_ELEMENT.Slab, x, y, 0, 1.0, 1.0, 0.05, 0.72, mat(FIN.Wood, 0x8d6a46))) return;
    lot.place(B40_ELEMENT.Pillar, fx(x), y, 0, 0.1, 0.1, 0.72, undefined, mat(FIN.Metal, 0x3a3d40));
    for (const [oy, f] of [[0.95, 2], [-0.95, 0]] as const) lot.place(B40_ELEMENT.Bench, fx(x), y + oy, f, 1.1, 0.42, 0.45, undefined, mat(FIN.Wood, 0x7a5a3c));
  };
  const dogHouse = (x: number, y: number): void => {
    if (put(B40_ELEMENT.Wall, x, y, 3, 1.0, 0.9, 0.8, undefined, mat(FIN.Wood, 0x9a6a3f))) lot.place(B40_ELEMENT.Slab, fx(x), y, 3, 1.2, 1.1, 0.12, 0.8, mat(FIN.Tile, 0x8a3e2c));
  };
  const coop = (x: number, y: number): void => {
    if (put(B40_ELEMENT.Fence, x, y, 0, 2.4, 1.6, 1.2, undefined, mat(FIN.Metal, 0x8a9094))) lot.place(B40_ELEMENT.Wall, fx(x + 0.7), y, 0, 0.9, 1.2, 1.0, undefined, mat(FIN.Wood, 0x8c6a48));
  };
  const firewood = (x: number, y: number): void => { put(B40_ELEMENT.Slab, x, y, 2, 1.6, 0.5, 0.9, 0, mat(FIN.Wood, 0x6e4c2c)); };
  const trampoline = (x: number, y: number): void => {
    if (!put(B40_ELEMENT.Slab, x, y, 0, 2.6, 2.6, 0.08, 0.6, mat(FIN.Panel, 0x24303a))) return;
    for (const [dx, dy] of [[-1.15, -1.15], [1.15, -1.15], [-1.15, 1.15], [1.15, 1.15]] as const) lot.place(B40_ELEMENT.Pillar, fx(x) + dx, y + dy, 0, 0.06, 0.06, 0.6, 0, mat(FIN.Metal, 0x3a3d40));
  };
  switch (pick) {
    case 0:
      trees(3, far - 1.8); trees(2, lawnY0 + depth * 0.55); put(B40_ELEMENT.Bench, jit(W / 2), lawnY0 + depth * 0.35, 2, 1.4, 0.45, 0.45);
      break;
    case 1:
      swing(jit(W * 0.6), lawnY0 + depth * 0.6); trampoline(jit(W * 0.3), lawnY0 + depth * 0.7); dogHouse(W - 1.4, jit(lawnY0 + depth * 0.4)); table(jit(W * 0.4), lawnY0 + depth * 0.3);
      break;
    case 2:
      beds(1.6, lawnY0 + depth * 0.35, Math.min(4, Math.floor((W - 3) / 1.5)), 3); coop(W - 2, far - 1.6); trees(1, far - 1.8); firewood(1.2, far - 0.5);
      break;
    case 3:
      edicula(W - 3.2, far - 2.2, 4.4 + rng.float(), 3.4 + rng.float()); firewood(1.2, far - 0.5); dogHouse(1.4, jit(lawnY0 + depth * 0.5)); table(jit(W * 0.35), lawnY0 + depth * 0.25);
      break;
    default:
      edicula(W / 2, far - 2.2, 5 + rng.float(), 3.6); put(B40_ELEMENT.Pavement, W / 2, far - 4.6, 0, 5, 1.6, 0.08, 0, mat(FIN.Wood, 0x9a7650));
      table(jit(W * 0.3), lawnY0 + depth * 0.45); trees(2, lawnY0 + depth * 0.65); beds(1.6, lawnY0 + depth * 0.2, 2, 1);
  }
}

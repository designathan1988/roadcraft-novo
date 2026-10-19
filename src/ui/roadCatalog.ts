// The road catalogue in the Roads drawer (Roadcraft's catalogPanel: tabs by category, a card drawn from above for
// each road, its width and price) and the cross-section editor (Roadcraft's profile editor, Streetmix-like): the
// player builds the road strip by strip, sets widths, direction, bus lanes, arrows, paving and speed, and draws
// with it or saves it as a template. Cards are drawn once per category shown; picking a road only moves the ring.

import {
  PROFILES, PROFILE_INFO, Paving, Surface, TurnBit, normalize, profileIssueSpots, profileKey, registerProfile,
  type Category, type ProfileIssue, type Centre, type Profile, type Strip, type StripKind,
} from '../roads/profiles.ts';
import { STEP_LIMITS, fromWork, insertionIndex, movedStrip, newStrip, toWork, withStripWidth, type PaletteKind } from '../roads/profileWork.ts';
import { el } from './dom.ts';
import { svg } from './icons.ts';
import { fmtDec, lang, loose, money, plural, t } from './i18n.ts';

const CATS: Array<[Category, string]> = [['ruas', 'catalog.cat.streets'], ['avenidas', 'catalog.cat.avenues'], ['rodovias', 'catalog.cat.highways'],
  ['especiais', 'catalog.cat.special'], ['trilhos', 'catalog.cat.rails'], ['meus', 'catalog.cat.mine']];
const KIND_KEY: Record<StripKind, string> = {
  sidewalk: 'profile.element.footway', curb: 'ui.strip.curb', parking: 'profile.element.parking', bike: 'profile.element.cycle', lane: 'profile.element.lane',
  median: 'profile.element.median', shoulder: 'ui.strip.shoulder', barrier: 'ui.strip.barrier',
};
const KIND_COLOR: Record<StripKind, string> = {
  sidewalk: '#bcb5a7', curb: '#e0dbd2', parking: '#55585c', bike: '#3f8f55', lane: '#45484c', median: '#5e8a46', shoulder: '#5f6164', barrier: '#a9a59d',
};
const TURNS: Array<[number, string]> = [
  [0, 'ui.turn.auto'], [TurnBit.Left | TurnBit.Straight | TurnBit.Right, 'road.turn.all'], [TurnBit.Left, 'road.turn.left'], [TurnBit.Straight, 'road.turn.through'],
  [TurnBit.Right, 'road.turn.right'], [TurnBit.Left | TurnBit.Straight, 'road.turn.leftThrough'], [TurnBit.Straight | TurnBit.Right, 'road.turn.throughRight'],
];
const STORE = 'cidade.modelosDeVia';

export interface CatalogActions {
  use(id: number): void;
  toast(text: string): void;
}

/** The player's templates, kept in the browser (they serve every map). */
function readTemplates(): Array<Omit<Profile, 'id'>> {
  try {
    const raw = localStorage.getItem(STORE);
    const list = raw ? JSON.parse(raw) as Array<Omit<Profile, 'id'>> : [];
    return Array.isArray(list) ? list.filter((p) => p && Array.isArray(p.strips) && p.strips.length > 0) : [];
  } catch { return []; }
}
function writeTemplates(list: Array<Omit<Profile, 'id'>>): boolean {
  try { localStorage.setItem(STORE, JSON.stringify(list)); return true; } catch { return false; }
}

/** A road's name in the player's language (the engine names its profiles in Portuguese). */
export const profileName = (p: { name: string; custom?: boolean }): string => (p.custom ? p.name : loose(p.name));

/** The strips from the image's left edge to its right (seen from A to B, the right edge on the right). */
const leftToRight = (p: Omit<Profile, 'id'>): Strip[] => p.strips.slice().reverse();

/**
 * A road seen FROM ABOVE, as the game draws it (Roadcraft's profileSwatch): pavements in their paving, kerbs,
 * asphalt, parked cars, lane lines, arrows on one-way roads. The strips run across the tile from top to bottom.
 */
export function topSwatch(p: Omit<Profile, 'id'>, span: number, width = 124, height = 64, dpr = 2): string {
  const cv = document.createElement('canvas');
  cv.width = width * dpr; cv.height = height * dpr;
  const g = cv.getContext('2d');
  if (!g) return '';
  g.scale(dpr, dpr);
  const bg = g.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, '#55753f'); bg.addColorStop(1, '#476536');
  g.fillStyle = bg; g.fillRect(0, 0, width, height);
  const strips = leftToRight(p);
  const total = strips.reduce((s, x) => s + x.width, 0) || 1;
  const fill = 0.62 + 0.24 * Math.min(1, total / Math.max(span, 1e-6));
  const k = height * fill / total;
  const asphalt = p.surface === Surface.Concrete ? '#9a9a94' : p.surface === Surface.Cobble ? '#7d7468' : p.surface === Surface.Ballast ? '#6b6258' : '#3f4245';
  const cars = ['#c8ccd0', '#2f4f7a', '#b8382e', '#e8e4dc', '#3d3d3d', '#7a8f4f'];
  let y = (height - total * k) / 2;
  const bands: Array<{ s: Strip; y0: number; y1: number }> = [];
  for (const s of strips) {
    const h = Math.max(0.6, s.width * k), y0 = y, y1 = y + h;
    switch (s.kind) {
      case 'sidewalk':
        g.fillStyle = s.pave === Paving.Pavers ? '#c4c0b4' : s.pave === Paving.Stone ? '#a9a294' : '#bdbdb7';
        g.fillRect(0, y0, width, h);
        g.fillStyle = 'rgba(0,0,0,0.08)';
        for (let x = 3; x < width; x += 6) g.fillRect(x, y0, 0.6, h);
        break;
      case 'median':
        g.fillStyle = s.pave === Paving.Concrete ? '#a8a69e' : s.pave === Paving.Pavers ? '#b6b0a2' : '#5e8a46';
        g.fillRect(0, y0, width, h);
        if ((s.pave ?? Paving.Grass) === Paving.Grass && h >= 3) {
          for (let x = 8; x < width; x += 18) {
            g.fillStyle = '#2f5a2a'; g.beginPath(); g.arc(x, (y0 + y1) / 2, Math.min(h * 0.9, 5), 0, Math.PI * 2); g.fill();
            g.fillStyle = '#4f8a3f'; g.beginPath(); g.arc(x - 1, (y0 + y1) / 2 - 1, Math.min(h * 0.55, 3), 0, Math.PI * 2); g.fill();
          }
        }
        break;
      case 'bike': g.fillStyle = '#3f8f55'; g.fillRect(0, y0, width, h); break;
      case 'curb': g.fillStyle = '#e4e1d8'; g.fillRect(0, y0, width, h); break;
      case 'barrier': g.fillStyle = '#a9a59d'; g.fillRect(0, y0, width, h); break;
      case 'shoulder': g.fillStyle = '#4b4e52'; g.fillRect(0, y0, width, h); break;
      case 'parking':
        g.fillStyle = asphalt; g.fillRect(0, y0, width, h);
        g.fillStyle = '#f2f2ee';
        for (let x = 0; x < width; x += 14) g.fillRect(x, y0, 0.8, h);
        for (let x = 2, n = 0; x + 10 < width; x += 14, n++) {
          if ((n * 7) % 3 === 2) continue;
          g.fillStyle = cars[n % cars.length]; g.fillRect(x + 1, y0 + h * 0.18, 9, h * 0.64);
          g.fillStyle = 'rgba(20,30,40,0.55)'; g.fillRect(x + 3, y0 + h * 0.24, 2.5, h * 0.52);
        }
        break;
      case 'lane':
        g.fillStyle = s.bus ? '#8f3a33' : asphalt; g.fillRect(0, y0, width, h);
        if (s.rail) { g.fillStyle = '#8a8a86'; g.fillRect(0, y0 + h * 0.3, width, 0.9); g.fillRect(0, y0 + h * 0.7, width, 0.9); g.fillStyle = 'rgba(80,60,40,0.7)'; for (let x = 1; x < width; x += 4) g.fillRect(x, y0 + h * 0.2, 1.4, h * 0.6); }
        break;
    }
    bands.push({ s, y0, y1 });
    y = y1;
  }
  const lanes = bands.filter((b) => b.s.kind === 'lane' && !b.s.rail);
  for (let i = 0; i + 1 < bands.length; i++) {
    const a = bands[i], b = bands[i + 1];
    if (a.s.kind !== 'lane' || b.s.kind !== 'lane' || a.s.rail) continue;
    const yy = a.y1;
    if ((a.s.dir ?? 1) !== (b.s.dir ?? 1)) { g.fillStyle = '#e8c440'; g.fillRect(0, yy - 1.4, width, 0.9); g.fillRect(0, yy + 0.5, width, 0.9); }
    else { g.fillStyle = '#f2f2ee'; if (b.s.solid) g.fillRect(0, yy - 0.5, width, 1); else for (let x = 2; x < width; x += 10) g.fillRect(x, yy - 0.5, 5, 1); }
  }
  if (p.oneWay) {
    g.fillStyle = '#f2f2ee';
    for (const b of lanes) {
      const cy = (b.y0 + b.y1) / 2, sz = Math.min(3, (b.y1 - b.y0) * 0.35), back = b.s.dir === -1;
      for (const x of [width * 0.3, width * 0.72]) {
        g.beginPath(); g.moveTo(x + (back ? -sz * 1.6 : sz * 1.6), cy); g.lineTo(x + (back ? sz : -sz), cy - sz); g.lineTo(x + (back ? sz : -sz), cy + sz); g.closePath(); g.fill();
      }
    }
  }
  return cv.toDataURL('image/png');
}

/** Colours of Roadcraft 4.0's street section (ui/roads/crossSection.ts:36-41). */
const XS = {
  asphalt: '#3a3f44', concrete: '#8d8c86', cobble: '#6b5f52', pavers: '#a39f95', footConcrete: '#b8b6ae', stone: '#b59b77',
  kerb: '#dedbd3', grass: '#4f7d43', earth: '#2a2420', earthLine: '#3a322c', white: '#f2efe6', yellow: '#e5c14c',
  cycle: '#3f8f57', bus: '#7a3a34', barrier: '#c9c4b8', shoulder: '#4a4f54',
} as const;
const r1 = (v: number): number => Math.round(v * 10) / 10;

/**
 * A road's cross-section as a street section, the way Roadcraft 4.0 draws it (ui/roads/crossSection.ts:55-157): the
 * strips from the left edge to the right one seen from A towards B, raised ones on a kerb, lane lines between
 * lanes, and to the road's metre scale a car in each lane (its back when it goes towards B), a person on a
 * sidewalk, a tree on a grass median, a cyclist, a P on parking, the widths under the strips. `selected` rings one
 * strip (its index in the profile). Returns the SVG and each strip's span in pixels (by profile index).
 */
export function sectionSvg(p: Omit<Profile, 'id'>, o: {
  width: number; height: number; labels?: boolean; selected?: number; title?: string;
  /** The editor's: grab handles on the boundaries and a hit area over each strip (4.0 crossSection.ts:85-86, :147-153). */
  handles?: boolean;
  /** Strips with a problem: a warning badge (4.0 :138-146). */
  flagged?: ReadonlySet<number>;
  /** The strip being dragged to a new place, faded (4.0 :101). */
  dragging?: number;
  /** Pixels per metre to keep while a width is dragged, and the edge that stays put (4.0 :28-31, :72). */
  ppm?: number; anchor?: 'left' | 'right';
}): { svg: string; spans: Array<[number, number]>; ppm: number } {
  const { width, height } = o;
  // a thumbnail (a template card): no people, cars, signs, labels or handles (4.0 crossSection.ts:57-68)
  const compact = height < 60;
  const labels = o.labels !== false && !compact;
  const pad = compact ? 3 : 12, total = Math.max(1e-6, p.strips.reduce((s, x) => s + x.width, 0));
  const ppm = o.ppm ?? (width - pad * 2) / total;
  const depth = compact ? 4 : 12, base = compact ? Math.round(height * 0.66) : height - depth - (labels ? 30 : 4);
  const rise = compact ? 3 : Math.max(5, Math.min(9, 0.15 * ppm)), headroom = base - 30, iconY = 36;
  const order = p.strips.map((_, i) => i).reverse();
  const spans: Array<[number, number]> = [];
  let x = o.ppm !== undefined && o.anchor === 'right' ? width - pad - total * ppm : pad;
  for (const i of order) { spans[i] = [r1(x), r1(x + p.strips[i].width * ppm)]; x += p.strips[i].width * ppm; }
  const carriage = p.surface === Surface.Concrete ? XS.concrete : p.surface === Surface.Cobble ? XS.cobble : XS.asphalt;
  const raised = (s: Strip): boolean => !s.flush && (s.kind === 'sidewalk' || s.kind === 'median' || s.kind === 'curb');
  const fill = (s: Strip): string => {
    switch (s.kind) {
      case 'sidewalk': return s.pave === Paving.Stone ? XS.stone : s.pave === Paving.Concrete ? XS.footConcrete : XS.pavers;
      case 'curb': return XS.kerb;
      case 'median': return s.flush ? carriage : s.pave === Paving.Concrete ? XS.footConcrete : s.pave === Paving.Pavers ? XS.pavers : s.pave === Paving.Stone ? XS.stone : XS.grass;
      case 'bike': return XS.cycle;
      case 'barrier': return XS.barrier;
      case 'shoulder': return XS.shoulder;
      case 'lane': return s.bus ? XS.bus : s.rail ? '#5a4f45' : carriage;
      default: return carriage;
    }
  };
  const parts: string[] = [
    `<rect x="0" y="${base}" width="${width}" height="${height - base}" fill="${XS.earth}"/>`,
    `<rect x="0" y="${base + depth}" width="${width}" height="1" fill="${XS.earthLine}"/>`,
  ];
  const car = (cx: number, w: number, paint: string, front: boolean): string => {
    const h = w * 0.78, x0 = r1(cx - w / 2), y = base - h, lamp = front ? '#fff4c8' : '#d9483b';
    return `<g class="xs-car"><rect x="${x0}" y="${r1(y + h * 0.36)}" width="${r1(w)}" height="${r1(h * 0.5)}" rx="${r1(w * 0.12)}" fill="${paint}"/>` +
      `<rect x="${r1(x0 + w * 0.14)}" y="${r1(y)}" width="${r1(w * 0.72)}" height="${r1(h * 0.46)}" rx="${r1(w * 0.14)}" fill="${paint}"/>` +
      `<rect x="${r1(x0 + w * 0.21)}" y="${r1(y + h * 0.07)}" width="${r1(w * 0.58)}" height="${r1(h * 0.28)}" rx="${r1(w * 0.06)}" fill="#2a3a44"/>` +
      `<rect x="${r1(x0 + w * 0.05)}" y="${r1(y + h * 0.5)}" width="${r1(w * 0.17)}" height="${r1(h * 0.09)}" rx="1" fill="${lamp}"/>` +
      `<rect x="${r1(x0 + w * 0.78)}" y="${r1(y + h * 0.5)}" width="${r1(w * 0.17)}" height="${r1(h * 0.09)}" rx="1" fill="${lamp}"/>` +
      `<rect x="${r1(x0 + w * 0.04)}" y="${r1(base - h * 0.16)}" width="${r1(w * 0.19)}" height="${r1(h * 0.16)}" rx="2" fill="#15191c"/>` +
      `<rect x="${r1(x0 + w * 0.77)}" y="${r1(base - h * 0.16)}" width="${r1(w * 0.19)}" height="${r1(h * 0.16)}" rx="2" fill="#15191c"/></g>`;
  };
  for (const i of order) {
    const s = p.strips[i], [x0, x1] = spans[i], w = x1 - x0, cx = (x0 + x1) / 2;
    const top = s.kind === 'barrier' ? base - Math.min(headroom * 0.4, 0.9 * ppm) : raised(s) ? base - rise : base;
    const g: string[] = [];
    // the whole column above a strip picks it (4.0 :85-86): the air over a lane is the lane
    if (o.handles) g.push(`<rect class="xs-hit" x="${x0}" y="0" width="${r1(w)}" height="${base + depth}" fill="transparent"/>`);
    g.push(`<rect x="${x0}" y="${r1(top)}" width="${r1(w)}" height="${r1(base - top + depth)}" fill="${fill(s)}"/>`);
    // a kerb's light edge where a raised strip meets a lower one (4.0 :89-95), when the profile has no kerb strip there
    if (raised(s) && s.kind !== 'curb') {
      const kw = Math.min(3, w), k = order.indexOf(i), prev = p.strips[order[k - 1]], next = p.strips[order[k + 1]];
      if (prev && !raised(prev)) g.push(`<rect x="${x0}" y="${r1(top)}" width="${kw}" height="${r1(rise + 1)}" fill="${XS.kerb}"/>`);
      if (next && !raised(next)) g.push(`<rect x="${r1(x1 - kw)}" y="${r1(top)}" width="${kw}" height="${r1(rise + 1)}" fill="${XS.kerb}"/>`);
    }
    if (compact) {
      if (s.kind === 'median' && !s.flush && (s.pave ?? Paving.Grass) === Paving.Grass) {
        const r = Math.min(w * 0.42, height * 0.2);
        g.push(`<circle cx="${r1(cx)}" cy="${r1(top - r * 1.15)}" r="${r1(r)}" fill="#5f9a4f"/>`);
      }
    } else if (s.kind === 'sidewalk') {
      const step = Math.max(5, 0.5 * ppm);
      for (let xx = x0 + step; xx < x1 - 2; xx += step) g.push(`<rect x="${r1(xx)}" y="${r1(top)}" width="1" height="${r1(base - top + depth)}" fill="#00000026"/>`);
      if (w >= 12) {
        const k = Math.min(1.7 * ppm, headroom * 0.74);
        g.push(`<g class="xs-person"><circle cx="${r1(cx)}" cy="${r1(top - k * 0.9)}" r="${r1(k * 0.1)}" fill="#e2c3a1"/><rect x="${r1(cx - k * 0.13)}" y="${r1(top - k * 0.79)}" width="${r1(k * 0.26)}" height="${r1(k * 0.4)}" rx="${r1(k * 0.08)}" fill="#3f6fa8"/>` +
          `<rect x="${r1(cx - k * 0.11)}" y="${r1(top - k * 0.42)}" width="${r1(k * 0.09)}" height="${r1(k * 0.42)}" fill="#2d3238"/><rect x="${r1(cx + k * 0.02)}" y="${r1(top - k * 0.42)}" width="${r1(k * 0.09)}" height="${r1(k * 0.42)}" fill="#2d3238"/></g>`);
      }
    } else if (s.kind === 'lane' && !s.rail) {
      const back = (s.dir ?? 1) === -1;
      if (w >= 14) g.push(car(cx, Math.min(1.8 * ppm, w * 0.78, (headroom * 0.66) / 0.78), s.bus ? '#e6b53c' : '#c9d2d6', back));
      const len = Math.min(26, w * 0.55), h = len / 2, head = Math.min(9, len * 0.45), sg = back ? -1 : 1;
      const pts = [[-h, -2], [h - head, -2], [h - head, -6], [h, 0], [h - head, 6], [h - head, 2], [-h, 2]].map(([px, py]) => `${r1(cx + sg * px)},${r1(iconY + py)}`).join(' ');
      g.push(`<polygon class="xs-arrow" points="${pts}" fill="${XS.white}"/>`);
    } else if (s.kind === 'parking') {
      if (w >= 12) g.push(car(cx, Math.min(1.8 * ppm, w * 0.82, (headroom * 0.66) / 0.78), '#7f8a93', false));
      g.push(`<rect x="${r1(cx - 8)}" y="${iconY - 8}" width="16" height="16" rx="3" fill="#2f6fd0"/><text x="${r1(cx)}" y="${iconY + 5}" text-anchor="middle" class="xs-glyph" fill="#fff" font-size="12" font-weight="700">P</text>`);
    } else if (s.kind === 'bike') {
      g.push(`<rect x="${r1(cx - 9)}" y="${iconY - 9}" width="18" height="18" rx="3" fill="#2c7a45"/><g fill="none" stroke="#f2efe6" stroke-width="1.6"><circle cx="${r1(cx - 4.2)}" cy="${r1(iconY + 2.5)}" r="3"/><circle cx="${r1(cx + 4.2)}" cy="${r1(iconY + 2.5)}" r="3"/><path d="M${r1(cx - 4.2)} ${r1(iconY + 2.5)}L${r1(cx - 1)} ${r1(iconY - 2.5)}H${r1(cx + 2.5)}L${r1(cx + 4.2)} ${r1(iconY + 2.5)}"/></g>`);
    } else if (s.kind === 'median' && !s.flush && (s.pave ?? Paving.Grass) === Paving.Grass && w >= 8) {
      const r = Math.min(w * 0.46, 1.6 * ppm), hh = Math.min(headroom * 0.95, 5 * ppm), cy = top - hh + r;
      g.push(`<g class="xs-tree"><rect x="${r1(cx - Math.max(1.5, r * 0.09))}" y="${r1(cy)}" width="${r1(Math.max(3, r * 0.18))}" height="${r1(top - cy)}" fill="#6b4a2f"/><circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(r)}" fill="#4f8a42"/>` +
        `<circle cx="${r1(cx - r * 0.38)}" cy="${r1(cy - r * 0.22)}" r="${r1(r * 0.62)}" fill="#64a353"/><circle cx="${r1(cx + r * 0.42)}" cy="${r1(cy + r * 0.12)}" r="${r1(r * 0.5)}" fill="#5a9a4b"/></g>`);
    }
    parts.push(`<g data-index="${i}" class="xs-el${o.dragging === i ? ' xs-dragging' : ''}">${g.join('')}</g>`);
  }
  // lane lines: between opposite directions a double yellow, between lanes of one a white one (solid when asked)
  for (let k = 0; k + 1 < order.length; k++) {
    const a = p.strips[order[k]], b = p.strips[order[k + 1]], xb = spans[order[k]][1], y = base - 1.5;
    if (a.kind !== 'lane' || b.kind !== 'lane' || a.rail) continue;
    if ((a.dir ?? 1) !== (b.dir ?? 1)) parts.push(`<rect x="${r1(xb - 3.5)}" y="${y}" width="2.5" height="3" fill="${XS.yellow}"/><rect x="${r1(xb + 1)}" y="${y}" width="2.5" height="3" fill="${XS.yellow}"/>`);
    else parts.push(`<rect x="${r1(xb - 1.5)}" y="${y}" width="3" height="3" fill="${XS.white}"${a.solid || b.solid ? '' : ' opacity="0.6"'}/>`);
  }
  if (labels) {
    const y = base + depth + 9;
    for (const i of order) {
      const [x0, x1] = spans[i], text = `${fmtDec(p.strips[i].width)} m`;
      parts.push(`<line x1="${x0 + 1}" y1="${y}" x2="${x1 - 1}" y2="${y}" stroke="#ffffff38"/><line x1="${x0 + 0.5}" y1="${y - 4}" x2="${x0 + 0.5}" y2="${y + 4}" stroke="#ffffff50"/>`);
      if (x1 - x0 >= text.length * 7 + 4) parts.push(`<text x="${r1((x0 + x1) / 2)}" y="${y + 17}" text-anchor="middle" class="xs-label" fill="#d8dcd8" font-size="11">${text}</text>`);
    }
  }
  for (const i of o.flagged ?? []) {
    const span = spans[i];
    if (!span) continue;
    const cx = r1(Math.max(span[0] + 9, span[1] - 12)), cy = iconY + 22;
    parts.push(`<g class="xs-flag" pointer-events="none"><circle cx="${cx}" cy="${cy}" r="8" fill="#ff6f61" stroke="#1b0b09" stroke-width="1.5"/><rect x="${r1(cx - 1.2)}" y="${r1(cy - 5)}" width="2.4" height="6" rx="1" fill="#1b0b09"/><circle cx="${cx}" cy="${r1(cy + 4)}" r="1.3" fill="#1b0b09"/></g>`);
  }
  // grab handles on every boundary, by drawn position (the strip on the left of it)
  if (o.handles) for (let k = 0; k + 1 < order.length; k++) parts.push(`<rect data-edge="${k}" class="xs-edge" x="${r1(spans[order[k]][1] - 6)}" y="0" width="12" height="${base + depth}" fill="transparent"/>`);
  const sel = o.selected !== undefined && o.selected >= 0 ? spans[o.selected] : undefined;
  if (sel) parts.push(`<rect x="${sel[0] + 1.5}" y="3" width="${r1(Math.max(2, sel[1] - sel[0] - 3))}" height="${base + depth - 2}" rx="7" fill="#4fe0bf" fill-opacity="0.09" stroke="#4fe0bf" stroke-width="2.5" pointer-events="none"/>`);
  const title = o.title ? `<title>${o.title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</title>` : '';
  return { svg: `<svg class="xs" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img">${title}${parts.join('')}</svg>`, spans, ppm };
}

export class RoadCatalog {
  readonly el: HTMLElement;
  /** The section editor (made again when the language changes, `languageChanged`). */
  editor: SectionEditor;
  private tabs: HTMLElement;
  private grid: HTMLElement;
  private cat: Category = 'ruas';
  private current = 0;
  private built = '';
  private cards = new Map<number, HTMLElement>();
  private art = new Map<string, string>();
  /** Names of the models deleted in this session (their profiles stay registered for the roads that use them). */
  private deleted = new Set<string>();
  private a: CatalogActions;

  constructor(a: CatalogActions) {
    this.a = a;
    this.el = el('div', 'rc-catalog');
    this.tabs = el('div', 'rc-tabs');
    this.tabs.setAttribute('role', 'tablist');
    this.grid = el('div', 'rc-cards');
    this.grid.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { this.grid.scrollLeft += e.deltaY; e.preventDefault(); } e.stopPropagation(); }, { passive: false });
    this.el.append(this.tabs, this.grid);
    this.editor = new SectionEditor(this.editorHost());
    document.getElementById('hud')!.append(this.editor.el);
  }

  set visible(v: boolean) {
    if (v) this.build(); else { this.el.remove(); this.editor.close(); }
  }

  /** A road picked from outside (eyedropper, key). */
  select(id: number): void {
    this.current = id;
    const p = PROFILES[id];
    if (p?.category && p.category !== this.cat && !p.custom) { this.cat = p.category; this.built = ''; }
    if (this.el.isConnected) this.build();
  }

  /** What the section editor tells the catalogue: a template saved (it stays open), a profile to draw with. */
  private editorHost(): EditorHost {
    return {
      done: (def, save) => this.fromEditor(def, save),
      toast: (text) => this.a.toast(text),
      templates: () => readTemplates(),
      deleteTemplate: (name) => { writeTemplates(readTemplates().filter((x) => x.name !== name)); this.deleted.add(name); this.built = ''; if (this.el.isConnected) this.build(); },
    };
  }

  private fromEditor(def: Omit<Profile, 'id'>, save: boolean): void {
    // a model made (or saved) again under a deleted name is back in "Mine"
    this.deleted.delete(def.name);
    if (save) {
      // saved as a template (Roadcraft 4.0 ui/roads/profileEditor.ts:593-607): the card shows under "Mine", the editor stays
      const list = readTemplates().filter((x) => x.name !== def.name);
      list.push({ ...def, category: 'meus', custom: true });
      if (!writeTemplates(list)) { this.a.toast(t('profile.notStored')); return; }
      this.a.toast(t('ui.catalog.saved', { name: def.name }));
      this.cat = 'meus';
      this.built = '';
      if (this.el.isConnected) this.build();
      return;
    }
    const id = registerProfile({ ...def, category: 'meus', custom: true });
    if (id < 0) { this.a.toast(t('ui.catalog.tooMany')); return; }
    this.current = id;
    this.built = '';
    this.build();
    this.a.use(id);
  }

  /**
   * The language changed while the game runs: the cards and the section editor are made again in it. An edit in
   * progress stays open with its profile, selected strip and name.
   */
  languageChanged(): void {
    const old = this.editor, kept = old.state();
    this.editor = new SectionEditor(this.editorHost());
    old.el.replaceWith(this.editor.el);
    if (kept) this.editor.restore(kept);
    this.built = '';
    if (this.el.isConnected) this.build();
  }

  /** The section editor opened on profile `id` for a road (the inspector's "Edit profile"): what it gives back is
   *  registered as the player's own and its id goes to `apply`. */
  editFor(id: number, apply: (id: number) => void): void {
    const p = PROFILES[id];
    if (!p) return;
    this.editor.open(p, (def) => {
      const out = registerProfile({ ...def, category: 'meus', custom: true });
      if (out < 0) { this.a.toast(t('ui.catalog.tooMany')); return; }
      this.built = '';
      apply(out);
    });
  }

  /** Builds the tabs and cards when the category or the list changed; otherwise only moves the ring. */
  private build(): void {
    const items: Array<{ def: Omit<Profile, 'id'>; id: number; del?: () => void }> = [];
    if (this.cat === 'meus') {
      // a deleted model leaves "Mine" (Roadcraft 4.0 ui/roads/templates.ts:27); a road already drawn with it keeps its
      // profile, which is no longer offered as a card
      for (const tp of readTemplates()) items.push({ def: tp, id: -1, del: () => { writeTemplates(readTemplates().filter((x) => x.name !== tp.name)); this.deleted.add(tp.name); this.built = ''; this.build(); } });
      for (const p of PROFILES) if (p.custom && !this.deleted.has(p.name) && !items.some((i) => i.def.name === p.name)) items.push({ def: p, id: p.id });
    } else for (const p of PROFILES) if (!p.custom && !p.ring && p.category === this.cat) items.push({ def: p, id: p.id });
    // the language is part of what the cards were built for (Roadcraft 4.0 ui/roads/catalogPanel.ts:73)
    const key = `${lang()}|${this.cat}|${PROFILES.length}|${items.map((i) => i.def.name).join(',')}`;
    if (key !== this.built) {
      this.built = key;
      this.tabs.replaceChildren();
      const mine = readTemplates();
      for (const [c, k] of CATS) {
        const b = el('button', `rc-tab${c === this.cat ? ' on' : ''}`);
        b.type = 'button';
        b.setAttribute('role', 'tab');
        b.dataset.category = c;
        // "Mine" counts the cards it shows: the models, and the session's own profiles that are not one of them nor deleted
        const count = c === 'meus' ? mine.length + PROFILES.filter((p) => p.custom && !this.deleted.has(p.name) && !mine.some((x) => x.name === p.name)).length
          : PROFILES.filter((p) => !p.custom && !p.ring && p.category === c).length;
        b.append(el('span', '', t(k)), el('em', '', String(count)));
        b.addEventListener('click', (e) => { e.stopPropagation(); this.cat = c; this.build(); });
        this.tabs.append(b);
      }
      this.grid.replaceChildren();
      this.cards.clear();
      if (!items.length) this.grid.append(el('div', 'rc-empty', t(this.cat === 'meus' ? 'catalog.mineEmpty' : 'catalog.empty')));
      const span = Math.max(...PROFILES.filter((p) => !p.ring).map((p) => p.strips.reduce((s, x) => s + x.width, 0)));
      for (const it of items) {
        const cardEl = el('div', 'rc-card');
        const main = el('button', 'rc-card-main');
        main.type = 'button';
        const info = it.id >= 0 ? PROFILE_INFO[it.id] : null;
        const width = it.def.strips.reduce((s, x) => s + x.width, 0);
        const lanes = it.def.strips.filter((s) => s.kind === 'lane').length;
        const cost = info ? info.cost : Math.round(width * 60);
        main.title = t('catalog.tip', { name: profileName(it.def), lanes: plural('palette.lanes.count', lanes), way: t(it.def.oneWay ? 'catalog.oneWay' : 'catalog.twoWay'), speed: it.def.speed });
        const artKey = `${JSON.stringify(it.def.strips)}|${it.def.surface ?? 0}|${it.def.oneWay}|${span}`;
        let src = this.art.get(artKey);
        if (!src) { src = topSwatch(it.def, span); this.art.set(artKey, src); }
        const img = el('img', 'rc-art');
        img.src = src; img.alt = ''; img.draggable = false;
        main.append(img, el('span', 'rc-name', profileName(it.def)), el('span', 'rc-meta', t('catalog.meta', { width: fmtDec(width), price: money(cost) })));
        main.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = it.id >= 0 ? it.id : registerProfile({ ...it.def, category: 'meus', custom: true });
          if (id < 0) { this.a.toast(t('ui.catalog.tooMany')); return; }
          this.current = id;
          this.editor.close();
          if (it.id < 0) { this.built = ''; this.build(); } else this.mark();
          this.a.use(id);
        });
        cardEl.append(main);
        if (it.del) {
          const x = el('button', 'rc-custom');
          x.type = 'button';
          x.title = t('profileEditor.deleteTemplate');
          x.innerHTML = svg('close', 14);
          x.style.color = 'var(--v-danger-ink)';
          x.addEventListener('click', (e) => { e.stopPropagation(); it.del!(); });
          cardEl.append(x);
        }
        if (it.id >= 0) this.cards.set(it.id, cardEl);
        this.grid.append(cardEl);
      }
    }
    this.mark();
  }

  /** The picked card ringed, with the "Customise…" button on it. */
  private mark(): void {
    for (const [id, c] of this.cards) {
      const on = id === this.current;
      c.classList.toggle('on', on);
      const custom = c.querySelector('.rc-custom.edit');
      if (on && !custom) {
        const b = el('button', 'rc-custom edit');
        b.type = 'button';
        b.title = t('catalog.customise');
        b.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 11.5V13h1.5l6.9-6.9-1.5-1.5L3 11.5zm9.7-6.2a.8.8 0 000-1.1l-.9-.9a.8.8 0 00-1.1 0l-.8.8 1.5 1.5.8-.8z" fill="currentColor"/></svg>';
        const name = el('span', '', t('catalog.customise'));
        name.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)';
        b.append(name);
        b.addEventListener('click', (e) => { e.stopPropagation(); this.editor.open(PROFILES[id]); });
        c.append(b);
      } else if (!on) custom?.remove();
    }
  }
}

/** What the section editor reads of the catalogue and tells it. */
interface EditorHost {
  /** The profile drawn with (or saved as a template: the editor stays open, the card shows under "Mine"). */
  done(def: Omit<Profile, 'id'>, save: boolean): void;
  toast(text: string): void;
  /** The player's templates, and one deleted. */
  templates(): Array<Omit<Profile, 'id'>>;
  deleteTemplate(name: string): void;
}

/** Roadcraft 4.0's road classes (world/roadTypes.ts) as this engine's right of way, with their names. */
const CLASSES: Array<[number, string]> = [[0, 'road.local'], [1, 'road.urban'], [2, 'road.avenue'], [3, 'road.boulevard'], [5, 'road.highway'], [4, 'road.ramp']];
/** The class a priority reads as (the highest class not above it). */
const classOf = (priority: number): number => (priority >= 5 ? 5 : priority === 4 ? 4 : Math.max(0, Math.min(3, priority)));
const PALETTE: Array<[PaletteKind, string]> = [['footway', 'profileEditor.palette.footway'], ['laneBackward', 'profileEditor.palette.laneBackward'], ['laneForward', 'profileEditor.palette.laneForward'],
  ['median', 'profileEditor.palette.median'], ['parking', 'profileEditor.palette.parking'], ['cycle', 'profileEditor.palette.cycle'], ['shoulder', 'ui.strip.shoulder'], ['barrier', 'ui.strip.barrier']];
/** 4.0 ROAD_SECTION_LIMITS.speedKmh. */
const SPEED: [number, number] = [20, 120];

/**
 * The cross-section editor (Roadcraft 4.0 ui/roads/profileEditor.ts:184-668): the road drawn as a street section whose
 * boundaries are dragged (whole metres; a lane carries every lane) and whose strips are dragged to another place;
 * template cards (the catalogue's roads, the player's own, a blank road); a palette that puts each strip where the
 * road can carry it; the picked strip's width, direction, use, line, arrows, paving and level; the road's class,
 * carriageway, speed and centre line; its problems, each pointing at its strips; save (in two steps), draw with
 * it, or apply it to the road it was opened from. ← → pick, Delete removes, Esc closes. Opened from the catalogue it
 * is docked above the drawer and folds to its head.
 */
class SectionEditor {
  readonly el: HTMLElement;
  private base: Omit<Profile, 'id'> | null = null;
  private work: Strip[] = [];
  private sel = -1;
  private apply: ((def: Omit<Profile, 'id'>) => void) | null = null;
  private saving = false;
  private status = '';
  private drag: { kind: 'edge'; pointer: number; startX: number; start: Strip[]; target: number; anchor: 'left' | 'right'; ppm: number; startW: number; count: number; limits: readonly [number, number] }
    | { kind: 'move'; pointer: number; startX: number; start: Strip[]; from: number; centres: number[]; moving: boolean; to: number } | null = null;
  private readonly host: EditorHost;
  private readonly sub: HTMLElement;
  private readonly chip: HTMLElement;
  private readonly foot: HTMLElement;
  private readonly cards: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly picture: HTMLElement;
  private readonly props: HTMLElement;
  private readonly nameField: HTMLInputElement;
  private readonly fold: HTMLButtonElement;

  constructor(host: EditorHost) {
    this.host = host;
    this.el = el('section', 'rp-panel section-editor hidden');
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', t('profileEditor.title'));
    const head = el('div', 'rp-head');
    const titles = el('div');
    this.sub = el('div', 'rp-sub');
    titles.append(el('div', 'rp-title', t('profileEditor.title')), this.sub);
    this.chip = el('div', 'rp-chip');
    this.foot = el('div', 'rp-foot');
    this.fold = iconBtn('fold', t('profileEditor.fold'), () => { this.el.classList.toggle('folded'); this.fold.setAttribute('aria-expanded', String(!this.el.classList.contains('folded'))); this.place(); });
    addEventListener('resize', () => { if (this.isOpen) this.place(); });
    this.fold.dataset.action = 'fold';
    const close = iconBtn('close', t('profileEditor.close'), () => this.close());
    head.append(titles, this.chip, this.foot, this.fold, close);
    this.cards = el('div', 'rp-cards');
    this.cards.setAttribute('aria-label', t('profileEditor.templates'));
    this.stage = el('div', 'rp-stage');
    this.stage.setAttribute('aria-label', t('profileEditor.bands'));
    this.picture = el('div', 'rp-picture');
    this.stage.append(this.picture, el('div', 'rp-end rp-end-l', t('profileEditor.leftEnd')), el('div', 'rp-end rp-end-r', t('profileEditor.rightEnd')));
    const palette = el('div', 'rp-palette');
    palette.append(el('div', 'rp-label', t('profileEditor.add')));
    for (const [kind, key] of PALETTE) {
      const b = el('button', 'rp-tool');
      b.type = 'button';
      b.dataset.palette = kind;
      b.innerHTML = PALETTE_ICON[kind];
      b.append(el('span', '', t(key)));
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const at = insertionIndex(this.work, kind, this.sel);
        this.work.splice(at, 0, newStrip(kind, this.work));
        this.sel = at; this.status = '';
        this.render();
      });
      palette.append(b);
    }
    this.props = el('div', 'rp-props');
    this.nameField = el('input', 'rp-field');
    this.nameField.type = 'text'; this.nameField.maxLength = 40;
    this.nameField.placeholder = t('profile.templateName');
    this.nameField.setAttribute('aria-label', t('profile.templateName'));
    this.nameField.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') this.save();
      if (e.key === 'Escape') { this.saving = false; this.renderFoot(); }
    });
    this.el.append(head, this.cards, this.stage, palette, this.props);
    // keys typed here are the editor's, not the game's (4.0 :268-275)
    this.el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'Escape') this.close();
      else if (e.key === 'ArrowLeft' && this.sel > 0) { this.sel--; this.render(); }
      else if (e.key === 'ArrowRight' && this.sel < this.work.length - 1) { this.sel++; this.render(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && this.work[this.sel]) this.remove();
    });
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    this.stage.addEventListener('pointerdown', (e) => this.dragStart(e));
    this.stage.addEventListener('pointermove', (e) => this.dragMove(e));
    this.stage.addEventListener('pointerup', (e) => this.dragEnd(e));
    this.stage.addEventListener('pointercancel', (e) => this.dragEnd(e));
  }

  get isOpen(): boolean { return !this.el.classList.contains('hidden'); }

  /** Opens the editor on a profile; `apply` (the inspector's "Edit profile", Roadcraft 4.0 ui/roads/profilePanel.ts:50-56)
   *  takes the result instead of the catalogue (the road it was opened from gets it). Without it the editor is docked
   *  above the drawer (4.0 :27-28, :653-660). */
  open(p: Profile | Omit<Profile, 'id'>, apply?: (def: Omit<Profile, 'id'>) => void): void {
    this.apply = apply ?? null;
    this.base = { ...JSON.parse(JSON.stringify({ ...p, id: undefined })) as Omit<Profile, 'id'>, ring: false };
    this.work = toWork(this.base);
    this.nameField.value = p.custom ? p.name : t('ui.editor.mine', { name: profileName(p) });
    this.sel = Math.min(1, this.work.length - 1);
    this.saving = false; this.status = '';
    this.sub.textContent = t('profileEditor.sub', { target: t(apply ? 'profileEditor.thisRoad' : 'profileEditor.newRoads') });
    this.el.classList.toggle('docked', !apply);
    this.el.classList.remove('folded', 'hidden');
    this.fold.hidden = !!apply;
    this.render();
    this.place();
  }

  /** Docked: between the top bar and the drawer, whatever the drawer's height (4.0 profileEditor.ts:653-660). */
  place(): void {
    if (!this.el.classList.contains('docked')) { this.el.style.bottom = ''; return; }
    const drawer = document.querySelector<HTMLElement>('.v2-drawer:not([hidden])');
    const top = drawer ? drawer.getBoundingClientRect().top : innerHeight;
    this.el.style.bottom = `${Math.max(12, Math.round(innerHeight - top + 10))}px`;
  }

  close(): void { this.el.classList.add('hidden'); this.base = null; this.drag = null; }

  /** What an open edit holds (null when closed), to carry it into an editor built again. */
  state(): { def: Omit<Profile, 'id'>; sel: number; name: string } | null {
    return this.isOpen && this.base ? { def: this.profile(), sel: this.sel, name: this.nameField.value } : null;
  }

  restore(st: { def: Omit<Profile, 'id'>; sel: number; name: string }): void {
    this.base = st.def; this.work = toWork(st.def); this.sel = st.sel; this.nameField.value = st.name;
    this.sub.textContent = t('profileEditor.sub', { target: t('profileEditor.newRoads') });
    this.el.classList.remove('hidden');
    this.render();
  }

  /** The profile as edited (kerbs put back, normalised). */
  private profile(): Omit<Profile, 'id'> { return fromWork(this.base!, this.work); }

  /** The problems, with the strips each is about in the editor's own order. */
  private issues(): Array<{ text: string; strips: number[] }> {
    const p = this.profile(), n = p.strips.length;
    // profile index → editor index (the profile runs right to left and has kerbs the editor does not)
    const map: number[] = [];
    let k = this.work.length - 1;
    for (let i = 0; i < n; i++) map[i] = p.strips[i].kind === 'curb' ? -1 : k--;
    return profileIssueSpots(p).map((x) => ({ text: problemText(x.problem), strips: x.strips.map((i) => map[i]).filter((i) => i >= 0) }));
  }

  private render(): void {
    if (!this.base) return;
    this.renderCards();
    this.drawStage();
    this.renderProps();
    this.renderFoot();
  }

  /** The editor's strips as a profile for the picture (right to left, no kerbs: the picture draws the kerb edges). */
  private shown(): Omit<Profile, 'id'> { return { ...this.base!, strips: this.work.slice().reverse() }; }
  private toShown(i: number): number { return this.work.length - 1 - i; }

  private stageSize(): { width: number; height: number } {
    return { width: Math.max(320, Math.round(this.picture.clientWidth || this.stage.clientWidth || 900)), height: this.el.classList.contains('docked') ? 128 : innerHeight < 820 ? 160 : 200 };
  }

  private drawStage(extra: { ppm?: number; anchor?: 'left' | 'right'; dragging?: number } = {}): void {
    if (!this.work.length) {
      this.picture.innerHTML = '';
      this.picture.append(el('div', 'rp-empty', t('profileEditor.empty')));
    } else {
      const flagged = new Set(this.issues().flatMap((x) => x.strips.map((i) => this.toShown(i))));
      const { width, height } = this.stageSize();
      this.picture.innerHTML = sectionSvg(this.shown(), {
        width, height, handles: true, flagged, title: t('profile.diagram'),
        ...(this.sel >= 0 ? { selected: this.toShown(this.sel) } : {}),
        ...(extra.ppm !== undefined ? { ppm: extra.ppm, anchor: extra.anchor } : {}),
        ...(extra.dragging !== undefined ? { dragging: this.toShown(extra.dragging) } : {}),
      }).svg;
    }
    // the width the road is built at, kerbs included
    this.chip.textContent = t('profileEditor.totalWidth', { width: fmtDec(this.base ? this.profile().strips.reduce((s, x) => s + x.width, 0) : 0) });
  }

  private svgX(clientX: number): number {
    const svgEl = this.picture.querySelector('svg');
    if (!svgEl) return 0;
    const r = svgEl.getBoundingClientRect();
    return (clientX - r.left) * this.stageSize().width / Math.max(1, r.width);
  }

  /** A boundary dragged changes a width (whole metres), a strip dragged goes to another place (4.0 :312-387). */
  private dragStart(e: PointerEvent): void {
    if (e.button !== 0 || !this.work.length) return;
    const target = e.target as Element;
    const fit = sectionSvg(this.shown(), { width: this.stageSize().width, height: 10, labels: false });
    const edge = target.closest('[data-edge]');
    if (edge) {
      const i = Number(edge.getAttribute('data-edge'));
      const left = this.work[i], right = this.work[i + 1];
      if (!left || !right) return;
      // the left strip follows the boundary; when its width is fixed, the right one does
      const pick = STEP_LIMITS[left.kind] ? i : STEP_LIMITS[right.kind] ? i + 1 : -1;
      if (pick < 0) return;
      const anchor = pick === i ? 'left' : 'right';
      const s = this.work[pick];
      const count = s.kind === 'lane' ? this.work.filter((x, k) => x.kind === 'lane' && (anchor === 'left' ? k <= i : k >= i + 1)).length : 1;
      this.drag = { kind: 'edge', pointer: e.pointerId, startX: this.svgX(e.clientX), start: this.work.slice(), target: pick, anchor, ppm: fit.ppm, startW: s.width, count, limits: STEP_LIMITS[s.kind]! };
      this.sel = pick;
    } else {
      const g = target.closest('[data-index]');
      if (!g) return;
      const from = this.toShown(Number(g.getAttribute('data-index')));
      const centres = this.work.map((_, k) => { const [a, b] = fit.spans[this.toShown(k)]; return (a + b) / 2; });
      this.drag = { kind: 'move', pointer: e.pointerId, startX: this.svgX(e.clientX), start: this.work.slice(), from, centres, moving: false, to: from };
      this.sel = from;
    }
    try { this.stage.setPointerCapture(e.pointerId); } catch { /* the drag still follows moves over the picture */ }
    this.stage.classList.add('dragging');
    this.drawStage(this.drag.kind === 'edge' ? { ppm: this.drag.ppm, anchor: this.drag.anchor } : {});
    e.preventDefault();
  }

  private dragMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointer) return;
    const dx = this.svgX(e.clientX) - d.startX;
    if (d.kind === 'edge') {
      const delta = dx / d.ppm / d.count * (d.anchor === 'left' ? 1 : -1);
      const metres = Math.max(d.limits[0], Math.min(d.limits[1], Math.round(d.startW + delta)));
      if (this.work[d.target].width === metres) return;
      this.work = withStripWidth(d.start, d.target, metres);
      this.drawStage({ ppm: d.ppm, anchor: d.anchor });
    } else {
      if (!d.moving && Math.abs(dx) < 4) return;
      d.moving = true;
      const x = this.svgX(e.clientX);
      const to = d.centres.filter((c, k) => k !== d.from && c < x).length;
      if (to === d.to && this.work !== d.start) return;
      d.to = to;
      this.work = movedStrip(d.start, d.from, to);
      this.sel = to;
      this.drawStage({ dragging: to });
    }
  }

  private dragEnd(e: PointerEvent): void {
    if (!this.drag || e.pointerId !== this.drag.pointer) return;
    this.drag = null;
    this.stage.classList.remove('dragging');
    if (this.stage.hasPointerCapture(e.pointerId)) this.stage.releasePointerCapture(e.pointerId);
    this.status = '';
    this.render();
  }

  /** The template cards: the catalogue's roads, the player's own (deletable), a blank road (4.0 :389-430). */
  private renderCards(): void {
    this.cards.replaceChildren();
    const now = profileKey(this.profile());
    const card = (name: string, on: boolean, art: string, pick: () => void, remove?: () => void): void => {
      const box = el('div', `rp-card${on ? ' on' : ''}`);
      const main = el('button', 'rp-card-main');
      main.type = 'button';
      main.setAttribute('aria-pressed', String(on));
      main.title = name;
      const a = el('span', 'rp-card-art'); a.innerHTML = art;
      main.append(a, el('span', 'rp-card-name', name));
      main.addEventListener('click', (ev) => { ev.stopPropagation(); pick(); });
      box.append(main);
      if (remove) { const x = iconBtn('close', `${t('profileEditor.deleteTemplate')}: ${name}`, remove); x.className = 'rp-card-x'; box.append(x); }
      this.cards.append(box);
    };
    const use = (p: Omit<Profile, 'id'>): void => { this.base = { ...p, ring: false }; this.work = toWork(p); this.sel = Math.min(1, this.work.length - 1); this.status = ''; this.render(); };
    for (const p of PROFILES) {
      if (p.custom || p.ring || p.category === 'trilhos') continue;
      card(profileName(p), profileKey(p) === now, sectionSvg(p, { width: 92, height: 34, labels: false }).svg, () => use(p));
    }
    for (const p of this.host.templates()) {
      card(p.name, profileKey(p) === now, sectionSvg(p, { width: 92, height: 34, labels: false }).svg, () => use(p), () => { this.host.deleteTemplate(p.name); this.renderCards(); });
    }
    card(t('profileEditor.blank'), this.work.length === 0, svg('plus', 18), () => { this.work = []; this.sel = -1; this.status = ''; this.render(); });
  }

  private replace(s: Strip): void { this.work[this.sel] = s; this.status = ''; this.render(); }

  private remove(): void {
    this.work.splice(this.sel, 1);
    this.sel = Math.min(this.sel, this.work.length - 1);
    this.status = '';
    this.render();
  }

  private moveSel(by: -1 | 1): void {
    const to = this.sel + by;
    if (to < 0 || to >= this.work.length) return;
    this.work = movedStrip(this.work, this.sel, to);
    this.sel = to;
    this.render();
  }

  /** The picked strip, then the road as a whole and its problems (4.0 :464-590). */
  private renderProps(): void {
    this.props.replaceChildren();
    const found = this.issues();
    const s = this.work[this.sel];
    const block = el('div', 'rp-block rp-element');
    if (!s) block.append(el('div', 'rp-sub', t('profileEditor.pick')));
    else {
      const top = el('div', 'rp-block-head');
      const sw = el('span', 'rp-swatch'); sw.style.background = KIND_COLOR[s.kind];
      const name = s.kind === 'lane' ? `${t('profile.element.lane')} · ${t((s.dir ?? 1) === 1 ? 'profileEditor.dirForward' : 'profileEditor.dirBackward')}` : t(KIND_KEY[s.kind]);
      const acts = el('div', 'rp-actions');
      const l = iconBtn('left', t('profileEditor.moveLeft'), () => this.moveSel(-1)); l.disabled = this.sel === 0;
      const r = iconBtn('right', t('profileEditor.moveRight'), () => this.moveSel(1)); r.disabled = this.sel === this.work.length - 1;
      const x = iconBtn('trash', t('profileEditor.remove'), () => this.remove());
      acts.append(l, r, x);
      top.append(sw, el('span', '', name), acts);
      block.append(top);
      const lim = STEP_LIMITS[s.kind];
      if (lim) {
        const whole = Math.abs(s.width - Math.round(s.width)) < 1e-6;
        const down = whole ? Math.round(s.width) - 1 : Math.floor(s.width), up = whole ? Math.round(s.width) + 1 : Math.ceil(s.width);
        block.append(edRow(t('profileEditor.width'), edStepper(`${fmtDec(s.width)} m`,
          down >= lim[0] ? () => { this.work = withStripWidth(this.work, this.sel, down); this.render(); } : null,
          up <= lim[1] ? () => { this.work = withStripWidth(this.work, this.sel, up); this.render(); } : null),
          el('div', 'rp-note', s.kind === 'lane' ? t('profileEditor.allLanes') : '')));
      } else block.append(edRow(t('profileEditor.width'), el('div', 'rp-sub', `${fmtDec(s.width)} m · ${t('profileEditor.fixedWidth')}`)));
      if (s.kind === 'lane') {
        block.append(edRow(t('profileEditor.direction'), edSeg([[-1, t('profileEditor.dirBackward')], [1, t('profileEditor.dirForward')]], s.dir ?? 1, (v) => this.replace({ ...s, dir: v as 1 | -1 }))));
        block.append(edRow(t('profileEditor.use'), edSeg([[0, t('profileEditor.useAll')], [1, t('profileEditor.useBus')]], s.bus ? 1 : 0, (v) => this.replace({ ...s, bus: v === 1 }))));
        // the line to the next lane of its direction (4.0 :518-535); a bus lane's is always solid
        const next = this.work[this.sel + 1];
        if (next?.kind === 'lane' && (next.dir ?? 1) === (s.dir ?? 1)) {
          const busLine = !!s.bus !== !!next.bus;
          const line = edRow(t('profileEditor.lineRight'), edSeg([[0, t('profileEditor.lineDashed')], [1, t('profileEditor.lineSolid')]], busLine || s.solid ? 1 : 0, (v) => { if (!busLine) this.replace({ ...s, solid: v === 1 }); }));
          if (busLine) { line.querySelectorAll('button').forEach((b) => { b.disabled = true; }); line.append(el('div', 'rp-note', t('profileEditor.lineBus'))); }
          block.append(line);
        }
        // this engine's lane arrows (the lanes' turns at the junctions)
        block.append(edRow(t('road.section.turns'), edSeg(TURNS.map(([v, k]) => [v, t(k)]), s.turns ?? 0, (v) => this.replace({ ...s, turns: v }))));
      }
      if (s.kind === 'sidewalk') {
        block.append(edRow(t('profileEditor.paving'), edSeg([[Paving.Pavers, t('profile.materialName.pavers')], [Paving.Concrete, t('profile.materialName.concrete')], [Paving.Stone, t('profile.materialName.stone')]], s.pave ?? Paving.Concrete, (v) => this.replace({ ...s, pave: v }))));
        block.append(edRow('', edToggle(t('profileEditor.flush'), !!s.flush, (on) => this.replace({ ...s, flush: on || undefined }))));
      }
      if (s.kind === 'median') {
        block.append(edRow(t('profileEditor.paving'), edSeg([[Paving.Grass, t('profile.materialName.grass')], [Paving.Concrete, t('profile.materialName.concrete')], [Paving.Pavers, t('profile.materialName.pavers')]], s.pave ?? Paving.Grass, (v) => this.replace({ ...s, pave: v }))));
        block.append(edRow('', edToggle(t('profileEditor.medianFlush'), !!s.flush, (on) => this.replace({ ...s, flush: on || undefined }))));
      }
      for (const x of found.filter((q) => q.strips.includes(this.sel))) block.append(this.issueLine(x, false));
    }

    const road = el('div', 'rp-block rp-road');
    road.append(el('div', 'rp-block-head', t('profileEditor.road')));
    const b = this.base!;
    road.append(edRow(t('profileEditor.class'), edSeg(CLASSES.map(([v, k]) => [v, t(k)]), classOf(b.priority ?? 0), (v) => { b.priority = v; this.status = ''; this.render(); }, true)));
    road.append(edRow(t('profile.material.carriageway'), edSeg([[Surface.Asphalt, t('profile.materialName.asphalt')], [Surface.Concrete, t('profile.materialName.concrete')], [Surface.Cobble, t('profile.materialName.cobble')]], b.surface ?? Surface.Asphalt, (v) => { b.surface = v; this.render(); })));
    road.append(edRow(t('profileEditor.speed'), edStepper(t('profileEditor.speedValue', { speed: b.speed }),
      b.speed - 10 >= SPEED[0] ? () => { b.speed -= 10; this.render(); } : null, b.speed + 10 <= SPEED[1] ? () => { b.speed += 10; this.render(); } : null, t('profileEditor.slower'), t('profileEditor.faster'))));
    // the line between the two directions, where they meet with no median (4.0 :569-578)
    const dirs = new Set(this.work.filter((x) => x.kind === 'lane').map((x) => x.dir ?? 1));
    if (dirs.size === 2 && !this.work.some((x) => x.kind === 'median')) {
      const kinds: Array<Centre | 'auto'> = ['auto', 'dashed', 'solid', 'double'];
      road.append(edRow(t('profileEditor.centreLine'), edSeg(kinds.map((k, i) => [i, t(`profileEditor.centreLineName.${k}`)]), b.centre ? kinds.indexOf(b.centre) : 0,
        (v) => { if (v === 0) delete b.centre; else b.centre = kinds[v] as Centre; this.render(); })));
    }
    const elsewhere = this.work.length ? found.filter((x) => !x.strips.includes(this.sel)) : [];
    for (const x of elsewhere) road.append(this.issueLine(x, x.strips.length > 0));
    if (!found.length) {
      const ok = el('div', 'rp-ok');
      ok.setAttribute('role', 'status');
      ok.innerHTML = PALETTE_ICON.ok;
      ok.append(el('span', '', t('profileEditor.ok')));
      road.append(ok);
    }
    this.props.append(block, road);
  }

  private issueLine(x: { text: string; strips: number[] }, link: boolean): HTMLElement {
    const line = el(link ? 'button' : 'div', 'rp-issue');
    line.setAttribute('role', link ? 'button' : 'alert');
    line.innerHTML = PALETTE_ICON.warn;
    line.append(el('span', '', x.text + (link ? ` ${t('profileEditor.seeIssue')}` : '')));
    if (link && line instanceof HTMLButtonElement) { line.type = 'button'; line.addEventListener('click', (e) => { e.stopPropagation(); this.sel = x.strips[0]; this.render(); }); }
    return line;
  }

  /** Save as a template in two steps (a name, then OK), draw new roads with it, or apply it (4.0 :592-644). */
  private renderFoot(): void {
    this.foot.replaceChildren();
    const blocked = this.issues().length > 0;
    if (this.saving) this.foot.append(this.nameField, edButton(t('profileEditor.save'), () => this.save()), edButton(t('profileEditor.cancel'), () => { this.saving = false; this.renderFoot(); }));
    else {
      const start = edButton(t('profileEditor.saveShort'), () => { this.saving = true; this.status = ''; this.renderFoot(); this.nameField.focus(); });
      start.disabled = blocked;
      start.dataset.action = 'save';
      this.foot.append(start);
    }
    if (this.status) { const n = el('div', 'rp-sub', this.status); n.setAttribute('role', 'status'); this.foot.append(n); }
    const draw = edButton(t('profileEditor.drawWith'), () => this.finish(false), this.apply ? '' : 'primary');
    draw.disabled = blocked;
    draw.dataset.action = 'draw';
    this.foot.append(draw);
    if (this.apply) {
      const ap = edButton(t('profileEditor.apply'), () => this.finish(true), 'primary');
      ap.disabled = blocked;
      ap.dataset.action = 'apply';
      this.foot.append(ap);
    }
  }

  private save(): void {
    const name = this.nameField.value.trim();
    if (!name || this.issues().length) { this.status = t('profile.notSaved'); this.renderFoot(); return; }
    this.host.done(normalize({ ...this.profile(), name }), true);
    this.saving = false;
    this.renderCards();
    this.renderFoot();
  }

  /** Draw new roads with it (`toRoad` false), or apply it to the road it was opened from. */
  private finish(toRoad: boolean): void {
    if (this.issues().length) return;
    const name = this.nameField.value.trim() || t('profileEditor.custom');
    const out = normalize({ ...this.profile(), name });
    const apply = this.apply;
    this.close();
    if (toRoad && apply) apply(out); else this.host.done(out, false);
  }
}

/** The editor's icons (4.0 ui/roads/profileEditor.ts:45-66). */
const ICONS: Record<string, string> = {
  close: '<path d="M6 6l12 12M18 6L6 18"/>', left: '<path d="M14 6l-6 6 6 6"/>', right: '<path d="M10 6l6 6-6 6"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>', warn: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
  ok: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>', fold: '<path d="M6 15l6-6 6 6"/>',
  footway: '<circle cx="12" cy="4.5" r="1.8"/><path d="M12 7.5v6l-3 7M12 13.5l3 7M8.5 10.5l3.5-3 3.5 3"/>',
  laneForward: '<path d="M3 19h18" opacity=".5"/><path d="M4 11h14M14 6l5 5-5 5"/>',
  laneBackward: '<path d="M3 19h18" opacity=".5"/><path d="M20 11H6M10 6l-5 5 5 5"/>',
  median: '<circle cx="12" cy="8" r="5"/><path d="M12 13v6M5 20h14"/>',
  parking: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M10 16V8h3a2.5 2.5 0 010 5h-3"/>',
  cycle: '<circle cx="6" cy="16" r="3.5"/><circle cx="18" cy="16" r="3.5"/><path d="M6 16l4-7h5l3 7M10 9l3 7h-3M13 6h3"/>',
  shoulder: '<path d="M4 20L9 4M15 4l5 16" /><path d="M12 6v3M12 13v3" opacity=".6"/>',
  barrier: '<path d="M3 9h18M3 15h18M6 9v8M18 9v8"/>',
};
const ic = (name: string): string => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ''}</svg>`;
const PALETTE_ICON: Record<string, string> = Object.fromEntries(Object.keys(ICONS).map((k) => [k, ic(k)]));

function iconBtn(name: string, label: string, fn: () => void): HTMLButtonElement {
  const b = el('button', 'rp-icon');
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.innerHTML = PALETTE_ICON[name] ?? '';
  b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
  return b;
}
function edButton(label: string, fn: () => void, kind = ''): HTMLButtonElement {
  const b = el('button', `rp-btn${kind ? ` ${kind}` : ''}`, label);
  b.type = 'button';
  b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
  return b;
}
function edRow(label: string, ...controls: HTMLElement[]): HTMLElement {
  const r = el('div', 'rp-row');
  const c = el('div', 'rp-ctrls');
  c.append(...controls);
  r.append(el('div', 'rp-label', label), c);
  return r;
}
function edSeg(opts: Array<[number, string]>, value: number, fn: (v: number) => void, dense = false): HTMLElement {
  const box = el('div', dense ? 'rp-seg dense' : 'rp-seg');
  box.setAttribute('role', 'radiogroup');
  for (const [v, text] of opts) {
    const b = el('button', v === value ? 'on' : '', text);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(v === value));
    b.addEventListener('click', (e) => { e.stopPropagation(); if (v !== value) fn(v); });
    box.append(b);
  }
  return box;
}
function edStepper(text: string, less: (() => void) | null, more: (() => void) | null, lessLabel = t('profileEditor.narrower'), moreLabel = t('profileEditor.wider')): HTMLElement {
  const box = el('div', 'rp-step');
  const minus = el('button', '', '−'), plus = el('button', '', '+');
  minus.type = 'button'; plus.type = 'button';
  minus.setAttribute('aria-label', lessLabel); plus.setAttribute('aria-label', moreLabel);
  minus.disabled = !less; plus.disabled = !more;
  if (less) minus.addEventListener('click', (e) => { e.stopPropagation(); less(); });
  if (more) plus.addEventListener('click', (e) => { e.stopPropagation(); more(); });
  box.append(minus, el('output', '', text), plus);
  return box;
}
function edToggle(label: string, on: boolean, fn: (on: boolean) => void): HTMLElement {
  const b = el('button', 'rp-switch');
  b.type = 'button';
  b.setAttribute('role', 'switch');
  b.setAttribute('aria-checked', String(on));
  const track = el('span', 'track'); track.append(el('span', 'knob'));
  b.append(track, el('span', 'txt', label));
  b.addEventListener('click', (e) => { e.stopPropagation(); fn(!on); });
  return b;
}

/** A problem in the player's words (the checks are `roads/profiles.ts` profileIssueSpots). */
function problemText(p: ProfileIssue): string {
  const key: Record<ProfileIssue, string> = {
    noLanes: 'profile.problem.noLanes', maxLanes: 'ui.problem.maxLanes', busOnly: 'profile.problem.busOnly', order: 'ui.problem.order',
    footways: 'ui.problem.footways', wide: 'ui.problem.wide', laneBalance: 'profile.problem.laneBalance', parkingSide: 'profile.problem.parkingSide',
    width: 'profile.problem.width', median: 'profile.problem.median', class: 'profile.problem.class',
  };
  return t(key[p]);
}


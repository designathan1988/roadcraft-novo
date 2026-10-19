// The section editor's working model (Roadcraft 4.0 ui/roads/profileEditor.ts:68-146): a road's strips as drawn, from
// its left edge to its right one seen from A towards B, without the kerbs. 4.0 has no kerb element (the kerb stands
// wherever a raised strip meets the carriageway); this engine draws its kerb as a strip of its own, so the editor
// takes them out and puts them back there. Pure: no page, testable in Node.

import { normalize, type Profile, type Strip, type StripKind } from './profiles.ts';

/** The kerb this engine puts between a raised strip and the carriageway (the built-in roads' 20 cm). */
const KERB_WIDTH = 0.2;

const raised = (s: Strip): boolean => !s.flush && (s.kind === 'sidewalk' || s.kind === 'median');
const carriage = (s: Strip): boolean => s.kind === 'lane' || s.kind === 'parking' || s.kind === 'bike' || s.kind === 'shoulder' || (s.flush === true && s.kind !== 'barrier');

/** The strips as the editor shows them: left to right, no kerbs. */
export function toWork(p: Omit<Profile, 'id'>): Strip[] {
  return p.strips.filter((s) => s.kind !== 'curb').reverse().map((s) => ({ ...s }));
}

/** The profile back from the editor's strips: right to left again, a kerb wherever a raised strip meets the carriageway. */
export function fromWork(base: Omit<Profile, 'id'>, work: readonly Strip[]): Omit<Profile, 'id'> {
  const out: Strip[] = [];
  work.forEach((s, i) => {
    out.push({ ...s });
    const next = work[i + 1];
    if (next && ((raised(s) && carriage(next)) || (carriage(s) && raised(next)))) out.push({ kind: 'curb', width: KERB_WIDTH });
  });
  return normalize({ ...base, strips: out.reverse() });
}

/** What the palette adds (4.0 profileEditor.ts:33-34), and this engine's highway strips. */
export type PaletteKind = 'footway' | 'laneBackward' | 'laneForward' | 'median' | 'parking' | 'cycle' | 'shoulder' | 'barrier';

/** A new strip of each kind as the palette adds it; a lane as wide as the road's others (4.0 :68-79). */
export function newStrip(kind: PaletteKind, work: readonly Strip[]): Strip {
  const lane = work.find((s) => s.kind === 'lane')?.width ?? 3;
  switch (kind) {
    case 'footway': return { kind: 'sidewalk', width: 2 };
    case 'laneForward': return { kind: 'lane', width: lane, dir: 1 };
    case 'laneBackward': return { kind: 'lane', width: lane, dir: -1 };
    case 'median': return { kind: 'median', width: 2 };
    case 'parking': return { kind: 'parking', width: 2.3 };
    case 'cycle': return { kind: 'bike', width: 1.6 };
    case 'shoulder': return { kind: 'shoulder', width: 2.5 };
    case 'barrier': return { kind: 'barrier', width: 0.6 };
  }
}

/** Where the palette puts a new strip: where the road can carry it (4.0 profileEditor.ts:82-126), in drawn order. */
export function insertionIndex(work: readonly Strip[], kind: PaletteKind, selected: number): number {
  const e = work, n = e.length;
  const hasLeft = e[0]?.kind === 'sidewalk', hasRight = n > 1 && e[n - 1]?.kind === 'sidewalk';
  const lo = hasLeft ? 1 : 0, hi = hasRight ? n - 1 : n;
  const clamp = (i: number): number => Math.max(lo, Math.min(hi, i));
  const lastIndex = (test: (x: Strip) => boolean): number => { for (let i = n - 1; i >= 0; i--) if (test(e[i])) return i; return -1; };
  const kerbBand = (x: Strip | undefined): boolean => x?.kind === 'parking' || x?.kind === 'bike';
  const lastBack = lastIndex((x) => x.kind === 'lane' && x.dir === -1);
  const lastFwd = lastIndex((x) => x.kind === 'lane' && (x.dir ?? 1) === 1);
  switch (kind) {
    case 'footway': return !hasLeft ? 0 : !hasRight ? n : clamp(selected + 1);
    case 'laneBackward': {
      if (lastBack >= 0) return lastBack + 1;
      const core = e.findIndex((x) => x.kind === 'median' || (x.kind === 'lane' && (x.dir ?? 1) === 1));
      if (core >= 0) return core;
      return clamp(kerbBand(e[lo]) ? lo + 1 : lo);
    }
    case 'laneForward': {
      if (lastFwd >= 0) return lastFwd + 1;
      const median = lastIndex((x) => x.kind === 'median');
      if (median >= 0) return median + 1;
      if (lastBack >= 0) return lastBack + 1;
      return clamp(kerbBand(e[hi - 1]) ? hi - 1 : hi);
    }
    case 'median': return lastBack >= 0 ? lastBack + 1 : clamp(selected + 1);
    case 'parking': case 'cycle': case 'shoulder': case 'barrier': {
      // by the kerb nearest the picked strip; the other kerb when that one has its band already
      const leftFree = !kerbBand(e[lo]), rightFree = !kerbBand(e[hi - 1]);
      const nearLeft = selected >= 0 && selected < n / 2;
      if (nearLeft) return leftFree || !rightFree ? lo : hi;
      return rightFree || !leftFree ? hi : lo;
    }
  }
}

/** The strip at `index` made `metres` wide; a lane carries every lane with it (4.0 :128-137). */
export function withStripWidth(work: readonly Strip[], index: number, metres: number): Strip[] {
  const target = work[index];
  if (!target) return work.slice();
  return work.map((s, i) => (i === index || (target.kind === 'lane' && s.kind === 'lane') ? { ...s, width: metres } : s));
}

/** The strips with the one at `from` moved to `to` (4.0 :139-146). */
export function movedStrip(work: readonly Strip[], from: number, to: number): Strip[] {
  if (from === to) return work.slice();
  const out = work.slice();
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
}

/** Widths a strip may be set to in whole-metre steps (4.0 :36-43); null for a fixed width (parking, cycle lane). */
export const STEP_LIMITS: Readonly<Record<StripKind, readonly [number, number] | null>> = {
  sidewalk: [1, 12], lane: [2, 6], median: [1, 8], parking: null, bike: null, shoulder: [1, 4], barrier: null, curb: null,
};

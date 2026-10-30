// The frame's own timing per system (?perf only): the frame marks where each system ends and the profile adds the
// durations up, with no allocation per frame. The probe reads the totals through the automation contract instead of
// replacing the game's methods with timers (plan P3/P5). Messages from the simulation are counted where they arrive.

/** The frame's systems, in the order the frame runs them. */
export const FRAME_PARTS = [
  'camera', 'weather', 'effects', 'audioHud', 'tools', 'layersDirty', 'roadPaint', 'growth', 'terrain', 'layersUpdate',
  'sim', 'vehicles', 'props', 'draw',
] as const;
export type FramePart = (typeof FRAME_PARTS)[number];
/** Index of each part, for the frame's marks. */
export const PART = Object.fromEntries(FRAME_PARTS.map((p, i) => [p, i])) as Record<FramePart, number>;

export class FrameProfile {
  private readonly totals = new Float64Array(FRAME_PARTS.length);
  private frames = 0;
  private drawn = 0;
  private simIn = 0;
  private mark = 0;

  /** The frame starts (after the hidden-page check). */
  begin(now: number): void { this.frames++; this.mark = now; }

  /** The part ends at `now`. */
  lap(part: number, now: number): void { this.totals[part] += now - this.mark; this.mark = now; }

  /** The frame drew (still frames stop before the layers). */
  drew(): void { this.drawn++; }

  /** A message from the simulation worker arrived. */
  simMessage(): void { this.simIn++; }

  /** Totals in ms since the last reset, per part, with the frames counted, those drawn and the simulation's messages. */
  snapshot(): Record<FramePart | 'frames' | 'drawn' | 'simIn', number> {
    const out = { frames: this.frames, drawn: this.drawn, simIn: this.simIn } as Record<FramePart | 'frames' | 'drawn' | 'simIn', number>;
    FRAME_PARTS.forEach((p, i) => { out[p] = this.totals[i]; });
    return out;
  }

  reset(): void { this.totals.fill(0); this.frames = 0; this.drawn = 0; this.simIn = 0; }
}

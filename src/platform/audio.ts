// Synthesized ambient sound (no files): rain, wind, traffic hum,
// daytime birds and thunder. Everything comes from a looping white noise run
// through filters; each layer's volume comes from the game state every frame.

export interface AmbientState {
  /** 0..1 */
  rain: number;
  wind: number;
  /** Cars near the camera (0..1). */
  traffic: number;
  /** Camera height in meters (far = muffled). */
  height: number;
  /** 0 night .. 1 day. */
  day: number;
  /** Trees nearby (0..1). */
  green: number;
}

export class Ambient {
  private ctx: AudioContext | null = null;
  /** The sound context's state (running, suspended while the game is hidden), or none before the first sound. */
  get state(): AudioContextState | 'none' { return this.ctx?.state ?? 'none'; }
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private rain: GainNode | null = null;
  private wind: GainNode | null = null;
  private windF: BiquadFilterNode | null = null;
  private hum: GainNode | null = null;
  private humF: BiquadFilterNode | null = null;
  private birdTimer = 2;
  volume = 0.6;

  /** The browser only allows playback after a gesture: called on the first click/key. */
  start(): void {
    if (this.ctx) { void this.ctx.resume(); return; }
    let ctx: AudioContext;
    try { ctx = new AudioContext(); } catch { return; }
    this.ctx = ctx;
    // minimised or in another tab: silence (and the sound comes back with the game)
    document.addEventListener('visibilitychange', () => { if (document.hidden) void ctx.suspend(); else void ctx.resume(); });
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const loop = (filters: BiquadFilterNode[]): GainNode => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise; src.loop = true;
      src.loopStart = Math.random();
      let node: AudioNode = src;
      for (const f of filters) { node.connect(f); node = f; }
      const g = ctx.createGain(); g.gain.value = 0;
      node.connect(g); g.connect(this.master!);
      src.start(0, Math.random() * 1.5);
      return g;
    };
    const bq = (type: BiquadFilterType, f: number, q = 0.7) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
    this.rain = loop([bq('highpass', 900), bq('lowpass', 7000)]);
    this.windF = bq('bandpass', 380, 0.6);
    this.wind = loop([this.windF, bq('lowpass', 900)]);
    this.humF = bq('lowpass', 220);
    this.hum = loop([this.humF, bq('highpass', 40)]);
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.1);
  }

  update(dt: number, s: AmbientState): void {
    const ctx = this.ctx;
    if (!ctx || !this.rain || !this.wind || !this.hum || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    const near = 1 / (1 + Math.max(0, s.height - 20) / 180);
    this.rain.gain.setTargetAtTime(s.rain * 0.35, t, 0.4);
    // gusts: the wind slowly rises and falls
    const gust = 0.65 + 0.35 * Math.sin(t * 0.37) * Math.sin(t * 0.13 + 1);
    this.wind.gain.setTargetAtTime((0.03 + s.wind * 0.3) * gust * (0.5 + 0.5 * (1 - near)), t, 0.6);
    this.windF!.frequency.setTargetAtTime(260 + 260 * gust * (0.5 + s.wind), t, 0.6);
    this.hum.gain.setTargetAtTime(s.traffic * 0.32 * near, t, 0.5);
    this.humF!.frequency.setTargetAtTime(160 + 160 * near, t, 0.5);
    // birds: by day, near the ground, with trees and no rain
    this.birdTimer -= dt;
    if (this.birdTimer <= 0) {
      this.birdTimer = 1.5 + Math.random() * 5;
      const p = s.day * near * s.green * (1 - s.rain);
      if (Math.random() < p) this.chirp();
    }
  }

  private chirp(): void {
    const ctx = this.ctx!, t0 = ctx.currentTime;
    const n = 2 + Math.floor(Math.random() * 4), base = 2600 + Math.random() * 2200;
    const pan = ctx.createStereoPanner(); pan.pan.value = Math.random() * 1.6 - 0.8;
    pan.connect(this.master!);
    for (let i = 0; i < n; i++) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      const s = t0 + i * (0.09 + Math.random() * 0.05);
      o.frequency.setValueAtTime(base, s);
      o.frequency.exponentialRampToValueAtTime(base * (1.25 + Math.random() * 0.4), s + 0.06);
      g.gain.setValueAtTime(0, s);
      g.gain.linearRampToValueAtTime(0.035, s + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0005, s + 0.08);
      o.connect(g); g.connect(pan);
      o.start(s); o.stop(s + 0.1);
    }
  }

  /** Short effects: build (thud and gravel), demolish (crash and rubble), click. */
  sfx(kind: 'build' | 'demolish' | 'click' | 'place' | 'undo' | 'shot' | 'boom'): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise || ctx.state !== 'running') return;
    const t0 = ctx.currentTime;
    const out = ctx.createGain(); out.connect(this.master!);
    const tone = (f0: number, f1: number, dur: number, gain: number, type: OscillatorType = 'sine') => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, t0); o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
      g.gain.setValueAtTime(gain, t0); g.gain.exponentialRampToValueAtTime(0.0005, t0 + dur);
      o.connect(g); g.connect(out); o.start(t0); o.stop(t0 + dur + 0.02);
    };
    const burst = (lp: number, dur: number, gain: number, attack = 0.005) => {
      const src = ctx.createBufferSource(); src.buffer = this.noise; src.loop = true;
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(gain, t0 + attack); g.gain.exponentialRampToValueAtTime(0.0005, t0 + dur);
      src.connect(f); f.connect(g); g.connect(out); src.start(t0, Math.random()); src.stop(t0 + dur + 0.05);
    };
    switch (kind) {
      case 'click': tone(1800, 1200, 0.04, 0.05, 'triangle'); break;
      case 'shot': burst(3500, 0.12, 0.5, 0.002); tone(180, 60, 0.12, 0.3); break;
      case 'boom': tone(70, 25, 1.4, 0.9); burst(800, 1.6, 0.9, 0.005); burst(3000, 0.3, 0.4, 0.001); break;
      case 'place': tone(520, 380, 0.09, 0.12, 'triangle'); burst(2500, 0.08, 0.05); break;
      case 'undo': tone(700, 420, 0.08, 0.06, 'triangle'); break;
      case 'build': tone(120, 55, 0.22, 0.35); burst(900, 0.35, 0.18, 0.01); break;
      case 'demolish': tone(90, 40, 0.5, 0.35); burst(1400, 0.9, 0.32, 0.02); break;
    }
  }

  /** Thunder: crack (if near) and low rumble, delayed by distance (sound at 343 m/s). */
  /** Thunder volume (0..1), from the weather panel. */
  thunderVolume = 1;

  thunder(dist: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise || ctx.state !== 'running') return;
    const t0 = ctx.currentTime + Math.min(12, dist / 343);
    const loud = Math.min(1, 900 / Math.max(300, dist)) * this.thunderVolume;
    if (loud <= 0) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise; src.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(dist < 1200 ? 2400 : 700, t0);
    lp.frequency.exponentialRampToValueAtTime(90, t0 + 2.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.9 * loud, t0 + (dist < 1200 ? 0.02 : 0.25));
    // rumble with tremors
    for (let k = 1; k < 6; k++) g.gain.linearRampToValueAtTime((0.35 + Math.random() * 0.45) * loud * (1 - k / 7), t0 + k * 0.5 + Math.random() * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0008, t0 + 5.5);
    src.connect(lp); lp.connect(g); g.connect(this.master!);
    src.start(t0, Math.random()); src.stop(t0 + 6);
  }
}

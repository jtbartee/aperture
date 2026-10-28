// Native Web Audio equivalents of the Tone.js modulation and delay effects used by the inserts.
// Same DSP and the same parameter mapping as Tone 15 (each stage is compared sample-by-sample with
// its Tone counterpart in tests/e2e/stress.mjs), built from fewer nodes: a Tone LFO is an oscillator
// → gain → waveshaper → scale chain plus constant sources, a Tone wet/dry is a constant source →
// panner → splitter → two gains, and every Tone Signal is another running ConstantSourceNode. On the
// realtime audio thread that scaffolding cost ~2–3× the filtering and delaying itself (measured on
// the Drone / Experimental stress scenario), so these use one oscillator + one gain per LFO and two
// gains per wet/dry. Tone.js is still used for reverb, compression and everything else.

/** A built effect: native input/output plus the handles its owner modulates. */
export interface NativeFx {
  input: AudioNode;
  output: AudioNode;
  dispose(): void;
}

const TAU = 0.03; // smoothing time constant for parameter changes from the UI / modulation

/** Equal-power dry/wet, Tone.CrossFade's law: dry = cos(f·π/2), wet = sin(f·π/2). */
export class DryWet {
  readonly dry: GainNode;
  readonly wet: GainNode;
  readonly output: GainNode;
  constructor(ctx: BaseAudioContext, fade: number) {
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.output = ctx.createGain();
    this.dry.connect(this.output);
    this.wet.connect(this.output);
    this.dry.gain.value = Math.cos((fade * Math.PI) / 2);
    this.wet.gain.value = Math.sin((fade * Math.PI) / 2);
  }
  set(fade: number, time: number, tc = TAU) {
    const f = Math.max(0, Math.min(1, fade));
    this.dry.gain.setTargetAtTime(Math.cos((f * Math.PI) / 2), time, tc);
    this.wet.gain.setTargetAtTime(Math.sin((f * Math.PI) / 2), time, tc);
  }
  disconnect() { for (const n of [this.dry, this.wet, this.output]) n.disconnect(); }
}

/** A sine LFO with Tone's phase convention (value = sin(ωt − φ)) feeding `depth` into params.
 *  The params keep their own value as the centre (Tone zeroes them and adds min…max instead). */
export class Lfo {
  readonly osc: OscillatorNode;
  readonly depth: GainNode;
  constructor(ctx: BaseAudioContext, rate: number, phaseDeg: number, depth: number, targets: AudioParam[]) {
    this.osc = ctx.createOscillator();
    if (phaseDeg % 360 === 0) this.osc.type = 'sine';
    else {
      const ph = (phaseDeg * Math.PI) / 180;
      this.osc.setPeriodicWave(ctx.createPeriodicWave(new Float32Array([0, -Math.sin(ph)]), new Float32Array([0, Math.cos(ph)])));
    }
    this.osc.frequency.value = rate;
    this.depth = ctx.createGain();
    this.depth.gain.value = depth;
    this.osc.connect(this.depth);
    for (const t of targets) this.depth.connect(t);
    this.osc.start();
  }
  dispose() { try { this.osc.stop(); } catch { /* not started */ } this.osc.disconnect(); this.depth.disconnect(); }
}

const stereoIn = (ctx: BaseAudioContext) => {
  const g = ctx.createGain();
  g.channelCount = 2;
  g.channelCountMode = 'explicit';
  return g;
};

/** Tone.LFO min/max → centre and half-range (amplitude scales the half-range). */
const span = (min: number, max: number, amp = 1) => ({ center: (min + max) / 2, half: ((max - min) / 2) * amp });

// ---------------------------------------------------------------- Phaser (Tone.Phaser, stereo)

export class NativePhaser implements NativeFx {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly mix: DryWet;
  readonly filters: BiquadFilterNode[] = [];
  private lfos: Lfo[] = [];
  private split: ChannelSplitterNode;
  private merge: ChannelMergerNode;
  constructor(ctx: BaseAudioContext, o: { rate: number; octaves: number; base: number; wet: number; q?: number; stages?: number }) {
    this.input = stereoIn(ctx);
    this.mix = new DryWet(ctx, o.wet);
    this.output = this.mix.output;
    this.split = ctx.createChannelSplitter(2);
    this.merge = ctx.createChannelMerger(2);
    this.input.connect(this.mix.dry);
    this.input.connect(this.split);
    this.merge.connect(this.mix.wet);
    const { center, half } = span(o.base, o.base * Math.pow(2, o.octaves));
    for (let ch = 0; ch < 2; ch++) {
      const chain: BiquadFilterNode[] = [];
      for (let i = 0; i < (o.stages ?? 10); i++) {
        const f = ctx.createBiquadFilter();
        f.type = 'allpass';
        f.frequency.value = center;
        f.Q.value = o.q ?? 10;
        if (i) chain[i - 1].connect(f);
        chain.push(f);
      }
      this.split.connect(chain[0], ch);
      chain[chain.length - 1].connect(this.merge, 0, ch);
      this.filters.push(...chain);
      this.lfos.push(new Lfo(ctx, o.rate, ch ? 180 : 0, half, chain.map((f) => f.frequency)));
    }
  }
  set(o: { rate: number; octaves: number; base: number }, time: number) {
    const { center, half } = span(o.base, o.base * Math.pow(2, o.octaves));
    for (const f of this.filters) f.frequency.setTargetAtTime(center, time, TAU);
    for (const l of this.lfos) { l.depth.gain.setTargetAtTime(half, time, TAU); l.osc.frequency.setTargetAtTime(o.rate, time, TAU); }
  }
  dispose() {
    this.lfos.forEach((l) => l.dispose());
    for (const n of [this.input, this.split, this.merge, ...this.filters]) n.disconnect();
    this.mix.disconnect();
  }
}

// ---------------------------------------------------------------- Chorus (Tone.Chorus, spread 180, feedback 0)

export class NativeChorus implements NativeFx {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly mix: DryWet;
  private delays: DelayNode[] = [];
  private lfos: Lfo[] = [];
  private split: ChannelSplitterNode;
  private merge: ChannelMergerNode;
  constructor(ctx: BaseAudioContext, private o: { rate: number; depth: number; delayMs: number; wet: number }) {
    this.input = stereoIn(ctx);
    this.mix = new DryWet(ctx, o.wet);
    this.output = this.mix.output;
    this.split = ctx.createChannelSplitter(2);
    this.merge = ctx.createChannelMerger(2);
    this.input.connect(this.mix.dry);
    this.input.connect(this.split);
    this.merge.connect(this.mix.wet);
    const { center, half } = this.range(o.depth, o.delayMs);
    for (let ch = 0; ch < 2; ch++) {
      const d = ctx.createDelay(0.1);
      d.delayTime.value = center;
      this.split.connect(d, ch);
      d.connect(this.merge, 0, ch);
      this.delays.push(d);
      // spread 180°: Tone sets the phases to 90 ∓ spread/2 → 0° and 180°
      this.lfos.push(new Lfo(ctx, o.rate, ch ? 180 : 0, half, [d.delayTime]));
    }
  }
  /** Tone.Chorus.depth: delay ± delay·depth (never below zero). */
  private range(depth: number, delayMs: number) {
    const dt = delayMs / 1000;
    const dev = dt * depth;
    return span(Math.max(dt - dev, 0), dt + dev);
  }
  set(o: { rate: number; depth: number; delayMs: number }, time: number) {
    this.o = { ...this.o, ...o };
    const { center, half } = this.range(o.depth, o.delayMs);
    for (const d of this.delays) d.delayTime.setTargetAtTime(center, time, TAU);
    for (const l of this.lfos) { l.depth.gain.setTargetAtTime(half, time, TAU); l.osc.frequency.setTargetAtTime(o.rate, time, TAU); }
  }
  setDepth(depth: number, time: number) { this.set({ rate: this.o.rate, depth, delayMs: this.o.delayMs }, time); }
  dispose() {
    this.lfos.forEach((l) => l.dispose());
    for (const n of [this.input, this.split, this.merge, ...this.delays]) n.disconnect();
    this.mix.disconnect();
  }
}

// ---------------------------------------------------------------- AutoPanner (Tone.AutoPanner: mono in, LFO pan)

export class NativeAutoPanner implements NativeFx {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly mix: DryWet;
  readonly panner: StereoPannerNode;
  private lfo: Lfo;
  constructor(ctx: BaseAudioContext, o: { rate: number; depth: number; wet: number }) {
    this.input = ctx.createGain();
    this.mix = new DryWet(ctx, o.wet);
    this.output = this.mix.output;
    // Tone's AutoPanner uses a one-channel panner: the input is summed to mono, then panned
    this.panner = ctx.createStereoPanner();
    this.panner.channelCount = 1;
    this.panner.channelCountMode = 'explicit';
    this.panner.pan.value = 0;
    this.input.connect(this.mix.dry);
    this.input.connect(this.panner).connect(this.mix.wet);
    this.lfo = new Lfo(ctx, o.rate, 0, o.depth, [this.panner.pan]);
  }
  set(o: { rate: number; depth: number }, time: number) {
    this.lfo.osc.frequency.setTargetAtTime(o.rate, time, TAU);
    this.lfo.depth.gain.setTargetAtTime(o.depth, time, TAU);
  }
  dispose() { this.lfo.dispose(); this.input.disconnect(); this.panner.disconnect(); this.mix.disconnect(); }
}

// ---------------------------------------------------------------- AutoFilter (Tone.AutoFilter, −12 dB lowpass)

export class NativeAutoFilter implements NativeFx {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly mix: DryWet;
  readonly filter: BiquadFilterNode;
  private lfo: Lfo;
  constructor(ctx: BaseAudioContext, o: { rate: number; octaves: number; base: number; q: number; wet: number; depth?: number }) {
    this.input = ctx.createGain();
    this.mix = new DryWet(ctx, o.wet);
    this.output = this.mix.output;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = o.q;
    const { center, half } = span(o.base, o.base * Math.pow(2, o.octaves), o.depth ?? 1);
    this.filter.frequency.value = center;
    this.input.connect(this.mix.dry);
    this.input.connect(this.filter).connect(this.mix.wet);
    this.lfo = new Lfo(ctx, o.rate, 0, half, [this.filter.frequency]);
  }
  set(o: { rate: number; octaves: number; base: number }, time: number) {
    const { center, half } = span(o.base, o.base * Math.pow(2, o.octaves));
    this.filter.frequency.setTargetAtTime(center, time, TAU);
    this.lfo.depth.gain.setTargetAtTime(half, time, TAU);
    this.lfo.osc.frequency.setTargetAtTime(o.rate, time, TAU);
  }
  dispose() { this.lfo.dispose(); this.input.disconnect(); this.filter.disconnect(); this.mix.disconnect(); }
}

// ---------------------------------------------------------------- FeedbackDelay (Tone.FeedbackDelay)

export class NativeFeedbackDelay implements NativeFx {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly mix: DryWet;
  readonly delay: DelayNode;
  readonly feedback: GainNode;
  constructor(ctx: BaseAudioContext, o: { time: number; feedback: number; wet: number; maxDelay: number }) {
    this.input = ctx.createGain();
    this.mix = new DryWet(ctx, o.wet);
    this.output = this.mix.output;
    this.delay = ctx.createDelay(o.maxDelay);
    this.delay.delayTime.value = o.time;
    this.feedback = ctx.createGain();
    this.feedback.gain.value = o.feedback;
    this.input.connect(this.mix.dry);
    this.input.connect(this.delay);
    this.delay.connect(this.mix.wet);
    this.delay.connect(this.feedback).connect(this.delay);
  }
  dispose() { for (const n of [this.input, this.delay, this.feedback]) n.disconnect(); this.mix.disconnect(); }
}

// ---------------------------------------------------------------- PingPongDelay (Tone.PingPongDelay)

/** Tone.PingPongDelay: the left input is delayed by `time`, the right by twice that (a pre-delay
 *  then the delay), and each echo crosses to the other side scaled by `feedback`. */
export class NativePingPong implements NativeFx {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly mix: DryWet;
  readonly delays: DelayNode[];
  readonly feedbacks: GainNode[];
  private split: ChannelSplitterNode;
  private merge: ChannelMergerNode;
  constructor(ctx: BaseAudioContext, o: { time: number; feedback: number; wet: number; maxDelay: number }) {
    this.input = stereoIn(ctx);
    this.mix = new DryWet(ctx, o.wet);
    this.output = this.mix.output;
    this.split = ctx.createChannelSplitter(2);
    this.merge = ctx.createChannelMerger(2);
    const left = ctx.createDelay(o.maxDelay);
    const rightPre = ctx.createDelay(o.maxDelay);
    const right = ctx.createDelay(o.maxDelay);
    this.delays = [left, rightPre, right];
    for (const d of this.delays) d.delayTime.value = o.time;
    const fbL = ctx.createGain();
    const fbR = ctx.createGain();
    this.feedbacks = [fbL, fbR];
    for (const g of this.feedbacks) g.gain.value = o.feedback;
    this.input.connect(this.mix.dry);
    this.input.connect(this.split);
    this.split.connect(left, 0);
    this.split.connect(rightPre, 1).connect(right);
    left.connect(fbL).connect(right);
    right.connect(fbR).connect(left);
    left.connect(this.merge, 0, 0);
    right.connect(this.merge, 0, 1);
    this.merge.connect(this.mix.wet);
  }
  dispose() { for (const n of [this.input, this.split, this.merge, ...this.delays, ...this.feedbacks]) n.disconnect(); this.mix.disconnect(); }
}

// ---------------------------------------------------------------- Reverb (Tone.Reverb's impulse, truncated)

/** Tone.Reverb's envelope: `exponentialApproachValueAtTime(0, preDelay, decay)` is a setTarget with
 *  time constant ln(decay + 1) / ln(200) — so "decay 9 s" reaches −60 dB after ~3 s. */
export const reverbTau = (decay: number) => Math.log(decay + 1) / Math.log(200);

/** Below this the impulse is cut: it is under 16-bit resolution relative to its own start. */
export const REVERB_FLOOR_DB = -90;

/** Tone.Reverb's impulse response, generated directly: independent white noise per channel, silent
 *  until the pre-delay, then e^(−t/τ). Tone renders `decay + preDelay` seconds, but past the
 *  −90 dB point the remainder is numerically inaudible, and a ConvolverNode's realtime cost grows
 *  with impulse length (measured in Chrome 156: 3 × 9 s convolvers cost 1.4× as much as 3 × 4.8 s),
 *  so the impulse stops there with a short fade. The noise is seeded, so renders are reproducible.
 *
 *  Level: ConvolverNode normalisation divides by the impulse's RMS over its *whole length* (Web
 *  Audio spec, calculateNormalizationScale), so a normalised shorter impulse would come out
 *  quieter by √(full/short). The spec's scale for the full-length impulse is baked into the
 *  samples instead, and the node is used with normalize = false. */
export function reverbImpulse(ctx: BaseAudioContext, decay: number, preDelay: number, seed = 1): AudioBuffer {
  const sr = ctx.sampleRate;
  const tau = reverbTau(decay);
  const audible = tau * Math.log(Math.pow(10, -REVERB_FLOOR_DB / 20));
  const seconds = Math.max(0.05, Math.min(decay, audible) + preDelay);
  const n = Math.ceil(seconds * sr);
  const fullLength = Math.max(n, Math.round((decay + preDelay) * sr));
  const ir = ctx.createBuffer(2, n, sr);
  const start = Math.round(preDelay * sr);
  const fade = Math.min(n - start, Math.round(0.05 * sr));
  let s = (seed * 2654435761) >>> 0 || 1;
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    for (let i = start; i < n; i++) {
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      const tail = i >= n - fade ? (n - i) / fade : 1;
      d[i] = ((s / 4294967296) * 2 - 1) * Math.exp(-(i - start) / sr / tau) * tail;
    }
  }
  // spec normalisation as if the impulse were full length (energy past the cut is ~1e-9 of it)
  let energy = 0;
  for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < n; i++) energy += d[i] * d[i]; }
  const power = Math.max(0.000125, Math.sqrt(energy / (2 * fullLength)));
  const scale = (0.00125 * (44100 / sr)) / power;
  for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < n; i++) d[i] *= scale; }
  return ir;
}

export class NativeReverb implements NativeFx {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly mix: DryWet;
  readonly convolver: ConvolverNode;
  constructor(private ctx: BaseAudioContext, private o: { decay: number; preDelay: number; wet: number; seed?: number }) {
    this.input = ctx.createGain();
    this.mix = new DryWet(ctx, o.wet);
    this.output = this.mix.output;
    this.convolver = ctx.createConvolver();
    this.convolver.normalize = false; // the impulse carries its own (full-length) normalisation
    this.convolver.buffer = reverbImpulse(ctx, o.decay, o.preDelay, o.seed);
    this.input.connect(this.mix.dry);
    this.input.connect(this.convolver).connect(this.mix.wet);
  }
  /** Regenerate the impulse (only when decay or pre-delay changed). */
  setShape(decay: number, preDelay: number) {
    if (Math.abs(decay - this.o.decay) < 1e-6 && Math.abs(preDelay - this.o.preDelay) < 1e-6) return;
    this.o = { ...this.o, decay, preDelay };
    this.convolver.buffer = reverbImpulse(this.ctx, decay, preDelay, this.o.seed);
  }
  dispose() { this.input.disconnect(); this.convolver.disconnect(); this.mix.disconnect(); }
}

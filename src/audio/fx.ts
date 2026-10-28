import * as Tone from 'tone';
import type { EffectSlot, FxType, ModTarget } from '../core/types';
import { crushCurve } from './voices';
import { BLOCK, MAX_FILTER_STEP_OCT, MAX_PAN_STEP, biquadParams, blockRate, lfoBlockStep, sampleRateParams } from './quality';
import { DryWet, NativeAutoFilter, NativeAutoPanner, NativeChorus, NativeFeedbackDelay, NativePhaser, NativePingPong, NativeReverb, type NativeFx } from './nativeFx';

export interface ParamDef { key: string; label: string; min: number; max: number; step: number; def: number; unit?: string }
export interface FxDef { type: FxType; label: string; params: ParamDef[] }

const wet = (def = 0.35): ParamDef => ({ key: 'wet', label: 'Dry/wet', min: 0, max: 1, step: 0.01, def });

export const FX_DEFS: Record<FxType, FxDef> = {
  delay: { type: 'delay', label: 'Delay', params: [{ key: 'time', label: 'Time', min: 0.03, max: 2, step: 0.01, def: 0.375, unit: 's' }, { key: 'feedback', label: 'Feedback', min: 0, max: 0.92, step: 0.01, def: 0.4 }, wet(0.3)] },
  pingpong: { type: 'pingpong', label: 'Ping-pong delay', params: [{ key: 'time', label: 'Time', min: 0.03, max: 2, step: 0.01, def: 0.25, unit: 's' }, { key: 'feedback', label: 'Feedback', min: 0, max: 0.92, step: 0.01, def: 0.45 }, wet(0.3)] },
  reverb: { type: 'reverb', label: 'Reverb', params: [{ key: 'decay', label: 'Size', min: 0.4, max: 18, step: 0.1, def: 4, unit: 's' }, { key: 'preDelay', label: 'Pre-delay', min: 0, max: 0.2, step: 0.005, def: 0.02, unit: 's' }, wet(0.35)] },
  chorus: { type: 'chorus', label: 'Chorus', params: [{ key: 'rate', label: 'Rate', min: 0.05, max: 8, step: 0.05, def: 1.2, unit: 'Hz' }, { key: 'depth', label: 'Depth', min: 0, max: 1, step: 0.01, def: 0.6 }, { key: 'delay', label: 'Delay', min: 2, max: 20, step: 0.5, def: 4, unit: 'ms' }, wet(0.5)] },
  phaser: { type: 'phaser', label: 'Phaser', params: [{ key: 'rate', label: 'Rate', min: 0.02, max: 8, step: 0.01, def: 0.3, unit: 'Hz' }, { key: 'octaves', label: 'Octaves', min: 0.5, max: 6, step: 0.1, def: 3 }, { key: 'base', label: 'Base', min: 100, max: 2000, step: 10, def: 350, unit: 'Hz' }, wet(0.5)] },
  tremolo: { type: 'tremolo', label: 'Tremolo', params: [{ key: 'rate', label: 'Rate', min: 0.1, max: 20, step: 0.1, def: 4, unit: 'Hz' }, { key: 'depth', label: 'Depth', min: 0, max: 1, step: 0.01, def: 0.6 }, wet(1)] },
  autopan: { type: 'autopan', label: 'Auto-pan', params: [{ key: 'rate', label: 'Rate', min: 0.02, max: 10, step: 0.01, def: 0.2, unit: 'Hz' }, { key: 'depth', label: 'Depth', min: 0, max: 1, step: 0.01, def: 0.8 }, wet(1)] },
  filter: { type: 'filter', label: 'Filter', params: [{ key: 'mode', label: 'LP/HP/BP', min: 0, max: 2, step: 1, def: 0 }, { key: 'cutoff', label: 'Cutoff', min: 40, max: 18000, step: 1, def: 2000, unit: 'Hz' }, { key: 'res', label: 'Resonance', min: 0.1, max: 18, step: 0.1, def: 1 }] },
  distortion: { type: 'distortion', label: 'Saturation', params: [{ key: 'amount', label: 'Drive', min: 0, max: 1, step: 0.01, def: 0.3 }, wet(0.6)] },
  bitcrusher: { type: 'bitcrusher', label: 'Bitcrusher', params: [{ key: 'bits', label: 'Bits', min: 1, max: 12, step: 0.5, def: 5 }, wet(0.5)] },
  width: { type: 'width', label: 'Stereo width', params: [{ key: 'width', label: 'Width', min: 0, max: 1, step: 0.01, def: 0.7 }] },
  compressor: { type: 'compressor', label: 'Compressor', params: [{ key: 'threshold', label: 'Threshold', min: -60, max: 0, step: 0.5, def: -20, unit: 'dB' }, { key: 'ratio', label: 'Ratio', min: 1, max: 20, step: 0.1, def: 4 }, { key: 'attack', label: 'Attack', min: 0.001, max: 0.3, step: 0.001, def: 0.01, unit: 's' }, { key: 'release', label: 'Release', min: 0.02, max: 1, step: 0.01, def: 0.2, unit: 's' }] },
  limiter: { type: 'limiter', label: 'Limiter', params: [{ key: 'threshold', label: 'Ceiling', min: -24, max: 0, step: 0.5, def: -3, unit: 'dB' }] },
  atmosSweep: {
    type: 'atmosSweep', label: 'Atmospheric Sweep', params: [
      { key: 'mix', label: 'Dry/wet', min: 0, max: 1, step: 0.01, def: 0.45 },
      { key: 'speed', label: 'Sweep speed', min: 0.01, max: 2, step: 0.01, def: 0.12, unit: 'Hz' },
      { key: 'depth', label: 'Sweep depth', min: 0, max: 1, step: 0.01, def: 0.7 },
      { key: 'size', label: 'Reverb size', min: 1, max: 18, step: 0.1, def: 9, unit: 's' },
      { key: 'feedback', label: 'Feedback', min: 0, max: 0.9, step: 0.01, def: 0.45 },
      { key: 'spread', label: 'Stereo spread', min: 0, max: 1, step: 0.01, def: 0.85 },
      { key: 'filterMove', label: 'Filter movement', min: 0, max: 1, step: 0.01, def: 0.6 },
    ],
  },
};

export const FX_TYPES = Object.keys(FX_DEFS) as FxType[];

export function defaultParams(type: FxType): Record<string, number> {
  return Object.fromEntries(FX_DEFS[type].params.map((p) => [p.key, p.def]));
}

export interface FxUnit {
  type: FxType;
  input: Tone.InputNode;
  output: Tone.OutputNode;
  set(params: Record<string, number>): void;
  /** apply a normalised modulation value; returns false if this unit has no such target */
  mod(target: ModTarget, v: number, time: number): boolean;
  ready: Promise<void>;
  dispose(): void;
}

const FILTER_MODES: BiquadFilterType[] = ['lowpass', 'highpass', 'bandpass'];

/** How an insert is built: whether slow LFO sweeps may run at block rate (audio/quality.ts). */
export interface FxContext { blockRate: boolean; sampleRate: number }

/** Largest per-block step, in octaves, of a sine LFO sweeping a frequency linearly in Hz between
 *  f and f·2^octaves (Tone's Phaser and AutoFilter): max |d ln f/dt| = ω(R−1)/(2√R). */
export function sweepBlockStep(rate: number, octaves: number, sampleRate: number) {
  const R = Math.pow(2, Math.max(0, octaves));
  return (2 * Math.PI * Math.abs(rate) * (R - 1)) / (2 * Math.sqrt(R)) / Math.LN2 * (BLOCK / sampleRate);
}

/** Put parameters at block rate when allowed and the movement is slow enough, else sample rate. */
function rateFor(fc: FxContext, params: (AudioParam | null)[], slow: boolean) {
  if (fc.blockRate && slow) blockRate(...params);
  else sampleRateParams(...params);
}

/** Calls `apply` with only the parameters that changed since the last call. sync() re-sends every
 *  insert's parameters on any track edit; touching unchanged ones would cancel lane automation
 *  already scheduled on them (and add needless automation events). */
function changes(initial: Record<string, number>) {
  let last = { ...initial };
  return (q: Record<string, number>, apply: (changed: (k: string) => boolean) => void) => {
    const prev = last;
    last = { ...q };
    if (Object.keys(q).every((k) => Math.abs(q[k] - prev[k]) < 1e-9)) return;
    apply((k) => Math.abs(q[k] - prev[k]) >= 1e-9);
  };
}

/** An insert built from native nodes (audio/nativeFx.ts). */
function native(type: FxType, fx: NativeFx, set: FxUnit['set'], mod: FxUnit['mod'] = () => false, ready = Promise.resolve(), extra: { dispose(): void }[] = []): FxUnit {
  return { type, input: fx.input, output: fx.output, set, mod, ready, dispose: () => { fx.dispose(); extra.forEach((e) => e.dispose()); } };
}

function simple<T extends Tone.ToneAudioNode>(type: FxType, node: T, set: (p: Record<string, number>) => void, mod: FxUnit['mod'] = () => false, ready = Promise.resolve(), extra: Tone.ToneAudioNode[] = []): FxUnit {
  return { type, input: node, output: node, set, mod, ready, dispose: () => { node.dispose(); extra.forEach((e) => e.dispose()); } };
}

export function createFx(slot: EffectSlot, fc: FxContext = { blockRate: false, sampleRate: 48000 }): FxUnit {
  const p = { ...defaultParams(slot.type), ...slot.params };
  switch (slot.type) {
    case 'delay': {
      const d = new NativeFeedbackDelay(Tone.getContext().rawContext as BaseAudioContext, { time: p.time, feedback: p.feedback, wet: p.wet, maxDelay: 2.5 });
      const ch = changes(p);
      return native('delay', d, (q) => ch(q, (c) => {
        const now = d.input.context.currentTime;
        if (c('time')) d.delay.delayTime.setTargetAtTime(q.time, now, 0.02);
        if (c('feedback')) d.feedback.gain.setTargetAtTime(q.feedback, now, 0.02);
        if (c('wet')) d.mix.set(q.wet, now, 0.02);
      }), (t, v, time) => { if (t !== 'delayFeedback') return false; d.feedback.gain.setTargetAtTime(v * 0.9, time, 0.05); return true; });
    }
    case 'pingpong': {
      const d = new NativePingPong(Tone.getContext().rawContext as BaseAudioContext, { time: p.time, feedback: p.feedback, wet: p.wet, maxDelay: 2.5 });
      const ch = changes(p);
      return native('pingpong', d, (q) => ch(q, (c) => {
        const now = d.input.context.currentTime;
        if (c('time')) for (const x of d.delays) x.delayTime.setTargetAtTime(q.time, now, 0.02);
        if (c('feedback')) for (const g of d.feedbacks) g.gain.setTargetAtTime(q.feedback, now, 0.02);
        if (c('wet')) d.mix.set(q.wet, now, 0.02);
      }), (t, v, time) => { if (t !== 'delayFeedback') return false; for (const g of d.feedbacks) g.gain.setTargetAtTime(v * 0.9, time, 0.05); return true; });
    }
    case 'reverb': {
      const r = new NativeReverb(Tone.getContext().rawContext as BaseAudioContext, { decay: p.decay, preDelay: p.preDelay, wet: p.wet, seed: 3 });
      const ch = changes(p);
      return native('reverb', r, (q) => ch(q, (k) => {
        if (k('wet')) r.mix.set(q.wet, r.input.context.currentTime);
        if (k('decay') || k('preDelay')) r.setShape(q.decay, q.preDelay);
      }));
    }
    case 'chorus': {
      const c = new NativeChorus(Tone.getContext().rawContext as BaseAudioContext, { rate: p.rate, depth: p.depth, delayMs: p.delay, wet: p.wet });
      const ch = changes(p);
      return native('chorus', c, (q) => ch(q, (k) => {
        const now = c.input.context.currentTime;
        if (k('rate') || k('depth') || k('delay')) c.set({ rate: q.rate, depth: q.depth, delayMs: q.delay }, now);
        if (k('wet')) c.mix.set(q.wet, now);
      }), (t, v, time) => { if (t !== 'chorusDepth') return false; c.setDepth(v, time); return true; });
    }
    case 'phaser': {
      const ph = new NativePhaser(Tone.getContext().rawContext as BaseAudioContext, { rate: p.rate, octaves: p.octaves, base: p.base, wet: p.wet });
      const rates = (q: Record<string, number>) => rateFor(fc, ph.filters.flatMap(biquadParams), sweepBlockStep(q.rate, q.octaves, fc.sampleRate) <= MAX_FILTER_STEP_OCT);
      rates(p);
      const ch = changes(p);
      return native('phaser', ph, (q) => ch(q, (k) => {
        const now = ph.input.context.currentTime;
        if (k('rate') || k('octaves') || k('base')) { ph.set({ rate: q.rate, octaves: q.octaves, base: q.base }, now); rates(q); }
        if (k('wet')) ph.mix.set(q.wet, now);
      }));
    }
    case 'tremolo': {
      const tr = new Tone.Tremolo({ frequency: p.rate, depth: p.depth, wet: p.wet, spread: 0 }).start();
      return simple('tremolo', tr, (q) => { tr.frequency.rampTo(q.rate, 0.05); tr.depth.rampTo(q.depth, 0.05); tr.wet.rampTo(q.wet, 0.05); },
        (t, v, time) => { if (t !== 'tremoloRate') return false; tr.frequency.setTargetAtTime(0.2 + v * 14, time, 0.08); return true; });
    }
    case 'autopan': {
      const ap = new NativeAutoPanner(Tone.getContext().rawContext as BaseAudioContext, { rate: p.rate, depth: p.depth, wet: p.wet });
      const rates = (q: Record<string, number>) => rateFor(fc, [ap.panner.pan], lfoBlockStep(q.rate, q.depth, fc.sampleRate) <= MAX_PAN_STEP);
      rates(p);
      const ch = changes(p);
      return native('autopan', ap, (q) => ch(q, (k) => {
        const now = ap.input.context.currentTime;
        if (k('rate') || k('depth')) { ap.set({ rate: q.rate, depth: q.depth }, now); rates(q); }
        if (k('wet')) ap.mix.set(q.wet, now);
      }));
    }
    case 'filter': {
      const f = new Tone.Filter({ type: FILTER_MODES[Math.round(p.mode)] ?? 'lowpass', frequency: p.cutoff, Q: p.res, rolloff: -24 });
      return simple('filter', f, (q) => { f.type = FILTER_MODES[Math.round(q.mode)] ?? 'lowpass'; f.frequency.rampTo(q.cutoff, 0.05); f.Q.rampTo(q.res, 0.05); });
    }
    case 'distortion': {
      const d = new Tone.Distortion({ distortion: p.amount, wet: p.wet, oversample: '2x' });
      let last = -1;
      return simple('distortion', d, (q) => { d.distortion = q.amount; d.wet.rampTo(q.wet, 0.05); },
        (t, v) => { if (t !== 'drive') return false; if (Math.abs(v - last) > 0.02) { last = v; d.distortion = v; } return true; });
    }
    case 'bitcrusher': {
      // amplitude quantiser (bit depth) — runs in any context, including offline renders
      const ws = new Tone.WaveShaper(crushCurve(p.bits));
      const xf = new Tone.CrossFade(p.wet);
      const inp = new Tone.Gain();
      inp.connect(xf.a);
      inp.connect(ws);
      ws.connect(xf.b);
      let lastBits = p.bits;
      return {
        type: 'bitcrusher', input: inp, output: xf, ready: Promise.resolve(),
        set: (q) => { ws.curve = crushCurve(q.bits); xf.fade.rampTo(q.wet, 0.05); },
        mod: (t, v) => { if (t !== 'crush') return false; const b = 12 - v * 10; if (Math.abs(b - lastBits) >= 0.5) { lastBits = b; ws.curve = crushCurve(b); } return true; },
        dispose: () => { ws.dispose(); xf.dispose(); inp.dispose(); },
      };
    }
    case 'width': {
      const w = new Tone.StereoWidener(p.width);
      return simple('width', w, (q) => w.width.rampTo(q.width, 0.05));
    }
    case 'compressor': {
      const c = new Tone.Compressor({ threshold: p.threshold, ratio: p.ratio, attack: p.attack, release: p.release });
      return simple('compressor', c, (q) => { c.threshold.value = q.threshold; c.ratio.value = q.ratio; c.attack.value = q.attack; c.release.value = q.release; });
    }
    case 'limiter': {
      // 150 ms release: a 10 ms limiter release moves the gain inside low kick cycles and crackles
      const c = new Tone.Compressor({ threshold: p.threshold, ratio: 20, attack: 0.002, release: 0.15, knee: 1 });
      return simple('limiter', c, (q) => { c.threshold.value = q.threshold; });
    }
    case 'atmosSweep':
      return createAtmosSweep(p, fc);
  }
}

/** Atmospheric Sweep: slow stereo auto-pan → modulated phase + chorus → large diffuse reverb with
 *  feedback ambience → sweeping tonal filter, blended behind the clean signal. The modulation and
 *  delay stages are the native equivalents of the Tone.js effects it was designed with (same
 *  mapping, verified against them); the reverb is Tone.Reverb's impulse (nativeFx.ts). */
function createAtmosSweep(p: Record<string, number>, fc: FxContext): FxUnit {
  const ctx = Tone.getContext().rawContext as BaseAudioContext;
  const input = ctx.createGain();
  const xf = new DryWet(ctx, p.mix);
  const pan = new NativeAutoPanner(ctx, { rate: p.speed * 0.5, depth: p.spread, wet: 1 });
  const phaser = new NativePhaser(ctx, { rate: p.speed, octaves: 1 + p.depth * 4, base: 280, wet: 0.6 });
  const chorus = new NativeChorus(ctx, { rate: p.speed * 3, depth: 0.4 + p.depth * 0.6, delayMs: 6, wet: 0.6 });
  const fb = new NativeFeedbackDelay(ctx, { time: 0.61, feedback: p.feedback, wet: 0.35, maxDelay: 1.5 });
  const verb = new NativeReverb(ctx, { decay: p.size, preDelay: 0.04, wet: 0.85, seed: 2 });
  const sweep = new NativeAutoFilter(ctx, { rate: p.speed * 0.7, octaves: 1 + p.filterMove * 4.5, base: 180, q: 1.5, wet: 1 });
  const wetTrim = ctx.createGain();
  wetTrim.gain.value = 1.4;
  input.connect(xf.dry);
  input.connect(pan.input);
  pan.output.connect(phaser.input);
  phaser.output.connect(chorus.input);
  chorus.output.connect(fb.input);
  fb.output.connect(verb.input);
  verb.output.connect(sweep.input);
  sweep.output.connect(wetTrim).connect(xf.wet);
  // the three slow sweeps (well under 1 Hz) may run at block rate; the chorus delay sweep may not
  // (a stepped delay time jumps the read position several samples per block)
  const rates = (q: Record<string, number>) => {
    rateFor(fc, phaser.filters.flatMap(biquadParams), sweepBlockStep(q.speed, 1 + q.depth * 4, fc.sampleRate) <= MAX_FILTER_STEP_OCT);
    rateFor(fc, biquadParams(sweep.filter), sweepBlockStep(q.speed * 0.7, 1 + q.filterMove * 4.5, fc.sampleRate) <= MAX_FILTER_STEP_OCT);
    rateFor(fc, [pan.panner.pan], lfoBlockStep(q.speed * 0.5, q.spread, fc.sampleRate) <= MAX_PAN_STEP);
  };
  rates(p);
  const ch = changes(p);
  return {
    type: 'atmosSweep', input, output: xf.output, ready: Promise.resolve(),
    set: (q) => ch(q, (k) => {
      const now = ctx.currentTime;
      if (k('mix')) xf.set(q.mix, now, 0.03);
      if (k('speed') || k('spread')) pan.set({ rate: q.speed * 0.5, depth: q.spread }, now);
      if (k('speed') || k('depth')) {
        phaser.set({ rate: q.speed, octaves: 1 + q.depth * 4, base: 280 }, now);
        chorus.set({ rate: q.speed * 3, depth: 0.4 + q.depth * 0.6, delayMs: 6 }, now);
      }
      if (k('feedback')) fb.feedback.gain.setTargetAtTime(q.feedback, now, 0.03);
      if (k('speed') || k('filterMove')) sweep.set({ rate: q.speed * 0.7, octaves: 1 + q.filterMove * 4.5, base: 180 }, now);
      if (k('size')) verb.setShape(q.size, 0.04);
      rates(q);
    }),
    mod: (t, v, time) => {
      if (t === 'sweepDepth') { xf.set(v, time, 0.1); return true; }
      if (t === 'delayFeedback') { fb.feedback.gain.setTargetAtTime(v * 0.85, time, 0.1); return true; }
      return false;
    },
    dispose: () => {
      for (const x of [pan, phaser, chorus, fb, sweep]) x.dispose();
      verb.dispose();
      input.disconnect();
      wetTrim.disconnect();
      xf.disconnect();
    },
  };
}

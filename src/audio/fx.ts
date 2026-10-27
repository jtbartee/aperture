import * as Tone from 'tone';
import type { EffectSlot, FxType, ModTarget } from '../core/types';
import { crushCurve } from './voices';

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

function simple<T extends Tone.ToneAudioNode>(type: FxType, node: T, set: (p: Record<string, number>) => void, mod: FxUnit['mod'] = () => false, ready = Promise.resolve(), extra: Tone.ToneAudioNode[] = []): FxUnit {
  return { type, input: node, output: node, set, mod, ready, dispose: () => { node.dispose(); extra.forEach((e) => e.dispose()); } };
}

export function createFx(slot: EffectSlot): FxUnit {
  const p = { ...defaultParams(slot.type), ...slot.params };
  switch (slot.type) {
    case 'delay': {
      const d = new Tone.FeedbackDelay({ delayTime: p.time, feedback: p.feedback, wet: p.wet, maxDelay: 2.5 });
      return simple('delay', d, (q) => { d.delayTime.rampTo(q.time, 0.05); d.feedback.rampTo(q.feedback, 0.05); d.wet.rampTo(q.wet, 0.05); },
        (t, v, time) => { if (t !== 'delayFeedback') return false; d.feedback.setTargetAtTime(v * 0.9, time, 0.05); return true; });
    }
    case 'pingpong': {
      const d = new Tone.PingPongDelay({ delayTime: p.time, feedback: p.feedback, wet: p.wet, maxDelay: 2.5 });
      return simple('pingpong', d, (q) => { d.delayTime.rampTo(q.time, 0.05); d.feedback.rampTo(q.feedback, 0.05); d.wet.rampTo(q.wet, 0.05); },
        (t, v, time) => { if (t !== 'delayFeedback') return false; d.feedback.setTargetAtTime(v * 0.9, time, 0.05); return true; });
    }
    case 'reverb': {
      const r = new Tone.Reverb({ decay: p.decay, preDelay: p.preDelay, wet: p.wet });
      let decay = p.decay;
      return simple('reverb', r, (q) => {
        r.wet.rampTo(q.wet, 0.05);
        if (Math.abs(q.decay - decay) > 0.05) { decay = q.decay; r.decay = q.decay; }
        r.preDelay = q.preDelay;
      }, () => false, r.ready.then(() => undefined));
    }
    case 'chorus': {
      const c = new Tone.Chorus({ frequency: p.rate, depth: p.depth, delayTime: p.delay, wet: p.wet, spread: 180 }).start();
      return simple('chorus', c, (q) => { c.frequency.rampTo(q.rate, 0.05); c.depth = q.depth; c.delayTime = q.delay; c.wet.rampTo(q.wet, 0.05); },
        (t, v) => { if (t !== 'chorusDepth') return false; c.depth = v; return true; });
    }
    case 'phaser': {
      const ph = new Tone.Phaser({ frequency: p.rate, octaves: p.octaves, baseFrequency: p.base, wet: p.wet });
      return simple('phaser', ph, (q) => { ph.frequency.rampTo(q.rate, 0.05); ph.octaves = q.octaves; ph.baseFrequency = q.base; ph.wet.rampTo(q.wet, 0.05); });
    }
    case 'tremolo': {
      const tr = new Tone.Tremolo({ frequency: p.rate, depth: p.depth, wet: p.wet, spread: 0 }).start();
      return simple('tremolo', tr, (q) => { tr.frequency.rampTo(q.rate, 0.05); tr.depth.rampTo(q.depth, 0.05); tr.wet.rampTo(q.wet, 0.05); },
        (t, v, time) => { if (t !== 'tremoloRate') return false; tr.frequency.setTargetAtTime(0.2 + v * 14, time, 0.08); return true; });
    }
    case 'autopan': {
      const ap = new Tone.AutoPanner({ frequency: p.rate, depth: p.depth, wet: p.wet }).start();
      return simple('autopan', ap, (q) => { ap.frequency.rampTo(q.rate, 0.05); ap.depth.rampTo(q.depth, 0.05); ap.wet.rampTo(q.wet, 0.05); });
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
      return createAtmosSweep(p);
  }
}

/** Atmospheric Sweep: slow stereo auto-pan → modulated phase + chorus → large diffuse reverb with
 *  feedback ambience → sweeping tonal filter, blended behind the clean signal. Original configuration
 *  built from stock Tone.js nodes. */
function createAtmosSweep(p: Record<string, number>): FxUnit {
  const input = new Tone.Gain();
  const xf = new Tone.CrossFade(p.mix);
  const pan = new Tone.AutoPanner({ frequency: p.speed * 0.5, depth: p.spread, wet: 1 }).start();
  const phaser = new Tone.Phaser({ frequency: p.speed, octaves: 1 + p.depth * 4, baseFrequency: 280, wet: 0.6 });
  const chorus = new Tone.Chorus({ frequency: p.speed * 3, depth: 0.4 + p.depth * 0.6, delayTime: 6, wet: 0.6, spread: 180 }).start();
  const fb = new Tone.FeedbackDelay({ delayTime: 0.61, feedback: p.feedback, wet: 0.35, maxDelay: 1.5 });
  const verb = new Tone.Reverb({ decay: p.size, preDelay: 0.04, wet: 0.85 });
  const sweep = new Tone.AutoFilter({ frequency: p.speed * 0.7, octaves: 1 + p.filterMove * 4.5, baseFrequency: 180, wet: 1, filter: { type: 'lowpass', rolloff: -12, Q: 1.5 } }).start();
  const wetTrim = new Tone.Gain(1.4);
  input.connect(xf.a);
  input.chain(pan, phaser, chorus, fb, verb, sweep, wetTrim, xf.b);
  let size = p.size;
  const nodes = [input, xf, pan, phaser, chorus, fb, verb, sweep, wetTrim];
  return {
    type: 'atmosSweep', input, output: xf, ready: verb.ready.then(() => undefined),
    set: (q) => {
      xf.fade.rampTo(q.mix, 0.1);
      pan.frequency.rampTo(q.speed * 0.5, 0.1);
      pan.depth.rampTo(q.spread, 0.1);
      phaser.frequency.rampTo(q.speed, 0.1);
      phaser.octaves = 1 + q.depth * 4;
      chorus.frequency.rampTo(q.speed * 3, 0.1);
      chorus.depth = 0.4 + q.depth * 0.6;
      fb.feedback.rampTo(q.feedback, 0.1);
      sweep.frequency.rampTo(q.speed * 0.7, 0.1);
      sweep.octaves = 1 + q.filterMove * 4.5;
      if (Math.abs(q.size - size) > 0.1) { size = q.size; verb.decay = q.size; }
    },
    mod: (t, v, time) => {
      if (t === 'sweepDepth') { xf.fade.setTargetAtTime(v, time, 0.1); return true; }
      if (t === 'delayFeedback') { fb.feedback.setTargetAtTime(v * 0.85, time, 0.1); return true; }
      return false;
    },
    dispose: () => nodes.forEach((n) => n.dispose()),
  };
}

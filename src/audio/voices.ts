// Per-note voices built from native Web Audio nodes. A voice is created for each note and
// discarded when it ends, so there is no voice pool to leak and nothing can stay stuck:
// every source is given an explicit stop time when the note is scheduled.
// The same code runs in the live AudioContext and in an OfflineAudioContext for WAV export.

import type { DrumVoice, SynthPatch } from '../core/types';
import { defaultImageParams } from './imageSynth';

export interface Voice {
  start: number;
  /** scheduled end of the audible tail (Infinity while a held note is down) */
  end: number;
  midi: number;
  release(t: number): void;
  kill(t: number): void;
}

/** Channel modulation buses an Image Synth voice listens to while it sounds (audio/graph.ts). */
export type BusName = 'morph' | 'detune' | 'fmDepth' | 'noise' | 'lfoRate' | 'lfoDepth' | 'tremolo';

export interface VoiceOpts {
  /** multiplier applied to the patch cutoff (from automation / image modulation) */
  cutoffMul?: number;
  /** previous MIDI note for mono glide */
  glideFrom?: number;
  /** per-note overrides read from lanes at the onset */
  attack?: number;
  release?: number;
  fmRatio?: number;
  /** 0..1 per-note timbre (Image Synth: wave balance and brightness) */
  timbre?: number;
  /** continuous pitch: [beats after onset, semitones] */
  bend?: [number, number][];
  /** seconds per beat (for bend timing) and how many beats of the note were skipped (chase) */
  spb?: number;
  bendOffset?: number;
  /** live modulation sources; absent = static patch values */
  bus?: (name: BusName) => AudioNode | null;
}

const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();
function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let b = noiseBuffers.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = b.getChannelData(0);
    // deterministic noise so offline renders are reproducible
    let s = 22222;
    for (let i = 0; i < d.length; i++) { s = (s * 16807) % 2147483647; d[i] = (s / 2147483647) * 2 - 1; }
    noiseBuffers.set(ctx, b);
  }
  return b;
}

const crushCurves = new Map<number, Float32Array<ArrayBuffer>>();
export function crushCurve(bits: number): Float32Array<ArrayBuffer> {
  const k = Math.round(bits * 2) / 2;
  let c = crushCurves.get(k);
  if (!c) {
    c = new Float32Array(4096);
    const levels = Math.pow(2, k - 1);
    for (let i = 0; i < c.length; i++) {
      const x = (i / (c.length - 1)) * 2 - 1;
      c[i] = Math.round(x * levels) / levels;
    }
    crushCurves.set(k, c);
  }
  return c;
}

export const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
export const dbToGain = (db: number) => Math.pow(10, db / 20);

function velGain(p: SynthPatch, vel: number) {
  return 1 - p.velSens + p.velSens * Math.pow(Math.max(0, Math.min(1, vel)), 1.4);
}

interface Built {
  sources: AudioScheduledSourceNode[];
  amp: GainNode;
  /** detune params that follow per-note pitch bends */
  pitch: AudioParam[];
  filter?: BiquadFilterNode;
  /** called with the gate-off time to schedule the release stage; returns tail length */
  onRelease: (t: number) => number;
  /** earliest time a release may start (end of attack) */
  attackEnd: number;
}

/** Linear attack to `peak`, then exponential decay to the sustain level. When the gate closes
 *  inside the attack (known up front), the ramp is truncated so there is no discontinuity. */
function envAttack(param: AudioParam, t: number, a: number, d: number, s: number, peak: number, gateOff?: number) {
  param.setValueAtTime(0, t);
  const aa = Math.max(0.001, a);
  if (gateOff !== undefined && gateOff < t + aa) {
    param.linearRampToValueAtTime(peak * ((gateOff - t) / aa), Math.max(t + 0.001, gateOff));
    return;
  }
  param.linearRampToValueAtTime(peak, t + aa);
  param.setTargetAtTime(s * peak, t + aa, Math.max(0.005, d / 4));
}

function makeLfo(ctx: BaseAudioContext, p: SynthPatch, t: number, sources: AudioScheduledSourceNode[]): AudioNode | null {
  if (p.lfo.dest === 'none' || p.lfo.depth <= 0) return null;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = Math.max(0.01, p.lfo.rate);
  lfo.start(t);
  sources.push(lfo);
  return lfo;
}

function buildSub(ctx: BaseAudioContext, p: SynthPatch, midi: number, vel: number, t: number, out: AudioNode, o: VoiceOpts, gateOff?: number): Built {
  const f = mtof(midi);
  const sources: AudioScheduledSourceNode[] = [];
  const mix = ctx.createGain();
  const oscs: OscillatorNode[] = [];
  const u = Math.max(1, Math.min(6, Math.round(p.unison)));
  const addOsc = (wave: OscillatorType, freq: number, detune: number, level: number) => {
    if (level <= 0.001) return;
    const osc = ctx.createOscillator();
    osc.type = wave;
    osc.frequency.value = freq;
    osc.detune.value = detune;
    const g = ctx.createGain();
    g.gain.value = level;
    osc.connect(g).connect(mix);
    osc.start(t);
    sources.push(osc);
    oscs.push(osc);
  };
  for (let i = 0; i < u; i++) {
    const off = u === 1 ? 0 : (i / (u - 1) - 0.5) * 2 * p.spread;
    addOsc(p.osc1.wave, f, p.osc1.detune + off, p.osc1.level / Math.sqrt(u));
    addOsc(p.osc2.wave, f * Math.pow(2, p.osc2.semi / 12), p.osc2.detune - off, p.osc2.level / Math.sqrt(u));
  }
  addOsc('square', f / 2, 0, p.sub * 0.6);
  if (p.noise > 0.001) {
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx);
    n.loop = true;
    const g = ctx.createGain();
    g.gain.value = p.noise;
    n.connect(g).connect(mix);
    n.start(t, (midi * 0.0137) % 1.5);
    sources.push(n);
  }
  // glide / pitch envelope act on every oscillator's frequency
  for (const osc of oscs) {
    const target = osc.frequency.value;
    if (o.glideFrom !== undefined && p.glide > 0 && o.glideFrom !== midi) {
      osc.frequency.setValueAtTime(target * Math.pow(2, (o.glideFrom - midi) / 12), t);
      osc.frequency.exponentialRampToValueAtTime(target, t + p.glide);
    } else if (p.pitchEnv.amount) {
      osc.frequency.setValueAtTime(target * Math.pow(2, p.pitchEnv.amount), t);
      osc.frequency.exponentialRampToValueAtTime(target, t + Math.max(0.005, p.pitchEnv.time));
    }
  }
  mix.gain.value = 1 / Math.max(1, Math.sqrt(oscs.length * 0.6));
  return finishChain(ctx, p, midi, vel, t, mix, sources, oscs, out, o, gateOff);
}

/** Shared filter + filter envelope + amp envelope + LFO routing. */
function finishChain(
  ctx: BaseAudioContext, p: SynthPatch, midi: number, vel: number, t: number, src: AudioNode,
  sources: AudioScheduledSourceNode[], pitchTargets: OscillatorNode[], out: AudioNode, o: VoiceOpts, gateOff?: number,
): Built {
  const nyq = ctx.sampleRate * 0.45;
  if (o.attack !== undefined || o.release !== undefined) p = { ...p, amp: { ...p.amp, a: o.attack ?? p.amp.a, r: o.release ?? p.amp.r } };
  const filter = ctx.createBiquadFilter();
  filter.type = p.filter.type;
  filter.Q.value = Math.max(0.0001, p.filter.res);
  const base = Math.min(nyq, Math.max(20, p.filter.cutoff * Math.pow(2, (p.filter.keyTrack * (midi - 60)) / 12) * (o.cutoffMul ?? 1)));
  const vg = velGain(p, vel);
  if (p.filter.envAmt > 0.01) {
    const peak = Math.min(nyq, base * Math.pow(2, p.filter.envAmt * (0.6 + 0.4 * vg)));
    const sus = Math.min(nyq, base * Math.pow(2, p.filter.envAmt * p.fenv.s));
    filter.frequency.setValueAtTime(base, t);
    filter.frequency.exponentialRampToValueAtTime(peak, t + Math.max(0.002, p.fenv.a));
    filter.frequency.setTargetAtTime(sus, t + Math.max(0.002, p.fenv.a), Math.max(0.005, p.fenv.d / 4));
  } else {
    filter.frequency.value = base;
  }
  const amp = ctx.createGain();
  const peak = 0.85 * vg * dbToGain(p.gain);
  envAttack(amp.gain, t, p.amp.a, p.amp.d, p.amp.s, peak, gateOff);
  src.connect(filter).connect(amp);
  let tail: AudioNode = amp;

  const lfo = makeLfo(ctx, p, t, sources);
  if (lfo) {
    const depth = ctx.createGain();
    lfo.connect(depth);
    switch (p.lfo.dest) {
      case 'pitch':
        depth.gain.value = p.lfo.depth * 100;
        for (const osc of pitchTargets) depth.connect(osc.detune);
        break;
      case 'filter':
        depth.gain.value = p.lfo.depth * 2400;
        depth.connect(filter.detune);
        break;
      case 'amp': {
        const trem = ctx.createGain();
        trem.gain.value = 1 - p.lfo.depth / 2;
        depth.gain.value = p.lfo.depth / 2;
        depth.connect(trem.gain);
        amp.connect(trem);
        tail = trem;
        break;
      }
      case 'pan': {
        const pan = ctx.createStereoPanner();
        depth.gain.value = Math.min(1, p.lfo.depth);
        depth.connect(pan.pan);
        amp.connect(pan);
        tail = pan;
        break;
      }
    }
  }
  tail.connect(out);
  const aEnd = t + Math.max(0.001, p.amp.a);
  return {
    sources,
    amp,
    pitch: pitchTargets.map((x) => x.detune),
    filter,
    attackEnd: aEnd,
    onRelease: (tOff) => {
      const r = Math.max(0.01, p.amp.r);
      amp.gain.setTargetAtTime(0, tOff, r / 5);
      if (p.filter.envAmt > 0.01) filter.frequency.setTargetAtTime(base, tOff, Math.max(0.005, p.fenv.r / 4));
      return r * 1.6 + 0.03;
    },
  };
}

function buildFm(ctx: BaseAudioContext, p: SynthPatch, midi: number, vel: number, t: number, out: AudioNode, o: VoiceOpts, gateOff?: number): Built {
  const f = mtof(midi);
  const sources: AudioScheduledSourceNode[] = [];
  const mix = ctx.createGain();
  const mod = ctx.createOscillator();
  mod.frequency.value = f * p.fm.ratio;
  const modGain = ctx.createGain();
  const vg = velGain(p, vel);
  const dev = p.fm.index * f * p.fm.ratio * (0.5 + 0.5 * vg);
  modGain.gain.setValueAtTime(dev, t);
  modGain.gain.setTargetAtTime(dev * p.fm.modSustain, t + 0.002, Math.max(0.01, p.fm.modDecay / 4));
  mod.connect(modGain);
  mod.start(t);
  sources.push(mod);
  const carriers: OscillatorNode[] = [];
  const u = Math.max(1, Math.min(4, Math.round(p.unison)));
  for (let i = 0; i < u; i++) {
    const c = ctx.createOscillator();
    c.type = p.osc1.wave;
    c.frequency.value = f;
    c.detune.value = u === 1 ? p.osc1.detune : (i / (u - 1) - 0.5) * 2 * p.spread;
    modGain.connect(c.frequency);
    c.connect(mix);
    c.start(t);
    sources.push(c);
    carriers.push(c);
  }
  if (p.noise > 0.001) {
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx);
    n.loop = true;
    const g = ctx.createGain();
    g.gain.value = p.noise;
    n.connect(g).connect(mix);
    n.start(t);
    sources.push(n);
  }
  mix.gain.value = p.osc1.level / Math.sqrt(u);
  const built = finishChain(ctx, p, midi, vel, t, mix, sources, [...carriers, mod], out, o, gateOff);
  const rel = built.onRelease;
  built.onRelease = (tOff) => {
    modGain.gain.setTargetAtTime(0, tOff, Math.max(0.01, p.amp.r / 5));
    return rel(tOff);
  };
  return built;
}

function buildModal(ctx: BaseAudioContext, p: SynthPatch, midi: number, vel: number, t: number, out: AudioNode, o: VoiceOpts, gateOff?: number): Built {
  const f = mtof(midi);
  const sources: AudioScheduledSourceNode[] = [];
  const mix = ctx.createGain();
  const partialGains: GainNode[] = [];
  const partials: OscillatorNode[] = [];
  const nyq = ctx.sampleRate * 0.45;
  p.modal.ratios.forEach((ratio, i) => {
    if (f * ratio > nyq) return;
    const osc = ctx.createOscillator();
    partials.push(osc);
    osc.frequency.value = f * ratio;
    const g = ctx.createGain();
    const w = 1 / (1 + i * 0.9);
    const decay = Math.max(0.02, p.amp.d * (p.modal.decays[i] ?? 0.5));
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(w, t + Math.max(0.001, p.amp.a));
    g.gain.setTargetAtTime(w * p.amp.s, t + Math.max(0.001, p.amp.a), decay / 4);
    osc.connect(g).connect(mix);
    osc.start(t);
    sources.push(osc);
    partialGains.push(g);
  });
  if (p.modal.strike > 0) {
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = Math.min(nyq, f * 3);
    bp.Q.value = 2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(p.modal.strike, t);
    g.gain.setTargetAtTime(0, t, 0.006);
    n.connect(bp).connect(g).connect(mix);
    n.start(t, (midi * 0.031) % 1.5, 0.08);
    sources.push(n);
  }
  mix.gain.value = 0.8;
  // the voice-level envelope is a gate; the partials carry their own decays
  const gateP = { ...p, amp: { a: 0.001, d: 0.1, s: 1, r: p.amp.r }, filter: { ...p.filter, envAmt: 0 } };
  return finishChain(ctx, gateP, midi, vel, t, mix, sources, partials, out, { ...o, attack: undefined }, gateOff);
}

const waveCache = new WeakMap<BaseAudioContext, Map<string, PeriodicWave>>();
function periodicWave(ctx: BaseAudioContext, amps: number[]): PeriodicWave {
  let m = waveCache.get(ctx);
  if (!m) { m = new Map(); waveCache.set(ctx, m); }
  const key = amps.join(',');
  let w = m.get(key);
  if (!w) {
    // Schroeder phases: same magnitude spectrum, but the partials no longer line up into a
    // sawtooth-like vertical edge every cycle (lower crest factor, no per-period spike)
    const real = new Float32Array(amps.length + 1);
    const imag = new Float32Array(amps.length + 1);
    const N = amps.length;
    amps.forEach((a, k) => {
      const ph = (Math.PI * k * (k + 1)) / Math.max(1, N);
      real[k + 1] = a * Math.sin(ph);
      imag[k + 1] = a * Math.cos(ph);
    });
    w = ctx.createPeriodicWave(real, imag);
    m.set(key, w);
  }
  return w;
}

/** IMAGE SYNTH voice: wavetable A ↔ B morph (both read from the image), FM, band-passed noise,
 *  an LFO for filter wobble and tremolo. Each live parameter sums a static base with the
 *  channel's modulation bus, so lanes reshape a held note while it sounds. */
function buildImage(ctx: BaseAudioContext, p: SynthPatch, midi: number, vel: number, t: number, out: AudioNode, o: VoiceOpts, gateOff?: number): Built {
  const ip = p.image ?? defaultImageParams();
  const f = mtof(midi);
  const nyq = ctx.sampleRate * 0.45;
  const sources: AudioScheduledSourceNode[] = [];
  const bus = (n: BusName) => o.bus?.(n) ?? null;
  const scaled = (src: AudioNode, k: number, dest: AudioParam) => { const g = ctx.createGain(); g.gain.value = k; src.connect(g).connect(dest); };
  // keep every partial AND its FM sidebands below Nyquist (≈ (index + 1) · ratio · f either side
  // of each harmonic, at the bus's maximum index of 3) — aliased FM grit sounds like clicks
  const ratio = o.fmRatio ?? ip.fmRatio;
  const maxH = Math.max(1, Math.floor(nyq / f - 4 * ratio));
  const tableA = periodicWave(ctx, ip.wavesA.slice(0, maxH));
  const tableB = periodicWave(ctx, ip.wavesB.slice(0, maxH));
  const oscA = ctx.createOscillator();
  const oscB = ctx.createOscillator();
  oscA.setPeriodicWave(tableA);
  oscB.setPeriodicWave(tableB);
  oscA.frequency.value = f;
  oscB.frequency.value = f;
  const tOff = ((o.timbre ?? 0.5) - 0.5) * 0.4; // thicker contours lean to the brighter table
  const gA = ctx.createGain();
  const gB = ctx.createGain();
  const mMorph = bus('morph');
  if (mMorph) {
    gA.gain.value = 1 - tOff;
    gB.gain.value = tOff;
    mMorph.connect(gB.gain);
    scaled(mMorph, -1, gA.gain);
  } else {
    const m = Math.max(0, Math.min(1, ip.morph + tOff));
    gA.gain.value = 1 - m;
    gB.gain.value = m;
  }
  const mDet = bus('detune');
  if (mDet) { scaled(mDet, -0.5, oscA.detune); scaled(mDet, 0.5, oscB.detune); }
  else { oscA.detune.value = -ip.detune / 2; oscB.detune.value = ip.detune / 2; }
  const mix = ctx.createGain();
  mix.gain.value = 0.9;
  oscA.connect(gA).connect(mix);
  oscB.connect(gB).connect(mix);
  // FM: one sine modulator on both tables
  const mod = ctx.createOscillator();
  mod.frequency.value = f * ratio;
  const modGain = ctx.createGain();
  const vg = velGain(p, vel);
  const mFm = bus('fmDepth');
  const dev = f * ratio * (0.6 + 0.4 * vg);
  if (mFm) { modGain.gain.value = 0; scaled(mFm, dev, modGain.gain); }
  else modGain.gain.value = ip.fmDepth * dev;
  mod.connect(modGain);
  modGain.connect(oscA.frequency);
  modGain.connect(oscB.frequency);
  // noise, band-passed around the note
  const nz = ctx.createBufferSource();
  nz.buffer = noiseBuffer(ctx);
  nz.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = Math.min(nyq, f * 3);
  bp.Q.value = 1.2;
  const nG = ctx.createGain();
  const mNoise = bus('noise');
  if (mNoise) { nG.gain.value = 0; scaled(mNoise, 2.5, nG.gain); }
  else nG.gain.value = ip.noise * 2.5;
  nz.connect(bp).connect(nG).connect(mix);
  // LFO → tremolo (before the filter: amplitude modulation commutes) and filter wobble
  const lfo = ctx.createOscillator();
  const mRate = bus('lfoRate');
  if (mRate) { lfo.frequency.value = 0; mRate.connect(lfo.frequency); }
  else lfo.frequency.value = ip.lfoRate;
  const trem = ctx.createGain();
  const tremDepth = ctx.createGain();
  const mTrem = bus('tremolo');
  if (mTrem) { trem.gain.value = 1; tremDepth.gain.value = 0; scaled(mTrem, 0.5, tremDepth.gain); scaled(mTrem, -0.5, trem.gain); }
  else { trem.gain.value = 1 - ip.tremolo / 2; tremDepth.gain.value = ip.tremolo / 2; }
  lfo.connect(tremDepth).connect(trem.gain);
  mix.connect(trem);
  for (const src of [oscA, oscB, mod, nz, lfo]) { src.start(t); sources.push(src); }
  const built = finishChain(ctx, p, midi, vel, t, trem, sources, [oscA, oscB, mod], out, { ...o, cutoffMul: (o.cutoffMul ?? 1) * Math.pow(2, ((o.timbre ?? 0.5) - 0.5) * 1.2) }, gateOff);
  const wob = ctx.createGain();
  const mDepth = bus('lfoDepth');
  if (mDepth) { wob.gain.value = 0; scaled(mDepth, 1200, wob.gain); }
  else wob.gain.value = ip.lfoDepth * 1200;
  lfo.connect(wob);
  if (built.filter) wob.connect(built.filter.detune);
  return built;
}

function buildNoise(ctx: BaseAudioContext, p: SynthPatch, midi: number, vel: number, t: number, out: AudioNode, o: VoiceOpts, gateOff?: number): Built {
  const sources: AudioScheduledSourceNode[] = [];
  const n = ctx.createBufferSource();
  n.buffer = noiseBuffer(ctx);
  n.loop = true;
  n.start(t, (midi * 0.0213) % 1.5);
  sources.push(n);
  const g = ctx.createGain();
  // a resonant band-pass keeps only a sliver of white noise's energy; make up for it
  g.gain.value = 2 + Math.max(1, p.filter.res) * 0.9;
  n.connect(g);
  // pitch selects the noise band: keyTrack 1 follows the note fully
  return finishChain(ctx, p, midi, vel, t, g, sources, [], out, o, gateOff);
}

function buildGlitch(ctx: BaseAudioContext, p: SynthPatch, midi: number, vel: number, t: number, out: AudioNode, o: VoiceOpts): Built {
  const sources: AudioScheduledSourceNode[] = [];
  const f = mtof(midi);
  const mix = ctx.createGain();
  const kind = ((midi % 4) + 4) % 4;
  const dec = Math.max(0.01, p.amp.d);
  const env = ctx.createGain();
  env.gain.value = 0;
  if (kind === 0) {
    // bit-crushed square blip with a fast pitch drop
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(f * 4, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(30, f), t + 0.03);
    const ws = ctx.createWaveShaper();
    ws.curve = crushCurve(3);
    osc.connect(ws).connect(env);
    env.gain.setValueAtTime(0.7, t);
    env.gain.setTargetAtTime(0, t + 0.004, dec / 3);
    osc.start(t);
    sources.push(osc);
  } else if (kind === 1) {
    // stuttered noise grains
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx);
    n.connect(env);
    const gap = 0.012 + (midi % 7) * 0.004;
    for (let i = 0; i < 4; i++) {
      env.gain.setValueAtTime(0.8 * (1 - i * 0.2), t + i * gap);
      env.gain.setValueAtTime(0, t + i * gap + gap * 0.45);
    }
    n.start(t, (midi * 0.017) % 1.5);
    sources.push(n);
  } else if (kind === 2) {
    // FM chirp: modulation ratio sweeps down
    const c = ctx.createOscillator();
    const m = ctx.createOscillator();
    const mg = ctx.createGain();
    c.frequency.value = f * 2;
    m.frequency.setValueAtTime(f * 16, t);
    m.frequency.exponentialRampToValueAtTime(f * 0.5, t + dec);
    mg.gain.value = f * 6;
    m.connect(mg).connect(c.frequency);
    c.connect(env);
    env.gain.setValueAtTime(0.6, t);
    env.gain.setTargetAtTime(0, t + 0.003, dec / 2.5);
    c.start(t);
    m.start(t);
    sources.push(c, m);
  } else {
    // digital click
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2000 + (midi % 12) * 500;
    n.connect(hp).connect(env);
    env.gain.setValueAtTime(1, t);
    env.gain.setTargetAtTime(0, t + 0.001, 0.0025);
    n.start(t, (midi * 0.011) % 1.5, 0.05);
    sources.push(n);
  }
  env.connect(mix);
  mix.gain.value = 2.2;
  const gateP = { ...p, amp: { a: 0.0005, d: 1, s: 1, r: 0.05 }, filter: { ...p.filter, envAmt: 0 }, lfo: { ...p.lfo, dest: 'none' as const } };
  const b = finishChain(ctx, gateP, midi, vel, t, mix, sources, [], out, o);
  const rel = b.onRelease;
  b.onRelease = (tOff) => Math.max(rel(tOff), dec * 2 + 0.05 - (tOff - t));
  return b;
}

const DRUM_MAP: Record<number, DrumVoice> = { 35: 'kick', 36: 'kick', 37: 'click', 38: 'snare', 40: 'snare', 39: 'noise', 42: 'chh', 44: 'chh', 46: 'ohh', 56: 'metal' };
export function drumVoiceFor(midi: number): DrumVoice {
  if (DRUM_MAP[midi]) return DRUM_MAP[midi];
  const order: DrumVoice[] = ['kick', 'click', 'snare', 'noise', 'chh', 'ohh', 'metal'];
  return order[((midi % 7) + 7) % 7];
}

function buildDrum(ctx: BaseAudioContext, p: SynthPatch, midi: number, vel: number, t: number, out: AudioNode): Built {
  const voice = drumVoiceFor(midi);
  const dp = p.drums[voice];
  const sources: AudioScheduledSourceNode[] = [];
  const amp = ctx.createGain();
  const level = dp.level * velGain(p, vel) * dbToGain(p.gain) * 2.2;
  const decay = 0.03 + dp.decay * 0.6;
  const tone = dp.tone;
  const noise = () => {
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx);
    n.start(t, ((midi * 37 + Math.round(t * 1000)) % 1400) / 1000, 1);
    sources.push(n);
    return n;
  };
  let tail = decay;
  switch (voice) {
    case 'kick': {
      const osc = ctx.createOscillator();
      const f0 = 38 + tone * 30;
      osc.frequency.setValueAtTime(f0 * 3.2, t);
      osc.frequency.exponentialRampToValueAtTime(f0, t + 0.045);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(level, t + 0.002);
      g.gain.setTargetAtTime(0, t + 0.01, (0.08 + dp.decay * 0.45) / 3);
      osc.connect(g).connect(amp);
      osc.start(t);
      sources.push(osc);
      const c = noise();
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 3000;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(level * 0.25, t);
      cg.gain.setTargetAtTime(0, t, 0.003);
      c.connect(hp).connect(cg).connect(amp);
      tail = 0.08 + dp.decay * 0.6;
      break;
    }
    case 'snare': {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(240 + tone * 80, t);
      osc.frequency.exponentialRampToValueAtTime(160 + tone * 40, t + 0.03);
      const og = ctx.createGain();
      og.gain.setValueAtTime(level * 0.5, t);
      og.gain.setTargetAtTime(0, t, 0.04);
      osc.connect(og).connect(amp);
      osc.start(t);
      sources.push(osc);
      const n = noise();
      const bp = ctx.createBiquadFilter();
      bp.type = 'highpass';
      bp.frequency.value = 1200 + tone * 2400;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(level * 0.8, t);
      ng.gain.setTargetAtTime(0, t + 0.002, decay / 3.5);
      n.connect(bp).connect(ng).connect(amp);
      break;
    }
    case 'chh':
    case 'ohh':
    case 'metal': {
      // six detuned square partials (the classic analogue metal recipe), band-passed
      const ratios = voice === 'metal' ? [1, 1.483, 1.932, 2.546] : [2.0, 3.0, 4.16, 5.43, 6.79, 8.21];
      const base = voice === 'metal' ? 420 + tone * 500 : 160 + tone * 120;
      const mix = ctx.createGain();
      mix.gain.value = 0.25;
      for (const r of ratios) {
        const o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = base * r;
        o.connect(mix);
        o.start(t);
        sources.push(o);
      }
      const bp = ctx.createBiquadFilter();
      bp.type = voice === 'metal' ? 'bandpass' : 'highpass';
      bp.frequency.value = voice === 'metal' ? 1800 + tone * 2000 : 6500 + tone * 3000;
      bp.Q.value = voice === 'metal' ? 3 : 0.8;
      const g = ctx.createGain();
      const d = voice === 'chh' ? 0.02 + dp.decay * 0.08 : voice === 'ohh' ? 0.15 + dp.decay * 0.6 : 0.1 + dp.decay * 0.7;
      g.gain.setValueAtTime(level * (voice === 'metal' ? 0.6 : 0.5), t);
      g.gain.setTargetAtTime(0, t + 0.001, d / 3);
      mix.connect(bp).connect(g).connect(amp);
      tail = d * 1.6;
      break;
    }
    case 'click': {
      const n = noise();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1500 + tone * 4000;
      bp.Q.value = 4;
      const g = ctx.createGain();
      g.gain.setValueAtTime(level * 1.5, t);
      g.gain.setTargetAtTime(0, t, 0.004 + dp.decay * 0.01);
      n.connect(bp).connect(g).connect(amp);
      tail = 0.08;
      break;
    }
    case 'noise': {
      const n = noise();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 1.2;
      bp.frequency.setValueAtTime(800 + tone * 3000, t);
      bp.frequency.exponentialRampToValueAtTime(400 + tone * 1000, t + decay);
      const g = ctx.createGain();
      g.gain.setValueAtTime(level * 0.9, t);
      g.gain.setTargetAtTime(0, t + 0.002, decay / 3);
      n.connect(bp).connect(g).connect(amp);
      break;
    }
  }
  amp.gain.value = 1;
  amp.connect(out);
  return { sources, amp, pitch: [], attackEnd: t, onRelease: () => tail + 0.05 };
}

/** Continuous pitch along a contour: each detune param ramps through the bend points. Points
 *  before `offset` (a chased note) are skipped; nothing is scheduled past the gate. */
function applyBend(params: AudioParam[], bend: [number, number][], t: number, spb: number, offset: number, gateOff?: number) {
  const at = (b: number) => {
    if (b <= bend[0][0]) return bend[0][1];
    for (let i = 1; i < bend.length; i++) if (bend[i][0] >= b) { const a = bend[i - 1], z = bend[i]; return a[1] + ((z[1] - a[1]) * (b - a[0])) / Math.max(1e-9, z[0] - a[0]); }
    return bend[bend.length - 1][1];
  };
  const end = gateOff ?? Infinity;
  for (const prm of params) {
    const base = prm.value;
    prm.setValueAtTime(base + at(offset) * 100, t);
    for (const [bt, st] of bend) {
      if (bt <= offset) continue;
      const tt = t + (bt - offset) * spb;
      if (tt > end + 0.05) break;
      prm.linearRampToValueAtTime(base + st * 100, tt);
    }
  }
}

/** Start a voice. If `dur` is given the gate closes at time+dur (sequenced notes); otherwise
 *  the voice is held until release() (live MIDI / computer keyboard). */
export function startVoice(ctx: BaseAudioContext, out: AudioNode, p: SynthPatch, midi: number, vel: number, time: number, dur?: number, o: VoiceOpts = {}): Voice {
  const kill = ctx.createGain();
  kill.connect(out);
  const gateOff = dur !== undefined ? time + Math.max(0.01, dur) : undefined;
  let b: Built;
  switch (p.engine) {
    case 'fm': b = buildFm(ctx, p, midi, vel, time, kill, o, gateOff); break;
    case 'modal': b = buildModal(ctx, p, midi, vel, time, kill, o, gateOff); break;
    case 'noise': b = buildNoise(ctx, p, midi, vel, time, kill, o, gateOff); break;
    case 'glitch': b = buildGlitch(ctx, p, midi, vel, time, kill, o); break;
    case 'drums': b = buildDrum(ctx, p, midi, vel, time, kill); break;
    case 'image': b = buildImage(ctx, p, midi, vel, time, kill, o, gateOff); break;
    default: b = buildSub(ctx, p, midi, vel, time, kill, o, gateOff);
  }
  if (o.bend && o.bend.length > 1 && b.pitch.length) applyBend(b.pitch, o.bend, time, o.spb ?? 0.5, o.bendOffset ?? 0, gateOff);
  const stopAll = (t: number) => {
    for (const s of b.sources) { try { s.stop(t); } catch { /* already stopped */ } }
  };
  const v: Voice = {
    start: time,
    end: Infinity,
    midi,
    release(t: number) {
      if (v.end !== Infinity) return;
      const tOff = gateOff ?? Math.max(t, b.attackEnd);
      const tail = b.onRelease(tOff);
      v.end = tOff + tail;
      stopAll(v.end + 0.02);
    },
    kill(t: number) {
      const at = Math.max(t, time);
      kill.gain.setValueAtTime(1, at);
      kill.gain.linearRampToValueAtTime(0, at + 0.015);
      stopAll(at + 0.03);
      v.end = Math.min(v.end, at + 0.03);
    },
  };
  // disconnect everything once the last source ends (lets the GC collect the graph)
  let alive = b.sources.length;
  for (const s of b.sources) {
    s.onended = () => { if (--alive === 0) { try { kill.disconnect(); } catch { /* ignore */ } } };
  }
  if (gateOff !== undefined || p.engine === 'drums' || p.engine === 'glitch') v.release(gateOff ?? time);
  return v;
}

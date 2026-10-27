import type { DrumVoice, DrumVoiceParams, SynthPatch } from '../core/types';

const DRUMS: Record<DrumVoice, DrumVoiceParams> = {
  kick: { tone: 0.5, decay: 0.5, level: 0.9 },
  snare: { tone: 0.5, decay: 0.45, level: 0.7 },
  chh: { tone: 0.5, decay: 0.3, level: 0.45 },
  ohh: { tone: 0.5, decay: 0.5, level: 0.4 },
  click: { tone: 0.6, decay: 0.2, level: 0.5 },
  noise: { tone: 0.5, decay: 0.4, level: 0.5 },
  metal: { tone: 0.5, decay: 0.5, level: 0.45 },
};

export function basePatch(): SynthPatch {
  return {
    name: 'Init',
    engine: 'sub',
    osc1: { wave: 'sawtooth', detune: 0, level: 0.8 },
    osc2: { wave: 'square', semi: 0, detune: 7, level: 0 },
    sub: 0,
    noise: 0,
    unison: 1,
    spread: 12,
    fm: { ratio: 2, index: 2, modDecay: 0.4, modSustain: 0.3 },
    modal: { ratios: [1, 3.99, 10.6], decays: [1, 0.45, 0.2], strike: 0.3 },
    filter: { type: 'lowpass', cutoff: 2400, res: 1, envAmt: 1, keyTrack: 0.3 },
    amp: { a: 0.01, d: 0.3, s: 0.7, r: 0.4 },
    fenv: { a: 0.01, d: 0.4, s: 0.3, r: 0.4 },
    lfo: { rate: 0.5, depth: 0, dest: 'none' },
    pitchEnv: { amount: 0, time: 0.05 },
    glide: 0,
    velSens: 0.6,
    poly: 8,
    gain: 0,
    drums: structuredClone(DRUMS),
  };
}

type PatchPatch = { [K in keyof SynthPatch]?: SynthPatch[K] extends object ? Partial<SynthPatch[K]> : SynthPatch[K] };

export function makePatch(name: string, p: PatchPatch): SynthPatch {
  const b = basePatch();
  const out: any = { ...b, name };
  for (const [k, v] of Object.entries(p)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof (b as any)[k] === 'object' && !Array.isArray((b as any)[k])
      ? { ...(b as any)[k], ...v }
      : v;
  }
  return out as SynthPatch;
}

/** The twelve core instruments (+ drum kit). Each uses a different engine or a structurally different
 *  oscillator/envelope architecture — not the same synth with a different filter. */
export const INSTRUMENTS: SynthPatch[] = [
  makePatch('Warm Analog Pad', {
    engine: 'sub', osc1: { wave: 'sawtooth', level: 0.6 }, osc2: { wave: 'sawtooth', semi: 0, detune: 9, level: 0.5 },
    unison: 3, spread: 18, sub: 0.2, filter: { cutoff: 1100, res: 0.8, envAmt: 0.8, keyTrack: 0.2 },
    amp: { a: 1.4, d: 1.5, s: 0.85, r: 2.8 }, fenv: { a: 1.8, d: 2, s: 0.5, r: 2 }, lfo: { rate: 0.18, depth: 0.25, dest: 'filter' }, poly: 8, gain: -11,
  }),
  makePatch('Glassy Ambient Pad', {
    engine: 'fm', osc1: { wave: 'sine', level: 0.8 }, fm: { ratio: 3, index: 1.6, modDecay: 3, modSustain: 0.6 },
    unison: 2, spread: 8, filter: { type: 'highpass', cutoff: 220, res: 0.7, envAmt: 0, keyTrack: 0 },
    amp: { a: 1.8, d: 2, s: 0.8, r: 3.5 }, lfo: { rate: 4.5, depth: 0.08, dest: 'pitch' }, poly: 8, gain: -11,
  }),
  makePatch('Dark Drone', {
    engine: 'sub', osc1: { wave: 'square', level: 0.5 }, osc2: { wave: 'sawtooth', semi: -12, detune: 4, level: 0.5 },
    unison: 2, spread: 6, sub: 0.5, noise: 0.03, filter: { cutoff: 380, res: 2.5, envAmt: 0.4, keyTrack: 0 },
    amp: { a: 3, d: 2, s: 1, r: 5 }, fenv: { a: 4, d: 6, s: 0.6, r: 4 }, lfo: { rate: 0.07, depth: 0.5, dest: 'filter' }, poly: 4, gain: -9,
  }),
  makePatch('Sub Bass', {
    engine: 'sub', osc1: { wave: 'sine', level: 0.9 }, osc2: { wave: 'triangle', semi: 12, level: 0.15 }, sub: 0.3,
    filter: { cutoff: 260, res: 0.5, envAmt: 0.3, keyTrack: 0.5 }, amp: { a: 0.008, d: 0.4, s: 0.85, r: 0.25 }, poly: 1, glide: 0.03, gain: -3, velSens: 0.3,
  }),
  makePatch('Analog Mono Bass', {
    engine: 'sub', osc1: { wave: 'sawtooth', level: 0.75 }, osc2: { wave: 'square', semi: -12, detune: 3, level: 0.45 },
    filter: { cutoff: 420, res: 7, envAmt: 2.6, keyTrack: 0.4 }, amp: { a: 0.004, d: 0.35, s: 0.6, r: 0.15 }, fenv: { a: 0.003, d: 0.22, s: 0.15, r: 0.15 },
    poly: 1, glide: 0.05, gain: -6, velSens: 0.8,
  }),
  makePatch('Plucked Synth', {
    engine: 'sub', osc1: { wave: 'triangle', level: 0.7 }, osc2: { wave: 'sawtooth', semi: 12, detune: 5, level: 0.35 },
    filter: { cutoff: 600, res: 3, envAmt: 3.4, keyTrack: 0.6 }, amp: { a: 0.002, d: 0.45, s: 0, r: 0.35 }, fenv: { a: 0.001, d: 0.16, s: 0, r: 0.2 },
    pitchEnv: { amount: 0.25, time: 0.02 }, poly: 10, gain: -6,
  }),
  makePatch('Bell / FM Tone', {
    engine: 'fm', osc1: { wave: 'sine', level: 0.8 }, fm: { ratio: 3.5, index: 7, modDecay: 1.4, modSustain: 0.05 },
    filter: { cutoff: 12000, res: 0.5, envAmt: 0, keyTrack: 0 }, amp: { a: 0.002, d: 2.6, s: 0, r: 2.2 }, poly: 10, gain: -9,
  }),
  makePatch('Electric Keyboard', {
    engine: 'fm', osc1: { wave: 'sine', level: 0.85 }, fm: { ratio: 1, index: 3.2, modDecay: 0.35, modSustain: 0.12 },
    filter: { cutoff: 5200, res: 0.6, envAmt: 0, keyTrack: 0.4 }, amp: { a: 0.003, d: 1.8, s: 0.25, r: 0.6 },
    lfo: { rate: 4.2, depth: 0.22, dest: 'amp' }, poly: 10, gain: -7,
  }),
  makePatch('Digital Mallet', {
    engine: 'modal', modal: { ratios: [1, 3.99, 10.65, 2.01], decays: [1, 0.35, 0.12, 0.6], strike: 0.4 },
    filter: { cutoff: 9000, res: 0.5, envAmt: 0, keyTrack: 0 }, amp: { a: 0.001, d: 1.2, s: 0, r: 0.8 }, poly: 10, gain: -6,
  }),
  makePatch('Soft Arpeggio Synth', {
    engine: 'sub', osc1: { wave: 'square', level: 0.45 }, osc2: { wave: 'triangle', semi: 12, detune: -4, level: 0.4 },
    filter: { cutoff: 1500, res: 1.6, envAmt: 1.2, keyTrack: 0.5 }, amp: { a: 0.01, d: 0.25, s: 0.35, r: 0.3 }, fenv: { a: 0.005, d: 0.2, s: 0.2, r: 0.2 },
    lfo: { rate: 0.3, depth: 0.2, dest: 'filter' }, poly: 8, gain: -8,
  }),
  makePatch('Noise Percussion', {
    engine: 'noise', filter: { type: 'bandpass', cutoff: 2000, res: 6, envAmt: 1, keyTrack: 1 }, amp: { a: 0.001, d: 0.12, s: 0, r: 0.08 },
    fenv: { a: 0.001, d: 0.08, s: 0, r: 0.05 }, poly: 12, gain: -4, velSens: 0.9,
  }),
  makePatch('Glitch Percussion', {
    engine: 'glitch', filter: { cutoff: 7000, res: 2, envAmt: 0, keyTrack: 0 }, amp: { a: 0.001, d: 0.09, s: 0, r: 0.04 },
    osc1: { wave: 'square', level: 0.6 }, poly: 16, gain: -8, velSens: 0.8,
  }),
  makePatch('Drum Kit', { engine: 'drums', poly: 16, gain: -2, velSens: 0.85 }),
];

export function instrument(name: string): SynthPatch {
  return structuredClone([...INSTRUMENTS, ...FACTORY_PRESETS].find((p) => p.name === name) ?? INSTRUMENTS[0]);
}

/** Factory sound presets for experimental electronic composition. */
export const FACTORY_PRESETS: SynthPatch[] = [
  makePatch('Faded Tape Pad', {
    engine: 'sub', osc1: { wave: 'sawtooth', level: 0.5 }, osc2: { wave: 'triangle', semi: 12, detune: -6, level: 0.4 }, unison: 3, spread: 14,
    noise: 0.04, filter: { cutoff: 900, res: 0.6, envAmt: 0.5 }, amp: { a: 1.2, d: 2, s: 0.8, r: 3 }, lfo: { rate: 0.6, depth: 0.12, dest: 'pitch' }, gain: -11,
  }),
  makePatch('Frozen Glass', {
    engine: 'fm', osc1: { wave: 'sine', level: 0.7 }, fm: { ratio: 5.01, index: 2.2, modDecay: 4, modSustain: 0.4 }, unison: 2, spread: 5,
    filter: { type: 'highpass', cutoff: 400, res: 1 }, amp: { a: 2.5, d: 3, s: 0.7, r: 4 }, gain: -13,
  }),
  makePatch('Soft Machinery', {
    engine: 'sub', osc1: { wave: 'square', level: 0.5 }, osc2: { wave: 'square', semi: 7, detune: 3, level: 0.3 },
    filter: { cutoff: 700, res: 4, envAmt: 2, keyTrack: 0.5 }, amp: { a: 0.005, d: 0.18, s: 0.2, r: 0.12 }, fenv: { a: 0.002, d: 0.1, s: 0.1, r: 0.1 }, poly: 6, gain: -8,
  }),
  makePatch('Analog Haze', {
    engine: 'sub', osc1: { wave: 'sawtooth', level: 0.5 }, osc2: { wave: 'sawtooth', semi: 0, detune: 14, level: 0.5 }, unison: 4, spread: 24, sub: 0.15,
    filter: { cutoff: 1600, res: 1.2, envAmt: 0.6 }, amp: { a: 0.8, d: 1, s: 0.8, r: 2.4 }, lfo: { rate: 0.12, depth: 0.4, dest: 'pan' }, gain: -12,
  }),
  makePatch('Deep Current', {
    engine: 'sub', osc1: { wave: 'sine', level: 0.8 }, osc2: { wave: 'sawtooth', semi: 0, detune: 2, level: 0.18 }, sub: 0.4,
    filter: { cutoff: 320, res: 2, envAmt: 0.8, keyTrack: 0.3 }, amp: { a: 0.02, d: 0.6, s: 0.8, r: 0.6 }, lfo: { rate: 0.25, depth: 0.3, dest: 'filter' }, poly: 1, glide: 0.08, gain: -4,
  }),
  makePatch('Distant Chimes', {
    engine: 'modal', modal: { ratios: [1, 2.76, 5.4, 8.93], decays: [1, 0.6, 0.35, 0.2], strike: 0.15 }, amp: { a: 0.002, d: 3.5, s: 0, r: 3 }, gain: -10,
  }),
  makePatch('Hollow Pulse', {
    engine: 'sub', osc1: { wave: 'square', level: 0.6 }, osc2: { wave: 'square', semi: 12, detune: 0, level: 0.25 },
    filter: { type: 'bandpass', cutoff: 900, res: 3, envAmt: 0.8 }, amp: { a: 0.004, d: 0.22, s: 0.3, r: 0.2 }, poly: 8, gain: -6,
  }),
  makePatch('Broken Clock', { engine: 'glitch', amp: { a: 0.001, d: 0.05, s: 0, r: 0.03 }, filter: { cutoff: 5000, res: 4 }, gain: -8 }),
  makePatch('Dusty Keys', {
    engine: 'fm', osc1: { wave: 'triangle', level: 0.8 }, fm: { ratio: 1, index: 1.8, modDecay: 0.5, modSustain: 0.2 }, noise: 0.02,
    filter: { cutoff: 2400, res: 0.7 }, amp: { a: 0.004, d: 1.4, s: 0.3, r: 0.7 }, lfo: { rate: 0.4, depth: 0.08, dest: 'pitch' }, gain: -7,
  }),
  makePatch('Subterranean Drone', {
    engine: 'sub', osc1: { wave: 'sawtooth', level: 0.5 }, osc2: { wave: 'sawtooth', semi: -12, detune: 5, level: 0.6 }, sub: 0.6, unison: 2, spread: 4,
    filter: { cutoff: 220, res: 4, envAmt: 0.6 }, amp: { a: 4, d: 3, s: 1, r: 6 }, lfo: { rate: 0.05, depth: 0.6, dest: 'filter' }, poly: 3, gain: -9,
  }),
  makePatch('Microclicks', {
    engine: 'noise', filter: { type: 'highpass', cutoff: 5000, res: 2, envAmt: 0, keyTrack: 0.5 }, amp: { a: 0.0005, d: 0.02, s: 0, r: 0.01 }, gain: -6,
  }),
  makePatch('Metallic Bloom', {
    engine: 'fm', osc1: { wave: 'sine', level: 0.7 }, fm: { ratio: 1.414, index: 5, modDecay: 2.5, modSustain: 0.3 },
    filter: { cutoff: 6000, res: 1 }, amp: { a: 0.6, d: 2.5, s: 0.4, r: 3 }, gain: -12,
  }),
  makePatch('Night Bus Bass', {
    engine: 'sub', osc1: { wave: 'sawtooth', level: 0.6 }, osc2: { wave: 'sawtooth', semi: 0, detune: -8, level: 0.6 },
    filter: { cutoff: 300, res: 9, envAmt: 2.2, keyTrack: 0.3 }, amp: { a: 0.003, d: 0.25, s: 0.5, r: 0.12 }, fenv: { a: 0.002, d: 0.3, s: 0.1, r: 0.1 }, poly: 1, gain: -7,
  }),
  makePatch('Pale Organ', {
    engine: 'modal', modal: { ratios: [1, 2, 3, 4, 6], decays: [1, 1, 1, 1, 1], strike: 0 }, amp: { a: 0.05, d: 1, s: 0.9, r: 0.4 }, gain: -12,
  }),
];

export const ALL_PRESETS = [...INSTRUMENTS, ...FACTORY_PRESETS];

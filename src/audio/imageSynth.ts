// IMAGE SYNTH: the picture is a sound-design input, not just a note source.
//  - Two wavetables are read from the image: A from the region's luminance profile (rows bottom→top
//    become harmonics 1→N), B from its edge-density profile (detail → bright upper partials). The
//    oscillator morphs between them.
//  - Every other parameter (filter, resonance, spectral tilt, detune, FM, noise, attack, release,
//    LFO, tremolo, pan, delay feedback, reverb) is set by a reassignable feature → parameter
//    mapping. The image's average sets the starting patch; with EVOLUTION > 0 the same mapping,
//    read along the scan, becomes automation lanes that move sustained voices as the playhead
//    travels (channel modulation buses in audio/graph.ts), so a long scan is a long timbral journey.

import type { AutomationLane, FeatureKey, ImageSynthParams, ModTarget, SynthMapping, SynthPatch, SynthTarget } from '../core/types';
import { type Curve, type CurveKey, curveSummary, curveValue, EDGE_BINS, type FeatureGrid, type MaskFn } from '../analysis/features';
import { makePatch } from './patches';

export type SynthCharacter = 'voice' | 'pluck' | 'drone' | 'texture' | 'shimmer';

/** How each target is applied: 'lane' = continuous automation, 'note' = read at each onset, 'gen' = event generators. */
export const SYNTH_TARGETS: Record<SynthTarget, { label: string; kind: 'lane' | 'note' | 'gen'; mod?: ModTarget }> = {
  cutoff: { label: 'Filter cutoff', kind: 'lane', mod: 'cutoff' },
  resonance: { label: 'Resonance', kind: 'lane', mod: 'resonance' },
  morph: { label: 'Wave morph (osc A↔B balance)', kind: 'lane', mod: 'morph' },
  richness: { label: 'Harmonic richness (tilt)', kind: 'lane', mod: 'richness' },
  detune: { label: 'Oscillator detune', kind: 'lane', mod: 'detune' },
  fmDepth: { label: 'FM depth', kind: 'lane', mod: 'fmDepth' },
  fmRatio: { label: 'FM ratio', kind: 'note', mod: 'fmRatio' },
  noise: { label: 'Noise content', kind: 'lane', mod: 'noise' },
  attack: { label: 'Attack', kind: 'note', mod: 'attack' },
  release: { label: 'Release', kind: 'note', mod: 'release' },
  lfoRate: { label: 'LFO rate', kind: 'lane', mod: 'lfoRate' },
  lfoDepth: { label: 'LFO depth (filter)', kind: 'lane', mod: 'lfoDepth' },
  tremolo: { label: 'Tremolo', kind: 'lane', mod: 'tremolo' },
  pan: { label: 'Stereo pan', kind: 'lane', mod: 'pan' },
  delayFeedback: { label: 'Delay feedback', kind: 'lane', mod: 'delayFeedback' },
  reverbSend: { label: 'Reverb mix', kind: 'lane', mod: 'reverbSend' },
  density: { label: 'Voice / event density', kind: 'gen' },
};
export const SYNTH_TARGET_IDS = Object.keys(SYNTH_TARGETS) as SynthTarget[];

/** Default mappings: bounded, explainable starting points the user can reassign. */
export function defaultSynthMap(): SynthMapping[] {
  return [
    { target: 'cutoff', source: 'brightness', amount: 0.8 },
    { target: 'resonance', source: 'contrast', amount: 0.45 },
    { target: 'morph', source: 'texture', amount: 0.9 },
    { target: 'richness', source: 'edges', amount: 0.5 },
    { target: 'detune', source: 'saturation', amount: 0.6 },
    { target: 'fmDepth', source: 'texture', amount: 0.55 },
    { target: 'fmRatio', source: 'hue', amount: 0.5 },
    { target: 'noise', source: 'edges', amount: 0.45 },
    { target: 'attack', source: 'contrast', amount: -0.7 },
    { target: 'release', source: 'texture', amount: -0.6 },
    { target: 'lfoRate', source: 'variation', amount: 0.6 },
    { target: 'lfoDepth', source: 'periodicity', amount: 0.6 },
    { target: 'tremolo', source: 'periodicity', amount: 0.7 },
    { target: 'pan', source: 'centroid', amount: 0.5 },
    { target: 'delayFeedback', source: 'variation', amount: 0.4 },
    { target: 'reverbSend', source: 'texture', amount: -0.6 },
    { target: 'density', source: 'edges', amount: 0.6 },
  ];
}

/** Neutral (normalised) value per target and character: what the patch is before the image moves it. */
const NEUTRAL: Record<SynthCharacter, Partial<Record<SynthTarget, number>>> = {
  voice: { cutoff: 0.62, resonance: 0.12, morph: 0.4, richness: 0.5, detune: 0.2, fmDepth: 0.15, fmRatio: 0.34, noise: 0.05, attack: 0.38, release: 0.5, lfoRate: 0.45, lfoDepth: 0.12, tremolo: 0, pan: 0.5, delayFeedback: 0.3, reverbSend: 0.45, density: 0.5 },
  pluck: { cutoff: 0.7, resonance: 0.18, morph: 0.45, richness: 0.55, detune: 0.12, fmDepth: 0.25, fmRatio: 0.5, noise: 0.08, attack: 0.08, release: 0.42, lfoRate: 0.4, lfoDepth: 0.05, tremolo: 0, pan: 0.5, delayFeedback: 0.35, reverbSend: 0.5, density: 0.5 },
  drone: { cutoff: 0.5, resonance: 0.1, morph: 0.3, richness: 0.45, detune: 0.3, fmDepth: 0.08, fmRatio: 0.34, noise: 0.06, attack: 0.82, release: 0.82, lfoRate: 0.3, lfoDepth: 0.2, tremolo: 0, pan: 0.5, delayFeedback: 0.25, reverbSend: 0.6, density: 0.5 },
  texture: { cutoff: 0.82, resonance: 0.25, morph: 0.6, richness: 0.6, detune: 0.1, fmDepth: 0.35, fmRatio: 0.66, noise: 0.2, attack: 0.02, release: 0.3, lfoRate: 0.6, lfoDepth: 0.1, tremolo: 0, pan: 0.5, delayFeedback: 0.4, reverbSend: 0.4, density: 0.5 },
  shimmer: { cutoff: 0.8, resonance: 0.15, morph: 0.65, richness: 0.62, detune: 0.35, fmDepth: 0.2, fmRatio: 0.84, noise: 0.04, attack: 0.55, release: 0.7, lfoRate: 0.55, lfoDepth: 0.15, tremolo: 0.1, pan: 0.5, delayFeedback: 0.45, reverbSend: 0.65, density: 0.5 },
};

const FM_RATIOS = [0.5, 1, 1.5, 2, 3, 4, 5];
const c01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Normalised lane value → physical unit (shared with the channel buses in audio/graph.ts). */
export const unit = {
  resonance: (v: number) => 0.5 + v * 9,
  richness: (v: number) => (v - 0.5) * 20, // dB high-shelf
  morph: (v: number) => v,
  detune: (v: number) => v * 40, // cents
  fmDepth: (v: number) => v * 3, // index
  fmRatio: (v: number) => FM_RATIOS[Math.max(0, Math.min(FM_RATIOS.length - 1, Math.round(v * (FM_RATIOS.length - 1))))],
  noise: (v: number) => v * 0.4,
  attack: (v: number) => 0.002 * Math.pow(2, v * 11), // 2 ms … 4 s
  release: (v: number) => 0.03 * Math.pow(2, v * 8), // 30 ms … 7.7 s
  lfoRate: (v: number) => 0.03 * Math.pow(2, v * 8), // 0.03 … 7.7 Hz
  lfoDepth: (v: number) => v,
  tremolo: (v: number) => v,
};

/** Statistics of one image region for patch derivation. */
export interface RegionFeatures {
  summary: ReturnType<typeof curveSummary>;
  /** mean luminance and edge density per grid row, top → bottom */
  rowLum: Float32Array;
  rowEdge: Float32Array;
}

export function regionFeatures(grid: FeatureGrid, mask: MaskFn, cv: Curve): RegionFeatures {
  const rowLum = new Float32Array(grid.rows);
  const rowEdge = new Float32Array(grid.rows);
  const nb = EDGE_BINS.length;
  for (let r = 0; r < grid.rows; r++) {
    let L = 0, E = 0, W = 0;
    for (let c = 0; c < grid.cols; c++) {
      const m = mask(c, r);
      const cell = r * grid.cols + c;
      const cnt = grid.count[cell];
      if (m <= 0 || !cnt) continue;
      L += (grid.lum[cell] / cnt) * m;
      E += (grid.hist[cell * nb + 3] / cnt) * m;
      W += m;
    }
    rowLum[r] = W ? L / W : 0;
    rowEdge[r] = W ? E / W : 0;
  }
  return { summary: curveSummary(cv), rowLum, rowEdge };
}

const featMean = (s: RegionFeatures['summary'], f: FeatureKey): number => {
  switch (f) {
    case 'none': return 0.5;
    case 'centroid': return 0.5;
    default: return (s as Record<string, number>)[f] ?? 0.5;
  }
};

/** Static (normalised) value of a target for a region: neutral moved by the image's average. */
export function staticValue(target: SynthTarget, character: SynthCharacter, map: SynthMapping[], s: RegionFeatures['summary']): number {
  const n = NEUTRAL[character][target] ?? 0.5;
  const m = map.find((x) => x.target === target);
  if (!m || m.source === 'none') return n;
  return c01(n + m.amount * 0.9 * (featMean(s, m.source) - 0.5));
}

function harmonics(profile: Float32Array, floor: number, roll: number, gain: number, N = 24): number[] {
  const rows = profile.length;
  const out: number[] = [];
  for (let k = 1; k <= N; k++) {
    // bottom row → fundamental, top row → highest partial
    const r = rows - 1 - Math.min(rows - 1, Math.floor(((k - 1) / N) * rows));
    out.push((floor + profile[r] * gain) * Math.pow(k, -roll));
  }
  const norm = Math.sqrt(out.reduce((a, b) => a + b * b, 0)) || 1;
  return out.map((v) => Math.round((v / norm) * 1e4) / 1e4);
}

/** A patch whose character comes from the image region, ready for the 'image' voice engine. */
export function deriveImageSynth(name: string, character: SynthCharacter, f: RegionFeatures, map: SynthMapping[]): SynthPatch {
  const s = f.summary;
  const v = (t: SynthTarget) => staticValue(t, character, map, s);
  const image: ImageSynthParams = {
    wavesA: harmonics(f.rowLum, 0.12, 1.5 - 0.8 * c01(s.texture), 1),
    wavesB: harmonics(f.rowEdge, 0.08, 1.0 - 0.4 * c01(s.texture), 3),
    morph: unit.morph(v('morph')),
    detune: unit.detune(v('detune')),
    fmRatio: unit.fmRatio(v('fmRatio')),
    fmDepth: unit.fmDepth(v('fmDepth')),
    noise: unit.noise(v('noise')),
    lfoRate: unit.lfoRate(v('lfoRate')),
    lfoDepth: unit.lfoDepth(v('lfoDepth')),
    tremolo: unit.tremolo(v('tremolo')),
  };
  const amp = {
    voice: { d: 0.6, s: 0.72 },
    pluck: { d: 0.5, s: 0 },
    drone: { d: 2, s: 1 },
    texture: { d: 0.18, s: 0 },
    shimmer: { d: 1.2, s: 0.8 },
  }[character];
  return makePatch(name, {
    engine: 'image',
    image,
    // the voice filter stays open and key-tracked; the image-driven cutoff lives on the channel
    filter: { type: 'lowpass', cutoff: character === 'pluck' ? 2600 : 7000, res: 0.7, envAmt: character === 'pluck' ? 2.2 : character === 'texture' ? 1.2 : 0.3, keyTrack: 0.5 },
    fenv: { a: 0.002, d: character === 'pluck' ? 0.25 : 0.6, s: 0.2, r: 0.4 },
    amp: { a: unit.attack(v('attack')), d: amp.d, s: amp.s, r: unit.release(v('release')) },
    lfo: { rate: 0.5, depth: 0, dest: 'none' },
    poly: character === 'drone' ? 6 : character === 'texture' ? 12 : 8,
    velSens: character === 'drone' ? 0.3 : 0.75,
    gain: { voice: -9, pluck: -7, drone: -12, texture: -9, shimmer: -13 }[character],
  });
}

const cv01 = (cv: Curve, key: FeatureKey, t: number) => (key === 'none' ? 0.5 : curveValue(cv, key as CurveKey, t));

/** Value of one mapping along the scan: static + EVOLUTION × (deviation from the region's mean). */
export function mappingCurve(m: SynthMapping, character: SynthCharacter, cv: Curve, evolution: number, s: RegionFeatures['summary']): (t01: number) => number {
  const n = NEUTRAL[character][m.target] ?? 0.5;
  const mean = featMean(s, m.source);
  const meanCv = m.source === 'centroid' ? (() => { let a = 0; for (let j = 0; j < cv.n; j++) a += cv.centroid[j]; return a / cv.n; })() : mean;
  return (t01) => {
    if (m.source === 'none') return n;
    const f = cv01(cv, m.source, t01);
    return c01(n + m.amount * (0.9 * (mean - 0.5) + 1.8 * evolution * (f - meanCv)));
  };
}

/** Automation lanes for every 'lane' and 'note' target. At EVOLUTION 0 each lane is flat (a static,
 *  repeatable timbre); otherwise it follows the feature, smoothed so filters never jump. */
export function synthLanes(cv: Curve, map: SynthMapping[], character: SynthCharacter, f: RegionFeatures, evolution: number, beats: number, idPrefix: string, origin: AutomationLane['origin'], skip: SynthTarget[] = []): AutomationLane[] {
  const step = Math.max(0.5, beats / 512);
  const lanes: AutomationLane[] = [];
  for (const m of map) {
    const def = SYNTH_TARGETS[m.target];
    if (def.kind === 'gen' || !def.mod || skip.includes(m.target)) continue;
    const fn = mappingCurve(m, character, cv, evolution, f.summary);
    const vals: number[] = [];
    for (let b = 0; b <= beats + 1e-6; b += step) vals.push(fn(b / beats));
    // forward-backward slew: smooth without shifting features in time
    const a = 0.45;
    for (let i = 1; i < vals.length; i++) vals[i] = vals[i - 1] + a * (vals[i] - vals[i - 1]);
    for (let i = vals.length - 2; i >= 0; i--) vals[i] = vals[i + 1] + a * (vals[i] - vals[i + 1]);
    const points = evolution <= 1e-3
      ? [{ beat: 0, value: vals[0] }, { beat: beats, value: vals[0] }]
      : vals.map((value, i) => ({ beat: Math.min(beats, i * step), value: Math.round(value * 1e4) / 1e4 }));
    lanes.push({ id: `${idPrefix}_syn_${m.target}`, target: def.mod, points, origin });
  }
  return lanes;
}

/** Density modulation from the 'density' mapping (1 = neutral): event generators scale their spacing by it. */
export function densityMod(map: SynthMapping[], cv: Curve, evolution: number, s: RegionFeatures['summary']): (t01: number) => number {
  const m = map.find((x) => x.target === 'density');
  if (!m || m.source === 'none') return () => 1;
  const fn = mappingCurve(m, 'voice', cv, Math.max(0.5, evolution), s);
  return (t) => Math.pow(2, (fn(t) - 0.5) * 2.4);
}

export function defaultImageParams(): ImageSynthParams {
  const saw = Array.from({ length: 24 }, (_, k) => 1 / (k + 1));
  return { wavesA: saw.map((x, k) => x / (k + 1)), wavesB: saw, morph: 0.4, detune: 8, fmRatio: 1, fmDepth: 0.4, noise: 0.02, lfoRate: 0.3, lfoDepth: 0.1, tremolo: 0 };
}

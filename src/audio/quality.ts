// Audio performance profiles. The realtime audio thread has a hard deadline (one render callback,
// ~10 ms); when the graph takes longer the output underruns and you hear crackles and stutter.
// Measured on the Drone / Experimental stress scenario, most of that time went to parameters that
// move slowly (LFO sweeps of 0.05–1 Hz, 25 ms lane automation, multi-second envelopes) but were
// computed every sample — a BiquadFilterNode recomputes its coefficients (sin/cos/pow) for every
// sample whenever a parameter has audio-rate input. Computing those once per 128-sample block
// (2.9 ms) sounds the same when the per-block step is tiny, so a parameter is moved to block rate
// only when its fastest movement is provably below the step thresholds here. Audio-rate
// modulation (FM, chorus delay sweeps, gain envelopes) is never changed.

export type AudioQuality = 'balanced' | 'high' | 'performance';

export interface QualityProfile {
  id: AudioQuality;
  label: string;
  description: string;
  /** compute slow modulation once per render block where the step is inaudible */
  blockRate: boolean;
  /** project-wide voice budget in cost units (see voiceCost in voices.ts) */
  voiceBudget: number;
  /** AudioContext latency hint: a larger device buffer absorbs momentary load peaks */
  latencyHint: AudioContextLatencyCategory | number;
}

export const QUALITY: Record<AudioQuality, QualityProfile> = {
  balanced: {
    id: 'balanced', label: 'Balanced', blockRate: true, voiceBudget: 900, latencyHint: 'playback',
    description: 'Slow modulation is computed once per audio block (an inaudible step) and the output buffer is sized for playback, which absorbs the periodic load peaks of the convolution reverbs (≈ 36 ms output latency, 9 ms more than before). Full polyphony and effects.',
  },
  high: {
    id: 'high', label: 'High quality', blockRate: false, voiceBudget: 1800, latencyHint: 'balanced',
    description: 'Every modulated parameter at sample rate, the lowest output latency and a larger voice budget. For powerful computers and live keyboard playing.',
  },
  performance: {
    id: 'performance', label: 'Performance', blockRate: true, voiceBudget: 600, latencyHint: 0.06,
    description: 'Balanced processing with a larger output buffer (≈ 75 ms output latency, measured in Chrome 156 on macOS) for very dense projects. Sequenced playback stays in time; live keyboard notes sound later.',
  },
};

/** One render quantum. */
export const BLOCK = 128;

/** Largest inaudible per-block step of a filter frequency (octaves) and of an oscillator pitch (cents). */
export const MAX_FILTER_STEP_OCT = 1 / 96;
export const MAX_PITCH_STEP_CENTS = 3;
/** Largest per-block step of a stereo pan position (−1…1). */
export const MAX_PAN_STEP = 0.01;

/** Sine LFO of `rate` Hz and peak deviation `depth` (any unit): its largest change in one block. */
export const lfoBlockStep = (rate: number, depth: number, sampleRate: number) => 2 * Math.PI * Math.abs(rate) * Math.abs(depth) * (BLOCK / sampleRate);

/** Move AudioParams to block-rate automation. Feature-detected and never throws (older engines
 *  have no automationRate; some parameters have a fixed rate). */
export function blockRate(...params: (AudioParam | null | undefined)[]) {
  for (const p of params) {
    if (!p || !('automationRate' in p) || p.automationRate === 'k-rate') continue;
    try { p.automationRate = 'k-rate'; } catch { /* fixed-rate parameter */ }
  }
}

/** All four parameters of a biquad. Chromium only takes the once-per-block coefficient path when
 *  every one of them is k-rate — leaving gain or detune at a-rate keeps the per-sample path. */
export const biquadParams = (f: BiquadFilterNode | null | undefined): (AudioParam | null)[] => (f ? [f.frequency, f.detune, f.Q, f.gain] : []);

export function sampleRateParams(...params: (AudioParam | null | undefined)[]) {
  for (const p of params) {
    if (!p || !('automationRate' in p) || p.automationRate === 'a-rate') continue;
    try { p.automationRate = 'a-rate'; } catch { /* fixed-rate parameter */ }
  }
}

const KEY = 'aperture.audioQuality';

export function loadQuality(): AudioQuality {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'balanced' || v === 'high' || v === 'performance') return v;
  } catch { /* storage unavailable */ }
  return 'balanced';
}

export function saveQuality(q: AudioQuality) {
  try { localStorage.setItem(KEY, q); } catch { /* storage unavailable */ }
}

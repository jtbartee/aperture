import { describe, expect, test } from 'vitest';
import { BLOCK, MAX_FILTER_STEP_OCT, QUALITY, biquadParams, blockRate, lfoBlockStep, sampleRateParams } from '../../src/audio/quality';
import { sweepBlockStep } from '../../src/audio/fx';
import { REVERB_FLOOR_DB, reverbImpulse, reverbTau } from '../../src/audio/nativeFx';
import { voiceCost } from '../../src/audio/voices';
import { INSTRUMENTS } from '../../src/audio/patches';
import { levels, outputStats } from '../../src/audio/diagnostics';

/** Just enough of a BaseAudioContext for impulse generation. */
function fakeCtx(sampleRate: number) {
  return {
    sampleRate,
    createBuffer: (channels: number, length: number) => {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { length, numberOfChannels: channels, sampleRate, getChannelData: (c: number) => data[c] };
    },
  } as unknown as BaseAudioContext;
}

const patch = (name: string) => INSTRUMENTS.find((p) => p.name === name)!;

describe('processing profiles', () => {
  test('Balanced is the default trade-off: block-rate modulation, a playback-sized buffer, a mid budget', () => {
    expect(QUALITY.balanced.blockRate).toBe(true);
    expect(QUALITY.balanced.latencyHint).toBe('playback');
    expect(QUALITY.high.blockRate).toBe(false);
    expect(QUALITY.performance.voiceBudget).toBeLessThan(QUALITY.balanced.voiceBudget);
    expect(QUALITY.balanced.voiceBudget).toBeLessThan(QUALITY.high.voiceBudget);
    // generous enough that the Drone / Experimental stress scenario (peak cost ≈ 225) never steals
    expect(QUALITY.performance.voiceBudget).toBeGreaterThan(2 * 225);
  });

  test('block-rate helpers touch only parameters that support it and never throw', () => {
    const p = { automationRate: 'a-rate' } as AudioParam;
    const fixed = { get automationRate() { return 'a-rate'; }, set automationRate(_v: string) { throw new Error('fixed'); } } as unknown as AudioParam;
    blockRate(p, fixed, null, undefined);
    expect(p.automationRate).toBe('k-rate');
    sampleRateParams(p);
    expect(p.automationRate).toBe('a-rate');
    const wrapped = {} as AudioParam; // a wrapper without automationRate (standardized-audio-context)
    blockRate(wrapped);
    expect('automationRate' in wrapped).toBe(false);
  });

  test('a biquad moves to block rate only as a whole (all four parameters)', () => {
    const f = { frequency: {}, detune: {}, Q: {}, gain: {} } as unknown as BiquadFilterNode;
    expect(biquadParams(f)).toHaveLength(4);
    expect(biquadParams(null)).toEqual([]);
  });
});

describe('block-rate step limits', () => {
  test('LFO step: 2π · rate · depth per block', () => {
    expect(lfoBlockStep(1, 1, 48000)).toBeCloseTo((2 * Math.PI * BLOCK) / 48000, 9);
    expect(lfoBlockStep(0, 5, 48000)).toBe(0);
  });

  test('Atmospheric Sweep phaser (0.12 Hz over 3.8 octaves) steps < 1/96 octave per block; a 4 Hz phaser does not', () => {
    expect(sweepBlockStep(0.12, 3.8, 44100)).toBeLessThan(MAX_FILTER_STEP_OCT);
    expect(sweepBlockStep(4, 3, 44100)).toBeGreaterThan(MAX_FILTER_STEP_OCT);
  });

  test('the sweep step is the steepest point of a linear-in-Hz sweep, in octaves', () => {
    // numerically: max |d log2 f| over one LFO cycle, per block
    const rate = 0.5, oct = 3, sr = 48000;
    const fmin = 200, fmax = fmin * 2 ** oct;
    let worst = 0;
    const dt = BLOCK / sr;
    for (let t = 0; t < 1 / rate; t += dt) {
      const f = (x: number) => fmin + ((fmax - fmin) * (Math.sin(2 * Math.PI * rate * x) + 1)) / 2;
      worst = Math.max(worst, Math.abs(Math.log2(f(t + dt)) - Math.log2(f(t))));
    }
    expect(sweepBlockStep(rate, oct, sr)).toBeGreaterThanOrEqual(worst * 0.99);
    expect(sweepBlockStep(rate, oct, sr)).toBeLessThan(worst * 1.05);
  });
});

describe('reverb impulse (Tone.Reverb recipe, truncated)', () => {
  test("Tone's decay is not RT60: decay 9 s has τ = ln 10 / ln 200 and is −60 dB after ≈ 3 s", () => {
    expect(reverbTau(9)).toBeCloseTo(Math.log(10) / Math.log(200), 9);
    expect(reverbTau(9) * Math.log(1000)).toBeCloseTo(3.0, 1);
  });

  test('stops where the envelope reaches the floor, not at decay + pre-delay', () => {
    const ir = reverbImpulse(fakeCtx(48000), 9, 0.04);
    const expected = reverbTau(9) * Math.log(10 ** (-REVERB_FLOOR_DB / 20)) + 0.04;
    expect(ir.length / 48000).toBeCloseTo(expected, 2);
    expect(ir.length / 48000).toBeLessThan(9.04 * 0.55);
    // short decays are not stretched past their own length
    expect(reverbImpulse(fakeCtx(48000), 0.5, 0).length).toBe(Math.ceil(0.5 * 48000));
  });

  test('silent until the pre-delay, then decaying white noise; seeded and different per channel', () => {
    const ctx = fakeCtx(48000);
    const a = reverbImpulse(ctx, 3, 0.02, 5);
    const b = reverbImpulse(ctx, 3, 0.02, 5);
    const c = reverbImpulse(ctx, 3, 0.02, 6);
    const L = a.getChannelData(0), R = a.getChannelData(1);
    expect(L.slice(0, 959).every((x) => x === 0)).toBe(true);
    expect(Math.abs(L[970])).toBeGreaterThan(0);
    expect(Array.from(L)).toEqual(Array.from(b.getChannelData(0)));
    expect(L[2000]).not.toBe(c.getChannelData(0)[2000]);
    expect(L[2000]).not.toBe(R[2000]);
    const rms = (d: Float32Array, i0: number, n: number) => Math.sqrt(d.slice(i0, i0 + n).reduce((s, x) => s + x * x, 0) / n);
    // energy falls by e^(−2t/τ): 10·log10 ratio over 0.5 s
    const drop = 20 * Math.log10(rms(L, 960, 4800) / rms(L, 960 + 24000, 4800));
    expect(drop).toBeCloseTo((20 * 0.5) / reverbTau(3) / Math.LN10, 0);
  });

  test("carries the spec's normalisation for the full-length impulse (so truncation keeps the level)", () => {
    const sr = 48000, decay = 9, pre = 0.04;
    const ir = reverbImpulse(fakeCtx(sr), decay, pre, 2);
    let e = 0;
    for (let c = 0; c < 2; c++) for (const x of ir.getChannelData(c)) e += x * x;
    // after scaling, the RMS over the *full* length (decay + preDelay) equals the spec's calibration
    const fullLength = Math.round((decay + pre) * sr);
    expect(Math.sqrt(e / (2 * fullLength))).toBeCloseTo(0.00125 * (44100 / sr), 6);
  });
});

describe('voice cost', () => {
  test('weights voices by what they run: a drone with unison and an LFO-swept filter costs more than a click', () => {
    const drone = voiceCost(patch('Dark Drone'));
    const pad = voiceCost(patch('Warm Analog Pad'));
    const noise = voiceCost(INSTRUMENTS.find((p) => p.engine === 'noise')!);
    expect(drone).toBeGreaterThan(noise * 1.5);
    expect(pad).toBeGreaterThan(noise);
  });

  test('block rate lowers the estimate for audio-rate-modulated filters', () => {
    const p = patch('Dark Drone');
    expect(voiceCost(p, true)).toBeLessThan(voiceCost(p, false));
  });
});

describe('diagnostics helpers', () => {
  test('levels: peak and RMS in dBFS', () => {
    const buf = new Float32Array(1000).fill(0.5);
    const l = levels(buf);
    expect(l.peakDb).toBeCloseTo(-6.02, 1);
    expect(l.rmsDb).toBeCloseTo(-6.02, 1);
    expect(levels(new Float32Array(16)).peakDb).toBe(-180);
  });

  test('output stats: playbackStats (seconds) or playoutStats (ms); absent → null, never a guess', () => {
    expect(outputStats({ playbackStats: { underrunEvents: 3, underrunDuration: 0.02, averageLatency: 0.035 } } as unknown as BaseAudioContext)).toEqual({ underruns: 3, underrunMs: 20, latencyMs: 35 });
    expect(outputStats({ playoutStats: { fallbackFramesEvents: 2, fallbackFramesDuration: 7, averageLatency: 0 } } as unknown as BaseAudioContext)).toEqual({ underruns: 2, underrunMs: 7, latencyMs: null });
    expect(outputStats({} as BaseAudioContext)).toBeNull();
    expect(outputStats(undefined)).toBeNull();
  });
});

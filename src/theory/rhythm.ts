import type { Beats, RhythmSpec, TimeSigId } from '../core/types';
import type { Rng } from '../core/rng';
import { TIME_SIGS, groupStarts, metricWeight } from '../core/time';

export const SUBDIVISIONS: { label: string; steps: number }[] = [
  { label: '1/4', steps: 1 },
  { label: '1/8', steps: 2 },
  { label: '1/8 triplet', steps: 3 },
  { label: '1/16', steps: 4 },
  { label: '1/16 triplet', steps: 6 },
  { label: '1/32', steps: 8 },
];

export const DURATIONS: Record<string, Beats> = {
  whole: 4, half: 2, dottedQuarter: 1.5, quarter: 1, dottedEighth: 0.75, eighth: 0.5,
  tripletEighth: 1 / 3, sixteenth: 0.25, tripletSixteenth: 1 / 6, thirtySecond: 0.125,
};

/** Bjorklund/Euclidean distribution of `pulses` onsets over `steps`, rotated. */
export function euclid(pulses: number, steps: number, rotation = 0): boolean[] {
  const n = Math.max(1, Math.round(steps));
  const k = Math.max(0, Math.min(n, Math.round(pulses)));
  // Bresenham form of the Euclidean rhythm, first onset on step 0; rotation moves it later.
  const out: boolean[] = [];
  for (let i = 0; i < n; i++) out.push(k > 0 && (i * k) % n < k);
  return rotate(out, rotation);
}

export function rotate<T>(xs: T[], r: number): T[] {
  const n = xs.length;
  if (!n) return xs;
  const k = ((r % n) + n) % n;
  return [...xs.slice(n - k), ...xs.slice(0, n - k)];
}

export interface Onset { beat: Beats; dur: Beats; accent: number }

/** Expand a RhythmSpec into onsets over [0, beats). The pattern repeats with its own length,
 *  so a 7-step bass and a 16-step hat drift against each other (polymeter). */
export function expandRhythm(spec: RhythmSpec, beats: Beats, ts: TimeSigId, rng: Rng, offset: Beats = 0): Onset[] {
  const step = 1 / spec.subdiv;
  const pat = euclid(spec.pulses, spec.length, spec.rotation);
  const bar = TIME_SIGS[ts].barBeats;
  const out: Onset[] = [];
  const total = Math.floor((beats - offset) / step + 1e-6);
  for (let i = 0; i < total; i++) {
    if (!pat[i % pat.length]) continue;
    if (spec.probability < 1 && !rng.chance(spec.probability)) continue;
    const beat = offset + i * step;
    const accent = metricWeight(ts, beat % bar);
    // length until the next onset in the pattern, capped
    let gap = 1;
    while (gap < pat.length && !pat[(i + gap) % pat.length]) gap++;
    const dur = Math.min(gap, 4) * step;
    if (spec.ratchet > 0 && rng.chance(spec.ratchet * 0.5)) {
      const r = rng.pick([2, 3, 4]);
      for (let j = 0; j < r; j++) out.push({ beat: beat + (j * step) / r, dur: step / r * 0.9, accent: accent * (1 - j * 0.15) });
      continue;
    }
    out.push({ beat, dur, accent });
  }
  return humanize(out, spec.humanize, rng);
}

/** Small deterministic timing/velocity deviations (resolved at generation, so exports match playback). */
export function humanize(onsets: Onset[], amount: number, rng: Rng): Onset[] {
  if (amount <= 0) return onsets;
  return onsets.map((o) => ({
    ...o,
    beat: Math.max(0, o.beat + rng.gauss() * amount * 0.015),
    accent: Math.max(0.05, Math.min(1, o.accent + rng.gauss() * amount * 0.08)),
  }));
}

/** k-against-n polyrhythm onsets over one cycle of `cycle` beats. */
export function polyrhythm(k: number, cycle: Beats): Beats[] {
  return Array.from({ length: k }, (_, i) => (i * cycle) / k);
}

/** Onsets that mark each metric group start: the time-signature-aware "pulse". */
export function groupPulse(ts: TimeSigId, bars: number): Beats[] {
  const bb = TIME_SIGS[ts].barBeats;
  const gs = groupStarts(ts);
  const out: Beats[] = [];
  for (let b = 0; b < bars; b++) for (const g of gs) out.push(b * bb + g);
  return out;
}

/** Steps inside one bar for a given subdivision (handles x/8 bars of non-integer beats). */
export function stepsPerBar(ts: TimeSigId, subdiv: number): number {
  return Math.round(TIME_SIGS[ts].barBeats * subdiv);
}

export function defaultRhythm(partial: Partial<RhythmSpec> = {}): RhythmSpec {
  return { subdiv: 4, length: 16, pulses: 5, rotation: 0, probability: 1, ratchet: 0, humanize: 0, ...partial };
}

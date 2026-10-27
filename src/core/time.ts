import type { Beats, TimeSigId, ProjectSettings } from './types';

export interface TimeSigInfo {
  id: TimeSigId;
  num: number;
  den: number;
  /** bar length in quarter-note beats */
  barBeats: number;
  /** grouping of the bar in its own pulse unit (eighths for x/8, quarters for x/4) */
  groups: number[];
  /** pulse unit length in beats */
  pulse: number;
}

export const TIME_SIGS: Record<TimeSigId, TimeSigInfo> = {
  '4/4': { id: '4/4', num: 4, den: 4, barBeats: 4, groups: [1, 1, 1, 1], pulse: 1 },
  '3/4': { id: '3/4', num: 3, den: 4, barBeats: 3, groups: [1, 1, 1], pulse: 1 },
  '6/8': { id: '6/8', num: 6, den: 8, barBeats: 3, groups: [3, 3], pulse: 0.5 },
  '5/4': { id: '5/4', num: 5, den: 4, barBeats: 5, groups: [3, 2], pulse: 1 },
  '7/8': { id: '7/8', num: 7, den: 8, barBeats: 3.5, groups: [2, 2, 3], pulse: 0.5 },
  '9/8': { id: '9/8', num: 9, den: 8, barBeats: 4.5, groups: [3, 3, 3], pulse: 0.5 },
};

export const barBeats = (ts: TimeSigId) => TIME_SIGS[ts].barBeats;

/** Beat positions (within one bar) where each metric group starts; index 0 is the downbeat. */
export function groupStarts(ts: TimeSigId): Beats[] {
  const info = TIME_SIGS[ts];
  const out: Beats[] = [];
  let p = 0;
  for (const g of info.groups) { out.push(p * info.pulse); p += g; }
  return out;
}

/** Metric accent weight (0..1) for a position inside a bar: downbeat 1, group starts 0.75,
 *  pulse units 0.5, finer subdivisions lower. This is what makes 7/8 feel like 2+2+3. */
export function metricWeight(ts: TimeSigId, posInBar: Beats): number {
  const info = TIME_SIGS[ts];
  const eps = 1e-6;
  if (Math.abs(posInBar) < eps) return 1;
  for (const g of groupStarts(ts)) if (Math.abs(posInBar - g) < eps) return 0.75;
  const pu = posInBar / info.pulse;
  if (Math.abs(pu - Math.round(pu)) < eps) return 0.5;
  const half = posInBar / (info.pulse / 2);
  if (Math.abs(half - Math.round(half)) < eps) return 0.3;
  return 0.15;
}

/** Swing as a continuous time warp: inside each pair-cell the midpoint moves later by up
 *  to a triplet feel. Applied identically by the live scheduler, offline render and MIDI export. */
export function swingBeat(b: Beats, swing: number, grid: 8 | 16): Beats {
  if (swing <= 0) return b;
  const cell = grid === 8 ? 1 : 0.5;
  const k = Math.floor(b / cell + 1e-9);
  const p = b / cell - k;
  const m = 0.5 + swing * (1 / 6);
  const w = p < 0.5 ? p * (m / 0.5) : m + (p - 0.5) * ((1 - m) / 0.5);
  return (k + w) * cell;
}

export const performedBeat = (b: Beats, s: Pick<ProjectSettings, 'swing' | 'swingGrid'>) => swingBeat(b, s.swing, s.swingGrid);

export const secondsPerBeat = (bpm: number) => 60 / bpm;

export function projectBeats(s: Pick<ProjectSettings, 'lengthBars' | 'timeSig'>): Beats {
  return s.lengthBars * barBeats(s.timeSig);
}

export function quantizeBeat(b: Beats, stepsPerBeat: number): Beats {
  if (!stepsPerBeat) return b;
  return Math.round(b * stepsPerBeat) / stepsPerBeat;
}

export function formatPosition(b: Beats, ts: TimeSigId): string {
  const bb = barBeats(ts);
  const bar = Math.floor(b / bb + 1e-9);
  const inBar = b - bar * bb;
  const info = TIME_SIGS[ts];
  const pulse = Math.floor(inBar / info.pulse + 1e-9);
  return `${bar + 1}.${pulse + 1}`;
}

import type { PitchMapping, ScaleId } from '../core/types';

export interface ScaleDef { id: ScaleId; name: string; intervals: number[] }

export const SCALES: Record<ScaleId, ScaleDef> = {
  major: { id: 'major', name: 'Major', intervals: [0, 2, 4, 5, 7, 9, 11] },
  minor: { id: 'minor', name: 'Natural minor', intervals: [0, 2, 3, 5, 7, 8, 10] },
  harmonicMinor: { id: 'harmonicMinor', name: 'Harmonic minor', intervals: [0, 2, 3, 5, 7, 8, 11] },
  melodicMinor: { id: 'melodicMinor', name: 'Melodic minor', intervals: [0, 2, 3, 5, 7, 9, 11] },
  dorian: { id: 'dorian', name: 'Dorian', intervals: [0, 2, 3, 5, 7, 9, 10] },
  phrygian: { id: 'phrygian', name: 'Phrygian', intervals: [0, 1, 3, 5, 7, 8, 10] },
  lydian: { id: 'lydian', name: 'Lydian', intervals: [0, 2, 4, 6, 7, 9, 11] },
  mixolydian: { id: 'mixolydian', name: 'Mixolydian', intervals: [0, 2, 4, 5, 7, 9, 10] },
  locrian: { id: 'locrian', name: 'Locrian', intervals: [0, 1, 3, 5, 6, 8, 10] },
  majorPent: { id: 'majorPent', name: 'Major pentatonic', intervals: [0, 2, 4, 7, 9] },
  minorPent: { id: 'minorPent', name: 'Minor pentatonic', intervals: [0, 3, 5, 7, 10] },
  majorBlues: { id: 'majorBlues', name: 'Major blues', intervals: [0, 2, 3, 4, 7, 9] },
  minorBlues: { id: 'minorBlues', name: 'Minor blues', intervals: [0, 3, 5, 6, 7, 10] },
  wholeTone: { id: 'wholeTone', name: 'Whole tone', intervals: [0, 2, 4, 6, 8, 10] },
  chromatic: { id: 'chromatic', name: 'Chromatic', intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  octatonic: { id: 'octatonic', name: 'Diminished (octatonic)', intervals: [0, 2, 3, 5, 6, 8, 9, 11] },
  phrygianDominant: { id: 'phrygianDominant', name: 'Phrygian dominant', intervals: [0, 1, 4, 5, 7, 8, 10] },
  custom: { id: 'custom', name: 'Custom', intervals: [0, 2, 4, 7, 9] },
};

export const SCALE_IDS = Object.keys(SCALES) as ScaleId[];

const SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const FLAT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
/** Key roots conventionally spelled with flats in major-family and minor-family keys. */
const FLAT_MAJOR = new Set([5, 10, 3, 8, 1, 6]);
const FLAT_MINOR = new Set([2, 7, 0, 5, 10, 3]);

export const KEY_NAMES = ['C', 'C♯/D♭', 'D', 'E♭', 'E', 'F', 'F♯/G♭', 'G', 'A♭', 'A', 'B♭', 'B'];

export function isMinorish(scale: ScaleId): boolean {
  const iv = scaleIntervals(scale);
  return iv.includes(3) && !iv.includes(4);
}

/** Practical enharmonic spelling: flats for flat keys (F, B♭, E♭… / d, g, c… minor), sharps otherwise. */
export function prefersFlats(root: number, scale: ScaleId): boolean {
  return isMinorish(scale) ? FLAT_MINOR.has(root) : FLAT_MAJOR.has(root);
}

export function pcName(pc: number, root = 0, scale: ScaleId = 'major'): string {
  const p = ((pc % 12) + 12) % 12;
  return (prefersFlats(root, scale) ? FLAT : SHARP)[p];
}

export function midiName(m: number, root = 0, scale: ScaleId = 'major'): string {
  return `${pcName(m, root, scale)}${Math.floor(m / 12) - 1}`;
}

export function keyLabel(root: number, scale: ScaleId): string {
  return `${pcName(root, root, scale)} ${SCALES[scale].name}`;
}

export function scaleIntervals(scale: ScaleId, custom?: number[]): number[] {
  if (scale === 'custom') {
    const c = [...new Set((custom?.length ? custom : SCALES.custom.intervals).map((x) => ((x % 12) + 12) % 12))].sort((a, b) => a - b);
    return c.length ? c : [0];
  }
  return SCALES[scale].intervals;
}

/** Pitch classes (absolute, 0..11) of a key + scale. */
export function pitchClasses(root: number, scale: ScaleId, custom?: number[]): number[] {
  return scaleIntervals(scale, custom).map((i) => (root + i) % 12).sort((a, b) => a - b);
}

export function inScale(midi: number, root: number, scale: ScaleId, custom?: number[]): boolean {
  return scaleIntervals(scale, custom).includes((((midi - root) % 12) + 12) % 12);
}

export function snapToScale(midi: number, root: number, scale: ScaleId, custom?: number[]): number {
  const iv = scaleIntervals(scale, custom);
  for (let d = 0; d <= 6; d++) {
    if (iv.includes((((midi - d - root) % 12) + 12) % 12)) return midi - d;
    if (iv.includes((((midi + d - root) % 12) + 12) % 12)) return midi + d;
  }
  return midi;
}

export const DRUM_PITCHES = [36, 37, 38, 39, 42, 46, 56];
export const DRUM_NAMES: Record<number, string> = { 36: 'Kick', 37: 'Click', 38: 'Snare', 39: 'Noise', 42: 'Closed hat', 46: 'Open hat', 56: 'Metal' };

/** Every pitch the vertical axis can reach for a mapping, ascending. */
export function allowedPitches(map: PitchMapping, root: number, scale: ScaleId, custom?: number[]): number[] {
  if (map.mode === 'drums') return DRUM_PITCHES;
  let iv: number[];
  switch (map.mode) {
    case 'chromatic': iv = SCALES.chromatic.intervals; break;
    case 'pentatonic': iv = isMinorish(scale) ? SCALES.minorPent.intervals : SCALES.majorPent.intervals; break;
    case 'custom': iv = scaleIntervals('custom', map.custom); break;
    default: iv = scaleIntervals(scale, custom);
  }
  const out: number[] = [];
  const lo = Math.min(map.low, map.high);
  const hi = Math.max(map.low, map.high);
  for (let m = lo; m <= hi; m++) if (iv.includes((((m - root) % 12) + 12) % 12)) out.push(m);
  return out.length ? out : [lo];
}

/** Map a normalised vertical position (0 bottom, 1 top) to a pitch, then move `steps` scale steps. */
export function mapY(y: number, pitches: number[], steps = 0): number {
  const n = pitches.length;
  const idx = Math.round(Math.max(0, Math.min(1, y)) * (n - 1));
  const j = idx + steps;
  if (j >= 0 && j < n) return pitches[j];
  // beyond the range: continue by octave equivalence
  const per = Math.max(1, pitchesPerOctave(pitches));
  const oct = Math.floor(j / per);
  const k = ((j % per) + per) % per;
  return pitches[Math.min(n - 1, k)] + 12 * oct;
}

function pitchesPerOctave(p: number[]): number {
  if (p.length < 2) return 1;
  const first = p[0];
  let c = 0;
  for (const m of p) if (m < first + 12) c++;
  return c;
}

/** Inverse of mapY: where does a pitch sit on the vertical axis (nearest row). */
export function yForMidi(midi: number, pitches: number[]): number {
  if (pitches.length < 2) return 0.5;
  let best = 0;
  for (let i = 0; i < pitches.length; i++) if (Math.abs(pitches[i] - midi) < Math.abs(pitches[best] - midi)) best = i;
  return best / (pitches.length - 1);
}

/** Scale degree → MIDI. Degree 0 is the tonic in the octave starting at `base` (a MIDI note ≤ tonic). */
export function degreeToMidi(degree: number, root: number, scale: ScaleId, base: number, custom?: number[]): number {
  const iv = scaleIntervals(scale, custom);
  const n = iv.length;
  const oct = Math.floor(degree / n);
  const k = ((degree % n) + n) % n;
  const tonic = base + ((((root - base) % 12) + 12) % 12);
  return tonic + iv[k] + 12 * oct;
}

/** Nearest scale degree for a MIDI note, relative to the tonic at `base`. */
export function midiToDegree(midi: number, root: number, scale: ScaleId, base: number, custom?: number[]): number {
  const iv = scaleIntervals(scale, custom);
  const tonic = base + ((((root - base) % 12) + 12) % 12);
  const rel = midi - tonic;
  const oct = Math.floor(rel / 12);
  const pc = rel - oct * 12;
  let best = 0;
  for (let i = 0; i < iv.length; i++) if (Math.abs(iv[i] - pc) < Math.abs(iv[best] - pc)) best = i;
  return best + oct * iv.length;
}

// ------------------------------------------------------------------ scale character
// Different scales need different harmony rules. A seven-note scale stacks thirds; pentatonic,
// blues, symmetric and custom scales do not, so harmony for them is chosen from chord shapes
// whose tones the scale actually contains (src/theory/chords.ts).

export type ScaleFamily = 'heptatonic' | 'pentatonic' | 'blues' | 'symmetric' | 'chromatic' | 'other';

export function scaleFamily(scale: ScaleId, custom?: number[]): ScaleFamily {
  if (scale === 'majorBlues' || scale === 'minorBlues') return 'blues';
  if (scale === 'wholeTone' || scale === 'octatonic') return 'symmetric';
  if (scale === 'chromatic') return 'chromatic';
  const n = scaleIntervals(scale, custom).length;
  if (n === 7) return 'heptatonic';
  if (n === 5) return 'pentatonic';
  return n >= 11 ? 'chromatic' : 'other';
}

/** Modes whose identity comes from one or two "colour" tones rather than a leading-tone cadence. */
export const MODAL_SCALES = new Set<ScaleId>(['dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian', 'phrygianDominant']);

/** Intervals above the tonic that give a scale its character (what makes Dorian not minor). */
export const CHARACTERISTIC: Partial<Record<ScaleId, number[]>> = {
  major: [4, 11], minor: [8], harmonicMinor: [8, 11], melodicMinor: [9, 11], dorian: [9], phrygian: [1],
  lydian: [6], mixolydian: [10], locrian: [1, 6], phrygianDominant: [1, 4], minorBlues: [6], majorBlues: [3],
  wholeTone: [6, 8], octatonic: [3, 6],
};

export function characteristicPcs(root: number, scale: ScaleId): number[] {
  return (CHARACTERISTIC[scale] ?? []).map((i) => (root + i) % 12);
}

const ORD = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];
const INTERVAL_NAME = ['root', '♭9', '9th', '♯9 / minor 3rd', 'third', '4th / 11th', '♯11 / ♭5', 'fifth', '♯5 / ♭13', '6th / 13th', '7th', 'major 7th'];

/** "6th degree" for a pitch class of the scale, or null when it is outside the scale. */
export function degreeOrdinal(pc: number, root: number, scale: ScaleId, custom?: number[]): string | null {
  const iv = scaleIntervals(scale, custom);
  const k = iv.indexOf((((pc - root) % 12) + 12) % 12);
  return k < 0 ? null : `${ORD[k] ?? `${k + 1}th`} degree`;
}

export const intervalName = (semis: number) => INTERVAL_NAME[((semis % 12) + 12) % 12];

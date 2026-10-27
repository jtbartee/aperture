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

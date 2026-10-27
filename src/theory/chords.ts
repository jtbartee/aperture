import type { ScaleId } from '../core/types';
import { scaleIntervals } from './scales';

export type ChordQuality =
  | 'maj' | 'min' | 'dim' | 'aug' | 'sus2' | 'sus4' | 'maj7' | 'min7' | 'dom7' | 'min9' | 'maj9'
  | 'add9' | 'min7b5' | 'quartal' | 'cluster' | 'maj7s11' | 'min11';

/** Interval formulas in semitones above the chord root. */
export const CHORD_FORMULAS: Record<ChordQuality, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  dom7: [0, 4, 7, 10],
  min9: [0, 3, 7, 10, 14],
  maj9: [0, 4, 7, 11, 14],
  add9: [0, 4, 7, 14],
  min7b5: [0, 3, 6, 10],
  // extended atmospheric voicings
  quartal: [0, 5, 10, 15],
  cluster: [0, 2, 3, 7],
  maj7s11: [0, 4, 7, 11, 18],
  min11: [0, 3, 7, 10, 14, 17],
};

export const CHORD_SYMBOL: Record<ChordQuality, string> = {
  maj: '', min: 'm', dim: '°', aug: '+', sus2: 'sus2', sus4: 'sus4', maj7: 'maj7', min7: 'm7', dom7: '7',
  min9: 'm9', maj9: 'maj9', add9: 'add9', min7b5: 'ø7', quartal: 'q4', cluster: 'cl', maj7s11: 'maj7♯11', min11: 'm11',
};

export interface Chord {
  /** scale degree of the root (0-based, may exceed the scale length for chromatic chords) */
  degree: number;
  rootPc: number;
  quality: ChordQuality;
  /** pitch classes, root first */
  pcs: number[];
}

/** Recognise the quality of a stack of intervals (thirds stacked from a scale). */
function qualityFromIntervals(third: number, fifth: number, seventh?: number): ChordQuality {
  if (seventh === undefined) {
    if (third === 4 && fifth === 7) return 'maj';
    if (third === 3 && fifth === 7) return 'min';
    if (third === 3 && fifth === 6) return 'dim';
    if (third === 4 && fifth === 8) return 'aug';
    if (third === 2) return 'sus2';
    if (third === 5) return 'sus4';
    return third >= 4 ? 'maj' : 'min';
  }
  if (third === 4 && seventh === 11) return 'maj7';
  if (third === 4 && seventh === 10) return 'dom7';
  if (third === 3 && fifth === 6) return 'min7b5';
  return 'min7';
}

/** Diatonic chord on a scale degree by stacking scale thirds. `size` 3 = triad, 4 = seventh, 5 = ninth. */
export function diatonicChord(degree: number, root: number, scale: ScaleId, size = 3, custom?: number[]): Chord {
  const iv = scaleIntervals(scale, custom);
  const n = iv.length;
  const at = (d: number) => iv[((d % n) + n) % n] + 12 * Math.floor(d / n);
  const r = at(degree);
  // Scales with fewer than 7 notes do not stack in thirds cleanly; step by 2 anyway (gives quartal-ish colours).
  const tones = [0, 2, 4, 6, 8].slice(0, Math.max(3, Math.min(5, size))).map((k) => at(degree + k) - r);
  let quality = qualityFromIntervals(tones[1], tones[2], tones[3]);
  if (size >= 5) quality = tones[1] === 3 ? 'min9' : 'maj9';
  const pcs = tones.map((t) => (root + r + t) % 12);
  return { degree, rootPc: (root + r) % 12, quality, pcs };
}

export function chordFromQuality(rootPc: number, quality: ChordQuality, degree = 0): Chord {
  return { degree, rootPc, quality, pcs: CHORD_FORMULAS[quality].map((i) => (rootPc + i) % 12) };
}

/** Re-colour a diatonic chord: suspend, add9, extend — used by the atmospheric/ambient engines. */
export function colourChord(c: Chord, colour: 'plain' | 'sus2' | 'sus4' | 'add9' | 'seventh' | 'ninth' | 'quartal'): Chord {
  const isMinor = c.quality.startsWith('min') || c.quality === 'dim';
  switch (colour) {
    case 'sus2': return chordFromQuality(c.rootPc, 'sus2', c.degree);
    case 'sus4': return chordFromQuality(c.rootPc, 'sus4', c.degree);
    case 'add9': return chordFromQuality(c.rootPc, isMinor ? 'min9' : 'add9', c.degree);
    case 'seventh': return chordFromQuality(c.rootPc, c.quality === 'dim' ? 'min7b5' : isMinor ? 'min7' : c.quality === 'dom7' ? 'dom7' : 'maj7', c.degree);
    case 'ninth': return chordFromQuality(c.rootPc, isMinor ? 'min9' : 'maj9', c.degree);
    case 'quartal': return chordFromQuality(c.rootPc, 'quartal', c.degree);
    default: return c;
  }
}

export function chordSymbol(c: Chord, names: (pc: number) => string): string {
  return names(c.rootPc) + CHORD_SYMBOL[c.quality];
}

/** Close-position voicing of a chord with the given inversion, rooted at or above `floor`. */
export function voiceChord(c: Chord, floor: number, inversion = 0): number[] {
  const ivs = CHORD_FORMULAS[c.quality] ?? [0, 4, 7];
  let base = floor + ((((c.rootPc - floor) % 12) + 12) % 12);
  const notes = ivs.map((i) => base + i);
  for (let k = 0; k < inversion % notes.length; k++) notes.push(notes.shift()! + 12);
  base = notes[0];
  return notes.sort((a, b) => a - b);
}

/** All inversions of a chord in a register window; then choose the one with the least total
 *  movement from the previous voicing (with a small penalty for leaving the target centre). */
export function voiceLead(prev: number[] | null, c: Chord, lo: number, hi: number, maxNotes = 5): number[] {
  const ivs = CHORD_FORMULAS[c.quality].slice(0, maxNotes);
  const centre = (lo + hi) / 2;
  const candidates: number[][] = [];
  for (let floor = lo; floor <= hi - 7; floor++) {
    for (let inv = 0; inv < ivs.length; inv++) {
      const v = voiceChord({ ...c, quality: c.quality }, floor, inv).slice(0, maxNotes);
      if (v[0] >= lo && v[v.length - 1] <= hi + 4) candidates.push(v);
    }
  }
  if (!candidates.length) return voiceChord(c, lo, 0).slice(0, maxNotes);
  const unique = new Map(candidates.map((v) => [v.join(','), v]));
  let best: number[] = candidates[0];
  let bestCost = Infinity;
  for (const v of unique.values()) {
    const mean = v.reduce((s, x) => s + x, 0) / v.length;
    let cost = Math.abs(mean - centre) * 0.35;
    if (prev && prev.length) {
      // Each new note pays the distance to the nearest previous note — rewards common tones and steps.
      for (const n of v) cost += Math.min(...prev.map((p) => Math.abs(p - n)));
      for (const p of prev) cost += Math.min(...v.map((n) => Math.abs(p - n))) * 0.5;
    }
    // Avoid muddy low close intervals: a 2nd or 3rd below C3 is penalised.
    for (let i = 1; i < v.length; i++) if (v[i - 1] < 48 && v[i] - v[i - 1] < 5) cost += 6;
    if (cost < bestCost) { bestCost = cost; best = v; }
  }
  return best;
}

/** Spread voicing for pads: root low, remaining tones opened by an octave. */
export function openVoicing(c: Chord, floor: number): number[] {
  const close = voiceChord(c, floor, 0);
  return close.map((n, i) => (i % 2 === 1 && i < close.length - 1 ? n + 12 : n)).sort((a, b) => a - b);
}

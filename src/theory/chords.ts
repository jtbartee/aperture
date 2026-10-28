// CHORDS. A chord's pitch classes are the single truth: its name is recognised from them and its
// voicings are built from them (`ivs`), so the label on screen always matches what sounds.
//
// Seven-note scales stack thirds. Pentatonic, blues, symmetric and custom scales do not: stacking
// "every other note" of A minor pentatonic gives A–D–G, which is not an A minor seventh. For those
// scales a chord on a degree is chosen from a catalogue of shapes whose tones the scale contains.

import type { Chord, ChordQuality, ScaleId } from '../core/types';
import { scaleFamily, scaleIntervals } from './scales';

export type { Chord, ChordQuality } from '../core/types';

/** Interval formulas in semitones above the chord root. */
export const CHORD_FORMULAS: Record<ChordQuality, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  five: [0, 7],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  dom7: [0, 4, 7, 10],
  min7b5: [0, 3, 6, 10],
  dim7: [0, 3, 6, 9],
  six: [0, 4, 7, 9],
  min6: [0, 3, 7, 9],
  sus7: [0, 5, 7, 10],
  add9: [0, 4, 7, 14],
  madd9: [0, 3, 7, 14],
  minMaj7: [0, 3, 7, 11],
  maj7s5: [0, 4, 8, 11],
  aug7: [0, 4, 8, 10],
  dom7b5: [0, 4, 6, 10],
  maj9: [0, 4, 7, 11, 14],
  min9: [0, 3, 7, 10, 14],
  dom9: [0, 4, 7, 10, 14],
  six9: [0, 4, 7, 9, 14],
  min11: [0, 3, 7, 10, 14, 17],
  maj7s11: [0, 4, 7, 11, 18],
  // open / atmospheric structures
  quartal3: [0, 5, 10],
  quartal: [0, 5, 10, 15],
  cluster: [0, 2, 3, 7],
  other: [0],
};

export const CHORD_SYMBOL: Record<ChordQuality, string> = {
  maj: '', min: 'm', dim: '°', aug: '+', sus2: 'sus2', sus4: 'sus4', five: '5', maj7: 'maj7', min7: 'm7', dom7: '7',
  min7b5: 'ø7', dim7: '°7', six: '6', min6: 'm6', sus7: '7sus4', add9: 'add9', madd9: 'm(add9)', minMaj7: 'm(maj7)',
  maj7s5: 'maj7♯5', aug7: '7♯5', dom7b5: '7♭5', maj9: 'maj9', min9: 'm9', dom9: '9', six9: '6/9', min11: 'm11',
  maj7s11: 'maj7♯11', quartal3: '(4ths)', quartal: '(4ths)', cluster: '(cluster)', other: '',
};

/** Recognition order: the plainest name that fits wins (cluster {0,2,3,7} is named m(add9)). */
const RECOGNISE: ChordQuality[] = [
  'maj', 'min', 'dim', 'aug', 'sus2', 'sus4', 'five', 'maj7', 'min7', 'dom7', 'min7b5', 'dim7', 'six', 'min6', 'sus7',
  'add9', 'madd9', 'minMaj7', 'maj7s5', 'aug7', 'dom7b5', 'maj9', 'min9', 'dom9', 'six9', 'min11', 'maj7s11', 'quartal3', 'quartal',
];

const mod12 = (x: number) => ((x % 12) + 12) % 12;
const setKey = (xs: number[]) => [...new Set(xs.map(mod12))].sort((a, b) => a - b).join(',');
const FORMULA_KEYS = new Map(RECOGNISE.map((q) => [q, setKey(CHORD_FORMULAS[q])]));

/** The quality whose formula has exactly these intervals above the root, or 'other'. */
export function identifyQuality(ivs: number[]): ChordQuality {
  const k = setKey(ivs);
  for (const q of RECOGNISE) if (FORMULA_KEYS.get(q) === k) return q;
  return 'other';
}

/** The sounding template of a chord (semitones above its root, ascending). */
export function chordIntervals(c: Chord): number[] {
  return c.ivs?.length ? c.ivs : CHORD_FORMULAS[c.quality] ?? [0, 4, 7];
}

function makeChord(degree: number, rootPc: number, ivs: number[], scalePcs?: number[]): Chord {
  const sorted = [...ivs].sort((a, b) => a - b);
  const pcs = sorted.map((i) => mod12(rootPc + i)).filter((pc, i, a) => a.indexOf(pc) === i);
  const outside = scalePcs ? pcs.filter((pc) => !scalePcs.includes(pc)) : [];
  return { degree, rootPc: mod12(rootPc), quality: identifyQuality(sorted), pcs, ivs: sorted, ...(outside.length ? { outside } : {}) };
}

export function chordFromQuality(rootPc: number, quality: ChordQuality, degree = 0): Chord {
  return makeChord(degree, rootPc, CHORD_FORMULAS[quality]);
}

/** Chord shapes tried, in order of preference, for a stacked size (3 triad, 4 seventh, 5 ninth). */
const PREFER: Record<number, ChordQuality[]> = {
  3: ['maj', 'min', 'sus2', 'sus4', 'aug', 'dim', 'quartal3', 'five'],
  4: ['min7', 'dom7', 'maj7', 'six', 'min6', 'sus7', 'add9', 'madd9', 'min7b5', 'dim7', 'aug7', 'dom7b5', 'minMaj7', 'maj7s5', 'quartal'],
  5: ['min9', 'maj9', 'dom9', 'six9'],
};

/** The richest preferred shape on `rootPc` whose tones all belong to `pcs`, or null. */
export function shapeWithin(rootPc: number, pcs: number[], size: number): ChordQuality | null {
  const order = [...(PREFER[Math.min(5, size)] ?? []), ...(size > 4 ? PREFER[4] : []), ...(size > 3 ? PREFER[3] : [])];
  for (const q of order) if (CHORD_FORMULAS[q].every((i) => pcs.includes(mod12(rootPc + i)))) return q;
  return null;
}

/** Chord on a scale degree. Seven-note scales stack scale thirds (a ♭9 is left out, as players do);
 *  other scales use the catalogue so every chord tone is a scale tone. `size` 3 = triad, 4 = seventh,
 *  5 = ninth. */
export function diatonicChord(degree: number, root: number, scale: ScaleId, size = 3, custom?: number[]): Chord {
  const iv = scaleIntervals(scale, custom);
  const n = iv.length;
  const at = (d: number) => iv[((d % n) + n) % n] + 12 * Math.floor(d / n);
  const r = at(degree);
  const rootPc = mod12(root + r);
  const pcs = iv.map((i) => mod12(root + i));
  const sz = Math.max(3, Math.min(5, size));
  if (scaleFamily(scale, custom) === 'heptatonic') {
    let tones = [0, 2, 4, 6, 8].slice(0, sz).map((k) => at(degree + k) - r);
    if (tones.length === 5 && tones[4] === 13) tones = tones.slice(0, 4);
    return makeChord(degree, rootPc, tones, pcs);
  }
  const q = shapeWithin(rootPc, pcs, sz);
  if (q) return makeChord(degree, rootPc, CHORD_FORMULAS[q], pcs);
  // nothing tertian, suspended or quartal fits: the root with the nearest scale tones a third/fourth
  // and a fifth/sixth above (named for what it is)
  const up = (lo: number, hi: number) => { for (let s = lo; s <= hi; s++) if (pcs.includes(mod12(rootPc + s))) return s; return null; };
  const a = up(3, 5), b = up(6, 9);
  return makeChord(degree, rootPc, [0, ...(a !== null ? [a] : []), ...(b !== null ? [b] : [])], pcs);
}

/** A degree is a usable chord root when its chord is a recognised, scale-contained sonority
 *  (in a blues scale the blue note is a passing tone, not a root). */
export function stableDegree(degree: number, root: number, scale: ScaleId, custom?: number[]): boolean {
  if (scaleFamily(scale, custom) === 'heptatonic') return true;
  const c = diatonicChord(degree, root, scale, 3, custom);
  return c.quality !== 'other' && c.pcs.length >= 2;
}

export type Colour = 'plain' | 'sus2' | 'sus4' | 'add9' | 'six' | 'seventh' | 'ninth' | 'quartal';

export interface ScaleRef { root: number; scale: ScaleId; custom?: number[] }

/** Re-colour a chord: suspend, add a 9th or 6th, extend, or open into fourths. With a scale the
 *  colour is only applied when every new tone belongs to it (a seventh is the scale's own seventh:
 *  IV in Dorian becomes G7, never Gmaj7); otherwise the chord is returned unchanged. */
export function colourChord(c: Chord, colour: Colour, sc?: ScaleRef): Chord {
  if (colour === 'plain') return c;
  const isMinor = c.pcs.includes(mod12(c.rootPc + 3)) && !c.pcs.includes(mod12(c.rootPc + 4));
  const pcs = sc ? scaleIntervals(sc.scale, sc.custom).map((i) => mod12(sc.root + i)) : null;
  if ((colour === 'seventh' || colour === 'ninth') && sc && c.degree >= 0) {
    const ext = diatonicChord(c.degree, sc.root, sc.scale, colour === 'seventh' ? 4 : 5, sc.custom);
    return ext.rootPc === c.rootPc ? ext : c;
  }
  const want: Record<Exclude<Colour, 'plain'>, number[]> = {
    sus2: CHORD_FORMULAS.sus2, sus4: CHORD_FORMULAS.sus4,
    add9: isMinor ? CHORD_FORMULAS.madd9 : CHORD_FORMULAS.add9,
    six: isMinor ? CHORD_FORMULAS.min6 : CHORD_FORMULAS.six,
    seventh: isMinor ? CHORD_FORMULAS.min7 : c.quality === 'dim' ? CHORD_FORMULAS.min7b5 : c.quality === 'dom7' ? CHORD_FORMULAS.dom7 : CHORD_FORMULAS.maj7,
    ninth: isMinor ? CHORD_FORMULAS.min9 : CHORD_FORMULAS.maj9,
    quartal: CHORD_FORMULAS.quartal,
  };
  let ivs = want[colour];
  if (pcs && colour === 'quartal' && !ivs.every((i) => pcs.includes(mod12(c.rootPc + i)))) ivs = CHORD_FORMULAS.quartal3;
  if (pcs && !ivs.every((i) => pcs.includes(mod12(c.rootPc + i)))) return c;
  return makeChord(c.degree, c.rootPc, ivs, pcs ?? undefined);
}

const SHORT = ['1', '♭9', '9', '♭3', '3', '4', '♭5', '5', '♯5', '6', '♭7', '7'];

/** The name of what sounds: "Am7", "C6", "D7sus4", an inversion "Am/C" when the root set
 *  matches better from another tone, else the root with its intervals, "B(♭3,♭5,♭7)". */
export function chordSymbol(c: Chord, names: (pc: number) => string): string {
  const ivs = chordIntervals(c);
  const q = c.ivs?.length ? identifyQuality(ivs) : c.quality;
  if (q !== 'other') return names(c.rootPc) + CHORD_SYMBOL[q];
  for (const alt of c.pcs.slice(1)) {
    const aq = identifyQuality(c.pcs.map((pc) => mod12(pc - alt)));
    if (aq !== 'other' && aq !== 'five') return `${names(alt)}${CHORD_SYMBOL[aq]}/${names(c.rootPc)}`;
  }
  return `${names(c.rootPc)}(${ivs.slice(1).map((i) => SHORT[mod12(i)]).join(',')})`;
}

/** Close-position voicing of a chord with the given inversion, rooted at or above `floor`. */
export function voiceChord(c: Chord, floor: number, inversion = 0): number[] {
  const ivs = chordIntervals(c);
  const base = floor + mod12(c.rootPc - floor);
  const notes = ivs.map((i) => base + i);
  for (let k = 0; k < inversion % notes.length; k++) notes.push(notes.shift()! + 12);
  return notes.sort((a, b) => a - b);
}

/** All inversions of a chord in a register window; then choose the one with the least total
 *  movement from the previous voicing (with a small penalty for leaving the target centre). */
export function voiceLead(prev: number[] | null, c: Chord, lo: number, hi: number, maxNotes = 5): number[] {
  const ivs = chordIntervals(c).slice(0, maxNotes);
  const cc: Chord = { ...c, ivs };
  const centre = (lo + hi) / 2;
  const candidates: number[][] = [];
  for (let floor = lo; floor <= hi - 7; floor++) {
    for (let inv = 0; inv < ivs.length; inv++) {
      const v = voiceChord(cc, floor, inv);
      if (v[0] >= lo && v[v.length - 1] <= hi + 4) candidates.push(v);
    }
  }
  if (!candidates.length) return voiceChord(cc, lo, 0);
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

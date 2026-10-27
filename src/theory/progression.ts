import type { Beats, ScaleId } from '../core/types';
import type { Rng } from '../core/rng';
import { type Chord, chordFromQuality, colourChord, diatonicChord } from './chords';
import { scaleIntervals } from './scales';

export type ProgressionType =
  | 'diatonic' | 'modal' | 'pedal' | 'static' | 'circular' | 'tension' | 'sparse' | 'chromatic';

export const PROGRESSION_TYPES: { id: ProgressionType; label: string }[] = [
  { id: 'diatonic', label: 'Diatonic (functional)' },
  { id: 'modal', label: 'Modal' },
  { id: 'pedal', label: 'Pedal point' },
  { id: 'static', label: 'Static drone' },
  { id: 'circular', label: 'Circle of fifths' },
  { id: 'tension', label: 'Tension → release' },
  { id: 'sparse', label: 'Sparse ambient' },
  { id: 'chromatic', label: 'Chromatic movement' },
];

export interface ChordSlot {
  start: Beats;
  dur: Beats;
  chord: Chord;
  /** pitch class the bass should hold (pedal point) — defaults to the chord root */
  bassPc: number;
}

/** Functional transition weights between the seven diatonic degrees (row = from). */
const MARKOV: number[][] = [
  /* I   */ [0.02, 0.15, 0.05, 0.3, 0.25, 0.2, 0.03],
  /* ii  */ [0.05, 0.0, 0.03, 0.1, 0.55, 0.12, 0.15],
  /* iii */ [0.05, 0.15, 0.0, 0.3, 0.0, 0.5, 0.0],
  /* IV  */ [0.25, 0.15, 0.03, 0.0, 0.35, 0.12, 0.1],
  /* V   */ [0.55, 0.02, 0.05, 0.08, 0.0, 0.3, 0.0],
  /* vi  */ [0.05, 0.35, 0.08, 0.37, 0.15, 0.0, 0.0],
  /* vii */ [0.7, 0.0, 0.1, 0.0, 0.0, 0.2, 0.0],
];

export interface ProgressionOptions {
  type: ProgressionType;
  /** total length in beats */
  beats: Beats;
  barBeats: Beats;
  root: number;
  scale: ScaleId;
  custom?: number[];
  /** bars per chord (may be fractional, e.g. 0.5) */
  harmonicRhythm: number;
  tension: number; // 0..1: sevenths, dominants, chromatic colour
  chordSize?: number; // 3..5
  rng: Rng;
  /** optional external guide (e.g. image hue): preferred degree at a normalised time, with strength 0..1 */
  guide?: (t01: number) => { degree: number; strength: number; colour?: number };
}

const degreeCount = (scale: ScaleId, custom?: number[]) => scaleIntervals(scale, custom).length;

export function generateProgression(o: ProgressionOptions): ChordSlot[] {
  const n = degreeCount(o.scale, o.custom);
  const slotBeats = Math.max(o.barBeats / 2, o.harmonicRhythm * o.barBeats);
  const slots = Math.max(1, Math.round(o.beats / slotBeats));
  const size = o.chordSize ?? (o.tension > 0.55 ? 4 : 3);
  const tonicPc = o.root;
  const out: ChordSlot[] = [];
  let deg = 0;
  let chromaRoot = o.root;
  const phraseLen = slots >= 8 ? 4 : Math.max(2, slots);
  const circle = [0, 3, 6, 2, 5, 1, 4];
  for (let i = 0; i < slots; i++) {
    const t01 = i / slots;
    let chord: Chord;
    let bassPc: number | undefined;
    const guide = o.guide?.(t01);
    switch (o.type) {
      case 'static': {
        const colours = ['plain', 'sus2', 'add9', 'sus4'] as const;
        chord = colourChord(diatonicChord(0, o.root, o.scale, 3, o.custom), i === 0 ? 'plain' : o.rng.pick(colours));
        break;
      }
      case 'circular': {
        deg = circle[i % circle.length] % n;
        chord = diatonicChord(deg, o.root, o.scale, size, o.custom);
        break;
      }
      case 'chromatic': {
        if (i > 0) {
          const moves = [3, -3, 4, -4, 1, -1, 5, -5];
          const w = [1, 1, 1, 1, o.tension * 2, o.tension * 2, 0.6, 0.6];
          chromaRoot = (chromaRoot + o.rng.weighted(moves, w) + 12) % 12;
          if (o.rng.chance(0.3)) chromaRoot = o.root; // keep a home
        }
        const q = o.rng.chance(0.5) ? (o.tension > 0.5 ? 'min7' : 'min') : (o.tension > 0.5 ? 'maj7' : 'maj');
        chord = chordFromQuality(chromaRoot, q, -1);
        break;
      }
      case 'modal': {
        // Alternate the tonic with the mode's colour chords (II, VII, IV) — avoids the dominant pull.
        const colourDegrees = [1, n - 1, 3, 2].filter((d) => d > 0 && d < n);
        deg = i % 2 === 0 ? 0 : o.rng.pick(colourDegrees);
        if (guide && guide.strength > 0.4) deg = guide.degree % n;
        chord = diatonicChord(deg, o.root, o.scale, size, o.custom);
        break;
      }
      case 'sparse': {
        const pool = [0, 3, 5, 2].filter((d) => d < n);
        deg = i === 0 ? 0 : o.rng.weighted(pool, [3, 2, 2, 1]);
        if (guide && guide.strength > 0.3) deg = guide.degree % n;
        chord = colourChord(diatonicChord(deg, o.root, o.scale, 3, o.custom), o.rng.pick(['add9', 'sus2', 'plain', 'seventh'] as const));
        break;
      }
      case 'tension': {
        // Phrase arc: start home, lean toward the dominant at the phrase end, resolve on the next downbeat.
        const pos = i % phraseLen;
        if (pos === 0) deg = 0;
        else if (pos === phraseLen - 1) deg = o.rng.chance(0.75) ? 4 % n : 6 % n;
        else deg = o.rng.weighted([1, 3, 5, 2].map((d) => d % n), [2, 3, 2, 1]);
        const c = diatonicChord(deg, o.root, o.scale, pos === phraseLen - 1 && o.tension > 0.3 ? 4 : size, o.custom);
        chord = pos === phraseLen - 1 && deg === 4 % n && o.tension > 0.5 ? chordFromQuality(c.rootPc, 'dom7', deg) : c;
        break;
      }
      default: {
        // diatonic + pedal share the functional Markov chain
        if (i > 0) {
          const row = MARKOV[deg % 7].slice(0, n).map((w, j) => (j < n ? w : 0));
          if (guide) {
            for (let j = 0; j < row.length; j++) if (j === guide.degree % n) row[j] += guide.strength * 1.5;
          }
          // cadence pull at phrase ends
          if (i % phraseLen === phraseLen - 1) row[4 % n] += o.tension * 0.6;
          if (i % phraseLen === 0) row[0] += 0.4;
          deg = o.rng.weighted(row.map((_, j) => j), row);
        }
        chord = diatonicChord(deg, o.root, o.scale, size, o.custom);
        if (o.type === 'pedal') bassPc = tonicPc;
      }
    }
    if (guide?.colour !== undefined && o.type !== 'chromatic') {
      // saturation-style colour from a guide: 0 plain → 1 lush
      const c = guide.colour;
      if (c > 0.75) chord = colourChord(chord, 'ninth');
      else if (c > 0.5) chord = colourChord(chord, 'seventh');
      else if (c < 0.15) chord = colourChord(chord, 'sus2');
    }
    const prev = out[out.length - 1];
    if (prev && prev.chord.rootPc === chord.rootPc && prev.chord.quality === chord.quality && o.type !== 'static') {
      prev.dur += slotBeats; // merge repeats into longer harmonic rhythm
      continue;
    }
    out.push({ start: i * slotBeats, dur: slotBeats, chord, bassPc: bassPc ?? chord.rootPc });
  }
  // stretch the final chord to the end
  const last = out[out.length - 1];
  if (last) last.dur = Math.max(last.dur, o.beats - last.start);
  return out;
}

export function chordAt(slots: ChordSlot[], beat: Beats): ChordSlot {
  let lo = 0;
  for (let i = 0; i < slots.length; i++) if (slots[i].start <= beat + 1e-6) lo = i;
  return slots[lo];
}

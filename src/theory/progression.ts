// PROGRESSIONS. Each approach decides chord ROOTS (scale degrees) and their harmonic function; the
// chord on each root comes from chords.ts, so it always belongs to the scale family's vocabulary.
//
// Modes are not treated as major keys: a Dorian cadence is IV→i or ♭VII→i, never A7→Dm. Functional
// dominant pull only exists where the scale has a leading tone (major, harmonic/melodic minor); in
// natural minor the raised-leading-tone V is a deliberate, labelled borrowing that only the
// Expressive and Experimental behaviours may use.
//
//   strict       — every chord tone is a scale tone (user-typed chords excepted, and flagged)
//   expressive   — suspensions at cadences, scale-contained colour, a borrowed V in minor, blues
//                  backing chords (i7–iv7–v7) whose outside tones are flagged
//   experimental — chromatic mediants, ♭VI/♭II borrowings and planing, still anchored on the tonic

import type { Beats, ChordColour, ChordSlot, HarmonicFunction, HarmonyBehavior, ScaleId } from '../core/types';
import type { Rng } from '../core/rng';
import { type Chord, type Colour, CHORD_FORMULAS, chordFromQuality, colourChord, diatonicChord, identifyQuality, stableDegree, type ScaleRef } from './chords';
import { MODAL_SCALES, scaleFamily, scaleIntervals, characteristicPcs } from './scales';

export type { ChordSlot } from '../core/types';

export type ProgressionType = 'diatonic' | 'modal' | 'pedal' | 'static' | 'circular' | 'sparse' | 'tension' | 'chromatic' | 'custom';

export const PROGRESSION_TYPES: { id: ProgressionType; label: string; title: string }[] = [
  { id: 'diatonic', label: 'Functional', title: 'Chords move by function toward the scale’s own cadence' },
  { id: 'modal', label: 'Modal vamp', title: 'Tonic alternating with the chords that carry the mode’s colour tone' },
  { id: 'pedal', label: 'Pedal point', title: 'Chords move over a held tonic bass' },
  { id: 'static', label: 'Static / drone', title: 'One tonal centre; only its colour changes' },
  { id: 'circular', label: 'Circular', title: 'Descending fifths through the scale' },
  { id: 'sparse', label: 'Slowly evolving', title: 'Long chords, each sharing tones with the last' },
  { id: 'tension', label: 'Tension → resolution', title: 'Phrases depart, build to the scale’s cadence and resolve' },
  { id: 'chromatic', label: 'Chromatic movement', title: 'Chromatic mediants and planing (Experimental only)' },
  { id: 'custom', label: 'Your chord sequence', title: 'Plays the chords you type, e.g. “Dm7 G Am7 C” or “i IV i bVII”' },
];

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

/** The chord that leads home in each heptatonic scale (degree index). */
const CADENCE: Partial<Record<ScaleId, number>> = {
  major: 4, harmonicMinor: 4, melodicMinor: 4, minor: 4, dorian: 3, phrygian: 1, lydian: 1, mixolydian: 6, locrian: 1, phrygianDominant: 1,
};

/** Colour chords for a modal vamp, most characteristic first. */
const VAMP: Partial<Record<ScaleId, number[]>> = {
  dorian: [3, 1, 6], phrygian: [1, 6, 2], lydian: [1, 4, 6], mixolydian: [6, 4, 3], minor: [5, 6, 3], major: [3, 4, 5],
  harmonicMinor: [4, 5, 3], melodicMinor: [3, 1, 4], locrian: [1, 6, 4], phrygianDominant: [1, 6, 3],
};

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
  tension: number; // 0..1: sevenths, cadential pull, suspensions
  chordSize?: number; // 3..5
  behavior?: HarmonyBehavior;
  colour?: ChordColour;
  /** user chord sequence for type 'custom' */
  sequence?: string;
  rng: Rng;
  /** optional external guide (e.g. image hue): preferred degree at a normalised time, with strength 0..1 */
  guide?: (t01: number) => { degree: number; strength: number; colour?: number };
}

const mod12 = (x: number) => ((x % 12) + 12) % 12;

/** Degree whose chord resolves to the tonic in this scale. Non-heptatonic scales use the usable
 *  degree whose root lies a fifth above (or a fourth above) the tonic. */
export function cadenceDegree(root: number, scale: ScaleId, custom?: number[]): number {
  const fam = scaleFamily(scale, custom);
  if (fam === 'heptatonic' && CADENCE[scale] !== undefined) return CADENCE[scale]!;
  const iv = scaleIntervals(scale, custom);
  for (const want of [7, 5, 10, 2]) {
    const d = iv.indexOf(want);
    if (d > 0 && stableDegree(d, root, scale, custom)) return d;
  }
  return Math.min(1, iv.length - 1);
}

/** Usable non-tonic roots for vamps and colour, most characteristic first. */
export function colourDegrees(root: number, scale: ScaleId, custom?: number[]): number[] {
  const n = scaleIntervals(scale, custom).length;
  const fam = scaleFamily(scale, custom);
  if (fam === 'heptatonic' && VAMP[scale]) return VAMP[scale]!;
  const tonic = diatonicChord(0, root, scale, 3, custom);
  const ch = characteristicPcs(root, scale);
  return Array.from({ length: n - 1 }, (_, i) => i + 1)
    .filter((d) => stableDegree(d, root, scale, custom))
    .map((d) => { const c = diatonicChord(d, root, scale, 3, custom); return { d, s: c.pcs.filter((pc) => tonic.pcs.includes(pc)).length + (c.pcs.some((pc) => ch.includes(pc)) ? 0.5 : 0) }; })
    .sort((a, b) => b.s - a.s || a.d - b.d)
    .map((x) => x.d);
}

// ------------------------------------------------------------------ user chord sequences

const SUFFIX: [RegExp, keyof typeof CHORD_FORMULAS][] = [
  [/^(maj7#11|maj7♯11|M7#11)$/, 'maj7s11'], [/^(m\(maj7\)|mM7|m\(M7\)|minmaj7)$/, 'minMaj7'], [/^(m7b5|m7♭5|ø7?|min7b5)$/, 'min7b5'],
  [/^(dim7|°7|o7)$/, 'dim7'], [/^(maj9|M9|Δ9)$/, 'maj9'], [/^(maj7|M7|Δ7?|ma7)$/, 'maj7'], [/^(m9|min9|-9)$/, 'min9'],
  [/^(m11|min11|-11)$/, 'min11'], [/^(madd9|m\(add9\)|m2)$/, 'madd9'], [/^(m7|min7|-7)$/, 'min7'], [/^(m6|min6|-6)$/, 'min6'],
  [/^(7sus4|7sus)$/, 'sus7'], [/^(6\/9|69)$/, 'six9'], [/^(7#5|7♯5|7\+|aug7|\+7)$/, 'aug7'], [/^(7b5|7♭5)$/, 'dom7b5'],
  [/^(add9|2|add2)$/, 'add9'], [/^9$/, 'dom9'], [/^7$/, 'dom7'], [/^6$/, 'six'], [/^5$/, 'five'],
  [/^(sus2)$/, 'sus2'], [/^(sus4|sus)$/, 'sus4'], [/^(dim|°|o)$/, 'dim'], [/^(aug|\+)$/, 'aug'], [/^(m|min|-)$/, 'min'],
  [/^(q|4ths|quartal)$/, 'quartal'], [/^(maj|M)?$/, 'maj'],
];

const LETTER: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ROMAN = ['vii', 'iii', 'vi', 'iv', 'ii', 'v', 'i'];
const ROMAN_DEG: Record<string, number> = { i: 0, ii: 1, iii: 2, iv: 3, v: 4, vi: 5, vii: 6 };
const MAJOR = [0, 2, 4, 5, 7, 9, 11];

export interface ParsedChord { chord: Chord; bassPc: number; absolute: boolean }

/** Parse "Dm7 G7 | Cmaj7 A7" or Roman numerals relative to the scale ("i IV i bVII"). Roman
 *  numerals without a suffix take the scale's own chord on that degree; letter symbols are absolute. */
export function parseChordSequence(text: string, root: number, scale: ScaleId, custom?: number[]): { chords: ParsedChord[]; errors: string[] } {
  const iv = scaleIntervals(scale, custom);
  const pcs = iv.map((i) => mod12(root + i));
  const chords: ParsedChord[] = [];
  const errors: string[] = [];
  for (const raw of text.split(/[\s,|→–]+/).map((t) => t.trim()).filter(Boolean)) {
    const [body, slash] = raw.split('/').length === 2 && /^[A-G][#b♯♭]?$/.test(raw.split('/')[1]) ? raw.split('/') : [raw, undefined];
    let rootPc: number | null = null;
    let suffix = '';
    let roman: { deg: number; upper: boolean } | null = null;
    const sym = /^([A-G])([#b♯♭]?)(.*)$/.exec(body);
    const rom = /^([b#♭♯]?)(vii|iii|vi|iv|ii|v|i|VII|III|VI|IV|II|V|I)(.*)$/.exec(body);
    if (sym) {
      rootPc = mod12(LETTER[sym[1]] + (sym[2] === '#' || sym[2] === '♯' ? 1 : sym[2] ? -1 : 0));
      suffix = sym[3];
    } else if (rom) {
      const low = rom[2].toLowerCase();
      if (!ROMAN.includes(low)) { errors.push(raw); continue; }
      // numerals count from the major scale (♭VII is a whole step below the tonic in every mode)
      const acc = rom[1] === 'b' || rom[1] === '♭' ? -1 : rom[1] ? 1 : 0;
      rootPc = mod12(root + MAJOR[ROMAN_DEG[low]] + acc);
      suffix = rom[3];
      const inside = pcs.indexOf(rootPc);
      roman = inside >= 0 ? { deg: inside, upper: rom[2] !== low } : null;
    } else { errors.push(raw); continue; }
    const q = SUFFIX.find(([re]) => re.test(suffix.replace(/[()]/g, (m) => m)))?.[1];
    if (q === undefined) { errors.push(raw); continue; }
    let chord: Chord;
    if (roman && suffix === '') {
      // the scale's own chord on that degree, unless the numeral's case asks for the other quality
      const d = diatonicChord(roman.deg, root, scale, 3, custom);
      const major = d.pcs.includes(mod12(d.rootPc + 4));
      chord = major === roman.upper || d.quality === 'dim' || d.quality === 'aug' ? d : chordFromQuality(d.rootPc, roman.upper ? 'maj' : 'min', roman.deg);
    } else {
      const lowerRoman = rom && !sym && rom[2] === rom[2].toLowerCase() && q === 'maj' && suffix === '';
      chord = chordFromQuality(rootPc, lowerRoman ? 'min' : q, pcs.indexOf(rootPc));
    }
    const outside = chord.pcs.filter((pc) => !pcs.includes(pc));
    chord = { ...chord, degree: pcs.indexOf(chord.rootPc), ...(outside.length ? { outside } : {}) };
    const bassPc = slash ? mod12(LETTER[slash[0]] + (slash[1] === '#' || slash[1] === '♯' ? 1 : slash[1] ? -1 : 0)) : chord.rootPc;
    chords.push({ chord, bassPc, absolute: !!sym });
  }
  return { chords, errors };
}

// ------------------------------------------------------------------ generation

function sizeFor(o: ProgressionOptions): number {
  if (o.chordSize) return o.chordSize;
  switch (o.colour) {
    case 'triads': case 'sus': return 3;
    case 'sevenths': case 'added': return 4;
    case 'ninths': return 5;
    case 'quartal': return 4;
    default: return o.tension > 0.55 ? 4 : 3;
  }
}

/** The chord colour a slot gets from the colour setting (always checked against the scale). */
function colourFor(o: ProgressionOptions, i: number, r: Rng): Colour {
  switch (o.colour) {
    case 'sus': return i % 2 ? 'sus4' : 'sus2';
    case 'added': return r.chance(0.5) ? 'add9' : 'six';
    case 'quartal': return 'quartal';
    default: return 'plain';
  }
}

interface Step { deg: number; func: HarmonicFunction; tension: number; colour?: Colour; chord?: Chord; bassPc?: number; absolute?: boolean }

export function generateProgression(o: ProgressionOptions): ChordSlot[] {
  const behavior: HarmonyBehavior = o.behavior ?? 'expressive';
  const type: ProgressionType = o.type === 'chromatic' && behavior !== 'experimental' ? 'sparse' : o.type;
  const iv = scaleIntervals(o.scale, o.custom);
  const n = iv.length;
  const fam = scaleFamily(o.scale, o.custom);
  const sc: ScaleRef = { root: o.root, scale: o.scale, custom: o.custom };
  const slotBeats = Math.max(o.barBeats / 2, o.harmonicRhythm * o.barBeats);
  const slots = Math.max(1, Math.round(o.beats / slotBeats));
  const size = sizeFor(o);
  const usable = Array.from({ length: n }, (_, d) => d).filter((d) => d === 0 || stableDegree(d, o.root, o.scale, o.custom));
  const cad = cadenceDegree(o.root, o.scale, o.custom);
  const colours = colourDegrees(o.root, o.scale, o.custom);
  const phraseLen = slots >= 8 ? 4 : Math.max(2, slots);
  const modal = MODAL_SCALES.has(o.scale);
  const steps: Step[] = [];
  let deg = 0;

  // user chord sequence: cycle it across the piece
  if (type === 'custom') {
    const parsed = parseChordSequence(o.sequence ?? '', o.root, o.scale, o.custom).chords;
    if (parsed.length) {
      for (let i = 0; i < slots; i++) {
        const p = parsed[i % parsed.length];
        steps.push({ deg: p.chord.degree, func: p.chord.degree === 0 ? 'tonic' : 'colour', tension: p.chord.degree === 0 ? 0 : 0.4, chord: p.chord, bassPc: p.bassPc, absolute: p.absolute });
      }
    }
  }

  const circle = fam === 'heptatonic' ? [0, 3, 6, 2, 5, 1, 4] : fifthsChain(usable, iv);
  let chromaRoot = o.root;
  for (let i = steps.length ? slots : 0; i < slots; i++) {
    const t01 = i / slots;
    const pos = i % phraseLen;
    const guide = o.guide?.(t01);
    const g = guide && usable.includes(guide.degree % n) ? guide : undefined;
    let st: Step;
    switch (type) {
      case 'static': {
        const cols: Colour[] = ['plain', 'sus2', 'add9', 'sus4'];
        st = { deg: 0, func: 'tonic', tension: 0.1, colour: i === 0 ? 'plain' : o.rng.pick(cols) };
        break;
      }
      case 'circular': {
        deg = circle[i % circle.length] % n;
        st = { deg, func: deg === 0 ? 'tonic' : deg === cad ? 'dominant' : 'pre', tension: deg === cad ? 0.8 : 0.4 };
        break;
      }
      case 'chromatic': {
        // experimental only: chromatic mediants and planing around a tonal home
        if (i > 0) {
          const moves = [3, -3, 4, -4, 1, -1, 5, -5];
          const w = [1, 1, 1, 1, o.tension * 2, o.tension * 2, 0.6, 0.6];
          chromaRoot = mod12(chromaRoot + o.rng.weighted(moves, w));
          if (pos === 0 || o.rng.chance(0.25)) chromaRoot = o.root;
        }
        const home = chromaRoot === o.root;
        const c = home
          ? diatonicChord(0, o.root, o.scale, size, o.custom)
          : chordFromQuality(chromaRoot, o.rng.chance(0.5) ? (o.tension > 0.5 ? 'min7' : 'min') : (o.tension > 0.5 ? 'maj7' : 'maj'), iv.indexOf(mod12(chromaRoot - o.root)));
        st = { deg: Math.max(0, c.degree), func: home ? 'tonic' : 'chromatic', tension: home ? 0 : 0.6, chord: c };
        break;
      }
      case 'modal':
      case 'pedal': {
        // a vamp: tonic, the mode's colour chord, tonic, a second colour — repeated, with small changes
        const a = colours[0] ?? 0, b = colours[1] ?? a;
        deg = pos % 2 === 0 ? 0 : (pos === 3 || o.rng.chance(0.25)) ? b : a;
        if (g && g.strength > 0.4) deg = g.degree % n;
        st = { deg, func: type === 'pedal' ? 'pedal' : deg === 0 ? 'tonic' : 'colour', tension: deg === 0 ? 0 : 0.35 };
        break;
      }
      case 'sparse': {
        // slowly evolving: each chord shares tones with the last; home returns every few changes
        if (i === 0 || pos === 0 && i >= phraseLen * 2 && o.rng.chance(0.5)) deg = 0;
        else {
          const prev = diatonicChord(deg, o.root, o.scale, 3, o.custom);
          const cand = usable.filter((d) => d !== deg);
          const w = cand.map((d) => { const c = diatonicChord(d, o.root, o.scale, 3, o.custom); const common = c.pcs.filter((pc) => prev.pcs.includes(pc)).length; return (common >= 2 ? 3 : common === 1 ? 1 : 0.2) * (d === 0 ? 1.4 : 1) * (c.quality === 'dim' ? 0.2 : 1); });
          deg = o.rng.weighted(cand, w);
        }
        if (g && g.strength > 0.3) deg = g.degree % n;
        st = { deg, func: deg === 0 ? 'tonic' : 'colour', tension: deg === 0 ? 0 : 0.3 };
        break;
      }
      case 'tension': {
        // phrase arc: home → departure → the scale's own cadence → resolution on the next downbeat
        const pre = usable.filter((d) => d !== 0 && d !== cad && diatonicChord(d, o.root, o.scale, 3, o.custom).quality !== 'dim');
        if (pos === 0) deg = 0;
        else if (pos === phraseLen - 1) deg = cad;
        else deg = pre.length ? o.rng.weighted(pre, pre.map((d) => (colours.includes(d) ? 2 : 1))) : 0;
        if (g && g.strength > 0.5 && pos !== 0 && pos !== phraseLen - 1) deg = g.degree % n;
        st = { deg, func: pos === 0 ? 'tonic' : pos === phraseLen - 1 ? 'dominant' : 'pre', tension: pos === 0 ? 0 : pos === phraseLen - 1 ? 0.9 : 0.3 + 0.4 * (pos / phraseLen) };
        break;
      }
      default: {
        // functional ('diatonic'): heptatonic scales walk the Markov chain toward their cadence;
        // blues uses its own form; other scales move by fourths/fifths between usable roots
        if (fam === 'blues' && behavior !== 'strict') {
          st = bluesStep(i, o, cad);
          break;
        }
        if (i > 0) {
          let row: number[];
          if (fam === 'heptatonic') row = MARKOV[deg % 7].map((w, j) => (usable.includes(j) ? w : 0));
          else row = Array.from({ length: n }, (_, j) => (!usable.includes(j) || j === deg ? 0 : fifthRelated(iv[deg], iv[j]) ? 1 : 0.35));
          if (fam === 'heptatonic' && modal) row[4] *= o.scale === 'mixolydian' ? 0.6 : 0.2; // a modal v is colour, not a dominant
          if (g) row[g.degree % n] += g.strength * 1.5;
          if (pos === phraseLen - 1) row[cad] += 0.3 + o.tension * 0.6;
          if (pos === 0) row[0] += 0.4;
          deg = o.rng.weighted(row.map((_, j) => j), row);
        }
        st = { deg, func: deg === 0 ? 'tonic' : deg === cad ? 'dominant' : 'pre', tension: deg === 0 ? 0 : deg === cad ? 0.75 : 0.35 };
      }
    }
    // experimental: an occasional chromatic substitution away from phrase starts
    if (behavior === 'experimental' && type !== 'chromatic' && type !== 'static' && pos !== 0 && o.rng.chance(0.08 + o.tension * 0.22)) {
      // a chromatic mediant of the chord it replaces, or the borrowed ♭VI / ♭II of the tonic
      const kind = o.rng.pick(['mediant', 'mediant', 'flatSix', 'flatTwo'] as const);
      const rootPc = kind === 'flatSix' ? mod12(o.root + 8) : kind === 'flatTwo' ? mod12(o.root + 1) : mod12(o.root + iv[st.deg % n] + o.rng.pick([3, -3, 4, -4]));
      const c = chordFromQuality(rootPc, o.rng.chance(0.5) ? 'maj' : 'maj7', iv.indexOf(mod12(rootPc - o.root)));
      const pcsIn = iv.map((x) => mod12(o.root + x));
      const outside = c.pcs.filter((pc) => !pcsIn.includes(pc));
      st = { ...st, chord: { ...c, ...(outside.length ? { outside } : {}) }, func: 'chromatic', tension: 0.65 };
    }
    steps.push(st);
  }

  // realise chords
  const out: ChordSlot[] = [];
  steps.forEach((st, i) => {
    let chord = st.chord ?? diatonicChord(st.deg, o.root, o.scale, size, o.custom);
    if (!st.chord) {
      const colour = st.colour ?? colourFor(o, i, o.rng);
      chord = colourChord(chord, colour, sc);
      const guide = o.guide?.(i / slots);
      if (guide?.colour !== undefined) {
        const c = guide.colour;
        chord = colourChord(chord, c > 0.75 ? 'ninth' : c > 0.5 ? 'seventh' : c < 0.15 ? 'sus2' : 'plain', sc);
      }
      // expressive cadences: a minor-key dominant may borrow the leading tone (labelled, never strict)
      if (st.func === 'dominant' && o.scale === 'minor' && behavior !== 'strict' && o.tension > 0.6 && st.deg === 4) {
        const v = chordFromQuality(chord.rootPc, size >= 4 ? 'dom7' : 'maj', 4);
        chord = { ...v, outside: v.pcs.filter((pc) => !iv.map((x) => mod12(o.root + x)).includes(pc)) };
      }
    }
    const bassPc = st.bassPc ?? (type === 'pedal' ? o.root : chord.rootPc);
    const prev = out[out.length - 1];
    if (prev && prev.chord.rootPc === chord.rootPc && prev.chord.pcs.join() === chord.pcs.join() && prev.bassPc === bassPc && type !== 'static' && type !== 'custom') {
      prev.dur += slotBeats; // merge repeats into longer harmonic rhythm
      return;
    }
    // expressive suspension: the cadence chord enters as a sus4 and resolves halfway
    if (behavior !== 'strict' && st.func === 'dominant' && o.tension > 0.3 && slotBeats >= o.barBeats && !st.chord) {
      const sus = colourChord(chord, 'sus4', sc);
      if (sus !== chord) {
        out.push({ start: i * slotBeats, dur: slotBeats / 2, chord: sus, bassPc, func: 'dominant', tension: Math.min(1, st.tension + 0.1), size });
        out.push({ start: i * slotBeats + slotBeats / 2, dur: slotBeats / 2, chord, bassPc, func: 'dominant', tension: st.tension, size });
        return;
      }
    }
    out.push({ start: i * slotBeats, dur: slotBeats, chord, bassPc, func: st.func, tension: st.tension, size, ...(st.absolute ? { absolute: true } : {}) });
  });
  // stretch the final chord to the end
  const last = out[out.length - 1];
  if (last) last.dur = Math.max(last.dur, o.beats - last.start);
  // every chord states which of its tones lie outside the scale (borrowed, blues, chromatic, typed)
  const scalePcs = iv.map((x) => mod12(o.root + x));
  return out.map((sl) => {
    const outside = sl.chord.pcs.filter((pc) => !scalePcs.includes(pc));
    const { outside: _drop, ...rest } = sl.chord;
    void _drop;
    return { ...sl, chord: outside.length ? { ...rest, outside } : rest };
  });
}

function fifthRelated(a: number, b: number): boolean {
  const d = mod12(b - a);
  return d === 5 || d === 7;
}

/** Usable degrees ordered as a chain of descending fifths (or the nearest substitute). */
function fifthsChain(usable: number[], iv: number[]): number[] {
  const out = [0];
  const left = usable.filter((d) => d !== 0);
  while (left.length) {
    const cur = iv[out[out.length - 1]];
    left.sort((a, b) => (mod12(cur - iv[a]) === 7 ? -1 : 0) - (mod12(cur - iv[b]) === 7 ? -1 : 0) || mod12(cur - iv[a] - 7) - mod12(cur - iv[b] - 7));
    out.push(left.shift()!);
  }
  return out;
}

/** Twelve-bar blues form on dominant (major blues) or minor (minor blues) sevenths. The chord
 *  tones outside the blues scale are flagged so melodies keep to the scale while the band plays
 *  the changes. */
function bluesStep(i: number, o: ProgressionOptions, cad: number): Step {
  const FORM = [0, 3, 0, 0, 3, 3, 0, 0, 4, 3, 0, 4];
  const which = FORM[i % 12];
  const minor = o.scale === 'minorBlues';
  const semis = which === 0 ? 0 : which === 3 ? 5 : 7;
  const c = chordFromQuality(mod12(o.root + semis), minor ? 'min7' : 'dom7', scaleIntervals(o.scale, o.custom).indexOf(semis));
  const pcs = scaleIntervals(o.scale, o.custom).map((x) => mod12(o.root + x));
  const outside = c.pcs.filter((pc) => !pcs.includes(pc));
  void cad;
  return { deg: Math.max(0, c.degree), func: which === 0 ? 'tonic' : which === 4 ? 'dominant' : 'pre', tension: which === 0 ? 0 : which === 4 ? 0.8 : 0.4, chord: { ...c, ...(outside.length ? { outside } : {}) } };
}

export function chordAt(slots: ChordSlot[], beat: Beats): ChordSlot {
  let lo = 0;
  for (let i = 0; i < slots.length; i++) if (slots[i].start <= beat + 1e-6) lo = i;
  return slots[lo];
}

/** Move a timeline to a new key/scale. A key change transposes exactly; a scale change rebuilds
 *  each relative chord on its degree in the new scale (absolute, user-typed chords transpose). */
export function retargetSlots(slots: ChordSlot[], from: { key: number; scale: ScaleId; customScale?: number[] }, to: { key: number; scale: ScaleId; customScale?: number[] }): ChordSlot[] {
  const dk = mod12(to.key - from.key);
  const sameScale = from.scale === to.scale && JSON.stringify(from.customScale ?? []) === JSON.stringify(to.customScale ?? []);
  const n = scaleIntervals(to.scale, to.customScale).length;
  return slots.map((s) => {
    const shift = (pc: number) => mod12(pc + dk);
    if (sameScale || s.absolute || s.chord.degree < 0) {
      const chord: Chord = { ...s.chord, rootPc: shift(s.chord.rootPc), pcs: s.chord.pcs.map(shift), ...(s.chord.outside ? { outside: s.chord.outside.map(shift) } : {}) };
      return { ...s, chord, bassPc: shift(s.bassPc) };
    }
    const deg = s.chord.degree % n;
    const d = stableDegree(deg, to.key, to.scale, to.customScale) ? deg : 0;
    const chord = diatonicChord(d, to.key, to.scale, s.size ?? Math.min(5, s.chord.pcs.length), to.customScale);
    const pedal = s.bassPc === mod12(from.key) && s.chord.rootPc !== s.bassPc;
    return { ...s, chord, bassPc: pedal ? mod12(to.key) : chord.rootPc };
  });
}

/** True when the chord's quality label matches the formula of what sounds (used by tests). */
export const chordIsHonest = (c: Chord) => c.quality === 'other' || identifyQuality(c.ivs ?? CHORD_FORMULAS[c.quality]) === c.quality;

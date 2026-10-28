// MUSICAL INTELLIGENCE ENGINE. One shared musical context — key, scale, the harmony timeline,
// sections and the harmonic behaviour — that every tonal generator consults: the composer, Orbital,
// Particles, the drawing brushes' harmony option and image/panorama interpretation.
//
// It is not an audio engine. It answers two questions for anyone producing NoteEvents:
//   "which pitch fits here?"  — choosePitch() weighs the requested position against the current
//                               chord, the line's previous note, metric strength, the scale's
//                               colour tones and whatever else is sounding;
//   "why this pitch?"          — explain() gives a short human reason ("F♯ — third of D major").
//
// The scale is the vocabulary; the current chord and the phrase decide which words fit now.

import type { Beats, ChordSlot, HarmonyBehavior, HarmonySettings, NoteEvent, ProjectSettings, ScaleId, TimeSigId } from '../core/types';
import type { Rng } from '../core/rng';
import { barBeats, beatStrength } from '../core/time';
import { chordIntervals, chordSymbol, diatonicChord } from './chords';
import { characteristicPcs, degreeOrdinal, intervalName, pcName, SCALES, scaleFamily, type ScaleFamily, scaleIntervals } from './scales';

export interface SectionSpan { start: Beats; end: Beats; name: string }

export interface MusicalContext {
  key: number;
  scale: ScaleId;
  custom?: number[];
  /** scale pitch classes in degree order */
  pcs: number[];
  family: ScaleFamily;
  behavior: HarmonyBehavior;
  slots: ChordSlot[];
  timeSig: TimeSigId;
  barBeats: number;
  characteristic: number[];
  sections: SectionSpan[];
}

const mod12 = (x: number) => ((x % 12) + 12) % 12;

export function defaultHarmony(): HarmonySettings {
  return { behavior: 'strict', progression: 'auto', colour: 'auto', rhythm: 0, sequence: '', lock: false, seed: 1, slots: [], author: 'none' };
}

/** A context from project settings and the shared harmony. Without a timeline the tonic chord
 *  rules everywhere, so sequencers are harmonically anchored even before anything is generated. */
export function musicalContext(ps: Pick<ProjectSettings, 'key' | 'scale' | 'customScale' | 'timeSig'>, h?: Partial<HarmonySettings>, sections: SectionSpan[] = []): MusicalContext {
  const iv = scaleIntervals(ps.scale, ps.customScale);
  const slots = h?.slots?.length ? h.slots : [tonicSlot(ps)];
  return {
    key: ps.key, scale: ps.scale, custom: ps.customScale, pcs: iv.map((i) => mod12(ps.key + i)),
    family: scaleFamily(ps.scale, ps.customScale), behavior: h?.behavior ?? 'strict', slots,
    timeSig: ps.timeSig, barBeats: barBeats(ps.timeSig), characteristic: characteristicPcs(ps.key, ps.scale), sections,
  };
}

function tonicSlot(ps: Pick<ProjectSettings, 'key' | 'scale' | 'customScale'>): ChordSlot {
  const chord = diatonicChord(0, ps.key, ps.scale, 3, ps.customScale);
  return { start: 0, dur: 1e9, chord, bassPc: ps.key, func: 'tonic', tension: 0 };
}

/** The chord at a beat. A timeline shorter than the request repeats (a looped progression). */
export function slotAt(ctx: MusicalContext, beat: Beats): ChordSlot {
  const s = ctx.slots;
  const last = s[s.length - 1];
  const total = last.start + last.dur;
  const b = beat >= total && total > 0 ? beat % total : beat;
  let lo = 0;
  for (let i = 0; i < s.length; i++) if (s[i].start <= b + 1e-6) lo = i;
  return s[lo];
}

export const inScale = (ctx: MusicalContext, midi: number) => ctx.pcs.includes(mod12(midi));
export const isChordTone = (ctx: MusicalContext, midi: number, beat: Beats) => slotAt(ctx, beat).chord.pcs.includes(mod12(midi));

/** Root, third and fifth (or their stand-ins): where phrases come to rest. */
export function stablePcs(slot: ChordSlot): number[] {
  const ivs = chordIntervals(slot.chord).map(mod12);
  const keep = ivs.filter((i) => i === 0 || i === 3 || i === 4 || i === 6 || i === 7 || i === 8);
  return [...new Set((keep.length >= 2 ? keep : ivs).map((i) => mod12(slot.chord.rootPc + i)))];
}

/** Every pitch in [lo, hi] whose pitch class is in `pcs`, ascending. */
export function pitchesOf(pcs: number[], lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let m = lo; m <= hi; m++) if (pcs.includes(mod12(m))) out.push(m);
  return out;
}

/** Chord tones the strict behaviour may play: the chord's scale tones (user/borrowed chords keep
 *  their outside tones out of melodies in strict mode, but the band may voice them). */
export function chordPcsFor(ctx: MusicalContext, slot: ChordSlot, line: 'harmony' | 'melody'): number[] {
  if (line === 'harmony' || ctx.behavior !== 'strict') return slot.chord.pcs;
  const inside = slot.chord.pcs.filter((pc) => ctx.pcs.includes(pc));
  return inside.length ? inside : slot.chord.pcs;
}

export type PitchMode = 'chord' | 'melody' | 'pedal' | 'bass';

export interface PitchRequest {
  /** where the gesture puts the note (MIDI, may be fractional) */
  target: number;
  lo: number;
  hi: number;
  beat: Beats;
  /** 0..1 metric / phrase strength (downbeats and phrase ends are strong) */
  strong?: number;
  /** previous pitch of this line */
  prev?: number;
  mode: PitchMode;
  /** pitches other parts sound at this moment */
  avoid?: number[];
  /** weighted choice among near-equals; omitted = the single best fit (fully deterministic) */
  rng?: Rng;
  /** tolerance around the target in semitones (default 3) */
  spread?: number;
  /** 0..1 liking for the scale's characteristic colour tones on weak positions */
  colour?: number;
}

/** Score every candidate pitch for a request and pick one. */
export function choosePitch(ctx: MusicalContext, q: PitchRequest): number {
  const slot = slotAt(ctx, q.beat);
  const strong = q.strong ?? beatStrength(ctx.timeSig, mod(q.beat, ctx.barBeats));
  const chordPcs = chordPcsFor(ctx, slot, q.mode === 'melody' ? 'melody' : 'harmony');
  const stable = stablePcs(slot);
  const spread = q.spread ?? 3;
  const lo = Math.max(0, Math.round(Math.min(q.lo, q.hi)));
  const hi = Math.min(127, Math.round(Math.max(q.lo, q.hi)));
  const exp = ctx.behavior === 'experimental';
  let pool: number[];
  switch (q.mode) {
    case 'chord': pool = pitchesOf(chordPcs, lo, hi); break;
    case 'pedal': pool = pitchesOf([ctx.key, ...(ctx.pcs.includes(mod12(ctx.key + 7)) ? [mod12(ctx.key + 7)] : [])], lo, hi); break;
    case 'bass': pool = pitchesOf([slot.bassPc, slot.chord.rootPc, ...stable], lo, hi); break;
    default: pool = pitchesOf(exp ? [...Array(12).keys()] : ctx.pcs, lo, hi);
  }
  if (!pool.length) pool = pitchesOf(chordPcs, Math.max(0, lo - 12), Math.min(127, hi + 12));
  if (!pool.length) return Math.round(q.target);
  const scored = pool.map((m) => ({ m, s: scorePitch(ctx, q, m, { chordPcs, stable, strong, spread, bassPc: slot.bassPc }) }));
  if (!q.rng) return scored.reduce((a, b) => (b.s > a.s ? b : a)).m;
  const top = Math.max(...scored.map((x) => x.s));
  const near = scored.filter((x) => x.s >= top * 0.45);
  return q.rng.weighted(near.map((x) => x.m), near.map((x) => x.s * x.s));
}

function scorePitch(ctx: MusicalContext, q: PitchRequest, m: number, k: { chordPcs: number[]; stable: number[]; strong: number; spread: number; bassPc: number }): number {
  const pc = mod12(m);
  const d = Math.abs(m - q.target);
  let s = Math.exp(-((d / k.spread) ** 2)) + 0.02;
  const ct = k.chordPcs.includes(pc);
  const sc = ctx.pcs.includes(pc);
  if (q.mode === 'melody') {
    const stepFromPrev = q.prev !== undefined && Math.abs(m - q.prev) <= 2 && m !== q.prev;
    if (!ct) {
      // a non-chord tone needs a reason: a weak position reached by step (passing / neighbour);
      // in Expressive a strong one may be an appoggiatura or suspension that resolves by step
      const weakOk = k.strong < 0.5 && (stepFromPrev || q.prev === undefined);
      const base = ctx.behavior === 'strict' ? (weakOk ? 0.55 : 0.06) : ctx.behavior === 'expressive' ? (weakOk ? 0.75 : 0.3) : 0.6;
      s *= base;
    } else if (k.strong >= 0.5 && k.stable.includes(pc)) s *= 1.25;
    if (!sc) s *= ctx.behavior === 'experimental' ? (stepFromPrev ? 0.45 : 0.12) : 0;
    if (q.prev !== undefined) {
      const L = Math.abs(m - q.prev);
      s *= L === 0 ? 0.55 : L <= 2 ? 1 : L <= 4 ? 0.85 : L <= 7 ? 0.55 : L <= 12 ? 0.3 : 0.12;
    }
    if (q.colour && k.strong < 0.5 && ctx.characteristic.includes(pc)) s *= 1 + q.colour * 0.8;
  } else if (q.mode === 'bass') {
    s *= pc === k.bassPc ? 2.2 : k.stable.includes(pc) ? 1 : 0.4;
  } else if (q.mode === 'pedal') {
    s *= pc === mod12(ctx.key) ? 1.6 : 1;
  } else if (k.strong >= 0.5 && k.stable.includes(pc)) s *= 1.15;
  for (const a of q.avoid ?? []) {
    const iv = mod12(m - a);
    if (m === a) s *= 0.35; // complement, don't double
    else if (iv === 1 || iv === 11) s *= ctx.behavior === 'strict' ? 0.05 : ctx.behavior === 'expressive' ? 0.25 : 0.75;
    else if (iv === 6) s *= ctx.behavior === 'strict' ? 0.45 : 0.8;
    else if (iv === 3 || iv === 4 || iv === 8 || iv === 9) s *= 1.12; // thirds and sixths answer well
  }
  return s;
}

const mod = (x: number, m: number) => ((x % m) + m) % m;

/** The nearest chord tone to a pitch (ties go to the direction the line is moving). */
export function nearestChordTone(ctx: MusicalContext, midi: number, beat: Beats, dir = 0, line: 'melody' | 'harmony' = 'melody'): number {
  const pcs = chordPcsFor(ctx, slotAt(ctx, beat), line);
  for (let d = 0; d <= 6; d++) {
    const a = midi + (dir >= 0 ? d : -d), b = midi - (dir >= 0 ? d : -d);
    if (pcs.includes(mod12(a))) return a;
    if (pcs.includes(mod12(b))) return b;
  }
  return midi;
}

/** Fit spatially placed notes (drawn strokes, orbital figures) to the harmony at the moment each
 *  sounds. 'guided': only exposed notes — strong positions and long notes — that are not chord
 *  tones move; 'chord': every note becomes the chord tone nearest its position. `adapt` (0..1)
 *  bounds how far a note may move: 1 + 4·adapt semitones. Shapes stay recognisable. */
export function adaptNotes(ctx: MusicalContext, notes: NoteEvent[], mode: 'guided' | 'chord', adapt = 0.7): NoteEvent[] {
  const reach = 1 + adapt * 4;
  return notes.map((n) => {
    const strong = beatStrength(ctx.timeSig, mod(n.start, ctx.barBeats));
    const exposed = strong >= 0.75 || n.dur >= 1;
    if (mode === 'guided' && (!exposed || isChordTone(ctx, n.midi, n.start))) return n;
    const c = choosePitch(ctx, { target: n.midi, lo: n.midi - reach, hi: n.midi + reach, beat: n.start, mode: 'chord', strong, spread: 1.5 + adapt * 2 });
    return Math.abs(c - n.midi) <= reach + 1e-9 && c !== n.midi ? { ...n, midi: c } : n;
  });
}

// ------------------------------------------------------------------ explanations

const QUALITY_WORD: Partial<Record<string, string>> = { maj: 'major', min: 'minor', dim: 'diminished', aug: 'augmented' };
const CHORD_ROLE: Record<number, string> = { 0: 'root', 2: '9th', 3: 'third', 4: 'third', 5: '4th', 6: '♭5', 7: 'fifth', 8: '♯5', 9: '6th', 10: '7th', 11: '7th', 1: '♭9' };

export function chordLongName(ctx: MusicalContext, slot: ChordSlot): string {
  const names = (pc: number) => pcName(pc, ctx.key, ctx.scale);
  const q = slot.chord.quality;
  const word = QUALITY_WORD[q];
  const sym = chordSymbol(slot.chord, names);
  return word ? `${names(slot.chord.rootPc)} ${word}` : sym;
}

export function scaleLabel(ctx: MusicalContext): string {
  return `${pcName(ctx.key, ctx.key, ctx.scale)} ${SCALES[ctx.scale].name}`;
}

/** Why a pitch fits at a moment: "F♯ — third of D major", "B — 6th degree of D Dorian (its colour
 *  tone)", "C♯ — outside D Dorian". */
export function explain(ctx: MusicalContext, midi: number, beat: Beats): string {
  const pc = mod12(midi);
  const slot = slotAt(ctx, beat);
  const name = pcName(pc, ctx.key, ctx.scale);
  const chordName = chordLongName(ctx, slot);
  if (slot.chord.pcs.includes(pc)) {
    const role = CHORD_ROLE[mod12(pc - slot.chord.rootPc)] ?? intervalName(pc - slot.chord.rootPc);
    const out = slot.chord.outside?.includes(pc) ? ' (a chord tone outside the scale)' : '';
    return `${name} — ${role} of ${chordName}${out}`;
  }
  const ord = degreeOrdinal(pc, ctx.key, ctx.scale, ctx.custom);
  if (ord) {
    const colour = ctx.characteristic.includes(pc) ? ' — its colour tone' : '';
    return `${name} — ${ord} of ${scaleLabel(ctx)}${colour}, passing over ${chordName}`;
  }
  return `${name} — chromatic, outside ${scaleLabel(ctx)} (over ${chordName})`;
}

/** Scale degrees of the current chord's tones ("1 3 5" / "4 6 1"), for the harmony readout. */
export function chordDegrees(ctx: MusicalContext, slot: ChordSlot): string {
  return slot.chord.pcs.map((pc) => { const k = ctx.pcs.indexOf(pc); return k < 0 ? `(${pcName(pc, ctx.key, ctx.scale)})` : String(k + 1); }).join(' ');
}

/** Section name at a beat. */
export function sectionAt(ctx: MusicalContext, beat: Beats): string {
  return ctx.sections.find((s) => beat >= s.start - 1e-6 && beat < s.end - 1e-6)?.name ?? '';
}

const NUMERAL = ['I', '♭II', 'II', '♭III', 'III', 'IV', '♯IV', 'V', '♭VI', 'VI', '♭VII', 'VII'];

/** Roman numeral of a chord relative to the tonic, by interval (works for every scale): in D Dorian
 *  G is IV, C is ♭VII, Em is ii. Lower case for minor and diminished chords. */
export function romanNumeral(ctx: MusicalContext, slot: ChordSlot): string {
  const iv = mod12(slot.chord.rootPc - ctx.key);
  const has = (x: number) => slot.chord.pcs.includes(mod12(slot.chord.rootPc + x));
  const minor = has(3) && !has(4);
  const dim = minor && has(6) && !has(7);
  const n = NUMERAL[iv];
  return minor ? n.toLowerCase() + (dim ? '°' : '') : n + (has(4) && has(8) && !has(7) ? '+' : '');
}

/** One-line description of how harmony works in the current scale family. */
export function familyNote(ctx: MusicalContext): string {
  switch (ctx.family) {
    case 'heptatonic':
      return ['dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian', 'phrygianDominant'].includes(ctx.scale)
        ? 'A mode: chords stack in thirds, and cadences use the mode’s own colour chords — no borrowed leading tone.'
        : 'Seven-note scale: chords stack in thirds and cadences pull to the tonic.';
    case 'pentatonic': return 'Five-note scale: every chord is built only from scale tones (m7, 6, 7sus4, quartal), so melody and harmony never leave it.';
    case 'blues': return 'Blues scale: Strict uses scale-tone chords and treats the blue note as a passing tone; Expressive plays i7–iv7–v7 backing whose outside tones are marked.';
    case 'symmetric': return 'Symmetric scale: augmented or diminished harmony taken from its own tones; there is no dominant.';
    case 'chromatic': return 'Chromatic: every tone is available; harmony is anchored on the tonic chord.';
    default: return 'Custom scale: chords are chosen from shapes the scale contains.';
  }
}

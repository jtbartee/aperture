// THEMES. A piece's melody grows from one principal motif — a short rhythm with a contour written
// in scale steps — that is stated, repeated, sequenced onto new chords, inverted, fragmented,
// augmented and answered. Because a motif is stored in steps relative to an anchor, it keeps its
// shape on every chord; the harmony only nudges single notes (by a step or two) onto chord tones.
//
// realiseUnit() is where a motif meets the shared musical context: strong positions land on chord
// tones; non-chord tones survive only where they have a reason (passing or neighbour on weak
// positions; in Expressive an appoggiatura that resolves by step); phrase ends land on stable tones.

import type { Beats } from '../core/types';
import type { Rng } from '../core/rng';
import { beatStrength, metricWeight } from '../core/time';
import { type MusicalContext, chordPcsFor, slotAt, stablePcs } from './context';
import { degreeToMidi } from './scales';

export interface MotifNote { at: Beats; dur: Beats; step: number }
export interface Motif { notes: MotifNote[]; span: Beats }

export type PhraseForm = 'sentence' | 'period' | 'cell' | 'call' | 'drone' | 'theme';

export interface Grammar {
  /** notes per motif */
  count: [number, number];
  /** onset grids to choose from, in beats (e.g. 0.5 = eighths, 1/3 = triplet eighths, 0.2 = quintuplet sixteenths) */
  grids: number[];
  /** longest single note in beats */
  longest: Beats;
  /** 0..1 tendency to leap (followed by a step back: gap fill) */
  leap: number;
  /** 0..1 negative space: shortens notes and leaves gaps */
  rest: number;
  /** 0..1 chance the motif starts after the downbeat */
  pickup: number;
  /** bars one statement of the motif occupies */
  bars: number;
  form: PhraseForm;
}

const clampI = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** A principal motif: a rhythm on a grid (strong positions preferred) and a contour shape. */
export function makeMotif(r: Rng, g: Grammar, barBeats: Beats): Motif {
  const span = g.bars * barBeats;
  const grid = r.pick(g.grids);
  const cells = Math.max(2, Math.floor(span / grid + 1e-6));
  const count = clampI(r.int(g.count[0], g.count[1]), 1, cells);
  const first = r.chance(g.pickup) ? r.int(1, Math.min(3, cells - count)) : 0;
  const chosen = new Set<number>([first]);
  // remaining onsets: weighted by metric strength, spread out, inside the first ~85% of the span
  const usable = Array.from({ length: cells }, (_, i) => i).filter((i) => i > first && i * grid < span * 0.86);
  while (chosen.size < count && usable.length) {
    const w = usable.map((i) => 0.25 + metricWeight('4/4', (i * grid) % 4) + (chosen.has(i - 1) ? -0.15 : 0.1));
    const pick = r.weighted(usable, w);
    chosen.add(pick);
    usable.splice(usable.indexOf(pick), 1);
  }
  const at = [...chosen].sort((a, b) => a - b).map((i) => i * grid);
  const shape = r.pick(['rise', 'fall', 'arch', 'valley', 'wave', 'turn'] as const);
  const steps: number[] = [0];
  for (let k = 1; k < at.length; k++) {
    const f = k / Math.max(1, at.length - 1);
    let dir = shape === 'rise' ? 1 : shape === 'fall' ? -1 : shape === 'arch' ? (f <= 0.55 ? 1 : -1) : shape === 'valley' ? (f <= 0.55 ? -1 : 1) : shape === 'wave' ? (k % 2 ? 1 : -1) : (k === 1 ? 1 : k === 2 ? -1 : -1);
    const prevLeap = k > 1 && Math.abs(steps[k - 1] - steps[k - 2]) >= 3;
    if (prevLeap) dir = -Math.sign(steps[k - 1] - steps[k - 2]) || dir; // gap fill after a leap
    const size = !prevLeap && r.chance(g.leap) ? r.pick([3, 4]) : r.chance(0.75) ? 1 : 2;
    steps.push(clampI(steps[k - 1] + dir * size, -6, 7));
  }
  const notes: MotifNote[] = at.map((a, k) => {
    const next = at[k + 1] ?? span;
    const room = next - a;
    const legato = r.chance(g.rest) ? 0.45 + r() * 0.2 : 0.8 + r() * 0.15;
    return { at: a, dur: Math.min(g.longest, Math.max(grid * 0.5, room * legato)), step: steps[k] };
  });
  return { notes, span };
}

// ------------------------------------------------------------------ development operations

export const invert = (m: Motif): Motif => ({ ...m, notes: m.notes.map((n) => ({ ...n, step: -n.step })) });
export const retrograde = (m: Motif): Motif => ({ ...m, notes: m.notes.map((n, k) => ({ ...n, step: m.notes[m.notes.length - 1 - k].step - m.notes[m.notes.length - 1].step })) });
export const scaleTime = (m: Motif, f: number): Motif => ({ span: m.span * f, notes: m.notes.map((n) => ({ ...n, at: n.at * f, dur: n.dur * f })) });

/** The first k notes, in a span rounded up to half the original. */
export function fragment(m: Motif, k: number): Motif {
  const notes = m.notes.slice(0, Math.max(1, k));
  const end = notes[notes.length - 1].at + notes[notes.length - 1].dur;
  return { notes, span: Math.max(m.span / 2, Math.ceil(end / (m.span / 4)) * (m.span / 4)) };
}

/** Same rhythm; the second half mirrors the first and the last note falls back to the start. */
export function answer(m: Motif): Motif {
  const h = Math.ceil(m.notes.length / 2);
  const notes = m.notes.map((n, k) => (k < h ? n : { ...n, step: -n.step }));
  if (notes.length > 1) notes[notes.length - 1] = { ...notes[notes.length - 1], step: 0 };
  return { ...m, notes };
}

/** Gradual note substitution (minimalism, motorik): one note moves by a step or two. */
export function substitute(m: Motif, r: Rng): Motif {
  if (m.notes.length < 2) return m;
  const k = r.int(1, m.notes.length - 1);
  return { ...m, notes: m.notes.map((n, i) => (i === k ? { ...n, step: clampI(n.step + r.pick([-2, -1, 1, 2]), -6, 7) } : n)) };
}

/** Rhythmic displacement inside the span (IDM): onsets rotate by `by` beats. */
export function displace(m: Motif, by: Beats): Motif {
  const notes = m.notes.map((n) => ({ ...n, at: ((n.at + by) % m.span + m.span) % m.span })).sort((a, b) => a.at - b.at);
  return { ...m, notes: notes.map((n, k) => ({ ...n, dur: Math.min(n.dur, (notes[k + 1]?.at ?? m.span) - n.at) })) };
}

/** Additive / subtractive process: grow by one repeated-or-neighbour note, or drop the last. */
export function additive(m: Motif, grow: boolean, r: Rng, grid: Beats): Motif {
  if (!grow) return m.notes.length > 2 ? { ...m, notes: m.notes.slice(0, -1) } : m;
  const last = m.notes[m.notes.length - 1];
  const at = Math.ceil((last.at + Math.max(grid, last.dur)) / grid - 1e-6) * grid;
  if (at >= m.span - 1e-6) return m;
  return { ...m, notes: [...m.notes, { at, dur: Math.min(grid, m.span - at), step: last.step + r.pick([-1, 1, 2]) }] };
}

/** An ornament on the longest note: it splits into note, upper neighbour, note (Expressive). */
export function ornament(m: Motif): Motif {
  let k = 0;
  m.notes.forEach((n, i) => { if (n.dur > m.notes[k].dur) k = i; });
  const n = m.notes[k];
  if (n.dur < 0.75) return m;
  const third = n.dur / 3;
  const notes = [...m.notes.slice(0, k), { ...n, dur: third }, { at: n.at + third, dur: third, step: n.step + 1 }, { at: n.at + 2 * third, dur: third, step: n.step }, ...m.notes.slice(k + 1)];
  return { ...m, notes };
}

// ------------------------------------------------------------------ phrase plans

export type Cadence = 'none' | 'half' | 'full';
export interface UnitPlan { motif: Motif; shift: number; cadence: Cadence; label: string }

/** How one phrase develops the theme, unit by unit. `stage` = how far into the piece (0..1);
 *  `variant` 1 = a contrasting section. */
export function planPhrase(form: PhraseForm, theme: Motif, units: number, phraseIdx: number, r: Rng, o: { stage: number; variant: number; mutation: number; grid: Beats; expressive: boolean }): UnitPlan[] {
  const out: UnitPlan[] = [];
  const last = units - 1;
  const t = theme;
  for (let u = 0; u < units; u++) {
    const cad: Cadence = u === last ? (phraseIdx % 2 === 0 && form !== 'cell' ? 'half' : 'full') : 'none';
    let m: Motif;
    let shift = 0;
    let label: string;
    switch (form) {
      case 'period': {
        // antecedent / consequent: theme + answer, twice
        m = u % 2 === 0 ? t : answer(t);
        label = u % 2 === 0 ? 'statement' : 'answer';
        break;
      }
      case 'cell': {
        // repetition as a device: the cell returns; each phrase one note is substituted and the
        // cell grows or shrinks by a note (additive / subtractive process)
        m = t;
        for (let k = 0; k < phraseIdx; k++) {
          if (r.chance(0.35 + o.mutation * 0.5)) m = substitute(m, r);
        }
        const growth = Math.round(Math.sin(phraseIdx * 0.9) * 2);
        for (let k = 0; k < Math.abs(growth); k++) m = additive(m, growth > 0, r, o.grid);
        label = 'cell';
        break;
      }
      case 'call': {
        m = u % 2 === 0 ? t : retrograde(answer(t));
        label = u % 2 === 0 ? 'call' : 'response';
        break;
      }
      case 'drone': {
        m = u === 0 ? t : r.chance(0.5) ? t : fragment(t, Math.max(1, Math.ceil(t.notes.length / 2)));
        label = u === 0 ? 'statement' : 'echo';
        break;
      }
      default: {
        // sentence: statement, sequence (same shape on the next chord), fragmentation, cadence
        if (u === 0) { m = t; label = 'statement'; }
        else if (u === 1) { m = t; shift = r.pick([1, 2, -1]); label = 'sequence'; }
        else if (u === last) { m = answer(t); label = 'cadence'; }
        else {
          const f = fragment(t, Math.max(2, Math.ceil(t.notes.length / 2)));
          const twice: Motif = { span: t.span, notes: [...f.notes, ...f.notes.map((n) => ({ ...n, at: n.at + t.span / 2, step: n.step + 1 }))].filter((n) => n.at < t.span) };
          m = twice; label = 'fragmentation';
        }
      }
    }
    // contrasting section: the theme inverted (still recognisably the same rhythm)
    if (o.variant === 1 && form !== 'cell' && u !== last) { m = invert(m); label += ' (inverted)'; }
    // late in the piece the theme may return augmented (a thematic callback) on the first unit
    if (form === 'theme' && o.stage > 0.75 && u === 0) { m = scaleTime(t, 2); label = 'callback (augmented)'; }
    if (o.expressive && u !== last && r.chance(0.18)) m = ornament(m);
    out.push({ motif: m, shift, cadence: cad, label });
  }
  return out;
}

// ------------------------------------------------------------------ realisation

export interface RealisedNote { beat: Beats; dur: Beats; midi: number; degree?: number; vel: number; label?: string }

export interface UnitInput {
  motif: Motif;
  start: Beats;
  /** anchor degree (scale step 0 of the motif), relative to the tonic at `base` */
  anchor: number;
  base: number;
  lo: number;
  hi: number;
  cadence: Cadence;
  vel: number;
  /** 0..1 chance of a chromatic passing note in Experimental */
  chromatic?: number;
  rng: Rng;
  end?: Beats;
}

/** Turn a motif into pitches on the current harmony. Contour is preserved; only single notes
 *  move (≤ 2 steps) to land on chord tones where the music asks for stability. */
export function realiseUnit(ctx: MusicalContext, u: UnitInput): RealisedNote[] {
  const n = ctx.pcs.length;
  const mid = (d: number) => degreeToMidi(d, ctx.key, ctx.scale, u.base, ctx.custom);
  const fold = (d: number) => { let x = d; while (x > u.hi) x -= n; while (x < u.lo) x += n; return x > u.hi ? u.hi : x; };
  const notes = u.motif.notes.filter((m) => u.end === undefined || u.start + m.at < u.end - 1e-6);
  // keep the whole statement in range by moving its anchor (an octave at a time, so it stays on the
  // same chord tone) rather than folding single notes, which would turn a falling step into a leap
  let anchor = u.anchor;
  if (notes.length) {
    const lo = Math.min(...notes.map((m) => m.step)), hi = Math.max(...notes.map((m) => m.step));
    while (anchor + hi > u.hi && anchor + lo - n >= u.lo) anchor -= n;
    while (anchor + lo < u.lo && anchor + hi + n <= u.hi) anchor += n;
  }
  const degs = notes.map((m) => fold(anchor + m.step));
  const out: RealisedNote[] = [];
  const isCT = (d: number, beat: Beats) => chordPcsFor(ctx, slotAt(ctx, beat), 'melody').includes(((mid(d) % 12) + 12) % 12);
  const nearestCT = (d: number, beat: Beats, dir: number) => {
    for (const k of [0, 1, -1, 2, -2, 3, -3]) { const c = d + (dir < 0 ? -k : k); if (c >= u.lo && c <= u.hi && isCT(c, beat)) return c; }
    return d;
  };
  for (let i = 0; i < notes.length; i++) {
    const m = notes[i];
    const beat = u.start + m.at;
    let d = degs[i];
    const prev = i ? degs[i - 1] : undefined;
    const next = degs[i + 1];
    const dirNext = next !== undefined ? Math.sign(next - d) : prev !== undefined ? Math.sign(d - prev) : 0;
    const w = beatStrength(ctx.timeSig, ((beat % ctx.barBeats) + ctx.barBeats) % ctx.barBeats);
    const isLast = i === notes.length - 1;
    const strong = i === 0 || w >= 0.75 || m.dur >= 1.5 || (isLast && u.cadence !== 'none');
    if (isLast && u.cadence !== 'none') {
      // phrase ending: a stable tone of the chord (root or third for a full cadence)
      const slot = slotAt(ctx, beat);
      const st = stablePcs(slot);
      const pref = u.cadence === 'full' ? st.slice(0, 2) : st;
      let best = d, bd = Infinity;
      for (let c = u.lo; c <= u.hi; c++) { const pc = ((mid(c) % 12) + 12) % 12; const dist = Math.abs(c - d) + (pref.includes(pc) ? 0 : 3); if (st.includes(pc) && dist < bd) { bd = dist; best = c; } }
      d = best;
    } else if (!isCT(d, beat)) {
      const passing = prev !== undefined && next !== undefined && Math.abs(d - prev) === 1 && Math.abs(next - d) === 1;
      const neighbour = prev !== undefined && next !== undefined && Math.abs(d - prev) === 1 && next === prev;
      const resolves = next !== undefined && Math.abs(next - d) === 1 && isCT(next, u.start + notes[i + 1].at);
      if (strong) {
        // Expressive keeps an appoggiatura that steps into a chord tone; otherwise land on one
        const keep = (ctx.behavior === 'expressive' && resolves && !isLast) || (ctx.behavior === 'experimental' && resolves);
        if (!keep) d = nearestCT(d, beat, dirNext);
      } else if (!(passing || neighbour)) {
        const leapIn = prev !== undefined && Math.abs(d - prev) > 2;
        if (ctx.behavior === 'strict' ? leapIn || !resolves : leapIn && !resolves) d = nearestCT(d, beat, dirNext);
      }
    }
    degs[i] = d;
    let midi = mid(d);
    let degree: number | undefined = d;
    // Experimental: a chromatic passing tone between two notes a whole step apart (weak position only)
    if (ctx.behavior === 'experimental' && !strong && u.chromatic && prev !== undefined && u.rng.chance(u.chromatic)) {
      const pm = mid(prev);
      if (Math.abs(midi - pm) === 2) { midi = (midi + pm) / 2; degree = undefined; }
    }
    const accent = i === 0 ? 1 : 0.7 + 0.3 * w;
    out.push({ beat, dur: m.dur, midi, degree, vel: Math.max(0.1, Math.min(1, u.vel * (0.82 + 0.22 * accent))) });
  }
  return out;
}

/** The chord-tone degree nearest a wanted degree (the anchor for the next statement). */
export function chordAnchor(ctx: MusicalContext, want: number, beat: Beats, base: number, lo: number, hi: number): number {
  const pcs = stablePcs(slotAt(ctx, beat));
  let best = want, bd = Infinity;
  for (let d = lo; d <= hi; d++) {
    const pc = ((degreeToMidi(d, ctx.key, ctx.scale, base, ctx.custom) % 12) + 12) % 12;
    if (pcs.includes(pc) && Math.abs(d - want) < bd) { bd = Math.abs(d - want); best = d; }
  }
  return best;
}

/** Interval-step signature of a run of degrees, for recognising a motif in later phrases. */
export const contourSignature = (degrees: number[]) => degrees.slice(1).map((d, i) => Math.sign(d - degrees[i]));

import type { Beats, ScaleId } from '../core/types';
import type { Rng } from '../core/rng';
import type { Onset } from './rhythm';
import { type ChordSlot, chordAt } from './progression';
import { degreeToMidi, scaleIntervals } from './scales';

export type MelodyBehavior =
  | 'stepwise' | 'leaping' | 'arpeggiated' | 'contour' | 'motif' | 'minimal' | 'chromatic' | 'drone' | 'callResponse';

export const MELODY_BEHAVIORS: { id: MelodyBehavior; label: string }[] = [
  { id: 'stepwise', label: 'Stepwise' },
  { id: 'leaping', label: 'Leaping' },
  { id: 'arpeggiated', label: 'Arpeggiated' },
  { id: 'contour', label: 'Contour-following' },
  { id: 'motif', label: 'Motif-based' },
  { id: 'minimal', label: 'Minimal / repetitive' },
  { id: 'chromatic', label: 'Chromatic' },
  { id: 'drone', label: 'Drone-centred' },
  { id: 'callResponse', label: 'Call and response' },
];

export interface MelodyNote { beat: Beats; dur: Beats; midi: number; degree?: number; vel: number }

export interface MelodyOptions {
  onsets: Onset[];
  behavior: MelodyBehavior;
  chords: ChordSlot[];
  root: number;
  scale: ScaleId;
  custom?: number[];
  /** MIDI note at or below the tonic that anchors degree 0 */
  base: number;
  /** lowest/highest degree the line may use */
  lo: number;
  hi: number;
  rng: Rng;
  restProb: number;
  phraseBeats: Beats;
  /** optional visual contour 0..1 over normalised time */
  contour?: (t01: number) => number;
  totalBeats: Beats;
  velocity?: number;
}

/** Degrees (mod scale length) whose pitch class belongs to the chord. */
export function chordDegreeSet(slot: ChordSlot, root: number, scale: ScaleId, custom?: number[]): number[] {
  const iv = scaleIntervals(scale, custom);
  const out: number[] = [];
  iv.forEach((i, d) => { if (slot.chord.pcs.includes((root + i) % 12)) out.push(d); });
  return out.length ? out : [0];
}

function nearestChordDegree(target: number, set: number[], n: number): number {
  let best = target;
  let bestD = Infinity;
  for (let o = -2; o <= 2; o++) {
    for (const d of set) {
      const c = d + o * n;
      if (Math.abs(c - target) < bestD) { bestD = Math.abs(c - target); best = c; }
    }
  }
  return best;
}

export function generateMelody(o: MelodyOptions): MelodyNote[] {
  const n = scaleIntervals(o.scale, o.custom).length;
  const clampD = (d: number) => Math.max(o.lo, Math.min(o.hi, d));
  const out: MelodyNote[] = [];
  const mid = Math.round((o.lo + o.hi) / 2);
  let cur = nearestChordDegree(mid, [0], n);
  let dir = 1;
  let arpIdx = 0;
  let motif: number[] = [];
  let motifPhrase = -1;
  let minimalCell: number[] = [];
  let callShape: number[] = [];
  const phraseOf = (b: Beats) => Math.floor(b / o.phraseBeats + 1e-9);
  const midiOf = (d: number) => degreeToMidi(d, o.root, o.scale, o.base, o.custom);

  for (let i = 0; i < o.onsets.length; i++) {
    const on = o.onsets[i];
    const phrase = phraseOf(on.beat);
    const posInPhrase = (on.beat - phrase * o.phraseBeats) / o.phraseBeats;
    // intentional rests: more likely late in a phrase and on weak beats
    const restP = o.restProb * (0.6 + posInPhrase * 0.6) * (1.2 - on.accent * 0.6);
    if (o.rng.chance(restP)) continue;
    const slot = chordAt(o.chords, on.beat);
    const cset = chordDegreeSet(slot, o.root, o.scale, o.custom);
    const strong = on.accent >= 0.5;
    let target = cur;
    let chromaticOffset = 0;
    switch (o.behavior) {
      case 'stepwise': {
        if (o.rng.chance(0.15)) dir = -dir;
        target = cur + dir * (o.rng.chance(0.8) ? 1 : 2);
        if (strong) target = nearestChordDegree(target, cset, n);
        break;
      }
      case 'leaping': {
        const leap = o.rng.pick([2, 3, 4, 5]);
        // leap, then recover by step in the opposite direction (gap-fill)
        target = i % 2 === 0 ? cur + dir * leap : cur - dir;
        if (i % 2 === 1) dir = -dir;
        target = nearestChordDegree(target, cset, n);
        break;
      }
      case 'arpeggiated': {
        const tones: number[] = [];
        for (let oct = -1; oct <= 2; oct++) for (const d of cset) tones.push(d + oct * n);
        const inRange = tones.filter((d) => d >= o.lo && d <= o.hi).sort((a, b) => a - b);
        if (!inRange.length) break;
        arpIdx += dir;
        if (arpIdx >= inRange.length - 1 || arpIdx <= 0) dir = -dir;
        arpIdx = Math.max(0, Math.min(inRange.length - 1, arpIdx));
        target = inRange[arpIdx];
        break;
      }
      case 'contour': {
        const c = o.contour ? o.contour(on.beat / o.totalBeats) : 0.5;
        const want = o.lo + c * (o.hi - o.lo);
        target = Math.round(cur + Math.max(-3, Math.min(3, want - cur)));
        if (strong) target = nearestChordDegree(target, cset, n);
        break;
      }
      case 'motif': {
        if (phrase !== motifPhrase) {
          if (!motif.length || o.rng.chance(0.25)) {
            motif = Array.from({ length: o.rng.int(3, 6) }, (_, k) => (k === 0 ? 0 : o.rng.pick([-2, -1, 1, 1, 2, 3])));
          } else {
            // develop: invert, sequence or retrograde
            const op = o.rng.pick(['invert', 'sequence', 'retro', 'same']);
            if (op === 'invert') motif = motif.map((x, k) => (k ? -x : 0));
            else if (op === 'retro') motif = [0, ...motif.slice(1).reverse()];
          }
          motifPhrase = phrase;
          cur = nearestChordDegree(mid + (phrase % 2 ? 2 : 0), cset, n);
        }
        const k = out.filter((m) => phraseOf(m.beat) === phrase).length % motif.length;
        target = k === 0 ? nearestChordDegree(cur, cset, n) : cur + motif[k];
        break;
      }
      case 'minimal': {
        if (!minimalCell.length || (phrase !== motifPhrase && o.rng.chance(0.2))) {
          const a = nearestChordDegree(mid, cset, n);
          minimalCell = [a, a + o.rng.pick([1, 2, -1]), a + o.rng.pick([0, 2, 4])];
          motifPhrase = phrase;
        }
        target = minimalCell[i % minimalCell.length];
        break;
      }
      case 'chromatic': {
        target = cur + dir * (o.rng.chance(0.7) ? 1 : 2);
        if (o.rng.chance(0.2)) dir = -dir;
        if (!strong && o.rng.chance(0.45)) chromaticOffset = o.rng.pick([-1, 1]);
        break;
      }
      case 'drone': {
        const anchors = [0, 4 % n, n];
        target = o.rng.chance(0.7) ? o.rng.pick(anchors) + Math.floor(mid / n) * n : cur + o.rng.pick([-1, 1]);
        break;
      }
      case 'callResponse': {
        const isCall = phrase % 2 === 0;
        const k = out.filter((m) => phraseOf(m.beat) === phrase).length;
        if (isCall) {
          if (k === 0) callShape = [];
          target = cur + (o.rng.chance(0.7) ? 1 : 2);
          callShape.push(target - cur);
          if (posInPhrase > 0.7) target = nearestChordDegree(target, cset.filter((d) => d !== 0), n);
        } else {
          // the answer mirrors the call's intervals and lands on the tonic
          const step = callShape[k % Math.max(1, callShape.length)] ?? 1;
          target = cur - step;
          if (posInPhrase > 0.7) target = nearestChordDegree(target, [0], n);
        }
        break;
      }
    }
    // keep in range by folding direction
    if (target > o.hi) { target = o.hi - (target - o.hi); dir = -1; }
    if (target < o.lo) { target = o.lo + (o.lo - target); dir = 1; }
    cur = clampD(target);
    const midi = midiOf(cur) + chromaticOffset;
    out.push({
      beat: on.beat,
      dur: on.dur,
      midi,
      degree: chromaticOffset ? undefined : cur,
      vel: Math.max(0.1, Math.min(1, (o.velocity ?? 0.7) * (0.75 + on.accent * 0.35))),
    });
  }
  return out;
}
